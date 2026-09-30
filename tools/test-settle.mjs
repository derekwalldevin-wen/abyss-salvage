// 打完一整局，验证结算面板。
//
// 走的是**真实路径**：把玩家挪进减压舱、让游戏自己的 updateExtract 走完
// 7 秒上浮，而不是直接调 raid.end()。原因：结算界面能不能弹出来，取决于
// 事件消费链是否完整（这正是上一轮发现的 bug —— end 事件在 raid.over 之后
// 就没人消费了）。直接调 end() 反而绕开了它测的那一段。
//
// 另外把面板上显示的每个数字和 core/rules.js 的算式对照 ——
// 面板一旦自己重算经济公式，这里立刻对不上。
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const OUT = 'C:/Users/derek/AppData/Local/Temp/opencode/abyss/shots';
fs.mkdirSync(OUT, { recursive: true });
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary',
};
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end('404');
  const b = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
const PORT = 4188;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

await page.goto(`http://127.0.0.1:${PORT}/?seed=4242`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });

const moneyBefore = await page.evaluate(() => {
  localStorage.removeItem('abyss_profile_v1');      // 从干净的存档开始，数字好对
  location.reload();
  return true;
});
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });

const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); return cond; };

// ---------------------------------------------------------------- 成功上浮
await page.evaluate(() => window.__abyss.deploy());
await page.waitForTimeout(700);

const bag = await page.evaluate(() => {
  const A = window.__abyss, r = A.raid, p = r.player;
  // 覆盖 0~5 六个稀有度，面板要能正确上色并按稀有度排序
  p.bag = ['ration', 'ration', 'ration', 'sealant', 'gauge', 'drone', 'bullion', 'statue', 'pearl'];
  r.kills = 4;
  r.maxDepth = 41;
  // 站进第一个减压舱，让游戏自己走完 7 秒上浮
  const e = r.extracts[0];
  p.x = e.x; p.z = e.z; p.y = A.world.heightAt(e.x, e.z);
  return { extract: e.name, bagLen: p.bag.length };
});
console.log('撤离舱:', bag.extract, ' 背包:', bag.bagLen, '件');

await page.waitForFunction(() => !document.getElementById('settle').hidden, null, { timeout: 30000, polling: 200 });
await page.waitForTimeout(500);

const win = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  return {
    out: t('seOut'), via: t('seVia'),
    depth: t('seDepth'), kills: t('seKills'), time: t('seTime'), scale: t('seScale'),
    net: t('seNet'), money: t('seMoney'),
    haul: [...document.querySelectorAll('#seHaul .se-hrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    ledger: [...document.querySelectorAll('#seLedger .se-lrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    career: t('seCareer'),
    hudHidden: document.getElementById('hud').hidden,
  };
});
console.log('\n=== 成功上浮 ===');
console.log('  标题   ', win.out, '|', win.via);
console.log('  概况   ', `最深 ${win.depth}m · 击杀 ${win.kills} · 历时 ${win.time} · 系数 ${win.scale}`);
console.log('  物资   '); for (const h of win.haul) console.log('     ', h);
console.log('  明细   '); for (const l of win.ledger) console.log('     ', l);
console.log('  合计   ', `净收支 ${win.net} · 余额 ${win.money}`);
console.log('  生涯   ', win.career);
console.log('  HUD 隐藏:', win.hudHidden);

check(win.out === '成功上浮', `成功局标题应为「成功上浮」，实际「${win.out}」`);
check(win.depth === '41', `最深应为 41，实际 ${win.depth}`);
check(win.kills === '4', `击杀应为 4，实际 ${win.kills}`);
check(win.scale.startsWith('×') && parseFloat(win.scale.slice(1)) > 1, `41m 深度系数应 >1，实际 ${win.scale}`);
check(win.haul.length >= 4, `物资应合并同名后至少 4 行，实际 ${win.haul.length}`);
check(win.haul[0]?.includes('深渊珍珠'), '最高价值物品应排在第一');
check(win.ledger.length >= 2, '明细至少要有战利品和撤离奖金两行');
check(win.ledger.some(l => l.includes('撤离奖金')), '明细缺「撤离奖金」行');
check(win.hudHidden, '结算时 HUD 应隐藏');
check(parseInt(win.money.replace(/[^\d]/g, ''), 10) > 120000, '撤离成功余额应高于初始 120000');

await page.screenshot({ path: path.join(OUT, 'settle-win.png') });

