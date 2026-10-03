// Runs analyst.js (via run-analyst.mjs) over tests/fixtures: scoreboard rows (moves) and
// oracle responses (moves, blocked, start/end, exact tokens). Prints per-feature matched/total.
// Usage: node tools/oracle/check-corpus.mjs   (exit code 1 on any mismatch)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalyst } from './run-analyst.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fx = path.join(root, 'tests/fixtures');
const feats = (f) => (f.length ? f : ['plain']);
const tally = {};
const bump = (kind, features, ok) => {
  for (const f of ['all', ...feats(features)]) {
    const t = ((tally[kind] ??= {})[f] ??= { ok: 0, total: 0 });
    t.total++;
    if (ok) t.ok++;
  }
};
const failures = [];

const rows = JSON.parse(fs.readFileSync(path.join(fx, 'scoreboard.json'), 'utf8'));
for (const r of rows) {
  const a = runAnalyst(r.code, r.solution);
  const ok = a.totalMoves === r.moves;
  bump('scoreboard', r.features, ok);
  if (!ok)
    failures.push(`scoreboard map ${r.mapId} ${r.name}: server=${r.moves} analyst=${a.totalMoves}`);
}

const oracleDir = path.join(fx, 'oracle');
for (const f of fs.readdirSync(oracleDir).sort()) {
  const o = JSON.parse(fs.readFileSync(path.join(oracleDir, f), 'utf8'));
  const a = runAnalyst(o.code, o.solution);
  const s = o.response;
  const diffs = [];
  if (a.totalMoves !== s.totalMoves) diffs.push(`totalMoves ${s.totalMoves} vs ${a.totalMoves}`);
  if (a.blocked !== !!s.blocked) diffs.push(`blocked ${s.blocked} vs ${a.blocked}`);
  s.path.forEach((sp, k) => {
    const ap = a.paths[k];
    if (!ap) return diffs.push(`path${k} missing`);
    if (ap.moves !== sp.moves) diffs.push(`path${k} moves ${sp.moves} vs ${ap.moves}`);
    if (ap.blocked !== !!sp.blocked) diffs.push(`path${k} blocked`);
    if (ap.start !== sp.start || (!sp.blocked && ap.end !== sp.end))
      diffs.push(`path${k} start/end ${sp.start}>${sp.end} vs ${ap.start}>${ap.end}`);
    const x = JSON.stringify(sp.pathArray),
      y = JSON.stringify(ap.tokens);
    if (x !== y) diffs.push(`path${k} tokens\n    server ${x}\n    analyst ${y}`);
  });
  if (a.paths.length !== s.path.length) diffs.push('path count');
  const featuresOf = (await import('./run-analyst.mjs')).mapFeatures(
    (await import('./run-analyst.mjs')).parseCode(o.code),
  );
  bump('oracle', featuresOf, !diffs.length);
  if (diffs.length) failures.push(`oracle ${o.name}: ${diffs.join('; ')}`);
}

for (const kind of Object.keys(tally)) {
  const unit = kind === 'scoreboard' ? 'moves' : 'moves+blocked+start/end+exact tokens';
  console.log(`${kind} (${unit}):`);
  for (const [f, t] of Object.entries(tally[kind]))
    console.log(`  ${f.padEnd(9)} ${t.ok}/${t.total}`);
}
console.log(`distinct solutions: ${new Set(rows.map((r) => r.mapId + '|' + r.solution)).size}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES:\n` + failures.join('\n'));
  process.exit(1);
}
console.log('\nall match');
