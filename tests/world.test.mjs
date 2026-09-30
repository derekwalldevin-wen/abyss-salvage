// 地图构建与构建期断言的测试。
//
// 这里最关键的一条：`validateMap` 必须**真的会在地图坏掉时抛错**。
// 一个永远不会失败的断言等于没有断言，所以第 3 组测试故意造了一张坏地图，
// 逐条验证每类问题都能被抓出来 —— 否则前面 80 个种子的"全绿"毫无意义。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorld } from '../src/world/build.js';
import { validateMap, MapValidationError, freeCellsIn, insideAnyCollider } from '../src/world/validate.js';
import { BANDS, RAMPS, ZONES, EXTRACTS, SPAWNS, heightAt, depthAt, bandAt, zoneAt, HALF } from '../src/world/layout.js';
import { EXTRACT_RADIUS, CONTAINERS } from '../src/core/catalog.js';
import { rasterizeNav, buildColliderGrid, Nav } from '../src/core/nav.js';

/** 往地图里塞了新的碰撞体之后，重建导航网格让断言看到它们 */
function rebuildNav(w) {
  buildColliderGrid(w.colliders);
  w.grid = rasterizeNav(w.colliders, w.half, 0.45);
  w.nav = new Nav(w.grid, w.half * 2, w.half);
}

const SEEDS = [20260928, 20260929, 20260937, 20260945, 20260960, 20260980, 20260995, 20261005];

// ================= 1. 布局自洽（不需要构建，最便宜） =================
test('layout: 四条带 z 区间不重叠且严格递减变深', () => {
  for (let i = 1; i < BANDS.length; i++) {
    assert.ok(BANDS[i].z0 >= BANDS[i - 1].z1,
      `条带 ${BANDS[i - 1].id} 与 ${BANDS[i].id} 的 z 区间重叠 —— heightAt 单值函数会无解`);
    assert.ok(BANDS[i].floorY < BANDS[i - 1].floorY, `条带 ${BANDS[i].id} 没有比上一层更深`);
  }
  assert.ok(-BANDS[BANDS.length - 1].floorY >= 30, '最深必须 ≥30m，否则深度系统失去意义');
});

test('layout: 每个区域完全落在自己条带的 z 区间内', () => {
  for (const z of ZONES) {
    const b = BANDS.find(x => x.id === z.band);
    assert.ok(b, `区域 ${z.id} 引用了不存在的条带 ${z.band}`);
    assert.ok(z.rect[1] >= b.z0 && z.rect[3] <= b.z1,
      `区域 ${z.id}(${z.name}) 的 z 区间 [${z.rect[1]}, ${z.rect[3]}] 越出了条带 ${b.id}[${b.z0}, ${b.z1}]`);
  }
});

test('layout: 每条坡道正好跨越相邻条带的边界', () => {
  for (const r of RAMPS) {
    const from = BANDS.find(b => b.id === r.from);
    const to = BANDS.find(b => b.id === r.to);
    assert.ok(from && to, `坡道 ${r.name} 的条带不存在`);
    assert.equal(r.y0, from.floorY, `坡道 ${r.name} 起点高度不符`);
    assert.equal(r.y1, to.floorY, `坡道 ${r.name} 终点高度不符`);
    assert.ok(r.z0 >= from.z0 && r.z1 <= to.z1, `坡道 ${r.name} 没有正确跨越边界`);
    assert.ok(r.x1 - r.x0 >= 8, `坡道 ${r.name} 太窄，走起来像在墙上挤`);
  }
});

test('layout: heightAt 在坡道上是连续插值，两端接上条带', () => {
  for (const r of RAMPS) {
    const cx = (r.x0 + r.x1) / 2;
    assert.ok(Math.abs(heightAt(cx, r.z0) - r.y0) < 0.01, `坡道 ${r.name} 起点不连续`);
    assert.ok(Math.abs(heightAt(cx, r.z1) - r.y1) < 0.01, `坡道 ${r.name} 终点不连续`);
    // 坡道之外同一 z 处应属于某条带
    const outside = r.x1 + 12;
    assert.ok(bandAt(r.z0) !== null, `坡道 ${r.name} 的 z 区间不在任何条带内`);
    void outside;
  }
});

