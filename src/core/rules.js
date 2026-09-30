// 战斗 / 伤害 / 护甲 / 压力 / 氧气 / 背包 / 战利品 / 结算。零 three、零 DOM。
//
// 相对参考作刻意改掉的三件事：
// 1) 爆头是真判定，不是每颗子弹掷 16% 骰子。改成「上半身胶囊 + 头部球」两段碰撞体，
//    爆头率变成距离与姿态的函数，可以被技术学习。
// 2) 护甲耐久不再倒挂。参考作被打时按 0.55×、打人时按 0.32× 扣耐久，玩家护甲反而掉得更快。
//    这里统一用有效防护值：eff = cut × (0.35 + 0.65 × cur/dur)，耐久越低减免越弱。
// 3) 冲刺速度吃武器移速系数。参考作写死 7.0，M249 比 G17 冲刺还快。

import {
  GUNS, AMMO, ITEMS, SUITS, HELMS, PACKS, CONTAINERS, RARITY,
  depthValueScale, pressureDamage, o2Drain, EXTRACT_BONUS, INSURANCE,
  ABANDON_REFUND, MIN_MONEY, haulValue, loadoutCost, skillMods,
} from './catalog.js';
import { rayBox, losClear, nearColliders, angDiff } from './nav.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- 角色碰撞体 ----------
// 躯干：竖直胶囊（XZ 平面上的圆 + 高度区间）
// 头部：球，位于肩部之上
export const BODY = {
  r: 0.42,          // 躯干半径
  y0: 0.0,          // 躯干下沿（相对脚下）
  y1: 1.42,         // 躯干上沿（肩）
  headR: 0.19,      // 头球半径
  headY: 1.60,      // 头球中心高度
  headMul: 1.9,     // 爆头伤害倍率
};

// 护具磨损系数：吸收到的伤害里，有多大比例会真的磨损护具。
// 1.0 = 打到护具就等于打废它；0.5 = 磨掉一半。攻守双方一致。
export const ARMOR_WEAR = 0.5;

export function makeActorState(opts = {}) {
  const suit = SUITS.find(s => s.id === (opts.suit || 's0')) || SUITS[0];
  const helm = HELMS.find(h => h.id === (opts.helm || 'h0')) || HELMS[0];
  return {
    x: opts.x || 0, z: opts.z || 0, y: opts.y || 0,
    angle: Math.PI, hp: 100, maxHp: 100,
    r: BODY.r,
    // 刚穿上就是满耐久。参考作每局都重置满耐久，本作耐久跨局保留（由 profile 传入覆盖）
    suit: { ...suit, cur: opts.suitCur ?? suit.dur },
    helm: { ...helm, cur: opts.helmCur ?? helm.dur },
    dead: false, hurtT: -99, heal: 0, meds: 0,
  };
}

/** 护甲/头盔当前的有效减伤（耐久越低越弱） */
export function effCut(piece, bonus = 0) {
  if (!piece || piece.lvl === 0 || piece.cur <= 0) return 0;
  const ratio = clamp(piece.cur / Math.max(1, piece.dur), 0, 1);
  return clamp(piece.cut * (0.35 + 0.65 * ratio) + bonus, 0, 0.85);
}

/**
 * 射线 vs 角色（真碰撞体）。
 * @returns {null | {t:number, head:boolean}} t 是沿射线方向的距离
 */
