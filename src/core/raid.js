// 一局的状态机：配装 → 下潜 → 搜刮 → 交火 → 上浮 → 结算。
// 零 three、零 DOM：渲染层通过读 raid 的状态来画，AI/规则全在这里。
//
// 与参考作的结构差异：深度是这个世界的第三维，但它只改数值（压力/耗氧/价值），
// 不增加任何按键或移动复杂度，所以摄像机与 2D 命中判定完全不需要改。

import {
  GUNS, AMMO, ITEMS, SUITS, HELMS, DIFFICULTY, RAID_SECONDS, skillMods, loadoutCost, CONTAINERS,
  EXTRACT_RADIUS, ROLES,
} from './catalog.js';
import { Rng } from './rng.js';
import { Nav, collideCircle, losClear, terrainClear, angDiff } from './nav.js';
import {
  BODY, clamp, makeActorState, effCut, traceShot, applyDamage, updateVitals,
  bagUsed, packSlots, rollLoot, canFit, settle,
} from './rules.js';
import { spawnEnemy, updateEnemy, assignTokens, separate, gunNoise } from './ai.js';

const PICKUP_RADIUS = 1.9;
const PICKUP_CLOSE = 2.6;
const FIRE_HOLD = 7;

export class Raid {
  /**
   * @param {object} o
   * @param {object} o.world { colliders, heightAt, extracts, spawns, enemySpots, containerSpots, nav, half }
   * @param {object} o.loadout 配装
   * @param {number} o.seed 种子（决定世界随机：敌人装备、战利品内容、活跃减压舱）
   * @param {object} o.profile 存档（只读，用于技能）
   */
  constructor(o) {
    this.world = o.world;
    this.loadout = o.loadout;
    this.rng = new Rng(o.seed >>> 0);
    this.profile = o.profile || { skills: {} };
    this.mods = skillMods(this.profile.skills);
    this.diff = DIFFICULTY[o.loadout.difficulty] || DIFFICULTY.diver;
    this.nav = o.world.nav instanceof Nav ? o.world.nav : new Nav(o.world.nav, o.world.half * 2, o.world.half);
    this.colliders = o.world.colliders;

    this.time = RAID_SECONDS;
    this.elapsed = 0;
    this.frame = 0;
    this.over = false;
    this.outcome = null;
    this.kills = 0;
    this.maxDepth = 0;
    this.pings = [];

    // ---- 玩家 ----
    const lo = o.loadout;
    const g = GUNS[lo.gun] || GUNS.seacutter;
    const p = makeActorState({ suit: lo.suit, helm: lo.helm });
    p.name = '你';
    p.elapsed = 0;
    p.vx = 0; p.vz = 0;
    p.y = 0;
    p.sprint = false;
    p.stamina = 100;
    p.o2 = this.mods.o2Max;
    p.meds = Math.max(0, Math.min(4, lo.meds | 0));
    p.nades = 2 + this.mods.nadeBonus;
    p.nadeCd = 0;
    p.fireCd = 0; p.reload = 0; p.swap = 0; p.bloom = 0; p.heal = 0;
    p.bag = [];
    p.cap = packSlots(lo.pack, this.mods);
    p.slots = [{ key: lo.gun, mag: g.mag }, null, { key: 'seacutter', mag: GUNS.seacutter.mag }];
    p.cur = 0; p.last = 0;
    p.ammo = { [g.ammo]: g.mag * 4 + (lo.extraAmmo || 0) };
    for (const s of p.slots) if (s) { const gg = GUNS[s.key]; p.ammo[gg.ammo] = (p.ammo[gg.ammo] || 0) + s.mag; }
    p.insured = lo.insured !== false;
    this.player = p;

    // ---- 减压舱：6 选 3 ----
    const all = o.world.extracts.slice();
    this.rng.shuffle(all);
    this.extracts = all.slice(0, 3);

    // ---- 敌人 ----
    this.enemies = [];
    const sp = o.world.spawns[this.rng.int(0, o.world.spawns.length - 1)];
    p.x = sp.x; p.z = sp.z; p.y = o.world.heightAt(sp.x, sp.z);
    for (const s of o.world.enemySpots) {
      if (Math.hypot(s.x - sp.x, s.z - sp.z) < 45) continue;         // 出生点 45m 内不刷怪
      // ROLES 里标了 always 的兵种（监工卫队、Boss）必定刷新，不吃难度的 count 折扣
      const always = !!(ROLES[s.role] && ROLES[s.role].always) || s.always === true;
      if (always || this.rng.chance(this.diff.count)) this.enemies.push(spawnEnemy(this.rng, s, o.world));
    }

    // ---- 容器 ----
    this.containers = [];
    for (const c of o.world.containerSpots) {
      const depth = Math.max(0, -(o.world.heightAt(c.x, c.z)));
      if (c.type === 'vault' || c.type === 'hold') {
        if (depth < (CONTAINERS[c.type].minDepth || 0)) continue;      // 保险库/封死货舱限深度
      }
      this.containers.push({
        type: c.type, name: CONTAINERS[c.type].name, x: c.x, z: c.z, y: o.world.heightAt(c.x, c.z),
        items: rollLoot(this.rng, c.type, depth), searched: false, revealed: 0, revealT: 0,
      });
    }
    // 地面散落
    for (const s of o.world.lootSpots || []) {
      if (!this.rng.chance(0.4)) continue;
      const depth = Math.max(0, -(o.world.heightAt(s.x, s.z)));
      const items = this.rng.chance(0.12) ? [{ kind: 'med', n: 1 }]
        : this.rng.chance(0.2) ? (() => { const t = this.rng.pick(Object.keys(AMMO)); return [{ kind: 'ammo', type: t, n: AMMO[t].box }]; })()
        : (() => { const k = this.rollAtDepth(depth); return k ? [{ kind: 'item', key: k }] : []; })();
      if (!items.length) continue;
      this.containers.push({ type: 'loose', name: '散落物', x: s.x, z: s.z, y: o.world.heightAt(s.x, s.z), items, searched: false, revealed: items.length, loose: true, revealT: 0 });
    }

    this.nadeList = [];
    this.extractT = 0;
    this.inZone = null;
    this.lootOpen = null;
    this.events = [];        // 供渲染层消费的一次性事件（命中、拾取、击杀…）
  }

