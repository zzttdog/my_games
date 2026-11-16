/*
 * 开局资源预加载 + 进度条（两款游戏共用，单机 / 联机 / 手机外壳页都能用）
 *
 * 设计要点：
 *  1. 放在游戏页 <head> 里同步执行，遮罩早于任何卡图请求出现；游戏脚本照常解析执行，
 *     遮罩只是盖住画面并拦截点击，因此「加载完再进游戏」不需要改动任何游戏规则代码，
 *     也完全不碰 bridge.js 的开局时序（联机 ready / start / 15 秒诊断都不受影响）。
 *  2. 分批并发：每批最多 BATCH 张，完成一张补下一张，避免 300 张图同时挤爆连接。
 *     essential（首屏必需）加载完才放行；rest 在放行后以更低并发继续后台补齐。
 *  3. 单张失败 / 挂起都计入完成，整体 18 秒到点必定放行；不取消已发出的请求，
 *     让浏览器继续下载，后续 <img> 会复用缓存。任何网络情况都不会把玩家卡在进度条。
 *     阈值定在 18 秒是因为线上冷缓存回源只有 ~12KB/s：essential 有 1.8MB，
 *     等满 30 秒也照样加载不完，反而白等；清单已按优先级排序（棋盘底图最前），
 *     早放行时版图已经画得出来，剩下的由游戏自身按需加载补齐。
 *  4. iframe 内 position:fixed 的坑：手机端 iframe 高度 = 整页内容高度，100vh 会
 *     把遮罩撑到几千像素、进度条跑到屏幕外。这里取 min(自身视口, 父页视口) 并 top:0，
 *     同时通知父页滚回顶部；被 transform:scale 缩放的外壳页则由父页自己画进度条。
 */
