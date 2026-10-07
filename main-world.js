/* 哔哩哔哩 PC 客户端 · 「撤回刷新」插件 —— 页面主世界钩子（可重入）
 *
 * 为什么必须跑在主世界：
 *   首页的请求是页面自己的 JS（fetch）发出的，只有和它同一个 JS world 才能劫持到。
 *   preload 位于隔离世界，因此由 preload 注入本文件到主世界执行。
 *
 * 通道设计（不依赖内联脚本能否反复执行）：
 *   · 命令：preload 写在 <html data-bili-undo-cmd="{seq,cmd}"> 上，跨 world 可见
 *   · 每次命令由 preload 追加一个新的 <script data-seq=N> 节点来执行本文件
 *   · 结果：写回「自己这个 script 节点」的 data-bili-undo-res 属性（节点唯一，不会被替换）
 *   · 单例状态挂在 window.__BILI_UNDO__ 上，重复执行只做命令分发，不会重复劫持
 *
 * 原理：
 *   首页「推荐」刷新 = GET https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd
 *   返回 { code:0, data:{ item:[...30 条...] } }，每批由 track_id 区分。
 *   劫持 window.fetch：
 *     · 每次成功拿到 rcmd 响应 → 把响应文本压入快照栈
 *     · 撤回时 → 下一次 rcmd 请求直接返回上一批的响应文本，不发起真实请求
 *       （页面用旧数据正常渲染，所以是"数据级"撤回，内容级/页面级刷新都适用）
 */
