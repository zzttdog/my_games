/* ============================================================
 * 游戏状态
 * ============================================================ */
const G = {
  side: 'A', mods: { pulse: true, spirit: false, cres: false, sanct: false }, n: 2,
  pouch: [], supply: [], deck: [], market: [],
  players: [], cur: 0, round: 1, first: 0, firstChoice: 'rand',
  hand: [], handSel: -1, tookCard: false, cubeMode: null,
  tookSanct: false, sanctDeck: [], sanctOffer: [],   // 保护区板块(非「圣所」)
  endTriggered: false, over: false, undoStack: [], roundStart: null, cubePlacedThisTurn: false,
};

function newPlayer(name, isAI) {
  const board = {};
  for (const c of boardCells(G.side)) board[key(c.q, c.r)] = { stack: [], cube: null };
  if (G.side === 'D') for (const k of (BOARD_SHAPES.D.dry || [])) if (board[k]) board[k].dry = true;
  return { name, isAI, board, cards: [], spirit: null, cubesPlaced: 0, sancts: [] };
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function setup() {
  G.pouch = shuffle(Object.entries(POUCH_DEF).flatMap(([t, n]) => Array(n).fill(t)));
  G.supply = Array.from({ length: 5 }, () => drawTokens(3));
  let pool = BASE_CARDS.slice();
  if (G.mods.pulse) pool = pool.concat(PULSE_CARDS);
  if (G.mods.cres) pool = pool.concat(ELF_CARDS);
  G.deck = shuffle(pool.map((c, i) => ({ ...c, id: 'c' + i })));
  // 保护区板块:混洗成堆,展示 3 个(建设中面)供选择;拿取后回合结束补足保持 3 个可见
  G.sanctDeck = G.mods.sanct ? shuffle(SANCT_CARDS.map((c, i) => ({ ...c, id: 'q' + i }))) : [];
  G.sanctOffer = G.sanctDeck.splice(0, 3);
  G.market = G.deck.splice(0, 5);
  G.players = [newPlayer('你', false)];
  for (let i = 1; i < G.n; i++) G.players.push(newPlayer('AI' + i, true));
  // 先手:你先手 / AI先手 / 随机抽签(N 人随机取一位)
  G.first = G.firstChoice === 'me' ? 0 : G.firstChoice === 'ai' ? 1 : Math.floor(Math.random() * G.n);
  G.cur = G.first; G.round = 1; G.hand = []; G.handSel = -1; G.tookCard = false;
  G.cubeMode = null; G.endTriggered = false; G.over = false; G.undoStack = []; G.roundStart = null; G.cubePlacedThisTurn = false;
  G.tookSanct = false;
  buildBoards();
  renderGameAid();
  document.getElementById('log').innerHTML = '';
  log(`游戏开始 · ${G.n} 人 · 版图 ${G.side} 面`);
  log(`先手:${G.players[G.first].isAI ? G.players[G.first].name : '你'}${G.firstChoice === 'rand' ? '（随机抽签）' : ''}`);
  // 自然之灵
  if (G.mods.spirit) {
    const sp = shuffle(SPIRIT_CARDS.map((c, i) => ({ ...c, id: 's' + i })));
    offerSpiritChoice(sp[0], sp[1]);
    for (let i = 1, k = 2; i < G.n; i++, k++) {
      const pick = sp[k] || sp[k % sp.length];
      G.players[i].spirit = pick; G.players[i].cards.push(mkCardInst(pick));
      log(`${G.players[i].name} 选择了自然之灵「${pick.name}」`, i);
    }
  }
  // 自然之灵需玩家先 2 选 1,选完再开回合;否则直接开回合
  if (G.mods.spirit) renderAll(); else beginTurn();
}

/* 开始当前行动方的回合(AI 先手时自动跑 AI) */
function saveRoundStart() {
  const p = G.players[0];
  G.roundStart = {
    board: JSON.parse(JSON.stringify(p.board)),
    cards: p.cards.map(c => ({ def: c.def, placed: c.placed, done: c.done, elfLeft: c.elfLeft })),
    cubesPlaced: p.cubesPlaced,
    sancts: (p.sancts || []).map(s => ({ def: s.def, layer: s.layer, done: s.done, pos: s.pos, site: s.site || null })),
    hand: JSON.parse(JSON.stringify(G.hand)),
    handSel: G.handSel,
    supply: G.supply.map(g => g.slice()),
    market: G.market.slice(),
    tookCard: G.tookCard,
    tookSanct: G.tookSanct || false,
    sanctOffer: G.sanctOffer.slice(),
    undoStack: G.undoStack.slice(),
    cubePlacedThisTurn: G.cubePlacedThisTurn,
  };
}
function beginTurn() {
  // 先存快照再渲染:renderStats 会依据 G.roundStart 决定「撤回至回合开始」是否可用
  if (G.cur === 0) saveRoundStart();
  renderAll();
  if (G.cur !== 0) { setMsg(`${G.players[G.cur].name} 先手 · 思考中…`); aiTurn(); }
  else setMsg(`第 ${G.round} 轮 · 你的回合:点击供应区取一组标记`);
}

/* 按人数动态生成 N 个版图面板(canvas 用 CSS 缩放适配列宽) */
function buildBoards() {
  const wrap = document.getElementById('boards');
  wrap.className = 'boards' + (G.n >= 3 ? ' n' + G.n : '');
  wrap.innerHTML = '';
  document.getElementById('layout').style.maxWidth = Math.max(1440, 300 + 340 * G.n) + 'px';
  const cw = G.side === 'D' ? 500 : 470; // D 面 8 列更宽,画布加宽(点击按宽高比映射)
  const ch = { A: 390, B: 378, C: 377, D: 403 }[G.side] || 440; // 高度贴合各面底图,去掉上下黑边
  for (let i = 0; i < G.n; i++) {
    const p = G.players[i];
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `
      <div class="board-card">
        <div class="board-title">${p.name}<span class="firstTag" id="firstTag${i}"></span> · 地形 <span class="pts" id="terr${i}">0</span> + 动物 <span class="pts" id="ani${i}">0</span> + 自然之灵 <span class="pts" id="spi${i}">0</span> + 精灵 <span class="pts" id="elf${i}">0</span> + 保护区 <span class="pts" id="sanctPts${i}">0</span> = <span class="pts" id="pts${i}">0</span></div>
        <div class="card">
          <h3>${p.name}的卡牌(<span id="cardN${i}">0</span>/4)${i === 0 ? ' · 点击卡片进入放方块模式' : ''}</h3>
          <div class="card-row" id="cards${i}"></div>
        </div>
        <canvas id="cv${i}" width="${cw}" height="${ch}" class="${i === 0 ? 'mine' : ''} side-${G.side}"></canvas>
        <div class="ai-thinking" id="think${i}"></div>
        <div class="card" style="display:none">
          <h3>${p.name}的已完成卡牌</h3>
          <div class="card-row done-row" id="doneCards${i}"></div>
        </div>
      </div>`;
    wrap.appendChild(col);
    if (i === 0) col.querySelector('#cv0').addEventListener('click', onBoardClick);
  }
}

function mkCardInst(def) { return { def, placed: 0, done: false }; }
function drawTokens(n) { const out = []; for (let i = 0; i < n && G.pouch.length; i++) out.push(G.pouch.pop()); return out; }
