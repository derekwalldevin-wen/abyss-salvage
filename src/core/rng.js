// 种子随机数。整局世界生成、战利品、敌人装备都由它驱动 —— 同 seed 必得同结果，
// 这样无头模拟跑出来的平衡结论才有意义，也才能复现 bug。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.seed = seed >>> 0; this.next = mulberry32(this.seed); this.calls = 0; }
  f() { this.calls++; return this.next(); }
  range(a, b) { return a + this.f() * (b - a); }            // [a,b)
  int(a, b) { return Math.floor(this.range(a, b + 1)); }    // [a,b] 闭区间
  chance(p) { return this.f() < p; }
  sign() { return this.f() < 0.5 ? -1 : 1; }
  pick(arr) { return arr.length ? arr[Math.floor(this.f() * arr.length)] : undefined; }
  // 原地洗牌（Fisher–Yates，均匀；参考作用 sort(()=>rng()-.5) 是有偏的）
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.f() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // 按权重取索引。权重全为 0 时返回 -1（而不是参考作那样静默落到最后一项，
  // 那会造出 ITEMS[undefined] 然后在读 .s 时炸掉）
  weightedIndex(weights) {
    let sum = 0;
    for (const w of weights) if (w > 0) sum += w;
    if (sum <= 0) return -1;
    let r = this.f() * sum;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (w > 0) { r -= w; if (r < 0) return i; }
    }
    return weights.length - 1;
  }
  // 高斯近似：3 个均匀分布求和，均值 0、标准差约 0.577，用于弹道散布
  gauss() { return (this.f() + this.f() + this.f() - 1.5) / 0.866; }
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
