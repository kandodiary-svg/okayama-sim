const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|'))); p.on('console', m => { const t=m.text(); if(/hi |Error|error|tile/.test(t)) console.log('CON', t.slice(0,160)); });
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  if (process.env.PRE) await p.evaluate(process.env.PRE);
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  const shots = JSON.parse(process.env.SHOTS);
  let i=0;
  for (let sh of shots) {
    if (sh[0]==='car') { sh = await p.evaluate(([_,back,side])=>{ const cs=__Traffic.cars.filter(c=>c.type&&c.v>2); const c=cs[Math.floor(Math.random()*cs.length)]; if(!c) return [0,20,0,10,0,10];
       return [c.x-c.dx*back+(-c.dz)*side, c.y+2.2, c.z-c.dz*back+c.dx*side, c.x+c.dx*10, c.y+1.0, c.z+c.dz*10]; }, sh); }
    else if (sh.length===2) { sh = await p.evaluate(([k,back])=>{ const P=__Peds; const L=P.peds.filter(o=>o.on&&P.E[o.e].k===k&&o.v>0.5); const o=L[Math.floor(L.length/2)]; if(!o) return [0,20,0,10,0,10]; const y=__Car.hAt(o.x,o.z);
       return [o.x-o.fx*back+(-o.fz)*1.5, y+1.7, o.z-o.fz*back+o.fx*1.5, o.x+o.fx*8, y+1.2, o.z+o.fz*8]; }, sh); }
    const [px,py,pz,lx,ly,lz]=sh;
    await p.evaluate(([px,py,pz,lx,ly,lz])=>{ const H=__Heli.H; Object.assign(H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, [px,py,pz,lx,ly,lz]);
    for (let k=0;k<Number(process.env.WAIT||36);k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    if (process.env.EVAL) console.log(await p.evaluate(process.env.EVAL));
    await p.screenshot({path:`${process.env.OUT||'/tmp/cam'}${i++}.png`, timeout:240000});
  }
  await b.close();
})();
