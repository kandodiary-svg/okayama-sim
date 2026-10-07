// 車のガラスの雨（水滴・ワイパー）だけを映す軽い確認。使い方: BASE=http://localhost:PORT/tools/tests/glass_rain.html node glass_rain_shot.js "v=sedan" /tmp/g "0.5,1.5,3.0"  （v=sedan|truckP|busP, rain=0 で晴れ。数字は雨が降り始めてからの秒）
const { chromium } = require('playwright');
(async()=>{
  const [q,out,tms]=[process.argv[2]||'',process.argv[3]||'/tmp/g',(process.argv[4]||'2.5').split(',')];
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p=await b.newPage({viewport:{width:1100,height:700}});
  p.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') console.log('C:',m.text().slice(0,400)); });
  p.on('pageerror',e=>console.log('PE:',e.message));
  await p.goto(''+(process.env.BASE||'http://localhost:8811/tools/tests/glass_rain.html')+'?'+q); await p.waitForFunction(()=>window.ready,null,{timeout:60000});
  for(const t of tms){ await p.evaluate(t=>window.render(+t),t); await p.screenshot({path:out+'_'+t+'.png'}); console.log('shot',t); }
  await b.close();
})();
