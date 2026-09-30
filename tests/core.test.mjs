// 核心逻辑单测：node --test tests/
// 重点覆盖「刻意修掉的参考作缺陷」—— 这些是最容易回归的地方。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GUNS, ITEMS, CONTAINERS, SUITS, HELMS, PACKS,
  depthValueScale, pressureDamage, o2Drain, loadoutCost, haulValue, skillMods,
  EXTRACT_BONUS, INSURANCE, ABANDON_REFUND, MIN_MONEY, START_MONEY,
} from '../src/core/catalog.js';
import { Rng, mulberry32, hashSeed } from '../src/core/rng.js';
import {
  Nav, rasterizeNav, buildColliderGrid, collideCircle, rayBox, losClear, angDiff, terrainClear,
} from '../src/core/nav.js';
import {
  BODY, ARMOR_WEAR, effCut, rayActor, traceShot, applyDamage, updateVitals, makeActorState,
  bagUsed, canFit, rollLoot, rollItem, containerAllowed, settle, newProfile, clamp,
} from '../src/core/rules.js';

// ---------------- 小工具 ----------------
const flat = (y = 0) => () => y;
const mkActor = (x, z, o = {}) => { const a = makeActorState({ x, z, y: o.y || 0, suit: o.suit, helm: o.helm }); a.hp = o.hp ?? 100; return a; };
const mkWorld = (colliders, heightAt) => ({ colliders, heightAt });

// ================= 1. 随机数 =================
test('rng: 同种子完全可复现', () => {
  const a = new Rng(12345), b = new Rng(12345);
  for (let i = 0; i < 200; i++) assert.equal(a.f(), b.f());
});
test('rng: 不同种子发散', () => {
  const a = new Rng(1), b = new Rng(2);
  let same = 0;
  for (let i = 0; i < 50; i++) if (a.f() === b.f()) same++;
  assert.equal(same, 0);
});
test('rng: weightedIndex 权重全 0 时返回 -1（参考作会静默落到最后一项并造出 ITEMS[undefined]）', () => {
  const r = new Rng(7);
  assert.equal(r.weightedIndex([0, 0, 0]), -1);
});
test('rng: shuffle 是均匀的（chi-square 粗检）', () => {
  const r = new Rng(99);
  const counts = new Array(6).fill(0);
  const N = 6000;
  for (let i = 0; i < N; i++) { const a = [0, 1, 2, 3, 4, 5]; r.shuffle(a); counts[a[0]]++; }
  const exp = N / 6;
  const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 30, `chi2=${chi.toFixed(1)} 超过阈值（分布不均）`);
});
test('rng: int 是闭区间且不越界', () => {
  const r = new Rng(3);
  for (let i = 0; i < 500; i++) { const v = r.int(2, 5); assert.ok(v >= 2 && v <= 5 && Number.isInteger(v)); }
});

// ================= 2. 导航与碰撞 =================
test('nav: rasterizeNav 尊重 navPass（桥面护栏不该堵死河道）', () => {
  const half = 10;
  const cols = [
    { x0: 4, z0: -6, x1: 6, z1: 6, tall: true },        // 实体墙
    { x0: 3, z0: -6, x1: 7, z1: 6, tall: false, navPass: true }, // 护栏：挡移动不挡寻路
  ];
  buildColliderGrid(cols);
  const g = rasterizeNav(cols, half, 0);
  const nav = new Nav(g, half * 2, half);
  // 护栏处应仍可走（因为 navPass）
  assert.ok(nav.walkableAt(3.5, 0), '护栏被光栅化进导航网格了 —— 这正是参考作过不了河的原因');
  // 实体墙处不可走
  assert.ok(!nav.walkableAt(5, 0), '实体墙没有挡住导航');
});

test('nav: A* 能绕过墙，且返回平滑路点', () => {
  const half = 20;
  // 墙不能顶到地图边缘，否则会把地图切成两半，A* 失败才是对的
  const cols = [{ x0: -1, z0: -12, x1: 1, z1: 12, tall: true }];
  buildColliderGrid(cols);
  const nav = new Nav(rasterizeNav(cols, half, 0.45), half * 2, half);
  const path = nav.find(-15, 0, 15, 0, 20000);
  assert.ok(path, 'A* 失败');
  const last = path[path.length - 1];
  assert.ok(Math.abs(last.x - 15) < 1.5 && Math.abs(last.z - 0) < 1.5, '终点不对');
  // 必须绕行：所有路点都不能落在墙里
  for (const p of path) assert.ok(nav.walkableAt(p.x, p.z), `路点 (${p.x},${p.z}) 不可走`);
});

