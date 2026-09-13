const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/page-runtime');
const { createLocalCloud } = require('../utils/localcloud');
const { createAtomicStorage } = require('../utils/atomic-storage');

// Only device storage and the native page host are replaced. Search, util,
// ownership filtering, sorting and pagination use the real implementations.
function fixture(t) {
  const values = new Map();
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] })
  };
  const atomic = createAtomicStorage(raw);
  atomic.setStorageSync('cpos_openid', 'customer-owner');
  const cloud = createLocalCloud(atomic);
  const app = { dataCloud: cloud, globalData: { openid: 'customer-owner' } };
  const toasts = [];
  const wx = { ...raw, showToast: value => toasts.push(value.title) };
  const previousWx = global.wx, previousGetApp = global.getApp;
  global.wx = wx;
  global.getApp = () => app;
  const page = loadPage('customers', { app, wx });
  t.after(() => {
    page.onUnload();
    global.wx = previousWx;
    global.getApp = previousGetApp;
  });
  const add = async data => (await cloud.database().collection('customers').add({ data: {
    openid: 'customer-owner', name: '默认客户', phone: '', wechat: '', lastOrderAt: 1, ...data
  } }))._id;
  // Observe the actual debounced reload promise without replacing its behavior.
  const input = value => new Promise((resolve, reject) => {
    const reload = page.reload;
    page.reload = function () {
      page.reload = reload;
      const pending = reload.call(page);
      pending.then(resolve, reject);
      return pending;
    };
    page.onKeyword({ detail: { value } });
  });
  return { page, add, input, toasts };
}
const names = page => Array.from(page.data.list, row => row.name);

// Omitting any advertised field loses the customer when the name is unrelated.
for (const [label, keyword, match] of [
  ['姓名', '张女士', { name: '张女士（熟客）', phone: '13700000001', wechat: 'zhang_shop' }],
  ['电话', '1381234', { name: '王女士', phone: '13812345678', wechat: 'wang_shop' }],
  ['微信（忽略大小写）', 'SHOP_ALICE', { name: '李女士', phone: '13900000001', wechat: 'shop_alice88' }]
]) {
  test('输入' + label + '后自动重载并找到对应客户', { timeout: 3000 }, async t => {
    const f = fixture(t);
    await f.add(match);
    await f.add({ name: '无关客户', phone: '13600000001', wechat: 'other_account' });
    await f.input(keyword);
    assert.deepEqual(names(f.page), [match.name]);
    assert.equal(f.page.data.keyword, keyword);
    assert.equal(f.page.data.loading, false);
    assert.deepEqual(f.toasts, []);
  });
}

// Retaining an old predicate or omitting ownership would produce the wrong list.
test('清空搜索后恢复本人的全部客户并重置分页', { timeout: 3000 }, async t => {
  const f = fixture(t);
  await f.add({ name: '张女士', lastOrderAt: 1 });
  await f.add({ name: '王女士', lastOrderAt: 2 });
  await f.add({ name: '他人客户', openid: 'other-owner', lastOrderAt: 3 });
  await f.input('张女士');
  assert.deepEqual(names(f.page), ['张女士']);
  await f.input('');
  assert.deepEqual(names(f.page), ['王女士', '张女士']);
  assert.equal(f.page.data.skip, 2);
  assert.equal(f.page.data.hasMore, false);
});

// Removing regex escaping would match unrelated records or lose a literal match.
for (const [field, keyword, literal, distractor] of [
  ['name', '[VIP].+', '王[VIP].+女士', '王Vxxxx女士'],
  ['phone', '+86(021)', '+86(021)12345678', '8602112345678'],
  ['wechat', 'shop.a+b', 'shop.a+b_88', 'shopXaaab_88']
]) {
  test(field + ' 中的正则特殊字符按用户输入的字面值搜索', { timeout: 3000 }, async t => {
    const f = fixture(t);
    const wanted = await f.add({ name: '目标客户', [field]: literal });
    await f.add({ name: '相似客户', [field]: distractor });
    await f.input(keyword);
    assert.deepEqual(Array.from(f.page.data.list, row => row._id), [wanted]);
    assert.deepEqual(f.toasts, []);
  });
}

// An OR without the ownership AND would disclose another owner's matching rows.
test('姓名、电话和微信各分支均只返回当前 openid 的客户', { timeout: 3000 }, async t => {
  const f = fixture(t);
  for (const [field, name, time] of [['name', 'match姓名', 1], ['phone', '电话客户', 2], ['wechat', '微信客户', 3]]) {
    await f.add({ name, [field]: 'match', lastOrderAt: time });
    await f.add({ name: '他人' + name, [field]: 'match', openid: 'other-owner', lastOrderAt: time + 10 });
  }
  await f.input('match');
  assert.deepEqual(names(f.page), ['微信客户', '电话客户', 'match']);
  assert.ok(f.page.data.list.every(row => row.openid === 'customer-owner'));
});

// Filtering after pagination would omit matches; advancing incorrectly repeats
// rows, and reusing a prior skip loses the first result of a new keyword.
test('混合字段命中的45位客户按最近交易倒序分页且换词后从第一页开始', { timeout: 3000 }, async t => {
  const f = fixture(t);
  const ids = [];
  for (let i = 0; i < 45; i++) {
    const field = ['name', 'phone', 'wechat'][i % 3];
    ids.push(await f.add({ name: '客户' + i, [field]: 'needle' + i, lastOrderAt: i }));
  }
  await f.add({ name: '不匹配客户', lastOrderAt: 100 });
  await f.add({ name: 'needle外部客户', openid: 'other-owner', lastOrderAt: 101 });
  await f.input('needle');
  assert.equal(f.page.data.list.length, 20);
  assert.equal(f.page.data.hasMore, true);
  await f.page.fetchMore();
  assert.equal(f.page.data.list.length, 40);
  await f.page.fetchMore();
  assert.deepEqual(Array.from(f.page.data.list, row => row._id), ids.slice().reverse());
  assert.equal(f.page.data.skip, 45);
  assert.equal(f.page.data.hasMore, false);
  await f.input('needle44');
  assert.deepEqual(Array.from(f.page.data.list, row => row._id), [ids[44]]);
  assert.equal(f.page.data.skip, 1);
  assert.equal(f.page.data.hasMore, false);
  assert.deepEqual(f.toasts, []);
});