export function rayActor(ox, oy, oz, dx, dz, actor) {
  if (actor.dead) return null;
  const px = actor.x - ox, pz = actor.z - oz;
  const along = px * dx + pz * dz;                 // 投影到射线方向
  if (along <= 0) return null;
  // 垂直于射线的偏移
  const perpX = px - dx * along, perpZ = pz - dz * along;
  const perp2 = perpX * perpX + perpZ * perpZ;

  let best = null;

  // 躯干：XZ 圆 + 高度区间（射线在 y=oy 的水平面内，故只要 oy 落在区间内就可能命中）
  if (oy >= actor.y + BODY.y0 && oy <= actor.y + BODY.y1) {
    const rr = actor.r + 0.06;
    if (perp2 < rr * rr) {
      const t = along - Math.sqrt(rr * rr - perp2);
      if (t >= 0) best = { t, head: false };
    }
  }
  // 头：球。射线是水平的（y 恒为 oy），所以只要球心在 oy 上下 headR 之内即可能命中
  const headY = actor.y + BODY.headY;
  const dy = headY - oy;
  const rr = BODY.headR + 0.06;
  const headDist2 = perp2 + dy * dy;
  if (headDist2 < rr * rr) {
    const half = Math.sqrt(rr * rr - dy * dy);   // 水平方向半弦
    const t = along - half;
    if (t >= 0 && (!best || t < best.t)) best = { t, head: true };
  }
  return best;
}

/**
 * 射击解算：一步完成几何判定与伤害计算。
 * 这是纯函数，不改任何状态 —— 便于单测。
 *
 * @param {object} o
 * @param {number} o.ox,o.oy,o.oz 射线起点（枪口）
 * @param {number} o.dx,o.dz 单位方向
 * @param {object} o.gun GUNS 的一项
 * @param {Array}  o.targets 目标 actor 数组
 * @param {Array}  o.colliders 碰撞体
 * @param {object} o.world { heightAt }
 * @param {number} o.spreadDeg 散布角（度）
 * @param {Function} o.rng 0..1 随机源
 * @param {number} o.dmgMul 难度伤害系数
 * @param {number} o.suitBonus 技能加成的有效防护
 * @param {boolean} o.explosive 爆炸（不掷爆头）
 */
export function traceShot(o) {
  const { ox, oy, oz, dx, dz, gun, targets, colliders, world, spreadDeg, rng, dmgMul, suitBonus = 0, explosive = false } = o;
  const pellets = gun.pellets || 1;
  const maxT = gun.range * 1.6;
  const out = [];
  let anyHit = null;
  // rng 既接受函数也接受 Rng 实例（调用方很容易传错，这里兜住）
  const rf = typeof rng === 'function' ? rng : (rng && typeof rng.f === 'function' ? () => rng.f() : null);

  for (let k = 0; k < pellets; k++) {
    // 高斯散布
    let ang = Math.atan2(dx, dz);
    if (spreadDeg > 0) {
      const g = rf ? rf() * 2 - 1.5 : 0;          // 近似高斯
      ang += (g / 1.5) * (spreadDeg * Math.PI / 180) * 1.732;
    }
    const rx = Math.sin(ang), rz = Math.cos(ang);

    let hitT = maxT, hitActor = null, hitHead = false, groundHit = false, nx = 0, nz = 0;

    // 1) 角色
    for (const a of targets) {
      const h = rayActor(ox, oy, oz, rx, rz, a);
      if (h && h.t < hitT) { hitT = h.t; hitActor = a; hitHead = h.head; }
    }

    // 2) 碰撞体
    let wallT = Infinity, lowT = Infinity, lowN = [0, 0];
    for (const c of nearColliders(colliders, ox, oz, ox + rx * maxT, oz + rz * maxT)) {
      if (c.noBullet) continue;
      const h = rayBox(ox, oz, rx, rz, c, oy);
      if (!h) continue;
      if (c.tall) { if (h[0] < wallT) { wallT = h[0]; nx = h[1]; nz = h[2]; } }
      else if (h[0] < lowT) { lowT = h[0]; lowN = [h[1], h[2]]; }
    }
    // 低掩体规则：只有当它离射手够近（沿射线 < 1.6m）才挡。
    // 含义是「远处可以打越过去，贴脸时必须探身」——这是有代价的取舍，不是免费掩体。
    let effWallT = wallT, enx = nx, enz = nz;
    if (lowT < 1.6 && lowT < effWallT) { effWallT = lowT; enx = lowN[0]; enz = lowN[1]; }

    // 3) 地形山脊
    const endT = Math.min(hitT, effWallT);
    const tgtY = hitActor ? hitActor.y + 1.1 : oy;
    for (let t = 1.5; t < endT; t += 1.0) {
      const hx = ox + rx * t, hz = oz + rz * t;
      const rayY = oy + (tgtY - oy) * (t / Math.max(0.001, endT));
      if (world.heightAt(hx, hz) > rayY - 0.1) {
        hitT = t; groundHit = true; hitActor = null; hitHead = false;
        break;
      }
    }

    const stoppedAt = Math.min(hitT, effWallT);
    const hitSomething = hitActor && hitT <= effWallT;
    let dmg = 0;
    if (hitSomething) {
      let d = gun.dmg;
      // 距离衰减：最远保 35%
      if (stoppedAt > gun.range) d *= Math.max(0.35, 1 - (stoppedAt - gun.range) / gun.range);
      d *= dmgMul;
      if (!explosive && hitHead) d *= BODY.headMul;
      dmg = d;
      out.push({ kind: 'actor', t: stoppedAt, head: hitHead, dmg, actor: hitActor, dx: rx, dz: rz });
      if (!anyHit) anyHit = out[out.length - 1];
    } else if (groundHit) {
      out.push({ kind: 'ground', t: stoppedAt, x: ox + rx * stoppedAt, z: oz + rz * stoppedAt });
    } else if (effWallT < maxT) {
      out.push({ kind: 'wall', t: effWallT, x: ox + rx * effWallT, z: oz + rz * effWallT, nx: enx, nz: enz });
    } else {
      out.push({ kind: 'void', t: maxT, x: ox + rx * maxT, z: oz + rz * maxT });
    }
  }
  return { pellets: out, hit: anyHit };
}

