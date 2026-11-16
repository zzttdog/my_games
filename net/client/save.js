/* ============================================================
 * my_games 本地存档 —— 两个游戏页各自用 <script src="../net/save.js"> 引入
 *
 *  · 存：每次动作（取/放标记、拿卡、放骰、结束回合…）后把状态序列化进 localStorage
 *  · 读：页面打开时若检测到存档，弹窗问「要继续吗」；否则清掉按新局走
 *  · 清：终局、版本/结构不匹配、用户选「否」时删除存档
 *
 * 三个约束（都是硬要求，不要删）：
 *  1. 状态里遇到「函数 / DOM 节点 / Symbol / 循环引用」不硬存：递归剔除并记录字段名，
 *     被剔除的字段在恢复时由各适配器补默认值（例如姬路城 g.snapshots 补 []）。
 *  2. 存档带 schema 版本号 + 结构校验；任何不匹配直接丢弃，绝不让游戏崩。
 *  3. 联机只有主机（net_seat=0）读写，客机整个模块直接 return；状态以主机为准，
 *     主机恢复后由 net/bridge.js 广播给客机。
 *
 * 已知需要剔除的字段（真实浏览器扫描结论）：
 *   · 姬路城 g.onUpdate —— 函数回调槽（engine.js notify() 会 typeof === 'function' 调用）
 *   · 姬路城 g.snapshots —— 撤销历史，最多 400 条 JSON 字符串，实测让状态膨胀到 ~500KB
 *   · 自然和弦 G.undoStack / G.roundStart —— 联机下不存（与 bridge.js 的 DROP 一致）
 * ============================================================ */
