// 動くもの（車・人・電車・列車）を隠して、決めた視点の画面を撮る（版の違いで画面が同じか比べる用）。CTX=1 なら WebGL を一度失わせて戻した後も撮る
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--js-flags=--expose-gc','--enable-precise-memory-info']});
  const p = await b.newPage({viewport:{width:960,height:600}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  p.on('console', m => { const t=m.text(); if(m.type()==='error' || /GeoMem|Context/.test(t)) console.log('CON', t.slice(0,160)); });
  await p.addInitScript(()=>{ Math.random = (()=>{ let s=12345; return ()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x80000000; }; })(); });
  await p.goto(process.env.URL);
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ __Env.set("noon", false); document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  const shots = JSON.parse(process.env.SHOTS), O = process.env.OUT;
  const hide = ()=>p.evaluate(()=>{ __world.parent.traverse(o=>{ if(o.isInstancedMesh || o.isSprite || o.isPoints) o.visible=false; }); for(const g of (window.__hideGroups||[])) g.visible=false;
     __world.parent.children.forEach(o=>{ if(o.isGroup && o!==__world && !/jr|pwires/.test(o.name)) o.visible=false; }); });
  const shoot = async (tag)=>{ let i=0; for(const [px,py,pz,lx,ly,lz] of shots){
    await p.evaluate(([px,py,pz,lx,ly,lz])=>{ Object.assign(__Heli.H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, [px,py,pz,lx,ly,lz]);
    for(let k=0;k<Number(process.env.WAIT||60);k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
    await hide(); await p.waitForTimeout(1500);
    await p.screenshot({path:`${O}${tag}${i++}.png`}); } };
  await shoot('a');
  const mem = await p.evaluate(()=>{ gc(); return Math.round(performance.memory.usedJSHeapSize/1e6); }); console.log('heap MB after shots', mem);
  if(process.env.CTX){
    await p.evaluate(()=>{ const c=document.querySelector('canvas'); const gl=c.getContext('webgl2')||c.getContext('webgl'); window.__lc=gl.getExtension('WEBGL_lose_context'); __lc.loseContext(); });
    await p.waitForTimeout(3000); await p.evaluate(()=>__lc.restoreContext()); await p.waitForTimeout(5000);
    await shoot('c');
  }
  await b.close();
})();
