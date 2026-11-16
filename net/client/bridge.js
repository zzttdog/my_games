/* ============================================================
 * my_games 联机桥 v2 —— 由 net/play.html 动态注入到游戏 iframe 内
 *
 * 不修改任何游戏文件。所有「游戏内规则」由房主在房间页统一设定，
 * 通过 net_cfg 一次性冻结传进来，本桥据此直接构造游戏状态。
 *
 *  · 原版开局设置页在注入瞬间被隐藏并禁用交互 → 各窗口不可能再各选人数/难度
 *  · 只有座位 0（房主）初始化对局；其余窗口纯镜像，等第一份状态快照
 *  · 支持 2~4 个席位：N 个真人 + M 个 AI（M = total - N）
 *  · AI 只由房主窗口代跑：游戏自带的 aiTurn()/drive() 被完全接管，
 *    其他窗口不会出现第二份 AI
 *  · Harmonies 写死「本地玩家 0 = 人类」，因此做通用座位置换
 *    localToWire / wireToLocal，不再只交换 0 和 1
 *  · 姬路城用 WCEngine.apply / newGame 包装层做座位控制
 *  · 同步：JSON 全量快照 + 200ms diff 轮询 + 单调 rev
 * ============================================================ */
(function () {
  'use strict';

  var Q = new URLSearchParams(location.search);
  if (Q.get('net') !== '1') return;

  /* 轻量网络诊断：控制台或 ?net_debug=1 可看；不参与游戏逻辑 */
  var netStat = { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, lastTxAt: 0, lastRxAt: 0, lastLatency: 0, lastApplyMs: 0 };
  window.MGNetStat = netStat;

  var CFG = {};
  try { CFG = JSON.parse(Q.get('net_cfg') || '{}') || {}; } catch (e) { CFG = {}; }

  var MG = (window.MG_GAMES && window.MG_GAMES.games) || {};
  var qk = Q.get('game') || Q.get('net_game');
  var GAME = MG[qk] ? qk : (Q.get('net_game') === 'castle' ? 'castle' : 'harmonies');
  var ROOM = (Q.get('net_room') || '0000').replace(/\D/g, '').slice(0, 4) || '0000';
  var MATCH = Q.get('net_match') || 'm0';
  var SEAT = parseInt(Q.get('net_seat'), 10);
  if (!(SEAT >= 0 && SEAT <= 3)) SEAT = 0;
  var MODE = Q.get('net_transport') === 'net'
    ? 'net'
    : (Q.get('net_transport') === 'peer' ? 'peer' : 'local');
  var PEER = 'b' + Math.random().toString(36).slice(2, 10);
  var CHANNEL = 'mygames_' + GAME + '_' + ROOM + '_' + MATCH;

  var TOTAL = Math.min(4, Math.max(2, parseInt(CFG.total, 10) || 2));
  var HUMANS = Math.min(TOTAL, Math.max(1, parseInt(CFG.humans, 10) || 2));
  var KINDS = (CFG.seatKinds && CFG.seatKinds.length === TOTAL)
    ? CFG.seatKinds.slice()
    : Array.from({ length: TOTAL }, function (_, i) { return i < HUMANS ? 'human' : 'ai'; });
  var NAMES = CFG.names || {};
  var IS_HOST = (SEAT === 0);
  var AI_N = TOTAL - HUMANS;

  function isAI(s) { return KINDS[s] === 'ai'; }
  function label(s) {
    if (s === SEAT) return '你（本窗口）';
    if (isAI(s)) return 'AI ' + (s + 1) + '（电脑）';
    return NAMES[s] || ('玩家 ' + (s + 1));
  }
  function rosterText() { return HUMANS + ' 真人 + ' + AI_N + ' AI · 共 ' + TOTAL + ' 席'; }
  function resolveFirst() {
    var f = CFG.firstSeat;
    if (f === 'random') return Math.floor(Math.random() * TOTAL);
    f = parseInt(f, 10);
    return (f >= 0 && f < TOTAL) ? f : 0;
  }

  /* ── 父页通信 ─────────────────────────────────────────── */
  function tell(status, detail) {
    try {
      window.parent.postMessage({ __mygames: true, game: GAME, room: ROOM,
        seat: SEAT, status: status, detail: detail || '' }, '*');
    } catch (e) {}
  }

  /* ── 立刻盖住原版设置页：用户永远看不到「你 vs AI / 人数 / 难度」 ── */
  function hideSetup() {
    var st = document.createElement('style');
    st.id = '__net_hidesetup';
    st.textContent =
      '#setupOv,#setup,#spiritOv{display:none!important;visibility:hidden!important;pointer-events:none!important}' +
      '#setupOv *,#setup *{pointer-events:none!important}' +
      '#btnAgain,#btnEndFloat,#btnRestart{display:none!important}';
    document.head.appendChild(st);
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest &&
              ev.target.closest('#btnRestart,#btnAgain,#btnEndFloat');
      if (t) { ev.preventDefault(); ev.stopPropagation(); tip('联机对局中不能重开，请回大厅'); }
    }, true);
  }
  /* 自然和弦的移动端布局已写进游戏页自身的响应式层（Harmonies/index.html 的
     @media(max-width:1049/899/620/420) 四档），联机页不再注入第二套 !important 样式，
     避免两套布局互相覆盖。这里只保留原来的 hideSetup / makeVeil 等非布局逻辑。 */

  function hideGameOverlays() {
    ['setupOv', 'spiritOv', 'endOv', 'btnEndFloat', 'btnAgain'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.classList.add('hidden');
    });
    var su = document.getElementById('setup'); if (su) su.classList.add('hidden');
    var ga = document.getElementById('game'); if (ga) ga.classList.remove('hidden');
  }

  /* ── 载入遮罩（房主初始化 / 客机等首份快照时盖住空白棋盘） ── */
  var veil = null;
  function makeVeil() {
    veil = document.createElement('div');
    veil.id = '__net_veil';
    veil.style.cssText = 'position:fixed;inset:0;z-index:99990;background:#0e1218f5;color:#e8edf4;' +
      'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;' +
      'font:14px/1.9 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;text-align:center;padding:20px';
    veil.innerHTML = '<div style="font-size:20px;font-weight:600;color:#d9b26a">房间 ' + ROOM + ' · 座位 ' + SEAT + '</div>' +
      '<div>' + (IS_HOST ? '正在初始化对局…' : '等待房主开局…') + '</div>' +
      '<div style="color:#8d9bad;font-size:12px">' + rosterText() + ' ｜ 规则由房主统一设定，本窗口只读</div>';
    document.body.appendChild(veil);
  }
  function hideVeil() { if (veil && veil.parentNode) veil.parentNode.removeChild(veil); }

  /* ── 联机角标 ─────────────────────────────────────────── */
  var badgeEl = null;
  function setBadge(online, myTurn, curWire) {
    try {
      if (!badgeEl) {
        badgeEl = document.createElement('div');
        badgeEl.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99997;max-width:330px;' +
          'background:rgba(17,26,36,.95);color:#e8edf4;border:1px solid #3d4d61;border-radius:10px;' +
          'padding:8px 12px;font:12px/1.7 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.6);pointer-events:none';
        document.body.appendChild(badgeEl);
      }
      var soloWithAI = (HUMANS === 1);
      var color = (online || soloWithAI) ? '#7fc8a0' : '#d9b26a';
      var line2;
      if (soloWithAI) line2 = '单人 + ' + AI_N + ' AI 模式 · AI 由本窗口代跑';
      else if (!online) line2 = '未发现其他窗口';
      else if (myTurn) line2 = '<span style="color:#7fc8a0">✅ 轮到你 · 就在本窗口操作</span>';
      else if (curWire == null || curWire < 0) line2 = '对局进行中';
      else if (isAI(curWire)) line2 = 'AI ' + (curWire + 1) + ' 行动中 · 房主窗口代跑';
      else line2 = '轮到 ' + label(curWire) + ' · 请到他的窗口操作';
      badgeEl.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
        color + ';margin-right:7px"></span><b>联机对战</b> · 座位 ' + SEAT +
        '<br><span style="color:#9fb0c2">房间 ' + ROOM + ' ｜ ' + rosterText() + '</span>' +
        '<br><span style="color:#c3cdd9">' + line2 + '</span>';
    } catch (e) {}
  }

  var tipEl = null, tipTimer = null;
  function tip(msg) {
    try {
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;' +
          'background:#1d2733;color:#e8edf4;border:1px solid #3d4d61;border-radius:10px;' +
          'padding:10px 18px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px #0008;pointer-events:none';
        document.body.appendChild(tipEl);
      }
      tipEl.textContent = msg;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { if (tipEl) tipEl.style.display = 'none'; }, 1800);
      tipEl.style.display = '';
    } catch (e) {}
  }

  hideSetup();
  makeVeil();

  /* 由传输层在 publish 定义之后填充：立即广播一次当前状态（不等 200ms 轮询） */
  var forcePublish = function () {};

  /* 原版这些入口在「不是自己回合」时是静默 return 的，玩家会以为界面坏了。
     这里补一条明确提示，只在真的点到了操作区时触发。 */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('#supply,#hand,#market,#sanctOffer,#boards')) return;
    try {
      if (typeof G === 'undefined' || !G.players || !G.players.length) return;
      if (G.over) { tip('对局已结束'); return; }
      if (G.cur !== 0) {
        var w = -1;
        try { w = (typeof A !== 'undefined' && A && A.currentWire) ? A.currentWire() : -1; } catch (e) {}
        tip('还没轮到你' + (w >= 0 ? '，现在是 ' + label(w) + ' 的回合' : ''));
      }
    } catch (e) {}
  }, true);

  /* 点「结束回合 / 撤回」后立刻广播一次，缩短「本地已交棒、房主还没收到」的窗口 */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('#btnEnd,#btnUndo,#btnUndoRound')) return;
    setTimeout(function () { try { forcePublish(); } catch (e) {} }, 40);
  }, true);

  /* ============================================================
   * 适配器 A：Harmonies（自然和弦）
   * 原逻辑写死「本地 players[0] = 人类，cur===0 才可操作，否则跑 aiTurn」。
   * 因此每个窗口把自己的座位换到本地 0，其余座位按序排开；
   * wire 状态始终是绝对座位，用 localToWire / wireToLocal 互相换算。
   * ============================================================ */
  function makeHarmonies() {
    var localToWire = [SEAT];
    for (var w = 0; w < TOTAL; w++) if (w !== SEAT) localToWire.push(w);
    var wireToLocal = [];
    localToWire.forEach(function (ww, l) { wireToLocal[ww] = l; });

    var origAiTurn = window.aiTurn;
    window.aiTurn = function () {};          // 完全接管 AI 驱动

    /* 联机交棒必须按「全局座位顺序」走，不能按本窗口重排后的本地数组顺序。
       客机把本地 0 换成了自己，localToWire 可能是 [1,0,2]；原版 advanceTurn()
       直接 G.cur = (G.cur + 1) % G.n，于是「座位 1 的真人结束回合」会跳回座位 0，
       座位 2 的 AI 永远轮不到，表现为 2 真人 + AI 时 AI 不行动。
       这里保留原版所有回合清理逻辑，只把「下一位」换算成 wire 座位再映射回本地。 */
    window.advanceTurn = function () {
      G.hand = []; G.handSel = -1; G.tookCard = false; G.cubeMode = null;
      G.tookSanct = false;
      G.undoStack = []; G.cubePlacedThisTurn = false;
      var curWire = localToWire[G.cur];
      var nextWire = (curWire + 1) % TOTAL;
      var firstWire = localToWire[G.first];
      G.cur = wireToLocal[nextWire];
      var newRound = (nextWire === firstWire);
      if (newRound) G.round++;
      if (G.cur === 0 && !G.over) {
        try { saveRoundStart(); } catch (e) {}
      }
      renderAll();
      if (G.endTriggered && newRound) { gameOver(); return; }
      if (G.cur === 0) {
        setMsg('第 ' + G.round + ' 轮 · 你的回合:点击供应区取一组标记');
      } else {
        setMsg(G.players[G.cur].name + ' 思考中…');
        aiTurn();
      }
    };
    /* 撤回：原版的 pushUndo / saveRoundStart 只快照「本地 players[0]」，在联机里
       本地 0 正好就是「我自己这个座位」，所以原样沿用即可。
       之前这里把两者都换成了空函数，导致 G.undoStack 永远为空、G.roundStart 永远为 null，
       「撤回上一步 / 撤回至回合开始」两个按钮就永远是禁用状态。
       撤回栈本身不进 wire（见 DROP）：它记录的是我自己版图的回滚点，
       传给对面窗口毫无意义，改由 apply() 按「回合归属」在本窗口维护。 */

    var DROP = { undoStack: 1, roundStart: 1 };
    var aiBusy = false, lastAiAt = 0, inited = false;

    function localPlain() {
      var o = {};
      Object.keys(G).forEach(function (k) {
        if (DROP[k] || typeof G[k] === 'function') return;
        o[k] = G[k];
      });
      return JSON.parse(JSON.stringify(o));
    }
    function toWire(local) {
      var ww = JSON.parse(JSON.stringify(local));
      var wp = new Array(TOTAL);
      local.players.forEach(function (p, l) { wp[localToWire[l]] = p; });
      ww.players = wp;
      ww.cur = localToWire[local.cur];
      ww.first = localToWire[local.first];
      ww.players.forEach(function (p, i) { p.isAI = isAI(i); p.name = 'P' + i; });
      return ww;
    }
    function toLocal(wire) {
      var l = JSON.parse(JSON.stringify(wire));
      var lp = new Array(TOTAL);
      wire.players.forEach(function (p, ww) { lp[wireToLocal[ww]] = p; });
      l.players = lp;
      l.cur = wireToLocal[wire.cur];
      l.first = wireToLocal[wire.first];
      l.players.forEach(function (p, idx) {
        p.isAI = idx !== 0;                 // 只有本地 0 是人类
        p.name = idx === 0 ? '你' : label(localToWire[idx]);
      });
      l.undoStack = []; l.roundStart = null; l.n = TOTAL;
      return l;
    }
    function replaceG(l) {
      Object.keys(G).forEach(function (k) { delete G[k]; });
      Object.assign(G, l);
    }
    function currentWire() { return this.ready() ? localToWire[G.cur] : -1; }

    /* 原版版图底图是「异步 onload 后再重绘」的：线上网络慢时，遮罩一收就会先看到一块黑棋盘，
       过一两秒才跳变成版图。这里让遮罩等底图就绪再收（最多等 2 秒），首帧即完整。 */
    var veilTimer = null;
    function hideVeilWhenBoardReady() {
      var done = false;
      var fin = function () {
        if (done) return;
        done = true;
        if (veilTimer) { clearTimeout(veilTimer); veilTimer = null; }
        try { renderAll(); } catch (e) {}
        hideVeil();
      };
      try {
        var key = { A: 'board_A.jpg', B: 'board_B.jpg', C: 'board_C.png', D: 'board_D.png' }[G.side] || 'board_A.jpg';
        var im = new Image();
        im.onload = fin;
        im.onerror = fin;
        im.src = 'Images/res/' + key;
      } catch (e) { fin(); return; }
      veilTimer = setTimeout(fin, 2000);
    }

    /* ── 自然之灵：每位真人各自 2 选 1 ────────────────────────────
       原版只在 setup() 里给本地玩家 0 弹「2 选 1」，其余座位直接发牌。
       联机要的是「每个真人自己挑一张」，所以 setup() 时先关掉 spirit，
       灵卡全部改由本桥在 setup 之后统一发放：
         · 按绝对座位切成 TOTAL 组候选，写进 G.spiritOffers（随快照同步）
         · AI 自动选第一张；真人各自在弹窗里点
         · 30 秒内没选完就强制补齐，避免整局卡在选卡界面
       ────────────────────────────────────────────────────────── */
    var mySpirit = null, spiritOvEl = null, spiritDeadline = 0;

    function spiritApplyTo(ws, def) {
      var l = wireToLocal[ws];
      if (l == null || !G.players || !G.players[l]) return false;
      if (G.players[l].spirit) return false;
      G.players[l].spirit = def;
      try { G.players[l].cards.push(mkCardInst(def)); } catch (e) {}
      G.spiritPicked = G.spiritPicked || {};
      G.spiritPicked[ws] = def.id;
      if (ws === SEAT) {
        mySpirit = def;
        /* 灵卡此时已经进手牌，重记一次「回合开始」基准；
           否则基准里没有灵卡，「撤回至回合开始」会把灵卡一起撤掉。 */
        if (G.cur === 0) { try { G.undoStack = []; saveRoundStart(); } catch (e) {} }
      }
      return true;
    }

    function spiritSetup() {
      var pool;
      try {
        pool = shuffle(SPIRIT_CARDS.map(function (c, i) { return Object.assign({}, c, { id: 's' + i }); }));
      } catch (e) { console.warn('[net] spirit pool', e); return; }
      G.spiritOffers = []; G.spiritPicked = {};
      for (var s = 0; s < TOTAL; s++) {
        G.spiritOffers.push([pool[(s * 2) % pool.length], pool[(s * 2 + 1) % pool.length]]);
      }
      for (var a = 0; a < TOTAL; a++) {
        if (isAI(a)) spiritApplyTo(a, G.spiritOffers[a][0]);
      }
      spiritDeadline = Date.now() + 30000;
    }

    /* 还有真人没选灵时返回 true（房主据此暂缓 AI，先让所有人选完） */
    function spiritMissing() {
      if (!G.mods || !G.mods.spirit || !G.spiritOffers) return false;
      var miss = [];
      for (var s = 0; s < TOTAL; s++) if (!G.spiritPicked || !G.spiritPicked[s]) miss.push(s);
      if (!miss.length) return false;
      /* 开局预加载进度条还盖着画面时，玩家根本看不到「自然之灵 2 选 1」弹窗。
         把兜底截止时间顺延到进度条放行之后，别让系统替玩家自动选掉。 */
      if (window.MGPreload && !window.MGPreload.done) {
        spiritDeadline = Date.now() + 30000;
        return true;
      }
      if (spiritDeadline && Date.now() > spiritDeadline) {
        miss.forEach(function (s) {
          var off = G.spiritOffers[s];
          if (off && off[0]) spiritApplyTo(s, off[0]);
        });
        try { hideSpiritPick(); } catch (e) {}
        return false;
      }
      return true;
    }

    function hideSpiritPick() {
      if (spiritOvEl && spiritOvEl.parentNode) spiritOvEl.parentNode.removeChild(spiritOvEl);
      spiritOvEl = null;
    }

    function showSpiritPick() {
      if (!G.mods || !G.mods.spirit || !G.spiritOffers) { hideSpiritPick(); return; }
      var mine = G.spiritOffers[SEAT];
      if (!mine || !mine.length || (G.spiritPicked && G.spiritPicked[SEAT])) { hideSpiritPick(); return; }
      if (spiritOvEl) return;
      /* 关键：iframe 在手机端的高度 = 整页内容高度，里面的 100vh 不等于屏幕高度，
         position:fixed 居中的弹窗会跑到一两千像素处，屏幕上根本看不到。
         所以用父页视口高度钳制，并从顶部开始排（父页同时会滚到顶部）。 */
      var vh = 800;
      try { vh = (window.parent && window.parent.innerHeight) || window.innerHeight || 800; } catch (e) {}
      var boxH = Math.max(320, Math.min(vh - 64, 900));
      spiritOvEl = document.createElement('div');
      spiritOvEl.id = '__net_spirit';
      spiritOvEl.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + boxH + 'px;' +
        'z-index:99995;background:#0b0e13f7;box-sizing:border-box;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
        'padding:16px 14px;overflow:auto;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      spiritOvEl.innerHTML =
        '<div style="font:600 17px/1.5 system-ui;color:#d9b26a;text-align:center">选择你的自然之灵</div>' +
        '<div style="font:12px/1.6 system-ui;color:#9fb0c2;text-align:center;max-width:440px">' +
        '两张里选一张，选定后本局不可更改。其他玩家在他们自己的窗口里各自选择。</div>' +
        '<div id="__net_spirit_pick" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center"></div>';
      document.body.appendChild(spiritOvEl);
      var wrap = spiritOvEl.querySelector('#__net_spirit_pick');
      mine.forEach(function (def) {
        var d;
        try { d = cardHtml({ def: def, placed: 0, done: false }); }
        catch (e) { d = document.createElement('div'); d.textContent = def.name; }
        d.style.cursor = 'pointer';
        d.style.maxWidth = 'min(44vw, 168px)';
        d.style.flex = '0 0 auto';
        d.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!spiritApplyTo(SEAT, def)) return;
          tip('已选择「' + def.name + '」');
          hideSpiritPick();
          try { renderAll(); } catch (e) {}
          forcePublish();
        }, true);
        wrap.appendChild(d);
      });
      /* 让外层把 iframe 滚回顶部，保证弹窗真的在屏幕上 */
      try {
        window.parent.postMessage({ __mygames: true, game: GAME, room: ROOM, seat: SEAT,
          status: 'needPick' }, '*');
      } catch (e) {}
    }

    return {
      currentWire: currentWire,
      ready: function () { return !!(G.players && G.players.length >= 2); },
      myTurn: function () { return this.ready() && G.cur === 0 && !G.over; },
      snapshot: function () { return this.ready() ? toWire(localPlain()) : null; },
      extra: function () {
        var lg = document.getElementById('log'), ms = document.getElementById('msg');
        return { log: lg ? lg.innerHTML : '', msg: ms ? ms.textContent : '' };
      },
      /* 仅房主调用：直接写 G 的属性后调原版 setup()，不经过任何可见设置控件 */
      init: function () {
        if (inited) return;
        inited = true;
        G.side = CFG.side || 'A';
        G.n = TOTAL;
        G.firstChoice = 'me';
        G.mods = Object.assign({ pulse: true, spirit: false, cres: false, sanct: false }, CFG.mods || {});
        var wantSpirit = !!G.mods.spirit;
        /* 先关掉自然之灵再 setup()：原版会在 setup 里给本地玩家 0 弹「2 选 1」、
           给其余座位自动发牌，并且不调 beginTurn()。联机需要「每位真人各自 2 选 1」，
           所以让 setup 走普通分支，灵卡改由 spiritSetup() 统一发放。 */
        G.mods.spirit = false;
        setup();                            // 构建牌库 / 玩家 / 版图（aiTurn 已被屏蔽）
        G.mods.spirit = wantSpirit;
        if (wantSpirit) spiritSetup();
        var fs = resolveFirst();
        G.first = fs; G.cur = fs; G.round = 1;
        G.players.forEach(function (p, i) {
          p.isAI = i !== 0;
          p.name = i === 0 ? '你' : label(i);   // 房主 seat=0，本地索引即绝对座位
        });
        G.undoStack = []; G.roundStart = null; G.cubePlacedThisTurn = false;
        /* 房主自己是先手时收不到「自己的」快照，apply() 里的重建对它不生效，
           所以开局要在这里记一次基准；带自然之灵时改由选灵成功后补记。 */
        if (G.cur === 0 && !wantSpirit) { try { saveRoundStart(); } catch (e) {} }
        hideGameOverlays();
        buildBoards(); renderGameAid(); renderAll();
        if (wantSpirit) { try { showSpiritPick(); } catch (e) {} }
        hideVeilWhenBoardReady();
      },
      apply: function (wire, extra) {
        var wasEmpty = !this.ready();
        /* 撤回栈不进 wire（见 DROP），这里在 replaceG 之前先把它取出来，
           否则每收到一次快照就会把玩家自己的撤回记录清空 —— 这是「撤回按不了」的第二个原因。 */
        var prevCur = wasEmpty ? -1 : G.cur;
        var prevUndo = wasEmpty ? [] : (G.undoStack || []);
        var prevRound = wasEmpty ? null : (G.roundStart || null);
        replaceG(toLocal(wire));
        /* 自己已经选过灵、但快照里还没体现（选择还没同步到房主）时，用本地缓存补回，
           否则会「选完又弹一次」。这一步必须排在「重建撤回栈」之前，
           因为 saveRoundStart() 会把灵卡一起记进基准，顺序反了「撤回至回合开始」会撤掉灵卡。 */
        if (mySpirit && G.players && G.players[0] && !G.players[0].spirit) {
          G.players[0].spirit = mySpirit;
          try { G.players[0].cards.push(mkCardInst(mySpirit)); } catch (e) {}
          G.spiritPicked = G.spiritPicked || {};
          G.spiritPicked[SEAT] = mySpirit.id;
        }
        /* 按回合归属重建撤回栈：
           · 轮到我了、上一帧也轮到我 → 保留（同一回合内继续操作，撤回记录不该丢）
           · 轮到我了、上一帧不是我 → 我的新回合，清空并记下「回合开始」快照
           · 不是我 → 清空（我的回合已结束，别人的操作不可撤回） */
        if (G.cur === 0 && !G.over) {
          if (prevCur === 0 && prevRound) {
            G.undoStack = prevUndo;
            G.roundStart = prevRound;
          } else {
            G.undoStack = [];
            G.roundStart = null;
            try { saveRoundStart(); } catch (e) {}
          }
        } else {
          G.undoStack = [];
          G.roundStart = null;
        }
        if (wasEmpty) {
          try { buildBoards(); } catch (e) {}
          try { renderGameAid(); } catch (e) {}
          hideGameOverlays();
        }
        try { renderAll(); }
        catch (e) {
          console.error('[net] renderAll', e);
          tell('error', '渲染异常：' + (e && e.message));
        }
        if (extra) {
          var lg = document.getElementById('log'); if (lg && extra.log != null) lg.innerHTML = extra.log;
        }
        if (wasEmpty) hideVeilWhenBoardReady(); else hideVeil();
        try { showSpiritPick(); } catch (e) {}
        /* 立刻刷新回合提示：apply 只重绘棋盘，不会改 #msg，
           否则客机交棒后会一直显示上一位玩家的「思考中…」 */
        try { if (this.cosmetics) this.cosmetics(); } catch (e) {}
      },
      /* AI 只由房主窗口执行，一次一步，不依赖游戏自带的递归链 */
      kickAI: function () {
        if (!IS_HOST || aiBusy || !this.ready() || G.over) return;
        if (spiritMissing()) return;         // 还有真人没选灵，先不开回合
        if (G.cur === 0) return;
        var cw = localToWire[G.cur];
        if (!isAI(cw)) return;
        if (Date.now() - lastAiAt < 450) return;
        lastAiAt = Date.now(); aiBusy = true;
        Promise.resolve().then(function () { return origAiTurn(); })
          .catch(function (e) { console.error('[net] aiTurn', e); })
          .then(function () { aiBusy = false; });
      },
      cosmetics: function () {
        if (!this.ready()) return;
        var changed = false;
        if (G.players[0].name !== '你') { G.players[0].name = '你'; changed = true; }
        for (var l = 1; l < G.players.length; l++) {
          var nm = label(localToWire[l]);
          if (G.players[l].name !== nm) { G.players[l].name = nm; changed = true; }
        }
        if (changed) { try { renderAll(); } catch (e) {} }
        if (G.over) return;
        var ms = document.getElementById('msg');
        if (!ms) return;
        var cw = localToWire[G.cur];
        var t = G.cur === 0 ? '第 ' + G.round + ' 轮 · 你的回合（在本窗口操作）'
          : (isAI(cw) ? 'AI ' + (cw + 1) + ' 思考中…（房主窗口代跑）'
                      : '轮到 ' + label(cw) + ' · 请到他的窗口操作');
        if (ms.textContent !== t) ms.textContent = t;
      }
    };
  }

  /* ============================================================
   * 适配器 B：The White Castle（姬路城）
   * 引擎的 apply(g,cmd) 是唯一状态入口，WCUI.game()/render() 是官方钩子。
   * 把所有 players[].isAI 设为 false → 游戏自带 drive() 永远不会跑 AI；
   * AI 改由本桥在房主窗口用 legalCommands + WCAI.chooseMove 单步驱动。
   * ============================================================ */
  function makeCastle() {
    var E = window.WCEngine, U = window.WCUI;
    var origApply = E.apply, origNew = E.newGame;
    var inApply = false, bridgeApply = false, aiBusy = false, lastAiAt = 0, inited = false;

    function actorSeat(g) {
      if (!g || !g.players) return -1;
      if (g.pending) return g.pending.playerId;
      if (g.phase === 'play') {
        try { var p = E.currentPlayer(g); return p ? g.players.indexOf(p) : -1; } catch (e) { return -1; }
      }
      return -1;
    }
    function plain(g) {
      var o = {};
      Object.keys(g).forEach(function (k) { if (typeof g[k] !== 'function') o[k] = g[k]; });
      return JSON.parse(JSON.stringify(o));
    }
    function clickSeg(group, v) {
      try {
        var seg = document.querySelector('.seg[data-group="' + group + '"]');
        var b = seg && seg.querySelector('button[data-v="' + v + '"]');
        if (b) b.click();
      } catch (e) {}
    }
    function installDom() {
      clickSeg('players', String(TOTAL));
      clickSeg('diff', CFG.difficulty || 'normal');
      clickSeg('order', CFG.order || 'first');
      clickSeg('seat', '0');
    }

    /* firstSeat 决定谁第一个行动；order（原版先手/后手/随机）决定座位 0
       在其余轮转中的相对位置。两者都真实生效，不互相覆盖。 */
    function buildTurnOrder() {
      var fs = resolveFirst(), ord = CFG.order || 'first';
      var rest = [];
      for (var k = 0; k < TOTAL; k++) if (k !== fs) rest.push(k);
      if (fs !== 0) {
        rest = rest.filter(function (x) { return x !== 0; });
        if (ord === 'second') rest.push(0);
        else if (ord === 'random') rest.splice(Math.floor(Math.random() * (rest.length + 1)), 0, 0);
        else rest.unshift(0);
      }
      return [fs].concat(rest);
    }

    /* 强制按房间配置开局：席位数、名字、AI 标记、先手轮转顺序 */
    E.newGame = function () {
      var args = Array.prototype.slice.call(arguments);
      args[0] = Object.assign({}, args[0] || {}, {
        playerCount: TOTAL, humanSeat: 0,
        difficulty: CFG.difficulty || 'normal', order: CFG.order || 'first'
      });
      var g = origNew.apply(this, args);
      if (g && g.players) {
        g.players.forEach(function (p, i) {
          p.isAI = false;                 // 关键：任何窗口都不让 ui.js 的 drive() 自跑 AI
          p.name = isAI(i) ? ('AI ' + (i + 1) + '（电脑）') : (NAMES[i] || ('玩家 ' + (i + 1)));
        });
        var order = buildTurnOrder();
        g.turnOrder = order; g.turnIdx = 0;
        if (g.pending && g.pending.kind === 'draft') {
          var d = order.slice().reverse();
          g.pending.order = d; g.pending.playerId = d[0]; g.pending.idx = 0;
        }
      }
      return g;
    };

    /* 座位控制：只有当前行动者本人能落子；AI 回合由桥内部驱动 */
    E.apply = function (g, cmd) {
      if (inApply || bridgeApply) return origApply.apply(this, arguments);
      if (cmd && cmd.type === 'undo') { tip('联机模式禁用悔棋'); return; }
      var gg = g || U.game();
      if (gg && gg.players) {
        var s = actorSeat(gg);
        if (s >= 0) {
          if (isAI(s)) { tip('AI 正在行动…（由房主窗口代跑）'); return; }
          if (s !== SEAT) { tip('现在轮到 ' + label(s) + '，请到他的窗口操作'); return; }
        }
      }
      inApply = true;
      try { return origApply.apply(this, arguments); } finally { inApply = false; }
    };

    return {
      ready: function () { return !!U.game(); },
      currentWire: function () { var g = U.game(); return g ? actorSeat(g) : -1; },
      myTurn: function () {
        var g = U.game(); if (!g) return false;
        var s = actorSeat(g); return s >= 0 && s === SEAT && !isAI(s);
      },
      snapshot: function () { var g = U.game(); return g ? plain(g) : null; },
      extra: function () { return null; },
      init: function () {
        if (inited) return;
        inited = true;
        installDom();
        var btn = document.getElementById('btnStart');
        if (btn) btn.click();               // startGame() → E.newGame（已被包装）
        hideGameOverlays();
        hideVeil();
      },
      apply: function (wire) {
        var g = U.game();
        if (!g) {
          installDom();
          var btn = document.getElementById('btnStart');
          if (btn) btn.click();
          g = U.game();
          if (!g) return;
        }
        hideGameOverlays();
        var onUpdate = (typeof g.onUpdate === 'function') ? g.onUpdate : null;
        Object.keys(g).forEach(function (k) { delete g[k]; });
        Object.assign(g, wire);
        if (onUpdate) g.onUpdate = onUpdate;
        try { U.render(); } catch (e) { console.error('[net] render', e); }
        hideVeil();
      },
      kickAI: function () {
        if (!IS_HOST || aiBusy) return;
        var g = U.game();
        if (!g || g.phase === 'gameEnd') return;
        var s = actorSeat(g);
        if (s < 0 || !isAI(s)) return;
        if (Date.now() - lastAiAt < 400) return;
        lastAiAt = Date.now(); aiBusy = true;
        setTimeout(function () {
          try {
            var g2 = U.game();
            if (!g2) return;
            var s2 = actorSeat(g2);
            if (s2 < 0 || !isAI(s2)) return;
            var cmds = E.legalCommands(g2).filter(function (c) { return c.type !== 'undo'; });
            if (!cmds.length) return;
            var cmd;
            try { cmd = window.WCAI.chooseMove(g2, cmds) || cmds[0]; }
            catch (e) { cmd = cmds[0]; }
            bridgeApply = true;
            try { origApply(g2, cmd); } finally { bridgeApply = false; }
            try { U.render(); } catch (e) {}
          } catch (e) { console.error('[net] castle AI', e); }
          finally { aiBusy = false; }
        }, 300);
      },
      cosmetics: function () {}
    };
  }

  /* per-game 适配器注册表；新增游戏在 makeX 后加一条 */
  var ADAPTERS = { harmonies: makeHarmonies, castle: makeCastle };
  var A;
  try { A = ADAPTERS[GAME] ? ADAPTERS[GAME]() : makeVeil(); }
  catch (e) { tell('error', e && e.message); return; }

  /* ── 传输层 ──────────────────────────────────────────────
   * 重要：POST 不能带 keepalive。Chromium 对 keepalive 请求有累计
   * 体积配额（约 64KiB），约 12KB 的完整状态快照发过几次后会全部
   * Failed to fetch，导致对局中途彻底断流（只有小体积 ping 还能到）。
   * 这些请求都发生在页面存活期间，本就不需要 keepalive。
   * ────────────────────────────────────────────────────── */
  var emit = function () {};
  if (MODE === 'peer') {
    if (typeof Peer !== 'function') {
      tell('error', 'PeerJS 库未加载');
      return;
    }
    var rtcHostId = 'mg-' + GAME + '-' + ROOM + '-bridge';
    var rtcPeer = null, rtcHostConn = null, rtcConns = {};
    function rtcData(d) {
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { return; }
      }
      incoming(d);
    }
    function rtcAttach(conn) {
      if (!conn) return;
      rtcConns[conn.peer] = conn;
      conn.on('data', rtcData);
      conn.on('close', function () { delete rtcConns[conn.peer]; });
      conn.on('error', function (e) { console.warn('[peer] bridge conn', e); });
      conn.on('open', function () {
        if (A.ready()) { try { broadcastState(); } catch (e) {} }
      });
    }
    function rtcConnectHost() {
      if (IS_HOST || !rtcPeer || rtcPeer.destroyed) return;
      if (rtcHostConn && rtcHostConn.open) return;
      try {
        rtcHostConn = rtcPeer.connect(rtcHostId, { reliable: true });
        rtcHostConn.on('open', function () {
          tell('peer-connected', '已连接房主');
          send({ kind: 'hello', seen: lastRev });
        });
        rtcHostConn.on('data', rtcData);
        rtcHostConn.on('close', function () {
          tell('waiting');
          setTimeout(rtcConnectHost, 2000);
        });
        rtcHostConn.on('error', function (e) { console.warn('[peer] guest bridge conn', e); });
      } catch (e) { setTimeout(rtcConnectHost, 2500); }
    }
    try {
      rtcPeer = IS_HOST ? new Peer(rtcHostId, { debug: 0 }) : new Peer(PEER, { debug: 0 });
    } catch (e) {
      tell('error', 'PeerJS 初始化失败：' + ((e && e.message) || e));
      return;
    }
    emit = function (m) {
      if (IS_HOST) {
        Object.keys(rtcConns).forEach(function (k) {
          var c = rtcConns[k];
          if (c && c.open) { try { c.send(m); } catch (e) {} }
        });
      } else if (rtcHostConn && rtcHostConn.open) {
        try { rtcHostConn.send(m); } catch (e) {}
      }
    };
    rtcPeer.on('open', function (id) {
      PEER = id;
      tell('peer-ready', 'PeerJS');
      if (IS_HOST) {
        if (A.ready()) { try { broadcastState(); } catch (e) {} }
      } else {
        rtcConnectHost();
      }
    });
    rtcPeer.on('connection', function (conn) {
      if (IS_HOST) rtcAttach(conn);
    });
    rtcPeer.on('error', function (e) {
      var type = (e && e.type) || 'error';
      if (type === 'peer-unavailable') {
        if (!IS_HOST) setTimeout(rtcConnectHost, 2500);
        return;
      }
      if (type === 'unavailable-id') {
        tell('error', 'PeerJS 房间桥接 ID 已被占用');
        return;
      }
      tell('error', 'PeerJS ' + type + '：' + ((e && e.message) || ''));
    });
    window.addEventListener('pagehide', function () { try { rtcPeer.destroy(); } catch (e) {} });
  } else if (MODE === 'net') {
    var es = new EventSource('../net/room?room=' + encodeURIComponent(CHANNEL) + '&peer=' + PEER);
    es.onmessage = function (ev) { try { incoming(JSON.parse(ev.data)); } catch (e) {} };
    es.onerror = function () { tell('waiting'); };
    emit = function (m) { postRoom(m, 0); };
    window.addEventListener('pagehide', function () { try { es.close(); } catch (e) {} });
  } else {
    var bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = function (ev) { incoming(ev.data); };
    emit = function (m) { bc.postMessage(m); };
    window.addEventListener('pagehide', function () { try { bc.close(); } catch (e) {} });
  }

  function postRoom(m, retry) {
    var body;
    try { body = JSON.stringify(m); } catch (e) { return; }
    netStat.tx++;
    netStat.txBytes += body.length;
    netStat.lastTxAt = Date.now();
    fetch('../net/room?room=' + encodeURIComponent(CHANNEL), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
    }).then(function (r) {
      if (!r.ok && retry < 2) setTimeout(function () { postRoom(m, retry + 1); }, 250);
    }).catch(function () {
      if (retry < 2) setTimeout(function () { postRoom(m, retry + 1); }, 250);
    });
  }

  function send(m) { m.peer = PEER; m.seat = SEAT; m.t = Date.now(); emit(m); }

  /* 只有本窗口发生真实交互后才允许非房主窗口广播状态，避免把刚收到的
     远端快照原样回弹、把自己的 rev 抬得比房主还高。 */
  var lastLocalAction = 0;
  ['pointerdown', 'click', 'keydown', 'touchstart'].forEach(function (t) {
    document.addEventListener(t, function () { lastLocalAction = Date.now(); }, true);
  });

  /* ── 同步协议 ────────────────────────────────────────────
   * rev 为 Lamport 时钟；每条状态原样重发两次（同 rev 去重），
   * 客机长时间收不到状态就主动 sync 拉全量，保证最终收敛。
   * ────────────────────────────────────────────────────── */
  var lastRev = 0, lastHash = '', joined = false;
  var peerRev = {};                     // 每个发送者已发过的最大 rev（仅用于丢乱序）
  var lastLocalEdit = 0;                // 本窗口最近一次真正改动游戏状态的时刻
  var lastPeerAt = 0, lastStateAt = Date.now(), peerOnline = false;

  /* 60ms 合并窗口：连续动作（拿卡→放方块→结束回合）只发最后一份状态，
     避免每个动作都把整份 snapshot 广播三遍。 */
  var pendingPublish = null, publishTimer = 0;
  function flushPublish() {
    if (publishTimer) { clearTimeout(publishTimer); publishTimer = 0; }
    var p = pendingPublish; pendingPublish = null;
    if (!p) return;
    var msg = { kind: 'state', rev: ++lastRev, snap: p.s, extra: p.extra };
    send(msg);
    /* 只补一次；host/客机的 300ms 兜底轮询会继续收敛，不再额外占带宽 */
    setTimeout(function () { send(msg); }, 500);
  }
  function publish(s, extra) {
    pendingPublish = { s: s, extra: extra };
    lastHash = JSON.stringify(s);
    lastLocalEdit = Date.now();
    if (publishTimer) return;
    publishTimer = setTimeout(flushPublish, 60);
  }
  /* 选灵这类一次性操作要立刻广播，不能等 200ms 轮询（也不能被 5 秒静默规则挡掉） */
  forcePublish = function () {
    try {
      var s = A.snapshot();
      if (!s) return;
      lastLocalAction = Date.now();
      publish(s, A.extra());
      tell('synced');
    } catch (e) {}
  };
  function broadcastState(seen) {
    var s = A.snapshot();
    if (!s) return;
    lastRev = Math.max(lastRev, seen || 0);
    publish(s, A.extra());
  }

  function incoming(m) {
    if (!m || m.peer === PEER) return;
    netStat.rx++;
    try { netStat.rxBytes += JSON.stringify(m).length; } catch (e) {}
    netStat.lastRxAt = Date.now();
    if (m.t) netStat.lastLatency = Date.now() - m.t;
    var applyStart = (window.performance && performance.now) ? performance.now() : 0;
    lastPeerAt = Date.now();
    if (!peerOnline) { peerOnline = true; tell('online'); }
    if (m.seat === SEAT) { tell('sameSeat', '有两个窗口占用了座位 ' + SEAT); return; }
    if (m.kind === 'ping') return;
    if (m.kind === 'hello' || m.kind === 'sync') {
      if (IS_HOST && A.ready()) { broadcastState(m.seen); tell('connected'); }
      return;
    }
    if (m.kind !== 'state') return;
    var hh = '';
    try { hh = JSON.stringify(m.snap); } catch (e) {}
    if (hh === lastHash) { lastRev = Math.max(lastRev, m.rev || 0); return; }
    /* 客机刚做过本地操作、而远端快照里「当前回合仍然是我」时，不能接受这份快照：
       那只是房主还没收到我这次操作的旧状态，接受了等于把我的操作回滚
       （表现就是：点完「结束回合」界面又跳回自己回合，永远轮不到对手）。 */
    if (!IS_HOST && m.snap && m.snap.cur === SEAT && Date.now() - lastLocalEdit < 3000) return;
    /* rev 只在「同一个发送者」内部比较，用来丢弃乱序重发。
       绝不能跨窗口比 rev：两端各自 ++lastRev，操作次数多的一方计数会越涨越高，
       另一方的快照就会被永久判为「更旧」而丢弃 —— 典型表现就是
       房主点了结束回合，客机却还停在旧状态，点供应区/手牌全都没反应。 */
    if (m.peer) {
      if (m.rev != null && peerRev[m.peer] != null && m.rev < peerRev[m.peer]) return;
      peerRev[m.peer] = Math.max(peerRev[m.peer] || 0, m.rev || 0);
    }
    lastRev = Math.max(lastRev, m.rev || 0);
    lastStateAt = Date.now();
    /* 本地还有未发出的合并状态：先发出去，再应用远端，避免 60ms 定时器
       在远端快照之后又把旧状态广播出去。 */
    flushPublish();
    try {
      A.apply(m.snap, m.extra);
      var cur = A.snapshot();
      lastHash = cur ? JSON.stringify(cur) : '';
      joined = true;
      tell('synced');
    } catch (e) { console.error('[net] apply remote', e); tell('error', e && e.message); }
    if (applyStart) netStat.lastApplyMs = Math.round(((window.performance && performance.now ? performance.now() : 0) - applyStart) * 10) / 10;
  }

  /* ── 房主收到父页命令才初始化；客机不初始化，等第一份快照 ── */
  var started = false;
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__mygames_cmd !== 'start' || !IS_HOST || started) return;
    started = true;
    try {
      A.init();
      /* 主机本地存档：必须排在 A.init() 之后，否则 setup() 会把恢复的状态覆盖掉。
         只有座位 0 会走到这里（客机在 save.js 顶部就 return 了）。
         玩家选「继续」后由 publish() 把恢复后的局面广播给客机，状态仍以主机为准。 */
      try {
        if (window.MGSave && window.MGSave.onNetReady) {
          window.MGSave.onNetReady({
            seat: SEAT, game: GAME, room: ROOM, cfg: CFG,
            publish: function () { forcePublish(); }
          });
        }
      } catch (e) { console.warn('[net] save restore', e); }
      broadcastState(); tell('started');
    }
    catch (e) { tell('error', e && e.message); }
  });

  send({ kind: 'hello', seen: lastRev });
  setInterval(function () { send({ kind: 'ping' }); }, 2000);
  var handshake = setInterval(function () {
    if (joined) { clearInterval(handshake); return; }
    if (!IS_HOST) send({ kind: 'sync', seen: lastRev });
  }, 1200);
  /* 断流兜底：长时间收不到任何状态快照就向房主拉一次全量 */
  setInterval(function () {
    if (IS_HOST || !A.ready()) return;
    if (Date.now() - lastStateAt > 5000) send({ kind: 'sync', seen: lastRev });
  }, 1500);

  /* 本地变更 → 广播 */
  setInterval(function () {
    if (!A.ready()) return;
    if (!IS_HOST && !joined) return;
    var s = A.snapshot();
    if (!s) return;
    var h = JSON.stringify(s);
    if (h === lastHash) return;
    if (!IS_HOST && Date.now() - lastLocalAction > 5000) { lastHash = h; return; }
    /* 主机状态变化时不再额外写档：save.js 的 400ms 轮询会按签名落盘/上传。
       这里只负责把变化尽早广播。 */
    publish(s, A.extra());
    tell('synced');
  }, 300);

  /* AI 单独用更快的节拍驱动（只在房主窗口生效） */
  setInterval(function () {
    try { if (A.kickAI) A.kickAI(); } catch (e) {}
  }, 300);

  /* 角标 / 在线状态 */
  setInterval(function () {
    var online = lastPeerAt > 0 && (Date.now() - lastPeerAt) < 6000;
    if (online !== peerOnline) { peerOnline = online; tell(online ? 'online' : 'alone'); }
    try { if (A.cosmetics) A.cosmetics(); } catch (e) {}
    var cw = -1;
    try { cw = A.currentWire ? A.currentWire() : -1; } catch (e) {}
    setBadge(online, A.myTurn ? A.myTurn() : false, cw);
  }, 500);

  tell('ready');
})();
