const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');
const wxml = require('./helpers/wxml-runtime');
const actual = require('../utils/util');

function harness(name, overrides = {}) {
  const calls = { navigation: [], back: 0, toast: [], submitted: [], emitted: [] };
  const app = { globalData: { openid: 'owner', settings: { defaultPayment: 'cash' } }, _resolveTheme: () => 'light' };
  const util = Object.assign({}, actual, {
    ensureOpenid: async () => 'owner', fetchSettings: async () => app.globalData.settings,
    listCollAll: async () => [], syncCustomers: async () => {},
    submitSale: async payload => { calls.submitted.push(payload); return { orderId: 'sale', amountDue: 100, received: 100 }; },
    submitPurchase: async payload => { calls.submitted.push(payload); return { orderId: 'purchase', totalAmount: 100 }; }
  }, overrides.util);
  const wx = Object.assign({
    showToast: value => calls.toast.push(value), showModal: () => {},
    setNavigationBarTitle: () => {}, navigateTo: value => { calls.navigation.push(value); },
    navigateBack: () => { calls.back++; }
  }, overrides.wx);
  if (!overrides.util || !overrides.util.db) util.db = () => wx.cloud.database();
  const page = loadPage(name, { app, wx, modules: { '../../utils/util.js': util } });
  page.getOpenerEventChannel = () => ({ emit: (event, value) => calls.emitted.push({ event, value }) });
  return { page, calls, app, wx };
}
function goods(id = 'dress', stock = 8) {
  return { _id: id, name: id, stock, costPrice: 35, price: 100, colors: ['红'], sizes: ['M'], skus: [{ key: '红-M', color: '红', size: 'M', stock, costPrice: 35, price: 100 }] };
}
function line(id = 'dress') {
  return { goodsId: id, name: id, skuKey: '红-M', color: '红', size: 'M', stock: 20, qty: 1, price: 100, unitCost: 35 };
}
function input(page, name, handler, value, index) {
  return wxml.event(page, name, { type: 'input', name: handler }, { value }, a => index === undefined || Number(a['data-index']) === index);
}
function tap(page, name, handler, where) {
  return wxml.event(page, name, { type: 'tap', name: handler }, {}, where);
}

