
/* ============================================================
 * AI(启发式)
 * ============================================================ */
const wait = ms => new Promise(r => setTimeout(r, ms));
const aiLog = (idx, t) => { const el = document.getElementById('think' + idx); if (el) el.textContent = t; };

/* 选一张「真能建得完」的保护区:看所需颜色在当前供应区/袋子里够不够、
   版图有没有空格可起建、建成后相邻格能拿多少分。旧版固定拿第 1 张,
   又不给建造奖励,结果 AI 拿了保护区 100% 用不上。 */
function pickSanct(p) {
  let best = -1, bv = -1e9;
  const freeCells = Object.values(p.board).filter(c => !c.stack.length && !c.cube && !c.spirit).length;
  G.sanctOffer.forEach((def, i) => {
    const need = {};
    def.layers.forEach(t => { need[t] = (need[t] || 0) + 1; });
    let avail = 0;
    for (const t in need) {
      const inSupply = G.supply.reduce((n, g) => n + g.filter(x => x === t).length, 0);
      const inPouch = G.pouch.filter(x => x === t).length;
      avail += Math.min(need[t], inSupply * 1.5 + inPouch * 0.12);
    }
    let adj = 0;
    for (const k in p.board) {
      const [q, r] = k.split(',').map(Number);
      let n = 0;
      for (const [nq, nr] of neighbors(q, r)) {
        const c = p.board[key(nq, nr)];
        if (c && def.colors.includes(topType(c))) n++;
      }
      if (n > adj) adj = n;
    }
    // 和当前动物卡需要的颜色重合越多,保护区越可能在之后帮助动物完成/计分。
    let animalFit = 0;
    for (const ci of p.cards) {
      if (ci.done) continue;
      for (const pc of ci.def.pat) {
        const rc = reqColor(pc);
        if (rc && def.colors.includes(rc)) animalFit += pc.a ? 2 : 1;
      }
    }
    const v = avail * 4 + Math.min(freeCells, 6) * 1.2 + adj * 2.5 + animalFit * 1.4;
    if (v > bv) { bv = v; best = i; }
  });
  return best;
}

