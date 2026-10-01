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

const DIR = path.resolve('assets/models');

/**
 * 分档简化率。
 *
 * 之前所有模型统一 `-si 0.25`，结果小道具和一个巨型门面的顶点预算一样多。
 * 但它们的**屏幕占比差两个数量级**：油桶在 20m 镜头里就十几个像素，
 * 吊车基座是地标、要走近看。所以按「玩家会凑多近看」分档：
 *
 *  - 地标/大体量（吊车、管段）：0.25，走近了还要经得起看
 *  - 集装箱这种要钻进去的：0.20
 *  - 油桶、木箱、工具这类小件：0.10，屏幕上一丁点，顶点纯属浪费
 *
 * 统一档实测：模型 14.4MB。分档后见运行输出。
 */
const TIERS = [
  { re: /overhead_crane|modular_industrial_pipes|dutch_ship/, si: '0.25' },
  { re: /industrial_pastic_container|treasure_chest|old_military_compressor|portable_generator|modular_airduct/, si: '0.20' },
  { re: /.*/, si: '0.10' },
];
const rateFor = (name) => TIERS.find((t) => t.re.test(name)).si;

// 已经有 .slim.glb 的就地再简化（原始 .glb 在之前的清理里删掉了）。
// 再次 pack 依然有效：它会重新量化、合并材质、抽稀顶点。
// 对已经是 .slim 的文件，用同一个档位再跑一次会继续变���小，但边际收益递减，
// 所以这里的档位是「累计目标」的相对收缩。
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb'));

const iface = {
  read: (p) => new Uint8Array(fs.readFileSync(p)),
  write: (p, data) => fs.writeFileSync(p, Buffer.from(data)),
};

let before = 0, after = 0, fail = 0;
const rows = [];
for (const f of files) {
  const src = path.join(DIR, f);
  const tmp = path.join(DIR, '_tmp_' + f);
  const size = fs.statSync(src).size;
  before += size;
  const si = rateFor(f.replace('.glb', '').replace('.slim', ''));
  try {
    await pack(['-i', src, '-o', tmp, '-si', si, '-mi', '-km'], iface);
    // 只有真的变小了才替换，否则保留原文件（有些模型再抽会掉关键细节）
    const out = fs.statSync(tmp).size;
    if (out < size) { fs.renameSync(tmp, src); after += out; }
    else { fs.unlinkSync(tmp); after += size; }
    rows.push([f.replace('.slim.glb', ''), si, size, out]);
  } catch (e) {
    console.log('  失败', f, '—', String(e.message || e).slice(0, 80));
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    fail++; after += size;
  }
}
rows.sort((a, b) => b[2] - a[2]);
console.log('  模型                            档位      原→新');
for (const [n, si, a, b] of rows) {
  console.log(`  ${n.padEnd(30)} ${si.padStart(5)}  ${(a / 1024).toFixed(0).padStart(6)}K→${(b / 1024).toFixed(0).padStart(6)}K`);
}
console.log(`\n模型合计 ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB` +
  (fail ? `（${fail} 个失败）` : ''));
