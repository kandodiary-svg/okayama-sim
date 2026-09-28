const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="bus"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(3000);
  const ss = JSON.parse(process.env.SS||'[60,100]'); let i=0;
  for (const s of ss){
    await p.evaluate((s)=>{ const C=__Car.C, P=__busP(); const q=__pathPt(P,s), t=__pathTan(P,s); C.x=q.x; C.z=q.z; C.yaw=Math.atan2(t.x,t.z); C.v=0; }, s);
    for(let k=0;k<20;k++){ await p.waitForTimeout(250); }
    await p.screenshot({path:`/tmp/busshot${i++}.png`});
  }
  await b.close();
})();
