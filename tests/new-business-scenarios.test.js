'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalCloud } = require('../utils/localcloud');
const { createAtomicStorage, SNAPSHOT_KEY, RESTORE_BACKUP_KEY } = require('../utils/atomic-storage');
const { readStored, writeStored } = require('../utils/snapshot-codec');
const { exportData, importData } = require('../utils/data-backup');

// Only the device storage boundary is replaced; transactions, business calculations,
// database queries, and backup encoding are the actual production implementations.
function fixture() {
  const values = new Map();
  let rejectWrite = () => false;
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync(key, value) { if (rejectWrite(key, value)) throw new Error('storage quota exceeded'); values.set(key, copy(value)); },
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] })
  };
  const atomic = createAtomicStorage(raw);
  atomic.setStorageSync('cpos_openid', 'scenario-owner');
  const cloud = createLocalCloud(atomic);
  const call = async (name, data) => (await cloud.callFunction({ name, data })).result;
  const all = async name => (await cloud.database().collection(name).limit(1000).get()).data;
  const goods = async (opts = {}) => {
    const stock = opts.stock === undefined ? 10 : opts.stock;
    const costPrice = opts.cost === undefined ? 40 : opts.cost;
    const price = opts.price === undefined ? 100 : opts.price;
    const result = await call('saveGoods', { goods: {
      name: opts.name || '女装衬衫', unit: '件', price, costPrice,
      skus: [{ key: '白-M', color: '白', size: 'M', stock, costPrice, price }]
    } });
    assert.equal(result.success, true, result.message);
    return result.goodsId;
  };
  return { raw, atomic, cloud, call, all, goods, reject: fn => { rejectWrite = fn; } };
}
const line = (goodsId, extras = {}) => ({ goodsId, skuKey: '白-M', color: '白', size: 'M', qty: 1, price: 100, unitCost: 40, ...extras });
const sell = (f, goodsId, extras = {}) => f.call('submitSale', { lines: [line(goodsId)], received: 100, requestId: 'sale-1', ...extras });
const ledger = f => readStored(f.raw, SNAPSHOT_KEY);


test('purchase, discounted credit sale, partial settlement, and return keep records and inventory aligned', async () => {
  const f = fixture(), id = await f.goods({ stock: 2 });
  const customerId = (await f.cloud.database().collection('customers').add({ data: { openid: 'scenario-owner', name: '张女士' } }))._id;
  const purchase = await f.call('submitPurchase', { lines: [line(id, { qty: 2, unitCost: 60 })], requestId: 'purchase-1' });
  assert.equal(purchase.totalAmount, 120);
  const sale = await sell(f, id, { lines: [line(id, { qty: 2, price: 99.99 })], discountPct: 90, erase: true, received: 100, customerId });
  assert.deepEqual([sale.amountDue, sale.change, sale.debt], [179, 0, 79]);
  const stored = (await f.all('sales_orders'))[0];
  assert.equal(stored.lines[0].cost, 50);
  assert.equal((await f.all('goods'))[0].stock, 2);
  const settled = await f.call('settleDebt', { orderId: sale.orderId, amount: 29, requestId: 'settle-1' });
  assert.deepEqual([settled.received, settled.debt], [129, 50]);
  assert.equal((await f.all('customers'))[0].totalDebt, 50);
  const returned = await f.call('returnSale', { orderId: sale.orderId, reason: '试穿不合适' });
  assert.equal(returned.success, true);
  assert.equal((await f.all('goods'))[0].stock, 4);
  assert.equal((await f.all('customers'))[0].totalDebt, 0);
  assert.equal((await f.all('sales_orders'))[0].status, 'returned');
  const logs = await f.all('inventory_logs');
  assert.deepEqual(logs.map(x => [x.type, x.qty]), [['initial', 2], ['purchase', 2], ['sale', 2], ['return', 2]]);
});

test('concurrent identical sale and purchase retries commit stock and logs once', async () => {
  const f = fixture(), id = await f.goods();
  const sales = await Promise.all([sell(f, id), sell(f, id), sell(f, id)]);
  assert.equal(new Set(sales.map(x => x.orderId)).size, 1);
  const payload = { lines: [line(id, { qty: 2 })], requestId: 'purchase-idempotent' };
  const purchases = await Promise.all([f.call('submitPurchase', payload), f.call('submitPurchase', payload)]);
  assert.equal(new Set(purchases.map(x => x.orderId)).size, 1);
  assert.equal((await f.all('goods'))[0].stock, 11);
  assert.equal((await f.all('sales_orders')).length, 1);
  assert.equal((await f.all('purchase_orders')).length, 1);
  assert.equal((await f.all('inventory_logs')).length, 3);
});

