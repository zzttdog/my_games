
/* ============================================================
 * 规则引擎
 * ============================================================ */
function topType(cell) { return cell.stack.length ? cell.stack[cell.stack.length - 1] : null; }

/* 一般放置规则(不含保护区许可) */
function basicCanPlace(h, top, type) {
  switch (type) {
    case 'water': case 'field': return h === 0;
    case 'trunk':  return h === 0 || (top === 'trunk' && h <= 1);
    case 'tree':   return h === 0 || (top === 'trunk' && h <= 2);
    case 'mountain':return h === 0 || (top === 'mountain' && h <= 2);
    case 'building':return h < 2 && (h === 0 || top === 'trunk' || top === 'mountain' || top === 'building');
  }
  return false;
}
/* 保护区许可:返回允许本次突破一般规则的板块(无则 null)。
   官方规则:每个未完成板块只能同时在一个格子上建造——首次靠它突破一般规则时
   把板块锁定到该格(site),此后只允许在该格继续堆叠,不能在别的格子重复违规建造。 */
function sanctPermit(board, k, type, player) {
  if (!player || !player.sancts) return null;
  const cell = board[k]; if (!cell || cell.cube || cell.spirit) return null;
  const h = cell.stack.length;
  if (h >= 4) return null;
  for (const s of player.sancts) {
    if (s.done) continue;
    if (s.site && s.site !== k) continue;
    let match = true;
    for (let i = 0; i < h; i++) if (cell.stack[i] !== s.def.layers[i]) { match = false; break; }
    if (match && type === s.def.layers[h]) return s;
  }
  return null;
}
/* 保护区格类型:0=普通格,1=建设中(site),2=已完成(pos)。
   保护区建造途中禁止放动物/精灵方块;完成后也只能走「动物卡最后一枚方块」专用路径,
   通用图案匹配一律跳过。 */
function sanctCellKind(player, k) {
  if (!player || !player.sancts) return 0;
  for (const s of player.sancts) {
    if (s.done && s.pos === k) return 2;
    if (!s.done && s.site === k) return 1;
  }
  return 0;
}
function canPlace(board, k, type, player) {
  // 动物/自然之灵方块(cell.cube)与精灵方块(cell.spirit)都占格:放过后该格不能再放地形标记
  const cell = board[k]; if (!cell || cell.cube || cell.spirit) return false;
  const h = cell.stack.length, top = topType(cell);
  if (basicCanPlace(h, top, type)) return true;
  return !!sanctPermit(board, k, type, player);
}
/* 实际放置标记时调用(必须在 placeToken 之前):若本次靠保护区突破一般规则,锁定建造格 */
function lockSanctSite(board, k, type, player) {
  const cell = board[k]; if (!cell) return null;
  const h = cell.stack.length, top = topType(cell);
  if (basicCanPlace(h, top, type)) return null;
  const s = sanctPermit(board, k, type, player);
  if (s && !s.site) s.site = k;
  return s;
}
function checkSanctComplete(board, k, player) {
  if (!player.sancts) return null;
  const cell = board[k];
  if (cell.stack.length !== 4) return null;
  for (const s of player.sancts) {
    if (s.done) continue;
    if (s.site && s.site !== k) continue;
    let match = true;
    for (let i = 0; i < 4; i++) if (cell.stack[i] !== s.def.layers[i]) { match = false; break; }
    if (match) { s.done = true; s.pos = k; return s; }
  }
  return null;
}

function placeToken(board, k, type) {
  board[k].stack.push(type);
}

function reqMatch(cell, req) {
  if (req === 'C') return !!cell.cube;
  const top = topType(cell); if (!top) return false;
  const h = cell.stack.length;
  switch (req) {
    case 'w': return top === 'water';
    case 'f': return top === 'field';
    case 't': return top === 'trunk';
    // 建筑 = 红色建筑标记叠出 2 层(1棕2红 / 1灰2红 / 1红2红)
    case 'B': return top === 'building' && h === 2;
    // 单层红标记:只有精灵牌1 的第二格是这种「1红」,它不构成建筑
    case 'r': return top === 'building' && h === 1;
    case 'T1': return top === 'tree' && h === 1;
    case 'T2': return top === 'tree' && h === 2;
    case 'T3': return top === 'tree' && h === 3;
    case 'M1': return top === 'mountain' && h === 1;
    case 'M2': return top === 'mountain' && h === 2;
    case 'M3': return top === 'mountain' && h === 3;
  }
  return false;
}

