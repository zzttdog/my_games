
function setMsg(t) { document.getElementById('msg').textContent = t; }
function log(t, pIdx) {
  const el = document.getElementById('log');
  const cls = (pIdx === 0 || pIdx) ? ` class="pl${pIdx}"` : '';
  el.innerHTML = `<div${cls}>[R${G.round}] ${t}</div>` + el.innerHTML;
}

/* ============================================================
 * 回合流程(人类)
 * ============================================================ */
/* 撤回:回合内任意操作前压入快照,回合结束前可逐步步退 */
function pushUndo() {
  const p = G.players[0];
  G.undoStack.push({
    board: JSON.parse(JSON.stringify(p.board)),
    cards: p.cards.map(c => ({ def: c.def, placed: c.placed, done: c.done, elfLeft: c.elfLeft })),
    cubesPlaced: p.cubesPlaced,
    sancts: (p.sancts || []).map(s => ({ def: s.def, layer: s.layer, done: s.done, pos: s.pos, site: s.site || null })),
    hand: JSON.parse(JSON.stringify(G.hand)),
    handSel: G.handSel,
    supply: G.supply.map(g => g.slice()),
    market: G.market.slice(),
    tookCard: G.tookCard,
    tookSanct: G.tookSanct,
    sanctOffer: G.sanctOffer.slice(),
  });
}

function takeGroup(gi) {
  if (G.cur !== 0 || G.hand.length || G.over) return;
  pushUndo();
  G.hand = G.supply[gi].map(t => ({ type: t, placed: false }));
  G.supply[gi] = [];
  G.handGi = gi;
  G.handSel = G.hand.findIndex(h => !h.placed);
  G.cubeMode = null;
  setMsg(`已取标记,点击版图高亮处放置(需全部放完才能结束回合)`);
  renderAll();
}

function onBoardClick(e) {
  if (G.cur !== 0 || G.over) return;
  const p = G.players[0];
  const cv = e.currentTarget, rect = cv.getBoundingClientRect();
  const sx = cv.width / rect.width, sy = cv.height / rect.height;
  const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
  // B 面整体缩放后，点击坐标先反算回未缩放坐标，再按 HEX 命中
  const view = (typeof BOARD_VIEW !== 'undefined') ? BOARD_VIEW[G.side] : null;
  let hx = mx, hy = my;
  if (view) {
    hx = cv.width / 2 + (mx - cv.width / 2 - view.dx) / view.k;
    hy = cv.height / 2 + (my - cv.height / 2 - view.dy) / view.k;
  }
  let best = null, bd = Infinity;
  for (const k in p.board) {
    const [q, r] = k.split(',').map(Number);
    const { x, y } = hexPx(q, r);
    const d = Math.hypot(hx - x, hy - y);
    if (d < HEX && d < bd) { bd = d; best = k; }
  }
  if (!best) return;
  // 方块模式
  if (G.cubeMode) {
    const m = G.cubeMode.matches.find(m => m.anchor === best);
    if (m) placeCube(0, G.cubeMode.cardIdx, m);
    else { setMsg('该处不能放置此动物方块'); }
    return;
  }
  // 放标记
  if (G.handSel < 0 || !G.hand[G.handSel] || G.hand[G.handSel].placed) return;
  const h = G.hand[G.handSel];
  if (!canPlace(p.board, best, h.type, p)) { setMsg('此处不能放置该标记(检查堆叠规则)'); return; }
  pushUndo();
  const locked = lockSanctSite(p.board, best, h.type, p); // 必须在 placeToken 之前
  placeToken(p.board, best, h.type);
  h.placed = true;
  log(`你放置 <b>${TYPES[h.type].name}</b>`, 0);
  if (locked) log(`保护区「${locked.def.name}」已绑定本格建造(同一板块不能同时在多个格子突破规则)`, 0);
  const doneS = checkSanctComplete(p.board, best, p);
  if (doneS) {
    log(`你的保护区 <b>${doneS.def.name}</b> 建造完成!相邻格顶标记匹配 ${doneS.def.colors.map(c=>TYPES[c].short).join('/')} 每格 +3 分`, 0);
    setMsg(`「${doneS.def.name}」完成!相邻对应色顶标记每格 +3 分`);
  }
  G.handSel = G.hand.findIndex(x => !x.placed);
  if (G.handSel < 0) setMsg('标记已放完。可取动物卡/放方块,或结束回合');
  renderAll();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { G.cubeMode = null; renderAll(); setMsg('已取消'); }
});

