// 云函数 submitPurchase：进货入库 —— 单事务内完成
//   1) 逐行读取商品（事务内 doc.get）
//   2) 按 SKU 维度库存增加 + 加权平均成本更新
//   3) 写入进货单 purchase_orders + 库存流水（每条明细一条）
//
// 【SKU 兼容】旧数据（无 skus 字段）按 goods.stock 单一字段处理。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LINES = 30;

function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function toNum(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function genOrderNo() {
  const d = new Date();
  return 'JH' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
    Math.floor(Math.random() * 90 + 10);
}
function makeSkuKey(color, size) {
  return String(color || '') + '·' + String(size || '');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  try {
    const rawLines = Array.isArray(event.lines) ? event.lines : [];
    if (!rawLines.length) return { success: false, message: '进货明细为空' };
    if (rawLines.length > MAX_LINES) return { success: false, message: '单笔最多 ' + MAX_LINES + ' 项商品' };

    const lines = [];
    for (let i = 0; i < rawLines.length; i++) {
      const rl = rawLines[i] || {};
      const goodsId = String(rl.goodsId || '').trim();
      const qty = Math.floor(toNum(rl.qty, 0));
      const unitCost = round2(Math.max(0, toNum(rl.unitCost, 0)));
      const skuKey = String(rl.skuKey || '').trim();
      const color = String(rl.color || '').slice(0, 30);
      const size = String(rl.size || '').slice(0, 20);
      if (!goodsId) return { success: false, message: '第 ' + (i + 1) + '行缺少商品' };
      if (qty < 1 || qty > 99999) return { success: false, message: '第 ' + (i + 1) + '行数量不合法' };
      if (unitCost > 9999999) return { success: false, message: '第 ' + (i + 1) + '行进价过大' };
      lines.push({ goodsId: goodsId, qty: qty, unitCost: unitCost, skuKey: skuKey, color: color, size: size });
    }

    const supplierId = String(event.supplierId || '').trim();
    const remark = String(event.remark || '').slice(0, 200);
    let supplierName = '';
    if (supplierId) {
      try {
        const sRes = await db.collection('suppliers').doc(supplierId).get();
        if (sRes.data && sRes.data.openid === OPENID) {
          supplierName = sRes.data.name || '';
        }
      } catch (e) { /* 供应商已被删：散货 */ }
    }

    const now = new Date();
    const orderNo = genOrderNo();
    let orderId = '';
    const savedLines = [];
    let totalAmount = 0;

    await db.runTransaction(async (t) => {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        let g = null;
        try {
          const res = await t.collection('goods').doc(l.goodsId).get();
          g = res.data;
        } catch (e) { g = null; }
        if (!g || g.openid !== OPENID) {
          throw new Error('商品不存在或已被删除：请重新选择第 ' + (i + 1) + ' 行商品');
        }

        const oldCost = round2(Number(g.costPrice) || 0);
        const skus = Array.isArray(g.skus) ? g.skus.map((s) => ({
          key: String(s.key || ''),
          color: String(s.color || ''),
          size: String(s.size || ''),
          stock: Number(s.stock) || 0,
          costPrice: round2(Number(s.costPrice) || 0),
          price: round2(Number(s.price) || 0)
        })) : null;

        let lineUnitCost = l.unitCost;
        let lineAvgCost = l.unitCost; // 用于订单行展示的均价（加权后）
        let amount = 0;
        let stockAfter = 0;
        let newCost = oldCost;

        if (skus && skus.length) {
          const key = l.skuKey || makeSkuKey(l.color, l.size);
          const idx = skus.findIndex((s) => s.key === key);
          if (idx < 0) {
            throw new Error('SKU 不存在：' + (g.name || '') + ' / ' + (key || '(未指定)'));
          }
          const oldSkuStock = skus[idx].stock;
          const oldSkuCost = skus[idx].costPrice > 0 ? skus[idx].costPrice : oldCost;
          const stockSkuAfter = oldSkuStock + l.qty;
          // SKU 维度加权平均成本
          const newSkuCost = stockSkuAfter > 0
            ? round2((oldSkuCost * oldSkuStock + l.unitCost * l.qty) / stockSkuAfter)
            : l.unitCost;
          skus[idx].stock = stockSkuAfter;
          skus[idx].costPrice = newSkuCost;
          lineUnitCost = l.unitCost;
          lineAvgCost = newSkuCost;
          amount = round2(l.unitCost * l.qty);

          const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
          // 商品级 costPrice 取所有 SKU 的加权平均
          let totalQty = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
          let weightedCostSum = 0;
          skus.forEach((x) => { weightedCostSum += x.costPrice * x.stock; });
          newCost = totalQty > 0 ? round2(weightedCostSum / totalQty) : oldCost;

          await t.collection('goods').doc(l.goodsId).update({
            data: { skus: skus, totalStock: totalStock, costPrice: newCost, updatedAt: now }
          });
        } else {
          // ⚠️ 兼容旧数据
          const stock = Number(g.stock) || 0;
          stockAfter = stock + l.qty;
          newCost = stockAfter > 0
            ? round2((oldCost * stock + l.unitCost * l.qty) / stockAfter)
            : l.unitCost;
          amount = round2(l.unitCost * l.qty);

          await t.collection('goods').doc(l.goodsId).update({
            data: { stock: stockAfter, costPrice: newCost, updatedAt: now }
          });
        }

        totalAmount = round2(totalAmount + amount);
        savedLines.push({
          goodsId: l.goodsId,
          name: g.name || '',
          unit: g.unit || '件',
          qty: l.qty,
          unitCost: lineUnitCost,
          avgCost: lineAvgCost,
          amount: amount,
          skuKey: l.skuKey || (l.color || l.size ? makeSkuKey(l.color, l.size) : ''),
          color: l.color,
          size: l.size
        });
      }

      const order = {
        openid: OPENID,
        orderNo: orderNo,
        type: 'purchase',
        supplierId: supplierId,
        supplierName: supplierName,
        remark: remark,
        totalAmount: totalAmount,
        lines: savedLines,
        createdAt: now
      };
      const addRes = await t.collection('purchase_orders').add({ data: order });
      orderId = addRes._id;

      for (let i = 0; i < savedLines.length; i++) {
        const l = savedLines[i];
        await t.collection('inventory_logs').add({
          data: {
            openid: OPENID,
            type: 'purchase',
            action: 'in',
            goodsId: l.goodsId,
            goodsName: l.name,
            unit: l.unit,
            qty: l.qty,
            unitPrice: l.unitCost,
            skuKey: l.skuKey || '',
            color: l.color || '',
            size: l.size || '',
            refType: 'purchase',
            refId: orderId,
            createdAt: now
          }
        });
      }
    });

    return { success: true, orderId: orderId, orderNo: orderNo, totalAmount: totalAmount, supplierName: supplierName };
  } catch (e) {
    console.error('[submitPurchase]', e);
    return { success: false, message: (e && e.message) || '入库失败，请重试' };
  }
};