async function aiTurn() {
  const meIdx = G.cur;
  const p = G.players[meIdx];
  await wait(500);
  // 0. 保护区:只同时持有一张未完成的,且给动物卡留出卡位
  const undoneSanct = (p.sancts || []).filter(s => !s.done).length;
  const sanctLimit = sideTune().sanctSlot;
  if (G.mods.sanct && !G.tookSanct && activeCardCount(p) < sanctLimit && undoneSanct < 1
      && G.sanctOffer.length && G.round >= 2) {
    const si = pickSanct(p);
    if (si >= 0) {
      const def = G.sanctOffer.splice(si, 1)[0];
      p.sancts.push({ def, layer: 0, done: false, pos: null, site: null });
      G.tookSanct = true;
      log(`${p.name} 拿了保护区板块 <b>${def.name}</b>(将按 4 层颜色建造)`, meIdx);
      renderAll(); await wait(350);
    }
  }
  // 1. 取卡:优先「当前版图已经接近拼出图案」的卡,别拿永远搭不出来的死卡把 4 个卡位堵死
  if (!G.tookCard && activeCardCount(p) < 4 && G.market.length) {
    let bi = -1, bv = 0;
    const busy = activeCardCount(p);
    G.market.forEach((def, i) => {
      const m = findMatches(def, p.board, p).length;
      const prog = cardProgress(def, p.board, p);
      const n = def.pat.length;
      // 高堆叠/建筑图案更难搭,轻度降权
      const hard = def.pat.reduce((a, pc) => a + ({ T3: 1, M3: 1, B: 1, T2: 1, M2: 1, r: 1 }[pc.req] || 0), 0);
      let v = m * 5 + prog * 2.4 + Math.max(0, 4 - n) * 1.2
            + def.cubes[def.cubes.length - 1] * 0.28 - hard * AI_TUNE.hardPenalty
            - (def.cubes.length - 2) * AI_TUNE.cubePenalty
            + (m >= def.cubes.length ? AI_TUNE.readyBonus : 0);
      if (def.elf) v -= 0.5;
      // 卡位吃紧时只拿「已经能放方块」或「只差一格」的卡,否则 4 个位会被死卡堵死
      if (busy >= AI_TUNE.busyLimit && m === 0 && prog < n - 1) return;
      if (v > bv) { bv = v; bi = i; }
    });
    if (bi >= 0 && bv > AI_TUNE.takeThreshold) {
      const def = G.market.splice(bi, 1)[0];
      const inst = mkCardInst(def);
      if (def.elf) inst.elfLeft = 2;
      p.cards.push(inst); G.tookCard = true;
      log(`${p.name} 取了动物卡 <b>${def.icon}${def.name}</b>`, meIdx);
      aiLog(meIdx, `${p.name} 取了 ${def.name}`);
      renderAll(); await wait(400);
    }
  }
  // 2. 选组:贪心模拟每组的最大收益
  let bestGi = -1, bestPlan = null, bestVal = -1e9;
  for (let gi = 0; gi < 5; gi++) {
    if (!G.supply[gi].length) continue;
    const plan = planPlacements(p, G.supply[gi], { allOrders: sideTune().allOrders });
    let val = plan.val;
    // 只有自己这组实在没什么收益时才考虑抢组;正常局面仍以自己动物/地形为主。
    if (AI_TUNE.deny > 0 && plan.val < 4) val += AI_TUNE.deny * opponentGroupValue(gi, meIdx);
    if (val > bestVal) { bestVal = val; bestGi = gi; bestPlan = plan; }
  }
  if (!bestPlan) { // 供应区全空(结束已触发):直接结束
    aiLog(meIdx, ''); G.tookCard = false; endTurn(); return;
  }
  G.supply[bestGi] = [];
  aiLog(meIdx, `${p.name} 取了一组标记`);
  renderAll(); await wait(450);
  // 3. 放置
  for (const step of bestPlan.steps) {
    lockSanctSite(p.board, step.k, step.type, p); // 与人类一致:锁定保护区建造格
    placeToken(p.board, step.k, step.type);
    log(`${p.name} 放置 <b>${TYPES[step.type].name}</b>`, meIdx);
    const doneS = checkSanctComplete(p.board, step.k, p);
    if (doneS) log(`${p.name} 的保护区 <b>${doneS.def.name}</b> 建造完成!`, meIdx);
    renderAll(); await wait(350);
    // 放置间隙可放方块
    await aiPlaceCubes(meIdx, p);
  }
  if (bestPlan.steps.length < 3) log(`${p.name} 有 ${3 - bestPlan.steps.length} 个标记无处可放,按规则弃置`, meIdx);
  await aiPlaceCubes(meIdx, p);
  aiLog(meIdx, '');
  await wait(300);
  G.tookCard = false;
  endTurn();
}

/* AI 建造保护区:把当前层地形放到版图可建造格(空格或已有前序层的格),无视一般放置规则 */

/* 同一张卡的多个匹配锚点,选一个最不挡其它卡图案的:
   旧版固定取 m[0],经常把别的卡图案锚点占掉,导致那张卡永远差一格。 */
function chooseCubeAnchor(p, ci, matches) {
  let best = matches[0], bestPen = 1e9;
  for (const m of matches) {
    let pen = 0;
    for (const other of p.cards) {
      if (other === ci || other.done) continue;
      const om = findMatches(other.def, p.board, p);
      if (!om.some(x => x.anchor === m.anchor)) continue;
      const op = cardProgress(other.def, p.board, p);
      const cubeW = other.def.cubes[Math.min(other.placed, other.def.cubes.length - 1)] || 0;
      pen += 3 + op * 3 + cubeW * 0.4;
    }
    if (pen < bestPen) { bestPen = pen; best = m; }
  }
  return best;
}

