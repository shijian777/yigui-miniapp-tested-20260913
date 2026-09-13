const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createAtomicStorage } = require('../utils/atomic-storage');
const { createLocalCloud } = require('../utils/localcloud');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');

async function fixture(name, overrides = {}) {
  const values = new Map(), copy = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const calls = { navigation: [], toast: [], modal: [] };
  const wx = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
    showToast: value => calls.toast.push(value), showModal: value => calls.modal.push(value),
    navigateTo: value => calls.navigation.push(value)
  };
  const atomic = createAtomicStorage(wx);
  atomic.setStorageSync('cpos_openid', 'revision-owner');
  const cloud = createLocalCloud(atomic);
  const app = { dataCloud: cloud, globalData: { openid: 'revision-owner', settings: { defaultPayment: 'cash' } }, _resolveTheme: () => 'light' };
  const source = path.resolve(__dirname, '../utils/util.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports, require: createRequire(source), getApp: () => app, wx, Date, console }, { filename: source });
  const util = module.exports;
  const saved = (await cloud.callFunction({ name: 'saveGoods', data: { goods: { name: '原账本衬衫', unit: '件', price: 100, costPrice: 40, skus: [{ key: '白-M', color: '白', size: 'M', stock: 10, price: 100, costPrice: 40 }] } } })).result;
  assert.equal(saved.success, true);
  const item = { goodsId: saved.goodsId, name: '原账本衬衫', unit: '件', skuKey: '白-M', color: '白', size: 'M', qty: 1, price: 100, unitCost: 40, costPrice: 40, stock: 10 };
  const page = loadPage(name, { app, wx, modules: { '../../utils/util.js': Object.assign({}, util, overrides) } });
  page.onLoad(); page.onShow(); await flush();
  const restore = async () => {
    const backup = JSON.parse((await util.exportAllData()).json), g = backup.data.goods[0];
    g.name = '恢复后外套'; g.price = 200; g.costPrice = 80; g.stock = 20; g.totalStock = 20;
    g.skus[0].price = 200; g.skus[0].costPrice = 80; g.skus[0].stock = 20;
    await util.importAllData(JSON.stringify(backup), 'overwrite');
  };
  const all = async collection => (await cloud.database().collection(collection).get()).data;
  return { page, app, wx, util, calls, restore, item, all };
}
function merge(f, name, item = f.item) { f.page[name === 'sale' ? 'mergeIntoCart' : 'mergeLine'](item); }
function selectedGoods(f) { return { _id: f.item.goodsId, goodsId: f.item.goodsId, name: f.item.name, colors: ['白'], sizes: ['M'], skus: [{ key: '白-M', color: '白', size: 'M', stock: 10, price: 100, costPrice: 40 }] }; }

test('只有成功的账本恢复递增版本；格式错误的恢复保留当前版本', async () => {
  const f = await fixture('sale');
  const before = Number(f.app.globalData.dataRevision) || 0;
  await f.restore();
  assert.equal(f.app.globalData.dataRevision, before + 1);
  await assert.rejects(() => f.util.importAllData('{invalid', 'overwrite'));
  assert.equal(f.app.globalData.dataRevision, before + 1);
});
test('恢复前迟到的店铺设置查询不能覆盖新账本默认付款方式', async () => {
  const f = await fixture('sale'), old = deferred();
  const provider = f.app.dataCloud; let intercept = true;
  f.app.dataCloud = Object.assign({}, provider, { database: () => {
    const db = provider.database(), collection = db.collection.bind(db);
    db.collection = name => {
      if (name === 'settings' && intercept) {
        intercept = false;
        return { where() { return this; }, limit() { return this; }, get: () => old.promise };
      }
      return collection(name);
    };
    return db;
  } });
  const beforeRestore = f.util.fetchSettings(true); await flush();
  await f.restore();
  const afterRestore = await f.util.fetchSettings(true);
  assert.equal(afterRestore.defaultPayment, 'cash');
  old.resolve({ data: [{ _id: 'old-settings', defaultPayment: 'credit', storeName: '旧店名' }] });
  await beforeRestore;
  assert.equal(f.app.globalData.settings.defaultPayment, 'cash');
  assert.notEqual(f.app.globalData.settings.storeName, '旧店名');
});

