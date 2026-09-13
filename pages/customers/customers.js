// pages/customers/customers.js —— 客户档案列表（搜索/标签筛选 + 累计统计）
const util = require('../../utils/util.js');

Page({
  onLoad(query) {
    this._asPicker = !!(query && query.from === 'picker');
    this.setData({ _asPicker: this._asPicker });
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    _asPicker: false,
    keyword: '',
    list: [],
    skip: 0,
    hasMore: true,
    loading: false
  },

  onShow() {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    this.reload();
    if (this._asPicker) {
      wx.setNavigationBarTitle({ title: '选择客户' });
    }
  },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchMore();
  },

  onUnload() { this._disposed = true; this._listQuery = null; if (this._t) clearTimeout(this._t); },

  reload() {
    this._listQuery = { keyword: this.data.keyword, status: this.data.status, skip: 0, loading: false };
    this.setData({ list: [], skip: 0, hasMore: true });
    return this.fetchMore();
  },

  async fetchMore() {
    const query = this._listQuery;
    if (!query || query.loading || this._disposed) return;
    query.loading = true;
    this.setData({ loading: true });
    try {
      await util.ensureOpenid();
      if (query !== this._listQuery) return;
      const db = util.db();
      const _ = db.command;
      let where = { openid: getApp().globalData.openid };
      if (query.keyword) {
        const reg = db.RegExp({ regexp: util.escReg(query.keyword), options: 'i' });
        where = _.and([where, _.or([{ name: reg }, { phone: reg }, { wechat: reg }])]);
      }
      const rows = await util.listColl('customers', { where: where, orderBy: 'lastOrderAt', order: 'desc', skip: query.skip, limit: 20 });
      if (query !== this._listQuery) return;
      const mapped = rows.map((c) => Object.assign({}, c, {
        totalSpentText: util.fmtMoney(c.totalSpent || 0),
        totalDebtText: util.fmtMoney(c.totalDebt || 0)
      }));
      query.skip += rows.length;
      this.setData({
        list: this.data.list.concat(mapped),
        skip: query.skip,
        hasMore: rows.length === 20,
        loading: false
      });
    } catch (e) {
      if (query !== this._listQuery) return;
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    } finally { query.loading = false; }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => this.reload(), 300);
  },
  clearKeyword() {
    this.setData({ keyword: '' });
    this.reload();
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id || '';
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + id });
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit' });
  },
  // 销售页通过 from=picker 显式启用选择模式。
  goPickForCaller() {
    // 默认就是受 pickCustomer 调用，由 caller 监听 picked 事件
  },
  onTapRow(e) {
    const id = e.currentTarget.dataset.id;
    const c = (this.data.list || []).find((x) => x._id === id);
    if (!c) return;
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (this._asPicker && ch) {
      // picker 模式下回传给 caller；否则交给 goEdit
      try {
        if (ch.emit) {
          ch.emit('picked', c);
          wx.navigateBack();
          return;
        }
      } catch (err) { /* 不报错，给调用方机会兜底 */ }
    }
    // 否则当作普通点击：编辑
    this.goEdit({ currentTarget: { dataset: { id: id } } });
  },
  goDetail(e) {
    if (this._asPicker) {
      this.onTapRow(e);
      return;
    }
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['查看订单流水', '编辑资料', '删除客户'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 跳到订单列表并按客户筛选（order-detail 单个）
          const customer = this.data.list.find((c) => c._id === id) || {};
          wx.navigateTo({ url: '/pages/statement/statement?customerId=' + encodeURIComponent(id) + '&customerName=' + encodeURIComponent(customer.name || '') });
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + id });
        } else if (res.tapIndex === 2) {
          this.confirmDelete(id);
        }
      }
    });
  },
  async confirmDelete(id) {
    if (this._deleting || this._disposed) return;
    const c = (this.data.list || []).find((x) => x._id === id);
    if (!c) return;
    this._deleting = true;
    const hasHistory = async () => (await util.listColl('sales_orders', { where: { customerId: id }, limit: 1 })).length > 0;
    try {
      if ((c.totalSpent || 0) > 0 || (c.totalDebt || 0) > 0 || await hasHistory()) {
        throw new Error('客户有交易/欠款记录，不能删除');
      }
      if (this._disposed) return;
      wx.showModal({
        title: '删除客户', content: '确认删除「' + (c.name || '') + '」？', confirmColor: '#e64340',
        success: async (res) => {
          if (!res.confirm || this._disposed) { this._deleting = false; return; }
          try {
            if (await hasHistory()) throw new Error('客户已有交易记录，不能删除');
            const removed = await util.removeDocById('customers', id);
            if (!removed) throw new Error('客户不存在，请刷新');
            if (this._disposed) return;
            wx.showToast({ title: '已删除', icon: 'success' });
            this.reload();
          } catch (e) { if (!this._disposed) wx.showToast({ title: e.message || '删除失败', icon: 'none' }); }
          finally { this._deleting = false; }
        },
        fail: () => { this._deleting = false; }
      });
    } catch (e) {
      this._deleting = false;
      if (!this._disposed) wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    }
  }
});