async function aiPlaceCubes(pIdx, p) {
  for (let i = 0; i < p.cards.length; i++) {
    const ci = p.cards[i];
    if (ci.done) continue;
    // 动物卡只剩最后 1 个方块且所需颜色匹配已完成保护区 → 直接放到保护区上完成该卡
    if (!ci.def.elf && !ci.def.spirit && ci.placed === ci.def.cubes.length - 1) {
      const need = reqColor(ci.def.pat.find(c => c.a));
      const doneS = (p.sancts || []).find(s => s.done && need && s.def.colors.includes(need));
      if (doneS) {
        ci.placed++; ci.done = true;
        log(`${p.name} 把「${ci.def.name}」最后 1 方块放到保护区「${doneS.def.name}」上`, pIdx);
        renderAll(); await wait(280);
      }
    }
    let m = findMatches(ci.def, p.board, p);
    let guard = 0;
    while (m.length && !ci.done && guard++ < 8) {
      const before = ci.placed;
      const best = chooseCubeAnchor(p, ci, m);
      if (!placeCube(pIdx, i, best)) break;   // 放置被规则拒绝时立即停,避免死循环
      renderAll(); await wait(280);
      if (ci.placed === before) break;
      m = findMatches(ci.def, p.board, p);
    }
  }
}

/* AI 启发式权重集中在这里,便于批量模拟调参(模拟脚本会临时改 AI_TUNE)。
   这一组来自跨种子批量模拟:cube 前瞻 + 只算锚点空闲的图案进度 + 更克制的叠高。
   注意单批种子很容易过拟合,调参务必跨种子复核。 */
window.AI_TUNE = {
  match: 5.5,          // 放置后「已有可放方块的匹配」的价值
  terrain: 2.2,        // 地形铺垫(树干打底/连片)的提前奖励
  emptyCost: 3.0,      // 占用新空格的基础代价(空格 ≤2 触发终局,后期还会放大)
  progScale: 7,        // 图案进度价值系数
  progPow: 2.2,        // 非线性指数:越接近完成,补最后一格越值钱
  sanctBase: 10, sanctStep: 5, sanctFinal: 20,  // 保护区逐层建造 / 完成奖励
  cubePenalty: 3.2,    // 卡的方块数越多越难完成的降权
  readyBonus: 6,       // 当前版图已能一次放完整张卡
  hardPenalty: 1.3,    // T3/M3/B 等难搭地形的降权
  busyLimit: 3,        // 未完成卡达到这个数量后只拿「快能完成」的卡
  takeThreshold: 4.0,  // 取卡评分门槛
  stackBonus: 3,       // 放在已有标记上的额外奖励(叠高、省空格);过高会让 AI 只堆不铺图案
  lateEmptyK: 1,       // 空格快用完时放大「占用新空格」的代价,越晚越倾向堆叠续命
  cubeGain: 1.0,       // 下一枚方块的卡面分增量权重(第二/第三枚高分方块要看得见)
  center: 1.8,         // 版图重心偏好:避免总从左/上边缘起手,给图案留更多邻接方向
  frontier: 0.9,       // 向已有地形/标记邻接的偏好:减少孤立空格,提高动物卡联动
  sanctCenter: 6.0,    // 保护区首层向中心靠的权重;避免保护区贴边、完成时邻接计分少
  deny: 0.10,          // 仅当自己这组收益很低时,才轻度抢对手需要的组
};
/* 图案进度的价值是「非线性」的:把最后 1 格补上(能立刻放方块拿分)远比
   到处开新坑值钱。线性权重会让 AI 每回合在不同位置各铺一格,结果每张卡都差一点,
   终局 4 个卡位全被死卡占满。 */
function progValue(prog, n) {
  if (prog <= 0) return 0;
  return AI_TUNE.progScale * n * Math.pow(prog / n, AI_TUNE.progPow);
}
/* 地形「铺垫」的提前奖励:树干打底(0 分)、水/田野连片、山相邻这些动作在做到的
   当下 scoreBoard 增量为 0,单步贪心看不见,AI 就永远堆不出 3 层树或长河流。 */
