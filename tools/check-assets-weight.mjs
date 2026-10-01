// 资源体检：加载耗时分解 + 实际用到哪些资产 + 运行时开销。
// 目的很具体：找出「下载了但没用」的部分，以及时间到底花在哪一段。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary',
};
// 按字节数记录每个请求，用来定位「大文件」
const bytes = [];
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end('404');
  const b = fs.readFileSync(f);
  bytes.push({ url: u.replace('/assets/', ''), n: b.length, t: Date.now() });
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
const PORT = 4201;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const t0 = Date.now();
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });

// 在页面里给每个请求打时间戳
await page.addInitScript(() => {
  window.__net = [];
  const open = window.fetch;
  window.__t0 = performance.now();
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 100 });
const bootMs = Date.now() - t0;
console.log(`\n=== 加载耗时（本地服务器，排除网络）===\n  从导航到可用：${bootMs} ms`);

const group = {};
for (const b of bytes) {
  const k = b.url.includes('models/') ? '模型 GLB' : b.url.includes('tex/') ? '贴图' : b.url.includes('hdri/') ? 'HDRI' : b.url.includes('.js') ? 'JS' : b.url.includes('.css') ? 'CSS' : 'HTML/其他';
  group[k] = group[k] || { n: 0, count: 0 };
  group[k].n += b.n; group[k].count++;
}
console.log('\n  分类          字节        占比   文件数');
const total = bytes.reduce((s, b) => s + b.n, 0);
for (const [k, v] of Object.entries(group).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(12)} ${(v.n / 1024).toFixed(0).padStart(7)} KB  ${(v.n / total * 100).toFixed(0).padStart(4)}%  ${String(v.count).padStart(4)}`);
}
console.log(`  ${'合计'.padEnd(12)} ${(total / 1024).toFixed(0).padStart(7)} KB`);

await page.evaluate(() => window.__abyss.deploy());
await page.waitForTimeout(2500);

// 运行时实际用到的模型
const used = await page.evaluate(() => {
  const A = window.__abyss;
  const g = A.scene.getObjectByName('static');
  const names = new Map();       // matName -> 实例数
  g.traverse(o => {
    if (!o.isInstancedMesh) return;
    const n = o.material?.name || '?';
    names.set(n, (names.get(n) || 0) + o.count);
  });
  const declared = Object.keys(A.assets.models);
  const unused = declared.filter(n => !names.has(n));
  return {
    instanced: [...names.entries()].map(([k, v]) => [k, v]).sort((a, b) => b[1] - a[1]),
    unusedModels: unused,
    stats: A.stats(),
    worldStats: A.worldStats(),
  };
});
console.log(`\n=== 实际摆上场的模型（${used.instanced.length} 种 / 声明 ${Object.keys(used.instanced).length === 0 ? 33 : 33}）===`);
for (const [k, v] of used.instanced) console.log(`  ${String(v).padStart(4)} 个  ${k}`);
console.log('\n*** 下载了但一个都没摆出来的模型:', used.unusedModels.length);
if (used.unusedModels.length) {
  let w = 0;
  for (const m of used.unusedModels) { const p = path.join(ROOT, 'assets/models', m + '.slim.glb'); if (fs.existsSync(p)) w += fs.statSync(p).size; }
  console.log(`    ${used.unusedModels.join(', ')}`);
  console.log(`    白下载 ${(w / 1048576).toFixed(2)} MB`);
}

console.log('\n=== 运行时开销 ===');
console.log('  ', JSON.stringify({ drawCalls: used.stats.drawCalls, tris: used.stats.tris, geoms: used.stats.geoms, tex: used.stats.tex }));
const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
const gpu = await page.evaluate(() => {
  const gl = window.__abyss.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a';
});
console.log('  JS 堆', mem ? mem + ' MB' : 'n/a', '  GPU:', String(gpu).slice(0, 60));

// 帧率
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t = performance.now();
  const tick = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t) / 1000))); };
  requestAnimationFrame(tick);
}));
console.log('  帧率(无头 GL 下，仅供参考):', fps, 'fps');

await browser.close();
srv.close();