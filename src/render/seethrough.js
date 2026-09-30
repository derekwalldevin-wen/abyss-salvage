// 「透墙」着色器：沿 玩家→摄像机 这条线开一条圆柱通道，把挡住视线的舱壁用
// 4×4 Bayer 有序抖动溶解掉（最多 90% 覆盖率，所以墙还在，但能看穿）。
//
// 这是照抄参考作验证过的做法，它解决了固定斜角摄像机最大的问题：
// 没有自由视角时，舱壁会同时挡住玩家和敌人。
//
// 优点：零额外几何、零排序问题、CPU 开销为 0。
// 代价：discard 会破坏 early-Z，是填充率杀手；所以只给舱壁类材质挂，
//       地面/水面不挂。

import * as THREE from 'three';

export const seeThrough = {
  uPlayer: { value: new THREE.Vector3(0, -999, 0) },
  uCam: { value: new THREE.Vector3(0, 0, 0) },
  uRadius: { value: 2.7 },
};

const VERT_HOOK = /* glsl */`
  vec4 stP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    stP = instanceMatrix * stP;
  #endif
  vSTPos = (modelMatrix * stP).xyz;
`;

// 注入点在 main() 内部声明常量数组 —— 放在文件级 scope 在某些驱动上会出问题，
// 而且和 three 自己注入的代码混在一起很难排查。
const FRAG_HOOK = /* glsl */`
  {
    vec3 cp = uCam - uPlayer;
    float cpLen = length(cp);
    if (cpLen > 0.001) {
      vec3 dir = cp / cpLen;
      vec3 rel = vSTPos - uPlayer;
      float t = dot(rel, dir);
      if (t > 0.35) {
        float dist = length(rel - dir * t);
        float radial = 1.0 - smoothstep(uRadius * 0.5, uRadius, dist);
        float vert = smoothstep(-0.2, 1.6, rel.y);
        float fade = radial * vert;
        if (fade > 0.02) {
          const float bayer[16] = float[16](
             0.0,  8.0,  2.0, 10.0,
            12.0,  4.0, 14.0,  6.0,
             3.0, 11.0,  1.0,  9.0,
            15.0,  7.0, 13.0,  5.0);
          ivec2 bq = ivec2(mod(gl_FragCoord.xy, 4.0));
          float n = (bayer[bq.y * 4 + bq.x] + 0.5) / 16.0;
          // 上限 0.62 而不是 0.9：0.9 会把墙溶成一大片规则斜条纹，
          // 看起来像渲染出错而不是「看穿了」。0.62 保留墙的大致轮廓，
          // 又足够让玩家看清墙后面的敌人。
          if (n < fade * 0.62) discard;
        }
      }
    }
  }
`;

// 调试用：?stsimple=1 保留全部注入但不做任何 discard，用来区分
// 「discard 逻辑把画面干掉了」和「注入本身把材质搞坏了」
const FRAG_NOOP = '  /* see-through disabled */\n';

const patched = new WeakSet();

/** 调试开关：?stsimple=1 时保留注入但不做 discard */
const SIMPLE = typeof location !== 'undefined' && /(^|[?&])stsimple=1(&|$)/.test(location.search);

/**
 * 程序缓存键。用 onBeforeCompile 改过 shader 的材质**必须**有自己独立的缓存键，
 * 否则 three 可能把「打过补丁」和「没打补丁」的材质编到同一个 program 上。
 */
export function patchKey(mat) {
  const p = mat.userData._patches || (mat.userData._patches = []);
  return p.slice().sort().join('+') || 'plain';
}

export function markPatched(mat, tag) {
  const p = mat.userData._patches || (mat.userData._patches = []);
  if (!p.includes(tag)) p.push(tag);
  mat.customProgramCacheKey = () => patchKey(mat);
  mat.needsUpdate = true;
}

/** 给材质挂上透墙效果。重复调用安全。 */
export function addSeeThrough(mat) {
  if (!mat || patched.has(mat)) return mat;
  patched.add(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    Object.assign(shader.uniforms, seeThrough);
    shader.vertexShader = 'varying vec3 vSTPos;\n' + shader.vertexShader
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_HOOK);
    shader.fragmentShader = 'varying vec3 vSTPos;\nuniform vec3 uPlayer;\nuniform vec3 uCam;\nuniform float uRadius;\n'
      + shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + (SIMPLE ? FRAG_NOOP : FRAG_HOOK));
  };
  markPatched(mat, 'st');
  return mat;
}
/** 每帧更新：玩家位置 + 摄像机位置 */
export function updateSeeThrough(playerPos, camPos, radius) {
  if (playerPos) seeThrough.uPlayer.value.copy(playerPos);
  if (camPos) seeThrough.uCam.value.copy(camPos);
  if (radius != null) seeThrough.uRadius.value = radius;
}

export function disableSeeThrough() {
  seeThrough.uPlayer.value.set(0, -9999, 0);
}
