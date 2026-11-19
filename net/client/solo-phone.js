(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  /* 手机壳外层每次升级都会换 v；把同一个 v 传给 iframe 里的游戏页，
     否则游戏页 HTML/旧 UI 可能被浏览器缓存，界面看起来像没改。 */
  var shellV = qs.get('v') || '20261119i';
  function withV(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(shellV);
  }

  /* 游戏目录 / 名称来自根 games.json 生成的 MG_GAMES；新增游戏只改清单 */
  var CFG = (window.MG_GAMES && window.MG_GAMES.games) || {};
  var GAMES = {};
  Object.keys(CFG).forEach(function (k) {
    GAMES[k] = { url: withV('../../' + (CFG[k].entry || '')), name: CFG[k].subtitle || CFG[k].title || k };
  });
  if (!Object.keys(GAMES).length) {
    GAMES = { harmonies: { url: withV('../../Harmonies/index.html'), name: '自然和弦' }, castle: { url: withV('../../The White Castle/index.html'), name: '白城' } };
  }

  var qk = qs.get('game');
  var key = GAMES[qk] ? qk : Object.keys(GAMES)[0];
  var cfg = GAMES[key];

  var frame = document.getElementById('frame');
  var pan = document.getElementById('pan');
  var wrap = document.getElementById('wrap');
  var ratio = document.getElementById('ratio');
  var btnMode = document.getElementById('btnMode');
  var premask = document.getElementById('premask');

  /* 游戏页的预加载进度（iframe 内 preload.js 汇报）。外壳页这一层不受缩放影响；
     没收到 lock 就完全不显示，单机老缓存页面行为不变。 */
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__mg_preload) return;
    if (d.status === 'lock') {
      premask.style.display = 'flex';
      wrap.scrollTop = 0;
      wrap.classList.add('preload-lock');
    } else if (d.status === 'progress') {
      var pct = d.total ? Math.round(d.loaded * 100 / d.total) : 0;
      premask.querySelector('.fill').style.width = pct + '%';
      premask.querySelector('.n').textContent = d.loaded + ' / ' + d.total + ' · ' + pct + '%';
    } else if (d.status === 'done') {
      premask.style.display = 'none';
      wrap.classList.remove('preload-lock');
      wrap.scrollTop = 0;
    }
  });

  document.getElementById('ttl').textContent = cfg.name;
  document.title = cfg.name + ' · 单机';

  var fitMode = true;     /* true = 等比缩放适配；false = 原尺寸（可横向滚动） */
  var baseW = 0;          /* 当前排版用的基准宽度 */
  var lastH = 0;

  /* 单机版页面在窄屏下的两处硬伤，只在外壳页注入样式修正，游戏文件不动：
     1) #market 是 flex-wrap:nowrap 的 5 张 144px 卡（744px + 内边距 = 760px），
        把整个 .layout 的 min-content 顶到 760px，于是任何小于 760px 的屏幕都横向溢出。
        改成两列网格后 min-content 归零，页面才能按屏幕宽排。
     2) 设置弹窗内容比视口高，「开始游戏」被推到滚动区外 150px 左右，
        手机上要滚很久才找得到；把内容区改成自己滚、按钮常驻底部。 */
  var SOLO_CSS = [
    /* —— 公共区：市场 / 保护区改两列网格 —— */
    /* 卡高沿用游戏自己的 --pubCardH(240px)，图片用 contain 不裁切：
       动物卡是竖版，压成方形再用 cover 会把卡面文字裁掉。 */
    'html.__solo #market{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(132px,1fr))!important;',
    '  gap:6px!important;flex:none!important;justify-content:stretch!important;height:auto!important}',
    'html.__solo #market .acard,html.__solo #market .market-card{width:auto!important;',
    '  height:var(--pubCardH,240px)!important;flex:none!important;min-width:0!important}',
    'html.__solo #market .acard .aimg,html.__solo #market .market-card .aimg{object-fit:contain!important}',
    'html.__solo #sanctOffer{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(132px,1fr))!important;',
    '  gap:6px!important;flex:none!important}',
    'html.__solo #sanctOffer .acard{width:auto!important;flex:none!important;min-width:0!important}',
    /* 5:3 分栏在窄屏会让市场只剩一列，公共区两排改纵向 */
    'html.__solo .public-row{flex-direction:column!important}',
    'html.__solo .public-row .pub-market,html.__solo .public-row .pub-sanct{width:100%!important;flex:none!important}',
    /* 版图卡牌行原本 nowrap（zoom .75 × 4 张 120px ≈ 360px），
       拿到多张保护区板块 / 动物卡后会再次顶出屏幕，允许换行 */
    'html.__solo .board-card .card .card-row{flex-wrap:wrap!important}',
    'html.__solo .board-card .card .acard{max-width:100%!important}',
    /* —— 设置弹窗：按钮常驻底部 ——
       iframe 的高度被设成「整页内容高度」，所以里面的 100vh/94vh 等于内容高度而不是屏幕高度，
       弹窗会被撑到屏幕外。这里用外壳传进来的 --solo-vh（真实可见高度）覆盖掉。 */
    'html.__solo .overlay{height:var(--solo-vh,100vh)!important;bottom:auto!important;',
    '  align-items:flex-start!important;padding:8px 0!important;overflow:auto!important}',
    'html.__solo .overlay .modal{max-height:calc(var(--solo-vh,100vh) - 16px)!important}',
    'html.__solo #setupOv .modal{display:flex!important;flex-direction:column!important;',
    '  padding:16px 14px 12px!important}',
    'html.__solo #setupOv .modal>.setup-cols{flex:1 1 auto!important;min-height:0!important;',
    '  overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;padding-right:2px}',
    'html.__solo #setupOv #btnStart{position:sticky!important;bottom:0!important;margin-top:10px!important;',
    '  z-index:3!important;box-shadow:0 -8px 16px rgba(10,12,16,.85)}',
    /* —— 对局中的选择弹窗 / 记录区 ——
       iframe 高度被设成整页内容高度，里面的 fixed / 100vh 会以整页高度为基准，
       选择弹窗就会落在整页中间（手机上要往下拖很久）。
       外壳把「当前可见区域」换算成 --solo-top / --solo-vh 传进来：
       弹窗改成绝对定位，钉在用户此刻看到的区域顶部；记录区按可见高度限高、自己滚。 */
    'html.__solo .modal-root{position:absolute!important;left:0!important;right:0!important;',
    '  top:var(--solo-top,0px)!important;height:var(--solo-vh,100vh)!important;bottom:auto!important;',
    '  place-items:start center!important;align-items:start!important;justify-items:center!important;',
    '  padding:8px 10px!important;overflow:auto!important;-webkit-overflow-scrolling:touch!important}',
    'html.__solo .modal-root .modal{width:100%!important;max-height:calc(var(--solo-vh,100vh) - 16px)!important;',
    '  margin:0!important}',
    'html.__solo .modal-root .modal>div:last-child{flex:1 1 auto!important;min-height:0!important;',
    '  -webkit-overflow-scrolling:touch!important}',
    'html.__solo .side .log-wrap:not(.stats-wrap){max-height:calc(var(--solo-vh,100vh) * .38)!important}',
    'html.__solo .side .log-wrap:not(.stats-wrap) .log{max-height:calc(var(--solo-vh,100vh) * .38 - 34px)!important;',
    '  overflow-y:auto!important;-webkit-overflow-scrolling:touch!important}',
    /* —— 开局设置页 ——
       .setup 的 min-height:100vh 在 iframe 里等于整页高度，会把设置卡推到页面中段；
       底图 cover 也跟着整页放大。手机壳里去掉底图、取消 100vh、设置卡直接贴顶。 */
    'html.__solo .setup{min-height:0!important;display:block!important;padding:10px!important;',
    '  border:0!important;background:#0d0b0a!important}',
    'html.__solo .setup-card{width:100%!important;margin:8px auto 18px!important;',
    '  padding:26px 18px 20px!important}',
    /* 触控目标放大 */
    'html.__solo .btn{padding:12px 10px!important;min-height:44px!important}',
    'html.__solo .opt{min-height:38px}',
    /* 游戏自带的整体缩放条在手机上会压住标题，改由外壳顶栏控制 */
    'html.__solo #zoomCtl{display:none!important}'
  ].join('');

  function injectCss(d) {
    if (!d || !d.head) return;
    var old = d.getElementById('__solo_css');
    if (old) old.parentNode.removeChild(old);
    var st = d.createElement('style');
    st.id = '__solo_css';
    st.textContent = SOLO_CSS;
    d.head.appendChild(st);
    try { d.documentElement.classList.add('__solo'); } catch (e) {}
  }

  function doc() {
    try { return frame.contentDocument; } catch (e) { return null; }
  }
  function win() {
    try { return frame.contentWindow; } catch (e) { return null; }
  }

  function contentH(d, w) {
    return MGShell.contentH(frame, d, w, 16);
  }

  /* 找「刚好不横向溢出」的最小宽度：共享实现，见 mobile-shell.js */
  function minBaseW(d, vw) {
    return MGShell.minBaseW(frame, d, vw);
  }

  /* 把「外层当前可见区域」换算成 iframe 内部的坐标。
     iframe 被 scale(s) 缩放，里面 1px = 屏幕上 s px；所以：
       --solo-vh  = 可见高度 / s
       --solo-top = 外层已滚动距离 / s + iframe 自身滚动距离
     对局里的选择弹窗用这两个值定位到用户此刻看到的区域，而不是整页中间。 */
  var lastScale = 1;
  function setViewportVars(d, w, s) {
    if (!d) return;
    if (!s || s < 0.01) s = 1;
    lastScale = s;
    var innerScroll = 0;
    try { innerScroll = (w && w.scrollY) || 0; } catch (e) {}
    var vh = Math.round(Math.max(1, wrap.clientHeight) / s);
    var top = Math.round(Math.max(0, wrap.scrollTop || 0) / s + innerScroll);
    try {
      d.documentElement.style.setProperty('--solo-vh', vh + 'px');
      d.documentElement.style.setProperty('--solo-top', top + 'px');
    } catch (e) {}
  }

  function apply() {
    var d = doc(), w = win();
    if (!d || !d.body) return;

    var vw = wrap.clientWidth || window.innerWidth;

    if (!fitMode) {
      /* 原尺寸：按最小可用宽度排版、不缩放，横向交给外层滚动，方便细看卡面与数字 */
      baseW = minBaseW(d, vw);
      var h0 = contentH(d, w) || Math.round(wrap.clientHeight);
      frame.style.width = baseW + 'px';
      frame.style.height = h0 + 'px';
      frame.style.transform = 'none';
      pan.style.width = baseW + 'px';
      pan.style.height = h0 + 'px';
      ratio.textContent = '100%';
      lastH = h0;
      setViewportVars(d, w, 1);
      return;
    }

    baseW = minBaseW(d, vw);
    var s = Math.min(1, vw / baseW);
    var h = contentH(d, w);
    if (h < 200) h = Math.round(wrap.clientHeight);
    h = Math.max(h, 400);

    frame.style.height = h + 'px';
    frame.style.transform = 'scale(' + s + ')';
    pan.style.width = vw + 'px';
    pan.style.height = Math.round(h * s) + 'px';
    ratio.textContent = Math.round(s * 100) + '%';
    lastH = h;
    setViewportVars(d, w, s);
  }

  /* 内容高度随回合推进变化（手牌 / 市场 / 棋盘重建），定期校准；
     差值小于 8px 不动，避免来回抖动。
     宽度不能靠轮询判断（apply 之后 scrollWidth 必然等于 baseW），
     改用 MutationObserver 盯 DOM 变化：设置界面没有市场卡（最小宽度 ~459），
     进入对局后市场卡出现、最小宽度变大，必须重新量一次基准宽度，
     否则进对局就横向溢出。 */
  var timer = null, obTimer = null, mo = null, obsDoc = null;

  function attachObserver(d) {
    if (!d || !d.body || typeof MutationObserver === 'undefined') return;
    if (mo && obsDoc === d) return;              /* 同一个文档已挂过 */
    try { if (mo) mo.disconnect(); } catch (e) {}
    try {
      mo = new MutationObserver(function () {
        if (obTimer) clearTimeout(obTimer);
        obTimer = setTimeout(function () { apply(); }, 300);
      });
      mo.observe(d.body, { childList: true, subtree: true });
      obsDoc = d;
    } catch (e) { mo = null; obsDoc = null; }
  }

  function watch() {
    if (timer) return;
    timer = setInterval(function () {
      var d = doc(), w = win();
      if (!d || !d.body) return;
      var h = contentH(d, w);
      if (h > 200 && Math.abs(h - lastH) > 8) apply();
    }, 900);
  }

  function boot() {
    frame.src = cfg.url;
    /* 不能等 iframe 的 load 事件：它要等游戏页 94 张图全部下载完（冷缓存十几秒），
       这期间页面既没注入样式、iframe 也还停在默认 300px 宽，就是「横向溢出」的样子。
       改为轮询：文档一就绪（URL 不是 about:blank）立刻注入样式并排版。 */
    var t0 = Date.now(), lastApply = 0;
    var poll = setInterval(function () {
      var d = doc(), now = Date.now();
      if (now - t0 > 15000) { clearInterval(poll); return; }
      if (!d || !d.head) return;
      var url = '';
      try { url = d.URL || ''; } catch (e) {}
      if (!url || url.indexOf('about:blank') === 0) return;   /* 还是空文档，等真正导航 */
      if (!d.getElementById('__solo_css')) injectCss(d);
      if (d.body) {
        attachObserver(d);
        if (now - lastApply > 250) { lastApply = now; apply(); }
      }
    }, 80);
    frame.addEventListener('load', function () {
      injectCss(doc());
      try { wrap.scrollTop = 0; } catch (e) {}
      apply();
      setTimeout(apply, 300);
      setTimeout(function () { apply(); attachObserver(doc()); }, 1200);
      watch();
    });
  }

  document.getElementById('btnBack').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else location.href = '../../index.html';
  });

  btnMode.addEventListener('click', function () {
    fitMode = !fitMode;
    btnMode.textContent = fitMode ? '原尺寸' : '适配';
    apply();
    if (!fitMode) wrap.scrollLeft = 0;
  });

  var rz = null;
  function onResize() {
    if (rz) clearTimeout(rz);
    rz = setTimeout(function () { apply(); }, 180);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  /* 外层滚动时同步「当前可见区域」，否则打开中的选择弹窗会留在上一次的位置。 */
  wrap.addEventListener('scroll', function () {
    var d = doc(), w = win();
    if (d) setViewportVars(d, w, lastScale);
  }, { passive: true });

  boot();
})();




