const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');
const util = require('../utils/util');

test('BLE discovery accepts WeChat characteristic property objects', async () => {
  const wx = {
    getBLEDeviceServices: options => options.success({ services: [{ uuid: 'service', isPrimary: true }] }),
    getBLEDeviceCharacteristics: options => options.success({ characteristics: [
      { uuid: 'read-only', properties: { read: true, write: false, writeNoResponse: false } },
      { uuid: 'FFE1', properties: { read: false, write: true, writeDefault: false, writeNoResponse: true } }
    ] })
  };
  const page = loadPage('printer', { wx });
  const result = await page.findWritableCharacteristic('printer');
  assert.equal(result && result.characteristicId, 'FFE1');
  assert.equal(result.mode, 'noresp');
});

test('BLE writes use the selected supported write mode', async () => {
  let options;
  const page = loadPage('printer', { wx: { writeBLECharacteristicValue: value => { options = value; value.success({}); } } });
  page.data.writeMode = 'noresp';
  await page.writeOne({ deviceId: 'printer', serviceId: 'service', charId: 'FFE1' }, new ArrayBuffer(1));
  assert.equal(options.writeType, 'writeNoResponse');
});

test('leaving the printer page aborts a pending scan before it starts discovery', async () => {
  const adapter = deferred();
  let discoveries = 0;
  const page = loadPage('printer', { wx: {
    startBluetoothDevicesDiscovery: options => { discoveries++; options.success({}); },
    showToast() {}
  } });
  page.ensureAdapter = () => adapter.promise;
  page.cleanupConnection = async () => {};
  const pending = page.startScan();
  page.onUnload();
  adapter.resolve();
  await pending;
  if (page._scanTimer) clearTimeout(page._scanTimer);
  assert.equal(discoveries, 0);
});

test('a disconnected printer immediately disables printing and aborts transfer', () => {
  let connectionChange;
  const page = loadPage('printer', { wx: {
    onBLEConnectionStateChange: handler => { connectionChange = handler; }
  } });
  page.conn = { deviceId: 'printer' };
  page.data.connected = true;
  page.bindBleEvents();
  assert.equal(typeof connectionChange, 'function');
  connectionChange({ deviceId: 'printer', connected: false });
  assert.equal(page.data.connected, false);
  assert.equal(page.conn, null);
  assert.equal(page._abort, true);
});

test('sharing a receipt does not request album permission and opens one share menu', async () => {
  let albumRequests = 0;
  let shares = 0;
  const file = deferred();
  const page = loadPage('receipt', { wx: {
    getSetting: options => { albumRequests++; options.success({ authSetting: { 'scope.writePhotosAlbum': false } }); },
    showModal: options => options.success({ confirm: false }),
    canvasToTempFilePath: options => file.promise.then(() => options.success({ tempFilePath: '/tmp/receipt.png' })),
    showShareImageMenu: options => { shares++; options.success && options.success({}); },
    showToast() {}
  } });
  page.canvasNode = { width: 384, height: 800 };
  page.data.canvasReady = true;
  page.order = { type: 'sale' };
  const first = page.shareImage();
  const second = page.shareImage();
  file.resolve();
  await Promise.all([first, second]);
  await flush();
  assert.equal(albumRequests, 0);
  assert.equal(shares, 1);
});

test('receipt actions before canvas initialization show a recoverable message', async () => {
  let exports = 0;
  const messages = [];
  const page = loadPage('receipt', { wx: {
    showToast: options => messages.push(options.title),
    canvasToTempFilePath: () => { exports++; }
  } });
  await page.shareImage();
  assert.equal(exports, 0);
  assert.ok(messages.length > 0);
});

test('settings preserve typed text when returning from printer settings', async () => {
  const app = { globalData: { dataRevision: 0 } };
  const stored = { _id: 'settings', storeName: '旧店名', defaultPayment: 'cash', lowStockThreshold: 5 };
  const page = loadPage('settings', { app, wx: { showToast() {} }, modules: {
    '../../utils/util.js': { ensureOpenid: async () => {}, fetchSettings: async () => stored }
  } });
  page.refreshBackupStats = () => {};
  await page.onShow();
  await flush();
  page.onInput({ currentTarget: { dataset: { f: 'storeName' } }, detail: { value: '丹姐秋冬新店名' } });
  await page.onShow();
  await flush();
  assert.equal(page.data.form.storeName, '丹姐秋冬新店名');
});

test('settings loaded slowly cannot overwrite text typed while loading', async () => {
  const result = deferred();
  const page = loadPage('settings', { wx: { showToast() {} }, modules: {
    '../../utils/util.js': { ensureOpenid: async () => {}, fetchSettings: () => result.promise }
  } });
  const pending = page.load();
  await flush();
  page.onInput({ currentTarget: { dataset: { f: 'phone' } }, detail: { value: '+86 13800000000' } });
  result.resolve({ _id: 'settings', phone: '旧电话' });
  await pending;
  assert.equal(page.data.form.phone, '+86 13800000000');
  assert.equal(page.data.docId, 'settings');
});

test('saving settings rejects malformed inventory thresholds instead of silently defaulting', async () => {
  let writes = 0;
  const page = loadPage('settings', { wx: { showToast() {} }, modules: {
    '../../utils/util.js': Object.assign({}, util, { updateDocById: async () => { writes++; } })
  } });
  page.data.docId = 'settings';
  page.data.loadingSettings = false;
  for (const threshold of ['abc', '-1', '2.5', 'Infinity']) {
    page.data.form.lowStockThresholdStr = threshold;
    await page.save();
  }
  assert.equal(writes, 0);
});

test('saving before the initial settings read completes cannot erase existing fields', async () => {
  const read = deferred();
  let writes = 0;
  const page = loadPage('settings', { wx: { showToast() {} }, modules: {
    '../../utils/util.js': Object.assign({}, util, {
      ensureOpenid: async () => {}, fetchSettings: () => read.promise,
      updateDocById: async () => { writes++; return 1; }
    })
  } });
  const loading = page.load();
  await flush();
  page.onInput({ currentTarget: { dataset: { f: 'storeName' } }, detail: { value: '新店名' } });
  const saving = page.save();
  read.resolve({ _id: 'settings', storeName: '旧店名', phone: '原联系电话', defaultPayment: 'wechat' });
  await Promise.all([loading, saving]);
  assert.equal(writes, 0);
  assert.equal(page.data.form.storeName, '新店名');
  assert.equal(page.data.form.phone, '原联系电话');
});

test('old printer cleanup never closes or clears a newer connection', async () => {
  const stopped = deferred();
  const closed = [];
  const page = loadPage('printer', { wx: {
    stopBluetoothDevicesDiscovery: options => stopped.promise.then(() => options.success({})),
    closeBLEConnection: options => { closed.push(options.deviceId); options.success({}); }
  } });
  page.conn = { deviceId: 'old-printer' };
  const cleaning = page.cleanupConnection(false);
  page.conn = { deviceId: 'new-printer' };
  page.data.connected = true;
  stopped.resolve();
  await cleaning;
  assert.deepEqual(closed, ['old-printer']);
  assert.equal(page.conn.deviceId, 'new-printer');
  assert.equal(page.data.connected, true);
});