/* 在版图上找某卡的所有匹配(返回 [{anchor, cells:[k...]}])
 * 镜像规则仅适用于 Pulse 扩展的 10 张卡(官方规则),基础卡/自然之灵/精灵卡不享受镜像 */
/* 朝向表按卡对象缓存:AI 规划里每张卡每格都要反复用到,重算 6/12 个朝向太浪费。
   同一页面可以换一局并切换 Pulse 开关,所以缓存要带上 mirror 标记,否则会用旧朝向。 */
const ORIENT_CACHE = new WeakMap();
function orientsOf(def) {
  const mirror = !!(G.mods.pulse && def.pulse);
  let e = ORIENT_CACHE.get(def);
  if (!e || e.mirror !== mirror) {
    e = { mirror, o: orientations(def.pat, mirror) };
    ORIENT_CACHE.set(def, e);
  }
  return e.o;
}

function findMatches(cardDef, board, player) {
  // 注意:setup() 洗牌时用 {...c} 生成了副本,G.deck/G.market/p.cards[].def 都不是 PULSE_CARDS 里的原对象,
  // 因此不能用 PULSE_CARDS.includes(cardDef) 判断(永远 false,镜像会静默失效)。用卡自带的 pulse 标记判断。
  const res = [];
  for (const o of orientsOf(cardDef)) {
    for (const bk in board) {
      const [bq, br] = bk.split(',').map(Number);
      let ok = true; const cells = []; let anchor = null;
      for (const pc of o) {
        const k = key(bq + pc.q, br + pc.r);
        const cell = board[k];
        if (!cell || !reqMatch(cell, pc.req)) { ok = false; break; }
        cells.push(k);
        if (pc.a) anchor = k;
      }
      if (!ok || !anchor) continue;
      // 保护区格:建造途中不能放任何动物/精灵方块;完成后只走「最后一枚方块」专用路径。
      if (sanctCellKind(player, anchor) !== 0) continue;
      if (cardDef.elf) {
        /* 精灵方块只能落在卡面带「*」的锚点格:精灵牌 2/7 就是红色建筑格。
           卡上的 2 个精灵方块要放在「两处不同匹配」的锚点上。早期实现为了让第 2 块
           一定放得下,在锚点已有精灵时回退到图案内其它格子 —— 那会让精灵方块出现在
           棕色/绿色等非红色格上,违反卡面规则。这里删掉该回退。 */
        if (board[anchor].spirit) continue;
        /* 紫色精灵方块只能与动物(橙)方块同格,不能与自然之灵(白)方块同格 */
        if (board[anchor].cube && isSpiritCube(board[anchor].cube)) continue;
        res.push({ anchor, cells });
      } else if (!board[anchor].cube) {
        res.push({ anchor, cells });
      }
    }
  }
  // 按锚点去重(同一锚点只算一个可放点)
  const seen = new Set();
  return res.filter(m => (seen.has(m.anchor) ? false : (seen.add(m.anchor), true)));
}

/* ===== AI 用:图案接近度 =====
 * cardProgress:所有摆放里最多已满足几格,用于选卡(避免拿永远搭不出来的死卡)。
 * localProgress:只考虑「图案某格落在 k」的摆放,用于放置规划。
 *   放一枚标记只会改变 k 这一个格子,其它摆放的满足数不变,所以只看包含 k 的
 *   摆放就能算出精确的增量,代价从 O(格数) 降到 O(朝向×图案格数)。
 * 只统计「锚点仍空闲、还能真的放下一枚方块」的图案:锚点已被占的图案
 * 再补地形也不会得分,旧版会一直给这种死图案加分,导致 AI 反复补无用格。 */
function anchorFree(def, board, anchor, player) {
  const ac = board[anchor];
  if (!ac) return false;
  if (sanctCellKind(player, anchor) !== 0) return false;
  if (def.elf) {
    if (ac.spirit) return false;
    if (ac.cube && isSpiritCube(ac.cube)) return false;
    return true;
  }
  return !ac.cube;
}
function cardProgress(def, board, player) {
  const os = orientsOf(def);
  let best = 0;
  for (const o of os) {
    for (const bk in board) {
      const [bq, br] = bk.split(',').map(Number);
      let n = 0, anchor = null;
      for (const pc of o) {
        const c = board[key(bq + pc.q, br + pc.r)];
        if (c && reqMatch(c, pc.req)) n++;
        if (pc.a) anchor = key(bq + pc.q, br + pc.r);
      }
      if (!anchor || !anchorFree(def, board, anchor, player)) continue;
      if (n > best) { best = n; if (best === o.length) return best; }
    }
  }
  return best;
}
function localProgress(def, board, k, player) {
  const os = orientsOf(def);
  const [kq, kr] = k.split(',').map(Number);
  let best = 0;
  for (const o of os) {
    for (let j = 0; j < o.length; j++) {
      const dq = kq - o[j].q, dr = kr - o[j].r;
      let n = 0, anchor = null;
      for (const pc of o) {
        const c = board[key(dq + pc.q, dr + pc.r)];
        if (c && reqMatch(c, pc.req)) n++;
        if (pc.a) anchor = key(dq + pc.q, dr + pc.r);
      }
      if (!anchor || !anchorFree(def, board, anchor, player)) continue;
      if (n > best) best = n;
    }
  }
  return best;
}

