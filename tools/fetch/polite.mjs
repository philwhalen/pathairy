// Polite downloader for the RL map corpus (docs/rl-agent-plan.md §4.3). One request at a time,
// ~15 s apart (±3 s jitter), in chunks of 40 with a 20-minute break between chunks.
//
//   node tools/fetch/polite.mjs <A|B|C>            dry run: prints the plan and asks for "yes"
//   node tools/fetch/polite.mjs <A|B|C> --dry-run  print the plan and exit
//
//   A  validation, full days (2026-06-05 .. 07-04): date list + every map + score page 1
//   B  validation special-only days (05-06 .. 06-04), test special-only days (07-05 .. 09-02)
//      and test full days not downloaded yet (09-03 .. 09-12)
//   C  generator samples: 30 x each special type seen in the downloaded history
//
// Control: Ctrl+C stops at once (every file is saved as it arrives, so a rerun resumes and never
// re-downloads). Creating ml/data/fetch.STOP stops after the current request; ml/data/fetch.PAUSE
// waits until it is deleted. Stops for good on any non-200 response, HTTP 429 or 5xx, or a
// Cloudflare challenge page.
//
// History files go to ml/data/history/{mapsbydate,maps,scores}/; files already in
// reference/original/api/history/ count as downloaded. Samples go to ml/data/gen/{type}_NN.json.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://www.pathery.com/';
const UA = 'pathery-local-replica/0.2 (personal offline RL corpus; 1 request per 15 s)';
const DATA = path.join(ROOT, 'ml', 'data');
const OUT_HISTORY = path.join(DATA, 'history');
const OLD_HISTORY = path.join(ROOT, 'reference', 'original', 'api', 'history');
const OUT_GEN = path.join(DATA, 'gen');
const STOP_FILE = path.join(DATA, 'fetch.STOP');
const PAUSE_FILE = path.join(DATA, 'fetch.PAUSE');

export const SPACING_MS = 15_000;
export const JITTER_MS = 3_000;
export const CHUNK = 40;
export const BREAK_MS = 20 * 60_000;
const SAMPLES_PER_TYPE = 30;
const STANDARD = new Set(['Simple', 'Normal', 'Complex']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dateRange(first, last) {
  const out = [];
  for (
    let d = new Date(first + 'T12:00:00Z');
    d.toISOString().slice(0, 10) <= last;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** The generator's name for a map type ("ABC's" -> "abcs", "Loop craziness" -> "loop craziness"). */
export function specialValue(name) {
  return name.toLowerCase().replace(/'/g, '').trim();
}

export const BATCHES = {
  A: { days: [{ dates: dateRange('2026-06-05', '2026-07-04'), mode: 'full' }] },
  B: {
    days: [
      { dates: dateRange('2026-05-06', '2026-06-04'), mode: 'special' },
      { dates: dateRange('2026-07-05', '2026-09-02'), mode: 'special' },
      { dates: dateRange('2026-09-03', '2026-09-12'), mode: 'full' },
    ],
  },
  C: { samples: SAMPLES_PER_TYPE },
};

/** Path of a history file if it exists in either location, else null. */
function existing(rel) {
  for (const dir of [OUT_HISTORY, OLD_HISTORY]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class Fetcher {
  sent = 0;
  inChunk = 0;
  constructor(total) {
    this.total = total;
    this.started = Date.now();
  }

  /** Waits for spacing, chunk breaks, PAUSE and STOP. Returns false if STOP was requested. */
  async gate() {
    if (fs.existsSync(STOP_FILE)) return false;
    while (fs.existsSync(PAUSE_FILE)) await sleep(5_000);
    if (this.sent > 0) {
      if (this.inChunk >= CHUNK) {
        const next = new Date(Date.now() + BREAK_MS).toLocaleTimeString();
        console.log(
          `-- chunk done (${this.sent} requests so far). Break until ${next}. ${eta(this.total - this.sent)}`,
        );
        await sleep(BREAK_MS);
        this.inChunk = 0;
      } else {
        await sleep(SPACING_MS + (Math.random() * 2 - 1) * JITTER_MS);
      }
    }
    return !fs.existsSync(STOP_FILE);
  }

  /** GETs `rel`, validates it, saves it to `file`, returns the parsed JSON. Throws to stop. */
  async get(rel, file) {
    if (!(await this.gate())) throw new Error('STOP file found');
    const res = await fetch(BASE + rel, { headers: { 'User-Agent': UA } });
    this.sent++;
    this.inChunk++;
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${rel}: HTTP ${res.status}`);
    if (/<html|cf-chl|Just a moment/i.test(text.slice(0, 2000)))
      throw new Error(`${rel}: Cloudflare challenge or HTML page`);
    const json = JSON.parse(text);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`  [${this.sent}] GET ${rel}`);
    return json;
  }
}

function eta(requests) {
  const ms = requests * SPACING_MS + Math.floor(Math.max(0, requests - 1) / CHUNK) * BREAK_MS;
  return `ETA ${(ms / 3_600_000).toFixed(1)} h for ${requests} requests`;
}

/** Site URL of a history file: mapsbydate/D.json -> a/mapsbydate/D.js, maps/ID.json -> a/map/ID.js,
 *  scores/ID_P.json -> a/score/ID_P.js. */
export function historyUrl(rel) {
  const [dir, file] = rel.split('/');
  const site = { mapsbydate: 'mapsbydate', maps: 'map', scores: 'score' }[dir];
  return `a/${site}/${file.replace(/\.json$/, '.js')}`;
}

async function readHistory(f, rel) {
  const p = existing(rel);
  return p
    ? JSON.parse(fs.readFileSync(p, 'utf8'))
    : f.get(historyUrl(rel), path.join(OUT_HISTORY, rel));
}

/** Planned requests for a history batch: exact for date lists, an upper bound for maps/scores. */
function planHistory(batch) {
  const lines = [];
  let count = 0;
  for (const { dates, mode } of batch.days) {
    for (const date of dates) {
      const listRel = `mapsbydate/${date}.json`;
      const list = existing(listRel);
      const ids = list ? JSON.parse(fs.readFileSync(list, 'utf8')) : null;
      if (!ids) {
        lines.push(`GET a/mapsbydate/${date}.js`);
        count++;
      }
      const picked = ids ? (mode === 'full' ? ids : ids.slice(3, 5)) : null;
      const nMaps = picked
        ? picked.filter((id) => !existing(`maps/${id}.json`)).length
        : mode === 'full'
          ? 5
          : 2;
      const nScores = picked
        ? picked.filter((id) => !existing(`scores/${id}_1.json`)).length
        : nMaps;
      if (nMaps + nScores > 0)
        lines.push(
          `  then ${date}: ${nMaps} map file(s) + ${nScores} score page(s)${ids ? '' : ' (at most)'}`,
        );
      count += nMaps + nScores;
    }
  }
  return { lines, count };
}

async function runHistory(batch, f) {
  const now = Date.now() / 1000;
  for (const { dates, mode } of batch.days) {
    for (const date of dates) {
      const ids = await readHistory(f, `mapsbydate/${date}.json`);
      const picked = mode === 'full' ? ids : ids.slice(3, 5);
      for (const [k, id] of picked.entries()) {
        const map = await readHistory(f, `maps/${id}.json`);
        if (mode === 'special' && STANDARD.has(map.name)) {
          console.log(
            `  NOTE ${date}: map #${k + 4} (${id}) is "${map.name}", not a special/Ultra map`,
          );
        }
        if (map.dateExpires > now) continue;
        await readHistory(f, `scores/${id}_1.json`);
      }
    }
  }
}

/** Special types seen in the downloaded history (all files in both locations). */
function specialTypes() {
  const names = new Set();
  for (const dir of [OUT_HISTORY, OLD_HISTORY]) {
    const d = path.join(dir, 'maps');
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const name = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).name;
      if (name && !STANDARD.has(name)) names.add(specialValue(name));
    }
  }
  return [...names].sort();
}

