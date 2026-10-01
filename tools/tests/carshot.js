// 車モードの画面確認: SHOTS=[[chainId, idx, time, rain, wait]]
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:Number(process.env.W||1000),height:Number(process.env.HT||600)}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  if(process.env.CITY) await p.evaluate(()=>{window.__CITY=1;});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); if(!window.__CITY) document.querySelector('.cstart-opt[data-cs="mw"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500);
  let i=0;
  for (const [ci, idx, time, rain, wait, view] of JSON.parse(process.env.SHOTS)) {
    await p.evaluate(([ci,idx,time,rain,view])=>{ if(window.__CITY){ __Env.set(time,!!rain); return; } const MW=__MW, c=MW.chains.find(q=>q.id===ci), C=__Car.C, N=c.sec.N, U=-c.sec.lw*(N-1)/2, pt=MW.P(c,idx,U,0);
      C.x=pt[0]; C.z=pt[2]; C.h=pt[1]; C.yaw=Math.atan2(c.tx[idx],c.tz[idx]); C.v=0; C.hitT=0; __Env.set(time, !!rain); if(view) __S.view=view; MW.tick({x:C.x,z:C.z},true); __Outer.tick({x:C.x,z:C.z,y:C.h},true); }, [ci,idx,time,rain,view]);
    await p.waitForTimeout((wait||6)*1000);
    console.log('shot', i, await p.evaluate(()=>({outer:[...__Outer.live.values()].filter(Boolean).length, mw:__MW.live.size, h:+__Car.C.h.toFixed(1)})));
    await p.screenshot({path:`${process.env.OUT||'/tmp/cs'}${i++}.png`, timeout:240000});
  }
  await b.close();
})();
