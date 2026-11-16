/* ============================================================
 * my_games 联机服务（零第三方依赖）
 *
 *   node net/server/server.js            默认 http://localhost:8080
 *   PORT=9000 node net/server/server.js  自定义端口
 *
 * 同时做两件事：
 *   1) 静态托管整个 my_games/（可替代 Live Server）
 *   2) /net/room 提供房间广播：GET = SSE 下行，POST = JSON 上行
 *
 * 静态优化（2026-11-11）：
 *   - WebP 内容协商：游戏 HTML 里的图片 URL 一个字都不用改，
 *     浏览器带 Accept: image/webp 时服务端返回同名的 <原名>.webp，
 *     体积通常只有原 PNG/JPG 的 15~30%；不支持时自动回退原图。
 *   - 图片长缓存 + ETag/304；文本资源 brotli/gzip 压缩并缓存压缩结果。
 *   - 房间保留最近的 begin 消息，晚连上 SSE 的玩家也能补收到开局命令。
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8080);
const SAVE_DIR = path.join(__dirname, 'saves');
fs.mkdirSync(SAVE_DIR, { recursive: true });
const saveChains = new Map();
const saveLastSig = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8'
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.css', '.json', '.md', '.txt', '.svg']);
const compressCache = new Map();

/* room -> Set<res>；另存每个房间最近一次 begin，供晚连上的客机补收 */
const rooms = new Map();
const lastBegin = new Map();

function broadcast(room, payload, excludePeer) {
  const set = rooms.get(room);
  if (!set) return;
  const chunk = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of set) {
    if (excludePeer && res._peer === excludePeer) continue;
    try { res.write(chunk); } catch (e) { set.delete(res); }
  }
}

function handleRoom(req, res, u) {
  const room = u.searchParams.get('room') || 'demo';
  if (req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    if (!rooms.has(room)) rooms.set(room, new Set());
    res._peer = u.searchParams.get('peer') || '';
    rooms.get(room).add(res);
    /* 客户端刚订阅就错过了房主的 begin（很常见的「第二个人进不去」），
       这里把 30 秒内的开局命令补发一次；客户端 startPlay 有幂等保护。 */
    const lb = lastBegin.get(room);
    if (lb && Date.now() - lb.at < 30000) {
      setTimeout(() => { try { res.write('data: ' + JSON.stringify(lb.msg) + '\n\n'); } catch (e) {} }, 120);
    }
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 10000);
    req.on('close', () => {
      clearInterval(hb);
      const set = rooms.get(room);
      if (set) { set.delete(res); if (!set.size) { rooms.delete(room); lastBegin.delete(room); } }
    });
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2 * 1024 * 1024) { body = ''; req.destroy(); }
    });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch (e) {}
      res.writeHead(msg ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(msg ? '{"ok":true}' : '{"ok":false}');
      if (!msg) return;
      if (msg.kind === 'begin') lastBegin.set(room, { at: Date.now(), msg: msg });
      /* 发送者自己不需要回环这份消息；省一次 SSE 下行和一次 JSON 解析 */
      broadcast(room, msg, msg.peer || null);
    });
    return;
  }
  res.writeHead(405); res.end();
}

/* ── 线上对局存档：房主窗口自动上传，AI/复盘工具可以直接读文件 ──
 *   POST /net/save?game=&room=&match=   最新快照 + 变化追加到 .jsonl
 *   GET  /net/save?game=&room=&match=   读取最新 JSON
 *   GET  /net/save?history=1...         读取历史 JSONL
 *   GET  /net/save?list=1               列出已有存档
 * 文件位置：net/server/saves/<game>-<room>-<match>.json / .jsonl
 * ─────────────────────────────────────────────────────────────── */
function safePart(v, fallback) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return s || fallback;
}

function saveKey(u) {
  const game = safePart(u.searchParams.get('game'), 'harmonies');
  const room = safePart(u.searchParams.get('room'), '0000').slice(0, 4);
  const match = safePart(u.searchParams.get('match'), 'm0');
  return { game, room, match, name: game + '-' + room + '-' + match };
}

function saveReply(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}

