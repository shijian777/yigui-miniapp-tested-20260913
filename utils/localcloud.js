// utils/localcloud.js
// ═══════════════════════════════════════════════════════════════════════════
// 本地云开发模拟层（LocalCloud）
// 用途：通过 App.dataCloud 为离线设备提供数据库和业务操作。
// 页面统一经 util.db()/callFn() 访问，避免覆盖微信原生只读 wx.cloud。
//
// 实现范围（与 9 个云函数逻辑逐一对齐）：
//   database()  →  where/orderBy/limit/skip/get/add/update/count/doc().get/update + command + RegExp
//   callFunction→  login / submitSale / submitPurchase / returnSale / settleDebt
//                 / stats(含 syncCustomers/debtCustomers/debts) / slowMover / statement / migrateSku
// 数据落地：wx.setStorageSync('__lcloud_<col>__', [...])，兼容真机与模拟器。
// ═══════════════════════════════════════════════════════════════════════════

// 每个实例独立持有 storage，供设备 wx 和服务端事务快照共用同一业务引擎。
function createLocalCloud(storageAPI) {
const storage = storageAPI || require('./atomic-storage').createAtomicStorage(wx);
let pending = Promise.resolve();
function enqueue(run) {
  const result = pending.then(() => typeof storage.transaction === 'function' ? storage.transaction(run) : run());
  pending = result.catch(() => {});
  return result;
}
function queueTerminals(target, methods) {
  methods.forEach((name) => {
    const operation = target[name];
    target[name] = function (...args) { return enqueue(() => operation.apply(target, args)); };
  });
  return target;
}

// ---------- 基础工具 ----------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function round2(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function toNum(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function inputNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}
function skuCost(value, fallback) {
  return round2(value === undefined || value === null || !isFinite(Number(value)) ? fallback : Number(value));
}
function genOrderNo(prefix) {
  const d = new Date();
  return prefix + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
    Math.floor(Math.random() * 90 + 10);
}
function makeSkuKey(color, size) {
  // 与 utils/util.js 的 skuKey() 保持同一格式（颜色-尺码）。历史数据可能存在 '·' 分隔，
  // 匹配处一律配合 matchSku() 按颜色+尺码兜底，不要只比对 key。
  return String(color || '') + '-' + String(size || '');
}
// 宽容匹配 SKU：先按 key 精确匹配，再按 颜色+尺码 匹配（空值视作「默认」）
// 兼容三类历史数据：'-' 键（buildSkus）、'·' 键（旧版/迁移）、缺 color/size 的空规格
function matchSku(skus, skuKey, color, size) {
  const k = String(skuKey || '').trim();
  if (k) {
    const i = skus.findIndex((s) => s.key === k);
    if (i >= 0) return i;
  }
  const c = String(color || '').trim() || '默认';
  const z = String(size || '').trim() || '默认';
  const norm = (v) => (String(v || '').trim() || '默认');
  return skus.findIndex((s) => norm(s.color) === c && norm(s.size) === z);
}
function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function fmtDt(d) {
  if (!d) return '';
  const x = (d instanceof Date) ? d : new Date(d);
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate()) +
    ' ' + pad2(x.getHours()) + ':' + pad2(x.getMinutes());
}
function nowStr() {
  const d = new Date();
  return fmtDt(d) + ':' + pad2(d.getSeconds());
}

const PAYMENT_TEXT = { cash: '现金', wechat: '微信', alipay: '支付宝', credit: '记账欠款' };

// ---------- storage 读写（集合级） ----------
const STORE_PREFIX = '__lcloud_';
function readColl(name) {
  const v = storage.getStorageSync(STORE_PREFIX + name);
  return Array.isArray(v) ? v : [];
}
function writeColl(name, arr) {
  storage.setStorageSync(STORE_PREFIX + name, arr);
}
function nextId() {
  // 自增主键，_id 形如 "lcf-XXXXXXXX"
  const cnt = Number(storage.getStorageSync(STORE_PREFIX + '__seq') || 0) + 1;
  storage.setStorageSync(STORE_PREFIX + '__seq', cnt);
  return 'lcf-' + (Date.now().toString(36)) + '-' + cnt;
}

// ---------- command 模拟（db.command.xxx） ----------
// 产生 { __cmd: 'xxx', value }，由 matchesOp 解释；and/or 组合另当别论。
// 支持链式：_.gte(x).and(_.lt(y)) / _.gte(x).or(_.eq(y)) —— 并转化成 {__and:[...]}/{__or:[...]}
function makeCmd(op, value) {
  const c = { __cmd: op, value: value };
  c.and = function (other) {
    // 若 other 是 __and 数组则展开；否则单值
    const arr = (other && other.__and) ? other.__and.slice() : [other];
    return { __and: [c].concat(arr) };
  };
  c.or = function (other) {
    const arr = (other && other.__or) ? other.__or.slice() : [other];
    return { __or: [c].concat(arr) };
  };
  return c;
}
function compareCmd(op, a, b) {
  if (op === 'in') return Array.isArray(b) && b.some((value) => compareCmd('eq', a, value));
  // storage/HTTP 序列化把 Date 转为 ISO 文本；按时间值与 Date 条件比较。
  if (a instanceof Date || b instanceof Date) {
    a = a instanceof Date ? a.getTime() : (typeof a === 'string' ? Date.parse(a) : a);
    b = b instanceof Date ? b.getTime() : (typeof b === 'string' ? Date.parse(b) : b);
  }
  switch (op) {
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'eq': return a === b;
    case 'neq': return a !== b;
    default: return a === b;
  }
}
function isCmd(v) { return v && typeof v === 'object' && v.__cmd; }
function isAnd(v) { return v && typeof v === 'object' && v.__and; }
function isOr(v) { return v && typeof v === 'object' && v.__or; }
function isExists(v) { return v && typeof v === 'object' && typeof v.__exists === 'boolean'; }
function isReglike(v) { return v && typeof v === 'object' && v.__regexp !== undefined; }

function matchValue(fieldVal, cond) {
  // cond 可能来自 command、RegExp、raw value
  if (cond === undefined) return true;
  if (isExists(cond)) return (fieldVal !== undefined) === cond.__exists;
  if (isCmd(cond)) return compareCmd(cond.__cmd, fieldVal, cond.value);
  if (isReglike(cond)) {
    try { return new RegExp(cond.__regexp, cond.__options || '').test(String(fieldVal)); } catch (e) { return false; }
  }
  if (cond && typeof cond === 'object' && cond.__regexp !== undefined) return matchValue(fieldVal, cond);
  return compareCmd('eq', fieldVal, cond);
}

// 计算 where 条件（含 and/or 递归、command、RegExp）
function matchWhere(doc, where) {
  if (!where) return true;
  if (isAnd(where)) return where.__and.every((w) => matchWhere(doc, w));
  if (isOr(where)) return where.__or.some((w) => matchWhere(doc, w));
  for (const k in where) {
    const cond = where[k];
    if (isAnd(cond)) {
      // 形如 _.gte(x).and(_.lt(y)) 表达 `field >= x && field < y`
      if (!cond.__and.every((c) => matchValue(doc[k], c))) return false;
      continue;
    }
    if (isOr(cond)) {
      if (!cond.__or.some((c) => matchValue(doc[k], c))) return false;
      continue;
    }
    if (!matchValue(doc[k], cond)) return false;
  }
  return true;
}

const commandObj = {
  gt: (v) => makeCmd('gt', v),
  gte: (v) => makeCmd('gte', v),
  lt: (v) => makeCmd('lt', v),
  lte: (v) => makeCmd('lte', v),
  eq: (v) => makeCmd('eq', v),
  neq: (v) => makeCmd('neq', v),
  exists: (v) => ({ __exists: !!v }),
  and: (...args) => ({ __and: args.length === 1 && Array.isArray(args[0]) ? args[0] : args }),
  or: (...args) => ({ __or: args.length === 1 && Array.isArray(args[0]) ? args[0] : args }),
  in: (arr) => ({ __cmd: 'in', value: arr }),
  // 用于迁移函数里的 db.command.exists(false)
};

