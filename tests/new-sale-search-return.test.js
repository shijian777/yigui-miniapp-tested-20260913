const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');
const wxml = require('./helpers/wxml-runtime');
const actual = require('../utils/util');

const product = {
  _id: 'search-dress', name: '搜索测试连衣裙', barcode: 'VS09131820', unit: '件',
  price: 100, costPrice: 40, stock: 5, colors: ['米白'], sizes: ['M'],
  skus: [{ key: '米白-M', color: '米白', size: 'M', stock: 5, price: 100, costPrice: 40 }]
};

function tap(page, name, handler) {
  return wxml.event(page, name, { type: 'tap', name: handler });
}

function hasDropdown(page) {
  return wxml.nodes(wxml.render('sale', page.data)).some(node =>
    String(node.attr && node.attr.class || '').split(/\s+/).includes('drop'));
}

function fixture(searchResult) {
  const app = { globalData: { openid: 'owner', settings: { defaultPayment: 'cash' } }, _resolveTheme: () => 'light' };
  const routes = [];
  const query = { where() { return this; }, orderBy() { return this; }, limit() { return this; }, get: () => searchResult.promise };
  const util = { ...actual, ensureOpenid: async () => 'owner', db: () => ({
    command: { and: value => value, or: value => value }, RegExp: value => value, collection: () => query
  }) };
  let sale;
  const wx = { showToast() {}, setNavigationBarTitle() {}, navigateTo: route => routes.push(route), navigateBack: () => sale.onShow() };
  sale = loadPage('sale', { app, wx, modules: { '../../utils/util.js': util } });
  sale.onLoad();
  sale.onShow();
  sale.setData({ keyword: 'VS09131820', searchList: [product] });

  function openSku() {
    tap(sale, 'sale', 'addFromSearch');
    const route = routes[routes.length - 1];
    const picker = loadPage('sku-picker', { app, wx });
    picker.getOpenerEventChannel = () => ({ emit: (name, value) => route.events[name](value) });
    picker.onLoad({ goodsJson: route.url.match(/goodsJson=([^&]+)/)[1], mode: 'cart' });
    return picker;
  }
  function confirmSku(picker, quantity) {
    tap(picker, 'sku-picker', 'pickCell');
    wxml.event(picker, 'sku-picker', { type: 'input', name: 'onQtyInput' }, { value: String(quantity) });
    tap(picker, 'sku-picker', 'confirm');
  }
  return { sale, openSku, confirmSku, cancel: () => wx.navigateBack() };
}

// Missing successful-add cleanup leaves the old dropdown over checkout.
test('点击搜索结果选 SKU 返回后收起下拉，保留选择的两件商品', { skip: !wxml.available }, () => {
  const f = fixture();
  assert.equal(hasDropdown(f.sale), true);
  f.confirmSku(f.openSku(), 2);
  assert.equal(f.sale.data.cart.length, 1);
  assert.equal(f.sale.data.cart[0].goodsId, 'search-dress');
  assert.equal(f.sale.data.cart[0].qty, 2);
  assert.equal(f.sale.data.totals.amountDueText, '200.00');
  assert.equal(f.sale.data.keyword, '');
  assert.equal(f.sale.data.searchList.length, 0);
  assert.equal(f.sale.data.searching, false);
  assert.equal(hasDropdown(f.sale), false);
});

// Clearing only visible fields would allow an in-flight query to repopulate them.
test('SKU 成功加购后，之前未完成的搜索不能重新填回结果', { skip: !wxml.available }, async () => {
  const result = deferred();
  const f = fixture(result);
  const pending = f.sale.doSearch('VS09131820');
  await flush();
  f.confirmSku(f.openSku(), 2);
  result.resolve({ data: [product] });
  await pending;
  assert.equal(f.sale.data.searchList.length, 0);
  assert.equal(f.sale.data.keyword, '');
  assert.equal(f.sale.data.cart[0].qty, 2);
  assert.equal(hasDropdown(f.sale), false);
});

// Clearing when the picker opens would discard a search even when nothing is added.
test('取消 SKU 选择返回后保留搜索，购物车仍为空', { skip: !wxml.available }, () => {
  const f = fixture();
  f.openSku();
  f.cancel();
  assert.equal(f.sale.data.keyword, 'VS09131820');
  assert.equal(f.sale.data.searchList[0]._id, 'search-dress');
  assert.equal(f.sale.data.cart.length, 0);
  assert.equal(hasDropdown(f.sale), true);
});

test('SKU 数量超过库存时不加购，返回后仍可继续搜索选择', { skip: !wxml.available }, () => {
  const f = fixture();
  const picker = f.openSku();
  f.confirmSku(picker, 6);
  assert.equal(picker.data.confirming, false);
  f.cancel();
  assert.equal(f.sale.data.cart.length, 0);
  assert.equal(f.sale.data.keyword, 'VS09131820');
  assert.equal(hasDropdown(f.sale), true);
});

// Cleanup before the merge's stock guard would hide a failed addition.
test('同 SKU 合并超过库存时保留原有四件和搜索结果', { skip: !wxml.available }, () => {
  const f = fixture();
  f.sale.setData({ cart: [{ goodsId: 'search-dress', name: '搜索测试连衣裙', unit: '件',
    skuKey: '米白-M', color: '米白', size: 'M', qty: 4, stock: 5, price: 100, costPrice: 40 }] });
  f.sale.recompute();
  f.confirmSku(f.openSku(), 2);
  assert.equal(f.sale.data.cart.length, 1);
  assert.equal(f.sale.data.cart[0].qty, 4);
  assert.equal(f.sale.data.totals.amountDueText, '400.00');
  assert.equal(f.sale.data.keyword, 'VS09131820');
  assert.equal(f.sale.data.searchList[0]._id, 'search-dress');
  assert.equal(hasDropdown(f.sale), true);
});
