// 山陽道の画面確認: SHOTS = [[chainId, sampleIndex, uOffset, camHeight, back, lookAhead], ...]（uOffset: 右が+）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:Number(process.env.W||1100),height:Number(process.env.HT||650)}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|'))); p.on('console', m => { const t=m.text(); if(m.type()==='error'||/mw/.test(t)) console.log('CON', t.slice(0,200)); });
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  if (process.env.PRE) await p.evaluate(process.env.PRE);
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  const shots = JSON.parse(process.env.SHOTS); let i=0;
  for (const sh of shots) {
    const [ci, idx, u, hh, back, ahead] = sh;
    const cam = await p.evaluate(([ci,idx,u,hh,back,ahead])=>{ const MW=__MW; const c=MW.chains.find(q=>q.id===ci); const f=(k)=>MW.fracPoint(c,k); const a=f(idx-back/c.ds), l=f(idx+ahead/c.ds);
      const pa=[a.x+a.rx*u, a.y+(0.015-a.e)*u+hh, a.z+a.rz*u], pl=[l.x+l.rx*u, l.y+(0.015-l.e)*u+hh*0.55, l.z+l.rz*u]; return [pa[0],pa[1],pa[2],pl[0],pl[1],pl[2]]; }, sh);
    await p.evaluate(([px,py,pz,lx,ly,lz])=>{ const H=__Heli.H; Object.assign(H,{x:lx,z:lz,y:200,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, cam);
    for (let k=0;k<Number(process.env.WAIT||30);k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    if (process.env.EVAL) console.log(await p.evaluate(process.env.EVAL));
    console.log('shot', i, JSON.stringify(cam.map(v=>Math.round(v))), await p.evaluate(()=>({outer:[...__Outer.live.values()].filter(Boolean).length, mw:__MW.live.size})));
    await p.screenshot({path:`${process.env.OUT||'/tmp/mw'}${i++}.png`, timeout:240000});
  }
  await b.close();
})();