test('SKU 进货可在零库存时输入 3 件、0 元进价，直接确认只回传一次', { skip: !wxml.available }, () => {
  const { page, calls } = harness('sku-picker');
  page.onLoad({ goodsJson: encodeURIComponent(JSON.stringify(goods('dress', 0))), mode: 'purchase' });
  tap(page, 'sku-picker', 'pickCell');
  input(page, 'sku-picker', 'onQtyInput', '3');
  input(page, 'sku-picker', 'onCostInput', '0');
  tap(page, 'sku-picker', 'confirm');
  page.confirm();
  assert.equal(calls.emitted.length, 1);
  assert.equal(calls.emitted[0].value.qty, 3);
  assert.equal(calls.emitted[0].value.unitCost, 0);
  assert.equal(calls.back, 1);
});
test('SKU 进货加号不受现有库存限制', () => {
  const { page } = harness('sku-picker');
  page.onLoad({ goodsJson: encodeURIComponent(JSON.stringify(goods('dress', 0))), mode: 'purchase' });
  page.pickCell({ currentTarget: { dataset: { key: '红·M' } } });
  page.stepQty({ currentTarget: { dataset: { delta: 1 } } });
  assert.equal(page.data.qty, 2);
});
test('SKU 销售不能确认零库存或超库存数量', () => {
  const { page, calls } = harness('sku-picker');
  page.onLoad({ goodsJson: encodeURIComponent(JSON.stringify(goods('dress', 0))), mode: 'cart' });
  page.pickCell({ currentTarget: { dataset: { key: '红·M' } } });
  page.confirm();
  assert.equal(calls.emitted.length, 0);
  assert.equal(calls.back, 0);
});
for (const value of ['', '0', '2.5']) {
  test(`SKU 数量 ${JSON.stringify(value)} 不得确认`, () => {
    const { page, calls } = harness('sku-picker');
    page.onLoad({ goodsJson: encodeURIComponent(JSON.stringify(goods())), mode: 'purchase' });
    page.pickCell({ currentTarget: { dataset: { key: '红·M' } } });
    page.setData({ qty: value });
    page.confirm();
    assert.equal(calls.emitted.length, 0);
  });
}
test('销售输入数量、价格和折扣后立即开单，提交本次输入值', { skip: !wxml.available }, async () => {
  const { page, calls } = harness('sale');
  page.mergeIntoCart(line());
  input(page, 'sale', 'onQtyInput', '3', 0);
  input(page, 'sale', 'onPriceInput', '12.50', 0);
  input(page, 'sale', 'onPctInput', '90');
  input(page, 'sale', 'onRemark', '试穿后购买');
  tap(page, 'sale', 'doSubmit');
  await flush();
  assert.equal(calls.submitted[0].lines[0].qty, 3);
  assert.equal(calls.submitted[0].lines[0].price, 12.5);
  assert.equal(calls.submitted[0].discountPct, 90);
  assert.equal(calls.submitted[0].received, 33.75);
  assert.equal(calls.submitted[0].remark, '试穿后购买');
});
test('进货输入数量和 0 元进价后立即确认，提交本次值', { skip: !wxml.available }, async () => {
  const { page, calls } = harness('purchase');
  page.mergeLine(line());
  input(page, 'purchase', 'onQtyInput', '4', 0);
  input(page, 'purchase', 'onCostInput', '0', 0);
  input(page, 'purchase', 'onRemark', '厂家赠品');
  tap(page, 'purchase', 'doSubmit');
  await flush();
  assert.equal(calls.submitted[0].lines[0].qty, 4);
  assert.equal(calls.submitted[0].lines[0].unitCost, 0);
  assert.equal(calls.submitted[0].remark, '厂家赠品');
});
for (const name of ['sale', 'purchase']) {
  test(`${name} 不同商品相同色码有独立列表 key，删除第一行不串值`, { skip: !wxml.available }, () => {
    const { page } = harness(name);
    const merge = name === 'sale' ? 'mergeIntoCart' : 'mergeLine';
    const key = name === 'sale' ? 'cart' : 'lines';
    page[merge](line('dress')); page[merge](line('pants'));
    assert.equal(new Set(page.data[key].map(x => x.lineKey)).size, 2);
    const template = fs.readFileSync(path.join(__dirname, '../pages', name, name + '.wxml'), 'utf8');
    assert.match(template, /wx:key="lineKey"/);
    tap(page, name, 'removeLine', a => Number(a['data-index']) === 0);
    assert.equal(page.data[key][0].goodsId, 'pants');
  });
  test(`${name} 提交期间冻结行和备注，防止成功后丢失新输入`, async () => {
    const result = deferred();
    const action = name === 'sale' ? 'submitSale' : 'submitPurchase';
    const { page } = harness(name, { util: { [action]: () => result.promise } });
    page[name === 'sale' ? 'mergeIntoCart' : 'mergeLine'](line());
    page.doSubmit();
    page.onRemark({ detail: { value: '新单备注' } });
    page.removeLine({ currentTarget: { dataset: { index: 0 } } });
    assert.equal(page.data.remark, '');
    assert.equal(page.data[name === 'sale' ? 'cart' : 'lines'].length, 1);
    result.reject(new Error('offline')); await flush();
  });
  test(`${name} 任何一行非法数量都阻止整单，不静默漏单`, () => {
    const { page, calls } = harness(name);
    const key = name === 'sale' ? 'cart' : 'lines';
    page.setData({ [key]: [line(), Object.assign(line('pants'), { qty: 0 })] });
    page.doSubmit();
    assert.equal(calls.submitted.length, 0);
  });
  test(`${name} 双击提交只写一次；失败重试复用 requestId`, async () => {
    const submitted = [], results = [deferred(), deferred()];
    const action = name === 'sale' ? 'submitSale' : 'submitPurchase';
    const { page } = harness(name, { util: { [action]: payload => { submitted.push(payload); return results[submitted.length - 1].promise; } } });
    page[name === 'sale' ? 'mergeIntoCart' : 'mergeLine'](line());
    page.doSubmit(); page.doSubmit();
    assert.equal(submitted.length, 1);
    results[0].reject(new Error('offline')); await flush();
    page.doSubmit();
    assert.equal(submitted[0].requestId, submitted[1].requestId);
    results[1].reject(new Error('offline')); await flush();
  });
}
test('销售选客户返回保留金额、实收和备注，选中客户正常提交', async () => {
  const { page, calls } = harness('sale');
  page.mergeIntoCart(line());
  page.onRemark({ detail: { value: '留货' } });
  page.onReceivedInput({ detail: { value: '50' } });
  page.pickCustomer();
  assert.match(calls.navigation[0].url, /from=picker/);
  calls.navigation[0].events.picked({ _id: 'customer', name: '顾客甲', phone: '13800000000' });
  page.onShow(); await flush();
  assert.equal(page.data.receivedStr, '50');
  assert.equal(page.data.remark, '留货');
  page.doSubmit(); await flush();
  assert.equal(calls.submitted[0].customerId, 'customer');
});
test('销售清空搜索后迟到结果不能重新出现', async () => {
  const result = deferred();
  const query = { where() { return this; }, orderBy() { return this; }, limit() { return this; }, get: () => result.promise };
  const { page } = harness('sale', { wx: { cloud: { database: () => ({ command: { and: x => x, or: x => x }, RegExp: x => x, collection: () => query }) } } });
  page.setData({ keyword: '旧款' });
  const task = page.doSearch('旧款'); await flush();
  page.clearKeyword();
  result.resolve({ data: [goods('旧款')] }); await task;
  assert.equal(page.data.searchList.length, 0);
});
test('进货选商品页面的条码搜索包含名称或条码并保留店主条件', async () => {
  let condition;
  const query = { where(value) { condition = value; return this; }, orderBy() { return this; }, skip() { return this; }, limit() { return this; }, get: async () => ({ data: [] }) };
  const db = { command: { and: x => ({ and: x }), or: x => ({ or: x }) }, RegExp: x => x, collection: () => query };
  const { page } = harness('goods-picker', { util: { listColl: async (_, options) => { condition = options.where; return []; } }, wx: { cloud: { database: () => db } } });
  page.setData({ keyword: '69012345' });
  await page.reload();
  assert.match(JSON.stringify(condition), /barcode/);
  assert.match(JSON.stringify(condition), /owner/);
});
test('选商品连续点击只发一次事件和返回一次', () => {
  const { page, calls } = harness('goods-picker');
  page.setData({ list: [goods()] });
  const event = { currentTarget: { dataset: { index: 0 } } };
  page.onPick(event); page.onPick(event);
  assert.equal(calls.emitted.length, 1);
  assert.equal(calls.back, 1);
});
test('进货选商品后立即退出，不得由延迟回调再弹规格页', async () => {
  const { page, calls } = harness('purchase');
  page.addGoods();
  calls.navigation[0].events.pick(Object.assign(goods(), { goodsId: 'dress' }));
  if (page.onUnload) page.onUnload();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(calls.navigation.length, 1);
});
for (const [name, handler] of [['sale', 'onPriceBlur'], ['purchase', 'onCostBlur']]) {
  test(`${name} 清空金额再失焦不能静默按 0 元提交`, async () => {
    const { page, calls } = harness(name);
    page[name === 'sale' ? 'mergeIntoCart' : 'mergeLine'](line());
    page[handler]({ detail: { value: '' }, currentTarget: { dataset: { index: 0 } } });
    page.doSubmit(); await flush();
    assert.equal(calls.submitted.length, 0);
  });
}
test('销售清空实收再失焦不得自动变成全额已收', async () => {
  const { page, calls } = harness('sale');
  page.mergeIntoCart(line());
  page.onReceivedInput({ detail: { value: '' } }); page.onReceivedBlur();
  page.doSubmit(); await flush();
  assert.equal(calls.submitted.length, 0);
  assert.equal(page.data.receivedStr, '');
});
test('SKU 明确设置 0 元售价时，选择后保持 0 元而非商品默认价', () => {
  const { page, calls } = harness('sku-picker');
  const item = goods(); item.skus[0].price = 0;
  page.onLoad({ goodsJson: encodeURIComponent(JSON.stringify(item)), mode: 'cart' });
  page.pickCell({ currentTarget: { dataset: { key: '红·M' } } });
  page.confirm();
  assert.equal(calls.emitted[0].value.price, 0);
});
test('商品查询乱序返回不混入前一个搜索的行或游标', async () => {
  const old = deferred(), latest = deferred(); let index = 0;
  const query = { where() { return this; }, orderBy() { return this; }, skip() { return this; }, limit() { return this; }, get() { return index++ === 0 ? old.promise : latest.promise; } };
  const { page } = harness('goods-picker', { wx: { cloud: { database: () => ({ command: { and: x => x, or: x => x }, RegExp: x => x, collection: () => query }) } } });
  page.setData({ keyword: '旧款' }); const first = page.reload(); await flush();
  page.setData({ keyword: '新款' }); const second = page.reload(); await flush();
  latest.resolve({ data: [goods('新款')] }); await second;
  old.resolve({ data: Array.from({ length: 20 }, () => goods('旧款')) }); await first;
  assert.equal(page.data.list.length, 1);
  assert.equal(page.data.list[0]._id, '新款');
  assert.equal(page.data.skip, 1);
  assert.equal(page.data.hasMore, false);
});
test('进货从选商品到规格返回，输入和供应商完整进入订单', { skip: !wxml.available }, async () => {
  const purchase = harness('purchase');
  purchase.page.setData({ suppliers: [{ _id: 'supplier', name: '衣厂' }] });
  tap(purchase.page, 'purchase', 'toggleSupplierPanel');
  tap(purchase.page, 'purchase', 'chooseSupplier', a => a['data-id'] === 'supplier');
  input(purchase.page, 'purchase', 'onRemark', '首次入库');
  tap(purchase.page, 'purchase', 'addGoods');
  const picker = harness('goods-picker');
  picker.page.setData({ list: [goods('dress', 0)] });
  picker.page.getOpenerEventChannel = () => ({ emit: (_, item) => purchase.calls.navigation[0].events.pick(item) });
  tap(picker.page, 'goods-picker', 'onPick');
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(picker.calls.back, 1);
  assert.equal(purchase.calls.navigation.length, 2);
  const route = new URL(purchase.calls.navigation[1].url, 'https://miniapp.test');
  const sku = harness('sku-picker');
  sku.page.getOpenerEventChannel = () => ({ emit: (_, item) => purchase.calls.navigation[1].events.pickSku(item) });
  sku.page.onLoad({ goodsJson: route.searchParams.get('goodsJson'), mode: 'purchase' });
  tap(sku.page, 'sku-picker', 'pickCell');
  input(sku.page, 'sku-picker', 'onQtyInput', '3');
  input(sku.page, 'sku-picker', 'onCostInput', '12.50');
  tap(sku.page, 'sku-picker', 'confirm');
  assert.equal(sku.calls.back, 1);
  purchase.page.onShow(); await flush();
  assert.equal(purchase.page.data.supplierName, '衣厂');
  assert.equal(purchase.page.data.totalAmountText, '37.50');
  tap(purchase.page, 'purchase', 'doSubmit'); await flush();
  assert.equal(purchase.calls.submitted[0].supplierId, 'supplier');
  assert.equal(purchase.calls.submitted[0].remark, '首次入库');
  assert.equal(purchase.calls.submitted[0].lines[0].qty, 3);
  assert.equal(purchase.calls.submitted[0].lines[0].unitCost, 12.5);
});
