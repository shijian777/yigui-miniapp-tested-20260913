// pages/slow-mover/slow-mover.js —— 滞销分析
const util = require('../../utils/util.js');

Page({
  data: {
    threshold: 90,
    summary: { count: 0, totalStockQty: 0, totalStockValue: '0.00', threshold: 90 },
    list: [],
    loading: true
  },

  onLoad() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.reload();
  },
  onUnload() { this._requestSeq = (this._requestSeq || 0) + 1; },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  setThreshold(e) {
    const v = Number(e.currentTarget.dataset.d);
    if (v === this.data.threshold) return;
    this.setData({ threshold: v });
    this.reload();
  },

  async reload() {
    const seq = this._requestSeq = (this._requestSeq || 0) + 1;
    this.setData({ loading: true, list: [], errText: '' });
    try {
      const r = await util.callFn('slowMover', { thresholdDays: this.data.threshold, limit: 200 });
      if (seq !== this._requestSeq) return;
      const d = (r && r.data) || {};
      const list = (d.list || []).map((it) => Object.assign({}, it, {
        rowKey: JSON.stringify([it.goodsId, it.skuKey || '', it.color || '', it.size || '']),
        stockValueText: util.fmtMoney(it.stockValue),
        priceText: util.fmtMoney(it.price),
        costText: util.fmtMoney(it.costPrice),
        lastText: it.isNeverSold ? '无有效销售（退货不计）' : (it.daysSince + ' 天前')
      }));
      this.setData({
        summary: {
          count: d.count || 0,
          totalStockQty: d.totalStockQty || 0,
          totalStockValue: util.fmtMoney(d.totalStockValue),
          threshold: this.data.threshold
        },
        list: list,
        loading: false
      });
    } catch (e) {
      if (seq !== this._requestSeq) return;
      this.setData({ loading: false, summary: {}, errText: e.message || '查询失败' });
      wx.showToast({ title: e.message || '查询失败', icon: 'none' });
    }
  },

  goRestock(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/purchase/purchase?goodsId=' + encodeURIComponent(id) });
  },

  goGoodEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/goods-edit/goods-edit?id=' + id });
  }
});