function terrainPotential(board, k) {
  const cell = board[k]; if (!cell) return 0;
  const h = cell.stack.length, top = topType(cell);
  if (!top) return 0;
  const [q, r] = k.split(',').map(Number);
  let adjSame = 0; const adjColors = new Set();
  for (const [nq, nr] of neighbors(q, r)) {
    const c = board[key(nq, nr)];
    if (!c) continue;
    const ct = topType(c);
    if (ct === top) adjSame++;
    if (ct) adjColors.add(ct);
  }
  switch (top) {
    case 'trunk':    return h === 1 ? 2.2 : h === 2 ? 4.2 : 0;
    case 'mountain': return adjSame ? 1.2 + h * 1.1 : 0;
    case 'water':    return adjSame * 1.0;
    case 'field':    return adjSame * 1.0;
    case 'building': return h === 2 ? adjColors.size * 0.8 : 0;
  }
  return 0;
}

/* 保护区建造奖励:让 AI 从第一层起就在同一格按板块 4 层颜色堆叠。
   旧版完全没有这一项,所以 AI 拿了保护区也永远不会去建 —— 实测完成率 0%。 */
function sanctBuildBonus(p, clone, k, t, geom) {
  const cell = clone[k];
  const h = cell.stack.length - 1;              // clone 里已含本次放入的 t,h = 放入前的层数
  if (h < 0 || h >= 4) return 0;
  let bonus = 0;
  for (const s of (p.sancts || [])) {
    if (s.done || (s.site && s.site !== k)) continue;
    let ok = true;
    for (let i = 0; i < h; i++) if (cell.stack[i] !== s.def.layers[i]) { ok = false; break; }
    if (!ok || s.def.layers[h] !== t) continue;
    bonus += (h === 3 ? AI_TUNE.sanctFinal : AI_TUNE.sanctBase + h * AI_TUNE.sanctStep); // 越接近完成越值钱
    // 旧版保护区跟着第一个可用空格走,经常落在最左边。首层就往版图中心靠,
    // 让完成后相邻 6 格有更多可计分地形;后续层已被 site 锁定,不会跑位。
    if (geom) bonus += AI_TUNE.sanctCenter * centralPos(k, geom);
    if (h === 3) {                              // 完成后的相邻计分潜力
      const [q, r] = k.split(',').map(Number);
      for (const [nq, nr] of neighbors(q, r)) {
        const c = clone[key(nq, nr)];
        if (c && s.def.colors.includes(topType(c))) bonus += 3;
      }
    }
  }
  return bonus;
}

/* 一张卡「下一枚方块」的卡面分值:第二/第三枚高价值方块要被正确估值。
   旧版所有匹配都只值 match=5.5,不分「这张卡下一枚值 6 分还是 17 分」。
   matches.length 是当前可放锚点数;placedAfter 封顶到卡的总方块数。 */
function cardCubeScore(ci, matches) {
  const cubes = ci.def.cubes || [];
  if (!cubes.length) return 0;
  const placedAfter = Math.min(cubes.length, ci.placed + matches.length);
  return placedAfter > 0 ? cubes[placedAfter - 1] : 0;
}
/* 版图中心度:旧版用 |q|+|r|+|q+r| 做径向惩罚,原点在版图左上角,
   实际效果是越靠左越“好”,所以 AI 永远从最左边开始铺。这里改成
   以整张版图的像素重心为原点,给内部格加分。中心格周围可用的
   邻居/图案方向更多,动物卡和水田连片都更容易接上。 */
