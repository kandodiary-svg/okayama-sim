const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:700,height:450}}); p.setDefaultTimeout(1200000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); document.querySelector('.cstart-opt[data-cs="mw"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(([CID,IDX,SECS])=>{
    const MW=__MW, Car=__Car, C=Car.C, ch=MW.chains.find(q=>q.id===CID); const N=ch.sec.N, U=-ch.sec.lw*(N-1)/2; let ci=IDX;
    const pt=MW.P(ch,IDX,U,0); C.x=pt[0]; C.z=pt[2]; C.h=pt[1]; C.yaw=Math.atan2(ch.tx[IDX],ch.tz[IDX]); C.v=0; __MWT.reset();
    C.autopilot=(c)=>{ let bd=1e12; for(let k=Math.max(0,ci-6);k<=Math.min(ch.n-1,ci+30);k++){ const d=(ch.X[k]-c.x)**2+(ch.Z[k]-c.z)**2; if(d<bd){bd=d;ci=k;} }
      const k2=Math.min(ch.n-1,ci+Math.round(Math.max(15,c.v*1.1)/5)); const p=MW.P(ch,k2,U,0); const fx=Math.sin(c.yaw), fz=Math.cos(c.yaw), dx=p[0]-c.x, dz=p[2]-c.z, l=Math.hypot(dx,dz)||1, cr=(fx*dz-fz*dx)/l;
      return {thr: c.v<26?0.7:0, brk:0, wheel:Math.max(-0.5,Math.min(0.5,-cr*1.5))}; };
    const tr=[]; for(let i=0;i<SECS*20;i++){ Car.tick(0.05); __S.t+=0.05; __sim(0.05); if(i%40===0) tr.push([C.x|0,C.z|0,+(C.v*3.6).toFixed(0),ci]); }
    // 詳細
    const fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), sx=Math.cos(C.yaw), sz=-Math.sin(C.yaw); const cor=[];
    for(const [u,w] of Car.P.corners){ const px=C.x+fx*u+sx*w, pz=C.z+fz*u+sz*w; cor.push([u,w,Car.blocked(px,pz)?1:0, MW.wallAt(px,pz,C.h,true)]); }
    const obst=C.obst(C.x,C.z,fx,fz,1); const hits=[]; for(let d=-3;d<=8;d+=1){ const e=__Obs.hit(C.x+fx*d,C.z+fz*d,0.55,null,null); if(e) hits.push([d,e.r,Object.keys(e.o||{}).join('|'),e.o&&e.o.kind,e.o&&e.o.type&&e.o.type.name]); }
    return {tr, pos:[C.x,C.z,C.h,C.yaw,C.v], cor, obst, hits, tn:ch.tn[ci], br:ch.br[ci], ci}; }, [Number(process.env.CID||0), Number(process.env.IDX||17560), Number(process.env.SECS||30)]);
  console.log(JSON.stringify(r));
  await b.close();
})();
