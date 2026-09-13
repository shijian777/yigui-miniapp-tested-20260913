// pages/sale/sale.js —— 销售开单（购物车式）
// 色码管理：每个商品行含 skuKey/color/size 维度，库存按 SKU 扣
// 金额口径与云函数 submitSale 内 calcTotals 完全一致（服务端重算为权威结果）：
//   subtotal = Σ round2(单价 x 数量)
//   折后 = round2(subtotal x 折扣%/100)，抹零后应收取整数元
const util = require('../../utils/util.js');

function calcTotals(cart, pct, erase) {
  let subtotal = 0;
  cart.forEach((it) => {
    const qty = util.toNum(it.qty, 0);
    const price = util.toNum(it.price, 0);
    if (qty <= 0) return;
    subtotal = util.round2(subtotal + util.round2(price * qty));
  });
  const afterDiscount = util.round2(subtotal * pct / 100);
  const discountAmount = util.round2(subtotal - afterDiscount);
  const amountDue = erase ? Math.floor(afterDiscount) : afterDiscount;
  const eraseAmount = erase ? util.round2(afterDiscount - amountDue) : 0;
  return {
    subtotal: subtotal,
    discountAmount: discountAmount,
    eraseAmount: eraseAmount,
    amountDue: amountDue,
    pctText: (pct / 10).toString()
  };
}

// 行 ID：相同 goodsId+skuKey 合并，skuKey 为空则只按 goodsId 合并（兼容旧商品）
function lineId(it) {
  return String(it.goodsId) + '|' + String(it.skuKey || '');
}