function matchCmdIn(fieldVal, cmd) {
  if (cmd.__cmd === 'in') return (cmd.value || []).indexOf(fieldVal) >= 0;
  return false;
}

const existsCmd = { __exists: true };

// ---------- db 对象 ----------
// 提供 collection(name) 返回集合对象；以及 command、RegExp
function makeDB() {
  const db = {};
  db.command = commandObj;
  // db.command.aggregate 用于 .aggregate()
  db.command.aggregate = {
    sum: (v) => ({ __agg: 'sum', v: v }),
    first: (v) => ({ __agg: 'first', v: v }),
    max: (v) => ({ __agg: 'max', v: v }),
    min: (v) => ({ __agg: 'min', v: v }),
    avg: (v) => ({ __agg: 'avg', v: v }),
    push: (v) => ({ __agg: 'push', v: v })
  };
  db.RegExp = function (cfg) {
    const r = cfg || {};
    return { __regexp: r.regexp || '', __options: r.options || '' };
  };
  let _wrappedGet = null;
  db.collection = function (name) {
    const query = makeCollection(name);
    const makeDoc = query.doc;
    const makeAggregate = query.aggregate;
    query.doc = function (id) { return queueTerminals(makeDoc(id), ['get', 'update', 'remove']); };
    query.aggregate = function () { return queueTerminals(makeAggregate(), ['end']); };
    return queueTerminals(query, ['get', 'count', 'add', 'update', 'remove']);
  };
  return db;
}

// 把 command.and 链（如 _.gte(from).and(_.lt(to))）规整为 where 片段
// 该片段在 matchWhere 里被识别，这里直接复用。

// ---------- 集合对象 ----------
function makeCollection(name) {
  const col = {};
  col.name = name;

  // 构建查询
  let _where = null, _order = null, _limit = 50, _skip = 0;
  const q = {};

  function fresh() {
    _where = null; _order = null; _limit = 50; _skip = 0;
  }

  q.where = function (w) { _where = w; return q; };
  q.orderBy = function (f, dir) {
    if (!_order) _order = [];
    _order.push({ f: f, dir: (dir === 'asc' ? 1 : -1) });
    return q;
  };
  q.limit = function (n) { _limit = n; return q; };
  q.skip = function (n) { _skip = n; return q; };
  q.get = function () {
    let all = readColl(name);
    all = all.filter((doc) => matchWhere(doc, _where));
    if (_order && _order.length) {
      all.sort((a, b) => {
        for (let i = 0; i < _order.length; i++) {
          const o = _order[i];
          const va = _valPath(a, o.f), vb = _valPath(b, o.f);
          const ca = _cmp(va, vb);
          if (ca !== 0) return ca * o.dir;
        }
        return 0;
      });
    }
    all = all.slice(_skip, _skip + _limit);
    return Promise.resolve({ data: all.map((d) => JSON.parse(JSON.stringify(d))) });
  };
  q.count = function () {
    let all = readColl(name);
    all = all.filter((doc) => matchWhere(doc, _where));
    return Promise.resolve({ total: all.length });
  };
  q.add = function ({ data }) {
    const arr = readColl(name);
    const doc = JSON.parse(JSON.stringify(data || {}));
    doc._id = nextId();
    if (!doc.createdAt) doc.createdAt = new Date();
    arr.push(doc);
    writeColl(name, arr);
    return Promise.resolve({ _id: doc._id });
  };
  q.remove = function () {
    let all = readColl(name);
    const before = all.length;
    all = all.filter((doc) => !matchWhere(doc, _where));
    writeColl(name, all);
    return Promise.resolve({ stats: { removed: before - all.length } });
  };
  q.update = function ({ data }) {
    const all = readColl(name);
    let updated = 0;
    const patched = all.map((doc) => {
      if (matchWhere(doc, _where)) {
        updated++;
        return _deepMerge(doc, data || {});
      }
      return doc;
    });
    writeColl(name, patched);
    return Promise.resolve({ stats: { updated: updated } });
  };
  q.doc = function (id) {
    const d = {};
    d.get = function () {
      const all = readColl(name);
      const doc = all.find((x) => x._id === id);
      if (!doc) return Promise.reject(new Error('document not found'));
      return Promise.resolve({ data: JSON.parse(JSON.stringify(doc)) });
    };
    d.update = function ({ data }) {
      const all = readColl(name);
      let found = false;
      const patched = all.map((doc) => {
        if (doc._id === id) { found = true; return _deepMerge(doc, data || {}); }
        return doc;
      });
      writeColl(name, patched);
      return Promise.resolve({ stats: { updated: found ? 1 : 0 } });
    };
    d.remove = function () {
      const all = readColl(name);
      const filtered = all.filter((x) => x._id !== id);
      writeColl(name, filtered);
      return Promise.resolve({ stats: { removed: all.length - filtered.length } });
    };
    return d;
  };
  q.aggregate = function () {
    let _match = null, _group = null, _unwind = null, _sort = null, _limit = 50;
    let _project = null;
    const a = {};
    a.match = function (w) { _match = w; return a; };
    a.group = function (g) { _group = g; return a; };
    a.unwind = function (f) { _unwind = f; return a; };
    a.sort = function (s) { _sort = s; return a; };
    a.limit = function (n) { _limit = n; return a; };
    a.project = function (p) { _project = p; return a; };
    a.end = function () {
      let rows = readColl(name).filter((doc) => matchWhere(doc, _match));
      // unwind
      if (_unwind) {
        const path = String(_unwind).replace(/^\$/, '');
        const out = [];
        rows.forEach((doc) => {
          const v = _valPath(doc, path);
          if (Array.isArray(v)) {
            v.forEach((elem) => {
              const c = JSON.parse(JSON.stringify(doc));
              c[path] = elem;
              out.push(c);
            });
          } else {
            out.push(doc);
          }
        });
        rows = out;
      }
      // group
      if (_group) {
        const groups = {};
        rows.forEach((doc) => {
          const gid = _group._id;
          const key = JSON.stringify(_aggId(gid, doc));
          if (!groups[key]) groups[key] = { _id: _aggId(gid, doc) };
          const g = groups[key];
          for (const k in _group) {
            if (k === '_id') continue;
            const spec = _group[k];
            g[k] = _aggValue(g[k], spec, doc, k);
          }
        });
        rows = Object.keys(groups).map((k) => {
          const row = groups[k];
          for (const kk in row) {
            if (kk !== '_id' && row[kk] !== undefined && row[kk] !== null) {
              // 若含 __agg 标记（如 count 用 $.sum(1)），做数值处理
            }
          }
          return row;
        });
      }
      // sort
      if (_sort) {
        rows.sort((a, b) => {
          for (const f in _sort) {
            const va = _valPath(a, f), vb = _valPath(b, f);
            const c = _cmp(va, vb);
            if (c !== 0) return c * (_sort[f] === -1 ? -1 : 1);
          }
          return 0;
        });
      }
      rows = rows.slice(0, _limit);
      return Promise.resolve({ list: rows });
    };
    return a;
  };
  return q;
}

// ---------- 工具：路径取值 / 深合并 / 比较 ----------
function _valPath(obj, path) {
  if (!path) return undefined;
  // 支持 $lines.qty / lines.qty 及嵌套
  const parts = String(path).replace(/^\$/, '').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}
