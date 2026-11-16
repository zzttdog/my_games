/* ============================================================
 * 数据层
 * ============================================================ */
const TYPES = {
  water:    { name:'河流', short:'蓝', color:'#4a7fb5', img:'Images/res/water.png' },
  mountain: { name:'山岩', short:'灰', color:'#8a8f98', img:'Images/res/mountain.png' },
  trunk:    { name:'树干', short:'综', color:'#7a5a3a', img:'Images/res/trunk.png' },
  tree:     { name:'树冠', short:'绿', color:'#4f8a3f', img:'Images/res/tree.png' },
  field:    { name:'田野', short:'黄', color:'#d4b84a', img:'Images/res/field.png' },
  building: { name:'建筑', short:'红', color:'#b5544a', img:'Images/res/building.png' },
};
/* 图片缓存:加载完成后自动重绘
   GitHub Pages 是静态站，不执行 server.js 的 Accept 协商：这里显式请求
   「原文件名.webp」，加载失败时再回退到原图（旧浏览器 / 极少数缺副本）。 */
function webpSrc(src) {
  return (window.MGImg && MGImg.webp) ? MGImg.webp(src) : src;
}
const tokImgs = {}, cardImgs = {}, boardImgs = {};
function loadImg(cache, keyStr, src) {
  const im = new Image();
  im.onload = () => { cache[keyStr] = im; if (G.players.length) renderAll(); };
  im.onerror = () => {
    if (/\.webp(?:[?#]|$)/i.test(im.src)) {
      im.onerror = null;
      im.src = im.src.replace(/\.webp(?=[?#]|$)/i, '');
    }
  };
  im.src = webpSrc(src);
}
for (const t in TYPES) {
  TYPES[t].img = webpSrc(TYPES[t].img);
  loadImg(tokImgs, t, TYPES[t].img);
}
loadImg(boardImgs, 'boardA', 'Images/res/board_A.jpg'); // A 面版图底图(经六边形中心检测对齐画布)
loadImg(boardImgs, 'boardB', 'Images/res/board_B.jpg'); // B 面版图底图(经六边形中心检测对齐画布)
loadImg(boardImgs, 'boardC', 'Images/res/board_C.png'); // C 面版图(26 格,中央空穴)
loadImg(boardImgs, 'boardD', 'Images/res/board_D.png'); // D 面版图(25 格,18 个干旱格)
const POUCH_DEF = { water:23, mountain:23, trunk:21, tree:19, field:19, building:15 };
const HEIGHT_PTS = { 1:1, 2:3, 3:7 };
const RIVER_PTS  = { 2:2, 3:5, 4:8, 5:11, 6:15 }; // 超过 6 每格 +4

/* 图案需求简写:
 * w=河流(1蓝) f=田野(1黄) t=树干(1综/1综2综,顶部为树干) T1/T2/T3=树(1绿/1综2绿/1综2综3绿,顶部树冠)
 * M1/M2/M3=山(1灰/1灰2灰/1灰2灰3灰,顶部山岩) B=建筑(1棕2红/1灰2红/1红2红,顶部建筑,高2)
 * r=单层红标记(高 1,仅精灵牌1 的「1黄*+1红」使用,不视为建筑) C=该格已有动物方块
 * 单元格: {q,r,req,a(锚点=方块放置处)} */

// ---- 32 张基础动物卡(官方数据,与 BGA 实现逐卡核对一致;cubes 自上而下) ----
const BASE_CARDS = [
  { name:'鳄鱼',   icon:'🐊', cubes:[4,9,15],   pat:[{q:0,r:0,req:'T3'},{q:-1,r:0,req:'w'},{q:-2,r:0,req:'w',a:1}] },
  { name:'鳐鱼',   icon:'🐠', cubes:[4,10,16],  pat:[{q:0,r:0,req:'M1'},{q:-1,r:1,req:'M1'},{q:-1,r:0,req:'w',a:1}] },
  { name:'鱼',     icon:'🐟', cubes:[3,6,10,16],pat:[{q:0,r:0,req:'M3'},{q:-1,r:0,req:'w',a:1}] },
  { name:'水獭',   icon:'🦦', cubes:[5,10,16],  pat:[{q:0,r:0,req:'T1'},{q:-1,r:0,req:'T1'},{q:-2,r:0,req:'w',a:1}] },
  { name:'青蛙',   icon:'🐸', cubes:[2,4,6,10,15],pat:[{q:0,r:0,req:'T1'},{q:-1,r:0,req:'w',a:1}] },
  { name:'鸭子',   icon:'🦆', cubes:[2,4,8,13], pat:[{q:0,r:0,req:'B'},{q:-1,r:0,req:'w',a:1}] },
  { name:'火烈鸟', icon:'🦩', cubes:[4,10,16],  pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'w',a:1},{q:-1,r:1,req:'f'}] },
  { name:'蜥蜴',   icon:'🦎', cubes:[5,10,16],  pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'f'},{q:-2,r:0,req:'B',a:1}] },
  { name:'老鼠',   icon:'🐀', cubes:[5,10,17],  pat:[{q:0,r:0,req:'f'},{q:0,r:-1,req:'B',a:1},{q:-1,r:-1,req:'f'}] },
  { name:'孔雀',   icon:'🦚', cubes:[5,10,17],  pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'B',a:1},{q:-1,r:-1,req:'w'}] },
  { name:'松鼠',   icon:'🐿️', cubes:[4,9,15],  pat:[{q:0,r:0,req:'T3'},{q:-1,r:0,req:'B',a:1}] },
  { name:'刺猬',   icon:'🦔', cubes:[5,12],     pat:[{q:0,r:0,req:'T2'},{q:-1,r:0,req:'B',a:1},{q:-1,r:1,req:'T2'}] },
  { name:'蜜蜂',   icon:'🐝', cubes:[8,18],     pat:[{q:0,r:0,req:'f'},{q:0,r:-1,req:'T2',a:1},{q:-1,r:0,req:'f'},{q:-1,r:-1,req:'f'}] },
  { name:'熊',     icon:'🐻', cubes:[5,11],     pat:[{q:0,r:0,req:'M2'},{q:-1,r:0,req:'T1',a:1},{q:-1,r:1,req:'M2'}] },
  { name:'兔子',   icon:'🐰', cubes:[5,10,17],  pat:[{q:0,r:0,req:'B'},{q:-1,r:0,req:'T1'},{q:-2,r:0,req:'T1',a:1}] },
  { name:'鹦鹉',   icon:'🦜', cubes:[4,9,14],   pat:[{q:0,r:0,req:'w'},{q:-1,r:0,req:'T2',a:1},{q:-1,r:1,req:'w'}] },
  { name:'野猪',   icon:'🐗', cubes:[4,8,13],   pat:[{q:0,r:0,req:'B'},{q:-1,r:0,req:'T2',a:1}] },
  { name:'考拉',   icon:'🐨', cubes:[3,6,10,15],pat:[{q:0,r:0,req:'T1'},{q:-1,r:0,req:'T2',a:1}] },
  { name:'狼',     icon:'🐺', cubes:[4,10,16],  pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'T3',a:1},{q:-1,r:1,req:'f'}] },
  { name:'翠鸟',   icon:'�', cubes:[5,11,18],  pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'T3',a:1},{q:-1,r:-1,req:'w'}] },
  { name:'企鹅',   icon:'🐧', cubes:[4,10,16],  pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'M1',a:1},{q:-1,r:-1,req:'w'}] },
  { name:'蝙蝠',   icon:'🦇', cubes:[3,6,10,15],pat:[{q:0,r:0,req:'T3'},{q:-1,r:0,req:'M1',a:1}] },
  { name:'狐狸',   icon:'🦊', cubes:[4,9,16],   pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'M1'},{q:-2,r:0,req:'M1',a:1}] },
  { name:'猴子',   icon:'🐒', cubes:[5,11],     pat:[{q:0,r:0,req:'w'},{q:-1,r:0,req:'M2',a:1},{q:-1,r:1,req:'w'}] },
  { name:'鹰',     icon:'🦅', cubes:[5,11],     pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'M3',a:1}] },
  { name:'猫鼬',   icon:'�', cubes:[2,5,9,14], pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'M1',a:1}] },
  { name:'乌鸦',   icon:'�‍⬛', cubes:[4,9],    pat:[{q:0,r:0,req:'B'},{q:0,r:-1,req:'f',a:1},{q:-1,r:-1,req:'B'}] },
  { name:'羊驼',   icon:'🦙', cubes:[5,12],     pat:[{q:0,r:0,req:'M2'},{q:-1,r:0,req:'f'},{q:-2,r:0,req:'f',a:1}] },
  { name:'白狼',   icon:'❄️🐺', cubes:[5,10,17],pat:[{q:0,r:0,req:'T2'},{q:0,r:-1,req:'f',a:1},{q:-1,r:-1,req:'T2'}] },
  { name:'浣熊',   icon:'🦝', cubes:[6,12],     pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'f',a:1},{q:-1,r:0,req:'w'},{q:-1,r:-1,req:'w'}] },
  { name:'蝴蝶',   icon:'🦋', cubes:[2,5,8,12,17],pat:[{q:0,r:0,req:'T1'},{q:-1,r:0,req:'f',a:1}] },
  { name:'黑豹',   icon:'🐆', cubes:[5,11],     pat:[{q:0,r:0,req:'T2'},{q:-1,r:0,req:'T2'},{q:-2,r:0,req:'f',a:1}] },
];

