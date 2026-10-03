const fs=require('fs'),path=require('path');
const dir=process.argv[2];
const types=['simple','normal','complex','centralized'];
for(const t of types){
  const files=fs.readdirSync(dir).filter(f=>f.startsWith(t+'_'));
  const stats=[];
  for(const f of files){
    const m=JSON.parse(fs.readFileSync(path.join(dir,f)));
    const cnt={};const pos={};
    m.tiles.forEach((row,y)=>row.forEach(([ty,v],x)=>{const k=ty+(v??'');if(ty!=='o'){cnt[k]=(cnt[k]||0)+1;(pos[ty]=pos[ty]||[]).push([x,y,v]);}}));
    stats.push({f,name:m.name,w:m.width,h:m.height,walls:m.walls,cp:m.checkpoints,tp:m.teleports,cnt,pos,flags:m.flags,valid:m.validated,code:m.code});
  }
  const uniq=a=>[...new Set(a)].join('|');
  console.log('=====',t,'n=',stats.length);
  console.log('names',uniq(stats.map(s=>s.name)),' sizes',uniq(stats.map(s=>s.w+'x'+s.h)),' walls',uniq(stats.map(s=>s.walls)),' cp',uniq(stats.map(s=>s.cp)),' tp',uniq(stats.map(s=>s.tp)),' flags',uniq(stats.map(s=>s.flags)),' valid',uniq(stats.map(s=>s.valid)));
  const keys=uniq(stats.flatMap(s=>Object.keys(s.cnt))).split('|').sort();
  for(const k of keys){const v=stats.map(s=>s.cnt[k]||0);console.log('  ',k.padEnd(4),'min',Math.min(...v),'max',Math.max(...v),'avg',(v.reduce((a,b)=>a+b,0)/v.length).toFixed(1));}
  // start/finish columns
  console.log('  s cols',uniq(stats.flatMap(s=>(s.pos.s||[]).map(p=>p[0]))),' s rows',uniq(stats.map(s=>(s.pos.s||[]).map(p=>p[1]).join(','))));
  console.log('  f cols',uniq(stats.flatMap(s=>(s.pos.f||[]).map(p=>p[0]))),' f rows',uniq(stats.map(s=>(s.pos.f||[]).map(p=>p[1]).join(','))));
  // rock values by location: border col vs interior
  const rv={};stats.forEach(s=>(s.pos.r||[]).forEach(([x,y,v])=>{const loc=(x===0||x===s.w-1)?'edgecol':(y===0||y===s.h-1)?'edgerow':'interior';rv[loc+':r'+v]=(rv[loc+':r'+v]||0)+1;}));
  console.log('  rock loc',JSON.stringify(rv));
  // checkpoint/teleport columns
  console.log('  c cols',uniq(stats.flatMap(s=>(s.pos.c||[]).map(p=>p[0])).sort((a,b)=>a-b)));
  console.log('  t/u',stats.map(s=>((s.pos.t||[]).map(p=>'t'+p[2]+'@'+p[0]+','+p[1]).concat((s.pos.u||[]).map(p=>'u'+p[2]+'@'+p[0]+','+p[1]))).join(' ')).filter(x=>x).slice(0,6).join(' || '));
}
