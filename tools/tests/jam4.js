const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:800,height:500}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>document.querySelector('.mode-opt[data-mode="car"]').click());
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(1000);
  const SEC = Number(process.env.SEC||600); if(process.env.POS) await p.evaluate((q)=>{ window.__POS=q; }, process.env.POS);
  const r = await p.evaluate((SEC)=>{
    const T=__Traffic, segs=T.segs; const C=__Car.C; const P0=JSON.parse(window.__POS||'null'); if(P0){ C.x=P0[0]; C.z=P0[1]; C.v=0; }
    const res=[]; const hist={};
    for(let i=0;i<SEC*20;i++){ __S.t+=0.05; __sim(0.05);
      if(i%200===0){ for(const c of T.cars){ if(!c.type) continue; if(c.stopT>60){ const k=c.id; const g=segs[c.plan[0]]; const rem=g.P.len-c.s-c.type.l/2;
          const why = c.blockedBy ? (c.blockedBy.type ? 'car' : (c.blockedBy.ped!==undefined?'ped':'tram/other')) : (g.lane && g.sig && rem<8 ? 'signal' : !g.lane ? 'in-conn' : rem<20 ? 'lane-end' : 'mid-lane');
          hist[k]=[Math.round(c.x),Math.round(c.z),why,Math.round(c.stopT),g.lane?1:0,Math.round(rem), c.dead?1:0]; } } }
    }
    const cars=T.cars.filter(c=>c.type); const n=cars.length, moving=cars.filter(c=>c.v>=0.3).length, long=cars.filter(c=>c.stopT>60).length;
    return {n, moving, long, sample:Object.values(hist).slice(0,40)}; }, SEC);
  console.log(JSON.stringify(r));
  await b.close();
})();
