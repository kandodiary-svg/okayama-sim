// ダイヤ運行の試験: 自動運転（簡易）で東山線／清輝橋線を走り、定時点・各停留所の遅れを表示する。
// 使い方: ROUTE=higashi|seiki  FAC=0.85（制限速度の何割で走るか）  HOLD=1（定刻まで発車を待つ）  node tram_dia.js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1000,height:620}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message, (e.stack||'').split('\n').slice(1,3).join('|')));
  p.on('console', m => { if(m.type()==='error' && !/favicon|404/.test(m.text())) console.log('CON', m.text().slice(0,200)); });
  await p.goto(process.env.URL||'http://localhost:8805/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const route = process.env.ROUTE||'higashi';
  await p.evaluate((route)=>{ const r=document.querySelector('.route-opt[data-key="'+route+'"]'); if(r) r.click(); document.getElementById('start').click(); }, route);
  await p.waitForTimeout(2500);
  const res = await p.evaluate(async ([FAC,HOLD,MAXT])=>{
    const S=__S, log=[]; const dt=0.05; let step=0, doorT=0, state='dwell';
    const t0=S.clock;
    const sub=()=>document.getElementById('subtitle').textContent;
    const dia=()=>({row:document.getElementById('diarow').style.display, t:document.getElementById('dia-t').textContent, d:document.getElementById('dia-d').textContent});
    log.push(['start', dia(), Math.round(S.clock)]);
    let lastStop=S.stopIndex, closeAt=null;
    while(S.running && (S.clock-t0)<MAXT){
      __sim(dt); __tick(dt); step++;
      const ds=S.cum[S.stopIndex]-S.pos, lim=__limitAt(S.pos)*FAC;
      if(S.doorOpen){
        // 乗降: 定刻（HOLD）まで、または 10 秒待ってから閉める
        doorT+=dt;
        const a=(S._openedAt===S.stopIndex?S.stopIndex:S.stopIndex-1);
        const sc=__Dia&&__Dia.D.sc&&__Dia.D.sc[a];
        const ready = HOLD && sc ? (S.clock>=sc.dep) : doorT>10;
        if(doorT>3 && ready && S.running){ __doorAction(); doorT=0; }
        continue;
      }
      doorT=0;
      // 目標速度: 制限速度、次の停留所へのブレーキ曲線、赤信号の停止線
      let tgt=lim; const a=0.85;
      const dst=Math.max(0, ds-0.8); tgt=Math.min(tgt, Math.sqrt(2*a*dst)*3.6);
      const sg=S.signals[S.sigIndex];
      if(sg){ const d=sg.stop-S.pos; let red=false; try{ red = sg.block!=null ? !__Trams.blockFree(sg.block, __Trams.PLAYER) : (sg.g==null?false: __phase(sg.g, sg.ph, S.t)!==0); }catch(e){} if(red && d>-3) tgt=Math.min(tgt, Math.sqrt(2*a*Math.max(0,d-3))*3.6); }
      const e=tgt-S.speed;
      if(e>4) __setNotch(3); else if(e>1.5) __setNotch(2); else if(e>0.3) __setNotch(1); else if(e>-2) __setNotch(0); else if(e>-6) __setNotch(-2); else __setNotch(-3);
      if(ds<0.9 && S.speed<0.4){ __setNotch(-3); if(!S.doorOpen){ __doorAction(); } }
      if(S.stopIndex!==lastStop){ lastStop=S.stopIndex; }
      if(step%2400===0) log.push(['t',Math.round(S.clock-t0),'pos',Math.round(S.pos),'v',Math.round(S.speed),'stop',S.stopIndex, dia().d]);
    }
    const ft=document.getElementById('finish-text').textContent;
    const R=__Dia&&__Dia.result();
    return {log, clock:Math.round(S.clock-t0), finished:!S.running, finish:ft, dia:R, rec:__Dia&&__Dia.D.rec, early:__Dia&&__Dia.D.early, score:Math.round(S.score), sc:__Dia&&__Dia.D.sc&&__Dia.D.sc.map(x=>[x.arr&&Math.round(x.arr-t0), Math.round(x.dep-t0)])};
  }, [Number(process.env.FAC||0.85), process.env.HOLD!=='0', Number(process.env.MAXT||1800)]);
  console.log(JSON.stringify(res,null,1));
  await p.screenshot({path:'/tmp/tramdia.png'});
  await b.close();
})();
