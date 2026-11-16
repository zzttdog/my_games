/* 兼容旧路径：真实存档脚本在 net/client/save.js */
(function () {
  var s = document.currentScript;
  var u = s && s.src ? new URL('client/save.js', s.src).href : '../net/client/save.js';
  document.write('<script src="' + u + '"><\/script>');
})();
