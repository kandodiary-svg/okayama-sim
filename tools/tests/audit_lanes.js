const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:640,height:400}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const r = await p.evaluate(()=>{
    const segs=__Traffic.segs, C=__Car; const cells=new Map(); let nSamp=0;
    const add=(kind,x,z,v,seg)=>{ const key=Math.floor(x/25)+','+Math.floor(z/25); let o=cells.get(key); if(!o){ o={x,z,cliff:0,cliffMax:0,mis:0,misMax:0,off:0,seg}; cells.set(key,o); }
      if(kind==='c'){ o.cliff++; if(Math.abs(v)>Math.abs(o.cliffMax)){ o.cliffMax=v; o.cx=x; o.cz=z; } } else if(kind==='m'){ o.mis++; if(Math.abs(v)>Math.abs(o.misMax)){ o.misMax=v; o.mx=x; o.mz=z; } } else { o.off++; if(o.ox===undefined){ o.ox=x; o.oz=z; } } };
    for(const sg of segs){ const P=sg.P; if(!P||P.n<2) continue;
      let yprev=P.P[1], run=0;
      for(let s=0;s<=P.len;s+=1){ const q=__pathPt(P,s); nSamp++;
        const h=C.hAt(q.x,q.z,yprev), dh=h-yprev;
        if(Math.abs(dh)>0.35) add('c',q.x,q.z,dh,sg.i);
        const hl=C.hAt(q.x,q.z,q.y); if(Math.abs(hl-q.y)>0.6) add('m',q.x,q.z,hl-q.y,sg.i);
        if(C.kindAt(q.x,q.z,q.y)!==1){ run++; if(run===4) add('o',q.x,q.z,0,sg.i); } else run=0;
        yprev=Math.abs(dh)>0.35 ? q.y : h; }
    }
    const arr=[...cells.values()];
    return {nSamp, cells:arr.length, arr};
  });
  fs.writeFileSync('/home/claude/wx/audit/lane_audit.json', JSON.stringify(r));
  const A=r.arr;
  const sum=(k)=>A.reduce((a,o)=>a+(o[k]>0?1:0),0);
  console.log('samples',r.nSamp,'cells',r.cells,'cliffCells',sum('cliff'),'misCells',sum('mis'),'offCells',sum('off'));
  console.log('top cliffs'); A.filter(o=>o.cliff).sort((a,b)=>Math.abs(b.cliffMax)-Math.abs(a.cliffMax)).slice(0,25).forEach(o=>console.log(Math.round(o.cx),Math.round(o.cz),o.cliffMax.toFixed(2),o.cliff));
  console.log('top mismatch'); A.filter(o=>o.mis).sort((a,b)=>Math.abs(b.misMax)-Math.abs(a.misMax)).slice(0,25).forEach(o=>console.log(Math.round(o.mx),Math.round(o.mz),o.misMax.toFixed(2),o.mis));
  console.log('top off-road'); A.filter(o=>o.off).sort((a,b)=>b.off-a.off).slice(0,25).forEach(o=>console.log(Math.round(o.ox),Math.round(o.oz),o.off));
  await b.close();
})();
