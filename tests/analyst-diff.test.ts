/**
 * Differential test (plan Phase 2 step 3): our engine vs. the reference engine analyst.js
 * (tools/oracle/analyst.js, gitignored; `npm run oracle:fetch`). Compares tokens, moves,
 * start/end and the blocked flag on many seeded random cases.
 *
 * Excluded, because the server showed analyst.js is wrong there (report §9; those rules are
 * covered by server fixtures in engine.test.ts instead): checkpoint number gaps, `tN` without
 * `uN`, z1-z4 tiles, width-1 boards. On blocked results only the blocked flag and the failing
 * target are compared (the server reports a partial pathArray and only the first blocked path;
 * analyst.js reports just the target label and every path).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMapCode,
  parseSolution,
  serializeMapCode,
  serializeSolution,
} from '../src/engine/mapcode';
import { createEngine } from '../src/engine/pathing';
import type { Coord, MapData, PathsResult, Tile } from '../src/engine/types';
import { runAnalyst, type AnalystResult } from '../tools/oracle/run-analyst.mjs';

const HAS_ANALYST = existsSync(join(__dirname, '..', 'tools', 'oracle', 'analyst.js'));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns a description of the first difference, or null if the results agree. */
function diff(ours: PathsResult, a: AnalystResult): string | null {
  if (ours.blocked !== a.blocked) return `blocked ours=${ours.blocked} analyst=${a.blocked}`;
  if (ours.totalMoves !== a.totalMoves) return `totalMoves ${ours.totalMoves} vs ${a.totalMoves}`;
  if (!ours.blocked && ours.paths.length !== a.paths.length) return 'path count';
  for (let k = 0; k < ours.paths.length; k++) {
    const p = ours.paths[k]!;
    const q = a.paths[k];
    if (!q) return `path ${k} missing in analyst`;
    if (p.blocked !== q.blocked) return `path ${k} blocked ${p.blocked} vs ${q.blocked}`;
    if (p.start !== q.start) return `path ${k} start ${p.start} vs ${q.start}`;
    if (p.blocked) {
      // ours: partial pathArray ending in the failing target; analyst: just that target.
      // (A failed warp ends in "r"; analyst reports the target label, so skip that case.)
      const last = p.tokens[p.tokens.length - 1];
      if (last !== 'r' && last !== q.tokens[0])
        return `path ${k} blocked at ${last} vs ${q.tokens[0]}`;
      return null; // the server reports nothing after the first blocked path
    }
    if (p.moves !== q.moves) return `path ${k} moves ${p.moves} vs ${q.moves}`;
    if (p.end !== q.end) return `path ${k} end ${p.end} vs ${q.end}`;
    const x = JSON.stringify(p.tokens);
    const y = JSON.stringify(q.tokens);
    if (x !== y) return `path ${k} tokens\n  ours    ${x}\n  analyst ${y}`;
  }
  return null;
}

class Checker {
  cases = 0;
  blocked = 0;
  failures: string[] = [];
  check(map: MapData, code: string, walls: Coord[], label: string, engine = createEngine(map)) {
    const sol = serializeSolution(walls);
    const ours = engine.compute(walls);
    const d = diff(ours, runAnalyst(code, sol));
    this.cases++;
    if (ours.blocked) this.blocked++;
    if (d && this.failures.length < 10) this.failures.push(`${label}\n  ${code}\n  ${sol}\n  ${d}`);
  }
}

function openCells(map: MapData): Coord[] {
  const out: Coord[] = [];
  map.tiles.forEach((row, r) =>
    row.forEach((t, c) => {
      if (t.type === 'o') out.push({ row: r, col: c });
    }),
  );
  return out;
}

