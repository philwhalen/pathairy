const fs=require('fs');
const sym={o:'.',r:'#',s:'S',f:'F',p:'_',z:'~',x:'x'};
for(const f of process.argv.slice(2)){const m=JSON.parse(fs.readFileSync(f));
 console.log(f.replace(/.*\//,''),m.width+'x'+m.height,'walls',m.walls);
 for(const row of m.tiles)console.log('  '+row.map(([t,v])=>t==='c'?String.fromCharCode(64+v):t==='t'?'t':t==='u'?'u':t==='r'&&v==3?'%':(sym[t]||'?')).join(''));}
