# Abyss Salvage 进度

## 当前状态

- 逻辑层 + 世界层 + 渲染层 + HUD 全部完成
- 91/91 单元测试通过，80/80 地图种子校验通过
- **已上线**：https://derekwalldevin-wen.github.io/abyss-salvage/
  独立仓库 `derekwalldevin-wen/abyss-salvage`，分支 `main`
- 仓库体积 20.2MB，产物 20.5MB（JS 706KB / gzip 195KB + 资产 19.8MB）

## 渲染层调试：黑屏根因

`diag-mat` / `diag-path` / `diag-spawns` 逐层二分后确认，**不是材质、不是灯光方向、不是 NaN**，
最终定位到 GLB 资产的使用方式上。三个独立的 bug 叠在一起，症状都是「画面全黑」。

### 1. GLB 丢了节点矩阵 → 10 公里宽的怪物（真正的元凶）

gltfpack 把顶点量化成 `Uint16Array`（0..16383），**反量化缩放藏在节点矩阵里**。
渲染层原来只取 `part.geometry` 去实例化，等于把缩放扔了：

```
Barrel_01 的坐标范围 = 0..10482 × 0..16383 × 0..10482  米
```

一个油桶 10 公里宽。它同时糊住整个画面和整张阴影贴图 →
**8 个出生点里 6 个开局全黑**，而 draw call 数、三角面数、深度值全部正常。
所以 `?off=shadow` 能救（不投影就看不见它），直接渲染 scene 又能看见（材质兜住了）。

修法：把部件矩阵**组合进实例矩阵**，不要动 geometry。

### 2. `geometry.applyMatrix4()` 会毁掉量化属性

第一步的修法是克隆几何体再 `applyMatrix4` 烘焙变换 —— 这也是错的。
`applyMatrix4` 内部走 `setXYZ`，往非归一化的 `Uint16Array` 里写：
0.0056m 被钳成 0，5.4m 被截成 5，几何直接烂掉。
**所以只能用实例矩阵组合，浮点运算留在着色器里。**

### 3. 阴影相机投影矩阵从没重算

```js
Object.assign(sun.shadow.camera, { left: -34, right: 34, ... });   // 没调 updateProjectionMatrix()
```

three 只在 `new OrthographicCamera()` 时算一次投影矩阵，之后改属性不会自动更新，
实际范围还是默认的 ±5m。单看这一条不致命，但它让阴影只盖住玩家脚下 10m，
和前两个 bug 一起更难查。

## 其他渲染层 bug

| 症状 | 根因 | 修法 |
|---|---|---|
| 全场焦散糊成「脑珊瑚」漩涡 | 频率 0.34 rad/m → 波长 18m；且注入点在 `dithering_fragment`，**排在 tone mapping 和 fog 之后**，在显示空间做加法，雾完全失效 | 提到 3.1 rad/m；注入点改到 `lights_fragment_end`，当额外漫反射光加 |
| 阴影区纯黑，甲板被切成黑带 | sun 2.9 / hemi 0.9 太阳太狠；7m 高的头顶横梁投出 3~4m 纯黑硬边 | sun 3.6 / hemi 2.8 / 曝光 1.5；横梁单独一个不投影的材质桶 |
| 画面偏暗（平均 20、53% 纯黑） | 上一条的矫枉过正 | `tools/diag-bright.mjs` 跨 8 个出生点采样迭代：最终平均 49、纯黑 1% |
| 14M 三角面 / 557 draw call | GLB 完全没简化（一个塑料箱 18,320 面）；`InstancedMesh` 整批包围球让视锥剔除几乎失效 | gltfpack `-si 0.25`（28.9MB→14.5MB，5.17M→1.54M 面）+ 按批次形心距离剔除 118m |
| 摄像机被道具包住 | 模型尺寸极不统一（货架 21m 高、集装箱 0.46m），而碰撞盒是 1.8m —— 撞看不见的墙 | draw 带上碰撞盒尺寸 `foot`，按碰撞盒归一化模型 |
| 6 个几何含 NaN 顶点 | `cliff` 绘制指令缺 y0/y1/z0/z1；守卫写 `if (w <= 0.02)` 而 **NaN 跟任何数比较都是 false** | build 补齐字段 + 守卫改 `if (!(w > 0.02))` + 合并后再扫顶点 |
| 透明墙溶成大片规则斜条纹 | 溶解上限 0.9 太高 | 降到 0.62，保留墙的大致轮廓 |

## 调试方法上的教训

1. **随机种子会毁掉 A/B 对比。** `deploy()` 用 `Math.random()` 取种子，同一份代码两次跑出的
   亮度能差 10 倍（20 vs 150），我因此对着一个根本不存在的问题调了半天参数。
   → 加了 `?seed=`，所有对比必须固定种子。

