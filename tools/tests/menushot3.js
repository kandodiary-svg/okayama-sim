const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1920,height:1080}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{document.querySelector('.mode-opt[data-mode="car"]').click(); document.querySelector('.cstart-opt[data-cs="mw"]').click();});
  await p.waitForTimeout(800); await p.screenshot({path:'/tmp/menu_1920_car.png'});
  await p.evaluate(()=>document.querySelectorAll('.mdet summary')[1].click()); await p.waitForTimeout(300); await p.screenshot({path:'/tmp/menu_1920_det.png'});
  await p.evaluate(()=>document.querySelectorAll('.mdet')[1].removeAttribute('open'));
  // functional: start car
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(15000);
  console.log('menu hidden', await p.evaluate(()=>getComputedStyle(document.getElementById('menu')).display+'/'+document.getElementById('menu').className));
  await p.screenshot({path:'/tmp/menu_1920_ingame.png'});
  await b.close();
})();
