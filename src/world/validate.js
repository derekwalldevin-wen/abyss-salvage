// 构建期地图断言。**这是本作最重要的工程决定。**
//
// 参考作最严重的缺陷是「大坝泄洪闸」撤离点落在水库里，4m 内 0 个可站立格、
// A* 不可达 —— 而 5 选 3 每局随机，意味着约 60% 的对局开出一个永远拿不到的撤离点。
// 这类 bug 在 3D 项目里肉眼根本看不出来，只能靠自动化发现。
//
// 规则：任一断言不通过 → throw → `npm run build` 失败。没有 warn，没有"下次注意"。

import { EXTRACT_RADIUS, CONTAINERS } from '../core/catalog.js';

export class MapValidationError extends Error {
  constructor(problems) {
    const lines = problems.slice(0, 24).map(p => `  · ${p.msg}`);
    const more = problems.length > 24 ? `\n  … 另有 ${problems.length - 24} 条` : '';
    super(`地图校验未通过（${problems.length} 条）：\n${lines.join('\n')}${more}`);
    this.name = 'MapValidationError';
    this.problems = problems;
  }
}

/** 统计某点周围半径 r 内的可走格数 */
export function freeCellsIn(world, x, z, r, step = 0.5) {
  let n = 0;
  const need = Math.max(1, Math.ceil(r / step));
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    for (let k = 1; k <= need; k++) {
      const rad = (k / need) * r;
      if (world.nav.walkableAt(x + Math.cos(ang) * rad, z + Math.sin(ang) * rad)) n++;
    }
  }
  return n;
}

/** 点是否落在任何碰撞体 AABB 内 */
export function insideAnyCollider(world, x, z, pad = 0) {
  for (const c of world.colliders) {
    if (x >= c.x0 - pad && x <= c.x1 + pad && z >= c.z0 - pad && z <= c.z1 + pad) return c;
  }
  return null;
}

/**
 * 校验一张地图。任何一条不通过就抛 MapValidationError。
 * @param {object} world buildWorld() 的产物
 */
