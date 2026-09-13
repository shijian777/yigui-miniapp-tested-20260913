// pages/debts/debts.js —— 欠款台账（记账欠款 paymentMethod='credit' 的销售单）
// 顶部汇总 + 时间筛选 + 列表：
//   - 待收总额（全期，不随区间变化）——"现在还欠我多少"
//   - 区间内新增/已收回/欠款净额
//   - 列表按 debt 倒序（欠最多的在最上面），后跟已结清
//   - 按客户聚合：欠款总额按客户汇总，催收导向
const util = require('../../utils/util.js');

Page({
  data: {
    tab: 'list',               // list | byCustomer
    quick: 'month',
    startDate: '',
    endDate: '',
    summary: { totalDebt: '0.00', totalReceived: '0.00', totalAmountDue: '0.00', totalCount: 0 },
    rangeStats: { count: 0, amountDue: '0.00', received: '0.00', debt: '0.00' },
    customerAgg: { totalDebt: '0.00', list: [] },
    list: [],
    clearedList: [],
    loading: true,
    errText: ''
  },

  onLoad() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const today = util.todayStr();
    this.setData({ startDate: util.addDays(today, -29), endDate: today });
    this.reload();
  },

  onUnload() { this._disposed = true; this._requestSeq = (this._requestSeq || 0) + 1; },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  setTab(e) {
    const t = e.currentTarget.dataset.t;
    if (t === this.data.tab) return;
    this.setData({ tab: t });
    this.reload();
  },

  setQuick(e) {
    const q = e.currentTarget.dataset.q;
    const today = util.todayStr();
    let start = today;
    if (q === 'today') start = today;
    else if (q === 'week') start = util.addDays(today, -6);
    else if (q === 'month') start = util.addDays(today, -29);
    else if (q === 'all') {
      this.setData({ quick: q, startDate: '2020-01-01', endDate: today });
      this.reload();
      return;
    }
    this.setData({ quick: q, startDate: start, endDate: today });
    this.reload();
  },
  onStartChange(e) {
    this.setData({ startDate: e.detail.value, quick: '' });
  },
  onEndChange(e) {
    this.setData({ endDate: e.detail.value, quick: '' });
    // 选完结束日期自动刷新（与 stats 一致），无需点查询按钮
    this.reload();
  },
  doQuery() { this.reload(); },

  async reload() {
    const seq = this._requestSeq = (this._requestSeq || 0) + 1;
    this.setData({ loading: true, errText: '' });
    try {
      await util.ensureOpenid();
      if (seq !== this._requestSeq) return;
      const { startMs, endMs } = util.rangeMs(this.data.startDate, this.data.endDate);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('开始日期不能晚于结束日期，请重新选择');
      const r = await util.fetchDebts({ startMs: startMs, endMs: endMs });
      if (seq !== this._requestSeq) return;
      const d = r.data || {};
      const summary = {
        totalDebt: util.fmtMoney(d.totalDebt),
        totalReceived: util.fmtMoney(d.totalReceived),
        totalAmountDue: util.fmtMoney(d.totalAmountDue),
        totalCount: d.totalCount || 0
      };
      const rangeStats = {
        count: d.rangeCount || 0,
        amountDue: util.fmtMoney(d.rangeAmountDue),
        received: util.fmtMoney(d.rangeReceived),
        debt: util.fmtMoney(d.rangeDebt)
      };
      const list = (d.list || []).map(this.toRow);
      const clearedList = (d.clearedList || []).map(this.toRow);

      // 客户聚合（无条件全期）
      let customerAgg = { totalDebt: '0.00', list: [] };
      try {
        const cr = await util.fetchDebtCustomers();
        if (seq !== this._requestSeq) return;
        const cd = (cr && cr.data) || {};
        customerAgg = {
          totalDebt: util.fmtMoney(cd.totalDebt || 0),
          list: (cd.list || []).map((c) => Object.assign({}, c, { customerKey: c.customerKey || c.customerId || (c.customerPhone ? 'phone:' + c.customerPhone : 'name:' + c.customerName), totalDebtText: util.fmtMoney(c.totalDebt) }))
        };
      } catch (e) { if (seq !== this._requestSeq) return; }
      if (seq !== this._requestSeq) return;

      this.setData({
        summary: summary,
        rangeStats: rangeStats,
        list: list,
        clearedList: clearedList,
        customerAgg: customerAgg,
        loading: false
      });
    } catch (e) {
      if (seq !== this._requestSeq) return;
      this.setData({ list: [], clearedList: [], summary: {}, rangeStats: {}, customerAgg: { list: [] }, loading: false, errText: (e && e.message) || '查询失败' });
    }
  },

  toRow(o) {
    return {
      rowKey: o._id,
      _id: o._id,
      orderNo: o.orderNo || '',
      amountDueText: util.fmtMoney(o.amountDue),
      receivedText: util.fmtMoney(o.received),
      debtText: util.fmtMoney(o.debt),
      hasCustomer: !!(o.customerName || o.customerPhone),
      customerText: o.customerName ? (o.customerName + (o.customerPhone ? ' · ' + o.customerPhone : '')) : '',
      remark: o.remark || '',
      timeText: util.fmtDateTime(o.createdAt)
    };
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + encodeURIComponent(id) + '&type=sale', events: { orderChanged: () => { if (!this._disposed) this.reload(); } } });
  },
  // 客户行点击：如果有 customerId 跳详情（暂未做详情页，跳新建/编辑）
  goCustomer(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + id });
    } else {
      wx.navigateTo({ url: '/pages/customers/customers' });
    }
  }
});
