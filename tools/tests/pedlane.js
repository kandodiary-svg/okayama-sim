const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:800,height:500}}); p.setDefaultTimeout(1200000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>document.querySelector('.mode-opt[data-mode="car"]').click());
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(1500);
  const r = await p.evaluate(()=>{
    const P=__Peds, E=P.E, T=__Traffic;
    // lane point grid (4m)
    const G=new Map(); const add=(x,z,i)=>{ const k=Math.floor(x/4)+','+Math.floor(z/4); let a=G.get(k); if(!a){a=[];G.set(k,a);} a.push([x,z,i]); };
    for(let i=0;i<T.segs.length;i++){ const g=T.segs[i]; if(!g.lane) continue; const Q=g.P; for(let s=0;s<Q.len;s+=2){ const q=__pathPt(Q,s); add(q.x,q.z,i); } }
    const near=(x,z,r)=>{ let best=1e9, bi=-1; const i0=Math.floor((x-r)/4), i1=Math.floor((x+r)/4), j0=Math.floor((z-r)/4), j1=Math.floor((z+r)/4);
      for(let a=i0;a<=i1;a++) for(let c=j0;c<=j1;c++){ const L=G.get(a+','+c); if(!L) continue; for(const q of L){ const d=Math.hypot(q[0]-x,q[1]-z); if(d<best){best=d;bi=q[2];} } } return [best,bi]; };
    const tab={}, ex={};
    for(let i=0;i<20*90;i++){ __S.t+=0.05; __sim(0.05);
      if(i%100===0){ for(const L of [P.peds]) for(const o of L){ if(!o.on||o.x===undefined) continue; const e=E[o.e]; if(e.k===1) continue; const [d,si]=near(o.x,o.z,2.2); const on=d<1.6;
        const key='k'+e.k; tab[key]=tab[key]||[0,0]; tab[key][0]++; if(on){ tab[key][1]++; const g=T.segs[si]; (ex[key]=ex[key]||[]).length<6 && ex[key].push([Math.round(o.x),Math.round(o.z),d.toFixed(1),g.c,g.v]); } } } }
    return {tab, ex};
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
