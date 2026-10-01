const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:800,height:500}}); p.setDefaultTimeout(1200000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8806/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>document.querySelector('.mode-opt[data-mode="car"]').click());
  await p.evaluate(()=>document.getElementById('start').click());
  await p.waitForTimeout(1500);
  const SEC = Number(process.env.SEC||240);
  const r = await p.evaluate((SEC)=>{
    const T=__Traffic, segs=T.segs, P=__Peds, E=P.E; const C=__Car.C;
    const cv={viol:[], pass:0}, pv={spawnRed:0, redLong:[], onXwalk:0, n:0};
    const prev=new Map(); const enter=new Map();
    for(let i=0;i<SEC*20;i++){ __S.t+=0.05; __sim(0.05); const t=__S.t;
      for(const c of T.cars){ if(!c.type) continue; const seg=segs[c.plan[0]]; const hl=c.type.l/2;
        const key=c.id; const pr=prev.get(key);
        // 停止線(q.sig.s)を前端が通過した瞬間
        for(let k=0;k<Math.min(2,c.plan.length);k++){ const q=segs[c.plan[k]]; if(!(q.lane&&q.sig)) continue; const d=(k===0?-c.s:segs[c.plan[0]].P.len-c.s)+q.sig.s-hl;
          const tag=q.i+':'+q.sig.g;
          if(pr && pr.tag===tag && pr.d>0 && d<=0){ cv.pass++; }
          if(pr && pr.tag===tag && pr.d>0 && d<=0){ const stt=window.__phase(q.sig.g,q.sig.ph,t), st1=window.__phase(q.sig.g,q.sig.ph,t-1.5); if(stt===2 && st1===2) cv.viol.push([Math.round(c.x),Math.round(c.z),t.toFixed(0),c.ghost>0?'ghost':'',c.passedG===q.sig.g?'passedG':'',c.id, c.v.toFixed(1), pr.d.toFixed(1), q.lane?'':'?', c.plan.length]); }
          prev.set(key,{tag,d}); break; }
      }
      for(const o of P.peds){ if(!o.on||o.x===undefined) continue; const e=E[o.e]; pv.n++;
        if(e.k===1 && e.g>=0){ const st=P.pedState(e.g,e.ph,t); if(st===2){ const en=enter.get(o.id); if(en===undefined) enter.set(o.id,t); else if(t-en>14 && o.v>0.3) { pv.redLong.push([Math.round(o.x),Math.round(o.z),o.id]); enter.set(o.id,t+1e9); } } else enter.delete(o.id); }
        else enter.delete(o.id); }
    }
    return {cars:T.cars.filter(c=>c.type).length, pass:cv.pass, viol:cv.viol.length, violSample:cv.viol.slice(0,15), pedRedLong:new Set(pv.redLong.map(a=>a[2])).size, pedSample:pv.redLong.slice(0,8)};
  }, SEC);
  console.log(JSON.stringify(r));
  await b.close();
})();
