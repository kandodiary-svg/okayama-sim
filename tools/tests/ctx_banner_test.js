// v41.13 描画が止まった時の案内（バナー）が出て、戻ると消え、画面も戻るか
const { chromium } = require('playwright'); const fs=require('fs');
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p=await b.newPage({viewport:{width:900,height:560}}); p.setDefaultTimeout(900000);
  const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,120)));
  await p.goto('http://localhost:8811/index.html');
  await p.waitForFunction(()=>!document.getElementById('start').disabled,null,{timeout:600000});
  await p.evaluate(()=>{ __Env.set('noon',false); document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(6000);
  const vis=()=>p.evaluate(()=>{ const b=document.getElementById('boot-err'); return {shown:!b.hidden, msg:document.getElementById('boot-err-msg').textContent.slice(0,30), btn:!document.getElementById('boot-retry').hidden}; });
  const O=process.env.OUT;
  console.log('before', JSON.stringify(await vis())); await p.screenshot({path:O+'_before.png'});
  await p.evaluate(()=>{ const gl=document.querySelector('canvas').getContext('webgl2')||document.querySelector('canvas').getContext('webgl'); window.__lc=gl.getExtension('WEBGL_lose_context'); __lc.loseContext(); });
  await p.waitForTimeout(2500); console.log('lost  ', JSON.stringify(await vis())); await p.screenshot({path:O+'_lost.png'});
  await p.evaluate(()=>{ __lc.restoreContext(); }); await p.waitForTimeout(9000);
  console.log('after ', JSON.stringify(await vis())); await p.screenshot({path:O+'_after.png'});
  console.log('pageerrors', errs.length, errs.slice(0,3)); await b.close(); })();
