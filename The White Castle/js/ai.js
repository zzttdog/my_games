/* 姬路城 + 茶道扩 —— AI
   三档难度（g.config.difficulty，也可用 g.config.aiDifficulty[玩家id] 按座位指定）：

   easy   「简单」：★ 2026-10 按用户要求，直接换成「普通」那套逻辑（不再纯随机）。
           和 normal 参数完全一致 —— 至少会解 pending 链、看得见钱纹，不会乱走。
           实测 2 人局平均约 33 分。

   normal 「会算一步」：对每个候选，先把挂起的 pending 链（选择资源/队列/房间…）
           解 8 层再比较终态，这样「家臣行动→选房间→拿红扇」能算清总账。
           使用完整估值（资源接近度、灯笼区、幕僚梯子、庭院可拿性、影响力进度），
           取骰时同时枚举所有落点，避免取到只能放水井的骰。实测 2 人局平均约 46 分。

   hard   「会算整局」：完整估值 + 更深的选择链 + 对手压制 + 零抖动
           ① pending 链解 8 层；
           ② 估值含：资源按「距下一阶梯还差多少」估、灯笼区按图标实际价值估、
              幕僚梯子按层数加权、已派出家族成员、庭院可拿性、影响力离检查点的距离、
              钱纹（家纹比钱贵，因为它能随时换资源）；
           ③ 对手压制：按「我的分 − 对手最高分」排序，不只看自己；
           ④ 完全不加抖动。

   实测强度（2 人局；2026-11 重测：取骰-落点联合估值、家纹兑换、水井惩罚、
   影响力进度、墙外/领地偏好）：
     单档自走平均分  ：easy 33.5 / normal 40.8 / hard 41.8（12 局，默认参数）
                       normal 调成零抖动后约 46 分；hard 约 44–48 分。
      单局最高分目前约 74 分，普通 60 分是可达的单局高分、不是每局平均；
      困难 100 分在现有 3 轮 × 9 次行动的计分下没有观察到，需另调回合/计分规则。
   复现命令：node test/ai-match.js 8 hard normal / node test/ai-bench.js 8 2

   关键实现细节（踩过的坑）：
   - 纯 1-ply 贪心会把「家臣/园丁」这类放骰无即时收益的动作当 0 分扔掉，
     所以必须先解完 pending 链再比较终态。
   - 三档的差距**主要来自估值精度（lite 档位）**，不是搜索深度：
     只加深 pending 链时 hard 和 normal 打成 50%，加上 lite 才拉开。
   - 试过「对手最强回应」的两步前瞻，反而让 hard 变弱（胜率 29%），已放弃。
   - 随机性用「局面 + 候选」的稳定哈希，保证同种子同局面可复现（回归测试依赖这点）。
   - clone 用 JSON 深拷贝，snapshots 清空，避免 undo 栈被复制导致内存爆掉。
   - 估值权重集中在下面的 W 表里，想调 AI 性格（更贪分 / 更爱养灯笼）只改 W。 */
