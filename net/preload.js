/* 兼容旧路径：真实预加载脚本在 net/client/preload.js */
(function () {
  var s = document.currentScript;
  var u = s && s.src ? new URL('client/preload.js', s.src).href : '../net/client/preload.js';
  document.write('<script src="' + u + '"><\/script>');
})();
