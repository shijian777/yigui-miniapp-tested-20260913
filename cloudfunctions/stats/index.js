// 云函数 stats：统计报表聚合
// 在服务端做聚合（避免客户端全量拉明细），一次返回：
//   销售额/订单数/成本/毛利/进货额/进货单数/退货数/TOP5商品
// 口径：
//   - 销售统计只统计 status='completed' 的销售单（已退货的单整单剔除）
//   - 退货数按 returnedAt（退货发生时间）落在所选区间统计
//   - 成本 = Σ(明细 cost x qty)，cost 为销售时点商品加权平均成本快照
//   - 毛利 = 销售额(应收实收口径 amountDue) - 成本
// 区间由客户端换算成本地时区毫秒 [startMs, endMs) 传入，避免云函数时区问题。
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
function numOr(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}
function first(list) { return list && list.length ? list[0] : null; }

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, message: '无法获取用户身份' };

  const action = event.action || 'summary';
  const startMs = numOr(event.startMs, 0);
  const endMs = numOr(event.endMs, Date.now() + 86400000);
  if (startMs >= endMs) return { success: false, message: '日期区间不合法' };
  const from = new Date(startMs);
  const to = new Date(endMs);

  try {
    if (action === 'syncCustomers') {
      return await handleCustomers(db, $, _, OPENID);
    }
    if (action === 'debtCustomers') {
      return await handleDebtCustomers(db, $, _, OPENID);
    }
    if (action === 'debts') {
      // 欠款台账：所有未结清的销售欠款（completed + debt>0）
      // 返回：区间内 + 全期"待收总额/已结清总额/单数/列表"
      const debtRange = {
        openid: OPENID,
        status: 'completed',
        paymentMethod: 'credit',
        createdAt: _.gte(from).and(_.lt(to))
      };
      const allDebtsRange = {
        openid: OPENID,
        status: 'completed',
        paymentMethod: 'credit',
        debt: _.gt(0)
      };

      // 区间汇总（新增欠款）
      const aggInRange = await db.collection('sales_orders').aggregate()
        .match(debtRange)
        .group({
          _id: null,
          count: $.sum(1),
          amountDue: $.sum('$amountDue'),
          received: $.sum('$received'),
          debt: $.sum('$debt')
        })
        .end();
      const r = first(aggInRange.list) || {};
      const rangeCount = numOr(r.count, 0);
      const rangeAmountDue = round2(r.amountDue);
      const rangeReceived = round2(r.received);
      const rangeDebt = round2(r.debt);

      // 全期"待收总额 + 单数"（debt > 0 的 completed 单汇总）
      const aggAll = await db.collection('sales_orders').aggregate()
        .match(allDebtsRange)
        .group({
          _id: null,
          totalDebt: $.sum('$debt'),
          totalReceived: $.sum('$received'),
          totalAmountDue: $.sum('$amountDue'),
          count: $.sum(1)
        })
        .end();
      const a = first(aggAll.list) || {};
      const totalDebt = round2(a.totalDebt);
      const totalReceived = round2(a.totalReceived);
      const totalAmountDue = round2(a.totalAmountDue);
      const totalCount = numOr(a.count, 0);

      // 列表：区间内"按 debt 倒序"的前 100 条（debt > 0 排前面）
      const listRes = await db.collection('sales_orders')
        .where(Object.assign({}, debtRange, { debt: _.gt(0) }))
        .orderBy('debt', 'desc')
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
      const list = (listRes.data || []).map((o) => ({
        _id: o._id,
        orderNo: o.orderNo || '',
        amountDue: round2(o.amountDue),
        received: round2(o.received),
        debt: round2(o.debt),
        customerName: o.customerName || '',
        customerPhone: o.customerPhone || '',
        remark: o.remark || '',
        createdAt: o.createdAt
      }));

      // 已结清（区间内 debt=0 的 credit 单）：用于"已收回"展示
      const clearedRes = await db.collection('sales_orders')
        .where(Object.assign({}, debtRange, { debt: 0 }))
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
      const clearedList = (clearedRes.data || []).map((o) => ({
        _id: o._id,
        orderNo: o.orderNo || '',
        amountDue: round2(o.amountDue),
        received: round2(o.received),
        customerName: o.customerName || '',
        customerPhone: o.customerPhone || '',
        remark: o.remark || '',
        createdAt: o.createdAt
      }));

      return {
        success: true,
        data: {
          startMs: startMs,
          endMs: endMs,
          // 全期累计（不受区间限制，看到"还欠多少"）
          totalDebt: totalDebt,
          totalReceived: totalReceived,
          totalAmountDue: totalAmountDue,
          totalCount: totalCount,
          // 区间内
          rangeCount: rangeCount,
          rangeAmountDue: rangeAmountDue,
          rangeReceived: rangeReceived,
          rangeDebt: rangeDebt,
          // 列表：先按 debt desc，再补已结清
          list: list,
          clearedList: clearedList
        }
      };
    }

    // 1) 销售单汇总（不含已退货）
    const saleRange = { openid: OPENID, status: 'completed', createdAt: _.gte(from).and(_.lt(to)) };
    const salesAgg = await db.collection('sales_orders').aggregate()
      .match(saleRange)
      .group({
        _id: null,
        count: $.sum(1),
        amount: $.sum('$amountDue'),
        subtotal: $.sum('$subtotal'),
        discount: $.sum('$discountAmount'),
        erase: $.sum('$eraseAmount')
      })
      .end();
    const s = first(salesAgg.list) || {};
    const salesCount = numOr(s.count, 0);
    const salesAmount = round2(s.amount);
    const subtotal = round2(s.subtotal);

    // 2) 销售成本：展开明细行后求和 cost x qty
    const costAgg = await db.collection('sales_orders').aggregate()
      .match(saleRange)
      .unwind('$lines')
      .group({
        _id: null,
        cost: $.sum({ $multiply: ['$lines.cost', '$lines.qty'] }),
        qty: $.sum('$lines.qty')
      })
      .end();
    const c = first(costAgg.list) || {};
    const saleCost = round2(c.cost);
    const soldQty = numOr(c.qty, 0); // 销售总件数（completed 单明细 qty 之和）
    const grossProfit = round2(salesAmount - saleCost);

    // 3) TOP5 商品：按销售额（折前明细额）排序，附销量/销售额
    const topAgg = await db.collection('sales_orders').aggregate()
      .match(saleRange)
      .unwind('$lines')
      .group({
        _id: '$lines.goodsId',
        name: $.first('$lines.name'),
        unit: $.first('$lines.unit'),
        qty: $.sum('$lines.qty'),
        amount: $.sum('$lines.amount')
      })
      .sort({ amount: -1 })
      .limit(5)
      .end();
    const topGoods = (topAgg.list || []).map((row) => ({
      goodsId: row._id,
      name: row.name || '未知商品',
      unit: row.unit || '件',
      qty: numOr(row.qty, 0),
      amount: round2(row.amount)
    }));

    // 4) 退货数（按退货时间）
    const retAgg = await db.collection('sales_orders').aggregate()
      .match({ openid: OPENID, status: 'returned', returnedAt: _.gte(from).and(_.lt(to)) })
      .group({ _id: null, count: $.sum(1) })
      .end();
    const returnedCount = numOr(first(retAgg.list) && first(retAgg.list).count, 0);

    // 5) 进货统计（进货单无退货，全部计入）
    const purAgg = await db.collection('purchase_orders').aggregate()
      .match({ openid: OPENID, createdAt: _.gte(from).and(_.lt(to)) })
      .group({ _id: null, count: $.sum(1), amount: $.sum('$totalAmount') })
      .end();
    const p = first(purAgg.list) || {};
    const purchaseCount = numOr(p.count, 0);
    const purchaseAmount = round2(p.amount);

    // 6) 进货件数：展开进货明细行后求和 qty
    const purQtyAgg = await db.collection('purchase_orders').aggregate()
      .match({ openid: OPENID, createdAt: _.gte(from).and(_.lt(to)) })
      .unwind('$lines')
      .group({ _id: null, qty: $.sum('$lines.qty') })
      .end();
    const purchaseQty = numOr(first(purQtyAgg.list) && first(purQtyAgg.list).qty, 0);

    // 7) 色码销售占比（按 color 分组，TOP10）
    const colorAgg = await db.collection('sales_orders').aggregate()
      .match(saleRange)
      .unwind('$lines')
      .match({ 'lines.color': _.exists(true) })
      .group({
        _id: '$lines.color',
        qty: $.sum('$lines.qty'),
        amount: $.sum('$lines.amount')
      })
      .sort({ amount: -1 })
      .limit(10)
      .end();
    const colorBreakdown = (colorAgg.list || []).map((row) => ({
      color: row._id || '未指定',
      qty: numOr(row.qty, 0),
      amount: round2(row.amount)
    }));

    // 8) 尺码销售占比
    const sizeAgg = await db.collection('sales_orders').aggregate()
      .match(saleRange)
      .unwind('$lines')
      .match({ 'lines.size': _.exists(true) })
      .group({
        _id: '$lines.size',
        qty: $.sum('$lines.qty'),
        amount: $.sum('$lines.amount')
      })
      .sort({ amount: -1 })
      .limit(10)
      .end();
    const sizeBreakdown = (sizeAgg.list || []).map((row) => ({
      size: row._id || '未指定',
      qty: numOr(row.qty, 0),
      amount: round2(row.amount)
    }));

    return {
      success: true,
      data: {
        startMs: startMs,
        endMs: endMs,
        salesCount: salesCount,
        salesAmount: salesAmount,
        soldQty: soldQty,
        subtotal: subtotal,
        saleCost: saleCost,
        grossProfit: grossProfit,
        purchaseCount: purchaseCount,
        purchaseAmount: purchaseAmount,
        purchaseQty: purchaseQty,
        returnedCount: returnedCount,
        topGoods: topGoods,
        colorBreakdown: colorBreakdown,
        sizeBreakdown: sizeBreakdown
      }
    };
  } catch (e) {
    console.error('[stats]', e);
    const msg = (e && e.message) || '';
    if (/not exist|not found|collection/i.test(msg)) {
      return { success: false, message: '数据库集合尚未初始化，请按 README 第 5 步创建集合（sales_orders / purchase_orders）' };
    }
    return { success: false, message: '统计失败：' + msg };
  }
};

