const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1200,height:760}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>document.querySelector('.mode-opt[data-mode="bus"]').click());
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(1500);
  const r = await p.evaluate(()=>{
    const B=__Bus, C=__Car.C, D=B.data, P=__busP(); const log=[];
    B.doorKey(); log.push('close: '+document.getElementById('bus-msg').textContent);
    // 経路に沿って運ぶ（車の物理は使わず、位置だけ）→ 各停留所で前扉を標柱に合わせて停車
    for(let i=1;i<D.stops.length;i++){
      const s=D.stops[i];
      // 前扉(先頭から0.65m後ろ)が標柱の真横に来るよう: 車体中心 = 標柱の経路位置 + 0.65 - 5.25 + ... 
      const a = s.arc - (5.25-0.65) ;
      for(let k=0;k<30;k++){ const q=__pathPt(P, a - 30 + k); C.x=q.x; C.z=q.z; const t=__pathTan(P,a-30+k); C.yaw=Math.atan2(t.x,t.z); C.v=8; __S.t+=0.1; __sim(0.1); B.tick(0.1, __S.t); }
      const q=__pathPt(P,a), t=__pathTan(P,a); C.x=q.x; C.z=q.z; C.yaw=Math.atan2(t.x,t.z); C.v=0; B.tick(0.05,__S.t);
      const z=document.getElementById('bus-zone').textContent;
      B.doorKey(); const m1=document.getElementById('bus-msg').textContent;
      B.st.dwell=99; B.tick(0.05,__S.t);
      B.doorKey(); 
      log.push(i+' '+s.name+' | '+z+' | '+m1.slice(0,60)+' | score '+Math.round(B.st.score)+' pax '+B.st.pax);
    }
    return log; });
  for(const l of r) console.log(l);
  await p.waitForTimeout(9000);
  console.log('finish on:', await p.evaluate(()=>document.getElementById('finish-overlay').classList.contains('on')), await p.evaluate(()=>document.getElementById('finish-text').textContent));
  await b.close();
})();