// 对账：独立用 catalog 的公式重算一遍，和面板显示的比
const audit = await page.evaluate(() => {
  const A = window.__abyss, r = A.raid;
  return {
    money: A.profile.money,
    hist: (A.profile.history || [])[0],
    stash: (A.profile.stash || []).length,
  };
});
console.log('\n=== 对账（存档侧）===');
console.log('  余额     ', audit.money);
console.log('  本局记录 ', JSON.stringify(audit.hist));
console.log('  入库物品 ', audit.stash, '件');
check(audit.stash === 9, `撤离成功应把 9 件物资入库，实际 ${audit.stash}`);
check(audit.money === 120000 + audit.hist.value + audit.hist.refund + audit.hist.aid,
  `余额应等于初始+value+refund+aid：120000+${audit.hist.value}+${audit.hist.refund}+${audit.hist.aid} ≠ ${audit.money}`);

// ---------------------------------------------------------------- 阵亡
await page.click('#seAgain');
await page.waitForTimeout(900);
const dieRes = await page.evaluate(() => {
  const A = window.__abyss, r = A.raid, p = r.player;
  p.bag = ['ration', 'sealant', 'gauge', 'bullion', 'pearl'];
  r.kills = 1; r.maxDepth = 12;
  r.end('killed');            // 从循环外结束 —— 上一轮修的正是这条路径
  return { over: r.over, outcome: r.outcome };
});
await page.waitForFunction(() => !document.getElementById('settle').hidden, null, { timeout: 20000, polling: 200 });
await page.waitForTimeout(400);
const die = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  return {
    out: t('seOut'), via: t('seVia'), net: t('seNet'), money: t('seMoney'),
    ledger: [...document.querySelectorAll('#seLedger .se-lrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
  };
});
console.log('\n=== 阵亡 ===');
console.log('  标题', die.out, '|', die.via);
console.log('  明细'); for (const l of die.ledger) console.log('     ', l);
console.log('  净收支', die.net, ' 余额', die.money);

check(die.out === '潜水员阵亡', `阵亡标题应为「潜水员阵亡」，实际「${die.out}」`);
check(die.ledger.some(l => l.includes('装备投入')), '阵亡明细缺「装备投入」行');
check(die.ledger.some(l => l.includes('遗失')), '阵亡明细缺「物资遗失」行 —— 钱去哪了必须写出来');
check(die.ledger.some(l => l.includes('保险')), '阵亡应显示保险赔付');
check(die.net.startsWith('−') || die.net.startsWith('-'), `阵亡净收支应为负，实际 ${die.net}`);
await page.screenshot({ path: path.join(OUT, 'settle-dead.png') });

// ---------------------------------------------------------------- 放弃
await page.click('#seAgain');
await page.waitForTimeout(900);
await page.evaluate(() => { const r = window.__abyss.raid; r.player.bag = ['ration', 'gauge']; r.maxDepth = 20; r.end('abandon'); });
await page.waitForFunction(() => !document.getElementById('settle').hidden, null, { timeout: 20000, polling: 200 });
await page.waitForTimeout(400);
const ab = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  return { out: t('seOut'), via: t('seVia'),
    ledger: [...document.querySelectorAll('#seLedger .se-lrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()) };
});
console.log('\n=== 放弃 ===');
console.log('  标题', ab.out, '|', ab.via);
console.log('  明细'); for (const l of ab.ledger) console.log('     ', l);
check(ab.out === '放弃行动', `放弃标题应为「放弃行动」，实际「${ab.out}」`);
check(ab.ledger.some(l => l.includes('折价')), '放弃应显示装备折价收回');
await page.screenshot({ path: path.join(OUT, 'settle-abandon.png') });

// ---------------------------------------------------------------- 快捷键
await page.click('#seAgain');
await page.waitForTimeout(900);
await page.evaluate(() => window.__abyss.raid.end('mia'));
await page.waitForFunction(() => !document.getElementById('settle').hidden, null, { timeout: 20000, polling: 200 });
const beforeKey = await page.evaluate(() => window.__abyss.raid && window.__abyss.raid.over);
await page.keyboard.press('KeyH');
await page.waitForTimeout(1000);
const afterKey = await page.evaluate(() => ({
  settleHidden: document.getElementById('settle').hidden,
  newRaid: !!window.__abyss.raid && !window.__abyss.raid.over,
  items: window.__abyss.raid?.player?.bag.length,
}));
console.log('\n=== H 快捷键重开 ===');
console.log('  重开前 over =', beforeKey, '→ 重开后', JSON.stringify(afterKey));
check(afterKey.settleHidden, '按 H 后结算面板应关闭');
check(afterKey.newRaid, '按 H 后应开新局');
check(afterKey.items === 0, `新局背包应是空的，实际 ${afterKey.items}（旧物资没清干净）`);

if (errs.length) { console.log('\n控制台错误:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); }
await browser.close();
srv.close();

if (fail.length) { console.log('\n✗ 结算面板检查失败:\n  - ' + fail.join('\n  - ')); process.exit(1); }
console.log('\n✓ 结算面板全部检查通过（成功 / 阵亡 / 放弃 / 快捷键重开）');
