// 大账本分块保存，最后切换小索引；索引提交失败时仍读取上一份完整账本。
// 衣柜保留历史分块格式标识，保证已有账本和恢复备份兼容。
const FORMAT = 'danjie-chunks-v1';
const CHUNK_SIZE = 120000;
let generation = 0;
function chunkKeys(value, key) {
  if (!value || value.format !== FORMAT) return [];
  if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 200 || !Number.isSafeInteger(value.length) || value.length < 0) throw new Error('账本分块索引损坏');
  const keys = value.keys;
  if (new Set(keys).size !== keys.length || keys.some(k => typeof k !== 'string' || k.indexOf(key + '.part.') !== 0 || !/^[a-z0-9_-]+\.\d+$/.test(k.slice((key + '.part.').length)))) throw new Error('账本分块路径无效');
  return keys;
}
function readStored(raw, key) {
  const value = raw.getStorageSync(key);
  const keys = chunkKeys(value, key);
  if (!keys.length) return value;
  const text = keys.map(k => {
    const part = raw.getStorageSync(k);
    if (typeof part !== 'string') throw new Error('账本分块缺失，请保留数据并恢复有效备份');
    return part;
  }).join('');
  if (text.length !== value.length) throw new Error('账本分块长度校验失败');
  try { return JSON.parse(text); } catch (e) { throw new Error('账本分块内容损坏'); }
}
function removeChunks(raw, keys) {
  if (typeof raw.removeStorageSync !== 'function') return;
  keys.forEach(key => { try { raw.removeStorageSync(key); } catch (e) { /* 清理失败不影响已提交账本。 */ } });
}
function writeStored(raw, key, value) {
  const previous = chunkKeys(raw.getStorageSync(key), key);
  // 应用可能在分块写入途中被结束；只回收本账本命名空间内未被当前索引引用的分块。
  if (typeof raw.getStorageInfoSync === 'function' && typeof raw.removeStorageSync === 'function') {
    const info = raw.getStorageInfoSync();
    const prefix = key + '.part.';
    const orphans = (info.keys || []).filter(k => k.indexOf(prefix) === 0 && /^[a-z0-9_-]+\.\d+$/.test(k.slice(prefix.length)) && previous.indexOf(k) < 0);
    removeChunks(raw, orphans);
  }
  const text = JSON.stringify(value), next = [];
  if (text.length > CHUNK_SIZE * 200) throw new Error('账本过大，请先导出备份并联系维护人员');
  try {
    if (text.length <= CHUNK_SIZE) raw.setStorageSync(key, value);
    else {
      const id = Date.now().toString(36) + '_' + (++generation).toString(36) + '_' + Math.random().toString(36).slice(2);
      for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
        const partKey = key + '.part.' + id + '.' + next.length;
        next.push(partKey);
        raw.setStorageSync(partKey, text.slice(offset, offset + CHUNK_SIZE));
      }
      raw.setStorageSync(key, { format: FORMAT, keys: next, length: text.length });
    }
  } catch (e) { removeChunks(raw, next); throw e; }
  removeChunks(raw, previous);
}
module.exports = { readStored, writeStored };
