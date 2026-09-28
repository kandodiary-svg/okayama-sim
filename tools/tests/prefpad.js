const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const ctx = await b.newContext({viewport:{width:900,height:600}}); const p = await ctx.newPage();
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  await p.addInitScript(()=>{ window.__fakePad={connected:true,id:'fake',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({value:0,pressed:false}))}; navigator.getGamepads=()=>[window.__fakePad]; });
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  // 設定を変える
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="car"]').click(); document.querySelector('.time-opt[data-time="night"]').click(); document.querySelector('.look-opt[data-look="crisp"]').click(); document.querySelector('.route-opt[data-key="seiki"]').click(); });
  await p.waitForTimeout(300);
  console.log('saved', await p.evaluate(()=>localStorage.getItem('okaden.v1')));
  // 車: ゲームパッドで走る
  await p.evaluate(()=>document.getElementById('start').click()); await p.waitForTimeout(2500);
  const r1 = await p.evaluate(async ()=>{ const P=window.__fakePad; P.buttons[7].value=1; P.axes[0]=0.6; await new Promise(r=>setTimeout(r,2500)); const C=__Car.C; const o={v:C.v.toFixed(2), wheel:C.wheel.toFixed(2)}; P.buttons[7].value=0; P.axes[0]=0; P.buttons[6].value=1; await new Promise(r=>setTimeout(r,2000)); o.vAfterBrake=C.v.toFixed(2); P.buttons[6].value=0; return JSON.stringify(o); });
  console.log('car pad', r1);
  // メニューへ戻り、電車でマスコン
  await p.evaluate(()=>document.getElementById('car-menu').click()); await p.waitForTimeout(500);
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="tram"]').click(); document.getElementById('start').click(); }); await p.waitForTimeout(2500);
  const r2 = await p.evaluate(async ()=>{ const P=window.__fakePad; const press=async(i)=>{ P.buttons[i].value=1; await new Promise(r=>setTimeout(r,200)); P.buttons[i].value=0; await new Promise(r=>setTimeout(r,200)); };
    const bv0=__S.bv; await press(6); await press(6); const bv1=__S.bv; await press(0); const door=__S.doorOpen; await press(5); await press(5); return JSON.stringify({bv0,bv1,door,mc:__S.mc}); });
  console.log('tram pad', r2);
  // 再読み込みで設定が戻るか
  await p.reload(); await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  console.log('restored', await p.evaluate(()=>JSON.stringify({mode:document.querySelector('.mode-opt.on').dataset.mode, time:__Env.st.time, look:document.querySelector('.look-opt.on').dataset.look, route:__S.key, rec:document.getElementById('records').textContent})));
  await b.close();
})();
