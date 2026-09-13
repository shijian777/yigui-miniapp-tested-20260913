// pages/orders/orders.js —— 订单流水
// 销售单/进货单统一按日期查询；"全部"时两边各自翻页、按时间归并取当前页，
// 避免把两个集合全量拉到本地。
const util = require('../../utils/util.js');

const PAGE_SIZE = 20;

Page({
  data: {
    typeFilter: 'all',   // all | sale | purchase
    quick: 'today',      // today | yesterday | week | month
    startDate: '',
    endDate: '',
    list: [],
    loading: false,
    hasMore: true,
    errText: ''
  },

  onLoad() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const today = util.todayStr();
    this.setData({ startDate: today, endDate: today });
  },
  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
    this.reload();
  },
  onUnload() { this._query = null; },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (!this.data.loading && this.data.hasMore) this.loadNext();
  },

  setType(e) {
    this.setData({ typeFilter: e.currentTarget.dataset.t });
    this.reload();
  },
  setQuick(e) {
    const q = e.currentTarget.dataset.q;
    const today = util.todayStr();
    let start = today;
    if (q === 'yesterday') start = util.addDays(today, -1);
    else if (q === 'week') start = util.addDays(today, -6);
    else if (q === 'month') start = util.addDays(today, -29);
    this.setData({ quick: q, startDate: start, endDate: q === 'yesterday' ? start : today });
    this.reload();
  },
  onStartChange(e) {
    this.setData({ startDate: e.detail.value, quick: '' });
  },
  onEndChange(e) {
    this.setData({ endDate: e.detail.value, quick: '' });
  },
  doQuery() { this.reload(); },

  /* ---------- 查询 ---------- */
  async reload() {
    // Each filter query owns its cursors; an older request cannot overwrite it.
    const query = {
      type: this.data.typeFilter, startDate: this.data.startDate, endDate: this.data.endDate,
      saleDone: false, saleSkip: 0, saleBuf: [],
      purchaseDone: false, purchaseSkip: 0, purchaseBuf: [], loading: false
    };
    this._query = query;
    this.setData({ list: [], loading: true, hasMore: true, errText: '' });
    try {
      await util.ensureOpenid();
      if (this._query !== query) return;
      await this.loadNext(true, query);
      if (this._query !== query) return;
      this.setData({ loading: false });
    } catch (e) {
      if (this._query !== query) return;
      this.setData({ loading: false, hasMore: false, errText: (e && e.message) || '查询失败' });
      wx.showToast({ title: (e && e.message) || '查询失败', icon: 'none' });
    }
  },

  async loadNext(reset, query) {
    query = query || this._query;
    if (!query || query.loading || query !== this._query) return;
    query.loading = true;
    this.setData({ loading: true });
    try {
      const { startMs, endMs } = util.rangeMs(query.startDate, query.endDate);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('开始日期不能晚于结束日期，请重新选择');
      const _ = util.cmd();
      const range = { createdAt: _.gte(new Date(startMs)).and(_.lt(new Date(endMs))) };
      const type = query.type;
      const out = [];
      const pages = [];

      if (type === 'sale' || type === 'all') pages.push('sale');
      if (type === 'purchase' || type === 'all') pages.push('purchase');

      for (let k = 0; k < pages.length; k++) {
        const kind = pages[k];
        let doneKey = kind + 'Done', skipKey = kind + 'Skip', bufKey = kind + 'Buf';
        // 先给该端补一批数据（直到满一页或到底）
        while (query[bufKey].length < PAGE_SIZE && !query[doneKey]) {
          const coll = kind === 'sale' ? 'sales_orders' : 'purchase_orders';
          const rows = await util.listColl(coll, { where: range, orderBy: 'createdAt', skip: query[skipKey], limit: PAGE_SIZE });
          if (this._query !== query) return;
          query[skipKey] += rows.length;
          if (rows.length < PAGE_SIZE) query[doneKey] = true;
          query[bufKey] = query[bufKey].concat(rows);
        }
      }
      // 归并取头
      while (out.length < PAGE_SIZE) {
        let best = null, bestKind = null;
        for (let k = 0; k < pages.length; k++) {
          const kind = pages[k];
          const buf = query[kind + 'Buf'];
          if (!buf.length) continue;
          const head = buf[0];
          const t = head.createdAt instanceof Date ? head.createdAt.getTime() : new Date(head.createdAt).getTime();
          if (!best || t > best.t) { best = { t: t, row: head }; bestKind = kind; }
        }
        if (!best) break;
        query[bestKind + 'Buf'].shift();
        out.push(best.row);
      }
      // 是否还能继续加载
      let hasMore = false;
      for (let k = 0; k < pages.length; k++) {
        const kind = pages[k];
        if (!query[kind + 'Done'] || query[kind + 'Buf'].length) hasMore = true;
      }

      const mapped = (reset ? [] : this.data.list).concat(out.map((o) => this.toRow(o)));
      this.setData({ list: mapped, loading: false, hasMore: hasMore });
    } catch (e) {
      if (this._query !== query) return;
      this.setData({ loading: false, hasMore: false, errText: (e && e.message) || '查询失败' });
      wx.showToast({ title: (e && e.message) || '查询失败', icon: 'none' });
    } finally {
      query.loading = false;
    }
  },

  toRow(o) {
    // 明细摘要：把单内商品拼成「名称×数量」串，列表直接可见
    const itemsText = (Array.isArray(o.lines) ? o.lines : [])
      .map((l) => (l.name || '(商品)') + '×' + l.qty)
      .join('，');
    const type = o.type;
    if (type === 'sale') {
      return {
        rowKey: 'sale_' + o._id,
        _id: o._id,
        type: 'sale',
        typeText: '销售',
        orderNo: o.orderNo || '',
        amountText: util.fmtMoney(o.amountDue),
        mainText: o.status === 'returned'
          ? '原支付：' + util.paymentText(o.paymentMethod) + (o.debt > 0 ? ' · 退货前欠款 ¥' + util.fmtMoney(o.debt) + '（已取消）' : '')
          : util.paymentText(o.paymentMethod) + (o.debt > 0 ? ' · 欠 ¥' + util.fmtMoney(o.debt) : ''),
        itemsText: itemsText,
        returned: o.status === 'returned',
        timeText: util.fmtDateTime(o.createdAt)
      };
    }
    return {
      rowKey: 'purchase_' + o._id,
      _id: o._id,
      type: 'purchase',
      typeText: '进货',
      orderNo: o.orderNo || '',
      amountText: util.fmtMoney(o.totalAmount),
      mainText: (o.supplierName || '散货') + ' · ' + (o.lines ? o.lines.length : 0) + ' 项',
      itemsText: itemsText,
      returned: false,
      timeText: util.fmtDateTime(o.createdAt)
    };
  },

  goDetail(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + d.id + '&type=' + d.type });
  }
});
