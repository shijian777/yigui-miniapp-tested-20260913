// pages/supplier-edit/supplier-edit.js —— 供应商新增/编辑/删除
const util = require('../../utils/util.js');

Page({
  data: {
    id: '',
    loading: false, loadError: '',
    isNew: true,
    saving: false,
    form: { name: '', contact: '', phone: '', remark: '' }
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

    if (query.id) {
      this.setData({ id: query.id, isNew: false });
      this.loadDoc(query.id);
    }
  },

  async loadDoc(id) {
    this.setData({ loading: true, loadError: '' });
    try {
      await util.ensureOpenid();
      const doc = await util.getDocById('suppliers', id);
      if (this._disposed) return;
      if (!doc) throw new Error('供应商不存在');
      this.setData({ loading: false, loadError: '', form: { name: doc.name || '', contact: doc.contact || '', phone: doc.phone || '', remark: doc.remark || '' } });
    } catch (e) {
      if (this._disposed) return;
      this.setData({ loading: false, loadError: (e && e.message) || '加载失败' });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.f]: e.detail.value });
  },

  doSave() {
    if (this._disposed || this._saved || this._deleting || this.data.saving || this.data.loading || this.data.loadError) return;
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写供应商名称', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = {
      name: name,
      contact: (f.contact || '').trim(),
      phone: (f.phone || '').trim(),
      remark: (f.remark || '').trim()
    };
    const done = () => {
      this._saved = true;
      if (this._disposed) return;
      wx.showToast({ title: '已保存', icon: 'success' });
      this._backTimer = setTimeout(() => { if (!this._disposed) wx.navigateBack(); }, 500);
    };
    (this.data.isNew ? util.addDoc('suppliers', payload) : util.updateDocById('suppliers', this.data.id, payload))
      .then(done)
      .catch((e) => {
        this.setData({ saving: false });
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      });
  },

  async doDelete() {
    if (this._disposed || this._saved || this._deleting || this.data.saving || this.data.loading || this.data.loadError || this.data.isNew) return;
    this._deleting = true;
    const id = this.data.id;
    const hasHistory = async () => (await util.listColl('purchase_orders', { where: { supplierId: id }, limit: 1 })).length > 0;
    try {
      if (await hasHistory()) throw new Error('供应商有历史进货单，不能删除');
      if (this._disposed) return;
      wx.showModal({
        title: '删除供应商', content: '确定删除「' + this.data.form.name + '」？', confirmColor: '#e64340',
        success: async (res) => {
          if (!res.confirm || this._disposed) { this._deleting = false; return; }
          this.setData({ saving: true });
          try {
            if (await hasHistory()) throw new Error('供应商已有进货记录，不能删除');
            const removed = await util.removeDocById('suppliers', id);
            if (!removed) throw new Error('供应商不存在，请刷新');
            this._saved = true;
            if (this._disposed) return;
            wx.showToast({ title: '已删除', icon: 'success' });
            this._backTimer = setTimeout(() => { if (!this._disposed) wx.navigateBack(); }, 500);
          } catch (e) {
            if (!this._disposed) { this.setData({ saving: false }); wx.showToast({ title: e.message || '删除失败', icon: 'none' }); }
          } finally { this._deleting = false; }
        },
        fail: () => { this._deleting = false; }
      });
    } catch (e) {
      this._deleting = false;
      if (!this._disposed) wx.showToast({ title: e.message || '删除失败', icon: 'none' });
    }
  }
});