function takeCard(mi) {
  if (G.cur !== 0 || G.tookCard || G.over) return;
  const p = G.players[0];
  if (activeCardCount(p) >= 4) return;
  pushUndo();
  const def = G.market.splice(mi, 1)[0];
  const inst = mkCardInst(def);
  if (def.elf) inst.elfLeft = 2;
  p.cards.push(inst);
  G.tookCard = true;
  if (def.elf) {
    log(`你拿了精灵卡 <b>${def.icon}${def.name}</b>,卡上放置 2 个精灵方块`, 0);
    setMsg(`已取「${def.name}」:达成图案后把紫色方块放到卡面带「*」的格子(可与动物同格,不能与自然之灵同格)`);
  } else {
    log(`你取了动物卡 <b>${def.icon}${def.name}</b>`, 0);
    setMsg(`已取「${def.name}」。完成其图案后可放方块`);
  }
  renderAll();
}

function activeCardCount(p) { return p.cards.filter(c => !c.done).length + (p.sancts || []).filter(s => !s.done).length; }

function enterCubeMode(cardIdx) {
  if (G.cur !== 0 || G.over) return;
  const p = G.players[0];
  const ci = p.cards[cardIdx];
  if (ci.done) return;
  const need = ci.def.cubes.length - ci.placed;
  // 同一张卡再次点击:刷新匹配并继续放置,而不是取消。取消统一用 Esc。
  if (G.cubeMode && G.cubeMode.cardIdx === cardIdx) {
    const matches = findMatches(ci.def, p.board, p);
    if (matches.length) {
      G.cubeMode = { cardIdx, matches };
      setMsg(`「${ci.def.name}」还需 ${need} 枚方块:继续点击另一处金色高亮格(Esc 取消)`);
    } else {
      G.cubeMode = null;
      setMsg(need > 1
        ? `「${ci.def.name}」还需 ${need} 枚方块,但版图上没有第二处完整图案(同一格不能叠两枚动物方块)`
        : `「${ci.def.name}」还需 ${need} 枚方块,但当前没有可用匹配`);
    }
    renderAll();
    return;
  }
  // 动物卡只剩最后 1 个方块,且该方块所需颜色匹配已完成保护区 → 直接放到保护区上完成该卡
  if (!ci.def.elf && !ci.def.spirit && ci.placed === ci.def.cubes.length - 1) {
    const needColor = reqColor(ci.def.pat.find(c => c.a));
    const doneS = (p.sancts || []).find(s => s.done && needColor && s.def.colors.includes(needColor));
    if (doneS) {
      pushUndo();
      ci.placed++; ci.done = true;
      log(`你把「${ci.def.name}」的最后 1 个方块放到保护区「${doneS.def.name}」上,完成该卡`, 0);
      setMsg(`「${ci.def.name}」完成(方块已放到保护区上)`);
      renderAll();
      return;
    }
  }
  const matches = findMatches(ci.def, p.board, p);
  if (!matches.length) {
    setMsg(need > 1
      ? `「${ci.def.name}」还需 ${need} 枚方块,但版图上没有完整图案(同一格不能叠两枚动物方块)`
      : `「${ci.def.name}」的图案当前在版图上没有匹配`);
    return;
  }
  G.cubeMode = { cardIdx, matches };
  let msg = `「${ci.def.name}」还需 ${need} 枚方块,当前有 ${matches.length} 处匹配;点击金色高亮格放置(Esc 取消)`;
  if (matches.length < need) msg += `。注意:同一格不能叠两枚方块,当前匹配不足 ${need} 处,可能无法一次放完`;
  setMsg(msg);
  renderAll();
}

