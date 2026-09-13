// pages/purchase/purchase.js —— 进货入库（按 SKU 维度建行）
// 选供应商 -> 选商品（打开 sku-picker，每选一个 SKU 一行） -> 提交 submitPurchase 云函数
// 新结构：lines 每行是一个 SKU（goodsId+skuKey 唯一）；同一商品多次进货按多行显示
const util = require('../../utils/util.js');

function lineId(it) {
  return String(it.goodsId) + '|' + String(it.skuKey || '');
}

Page({
  onLoad(options) {
    this._ledgerRevision = Number(getApp().globalData.dataRevision) || 0;
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
    // 支持从商品编辑页带商品 ID 跳入：自动加一行该商品（多色码则弹 SKU 选择）
    if (options && options.goodsId) this._preloadGoods(decodeURIComponent(options.goodsId));
  },

  async _preloadGoods(goodsId) {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    try {
      await util.ensureOpenid();
      const g = await util.getDocById('goods', goodsId);
      if (!g || !this.isLedgerCurrent(revision) || this.data.submitting) return;
      const hasColors = Array.isArray(g.colors) && g.colors.length;
      const hasSizes = Array.isArray(g.sizes) && g.sizes.length;
      if (hasColors || hasSizes || (Array.isArray(g.skus) && g.skus.length)) {
        // 多色码：打开 SKU 选择器让用户挑要入库的色码
        const goodsJson = encodeURIComponent(JSON.stringify(g));
        wx.navigateTo({
          url: '/pages/sku-picker/sku-picker?goodsJson=' + goodsJson + '&mode=purchase',
          events: { pickSku: (it) => { if (it && this.isLedgerCurrent(revision)) this.mergeLine(it); } }
        });
      } else {
        // 无色码：直接入一行，进价取默认成本价
        let cost = Number(g.costPrice) || 0;
        if (Array.isArray(g.skus) && g.skus.length) {
          cost = Number(g.skus[0].costPrice) || cost;
        }
        this.mergeLine({
          goodsId: g._id, name: g.name, unit: g.unit || '件',
          skuKey: '', color: '', size: '', qty: 1, unitCost: cost
        });
      }
    } catch (e) { /* 预选失败静默，用户可手动添加 */ }
  },
  data: {
    showSupplier: false,
    suppliers: [],
    supplierId: '',
    supplierName: '',
    lines: [],
    remark: '',
    totalQty: 0,
    totalAmountText: '0.00',
    submitting: false
  },

  onUnload() {
    this._unloaded = true;
    clearTimeout(this._pickerTimer);
  },

  isLedgerCurrent(revision) {
    return !this._unloaded && revision === (Number(getApp().globalData.dataRevision) || 0);
  },

  ensureLedgerCurrent() {
    const revision = Number(getApp().globalData.dataRevision) || 0;
    if (this._ledgerRevision === undefined) this._ledgerRevision = revision;
    if (this._ledgerRevision === revision) return true;
    this._ledgerRevision = revision;
    this._operationRequests = {};
    clearTimeout(this._pickerTimer);
    this.setData({ submitting: false, supplierId: '', supplierName: '', suppliers: [] });
    this.reset();
    wx.showToast({ title: '账本已恢复，请重新选商品', icon: 'none' });
    return false;
  },

  onShow() {
    this.ensureLedgerCurrent();
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    util.ensureOpenid().catch(() => {});
    this.loadSuppliers();
  },

  async loadSuppliers() {
    const revision = Number(getApp().globalData.dataRevision) || 0;
    try {
      await util.ensureOpenid();
      const list = await util.listCollAll('suppliers', { orderBy: 'createdAt', order: 'desc' });
      if (this.isLedgerCurrent(revision)) this.setData({ suppliers: list });
    } catch (e) { /* 供应商加载失败不阻塞进货 */ }
  },

  /* ---------- 供应商 ---------- */
  toggleSupplierPanel() {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ showSupplier: !this.data.showSupplier });
  },
  chooseSupplier(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({
      supplierId: e.currentTarget.dataset.id || '',
      supplierName: e.currentTarget.dataset.name || '',
      showSupplier: false
    });
  },

  /* ---------- 商品选择 → 色码选择 ---------- */
  addGoods() {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded) return;
    const self = this;
    // 先选商品（用 goods-picker），回传后打开 sku-picker
    wx.navigateTo({
      url: '/pages/goods-picker/goods-picker',
      events: {
        pick: (g) => {
          if (!g || !g.goodsId || !self.isLedgerCurrent(revision) || self.data.submitting) return;
          const hasSkus = Array.isArray(g.skus) && g.skus.length;
          const hasColors = Array.isArray(g.colors) && g.colors.length;
          if (hasSkus || hasColors) {
            const goodsJson = encodeURIComponent(JSON.stringify(g));
            // 关键：goods-picker 正在 navigateBack 返回动画中，立刻 navigateTo 会失败
            //（页面栈退场时跳转被微信吞掉），必须等返回动画结束再打开 SKU 选择器
            clearTimeout(self._pickerTimer);
            self._pickerTimer = setTimeout(() => {
              if (!self.isLedgerCurrent(revision) || self.data.submitting) return;
              wx.navigateTo({
                url: '/pages/sku-picker/sku-picker?goodsJson=' + goodsJson + '&mode=purchase',
                events: {
                  pickSku: (it) => {
                    if (!it || !self.isLedgerCurrent(revision)) return;
                    self.mergeLine(it);
                  }
                }
              });
            }, 350);
          } else {
            // 兼容旧商品（无 SKU）：按 goodsId 入一行
            self.mergeLine({
              goodsId: g.goodsId,
              name: g.name,
              unit: g.unit || '件',
              skuKey: '',
              color: '',
              size: '',
              qty: 1,
              unitCost: Number(g.costPrice) || 0
            });
          }
        }
      }
    });
  },
  // 合并：同 goodsId+skuKey 数量累加
  mergeLine(it) {
    if (this.data.submitting || this._unloaded) return;
    if (!it || !it.goodsId) {
      wx.showToast({ title: '商品数据异常，请重新选择', icon: 'none' });
      return;
    }
    const id = lineId(it);
    const lines = this.data.lines.slice();
    const idx = lines.findIndex((l) => lineId(l) === id);
    if (idx >= 0) {
      lines[idx].qty = Number(lines[idx].qty) + (Number(it.qty) || 1);
      // 进价用最新一次的（采购员可手动改）
      if (it.unitCost !== undefined) {
        lines[idx].unitCost = Number(it.unitCost) || 0;
        lines[idx].unitCostStr = String(lines[idx].unitCost);
      }
      this.setData({ lines: lines });
    } else {
      lines.push({
        goodsId: it.goodsId,
        name: it.name,
        unit: it.unit || '件',
        skuKey: it.skuKey || '',
        color: it.color || '',
        size: it.size || '',
        qty: Number(it.qty) || 1,
        unitCost: Number(it.unitCost) || 0,
        unitCostStr: String(Number(it.unitCost) || 0)
      });
      this.setData({ lines: lines });
    }
    this.recompute();
  },

  /* ---------- 行操作 ---------- */
  removeLine(e) {
    if (this.data.submitting || this._unloaded) return;
    const lines = this.data.lines.slice();
    lines.splice(e.currentTarget.dataset.index, 1);
    this.setData({ lines: lines });
    this.recompute();
  },
  stepQty(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const lines = this.data.lines.slice();
    const it = lines[idx];
    if (!it) return;
    const next = (Number(it.qty) || 1) + Number(e.currentTarget.dataset.delta);
    if (next < 1) return;
    it.qty = next;
    this.setData({ lines: lines });
    this.recompute();
  },
  onQtyInput(e) {
    if (this.data.submitting || this._unloaded) return;
    const lines = this.data.lines.slice();
    if (!lines[e.currentTarget.dataset.index]) return;
    lines[e.currentTarget.dataset.index].qty = e.detail.value;
    this.setData({ lines });
    this.recompute();
  },
  onCostInput(e) {
    if (this.data.submitting || this._unloaded) return;
    const lines = this.data.lines.slice();
    const item = lines[e.currentTarget.dataset.index];
    if (!item) return;
    item.unitCost = e.detail.value;
    item.unitCostStr = e.detail.value;
    this.setData({ lines });
    this.recompute();
  },
  onQtyBlur(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const lines = this.data.lines.slice();
    const it = lines[idx];
    if (!it) return;
    const raw = e.detail.value;
    let q = Number(raw);
    if (!Number.isSafeInteger(q) || q < 1) q = raw;
    it.qty = q;
    this.setData({ lines: lines });
    this.recompute();
  },
  onCostBlur(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const lines = this.data.lines.slice();
    const it = lines[idx];
    if (!it) return;
    const value = e.detail.value;
    const cost = value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? util.round2(Number(value)) : value;
    it.unitCost = cost;
    it.unitCostStr = String(cost);
    this.setData({ lines: lines });
    this.recompute();
  },
  onRemark(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ remark: e.detail.value });
  },

  recompute() {
    const lines = this.data.lines.map((it) => {
      const qty = Math.floor(util.toNum(it.qty, 0));
      const unitCost = util.toNum(it.unitCost, 0);
      const amount = qty > 0 ? util.round2(unitCost * qty) : 0;
      return Object.assign({}, it, { lineKey: lineId(it), amount: amount, amountText: util.fmtMoney(amount) });
    });
    let totalQty = 0;
    let total = 0;
    lines.forEach((l) => {
      totalQty += Number(l.qty) || 0;
      total = util.round2(total + l.amount);
    });
    this.setData({ lines: lines, totalQty: totalQty, totalAmountText: util.fmtMoney(total) });
  },

  /* ---------- 提交 ---------- */
  doSubmit() {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded) return;
    const valid = this.data.lines;
    if (!valid.length) {
      wx.showToast({ title: '进货明细为空', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    if (valid.some(l => !Number.isSafeInteger(Number(l.qty)) || Number(l.qty) < 1 || l.unitCost === '' || !Number.isFinite(Number(l.unitCost)) || Number(l.unitCost) < 0)) {
      wx.showToast({ title: '请检查每行数量和进价（数量为正整数）', icon: 'none' });
      return;
    }
    const payload = {
      supplierId: this.data.supplierId,
      remark: this.data.remark,
      lines: valid.map((l) => ({
        goodsId: l.goodsId,
        skuKey: l.skuKey || '',
        color: l.color || '',
        size: l.size || '',
        qty: Number(l.qty),
        unitCost: util.toNum(l.unitCost, 0)
      }))
    };
    payload.requestId = util.operationRequestId(this, 'submitPurchase', payload);
    this.setData({ submitting: true });
    util.submitPurchase(payload).then((r) => {
      if (!this.isLedgerCurrent(revision)) return;
      this.setData({ submitting: false });
      this.reset();
      const notifySaved = () => {
        if (this.isLedgerCurrent(revision)) wx.showToast({ title: '入库已保存，请在流水查看', icon: 'none' });
      };
      try { wx.showModal({
        title: '入库成功',
        content: '单号 ' + (r.orderNo || '') + '\n合计 ¥' + util.fmtMoney(r.totalAmount) +
          (r.supplierName ? '\n供应商 ' + r.supplierName : ''),
        cancelText: '再入一单',
        confirmText: '查看单据',
        fail: notifySaved,
        success: (res) => {
          if (res.confirm && r.orderId && this.isLedgerCurrent(revision)) {
            wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + r.orderId + '&type=purchase' });
          }
        }
      }); } catch (e) { notifySaved(); }
    }).catch((e) => {
      if (!this.isLedgerCurrent(revision)) return;
      this.setData({ submitting: false });
      wx.showToast({ title: (e && e.message) || '入库失败', icon: 'none' });
    });
  },
  reset() {
    util.clearOperationRequest(this, 'submitPurchase');
    this.setData({ lines: [], remark: '', totalQty: 0, totalAmountText: '0.00', showSupplier: false });
  }
});
