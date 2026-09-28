const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { const t=m.text(); if(/jr|Error|error/.test(t)) console.log('CON', t.slice(0,200)); });
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500);
  // 列車を早く出す: 時間を進める
  const r = await p.evaluate(()=>{ for(let i=0;i<Number(1)*2400;i++) __JR.update(0.25, 0); return __JR.trains.map(T=>T.L.key+':'+T.mk+'x'+T.cars.length+' s='+T.s.toFixed(0)+'/'+T.L.len.toFixed(0)+' v='+T.v.toFixed(1)+' '+T.state).join(' | '); });
  console.log(r);
  if (process.env.PLACE) console.log(await p.evaluate(process.env.PLACE));
  const shots = JSON.parse(process.env.SHOTS); let i=0;
  for (const [px,py,pz,lx,ly,lz] of shots) {
    await p.evaluate(([px,py,pz,lx,ly,lz])=>{ const H=__Heli.H; Object.assign(H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, [px,py,pz,lx,ly,lz]);
    for (let k=0;k<24;k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    await p.screenshot({path:`/tmp/jr${i++}.png`});
  }
  await b.close();
})();
