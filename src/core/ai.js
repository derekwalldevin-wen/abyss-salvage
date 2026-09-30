// 敌人 AI：巡逻/搜索/追击/交火 四态机 + 开火令牌 + 现算掩体 + 深度减速。
// 零 three、零 DOM。
//
// 保留参考作三样最聪明的设计：
// 1) 开火令牌：同一时刻每个目标只允许 N 个敌人开火。把"被八人集火"变成"被两人压制"，
//    这是用一行代码换难度曲线的典范。
// 2) 掩体现算：不预烘焙掩体点，而是在需要时于半径环上采样，要求"对目标不可见"且"紧贴碰撞体"。
// 3) 班组呼叫：看到玩家的敌人会提醒 18m 内的同伴。
//
// 新增：敌人在深水区被憋气减速（>30m 时 -25%）。深度因此同时是风险和掩护。

import { ROLES, GUNS, SUITS, HELMS } from './catalog.js';
import { losClear, terrainClear, angDiff, collideCircle, nearColliders } from './nav.js';
import { applyDamage, effCut, clamp } from './rules.js';

const SPEED = {
  patrol: 1.5, search: 2.0, hunt: 3.3, combat: 2.1, cover: 3.8, retreat: 3.2, panic: 4.8,
};
const FOV = 1.1;              // ±63° → 约 126° 视野锥
const CLOSE_SENSE = 7;        // 贴脸感知
const SQUAD_RADIUS = 18;      // 班组呼叫半径
const DEEP_SLOW_DEPTH = 30;
const DEEP_SLOW = 0.75;

export function spawnEnemy(rng, spot, world) {
  const def = ROLES[spot.role] || ROLES.guard;
  const y = world.heightAt(spot.x, spot.z);
  const gun = rng.pick(def.guns);
  const gd = GUNS[gun];
  const suit = SUITS[rng.int(def.suits[0], def.suits[def.suits.length - 1])]
    || SUITS[rng.int(0, SUITS.length - 1)];
  const helm = HELMS[rng.int(def.helms[0], def.helms[def.helms.length - 1])]
    || HELMS[rng.int(0, HELMS.length - 1)];
  const e = {
    role: spot.role, def, name: def.name, boss: !!def.boss, static: !!def.static,
    always: !!(def.always || spot.always), floor: spot.floor || null, zone: spot.zone || '',
    x: spot.x + (rng.f() - 0.5), z: spot.z + (rng.f() - 0.5), y,
    vx: 0, vz: 0, angle: rng.range(0, Math.PI * 2),
    hp: def.hp, maxHp: def.hp,
    suit: { ...suit, cur: suit.dur }, helm: { ...helm, cur: helm.dur },
    r: def.boss ? 0.5 : 0.42,
    gun, mag: gd.mag, reload: 0, fireCd: rng.range(0, 0.6),
    burst: 0, burstPause: 0,
    state: 'patrol', path: null, pi: 0, repathT: 0, waitT: 0,
    home: { x: spot.x, z: spot.z }, homeR: spot.r ?? rng.range(1, 12),
    alert: 0, lastSeen: null, lastSeenT: -99, sees: false, seeT: 0,
    perceiveT: rng.range(0, 0.18), react: 0, reactT: 0,
    strafe: rng.sign(), strafeT: 0,
    coverPt: null, coverCd: rng.range(0, 2), coverT: 0,
    meds: rng.chance(0.5) ? 1 : 0, heal: 0, retreat: false,
    nades: (spot.role === 'foreman' || spot.role === 'gunner' || spot.role === 'anchor') ? 2 : (rng.chance(0.4) ? 1 : 0),
    nadeCd: 4,
    token: false,
    hurtT: -99, dead: false, deadT: 0,
    stepT: 0, stuckT: 0, lastX: 0, lastZ: 0,
    searchT: 0, tDist: 999,
  };
  if (def.boss) { e.hp = e.maxHp = def.hp; }
  return e;
}

