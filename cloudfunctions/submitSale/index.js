// 云函数 submitSale：销售开单 —— 单事务内完成
//   1) 逐行读取商品（事务内 doc.get），校验库存（按 SKU）
//   2) 扣减库存（绝对数值写入，事务自带冲突重试，避免并发覆盖）
//   3) 写入销售单 sales_orders
//   4) 写库存流水 inventory_logs（每条明细一条）
// 任一步失败则整体回滚。金额一律由服务端重算，客户端传的值只当输入。
//
// 【SKU 兼容】如果商品有 skus 字段且 line 传了 skuKey，按 SKU 维度扣 + 维护 totalStock；
// 否则 fallback 到 goods.stock 单一字段（兼容未迁移旧数据）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LINES = 30;
const PAYMENTS = ['cash', 'wechat', 'alipay', 'credit'];
const PAYMENT_TEXT = { cash: '现金', wechat: '微信', alipay: '支付宝', credit: '记账欠款' };

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

function genOrderNo(prefix) {
  const d = new Date();
  return prefix + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
    Math.floor(Math.random() * 90 + 10);
}

function calcTotals(lines, discountPct, erase) {
  let subtotal = 0;
  for (let i = 0; i < lines.length; i++) {
    subtotal = round2(subtotal + round2(lines[i].price * lines[i].qty));
  }
  const afterDiscount = round2(subtotal * discountPct / 100);
  const discountAmount = round2(subtotal - afterDiscount);
  const amountDue = erase ? Math.floor(afterDiscount) : afterDiscount;
  const eraseAmount = erase ? round2(afterDiscount - amountDue) : 0;
  return { subtotal: subtotal, discountAmount: discountAmount, eraseAmount: eraseAmount, amountDue: amountDue };
}

