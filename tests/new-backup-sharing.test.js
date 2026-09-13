const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, deferred, flush } = require('./helpers/page-runtime');
const wxml = require('./helpers/wxml-runtime');
const { createLocalCloud } = require('../utils/localcloud');
const { createAtomicStorage } = require('../utils/atomic-storage');

function fixture(t) {
  const values = new Map(), files = new Map(), shares = [], messages = [], gestureErrors = [];
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const raw = {
    getStorageSync: key => copy(values.get(key)),
    setStorageSync: (key, value) => values.set(key, copy(value)),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] })
  };
  const atomic = createAtomicStorage(raw);
  atomic.setStorageSync('cpos_openid', 'backup-owner');
  const cloud = createLocalCloud(atomic);
  const app = { dataCloud: cloud, globalData: { openid: 'backup-owner', dataRevision: 0 }, _resolveTheme: () => 'light' };
  let activeTap = false, writeError = '', shareError = '', heldWrite = null, holdShare = false;
  const wx = { ...raw, env: { USER_DATA_PATH: '/device' },
    showToast: options => messages.push(options.title),
    showModal: options => options.success({ confirm: true }),
    getFileSystemManager: () => ({ writeFile: options => {
      const finish = () => {
        if (writeError) options.fail({ errMsg: writeError });
        else { files.set(options.filePath, options.data); options.success({}); }
      };
      if (heldWrite) heldWrite.promise.then(finish); else setImmediate(finish);
    } }),
    shareFileMessage: options => {
      if (!activeTap) {
        const errMsg = 'shareFileMessage:fail can only be invoked by user TAP gesture';
        gestureErrors.push(errMsg); options.fail({ errMsg }); return;
      }
      shares.push(options);
      if (!holdShare) setImmediate(() => shareError ? options.fail({ errMsg: shareError }) : options.success({}));
    }
  };
  const previousWx = global.wx, previousApp = global.getApp;
  global.wx = wx; global.getApp = () => app;
  const page = loadPage('settings', { wx, app });
  page.onLoad();
  t.after(() => { if (page.onUnload) page.onUnload(); global.wx = previousWx; global.getApp = previousApp; });
  function tap(handler) {
    const node = wxml.nodes(wxml.render('settings', page.data)).find(node => node.attr && node.attr.bindtap === handler);
    assert.ok(node, '应显示可点击的 ' + handler + ' 按钮');
    assert.equal(Boolean(node.attr.disabled), false, handler + ' 应可点击');
    activeTap = true;
    try { return wxml.event(page, 'settings', { type: 'tap', name: handler }); }
    finally { activeTap = false; }
  }
  return { page, app, wx, files, shares, messages, gestureErrors, tap, cloud,
    failWrite: value => { writeError = value; }, failShare: value => { shareError = value; },
    holdWrite: () => { heldWrite = deferred(); return heldWrite; }, holdShare: () => { holdShare = true; } };
}

// The original async export attempts to share after the TAP has ended.
test('生成备份只准备完整文件，等待新的点击再分享', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.cloud.database().collection('customers').add({ data: { openid: 'backup-owner', name: '待备份客户' } });
  await f.tap('doExport');
  assert.deepEqual(f.gestureErrors, []);
  assert.equal(f.shares.length, 0);
  const saved = JSON.parse(f.files.get(f.page.data.lastBackupPath));
  assert.equal(saved.data.customers[0].name, '待备份客户');
  assert.equal(f.page.data.backupBusy, false);
  assert.ok(f.page.data.lastBackupAt);
});

// Awaiting any preparation in the second handler loses the new gesture too.
test('保存分享按钮在新的 TAP 内立即调用分享已生成的文件', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  const path = f.page.data.lastBackupPath;
  const pending = f.tap('shareBackup');
  assert.equal(f.shares.length, 1);
  assert.equal(f.shares[0].filePath, path);
  assert.equal(f.files.size, 1);
  await pending; await flush();
  assert.deepEqual(f.gestureErrors, []);
  assert.equal(f.page.data.backupSharing, false);
});

test('分享失败保留文件且解除锁，再点击可重试而不重新生成', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  const path = f.page.data.lastBackupPath;
  f.failShare('shareFileMessage:fail network error');
  await f.tap('shareBackup'); await flush();
  assert.equal(f.page.data.backupSharing, false);
  assert.equal(f.page.data.lastBackupPath, path);
  assert.ok(f.files.has(path));
  assert.ok(f.messages.some(message => /重试/.test(message)));
  f.failShare('');
  await f.tap('shareBackup'); await flush();
  assert.equal(f.shares.length, 2);
  assert.equal(f.files.size, 1);
});

test('用户取消分享得到友好提示，备份仍可再次分享', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  f.failShare('shareFileMessage:fail cancel');
  await f.tap('shareBackup'); await flush();
  assert.equal(f.page.data.backupSharing, false);
  assert.ok(f.files.has(f.page.data.lastBackupPath));
  assert.ok(f.messages.some(message => /已取消/.test(message)));
  assert.equal(f.messages.some(message => /TAP gesture/.test(message)), false);
});

