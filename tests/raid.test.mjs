// 一局完整流程的无头集成测试：造一张最小地图，跑完整局。
// 零 three、零 DOM —— 这也是 tools/sim.mjs 的基础。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Nav, rasterizeNav, buildColliderGrid } from '../src/core/nav.js';
import { Raid } from '../src/core/raid.js';
import { newProfile, bagUsed, GUNS, ITEMS } from '../src/core/index.js';
import { o2Drain } from '../src/core/catalog.js';
import { BANDS } from '../src/world/layout.js';

const HALF = 60;

// 造一张 4 层的小地图：每层一块平板，用斜坡连接，测深度系统与撤离
function makeWorld() {
  const colliders = [];
  const yOf = (x, z) => {
    // 阶梯式：按 z 分 4 段，越往南越深
    const seg = Math.floor((z + HALF) / (HALF * 2 / 4));
    return -(seg + 1) * ((BANDS[0].floorY - BANDS[3].floorY) / 3) - 4;
  };
  const heightAt = (x, z) => yOf(x, z);

  // 边界墙
  for (const [x0, z0, x1, z1] of [
    [-HALF, -HALF, HALF, -HALF + 1], [-HALF, HALF - 1, HALF, HALF],
    [-HALF, -HALF, -HALF + 1, HALF], [HALF - 1, -HALF, HALF, HALF],
  ]) colliders.push({ x0, z0, x1, z1, tall: true, h: 6, y0: -50, y1: 0 });

  // 每层一道矮掩体墙（tall:false，供掩体 AI 用）
  for (const seg of [0, 1, 2]) {
    const z = -HALF + (seg + 0.5) * (HALF * 2 / 4);
    colliders.push({ x0: -6, z0: z - 0.4, x1: 6, z1: z + 0.4, tall: false, h: 0.9, y0: yOf(0, z), y1: yOf(0, z) + 0.9 });
  }

  // 测试图只有 120m 见方，而真实布局的锚点在 ±130m 的地图上 ——
  // 这里在每条带的中段放一个减压舱，必须落在空地上（不能撞墙）
  const step = (HALF * 2) / 4;
  const extracts = BANDS.map((f, i) => {
    const z = -HALF + step * (i + 0.5);
    // x 选在远离中轴掩体墙的位置
    const x = 34;
    return { name: f.name + '气闸', x, z, depth: f.floorY };
  });
  const spawns = [{ x: 0, z: HALF - 8 }];
  const enemySpots = [];
  for (let i = 0; i < 26; i++) {
    const a = i / 26 * Math.PI * 2;
    enemySpots.push({
      x: Math.cos(a) * (18 + (i % 5) * 6), z: Math.sin(a) * (18 + (i % 5) * 6),
      role: ['guard', 'runner', 'gunner', 'foreman', 'breacher'][i % 5], r: 4, zone: '',
    });
  }
  // 必定刷新的：每层一个监工卫队 + 舱底 Boss（与真实 layout.js 一致）
  enemySpots.push({ x: 0, z: -HALF + 12, role: 'anchor', r: 2, zone: '' });
  for (const z of [-HALF + 14, -14, HALF - 14]) {
    enemySpots.push({ x: 30, z, role: 'foreman', r: 4, zone: '' });
  }
  const containerSpots = [];
  for (let i = 0; i < 30; i++) {
    const a = i / 30 * Math.PI * 2;
    const type = i % 6 === 0 ? 'vault' : i % 3 === 0 ? 'crate' : i % 2 === 0 ? 'netbag' : 'toolbox';
    containerSpots.push({ type, x: Math.cos(a) * 24, z: Math.sin(a) * 24 });
  }

  const world = {
    half: HALF, colliders, heightAt, extracts, spawns, enemySpots, containerSpots, lootSpots: [],
  };
  buildColliderGrid(colliders);
  world.nav = new Nav(rasterizeNav(colliders, HALF, 0.45), HALF * 2, HALF);
  return world;
}

const LO = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2, difficulty: 'diver', insured: true };

function step(raid, seconds, input) {
  const dt = 1 / 30;
  for (let i = 0; i < seconds * 30; i++) {
    if (raid.over) return;
    raid.update(dt, input || {
      keys: {}, pressed: {}, mouse: false, clicked: false, ads: false, aim: null,
    });
  }
}

test('raid: 能构造出一局完整状态', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 1, profile: newProfile() });
  assert.equal(raid.over, false);
  assert.equal(raid.extracts.length, 3, '应是 6 选 3');
  // 测试图只有 27 个刷新点、且出生点 45m 内不刷怪，所以数量本就远少于真实地图
  assert.ok(raid.enemies.length >= 8, `敌人太少: ${raid.enemies.length}`);
  assert.ok(raid.enemies.some(e => e.always), '必定刷新的监工卫队应存在');
  assert.ok(raid.containers.length > 5, `容器太少: ${raid.containers.length}`);
  assert.equal(raid.player.cap, 14);
  assert.equal(raid.player.bag.length, 0);
  assert.ok(raid.player.o2 > 0);
});