test('duplicate partial settlement is idempotent and a changed reuse is rejected', async () => {
  const f = fixture(), id = await f.goods();
  const sale = await sell(f, id, { received: 0, paymentMethod: 'credit' });
  const payload = { orderId: sale.orderId, amount: 30, requestId: 'settle-retry' };
  const responses = await Promise.all([f.call('settleDebt', payload), f.call('settleDebt', payload)]);
  assert.deepEqual(responses[0], responses[1]);
  const conflict = await f.call('settleDebt', { ...payload, amount: 40 });
  assert.equal(conflict.success, false);
  const order = (await f.all('sales_orders'))[0];
  assert.equal(order.received, 30);
  assert.equal(order.debt, 70);
  assert.equal(order.settleHistory.length, 1);
});

test('insufficient second sale line rolls back first line, order, logs, and sequence', async () => {
  const f = fixture(), a = await f.goods(), b = await f.goods({ stock: 0 });
  const before = ledger(f);
  const result = await sell(f, a, { lines: [line(a), line(b)] });
  assert.equal(result.success, false);
  assert.match(result.message, /库存不足/);
  assert.deepEqual(ledger(f), before);
});

test('invalid second purchase line rolls back stock and costs already staged for first line', async () => {
  const f = fixture(), id = await f.goods();
  const before = ledger(f);
  const result = await f.call('submitPurchase', { lines: [line(id, { unitCost: 88 }), line('missing')] });
  assert.equal(result.success, false);
  assert.deepEqual(ledger(f), before);
});

test('storage commit failure leaves the sale retryable without partial inventory changes', async () => {
  const f = fixture(), id = await f.goods();
  const before = ledger(f);
  f.reject(key => key === SNAPSHOT_KEY);
  await assert.rejects(sell(f, id), /quota/);
  assert.deepEqual(ledger(f), before);
  f.reject(() => false);
  assert.equal((await sell(f, id)).success, true);
  assert.equal((await f.all('goods'))[0].stock, 9);
  assert.equal((await f.all('sales_orders')).length, 1);
});

test('a return with a missing second product rolls back the first product restoration', async () => {
  const f = fixture(), a = await f.goods(), b = await f.goods();
  const sale = await sell(f, a, { lines: [line(a), line(b)] });
  await f.cloud.database().collection('goods').doc(b).remove();
  const before = ledger(f);
  const result = await f.call('returnSale', { orderId: sale.orderId });
  assert.equal(result.success, false);
  assert.deepEqual(ledger(f), before);
});

for (const [label, value] of [['fractional', 1.5], ['infinite', Infinity], ['blank', ''], ['negative', -1]]) {
  test('sale rejects ' + label + ' quantity instead of silently recording another quantity', async () => {
    const f = fixture(), id = await f.goods(), before = ledger(f);
    const result = await sell(f, id, { lines: [line(id, { qty: value })] });
    assert.equal(result.success, false);
    assert.deepEqual(ledger(f), before);
  });
}
for (const [label, value] of [['negative', -1], ['not a number', 'abc'], ['blank', '']]) {
  test('sale rejects ' + label + ' price instead of recording a free item', async () => {
    const f = fixture(), id = await f.goods(), before = ledger(f);
    const result = await sell(f, id, { lines: [line(id, { price: value })] });
    assert.equal(result.success, false);
    assert.deepEqual(ledger(f), before);
  });
  test('purchase rejects ' + label + ' cost instead of writing zero cost', async () => {
    const f = fixture(), id = await f.goods(), before = ledger(f);
    const result = await f.call('submitPurchase', { lines: [line(id, { unitCost: value })] });
    assert.equal(result.success, false);
    assert.deepEqual(ledger(f), before);
  });
}

test('zero cost replenishment and zero price sale remain valid intentional values', async () => {
  const f = fixture(), id = await f.goods({ stock: 0 });
  const purchase = await f.call('submitPurchase', { lines: [line(id, { unitCost: 0 })] });
  assert.equal(purchase.success, true);
  const sale = await sell(f, id, { lines: [line(id, { price: 0 })], received: 0 });
  assert.equal(sale.success, true);
  assert.equal(sale.amountDue, 0);
  assert.equal((await f.all('sales_orders'))[0].lines[0].cost, 0);
});

