// 渲染器 / 固定斜角摄像机 / 水下光照 / 后期 / 画质分级。
//
// 摄像机是整个设计的支点：yaw 锁 45°、pitch 锁 56°、没有自由视角。
// 玩家不能转头，只能转角色；鼠标只用来在地面选一个瞄准点。
// 这样命中判定能退化成 2D，AI 视线不必算高度差，单层建筑也不会卡死。
// 代价是深度感弱，所以水下浊光 + 悬浮颗粒 + 焦散要帮忙把画面撑住。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { updateSeeThrough, disableSeeThrough } from './seethrough.js';

export const CAM = {
  yaw: Math.PI / 4,
  pitch: THREE.MathUtils.degToRad(56),
  dist: 20,
  target: new THREE.Vector3(),
  cur: new THREE.Vector3(),
  shake: 0,
};

// 雾：深海的敌人。参考作是 50/130，这里压到 12/95 —— 水下看不清远处才合理，
// 而且这让远处的 draw call 靠深度剔除自然消失，是免费的性能优化。
const FOG_COLOR = new THREE.Color(0x0d2b33);
const FOG_NEAR = 12;
const FOG_FAR = 95;

export const QUALITY = {
  high: { name: '高', dpr: 1.5, msaa: 4, shadow: 2048, bloom: true, particulate: 900 },
  medium: { name: '中', dpr: 1.25, msaa: 2, shadow: 2048, bloom: true, particulate: 500 },
  low: { name: '低', dpr: 1.0, msaa: 0, shadow: 1024, bloom: false, particulate: 200 },
};

export function createRenderer(canvas) {
  // preserveDrawingBuffer：无头截图时浏览器可能抓到已清空的缓冲，
  // 表现为"明明渲染了 4.6M 三角面、截图却全黑"。开发期始终开着。
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  // 让统计跨所有 pass 累加（EffectComposer 每个 pass 都会 reset）
  renderer.info.autoReset = false;
  return renderer;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
  scene.background = FOG_COLOR;
  return scene;
}

export function createCamera() {
  const cam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 400);
  cam.position.set(0, 0, 20);
  return cam;
}

/**
 * 水下光照。
 *
 * 调了好几版才找到感觉。核心问题不是「亮度不够」，而是**动态范围太窄**：
 * 实测 95% 的像素挤在亮度 32~128 之间，高光（>128）几乎一个都没有。
 * 全是中间调的画面看着就是一团绿糊 —— 形体、光源方向、材质全都读不出来。
 *
 * 所以目标不是更亮，而是**拉开明暗**：
 *   - 甲板压暗（接近剪影），道具和轮廓才跳得出来
 *   - 平行光加强、半球光减弱 → 有方向性的明暗，物体才有体积
 *   - 下半球用暖色 → 朝上/朝下的面不同色，否则物体是平的
 * 深水散射让对比度天然低于户外，但「低对比」不等于「零对比」。
 */
export function createLights(scene) {
  const sun = new THREE.DirectionalLight(0xa8f0e6, 3.4);
  sun.position.set(-0.42, 1, 0.28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const SH = 34;
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 180 });
  // 必须手动重算投影矩阵：three 只在 new OrthographicCamera() 时算一次，
  // 之后改 left/right/top/bottom/near/far 它不会自动更新。
  // 不调这一行，阴影相机的实际范围还是默认的 ±5m，等于阴影只盖住玩家脚下 10m。
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  // 上半球水色（冷），下半球海床暖沙色 —— 后者是体积感的关键
  const hemi = new THREE.HemisphereLight(0x2f7d8c, 0x2a2620, 1.25);
  scene.add(hemi);
  return { sun, hemi };
}

/**
 * 阳光方向：**常量**。方向一旦定下来就别再从 sun.position 反推。
 * 踩过的坑：原来写成 `dir = sun.position.normalize()` 再
 * `sun.position = focus + dir * 70` —— 这是个反馈回路，dir 每帧都从
 * 「上一帧算出的世界坐标」重新归一化，方向会一路螺旋下沉，
 * 几十帧后 y 变负数，**太阳掉到甲板底下去了**。
 * 表现是 8 个出生点里 6 个开局全黑：平行光照不到朝上的地板，
 * 只剩非常暗的半球光（间接光要除 π，数值小到几乎看不见）。
 * 深度、雾、材质全对，只有光没了 —— 读代码看不出来，必须量画面亮度。
 */
const SUN_DIR = new THREE.Vector3(-0.42, 1, 0.28).normalize();
const SUN_DIST = 70;