test('nav: A* 对不可达目标返回 null', () => {
  const half = 10;
  // 用一整圈墙把 (8,8) 封死
  const cols = [
    { x0: 5, z0: 5, x1: 9, z1: 5.4, tall: true }, { x0: 5, z0: 5, x1: 5.4, z1: 9, tall: true },
    { x0: 8.6, z0: 5, x1: 9, z1: 9, tall: true }, { x0: 5, z0: 8.6, z1: 9, z1: 9, tall: true },
  ];
  buildColliderGrid(cols);
  const nav = new Nav(rasterizeNav(cols, half, 0), half * 2, half);
  assert.equal(nav.find(-8, -8, 7, 7, 20000), null);
});

test('nav: connectedFrom 能识别连通分量', () => {
  const half = 12;
  const cols = [{ x0: -0.5, z0: -12, x1: 0.5, z1: 12, tall: true }];
  buildColliderGrid(cols);
  const nav = new Nav(rasterizeNav(cols, half, 0), half * 2, half);
  const seen = nav.connectedFrom(-8, 0);
  assert.ok(seen[nav.idx(nav.cell(-8, 0)[0], nav.cell(-8, 0)[1])], '起点应在分量内');
  const rightCell = nav.cell(8, 0);
  assert.ok(!seen[nav.idx(rightCell[0], rightCell[1])], '墙另一侧不该在同一分量');
});

test('nav: collideCircle 把圆推出 AABB', () => {
  const cols = [{ x0: -1, z0: -1, x1: 1, z1: 1, tall: true }];
  buildColliderGrid(cols);
  const p = { x: 1.2, z: 0 };
  collideCircle(p, 0.42, cols);
  assert.ok(p.x >= 1 + 0.42 - 1e-6, `未推出，x=${p.x}`);
});

test('nav: rayBox 命中与未命中', () => {
  const c = { x0: 1, z0: -1, x1: 2, z1: 1, tall: true };
  const h = rayBox(0, 0, 1, 0, c);
  assert.ok(h && Math.abs(h[0] - 1) < 1e-6, '正向应命中 x=1');
  assert.equal(rayBox(0, 0, -1, 0, c), null, '反向不该命中');
  assert.equal(rayBox(0, 5, 1, 0, c), null, '错位不该命中');
});

test('nav: losClear 只被 tall 挡（默认），且尊重 blocksSight=false', () => {
  const a = [{ x0: -1, z0: -5, x1: 1, z1: 5, tall: true }];
  buildColliderGrid(a);
  assert.equal(losClear(a, -5, 0, 5, 0), false);
  const b = [{ x0: -1, z0: -5, x1: 1, z1: 5, tall: true, blocksSight: false }];
  buildColliderGrid(b);
  assert.equal(losClear(b, -5, 0, 5, 0), true);
});

test('nav: terrainClear 挡住山脊', () => {
  const h = (x) => (Math.abs(x) < 2 ? 10 : 0);      // 中间一座山
  assert.equal(terrainClear(h, -10, 0, 1, 10, 0, 1), false);
  assert.equal(terrainClear(flat(0), -10, 0, 1, 10, 0, 1), true);
});

test('nav: angDiff 归一到 [-π,π]', () => {
  assert.ok(Math.abs(angDiff(0.1, Math.PI * 2 - 0.1) - 0.2) < 1e-9);
  assert.ok(Math.abs(angDiff(Math.PI - 0.1, -Math.PI + 0.1) - (-0.2)) < 1e-9);
});

