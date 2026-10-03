// Records pathery.com `getpath` responses for the probes in tools/oracle/probes.json as fixtures in
// tests/fixtures/oracle/{name}.json. Polite by design: sequential, 3-4 s apart, hard request cap,
// stops at the first HTTP/network error, never re-sends a probe whose fixture already exists.
// Usage: tsx tools/oracle/record.ts [--probes file.json] [--only a,b] [--dry-run] [--max 40]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../tests/fixtures/oracle');
const UA = 'pathery-local-clone/0.1 (offline engine test fixtures)';
const ENDPOINT = 'https://www.pathery.com/do.php';

interface Probe {
  name: string;
  question?: string;
  code: string;
  solution: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const probesFile = arg('--probes') ?? path.join(here, 'probes.json');
const only = arg('--only')?.split(',').filter(Boolean);
const dryRun = process.argv.includes('--dry-run');
const maxRequests = Number(arg('--max') ?? 40);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a response that may have a non-JSON prefix before the first `{`; null if it isn't JSON. */
function parseResponse(text: string): unknown {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

function isPathResponse(r: any): boolean {
  return !!r && typeof r === 'object' && Array.isArray(r.path) && typeof r.totalMoves === 'number';
}

export function buildUrl(code: string, solution: string): string {
  return (
    `${ENDPOINT}?r=getpath&isChallenge=false&mapid=-1` +
    `&mapcode=${encodeURIComponent(code)}&solution=${encodeURIComponent(solution)}`
  );
}

async function main() {
  let probes: Probe[] = JSON.parse(fs.readFileSync(probesFile, 'utf8'));
  if (only) {
    const missing = only.filter((n) => !probes.some((p) => p.name === n));
    if (missing.length) throw new Error(`Unknown probe(s): ${missing.join(', ')}`);
    probes = probes.filter((p) => only.includes(p.name));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const todo = probes.filter((p) => !fs.existsSync(path.join(outDir, `${p.name}.json`)));
  console.log(`${probes.length} probes, ${todo.length} without a fixture`);
  if (todo.length > maxRequests) {
    throw new Error(`Refusing: ${todo.length} requests exceeds the cap of ${maxRequests}`);
  }
  let sent = 0;
  for (const p of todo) {
    const url = buildUrl(p.code, p.solution);
    if (dryRun) {
      console.log(`[dry-run] ${p.name}: POST ${url}`);
      continue;
    }
    if (sent > 0) await sleep(3000 + Math.random() * 1000);
    sent++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'rndval=1',
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status} for ${p.name}; stopping. Body: ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const response = parseResponse(text);
    const record: Record<string, unknown> = {
      name: p.name,
      question: p.question,
      code: p.code,
      solution: p.solution,
    };
    if (isPathResponse(response)) {
      record.response = response;
      console.log(`${p.name}: totalMoves=${(response as any).totalMoves}`);
    } else {
      // Error / unexpected shape: keep it (informative) so it is not re-sent, then stop.
      record.error = true;
      record.raw = text;
      console.log(`${p.name}: non-path response: ${text.slice(0, 200)}`);
    }
    fs.writeFileSync(path.join(outDir, `${p.name}.json`), JSON.stringify(record, null, 2) + '\n');
    // A JSON {"error": ...} reply is an expected server verdict; anything else is unexpected: stop.
    if (record.error && !(response && typeof response === 'object' && 'error' in response)) {
      console.error(`Unexpected response for ${p.name}; stopping.`);
      process.exit(1);
    }
  }
  console.log(`done, ${sent} request(s) sent`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
