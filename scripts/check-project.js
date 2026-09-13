// Zero-dependency project validation. Uses WeChat's own compilers when available.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
const checked = [];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'h5', 'artifacts'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
for (const file of walk(root)) {
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(result.stderr || result.error?.message);
    checked.push(file);
  } else if (file.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); checked.push(file); }
    catch (error) { failures.push(path.relative(root, file) + ': ' + error.message); }
  }
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
if (config.darkmode && (!config.themeLocation || !fs.existsSync(path.join(root, config.themeLocation)))) {
  failures.push('启用 darkmode 时必须配置存在的 themeLocation 文件。');
}
for (const page of config.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    if (!fs.existsSync(path.join(root, page + '.' + ext))) failures.push('页面文件缺失: ' + page + '.' + ext);
  }
  const jsPath = path.join(root, page + '.js');
  const code = fs.readFileSync(jsPath, 'utf8');
  const template = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
  let definition;
  try {
    vm.runInNewContext(code, {
      Page: value => definition = value, require: createRequire(jsPath), console,
      setTimeout, clearTimeout, setInterval, clearInterval
    }, { filename: jsPath });
    for (const match of template.matchAll(/(?:bind|catch)(?::?[\w]+)\s*=\s*"([^"]+)"/g)) {
      const handlers = match[1].includes('{{')
        ? Array.from(match[1].matchAll(/'([\w]+)'/g), item => item[1]) : [match[1]];
      for (const handler of handlers) {
        if (typeof definition?.[handler] !== 'function') failures.push(page + ': 缺少事件方法 ' + handler);
      }
    }
    for (const match of code.matchAll(/\/pages\/([\w-]+\/[\w-]+)/g)) {
      if (!config.pages.includes('pages/' + match[1])) failures.push(page + ': 跳转页面未注册 ' + match[0]);
    }
  } catch (error) { failures.push(page + ': ' + error.message); }
}
for (const tab of config.tabBar.list) {
  for (const key of ['iconPath', 'selectedIconPath']) {
    if (!fs.existsSync(path.join(root, tab[key]))) failures.push('Tab 图标缺失: ' + tab[key]);
  }
}
console.log('已检查 ' + checked.length + ' 个 JS/JSON 文件、' + config.pages.length + ' 个页面及其事件/跳转。');
const compilerRoot = '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clothing-pos-check-'));
for (const [binary, envName, ext, files] of [
  ['wcc', 'WX_WCC', 'js', config.pages.map(page => page + '.wxml')],
  ['wcsc', 'WX_WCSC', 'css', ['app.wxss', ...config.pages.map(page => page + '.wxss')]]
]) {
  const compiler = process.env[envName] || path.join(compilerRoot, binary);
  if (!fs.existsSync(compiler)) {
    const text = binary + ' 未找到：跳过微信编译，可通过 ' + envName + ' 指定编译器路径。';
    if (process.argv.includes('--require-compiler')) failures.push(text);
    else console.log(text);
    continue;
  }
  const result = spawnSync(compiler, ['-o', path.join(out, binary + '.' + ext), ...files], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) failures.push(binary + ': ' + (result.stderr || result.stdout || result.error?.message));
  else console.log(binary + ': ' + files.length + ' 个模板/样式编译通过。');
}
fs.rmSync(out, { recursive: true, force: true });
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('项目检查通过。');
