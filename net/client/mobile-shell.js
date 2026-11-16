/* 手机外壳共用的显示层工具：断点、iframe 内容高度、最小排版宽度。
   联机大厅 play.html 与单机手机壳 phone.html 都用这一份，避免两套魔法数字。 */
(function () {
  'use strict';
  window.MGShell = {
    MOBILE_MAX: 820,

    isMobile: function () {
      try { return window.matchMedia('(max-width:' + this.MOBILE_MAX + 'px)').matches; }
      catch (e) { return false; }
    },

    /* iframe 里真实内容高度。
       documentElement.scrollHeight 会被 iframe 自身高度撑满（越量越大），不能用；
       改为遍历 body 直接子元素的底边（getBoundingClientRect 已含 body 上的 zoom）。 */
    contentH: function (frame, d, w, pad) {
      if (!d) {
        try { d = frame.contentDocument; w = frame.contentWindow; } catch (e) { return 0; }
      }
      if (!d || !d.body) return 0;
      var sy = 0;
      try { sy = (w && w.scrollY) || d.documentElement.scrollTop || 0; } catch (e) {}
      var max = 0, kids = d.body.children;
      for (var i = 0; i < kids.length; i++) {
        var r;
        try { r = kids[i].getBoundingClientRect(); } catch (e) { continue; }
        if (r.height <= 0) continue;
        if (r.bottom + sy > max) max = r.bottom + sy;
      }
      return max > 0 ? Math.ceil(max) + (pad == null ? 16 : pad) : 0;
    },

    /* 找「刚好不横向溢出」的最小宽度：先按屏幕宽排，撑不下就把宽度顶到内容宽度，最多迭代 6 次。 */
    minBaseW: function (frame, d, vw) {
      var w = Math.max(vw, 320);
      frame.style.width = w + 'px';
      for (var i = 0; i < 6; i++) {
        var sw = 0;
        try { sw = d.documentElement.scrollWidth; } catch (e) { break; }
        if (sw <= w + 1) break;
        w = sw;
        frame.style.width = w + 'px';
      }
      return w;
    }
  };
})();
