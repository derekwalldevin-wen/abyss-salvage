// 营地：配装 + 出击。
//
// 这个界面之前根本不存在。deploy() 只挂在 window.__abyss 上给测试用，
// 于是游戏加载完是一个**什么都点不了的黑屏** —— 所有自动化检查都绿，
// 因为它们全都是用控制台调 deploy() 进场的。人是进不去的。
//
// 原则：营地只做「开一局所必需的事」。买卖、改造、仓库管理都不在这儿 ——
// 那是另一个功能，不该把入口堵住。
//
// 配装规则全部来自 core/catalog.js（价格、耐久、抗切割、负重格数），
// 这里不写死任何数字。

import {
  GUNS, SUITS, HELMS, PACKS, DIFFICULTY, ITEMS, RARITY, RARITY_COLOR,
  loadoutCost, MIN_MONEY,
} from '../core/catalog.js';

const $ = (id) => document.getElementById(id);

export class Camp {
  /**
   * @param {object} profile 存档
   * @param {(lo:object)=>void} onDeploy 点了「下潜」，把配装交出去
   */
  constructor(profile, onDeploy) {
    this.profile = profile;
    this.onDeploy = onDeploy;
    this.el = {
      root: $('camp'), money: $('cpMoney'), aid: $('cpAid'),
      guns: $('cpGuns'), suits: $('cpSuits'), helms: $('cpHelms'),
      packs: $('cpPacks'), diff: $('cpDiff'), meds: $('cpMeds'),
      info: $('cpInfo'), stash: $('cpStash'), stats: $('cpStats'),
      cost: $('cpCost'), warn: $('cpWarn'), go: $('cpGo'),
    };
    // 默认配装：不是最贵的，也不是最便宜的 —— 玩家第一次进来要能直接下水
    this.lo = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2, difficulty: 'salvage' };
    this.el.go?.addEventListener('click', () => this.start());
  }

  /** @param {object} lo 从结算界面「返回营地」带回来的上一局配装 */
  show(lo) {
    if (lo) this.lo = { ...this.lo, ...lo };
    this.render();
    this.el.root.hidden = false;
  }
  hide() { if (this.el.root) this.el.root.hidden = true; }

  start() {
    if (this.cost() > this.profile.money) { this.flash(); return; }
    this.hide();
    this.onDeploy({ ...this.lo });
  }

  flash() {
    const w = this.el.warn;
    if (!w) return;
    w.hidden = false;
    this.el.go?.animate?.(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' },
       { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
      { duration: 220 }
    );
  }

  /** 回车 = 下潜。营地是唯一有输入焦点的界面。 */
  hotkey(pressed) {
    if (this.el.root?.hidden) return false;
    if (pressed.Enter || pressed.NumpadEnter) { this.start(); return true; }
    return false;
  }

  cost() { return loadoutCost(this.lo) || 0; }

  render() {
    const p = this.profile;
    this.el.money.textContent = fmtMoney(p.money);
    // 余额被过线补足过时明确标出来，否则玩家会莫名多出一笔钱
    const aided = p.history?.[0]?.aid > 0 && p.history[0].t > (Date.now() - 8000);
    this.el.aid.hidden = !aided;

    this.picker(this.el.guns, 'gun', Object.entries(GUNS).map(([k, v]) => ({
      key: k, name: v.name, sub: `${v.cls} · 伤害 ${v.dmg} · ${v.mag} 发`, price: v.price,
    })));

    this.picker(this.el.suits, 'suit', SUITS.map((v, i) => ({
      key: i, name: v.name, sub: v.dur ? `耐久 ${v.dur} · 抗切割 ${Math.round(v.cut * 100)}%` : '无防护',
      price: v.price,
    })));

    this.picker(this.el.helms, 'helm', HELMS.map((v, i) => ({
      key: i, name: v.name, sub: v.dur ? `耐久 ${v.dur} · 抗打击 ${Math.round(v.cut * 100)}%` : '无防护',
      price: v.price,
    })));

    this.picker(this.el.packs, 'pack', PACKS.map((v) => ({
      key: v.id, name: v.name, sub: `${v.slots} 格`, price: v.price,
    })));

    this.picker(this.el.diff, 'difficulty', Object.entries(DIFFICULTY).map(([k, v]) => ({
      key: k, name: v.name, sub: v.desc, price: 0,
    })));

    // 急救包：固定 0~4
    this.el.meds.innerHTML = [0, 1, 2, 3, 4].map((n) =>
      `<button class="cp-mini${this.lo.meds === n ? ' on' : ''}" data-meds="${n}">${n}</button>`).join('');
    for (const b of this.el.meds.querySelectorAll('[data-meds]')) {
      b.addEventListener('click', () => { this.lo.meds = +b.dataset.meds; this.render(); });
    }

    // ---- 本局预览：把关键数字摊开，别让玩家下水后才发现没氧气瓶 ----
    const g = GUNS[this.lo.gun];
    const pack = PACKS.find((v) => v.id === this.lo.pack);
    const suit = SUITS[this.lo.suit], helm = HELMS[this.lo.helm];
    const d = DIFFICULTY[this.lo.difficulty];
    this.el.info.innerHTML = [
      ['潜水时长', '12:00'],
      ['负重', `${pack?.slots || 0} 格`],
      ['保险赔付', '50%'],
      ['难度', d?.name || '—'],
      ['敌人反应', bar(1 - (d?.react ?? 1))],
      ['敌人伤害', bar(d?.dmg ?? 0.3, 0.5)],
    ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')
      + `<div class="cp-gearline">${esc(g?.name || '')} · ${esc(suit?.name || '')} · ${esc(helm?.name || '')}</div>`;

    // ---- 仓库：撤离成功才进得来东西 ----
    const stash = p.stash || [];
    if (!stash.length) {
      this.el.stash.textContent = '空';
      this.el.stash.className = 'cp-stash empty';
    } else {
      const by = new Map();
      for (const k of stash) by.set(k, (by.get(k) || 0) + 1);
      this.el.stash.className = 'cp-stash';
      this.el.stash.innerHTML = [...by.entries()].slice(0, 12).map(([k, n]) => {
        const it = ITEMS[k];
        if (!it) return '';
        return `<span style="--rc:${RARITY_COLOR[it.r]}">${it.ic || '◆'}${esc(it.name)}${n > 1 ? '×' + n : ''}</span>`;
      }).join('') + (stash.length > 12 ? `<span class="more">…共 ${stash.length} 件</span>` : '');
    }

    const s = p.stats || {};
    this.el.stats.innerHTML = [
      ['局数', s.raids || 0], ['上浮', s.extracts || 0], ['阵亡', s.deaths || 0],
      ['击杀', s.kills || 0], ['最佳', fmtMoney(s.bestHaul || 0)], ['最深', (s.bestDepth || 0) + 'm'],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');

    // ---- 费用与放行 ----
    const c = this.cost();
    this.el.cost.textContent = fmtMoney(c);
    const broke = c > p.money;
    this.el.warn.hidden = !broke;
    this.el.go.disabled = broke;
    this.el.go.classList.toggle('broke', broke);
  }

  /** 通用选项列表。price 为 0 的（难度）不显示价格。 */
  picker(host, field, opts) {
    if (!host) return;
    host.innerHTML = opts.map((o) => {
      const on = this.lo[field] === o.key;
      const afford = o.price === 0 || this.profile.money >= o.price;
      return `<button class="cp-opt${on ? ' on' : ''}${afford ? '' : ' poor'}" data-f="${field}" data-v="${esc(String(o.key))}">
        <span class="cp-n">${esc(o.name)}</span>
        <span class="cp-s">${esc(o.sub)}</span>
        ${o.price ? `<span class="cp-p mono">${fmtMoney(o.price)}</span>` : '<span class="cp-p">—</span>'}
      </button>`;
    }).join('');
    for (const b of host.querySelectorAll('[data-f]')) {
      b.addEventListener('click', () => {
        const f = b.dataset.f;
        const v = f === 'gun' || f === 'difficulty' || f === 'pack' ? b.dataset.v : +b.dataset.v;
        this.lo[f] = v;
        this.render();
      });
    }
  }
}

function fmtMoney(v) { return Math.round(v).toLocaleString('en-US'); }
/** 简易条形指示（0~1） */
function bar(v, max = 1) {
  const n = Math.max(0, Math.min(1, v / max));
  return `<i class="cp-bar"><b style="width:${(n * 100).toFixed(0)}%"></b></i>`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
