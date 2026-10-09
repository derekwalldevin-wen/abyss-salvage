// 量 GLB 里每张内嵌贴图的尺寸和字节数。
//
// 目的：决定该用哪条路线瘦身。
//   - 如果贴图尺寸远超道具的屏幕尺寸 → 降分辨率收益最大，且只需要 sharp
//   - 如果尺寸已经合理、纯粹是编码浪费 → 才需要 KTX2/BasisU
//
// 之前只知道「模型 8MB 里大部分是内嵌贴图」，但不知道是 512² 还是 2048²，
// 于是直接奔着 KTX2 去了 —— 而 KTX2 需要原生二进制 gltfpack，WASM 版没编
// BasisU。先量清楚再决定。
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('assets/models');

/** 解析 GLB：12 字节头 + JSON chunk + BIN chunk */
function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

/** 从 bufferView 切出图片字节，再读 JPEG/PNG 头拿宽高 */
function imageSize(bytes) {
  // PNG: 8 字节签名 + IHDR
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20), fmt: 'png' };
  }
  // JPEG: 逐段找 SOFn
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const m = bytes[i + 1];
      // SOF0..SOF15，跳过 DHT(c4)/JPG(c8)/DAC(cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7), fmt: 'jpg' };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return { w: 0, h: 0, fmt: 'unknown' };
}

const rows = [];
let totalImg = 0, totalFile = 0;
const dimCount = new Map();

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.glb'))) {
  const buf = fs.readFileSync(path.join(DIR, f));
  totalFile += buf.length;
  let g;
  try { g = parseGLB(buf); } catch { continue; }
  const imgs = g.json.images || [];
  const bv = g.json.bufferViews || [];
  for (const im of imgs) {
    const v = bv[im.bufferView];
    if (!v) continue;
    const bytes = g.bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    totalImg += bytes.length;
    const s = imageSize(bytes);
    const key = `${s.w}x${s.h}`;
    dimCount.set(key, (dimCount.get(key) || 0) + 1);
    rows.push([f.replace('.slim.glb', ''), key, s.fmt, bytes.length, v.byteLength]);
  }
}

console.log(`模型文件合计 ${(totalFile / 1048576).toFixed(2)} MB，其中内嵌图片 ${(totalImg / 1048576).toFixed(2)} MB (${(totalImg / totalFile * 100).toFixed(0)}%)`);
console.log(`\n贴图尺寸分布（张数）：`);
[...dimCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v} 张`));

console.log(`\n最大的 12 张：`);
rows.sort((a, b) => b[3] - a[3]).slice(0, 12)
  .forEach(([n, d, fmt, bytes]) => console.log(`  ${d.padEnd(11)} ${fmt.padEnd(5)} ${(bytes / 1024).toFixed(0).padStart(5)} KB  ${n}`));

const px = rows.reduce((s, r) => {
  const [w, h] = r[1].split('x').map(Number);
  return s + w * h;
}, 0);
console.log(`\n贴图总像素 ${(px / 1e6).toFixed(1)} MP —— 若全部降到 512x512，总像素会变成 ${(rows.length * 512 * 512 / 1e6).toFixed(1)} MP`);
