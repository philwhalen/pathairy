/** Map variants for the RL training corpus (tools/dump-maps.ts): symmetries and jitter. */
import type { MapData, Tile } from '../src/engine/types';
import type { Rng } from '../src/generator/rng';

/** The 8 symmetries of the rectangle: t = 0..7 (bit 0 flip columns, bit 1 flip rows, bit 2 transpose). */
export function transformMap(map: MapData, t: number): MapData {
  const transpose = (t & 4) !== 0;
  const W = transpose ? map.height : map.width;
  const H = transpose ? map.width : map.height;
  const tiles: Tile[][] = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => {
      let [sr, sc] = transpose ? [c, r] : [r, c];
      if (t & 1) sc = map.width - 1 - sc;
      if (t & 2) sr = map.height - 1 - sr;
      return { ...map.tiles[sr]![sc]! };
    }),
  );
  return { ...map, width: W, height: H, tiles };
}

const MOVABLE = (t: Tile) =>
  (t.type === 'r' && t.value !== 3) ||
  t.type === 'c' ||
  t.type === 't' ||
  t.type === 'u' ||
  t.type === 'z';

/** Moves each movable tile, with probability 1/2, to a random open cell within 2 steps. */
export function jitterMap(map: MapData, rng: Rng): MapData {
  const tiles = map.tiles.map((row) => row.map((t) => ({ ...t })));
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      if (!MOVABLE(tiles[r]![c]!) || rng.next() < 0.5) continue;
      const free: [number, number][] = [];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const t = tiles[r + dr]?.[c + dc];
          if (t?.type === 'o') free.push([r + dr, c + dc]);
        }
      }
      if (free.length === 0) continue;
      const [nr, nc] = rng.pick(free);
      tiles[nr]![nc] = tiles[r]![c]!;
      tiles[r]![c] = { type: 'o', value: 1 };
    }
  }
  return { ...map, tiles };
}
