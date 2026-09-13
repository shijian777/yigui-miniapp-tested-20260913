const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadPage(name, { wx = {}, app = { globalData: {} }, modules = {}, pages = [] } = {}) {
  const file = path.resolve(__dirname, '../../pages', name, name + '.js');
  const localRequire = createRequire(file);
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value; },
    require: request => modules[request] || localRequire(request),
    getApp: () => app, getCurrentPages: () => pages, wx,
    // The actual miniapp pages and LocalCloud share one JS realm.
    Date, ArrayBuffer, Uint8Array, Uint8ClampedArray,
    console, setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename: file });
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data || {})) });
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = page.data;
      for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {};
        target = target[part];
      }
      target[parts[parts.length - 1]] = value;
    }
    if (callback) callback();
  };
  return page;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
module.exports = { loadPage, deferred, flush };
