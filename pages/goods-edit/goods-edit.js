// pages/goods-edit/goods-edit.js —— 商品新增/编辑/删除（含色码管理）
// 数据模型（Phase 2）：
//  - 颜色 colors[] / 尺码 sizes[]：定义该款规格
//  - skus[]：每条 = colors[i] × sizes[j]，含独立库存/成本/售价
//  - stock = Σ skus.stock（派生缓存）
//  - 兼容旧数据：无 skus 的视为单个默认 SKU
const util = require('../../utils/util.js');

Page({
  data: {
    id: '',
    loading: false, loadError: '',
    isNew: true,
    saving: false,
    form: {
      name: '', barcode: '', category: '', unit: '件',
      status: 'on',
      costPriceStr: '', priceStr: '',
      colors: [],   // ['黑','蓝','灰']
      sizes: [],    // ['S','M','L']
      colorInput: '',
      sizeInput: '',
      skus: [],     // [{key,color,size,stock,costPrice,price}]
      initialSkus: [] // 仅新建时使用
    },
    totalStock: 0,
    nonEmptySkuCount: 0
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
      const g = await util.getDocById('goods', id);
      if (this._disposed) return;
      if (!g) throw new Error('商品不存在');
      const colors = Array.isArray(g.colors) ? g.colors : [];
      const sizes = Array.isArray(g.sizes) ? g.sizes : [];
      let skus = Array.isArray(g.skus) ? g.skus : [];
      this._expectedOriginalSkus = skus.map((s) => Object.assign({}, s));
      this._expectedOriginalStock = Number(g.stock) || 0;
      // 兼容旧数据：迁移默认 SKU
      if (skus.length === 0) {
        skus = util.buildSkus(colors, sizes, { costPrice: g.costPrice, price: g.price });
        if (Number(g.stock) > 0) skus = util.upsertSku(skus, '', '', { stock: Number(g.stock) });
      }
      // Keep the loaded inventory independent from the editable form.
      this._originalSkus = skus.map((s) => Object.assign({}, s));
      this.setData({
        loading: false, loadError: '',
        form: {
          name: g.name || '', barcode: g.barcode || '', category: g.category || '',
          unit: g.unit || '件',
          status: g.status === 'off' ? 'off' : 'on',
          costPriceStr: g.costPrice === undefined ? '' : String(g.costPrice),
          priceStr: g.price === undefined ? '' : String(g.price),
          colors: colors.slice(),
          sizes: sizes.slice(),
          colorInput: '',
          sizeInput: '',
          skus: skus.map((s) => Object.assign({}, s))
        }
      });
      this.refreshDerived();
    } catch (e) {
      if (this._disposed) return;
      this.setData({ loading: false, loadError: (e && e.message) || '加载失败' });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  onInput(e) {
    const f = e.currentTarget.dataset.f;
    this.setData({ ['form.' + f]: e.detail.value });
  },
  setStatus(e) { this.setData({ 'form.status': e.currentTarget.dataset.s }); },

  // 编辑态：跳进货页并自动带上本商品（改库存只能通过进货/销售）
  goPurchase() {
    wx.redirectTo({ url: '/pages/purchase/purchase?goodsId=' + encodeURIComponent(this.data.id) });
  },

  // ========== 扫码录入条码 ==========
  scanBarcode() {
    // 仅在扫码场景：未授权用户拒绝时静默；用户取消不报错
    wx.scanCode({
      onlyFromCamera: false,        // 允许相机 + 相册（相册里的条码图也能识别）
      scanType: ['barCode', 'qrCode'],
      success: (res) => {
        const code = (res && res.result) ? String(res.result).trim() : '';
        if (!code) { wx.showToast({ title: '未识别到条码', icon: 'none' }); return; }
        // 兼容 EAN-13/EAN-8/Code128/QR 等
        this.setData({ 'form.barcode': code });
        wx.showToast({ title: '已填入条码', icon: 'success', duration: 1200 });
        // 轻微震动反馈（仅在支持的设备上；iOS 不识别 type 参数，避免报警告）
        try { wx.vibrateShort && wx.vibrateShort({}); } catch (e) {}
      },
      fail: (err) => {
        // 用户主动取消（errMsg 含 "cancel"）不提示
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) return;
        wx.showToast({ title: '扫码失败，请重试', icon: 'none' });
      }
    });
  },

  // ========== 颜色 / 尺码管理 ==========
  rebuildSkus(colors, sizes) {
    const f = this.data.form;
    const skus = util.buildSkus(colors, sizes, { costPrice: f.costPriceStr, price: f.priceStr }).map((s) => {
      // Older documents may use a different key delimiter; retain their stable key.
      const existing = f.skus.find((x) => x.key === s.key && x.color === s.color && x.size === s.size)
        || f.skus.find((x) => (x.color || '') === s.color && (x.size || '') === s.size);
      return existing ? Object.assign({}, existing) : s;
    });
    const inventory = f.skus.concat(this._originalSkus || []);
    if (inventory.some((s) => Number(s.stock) > 0 && !skus.some((x) => x.key === s.key))) {
      wx.showToast({ title: '有库存的规格不能移除，请先通过进货/销售处理库存', icon: 'none' });
      return null;
    }
    return skus;
  },
  onTagInput(e) { this.setData({ ['form.' + e.currentTarget.dataset.f]: e.detail.value }); },
  addColor() {
    const v = (this.data.form.colorInput || '').trim();
    if (!v) return;
    const colors = this.data.form.colors.slice();
    if (colors.indexOf(v) >= 0) { wx.showToast({ title: '已有该颜色', icon: 'none' }); return; }
    colors.push(v);
    const skus = this.rebuildSkus(colors, this.data.form.sizes);
    if (!skus) return;
    this.setData({ 'form.colors': colors, 'form.colorInput': '', 'form.skus': skus });
    this.refreshDerived();
  },
  addSize() {
    const v = (this.data.form.sizeInput || '').trim();
    if (!v) return;
    const sizes = this.data.form.sizes.slice();
    if (sizes.indexOf(v) >= 0) { wx.showToast({ title: '已有该尺码', icon: 'none' }); return; }
    sizes.push(v);
    const skus = this.rebuildSkus(this.data.form.colors, sizes);
    if (!skus) return;
    this.setData({ 'form.sizes': sizes, 'form.sizeInput': '', 'form.skus': skus });
    this.refreshDerived();
  },
  removeColor(e) {
    const idx = e.currentTarget.dataset.idx;
    const colors = this.data.form.colors.slice();
    colors.splice(idx, 1);
    const skus = this.rebuildSkus(colors, this.data.form.sizes);
    if (!skus) return;
    this.setData({ 'form.colors': colors, 'form.skus': skus });
    this.refreshDerived();
  },
  removeSize(e) {
    const idx = e.currentTarget.dataset.idx;
    const sizes = this.data.form.sizes.slice();
    sizes.splice(idx, 1);
    const skus = this.rebuildSkus(this.data.form.colors, sizes);
    if (!skus) return;
    this.setData({ 'form.sizes': sizes, 'form.skus': skus });
    this.refreshDerived();
  },

  // ========== SKU 矩阵 ==========
  onSkuInput(e) {
    const { key, f } = e.currentTarget.dataset;
    if (f === 'stock' && !this.data.isNew) return;
    const skus = this.data.form.skus.map((s) => s.key === key ? Object.assign({}, s, { [f]: e.detail.value }) : s);
    this.setData({ 'form.skus': skus });
  },
  onSkuBlur(e) {
    // blur 时把字符串转数字并刷派生
    const { key, f } = e.currentTarget.dataset;
    if (f === 'stock' && !this.data.isNew) return;
    const skus = this.data.form.skus.map((s) => {
      if (s.key !== key) return s;
      if (f === 'stock') return Object.assign({}, s, { stock: Math.max(0, Math.floor(util.toNum(s.stock, 0))) });
      if (f === 'costPrice' || f === 'price') {
        const value = Number(s[f]);
        if (!Number.isFinite(value) || value < 0) return s;
        return Object.assign({}, s, { [f]: util.round2(value) });
      }
      return s;
    });
    this.setData({ 'form.skus': skus });
    this.refreshDerived();
  },
  // 批量填充：把默认价格/成本应用到所有 SKU
  applyDefaultPrice() {
    const cp = util.toNum(this.data.form.costPriceStr, 0);
    const pr = util.toNum(this.data.form.priceStr, 0);
    const skus = this.data.form.skus.map((s) => Object.assign({}, s, { costPrice: util.round2(cp), price: util.round2(pr) }));
    this.setData({ 'form.skus': skus });
    wx.showToast({ title: '已应用到全部 SKU', icon: 'success' });
  },

  refreshDerived() {
    const skus = this.data.form.skus;
    this.setData({
      totalStock: util.skuTotalStock(skus),
      nonEmptySkuCount: util.skuNonEmptyCount(skus)
    });
  },

  // ========== 保存 ==========
  async doSave() {
    if (this._disposed || this._saved || this._confirming || this.data.saving || this.data.loading || this.data.loadError) return;
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) { wx.showToast({ title: '请填写商品名称', icon: 'none' }); return; }
    // 至少要有颜色或尺码之一（按选项 A：全 SKU 都要选）
    if (f.colors.length === 0 && f.sizes.length === 0) {
      this._confirming = true;
      wx.showModal({
        title: '提示',
        content: '没设置颜色和尺码，将创建 1 个默认 SKU。继续吗？',
        confirmText: '继续',
        success: (res) => {
          this._confirming = false;
          if (res.confirm && !this._disposed) this.doSaveAfterCheck(f);
        },
        fail: () => { this._confirming = false; }
      });
      return;
    }
    this.doSaveAfterCheck(f);
  },

  async doSaveAfterCheck(f) {
    if (this._disposed || this._saved || this.data.saving || this.data.loading || this.data.loadError) return;
    const name = (f.name || '').trim();
    this.setData({ saving: true });
    try {
      const costPrice = Number(f.costPriceStr);
      const price = Number(f.priceStr);
      if (!Number.isFinite(price) || !Number.isFinite(costPrice) || price < 0 || costPrice < 0) {
        throw new Error('请填写有效的非负价格');
      }

      // 兜底：没有 SKU 就建 1 个默认
      let skus = f.skus.slice();
      if (skus.length === 0) skus = util.buildSkus(f.colors, f.sizes, { costPrice: costPrice, price: price });

      const keys = new Set();
      for (const s of skus) {
        const stock = Number(s.stock), cp = Number(s.costPrice), pr = Number(s.price);
        if (!s.key || keys.has(s.key) || !Number.isSafeInteger(stock) || stock < 0
          || !Number.isFinite(cp) || cp < 0 || !Number.isFinite(pr) || pr < 0) {
          throw new Error('规格、库存或价格无效，请检查后保存');
        }
        keys.add(s.key);
      }

      // 校验：编辑态下不允许通过本页改库存
      if (!this.data.isNew) {
        const original = this._originalSkus;
        if (!original) throw new Error('商品尚未加载完成，请重新打开');
        if (original.some((s) => Number(s.stock) > 0 && !skus.some((x) => x.key === s.key))) {
          throw new Error('有库存的规格不能移除');
        }
        for (let i = 0; i < skus.length; i++) {
          const ov = original.find((x) => x.key === skus[i].key);
          if ((ov && (Number(skus[i].stock) !== Number(ov.stock)
            || (skus[i].color || '') !== (ov.color || '') || (skus[i].size || '') !== (ov.size || '')))
            || (!ov && Number(skus[i].stock) !== 0)) {
            wx.showToast({ title: '编辑态不能改库存，请走进货/销售', icon: 'none' });
            this.setData({ saving: false });
            return;
          }
        }
      }

      const payload = {
        name: name,
        barcode: (f.barcode || '').trim(),
        category: (f.category || '').trim(),
        unit: (f.unit || '件').trim(),
        status: f.status,
        colors: f.colors,
        sizes: f.sizes,
        skus: skus.map((s) => ({
          key: s.key,
          color: s.color || '',
          size: s.size || '',
          stock: Math.floor(Number(s.stock) || 0),
          costPrice: util.round2(Number(s.costPrice) || 0),
          price: util.round2(Number(s.price) || 0)
        })),
        stock: util.skuTotalStock(skus),  // 派生缓存
        totalStock: util.skuTotalStock(skus),  // 与 stock 保持同步（部分页面读 totalStock）
        skuCount: util.skuNonEmptyCount(skus)
      };
      // 兼容性：保留旧字段（成本/售价取 SKU 平均作为兜底）
      payload.costPrice = util.round2(costPrice);
      payload.price = util.round2(price);

      const wasNew = this.data.isNew;
      const result = await util.callFn('saveGoods', {
        goodsId: wasNew ? '' : this.data.id,
        goods: payload,
        expectedOriginalSkus: this._expectedOriginalSkus,
        expectedOriginalStock: this._expectedOriginalStock
      });
      this._originalSkus = payload.skus.map((s) => Object.assign({}, s));
      this._expectedOriginalSkus = payload.skus.map((s) => Object.assign({}, s));
      this._expectedOriginalStock = payload.stock;
      this._saved = true;
      if (this._disposed) return;
      this.setData({ id: result.goodsId, isNew: false });
      wx.showToast({ title: wasNew ? '已新增' : '已保存', icon: 'success' });
      this._backTimer = setTimeout(() => { if (!this._disposed) wx.navigateBack(); }, 600);
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    }
  },

  // 保留商品和规格，历史销售单退货仍可准确回补库存。
  doDelete() {
    if (this._disposed || this._saved || this._confirming || this.data.saving || this.data.loading || this.data.loadError || this.data.isNew) return;
    this._confirming = true;
    wx.showModal({
      title: '停售商品', content: '停售「' + this.data.form.name + '」？商品、库存和历史退货记录会保留，可在商品管理重新上架。',
      success: async (res) => {
        this._confirming = false;
        if (!res.confirm || this._disposed || this.data.saving) return;
        this.setData({ saving: true });
        try {
          const changed = await util.updateDocById('goods', this.data.id, { status: 'off' });
          if (!changed) throw new Error('商品不存在，请刷新');
          this._saved = true;
          if (this._disposed) return;
          wx.showToast({ title: '已停售', icon: 'success' });
          this._backTimer = setTimeout(() => { if (!this._disposed) wx.navigateBack(); }, 600);
        } catch (e) {
          if (!this._disposed) { this.setData({ saving: false }); wx.showToast({ title: e.message || '停售失败', icon: 'none' }); }
        }
      },
      fail: () => { this._confirming = false; }
    });
  }
});