test('raid: 同种子完全可复现', () => {
  const a = new Raid({ world: makeWorld(), loadout: LO, seed: 42, profile: newProfile() });
  const b = new Raid({ world: makeWorld(), loadout: LO, seed: 42, profile: newProfile() });
  assert.deepEqual(a.extracts, b.extracts, '活跃减压舱应一致');
  assert.equal(a.enemies.length, b.enemies.length);
  const ka = a.containers.map(c => c.items.map(i => i.key || i.type).join(',')).sort();
  const kb = b.containers.map(c => c.items.map(i => i.key || i.type).join(',')).sort();
  assert.deepEqual(ka, kb, '战利品内容应一致');
});

test('raid: 深度被正确追踪，且越深耗氧越快', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 3, profile: newProfile() });
  // 测试地图的阶梯是 z 越大越深：最深一段在 z = +HALF-12
  raid.player.z = HALF - 12;
  raid.player.y = raid.world.heightAt(0, HALF - 12);
  step(raid, 0.2);
  const deep = raid.stats();
  assert.ok(deep.depth > 20, `最深处应 >20m，实际 ${deep.depth}`);

  // 同一局里站浅层，深度与耗氧速率都应更低
  raid.player.z = -HALF + 12;
  raid.player.y = raid.world.heightAt(0, -HALF + 12);
  const shallow = raid.stats();
  assert.ok(shallow.depth < deep.depth, '浅层深度应更小');
  assert.ok(o2Drain(deep.depth) > o2Drain(shallow.depth), '深处耗氧应更快');
  assert.ok(raid.stats().maxDepth >= deep.depth, 'maxDepth 应记录历史最深');
});

test('raid: 跑到超时按 MIA 结算', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 5, profile: newProfile() });
  raid.time = 0.5;
  step(raid, 2);
  assert.equal(raid.over, true);
  assert.equal(raid.outcome, 'mia');
  const prof = newProfile();
  const r = raid.finalize(prof);
  assert.equal(r.value, 0, 'MIA 不该有带出价值');
  assert.ok(r.refund > 0, 'MIA 应退保险');
});

test('raid: 走进减压舱站满读条即撤离', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 9, profile: newProfile() });
  const e = raid.extracts[0];
  raid.player.x = e.x; raid.player.z = e.z;
  raid.player.y = raid.world.heightAt(e.x, e.z);
  step(raid, 1);
  assert.ok(raid.extractT > 0, '进舱后读条应开始');
  step(raid, raid.mods.holdTime + 1.5);
  assert.equal(raid.over, true);
  assert.equal(raid.outcome, 'extracted');
  assert.ok(raid.extractedVia, '应记录撤离舱名');
});

test('raid: 离开减压舱读条立刻清零', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 11, profile: newProfile() });
  const e = raid.extracts[0];
  raid.player.x = e.x; raid.player.z = e.z;
  raid.player.y = raid.world.heightAt(e.x, e.z);
  step(raid, 1.5);
  assert.ok(raid.extractT > 0.5);
  raid.player.x += 20;                       // 走开
  step(raid, 0.2);
  assert.equal(raid.extractT, 0, '离开应清零');
});

test('raid: 搜刮容器并把物品放进背囊', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 13, profile: newProfile() });
  const c = raid.containers.find(x => !x.loose && x.items.some(i => i.kind === 'item'));
  raid.player.x = c.x; raid.player.z = c.z;
  raid.player.y = raid.world.heightAt(c.x, c.z);
  raid.interact();
  assert.ok(raid.lootOpen, 'E 应打开搜刮面板');
  step(raid, 12, { keys: {}, pressed: { KeyF: true }, mouse: false, clicked: false, ads: false, aim: null });
  step(raid, 1);
  assert.ok(raid.player.bag.length > 0, '全拿后背囊应有东西');
  assert.ok(bagUsed(raid.player.bag) <= raid.player.cap, '不应超过容量');
  for (const k of raid.player.bag) assert.ok(ITEMS[k], `背囊里不该有未知物品 ${k}`);
});

test('raid: 撤离结算把背囊物资写进仓库', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 17, profile: newProfile() });
  raid.player.bag = ['bullion', 'ration'];
  raid.maxDepth = 38;
  raid.end('extracted');
  raid.extractedVia = raid.extracts[0].name;
  const prof = newProfile();
  const before = prof.money;
  const r = raid.finalize(prof);
  assert.ok(r.value > 0);
  assert.deepEqual(prof.stash.sort(), ['bullion', 'ration']);
  assert.ok(prof.money > before, '撤离应进账');
});

