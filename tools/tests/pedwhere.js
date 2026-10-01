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
    const P=__Peds, E=P.E, Car=__Car; const tab={}; const bad=[];
    for(let i=0;i<20*120;i++){ __S.t+=0.05; __sim(0.05);
      if(i%100===0){ for(const L of [P.peds,P.bikes]) for(const o of L){ if(!o.on||o.x===undefined) continue; const e=E[o.e]; const kd=Car.kindAt(o.x,o.z); const bl=Car.blocked(o.x,o.z)?1:0;
        const key=(o.bike?'B':'P')+'k'+e.k+'_kind'+kd+(bl?'_blk':''); tab[key]=(tab[key]||0)+1;
        if(!o.bike && e.k!==1 && e.k!==5 && kd===1 && bad.length<12) bad.push([Math.round(o.x),Math.round(o.z),e.k]); } } }
    return {tab, bad, C: __Car.C.x.toFixed(0)+','+__Car.C.z.toFixed(0)};
  });
  console.log(JSON.stringify(r,null,0));
  await b.close();
})();
