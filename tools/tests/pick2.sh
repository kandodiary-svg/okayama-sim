#!/bin/bash
cd /home/claude/wx/tests
node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({executablePath:"/opt/pw-browsers/chromium", args:["--use-gl=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  await p.goto("http://localhost:8806/index.html");
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ __Env.set("noon", false); document.querySelector(".mode-opt[data-mode=\"heli\"]").click(); document.getElementById("start").click(); });
  await p.waitForTimeout(2000);
  let [px,py,pz,lx,ly,lz] = JSON.parse(process.env.SHOT);
  const g = await p.evaluate(([a,b,c,d])=>[__Car.hAt(a,b), __Car.hAt(c,d)], [px,pz,lx,lz]); py+=g[0]; ly+=g[1];
  await p.evaluate(([px,py,pz,lx,ly,lz])=>{ Object.assign(__Heli.H,{x:lx,z:lz,y:60,vF:0,vS:0,vY:0}); window.__camfix={pos:[px,py,pz],look:[lx,ly,lz]}; }, [px,py,pz,lx,ly,lz]);
  for (let k=0;k<60;k++){ await p.evaluate(()=>{ const H=__Heli.H; const s={x:H.x,y:H.y,z:H.z}; __Heli.tick(0.05); Object.assign(H,s,{vF:0,vS:0,vY:0}); }); await p.waitForTimeout(250); }
  const r = await p.evaluate((pts)=>{ const rc=new THREE.Raycaster(); const out=[];
    for(const [sx,sy] of pts){ rc.setFromCamera(new THREE.Vector2(sx/innerWidth*2-1, -(sy/innerHeight*2-1)), window.__cam);
      const objs=[]; __world.traverse(o=>{ if(o.isMesh && o.visible && o.geometry.attributes.position && o.geometry.attributes.position.array && !Object.values(o.geometry.attributes).some(a=>!(a.array||(a.data&&a.data.array)))) objs.push(o); }); const h=rc.intersectObjects(objs,false).filter(h=>h.object.visible).slice(0,2);
      out.push([sx,sy,h.map(x=>[x.object.name,x.object.userData.file,x.object.material&&x.object.material.color&&x.object.material.color.getHexString(),+x.point.x.toFixed(1),+x.point.y.toFixed(1),+x.point.z.toFixed(1)])]); } return out; }, JSON.parse(process.env.PTS));
  console.log(JSON.stringify(r));
  await p.screenshot({path:"/home/claude/wx/tests/pick2.png"}); await b.close(); })();'