function placeCube(pIdx, cardIdx, match) {
  const p = G.players[pIdx];
  const ci = p.cards[cardIdx];
  /* 保护区格一律拒绝通用放置:建造途中不能放动物/精灵;完成后只能由「动物卡最后一枚方块」
     专用路径直接完成(该路径不经过 placeCube)。 */
  if (sanctCellKind(p, match.anchor) !== 0) {
    if (pIdx === 0) setMsg('保护区格不能放动物/精灵方块:建造途中禁止;完成后只能由该卡最后一枚方块专用路径放置');
    return false;
  }
  if (ci.def.elf) { // 精灵方块:放格上 spirit 标记,只能与动物(橙)方块同格
    const cell = p.board[match.anchor];
    /* 兜底防御:findMatches 已经排除这两种格子,但旧快照/AI 快速路径也不能绕过规则。
       必须在 pushUndo 之前判断,否则被拒绝的点击也会往撤回栈里压一条空操作。 */
    if (!cell || cell.spirit || (cell.cube && isSpiritCube(cell.cube))) {
      if (pIdx === 0) setMsg('此格已有精灵方块或自然之灵方块,不能放精灵方块');
      return false;
    }
  }
  if (pIdx === 0) pushUndo();
  if (ci.def.elf) {
    const cell = p.board[match.anchor];
    cell.spirit = true;
    ci.placed++; if (ci.elfLeft > 0) ci.elfLeft--;
    G.cubePlacedThisTurn = true;
    log(`${p.name}的精灵方块入驻!(${ci.placed}/2 精灵方块,只能与动物方块同格)`, pIdx);
  } else {
    const cell = p.board[match.anchor];
    cell.cube = { icon: ci.def.icon, card: ci.def.name, img: ci.def.img || null, spirit: !!ci.def.spirit };
    ci.placed++; p.cubesPlaced++;
    G.cubePlacedThisTurn = true;
    log(`${p.name}的 <b>${ci.def.icon}${ci.def.name}</b> 入驻!(${ci.placed}/${ci.def.cubes.length} 方块)`, pIdx);
  }
  if (ci.placed >= ci.def.cubes.length) {
    ci.done = true;
    log(`<b>${ci.def.icon}${ci.def.name}</b> 完成!${ci.def.elf ? '精灵:与动物同格5分/单独2分' : ci.def.spirit ? '终局按「' + ci.def.desc + '」计分' : `终局 ${ci.def.cubes[ci.def.cubes.length - 1]} 分`}`, pIdx);
    if (pIdx === 0) G.cubeMode = null;
  } else if (pIdx === 0) {
    // 刷新匹配;同一张卡继续点,不要因为再点卡牌而取消高亮
    const left = ci.def.cubes.length - ci.placed;
    const matches = findMatches(ci.def, p.board, p);
    if (matches.length) {
      G.cubeMode = { cardIdx, matches };
      setMsg(`已放 ${ci.placed} 枚,还需 ${left} 枚:继续点击另一处金色高亮格(Esc 取消)`);
    } else {
      G.cubeMode = null;
      setMsg(left > 1
        ? `「${ci.def.name}」还需 ${left} 枚,但版图上没有第二处完整图案(同一格不能叠两枚方块)`
        : `「${ci.def.name}」还需 ${left} 枚,但当前没有可用匹配`);
    }
  }
  renderAll();
  return true;
}

document.getElementById('btnUndo').onclick = () => {
  if (G.cur !== 0 || !G.undoStack.length || G.over) return;
  const s = G.undoStack.pop();
  const p = G.players[0];
  p.board = s.board;
  p.cards = s.cards;
  p.cubesPlaced = s.cubesPlaced;
  p.sancts = s.sancts || [];
  G.hand = s.hand; G.handSel = s.handSel;
  G.supply = s.supply; G.market = s.market;
  G.tookCard = s.tookCard; G.tookSanct = s.tookSanct || false;
  G.sanctOffer = s.sanctOffer || [];
  G.cubeMode = null;
  setMsg('已撤回上一步');
  renderAll();
};

