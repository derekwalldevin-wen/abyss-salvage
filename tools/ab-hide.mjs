// 定点归因：隐藏指定颜色/类型的 mesh，截图对比。
//
// 用法：node tools/ab-hide.mjs <zone> <hexColor>
// 例：  node tools/ab-hide.mjs derrick 2f6b4a
//
// 之前排查绿色碎条时，靠「按 geometry.type 隐藏」查了三四轮都没命中 ——
// 因为海草 260 根已经 merge 成单个 BufferGeometry，按类型根本筛不出来。
// 按**材质色**筛才定位到。
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const OUT = 'C:/Users/derek/AppData/Local/Temp/opencode/abyss/shots';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const srv = http.createServer((rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]); if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return rs.writeHead(404).end('404');
  const b = fs.readFileSync(f);
  rs.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  rs.end(b);
});
await new Promise((r) => srv.listen(4225, '127.0.0.1', r));
const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await br.newPage({ viewport: { width: 1000, height: 620 } });

const zone = process.argv[2] || 'derrick';
const hex = process.argv[3] || '';

await pg.goto(`http://127.0.0.1:4225/?seed=9`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 200 });
await pg.evaluate((zid) => {
  document.getElementById('camp').hidden = true;
  document.getElementById('hud').hidden = false;
  document.body.classList.add('in-raid');
  window.__abyss.deploy();
  const A = window.__abyss;
  const z = A.world.zones.find((v) => v.id === zid);
  const [x0, z0, x1, z1] = z.rect;
  const x = Math.round((x0 + x1) / 2), zz = Math.round((z0 + z1) / 2);
  const p = A.raid.player;
  p.x = x; p.z = zz; p.vx = 0; p.vz = 0; p.y = A.world.heightAt(x, zz);
  A.CAM.cur.set(x, p.y, zz);
}, zone);
await pg.waitForTimeout(1400);
await pg.screenshot({ path: path.join(OUT, `hid-before-${zone}.png`) });

if (hex) {
  const n = await pg.evaluate((hx) => {
    let hid = 0;
    window.__abyss.scene.traverse((o) => {
      if (o.isMesh && o.material?.color?.getHexString() === hx) { o.visible = false; hid++; }
    });
    return hid;
  }, hex);
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: path.join(OUT, `hid-after-${zone}.png`) });
  console.log(`隐藏 #${hex} 的 mesh：${n} 个`);
  console.log(`  对比图 hid-before-${zone}.png / hid-after-${zone}.png`);
} else {
  console.log('只截了基线图。用法：node tools/ab-hide.mjs <zone> <hexColor>');
}
await br.close();
srv.close();
