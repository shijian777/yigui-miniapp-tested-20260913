// utils/util.js —— 公共工具：日期/金额/云数据库访问/登录与设置缓存
// 隔离规则：所有集合数据都带显式 openid 字段（云函数写入时用 wxContext.OPENID），
// 客户端查询也会带 where openid；集合权限再设"仅创建者可读写"做第二层兜底。

const PAYMENT_TEXT = { cash: '现金', wechat: '微信', alipay: '支付宝', credit: '记账欠款' };
const ORDER_TYPE_TEXT = { sale: '销售', purchase: '进货', return: '退货' };

const SETTINGS_DEFAULTS = {
  storeName: '我的服装店',
  phone: '',
  address: '',
  receiptNote: '谢谢惠顾，欢迎再次光临！',
  defaultPayment: 'cash',
  lowStockThreshold: 5,
  showQrPlaceholder: false
};

/* ---------------- 基础工具 ---------------- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Date / 时间戳 -> 本地 'YYYY-MM-DD'
function fmtDate(d) {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}
// -> 'YYYY-MM-DD HH:mm'
function fmtDateTime(d) {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  return fmtDate(t) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}
function todayStr() { return fmtDate(new Date()); }
// 给 'YYYY-MM-DD' 加/减 n 天
function addDays(dateStr, n) {
  const t = new Date(dateStr + 'T00:00:00');
  t.setDate(t.getDate() + n);
  return fmtDate(t);
}
// 把 [start, end]('YYYY-MM-DD'，含首尾) 转成毫秒区间 [startMs, endMs)
function rangeMs(startStr, endStr) {
  const s = new Date(startStr + 'T00:00:00');
  const e = new Date(endStr + 'T00:00:00');
  return { startMs: s.getTime(), endMs: e.getTime() + 24 * 3600 * 1000 };
}

function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
// 金额显示：保留两位（小票与列表统一口径）
function fmtMoney(n) { return round2(n).toFixed(2); }
// 输入框字符串 -> number
function toNum(v, dflt) {
  const n = Number(v);
  return isFinite(n) && v !== '' && v !== null && v !== undefined ? n : (dflt === undefined ? 0 : dflt);
}
function escReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function paymentText(m) { return PAYMENT_TEXT[m] || '现金'; }
function orderTypeText(t) { return ORDER_TYPE_TEXT[t] || t; }

/* ---------------- SKU（色码）辅助 ---------------- */
// 生成 SKU 唯一 key：颜色-尺码
function skuKey(color, size) { return (color || '') + '-' + (size || ''); }
// 从 colors 数组和 sizes 数组构造全套 SKU（含 0 库存占位）
function buildSkus(colors, sizes, defaults) {
  const cs = Array.isArray(colors) ? colors : [];
  const ss = Array.isArray(sizes) ? sizes : [];
  const def = defaults || {};
  const costPrice = Number(def.costPrice) || 0;
  const price = Number(def.price) || 0;
  const skus = [];
  if (cs.length === 0 && ss.length === 0) {
    // 单 SKU（无颜色无尺码）
    skus.push({ key: skuKey('', ''), color: '', size: '', stock: 0, costPrice: costPrice, price: price });
  } else if (cs.length === 0) {
    // 只有尺码
    ss.forEach((s) => skus.push({ key: skuKey('', s), color: '', size: s, stock: 0, costPrice: costPrice, price: price }));
  } else if (ss.length === 0) {
    // 只有颜色
    cs.forEach((c) => skus.push({ key: skuKey(c, ''), color: c, size: '', stock: 0, costPrice: costPrice, price: price }));
  } else {
    cs.forEach((c) => ss.forEach((s) => skus.push({ key: skuKey(c, s), color: c, size: s, stock: 0, costPrice: costPrice, price: price })));
  }
  return skus;
}
// 从 SKU 列表汇总总库存
function skuTotalStock(skus) {
  if (!Array.isArray(skus)) return 0;
  return skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
}
function skuNonEmptyCount(skus) {
  if (!Array.isArray(skus)) return 0;
  return skus.filter((x) => (Number(x.stock) || 0) > 0).length;
}
// 按 key 找 SKU
function findSku(skus, color, size) {
  if (!Array.isArray(skus)) return null;
  const k = skuKey(color, size);
  return skus.find((x) => x.key === k) || null;
}
// 在 SKU 列表里查找/创建/更新（返回新数组）
function upsertSku(skus, color, size, patch) {
  const k = skuKey(color, size);
  const idx = skus.findIndex((x) => x.key === k);
  const cur = idx >= 0 ? skus[idx] : { key: k, color: color || '', size: size || '', stock: 0, costPrice: 0, price: 0 };
  const next = Object.assign({}, cur, patch || {});
  if (idx >= 0) {
    const arr = skus.slice();
    arr[idx] = next;
    return arr;
  }
  return skus.concat([next]);
}

// Promise 化微信 API（wx 原生 API 均可传 callback，这里转成 Promise 便于 async/await）
function wxP(fn, opts) {
  return new Promise((resolve, reject) => {
    fn(Object.assign({}, opts || {}, {
      success: (res) => resolve(res),
      fail: (err) => reject(err)
    }));
  });
}