function boardGeom(board) {
  let cx = 0, cy = 0, n = 0;
  const pts = [];
  for (const k in board) {
    const [q, r] = k.split(',').map(Number);
    const p = hexPx(q, r);
    pts.push({ x: p.x, y: p.y });
    cx += p.x; cy += p.y; n++;
  }
  cx /= (n || 1); cy /= (n || 1);
  let maxD = 1;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > maxD) maxD = d;
  }
  return { cx, cy, maxD };
}
function centralPos(k, geom) {
  if (!geom) return 0;
  const [q, r] = k.split(',').map(Number);
  const p = hexPx(q, r);
  return 1 - Math.min(1, Math.hypot(p.x - geom.cx, p.y - geom.cy) / geom.maxD);
}
/* 不同版图的侧重点:小版图 A 优先动物/图案,大版图 D 优先地形;
   中心度仍然保留,但 A 面空格少,不能让中心偏好把动物卡位挤掉。
   三枚标记顺序搜索对所有版图开启;不同版图仅差权重/保护区上限。 */
const SIDE_TUNE = {
  A: { center: 2.2, frontier: 1.0, animal: 1.08, terrain: 1.00, building: 1.00, sanct: 0.90, sanctSlot: 3, allOrders: true },
  B: { center: 1.8, frontier: 0.9, animal: 1.00, terrain: 1.00, building: 1.00, sanct: 1.00, sanctSlot: 4, allOrders: true },
  C: { center: 1.7, frontier: 1.0, animal: 1.05, terrain: 1.15, building: 1.00, sanct: 0.95, sanctSlot: 3, allOrders: true },
  D: { center: 1.9, frontier: 0.85, animal: 0.95, terrain: 1.15, building: 1.00, sanct: 1.00, sanctSlot: 4, allOrders: true },
};
function sideTune() { return SIDE_TUNE[G.side] || SIDE_TUNE.B; }
/* 动态侧重点:快完成的动物卡优先,地形分落后时补地形,已有保护区/卡位紧时降低保护区。 */
function dynamicFocus(p, t) {
  const active = p.cards.filter(c => !c.done);
  const near = active.filter(c => cardProgress(c.def, p.board, p) >= c.def.pat.length - 1).length;
  const empty = Object.values(p.board).filter(c => !c.stack.length && !c.cube && !c.spirit).length;
  const s = scoreBoard(p);
  const terrainPts = s.tree + s.mountain + s.field + s.building + s.water;
  let animal = t.animal * (1 + near * 0.05 + active.length * 0.02);
  let terrain = t.terrain * (terrainPts < 30 ? 1.08 : 0.98) * (near >= 2 ? 0.97 : 1);
  let sanct = t.sanct * (empty >= 10 ? 1 : 0.85);
  if ((p.sancts || []).some(x => x.done)) sanct *= 0.90; // 已建成一个后不再无限追保护区
  if (near >= 2) sanct *= 0.85;                          // 动物卡快完成时先补动物
  return { animal, terrain, sanct, building: t.building || 1 };
}
/* 已有地形邻接数:让 AI 往已有版图/图案旁边发展,而不是在空白边缘各开一坑。 */
function developedNeighbors(board, k) {
  const [q, r] = k.split(',').map(Number);
  let n = 0;
  for (const [nq, nr] of neighbors(q, r)) {
    const c = board[key(nq, nr)];
    if (c && (c.stack.length || c.cube || c.spirit)) n++;
  }
  return n;
}

/* 贪心放置规划:逐枚尝试所有合法格。
   收益 = 计分增量 + 图案推进 + 下一枚方块卡面分增量 + 保护区建造奖励 + 堆叠奖励 - 空格成本 + 中心度/邻接 */
