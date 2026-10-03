import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMapCode, parseSolution } from '../src/engine/mapcode';
import { computePaths, validateSolution } from '../src/engine/pathing';
import type { MapData } from '../src/engine/types';
import { generateMap } from '../src/generator/generate';
import { createSolver, solve } from '../src/solver/solve';

const maps: [string, MapData][] = [
  ['simple-7', generateMap('simple', 7).map],
  ['normal-42', generateMap('normal', 42).map],
  ['complex-12345', generateMap('complex', 12345).map],
  ['centralized-3', generateMap('centralized', 3).map],
];

function expectValid(map: MapData, walls: { row: number; col: number }[], moves: number) {
  expect(walls.length).toBeLessThanOrEqual(map.walls);
  expect(validateSolution(map, walls)).toBeNull();
  for (const w of walls) expect(map.tiles[w.row]![w.col]!.type).toBe('o');
  const res = computePaths(map, walls);
  expect(res.blocked).toBe(false);
  expect(res.totalMoves).toBe(moves);
}

describe('solver', () => {
  for (const [name, map] of maps) {
    it(`${name}: valid walls, moves match the engine, beats no walls`, () => {
      const res = solve(map, { seed: 1, iterations: 1500 });
      expectValid(map, res.walls, res.moves);
      expect(res.iterations).toBe(1500);
      expect(res.moves).toBeGreaterThan(computePaths(map, []).totalMoves);
    });
  }

  it('is deterministic for a seed, however the work is sliced', () => {
    const map = maps[2]![1];
    const a = solve(map, { seed: 5, iterations: 800 });
    const b = solve(map, { seed: 5, iterations: 800 });
    expect(b.walls).toEqual(a.walls);
    expect(b.moves).toBe(a.moves);

    const s = createSolver(map, { seed: 5, iterations: 800 });
    let p = s.stepIterations(1);
    while (!p.done) p = s.stepIterations(137);
    expect(p.iterations).toBe(800);
    expect(p.walls).toEqual(a.walls);
    expect(p.moves).toBe(a.moves);
  });

  it('step(ms) reports progress and stops at the iteration limit', () => {
    const s = createSolver(maps[1]![1], { seed: 2, iterations: 1500 });
    let p = s.step(5);
    let prev = p.moves;
    while (!p.done) {
      p = s.step(5);
      expect(p.moves).toBeGreaterThanOrEqual(prev);
      prev = p.moves;
    }
    expect(p.iterations).toBe(1500);
    expectValid(maps[1]![1], p.walls, p.moves);
  });

  it('never returns worse than initialWalls (a top human solution)', () => {
    const rows: { code: string; solution: string; moves: number }[] = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'scoreboard.json'), 'utf8'),
    );
    const row = rows.find((r) => r.code.includes('.Complex...'))!;
    const map = parseMapCode(row.code);
    const initialWalls = parseSolution(row.solution);
    const res = solve(map, { seed: 1, iterations: 300, initialWalls });
    expect(res.moves).toBeGreaterThanOrEqual(row.moves);
    expectValid(map, res.walls, res.moves);
  });

  it('ignores invalid initialWalls and still solves', () => {
    const map = maps[0]![1];
    const res = solve(map, {
      seed: 1,
      iterations: 500,
      initialWalls: [{ row: -1, col: 0 }],
    });
    expectValid(map, res.walls, res.moves);
  });
});
