const { createAtomicStorage, COLLECTIONS, RESTORE_BACKUP_KEY } = require('./atomic-storage');
const PREFIX = '__lcloud_';
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function inspect(value) {
  if (!value || typeof value !== 'object') return;
  Object.keys(value).forEach(key => {
    if (['__proto__', 'constructor', 'prototype'].indexOf(key) >= 0) throw new Error('备份包含不支持的字段');
    inspect(value[key]);
  });
}
function validateBackup(json) {
  if (typeof json !== 'string' || !json.trim()) throw new Error('备份内容为空');
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) { throw new Error('备份 JSON 格式错误'); }
  if (!parsed || parsed.app !== 'clothing-pos-miniapp' || [1, 2].indexOf(parsed.version) < 0) throw new Error('不是兼容的小程序备份');
  const data = parsed.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份缺少有效数据');
  inspect(data);
  const owners = new Set();
  Object.keys(data).forEach(name => {
    if (name === '__seq') {
      if (!Number.isSafeInteger(data[name]) || data[name] < 0) throw new Error('备份序号无效');
      return;
    }
    if (COLLECTIONS.indexOf(name) < 0 || !Array.isArray(data[name])) throw new Error('备份集合无效：' + name);
    const ids = new Set();
    data[name].forEach(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row._id !== 'string' || !row._id || ids.has(row._id)) throw new Error(name + ' 存在缺失或重复的记录编号');
      ids.add(row._id);
      if (row.openid) owners.add(row.openid);
    });
    if (parsed.counts && parsed.counts[name] !== undefined && parsed.counts[name] !== data[name].length) throw new Error('备份记录数校验失败：' + name);
  });
  if (owners.size > 1) throw new Error('备份包含多个账号的数据，不能合并归属');
  return parsed;
}
function snapshot(api) {
  const data = {}, counts = {};
  COLLECTIONS.forEach(name => { data[name] = api.getStorageSync(PREFIX + name); counts[name] = data[name].length; });
  data.__seq = api.getStorageSync(PREFIX + '__seq');
  return { app: 'clothing-pos-miniapp', version: 2, exportedAt: new Date().toISOString(), counts, data };
}
async function exportData(raw) {
  const api = createAtomicStorage(raw);
  return api.transaction(() => {
    const payload = snapshot(api);
    return { json: JSON.stringify(payload, null, 2), counts: payload.counts, exportedAt: payload.exportedAt };
  });
}
async function importData(raw, json, mode) {
  if (mode !== 'merge' && mode !== 'overwrite') throw new Error('请选择合并或覆盖模式');
  const parsed = validateBackup(json);
  const api = createAtomicStorage(raw);
  return api.transaction(() => {
    const original = snapshot(api), imported = {};
    const owner = api.getStorageSync('cpos_openid') || ('local_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
    let seq = Math.max(original.data.__seq || 0, parsed.data.__seq || 0);
    const changes = {};
    COLLECTIONS.forEach(name => {
      if (mode === 'merge' && (name === 'settings' || parsed.data[name] === undefined)) return;
      const incoming = (parsed.data[name] || []).map(row => Object.assign({}, row, { openid: owner }));
      incoming.forEach(row => { const match = /^lcf-[a-z0-9]+-(\d+)$/.exec(row._id); if (match) seq = Math.max(seq, Number(match[1])); });
      if (mode === 'merge') {
        const rows = original.data[name].slice(), byId = new Map(rows.map(row => [row._id, row]));
        incoming.forEach(row => {
          const current = byId.get(row._id);
          if (current && stable(current) !== stable(row)) throw new Error('合并冲突：' + name + ' 的记录 ' + row._id + ' 已有不同内容；原数据未修改');
          if (!current) { rows.push(row); byId.set(row._id, row); }
        });
        changes[name] = rows;
      } else changes[name] = incoming;
      imported[name] = incoming.length;
    });
    const finalGoods = new Set((changes.goods || original.data.goods).map(row => row._id));
    const originalGoods = new Set(original.data.goods.map(row => row._id));
    ['sales_orders', 'purchase_orders', 'inventory_logs'].forEach(name => {
      const previousIds = new Set(original.data[name].map(row => row._id));
      const rows = changes[name] || original.data[name];
      rows.forEach(row => {
        if (mode === 'merge' && previousIds.has(row._id)) return;
        const refs = name === 'inventory_logs' ? [row.goodsId] : (row.lines || []).map(line => line.goodsId);
        refs.forEach(id => {
          // 完整备份的 goods:[] 可代表商品已删除、历史流水保留；缺少整个 goods 集合则无法判断。
          if (!id || (!finalGoods.has(id) && parsed.data.goods === undefined)) throw new Error('备份缺少商品集合，请使用完整备份');
          if (mode === 'merge' && !previousIds.has(row._id) && originalGoods.has(id)) {
            throw new Error('新增订单或流水涉及已有商品，无法确认库存是否已计入；请使用完整备份覆盖恢复');
          }
        });
      });
    });
    // 恢复前副本与新账本使用同一个提交点，失败时两者均保持原样。
    api.setStorageSync(RESTORE_BACKUP_KEY, original);
    api.setStorageSync('cpos_openid', owner);
    Object.keys(changes).forEach(name => api.setStorageSync(PREFIX + name, changes[name]));
    api.setStorageSync(PREFIX + '__seq', seq);
    return { imported, exportedAt: parsed.exportedAt, mode };
  });
}
module.exports = { exportData, importData, validateBackup, RESTORE_BACKUP_KEY };