test('raid: 阵亡时背囊物资全部丢失', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 19, profile: newProfile() });
  raid.player.bag = ['bullion'];
  raid.end('killed');
  const prof = newProfile();
  raid.finalize(prof);
  assert.equal(prof.stash.length, 0);
  assert.equal(prof.stats.deaths, 1);
});

test('raid: 战斗能造成伤害并击杀', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 23, profile: newProfile() });
  const e = raid.enemies.find(x => !x.boss);
  // 把敌人放到玩家正前方 12m
  raid.player.x = 0; raid.player.z = 0; raid.player.y = 0;
  raid.player.angle = 0;
  e.x = 0; e.z = 12; e.y = 0;
  const hp0 = e.hp;
  let guard = 0;
  while (e.hp > 0 && !e.dead && guard++ < 400) {
    raid.update(1 / 30, {
      keys: {}, pressed: {}, mouse: true, clicked: true, ads: false,
      aim: { x: 0, z: 12 },
    });
    if (raid.over) break;
  }
  assert.ok(e.dead || e.hp < hp0, `敌人应掉血: ${hp0} → ${e.hp}`);
  assert.ok(raid.kills >= 1, `应记击杀，实际 ${raid.kills}`);
});

test('raid: 敌人会攻击玩家并造成伤害', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 29, profile: newProfile() });
  const e = raid.enemies[0];
  // 必须选在压力阈值(20m)之上的浅层，否则掉血来自压力而不是敌人火力，测的就不是交火了。
  // 也要同层（地形视线会挡跨层射击），并且远离所有减压舱锚点。
  const FX = -20, FZ = -HALF + 12;
  raid.player.x = FX; raid.player.z = FZ; raid.player.y = raid.world.heightAt(FX, FZ); raid.player.angle = 0;
  assert.ok(raid.player.y > -20, `交火点必须浅于压力阈值，实际 ${raid.player.y}`);
  e.x = FX; e.z = FZ + 6; e.y = raid.world.heightAt(FX, FZ + 6); e.state = 'combat'; e.alert = 1;
  e.react = 0; e.token = true; e.seeT = 5; e.burstPause = 0; e.fireCd = 0;
  // 敌人朝玩家扫过来（等价于听到枪声后警觉），否则它会背对玩家僵住
  e.angle = Math.atan2(FX - e.x, FZ - e.z);
  e.lastSeen = { x: FX, z: FZ };
  const hp0 = raid.player.hp, suit0 = raid.player.suit.cur;
  // 要跑过难度保护期（diver 15s ≈ 450 帧）敌人才会开始锁定
  let guard = 0, sawPlayer = false;
  const inp = { keys: {}, pressed: {}, mouse: false, clicked: false, ads: false, aim: { x: FX, z: FZ + 6 } };
  while (raid.player.hp === hp0 && raid.player.suit.cur === suit0 && guard++ < 3000) {
    raid.update(1 / 30, inp);
    if (e.sees) sawPlayer = true;
    if (raid.over) break;
  }
  assert.ok(sawPlayer, `敌人应该能发现玩家（跑了 ${(guard / 30).toFixed(0)}s）`);
  assert.ok(raid.player.hp < hp0 || raid.player.suit.cur < suit0,
    `玩家应掉血或护甲磨损: hp ${hp0}→${raid.player.hp}, suit ${suit0}→${raid.player.suit.cur}`);
});

test('raid: 压力在深水区真实生效（长时间不撤离会死）', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 31, profile: newProfile() });
  raid.player.y = -44;                       // 极深
  raid.player.o2 = raid.mods.o2Max;
  const hp0 = raid.player.hp;
  step(raid, 20);
  assert.ok(raid.player.hp < hp0, `深水 20 秒应掉血: ${hp0} → ${raid.player.hp}`);
});

test('raid: 减压舱内补氧', () => {
  const raid = new Raid({ world: makeWorld(), loadout: LO, seed: 37, profile: newProfile() });
  const e = raid.extracts[0];
  raid.player.x = e.x; raid.player.z = e.z; raid.player.y = raid.world.heightAt(e.x, e.z);
  raid.player.o2 = 10;
  step(raid, 2);
  assert.ok(raid.player.o2 > 10, '舱内应回氧');
});

test('raid: 20 局全部能构造成功，且减压舱永不落进不可达点', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const world = makeWorld();
    const raid = new Raid({ world, loadout: LO, seed, profile: newProfile() });
    assert.equal(raid.extracts.length, 3, `seed ${seed}`);
    for (const e of raid.extracts) {
      assert.ok(world.nav.walkableAt(e.x, e.z),
        `seed ${seed} 的减压舱 ${e.name}(${e.x},${e.z}) 落在不可走格上`);
    }
  }
});

void GUNS;
