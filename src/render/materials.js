// 资产加载：把 34MB 的 CC0 资源拉进 three，并生成共享的 PBR 材质。
//
// 关键约定：贴图在几何体里按**米**缩放 UV（见 boxUV / planeUV），
// 所以整个地图共用同一份材质实例，draw call 和显存都省下来。
// 这一点是照抄参考作验证过的做法，也是它能把 40MB 资产跑进浏览器的原因。

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// 8 套贴图，每套 diff/nor/arm 三张
export const TEX_SETS = [
  'rusty_metal', 'corrugated_iron', 'metal_plate', 'concrete',
  'rock_ground', 'coral_gravel', 'wooden_planks', 'blue_painted_planks',
];

// GLB 模型清单（与 tools 资产脚本一致）
export const MODELS = [
  'overhead_crane', 'dutch_ship_medium', 'dutch_ship_medium',
  'modular_industrial_pipes_01', 'modular_airduct_circular_01', 'modular_factory_facade',
  'rollershutter_door', 'ladder_sectioned_01', 'ocean_buoy', 'life_jacket',
  'old_military_crate', 'wooden_crate_01', 'plastic_crate_01', 'industrial_pastic_container',
  'metal_tool_chest', 'steel_frame_shelves_01', 'treasure_chest', 'medical_box',
  'Barrel_01', 'Barrel_02', 'metal_jerrycan', 'propane_tank', 'oil_tin',
  'hanging_industrial_lamp', 'industrial_pipe_lamp', 'portable_searchlight', 'security_light',
  'tool_cart', 'old_military_compressor', 'portable_generator', 'hand_truck',
  'moon_rock_02', 'rock_07', 'namaqualand_boulder_03',
];

/** 每米对应多少 UV 重复（贴图在几何体里按米缩放） */
export const TILE = {
  rusty: 2.4, iron: 2.2, deck: 2.0, floor: 3.0, conc: 2.5, steel: 1.6, paint: 1.2, sand: 1.0, rock: 3.0,
};

export async function loadAssets(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  const tl = new THREE.TextureLoader(manager);
  const gl = new GLTFLoader(manager);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const total = TEX_SETS.length * 3 + MODELS.length + 2;
  let done = 0;
  const tick = () => { done++; onProgress?.(Math.min(0.99, done / total)); };

  const tex = {};
  await Promise.all(TEX_SETS.map(async (name) => {
    const load = (kind) => new Promise((res, rej) =>
      tl.load(`assets/tex/${name}_${kind}.jpg`, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = aniso;
        if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace;
        tick(); res(t);
      }, undefined, rej));
    const [map, normalMap, armMap] = await Promise.all([load('diff'), load('nor'), load('arm')]);
    tex[name] = { map, normalMap, armMap };
  }));

  const models = {};
  const modelErrs = [];
  await Promise.all([...new Set(MODELS)].map(async (name) => {
    try {
      const g = await gl.loadAsync(`assets/models/${name}.slim.glb`);
      models[name] = g.scene;
      tick();
    } catch (e) {
      // **不要**只 console.warn 就完事。静默吞掉的资产加载失败会一路带到线上：
      // build.js 照常按 MODELS 表摆道具，渲染层 `assets.models[name]` 拿到 undefined
      // 静默跳过，最后表现为「那批道具凭空消失」，查起来毫无线索。
      // 所以记下来，交给 tools/check-assets.mjs 断言。
      modelErrs.push({ name, err: String(e.message || e).slice(0, 120) });
      console.warn('模型加载失败', name, e.message);
      tick();
    }
  }));

  // 水下环境光用海生馆 HDRI；内舱用洞穴 HDRI 备用
  const env = {};
  for (const [key, file] of [['sea', 'ushaka_sea_world_aquarium'], ['cave', 'small_cave']]) {
    try {
      const d = await new RGBELoader().loadAsync(`assets/hdri/${file}.hdr`);
      const pmrem = new THREE.PMREMGenerator(renderer);
      env[key] = pmrem.fromEquirectangular(d).texture;
      d.dispose(); pmrem.dispose();
      tick();
    } catch (e) { console.warn('HDRI 加载失败', file, e.message); tick(); }
  }

  return { tex, models, env, errs: { models: modelErrs } };
}

/**
 * 用一套贴图生成 PBR 材质。
 * arm 贴图打包了 AO(R) / 粗糙度(G) / 金属度(B)，一张图顶三张。
 */
export function pbr(tex, setName, opts = {}) {
  const t = tex[setName];
  if (!t) return new THREE.MeshStandardMaterial({ color: opts.color ?? 0x9aa0a2, roughness: 0.85 });
  const m = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap,
    roughnessMap: t.armMap,
    metalnessMap: t.armMap,
    aoMap: t.armMap,
    roughness: 1,
    metalness: opts.metalness ?? 1,
    color: opts.color ?? 0xffffff,
    aoMapIntensity: 0.85,
    normalScale: new THREE.Vector2(opts.normal ?? 1, opts.normal ?? 1),
    envMapIntensity: opts.env ?? 0.8,
  });
  if (opts.repeat) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].repeat.set(opts.repeat, opts.repeat); }
  m.userData.tile = TILE[opts.tile || 'iron'] ?? 2.2;
  return m;
}

/**
 * 按米缩放盒体 UV。dims 是六个面的 [宽,高]（米）。
 * 这样同一张贴图贴到 3m 墙和 30m 地板上，纹理密度一致。
 */
export function boxUV(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  // three 的 BoxGeometry 面序：+X, -X, +Y, -Y, +Z, -Z，每面 4 个顶点
  const faces = [
    [d, h], [d, h], [w, d], [w, d], [w, h], [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = faces[f];
    const su = fw / tile, sv = fh / tile;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

export function planeUV(geo, w, d, tile) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  const su = w / tile, sv = d / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/** 生成一个按米缩放 UV 的盒体几何体 */
export function tiledBox(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  return boxUV(g, w, h, d, tile);
}

/** 生成一个按米缩放 UV 的平面几何体（朝上） */
export function tiledPlane(w, d, tile) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  return planeUV(g, w, d, tile);
}
