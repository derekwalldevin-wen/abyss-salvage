import { defineConfig } from 'vite';

// three 会被打进 bundle：CDN 部署时不能依赖 node_modules 里的裸路径，
// index.html 里那份指向 /node_modules/ 的 importmap 只在 dev 下能用。
// 34MB 的资产（模型+贴图+HDRI）保持为独立文件由 public 目录原样拷贝，
// 不参与打包 —— 让浏览器能并行下载、并且能被 CDN 单独缓存。
export default defineConfig({
  // 不用 publicDir 放资产：20MB 模型/贴图/HDRI 由 tools/copy-assets.mjs 在
  // vite build 之后显式拷进 dist/。原因见那个文件的注释 —— 用目录联接把 assets/
  // 挂进 public/ 会被 git 当成真实文件提交，仓库体积直接翻倍（实测 20MB→40MB）。
  publicDir: false,
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,     // 资产一律外链，不塞进 data URI
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // three 单独一个 chunk：它几乎不变，CDN 上可以长期缓存
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