/* ---------------- 登录与 openid ---------------- */
function getDataCloud() {
  const app = getApp();
  if (app.dataCloudError) throw new Error(app.dataCloudError);
  const provider = app.dataCloud;
  if (!provider || typeof provider.database !== 'function' || typeof provider.callFunction !== 'function') {
    throw new Error('数据服务尚未初始化，请重新打开小程序');
  }
  return provider;
}
let loginPromise = null;
function ensureOpenid() {
  const app = getApp();
  let provider;
  try { provider = getDataCloud(); } catch (e) { return Promise.reject(e); }
  if (app.globalData.openid) return Promise.resolve(app.globalData.openid);
  if (!loginPromise) {
    loginPromise = provider.callFunction({ name: 'login' }).then((res) => {
      const r = res.result || {};
      if (!r.success || !r.openid) throw new Error(r.message || '获取登录态失败');
      app.globalData.openid = r.openid;
      try { wx.setStorageSync('cpos_openid', r.openid); } catch (e) { /* ignore */ }
      return r.openid;
    }).catch((err) => {
      loginPromise = null;
      throw err;
    });
  }
  return loginPromise;
}

function db() { return getDataCloud().database(); }
function cmd() { return db().command; }

// 新增文档：自动带 openid + createdAt
async function addDoc(collection, data) {
  const openid = await ensureOpenid();
  const payload = Object.assign({}, data, {
    openid: openid,
    createdAt: data.createdAt || new Date()
  });
  const res = await db().collection(collection).add({ data: payload });
  return res._id;
}
// 更新文档（只允许改自己的：集合权限兜底，另加 openid 条件）
async function updateDocById(collection, id, data) {
  await ensureOpenid();
  const openid = getApp().globalData.openid;
  const payload = Object.assign({}, data, { updatedAt: new Date() });
  const res = await db().collection(collection)
    .where({ _id: id, openid: openid })
    .update({ data: payload });
  return res.stats.updated;
}
// 删除文档
async function removeDocById(collection, id) {
  await ensureOpenid();
  const openid = getApp().globalData.openid;
  const res = await db().collection(collection)
    .where({ _id: id, openid: openid })
    .remove();
  return res.stats.removed;
}
// 按 _id 取自己的文档
async function getDocById(collection, id) {
  await ensureOpenid();
  const openid = getApp().globalData.openid;
  const res = await db().collection(collection)
    .where({ _id: id, openid: openid })
    .limit(1)
    .get();
  return res.data.length ? res.data[0] : null;
}
// 分页列表：where 允许含 db.command 值；openid 由这里自动并入（防御双保险）
async function listColl(collection, opt) {
  const o = opt || {};
  await ensureOpenid();
  const openid = getApp().globalData.openid;
  const where = Object.assign({}, o.where || {}, { openid: openid });
  let q = db().collection(collection).where(where);
  if (o.orderBy) q = q.orderBy(o.orderBy, o.order || 'desc');
  const res = await q.skip(o.skip || 0).limit(o.limit || 20).get();
  return res.data;
}
// 全量拉取直到最后一页，避免超过 1000 条时静默漏数据。
async function listCollAll(collection, opt) {
  const out = [];
  let skip = 0;
  while (true) {
    const part = await listColl(collection, Object.assign({}, opt, { skip: skip, limit: 20 }));
    out.push.apply(out, part);
    if (part.length < 20) break;
    skip += 20;
  }
  return out;
}
async function countColl(collection, where) {
  await ensureOpenid();
  const openid = getApp().globalData.openid;
  const w = Object.assign({}, where || {}, { openid: openid });
  const res = await db().collection(collection).where(w).count();
  return res.total;
}
// 通用云函数调用：统一错误提示文案
async function callFn(name, data) {
  try {
    const res = await getDataCloud().callFunction({ name: name, data: data || {} });
    const r = res.result || {};
    if (!r.success) throw new Error(r.message || '操作失败，请重试');
    return r;
  } catch (e) {
    if (e && e.message) throw e;
    throw new Error('网络异常或云函数未部署（' + name + '），请检查 README 部署步骤');
  }
}
/* 云函数统一包装（提交销售/进货/退货/统计） */
function submitSale(data) { return callFn('submitSale', data); }
function submitPurchase(data) { return callFn('submitPurchase', data); }
function returnSale(data) { return callFn('returnSale', data); }
function settleDebt(data) { return callFn('settleDebt', data); }
function fetchStats(data) { return callFn('stats', data); }
function migrateSku(data) { return callFn('migrateSku', data || {}); }
function syncCustomers(data) { return callFn('stats', Object.assign({}, data || {}, { action: 'syncCustomers' })); }
function fetchDebtCustomers(data) { return callFn('stats', Object.assign({}, data || {}, { action: 'debtCustomers' })); }
function fetchDebts(data) { return callFn('stats', Object.assign({}, data || {}, { action: 'debts' })); }

