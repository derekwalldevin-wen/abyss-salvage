// 深渊打捞 · 纯数据目录。零 three、零 DOM，可在 Node 里直接 import 做无头模拟。
//
// 设计约束（对照 docs/plans/2026-09-27-abyss-salvage-design.md）：
// - 撤离奖励固定 8,000（参考作是 5,000，但本作路线更长、容错更低）
// - 初始资金 120,000（参考作 150,000）
// - 放弃行动退 30%（参考作退 0，是陷阱按钮）

export const START_MONEY = 120000;
export const MIN_MONEY = 15000;
export const INSURANCE = 0.5;        // 撤离时上了保险 → 阵亡返还比例
export const ABANDON_REFUND = 0.3;    // 放弃行动返还比例（> 0，避免陷阱）
export const EXTRACT_BONUS = 8000;
export const GUN_SELL_RATE = 0.6;
export const MED_PRICE = 700;
export const RAID_SECONDS = 12 * 60;

// ---------- 深度与压力（本作的核心系统） ----------
export const SEA_LEVEL = 0;           // y = 0
export const SEABED_Y = -46;
export const DEEPEST_FLOOR = -42;      // 舱底地面
export const PRESSURE_START = 20;     // 超过这个深度(m)开始掉血
export const PRESSURE_COEF = 0.55;
export const PRESSURE_EXP = 1.15;
export const O2_BASE = 1.0;           // 单位/秒
export const O2_PER_M = 0.055;        // 每超过阈值 1m 的额外消耗
export const O2_DEPTH_START = 24;
export const O2_MAX = 100;
export const EXTRACT_HOLD = 7;        // 秒
export const EXTRACT_RADIUS = 4;      // 米
export const REGEN_DELAY = 6;         // 脱战多少秒后开始回压/回氧

// 价值随深度线性放大：12m 处 ×1.0，42m 处 ×2.0
export function depthValueScale(depth) {
  return 1 + Math.max(0, depth - 12) / 30;
}

// 压力伤害（每秒）
export function pressureDamage(depth, skillDeepStart) {
  const s = skillDeepStart ?? PRESSURE_START;
  if (depth <= s) return 0;
  return PRESSURE_COEF * Math.pow(depth - s, PRESSURE_EXP);
}

// 氧气消耗（单位/秒）
export function o2Drain(depth) {
  return O2_BASE + Math.max(0, depth - O2_DEPTH_START) * O2_PER_M;
}

// ---------- 难度 ----------
// dmg 敌人伤害系数 · acc 敌人散布系数 · react 反应附加秒数 · view 视野系数
// count 敌人数量比例 · grace 开局保护秒 · regen 脱战回压(HP/s) · tokens 同时开火数
export const DIFFICULTY = {
  diver:   { name: '实习潜员', desc: '敌人少且枪法差，脱战回压回氧快', dmg: 0.22, acc: 1.6, react: 0.6, view: 0.72, count: 0.6, grace: 15, regen: 3.0, o2regen: 6.0, tokens: 2, loud: 0.6 },
  salvage: { name: '打捞工',   desc: '标准体验',                      dmg: 0.30, acc: 1.35, react: 0.3, view: 0.88, count: 0.82, grace: 12, regen: 1.4, o2regen: 3.0, tokens: 2, loud: 0.8 },
  foreman:  { name: '监工',     desc: '敌人精准凶狠，氧耗不赦人',        dmg: 0.44, acc: 1.0, react: 0, view: 1, count: 1, grace: 6, regen: 0, o2regen: 0, tokens: 99, loud: 1 },
};