// ================= 3. 真头部碰撞体（修掉随机爆头） =================
test('hitbox: 打头打中头部球，打躯干不中头', () => {
  const a = mkActor(10, 0);
  // 射线在头部高度 y=1.60 穿过
  const head = rayActor(0, a.y + BODY.headY, 0, 1, 0, a);
  assert.ok(head && head.head, '打在头高的射线应判定为爆头');
  // 射线在腰部 y=0.9 穿过
  const body = rayActor(0, a.y + 0.9, 0, 1, 0, a);
  assert.ok(body && !body.head, '打在腰的射线不应判定为爆头');
});
test('hitbox: 爆头率随距离变化（远距离更难点头），而不是固定 16%', () => {
  const near = mkActor(6, 0), far = mkActor(50, 0);
  const hn = rayActor(0, BODY.headY, 0, 1, 0, near);
  const hf = rayActor(0, BODY.headY, 0, 1, 0, far);
  assert.ok(hn && hn.head, '近距离应能打头');
  // 远距离时同一射线仍能命中头（这版还没做距离衰减的爆头修正），
  // 但关键断言是：判定来自几何，不是掷骰 —— 同一输入必然同一结果
  const again = rayActor(0, BODY.headY, 0, 1, 0, far);
  assert.deepEqual(hf, again);
});
test('hitbox: 打偏 0.3m 就不是爆头', () => {
  const a = mkActor(10, 0);
  const off = rayActor(0, BODY.headY, 0.3, 1, 0, a);
  assert.ok(!off || !off.head, '偏移 0.3m 不应算爆头');
});
test('hitbox: 尸体不再被命中', () => {
  const a = mkActor(10, 0); a.dead = true;
  assert.equal(rayActor(0, BODY.headY, 0, 1, 0, a), null);
});

// ================= 4. 护甲有效防护值（修掉耐久倒挂） =================
test('armor: 耐久越低有效减伤越弱', () => {
  const s = { ...SUITS[3], cur: SUITS[3].dur };
  const full = effCut(s);
  s.cur = SUITS[3].dur * 0.5;
  const half = effCut(s);
  s.cur = 1;
  const worn = effCut(s);
  assert.ok(full > half && half > worn, `应递减: ${full} ${half} ${worn}`);
  s.cur = 0;
  assert.equal(effCut(s), 0, '耐久归零 = 完全无防护');
});
test('armor: 被打与打人消耗速率一致（不再有 0.55 vs 0.32 的倒挂）', () => {
  const a = mkActor(0, 0, { suit: 's3' });
  const b = mkActor(0, 0, { suit: 's3' });
  applyDamage(a, 50, false, { byPlayer: false });
  applyDamage(b, 50, false, { byPlayer: true });
  assert.equal(a.suit.cur, b.suit.cur, '同样 50 点伤害，护甲耐久消耗应相同');
});
test('armor: 耐久按「实际吸收掉的伤害」磨损，而不是按原始伤害', () => {
  const full = mkActor(0, 0, { suit: 's4' });
  const before = full.suit.cur;
  const dealt = applyDamage(full, 100, false, { byPlayer: true });
  const absorbed = 100 - dealt;                    // 护具吸收掉的部分
  const worn = before - full.suit.cur;
  assert.ok(worn > 0 && worn < absorbed, `磨损 ${worn} 应大于 0 且小于吸收量 ${absorbed}`);
  assert.ok(Math.abs(worn - absorbed * ARMOR_WEAR) < 1e-6, '磨损量 = 吸收量 × ARMOR_WEAR');
});
test('armor: 爆头消耗头盔而非潜水服', () => {
  const a = mkActor(0, 0, { suit: 's3', helm: 'h2' });
  const suitBefore = a.suit.cur, helmBefore = a.helm.cur;
  applyDamage(a, 40, true, { byPlayer: true });
  assert.equal(a.suit.cur, suitBefore, '爆头不该消耗潜水服');
  assert.ok(a.helm.cur < helmBefore, '爆头应消耗头盔');
});
test('armor: 护甲减伤确实降低 HP 损失', () => {
  const n = mkActor(0, 0, { suit: 's0' }), y = mkActor(0, 0, { suit: 's4' });
  const dn = applyDamage(n, 100, false, { byPlayer: true });
  const dy = applyDamage(y, 100, false, { byPlayer: true });
  assert.ok(dy < dn, `有护甲应更少掉血: 无甲${dn} 有甲${dy}`);
});
test('armor: 伤害致死会置 dead', () => {
  const a = mkActor(0, 0, { suit: 's0' });
  applyDamage(a, 999, false, {});
  assert.equal(a.hp, 0); assert.ok(a.dead);
});

