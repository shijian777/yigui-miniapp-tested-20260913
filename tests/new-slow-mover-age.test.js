const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalCloud } = require('../utils/localcloud');
const { createAtomicStorage } = require('../utils/atomic-storage');

// Replace only device storage and freeze the reference clock. LocalCloud's real
// inventory, sales, return and slow-mover implementations run unchanged.
function fixture(t) {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const values = new Map();
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] })
  };
  const storage = createAtomicStorage(raw);
  storage.setStorageSync('cpos_openid', 'slow-owner');
  const cloud = createLocalCloud(storage);
  const ago = days => new Date(now - days * 86400000).toISOString();
  async function seed(collection, data) {
    const id = (await cloud.database().collection(collection).add({ data: { openid: 'slow-owner', ...data } }))._id;
    // Model legacy records with missing/invalid dates; collection.add normally
    // supplies a creation time when the imported value is empty.
    if (Object.hasOwn(data, 'createdAt')) {
      const key = '__lcloud_' + collection;
      const rows = storage.getStorageSync(key);
      rows.find(row => row._id === id).createdAt = data.createdAt;
      storage.setStorageSync(key, rows);
    }
    return id;
  }
  const goods = (data = {}) => seed('goods', {
    name: '测试衣服', unit: '件', stock: 2, costPrice: 10, price: 20,
    skus: [], createdAt: ago(120), ...data
  });
  const inbound = (goodsId, createdAt, data = {}) => seed('inventory_logs', {
    goodsId, type: 'purchase', action: 'in', qty: 2, skuKey: '', createdAt, ...data
  });
  const sale = (goodsId, createdAt, data = {}) => seed('sales_orders', {
    type: 'sale', status: 'completed', amountDue: 20, received: 20, debt: 0,
    lines: [{ goodsId, qty: 1, price: 20 }], createdAt, ...data
  });
  async function call(name, data) {
    const result = (await cloud.callFunction({ name, data })).result;
    assert.equal(result.success, true, result.message);
    return result;
  }
  const slow = async (thresholdDays = 90) => (await call('slowMover', { thresholdDays })).data;
  return { goods, inbound, sale, call, slow, ago };
}
const sku = (key = '白-M', stock = 2) => ({ key, color: key.split('-')[0], size: key.split('-')[1], stock, costPrice: 10, price: 20 });

// Treating every never-sold row as slow-moving misclassifies today's inventory.
for (const withSku of [true, false]) {
  test((withSku ? '有色码' : '无色码') + '新品今天首次进货不属于30天或90天滞销', async t => {
    const f = fixture(t);
    const id = withSku ? (await f.call('saveGoods', { goods: { name: '今日新品', price: 20, costPrice: 10, skus: [sku('白-M', 0)] } })).goodsId
      : await f.goods({ stock: 0, createdAt: f.ago(0) });
    await f.call('submitPurchase', { lines: [{ goodsId: id, skuKey: withSku ? '白-M' : '', qty: 2, unitCost: 10 }] });
    for (const threshold of [30, 90]) {
      const result = await f.slow(threshold);
      assert.equal(result.count, 0);
      assert.equal(result.totalStockQty, 0);
      assert.equal(result.totalStockValue, 0);
      assert.deepEqual(result.list, []);
    }
  });
}

test('今天建档时录入的期初库存不会立即变成90天滞销', async t => {
  const f = fixture(t);
  await f.call('saveGoods', { goods: { name: '新款期初库存', price: 20, costPrice: 10, skus: [sku()] } });
  assert.equal((await f.slow()).count, 0);
});

// A strict boundary or lack of a legacy fallback loses genuinely old stock.
for (const withSku of [true, false]) {
  test((withSku ? '有色码' : '无色码') + '旧记录没有入库流水时以建档年龄判断90天边界', async t => {
    const f = fixture(t), variants = withSku ? { skus: [sku()] } : {};
    await f.goods({ ...variants, name: '未满90天', createdAt: f.ago(89.99) });
    const boundary = await f.goods({ ...variants, name: '恰好90天', createdAt: f.ago(90) });
    const old = await f.goods({ ...variants, name: '120天未售', createdAt: f.ago(120) });
    await f.goods({ stock: 0, skus: withSku ? [sku('白-M', 0)] : [], createdAt: f.ago(200) });
    const result = await f.slow();
    assert.deepEqual(result.list.map(item => item.goodsId).sort(), [boundary, old].sort());
    assert.equal(result.totalStockQty, 4);
    assert.equal(result.totalStockValue, 40);
    assert.ok(result.list.every(item => item.isNeverSold && item.lastSaleAt === null));
  });
}

