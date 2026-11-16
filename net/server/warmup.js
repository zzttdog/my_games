/*
 * 部署后预热图片缓存（运维工具，非页面资源）
 *
 * 为什么需要：线上网关对未缓存的图片回源只有 ~15KB/s，而自然和弦 essential
 * 有 1.8MB，任何超时阈值都不可能「加载完再进游戏」。但同一个 URL 命中网关缓存后
 * 只要几百毫秒。所以发布完立刻按浏览器同款请求头跑一遍，把缓存焐热，
 * 第一个真实用户打开时就是热的。
 *
 * 关键：server.js 带 `Vary: Accept`，Accept 不同就是不同缓存条目。
 * 必须用 Chrome 的完整 Accept 头预热，否则填的是 Node 自己的条目，用户照样冷。
 *
 * 用法：
 *   node net/server/warmup.js                      # 预热线上（默认地址）
 *   MG_BASE=http://127.0.0.1:8099 node net/server/warmup.js
 *   node net/server/warmup.js --only=harmonies    # 只预热一款
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const BASE = process.env.MG_BASE || (CFG.runtime && CFG.runtime.wbappBase) || '';
const SC = process.env.MG_BASE ? '' : (CFG.runtime && CFG.runtime.sharecode ? '?sharecode=' + CFG.runtime.sharecode : '');
const CONC = parseInt(process.env.CONC || '12', 10);

/* Chrome 桌面/手机通用的图片 Accept 头 */
const ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

const GAME_DIR = {};
Object.keys(CFG.games || {}).forEach(function (k) { GAME_DIR[k] = CFG.games[k].dir + '/'; });

function loadList() {
  const p = path.join(__dirname, '..', 'client', 'img-list.js');
  const s = fs.readFileSync(p, 'utf8');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

async function warm(game, files) {
  const dir = GAME_DIR[game];
  let at = 0, ok = 0, bad = 0, bytes = 0;
  const t0 = Date.now();
  const fails = [];

  async function worker() {
    while (at < files.length) {
      const rel = files[at++];
      const url = BASE + '/' + encodeURI(dir + rel).replace(/#/g, '%23') + SC;
      const s = Date.now();
      try {
        const r = await fetch(url, { headers: { Accept: ACCEPT } });
        const b = await r.arrayBuffer();
        if (r.status === 200) { ok++; bytes += b.byteLength; }
        else { bad++; fails.push(r.status + ' ' + rel); }
        if (Date.now() - s > 8000) console.log(`    慢 ${((Date.now() - s) / 1000).toFixed(1)}s ${rel}`);
      } catch (e) { bad++; fails.push('ERR ' + rel + ' ' + e.message); }
    }
  }

  await Promise.all(Array.from({ length: CONC }, worker));
  const sec = (Date.now() - t0) / 1000;
  console.log(`${game}: ${ok}/${files.length} 张，${(bytes / 1048576).toFixed(2)} MB，${sec.toFixed(1)}s，` +
    `${(bytes / 1024 / sec).toFixed(0)} KB/s${bad ? '，失败 ' + bad : ''}`);
  fails.slice(0, 5).forEach((f) => console.log('    ' + f));
}

(async () => {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const list = loadList();
  for (const game of ['harmonies', 'castle']) {
    if (only && only !== game) continue;
    const all = [].concat(list[game].essential || [], list[game].rest || []);
    await warm(game, all);
  }
  console.log('预热完成：再打开游戏页应当直接命中网关缓存。');
})().catch((e) => { console.error('预热失败', e.message); process.exit(1); });