/** 阴影相机跟随玩家并按纹素对齐，避免阴影边缘游动 */
const _lx = new THREE.Vector3(), _ly = new THREE.Vector3();
export function followShadow(sun, focus) {
  const SH = 34;
  const texel = (SH * 2) / sun.shadow.mapSize.x;
  const dir = SUN_DIR;
  _lx.set(0, 1, 0).cross(dir).normalize();
  _ly.copy(dir).cross(_lx);
  const px = focus.x * _lx.x + focus.y * _lx.y + focus.z * _lx.z;
  const py = focus.x * _ly.x + focus.y * _ly.y + focus.z * _ly.z;
  const pz = focus.x * dir.x + focus.y * dir.y + focus.z * dir.z;
  // 在光空间里把焦点吸附到纹素网格，否则镜头一动阴影边缘就会「游动」
  const ax = Math.round(px / texel) * texel;
  const ay = Math.round(py / texel) * texel;
  const az = Math.round(pz / texel) * texel;
  const fx = ax * _lx.x + ay * _ly.x + az * dir.x;
  const fy = ax * _lx.y + ay * _ly.y + az * dir.y;
  const fz = ax * _lx.z + ay * _ly.z + az * dir.z;
  sun.target.position.set(fx, fy, fz);
  sun.position.set(fx + dir.x * SUN_DIST, fy + dir.y * SUN_DIST, fz + dir.z * SUN_DIST);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
  shadowDirty = true;
}

let shadowDirty = true;
export function markShadowDirty() { shadowDirty = true; }
export function consumeShadowDirty() { const v = shadowDirty; shadowDirty = false; return v; }

/** 建后期链。半浮点缓冲 + MSAA，否则离屏渲染 antialias 失效，边缘全是锯齿。 */
export function createComposer(renderer, scene, camera) {
  const dpr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(innerWidth * dpr, innerHeight * dpr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.62, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return { composer, bloom, rt };
}

export function applyQuality(renderer, comp, sun, key) {
  const q = QUALITY[key];
  if (!q) return;
  const dpr = Math.min(devicePixelRatio, q.dpr);
  renderer.setPixelRatio(dpr);
  comp.composer.setPixelRatio(dpr);
  for (const rt of [comp.composer.renderTarget1, comp.composer.renderTarget2]) {
    if (rt.samples !== q.msaa) { rt.samples = q.msaa; rt.dispose(); }
  }
  comp.composer.setSize(innerWidth, innerHeight);
  if (sun.shadow.mapSize.x !== q.shadow) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  comp.bloom.enabled = q.bloom;
  renderer.shadowMap.needsUpdate = true;
}

export function onResize(renderer, comp, camera) {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  comp.composer.setSize(innerWidth, innerHeight);
}

/**
 * 固定斜角摄像机跟随玩家。
 * @param {THREE.Vector3} aim 世界瞄准点（鼠标选出来的地面点）
 */
export function updateCamera(cam, player, aim, dt, aiming) {
  const look = aiming ? 0.42 : 0.22;
  const ax = aim ? THREE.MathUtils.clamp(aim.x - player.x, -40, 40) : 0;
  const az = aim ? THREE.MathUtils.clamp(aim.z - player.z, -40, 40) : 0;
  CAM.target.set(player.x + ax * look, player.y || 0, player.z + az * look);
  const k = 1 - Math.exp(-dt * 6);
  CAM.cur.lerp(CAM.target, k);
  const want = aiming ? 23 : 20;
  CAM.dist += (want - CAM.dist) * k;

  const s = CAM.shake * 0.35;
  CAM.shake *= Math.exp(-dt * 10);
  cam.position.set(
    CAM.cur.x + Math.sin(CAM.yaw) * Math.cos(CAM.pitch) * CAM.dist + (Math.random() - 0.5) * s,
    CAM.cur.y + Math.sin(CAM.pitch) * CAM.dist,
    CAM.cur.z + Math.cos(CAM.yaw) * Math.cos(CAM.pitch) * CAM.dist + (Math.random() - 0.5) * s
  );
  cam.lookAt(CAM.cur);
  cam.updateMatrixWorld();

  updateSeeThrough(
    new THREE.Vector3(player.x, (player.y || 0) + 1.0, player.z),
    cam.position
  );
}

export function resetCameraTo(player) {
  CAM.cur.set(player.x, player.y || 0, player.z);
  CAM.shake = 0;
  disableSeeThrough();
}

export { FOG_COLOR, FOG_NEAR, FOG_FAR };
