const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run real Page/util/LocalCloud code with only the device boundary replaced.
function loadHome() {
  const storage = new Map();
  const navigation = [];
  global.wx = {
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    showToast() {}, navigateTo: opt => navigation.push(opt.url)
  };
  global.getApp = () => app;
  const app = { globalData: { openid: 'test-owner', settings: null } };
  storage.set('cpos_openid', 'test-owner');
  const { createLocalCloud } = require('../utils/localcloud');
  app.dataCloud = createLocalCloud();
  delete require.cache[require.resolve('../utils/util')];
  const util = require('../utils/util');
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8'), {
    Page: value => definition = value, require: () => util,
    wx, getApp, console, setTimeout, Date, Map, Promise
  });
  const page = Object.assign({}, definition, {
    data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch); }
  });
  return { page, storage, util, navigation };
}

test('首页阈值 0 只预警缺货 SKU，整款库存充足仍提示断码', async () => {
  const { page, storage } = loadHome();
  storage.set('__lcloud_settings', [{ _id: 's1', openid: 'test-owner', lowStockThreshold: 0 }]);
  storage.set('__lcloud_goods', [{
    _id: 'g1', openid: 'test-owner', name: '针织衫', status: 'on', stock: 12,
    skus: [
      { key: '红-S', color: '红', size: 'S', stock: 0, price: 20, costPrice: 10 },
      { key: '红-M', color: '红', size: 'M', stock: 12, price: 20, costPrice: 10 }
    ]
  }]);
  await page.refresh();
  assert.equal(page.data.lowLimit, 0);
  assert.equal(page.data.inv.lowSkuCount, 1);
  assert.equal(page.data.lowGoods.length, 1);
  assert.equal(page.data.lowGoods[0].skuKey, '红-S');
  assert.equal(page.data.inv.totalCost, '120.00');
});

test('首页最近订单从全量历史中取最新八条', async () => {
  const { page, storage } = loadHome();
  storage.set('__lcloud_sales_orders', Array.from({ length: 12 }, (_, i) => ({
    _id: 'order-' + i, openid: 'test-owner', createdAt: new Date(2026, 8, 1, i),
    status: 'normal', amountDue: i, lines: []
  })));
  await page.refresh();
  assert.equal(page.data.recent[0]._id, 'order-11');
  assert.equal(page.data.recent[7]._id, 'order-4');
});

test('首页补货入口带出用户点中的商品', () => {
  const { page, navigation } = loadHome();
  page.restock({ currentTarget: { dataset: { id: 'g 1' } } });
  assert.equal(navigation[0], '/pages/purchase/purchase?goodsId=g%201');
});
