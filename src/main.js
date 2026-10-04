// 入口：加载资源 → 建场景 → 部署 → 主循环。中文 UI 在 ui/hud.js。
import * as THREE from 'three';
import { loadAssets } from './render/materials.js';
import {
  createRenderer, createScene, createCamera, createLights, createComposer,
  applyQuality, onResize, updateCamera, resetCameraTo, followShadow,
  consumeShadowDirty, CAM, QUALITY,
} from './render/renderer.js';
import { buildSceneFromDrawList } from './render/world3d.js';
import { Underwater } from './render/water.js';
import { FX } from './render/fx.js';
import { Diver } from './render/character.js';
import { buildWorld } from './world/build.js';
import { Raid } from './core/raid.js';
import { newProfile } from './core/rules.js';
import { Hud } from './ui/hud.js';
import { Settle } from './ui/settle.js';
import { Camp } from './ui/camp.js';
import { RARITY_COLOR } from './core/catalog.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#gl');

// 渲染调试开关：?off=fog,shadow,bloom,env,tone,post
// 出画面问题时用它逐项关掉，定位到底是哪一层把画面吃掉了。
const OFF = new Set((new URLSearchParams(location.search).get('off') || '').split(',').filter(Boolean));

// ---------- 存档 ----------
const SAVE_KEY = 'abyss_profile_v1';
function loadProfile() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { ...newProfile(), ...p, stats: { ...newProfile().stats, ...(p.stats || {}) } };
    }
  } catch { /* 存档损坏就重开一局 */ }
  return newProfile();
}
function saveProfile(p) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(p)); } catch { /* 隐私模式写不进去，忽略 */ }
}
let profile = loadProfile();

// ---------- 渲染器 ----------
const renderer = createRenderer(canvas);
const scene = createScene();
const camera = createCamera();
const { sun } = createLights(scene);
const comp = createComposer(renderer, scene, camera);

let quality = 'high';
try { quality = localStorage.getItem('abyss_q') || 'high'; } catch { /* 忽略 */ }
applyQuality(renderer, comp, sun, quality);
addEventListener('resize', () => onResize(renderer, comp, camera));

// ---------- 输入 ----------
const input = {
  keys: {}, pressed: {}, mouse: false, clicked: false, ads: false,
  mx: innerWidth / 2, my: innerHeight / 2, aim: new THREE.Vector3(), wheel: 0,
};
addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();
  if (!input.keys[e.code]) input.pressed[e.code] = true;
  input.keys[e.code] = true;
});
addEventListener('keyup', (e) => { input.keys[e.code] = false; });
addEventListener('blur', () => { input.keys = {}; input.mouse = false; input.ads = false; });
addEventListener('mousemove', (e) => { input.mx = e.clientX; input.my = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) { input.mouse = true; input.clicked = true; }
  if (e.button === 2) input.ads = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.mouse = false; if (e.button === 2) input.ads = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => {
  if (!raid) return;
  input.wheel += Math.sign(e.deltaY);
  if (input.wheel) { raid.switchSlot((raid.player.cur + 1) % 3); input.wheel = 0; }
}, { passive: true });

