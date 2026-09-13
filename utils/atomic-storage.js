// 库存、订单和流水暂存后一次提交；旧版分散存储保留，首次成功写入后以快照为准。
// 衣柜沿用历史存储键以读取已有库存和订单；这些兼容标识不是产品显示名称。
const SNAPSHOT_KEY = '__danjie_ledger_v2';
const RESTORE_BACKUP_KEY = '__danjie_before_restore_v2';
const COLLECTIONS = ['goods', 'customers', 'suppliers', 'sales_orders', 'purchase_orders', 'inventory_logs', 'settings'];
const PREFIX = '__lcloud_';
const providers = new WeakMap();
const { readStored, writeStored } = require('./snapshot-codec');
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function validate(state) {
  if (!state || state.version !== 2 || !state.collections || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || typeof state.openid !== 'string') {
    throw new Error('本地账本损坏或版本不兼容，请保留数据并恢复有效备份');
  }
  COLLECTIONS.forEach(name => { if (!Array.isArray(state.collections[name])) throw new Error('本地账本集合损坏：' + name); });
  return state;
}
function createAtomicStorage(raw) {
  if (providers.has(raw)) return providers.get(raw);
  let draft = null, dirty = false, queue = Promise.resolve();
  function read() {
    const saved = readStored(raw, SNAPSHOT_KEY);
    if (saved !== undefined && saved !== null && saved !== '') return validate(clone(saved));
    const state = { version: 2, collections: {}, sequence: 0, openid: raw.getStorageSync('cpos_openid') || '' };
    COLLECTIONS.forEach(name => {
      const value = raw.getStorageSync(PREFIX + name);
      if (value !== undefined && value !== null && value !== '' && !Array.isArray(value)) throw new Error('旧版账本集合损坏：' + name);
      state.collections[name] = clone(value || []);
    });
    const seq = raw.getStorageSync(PREFIX + '__seq');
    if (seq !== undefined && seq !== null && seq !== '') state.sequence = Number(seq);
    return validate(state);
  }
  function mapped(key) { return key === RESTORE_BACKUP_KEY || key === 'cpos_openid' || key === PREFIX + '__seq' || COLLECTIONS.indexOf(key.slice(PREFIX.length)) >= 0 && key.indexOf(PREFIX) === 0; }
  const api = {
    getStorageSync(key) {
      if (!mapped(key)) return raw.getStorageSync(key);
      const state = draft || read();
      if (key === RESTORE_BACKUP_KEY) return clone(state.beforeRestore);
      if (key === 'cpos_openid') return state.openid;
      if (key === PREFIX + '__seq') return state.sequence;
      return clone(state.collections[key.slice(PREFIX.length)]);
    },
    setStorageSync(key, value) {
      if (!mapped(key)) throw new Error('不支持的账本存储键：' + key);
      const state = draft || read();
      if (key === RESTORE_BACKUP_KEY) state.beforeRestore = clone(value);
      else if (key === 'cpos_openid') state.openid = value;
      else if (key === PREFIX + '__seq') state.sequence = value;
      else state.collections[key.slice(PREFIX.length)] = clone(value);
      validate(state);
      if (draft) dirty = true;
      else writeStored(raw, SNAPSHOT_KEY, clone(state));
    },
    getStorageInfoSync() { return { keys: COLLECTIONS.map(name => PREFIX + name).concat([PREFIX + '__seq', 'cpos_openid']) }; },
    transaction(callback) {
      const run = async () => {
        draft = read(); dirty = false;
        try {
          const result = await callback();
          if (dirty && !(result && result.success === false)) writeStored(raw, SNAPSHOT_KEY, clone(validate(draft)));
          return result;
        } finally { draft = null; dirty = false; }
      };
      const job = queue.then(run);
      queue = job.catch(() => {});
      return job;
    }
  };
  providers.set(raw, api);
  return api;
}
module.exports = { createAtomicStorage, SNAPSHOT_KEY, COLLECTIONS, RESTORE_BACKUP_KEY };
