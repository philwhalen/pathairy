// Runs analyst.js (via run-analyst.mjs) over tests/fixtures: scoreboard rows (moves) and
// oracle responses (moves, blocked, start/end, exact tokens). Prints per-feature matched/total.
// Error fixtures (`error: true`) are skipped. -v prints one line per oracle fixture.
// Usage: node tools/oracle/check-corpus.mjs [-v]   (exit code 1 on any mismatch)
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
// Fixtures where the server is known to differ from analyst.js (see report §9). They still count as
// mismatches in the tallies, but do not fail the run; an entry that starts matching does fail it.
const KNOWN = {
  cp_gap_c1_c3: 'missing checkpoint number => server: blocked at the first gap',
  cp_gap_c2_only: 'missing checkpoint number => server: blocked at the first gap',
  cp_gap_c1_c2_c4: 'missing checkpoint number => server: blocked at the first gap',
  cp_gap_c1_c4: 'missing checkpoint number => server: blocked at the first gap',
  cp_gap_c2_c3_no_c1: 'missing checkpoint number => server: blocked at the first gap',
  cp_gap_dual: 'missing checkpoint number => server: blocked at the first gap',
  t_no_exit: 'tN without any uN => server: blocked',
  z1_center: 'z1 is impassable on the server',
  z1_down: 'z1 is impassable on the server',
  z2_down: 'analyst bug: direction tokens wrong on width-1 boards (moves agree)',
  z3_down: 'analyst bug: direction tokens wrong on width-1 boards (moves agree)',
  z4_down: 'analyst bug: direction tokens wrong on width-1 boards (moves agree)',
};
const knownSeen = [];
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

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
  if (o.error) {
    console.log(`skip ${o.name}: server error fixture`);
    continue;
  }
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
  if (verbose)
    console.log(
      `${diffs.length ? 'DIFF' : 'ok  '} ${o.name} server=${s.totalMoves}${s.blocked ? ' (blocked)' : ''} analyst=${a.totalMoves}`,
    );
  if (diffs.length && KNOWN[o.name]) knownSeen.push(`${o.name}: ${KNOWN[o.name]}`);
  else if (diffs.length) failures.push(`oracle ${o.name}: ${diffs.join('; ')}`);
  else if (KNOWN[o.name])
    failures.push(`oracle ${o.name}: listed as known divergence but now matches`);
}

for (const kind of Object.keys(tally)) {
  const unit = kind === 'scoreboard' ? 'moves' : 'moves+blocked+start/end+exact tokens';
  console.log(`${kind} (${unit}):`);
  for (const [f, t] of Object.entries(tally[kind]))
    console.log(`  ${f.padEnd(9)} ${t.ok}/${t.total}`);
}
if (knownSeen.length)
  console.log(['known divergences (' + knownSeen.length + '):', ...knownSeen].join('\n  '));
console.log(`distinct solutions: ${new Set(rows.map((r) => r.mapId + '|' + r.solution)).size}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES:\n` + failures.join('\n'));
  process.exit(1);
}
console.log('\nall match');
