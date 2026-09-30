// 网格 A* 寻路 + 圆-AABB 碰撞推出 + 射线-AABB + 视线判定。
// 零 three、零 DOM，可在 Node 里直接跑（构建期地图断言就靠它）。
//
// 与参考作的三处刻意差异：
// 1) 碰撞体与导航层分离：collider.navPass = true 的碰撞体挡移动但不进导航网格。
//    参考作把桥面护栏光栅化进 nav，导致唯一的过河通道被堵死、AI 永远过不了河。
// 2) 视线判定吃高度参数：低掩体(sandbag/窗台)对视线不再是"完全无效"。
// 3) A* 的八方向不允许穿对角缝隙（和参考作一样要求两侧正交格可走），避免卡在墙角。

export class Nav {
  /** @param {Uint8Array} grid 1 = 不可走，长度 N*N  @param {number} N 边长(格) */
  constructor(grid, N, half) {
    this.g = grid; this.N = N; this.half = half;
    const n = N * N;
    this.cost = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 1;
    this.heap = new Int32Array(n);
    this.f = new Float32Array(n);
  }

  idx(ix, iz) { return iz * this.N + ix; }
  cell(x, z) { return [Math.floor(x + this.half), Math.floor(z + this.half)]; }
  free(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.N && iz < this.N && !this.g[iz * this.N + ix]; }
  walkableAt(x, z) { const [a, b] = this.cell(x, z); return this.free(a, b); }

  nearestFree(ix, iz) {
    if (this.free(ix, iz)) return [ix, iz];
    for (let r = 1; r < 6; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (this.free(ix + dx, iz + dz)) return [ix + dx, iz + dz];
      }
    }
    return null;
  }

  /** 网格直线是否畅通（每 0.4m 采样） */
  clear(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    if (d < 0.01) return this.walkableAt(x0, z0);
    const n = Math.ceil(d / 0.4);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.walkableAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
    }
    return true;
  }

  /**
   * A*。返回平滑后的路点数组（不含起点，终点为实际目标或最近可站格），失败返回 null。
   * @param {number} maxExp 扩展上限。跨整张图约需 300 次；2500~3000 够局部寻路。
   */
  find(sx, sz, tx, tz, maxExp = 3000) {
    const N = this.N;
    const s = this.nearestFree(...this.cell(sx, sz));
    const t = this.nearestFree(...this.cell(tx, tz));
    if (!s || !t) return null;
    const start = this.idx(s[0], s[1]), goal = this.idx(t[0], t[1]);
    if (start === goal) return [{ x: tx, z: tz }];

    const gen = ++this.gen;
    const heap = this.heap, f = this.f;
    let hn = 0;
    const h = (i) => {
      const dx = Math.abs((i % N) - t[0]), dz = Math.abs(((i / N) | 0) - t[1]);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);   // 八向 octile
    };
    const push = (i) => {
      let k = hn++; heap[k] = i;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (f[heap[p]] <= f[heap[k]]) break;
        const t2 = heap[p]; heap[p] = heap[k]; heap[k] = t2; k = p;
      }
    };
    const pop = () => {
      const top = heap[0]; heap[0] = heap[--hn];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < hn && f[heap[l]] < f[heap[m]]) m = l;
        if (r < hn && f[heap[r]] < f[heap[m]]) m = r;
        if (m === k) break;
        const t2 = heap[m]; heap[m] = heap[k]; heap[k] = t2; k = m;
      }
      return top;
    };

    this.stamp[start] = gen; this.cost[start] = 0; this.from[start] = -1;
    f[start] = h(start); push(start);

    let exp = 0, found = false;
    while (hn > 0 && exp++ < maxExp) {
      const cur = pop();
      if (cur === goal) { found = true; break; }
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      const cx = cur % N, cz = (cur / N) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.free(nx, nz)) continue;
        // 不许从对角缝隙穿过：两侧正交格必须都可走
        if (dx && dz && (!this.free(cx + dx, cz) || !this.free(cx, cz + dz))) continue;
        const ni = this.idx(nx, nz);
        if (this.closed[ni] === gen) continue;
        const nc = this.cost[cur] + (dx && dz ? 1.414 : 1);
        if (this.stamp[ni] !== gen || nc < this.cost[ni]) {
          this.stamp[ni] = gen; this.cost[ni] = nc; this.from[ni] = cur;
          f[ni] = nc + h(ni); push(ni);
        }
      }
    }
    if (!found) return null;

    const pts = [];
    for (let i = goal; i !== -1; i = this.from[i]) {
      pts.push({ x: (i % N) - this.half + 0.5, z: ((i / N) | 0) - this.half + 0.5 });
    }
    pts.reverse();

    // 拉绳平滑：尽量直接跳到更远的可直达路点
    const out = [];
    let a = 0;
    while (a < pts.length - 1) {
      let b = pts.length - 1;
      while (b > a + 1 && !this.clear(pts[a].x, pts[a].z, pts[b].x, pts[b].z)) b--;
      out.push(pts[b]); a = b;
    }
    // 终点：目标可走就用目标本身，否则落到最近可站格
    if (this.walkableAt(tx, tz)) out[out.length - 1] = { x: tx, z: tz };
    return out;
  }

  /**
   * 从 start 出发做 BFS，返回"与 start 连通的所有自由格"的标记数组。
   * 构建期用它断言：所有减压舱与所有可搜容器都在同一个连通分量里。
   */
  connectedFrom(sx, sz) {
    const N = this.N, seen = new Uint8Array(N * N);
    const s = this.nearestFree(...this.cell(sx, sz));
    if (!s) return seen;
    const q = new Int32Array(N * N);
    let qh = 0, qt = 0;
    const start = this.idx(s[0], s[1]);
    seen[start] = 1; q[qt++] = start;
    while (qh < qt) {
      const cur = q[qh++];
      const cx = cur % N, cz = (cur / N) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.free(nx, nz)) continue;
        if (dx && dz && (!this.free(cx + dx, cz) || !this.free(cx, cz + dz))) continue;
        const ni = this.idx(nx, nz);
        if (seen[ni]) continue;
        seen[ni] = 1; q[qt++] = ni;
      }
    }
    return seen;
  }
}

