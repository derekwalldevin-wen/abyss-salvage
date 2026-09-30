// 钻井平台「墨龙号」的布局数据。纯数据 + 少量纯函数，零 three。
//
// 关键结构决定：四层地板沿 **Z 轴排成不重叠的条带**，层与层之间用斜坡连接。
// 原因很硬 —— heightAt(x, z) 是单值函数，两层楼不可能叠在同一个 (x,z) 上。
// 平台本来就是一头翘进海面、一头沉进海沟的，所以「越往南越深」既符合设定，
// 也让深度成为玩家能直接用眼睛读懂的��间信息。
//
// 早期版本把四层画成互相重叠的矩形（正是这一点在写 build.js 时才暴露出来），
// 那样 heightAt 无解。现在改成条带 + 斜坡后，整张图的地面高度是 z 的分段线性函数。

export const HALF = 130;                 // 可玩区半边长（米），260×260
export const SEA_LEVEL = 0;
export const SEABED_Y = -48;

/**
 * 四个条带，由浅到深。z0 < z1，每条带内部地面高度恒为 floorY。
 * 条带之间由 RAMPS 里的斜坡衔接；斜坡之外是断崖（不可通行）。
 */
export const BANDS = [
  { id: 'foredeck', name: '艏层甲板', z0: -130, z1: -58, floorY: -6 },
  { id: 'work', name: '中层作业区', z0: -58, z1: 14, floorY: -20 },
  { id: 'drill', name: '深井钻井区', z0: 14, z1: 78, floorY: -34 },
  { id: 'hold', name: '舱底压载舱', z0: 78, z1: 130, floorY: -44 },
];

/** 条带地面高度（米深）。索引 0 最浅。 */
export const DEEP = BANDS.map(b => b.floorY);

/**
 * 斜坡：层与层之间唯一合法的通路。
 * 只在 [x0,x1] 这个 x 区间内可走，区间外同一 z 处是断崖（会生成墙体碰撞体）。
 * 刻意做成斜置通道而不是真垂直 —— 玩家始终只在 2.5D 平面上走，走过去就换了一层深度。
 */
export const RAMPS = [
  { from: 'foredeck', to: 'work', z0: -70, z1: -58, y0: -6, y1: -20, x0: -100, x1: -60, name: '艏西坡道' },
  { from: 'foredeck', to: 'work', z0: -70, z1: -58, y0: -6, y1: -20, x0: 20, x1: 60, name: '艏东坡道' },
  { from: 'work', to: 'drill', z0: 2, z1: 14, y0: -20, y1: -34, x0: -30, x1: 10, name: '作业西坡道' },
  { from: 'work', to: 'drill', z0: 2, z1: 14, y0: -20, y1: -34, x0: 40, x1: 80, name: '作业东坡道' },
  { from: 'drill', to: 'hold', z0: 66, z1: 78, y0: -34, y1: -44, x0: -40, x1: 0, name: '深井西坡道' },
  { from: 'drill', to: 'hold', z0: 66, z1: 78, y0: -34, y1: -44, x0: 30, x1: 70, name: '深井东坡道' },
];

/** 塌方破洞：同层内两条走廊之间的捷径，也是遭遇战点 */
export const BREACHES = [
  { floor: 'work', x: -50, z: -38, w: 5 },
  { floor: 'work', x: 8, z: -46, w: 5 },
  { floor: 'work', x: -20, z: 0, w: 6 },
  { floor: 'drill', x: 38, z: 40, w: 5 },
  { floor: 'hold', x: -32, z: 104, w: 5 },
];

/**
 * 区域。rect = [x0, z0, x1, z1]，必须完全落在所属条带的 z 区间内。
 * tags: open 开阔 / cover 有掩体 / room 舱室 / corridor 走廊
 *       landmark 地标 / vault 高价值 / natural 海床（非人工，不刷怪）
 */