  rollAtDepth(depth) {
    const w = [50, 30, 14, 5, 1, 0.3];
    const r = this.rng.weightedIndex(w);
    if (r < 0) return null;
    const pool = Object.keys(ITEMS).filter(k => ITEMS[k].r === r && ITEMS[k].deep <= depth);
    if (!pool.length) return null;
    return this.rng.pick(pool);
  }

  // ---------------- 主循环 ----------------
  update(dt, input) {
    if (this.over) return;
    this.elapsed += dt;
    this.time -= dt;
    this.player.elapsed = this.elapsed;
    this.frame++;
    if (this.time <= 0) { this.time = 0; return this.end('mia'); }

    this.updatePlayer(dt, input);
    this.updateVitalsAndNades(dt);

    if (this.frame % 6 === 0) assignTokens(this, this.player);
    for (const e of this.enemies) updateEnemy(e, this, dt);
    separate(this);

    this.updateContainers(dt);
    this.updateExtract(dt);
    this.pings = this.pings.filter(g => (g.t -= dt) > 0);
    if (this.player.dead) this.end('killed');
  }

  // ---------------- 玩家 ----------------
  updatePlayer(dt, inp) {
    const p = this.player;
    if (p.dead) return;
    const g = GUNS[this.curGun().key];

    // 相机相对移动
    let mx = 0, mz = 0;
    if (inp) {
      if (inp.keys.KeyW) mz -= 1;
      if (inp.keys.KeyS) mz += 1;
      if (inp.keys.KeyA) mx -= 1;
      if (inp.keys.KeyD) mx += 1;
    }
    const yaw = this.camYaw ?? Math.PI / 4;
    let wx = mx * Math.cos(yaw) + mz * Math.sin(yaw);
    let wz = -mx * Math.sin(yaw) + mz * Math.cos(yaw);
    const ml = Math.hypot(wx, wz);
    if (ml > 0) { wx /= ml; wz /= ml; }

    const fwdDot = wx * Math.sin(p.angle) + wz * Math.cos(p.angle);
    const wantSprint = !!(inp && inp.keys.ShiftLeft) && ml > 0 && fwdDot > 0.3
      && p.stamina > 5 && !inp.ads && p.heal <= 0 && p.reload <= 0;
    p.sprint = wantSprint;

    // 冲刺吃武器移速系数（参考作写死 7.0，M249 反而比 G17 快）
    let speed = wantSprint ? 7.0 * g.move : 4.4 * g.move;
    if (inp && inp.ads) speed *= 0.58;
    if (p.heal > 0) speed *= 0.5;
    if (fwdDot < -0.3) speed *= 0.82;

    const acc = 1 - Math.exp(-dt * 12);
    p.vx += (wx * speed - p.vx) * acc;
    p.vz += (wz * speed - p.vz) * acc;
    p.stamina = clamp(p.stamina + (wantSprint ? -20 : 14) * dt, 0, 100);

    p.x += p.vx * dt; p.z += p.vz * dt;
    const c = { x: p.x, z: p.z };
    collideCircle(c, p.r, this.colliders);
    p.x = c.x; p.z = c.z;
    p.y = this.world.heightAt(p.x, p.z);
    this.maxDepth = Math.max(this.maxDepth, Math.max(0, -p.y));

    // 朝向 = 瞄准点
    if (inp && inp.aim) {
      const dx = inp.aim.x - p.x, dz = inp.aim.z - p.z;
      if (Math.hypot(dx, dz) > 0.6) {
        const want = Math.atan2(dx, dz);
        p.angle += angDiff(want, p.angle) * Math.min(1, dt * 14);
      }
    }

    // 射击
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.bloom = Math.max(0, p.bloom - 4.5 * dt);
    p.swap = Math.max(0, p.swap - dt);
    if (p.reload > 0) {
      p.reload -= dt;
      if (p.reload <= 0) {
        const gg = GUNS[this.curGun().key];
        const need = gg.mag - this.curGun().mag;
        const have = p.ammo[gg.ammo] || 0;
        const take = Math.min(need, have);
        this.curGun().mag += take;
        p.ammo[gg.ammo] = have - take;
      }
    }
    if (p.heal > 0) {
      p.heal -= dt;
      if (p.heal <= 0) {
        p.hp = Math.min(p.maxHp, p.hp + 45);
        p.meds--;
        this.events.push({ k: 'healed' });
      }
    }
    p.nadeCd = Math.max(0, p.nadeCd - dt);

    if (!inp) return;
    if (inp.pressed.KeyH) this.startHeal();
    if (inp.pressed.KeyG && !this.lootOpen && p.nades > 0 && p.nadeCd <= 0) {
      p.nades--; p.nadeCd = 0.9;
      const ax = inp.aim ? inp.aim.x : p.x, az = inp.aim ? inp.aim.z : p.z;
      this.spawnNade(p, p.x, p.y + 1.6, p.z, ax, az);
    }
    if (inp.pressed.KeyR) this.startReload();
    for (let i = 0; i < 3; i++) if (inp.pressed['Digit' + (i + 1)]) this.switchSlot(i);
    if (inp.pressed.KeyE) this.interact();
    if (inp.pressed.KeyF && this.lootOpen) this.takeAll();

    const trigger = g.auto ? inp.mouse : inp.clicked;
    if (trigger && !this.lootOpen && !p.sprint && p.swap <= 0 && p.reload <= 0 && p.fireCd <= 0) {
      if (p.heal > 0) { p.heal = 0; this.events.push({ k: 'healCancel' }); }
      this.playerFire(g);
    }
  }