(function () {
  'use strict';

  var Q = new URLSearchParams(location.search);
  var path = '';
  try { path = decodeURIComponent(location.pathname); } catch (e) { path = location.pathname; }
  var MG = (window.MG_GAMES && window.MG_GAMES.games) || {};
  var qk = Q.get('game') || Q.get('net_game');
  var GAME = MG[qk] ? qk : (/\/The White Castle\//i.test(path) ? 'castle' : 'harmonies');
  if (Q.get('net_game') === 'castle') GAME = 'castle';
  else if (Q.get('net_game') === 'harmonies') GAME = 'harmonies';

  var BATCH = 6;            // 前台并发窗口（分批加载）
  var BATCH_BG = 3;         // 放行后的后台并发，避免抢操作带宽
  var TIMEOUT = 18000;      // 整体最长等待，到点自动放行（冷缓存回源慢，等满也没用）
  var PER_IMG = 15000;      // 单张挂起兜底

  var list = (window.MG_IMG_LIST || {})[GAME];
  var essential = (list && list.essential) || [];
  var rest = (list && list.rest) || [];
  var total = essential.length;

  /* 暴露给 bridge.js：自然之灵二选一的 30 秒兜底要等玩家真能看到弹窗才开始计时 */
  var api = { done: false, game: GAME, total: total, loaded: 0, peak: 0, reason: '' };
  window.MGPreload = api;

  /* 清单没取到（旧缓存 / 单独打开）时绝不能把游戏挡住 */
  if (!total) { api.done = true; return; }

  var inFrame = false;
  try { inFrame = !!(window.parent && window.parent !== window); } catch (e) {}

  function viewH() {
    var h = window.innerHeight || 800;
    if (inFrame) {
      try { h = Math.min(h, window.parent.innerHeight || h); } catch (e) {}
    }
    return h;
  }

  /* ── 遮罩 / 进度条 ─────────────────────────────────────────────── */
  var root = document.documentElement;
  var style = document.createElement('style');
  style.textContent =
    '#__mg_pre{position:fixed!important;left:0!important;top:0!important;width:100%!important;' +
    'z-index:2147483647!important;background:#151a22;display:flex;align-items:center;' +
    'justify-content:center;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
    'color:#e8eef7;transition:opacity .32s ease;overflow:hidden}' +
    '#__mg_pre .box{width:min(340px,84vw);padding:26px 24px;border-radius:14px;' +
    'background:#202834;border:1px solid #35404f;box-shadow:0 18px 46px rgba(0,0,0,.42);text-align:center}' +
    '#__mg_pre .t{font-size:16px;font-weight:600;letter-spacing:.5px}' +
    '#__mg_pre .s{margin-top:6px;font-size:12px;color:#93a3b8}' +
    '#__mg_pre .track{margin-top:18px;height:9px;border-radius:9px;background:#121821;overflow:hidden}' +
    '#__mg_pre .fill{height:100%;width:0;border-radius:9px;background:linear-gradient(90deg,#4c9a72,#8bc34a);' +
    'transition:width .18s ease}' +
    '#__mg_pre .n{margin-top:10px;font-size:12px;color:#93a3b8;font-variant-numeric:tabular-nums}';
  root.appendChild(style);

  var mask = document.createElement('div');
  mask.id = '__mg_pre';
  mask.style.height = viewH() + 'px';
  mask.innerHTML =
    '<div class="box"><div class="t">正在载入游戏资源</div>' +
    '<div class="s">首次进入需要下载卡图与版图，之后会走缓存</div>' +
    '<div class="track"><div class="fill"></div></div>' +
    '<div class="n">0 / ' + total + ' · 0%</div></div>';
  root.appendChild(mask);
  var fill = mask.querySelector('.fill');
  var num = mask.querySelector('.n');

  function relayout() { mask.style.height = viewH() + 'px'; }
  window.addEventListener('resize', relayout);

  function post(status, reason) {
    if (!inFrame) return;
    try {
      window.parent.postMessage({
        __mg_preload: true, status: status, game: GAME,
        total: total, loaded: api.loaded, reason: reason || ''
      }, '*');
    } catch (e) {}
  }
  post('lock');

  var lastPost = 0;
  function update(force) {
    var pct = Math.round(api.loaded * 100 / total);
    fill.style.width = pct + '%';
    num.textContent = api.loaded + ' / ' + total + ' · ' + pct + '%';
    var now = Date.now();
    if (force || now - lastPost > 90) { lastPost = now; post('progress'); }
  }

  /* ── 分批队列 ───────────────────────────────────────────────────── */
  var queue = essential.slice();
  var idx = 0, active = 0, released = false, bgStarted = false;
  var hardTimer = setTimeout(function () { release('timeout'); }, TIMEOUT);

  function loadOne(src, cb) {
    var im = new Image(), fin = false;
    function finish() {
      if (fin) return;
      fin = true;
      im.onload = im.onerror = null;
      cb();
    }
    im.onload = finish;
    im.onerror = finish;           // 失败也计入完成，绝不阻塞
    setTimeout(finish, PER_IMG);   // 挂起兜底；请求本身不取消，让缓存继续填充
    try { im.src = src; } catch (e) { finish(); }
  }

  function pump() {
    var cap = released ? BATCH_BG : BATCH;
    while (active < cap && idx < queue.length) {
      var at = idx++;
      var src = queue[at];
      var isEssential = at < total;   /* rest 排在 total 之后，不占进度条百分比 */
      active++;
      if (active > api.peak) api.peak = active;
      /* 闭包隔离，避免 src 被后续循环改写 */
      (function (s, ess) {
        loadOne(s, function () {
          active--;
          if (ess) api.loaded++;
          if (!released) update(false);
          if (!released && api.loaded >= total) { release('complete'); return; }
          pump();
        });
      })(src, isEssential);
    }
  }

  function startBackground() {
    if (bgStarted) return;
    bgStarted = true;
    for (var i = 0; i < rest.length; i++) queue.push(rest[i]);
    pump();
  }

  function release(reason) {
    if (released) return;
    released = true;
    clearTimeout(hardTimer);
    api.done = true;
    api.reason = reason;
    post('done', reason);
    try { window.dispatchEvent(new CustomEvent('mgpreload:done', { detail: { reason: reason } })); } catch (e) {}
    mask.style.opacity = '0';
    setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 340);
    startBackground();     // 剩余 essential + rest 继续后台补齐
  }

  update(true);
  pump();
})();
