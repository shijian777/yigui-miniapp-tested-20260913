// pages/stats/stats.js —— 统计报表（聚合全部在 stats 云函数内完成）
const util = require('../../utils/util.js');

Page({
  data: {
    quick: 'week',
    startDate: '',
    endDate: '',
    loading: true,
    stat: {
      salesCount: 0, soldQty: 0, salesAmount: '0.00', grossProfitText: '0.00', grossProfit: 0,
      saleCost: '0.00', purchaseCount: 0, purchaseAmount: '0.00',
      returnedCount: 0, topGoods: []
    }
  },

  onLoad() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const today = util.todayStr();
    this.setData({ startDate: util.addDays(today, -6), endDate: today });
  },
  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
    this.load();
  },
  onUnload() { this._requestSeq = (this._requestSeq || 0) + 1; },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  setQuick(e) {
    const q = e.currentTarget.dataset.q;
    const today = util.todayStr();
    let start = today;
    if (q === 'yesterday') start = util.addDays(today, -1);
    else if (q === 'week') start = util.addDays(today, -6);
    else if (q === 'month') start = util.addDays(today, -29);
    // custom 保留当前日期不动
    if (q !== 'custom') this.setData({ startDate: start, endDate: q === 'yesterday' ? start : today });
    this.setData({ quick: q });
    if (q !== 'custom') this.load();
  },
  onStartChange(e) {
    this.setData({ startDate: e.detail.value, quick: 'custom' });
  },
  onEndChange(e) {
    this.setData({ endDate: e.detail.value, quick: 'custom' });
    // 选完结束日期自动刷新（用户期望立刻看到结果）
    this.load();
  },

  async load() {
    const seq = this._requestSeq = (this._requestSeq || 0) + 1;
    this.setData({ loading: true, errText: '' });
    try {
      const { startMs, endMs } = util.rangeMs(this.data.startDate, this.data.endDate);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('开始日期不能晚于结束日期，请重新选择');
      const r = await util.fetchStats({ startMs: startMs, endMs: endMs });
      if (seq !== this._requestSeq) return;
      const d = r.data || {};
      const stat = {
        salesCount: d.salesCount || 0,
        soldQty: d.soldQty || 0,
        salesAmount: util.fmtMoney(d.salesAmount),
        grossProfit: Number(d.grossProfit) || 0,
        grossProfitText: util.fmtMoney(d.grossProfit),
        saleCost: util.fmtMoney(d.saleCost),
        purchaseCount: d.purchaseCount || 0,
        purchaseAmount: util.fmtMoney(d.purchaseAmount),
        returnedCount: d.returnedCount || 0,
        topGoods: (d.topGoods || []).map((g) => ({
          goodsId: g.goodsId,
          name: g.name,
          qty: g.qty,
          unit: g.unit || '件',
          amountText: util.fmtMoney(g.amount)
        }))
      };
      this.setData({ stat: stat, loading: false });
    } catch (e) {
      if (seq !== this._requestSeq) return;
      this.setData({ loading: false, stat: null, errText: e.message || '统计失败' });
      wx.showToast({ title: (e && e.message) || '统计失败', icon: 'none' });
    }
  }
});