/** 每 6 帧重算一次开火令牌：每个目标只放行最近的 N 个射手 */
export function assignTokens(raid, player) {
  const N = raid.diff.tokens;
  const live = raid.enemies.filter(e => !e.dead);
  // 看得见的按距离排序，看不见的清掉令牌（避免残留令牌让敌人复活瞬间无冷却开火）
  for (const e of live) if (!e.sees) e.token = false;
  const seers = live.filter(e => e.sees)
    .sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z));
  for (let i = 0; i < seers.length; i++) seers[i].token = i < N;
}

function alertSquad(raid, e, x, z, sure) {
  for (const o of raid.enemies) {
    if (o === e || o.dead) continue;
    if (Math.hypot(o.x - e.x, o.z - e.z) > SQUAD_RADIUS) continue;
    if (o.alert < 0.5 && !o.sees) {
      o.alert = Math.max(o.alert, 0.7);
      o.lastSeen = { x, z };
      o.lastSeenT = raid.elapsed;
      if (sure) o.angle = Math.atan2(x - o.x, z - o.z);
    }
  }
}

/** 枪声传播：把半径内的敌人全部惊动 */
export function gunNoise(raid, x, z, gun) {
  const loud = (gun.snd === 'pistol' || gun.snd === 'smg' ? 26 : 40) * raid.diff.loud * raid.mods.noiseMul;
  for (const e of raid.enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - x, e.z - z);
    if (d > loud) continue;
    const jitter = d * 0.1;
    e.alert = 1;
    e.lastSeen = { x: x + (Math.random() - 0.5) * jitter, z: z + (Math.random() - 0.5) * jitter };
    e.lastSeenT = raid.elapsed;
    if (e.state === 'patrol') e.state = 'hunt';
  }
}

/** 现算掩体点：在半径 2~8m 环上采 16 点，要求对目标不可见且紧贴碰撞体 */
export function findCover(e, raid, tx, tz) {
  const nav = raid.nav;
  let best = null, bestCost = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + raid.rng.f() * 0.3;
    const r = 2 + raid.rng.f() * 6;
    const x = e.x + Math.sin(a) * r, z = e.z + Math.cos(a) * r;
    if (!nav.walkableAt(x, z)) continue;
    if (losClear(raid.colliders, tx, tz, x, z)) continue;         // 必须对目标隐藏
    let near = false;
    for (const c of nearColliders(raid.colliders, x - 1.3, z - 1.3, x + 1.3, z + 1.3)) {
      if (c.water) continue;
      if (x > c.x0 - 1.3 && x < c.x1 + 1.3 && z > c.z0 - 1.3 && z < c.z1 + 1.3) { near = true; break; }
    }
    if (!near) continue;
    const cost = Math.hypot(x - e.x, z - e.z) + 0.15 * Math.hypot(x - tx, z - tz);
    if (cost < bestCost) { bestCost = cost; best = { x, z }; }
  }
  return best;
}

function moveToward(e, raid, tx, tz, speed, dt) {
  const dx = tx - e.x, dz = tz - e.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.01) return;
  const wx = dx / L, wz = dz / L;
  // 深水减速：深处敌人自己也在憋气
  const depth = Math.max(0, -(raid.world.heightAt(e.x, e.z)));
  const slow = depth > DEEP_SLOW_DEPTH ? DEEP_SLOW : 1;
  const acc = 1 - Math.exp(-dt * 10);
  e.vx += (wx * speed * slow - e.vx) * acc;
  e.vz += (wz * speed * slow - e.vz) * acc;
}

function followPath(e, raid, speed, dt) {
  if (!e.path || e.pi >= e.path.length) return false;
  const wp = e.path[e.pi];
  const d = Math.hypot(wp.x - e.x, wp.z - e.z);
  if (d < 0.5) { e.pi++; return e.pi < e.path.length; }
  moveToward(e, raid, wp.x, wp.z, speed, dt);
  return true;
}

