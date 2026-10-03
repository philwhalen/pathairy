// Downloads midnighttherapy's analyst.js (pinned commit), applies analyst.patch, and writes
// tools/oracle/analyst.js. The file is unlicensed third-party code: it is gitignored, local only.
// Usage: node tools/oracle/fetch-analyst.mjs [outPath]
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL =
  'https://raw.githubusercontent.com/WuTheFWasThat/midnighttherapy/2c085bd1fd92ca3d780c7603fb384fb0abc5c074/src/analyst.js';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, 'analyst.js');

/** Apply a single-file unified diff to `text` (both LF-normalized). Context is verified. */
export function applyPatch(text, patch) {
  const src = text.split('\n');
  const res = [];
  let pos = 0; // index into src (0-based)
  const lines = patch.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!m) {
      if (lines[i] === '') {
        i++;
        continue;
      }
      throw new Error(`Unexpected patch line: ${lines[i]}`);
    }
    const start = Number(m[1]) - 1;
    while (pos < start) res.push(src[pos++]);
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i];
      const tag = l[0];
      const body = l.slice(1);
      if (l.startsWith('\\ ')) {
        i++;
        continue;
      }
      if (tag === ' ' || (l === '' && i < lines.length - 1)) {
        if (src[pos] !== body) throw new Error(`Context mismatch at line ${pos + 1}`);
        res.push(src[pos++]);
      } else if (tag === '-') {
        if (src[pos] !== body) throw new Error(`Removal mismatch at line ${pos + 1}`);
        pos++;
      } else if (tag === '+') {
        res.push(body);
      } else if (l === '' && i === lines.length - 1) {
        // trailing newline of patch file
      } else {
        throw new Error(`Bad hunk line: ${l}`);
      }
      i++;
    }
  }
  while (pos < src.length) res.push(src[pos++]);
  return res.join('\n');
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
const original = (await res.text()).replace(/\r\n/g, '\n');
const patch = (await readFile(join(here, 'analyst.patch'), 'utf8')).replace(/\r\n/g, '\n');
await writeFile(out, applyPatch(original, patch));
console.log(`Wrote ${out}`);
