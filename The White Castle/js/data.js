/* 姬路城 The White Castle —— 数据定义（基础版）
   所有卡牌/板块效果统一用 Effect DSL 数组表达，由 engine.js 单一解释器结算。
   DSL 操作一览：
     {op:'gain',    what:'coins'|'seals'|'iron'|'food'|'pearl', n}
     {op:'gainAny', pool:['iron','food',...], n}            // n 次任选（逐个产生 pending）
     {op:'fan',     kind:'red'|'gold', n}                   // 红扇立即推分数轨；金扇仅终局
     {op:'time',    n}                                      // 影响力前进 n（引擎处理跨季付纹）
     {op:'lantern'}                                         // 结算灯笼区全部可见图标
     {op:'action',  kind:'retainer'|'gardener'|'samurai'|'well'|'domain'}
     {op:'castle',  color:'coral'|'black'|'white'|'any', shade:'dark'|'light'|'any', n}
     {op:'promote', levels:1|2, free?:true}                 // 幕僚晋升（默认需付珍珠，free 免付）
          {op:'outskirtGain', curtain:'yellow'|'blue'|'any', n, free?:true}
     {op:'trainingYellow', n}                               // 训练场板块黄面奖励 n 次
     {op:'trainingBlue', pick:1, from:2}                    // 训练场蓝面 from 选 pick
     {op:'gardenGain', n}                                   // 从自己园丁所在庭院卡领奖励 n 次
          {op:'choose',  options:[[Effect...],...]}
   凡标【近似】处为版图照片读不出、按效果强度自定的数值。 */
