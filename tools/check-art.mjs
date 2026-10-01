// 美术验收：站在每个区域的中心截图 + 量亮度分布。
//
// 采样点**从区域矩形反查**，不能写死坐标 —— 地图从 260m 缩到 182m 之后，
// 写死的点会落到图外，画面全黑还会被误判成「渲染坏了」（踩过一次）。
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
const PORT = 4195;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 140)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 500 });
await page.evaluate(() => { document.getElementById('camp').hidden = true; document.getElementById('hud').hidden = false; document.body.classList.add('in-raid'); window.__abyss.deploy(); });
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const T = window.__abyss, g = T.scene.getObjectByName('static');
  let inst = 0; g.traverse(o => { if (o.isInstancedMesh) inst++; });
  return { models: Object.keys(T.assets.models).length, errs: (T.assets.errs?.models || []).length,
    instBatches: inst, props: T.worldStats().propCount, draws: T.world.draw.length };
});
console.log('场景:', JSON.stringify(info));

// 站位点从 world.zones 的矩形中心取 —— layout.js 是唯一真相来源，
// 写死坐标在地图缩放后会落到图外（画面全黑还会被误判成渲染坏了）。
const TARGETS = ['boxes', 'pump', 'mess', 'mud', 'sealed', 'crane', 'derrick', 'bunk'];
for (const id of TARGETS) {
  const r = await page.evaluate((zid) => {
    const A = window.__abyss;
    const z = A.world.zones.find(v => v.id === zid);
    if (!z) return { skip: true };
    const [x0, z0, x1, z1] = z.rect;
    const x = Math.round((x0 + x1) / 2), zz = Math.round((z0 + z1) / 2);
    const p = A.raid.player;
    p.x = x; p.z = zz; p.vx = 0; p.vz = 0; p.y = A.world.heightAt(x, zz);
    A.CAM.cur.set(x, p.y, zz);
    return { x, z: zz };
  }, id);
  if (r.skip) { console.log(id.padEnd(8), '区域不存在'); continue; }
  await page.waitForTimeout(1100);
  const m = await page.evaluate(() => {
    const gl = window.__abyss.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4 * w * h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, n = 0, dark = 0; const hist = new Array(8).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
      sum += l; if (l < 10) dark++; n++; hist[Math.min(7, Math.floor(l / 32))]++;
    }
    return { avg: +(sum / n).toFixed(1), darkPct: Math.round(dark / n * 100), hist: hist.map(v => Math.round(v / n * 100)) };
  });
  const flag = m.darkPct > 55 ? '  <<< 过暗' : '';
  console.log(id.padEnd(8), `(${r.x},${r.z})`.padEnd(12), `avg=${String(m.avg).padStart(5)} 暗${String(m.darkPct).padStart(3)}% 分布=${JSON.stringify(m.hist)}${flag}`);
  await page.screenshot({ path: path.join(OUT, `art-${id}.png`) });
}await browser.close();
srv.close();