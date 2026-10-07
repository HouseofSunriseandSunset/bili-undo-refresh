/* 哔哩哔哩 PC 客户端 · 「撤回刷新」插件（preload 侧 / 隔离世界）
 *
 * 职责：
 *   1) 把 main-world.js 注入页面主世界（网络劫持必须在主世界生效）
 *   2) 与主世界建立命令/状态通道：
 *        · 命令写在 <html data-bili-undo-cmd="{seq,cmd}">（跨 world 可见）
 *        · 每个命令追加一个新的 <script data-seq=N> 节点执行主世界代码
 *          （同一节点重设 textContent 不会重新执行，必须新建节点）
 *        · 结果由主世界写回该节点自身的 data-bili-undo-res
 *   3) 绘制右下角悬浮面板：撤回刷新 / 重做 / 清空历史
 *   4) 快捷键 Alt+Z 撤回、Alt+Shift+Z 重做
 *   5) 撤回时先让主世界准备快照，再点击客户端自带的刷新按钮触发回放
 *
 * 只作用于主窗口（index.html）；播放器等其它窗口会互相覆盖面板状态，故跳过。
 */
'use strict';
(function () {
  const VERSION = '1.0.0';
  const TAG = '[撤回刷新]';
  const SCRIPT_ID = '__bili_undo_run__';
  const MAIN_FILE = 'main-world.js';

  let fs = null;
  let pathMod = null;
  try {
    fs = require('fs');
    pathMod = require('path');
  } catch (e) {}

  const DIAG_KEEP = 2000; // 内存/文件中最多保留的日志行数
  const DIAG_TRIM_AT = 4000; // 超过该行数才落盘压缩
  let diagPath = null;
  let diagBuf = null;
  function resolveDiagPath() {
    if (diagPath) return diagPath;
    try {
      if (process.env.BILI_UNDO_LOG) diagPath = process.env.BILI_UNDO_LOG;
      else if (process.env.USERPROFILE || process.env.HOME) {
        diagPath = pathMod.join(process.env.USERPROFILE || process.env.HOME, 'bili-undo-refresh.log');
      } else if (typeof __dirname === 'string') {
        diagPath = pathMod.join(__dirname, 'bili-undo-refresh.log');
      }
    } catch (e) {}
    return diagPath;
  }
  function diagFlush(force) {
    if (diagBuf == null) return;
    // 行数不多时直接追加（成本最低）
    if (!force && diagBuf.length < DIAG_TRIM_AT) {
      try {
        fs.appendFileSync(diagPath, diagBuf.join('\n') + '\n');
      } catch (e) {}
      diagBuf = [];
      return;
    }
    // 压缩：只保留最后 DIAG_KEEP 行
    if (diagBuf.length >= DIAG_TRIM_AT || force) {
      const keep = diagBuf.slice(Math.max(0, diagBuf.length - DIAG_KEEP));
      try {
        fs.writeFileSync(diagPath, keep.join('\n') + '\n');
      } catch (e) {}
      diagBuf = keep;
      if (diagBuf.length > DIAG_KEEP) diagBuf = diagBuf.slice(-DIAG_KEEP);
    }
  }
  function diag(level, args) {
    try {
      const p = resolveDiagPath();
      if (!p || !fs) return;
      const line =
        new Date().toISOString() +
        ' [' +
        level +
        '] ' +
        args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch (e) {
              return String(a);
            }
          })
          .join(' ');
      if (diagBuf == null) diagBuf = [];
      diagBuf.push(line);
      if (level === 'error' || diagBuf.length >= DIAG_TRIM_AT) diagFlush(false);
      else if (diagBuf.length && diagBuf.length % 20 === 0) diagFlush(false);
    } catch (e) {}
  }
  // 启动时把上一轮的日志尾巴读进来，随后按需压缩
  try {
    const p0 = resolveDiagPath();
    if (p0 && fs && fs.existsSync(p0)) {
      const old = fs.readFileSync(p0, 'utf8');
      const arr = old.split('\n').filter(Boolean);
      diagBuf = arr.slice(Math.max(0, arr.length - DIAG_KEEP));
      fs.writeFileSync(p0, diagBuf.join('\n') + (diagBuf.length ? '\n' : ''));
    } else {
      diagBuf = [];
    }
  } catch (e) {
    diagBuf = [];
  }
  try {
    process.on('exit', () => {
      try {
        diagFlush(false);
      } catch (e) {}
    });
  } catch (e) {}
  try {
    const origLog = console.log;
    const origErr = console.error;
    console.log = function (...a) {
      diag('log', a);
      try {
        origLog.apply(console, a);
      } catch (e) {}
    };
    console.error = function (...a) {
      diag('error', a);
      try {
        origErr.apply(console, a);
      } catch (e) {}
    };
  } catch (e) {}

  const log = (...a) => {
    try {
      console.log(TAG, ...a);
    } catch (e) {}
  };

  // 只作用于主窗口（index.html）。播放器/其他窗口虽然同源，但会互相覆盖面板状态。
  function isMainWindow() {
    try {
      const p = String(location.pathname || '');
      if (!/\/index\.html$/i.test(p)) return false;
      // 主窗口是带 hash 路由的那个（/#/ ）
      return true;
    } catch (e) {
      return false;
    }
  }

  // 主世界（页面 context）的日志通过自定义事件送到隔离世界，再落盘
  const mainLog = (...a) => {
    diag('main', a);
  };
  try {
    window.addEventListener('__bili_undo_log__', (ev) => {
      mainLog('[main-world]', ev && ev.detail);
    });
  } catch (e) {
    diag('error', ['log bridge 注册失败', e && e.message]);
  }
  // 主世界状态一变就主动通知：UI 立即刷新，不必等轮询
  let stateSyncTimer = null;
  try {
    window.addEventListener('__bili_undo_changed__', () => {
      clearTimeout(stateSyncTimer);
      stateSyncTimer = setTimeout(() => {
        try {
          syncState();
        } catch (e) {}
      }, 30);
    });
  } catch (e) {}
  diag('log', ['隔离世界 preload 启动']);

  // ---------------- 读取主世界脚本源码 ----------------
  let sourceCache = null;
  function mainSource() {
    if (sourceCache) return sourceCache;
    const cands = [];
    try {
      if (typeof __dirname === 'string') cands.push(pathMod.join(__dirname, MAIN_FILE));
    } catch (e) {}
    try {
      if (typeof process !== 'undefined' && process.resourcesPath) {
        cands.push(pathMod.join(process.resourcesPath, 'bili-undo-refresh', MAIN_FILE));
      }
    } catch (e) {}
    for (const p of cands) {
      try {
        if (fs && fs.existsSync(p)) {
          sourceCache = fs.readFileSync(p, 'utf8');
          return sourceCache;
        }
      } catch (e) {}
    }
    return null;
  }

  // ---------------- 注入 / 命令通道 ----------------
  // 命令写在 document.documentElement 的 data-bili-undo-cmd 上（跨 world 可见、不会被 DOM 替换）；
  // 每个命令用一个新的 <script> 节点执行主世界代码，结果由主世界写回该节点自身。
  const CMD_ATTR = 'data-bili-undo-cmd';
  const RES_ATTR = 'data-bili-undo-res';

  let seqCounter = 0;
  function execCmd(cmd, payload) {
    return new Promise((resolve) => {
      const root = document.documentElement;
      const parent = document.head || root;
      if (!root || !parent) {
        resolve({ ok: false, error: 'no-dom-root' });
        return;
      }
      const src = mainSource();
      if (!src) {
        diag('error', ['找不到主世界脚本', MAIN_FILE]);
        resolve({ ok: false, error: 'main-world source not found' });
        return;
      }
      const seq = ++seqCounter;
      diag('log', ['execCmd 开始', cmd, 'seq=' + seq]);

      let run = null;
      let done = false;
      let timer = null;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          obs.disconnect();
        } catch (e) {}
        if (timer) clearTimeout(timer);
        resolve(val);
      };

      let obs = null;
      try {
        // 先把执行节点建好并挂上观察器，再写命令并插入脚本
        run = document.createElement('script');
        run.setAttribute('data-seq', String(seq));
        obs = new MutationObserver(() => {
          try {
            const raw = run.getAttribute(RES_ATTR);
            if (!raw) return;
            const o = JSON.parse(raw);
            if (!o || o.seq !== seq) return;
            diag('log', [
              '收到主世界结果 seq=' + o.seq,
              'cmd=' + o.cmd,
              'state=' + JSON.stringify(o.state ? { s: o.state.stackSize, r: o.state.remaining, u: o.state.canUndo, d: o.state.canRedo } : null),
            ]);
            finish(o);
          } catch (e) {}
        });
        obs.observe(run, { attributes: true, attributeFilter: [RES_ATTR] });

        root.setAttribute(CMD_ATTR, JSON.stringify({ seq: seq, cmd: cmd, payload: payload || null }));
        run.textContent = src;
        parent.appendChild(run);
      } catch (e) {
        finish({ ok: false, error: 'exec: ' + e.message });
      }

      timer = setTimeout(() => {
        let last = null;
        try {
          last = run && JSON.parse(run.getAttribute(RES_ATTR) || 'null');
        } catch (e) {}
        diag('error', ['execCmd 超时', cmd, 'seq=' + seq, 'res=' + JSON.stringify(last)]);
        finish({ ok: false, error: 'timeout', last });
      }, 900);

      // 清理旧节点，避免 DOM 无限增长
      try {
        const olds = Array.from(document.querySelectorAll('script[data-seq]'));
        olds.slice(0, Math.max(0, olds.length - 3)).forEach((n) => {
          if (n !== run) {
            try {
              n.parentNode.removeChild(n);
            } catch (e) {}
          }
        });
      } catch (e) {}
    });
  }

  function applyBridgeResult(o) {
    if (!o) return null;
    return o.state || null;
  }

  // ---------------- 触发客户端刷新 ----------------
  const REFRESH_SELECTORS = ['.fixed_buttons--wrapper-btns .vui_button', '.fixed_buttons .vui_button', '.fixed_buttons button'];

  function findRefreshButton() {
    for (const sel of REFRESH_SELECTORS) {
      const list = Array.from(document.querySelectorAll(sel));
      const btn = list.find((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (btn) return btn;
    }
    return null;
  }

  function triggerRefresh() {
    const btn = findRefreshButton();
    if (btn) {
      btn.click();
      return true;
    }
    log('未找到刷新按钮');
    return false;
  }

  // ---------------- 面板（与 B 站客户端观感一致的图标按钮） ----------------
  const PINK = '#FB7299';
  const PINK_DARK = '#E45C85';

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }

  function svg(inner, size) {
    const s = size || 20;
    return (
      '<svg viewBox="0 0 24 24" width="' +
      s +
      '" height="' +
      s +
      '" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner +
      '</svg>'
    );
  }

  // 图1：环形箭头向左 —— 撤回刷新
  const ICON_UNDO = svg(
    '<path d="M8.4 3.8 4.7 7.5l3.7 3.7"/>' +
      '<path d="M4.7 7.5h9.4a5.6 5.6 0 0 1 5.6 5.6 5.6 5.6 0 0 1-5.6 5.6h-3.4"/>'
  );

  // 图2：环形箭头向右 —— 重做
  const ICON_REDO = svg(
    '<path d="M15.6 3.8l3.7 3.7-3.7 3.7"/>' +
      '<path d="M19.3 7.5h-9.4a5.6 5.6 0 0 0-5.6 5.6 5.6 5.6 0 0 0 5.6 5.6h3.4"/>'
  );

  let lastState = null;

  function iconBtn(id, iconSvg, title) {
    const b = el('button', {
      position: 'relative',
      width: '34px',
      height: '34px',
      padding: '0',
      border: 'none',
      borderRadius: '9px',
      background: 'transparent',
      color: '#61666d',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background .15s, color .15s, opacity .15s',
      outline: 'none',
    });
    b.id = id;
    b.title = title;
    b.innerHTML = iconSvg;
    b.addEventListener('mouseenter', () => {
      if (b.disabled) return;
      b.style.background = 'rgba(251,114,153,.12)';
      b.style.color = PINK;
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'transparent';
      b.style.color = b.disabled ? '#c9ccd0' : '#61666d';
    });
    return b;
  }

  function buildPanel() {
    if (document.getElementById('bili-undo-panel')) return true;
    const parent = document.body || document.documentElement;
    if (!parent) return false;

    const pos = loadPanelPos();
    const panel = el('div', {
      position: 'fixed',
      right: pos ? 'auto' : '22px',
      left: pos ? pos.left + 'px' : 'auto',
      top: pos ? pos.top + 'px' : 'auto',
      bottom: pos ? 'auto' : '96px',
      zIndex: '2147483600',
      display: 'none', // 没有可撤回/可重做的内容时不占位置
      alignItems: 'center',
      gap: '2px',
      padding: '4px',
      borderRadius: '12px',
      background: 'rgba(255,255,255,.97)',
      boxShadow: '0 2px 12px rgba(0,0,0,.14)',
      border: '1px solid rgba(0,0,0,.05)',
      backdropFilter: 'blur(8px)',
      userSelect: 'none',
      touchAction: 'none',
      font: '12px/1 "Microsoft YaHei",system-ui,sans-serif',
    });
    panel.id = 'bili-undo-panel';
    panel.title = '长按可拖动调整位置（右键撤回按钮可清空历史）';

    const undoBtn = iconBtn('bili-undo-btn', ICON_UNDO, '撤回刷新（Alt+Z）：回到上一次刷新前的推荐');
    const redoBtn = iconBtn('bili-undo-redo', ICON_REDO, '重做（Alt+Shift+Z）：回到撤回前的那一批');

    // 撤回按钮右上角的可撤步数角标
    const badge = el(
      'span',
      {
        position: 'absolute',
        top: '-2px',
        right: '-2px',
        minWidth: '15px',
        height: '15px',
        padding: '0 3px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        background: PINK,
        color: '#fff',
        fontSize: '10px',
        lineHeight: '15px',
        textAlign: 'center',
        fontWeight: '600',
        display: 'none',
      },
      '1'
    );
    badge.id = 'bili-undo-badge';
    undoBtn.appendChild(badge);

    const divider = el('div', { width: '1px', height: '18px', background: 'rgba(0,0,0,.08)', margin: '0 2px' });

    panel.appendChild(undoBtn);
    panel.appendChild(divider);
    panel.appendChild(redoBtn);
    parent.appendChild(panel);

    // 轻量提示条（仅用于反馈，如"已回到上一批"）
    const toast = el(
      'div',
      {
        position: 'fixed',
        right: '22px',
        bottom: '144px',
        zIndex: '2147483600',
        display: 'none',
        padding: '6px 10px',
        borderRadius: '8px',
        background: 'rgba(0,0,0,.78)',
        color: '#fff',
        fontSize: '12px',
        lineHeight: '16px',
        pointerEvents: 'none',
        userSelect: 'none',
      },
      ''
    );
    toast.id = 'bili-undo-toast';
    parent.appendChild(toast);

    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      doUndo();
    });
    redoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      doRedo();
    });
    // 右键撤回按钮 = 清空历史（隐藏功能，避免面板上塞第三个按钮）
    undoBtn.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
      execCmd('clear').then((o) => {
        applyBridgeResult(o);
        toastMsg('已清空撤回历史');
        setTimeout(syncState, 150);
      });
    });
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());

    // 拖动：按住面板空白处拖动即可，位置记在 localStorage
    setupDrag(panel);
    return true;
  }

  // ---------------- 拖动 ----------------
  const POS_KEY = 'bili-undo-panel-pos';

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) {}
    return null;
  }

  function savePanelPos(left, top) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
    } catch (e) {}
  }

  function setupDrag(panel) {
    const LONG_PRESS_MS = 200;
    let armed = false; // 已按下，等待长按判定
    let dragging = false; // 已进入拖动
    let movedBeforeDrag = false;
    let dragged = false; // 本次交互发生过拖动（用于吞掉随后的 click）
    let timer = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    function beginDrag() {
      const r = panel.getBoundingClientRect();
      dragging = true;
      dragged = true;
      originLeft = r.left;
      originTop = r.top;
      // 从 right/bottom 定位切换到 left/top，避免坐标跳动
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.boxShadow = '0 6px 22px rgba(0,0,0,.22), 0 0 0 2px rgba(251,114,153,.6)';
      toastMsg('拖动中，松手即保存位置', 1200);
    }

    function onDown(e) {
      if (e.button !== 0) return; // 仅左键
      armed = true;
      dragging = false;
      movedBeforeDrag = false;
      const r = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = r.left;
      originTop = r.top;
      clearTimeout(timer);
      // 长按判定的作用：面板上任意位置（含按钮）按住约 200ms 即进入拖动
      timer = setTimeout(() => {
        if (armed && !movedBeforeDrag) beginDrag();
      }, LONG_PRESS_MS);
    }

    function onMove(e) {
      if (!armed && !dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        // 长按前就明显移动 → 视为普通点击/滑动，不进入拖动
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          movedBeforeDrag = true;
          clearTimeout(timer);
        }
        return;
      }
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth - 4);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight - 4);
      panel.style.left = Math.min(maxLeft, Math.max(4, originLeft + dx)) + 'px';
      panel.style.top = Math.min(maxTop, Math.max(4, originTop + dy)) + 'px';
      if (e.cancelable) e.preventDefault();
    }

    function onUp() {
      clearTimeout(timer);
      if (dragging) {
        const r = panel.getBoundingClientRect();
        savePanelPos(r.left, r.top);
        diag('log', ['面板位置已保存', Math.round(r.left), Math.round(r.top)]);
        panel.style.boxShadow = '0 2px 12px rgba(0,0,0,.14)';
        setTimeout(() => {
          dragged = false;
        }, 0);
      }
      armed = false;
      dragging = false;
    }

    panel.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    // 拖动结束后吞掉紧跟着的 click，避免误触发撤回/重做
    panel.addEventListener(
      'click',
      (e) => {
        if (dragged) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    // 拖动过程中禁用按钮的 hover 反馈
    panel.addEventListener('pointerdown', () => {
      if (dragging) return;
    });
  }

  function toastMsg(text, ms) {
    const t = document.getElementById('bili-undo-toast');
    if (!t) return;
    t.textContent = text;
    t.style.display = 'block';
    clearTimeout(toastMsg._t);
    toastMsg._t = setTimeout(() => {
      t.style.display = 'none';
    }, ms || 1800);
  }

  // 兼容旧调用名（部分分支仍用 setHint）
  function setHint(text) {
    toastMsg(text);
  }

  function renderState(st) {
    if (!st) {
      diag('log', ['renderState: 收到空状态']);
      return;
    }
    lastState = st;
    const panel = document.getElementById('bili-undo-panel');
    const badge = document.getElementById('bili-undo-badge');
    const undoBtn = document.getElementById('bili-undo-btn');
    const redoBtn = document.getElementById('bili-undo-redo');
    if (!panel || !badge || !undoBtn || !redoBtn) return;

    const canUndo = !!st.canUndo;
    const canRedo = !!st.canRedo;
    const n = Number(st.remaining) || 0;

    // 没有任何可撤销/可重做的内容时整块隐藏，避免干扰界面
    panel.style.display = canUndo || canRedo ? 'flex' : 'none';

    badge.style.display = canUndo && n > 1 ? 'block' : 'none';
    badge.textContent = String(n);

    [undoBtn, redoBtn].forEach((b) => {
      const on = b === undoBtn ? canUndo : canRedo;
      b.disabled = !on;
      b.style.opacity = on ? '1' : '.32';
      b.style.cursor = on ? 'pointer' : 'default';
    });
  }

  let syncBusy = false;
  let lastStateAt = 0;
  async function syncState() {
    if (syncBusy) return lastState;
    syncBusy = true;
    try {
      const o = await execCmd('debug');
      renderState(applyBridgeResult(o));
      lastStateAt = Date.now();
      return lastState;
    } finally {
      syncBusy = false;
    }
  }

  // 状态够新就直接用，省掉一次往返（撤回/重做要尽量跟手）
  async function freshState(maxAgeMs) {
    if (lastState && Date.now() - lastStateAt < (maxAgeMs || 1500)) return lastState;
    return (await syncState()) || lastState;
  }

  async function doUndo() {
    const st = await freshState();
    if (!st || !st.canUndo) {
      toastMsg('没有可撤回的内容');
      return;
    }
    const o = await execCmd('requestUndo');
    const res = o && o.result;
    if (!res || !res.ok) {
      toastMsg('撤回准备失败');
      return;
    }
    toastMsg('正在回到上一批…', 1200);
    setTimeout(() => {
      const fired = triggerRefresh();
      if (!fired) toastMsg('未找到刷新按钮');
      setTimeout(syncState, 900);
    }, 20);
  }

  async function doRedo() {
    const st = await freshState();
    if (!st || !st.canRedo) {
      toastMsg('没有可重做的内容');
      return;
    }
    const o = await execCmd('requestRedo');
    const res = o && o.result;
    if (!res || !res.ok) {
      toastMsg('重做准备失败');
      return;
    }
    toastMsg('正在回到刷新后的内容…', 1200);
    setTimeout(() => {
      triggerRefresh();
      setTimeout(syncState, 900);
    }, 20);
  }

  // ---------------- 快捷键 ----------------
  function onKeydown(e) {
    if (!e.altKey) return;
    const k = String(e.key || '').toLowerCase();
    if (k !== 'z') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) doRedo();
    else doUndo();
  }
  try {
    window.addEventListener('keydown', onKeydown, true);
  } catch (e) {}
  try {
    window.addEventListener('beforeunload', () => {
      try {
        diagFlush(false);
      } catch (e) {}
    });
  } catch (e) {}

  // ---------------- 启动 ----------------
  if (!isMainWindow()) {
    diag('log', ['非主窗口，跳过 UI 与轮询', String(location.pathname)]);
    return;
  }
  diag('log', ['主窗口已识别，启动 UI 轮询']);

  const boot = setInterval(() => {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    buildPanel();
    if (document.getElementById('bili-undo-panel')) {
      clearInterval(boot);
      syncState();
      setInterval(syncState, 3000); // 仅作兜底，正常靠主世界的事件推送
    }
  }, 400);

  try {
    document.addEventListener('DOMContentLoaded', () => {
      buildPanel();
      syncState();
    });
    window.addEventListener('load', () => {
      buildPanel();
      syncState();
    });
  } catch (e) {}

  // 首次尽快注入（保证首页第一批数据也被记录）
  const early = setInterval(() => {
    if (document.head || document.documentElement) {
      clearInterval(early);
      execCmd('debug').then((o) => renderState(applyBridgeResult(o)));
    }
  }, 5);

  log('preload 侧就绪 v' + VERSION);
})();
