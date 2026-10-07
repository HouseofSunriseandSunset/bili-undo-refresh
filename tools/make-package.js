'use strict';
/**
 * 生成发布用 zip： dist/bili-undo-refresh-<version>.zip
 *
 *   node tools/make-package.js
 *
 * 打包内容 = 仓库根目录下的插件文件（不含 config.json / 日志 / 本脚本）。
 * 用纯 Node 实现 zip（zlib deflate + CRC32），零第三方依赖。
 * 生成后把 dist 里的 zip 上传到 GitHub Release 即可。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version || '1.0.0';
const ZIP_NAME = `bili-undo-refresh-${VERSION}.zip`;

// ---------------- 最小 ZIP 写入器 ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const data = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(now.time, 10);
    lh.writeUInt16LE(now.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const localOffset = offset;
    locals.push(lh, nameBuf, data);
    offset += lh.length + nameBuf.length + data.length;

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(now.time, 12);
    ch.writeUInt16LE(now.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(localOffset, 42);
    centrals.push(ch, nameBuf);
  }

  const centralBuf = Buffer.concat(centrals);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

// ---------------- 打包 ----------------
const INCLUDE = [
  '开始使用.txt',
  'README.md',
  'install.cmd',
  'uninstall.cmd',
  'install.js',
  'uninstall.js',
  'loader.js',
  'preload.js',
  'main-world.js',
  'asar-lib.js',
  'client-locator.js',
  'config.template.json',
  'package.json',
];

const entries = [];
for (const name of INCLUDE) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) {
    console.log('跳过（不存在）:', name);
    continue;
  }
  entries.push({ name, data: fs.readFileSync(p) });
}

if (!entries.length) {
  console.error('没有可打包的文件');
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, ZIP_NAME);
fs.writeFileSync(out, buildZip(entries));

console.log('已生成:', out);
console.log('版本:', VERSION, ' 大小:', (fs.statSync(out).size / 1024).toFixed(1), 'KB');
console.log('包含文件:');
for (const e of entries) console.log('  -', e.name);
console.log('\n把这个 zip 上传到 GitHub Release 即可。');