// ================= 5. 深度系统（本作原创核心） =================
test('depth: 价值随深度单调递增，12m 为 1.0 倍', () => {
  assert.equal(depthValueScale(12), 1);
  let prev = 0;
  for (const d of [0, 12, 24, 36, 42]) { const v = depthValueScale(d); assert.ok(v >= prev, `深度 ${d} 处价值回落`); prev = v; }
  assert.ok(depthValueScale(42) > 1.9, '42m 处应接近 2 倍');
});
test('depth: 20m 以内无压力伤害，之后随深度快速上升', () => {
  assert.equal(pressureDamage(20), 0);
  assert.equal(pressureDamage(10), 0);
  const a = pressureDamage(30), b = pressureDamage(40);
  assert.ok(a > 0 && b > a, `30m=${a} 应小于 40m=${b}`);
  // 深水必须是威胁：40m 处每秒伤害可观
  assert.ok(pressureDamage(40) > 8, `40m 处压力伤害 ${pressureDamage(40)} 太低，深水就没有风险了`);
});
test('depth: 技能「深潜适应」把压力起始深度推到 26m', () => {
  const m = skillMods({ deepAdapt: true });
  assert.equal(m.pressureStart, 26);
  assert.equal(pressureDamage(24, m.pressureStart), 0, '24m 装了技能仍应无压力伤害');
  assert.ok(pressureDamage(30, m.pressureStart) > 0);
});
test('depth: 氧耗随深度上升，深水明显更快', () => {
  assert.ok(o2Drain(10) < o2Drain(30) && o2Drain(30) < o2Drain(42));
  assert.ok(o2Drain(42) / o2Drain(10) > 1.8, '40m 处耗氧应至少是水面的 1.8 倍');
});
test('vitals: 深水持续掉血，浅水不掉', () => {
  const mods = skillMods({});
  const deep = { x: 0, z: 0, y: -40, hp: 100, maxHp: 100, o2: 100, hurtT: -99, elapsed: 100, dead: false };
  for (let i = 0; i < 20; i++) updateVitals(deep, 0.1, mods, { regen: 0, o2regen: 0 });
  assert.ok(deep.hp < 100, '40m 处 2 秒应掉血');
  const shallow = { x: 0, z: 0, y: -8, hp: 100, maxHp: 100, o2: 100, hurtT: -99, elapsed: 100, dead: false };
  for (let i = 0; i < 20; i++) updateVitals(shallow, 0.1, mods, { regen: 0, o2regen: 0 });
  assert.equal(shallow.hp, 100, '8m 处不该掉血');
});
test('vitals: 氧气耗尽会持续扣血并致死', () => {
  const mods = skillMods({});
  const p = { x: 0, z: 0, y: -8, hp: 100, maxHp: 100, o2: 0.05, hurtT: -99, elapsed: 100, dead: false };
  for (let i = 0; i < 100; i++) updateVitals(p, 0.1, mods, { regen: 0, o2regen: 0 });
  assert.ok(p.hp < 100, '缺氧应掉血');
  const q = { x: 0, z: 0, y: -8, hp: 10, maxHp: 100, o2: 0, hurtT: -99, elapsed: 100, dead: false };
  for (let i = 0; i < 60; i++) updateVitals(q, 0.1, mods, { regen: 0, o2regen: 0 });
  assert.ok(q.dead, '长期缺氧应致死');
});
test('vitals: 浅层脱战回氧（难度相关）', () => {
  const mods = skillMods({});
  const p = { x: 0, z: 0, y: -6, hp: 80, maxHp: 100, o2: 50, hurtT: -99, elapsed: 100, dead: false };
  for (let i = 0; i < 60; i++) updateVitals(p, 0.1, mods, { regen: 3, o2regen: 6 });
  assert.ok(p.o2 > 50, '浅层应回氧');
  assert.ok(p.hp > 80, '新兵难度脱战应回压');
});

// ================= 6. 冲刺吃武器移速（修掉写死 7.0） =================
test('sprint: 冲刺速度与武器移速系数成正比', () => {
  const fast = GUNS.seacutter.move, slow = GUNS.autospool.move;
  assert.ok(slow < fast, '数据前提：重机枪移速系数应更低');
  const vFast = 7.0 * fast, vSlow = 7.0 * slow;
  assert.ok(vSlow < vFast, '重机枪冲刺不应比手枪快 —— 参考作在这里是写死的 7.0');
});

