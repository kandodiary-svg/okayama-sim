const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-precise-memory-info']});
  const p = await b.newPage({viewport:{width:900,height:560}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="jr"]').click(); [...document.querySelectorAll('#jr-routes .route-opt')][0].click(); [...document.querySelectorAll('#jr-vehs .veh-opt')][0].click(); document.getElementById('start').click(); });
  await p.waitForTimeout(3000);
  // 1) 物理のみ: 自動運転で全線
  const r = await p.evaluate(()=>{
    const S=__S; S.doorOpen=false; document.getElementById('door').textContent='閉';
    let t=0, vmax=0, maxAcc=0, minAcc=0, stops=[], lastNext=S.nextStop;
    const T0=performance.now();
    for(let i=0;i<20*3600 && S.pos<S.total-300 && S.running;i++){
      const lim=(__limitAt? __limitAt(S.pos):300);
      const sp=S.speed;
      // 目標: 制限-8、先の停止点までのブレーキ曲線
      let tgt=Math.min(300, lim-5);
      let nxt=S.stops.find(s=>s.arc>S.pos+5); if(nxt){ const d=nxt.arc-S.pos; tgt=Math.min(tgt, Math.sqrt(2*0.5*Math.max(d-30,0))*3.6+5); }
      if(sp<tgt-4) __setNotch(13); else if(sp>tgt+3) __setNotch(-Math.min(7,1+Math.floor((sp-tgt)/6))); else __setNotch(0);
      if(nxt && nxt.arc-S.pos<3 && sp<1){ stops.push([nxt.name,+(S.pos-nxt.arc).toFixed(1),+t.toFixed(0)]); S.pos+=4; }
      __sim(0.05); __tick(0.05); t+=0.05; vmax=Math.max(vmax,S.speed); maxAcc=Math.max(maxAcc,S.acc); minAcc=Math.min(minAcc,S.acc);
    }
    return {t:+t.toFixed(0), pos:Math.round(S.pos), vmax:Math.round(vmax), maxAcc:+maxAcc.toFixed(2), minAcc:+minAcc.toFixed(2), stops, wall:Math.round(performance.now()-T0), heap:Math.round(performance.memory.usedJSHeapSize/1e6)};
  });
  console.log(JSON.stringify(r));
  // 2) テレポート: 描画込みでメモリ・タイル
  for(let pos=2000;pos<113000;pos+=7000){
    await p.evaluate((pos)=>{ const S=__S; S.pos=pos; S.speed=0; S.view="cab"; }, pos);
    for(let k=0;k<3;k++){ await p.evaluate(()=>{ __sim(0.05); __tick(0.05); }); await p.waitForTimeout(400); }
    const st=await p.evaluate(()=>({outer:[...__Outer.live.values()].filter(Boolean).length, heap:Math.round(performance.memory.usedJSHeapSize/1e6), cam:Math.round(__cam.position.y)}));
    console.log(pos, JSON.stringify(st));
  }
  await b.close();
})();
