const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  const shots = JSON.parse(process.env.SHOTS || '[[30,40,18,3.14159,0.35,40]]');
  let i=0;
  for (const [x,z,y,yaw,pitch,dist] of shots) {
    await p.evaluate(([x,z,y,yaw,pitch,dist])=>{ const H=__Heli.H; Object.assign(H,{x,z,y,yaw,vF:0,vS:0,vY:0,camYaw:0,camPitch:pitch,camDist:dist}); }, [x,z,y,yaw,pitch,dist]);
    for (let k=0;k<30;k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    await p.screenshot({path:`/tmp/ekishot${i++}.png`});
  }
  await b.close();
})();