// ---- Pulse 扩展 10 张(仅这 10 张的图案允许镜像放置) ----
// 图案/分值逐张对照实体卡照片校准(Images/cards/*.jpg)
const PULSE_CARDS = [
  { name:'圣甲虫', icon:'🪲', cubes:[5,12],   pat:[{q:0,r:0,req:'B'},{q:-1,r:0,req:'f',a:1},{q:-2,r:0,req:'M1'}] },
  { name:'海鸥',   icon:'🕊️', cubes:[5,11],   pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'f'},{q:-1,r:-1,req:'B',a:1}] },
  { name:'六角恐龙',icon:'🦎', cubes:[7,16],   pat:[{q:0,r:0,req:'M2'},{q:-1,r:0,req:'T2'},{q:-1,r:1,req:'w',a:1}] },
  { name:'骆驼',   icon:'🐫', cubes:[4,9,16], pat:[{q:0,r:0,req:'B'},{q:0,r:-1,req:'M1',a:1},{q:-1,r:-1,req:'f'}] },
  { name:'熊猫',   icon:'🐼', cubes:[5,13],   pat:[{q:0,r:0,req:'T3'},{q:-1,r:0,req:'M1'},{q:-1,r:1,req:'f',a:1}] },
  { name:'变色龙', icon:'🦎', cubes:[4,8,15], pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'T1',a:1},{q:-1,r:-1,req:'f'}] },
  { name:'牦牛',   icon:'🐂', cubes:[7,16],   pat:[{q:0,r:0,req:'w'},{q:-1,r:0,req:'M2',a:1},{q:-2,r:0,req:'f'}] },
  { name:'知更鸟', icon:'🐦', cubes:[4,10,17],pat:[{q:0,r:0,req:'T2'},{q:-1,r:0,req:'B',a:1},{q:-1,r:1,req:'M1'}] },
  { name:'食人鱼', icon:'🐟', cubes:[6,13],   pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'T3'},{q:-1,r:1,req:'w',a:1}] },
  { name:'老虎',   icon:'�', cubes:[3,10,16],pat:[{q:0,r:0,req:'w'},{q:0,r:-1,req:'M1'},{q:-1,r:-1,req:'T1',a:1}] },
];

