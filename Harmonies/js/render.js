
/* ============================================================
 * 渲染
 * ============================================================ */
const HEX = 38, LAY = 9;
/* B 面底图整体显示：按画布中心缩到 90% 并居中，避免上下/左右裁切。
   格子绘制与点击检测同步用这一变换，保证不脱格。 */
const BOARD_VIEW = { B: { k: 0.918, dx: -14.0, dy: 56.0 } };
// 平顶六边形坐标:列内序号按各面版图的 rmin 归一,奇数列下移半格
function hexPx(q, r) {
  const s = BOARD_SHAPES[G.side] || BOARD_SHAPES.A;
  if (s.grid) return { x: s.grid.x0 + s.grid.dx * q,
                       y: s.grid.y0 + s.grid.dy * (r + (s.cofs ? (s.cofs[q] || 0) : 0) + (q % 2 ? 0.5 : 0)) };
  const i = r - (s.rmin[q] ?? 0);
  return { x: HEX * 1.5 * q + s.x0, y: HEX * Math.sqrt(3) * (i + (q % 2 ? 0.5 : 0)) + 55 };
}
function drawHexPath(ctx, x, y, s) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i); // 平顶
    const px = x + s * Math.cos(a), py = y + s * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function renderBoard(idx) {
  const p = G.players[idx];
  const cv = document.getElementById('cv' + idx);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  // 官方版图照片作底图:A/B 用仿射变换对齐;C/D 按等比缩放贴合格心坐标
  const bgKey = { A: 'boardA', B: 'boardB', C: 'boardC', D: 'boardD' }[G.side];
  const bg = bgKey ? boardImgs[bgKey] : null;
  if (bg) {
    if (G.side === 'A') {
      ctx.setTransform(0.2330, 0.0020, 0.0011, 0.2441, -28.4, -22.3);
      ctx.drawImage(bg, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else if (G.side === 'B') {
      const v = BOARD_VIEW.B, cx = cv.width / 2, cy = cv.height / 2;
      // 底图矩阵先组合视图缩放，再把整张图居中放进画布
      ctx.setTransform(v.k * 0.2282, v.k * 0.0000,
        v.k * 0.0002, v.k * 0.2317,
        v.k * (-4.6 - cx) + cx + v.dx,
        v.k * (-45.9 - cy) + cy + v.dy);
      ctx.drawImage(bg, 0, 0);
      // 之后所有格子统一按视图变换绘制
      ctx.setTransform(v.k, 0, 0, v.k, cx + v.dx - v.k * cx, cy + v.dy - v.k * cy);
    } else {
      const b = BOARD_SHAPES[G.side].bg;
      ctx.drawImage(bg, 0, b.ty, bg.naturalWidth * b.s, bg.naturalHeight * b.s);
    }
  } else if (G.side === 'B') {
    const v = BOARD_VIEW.B, cx = cv.width / 2, cy = cv.height / 2;
    ctx.setTransform(v.k, 0, 0, v.k, cx + v.dx - v.k * cx, cy + v.dy - v.k * cy);
  }
  const cubeHighlights = (idx === 0 && G.cubeMode) ? new Set(G.cubeMode.matches.map(m => m.anchor)) : null;
  for (const k in p.board) {
    const [q, r] = k.split(',').map(Number);
    const { x, y } = hexPx(q, r);
    const cell = p.board[k];
    // 底格(无底图时绘制;C/D 版图:D 面干旱格用灰色底)
    if (!bg) {
      drawHexPath(ctx, x, y, HEX - 2);
      ctx.fillStyle = cell.dry ? '#3b4148' : '#1d2129'; ctx.fill();
      ctx.strokeStyle = cell.dry ? '#575e66' : '#2e3540'; ctx.lineWidth = 1.2; ctx.stroke();
      if (cell.dry && !cell.stack.length && !cell.cube && !cell.spirit) {
        ctx.fillStyle = '#7d858e'; ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('干', x, y);
      }
    }
    // 标记堆叠(圆片 3D,使用官方图案)
    cell.stack.forEach((t, i) => {
      const yy = y - i * LAY, R = HEX * 0.72;
      ctx.beginPath(); ctx.arc(x, yy, R, 0, Math.PI * 2);
      if (tokImgs[t]) {
        ctx.save(); ctx.clip();
        ctx.drawImage(tokImgs[t], x - R, yy - R, R * 2, R * 2);
        ctx.restore();
        ctx.beginPath(); ctx.arc(x, yy, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.fillStyle = TYPES[t].color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = t === 'field' || t === 'mountain' ? '#222' : 'rgba(255,255,255,.85)';
        ctx.font = `600 ${i === cell.stack.length - 1 ? 12 : 9}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}${TYPES[t].short}`, x, yy);
      }
    });
    const topY = cell.stack.length ? y - (cell.stack.length - 1) * LAY : y;
    // 得分方块标记:动物 = 橙色、自然之灵 = 白色(与动物区分)、精灵 = 紫色,
    // 同格两者都有则各画一个;一律居中放在最上层地形标记(或空格格心)的正中央
    const marks = [];
    if (cell.spirit) marks.push({ fill: '#a35ce0', edge: '#6b35b5' });  // 精灵:紫
    if (cell.cube) marks.push(isSpiritCube(cell.cube)
      ? { fill: '#f7f9fc', edge: '#414a58', inner: '#8a6ad4' }         // 自然之灵:白 + 紫色菱形
      : { fill: '#f39c3d', edge: '#b9681a' });                        // 动物:橙
    if (marks.length) {
      const S = 15, gap = 3;
      const total = marks.length * S + (marks.length - 1) * gap;
      marks.forEach((m, i) => {
        const sx = x - total / 2 + i * (S + gap);
        ctx.fillStyle = m.fill;
        ctx.fillRect(sx, topY - S / 2, S, S);
        ctx.strokeStyle = m.edge; ctx.lineWidth = m.inner ? 2 : 1.5;
        ctx.strokeRect(sx, topY - S / 2, S, S);
        if (m.inner) {
          const cx = sx + S / 2, cy = topY, d = 3.6;
          ctx.beginPath();
          ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy);
          ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d, cy); ctx.closePath();
          ctx.fillStyle = m.inner; ctx.fill();
        }
      });
    }
    // 放置高亮
    if (idx === 0 && G.handSel >= 0 && G.hand[G.handSel] && !G.hand[G.handSel].placed) {
      if (canPlace(p.board, k, G.hand[G.handSel].type, p)) {
        drawHexPath(ctx, x, y - (cell.stack.length ? (cell.stack.length - 1) * LAY : 0), HEX - 5);
        ctx.fillStyle = 'rgba(127,176,105,.18)'; ctx.fill();
        ctx.strokeStyle = 'rgba(127,176,105,.75)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    // 方块放置高亮
    if (cubeHighlights && cubeHighlights.has(k)) {
      drawHexPath(ctx, x, y - (cell.stack.length ? (cell.stack.length - 1) * LAY : 0), HEX - 5);
      ctx.fillStyle = 'rgba(212,168,83,.25)'; ctx.fill();
      ctx.strokeStyle = '#d4a853'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }
  if (G.side === 'B') ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function tokEl(type, cls = '') {
  const d = document.createElement('div');
  d.className = `tok ${type} ${cls}`; d.textContent = TYPES[type].short; d.title = TYPES[type].name;
  return d;
}

function renderSupply() {
  const el = document.getElementById('supply'); el.innerHTML = '';
  G.supply.forEach((grp, gi) => {
    const g = document.createElement('div');
    g.className = 'supply-group' + (grp.length === 0 ? ' empty' : '');
    grp.forEach(t => g.appendChild(tokEl(t)));
    if (grp.length === 0) g.innerHTML = '<span style="color:var(--muted);font-size:.7rem;padding:0 8px">已取走</span>';
    else if (G.cur === 0 && !G.over && G.hand.length === 0) g.onclick = () => takeGroup(gi);
    el.appendChild(g);
  });
}

function renderHand() {
  const el = document.getElementById('hand'); el.innerHTML = '';
  if (!G.hand.length) { el.innerHTML = '<span style="color:var(--muted);font-size:.75rem">尚未取标记</span>'; return; }
  G.hand.forEach((h, i) => {
    const noSpot = !h.placed && G.players.length && !hasAnyPlacement(G.players[0].board, h.type, G.players[0]);
    const t = tokEl(h.type, (h.placed ? 'placed ' : '') + (G.handSel === i ? 'selected' : '') + (noSpot ? 'placed' : ''));
    if (noSpot) t.title = TYPES[h.type].name + '(无处可放,结束回合时弃置)';
    else if (!h.placed) t.onclick = () => { G.handSel = i; G.cubeMode = null; renderAll(); };
    el.appendChild(t);
  });
}

function cardHtml(ci, opts = {}) {
  const d = document.createElement('div');
  d.className = 'acard' + (ci.done ? ' done' : '') + (ci.def.spirit ? ' spirit' : '')
    + (ci.def.elf ? ' elf' : '') + (ci.def.pulse ? ' pulse' : '');
  if (opts.cubeMode) d.classList.add('cubemode');
  // 动物/精灵/Pulse 卡一律不显示卡底地形要求(如「1黄+1灰」);
  // 仅自然之灵在开局二选一弹窗保留计分说明 desc(玩家面板仍由 hidePat 隐藏)
  const reqs = (!opts.hidePat && ci.def.spirit) ? ci.def.desc : '';
  const iconHtml = ci.def.img
    ? `<img class="aimg" src="${ci.def.img}" alt="${ci.def.name}" draggable="false" onerror="MGImg.fallback(this)">`
    : `<div class="ic">${ci.def.icon}</div>`;
  // 精灵牌也用与动物牌同尺寸的分数方格(淡紫色,见 .cubeslot.elf-slot),不再显示 2/5 纯文本
  const elfTitle = '紫色精灵方块:只能放在卡面带「*」的锚点格;与动物(橙)方块同格 5 分/格,单独 2 分/格;不能与自然之灵(白)方块同格';
  const cubesDisplay = ci.def.elf
    ? ci.def.cubes.map((v, i) => `<div class="cubeslot elf-slot${i < ci.placed ? ' filled' : ''}" title="${elfTitle}">${v}</div>`).join('')
    : ci.def.spirit ? '★'
    : ci.def.cubes.map((v, i) => `<div class="cubeslot ${i < ci.placed ? 'filled' : ''}">${v}</div>`).join('');
  d.innerHTML = `${iconHtml}<div class="nm">${ci.def.name}</div>
    <div class="cubes">${cubesDisplay}</div>
    ${reqs ? `<div class="pat">${reqs}</div>` : ''}`;
  if (ci.def.elf) d.innerHTML += '<div class="badge card-tag" style="background:#e0c060;color:#321">精灵·同动物5/单独2</div>';
  if (ci.def.spirit) d.innerHTML += '<div class="badge card-tag" style="background:#f2f5fa;color:#313846;border:1px solid #6b7482">灵·白方块</div>';
  if (ci.def.pulse) d.innerHTML += '<div class="badge card-tag pulse-badge" title="本卡图案可镜像对称放置">可镜像对称放置</div>';
  return d;
}
function reqText(req) {
  return { w:'1蓝', f:'1黄', t:'1综', B:'建筑', r:'1红', C:'动物', T1:'1绿', T2:'1综2绿', T3:'1综2综3绿', M1:'1灰', M2:'1灰2灰', M3:'1灰2灰3灰' }[req] || req;
}

function marketCardHtml(def) {
  // 市场动物卡与玩家面板卡牌完全同构(cardHtml):插画 → 名称 → 分数方格 → 图案要求
  const d = cardHtml({ def, placed: 0, done: false });
  d.classList.add('market-card');
  return d;
}
function renderMarket() {
  const el = document.getElementById('market'); el.innerHTML = '';
  const canTake = G.cur === 0 && !G.over && !G.tookCard && activeCardCount(G.players[0]) < 4;
  for (let i = 0; i < 5; i++) {
    const def = G.market[i];
    if (!def) {
      const b = document.createElement('div');
      b.className = 'acard facedown market-card';
      b.innerHTML = `<img class="aimg" src="${webpSrc('Images/ref/card_back_dark.jpg')}" alt="卡背" draggable="false" onerror="MGImg.fallback(this)">`;
      el.appendChild(b);
      continue;
    }
    const d = marketCardHtml(def);
    if (canTake) { d.classList.add('takeable'); d.onclick = () => takeCard(i); }
    else d.style.cursor = 'default';
    el.appendChild(d);
  }
}

function renderPlayerCards() {
  for (let idx = 0; idx < G.n; idx++) {
    const p = G.players[idx];
    const el = document.getElementById('cards' + idx); el.innerHTML = '';
    document.getElementById('cardN' + idx).textContent = activeCardCount(p);
    // 只显示未完成的卡(完成的已移到版图下方的已完成卡牌区)
    p.cards.forEach((ci, i) => {
      if (ci.done) return;
      const d = cardHtml(ci, { cubeMode: idx === 0 && G.cubeMode && G.cubeMode.cardIdx === i, hidePat: true });
      if (idx === 0 && !G.over) {
        d.title = '点击进入放方块模式';
        d.onclick = () => enterCubeMode(i);
      }
      el.appendChild(d);
    });
    // 「暂无」需把未完成保护区也算进去(renderActiveSancts 随后会往同一容器追加板块)
    const hasActive = p.cards.some(c => !c.done) || (G.mods.sanct && (p.sancts || []).some(s => !s.done));
    if (!hasActive) el.innerHTML = '<span style="color:var(--muted);font-size:.7rem">暂无</span>';
  }
}

/* ---- 保护区板块(建设中):公共区 3 张可选 + 个人版图建造 ---- */
function renderSanctOffer() {
  const el = document.getElementById('sanctOffer'); if (!el) return;
  if (!G.mods.sanct) { el.parentElement.style.display = 'none'; return; }
  el.parentElement.style.display = '';
  el.innerHTML = '';
  const canTake = G.cur === 0 && !G.over && !G.tookSanct && activeCardCount(G.players[0]) < 4;
  G.sanctOffer.forEach(def => {
    const d = document.createElement('div');
    d.className = 'acard sanct';
    d.innerHTML = `<img class="aimg" src="${def.imgA}" alt="${def.name}建设中" draggable="false" onerror="MGImg.fallback(this)">
      <div class="nm">${def.name}</div>
      <div class="layers" title="按此 4 层顺序(下→上)在 1 格堆叠,可突破一般放置规则">
        ${def.layers.map(t => `<i style="background:${TYPES[t].color}" title="${TYPES[t].name}"></i>`).join('')}
      </div>
      <div class="badge" style="background:#3f6f8f;color:#fff">建设中</div>`;
    if (canTake) { d.classList.add('takeable'); d.onclick = () => takeSanct(def); }
    else d.style.cursor = 'default';
    el.appendChild(d);
  });
  if (!G.sanctOffer.length) el.innerHTML = '<span style="color:var(--muted);font-size:.7rem">保护区板块已全部取完</span>';
}
function takeSanct(def) {
  // 官方规则:拿保护区板块是独立的可选行动,与拿动物卡/精灵卡分开算(各每回合 1 次)
  if (G.cur !== 0 || G.tookSanct || G.over) return;
  const p = G.players[0];
  if (activeCardCount(p) >= 4) return; // 板块视作卡牌,仍与动物卡共享 4 张上限
  pushUndo();
  G.sanctOffer.splice(G.sanctOffer.indexOf(def), 1);
  p.sancts.push({ def, layer: 0, done: false, pos: null, site: null });
  G.tookSanct = true;
  log(`你拿了保护区板块 <b>${def.name}</b>(按此牌面4层样式放置标记可突破一般规则)`, 0);
  setMsg(`已拿「${def.name}」:按牌面 4 层样式在「同一个格子」堆叠可突破一般放置规则(该板块不能同时在多个格子建造),完成即翻面计分`);
  renderAll();
}
/* 已完成区(版图下方):已完成的动物卡 / 精灵卡 / 自然之灵
   (含「最后 1 个方块放到已完成保护区上」而直接完成的动物卡) + 已完成的保护区板块。
   注意:这里是「保护区板块」,与旧版已删除的「圣所」机制无关。 */
function renderDoneCards() {
  for (let idx = 0; idx < G.n; idx++) {
    const p = G.players[idx];
    const doneEl = document.getElementById('doneCards' + idx);
    if (!doneEl) continue;
    const doneCards = (p.cards || []).filter(ci => ci.done);
    const doneSancts = G.mods.sanct ? (p.sancts || []).filter(s => s.done) : [];
    doneEl.parentElement.style.display = (doneCards.length || doneSancts.length) ? '' : 'none';
    doneEl.innerHTML = '';
    doneCards.forEach(ci => doneEl.appendChild(cardHtml(ci, { hidePat: true })));
    doneSancts.forEach(s => {
      const d = document.createElement('div');
      d.className = 'acard sanct done';
      d.innerHTML = `<img class="aimg" src="${s.def.imgB}" alt="${s.def.name}" draggable="false" onerror="MGImg.fallback(this)">
        <div class="nm">${s.def.name}</div>
        <div class="badge" style="background:#2f7f5a;color:#fff">完成</div>`;
      doneEl.appendChild(d);
    });
  }
}
// 未完成保护区:渲染到 cards 区域内(和动物卡一起,占 4 张上限)
function renderActiveSancts() {
  for (let idx = 0; idx < G.n; idx++) {
    const p = G.players[idx];
    // 找到 cards 容器,追加未完成保护区
    const cardsEl = document.getElementById('cards' + idx); if (!cardsEl) continue;
    // 先清除之前追加的 sanct 元素
    cardsEl.querySelectorAll('.acard.sanct-active').forEach(e => e.remove());
    if (!G.mods.sanct) continue;
    (p.sancts || []).forEach((s, i) => {
      if (s.done) return;
      const d = document.createElement('div');
      d.className = 'acard sanct-active';
      d.innerHTML = `<img class="aimg" src="${s.def.imgA}" alt="${s.def.name}" draggable="false" onerror="MGImg.fallback(this)">
        <div class="nm">${s.def.name}${s.site ? ` · 建造中 ${s.site}` : ''}</div>
        <div class="badge" style="background:${s.site ? '#2f7f5a' : '#8a7a3f'};color:#fff">${s.def.layers.map(ty=>TYPES[ty].short).join('→')}</div>`;
      d.title = `按此4层样式(下→上)放置标记可突破一般规则,堆叠匹配即完成。${s.site ? `已锁定在格 ${s.site} 建造,同一板块不能同时在多个格子突破规则` : '每个板块只能同时在一个格子建造'}`;
      cardsEl.appendChild(d);
    });
  }
}
/* 图案锚点需求 → 地形颜色(用于动物卡最后 1 方块能否放保护区) */
function reqColor(pr) {
  if (!pr) return null;
  return { w:'water', f:'field', t:'trunk', B:'building', r:'building', T1:'tree', T2:'tree', T3:'tree', M1:'mountain', M2:'mountain', M3:'mountain' }[pr.req] || null;
}

function renderStats() {
  // 袋中标记:按颜色分组显示数量,并给出总量
  const counts = {};
  for (const t of G.pouch) counts[t] = (counts[t] || 0) + 1;
  let ph = '';
  for (const t of ['water', 'mountain', 'trunk', 'tree', 'field', 'building'])
    ph += `<span class="pouch-dot" style="background:${TYPES[t].color}" title="${TYPES[t].name}"></span>${counts[t] || 0}`;
  document.getElementById('pouchN').innerHTML = ph + `<span style="margin-left:7px">共 ${G.pouch.length}</span>`;
  document.getElementById('deckN').textContent = G.deck.length;
  document.getElementById('roundN').textContent = G.round;
  document.getElementById('sideN').textContent = G.side;
  // 先手标注
  const hasP = G.players.length > 0;
  document.getElementById('firstN').textContent = hasP ? (G.players[G.first].isAI ? G.players[G.first].name : '你') : '-';
  document.getElementById('modN').textContent =
    ['Pulse', G.mods.spirit && '自然之灵', G.mods.cres && 'Crescendo(精灵)', G.mods.sanct && '保护区'].filter(Boolean).join(' · ');
  // 各玩家:地形 / 动物 / 自然之灵 / 精灵 / 保护区分开显示
  for (let i = 0; i < G.n; i++) {
    const s = scoreBoard(G.players[i]);
    const terrPts = s.tree + s.mountain + s.field + s.building + s.water;
    document.getElementById('terr' + i).textContent = terrPts;
    document.getElementById('ani' + i).textContent = s.animal || 0;
    document.getElementById('spi' + i).textContent = s.spirit || 0;
    document.getElementById('elf' + i).textContent = s.elf || 0;
    document.getElementById('sanctPts' + i).textContent = s.sanctPts || 0;
    document.getElementById('pts' + i).textContent = s.total;
    document.getElementById('firstTag' + i).textContent = hasP && G.first === i ? '先手' : '';
  }
  const myTurn = G.cur === 0 && !G.over;
  const stuck = G.hand.length > 0 && G.hand.every(h => h.placed || !hasAnyPlacement(G.players[0].board, h.type, G.players[0]));
  document.getElementById('btnEnd').disabled = !myTurn || G.hand.length === 0 || (G.hand.some(h => !h.placed) && !stuck);
  document.getElementById('btnUndo').disabled = !myTurn || !G.undoStack.length;
  document.getElementById('btnUndoRound').disabled = !myTurn || !G.roundStart;
}

function renderAll() {
  renderSupply(); renderHand(); renderMarket(); renderPlayerCards(); renderSanctOffer(); renderDoneCards(); renderActiveSancts(); renderStats();
  for (let i = 0; i < G.n; i++) renderBoard(i);
}