document.getElementById('btnUndoRound').onclick = () => {
  if (G.cur !== 0 || !G.roundStart || G.over) return;
  const s = G.roundStart;
  const p = G.players[0];
  p.board = s.board;
  p.cards = s.cards;
  p.cubesPlaced = s.cubesPlaced;
  p.sancts = s.sancts || [];
  G.hand = s.hand; G.handSel = s.handSel;
  G.supply = s.supply; G.market = s.market;
  G.tookCard = s.tookCard; G.tookSanct = s.tookSanct || false;
  G.sanctOffer = s.sanctOffer || [];
  G.undoStack = s.undoStack; // 恢复本回合开始时的 undo 栈
  G.cubePlacedThisTurn = s.cubePlacedThisTurn || false;
  G.cubeMode = null;
  setMsg('已撤回至回合开始');
  renderAll();
};

document.getElementById('btnEnd').onclick = () => {
  if (G.cur !== 0 || G.over) return;
  const stuck = G.hand.filter(h => !h.placed && !hasAnyPlacement(G.players[0].board, h.type, G.players[0]));
  const unplaced = G.hand.filter(h => !h.placed);
  if (unplaced.length && stuck.length !== unplaced.length) { setMsg('必须放完手上所有标记'); return; }
  if (stuck.length) log(`你有 ${stuck.length} 个标记无处可放,按规则弃置`, 0);
  endTurn();
};

/* 回合收尾:补供应区/市场,并检查结束条件(所有 N 人共用) */
function concludeTurn() {
  const p = G.players[G.cur];
  if (G.supply.some(g => g.length === 0)) {
    if (G.pouch.length < 3) { if (!G.endTriggered) { G.endTriggered = true; log('袋中标记不足,触发游戏结束!'); } }
    else for (let i = 0; i < 5; i++) if (!G.supply[i].length) G.supply[i] = drawTokens(3);
  }
  while (G.market.length < 5 && G.deck.length) G.market.push(G.deck.pop());
  // 官方规则:回合结束时,若本回合拿过保护区板块,用抽取堆顶补足到 3 个可见
  if (G.tookSanct) while (G.sanctOffer.length < 3 && G.sanctDeck.length) G.sanctOffer.push(G.sanctDeck.shift());
  const empty = Object.values(p.board).filter(c => c.stack.length === 0 && !c.cube && !c.spirit).length;
  if (empty <= 2 && !G.endTriggered) { G.endTriggered = true; log(`${p.name}的版图只剩 ${empty} 格,触发游戏结束!`, G.cur); }
}

/* 交棒给下一位:轮转 N 人,回到本轮先手则进入下一轮 */
function advanceTurn() {
  G.hand = []; G.handSel = -1; G.tookCard = false; G.cubeMode = null;
  G.tookSanct = false;
  G.undoStack = []; G.cubePlacedThisTurn = false;
  G.cur = (G.cur + 1) % G.n;
  const newRound = G.cur === G.first;
  if (newRound) G.round++;
  // 每次轮到玩家 0 都刷新「本回合开始」快照。
  // 之前只在开局 beginTurn() 存过一次,导致第 2 回合起「撤回至回合开始」会一路退回游戏开始。
  if (G.cur === 0 && !G.over) saveRoundStart();
  renderAll();
  // 结束条件已触发且本轮已走完 → 结算
  if (G.endTriggered && newRound) { gameOver(); return; }
  if (G.cur === 0) setMsg(`第 ${G.round} 轮 · 你的回合:点击供应区取一组标记`);
  else { setMsg(`${G.players[G.cur].name} 思考中…`); aiTurn(); }
}

function endTurn() { concludeTurn(); advanceTurn(); }
