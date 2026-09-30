// 跨种子测画面亮度。随机出生点会让单次测量毫无意义 ——
// 这个游戏有 8 个出生点，画面亮不亮取决于开局落在哪，所以必须采样。
//
// 测的是 dist 打包产物（先 npm run build），理由见 ROOT 上面那句。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

// 测 **dist 打包产物**而不是源码：源码里 `import * as THREE from 'three'` 是裸模块名，
// 靠 index.html 里那份 importmap 解析。那份 importmap 只在 dev 成立
// （生产构建里没有，three 由 Vite 打进 bundle），所以自建静态服务器喂源码会直接
// "Failed to resolve module specifier three"。这里起一个 serve dist 的服务器。
const ROOT = path.resolve('dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end('nf');
  const b = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
await new Promise((r) => srv.listen(8981, '127.0.0.1', r));

const N = Number(process.argv[2] || 8);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 140)));
await page.goto('http://127.0.0.1:8981/?seed=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });

const spawns = await page.evaluate(() => window.__abyss.world.spawns.map((s) => [+s.x, +s.z]));
const rows = [];
for (let i = 0; i < spawns.length; i++) {
  const [sx, sz] = spawns[i];
  await page.evaluate(async ([x, z]) => {
    const A = window.__abyss;
    if (!A.raid) A.deploy();
    const p = A.raid.player;
    p.x = x; p.z = z; p.vx = 0; p.vz = 0;
    A.CAM.cur.set(x, p.y || 0, z);
  }, [sx, sz]);
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const gl = window.__abyss.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4 * w * h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, mx = 0, dark = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
      s += l; if (l > mx) mx = l; if (l < 12) dark++; n++;
    }
    return { avg: +(s / n).toFixed(1), max: mx, darkPct: Math.round(dark / n * 100) };
  });
  rows.push(r);
  console.log(`出生点${i} (${sx},${sz})`.padEnd(26), JSON.stringify(r), r.darkPct > 55 ? '  <<< 过暗' : '');
}
const avg = rows.reduce((s, r) => s + r.avg, 0) / rows.length;
const darkAvg = rows.reduce((s, r) => s + r.darkPct, 0) / rows.length;
console.log(`\n平均亮度 ${avg.toFixed(1)} · 平均过暗像素 ${darkAvg.toFixed(0)}%`);
console.log(`最暗 ${Math.min(...rows.map(r => r.avg))} · 最亮 ${Math.max(...rows.map(r => r.avg))}`);
if (avg < 45) console.log('→ 整体偏暗，需要提亮（曝光或半球光）');
if (darkAvg > 45) console.log('→ 大量像素接近纯黑，雾/环境光需要加强');
await browser.close();
srv.close();
