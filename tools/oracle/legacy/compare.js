const fs = require('fs'), path = require('path');
const A = require('./analyst_arr.js');
const dir = 'C:/Users/Phil/Documents/Source/pathery/reference/original/api';
function parse(code) {
  const [head, body] = code.split(':'); const h = head.split('.');
  const w = +h[0], H = +h[1];
  const b = Array.from({length: H}, () => Array(w).fill(' '));
  let idx = -1;
  for (const e of body.split('.').slice(0, -1)) { const [g, t] = e.split(','); idx += 1 + (+g || 0); if (t && idx < w*H) b[Math.floor(idx / w)][idx % w] = t; }
  return b;
}
const norm = toks => toks.filter(t => !/^t\d+$/.test(String(t))).map(t => /^u\d*$/.test(String(t)) ? 'u' : String(t));
let ok = 0, bad = 0;
for (const f of fs.readdirSync(dir).filter(f => /^(probe|getpath)_.*\.json$/.test(f))) {
  let txt = fs.readFileSync(path.join(dir, f), 'utf8'); const i = txt.indexOf('{'); const r = JSON.parse(txt.slice(i));
  if (!r.path) { console.log('SKIP', f, '(server error response:', txt.slice(0, 60) + ')'); continue; }
  const board = parse(r.mapcodeExecuted);
  const walls = r.usedSolution.split('.').slice(1, -1).filter(s => s && s !== ':').map(s => s.split(',').map(Number));
  const sol = A.pa_compute_solution(board, walls);
  const diffs = [];
  r.path.forEach((sp, k) => {
    const mp = sol.path[k];
    if (!mp) { diffs.push(`path${k} missing`); return; }
    if (!!sp.blocked !== !!mp.blocked) diffs.push(`path${k} blocked srv=${sp.blocked} mt=${mp.blocked}`);
    if (!sp.blocked) {
      if (sp.moves !== mp.moves) diffs.push(`path${k} moves srv=${sp.moves} mt=${mp.moves}`);
      const a = JSON.stringify(norm(sp.pathArray)), b = JSON.stringify(norm(mp.path));
      if (a !== b) diffs.push(`path${k} tokens\n   srv=${a}\n   mt =${b}`);
      if (sp.start !== mp.start || sp.end !== mp.end) diffs.push(`path${k} start/end srv=${sp.start}->${sp.end} mt=${mp.start}->${mp.end}`);
    }
  });
  if (diffs.length) { bad++; console.log('DIFF', f, '\n  ' + diffs.join('\n  ')); } else { ok++; console.log('OK  ', f, 'moves=' + r.totalMoves); }
}
console.log(`\n${ok} match, ${bad} differ`);