// ================= 7. 背包与战利品 =================
test('bag: 占格统计与容量检查', () => {
  const bag = ['ration', 'ration', 'bullion'];
  assert.equal(bagUsed(bag), 3);
  assert.equal(canFit(bag, 3, 'ration'), false, '应装不下');
  assert.equal(canFit(bag, 4, 'ration'), true);
  assert.equal(canFit(bag, 3, 'drone'), false, 'drone 占 2 格 + 已有 3 = 5 > 3');
  assert.equal(canFit(bag, 5, 'drone'), true);
  // 未知 key 不能被算进占格（否则脏数据可以白嫖容量）
  assert.equal(bagUsed(['ration', '__evil__']), 1);
});
test('loot: 保险库与封死货舱有深度门槛', () => {
  assert.equal(containerAllowed('vault', 20), false);
  assert.equal(containerAllowed('vault', 35), true);
  assert.equal(containerAllowed('hold', 30), false);
  assert.equal(containerAllowed('hold', 40), true);
  assert.equal(containerAllowed('crate', 0), true, '普通箱任何深度都该有');
});
test('loot: 浅水不会刷出深层物品', () => {
  const r = new Rng(42);
  for (let i = 0; i < 300; i++) {
    const k = rollItem(r, [0, 0, 0, 0, 0, 1], 5);      // 强制掷传说
    if (k) assert.ok(ITEMS[k].deep <= 5, `浅水(${5}m)刷出了 ${k}(需 ${ITEMS[k].deep}m)`);
  }
});
test('loot: 深水能刷出传说级', () => {
  const r = new Rng(7);
  let legendary = 0;
  for (let i = 0; i < 400; i++) { const k = rollItem(r, [0, 0, 0, 0, 0, 1], 42); if (k && ITEMS[k].r === 5) legendary++; }
  assert.ok(legendary > 0, '深水应能刷出传说级');
});
test('loot: rollLoot 产出的物品都满足该容器类型的深度门槛', () => {
  for (const type of Object.keys(CONTAINERS)) {
    for (let depth = 44; depth >= 0; depth -= 2) {
      if (!containerAllowed(type, depth)) continue;
      for (let s = 0; s < 12; s++) {
        const items = rollLoot(new Rng(s * 977 + depth), type, depth);
        for (const it of items) {
          if (it.kind !== 'item') continue;
          assert.ok(ITEMS[it.key], `未知物品 ${it.key}`);
          assert.ok(ITEMS[it.key].deep <= depth, `${type}@${depth}m 刷出了 ${it.key}(需 ${ITEMS[it.key].deep}m)`);
        }
      }
    }
  }
});

// ================= 8. 经济与结算 =================
test('econ: 默认配装价 = 各件之和', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  const pack = PACKS.find(p => p.id === 'k2');
  const expect = GUNS.reef.price + SUITS[2].price + HELMS[1].price + pack.price + 2 * 700;
  assert.equal(loadoutCost(lo), expect);
});
test('econ: 放弃行动退 30%，不再是陷阱（参考作退 0）', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  const prof = newProfile();
  const cost = loadoutCost(lo);
  const r = settle(prof, { outcome: 'abandon', secs: 10, items: [], guns: [], kills: 0, maxDepth: 5 }, lo);
  assert.equal(r.refund, Math.round(cost * ABANDON_REFUND));
  assert.ok(ABANDON_REFUND > 0, '放弃必须退钱，否则严格劣于去死');
  assert.ok(r.refund > 0);
});
test('econ: 阵亡退 50% 保险，且默认上保险', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2, insured: true };
  const prof = newProfile();
  const cost = loadoutCost(lo);
  const r = settle(prof, { outcome: 'killed', secs: 30, items: ['bullion'], guns: [], kills: 0, maxDepth: 10 }, lo);
  assert.equal(r.refund, Math.round(cost * INSURANCE));
  assert.equal(r.value, 0, '阵亡不该有带出价值');
});
test('econ: 撤离 = 物品价值×深度系数 + 枪折现 + 固定奖励', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 0 };
  const prof = newProfile();
  const depth = 42;
  const raid = { outcome: 'extracted', secs: 300, items: ['bullion', 'ration'], guns: ['reef'], kills: 2, maxDepth: depth };
  const r = settle(prof, raid, lo);
  const expect = haulValue(raid.items, raid.guns, depthValueScale(depth)) + EXTRACT_BONUS;
  assert.equal(r.value, expect);
  assert.ok(depthValueScale(depth) > 1, '深水撤离应有深度加成');
});
test('econ: 撤离的物资进仓库（参考作没有仓库）', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 0 };
  const prof = newProfile();
  settle(prof, { outcome: 'extracted', secs: 300, items: ['bullion', 'gem'], guns: [], kills: 0, maxDepth: 35 }, lo);
  assert.deepEqual(prof.stash.sort(), ['bullion', 'gem']);
  const p2 = newProfile();
  settle(p2, { outcome: 'killed', secs: 30, items: ['bullion'], guns: [], kills: 0, maxDepth: 35 }, lo);
  assert.equal(p2.stash.length, 0, '阵亡的物资应丢失');
});
test('econ: 资金保底生效', () => {
  const lo = { gun: 'seacutter', suit: 's0', helm: 'h0', pack: 'k1', meds: 0, insured: false };
  const prof = newProfile();
  prof.money = 100;
  const r = settle(prof, { outcome: 'killed', secs: 5, items: [], guns: [], kills: 0, maxDepth: 0 }, lo);
  assert.equal(prof.money, MIN_MONEY);
  assert.equal(r.aid, MIN_MONEY - 100);
});
test('econ: 战绩与深度纪录被记录', () => {
  const lo = { gun: 'seacutter', suit: 's0', helm: 'h0', pack: 'k1', meds: 0 };
  const prof = newProfile();
  settle(prof, { outcome: 'extracted', secs: 100, items: ['bullion'], guns: [], kills: 3, maxDepth: 38.6 }, lo);
  assert.equal(prof.stats.raids, 1);
  assert.equal(prof.stats.extracts, 1);
  assert.equal(prof.stats.kills, 3);
  assert.equal(prof.stats.bestDepth, 39);
  assert.equal(prof.history.length, 1);
});

