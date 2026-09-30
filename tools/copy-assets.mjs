// 构建后把 20MB 资产和 _headers 拷进 dist/。
//
// 为什么不在 vite.config 里配 publicDir：
// public 目录的内容会被 vite **原样复制**，但如果用目录联接（junction）把
// assets/ 挂进 public/，git 会把联接里的文件当成真实文件提交 —— 同一批资产
// 在仓库里存两份，20MB 直接变 40MB（实测踩过）。
// 显式拷贝则只有一份，磁盘上不会翻倍，git 里也不会翻倍。
//
// 用法：npm run build（vite build 之后自动跑）

import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const SRC = path.resolve('assets');

if (!fs.existsSync(DIST)) {
  console.error('[copy-assets] dist/ 不存在，先跑 vite build');
  process.exit(1);
}

let files = 0, bytes = 0;
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      files++; bytes += fs.statSync(s).size;
    }
  }
}
copyDir(SRC, path.join(DIST, 'assets'));

// _headers 是 Cloudflare Pages / Netlify 的响应头配置，不是静态资源，
// 但它们都从站点根目录读，所以要一起进包。
const hdr = path.resolve('_headers');
if (fs.existsSync(hdr)) {
  fs.copyFileSync(hdr, path.join(DIST, '_headers'));
  files++; bytes += fs.statSync(hdr).size;
}

console.log(`[copy-assets] ${files} 个文件 · ${(bytes / 1048576).toFixed(1)} MB → dist/`);