export const ZONES = [
  // ---- 艏层甲板 (y = -6) ----
  { id: 'heli', name: '直升机坪', band: 'foredeck', rect: [-120, -126, -62, -94], tags: ['open', 'landmark'] },
  { id: 'crane', name: '吊车基座', band: 'foredeck', rect: [-40, -124, -4, -96], tags: ['landmark', 'cover'] },
  { id: 'boxes', name: '集装箱堆', band: 'foredeck', rect: [20, -122, 82, -92], tags: ['cover'] },
  { id: 'winch', name: '艉部绞车区', band: 'foredeck', rect: [94, -120, 126, -88], tags: ['open'] },
  { id: 'deckcorr', name: '艏层通道', band: 'foredeck', rect: [-56, -90, 16, -64], tags: ['corridor'] },

  // ---- 中层作业区 (y = -20) ----
  { id: 'pipe', name: '管廊', band: 'work', rect: [-118, -54, -62, -24], tags: ['cover', 'corridor'] },
  { id: 'pump', name: '泵房', band: 'work', rect: [-46, -52, 4, -22], tags: ['room'] },
  { id: 'mess', name: '餐厅', band: 'work', rect: [20, -50, 64, -24], tags: ['room'] },
  { id: 'bunk', name: '宿舍', band: 'work', rect: [80, -52, 120, -20], tags: ['room'] },
  { id: 'cargo', name: '货舱', band: 'work', rect: [-118, -16, -58, 8], tags: ['room', 'cover'] },
  { id: 'workcorr', name: '作业区通道', band: 'work', rect: [-44, -16, 76, 8], tags: ['corridor'] },

  // ---- 深井钻井区 (y = -34) ----
  { id: 'derrick', name: '钻杆区', band: 'drill', rect: [-112, 20, -52, 56], tags: ['landmark', 'cover'] },
  { id: 'mud', name: '泥浆池', band: 'drill', rect: [-32, 22, 30, 54], tags: ['open'] },
  { id: 'engine', name: '机房', band: 'drill', rect: [48, 20, 98, 54], tags: ['room'] },
  { id: 'drillcorr', name: '钻井通道', band: 'drill', rect: [-48, 60, 100, 76], tags: ['corridor'] },

  // ---- 舱底压载舱 (y = -44) ----
  { id: 'ballast', name: '压载舱', band: 'hold', rect: [-112, 84, -42, 118], tags: ['room'] },
  { id: 'sealed', name: '封死货舱', band: 'hold', rect: [-24, 84, 38, 114], tags: ['room', 'vault'] },
  { id: 'keel', name: '龙骨通道', band: 'hold', rect: [-38, 118, 42, 129], tags: ['corridor'] },
  // 海床废墟/残骸场：人工结构之外的自然堆积，放在条带两端的 x 极值处
  { id: 'wreck', name: '海床废墟', band: 'hold', rect: [-128, 82, -116, 126], tags: ['natural'] },
  { id: 'debris', name: '残骸场', band: 'drill', rect: [112, 20, 128, 60], tags: ['natural'] },
];

/**
 * 六个减压舱。每局随机开 3 个。必须落在对应条带内。
 * depth 是设计深度标注；实际深度由 heightAt 算出，构建期断言两者一致。
 * 位置都避开了区域正中 —— 正中常常被地标道具或泥浆池占住，
 * 撤离点被自己的场景道具堵死是这类项目最常见的低级 bug。
 */
export const EXTRACTS = [
  { name: '艏部吊笼', band: 'foredeck', x: -92, z: -110, depth: 6 },
  { name: '艉部绞车', band: 'foredeck', x: 110, z: -104, depth: 6 },
  { name: '中层气闸', band: 'work', x: -22, z: -12, depth: 20 },     // 作业区通道内，避开泵房中心
  { name: '泵房顶口', band: 'work', x: 52, z: -36, depth: 20 },
  { name: '绞车深井', band: 'drill', x: 20, z: 70, depth: 34 },     // 钻井通道内，避开泥浆池与两条坡道口
  { name: '龙骨舱口', band: 'hold', x: 0, z: 124, depth: 44 },
];

/** 玩家出生点：全部在艏层最浅处（潜水员从吊笼下水） */
export const SPAWNS = [
  { x: -104, z: -118 }, { x: -70, z: -120 }, { x: 66, z: -118 },
  { x: 108, z: -112 }, { x: -30, z: -112 }, { x: 34, z: -84 },
  { x: -20, z: -80 }, { x: 96, z: -70 },
];

const roleFor = {
  heli: 'guard', crane: 'gunner', boxes: 'runner', winch: 'guard', deckcorr: 'runner',
  pipe: 'runner', pump: 'guard', mess: 'runner', bunk: 'breacher', cargo: 'gunner', workcorr: 'guard',
  derrick: 'gunner', mud: 'guard', engine: 'breacher', drillcorr: 'runner',
  ballast: 'breacher', sealed: 'gunner', keel: 'guard',
};

/**
 * 敌人刷新点：在每个非 natural 区域里均匀铺开，并保证必定刷新的兵种。
 * 返回 { x, z, role, zone, r, band, always? }
 */