function planPlacementsOne(p, tokens, forcedOrder) {
  const clone = {};
  for (const k in p.board) clone[k] = { stack: p.board[k].stack.slice(), cube: p.board[k].cube, spirit: p.board[k].spirit };
  // sancts 单独克隆:模拟中也要维护"一个板块只在一个格子建造"的锁定
  const tmpP = { ...p, board: clone, sancts: (p.sancts || []).map(s => ({ ...s })) };
  const cards = p.cards.filter(c => !c.done);
  const steps = []; let total = 0;
  const geom = boardGeom(clone);
  const st = sideTune();
  const focus = dynamicFocus(p, st);
  /* 空格成本随版图变满而放大:开局自由铺河流/田野/图案,空格少于 ~10 时才强力
     堆叠续命。固定代价会让 AI 从第一回合起不敢铺开,版图过早填满直接触发终局。 */
  const free0 = Object.values(p.board).filter(c => !c.stack.length && !c.cube && !c.spirit).length;
  const cellCost = AI_TUNE.emptyCost * (1 + Math.max(0, 10 - free0) * AI_TUNE.lateEmptyK);
  // 稀有度优先放置(红/综先放,蓝/黄后放);指定顺序时用于排列搜索。
  const order = forcedOrder ? forcedOrder.slice() : tokens.slice().sort((a, b) => scarcity(b) - scarcity(a));
  for (const t of order) {
    let bestK = null, bestV = -1e9;
    const baseScore = scoreBoard(tmpP).total;
    // 「放置前」的图案进度/可放方块分,对每枚标记只算一次,后面只算差分
    const beforeMatches = cards.map(ci => findMatches(ci.def, clone, tmpP));
    const beforeCubeScore = cards.map((ci, i) => cardCubeScore(ci, beforeMatches[i]));
    const before = {};
    for (const k in clone) {
      if (!canPlace(clone, k, t, tmpP)) continue;
      before[k] = cards.map(ci => localProgress(ci.def, clone, k, tmpP));
    }
    for (const k in before) {
      const potBefore = terrainPotential(clone, k);
      const wasEmpty = clone[k].stack.length === 0;
      const devBefore = developedNeighbors(clone, k);
      clone[k].stack.push(t);
      let v = scoreBoard(tmpP).total - baseScore;
      let gain = 0, cubeGain = 0;
      for (let i = 0; i < cards.length; i++) {
        const ci = cards[i], n = ci.def.pat.length;
        gain += progValue(localProgress(ci.def, clone, k, tmpP), n) - progValue(before[k][i], n);
        const afterM = findMatches(ci.def, clone, tmpP);
        cubeGain += cardCubeScore(ci, afterM) - beforeCubeScore[i];
      }
      v += gain * focus.animal + cubeGain * AI_TUNE.cubeGain * focus.animal;
      const potAfter = terrainPotential(clone, k);
      const buildingMul = topType(clone[k]) === 'building' ? focus.building : 1;
      v += Math.max(0, potAfter - potBefore) * AI_TUNE.terrain * focus.terrain * buildingMul;
      v += (clone[k].stack.length - 1) * AI_TUNE.stackBonus; // 叠高既有格:既攒高度分又省空格
      if (wasEmpty) v -= cellCost;   // 空格越少,占用新空格越贵(别太早触发终局)
      v += sanctBuildBonus(p, clone, k, t, geom) * focus.sanct;
      v += st.center * centralPos(k, geom);
      v += st.frontier * devBefore;
      clone[k].stack.pop();
      if (v > bestV) { bestV = v; bestK = k; }
    }
    if (bestK == null) { // 无处可放:该标记被跳过并重罚,避免 AI 选这组
      total -= 12;
      continue;
    }
    lockSanctSite(clone, bestK, t, tmpP);
    clone[bestK].stack.push(t);
    steps.push({ k: bestK, type: t });
    total += bestV;
  }
  return { steps, val: total };
}

/* 3 枚标记的顺序会影响图案先后;固定按稀有度排序只是启发式。
   对每个供应组额外尝试所有不重复顺序,选总分最高的方案。 */
function permutationOrders(tokens) {
  if (tokens.length <= 1) return [tokens.slice()];
  const out = [];
  const seen = new Set();
  const walk = (rest, acc) => {
    if (!rest.length) {
      const sig = acc.join('|');
      if (!seen.has(sig)) { seen.add(sig); out.push(acc.slice()); }
      return;
    }
    for (let i = 0; i < rest.length; i++) walk(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat(rest[i]));
  };
  walk(tokens, []);
  return out;
}
function planPlacements(p, tokens, opts = {}) {
  const orders = opts.allOrders ? permutationOrders(tokens) : [null];
  let best = null;
  for (const order of orders) {
    const r = planPlacementsOne(p, tokens, order);
    if (!best || r.val > best.val) best = r;
  }
  return best;
}