// ---------- 武器 ----------
// dmg 单发 · rpm · auto · mag · reload · spread 散布(度) · range 射程(米)
// move 移速系数 · kick 后坐 · snd 音色
export const GUNS = {
  seacutter: { name: '断潮 切割器',  cls: '切割器', ammo: 'cell',  dmg: 21, rpm: 380, auto: false, mag: 14, reload: 1.7, spread: 2.6, range: 34, move: 1.00, price: 0,     kick: 0.6, snd: 'pistol' },
  harpoon:   { name: '鱼叉冲锋枪',   cls: '冲锋枪', ammo: 'cell',  dmg: 17, rpm: 840, auto: true,  mag: 32, reload: 2.1, spread: 3.2, range: 36, move: 0.98, price: 8000,  kick: 0.5, snd: 'smg' },
  reef:      { name: '礁岩 突击枪',  cls: '突击枪', ammo: 'cell',  dmg: 25, rpm: 750, auto: true,  mag: 30, reload: 2.4, spread: 2.2, range: 56, move: 0.94, price: 15000, kick: 0.8, snd: 'rifle' },
  trench:    { name: '海沟 突击枪',  cls: '突击枪', ammo: 'slug',  dmg: 31, rpm: 610, auto: true,  mag: 30, reload: 2.6, spread: 3.0, range: 56, move: 0.93, price: 17000, kick: 1.1, snd: 'rifle2' },
  breacher:  { name: '破舱 霰弹',   cls: '霰弹枪', ammo: 'shell', dmg: 13, rpm: 66,  auto: false, mag: 6,  reload: 3.2, spread: 8.5, range: 20, move: 0.95, price: 10000, kick: 2.2, snd: 'shotgun', pellets: 9 },
  longfin:   { name: '长鳍 狙击枪',  cls: '狙击枪', ammo: 'slug',  dmg: 128, rpm: 42, auto: false, mag: 5,  reload: 3.6, spread: 0.25, range: 118, move: 0.88, price: 29000, kick: 3.0, snd: 'sniper', scope: true },
  autospool: { name: '绞盘 重机枪',  cls: '轻机枪', ammo: 'cell',  dmg: 24, rpm: 770, auto: true,  mag: 100, reload: 5.2, spread: 3.8, range: 56, move: 0.82, price: 25000, kick: 0.9, snd: 'lmg' },
};

export const AMMO = {
  cell: { name: '压力弹匣组', box: 36 },
  slug: { name: '重型穿甲弹', box: 36 },
  shell:{ name: '破片弹鼓',   box: 14 },
};

// ---------- 护具 ----------
// lvl 等级 · dur 耐久 · cut 基础减伤 · price
// 耐久越低减免越弱：eff = cut × (0.35 + 0.65 × cur/dur)  （见 rules.js）
export const SUITS = [
  { id: 's0', name: '裸潜服',       lvl: 0, dur: 0,  cut: 0,    price: 0 },
  { id: 's1', name: '一级 帆布潜水服', lvl: 1, dur: 45, cut: 0.22, price: 1800 },
  { id: 's2', name: '二级 夹克潜水服', lvl: 2, dur: 65, cut: 0.35, price: 5200 },
  { id: 's3', name: '三级 硬式潜水服', lvl: 3, dur: 90, cut: 0.47, price: 13000 },
  { id: 's4', name: '四级 深潜装甲', lvl: 4, dur: 120, cut: 0.58, price: 25000 },
];
export const HELMS = [
  { id: 'h0', name: '无头盔',       lvl: 0, dur: 0,  cut: 0,    price: 0 },
  { id: 'h1', name: '一级 潜水帽',   lvl: 1, dur: 25, cut: 0.28, price: 1200 },
  { id: 'h2', name: '二级 面罩盔',   lvl: 2, dur: 38, cut: 0.42, price: 4000 },
  { id: 'h3', name: '三级 钛合金盔', lvl: 3, dur: 55, cut: 0.52, price: 10000 },
];
export const PACKS = [
  { id: 'k1', name: '网兜',   slots: 8,  price: 0 },
  { id: 'k2', name: '背囊',   slots: 14, price: 3200 },
  { id: 'k3', name: '拖网',   slots: 22, price: 8500 },
];

export const RARITY = ['普通', '优良', '精良', '稀有', '史诗', '传说'];
export const RARITY_COLOR = ['#b9c0c7', '#5fd068', '#4aa3ff', '#b36bff', '#ffb938', '#ff4d4f'];