function handleSave(req, res, u) {
  const key = saveKey(u);

  if (req.method === 'GET') {
    if (u.searchParams.get('list') === '1') {
      fsp.readdir(SAVE_DIR).then((names) => {
        const only = names.filter((n) => n.endsWith('.json')).sort();
        saveReply(res, 200, JSON.stringify({ ok: true, saves: only }));
      }).catch((e) => saveReply(res, 500, JSON.stringify({ ok: false, error: e.message })));
      return;
    }
    const file = path.join(SAVE_DIR, key.name + (u.searchParams.get('history') === '1' ? '.jsonl' : '.json'));
    fsp.readFile(file, 'utf8').then((text) => {
      saveReply(res, 200, text, u.searchParams.get('history') === '1'
        ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8');
    }).catch(() => saveReply(res, 404, JSON.stringify({ ok: false, error: '暂无该房间存档' })));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 8 * 1024 * 1024) { body = ''; req.destroy(); }
  });
  req.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) {}
    if (!payload || typeof payload !== 'object') {
      saveReply(res, 400, JSON.stringify({ ok: false, error: 'bad json' }));
      return;
    }
    let sig = '';
    try { sig = crypto.createHash('sha1').update(JSON.stringify(payload.state || payload)).digest('hex'); } catch (e) {}
    payload.at = payload.at || Date.now();
    payload.game = key.game;
    payload.room = key.room;
    payload.match = key.match;
    const latest = path.join(SAVE_DIR, key.name + '.json');
    const history = path.join(SAVE_DIR, key.name + '.jsonl');
    const line = JSON.stringify(payload) + '\n';
    const prev = saveChains.get(key.name) || Promise.resolve();
    const next = prev.then(async () => {
      const tmp = latest + '.' + process.pid + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.rename(tmp, latest);
      if (sig && saveLastSig.get(key.name) !== sig) {
        saveLastSig.set(key.name, sig);
        await fsp.appendFile(history, line, 'utf8');
      }
    }).catch((e) => { saveReply(res, 500, JSON.stringify({ ok: false, error: e.message })); });
    saveChains.set(key.name, next);
    next.then(() => {
      if (!res.headersSent) {
        saveReply(res, 200, JSON.stringify({
          ok: true, key: key.name,
          latest: '/net/server/saves/' + key.name + '.json',
          history: '/net/server/saves/' + key.name + '.jsonl'
        }));
      }
    });
  });
}


async function serveStatic(req, res, u) {
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); res.end(); return; }
  if (rel === '/') rel = '/index.html';
  /* 线上存档目录只给本机 AI/复盘脚本读，不通过静态服务暴露 */
  if (rel.startsWith('/net/server/saves')) { res.writeHead(403); res.end(); return; }
  let full = path.resolve(ROOT, '.' + rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  let st = await fsp.stat(full).catch(() => null);
  if (st && st.isDirectory()) {
    full = path.join(full, 'index.html');
    st = await fsp.stat(full).catch(() => null);
  }
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + rel);
    return;
  }

  const ext = path.extname(full).toLowerCase();
  let target = full, usedSt = st, ct = MIME[ext] || 'application/octet-stream';
  if (IMAGE_EXT.has(ext) && /\bimage\/webp\b/i.test(req.headers.accept || '') && ext !== '.webp') {
    const wst = await fsp.stat(full + '.webp').catch(() => null);
    if (wst && wst.isFile()) { target = full + '.webp'; usedSt = wst; ct = 'image/webp'; }
  }

  /* HTML 必须每次回源校验；带 v/_v 的脚本和样式可以长缓存。
     版本号在 index.html / play.html 里显式控制，更新代码时一起 bump。 */
  const versioned = u.searchParams.has('v') || u.searchParams.has('_v');
  const isHtml = ext === '.html' || ext === '.htm';
  const cacheControl = IMAGE_EXT.has(ext)
    ? 'public, max-age=86400'
    : (isHtml ? 'no-cache'
      : (versioned ? 'public, max-age=31536000, immutable' : 'no-cache'));
  const etag = '"' + Math.floor(usedSt.mtimeMs).toString(36) + '-' + usedSt.size.toString(36) + '"';
  const headers = {
    'Content-Type': ct,
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Vary': 'Accept, Accept-Encoding'
  };
  if (req.headers['if-none-match'] && req.headers['if-none-match'].indexOf(etag) >= 0) {
    res.writeHead(304, headers); res.end(); return;
  }

  let raw = await fsp.readFile(target);
  if (TEXT_EXT.has(ext) && raw.length < 1024 * 1024) {
    const ae = req.headers['accept-encoding'] || '';
    const useBr = /\bbr\b/i.test(ae), useGz = !useBr && /\bgzip\b/i.test(ae);
    if (useBr || useGz) {
      const kind = useBr ? 'br' : 'gz';
      const key = target + '|' + usedSt.mtimeMs + '|' + kind;
      let packed = compressCache.get(key);
      if (!packed) {
        packed = useBr ? zlib.brotliCompressSync(raw) : zlib.gzipSync(raw, { level: 6 });
        if (compressCache.size > 100) compressCache.clear();
        compressCache.set(key, packed);
      }
      raw = packed;
      headers['Content-Encoding'] = kind === 'br' ? 'br' : 'gzip';
    }
  }
  headers['Content-Length'] = raw.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : raw);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/net/room') return handleRoom(req, res, u);
  if (u.pathname === '/net/save') return handleSave(req, res, u);
  if (u.pathname === '/net/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"ok":true,"rooms":' + rooms.size + '}');
    return;
  }
  serveStatic(req, res, u).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + (e && e.message));
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('my_games 联机服务已启动: http://localhost:' + PORT + '/');
  console.log('  大厅: http://localhost:' + PORT + '/net/client/play.html');
  console.log('  静态根目录: ' + ROOT);
});