test('layout: depthAt 与 heightAt 互为反数', () => {
  for (let x = -120; x <= 120; x += 17) {
    for (let z = -120; z <= 120; z += 23) {
      assert.ok(Math.abs(depthAt(x, z) + heightAt(x, z)) < 1e-9, `(${x},${z}) 处两者不一致`);
      assert.ok(depthAt(x, z) >= 0, `(${x},${z}) 深度为负`);
    }
  }
});

test('layout: 六个减压舱都落在合法条带内且深度与地形一致', () => {
  assert.equal(EXTRACTS.length, 6, '应为 6 选 3 的候选池');
  for (const e of EXTRACTS) {
    const b = BANDS.find(x => x.id === e.band);
    assert.ok(b, `${e.name} 引用了不存在的条带`);
    assert.ok(e.z >= b.z0 && e.z <= b.z1, `${e.name} 的 z 越出了条带 ${b.id}`);
    assert.ok(Math.abs(depthAt(e.x, e.z) - e.depth) <= 1.5,
      `${e.name} 标注深度 ${e.depth}m，实际 ${depthAt(e.x, e.z).toFixed(1)}m`);
  }
});

test('layout: 出生点 50m 内不放敌人刷新点（结构性保证，不是靠断言）', () => {
  const world = buildWorld({ seed: 1 });
  for (const s of world.spawns) {
    for (const e of world.enemySpots) {
      assert.ok(Math.hypot(e.x - s.x, e.z - s.z) >= 49,
        `出生点 (${s.x},${s.z}) 离敌人刷新点 (${e.x},${e.z}) 只有 ${Math.hypot(e.x - s.x, e.z - s.z).toFixed(1)}m`);
    }
  }
});

// ================= 2. 构建产物完整性 =================
test('build: 产出完整且内部自洽', () => {
  const w = buildWorld({ seed: 20260928 });
  assert.equal(w.half, HALF);
  assert.ok(w.colliders.length > 150, `碰撞体太少: ${w.colliders.length}`);
  assert.ok(w.nav && w.nav.N === HALF * 2);
  assert.equal(w.grid.length, HALF * 2 * HALF * 2);
  assert.equal(w.extracts.length, 6);
  assert.ok(w.enemySpots.length > 25, `敌人刷新点太少: ${w.enemySpots.length}`);
  assert.ok(w.containerSpots.length > 30, `容器点太少: ${w.containerSpots.length}`);
  assert.ok(w.draw.length > 200, `绘制指令太少: ${w.draw.length}`);
  assert.ok(w.doorways.length > 10, '应有多个门洞供断言检查');
});

test('build: 每个碰撞体都有合法的 AABB', () => {
  const w = buildWorld({ seed: 20260933 });
  for (const c of w.colliders) {
    assert.ok(c.x1 > c.x0, `AABB x 反了: [${c.x0}, ${c.x1}]`);
    assert.ok(c.z1 > c.z0, `AABB z 反了: [${c.z0}, ${c.z1}]`);
    assert.ok(Number.isFinite(c.x0) && Number.isFinite(c.z1), 'AABB 含 NaN');
  }
});

test('build: 同种子完全可复现', () => {
  const a = buildWorld({ seed: 777 });
  const b = buildWorld({ seed: 777 });
  assert.equal(a.colliders.length, b.colliders.length);
  assert.deepEqual(a.containerSpots.map(c => [c.type, c.x, c.z]), b.containerSpots.map(c => [c.type, c.x, c.z]));
  const c = buildWorld({ seed: 778 });
  assert.notDeepEqual(a.containerSpots.map(x => x.x), c.containerSpots.map(x => x.x), '不同种子应产生不同布局');
});

