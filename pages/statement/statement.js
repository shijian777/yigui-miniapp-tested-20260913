// pages/statement/statement.js —— 客户对账单
const util = require('../../utils/util.js');

// 路由参数仅解码一次，保留姓名里的字面 %20；非法编码按原文显示。
function decodeRouteValue(value) {
  const text = value || '';
  try { return decodeURIComponent(text); } catch (e) { return text; }
}

Page({
  data: {
    customerId: '',
    customerName: '',
    customerLabel: '未选',
    startDate: '',
    endDate: '',
    quick: 'month',
    summary: null,
    list: [],
    loading: false
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const today = util.todayStr();
    this.setData({
      startDate: util.addDays(today, -29),
      endDate: today,
      customerId: decodeRouteValue(query && query.customerId),
      customerName: decodeRouteValue(query && query.customerName)
    });
    if (this.data.customerId) {
      this.setData({ customerLabel: this.data.customerName || '已选客户' });
    }
    this.reload();
  },

  onUnload() { this._disposed = true; this._requestSeq = (this._requestSeq || 0) + 1; },

  pickCustomer() {
    wx.navigateTo({
      url: '/pages/customers/customers?from=picker',
      events: {
        picked: (c) => {
          if (!c || this._disposed) return;
          this.setData({
            customerId: c._id,
            customerName: c.name || '',
            customerLabel: c.name + (c.phone ? ' · ' + c.phone : '')
          });
          this.reload();
        }
      }
    });
  },
  clearCustomer() {
    this.setData({ customerId: '', customerName: '', customerLabel: '未选' });
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
    if (!this.data.customerId && !this.data.customerName) {
      this.setData({ summary: null, list: [], loading: false, errText: '' });
      return;
    }
    this.setData({ loading: true, summary: null, list: [], errText: '' });
    try {
      const { startMs, endMs } = util.rangeMs(this.data.startDate, this.data.endDate);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('开始日期不能晚于结束日期，请重新选择');
      const r = await util.callFn('statement', {
        customerId: this.data.customerId,
        customerName: this.data.customerName,
        startMs: startMs,
        endMs: endMs
      });
      if (seq !== this._requestSeq) return;
      const d = (r && r.data) || {};
      const summary = d.summary || null;
      const list = (d.list || []).map((it) => Object.assign({}, it, {
        amountText: util.fmtMoney(it.amount),
        receivedText: util.fmtMoney(it.received),
        debtText: util.fmtMoney(it.debt)
      }));
      this.setData({ summary: summary, list: list, loading: false });
    } catch (e) {
      if (seq !== this._requestSeq) return;
      this.setData({ loading: false, errText: e.message || '查询失败' });
      wx.showToast({ title: e.message || '查询失败', icon: 'none' });
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + encodeURIComponent(id) + '&type=sale', events: { orderChanged: () => { if (!this._disposed) this.reload(); } } });
  }
});
