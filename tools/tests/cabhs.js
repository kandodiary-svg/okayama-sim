const { chromium } = require('playwright');
(async () => {
  const W=Number(process.env.W||1280), H=Number(process.env.HT||720);
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:W,height:H}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="jr"]').click(); [...document.querySelectorAll('#jr-routes .route-opt')][0].click(); [...document.querySelectorAll('#jr-vehs .veh-opt')][0].click(); document.getElementById('start').click(); });
  await p.waitForTimeout(4000);
  console.log(await p.evaluate(()=>JSON.stringify({view:__S.view,mode:__S.mode,run:__S.running})));
  const states = JSON.parse(process.env.STATES||'[{"name":"stop"},{"name":"p8","mc":8,"speed":180,"pos":4000},{"name":"b3","bv":3,"speed":120,"pos":4000},{"name":"eb","bv":8,"speed":60,"pos":4000}]');
  for(const st of states){
    await p.evaluate((st)=>{ const S=__S; S.view='cab'; document.getElementById('ui').classList.add('cab'); S.doorOpen=false; document.getElementById('door').textContent='閉';
      if(st.pos) S.pos=st.pos; if(st.speed!=null) S.speed=st.speed;
      S.mc=st.mc||0; S.bv=st.bv||0; __applyHandles(); }, st);
    await p.waitForTimeout(2500);
    await p.screenshot({path:`/tmp/cabhs_${W}_${st.name}.png`});
    console.log('shot', st.name);
  }
  await b.close();
})();