function _cmp(a, b) {
  const na = a instanceof Date ? a.getTime() : a;
  const nb = b instanceof Date ? b.getTime() : b;
  if (na === nb) return 0;
  if (na === undefined || na === null) return -1;
  if (nb === undefined || nb === null) return 1;
  return na < nb ? -1 : 1;
}
function _deepMerge(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const k in (patch || {})) {
    const v = patch[k];
    if (v instanceof Date) {
      out[k] = new Date(v.getTime());
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !isCmd(v)) {
      out[k] = _deepMerge(out[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------- aggregate 的 _id / 值计算 ----------
function _aggId(spec, doc) {
  if (typeof spec === 'string') return _valPath(doc, spec);
  if (spec === null) return null;
  if (spec && typeof spec === 'object') {
    const o = {};
    for (const k in spec) o[k] = _aggId(spec[k], doc);
    return o;
  }
  return spec;
}
function _aggValue(prev, spec, doc, key) {
  // spec 形如字段名'$x' 或 {$multiply:[..]} 或 command aggregate 标记
  if (spec && typeof spec === 'object' && spec.__agg) {
    const a = spec.__agg;
    const val = _valPath(doc, spec.v);
    const prevNum = Number(prev) || 0;
    const curNum = Number(val) || 0;
    switch (a) {
      case 'sum': return (Number(prev) || 0) + (spec.v === 1 ? 1 : curNum);
      case 'first': return prev === undefined || prev === null ? val : prev;
      case 'max': return prev === undefined || prev === null ? val : Math.max(Number(prev) || 0, Number(val) || 0);
      case 'min': return prev === undefined || prev === null ? val : Math.min(Number(prev) || 0, Number(val) || 0);
      case 'avg': throw new Error('avg 需自行计算');
      case 'push': { const arr = Array.isArray(prev) ? prev : []; arr.push(val); return arr; }
      default: return prev;
    }
  }
  if (spec === 1) return (Number(prev) || 0) + 1;
  if (typeof spec === 'string' && spec[0] === '$') return _valPath(doc, spec);
  return spec;
}

// ---------- 云函数实现（9 个，与云端逻辑对齐） ----------
function resolveOpenid() {
  // 本地模式下用固定 openid（模拟单用户）
  let oid = storage.getStorageSync('cpos_openid');
  if (!oid) {
    oid = 'local-' + Date.now().toString(36);
    storage.setStorageSync('cpos_openid', oid);
  }
  return oid;
}

async function fnLogin() {
  const oid = resolveOpenid();
  return { success: true, openid: oid };
}

function goodsSkuSnapshot(skus) {
  return (Array.isArray(skus) ? skus : []).map((s) => ({
    key: String(s.key || ''), color: String(s.color || ''), size: String(s.size || ''),
    stock: Number(s.stock) || 0, costPrice: Number(s.costPrice) || 0, price: Number(s.price) || 0
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

async function fnSaveGoods(event) {
  const OPENID = resolveOpenid();
  try {
    const input = event.goods || {}, goodsId = String(event.goodsId || '').trim();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('请填写商品名称');
    if (!Array.isArray(input.skus) || !input.skus.length) throw new Error('请设置商品规格');
    const keys = new Set();
    const skus = input.skus.map((s) => {
      const key = String(s.key || ''), stock = Number(s.stock), costPrice = Number(s.costPrice), price = Number(s.price);
      if (!key || keys.has(key) || !Number.isSafeInteger(stock) || stock < 0 || !Number.isFinite(costPrice) || costPrice < 0 || !Number.isFinite(price) || price < 0) throw new Error('规格、库存或价格无效，请检查后保存');
      keys.add(key);
      return { key, color: String(s.color || ''), size: String(s.size || ''), stock, costPrice: round2(costPrice), price: round2(price) };
    });
    const stock = skus.reduce((sum, s) => sum + s.stock, 0);
    const costPrice = Number(input.costPrice), price = Number(input.price);
    if (!Number.isSafeInteger(stock) || !Number.isFinite(costPrice) || costPrice < 0 || !Number.isFinite(price) || price < 0) throw new Error('库存或价格无效，请检查后保存');
    const now = new Date();
    const payload = {
      name, barcode: String(input.barcode || '').trim(), category: String(input.category || '').trim(), unit: String(input.unit || '件').trim(),
      status: input.status === 'off' ? 'off' : 'on', colors: Array.isArray(input.colors) ? input.colors.map(String) : [], sizes: Array.isArray(input.sizes) ? input.sizes.map(String) : [],
      skus, stock, totalStock: stock, skuCount: skus.filter((s) => s.stock > 0).length,
      costPrice: round2(costPrice), price: round2(price), updatedAt: now
    };
    if (goodsId) {
      const current = readColl('goods').find((g) => g._id === goodsId);
      if (!current || current.openid !== OPENID) throw new Error('商品不存在或不是本人数据');
      if (!Array.isArray(event.expectedOriginalSkus) || event.expectedOriginalStock === undefined ||
        JSON.stringify(goodsSkuSnapshot(current.skus)) !== JSON.stringify(goodsSkuSnapshot(event.expectedOriginalSkus)) ||
        (Number(current.stock) || 0) !== Number(event.expectedOriginalStock)) throw new Error('商品库存或规格已变更，请重新打开商品后保存');
      const currentSkus = goodsSkuSnapshot(current.skus);
      if (currentSkus.length) {
        if (currentSkus.some((s) => s.stock > 0 && !skus.some((x) => x.key === s.key))) throw new Error('有库存的规格不能移除');
        const removedSkus = currentSkus.filter((s) => !skus.some((x) => x.key === s.key));
        if (removedSkus.length) {
          const historicalLines = readColl('sales_orders').concat(readColl('purchase_orders'))
            .filter((o) => o.openid === OPENID).reduce((all, o) => all.concat(Array.isArray(o.lines) ? o.lines : []), []);
          const referenced = historicalLines.concat(readColl('inventory_logs').filter((log) => log.openid === OPENID))
            .some((l) => l.goodsId === goodsId && matchSku(removedSkus, l.skuKey, l.color, l.size) >= 0);
          if (referenced) throw new Error('有历史订单或库存流水的规格不能移除，请保留以便查询和退货');
        }
        skus.forEach((s) => {
          const old = currentSkus.find((x) => x.key === s.key);
          if (old ? s.stock !== old.stock || s.color !== old.color || s.size !== old.size : s.stock !== 0) throw new Error('编辑态不能改库存，请走进货/销售');
        });
      } else if (stock !== (Number(current.stock) || 0)) throw new Error('编辑态不能改库存，请走进货/销售');
      _patchDoc('goods', goodsId, payload);
      return { success: true, goodsId };
    }
    const id = _addDoc('goods', Object.assign({ openid: OPENID, createdAt: now }, payload));
    skus.filter((s) => s.stock > 0).forEach((s) => _addDoc('inventory_logs', {
      openid: OPENID, type: 'initial', action: 'in', goodsId: id, goodsName: name,
      skuKey: s.key, color: s.color, size: s.size, unit: payload.unit, qty: s.stock, unitPrice: s.costPrice,
      refType: 'initial', refId: '', remark: '期初建档库存', createdAt: now
    }));
    return { success: true, goodsId: id };
  } catch (e) { return { success: false, message: (e && e.message) || '商品保存失败' }; }
}

async function fnSubmitSale(event) {
  const OPENID = resolveOpenid();
  const rawLines = Array.isArray(event.lines) ? event.lines : [];
  if (!rawLines.length) return { success: false, message: '订单明细为空' };
  if (rawLines.length > 30) return { success: false, message: '单笔最多 30 项商品' };
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const rl = rawLines[i] || {};
    const goodsId = String(rl.goodsId || '').trim();
    const qty = inputNumber(rl.qty);
    const rawPrice = inputNumber(rl.price);
    const price = round2(rawPrice);
    const skuKey = String(rl.skuKey || '').trim();
    const color = String(rl.color || '').slice(0, 30);
    const size = String(rl.size || '').slice(0, 20);
    if (!goodsId) return { success: false, message: '第 ' + (i + 1) + ' 行缺少商品' };
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99999) return { success: false, message: '第 ' + (i + 1) + ' 行数量不合法' };
    if (!Number.isFinite(rawPrice) || rawPrice < 0) return { success: false, message: '第 ' + (i + 1) + ' 行单价不合法' };
    if (price > 9999999) return { success: false, message: '第 ' + (i + 1) + ' 行单价过大' };
    lines.push({ goodsId, qty, price, skuKey, color, size });
  }
  const pct = event.discountPct === undefined ? 100 : inputNumber(event.discountPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { success: false, message: '折扣必须为 0 到 100 的有效数字' };
  const erase = !!event.erase;
  const payment = ['cash', 'wechat', 'alipay', 'credit'].indexOf(event.paymentMethod) >= 0 ? event.paymentMethod : 'cash';
  const remark = String(event.remark || '').slice(0, 200);
  const customerName = String(event.customerName || '').trim().slice(0, 50);
  const customerPhone = String(event.customerPhone || '').trim().slice(0, 20);
  const customerId = String(event.customerId || '').trim();
  const receivedInput = event.received === undefined ? 0 : inputNumber(event.received);
  if (!Number.isFinite(receivedInput) || receivedInput < 0 || receivedInput > 99999999) return { success: false, message: '实收金额不合法' };
  const receivedRaw = round2(receivedInput);

  let subtotal = 0;
  lines.forEach((l) => { subtotal = round2(subtotal + round2(l.price * l.qty)); });
  const afterDiscount = round2(subtotal * pct / 100);
  const discountAmount = round2(subtotal - afterDiscount);
  const amountDue = erase ? Math.floor(afterDiscount) : afterDiscount;
  const eraseAmount = erase ? round2(afterDiscount - amountDue) : 0;
  const received = receivedRaw;
  const change = received > amountDue ? round2(received - amountDue) : 0;
  const debt = amountDue > received ? round2(amountDue - received) : 0;
  const requestId = String(event.requestId || '').trim();
  const requestFingerprint = JSON.stringify({ lines, pct, erase, payment, remark, customerName, customerPhone, customerId, received });
  if (requestId) {
    const previous = readColl('sales_orders').find((o) => o.openid === OPENID && o.requestId === requestId);
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) return { success: false, message: '重复请求的订单内容不一致，请重新确认后提交' };
      return { success: true, orderId: previous._id, orderNo: previous.orderNo, amountDue, received, change, debt };
    }
  }

  const now = new Date();
  const orderNo = genOrderNo('XS');
  const savedLines = [];

  try {
    const goodsColl = makeCollection('goods');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const gAll = readColl('goods');
      const g = gAll.find((x) => x._id === l.goodsId);
      if (!g || g.openid !== OPENID) throw new Error('商品不存在或已被删除，请返回购物车检查');
      if (g.status === 'off') throw new Error('商品「' + (g.name || '') + '」已下架，请返回购物车移除或重新上架');
      let lineCost = round2(Number(g.costPrice) || 0);
      let skus = null, stockAfter = 0, skuMatched = false;
      if (Array.isArray(g.skus) && g.skus.length) {
        skus = g.skus.map((s) => ({
          key: String(s.key || ''), color: String(s.color || ''), size: String(s.size || ''),
          stock: Number(s.stock) || 0, costPrice: skuCost(s.costPrice, lineCost), price: round2(Number(s.price) || 0)
        }));
        const key = l.skuKey || makeSkuKey(l.color, l.size);
        const idx = matchSku(skus, key, l.color, l.size);
        if (idx < 0) throw new Error('SKU 不存在：' + (g.name || '') + ' / ' + (key || '(未指定)'));
        if (skus[idx].stock < l.qty) throw new Error('库存不足：' + (g.name || '') + ' ' + (key || '') + ' 仅剩 ' + skus[idx].stock + ' 件');
        skus[idx].stock = skus[idx].stock - l.qty;
        skuMatched = true;
        lineCost = skus[idx].costPrice;
      } else {
        const stock = Number(g.stock) || 0;
        if (stock < l.qty) throw new Error('库存不足：' + (g.name || '') + ' 仅剩 ' + stock + ' 件');
        stockAfter = stock - l.qty;
      }

      if (skuMatched) {
        const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
        _patchDoc('goods', l.goodsId, { skus, totalStock, stock: totalStock, updatedAt: now });
      } else {
        _patchDoc('goods', l.goodsId, { stock: stockAfter, totalStock: stockAfter, updatedAt: now });
      }
      savedLines.push({
        goodsId: l.goodsId, name: g.name || '', unit: g.unit || '件', price: l.price, qty: l.qty,
        amount: round2(l.price * l.qty), cost: lineCost,
        skuKey: l.skuKey || (l.color || l.size ? makeSkuKey(l.color, l.size) : ''),
        color: l.color, size: l.size
      });
    }

    const order = {
      openid: OPENID, orderNo, type: 'sale', status: 'completed',
      requestId, requestFingerprint,
      paymentMethod: payment, paymentMethodText: PAYMENT_TEXT[payment],
      subtotal, discountPct: pct, discountAmount, erase, eraseAmount, amountDue,
      received, change, debt, remark, customerId, customerName, customerPhone,
      lines: savedLines, createdAt: now
    };
    const orderId = _addDoc('sales_orders', order);

    savedLines.forEach((l) => {
      _addDoc('inventory_logs', {
        openid: OPENID, type: 'sale', action: 'out',
        goodsId: l.goodsId, goodsName: l.name, unit: l.unit, qty: l.qty, unitPrice: l.cost,
        skuKey: l.skuKey || '', color: l.color || '', size: l.size || '',
        refType: 'sale', refId: orderId, createdAt: now
      });
    });

    await fnStatsSyncCustomers(OPENID);
    return { success: true, orderId, orderNo, amountDue, received, change, debt };
  } catch (e) {
    return { success: false, message: (e && e.message) || '开单失败，请重试' };
  }
}

async function fnSubmitPurchase(event) {
  const OPENID = resolveOpenid();
  const rawLines = Array.isArray(event.lines) ? event.lines : [];
  if (!rawLines.length) return { success: false, message: '进货明细为空' };
  if (rawLines.length > 30) return { success: false, message: '单笔最多 30 项商品' };
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const rl = rawLines[i] || {};
    const goodsId = String(rl.goodsId || '').trim();
    const qty = inputNumber(rl.qty);
    const rawCost = inputNumber(rl.unitCost);
    const unitCost = round2(rawCost);
    const skuKey = String(rl.skuKey || '').trim();
    const color = String(rl.color || '').slice(0, 30);
    const size = String(rl.size || '').slice(0, 20);
    if (!goodsId) return { success: false, message: '第 ' + (i + 1) + '行缺少商品' };
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99999) return { success: false, message: '第 ' + (i + 1) + '行数量不合法' };
    if (!Number.isFinite(rawCost) || rawCost < 0) return { success: false, message: '第 ' + (i + 1) + ' 行进价不合法' };
    if (unitCost > 9999999) return { success: false, message: '第 ' + (i + 1) + '行进价过大' };
    lines.push({ goodsId, qty, unitCost, skuKey, color, size });
  }
  const supplierId = String(event.supplierId || '').trim();
  const remark = String(event.remark || '').slice(0, 200);
  const requestId = String(event.requestId || '').trim();
  const requestFingerprint = JSON.stringify({ lines, supplierId, remark });
  if (requestId) {
    const previous = readColl('purchase_orders').find((o) => o.openid === OPENID && o.requestId === requestId);
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) return { success: false, message: '重复请求的进货内容不一致，请重新确认后提交' };
      return { success: true, orderId: previous._id, orderNo: previous.orderNo, totalAmount: previous.totalAmount, supplierName: previous.supplierName || '' };
    }
  }
  let supplierName = '';
  if (supplierId) {
    const sAll = readColl('suppliers');
    const s = sAll.find((x) => x._id === supplierId);
    if (s && s.openid === OPENID) supplierName = s.name || '';
  }

  const now = new Date();
  const orderNo = genOrderNo('JH');
  const savedLines = [];
  let totalAmount = 0;

  try {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const gAll = readColl('goods');
      const g = gAll.find((x) => x._id === l.goodsId);
      if (!g || g.openid !== OPENID) throw new Error('商品不存在或已被删除：请重新选择第 ' + (i + 1) + ' 行商品');
      const oldCost = round2(Number(g.costPrice) || 0);
      const skus = Array.isArray(g.skus) ? g.skus.map((s) => ({
        key: String(s.key || ''), color: String(s.color || ''), size: String(s.size || ''),
        stock: Number(s.stock) || 0, costPrice: skuCost(s.costPrice, oldCost), price: round2(Number(s.price) || 0)
      })) : null;
      let lineUnitCost = l.unitCost, lineAvgCost = l.unitCost, amount = 0, stockAfter = 0, newCost = oldCost;
      if (skus && skus.length) {
        const key = l.skuKey || makeSkuKey(l.color, l.size);
        const idx = matchSku(skus, key, l.color, l.size);
        if (idx < 0) throw new Error('SKU 不存在：' + (g.name || '') + ' / ' + (key || '(未指定)'));
        const oldSkuStock = skus[idx].stock;
        const oldSkuCost = skus[idx].costPrice;
        const stockSkuAfter = oldSkuStock + l.qty;
        const newSkuCost = stockSkuAfter > 0 ? round2((oldSkuCost * oldSkuStock + l.unitCost * l.qty) / stockSkuAfter) : l.unitCost;
        skus[idx].stock = stockSkuAfter;
        skus[idx].costPrice = newSkuCost;
        lineUnitCost = l.unitCost;
        lineAvgCost = newSkuCost;
        amount = round2(l.unitCost * l.qty);
        const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
        let totalQty = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
        let weightedCostSum = 0;
        skus.forEach((x) => { weightedCostSum += x.costPrice * x.stock; });
        newCost = totalQty > 0 ? round2(weightedCostSum / totalQty) : oldCost;
        _patchDoc('goods', l.goodsId, { skus, totalStock, stock: totalStock, costPrice: newCost, updatedAt: now });
      } else {
        const stock = Number(g.stock) || 0;
        stockAfter = stock + l.qty;
        newCost = stockAfter > 0 ? round2((oldCost * stock + l.unitCost * l.qty) / stockAfter) : l.unitCost;
        amount = round2(l.unitCost * l.qty);
        _patchDoc('goods', l.goodsId, { stock: stockAfter, totalStock: stockAfter, costPrice: newCost, updatedAt: now });
      }
      totalAmount = round2(totalAmount + amount);
      savedLines.push({
        goodsId: l.goodsId, name: g.name || '', unit: g.unit || '件', qty: l.qty,
        unitCost: lineUnitCost, avgCost: lineAvgCost, amount,
        skuKey: l.skuKey || (l.color || l.size ? makeSkuKey(l.color, l.size) : ''),
        color: l.color, size: l.size
      });
    }
    const order = {
      openid: OPENID, orderNo, type: 'purchase', supplierId, supplierName, remark,
      requestId, requestFingerprint,
      totalAmount, lines: savedLines, createdAt: now
    };
    const orderId = _addDoc('purchase_orders', order);
    savedLines.forEach((l) => {
      _addDoc('inventory_logs', {
        openid: OPENID, type: 'purchase', action: 'in',
        goodsId: l.goodsId, goodsName: l.name, unit: l.unit, qty: l.qty, unitPrice: l.unitCost,
        skuKey: l.skuKey || '', color: l.color || '', size: l.size || '',
        refType: 'purchase', refId: orderId, createdAt: now
      });
    });
    return { success: true, orderId, orderNo, totalAmount, supplierName };
  } catch (e) {
    return { success: false, message: (e && e.message) || '入库失败，请重试' };
  }
}