/* ---------------- 设置 ---------------- */
let settingsPromise = null;
// 读取当前老板的设置；不存在则自动建一份默认文档（settings 集合单文档）
function fetchSettings(force) {
  const app = getApp();
  if (app.globalData.settings && !force) return Promise.resolve(app.globalData.settings);
  if (!force && settingsPromise) return settingsPromise;
  const revision = Number(app.globalData.dataRevision) || 0;
  const request = ensureOpenid().then(async () => {
    if (revision !== (Number(app.globalData.dataRevision) || 0)) return fetchSettings();
    const openid = app.globalData.openid;
    const res = await db().collection('settings').where({ openid: openid }).limit(1).get();
    if (revision !== (Number(app.globalData.dataRevision) || 0)) return fetchSettings();
    let doc = res.data.length ? res.data[0] : null;
    if (!doc) {
      const id = await addDoc('settings', Object.assign({}, SETTINGS_DEFAULTS, {
        updatedAt: new Date()
      }));
      const got = await getDocById('settings', id);
      doc = got;
    }
    if (revision !== (Number(app.globalData.dataRevision) || 0)) return fetchSettings();
    const merged = Object.assign({}, SETTINGS_DEFAULTS, doc || {});
    merged._id = doc ? doc._id : '';
    app.globalData.settings = merged;
    return merged;
  }).catch((e) => {
    if (settingsPromise === request) settingsPromise = null;
    throw e;
  });
  settingsPromise = request;
  return request;
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据备份与恢复（防"清理缓存/换手机/误删"导致数据丢失）
// 设计：把 LocalCloud 的所有 collection 连同自增 __seq 一起打包成 JSON。
//       导入时按 collection 名原样写回 wx.storage，覆盖前自动备份当前数据为 .bak。
//       不动 settings 单文档与 openid 等账号信息。
// ═══════════════════════════════════════════════════════════════════════════
function exportAllData() {
  return require('./data-backup').exportData(wx);
}
async function importAllData(jsonText, mode) {
  await ensureOpenid();
  const result = await require('./data-backup').importData(wx, jsonText, mode);
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.settings = null;
    app.globalData.dataRevision = (Number(app.globalData.dataRevision) || 0) + 1;
  }
  settingsPromise = null;
  return result;
}
function exportBeforeRestore() {
  const { createAtomicStorage, RESTORE_BACKUP_KEY } = require('./atomic-storage');
  const api = createAtomicStorage(wx);
  return api.transaction(() => {
    const backup = api.getStorageSync(RESTORE_BACKUP_KEY);
    if (!backup) throw new Error('暂无恢复前备份');
    return JSON.stringify(backup);
  });
}
let requestSequence = 0;
function operationRequestId(page, action, payload) {
  const fingerprint = JSON.stringify(payload);
  if (!page._operationRequests) page._operationRequests = {};
  const existing = page._operationRequests[action];
  if (existing && existing.fingerprint === fingerprint) return existing.id;
  const id = action + '_' + Date.now().toString(36) + '_' + (++requestSequence).toString(36) + '_' + Math.random().toString(36).slice(2);
  page._operationRequests[action] = { fingerprint: fingerprint, id: id };
  return id;
}
function clearOperationRequest(page, action) {
  if (page._operationRequests) delete page._operationRequests[action];
}

function buildBackupFilename() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return 'clothing-pos-backup-' +
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.json';
}

module.exports = {
  SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
  pad2: pad2,
  fmtDate: fmtDate,
  fmtDateTime: fmtDateTime,
  todayStr: todayStr,
  addDays: addDays,
  rangeMs: rangeMs,
  round2: round2,
  fmtMoney: fmtMoney,
  toNum: toNum,
  escReg: escReg,
  paymentText: paymentText,
  orderTypeText: orderTypeText,
  // SKU
  skuKey: skuKey,
  buildSkus: buildSkus,
  skuTotalStock: skuTotalStock,
  skuNonEmptyCount: skuNonEmptyCount,
  findSku: findSku,
  upsertSku: upsertSku,
  wxP: wxP,
  getDataCloud: getDataCloud,
  ensureOpenid: ensureOpenid,
  db: db,
  cmd: cmd,
  addDoc: addDoc,
  updateDocById: updateDocById,
  removeDocById: removeDocById,
  getDocById: getDocById,
  listColl: listColl,
  listCollAll: listCollAll,
  countColl: countColl,
  callFn: callFn,
  submitSale: submitSale,
  submitPurchase: submitPurchase,
  returnSale: returnSale,
  settleDebt: settleDebt,
  fetchStats: fetchStats,
  fetchDebts: fetchDebts,
  fetchDebtCustomers: fetchDebtCustomers,
  migrateSku: migrateSku,
  syncCustomers: syncCustomers,
  fetchSettings: fetchSettings,
  exportAllData: exportAllData,
  exportBeforeRestore: exportBeforeRestore,
  operationRequestId: operationRequestId,
  clearOperationRequest: clearOperationRequest,
  importAllData: importAllData,
  buildBackupFilename: buildBackupFilename,
  COLLECTIONS: ['goods', 'suppliers', 'sales_orders', 'purchase_orders', 'inventory_logs', 'settings', 'customers']
};
