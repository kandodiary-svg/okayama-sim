const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:800,height:500}}); p.setDefaultTimeout(1200000);
  p.on('pageerror', e => console.log('ERR', e.message));
  p.on('console', m => { const t=m.text(); if(/crosswalk phases/.test(t)) console.log('CON', t); });
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>document.querySelector('.mode-opt[data-mode="car"]').click());
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(1500);
  const r = await p.evaluate(()=>{
    const T=__Traffic, segs=T.segs; const tab={}; let samples=0, mov={u:0,m:0}; const jam=[];
    for(let i=0;i<20*150;i++){ __S.t+=0.05; __sim(0.05);
      if(i>400 && i%100===0){ samples++; for(const c of T.cars){ if(!c.type) continue; const g=segs[c.plan[0]]; const cl=g.lane?g.c:(segs[c.plan[0]].from!=null?segs[segs[c.plan[0]].from].c:'?'); tab[cl]=(tab[cl]||0)+1; } } }
    const tot=Object.values(tab).reduce((a,b)=>a+b,0); const out={}; for(const k in tab) out[k]=(tab[k]/tot*100).toFixed(1)+'%';
    return {out, cars:T.cars.filter(c=>c.type).length, stopped:T.cars.filter(c=>c.type&&c.stopT>30).length};
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
