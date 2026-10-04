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
/**
 * 溶解判定。8×8 Bayer，不是原来的 4×4。
 *
 * 4×4 的一个周期只有 4 像素。在 1000×620 的画面上，一根横跨 400 像素的
 * 舱壁会出现 **100 个重复的棋盘格周期** —— 肉眼看到的是一片「网点贴图」，
 * 而不是「墙被看穿了」。check-art --ab 的调试图证实了这点：那根斜梁上的
 * 品红像素正是规则的 4 像素网格，看着像渲染坏了。
 *
 * 8×8 把周期拉长一倍，同时把上限从 0.62 降到 0.5：溶解得少一点没关系，
 * 墙的轮廓还在，观感上不那么像出错。代价是同周期内像素从 16 涨到 64，
 * 梯度上有轻微带状（Bayer 本身不是完美蓝噪声）；在固定斜角视角、
 * 溶解半径只有 2.7m 的前提下肉眼不可见。
 */
const ST_LIMIT = 0.5;

const FRAG_HOOK = /* glsl */`
  {
    float fade = stFade();
    if (fade > 0.02 && stN() < fade * ${ST_LIMIT}) discard;
  }
`;

// 调试用：?stsimple=1 保留全部注入但不做任何 discard，用来区分
// 「discard 逻辑把画面干掉了」和「注入本身把材质搞坏了」
const FRAG_NOOP = '  /* see-through disabled */\n';

/**
 * 调试图：把「本来会被溶解掉的像素」染成品红。
 *
 * **注入点必须在 opaque_fragment 之后**。
 * 之前我把它塞在 clipping_planes_fragment（也就是 FRAG_HOOK 那个位置），
 * 在那里写 gl_FragColor 会被 three 后续的 opaque_fragment整个覆盖掉 ——
 * 于是 ?stdebug=1 明明开着，量出来的溶解像素却是 0%。
 * 这是个「工具本身骗人」的 bug，比没有工具更糟。
 *
 * 判据和 FRAG_HOOK 保持一致，但这里必须重算一遍 —— 变量在另一个作用域里。
 * 为了避免两份逻辑漂移，把判定收成一个函数。
 */
const FRAG_DEBUG = /* glsl */`
  #include <opaque_fragment>
  {
    float fade = stFade();
    if (fade > 0.02 && stN() < fade * ${ST_LIMIT}) gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
  }
`;

/** 溶解判定的共用部分，两处注入都调它，避免逻辑漂移。 */
const GLSL_BAYER = /* glsl */`
  float stFade() {
    vec3 cp = uCam - uPlayer;
    float cpLen = length(cp);
    if (cpLen <= 0.001) return 0.0;
    vec3 dir = cp / cpLen;
    vec3 rel = vSTPos - uPlayer;
    float t = dot(rel, dir);
    if (t <= 0.35) return 0.0;
    float dist = length(rel - dir * t);
    float radial = 1.0 - smoothstep(uRadius * 0.5, uRadius, dist);
    float vert = smoothstep(-0.2, 1.6, rel.y);
    return radial * vert;
  }
  float stN() {
    const float bayer[64] = float[64](
       0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
      48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
      12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
      60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
       3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
      51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
      15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
      63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0);
    ivec2 bq = ivec2(mod(gl_FragCoord.xy, 8.0));
    return (bayer[bq.y * 8 + bq.x] + 0.5) / 64.0;
  }
`;

const patched = new WeakSet();

/** 调试开关：?stsimple=1 时保留注入但不做 discard */
const SIMPLE = typeof location !== 'undefined' && /(^|[?&])stsimple=1(&|$)/.test(location.search);

/** 调试开关：?stdebug=1 把溶解掉的像素染成品红，供 check-art 量化 */
const STDEBUG = typeof location !== 'undefined' && /(^|[?&])stdebug=1(&|$)/.test(location.search);

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
    // uniform 声明必须在共用函数**之前**，否则函数体里的 uCam/uPlayer 看不到声明 ——
    // 表现为 'uCam' : undeclared identifier，整个 fragment shader 编译失败。
    shader.fragmentShader = 'varying vec3 vSTPos;\nuniform vec3 uPlayer;\nuniform vec3 uCam;\nuniform float uRadius;\n'
      + GLSL_BAYER
      + shader.fragmentShader;
    // 调试图走**另一条注入路径**：把 opaque_fragment 换成
    // 「原样渲染 + 溶解处染品红」，这样量出来的就是真正会被 discard 的像素。
    // 之前那条路（在 clipping_planes_fragment 里写 gl_FragColor）会被
    // three 后续的 opaque_fragment 整个覆盖，工具自己骗人。
    if (STDEBUG) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <opaque_fragment>', FRAG_DEBUG);
    } else {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + (SIMPLE ? FRAG_NOOP : FRAG_HOOK));
    }
  };
  markPatched(mat, STDEBUG ? 'st+dbg' : 'st');
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