Page({
  onLoad() {
    this._ledgerRevision = Number(getApp().globalData.dataRevision) || 0;
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}
  },
  data: {
    keyword: '',
    searching: false,
    searchList: [],
    cart: [],
    pctStr: '100',
    erase: false,
    payment: 'cash',
    receivedStr: '',
    receivedTouched: false,
    remark: '',
    customerName: '',
    customerPhone: '',
    customerId: '',
    submitting: false,
    totals: { subtotalText: '0.00', discountText: '0.00', eraseText: '0.00', amountDueText: '0.00', changeText: '0.00', debtText: '0.00', discountAmount: 0, eraseAmount: 0, change: 0, debt: 0 }
  },

  onUnload() {
    this._unloaded = true;
    this._searchSeq = (this._searchSeq || 0) + 1;
    clearTimeout(this._searchTimer);
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
    clearTimeout(this._searchTimer);
    this._searchSeq = (this._searchSeq || 0) + 1;
    this._confirmingSearch = false;
    this.setData({ submitting: false, searching: false });
    this.resetCart();
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
    this.initializePayment();
  },

  initializePayment() {
    if (this._paymentInitialized) return;
    this._paymentInitialized = true;
    const generation = this._cartGeneration || 0;
    const revision = Number(getApp().globalData.dataRevision) || 0;
    const apply = (settings) => {
      if (!this.isLedgerCurrent(revision) || generation !== (this._cartGeneration || 0) || this._paymentTouched || this.data.receivedTouched) return;
      this.setData({ payment: (settings && settings.defaultPayment) || 'cash' });
      this.syncReceived();
    };
    const settings = getApp().globalData.settings;
    if (settings) apply(settings);
    else util.fetchSettings().then(apply).catch(() => {});
  },

  /* ---------------- 搜索 ---------------- */
  onKeyword(e) {
    if (this.data.submitting || this._unloaded) return;
    const kw = e.detail.value;
    this._searchSeq = (this._searchSeq || 0) + 1;
    this.setData({ keyword: kw, searchList: [], searching: kw ? true : false });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (!kw) return;
    this._searchTimer = setTimeout(() => this.doSearch(kw), 250);
  },
  async doSearch(kw) {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this._unloaded || this.data.submitting) return;
    const seq = this._searchSeq = (this._searchSeq || 0) + 1;
    try {
      await util.ensureOpenid();
      const db = util.db();
      const _ = db.command;
      const reg = db.RegExp({ regexp: util.escReg(kw), options: 'i' });
      const where = _.and([
        { openid: getApp().globalData.openid },
        { status: 'on' },
        _.or([{ name: reg }, { barcode: reg }])
      ]);
      const res = await db.collection('goods').where(where).orderBy('updatedAt', 'desc').limit(20).get();
      if (!this.isLedgerCurrent(revision) || seq !== this._searchSeq) return;
      const list = res.data || [];
      this.setData({ searchList: list, searching: false });
    } catch (e) {
      if (!this.isLedgerCurrent(revision) || seq !== this._searchSeq) return;
      this.setData({ searching: false });
      wx.showToast({ title: '搜索失败：' + ((e && e.message) || '未知错误'), icon: 'none' });
    }
  },
  async onSearchConfirm() {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded || this._confirmingSearch) return;
    const kw = (this.data.keyword || '').trim();
    if (!kw) return;
    clearTimeout(this._searchTimer);
    const seq = this._searchSeq = (this._searchSeq || 0) + 1;
    this._confirmingSearch = true;
    try {
      await util.ensureOpenid();
      const db = util.db();
      const res = await db.collection('goods')
        .where({ openid: getApp().globalData.openid, status: 'on', barcode: kw })
        .limit(1).get();
      if (!this.isLedgerCurrent(revision) || seq !== this._searchSeq) return;
      if (res.data.length) {
        this.addToCart(res.data[0]);
        this.clearKeyword();
        return;
      }
    } catch (e) { /* 落到普通搜索 */ }
    finally { this._confirmingSearch = false; }
    if (this.isLedgerCurrent(revision) && seq === this._searchSeq) this.doSearch(kw);
  },
  clearKeyword() {
    if (this.data.submitting || this._unloaded) return;
    clearTimeout(this._searchTimer);
    this._searchSeq = (this._searchSeq || 0) + 1;
    this.setData({ keyword: '', searchList: [], searching: false });
  },
  addFromSearch(e) {
    if (this.data.submitting || this._unloaded) return;
    const g = this.data.searchList[e.currentTarget.dataset.index];
    if (g) this.addToCart(g);
  },

  /* ---------------- 加购 ---------------- */
  // 有 SKU 的商品 → 弹出 sku-picker；无 SKU 的旧商品 → 直接入车
  addToCart(g) {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded) return;
    const hasSkus = Array.isArray(g.skus) && g.skus.length;
    if (hasSkus || (Array.isArray(g.colors) && g.colors.length)) {
      const goodsJson = encodeURIComponent(JSON.stringify(g));
      wx.navigateTo({
        url: '/pages/sku-picker/sku-picker?goodsJson=' + goodsJson + '&mode=cart',
        events: {
          pickSku: (it) => { if (this.isLedgerCurrent(revision)) this.mergeIntoCart(it); }
        }
      });
    } else {
      // 兼容旧商品
      const stock = Number(g.stock) || 0;
      if (stock <= 0) {
        wx.showToast({ title: '「' + g.name + '」库存为 0', icon: 'none' });
        return;
      }
      this.mergeIntoCart({
        goodsId: g._id,
        name: g.name,
        unit: g.unit || '件',
        skuKey: '',
        color: '',
        size: '',
        qty: 1,
        price: Number(g.price) || 0,
        costPrice: Number(g.costPrice) || 0,
        stock: stock
      });
    }
  },
  // 把 SKU 选择结果合并到购物车（同 goodsId+skuKey 合并数量）
  mergeIntoCart(it) {
    if (this.data.submitting || this._unloaded) return;
    const id = lineId(it);
    const cart = this.data.cart.slice();
    const idx = cart.findIndex((x) => lineId(x) === id);
    if (idx >= 0) {
      if (Number(cart[idx].qty) + Number(it.qty) > it.stock) {
        wx.showToast({ title: '已达库存上限（剩 ' + it.stock + '）', icon: 'none' });
        return;
      }
      cart[idx].qty = Number(cart[idx].qty) + Number(it.qty);
    } else {
      cart.push(Object.assign({}, it));
    }
    this.setData({ cart: cart });
    this.recompute();
    this.clearKeyword();
    if (wx.vibrateShort) wx.vibrateShort({});
  },

  /* ---------------- 购物车行操作 ---------------- */
  removeLine(e) {
    if (this.data.submitting || this._unloaded) return;
    const cart = this.data.cart.slice();
    cart.splice(e.currentTarget.dataset.index, 1);
    this.setData({ cart: cart });
    this.recompute();
  },
  stepQty(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const delta = Number(e.currentTarget.dataset.delta);
    const cart = this.data.cart.slice();
    const it = cart[idx];
    if (!it) return;
    const next = (Number(it.qty) || 1) + delta;
    if (next < 1) return;
    if (next > it.stock) {
      wx.showToast({ title: '库存不足（剩 ' + it.stock + '）', icon: 'none' });
      return;
    }
    it.qty = next;
    this.setData({ cart: cart });
    this.recompute();
  },
  onQtyInput(e) {
    if (this.data.submitting || this._unloaded) return;
    const cart = this.data.cart.slice();
    if (!cart[e.currentTarget.dataset.index]) return;
    cart[e.currentTarget.dataset.index].qty = e.detail.value;
    this.setData({ cart });
    this.recompute();
  },
  onPriceInput(e) {
    if (this.data.submitting || this._unloaded) return;
    const cart = this.data.cart.slice();
    if (!cart[e.currentTarget.dataset.index]) return;
    cart[e.currentTarget.dataset.index].price = e.detail.value;
    this.setData({ cart });
    this.recompute();
  },
  onQtyBlur(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const cart = this.data.cart.slice();
    const it = cart[idx];
    if (!it) return;
    const raw = e.detail.value;
    let q = Number(raw);
    if (!Number.isSafeInteger(q) || q < 1) q = raw;
    if (q > it.stock) {
      wx.showToast({ title: '库存不足（剩 ' + it.stock + '）', icon: 'none' });
      q = it.stock;
    }
    it.qty = q;
    this.setData({ cart: cart });
    this.recompute();
  },
  onPriceBlur(e) {
    if (this.data.submitting || this._unloaded) return;
    const idx = e.currentTarget.dataset.index;
    const cart = this.data.cart.slice();
    const it = cart[idx];
    if (!it) return;
    const value = e.detail.value;
    it.price = value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? util.round2(Number(value)) : value;
    this.setData({ cart: cart });
    this.recompute();
  },

  /* ---------------- 结算 ---------------- */
  recompute() {
    const pct = Math.min(100, Math.max(0, util.toNum(this.data.pctStr, 100)));
    const erase = this.data.erase;
    const cart = this.data.cart.map((it) => {
      const qty = Math.floor(util.toNum(it.qty, 0));
      return Object.assign({}, it, {
        lineKey: lineId(it),
        amount: qty > 0 ? util.round2(util.toNum(it.price, 0) * qty) : 0
      });
    });
    const t = calcTotals(cart, pct, erase);
    this.setData({ cart: cart });

    let received = util.toNum(this.data.receivedStr, -1);
    const needDefault = !this.data.receivedTouched;
    let receivedNum;
    if (needDefault) {
      receivedNum = this.data.payment === 'credit' ? 0 : t.amountDue;
    } else {
      receivedNum = util.round2(received);
    }
    const change = receivedNum > t.amountDue ? util.round2(receivedNum - t.amountDue) : 0;
    const debt = t.amountDue > receivedNum ? util.round2(t.amountDue - receivedNum) : 0;

    this.setData({
      totals: {
        subtotalText: util.fmtMoney(t.subtotal),
        discountAmount: t.discountAmount,
        discountText: util.fmtMoney(t.discountAmount),
        eraseAmount: t.eraseAmount,
        eraseText: util.fmtMoney(t.eraseAmount),
        amountDueText: util.fmtMoney(t.amountDue),
        change: change,
        changeText: util.fmtMoney(change),
        debt: debt,
        debtText: util.fmtMoney(debt),
        pctText: t.pctText
      },
      receivedStr: needDefault ? (this.data.payment === 'credit' ? '0' : util.fmtMoney(receivedNum)) : this.data.receivedStr
    });
  },
  syncReceived() {
    this.setData({ receivedTouched: false, receivedStr: '' });
    this.recompute();
  },
  onPctInput(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ pctStr: e.detail.value });
    this.recompute();
  },
  onPctBlur(e) {
    if (this.data.submitting || this._unloaded) return;
    const v = e.detail.value;
    this.setData({ pctStr: String(v) });
    this.recompute();
  },
  setPct(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ pctStr: String(e.currentTarget.dataset.pct) });
    this.recompute();
  },
  onErase(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ erase: e.detail.value });
    this.recompute();
  },
  setPayment(e) {
    if (this.data.submitting || this._unloaded) return;
    this._paymentTouched = true;
    this.setData({ payment: e.currentTarget.dataset.pay });
    this.syncReceived();
  },
  onReceivedInput(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ receivedStr: e.detail.value, receivedTouched: true });
    const pct = Math.min(100, Math.max(0, util.toNum(this.data.pctStr, 100)));
    const t = calcTotals(this.data.cart, pct, this.data.erase);
    const receivedNum = util.round2(util.toNum(e.detail.value, 0));
    const change = receivedNum > t.amountDue ? util.round2(receivedNum - t.amountDue) : 0;
    const debt = t.amountDue > receivedNum ? util.round2(t.amountDue - receivedNum) : 0;
    this.setData({
      'totals.change': change,
      'totals.changeText': util.fmtMoney(change),
      'totals.debt': debt,
      'totals.debtText': util.fmtMoney(debt)
    });
  },
  onReceivedBlur() {
    if (this.data.submitting || this._unloaded) return;
    this.recompute();
  },
  fillReceived() {
    if (this.data.submitting || this._unloaded) return;
    const t = calcTotals(this.data.cart, Math.min(100, Math.max(0, util.toNum(this.data.pctStr, 100))), this.data.erase);
    this.setData({ receivedStr: util.fmtMoney(t.amountDue), receivedTouched: true });
    this.recompute();
  },
  onRemark(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ remark: e.detail.value });
  },
  onCustomerName(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ customerName: e.detail.value });
  },
  onCustomerPhone(e) {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ customerPhone: e.detail.value });
  },
  // 打开客户列表选客户（eventChannel 回传）
  pickCustomer() {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded) return;
    const self = this;
    wx.navigateTo({
      url: '/pages/customers/customers?from=picker',
      events: {
        picked: (c) => {
          if (!c || !c._id || !self.isLedgerCurrent(revision) || self.data.submitting) return;
          self.setData({
            customerId: c._id,
            customerName: c.name || '',
            customerPhone: c.phone || ''
          });
        }
      }
    });
  },
  clearCustomer() {
    if (this.data.submitting || this._unloaded) return;
    this.setData({ customerId: '', customerName: '', customerPhone: '' });
  },

  /* ---------------- 提交 ---------------- */
  doSubmit() {
    if (!this.ensureLedgerCurrent()) return;
    const revision = this._ledgerRevision;
    if (this.data.submitting || this._unloaded) return;
    const valid = this.data.cart;
    if (!valid.length) {
      wx.showToast({ title: '购物车为空', icon: 'none' });
      return;
    }
    for (let i = 0; i < valid.length; i++) {
      const it = valid[i];
      if (!Number.isSafeInteger(Number(it.qty)) || Number(it.qty) < 1 || it.price === '' || !Number.isFinite(Number(it.price)) || Number(it.price) < 0) {
        wx.showToast({ title: '请检查每行数量和单价（数量为正整数）', icon: 'none' });
        return;
      }
      if (it.qty > it.stock) {
        const tag = it.skuKey ? ('(' + it.color + '·' + it.size + ')') : '';
        wx.showToast({ title: '「' + it.name + tag + '」库存不足', icon: 'none' });
        return;
      }
    }
    if (this.data.submitting) return;

    if (this.data.pctStr === '' || !Number.isFinite(Number(this.data.pctStr)) || Number(this.data.pctStr) < 0 || Number(this.data.pctStr) > 100 || (this.data.receivedTouched && (this.data.receivedStr === '' || !Number.isFinite(Number(this.data.receivedStr)) || Number(this.data.receivedStr) < 0))) {
      wx.showToast({ title: '请检查折扣和实收金额', icon: 'none' });
      return;
    }
    const pct = Math.min(100, Math.max(0, util.toNum(this.data.pctStr, 100)));
    const received = util.toNum(this.data.receivedStr, this.data.payment === 'credit' ? 0 : this.data.totals.amountDueText);
    const payload = {
      lines: valid.map((it) => ({
        goodsId: it.goodsId,
        skuKey: it.skuKey || '',
        color: it.color || '',
        size: it.size || '',
        qty: Number(it.qty),
        price: util.toNum(it.price, 0)
      })),
      discountPct: pct,
      erase: this.data.erase,
      paymentMethod: this.data.payment,
      received: received,
      remark: this.data.remark,
      customerId: this.data.customerId || '',
      customerName: this.data.customerName || '',
      customerPhone: this.data.customerPhone || ''
    };

    payload.requestId = util.operationRequestId(this, 'submitSale', payload);
    this.setData({ submitting: true });
    util.submitSale(payload).then((r) => {
      if (!this.isLedgerCurrent(revision)) return;
      this.setData({ submitting: false });
      // 异步刷新客户聚合（失败不阻塞）
      if (this.data.customerId) {
        util.syncCustomers().catch(() => {});
      }
      this.resetCart();
      wx.showModal({
        title: '开单成功',
        content: '单号 ' + (r.orderNo || '') + '\n应收 ¥' + util.fmtMoney(r.amountDue) + '，实收 ¥' + util.fmtMoney(r.received),
        cancelText: '继续开单',
        confirmText: '查看小票',
        success: (res) => {
          if (res.confirm && this.isLedgerCurrent(revision)) {
            wx.navigateTo({ url: '/pages/receipt/receipt?id=' + r.orderId });
          }
        }
      });
    }).catch((e) => {
      if (!this.isLedgerCurrent(revision)) return;
      this.setData({ submitting: false });
      wx.showToast({ title: (e && e.message) || '开单失败，请重试', icon: 'none' });
    });
  },
  resetCart() {
    util.clearOperationRequest(this, 'submitSale');
    this._cartGeneration = (this._cartGeneration || 0) + 1;
    this._paymentInitialized = false;
    this._paymentTouched = false;
    this.setData({
      cart: [],
      keyword: '',
      searchList: [],
      pctStr: '100',
      erase: false,
      payment: 'cash',
      receivedStr: '',
      receivedTouched: false,
      remark: '',
      customerId: '',
      customerName: '',
      customerPhone: ''
    });
    this.initializePayment();
    this.recompute();
  }
});