  curGun() { return this.player.slots[this.player.cur]; }

  startReload() {
    const p = this.player;
    const s = this.curGun(); if (!s) return;
    const gg = GUNS[s.key];
    if (p.reload > 0 || s.mag >= gg.mag) return;
    if ((p.ammo[gg.ammo] || 0) <= 0) return;
    p.reload = gg.reload * this.mods.reloadMul;
    p.heal = 0;
  }

  switchSlot(i) {
    const p = this.player;
    if (i === p.cur || !p.slots[i]) return;
    p.last = p.cur; p.cur = i; p.reload = 0; p.swap = 0.45 * this.mods.reloadMul; p.heal = 0;
  }

  startHeal() {
    const p = this.player;
    if (p.meds <= 0 || p.hp >= p.maxHp || p.heal > 0) return;
    p.heal = 3;
  }

  playerFire(gun) {
    const p = this.player;
    const s = this.curGun();
    if (s.mag <= 0) {
      if ((p.ammo[gun.ammo] || 0) > 0) this.startReload();
      return;
    }
    s.mag--;
    p.fireCd = 60 / gun.rpm;
    const moving = Math.hypot(p.vx, p.vz) / 4.4;
    let spread = (gun.spread * (1 + moving * 0.9) + p.bloom) * this.mods.spreadMul;
    if (this.aiming) spread *= gun.scope ? 0.08 : 0.45;
    p.bloom = Math.min(gun.spread * 2.2 + 2, p.bloom + gun.kick * 0.9);
    this.fireBullet(p, gun, p.x, p.y + 1.5, p.z, p.angle, spread, true);
    gunNoise(this, p.x, p.z, gun);
  }