window.WCData = (function () {
  'use strict';

  /* ── 基础常量 ─────────────────────────────────────────── */
  const DIE_COLORS = {
    coral: { id: 'coral', name: '珊瑚', hex: '#c4553f', soft: '#f3ddd6' },
    black: { id: 'black', name: '墨', hex: '#33302e', soft: '#e2dfda' },
    white: { id: 'white', name: '白', hex: '#d9d2c3', soft: '#f6f1e4' },
    green: { id: 'green', name: '松', hex: '#5f8b52', soft: '#e0ead8' }
  };

  const PLAYER_COLORS = [
    { id: 'vermilion', name: '朱', hex: '#b23a2e', clan: '明智', crest: '桔梗' },
    { id: 'indigo', name: '蓝', hex: '#2f5378', clan: '织田', crest: '木瓜' },
    { id: 'gold', name: '金', hex: '#a97c2f', clan: '德川', crest: '三叶葵' },
    { id: 'moss', name: '萌黄', hex: '#5c7a45', clan: '丰臣', crest: '五七桐' }
  ];

  const RESOURCES = {
    iron: { id: 'iron', name: '铁', glyph: '铁', hex: '#566573' },
    food: { id: 'food', name: '食物', glyph: '食', hex: '#a8763e' },
    pearl: { id: 'pearl', name: '珍珠', glyph: '珠', hex: '#7d8fa6' },
  };
  const RES_MAX = 7;      // 资源 0–7 记录轨【书·基础 p05】
  const SEAL_MAX = 5;     // 家纹上限 5【书·基础 p12】

  const BRIDGES = [
    { id: 'coral', name: '珊瑚桥' },
    { id: 'black', name: '墨桥' },
    { id: 'white', name: '白桥' },
  ];


  /* ── 分数轨：1–40 循环，满 40 拿 +40 板、再满翻 +80 ── */
  const SCORE_TRACK = { lap: 40, maxBonus: { base: 80 } };

  /* ── 时间流逝轨（影响力）：20 格绿环，读自主版图照片
     检查点：进第 6 格付 1 纹、第 11 格付 2 纹、第 15 格付 3 纹（付不起停在本季）
     终局分：第 6–10 格 3 分；第 11–14 格 6 分；第 15–20 格按格 10/11/12/13/14/15 分 */
  const INFLUENCE_TRACK = {
    length: 20,
    /* 跨格支付：5→6 付 1 纹；10→11 付 2 纹；14→15 付 3 纹 */
    checkpoints: [
      { at: 6, cost: 1 },
      { at: 11, cost: 2 },
      { at: 15, cost: 3 }
    ],
    // scoreAt(pos)：由引擎实现 —— pos>=10 → 10+(pos-10)；>=6 → 6；>=3 → 3；否则 0
    seasonScores: { 2: 3, 3: 6 },
    season4Base: 10   // 第 15 格 = 10 分，每格 +1
  };

  /* ── 终局计分常量【书·基础 p14】─────────────────────── */
  const SCORING = {
    coinsSealsPer: 5,                       // (钱+纹) 每 5 = 1 分
    resTiers: [[7, 2], [3, 1]],             // 每种资源 >=7 → 2 分；>=3 → 1 分
    clanPts: { gate: 1, floor1: 3, floor2: 6, floor3: 10 }
  };

  /* ── 城堡 6 房间：每房 1 骰位 + 2 个骰子板块（颜色+编号，读自主版图照片）
     规则书基础 p02·步骤4：「每个房间必须拥有至少 2 种不同的骰子颜色」。
     旧版把地头 3 房做成同色×2（等于每次放置都执行 2 次行动），既违反该条，
     又让「地头层同色出现两次可执行 2 个行动」的分支恒真。此处改为双色分配。
     同色×2 的乘法逻辑仍保留在引擎里（4 人局或未来换板块时仍可能触发）。
     放置差值结算基准 = 匹配颜色板块的编号；同色两板块取较小者。【板块编号沿用原分配】
     第三层「天守阁」只放 1 张房间卡，没有骰子板块（colorTiles 为空）：
     任意骰色都可放入，且不结算差值加值。 */
  const ROOM_DEFS = [
    { id: 'r1', name: '千叠室', floor: 1, colorTiles: [{ color: 'coral', num: 3 }, { color: 'black', num: 3 }] },
    { id: 'r2', name: '松之间', floor: 1, colorTiles: [{ color: 'black', num: 3 }, { color: 'white', num: 3 }] },
    { id: 'r3', name: '鹤之间', floor: 1, colorTiles: [{ color: 'white', num: 3 }, { color: 'coral', num: 3 }] },
    { id: 'r4', name: '梅之间', floor: 2, colorTiles: [{ color: 'coral', num: 4 }, { color: 'black', num: 4 }] },
    { id: 'r5', name: '桐之间', floor: 2, colorTiles: [{ color: 'white', num: 4 }, { color: 'coral', num: 4 }] },
    { id: 'r6', name: '天守阁', floor: 3, colorTiles: [] }
  ];

  /* ── 房间标记（assets/tiles 的 256px 图标）：放在版图上房间里的印刷标记位 ── */
  const MARKERS = [
    { id: 'mk1', name: '任意一基础', img: 'tiles/mk1.png' },
    { id: 'mk2', name: '铁', img: 'tiles/mk2.png' },
    { id: 'mk3', name: '珍珠', img: 'tiles/mk3.png' },
    { id: 'mk4', name: '食物', img: 'tiles/mk4.png' },
    { id: 'mk5', name: '钱', img: 'tiles/mk5.png' },
    { id: 'mk6', name: '红扇', img: 'tiles/mk6.png' },
    { id: 'mk7', name: '影响力', img: 'tiles/mk7.png' },
    { id: 'mk8', name: '家纹', img: 'tiles/mk8.png' },
    { id: 'mk_a', name: '红方块', img: 'tiles/mk_a.png' },
    { id: 'mk_b', name: '黑方块', img: 'tiles/mk_b.png' },
    { id: 'mk_c', name: '白方块', img: 'tiles/mk_c.png' }
  ];

  /* ── 版图标记格（13 个放方块 + 2 个额外标记位）──
     1..10 = 数字格；D3/D4/D5 = 地头层三个菱形格（先放红/白/黑）；11/12 = 水井旁，放 mk1–mk8 随机 2 个 */
  const MARKER_CELLS = {
    nums: {
      1: [44.6, 47.6], 2: [66.6, 47.6], 3: [40.4, 74.1], 4: [62.3, 74.0], 5: [84.4, 73.7],
      6: [44.6, 59.0], 7: [66.6, 59.0], 8: [40.4, 79.6], 9: [62.3, 79.5], 10: [84.4, 79.2]
    },
    diamonds: { D3: [40.4, 68.2], D4: [62.3, 68.1], D5: [84.4, 67.8] },
    extras: { 11: [38.0, 91.2], 12: [38.0, 96.4] }
  };

  /* ── 城堡房间卡（imgFile = assets/cards/cut/room/room-rXcY.png 真实卡面实拍）
     darkActions 按骰色查表执行（深色背景）；lightActions 为幕僚晋升到该层时执行（浅色背景）；
     lantern 为该卡日后被翻出进灯笼区时的可见图标。
     图：横版三栏，下半为灰色剪影装饰，游戏里用 只显示上半。【近似】三色深色行动相同。 */
  const ROOM_CARDS = [
    { id: 'rc1', name: '习武之间', imgFile: 'cards/cut/room/room-r1c1.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'iron', n: 2 }], black: [{ op: 'gain', what: 'iron', n: 2 }], white: [{ op: 'gain', what: 'iron', n: 2 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 1 }], lantern: [{ op: 'gain', what: 'coins', n: 1 }], picks: [[{ op: 'special', note: '任意浅色效果' }], [{ op: 'gain', what: 'iron', n: 2 }], [{ op: 'gain', what: 'coins', n: 2 }]], used: [] },
    { id: 'rc2', name: '五谷之间', imgFile: 'cards/cut/room/room-r1c2.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 5 }], black: [{ op: 'gain', what: 'food', n: 5 }], white: [{ op: 'gain', what: 'food', n: 5 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 4 }], lantern: [{ op: 'gain', what: 'food', n: 1 }], picks: [[{ op: 'special', note: '水井效果' }], [{ op: 'fan', kind: 'red', n: 2 }], [{ op: 'gain', what: 'seals', n: 2 }]], used: [] },
    { id: 'rc3', name: '渡桥之间', imgFile: 'cards/cut/room/room-r1c3.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'seals', n: 1 }, { op: 'time', n: 1 }], black: [{ op: 'gain', what: 'seals', n: 1 }, { op: 'time', n: 1 }], white: [{ op: 'gain', what: 'seals', n: 1 }, { op: 'time', n: 1 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 1 }], lantern: [{ op: 'gain', what: 'coins', n: 1 }], picks: [[{ op: 'special', note: '水井效果' }], [{ op: 'gain', what: 'food', n: 2 }], [{ op: 'time', n: 2 }]], used: [] },
    { id: 'rc4', name: '稻田之间', imgFile: 'cards/cut/room/room-r1c4.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 4 }], black: [{ op: 'gain', what: 'food', n: 4 }], white: [{ op: 'gain', what: 'food', n: 4 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 3 }], lantern: [{ op: 'gain', what: 'food', n: 1 }], picks: [[{ op: 'special', note: '任意浅色效果' }], [{ op: 'gain', what: 'pearl', n: 2 }], [{ op: 'fan', kind: 'red', n: 2 }]], used: [] },
    { id: 'rc5', name: '天守之间', imgFile: 'cards/cut/room/room-r2c1.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'fan', kind: 'red', n: 2 }], black: [{ op: 'fan', kind: 'red', n: 2 }], white: [{ op: 'fan', kind: 'red', n: 2 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 2 }], lantern: [{ op: 'fan', kind: 'red', n: 1 }], picks: [[{ op: 'lantern' }], [{ op: 'gain', what: 'iron', n: 2 }], [{ op: 'gain', what: 'seals', n: 2 }]], used: [] },
    { id: 'rc6', name: '青苗之间', imgFile: 'cards/cut/room/room-r2c2.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 3 }], black: [{ op: 'gain', what: 'food', n: 3 }], white: [{ op: 'gain', what: 'food', n: 3 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 2 }], lantern: [{ op: 'gain', what: 'food', n: 1 }], picks: [[{ op: 'lantern' }], [{ op: 'time', n: 2 }], [{ op: 'gain', what: 'coins', n: 3 }]], used: [] },
    { id: 'rc7', name: '旗印之间', imgFile: 'cards/cut/room/room-r2c3.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'iron', n: 2 }, { op: 'fan', kind: 'red', n: 1 }], black: [{ op: 'gain', what: 'iron', n: 2 }, { op: 'fan', kind: 'red', n: 1 }], white: [{ op: 'gain', what: 'iron', n: 2 }, { op: 'fan', kind: 'red', n: 1 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 1 }], lantern: [{ op: 'gain', what: 'coins', n: 1 }], picks: [[{ op: 'special', note: '红骰子奖励' }], [{ op: 'special', note: '黑骰子奖励' }], [{ op: 'special', note: '白骰子奖励' }]], used: [] },
    { id: 'rc8', name: '早苗之间', imgFile: 'cards/cut/room/room-r2c4.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 3 }], black: [{ op: 'gain', what: 'food', n: 3 }], white: [{ op: 'gain', what: 'food', n: 3 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 2 }], lantern: [{ op: 'gain', what: 'food', n: 1 }], picks: [[{ op: 'special', note: '任意浅色效果' }], [{ op: 'time', n: 2 }], [{ op: 'gain', what: 'seals', n: 2 }]], used: [] },
    { id: 'rc9', name: '庭师之间', imgFile: 'cards/cut/room/room-r3c1.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 2 }, { op: 'gain', what: 'pearl', n: 1 }], black: [{ op: 'gain', what: 'food', n: 2 }, { op: 'gain', what: 'pearl', n: 1 }], white: [{ op: 'gain', what: 'food', n: 2 }, { op: 'gain', what: 'pearl', n: 1 }] }, lightActions: [{ op: 'time', n: 1 }], lantern: [{ op: 'gain', what: 'iron', n: 1 }], picks: [[{ op: 'lantern' }], [{ op: 'gain', what: 'food', n: 2 }], [{ op: 'fan', kind: 'red', n: 2 }]], used: [] },
    { id: 'rc10', name: '稻荷之间', imgFile: 'cards/cut/room/room-r3c2.png', backFile: 'cards/cut/_backs/back-room.png', darkActions: { coral: [{ op: 'gain', what: 'food', n: 4 }], black: [{ op: 'gain', what: 'food', n: 4 }], white: [{ op: 'gain', what: 'food', n: 4 }] }, lightActions: [{ op: 'fan', kind: 'red', n: 3 }], lantern: [{ op: 'gain', what: 'food', n: 1 }], picks: [[{ op: 'special', note: '水井效果' }], [{ op: 'gain', what: 'pearl', n: 2 }], [{ op: 'gain', what: 'coins', n: 3 }]], used: [] },
  ];

  const ART_EFFECTS = [
    { fx3: [[{ op: 'action', kind: 'retainer' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gain', what: 'seals', n: 1 }, { op: 'fan', kind: 'red', n: 1 }], [{ op: 'lantern' }, { op: 'gain', what: 'food', n: 1 }]], dark: [true, false, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'time', n: 1 }], [{ op: 'action', kind: 'gardener' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gain', what: 'food', n: 2 }]], dark: [false, true, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'time', n: 1 }], [{ op: 'gain', what: 'pearl', n: 2 }], [{ op: 'action', kind: 'samurai' }, { op: 'gain', what: 'seals', n: -1 }]], dark: [false, false, true], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'samurai' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'special', note: '水井效果' }, { op: 'gain', what: 'coins', n: 1 }], [{ op: 'lantern' }]], dark: [true, false, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'time', n: 1 }], [{ op: 'gain', what: 'iron', n: 2 }]], dark: [true, false, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'special', note: '水井效果' }, { op: 'gain', what: 'coins', n: 1 }], [{ op: 'action', kind: 'retainer' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gain', what: 'food', n: 2 }]], dark: [false, true, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'gainAny', n: 2 }], [{ op: 'lantern' }, { op: 'gain', what: 'pearl', n: 1 }], [{ op: 'action', kind: 'samurai' }, { op: 'gain', what: 'seals', n: -1 }]], dark: [false, false, true], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'gainAny', n: 1 }, { op: 'gain', what: 'seals', n: 1 }], [{ op: 'action', kind: 'retainer' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gain', what: 'iron', n: 1 }, { op: 'gain', what: 'food', n: 1 }]], dark: [false, true, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'lantern' }], [{ op: 'fan', kind: 'red', n: 2 }]], dark: [true, false, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'gain', what: 'iron', n: 2 }], [{ op: 'lantern' }], [{ op: 'action', kind: 'gardener' }, { op: 'gain', what: 'seals', n: -1 }]], dark: [false, false, true], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'lantern' }, { op: 'gain', what: 'iron', n: 1 }], [{ op: 'action', kind: 'gardener' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gainAny', n: 2 }]], dark: [false, true, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'special', note: '水井效果' }, { op: 'gain', what: 'coins', n: 1 }], [{ op: 'action', kind: 'gardener' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'time', n: 1 }]], dark: [false, true, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'fan', kind: 'red', n: 2 }], [{ op: 'gainAny', n: 1 }, { op: 'gain', what: 'seals', n: 1 }], [{ op: 'action', kind: 'samurai' }, { op: 'gain', what: 'seals', n: -1 }]], dark: [false, false, true], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'gain', what: 'pearl', n: 2 }], [{ op: 'gain', what: 'seals', n: 1 }, { op: 'fan', kind: 'red', n: 1 }], [{ op: 'action', kind: 'gardener' }, { op: 'gain', what: 'seals', n: -1 }]], dark: [false, false, true], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'samurai' }, { op: 'gain', what: 'seals', n: -1 }], [{ op: 'gain', what: 'food', n: 1 }, { op: 'gain', what: 'pearl', n: 1 }], [{ op: 'lantern' }, { op: 'gain', what: 'iron', n: 1 }]], dark: [true, false, false], back: [{ op: 'gain', what: 'coins', n: 1 }] },
    { fx3: [[{ op: 'special', note: '水井效果' }, { op: 'fan', kind: 'red', n: 2 }], [{ op: 'action', kind: 'gardener' }], [{ op: 'action', kind: 'gardener' }]], dark: [false, true, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }], [{ op: 'special', note: '水井效果' }, { op: 'fan', kind: 'red', n: 2 }], [{ op: 'special', note: '水井效果' }, { op: 'fan', kind: 'red', n: 2 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'lantern' }, { op: 'gain', what: 'coins', n: 2 }], [{ op: 'lantern' }, { op: 'gain', what: 'coins', n: 2 }], [{ op: 'action', kind: 'samurai' }]], dark: [false, false, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'lantern' }, { op: 'time', n: 1 }], [{ op: 'lantern' }, { op: 'time', n: 1 }], [{ op: 'action', kind: 'gardener' }]], dark: [false, false, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }], [{ op: 'time', n: 2 }], [{ op: 'time', n: 2 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'gainAny', n: 3 }], [{ op: 'gainAny', n: 3 }], [{ op: 'action', kind: 'gardener' }]], dark: [false, false, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'time', n: 2 }], [{ op: 'action', kind: 'gardener' }], [{ op: 'action', kind: 'gardener' }]], dark: [false, true, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }], [{ op: 'gainAny', n: 3 }], [{ op: 'gainAny', n: 3 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'samurai' }], [{ op: 'gainAny', n: 3 }], [{ op: 'gainAny', n: 3 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'special', note: '水井效果' }, { op: 'fan', kind: 'red', n: 2 }], [{ op: 'special', note: '水井效果' }, { op: 'fan', kind: 'red', n: 2 }], [{ op: 'action', kind: 'samurai' }]], dark: [false, false, true], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'samurai' }], [{ op: 'time', n: 2 }], [{ op: 'time', n: 2 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] },
    { fx3: [[{ op: 'action', kind: 'retainer' }], [{ op: 'lantern' }, { op: 'gain', what: 'seals', n: 1 }], [{ op: 'lantern' }, { op: 'gain', what: 'seals', n: 1 }]], dark: [true, false, false], back: [{ op: 'fan', kind: 'red', n: 1 }] }
  ];
  const ART_FILES_A = ['r1c1', 'r1c2', 'r1c3', 'r1c4', 'r2c1', 'r2c2', 'r2c3', 'r2c4', 'r3c1', 'r3c2', 'r3c3', 'r3c4', 'r4c1', 'r4c2', 'r4c3'];
  const ART_FILES_B = ['r1c1', 'r1c2', 'r1c3', 'r2c1', 'r2c2', 'r2c3', 'r3c1', 'r3c2', 'r3c3', 'r4c1', 'r4c2', 'r4c3'];
  /* 数据总表「备注」列 = 「2人局不用」的城郊卡：只在 3/4 人局入牌堆 */
  const ART_MIN_PLAYERS_3 = ['oa01', 'oa07', 'oa09', 'oa11', 'oa12', 'oa13', 'ob06', 'ob08', 'ob10'];
  const buildArtDeck = (prefix, layer, files, dir) => files.map((f, i) => {
    const base = dir === 'outskirt-a' ? 0 : 15;
  const eff = ART_EFFECTS[base + i];
    const num = String(i + 1).padStart(2, '0');
    const id = prefix + num;
    return {
      id, name: `城郊${layer}${num}`, layer,
      minPlayers: ART_MIN_PLAYERS_3.includes(id) ? 3 : 2,
      fx3: eff.fx3, dark: eff.dark, back: eff.back, yellow: [], blue: [],
      imgFile: `cards/cut/${dir}/${dir}-${f}.jpg`, backFile: `cards/cut/${dir}/back.jpg`
    };
  });
  const ART_CARDS_A = buildArtDeck('oa', 'a', ART_FILES_A, 'outskirt-a');
  const ART_CARDS_B = buildArtDeck('ob', 'b', ART_FILES_B, 'outskirt-b');
  const COURTYARD_CARDS = [
    { id: 'g1', name: '庭院a01', layer: 'a', food: 2, reward: [{ op: 'gain', what: 'seals', n: 2 }], end: 3, imgFile: 'cards/cut/castle-a/castle-a-01.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g2', name: '庭院a02', layer: 'a', food: 1, reward: [{ op: 'gain', what: 'coins', n: 3 }], end: 1, imgFile: 'cards/cut/castle-a/castle-a-02.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g3', name: '庭院a03', layer: 'a', food: 1, reward: [{ op: 'gainAny', n: 2 }], end: 1, imgFile: 'cards/cut/castle-a/castle-a-03.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g4', name: '庭院a04', layer: 'a', food: 2, reward: [{ op: 'lantern' }], end: 3, imgFile: 'cards/cut/castle-a/castle-a-04.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g5', name: '庭院a05', layer: 'a', food: 3, reward: [{ op: 'special', note: '水井效果' }], end: 5, imgFile: 'cards/cut/castle-a/castle-a-05.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g6', name: '庭院a06', layer: 'a', food: 2, reward: [{ op: 'special', note: '任意浅色奖励' }], end: 3, imgFile: 'cards/cut/castle-a/castle-a-06.jpg', backFile: 'cards/cut/_backs/back-castle-a.png', },
    { id: 'g7', name: '庭院b01', layer: 'b', food: 5, reward: [{ op: 'gain', what: 'coins', n: -4 }, { op: 'special', note: '任意骰子奖励' }], end: 9, imgFile: 'cards/cut/castle-b/castle-b-01.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    { id: 'g8', name: '庭院b02', layer: 'b', food: 4, reward: [{ op: 'gain', what: 'coins', n: -3 }, { op: 'action', kind: 'gardener' }], end: 7, imgFile: 'cards/cut/castle-b/castle-b-02.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    { id: 'g9', name: '庭院b03', layer: 'b', food: 3, reward: [{ op: 'gain', what: 'coins', n: -4 }, { op: 'special', note: '任意人物奖励' }], end: 5, imgFile: 'cards/cut/castle-b/castle-b-03.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    { id: 'g10', name: '庭院b04', layer: 'b', food: 3, reward: [{ op: 'gain', what: 'coins', n: -4 }, { op: 'special', note: '玩家面板奖励' }], end: 5, imgFile: 'cards/cut/castle-b/castle-b-04.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    { id: 'g11', name: '庭院b05', layer: 'b', food: 4, reward: [{ op: 'gain', what: 'coins', n: -3 }, { op: 'action', kind: 'samurai' }], end: 7, imgFile: 'cards/cut/castle-b/castle-b-05.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    { id: 'g12', name: '庭院b06', layer: 'b', food: 4, reward: [{ op: 'gain', what: 'coins', n: -3 }, { op: 'action', kind: 'retainer' }], end: 7, imgFile: 'cards/cut/castle-b/castle-b-06.jpg', backFile: 'cards/cut/_backs/back-castle-b.png', },
    ];

  /* ── 训练场板块：13 块双面（黄=奖励面 / 蓝=行动面），每局抽 4 块
     配对与文字取自 Mods 标注（wc-labeled.txt）；imgY 为 assets/tiles/try-*.jpg 黄面实拍；
     蓝面无图（仅文字 textB）。ironCost / value 版图读不出，按效果强度 1–3 自定【近似】 */
  const TRAINING_TILES = [
    { id: 'bk_H_1', name: '黄1', imgY: 'tiles/bk_H_1.jpg', yellow: [{ op: 'special', note: '水井效果' }], blue: [] },
    { id: 'bk_H_2', name: '黄2', imgY: 'tiles/bk_H_2.jpg', yellow: [{ op: 'special', note: '任选一浅色奖励' }], blue: [] },
    { id: 'bk_H_3', name: '黄3', imgY: 'tiles/bk_H_3.jpg', yellow: [{ op: 'gain', what: 'coins', n: 5 }], blue: [] },
    { id: 'bk_H_4', name: '黄4', imgY: 'tiles/bk_H_4.jpg', yellow: [{ op: 'gain', what: 'seals', n: 2 }], blue: [] },
    { id: 'bk_H_5', name: '黄5', imgY: 'tiles/bk_H_5.jpg', yellow: [{ op: 'time', n: 2 }], blue: [] },
    { id: 'bk_H_6', name: '黄6', imgY: 'tiles/bk_H_6.jpg', yellow: [{ op: 'fan', kind: 'red', n: 2 }], blue: [] },
    { id: 'bk_H_7', name: '黄7', imgY: 'tiles/bk_H_7.jpg', yellow: [{ op: 'gain', what: 'food', n: 3 }], blue: [] },
    { id: 'bk_H_8', name: '黄8', imgY: 'tiles/bk_H_8.jpg', yellow: [{ op: 'gainAny', n: 2 }], blue: [] },
    { id: 'bk_H_9', name: '黄9', imgY: 'tiles/bk_H_9.jpg', yellow: [{ op: 'gain', what: 'pearl', n: 3 }], blue: [] }, 
    { id: 'bk_L_1', name: '蓝1', imgY: 'tiles/bk_L_1.jpg', yellow: [{ op: 'action', kind: 'retainer' }], blue: [] },
    { id: 'bk_L_2', name: '蓝2', imgY: 'tiles/bk_L_2.jpg', yellow: [{ op: 'special', note: '任选人物效果' }], blue: [] },
    { id: 'bk_L_3', name: '蓝3', imgY: 'tiles/bk_L_3.jpg', yellow: [{ op: 'action', kind: 'gardener' }], blue: [] },
    { id: 'bk_L_4', name: '蓝4', imgY: 'tiles/bk_L_4.jpg', yellow: [{ op: 'special', note: '红骰子奖励' }], blue: [] },
    { id: 'bk_L_5', name: '蓝5', imgY: 'tiles/bk_L_5.jpg', yellow: [{ op: 'special', note: '玩家面板任意效果' }], blue: [] },
    { id: 'bk_L_6', name: '蓝6', imgY: 'tiles/bk_L_6.jpg', yellow: [{ op: 'action', kind: 'samurai' }], blue: [] },
    { id: 'bk_L_7', name: '蓝7', imgY: 'tiles/bk_L_7.jpg', yellow: [{ op: 'special', note: '白骰子奖励' }], blue: [] },
    { id: 'bk_L_8', name: '蓝8', imgY: 'tiles/bk_L_8.jpg', yellow: [{ op: 'special', note: '黑骰子奖励' }], blue: [] },
    { id: 'bk_L_9', name: '蓝9', imgY: 'tiles/bk_L_9.jpg', yellow: [{ op: 'special', note: '任意骰子奖励' }], blue: [] }
  ];

  /* ── 训练场区域（3 个）：a 放 2 块（一蓝一黄）、b 放 1 块蓝面、c 放 1 块黄面
     costIron 为该区域印制的铁成本；sides 为允许朝上的面。 */
  const TRAINING_AREAS = [
    { id: 'a', name: '训练场a', costIron: 5, sides: ['blue', 'yellow'] },
    { id: 'b', name: '训练场b', costIron: 3, sides: ['blue'] },
    { id: 'c', name: '训练场c', costIron: 1, sides: ['yellow'] }
  ];

  const ART_CARDS = ART_CARDS_A.concat(ART_CARDS_B);   // 兼容旧引用

  /* ── 法令卡（DECREE_CARDS）─────────────────────────────────────
     ★ 改法令卡效果就改这张表。
     起始资源卡的卡面中间印着一个小卷轴：抽到这张卡时「另取 1 张法令卡」放进
     灯笼奖励区（数据总表「额外」列）。目前只有 sf1 / si2 / sp1 三张带卷轴。
     进灯笼区后按 fx 提供灯笼图标，和卡背一样每回合左端骰触发时结算。
     imgFile = 卡面图，相对 assets/。留空则用 glyph 文字牌面（米色底 + 单字）。
               放图的位置约定：assets/cards/cut/decree/decree-red.jpg 等，
               把文件放进去后在这里填 'cards/cut/decree/decree-red.jpg' 即可。
     【近似】效果按卷轴图标推定（红扇/家纹/钱币 各 +1）。 */
  const DECREE_CARDS = {
    红扇: { id: 'decree-red', name: '红扇法令', glyph: '扇', imgFile: 'cards/cut/start-food/back-lightblue-fan.jpg', fx: [{ op: 'fan', kind: 'red', n: 1 }] },
    家纹: { id: 'decree-seal', name: '家纹法令', glyph: '纹', imgFile: 'cards/cut/start-iron/back-grey-bluecoin.jpg', fx: [{ op: 'gain', what: 'seals', n: 1 }] },
    钱币: { id: 'decree-coin', name: '钱币法令', glyph: '钱', imgFile: 'cards/cut/start-pearl/back-grey-crest.jpg', fx: [{ op: 'gain', what: 'coins', n: 1 }] }
  };

  /* ── 起始资源卡（9 张 = 食/铁/珍珠 三面旗 × 3）—— 数值逐张读自卡面实拍
     （Mods/Images 的三张 3 卡合照，已切成 assets/cards/res-<旗>-<序>.jpg）
     卡面版式：左上角旗色 + 中间小卷轴（若有＝另取 1 张法令卡）+ 上半资源 + 下半「钱 / 家纹」。
     res = 固定资源；anyRes = 「三资源图标 + N」＝任选 N 个铁/食/珍珠；
     decree = 小卷轴所示法令卡类型 → 见上面的 DECREE_CARDS，抽到时另取 1 张进灯笼区。
     ★ fx = 只有「卡背」效果（进灯笼区后提供的图标）。法令卡的额外效果不要写进 fx，
       否则会和 DECREE_CARDS 重复结算。 */
  const START_RESOURCE_CARDS = [
    { id: 'sf1', name: '食旗·一', res: {}, anyRes: 1, coins: 2, seals: 2, decree: '红扇', lantern: [{ op: 'gain', what: 'food', n: 1 }], imgFile: 'cards/cut/start-food/start-food-r1c1.jpg', backFile: 'cards/cut/start-food/back.jpg', fx: [{ op: 'gain', what: 'food', n: 1 }], fx3: [[{ op: 'gain', what: 'food', n: 1 }], [{ op: 'fan', kind: 'red', n: 1 }], []] },
    { id: 'sf2', name: '食旗·二', res: { food: 2, iron: 2, pearl: 1 }, coins: 4, seals: 1, lantern: [{ op: 'gain', what: 'food', n: 1 }], imgFile: 'cards/cut/start-food/start-food-r1c2.jpg', backFile: 'cards/cut/start-food/back.jpg', fx: [{ op: 'gain', what: 'food', n: 1 }], fx3: [[{ op: 'gain', what: 'food', n: 1 }], [], []] },
    { id: 'sf3', name: '食旗·三', res: { food: 4, iron: 2 }, coins: 3, seals: 2, lantern: [{ op: 'gain', what: 'food', n: 1 }], imgFile: 'cards/cut/start-food/start-food-r2c1.jpg', backFile: 'cards/cut/start-food/back.jpg', fx: [{ op: 'gain', what: 'food', n: 1 }], fx3: [[{ op: 'gain', what: 'food', n: 1 }], [], []] },
    { id: 'si1', name: '铁旗·一', res: { food: 1, iron: 2, pearl: 1 }, coins: 3, seals: 1, lantern: [{ op: 'gain', what: 'iron', n: 1 }], imgFile: 'cards/cut/start-iron/start-iron-r1c1.jpg', backFile: 'cards/cut/start-iron/back.jpg', fx: [{ op: 'gain', what: 'iron', n: 1 }], fx3: [[{ op: 'gain', what: 'iron', n: 1 }], [], []] },
    { id: 'si2', name: '铁旗·二', res: { iron: 1, pearl: 2 }, coins: 4, seals: 0, decree: '家纹', lantern: [{ op: 'gain', what: 'iron', n: 1 }], imgFile: 'cards/cut/start-iron/start-iron-r1c2.jpg', backFile: 'cards/cut/start-iron/back.jpg', fx: [{ op: 'gain', what: 'iron', n: 1 }], fx3: [[{ op: 'gain', what: 'iron', n: 1 }], [{ op: 'gain', what: 'seals', n: 1 }], []] },
    { id: 'si3', name: '铁旗·三', res: {}, anyRes: 3, coins: 4, seals: 1, lantern: [{ op: 'gain', what: 'iron', n: 1 }], imgFile: 'cards/cut/start-iron/start-iron-r2c1.jpg', backFile: 'cards/cut/start-iron/back.jpg', fx: [{ op: 'gain', what: 'iron', n: 1 }], fx3: [[{ op: 'gain', what: 'iron', n: 1 }], [], []] },
    { id: 'sp1', name: '珠旗·一', res: { food: 2, iron: 1 }, coins: 2, seals: 1, decree: '钱币', lantern: [{ op: 'gain', what: 'pearl', n: 1 }], imgFile: 'cards/cut/start-pearl/start-pearl-r1c1.jpg', backFile: 'cards/cut/start-pearl/back.jpg', fx: [{ op: 'gain', what: 'pearl', n: 1 }], fx3: [[{ op: 'gain', what: 'pearl', n: 1 }], [], []] },
    { id: 'sp2', name: '珠旗·二', res: {}, anyRes: 2, coins: 4, seals: 2, lantern: [{ op: 'gain', what: 'pearl', n: 1 }], imgFile: 'cards/cut/start-pearl/start-pearl-r1c2.jpg', backFile: 'cards/cut/start-pearl/back.jpg', fx: [{ op: 'gain', what: 'pearl', n: 1 }], fx3: [[{ op: 'gain', what: 'pearl', n: 1 }], [], []] },
    /* sp3 之前把 fx / fx3 误写进了 res 对象里（res 只放铁/食/珠），
       导致这张卡的卡背 +1珍珠 在灯笼区不结算 —— 已提到顶层。 */
    { id: 'sp3', name: '珠旗·三', res: { iron: 2, pearl: 1 }, coins: 5, seals: 1, lantern: [{ op: 'gain', what: 'pearl', n: 1 }], imgFile: 'cards/cut/start-pearl/start-pearl-r2c1.jpg', backFile: 'cards/cut/start-pearl/back.jpg', fx: [{ op: 'gain', what: 'pearl', n: 1 }], fx3: [[{ op: 'gain', what: 'pearl', n: 1 }], [], []] }
  ];

  /* ── 起始行动卡：3 张（城堡／桥／村社 三种图示），开局与资源卡成对供选，入领地卡槽。
     light 为被晋升翻出时的灯笼可见图标【近似：图标含义按版式推定】 */
  /* ── 起始行动卡（act-castle / act-bridge / act-village）字段说明 ──
     id       : 卡牌编号，与数据总表「编号」列一致
     name     : 显示名
     imgFile  : 卡面图（assets/cards/cut/start-action/...）
     效果（数据总表 3 列，对应 fx3[0..2]）：
       fx3[0]  效果 1 —— 家臣令 / 庭师令 / 武家令（{op:'action',kind:'retainer'|'gardener'|'samurai'}）
       fx3[1]  效果 2 —— 三张卡统一是「+1影响力」（{op:'time',n:1}）＝ 卡背效果
       fx3[2]  效果 3 —— 表格里留空
     ★ 卡背 = +1影响力（backFx 字段）。这张卡开局在个人版图行动区（正面朝上），
       【不进】灯笼区；等它被城郊卡替换时，才会翻面进灯笼区并提供这 1 点影响力。
     引擎开局读 pair.act 放进 p.domain.actionCard，作为个人面板卡槽的起始行动卡。 */
  const START_ACTION_CARDS = [
    { id: 'act-castle', isStartAction: true, name: '家臣令', color: 'coral', icon: 'castle', light: [{ op: 'gain', what: 'coins', n: 1 }], imgFile: 'cards/cut/start-action/action-castle.jpg', backFile: 'cards/cut/start-action/back-yellow-crane.jpg', backFx: [{ op: 'time', n: 1 }], fx: [{ op: 'action', kind: 'retainer' }, { op: 'time', n: 1 }], fx3: [[{ op: 'action', kind: 'retainer' }], [{ op: 'time', n: 1 }], []] },
    { id: 'act-bridge', isStartAction: true, name: '庭师令', color: 'black', icon: 'bridge', light: [{ op: 'fan', kind: 'red', n: 1 }], imgFile: 'cards/cut/start-action/action-bridge.jpg', backFile: 'cards/cut/start-action/back-yellow-crane.jpg', backFx: [{ op: 'time', n: 1 }], fx: [{ op: 'action', kind: 'gardener' }, { op: 'time', n: 1 }], fx3: [[{ op: 'action', kind: 'gardener' }], [{ op: 'time', n: 1 }], []] },
    { id: 'act-village', isStartAction: true, name: '武家令', color: 'white', icon: 'village', light: [{ op: 'time', n: 1 }], imgFile: 'cards/cut/start-action/action-village.jpg', backFile: 'cards/cut/start-action/back-yellow-crane.jpg', backFx: [{ op: 'time', n: 1 }], fx: [{ op: 'action', kind: 'samurai' }, { op: 'time', n: 1 }], fx3: [[{ op: 'action', kind: 'samurai' }], [{ op: 'time', n: 1 }], []] }
  ];

  /* ── 大名卡：5 张，幕僚晋升第 3 层（大名层）时抽取结算。无图【近似：小奖励】 */
  const DAIMYO_CARDS = [
    { id: 'dm1', name: '稻叶一铁', effect: [{ op: 'fan', kind: 'red', n: 3 }] },
    { id: 'dm2', name: '安藤守就', effect: [{ op: 'gain', what: 'seals', n: 2 }] },
    { id: 'dm3', name: '氏家卜全', effect: [{ op: 'time', n: 2 }] },
    { id: 'dm4', name: '竹中重治', effect: [{ op: 'gainAny', pool: ['iron', 'food', 'pearl'], n: 2 }] },
    { id: 'dm5', name: '黑田孝高', effect: [{ op: 'fan', kind: 'gold', n: 1 }, { op: 'fan', kind: 'red', n: 1 }] }
  ];

  /* ── 个人领地队列（读自领地版图照片）
     每条 = 1 骰位（印刷值 base）+ 6 格奖励条 strip + 骰位旁金扇 fan；
     ★ 三条行＝三种基础资源的「资源带」：coral 食物 / black 铁 / white 珍珠
       （看版图：三条行开头的图标分别是饭碗、铁锭、珍珠贝）。
     ★ 奖励格由【你已经派出去多少个人】决定，不是由「这条队列放了几颗骰」决定
       （2026-11 按用户规则改）：每个玩家家臣/园丁/武士各 5 个，
       已派数 = 5 − 池里剩下的数量，取 rewards[已派数]（0–5）。
         coral（红骰）＝行动卡效果1 + 家臣已派数对应的食物格
         black（黑骰）＝行动卡效果2 + 园丁已派数对应的铁格
         white（白骰）＝行动卡效果3 + 武士已派数对应的珍珠格
       pool 字段就是「这一行用哪个池子来数」。
     ★ 放骰后执行的「家族行动」不在这里，而是由【行动卡上的人】决定，
       见 engine.js 的 domainCardEffects()。 */
  const QUEUE_STRIPS = {
    base: {
      coral: { lane: 'food', laneName: '食物', pool: 'clan', base: 6, rewards: [
        [{ op: 'gain', what: 'food', n: 1 }],
        [{ op: 'gain', what: 'food', n: 2 }],
        [{ op: 'gain', what: 'food', n: 3 }],
        [{ op: 'gain', what: 'food', n: 3 }, { op: 'gain', what: 'coins', n: 2 }],
        [{ op: 'gain', what: 'food', n: 4 }, { op: 'gain', what: 'coins', n: 2 }],
        [{ op: 'gain', what: 'food', n: 4 }, { op: 'gain', what: 'coins', n: 2 }, { op: 'gain', what: 'seals', n: 1 }]
      ] },
      black: { lane: 'iron', laneName: '铁', pool: 'gardener', base: 6, rewards: [
        [{ op: 'gain', what: 'iron', n: 1 }],
        [{ op: 'gain', what: 'iron', n: 2 }],
        [{ op: 'gain', what: 'iron', n: 3 }],
        [{ op: 'gain', what: 'iron', n: 3 }, { op: 'lantern' }],
        [{ op: 'gain', what: 'iron', n: 4 }, { op: 'lantern' }],
        [{ op: 'gain', what: 'iron', n: 4 }, { op: 'lantern' }, { op: 'gain', what: 'coins', n: 2 }]
      ] },
      white: { lane: 'pearl', laneName: '珍珠', pool: 'samurai', base: 6, rewards: [
        [{ op: 'gain', what: 'pearl', n: 1 }],
        [{ op: 'gain', what: 'pearl', n: 2 }],
        [{ op: 'gain', what: 'pearl', n: 3 }],
        [{ op: 'gain', what: 'pearl', n: 3 }, { op: 'gain', what: 'seals', n: 1 }],
        [{ op: 'gain', what: 'pearl', n: 4 }, { op: 'gain', what: 'seals', n: 1 }],
        [{ op: 'gain', what: 'pearl', n: 4 }, { op: 'gain', what: 'seals', n: 1 }, { op: 'lantern' }]
      ] }
    }
  };

  /* ── 主版图区域 ─────────────────────────────────────────
     水井：栏位值恒 1、不限骰数、每颗 = 1 家纹 + 2 个板块收益（首玩配置 = 珍珠母 + 铁）+ (点数−1) 钱【书·基础 p07】 */
  const WELL = { base: 1, seal: 1, tiles: ['pearl', 'iron'] };

  /* 墙外：2 栏位，每栏位印 2 个行动、只能选 1【近似：行动与值 2 版图读不出，自定】 */
  const WALL_SLOTS = [
    { id: 'wallA', base: 5, actions: [[{ op: 'action', kind: 'retainer' }], [{ op: 'action', kind: 'gardener' }]] },
    { id: 'wallB', base: 5, actions: [[{ op: 'action', kind: 'samurai' }], [{ op: 'action', kind: 'retainer' }]] }
  ];

  /* 城门：付 2 钱进入；晋升付 2 珍珠升 1 层、付 5 珍珠升 2 层 */
  const GATE = { enterCoins: 2, promote: [{ pearl: 2, levels: 1 }, { pearl: 5, levels: 2 }] };

  /* 训练场：不是放骰区域（规则书的 4 个放骰区＝城堡／墙外／水井／个人领地）。
     版图上训练场只有「铁成本 + 武士价值」，骰子不能放这里。武士经武士行动派遣上去。 */

  /* 城郊：5 个骰位，印刷点数 —— 地头层那排（layer a，3 格）3 点 / 使节层那排（layer b，2 格）4 点。
     ★ 2026-10-31 按用户要求：城郊卡不接受骰子，这份数值仅作记录（引擎按 layer 写入 slot.base，
     本次放骰区域仍是城堡／墙外／水井／个人领地四类）。
     规则书里城郊＝放骰执行该栏位卡的黄+蓝窗帘（顺序自选），用后卡进灯笼区并补牌。 */
  const OUTSKIRTS_SLOTS = [{ base: 3 }, { base: 4 }];

  /* ── 回合内自由兑换（领地横幅）──────────────────────────── */
  const EXCHANGES = [
    { id: 'seal2res', name: '2 纹 → 1 资源', cost: { seals: 2 }, gainAny: { n: 1 } },   // pool 固定 3 种基础资源是否含筅
    { id: 'seal2coin', name: '1 纹 → 1 钱', cost: { seals: 1 }, gain: { coins: 1 } }
  ];

  /* ── 起始设置【近似：基础钱数版图未标注，自定 3 钱，其余靠起始卡】 */
  const SETUP = {
    coins: 0, seals: 0,
    res: { iron: 0, food: 0, pearl: 0 },
    clanPool: 5, samuraiPool: 5, gardenerPool: 5,
    rounds: 3,                       // 3 轮
    draftPairsExtra: 1               // 抽出 (人数+1) 对起始卡
  };

  /* ══════════════════════════════════════════════════════════════════════
     版图布局 BOARD_LAYOUT —— 唯一位置来源，只改这里 ★

     【坐标单位】全部是百分比 0–100：
        x = 版图宽度的百分比（0 最左，100 最右）
        y = 版图高度的百分比（0 最上，100 最下）
        写成 [x, y] 表示「该元素的中心点」落在版图的哪个位置。

     【换算】下面的 BOARD_ART / DOMAIN_ART 会自动把 0–100 换算成 CSS 用的 0–1，
       所以这里填 27.7，CSS 里就是 left:27.7%。不要在这里写 0.277。

     【三类锚点严格分开，不要写成同一个坐标】
        die   = 骰子位：印刷骰位方块的中心（骰子叠在这里）
        card  = 卡牌位：卡图中心（卡牌铺在这里）
        piece = 棋子位：园丁 / 武士 / 家臣 的圆点中心

     【卡图尺寸】在 css/style.css 的 v8 段（搜索 `--card-w`）：
        房间卡 / 庭院卡 10.0×6.5cqw（横放）
        城郊卡 7.0×10.5cqw（竖放，按 outskirt 原图比例）
        骰位块 4.4cqw、骰子 3.9cqw
       改尺寸去 CSS，改位置改这里。

     【排查技巧】把某个值临时改成 50，刷新后看元素跳到版图正中，
       就能立刻确认这个字段控制的是哪一个元素。

     ══════════════════════════════════════════════════════════════════
     ★★ 最常微调的两处（2026-10 用户指定）★★
       ① 个人面板「行动区」卡位（那张大卡）
            BOARD_LAYOUT.domain.base.card  = [86.0, 40.0]
            含义：卡牌【中心点】在个人面板上的百分比位置。
            x 越大越靠右，y 越大越靠下。
            卡的大小不在这里，在 css/style.css 第 09 段
            「.art-thumb.file.pact」的 15cqw × 21.2cqw。
       ② 版图「武士板块 / 训练场」三个绿框
            BOARD_LAYOUT.base.training.c13 / c14 / c15
              card  = 训练场板块（卡）的中心点
              piece = 武士棋子圆点的中心点（在板块右边）
            三个框各自独立，改哪一项只动哪一个。
            板块大小在 css/style.css 第 08 段
            「.bslot.train-area」的 10.5cqw × 6.0cqw。
     ══════════════════════════════════════════════════════════════════ */
  const BOARD_LAYOUT = {
    base: {
      img: 'board-base-web.jpg',          // 底图文件名（assets/ 下）
      ratio: 1920 / 1039,                 // 底图宽高比，用于容器 aspect-ratio

      /* ── 三座桥：骰子沿桥面从左到右摆开 ────────────────────────────
         x0 = 桥面最左（左端骰的位置）
         x1 = 桥面最右（右端骰的位置）
         y  = 桥面中心线的高度
         每座桥的骰子数 = 玩家数+1，按点数升序均分在 x0→x1 之间。 */
      bridges: {
        coral: { x0: 5.0, x1: 16.9, y: 26.8 },   // 珊瑚桥（最上层）
        black: { x0: 5.2, x1: 17.1, y: 53.6 },   // 墨桥（中层）
        white: { x0: 5.3, x1: 17.0, y: 80.0 }    // 白桥（最下层）
      },

      /* ── 城堡 6 房 ──────────────────────────────────────────────────
         die  = 印刷骰位方块的中心（房间左侧那个绿色方块）
                r6 天守阁没有骰位 → null
         card = 房间卡位中心
                r1–r5 没有房间卡（放的是城郊卡，见下面的 outskirts）→ null
                r6 放唯一那张房间卡 */
      rooms: {
        r1: { die: [36.6, 74.3], card: null, mk: [[40.4,74.1], [40.4,79.6]] , marks: ['mk_a', 'mk_b'] },   // 地头层左房
        r2: { die: [58.5, 74.2], card: null, mk: [[62.3,74.0], [62.3,79.5]] , marks: ['mk_b', 'mk_c'] },   // 地头层中房
        r3: { die: [80.6, 73.9], card: null, mk: [[84.4,73.7], [84.4,79.2]] , marks: ['mk_c', 'mk_a'] },   // 地头层右房
        r4: { die: [40.8, 53.7], card: null, mk: [[44.6,53.5], [44.6,59.0]] , marks: ['mk_a', 'mk_b'] },   // 使节层左房
        r5: { die: [62.8, 53.7], card: null, mk: [[66.6,53.5], [66.6,59.0]] , marks: ['mk_c', 'mk_a'] },   // 使节层右房
        r6: { die: null, card: [50.7, 32.5] }    // 天守阁：只有卡位
      },

      /* ── 训练场 3 区域（版图右侧的绿框 G1/G2/G3）───────────────────
         ★ 这就是「武士板块区域」，想微调位置只改下面这 6 组坐标。
         card  = 训练场板块（卡）的中心点
         piece = 武士棋子的落点（在板块右边那一排圆点）
         坐标是 [x%, y%]，x 越大越靠右、y 越大越靠下。
         板块尺寸在 css/style.css 第 08 段 .bslot.train-area（10.5×6.0cqw）。 */
      training: {
        c13: { card: [78.8, 27.5], piece: [82.3, 37.1] },  // 右上绿框① 两块（蓝+黄，5 铁）
        c14: { card: [89.6, 28.0], piece: [92.9, 38.0] },  // 右上绿框② 一块蓝面（3 铁）
        c15: { card: [86.2, 47.4], piece: [91.6, 55.7] }   // 右中绿框③ 一块黄面（1 铁）
      },  

      /* ── 城郊卡 5 格（就是城堡里 5 个房间的卡位）─────────────────────
         顺序 = 数组顺序，layer 'a' 是地头层 3 张、'b' 是使节层 2 张
         card = 城郊卡图中心
         die  = 放骰触发这张卡时的骰位中心
         家臣晋升到该层时，会收走对应 layer 的城郊卡。 */
      outskirts: [
        { card: [45.7, 74.5], die: [45.7, 80.5], layer: 'a' },   // 城郊A1（地头层左）
        { card: [68.0, 74.5], die: [67.3, 80.5], layer: 'a' },   // 城郊A2（地头层中）
        { card: [90.0, 74.5], die: [90.0, 80.5], layer: 'a' },   // 城郊A3（地头层右）
        { card: [50.0, 54.3], die: [49.4, 60.3], layer: 'b' },   // 城郊B1（使节层左）
        { card: [72.0, 54.0], die: [70.0, 60.0], layer: 'b' }    // 城郊B2（使节层右）
      ],

      /* ── 墙外 2 格：骰位方块中心（右下角两个）────────────────────── */
      wall: [[83.4, 95.0], [92.4, 95.0]],

      /* ── 水井：骰位方块中心（1 格，不限骰色）────────────────────── */
      well: [28.0, 93.0],

      /* ── 庭院卡 6 格（版图最左侧）──────────────────────────────────
         cards 顺序：[左列上, 右列上, 左列中, 右列中, 左列下, 右列下]
         pieceDy = 园丁棋子相对卡中心的纵向偏移（正数 = 往下） */
      courtyard: {
        cards: [[5.5, 38.0], [16.5, 38.0],
                [5.5, 65.0], [16.5, 65.0],
                [5.5, 92.0], [16.5, 92.0]],
        pieceDy: 5.4
      },

      /* ── 家臣棋子 4 个落点 ────────────────────────────────────────
         gate   = 城门外
         floor1 = 地头层（第一层）走廊
         floor2 = 使节层（第二层）走廊
         floor3 = 大名层（第三层） */
      clan: { gate: [66.8, 97.1], floor1: [55.0, 80.5], floor2: [56.2, 60.8], floor3: [58.5, 36.5] },

      /* 整块区域外框（x,y=左上角，w,h=宽高），只用于静态校验「板块是否落在区域内」，
         不参与渲染，一般不用改。 */
      regions: {
        castle: { x: 24, y: 24, w: 62, h: 52 },
        wall: { x: 73, y: 90, w: 24, h: 10 },
        well: { x: 21, y: 87, w: 14, h: 13 },
        courtyard: { x: 1, y: 33, w: 15, h: 62 },
        outskirts: { x: 38, y: 45, w: 50, h: 30 },
        training: { x: 74, y: 27, w: 24, h: 30 }
      }
    },

    /* ── 个人领地图（玩家面板）──────────────────────────────────────
       rows   = 三条队列的 y 中心（按骰色分）
       dieX   = 队列里骰子的 x 位置（三条队列共用）
       card   = 领地行动卡的【中心点】，CSS 里用 translate(-50%,-50%) 对齐
       hud    = 面板上数值区的位置
       lantern= 灯笼奖励区的位置。
                [x%, y%] = 整条区域的【左上角】（与 css/style.css 第 10 段注释一致）。
                ★ 想整体挪位置就改这两个数：
                  x 越大越靠右（30 = 面板左中部起排）
                  y 越大越靠下（70 = 面板下部、行动卡下方）
                灯笼条是【固定宽度盒子】（左缘 = x，右缘贴面板内边），卡片从左往右排、
                旧卡永远不动，新卡往右补，放不下的收进「+N」片 —— 所以不存在
                「拿一张新卡整条往左滑」的问题。
                单张卡的宽/高/叠放步距不在这里，在 css/style.css 第 10 段
                「灯笼奖励区」的 --lan-w / --lan-h / --lan-step。 */
    domain: {
      base: {
        img: 'domain-base-web.jpg', ratio: 1700 / 1107,
        rows: { coral: 25.5, black: 41.2, white: 57.3 },
        /* ★ 行动区卡位：卡牌【中心点】。想挪那张大卡就改这两个数。
             尺寸不在这里 → css/style.css 第 09 段 .art-thumb.file.pact */
        dieX: 38.2, card: [88.5, 42.0], hud: [64.0, 76.0], lantern: [45.5, 70.0],
        /* ── 个人领地叠层：资源记录轨 / 待派成员格 / 家纹槽 ────────────
           资源：三条白色折线轨（0–7），x 是轨心，y 按 0→7 的值排。
           成员：每行 5 个印刷格，用玩家色半透明圆点表示池里还剩几个。
           家纹：顶部 5 个圆槽，最多放 5 枚；右上角是「家纹/钱 + 兑换」HUD。 */
        resX: { food: 8.1, iron: 17.6, pearl: 27.2 },
        resY: [85.2, 76.0, 67.3, 58.4, 50.1, 42.0, 33.7, 25.7],
        workerX: [50.7, 56.2, 61.7, 67.2, 72.7],
        workerY: { clan: 23.0, gardener: 40.2, samurai: 57.0 },
        crests: [[7.1, 8.5], [17.6, 8.5], [28.2, 8.5], [38.8, 8.5], [49.4, 8.5]],
        /* 家纹数量只看顶部 5 个槽；兑换条放家纹这一排中间，钱放右边，避免往下压住成员格 */
        exchangeHud: [55.2, 2.9, 21.8, 11.5],
        moneyHud: [79.0, 3.3, 8.2, 8.8]
      }
    }
  };

  /* 0–100 → 0–1，供渲染层直接乘 100 输出 CSS 百分比 */
  const u = (v) => v / 100;
  const uv = (a) => [u(a[0]), u(a[1])];
  const umap = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));
  const BOARD_ART = {
    base: {
      img: BOARD_LAYOUT.base.img, ratio: BOARD_LAYOUT.base.ratio,
      bridges: umap(BOARD_LAYOUT.base.bridges, (v) => ({ y: u(v.y), x0: u(v.x0), x1: u(v.x1) })),
      rooms: umap(BOARD_LAYOUT.base.rooms, (v) => ({ die: v.die ? uv(v.die) : null, card: v.card ? uv(v.card) : null })),
      training: umap(BOARD_LAYOUT.base.training, (v) => ({ card: uv(v.card), piece: uv(v.piece) })),
      outskirts: BOARD_LAYOUT.base.outskirts.map((v) => ({ card: uv(v.card), die: uv(v.die), layer: v.layer })),
      wall: BOARD_LAYOUT.base.wall.map(uv),
      well: uv(BOARD_LAYOUT.base.well),
      courtyard: { cards: BOARD_LAYOUT.base.courtyard.cards.map(uv), pieceDy: u(BOARD_LAYOUT.base.courtyard.pieceDy) },
      clan: umap(BOARD_LAYOUT.base.clan, uv)
    }
  };

  /* ── 个人领地图叠层：队列放骰点、行动卡槽、灯笼区锚点、HUD 位置 ── */
  const DOMAIN_ART = {
    base: {
      img: BOARD_LAYOUT.domain.base.img, ratio: BOARD_LAYOUT.domain.base.ratio,
      rows: umap(BOARD_LAYOUT.domain.base.rows, u),
      dieX: u(BOARD_LAYOUT.domain.base.dieX),
      card: uv(BOARD_LAYOUT.domain.base.card),
      hud: uv(BOARD_LAYOUT.domain.base.hud),
      lantern: uv(BOARD_LAYOUT.domain.base.lantern),    // 灯笼奖励区锚点（0–1）
      resX: umap(BOARD_LAYOUT.domain.base.resX, u),
      resY: BOARD_LAYOUT.domain.base.resY.map(u),
      workerX: BOARD_LAYOUT.domain.base.workerX.map(u),
      workerY: umap(BOARD_LAYOUT.domain.base.workerY, u),
      crests: BOARD_LAYOUT.domain.base.crests.map(uv),
      exchangeHud: uv(BOARD_LAYOUT.domain.base.exchangeHud),
      moneyHud: uv(BOARD_LAYOUT.domain.base.moneyHud)
    }
  };

  /* ── 通用卡牌定义 CARD_DEFS：静态数据，只描述“这张卡是什么”★
     与运行时实例（engine.createCardInstance 产出的 cardInstance）分离：
       CARD_DEFS → { id, name, frontEffect, backEffect, lanternText }
       cardInstance → { uid, defId, side:'front'|'back', owner, zone, slotIndex }
     效果对象统一为 { type, ... }，由 engine.executeEffect 单一入口 switch 分发。
     资源名沿用本项目：food / iron / pearl，货币 coins / seals。 */
  const CARD_DEFS = [
    {
      id: 'gardener_01',
      name: '园丁卡',
      frontEffect: { type: 'gainResource', resource: 'food', amount: 2 },
      backEffect: { type: 'gainResource', resource: 'coins', amount: 1 },
      lanternText: '获得 1 钱'
    },
    {
      id: 'smith_01',
      name: '铁匠卡',
      frontEffect: { type: 'gainResource', resource: 'iron', amount: 2 },
      backEffect: { type: 'gainResource', resource: 'coins', amount: 1 },
      lanternText: '获得 1 钱'
    },
    {
      id: 'merchant_01',
      name: '商人卡',
      frontEffect: { type: 'gainCoins', amount: 3 },
      backEffect: { type: 'time', amount: 1 },
      lanternText: '影响力前进 1 格'
    }
  ];
  const CARD_DEF_BY_ID = Object.fromEntries(CARD_DEFS.map((c) => [c.id, c]));
  const getCardDef = (id) => CARD_DEF_BY_ID[id] || null;

  return {
    DIE_COLORS, PLAYER_COLORS, RESOURCES, RES_MAX, SEAL_MAX,
    BRIDGES, SCORE_TRACK, INFLUENCE_TRACK, SCORING,
    MARKERS, MARKER_CELLS, ROOM_DEFS, ROOM_CARDS, COURTYARD_CARDS, TRAINING_TILES, TRAINING_AREAS,
    ART_CARDS, ART_CARDS_A, ART_CARDS_B, START_RESOURCE_CARDS, START_ACTION_CARDS, DAIMYO_CARDS,
    DECREE_CARDS,
    QUEUE_STRIPS, WELL, WALL_SLOTS, GATE, OUTSKIRTS_SLOTS,
    EXCHANGES, SETUP, BOARD_LAYOUT, BOARD_ART, DOMAIN_ART,
    CARD_DEFS, getCardDef
  };
})();
