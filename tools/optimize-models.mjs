// 用 gltfpack 重新优化模型：加面数简化 (-si)、实例化 (-mi)、合并材质 (-km)。
//
// 为什么必须做：原始 GLB 完全没有简化过 —— 一个塑料箱 18,320 面、
// 一台空压机 78,786 面。全图 327 个道具 = 516 万三角面，
// 加上阴影 pass 每帧画两遍，实测 draw call 557 / 14M 三角面，浏览器直接卡死。
//
// -si 0.25：简化到 25% 面数。镜头离道具 20m，这个量级肉眼看不出差别。
// 不加 -tc：本机 WASM 版没编 BasisU，开了会直接失败。
// 不加 -noq：会把量化取消掉，文件反而更大（之前踩过）。
//
// 用法：node tools/optimize-models.mjs [简化率]

import fs from 'node:fs';
import path from 'node:path';
import { pack } from 'gltfpack';

const RATE = process.argv[2] || '0.25';
const DIR = path.resolve('assets/models');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.opt.glb'));

const iface = {
  read: (p) => new Uint8Array(fs.readFileSync(p)),
  write: (p, data) => fs.writeFileSync(p, Buffer.from(data)),
};

let before = 0, after = 0, fail = 0;
for (const f of files) {
  const src = path.join(DIR, f);
  const dst = path.join(DIR, f.replace('.opt.glb', '.slim.glb'));
  const size = fs.statSync(src).size;
  before += size;
  try {
    await pack(['-i', src, '-o', dst, '-si', RATE, '-mi', '-km'], iface);
  } catch (e) {
    console.log('  失败', f, '—', String(e.message || e).slice(0, 90));
    fail++;
    continue;
  }
  const out = fs.statSync(dst).size;
  after += out;
  console.log('  ', f.padEnd(40), (size / 1024).toFixed(0).padStart(6) + 'K →',
    (out / 1024).toFixed(0).padStart(6) + 'K', ((out / size) * 100).toFixed(0) + '%');
}
console.log(`\n合计 ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB` +
  (fail ? `（${fail} 个失败）` : ''));
console.log('新文件后缀 .slim.glb。确认没问题后把 materials.js 的路径改过去，再删旧的 .opt.glb。');
