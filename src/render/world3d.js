// 把 build.js 产出的 draw list 变成 three.js 场景。
//
// 合批策略（和参考作验证过的一致）：
// 1. 静态几何按 (材质, 48m 区块) 合并 → 几百个 mesh 变几十个
// 2. GLB 道具按 (模型, 96m 区块) 实例化
// 3. 舱壁类材质挂透墙抖动着色器；地面挂焦散
//
// 注意：GLB 里有 17.5 万面的 modular_factory_facade，所以舱壁主体一律走
// 程序化盒体 + PBR 贴图，GLB 只当英雄道具用。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tiledBox, tiledPlane, boxUV, pbr, TILE, planeUV } from './materials.js';
import { addSeeThrough, markPatched } from './seethrough.js';
import { addCaustics } from './water.js';
import { heightAt } from '../world/layout.js';

const CHUNK = 48;
const PROP_CHUNK = 96;
const chunkOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;

// draw.mat → 贴图集 + 颜色
//
// 配色是「甲板压暗、道具偏亮」：固定斜角镜头俯视甲板时，地板占了大半画面，
// 地板一亮，所有立在地上的东西都糊进去了。压暗地板等于给道具当背景板。
// rough 那一项其实被下面 m.metalness = cfg.rough 覆盖了，改它没用。
const MAT_MAP = {
  rusty: { set: 'rusty_metal', color: 0xc9a893, tile: 'rusty', rough: 0.55 },
  iron: { set: 'corrugated_iron', color: 0xa8bcc0, tile: 'iron', rough: 0.5 },
  deck: { set: 'metal_plate', color: 0x36484c, tile: 'deck', rough: 0.35 },
  floor: { set: 'concrete', color: 0x4a4a44, tile: 'floor', rough: 0.2 },
  conc: { set: 'concrete', color: 0x33342f, tile: 'conc', rough: 0.1 },
  steel: { set: 'metal_plate', color: 0xb6c6cc, tile: 'steel', rough: 0.9 },
  // 头顶横梁：单独一个材质桶，因为**它不投影**。
  // 7m 高的横梁在 62° 高度角的阳光下会在甲板上投出 3~4m 宽的纯黑硬边，
  // 横跨整个玩法区，把画面切成一条条黑带。深水的散射光本来就没有硬阴影，
  // 所以直接不投影比调软更省事。
  beams: { set: 'metal_plate', color: 0x5d6a6e, tile: 'steel', rough: 0.6, noShadow: true },
  // 甲板拼板缝：单独一份，因为**它必须比甲板暗**。
  // 用 iron（0xa8bcc0）的话缝比地板亮一大截，成了画面里最抢眼的东西，
  // 视线全被这些网格线吸走，甲板上的道具反而看不见。
  seam: { set: 'corrugated_iron', color: 0x1e2a2e, tile: 'iron', rough: 0.5 },
};