test('return after replenishment preserves the documented current average cost policy', async () => {
  const f = fixture(), id = await f.goods({ stock: 2, cost: 40 });
  const sale = await sell(f, id, { lines: [line(id, { qty: 2 })] });
  assert.equal((await f.call('submitPurchase', { lines: [line(id, { qty: 2, unitCost: 60 })] })).success, true);
  assert.equal((await f.call('returnSale', { orderId: sale.orderId })).success, true);
  const product = (await f.all('goods'))[0];
  assert.equal(product.stock, 4);
  // README documents that returns restore quantity without rewinding average cost.
  assert.equal(product.skus[0].costPrice, 60);
  assert.equal(product.costPrice, 60);
  const nextSale = await sell(f, id, { requestId: 'sale-after-return' });
  const order = (await f.all('sales_orders')).find(x => x._id === nextSale.orderId);
  assert.equal(order.lines[0].cost, 60);
});

test('backup export, overwrite, and pre-restore copy preserve a complete restorable ledger', async () => {
  const f = fixture(), id = await f.goods();
  await sell(f, id);
  const old = await exportData(f.raw);
  await sell(f, id, { requestId: 'sale-2' });
  await importData(f.raw, old.json, 'overwrite');
  assert.equal((await f.all('goods'))[0].stock, 9);
  assert.equal((await f.all('sales_orders')).length, 1);
  const undo = f.atomic.getStorageSync(RESTORE_BACKUP_KEY);
  assert.equal(undo.data.goods[0].stock, 8);
  await importData(f.raw, JSON.stringify(undo), 'overwrite');
  assert.equal((await f.all('sales_orders')).length, 2);
  assert.equal((await f.all('goods'))[0].stock, 8);
});

test('same backup merge is idempotent and conflicting merge preserves all existing records', async () => {
  const f = fixture(), id = await f.goods();
  const original = await exportData(f.raw);
  await importData(f.raw, original.json, 'merge');
  assert.equal((await f.all('goods')).length, 1);
  await sell(f, id);
  const before = ledger(f);
  await assert.rejects(importData(f.raw, original.json, 'merge'), /合并冲突/);
  assert.deepEqual(ledger(f), before);
});

test('backup commit failure preserves the old ledger and its undo snapshot', async () => {
  const f = fixture(), id = await f.goods();
  const exported = await exportData(f.raw);
  await sell(f, id);
  const before = ledger(f);
  f.reject(key => key === SNAPSHOT_KEY);
  await assert.rejects(importData(f.raw, exported.json, 'overwrite'), /quota/);
  assert.deepEqual(ledger(f), before);
});

test('chunked ledger write failure keeps the previous full version readable', () => {
  const f = fixture();
  const old = { note: '女装童装'.repeat(70000) }, next = { note: '换季进货'.repeat(80000) };
  writeStored(f.raw, 'chunk-scenario', old);
  f.reject(key => key === 'chunk-scenario');
  assert.throws(() => writeStored(f.raw, 'chunk-scenario', next), /quota/);
  assert.deepEqual(readStored(f.raw, 'chunk-scenario'), old);
  f.reject(() => false);
  writeStored(f.raw, 'chunk-scenario', next);
  assert.deepEqual(readStored(f.raw, 'chunk-scenario'), next);
});

test('purchase rejects a fractional clothing quantity without silently rounding it down', async () => {
  const f = fixture(), id = await f.goods(), before = ledger(f);
  const result = await f.call('submitPurchase', { lines: [line(id, { qty: 1.5 })] });
  assert.equal(result.success, false);
  assert.deepEqual(ledger(f), before);
});
for (const [field, value] of [['received', -1], ['received', 'abc'], ['received', ''], ['discountPct', 'abc'], ['discountPct', -1], ['discountPct', 101]]) {
  test('sale rejects invalid ' + field + ' ' + JSON.stringify(value) + ' before touching the ledger', async () => {
    const f = fixture(), id = await f.goods(), before = ledger(f);
    const result = await sell(f, id, { [field]: value });
    assert.equal(result.success, false);
    assert.deepEqual(ledger(f), before);
  });
}

