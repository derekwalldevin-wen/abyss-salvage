// 撤离结算面板。
//
// 设计前提：撤离射击的结算**必须可核对**。玩家会在下一局之前反复算
// 「这趟到底赚没赚、为什么赚这么多」。所以这里不只给一个总数，
// 而是把 settle() 的每一项都列出来：装备成本、战利品、深度系数、撤离奖金、
// 保险赔付、余额过线补足。
//
// 关键约束：**这里不重算任何经济公式**。所有数字都来自 core/rules.js 的
// settle() 返回值（haul/bonus/scale/refund/...）。UI 自己再算一遍就等于把
// 经济系统抄了第二份，改一处忘一处是迟早的事。

import { ITEMS, GUNS, RARITY, RARITY_COLOR, GUN_SELL_RATE } from '../core/catalog.js';

const $ = (id) => document.getElementById(id);

// 四种结局的标题 / 副标题 / 主色。
// 措辞是有意的：失败局也要说清楚**发生了什么**，而不是只标一个「失败」。
const OUTCOMES = {
  extracted: { t: '成功上浮', c: 'var(--cyan)', s: '物资已入库' },
  killed: { t: '潜水员阵亡', c: 'var(--red)', s: '随身物资全部遗失' },
  mia: { t: '信号失联', c: 'var(--red)', s: '氧气耗尽，未能上浮' },
  abandon: { t: '放弃行动', c: 'var(--muted)', s: '撤离舱返回，装备折价收回' },
};

export class Settle {
  constructor(hooks = {}) {
    this.el = {
      root: $('settle'),
      out: $('seOut'), via: $('seVia'),
      depth: $('seDepth'), kills: $('seKills'), time: $('seTime'), scale: $('seScale'),
      haulSec: $('seHaulSec'), haul: $('seHaul'),
      ledger: $('seLedger'),
      net: $('seNet'), money: $('seMoney'),
      career: $('seCareer'),
      again: $('seAgain'), back: $('seBack'),
    };
    this.hooks = hooks;
    this.el.again?.addEventListener('click', () => this.hooks.onAgain?.());
    this.el.back?.addEventListener('click', () => this.hooks.onBack?.());
  }

  hide() { if (this.el.root) this.el.root.hidden = true; }

  /**
   * @param {object} raid  已 end() 的对局（end 会把 secs/items/guns 归一化好）
   * @param {object} res   settle() 的返回值
   * @param {object} profile 结算后的存档
   */
  show(raid, res, profile) {
    const e = this.el;
    const oc = OUTCOMES[res.outcome] || OUTCOMES.abandon;

    // ---- 标题 ----
    e.out.textContent = oc.t;
    e.out.style.color = oc.c;
    e.via.textContent = raid.extractedVia
      ? `经「${raid.extractedVia}」上浮 · ${oc.s}`
      : oc.s;

    // ---- 本局概况 ----
    e.depth.textContent = String(Math.round(raid.maxDepth || 0));
    e.kills.textContent = String(res.kills);
    e.time.textContent = fmtTime(raid.secs || 0);
    e.scale.textContent = '×' + (res.scale || 1).toFixed(2);

    // ---- 舱内物资（按物品归并，数量多的排前面）----
    this.renderHaul(raid, res);

    // ---- 明细 ----
    this.renderLedger(raid, res);

    // ---- 合计 ----
    // 净收支 = 卖货 + 赔付 + 补足 − 装备成本。
    // 撤离成功时装备成本已经通过货价体现了（装备不算损失），
    // 但仍要列出来让玩家看到这趟的门槛。
    const net = res.value + res.refund + res.aid - (res.outcome === 'extracted' ? 0 : res.cost);
    e.net.textContent = signed(net);
    e.net.style.color = net >= 0 ? 'var(--cyan)' : 'var(--red)';
    e.money.textContent = fmtMoney(profile.money);
    if (res.aid > 0) {
      // 余额跌破下限被补足过 —— 不说的话玩家会莫名多出一笔钱
      e.money.title = `含余额过线补足 +${fmtMoney(res.aid)}`;
      e.money.classList.add('aided');
    } else {
      e.money.classList.remove('aided');
    }

    // ---- 生涯 ----
    const s = profile.stats || {};
    e.career.innerHTML = [
      ['生涯', `${s.raids || 0} 局`],
      ['上浮', `${s.extracts || 0}`],
      ['阵亡', `${s.deaths || 0}`],
      ['最佳单局', fmtMoney(s.bestHaul || 0)],
      ['最深', `${s.bestDepth || 0} m`],
    ].map(([k, v]) => `<span><i>${k}</i><b>${v}</b></span>`).join('');

    e.root.hidden = false;
  }

