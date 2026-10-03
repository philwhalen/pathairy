import { describe, expect, it } from 'vitest';
import { computePaths } from '../src/engine/pathing';
import { parseMapCode, serializeMapCode } from '../src/engine/mapcode';
import type { MapData } from '../src/engine/types';
import { generateMap, parseMapKey, randomSeed } from '../src/generator/generate';
import { MAP_TYPES, PRESETS } from '../src/generator/presets';
import type { Region, Weighted } from '../src/generator/presets';
import { createRng } from '../src/generator/rng';

const SEEDS = 1000;
const values = (w: Weighted[]) => w.map((x) => x.value);
const inRegion = (r: Region, row: number, col: number) =>
  row >= r.row0 && row <= r.row1 && col >= r.col0 && col <= r.col1;

function cells(map: MapData, type: string) {
  const out: { row: number; col: number; value: number }[] = [];
  map.tiles.forEach((tr, row) =>
    tr.forEach((t, col) => {
      if (t.type === type) out.push({ row, col, value: t.value });
    }),
  );
  return out;
}

describe('rng', () => {
  it('is deterministic and in range', () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 100; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const r = createRng(1);
    for (let i = 0; i < 200; i++) expect([3, 4, 5]).toContain(r.int(3, 5));
    expect(r.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(r.weighted([{ value: 'x', weight: 1 }])).toBe('x');
  });
});

describe('map keys', () => {
  it('parses and rejects', () => {
    expect(parseMapKey('complex-123')).toEqual({ type: 'complex', seed: 123 });
    expect(parseMapKey('bogus-1')).toBeNull();
    expect(parseMapKey('simple-')).toBeNull();
    expect(Number.isInteger(randomSeed())).toBe(true);
  });
});

describe.each(MAP_TYPES)('generator: %s', (type) => {
  const p = PRESETS[type];

  it('is deterministic for a seed', () => {
    for (const seed of [1, 2, 99999]) {
      const a = generateMap(type, seed);
      const b = generateMap(type, seed);
      expect(serializeMapCode(a.map)).toBe(serializeMapCode(b.map));
      expect(a.key).toBe(`${type}-${seed}`);
    }
    expect(serializeMapCode(generateMap(type, 1).map)).not.toBe(
      serializeMapCode(generateMap(type, 2).map),
    );
  });

  it(`keeps invariants over ${SEEDS} seeds`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generateMap(type, seed);
      const map = g.map;
      const ctx = g.key;
      expect([map.width, map.height, map.name], ctx).toEqual([p.width, p.height, p.name]);
      expect(values(p.walls), ctx).toContain(map.walls);
      expect(map.tiles.length).toBe(p.height);

      // Fixed layout.
      const starts = cells(map, 's');
      const finishes = cells(map, 'f');
      if (p.layout.kind === 'fixed') {
        expect(
          starts.map((c) => [c.row, c.col]),
          ctx,
        ).toEqual([[p.layout.start.row, p.layout.start.col]]);
        expect(
          finishes.map((c) => [c.row, c.col]),
          ctx,
        ).toEqual([[p.layout.finish.row, p.layout.finish.col]]);
      } else {
        expect(
          starts.every((c) => c.col === 0),
          ctx,
        ).toBe(true);
        expect(
          finishes.every((c) => c.col === p.width - 1),
          ctx,
        ).toBe(true);
        expect(starts.length, ctx).toBe(p.layout.left === 'all' ? p.height : 1);
        expect(finishes.length, ctx).toBe(p.layout.right === 'all' ? p.height : 1);
        for (let row = 0; row < p.height; row++) {
          if (p.layout.left === 'one-in-rock-border' && map.tiles[row]![0]!.type !== 's') {
            expect(map.tiles[row]![0], ctx).toEqual({ type: 'r', value: 3 });
          }
          if (
            p.layout.right === 'one-in-rock-border' &&
            map.tiles[row]![p.width - 1]!.type !== 'f'
          ) {
            expect(map.tiles[row]![p.width - 1], ctx).toEqual({ type: 'r', value: 3 });
          }
        }
      }

      // Counts and regions.
      const cps = cells(map, 'c');
      expect(values(p.checkpoints.count), ctx).toContain(cps.length);
      expect(
        cps.map((c) => c.value).sort((x, y) => x - y),
        ctx,
      ).toEqual(cps.map((_, i) => i + 1));
      expect(
        cps.every((c) => inRegion(p.checkpoints.region, c.row, c.col)),
        ctx,
      ).toBe(true);

      const ts = cells(map, 't');
      const us = cells(map, 'u');
      if (p.teleports) {
        expect(values(p.teleports.pairs), ctx).toContain(ts.length);
        const vals = (a: { value: number }[]) => a.map((c) => c.value).sort((x, y) => x - y);
        expect(vals(us), ctx).toEqual(vals(ts));
        expect(
          [...ts, ...us].every((c) => inRegion(p.teleports!.region, c.row, c.col)),
          ctx,
        ).toBe(true);
      } else {
        expect(ts.length + us.length, ctx).toBe(0);
      }

      const ice = cells(map, 'z');
      if (p.ice) {
        expect(values(p.ice.count), ctx).toContain(ice.length);
        expect(
          ice.every((c) => c.value === 5 && inRegion(p.ice!.region, c.row, c.col)),
          ctx,
        ).toBe(true);
      } else {
        expect(ice.length, ctx).toBe(0);
      }

      const rocks = cells(map, 'r').filter((c) => c.value === 1);
      expect(values(p.rocks.count), ctx).toContain(rocks.length);
      expect(
        rocks.every((c) => inRegion(p.rocks.region, c.row, c.col)),
        ctx,
      ).toBe(true);
      const known = new Set(['o', 'r', 's', 'f', 'c', 't', 'u', 'z']);
      expect(
        map.tiles.flat().every((t) => known.has(t.type)),
        ctx,
      ).toBe(true);

      // Validated, and the code round-trips.
      expect(computePaths(map, []).blocked, ctx).toBe(false);
      const code = serializeMapCode(map);
      expect(code.startsWith(`${p.width}.${p.height}.${map.walls}.${p.name}...:`), ctx).toBe(true);
      expect(parseMapCode(code), ctx).toEqual(map);
    }
  });
});
