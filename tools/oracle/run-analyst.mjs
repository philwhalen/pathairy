// Wrapper around midnighttherapy's analyst.js (tools/oracle/analyst.js) producing results in the
// *current server format*.
//
// analyst.js is CommonJS and sloppy-mode, so it is evaluated through node:vm. That works even when
// the surrounding package.json says "type": "module".
//
// Token handling (verified against probe_teleport, probe_tptwo, getpath_23445 and all other saved
// responses):
//   server first use of tN :  ..., <move onto tN>, "u", "x,y", "u", ...      (x,y = exit uN tile)
//   server reuse of tN     :  ..., <move onto tN>, "tN", ...
//   analyst first use      :  ..., <move onto tN>, "tN", "uN", "x,y", "uN", ...
//   analyst reuse          :  nothing
// The server's reuse token IS reconstructible: the analyst gives the exact move list and exit
// coordinates, so we replay positions on the board and emit "tN" whenever a step lands on an
// already-used tN tile. `runAnalyst` therefore aims to reproduce the server token stream exactly
// (direction tokens become numbers 1=up 2=right 3=down 4=left, as in the server's pathArray).
// `normalizeTokens` (drop tN, uN -> u) is kept as a lossy fallback for comparing against legacy data.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANALYST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'analyst.js');
let analyst = null;

/** Load analyst.js lazily; throws a clear error if it has not been fetched. */
export function loadAnalyst() {
  if (analyst) return analyst;
  if (!fs.existsSync(ANALYST)) {
    throw new Error(
      `analyst.js not found at ${ANALYST}. Run \`npm run oracle:fetch\` to download the reference engine.`,
    );
  }
  const m = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(ANALYST, 'utf8'),
    { module: m, exports: m.exports, console },
    { filename: ANALYST },
  );
  analyst = m.exports;
  return analyst;
}

/** Run-length map code -> string[][] of tile codes (' ' = empty). Row 0 is the top row. */
export function parseCode(code) {
  const [head, body] = code.split(':');
  const h = head.split('.');
  const w = +h[0],
    H = +h[1];
  const b = Array.from({ length: H }, () => Array(w).fill(' '));
  let idx = -1;
  for (const e of body.split('.').slice(0, -1)) {
    const [g, t] = e.split(',');
    idx += 1 + (+g || 0);
    if (t && idx < w * H) b[Math.floor(idx / w)][idx % w] = t;
  }
  return b;
}

/** Solution string (".x,y.x,y.:" style) -> [[x, y], ...] exactly as passed to analyst. */
export function parseSolution(sol) {
  return String(sol)
    .replace(/:\s*$/, '')
    .split('.')
    .filter((s) => s.includes(','))
    .map((s) => s.split(',').map(Number));
}

/** Feature list for a board: subset of teleport, ice, dual, x, p (empty = plain). */
export function mapFeatures(board) {
  const tiles = new Set(board.flat());
  const has = (re) => [...tiles].some((t) => re.test(t));
  const f = [];
  if (has(/^t\d/)) f.push('teleport');
  if (has(/^z\d/)) f.push('ice');
  if (tiles.has('s2')) f.push('dual');
  if (has(/^x\d/)) f.push('x');
  if (tiles.has('p1')) f.push('p');
  return f;
}

const DIRS = { 1: [0, -1], 2: [1, 0], 3: [0, 1], 4: [-1, 0] }; // token -> [dx, dy]

/** Convert analyst's token list for one path to the server's pathArray. */
export function toServerTokens(tokens, start, board) {
  const out = [];
  let [x, y] = start.split(',').map(Number);
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i]);
    if (/^[1-4]$/.test(t)) {
      const [dx, dy] = DIRS[t];
      x += dx;
      y += dy;
      out.push(+t);
      const tile = board[y]?.[x];
      if (tile && /^t\d+$/.test(tile) && used.has(tile)) out.push(tile);
    } else if (/^t\d+$/.test(t)) {
      if (!/^u\d+$/.test(String(tokens[i + 1])))
        throw new Error('unexpected analyst teleport token sequence');
      used.add(t); // first use: analyst emits tN, uN, "x,y", uN
      out.push('u', String(tokens[i + 2]), 'u');
      [x, y] = String(tokens[i + 2])
        .split(',')
        .map(Number);
      i += 3;
    } else {
      out.push(t); // f1, c3, r ...
    }
  }
  return out;
}

/** Lossy normalizer: drop tN, map uN -> u, stringify. Apply to BOTH sides when comparing. */
export function normalizeTokens(tokens) {
  return tokens
    .filter((t) => !/^t\d+$/.test(String(t)))
    .map((t) => (/^u\d*$/.test(String(t)) ? 'u' : String(t)));
}

/**
 * Run analyst.js. Returns {paths:[{tokens, moves, blocked, start, end}], totalMoves, blocked}.
 * Blocked paths: tokens = [lastTarget] (server emits e.g. ["f1"]); `end` is NOT meaningful for blocked
 * paths (server reports quirky values like "0,0" or "-1,0"), so do not compare it.
 * `tokens` follows the server pathArray format (see header). `moves` is 0 for blocked paths.
 */
export function runAnalyst(code, solution) {
  const A = loadAnalyst();
  const board = parseCode(code);
  const r = A.pa_compute_solution(board, parseSolution(solution));
  const paths = r.path.map((p) => ({
    tokens: p.blocked ? [String(p.lastTarget)] : toServerTokens(p.path.map(String), p.start, board),
    moves: p.blocked ? 0 : p.moves,
    blocked: !!p.blocked,
    start: p.start,
    end: p.end,
  }));
  const blocked = paths.some((p) => p.blocked);
  return { paths, totalMoves: blocked ? 0 : paths.reduce((s, p) => s + p.moves, 0), blocked };
}
