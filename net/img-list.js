/* 兼容旧路径：真实清单在 net/client/img-list.js */
(function () {
  var s = document.currentScript;
  var u = s && s.src ? new URL('client/img-list.js', s.src).href : '../net/client/img-list.js';
  document.write('<script src="' + u + '"><\/script>');
})();