  /** 唯一的开火入口：玩家、敌人、爆炸都走这里 */
  fireBullet(shooter, gun, ox, oy, oz, ang, spreadDeg, byPlayer) {
    const dx = Math.sin(ang), dz = Math.cos(ang);
    const targets = byPlayer ? this.enemies : [this.player];
    const res = traceShot({
      ox, oy, oz, dx, dz, gun, targets, colliders: this.colliders, world: this.world,
      spreadDeg, rng: this.rng, dmgMul: byPlayer ? 1 : this.diff.dmg,
      suitBonus: byPlayer ? 0 : this.mods.suitCut,
    });
    for (const p of res.pellets) {
      if (p.kind === 'actor') {
        const dealt = applyDamage(p.actor, p.dmg, p.head, {
          byPlayer, now: this.elapsed,
          suitBonus: byPlayer ? 0 : this.mods.suitCut,
        });
        this.events.push({ k: 'hit', x: p.actor.x, y: p.actor.y + 1.2, z: p.actor.z, head: p.head, dealt, byPlayer });
        if (p.actor.dead) this.killEnemy(p.actor, byPlayer);
        if (!byPlayer) {
          this.pings.push({ x: ox, z: oz, t: 2.5 });
          this.events.push({ k: 'hurt', from: { x: ox, z: oz } });
        }
      } else if (p.kind === 'wall' || p.kind === 'ground') {
        this.events.push({ k: p.kind, x: p.x, y: p.y, z: p.z, nx: p.nx, nz: p.nz });
      }
    }
    this.events.push({ k: 'shot', x: ox, y: oy, z: oz, ang, byPlayer, snd: gun.snd });
    return res;
  }

  killEnemy(e, byPlayer) {
    e.dead = true; e.deadT = 0;
    if (byPlayer) this.kills++;
    // 尸体变成可搜容器
    const items = [{ kind: 'gun', key: e.gun, mag: e.mag }];
    const gd = GUNS[e.gun];
    items.push({ kind: 'ammo', type: gd.ammo, n: Math.round(AMMO[gd.ammo].box * (0.6 + this.rng.f() * 0.8)) });
    if (e.meds) items.push({ kind: 'med', n: e.meds });
    if (e.nades) items.push({ kind: 'nade', n: e.nades });
    const n = e.boss ? 3 : (this.rng.chance(0.6) ? 1 : 0);
    const w = e.boss ? [0, 0, 20, 40, 28, 12] : [45, 35, 15, 4, 1, 0];
    for (let i = 0; i < n; i++) {
      const k = this.rollAtDepth(Math.max(0, -e.y));
      if (k) items.push({ kind: 'item', key: k });
    }
    if (e.suit.lvl >= 2 && e.suit.cur > 5) items.push({ kind: 'suit', id: e.suit.id, cur: Math.round(e.suit.cur) });
    if (e.helm.lvl >= 2 && e.helm.cur > 5) items.push({ kind: 'helm', id: e.helm.id, cur: Math.round(e.helm.cur) });
    this.containers.push({ type: 'body', name: e.name + ' 的装备', x: e.x, z: e.z, y: e.y, items, searched: false, revealed: 0, revealT: 0 });
    this.events.push({ k: 'kill', x: e.x, y: e.y, z: e.z, name: e.name, boss: e.boss });
  }

  spawnNade(owner, ox, oy, oz, tx, tz) {
    this.nadeList.push({ x: ox, y: oy, z: oz, tx, tz, t: 0, fuse: 1.6, byPlayer: owner === this.player });
  }

