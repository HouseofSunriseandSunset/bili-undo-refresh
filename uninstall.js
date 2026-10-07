'use strict';
/**
 * 「撤回刷新」插件 —— 卸载脚本
 *
 *   node uninstall.js [--asar "D:\bilibili\resources\app.asar"] [--purge]
 *
 * 默认从最近一个「干净的原版备份」还原 app.asar。
 * --purge 额外删除生成的 config.json。
 * 还原后页面里残留的悬浮面板会随客户端重启消失；会话快照存在 sessionStorage，
 * 关闭客户端即清空。
 */
const fs = require('fs');
const path = require('path');
const { readAsar, closeAsar, readFile } = require('./asar-lib');
const { findClientAsar } = require('./client-locator');

const MARK = '/* __BILI_UNDO_REFRESH_PATCH__ */';
const DIR = __dirname;

function parseArgs() {
  const a = { asar: null, help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      if (!a.asar && !/^-/.test(raw)) a.asar = raw;
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
  console.log(['用法: node uninstall.js [app.asar 路径] [--purge]', '', '  不传路径时自动查找客户端；--purge 同时删除 config.json'].join('\n'));
  process.exit(0);
}

const located = findClientAsar(args.asar);
if (!located.asar) {
  console.error('\n[卸载失败] 没有找到哔哩哔哩客户端的 app.asar');
  if (args.asar) console.error('你指定的是:', args.asar);
  else for (const t of located.tried) console.error('  - ' + t);
  console.error('\n请手动指定，例如： uninstall.cmd "D:\\bilibili"');
  process.exit(2);
}
const ASAR = located.asar;
const dirName = path.dirname(ASAR);
const baseName = path.basename(ASAR);

console.log('== 哔哩哔哩「撤回刷新」插件 卸载 ==');
console.log('目标 asar:', ASAR);

if (!fs.existsSync(ASAR)) {
  console.error('找不到 app.asar：' + ASAR);
  process.exit(1);
}

const backups = fs
  .readdirSync(dirName)
  .filter((f) => f.startsWith(baseName + '.bak-'))
  .sort()
  .map((f) => path.join(dirName, f));

let chosen = null;
for (const b of backups) {
  let a = null;
  try {
    a = readAsar(b);
    const e1 = readFile(a, '/index.js');
    const e2 = readFile(a, '/main/index.js');
    const clean = [e1, e2].every((b2) => !b2 || !b2.toString('utf8').includes(MARK));
    if (clean) chosen = b;
  } catch (e) {
    /* 忽略损坏备份 */
  } finally {
    if (a) closeAsar(a);
  }
}

if (!chosen) {
  console.error('\n未找到干净的原版备份（app.asar.bak-*）。');
  console.error('可选做法：用官方安装包重新安装客户端，或用安装脚本生成的备份手动覆盖。');
  process.exit(2);
}

try {
  fs.copyFileSync(chosen, ASAR);
  console.log('已从备份还原:', chosen);
} catch (e) {
  console.error('\n还原失败（客户端可能仍在运行，请先关闭）：' + e.message);
  process.exit(1);
}

if (args.purge) {
  try {
    const cfg = path.join(DIR, 'config.json');
    if (fs.existsSync(cfg)) {
      fs.unlinkSync(cfg);
      console.log('已删除 config.json');
    }
  } catch (e) {}
}

console.log('\n== 卸载完成 ==');
console.log('· 备份文件仍保留在客户端目录，如需彻底清理可手动删除 app.asar.bak-*');