test('分享处理中重复点击不打开第二份分享菜单', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  f.holdShare();
  const pending = f.tap('shareBackup');
  f.page.shareBackup();
  assert.equal(f.shares.length, 1);
  f.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' });
  await pending;
  assert.equal(f.page.data.backupSharing, false);
});

test('重新生成失败不覆盖上一份文件，随后可重新生成新文件', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  const oldPath = f.page.data.lastBackupPath, oldContent = f.files.get(oldPath);
  f.failWrite('writeFile:fail no space');
  await f.tap('doExport');
  assert.equal(f.page.data.lastBackupPath, oldPath);
  assert.equal(f.files.get(oldPath), oldContent);
  assert.equal(f.page.data.backupBusy, false);
  f.failWrite('');
  await f.tap('doExport');
  assert.notEqual(f.page.data.lastBackupPath, oldPath);
  assert.equal(f.files.get(oldPath), oldContent);
});

// Counts and dataRevision do not change for an ordinary customer edit.
test('账本内容变更但条数不变时，旧文件不能冒充当前备份分享', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  const added = await f.cloud.database().collection('customers').add({ data: { openid: 'backup-owner', name: '旧姓名' } });
  await f.tap('doExport');
  const oldPath = f.page.data.lastBackupPath;
  await f.cloud.database().collection('customers').doc(added._id).update({ data: { name: '新姓名' } });
  await f.tap('shareBackup');
  assert.equal(f.shares.length, 0);
  assert.equal(f.page.data.backupStale, true);
  assert.equal(JSON.parse(f.files.get(oldPath)).data.customers[0].name, '旧姓名');
  await f.tap('doExport');
  assert.equal(f.page.data.backupStale, false);
  await f.tap('shareBackup'); await flush();
  assert.equal(JSON.parse(f.files.get(f.shares[0].filePath)).data.customers[0].name, '新姓名');
});

test('生成文件期间恢复账本，完成后必须提示旧快照并重新生成', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  const write = f.holdWrite();
  const pending = f.tap('doExport');
  await flush();
  f.app.globalData.dataRevision++;
  write.resolve();
  await pending;
  assert.ok(f.files.has(f.page.data.lastBackupPath));
  assert.equal(f.page.data.backupStale, true);
  assert.equal(f.shares.length, 0);
});

test('页面退出后迟到的生成完成不再改页面或启动分享', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  const write = f.holdWrite();
  const pending = f.tap('doExport');
  await flush();
  assert.equal(typeof f.page.onUnload, 'function');
  f.page.onUnload();
  const before = JSON.stringify(f.page.data);
  write.resolve();
  await pending;
  assert.equal(JSON.stringify(f.page.data), before);
  assert.equal(f.shares.length, 0);
});

test('未提交事务的旧内容不能掩盖已提交账本的变更', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  const added = await f.cloud.database().collection('customers').add({ data: { openid: 'backup-owner', name: '备份时姓名' } });
  await f.tap('doExport');
  const original = JSON.parse(f.files.get(f.page.data.lastBackupPath)).data.customers;
  await f.cloud.database().collection('customers').doc(added._id).update({ data: { name: '已提交的新姓名' } });
  const storage = createAtomicStorage(f.wx), staged = deferred(), release = deferred();
  const pending = storage.transaction(async () => {
    storage.setStorageSync('__lcloud_customers', original);
    staged.resolve();
    await release.promise;
    return { success: false };
  });
  try {
    await staged.promise;
    await f.tap('shareBackup');
    assert.equal(f.shares.length, 0);
    assert.equal(f.page.data.backupStale, true);
  } finally { release.resolve(); await pending; }
});

test('当前微信不支持文件分享时保留已生成文件并给出提示', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  delete f.wx.shareFileMessage;
  await f.tap('shareBackup');
  assert.ok(f.files.has(f.page.data.lastBackupPath));
  assert.equal(f.page.data.backupSharing, false);
  assert.ok(f.messages.some(message => /不支持.*分享/.test(message)));
});

test('开发者工具明确不支持分享调试时引导手机微信，不诱导重复重试', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  const filePath = f.page.data.lastBackupPath;
  f.failShare('shareFileMessage:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发');
  await f.tap('shareBackup'); await flush();
  assert.ok(f.messages.some(message => /备份已生成.*手机微信.*保存\/分享/.test(message)));
  assert.equal(f.messages.some(message => /重试/.test(message)), false);
  assert.match(f.page.data.backupMessage, /手机微信/);
  assert.equal(f.page.data.lastBackupPath, filePath);
  assert.ok(f.files.has(filePath));
  assert.equal(f.page.data.backupSharing, false);
});

test('重新读取统计不会因导出时间变化把未改动账本误标旧', { skip: !wxml.available }, async t => {
  const f = fixture(t);
  await f.tap('doExport');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.page.refreshBackupStats();
  assert.equal(f.page.data.backupStale, false);
  await f.tap('shareBackup'); await flush();
  assert.equal(f.shares.length, 1);
  assert.deepEqual(f.gestureErrors, []);
});