  updateVitalsAndNades(dt) {
    // 减压舱内不吃压力伤害：舱内会平衡压强。
    // 这里直接重新判定，不依赖 updateExtract 的执行顺序。
    const p = this.player;
    p.pressureSafe = this.extracts.some(e => Math.hypot(e.x - p.x, e.z - p.z) < EXTRACT_RADIUS);
    updateVitals(p, dt, this.mods, this.diff);
    for (let i = this.nadeList.length - 1; i >= 0; i--) {
      const n = this.nadeList[i];
      n.t += dt;
      // 简易抛物线插值
      const k = Math.min(1, n.t / n.fuse);
      n.x += (n.tx - n.x) * Math.min(1, dt * 6);
      n.z += (n.tz - n.z) * Math.min(1, dt * 6);
      if (k >= 1) {
        this.explode(n.x, n.y, n.z, n.byPlayer);
        this.nadeList.splice(i, 1);
      }
    }
  }

  explode(x, y, z, byPlayer) {
    const R = 3.6 * this.mods.nadeRadius;
    const targets = byPlayer ? this.enemies : [this.player];
    for (const a of targets) {
      if (a.dead) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > R) continue;
      const falloff = 1 - d / R;
      const dealt = applyDamage(a, 95 * falloff, false, { byPlayer, now: this.elapsed, explosive: true, suitBonus: byPlayer ? 0 : this.mods.suitCut });
      this.events.push({ k: 'boom', x, y, z, r: R, byPlayer });
      if (a.dead) this.killEnemy(a, byPlayer);
      else this.events.push({ k: 'hit', x: a.x, y: a.y + 1.2, z: a.z, head: false, dealt, byPlayer });
    }
  }

  // ---------------- 容器 ----------------
  nearestContainer() {
    const p = this.player;
    let best = null, bd = PICKUP_RADIUS;
    for (const c of this.containers) {
      if (c.searched) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  interact() {
    if (this.lootOpen) { this.lootOpen = null; return; }
    const c = this.nearestContainer();
    if (!c) return;
    this.lootOpen = c;
    if (c.loose) { c.searched = true; c.revealed = c.items.length; return; }
    if (c.revealed === 0) c.revealT = 0.4;
  }

  updateContainers(dt) {
    const p = this.player;
    if (this.lootOpen) {
      const c = this.lootOpen;
      if (c.searched || Math.hypot(c.x - p.x, c.z - p.z) > PICKUP_CLOSE) this.lootOpen = null;
      else {
        c.revealT -= dt;
        if (c.revealT <= 0 && c.revealed < c.items.length) {
          const it = c.items[c.revealed];
          c.revealed++;
          const rare = it.kind === 'item' ? (ITEMS[it.key]?.r ?? 0) : 0;
          c.revealT = (it.kind === 'item' ? 0.3 + rare * 0.22 : 0.3) / this.mods.revealSpeed;
          this.events.push({ k: 'reveal', rare, name: it.kind === 'item' ? ITEMS[it.key]?.name : it.kind });
          if (rare >= 4) this.events.push({ k: 'rareBanner', rare });
          if (c.revealed >= c.items.length) c.searched = true;
        }
      }
    }
  }

  take(c, i) {
    const it = c.items[i];
    if (i >= c.revealed || !it) return false;
    const p = this.player;
    switch (it.kind) {
      case 'item': {
        if (!canFit(p.bag, p.cap, it.key)) { this.events.push({ k: 'toast', text: '背囊装不下了' }); return false; }
        p.bag.push(it.key);
        this.events.push({ k: 'take', name: ITEMS[it.key].name, rare: ITEMS[it.key].r });
        return true;
      }
      case 'ammo': p.ammo[it.type] = (p.ammo[it.type] || 0) + it.n; return true;
      case 'med': p.meds += it.n; return true;
      case 'nade': p.nades += it.n; return true;
      case 'gun': {
        // 换下当前主武器，旧的放回容器同一位置
        const slot = !p.slots[0] ? 0 : !p.slots[1] ? 1 : (p.cur === 2 ? 0 : p.cur);
        const old = p.slots[slot];
        p.slots[slot] = { key: it.key, mag: it.mag };
        c.items[i] = old ? { kind: 'gun', key: old.key, mag: old.mag } : null;
        if (!c.items[i]) c.items.splice(i, 1);
        this.switchSlot(slot);
        return true;
      }
      case 'suit': {
        const oldLvl = p.suit.lvl;
        if (oldLvl > 0 && it.cur <= p.suit.cur) return false;      // 不允许用更破的换
        const old = { kind: 'suit', id: p.suit.id, cur: Math.round(p.suit.cur) };
        p.suit = { ...(SUITS.find(s => s.id === it.id) || p.suit), cur: it.cur };
        if (oldLvl > 0) c.items[i] = old; else c.items.splice(i, 1);
        this.events.push({ k: 'equip', what: '潜水服' });
        return true;
      }
      case 'helm': {
        const oldLvl = p.helm.lvl;
        if (oldLvl > 0 && it.cur <= p.helm.cur) return false;
        const old = { kind: 'helm', id: p.helm.id, cur: Math.round(p.helm.cur) };
        p.helm = { ...(HELMS.find(h => h.id === it.id) || p.helm), cur: it.cur };
        if (oldLvl > 0) c.items[i] = old; else c.items.splice(i, 1);
        this.events.push({ k: 'equip', what: '头盔' });
        return true;
      }
    }
    return false;
  }

  takeAll() {
    const c = this.lootOpen;
    if (!c) return;
    // 补给优先，再按价值降序拿值钱货（参考作同款策略）
    const order = [];
    for (let i = 0; i < c.revealed; i++) {
      const it = c.items[i];
      if (it.kind === 'item') order.push([i, it]);
    }
    order.sort((a, b) => (ITEMS[b[1].key]?.v || 0) - (ITEMS[a[1].key]?.v || 0));
    for (let i = 0; i < c.revealed; i++) {
      const it = c.items[i];
      if (it.kind !== 'item') this.take(c, i);
    }
    for (const [i] of order) this.take(c, i);
  }

  // ---------------- 撤离 ----------------
  updateExtract(dt) {
    const p = this.player;
    if (p.dead) { this.extractT = 0; this.inZone = null; return; }
    const zone = this.extracts.find(e => Math.hypot(e.x - p.x, e.z - p.z) < EXTRACT_RADIUS);
    if (zone) {
      if (this.extractT === 0) this.events.push({ k: 'beep' });
      const before = Math.floor(this.extractT);
      this.extractT += dt;
      if (Math.floor(this.extractT) !== before) this.events.push({ k: 'beep' });
      this.inZone = zone;
      // 减压舱补氧
      p.o2 = Math.min(this.mods.o2Max, p.o2 + 14 * dt);
      if (this.extractT >= this.mods.holdTime) this.end('extracted');
    } else if (this.extractT > 0) {
      this.extractT = 0; this.inZone = null;
    }
  }

  end(outcome) {
    if (this.over) return;
    this.over = true;
    this.outcome = outcome;
    this.secs = this.elapsed;
    this.items = this.player.bag.slice();
    this.guns = outcome === 'extracted'
      ? this.player.slots.filter(Boolean).map(s => s.key).filter(k => k !== 'seacutter')
      : [];
    this.extractedVia = outcome === 'extracted' && this.inZone ? this.inZone.name : '';
    this.events.push({ k: 'end', outcome });
  }

  /** 结算并写回存档。渲染层拿到返回值后画结算面板。 */
  finalize(profile) {
    return settle(profile, this, this.loadout);
  }

  // 便于调试/HUD 读
  stats() {
    const p = this.player;
    return {
      time: this.time, depth: Math.max(0, -p.y), maxDepth: this.maxDepth,
      o2: p.o2, o2Max: this.mods.o2Max, hp: p.hp, stamina: p.stamina,
      suit: effCut(p.suit, this.mods.suitCut), suitCur: p.suit.cur, suitDur: p.suit.dur,
      helm: effCut(p.helm), helmCur: p.helm.cur, helmDur: p.helm.dur,
      bagUsed: bagUsed(p.bag), cap: p.cap, kills: this.kills,
      alive: this.enemies.filter(e => !e.dead).length,
      extractT: this.extractT, holdTime: this.mods.holdTime,
      enemiesSeeing: this.enemies.filter(e => !e.dead && e.sees).length,
    };
  }
}

export { PICKUP_RADIUS, PICKUP_CLOSE, FIRE_HOLD, loadoutCost, losClear, terrainClear, BODY };