// ---------- 瞄准：鼠标 → 玩家高度的水平面 ----------
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.3);
const _ndc = new THREE.Vector2();
function updateAim() {
  const p = raid.player;
  _ndc.set((input.mx / innerWidth) * 2 - 1, -(input.my / innerHeight) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  _plane.constant = -((p.y || 0) + 1.3);
  if (!_ray.ray.intersectPlane(_plane, input.aim)) input.aim.set(p.x, p.y, p.z + 6);
}

// ---------- 全局状态 ----------
let world = null, world3d = null, water = null, fx = null, raid = null;
let playerDiver = null;
const hud = new Hud();
// 结算面板的「再来一局」要能重建一整局。
const settle = new Settle({
  onAgain: () => restartRaid(),
  onBack: () => { settle.hide(); camp.show(lastLoadout); },
});
// 营地是**入口**。没有它 deploy() 只能从控制台调，游戏加载完是个点不了的空屏
// —— 这正是上一版的情况：所有自动化检查都绿，因为它们都用控制台进场。
const camp = new Camp(profile, (lo) => { lastLoadout = lo; deploy(lo); });
let lastLoadout = null;
const enemyDivers = new Map();
let ready = false;

// ---------- 启动 ----------
async function boot() {
  const setTxt = (t) => { const e = $('#ldtxt'); if (e) e.textContent = t; };
  const setBar = (v) => { const e = $('#ldbar'); if (e) e.style.width = Math.round(v * 100) + '%'; };

  setTxt('正在加载资源…');
  const assets = await loadAssets(renderer, (p) => setBar(p * 0.78));
  // HDRI 是后台加载的（1.65MB，占首屏 13%，但只影响环境反射）。
  // 等它到位再挂上去，不要 await —— 玩家早几十秒能进游戏。
  if (!OFF.has('env')) {
    assets.envReady.then(() => {
      if (assets.env.sea && !scene.environment) {
        scene.environment = assets.env.sea;
        scene.environmentIntensity = 0.55;
      }
    });
  }
  if (OFF.has('fog')) { scene.fog = null; scene.background = new THREE.Color(0x101010); }
  if (OFF.has('shadow')) { renderer.shadowMap.enabled = false; sun.castShadow = false; }
  if (OFF.has('tone')) { renderer.toneMapping = THREE.NoToneMapping; }
  if (OFF.has('bloom')) comp.bloom.enabled = false;

  setTxt('正在生成平台结构…');
  await new Promise((r) => setTimeout(r, 16));
  world = buildWorld({ seed: 20260928 });
  water = new Underwater(scene, world.half, QUALITY[quality].particulate);
  world3d = buildSceneFromDrawList(scene, world, assets, water);
  water.attachExtracts(world.extracts);

  setTxt('正在编译着色器…');
  setBar(0.94);
  fx = new FX(scene);
  playerDiver = new Diver(false);
  scene.add(playerDiver.root);

  renderer.compile(scene, camera);
  setBar(1);
  setTxt('就绪');
  const ld = $('#loading');
  if (ld) ld.style.display = 'none';
  // 加载完直接进营地，玩家从这里出发。少了这一步就是「黑屏 + 无从下手」——
  // 上一版没有营地界面，deploy() 只能从控制台调，所有自动检查都绿，人却进不去。
  camp.show();
  ready = true;

  // 调试钩子（无副作用，只读）
  window.__abyss = {
    get raid() { return raid; }, world, scene, renderer, camera, input, CAM, assets,
    // 暴露 three 本体，调试工具才能构造 Raycaster / Vector2 去问
    // 「屏幕上这块绿色到底是什么」。之前探针只能统计颜色和遍历类型，
    // 定位「几片薄荷绿碎条」查了好几轮都没命中（海草是 merge 过的
    // BufferGeometry，按 geometry.type 筛不出来）。
    THREE,
    deploy, profile, setQuality: (q) => { quality = q; applyQuality(renderer, comp, sun, q); },
    stats: () => ({
      drawCalls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      geoms: renderer.info.memory.geometries, tex: renderer.info.memory.textures,
      shadow: {
        on: renderer.shadowMap.enabled, auto: renderer.shadowMap.autoUpdate,
        need: renderer.shadowMap.needsUpdate, map: !!sun.shadow.map,
        cast: sun.castShadow, pos: sun.position.toArray().map((v) => +v.toFixed(1)),
        cam: [sun.shadow.camera.left, sun.shadow.camera.right, sun.shadow.camera.top,
          sun.shadow.camera.bottom, sun.shadow.camera.near, sun.shadow.camera.far],
      },
    }),
    worldStats: () => world3d,
  };
  if (window.__onReady) window.__onReady();
}

// ---------- 部署 ----------
function deploy(overrides) {
  if (!ready || raid) return null;
  // 固定种子用 ?seed=123：做 A/B 对比时随机种子会让每次结果都不一样，根本没法比
  const forced = new URLSearchParams(location.search).get('seed');
  const seed = forced != null ? (+forced >>> 0) : ((Math.random() * 0x7fffffff) >>> 0);
  const base = { gun: 'reef', suit: 's2', helm: 'h1', pack: 'k2', meds: 2, difficulty: 'diver', insured: true };
  const lo = { ...base, ...(overrides || window.__loadout || {}) };
  raid = new Raid({ world, loadout: lo, seed, profile });
  raid.camYaw = CAM.yaw;
  resetCameraTo(raid.player);

  for (const d of enemyDivers.values()) scene.remove(d.root);
  enemyDivers.clear();
  for (const e of raid.enemies) {
    if (e.boss) continue;
    const d = new Diver(true);
    scene.add(d.root);
    enemyDivers.set(e, d);
  }
  document.body.classList.add('in-raid');
  hud.show(true);
  hud.cache = {};                 // 换局要把上一局的缓存值清掉，否则新局第一帧不刷新
  hud.push('潜水点已就位 — 找到减压舱上浮', '#5cffc8');
  if (window.__onDeploy) window.__onDeploy(raid);
  return raid;
}

function abortRaid() {
  if (!raid || raid.over) return;
  raid.end('abandon');
}

/** 结算面板的「返回营地」：回到配装界面。 */
function lobby() {
  settle.hide();
  camp.show(lastLoadout);
}

/** 再来一局：用上局配装直接重开，不回营地（省一次点击）。 */
function restartRaid() {
  settle.hide();
  const ld = $('#loading');
  if (ld) ld.style.display = 'none';
  raid = null;
  for (const d of enemyDivers.values()) scene.remove(d.root);
  enemyDivers.clear();
  document.body.classList.remove('in-raid');
  deploy(lastLoadout || undefined);
}

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let rafEMA = 16.7, frameNo = 0;
const _focus = new THREE.Vector3();

function loop(now) {
  requestAnimationFrame(loop);
  if (rafEMA > 0) {
    const d = now - lastNow;
    if (d > 0 && d < 60) rafEMA += (d - rafEMA) * 0.05;
  }
  lastNow = now;
  // 高刷屏隔帧渲染，稳定在 ~60fps，帧间隔均匀不会忽快忽慢
  const half = rafEMA < 11 && (frameNo & 1) === 1;
  frameNo++;
  if (half) return;

  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (!ready) { comp.composer.render(); return; }
  if (raid && !raid.over) {
    updateAim();
    raid.aiming = input.ads;
    raid.update(dt, input);
    updatePlayerVisual(dt);
    updateEnemyVisuals(dt);
  }
  // 事件消费必须在 `!raid.over` 守卫**外面**。
  // 对局在 raid.update() 里结束时，同一帧消费没问题；但如果从别处调用
  // end()（放弃行动、测试里直接 end、未来的掉线处理），下一帧就会因为
  // raid.over 而整段跳过，end 事件永远留在 events 里 ——
  // 表现为「按了放弃，结算界面不弹，游戏卡在最后一帧」。
  consumeRaidEvents();

  water.update(dt, camera.position);
  if (world3d) world3d.update(camera.position);
  fx.update(dt);
  if (raid) {
    const p = raid.player;
    _focus.set(p.x, p.y || 0, p.z);
    followShadow(sun, _focus);
    if (consumeShadowDirty()) renderer.shadowMap.needsUpdate = true;
    updateCamera(camera, p, input.aim, dt, input.ads);
  }
  if (window.__onFrame) window.__onFrame(dt);

  // 界面快捷键。放在这里而不是 keydown 里，是为了让同一个物理按键
  // 在不同界面有不同含义：营地回车 = 下潜，结算面板 H = 再来一局
  // （对局中 H 是急救包，不能被结算面板抢走）。
  if (input.pressed.Enter || input.pressed.NumpadEnter) {
    if (camp.hotkey(input.pressed)) input.pressed = {};
  }
  if (input.pressed.KeyH || input.pressed.Escape) {
    if (settle.hotkey(input.pressed)) input.pressed = {};
  }
  // 对局中 Esc = 放弃。abortRaid 之前只是 export 出去没有任何调用方，
  // README 里写着「Esc 放弃本局」，实际按了没反应。
  // 只在「有对局且没结束」时拦，避免和结算面板的 Esc=返回营地打架。
  if (input.pressed.Escape && raid && !raid.over) {
    abortRaid();
    input.pressed = {};
  }

  hud.tickFeed(dt);
  if (raid && document.body.classList.contains('in-raid')) hud.update(raid, input);

  renderer.info.reset();
  if (OFF.has('post')) renderer.render(scene, camera);
  else comp.composer.render();
  input.pressed = {};
  input.clicked = false;
}
let lastNow = 0;

// ---------- 视觉同步 ----------
function updatePlayerVisual(dt) {
  const p = raid.player;
  playerDiver.root.position.set(p.x, p.y || 0, p.z);
  const speed = Math.hypot(p.vx, p.vz);
  const fX = Math.sin(p.angle), fZ = Math.cos(p.angle);
  const mvDot = (p.vx * fX + p.vz * fZ) / Math.max(0.001, speed);
  playerDiver.update(dt, speed, mvDot, p.angle);
  playerDiver.beam.intensity = 2.2;
}

function updateEnemyVisuals(dt) {
  for (const [e, d] of enemyDivers) {
    if (e.dead) {
      d.setOpacity(Math.max(0, 1 - e.deadT * 1.8));
      if (e.deadT > 0.6) d.setVisible(false);
      continue;
    }
    d.setVisible(true);
    d.root.position.set(e.x, e.y || 0, e.z);
    const speed = Math.hypot(e.vx, e.vz);
    const fX = Math.sin(e.angle), fZ = Math.cos(e.angle);
    d.update(dt, speed, (e.vx * fX + e.vz * fZ) / Math.max(0.001, speed), e.angle);
  }
}

// ---------- 事件消费：把逻辑层事件翻译成特效 ----------
function consumeRaidEvents() {
  // 现在每帧都会调（不再只在对局进行中调），所以 raid 为 null 时必须挡住
  if (!raid) return;
  const ev = raid.events;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    switch (e.k) {
      case 'shot':
        fx.muzzle(e.x, e.y, e.z, e.ang);
        if (e.byPlayer) playerDiver.fire();
        break;
      case 'hit': fx.hit(e.x, e.y, e.z, !e.byPlayer); break;
      case 'boom': fx.hit(e.x, e.y + 0.6, e.z, !e.byPlayer); break;
      case 'hurt': CAM.shake = Math.max(CAM.shake, 0.4); break;
      // ---- 以下是纯 UI 事件：逻辑层已经把结论算好了，这里只翻译成一行字 ----
      case 'take': hud.pushTake(e.name, e.rare); break;
      case 'reveal': hud.push(`发现 ${e.name}`, e.rare >= 3 ? RARITY_COLOR[e.rare] : '#9fd0d8'); break;
      case 'rareBanner': hud.pushCenter(RARITY_COLOR[e.rare] || '战利品'); break;
      case 'kill': hud.push(`击杀 ${e.name}`, '#ff9c8a'); break;
      case 'toast': hud.push(e.text, '#ffd166'); break;
      case 'equip': hud.push(`装备 ${e.what}`, '#8ff0ff'); break;
      case 'healed': hud.push('已急救', '#5fd068'); break;
      case 'healCancel': hud.push('急救被打断', '#ffd166'); break;
      case 'end': onRaidEnd(); break;
    }
  }
  ev.length = 0;
}

function onRaidEnd() {
  // 先结算（写存档、算清账），再画面板 —— 面板要读的就是结算后的 profile
  const res = raid.finalize(profile);
  saveProfile(profile);
  document.body.classList.remove('in-raid');
  hud.show(false);
  settle.show(raid, res, profile);
  if (window.__onRaidEnd) window.__onRaidEnd(raid, res, profile);
}

boot().then(() => {
  requestAnimationFrame(loop);
}).catch((e) => {
  console.error(e);
  const el = $('#loading');
  if (el) {
    el.style.display = 'flex';
    el.innerHTML = '<div class="bootfail"><b>启动失败</b><p>' + String(e && e.message || e) + '</p></div>';
  }
});

export { input, deploy, abortRaid, saveProfile };
