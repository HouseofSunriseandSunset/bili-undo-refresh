'use strict';
/**
 * 定位哔哩哔哩 PC 客户端的 app.asar。
 *
 * 查找顺序：
 *   1) 命令行显式传入（--asar / 位置参数），支持传 .asar 文件、resources 目录、
 *      客户端安装目录、或客户端 exe 路径
 *   2) 注册表卸载信息里的 UninstallString（最可靠）
 *   3) 常见安装目录
 *
 * 纯 Node 实现，不依赖第三方库；同时兼容 Node 16（客户端自带运行时）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ASAR_REL = path.join('resources', 'app.asar');

/** 把一个模糊输入规范化成 app.asar 路径；失败返回 null */
function normalize(input) {
  if (!input) return null;
  let p = path.resolve(String(input));
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      // 依次尝试：目录本身就是 resources / 客户端根目录
      const direct = path.join(p, 'app.asar');
      if (fs.existsSync(direct)) return direct;
      const rel = path.join(p, ASAR_REL);
      if (fs.existsSync(rel)) return rel;
      return null;
    }
  } catch (e) {
    return null;
  }
  // 是文件
  if (/\.asar$/i.test(p)) return fs.existsSync(p) ? p : null;
  if (/\.exe$/i.test(p)) {
    const rel = path.join(path.dirname(p), ASAR_REL);
    return fs.existsSync(rel) ? rel : null;
  }
  return null;
}

/** 从注册表读取客户端安装目录 */
function registryDirs() {
  const out = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BiliBili',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\哔哩哔哩',
  ];
  for (const key of keys) {
    try {
      const txt = execFileSync('reg', ['query', key, '/v', 'UninstallString'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // 形如:     UninstallString    REG_SZ    D:\bilibili\卸载哔哩哔哩.exe
      const m = txt.match(/([A-Za-z]:\\[^\r\n]+?\.exe)/);
      if (m) {
        const dir = path.dirname(m[1]);
        if (out.indexOf(dir) < 0) out.push(dir);
      }
    } catch (e) {
      /* 键不存在，继续 */
    }
  }
  return out;
}

/** 常见安装目录 */
function commonDirs() {
  const list = [];
  const drives = ['C:', 'D:', 'E:', 'F:'];
  const rels = ['bilibili', 'Bilibili', 'BILI', path.join('Program Files', 'bilibili'), path.join('Program Files (x86)', 'bilibili')];
  for (const d of drives) {
    for (const r of rels) list.push(path.join(d + path.sep, r));
  }
  const local = process.env.LOCALAPPDATA;
  if (local) list.push(path.join(local, 'Programs', 'bilibili'), path.join(local, 'bilibili'));
  const pf = process.env.ProgramFiles;
  if (pf) list.push(path.join(pf, 'bilibili'));
  const pf86 = process.env['ProgramFiles(x86)'];
  if (pf86) list.push(path.join(pf86, 'bilibili'));
  return list;
}

/**
 * 查找客户端 app.asar。
 * @param {string} [hint] 用户显式传入的路径（可为空）
 * @returns {{asar: string|null, tried: string[]}}
 */
function findClientAsar(hint) {
  const tried = [];
  if (hint) {
    const norm = normalize(hint);
    tried.push(String(hint));
    if (norm) return { asar: norm, tried };
    return { asar: null, tried };
  }
  for (const dir of registryDirs()) {
    tried.push(dir + ' (注册表)');
    const norm = normalize(dir);
    if (norm) return { asar: norm, tried };
  }
  for (const dir of commonDirs()) {
    tried.push(dir);
    const norm = normalize(dir);
    if (norm) return { asar: norm, tried };
  }
  return { asar: null, tried };
}

/** 找出客户端主程序 exe（用于把 Electron 当 Node 运行时） */
function findClientExe(asarPath) {
  try {
    const root = path.dirname(path.dirname(asarPath)); // <客户端>\resources\app.asar -> <客户端>
    const files = fs.readdirSync(root).filter((f) => /\.exe$/i.test(f));
    let best = null;
    for (const f of files) {
      if (/^卸载/.test(f) || /uninstall/i.test(f)) continue; // 排除卸载器
      const p = path.join(root, f);
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch (e) {}
      if (!best || size > best.size) best = { path: p, size };
    }
    return best ? best.path : null;
  } catch (e) {
    return null;
  }
}

module.exports = { findClientAsar, findClientExe, normalize, registryDirs, commonDirs };
