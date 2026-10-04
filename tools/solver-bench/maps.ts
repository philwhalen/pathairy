/**
 * The solver tuning set (tools/tune-solver.ts): generated maps, site generator samples and two
 * tuning-only presets for board sizes the game's generator doesn't make. None of these maps are in
 * the history/scoreboard corpus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { mapJsonToMapData } from '../../src/engine/mapcode';
import type { MapData } from '../../src/engine/types';
import { generateFromPreset, generateMap } from '../../src/generator/generate';
import type { Preset, Weighted } from '../../src/generator/presets';

const uniform = (min: number, max: number): Weighted[] =>
  Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, weight: 1 }));
const fixed = (v: number): Weighted[] => [{ value: v, weight: 1 }];

/** Tuning-only presets for board sizes the game's generator doesn't make. */
export const TUNING_PRESETS: Record<'large' | 'mid', Preset> = {
  // 27x19 with an effectively unlimited wall budget, like the site's Ultra Complex Unlimited.
  large: {
    name: 'Large Unlimited',
    width: 27,
    height: 19,
    layout: { kind: 'edges', left: 'all', right: 'all' },
    checkpoints: { count: uniform(4, 6), region: { col0: 1, col1: 25, row0: 0, row1: 18 } },
    teleports: { pairs: uniform(2, 4), region: { col0: 1, col1: 25, row0: 0, row1: 18 } },
    ice: { count: uniform(0, 12), region: { col0: 1, col1: 25, row0: 0, row1: 18 } },
    rocks: { count: uniform(30, 60), region: { col0: 1, col1: 25, row0: 0, row1: 18 } },
    walls: fixed(999),
  },
  // 21x15 with ~30 walls, like Thirty / Rocky Maze / Seeing Double.
  mid: {
    name: 'Mid',
    width: 21,
    height: 15,
    layout: { kind: 'edges', left: 'all', right: 'all' },
    checkpoints: { count: uniform(3, 6), region: { col0: 1, col1: 19, row0: 0, row1: 14 } },
    teleports: { pairs: uniform(0, 3), region: { col0: 1, col1: 19, row0: 0, row1: 14 } },
    ice: { count: uniform(0, 4), region: { col0: 1, col1: 19, row0: 0, row1: 14 } },
    rocks: { count: uniform(20, 40), region: { col0: 1, col1: 19, row0: 0, row1: 14 } },
    walls: uniform(28, 34),
  },
};

export interface BenchMap {
  id: string;
  group: string;
  map: MapData;
}

export function benchMaps(groupFilter?: readonly string[]): BenchMap[] {
  const out: BenchMap[] = [];
  const gen = (group: 'simple' | 'normal' | 'complex' | 'centralized', n: number) => {
    for (let i = 1; i <= n; i++) {
      const seed = 900000 + i;
      out.push({ id: `${group}-${seed}`, group, map: generateMap(group, seed).map });
    }
  };
  gen('simple', 8);
  gen('normal', 8);
  gen('complex', 24);
  gen('centralized', 12);
  const dir = new URL('../../reference/original/api/gen/', import.meta.url);
  const siteComplex = readdirSync(dir)
    .filter((f) => f.startsWith('complex_'))
    .sort()
    .slice(0, 16);
  for (const f of siteComplex) {
    const map = mapJsonToMapData(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
    out.push({ id: `site-${f.replace('.json', '')}`, group: 'site-complex', map });
  }
  for (const [group, preset] of Object.entries(TUNING_PRESETS)) {
    for (let i = 1; i <= 8; i++) {
      const seed = 900000 + i;
      out.push({ id: `${group}-${seed}`, group, map: generateFromPreset(preset, seed).map });
    }
  }
  return groupFilter ? out.filter((m) => groupFilter.includes(m.group)) : out;
}