export function buildSceneFromDrawList(scene, world, assets, caustics) {
  const group = new THREE.Group();
  group.name = 'static';
  scene.add(group);

  // ---- 材质 ----
  const mats = {};
  for (const [key, cfg] of Object.entries(MAT_MAP)) {
    const m = pbr(assets.tex, cfg.set, { color: cfg.color, tile: cfg.tile, normal: 1.1, env: 0.9 });
    m.userData.tile = TILE[cfg.tile];
    m.metalness = cfg.rough;
    m.userData.noShadow = !!cfg.noShadow;
    mats[key] = m;
  }
  // 地面材质挂焦散；舱壁挂透墙。
  // 调试开关：?nocau / ?nost 可以单独关掉某个 shader 补丁 —— 
  // 这两个补丁都用 onBeforeCompile 改着色器，出问题时需要能单独二分定位。
  const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (!Q.has('nocau')) {
    addCaustics(mats.deck, caustics.uniforms);
    addCaustics(mats.floor, caustics.uniforms);
  }
  if (!Q.has('nost')) {
    for (const k of ['rusty', 'iron', 'steel']) addSeeThrough(mats[k]);
  }

  // ---- 1. 静态几何合批 ----
  const buckets = new Map();      // key: mat|chunk  → { mat, geos: [] }
  const push = (matKey, chunk, geo) => {
    const k = `${matKey}|${chunk}`;
    let b = buckets.get(k);
    if (!b) { b = { mat: matKey, geos: [] }; buckets.set(k, b); }
    b.geos.push(geo);
  };

  let drawCalls = 0;
  for (const d of world.draw) {
    switch (d.kind) {
      case 'deco': {
        // 纯视觉的平台结构，没有碰撞体（见 build.js 第 8b 节）
        const t = mats[d.mat].userData.tile;
        if (d.shape === 'pillar' || d.shape === 'col') {
          // 用八棱柱近似圆柱：比 BoxGeometry 便宜，比 CylinderGeometry 便宜得多
          const g = new THREE.CylinderGeometry(d.r, d.r * 1.25, d.h, 8, 1);
          boxUV(g, d.r * 2, d.h, d.r * 2, t);
          g.translate(d.x, d.y - d.h / 2, d.z);
          push(d.mat, chunkOf(d.x, d.z), g);
        } else if (d.shape === 'plate' || d.shape === 'beam' || d.shape === 'seam') {
          const w = d.x1 - d.x0, dp = d.z1 - d.z0, h = d.y1 - d.y0;
          if (!(w > 0.02) || !(h > 0.02) || !(dp > 0.02)) break;
          const g = tiledBox(w, h, dp, t);
          g.translate((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, (d.z0 + d.z1) / 2);
          push(d.mat, chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        } else if (d.shape === 'pipe') {
          const g = new THREE.CylinderGeometry(d.r, d.r, d.len, 7, 1);
          g.rotateX(Math.PI / 2);
          boxUV(g, d.r * 2, d.len, d.r * 2, t);
          g.translate(d.x, d.y, d.z);
          push(d.mat, chunkOf(d.x, d.z), g);
        } else if (d.shape === 'rail') {
          const len = d.z1 - d.z0;
          if (!(len > 0.02)) break;
          for (const ox of [-0.09, 0.09]) {
            const g = tiledBox(0.1, d.h, len, t);
            g.translate(d.x + ox, (d.y0 + d.y1) / 2 + d.h / 2, (d.z0 + d.z1) / 2);
            push(d.mat, chunkOf(d.x, (d.z0 + d.z1) / 2), g);
          }
          const top = tiledBox(0.3, 0.08, len, t);
          top.translate(d.x, (d.y0 + d.y1) / 2 + d.h, (d.z0 + d.z1) / 2);
          push(d.mat, chunkOf(d.x, (d.z0 + d.z1) / 2), top);
        }
        break;
      }
      case 'floor': {
        const w = d.x1 - d.x0, dp = d.z1 - d.z0;
        const g = tiledPlane(w, dp, mats[d.mat].userData.tile);
        g.translate((d.x0 + d.x1) / 2, d.y, (d.z0 + d.z1) / 2);
        push(d.mat, chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'ramp': {
        // 斜板：沿 z 倾斜的平面
        const w = d.x1 - d.x0, dp = d.z1 - d.z0;
        const g = new THREE.PlaneGeometry(w, Math.hypot(dp, d.y1 - d.y0), 1, 4);
        planeUV(g, w, Math.hypot(dp, d.y1 - d.y0), mats.deck.userData.tile);
        g.rotateX(-Math.PI / 2);
        const ang = Math.atan2(d.y1 - d.y0, dp);
        g.rotateX(ang);
        g.translate((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, (d.z0 + d.z1) / 2);
        push('deck', chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'wall':
      case 'cliff': {
        const w = d.x1 - d.x0, h = d.y1 - d.y0, dp = d.z1 - d.z0;
        // 用 `!(x > min)` 而不是 `x <= min`：NaN 跟任何数比较都返回 false，
        // 所以 `w <= 0.02` 这种写法拦不住 NaN，NaN 顶点会一路混进合并几何体
        // 和阴影贴图（实测整图永久阴影）。缺字段的绘制指令要在这里被丢掉。
        if (!(w > 0.02) || !(h > 0.02) || !(dp > 0.02)) break;
        const g = tiledBox(w, h, dp, mats[d.mat].userData.tile);
        g.translate((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, (d.z0 + d.z1) / 2);
        push(d.mat, chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'lintel': {
        if (!(d.w > 0.02) || !(d.h > 0.02) || !(d.d > 0.02)) break;
        const g = tiledBox(d.w, d.h, d.d, mats[d.mat].userData.tile);
        g.translate(d.x, d.y + d.h / 2, d.z);
        push(d.mat, chunkOf(d.x, d.z), g);
        break;
      }
      case 'rail': {
        const len = d.z1 - d.z0;
        if (!(len > 0.02) || !(d.h > 0.02)) break;
        const g = tiledBox(0.16, d.h, len, mats.iron.userData.tile);
        g.translate(d.x, (d.y0 + d.y1) / 2 + d.h / 2, (d.z0 + d.z1) / 2);
        push('iron', chunkOf(d.x, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'edge': {
        // 边界：巨大的混凝土环，充当"地图外"的视觉封边
        const w = d.x1 - d.x0, h = d.y1 - d.y0, dp = d.z1 - d.z0;
        if (!(w > 0.02) || !(h > 0.02) || !(dp > 0.02)) break;
        const g = tiledBox(w, h, dp, mats.conc.userData.tile);
        g.translate((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, (d.z0 + d.z1) / 2);
        push('conc', chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'pool': {
        const w = d.x1 - d.x0, dp = d.z1 - d.z0;
        const g = new THREE.PlaneGeometry(w, dp);
        g.rotateX(-Math.PI / 2);
        g.translate((d.x0 + d.x1) / 2, d.y + 0.12, (d.z0 + d.z1) / 2);
        push('floor', chunkOf((d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2), g);
        break;
      }
      case 'decompress': {
        // 减压舱钢架：四根柱 + 顶环
        const y = d.y;
        for (const [ox, oz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
          const g = tiledBox(0.24, 2.8, 0.24, 1.6);
          g.translate(d.x + ox, y + 1.4, d.z + oz);
          push('steel', chunkOf(d.x, d.z), g);
        }
        const top = new THREE.TorusGeometry(2.0, 0.12, 6, 20);
        top.rotateX(Math.PI / 2);
        top.translate(d.x, y + 2.8, d.z);
        push('steel', chunkOf(d.x, d.z), top);
        break;
      }
    }
  }

  for (const b of buckets.values()) {
    if (!b.geos.length) continue;
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    // 兜底：合并后再扫一遍顶点。任何一个 NaN 都会在阴影贴图里变成
    // 铺满全图的巨大三角形，把整张地图永久压进阴影 —— 症状是「大部分
    // 出生点开局全黑」，但 draw call 数和深度都正常，非常难查。
    if (hasNaN(merged)) {
      console.warn('[world3d] 合并几何含 NaN 顶点，已丢弃', b.mat, b.geos.length, '块');
      merged.dispose();
      for (const g of b.geos) g.dispose();
      continue;
    }
    const mesh = new THREE.Mesh(merged, mats[b.mat]);
    mesh.castShadow = !mats[b.mat].userData.noShadow && b.mat !== 'deck' && b.mat !== 'floor';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    drawCalls++;
    for (const g of b.geos) g.dispose();
  }

  // ---- 2. GLB 道具实例化 ----
  // 两个必须踩过才知道的坑：
  //
  // (1) gltfpack 把顶点量化成 Uint16（0..16383），**反量化缩放藏在节点矩阵里**。
  //     只取 part.geometry 就会得到一个 10 公里宽的怪物（桶的坐标范围
  //     0..10482 × 0..16383 × 0..10482 米），它同时糊住画面和整张阴影贴图 ——
  //     症状是「大部分出生点开局全黑」，而 draw call / 三角面 / 深度全都正常。
  //
  // (2) **不要**用 geometry.applyMatrix4() 去烘焙变换。position 属性是
  //     非归一化的 Uint16Array，applyMatrix4 内部的 setXYZ 会把结果
  //     截断取整：0.0056m 被钳成 0，5.4m 被截成 5，几何直接烂掉。
  //     正确做法是把部件矩阵**组合进实例矩阵**，让 three 在着色器里用浮点算。
  const propLists = new Map();     // model|chunk → { parts, list, cast }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  let propCount = 0;
  for (const d of world.draw) {
    if (d.kind !== 'prop' && d.kind !== 'rubble' && d.kind !== 'lamp') continue;
    const proto = assets.models[d.model];
    if (!proto) continue;
    const key = `${d.model}|${Math.floor(d.x / PROP_CHUNK)},${Math.floor(d.z / PROP_CHUNK)}`;
    let l = propLists.get(key);
    if (!l) { l = { parts: partMatrices(proto), norm: normScale(proto), list: [], cast: d.kind !== 'lamp' }; propLists.set(key, l); }
    if (!l.parts.length) continue;
    // 归一化：把模型缩放到与它的碰撞盒一致。
    // fit 必须是**标量**。早先写成 `l.norm * Math.min(...)` —— l.norm 是
    // [宽,深] 向量，乘出来还是向量，喂给 _s.set(sc,sc,sc) 就变成 NaN，
    // 整个实例矩阵全是 NaN，**一个道具都渲染不出来**（画面只剩甲板和潜水员）。
    // 这个 bug 静默了很久：亮度检查、渲染截图、冒烟测试全过，
    // 因为「没有道具」不会让这些检查失败 —— 是玩家发现的。
    const fit = d.foot ? Math.min(d.foot[0] / l.norm[0], d.foot[1] / l.norm[1]) : 1;
    _e.set(0, d.rot || 0, 0);
    _q.setFromEuler(_e);
    _p.set(d.x, d.y, d.z);
    const sc = (d.s || 1) * fit;
    _s.set(sc, sc, sc);
    l.list.push(_m.compose(_p, _q, _s).clone());
    propCount++;
  }

  let instCalls = 0, instMeshes = 0;
  const batches = [];             // { mesh, x, z } 用于按距离剔除
  // GLB 材质统一压进本作的调色板。
  // Poly Haven 的贴图是给「地面以上」场景用的：集装箱是亮蓝的、工具箱是鲜黄的。
  // 直接摆进深蓝绿的深海画面里，这些物件会像贴错了素材一样跳出来 ——
  // 集装箱那个亮蓝尤其刺眼，整幅画面就它一个高饱和色。
  // 做法是给每个材质叠一层轻微的冷调乘色，压掉饱和度但保留贴图明暗细节；
  // 直接改成纯色不行，那样模型会变成一块塑料。
  const seenMat = new WeakSet();
  for (const l of propLists.values()) {
    for (const part of l.parts) tintPropMaterial(part.mat, seenMat);
    // GLB 是多 mesh 的 Scene，InstancedMesh 只吃单个 geometry+material，所以按部件分别实例化
    for (const part of l.parts) {
      const inst = new THREE.InstancedMesh(part.geo, part.mat, l.list.length);
      // 实例矩阵 = 摆放 ∘ 部件局部矩阵
      l.list.forEach((m4, i) => inst.setMatrixAt(i, m4.clone().multiply(part.m)));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = l.cast;
      inst.receiveShadow = true;
      inst.frustumCulled = true;
      // 包围球按「部件矩阵 + 实例」算，否则视锥剔除会按错误的球体裁掉实例
      part.geo.computeBoundingSphere();
      inst.computeBoundingSphere?.();
      group.add(inst);
      instCalls++;
      instMeshes++;
      // 批次中心：区块内所有摆放点的形心，够用来做距离剔除
      let cx = 0, cz = 0;
      for (const m4 of l.list) { cx += m4.elements[12]; cz += m4.elements[14]; }
      batches.push({ mesh: inst, x: cx / l.list.length, z: cz / l.list.length });
    }
  }

  group.updateMatrixWorld(true);
  group.traverse(o => { o.matrixAutoUpdate = false; });

  // 距离剔除：雾在 95m 就把远处吃光了，但 three 的视锥剔除对 InstancedMesh
  // 用的是整批包围球，一个批次只要有一部分进视锥就全画。地图有 260m 见方，
  // 站在一角时另外三角的道具也在提交 —— 实测 557 个 draw call。
  // 按批次形心做一次距离剔除，138 个批次每帧一次平方距离比较，几乎免费。
  const CULL = 118;
  function update(camPos) {
    for (const b of batches) {
      const dx = b.x - camPos.x, dz = b.z - camPos.z;
      b.mesh.visible = dx * dx + dz * dz < CULL * CULL;
    }
  }
  return { group, mats, drawCalls: drawCalls + instCalls, instMeshes, propCount, batches, update };
}

export { chunkOf, MAT_MAP };

/**
 * 拆出 GLB 各部件的**局部矩阵**（保留根节点的反量化缩放，只去掉根的平移/旋转）
 * 和整模的地面投影尺寸。geometry 本身不做任何修改 —— 见 world3d 里的坑 (2)。
 */
const partCache = new WeakMap();
function partMatrices(root) {
  if (partCache.has(root)) return partCache.get(root);
  root.updateMatrixWorld(true);
  const rp = new THREE.Vector3(), rq = new THREE.Quaternion(), rs = new THREE.Vector3();
  root.matrixWorld.decompose(rp, rq, rs);
  // 只保留根的缩放：位置和朝向是「模型摆在哪儿」，由实例矩阵负责
  const keep = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(), rs);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const out = [];
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const m = new THREE.Matrix4().multiplyMatrices(keep, inv).multiply(o.matrixWorld);
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3());
    out.push({ geo: o.geometry, mat: o.material, m });
    // 量整模在 XZ 上的投影尺寸
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 7) {           // 抽样即可，只要量级
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      box.expandByPoint(v);
    }
  });
  partCache.set(root, out);
  return out;
}

/** 整模 XZ 投影尺寸（米）。用于把模型缩放到碰撞盒大小。 */
const normCache = new WeakMap();
function normScale(root) {
  if (normCache.has(root)) return normCache.get(root);
  const parts = partMatrices(root);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geo.attributes.position;
    for (let i = 0; i < pos.count; i += 7) {
      v.fromBufferAttribute(pos, i).applyMatrix4(p.m);
      box.expandByPoint(v);
    }
  }
  const s = box.getSize(new THREE.Vector3());
  const out = [Math.max(s.x, 1e-4), Math.max(s.z, 1e-4)];
  normCache.set(root, out);
  return out;
}

/**
 * 把 GLB 材质压进深海调色板。
 *
 * 光靠 `color.multiply()` 是**压不掉饱和度**的：颜色是乘在贴图上的，
 * 贴图本身是饱和蓝，乘出来还是饱和蓝，只是暗一点。集装箱在画面里
 * 依然是整幅画唯一的高饱和色，看着就像贴错了素材。
 *
 * 所以额外注入一段 shader，把 albedo 往它的灰度值上拉：
 *   mix(灰度, 原色, sat)，sat 越小越灰。
 * 贴图的明暗细节（锈迹、污渍、条纹）全部保留，只有颜色被抽走。
 */
const PROP_TINT = new THREE.Color(0xb9c6c2);   // 冷灰绿
// 保留 15% 饱和度。实测 0.32 还是「整幅画唯一的高饱和色」，
// 0.0 画面统一但完全没材质区别了，0.15 是这两者之间能看的位置。
const PROP_SAT = 0.15;
function tintPropMaterial(mat, seen) {
  if (!mat) return;
  for (const m of Array.isArray(mat) ? mat : [mat]) {
    if (!m || !m.color || seen.has(m)) continue;
    seen.add(m);
    m.color.multiply(PROP_TINT);
    if (m.envMapIntensity !== undefined) m.envMapIntensity *= 0.55;
    if (m.roughness !== undefined) m.roughness = Math.min(1, m.roughness + 0.12);
    desaturateMaterial(m);
  }
}

function desaturateMaterial(m) {
  if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) return;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.uSat = m.userData.uSat;
    shader.fragmentShader = 'uniform float uSat;\n' + shader.fragmentShader
      // color_fragment 之后 albedo 已经乘上 color，正是要处理的值
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, uSat);`);
  };
  m.userData.uSat = { value: PROP_SAT };
  markPatched(m, 'desat');
}

/** 几何体顶点里有没有 NaN/Infinity */
function hasNaN(geo) {
  const a = geo.attributes.position?.array;
  if (!a) return false;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
  return false;
}