// ---------- 战利品 ----------
// r 稀有度 0-5 · v 基础价值(浅层) · s 占格 · deep 最低生成深度(m)，-1 = 不限
// depthFloor 越高 = 只能在水下深处找到
export const ITEMS = {
  // 普通 —— 补给与垃圾
  ration:     { name: '压缩口粮',   ic: '🥫', r: 0, v: 450,  s: 1, deep: -1 },
  sealant:    { name: '封堵胶',     ic: '🧴', r: 0, v: 800,  s: 1, deep: -1 },
  rag:        { name: '滤布',       ic: '🧻', r: 0, v: 600,  s: 1, deep: -1 },
  lead:       { name: '配重块',     ic: '🧱', r: 0, v: 950,  s: 1, deep: -1 },
  tape:       { name: '防水胶带',   ic: '🧷', r: 0, v: 700,  s: 1, deep: -1 },
  bolts:      { name: '螺栓盒',     ic: '🔩', r: 0, v: 650,  s: 1, deep: -1 },
  buoylight:  { name: '浮标灯',     ic: '💡', r: 0, v: 1100, s: 1, deep: -1 },
  netting:    { name: '缆网',       ic: '🪢', r: 0, v: 820,  s: 1, deep: -1 },
  // 优良 —— 器械
  toolkit:    { name: '潜水工具组', ic: '🧰', r: 1, v: 2300, s: 1, deep: -1 },
  gauge:      { name: '压力表',     ic: '📟', r: 1, v: 2900, s: 1, deep: -1 },
  torch:      { name: '防水灯',     ic: '🔦', r: 1, v: 2600, s: 1, deep: -1 },
  radio:      { name: '防水对讲机', ic: '📻', r: 1, v: 4200, s: 1, deep: -1 },
  filter:     { name: '滤毒罐',     ic: '🫙', r: 1, v: 2500, s: 1, deep: -1 },
  cpu:        { name: '控制芯片',   ic: '🔳', r: 1, v: 4600, s: 1, deep: -1 },
  divebell:   { name: '潜水钟配件', ic: '🛠️', r: 1, v: 4800, s: 2, deep: 10 },
  // 精良 —— 电子
  ssd:        { name: '军用固态盘', ic: '💾', r: 2, v: 9600,  s: 1, deep: 12 },
  drone:      { name: '巡检无人机', ic: '🛸', r: 2, v: 16000, s: 2, deep: 16 },
  thermal:    { name: '热成像仪',   ic: '📷', r: 2, v: 17500, s: 2, deep: 18 },
  nvg:        { name: '夜视仪',     ic: '🥽', r: 2, v: 14000, s: 2, deep: 20 },
  console:    { name: '控制台',     ic: '🖥️', r: 2, v: 15000, s: 2, deep: 18 },
  satphone:   { name: '卫星电话',   ic: '📡', r: 2, v: 12500, s: 1, deep: 22 },
  coreboard:  { name: '钻控主板',   ic: '🔲', r: 2, v: 18200, s: 2, deep: 24 },
  // 稀有 —— 机密
  charts:     { name: '打捞图册',   ic: '🗺️', r: 3, v: 24000, s: 1, deep: 26 },
  keycard:    { name: '舱门权限卡', ic: '💳', r: 3, v: 27000, s: 1, deep: 28 },
  bullion:    { name: '金锭',       ic: '🟨', r: 3, v: 33000, s: 1, deep: 30 },
  gem:        { name: '海蓝宝石',   ic: '💎', r: 3, v: 36000, s: 1, deep: 32 },
  assay:      { name: '贵金属化验单', ic: '📁', r: 3, v: 22000, s: 1, deep: 28 },
  // 史诗 —— 沉船宝藏
  watch:      { name: '潜水腕表',   ic: '⌚', r: 4, v: 58000, s: 1, deep: 30 },
  statue:     { name: '青铜像',     ic: '🗿', r: 4, v: 66000, s: 2, deep: 32 },
  porthole:   { name: '鎏金舷窗',   ic: '🪟', r: 4, v: 52000, s: 2, deep: 34 },
  scope:      { name: '军用光学镜', ic: '🔭', r: 4, v: 48000, s: 1, deep: 30 },
  propeller:  { name: '黄铜螺旋桨', ic: '⚙️', r: 4, v: 72000, s: 3, deep: 36 },
  // 传说 —— 平台核心
  reactor:    { name: '「墨龙」反应芯', ic: '❤️‍🔥', r: 5, v: 190000, s: 2, deep: 36 },
  blackbox:   { name: '黑匣子',     ic: '✈️', r: 5, v: 150000, s: 1, deep: 38 },
  pearl:      { name: '深渊珍珠',   ic: '✨', r: 5, v: 220000, s: 1, deep: 40 },
  anodyne:    { name: '耐压合金锭', ic: '☢️', r: 5, v: 170000, s: 2, deep: 34 },
};

