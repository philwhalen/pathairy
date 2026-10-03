// Builds tests/fixtures/scoreboard.json and tests/fixtures/oracle/*.json from reference/original/api.
// Deterministic and idempotent. Usage: node tools/build-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCode, mapFeatures } from './oracle/run-analyst.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'reference/original/api');
const hist = path.join(api, 'history');
const outDir = path.join(root, 'tests/fixtures');
const oracleDir = path.join(outDir, 'oracle');
fs.mkdirSync(oracleDir, { recursive: true });

const readJson = (f) => {
  const txt = fs.readFileSync(f, 'utf8');
  return JSON.parse(txt.slice(Math.max(0, txt.search(/[[{]/))));
};
const sorted = (dir) => fs.readdirSync(dir).sort();

// ---- scoreboard ----
const dateOf = new Map();
for (const f of sorted(path.join(hist, 'mapsbydate'))) {
  const date = f.replace(/\.json$/, '');
  for (const id of readJson(path.join(hist, 'mapsbydate', f))) dateOf.set(Number(id), date);
}
const maps = new Map();
for (const f of sorted(path.join(hist, 'maps')))
  maps.set(parseInt(f, 10), readJson(path.join(hist, 'maps', f)));

const rows = [];
const seen = new Set();
const stats = { mapsTotal: maps.size, mapsWithScores: 0, mapsSkipped: [], rawRows: 0, dupes: 0 };
const scoreFiles = sorted(path.join(hist, 'scores')).sort(
  (a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b, 'en', { numeric: true }),
);
const withScores = new Set();
for (const f of scoreFiles) {
  const mapId = parseInt(f, 10);
  const map = maps.get(mapId);
  if (!map) continue;
  const sc = readJson(path.join(hist, 'scores', f));
  const users = Object.keys(sc.users || {})
    .sort((a, b) => a - b)
    .map((k) => sc.users[k]);
  if (!users.length) continue;
  withScores.add(mapId);
  const features = mapFeatures(parseCode(map.code));
  for (const u of users) {
    stats.rawRows++;
    const key = mapId + '|' + u.solution;
    if (seen.has(key)) {
      stats.dupes++;
      continue;
    }
    seen.add(key);
    rows.push({
      mapId,
      date: dateOf.get(mapId) ?? null,
      name: u.display,
      code: map.code,
      solution: u.solution,
      moves: Number(u.moves),
      features,
    });
  }
}
stats.mapsWithScores = withScores.size;
for (const id of [...maps.keys()].sort((a, b) => a - b))
  if (!withScores.has(id)) stats.mapsSkipped.push(id);
rows.sort(
  (a, b) => a.mapId - b.mapId || (a.solution < b.solution ? -1 : a.solution > b.solution ? 1 : 0),
);
fs.writeFileSync(
  path.join(outDir, 'scoreboard.json'),
  '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n',
);

// ---- oracle ----
let oracleOk = 0;
const oracleSkipped = [];
for (const f of sorted(api).filter((f) => /^(probe|getpath)_.*\.json$/.test(f))) {
  const txt = fs.readFileSync(path.join(api, f), 'utf8');
  const i = txt.indexOf('{');
  let r;
  try {
    r = JSON.parse(txt.slice(i));
  } catch {
    oracleSkipped.push(f);
    continue;
  }
  if (!Array.isArray(r.path) || r.mapcodeExecuted == null) {
    oracleSkipped.push(f);
    continue;
  }
  const name = f.replace(/\.json$/, '');
  fs.writeFileSync(
    path.join(oracleDir, f),
    JSON.stringify(
      { name, code: r.mapcodeExecuted, solution: r.usedSolution, response: r },
      null,
      1,
    ) + '\n',
  );
  oracleOk++;
}
console.log(
  `scoreboard: ${rows.length} rows (${stats.rawRows} raw, ${stats.dupes} duplicate (map,solution) dropped) from ${stats.mapsWithScores}/${stats.mapsTotal} maps; skipped maps without scores: ${stats.mapsSkipped.join(',') || 'none'}`,
);
console.log(`oracle: ${oracleOk} fixtures written; skipped: ${oracleSkipped.join(',') || 'none'}`);
