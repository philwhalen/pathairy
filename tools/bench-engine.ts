// Engine benchmark over the scoreboard corpus (real maps with real high-scoring wall sets).
// Usage: npx tsx tools/bench-engine.ts
import fs from 'node:fs';
import { parseMapCode, parseSolution } from '../src/engine/mapcode';
import { computePaths, createEngine } from '../src/engine/pathing';
import type { Coord, MapData } from '../src/engine/types';

interface Row {
  code: string;
  solution: string;
}
const rows: Row[] = JSON.parse(
  fs.readFileSync(new URL('../tests/fixtures/scoreboard.json', import.meta.url), 'utf8'),
);

function bench(label: string, cases: { map: MapData; walls: Coord[] }[]): void {
  if (cases.length === 0) return;
  const engines = cases.map((c) => createEngine(c.map));
  const time = (fn: (i: number) => unknown, minMs = 400): number => {
    let n = 0;
    const t0 = performance.now();
    let t = t0;
    while (t - t0 < minMs) {
      for (let i = 0; i < cases.length; i++) fn(i);
      n += cases.length;
      t = performance.now();
    }
    return ((t - t0) * 1000) / n; // microseconds per call
  };
  // Warm up the JIT.
  time((i) => engines[i]!.compute(cases[i]!.walls), 200);
  const fresh = time((i) => computePaths(cases[i]!.map, cases[i]!.walls));
  const reuse = time((i) => engines[i]!.compute(cases[i]!.walls));
  const score = time((i) => engines[i]!.score(cases[i]!.walls));
  console.log(
    `${label.padEnd(26)} ${String(cases.length).padStart(4)} cases  ` +
      `computePaths ${fresh.toFixed(1).padStart(6)} us  ` +
      `engine.compute ${reuse.toFixed(1).padStart(6)} us  engine.score ${score.toFixed(1).padStart(6)} us`,
  );
}

const groups = new Map<string, { map: MapData; walls: Coord[] }[]>();
for (const r of rows) {
  const map = parseMapCode(r.code);
  const key = `${map.width}x${map.height}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push({ map, walls: parseSolution(r.solution) });
}
for (const key of ['13x6', '17x9', '19x9', '27x19'])
  bench(`scoreboard ${key}`, groups.get(key) ?? []);
bench('scoreboard all sizes', [...groups.values()].flat());
