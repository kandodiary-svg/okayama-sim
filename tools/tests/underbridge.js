const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1000,height:620}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  // 橋の下（上の段がある升）にある路面の点を、走行格子から集める
  const spots = await p.evaluate(()=>{ const C=__Car, G=C.G; const out=[]; const n=G.UM.size; const keys=[...G.UM.keys()];
    const step=Math.floor(keys.length/400);
    for(let q=0;q<keys.length;q+=step){ const k=keys[q]; const u=G.UM.get(k); const i=k%G.nx, j=Math.floor(k/G.nx); const x=G.x0+(i+0.5)*G.step, z=G.z0+(j+0.5)*G.step;
      if(G.K[k]!==1) continue; const hl=G.H[k]/100, hu=G.UH[u]/100; if(hu-hl<3.5||hu-hl>9) continue; out.push([x,z,hl,hu]); }
    return out; });
  console.log('spots',spots.length);
  const want = JSON.parse(process.env.PICK||'[0,40,80,120,160,200,240,280]');
  let i=0;
  for (const w of want) { const s=spots[Math.min(w,spots.length-1)]; if(!s) continue; const [x,z,hl,hu]=s;
    // 近くの下の道の向き: 周りの道路升を探して一番長く続く向きを使う
    const dir = await p.evaluate(([x,z,hl])=>{ const C=__Car; let best=null,bs=-1; for(let a=0;a<16;a++){ const t=a*Math.PI/8; let s=0; for(let d=2;d<60;d+=2){ const px=x+Math.cos(t)*d,pz=z+Math.sin(t)*d; if(C.kindAt(px,pz,hl)!==1||Math.abs(C.hAt(px,pz,hl)-hl)>1.2) break; s=d; } if(s>bs){bs=s;best=t;} } return [Math.cos(best),Math.sin(best),bs]; },[x,z,hl]);
    const cam=[x-dir[0]*14, hl+3.2, z-dir[1]*14, x+dir[0]*20, hl+1.5, z+dir[1]*20];
    await p.evaluate(([px,py,pz,lx,ly,lz])=>{ const H=__Heli.H; Object.assign(H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, cam);
    for (let k=0;k<Number(process.env.WAIT||30);k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    console.log('shot',i,Math.round(x),Math.round(z),'low',hl.toFixed(1),'deck',hu.toFixed(1),'roadlen',dir[2]);
    await p.screenshot({path:`/tmp/ub${i++}.png`, timeout:240000});
  }
  await b.close();
})();
