// 云函数 returnSale：销售退货（红冲） —— 单事务内完成
//   1) 校验销售单存在、属于本人、状态为 completed（未退过）
//   2) 逐行把库存加回去（按 SKU；旧订单 fallback 到 goods.stock）
//   3) 销售单标记 status='returned' + returnedAt
// 退货不"回退成本价"——加权平均成本是动态口径，历史上已发生的销售成本不追溯调整。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  const orderId = String(event.orderId || '').trim();
  const reason = String(event.reason || '').slice(0, 200);
  if (!orderId) return { success: false, message: '缺少订单号' };

  try {
    let returnedAt = null;
    let orderNo = '';
    await db.runTransaction(async (t) => {
      let order = null;
      try {
        const res = await t.collection('sales_orders').doc(orderId).get();
        order = res.data;
      } catch (e) { order = null; }
      if (!order) throw new Error('订单不存在或已被删除');
      if (order.openid !== OPENID) throw new Error('无权操作该订单');
      if (order.type !== 'sale') throw new Error('只有销售单可以退货');
      if (order.status === 'returned') throw new Error('该订单已退货，请勿重复操作');
      if (order.status !== 'completed') throw new Error('订单状态异常，无法退货');

      orderNo = order.orderNo || '';
      const lines = order.lines || [];
      const now = new Date();

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i] || {};
        if (!l.goodsId) continue;
        let g = null;
        try {
          const res = await t.collection('goods').doc(l.goodsId).get();
          g = res.data;
        } catch (e) { g = null; }
        if (!g || g.openid !== OPENID) {
          throw new Error('商品「' + (l.name || '') + '」已删除，无法自动退货。请先在商品列表恢复该商品后再退货');
        }

        const skuKey = String(l.skuKey || '');
        const hasSkus = Array.isArray(g.skus) && g.skus.length;

        if (hasSkus && skuKey) {
          // ✅ 新数据：按 SKU 回补
          const skus = g.skus.map((s) => ({
            key: String(s.key || ''),
            color: String(s.color || ''),
            size: String(s.size || ''),
            stock: Number(s.stock) || 0,
            costPrice: Number(s.costPrice) || 0,
            price: Number(s.price) || 0
          }));
          const idx = skus.findIndex((s) => s.key === skuKey);
          if (idx < 0) {
            // SKU 已被删除或重命名 → 仍允许退货，但跳过 SKU 回补（防止阻塞）
            console.warn('[returnSale] SKU 不存在，跳过回补：goods=' + l.goodsId + ' skuKey=' + skuKey);
          } else {
            skus[idx].stock = skus[idx].stock + (Number(l.qty) || 0);
            const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
            await t.collection('goods').doc(l.goodsId).update({
              data: { skus: skus, totalStock: totalStock, updatedAt: now }
            });
          }
        } else {
          // ⚠️ 兼容旧数据 / 旧订单
          const stockAfter = (Number(g.stock) || 0) + (Number(l.qty) || 0);
          await t.collection('goods').doc(l.goodsId).update({
            data: { stock: stockAfter, updatedAt: now }
          });
        }

        await t.collection('inventory_logs').add({
          data: {
            openid: OPENID,
            type: 'return',
            action: 'in',
            goodsId: l.goodsId,
            goodsName: l.name || '',
            unit: l.unit || '件',
            qty: Number(l.qty) || 0,
            unitPrice: Number(l.cost) || 0,
            skuKey: skuKey,
            color: l.color || '',
            size: l.size || '',
            refType: 'return',
            refId: orderId,
            createdAt: now
          }
        });
      }

      returnedAt = now;
      await t.collection('sales_orders').doc(orderId).update({
        data: { status: 'returned', returnedAt: now, returnReason: reason }
      });
    });

    return { success: true, orderId: orderId, orderNo: orderNo, returnedAt: returnedAt };
  } catch (e) {
    console.error('[returnSale]', e);
    return { success: false, message: (e && e.message) || '退货失败，请重试' };
  }
};