async function fnReturnSale(event) {
  const OPENID = resolveOpenid();
  const orderId = String(event.orderId || '').trim();
  const reason = String(event.reason || '').slice(0, 200);
  if (!orderId) return { success: false, message: '缺少订单号' };
  try {
    const orders = readColl('sales_orders');
    const order = orders.find((x) => x._id === orderId);
    if (!order) throw new Error('订单不存在或已被删除');
    if (order.openid !== OPENID) throw new Error('无权操作该订单');
    if (order.type !== 'sale') throw new Error('只有销售单可以退货');
    if (order.status === 'returned') throw new Error('该订单已退货，请勿重复操作');
    if (order.status !== 'completed') throw new Error('订单状态异常，无法退货');
    const now = new Date();
    const lines = order.lines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      if (!l.goodsId) continue;
      const gAll = readColl('goods');
      const g = gAll.find((x) => x._id === l.goodsId);
      if (!g || g.openid !== OPENID) throw new Error('商品「' + (l.name || '') + '」已删除，无法自动退货。请先在商品列表恢复该商品后再退货');
      const skuKey = String(l.skuKey || '');
      const hasSkus = Array.isArray(g.skus) && g.skus.length;
      if (!hasSkus && (skuKey || l.color || l.size)) throw new Error('商品「' + (g.name || l.name || '') + '」的 SKU 已删除，请恢复对应规格后再退货');
      if (hasSkus) {
        const skus = g.skus.map((s) => ({
          key: String(s.key || ''), color: String(s.color || ''), size: String(s.size || ''),
          stock: Number(s.stock) || 0, costPrice: Number(s.costPrice) || 0, price: Number(s.price) || 0
        }));
        const idx = matchSku(skus, skuKey, l.color, l.size);
        if (idx < 0) throw new Error('商品「' + (g.name || l.name || '') + '」的 SKU 已删除，请恢复对应规格后再退货');
        if (idx >= 0) {
          skus[idx].stock = skus[idx].stock + (Number(l.qty) || 0);
          const totalStock = skus.reduce((s, x) => s + (Number(x.stock) || 0), 0);
          _patchDoc('goods', l.goodsId, { skus, totalStock, stock: totalStock, updatedAt: now });
        }
      } else {
        const stockAfter = (Number(g.stock) || 0) + (Number(l.qty) || 0);
        _patchDoc('goods', l.goodsId, { stock: stockAfter, totalStock: stockAfter, updatedAt: now });
      }
      _addDoc('inventory_logs', {
        openid: OPENID, type: 'return', action: 'in',
        goodsId: l.goodsId, goodsName: l.name || '', unit: l.unit || '件', qty: Number(l.qty) || 0,
        unitPrice: Number(l.cost) || 0, skuKey, color: l.color || '', size: l.size || '',
        refType: 'return', refId: orderId, createdAt: now
      });
    }
    _patchDoc('sales_orders', orderId, { status: 'returned', returnedAt: now, returnReason: reason });
    await fnStatsSyncCustomers(OPENID);
    return { success: true, orderId, orderNo: order.orderNo || '', returnedAt: now };
  } catch (e) {
    return { success: false, message: (e && e.message) || '退货失败，请重试' };
  }
}