// Pulse 卡标记:用于卡面加「可镜像对称放置」标识(镜像规则本身见 findMatches 的 allowMirror)
PULSE_CARDS.forEach(c => { c.pulse = 1; });

// ---- 自然之灵 11 张(图案与计分规则;名称取自含律动扩模组卡面,官方 10 张换鹿/猫/鹤/岩羊/熊/象龟并新增霸王龙;开局 2 选 1,完成图案后按专属规则计分) ----
const SPIRIT_CARDS = [
  { name:'狮子之灵',   icon:'🦁', cubes:[0], spirit:'f33',  desc:'每组田野:3枚以上10分,不足则2分', pat:[{q:0,r:0,req:'T2'},{q:-1,r:0,req:'f',a:1},{q:-2,r:0,req:'f'}] },
  { name:'蝴蝶之灵',   icon:'🦋', cubes:[0], spirit:'f5',   desc:'每组田野(1枚起)5分', pat:[{q:0,r:0,req:'f'},{q:0,r:-1,req:'w'},{q:-1,r:0,req:'w'},{q:-1,r:-1,req:'f',a:1}] },
  { name:'鹿之灵',     icon:'🦌', cubes:[0], spirit:'t423', desc:'每棵高2或3的树4分', pat:[{q:0,r:0,req:'T3'},{q:-1,r:0,req:'T2',a:1},{q:-2,r:0,req:'T1'}] },
  { name:'猫头鹰之灵', icon:'🦉', cubes:[0], spirit:'t321', desc:'每棵高1或2的树3分,高3的树1分', pat:[{q:0,r:0,req:'T1'},{q:-1,r:0,req:'T3',a:1},{q:-1,r:1,req:'T1'}] },
  { name:'猫之灵',     icon:'🐈‍⬛', cubes:[0], spirit:'b4',   desc:'每组建筑(1座起)4分', pat:[{q:0,r:0,req:'B'},{q:-1,r:0,req:'T1'},{q:-2,r:0,req:'B',a:1}] },
  { name:'鹤之灵',     icon:'🕊️', cubes:[0], spirit:'b6',   desc:'每组2座以上建筑6分', pat:[{q:0,r:0,req:'f'},{q:-1,r:0,req:'B'},{q:-2,r:0,req:'B',a:1}] },
  { name:'岩羊之灵',   icon:'🐏', cubes:[0], spirit:'m423', desc:'每座高2或3的山4分', pat:[{q:0,r:0,req:'M2'},{q:-1,r:0,req:'M3',a:1}] },
  { name:'熊之灵',     icon:'🐻', cubes:[0], spirit:'m321', desc:'每座高1或2的山3分,否则1分', pat:[{q:0,r:0,req:'M1'},{q:0,r:-1,req:'M2',a:1},{q:-1,r:-1,req:'M1'}] },
  { name:'蜻蜓之灵',   icon:'🪰', cubes:[0], spirit:'w7',   desc:'每组2枚以上河流7分', pat:[{q:0,r:0,req:'T2'},{q:-1,r:0,req:'w',a:1},{q:-2,r:0,req:'T2'}] },
  { name:'象龟之灵',   icon:'🐢', cubes:[0], spirit:'w2',   desc:'每枚河流2分', pat:[{q:0,r:0,req:'M2'},{q:-1,r:0,req:'w',a:1},{q:-2,r:0,req:'w'}] },
  { name:'霸王龙之灵', icon:'🦖', cubes:[0], spirit:'adj2', desc:'每1个与灵方块相邻(或经动物方块连通)的动物方块+2分', pat:[{q:0,r:0,req:'M3'},{q:-1,r:0,req:'f',a:1},{q:-2,r:0,req:'T3'}] },
];

