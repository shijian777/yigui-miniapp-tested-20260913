// pages/customer-edit/customer-edit.js —— 客户档案编辑
const util = require('../../utils/util.js');

const SUGGEST_TAGS = ['VIP', '回头客', '散户', '批发', '欠款'];

Page({
  data: {
    id: '',
    loading: false, loadError: '',
    isEdit: false,
    saving: false,
    form: {
      name: '',
      phone: '',
      wechat: '',
      address: '',
      tags: [],
      note: ''
    },
    tagInput: '',
    suggestTags: SUGGEST_TAGS
  },

  onUnload() {
    this._disposed = true;
    if (this._backTimer) clearTimeout(this._backTimer);
  },

  onLoad(query) {
    query = query || {};
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    const id = (query && query.id) || '';
    if (id) {
      this.setData({ id: id, isEdit: true });
      wx.setNavigationBarTitle({ title: '编辑客户' });
      this.load(id);
    }
  },

  async load(id) {
    this.setData({ loading: true, loadError: '' });
    try {
      await util.ensureOpenid();
      const c = await util.getDocById('customers', id);
      if (this._disposed) return;
      if (!c) throw new Error('客户不存在');
      this.setData({
        loading: false, loadError: '',
        form: {
          name: c.name || '',
          phone: c.phone || '',
          wechat: c.wechat || '',
          address: c.address || '',
          tags: Array.isArray(c.tags) ? c.tags : [],
          note: c.note || ''
        }
      });
    } catch (e) {
      if (this._disposed) return;
      this.setData({ loading: false, loadError: (e && e.message) || '加载失败' });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  /* ---- 表单 ---- */
  onName(e)    { this.setData({ 'form.name': e.detail.value }); },
  onPhone(e)   { this.setData({ 'form.phone': e.detail.value }); },
  onWechat(e)  { this.setData({ 'form.wechat': e.detail.value }); },
  onAddress(e) { this.setData({ 'form.address': e.detail.value }); },
  onNote(e)    { this.setData({ 'form.note': e.detail.value }); },

  toggleTag(e) {
    const t = e.currentTarget.dataset.tag;
    const tags = this.data.form.tags.slice();
    const idx = tags.indexOf(t);
    if (idx >= 0) tags.splice(idx, 1);
    else tags.push(t);
    this.setData({ 'form.tags': tags });
  },

  onTagInput(e) {
    this.setData({ tagInput: e.detail.value });
  },
  addCustomTag() {
    const t = (this.data.tagInput || '').trim();
    if (!t) return;
    const tags = this.data.form.tags.slice();
    if (tags.indexOf(t) < 0) tags.push(t);
    this.setData({ 'form.tags': tags, tagInput: '' });
  },
  removeTag(e) {
    const i = e.currentTarget.dataset.index;
    const tags = this.data.form.tags.slice();
    tags.splice(i, 1);
    this.setData({ 'form.tags': tags });
  },

  /* ---- 保存 ---- */
  async save() {
    if (this._disposed || this._saved || this.data.saving || this.data.loading || this.data.loadError) return;
    const f = this.data.form;
    if (!f.name || !f.name.trim()) {
      wx.showToast({ title: '请输入客户姓名', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await util.ensureOpenid();
      if (this._disposed) return;
      const payload = {
        name: f.name.trim().slice(0, 50),
        phone: (f.phone || '').trim().slice(0, 20),
        wechat: (f.wechat || '').trim().slice(0, 50),
        address: (f.address || '').trim().slice(0, 200),
        tags: f.tags.slice(0, 10),
        note: (f.note || '').trim().slice(0, 500)
      };
      if (this.data.id) {
        await util.updateDocById('customers', this.data.id, payload);
      } else {
        await util.addDoc('customers', payload);
      }
      this._saved = true;
      if (this._disposed) return;
      wx.showToast({ title: '已保存', icon: 'success' });
      this._backTimer = setTimeout(() => { if (!this._disposed) wx.navigateBack(); }, 600);
    } catch (e) {
      if (this._disposed) return;
      this.setData({ saving: false });
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  }
});
