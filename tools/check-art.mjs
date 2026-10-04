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

/**
 * 固定站位 + 关掉单个效果，截一张对照图。
 *
 * 用途是**归因**：画面里出现看不懂的东西（棋盘格、过亮白块、整片青绿）时，
 * 一次只关一个效果再截一张，就能确定它是哪来的。
 * 之前 derrick 区域一大片规则棋盘格，肉眼猜了三轮（怀疑是透墙、
 * 怀疑是贴图、怀疑是阴影）都没定位，最后靠这个一次关一项定下来。
 */
async function abShot(name, { off = '', zone = 'derrick', extra = '' } = {}) {
  const q = new URLSearchParams();
  if (off) q.set('off', off);
  if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const qs = q.toString();
  await page.goto(`http://127.0.0.1:${PORT}/?seed=9${qs ? '&' + qs : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 500 });
  await page.evaluate((zid) => {
    document.getElementById('camp').hidden = true;
    document.getElementById('hud').hidden = false;
    document.body.classList.add('in-raid');
    window.__abyss.deploy();
    const A = window.__abyss;
    const z = A.world.zones.find((v) => v.id === zid);
    if (z) {
      const [x0, z0, x1, z1] = z.rect;
      const x = Math.round((x0 + x1) / 2), zz = Math.round((z0 + z1) / 2);
      const p = A.raid.player;
      p.x = x; p.z = zz; p.vx = 0; p.vz = 0; p.y = A.world.heightAt(x, zz);
      A.CAM.cur.set(x, p.y, zz);
    }
  }, zone);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(OUT, `ab-${name}.png`) });
  console.log('  对照图', name.padEnd(16), `off=${off || '(无)'}`, extra ? JSON.stringify(extra) : '');
}

if (process.argv.includes('--ab')) {
  console.log('归因对照（固定站位，一次只关一项）：');
  await abShot('base');
  await abShot('nost', { extra: { nost: '1' } });
  await abShot('noshadow', { off: 'shadow' });
  await abShot('nofog', { off: 'fog' });
  await abShot('debug-st', { extra: { stdebug: '1' } });
  await browser.close(); srv.close();
  process.exit(0);
}

// ---- 撤离光柱单独看 --------------------------------------------------
// mess 区域 avg=78、分布里 4%+9%+8%+2% 全落在中高亮度，是全场最亮的。
// 光柱是 AdditiveBlending，摄像机又正好站在撤离点旁边看它 ——
// 怀疑是光柱把自己的屏幕糊掉了，而不是「撤离点很亮」。
// 这个模式单独量化：摄像机站远一点再截，亮度应该显著降下来。
if (process.argv.includes('--beam')) {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=9`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__abyss, null, { timeout: 600000, polling: 500 });
  await page.evaluate(() => {
    document.getElementById('camp').hidden = true;
    document.getElementById('hud').hidden = false;
    document.body.classList.add('in-raid');
    window.__abyss.deploy();
  });
  await page.waitForTimeout(1000);
  const measure = async (label, offBeam) => {
    const r = await page.evaluate((kill) => {
      const A = window.__abyss;
      // 把光柱和底座环藏起来
      const hidden = [];
      A.scene.traverse((o) => {
        if (o.isMesh && o.material?.blending === 2 && o.geometry?.type === 'CylinderGeometry') { o.visible = !kill; hidden.push(o); }
        if (o.isMesh && o.geometry?.type === 'RingGeometry') { o.visible = !kill; hidden.push(o); }
      });
      return { hidden: hidden.length };
    }, offBeam);
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const gl = window.__abyss.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(4 * w * h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, n = 0; const hist = new Array(8).fill(0);
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += l; n++; hist[Math.min(7, Math.floor(l / 32))]++;
      }
      return { avg: +(sum / n).toFixed(1), hist: hist.map((v) => Math.round(v / n * 100)) };
    });
    console.log(`  ${label.padEnd(14)} avg=${String(m.avg).padStart(5)} 分布=${JSON.stringify(m.hist)}  (隐藏了 ${r.hidden} 个光柱网格)`);
    return m;
  };
  // 必须站到撤离点附近才有意义 —— 站远了光柱在画面里只有几个像素，
// 开/关自然量不出差别（踩过一次：两次读数完全相同，白跑一轮）。
await page.evaluate(() => {
  const A = window.__abyss;
  const e = (A.world.extracts || [])[0];
  if (!e) return;
  const p = A.raid.player;
  // 站在撤离点旁边 6m，而不是正上方 —— 正上方时摄像机在光柱内部，
  // 反而看不出它有多亮。
  p.x = e.x + 6; p.z = e.z; p.vx = 0; p.vz = 0;
  p.y = A.world.heightAt(p.x, p.z);
  A.CAM.cur.set(p.x, p.y, p.z);
});
await page.waitForTimeout(1200);
console.log('撤离光柱归因（站在撤离点旁 6m，只切换光柱可见性）：');
const on = await measure('光柱开', false);
const off = await measure('光柱关', true);
console.log(`  → 光柱贡献 avg ${on.avg} → ${off.avg}，差 ${(on.avg - off.avg).toFixed(1)}`
  + `（${(((on.avg - off.avg) / Math.max(1, off.avg)) * 100).toFixed(0)}% 相对提升）`);
  await page.screenshot({ path: path.join(OUT, 'beam-off.png') });
  await browser.close(); srv.close();
  process.exit(0);
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 140)));