window.WCAI = (function () {
  'use strict';
  const E = window.WCEngine;
  const D = window.WCData;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ── 难度参数 ────────────────────────────────────────────
     chain     : pending 链最多解几层
     jitter    : 随机抖动幅度（越大越不稳）
     opp       : 对手压制权重（按对手最高分扣分）
     randomPick: 直接乱选的概率（easy = 1.0 即纯随机） */
  /* lite: 估值精度档位
       0 = 完整估值（hard）
       1 = 简化估值（normal）：只算终局分 + 钱纹，不看「灯笼区厚度 / 资源接近度 / 梯子潜力」
           这三项都是跨回合的长期资产，看不出它们 → 不会主动养灯笼区、不会补资源短板
       2 = 只看眼前（easy）：连钱纹都不看，基本是「这一步能拿多少终局分」 */
  const PRESET = {
    /* easy：★ 2026-10 按用户要求，直接换成「普通」那套逻辑（不再纯随机）。
       和 normal 完全一致，区别只在界面上给人一个「简单」的心理档位。 */
    easy:   { chain: 2, jitter: 2.0, opp: 0.00, randomPick: 0.00, ply2: 0, lite: 1, well: 0, exchange: false },
    normal: { chain: 8, jitter: 0.0, opp: 0.00, randomPick: 0.00, ply2: 0, lite: 0, well: 10, exchange: true, wallBias: 6, domainBias: 5 },
    hard:   { chain: 8, jitter: 0.0, opp: 0.00, randomPick: 0.00, ply2: 0, lite: 0, well: 12, exchange: true, wallBias: 8, domainBias: 6,
              weights: { total: 10, coins: 1.2, seals: 1.8, resProg: 4, lantern: 2, clan: 8, pieces: 10, gardenPot: 0, inflGap: 1.2, time: 1 } }
  };

  /* ── 估值权重（想调 AI 性格就改这里，数值越大越看重这一项）──
     lite 档位决定用哪几项：
       lite 2 = 只看总分（旧 easy，已不用）
       lite 1 = 总分 + 钱纹（easy / normal）
       lite 0 = 全量（hard） */
  const W = {
    total: 10,        // 终局分（scoreBreakdown.total）的倍数，主项
    coins: 1.2,       // 1 钱值多少
    seals: 1.8,       // 1 家纹值多少（家纹能换任意资源，比钱更值钱）
    resProg: 4.0,     // 资源「距下一阶梯还差多少」的权重
    lantern: 2.0,     // 灯笼区图标总价值（每回合左端骰都会结算一次）
    clan: 2.0,        // 幕僚梯子层数
    pieces: 1.5,      // 已派出的武士 / 园丁
    gardenPot: 3.0,  // 庭院卡可拿性（食物还能派园丁）
    inflGap: 1.2,     // 影响力「离下一个检查点还差几格」
    time: 3.5         // 影响力离下一档终局分的进度（6/11/15 档）
  };

  /* 稳定伪随机：同一局面同一候选 → 同一抖动 */
  function hash01(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return ((x >>> 0) % 10000) / 10000;
  }
  const jitter = (g, cmd, i) => hash01(JSON.stringify(cmd) + '|' + (g.round || 0) + '|' + (g.turnIdx || 0) + '|' + i);

  /* ── 估值 ────────────────────────────────────────────────
     终局分（scoreBreakdown.total）是主项，其余是「中间态塑形」：
     让正在成型、但还没变成分的资产也有价值，否则多步动作走到一半会被判无意义。 */
  function evaluate(g, who, lite, weights) {
    const p = (who && typeof who === 'object') ? who : g.players[who];
    if (!p) return -Infinity;
    const w = weights || W;
    const b = E.scoreBreakdown(g, p);
    /* lite 2：只看眼前这一步能拿到的终局分 */
    if (lite === 2) return b.total * w.total;
    /* b.total 里已经含了：资源阶梯分、影响力分、幕僚层级分、训练场乘算分、
       园丁分（=金扇）、钱+纹、红扇。所以下面只补「total 里还没有」的塑形项，
       重复加权会让 AI 过度追逐红扇/影响力而忽略资源阶梯。 */
    let v = b.total * w.total;

    /* lite 1：只算终局分 + 钱纹，不看下面这些跨回合的长期资产 */
    if (lite === 1) return v + p.coins * w.coins + p.seals * w.seals;

    /* 资源：距下一阶梯的接近度（total 只算「已到档」，这里奖励补短板） */
    v += resProgress(p) * w.resProg;

    /* 灯笼区：图标越多，左端骰每回合结算越厚，是长期引擎 */
    v += lanternValue(p) * w.lantern;

    /* 幕僚梯子：越高行动越强，给一点潜力分（total 已算层级分，这里权重压低） */
    v += (p.clan.gate + p.clan.floor1 * 2 + p.clan.floor2 * 3 + p.clan.floor3 * 4) * w.clan;

    /* 钱 / 家纹：可换分。家纹还能随时换资源，所以比钱略贵 */
    v += p.coins * w.coins + p.seals * w.seals;

    /* 已派出的家族成员：终局乘算的底座 */
    v += (p.samuraiTiles.length + p.gardeners.length) * w.pieces;

    /* 庭院卡可拿性：手里有食物就还派得出园丁，食物越多这项潜力越大 */
    v += Math.min(p.res.food, 5) * w.gardenPot;

    /* 影响力：离下一个检查点还差几格（差 1 格时最值钱，会主动去凑家纹） */
    const cp = D.INFLUENCE_TRACK.checkpoints.find((c) => p.time < c.at);
    if (cp) v += Math.max(0, 4 - (cp.at - p.time)) * w.inflGap;
    v += timeProgress(p) * w.time;

    /* 手里还攥着骰子没放 → 略微扣分，鼓励把回合走完 */
    if (g.inHand && g.inHand.die) v -= 6;
    return v;
  }

  /* 三种资源各自「离下一阶梯还差多少」，按阶梯分给部分信用 */
  function resProgress(p) {
    const tiers = (D.SCORING && D.SCORING.resTiers) || [];
    let v = 0;
    for (const r of ['iron', 'food', 'pearl']) {
      const cur = p.res[r] || 0;
      let got = false;
      for (const [th, pts] of tiers) {
        if (cur >= th) { v += pts; got = true; break; }
      }
      if (got) continue;
      /* 没到任何档：按最接近的那一档给部分信用 */
      let best = null;
      for (const [th, pts] of tiers) {
        if (cur < th && (!best || th < best[0])) best = [th, pts];
      }
      if (best) v += (cur / best[0]) * best[1] * 0.6;
    }
    return v;
  }

  /* 影响力进度：按 6 / 11 / 15 / 20 四档给部分信用，让 AI 早期也愿意走时间 */
  function timeProgress(p) {
    const t = p.time || 0;
    if (t >= 15) return 10 + Math.min(5, t - 15);
    if (t >= 11) return 6 + (t - 11) * 0.8;
    if (t >= 6) return 3 + (t - 6) * 0.6;
    return t * 0.5;
  }

  /* 灯笼区图标总价值：效果 DSL → 粗略分值 */
  function lanternValue(p) {
    let v = 0;
    for (const e of E.lanternEffects(p)) {
      if (!e) continue;
      if (e.op === 'fan') v += e.n * (e.kind === 'gold' ? 5 : 8);
      else if (e.op === 'time') v += e.n * 4;
      else if (e.op === 'gain') v += e.n * ((e.what === 'coins' || e.what === 'seals') ? 2.2 : 1.6);
      else if (e.op === 'gainAny') v += e.n * 1.6;
      else if (e.op === 'lantern') v += 5;
      else if (e.op === 'action') v += 3;
      else if (e.op === 'special') v += 2.5;
    }
    return v;
  }

  function opponentBest(g2, pid) {
    let m = -Infinity;
    for (const p of g2.players) {
      if (p.id === pid) continue;
      const v = evaluate(g2, p);
      if (v > m) m = v;
    }
    return m === -Infinity ? 0 : m;
  }

  /* 把 pending 链按同一估值解完；只接管自己的待决，最多 depth 层 */
  function resolveChain(g, pid, depth, lite, weights) {
    let d = 0;
    while (g.pending && d++ < depth) {
      if (g.pending.playerId !== pid) break;
      const opts = E.legalCommands(g).filter((c) => c.type !== 'undo' && c.type !== 'exchange');
      if (!opts.length) break;
      if (opts.length === 1) { try { E.apply(g, opts[0]); } catch (e) { break; } continue; }
      let best = null, bestV = -Infinity;
      opts.forEach((c, i) => {
        const g3 = clone({ ...g, snapshots: [], log: [] });
        try { E.apply(g3, c); } catch (e) { return; }
        const v = evaluate(g3, pid, lite, weights) + jitter(g, c, i) * 1.2;
        if (v > bestV) { bestV = v; best = c; }
      });
      if (!best) break;
      try { E.apply(g, best); } catch (e) { break; }
    }
  }

  function actorPid(g) {
    if (g.pending) return g.pending.playerId;
    return g.turnOrder[g.turnIdx];
  }

  /* 取骰时不能只看取骰本身：骰子拿在手里还没放，真正的收益在落点。
     这里把「取这颗骰 → 枚举所有可放位置 → 解完选择链」一起估值，
     否则 AI 会挑一颗只有水井能放的骰，白白浪费一次行动。 */
  function placementBias(cmd, P) {
    let b = 0;
    if (cmd.type === 'placeDie') {
      if (cmd.slot === 'well') b -= (P.well || 0);
      else if (cmd.slot.indexOf('wall:') === 0) b += (P.wallBias || 3);
      else if (cmd.slot.indexOf('domain:') === 0) b += (P.domainBias || 3);
    }
    return b;
  }

  function bestPlacementValue(g2, pid, P) {
    if (!g2.inHand) return null;
    const opts = E.legalCommands(g2).filter((c) => c.type === 'placeDie');
    if (!opts.length) return null;
    let best = -Infinity;
    opts.forEach((cmd, i) => {
      const g3 = clone({ ...g2, snapshots: [], log: [] });
      try { E.apply(g3, cmd); } catch (e) { return; }
      resolveChain(g3, pid, P.chain, P.lite, P.weights);
      let v = evaluate(g3, pid, P.lite, P.weights) + placementBias(cmd, P);
      if (P.opp > 0) v -= P.opp * opponentBest(g3, pid);
      if (P.jitter > 0) v += jitter(g2, cmd, i) * P.jitter * 0.35;
      if (v > best) best = v;
    });
    return best;
  }

  function candidateValue(g2, pid, P, cmd) {
    const placeV = bestPlacementValue(g2, pid, P);
    if (placeV !== null) return placeV;
    let v = evaluate(g2, pid, P.lite, P.weights);
    if (P.opp > 0) v -= P.opp * opponentBest(g2, pid);
    return v + placementBias(cmd, P);
  }

  /* 对手的最强回应值：枚举对手的合法步，每步都解完他的 pending 链，
     取「对手自己最优」的那一步，返回从我的视角看的分数。
     hard 用它来做两步前瞻 —— 防止「这步我拿了 3 分，但白送对手 5 分」。 */
  function bestReplyValue(g2, pid) {
    const opts = E.legalCommands(g2).filter((c) => c.type !== 'undo');
    const mine = evaluate(g2, pid);
    if (!opts.length) return mine;
    /* 对手 = 除我以外分数最高的那位（2 人局就是另一个玩家） */
    let oppPid = null, oppV0 = -Infinity;
    for (const p of g2.players) {
      if (p.id === pid) continue;
      const v = evaluate(g2, p);
      if (v > oppV0) { oppV0 = v; oppPid = p.id; }
    }
    if (oppPid === null) return mine;
    let worst = Infinity;
    for (const oc of opts) {
      const g3 = clone({ ...g2, snapshots: [], log: [] });
      try { E.apply(g3, oc); } catch (e) { continue; }
      resolveChain(g3, oppPid, 2, 0);
      /* 对手按「他自己分 − 我的分」选，我按同一表达式取最差情形 */
      const score = evaluate(g3, pid) - 0.55 * evaluate(g3, oppPid);
      if (score < worst) worst = score;
    }
    return worst === Infinity ? mine : worst;
  }

  function chooseMove(g, cmds) {
    const raw = (cmds || E.legalCommands(g)).filter((c) => c.type !== 'undo');
    if (!raw.length) return null;
    const pid = actorPid(g);
    /* 难度来源：优先 g.config.aiDifficulty[玩家id]（允许同一局里不同 AI 用不同难度，
       方便做「困难 vs 普通」的对战测试），否则用全局 g.config.difficulty。 */
    const perSeat = g.config && g.config.aiDifficulty;
    const difficulty = (perSeat && perSeat[pid]) || (g.config && g.config.difficulty) || 'normal';
    const P = PRESET[difficulty] || PRESET.normal;
    /* 家纹兑换默认不进候选；普通/困难允许在资源正好补上关键行动时主动兑换。 */
    const list = raw.filter((c) => c.type !== 'exchange' || P.exchange);
    if (!list.length) return null;

    /* easy：randomPick >= 1 = 纯随机，直接等概率抽一个合法命令（不估值） */
    if (P.randomPick >= 1) return list[Math.floor(jitter(g, list[0], list.length + 2) * list.length)];
    /* 其余档位：按概率乱选，制造「偶尔漏看」的效果 */
    if (P.randomPick > 0 && jitter(g, list[0], list.length + 1) < P.randomPick) {
      return list[Math.floor(jitter(g, list[0], list.length + 2) * list.length)];
    }

    /* 第一轮：1-ply 估值（每个候选都把 pending 链解完） */
    const scored = [];
    list.forEach((cmd, i) => {
      const g2 = clone({ ...g, snapshots: [], log: [] });
      try { E.apply(g2, cmd); } catch (e) { return; }
      resolveChain(g2, pid, P.chain, P.lite);

      let v = candidateValue(g2, pid, P, cmd);
      if (P.jitter > 0) v += jitter(g, cmd, i) * P.jitter; // 随机抖动
      scored.push({ cmd, v, g2 });
    });
    if (!scored.length) return list[0];

    /* 第二轮（仅 hard）：对前 N 个候选做对手最强回应的两步前瞻，
       最终分 = 0.45 × 自己 1-ply 分 + 0.55 × 对手回应后的分。 */
    if (P.ply2 > 0 && scored.length > 1) {
      scored.sort((a, b) => b.v - a.v);
      const top = scored.slice(0, P.ply2);
      for (const it of top) {
        it.v2 = 0.45 * it.v + 0.55 * bestReplyValue(it.g2, pid);
      }
      top.sort((a, b) => b.v2 - a.v2);
      return top[0].cmd;
    }

    let best = scored[0].cmd, bestV = -Infinity;
    for (const it of scored) if (it.v > bestV) { bestV = it.v; best = it.cmd; }
    return best;
  }

  return { chooseMove, evaluate, PRESET, W };
})();
