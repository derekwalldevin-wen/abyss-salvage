// 无头验证：20MB 资产能否真的被加载（GLB / HDR / 贴图）
// 用 Playwright 跑真实 WebGL，因为 three 的 GLTFLoader 依赖 DOM。
//
// 读的是**游戏自己的加载结果**（window.__abyss.assets），不在这里 import three：
//   1. 生产构建里 three 已被打进 bundle，没有裸模块名可 import；
//   2. 更重要的是让这个检查走游戏真正的那条加载路径 —— 自己另写一套
//      import + loadAsync 只能证明「文件能解析」，证明不了「游戏会用到它」。
//      实测真出过问题：模型路径从 .opt.glb 改成 .slim.glb 时，
//      只有游戏自己的加载器才发现全部 404。
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' };

const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(path.resolve(ROOT)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return res.writeHead(404).end('nope');
  }
  const b = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  res.end(b);
});
const PORT = 8944;
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
// 等 boot() 把全部资产加载完并挂上 __abyss
await page.waitForFunction(() => !!window.__abyss && !!window.__abyss.assets, null, { timeout: 300000, polling: 400 });

// 读游戏自己加载完的资产，不重新加载一遍
const report = await page.evaluate(async () => {
  const A = window.__abyss;
  const a = A.assets;
  const models = [];
  for (const [n, scene] of Object.entries(a.models)) {
    let tri = 0, mesh = 0;
    const mats = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      mesh++;
      const g = o.geometry;
      tri += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) mats.add(m.uuid);
    });
    models.push({ n, mesh, tri: Math.round(tri), mats: mats.size, ok: true });
  }
  const tex = [];
  for (const [s, t] of Object.entries(a.tex)) {
    for (const k of ['map', 'normalMap', 'armMap']) {
      const x = t[k];
      tex.push({ s: `${s}.${k}`, w: x?.image?.width || 0, h: x?.image?.height || 0, ok: !!x && !!x.image });
    }
  }
  const hdr = Object.entries(a.env).map(([h, x]) => ({ h, ok: !!x }));
  return { models, tex, hdr, errs: a.errs?.models || [] };
});

console.log(`--- 模型（游戏实际加载 ${report.models.length} 个）---`);
for (const m of report.models) console.log('  ', `✓ ${m.n.padEnd(30)} mesh=${String(m.mesh).padStart(3)} 三角=${String(m.tri).padStart(6)} 材质=${m.mats}`);
console.log(`--- 贴图（${report.tex.length} 张）---`);
for (const t of report.tex) console.log('  ', t.ok ? `✓ ${t.s.padEnd(34)} ${t.w}x${t.h}` : `✗ ${t.s}`);
console.log('--- HDRI ---');
for (const h of report.hdr) console.log('  ', h.ok ? `✓ ${h.h}` : `✗ ${h.h}`);
if (report.errs.length) { console.log('--- 加载失败 ---'); for (const e of report.errs) console.log('  ✗ ' + e.name + '  ' + e.err); }
if (errs.length) console.log('--- 页面错误 ---\n' + errs.slice(0, 5).join('\n'));

await browser.close();
srv.close();
const bad = report.errs.length
  + report.models.filter(m => !m.ok).length
  + report.tex.filter(t => !t.ok).length
  + report.hdr.filter(h => !h.ok).length;
console.log(bad ? `\n${bad} 项失败` : `\n全部资产加载通过（${report.models.length} 模型 / ${report.tex.length} 贴图 / ${report.hdr.length} HDRI）`);
process.exit(bad ? 1 : 0);
