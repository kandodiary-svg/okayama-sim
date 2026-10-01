const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1200,height:760}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  p.on('console', m => { const t=m.text(); if(m.type()==='error' || /outer|jr lines|GeoMem/.test(t)) console.log('CON', t.slice(0,200)); });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const names = await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="jr"]').click(); return [...document.querySelectorAll('#jr-routes .route-opt')].map((x,i)=>i+':'+x.textContent.replace(/\s+/g,' ').slice(0,90)); });
  console.log(names.join('\n'));
  const ri = Number(process.env.RI||0);
  await p.evaluate((ri)=>{ const rs=[...document.querySelectorAll('#jr-routes .route-opt')]; rs[ri].click(); [...document.querySelectorAll('#jr-vehs .veh-opt')][0].click(); document.getElementById('start').click(); }, ri);
  await p.waitForTimeout(3000);
  const info = await p.evaluate(()=>{ const S=__S; return {route:S.route.name, total:Math.round(S.total), stops:S.stops.map(s=>s.name+'@'+Math.round(s.arc)), pos:Math.round(S.pos)}; });
  console.log(JSON.stringify(info));
  const poss = JSON.parse(process.env.POS||'[]');
  let i=0;
  for (const pos of poss) {
    await p.evaluate((pos)=>{ const S=__S; S.pos=pos; S.speed=0; S.doorOpen=false; S.view="cab"; document.getElementById('ui').classList.add('cab'); }, pos);
    for(let k=0;k<Number(process.env.WAIT||14);k++){ await p.evaluate(()=>{ __sim(0.05); __tick(0.05); }); await p.waitForTimeout(500); }
    const st = await p.evaluate(()=>{ const c=__cam.position; return {cam:[Math.round(c.x),Math.round(c.y),Math.round(c.z)], outer: [...__Outer.live.values()].filter(Boolean).length, ready: __Outer.ready}; });
    console.log(pos, JSON.stringify(st));
    await p.screenshot({path:`${process.env.OUT||'/tmp/hsf'}${i++}.png`, timeout:300000});
  }
  await b.close();
})();
