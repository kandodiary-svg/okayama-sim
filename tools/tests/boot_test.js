// v41.13 起動の試験（URL=… SC=normal|cdn_slow|cdn_block|vendor_missing|both_missing|once=ファイル|always=ファイル DELAY=ms）: 各シナリオで 最初の描画の時刻 / 開始ボタンが有効になるまで / エラー表示 / 要求された外部URL を見る
const { chromium } = require('playwright'); const fs=require('fs');
const SC=process.env.SC||'normal', URL=process.env.URL||'http://localhost:8811/index.html', DELAY=Number(process.env.DELAY||0), WAIT=Number(process.env.WAIT||150000);
const THREE_SRC=fs.readFileSync(require('path').join(__dirname,'../../vendor/three.r128.min.js'),'utf8');
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const ctx=await b.newContext({viewport:{width:1100,height:700}}); const p=await ctx.newPage();
  const bad=[], ext=[], logs=[]; let hits={};
  p.on('response',r=>{ if(r.status()>=400) bad.push(r.status()+' '+r.url().slice(-50)); });
  p.on('console',m=>{ const t=m.type(); if(t==='error'||t==='warning') logs.push(t+': '+m.text().slice(0,140)); });
  p.on('pageerror',e=>logs.push('PAGEERROR '+String(e).slice(0,160)));
  p.on('request',r=>{ if(!r.url().startsWith('http://localhost')) ext.push(r.url().slice(0,70)); });
  // CDN: 既定は実物（three.js）を返す。cdn_block は遮断、cdn_slow は遅延
  await p.route('**/cdnjs.cloudflare.com/**', async route=>{
    if(SC.includes('cdn_block')||SC.includes('both_missing')) return route.abort('failed');
    if(SC.includes('cdn_slow')) await new Promise(r=>setTimeout(r,DELAY));
    route.fulfill({status:200,contentType:'application/javascript',body:THREE_SRC}); });
  if(SC.includes('vendor_missing')||SC.includes('both_missing')) await p.route('**/vendor/three.r128.min.js', route=>route.fulfill({status:404,body:'nf'}));
  const m=SC.match(/once=([\w.]+)/); if(m){ let n=0; await p.route('**/data/'+m[1], route=>{ if(n++<1) return route.abort('connectionreset'); route.continue(); }); }
  const m2=SC.match(/always=([\w.]+)/); if(m2){ await p.route('**/data/'+m2[1], route=>route.fulfill({status:503,body:'busy'})); }
  const t0=Date.now();
  await p.goto(URL,{waitUntil:'commit'});
  let state=null, tStart=null;
  const dl=Date.now()+WAIT;
  while(Date.now()<dl){
    await new Promise(r=>setTimeout(r,500));
    try{ state=await p.evaluate(()=>({ready:document.readyState, start:(document.getElementById('start')||{}).disabled, label:(document.getElementById('start-label')||{}).textContent, err:(document.getElementById('boot-err')&&!document.getElementById('boot-err').hidden)?document.getElementById('boot-err-msg').textContent:null, retryBtn:(document.getElementById('boot-retry')&&!document.getElementById('boot-retry').hidden), three:typeof THREE})); }catch(e){ continue; }
    if(state.start===false){ tStart=Date.now()-t0; break; }
    if(state.err && !/自動で/.test(state.err)){ break; }
  }
  const paint=await p.evaluate(()=>performance.getEntriesByType('paint').map(e=>e.name+':'+Math.round(e.startTime))).catch(()=>null);
  console.log(JSON.stringify({SC,DELAY,paint,startEnabledMs:tStart,state,ext:[...new Set(ext)],bad,logs:logs.slice(0,8)},null,0));
  if(process.env.SHOT) await p.screenshot({path:process.env.SHOT});
  await b.close();
})();
