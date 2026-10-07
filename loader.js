/* 「撤回刷新」插件 —— 主进程加载器
 *
 * 由 app.asar 入口的一行 require(<本文件绝对路径>) 引入。它只做两件长期不变的事：
 *   1) 读取同目录 config.json，把其中的 preload 注册到 Electron 会话
 *   2) 记录加载日志，便于排查
 *
 * 这样设计的目的：以后修改插件逻辑，只需改 preload.js / main-world.js 并重启客户端，
 * 不必重新修改 app.asar。
 *
 * 可选环境变量：
 *   BILI_UNDO_LOG          自定义日志文件路径
 *   BILI_UNDO_DEBUG_PORT   打开远程调试端口（默认不打开）
 *   BILI_UNDO_PRELOAD      直接指定 preload 路径（覆盖 config.json）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');
const LOGFILE =
  process.env.BILI_UNDO_LOG || path.join(process.env.USERPROFILE || process.env.HOME || DIR, 'bili-undo-refresh.log');

function log(...a) {
  const line =
    new Date().toISOString() +
    ' ' +
    a
      .map((x) => {
        if (typeof x === 'string') return x;
        try {
          return JSON.stringify(x);
        } catch (e) {
          return String(x);
        }
      })
      .join(' ');
  try {
    const st = fs.statSync(LOGFILE);
    if (st.size > 2 * 1024 * 1024) {
      // 简单轮转：保留尾部
      const old = fs.readFileSync(LOGFILE, 'utf8').split('\n');
      fs.writeFileSync(LOGFILE, old.slice(-2000).join('\n') + line + '\n');
    } else {
      fs.appendFileSync(LOGFILE, line + '\n');
    }
  } catch (e) {
    try {
      fs.appendFileSync(LOGFILE, line + '\n');
    } catch (e2) {}
  }
  try {
    console.log('[撤回刷新] ' + line);
  } catch (e) {}
}

log('loader 启动', { version: '1.0.0', dir: DIR });

function resolvePreload() {
  try {
    if (fs.existsSync(CONFIG)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      if (cfg && typeof cfg.preload === 'string') {
        const p = cfg.preload.split('__PLUGIN_DIR__').join(DIR);
        if (fs.existsSync(p)) return p;
        log('config.json 指定的 preload 不存在', p);
      }
    } else {
      log('config.json 不存在', CONFIG);
    }
  } catch (e) {
    log('读取 config.json 失败', e && e.message);
  }
  const fallback = path.join(DIR, 'preload.js');
  return fs.existsSync(fallback) ? fallback : null;
}

// 可选调试端口（默认关闭，避免影响正常使用）
try {
  const port = process.env.BILI_UNDO_DEBUG_PORT;
  if (port && !process.argv.some((x) => String(x).startsWith('--remote-debugging-port'))) {
    process.argv.push('--remote-debugging-port=' + port, '--remote-allow-origins=*');
    log('已启用调试端口', port);
  }
} catch (e) {}

let electron = null;
try {
  electron = require('electron');
} catch (e) {
  log('require(electron) 失败', e && e.message);
}

if (electron && electron.app) {
  const { app, session } = electron;
  const PRELOAD = process.env.BILI_UNDO_PRELOAD || resolvePreload();
  log('preload =', PRELOAD);

  app.whenReady().then(() => {
    try {
      if (!PRELOAD) {
        log('没有可注册的 preload，插件不会生效');
        return;
      }
      const s = session.defaultSession;
      const existing = typeof s.getPreloads === 'function' ? s.getPreloads() : [];
      if (typeof s.setPreloads === 'function') {
        s.setPreloads(existing.concat([PRELOAD]));
        log('已注册插件 preload，总数', existing.length + 1);
      } else {
        log('当前 Electron 不支持 setPreloads');
      }
    } catch (e) {
      log('注册 preload 失败', e && e.stack);
    }
  });

  // 兜底：窗口创建时若该 session 还没注册，再补一次
  try {
    app.on('web-contents-created', (_e, wc) => {
      try {
        const s = wc.session;
        if (PRELOAD && s && typeof s.getPreloads === 'function' && typeof s.setPreloads === 'function') {
          const list = s.getPreloads();
          if (list.indexOf(PRELOAD) < 0) {
            s.setPreloads(list.concat([PRELOAD]));
            log('兜底注册 preload');
          }
        }
      } catch (e) {}
      try {
        wc.on('did-finish-load', () => log('did-finish-load', wc.getURL()));
      } catch (e) {}
    });
  } catch (e) {}
}
