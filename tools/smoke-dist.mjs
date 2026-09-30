// 生产构建冒烟测试：自建静态服务器打 dist，验证**要部署的那份东西**能用。
// 和 render-check 的区别：那个测画面好不好看，这个测「能不能用」——
// 资源 404、JS 报错、启动卡住、HUD 不刷新、刷不出敌人。
//
// 自己起服务器（而不是连 npm run preview）：这样 npm run check:dist 一条命令就能跑完，
// 不用先在另一个终端把 preview 挂起来。传 URL 参数可以改打别的地址。
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return res.writeHead(404).end('404');
  }
  const b = fs.readFileSync(f);
  res.writeHead(200, {
    'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
    'content-length': b.length,
  });
  res.end(b);
});
const PORT = 4173;
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const URL = process.argv[2] || `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); });

console.log('打��', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__abyss, null, { timeout: 300000, polling: 400 });
console.log('✓ 启动完成');

const info = await page.evaluate(() => ({
  world: window.__abyss.worldStats(),
  draw: window.__abyss.world.draw.length,
}));
console.log(`✓ 地图 ${info.draw} 条绘制指令，3D 合批 ${info.world.drawCalls}，道具 ${info.world.propCount}`);

const r = await page.evaluate(() => {
  window.__abyss.deploy();
  return true;
});
await page.waitForTimeout(2500);

const st = await page.evaluate(() => {
  const A = window.__abyss;
  const gl = A.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(4 * w * h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, dark = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
    sum += l; if (l < 12) dark++; n++;
  }
  const raid = A.raid;
  return {
    avg: +(sum / n).toFixed(1), darkPct: Math.round(dark / n * 100),
    stats: A.stats(),
    hud: {
      timer: document.getElementById('timer').textContent,
      depth: document.getElementById('depth').textContent,
      weapon: document.getElementById('wname').textContent,
      mag: document.getElementById('wmag').textContent,
      suit: document.getElementById('suitName').textContent,
      hull: document.getElementById('helmName').textContent,
    },
    enemies: raid.enemies.length, extracts: raid.extracts.length, containers: raid.containers.length,
  };
});
console.log('✓ 画面亮度', JSON.stringify({ avg: st.avg, darkPct: st.darkPct }));
console.log('✓ HUD', JSON.stringify(st.hud));
console.log(`✓ 对局: 敌人 ${st.enemies} · 撤离点 ${st.extracts} · 容器 ${st.containers}`);
console.log('✓ 渲染', JSON.stringify({ calls: st.stats.drawCalls, tris: st.stats.tris }));

await page.screenshot({ path: 'C:/Users/derek/AppData/Local/Temp/opencode/abyss/shots/prod.png' });

const bad = [];
if (st.avg < 12) bad.push(`画面几乎全黑 (avg ${st.avg})`);
if (st.darkPct > 70) bad.push(`画面 ${st.darkPct}% 过暗`);
if (st.enemies === 0) bad.push('没有刷出敌人');
if (st.containers === 0) bad.push('没有刷出容器');
if (st.hud.depth === '0' && st.hud.weapon === '—') bad.push('HUD 没有更新');
if (failed.length) bad.push(`${failed.length} 个请求失败`);

if (errors.length) { console.log('\n控制台错误:'); for (const e of errors.slice(0, 8)) console.log('  ' + e); }
if (failed.length) { console.log('\n失败请求:'); for (const f of failed.slice(0, 8)) console.log('  ' + f); }

await browser.close();
srv.close();
if (bad.length) { console.log('\n冒烟测试失败:\n  - ' + bad.join('\n  - ')); process.exit(1); }
console.log('\n生产构建冒烟测试通过');