// --dither：逐区域量出「透墙溶解」吃掉了多少像素。
// 透墙是 4×4 Bayer 有序抖动，本来是为了在固定斜角视角下看穿舱壁；
// 但溶解上限 0.62 意味着大面积墙体会出现**规则棋盘格**，近看非常刺眼。
// 之前只能靠肉眼在截图里找，现在直接读像素。
const DEBUG = process.argv.includes('--dither');

// **必须固定 seed**。默认是随机种子，而 check-art 会瞬移玩家 —— 每次地图
// 重新生成，撤离光柱/海草/道具分布全都不同，亮度自然对不上。
// 实测同一份代码连跑三次，mud 区域 avg 在 45 / 74 / 76 之间跳 ——
// 这种数字拿来对比改动毫无意义。
// （和之前那次「同代码两次量出 avg 20 vs 150」是同一个坑。）
const SEED = process.env.SEED || '9';
const qs = new URLSearchParams({ seed: SEED });
if (DEBUG) qs.set('stdebug', '1');

await page.goto(`http://127.0.0.1:${PORT}/?${qs}`, { waitUntil: 'domcontentloaded' });
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
  // 固定 seed 之后仍然会漂：游戏循环在跑，敌人/粒子/焦散动画每帧都在变，
  // 1100ms 不保证落在同一个动画相位上。取 3 帧的中位数 —— 单帧读数
  // 会被动画噪声带偏，中位数稳得多（实测 crane 在 45~53 之间跳）。
  const shots = [];
  for (let k = 0; k < 3; k++) {
    await page.waitForTimeout(360);
  const m = await page.evaluate(() => {
    const gl = window.__abyss.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4 * w * h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, n = 0, dark = 0, dissolve = 0; const hist = new Array(8).fill(0);
    // 品红倾向 = min(r,b) - g。用通道关系而不是绝对阈值 —— tone mapping 和
    // 色彩空间往返会让调试色偏离纯 (255,0,255)（实测读到 231,40,217）。
    let top = -999, topPx = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = (r + g + b) / 3;
      // 品红倾向 = min(r,b) - g。用关系而不是绝对阈值 —— tone mapping 和
      // 色彩空间往返会让调试色偏离纯 (255,0,255)（实测读到 231,40,217）。
      const score = Math.min(r, b) - g;
      if (score > top) { top = score; topPx = [r, g, b]; }
      if (score > 90) dissolve++;
      sum += l; if (l < 10) dark++; n++; hist[Math.min(7, Math.floor(l / 32))]++;
    }
    // 溶解率保留两位小数：实测 derrick 只有 0.31%，四舍五入成整数就是 0，
    // 于是「量到了」和「没量到」在输出上一模一样 —— 工具等于没用。
    return { avg: sum / n, darkPct: dark / n * 100, dissolvePct: dissolve / n * 100,
      top, topPx, hist: hist.map(v => v / n * 100) };
  });
    shots.push(m);
  }
  // 取中位数。avg / darkPct / dissolvePct 都取中位数；
  // 直方图按元素分别取中位数再归一化到 100%。
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const m = {
    avg: +med(shots.map((s) => s.avg)).toFixed(1),
    darkPct: Math.round(med(shots.map((s) => s.darkPct))),
    dissolvePct: +med(shots.map((s) => s.dissolvePct)).toFixed(2),
    top: med(shots.map((s) => s.top)),
    hist: (() => {
      const h = m_hist(shots);
      const t = h.reduce((a, b) => a + b, 0);
      return h.map((v) => Math.round(v / t * 100));
    })(),
  };
  function m_hist(list) {
    const n = list[0].hist.length;
    const out = new Array(n).fill(0);
    for (let i = 0; i < n; i++) out[i] = med(list.map((s) => s.hist[i]));
    return out;
  }

  const flag = m.darkPct > 55 ? '  <<< 过暗' : '';
  // 溶解率 0 不算错误：站位离墙远时本就不该有溶解（实测只有 derrick 有 0.31%）。
  // 判据是「有没有刺眼的棋盘格」，阈值 3%。
  const dflag = DEBUG
    ? ` 溶解${String(m.dissolvePct).padStart(5)}%${m.dissolvePct > 3 ? ' <<< 棋盘格刺眼' : ''}`
    : '';
  console.log(id.padEnd(8), `(${r.x},${r.z})`.padEnd(12), `avg=${String(m.avg).padStart(5)} 暗${String(m.darkPct).padStart(3)}% 分布=${JSON.stringify(m.hist)}${flag}${dflag}`);
  await page.screenshot({ path: path.join(OUT, `${DEBUG ? 'dither-' : 'art-'}${id}.png`) });
}
await browser.close();
srv.close();