for (const name of ['sale', 'purchase']) {
  const action = name === 'sale' ? 'submitSale' : 'submitPurchase';
  const rows = name === 'sale' ? 'cart' : 'lines';
  const collection = name === 'sale' ? 'sales_orders' : 'purchase_orders';
  test(`${name} 恢复后返回清除旧行、客户供应商与失败请求ID，再选商品可用手工价格`, async () => {
    let attempt = 0, f;
    f = await fixture(name, { [action]: payload => ++attempt === 1 ? Promise.reject(new Error('offline')) : f.util[action](payload) });
    merge(f, name);
    f.page.setData({ customerId: 'old-customer', customerName: '旧客户', customerPhone: '13800000000', supplierId: 'old-supplier', supplierName: '旧供应商', keyword: '原账本', searchList: [selectedGoods(f)], remark: '旧单' });
    f.page.doSubmit(); await flush();
    const oldRequestId = f.page._operationRequests[action].id;
    await f.restore(); f.page.onShow(); await flush();
    assert.equal(f.page.data[rows].length, 0);
    assert.equal(f.page._operationRequests[action], undefined);
    assert.equal(name === 'sale' ? f.page.data.customerId : f.page.data.supplierId, '');
    assert.equal(f.page.data.remark, '');
    if (name === 'sale') assert.equal(f.page.data.searchList.length, 0);
    assert.equal((await f.all(collection)).length, 0);
    const current = (await f.all('goods'))[0];
    merge(f, name, Object.assign({}, f.item, { name: current.name, stock: current.stock, price: 123, unitCost: 55 }));
    f.page.doSubmit(); await flush(); await flush();
    const order = (await f.all(collection))[0];
    assert.notEqual(order.requestId, oldRequestId);
    assert.equal(name === 'sale' ? order.lines[0].price : order.lines[0].unitCost, name === 'sale' ? 123 : 55);
  });
  test(`${name} 未先触发onShow也不得把旧单提交到恢复后账本`, async () => {
    const f = await fixture(name); merge(f, name);
    await f.restore(); f.page.doSubmit(); await flush(); await flush();
    assert.equal((await f.all(collection)).length, 0);
    assert.equal(f.page.data[rows].length, 0);
    assert.equal((await f.all('goods'))[0].stock, 20);
  });
  test(`${name} 相同账本返回保留未提交行、备注和手工价格`, async () => {
    const f = await fixture(name); merge(f, name, Object.assign({}, f.item, { price: 123, unitCost: 55 }));
    f.page.onRemark({ detail: { value: '保留输入' } });
    f.page.onShow(); await flush();
    assert.equal(f.page.data[rows].length, 1);
    assert.equal(f.page.data.remark, '保留输入');
    assert.equal(name === 'sale' ? f.page.data.cart[0].price : f.page.data.lines[0].unitCost, name === 'sale' ? 123 : 55);
  });
  for (const status of ['resolve', 'reject']) {
    test(`${name} 恢复前提交的迟到${status}不清新单、不解除新提交锁、不弹旧结果`, async () => {
      const old = deferred(), current = deferred(); let count = 0;
      const f = await fixture(name, { [action]: () => ++count === 1 ? old.promise : current.promise });
      merge(f, name); f.page.doSubmit();
      await f.restore(); f.page.onShow(); await flush();
      merge(f, name, Object.assign({}, f.item, { name: '新单外套' }));
      f.page.onRemark({ detail: { value: '新单备注' } }); f.page.doSubmit();
      assert.equal(count, 2);
      const toastCount = f.calls.toast.length;
      if (status === 'resolve') old.resolve({ orderId: 'old-order', amountDue: 100, totalAmount: 40, received: 100 });
      else old.reject(new Error('旧单错误'));
      await flush();
      assert.equal(f.page.data[rows][0].name, '新单外套');
      assert.equal(f.page.data.remark, '新单备注');
      assert.equal(f.page.data.submitting, true);
      assert.equal(f.calls.modal.length, 0);
      assert.equal(f.calls.toast.length, toastCount);
      current.reject(new Error('新单错误')); await flush();
    });
  }
  test(`${name} 恢复前成功弹窗的确认回调不得跳转新账本同ID订单`, async () => {
    const f = await fixture(name); merge(f, name); f.page.doSubmit(); await flush(); await flush();
    assert.equal(f.calls.modal.length, 1);
    await f.restore();
    f.calls.modal[0].success({ confirm: true });
    assert.equal(f.calls.navigation.length, 0);
  });
}