  renderHaul(raid, res) {
    const e = this.el;
    const items = raid.items || [];
    if (!items.length) {
      e.haulSec.hidden = true;
      return;
    }
    e.haulSec.hidden = false;
    // 失败局这一栏的标题要跟着变。同样一列东西，撤离成功是「入库」，
    // 阵亡是「全丢了」—— 不写清楚的话玩家容易把它当成还能拿到的收益。
    const title = e.haulSec.querySelector('.se-sect');
    if (title) {
      const lost = res.outcome !== 'extracted';
      title.textContent = lost ? '遗失物资' : '舱内物资';
      title.style.color = lost ? 'var(--red)' : '';
    }

    // 归并同名物品。背包是数组，可能有 20 多个同名罐头，不归并没法看。
    const by = new Map();
    for (const k of items) {
      const it = ITEMS[k];
      if (!it) continue;
      by.set(k, (by.get(k) || 0) + 1);
    }
    const rows = [...by.entries()].sort((a, b) => {
      const ra = ITEMS[a[0]], rb = ITEMS[b[0]];
      return (rb.r - ra.r) || (rb.v * b[1] - ra.v * a[1]);
    });

    const scale = res.scale || 1;
    e.haul.innerHTML = rows.map(([k, n]) => {
      const it = ITEMS[k];
      // 战利品价值 = 单价 × 深度系数。系数在这里显式写出来，
      // 玩家才看得懂「同一个东西，为什么这趟更值钱」。
      const v = Math.round(it.v * scale) * n;
      return `<div class="se-hrow" style="--rc:${RARITY_COLOR[it.r]}">
        <span class="se-ic">${it.ic || '◆'}</span>
        <span class="se-nm">${esc(it.name)}${n > 1 ? `<i>×${n}</i>` : ''}</span>
        <span class="se-rr">${RARITY[it.r]}</span>
        <span class="se-v mono">${fmtMoney(v)}</span>
      </div>`;
    }).join('');

    // 撤离成功会把枪也变现
    const guns = (raid.guns || []).filter(k => GUNS[k]);
    if (guns.length) {
      e.haul.insertAdjacentHTML('beforeend', guns.map(k => {
        const g = GUNS[k];
        return `<div class="se-hrow" style="--rc:#9fd0d8">
          <span class="se-ic">🔫</span>
          <span class="se-nm">${esc(g.name)}</span>
          <span class="se-rr">武器</span>
          <span class="se-v mono">${fmtMoney(Math.round(g.price * GUN_SELL_RATE))}</span>
        </div>`;
      }).join(''));
    }
  }

  renderLedger(raid, res) {
    const rows = [];
    const win = res.outcome === 'extracted';

    if (!win && res.cost > 0) {
      rows.push(['装备投入', -res.cost, 'dim']);
    }
    if (win) {
      if (res.scale > 1) {
        rows.push([`战利品（含深度加成 ×${res.scale.toFixed(2)}）`, res.haul, res.haul > 0 ? 'up' : 'dim']);
      } else {
        rows.push(['战利品', res.haul, res.haul > 0 ? 'up' : 'dim']);
      }
      rows.push(['撤离奖金', res.bonus, 'up']);
    } else if (res.lost > 0) {
      // 失败局最该说清楚的就是钱去哪了
      rows.push([`舱内物资遗失${res.scale > 1 ? `（含深度加成 ×${res.scale.toFixed(2)}）` : ''}`, -res.lost, 'down']);
    }
    if (res.refund > 0) {
      const why = res.outcome === 'abandon' ? '装备折价收回' : '保险赔付';
      rows.push([why, res.refund, 'up']);
    }
    if (res.aid > 0) rows.push(['余额过线补足', res.aid, 'up']);

    this.el.ledger.innerHTML = rows.map(([k, v, cls]) =>
      `<div class="se-lrow ${cls}"><span>${esc(k)}</span><b class="mono">${signed(v)}</b></div>`
    ).join('') || '<div class="se-lrow dim"><span>本局无资金变动</span><b class="mono">0</b></div>';
  }

  /**
   * 结算面板的快捷键。
   * @param {object} pressed input.pressed —— 形如 { KeyH: true } 的「按键名 → 布尔」表，
   *   **不是** KeyboardEvent。写成 e.code 会永远 undefined，表现为
   *   「按钮能点、H 键没反应」（踩过）。
   * @returns {boolean} 是否消费掉了这次按键
   */
  hotkey(pressed) {
    if (this.el.root?.hidden) return false;
    if (pressed.KeyH) { this.hooks.onAgain?.(); return true; }
    if (pressed.Escape) { this.hooks.onBack?.(); return true; }
    return false;
  }
}

// ---------------- 工具 ----------------
function fmtTime(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 金额：过万缩写，否则带千分位 */
function fmtMoney(v) {
  const n = Math.round(v);
  return n.toLocaleString('en-US');
}
function signed(v) {
  const n = Math.round(v);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US');
}

/** 物品名来自数据文件，仍然转义一下 —— 数据和标记混在一起是迟早会被坑到的事 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