// ---------------- 碰撞体空间索引（8m 一格） ----------------

export function buildColliderGrid(colliders, cell = 8) {
  const map = new Map();
  const key = (i, j) => i * 100000 + j;
  for (const c of colliders) {
    for (let i = Math.floor(c.x0 / cell); i <= Math.floor(c.x1 / cell); i++) {
      for (let j = Math.floor(c.z0 / cell); j <= Math.floor(c.z1 / cell); j++) {
        const k = key(i, j);
        let l = map.get(k);
        if (!l) { l = []; map.set(k, l); }
        l.push(c);
      }
    }
  }
  let stamp = 0;
  const out = [];
  const grid = {
    cell,
    query(x0, z0, x1, z1) {
      stamp++; out.length = 0;
      const i0 = Math.floor(Math.min(x0, x1) / cell), i1 = Math.floor(Math.max(x0, x1) / cell);
      const j0 = Math.floor(Math.min(z0, z1) / cell), j1 = Math.floor(Math.max(z0, z1) / cell);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return colliders;   // 范围过大退化为全量
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const l = map.get(key(i, j));
        if (!l) continue;
        for (const c of l) if (c._s !== stamp) { c._s = stamp; out.push(c); }
      }
      return out;
    },
  };
  Object.defineProperty(colliders, 'grid', { value: grid, enumerable: false, configurable: true });
  return grid;
}

export function nearColliders(colliders, x0, z0, x1, z1) {
  return colliders.grid ? colliders.grid.query(x0, z0, x1, z1) : colliders;
}

/**
 * 由碰撞体列表生成 1m 导航网格。
 * @param {number} radius 智能体半径（光栅化膨胀量）
 */