async function fnSettleDebt(event) {
  const OPENID = resolveOpenid();
  const orderId = String(event.orderId || '').trim();
  if (!orderId) return { success: false, message: '缺少订单 ID' };
  const amount = round2(toNum(event.amount, 0));
  if (amount <= 0) return { success: false, message: '收款金额必须大于 0' };
  if (amount > 9999999) return { success: false, message: '收款金额过大' };
  const payment = ['cash', 'wechat', 'alipay'].indexOf(event.paymentMethod) >= 0 ? event.paymentMethod : 'cash';
  const note = String(event.note || '').slice(0, 100);
  const requestId = String(event.requestId || '').trim();
  const requestFingerprint = JSON.stringify({ orderId, amount, payment, note });
  try {
    const orders = readColl('sales_orders');
    const order = orders.find((x) => x._id === orderId);
    if (!order || order.openid !== OPENID) return { success: false, message: '订单不存在或不是本人数据' };
    const oldHistory = Array.isArray(order.settleHistory) ? order.settleHistory : [];
    const previous = requestId && oldHistory.find((entry) => entry.requestId === requestId);
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint || !previous.result) return { success: false, message: '重复请求的收款内容不一致，请重新确认后提交' };
      return previous.result;
    }
    if (order.status !== 'completed') return { success: false, message: '只能对「正常」订单补收欠款' };
    const oldReceived = Number(order.received) || 0;
    const amountDue = Number(order.amountDue) || 0;
    const oldDebt = Number(order.debt) || 0;
    if (oldDebt <= 0) return { success: false, message: '该订单没有欠款，无需补收' };
    if (amount > oldDebt) return { success: false, message: '收款金额不能超过欠款 ¥' + round2(oldDebt) };
    const newReceived = round2(oldReceived + amount);
    const newDebt = amountDue > newReceived ? round2(amountDue - newReceived) : 0;
    const newChange = newReceived > amountDue ? round2(newReceived - amountDue) : 0;
    const fullyCleared = newDebt === 0;
    let newPayMethod = order.paymentMethod || 'credit';
    let newPayText = order.paymentMethodText || PAYMENT_TEXT[order.paymentMethod] || '记账欠款';
    if (fullyCleared && order.paymentMethod === 'credit') {
      newPayMethod = payment;
      newPayText = PAYMENT_TEXT[payment];
    }
    const result = { success: true, orderId, added: amount, received: newReceived, debt: newDebt, change: newChange, fullyCleared, paymentMethod: newPayMethod, paymentMethodText: newPayText };
    const newEntry = { amount, paymentMethod: payment, paymentMethodText: PAYMENT_TEXT[payment], at: new Date(), atText: nowStr(), note, requestId, requestFingerprint, result };
    _patchDoc('sales_orders', orderId, {
      received: newReceived, change: newChange, debt: newDebt,
      paymentMethod: newPayMethod, paymentMethodText: newPayText,
      originalPaymentMethod: order.originalPaymentMethod || order.paymentMethod || 'credit',
      settleHistory: oldHistory.concat([newEntry]), updatedAt: new Date()
    });
    await fnStatsSyncCustomers(OPENID);
    return result;
  } catch (e) {
    return { success: false, message: (e && e.message) || '结清失败，请重试' };
  }
}

