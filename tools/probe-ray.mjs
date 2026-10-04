// 从摄像机向「绿色像素」发射线，报出命中的物件。
//
// 这是定位「屏幕上这块东西到底是什么」最直接的办法 —— 之前靠颜色统计
// 和按类型隐藏查了好几轮都定位不到（海草是 merge 过的 BufferGeometry，
// 按 geometry.type 筛不出来；撤离环/光柱也不是）。
// 射线直接给出 object / material / 材质色，一次就对。
//
// 用法：node tools/probe-ray.mjs <zone> [r> b> g-]
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const srv = http.createServer((rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]); if (u === '/') u = '/index.html';
  const f = path.resolve(path.join(ROOT, u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return rs.writeHead(404).end('404');
  const b = fs.readFileSync(f);
  rs.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': b.length });
  rs.end(b);
});
await new Promise((r) => srv.listen(4227, '127.0.0.1', r));
const br = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pg = await br.newPage({ viewport: { width: 1000, height: 620 } });
const zone = process.argv[2] || 'derrick';

await pg.goto(`http://127.0.0.1:4227/?seed=9`, { waitUntil: 'domcontentloaded' });
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

console.log(JSON.stringify(await pg.evaluate((zid) => {
  const T = window.__abyss;
  const THREE = T.THREE;
  if (!THREE) return { err: 'window.__abyss.THREE 不存在，无法构造 Raycaster' };
  const gl = T.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(4 * w * h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  // 找**明亮薄荷绿**像素，聚类取几个代表点（相隔至少 60px）。
  //
  // 判据必须卡亮度。之前的 `g > r+30 && g > 90` 会把整个青色甲板
  // （deck 材质 #36484c = rgb(54,72,76)，受光后绿高于红）也算进去 ——
  // 于是 7500 个「绿色像素」采样出来的射线**全部打在甲板上**，
  // 看起来像「绿色就是甲板」，其实找错了对象。
  //
  // 薄荷绿碎片是 #5cffc8 一类：亮度高（各通道都 >140）且绿是最高通道。
  const pts = [];
  const isMint = (r, g, b) => g > 140 && r > 110 && b > 110 && g >= r && g >= b && (g - Math.min(r, b)) < 90;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      if (isMint(px[i], px[i + 1], px[i + 2])) pts.push([x, y]);
    }
  }
  const picked = [];
  for (const p of pts) {
    if (picked.length >= 5) break;
    if (picked.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 60)) picked.push(p);
  }

  const rc = new THREE.Raycaster();
  const hits = picked.map(([sx, sy]) => {
    // readPixels 的 y 是左下原点，NDC 也是左下原点 —— 不用再取负。
    const ndc = new THREE.Vector2((sx / w) * 2 - 1, (sy / h) * 2 - 1);
    rc.setFromCamera(ndc, T.camera);
    const is = rc.intersectObjects(T.scene.children, true).filter((i) => i.object.visible);

    // **只看第一击**。之前的版本取 slice(0,3)，结果每个采样点都返回
    // 「甲板 + 地板 + ...」—— 因为射线总能打到地面，而绿色那层在
    // 地面之上、可能是 ShaderMaterial 覆盖层或者 depthWrite:false 的透明片，
    // 排在命中列表后面。一看就以为是地面，不会怀疑上面还有东西。
    // 报告里保留后面的命中，但要标出 index，方便看谁在最前面。
    return {
      // 报告时转回「左上原点」，和截图/PIL 的习惯一致
      screen: [sx, h - sy],
      first: is[0] ? {
        geo: is[0].object.geometry?.type,
        mat: is[0].object.material?.name || is[0].object.material?.type,
        color: is[0].object.material?.color ? '#' + is[0].object.material.color.getHexString() : null,
        transparent: !!is[0].object.material?.transparent,
        depthWrite: is[0].object.material?.depthWrite,
        dist: +is[0].distance.toFixed(2),
      } : null,
      // 命中列表里所有「材质色偏绿」的，逐个列出来 —— 这才是要找的那层
      greenish: is.filter((i) => {
        const c = i.object.material?.color;
        return c && c.g > c.r * 1.15;
      }).slice(0, 4).map((i, k) => ({
        idx: is.indexOf(i),
        mat: i.object.material?.name || i.object.material?.type,
        color: '#' + i.object.material.color.getHexString(),
        transparent: !!i.object.material?.transparent,
        dist: +i.distance.toFixed(2),
      })),
      totalHits: is.length,
    };
  });
  return { greenPixels: pts.length, sampled: picked.length, hits };
}, zone), null, 1));
await br.close();
srv.close();
