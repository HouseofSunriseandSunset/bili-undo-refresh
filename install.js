'use strict';
/**
 * 「撤回刷新」插件 —— 安装脚本
 *
 *   node install.js [--asar "D:\bilibili\resources\app.asar"] [--yes]
 *
 * 做两件事：
 *   1) 生成 config.json（指向本目录的 preload.js）
 *   2) 把 app.asar 的入口 /index.js 与 /main/index.js 打上一行 require(loader.js)
 *      原版会先被备份为 app.asar.bak-<时间戳>
 *
 * 安装前请关闭哔哩哔哩客户端（文件被占用会失败）。
 */
const fs = require('fs');
const path = require('path');
const { readAsar, closeAsar, readFile, packAsar } = require('./asar-lib');
const { findClientAsar } = require('./client-locator');

const MARK = '/* __BILI_UNDO_REFRESH_PATCH__ */';
const ENTRIES = ['/index.js', '/main/index.js'];
const DIR = __dirname;
const LOADER = path.join(DIR, 'loader.js');
const TESTED_CLIENT = '1.17.5';

function parseArgs() {
  const a = { asar: null, help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      if (!a.asar && !/^-/.test(raw)) a.asar = raw; // 位置参数也当 --asar
      continue;
    }
    if (m[1] === 'help') a.help = true;
    else if (m[2] !== undefined) a[m[1]] = m[2];
    else if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) a[m[1]] = argv[++i];
    else a[m[1]] = true;
  }
  return a;
}

const args = parseArgs();

if (args.help) {
  console.log(
    [
      '用法: node install.js [app.asar 路径]',
      '',
      '  不传路径时会自动查找客户端（注册表 → 常见目录）。',
      '  路径可以传：app.asar 文件 / resources 目录 / 客户端安装目录 / 客户端 exe。',
      '',
      '示例:',
      '  node install.js',
      '  node install.js "D:\\bilibili\\resources\\app.asar"',
      '  node install.js "E:\\bilibili"',
    ].join('\n')
  );
  process.exit(0);
}

const located = findClientAsar(args.asar);
if (!located.asar) {
  console.error('\n[安装失败] 没有找到哔哩哔哩客户端的 app.asar');
  if (args.asar) {
    console.error('你指定的是:', args.asar, '（不是有效的 asar / 安装目录）');
  } else {
    console.error('已尝试以下位置：');
    for (const t of located.tried) console.error('  - ' + t);
    console.error('\n请手动指定，例如：');
    console.error('  install.cmd "D:\\bilibili"');
    console.error('  node install.js "D:\\bilibili\\resources\\app.asar"');
  }
  process.exit(2);
}
const ASAR = located.asar;

function fail(msg) {
  console.error('\n[安装失败] ' + msg);
  process.exit(1);
}

function injectionLine(payloadAbs) {
  return `\n${MARK}try{globalThis.__BILI_UNDO_REFRESH_PATCH__=true;require(${JSON.stringify(
    payloadAbs
  )});}catch(e){try{console.error('[undo-refresh] patch load failed',e);}catch(_){}}\n`;
}

function stripPatch(src) {
  const out = String(src);
  const first = out.indexOf(MARK);
  if (first < 0) return out;
  const second = out.indexOf(MARK, first + MARK.length);
  if (second < 0) {
    const eol = out.indexOf('\n', first);
    return out.slice(0, first) + (eol < 0 ? '' : out.slice(eol + 1));
  }
  const eol = out.indexOf('\n', second);
  return out.slice(0, first) + (eol < 0 ? '' : out.slice(eol + 1));
}

console.log('== 哔哩哔哩「撤回刷新」插件 安装 ==');
console.log('插件目录:', DIR);
console.log('客户端 asar:', ASAR);

if (!fs.existsSync(ASAR)) fail('找不到 app.asar：' + ASAR);
if (!fs.existsSync(LOADER)) fail('插件不完整，缺少 loader.js');