test('customer payment is rounded to cents consistently with the saved debt', async () => {
  const f = fixture(), id = await f.goods();
  const result = await sell(f, id, { received: 12.345 });
  assert.equal(result.received, 12.35);
  assert.equal(result.debt, 87.65);
  assert.equal((await f.all('sales_orders'))[0].received, 12.35);
});

test('stale goods editor cannot overwrite stock changed by an intervening sale', async () => {
  const f = fixture(), id = await f.goods();
  const original = (await f.all('goods'))[0];
  await sell(f, id);
  const before = ledger(f);
  const result = await f.call('saveGoods', { goodsId: id, goods: { ...original, name: '新名称' }, expectedOriginalSkus: original.skus, expectedOriginalStock: original.stock });
  assert.equal(result.success, false);
  assert.match(result.message, /已变更/);
  assert.deepEqual(ledger(f), before);
});

test('removing a sold-out SKU with historical sales is rejected so those sales remain returnable', async () => {
  const f = fixture(), id = await f.goods({ stock: 1 });
  const sale = await sell(f, id);
  const product = (await f.all('goods'))[0], before = ledger(f);
  const result = await f.call('saveGoods', {
    goodsId: id,
    expectedOriginalSkus: product.skus, expectedOriginalStock: product.stock,
    goods: { ...product, skus: [{ key: '黑-L', color: '黑', size: 'L', stock: 0, costPrice: 40, price: 100 }] }
  });
  assert.equal(result.success, false);
  assert.deepEqual(ledger(f), before);
  assert.equal((await f.call('returnSale', { orderId: sale.orderId })).success, true);
});

test('unreferenced empty SKU may be removed while preserving other product fields', async () => {
  const f = fixture(), id = await f.goods({ stock: 0 });
  const product = (await f.all('goods'))[0];
  const result = await f.call('saveGoods', {
    goodsId: id, expectedOriginalSkus: product.skus, expectedOriginalStock: 0,
    goods: { ...product, skus: [{ key: '黑-L', color: '黑', size: 'L', stock: 0, costPrice: 40, price: 100 }] }
  });
  assert.equal(result.success, true, result.message);
  assert.equal((await f.all('goods'))[0].skus[0].key, '黑-L');
});

test('discount and rounding are reflected in product, color, and size sales totals', async () => {
  const f = fixture(), a = await f.goods(), b = await f.goods({ name: '童装外套' });
  await sell(f, a, { lines: [line(a, { price: 99.99 }), line(b, { price: 99.99 })], discountPct: 90, erase: true, received: 179 });
  const stats = (await f.call('stats', { startMs: 0, endMs: Date.now() + 86400000 })).data;
  assert.equal(stats.salesAmount, 179);
  assert.deepEqual(stats.topGoods.map(x => x.amount), [89.5, 89.5]);
  assert.equal(stats.colorBreakdown[0].amount, 179);
  assert.equal(stats.sizeBreakdown[0].amount, 179);
});

test('cent allocation across three sale lines has no extra or lost cent', async () => {
  const f = fixture(), a = await f.goods(), b = await f.goods(), c = await f.goods();
  await sell(f, a, { lines: [line(a, { price: 0.01 }), line(b, { price: 0.01 }), line(c, { price: 0.01 })], discountPct: 50, received: 0.02 });
  const stats = (await f.call('stats', {})).data;
  assert.deepEqual(stats.topGoods.map(x => x.amount), [0.01, 0.01, 0]);
  assert.equal(stats.salesAmount, 0.02);
});

test('anonymous customers with distinct phone numbers are not combined into one debt', async () => {
  const f = fixture(), id = await f.goods();
  await sell(f, id, { customerName: '李女士', customerPhone: '13800000001', received: 0 });
  await sell(f, id, { customerName: '李女士', customerPhone: '13800000002', received: 0, requestId: 'sale-2' });
  const debts = (await f.call('stats', { action: 'debtCustomers' })).data;
  assert.equal(debts.list.length, 2);
  assert.deepEqual(debts.list.map(x => x.totalDebt), [100, 100]);
  assert.equal(new Set(debts.list.map(x => x.customerKey)).size, 2);
  assert.equal(debts.totalDebt, 200);
});

test('independent LocalCloud instances sharing device storage cannot oversell the last item', async () => {
  const f = fixture(), id = await f.goods({ stock: 1 });
  const secondCloud = createLocalCloud(createAtomicStorage(f.raw));
  const outcomes = await Promise.all([
    sell(f, id),
    secondCloud.callFunction({ name: 'submitSale', data: { lines: [line(id)], received: 100, requestId: 'sale-other-page' } }).then(x => x.result)
  ]);
  assert.equal(outcomes.filter(x => x.success).length, 1);
  assert.equal((await f.all('goods'))[0].stock, 0);
  assert.equal((await f.all('sales_orders')).length, 1);
});