test('恢复前打开的客户和SKU选择器回调不能回填新销售单', async () => {
  const f = await fixture('sale');
  f.page.pickCustomer(); f.page.addToCart(selectedGoods(f));
  await f.restore(); f.page.onShow(); await flush();
  f.calls.navigation[0].events.picked({ _id: 'old-customer', name: '旧客户' });
  f.calls.navigation[1].events.pickSku(f.item);
  assert.equal(f.page.data.customerId, '');
  assert.equal(f.page.data.cart.length, 0);
});
test('恢复前商品预载结果和供应商列表不能回填进货页', async () => {
  const preload = deferred(), suppliers = deferred(); let listCount = 0;
  const f = await fixture('purchase', { getDocById: () => preload.promise, listCollAll: () => ++listCount === 1 ? suppliers.promise : Promise.resolve([]) });
  const task = f.page._preloadGoods(f.item.goodsId); await flush();
  await f.restore(); f.page.onShow(); await flush();
  preload.resolve(selectedGoods(f)); suppliers.resolve([{ _id: 'old-supplier', name: '旧供应商' }]); await task; await flush();
  assert.equal(f.calls.navigation.length, 0);
  assert.equal(f.page.data.suppliers.length, 0);
});
test('恢复前已打开进货SKU页的回调不能回填新进货单', async () => {
  const f = await fixture('purchase'); f.page.addGoods();
  f.calls.navigation[0].events.pick(selectedGoods(f));
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(f.calls.navigation.length, 2);
  await f.restore(); f.page.onShow(); await flush();
  f.calls.navigation[1].events.pickSku(f.item);
  assert.equal(f.page.data.lines.length, 0);
});
test('恢复账本后，旧商品选择回调不得再启动延迟SKU导航', async () => {
  const f = await fixture('purchase'); f.page.addGoods();
  await f.restore(); f.page.onShow(); await flush();
  f.calls.navigation[0].events.pick(selectedGoods(f));
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(f.calls.navigation.length, 1);
});

test('进货成功弹窗符合微信四字按钮限制，确认后打开已保存单据', async () => {
  const f = await fixture('purchase'), accepted = [];
  f.wx.showModal = options => {
    if (Array.from(options.confirmText || '').length > 4) {
      if (options.fail) options.fail({ errMsg: 'showModal:fail parameter error: confirmText length should not larger than 4' });
      return;
    }
    accepted.push(options);
  };
  merge(f, 'purchase'); f.page.doSubmit(); await flush(); await flush();
  assert.equal(accepted.length, 1);
  const orders = await f.all('purchase_orders');
  assert.equal(orders.length, 1);
  assert.equal(f.page.data.lines.length, 0);
  accepted[0].success({ confirm: true });
  assert.match(f.calls.navigation[0].url, new RegExp('id=' + orders[0]._id + '&type=purchase'));
});
for (const failure of ['callback', 'throw']) {
  test(`进货成功弹窗${failure}失败时提示已保存，避免诱导重提`, async () => {
    const f = await fixture('purchase');
    f.wx.showModal = options => {
      if (failure === 'throw') throw new Error('dialog unavailable');
      if (options.fail) options.fail({ errMsg: 'showModal:fail unavailable' });
    };
    merge(f, 'purchase'); f.page.doSubmit(); await flush(); await flush();
    assert.equal((await f.all('purchase_orders')).length, 1);
    assert.equal(f.page.data.lines.length, 0);
    assert.equal(f.page.data.submitting, false);
    assert.ok(f.calls.toast.some(x => /入库已保存/.test(x.title)));
    assert.equal(f.calls.toast.some(x => /入库失败/.test(x.title)), false);
  });
}
