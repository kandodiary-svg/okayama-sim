const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:900,height:600}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(4000);
  const r = await p.evaluate(()=>{
    const C=__Car.C; const P=__Peds; const o=P.peds.find(q=>q.on && P.E[q.e].k===1) || P.peds.find(q=>q.on);
    o.stand=999; o.v=0; C.x=o.x-o.fx*9; C.z=o.z-o.fz*9; C.yaw=Math.atan2(o.fx,o.fz); C.v=0;
    C.autopilot=()=>({thr:0.6,brk:0,wheel:0});
    for(let i=0;i<80;i++){ __sim(0.05); __Car.tick(0.05); if(C.hitT>0) break; }
    C.autopilot=null;
    return 'hit '+C.hitT.toFixed(2)+' what '+C.hitWhat+' dist '+Math.hypot(C.x-o.x,C.z-o.z).toFixed(1);
  });
  console.log(r); await b.close();
})();