/**
 * 把一次命中结算到目标身上（就地修改）。
 * @returns {number} 实际造成的 HP 伤害
 */
export function applyDamage(target, rawDmg, head, opts = {}) {
  const { byPlayer = false, explosive = false, suitBonus = 0, helmBonus = 0 } = opts;
  if (target.dead) return 0;
  target.hurtT = opts.now ?? 0;
  let d = rawDmg;
  if (explosive) d *= 0.85;

  // 爆头吃头盔，其他吃潜水服 —— 真判定，不是掷骰
  const piece = head ? target.helm : target.suit;
  const bonus = head ? helmBonus : suitBonus;
  const eff = effCut(piece, bonus);
  if (piece && piece.lvl > 0 && piece.cur > 0) {
    // 耐久按「护具实际吸收掉的那部分伤害」扣，而不是按减伤前的原始伤害。
    // 攻守双方完全对称 —— 参考作这里是 0.55(被打) vs 0.32(打人) 的倒挂，
    // 结果是玩家的护甲掉得比敌人快约 1.7 倍。
    const absorbed = d * eff;
    piece.cur = Math.max(0, piece.cur - absorbed * ARMOR_WEAR);
    d *= (1 - eff);
  }
  target.hp -= d;
  if (target.hp <= 0) { target.hp = 0; target.dead = true; }
  void explosive;
  return d;
}

// ---------- 压力与氧气 ----------

/**
 * 每帧更新潜水员的深度相关生存状态。返回 { o2, pressure, depth }
 * @param {boolean} p.pressureSafe 处于减压舱内 —— 舱内会平衡压强，不吃压力伤害。
 *   这既是设定自洽（减压舱本来就把压力平衡掉），也让「在 40m 深处站满 7 秒读条」
 *   成为一个可完成的操作，而不是必死陷阱。
 */
