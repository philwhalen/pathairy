/**
 * Training map corpus for the RL agent (docs/rl-agent-plan.md §4.2, Phase 1 step 3): writes
 * JSONL rows `{id, type, source, code}`.
 *
 *   npx tsx tools/dump-maps.ts [--per-type 1000] [--seed0 1000000] [--transforms] [--jitter 2]
 *                              [--site] [--max-w 27] [--max-h 19] [--out ml/data/train-maps.jsonl]
 *
 * Sources:
 *  - generated maps of the four types (seeds seed0, seed0+1, ...; never the seeds the game or
 *    the solver tuning set use by default);
 *  - with --site, the site generator samples in reference/original/api/gen;
 *  - with --transforms, each map's 7 other flips/rotations (kept if they fit max-w x max-h);
 *  - with --jitter K, K variants per map with movable tiles (rocks, checkpoints, teleports, ice)
 *    nudged to random free cells nearby.
 * Every map written is unblocked with no walls (blocked variants are dropped, not repaired).
 * No history maps are ever included: they are the validation and test splits.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mapJsonToMapData, serializeMapCode } from '../src/engine/mapcode';
import { computePaths } from '../src/engine/pathing';
import type { MapData } from '../src/engine/types';
import { generateMap, MAP_TYPES } from '../src/generator/generate';
import { createRng, type Rng } from '../src/generator/rng';
import { jitterMap, transformMap } from './map-variants';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PER_TYPE = Number(flag('per-type') ?? 1000);
const SEED0 = Number(flag('seed0') ?? 1_000_000);
const TRANSFORMS = args.includes('--transforms');
const JITTER = Number(flag('jitter') ?? 0);
const SITE = args.includes('--site');
const MAX_W = Number(flag('max-w') ?? 27);
const MAX_H = Number(flag('max-h') ?? 19);
const OUT = flag('out') ?? 'ml/data/train-maps.jsonl';

const rows: string[] = [];
const seen = new Set<string>();
let dropped = 0;
function emit(id: string, type: string, source: string, map: MapData): void {
  if (map.width > MAX_W || map.height > MAX_H) return;
  const code = serializeMapCode(map);
  if (seen.has(code)) return;
  if (computePaths(map, []).blocked) {
    dropped++;
    return;
  }
  seen.add(code);
  rows.push(JSON.stringify({ id, type, source, code }));
}

function withVariants(id: string, type: string, source: string, map: MapData, rng: Rng): void {
  emit(id, type, source, map);
  const bases: [string, MapData][] = [[id, map]];
  if (TRANSFORMS) {
    for (let t = 1; t < 8; t++) {
      const m = transformMap(map, t);
      emit(`${id}~t${t}`, type, `${source}+transform`, m);
      bases.push([`${id}~t${t}`, m]);
    }
  }
  for (const [bid, base] of bases) {
    for (let k = 1; k <= JITTER; k++)
      emit(`${bid}~j${k}`, type, `${source}+jitter`, jitterMap(base, rng));
  }
}

const rng = createRng(SEED0);
for (const type of MAP_TYPES) {
  for (let i = 0; i < PER_TYPE; i++) {
    const seed = SEED0 + i;
    withVariants(`${type}-${seed}`, type, 'generator', generateMap(type, seed).map, rng);
  }
}
if (SITE) {
  const dir = new URL('../reference/original/api/gen/', import.meta.url);
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const map = mapJsonToMapData(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
    const type = f.replace(/_\d+\.json$/, '');
    withVariants(`site-${f.replace('.json', '')}`, type, 'site-sample', map, rng);
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`${rows.length} maps -> ${OUT} (${dropped} blocked variants dropped)`);