/* 版图上的得分方块有三类:动物(橙) / 自然之灵(白) / 精灵(紫)。
   cell.cube.spirit 是新写入的标记;旧快照没有该字段时按卡名回退识别,
   保证读旧存档/晚到的联机快照也能正确显示与计分。 */
const SPIRIT_NAMES = new Set(SPIRIT_CARDS.map(c => c.name));
function isSpiritCube(cube) {
  if (!cube) return false;
  if (cube.spirit != null) return !!cube.spirit;
  return SPIRIT_NAMES.has(cube.card);
}

/* 关联卡牌插画:按分组目录存放(动物/自然之灵/Pulse),由官方卡面精灵图切分 */
const ANIMAL_DIR = 'Images/cards/动物', SPIRIT_DIR = 'Images/cards/自然之灵', PULSE_DIR = 'Images/cards/Pulse';
for (const c of [...BASE_CARDS, ...SPIRIT_CARDS, ...PULSE_CARDS]) {
  const dir = BASE_CARDS.includes(c) ? ANIMAL_DIR : SPIRIT_CARDS.includes(c) ? SPIRIT_DIR : PULSE_DIR;
  c.img = webpSrc(`${dir}/${c.name}.jpg`);
  loadImg(cardImgs, c.img, c.img);
}

// ---- Crescendo 精灵卡 10 张(官方规则:混洗牌库前加入;拿取时从供应堆取 2 个精灵方块放卡上 2 格;
//      版图达成栖息地后,只能把方块放到卡面带「*」的锚点格;目标格必须无精灵方块,
//      可与动物(橙)方块同格,但不能与自然之灵(白)方块同格;
//      两格都放完卡放版图旁不再计入 4 张上限;计分:与动物同格 5 分/格,单独 2 分/格) ----
const ELF_CARDS = [
  // 精灵牌1 卡面:1黄* + 1红 —— 红是单层红标记(r),不是 2 层建筑
  { name:'精灵牌1', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'f',a:1},{q:-1,r:0,req:'r'}] },
  { name:'精灵牌2', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'B',a:1},{q:-1,r:0,req:'t'}] },
  { name:'精灵牌3', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'M1',a:1},{q:-1,r:0,req:'w'}] },
  { name:'精灵牌4', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'T1',a:1},{q:-1,r:0,req:'M1'}] },
  { name:'精灵牌5', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'w',a:1},{q:-1,r:0,req:'f'}] },
  { name:'精灵牌6', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'f',a:1},{q:-1,r:0,req:'t'}] },
  { name:'精灵牌7', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'B',a:1},{q:-1,r:0,req:'T1'}] },
  { name:'精灵牌8', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'M1',a:1},{q:-1,r:0,req:'T2'}] },
  { name:'精灵牌9', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'T2',a:1},{q:-1,r:0,req:'w'}] },
  { name:'精灵牌10', icon:'🧚', elf:1, cubes:[2,5], pat:[{q:0,r:0,req:'w',a:1},{q:-1,r:0,req:'t'}] },
];