(function () {
  const VERSION = '1.0.0';
  const FEED_RE = /x\/web-interface\/wbi\/index\/top\/feed\/rcmd/i;
  const KEY = '__bili_undo_refresh_v1__';
  const MAX = 6;
  const SUPPRESS_MS = 2500; // 撤回/重做后，这段时间内的 replace 请求都走本地回放
  const TAG = '[撤回刷新]';

  // 状态变化通知：让 UI 立刻刷新，而不是等轮询
  function notify(reason) {
    try {
      window.dispatchEvent(new CustomEvent('__bili_undo_changed__', { detail: { reason: reason || '', at: Date.now() } }));
    } catch (e) {}
  }

  // 日志：既打 console，也通过自定义事件传给 preload（隔离世界）以便落盘
  const log = (...a) => {
    const text = a
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
      console.log(TAG, text);
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent('__bili_undo_log__', { detail: text }));
    } catch (e) {}
  };

  log('主世界脚本开始执行');

  // ---------- 单例初始化 ----------
  let api = window.__BILI_UNDO__;
  if (!api || api.version !== VERSION) {
    const state = {
      version: VERSION,
      stack: [], // 已提交的「替换」批次：[{ at, url, text, track, count, bvids, appends: [...] }]
      live: null, // 当前正在使用的替换批次（尚未被下一次替换挤下去）
      future: [], // 已被撤回的批次（供重做）
      redoQueue: [], // 待回放的批次
      pending: 0, // 下一次 feed 请求是否走本地快照
      intent: null, // 'undo' | 'redo'：本次回放的意图
      serving: 0, // 预留
      suppressUntil: 0, // 回放抑制窗口截止时间
      intentAt: 0, // 最近一次撤回/重做的时间
      gen: 0, // 撤销动作代次
      served: 0,
      saved: 0,
      lastError: null,
      feedLog: [],
    };

    const payload = () =>
      JSON.stringify({
        version: VERSION,
        stack: state.stack,
        live: state.live,
        future: state.future,
        redoQueue: state.redoQueue,
        pending: state.pending,
        served: state.served,
        saved: state.saved,
      });

    function persist() {
      const write = () => {
        try {
          sessionStorage.setItem(KEY, payload());
          return true;
        } catch (e) {
          state.lastError = 'persist: ' + e.message;
          return false;
        }
      };
      const ok = write();
      if (ok) {
        notify('persist'); // 状态变了，立刻通知 UI
        return;
      }
      while (state.stack.length > 1) {
        state.stack.shift();
        if (write()) {
          state.lastError = null;
          notify('persist');
          return;
        }
      }
    }

    function restore() {
      try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o && o.version === VERSION && Array.isArray(o.stack)) {
          state.stack = o.stack;
          state.live = o.live || null;
          state.future = Array.isArray(o.future) ? o.future : [];
          state.redoQueue = Array.isArray(o.redoQueue) ? o.redoQueue : [];
          state.pending = Number(o.pending) || 0;
          state.served = Number(o.served) || 0;
          state.saved = Number(o.saved) || 0;
        }
      } catch (e) {
        state.lastError = 'restore: ' + e.message;
      }
    }

    function summarize(text) {
      const out = { track: null, bvids: [], count: 0, ads: 0 };
      try {
        const o = JSON.parse(text);
        const items = (o && o.data && o.data.item) || [];
        out.count = items.length;
        for (const it of items) {
          if (it && it.goto === 'ad') out.ads++;
          if (it && it.bvid) out.bvids.push(it.bvid);
          if (!out.track && it && it.track_id) out.track = it.track_id;
        }
      } catch (e) {
        out.parseError = String(e && e.message);
      }
      return out;
    }

    // ---------- 请求分类 ----------
    // 推荐接口有两类语义完全不同的请求：
    //   · 替换列表（首次加载 / 点刷新按钮）
    //   · 追加列表（下拉加载更多，只往后加视频，不顶掉已有内容）
    // 只有「替换」才产生可撤回点；「追加」不能进栈，否则撤回会回放残缺的增量批次。
    function parseFeedParams(url) {
      const out = { raw: String(url).slice(0, 300), fresh_idx: null, fresh_type: null, ps: null, ok: false };
      try {
        const u = new URL(String(url), location.href);
        const g = (k) => u.searchParams.get(k);
        out.fresh_idx = g('fresh_idx');
        out.fresh_type = g('fresh_type');
        out.ps = g('ps');
        out.ok = true;
      } catch (e) {
        // 退化：正则抓参数
        const fi = String(url).match(/[?&]fresh_idx=(\d+)/);
        const ft = String(url).match(/[?&]fresh_type=(\d+)/);
        out.fresh_idx = fi ? fi[1] : null;
        out.fresh_type = ft ? ft[1] : null;
        out.raw = String(url).slice(0, 300);
      }
      const idx = out.fresh_idx == null ? NaN : Number(out.fresh_idx);
      out.kind = Number.isFinite(idx) && idx <= 1 ? 'replace' : 'append';
      return out;
    }

    // 记录每一条推荐请求的参数，便于确认客户端换参数后仍然判得准
    state.feedLog = state.feedLog || [];
    function noteFeedRequest(url, phase, extra) {
      try {
        const p = parseFeedParams(url);
        const rec = {
          at: Date.now(),
          phase: phase,
          fresh_idx: p.fresh_idx,
          fresh_type: p.fresh_type,
          ps: p.ps,
          kind: p.kind,
          pending: state.pending,
          stackSize: state.stack.length,
          extra: extra || null,
        };
        state.feedLog.push(rec);
        if (state.feedLog.length > 60) state.feedLog.shift();
        log(
          'feed请求[' + phase + '] fresh_idx=' + p.fresh_idx + ' fresh_type=' + p.fresh_type + ' ps=' + p.ps + ' → ' + p.kind + ' pending=' + state.pending + ' stack=' + state.stack.length + (extra ? ' ' + JSON.stringify(extra) : '')
        );
      } catch (e) {
        state.lastError = 'noteFeed: ' + e.message;
      }
    }

    function pushSnapshot(url, text) {
      if (typeof text !== 'string' || text.length < 100) {
        log('快照被丢弃（不是字符串或过短）', { type: typeof text, len: text ? text.length : 0 });
        return;
      }
      const p = parseFeedParams(url);
      const info = summarize(text);
      noteFeedRequest(url, 'response', { count: info.count, track: (info.track || '').slice(-24) });
      if (p.kind === 'replace') onReplace(url, text, info, p);
      else onAppend(url, text, info, p);
    }

    function snapshotResponse(text, note) {
      try {
        return Promise.resolve(
          new Response(text, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        );
      } catch (e) {
        state.lastError = 'Response: ' + e.message;
        log(note, '构造 Response 失败', e && e.message);
        return null;
      }
    }

    // ---------- 批次记账 ----------
    // 关键：页面是拿「单个响应」重建整个列表的。
    // 所以撤回时必须回放「那一批 + 之后下拉追加的所有批次」合并后的响应，
    // 否则下拉出来的视频会在撤回后丢失。
    function makeEntry(url, text, info, p) {
      return {
        at: Date.now(),
        url: String(url).slice(0, 400),
        text,
        track: info.track,
        count: info.count,
        bvids: info.bvids.slice(0, 60),
        origin: { fresh_idx: p ? p.fresh_idx : null, fresh_type: p ? p.fresh_type : null },
        appends: [],
      };
    }

    // 同一个 track + 同样条数视为「同一批内容」
    function sameBatch(a, b) {
      if (!a || !b) return false;
      if (!a.track || !b.track) return false;
      return a.track === b.track && Number(a.count) === Number(b.count);
    }

    /** 在 live / stack / future 中查找同一批内容 */
    function findTrack(track, count) {
      if (!track) return null;
      if (state.live && sameBatch(state.live, { track, count })) return { where: 'live' };
      for (let i = state.stack.length - 1; i >= 0; i--) {
        if (sameBatch(state.stack[i], { track, count })) return { where: 'stack', index: i };
      }
      for (let i = state.future.length - 1; i >= 0; i--) {
        if (sameBatch(state.future[i], { track, count })) return { where: 'future', index: i };
      }
      return null;
    }

    // 把当前 live 批次的「基准 + 追加」合并成一个响应文本
    function mergedText(entry) {
      if (!entry || !entry.appends || !entry.appends.length) return entry ? entry.text : null;
      try {
        const base = JSON.parse(entry.text);
        if (!base || !base.data || !Array.isArray(base.data.item)) return entry.text;
        const merged = base.data.item.slice();
        for (const a of entry.appends) {
          try {
            const ao = JSON.parse(a.text);
            const items = (ao && ao.data && ao.data.item) || [];
            for (const it of items) merged.push(it);
          } catch (e) {
            /* 单个追加批次解析失败则跳过 */
          }
        }
        base.data.item = merged;
        base.data.has_more = 1;
        log('合并回放内容：基准', base.data.item.length - (merged.length - base.data.item.length), '+ 追加', merged.length - base.data.item.length, '=', merged.length, '条');
        return JSON.stringify(base);
      } catch (e) {
        state.lastError = 'merge: ' + e.message;
        return entry.text;
      }
    }

    function onReplace(url, text, info, p) {
      // 去重 1：同一 track（同一批内容）不会重复计入历史
      const hit = findTrack(info.track, info.count);
      if (hit) {
        if (hit.where === 'live' && state.live) {
          state.live.text = text;
          state.live.at = Date.now();
          state.live.bvids = info.bvids.slice(0, 60);
          persist();
          log('同一批内容再次到达（当前批次），仅更新不新增撤回点', info.track);
          return;
        }
        if (hit.where === 'stack') {
          const removed = state.stack.splice(hit.index, 1)[0];
          removed.text = text;
          removed.at = Date.now();
          if (state.live) state.stack.push(state.live);
          state.live = removed;
          persist();
          log('同一批内容再次到达（历史批次），移动到当前，不新增撤回点', info.track);
          return;
        }
        if (hit.where === 'future') {
          state.future.splice(hit.index, 1);
          persist();
          log('同一批内容再次到达（重做历史），已清理重做项', info.track);
          return;
        }
      }
      // 去重 2 已由 fetch 层的「回声窗口」处理（见 ECHO_WINDOW_MS）
      if (state.live) {
        state.stack.push(state.live);
        if (state.stack.length > MAX) state.stack.shift();
      }
      const entry = makeEntry(url, text, info, p);
      state.live = entry;
      // 「替换」发生后，之前撤掉的分支失效
      state.future.length = 0;
      state.redoQueue.length = 0;
      state.saved++;
      persist();
      log('记录替换批次：', info.track, '共', info.count, '条（此时可撤回', state.stack.length, '步）');
    }

    // 「追加」批次只挂到当前 live 批次上，不产生可撤回点
    function onAppend(url, text, info, p) {
      if (!state.live) {
        // 还没记录到基准批次就出现追加（例如从中间恢复），单独存着也无意义，忽略
        log('追加批次没有基准，忽略', { fresh_idx: p && p.fresh_idx, count: info.count });
        return;
      }
      state.live.appends.push({
        at: Date.now(),
        text,
        track: info.track,
        count: info.count,
        fresh_idx: p ? p.fresh_idx : null,
      });
      persist();
      log('追加批次已保留（下拉加载更多）：', info.count, '条，当前累计追加', state.live.appends.length, '批');
    }

    // ---------- 劫持 fetch ----------
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) {}
        const isFeed = FEED_RE.test(String(url));
        if (isFeed) noteFeedRequest(url, 'request');
        let replayMark = false;

        if (isFeed) {
          const rp = parseFeedParams(url);
          const now = Date.now();
          const suppressing = !!state.suppressUntil && now < state.suppressUntil;
          if (rp.kind !== 'replace') {
            noteFeedRequest(url, 'replay-skip', { reason: 'append-request' });
          } else if (state.pending > 0) {
            // 用户点了撤回/重做 → 这一批请求走对应逻辑（意图必须显式区分）
            const intent = state.intent;
            state.suppressUntil = 0;
            state.gen++;
            // A) 重做：把被撤掉的那一批还回去（含它当时的追加批次）
            if (intent === 'redo' && state.future.length) {
              const back = state.future[state.future.length - 1];
              const r = snapshotResponse(mergedText(back), 'redo');
              if (r) {
                state.future.pop();
                if (state.live) state.stack.push(state.live);
                state.live = back;
                state.pending = 0;
                state.suppressUntil = Date.now() + SUPPRESS_MS;
                persist();
                log('重做 → 回放', back.track, '共', back.count, '条 +追加', (back.appends || []).length, '批');
                replayMark = true;
                return r;
              }
            }
            // B) 撤回：回到上一个替换批次（含它当时的追加批次）
            if (intent !== 'redo' && state.stack.length >= 1) {
              const prev = state.stack[state.stack.length - 1];
              const r = snapshotResponse(mergedText(prev), 'undo');
              if (r) {
                state.stack.pop(); // prev 即将成为 live
                if (state.live) state.future.push(state.live); // 被撤掉的那一批
                state.live = prev;
                state.pending = 0;
                state.suppressUntil = Date.now() + SUPPRESS_MS;
                state.served++;
                persist();
                log(
                  '撤回 → 回放',
                  prev.track,
                  '共',
                  prev.count,
                  '条 +追加',
                  (prev.appends || []).length,
                  '批，剩余可撤',
                  state.stack.length
                );
                replayMark = true;
                return r;
              }
            }
            state.pending = 0;
            persist();
            log('没有可回退的批次');
          } else if (suppressing) {
            // 抑制窗口：撤回后客户端可能又发出 replace 请求（回声），
            // 一律回放当前 live 内容，绝不记为新的撤回点。
            const cur = state.live;
            const r = cur ? snapshotResponse(mergedText(cur), 'replay') : null;
            if (r) {
              noteFeedRequest(url, 'replay', { reason: 'suppress-window', track: cur.track });
              replayMark = true;
              return r;
            }
            noteFeedRequest(url, 'replay-skip', { reason: 'no-live' });
          }
        }

        const p = origFetch.apply(this, arguments);
        if (!isFeed) return p;
        const servedLocally = replayMark;
        try {
          p.then((res) => {
            try {
              if (!res || !res.ok) return;
              res
                .clone()
                .text()
                .then((t) => {
                  if (state.pending > 0) return;
                  if (servedLocally) {
                    log('回放响应到达，保持在抑制窗口内');
                    return;
                  }
                  pushSnapshot(url, t);
                })
                .catch((e) => {
                  state.lastError = 'clone: ' + e.message;
                });
            } catch (e) {
              state.lastError = 'then: ' + e.message;
            }
          });
        } catch (e) {
          state.lastError = 'hook: ' + e.message;
        }
        return p;
      };
      log('fetch 已劫持');
    } else {
      state.lastError = 'window.fetch 不可用';
      log('window.fetch 不可用，无法安装');
    }

    restore();

    api = window.__BILI_UNDO__ = {
      version: VERSION,
      state: state,
      /** 还能撤回几步 = 栈里还有多少个更早的替换批次 */
      remaining: () => state.stack.length,
      canUndo: () => state.stack.length >= 1 && !!state.live,
      canRedo: () => state.future.length >= 1,
      requestUndo: function () {
        if (state.stack.length < 1 || !state.live) return { ok: false, reason: 'empty' };
        state.pending = 1;
        state.intent = 'undo';
        state.suppressUntil = 0;
        state.intentAt = Date.now();
        state.gen++;
        persist();
        return { ok: true };
      },
      requestRedo: function () {
        if (!state.future.length) return { ok: false, reason: 'empty' };
        state.pending = 1;
        state.intent = 'redo';
        state.suppressUntil = 0;
        state.intentAt = Date.now();
        state.gen++;
        persist();
        return { ok: true };
      },
      clear: function () {
        state.stack.length = 0;
        state.live = null;
        state.future.length = 0;
        state.redoQueue.length = 0;
        state.pending = 0;
        state.intent = null;
        state.suppressUntil = 0;
        state.intentAt = 0;
        persist();
        return { ok: true };
      },
      debug: function () {
        const liveDesc = state.live
          ? { track: state.live.track, count: state.live.count, appends: (state.live.appends || []).length }
          : null;
        return {
          version: VERSION,
          stack: state.stack.map((s) => ({
            track: s.track,
            count: s.count,
            at: s.at,
            appends: (s.appends || []).length,
          })),
          stackSize: state.stack.length,
          live: liveDesc,
          future: state.future.length,
          redoQueue: state.redoQueue.length,
          pending: state.pending,
          served: state.served,
          saved: state.saved,
          remaining: state.stack.length,
          canUndo: state.stack.length >= 1 && !!state.live,
          canRedo: state.future.length >= 1,
          lastError: state.lastError,
          lastTrack: state.live ? state.live.track : null,
          feedLog: (state.feedLog || []).slice(-12),
        };
      },
    };

    log('已安装 v' + VERSION, '栈内可撤回点', state.stack.length, 'pending', state.pending);
  }

  // ---------- 命令通道 ----------
  // preload 每次追加一个新的 <script data-seq> 节点来执行本文件。
  // 命令写在 document.documentElement 的 data-bili-undo-cmd 上（跨 world 可见）；
  // 结果写回「自己这个 script 节点」的 data-bili-undo-res —— 节点天然唯一，不怕被替换。
  const me = (function () {
    try {
      return document.currentScript;
    } catch (e) {
      return null;
    }
  })();
  const mySeq = (function () {
    try {
      const v = me && me.getAttribute && me.getAttribute('data-seq');
      return v == null ? null : Number(v);
    } catch (e) {
      return null;
    }
  })();
  let myCmd = null;
  let myPayload = null;
  try {
    const raw = document.documentElement && document.documentElement.getAttribute('data-bili-undo-cmd');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.seq === mySeq) {
        myCmd = parsed.cmd;
        myPayload = parsed.payload;
      }
    }
  } catch (e) {}

  function writeData(obj) {
    try {
      if (me && me.setAttribute) me.setAttribute('data-bili-undo-res', JSON.stringify(obj));
    } catch (e) {}
  }

  let result = null;
  try {
    if (myCmd) {
      switch (myCmd) {
        case 'requestUndo':
          result = api.requestUndo();
          break;
        case 'requestRedo':
          result = api.requestRedo();
          break;
        case 'clear':
          result = api.clear();
          break;
        case 'debug':
          result = api.debug();
          break;
        default:
          result = { ok: false, reason: 'unknown-cmd' };
      }
    }
  } catch (e) {
    result = { ok: false, error: String(e && e.message) };
  }

  const state = api.debug();
  writeData({ seq: mySeq, at: Date.now(), result: result, state: state, cmd: myCmd });
  log('脚本执行结束', { seq: mySeq, cmd: myCmd, result: result, stackSize: state.stackSize, pending: state.pending });
})();
