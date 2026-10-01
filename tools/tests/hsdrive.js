const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1200,height:760}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const info = await p.evaluate(([ri])=>{
    document.querySelector('.mode-opt[data-mode="jr"]').click();
    const rs=[...document.querySelectorAll('#jr-routes .route-opt')]; const names=rs.map(x=>x.textContent.replace(/\s+/g,' ').slice(0,60));
    rs[ri].click(); const vs=[...document.querySelectorAll('#jr-vehs .veh-opt')]; vs[0].click();
    return {names, veh:vs[0].textContent};
  }, [Number(process.env.RI||0)]);
  console.log(JSON.stringify(info));
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(3000);
  const res = await p.evaluate(()=>{
    const S=__S, out=[]; const V=__VEHICLES[S.vehicle];
    out.push({veh:V.name, np:V.np, nb:V.nb, total:Math.round(S.total), stops:S.stops.map(s=>s.name+'@'+Math.round(s.arc)), notchbar:document.getElementById('notch-bar').children.length});
    S.doorOpen=false; document.getElementById('door').textContent='閉';
    const marks={}; let t=0;
    // ATC 試験: 発車直後（指示速度 125km/h）に 200km/h で走っている状態から惰行
    S.speed=200; __setNotch(0); let rel=null, trig=null, minAllow=999;
    for(let i=0;i<20*120 && S.running;i++){ __sim(0.05); __tick(0.05); t+=0.05; if(S.atc && !trig) trig=[+t.toFixed(1), Math.round(S.speed), Math.round(S.atcAllow)]; if(trig && !S.atc && !rel){ rel=[+t.toFixed(1), Math.round(S.speed), Math.round(S.atcAllow)]; break; } }
    out.push({atc:{trig, rel, sub:document.getElementById('subtitle').textContent.slice(0,80)}});
    // ブレーキ試験（B1〜B7 と 非常）: 200km/h から停止まで
    for(const n of [2,4,7]){ S.speed=150; S.acc=0; S.atc=false; S.pos=9000; __setNotch(0); __setNotch(-n); let tt=0, p0=S.pos, peak=0;
      for(let i=0;i<20*300 && S.speed>0.2;i++){ __sim(0.05); __tick(0.05); tt+=0.05; peak=Math.min(peak,S.acc); }
      out.push({['B'+n]:{sec:+tt.toFixed(0), dist:Math.round(S.pos-p0), peakDec:+peak.toFixed(2)}}); __setNotch(0); }
    S.speed=150; S.acc=0; S.pos=9000; __applyHandles(); S.mc=0; S.bv=8; __applyHandles(); { let tt=0, p0=S.pos, peak=0; for(let i=0;i<20*300 && S.speed>0.2;i++){ __sim(0.05); __tick(0.05); tt+=0.05; peak=Math.min(peak,S.acc); } out.push({EB:{sec:+tt.toFixed(0), dist:Math.round(S.pos-p0), peakDec:+peak.toFixed(2), notch:S.notch, emerg:S.emergency}}); }
    return out;
  });
  for(const r of res) console.log(JSON.stringify(r));
  await b.close();
})();