function hasAnyPlacement(board, type, player) {
  return Object.keys(board).some(k => canPlace(board, k, type, player));
}
/* 对手对这组标记的最高收益:用于选组时做动态防守。
   只看「对手也能拿这组做什么」,不改变自己的放置评分,避免因为对手而乱铺。 */
function opponentGroupValue(gi, meIdx) {
  let best = 0;
  const me = G.players[meIdx];
  const myScore = scoreBoard(me).total;
  for (let i = 0; i < G.players.length; i++) {
    if (i === meIdx) continue;
    const op = G.players[i];
    if (!op || !op.cards) continue;
    const oppScore = scoreBoard(op).total;
    const active = op.cards.filter(c => !c.done);
    const near = active.filter(c => cardProgress(c.def, op.board, op) >= c.def.pat.length - 1).length;
    // 只有对手已经领先或手里有快完成卡时才防守,避免为了“抢组”牺牲自己的动物/地形。
    if (oppScore < myScore + 15 && near === 0) continue;
    const pv = planPlacements(op, G.supply[gi]).val;
    if (pv > best) best = pv;
  }
  return best;
}
function scarcity(t) { return { building: 6, trunk: 5, tree: 4, mountain: 3, field: 2, water: 1 }[t]; }

/* ============================================================
 * 结束与结算
 * ============================================================ */
function gameOver() {
  G.over = true;
  const scores = G.players.map(p => scoreBoard(p));
  let html = `<tr><th></th>${G.players.map(p => `<th>${p.name}</th>`).join('')}</tr>`;
  const row = (label, fn, cond = true) => {
    if (!cond) return;
    html += `<tr><td>${label}</td>${scores.map(s => `<td>${fn(s) || 0}</td>`).join('')}</tr>`;
  };
  // 地形分:树木/山脉/田地/建筑/水 逐项明细
  row('树木', s => s.tree);
  row('山脉', s => s.mountain);
  row('田地', s => s.field);
  row('建筑', s => s.building);
  row('水',   s => s.water);
  row('动物', s => s.animal);
  row('自然之灵', s => s.spirit, scores.some(s => s.spirit));           // 有灵分才显示
  row('精灵', s => s.elf, G.mods.cres);                                  // Crescendo 精灵方块
  row('保护区', s => s.sanctPts, G.mods.sanct);                          // 保护区板块(非「圣所」)
  html += `<tr class="total"><td>总分</td>${scores.map(s => `<td>${s.total}</td>`).join('')}</tr>`;
  document.getElementById('scoreTbl').innerHTML = html;
  // 胜负:最高分者获胜;并列时比较动物方块数
  const totals = scores.map(s => s.total);
  const maxT = Math.max(...totals);
  const leaders = G.players.filter((p, i) => totals[i] === maxT);
  let win, tie = '';
  if (leaders.length === 1) {
    win = leaders[0].isAI ? `${leaders[0].name} 获胜` : '🎉 你赢了!';
  } else {
    const maxC = Math.max(...leaders.map(p => p.cubesPlaced));
    const top = leaders.filter(p => p.cubesPlaced === maxC);
    if (top.length === 1) win = top[0].isAI ? `平分,${top[0].name} 动物方块更多,${top[0].name} 获胜` : '🎉 平分,你放置的动物方块更多,你赢!';
    else win = '完全平分,共享胜利!';
    tie = `平分加赛(方块数):` + leaders.map(p => `${p.name} ${p.cubesPlaced}`).join(' vs ');
  }
  document.getElementById('winnerTxt').textContent = win;
  document.getElementById('tieNote').textContent = tie;
  document.getElementById('endOv').classList.remove('hidden');
  log(`游戏结束 · ` + G.players.map((p, i) => `${p.name} ${totals[i]}`).join(' / '));
  renderAll();
}
