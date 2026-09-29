// WebGL のコンテキストが失われて戻った時に、画面が戻るか（ヘリで同じ視点を撮る）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:900,height:560}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  p.on('console', m => { if(m.type()==='error'||/context/i.test(m.text())) console.log('CON', m.text().slice(0,160)); });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ __Env.set("noon", false); document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(8000);
  const O = process.env.OUT || '/tmp/claude-0/ctx';
  await p.screenshot({path:O+'_before.png'});
  await p.evaluate(()=>{ const gl=document.querySelector('canvas').getContext('webgl2')||document.querySelector('canvas').getContext('webgl'); window.__lc=gl.getExtension('WEBGL_lose_context'); __lc.loseContext(); });
  await p.waitForTimeout(3000);
  await p.evaluate(()=>{ __lc.restoreContext(); });
  await p.waitForTimeout(10000);
  await p.screenshot({path:O+'_after.png'});
  await b.close();
})();
