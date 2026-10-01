const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:(Number(process.env.VW)||1200),height:(Number(process.env.VH)||760)}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const info = await p.evaluate(([ri,vi])=>{
    document.querySelector('.mode-opt[data-mode="jr"]').click();
    const rs=[...document.querySelectorAll('#jr-routes .route-opt')]; const names=rs.map(x=>x.textContent.replace(/\s+/g,' ')); 
    if(rs[ri]) rs[ri].click(); const vs=[...document.querySelectorAll('#jr-vehs .veh-opt')]; if(vs[vi]) vs[vi].click();
    return {names, vehs:vs.map(x=>x.textContent)};
  }, [Number(process.env.RI||0), Number(process.env.VI||0)]);
  console.log(JSON.stringify(info));
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(3000);
  const SEC=Number(process.env.SEC||900);
  const res = await p.evaluate((SEC)=>{
    const S=__S, V=()=>__VEHICLES[S.vehicle]; const log=[]; let dwell=0, lastIdx=S.stopIndex, finished=false, maxv=0, lastLogT=0;
    const info0={route:S.route.name, veh:V().name, stops:S.stops.map(s=>s.name+'@'+Math.round(s.arc)), total:Math.round(S.total), len:Math.round(V().len), pos:Math.round(S.pos)};
    for(let i=0;i<SEC*20 && S.running;i++){
      const v=S.speed, lim=__limitAt(S.pos), ds=S.cum[S.stopIndex]-S.pos, Vh=V();
      if(S.doorOpen){ dwell+=0.05; if(dwell>6 && v<0.2){ const atStart=(S.pos-S.cum[0])<3 && S.stopIndex===1 && !S._started; const atFinal=S.stopIndex>=S.stops.length-1 && S._started2; if(atStart){ S._started=true; S._started2=false; __doorAction(); dwell=0; } else if(S.stopIndex<S.stops.length-1){ __doorAction(); dwell=0; } } }
      else {
        const a=(Vh.bdec[4]/3.6)*0.8, vp=3.6*Math.sqrt(2*a*Math.max(0,ds-12));
        const tgt=Math.min(lim-4, vp);
        if(v>tgt+1.5) __setNotch(-4); else if(v<tgt-6) __setNotch(4); else if(v<tgt-2) __setNotch(2); else __setNotch(0);
        if(ds<40 && v<25) __setNotch(-3); if(ds<14 && v<6) __setNotch(-4); 
        if(v<0.3 && ds<10 && ds>-3.5){ __doorAction(); }
      }
      __sim(0.05); __tick(0.05);
      maxv=Math.max(maxv,S.speed); { const tx=document.getElementById('subtitle').textContent; if(tx!==window.__lastSub){ window.__lastSub=tx; log.push(['sub',S.t.toFixed(0),tx.slice(0,60)]); } }
      if(S.stopIndex>=S.stops.length-1) S._started2=true;
      if(S.stopIndex!==lastIdx){ log.push(['stopIndex',S.stopIndex,S.t.toFixed(0),Math.round(S.pos)]); lastIdx=S.stopIndex; }
      if(S.t-lastLogT>60){ lastLogT=S.t; log.push(['t',S.t.toFixed(0),'pos',Math.round(S.pos),'v',Math.round(S.speed),'lim',lim,'ds',Math.round(ds),'score',Math.round(S.score)]); }
    }
    return {info0, log, end:{running:S.running,t:S.t.toFixed(0),pos:Math.round(S.pos),v:S.speed.toFixed(1),score:Math.round(S.score),maxv:Math.round(maxv),stopIndex:S.stopIndex,door:S.doorOpen}};
  }, SEC);
  console.log(JSON.stringify(res));
  if(process.env.VIEW){ await p.evaluate((v)=>{ __S.view=v; document.getElementById('ui').classList.toggle('cab', v==='cab'); }, process.env.VIEW); }
  await p.waitForTimeout(4000);
  if(process.env.SHOT){ await p.screenshot({path:process.env.SHOT, timeout:600000}); }
  await b.close();
})();