test('build: 8 个种子全部通过校验', () => {
  for (const s of SEEDS) {
    const w = buildWorld({ seed: s });
    const r = validateMap(w);
    assert.equal(r.ok, true, `seed ${s} 应通过`);
    assert.ok(r.stats.bandDepths.length === 4);
  }
});

test('build: 深层容器数量足够（高价值层不能是空的）', () => {
  const w = buildWorld({ seed: 20260928 });
  const deep = w.containerSpots.filter(c => c.type === 'vault' || c.type === 'hold');
  assert.ok(deep.length >= 6, `保险库/封死货舱只有 ${deep.length} 个`);
  for (const c of deep) {
    assert.ok(depthAt(c.x, c.z) >= (CONTAINERS[c.type].minDepth ?? 0) - 0.5,
      `${c.type} 被放在 ${depthAt(c.x, c.z).toFixed(1)}m`);
  }
});

// ================= 3. 断言本身必须有效（最关键的一组） =================
// 一个永远不会失败的断言等于没有断言。所以这里故意把地图弄坏，
// 逐类验证 validateMap 真的会抛错。

function expectFail(world, id, label) {
  let err = null;
  try { validateMap(world); } catch (e) { err = e; }
  assert.ok(err instanceof MapValidationError, `${label}: 期望抛 MapValidationError，实际没抛`);
  const ids = err.problems.map(p => p.id);
  assert.ok(ids.includes(id), `${label}: 期望问题类型 ${id}，实际得到 [${[...new Set(ids)].join(',')}]`);
}

test('断言有效性: 撤离点落在不可走格 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  // 把一个减压舱塞进边界墙里
  w.extracts[0].x = -HALF + 0.2;
  w.extracts[0].z = -HALF + 0.2;
  expectFail(w, 'extract-center', '撤离点在墙里');
});

test('断言有效性: 撤离点被碰撞体包住 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  // 在减压舱中心塞一个碰撞体
  const e = w.extracts[1];
  w.colliders.push({ x0: e.x - 1, z0: e.z - 1, x1: e.x + 1, z1: e.z + 1, tall: true });
  expectFail(w, 'extract-inside', '撤离点被埋');
});

test('断言有效性: 撤离点被墙隔断 → A* 不可达被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  const e = w.extracts[2];
  // 竖一道高墙把它单独围起来（留 3m 宽的缝，让 freeCells 断言不先触发）
  w.colliders.push({ x0: e.x - 30, z0: e.z - 14, x1: e.x - 27, z1: e.z + 14, tall: true });
  w.colliders.push({ x0: e.x + 27, z0: e.z - 14, x1: e.x + 30, z1: e.z + 14, tall: true });
  w.colliders.push({ x0: e.x - 30, z0: e.z - 14, x1: e.x + 30, z1: e.z - 11, tall: true });
  w.colliders.push({ x0: e.x - 30, z0: e.z + 11, x1: e.x + 30, z1: e.z + 14, tall: true });
  w.colliders.push({ x0: e.x - 30, z0: e.z - 11, x1: e.x - 27, z1: e.z + 11, tall: true });
  rebuildNav(w);   // 让新墙进入导航网格
  expectFail(w, 'extract-unreachable', '撤离点被围死');
});

test('断言有效性: 出生点压在墙上 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  w.colliders.push({ x0: w.spawns[0].x - 2, z0: w.spawns[0].z - 2, x1: w.spawns[0].x + 2, z1: w.spawns[0].z + 2, tall: true });
  expectFail(w, 'spawn-inside', '出生点在实体里');
});

