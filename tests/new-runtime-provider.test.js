const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Native wx properties may be readonly or accessor-backed. Evaluate App and its
// real modules together; only the device storage and native cloud boundary differ.
function runtime({ accessor = true, failLocalInit = false } = {}) {
  const values = new Map(), calls = [], errors = [];
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const nativeCloud = Object.freeze({
    init() { calls.push('init'); },
    database() { calls.push('database'); throw new Error('native cloud used'); },
    callFunction() { calls.push('callFunction'); return Promise.reject(new Error('native cloud used')); }
  });
  const wx = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
    getSystemInfoSync: () => ({ theme: 'light' })
  };
  Object.defineProperty(wx, 'cloud', accessor ? { get: () => nativeCloud } : { value: nativeCloud, writable: false });
  let app;
  const context = vm.createContext({ wx, getApp: () => app, getCurrentPages: () => [], App: value => { app = value; },
    Date, Promise, Map, Set, WeakMap, setTimeout, clearTimeout,
    console: { log() {}, error(...args) { errors.push(args); } }
  });
  const modules = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (!path.extname(file)) file += '.js';
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const requireLocal = request => {
      if (failLocalInit && /localcloud/.test(request)) throw new Error('forced local init failure');
      return load(path.resolve(path.dirname(file), request));
    };
    const wrapper = vm.runInContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})', context, { filename: file });
    wrapper(requireLocal, module, module.exports);
    return module.exports;
  }
  load('app.js');
  app.onLaunch();
  return { app, util: load('utils/util.js'), wx, nativeCloud, calls, errors };
}

for (const accessor of [true, false]) {
  test((accessor ? 'getter-only' : 'readonly') + ' wx.cloud does not receive local-mode initialization, database, or function calls', async () => {
    const r = runtime({ accessor });
    assert.equal(r.calls.length, 0, 'local mode must not initialize native cloud');
    const openid = await r.util.ensureOpenid();
    assert.ok(openid.startsWith('local-'));
    const created = await r.util.callFn('saveGoods', { goods: {
      name: '微信模拟器女装', price: 99, costPrice: 35,
      skus: [{ key: '红-M', color: '红', size: 'M', stock: 3, price: 99, costPrice: 35 }]
    } });
    const saved = await r.util.getDocById('goods', created.goodsId);
    assert.equal(saved.name, '微信模拟器女装');
    const sale = await r.util.submitSale({ lines: [{ goodsId: saved._id, skuKey: '红-M', color: '红', size: 'M', qty: 2, price: 99 }], discountPct: 90, received: 100 });
    assert.equal(sale.amountDue, 178.2);
    assert.equal(sale.debt, 78.2);
    assert.equal((await r.util.getDocById('goods', saved._id)).stock, 1);
    const stats = await r.util.fetchStats({});
    assert.equal(stats.data.salesCount, 1);
    assert.equal(stats.data.salesAmount, 178.2);
    assert.equal((await r.util.db().collection('sales_orders').get()).data.length, 1);
    assert.equal(r.calls.length, 0);
    assert.equal(r.wx.cloud, r.nativeCloud);
  });
}

test('local provider initialization failure is explicit and never falls back to native cloud', async () => {
  const r = runtime({ failLocalInit: true });
  await assert.rejects(r.util.ensureOpenid(), /forced local init failure/);
  await assert.rejects(r.util.callFn('saveGoods', {}), /forced local init failure/);
  assert.throws(() => r.util.db(), /forced local init failure/);
  assert.equal(r.calls.length, 0);
});