function sample<T>(rnd: () => number, items: T[], n: number): T[] {
  const a = items.slice();
  for (let i = 0; i < n && i < a.length; i++) {
    const j = i + Math.floor(rnd() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

interface ScoreRow {
  mapId: number;
  code: string;
  solution: string;
}
const rows: ScoreRow[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'scoreboard.json'), 'utf8'),
);

describe.skipIf(!HAS_ANALYST)('differential test vs analyst.js', () => {
  it('scoreboard maps with random wall sets', () => {
    const rnd = mulberry32(1);
    const codes = [...new Set(rows.map((r) => r.code))];
    const ck = new Checker();
    for (const code of codes) {
      const map = parseMapCode(code);
      const engine = createEngine(map);
      const open = openCells(map);
      const budget = Math.min(map.walls, Math.floor(open.length / 3));
      for (let i = 0; i < 40; i++) {
        const n = Math.floor(rnd() * (budget + 1));
        ck.check(map, code, sample(rnd, open, n), `scoreboard map random #${i}`, engine);
      }
    }
    expect(ck.failures).toEqual([]);
    expect(ck.cases).toBeGreaterThan(2000);
  });

  it('scoreboard solutions with a few walls moved', () => {
    const rnd = mulberry32(2);
    const ck = new Checker();
    for (const r of rows) {
      const map = parseMapCode(r.code);
      const engine = createEngine(map);
      const open = openCells(map);
      const base = parseSolution(r.solution);
      for (let i = 0; i < 3; i++) {
        const kept = sample(rnd, base, base.length - 1 - Math.floor(rnd() * 3));
        const taken = new Set(kept.map((w) => `${w.row},${w.col}`));
        const free = open.filter((w) => !taken.has(`${w.row},${w.col}`));
        const walls = [...kept, ...sample(rnd, free, base.length - kept.length)];
        ck.check(map, r.code, walls, `map ${r.mapId} mutated #${i}`, engine);
      }
    }
    expect(ck.failures).toEqual([]);
    expect(ck.cases).toBeGreaterThan(1500);
  });

  it('random synthetic maps covering every feature', () => {
    const rnd = mulberry32(3);
    const ck = new Checker();
    const features = { teleport: 0, ice: 0, dual: 0, x: 0, p: 0, multiStart: 0, multiExit: 0 };
    for (let i = 0; i < 6000; i++) {
      const map = randomMap(rnd);
      const tiles = map.tiles.flat();
      const count = (pred: (t: Tile) => boolean) => tiles.filter(pred).length;
      if (count((t) => t.type === 't')) features.teleport++;
      if (count((t) => t.type === 'z')) features.ice++;
      if (count((t) => t.type === 's' && t.value === 2)) features.dual++;
      if (count((t) => t.type === 'x')) features.x++;
      if (count((t) => t.type === 'p')) features.p++;
      if (count((t) => t.type === 's' && t.value === 1) > 1) features.multiStart++;
      if (count((t) => t.type === 'u') > count((t) => t.type === 't')) features.multiExit++;
      const open = openCells(map);
      const density = rnd() * 0.3;
      const walls = open.filter(() => rnd() < density);
      ck.check(map, serializeMapCode(map), walls, `synthetic #${i}`);
    }
    expect(ck.failures).toEqual([]);
    for (const n of Object.values(features)) expect(n).toBeGreaterThan(300);
    // Not everything should be blocked.
    expect(ck.blocked).toBeLessThan(ck.cases * 0.6);
  });
});

/**
 * A random map up to 19 x 12 with any mix of: several s1, s2 (dual), f1 copies, checkpoints
 * c1..cN without gaps (several copies each), teleport numbers with 1-2 entries and 1-3 exits,
 * z5 ice, x1/x2, p1 and rocks.
 */
function randomMap(rnd: () => number): MapData {
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const width = int(2, 19);
  const height = int(2, 12);
  const tiles: Tile[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): Tile => ({ type: 'o', value: 1 })),
  );
  const free = sample(
    rnd,
    Array.from({ length: width * height }, (_, i) => i),
    width * height,
  );
  const place = (type: Tile['type'], value: number, n: number) => {
    for (let k = 0; k < n && free.length; k++) {
      const i = free.pop()!;
      tiles[Math.floor(i / width)]![i % width] = { type, value };
    }
  };
  const size = width * height;
  place('s', 1, rnd() < 0.3 ? int(2, 3) : 1);
  if (rnd() < 0.35) place('s', 2, int(1, 2));
  place('f', 1, int(1, 3));
  const cps = rnd() < 0.6 ? int(1, Math.min(5, Math.floor(size / 8))) : 0;
  for (let n = 1; n <= cps; n++) place('c', n, rnd() < 0.2 ? 2 : 1);
  if (rnd() < 0.5) {
    const numbers = int(1, 3);
    for (let n = 1; n <= numbers; n++) {
      place('t', n, rnd() < 0.25 ? 2 : 1);
      place('u', n, rnd() < 0.3 ? int(2, 3) : 1);
    }
  }
  if (rnd() < 0.4) place('z', 5, int(1, Math.max(1, Math.floor(size / 10))));
  if (rnd() < 0.3) {
    place('x', 1, int(1, Math.max(1, Math.floor(size / 12))));
    place('x', 2, int(1, Math.max(1, Math.floor(size / 12))));
  }
  if (rnd() < 0.3) place('p', 1, int(1, 4));
  place('r', int(1, 3), Math.floor(size * rnd() * 0.25));
  // No `tN` without `uN` (the grid may have filled up before the exit was placed).
  const exits = new Set(tiles.flat().flatMap((t) => (t.type === 'u' ? [t.value] : [])));
  for (const row of tiles) {
    row.forEach((t, c) => {
      if (t.type === 't' && !exits.has(t.value)) row[c] = { type: 'o', value: 1 };
    });
  }
  // Re-roll if the grid filled up before a finish or every checkpoint number was placed.
  const all = tiles.flat();
  const cpPlaced = new Set(all.flatMap((t) => (t.type === 'c' ? [t.value] : [])));
  if (!all.some((t) => t.type === 'f') || cpPlaced.size !== cps) return randomMap(rnd);
  return { width, height, walls: 999, name: 'Diff', headerExtra: ['', '', ''], tiles };
}
