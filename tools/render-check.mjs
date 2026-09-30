// 首屏渲染验收：加载 → 部署 → 走动 → 截图。用完 headless 硬件 GL 才跑得动。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 测 dist 打包产物（先 npm run build），不是源码。
// 源码里 `import * as THREE from 'three'` 是裸模块名，要靠 index.html 里的
// importmap 解析，而那份 importmap 只在 dev 成立 —— 生产构建没有它，
// three 由 Vite 打进 bundle。所以自建静态服务器喂源码会直接报
// "Failed to resolve module specifier three"。要么用 npm run dev，要么测 dist。
const ROOT = path.resolve('dist');
const OUT = path.resolve(process.env.SHOT_DIR || 'C:/Users/derek/AppData/Local/Temp/opencode/abyss/shots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.woff2': 'font/woff2',
};

const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return res.writeHead(404).end('not found');
  }
  const b = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
const PORT = 8951;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)); });

const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a);
const shot = async (n) => { const p = path.join(OUT, n + '.png'); await page.screenshot({ path: p }); log('截图', p); return p; };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  log('等待资源加载…');
  await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });
  log('资源就绪');
  await page.waitForTimeout(1500);
  await shot('r01-boot');

  const stats = await page.evaluate(() => ({
    r: window.__abyss.stats(),
    world: {
      colliders: window.__abyss.world.colliders.length,
      draws: window.__abyss.world.draw.length,
      draws3d: window.__abyss.worldStats().drawCalls,
      props: window.__abyss.worldStats().propCount,
    },
  }));
  log('渲染统计', JSON.stringify(stats.r));
  log('地图统计', JSON.stringify(stats.world));

  log('部署…');
  const dep = await page.evaluate(() => {
    const rd = window.__abyss.deploy();
    return rd ? { enemies: rd.enemies.length, containers: rd.containers.length, extracts: rd.extracts.map(e => e.name) } : null;
  });
  log('部署结果', JSON.stringify(dep));
  await page.waitForTimeout(2500);
  await shot('r02-deployed');

  // 走动：按住 W 冲刺 2.5 秒
  log('移动测试…');
  const p0 = await page.evaluate(() => { const p = window.__abyss.raid.player; return { x: p.x, z: p.z }; });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  const p1 = await page.evaluate(() => { const p = window.__abyss.raid.player; return { x: p.x, z: p.z, y: p.y, o2: p.o2 }; });
  log('位移', Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1) + 'm', '深度', (-p1.y).toFixed(1) + 'm', '氧气', p1.o2.toFixed(0));
  await shot('r03-moved');

  // 射击
  log('开火测试…');
  await page.mouse.move(760, 320);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const fire = await page.evaluate(() => {
    const r = window.__abyss.raid;
    return { mag: r.player.slots[r.player.cur].mag, kills: r.kills, events: r.events.length };
  });
  log('开火后', JSON.stringify(fire));
  await shot('r04-fired');

  const stats2 = await page.evaluate(() => window.__abyss.stats());
  log('渲染统计(后)', JSON.stringify(stats2));
  log('错误', errs.length ? '\n' + errs.slice(0, 8).join('\n') : '(无)');
} catch (e) {
  log('FAIL', e.message.slice(0, 300));
  try { await shot('r99-fail'); } catch { /* ignore */ }
  if (errs.length) log('错误\n' + errs.slice(0, 10).join('\n'));
} finally {
  await browser.close();
  srv.close();
  log('done');
}
