// 多分辨率 UI 验收：营地 / HUD / 结算三个界面在几种常见尺寸下会不会溢出、被切、按钮点不到。
//
// 为什么要有这个：之前 UI 全在 1000×620 下看，那个尺寸下挤在一起看不出来。
// 换到 1440×900 立刻暴露两个 bug（事件流压在小地图上、刻度线用错 helper）。
// 响应式的问题只会在某个特定尺寸出现，所以必须扫一遍。
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const OUT = process.env.SHOT_DIR || 'C:/Users/derek/AppData/Local/Temp/opencode/shots';
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
const PORT = 4205;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
});

const SIZES = [[1920, 1080, '1080p'], [1440, 900, 'laptop'], [1280, 720, 'small'], [1024, 768, '4x3']];
const problems = [];
const check = (c, m, tag) => { if (!c) problems.push(`[${tag}] ${m}`); };

for (const [w, h, tag] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => problems.push(`[${tag}] ${e.message.slice(0, 110)}`));
  await page.goto(`http://127.0.0.1:${PORT}/?seed=9`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#camp:not([hidden])', { timeout: 600000 });

  const camp = await page.evaluate(() => {
    const c = document.querySelector('.cp-card'), r = c.getBoundingClientRect();
    const gl = document.querySelector('.cp-gearline');
    return {
      scrollH: c.scrollHeight, clientH: c.clientHeight,
      goBottom: Math.round(document.getElementById('cpGo').getBoundingClientRect().bottom),
      cardTop: Math.round(r.top),
      vh: innerHeight,
      // 配装行是「枪 · 潜水服 · 头盔」三段。任一段为空会渲染成
      // 「礁岩 突击枪 · · 」这种残缺文本，看着像加载坏了。
      gearline: gl ? gl.textContent.trim() : null,
      gearSegs: gl ? gl.textContent.split('·').length : 0,
    };
  });
  await page.screenshot({ path: path.join(OUT, `sz-${tag}-camp.png`) });

  // 进图。等 raid 真的建起来，不要用固定 sleep —— 加载快慢随机器波动，
  // sleep 短了就拿到 null然后报一句和 UI 毫无关系的错。
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!window.__abyss?.raid, null, { timeout: 120000, polling: 100 });
  await page.waitForTimeout(600);

  // HUD：底部两块不能被视口切掉
  const hud = await page.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), right: Math.round(r.right), left: Math.round(r.left) }; };
    return { vitals: g('.vitals'), weapon: g('.weapon'), mm: g('#minimap'), vh: innerHeight, vw: innerWidth };
  });

  // 结算：塞满物资，逼出滚动
  await page.evaluate(() => {
    const r = window.__abyss.raid, p = r.player;
    p.bag = ['ration', 'ration', 'ration', 'sealant', 'rag', 'gauge', 'torch', 'toolkit',
      'ssd', 'drone', 'thermal', 'bullion', 'charts', 'keycard', 'statue', 'watch', 'porthole', 'pearl'];
    r.kills = 7; r.maxDepth = 44;
    r.end('extracted');
  });
  await page.waitForSelector('#settle:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => {
    const c = document.querySelector('.se-card');
    const h = document.getElementById('seHaul'), s = document.querySelector('.se-scroll');
    return {
      scrollH: c.scrollHeight, clientH: c.clientHeight,
      btnBottom: Math.round(document.getElementById('seAgain').getBoundingClientRect().bottom),
      vh: innerHeight,
      rows: document.querySelectorAll('#seHaul .se-hrow').length,
      cardLeft: Math.round(c.getBoundingClientRect().left),
      cardW: Math.round(c.getBoundingClientRect().width),
      // 卡片必须不再整张滚动（余额和按钮因此永远在视口内）
      cardScrolls: c.scrollHeight > c.clientHeight + 2,
      haulScrolls: h.scrollHeight > h.clientHeight + 2,
      haulFade: h.classList.contains('more'),
      midScrolls: s.scrollHeight > s.clientHeight + 2,
      midFade: s.classList.contains('more'),
    };
  });
  await page.screenshot({ path: path.join(OUT, `sz-${tag}-settle.png`) });

  console.log(`${tag.padEnd(7)} ${String(w).padStart(4)}x${String(h).padEnd(4)}`);
  console.log(`  营地  内容${camp.scrollH} / 可见${camp.clientH}  下潜键底 ${camp.goBottom} (视口 ${camp.vh})`);
  console.log(`  HUD   vitals底 ${hud.vitals.bottom}  weapon底 ${hud.weapon.bottom}  小地图右 ${hud.mm.right}  视口 ${hud.vh}x${hud.vw}`);
  console.log(`  结算  卡片${st.scrollH} 按钮底 ${st.btnBottom}/${st.vh} 物资${st.rows}行 中段可滚=${st.midScrolls} 物资可滚=${st.haulScrolls}`);

  // 底部两块必须在视口内
  check(hud.vitals.bottom <= hud.vh, `vitals 被切: 底 ${hud.vitals.bottom} > ${hud.vh}`, tag);
  check(hud.weapon.bottom <= hud.vh, `武器面板被切: 底 ${hud.weapon.bottom} > ${hud.vh}`, tag);
  check(hud.mm.right <= hud.vw, `小地图被切: 右 ${hud.mm.right} > ${hud.vw}`, tag);
  // 营地卡片不能超出视口
  check(camp.cardTop >= 0, `营地上边跑出视口: ${camp.cardTop}`, tag);
  // 结算：内容高过可视高度时必须可滚动
  check(!st.cardScrolls, `结算卡片在整张滚动（余额/按钮会被顶出视口）`, tag);
  check(st.btnBottom <= st.vh, `结算按钮被切: 底 ${st.btnBottom} > ${st.vh}`, tag);
  // 可滚的列表必须给出视觉提示，否则玩家不知道下面还有东西
  check(!st.haulScrolls || st.haulFade, '物资列表可滚但没有渐隐提示', tag);
  check(!st.midScrolls || st.midFade, '结算中段可滚但没有渐隐提示', tag);
  // 营地配装行三段都要有值
  check(camp.gearSegs === 3 && camp.gearline.split('·').every((s) => s.trim()),
    `配装行残缺: "${camp.gearline}"`, tag);

  await page.close();
}

await browser.close();
srv.close();
console.log('');
if (problems.length) {
  console.log('发现问题:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('✓ 四种分辨率下营地 / HUD / 结算都没有溢出或被切');