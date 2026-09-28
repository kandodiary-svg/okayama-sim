const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}});
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,4).join('|')));
  p.on('console', m => console.log('CON', m.type(), m.text().slice(0,200)));
  p.on('requestfailed', r => console.log('REQFAIL', r.url())); p.on('response', r => { if(r.status()>=400) console.log('HTTP', r.status(), r.url()); });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  for (let i=0;i<Number(process.env.T||12);i++){ await p.waitForTimeout(10000);
    console.log(i, await p.evaluate(()=>({dis:document.getElementById('start').disabled, lab:document.getElementById('start-label').textContent, op: window.__OrthoPages?__OrthoPages.loadedCount:null, gt: window.__GT?__GT.filter(t=>t.hi).length:null})));
    if(!(await p.evaluate(()=>document.getElementById('start').disabled))) break; }
  if (process.env.EVAL) console.log(await p.evaluate(process.env.EVAL));
  await b.close();
})();
