﻿/* 姬路城 The White Castle —— 规则引擎（纯逻辑，不依赖 DOM）
   架构（按 docs/规则拆解与实现方案.md §4）：
     state 纯 JSON 可序列化；apply(g, cmd) 同步执行并可能产生 g.pending；
     legalCommands(g) 列出当前合法命令；snapshot 栈支持 undo；seeded xorshift RNG。
   cmd：{type:'draftPick', pairIdx} / {type:'takeDie', bridge, side} / {type:'placeDie', slot}
        {type:'choose', optionId} / {type:'exchange', id} / {type:'undo'} */
window.WCEngine = (function () {
  'use strict';
  const D = window.WCData;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let autoSeedN = 0;      // 不传 seed 时的开局计数（避免同毫秒重复种子）

  /* ── RNG：xorshift32，状态存于 g.rngState ─────────────── */
  function nextRng(g) {
    let x = (g.rngState >>> 0) || 1;
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    g.rngState = x;
    return x / 4294967296;
  }
  const ri = (g, n) => Math.floor(nextRng(g) * n);
  const roll = (g) => 1 + ri(g, 6);
  function shuffle(g, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = ri(g, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const nid = (g, p) => p + (++g.uid);

  function pushLog(g, text, cls) {
    /* ★ pid = 这条日志发生时的「当前行动玩家」。UI（renderLog）用它给日志条
       上该玩家的颜色边条，一眼区分谁做的操作。
       g._actor 在 apply() 入口按命令类型写好；系统级日志（开局选卡、轮开始等）
       发生在没人行动的时机，_actor 为空 → 不上色。 */
    const entry = { text, cls: cls || 'info' };
    if (g._actor != null) entry.pid = g._actor;
    g.log.unshift(entry);
    if (g.log.length > 200) g.log.pop();
  }
  function notify(g) { if (typeof g.onUpdate === 'function') g.onUpdate(g); }

  /* ── 资源 / 货币 ─────────────────────────────────────── */
  function gain(g, p, what, n) {
    if (n < 0) {                                   // 卡牌效果里的「-N 资源」= 支付
      if (!canPay(p, what, -n)) return false;      // 付不起 → 失败，后续奖励也不给
      pay(g, p, what, -n);
      return;
    }
    if (n === 0) return;
    if (what === 'coins') p.coins += n;
    else if (what === 'seals') p.seals = clamp(p.seals + n, 0, D.SEAL_MAX);
    else p.res[what] = clamp((p.res[what] || 0) + n, 0, D.RES_MAX);
    pushLog(g, `${p.name} 获得 ${n} ${labelOf(what)}`);
  }
  function canPay(p, what, n) {
    if (what === 'coins') return p.coins >= n;
    if (what === 'seals') return p.seals >= n;
    return (p.res[what] || 0) >= n;
  }
  function pay(g, p, what, n) {
    if (!canPay(p, what, n)) return false;
    if (what === 'coins') p.coins -= n;
    else if (what === 'seals') p.seals -= n;
    else p.res[what] -= n;
    if (n > 0) pushLog(g, `${p.name} 支付 ${n} ${labelOf(what)}`, 'pay');
    return true;
  }
  function labelOf(what) {
    return { coins: '钱', seals: '家纹', iron: '铁', food: '食物', pearl: '珍珠' }[what] || what;
  }

  /* ── 影响力轨：跨季付纹【玩家自行选择】────────────────────
     ★ 规则（2026-10 按用户要求改）：跨过检查点时不再自动扣家纹，
       而是弹出选择：付 N 家纹继续前进 / 不付，停在本季最后一格。
       付不起时不给选项，直接停。
     返回 true = 已挂起（g.pending 已设置），false = 已结算完。 */
  function moveTime(g, p, n) {
    const target = clamp(p.time + n, 0, D.INFLUENCE_TRACK.length);
    return stepTime(g, p, target);
  }
  /* 从当前位置往 target 走，遇到第一个检查点就停下来问玩家 */
  function stepTime(g, p, target) {
    if (target <= p.time) { p.time = target; return false; }
    const cp = D.INFLUENCE_TRACK.checkpoints.find((c) => p.time < c.at && target >= c.at);
    if (!cp) {
      p.time = target;
      pushLog(g, `${p.name} 影响力前进至 ${p.time} 格`);
      return false;
    }
    if (p.seals < cp.cost) {
      p.time = cp.at - 1;
      pushLog(g, `${p.name} 家纹不足 ${cp.cost}，影响力停在第 ${p.time} 格`, 'warn');
      return false;
    }
    g.pending = {
      kind: 'timeMove', playerId: p.id, target, cp,
      options: [
        { id: 'pay', label: `支付 ${cp.cost} 家纹，影响力前进至 ${target} 格`, pay: true },
        { id: 'stop', label: `不支付家纹，影响力停在第 ${cp.at - 1} 格`, pay: false }
      ]
    };
    return true;
  }
  /* 玩家选完之后继续走（可能还有下一个检查点） */
  function resolveTimeMove(g, p, pd, opt, rest, ctx) {
    const cp = pd.cp;
    if (opt.pay && p.seals < cp.cost) {          // 中途把家纹换掉了 → 付不起，按「不支付」处理
      p.time = cp.at - 1;
      pushLog(g, `${p.name} 家纹不足，影响力停在第 ${p.time} 格`, 'warn');
      runEffects(g, p, rest || [], ctx);
      return;
    }
    if (opt.pay) {
      p.seals -= cp.cost;
      pushLog(g, `${p.name} 跨季支付 ${cp.cost} 家纹`, 'pay');
      p.time = cp.at;
      const more = pd.target - p.time;
      if (more > 0 && stepTime(g, p, pd.target)) {
        g.pending.rest = rest || [];
        g.pending.ctx = ctx || null;
        return;
      }
      runEffects(g, p, rest || [], ctx);
      return;
    }
    p.time = cp.at - 1;
    pushLog(g, `${p.name} 不支付家纹，影响力停在第 ${p.time} 格`, 'warn');
    runEffects(g, p, rest || [], ctx);
  }
  function inflScore(pos) {
    /* 6–10 = 3 金扇；11–14 = 6；15 = 10；16–20 每格 +1（20 = 15） */
    if (pos >= 15) return 10 + (pos - 15);
    if (pos >= 11) return 6;
    if (pos >= 6) return 3;
    return 0;
  }

  /* ── 灯笼区：全部可见图标 ─────────────────────────────── */
  /* 单张卡 → 它在灯笼区提供的图标（UI 的悬浮提示和这里的汇总共用同一套判定，
     避免两处各写一份、慢慢漂移）。
     判定顺序就是「这张卡是哪种卡」的顺序，别调换：
       1. fx            起始资源卡 / 起始行动卡的卡背卡 / 法令卡
       2. back          城郊卡的卡背（数据总表「卡背」列：+1钱 / +1红扇）
       3. fx3 + dark    房间卡的浅色格
       4. light         晋升翻出的灯笼图标
     注意：城郊卡同时有 back 和 fx3，第 2 条先命中，所以第 3 条对城郊卡是走不到的
     （规则上城郊卡进灯笼区只看卡背，这里是对的；旧注释说「城郊卡＝浅色效果」是错的）。 */
  function lanternCardEffects(c) {
    if (!c) return [];
    /* ★ backFx 优先级最高：这张卡进灯笼区后只结算「卡背」效果。
       起始行动卡 fx 是正面效果（家臣/园丁/武士行动），不能拿来当灯笼图标，
       否则一张「家臣令」进灯笼区会白送一个家臣行动。 */
    if (Array.isArray(c.backFx)) return c.backFx.slice();
    if (Array.isArray(c.fx)) return c.fx.slice();
    if (Array.isArray(c.back)) return c.back.slice();
    if (Array.isArray(c.fx3) && Array.isArray(c.dark)) {
      const out = [];
      c.fx3.forEach((fx, i) => { if (!c.dark[i]) out.push(...(fx || [])); });
      return out;
    }
    if (Array.isArray(c.light)) return c.light.slice();
    return [];
  }
  function lanternEffects(p) {
    const eff = [];
    for (const c of p.lantern) eff.push(...lanternCardEffects(c));
    return eff;
  }

  /* ── 支付先行（结算与展示共用同一条规则）────────────────────
     ★ 一条效果链里所有「支付」({op:'gain', n<0}) 都提到最前面：
         先支付、后奖励，和卡面阅读顺序一致。
       ★ 付不起只跳过【那一条】（2026-10-31 晚按用户要求改）：
         以前是「开链前整体预检，任一支付付不起 → 整条链作废」；
         现在改成逐条执行，哪条付不起就跳过哪条（写一条 warn 日志），
         链里其余效果照常结算。
     ★ describeEffects 用同一个 orderEffects 排序，保证「看到的顺序 = 结算的顺序」。 */
  const isPayEffect = (e) => !!(e && e.op === 'gain' && e.n < 0);
  function orderEffects(effects) {
    const list = (effects || []).slice();
    const pays = list.filter(isPayEffect);
    return pays.length ? pays.concat(list.filter((e) => !isPayEffect(e))) : list;
  }

  /* ── 效果解释器：逐项执行；遇选择则设 g.pending 并把剩余效果挂到 rest ── */
  function applyEffects(g, p, effects, ctx) {
    const list = orderEffects(effects);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      if (e.op === 'lantern') { list.splice(i, 1, ...lanternEffects(p)); i--; continue; }
      const res = applyOne(g, p, e, ctx);
      if (res === 'abort') return true;   // 效果链中断 = 本动作结束（不是挂起）
      if (res) {
        /* 一个特殊效果内部也可能先挂起（例如水井图标的「任选资源」），
           它已经把自己剩余的图标放到 pending.rest；这里把外层效果接在后面，
           不能直接覆盖，否则会丢掉内层待结算效果。 */
        g.pending.rest = (g.pending.rest || []).concat(list.slice(i + 1));
        g.pending.ctx = ctx || null;
        return false;
      }
    }
    return true;
  }
  function runEffects(g, p, effects, ctx) {
    if (applyEffects(g, p, effects, ctx)) postChain(g, ctx);
  }
  function postChain(g, ctx) {
    if (g.phase === 'roundEnd') { advanceRoundEnd(g); return; }
    if (g.phase !== 'play') return;
    /* 还有待选项 / 手里还握着骰子 → 没结束 */
    if (g.pending || g.inHand) return;
    /* 取左端骰的灯笼奖励结算完，还要放骰 */
    if (ctx && ctx.after === 'lanternTake') return;
    /* 其余情况（放骰、嵌套行动链：领地→武士→园丁→家臣…）一律进入「等待结束回合」 */
    g.awaitEnd = true;
  }
  /* ── 灯笼行动：结算灯笼区全部可见图标 ─────────────────────
     after：'take' = 取左端骰时先结算（之后才放骰）
            'place' = 放骰后结算（旧流程，保留兼容） */
  function startLantern(g, p, after) {
    const mode = after || 'place';
    const eff = lanternEffects(p);
    if (!eff.length) {
      pushLog(g, `${p.name} 触发灯笼行动，当前灯笼区无效果`, 'info');
      if (mode === 'place') g.awaitEnd = true;
      return;
    }
    pushLog(g, `${p.name} 触发灯笼行动（${p.lantern.length} 张卡）`, 'act');
    runEffects(g, p, eff, { after: mode === 'take' ? 'lanternTake' : 'lanternPlace', playerId: p.id });
  }
  /* applyOne 返回 true = 已挂起（g.pending 已设置） */
  function applyOne(g, p, e, ctx) {
    switch (e.op) {
      case 'special': return applySpecial(g, p, e, ctx);
      case 'gain': {
        const ok = gain(g, p, e.what, e.n);
        if (ok === false) {
          /* ★ 付不起只跳过这一条，链里其余效果照常（2026-10-31 晚改）。
             以前这里 return 'abort' 会把整条链作废。 */
          pushLog(g, `${p.name} 付不起 ${Math.abs(e.n)} ${labelOf(e.what)}，跳过本条效果`, 'warn');
          return false;
        }
        return false;
      }
      case 'gainAny': {
        if (!e.n) return false;
        g.pending = { kind: 'gainAny', playerId: p.id, pool: (e.pool || ['iron', 'food', 'pearl']).slice(), n: e.n };
        return true;
      }
      case 'fan':
        if (e.kind === 'gold') { p.goldFan += e.n; pushLog(g, `${p.name} 获得 ${e.n} 金扇（终局分）`); }
        else { p.redFan += e.n; pushLog(g, `${p.name} 获得 ${e.n} 红扇`); }
        return false;
      case 'time': return moveTime(g, p, e.n);   // 可能挂起「付不付家纹」的选择
      case 'action': return startAction(g, p, e.kind, ctx);
      case 'castle': return startCastle(g, p, e, ctx);
      case 'promote': return startPromote(g, p, e, ctx);
      case 'outskirtGain': return startOutskirtGain(g, p, e, ctx);
      case 'trainingYellow': return startTrainYellow(g, p, e.n || 1, ctx);
      case 'trainingBlue': return startTrainBlue(g, p, ctx);
      case 'gardenGain': return startGardenGain(g, p, e.n || 1, ctx);
      case 'choose': {
        g.pending = {
          kind: 'choose', playerId: p.id,
          options: e.options.map((effs, i) => ({ id: i, label: describeEffects(effs), effects: effs }))
        };
        return true;
      }
      default: pushLog(g, `未知效果 ${e.op}`, 'warn'); return false;
    }
  }

  /* ── 家族行动 ─────────────────────────────────────────── */
  function startAction(g, p, kind, ctx) {
    switch (kind) {
      case 'well': wellGain(g, p, 1); return false;
      case 'retainer': return startPromote(g, p, { levels: 0 }, ctx);   // levels:0 = 完整家臣行动
      case 'gardener': return startGardener(g, p, ctx);
      case 'samurai': return startSamurai(g, p, ctx);
      case 'domain': return startDomainPick(g, p, ctx);
      default: return false;
    }
  }

  /* 家臣行动：进城门 / 晋升（含行动卡循环、大名层） */
  function retainerOptions(_g, p, free, onlyLevels) {
    const opts = [];
    const G = D.GATE;
    if (!free && p.pools.clan > 0 && p.coins >= G.enterCoins)
      opts.push({ id: 'enter', label: `支付 ${G.enterCoins} 钱，家臣进城门` });
    const ups = [
      { id: 'g1', from: 'gate', to: 'floor1', levels: 1, pearl: G.promote[0].pearl },
      { id: 'g2', from: 'gate', to: 'floor2', levels: 2, pearl: G.promote[1].pearl },
      { id: '12', from: 'floor1', to: 'floor2', levels: 1, pearl: G.promote[0].pearl },
      { id: '13', from: 'floor1', to: 'floor3', levels: 2, pearl: G.promote[1].pearl },
      { id: '23', from: 'floor2', to: 'floor3', levels: 1, pearl: G.promote[0].pearl }
    ];
    for (const u of ups) {
      if (onlyLevels && u.levels !== onlyLevels) continue;
      if (p.clan[u.from] <= 0) continue;
      if (!free && p.res.pearl < u.pearl) continue;
      const layer = { floor1: '地头层', floor2: '使节层', floor3: '大名层' }[u.to];
      opts.push({ id: u.id, label: `${free ? '免费' : `支付 ${u.pearl} 珍珠`}，家臣晋升至${layer}`, up: u });
    }
    return opts;
  }
  function openRetainerMenu(g, p, used, flags, rest, ctx) {
    const all = retainerOptions(g, p, !!flags.free, flags.levels || 0);
    const left = all.filter((o) => !used.includes(o.id));
    const options = left.concat([{ id: '__end', label: `结束家臣行动${used.length ? `（已执行 ${used.length} 个）` : ''}` }]);
    g.pending = { kind: 'retainer', playerId: p.id, used, flags, rest: rest || [], ctx: ctx || null, options };
    return true;
  }
  function startPromote(g, p, e, ctx) {
    const opts = retainerOptions(g, p, !!e.free, e.levels || 0);
    if (!opts.length) { pushLog(g, `${p.name} 无可执行的家臣行动`, 'warn'); return false; }
    return openRetainerMenu(g, p, [], { free: !!e.free, levels: e.levels || 0 }, [], ctx);
  }
  function resolveRetainer(g, p, opt, rest, ctx) {
    const pd = g.pending || {};
    if (opt.id === '__end') { runEffects(g, p, rest, ctx); return; }
    const used = (pd.used || []).concat([opt.id]);
    const again = () => {
      const flags = pd.flags || {};
      const left = retainerOptions(g, p, !!flags.free, flags.levels || 0).filter((o) => !used.includes(o.id));
      if (left.length) { openRetainerMenu(g, p, used, flags, rest, ctx); return true; }
      runEffects(g, p, rest, ctx); return false;
    };
    if (opt.id === 'enter') {
      pay(g, p, 'coins', D.GATE.enterCoins);
      p.pools.clan--; p.clan.gate++;
      pushLog(g, `${p.name} 家臣进入城门`, 'act');
      again(); return;
    }
    const u = opt.up;
    if (u.pearl) pay(g, p, 'pearl', u.pearl);
    p.clan[u.from]--; p.clan[u.to]++;
    pushLog(g, `${p.name} 家臣晋升至${{ floor1: '地头层', floor2: '使节层', floor3: '大名层' }[u.to]}`, 'act');
    if (u.to === 'floor3') {
      /* 大名层：天守阁的房间卡在开局就固定，整局不换、也不会被拿取。
         到这里只从这张卡的 3 个效果里选 1 个（同一个效果整局只能选一次）。 */
      const eff = lanternEffects(p).slice();
      const keep = g.castle.rooms.find((r) => r.def.id === 'r6');
      const kc = keep && keep.card;
      if (!kc) {
        pushLog(g, '大名层房间卡缺失，只结算灯笼效果', 'warn');
        if (again()) return;
        return;
      }
      kc.used = kc.used || [];
      const picks = kc.picks || [];
      const opts = picks.map((fx, i) => ({ id: String(i), effects: fx, label: `房间卡效果${i + 1}：${describeEffects(fx)}` }))
        .filter((o) => !kc.used.includes(o.id));
      if (!opts.length) {
        pushLog(g, '大名层效果已全部选完，只结算灯笼效果', 'warn');
        if (again()) return;
        return;
      }
      g.pending = { kind: 'choose', playerId: p.id, rest: eff.concat(rest || []), ctx: ctx || null, options: opts, roomPick: true };
      return;
    } else {
      /* 1/2 层（城郊卡层）：选该层一张卡收走 */
      const layer = u.to === 'floor1' ? 'a' : 'b';
      const slots = g.outskirts.slots.filter((s) => s.layer === layer && s.card);
      if (!slots.length) { again(); return; }
      g.pending = {
        kind: 'promoteRoom', playerId: p.id, layer, rest: rest || [], ctx: ctx || null,
        /* ★ 只写浅色效果，不写城郊卡名/编号 */
        options: slots.map((s) => ({
          id: String(g.outskirts.slots.indexOf(s)),
          label: `浅色：${describeEffects((s.card.fx3 || []).filter((fx, i) => !(s.card.dark || [])[i]).flat()) || '无奖励'}`
        }))
      };
    }
  }
  function resolvePromoteRoom(g, p, opt, rest, ctx) {
    const slot = g.outskirts.slots[+opt.id];
    const card = slot && slot.card;
    if (!card) { runEffects(g, p, rest || [], ctx); return; }
    slot.card = g.outskirts.decks[slot.layer].pop() || null;
    gainCard(g, p, card);                     // 新卡进个人面板，被替换的卡进灯笼区
    pushLog(g, `${p.name} 收走城郊「${card.name}」`, 'act');
    const lights = [];
    (card.fx3 || []).forEach((fx, i) => {
      if (card.dark && card.dark[i]) return;
      if (fx && fx.length) lights.push({ id: String(i), effects: fx, label: `浅色：${describeEffects(fx)}` });
    });
    if (lights.length === 1) { runEffects(g, p, lights[0].effects.concat(rest || []), ctx); return; }
    if (lights.length > 1) {
      g.pending = { kind: 'choose', playerId: p.id, rest: rest || [], ctx: ctx || null, options: lights };
      return;
    }
    runEffects(g, p, rest || [], ctx);
    /* 家臣到 1/2 层：拿 1 张该层行动卡 → 执行亮色行动 → 翻面进灯笼区（成为后续灯笼奖励来源） */
  }

  /* 园丁行动：庭院卡不再绑定桥，可派到任意一张正面朝上的庭院卡
     ★ 2026-11-19：派遣只看食物。卡上「支付 N 钱」属于到达后的后续效果，
       钱不够也能先把园丁派过去，只是跳过后续效果；钱够时由玩家选择是否执行。
     选项文案只写「条件 + 奖励」，不写庭院卡名。 */
  function startGardener(g, p, _ctx) {
    const opts = [];
    for (const s of g.courtyard.slots) {
      const card = s.card;
      if (!card) continue;
      if (p.pools.gardener <= 0) break;
      if (p.res.food < card.food) continue;
      if (p.gardeners.some((x) => x.cardId === card.id)) continue;
      /* 把 reward 里的负钱拆出来只用于文案提示；派遣本身不再检查钱。 */
      const coinCost = (card.reward || []).reduce((acc, e) => acc + (e.op === 'gain' && e.what === 'coins' && e.n < 0 ? -e.n : 0), 0);
      const endTxt = card.end ? `（终局 ${card.end} 分）` : '';
      const rewardTxt = describeEffects(card.reward);
      const label = coinCost
        ? `支付 ${card.food} 食物派遣；到达后可选：${rewardTxt}${endTxt}`
        : `支付 ${card.food} 食物，${rewardTxt}${endTxt}`;
      opts.push({ id: card.id, label, card, slot: s, coinCost });
    }
    if (!opts.length) { pushLog(g, `${p.name} 无可派遣的庭院`, 'warn'); return false; }
    g.pending = { kind: 'gardener', playerId: p.id, options: opts };
    return true;
  }
  function resolveGardener(g, p, opt, rest, ctx) {
    const card = opt.card;
    /* 食物是唯一的派遣门槛；付了食物就把园丁放上去（终局分照算）。 */
    if (!pay(g, p, 'food', card.food)) {
      pushLog(g, `${p.name} 食物不足（需 ${card.food}），无法派遣园丁`, 'warn');
      g.awaitEnd = true;
      return;
    }
    p.pools.gardener--;
    const slot = g.courtyard.slots.find((s) => s.card && s.card.id === card.id);
    const slotIdx = slot ? g.courtyard.slots.indexOf(slot) : -1;
    p.gardeners.push({ cardId: card.id, layer: slot ? slot.layer : null, idx: slot ? slot.idx : -1, row: slotIdx >= 0 ? Math.floor(slotIdx / 2) : -1 });
    pushLog(g, `${p.name} 派园丁到「${card.name}」`, 'act');

    const reward = card.reward || [];
    const coinCost = reward.reduce((acc, e) => acc + (e.op === 'gain' && e.what === 'coins' && e.n < 0 ? -e.n : 0), 0);
    if (coinCost > 0) {
      if (p.coins < coinCost) {
        pushLog(g, `${p.name} 钱不足 ${coinCost}，园丁已派遣，跳过庭院后续效果`, 'warn');
        runEffects(g, p, rest || [], ctx);
        return;
      }
      /* 钱够：玩家可以选择执行（付钱并拿后续奖励）或不执行（只保留园丁）。 */
      g.pending = {
        kind: 'choose', playerId: p.id,
        title: `园丁已派遣到「${card.name}」：是否执行后续效果？`,
        options: [
          { id: 0, label: `执行：${describeEffects(reward)}`, effects: reward },
          { id: 1, label: '不执行，只保留园丁（终局分照算）', effects: [] }
        ],
        rest: rest || [], ctx: ctx || null
      };
      return;
    }
    runEffects(g, p, reward.concat(rest || []), ctx);
  }

  /* 训练场板块：areas 里扁平取出（含朝上面） */
  function allTrainingTiles(g) {
    return g.training.areas.reduce((acc, a) => acc.concat(a.tiles.map((x) => x.tile)), []);
  }
  function courtyardCard(g, id) {
    const slot = g.courtyard.slots.find((s) => s.card && s.card.id === id);
    return slot ? slot.card : null;
  }

  /* 武士行动：★ 选项只写「支付几铁 → 拿到什么」，不写训练场板块名（2026-10 按用户要求改）
     ★ 区域里有多块板块（如 C13 = 蓝+黄两块）时，效果执行的先后顺序由玩家选
       （2026-10-31 晚按用户要求加），标签末尾标「可自选顺序」。 */
  function startSamurai(g, p, _ctx) {
    const opts = [];
    for (const a of g.training.areas) {
      if (!a.tiles.length) continue;
      const cost = a.def.costIron || 0;
      if (p.pools.samurai <= 0 || p.res.iron < cost) continue;
      const fxAll = a.tiles.reduce((acc, tc) => acc.concat(tc.tile.yellow || []), []);
      const multi = a.tiles.filter((tc) => (tc.tile.yellow || []).length).length > 1;
      opts.push({ id: a.def.id, area: a, cost, label: `支付 ${cost} 铁，${describeEffects(fxAll) || '无奖励'}${multi ? '（可自选顺序）' : ''}` });
    }
    if (!opts.length) { pushLog(g, `${p.name} 无可派遣的训练场区域`, 'warn'); return false; }
    g.pending = { kind: 'samurai', playerId: p.id, options: opts };
    return true;
  }
  function resolveSamurai(g, p, opt, rest, ctx) {
    const a = opt.area || g.training.areas.find((x) => x.def.id === opt.id);
    if (!pay(g, p, 'iron', opt.cost || 0)) {
      pushLog(g, `${p.name} 铁不足（需 ${opt.cost || 0}），无法派遣武士`, 'warn');
      g.awaitEnd = true;
      return;
    }
    p.pools.samurai--;
    if (!p.samuraiDispatch) p.samuraiDispatch = [];
    if (!p.samuraiAreas) p.samuraiAreas = [];
    /* 记一次派遣的铁成本（5/3/1），供右侧「玩家数据」按档统计武士数
       （一次派遣可能拿 2 块标志，但仍只算 1 个武士，所以这里只 push 一次 cost） */
    p.samuraiDispatch.push(opt.cost || a.def.costIron || 0);
    /* 记这次武士落在哪个训练区，供版图棋子按【派遣次数】画圆点。
       不能用 samuraiTiles 反推：板块留在训练场不移除，同一区域反复派遣时
       filter+includes 会被去重，只显示「板块数」个圆点（放 4 个只显示 2 个）。 */
    p.samuraiAreas.push(a.def.id);
    for (const tc of a.tiles) {
      p.samuraiTiles.push(tc.tile.id);
      pushLog(g, `${p.name} 派武士到「${tc.tile.name}」`, 'act');
    }
    /* 板块留在训练场，只拿效果 */
    /* ★ 多块板块 → 弹「先执行哪块」的选择（orderPick 与放骰命中多格共用一套） */
    const seqs = a.tiles
      .filter((tc) => (tc.tile.yellow || []).length)
      .map((tc) => ({ n: tc.tile.name, eff: (tc.tile.yellow || []).slice(), pickLabel: `先执行：${describeEffects(tc.tile.yellow) || '无奖励'}` }));
    if (seqs.length > 1) {
      g.pending = {
        kind: 'orderPick', playerId: p.id, seqs, rest: rest || [], ctx: ctx || null,
        options: seqs.map((s, k) => ({ id: String(k), label: s.pickLabel }))
      };
      return;
    }
    runEffects(g, p, seqs.reduce((acc, s) => acc.concat(s.eff), []).concat(rest || []), ctx);
  }

  /* 领地行动：任选 1 队列领下一格奖励（不放骰、不执行家族行动） */
  function startDomainPick(g, p, _ctx) {
    const qs = p.domain.queues;
    const opts = Object.keys(qs).map((c) => {
      const st = queueStrip()[c];
      /* ★ 与放骰路径同一口径：奖励格 = 已派人数（0–5），与队列放了几颗骰无关 */
      const rewards = (st.rewards || [])[stripIndex(p, c)] || [];
      const cardEff = domainCardEffects(p, c);
      return {
        id: c, cardEff,
        label: describeEffects(rewards.concat(cardEff)) || '无奖励'
      };
    });
    if (!opts.length) { pushLog(g, `${p.name} 无可执行的领地行动`, 'warn'); return false; }
    g.pending = { kind: 'domainPick', playerId: p.id, options: opts };
    return true;
  }
  function queueStrip() { return D.QUEUE_STRIPS.base; }
  /* ★ 队列奖励格下标 = 这一行那个人「已经派出去几个」（0–5），不是放骰次数。
       coral→家臣池 / black→园丁池 / white→武士池；
       已派数 = 5 − 池里剩下的数量（每人 5 个，池见 data.js SETUP）。
     例（用户规则）：家臣已派 0/1/2/3/4/5 个 → 1食 / 2食 / 3食 / 3食+2钱 / 4食+2钱 / 4食+2钱+1纹。 */
  function stripIndex(p, key) {
    const st = queueStrip()[key] || {};
    const pool = st.pool || 'clan';
    const max = { clan: D.SETUP.clanPool, gardener: D.SETUP.gardenerPool, samurai: D.SETUP.samuraiPool }[pool] || 5;
    return clamp(max - (p.pools[pool] || 0), 0, 5);
  }
  /* ── 个人面板行动卡 → 这一行能执行的效果 ────────────────────
     ★ 关键规则（2026-10 按用户反馈修正）：
       个人面板的效果由【行动卡上的人】决定，不是由队列行（骰色）决定。
       以前按行色给「家臣/园丁/武士」行动，导致「家臣令」放进卡槽后，
       放黑骰却触发园丁行动 —— 这就是「用了人，效果不太对」的原因。
     判定：
       起始行动卡（家臣令/庭师令/武家令，data 里 isStartAction=true）
         → 卡上只有一个人物行动，三行通用（取 fx3[0]）；
       城郊卡当行动卡 → 卡面分 3 列，按骰色取对应列（coral=第1列 / black=第2列 / white=第3列）。 */
  function domainCardEffects(p, color) {
    const c = p.domain.actionCard;
    if (!c) return [];
    if (c.isStartAction) return ((c.fx3 && c.fx3[0]) || []).slice();
    const idx = { coral: 0, black: 1, white: 2 }[color] || 0;
    return ((c.fx3 && c.fx3[idx]) || []).slice();
  }

  /* 城堡板块行动（任选房间执行深/浅色行动）—— 选项只写效果，不写卡名 */
  function startCastle(g, p, e, _ctx) {
    const opts = [];
    for (const r of g.castle.rooms) {
      if (!r.card) continue;
      /* 无骰子板块的房间（天守阁）：三种基础骰色的深色行动都可选 */
      const colors = r.def.colorTiles.length
        ? [...new Set(r.def.colorTiles.map((t) => t.color))]
        : ['coral', 'black', 'white'];
      if (e.shade !== 'light') {
        for (const c of colors) {
          if (e.color !== 'any' && e.color !== c) continue;
          opts.push({ id: r.def.id + ':' + c, label: `${D.DIE_COLORS[c].name}深色：${describeEffects(r.card.darkActions[c]) || '无奖励'}`, effects: r.card.darkActions[c] });
        }
      }
      if (e.shade !== 'dark')
        opts.push({ id: r.def.id + ':light', label: `浅色：${describeEffects(r.card.lightActions) || '无奖励'}`, effects: r.card.lightActions });
    }
    if (!opts.length) { pushLog(g, '城堡无可执行的卡牌行动', 'warn'); return false; }
    g.pending = { kind: 'castle', playerId: p.id, n: e.n || 1, color: e.color, shade: e.shade, options: opts };
    return true;
  }

  /* 城郊窗帘行动（经卡牌/板块触发，不送灯笼区）—— 选项只写窗帘效果 */
  function startOutskirtGain(g, p, e, _ctx) {
    const opts = [];
    g.outskirts.slots.forEach((s, i) => {
      if (!s.card) return;
      const cur = e.curtain || 'any';
      if ((cur === 'yellow' || cur === 'any'))
        opts.push({ id: i + ':y', label: `黄窗帘：${describeEffects(s.card.yellow) || '无奖励'}`, effects: s.card.yellow });
      if ((cur === 'blue' || cur === 'any') && (e.free || p.seals >= 1))
        opts.push({ id: i + ':b', label: `蓝窗帘${e.free ? '（免纹）' : '（支付 1 家纹）'}：${describeEffects(s.card.blue) || '无奖励'}`, effects: s.card.blue, seal: !e.free });
    });
    if (!opts.length) { pushLog(g, '城郊无可执行的窗帘行动', 'warn'); return false; }
    g.pending = { kind: 'outskirtGain', playerId: p.id, n: e.n || 1, curtain: e.curtain || 'any', free: !!e.free, options: opts };
    return true;
  }

  /* 训练场黄/蓝面（经仪式板块触发）：只在该面朝上的板块里选 */
  function startTrainYellow(g, p, n, _ctx) {
    if (!n) return false;
    const opts = [];
    for (const a of g.training.areas) for (const t of a.tiles) {
      if (t.side !== 'yellow') continue;
      opts.push({ id: t.tile.id, label: `黄面：${describeEffects(t.tile.yellow) || '无奖励'}`, effects: t.tile.yellow });
    }
    if (!opts.length) return false;
    g.pending = { kind: 'trainYellow', playerId: p.id, n, options: opts };
    return true;
  }
  function startTrainBlue(g, p, _ctx) {
    const opts = [];
    for (const a of g.training.areas) for (const t of a.tiles) {
      if (t.side !== 'blue') continue;
      opts.push({ id: t.tile.id, label: `蓝面：${describeEffects(t.tile.blue) || '无奖励'}`, effects: t.tile.blue });
    }
    if (!opts.length) return false;
    g.pending = { kind: 'trainBlue', playerId: p.id, options: opts };
    return true;
  }

  /* 从自己园丁所在庭院卡领奖励 */
  function startGardenGain(g, p, n, _ctx) {
    const cards = p.gardeners
      .map((gd) => courtyardCard(g, gd.cardId))
      .filter(Boolean);
    const opts = cards.map((c) => ({
      id: c.id,
      label: `${describeEffects(c.reward) || '无奖励'}${c.end ? `（终局 ${c.end} 分）` : ''}`,
      effects: c.reward
    }));
    if (!opts.length) { pushLog(g, `${p.name} 没有在场园丁`, 'warn'); return false; }
    g.pending = { kind: 'gardenGain', playerId: p.id, n, used: [], options: opts };
    return true;
  }

  /* 水井收益：1 纹 + 2 板块收益（珍珠+铁）+ (点数−1) 钱 */
  function wellGain(g, p, val) {
    gain(g, p, 'seals', D.WELL.seal);
    gain(g, p, D.WELL.tiles[0], 1);
    gain(g, p, D.WELL.tiles[1], 1);
    const c = Math.max(0, val - 1);
    if (c) gain(g, p, 'coins', c);
  }

  /* ── 新游戏 ───────────────────────────────────────────── */

  /* ── 开局放置方块标记（13 个）─────────────────────────────
     1) 先在 D3/D4/D5 三个菱形格按任意顺序放红/白/黑
     2) 再按 1..10 放：6≠1、7≠2；8/3/D3、9/4/D4、10/5/D5 三者不能全同色
     红白黑各 5 个，共用 13 个；11/12 从 mk1–mk8 随机取 2 个 */
  function placeMarkers(g) {
    const COL = ['red', 'white', 'black'];
    const rc = () => Math.floor(nextRng(g) * 3);
    for (let attempt = 0; attempt < 500; attempt++) {
      const perm = shuffle(g, COL.slice());     // 红/白/黑各一个，随机排列
      const d = { D3: perm[0], D4: perm[1], D5: perm[2] };
      const c = {};
      for (const n of [1, 2, 3, 4, 5]) c[n] = COL[rc()];
      c[6] = COL[rc()]; if (c[6] === c[1]) continue;
      c[7] = COL[rc()]; if (c[7] === c[2]) continue;
      c[8] = COL[rc()]; if (c[8] === c[3] && c[8] === d.D3) continue;
      c[9] = COL[rc()]; if (c[9] === c[4] && c[9] === d.D4) continue;
      c[10] = COL[rc()]; if (c[10] === c[5] && c[10] === d.D5) continue;
      const all = [].concat(Object.values(c), Object.values(d));
      const cnt = { red: 0, white: 0, black: 0 };
      for (const x of all) cnt[x]++;
      if (cnt.red > 5 || cnt.white > 5 || cnt.black > 5) continue;
      const pool = D.MARKERS.filter((m) => /^mk[1-8]$/.test(m.id)).map((m) => m.id);
      const shuff = shuffle(g, pool.slice());
      return { cells: c, diamonds: d, extras: { 11: shuff[0], 12: shuff[1] } };
    }
    return { cells: { 1: 'red', 2: 'white', 3: 'black', 4: 'red', 5: 'white', 6: 'black', 7: 'red', 8: 'white', 9: 'black', 10: 'red' },
      diamonds: { D3: 'white', D4: 'black', D5: 'red' }, extras: { 11: 'mk1', 12: 'mk2' } };
  }

  function newGame(opts) {
    opts = opts || {};
    const playerCount = clamp(opts.playerCount || 2, 2, 4);
    const g = {
      version: 2,
      /* ★ 不传 seed 时：毫秒时间戳 + 递增计数，避免两次开局落在同一毫秒 → 同一个种子。
         （之前只用 Date.now()%…，连开两局会拿到一样的牌，随机先手也永远是同一个顺序） */
      seed: opts.seed || (((Date.now() % 2147483646) + (++autoSeedN) * 7919) % 2147483646) + 1,
      rngState: 0, uid: 0,
      config: { playerCount, humanSeat: opts.humanSeat || 0, difficulty: opts.difficulty || 'normal', names: opts.names || null },
      phase: 'draft', round: 1, turnIdx: 0,
      turnOrder: null,                              // 下面按「先手 / 后手 / 随机」生成
      players: [], bridges: {}, castle: null, courtyard: {}, training: null,
      well: { dice: [] }, wall: [], outskirts: null,
      inHand: null, pending: null, roundEndQueue: [],
      /* 当前玩家「本回合开始」对应的快照下标；撤销至回合开始用。
         值为 snapshots.length 时表示当前局面本身就是回合开始。 */
      turnStartIdx: 0,
      log: [], snapshots: [], scores: null
    };
    g.rngState = g.seed;

    /* 行动顺序（用户规则）：先手 = 你第一个行动；后手 = 你最后一个行动；
       随机 = 座位顺序随机（每局不同，用本局 RNG，不再固定）。
       选卡顺序永远是行动顺序的逆序（最后行动的人最先选）。 */
    const seatBase = Array.from({ length: playerCount }, (_, i) => i);
    const human = (opts.humanSeat === undefined ? 0 : opts.humanSeat);
    const ord = opts.order || 'first';
    if (ord === 'random') g.turnOrder = shuffle(g, seatBase);
    else if (ord === 'second') g.turnOrder = seatBase.filter((i) => i !== human).concat([human]);
    else g.turnOrder = [human].concat(seatBase.filter((i) => i !== human));

    for (let i = 0; i < playerCount; i++) {
      const pc = D.PLAYER_COLORS[i];
      const isAI = i !== g.config.humanSeat;
      const queues = {};
      const qs = D.QUEUE_STRIPS.base;
      for (const c of Object.keys(qs)) queues[c] = { covered: 0, dice: [] };
      g.players.push({
        id: i, seat: i,
        name: (opts.names && opts.names[i]) || (isAI ? 'AI ' + (i + 1) : '你'),
        color: pc, isAI,
        coins: D.SETUP.coins, seals: D.SETUP.seals, redFan: 0, goldFan: 0, time: 0, vp: 0,
        res: clone(D.SETUP.res),
        pools: { clan: D.SETUP.clanPool, samurai: D.SETUP.samuraiPool, gardener: D.SETUP.gardenerPool },
        clan: { gate: 0, floor1: 0, floor2: 0, floor3: 0 },
        samuraiTiles: [], samuraiDispatch: [], samuraiAreas: [], gardeners: [], daimyo: [],
        domain: { queues, actionCard: null },
        lantern: [], startCard: null
      });
    }

    /* 城堡：6 房间（含第三层天守阁）各配 1 卡，余为牌库 */
    /* 规则：只有天守阁(r6)有房间卡；其余 5 房在家臣晋升时收走该房的城郊卡并补牌 */
    const roomDeck = shuffle(g, D.ROOM_CARDS.map(clone));
    g.castle = {
      rooms: D.ROOM_DEFS.map((def) => ({ def, card: def.id === 'r6' ? roomDeck.pop() : null, dice: [] })),
      deck: roomDeck,
      /* 每层剩余的房间卡：地头层 / 使节层 / 大名层各一堆 */
      roomDecks: {
        f1: roomDeck.slice(0, 3),
        f2: roomDeck.slice(3, 6),
        f3: roomDeck.slice(6)
      },
      daimyoDeck: shuffle(g, D.DAIMYO_CARDS.map(clone))
    };

    /* 庭院：a 列 / b 列各 6 张牌堆，各抽 3 张摆成三行 */
    g.courtyard = { slots: [], decks: {} };
    for (const layer of ['a', 'b'])
      g.courtyard.decks[layer] = shuffle(g, D.COURTYARD_CARDS.filter((c) => c.layer === layer).map(clone));
    /* 6 个槽按 a,b,a,b,a,b 排列：C7=a C8=b C9=a C10=b C11=a C12=b */
    for (let i = 0; i < 3; i++) for (const layer of ['a', 'b'])
      g.courtyard.slots.push({ layer, idx: i, base: 2, card: g.courtyard.decks[layer].pop() || null, dice: [] });

    /* 训练场：bk_L / bk_H 各随机 2 个 → C13 = 1L+1H（5 铁）、C14 = 剩余 L（3 铁）、C15 = 剩余 H（1 铁） */
    const tl = shuffle(g, D.TRAINING_TILES.filter((t) => /^bk_L_/.test(t.id)).map(clone));
    const th = shuffle(g, D.TRAINING_TILES.filter((t) => /^bk_H_/.test(t.id)).map(clone));
    /* ★ 规则（用户指定）：bk_H_8 与 bk_L_2 一局里不能同时出现。
       本局实际用到的是黄面 th[0]、th[1] 和蓝面 tl[0]、tl[1]；
       命中时把蓝2 换成一块本局没用到的蓝面（不重整牌序，牌数不变）。 */
    if (th[0].id === 'bk_H_8' || th[1].id === 'bk_H_8') {
      const bad = tl[0].id === 'bk_L_2' ? 0 : (tl[1].id === 'bk_L_2' ? 1 : -1);
      if (bad >= 0) {
        const j = 2;                       // 第 3 张起都是本局不用的备用蓝面
        [tl[bad], tl[j]] = [tl[j], tl[bad]];
      }
    }
    g.training = {
      areas: [
        { def: { id: 'c13', costIron: 5 }, tiles: [{ tile: tl[0], side: 'blue' }, { tile: th[0], side: 'yellow' }] },
        { def: { id: 'c14', costIron: 3 }, tiles: [{ tile: tl[1], side: 'blue' }] },
        { def: { id: 'c15', costIron: 1 }, tiles: [{ tile: th[1], side: 'yellow' }] }
      ],
      deck: []
    };

    /* 城郊：第一层 3 格（A 堆）· 第二层 2 格（B 堆），基础局也生成 */
    /* 数据总表「备注」：标了「2人局不用」的卡只在 3/4 人局入堆 */
    const artA = shuffle(g, D.ART_CARDS_A.filter((c) => (c.minPlayers || 2) <= playerCount).map(clone));
    const artB = shuffle(g, D.ART_CARDS_B.filter((c) => (c.minPlayers || 2) <= playerCount).map(clone));
    g.outskirts = { slots: [], decks: { a: artA, b: artB } };
    /* 城郊 5 格骰位：印刷点数 —— 地头层那排（layer a）3 点、使节层那排（layer b）4 点 */
    for (let i = 0; i < 3; i++) g.outskirts.slots.push({ layer: 'a', idx: i, base: 3, card: artA.pop() || null, dice: [] });
    for (let i = 0; i < 2; i++) g.outskirts.slots.push({ layer: 'b', idx: i, base: 4, card: artB.pop() || null, dice: [] });
    /* ★ 起始设置约束（用户规则）：摆上版图的 5 张城郊卡，效果1/2/3 三列里
       「深色」不能整列都是深色 —— 即 5 张卡的深色效果不能全落在同一列，否则换 1 张。 */
    ensureOutskirtDarkSpread(g.outskirts);

    g.wall = D.WALL_SLOTS.map((s) => ({ base: s.base, dice: [] }));

    /* 轮骰：每色 = 玩家数 + 1 */
    dealDice(g);

    g.markers = placeMarkers(g);
    /* 水井图标 = 格 11/12 上摆的两个标记（结算：1 家纹 + 这两个标记的图标效果） */
    const ICON_RES = { mk1: 'anyBase', mk2: 'iron', mk3: 'pearl', mk4: 'food', mk5: 'coins', mk6: 'redFan', mk7: 'time', mk8: 'seals' };
    g.well.icons = [g.markers.extras[11], g.markers.extras[12]].map((id) => ICON_RES[id] || 'coins');
    /* 起始选卡：(P+1) 对，逆回合顺序 */
    const resDeck = shuffle(g, D.START_RESOURCE_CARDS.map(clone));
    const actDeck = shuffle(g, D.START_ACTION_CARDS.map(clone));
    /* 起始牌：人数 + 1 组，按顺位依次选 */
    const pairs = [];
    for (let i = 0; i < playerCount + 1; i++)
      pairs.push({ res: resDeck[i % resDeck.length], act: clone(actDeck[i % actDeck.length]) });
    const order = g.turnOrder.slice().reverse();
    /* 选卡顺序 = 行动顺序的逆序：最后行动的人（后手）最先选（P+1 选 1），
       最先行动的人（先手）最后选（剩 2 选 1）；随机局同理按随机行动序逆序。 */
    const draftOrder = order.slice();   // order 已是「末位在前」的选卡序
    g.pending = { kind: 'draft', playerId: draftOrder[0], pairs, order: draftOrder, idx: 0 };
    pushLog(g, '开局选卡：按逆回合顺序每人选一对（资源卡 + 行动卡）');
    return g;
  }
  function activeBridges() { return ['coral', 'black', 'white']; }
  /* 城郊卡「深色」落在哪几列（fx3 下标 0/1/2）。
     ★ 一张卡可能有两列深色（城郊b01 / b07 是 [浅,深,深]），两列都要保留，
       不能只认第一列。 */
  function darkColsOf(card) {
    const d = (card && card.dark) || [];
    const cols = [];
    d.forEach((v, i) => { if (v) cols.push(i); });
    return cols;
  }
  /* ★ 起始设置约束（用户规则）：摆到版图上的 5 张城郊卡（A 堆 3 + B 堆 2），
     效果1 / 效果2 / 效果3 这三列里，不允许某一列是「5 张全深色」。
     命中时从该层牌堆换 1 张「该列不是深色」的卡进来（换下的卡回牌堆底，牌数不变），
     换完重新校验，直到没有整列全深色为止。 */
  function ensureOutskirtDarkSpread(outskirts) {
    const slots = outskirts.slots.filter((s) => s.card);
    if (slots.length < 2) return;
    for (let guard = 0; guard < 10; guard++) {
      const cards = slots.map((s) => s.card);
      const bad = [0, 1, 2].find((col) => cards.every((c) => darkColsOf(c).includes(col)));
      if (bad === undefined) return;
      let swapped = false;
      for (const layer of ['b', 'a']) {
        const deck = outskirts.decks[layer];
        if (!deck.length) continue;
        const slot = slots.find((s) => s.layer === layer && darkColsOf(s.card).includes(bad));
        if (!slot) continue;
        const i = deck.findIndex((c) => !darkColsOf(c).includes(bad));
        if (i < 0) continue;
        const alt = deck.splice(i, 1)[0];
        deck.push(slot.card);            // 换下来的卡放回牌堆底，牌数不变
        slot.card = alt;
        swapped = true;
        break;
      }
      if (!swapped) return;              // 牌堆里已无可用卡 → 保持现状，牌局照常开局
    }
  }

  /* 发骰：每色 P+1 颗，按点数升序排在桥面的【固定落点】上。
     ★ 桥面有 5 个固定落点 1..5（从左到右），不同人数占用不同落点（用户指定）：
          2 人局 → 1,3,5      3 人局 → 1,2,4,5      4 人局 → 1,2,3,4,5
        骰子只能从【落点 1】或【落点 5】取（落点 1 触发灯笼奖励）。
        取走落点 1 的骰后，除落点 5 外最靠近 1 的那颗补到落点 1、其余不动；
        取走落点 5 的骰后，除落点 1 外最靠近 5 的那颗补到落点 5、其余不动。
        （这是「定向补位」，不是整串紧凑，也不是按剩余数量重新均分 —— 二者都是错的。）
        每颗骰记 d.pos（1..5），渲染端（ui.js bridgeDice）按 (pos-1)/4 映射到固定落点。 */
  function dealDice(g) {
    g.bridges = {};
    const count = g.config.playerCount + 1;
    const POS_BY_COUNT = { 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };
    const positions = POS_BY_COUNT[count] || POS_BY_COUNT[5];
    for (const c of activeBridges(g)) {
      const dice = [];
      for (let i = 0; i < count; i++)
        dice.push({ id: nid(g, 'd'), color: c, value: roll(g), owner: null, pos: 0 });
      dice.sort((a, b) => a.value - b.value);            // 按点数升序
      dice.forEach((d, i) => { d.pos = positions[i]; }); // 小的在左、大的在右
      g.bridges[c] = { dice, total: count };
    }
  }

  /* ── 选卡 ─────────────────────────────────────────────── */
  function resolveDraft(g, pairIdx) {
    const pd = g.pending;
    const p = g.players[pd.playerId];
    const pair = pd.pairs.splice(pairIdx, 1)[0];
    const c = pair.res;
    for (const r of ['iron', 'food', 'pearl']) if (c.res[r]) gain(g, p, r, c.res[r]);
    gain(g, p, 'coins', c.coins); gain(g, p, 'seals', c.seals);
    if (c.fan) { p.redFan += c.fan; pushLog(g, `${p.name} 获得 ${c.fan} 红扇`); }
    p.lantern.push(c);                       // 起始资源卡【以卡背】→ 灯笼奖励区
    p.domain.actionCard = pair.act;          // 起始行动卡 → 个人版图行动区（正面朝上，不进灯笼区）
    /* ★ 起始行动卡开局【不进】灯笼区：它要等到被城郊卡替换时才翻面进灯笼区（见 gainCard）。
       它的卡背效果定义在 data.js 的 backFx 字段（三张统一 +1影响力）。 */
    /* 卡面小卷轴 → 另取 1 张法令卡放进灯笼奖励区（数据总表「额外」列）。
       入区顺序：资源卡 → 法令卡，和现实里叠卡的顺序一致。 */
    if (c.decree) {
      const dec = D.DECREE_CARDS && D.DECREE_CARDS[c.decree];
      if (dec) {
        p.lantern.push(Object.assign({}, dec, { isDecree: true }));
        pushLog(g, `${p.name} 另取 1 张「${dec.name}」放入灯笼区（${describeEffects(dec.fx)}）`, 'act');
      } else {
        pushLog(g, `${p.name} 的法令卡类型「${c.decree}」未在 DECREE_CARDS 登记`, 'warn');
      }
    }
    p.startCard = c;
    pushLog(g, `${p.name} 选择「${c.name}」+「${pair.act.name}」`, 'act');
    /* 卡面「任选 N 资源」：先选资源，再继续选卡流程 */
    if (c.anyRes) {
      g.pending = { kind: 'gainAny', playerId: p.id, pool: ['iron', 'food', 'pearl'], n: c.anyRes, rest: [], ctx: null, draft: pd };
      pushLog(g, `${p.name} 需自选 ${c.anyRes} 个资源`, 'info');
      return;
    }
    advanceDraft(g, pd);
  }

  function advanceDraft(g, pd) {
    pd.idx++;
    if (pd.idx >= g.config.playerCount) {
      g.pending = null; g.phase = 'play';
      g.turnStartIdx = g.snapshots.length;   // 选卡结束后的局面 = 第一个回合开始
      pushLog(g, `第 1 轮开始`, 'round');
    } else { g.pending = pd; pd.playerId = pd.order[pd.idx]; }
  }

  /* ── 取骰 / 放骰 ─────────────────────────────────────── */
  function currentPlayer(g) { return g.players[g.turnOrder[g.turnIdx]]; }

  function legalTake(g) {
    const cmds = [];
    for (const b of activeBridges(g)) {
      const br = g.bridges[b];
      if (br.dice.some((d) => d.pos === 1)) cmds.push({ type: 'takeDie', bridge: b, side: 'left' });
      if (br.dice.some((d) => d.pos === 5)) cmds.push({ type: 'takeDie', bridge: b, side: 'right' });
    }
    return cmds;
  }
  function resolveTake(g, cmd) {
    const p = currentPlayer(g);
    const br = g.bridges[cmd.bridge];
    if (!br || !br.dice.length) return;
    const target = cmd.side === 'left' ? 1 : 5;          // 只能从落点 1 或落点 5 取
    const idx = br.dice.findIndex((d) => d.pos === target);
    if (idx < 0) return;                                 // 该端点没骰，不能从这边取
    const die = br.dice.splice(idx, 1)[0];
    die.owner = p.id;
    g.inHand = { die, bridge: cmd.bridge, side: cmd.side, lantern: cmd.side === 'left' };
    pushLog(g, `${p.name} 取${cmd.side === 'left' ? '左(落点1)' : '右(落点5)'} ${D.DIE_COLORS[die.color].name}骰（${die.value} 点）`, 'act');
    if (cmd.side === 'left') {
      /* 落点 1 被取走：除落点 5 外、最靠近 1（pos 最小）的那颗补到落点 1，其余不动 */
      let cand = null;
      for (const d of br.dice) if (d.pos !== 5 && (!cand || d.pos < cand.pos)) cand = d;
      if (cand) cand.pos = 1;
      /* ★ 落点 1 骰＝灯笼奖励，【先结算灯笼，再去放骰】（2026-10 按用户要求改顺序）。 */
      pushLog(g, `${p.name} 先结算个人领地的灯笼区，然后再放骰`, 'info');
      startLantern(g, p, 'take');
    } else {
      /* 落点 5 被取走：除落点 1 外、最靠近 5（pos 最大）的那颗补到落点 5，其余不动 */
      let cand = null;
      for (const d of br.dice) if (d.pos !== 1 && (!cand || d.pos > cand.pos)) cand = d;
      if (cand) cand.pos = 5;
    }
  }

  function mainCap(g) { return g.config.playerCount <= 2 ? 1 : 2; }
  /* 覆盖值＝栏位的【固定】base。差值只看「你这颗粒子点数 − 位置固定 base」，
     不随栏位里已放的骰变化。
     ★ 2026-11-01 修正：之前写成「返回栏内最后一颗骰的值」，导致同栏位放第二颗骰时
        base 被上一颗骰覆盖、diff 变成「相对上一颗骰」而非「相对固定 base」——与规则不符。
     规则：位置 base 是定好的（城堡房间=同色方块数字 / 墙外=5 / 水井=1 / 领地=6），
     每颗骰都只和这个固定 base 比。天守阁(无方块)与水的 fixed 分支本来就是 base，不受影响。 */
  function slotCovered(slot, base) { return base; }

  /* 获得新卡：个人版图只有【一个】行动卡槽，新卡顶掉旧卡，旧卡以卡背形式进灯笼奖励区。
     例：a 替换 b → a 从主板图进行动区，b 从行动区进灯笼区。
     ★ 全流程只用 p.domain.actionCard 这一个字段，不要再加第二个卡槽字段，
       否则「被替换的卡」会漏进灯笼区（旧版用 resourceCard/actionCard 双字段就有这个 bug）。 */
  function gainCard(g, p, card) {
    const old = p.domain.actionCard;
    if (old && old.id !== card.id) {
      p.lantern.push(old);                 // 被替换的卡 → 灯笼奖励区（显示卡背）
      pushLog(g, `「${old.name || old.id}」离开行动区，进入灯笼奖励区`, 'info');
    }
    p.domain.actionCard = card;            // 新卡 → 个人版图行动区
    pushLog(g, `${p.name} 获得「${card.name || card.id}」，放入个人版图行动区`, 'act');
  }
  /* ── 「特殊效果」算子：把数据表里的文字效果落成真实行为 ── */
  function applySpecial(g, p, e, ctx) {
    const note = String(e.note || '');
    const pick = (options, label) => {
      if (!options.length) return false;
      g.pending = { kind: 'choose', playerId: p.id, options, title: label };
      return true;
    };
    /* 水井效果：1 家纹 + 格 11/12 的图标
       ★ 图标里可能有「任选基础资源」。这里必须把图标逐项交给 applyOne，
       遇到 gainAny / timeMove 立即挂起并 return true；否则后续图标或外层效果
       会继续执行，把已经挂起的 gainAny 覆盖掉，玩家就看不到选资源弹窗。 */
    if (note.indexOf('水井') >= 0) {
      gain(g, p, 'seals', 1);
      const iconFx = [];
      for (const t of (g.well.icons || [])) {
        if (t === 'anyBase') iconFx.push({ op: 'gainAny', pool: ['iron', 'food', 'pearl'], n: 1 });
        else if (t === 'time') iconFx.push({ op: 'time', n: 1 });
        else if (t === 'redFan') iconFx.push({ op: 'fan', kind: 'red', n: 1 });
        else iconFx.push({ op: 'gain', what: t, n: 1 });
      }
      for (let i = 0; i < iconFx.length; i++) {
        const r = applyOne(g, p, iconFx[i], ctx);
        if (g.pending) {
          /* 先挂起的选项（任选资源/影响力检查点）负责把剩下的图标继续结算完。 */
          g.pending.rest = (g.pending.rest || []).concat(iconFx.slice(i + 1));
          pushLog(g, `${p.name} 结算水井效果（+1 家纹 + ${(g.well.icons || []).join('/')}）`, 'act');
          return true;
        }
        if (r === 'abort') break;
      }
      pushLog(g, `${p.name} 结算水井效果（+1 家纹 + ${(g.well.icons || []).join('/')}）`, 'act');
      return false;
    }
    /* 任意浅色效果：任选一张城郊卡的一个浅色效果 */
    if (note.indexOf('浅色') >= 0) {
      const opts = [];
      for (const s of g.outskirts.slots) {
        const c = s.card; if (!c) continue;
        (c.fx3 || []).forEach((fx, i) => {
          if ((c.dark || [])[i]) return;
          if (!fx || !fx.length) return;
          opts.push({ id: `${s.layer}${s.idx}:${i}`, effects: fx, label: describeEffects(fx) || '无奖励' });
        });
      }
      return pick(opts, '选择一张城郊卡的浅色效果');
    }
    /* 骰子奖励：主板图上该颜色标记所在的格 → 对应城郊卡的对应效果，任选一个 */
    const colOf = { 红骰子: 'coral', 黑骰子: 'black', 白骰子: 'white' };
    for (const k of Object.keys(colOf)) {
      if (note.indexOf(k) < 0) continue;
      const want = DIE2MK[colOf[k]];
      const opts = [];
      for (const rid of Object.keys(ROOM_CELLS)) {
        const oi = ['r1', 'r2', 'r3', 'r4', 'r5'].indexOf(rid);
        const os = oi >= 0 ? g.outskirts.slots[oi] : null;
        const card = os && os.card;
        if (!card) continue;
        for (const n of ROOM_CELLS[rid]) {
          if (cellMarker(g, n) !== want) continue;
          const fi = CELL_EFFECT[n];
          const fx = card.fx3 && card.fx3[fi];
          if (!fx || !fx.length) continue;
          opts.push({ id: rid + ':' + n, effects: fx, label: describeEffects(fx) || '无奖励' });
        }
      }
      if (!opts.length) { pushLog(g, k + '：主板图上没有同色标记格', 'warn'); return false; }
      return pick(opts, k + '：选择一个城郊卡效果');
    }
    /* 任意骰子 / 玩家面板：三色任选 */
    if (note.indexOf('任意骰子') >= 0) {
      const opts = [];
      for (const rid of Object.keys(ROOM_CELLS)) {
        const oi = ['r1', 'r2', 'r3', 'r4', 'r5'].indexOf(rid);
        const os = oi >= 0 ? g.outskirts.slots[oi] : null;
        const card = os && os.card;
        if (!card) continue;
        for (const n of ROOM_CELLS[rid]) {
          const fi = CELL_EFFECT[n];
          const fx = card.fx3 && card.fx3[fi];
          if (!fx || !fx.length) continue;
          const col = { red: '红', black: '黑', white: '白' }[cellMarker(g, n)] || '?';
          opts.push({ id: rid + ':' + n, effects: fx, label: `格${n}（${col}）「${card.name}」：${describeEffects(fx)}` });
        }
      }
      if (!opts.length) { pushLog(g, '主板图上没有可选的城郊卡效果', 'warn'); return false; }
      return pick(opts, '任意骰子：选择一个城郊卡效果');
    }
    if (note.indexOf('玩家面板') >= 0) {
      const opts = ['coral', 'black', 'white'].map((c) => {
        const st = queueStrip()[c];
        /* ★ 奖励格 = 已派人数（0–5），与队列放了几颗骰无关 */
        const fx = (st.rewards || [])[stripIndex(p, c)] || [];
        const rc = p.domain.actionCard;
        const ci = { coral: 0, black: 1, white: 2 }[c];
        const cardFx = (rc && rc.fx3 && rc.fx3[ci]) || [];
        return { id: c, effects: cardFx.concat(fx), label: describeEffects(cardFx.concat(fx)) || '无奖励' };
      });
      g.pending = { kind: 'choose', playerId: p.id, options: opts, domainAdvance: true, title: '选择个人领地队列' };
      return true;
    }
    /* 任意人物 / 任选人物：家臣/园丁/武士行动任选 */
    if (note.indexOf('人物') >= 0) {
      const opts = [
        { id: 'retainer', effects: [{ op: 'action', kind: 'retainer' }], label: '家臣行动' },
        { id: 'gardener', effects: [{ op: 'action', kind: 'gardener' }], label: '园丁行动' },
        { id: 'samurai', effects: [{ op: 'action', kind: 'samurai' }], label: '武士行动' }
      ];
      return pick(opts, '选择一个人物行动');
    }
    pushLog(g, note + '（暂未实现）', 'warn');
    return false;
  }

  /* 骰色 ↔ 方块色；房间数字格映射 */
  const DIE2MK = { coral: 'red', black: 'black', white: 'white' };
  const CELL_EFFECT = { D3: 0, D4: 0, D5: 0, 3: 1, 4: 1, 5: 1, 8: 2, 9: 2, 10: 2, 1: 0, 2: 0, 6: 2, 7: 2 };
  const ROOM_CELLS = { r1: ['D3', 3, 8], r2: ['D4', 4, 9], r3: ['D5', 5, 10], r4: [1, 6], r5: [2, 7] };
  function cellMarker(g, key) {
    if (!g.markers) return null;
    return String(key)[0] === 'D' ? (g.markers.diamonds || {})[key] : (g.markers.cells || {})[key];
  }
  function roomMatches(g, rid, color) {
    const cells = ROOM_CELLS[rid] || [];
    const want = DIE2MK[color];
    return cells.map((n, i) => ({ n, i, hit: cellMarker(g, n) === want }));
  }
  function roomBase(room) {
    /* ★ 房间的「差值基础值」= 该房间方块(立方体)的固定数值，与骰色无关：
       同房间各 colorTiles 的 num 相同（一层房=3、二层房=4），取 min 即房间固定值。
       原先按骰色过滤 t.color===color，但开局方块是随机摆放的（placeMarkers 必走随机分支），
       经常与该房间 colorTiles 颜色不一致 → 过滤不到 → 返回 0 → 差值算错
       （例如 1 点骰放「鹤之间」本应付 2 钱，却算成 +1 钱）。
       改为取房间统一值后，无论随机到什么方块色，差值都正确。 */
    const nums = room.def.colorTiles.map((t) => t.num);
    return nums.length ? Math.min(...nums) : 0;
  }
  /* 放骰到某房间会命中哪几格、每格给什么效果（resolvePlace 与黑标签预览共用这一份，
     避免「标签写一套、结算另一套」）。 */
  function roomHitSeqs(g, room, color) {
    const oi = ['r1', 'r2', 'r3', 'r4', 'r5'].indexOf(room.def.id);
    const os = oi >= 0 ? g.outskirts.slots[oi] : null;
    const card = os && os.card;
    return roomMatches(g, room.def.id, color).filter((m) => m.hit).map((m) => {
      const ei = CELL_EFFECT[m.n];
      const fi = (ei === undefined ? m.i : ei);
      return { n: m.n, i: m.i, eff: (card && card.fx3 && card.fx3[fi]) || [] };
    });
  }
  /* 枚举全部可放骰位；返回 null 表示不可放 */
  /* ★★ 放置骰子时版图上「带位置名称的黑色标签」文字来源就是这里的 label ★★
     —— 标签写【这一步能拿到的效果】（2026-10 按用户要求再改一次）：
         城堡房间（P1–P5 摆着城郊卡）：骰色命中的格 → 城郊卡对应列的效果
                                      「+2红扇，+1食物」这种；没命中就不会亮
         墙外    ：印的两个行动 → 「家臣行动 或 园丁行动」
         水井    ：1 家纹 + 珍珠 + 铁 + (点数−1) 钱 + 格 11/12 图标
         个人领地：队列下一格奖励 + 行动卡上那个人的行动
       ★ 城郊卡不能放骰（2026-10-31 晚改回），四类落点之外一概不亮。
     想控制「哪些位置会亮」也在这里：
         房间要骰色命中房内方块 → roomMatches / ms.some(m => m.hit)
         房间容量上限           → mainCap(g)（2 人局 1 颗、3–4 人局 2 颗）
         差值付不起就不许放      → tryPush 里的 diff < 0 && p.coins < -diff
     渲染端（谁把 label 变成黑色标签、长什么样）见 js/ui.js 的 hotSlot() 与
     css/style.css 的 .bslot.hot::before / ::after。 */
  function placeTargets(g) {
    const p = currentPlayer(g);
    const die = g.inHand.die;
    const out = [];
    const cap = mainCap(g);
    const tryPush = (id, kind, label, base, slot, extra) => {
      const covered = (extra && extra.fixed) ? base : slotCovered(slot, base);
      const diff = die.value - covered;
      if (diff < 0 && p.coins < -diff) return;                       // 付不起差值
      out.push(Object.assign({ type: 'placeDie', slot: id, kind, label, diff }, extra || {}));
    };
    /* 城堡房间：有板块时颜色须命中；无板块（天守阁）任意骰色可放 */
    for (const r of g.castle.rooms) {
      if (r.dice.length >= cap) continue;
      const ms = roomMatches(g, r.def.id, die.color);
      if (!ms.length) continue;                                  // 天守阁不放骰
      if (!ms.some((m) => m.hit)) continue;                      // 颜色须与该房标记同色
      /* 房间位摆的是城郊卡：命中几格就把那几格的效果叠起来显示 */
      const fx = roomHitSeqs(g, r, die.color).reduce((acc, s) => acc.concat(s.eff), []);
      const noTile = !r.def.colorTiles.length;
      tryPush('room:' + r.def.id, 'room', describeEffects(fx) || '无奖励',
        noTile ? die.value : roomBase(r), r, noTile ? { fixed: true } : null);
    }
    /* 墙外：印两个行动、只能选 1 个 → 标签写「A 或 B」 */
    g.wall.forEach((s, i) => {
      if (s.dice.length >= cap) return;
      const acts = (D.WALL_SLOTS[i] && D.WALL_SLOTS[i].actions) || [];
      const label = acts.map((a) => describeEffects(a)).filter(Boolean).join(' 或 ') || '无奖励';
      tryPush('wall:' + i, 'wall', label, s.base, s);
    });
    /* 水井：不限骰数，栏位值恒 1（不被覆盖） */
    tryPush('well', 'well', describeEffects(wellPreview(g, die.value)), D.WELL.base, g.well, { fixed: true });
    /* ★ 城郊卡【不能放骰】（2026-10-31 晚按用户要求改回）：
       骰子的合法落点只有 4 类 —— 城堡房间骰位 / 墙外 / 水井 / 个人领地队列。
       城郊卡只通过「家臣晋升收卡」「城郊窗帘行动」获得，不走放骰。 */
    /* 个人领地队列：骰色 = 队列色，恒 1 颗；标签 = 下一格奖励 + 家族行动 */
    const qs = p.domain.queues;
    const strips = queueStrip(g);
    if (qs[die.color] && qs[die.color].dice.length < 1) {
      const st = strips[die.color];
      /* ★ 奖励格看「已派几个人」，不看这条队列放了几颗骰 */
      const reward = (st.rewards || [])[stripIndex(p, die.color)] || [];
      tryPush('domain:' + die.color, 'domain',
        describeEffects(reward.concat(domainCardEffects(p, die.color))), st.base, qs[die.color]);
    }
    return out;
  }
  /* 水井预览：1 家纹 + 2 个板块收益 + (点数−1) 钱 + 格 11/12 的两个图标 */
  function wellPreview(g, dieValue) {
    const eff = [{ op: 'gain', what: 'seals', n: D.WELL.seal }];
    for (const t of D.WELL.tiles) eff.push({ op: 'gain', what: t, n: 1 });
    if (dieValue - 1 > 0) eff.push({ op: 'gain', what: 'coins', n: dieValue - 1 });
    for (const t of (g.well.icons || [])) {
      if (t === 'anyBase') eff.push({ op: 'gainAny', pool: ['iron', 'food', 'pearl'], n: 1 });
      else if (t === 'time') eff.push({ op: 'time', n: 1 });
      else if (t === 'redFan') eff.push({ op: 'fan', kind: 'red', n: 1 });
      else eff.push({ op: 'gain', what: t, n: 1 });
    }
    return eff;
  }
  function resolvePlace(g, cmd) {
    const p = currentPlayer(g);
    const die = g.inHand.die;
    const [kind, key] = cmd.slot.split(':');
    let effects = [];
    /* 左端骰的灯笼奖励已经在 resolveTake 里先结算过了，这里只负责放置本身 */
    const ctx = { after: 'place', playerId: p.id };
    const finish = (effs) => {
      g.inHand = null;
      const txt = describeEffects(effs);
      if (txt) {
        pushLog(g, `${p.name} 结算效果：${txt}`, 'info');   // 选完地点后把要执行的效果写出来
        /* g.lastFx 只给 UI 飘提示条用（ui.js 的 flushToast），不参与任何结算；
           只给人类玩家飘，AI 回合不刷屏 */
        if (!p.isAI) g.lastFx = { seq: ((g.lastFx && g.lastFx.seq) || 0) + 1, text: `${p.name}：${txt}` };
      }
      runEffects(g, p, effs, ctx);
    };
    const settle = (slot, base, label, fixed) => {
      const covered = fixed ? base : slotCovered(slot, base);
      const diff = die.value - covered;
      if (diff > 0) gain(g, p, 'coins', diff);
      else if (diff < 0) pay(g, p, 'coins', -diff);
      slot.dice.push(die);
      pushLog(g, `${p.name} 将 ${die.value} 点骰放到${label}${diff ? `（差值 ${diff > 0 ? '+' : ''}${diff} 钱）` : ''}`, 'act');
    };

    if (kind === 'room') {
      const room = g.castle.rooms.find((r) => r.def.id === key);
      const tiles = room.def.colorTiles;
      if (tiles.length) settle(room, roomBase(room), `城堡${room.def.name}`);
      else {
        /* 天守阁无骰子板块：不结算差值（不加值），直接放骰 */
        room.dice.push(die);
        pushLog(g, `${p.name} 将 ${die.value} 点骰放到城堡${room.def.name}`, 'act');
      }
      const ms = roomMatches(g, room.def.id, die.color);
      if (ms.length) {
        /* P1–P5：与骰子同色的方块有几个，就执行几个效果（第 1 格=黄面 / 第 2 格=蓝面） */
        const seqs = roomHitSeqs(g, room, die.color);
        /* 放骰不移动卡牌（卡留在原位，只有人物行动才会收卡） */
        if (seqs.length === 1) {
          effects.push(...seqs[0].eff);
          pushLog(g, `命中 ${room.def.name} 格${seqs[0].n}`, 'info');
        } else if (seqs.length > 1) {
          g.inHand = null;
          pushLog(g, `${p.name} 命中 ${seqs.length} 处，按所选顺序结算：${seqs.map((s) => describeEffects(s.eff) || '无奖励').join('；')}`, 'info');
          g.pending = {
            kind: 'orderPick', playerId: p.id, seqs, rest: effects, ctx,
            options: seqs.map((s, k) => ({ id: String(k), label: `先结算：${describeEffects(s.eff) || '无奖励'}` }))
          };
          return;
        }
      } else if (room.card) {
        for (const eff of (room.card.darkActions[die.color] || [])) effects.push(eff);
      }
      return finish(effects);
    }
    if (kind === 'wall') {
      const s = g.wall[+key];
      settle(s, s.base, `墙外栏位 ${+key + 1}`);
      g.inHand = null;
      const acts = D.WALL_SLOTS[+key].actions;
      pushLog(g, `${p.name} 墙外二选一：${acts.map((a) => describeEffects(a) || '无奖励').join(' 或 ')}`, 'info');
      g.pending = {
        kind: 'wallPick', playerId: p.id, rest: [], ctx,
        options: acts.map((effs, i) => ({ id: i, label: describeEffects(effs) || '无奖励', effects: effs }))
      };
      return;
    }
    if (kind === 'well') {
      settle(g.well, D.WELL.base, '水井', true);
      g.inHand = null;
      /* 水井 = 1 家纹 + 2 个板块收益（珍珠/铁）+ 格 11/12 的两个图标；
         统一走效果链，图标里若有「影响力」也能正确弹出「付不付家纹」的选择 */
      const eff = [{ op: 'gain', what: 'seals', n: 1 }];
      for (const t of D.WELL.tiles) eff.push({ op: 'gain', what: t, n: 1 });
      for (const t of (g.well.icons || [])) {
        if (t === 'redFan') eff.push({ op: 'fan', kind: 'red', n: 1 });
        else if (t === 'anyBase') eff.push({ op: 'gainAny', pool: ['iron', 'food', 'pearl'], n: 1 });
        else if (t === 'time') eff.push({ op: 'time', n: 1 });
        else eff.push({ op: 'gain', what: t, n: 1 });
      }
      pushLog(g, `${p.name} 结算水井：+1 家纹 + ${(g.well.icons || []).join('/') || '无图标'}`, 'act');
      return finish(eff);
    }
    if (kind === 'domain') {
      const q = p.domain.queues[key];
      const st = queueStrip(g)[key];
      settle(q, st.base, `领地${st.laneName}队列`);
      /* ★ 奖励格 = 已派人数（0–5）对应的那一格；q.covered 只作记录 */
      const cell = stripIndex(p, key);
      effects.push(...((st.rewards || [])[cell] || []));
      q.covered++;
      /* ★ 家族行动来自【行动卡上的人】，不是队列行的颜色 */
      effects.push(...domainCardEffects(p, key));
      return finish(effects);
    }
  }
  /* ── choose 统一分派 ─────────────────────────────────── */
  function resolveChoose(g, cmd) {
    const pd = g.pending;
    if (!pd) return;
    const p = g.players[pd.playerId];
    const rest = pd.rest || [];
    const ctx = pd.ctx || null;
    if (pd.kind === 'gainAny') {
      const what = String(cmd.optionId);
      if (!pd.pool.includes(what)) return;
      g.pending = null;
      gain(g, p, what, 1);
      if (pd.n - 1 > 0) g.pending = { kind: 'gainAny', playerId: p.id, pool: pd.pool, n: pd.n - 1, rest, ctx, draft: pd.draft, resume: pd.resume };
      else if (pd.draft) advanceDraft(g, pd.draft);
      else if (pd.resume) { g.pending = pd.resume; refreshPending(g); }   // 兑换完 → 回到兑换前的那个选择弹窗
      else runEffects(g, p, rest, ctx);
      return;
    }
    const opt = pd.options[+cmd.optionId];
    if (!opt) return;
    g.pending = null;
    switch (pd.kind) {
      case 'choose':
      case 'wallPick':
        if (pd.roomPick) {
          const keep = g.castle.rooms.find((r) => r.def.id === 'r6');
          if (keep && keep.card) { keep.card.used = keep.card.used || []; keep.card.used.push(String(opt.id)); }
        }
        runEffects(g, p, (opt.effects || []).concat(rest), ctx); break;
      case 'orderPick': {
        const k = +opt.id;
        const first = pd.seqs[k];
        const restSeqs = pd.seqs.filter((_, idx) => idx !== k);
        const flat = first.eff.concat(...restSeqs.map((x) => x.eff));
        /* 日志直接用按钮文案（已写成「先结算：效果」/「先执行：效果」，不再带格号或板块名） */
        pushLog(g, opt.label || `先结算：${describeEffects(first.eff) || '无奖励'}`, 'act');
        runEffects(g, p, flat.concat(pd.rest || []), ctx);
        break;
      }
      case 'retainer': resolveRetainer(g, p, opt, rest, ctx); break;
      case 'promoteRoom': resolvePromoteRoom(g, p, opt, rest, ctx); break;
      case 'gardener': resolveGardener(g, p, opt, rest, ctx); break;
      case 'samurai': resolveSamurai(g, p, opt, rest, ctx); break;
      case 'domainPick': {
        /* ★ 与放骰路径（resolvePlace 的 domain 分支）严格同款：
           奖励格 = 已派人数（0–5）对应的那一格；q.covered 只作记录。 */
        const q = p.domain.queues[opt.id];
        const st = queueStrip(g)[opt.id];
        const cell = stripIndex(p, opt.id);
        const eff = (st.rewards || [])[cell] || [];
        q.covered++;
        pushLog(g, `${p.name} 执行个人领地「${st.laneName}」：已派 ${cell}/5 → ${describeEffects(eff) || '无奖励'}`, 'act');
        runEffects(g, p, eff.concat(opt.cardEff || []).concat(rest), ctx); break;
      }
      case 'castle': {
        const more = pd.n - 1 > 0 ? [{ op: 'castle', color: pd.color, shade: pd.shade, n: pd.n - 1 }] : [];
        runEffects(g, p, opt.effects.concat(more).concat(rest), ctx);
        break;
      }
      case 'outskirtGain': {
        if (opt.seal) pay(g, p, 'seals', 1);
        const more = pd.n - 1 > 0 ? [{ op: 'outskirtGain', curtain: pd.curtain, n: pd.n - 1, free: pd.free }] : [];
        runEffects(g, p, opt.effects.concat(more).concat(rest), ctx);
        break;
      }
      case 'trainYellow': {
        const more = pd.n - 1 > 0 ? [{ op: 'trainingYellow', n: pd.n - 1 }] : [];
        runEffects(g, p, opt.effects.concat(more).concat(rest), ctx);
        break;
      }
      case 'trainBlue': runEffects(g, p, opt.effects.concat(rest), ctx); break;
      case 'gardenGain': {
        const used = pd.used.concat([opt.id]);
        if (pd.n - 1 > 0) {
          const remain = pd.options.filter((o) => !used.includes(o.id));
          runEffects(g, p, opt.effects, ctx);
          if (!g.pending) {
            if (remain.length) { g.pending = { kind: 'gardenGain', playerId: p.id, n: pd.n - 1, used, options: remain, rest, ctx }; }
            else runEffects(g, p, rest, ctx);
          }
        } else runEffects(g, p, opt.effects.concat(rest), ctx);
        break;
      }
      case 'timeMove': resolveTimeMove(g, p, pd, opt, rest, ctx); break;
      default: break;
    }
  }

  /* ── 回合 / 轮末 ─────────────────────────────────────── */
  function bridgeDiceLeft(g) { return activeBridges(g).reduce((s, b) => s + g.bridges[b].dice.length, 0); }
  function endTurn(g) {
    g.awaitEnd = false;
    const target = 3;
    if (bridgeDiceLeft(g) <= target) return startRoundEnd(g);
    g.turnIdx = (g.turnIdx + 1) % g.turnOrder.length;
    g.turnStartIdx = g.snapshots.length;      // 下一位玩家的回合从这里开始
  }
  function startRoundEnd(g) {
    g.phase = 'roundEnd';
    /* 按影响力重排下一轮顺位：最靠右优先；同格按堆叠（稳定排序 = 保留本轮先后） */
    g.turnOrder.sort((a, b) => g.players[b].time - g.players[a].time);
    pushLog(g, `第 ${g.round} 轮结束，按影响力重排顺位`, 'round');
    if (g.round >= D.SETUP.rounds) return finishGame(g);
    const q = [];
    /* 庭院再激活：按行判断——第 1 行看珊瑚桥、第 2 行看墨桥、第 3 行看白桥，桥上有剩骰才再执行一次 */
    const ROW_BRIDGE = ['coral', 'black', 'white'];
    g.courtyard.slots.forEach((s, i) => {
      const bridge = ROW_BRIDGE[Math.floor(i / 2)];
      if (!g.bridges[bridge] || !g.bridges[bridge].dice.length) return;
      const card = s.card;
      if (!card) return;
      for (const pid of g.turnOrder) {
        const p = g.players[pid];
        if (!p.gardeners.some((x) => x.cardId === card.id)) continue;
        /* 轮末再激活也遵守同一门槛：付不起卡上的钱，就不执行后续效果。 */
        const coinCost = (card.reward || []).reduce((acc, e) => acc + (e.op === 'gain' && e.what === 'coins' && e.n < 0 ? -e.n : 0), 0);
        if (coinCost > 0 && p.coins < coinCost) {
          pushLog(g, `${p.name} 钱不足 ${coinCost}，庭院「${card.name}」本轮不再激活`, 'warn');
          continue;
        }
        q.push({ kind: 'auto', playerId: pid, effects: card.reward, note: `${p.name} 再激活庭院「${card.name}」（${bridge} 桥有剩骰）` });
      }
    });
    g.roundEndQueue = q;
    advanceRoundEnd(g);
  }
  function advanceRoundEnd(g) {
    if (g.pending) return;
    while (g.roundEndQueue.length) {
      const item = g.roundEndQueue.shift();
      if (item.kind === 'auto') {
        g._actor = item.playerId;             // 轮末自动结算也按玩家上色
        pushLog(g, item.note, 'act');
        if (!applyEffects(g, g.players[item.playerId], item.effects, { re: true })) return; // 挂起，解决后继续
        continue;
      }
      g.pending = item;
      return;
    }
    g._actor = null;
    finishRound(g);
  }
  function finishRound(g) {
    /* 收回所有骰 → 重掷重摆 */
    for (const r of g.castle.rooms) r.dice = [];
    g.wall.forEach((s) => (s.dice = []));
    g.well.dice = [];
    g.outskirts.slots.forEach((s) => (s.dice = []));
    for (const p of g.players) for (const c of Object.keys(p.domain.queues)) p.domain.queues[c].dice = [];
    dealDice(g);
    g.round++;
    g.turnIdx = 0;
    g.phase = 'play';
    g.turnStartIdx = g.snapshots.length;      // 新一轮第一位玩家的回合起点
    pushLog(g, `第 ${g.round} 轮开始`, 'round');
  }

  /* ── 终局计分（严格按 md §3 四组）────────────────────── */
  function scoreBreakdown(g, p) {
    const S = D.SCORING;
    const coinsSeals = Math.floor((p.coins + p.seals) / S.coinsSealsPer);
    let resPts = 0;
    for (const r of ['iron', 'food', 'pearl'])
      for (const [th, pts] of S.resTiers) if (p.res[r] >= th) { resPts += pts; break; }
    const timePts = inflScore(p.time);
    const clanPts = p.clan.gate * S.clanPts.gate + p.clan.floor1 * S.clanPts.floor1 + p.clan.floor2 * S.clanPts.floor2 + p.clan.floor3 * S.clanPts.floor3;
    const samuraiValue = p.samuraiTiles.reduce((s, id) => s + (D.TRAINING_TILES.find((t) => t.id === id)?.value || 0), 0);
    /* 武士：城堡里的家臣数 × 训练场标志数量 */
    const trainingPts = p.samuraiTiles.length * (p.clan.floor1 + p.clan.floor2 + p.clan.floor3);
    let gardenPts = 0;
    for (const gd of p.gardeners) {
      const card = courtyardCard(g, gd.cardId);
      if (card) gardenPts += card.end;
    }
    const subtotal = coinsSeals + resPts + timePts + clanPts + trainingPts + gardenPts;
    /* ★ 金扇＝终局分（2026-10 按用户要求改成实时显示）：
         ① 庭院卡上印的金扇子 → 你派了园丁的每张卡的 end 值（= gardenPts）
         ② 效果里直接给的「+N金扇」（大名卡等）→ p.goldFan
       两者都计入总分，所以面板上的「金扇 N」正好等于这一项对总分的贡献。 */
    const goldFanTotal = p.goldFan + gardenPts;
    /* 总分 = 金扇各项 + 红扇（红扇是即时分，也计入） */
    const total = (p.vp || 0) + coinsSeals + resPts + timePts + clanPts + trainingPts + gardenPts + p.goldFan + p.redFan;
    const excludedPts = coinsSeals + p.redFan + goldFanTotal;
    return {
      redFan: p.redFan, goldFan: goldFanTotal, goldFanTokens: p.goldFan,
      coinsSeals, resPts, timePts, clanPts, trainingPts, gardenPts,
      subtotal, excludedPts, vp: p.vp || 0, total
    };
  }
  function finishGame(g) {
    g.phase = 'gameEnd';
    g.scores = g.players.map((p) => ({ pid: p.id, name: p.name, breakdown: scoreBreakdown(g, p) }));
    const ranked = g.scores.slice().sort((a, b) => b.breakdown.total - a.breakdown.total || g.players[a.pid].seat - g.players[b.pid].seat);
    g.winner = ranked[0].pid;
    pushLog(g, `游戏结束！${g.players[g.winner].name} 获胜（${ranked[0].breakdown.total} 分）`, 'round');
  }

  /* ── 命令入口 ─────────────────────────────────────────── */
  function legalCommands(g) {
    if (g.awaitEnd && !g.pending && !g.inHand) {
      const cs = [{ type: 'endTurn', label: '结束回合' }].concat(exchangeCommands(g));
      if (g.snapshots && g.snapshots.length) cs.push({ type: 'undo', label: '撤销' });
      return cs;
    }
    if (g.phase === 'gameEnd') return [];
    const pd = g.pending;
    if (pd) {
      if (pd.kind === 'draft')
        return pd.pairs.map((pair, i) => ({ type: 'draftPick', pairIdx: i, label: `「${pair.res.name}」+「${pair.act.name}」` }));
      let cmds;
      if (pd.kind === 'gainAny')
        cmds = pd.pool.map((r) => ({ type: 'choose', optionId: r, label: `+1 ${labelOf(r)}` }));
      else
        cmds = pd.options.map((o, i) => ({ type: 'choose', optionId: i, label: o.label }));
      /* ★ 弹窗里也能用家纹兑换（可能就是为了凑够这一手要付的资源） */
      cmds = cmds.concat(exchangeCommands(g));
      if (g.snapshots.length) cmds.push({ type: 'undo', label: '撤销' });
      return cmds;
    }
    if (g.phase !== 'play') return [];
    const cmds = g.inHand ? placeTargets(g) : legalTake(g);
    /* 回合内自由兑换（家纹随时可用） */
    for (const ex of exchangeCommands(g)) cmds.push(ex);
    if (g.snapshots.length) cmds.push({ type: 'undo', label: '撤销' });
    return cmds;
  }

  /* 快照：把当前局面压成一条 JSON 字符串塞进 g.snapshots（撤销用）。
     ★ 性能注意：这里必须先把 g.snapshots / g.onUpdate 摘掉再 stringify。
       否则每一步都要把「历史上最多 400 条快照」重新序列化一遍（O(n²)，
       实测单步 10ms、一整局 1 秒，测试要跑好几分钟）。摘掉后单步约 0.3ms。 */
  function snapshot(g) {
    const snaps = g.snapshots;
    const cb = g.onUpdate;
    g.snapshots = [];
    g.onUpdate = null;
    const s = JSON.stringify(g);
    g.snapshots = snaps;
    g.onUpdate = cb;
    snaps.push(s);
    if (snaps.length > 400) {
      snaps.shift();
      /* 丢弃最旧快照后，所有相对 snapshots 的下标都要前移一位。 */
      if (g.turnStartIdx > 0) g.turnStartIdx--;
    }
  }
  function restoreSnapshot(g, s) {
    const snaps = g.snapshots;
    const cb = g.onUpdate;
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, JSON.parse(s));
    g.snapshots = snaps;
    g.onUpdate = cb;
    g._actor = null;                      // 撤销不算任何人的操作，日志不上色
  }
  function undo(g) {
    if (!g.snapshots.length) return false;
    const s = g.snapshots.pop();
    restoreSnapshot(g, s);
    pushLog(g, '撤销一步', 'warn');
    return true;
  }
  /* 撤销至当前玩家「回合开始」：只退本回合内的操作，不碰上一回合。 */
  function canUndoTurn(g) {
    if (!g || g.phase !== 'play' || !g.snapshots) return false;
    return g.snapshots.length > Math.max(0, g.turnStartIdx || 0);
  }
  function undoTurn(g) {
    if (!canUndoTurn(g)) return false;
    const stop = Math.max(0, g.turnStartIdx || 0);
    let s = null;
    /* 逐条弹出但不逐条恢复；最终只恢复「回合开始」那一条，日志也只留一条。 */
    while (g.snapshots.length > stop) s = g.snapshots.pop();
    restoreSnapshot(g, s);
    pushLog(g, '撤销至回合开始', 'warn');
    return true;
  }

  function apply(g, cmd) {
    if (cmd.type === 'undo') { undo(g); notify(g); return g; }
    if (cmd.type === 'undoTurn') { undoTurn(g); notify(g); return g; }
    if (g.phase === 'gameEnd') return g;
    /* ★ 记下「这条命令是谁的」：日志上色（pushLog 读 g._actor）就靠它。
       行动中的连锁（弹窗选择、兑换、roundEnd 里按玩家跑的庭院再激活）
       都发生在 _actor 已设好的窗口内，所以它们的日志也能对上人。 */
    if (cmd.type === 'choose' || cmd.type === 'draftPick')
      g._actor = g.pending ? g.pending.playerId : null;
    else if (cmd.type === 'exchange')
      g._actor = g.pending ? g.pending.playerId : (g.phase === 'play' || g.phase === 'roundEnd' ? currentPlayer(g).id : null);
    else
      g._actor = (g.phase === 'play' || g.phase === 'roundEnd') ? currentPlayer(g).id : null;
    snapshot(g);
    switch (cmd.type) {
      case 'endTurn': endTurn(g); break;
      case 'draftPick': if (g.pending && g.pending.kind === 'draft') resolveDraft(g, cmd.pairIdx); break;
      case 'takeDie': if (!g.pending && g.phase === 'play' && !g.inHand) resolveTake(g, cmd); break;
      case 'placeDie': if (!g.pending && g.phase === 'play' && g.inHand) resolvePlace(g, cmd); break;
      case 'choose': if (g.pending) resolveChoose(g, cmd); break;
      case 'exchange': resolveExchange(g, cmd); break;
      default: break;
    }
    notify(g);
    return g;
  }
  /* ── 家纹兑换：随时可用（含行动结算到一半的弹窗里）──────────
     ★ 2026-10 按用户要求改：家纹不再是「只有回合结束前才能换」，
       而是在任何时刻都能换 —— 包括已经点开「家臣晋升 / 武士行动 / 园丁行动」
       这类选择弹窗、发现珍珠/铁/食物不够的时候。
     做法：
       ① legalCommands() 在「等待结束回合」「有 pending」「正常出牌」三种状态下
          都会追加 exchange 命令；
       ② 兑换本身不改 g.pending：如果是在弹窗里换的，换完把原来的弹窗
          原样塞回去（pd.resume），玩家接着做刚才那个选择。 */
  function exchangeCommands(g) {
    const p = g.pending ? g.players[g.pending.playerId] : (g.phase === 'play' || g.phase === 'roundEnd' ? currentPlayer(g) : null);
    if (!p) return [];
    const out = [];
    for (const ex of D.EXCHANGES) {
      if (ex.cost && ex.cost.seals && p.seals >= ex.cost.seals)
        out.push({ type: 'exchange', id: ex.id, label: ex.name });
    }
    return out;
  }
  function resolveExchange(g, cmd) {
    if (g.phase !== 'play' && g.phase !== 'roundEnd') return;
    const p = g.pending ? g.players[g.pending.playerId] : currentPlayer(g);
    if (!p) return;
    const resume = g.pending;                     // 行动中途兑换：换完继续原来的选择
    if (cmd.id === 'seal2coin' && p.seals >= 1) {
      p.seals--; gain(g, p, 'coins', 1);
      pushLog(g, `${p.name} 用 1 家纹换 1 钱`, 'pay');
      refreshPending(g);                          // 钱变了，家臣「进城门」等选项可能刚变得可用
    } else if (cmd.id === 'seal2res' && p.seals >= 2) {
      p.seals -= 2;
      pushLog(g, `${p.name} 用 2 家纹换 1 资源`, 'pay');
      /* ★ 携带原 pending 的 ctx：兑换完恢复 resume 时，嵌套链后置上下文不丢（2026-11-01 修） */
      g.pending = { kind: 'gainAny', playerId: p.id, pool: ['iron', 'food', 'pearl'], n: 1, rest: [], ctx: (resume && resume.ctx) || null, resume };
    }
  }
  /* 兑换后重算「按资源筛选」的选择弹窗，否则刚换来的资源买不到新选项。
     只重算会因资源变化而变化的几种；其余（城堡/城郊/训练场/晋升）不涉及资源门槛。 */
  function refreshPending(g) {
    const pd = g.pending;
    if (!pd) return;
    const p = g.players[pd.playerId];
    if (!p) return;
    if (pd.kind === 'retainer') openRetainerMenu(g, p, pd.used || [], pd.flags || {}, pd.rest || [], pd.ctx || null);
    else if (pd.kind === 'gardener') {
      /* ★ 兑换后重算园丁弹窗：必须保留原 pending 的 rest/ctx（嵌套链续接 + 后置上下文），
         否则中途用家纹兑换会导致链断裂 / 上下文丢失（2026-11-01 修）。 */
      startGardener(g, p);
      if (g.pending && g.pending.kind === 'gardener') { g.pending.rest = pd.rest; g.pending.ctx = pd.ctx; }
    }
    else if (pd.kind === 'samurai') {
      startSamurai(g, p);
      if (g.pending && g.pending.kind === 'samurai') { g.pending.rest = pd.rest; g.pending.ctx = pd.ctx; }
    }
    else if (pd.kind === 'outskirtGain') startOutskirtGain(g, p, { n: pd.n, curtain: pd.curtain, free: pd.free });
  }

  /* ── 效果文本描述（UI/AI 共用）────────────────────────── */
  /* 说明：返回的是给人看的一行中文，拼在弹窗选项、黑标签、右侧「玩家数据」里。
     两条固定规则（和结算顺序严格一致）：
       ① 支付写在最前面，且写成「支付3铁」而不是「-3铁」（orderEffects 负责排序）
       ② 奖励写成「+3珍珠」；多项之间用「，」分隔
     改文案只改这里。 */
  /* 合并相同效果：+1钱 +1钱 → +2钱 */
  function mergeEffects(list) {
    const out = [];
    const key = (o) => [o.op, o.what || '', o.kind || '', o.note || ''].join('|');
    for (const o of (list || [])) {
      if (!o) continue;
      if (typeof o.n !== 'number') { out.push(Object.assign({}, o)); continue; }
      const hit = out.find((x) => key(x) === key(o));
      if (hit) hit.n += o.n; else out.push(Object.assign({}, o));
    }
    return out.filter((o) => o.n !== 0);
  }
  function describeEffects(effects, sep) {
    return orderEffects(effects).map((e) => {
      switch (e.op) {
        case 'gain': return e.n < 0 ? `支付${-e.n}${labelOf(e.what)}` : `+${e.n}${labelOf(e.what)}`;
        case 'gainAny': return `任选${e.n}资源`;
        case 'fan': return e.kind === 'gold' ? `+${e.n}金扇` : `+${e.n}红扇`;
        case 'time': return `+${e.n}影响力`;
        case 'lantern': return '灯笼奖励';
        case 'special': return e.note || '特殊效果';
        case 'action': return { retainer: '家臣行动', gardener: '园丁行动', samurai: '武士行动', well: '水井行动', domain: '领地行动' }[e.kind] || '行动';
        case 'castle': return '城堡行动';
        case 'promote': return `晋升${e.levels}层`;
        case 'outskirtGain': return '城郊窗帘';
        case 'trainingYellow': return `训练黄面×${e.n}`;
        case 'trainingBlue': return '训练蓝面';
        case 'gardenGain': return `庭院奖励×${e.n}`;
        case 'choose': return '任选其一';
        default: return e.op;
      }
    }).join(sep || ' | ');
  }

  /* ── 不变量（测试用）──────────────────────────────────── */
  function assertInvariants(g) {
    const errs = [];
    const totalDice = activeBridges(g).length * (g.config.playerCount + 1);
    let count = bridgeDiceLeft(g) + g.well.dice.length;
    for (const r of g.castle.rooms) count += r.dice.length;
    g.wall.forEach((s) => (count += s.dice.length));
    g.outskirts.slots.forEach((s) => (count += s.dice.length));
    for (const p of g.players) for (const c of Object.keys(p.domain.queues)) count += p.domain.queues[c].dice.length;
    if (g.inHand) count++;
    if (count !== totalDice) errs.push(`骰子不守恒: ${count} !== ${totalDice}`);
    for (const p of g.players) {
      for (const r of ['iron', 'food', 'pearl'])
        if (p.res[r] < 0 || p.res[r] > D.RES_MAX) errs.push(`资源越界 ${p.name}.${r}=${p.res[r]}`);
      if (p.seals < 0 || p.seals > D.SEAL_MAX) errs.push(`家纹越界 ${p.name}=${p.seals}`);
      if (p.coins < 0) errs.push(`钱币为负 ${p.name}=${p.coins}`);
      const clanTotal = p.pools.clan + p.clan.gate + p.clan.floor1 + p.clan.floor2 + p.clan.floor3;
      if (clanTotal !== D.SETUP.clanPool) errs.push(`家臣不守恒 ${p.name}=${clanTotal}`);
        if (p.pools.gardener + p.gardeners.length !== D.SETUP.gardenerPool) errs.push(`园丁不守恒 ${p.name}`);
      /* 一次武士行动可能同时拿 1~2 块标志（C13 有两块），所以按「用了几个武士」校验 */
    const samuraiUsed = D.SETUP.samuraiPool - p.pools.samurai;
    if (p.pools.samurai < 0 || p.samuraiTiles.length > samuraiUsed * 2) errs.push(`武士不守恒 ${p.name}`);
    }
    const cap = mainCap(g);
    for (const r of g.castle.rooms) if (r.dice.length > cap) errs.push(`房间超容 ${r.def.id}`);
    g.wall.forEach((s, i) => { if (s.dice.length > cap) errs.push(`墙外${i}超容`); });
    return errs;
  }

  return {
    newGame, apply, legalCommands, undo, undoTurn, canUndoTurn, scoreBreakdown, describeEffects, lanternEffects, mergeEffects, lanternCardEffects,
    assertInvariants, currentPlayer, inflScore,
    _test: { moveTime, wellGain, lanternEffects, dealDice }
  };
})();
