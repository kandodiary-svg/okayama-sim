const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:800,height:500}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const out=[];
  const snap=(tag)=>p.evaluate((tag)=>({tag, mode:__S.mode, veh:__S.vehicle, key:__S.key, stops:__S.stops.length, carjr:!!(__S.car&&__S.car.userData.jr), jrplay:__JR.playing, run:__S.running, pos:Math.round(__S.pos)}), tag);
  // 1. JR
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="jr"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500); out.push(await snap('jr'));
  await p.evaluate(()=>{ for(let i=0;i<40;i++){ __sim(0.05); __tick(0.05);} });
  // 2. back to menu then tram
  await p.evaluate(()=>{ __S.running=false; document.getElementById('menu').style.display='flex'; document.querySelector('.mode-opt[data-mode="tram"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500); out.push(await snap('tram-after-jr'));
  await p.evaluate(()=>{ for(let i=0;i<40;i++){ __sim(0.05); __tick(0.05);} });
  // 3. car
  await p.evaluate(()=>{ __S.running=false; document.getElementById('menu').style.display='flex'; document.querySelector('.mode-opt[data-mode="car"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500); out.push(await snap('car'));
  // 4. JR again (other route), then tram
  await p.evaluate(()=>{ __S.running=false; document.getElementById('menu').style.display='flex'; document.querySelector('.mode-opt[data-mode="jr"]').click(); [...document.querySelectorAll('#jr-routes .route-opt')][6].click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500); out.push(await snap('jr2'));
  console.log(JSON.stringify(out,null,0));
  await b.close();
})();