test('断言有效性: 门洞实际只剩 1 格 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  // 断言量的是"声明跨度内**实际**有多少连续可走格"。所以要触发它，
  // 必须在几何上把一个 5m 的声明门洞真的堵到只剩 1.2m 通畅 ——
  // 只改声明值没用（真正的开口还在，断言理应放行）。
  const d = w.doorways.find(x => x.along === 'x') || w.doorways[0];
  const along = d.along;
  const GAP = 1.2, half = d.w / 2;
  // 塞两块"塞子"：覆盖声明跨度里除中心 1.2m 以外的部分，且在垂直方向伸出 2m
  if (along === 'x') {
    w.colliders.push({ x0: d.cx - half, z0: d.cz - 2, x1: d.cx - GAP / 2, z1: d.cz + 2, tall: true });
    w.colliders.push({ x0: d.cx + GAP / 2, z0: d.cz - 2, x1: d.cx + half, z1: d.cz + 2, tall: true });
  } else {
    w.colliders.push({ x0: d.cx - 2, z0: d.cz - half, x1: d.cx + 2, z1: d.cz - GAP / 2, tall: true });
    w.colliders.push({ x0: d.cx - 2, z0: d.cz + GAP / 2, x1: d.cx + 2, z1: d.cz + half, tall: true });
  }
  rebuildNav(w);
  expectFail(w, 'door-width', '门洞实际只剩 1 格');
});

test('断言有效性: 门洞够宽时不该误报', () => {
  // 反向验证：断言不能变成"什么都报错"。把某处标成 5m 的门（实际通畅）应通过。
  const w = buildWorld({ seed: 20260928 });
  const d = w.doorways[0];
  d.w = 5.0;
  const r = validateMap(w);
  assert.equal(r.ok, true);
});

test('断言有效性: 保险库被放在浅水区 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  const shallow = w.containerSpots.find(c => depthAt(c.x, c.z) < 20);
  assert.ok(shallow, '测试前提：应存在浅水区容器点');
  shallow.type = 'vault';
  expectFail(w, 'container-depth', '保险库放在浅处');
});

test('断言有效性: 条带不再递减变深 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  w.bands[2].floorY = w.bands[1].floorY;      // 人为拉平第三层
  expectFail(w, 'depth-order', '深度梯度错乱');
});

test('断言有效性: 最浅层太浅 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  for (const b of w.bands) b.floorY = -6;
  expectFail(w, 'depth-range', '深度范围不足');
});

test('断言有效性: 敌人刷新点离出生点太近 → 被抓', () => {
  const w = buildWorld({ seed: 20260928 });
  w.enemySpots.push({ x: w.spawns[0].x + 3, z: w.spawns[0].z, role: 'guard', r: 4, band: 'foredeck' });
  expectFail(w, 'spawn-enemy', '敌人贴脸刷在出生点');
});

// ================= 4. 工具函数 =================
test('freeCellsIn: 开阔处远多于墙角', () => {
  const w = buildWorld({ seed: 20260928 });
  const open = freeCellsIn(w, 0, -100, 6);
  assert.ok(open > 20, `开阔处可站格 ${open} 偏少`);
  const corner = freeCellsIn(w, -HALF + 0.5, -HALF + 0.5, 6);
  assert.ok(corner < open, '墙角应明显更少');
});

test('insideAnyCollider: 能识别内外', () => {
  const w = buildWorld({ seed: 20260928 });
  const c = w.colliders[0];
  const mid = { x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2 };
  assert.ok(insideAnyCollider(w, mid.x, mid.z), '中心应判定为在内部');
  // 随便找个远离所有碰撞体的点
  let found = false;
  for (let x = -120; x <= 120 && !found; x += 7) {
    for (let z = -120; z <= 120 && !found; z += 11) {
      if (!insideAnyCollider(w, x, z)) { found = true; assert.ok(w.nav.walkableAt(x, z), `${x},${z} 应为空地`); }
    }
  }
  assert.ok(found, '应能找到空地');
});

test('zoneAt / bandAt: 采样一致', () => {
  const zn = ZONES.find(z => z.id === 'pump');
  const cx = (zn.rect[0] + zn.rect[2]) / 2, cz = (zn.rect[1] + zn.rect[3]) / 2;
  assert.equal(zoneAt(cx, cz).id, 'pump');
  assert.equal(bandAt(cz).id, zn.band);
});
