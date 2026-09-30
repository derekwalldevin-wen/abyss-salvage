// 构建期地图校验。`npm run build` 的第一步，失败就让构建失败。
// 用法：node tools/validate-map.mjs [--seed 20260928] [--seeds 8]
import { buildWorld } from '../src/world/build.js';
import { validateMap, MapValidationError } from '../src/world/validate.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const baseSeed = Number(arg('--seed', 20260928));
const seedCount = Number(arg('--seeds', 8));

let failed = 0, passed = 0;
const allWarn = [];

for (let i = 0; i < seedCount; i++) {
  const seed = baseSeed + i;
  let world;
  try {
    world = buildWorld({ seed });
  } catch (e) {
    console.error(`✗ seed ${seed} 构建失败: ${e.message}`);
    failed++;
    continue;
  }
  try {
    const { stats, warnings } = validateMap(world);
    passed++;
    allWarn.push(...warnings);
    if (i === 0) {
      console.log('地图统计');
      console.log(`  碰撞体        ${stats.colliders}（其中 tall ${stats.tall}）`);
      console.log(`  导航格        ${stats.navCells}，阻塞 ${stats.navBlocked}（${(stats.navBlocked / stats.navCells * 100).toFixed(1)}%）`);
      console.log(`  绘制指令      ${stats.draws}`);
      console.log(`  减压舱 ${stats.extracts} · 坡道 ${stats.ramps} · 出生点 ${stats.spawns}`);
      console.log(`  敌人刷新点    ${stats.enemies}`);
      console.log(`  容器点        ${stats.containers} · 散落点 ${stats.loot}`);
      console.log(`  条带深度      ${stats.bandDepths.join(' / ')} m`);
      console.log(`  出生点 20m 内可站格 ${stats.spawnFreeCells}`);
      console.log('');
    }
    if (i > 0) process.stdout.write(`  ✓ seed ${seed}\n`);
  } catch (e) {
    if (e instanceof MapValidationError) {
      failed++;
      console.error(`✗ seed ${seed}:`);
      for (const p of e.problems.slice(0, 12)) console.error(`    [${p.id}] ${p.msg}`);
      if (e.problems.length > 12) console.error(`    … 另有 ${e.problems.length - 12} 条`);
    } else {
      failed++;
      console.error(`✗ seed ${seed} 校验异常: ${e.message}\n${e.stack}`);
    }
  }
}

if (allWarn.length) {
  console.log('\n警告（不阻断构建）:');
  for (const w of [...new Set(allWarn)]) console.log(`  ! ${w}`);
}

console.log(`\n地图校验：${passed} 通过 / ${failed} 失败（共 ${seedCount} 个种子）`);
process.exit(failed ? 1 : 0);