// 按订单应收金额分摊到分，余下的分给小数余数最大的明细，保证榜单与销售额一致。
function netLineAmounts(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const weights = lines.map((line) => Math.max(0, Number(line.amount === undefined ? Number(line.price) * Number(line.qty) : line.amount) || 0));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const cents = Math.max(0, Math.round(round2(order.amountDue) * 100));
  if (!total || !cents) return lines.map(() => 0);
  const shares = weights.map((weight, index) => {
    const exact = cents * (weight / total), whole = Math.floor(exact);
    return { index, whole, fraction: exact - whole };
  });
  let remaining = cents - shares.reduce((sum, share) => sum + share.whole, 0);
  const ranked = shares.slice().sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; remaining > 0; i++, remaining--) ranked[i % ranked.length].whole++;
  return shares.map((share) => share.whole / 100);
}

// ---- stats：summary / syncCustomers / debtCustomers / debts ----
async function fnStats(event) {
  const OPENID = resolveOpenid();
  const action = event.action || 'summary';
  const startMs = toNum(event.startMs, 0);
  const endMs = toNum(event.endMs, Date.now() + 86400000);
  if (startMs >= endMs) return { success: false, message: '日期区间不合法' };
  const from = new Date(startMs);
  const to = new Date(endMs);

  if (action === 'syncCustomers') return fnStatsSyncCustomers(OPENID);
  if (action === 'debtCustomers') return fnStatsDebtCustomers(OPENID);
  if (action === 'debts') return fnStatsDebts(OPENID, from, to);

  // summary
  const salesAll = readColl('sales_orders').filter((o) => o.openid === OPENID && o.status === 'completed' && _inRange(o.createdAt, from, to));
  const salesCount = salesAll.length;
  const salesAmount = round2(salesAll.reduce((s, o) => s + (Number(o.amountDue) || 0), 0));
  const subtotal = round2(salesAll.reduce((s, o) => s + (Number(o.subtotal) || 0), 0));
  let saleCost = 0, soldQty = 0;
  const goodsMap = {};
  salesAll.forEach((o) => {
    const amounts = netLineAmounts(o);
    (o.lines || []).forEach((l, index) => {
      saleCost = round2(saleCost + (Number(l.cost) || 0) * (Number(l.qty) || 0));
      soldQty += (Number(l.qty) || 0);
      const gid = String(l.goodsId || '');
      if (gid) {
        if (!goodsMap[gid]) goodsMap[gid] = { name: l.name || '未知商品', unit: l.unit || '件', qty: 0, amount: 0 };
        goodsMap[gid].qty += (Number(l.qty) || 0);
        goodsMap[gid].amount = round2(goodsMap[gid].amount + amounts[index]);
      }
    });
  });
  const topGoods = Object.keys(goodsMap).map((k) => ({ goodsId: k, name: goodsMap[k].name, unit: goodsMap[k].unit, qty: goodsMap[k].qty, amount: goodsMap[k].amount }))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);
  const grossProfit = round2(salesAmount - saleCost);

  const returnedCount = readColl('sales_orders').filter((o) => o.openid === OPENID && o.status === 'returned' && _inRange(o.returnedAt, from, to)).length;

  const purAll = readColl('purchase_orders').filter((o) => o.openid === OPENID && _inRange(o.createdAt, from, to));
  const purchaseCount = purAll.length;
  const purchaseAmount = round2(purAll.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0));
  let purchaseQty = 0;
  purAll.forEach((o) => (o.lines || []).forEach((l) => { purchaseQty += (Number(l.qty) || 0); }));

  // 色码/尺码占比
  const colorMap = {}, sizeMap = {};
  salesAll.forEach((o) => {
    const amounts = netLineAmounts(o);
    (o.lines || []).forEach((l, index) => {
      if (l.color !== undefined && l.color !== null && l.color !== '') {
        if (!colorMap[l.color]) colorMap[l.color] = { qty: 0, amount: 0 };
        colorMap[l.color].qty += (Number(l.qty) || 0);
        colorMap[l.color].amount = round2(colorMap[l.color].amount + amounts[index]);
      }
      if (l.size !== undefined && l.size !== null && l.size !== '') {
        if (!sizeMap[l.size]) sizeMap[l.size] = { qty: 0, amount: 0 };
        sizeMap[l.size].qty += (Number(l.qty) || 0);
        sizeMap[l.size].amount = round2(sizeMap[l.size].amount + amounts[index]);
      }
    });
  });
  const colorBreakdown = Object.keys(colorMap).map((c) => ({ color: c, qty: colorMap[c].qty, amount: colorMap[c].amount })).sort((a, b) => b.amount - a.amount).slice(0, 10);
  const sizeBreakdown = Object.keys(sizeMap).map((c) => ({ size: c, qty: sizeMap[c].qty, amount: sizeMap[c].amount })).sort((a, b) => b.amount - a.amount).slice(0, 10);

  return { success: true, data: { startMs, endMs, salesCount, salesAmount, soldQty, subtotal, saleCost, grossProfit, purchaseCount, purchaseAmount, purchaseQty, returnedCount, topGoods, colorBreakdown, sizeBreakdown } };
}

