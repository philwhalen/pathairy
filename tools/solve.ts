/**
 * Runs the wall-placement solver.
 *
 *   npx tsx tools/solve.ts complex 12345 [--time 5000] [--seed 1] [--iterations N]
 *   npx tsx tools/solve.ts --scoreboard [--time 3000] [--limit N] [--filter regex] [--map id] [--jobs N]
 *                                       [--shard i/n] [--json] [--param key=value,...]
 *
 * The scoreboard mode solves every map in tests/fixtures/scoreboard.json and compares the
 * solver's score with the best human score for that map.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseMapCode, serializeSolution } from '../src/engine/mapcode';
import { computePaths } from '../src/engine/pathing';
import type { Coord, MapData } from '../src/engine/types';
import { generateMap, type MapType } from '../src/generator/generate';
import { MAP_TYPES } from '../src/generator/presets';
import { solve, type SolverParams } from '../src/solver/solve';
import { renderMap } from './show-map';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const timeMs = Number(flag('time') ?? 3000);
const solverSeed = Number(flag('seed') ?? 1);
const iterations = flag('iterations') !== undefined ? Number(flag('iterations')) : undefined;
/** --param key=value,key=value: solver constant overrides (see SolverParams). */
const params: Partial<SolverParams> = Object.fromEntries(
  (flag('param') ?? '')
    .split(',')
    .filter(Boolean)
    .map((kv) => kv.split('='))
    .map(([k, v]) => [k, Number(v)]),
);

function renderWithWalls(map: MapData, walls: readonly Coord[]): string {
  const rows = renderMap(map)
    .split('\n')
    .map((r) => r.split(''));
  for (const w of walls) rows[w.row]![w.col] = '@';
  return rows.map((r) => r.join('')).join('\n');
}

const median = (a: number[]) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : NaN;
};

if (args.includes('--scoreboard')) {
  interface Row {
    mapId: number;
    code: string;
    moves: number;
  }
  const rows: Row[] = JSON.parse(
    readFileSync(new URL('../tests/fixtures/scoreboard.json', import.meta.url), 'utf8'),
  );
  const best = new Map<number, Row>();
  for (const r of rows) if ((best.get(r.mapId)?.moves ?? -1) < r.moves) best.set(r.mapId, r);
  let list = [...best.values()].sort((a, b) => a.mapId - b.mapId);
  const shard = flag('shard');
  if (shard) {
    const [i, n] = shard.split('/').map(Number) as [number, number];
    list = list.filter((_, k) => k % n === i);
  }
  if (flag('map')) list = list.filter((r) => r.mapId === Number(flag('map')));
  const filter = flag('filter');
  if (filter) list = list.filter((r) => new RegExp(filter, 'i').test(parseMapCode(r.code).name));
  if (flag('limit')) list = list.slice(0, Number(flag('limit')));
  type Result = { mapId: number; type: string; human: number; ai: number; ratio: number };
  const results: Result[] = [];
  const jobs = Number(flag('jobs') ?? 1);
  if (jobs > 1 && !shard) {
    // Run shards in parallel child processes (same tsx loader), each printing JSON.
    const outs = await Promise.all(
      Array.from(
        { length: jobs },
        (_, i) =>
          new Promise<Result[]>((resolve, reject) => {
            const childArgs = args.filter((a, k) => a !== '--jobs' && args[k - 1] !== '--jobs');
            const child = spawn(
              process.execPath,
              [
                ...process.execArgv,
                process.argv[1]!,
                ...childArgs,
                '--shard',
                `${i}/${jobs}`,
                '--json',
              ],
              { stdio: ['ignore', 'pipe', 'inherit'] },
            );
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('error', reject);
            child.on('close', () => resolve(JSON.parse(out) as Result[]));
          }),
      ),
    );
    results.push(...outs.flat().sort((a, b) => a.mapId - b.mapId));
    for (const r of results) {
      console.log(
        `${String(r.mapId).padStart(6)} ${r.type.padEnd(26)} human ${String(r.human).padStart(5)}  ai ${String(r.ai).padStart(5)}  ratio ${r.ratio.toFixed(3)}`,
      );
    }
  } else {
    for (const r of list) {
      const map = parseMapCode(r.code);
      const res = solve(map, { seed: solverSeed, timeLimitMs: timeMs, iterations, params });
      const ratio = res.moves / r.moves;
      const type = map.name.replace(/\.+$/, '');
      results.push({ mapId: r.mapId, type, human: r.moves, ai: res.moves, ratio });
      if (!args.includes('--json')) {
        console.log(
          `${String(r.mapId).padStart(6)} ${type.padEnd(26)} ${map.width}x${map.height} w${String(map.walls).padStart(3)}` +
            `  human ${String(r.moves).padStart(5)}  ai ${String(res.moves).padStart(5)}` +
            `  ratio ${ratio.toFixed(3)}  (${res.iterations} evals, ${(res.elapsedMs / 1000).toFixed(1)} s)`,
        );
      }
    }
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(results));
  } else {
    const byType = new Map<string, number[]>();
    for (const r of results) byType.set(r.type, [...(byType.get(r.type) ?? []), r.ratio]);
    console.log(`\nper type (n, median ratio, min ratio):`);
    for (const [t, rs] of [...byType].sort()) {
      console.log(
        `  ${t.padEnd(26)} n=${String(rs.length).padStart(2)}  median ${median(rs).toFixed(3)}  min ${Math.min(...rs).toFixed(3)}`,
      );
    }
    const all = results.map((r) => r.ratio);
    console.log(
      `overall n=${all.length}  median ratio ${median(all).toFixed(3)}  mean ${(all.reduce((s, v) => s + v, 0) / all.length).toFixed(3)}  ` +
        `matched-or-beat ${all.filter((x) => x >= 1).length}`,
    );
  }
} else {
  const type = (positional[0] ?? 'simple') as MapType;
  if (!MAP_TYPES.includes(type)) {
    console.error(`usage: solve.ts <${MAP_TYPES.join('|')}> <seed> [--time ms] | --scoreboard`);
    process.exit(1);
  }
  const g = generateMap(type, Number(positional[1] ?? 1));
  const t0 = performance.now();
  const res = solve(g.map, {
    seed: solverSeed,
    timeLimitMs: timeMs,
    iterations,
    params,
    onProgress: (p) =>
      args.includes('--verbose') &&
      console.log(`  ${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${p.moves}`),
  });
  const check = computePaths(g.map, res.walls);
  console.log(
    `${g.key}  ${g.map.width}x${g.map.height}  walls ${res.walls.length}/${g.map.walls}  ` +
      `no-walls ${computePaths(g.map, []).totalMoves}  best ${res.moves} (engine ${check.totalMoves})  ` +
      `${res.iterations} evals in ${res.elapsedMs.toFixed(0)} ms`,
  );
  console.log(renderWithWalls(g.map, res.walls));
  console.log(`solution: ${serializeSolution(res.walls)}`);
}
