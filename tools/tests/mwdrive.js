// 山陽道の車走行テスト（物理のみ）: 自動運転で本線を走る / ガードレールに当たる / 行き止まり / 救済
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:900,height:550}}); p.setDefaultTimeout(1200000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { const t=m.text(); if(m.type()==='error') console.log('CON', t.slice(0,200)); });
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const places = JSON.parse(process.env.PLACES || '[["-4544,-2878","up"],["-4544,-2878","down"]]');
  for (const [pl, dir] of places) {
    await p.evaluate(([pl,dir])=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); document.querySelector('.cstart-opt[data-cs="mw"]').click(); document.getElementById('mw-place').value = pl; document.querySelector('.cstart-dir[data-dir="'+dir+'"]').click(); document.getElementById('start').click(); }, [pl,dir]);
    await p.waitForTimeout(1500);
    const r = await p.evaluate(async ([secs,DIR,GUARD])=>{
      const C=__Car.C, MW=__MW; const out={start:{x:C.x|0,z:C.z|0,h:+C.h.toFixed(1),yaw:+C.yaw.toFixed(2)}};
      let maxLat=0, maxDh=0, hits=0, minv=99, vmax=0, off=0, t=0, odo0=C.odo; const tgtV=26;
      const sp=MW.spawn(C.x,C.z,DIR,0); let ch=sp.c, ci=sp.i; const N=ch.sec.N, lw=ch.sec.lw, U=-lw*(N-1)/2; const trace=[];
      C.autopilot=(c)=>{ let bd=1e12; for(let k=Math.max(0,ci-6);k<=Math.min(ch.n-1,ci+30);k++){ const d=(ch.X[k]-c.x)**2+(ch.Z[k]-c.z)**2; if(d<bd){bd=d;ci=k;} }
        const lat=Math.sqrt(bd); maxLat=Math.max(maxLat,lat); const k2=Math.min(ch.n-1,ci+Math.round(Math.max(15,c.v*1.1)/5)); const p=MW.P(ch,k2,U,0);
        const fx=Math.sin(c.yaw), fz=Math.cos(c.yaw), dx=p[0]-c.x, dz=p[2]-c.z, l=Math.hypot(dx,dz)||1, cr=(fx*dz-fz*dx)/l; let wheel=Math.max(-0.5,Math.min(0.5,-cr*1.5)); if(GUARD && t>10) wheel=GUARD;
        return {thr: c.v<tgtV?0.7:0, brk: c.v>tgtV+2?0.3:0, wheel}; };
      for(let i=0;i<secs*20;i++){ __Car.tick(0.05); __S.t+=0.05; __sim(0.05); __Loc.update(0.05,C.x,C.z,''); t+=0.05; const rd=MW.roadAt(C.x,C.z,C.h); if(!rd) off+=0.05; else maxDh=Math.max(maxDh,Math.abs(rd.y-C.h)); if(C.hitT>0) hits++; if(i%100===0) trace.push([C.x|0,C.z|0,+C.h.toFixed(1),+(C.v*3.6).toFixed(0)]); vmax=Math.max(vmax,C.v*3.6); }
      out.end={x:C.x|0,z:C.z|0,h:+C.h.toFixed(1)}; out.km=+((C.odo-odo0)/1000).toFixed(2); out.maxLat=+maxLat.toFixed(2); out.maxDh=+maxDh.toFixed(2); out.hitFrames=hits; out.offRoadSec=+off.toFixed(1); out.vmaxKmh=+vmax.toFixed(0);
      C.autopilot=null; out.mwt=__MWT.count; out.near=__MWT.cars.filter(o=>Math.hypot(o.x-C.x,o.z-C.z)<40).map(o=>({lane:o.lane,v:+o.v.toFixed(1),dx:+(o.x-C.x).toFixed(1),dz:+(o.z-C.z).toFixed(1),s:o.s|0,c:o.c.id,truck:o.truck})); out.player={yaw:+C.yaw.toFixed(2),v:+C.v.toFixed(2),hitT:C.hitT, msg:C.msg, thr:+C.thr.toFixed(2)}; out.pr=(()=>{const r=__MW.roadAt(C.x,C.z,C.h,true);return r?{c:r.c.id,u:+r.u.toFixed(2),s:((r.i+r.t)*r.c.ds)|0}:null})(); out.chip=document.getElementById('locchip').textContent; out.heapMB=Math.round((performance.memory||{}).usedJSHeapSize/1e6); out.trace=trace.map(t=>t.join(',')).join(' | '); return out; }, [Number(process.env.SECS||120),dir,Number(process.env.GUARD||0)]);
    console.log(pl, dir, JSON.stringify(r));
    if (process.env.RESCUE) { await p.evaluate(()=>document.getElementById('rescue-btn').click()); await p.waitForTimeout(3000); console.log('rescue', JSON.stringify(await p.evaluate(()=>{const C=__Car.C, rd=__MW.roadAt(C.x,C.z,C.h); return {x:C.x|0,z:C.z|0,h:+C.h.toFixed(1),onRoad:!!rd, roadY: rd?+rd.y.toFixed(1):null, v:C.v, msg:C.msg}}))); }
    await p.evaluate(()=>document.getElementById('car-menu').click()); await p.waitForTimeout(300);
  }
  await b.close();
})();