export const ENEMY_SPOTS = (() => {
  const out = [];
  for (const z of ZONES) {
    if (z.tags.includes('natural')) continue;
    const [x0, z0, x1, z1] = z.rect;
    const area = (x1 - x0) * (z1 - z0);
    const n = Math.max(2, Math.round(area / 620));
    for (let i = 0; i < n; i++) {
      // 网格化铺开，避免随机扎堆
      const gx = x0 + ((i % 3) + 0.5) / 3 * (x1 - x0);
      const gz = z0 + (Math.floor(i / 3) + 0.5) / Math.ceil(n / 3) * (z1 - z0);
      out.push({
        x: Math.min(x1 - 2, Math.max(x0 + 2, gx)),
        z: Math.min(z1 - 2, Math.max(z0 + 2, gz)),
        role: roleFor[z.id] || 'guard', zone: z.name, r: 6, band: z.band,
      });
    }
  }
  // 观察哨：固定点位，不巡逻
  for (const [x, z, band] of [[-118, -100, 'foredeck'], [122, -96, 'foredeck'],
    [-108, -40, 'work'], [110, -36, 'work'], [90, 38, 'drill'], [-40, 100, 'hold']]) {
    out.push({ x, z, role: 'spotter', zone: '观察哨', r: 1, band });
  }
  // 每个条带一个监工卫队（ROLES.foreman.always = true，必定刷新）
  for (const b of BANDS) {
    const zz = ZONES.find(z => z.band === b.id && !z.tags.includes('natural'));
    out.push({ x: (zz.rect[0] + zz.rect[2]) / 2, z: (zz.rect[1] + zz.rect[3]) / 2, role: 'foreman', zone: b.name, r: 5, band: b.id });
  }
  // Boss：舱底封死货舱
  out.push({ x: 8, z: 99, role: 'anchor', zone: '封死货舱', r: 3, band: 'hold' });
  // 结构性保证：出生点 50m 内不刷怪。
  // 放在这里过滤（而不是只靠构建期断言）是因为断言只能报错，结构上排除才不会复发。
  return out.filter(e => SPAWNS.every(s => Math.hypot(e.x - s.x, e.z - s.z) >= 50));
})();

/** 某点属于哪个条带（含斜坡归属） */
export function bandAt(z) {
  for (const b of BANDS) if (z >= b.z0 && z <= b.z1) return b;
  return null;
}

/** 覆盖该 z 的斜坡（若玩家 x 在该斜坡的 x 区间内） */
export function rampAt(x, z) {
  for (const r of RAMPS) {
    if (z >= r.z0 && z <= r.z1 && x >= r.x0 && x <= r.x1) return r;
  }
  return null;
}

/** 某点属于哪个区域 */
export function zoneAt(x, z) {
  for (const zn of ZONES) {
    const [x0, z0, x1, z1] = zn.rect;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return zn;
  }
  return null;
}

/** 某点的地面高度 —— 全图唯一的真相来源 */
export function heightAt(x, z) {
  const r = rampAt(x, z);
  if (r) {
    const t = (z - r.z0) / (r.z1 - r.z0);
    return r.y0 + (r.y1 - r.y0) * t;
  }
  const b = bandAt(z);
  return b ? b.floorY : (z < BANDS[0].z0 ? BANDS[0].floorY : BANDS[BANDS.length - 1].floorY);
}

/** 深度（米）。水面为 0，向下为正。 */
export function depthAt(x, z) { return Math.max(0, -heightAt(x, z)); }

/** 容器点位（按区域面积铺开，深处给更多高价值类型） */
export function containerSpotsFor(rng) {
  const out = [];
  for (const zn of ZONES) {
    if (zn.tags.includes('natural')) continue;
    const [x0, z0, x1, z1] = zn.rect;
    const n = Math.max(2, Math.round(((x1 - x0) * (z1 - z0)) / 620));
    const depth = -heightAt((x0 + x1) / 2, (z0 + z1) / 2);
    for (let i = 0; i < n; i++) {
      const x = x0 + 3 + rng.f() * Math.max(1, x1 - x0 - 6);
      const z = z0 + 3 + rng.f() * Math.max(1, z1 - z0 - 6);
      const r = rng.f();
      let type;
      // 保险库/封死货舱有深度门槛（30m / 36m），必须先满足深度才允许抽到，
      // 否则会出现「6m 深的甲板上摆着保险库」这种自相矛盾的布局。
      const d = depthAt(x, z);
      if (zn.tags.includes('vault')) type = r < 0.5 ? 'hold' : 'vault';
      else if (d >= 36 && r < 0.16) type = 'hold';
      else if (d >= 30 && r < 0.34) type = 'vault';
      else if (d >= 30 && r < 0.46) type = 'crate';
      else if (r < 0.58) type = 'crate';
      else if (r < 0.68) type = 'toolbox';
      else if (r < 0.76) type = 'medkit';
      else if (r < 0.86) type = 'ammo';
      else type = 'netbag';
      out.push({ type, x, z, band: zn.band, zone: zn.name });
    }
  }
  return out;
}

/** 地面散落点位（raid 里 40% 概率变成实际容器） */
export function lootSpotsFor(rng) {
  const out = [];
  for (const zn of ZONES) {
    const [x0, z0, x1, z1] = zn.rect;
    const n = 2 + Math.floor(rng.f() * 3);
    for (let i = 0; i < n; i++) {
      out.push({ x: x0 + 2 + rng.f() * Math.max(1, x1 - x0 - 4), z: z0 + 2 + rng.f() * Math.max(1, z1 - z0 - 4) });
    }
  }
  return out;
}