// ---------- 容器 ----------
// n 物品条数区间 · w 6 档稀有度权重 · extras 独立掷骰的额外产出
export const CONTAINERS = {
  netbag:   { name: '网兜',     n: [1, 3], w: [50, 32, 13, 4, 1, 0],    extras: { ammo: 0.35, med: 0.10 } },
  crate:    { name: '板条箱',   n: [2, 4], w: [22, 36, 26, 11, 4, 1],   extras: { ammo: 0.6, gun: 0.28, suit: 0.15, nade: 0.35 } },
  toolbox:  { name: '工具柜',   n: [2, 3], w: [45, 40, 13, 2, 0, 0],    extras: { ammo: 0.2 } },
  medkit:   { name: '医疗箱',   n: [1, 2], w: [40, 50, 10, 0, 0, 0],    extras: { med: 1.0, med2: 0.5 } },
  ammo:     { name: '弹药箱',   n: [0, 1], w: [60, 40, 0, 0, 0, 0],     extras: { ammo: 1.0, ammo2: 1.0, ammo3: 0.6, nade: 0.6 } },
  // 保险库只在深处，且权重整体上移
  vault:    { name: '保险库',   n: [2, 3], w: [0, 10, 32, 34, 17, 7],   extras: {}, minDepth: 30 },
  // 舱底封死货舱：史诗起步
  hold:     { name: '封死货舱', n: [2, 3], w: [0, 0, 20, 38, 30, 12],   extras: { gun: 0.2 }, minDepth: 36 },
};

export function loadoutCost(lo) {
  const g = GUNS[lo.gun]; const s = SUITS.find(x => x.id === lo.suit);
  const h = HELMS.find(x => x.id === lo.helm); const k = PACKS.find(x => x.id === lo.pack);
  if (!g || !s || !h || !k) return null;
  const meds = Math.max(0, Math.min(4, lo.meds | 0));
  return g.price + s.price + h.price + k.price + meds * MED_PRICE;
}

// 撤离结算：物品价值（按取出的实际深度放大） + 枪按比例折现
export function haulValue(items, guns, depthScale = 1) {
  let v = 0;
  for (const k of items || []) if (ITEMS[k]) v += Math.round(ITEMS[k].v * depthScale);
  for (const k of guns || []) if (GUNS[k]) v += Math.round(GUNS[k].price * GUN_SELL_RATE);
  return v;
}

// ---------- 敌人 ----------
// guns 可用枪 · hp · suit/helm 等级池 · range 交战距离 · view 视野 · react 反应
export const ROLES = {
  guard:   { name: '平台保安',     guns: ['reef', 'trench'], hp: 100, suits: [1, 1, 2, 2, 3], helms: [1, 1, 0, 2], range: [12, 26], view: 42, react: 0.55, acc: 1.0, patrolR: [1, 12] },
  runner:  { name: '巡舱员',       guns: ['harpoon'],        hp: 100, suits: [1, 1, 2],        helms: [0, 1],        range: [6, 14],  view: 38, react: 0.45, acc: 1.0, patrolR: [1, 10] },
  breacher:{ name: '破门工',       guns: ['breacher'],       hp: 110, suits: [2],           helms: [1],          range: [3, 8],   view: 34, react: 0.5,  acc: 1.0, patrolR: [1, 6] },
  spotter: { name: '观察哨',       guns: ['longfin'],        hp: 90,  suits: [1],           helms: [1],          range: [25, 70], view: 75, react: 1.3, acc: 0.8, patrolR: [1, 1], static: true },
  foreman: { name: '监工卫队',     guns: ['reef', 'trench'], hp: 110, suits: [3, 3, 2],     helms: [2, 1],       range: [8, 20],  view: 40, react: 0.4,  acc: 0.85, patrolR: [1, 5], always: true },
  gunner:  { name: '舱面机枪手',   guns: ['autospool'],      hp: 130, suits: [3],           helms: [2],          range: [10, 24], view: 40, react: 0.65, acc: 1.35, patrolR: [1, 8] },
  // Boss 在舱底 -38m，掉落最高价值
  anchor:  { name: '首席监工「铁锚」', guns: ['autospool'],    hp: 260, suits: [4],           helms: [3],          range: [8, 20],  view: 46, react: 0.5,  acc: 1.25, patrolR: [2, 2], always: true, boss: true, depth: 38 },
};

