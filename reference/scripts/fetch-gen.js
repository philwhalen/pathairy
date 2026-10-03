// Fetches freshly generated special maps to enlarge the generator-sample corpus.
//
//   node reference/scripts/fetch-gen.js <type> <targetCount>
//   e.g. node reference/scripts/fetch-gen.js complex 80   (fetches until complex_80.json exists)
//
// Politeness: sequential, >= 3 s between requests (plus jitter), stops at the first error,
// never re-fetches an existing file. Saved as reference/original/api/gen/{type}_NN.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://www.pathery.com/';
const OUT = path.join(__dirname, '..', 'original', 'api', 'gen');
const UA = 'pathery-local-clone/0.1 (generator stats)';
const [type, targetArg] = process.argv.slice(2);
const target = +targetArg;
if (!type || !(target > 0)) {
  console.error('usage: node fetch-gen.js <type> <targetCount>');
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let sent = 0;
  for (let i = 1; i <= target; i++) {
    const file = path.join(OUT, `${type}_${String(i).padStart(2, '0')}.json`);
    if (fs.existsSync(file)) continue;
    if (sent > 0) await sleep(3000 + Math.random() * 2000);
    const rel = `mapeditor?mapBySpecial=${encodeURIComponent(type)}`;
    const res = await fetch(BASE + rel, { headers: { 'User-Agent': UA } });
    sent++;
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${rel}: HTTP ${res.status} ${text.slice(0, 200)}`);
    JSON.parse(text);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`saved ${path.basename(file)}`);
  }
  console.log(`done, ${sent} requests`);
})().catch(e => { console.error(e.message); process.exit(1); });