// ---- Crescendo 保护区牌 10 张(官方规则:混洗"建设中"面向上成堆,展示 3 个板块供选择;
//      回合可选行动:从 3 个可用板块拿 1 个放个人版图(视作卡牌,卡牌+板块 ≤4),回合结束用堆顶补足保持 3 个可见;
//      持板块时可无视一般放置规则,按板块 4 层颜色(下→上)在版图一格创建特殊堆叠,建成翻"完成"面;
//      计分:每个完成的保护区,其相邻格子中最顶标记与得分色匹配 → +3 分/格;
//      动物卡最后 1 个方块若所需颜色与得分色匹配,可放到保护区上(数量不限)完成该卡) ----
const SANCT_CARDS = [
  { name:'保护区牌1',  layers:['mountain','mountain','water','water'],   colors:['mountain','water'] },   // 灰灰蓝蓝 / 灰蓝
  { name:'保护区牌2',  layers:['field','water','water','water'],         colors:['field','water'] },       // 黄蓝蓝蓝 / 黄蓝
  { name:'保护区牌3',  layers:['mountain','mountain','trunk','tree'],    colors:['tree','mountain'] },     // 灰灰综绿 / 绿灰
  { name:'保护区牌4',  layers:['trunk','trunk','building','tree'],       colors:['tree','building'] },     // 综综红绿 / 绿红
  { name:'保护区牌5',  layers:['water','trunk','tree','tree'],           colors:['water','tree'] },        // 蓝综绿绿 / 蓝绿
  { name:'保护区牌6',  layers:['field','trunk','trunk','building'],      colors:['building','field'] },    // 黄综综红 / 红黄
  { name:'保护区牌7',  layers:['water','water','trunk','building'],      colors:['building','water'] },    // 蓝蓝综红 / 红蓝
  { name:'保护区牌8',  layers:['trunk','building','mountain','mountain'],colors:['mountain','building'] }, // 综红灰灰 / 灰红
  { name:'保护区牌9',  layers:['field','field','mountain','mountain'],   colors:['field','mountain'] },    // 黄黄灰灰 / 黄灰
  { name:'保护区牌10', layers:['tree','tree','field','field'],           colors:['field','tree'] },        // 绿绿黄黄 / 黄绿
];

// ---- 精灵卡/保护区卡插画(用户切图素材:精灵 ,保护区_a=建设中面/b=完成面) ----
for (let i = 0; i < ELF_CARDS.length; i++) {
  ELF_CARDS[i].img = webpSrc(`Images/cards/精灵/精灵牌${String(i+1).padStart(2,'0')}.png`);
  loadImg(cardImgs, ELF_CARDS[i].img, ELF_CARDS[i].img);
}
for (let i = 0; i < SANCT_CARDS.length; i++) {
  SANCT_CARDS[i].imgA = webpSrc(`Images/cards/保护区/保护区牌${String(i+1).padStart(2,'0')}_a.jpg`);
  SANCT_CARDS[i].imgB = webpSrc(`Images/cards/保护区/保护区牌${String(i+1).padStart(2,'0')}_b.jpg`);
  loadImg(cardImgs, SANCT_CARDS[i].imgA, SANCT_CARDS[i].imgA);
  loadImg(cardImgs, SANCT_CARDS[i].imgB, SANCT_CARDS[i].imgB);
}