(function () {
  'use strict';

  var SCHEMA = 1;                       // ★ 存档结构变了就 +1，旧档会被直接丢弃
  var Q = new URLSearchParams(location.search);
  var NET = Q.get('net') === '1';
  var SEAT = parseInt(Q.get('net_seat'), 10);
  var MODE = NET ? 'net' : 'solo';
  var MG = (window.MG_GAMES && window.MG_GAMES.games) || {};
  var qk = Q.get('game') || Q.get('net_game');
  var GAME = MG[qk] ? qk : (Q.get('net_game') === 'castle' ? 'castle' : 'harmonies');

  /* 联机客机：不读、不写、不弹窗，状态完全以主机为准 */
  if (NET && SEAT !== 0) return;

  /* per-game 适配器注册表；新增游戏只在这里加一条 */
  var ADAPTERS = { harmonies: makeHarmonies, castle: makeCastle };
  var A = pickAdapter();
  if (!A) return;
  GAME = A.key;

  var KEY = 'mygames.save.' + A.key + '.' + MODE;  // 联机不绑房号 → 刷新后可续上
  var enabled = !NET;          // 联机等桥 init 完成后才启用，避免存到半初始化的状态
  var netMeta = null;
  var booted = false, bootPending = false;
  var skippedLogged = false;

  /* ── 序列化：递归剔除不能打包成文字的字段 ───────────────── */
  function sanitize(v, path, stack, skipped) {
    if (v == null) return v;
    var t = typeof v;
    if (t === 'function' || t === 'symbol' || t === 'bigint') { skipped[path] = t; return undefined; }
    if (t !== 'object') return v;
    if (v.nodeType || v === window || v === document || v === window.parent) {
      skipped[path] = 'DOM/全局对象'; return undefined;
    }
    if (stack.indexOf(v) >= 0) { skipped[path] = '循环引用'; return undefined; }
    stack.push(v);
    var out;
    if (Array.isArray(v)) {
      out = [];
      for (var i = 0; i < v.length; i++) {
        var y = sanitize(v[i], path + '[' + i + ']', stack, skipped);
        out.push(y === undefined ? null : y);
      }
    } else {
      out = {};
      Object.keys(v).forEach(function (k) {
        var z = sanitize(v[k], path + '.' + k, stack, skipped);
        if (z !== undefined) out[k] = z;
      });
    }
    stack.pop();
    return out;
  }

  function clean(obj, drop) {
    if (!obj || typeof obj !== 'object') return null;
    var skipped = {};
    var src = {};
    Object.keys(obj).forEach(function (k) {
      if (drop && drop[k]) { skipped['state.' + k] = '显式剔除'; return; }
      src[k] = obj[k];
    });
    var out;
    try { out = sanitize(src, 'state', [], skipped); }
    catch (e) { return null; }
    /* 兜底：再走一次真正的 JSON 往返，任何异常都只丢存档，不抛给游戏 */
    try { out = JSON.parse(JSON.stringify(out)); }
    catch (e) { return null; }
    var names = Object.keys(skipped);
    if (names.length && !skippedLogged) {
      skippedLogged = true;
      try { console.warn('[存档] 已跳过不能序列化的字段：' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' …' : '')); } catch (e) {}
    }
    return out;
  }

  /* ── localStorage 读写 ─────────────────────────────────── */
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} lastSig = null; }

  function netCfg() {
    if (netMeta && netMeta.cfg) return netMeta.cfg;
    try { return JSON.parse(Q.get('net_cfg') || '{}') || {}; } catch (e) { return {}; }
  }
  function cfgKey(c) {
    c = c || {};
    var mods = c.mods || {};
    return [c.total || 0, c.humans || 0, (c.seatKinds || []).join(','),
      c.firstSeat == null ? '' : String(c.firstSeat), c.side || '',
      c.difficulty || '', c.order || '',
      [mods.pulse, mods.spirit, mods.cres, mods.sanct].map(function (x) { return x ? 1 : 0; }).join('')
    ].join('|');
  }

  function read() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;
    var d;
    try { d = JSON.parse(raw); } catch (e) { clear(); return null; }
    if (!d || d.schema !== SCHEMA || d.game !== A.key || d.mode !== MODE || !d.state) {
      clear(); return null;                       // 版本 / 结构对不上 → 直接丢弃
    }
    var ok = false;
    try { ok = A.validate(d.state); } catch (e) { ok = false; }
    if (!ok) { clear(); return null; }
    /* 联机：房间配置变了（人数/AI/先手/扩展）就丢弃，否则座位映射会错乱 */
    if (NET) {
      var cur = cfgKey(netCfg());
      if (!cur || d.netCfgKey !== cur) { clear(); return null; }
    }
    return d;
  }

  function store(st) {
    var payload = {
      schema: SCHEMA, game: A.key, mode: MODE, savedAt: Date.now(),
      opts: A.opts() || null, state: st
    };
    if (NET) payload.netCfgKey = cfgKey(netCfg());
    localStorage.setItem(KEY, JSON.stringify(payload));
    if (NET) queueUpload();
  }

  /* 联机主机把存档镜像到服务端，AI/复盘脚本可直接读 net/server/saves/。
     1.5 秒合并一次，避免每个动作都打一次 POST 影响对局流畅度。 */
  var uploadTimer = 0, uploadBusy = false;
  function queueUpload() {
    if (!NET || SEAT !== 0 || Q.get('net_transport') !== 'net' || uploadTimer) return;
    uploadTimer = setTimeout(function () {
      uploadTimer = 0;
      uploadNet();
    }, 1500);
  }

  function uploadNet() {
    if (!NET || SEAT !== 0 || !enabled || uploadBusy || Q.get('net_transport') !== 'net') return;
    var d = null;
    try { d = read(); } catch (e) {}
    if (!d || !d.state) return;
    uploadBusy = true;
    var room = (Q.get('net_room') || '0000').replace(/\D/g, '').slice(0, 4) || '0000';
    var match = Q.get('net_match') || 'm0';
    var url = '../net/save?game=' + encodeURIComponent(A.key) +
      '&room=' + encodeURIComponent(room) +
      '&match=' + encodeURIComponent(match);
    var body;
    try { body = JSON.stringify(d); } catch (e) { uploadBusy = false; return; }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).catch(function () {}).then(function () { uploadBusy = false; });
  }

  function write() {
    if (!enabled || bootPending) return;
    try {
      if (!A.started()) return;
      if (A.isOver()) { clear(); lastSig = null; return; }   // 终局清档
      var st = A.plain();
      if (!st) return;
      var sig = JSON.stringify(st);
      if (sig === lastSig) return;      // 同一状态不重复落盘（双层包装时会调用两次）
      lastSig = sig;
      store(st);
    } catch (e) {
      /* 配额超限/序列化异常：宁可丢档，也不要留下半截数据让下次读到 */
      try { localStorage.removeItem(KEY); } catch (e2) {}
      try { console.warn('[存档] 写入失败，已清除：' + (e && e.message)); } catch (e3) {}
    }
  }

  /* 联机兜底：客机/AI 的动作是经 bridge 的 apply(wire) 直接改状态对象的，
     不会经过任何被包装过的动作函数；而且 bridge 后注入时会覆盖掉我们的 E.apply。
     这里由主机自己按状态签名轮询，任何一方动作都能在 250ms 内落盘。
     单机靠动作挂钩即时写档，不启用轮询，避免无谓的定时序列化。 */
  var lastSig = null, pollTimer = null;
  function poll() {
    if (!enabled || bootPending) return;
    try {
      if (!A.started()) return;
      if (A.isOver()) { clear(); lastSig = null; return; }
      var st = A.plain();
      if (!st) return;
      var sig = JSON.stringify(st);
      if (sig === lastSig) return;
      lastSig = sig;
      store(st);
    } catch (e) { /* 轮询绝不能影响游戏 */ }
  }
  function startPoll() {
    if (!NET || pollTimer) return;
    pollTimer = setInterval(poll, 400);
  }

  /* ── 提示弹窗（iframe 手机端 fixed 定位会跑到屏幕外，所以用父页视口高度 + top:0） ── */
  function toast(msg) {
    try {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;' +
        'background:#1b2430ee;color:#f0e6cf;border:1px solid #4a5a6e;border-radius:8px;' +
        'padding:8px 14px;font:13px/1.6 system-ui;max-width:80vw;text-align:center';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
    } catch (e) {}
  }

  function showPrompt(d, cb) {
    var vh = 800;
    try { vh = (window.parent && window.parent.innerHeight) || window.innerHeight || 800; } catch (e) {}
    var boxH = Math.max(300, Math.min(vh - 64, 900));
    var when = new Date(d.savedAt || Date.now());
    var whenTxt = isNaN(when.getTime()) ? '' :
      ('存档时间 ' + when.toLocaleString('zh-CN', { hour12: false }));
    var detail = A.describe ? A.describe(d.state) : '';

    var el = document.createElement('div');
    el.id = '__mg_save_prompt';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + boxH + 'px;' +
      'z-index:99996;background:#0b0e13f5;box-sizing:border-box;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;' +
      'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;overflow:auto';
    el.innerHTML =
      '<div style="font:600 19px/1.5 system-ui;color:#d9b26a;text-align:center">检测到上次的进度，要继续吗？</div>' +
      '<div style="font:13px/1.8 system-ui;color:#b8c6d6;text-align:center;max-width:420px">' +
        (NET ? '联机对局 · 本窗口是主机' : '本地对局') + '<br>' +
        (detail ? esc(detail) + '<br>' : '') + esc(whenTxt) +
        '<br><span style="color:#8d9bad;font-size:12px">选择「清掉重开」会删除存档，当前这局不会受影响</span></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' +
        '<button id="__mg_yes" style="padding:10px 20px;border:1px solid #d9b26a;background:#d9b26a;' +
          'color:#171b22;border-radius:8px;font:600 14px system-ui;cursor:pointer">继续上次进度</button>' +
        '<button id="__mg_no" style="padding:10px 20px;border:1px solid #4a5a6e;background:transparent;' +
          'color:#cfd9e6;border-radius:8px;font:14px system-ui;cursor:pointer">清掉重开</button>' +
      '</div>';
    document.body.appendChild(el);
    function done(yes) {
      if (el.parentNode) el.parentNode.removeChild(el);
      cb(!!yes);
    }
    el.querySelector('#__mg_yes').addEventListener('click', function () { done(true); });
    el.querySelector('#__mg_no').addEventListener('click', function () { done(false); });
    /* 让外层把 iframe 滚回顶部，保证弹窗真的在屏幕上 */
    try {
      if (window.parent !== window) {
        window.parent.scrollTo(0, 0);
        window.parent.postMessage({ __mygames: true, game: GAME, status: 'needPick' }, '*');
      }
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ── 动作挂钩：调用原函数后立即写档 ─────────────────────── */
  /* 包装是幂等的：bridge.js 会在游戏页之后注入并覆盖 E.apply / 部分全局动作函数，
     所以 onNetReady() 里会再挂一次，把我们的包装放到最外层。 */
  function wrapOne(orig) {
    if (typeof orig !== 'function' || orig.__mgSave) return orig;
    var w = function () {
      var r;
      try { r = orig.apply(this, arguments); }
      finally { write(); }
      return r;
    };
    w.__mgSave = true;
    return w;
  }
  function installHooks() {
    (A.hooks || []).forEach(function (name) { window[name] = wrapOne(window[name]); });
    if (A.hookEngine && window.WCEngine) {
      var E = window.WCEngine;
      E.apply = wrapOne(E.apply);
    }
  }

  /* ── 启动 ─────────────────────────────────────────────── */
  function boot() {
    if (booted) return;
    booted = true;
    var d = read();
    if (!d) { enabled = true; return; }           // 无存档 / 版本不符 → 正常新局
    bootPending = true;
    showPrompt(d, function (yes) {
      bootPending = false;
      if (!yes) { clear(); enabled = true; return; }
      try {
        A.apply(d.state);
        if (d.opts) A.setOpts(d.opts);
        enabled = true;
        if (NET && netMeta && netMeta.publish) {
          try { netMeta.publish(); } catch (e) {}   // 恢复后的状态广播给客机
        }
        write();
        toast('已恢复上次进度');
      } catch (e) {
        clear(); enabled = true;
        try { console.error('[存档] 恢复失败', e); } catch (e2) {}
        toast('存档恢复失败，已清除旧存档');
      }
    });
  }

  function start() {
    installHooks();
    if (!NET) boot();
  }

  /* ── 存档导出 / 导入：浏览器安全限制下，不读用户 profile，
     由玩家自己点一下导出 JSON，再把文件交给外部工具/复盘脚本 ───────── */
  function exportFile() {
    var d = read();
    if (!d) { toast('当前没有可导出的存档'); return; }
    var name = 'mygames-' + A.key + '-' + MODE + '-' + (d.savedAt || Date.now()) + '.json';
    var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
    toast('已导出：' + name);
  }

  function applyImported(d) {
    if (!d || d.schema !== SCHEMA || d.game !== A.key || !d.state) {
      toast('存档格式不匹配，已忽略');
      return false;
    }
    if (NET && d.mode !== 'net') { toast('联机窗口只能导入联机存档'); return false; }
    if (!NET && d.mode !== 'solo') { toast('单机窗口只能导入单机存档'); return false; }
    try {
      A.apply(d.state);
      if (d.opts) A.setOpts(d.opts);
      enabled = true;
      write();
      if (NET && netMeta && netMeta.publish) { try { netMeta.publish(); } catch (e) {} }
      toast('已导入存档');
      return true;
    } catch (e) {
      toast('导入失败：' + (e && e.message || e));
      return false;
    }
  }

  function importFile() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var d = null;
        try { d = JSON.parse(String(r.result)); } catch (e) {}
        if (!applyImported(d)) return;
      };
      r.readAsText(f, 'utf-8');
    };
    inp.click();
  }

  /* 联机：bridge.js 在 A.init() 末尾调用，保证不会被 setup() 覆盖 */
  window.MGSave = {
    schema: SCHEMA,
    key: KEY,
    onNetReady: function (meta) {
      netMeta = meta || {};
      /* bridge.js 晚于本模块注入，会覆盖掉 installHooks() 挂上的包装；
         这里重挂一次（幂等），把存档包装放到调用链最外层。 */
      try { installHooks(); } catch (e) {}
      if (NET && netMeta.seat === 0) { boot(); startPoll(); }
      else enabled = true;
    },
    save: write,
    clear: clear,
    read: read,
    upload: uploadNet,
    exportFile: exportFile,
    importFile: importFile
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* ── 两个游戏的适配器（注册表；新增游戏在此加一条） ───────── */
  function pickAdapter() {
    var key = (GAME === 'castle' || (window.WCUI && window.WCEngine)) ? 'castle'
            : ((GAME === 'harmonies' || document.getElementById('setupOv')) ? 'harmonies' : null);
    return key && ADAPTERS[key] ? ADAPTERS[key]() : null;
  }

  function makeHarmonies() {
    /* G 是页面里的 const，不挂在 window 上；间接 eval 在全局词法环境里能取到 */
    function state() { try { return window.eval('G'); } catch (e) { return null; } }
    var DROP = NET ? { undoStack: 1, roundStart: 1 } : {};
    return {
      key: 'harmonies',
      state: state,
      hooks: ['takeGroup', 'takeCard', 'takeSanct', 'placeToken', 'placeCube', 'endTurn', 'gameOver'],
      started: function () { var G = state(); return !!(G && G.players && G.players.length); },
      isOver: function () { var G = state(); return !!(G && G.over); },
      plain: function () { return clean(state(), DROP); },
      validate: function (s) {
        return !!(s && Array.isArray(s.players) && s.players.length >= 1 &&
          s.players.length === (s.n || s.players.length) &&
          s.players[0] && s.players[0].board && typeof s.players[0].board === 'object' &&
          Array.isArray(s.market) && Array.isArray(s.supply) &&
          s.mods && typeof s.mods === 'object');
      },
      describe: function (s) { return '第 ' + (s.round || 1) + ' 轮 · ' + (s.players ? s.players.length : 0) + ' 人'; },
      opts: function () {
        var G = state(); if (!G) return null;
        return { side: G.side, n: G.n, firstChoice: G.firstChoice, mods: Object.assign({}, G.mods) };
      },
      setOpts: function (o) {
        if (!o || NET) return;   // 联机设置由房间层固定，不改游戏页控件
        try {
          [['sideOpts', o.side], ['numOpts', o.n], ['firstOpts', o.firstChoice]].forEach(function (p) {
            var b = document.querySelector('#' + p[0] + ' .opt[data-v="' + p[1] + '"]');
            if (b) b.click();
          });
          if (o.mods) {
            [['modPulse', 'pulse'], ['modSpirit', 'spirit'], ['modCres', 'cres'], ['modSanct', 'sanct']]
              .forEach(function (p) {
                var e = document.getElementById(p[0]);
                if (e) e.checked = !!o.mods[p[1]];
              });
          }
        } catch (e) {}
      },
      apply: function (s) {
        var G = state();
        if (!G) throw new Error('G 不可用');
        var s2 = JSON.parse(JSON.stringify(s));
        /* 撤回栈是「本窗口自己维护」的，跨会话不还原，但字段必须补齐 */
        s2.undoStack = NET ? [] : (Array.isArray(s2.undoStack) ? s2.undoStack : []);
        s2.roundStart = NET ? null : (s2.roundStart || null);
        Object.keys(G).forEach(function (k) { delete G[k]; });
        Object.assign(G, s2);
        ['setupOv', 'spiritOv', 'endOv', 'btnEndFloat'].forEach(function (id) {
          var e = document.getElementById(id); if (e) e.classList.add('hidden');
        });
        try { window.buildBoards(); } catch (e) {}
        try { window.renderGameAid(); } catch (e) {}
        try { window.renderAll(); } catch (e) {}
        if (!G.over) {
          if (G.cur === 0) {
            try { window.saveRoundStart(); } catch (e) {}
            try { window.setMsg('已恢复上次进度 · 第 ' + G.round + ' 轮 · 你的回合'); } catch (e) {}
          } else if (!NET) {
            try { window.setMsg('已恢复上次进度 · 对手思考中…'); window.aiTurn(); } catch (e) {}
          }
        }
      }
    };
  }

  function makeCastle() {
    function U() { return window.WCUI; }
    function state() { try { return U().game(); } catch (e) { return null; } }
    /* g.onUpdate 是函数回调槽；g.snapshots 最多 400 条 JSON 字符串（约 500KB） */
    var DROP = { onUpdate: 1, snapshots: 1 };
    return {
      key: 'castle',
      state: state,
      hookEngine: true,
      started: function () { var g = state(); return !!(g && g.players && g.players.length); },
      isOver: function () { var g = state(); return !!(g && g.phase === 'gameEnd'); },
      plain: function () { var g = state(); return g ? clean(g, DROP) : null; },
      validate: function (s) {
        /* 只校验不可替代的骨架字段。g.castle / g.well 在 draft 阶段可能仍是 null，
           把它们当「必须存在」会把合法存档误判成旧结构直接丢掉。 */
        return !!(s && Array.isArray(s.players) && s.players.length >= 2 &&
          typeof s.phase === 'string' && s.config && typeof s.config === 'object' &&
          Array.isArray(s.log));
      },
      describe: function (s) { return '第 ' + (s.round || 1) + ' 轮 · ' + (s.players ? s.players.length : 0) + ' 人'; },
      opts: function () { try { return U().opts(); } catch (e) { return null; } },
      setOpts: function (o) { if (o && !NET) { try { U().setOpts(o); } catch (e) {} } },
      apply: function (s) {
        var s2 = JSON.parse(JSON.stringify(s));
        /* 被剔除的字段必须补默认值：legalCommands() 直接读 g.snapshots.length */
        s2.snapshots = [];
        delete s2.onUpdate;
        U().setGame(s2);
        U().showGame();
        U().render();
        if (!NET) { try { U().drive(); } catch (e) {} }
      }
    };
  }
})();
