/**
 * Dumps a differential test corpus for the Rust engine port (ml/engine-rs/tests/parity.rs):
 * random maps and wall sets with the TypeScript engine's full result for each.
 *
 *   npx tsx tools/dump-engine-cases.ts [N=3000] [out=ml/engine-rs/tests/data/diff-cases.jsonl]
 *
 * Cases (seeded, so the file is reproducible): generated maps of every type with random walls
 * on and off the path, and synthetic maps with every tile feature, including the rules that
 * analyst.js gets wrong (checkpoint gaps, `tN` without `uN`, z1-z4, width-1 boards).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeMapCode, serializeSolution } from '../src/engine/mapcode';
import { createEngine } from '../src/engine/pathing';
import type { Coord, MapData, Tile, TileType } from '../src/engine/types';
import { generateFromPreset, generateMap, MAP_TYPES } from '../src/generator/generate';
import { createRng, type Rng } from '../src/generator/rng';
import { TUNING_PRESETS } from './solver-bench/maps';

const N = Number(process.argv[2] ?? 3000);
const OUT = process.argv[3] ?? 'ml/engine-rs/tests/data/diff-cases.jsonl';

function openCells(map: MapData): Coord[] {
  const out: Coord[] = [];
  map.tiles.forEach((row, r) =>
    row.forEach((t, c) => t.type === 'o' && out.push({ row: r, col: c })),
  );
  return out;
}

function syntheticMap(rng: Rng): MapData {
  const width = rng.next() < 0.05 ? 1 : rng.int(2, 19);
  const height = rng.int(1, 12);
  const tiles: Tile[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): Tile => ({ type: 'o', value: 1 })),
  );
  const free = rng.shuffle(Array.from({ length: width * height }, (_, i) => i));
  const place = (type: TileType, value: number, n: number) => {
    for (let k = 0; k < n && free.length; k++) {
      const i = free.pop()!;
      tiles[Math.floor(i / width)]![i % width] = { type, value };
    }
  };
  const size = width * height;
  place('s', 1, rng.next() < 0.3 ? rng.int(2, 3) : 1);
  if (rng.next() < 0.35) place('s', 2, rng.int(1, 2));
  place('f', 1, rng.int(1, 3));
  const cps = rng.next() < 0.6 ? rng.int(1, Math.max(1, Math.min(6, Math.floor(size / 8)))) : 0;
  for (let n = 1; n <= cps; n++) {
    if (rng.next() < 0.08) continue; // checkpoint gap
    place('c', n, rng.next() < 0.2 ? 2 : 1);
  }
  if (rng.next() < 0.5) {
    const numbers = rng.int(1, 3);
    for (let n = 1; n <= numbers; n++) {
      place('t', n, rng.next() < 0.25 ? 2 : 1);
      if (rng.next() < 0.9) place('u', n, rng.next() < 0.3 ? rng.int(2, 3) : 1);
    }
  }
  if (rng.next() < 0.4) place('z', 5, rng.int(1, Math.max(1, Math.floor(size / 10))));
  if (rng.next() < 0.15) place('z', rng.int(1, 4), rng.int(1, 3));
  if (rng.next() < 0.3) {
    place('x', 1, rng.int(1, Math.max(1, Math.floor(size / 12))));
    place('x', 2, rng.int(1, Math.max(1, Math.floor(size / 12))));
  }
  if (rng.next() < 0.3) place('p', 1, rng.int(1, 4));
  place('r', rng.int(1, 3), Math.floor(size * rng.next() * 0.25));
  return { width, height, walls: 999, name: 'Synthetic', headerExtra: ['', '', ''], tiles };
}

/** Walls: a random share of open cells, or walls on the no-walls path (more likely to matter). */
function randomWalls(rng: Rng, map: MapData): Coord[] {
  const open = openCells(map);
  if (rng.next() < 0.5) return open.filter(() => rng.next() < rng.next() * 0.3);
  const res = createEngine(map).compute([]);
  const onPath = new Set<number>();
  for (const p of res.paths) {
    let [x, y] = p.start.split(',').map(Number) as [number, number];
    const dx = [0, 0, 1, 0, -1];
    const dy = [0, -1, 0, 1, 0];
    for (const t of p.tokens) {
      if (typeof t !== 'number') continue;
      x += dx[t]!;
      y += dy[t]!;
      if (map.tiles[y]?.[x]?.type === 'o') onPath.add(y * map.width + x);
    }
  }
  const cells = rng.shuffle([...onPath]).slice(0, rng.int(0, Math.min(25, onPath.size)));
  return cells.map((c) => ({ row: Math.floor(c / map.width), col: c % map.width }));
}

const rng = createRng(20261003);
const lines: string[] = [];
let blocked = 0;
for (let i = 0; i < N; i++) {
  let map: MapData;
  const kind = i % 4;
  if (kind === 0) map = syntheticMap(rng);
  else if (kind === 3 && i % 8 === 3) {
    const presets = Object.values(TUNING_PRESETS);
    map = generateFromPreset(presets[i % presets.length]!, 500000 + i).map;
  } else map = generateMap(MAP_TYPES[i % MAP_TYPES.length]!, 500000 + i).map;
  const walls = randomWalls(rng, map);
  const r = createEngine(map).compute(walls);
  if (r.blocked) blocked++;
  lines.push(
    JSON.stringify({
      code: serializeMapCode(map),
      solution: serializeSolution(walls),
      totalMoves: r.totalMoves,
      paths: r.paths.map((p) => ({
        tokens: p.tokens,
        moves: p.moves,
        blocked: p.blocked,
        start: p.start,
        end: p.blocked ? null : p.end,
      })),
    }),
  );
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${N} cases (${blocked} blocked) -> ${OUT}`);