// 0) 版本提示：不同客户端版本可能改了接口参数或刷新按钮
try {
  const a = readAsar(ASAR);
  try {
    const pkg = readFile(a, '/package.json');
    if (pkg) {
      const v = (JSON.parse(pkg.toString('utf8')) || {}).version;
      console.log('客户端版本:', v || '(未知)');
      if (v && v !== TESTED_CLIENT) {
        console.log('');
        console.log('提示：本插件在客户端 ' + TESTED_CLIENT + ' 上完整验证过，当前是 ' + v + '。');
        console.log('      app.asar 的结构通常一致，可以继续安装；');
        console.log('      若安装后刷新按钮点撤回没反应，多半是接口参数或按钮选择器变了，');
        console.log('      可按 README 的「可调参数」调整 FEED_RE / REFRESH_SELECTORS。');
        console.log('');
      }
    }
  } finally {
    closeAsar(a);
  }
} catch (e) {
  console.log('（读取客户端版本失败，继续安装）', e && e.message);
}

// 1) 生成 config.json
const cfgPath = path.join(DIR, 'config.json');
const cfg = {
  preload: path.join(DIR, 'preload.js'),
  note: 'Edit this file is enough - no need to repatch app.asar; restart the client to take effect.',
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1) + '\n');
console.log('已写入 config.json ->', cfg.preload);

// 2) 检查/创建备份
const dirName = path.dirname(ASAR);
const baseName = path.basename(ASAR);
const backups = fs.readdirSync(dirName).filter((f) => f.startsWith(baseName + '.bak-'));
let backupPath = null;
for (const b of backups.sort()) {
  const p = path.join(dirName, b);
  let a = null;
  try {
    a = readAsar(p);
    const entry = readFile(a, '/index.js');
    if (entry && !entry.toString('utf8').includes(MARK)) {
      backupPath = p; // 找到一个干净的原版备份
      break;
    }
  } catch (e) {
    /* 损坏的备份忽略 */
  } finally {
    if (a) closeAsar(a);
  }
}
if (!backupPath) {
  let a = null;
  try {
    a = readAsar(ASAR);
    const entries = ENTRIES.map((e) => {
      const b = readFile(a, e);
      return b ? b.toString('utf8') : null;
    });
    const patched = entries.some((s) => s && s.includes(MARK));
    closeAsar(a);
    a = null;
    if (patched) {
      fail('当前 app.asar 已是打过补丁的版本，且找不到干净原版备份。请先重新安装客户端或手动恢复。');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${ASAR}.bak-${stamp}`;
    fs.copyFileSync(ASAR, backupPath);
    console.log('已备份原版 ->', backupPath);
  } catch (e) {
    if (a) closeAsar(a);
    fail('读取 app.asar 失败：' + e.message);
  }
} else {
  console.log('已有干净备份 ->', backupPath);
}

// 3) 打补丁
let a = null;
try {
  a = readAsar(ASAR);
} catch (e) {
  fail('读取 app.asar 失败：' + e.message);
}
const replacements = new Map();
let patchedCount = 0;
for (const entry of ENTRIES) {
  const buf = readFile(a, entry);
  if (!buf) {
    console.log('入口不存在，跳过:', entry);
    continue;
  }
  const base = stripPatch(buf.toString('utf8'));
  const next = injectionLine(LOADER) + base;
  replacements.set(entry, Buffer.from(next, 'utf8'));
  patchedCount++;
  console.log('入口已注入:', entry, buf.length, '->', next.length);
}
closeAsar(a);

if (!patchedCount) fail('两个入口都不存在，未做任何修改');

try {
  const res = packAsar({ srcFile: ASAR, destFile: ASAR + '.tmp', replacements });
  fs.renameSync(ASAR + '.tmp', ASAR);
  console.log('补丁写入完成:', res);
} catch (e) {
  try {
    fs.unlinkSync(ASAR + '.tmp');
  } catch (e2) {}
  fail('写入失败（客户端可能仍在运行）：' + e.message);
}

console.log('\n== 安装完成 ==');
console.log('· 启动客户端后，首页「推荐」右下角会出现【撤回刷新】面板');
console.log('· 快捷键：Alt+Z 撤回 / Alt+Shift+Z 重做');
console.log('· 备份文件:', backupPath);
console.log('· 卸载：node uninstall.js   （从备份还原）');
