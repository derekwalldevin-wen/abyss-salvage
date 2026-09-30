# 深渊打捞 · Abyss Salvage

单人撤离射击。沉没的钻井平台「墨龙号」分四层沉在海底，越深越值钱，也越危险。
three.js + 原生 ES modules，无后端，静态托管即可。

## 跑起来

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

## 校验与构建

```bash
npm test             # 91 个单元测试
npm run validate:map # 地图构建期断言（默认 8 个种子，--seeds 80 全量）
npm run build        # 先跑地图校验，通过才打包 —— 校验不过就不出包
npm run verify       # 全套：测试 + 80 种子校验 + 资产 + 渲染 + 打包产物冒烟
```

单项：

```bash
npm run check:assets   # 33 模型 / 24 贴图 / 2 HDRI 能否被游戏自己的加载器加载
npm run check:render   # 起局、移动、开火，截图 + 抓控制台报错
npm run check:bright   # 8 个出生点全采样的画面亮度
npm run check:dist     # 对着 dist 冒烟：资源 404 / 黑屏 / HUD 不刷新都会被抓出来
```

> 渲染相关的检查都打的是 `dist/` 而不是源码。源码里 `import * as THREE from 'three'`
> 是裸模块名，只有 dev 靠 importmap 能解析；生产构建里 three 已被 Vite 打进 bundle。
> 这不是偷懒 —— **部署的就是 dist，测 dist 才是真的在测要上线的东西**。

`npm run build` 把地图断言当**硬门禁**：撤离点不可达、门洞太窄、容器点被道具堵死
这类问题会让构建直接失败，而不是变成一局玩不了的地图。

## 操作

| 键 | 作用 |
|---|---|
| WASD | 移动 |
| 鼠标 | 选地面瞄准点（固定斜角镜头，不能自由转视角） |
| 左键 | 射击 / 搜刮 |
| 右键 | 抵肩瞄准 |
| 1 / 2 / 3 · 滚轮 | 切换武器槽 |
| R | 换弹 |
| E | 交互（搜刮容器、上浮） |
| H / G | 急救包 / 手雷 |
| Shift | 冲刺（耗体力） |
| Esc | 放弃本局 |

## 核心设计

**固定斜角摄像机**（yaw 45°、pitch 56°、不能自由视角）是整个设计的支点。
玩家不能转头，只能转角色；鼠标只负责在地面选一个瞄准点。这样命中判定能退化成 2D，
AI 视线不必算高度差，单层建筑也不会把玩家卡死。代价是深度感弱，所以水下浊光、
悬浮颗粒和晃动焦散要负责把画面撑住。

**深度是纯数字，不是移动方式。** 20 米以下开始承受压力伤害，氧气消耗随深度上升，
战利品价值也随深度上升。加了垂直维度，但没加任何按键和操作复杂度。

**四层甲板沿 Z 轴排成不重叠的条带**（艏层 −6m / 作业区 −20m / 钻井区 −34m / 压载舱 −44m），
层间用斜坡连接。这么排是因为 `heightAt(x, z)` 必须是单值函数 —— 两层楼不可能
叠在同一个格子上。早期版本把四层画成互相重叠的矩形，正是这一点在写 build.js
时才暴露出来。改成条带后，整张图的地面高度是 z 的分段线性函数。

**逻辑与渲染彻底分离。** `src/core` + `src/world` 零 three、零 DOM，所以无头模拟
和构建期校验跑的是和浏览器里**完全相同**的那份代码。地图不是「画出来再检查」，
而是「生成成数据再断言」。

## 目录

```
src/core/      纯逻辑：rng / nav / rules / ai / raid / catalog   零 three 零 DOM
src/world/     布局数据 + 生成器 + 构建期断言                      零 three 零 DOM
src/render/    three 场景：材质 / 合批 / 透墙 / 焦散 / 角色 / 特效
src/ui/        HUD
tools/         校验、渲染验收、资产优化、冒烟测试
assets/        20MB CC0 资产（33 个 GLB + 24 张贴图 + 2 张 HDRI）
```

## 资产

全部来自 Poly Haven（CC0）。GLB 用 gltfpack 做过量化 + 简化（`tools/optimize-models.mjs`，
`-si 0.25`），从 28.9MB 压到 14.5MB。全图 327 个道具合计 154 万三角面。

重新优化资产：

```bash
node tools/optimize-models.mjs 0.25   # 产出 .slim.glb
```

> gltfpack 的坑（都踩过）：不要加 `-tc`（WASM 版没编 BasisU，会直接失败）；
> 不要加 `-noq`（会取消量化，文件反而更大）；简化会把缩放留在节点矩阵里，
> 所以渲染层**必须**把部件矩阵组合进实例矩阵，不能只取 `geometry`。

## 部署

纯静态，`dist/` 直接丢到任意 CDN。

```bash
npm run build
```

- 入口 `index.html`，`base: './'` 所以放子目录也能跑
- `dist/assets/` 是带 hash 的 JS/CSS，CDN 上给 `immutable` 长期缓存
- `dist/assets/models|tex|hdri/` 是固定路径，缓存 30 天（改了同名文件会变，不能给 immutable）
- `dist/_headers` 已配好 Cloudflare Pages / Netlify 的响应头

实测产物：`index.html` 3.3KB + JS 706KB（gzip 195KB）+ 资产 20.5MB。

没有服务端、没有数据库、没有账号系统 —— 存档走 `localStorage`。