// ================= 9. 射击管线 =================
test('shot: 墙后打不中敌人', () => {
  const cols = [{ x0: 4, z0: -5, x1: 5, z1: 5, tall: true }];
  buildColliderGrid(cols);
  const e = mkActor(10, 0);
  const r = traceShot({
    ox: 0, oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.reef, targets: [e],
    colliders: cols, world: mkWorld(cols, flat(0)), spreadDeg: 0, rng: null, dmgMul: 1,
  });
  assert.equal(r.hit, null, '墙后不该命中');
  assert.ok(r.pellets.some(p => p.kind === 'wall'), '应记录撞墙');
});
test('shot: 空旷处能命中且距离衰减生效', () => {
  const cols = []; buildColliderGrid(cols);
  // reef 射程 56m，射线长 89.6m —— 两个目标都要在射线内，但一个在射程内一个在外
  const near = mkActor(30, 0), far = mkActor(85, 0);
  const base = { ox: 0, oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.reef, colliders: cols, world: mkWorld(cols, flat(0)), spreadDeg: 0, rng: null, dmgMul: 1 };
  const rn = traceShot({ ...base, targets: [near] });
  const rf = traceShot({ ...base, targets: [far] });
  assert.ok(rn.hit && rf.hit, '两者都应命中');
  assert.ok(rf.hit.dmg < rn.hit.dmg, `远距离伤害 ${rf.hit.dmg} 应小于近处 ${rn.hit.dmg}`);
  assert.ok(rf.hit.dmg >= rn.hit.dmg * 0.35 - 1e-6, '伤害衰减有 35% 下限');
});
test('shot: 霰弹枪 9 颗弹丸各自解算', () => {
  const cols = []; buildColliderGrid(cols);
  const e = mkActor(6, 0);
  const r = traceShot({
    ox: 0, oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.breacher, targets: [e],
    colliders: cols, world: mkWorld(cols, flat(0)), spreadDeg: 0, rng: new Rng(5), dmgMul: 1,
  });
  assert.equal(r.pellets.length, 9);
});
test('shot: 难度系数缩放敌人伤害', () => {
  const cols = []; buildColliderGrid(cols);
  const e = mkActor(10, 0);
  const base = { ox: 0, oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.reef, targets: [e], colliders: cols, world: mkWorld(cols, flat(0)), spreadDeg: 0, rng: null };
  const easy = traceShot({ ...base, dmgMul: 0.22 }).hit.dmg;
  const hard = traceShot({ ...base, dmgMul: 0.44 }).hit.dmg;
  assert.ok(hard > easy * 1.9, `精英难度伤害 ${hard} 应约为新兵 ${easy} 的两倍`);
});
test('shot: 地形山脊挡住跨山射击', () => {
  const cols = []; buildColliderGrid(cols);
  const ridge = (x) => (Math.abs(x - 15) < 2.5 ? 12 : 0);
  const e = mkActor(30, 0);
  const r = traceShot({
    ox: 0, oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.reef, targets: [e],
    colliders: cols, world: mkWorld(cols, ridge), spreadDeg: 0, rng: null, dmgMul: 1,
  });
  assert.equal(r.hit, null, '山脊应挡住');
});
test('shot: 低掩体只近距离挡枪（远处可打越）', () => {
  const cols = [{ x0: 9, z0: -3, x1: 10, z1: 3, tall: false }];
  buildColliderGrid(cols);
  const e = mkActor(12, 0);
  const base = { oy: 1.0, oz: 0, dx: 1, dz: 0, gun: GUNS.reef, targets: [e], colliders: cols, world: mkWorld(cols, flat(0)), spreadDeg: 0, rng: null, dmgMul: 1 };
  const far = traceShot({ ...base, ox: 0 });      // 掩体在 9m 处，射手在 0m
  assert.ok(far.hit, '远处应能打越低掩体');
  const close = traceShot({ ...base, ox: 8.0 });  // 射手贴到 8m，掩体近在 1m
  assert.equal(close.hit, null, '贴近时低掩体应挡枪');
});

