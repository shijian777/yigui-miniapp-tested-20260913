// pages/settings/settings.js —— 设置（settings 集合单文档；首次打开自动建默认文档）
const util = require('../../utils/util.js');

Page({
  onLoad() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    backupBusy: false,
    backupSharing: false,
    backupStale: false,
    lastBackupPath: '',
    lastBackupName: '',
    lastBackupAt: '',
    backupMessage: '',
    backupStats: {},
    backupError: '',
    loadingSettings: true,
    settingsDirty: false,
    saving: false,
    docId: '',
    theme: 'light',
    themeRaw: 'auto',
    form: {
      storeName: '', phone: '', address: '', receiptNote: '',
      defaultPayment: 'cash',
      lowStockThresholdStr: '5',
      showQrPlaceholder: false
    }
  },

  onShow() {
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
    const revision = Number(getApp().globalData.dataRevision) || 0;
    if (!this._settingsLoaded || this._loadedRevision !== revision) this.load(this._loadedRevision !== undefined && this._loadedRevision !== revision);
    this.refreshBackupStats();
  },

  onUnload() {
    this._disposed = true;
    this._loadRequest = (this._loadRequest || 0) + 1;
    this._backupReadRequest = (this._backupReadRequest || 0) + 1;
  },

  updateBackupFreshness() {
    if (!this.data.lastBackupPath) return false;
    try {
      const { createAtomicStorage, COLLECTIONS } = require('../../utils/atomic-storage');
      // 独立只读入口只读取已提交账本，避免读到其他事务尚未提交的 draft。
      const storage = createAtomicStorage({ getStorageSync: key => wx.getStorageSync(key) });
      const data = {};
      COLLECTIONS.forEach(name => { data[name] = storage.getStorageSync('__lcloud_' + name); });
      data.__seq = storage.getStorageSync('__lcloud___seq');
      const stale = this._backupRevision !== (Number(getApp().globalData.dataRevision) || 0)
        || this._backupFingerprint !== JSON.stringify(data);
      this.setData({ backupStale: stale });
      return !stale;
    } catch (e) {
      this.setData({ backupStale: true, backupError: (e && e.message) || '无法核对账本，请保留已有文件' });
      return false;
    }
  },

  async refreshBackupStats() {
    const request = this._backupReadRequest = (this._backupReadRequest || 0) + 1;
    this.updateBackupFreshness();
    try {
      const r = await util.exportAllData();
      if (this._disposed || request !== this._backupReadRequest) return;
      this.setData({ backupStats: r.counts || {}, backupError: '' });
      this.updateBackupFreshness();
    } catch (e) {
      if (this._disposed || request !== this._backupReadRequest) return;
      this.setData({ backupError: (e && e.message) || '读取账本失败，请保留数据' });
    }
  },

  async doExport() {
    if (this._disposed || this.data.backupBusy || this.data.backupSharing || this.data.saving) return;
    this.setData({ backupBusy: true, backupMessage: '' });
    const revision = Number(getApp().globalData.dataRevision) || 0;
    try {
      const backup = await util.exportAllData();
      if (this._disposed) return;
      const suffix = Date.now().toString(36) + '-' + (this._backupSequence = (this._backupSequence || 0) + 1);
      const fileName = util.buildBackupFilename().replace(/\.json$/, '-' + suffix + '.json');
      const filePath = wx.env.USER_DATA_PATH + '/' + fileName;
      const fs = wx.getFileSystemManager();
      await util.wxP(fs.writeFile.bind(fs), { filePath, data: backup.json, encoding: 'utf8' });
      if (this._disposed) return;
      this._backupFingerprint = JSON.stringify(JSON.parse(backup.json).data);
      this._backupRevision = revision;
      this.setData({ lastBackupPath: filePath, lastBackupName: fileName,
        lastBackupAt: util.fmtDateTime(backup.exportedAt),
        backupMessage: '文件已生成，请点击下方保存/分享备份' });
      this.updateBackupFreshness();
    } catch (e) {
      if (this._disposed) return;
      const message = (e && (e.message || e.errMsg)) || '生成失败，请重试';
      this.setData({ backupMessage: '生成未完成，已有备份文件仍保留' });
      wx.showToast({ title: message, icon: 'none' });
    } finally { if (!this._disposed) this.setData({ backupBusy: false }); }
  },

  shareBackup() {
    if (this._disposed || this.data.backupBusy || this.data.backupSharing || this.data.saving) return;
    if (!this.data.lastBackupPath) {
      wx.showToast({ title: '请先生成备份文件', icon: 'none' });
      return;
    }
    if (!this.updateBackupFreshness()) {
      wx.showToast({ title: '账本已变更，请重新生成备份', icon: 'none' });
      return;
    }
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showToast({ title: '当前微信不支持文件分享，请更新后重试', icon: 'none' });
      return;
    }
    this.setData({ backupSharing: true, backupMessage: '' });
    // 必须在这个新 TAP 的同步调用栈中打开分享，不能先 await 生成或读取文件。
    return new Promise(resolve => {
      const finish = message => {
        if (!this._disposed) {
          this.setData({ backupSharing: false, backupMessage: message });
          if (message) wx.showToast({ title: message, icon: 'none' });
        }
        resolve();
      };
      const failed = e => {
        const message = (e && (e.errMsg || e.message)) || 'unknown error';
        console.warn('[settings] shareFileMessage failed:', message);
        if (/开发者工具.*不支持.*API.*调试/i.test(message)) {
          finish('备份已生成，请在手机微信中保存/分享');
          return;
        }
        finish(/cancel/i.test(message) ? '已取消分享，备份文件已保留' : '分享未完成，文件已保留，请重试');
      };
      try {
        wx.shareFileMessage({ filePath: this.data.lastBackupPath, fileName: this.data.lastBackupName,
          success: () => finish(''), fail: failed });
      } catch (e) { failed(e); }
    });
  },

  async confirmImport(json, mode) {
    const parsed = require('../../utils/data-backup').validateBackup(json);
    const count = Object.keys(parsed.data).reduce((sum, key) => sum + (Array.isArray(parsed.data[key]) ? parsed.data[key].length : 0), 0);
    const result = await util.wxP(wx.showModal.bind(wx), {
      title: mode === 'merge' ? '确认合并备份' : '确认覆盖恢复',
      content: '备份包含 ' + count + ' 条记录。' + (mode === 'merge' ? '保留当前数据和设置；相同编号内容不同会停止合并。' : '当前账本将由这份备份替换，未包含的集合将清空。') + '恢复前会自动保存当前账本。换设备的备份将归属当前账号。',
      confirmText: '确认恢复'
    });
    if (!result.confirm) return;
    await util.importAllData(json, mode);
    this.updateBackupFreshness();
    await this.load(true);
    await this.refreshBackupStats();
    wx.showToast({ title: '恢复成功', icon: 'success' });
  },

  async doImport() {
    if (this.data.backupBusy || this.data.backupSharing || this.data.saving) return;
    this.setData({ backupBusy: true });
    try {
      const chosen = await util.wxP(wx.chooseMessageFile.bind(wx), { count: 1, type: 'file', extension: ['json'] });
      if (!chosen.tempFiles || !chosen.tempFiles.length) return;
      const fs = wx.getFileSystemManager();
      const file = await util.wxP(fs.readFile.bind(fs), { filePath: chosen.tempFiles[0].path, encoding: 'utf8' });
      require('../../utils/data-backup').validateBackup(file.data);
      const choice = await util.wxP(wx.showActionSheet.bind(wx), { itemList: ['合并（保留当前数据）', '覆盖（替换整个账本）'] });
      if (choice.tapIndex !== 0 && choice.tapIndex !== 1) return;
      await this.confirmImport(file.data, choice.tapIndex === 0 ? 'merge' : 'overwrite');
    } catch (e) {
      const message = (e && (e.message || e.errMsg)) || '恢复失败，原数据未修改';
      if (!/cancel/.test(message)) wx.showToast({ title: message, icon: 'none' });
    } finally { this.setData({ backupBusy: false }); }
  },

  async undoImport() {
    if (this.data.backupBusy || this.data.backupSharing || this.data.saving) return;
    this.setData({ backupBusy: true });
    try { await this.confirmImport(await util.exportBeforeRestore(), 'overwrite'); }
    catch (e) { wx.showToast({ title: (e && e.message) || '恢复前备份读取失败', icon: 'none' }); }
    finally { this.setData({ backupBusy: false }); }
  },

  setTheme(e) {
    const mode = e.currentTarget.dataset.t;
    getApp().setTheme(mode);
    this.setData({ theme: getApp()._resolveTheme(mode), themeRaw: mode });
  },

  async load(force) {
    const request = this._loadRequest = (this._loadRequest || 0) + 1;
    this.setData({ loadingSettings: true });
    const revision = Number(getApp().globalData.dataRevision) || 0;
    if (force) { this._dirtyFields = {}; this.setData({ settingsDirty: false }); }
    try {
      await util.ensureOpenid();
      const s = await util.fetchSettings(true);
      if (request !== this._loadRequest || revision !== (Number(getApp().globalData.dataRevision) || 0)) return;
      const form = {
          storeName: s.storeName || '',
          phone: s.phone || '',
          address: s.address || '',
          receiptNote: s.receiptNote || '',
          defaultPayment: s.defaultPayment || 'cash',
          lowStockThresholdStr: String(s.lowStockThreshold === undefined || s.lowStockThreshold === null ? 5 : s.lowStockThreshold),
          showQrPlaceholder: !!s.showQrPlaceholder
      };
      Object.keys(this._dirtyFields || {}).forEach((key) => { form[key] = this.data.form[key]; });
      this._settingsLoaded = true;
      this._loadedRevision = revision;
      this.setData({ docId: s._id || '', form });
    } catch (e) {
      if (request === this._loadRequest) wx.showToast({ title: (e && e.message) || '设置加载失败，请重新进入本页', icon: 'none' });
    } finally { if (request === this._loadRequest) this.setData({ loadingSettings: false }); }
  },

  markSettingsDirty(field) {
    this._dirtyFields = this._dirtyFields || {};
    this._dirtyFields[field] = true;
    this._editVersion = (this._editVersion || 0) + 1;
    this.setData({ settingsDirty: true });
  },
  onInput(e) {
    this.markSettingsDirty(e.currentTarget.dataset.f);
    this.setData({ ['form.' + e.currentTarget.dataset.f]: e.detail.value });
  },
  setPayment(e) {
    this.markSettingsDirty('defaultPayment');
    this.setData({ 'form.defaultPayment': e.currentTarget.dataset.p });
  },
  onQrSwitch(e) {
    this.markSettingsDirty('showQrPlaceholder');
    this.setData({ 'form.showQrPlaceholder': e.detail.value });
  },
  goPrinter() {
    wx.navigateTo({ url: '/pages/printer/printer' });
  },

  async save() {
    if (this.data.saving || this.data.backupBusy || this.data.backupSharing) return;
    if (this.data.loadingSettings || !this.data.docId) {
      wx.showToast({ title: '请等待设置加载完成后再保存', icon: 'none' });
      return;
    }
    const f = this.data.form;
    const thresholdText = String(f.lowStockThresholdStr).trim();
    const threshold = Number(thresholdText);
    if (!/^\d+$/.test(thresholdText) || !Number.isSafeInteger(threshold)) {
      wx.showToast({ title: '低库存阈值请输入 0 或正整数', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const editVersion = this._editVersion || 0;
    const payload = {
      storeName: (f.storeName || '').trim(),
      phone: (f.phone || '').trim(),
      address: (f.address || '').trim(),
      receiptNote: (f.receiptNote || '').trim(),
      defaultPayment: f.defaultPayment,
      lowStockThreshold: threshold,
      showQrPlaceholder: f.showQrPlaceholder
    };
    try {
      if (!this.data.docId) {
        // 理论上 load() 已保证存在；双保险：再读一次或新建
        const s = await util.fetchSettings(true);
        this.setData({ docId: s._id });
      }
      const updated = await util.updateDocById('settings', this.data.docId, payload);
      if (updated === 0) throw new Error('设置记录不存在，请重新进入本页');
      this.updateBackupFreshness();
      this._loadRequest = (this._loadRequest || 0) + 1;
      // 刷新全局缓存
      getApp().globalData.settings = null;
      await util.fetchSettings(true);
      if (editVersion === (this._editVersion || 0)) { this._dirtyFields = {}; this.setData({ settingsDirty: false }); }
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  }
});
