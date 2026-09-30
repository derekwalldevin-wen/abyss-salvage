// 真人视角验收：只点界面，不碰 window.__abyss。
//
// 上一版所有检查都是控制台调 deploy() 进场，所以全绿，但人根本进不去游戏。
// 这个脚本刻意**不碰任何调试钩子**：加载完只许点，点了才算数。
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
const PORT = 4191;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const URL = process.argv[2] || `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)); });

const fail = [];
const check = (c, m) => { if (!c) fail.push(m); return c; };

console.log('打开', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#camp:not([hidden])', { timeout: 600000 });
console.log('✓ 加载完自动进营地');

// 1) 加载完不能被任何面板挡住
const boot = await page.evaluate(() => {
  const vis = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return 'missing';
    const cs = getComputedStyle(e);
    return (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) ? 'hidden' : 'VISIBLE';
  };
  return { camp: vis('#camp'), settle: vis('#settle'), hud: vis('#hud'), loading: vis('#loading') };
});
console.log('  可见性:', JSON.stringify(boot));
check(boot.camp === 'VISIBLE', '营地应可见');
check(boot.settle !== 'VISIBLE', '结算面板不该在开局就挡住画面 —— 上一版就是这里把人挡住的');
check(boot.loading !== 'VISIBLE', '加载层应已隐藏');

const camp = await page.evaluate(() => ({
  money: document.getElementById('cpMoney').textContent,
  cost: document.getElementById('cpCost').textContent,
  guns: document.querySelectorAll('#cpGuns .cp-opt').length,
  suits: document.querySelectorAll('#cpSuits .cp-opt').length,
  helms: document.querySelectorAll('#cpHelms .cp-opt').length,
  packs: document.querySelectorAll('#cpPacks .cp-opt').length,
  diff: document.querySelectorAll('#cpDiff .cp-opt').length,
  meds: document.querySelectorAll('#cpMeds .cp-mini').length,
  stats: (document.getElementById('cpStats').textContent || '').replace(/\s+/g, ' ').trim(),
  goDisabled: document.getElementById('cpGo').disabled,
  selected: [...document.querySelectorAll('.cp-opt.on .cp-n')].map(e => e.textContent),
}));
console.log('  余额', camp.money, '· 投入', camp.cost, '· 已选', JSON.stringify(camp.selected));
console.log('  可选: 枪', camp.guns, '服', camp.suits, '盔', camp.helms, '包', camp.packs, '难度', camp.diff, '急救', camp.meds);
check(camp.guns === 7, `武器应有 7 个选项，实际 ${camp.guns}`);
check(camp.suits === 5, `潜水服应有 5 个，实际 ${camp.suits}`);
check(camp.meds === 5, '急救包应有 0~4 五档');
check(!camp.goDisabled, '初始余额 120000 应付得起默认配装，下潜按钮不该是禁用的');
await page.screenshot({ path: path.join(OUT, 'camp.png') });

// 2) 换装要真的改状态和价格
await page.click('#cpGuns .cp-opt:nth-child(7)');   // 绞盘 重机 25000
await page.waitForTimeout(250);
const after = await page.evaluate(() => ({
  cost: document.getElementById('cpCost').textContent,
  on: document.querySelector('#cpGuns .cp-opt.on .cp-n')?.textContent,
}));
console.log('  换成重机枪后：投入', after.cost, '· 已选', after.on);
check(after.on !== camp.selected[0], '点了别的枪，营地应该更新选中态');
check(after.cost !== camp.cost, '换了更贵的枪，装备投入应该变化');

// 3) 回车下潜 —— 纯键盘，和真人一样
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);
const inRaid = await page.evaluate(() => {
  const vis = (sel) => { const e = document.querySelector(sel); if (!e) return 'missing'; const cs = getComputedStyle(e); return (cs.display === 'none' || +cs.opacity === 0) ? 'hidden' : 'VISIBLE'; };
  return {
    camp: vis('#camp'), hud: vis('#hud'),
    hudHidden: document.getElementById('hud').hidden,
    timer: document.getElementById('timer').textContent,
    weapon: document.getElementById('wname').textContent,
    depth: document.getElementById('depth').textContent,
    inRaidClass: document.body.classList.contains('in-raid'),
  };
});
console.log('  按回车后:', JSON.stringify(inRaid));
check(inRaid.camp === 'hidden', '下潜后营地应隐藏');
check(inRaid.hud === 'VISIBLE', '下潜后 HUD 应真的可见（之前被 opacity:0 弄没了）');
check(inRaid.hudHidden === false, '下潜后 HUD 的 hidden 属性应为 false');
check(inRaid.inRaidClass, 'body 应带 in-raid 类');
check(inRaid.weapon.includes('绞盘'), `HUD 武器应显示刚选的重机枪，实际 ${inRaid.weapon}`);
await page.screenshot({ path: path.join(OUT, 'play.png') });

// 4) 真的能走动和开枪
await page.keyboard.down('KeyW');
await page.waitForTimeout(1400);
await page.keyboard.up('KeyW');
const moved = await page.evaluate(() => document.getElementById('depth').textContent);
// 全自动武器读的是 inp.mouse（按住），page.mouse.click() 的 down+up 在同一帧内
// 完成，input.mouse 在下一帧读之前就被置回 false 了 —— 必须真的按住。
await page.mouse.move(640, 300);
await page.mouse.down();
await page.waitForTimeout(900);
await page.mouse.up();
await page.waitForTimeout(300);
const played = await page.evaluate(() => ({
  mag: document.getElementById('wmag').textContent,
  timer: document.getElementById('timer').textContent,
  o2: document.getElementById('o2num').textContent,
}));
console.log('  走动+开火后: 弹匣', played.mag, '· 计时', played.timer, '· 氧气', played.o2);
check(played.mag !== '100', `按住扳机后弹匣应减少，实际 ${played.mag}`);
check(played.timer !== '12:00', `倒计时应在走，实际 ${played.timer}`);

// 5) 打完一局能回到营地（Esc 放弃）
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
const back = await page.evaluate(() => {
  const vis = (sel) => { const e = document.querySelector(sel); const cs = getComputedStyle(e); return (cs.display === 'none' || +cs.opacity === 0) ? 'hidden' : 'VISIBLE'; };
  return { settle: vis('#settle'), money: document.getElementById('cpMoney').textContent };
});
console.log('  放弃后:', JSON.stringify(back));
check(back.settle === 'VISIBLE', '放弃后应弹结算面板');
await page.click('#seBack');
await page.waitForTimeout(700);
const camp2 = await page.evaluate(() => ({
  camp: (() => { const cs = getComputedStyle(document.getElementById('camp')); return cs.display === 'none' ? 'hidden' : 'VISIBLE'; })(),
  money: document.getElementById('cpMoney').textContent,
}));
console.log('  点返回营地:', JSON.stringify(camp2));
check(camp2.camp === 'VISIBLE', '点「返回营地」应回到配装界面');

if (errs.length) { console.log('\n控制台错误:'); for (const e of errs.slice(0, 6)) console.log('  ' + e); check(false, '有控制台错误'); }
await browser.close();
srv.close();

if (fail.length) { console.log('\n✗ 真人路径失败:\n  - ' + fail.join('\n  - ')); process.exit(1); }
console.log('\n✓ 纯点击/纯键盘走通：营地 → 配装 → 下潜 → 走动开火 → 放弃 → 结算 → 回营地');
