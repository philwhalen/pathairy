import { describe, expect, it } from 'vitest';
import { computePaths } from '../src/engine/pathing';
import type { MapData } from '../src/engine/types';
import { generateMap } from '../src/generator/generate';
import { createRng } from '../src/generator/rng';
import { jitterMap, transformMap } from '../tools/map-variants';

const counts = (m: MapData) => {
  const c: Record<string, number> = {};
  for (const row of m.tiles)
    for (const t of row) c[`${t.type}${t.value}`] = (c[`${t.type}${t.value}`] ?? 0) + 1;
  return c;
};

describe('map variants', () => {
  const map = generateMap('complex', 4242).map;

  it('the 8 symmetries keep every tile and are distinct', () => {
    const codes = new Set<string>();
    for (let t = 0; t < 8; t++) {
      const m = transformMap(map, t);
      expect(counts(m)).toEqual(counts(map));
      expect([m.width, m.height]).toEqual(
        t & 4 ? [map.height, map.width] : [map.width, map.height],
      );
      codes.add(JSON.stringify(m.tiles));
    }
    expect(codes.size).toBe(8);
    expect(transformMap(map, 0).tiles).toEqual(map.tiles);
  });

  it('flips are their own inverse and transposing twice is the identity', () => {
    for (const t of [1, 2, 3])
      expect(transformMap(transformMap(map, t), t).tiles).toEqual(map.tiles);
    expect(transformMap(transformMap(map, 4), 4).tiles).toEqual(map.tiles);
  });

  it('a horizontal flip mirrors a path with no checkpoints', () => {
    // 1 x 5 corridor: S . . . F -> F . . . S, same length.
    const line: MapData = {
      width: 5,
      height: 1,
      walls: 0,
      name: 'T',
      headerExtra: ['', '', ''],
      tiles: [
        [
          { type: 's', value: 1 },
          ...Array.from({ length: 3 }, () => ({ type: 'o' as const, value: 1 })),
          { type: 'f', value: 1 },
        ],
      ],
    };
    expect(computePaths(transformMap(line, 1), []).totalMoves).toBe(4);
  });

  it('jitter keeps the tile counts and borders', () => {
    const rng = createRng(1);
    for (let k = 0; k < 20; k++) {
      const j = jitterMap(map, rng);
      expect(counts(j)).toEqual(counts(map));
      for (let r = 0; r < map.height; r++) {
        expect(j.tiles[r]![0]).toEqual(map.tiles[r]![0]);
        expect(j.tiles[r]![map.width - 1]).toEqual(map.tiles[r]![map.width - 1]);
      }
    }
  });
});