// ---------- 潜水员技能（进程曲线；参考作完全没有） ----------
// tier: 需求撤离总额 · cost: 信用点花费 · apply 由 rules.js 解释
export const SKILLS = {
  // 呼吸系
  deepAdapt:  { name: '深潜适应',   tier: 0,    cost: 1, line: 'breath', desc: '压力伤害起始深度 20m → 26m' },
  bigTank:    { name: '高压气瓶',   tier: 1,    cost: 2, line: 'breath', desc: '气瓶容量 +25' },
  quickAsc:   { name: '快速上升',   tier: 2,    cost: 3, line: 'breath', desc: '减压读条 7s → 5.5s' },
  slowBurn:   { name: '缓燃节流',   tier: 3,    cost: 4, line: 'breath', desc: '氧气消耗 −18%' },
  // 装备系
  suitPlus:   { name: '强化潜水服', tier: 0,    cost: 1, line: 'gear',  desc: '护服有效防护 +12%' },
  fastStrip:  { name: '快拆装',     tier: 1,    cost: 2, line: 'gear',  desc: '换弹与切枪速度 +20%' },
  bigPack:    { name: '扩容背囊',   tier: 2,    cost: 3, line: 'gear',  desc: '背囊 +6 格' },
  // 打捞系
  steady:     { name: '稳手',       tier: 0,    cost: 1, line: 'salv',  desc: '散布 −15%' },
  greedy:     { name: '贪婪之爪',   tier: 1,    cost: 2, line: 'salv',  desc: '容器每次多揭示 1 条' },
  quickPry:   { name: '快速破拆',   tier: 1,    cost: 2, line: 'salv',  desc: '搜刮揭示速度 +30%' },
  // 战术系
  silencer:   { name: '消音',       tier: 2,    cost: 3, line: 'tac',   desc: '枪声传播半径 −40%' },
  extraNade:  { name: '诱饵手雷',   tier: 3,    cost: 4, line: 'tac',   desc: '手雷 +1，爆炸范围 +20%' },
  blastRes:   { name: '抗冲击',     tier: 3,    cost: 4, line: 'tac',   desc: '受爆炸伤害 −35%' },
};

export const CREDIT = 1;  // 每撤离 1,000 价值给 1 信用点
export function creditsFor(value) { return Math.floor(value / 1000); }

// 派生的技能修正（唯一解释 skills 的地方，避免散落在各处）
export function skillMods(sk = {}) {
  return {
    pressureStart: sk.deepAdapt ? 26 : PRESSURE_START,
    o2Max: O2_MAX + (sk.bigTank ? 25 : 0),
    holdTime: sk.quickAsc ? 5.5 : EXTRACT_HOLD,
    o2Cost: sk.slowBurn ? 0.82 : 1,
    suitCut: sk.suitPlus ? 0.12 : 0,
    reloadMul: sk.fastStrip ? 0.8 : 1,
    packBonus: sk.bigPack ? 6 : 0,
    spreadMul: sk.steady ? 0.85 : 1,
    revealBonus: sk.greedy ? 1 : 0,
    revealSpeed: sk.quickPry ? 1.3 : 1,
    noiseMul: sk.silencer ? 0.6 : 1,
    nadeBonus: sk.extraNade ? 1 : 0,
    nadeRadius: sk.extraNade ? 1.2 : 1,
    blastRes: sk.blastRes ? 0.65 : 1,
  };
}
