const fs = require('fs'), path = require('path');
const A = require('./analyst_arr.js');
const H = 'C:/Users/Phil/Documents/Source/pathery/reference/original/api/history';
function parse(code) {
  const [head, body] = code.split(':'); const h = head.split('.');
  const w = +h[0], Hh = +h[1];
  const b = Array.from({length: Hh}, () => Array(w).fill(' '));
  let idx = -1;
  for (const e of body.split('.').slice(0, -1)) { const [g, t] = e.split(','); idx += 1 + (+g || 0); if (t && idx < w * Hh) b[Math.floor(idx / w)][idx % w] = t; }
  return b;
}
const feats = m => { const s = new Set(); m.tiles.flat().forEach(([t, v]) => s.add(t + v)); const f = [];
  if ([...s].some(x => /^t/.test(x))) f.push('tp'); if ([...s].some(x => /^z/.test(x))) f.push('ice:' + [...s].filter(x => /^z/.test(x)).join('/'));
  if (s.has('s2')) f.push('dual'); if ([...s].some(x => /^x/.test(x))) f.push('x'); if (s.has('p1')) f.push('p'); return f.join(',') || '-'; };
let total = 0, ok = 0; const byMap = [];
for (const sf of fs.readdirSync(path.join(H, 'scores')).sort()) {
  const id = sf.split('_')[0]; if (!fs.existsSync(path.join(H, 'maps', id + '.json'))) continue; const m = JSON.parse(fs.readFileSync(path.join(H, 'maps', id + '.json')));
  const s = JSON.parse(fs.readFileSync(path.join(H, 'scores', sf)));
  const board = parse(m.code); let mOk = 0, mN = 0; const bad = [];
  for (const u of Object.values(s.users)) {
    const walls = u.solution.split('.').slice(1, -1).filter(x => x && x !== ':').map(x => x.split(',').map(Number));
    const r = A.pa_compute_solution(board, walls); const mv = isNaN(r.value) ? 0 : r.value;
    mN++; total++; if (mv === +u.moves) { mOk++; ok++; } else bad.push(`${u.moves}->${mv}`);
  }
  byMap.push(`${sf.padEnd(14)} ${m.name.padEnd(28)} ${(m.width + 'x' + m.height).padEnd(6)} ${feats(m).padEnd(16)} ${mOk}/${mN}${bad.length ? '  MISMATCH srv->mt: ' + bad.join(' ') : ''}`);
}
console.log(byMap.join('\n')); console.log(`\n${ok}/${total} solutions match on moves`);