// 辅助动作：客户聚合（写在 main 函数末尾之前会复杂化结构，这里用单独的小函数然后 switch）
async function handleCustomers(db, $, _, OPENID) {
  // 1) 按 customerId 聚合 sales_orders（只算 completed，未退货）
  const agg = await db.collection('sales_orders').aggregate()
    .match({ openid: OPENID, status: 'completed', customerId: _.exists(true) })
    .group({
      _id: '$customerId',
      totalSpent: $.sum('$amountDue'),
      totalOrders: $.sum(1),
      totalDebt: $.sum('$debt'),
      lastOrderAt: $.max('$createdAt')
    })
    .end();
  const updates = agg.list || [];
  let updated = 0;
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    try {
      await db.collection('customers').doc(u._id).update({
        data: {
          totalSpent: round2(u.totalSpent),
          totalOrders: u.totalOrders,
          totalDebt: round2(u.totalDebt),
          lastOrderAt: u.lastOrderAt
        }
      });
      updated++;
    } catch (e) { /* customer 被删：忽略 */ }
  }
  return { success: true, updated: updated };
}

// 辅助动作：欠款按客户聚合（不更新数据库，纯返回）
async function handleDebtCustomers(db, $, _, OPENID) {
  const agg = await db.collection('sales_orders').aggregate()
    .match({ openid: OPENID, status: 'completed', debt: _.gt(0) })
    .group({
      _id: {
        customerId: '$customerId',
        customerName: '$customerName',
        customerPhone: '$customerPhone'
      },
      totalDebt: $.sum('$debt'),
      orderCount: $.sum(1)
    })
    .sort({ totalDebt: -1 })
    .limit(200)
    .end();
  const list = (agg.list || []).map((row) => {
    const id = row._id && row._id.customerId ? row._id.customerId : '';
    return {
      customerId: id,
      customerName: (row._id && row._id.customerName) || '未指定',
      customerPhone: (row._id && row._id.customerPhone) || '',
      totalDebt: round2(row.totalDebt),
      orderCount: row.orderCount || 0
    };
  });
  const totalDebt = list.reduce((s, x) => s + x.totalDebt, 0);
  return { success: true, data: { list: list, totalDebt: totalDebt } };
}
