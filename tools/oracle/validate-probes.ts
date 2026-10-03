// Sanity-checks tools/oracle/probes.json offline: parses codes/solutions, renders the grid from the
// code and compares it with the probe's `grid` sketch, checks walls sit on open tiles, and compares
// the stored analystPrediction with a fresh analyst.js run. Usage: tsx tools/oracle/validate-probes.ts
import fs from 'node:fs';
import { parseMapCode, parseSolution } from '../../src/engine/mapcode';
import { runAnalyst } from './run-analyst.mjs';

const probes = JSON.parse(fs.readFileSync(new URL('./probes.json', import.meta.url), 'utf8'));
const sym = (t: { type: string; value: number }) => {
  switch (t.type) {
    case 'o':
      return '.';
    case 'r':
      return '#';
    case 's':
      return t.value === 1 ? 'S' : 'R';
    case 'f':
      return 'F';
    case 'c':
      return String(t.value);
    case 't':
      return 'abcdefg'[t.value - 1]!;
    case 'u':
      return 'ABCDEFG'[t.value - 1]!;
    case 'z':
      return t.value === 5 ? 'Z' : 'klmn'[t.value - 1]!;
    default:
      return t.type;
  }
};
let bad = 0;
const names = new Set<string>();
for (const p of probes) {
  const issues: string[] = [];
  if (names.has(p.name)) issues.push('duplicate name');
  names.add(p.name);
  try {
    const m = parseMapCode(p.code);
    const sol = parseSolution(p.solution);
    const grid = m.tiles.map((r) => r.map(sym).join(''));
    if (p.grid && JSON.stringify(grid) !== JSON.stringify(p.grid))
      issues.push(`grid mismatch: code renders ${JSON.stringify(grid)}`);
    if (sol.length > m.walls) issues.push('more walls than allowed');
    for (const w of sol) {
      const t = m.tiles[w.row]?.[w.col];
      if (!t) issues.push(`wall ${w.row},${w.col} off board`);
      else if (t.type !== 'o') issues.push(`wall ${w.row},${w.col} on ${t.type}${t.value}`);
    }
    const a = runAnalyst(p.code, p.solution);
    const pr = p.analystPrediction;
    if (
      pr &&
      JSON.stringify(a.paths.map((x: any) => x.tokens)) !==
        JSON.stringify(pr.paths.map((x: any) => x.tokens))
    )
      issues.push(
        `prediction stale: analyst now gives ${JSON.stringify(a.paths.map((x: any) => x.tokens))}`,
      );
  } catch (e) {
    issues.push('threw: ' + (e as Error).message);
  }
  if (issues.length) bad++;
  console.log(
    `${issues.length ? 'BAD' : 'ok '} ${p.name}${issues.length ? '\n    ' + issues.join('\n    ') : ''}`,
  );
}
console.log(`${probes.length} probes, ${bad} with issues`);
process.exit(bad ? 1 : 0);