async function fnStatsSyncCustomers(OPENID) {
  const sales = readColl('sales_orders').filter((o) => o.openid === OPENID && o.status === 'completed' && o.customerId);
  const map = {};
  sales.forEach((o) => {
    if (!map[o.customerId]) map[o.customerId] = { totalSpent: 0, totalOrders: 0, totalDebt: 0, lastOrderAt: null };
    map[o.customerId].totalSpent = round2(map[o.customerId].totalSpent + (Number(o.amountDue) || 0));
    map[o.customerId].totalOrders += 1;
    map[o.customerId].totalDebt = round2(map[o.customerId].totalDebt + (Number(o.debt) || 0));
    const t = o.createdAt instanceof Date ? o.createdAt : new Date(o.createdAt);
    if (!map[o.customerId].lastOrderAt || t.getTime() > new Date(map[o.customerId].lastOrderAt).getTime()) map[o.customerId].lastOrderAt = t;
  });
  let updated = 0;
  readColl('customers').filter((c) => c.openid === OPENID).forEach((cur) => {
    const totals = map[cur._id] || { totalSpent: 0, totalOrders: 0, totalDebt: 0, lastOrderAt: null };
    _patchDoc('customers', cur._id, totals);
    updated++;
  });
  return { success: true, updated };
}

async function fnStatsDebtCustomers(OPENID) {
  const sales = readColl('sales_orders').filter((o) => o.openid === OPENID && o.status === 'completed' && (Number(o.debt) || 0) > 0);
  const map = {};
  sales.forEach((o) => {
    const phone = String(o.customerPhone || '').replace(/[\s-]+/g, '');
    const name = String(o.customerName || '').trim();
    const key = o.customerId ? 'id:' + o.customerId : phone ? 'phone:' + phone : name ? 'name:' + name : '__none__';
    if (!map[key]) map[key] = { customerKey: key, customerId: o.customerId || '', customerName: o.customerName || '未指定', customerPhone: o.customerPhone || '', totalDebt: 0, orderCount: 0 };
    map[key].totalDebt = round2(map[key].totalDebt + (Number(o.debt) || 0));
    map[key].orderCount += 1;
  });
  const customers = Object.keys(map).map((k) => map[k]).sort((a, b) => b.totalDebt - a.totalDebt);
  const totalDebt = round2(customers.reduce((s, x) => s + x.totalDebt, 0));
  const list = customers.slice(0, 200);
  return { success: true, data: { list, totalDebt } };
}

async function fnStatsDebts(OPENID, from, to) {
  const creditCompleted = (o) => o.openid === OPENID && o.status === 'completed' && (
    (Number(o.debt) || 0) > 0 || o.paymentMethod === 'credit' || o.originalPaymentMethod === 'credit' ||
    (Array.isArray(o.settleHistory) && o.settleHistory.length > 0)
  );
  const inRange = readColl('sales_orders').filter((o) => creditCompleted(o) && _inRange(o.createdAt, from, to));
  const allDebt = readColl('sales_orders').filter((o) => creditCompleted(o) && (Number(o.debt) || 0) > 0);

  const rangeCount = inRange.length;
  const rangeAmountDue = round2(inRange.reduce((s, o) => s + (Number(o.amountDue) || 0), 0));
  const rangeReceived = round2(inRange.reduce((s, o) => s + (Number(o.received) || 0), 0));
  const rangeDebt = round2(inRange.reduce((s, o) => s + (Number(o.debt) || 0), 0));
  const totalDebt = round2(allDebt.reduce((s, o) => s + (Number(o.debt) || 0), 0));
  const totalReceived = round2(allDebt.reduce((s, o) => s + (Number(o.received) || 0), 0));
  const totalAmountDue = round2(allDebt.reduce((s, o) => s + (Number(o.amountDue) || 0), 0));
  const totalCount = allDebt.length;

  const list = inRange.filter((o) => (Number(o.debt) || 0) > 0)
    .sort((a, b) => (Number(b.debt) || 0) - (Number(a.debt) || 0))
    .slice(0, 100).map(_mapDebtOrder);
  const clearedList = inRange.filter((o) => (Number(o.debt) || 0) === 0)
    .sort((a, b) => _cmpDates(b.createdAt, a.createdAt)).slice(0, 100).map(_mapDebtOrder);

  return { success: true, data: { startMs: from.getTime(), endMs: to.getTime(), totalDebt, totalReceived, totalAmountDue, totalCount, rangeCount, rangeAmountDue, rangeReceived, rangeDebt, list, clearedList } };
}

function _mapDebtOrder(o) {
  return { _id: o._id, orderNo: o.orderNo || '', amountDue: round2(o.amountDue), received: round2(o.received), debt: round2(o.debt), customerName: o.customerName || '', customerPhone: o.customerPhone || '', remark: o.remark || '', createdAt: o.createdAt };
}

