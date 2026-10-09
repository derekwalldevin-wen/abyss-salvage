// 贴脸画质检查：把摄像机怼到小件道具旁边，验证 256 档在近距离下会不会糊。
//
// 为什么必须单独做：分档表把油桶/jerrycan/手推车压到 256×256，
// 理由是「屏幕上只是一丁点」。但玩家是会贴着油桶走的 ——
// 如果 256 在 3m 距离上就糊了，那这个档位就是拿画质换体积，
// 得改成 512。近景退化在全局亮度直方图上完全看不出来
// （avg 和 hist 都不会变），只能靠这个近距离截图判断。
//
// 用法：node tools/check-tex-closeup.mjs [before|after]
//   before 需要先从 glb-backup 还原原始 GLB 再跑
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const OUT = 'C:/Users/derek/AppData/Local/Temp/opencode/abyss/shots';
const TAG = process.argv[2] || 'after';
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const srv = http.createServer((rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]); if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return rs.writeHead(404).end('404');
  const b = fs.readFileSync(f);
  rs.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  rs.end(b);
});
await new Promise((r) => srv.listen(4231, '127.0.0.1', r));
const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
// 小视口 = 放大效果更明显（相当于把道具在屏幕上占更大比例）
const pg = await br.newPage({ viewport: { width: 900, height: 560 } });
await pg.goto(`http://127.0.0.1:4231/?seed=9`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 200 });
await pg.evaluate(() => { document.getElementById('camp').hidden = true; document.getElementById('hud').hidden = false; document.body.classList.add('in-raid'); window.__abyss.deploy(); });
await pg.waitForTimeout(900);

// 找场景里最近的一批小件（256 档），把玩家挪到旁边
const near = await pg.evaluate(() => {
  const A = window.__abyss;
  const SMALL = new Set(['Barrel_01', 'metal_jerrycan', 'propane_tank', 'hand_truck', 'security_light', 'portable_searchlight', 'industrial_pipe_lamp', 'hanging_industrial_lamp']);
  const hits = [];
  const g = A.scene.getObjectByName('static');
  const m = new (A.THREE ? A.THREE.Matrix4 : Object)();
  g.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const nm = o.material?.name || '';
    if (!SMALL.has(nm)) return;
    const mat = new A.THREE.Matrix4();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, mat);
      const p = new A.THREE.Vector3().setFromMatrixPosition(mat);
      hits.push({ model: nm, x: p.x, y: p.y, z: p.z });
    }
  });
  return hits.slice(0, 40);
});

if (!near.length) {
  console.log('没找到 256 档小件实例');
} else {
  // 取场景中心附近的那几个，摆开拍
  const cx = near.reduce((s, h) => s + h.x, 0) / near.length;
  const cz = near.reduce((s, h) => s + h.z, 0) / near.length;
  const p0 = near[0];
  await pg.evaluate(([x, z, mdl]) => {
    const A = window.__abyss, p = A.raid.player;
    p.x = x; p.z = z; p.vx = 0; p.vz = 0;
    p.y = A.world.heightAt(x, z);
    // 把摄像机压低、拉近，模拟「贴脸看」
    A.CAM.cur.set(x, p.y, z);
    A.CAM.dist = 9;
  }, [p0.x, p0.z, p0.model]);
  await pg.waitForTimeout(1500);
  const file = path.join(OUT, `tex-${TAG}-closeup.png`);
  await pg.screenshot({ path: file });
  console.log(`近距离截图 -> ${file}`);
  console.log(`对标道具 ${p0.model} @ (${p0.x.toFixed(1)}, ${p0.z.toFixed(1)})，附近小件 ${near.length} 个`);
}
await br.close();
srv.close();