test('legacy collection data migrates to an atomic snapshot without altering stock or sequence', async () => {
  const values = new Map([
    ['cpos_openid', 'old-owner'], ['__lcloud___seq', 9],
    ['__lcloud_goods', [{ _id: 'legacy-product', openid: 'old-owner', name: '历史商品', stock: 3, costPrice: 20, price: 50 }]]
  ]);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = { getStorageSync: key => copy(values.get(key)), setStorageSync: (key, value) => values.set(key, copy(value)) };
  const cloud = createLocalCloud(createAtomicStorage(raw));
  const sold = (await cloud.callFunction({ name: 'submitSale', data: { lines: [{ goodsId: 'legacy-product', qty: 1, price: 50 }], received: 50 } })).result;
  assert.equal(sold.success, true, sold.message);
  const state = readStored(raw, SNAPSHOT_KEY);
  assert.equal(state.collections.goods[0].stock, 2);
  assert.equal(state.sequence, 11);
  assert.equal(values.get('__lcloud_goods')[0].stock, 3);
});

test('a damaged current snapshot is reported and never silently replaced by older collection data', async () => {
  const f = fixture();
  f.raw.setStorageSync('__lcloud_goods', [{ _id: 'outdated-product' }]);
  f.raw.setStorageSync(SNAPSHOT_KEY, { version: 2, collections: {}, sequence: 0, openid: 'scenario-owner' });
  const before = f.raw.getStorageSync(SNAPSHOT_KEY);
  await assert.rejects(f.call('login', {}), /账本集合损坏/);
  assert.deepEqual(f.raw.getStorageSync(SNAPSHOT_KEY), before);
});

test('missing data chunks are reported without treating the ledger as empty', () => {
  const f = fixture();
  writeStored(f.raw, 'chunk-missing', { note: '货品'.repeat(130000) });
  const index = f.raw.getStorageSync('chunk-missing');
  f.raw.removeStorageSync(index.keys[0]);
  assert.throws(() => readStored(f.raw, 'chunk-missing'), /分块缺失/);
  assert.deepEqual(f.raw.getStorageSync('chunk-missing'), index);
});

test('cross-device overwrite reassigns ownership while retaining order to product links', async () => {
  const first = fixture(), id = await first.goods();
  await sell(first, id);
  const backup = await exportData(first.raw);
  const second = fixture();
  second.atomic.setStorageSync('cpos_openid', 'new-device-owner');
  await importData(second.raw, backup.json, 'overwrite');
  const product = (await second.all('goods'))[0], order = (await second.all('sales_orders'))[0];
  assert.equal(product.openid, 'new-device-owner');
  assert.equal(order.openid, 'new-device-owner');
  assert.equal(order.lines[0].goodsId, product._id);
  assert.equal((await second.call('returnSale', { orderId: order._id })).success, true);
  assert.equal((await second.all('goods'))[0].stock, 10);
});

test('backup with duplicate ids is rejected without changing data or the previous restore copy', async () => {
  const f = fixture(), id = await f.goods();
  await sell(f, id);
  const parsed = JSON.parse((await exportData(f.raw)).json);
  parsed.data.goods.push({ ...parsed.data.goods[0] });
  parsed.counts.goods++;
  const before = ledger(f);
  await assert.rejects(importData(f.raw, JSON.stringify(parsed), 'overwrite'), /重复/);
  assert.deepEqual(ledger(f), before);
});

test('merge of new orders into an existing product is rejected when inventory attribution is ambiguous', async () => {
  const source = fixture(), id = await source.goods();
  const beforeSale = await exportData(source.raw);
  await sell(source, id);
  const incoming = JSON.parse((await exportData(source.raw)).json);
  // Deliberately leave product metadata unchanged: new order alone must still be blocked.
  incoming.data.goods = JSON.parse(beforeSale.json).data.goods;
  const target = fixture();
  await importData(target.raw, beforeSale.json, 'overwrite');
  const before = ledger(target);
  await assert.rejects(importData(target.raw, JSON.stringify(incoming), 'merge'), /库存是否已计入/);
  assert.deepEqual(ledger(target), before);
});
