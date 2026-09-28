const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:900,height:900}});
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html')); await p.waitForTimeout(3000);
  await p.evaluate(()=>document.getElementById('src-btn').click()); await p.waitForTimeout(500);
  await p.screenshot({path:'/tmp/src.png'}); await b.close();
})();