export function rasterizeNav(colliders, half, radius = 0.45) {
  const N = half * 2;
  const g = new Uint8Array(N * N);
  for (const c of colliders) {
    // navPass：挡移动但不挡寻路（桥面护栏、可钻的缝隙）
    if (c.navPass) continue;
    const i0 = Math.max(0, Math.floor((c.x0 - radius + half)));
    const i1 = Math.min(N - 1, Math.floor((c.x1 + radius + half)));
    const j0 = Math.max(0, Math.floor((c.z0 - radius + half)));
    const j1 = Math.min(N - 1, Math.floor((c.z1 + radius + half)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) g[j * N + i] = 1;
  }
  return g;
}

// ---------------- 几何原语 ----------------

/** 圆与 AABB 碰撞推出。就地修改 p。 */
export function collideCircle(p, r, colliders) {
  for (const c of nearColliders(colliders, p.x - r, p.z - r, p.x + r, p.z + r)) {
    if (p.x < c.x0 - r || p.x > c.x1 + r || p.z < c.z0 - r || p.z > c.z1 + r) continue;
    const cx = Math.max(c.x0, Math.min(p.x, c.x1));
    const cz = Math.max(c.z0, Math.min(p.z, c.z1));
    let dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2), k = (r - d) / d;
      p.x += dx * k; p.z += dz * k;
    } else {
      // 圆心在盒内：沿最短方向弹出
      const l = p.x - c.x0, rr = c.x1 - p.x, t = p.z - c.z0, b = c.z1 - p.z;
      const m = Math.min(l, rr, t, b);
      if (m === l) p.x = c.x0 - r; else if (m === rr) p.x = c.x1 + r;
      else if (m === t) p.z = c.z0 - r; else p.z = c.z1 + r;
    }
  }
}

/**
 * 射线 vs AABB（2D 板法）。命中返回 [t, nx, nz]，否则 null。
 * @param {number} eyeY 射线起点高度；collider.y0/y1 存在时用于高度过滤（heightCheck）
 */
export function rayBox(ox, oz, dx, dz, c, eyeY = null) {
  if (eyeY !== null && c.y0 !== undefined) {
    // 掩体按高度判定：射线在掩体顶面之下才算被挡
    if (eyeY >= (c.y1 ?? Infinity)) return null;
  }
  let tmin = -Infinity, tmax = Infinity, nx = 0, nz = 0;
  if (Math.abs(dx) < 1e-9) { if (ox < c.x0 || ox > c.x1) return null; }
  else {
    let t1 = (c.x0 - ox) / dx, t2 = (c.x1 - ox) / dx, n = -1;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = n; nz = 0; }
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dz) < 1e-9) { if (oz < c.z0 || oz > c.z1) return null; }
  else {
    let t1 = (c.z0 - oz) / dz, t2 = (c.z1 - oz) / dz, n = -1;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; nz = n; }
    tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(0, tmin) || tmin < 0) return null;
  return [tmin, nx, nz];
}

/**
 * 视线是否通畅。默认只把 tall 碰撞体当遮挡；
 * 若碰撞体带 y0/y1，则用高度判定（低掩体不再对视线完全无效）。
 */
export function losClear(colliders, x0, z0, x1, z1, eyeY0 = null, eyeY1 = null) {
  const dx = x1 - x0, dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 0.01) return true;
  const ux = dx / L, uz = dz / L;
  for (const c of nearColliders(colliders, x0, z0, x1, z1)) {
    if (c.blocksSight === false) continue;
    if (!c.tall) continue;
    if (Math.max(x0, x1) < c.x0 || Math.min(x0, x1) > c.x1) continue;
    if (Math.max(z0, z1) < c.z0 || Math.min(z0, z1) > c.z1) continue;
    const h = rayBox(x0, z0, ux, uz, c);
    if (h && h[0] < L) return false;
  }
  return true;
}

/** 地形视线：沿连线按 2m 步进查高度场，挡住则 false */
export function terrainClear(heightAt, x0, z0, y0, x1, z1, y1) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  if (d < 0.01) return true;
  const n = Math.max(1, Math.floor(d / 2));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const rayY = y0 + (y1 - y0) * t;
    if (heightAt(x, z) > rayY - 0.15) return false;
  }
  return true;
}

/** 把角度差归一到 [-π, π] */
export function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
