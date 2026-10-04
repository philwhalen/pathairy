/**
 * Solver tuning benchmark. Uses only maps outside the history/scoreboard corpus (generated maps,
 * site generator samples and two tuning-only large presets), so the scoreboard stays a held-out
 * test set (docs/rl-agent-plan.md §1 ground rules).
 *
 *   npx tsx tools/tune-solver.ts [--time 2000] [--jobs 16] [--seed 1] [--groups a,b]
 *                                [--param key=value,...] [--label name] [--no-update]
 *
 * Every map's best score ever found is kept in tools/solver-bench/best-known.json (with its
 * walls), and a run is summarized as the mean ratio to those scores, per group and overall.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSolution, serializeSolution } from '../src/engine/mapcode';
import { computePaths } from '../src/engine/pathing';
import { solve, type SolverParams } from '../src/solver/solve';
import { benchMaps, type BenchMap } from './solver-bench/maps';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const timeMs = Number(flag('time') ?? 2000);
const solverSeed = Number(flag('seed') ?? 1);
const jobs = Number(flag('jobs') ?? 16);
const params: Partial<SolverParams> = Object.fromEntries(
  (flag('param') ?? '')
    .split(',')
    .filter(Boolean)
    .map((kv) => kv.split('='))
    .map(([k, v]) => [k, Number(v)]),
);
const groupFilter = flag('groups')?.split(',');

interface Result {
  id: string;
  group: string;
  moves: number;
  solution: string;
  evals: number;
}

function runShard(maps: BenchMap[]): Result[] {
  return maps.map(({ id, group, map }) => {
    const res = solve(map, { seed: solverSeed, timeLimitMs: timeMs, params });
    return {
      id,
      group,
      moves: res.moves,
      solution: serializeSolution(res.walls),
      evals: res.iterations,
    };
  });
}

const shard = flag('shard');
const all = benchMaps(groupFilter);
if (shard) {
  const [i, n] = shard.split('/').map(Number) as [number, number];
  console.log(JSON.stringify(runShard(all.filter((_, k) => k % n === i))));
} else {
  const t0 = performance.now();
  const outs = await Promise.all(
    Array.from(
      { length: jobs },
      (_, i) =>
        new Promise<Result[]>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [...process.execArgv, process.argv[1]!, ...args, '--shard', `${i}/${jobs}`],
            { stdio: ['ignore', 'pipe', 'inherit'] },
          );
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('error', reject);
          child.on('close', () => resolve(JSON.parse(out) as Result[]));
        }),
    ),
  );
  const results = outs.flat();
  const benchDir = new URL('./solver-bench/', import.meta.url);
  const bestFile = new URL('best-known.json', benchDir);
  if (!existsSync(benchDir)) mkdirSync(benchDir);
  const best: Record<string, { moves: number; solution: string }> = existsSync(bestFile)
    ? JSON.parse(readFileSync(bestFile, 'utf8'))
    : {};
  const byId = new Map(all.map((m) => [m.id, m]));
  let improved = 0;
  for (const r of results) {
    // Re-check every result with a fresh engine before it can become a reference score.
    const check = computePaths(byId.get(r.id)!.map, parseSolution(r.solution));
    if (check.blocked || check.totalMoves !== r.moves) {
      throw new Error(`${r.id}: solver reported ${r.moves}, engine says ${check.totalMoves}`);
    }
    if ((best[r.id]?.moves ?? -1) < r.moves) {
      best[r.id] = { moves: r.moves, solution: r.solution };
      improved++;
    }
  }
  if (!args.includes('--no-update')) {
    const sorted = Object.fromEntries(Object.entries(best).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(bestFile, JSON.stringify(sorted, null, 2) + '\n');
  }
  const groups = new Map<string, number[]>();
  for (const r of results) {
    groups.set(r.group, [...(groups.get(r.group) ?? []), r.moves / best[r.id]!.moves]);
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const label = flag('label') ?? JSON.stringify(params);
  const parts = [...groups].map(([g, rs]) => `${g} ${mean(rs).toFixed(4)}`);
  const ratios = results.map((r) => r.moves / best[r.id]!.moves);
  console.log(
    `${label}  time ${timeMs} seed ${solverSeed}  overall ${mean(ratios).toFixed(4)}  ` +
      `(at best ${ratios.filter((x) => x >= 1).length}/${ratios.length}, new best ${improved})  ` +
      `${parts.join('  ')}  [${((performance.now() - t0) / 1000).toFixed(0)} s]`,
  );
}