/* 版图形状:A 5/4/5/4/5=23;B 4/3/4/3/4/3/4=25;C 3/4/4/5/4/4/3=27,挖中央(3,0)空穴=26;D 2/3/3/4/3/4/4/2=25 */
const BOARD_SHAPES = {
  A: { cols: { 0: [0, 4], 1: [0, 3], 2: [-1, 3], 3: [-1, 2], 4: [-2, 2] },
       rmin: { 0: 0, 1: 0, 2: -1, 3: -1, 4: -2 }, x0: 121 },
  B: { cols: { 0: [0, 3], 1: [0, 2], 2: [-1, 2], 3: [-1, 1], 4: [-2, 1], 5: [-2, 0], 6: [-3, 0] },
       rmin: { 0: 0, 1: 0, 2: -1, 3: -1, 4: -2, 5: -2, 6: -3 }, x0: 80 },
  // C/D:按官方版图照片逐格检测出的格心坐标(照片像素 → 画布等比缩放)
  // cofs:列内行号补偿,使 key 坐标系与 DIRS 邻接完全一致(每两列 +1),hexPx 用 +cofs[q] 还原照片位置
  C: { cols: { 0: [0, 2], 1: [-1, 2], 2: [-2, 1], 3: [-3, 1], 4: [-3, 0], 5: [-3, 0], 6: [-3, -1] },
       holes: ['3,-1'],
       cofs: { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3 },
       grid: { x0: 79.3, dx: 51.8, y0: 182.3, dy: 59.0 },
       bg: { key: 'boardC', s: 0.5542, ty: 31.6 } },
  D: { cols: { 0: [0, 1], 1: [-1, 1], 2: [-1, 1], 3: [-2, 1], 4: [-2, 0], 5: [-3, 0], 6: [-4, -1], 7: [-4, -3] },
       // 干旱格 = 照片中偏深色的格(共 18 格)
       dry: ['1,0',
             '2,-1', '2,0', '2,1', '3,-2', '3,-1', '3,0', '3,1',
             '4,-2', '4,-1', '4,0', '5,-3', '5,-2', '5,-1', '5,0',
             '6,-3', '6,-2', '6,-1'],
       cofs: { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3 },
       grid: { x0: 56.9, dx: 55.3, y0: 169.3, dy: 63.8 },
       bg: { key: 'boardD', s: 0.6188, ty: 17.0 } },
};
function boardCells(side) {
  const s = BOARD_SHAPES[side] || BOARD_SHAPES.A;
  const cells = [];
  const holes = s.holes || null;
  for (const q in s.cols) for (let r = s.cols[q][0]; r <= s.cols[q][1]; r++) {
    if (holes && holes.includes(q + ',' + r)) continue;
    cells.push({ q: +q, r });
  }
  return cells;
}

/* ============================================================
 * 六边形与图案工具
 * ============================================================ */
const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
const key = (q, r) => q + ',' + r;
function neighbors(q, r) { return DIRS.map(d => [q + d[0], r + d[1]]); }
// cube 坐标旋转 60°: (q,r,s=-q-r) -> (-r,-s,-q)
function rot60(c) { return { q: -c.r, r: c.q + c.r }; }
function mirror(c) { return { q: c.q + c.r, r: -c.r }; } // 沿主轴镜像
function orientations(pat, allowMirror) {
  const outs = [];
  for (const m of (allowMirror ? [false, true] : [false])) {
    let cur = pat.map(c => ({ q: c.q, r: c.r, req: c.req, a: c.a }));
    if (m) cur = cur.map(c => ({ ...mirror(c), req: c.req, a: c.a }));
    for (let i = 0; i < 6; i++) {
      outs.push(cur);
      cur = cur.map(c => ({ ...rot60(c), req: c.req, a: c.a }));
    }
  }
  // 归一化去重(平移到 min 锚点不重要,匹配时再加偏移;这里按形状签名去重)
  const seen = new Set(), res = [];
  for (const o of outs) {
    const sig = o.map(c => `${c.q},${c.r},${c.req},${c.a?1:0}`).sort().join('|');
    if (!seen.has(sig)) { seen.add(sig); res.push(o); }
  }
  return res;
}

