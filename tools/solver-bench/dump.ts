/**
 * Writes the solver tuning set with best-known scores as JSON, for the Rust SA benchmark
 * (ml/engine-rs/examples/sa_bench.rs): npx tsx tools/solver-bench/dump.ts > ml/engine-rs/tests/data/bench-maps.json
 */
import { readFileSync } from 'node:fs';
import { serializeMapCode } from '../../src/engine/mapcode';
import { benchMaps } from './maps';

const best: Record<string, { moves: number }> = JSON.parse(
  readFileSync(new URL('./best-known.json', import.meta.url), 'utf8'),
);
const rows = benchMaps().map((m) => ({
  id: m.id,
  group: m.group,
  code: serializeMapCode(m.map),
  best: best[m.id]?.moves ?? 0,
}));
console.log(JSON.stringify(rows, null, 1));