// 由"颜色+尺码"生成稳定的 SKU key（和 utils/util.js 保持一致）
function makeSkuKey(color, size) {
  return String(color || '') + '·' + String(size || '');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  try {
    const rawLines = Array.isArray(event.lines) ? event.lines : [];
    if (!rawLines.length) return { success: false, message: '订单明细为空' };
    if (rawLines.length > MAX_LINES) return { success: false, message: '单笔最多 ' + MAX_LINES + ' 项商品' };

    const lines = [];
    for (let i = 0; i < rawLines.length; i++) {
      const rl = rawLines[i] || {};
      const goodsId = String(rl.goodsId || '').trim();
      const qty = Math.floor(toNum(rl.qty, 0));
      const price = round2(Math.max(0, toNum(rl.price, 0)));
      const skuKey = String(rl.skuKey || '').trim();
      const color = String(rl.color || '').slice(0, 30);
      const size = String(rl.size || '').slice(0, 20);
      if (!goodsId) return { success: false, message: '第 ' + (i + 1) + ' 行缺少商品' };
      if (qty < 1 || qty > 99999) return { success: false, message: '第 ' + (i + 1) + ' 行数量不合法' };
      if (price > 9999999) return { success: false, message: '第 ' + (i + 1) + ' 行单价过大' };
      lines.push({ goodsId: goodsId, qty: qty, price: price, skuKey: skuKey, color: color, size: size });
    }

    let pct = toNum(event.discountPct, 100);
    if (!isFinite(pct)) pct = 100;
    pct = Math.min(100, Math.max(0, pct));
    const erase = !!event.erase;
    const payment = PAYMENTS.indexOf(event.paymentMethod) >= 0 ? event.paymentMethod : 'cash';
    const remark = String(event.remark || '').slice(0, 200);
    const customerName = String(event.customerName || '').trim().slice(0, 50);
    const customerPhone = String(event.customerPhone || '').trim().slice(0, 20);
    const customerId = String(event.customerId || '').trim();
    const receivedRaw = Math.max(0, Math.min(99999999, toNum(event.received, 0)));

    const totals = calcTotals(lines, pct, erase);
    const received = receivedRaw;
    const change = received > totals.amountDue ? round2(received - totals.amountDue) : 0;
    const debt = totals.amountDue > received ? round2(totals.amountDue - received) : 0;

    const now = new Date();
    const orderNo = genOrderNo('XS');
    let orderId = '';
    let savedLines = [];

    await db.runTransaction(async (t) => {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        let g = null;
        try {
          const res = await t.collection('goods').doc(l.goodsId).get();
          g = res.data;
        } catch (e) { g = null; }
        if (!g || g.openid !== OPENID) {
          throw new Error('商品不存在或已被删除，请返回购物车检查');
        }

        // ---- 计算"扣减后"的库存 ----
        let lineCost = round2(Number(g.costPrice) || 0); // 售出时成本快照
        let skus = null;
        let stockAfter = 0;
        let skuMatched = false;

        if (Array.isArray(g.skus) && g.skus.length) {
          // ✅ 新数据：按 SKU 维度扣
          skus = g.skus.map((s) => ({
            key: String(s.key || ''),
            color: String(s.color || ''),
            size: String(s.size || ''),
            stock: Number(s.stock) || 0,
            costPrice: round2(Number(s.costPrice) || 0),
            price: round2(Number(s.price) || 0)
          }));
          const key = l.skuKey || makeSkuKey(l.color, l.size);
          const idx = skus.findIndex((s) => s.key === key);
          if (idx < 0) {
            throw new Error('SKU 不存在：' + (g.name || '') + ' / ' + (key || '(未指定)'));
          }
          if (skus[idx].stock < l.qty) {
            throw new Error('库存不足：' + (g.name || '') + ' ' + (key || '') + ' 仅剩 ' + skus[idx].stock + ' 件');
          }
          skus[idx].stock = skus[idx].stock - l.qty;
          skuMatched = true;
          // SKU 级成本快照：优先用 SKU 自己的 costPrice，否则用商品级
          lineCost = skus[idx].costPrice > 0 ? skus[idx].costPrice : lineCost;
        } else {
          // ⚠️ 兼容旧数据：单一 stock 字段
          const stock = Number(g.stock) || 0;
          if (stock < l.qty) {
            throw new Error('库存不足：' + (g.name || '') + ' 仅剩 ' + stock + ' 件');
          }
          stockAfter = stock - l.qty;
        }

        // ---- 写回商品 ----
        if (skuMatched) {
          const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
          await t.collection('goods').doc(l.goodsId).update({
            data: { skus: skus, totalStock: totalStock, updatedAt: now }
          });
        } else {
          await t.collection('goods').doc(l.goodsId).update({
            data: { stock: stockAfter, updatedAt: now }
          });
        }

        savedLines.push({
          goodsId: l.goodsId,
          name: g.name || '',
          unit: g.unit || '件',
          price: l.price,
          qty: l.qty,
          amount: round2(l.price * l.qty),
          cost: lineCost,
          skuKey: l.skuKey || (l.color || l.size ? makeSkuKey(l.color, l.size) : ''),
          color: l.color,
          size: l.size
        });
      }

      const order = {
        openid: OPENID,
        orderNo: orderNo,
        type: 'sale',
        status: 'completed',
        paymentMethod: payment,
        paymentMethodText: PAYMENT_TEXT[payment],
        subtotal: totals.subtotal,
        discountPct: pct,
        discountAmount: totals.discountAmount,
        erase: erase,
        eraseAmount: totals.eraseAmount,
        amountDue: totals.amountDue,
        received: received,
        change: change,
        debt: debt,
        remark: remark,
        customerId: customerId,
        customerName: customerName,
        customerPhone: customerPhone,
        lines: savedLines,
        createdAt: now
      };
      const addRes = await t.collection('sales_orders').add({ data: order });
      orderId = addRes._id;

      for (let i = 0; i < savedLines.length; i++) {
        const l = savedLines[i];
        await t.collection('inventory_logs').add({
          data: {
            openid: OPENID,
            type: 'sale',
            action: 'out',
            goodsId: l.goodsId,
            goodsName: l.name,
            unit: l.unit,
            qty: l.qty,
            unitPrice: l.cost,
            skuKey: l.skuKey || '',
            color: l.color || '',
            size: l.size || '',
            refType: 'sale',
            refId: orderId,
            createdAt: now
          }
        });
      }
    });

    return {
      success: true,
      orderId: orderId,
      orderNo: orderNo,
      amountDue: totals.amountDue,
      received: received,
      change: change,
      debt: debt
    };
  } catch (e) {
    console.error('[submitSale]', e);
    return { success: false, message: (e && e.message) || '开单失败，请重试' };
  }
};
