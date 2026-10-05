// 指定地点（x 東・z 南, m）の近くにある 3D オブジェクト（メッシュ／インスタンス）を一覧する。
// 使い方: PTS='[[192.4,-20],[808.4,406]]' R=3 node nearobj.js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:640,height:400}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(process.env.URL||'http://localhost:8805/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:900000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="heli"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(({pts,R})=>{
    const out=[]; const sc=window.__scene; const v=new (sc.position.constructor)();
    sc.updateMatrixWorld(true);
    sc.traverse(o=>{
      if(!(o.isMesh||o.isPoints)||!o.geometry) return; const g=o.geometry; if(!g.boundingBox) g.computeBoundingBox(); const bb=g.boundingBox; if(!bb) return;
      const mats=[]; if(o.isInstancedMesh){ const m=new o.matrix.constructor(); for(let i=0;i<o.count;i++){ o.getMatrixAt(i,m); mats.push(m.clone().premultiply(o.matrixWorld)); } } else mats.push(o.matrixWorld);
      for(const M of mats){ const c=bb.getCenter(v.clone()).applyMatrix4(M); const sz=bb.getSize(v.clone()); const sx=Math.hypot(M.elements[0],M.elements[1],M.elements[2]), sy=Math.hypot(M.elements[4],M.elements[5],M.elements[6]);
        for(const [x,z] of pts){ if(Math.hypot(c.x-x,c.z-z)<R){ out.push({pt:[x,z],name:o.name||o.parent&&o.parent.name||'',type:g.type,inst:!!o.isInstancedMesh,c:[+c.x.toFixed(2),+c.y.toFixed(2),+c.z.toFixed(2)],sz:[+(sz.x*sx).toFixed(2),+(sz.y*sy).toFixed(2),+(sz.z*sx).toFixed(2)],mat:o.material&&(o.material.name||o.material.type)}); } } } });
    return out.slice(0,200);
  }, {pts:JSON.parse(process.env.PTS), R:Number(process.env.R||3)});
  for(const o of r) console.log(JSON.stringify(o));
  await b.close();
})();