2. **「关掉某个功能就正常」是最有信息量的实验。** `?off=shadow` 让 6 个黑屏出生点
   全部正常，一步就把范围从「材质/灯光/几何/后期」缩到「阴影」。

3. **「大部分出生点异常、少数正常」几乎必然是空间相关的 bug**（阴影、剔除、雾），
   而不是材质或 shader —— 开局位置一变表现就变，这个特征本身就是线索。

4. `readPixels` 量化画面比看截图可靠，但只对稳态有效；帧循环还在跑时混着测会读到任意一帧。

## 地图密度

早期版本 260×260m 只有 127 个道具，玩家在开阔区走 40m 看不到东西，
画面就是「一块无限延伸的平板 + 一个小人」。

- 道具密度 260㎡/件 → 110㎡/件（127 → 327 个）
- 新增纯视觉平台结构（`kind:'deco'`，无碰撞体）：支撑腿、舷侧外板、头顶管路与横梁、
  层间护栏、甲板拼板缝
- 拼板缝是让空旷甲板有尺度感最便宜的办法：眼睛需要参照物，
  没有参照物时 260m 的地板看起来和 12m 的一样大

提高密度让道具开始堵门，触发两条新失败（`door-width` 剩 2 格、
`component-container` 1/51 不连通）。修法：

- 门口禁放余量 0.9m → 1.4m
- **构建期直接丢掉不可达点位**（取所有出生点连通域的并集），
  而不是只靠断言报错 —— 断言只能告诉你有问题，点位还是会被摆出来

## 部署时踩到的

- **Pages 默认没开**，workflow 的 build 步骤全绿、deploy 步骤失败。
  `deploy-pages` 要求仓库先启用 Pages 且 source 为 GitHub Actions：
  `POST /repos/{owner}/{repo}/pages` body `{"build_type":"workflow"}`，
  之后 `POST .../actions/runs/{id}/rerun` 重跑即可，不用重新 push。
- **git 走 HTTP/2 推大文件在 Windows 上会超时**，报
  `Failed to connect to github.com:443`（同一次 TCP 443 探测是通的，纯传输层问题）。
  加 `-c http.version=HTTP/1.1 -c http.postBuffer=524288000` 就稳。
- PowerShell 会把 git 写到 stderr 的正常进度当成错误，判据要看 `$LASTEXITCODE`。
- **不要用目录联接把 `assets/` 挂进 `public/`**：git 会把联接里的文件当真实文件提交，
  仓库体积 20MB → 40MB。现在由 `tools/copy-assets.mjs` 在 `vite build` 之后显式拷贝。

## 待办

- [x] 部署到 CDN → https://derekwalldevin-wen.github.io/abyss-salvage/
- [x] 撤离结算界面（src/ui/settle.js）—— 四种结局 + 逐项明细 + 快捷键重开
- [ ] 装备/商店界面（`#ui` 容器是空的，「返回营地」目前是占位提示）

## 撤离结算界面

`src/ui/settle.js`。除成功/阵亡外还处理放弃和失联。

### 顺手修掉的一个真 bug：end 事件永远消费不到

`consumeRaidEvents()` 原来在 `if (raid && !raid.over)` 里面。对局在
`raid.update()` 里自然结束时，同帧消费没问题；但从别处调 `end()`
（放弃行动、测试直接 end、以后的掉线处理），下一帧就因为 `raid.over`
整段跳过，end 事件永远留在 `raid.events` 里 —— 表现为「按了放弃，
结算界面不弹，游戏卡在最后一帧」。现在事件消费移到守卫外面。

### 快捷键的一个低级错

`hotkey(pressed)` 收的是 `input.pressed`（`{ KeyH: true }` 这样的按键名表），
我却按 KeyboardEvent 写成了 `e.code` —— 永远 undefined，表现为
「按钮能点、H 键没反应」。

### 设计取舍

- **UI 不重算经济公式。** `haul` / `bonus` / `cost` / `lost` 都由
  `core/rules.js` 的 `settle()` 返回，`haul + bonus === value` 有单测守着。
  抄一份经济公式就等于埋一个迟早会对不上的雷。
- **失败局要写「钱去哪了」。** 只显示 0 的话玩家学不到东西，
  所以失败局显式列出「装备投入 / 遗失物资 / 保险赔付」，物资栏标题也从
  「舱内物资」改成红色的「遗失物资」。
- **深度系数显式写进明细文字**（「战利品（含深度加成 ×1.97）」），
  否则玩家看不懂同一个东西为什么这趟更值钱。