/* ===== 计分 ===== */
function scoreBoard(p) {
  const b = p.board;
  const side = G.side, D_PTS = { 1: 2, 2: 4, 3: 9 }; // D 面树木高度分值(官方)
  // D 面干旱格:与水相邻 → 视为常规格(计分时)
  const isRegular = (cell, k) => {
    if (!cell.dry) return true;
    const [q, r] = k.split(',').map(Number);
    return neighbors(q, r).some(([nq, nr]) => { const c = b[key(nq, nr)]; return c && topType(c) === 'water'; });
  };
  let tree = 0, mountain = 0, field = 0, building = 0, water = 0, animal = 0, spirit = 0, elf = 0, sanctPts = 0;
  for (const k in b) {
    const cell = b[k], top = topType(cell);
    if (top === 'tree') {
      if (side === 'D') { if (isRegular(cell, k)) tree += D_PTS[cell.stack.length] || 0; }
      else tree += HEIGHT_PTS[cell.stack.length] || 0;
    }
    else if (top === 'mountain') {
      const [q, r] = k.split(',').map(Number);
      const adjM = neighbors(q, r).some(([nq, nr]) => { const c = b[key(nq, nr)]; return c && topType(c) === 'mountain'; });
      if (adjM) mountain += HEIGHT_PTS[cell.stack.length] || 0;
    } else if (top === 'building' && cell.stack.length === 2) {
      const [q, r] = k.split(',').map(Number);
      const colors = new Set();
      neighbors(q, r).forEach(([nq, nr]) => {
        const c = b[key(nq, nr)];
        if (c && topType(c)) colors.add(topType(c));
      });
      if (side === 'C') { if (colors.size >= 4 && colors.has('building')) building += 8; } // 官方:≥4 色含红→8
      else if (colors.size >= 3) building += 5;
    }
  }
  // 田野:A/C 2+ 连片每组 5 分;D 面需 ≥1 格为常规格才得 6 分(官方)
  const seenF = new Set();
  for (const k in b) {
    if (topType(b[k]) !== 'field' || seenF.has(k)) continue;
    const grp = flood(b, k, c => topType(c) === 'field');
    grp.forEach(g => seenF.add(g));
    if (grp.length < 2) continue;
    if (side === 'D') { if (grp.some(g => isRegular(b[g], g))) field += 6; }
    else field += 5;
  }
  // 水:按版面
  water = scoreWater(p);
  // 动物卡(自然之灵:cubes=[0],完成图案后按专属规则计分,单列 spirit 便于结算明细)
  for (const ci of p.cards) if (ci.placed > 0) {
    animal += ci.def.cubes[ci.placed - 1];
    if (ci.def.spirit) {
      const pos = ci.def.spirit === 'adj2' ? Object.keys(b).find(k => b[k].cube && b[k].cube.card === ci.def.name) : null;
      spirit += spiritScore(ci.def.spirit, b, pos);
    }
  }
  // 精灵方块:与动物(橙)方块同格 5 分/格;与自然之灵(白)方块同格或单独 2 分/格
  for (const k in b) if (b[k].spirit) elf += (b[k].cube && !isSpiritCube(b[k].cube)) ? 5 : 2;
  // 保护区:每个已完成的保护区,相邻 6 格中最顶标记与得分色匹配 → +3/格
  for (const s of (p.sancts || [])) {
    if (!s.done || !s.pos) continue;
    const [q, r] = s.pos.split(',').map(Number);
    for (const [nq, nr] of neighbors(q, r)) {
      const c = b[key(nq, nr)];
      if (c && s.def.colors.includes(topType(c))) sanctPts += 3;
    }
  }
  return { tree, mountain, field, building, water, animal, spirit, elf, sanctPts,
    total: tree + mountain + field + building + water + animal + spirit + elf + sanctPts };
}