export function updateEnemy(e, raid, dt) {
  const player = raid.player;

  if (e.dead) { e.deadT += dt; return; }

  // ---------- 感知（5.5~8.3Hz） ----------
  e.perceiveT -= dt;
  if (e.perceiveT <= 0) {
    e.perceiveT = 0.12 + raid.rng.f() * 0.06;
    const dx = player.x - e.x, dz = player.z - e.z;
    const dist = Math.hypot(dx, dz);
    const face = Math.atan2(dx, dz);
    const inFov = Math.abs(angDiff(e.angle, face)) < FOV;
    let view = e.def.view * raid.diff.view;
    if (player.sprint) view *= 1.1;                       // 冲刺更容易被发现
    const could = !player.dead && raid.elapsed > raid.diff.grace && dist < view
      && (inFov || dist < CLOSE_SENSE || (e.alert > 0.5 && dist < view * 0.8));
    const wasSeeing = e.sees;
    e.sees = !!could
      && losClear(raid.colliders, e.x, e.z, player.x, player.z)
      && terrainClear(raid.world.heightAt, e.x, e.z, e.y + 1.5, player.x, player.z, player.y + 1.3);

    if (e.sees) {
      e.lastSeen = { x: player.x, z: player.z };
      e.lastSeenT = raid.elapsed;
      e.alert = 1;
      if (e.state !== 'combat') {
        // 首次锁定时的反应时间；已在交火中则重新锁定更快
        e.react = e.def.react * (e.alert > 0.9 ? 0.75 : 1.2) * (0.9 + raid.rng.f() * 0.6) + raid.diff.react;
        e.state = 'combat';
      }
      if (!wasSeeing) alertSquad(raid, e, player.x, player.z, false);
      e.searchT = 0;
    } else {
      e.seeT += 0.15;
    }
  }
  if (e.sees) e.seeT += dt; else e.seeT = 0;
  e.alert = Math.max(0, e.alert - 0.01 * dt);
  e.react = Math.max(0, e.react - dt);

  // ---------- 撤退与治疗 ----------
  if (!e.retreat && e.hp < e.maxHp * 0.35 && e.meds > 0) e.retreat = true;
  if (e.heal > 0) {
    e.heal -= dt;
    if (e.heal <= 0) { e.hp = Math.min(e.maxHp, e.hp + 50); e.meds--; e.retreat = false; }
  }

  // ---------- 状态机 ----------
  const dist = Math.hypot(player.x - e.x, player.z - e.z);
  e.tDist = dist;
  let speed = SPEED[e.state] || 2;

  switch (e.state) {
    case 'patrol': {
      if (e.sees) break;
      if (!e.static) {
        if (e.waitT > 0) { e.waitT -= dt; }
        else if (!followPath(e, raid, speed, dt)) {
          e.waitT = 2 + raid.rng.f() * 4;
          const a = raid.rng.f() * Math.PI * 2, r = raid.rng.f() * e.homeR;
          const tx = e.home.x + Math.sin(a) * r, tz = e.home.z + Math.cos(a) * r;
          e.path = raid.nav.find(e.x, e.z, tx, tz, 3000);
          e.pi = 0;
        }
      } else {
        // 观察哨原地扫视（按 dt 缩放，避免参考作那种帧率相关的转速）
        e.angle += Math.sin(raid.elapsed * 0.4 + e.home.z) * 1.08 * dt;
      }
      break;
    }
    case 'search': {
      if (e.sees) break;
      e.searchT -= dt;
      if (e.searchT <= 0) { e.state = 'patrol'; e.path = null; break; }
      if (!followPath(e, raid, speed, dt)) {
        if (raid.rng.f() < dt * 0.8) {
          const a = raid.rng.f() * Math.PI * 2, r = 3 + raid.rng.f() * 6;
          const tx = e.x + Math.sin(a) * r, tz = e.z + Math.cos(a) * r;
          e.path = raid.nav.find(e.x, e.z, tx, tz, 2500);
          e.pi = 0;
        }
        e.angle += Math.sin(raid.elapsed * 1.3 + e.home.x) * 1.08 * dt;
      }
      break;
    }
    case 'hunt': {
      if (e.sees) { e.state = 'combat'; break; }
      e.repathT -= dt;
      if (!e.lastSeen) { e.state = 'search'; e.searchT = 5; break; }
      if (e.static) { e.state = 'search'; e.searchT = 5; break; }
      if (e.repathT <= 0 || !e.path) {
        e.repathT = 2;
        e.path = raid.nav.find(e.x, e.z, e.lastSeen.x, e.lastSeen.z, 3000);
        e.pi = 0;
        if (!e.path) { e.state = 'search'; e.searchT = 5; break; }
      }
      speed = SPEED.hunt;
      if (!followPath(e, raid, speed, dt)) {
        // 到了最后已知位置还没人 → 转搜索
        e.state = 'search'; e.searchT = 6 + raid.rng.f() * 4; e.path = null;
      }
      break;
    }
    case 'combat': {
      if (e.heal > 0) break;
      // 撤离/逃跑优先于交火
      if (e.retreat) { speed = SPEED.retreat; e.state = 'patrol'; e.retreat = false; break; }
      // 交火中却既看不见、也没有任何目标线索 → 转入搜索去扫视角。
      // 少了这一步，敌人会永远背对玩家僵在 combat 状态里（实测踩到过）。
      if (!e.sees && !e.lastSeen) { e.state = 'search'; e.searchT = 4; e.path = null; break; }

      // 掩体：换弹中、或 0.6s 内挨过打且血不满 80%
      const hurtRecently = raid.elapsed - e.hurtT < 0.6;
      if (!e.coverPt && e.coverCd <= 0 && !e.static
        && (e.reload > 0 || (hurtRecently && e.hp < e.maxHp * 0.8))) {
        e.coverPt = findCover(e, raid, player.x, player.z);
        if (e.coverPt) { e.coverCd = 5 + raid.rng.f() * 3; e.coverT = 2 + raid.rng.f() * 2; }
      }
      if (e.coverPt) {
        e.coverT -= dt;
        if (e.coverT <= 0 || !e.sees) { e.coverPt = null; }
        else { speed = SPEED.cover; moveToward(e, raid, e.coverPt.x, e.coverPt.z, speed, dt); }
      } else {
        // 侧向移动 + 视距内微调，不做无脑对冲
        e.strafeT -= dt;
        if (e.strafeT <= 0) { e.strafeT = 0.8 + raid.rng.f() * 1.2; e.strafe = raid.rng.sign(); }
        const gd = GUNS[e.gun];
        const want = gd.range * 0.5;
        const fx = Math.sin(e.angle), fz = Math.cos(e.angle);
        const rx = Math.cos(e.angle), rz = -Math.sin(e.angle);
        const toward = dist > want ? 0.7 : -0.5;
        const sx = (fx * toward + rx * e.strafe * 0.8) * speed;
        const sz = (fz * toward + rz * e.strafe * 0.8) * speed;
        const acc = 1 - Math.exp(-dt * 10);
        e.vx += (sx - e.vx) * acc; e.vz += (sz - e.vz) * acc;
      }
      e.coverCd = Math.max(0, e.coverCd - dt);
      break;
    }
  }

  // ---------- 卡住检测 ----------
  const moved = Math.hypot(e.x - e.lastX, e.z - e.lastZ);
  const spd = Math.hypot(e.vx, e.vz);
  if (spd > 0.3 && moved < spd * dt * 0.3) {
    e.stuckT += dt;
    if (e.stuckT > 0.8) { e.path = null; e.strafe *= -1; e.repathT = 0; e.stuckT = 0; }
  } else e.stuckT = 0;
  e.lastX = e.x; e.lastZ = e.z;

  // ---------- 应用位移与碰撞 ----------
  e.x += e.vx * dt; e.z += e.vz * dt;
  const p = { x: e.x, z: e.z };
  collideCircle(p, e.r, raid.colliders);
  e.x = p.x; e.z = p.z;
  e.y = raid.world.heightAt(e.x, e.z);

  // ---------- 朝向 ----------
  if (e.sees) {
    const want = Math.atan2(player.x - e.x, player.z - e.z);
    e.angle += angDiff(want, e.angle) * Math.min(1, dt * 7);
  } else if (spd > 0.4) {
    const want = Math.atan2(e.vx, e.vz);
    e.angle += angDiff(want, e.angle) * Math.min(1, dt * 4);
  }

  // ---------- 开火 ----------
  e.fireCd = Math.max(0, e.fireCd - dt);
  e.burstPause = Math.max(0, e.burstPause - dt);
  e.nadeCd = Math.max(0, e.nadeCd - dt);
  if (e.reload > 0) {
    e.reload -= dt;
    if (e.reload <= 0) e.mag = GUNS[e.gun].mag;
  }
  if (e.state === 'combat' && e.sees && !e.heal) {
    maybeThrowNade(e, raid, dist);
    const gd = GUNS[e.gun];
    const aimOk = Math.abs(angDiff(e.angle, Math.atan2(player.x - e.x, player.z - e.z))) < 0.2;
    if (e.token && e.react <= 0 && e.reload <= 0 && e.fireCd <= 0 && e.burstPause <= 0
      && aimOk && dist < gd.range * 1.4) {
      enemyFire(e, raid, gd, dist);
    }
  }

  // 脚步声（供听觉反馈）
  e.stepT -= dt;
  if (spd > 1 && e.stepT <= 0) { e.stepT = 1.6 / Math.max(1, spd); e.noisy = true; }
  else e.noisy = false;
}

