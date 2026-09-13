// 云函数 settleDebt：补收销售单欠款（不改动库存/明细）
// 适用：已开记账欠款单（paymentMethod='credit' 且 debt > 0），顾客再来补交。
// 入参：orderId + amount(本次收款金额) + paymentMethod(本次收款方式 cash/wechat/alipay)
// 行为：
//   - 加到原 received；重新算 debt = max(0, amountDue - received) 与 change = max(0, received - amountDue)
//   - 若 debt == 0 且原 paymentMethod 是 credit：把 paymentMethod 改成入参的 paymentMethod（默认 cash）
//     同时写入 settleHistory 数组（追加本次结清记录），便于日后查
//   - 校验：订单归属本人、status=completed、有未结清欠款
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAYMENTS = ['cash', 'wechat', 'alipay'];
const PAYMENT_TEXT = { cash: '现金', wechat: '微信', alipay: '支付宝' };

function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function toNum(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function nowStr() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  try {
    const orderId = String(event.orderId || '').trim();
    if (!orderId) return { success: false, message: '缺少订单 ID' };

    const amount = round2(toNum(event.amount, 0));
    if (amount <= 0) return { success: false, message: '收款金额必须大于 0' };
    if (amount > 9999999) return { success: false, message: '收款金额过大' };

    const payment = PAYMENTS.indexOf(event.paymentMethod) >= 0 ? event.paymentMethod : 'cash';
    const note = String(event.note || '').slice(0, 100);

    // 1) 取订单（本人 + completed + debt > 0）
    const orderRes = await db.collection('sales_orders').doc(orderId).get().catch(() => ({ data: null }));
    const order = orderRes.data;
    if (!order || order.openid !== OPENID) return { success: false, message: '订单不存在或不是本人数据' };
    if (order.status !== 'completed') return { success: false, message: '只能对「正常」订单补收欠款' };

    const oldReceived = Number(order.received) || 0;
    const amountDue = Number(order.amountDue) || 0;
    const oldDebt = Number(order.debt) || 0;
    if (oldDebt <= 0) return { success: false, message: '该订单没有欠款，无需补收' };
    if (amount > oldDebt) return { success: false, message: '收款金额不能超过欠款 ¥' + round2(oldDebt) };

    const newReceived = round2(oldReceived + amount);
    const newDebt = amountDue > newReceived ? round2(amountDue - newReceived) : 0;
    const newChange = newReceived > amountDue ? round2(newReceived - amountDue) : 0;
    const fullyCleared = newDebt === 0;
    // 原 credit 单若已结清：paymentMethod 切换为本次收款方式；paymentMethodText 也同步
    let newPayMethod = order.paymentMethod || 'credit';
    let newPayText = order.paymentMethodText || PAYMENT_TEXT[order.paymentMethod] || '记账欠款';
    if (fullyCleared && order.paymentMethod === 'credit') {
      newPayMethod = payment;
      newPayText = PAYMENT_TEXT[payment];
    }

    // 2) 写结算记录（追加）
    const oldHistory = Array.isArray(order.settleHistory) ? order.settleHistory : [];
    const newEntry = {
      amount: amount,
      paymentMethod: payment,
      paymentMethodText: PAYMENT_TEXT[payment],
      at: new Date(),
      atText: nowStr(),
      note: note
    };

    const update = {
      received: newReceived,
      change: newChange,
      debt: newDebt,
      paymentMethod: newPayMethod,
      paymentMethodText: newPayText,
      settleHistory: oldHistory.concat([newEntry]),
      updatedAt: new Date()
    };

    await db.collection('sales_orders').doc(orderId).update({ data: update });

    return {
      success: true,
      orderId: orderId,
      added: amount,
      received: newReceived,
      debt: newDebt,
      change: newChange,
      fullyCleared: fullyCleared,
      paymentMethod: newPayMethod,
      paymentMethodText: newPayText
    };
  } catch (e) {
    console.error('[settleDebt]', e);
    return { success: false, message: (e && e.message) || '结清失败，请重试' };
  }
};