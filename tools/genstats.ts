/**
 * Generates N local maps per type and prints histograms next to the 80 sampled maps (all files in reference/original/api/gen), plus the
 * no-walls path length (local engine on both). Usage: npm run genstats [-- N]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { computePaths } from '../src/engine/pathing';
import { mapJsonToMapData } from '../src/engine/mapcode';
import type { MapData } from '../src/engine/types';
import { generateMap } from '../src/generator/generate';
import { MAP_TYPES } from '../src/generator/presets';

const N = Number(process.argv[2] ?? 1000);
const GEN_DIR = new URL('../reference/original/api/gen/', import.meta.url);

interface Row {
  rocks: number;
  cp: number;
  ice: number;
  tp: number;
  walls: number;
  len: number;
  attempts: number;
}

function measure(map: MapData, attempts: number): Row {
  const c = { r: 0, c: 0, z: 0, t: 0 } as Record<string, number>;
  for (const row of map.tiles) for (const t of row) if (t.type === 'r' && t.value === 1) c.r!++;
  for (const row of map.tiles) for (const t of row) if (t.type in c && t.type !== 'r') c[t.type]!++;
  return {
    rocks: c.r!,
    cp: c.c!,
    ice: c.z!,
    tp: c.t!,
    walls: map.walls,
    len: computePaths(map, []).totalMoves,
    attempts,
  };
}

function hist(values: number[]): Map<number, number> {
  const h = new Map<number, number>();
  for (const v of values) h.set(v, (h.get(v) ?? 0) + 1);
  return h;
}

function printHist(label: string, local: number[], sample: number[]) {
  const hl = hist(local);
  const hs = hist(sample);
  const keys = [...new Set([...hl.keys(), ...hs.keys()])].sort((a, b) => a - b);
  const cells = keys.map((k) => {
    const l = ((100 * (hl.get(k) ?? 0)) / local.length).toFixed(0).padStart(3);
    const s = ((100 * (hs.get(k) ?? 0)) / sample.length).toFixed(0).padStart(3);
    return `${k}:${l}|${s}`;
  });
  console.log(`  ${label.padEnd(9)} value:local%|sample%  ${cells.join('  ')}`);
}

const q = (a: number[], p: number) =>
  a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]!;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

function lenSummary(a: number[]) {
  return `min ${Math.min(...a)} p25 ${q(a, 0.25)} median ${q(a, 0.5)} mean ${mean(a).toFixed(1)} p75 ${q(a, 0.75)} max ${Math.max(...a)}`;
}

function printLenHist(local: number[], sample: number[]) {
  const all = [...local, ...sample];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const bins = 8;
  const step = Math.max(1, Math.ceil((hi - lo + 1) / bins));
  const cells: string[] = [];
  for (let b = 0; b < bins; b++) {
    const from = lo + b * step;
    const to = from + step - 1;
    const inBin = (v: number) => v >= from && v <= to;
    const l = ((100 * local.filter(inBin).length) / local.length).toFixed(0).padStart(3);
    const s = ((100 * sample.filter(inBin).length) / sample.length).toFixed(0).padStart(3);
    cells.push(`${from}-${to}:${l}|${s}`);
  }
  console.log(`  len bins  range:local%|sample%  ${cells.join('  ')}`);
}

for (const type of MAP_TYPES) {
  const samples: Row[] = [];
  const names = readdirSync(GEN_DIR).filter((f) => f.startsWith(`${type}_`));
  for (const name of names) {
    const file = new URL(name, GEN_DIR);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    samples.push(measure(mapJsonToMapData(json), json.debug?.numberOfAttempts ?? 1));
  }
  const t0 = performance.now();
  const local: Row[] = [];
  for (let seed = 1; seed <= N; seed++) {
    const g = generateMap(type, seed);
    local.push(measure(g.map, g.attempts));
  }
  const ms = performance.now() - t0;
  console.log(
    `===== ${type}  local n=${N} (${(ms / N).toFixed(2)} ms/map) vs samples n=${samples.length}`,
  );
  for (const [label, key] of [
    ['rocks', 'rocks'],
    ['checkpts', 'cp'],
    ['ice', 'ice'],
    ['tele t', 'tp'],
    ['walls', 'walls'],
    ['attempts', 'attempts'],
  ] as const) {
    printHist(
      label,
      local.map((r) => r[key]),
      samples.map((r) => r[key]),
    );
  }
  const ll = local.map((r) => r.len);
  const sl = samples.map((r) => r.len);
  console.log(`  no-walls path length  local:  ${lenSummary(ll)}`);
  console.log(`                        sample: ${lenSummary(sl)}`);
  console.log(
    `  median ratio local/sample = ${(q(ll, 0.5) / q(sl, 0.5)).toFixed(2)}  (mean ratio ${(mean(ll) / mean(sl)).toFixed(2)})`,
  );
  printLenHist(ll, sl);
}
