const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page-runtime');
const { createLocalCloud } = require('../utils/localcloud');
const { createAtomicStorage } = require('../utils/atomic-storage');

// Run the real route producer, page, util and LocalCloud against isolated storage.
function fixture(t) {
  const values = new Map(), routes = [], toasts = [];
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] })
  };
  const atomic = createAtomicStorage(raw);
  atomic.setStorageSync('cpos_openid', 'statement-owner');
  const cloud = createLocalCloud(atomic);
  const app = { dataCloud: cloud, globalData: { openid: 'statement-owner' } };
  const wx = {
    ...raw, showToast: value => toasts.push(value.title),
    showActionSheet: options => options.success({ tapIndex: 0 }),
    navigateTo: options => routes.push(options)
  };
  const previousWx = global.wx, previousGetApp = global.getApp;
  global.wx = wx;
  global.getApp = () => app;
  const page = loadPage('statement', { app, wx });
  const customers = loadPage('customers', { app, wx });
  t.after(() => {
    page.onUnload();
    customers.onUnload();
    global.wx = previousWx;
    global.getApp = previousGetApp;
  });
  const order = async data => (await cloud.database().collection('sales_orders').add({ data: {
    openid: 'statement-owner', customerId: 'customer-1', customerName: '默认客户',
    orderNo: 'SALE-1', status: 'completed', createdAt: new Date(),
    amountDue: 125, received: 100, debt: 25, lines: [], ...data
  } }))._id;
  const open = async query => {
    const reload = page.reload.bind(page);
    let pending;
    page.reload = () => (pending = reload());
    try {
      page.onLoad(query);
      await pending;
    } finally { page.reload = reload; }
  };
  const openFromCustomer = async (id, name) => {
    customers.setData({ list: [{ _id: id, name }] });
    customers.goDetail({ currentTarget: { dataset: { id } } });
    // The native onLoad reproducer receives encoded parameter strings.
    // Keep them raw here; URLSearchParams would silently pre-decode the bug.
    const query = Object.fromEntries(routes.at(-1).url.split('?')[1].split('&').map(part => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator), part.slice(separator + 1)];
    }));
    await open(query);
  };
  return { page, order, open, openFromCustomer, toasts };
}

// Missing route decoding shows the encoded name on the customer statement.
test('客户档案查看订单流水后显示原始中文姓名并加载该客户流水', async t => {
  const f = fixture(t);
  const id = await f.order({ customerName: 'VS全程档案客户' });
  await f.openFromCustomer('customer-1', 'VS全程档案客户');
  assert.equal(f.page.data.customerName, 'VS全程档案客户');
  assert.equal(f.page.data.customerLabel, 'VS全程档案客户');
  assert.deepEqual(Array.from(f.page.data.list, item => item._id), [id]);
  assert.equal(f.page.data.summary.outstandingDebt, 25);
  assert.deepEqual(f.toasts, []);
});

// Repeated decoding would turn the customer's literal %20 into a space.
test('客户姓名中的字面百分号仅解码路由一层，保留 %20、加号和 &', async t => {
  const f = fixture(t);
  await f.order({ customerName: 'VS%20客户 & VIP+1' });
  await f.openFromCustomer('customer-1', 'VS%20客户 & VIP+1');
  assert.equal(f.page.data.customerName, 'VS%20客户 & VIP+1');
  assert.equal(f.page.data.customerLabel, 'VS%20客户 & VIP+1');
});

// Leaving the encoded id in the query silently produces an empty statement.
test('编码的客户 id 解码后用于实际订单筛选', async t => {
  const f = fixture(t);
  const id = await f.order({ customerId: '档案/50%/A+B', customerName: '王女士' });
  await f.order({ customerId: 'other-customer', customerName: '王女士' });
  await f.openFromCustomer('档案/50%/A+B', '王女士');
  assert.equal(f.page.data.customerId, '档案/50%/A+B');
  assert.deepEqual(Array.from(f.page.data.list, item => item._id), [id]);
});

// Fixing just the label would still use the encoded name in the business query.
test('未建档客户的编码姓名解码后能查询对应流水', async t => {
  const f = fixture(t);
  const id = await f.order({ customerId: '', customerName: '未建档张女士' });
  await f.order({ customerId: '', customerName: '未建档李女士' });
  await f.open({ customerName: encodeURIComponent('未建档张女士') });
  assert.equal(f.page.data.customerName, '未建档张女士');
  assert.deepEqual(Array.from(f.page.data.list, item => item._id), [id]);
});

// A throwing decoder must not break raw input or malformed percent sequences.
for (const name of ['原文王女士 + VIP', '会员100%', '客户%2G女士', '客户%E5%AE']) {
  test('原始 query 姓名 ' + name + ' 不崩溃且原样加载', async t => {
    const f = fixture(t);
    const id = await f.order({ customerId: '', customerName: name });
    await f.open({ customerName: name });
    assert.equal(f.page.data.customerName, name);
    assert.deepEqual(Array.from(f.page.data.list, item => item._id), [id]);
    assert.deepEqual(f.toasts, []);
  });
}

test('未携带 query 打开对账单时仍等待用户选择客户', async t => {
  const f = fixture(t);
  await f.open();
  assert.equal(f.page.data.customerId, '');
  assert.equal(f.page.data.customerName, '');
  assert.equal(f.page.data.customerLabel, '未选');
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.summary, null);
  assert.deepEqual(f.toasts, []);
});
