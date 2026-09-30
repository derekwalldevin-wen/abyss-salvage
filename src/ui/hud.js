// HUD 驱动层。index.html 里已经写好了全部 DOM，这里只负责把 raid 的状态
// 翻译成屏幕上的数字，**不做任何游戏逻辑判断**（那是 core/raid.js 的事）。
//
// 分成两半是有意的：
//   update()  每帧调用，但只在「值真的变了」时才写 DOM。
//             HUD 有 20 多个节点，每帧无条件写 textContent 会持续触发
//             样式重算，实测白占一截帧预算 —— 而且大多数帧里这些值根本没变。

import { GUNS, SUITS, HELMS, ITEMS, RARITY_COLOR, CONTAINERS } from '../core/catalog.js';
import { heightAt, HALF } from '../world/layout.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      timer: $('timer'), depth: $('depth'), haul: $('haul'), kills: $('kills'),
      o2fill: $('o2fill'), o2num: $('o2num'), o2mark: $('o2mark'), o2wrap: document.querySelector('.o2wrap'),
      hpb: $('hpb'), hpn: $('hpn'), arb: $('arb'), arn: $('arn'),
      hlb: $('hlb'), hln: $('hln'), stb: $('stb'), stn: $('stn'),
      suitName: $('suitName'), helmName: $('helmName'),
      meds: $('meds'), nades: $('nades'),
      wname: $('wname'), wmag: $('wmag'), wres: $('wres'), reloadbar: $('reloadbar'),
      threat: $('threat'), prompt: $('prompt'), center: $('center'),
      extract: $('extract'), extxt: $('extxt'), exfill: $('exfill'),
      feed: $('feed'), minimap: $('minimap'),
    };
    this.slots = [...document.querySelectorAll('.ws')];
    this.mm = this.el.minimap?.getContext('2d') || null;
    this.cache = {};        // 上一次写进去的值，用来跳过无意义的 DOM 写入
    this.feedItems = [];
    this.mmTick = 0;
  }

  show(on) { if (this.el.hud) this.el.hud.hidden = !on; }

  /** 同一帧内的多个 set 合并成一次写入 */
  _set(key, node, prop, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    if (node) node[prop] = value;
  }
  _text(key, node, value) { this._set(key, node, 'textContent', value); }
  _w(key, node, pct) { this._set(key, node, 'style', `width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%`); }

  // ---------------- 主更新 ----------------
  update(raid, input) {
    if (!raid) return;
    const s = raid.stats();
    const p = raid.player;

    // 倒计时
    const t = Math.max(0, s.time);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    this._text('timer', this.el.timer, `${mm}:${String(ss).padStart(2, '0')}`);
    this._set('timerHue', this.el.timer, 'style',
      `color:${t < 60 ? '#ff6b5a' : t < 180 ? '#ffd166' : '#cfe9ef'}`);

    // 深度：越深越冷色，一眼可读
    const d = Math.round(s.depth);
    this._text('depth', this.el.depth, String(d));
    this._set('depthHue', this.el.depthChip, 'style', `color:${depthHue(d)}`);

    // 气瓶
    this._w('o2', this.el.o2fill, (s.o2 / s.o2Max) * 100);
    this._text('o2n', this.el.o2num, String(Math.ceil(s.o2)));
    const low = s.o2 / s.o2Max < 0.25;
    this._set('o2low', this.el.o2wrap, 'className', 'o2wrap' + (low ? ' low' : ''));
    // 深度加压阈值刻度：O2_DEPTH_START 之前不额外消耗，过了就开始掉
    this._w('o2mark', this.el.o2mark, 26);

    // 生命 / 体力
    this._w('hp', this.el.hpb, s.hp);
    this._text('hpn', this.el.hpn, String(Math.ceil(s.hp)));
    this._w('st', this.el.stb, s.stamina);
    this._text('stn', this.el.stn, String(Math.ceil(s.stamina)));

    // 护甲：用「当前值/耐久上限」当血条，和耐久数字并排显示
    this._w('ar', this.el.arb, ratio(s.suitCur, s.suitDur));
    this._text('arn', this.el.arn, `${Math.ceil(s.suitCur)}/${Math.round(s.suitDur)}`);
    this._w('hl', this.el.hlb, ratio(s.helmCur, s.helmDur));
    this._text('hln', this.el.hln, `${Math.ceil(s.helmCur)}/${Math.round(s.helmDur)}`);
    // 名称直接读装备对象上的 name —— SUITS/HELMS 是数组，但玩家手上这件
    // 已经带着自己的 name 和 dur（mods 会改耐久），别去数组里反查。
    this._text('suit', this.el.suitName, p.suit.name);
    this._text('helm', this.el.helmName, p.helm.name);

    this._text('meds', this.el.meds, String(p.meds));
    this._text('nades', this.el.nades, String(p.nades));

    // 舱内价值
    this._text('haul', this.el.haul, fmtMoney(haulValue(p.bag)));

    // 武器
    const gun = raid.curGun();
    const gd = GUNS[gun.key];
    this._text('wname', this.el.wname, gd ? gd.name : '—');
    this._text('wmag', this.el.wmag, String(gun.mag));
    this._text('wres', this.el.wres, String(p.ammo[gd?.ammo] || 0));
    const reloading = p.reload > 0;
    this._set('rl', this.el.reloadbar, 'hidden', !reloading);
    if (reloading) this._w('rlf', this.el.reloadbar.firstElementChild, (1 - p.reload / (gd?.reload || 1)) * 100);
    for (let i = 0; i < this.slots.length; i++) {
      const has = !!p.slots[i];
      this._set('ws' + i, this.slots[i], 'className', 'ws' + (!has ? ' off' : i === p.cur ? ' on' : ''));
    }

    // 被发现
    const seen = s.enemiesSeeing;
    this._set('threatH', this.el.threat, 'hidden', seen <= 0);
    if (seen > 0) {
      this._text('threatN', this.el.threat.querySelector('b'), String(seen));
      this._set('threatCls', this.el.threat, 'className', 'threat' + (seen >= 3 ? ' bad' : ''));
    }

    // 交互提示
    const near = raid.nearestContainer();
    let prompt = '';
    if (raid.extractT > 0) prompt = '';
    else if (near && !near.searched) prompt = `[E] 搜索 ${near.name}`;
    else if (near && near.searched && near.revealed > 0) prompt = `[E] 拿走剩余`;
    this._text('prompt', this.el.prompt, prompt);
    this._set('promptH', this.el.prompt, 'hidden', !prompt);

    // 撤离进度
    const ex = s.extractT > 0;
    this._set('exH', this.el.extract, 'hidden', !ex);
    if (ex) this._w('exf', this.el.exfill, (s.extractT / s.holdTime) * 100);

    // 小地图每 4 帧刷一次就够了，它比主画面小 8 倍
    if ((this.mmTick++ & 3) === 0) this.drawMinimap(raid, s);
  }

  // ---------------- 小地图 ----------------
  drawMinimap(raid, s) {
    const c = this.mm;
    if (!c) return;
    const W = this.el.minimap.width, H = this.el.minimap.height;
    const R = W / 2, SC = R / (HALF + 8);
    const p = raid.player;
    c.clearRect(0, 0, W, H);
    c.save();
    c.beginPath(); c.arc(R, R, R - 1, 0, 7); c.clip();
    c.fillStyle = 'rgba(6,20,26,0.78)';
    c.fillRect(0, 0, W, H);

    // 条带：越深越暗，玩家能一眼看出自己在哪一层
    const px = R + p.x * SC, pz = R + p.z * SC;
    c.globalAlpha = 0.5;
    for (const b of raid.world.bands) {
      const y0 = R + b.z0 * SC, y1 = R + b.z1 * SC;
      const k = Math.min(1, -b.floorY / 44);
      c.fillStyle = `rgba(${Math.round(30 + 40 * (1 - k))},${Math.round(90 - 30 * k)},${Math.round(105 - 25 * k)},0.55)`;
      c.fillRect(0, y0, W, y1 - y0);
    }
    c.globalAlpha = 1;

    // 撤离点
    for (const e of raid.extracts) {
      c.fillStyle = '#5cffc8';
      c.beginPath(); c.arc(R + e.x * SC, R + e.z * SC, 3.4, 0, 7); c.fill();
    }
    // 敌人：只画「已经发现玩家的」。AI 里只有 sees 这一个对外可见的状态标记
    // （没有 alerted 之类的字段），用它就等于不泄露未发现的敌人位置。
    for (const e of raid.enemies) {
      if (e.dead || !e.sees) continue;
      c.fillStyle = '#ff6b5a';
      c.beginPath(); c.arc(R + e.x * SC, R + e.z * SC, 2.4, 0, 7); c.fill();
    }
    // 容器：只在被揭示后画，保留「搜刮点藏在哪」的信息价值
    for (const c2 of raid.containers) {
      if (c2.searched || c2.revealed > 0) {
        c.fillStyle = 'rgba(255,209,102,0.85)';
        c.fillRect(R + c2.x * SC - 1, R + c2.z * SC - 1, 2, 2);
      }
    }
    // 玩家 + 视线扇形
    const ang = p.angle;
    c.fillStyle = 'rgba(140,240,255,0.22)';
    c.beginPath(); c.moveTo(px, pz);
    c.arc(px, pz, 26, ang - 0.55, ang + 0.55); c.closePath(); c.fill();
    c.fillStyle = '#8ff0ff';
    c.beginPath(); c.arc(px, pz, 3.2, 0, 7); c.fill();
    c.restore();
  }

  // ---------------- 事件流 ----------------
  push(text, color) {
    const d = document.createElement('div');
    // class 用 fitem，颜色走内联 style：事件流的颜色来自稀有度表，
    // 是数据不是样式，硬塞进 CSS 类会变成一张越来越长的调色板。
    d.className = 'fitem';
    d.textContent = text;
    if (color) d.style.color = color;
    this.el.feed?.appendChild(d);
    this.feedItems.push({ node: d, t: 5.5 });
    while (this.feedItems.length > 7) {
      const old = this.feedItems.shift();
      old.node.remove();
    }
  }
  /** raid 的 take 事件已经带好 name 和 rare，直接上色即可 */
  pushTake(name, rare) {
    if (!name) return;
    this.push(name, RARITY_COLOR[rare] || '#cfe9ef');
  }
  pushCenter(text) {
    this._text('center', this.el.center, text);
    clearTimeout(this._ct);
    this._ct = setTimeout(() => { if (this.el.center) this.el.center.textContent = ''; }, 1400);
  }
  tickFeed(dt) {
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const f = this.feedItems[i];
      f.t -= dt;
      if (f.t <= 0) { f.node.remove(); this.feedItems.splice(i, 1); }
      else if (f.t < 1) f.node.style.opacity = String(f.t);
    }
  }
}

// ---------------- 小工具 ----------------
function ratio(cur, max) { return max > 0 ? (cur / max) * 100 : 0; }

function fmtMoney(v) {
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** 深度配色：浅处青、深处靛、再深处警示红。深度是本作的核心空间信息，要给颜色。 */
function depthHue(d) {
  if (d < 12) return '#8ff0ff';
  if (d < 26) return '#5cc8ff';
  if (d < 38) return '#7d8cff';
  return '#ff8f6b';
}

function haulValue(bag) {
  let v = 0;
  for (const b of bag) {
    const it = ITEMS[b.key];
    if (it) v += (it.v || 0) * (b.n || 1);
  }
  return v;
}