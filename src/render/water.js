// 水下氛围：焦散、悬浮颗粒、气泡、上行气泡柱、海草。
//
// 这是本作的视觉命脉。固定摄像机 + 有限视野本来就容易显得平，
// 水下浊光、飘动的颗粒和晃动的气泡柱能把画面撑住，而且几乎零成本：
// 焦散是一个 shader 注入，颗粒和气泡都是 InstancedMesh。

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { markPatched } from './seethrough.js';
import { heightAt, HALF, SEA_LEVEL } from '../world/layout.js';

/**
 * 给地面材质注入焦散：两层滚动的 voronoi-ish 图案取 min，叠在亮度上。
 * 水下没有太阳直射，焦散是唯一能让地面"活"起来的东西。
 */
export function addCaustics(mat, uniforms) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vWPos;\nuniform float uTime;\nuniform float uCaustic;\n'
      + CAUSTIC_FN
      + shader.fragmentShader
        // 注入点必须是 lights_fragment_end（光照阶段），**不能**是 dithering_fragment。
        // dithering_fragment 在 three 的片元着色器里排在
        // tonemapping → colorspace → fog **之后**，也就是说那时候的 gl_FragColor
        // 已经是 sRGB 显示值了。在那里做加法有两个后果：
        //   1) 数值是在显示空间里加的，同样大小看起来强好几倍；
        //   2) **雾完全失效** —— 图案叠在雾的上面，一路铺到天边，平铺感一眼看穿。
        // 当成额外的漫反射光加进去，才会被色调映射和雾正确处理。
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  float cFade = 1.0 - smoothstep(16.0, 58.0, length(vWPos - cameraPosition));
  // 乘一个青蓝色：水下的光被水散射过，偏蓝。直接用漫反射色相乘会得到
  // 一层灰白花纹，看起来像地面贴了张花纹贴图，而不是光。
  reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.55, 0.95, 1.0)
                                * caustic(vWPos.xz) * uCaustic * cFade;`);
  };
  mat.needsUpdate = true;
  // 焦散是 onBeforeCompile 补丁，必须有独立的 program 缓存键，
  // 否则会和「没打补丁」的材质共用同一个编译结果（实测整屏变黑）
  markPatched(mat, 'caustic');
  return mat;
}

const CAUSTIC_FN = /* glsl */`
float caustic(vec2 p) {
  float t = uTime * 0.32;
  float a = 0.0;
  // 三组不同频率/相位的波纹取最小值，形成网状光斑
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 q = p * (3.1 + fi * 1.15) + vec2(t * (0.9 + fi * 0.2), t * (0.5 - fi * 0.16));
    float v = abs(sin(q.x) * cos(q.y) + sin(q.y * 1.31 + t) * 0.6);
    a = (i == 0) ? v : min(a, v);
  }
  // 频率必须够高：0.34 rad/m 的波长是 18m，铺在甲板上就是一个巨大的
  // "脑珊瑚"漩涡而不是水下光斑。3.1 rad/m → 2m 波长，才像焦散。
  a = pow(clamp(1.0 - a, 0.0, 1.0), 6.0);
  return a;
}
`;

export class Underwater {
  /**
   * @param {THREE.Scene} scene
   * @param {number} half 地图半边长
   * @param {number} count 颗粒数量（按画质档给）
   */
  constructor(scene, half = HALF, count = 700) {
    this.scene = scene;
    this.half = half;
    this.time = 0;
    this.uniforms = {
      uTime: { value: 0 },
      // 焦散是**一层很淡的微光**。这个函数的零集是一张密集的曲线网，
      // pow 收窄之后看着仍是一张覆盖全甲板的花纹图案；数值必须小到
      // 「只在余光里闪一下」的程度，否则地板就像贴了张花纹贴图。
      uCaustic: { value: 0.26 },
    };
    this.rng = new Rng(4242);
    this.buildParticles(count);
    this.buildExtractColumns();
    this.buildSeagrass();
  }

  // ---- 悬浮颗粒：跟着摄像机走，永远在视野里 -------------------------------
  buildParticles(n) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (this.rng.f() - 0.5) * 60;
      pos[i * 3 + 1] = this.rng.f() * 14;
      pos[i * 3 + 2] = (this.rng.f() - 0.5) * 60;
      seed[i] = this.rng.f();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uSize: { value: 46 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime; uniform float uSize;
        varying float vA;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.35 + aSeed * 31.0) * 1.6;
          p.y += sin(uTime * 0.22 + aSeed * 17.0) * 0.9;
          p.z += cos(uTime * 0.29 + aSeed * 23.0) * 1.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (0.35 + aSeed * 0.8) / max(1.0, -mv.z);
          vA = 0.20 + aSeed * 0.35;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(d)) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.72, 0.92, 0.95, a);
        }`,
    });
    this.particles = new THREE.Points(g, m);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 3;
    this.scene.add(this.particles);
  }

  // ---- 减压舱的上行气泡柱：全场唯一的绿色地标 ---------------------------
  buildExtractColumns() {
    this.columns = [];
    this.columnDefs = [];
  }

  /** 地图就绪后调用：按减压舱坐标生成气泡柱 */
  attachExtracts(extracts) {
    for (const c of this.columns) this.scene.remove(c);
    this.columns = [];
    for (const e of extracts) {
      const y = heightAt(e.x, e.z);
      const g = new THREE.CylinderGeometry(1.5, 2.2, 16, 18, 1, true);
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(0x5cffc8) } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: /* glsl */`
          varying vec2 vUv; uniform float uTime; uniform vec3 uColor;
          void main(){
            float up = fract(vUv.y * 3.0 - uTime * 0.55);
            float ring = smoothstep(0.0, 0.25, up) * smoothstep(1.0, 0.6, up);
            float fade = (1.0 - vUv.y) * 0.55 + 0.12;
            gl_FragColor = vec4(uColor, ring * fade * 0.5);
          }`,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(e.x, y + 8, e.z);
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.columns.push(mesh);

      // 底座圆环，标出撤离区范围
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(3.6, 4.0, 40),
        new THREE.MeshBasicMaterial({ color: 0x5cffc8, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(e.x, y + 0.06, e.z);
      this.scene.add(ring);
    }
  }

  // ---- 海草：给海床区域一点生气，实例化 -------------------------------
  buildSeagrass() {
    const blades = [];
    for (let i = 0; i < 260; i++) {
      const x = (this.rng.f() - 0.5) * this.half * 2;
      const z = (this.rng.f() - 0.5) * this.half * 2;
      if (Math.abs(x) > this.half - 6 || Math.abs(z) > this.half - 6) continue;
      const y = heightAt(x, z);
      const h = 1.4 + this.rng.f() * 2.6;
      const g = new THREE.PlaneGeometry(0.5, h, 1, 3);
      g.translate(0, h / 2, 0);
      g.rotateY(this.rng.f() * Math.PI);
      g.translate(x, y, z);
      blades.push(g);
    }
    if (!blades.length) { this.seagrass = null; return; }
    const merged = mergeSimple(blades);
    const m = new THREE.MeshStandardMaterial({
      color: 0x2f6b4a, roughness: 0.9, side: THREE.DoubleSide,
      transparent: true, opacity: 0.85, alphaTest: 0.02,
    });
    this.seagrass = new THREE.Mesh(merged, m);
    this.seagrass.receiveShadow = false;
    this.scene.add(this.seagrass);
  }

  update(dt, camPos) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.particles && camPos) {
      // 颗粒群跟随摄像机，永远在视野里
      this.particles.position.set(
        Math.round(camPos.x / 30) * 30,
        Math.round(camPos.y / 14) * 14,
        Math.round(camPos.z / 30) * 30
      );
    }
    if (this.seagrass) {
      this.seagrass.rotation.z = Math.sin(this.time * 0.5) * 0.03;
    }
  }
}

// 极简合并：只处理 position/normal/uv，避免引 three 的 addon
function mergeSimple(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    const c = p.count;
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo; }
    else { for (let i = 0; i < c; i++) idx[io++] = i + vo; }
    vo += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export { SEA_LEVEL };
