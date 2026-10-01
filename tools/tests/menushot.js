const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const W=Number(process.env.W||1280), H=Number(process.env.HT||720);
  const p = await b.newPage({viewport:{width:W,height:H}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  for (const m of (process.env.MODES||'tram,jr,car,heli').split(',')) {
    await p.evaluate((m)=>{ document.querySelector('.mode-opt[data-mode="'+m+'"]').click(); if(m==='car') document.querySelector('.cstart-opt[data-cs="mw"]').click(); }, m);
    await p.waitForTimeout(800);
    await p.screenshot({path:`/tmp/menu_${W}_${m}.png`});
    console.log('shot', m, JSON.stringify(await p.evaluate(()=>{const c=document.querySelector('.mcard').getBoundingClientRect(); const mm=document.querySelector('.mmain'); return {card:[c.width|0,c.height|0], mainScroll: mm.scrollHeight>mm.clientHeight}})));
  }
  await p.evaluate(()=>document.querySelector('.mdet summary').click()); await p.waitForTimeout(300); await p.screenshot({path:`/tmp/menu_${W}_det.png`});
  await b.close();
})();
