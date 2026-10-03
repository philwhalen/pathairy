// Downloads past daily maps and their scoreboards (which include every player's solution and
// server-scored move count) so the engine can be checked offline without calling getpath.
//
//   node reference/scripts/fetch-history.js <lastDate yyyy-mm-dd> <days> [maxScorePages]
//
// Politeness: one request at a time, a pause between requests, nothing re-downloaded (files on
// disk are reused), and it stops at the first non-200 response. mapsbydate files are usually
// served from Cloudflare's cache; old map files often miss it, and score pages always reach the
// PHP origin, so those get longer pauses. Score pages are capped by maxScorePages (default 1).
const fs = require('fs'), path = require('path');

const BASE = 'https://www.pathery.com/';
const OUT = path.join(__dirname, '..', 'original', 'api', 'history');
const CACHED_DELAY_MS = 1000, MAP_DELAY_MS = 2000, ORIGIN_DELAY_MS = 3000;
const UA = 'pathery-local-replica/0.1 (personal offline test corpus; low rate)';

const [lastDate, days = '20', maxPagesArg = '1'] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDate || '')) {
  console.error('usage: node fetch-history.js <lastDate yyyy-mm-dd> <days> [maxScorePages]');
  process.exit(1);
}
const maxPages = +maxPagesArg;
let requests = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns parsed JSON from disk if present, else fetches, saves and returns it.
async function get(rel, file, delayMs) {
  const p = path.join(OUT, file);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  await sleep(delayMs);
  const res = await fetch(BASE + rel, { headers: { 'User-Agent': UA } });
  requests++;
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${rel}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  console.log(`  GET ${rel} (${res.headers.get('cf-cache-status')})`);
  return json;
}

function dateList(last, n) {
  const out = [], d = new Date(last + 'T12:00:00Z');
  for (let i = 0; i < n; i++, d.setUTCDate(d.getUTCDate() - 1)) out.push(d.toISOString().slice(0, 10));
  return out.reverse();
}

(async () => {
  const now = Date.now() / 1000;
  const mapIds = new Set();
  for (const date of dateList(lastDate, +days)) {
    const ids = await get(`a/mapsbydate/${date}.js`, `mapsbydate/${date}.json`, CACHED_DELAY_MS);
    ids.forEach(id => mapIds.add(id));
  }
  console.log(`${mapIds.size} maps`);

  const summary = [];
  for (const id of [...mapIds].sort((a, b) => a - b)) {
    const map = await get(`a/map/${id}.js`, `maps/${id}.json`, MAP_DELAY_MS);
    if (map.dateExpires > now) { console.log(`  skip ${id} ${map.name}: still running`); continue; }
    const first = await get(`a/score/${id}_1.js`, `scores/${id}_1.json`, ORIGIN_DELAY_MS);
    if (first.isCurrentMap) { console.log(`  skip ${id}: scoreboard says current`); continue; }
    let rows = Object.keys(first.users).length;
    for (let page = 2; page <= Math.min(first.pageCount, maxPages); page++) {
      const s = await get(`a/score/${id}_${page}.js`, `scores/${id}_${page}.json`, ORIGIN_DELAY_MS);
      rows += Object.keys(s.users).length;
    }
    summary.push(`${id} ${map.name} ${map.width}x${map.height} pages=${first.pageCount} rows=${rows} best=${first.bestMoves}`);
  }
  console.log(summary.join('\n'));
  console.log(`${requests} network requests`);
})().catch(e => { console.error('STOPPED:', e.message, `(${requests} requests made)`); process.exit(1); });
