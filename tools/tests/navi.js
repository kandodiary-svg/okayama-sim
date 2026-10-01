const { chromium } = require('playwright');
(async () => {
  const W=Number(process.env.W||1280), H=Number(process.env.HT||720);
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:W,height:H}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  console.log('K hist', JSON.stringify(await p.evaluate(()=>__NaviMap.stats())));
  // car: 岡山駅前
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(6000);
  const t0=Date.now(); 
  await p.waitForTimeout(3000);
  console.log('car navi on', await p.evaluate(()=>__NaviMap.on), await p.evaluate(()=>document.getElementById('navi-ll').textContent+' | '+document.getElementById('navi-rd').textContent));
  await p.screenshot({path:`/tmp/navi_car_${W}.png`});
  // zoom out, north up
  await p.evaluate(()=>{ __NaviMap.zoom(1); });
  await p.waitForTimeout(1500); await p.screenshot({path:`/tmp/navi_car_z2_${W}.png`});
  // drive a bit: teleport to 東山 route / other place
  await p.evaluate(()=>{ const C=__Car.C; C.x=2200; C.z=-300; C.yaw=1.2; });
  await p.waitForTimeout(2500); await p.screenshot({path:`/tmp/navi_car_b_${W}.png`});
  // heli
  await p.evaluate(()=>{ document.getElementById('car-menu').click(); });
  await p.waitForTimeout(1500);
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(6000);
  console.log('heli navi on', await p.evaluate(()=>__NaviMap.on), await p.evaluate(()=>document.getElementById('navi-ll').textContent+' | '+document.getElementById('navi-rd').textContent));
  await p.screenshot({path:`/tmp/navi_heli_${W}.png`});
  await p.evaluate(()=>{ __NaviMap.zoom(1); });
  await p.waitForTimeout(2000); await p.screenshot({path:`/tmp/navi_heli_z_${W}.png`});
  const tt = await p.evaluate(()=>{ const t=performance.now(); for(let i=0;i<3;i++){ __NaviMap.zoom(0); } return 0; });
  await b.close();
})();