async function fnSlowMover(event) {
  const OPENID = resolveOpenid();
  const thresholdDays = toNum(event.thresholdDays, 90);
  const limit = Math.min(500, Math.max(1, toNum(event.limit, 200)));
  const now = Date.now();
  function timestamp(value) {
    if (!(value instanceof Date) && typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time <= now ? time : null;
  }
  function oldEnough(lastDate, firstStockAt, createdAt) {
    const since = lastDate ? lastDate.getTime() : (firstStockAt === undefined ? timestamp(createdAt) : firstStockAt);
    return since !== null && Math.floor((now - since) / 86400000) >= thresholdDays;
  }
  const goods = readColl('goods').filter((o) => o.openid === OPENID);
  const goodsById = new Map(goods.map((g) => [g._id, g]));
  const firstStockBySku = {}, firstStockByGoods = {};
  // 从未有效售出的库存按首次入库年龄判断；旧数据无入库流水才回退建档时间。
  readColl('inventory_logs').forEach((log) => {
    if (log.openid !== OPENID || log.action !== 'in' || !(Number(log.qty) > 0)) return;
    const time = timestamp(log.createdAt);
    const g = goodsById.get(log.goodsId);
    if (time === null || !g) return;
    if (firstStockByGoods[g._id] === undefined || time < firstStockByGoods[g._id]) firstStockByGoods[g._id] = time;
    const index = matchSku(Array.isArray(g.skus) ? g.skus : [], log.skuKey, log.color, log.size);
    if (index >= 0) {
      const key = g._id + '|' + String(g.skus[index].key || '');
      if (firstStockBySku[key] === undefined || time < firstStockBySku[key]) firstStockBySku[key] = time;
    }
  });
  const sales = readColl('sales_orders').filter((o) => o.openid === OPENID && o.status !== 'returned');
  const lastSaleBySku = {}, lastSaleByGoods = {};
  const unknownSaleBySku = {}, unknownSaleByGoods = {};
  sales.forEach((o) => {
    const ts = timestamp(o.createdAt);
    (o.lines || []).forEach((l) => {
      const gk = String(l.goodsId || '');
      if (gk) {
        const prev = lastSaleByGoods[gk];
        if (ts === null) unknownSaleByGoods[gk] = true;
        else if (!prev || prev.getTime() < ts) lastSaleByGoods[gk] = new Date(ts);
      }
      const sk = String(l.skuKey || '');
      if (sk) {
        const fullKey = gk + '|' + sk;
        const prev = lastSaleBySku[fullKey];
        if (ts === null) unknownSaleBySku[fullKey] = true;
        else if (!prev || prev.getTime() < ts) lastSaleBySku[fullKey] = new Date(ts);
      }
    });
  });
  const items = [];
  goods.forEach((g) => {
    const skus = Array.isArray(g.skus) && g.skus.length ? g.skus : null;
    if (skus) {
      skus.forEach((sku) => {
        if (Number(sku.stock) <= 0) return;
        const fullKey = g._id + '|' + String(sku.key || '');
        const lastDate = lastSaleBySku[fullKey];
        const daysSince = lastDate ? Math.floor((now - new Date(lastDate).getTime()) / 86400000) : null;
        if (!unknownSaleBySku[fullKey] && oldEnough(lastDate, firstStockBySku[fullKey], g.createdAt)) {
          items.push({ goodsId: g._id, goodsName: g.name, unit: g.unit || '件', skuKey: sku.key, color: sku.color, size: sku.size, stock: Number(sku.stock) || 0, costPrice: Number(sku.costPrice) || 0, price: Number(sku.price) || 0, stockValue: round2((Number(sku.stock) || 0) * (Number(sku.costPrice) || 0)), lastSaleAt: lastDate || null, daysSince, isNeverSold: !lastDate });
        }
      });
    } else {
      const stock = Number(g.stock) || 0;
      if (stock <= 0) return;
      const lastDate = lastSaleByGoods[g._id];
      const daysSince = lastDate ? Math.floor((now - new Date(lastDate).getTime()) / 86400000) : null;
      if (!unknownSaleByGoods[g._id] && oldEnough(lastDate, firstStockByGoods[g._id], g.createdAt)) {
        items.push({ goodsId: g._id, goodsName: g.name, unit: g.unit || '件', skuKey: '', color: '', size: '', stock, costPrice: Number(g.costPrice) || 0, price: Number(g.price) || 0, stockValue: round2(stock * (Number(g.costPrice) || 0)), lastSaleAt: lastDate || null, daysSince, isNeverSold: !lastDate });
      }
    }
  });
  items.sort((a, b) => b.stockValue - a.stockValue);
  const sliced = items.slice(0, limit);
  const totalStockValue = round2(items.reduce((s, x) => s + x.stockValue, 0));
  const totalStockQty = items.reduce((s, x) => s + x.stock, 0);
  return { success: true, data: { thresholdDays, totalStockValue, totalStockQty, count: items.length, list: sliced } };
}

async function fnStatement(event) {
  const OPENID = resolveOpenid();
  const startMs = toNum(event.startMs, 0);
  const endMs = toNum(event.endMs, Date.now() + 86400000);
  if (startMs >= endMs) return { success: false, message: '日期区间不合法' };
  const customerId = String(event.customerId || '');
  const customerName = String(event.customerName || '').trim();
  const from = new Date(startMs);
  const to = new Date(endMs);
  try {
    let orders = readColl('sales_orders').filter((o) => o.openid === OPENID && _inRange(o.createdAt, from, to));
    if (customerId) orders = orders.filter((o) => String(o.customerId || '') === customerId);
    else if (customerName) orders = orders.filter((o) => String(o.customerName || '').toLowerCase().indexOf(customerName.toLowerCase()) >= 0);
    else return { success: false, message: '请指定客户（选客户或输入姓名）' };

    let completed = { count: 0, amount: 0, received: 0, debt: 0 };
    let returned = { count: 0, amount: 0, received: 0, debt: 0 };
    orders.forEach((o) => {
      const v = { count: 1, amount: round2(Number(o.amountDue) || 0), received: round2(Number(o.received) || 0), debt: round2(Number(o.debt) || 0) };
      if (o.status === 'returned') returned = _addStat(returned, v);
      else completed = _addStat(completed, v);
    });

    orders = orders.slice().sort((a, b) => _cmpDates(a.createdAt, b.createdAt));

    let customer = null;
    if (customerId) {
      customer = readColl('customers').find((c) => c._id === customerId) || null;
    } else if (orders.length) {
      customer = { _id: '', name: orders[0].customerName || customerName, phone: orders[0].customerPhone || '' };
    }

    const list = orders.map((o) => ({
      _id: o._id, orderNo: o.orderNo || '', status: o.status || 'completed', type: 'sale',
      createdAt: o.createdAt, timeText: fmtDt(o.createdAt),
      amount: round2(o.amountDue), received: round2(o.received), debt: round2(o.debt),
      paymentMethod: o.paymentMethod || '', paymentMethodText: o.paymentMethodText || '',
      remark: o.remark || '', skuCount: Array.isArray(o.lines) ? o.lines.length : 0
    }));

    return { success: true, data: { customer, range: { startMs, endMs }, summary: { completed, returned, netSales: completed.amount, totalReceived: completed.received, outstandingDebt: completed.debt }, list } };
  } catch (e) {
    return { success: false, message: (e && e.message) || '对账单生成失败' };
  }
}
function _addStat(a, v) {
  return { count: a.count + v.count, amount: round2(a.amount + v.amount), received: round2(a.received + v.received), debt: round2(a.debt + v.debt) };
}

async function fnMigrateSku(event) {
  const OPENID = resolveOpenid();
  const dryRun = !!event.dryRun;
  const limit = Math.min(1000, Math.max(1, Number(event.limit) || 500));
  let scanned = 0, migrated = 0, skipped = 0;
  const errors = [];
  try {
    let items = readColl('goods').filter((o) => o.openid === OPENID);
    scanned = items.length;
    items = items.filter((g) => !(Array.isArray(g.skus) && g.skus.length)).slice(0, limit);
    for (let i = 0; i < items.length; i++) {
      const g = items[i];
      if (Array.isArray(g.skus) && g.skus.length) { skipped++; continue; }
      const oldStock = Number(g.stock) || 0;
      const oldCost = Number(g.costPrice) || 0;
      const oldPrice = Number(g.price) || 0;
      const sku = { key: '默认·默认', color: '默认', size: '默认', stock: oldStock, costPrice: oldCost, price: oldPrice };
      const updateData = { skus: [sku], colors: ['默认'], sizes: ['默认'], stock: oldStock, totalStock: oldStock, migratedAt: new Date() };
      if (dryRun) { skipped++; continue; }
      try {
        _patchDoc('goods', g._id, updateData);
        migrated++;
      } catch (e) { errors.push({ _id: g._id, name: g.name, message: e.message }); }
    }
    const remaining = readColl('goods').filter((o) => o.openid === OPENID && !(Array.isArray(o.skus) && o.skus.length)).length;
    return { success: true, dryRun, scanned, migrated, skipped, errors, remaining };
  } catch (e) {
    return { success: false, message: (e && e.message) || '迁移失败', scanned, migrated };
  }
}

// ---------- 常用集合操作（供云函数内部复用） ----------
function _addDoc(name, data) {
  const arr = readColl(name);
  const doc = JSON.parse(JSON.stringify(data || {}));
  doc._id = nextId();
  if (!doc.createdAt) doc.createdAt = new Date();
  arr.push(doc);
  writeColl(name, arr);
  return doc._id;
}
function _patchDoc(name, id, patch) {
  const arr = readColl(name);
  const patched = arr.map((doc) => (doc._id === id ? _deepMerge(doc, patch || {}) : doc));
  writeColl(name, patched);
}
function _inRange(d, from, to) {
  if (!d) return false;
  const t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
  return t >= from.getTime() && t < to.getTime();
}
function _cmpDates(a, b) {
  const ta = (a instanceof Date) ? a.getTime() : new Date(a).getTime();
  const tb = (b instanceof Date) ? b.getTime() : new Date(b).getTime();
  return ta - tb;
}

// ---------- callFunction 路由 ----------
const FN_MAP = {
  login: fnLogin,
  saveGoods: fnSaveGoods,
  submitSale: fnSubmitSale,
  submitPurchase: fnSubmitPurchase,
  returnSale: fnReturnSale,
  settleDebt: fnSettleDebt,
  stats: fnStats,
  slowMover: fnSlowMover,
  statement: fnStatement,
  migrateSku: fnMigrateSku
};

// ---------- 对外导出 ----------
function makeCloud() {
  const cloud = {};
  // 兼容 cloud.DYNAMIC_CURRENT_ENV
  cloud.DYNAMIC_CURRENT_ENV = 'local-env';
  cloud.init = function () {};
  cloud.getWXContext = function () { return { OPENID: resolveOpenid() }; };
  cloud.database = function () { return makeDB(); };
  cloud.callFunction = function ({ name, data }) {
    const fn = FN_MAP[name];
    if (!fn) return Promise.resolve({ result: { success: false, message: '未实现的云函数：' + name } });
    return enqueue(() => fn(data || {})).then((result) => ({ result }));
  };
  return cloud;
}
return makeCloud();
}

module.exports = { createLocalCloud: createLocalCloud };