export function updateVitals(p, dt, mods, diff) {
  const depth = Math.max(0, -(p.y || 0));
  const o2 = p.o2 - o2Drain(depth) * mods.o2Cost * dt;
  const pd = p.pressureSafe ? 0 : pressureDamage(depth, mods.pressureStart);
  let hp = p.hp;
  if (pd > 0) {
    hp -= pd * dt;
    p.hurtT = p.elapsed ?? 0;
  }
  // 脱战回压 / 回氧
  const since = (p.elapsed ?? 0) - (p.hurtT ?? -99);
  if (since > 6) {
    if (diff.regen > 0 && hp < p.maxHp) hp = Math.min(p.maxHp, hp + diff.regen * dt);
    if (diff.o2regen > 0 && p.o2 < mods.o2Max) {
      // 只有在减压舱附近或浅层才回氧
      p.o2 = Math.min(mods.o2Max, p.o2 + diff.o2regen * dt * (depth < 12 ? 1 : 0.15));
    }
  }
  if (o2 <= 0) { p.o2 = 0; hp -= 6 * dt; }             // 缺氧直接扣血
  if (hp <= 0) { hp = 0; p.dead = true; }
  p.hp = hp;
  return { o2: p.o2, pressure: pd, depth };
}

// ---------- 背包 ----------

export function bagUsed(bag) {
  let s = 0;
  for (const k of bag) { const d = ITEMS[k]; if (d) s += d.s; }
  return s;
}
export function packSlots(packId, mods) {
  const p = PACKS.find(x => x.id === packId) || PACKS[0];
  return p.slots + (mods?.packBonus || 0);
}
export function canFit(bag, cap, key) {
  const d = ITEMS[key];
  if (!d) return false;
  return bagUsed(bag) + d.s <= cap;
}

// ---------- 战利品 ----------

/** 该容器类型在某深度是否可能出现 */
export function containerAllowed(type, depth) {
  const t = CONTAINERS[type];
  if (!t) return false;
  return t.minDepth == null || depth >= t.minDepth;
}

/** 按深度权重掷一条物品。返回 key 或 null */
export function rollItem(rng, weights, depth) {
  const r = rng.weightedIndex(weights);
  if (r < 0) return null;
  const pool = Object.keys(ITEMS).filter(k => ITEMS[k].r === r && ITEMS[k].deep <= depth);
  if (!pool.length) {
    // 该稀有度在当前深度无物品，向下沉一档
    for (let rr = r - 1; rr >= 0; rr--) {
      const p2 = Object.keys(ITEMS).filter(k => ITEMS[k].r === rr && ITEMS[k].deep <= depth);
      if (p2.length) return rng.pick(p2);
    }
    return null;
  }
  return rng.pick(pool);
}

/** 生成一个容器的战利品列表 */
export function rollLoot(rng, type, depth) {
  const t = CONTAINERS[type];
  if (!t) return [];
  const n = t.n[0] + Math.floor(rng.f() * (t.n[1] - t.n[0] + 1));
  const items = [];
  for (let i = 0; i < n; i++) {
    const k = rollItem(rng, t.w, depth);
    if (k) items.push({ kind: 'item', key: k });
  }
  for (const [kind, p] of Object.entries(t.extras || {})) {
    if (!rng.chance(p)) continue;
    switch (kind) {
      case 'ammo': case 'ammo2': case 'ammo3': {
        const type2 = rng.pick(Object.keys(AMMO));
        items.push({ kind: 'ammo', type: type2, n: AMMO[type2].box });
        break;
      }
      case 'med': items.push({ kind: 'med', n: 1 }); break;
      case 'med2': items.push({ kind: 'med', n: 2 }); break;
      case 'nade': items.push({ kind: 'nade', n: 1 + (rng.chance(0.3) ? 1 : 0) }); break;
      case 'gun': {
        const g = rng.pick(['harpoon', 'reef', 'trench', 'breacher', 'longfin']);
        items.push({ kind: 'gun', key: g, mag: GUNS[g].mag });
        break;
      }
      case 'suit': {
        // 明确分成「潜水服」与「头盔」两张表，避免靠字段形状去猜
        if (rng.chance(0.6)) {
          const it = rng.pick([SUITS[2], SUITS[3]]);
          items.push({ kind: 'suit', id: it.id, cur: Math.round(it.dur * (0.5 + rng.f() * 0.5)) });
        } else {
          const it = rng.pick([HELMS[1], HELMS[2]]);
          items.push({ kind: 'helm', id: it.id, cur: Math.round(it.dur * (0.5 + rng.f() * 0.5)) });
        }
        break;
      }
    }
  }
  return items;
}

