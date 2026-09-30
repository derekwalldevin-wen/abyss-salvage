// 按 layout.js 生成几何数据、碰撞体与导航网格。**零 three、零 DOM** —— 渲染层只消费这里
// 产出的 draw list，所以地图只有一份真相来源，改布局不会漏改渲染。
//
// 这一层存在的意义：参考作那个「60% 的对局开出一个进不去的撤离点」就是没人写这一层、
// 也没人在构建期检查可达性造成的。这里把「地图长什么样」变成可以无头验证的数据。

import {
  HALF, BANDS, RAMPS, ZONES, EXTRACTS, SPAWNS, ENEMY_SPOTS, BREACHES,
  SEABED_Y, heightAt, depthAt, containerSpotsFor, lootSpotsFor,
} from './layout.js';
import { Rng } from '../core/rng.js';
import { Nav, rasterizeNav, buildColliderGrid, terrainClear } from '../core/nav.js';

const WALL_H = 3.2;
const WALL_T = 0.34;
const RAIL_H = 1.05;

/**
 * @param {object} o
 * @param {number} o.seed 决定道具/容器摆放
 * @returns {object} world
 */
export function buildWorld(o = {}) {
  const seed = o.seed ?? 20260928;
  const rng = new Rng(seed);
  const colliders = [];
  const draw = [];           // 给渲染层的绘制指令（不直接建 three 对象）
  const doorways = [];       // 记录所有门洞，供后面的道具摆放避让
  // 关键点禁放区：出生点与减压舱。道具盖住它们会导致「出生在墙里」/「撤离点站不进去」。
  // 这两个点位比容器重要得多，所以是"禁止摆放"而不是"生成完再挪"。
  const keepOut = SPAWNS.map(s => ({ x: s.x, z: s.z, r: 4.5, why: 'spawn' }));
  for (const e of EXTRACTS) keepOut.push({ x: e.x, z: e.z, r: 5.0, why: 'extract' });

  const add = (c) => { colliders.push(c); return c; };

  // ---- 墙体工具 ------------------------------------------------------------
  // gap: [{c: 中心偏移, w: 宽度}] 用来开门洞
  function wall(x0, z0, x1, z1, y, h = WALL_H, opts = {}) {
    const tall = opts.tall !== false;
    const gaps = opts.gaps || [];
    const along = (x1 - x0) !== 0 ? 'x' : 'z';
    const len = along === 'x' ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    if (len < 0.05) return;
    // 把墙按门洞切成若干段
    const segs = [];
    const sorted = gaps.slice().sort((a, b) => a.c - b.c);
    let cursor = 0;
    for (const g of sorted) {
      const a = g.c - g.w / 2, b = g.c + g.w / 2;
      if (a > cursor) segs.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < len) segs.push([cursor, len]);
    for (const [a, b] of segs) {
      if (b - a < 0.05) continue;
      const sx0 = along === 'x' ? Math.min(x0, x1) + a : Math.min(x0, x1);
      const sx1 = along === 'x' ? Math.min(x0, x1) + b : Math.min(x0, x1);
      const sz0 = along === 'z' ? Math.min(z0, z1) + a : Math.min(z0, z1);
      const sz1 = along === 'z' ? Math.min(z0, z1) + b : Math.min(z0, z1);
      const c = along === 'x'
        ? { x0: sx0, z0: Math.min(z0, z1) - WALL_T / 2, x1: sx1, z1: Math.min(z0, z1) + WALL_T / 2 }
        : { x0: Math.min(x0, x1) - WALL_T / 2, z0: sz0, x1: Math.min(x0, x1) + WALL_T / 2, z1: sz1 };
      Object.assign(c, { tall, y0: y, y1: y + h, h });
      add(c);
      draw.push({ kind: 'wall', ...c, mat: opts.mat || 'rusty' });
    }
    // 门洞上方的过梁（不挡移动，只给视觉一个交代）
    for (const g of gaps) {
      const cx = along === 'x' ? Math.min(x0, x1) + g.c : Math.min(x0, x1);
      const cz = along === 'z' ? Math.min(z0, z1) + g.c : Math.min(z0, z1);
      draw.push({ kind: 'lintel', along, x: cx, z: cz, w: along === 'x' ? g.w : WALL_T, d: along === 'z' ? g.w : WALL_T, y: y + 2.4, h: h - 2.4, mat: opts.mat || 'rusty' });
      // 记录门洞，供道具摆放避让 —— 否则随机道具会正好堵在唯一的门口，
      // 把整个舱室连同它里面的容器从地图上切掉（实测踩到过 2 次）
      // along 记录的是**通行方向**：墙沿 x 走 → 门在 x 方向有开口。
      // 明确存下来，别让下游去猜（我第一版就猜反了）。
      const pad = 0.9;
      if (along === 'x') {
        doorways.push({ along: 'x', cx: cx, cz: cz, w: g.w,
          x0: cx - g.w / 2 - pad, z0: Math.min(z0, z1) - 1.0, x1: cx + g.w / 2 + pad, z1: Math.min(z0, z1) + 1.0 });
      } else {
        doorways.push({ along: 'z', cx: cx, cz: cz, w: g.w,
          x0: Math.min(x0, x1) - 1.0, z0: cz - g.w / 2 - pad, x1: Math.min(x0, x1) + 1.0, z1: cz + g.w / 2 + pad });
      }
    }
  }

  /** 某个矩形是否压到门洞（含余量）。margin 用来给门口留出转身空间。 */
  function blocksDoorway(x0, z0, x1, z1, margin = 0) {
    for (const d of doorways) {
      if (x0 - margin < d.x1 && x1 + margin > d.x0 && z0 - margin < d.z1 && z1 + margin > d.z0) return true;
    }
    return false;
  }

  /** 是否侵入了出生点/减压舱的禁放区。except：排除某个关键点自身 */
  function blocksKeepOut(x0, z0, x1, z1, except = null) {
    for (const k of keepOut) {
      if (except && Math.hypot(k.x - except.x, k.z - except.z) < 0.01) continue;
      const cx = Math.max(x0, Math.min(k.x, x1));
      const cz = Math.max(z0, Math.min(k.z, z1));
      if (Math.hypot(k.x - cx, k.z - cz) < k.r) return k;
    }
    return null;
  }

  // ---- 1. 边界墙 ------------------------------------------------------------
  for (const [x0, z0, x1, z1] of [
    [-HALF - 1, -HALF - 1, HALF + 1, -HALF], [-HALF - 1, HALF, HALF + 1, HALF + 1],
    [-HALF - 1, -HALF, -HALF, HALF], [HALF, -HALF, HALF + 1, HALF],
  ]) {
    const c = { x0, z0, x1, z1, tall: true, y0: -60, y1: 4, h: 64, edge: true };
    add(c);
    draw.push({ kind: 'edge', ...c, mat: 'conc' });
  }

  // ---- 2. 地面（每条带一块板 + 每条坡道一块斜板）---------------------------
  for (const b of BANDS) {
    draw.push({ kind: 'floor', band: b.id, x0: -HALF, z0: b.z0, x1: HALF, z1: b.z1, y: b.floorY, mat: 'deck' });
  }

  // ---- 3. 层间断崖：条带边界处，除坡道开口外全部封死 ------------------------
  for (let i = 1; i < BANDS.length; i++) {
    const zb = BANDS[i].z0;                       // 边界 z
    const from = BANDS[i - 1].floorY, to = BANDS[i].floorY;
    const openings = RAMPS.filter(r => r.z1 === zb);
    // 断崖墙：沿着边界铺，只在坡道 x 区间留口
    const sorted = openings.map(r => [r.x0, r.x1]).sort((a, b) => a[0] - b[0]);
    let cursor = -HALF;
    for (const [ox0, ox1] of sorted) {
      if (ox0 > cursor) cliff(cursor, ox0, zb, from, to);
      cursor = Math.max(cursor, ox1);
    }
    if (cursor < HALF) cliff(cursor, HALF, zb, from, to);

    function cliff(cx0, cx1, z, yA, yB) {
      if (cx1 - cx0 < 0.2) return;
      const y0 = Math.min(yA, yB), y1 = Math.max(yA, yB) + 1.2;
      add({ x0: cx0, z0: z - 0.6, x1: cx1, z1: z + 0.6, tall: true, y0, y1, cliff: true });
      // 绘制指令必须带齐 x0/x1/z0/z1/y0/y1。早先只给了 x0/x1/z，
      // 渲染层算出 w/h/dp 全是 NaN，而那里的尺寸守卫写的是 `if (w <= 0.02) break` ——
      // NaN 跟任何数比较都是 false，守卫根本不生效，于是拼出一批 NaN 顶点的盒子。
      // 它们进了阴影贴图就是几个铺满全图的巨大三角形：**整张地图永远处于阴影里**，
      // 表现是 8 个出生点里 6 个开局全黑。修复要两边都做：这里补齐字段，
      // 那边把守卫改成 NaN 也拦得住的形式。
      draw.push({ kind: 'cliff', x0: cx0, x1: cx1, z0: z - 0.6, z1: z + 0.6, y0, y1, mat: 'conc' });
    }
  }

  // ---- 4. 坡道：斜板 + 两侧护栏 ---------------------------------------------
  for (const r of RAMPS) {
    draw.push({ kind: 'ramp', ...r, mat: 'deck' });
    // 两侧护栏：挡住「走到坡道边缘直接掉 14 米」
    for (const x of [r.x0, r.x1]) {
      add({ x0: x - 0.3, z0: r.z0, x1: x + 0.3, z1: r.z1, tall: false, y0: r.y0, y1: r.y1 + RAIL_H, ramp: true });
      draw.push({ kind: 'rail', x, z0: r.z0, z1: r.z1, y0: r.y0, y1: r.y1, h: RAIL_H, mat: 'iron' });
    }
  }

  // ---- 5. 舱室墙体 ---------------------------------------------------------
  for (const zn of ZONES) {
    if (zn.tags.includes('natural') || zn.tags.includes('open')) continue;
    const [x0, z0, x1, z1] = zn.rect;
    const y = heightAt((x0 + x1) / 2, (z0 + z1) / 2);
    if (zn.tags.includes('corridor')) {
      // 走廊必须保持连通，所以只摆**短的**矮墙当掩体，并且每段之间留 ≥8m 的口子。
      // 早先版本沿长边铺满矮墙，结果走廊和它两边的区域彻底断开 ——
      // 「龙骨舱口」减压舱就是因此从 8 个出生点全部不可达。
      const horiz = (x1 - x0) > (z1 - z0);
      const len = horiz ? x1 - x0 : z1 - z0;
      const segs = Math.max(2, Math.round(len / 16));
      for (let i = 0; i < segs; i++) {
        if (rng.f() < 0.25) continue;                     // 随机再砍掉一些，留出通路
        const t0 = x0 + (horiz ? 0 : z0) + (i + 0.18) * (len / segs);
        const t1 = x0 + (horiz ? 0 : z0) + (i + 0.62) * (len / segs);
        if (horiz) wall(t0, z0, t1, z0, y, 1.05, { tall: false, mat: 'iron' });
        else wall(x0, t0, x0, t1, y, 1.05, { tall: false, mat: 'iron' });
      }
      continue;
    }
    // 舱室：四面墙 + 一到两个门洞
    const isSealed = zn.tags.includes('vault');
    const doorSide = ['s', 'n', 'e', 'w'][rng.int(0, 3)];
    // 门洞宽度不能太小：导航网格会把碰撞体按智能体半径(0.45m)膨胀再取 floor，
    // 3.4m 的门算下来只剩 **1 个**可走格 —— 孤立的单格在 A* 里几乎等于封死
    // （对角移动要求两侧正交格都可走）。次门 3.6m 也只够 2 格，同样不够。
    // 5.0 / 4.8 能稳定留下 4 格以上。validate 的 door-width 断言会守住这条线。
    const DOOR_W = 5.0, DOOR_W2 = 4.8;
    const mkGaps = (len) => {
      const g = [{ c: len * (0.3 + rng.f() * 0.4), w: DOOR_W }];
      if (!isSealed && len > 22) g.push({ c: len * (0.68 + rng.f() * 0.18), w: DOOR_W2 });
      return g;
    };
    const w = x1 - x0, d = z1 - z0;
    wall(x0, z0, x1, z0, y, isSealed ? 4.0 : WALL_H, { gaps: doorSide === 's' ? mkGaps(w) : [], mat: 'iron' });
    wall(x0, z1, x1, z1, y, isSealed ? 4.0 : WALL_H, { gaps: doorSide === 'n' ? mkGaps(w) : [], mat: 'iron' });
    wall(x0, z0, x0, z1, y, isSealed ? 4.0 : WALL_H, { gaps: doorSide === 'w' ? mkGaps(d) : [], mat: 'iron' });
    wall(x1, z0, x1, z1, y, isSealed ? 4.0 : WALL_H, { gaps: doorSide === 'e' ? mkGaps(d) : [], mat: 'iron' });
    // 地板
    draw.push({ kind: 'floor', band: zn.band, x0, z0, x1, z1, y: y + 0.02, mat: 'floor', zone: zn.id });
  }

  // ---- 6. 塌方破洞：打通舱室之间的短墙 -------------------------------------
  for (const b of BREACHES) {
    const y = heightAt(b.x, b.z);
    // 破洞位置不生成墙（这里只画一个开口标记 + 周围的碎石掩体）
    draw.push({ kind: 'breach', x: b.x, z: b.z, w: b.w, y, band: b.floor });
    for (let i = 0; i < 4; i++) {
      const a = rng.f() * Math.PI * 2, r = b.w * (0.7 + rng.f() * 0.6);
      const rx = b.x + Math.cos(a) * r, rz = b.z + Math.sin(a) * r;
      // 碎石同样不能压门洞 —— 破洞往往就挨着舱室围墙，
      // 碎石落进门里就等于把门堵死（实测封死了泵房的西门）。
      if (blocksDoorway(rx - 0.6, rz - 0.6, rx + 0.6, rz + 0.6)) continue;
      add({ x0: rx - 0.6, z0: rz - 0.6, x1: rx + 0.6, z1: rz + 0.6, tall: false, y0: y, y1: y + 0.9 });
      draw.push({ kind: 'rubble', x: rx, z: rz, y, s: 0.7 + rng.f() * 0.5, rot: rng.f() * 6.28, foot: [1.2, 1.2] });
    }
  }

  // ---- 7. 道具（同时是掩体和碰撞体）-----------------------------------------
  const MODELS = {
    crate: 'wooden_crate_01', milcrate: 'old_military_crate', pcrate: 'plastic_crate_01',
    barrel: 'Barrel_01', jerry: 'metal_jerrycan', tank: 'propane_tank', toolbox: 'metal_tool_chest',
    shelf: 'steel_frame_shelves_01', chest: 'treasure_chest', cart: 'tool_cart',
    gen: 'portable_generator', comp: 'old_military_compressor', pipe: 'modular_industrial_pipes_01',
    duct: 'modular_airduct_circular_01', lamp: 'hanging_industrial_lamp', plamp: 'industrial_pipe_lamp',
    search: 'portable_searchlight', slamp: 'security_light', crane: 'overhead_crane',
    wreck: 'dutch_ship_medium', buoy: 'ocean_buoy', ladder: 'ladder_sectioned_01',
    door: 'rollershutter_door', facade: 'modular_factory_facade', bench: 'painted_wooden_bench',
    jacket: 'life_jacket', med: 'medical_box', rock: 'moon_rock_02', rock2: 'rock_07',
    boulder: 'namaqualand_boulder_03', can: 'industrial_pastic_container', handtruck: 'hand_truck',
  };
  // 各类道具的碰撞盒（世界米）
  const PROPS = {
    crate: [1.1, 1.1], milcrate: [1.4, 1.0], pcrate: [1.0, 0.9], can: [1.5, 1.0],
    barrel: [0.8, 0.8], jerry: [0.5, 0.4], tank: [0.5, 0.5], toolbox: [0.9, 0.6],
    shelf: [1.8, 0.7], chest: [1.1, 0.8], cart: [1.5, 0.9], gen: [1.6, 1.1],
    comp: [1.4, 0.9], pipe: [4.0, 0.9], duct: [1.2, 1.2], bench: [1.8, 0.6],
    rock: [2.2, 2.0], rock2: [1.8, 1.6], boulder: [2.8, 2.6], handtruck: [0.6, 0.5],
  };
  const TALL_PROPS = new Set(['shelf', 'toolbox', 'chest', 'pipe', 'duct', 'gen', 'comp', 'facade']);

  function prop(kind, x, z, rot = 0, s = 1, mat = 'iron') {
    const [bw, bd] = PROPS[kind] || [1, 1];
    const swap = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
    const w = (swap ? bd : bw) * s, d = (swap ? bw : bd) * s;
    // 门口余量 1.4m：门洞本身只有 5m 宽，扣掉 0.45m 的智能体半径再取整格之后
    // 只剩 4 个可走格。道具哪怕不压住门，只要站在门口那 4 格边上，
    // 门就等于被堵死（实测提高道具密度后 40 个种子里有 1 个门只剩 2 格）。
    if (blocksDoorway(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 1.4)) return false;
    if (blocksKeepOut(x - w / 2, z - d / 2, x + w / 2, z + d / 2)) return false;
    const y = heightAt(x, z);
    add({ x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2, tall: TALL_PROPS.has(kind), y0: y, y1: y + (TALL_PROPS.has(kind) ? 2.2 : 1.1), prop: kind });
    // foot 告诉渲染层「这个碰撞盒实际是多大」。GLB 模型的原始尺寸极不统一
    // （实测货架 21m 高、集装箱只有 0.46m），不按碰撞盒归一化就会出现
    // 「撞一堵看不见的墙」和「21m 高的架子把摄像机包住」。
    draw.push({ kind: 'prop', model: MODELS[kind], x, y, z, rot, s, mat, foot: [w, d] });
    return true;
  }

  for (const zn of ZONES) {
    const [x0, z0, x1, z1] = zn.rect;
    const w = x1 - x0, d = z1 - z0;
    const natural = zn.tags.includes('natural');
    // 密度按「每 110 平米一件」定。早先 260㎡/件，260×260 的图里只有
    // 127 个道具，玩家在开阔区走 40m 看不到一样东西 —— 画面就是一块空板。
    const n = natural ? Math.round(w * d / 190) : Math.round(w * d / 110);
    for (let i = 0; i < n; i++) {
      const x = x0 + 2 + rng.f() * Math.max(1, w - 4);
      const z = z0 + 2 + rng.f() * Math.max(1, d - 4);
      let kind;
      if (natural) kind = rng.pick(['rock', 'rock2', 'boulder']);
      else if (zn.tags.includes('landmark')) kind = rng.pick(['barrel', 'jerry', 'tank', 'crate', 'bench']);
      else if (zn.tags.includes('cover')) kind = rng.pick(['crate', 'milcrate', 'pcrate', 'can', 'barrel', 'shelf']);
      else if (zn.tags.includes('room')) kind = rng.pick(['toolbox', 'cart', 'gen', 'comp', 'crate', 'shelf']);
      else kind = rng.pick(['crate', 'pcrate', 'barrel', 'handtruck', 'can']);
      // 撞到门洞就换个位置重试，最多 4 次
      for (let a = 0; a < 4; a++) {
        if (prop(kind, x, z, rng.f() * Math.PI * 2, 0.85 + rng.f() * 0.35)) break;
      }
    }
    // 地标与关键道具
    if (zn.id === 'crane') prop('crane', (x0 + x1) / 2, (z0 + z1) / 2, 0, 1.4);
    if (zn.id === 'derrick') { prop('pipe', (x0 + x1) / 2, z0 + 8, 0, 1.2); prop('pipe', (x0 + x1) / 2, z0 + 20, 0, 1.2); }
    if (zn.id === 'engine') { prop('comp', x0 + 5, (z0 + z1) / 2, Math.PI / 2); prop('gen', x0 + 13, (z0 + z1) / 2, 0); }
    // 泵房的空压机放偏一点，别压在区域正中（中层气闸撤离点也在这一带）
    if (zn.id === 'pump') { prop('comp', x0 + 5, z0 + 6, 0, 1.3); prop('pipe', x0 + 12, z0 + 5, 0, 0.9); }
    // 泥浆池：可以趟过去，所以 navPass（挡移动不挡寻路）。
    // 否则它会把整片区域从导航网格里挖掉，绞车深井撤离点当场不可达。
    if (zn.id === 'mud') {
      const py = heightAt((x0 + x1) / 2, (z0 + z1) / 2);
      add({ x0, z0, x1, z1, tall: false, navPass: true, y0: py - 0.4, y1: py + 0.15, pool: true });
      draw.push({ kind: 'pool', x0, z0, x1, z1, y: py });
    }
    // 灯具：深海里光是命，每个舱室挂一盏
    if (zn.tags.includes('room') || zn.tags.includes('corridor')) {
      const k = Math.max(1, Math.round(w * d / 420));
      for (let i = 0; i < k; i++) {
        const lx = x0 + 4 + rng.f() * Math.max(1, w - 8);
        const lz = z0 + 4 + rng.f() * Math.max(1, d - 8);
        draw.push({ kind: 'lamp', model: rng.pick(['hanging_industrial_lamp', 'industrial_pipe_lamp', 'security_light', 'portable_searchlight']), x: lx, y: heightAt(lx, lz) + 3.0, z: lz, rot: rng.f() * 6.28 });
      }
    }
  }

  // 竖梯：视觉上提示层间连接（不做攀爬机制）
  for (const r of RAMPS) {
    prop('ladder', (r.x0 + r.x1) / 2, r.z0 + 1, 0, 1);
  }

  // ---- 8. 减压舱（坐标在第 9 步统一解析；这里只出绘制指令）----------------
  // 减压舱**不生成碰撞体**。早先给它加了个 2.4m 的矮碰撞体，
  // 结果校验器报「中心落在不可走格 + 埋在碰撞体里」—— 撤离标记自己把撤离点堵死了。
  // 气泡柱是纯视觉，玩家应该能直接站进去。
  for (const e of EXTRACTS) {
    draw.push({ kind: 'decompress', x: e.x, y: heightAt(e.x, e.z), z: e.z, name: e.name, mat: 'steel' });
  }

  // ---- 8b. 平台结构（纯视觉，不生成碰撞体）---------------------------------
  // 为什么需要这一段：可玩区是 260×260m，但区域只占其中一部分，
  // 中间留下大片空荡荡的甲板。镜头里就是一块无限延伸的平板 + 一个小人。
  // 参考作那种「一眼看完整个战场」的密度感来自**结构性几何**：
  // 支撑腿、舷侧外板、头顶管路、层间护栏。这些不需要碰撞体（都在可行走面之外/之上），
  // 也不需要贴图，用程序化盒体和圆柱就够，但能把空旷的甲板变成一座沉没的平台。
  const deck = (shape, o) => draw.push({ kind: 'deco', shape, ...o });

  for (const b of BANDS) {
    const y = b.floorY;
    // 支撑腿：把每层甲板撑到海床。间隔 26m，避开条带两端的极值处。
    for (let x = -HALF + 14; x <= HALF - 14; x += 26) {
      for (const zz of [b.z0 + 10, (b.z0 + b.z1) / 2, b.z1 - 10]) {
        deck('pillar', { x, y, z: zz, r: 1.05, h: y - SEABED_Y, mat: 'conc' });
      }
    }
    // 舷侧外板：沿 x 两端垂下来的一圈钢板，让甲板有厚度
    for (const sx of [-1, 1]) {
      const x = sx * (HALF - 0.8);
      deck('plate', { x0: x - 0.35, x1: x + 0.35, z0: b.z0, z1: b.z1, y0: y - 9, y1: y + 1.1, mat: 'conc' });
      // 甲板边缘护栏
      deck('rail', { x: x - sx * 0.9, z0: b.z0, z1: b.z1, y0: y, y1: y, h: RAIL_H, mat: 'iron' });
    }
    // 头顶管路：横跨全宽的桁架 + 沿 z 的管束。
    // 只铺在两侧的话，画面中央还是一块 260m 宽的空板。
    // 横梁每 30m 一道，7m 高（在人头顶之上，不影响走动），给出强烈的透视参照。
    for (let z = b.z0 + 12; z < b.z1 - 8; z += 30) {
      deck('beam', { x0: -HALF + 4, x1: HALF - 4, z0: z - 0.3, z1: z + 0.3, y0: y + 6.6, y1: y + 7.1, mat: 'beams' });
      for (const bx of [-HALF * 0.5, 0, HALF * 0.5]) {
        deck('col', { x: bx, y, z, h: 6.6, r: 0.34, mat: 'beams' });
      }
    }
    for (const sx of [-1, 1]) {
      const x = sx * (HALF * 0.62);
      for (let z = b.z0 + 6; z < b.z1 - 6; z += 22) {
        deck('pipe', { x, y: y + 6.2, z, len: 20, r: 0.3, mat: 'iron' });
        if (rng.f() < 0.5) deck('pipe', { x: x + sx * 0.9, y: y + 5.6, z, len: 20, r: 0.2, mat: 'iron' });
      }
    }
    // 甲板拼板缝：每 12m 一道凸起长条。
    // 这是让「空旷甲板」有尺度感最便宜的办法 —— 观众的眼睛需要参照物，
    // 没有参照物时 260m 的地板看起来和 12m 的一样大（参考作靠密集掩体解决，
    // 但本作的玩法区域是自然海床，掩体不能铺满）。
    for (let x = -HALF + 6; x <= HALF - 6; x += 12) {
      deck('seam', { x0: x - 0.16, x1: x + 0.16, z0: b.z0, z1: b.z1, y0: y, y1: y + 0.14, mat: 'iron' });
    }
    for (let z = b.z0 + 6; z <= b.z1 - 6; z += 12) {
      deck('seam', { x0: -HALF, x1: HALF, z0: z - 0.16, z1: z + 0.16, y0: y, y1: y + 0.14, mat: 'iron' });
    }
  }
  // 层间护栏：沿条带边界整条铺（坡道口留空），让「这里换层了」一眼可读
  for (let i = 0; i < BANDS.length; i++) {
    const b = BANDS[i];
    const openings = RAMPS.filter(r => r.z0 === b.z0 || r.z1 === b.z0)
      .map(r => [Math.min(r.x0, r.x1) - 2.5, Math.max(r.x0, r.x1) + 2.5])
      .sort((p, q) => p[0] - q[0]);
    let cur = -HALF;
    const segs = [];
    for (const [a, bb] of openings) { if (a > cur) segs.push([cur, a]); cur = Math.max(cur, bb); }
    if (cur < HALF) segs.push([cur, HALF]);
    for (const [a, bb] of segs) {
      if (bb - a < 1) continue;
      const z = b.z0;
      deck('rail', { x: (a + bb) / 2, z0: z - 1.1, z1: z + 1.1, y0: b.floorY, y1: b.floorY, h: RAIL_H, mat: 'iron' });
    }
  }

  // ---- 9. 导航网格 ---------------------------------------------------------
  buildColliderGrid(colliders);
  const grid = rasterizeNav(colliders, HALF, 0.45);
  const nav = new Nav(grid, HALF * 2, HALF);

  /**
   * 把点位挪到最近的可站位置；挪不开就返回 null（调用方丢弃）。
   * 用于修「点位与道具重叠」—— 容器/敌人点位按区域矩形独立生成，
   * 道具是另一条随机路摆的，两条路必然偶尔撞上。
   */
  function resolveSpot(x, z, maxNudge = 3, self = null, bounds = null) {
    if (ok(x, z, self)) return { x, z };
    for (let ring = 1; ring <= maxNudge; ring++) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const nx = x + Math.cos(ang) * ring, nz = z + Math.sin(ang) * ring;
        if (nx < -HALF + 2 || nx > HALF - 2 || nz < -HALF + 2 || nz > HALF - 2) continue;
        // 挪动不能越出所属区域：否则会把点位从墙里"挤"到隔壁的封闭空间去，
        // 反而制造出不可达的容器点（实测封死货舱因此整体失联）。
        if (bounds && (nx < bounds[0] + 1 || nx > bounds[2] - 1 || nz < bounds[1] + 1 || nz > bounds[3] - 1)) continue;
        if (ok(nx, nz, self)) return { x: nx, z: nz };
      }
    }
    return null;
  }
  // self：正在解析的那个关键点。禁放区判定要把它自己排除掉 ——
  // 否则出生点会落在自己的禁放圈里，永远解析失败（except 由 blocksKeepOut 处理）。
  const ok = (x, z, self) => nav.walkableAt(x, z)
    && !blocksDoorway(x - 0.7, z - 0.7, x + 0.7, z + 0.7)
    && !blocksKeepOut(x - 0.7, z - 0.7, x + 0.7, z + 0.7, self);

  // 出生点与减压舱是安全网：禁放区已经挡掉了绝大多数情况，
  // 这里再兜一次底，保证「换个种子道具位置」也不会把它们埋掉。
  const spawns = [];
  for (const s of SPAWNS) {
    const p = resolveSpot(s.x, s.z, 2, s);
    if (p) spawns.push({ x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }
  const extracts = [];
  for (const e of EXTRACTS) {
    const p = resolveSpot(e.x, e.z, 2, e) || { x: e.x, z: e.z };
    extracts.push({ name: e.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), band: e.band, depth: depthAt(p.x, p.z), declaredDepth: e.depth });
  }

  const containerSpots = [];
  const lootSpots = [];
  // 容器/散落用独立 rng，避免和道具摆放互相牵制
  const crng = new Rng((seed ^ 0x5bf03635) >>> 0);
  // 容器也不能压在门洞上（否则搜刮点会把门口卡死）
  for (const c of containerSpotsFor(crng)) {
    const b = (ZONES.find(z => z.name === c.zone) || {}).rect;   // c.zone 是区域名
    const p = resolveSpot(c.x, c.z, 3, null, b);
    if (p) containerSpots.push({ ...c, x: p.x, z: p.z });
  }
  for (const l of lootSpotsFor(crng)) {
    const p = resolveSpot(l.x, l.z);
    if (p) lootSpots.push({ x: p.x, z: p.z });
  }

  // 敌人刷新点也要处理：容器/敌人点位是按区域矩形独立生成的，
  // 而道具是另一条路随机摆的 —— 两者会重叠，点位就落在道具碰撞体里，
  // 表现为「敌人刷新在墙里」或「容器点不可达」。这里统一挪开。
  const enemySpots = [];
  for (const e of ENEMY_SPOTS) {
    const p = resolveSpot(e.x, e.z, 4);
    if (p) enemySpots.push({ ...e, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }

  // ---- 9b. 连通性过滤 ------------------------------------------------------
  // 断言只能报错，点位还是会被摆出来。**在构建期就把不可达的点位丢掉**，
  // 这样「某个容器点玩家永远走不到」这类问题不会随种子随机出现。
  // 出生点各自可能处于不同的连通域，所以取所有出生点连通域的并集。
  const reach = new Uint8Array(nav.N * nav.N);
  for (const s of spawns) {
    const comp = nav.connectedFrom(s.x, s.z);
    for (let i = 0; i < reach.length; i++) if (comp[i]) reach[i] = 1;
  }
  const inReach = (x, z) => {
    const [ix, iz] = nav.cell(x, z);
    if (ix < 0 || iz < 0 || ix >= nav.N || iz >= nav.N) return false;
    return reach[nav.idx(ix, iz)] === 1;
  };
  const before = { c: containerSpots.length, l: lootSpots.length, e: enemySpots.length };
  const keptC = containerSpots.filter((c) => inReach(c.x, c.z));
  const keptL = lootSpots.filter((l) => inReach(l.x, l.z));
  const keptE = enemySpots.filter((e) => inReach(e.x, e.z));
  containerSpots.length = 0; for (const c of keptC) containerSpots.push(c);
  lootSpots.length = 0; for (const l of keptL) lootSpots.push(l);
  enemySpots.length = 0; for (const e of keptE) enemySpots.push(e);
  const dropped = { containers: before.c - keptC.length, loot: before.l - keptL.length, enemies: before.e - keptE.length };

  const world = {
    seed, half: HALF, N: HALF * 2,
    colliders, nav, grid,
    heightAt, depthAt, terrainClear,
    bands: BANDS, ramps: RAMPS,
    spawns,
    extracts, enemySpots,
    containerSpots, lootSpots,
    doorways,                 // 供 validate 断言"门洞够宽"
    dropped,                  // 构建期丢掉的不可达点位数（自检用）
    draw, models: MODELS,
  };
  return world;
}
