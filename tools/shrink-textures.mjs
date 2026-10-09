// GLB 贴图分档降分辨率。
//
// 为什么不是上 KTX2：先量了才决定 ——
//   模型 7.72MB 里 **73%（5.61MB）是内嵌贴图**，而且 **83 张全是 1024×1024**。
//   给一个 0.7m 的油桶和 6.1m 的集装箱发一样的 1024² 贴图，
//   真正被浪费的是**像素数**，不是编码效率。
//
// KTX2/BasisU 在这里收益有限：这些贴图**已经是 JPEG**，
// ETC1S 在同等画质下的字节数和 JPEG 是一档（都靠变换+熵编码），
// 它真正的优势是 GPU 原生格式（省显存、免运行时解压），
// 而省下载量要靠降像素 —— 那是 4~16 倍，任何编解码器都比不了。
//
// 而且 WASM 版 gltfpack **编译时没带 BasisU**：
//   Error: gltfpack was built without BasisU support,
//          texture compression is not available
//   （-tc 参数在 help 里，但功能没编进去）
// 要 KTX2 就得下载原生 gltfpack.exe。
//
// 分档依据是「玩家会凑多近看」，不是物理尺寸（见下面 TIER 表的注释）。
//
// 用法：node tools/shrink-textures.mjs [--dry]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('assets/models');
const DRY = process.argv.includes('--dry');

/**
 * 显式分档表。**不要用「按足迹自动推」** —— 我第一版就是按足迹推的，
 * 结果 moon_rock_02（3.2m 宽的石头）被判成 1024。
 * 决定贴图分辨率的是「玩家会凑多近看」，不是物理尺寸：
 * 6.1m 的集装箱你要钻进去，1024 合理；
 * 4.6m 的巨石你只会绕着走，512 就够 —— 按尺寸算是错的。
 *
 * 128 留给最小组件。再低就肉眼可见糊了 —— 摄像机是固定斜角，
 * 玩家贴脸看油桶是常事，不能只按「远处看不见」来省。
 */
const TIER = {
  // —— 1024：会走近看 / 地标 ——
  industrial_pastic_container: 1024,   // 6.1m，要钻进去
  modular_industrial_pipes_01: 1024,   // 6m 管段，横跨半个场景
  overhead_crane: 1024,                // 8m 吊车，地标

  // —— 512：中等，正常视野 ——
  wooden_crate_01: 512,
  plastic_crate_01: 512,
  steel_frame_shelves_01: 512,
  treasure_chest: 512,
  tool_cart: 512,
  portable_generator: 512,
  old_military_compressor: 512,
  modular_airduct_circular_01: 512,
  metal_tool_chest: 512,
  // 天然地貌：块头大但玩家只绕着走
  moon_rock_02: 512,
  rock_07: 512,
  namaqualand_boulder_03: 512,

  // —— 256：小组件，屏幕上一丁点 ——
  Barrel_01: 256,
  metal_jerrycan: 256,
  propane_tank: 256,
  hand_truck: 256,
  security_light: 256,
  portable_searchlight: 256,
  industrial_pipe_lamp: 256,
  hanging_industrial_lamp: 256,
};

function tierFor(name) {
  // 没登记的走 512：宁可保守，也不要默认给 1024 让体积悄悄涨回去。
  return TIER[name] ?? 512;
}

// gltfpack 写出的 GLB 带 KHR_mesh_quantization（顶点量化）等扩展，
// gltf-transform 默认**不认**，会报
//   Missing required extension, "KHR_mesh_quantization".
// 必须把 KHRONOS 全套注册进去才能读。
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.slim.glb'));
let before = 0, after = 0, saved = 0;
const rows = [];

for (const f of files) {
  const name = f.replace('.slim.glb', '');
  const src = path.join(DIR, f);
  const size0 = fs.statSync(src).size;
  before += size0;
  const target = tierFor(name);

  const doc = await io.read(src);
  const tex = doc.getRoot().listTextures();
  if (process.env.VERBOSE) {
    const mats = doc.getRoot().listMaterials();
    console.log(`  [${name}] textures=${tex.length} materials=${mats.length} `
      + `images=${doc.getRoot().listImages ? doc.getRoot().listImages().length : '?'} `
      + `texWithImage=${tex.filter((t) => t.getImage()).length}`);
  }
  if (!tex.length) { after += size0; rows.push([name, target, size0, size0, 0]); continue; }

  let dirty = false;
  // dry-run 也要报真实收益，所以这里照样做 resize 并累加字节数，
  // 只是不落盘。之前 dry-run 直接跳到「未改动」分支，于是永远显示省 0MB ——
  // 一个永远输出 0 的 dry-run 等于没有 dry-run。
  let imgBefore = 0, imgAfter = 0;
  for (const t of tex) {
    const img = t.getImage();
    if (!img) continue;
    const meta = await sharp(img).metadata();
    if (!meta.width || meta.width <= target) { imgBefore += img.byteLength; imgAfter += img.byteLength; continue; }
    const resized = await sharp(img)
      .resize(target, target, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: 86, mozjpeg: true })     // mozjpeg 同画质更小
      .toBuffer();
    imgBefore += img.byteLength;
    // 只有确实变小才换 —— 少数图缩到 512 后 mozjpeg 参数反而变大
    if (resized.length < img.byteLength) {
      t.setImage(resized);
      imgAfter += resized.length;
      dirty = true;
    } else {
      imgAfter += img.byteLength;
    }
  }
  if (process.env.VERBOSE) {
    console.log(`  [${name}] 目标${target} 贴图字节 ${(imgBefore / 1024).toFixed(0)}K → ${(imgAfter / 1024).toFixed(0)}K (${dirty ? '会改' : '不变'})`);
  }

  if (!dirty) {
    after += size0;
    rows.push([name, target, size0, size0, 0]);
    continue;
  }

  if (DRY) {
    // 用贴图字节差估算 GLB 体积（GLB = 头 + JSON + BIN，贴图占 BIN 的绝大部分）
    const est = Math.max(1, size0 - (imgBefore - imgAfter));
    after += est; saved += size0 - est;
    rows.push([name, target, size0, est, size0 - est]);
    continue;
  }

  const dst = path.join(DIR, '_small_' + f);
  await io.write(dst, doc);
  const size1 = fs.statSync(dst).size;
  if (size1 < size0) {
    fs.renameSync(dst, src);
    after += size1; saved += size0 - size1;
    rows.push([name, target, size0, size1, size0 - size1]);
  } else {
    fs.unlinkSync(dst);
    after += size0;
    rows.push([name, target, size0, size0, 0]);
  }
}

rows.sort((a, b) => b[4] - a[4]);
console.log(`  模型                    档位     原→新`);
for (const [n, t, a, b, s] of rows) {
  console.log(`  ${n.padEnd(24)} ${String(t).padStart(4)}  ${(a / 1024).toFixed(0).padStart(5)}K→${(b / 1024).toFixed(0).padStart(5)}K${s ? '  省 ' + (s / 1024).toFixed(0) + 'K' : ''}`);
}
console.log(`\n模型合计 ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB`
  + `（省 ${(saved / 1048576).toFixed(2)}MB，${(saved / before * 100).toFixed(0)}%）${DRY ? '  [dry-run，未落盘]' : ''}`);