const sampleFile = (type, i) =>
  path.join(OUT_GEN, `${type.replace(/ /g, '_')}_${String(i).padStart(2, '0')}.json`);

/** Types that already have enough samples in reference/original/api/gen (e.g. centralized). */
function haveSamples(type, n) {
  const dir = path.join(ROOT, 'reference', 'original', 'api', 'gen');
  return fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.startsWith(`${type}_`)).length >= n;
}

function planSamples(batch) {
  const lines = [];
  let count = 0;
  for (const type of specialTypes()) {
    if (haveSamples(type, batch.samples)) continue;
    let missing = 0;
    for (let i = 1; i <= batch.samples; i++) if (!fs.existsSync(sampleFile(type, i))) missing++;
    if (missing) lines.push(`GET mapeditor?mapBySpecial=${encodeURIComponent(type)}  x ${missing}`);
    count += missing;
  }
  return { lines, count };
}

async function runSamples(batch, f) {
  for (const type of specialTypes()) {
    if (haveSamples(type, batch.samples)) continue;
    for (let i = 1; i <= batch.samples; i++) {
      const file = sampleFile(type, i);
      if (!fs.existsSync(file))
        await f.get(`mapeditor?mapBySpecial=${encodeURIComponent(type)}`, file);
    }
  }
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const batch = BATCHES[name];
  if (!batch) {
    console.error('usage: node tools/fetch/polite.mjs <A|B|C> [--dry-run]');
    process.exit(1);
  }
  const plan = batch.samples ? planSamples(batch) : planHistory(batch);
  console.log(`Batch ${name}: ${plan.lines.join('\n')}`);
  console.log(
    `\n${plan.count} requests (upper bound), one per ${SPACING_MS / 1000} s ±${JITTER_MS / 1000} s, chunks of ${CHUNK} with ${BREAK_MS / 60_000}-min breaks. ${eta(plan.count)}.`,
  );
  if (rest.includes('--dry-run') || plan.count === 0) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "yes" to start: ');
  rl.close();
  if (answer.trim() !== 'yes') return console.log('Not started.');
  const f = new Fetcher(plan.count);
  try {
    if (batch.samples) await runSamples(batch, f);
    else await runHistory(batch, f);
    console.log(`Done: ${f.sent} requests.`);
  } catch (e) {
    console.error(`STOPPED: ${e.message} (${f.sent} requests made; rerun to resume)`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
