const { chromium } = require('playwright');
(async () => {
  const W=Number(process.env.W||1280), H=Number(process.env.HT||720);
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
  const p = await b.newPage({viewport:{width:W,height:H}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { if(m.type()==='error') console.log('CON', m.text().slice(0,200)); });
  await p.addInitScript(() => {
    const orig = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(dest, ...r){
      const ctx = this.context;
      if (dest === ctx.destination && !ctx.__an) { ctx.__an = ctx.createAnalyser(); ctx.__an.fftSize = 4096; ctx.__an.smoothingTimeConstant = 0; window.__ctx = ctx; orig.call(this, ctx.__an); }
      else if (dest === ctx.destination && ctx.__an) { orig.call(this, ctx.__an); }
      return orig.call(this, dest, ...r);
    };
  });
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
  const meas = async (label, vk, inside) => {
    await p.evaluate(([vk,inside])=>{ const S=__S; S.doorOpen=false; S.view=inside?'cab':'chase'; window.__fixv=vk; }, [vk,inside]);
    for (let i=0;i<30;i++){ await p.evaluate(()=>{ __S.speed=window.__fixv; __tick(0.05); }); await p.waitForTimeout(100); }
    const r = await p.evaluate(()=>{ const an=window.__ctx.__an; const N=an.fftSize; const a=new Float32Array(N); an.getFloatTimeDomainData(a); let s=0,pk=0; for(const x of a){ s+=x*x; pk=Math.max(pk,Math.abs(x)); }
      const f=new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f); const sr=window.__ctx.sampleRate, bw=sr/N; const band=(lo,hi)=>{ let e=0,n=0; for(let i=Math.floor(lo/bw);i<Math.floor(hi/bw);i++){ e+=Math.pow(10,f[i]/10); n++; } return +(10*Math.log10(e/Math.max(n,1)+1e-20)).toFixed(1); };
      return {rms:+Math.sqrt(s/N).toFixed(4), peak:+pk.toFixed(3), b: {'<100':band(20,100),'100-300':band(100,300),'300-1k':band(300,1000),'1k-3k':band(1000,3000),'3k-8k':band(3000,8000)}}; });
    console.log(label, vk, JSON.stringify(r));
  };
  for (const v of [0, 30, 100, 200, 285]) await meas('cab', v, true);
  await meas('out', 200, false);
  await b.close();
})();