function flood(board, start, pred) {
  const out = [], seen = new Set([start]), q = [start];
  while (q.length) {
    const k = q.pop(); out.push(k);
    const [cq, cr] = k.split(',').map(Number);
    for (const [nq, nr] of neighbors(cq, cr)) {
      const nk = key(nq, nr);
      if (!seen.has(nk) && board[nk] && pred(board[nk])) { seen.add(nk); q.push(nk); }
    }
  }
  return out;
}

/* 自然之灵专属计分(官方规则 + 霸王龙新规则) */
function spiritScore(kind, b, pos) {
  const cells = Object.values(b);
  const stackCount = (top, hs) => cells.filter(c => topType(c) === top && hs.includes(c.stack.length)).length;
  const groupSizes = pred => { // 各连通块的大小
    const seen = new Set(), sizes = [];
    for (const k in b) {
      if (seen.has(k) || !pred(b[k])) continue;
      const grp = flood(b, k, pred); grp.forEach(g => seen.add(g)); sizes.push(grp.length);
    }
    return sizes;
  };
  const isW = c => topType(c) === 'water', isF = c => topType(c) === 'field', isB = c => topType(c) === 'building';
  switch (kind) {
    case 'f33':  return groupSizes(isF).reduce((s, n) => s + (n >= 3 ? 10 : 2), 0);
    case 'f5':   return groupSizes(isF).length * 5;
    case 't423': return stackCount('tree', [2, 3]) * 4;
    case 't321': return stackCount('tree', [1, 2]) * 3 + stackCount('tree', [3]);
    case 'b4':   return groupSizes(isB).length * 4;
    case 'b6':   return groupSizes(isB).filter(n => n >= 2).length * 6;
    case 'm423': return stackCount('mountain', [2, 3]) * 4;
    case 'm321': return stackCount('mountain', [1, 2]) * 3 + stackCount('mountain', [3]);
    case 'w7':   return groupSizes(isW).filter(n => n >= 2).length * 7;
    case 'w2':   return cells.filter(isW).length * 2;
    case 'adj2': { // 霸王龙:灵方块邻接或经动物方块连通的每个动物方块 +2
      if (!pos || !b[pos]) return 0;
      const seen = new Set([pos]), q = [pos]; let n = 0;
      while (q.length) {
        const k = q.pop();
        const [cq, cr] = k.split(',').map(Number);
        for (const [nq, nr] of neighbors(cq, cr)) {
          const nk = key(nq, nr);
          if (seen.has(nk) || !b[nk]) continue;
          // 只有动物(橙)方块计分并可作为连通跳板;自然之灵(白)方块不算动物方块
          if (b[nk].cube && !isSpiritCube(b[nk].cube)) { seen.add(nk); q.push(nk); n++; }
        }
      }
      return n * 2;
    }
  }
  return 0;
}

function scoreWater(p) {
  const b = p.board, side = G.side;
  const isBlue = c => topType(c) === 'water';
  if (side === 'B') { // 岛屿:非水连通块 × 5
    const seen = new Set(); let n = 0;
    for (const k in b) {
      if (isBlue(b[k]) || seen.has(k)) continue;
      flood(b, k, c => !isBlue(c)).forEach(x => seen.add(x)); n++;
    }
    return n * 5;
  }
  // A/C/D 面:最长河流(连通块内最短路径的最长值);官方规则书:C/D 面"其他地貌遵循的规则与 A 面相同"

  let best = 0; const seen = new Set();
  for (const k in b) {
    if (!isBlue(b[k]) || seen.has(k)) continue;
    const grp = flood(b, k, isBlue); grp.forEach(x => seen.add(x));
    best = Math.max(best, riverDiameter(b, grp));
  }
  if (best < 2) return 0;
  return best <= 6 ? RIVER_PTS[best] : RIVER_PTS[6] + (best - 6) * 4;
}

function riverDiameter(board, grp) {
  const set = new Set(grp); let best = 0;
  for (const s of grp) {
    const dist = { [s]: 1 }; const q = [s];
    while (q.length) {
      const k = q.shift(); best = Math.max(best, dist[k]);
      const [cq, cr] = k.split(',').map(Number);
      for (const [nq, nr] of neighbors(cq, cr)) {
        const nk = key(nq, nr);
        if (set.has(nk) && !dist[nk]) { dist[nk] = dist[k] + 1; q.push(nk); }
      }
    }
  }
  return best;
}
