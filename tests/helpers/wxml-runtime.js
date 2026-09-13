const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const compiler = process.env.WX_WCC || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc';
const available = fs.existsSync(compiler);
let compiled;

function render(name, data) {
  if (!compiled) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-wxml-'));
    const output = path.join(directory, 'render.js');
    const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).pages;
    const result = spawnSync(compiler, ['-o', output, ...pages.map(page => page + '.wxml')], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'WXML compilation failed');
    compiled = fs.readFileSync(output, 'utf8');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const context = vm.createContext({ window: { __webview_engine_version__: 0.02 }, console });
  vm.runInContext(compiled, context);
  return context.$gwx('pages/' + name + '/' + name + '.wxml')(data);
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flatMap(nodes)];
}
function event(page, name, handler, detail = {}, where = () => true) {
  const item = nodes(render(name, page.data)).find(node => node.attr && node.attr['bind' + handler.type] === handler.name && where(node.attr));
  if (!item) throw new Error(`${name}: rendered ${handler.type} target ${handler.name} is missing`);
  if (item.attr.disabled) throw new Error(`${name}: ${handler.name} is disabled`);
  const dataset = {};
  for (const [key, value] of Object.entries(item.attr)) {
    if (key.startsWith('data-')) dataset[key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  }
  return page[handler.name]({ type: handler.type, currentTarget: { dataset }, target: { dataset }, detail });
}
module.exports = { render, nodes, event, available };