// ---------- 结算 ----------
// 与参考作最大的结构差异：装备耐久跨局保留 + 仓库 + 保险默认开启。
// 放弃行动退 30%（参考作退 0，是陷阱按钮）。

export function settle(profile, raid, loadout) {
  const cost = loadoutCost(loadout) || 0;
  const out = raid.outcome;
  const secs = Math.max(0, Math.round(raid.secs || 0));
  const extracted = out === 'extracted';
  const dead = out === 'killed' || out === 'mia';

  // 深度系数：取本局最深抵达深度
  const scale = depthValueScale(raid.maxDepth || 0);
  // 拆成 haul / bonus 两项再相加，而不是先算总值。
  // 结算面板要把这笔钱逐项列给玩家看（战利品、深度加成、撤离奖金），
  // 拆分必须发生在这里 —— 让 UI 拿返回值自己重算一遍，就等于把
  // 经济公式抄了第二份，迟早会跟本体对不上。
  const haul = extracted ? haulValue(raid.items, raid.guns, scale) : 0;
  const bonus = extracted ? EXTRACT_BONUS : 0;
  const value = haul + bonus;
  const refund = dead && loadout.insured !== false ? Math.round(cost * INSURANCE)
    : out === 'abandon' ? Math.round(cost * ABANDON_REFUND) : 0;

  const kills = clamp(raid.kills | 0, 0, 80);
  profile.money += value + refund;
  profile.stats.raids = (profile.stats.raids || 0) + 1;
  profile.stats.kills = (profile.stats.kills || 0) + kills;
  if (extracted) profile.stats.extracts = (profile.stats.extracts || 0) + 1;
  else if (dead) profile.stats.deaths = (profile.stats.deaths || 0) + 1;
  profile.stats.bestHaul = Math.max(profile.stats.bestHaul || 0, value);
  profile.stats.totalHaul = (profile.stats.totalHaul || 0) + value;
  profile.stats.bestDepth = Math.max(profile.stats.bestDepth || 0, Math.round(raid.maxDepth || 0));

  // 撤离成功的物资进仓库（参考作没有仓库，带出即变现）。
  // 必须校验物品 key：客户端可以传任意字符串进来，不能让脏数据污染仓库。
  if (extracted) {
    profile.stash = profile.stash || [];
    for (const k of raid.items) if (ITEMS[k]) profile.stash.push(k);
  }

  let aid = 0;
  if (profile.money < MIN_MONEY) { aid = MIN_MONEY - profile.money; profile.money = MIN_MONEY; }

  profile.history = profile.history || [];
  profile.history.unshift({
    t: Date.now(), outcome: out, value, refund, cost, kills, secs, aid,
    depth: Math.round(raid.maxDepth || 0), name: raid.extractedVia || '',
  });
  profile.history = profile.history.slice(0, 20);
  // breakdown 给结算面板逐项显示用（见上面 haul/bonus 拆分的注释）。
  // 约定：haul + bonus === value，面板可以把它们当独立行渲染。
  return { value, refund, aid, scale, kills, cost, haul, bonus, outcome: out, lost: !extracted ? haulValue(raid.items, raid.guns, scale) : 0 };
}

export function newProfile(name = '潜水员') {
  return {
    name, money: 120000, created: Date.now(),
    stats: { raids: 0, extracts: 0, deaths: 0, kills: 0, bestHaul: 0, totalHaul: 0, bestDepth: 0 },
    stash: [], skills: {}, history: [],
  };
}

export { skillMods, angDiff, losClear, depthValueScale, RARITY };
