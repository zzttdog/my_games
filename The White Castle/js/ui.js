/* 姬路城 The White Castle —— UI 层（棋盘叠在版图实拍上）
   - 主板图作为底层，骰子按版图上的真实骰位绝对定位
   - 玩家面板换成个人领地图，队列骰子叠在图上
   - 全量重绘 + 事件委托；pending 弹窗；AI 自动驱动 */
(function () {
  'use strict';
  const D = window.WCData, E = window.WCEngine, A = window.WCAI;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* 静态 Pages 没有 Node 的 Accept 协商：卡图显式请求「原名.webp」，失败回退原图。 */
  const assetSrc = (file) => (window.MGImg && MGImg.webp) ? MGImg.webp(file) : file;
  const fallbackAttr = (window.MGImg && MGImg.fallback) ? ' onerror="MGImg.fallback(this)"' : '';

  const S = { g: null, opts: { players: 2, seat: 0, diff: 'normal' }, cards: [] };

  /* ── 美术工具 ─────────────────────────────────────────── */
  /* 卡图裁切：castle-a/b 的配对图只取一半；房间卡只取上半（下半是灰色剪影装饰） */
  const POS = { left: 'left center', right: 'right center', top: 'top center' };
  const imgThumb = (file, cls, clip, tip) => file
    ? `<img class="art-thumb file ${cls || ''}" src="assets/${assetSrc(file)}" alt=""${tip ? ` title="${esc(tip)}"` : ''}${fallbackAttr} style="object-fit:cover;object-position:${POS[clip] || 'center'}">`
    : '';
  /* 版图上的卡图：整张卡铺满卡位，中文信息只放在 title（悬浮）里 */
  const cardImg = (file, cls, tip) => file
    ? `<img class="bcard ${cls || ''}" src="assets/${assetSrc(file)}" alt=""${tip ? ` title="${esc(tip)}"` : ''}${fallbackAttr}>`
    : `<span class="bcard noimg"${tip ? ` title="${esc(tip)}"` : ''}></span>`;
  const courtThumb = (card, tip) => card && card.imgFile ? cardImg(card.imgFile, '', tip) : `<span class="bcard noimg"${tip ? ` title="${esc(tip)}"` : ''}></span>`;

  /* 悬浮信息统一格式：编号 + 背面效果（卡面本身不写中文） */
  const cardTooltip = (card, backText) => {
    const id = (card && (card.defId || card.id)) || '';
    const back = backText ? String(backText).trim() : '';
    if (!id) return '';
    return back ? `编号 ${id}｜背面：${back}` : `编号 ${id}`;
  };
  /* 把效果 DSL 描述成一行中文（仅用于 title） */
  const fxText = (list) => {
    if (!Array.isArray(list) || !list.length) return '';
    try { return E.describeEffects(list); } catch (e) { return ''; }
  };

  const pct = (v) => (v * 100).toFixed(3) + '%';

  /* ── 提示条：选完地点后把「要执行的效果」飘一下 ──────────────
     引擎在 resolvePlace 的 finish() 里把这一手的效果写进 g.lastFx，
     这里只负责显示（同一个 seq 只飘一次）。 */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  let lastFxSeq = 0;
  function flushToast(g) {
    if (!g || !g.lastFx || !g.lastFx.text) return;
    if (g.lastFx.seq === lastFxSeq) return;
    lastFxSeq = g.lastFx.seq;
    toast(g.lastFx.text);
  }

  function dieHtml(die, cls, extra) {
    const owner = die.owner != null && S.g ? S.g.players[die.owner].color.hex : 'transparent';
    return `<div class="die c-${die.color} ${cls || ''}" style="--owner:${owner}" ${extra || ''}>${die.value}</div>`;
  }
  const tokDots = (players) => players.map((p) => `<span class="tok" style="background:${p.color.hex}" title="${esc(p.name)}"></span>`).join('');

  /* ── 卡牌渲染：只看 cardInstance.side，不用 DOM class 反推状态 ── */
  /* 通用卡牌实例：界面上不写中文，只用图案区分正/反面；
     卡牌编号与背面效果放在 title 里，鼠标悬浮可见 */
  function renderCard(card) {
    const def = D.getCardDef(card.defId);
    if (!def) return '';
    const front = card.side === 'front';
    const backEff = front ? (def && (def.blue || def.lightActions)) : (def && (def.yellow || def.darkActions && def.darkActions.any));
    const tip = cardTooltip(card, fxText(backEff));
    return `<div class="gcard ${front ? 'front' : 'back'}" data-card="${card.uid}" data-side="${card.side}" title="${esc(tip)}"></div>`;
  }

  /* 痛点 2 阶段只放一张示例卡；痛点 3 会由 selectCard 真正创建实例 */
  function ensureDemoCard() { /* 旧卡牌流程已删除，保留空实现 */ }

  /* ── 取/放合法集 ─────────────────────────────────────── */
  function cmdSets(g) {
    const cmds = E.legalCommands(g);
    const take = {}, place = {}, exchange = [];
    let canUndo = false;
    for (const c of cmds) {
      if (c.type === 'takeDie') take[c.bridge + ':' + c.side] = c;
      else if (c.type === 'placeDie') place[c.slot] = c;
      else if (c.type === 'exchange') exchange.push(c);
      else if (c.type === 'undo') canUndo = true;
    }
    return { cmds, take, place, exchange, canUndo, canRewind: !!(E.canUndoTurn && E.canUndoTurn(g)) };
  }
  const isHumanTurn = (g) => {
    if (!g || g.phase === 'gameEnd') return false;
    const p = g.pending ? g.players[g.pending.playerId] : (g.phase === 'play' ? E.currentPlayer(g) : null);
    return p && !p.isAI;
  };

  /* ── 渲染主入口 ───────────────────────────────────────── */
  function render() {
    const g = S.g;
    if (!g) return;
    ensureDemoCard();
    renderStatus(g);
    renderBoard(g);
    renderPlayers(g);
    renderLog(g);
    renderPending(g);
    if (g.phase === 'gameEnd') renderGameEnd(g);
    flushToast(g);
  }

  function renderStatus(g) {
    const p = g.phase === 'play' || g.phase === 'roundEnd' ? E.currentPlayer(g) : null;
    const phaseName = { draft: '开局选卡', play: '对局', roundEnd: '轮末结算', gameEnd: '终局' }[g.phase];
    let hint = '';
      if (g.phase === 'play' && p && !p.isAI) hint = g.inHand ? `手中 ${g.inHand.die.value} 点骰：点击版图发光处放置（黑标签写的就是能拿到的效果）` : '点击桥上的骰子（左端＝最小骰，取走时先结算个人领地灯笼区）';
    $('#status').innerHTML = `
      <span class="pill">第 <b>${g.round}</b> / ${D.SETUP.rounds} 轮</span>
      <span class="pill">${phaseName}</span>
      ${p ? `<span class="pill turn">行动：<b>${esc(p.name)}</b></span>` : ''}
      <span class="hintline">${esc(hint)}</span>`;
  }

  /* ── 版图叠层 ─────────────────────────────────────────── */
  function renderBoard(g) {
    const cs = cmdSets(g);
    const canAct = isHumanTurn(g) && !g.pending && !g.inHand;
    const canPlace = isHumanTurn(g) && !g.pending && !!g.inHand;
    const canEnd = isHumanTurn(g) && g.awaitEnd && !g.pending;
    const B = D.BOARD_ART.base;

    /* ══ 放置骰子时的「可放置高亮 + 黑色位置标签」══════════════════════
       你在版图上看到的那一圈虚线黄框 + 底下黑底黄边的小字，就是这里产出的。

       ① 哪些格子会亮
          canPlace = 人类玩家回合 && 手里有骰 && 没有待决弹窗；
          再 && 引擎给的 cs.place[id]（cs 来自 cmdSets(g) → E.legalCommands(g)
          → engine.js 的 placeTargets()）。所以「谁能放、放哪」全部由引擎决定，
          UI 只负责把能放的画成可点。

       ② 黑框里的文字从哪来
          hint = cs.place[id].label  ← engine.js placeTargets() 里 tryPush 的第 3 个参数。
          ★ 现在写的是【这一步能拿到的效果】（如「+2食物，+1红扇」），不是地点名。
          想改文案去 engine.js 的 placeTargets / describeEffects，不要在这里硬编码。
          id 只是内部标识（'room:r1' / 'wall:0' / 'well' / 'domain:coral'），不显示。

       ③ 黑框长什么样（背景色、边框、字号、位置）
          css/style.css → 搜 `.bslot.hot::before`（黑色标签本体）
                         搜 `.bslot.hot::after` （那圈闪烁的黄色虚线）
                         搜 `.bslot.hot:hover` （鼠标悬停变亮）
          标签定位是 `bottom: .35cqw`（贴在格子下沿），想挪到格子上方就改这一行。

       ④ 点击后发生什么
          属性 data-place="<id>" → 全局点击委托里 E.apply(g, {type:'placeDie', slot:id})。 */
    /* ★ 放骰时的「可放置高亮 + 黑色效果标签」就是下面这个函数生成的。
       ① 每个会亮的格子 = .bslot.hot（仅当 canPlace 且 cs.place[id] 存在时才加 hot）；
       ② 黑标签上的文字 = cs.place[id].label，来自 engine.js placeTargets() 里 tryPush 的第 3 个参数
          （现在写的是「这一步能拿到的效果」，如「+2食物，+1红扇」）。要改文字去 engine.js / data.js。
       ③ 黑框(黑底黄边小字) 与 黄色虚线框 的【外观】全部在 css/style.css 第 07 段 .bslot.hot
          （::before = 黑标签本体；::after = 闪烁黄虚线）。想换颜色/位置/字号/改到格子上方，改那里。 */
    const hotSlot = (id, xy, cls, inner) => {
      const hot = canPlace && cs.place[id];
      const hint = hot ? (cs.place[id].label || id) : '';
      return `<div class="bslot ${cls || ''}${hot ? ' hot' : ''}" style="left:${pct(xy[0])};top:${pct(xy[1])}"${hot ? ` data-place="${id}" data-hint="${esc(hint)}"` : ''}>${inner || ''}</div>`;
    };
    const diceRow = (slot, cls) => (slot && slot.dice || []).map((d) => dieHtml(d, cls || 'sm')).join('');

    /* —— 桥上的骰子：只能从落点 1（左/灯笼）或落点 5（右）取 ——
       5 个固定落点 1..5（左→右），每颗骰记 d.pos。取走落点 1 后，除 5 外最靠近 1 的
       补到 1、其余不动；取走落点 5 后，除 1 外最靠近 5 的补到 5、其余不动
       （定向补位，非整串紧凑、非按数量均分）。坐标 = (pos-1)/4 映射到固定落点。 */
    const bridgeDice = (bid, geo) => {
      const br = g.bridges[bid] || {};
      const dice = br.dice || [];
      return dice.map((d) => {
        const t = (d.pos - 1) / 4;                      // 5 个落点 1..5 → 0..1
        const x = geo.x0 + (geo.x1 - geo.x0) * t;
        const side = d.pos === 1 ? 'left' : (d.pos === 5 ? 'right' : null);
        const pick = canAct && side && cs.take[bid + ':' + side];
        return `<div class="bslot bdie${pick ? ' pickable' : ''}" style="left:${pct(x)};top:${pct(geo.y)}"${pick ? ` data-take="${bid}:${side}"` : ''}>
          ${dieHtml(d, 'bsm')}${d.pos === 1 ? '<span class="lantern-mark">灯</span>' : ''}</div>`;
      }).join('');
    };

    let base = '';
    /* 每层剩余城郊卡：卡背堆放在该层最左骰位的左侧，悬停显示张数 */
    if (g.outskirts && g.outskirts.decks) {
      const DK = [
        { key: 'a', x: 29.5, y: 74.5, label: '地头层', back: 'back-orange-coin.jpg' },
        { key: 'b', x: 33.5, y: 54.0, label: '使节层', back: 'back-blue-fan.jpg' }
      ];
      for (const d of DK) {
        const n = (g.outskirts.decks[d.key] || []).length;
        base += '<div class="outdeck' + (n ? '' : ' empty') + '" style="left:' + pct(d.x / 100) + ';top:' + pct(d.y / 100) + '" title="' + d.label + '剩余城郊卡 ' + n + ' 张">' +
          '<img src="assets/cards/cut/_backs/' + assetSrc(d.back) + '" alt=""' + fallbackAttr + '>' +
          '<b>' + n + '</b></div>';
      }
    }
    /* 桥上骰子 */
    for (const bid of ['coral', 'black', 'white']) if (g.bridges[bid]) base += bridgeDice(bid, B.bridges[bid]);

    for (const r of g.castle.rooms) {
      const geo = B.rooms[r.def.id]; if (!geo) continue;
      const c = r.card;
      if (geo.die) base += hotSlot('room:' + r.def.id, geo.die, 'die-slot', `<div class="dice-stack">${diceRow(r)}</div>`);
      if (geo.marks && geo.mk) {
        geo.marks.forEach((mid, mi) => {
          const m = (D.MARKERS || []).find((x) => x.id === mid);
          const pos = geo.mk[mi];
          if (!m || !pos) return;
          base += `<div class="bslot mk-slot" style="left:${pct(pos[0])};top:${pct(pos[1])}"><img class="mkimg" src="assets/${assetSrc(m.img)}" alt=""${fallbackAttr} title="${esc(m.name)}"></div>`;
        });
      }
      if (!geo.card) continue;
      const tip = c ? cardTooltip({ ...c, defId: c.id }, fxText(c.lightActions)) : '';
      base += hotSlot('room:' + r.def.id, geo.card, 'card-slot room-card' + (c ? '' : ' empty'),
        c ? cardImg(c.imgFile, '', tip) : '<span class="card-empty"></span>');
    }

    /* 墙外 / 水井 */
    g.wall.forEach((s, i) => { base += hotSlot('wall:' + i, B.wall[i], 'die-slot', `<div class="dice-stack">${diceRow(s)}</div>`); });
    base += hotSlot('well', B.well, 'die-slot', `<div class="dice-stack">${diceRow(g.well)}</div>`);

    /* 庭院卡 6 格：卡图落在卡位；园丁棋子单独排在卡位正下方 */
    g.courtyard.slots.forEach((s, i) => {
      const xy = B.courtyard.cards[i], card = s.card;
      if (!xy || !card) return;
      const owners = [];
      for (const p of g.players) {
        const n = p.gardeners.filter((x) => x.cardId === card.id).length;
        for (let k = 0; k < n; k++) owners.push(p);
      }
      
      const tip = cardTooltip({ ...card, defId: card.id });
      base += `<div class="bslot card-slot cy-card" style="left:${pct(xy[0])};top:${pct(xy[1])}">${courtThumb(card, tip)}</div>`;
      base += `<div class="bslot piece-row" style="left:${pct(xy[0])};top:${pct(xy[1] + B.courtyard.pieceDy)}">${tokDots(owners)}</div>`;
    });

    /* 城郊卡 5 格：只显示卡图。★ 城郊卡【不能放骰】（2026-10-31 晚改回），
       卡位也不做成可点高亮（引擎的 placeTargets 已不含 outskirts）。 */
    g.outskirts.slots.forEach((s, i) => {
      const geo = B.outskirts[i]; if (!geo) return;
      const c = s.card;
      const tip = c ? cardTooltip({ ...c, defId: c.id }, fxText(c.blue)) : '';
      base += `<div class="bslot card-slot out-card" style="left:${pct(geo.card[0])};top:${pct(geo.card[1])}">${c ? cardImg(c.imgFile, '', tip) : '<span class="card-empty"></span>'}</div>`;
    });

    /* 训练场 3 区域：板块落卡位，武士棋子落面板下方奖励行 */
    for (const area of g.training.areas) {
      const geo = B.training[area.def.id]; if (!geo) continue;
      const owners = [];
      for (const p of g.players) {
        /* ★ 棋子按【派遣次数】画：一次派遣 = 1 个武士 = 1 个圆点，落在对应训练区。
           以前用 area.tiles.filter(t => samuraiTiles.includes(t.tile.id)) 统计，
           那是布尔包含判断：板块留在训练场不移除，同一区域反复派遣时被去重，
           最多只显示「该区板块数」个圆点（放 4 个武士只显示 2 个）——已改。
           旧快照没有 samuraiAreas 时，回退用铁成本反推区域（c13=5 / c14=3 / c15=1）。 */
        let n;
        if (p.samuraiAreas) n = p.samuraiAreas.filter((id) => id === area.def.id).length;
        else if (p.samuraiDispatch) n = p.samuraiDispatch.filter((c) => c === area.def.costIron).length;
        else n = area.tiles.filter((t) => p.samuraiTiles.includes(t.tile.id)).length;  // 最旧快照兜底
        for (let k = 0; k < n; k++) owners.push(p);
      }

      const tiles = area.tiles.map((t) => {
        const eff = t.side === 'blue' ? t.tile.blue : t.tile.yellow;
        return `<span class="tr-tile" title="${esc(cardTooltip({ id: t.tile.id }, fxText(eff)))}">${imgThumb(t.tile.imgY, 'trthumb')}${t.side === 'blue' ? '<i class="side-b"></i>' : ''}</span>`;
      }).join('');
      base += `<div class="bslot card-slot train-area" style="left:${pct(geo.card[0])};top:${pct(geo.card[1])}"><div class="tr-tiles">${tiles}</div></div>`;
      base += `<div class="bslot piece-row" style="left:${pct(geo.piece[0])};top:${pct(geo.piece[1])}">${tokDots(owners)}</div>`;
    }

    /* 家臣棋子：每层走廊 + 城门，单独一排 */
    for (const key of ['gate', 'floor1', 'floor2', 'floor3']) {
      const xy = B.clan[key]; if (!xy) continue;
      const owners = [];
      for (const p of g.players) for (let n = 0; n < p.clan[key]; n++) owners.push(p);
      if (!owners.length) continue;
      base += `<div class="bslot piece-row clan-row" style="left:${pct(xy[0])};top:${pct(xy[1])}">${tokDots(owners)}</div>`;
    }


    /* —— 开局方块标记：13 格方块 + 11/12 两个标记 —— */
    if (g.markers && D.MARKER_CELLS) {
      const MK = D.MARKERS || [];
      const byId = (id) => MK.find((m) => m.id === id);
      const CUBE = { red: 'mk_a', black: 'mk_b', white: 'mk_c' };
      const put = (pos, mid, label) => {
        const m = byId(mid); if (!m || !pos) return;
        base += `<div class="bslot mkcell" style="left:${pct(pos[0] / 100)};top:${pct(pos[1] / 100)}"><img class="mkimg" src="assets/${assetSrc(m.img)}" alt=""${fallbackAttr} title="${esc(label)}：${esc(m.name)}"></div>`;
      };
      const MC = D.MARKER_CELLS;
      for (const n of Object.keys(MC.nums)) put(MC.nums[n], CUBE[g.markers.cells[n]], '格 ' + n);
      for (const k of Object.keys(MC.diamonds)) put(MC.diamonds[k], CUBE[g.markers.diamonds[k]], '菱形 ' + k);
      for (const k of Object.keys(MC.extras)) put(MC.extras[k], g.markers.extras[k], '格 ' + k);
    }

    $('#board').innerHTML =
      `<div class="bwrap" style="aspect-ratio:${B.ratio}">
         <img class="bimg" src="assets/${assetSrc(B.img)}" alt="基础版图"${fallbackAttr}>
         <div class="blabel">基础版图</div>${base}
       </div>`;
  }

  /* ── 玩家面板＝个人领地图 ─────────────────────────────── */
  function renderPlayers(g) {
    const cur = g.phase === 'play' ? E.currentPlayer(g).id : -1;
    const A = D.DOMAIN_ART.base;
    const strips = D.QUEUE_STRIPS.base;

    const bars = [];
    /* 面板列数按人数排：2 人 = 1 行 2 列；3 人 = 1 行 3 列；4 人 = 2×2。
       不用 auto-fit 是因为 4 人局会排成 3+1，最后一块掉到第二行左边很难看。 */
    $('#players').style.gridTemplateColumns = 'repeat(' + (g.config.playerCount === 3 ? 3 : 2) + ', 1fr)';
    $('#players').innerHTML = g.players.map((p) => {
      /* 队列骰子 */
      const qdice = Object.keys(A.rows).map((c) => {
        const q = p.domain.queues[c]; if (!q) return '';
        const st = strips[c];
        const qmax = { clan: D.SETUP.clanPool, gardener: D.SETUP.gardenerPool, samurai: D.SETUP.samuraiPool }[st.pool] || 5;
        const used = Math.max(0, Math.min(5, qmax - (p.pools[st.pool] || 0)));
        const reward = (st.rewards || [])[used] || [];
        const die = q.dice.length ? dieHtml(q.dice[0], 'sm') : '<span class="pempty"></span>';
        return `<div class="pdice" style="left:${pct(A.dieX)};top:${pct(A.rows[c])}" title="${esc(st.laneName)}队列：已派 ${used}/${qmax} → 本格 ${esc(E.describeEffects(reward) || '无')}">${die}</div>`;
      }).join('');

      /* 行动卡
         尺寸不再按人数写死系数：.pwrap 已是容器（container-type: inline-size），
         CSS 里 .art-thumb.file.pact 用 cqw 定义，宽度 = 面板宽度的 15%，
         2 / 3 / 4 人局面板宽度不同，卡片会自动跟着缩放。 */
      const act = p.domain.actionCard;                    // 个人版图唯一的行动卡槽（被替换的卡已进灯笼区）
      /* ★ 行动卡提示写【正面效果】：起始行动卡（家臣令/园丁令/武士令）的正面是人物的行动，
         不是 light（light 是它晋升时/进灯笼区用的另一面）。城郊卡则有 3 列按骰色取。 */
      const actCols = act && act.fx3
        ? act.fx3.map((fx, i) => ['效果1', '效果2', '效果3'][i] + '：' + (E.describeEffects(fx) || '—')).join('\n')
        : '';
      const cardTip = act ? cardTooltip({ ...act, defId: act.id }, actCols || E.describeEffects(act.backFx || act.fx || [])) : '无行动卡';
      const cardHtml = `<div class="pcard-slot" style="left:${pct(A.card[0])};top:${pct(A.card[1])}" title="${esc(cardTip)}">
        ${act ? `${imgThumb(act.imgFile, 'pact', null, cardTip)}` : '<span class="pempty2">无行动卡</span>'}</div>`;

      /* 个人领地 3 个骰位：当前玩家有可放命令时渲染成可点击格子 */
      const placeSet = p.id === cur ? cmdSets(g).place : {};   // 只能把骰子放到自己的面板
      const domSlots = Object.keys(A.rows).map(function (c) {
        const cmd = placeSet['domain:' + c];
        if (!cmd) return '';
        return '<div class="bslot domslot" data-place="domain:' + c + '" style="left:' + pct(A.dieX) + ';top:' + pct(A.rows[c]) + '" title="' + esc(cmd.label) + '"></div>';
      }).join('');

      /* ── 个人领地图上的可视化库存 ───────────────────────────────
         ① 资源记录轨：三条 0–7 折线轨，用一枚资源色方块标当前数量；
         ② 待派成员：每行 5 个印刷格，用半透明玩家色圆点表示池里剩余数；
         ③ 家纹：顶部 5 个圆槽按 p.seals 放家纹图 W.png；
         ④ 右上 HUD：家纹图 W.png + 钱图 Q.jpg + 2 个家纹兑换按钮。 */
      const resCubes = ['food', 'iron', 'pearl'].map((r) => {
        const n = Math.max(0, Math.min(7, Number(p.res && p.res[r]) || 0));
        const col = D.RESOURCES[r] || { hex: '#8b8172', name: r };
        return `<span class="presource" style="left:${pct(A.resX[r])};top:${pct(A.resY[n])};--rc:${p.color.hex}" title="${esc(col.name)} ${n}/7"></span>`;
      }).join('');

      const WORKER_ROWS = [['clan', '家臣'], ['gardener', '园丁'], ['samurai', '武士']];
      const workerDots = WORKER_ROWS.map(([pool, label]) => {
        const n = Math.max(0, Math.min(5, Number(p.pools && p.pools[pool]) || 0));
        return A.workerX.map((x, i) => i >= 5 - n
          ? `<span class="pworker-dot" style="left:${pct(x)};top:${pct(A.workerY[pool])};--pc:${p.color.hex}" title="${esc(label)}：池中剩余 ${n}/5"></span>`
          : '').join('');
      }).join('');

      const sealTokens = A.crests.map((xy, i) => i < (Number(p.seals) || 0)
        ? `<span class="pseal-token" style="left:${pct(xy[0])};top:${pct(xy[1])}"><img src="assets/W.png?v=20261125a" alt="家纹"></span>`
        : '').join('');

      const showExchange = !p.isAI;
      const canUseExchange = p.id === cur;
      const canRes = canUseExchange && (Number(p.seals) || 0) >= 2;
      const canCoin = canUseExchange && (Number(p.seals) || 0) >= 1;
      /* 家纹数量不再写数字：顶部 5 个 mk8 槽已经能数。两个兑换按钮框在左侧基础资源区最上方的
         印刷兑换徽记上；钱图标移到 5 枚家纹的右侧，直径与家纹一致。
         ★ 2026-11-20 按用户要求：按钮不再写文字，只保留不透明边框，按钮内部透明。 */
      const exchangeHud = showExchange ? `<div class="pexchange-hud" style="left:${pct(A.exchangeHud[0])};top:${pct(A.exchangeHud[1])};width:${pct(A.exchangeHud[2])};height:${pct(A.exchangeHud[3])}">
        <div class="pseal-ex">
          <button class="pex-btn" data-exchange="seal2res" ${canRes ? '' : 'disabled'} title="2 家纹换 1 个自选资源" aria-label="2 家纹换 1 个自选资源"></button>
          <button class="pex-btn" data-exchange="seal2coin" ${canCoin ? '' : 'disabled'} title="1 家纹换 1 钱" aria-label="1 家纹换 1 钱"></button>
        </div>
      </div>` : '';
      const moneyHud = `<div class="pmoney-hud" style="left:${pct(A.moneyHud[0])};top:${pct(A.moneyHud[1])};width:${pct(A.moneyHud[2])}" title="钱 ${p.coins}">
        <img src="assets/Q.jpg?v=20261125a" alt=""><b>${p.coins}</b>
      </div>`;

      /* ── 灯笼奖励区（★ 位置/尺寸改这里）──────────────────────────────
         位置：data.js 的 BOARD_LAYOUT.domain.base.lantern，[x%, y%] = 整条区域的
               【左上角】（和 CSS 第 10 段注释一致）。
         盒子：这里同时写 left 和 right（right 固定贴面板内边 1.2%），
               所以灯笼条是一个【固定宽度的盒子】——卡片从左往右排、
               每张旧卡的位置永远不动，新卡往右补。
               ★ 之前用 right 锚定（x=右边缘），每拿一张新卡整条变宽、
                 所有旧卡都往左滑一格，看起来就是「灯笼区在移动」——已改。
         尺寸：css/style.css 第 10 段「灯笼奖励区」的 --lan-w / --lan-h / --lan-step。
         形态：卡背【完整显示】并【逆时针转 90°】横躺，后一张压在前一张上面，
               只靠 --lan-step（每张露出的宽度）控制盖住多少。
         顺序：p.lantern 数组顺序 = 获得顺序，越晚拿到的越靠右。
         ★ 溢出（2026-11 改）：不再截断、也不再画「+N」计数片。所有卡都渲染，
           超出盒子右边界的【部分】由 .plantern-strip 的 overflow:hidden 裁掉——
           框内的卡完整显示，最右那张只露出留在框里的一截，而不是整张消失。 */
      const LANT = A.lantern || [0.3, 0.7];
      const lanAll = p.lantern || [];
      const lanCards = lanAll.map(function (c) {
        /* 效果文本走引擎的 lanternCardEffects，和右侧「玩家数据」用同一套判定 */
        const eff = E.lanternCardEffects(c);
        const tip = (c.name || c.id) + (eff.length ? '：' + E.describeEffects(eff) : '：无灯笼图标');
        /* 卡面优先级：
             法令卡 → imgFile（正面图，data.js 的 DECREE_CARDS 里填），没填就用文字牌面
             其他卡 → backFile（卡背图，灯笼区显示的是卡背不是正面） */
        const src = c.isDecree ? (c.imgFile || '') : (c.backFile || c.imgFile || '');
        const face = src
          ? '<img src="assets/' + assetSrc(src) + '" alt=""' + fallbackAttr + '>'
          : '<span class="plantern-glyph">' + esc(c.glyph || String(c.name || c.id || '?').slice(0, 1)) + '</span>';
        return '<div class="plantern' + (c.isDecree ? ' is-decree' : '') + '" title="' + esc(tip) + '">' + face + '</div>';
      }).join('');

      /* 状态条：四排固定结构（2026-10 按用户要求重排）
         第一排：玩家名称 / 金扇 / 红扇 / 总分（实时算，等于终局计分口径）
         第二排：钱 / 家纹 / 影响力 / 铁·食·珠
         第三排：家臣 / 武士 / 园丁
         第四排：灯笼区（张数 + 汇总图标）
         改顺序/内容就改这里的 <div class="prow">；样式在 css/style.css 的 .pbar / .prow。 */
      const res = ['iron', 'food', 'pearl'].map((r) => `<i class="rchip" style="color:${D.RESOURCES[r].hex};border-color:${D.RESOURCES[r].hex}66;background:${D.RESOURCES[r].hex}1a">${D.RESOURCES[r].glyph}${p.res[r]}</i>`).join('');
      /* 灯笼区记录：汇总图标走 E.lanternEffects（= 每张卡 lanternCardEffects 拼接），
         与左侧面板上卡背显示的是同一套判定，不会两边对不上。 */
      const lanEff = E.lanternEffects(p);
      const lanTxt = lanEff.length ? E.describeEffects(lanEff) : '空';
      const lanTip = (p.lantern || []).map((c) => `${c.name || c.id}：${E.describeEffects(E.lanternCardEffects(c)) || '无灯笼图标'}`).join('\n');
      /* 总分实时算：直接复用引擎的终局计分函数，面板上的数和结算表永远一致 */
      const bd = E.scoreBreakdown(g, p);
      /* 武士按「铁成本档」统计：板块属于哪个训练区 → 该区印制的铁成本（5/3/1）。
         （以前读 p.samuraiByCost，但引擎从不写这个字段，所以三个数永远是 0。） */
      /* 按【派遣次数】统计（一次派遣可能拿 2 块标志，但只算 1 个武士） */
      const samByCost = { 5: 0, 3: 0, 1: 0 };
      for (const c of (p.samuraiDispatch || [])) samByCost[c] = (samByCost[c] || 0) + 1;
      const bar = `<div class="pbar">
        <div class="prow r1">
          <span class="pn" style="color:${p.color.hex}">${esc(p.name)}${p.isAI ? '（AI）' : ''}${p.id === cur ? ' ●' : ''}</span>
        <span class="fan">红扇 ${p.redFan}</span><span class="gold">金扇 ${bd.total - p.redFan}</span><span>计分 ${bd.total}</span>
        </div>
        <div class="prow r2">
          <span>钱 ${p.coins}</span><span>家纹 ${p.seals}</span>
          <span>影响力 ${p.time}</span>
          <span class="resl">${res}</span>
        </div>
        <div class="prow r3">
          <span class="troop">家臣 ${p.pools.clan}池，三层/${p.clan.floor3} 二层/${p.clan.floor2} 一层/${p.clan.floor1} 门口/${p.clan.gate}</span>
          <span class="troop">园丁 ${p.pools.gardener}池，红桥/${p.gardeners.filter(x=>x.row===0).length} 黑桥/${p.gardeners.filter(x=>x.row===1).length} 白桥/${p.gardeners.filter(x=>x.row===2).length}</span>
          <span class="troop">武士 ${p.pools.samurai}池，五铁/${samByCost[5]} 三铁/${samByCost[3]} 一铁/${samByCost[1]}</span>
        </div>
        <div class="prow r4">
        <span class="lan">灯笼区 ${p.lantern.length}：${esc(E.describeEffects(E.mergeEffects(E.lanternEffects(p))))}</span>
        </div>
      </div>`;
      bars.push(bar);



      /* 卡牌：正面在花园条，翻面（side='back'）进灯笼区 */
      const mine = S.cards.concat(g.cardInstances || []).filter((c) => c.owner === p.id);
      const frontCards = mine.filter((c) => c.side === 'front').map(renderCard).join('');
      const lanternCards = mine.filter((c) => c.side === 'back').map(renderCard).join('');

      return `<div class="pcard ${p.id === cur ? 'active' : ''}" style="--pc:${p.color.hex}">
        <div class="pwrap" style="aspect-ratio:${A.ratio}">
          <img class="pimg" src="assets/${assetSrc(A.img)}" alt="个人领地"${fallbackAttr}>
          ${resCubes}${workerDots}${sealTokens}${qdice}${cardHtml}${domSlots}
          ${lanCards ? `<div class="plantern-strip" style="left:${pct(LANT[0])};top:${pct(LANT[1])};right:1.2%">${lanCards}</div>` : ''}
          ${exchangeHud}${moneyHud}
        </div>
        <div class="gcards">${frontCards}</div>
        ${lanternCards ? `<div class="gcards glantern"><span class="glan-title">灯笼区</span>${lanternCards}</div>` : ''}
      </div>`;
    }).join('');
    $('#pstats').innerHTML = bars.join('');
  }

  function renderLog(g) {
    /* ★ 不同玩家的操作用该玩家的颜色区分（2026-10-31 按用户要求加）：
       引擎在每条日志里带 pid（谁行动时写的就标谁），这里给该条加一条
       玩家色的左边条。系统级日志（开局/轮开始等）没有 pid，不加边条。 */
    $('#log').innerHTML = g.log.slice(0, 60).map((l) => {
      const pl = l.pid != null ? g.players[l.pid] : null;
      const bar = pl ? ` style="border-left:3px solid ${pl.color.hex}"` : '';
      return `<div class="${l.cls}"${bar}>${esc(l.text)}</div>`;
    }).join('');
  }

  /* ── pending 弹窗 ─────────────────────────────────────── */
  let pendingShownFor = null;
  let peekPending = false;
  function renderPending(g) {
    const root = $('#modalRoot');
    if (g.phase === 'gameEnd') return;
    const pd = g.pending;
    if (!pd || !isHumanTurn(g)) {
      /* 待决项已经结算完：把上一轮的待决弹窗一起收掉，避免开局选卡/选择资源
         已经完成后弹窗还留在屏幕上。 */
      if (pendingShownFor !== null) closeModal();
      pendingShownFor = null;
      peekPending = false;
      return;
    }
    const key = JSON.stringify([pd.kind, pd.playerId, (pd.options || pd.pool || pd.pairs || []).length, pd.n || '', g.log.length]);
    if (pendingShownFor === key) return;
    pendingShownFor = key;
    peekPending = false;
    const allCmds = E.legalCommands(g);
    /* ★ 只把「选择」类命令做成选项按钮：兑换/撤销另有按钮，
       否则会多出几个点了没反应的空按钮。 */
    const cmds = allCmds.filter((c) => c.type === 'choose' || c.type === 'draftPick');
    const exCmds = allCmds.filter((c) => c.type === 'exchange');
    /* ★ 撤销：选择界面里也要能用（以前只在状态栏，pending 时被隐藏，选到一半退不回去） */
    const canUndo = allCmds.some((c) => c.type === 'undo');
    const canRewind = !!(E.canUndoTurn && E.canUndoTurn(g));
    /* 弹窗标题也按「条件 + 效果」写，不写地点名 */
    const baseTitle = { draft: '开局选卡：选一对（资源卡入灯笼区，行动卡入领地）', gainAny: '选择资源', choose: '选择一项', orderPick: '选择结算顺序（先结算哪一项效果）', retainer: '家臣行动：支付珍珠晋升 / 支付钱进城门', promoteRoom: '晋升：选择浅色效果', gardener: '园丁行动：支付食物，获得奖励', samurai: '武士行动：支付铁，获得奖励', domainPick: '领地行动：选择一色，获得奖励', castle: '城堡行动', outskirtGain: '城郊窗帘：选择一色', trainYellow: '训练场黄面奖励', trainBlue: '训练场蓝面行动', gardenGain: '庭院奖励', wallPick: '墙外：选 1 个行动' }[pd.kind] || '选择';
    /* 任选 N 资源会连着弹 N 次；把「还需几个」写进标题，避免看起来像同一张卡没反应。 */
    const title = pd.kind === 'gainAny'
      ? `${pd.draft ? '开局选卡：' : ''}选择资源${pd.n > 1 ? `（还需 ${pd.n} 个）` : '（还需 1 个）'}`
      : baseTitle;
    const opts = cmds.map((c) => {
      let art = '';
      if (pd.kind === 'draft') {
        const pair = pd.pairs[c.pairIdx];
        art = `<div style="display:flex;gap:8px;margin-bottom:8px">${imgThumb(pair.res.imgFile, 'big')}${pair.act.imgFile ? imgThumb(pair.act.imgFile, 'big') : `<div class="art-thumb big" style="display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);font-size:10px;color:var(--paper-dim)">${esc(pair.act.name)}</div>`}</div>`;
      }
      return `<button class="ghost" style="display:block;width:100%;text-align:left;margin:5px 0;padding:9px" data-opt="${c.type === 'draftPick' ? 'd' + c.pairIdx : c.optionId}">${art}${esc(c.label)}</button>`;
    }).join('');
    /* 家纹兑换条：家纹随时可换，所以选择弹窗里也放一条，
       换完会重新计算选项（刚换来的资源马上就能用）。 */
    const exBar = exCmds.length
      ? `<div class="modal-ex"><span class="ex-lab">家纹兑换</span>${exCmds.map((c) => `<button class="ghost ex" data-ex="${c.id}">${esc(c.label)}</button>`).join('')}</div>`
      : '';
    const modalTools = [
      canUndo ? '<button class="ghost" id="undoBtn" style="font-size:11px;padding:3px 8px">撤销</button>' : '',
      canRewind ? '<button class="ghost" id="undoTurnBtn" style="font-size:11px;padding:3px 8px">撤销至回合开始</button>' : ''
    ].filter(Boolean).join('');
    const modalToolsHtml = modalTools ? `<span style="margin-left:auto;display:inline-flex;gap:5px">${modalTools}</span>` : '';
    root.innerHTML = `<div class="modal"><div class="panel-head"><h3>${esc(title)}</h3>${modalToolsHtml}<button class="ghost" id="peekBtn" style="margin-left:${modalTools ? '6px' : 'auto'};font-size:11px;padding:3px 8px">查看版图</button></div><div style="overflow:auto;padding:10px">${opts}${exBar}</div></div>`;
    root.querySelectorAll('[data-ex]').forEach((btn) => btn.addEventListener('click', () => {
      E.apply(S.g, { type: 'exchange', id: btn.getAttribute('data-ex') });
      pendingShownFor = null;
      render(); drive();
    }));
    const ub = root.querySelector('#undoBtn');
    if (ub) ub.addEventListener('click', () => {
      closeModal(); pendingShownFor = null;
      E.apply(S.g, { type: 'undo' }); render(); drive();
    });
    const ur = root.querySelector('#undoTurnBtn');
    if (ur) ur.addEventListener('click', () => {
      closeModal(); pendingShownFor = null;
      E.apply(S.g, { type: 'undoTurn' }); render(); drive();
    });
    const pb = root.querySelector('#peekBtn');
    if (pb) pb.addEventListener('click', () => {
      /* 不生成底部浮动按钮：查看版图时把「继续选择」放到顶部状态栏，
         紧挨着撤销，避免手机上还要滑到底部去点。 */
      peekPending = true;
      root.classList.add('hidden');
      if (typeof renderStatus === 'function') renderStatus(S.g);
    });
    root.classList.remove('hidden');
    root.querySelectorAll('[data-opt]').forEach((btn) => btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-opt');
      const cmd = v.startsWith('d') ? { type: 'draftPick', pairIdx: +v.slice(1) } : { type: 'choose', optionId: isNaN(+v) ? v : +v };
      closeModal(); pendingShownFor = null;
      E.apply(S.g, cmd); render(); drive();
    }));
  }
  function closeModal() { peekPending = false; $('#modalRoot').classList.add('hidden'); $('#modalRoot').innerHTML = ''; }

  /* ── 终局 ─────────────────────────────────────────────── */
  let endShown = false;
  function renderGameEnd(g) {
    if (endShown) return;
    endShown = true;
    const head = g.scores.map((s) => {
      const p = g.players[s.pid];
      return '<th style="color:' + (p.color.hex === '#d9d2c3' ? '#efe6cf' : p.color.hex) + '">' + esc(s.name) + (s.pid === g.winner ? ' ★' : '') + '</th>';
    }).join('');
    const row = (label, get, bold) => {
      const tds = g.scores.map((s) => '<td style="text-align:center' + (bold ? ';font-weight:700;border-top:1px solid #6b5a44' : '') + '">' + get(s.breakdown) + '</td>').join('');
      return '<tr><td style="text-align:right;opacity:.85">' + label + '</td>' + tds + '</tr>';
    };
    const table =
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr><th style="text-align:right">项目</th>' + head + '</tr>' +
      row('钱和家纹', (b) => b.coinsSeals) +
      row('影响力', (b) => b.timePts) +
      row('基础资源', (b) => b.resPts) +
      row('家臣', (b) => b.clanPts) +
      row('武士', (b) => b.trainingPts) +
      row('园丁', (b) => b.gardenPts) +
      row('红扇', (b) => b.redFan) +
      row('总分', (b) => '<b>' + b.total + '</b>', true) +
      '</table>';
    $('#modalRoot').innerHTML = '<div class="modal"><div class="panel-head"><h3>终局计分<small>FINAL</small></h3></div>' +
      '<div style="overflow:auto;padding:10px">' + table +
      '<div style="font-size:10.5px;opacity:.6;margin-top:8px">前 6 项为金扇，加红扇 = 总分。</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="ghost" style="flex:1" id="btnPeekEnd">查看游戏面板</button><button class="primary" style="flex:1" id="btnAgain">再来一局</button></div></div></div>';
    $('#modalRoot').classList.remove('hidden');
    $('#btnAgain').addEventListener('click', () => { closeModal(); endShown = false; showSetup(); });
    $('#btnPeekEnd').addEventListener('click', () => {
      $('#modalRoot').classList.add('hidden');
      const fab = document.createElement('button');
      fab.textContent = '返回计分'; fab.className = 'ghost fab';
      fab.addEventListener('click', () => { fab.remove(); $('#modalRoot').classList.remove('hidden'); });
      document.body.appendChild(fab);
    });
  }

  /* ── AI 驱动 ──────────────────────────────────────────── */
  let driving = false;
  function drive() {
    const g = S.g;
    if (!g || g.phase === 'gameEnd' || driving) return;
    if (isHumanTurn(g)) return;
    const actor = g.pending ? g.players[g.pending.playerId] : (g.phase === 'play' ? E.currentPlayer(g) : null);
    if (!actor) return;
    driving = true;
    setTimeout(() => {
      driving = false;
      try {
        const cmds = E.legalCommands(g).filter((c) => c.type !== 'undo');
        if (cmds.length) {
          const cmd = A.chooseMove(g, cmds) || cmds[0];
          E.apply(g, cmd);
        }
      } catch (e) {
        console.error('[AI] 走子异常，改用首个合法命令兜底：', (e && e.stack) || e);
        try {
          const cmds = E.legalCommands(g).filter((c) => c.type !== 'undo');
          if (cmds.length) E.apply(g, cmds[0]);
        } catch (e2) { console.error('[AI] 兜底仍失败', e2); }
      } finally {
        render(); drive();
      }
    }, 320);
  }

  /* ── 全局点击 ─────────────────────────────────────────── */
  document.addEventListener('click', (ev) => {
    const g = S.g;
    if (!g) return;
    const canAct = isHumanTurn(g) && !g.pending;
    const takeEl = ev.target.closest('[data-take]');
    if (takeEl) {
      if (!canAct || g.inHand) return;
      const [bridge, side] = takeEl.getAttribute('data-take').split(':');
      E.apply(g, { type: 'takeDie', bridge, side }); render(); drive(); return;
    }
    const placeEl = ev.target.closest('[data-place]');
    if (placeEl) {
      if (!canAct || !g.inHand) return;
      E.apply(g, { type: 'placeDie', slot: placeEl.getAttribute('data-place') }); render(); drive(); return;
    }
    const exEl = ev.target.closest('[data-exchange]');
    if (exEl) {
      /* 家纹随时可换：弹窗里也能换，所以这里不拦 g.pending */
      if (!isHumanTurn(g)) return;
      E.apply(g, { type: 'exchange', id: exEl.getAttribute('data-exchange') });
      pendingShownFor = null;
      render(); drive(); return;
    }
    if (ev.target.closest('[data-resume-peek]')) {
      peekPending = false;
      pendingShownFor = null;
      render(); drive(); return;
    }
    if (ev.target.closest('[data-end]')) { E.apply(g, { type: 'endTurn' }); render(); drive(); return; }
    if (ev.target.closest('[data-undo]')) {
      if (!isHumanTurn(g) || g.pending) return;
      E.apply(g, { type: 'undo' }); render(); drive(); return;
    }
    if (ev.target.closest('[data-rewind]')) {
      if (!isHumanTurn(g)) return;
      E.apply(g, { type: 'undoTurn' }); render(); drive(); return;
    }
  });

  /* ── 状态栏按钮（撤销 / 结束回合；兑换已收进个人领地的家纹排，不再重复） ── */
  const origStatus = renderStatus;
  renderStatus = function (g) {
    origStatus(g);
    if (isHumanTurn(g) && g.phase === 'play' && !g.pending) {
      const cs = cmdSets(g);
      const undo = cs.canUndo ? `<button class="ghost" data-undo style="padding:4px 9px;font-size:10px">撤销</button>` : '';
      const rewind = cs.canRewind ? `<button class="ghost" data-rewind style="padding:4px 9px;font-size:10px;white-space:nowrap">撤销至回合开始</button>` : '';
      const endBtn = cs.cmds.some((c) => c.type === 'endTurn') ? `<button class="ghost" data-end style="padding:4px 9px;font-size:10px">结束回合</button>` : '';
      if (undo || rewind || endBtn) $('#status').innerHTML += `<span style="display:inline-flex;flex-wrap:wrap;gap:5px;margin-left:8px">${undo}${rewind}${endBtn}</span>`;
    } else if (g.snapshots.length && isHumanTurn(g)) {
      const cs2 = cmdSets(g);
      const endBtn2 = cs2.cmds.some((c) => c.type === 'endTurn') ? `<button class="ghost" data-end style="padding:4px 9px;font-size:10px">结束回合</button>` : '';
      const rewind2 = cs2.canRewind ? `<button class="ghost" data-rewind style="padding:4px 9px;font-size:10px;white-space:nowrap">撤销至回合开始</button>` : '';
      $('#status').innerHTML += `<span style="display:inline-flex;flex-wrap:wrap;gap:5px;margin-left:8px">${endBtn2}<button class="ghost" data-undo style="padding:4px 9px;font-size:10px">撤销</button>${rewind2}</span>`;
    }
    if (peekPending) {
      $('#status').innerHTML += `<button class="ghost" data-resume-peek style="padding:4px 9px;font-size:10px;margin-left:6px">继续选择 ▸</button>`;
    }
  };

  /* ── 版图缩放：用 CSS 变量 --board-scale 控制 .bwrap 宽度，整张版图（含骰位叠层）等比缩放 ── */
  const ZOOM_KEY = 'himeji-board-scale';
  let boardScale = parseFloat(localStorage.getItem(ZOOM_KEY)) || 1;
  const applyBoardScale = () => {
    document.documentElement.style.setProperty('--board-scale', boardScale);
    const lbl = $('#zoomLabel'); if (lbl) lbl.textContent = Math.round(boardScale * 100) + '%';
  };
  applyBoardScale();
  $('#btnZoomIn').addEventListener('click', () => {
    boardScale = Math.min(2, +(boardScale + 0.1).toFixed(2));
    localStorage.setItem(ZOOM_KEY, boardScale); applyBoardScale();
  });
  $('#btnZoomOut').addEventListener('click', () => {
    boardScale = Math.max(0.4, +(boardScale - 0.1).toFixed(2));
    localStorage.setItem(ZOOM_KEY, boardScale); applyBoardScale();
  });
  $('#zoomLabel').addEventListener('click', () => {
    boardScale = 1; localStorage.setItem(ZOOM_KEY, boardScale); applyBoardScale();
  });

  /* ── 设置页 ───────────────────────────────────────────── */
  function initSetup() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const group = seg.getAttribute('data-group');
      if (group === 'seat') return;
      seg.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button');
        if (!btn) return;
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        const v = btn.getAttribute('data-v');
        if (group === 'players') { S.opts.players = +v; renderSeatSeg(); }
        if (group === 'diff') S.opts.diff = v;
    if (group === 'order') S.opts.order = v;
      });
    });
    renderSeatSeg();
    $('#btnStart').addEventListener('click', startGame);
  }
  function renderSeatSeg() {
    const seg = document.querySelector('.seg[data-group="seat"]');
    seg.innerHTML = D.PLAYER_COLORS.slice(0, S.opts.players).map((c, i) =>
      `<button data-v="${i}" class="${i === S.opts.seat ? 'on' : ''}" style="border-color:${c.hex}">${c.clan}</button>`).join('');
    if (S.opts.seat >= S.opts.players) S.opts.seat = 0;
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      S.opts.seat = +b.getAttribute('data-v');
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    }));
  }
  function showSetup() {
    closeModal();
    $('#setup').classList.remove('hidden');
    $('#game').classList.add('hidden');
    S.g = null;
  }
  function startGame() {
    endShown = false; pendingShownFor = null;
    closeModal();
    S.g = E.newGame({ playerCount: S.opts.players, humanSeat: S.opts.seat, difficulty: S.opts.diff, order: S.opts.order || 'first' });
    $('#setup').classList.add('hidden');
    $('#game').classList.remove('hidden');
      render(); drive();
  }


  /* 只读的规则层之外的 4 个接口，专供 net/save.js 恢复本地存档使用。
     它们只替换状态对象 / 开局选项 / 界面显隐，不改变任何游戏逻辑。 */
  window.WCUI = {
    renderCard, render,
    cards: () => S.cards,
    game: () => S.g,
    drive,
    opts: () => Object.assign({}, S.opts),
    setOpts: (o) => {
      if (!o) return;
      if (o.players) S.opts.players = o.players;
      if (o.diff) S.opts.diff = o.diff;
      if (o.order) S.opts.order = o.order;
      if (o.seat != null) S.opts.seat = Math.max(0, Math.min(S.opts.players - 1, o.seat));
      renderSeatSeg();
    },
    setGame: (g) => { S.g = g; },
    showGame: () => {
      endShown = false; pendingShownFor = null;
      try { closeModal(); } catch (e) {}
      $('#setup').classList.add('hidden');
      $('#game').classList.remove('hidden');
    }
  };

  initSetup();
})();
