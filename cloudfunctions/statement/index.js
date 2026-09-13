// 云函数 statement：对账单
// 入参：customerId（可选，按 customerId 拉）+ startMs/endMs（必传）
//      如果没传 customerId 但传了 customerName/Phone，则按姓名/电话模糊匹配
// 输出：该客户在区间内的：
//   - 销售单（completed + returned 区分；列金额/收款/欠款/退货）
//   - 已结清欠款（paymentMethod 变化记 settlement_logs，本函数不查）
//   - 累计：销售总额 / 已收款 / 仍欠款 / 退货总额 / 单数
//   - 返回时附加 sales_orders 列表 + purchase_orders（如有）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function numOr(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  const startMs = numOr(event.startMs, 0);
  const endMs = numOr(event.endMs, Date.now() + 86400000);
  if (startMs >= endMs) return { success: false, message: '日期区间不合法' };

  const customerId = String(event.customerId || '');
  const customerName = String(event.customerName || '').trim();

  const from = new Date(startMs);
  const to = new Date(endMs);

  try {
    let customerMatch = {};
    if (customerId) {
      customerMatch = { customerId: customerId };
    } else if (customerName) {
      // 用 RegExp 模糊匹配
      const reg = db.RegExp({ regexp: customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
      customerMatch = { customerName: reg };
    } else {
      return { success: false, message: '请指定客户（选客户或输入姓名）' };
    }

    const where = Object.assign({
      openid: OPENID,
      createdAt: _.gte(from).and(_.lt(to))
    }, customerMatch);

    // 1) 拉所有订单
    const ordersRes = await db.collection('sales_orders').where(where).orderBy('createdAt', 'asc').limit(500).get();
    const orders = ordersRes.data || [];

    // 2) 聚合统计
    const agg = await db.collection('sales_orders').aggregate()
      .match(where)
      .group({
        _id: '$status',
        count: $.sum(1),
        amount: $.sum('$amountDue'),
        received: $.sum('$received'),
        debt: $.sum('$debt')
      })
      .end();
    let completed = { count: 0, amount: 0, received: 0, debt: 0 };
    let returned = { count: 0, amount: 0, received: 0, debt: 0 };
    (agg.list || []).forEach((row) => {
      const v = {
        count: row.count || 0,
        amount: round2(row.amount),
        received: round2(row.received),
        debt: round2(row.debt)
      };
      if (row._id === 'returned') returned = v;
      else completed = v;
    });

    // 3) 客户基本信息（若有 customerId）
    let customer = null;
    if (customerId) {
      try {
        const c = await db.collection('customers').doc(customerId).get();
        customer = c.data || null;
      } catch (e) {}
    } else if (orders.length) {
      customer = {
        _id: '',
        name: orders[0].customerName || customerName,
        phone: orders[0].customerPhone || ''
      };
    }

    // 4) 列表（每条销售单已付/未付/退货）
    const list = orders.map((o) => ({
      _id: o._id,
      orderNo: o.orderNo || '',
      status: o.status || 'completed',
      type: 'sale',
      createdAt: o.createdAt,
      timeText: util_fmtDt(o.createdAt),
      amount: round2(o.amountDue),
      received: round2(o.received),
      debt: round2(o.debt),
      paymentMethod: o.paymentMethod || '',
      paymentMethodText: o.paymentMethodText || '',
      remark: o.remark || '',
      skuCount: Array.isArray(o.lines) ? o.lines.length : 0
    }));

    return {
      success: true,
      data: {
        customer: customer,
        range: { startMs: startMs, endMs: endMs },
        summary: {
          completed: completed,
          returned: returned,
          netSales: round2(completed.amount - returned.amount),
          totalReceived: round2(completed.received - returned.received),
          outstandingDebt: round2(completed.debt - returned.debt)
        },
        list: list
      }
    };
  } catch (e) {
    console.error('[statement]', e);
    return { success: false, message: e.message || '对账单生成失败' };
  }
};

function util_fmtDt(d) {
  if (!d) return '';
  const x = (d instanceof Date) ? d : new Date(d);
  const Y = x.getFullYear();
  const M = (x.getMonth() + 1) < 10 ? '0' + (x.getMonth() + 1) : '' + (x.getMonth() + 1);
  const D = x.getDate() < 10 ? '0' + x.getDate() : '' + x.getDate();
  const h = x.getHours() < 10 ? '0' + x.getHours() : '' + x.getHours();
  const m = x.getMinutes() < 10 ? '0' + x.getMinutes() : '' + x.getMinutes();
  return Y + '-' + M + '-' + D + ' ' + h + ':' + m;
}