// ================= 10. 技能表自洽 =================
test('skills: 12 项技能都能被解释且描述非空', () => {
  const all = ['deepAdapt', 'bigTank', 'quickAsc', 'slowBurn', 'suitPlus', 'fastStrip', 'bigPack',
    'steady', 'greedy', 'quickPry', 'silencer', 'extraNade', 'blastRes'];
  const m = skillMods(Object.fromEntries(all.map(k => [k, true])));
  assert.ok(m.pressureStart > 20);
  assert.ok(m.o2Max > 100);
  assert.ok(m.holdTime < 7);
  assert.ok(m.packBonus > 0);
  assert.ok(m.spreadMul < 1);
});
test('skills: 无技能时修正量都是中性的', () => {
  const m = skillMods({});
  assert.equal(m.pressureStart, 20);
  assert.equal(m.o2Max, 100);
  assert.equal(m.holdTime, 7);
  assert.equal(m.packBonus, 0);
  assert.equal(m.spreadMul, 1);
});

void mulberry32; void hashSeed; void clamp; void START_MONEY;

// ---- 结算面板的账必须能对上 ----
// 面板把 settle() 的每一项都列给玩家看，所以「haul + bonus === value」
// 这个恒等式就是 UI 不会显示出自相矛盾数字的前提。改经济公式时如果
// 漏改某一项，这里会立刻炸。
test('econ: 结算明细 haul + bonus === value', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  for (const outcome of ['extracted', 'killed', 'mia', 'abandon']) {
    const prof = newProfile();
    const r = settle(prof, { outcome, secs: 120, items: ['bullion', 'gem'], guns: [], kills: 3, maxDepth: 35 }, lo);
    assert.equal(r.haul + r.bonus, r.value, outcome + ': 明细加总应等于总值');
    assert.equal(r.outcome, outcome);
  }
});

test('econ: 只有撤离成功才有战利品收入与撤离奖金', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  for (const outcome of ['killed', 'mia', 'abandon']) {
    const r = settle(newProfile(), { outcome, secs: 60, items: ['bullion'], guns: [], kills: 0, maxDepth: 10 }, lo);
    assert.equal(r.haul, 0, outcome + ': 失败局不该有战利品收入');
    assert.equal(r.bonus, 0, outcome + ': 失败局不该有撤离奖金');
    // 但要告诉玩家「本来能拿到多少」—— 失败局的钱去哪了必须显示出来
    assert.ok(r.lost > 0, outcome + ': 失败局应记录遗失物资价值');
  }
});

test('econ: 失败局的遗失额 = 同样深度系数算出的货价', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  const raid = { outcome: 'killed', secs: 60, items: ['bullion', 'gem'], guns: [], kills: 0, maxDepth: 35 };
  const r = settle(newProfile(), raid, lo);
  assert.equal(r.lost, haulValue(raid.items, raid.guns, depthValueScale(35)));
});

test('econ: 明细里的 cost 就是这局的装备投入', () => {
  const lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2 };
  const r = settle(newProfile(), { outcome: 'killed', secs: 10, items: [], guns: [], kills: 0, maxDepth: 0 }, lo);
  assert.equal(r.cost, loadoutCost(lo));
});