export function validateMap(world, opts = {}) {
  const minFree = opts.minFreeCells ?? 24;
  const spawnClear = opts.spawnClearRadius ?? 45;
  const problems = [];
  const warnings = [];
  const P = (id, msg) => problems.push({ id, msg });

  // ---------- 0. 条带与坡道的几何自洽 ----------
  for (let i = 0; i < world.bands.length; i++) {
    const b = world.bands[i];
    if (b.z1 <= b.z0) P('band', `条带 ${b.id} 的 z 区间非法: [${b.z0}, ${b.z1}]`);
    if (i > 0 && b.z0 < world.bands[i - 1].z1) {
      P('band', `条带 ${world.bands[i - 1].id} 与 ${b.id} 的 z 区间重叠 —— ` +
        `heightAt(x,z) 是单值函数，重叠会让该处地面高度无解`);
    }
  }
  for (const r of world.ramps) {
    const bFrom = world.bands.find(b => b.id === r.from);
    const bTo = world.bands.find(b => b.id === r.to);
    if (!bFrom || !bTo) { P('ramp', `坡道 ${r.name} 的 from/to 找不到对应条带`); continue; }
    if (Math.abs(r.y0 - bFrom.floorY) > 0.01) P('ramp', `坡道 ${r.name} 起点高度 ${r.y0} 与条带 ${r.from}(${bFrom.floorY}) 不符`);
    if (Math.abs(r.y1 - bTo.floorY) > 0.01) P('ramp', `坡道 ${r.name} 终点高度 ${r.y1} 与条带 ${r.to}(${bTo.floorY}) 不符`);
    if (r.z0 < bFrom.z0 - 0.01 || r.z1 > bTo.z1 + 0.01) {
      P('ramp', `坡道 ${r.name} 的 z 区间 [${r.z0}, ${r.z1}] 没有正确跨越 ${r.from}→${r.to} 的边界`);
    }
    if (r.x1 - r.x0 < 4) P('ramp', `坡道 ${r.name} 太窄（${r.x1 - r.x0}m），走起来会像在墙上挤`);
  }

  // ---------- 1. 减压舱：站得住、没被埋、深度标注正确 ----------
  for (const e of world.extracts) {
    if (!world.nav.walkableAt(e.x, e.z)) {
      P('extract-center', `减压舱「${e.name}」中心 (${e.x.toFixed(0)}, ${e.z.toFixed(0)}) 落在不可走格上 —— 玩家站不进去`);
    }
    const free = freeCellsIn(world, e.x, e.z, EXTRACT_RADIUS);
    if (free < minFree) {
      P('extract-free', `减压舱「${e.name}」${EXTRACT_RADIUS}m 内只有 ${free} 个可站格（要求 ≥${minFree}）—— ` +
        `读条要站住 7 秒，周围必须真的有地方站`);
    }
    const inside = insideAnyCollider(world, e.x, e.z);
    if (inside) {
      P('extract-inside', `减压舱「${e.name}」埋在碰撞体里（${inside.prop || inside.cliff ? '地形/道具' : '结构'}）—— 光柱会从实体内部透出来`);
    }
    if (e.declaredDepth != null && Math.abs(e.declaredDepth - e.depth) > 1.5) {
      P('extract-depth', `减压舱「${e.name}」标注深度 ${e.declaredDepth}m，实际地形深度 ${e.depth.toFixed(1)}m`);
    }
    // 地面够平（读条时不能站在斜坡上）
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 8; a++) {
      for (const rad of [1, 2, 3]) {
        const y = world.heightAt(e.x + Math.cos((a / 8) * Math.PI * 2) * rad, e.z + Math.sin((a / 8) * Math.PI * 2) * rad);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    }
    if (hi - lo > 0.6) P('extract-flat', `减压舱「${e.name}」周围地面高差 ${(hi - lo).toFixed(2)}m（要求 ≤0.6m）`);
  }

  // ---------- 1.5 门洞必须真的够宽 ----------
  // 这条是踩过坑才加的：导航网格把碰撞体按智能体半径(0.45m)膨胀后再取 floor，
  // 于是 3.4m 的门只剩 1 个可走格。孤立单格在对角移动规则下等于封死，
  // 表现为「某个舱室里的容器突然全部不可达」，排查起来极其绕。
  if (world.doorways) {
    for (const d of world.doorways) {
      // 沿门洞的**通行方向**数连续可走格。along 由 build 显式给出，不能靠矩形形状猜。
      // 采样要落在墙面的两侧（agent 中心离墙面至少 0.45+0.17≈0.6m），
      // 压在墙中心线上采样是错的 —— 墙自己的膨胀碰撞体必然把那条线判成不可走。
      const xAxis = d.along === 'x';
      const half = d.w / 2;
      const OFF = 1.1;                       // 两侧各让开 1.1m
      const runAt = (off) => {
        let run = 0, best = 0;
        for (let t = -half; t <= half; t += 0.25) {
          const px = xAxis ? d.cx + t : d.cx + off;
          const pz = xAxis ? d.cz + off : d.cz + t;
          if (world.nav.walkableAt(px, pz)) { run++; best = Math.max(best, run); } else run = 0;
        }
        return best;
      };
      const inA = runAt(-OFF), inB = runAt(OFF);
      const worst = Math.min(inA, inB);
      if (worst < 3) {
        P('door-width', `门洞「${d.cx.toFixed(0)},${d.cz.toFixed(0)}」(宽 ${d.w}m) 两侧通道分别只有 ` +
          `${inA} / ${inB} 个连续可走格（要求都 ≥3）—— 实际是堵死的`);
      }
    }
  }

  // ---------- 2. 每个出生点 → 每个减压舱都必须 A* 可达 ----------
  for (const s of world.spawns) {
    if (!world.nav.walkableAt(s.x, s.z)) P('spawn-walk', `出生点 (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) 落在不可走格上`);
    const inside = insideAnyCollider(world, s.x, s.z);
    if (inside) P('spawn-inside', `出生点 (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) 压在碰撞体里`);

    for (const e of world.extracts) {
      let reached = false, tried = 0;
      for (let a = 0; a < 12 && !reached; a++) {
        for (const rad of [1.5, 2.5, 3.5]) {
          const tx = e.x + Math.cos((a / 12) * Math.PI * 2) * rad;
          const tz = e.z + Math.sin((a / 12) * Math.PI * 2) * rad;
          if (!world.nav.walkableAt(tx, tz)) continue;
          tried++;
          if (world.nav.find(s.x, s.z, tx, tz, 80000)) { reached = true; break; }
        }
      }
      if (!reached) {
        P('extract-unreachable', `出生点 (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) 无法寻路到减压舱「${e.name}」` +
          (tried ? '' : '（其周边一个可站格都没有）'));
      }
    }
  }

  // ---------- 3. 连通分量：所有减压舱与所有容器必须与出生点同分量 ----------
  const seen = world.nav.connectedFrom(world.spawns[0].x, world.spawns[0].z);
  const inComponent = (x, z) => {
    const [ix, iz] = world.nav.cell(x, z);
    if (!world.nav.free(ix, iz)) return false;
    return !!seen[world.nav.idx(ix, iz)];
  };
  for (const e of world.extracts) {
    if (!inComponent(e.x, e.z)) P('component-extract', `减压舱「${e.name}」与出生点不连通 —— 玩家过不去`);
  }
  let orphan = 0;
  const orphanSamples = [];
  for (const c of world.containerSpots) {
    if (!inComponent(c.x, c.z)) {
      orphan++;
      if (orphanSamples.length < 4) orphanSamples.push(`${c.type}@(${c.x.toFixed(0)},${c.z.toFixed(0)})`);
    }
  }
  if (orphan) {
    P('component-container', `${orphan}/${world.containerSpots.length} 个容器点与出生点不连通` +
      (orphanSamples.length ? `，例如 ${orphanSamples.join('、')}` : ''));
  }

  // ---------- 4. 深度梯度 ----------
  const bandDepths = world.bands.map(b => -b.floorY);
  for (let i = 1; i < bandDepths.length; i++) {
    if (bandDepths[i] <= bandDepths[i - 1]) {
      P('depth-order', `条带 ${world.bands[i].id} 深度 ${bandDepths[i]}m 没有比上一层 ${bandDepths[i - 1]}m 更深`);
    }
  }
  if (Math.max(...bandDepths) < 30) {
    P('depth-range', `最深只有 ${Math.max(...bandDepths)}m，深水区的价值与压力设计失去意义（需要 ≥30m）`);
  }

  // ---------- 5. 容器深度门槛与内容量 ----------
  for (const c of world.containerSpots) {
    const t = CONTAINERS[c.type];
    if (!t) { P('container-type', `未知容器类型 ${c.type}`); continue; }
    if (t.minDepth != null) {
      const d = world.depthAt(c.x, c.z);
      if (d < t.minDepth - 0.5) P('container-depth', `容器 ${c.type}(需 ≥${t.minDepth}m) 被放在 ${d.toFixed(1)}m 处`);
    }
  }
  const deepCount = world.containerSpots.filter(c => c.type === 'vault' || c.type === 'hold').length;
  if (deepCount < 6) warnings.push(`保险库/封死货舱只有 ${deepCount} 个，深层可能显得空`);

  // 每条带都要有容器，否则某层会空得没有内容
  for (const b of world.bands) {
    const n = world.containerSpots.filter(c => c.band === b.id).length;
    if (n < 3) warnings.push(`条带 ${b.name}(${b.id}) 只有 ${n} 个容器点，可能太空`);
  }

  // ---------- 6. 出生点与敌人刷新点间距 ----------
  for (const s of world.spawns) {
    let best = Infinity;
    for (const e of world.enemySpots) best = Math.min(best, Math.hypot(e.x - s.x, e.z - s.z));
    if (best < spawnClear) {
      P('spawn-enemy', `出生点 (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) 离最近敌人刷新点只有 ${best.toFixed(1)}m（要求 ≥${spawnClear}）`);
    }
  }

  // ---------- 7. 敌人刷新点必须在可达面上 ----------
  const badSpots = world.enemySpots.filter(e => !world.nav.walkableAt(e.x, e.z));
  if (badSpots.length) {
    P('enemy-spot', `${badSpots.length}/${world.enemySpots.length} 个敌人刷新点落在不可走格上` +
      (badSpots.length <= 3 ? `，例如 (${badSpots[0].x.toFixed(0)},${badSpots[0].z.toFixed(0)})` : ''));
  }

  const stats = {
    colliders: world.colliders.length,
    tall: world.colliders.filter(c => c.tall).length,
    navCells: world.grid.length,
    navBlocked: world.grid.reduce((s, v) => s + v, 0),
    draws: world.draw.length,
    extracts: world.extracts.length,
    enemies: world.enemySpots.length,
    containers: world.containerSpots.length,
    loot: world.lootSpots.length,
    spawns: world.spawns.length,
    ramps: world.ramps.length,
    bandDepths,
    spawnFreeCells: freeCellsIn(world, world.spawns[0].x, world.spawns[0].z, 20),
  };

  if (problems.length) throw new MapValidationError(problems);
  return { ok: true, stats, warnings };
}
