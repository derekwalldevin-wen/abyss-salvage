// 找出哪些几何体含 NaN，以及它们来自哪种 draw
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end('nf');
  const b = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
await new Promise((r) => srv.listen(8953, '127.0.0.1', r));

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://127.0.0.1:8953/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });

const r = await page.evaluate(() => {
  const A = window.__abyss, T = A.scene;
  const bad = [];
  const check = (o, tag) => {
    const g = o.geometry;
    if (!g) return;
    const p = g.attributes && g.attributes.position;
    if (!p) return;
    const a = p.array;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) { bad.push({ tag, type: o.type, name: o.name || '', inst: o.isInstancedMesh ? o.count : 0, at: i, len: a.length }); return; }
    }
  };
  T.traverse((o) => { if (o.isMesh) check(o, 'mesh'); });

  // 按 draw 分类统计，看是哪类产生的
  const kinds = {};
  for (const d of A.world.draw) kinds[d.kind] = (kinds[d.kind] || 0) + 1;

  // 检查 draw 数据本身有没有 undefined/NaN
  const badDraw = [];
  for (const d of A.world.draw) {
    for (const k of ['x', 'y', 'z', 'x0', 'x1', 'y0', 'y1', 'z0', 'z1', 'w', 'h', 'd', 's']) {
      if (k in d && !Number.isFinite(d[k])) { badDraw.push({ kind: d.kind, key: k, val: String(d[k]) }); break; }
    }
  }
  return { badGeo: bad.slice(0, 12), badGeoCount: bad.length, kinds, badDraw: badDraw.slice(0, 12), badDrawCount: badDraw.length };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
srv.close();
