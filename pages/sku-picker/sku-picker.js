// pages/sku-picker/sku-picker.js —— 色码选择器（颜色×尺码 网格）
// 从 opener 通过 URL 传入 goodsId 或直接传 goods 快照（onLoad 由 wx.navigateTo options 解码不友好，所以推荐用 eventChannel 注入）
// 行为：网格点击单元格 = 选中 SKU + 设置数量；
//       顶部"+"可加减数量；底部"加入清单"回传 {skuKey, color, size, qty, price, costPrice, name, ...}。
// 兼容旧商品（无 skus）：退化为一个"默认 SKU"占位。
const util = require('../../utils/util.js');

Page({
  data: {
    goods: null,
    colors: [],
    sizes: [],
    skuMap: {},        // key -> {stock,costPrice,price,color,size}
    flatList: [],      // 展开用于 wx:for
    selectedKey: '',
    selectedSku: null,
    qty: 1,
    mode: 'cart',      // 'cart' 销售加购 / 'purchase' 进货入库
    confirming: false,
    defaultPrice: 0,
    defaultCost: 0
  },

  onLoad(query) {
    // 同步主题
    try {
      const app = getApp();
      this.setData({ theme: app._resolveTheme(app.globalData.theme), themeRaw: app.globalData.theme || 'auto' });
    } catch (e) {}

    // goods 数据通过 URL 序列化（适合小型快照）；也支持 onLoad 时 query.goodsJson
    let g = null;
    if (query && query.goodsJson) {
      try { g = JSON.parse(decodeURIComponent(query.goodsJson)); } catch (e) {}
    }
    if (!g && query && query.goodsId) {
      // 调用方略：sale.js 可以直接传 goodsId 让本页面从云数据库拉（暂未实现，推荐传 goodsJson）
    }
    // 兼容 goods-picker 快照：其商品 ID 字段是 goodsId，不是数据库的 _id
    if (g && !g._id && g.goodsId) g._id = g.goodsId;
    const mode = (query && query.mode) || 'cart';
    this.setData({ mode: mode });
    if (g) this.setGoods(g);
  },

  setGoods(g) {
    const colors = Array.isArray(g.colors) ? g.colors.slice() : [];
    const sizes = Array.isArray(g.sizes) ? g.sizes.slice() : [];
    let skuMap = {};
    let flatList = [];
    const skus = Array.isArray(g.skus) ? g.skus : [];
    if (skus.length) {
      skus.forEach((s) => {
        const k = String(s.key || '');
        if (!k) return;
        // 兜底：没填颜色/尺码的 SKU 按「默认」显示，保证矩阵至少有一行可点
        // （否则 colors 为空 → flatList 无行 → 无格子可选 → 底部按钮永远灰）
        const dc = (String(s.color || '').trim()) || '默认';
        const dz = (String(s.size || '').trim()) || '默认';
        const dk = dc + '·' + dz;
        skuMap[dk] = {
          key: k, // 保留原始 key：提交进货/销售时服务端按原始 key 匹配库存
          color: dc,
          size: dz,
          stock: Number(s.stock) || 0,
          costPrice: Number(s.costPrice) || 0,
          price: Number(s.price) || 0
        };
        if (colors.indexOf(dc) < 0) colors.push(dc);
        if (sizes.indexOf(dz) < 0) sizes.push(dz);
      });
    } else {
      // 兼容无 SKU 的旧商品：按已填 colors/sizes 展开（没有则用「默认」），保证矩阵可点
      // 注意：矩阵格子 key 用「显示 key」（颜色·尺码），skuMap 也按显示 key 索引，
      // 内部保留 buildSkus 原始 key 供提交。与上面 skus 分支保持同一套键规则。
      if (!colors.length) colors.push('默认');
      if (!sizes.length) sizes.push('默认');
      util.buildSkus(colors, sizes, { costPrice: Number(g.costPrice) || 0, price: Number(g.price) || 0 }).forEach((s) => {
        const dc = (String(s.color || '').trim()) || '默认';
        const dz = (String(s.size || '').trim()) || '默认';
        const dk = dc + '·' + dz;
        skuMap[dk] = {
          key: s.key,
          color: dc,
          size: dz,
          stock: Number(g.stock) || 0,
          costPrice: Number(s.costPrice) || 0,
          price: Number(s.price) || 0
        };
      });
    }

    // 网格数据：每行（颜色）下多个尺码单元
    flatList = colors.map((c) => ({
      color: c,
      cells: sizes.map((s) => {
        const key = c + '·' + s;
        const sku = skuMap[key];
        return {
          key: key,
          size: s,
          hasSku: !!sku,
          stock: sku ? sku.stock : 0,
          costPrice: sku ? sku.costPrice : 0,
          price: sku ? sku.price : 0,
          out: !sku || sku.stock <= 0
        };
      })
    }));

    this.setData({
      goods: g,
      colors: colors,
      sizes: sizes,
      skuMap: skuMap,
      flatList: flatList,
      defaultPrice: Number(g.price) || 0,
      defaultCost: Number(g.costPrice) || 0
    });
    wx.setNavigationBarTitle({ title: (g.name || '选择色码').slice(0, 12) });
  },

  /* ---------- 网格交互 ---------- */
  pickCell(e) {
    if (this.data.confirming) return;
    const key = e.currentTarget.dataset.key;
    const sku = this.data.skuMap[key];
    if (!sku) return;
    this.setData({
      selectedKey: key,
      selectedSku: sku,
      qty: 1
    });
  },

  /* ---------- 数量 ---------- */
  stepQty(e) {
    if (this.data.confirming) return;
    const delta = Number(e.currentTarget.dataset.delta);
    let q = (Number(this.data.qty) || 1) + delta;
    if (q < 1) q = 1;
    if (this.data.mode !== 'purchase' && this.data.selectedSku && q > this.data.selectedSku.stock) {
      wx.showToast({ title: '库存仅剩 ' + this.data.selectedSku.stock, icon: 'none' });
      q = this.data.selectedSku.stock;
    }
    this.setData({ qty: q });
  },
  onQtyInput(e) {
    if (this.data.confirming) return;
    this.setData({ qty: e.detail.value });
  },
  onQtyBlur(e) {
    if (this.data.confirming) return;
    const raw = e.detail.value;
    let q = Number(raw);
    if (!Number.isSafeInteger(q) || q < 1) q = raw;
    if (this.data.mode !== 'purchase' && this.data.selectedSku && q > this.data.selectedSku.stock) {
      wx.showToast({ title: '库存仅剩 ' + this.data.selectedSku.stock, icon: 'none' });
      q = this.data.selectedSku.stock;
    }
    this.setData({ qty: q });
  },

  /* ---------- 进价（仅进货模式） ---------- */
  onCostInput(e) {
    if (this.data.confirming || !this.data.selectedSku) return;
    const sku = Object.assign({}, this.data.selectedSku, { costPrice: e.detail.value });
    const skuMap = Object.assign({}, this.data.skuMap);
    skuMap[this.data.selectedKey] = sku;
    this.setData({ selectedSku: sku, skuMap: skuMap });
  },
  onCostBlur(e) {
    if (this.data.confirming) return;
    const value = e.detail.value;
    const v = value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? util.round2(Number(value)) : value;
    const sku = Object.assign({}, this.data.selectedSku, { costPrice: v });
    const skuMap = Object.assign({}, this.data.skuMap, {}); // 不持久化到全部
    skuMap[this.data.selectedKey] = sku;
    this.setData({ selectedSku: sku, skuMap: skuMap });
  },

  /* ---------- 确认 ---------- */
  confirm() {
    if (this.data.confirming) return;
    const sku = this.data.selectedSku;
    if (!sku) {
      wx.showToast({ title: '请先选择色码', icon: 'none' });
      return;
    }
    const qty = Number(this.data.qty);
    if (!Number.isSafeInteger(qty) || qty < 1) {
      wx.showToast({ title: '请输入大于 0 的整数数量', icon: 'none' });
      return;
    }
    if (this.data.mode !== 'purchase' && qty > sku.stock) {
      wx.showToast({ title: '库存不足（剩 ' + sku.stock + '）', icon: 'none' });
      return;
    }
    const cost = Number(sku.costPrice);
    if (this.data.mode === 'purchase' && (sku.costPrice === '' || !Number.isFinite(cost) || cost < 0)) {
      wx.showToast({ title: '请输入有效进价，可填 0', icon: 'none' });
      return;
    }
    this.setData({ confirming: true });
    if (this.data.mode === 'purchase') {
      // 进货模式：回传 unitCost（默认用 SKU 当前 costPrice，可被采购员改）
      const evt = {
        goodsId: this.data.goods._id || this.data.goods.goodsId,
        name: this.data.goods.name,
        unit: this.data.goods.unit || '件',
        skuKey: sku.key,
        color: sku.color,
        size: sku.size,
        qty: qty,
        unitCost: util.round2(cost),
        stock: sku.stock
      };
      const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (ch && ch.emit) ch.emit('pickSku', evt);
    } else {
      // 销售模式
      const evt = {
        goodsId: this.data.goods._id || this.data.goods.goodsId,
        name: this.data.goods.name,
        unit: this.data.goods.unit || '件',
        skuKey: sku.key,
        color: sku.color,
        size: sku.size,
        qty: qty,
        price: Number(sku.price),
        costPrice: sku.costPrice,
        stock: sku.stock
      };
      const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (ch && ch.emit) ch.emit('pickSku', evt);
    }
    wx.navigateBack();
  }
});
