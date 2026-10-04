// 街の任意の地点を、ヘリモードのカメラ固定機能（__camfix）で撮影する。
// 使い方: SHOTS='[[px,pz,eyeH,lx,lz,lookH],...]' node cityshot.js   （x 東・z 南・m。高さは地面からの m）
//   PREFIX=/tmp/city  WAIT=20  EVAL='式'（撮影ごとに評価して表示）  MODE=heli|car
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:Number(process.env.W||1100),height:Number(process.env.H||700)}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { const t=m.text(); if(/^ERR|Error|error/.test(t) && !/favicon/.test(t)) console.log('CON', t.slice(0,200)); });
  await p.goto(process.env.URL||'http://localhost:8805/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:900000});
  if (process.env.PRE) await p.evaluate(process.env.PRE);
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2500);
  const shots = JSON.parse(process.env.SHOTS);
  const prefix = process.env.PREFIX || '/tmp/city';
  let i = 0;
  for (const sh of shots) {
    const [px,pz,eh,lx,lz,lh] = sh;
    const r = await p.evaluate(([px,pz,eh,lx,lz,lh])=>{
      const gy=(x,z)=>__Car.hAt(x,z); const H=__Heli.H;
      Object.assign(H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0});
      window.__camfix={pos:[px,gy(px,pz)+eh,pz],look:[lx,gy(lx,lz)+lh,lz]};
      return [gy(px,pz),gy(lx,lz)];
    }, [px,pz,eh,lx,lz,lh]);
    for (let k=0;k<Number(process.env.WAIT||24);k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    if (process.env.EVAL) console.log(await p.evaluate(process.env.EVAL));
    await p.screenshot({path:`${prefix}${i}.png`});
    console.log('shot', i, sh.join(','), 'ground', r.map(v=>+v.toFixed(2)).join('/'));
    i++;
  }
  await b.close();
})();