function maybeThrowNade(e, raid, dist) {
  if (e.nades <= 0 || e.nadeCd > 0 || !e.lastSeen) return;
  if (dist <= 7 || dist > 26) return;
  if (raid.elapsed < raid.diff.grace + 5) return;
  const since = raid.elapsed - e.lastSeenT;
  if (since < 1.8 || since > 10) return;
  if (!raid.rng.chance(0.02 * 60 * 0.016)) return;      // ≈ 每帧 2%
  e.nades--; e.nadeCd = 12 + raid.rng.f() * 8;
  const err = 1.5 + dist * 0.08;
  raid.spawnNade(e, e.x, e.y + 1.6, e.z,
    e.lastSeen.x + (raid.rng.f() - 0.5) * err,
    e.lastSeen.z + (raid.rng.f() - 0.5) * err);
}

function enemyFire(e, raid, gd, dist) {
  if (e.mag <= 0) { e.reload = gd.reload * 1.1; e.mag = gd.mag; return; }
  e.mag--;
  e.fireCd = (60 / gd.rpm) * (gd.auto ? 1.8 : 1.7);

  const pSpeed = Math.hypot(raid.player.vx, raid.player.vz);
  let spread = (gd.spread * 3.0 * e.def.acc
    + pSpeed * 1.3                                   // 玩家横移要付代价
    + (e.seeT < 1.2 ? 3.5 : 0)                        // 刚暴露的 1.2 秒惩罚
    + dist * 0.03) * raid.diff.acc;
  if (gd.scope) spread = (0.9 + pSpeed * 0.5) * raid.diff.acc;
  e.seeT += 60 / gd.rpm;

  const lead = gd.scope ? 0.25 : 0.1;
  const tx = raid.player.x + raid.player.vx * lead;
  const tz = raid.player.z + raid.player.vz * lead;
  const ang = Math.atan2(tx - e.x, tz - e.z);
  raid.fireBullet(e, gd, e.x, e.y + 1.5, e.z, ang, spread, false);
}

/** 敌人之间的分离，避免叠在一起（O(n²)，74 个量级可接受） */
export function separate(raid) {
  const live = raid.enemies.filter(e => !e.dead);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const rr = a.r + b.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const push = (rr - d) * 0.5;
      const ux = dx / d, uz = dz / d;
      a.x -= ux * push; a.z -= uz * push;
      b.x += ux * push; b.z += uz * push;
    }
  }
}

export { SPEED, FOV, DEEP_SLOW_DEPTH, DEEP_SLOW };
