// 画面の点に写っているメッシュ（層・材質・ページ・ファイル）を調べる。SHOT=[px,py,pz,lx,ly,lz] PTS=[[sx,sy],...]
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ __Env.set("noon", false); document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2000);
  const [px,py,pz,lx,ly,lz] = JSON.parse(process.env.SHOT);
  await p.evaluate(([px,py,pz,lx,ly,lz])=>{ const H=__Heli.H; Object.assign(H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, [px,py,pz,lx,ly,lz]);
  for (let k=0;k<50;k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
  const r = await p.evaluate((pts)=>{
    const cam = window.__camera || null; const out=[];
    const rc = new THREE.Raycaster(); const W=innerWidth, H=innerHeight;
    const c = __world.parent.children.find(o=>o.isCamera) || null;
    for(const [sx,sy] of pts){
      rc.setFromCamera(new THREE.Vector2(sx/W*2-1, -(sy/H*2-1)), window.__cam);
      const hits = rc.intersectObjects(__world.children, true).filter(h=>h.object.visible).slice(0,3);
      out.push([sx,sy, hits.map(h=>({name:h.object.name, file:h.object.userData.file, mat:h.object.material && h.object.material.type, map: !!(h.object.material && h.object.material.map), img: h.object.material && h.object.material.map && h.object.material.map.image ? (h.object.material.map.image.src||'').slice(-30) : null, d:+h.distance.toFixed(1), p:[+h.point.x.toFixed(1), +h.point.y.toFixed(1), +h.point.z.toFixed(1)]}))]);
    }
    return out; }, JSON.parse(process.env.PTS));
  console.log(JSON.stringify(r, null, 1));
  await p.screenshot({path:'/home/claude/wx/tests/pick.png'});
  await b.close();
})();