// Using the parent creation date or another SKU's receipt date ages a new SKU.
test('旧款内各色码按自己的首次入库日期判断，支持仅记录颜色尺码的入库流水', async t => {
  const f = fixture(t);
  const id = await f.goods({ createdAt: f.ago(365), stock: 4, skus: [sku('红-M'), sku('蓝-M')] });
  await f.inbound(id, f.ago(120), { skuKey: '红-M', color: '红', size: 'M' });
  await f.inbound(id, f.ago(1), { color: '蓝', size: 'M' });
  const result = await f.slow();
  assert.deepEqual(result.list.map(item => item.skuKey), ['红-M']);
  assert.equal(result.totalStockQty, 2);
  assert.equal(result.totalStockValue, 20);
});

for (const withSku of [true, false]) {
  test((withSku ? '有色码' : '无色码') + '首次入库比建档晚时采用入库年龄，后续补货不覆盖首次入库', async t => {
    const f = fixture(t), variants = withSku ? { skus: [sku()] } : {};
    const young = await f.goods({ ...variants, createdAt: f.ago(365) });
    await f.inbound(young, f.ago(1), { skuKey: withSku ? '白-M' : '' });
    const old = await f.goods({ ...variants, createdAt: f.ago(0) });
    await f.inbound(old, f.ago(120), { skuKey: withSku ? '白-M' : '' });
    await f.inbound(old, f.ago(1), { skuKey: withSku ? '白-M' : '' });
    assert.deepEqual((await f.slow()).list.map(item => item.goodsId), [old]);
  });
}

// Coercing null/empty/boolean to the epoch would fabricate decades of age.
for (const [label, value] of [['缺失', undefined], ['null', null], ['空值', ''], ['非法', 'not-a-date'], ['布尔值', true], ['未来', '2999-01-01']]) {
  test(label + '建档日期且没有有效入库证据时不声称有90天库存年龄', async t => {
    const f = fixture(t);
    await f.goods({ createdAt: value });
    await f.goods({ skus: [sku()], createdAt: value });
    assert.equal((await f.slow()).count, 0);
  });
}

test('有效入库流水可证明缺失建档时间的老库存年龄，其他账号和出库流水不能', async t => {
  const f = fixture(t);
  const old = await f.goods({ createdAt: null, skus: [sku()] });
  await f.inbound(old, f.ago(120), { skuKey: '白-M' });
  const unknown = await f.goods({ createdAt: null });
  await f.inbound(unknown, f.ago(120), { openid: 'other-owner' });
  await f.inbound(unknown, f.ago(120), { action: 'out', type: 'sale' });
  await f.inbound(unknown, f.ago(120), { qty: 0 });
  await f.inbound(unknown, null);
  await f.inbound(unknown, 'bad-date');
  assert.deepEqual((await f.slow()).list.map(item => item.goodsId), [old]);
});

// A fully returned sale is not an effective last sale, but it must not age new stock.
test('真实销售后整单退货：新品仍不入选，120天旧库存仍按原首次入库判断', async t => {
  const f = fixture(t);
  const fresh = (await f.call('saveGoods', { goods: { name: '今日新款', price: 20, costPrice: 10, skus: [sku()] } })).goodsId;
  const old = await f.goods({ name: '历史旧款', skus: [sku()] });
  await f.inbound(old, f.ago(120), { skuKey: '白-M' });
  for (const id of [fresh, old]) {
    const sold = await f.call('submitSale', { lines: [{ goodsId: id, skuKey: '白-M', qty: 1, price: 20 }], received: 20 });
    await f.call('returnSale', { orderId: sold.orderId });
  }
  const result = await f.slow();
  assert.deepEqual(result.list.map(item => item.goodsId), [old]);
  assert.equal(result.list[0].stock, 2);
  assert.equal(result.list[0].isNeverSold, true);
  assert.equal(result.list[0].lastSaleAt, null);
});

// Falling back to stock age for a sold item would ignore its recent effective sale.
test('有有效销售的库存仍按最后未退货销售日判断，最近退货单不重置日期', async t => {
  const f = fixture(t);
  const old = await f.goods();
  await f.sale(old, f.ago(100));
  await f.sale(old, f.ago(1), { status: 'returned' });
  const recent = await f.goods({ skus: [sku()] });
  await f.sale(recent, f.ago(100), { lines: [{ goodsId: recent, skuKey: '白-M', qty: 1 }] });
  await f.sale(recent, f.ago(5), { lines: [{ goodsId: recent, skuKey: '白-M', qty: 1 }] });
  const result = await f.slow();
  assert.deepEqual(result.list.map(item => item.goodsId), [old]);
  assert.equal(result.list[0].daysSince, 100);
  assert.equal(result.list[0].isNeverSold, false);
  assert.equal(result.list[0].lastSaleAt.getTime(), new Date(f.ago(100)).getTime());
});

test('有效销售记录的日期缺失或非法时不把它当成1970年的销售或从未售出', async t => {
  const f = fixture(t);
  for (const date of [undefined, null, '', 'bad-date', true]) {
    const id = await f.goods({ skus: [sku()] });
    await f.sale(id, date, { lines: [{ goodsId: id, skuKey: '白-M', qty: 1 }] });
  }
  assert.equal((await f.slow()).count, 0);
});
