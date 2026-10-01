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
    const P=__Peds, E=P.E, T=__Traffic; const ph=__phase, ps=P.pedState;
    let pairs=0, conflictPairs=0, ex=[]; const seen=new Set();
    for(const g of T.segs){ if(!g.lane||!g.sig) continue; const sp=__pathPt(g.P,g.sig.s), tg=__pathTan(g.P,g.sig.s);
      for(const e of E){ if(e.k!==1||e.g!==g.sig.g) continue; const mx=(e.P[0]+e.P[e.P.length-2])/2, mz=(e.P[1]+e.P[e.P.length-1])/2;
        const dx=mx-sp.x, dz=mz-sp.z, dist=Math.hypot(dx,dz); if(dist>22) continue; const ahead=(dx*tg.x+dz*tg.z); if(ahead<-3) continue;   // 車の進行方向の先にある横断歩道
        const vx=e.P[e.P.length-2]-e.P[0], vz=e.P[e.P.length-1]-e.P[1], L=Math.hypot(vx,vz)||1; const cosv=Math.abs((vx*tg.x+vz*tg.z)/L/(Math.hypot(tg.x,tg.z)||1)); if(cosv>0.5) continue; // 車が横切る横断歩道
        pairs++; let both=0, n=0; for(let t=0;t<120;t+=1){ n++; if(ph(g.sig.g,g.sig.ph,t)===0 && ps(e.g,e.ph,t)===0) both++; }
        if(both>0){ conflictPairs++; if(ex.length<10) ex.push([Math.round(sp.x),Math.round(sp.z),g.sig.g,g.sig.ph,e.ph,both]); } } }
    return {pairs, conflictPairs, ex};
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
