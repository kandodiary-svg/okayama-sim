(async()=>{
const T=__Traffic, S=__S, segs=T.segs, C=__Car.C, cam=__cam; const step=(n)=>{ for(let i=0;i<n;i++){ __sim(0.1); S.t+=0.1; } };
const K=(g)=> (g.c==="p"||g.c==="s"||(g.c==="t"&&g.n>=2)) ? "art" : g.c==="t" ? "mid" : "nar";
const spots=[[500,300],[-1200,1700],[2000,-800],[0,0],[1500,1500]]; const agg={art:{n:0,mv:0,nm:0,st:0},mid:{n:0,mv:0,nm:0,st:0},nar:{n:0,mv:0,nm:0,st:0}}; let lenA={art:0,mid:0,nar:0}; let nS=0; const per=[];
for(const [x,z] of spots){
  const sp=T.startPose(x,z,1,0)||T.startPose(x,z,0,1); C.x=sp?sp.x:x; C.z=sp?sp.z:z; C.h=__Car.hAt(C.x,C.z); C.v=0; C.yaw=sp?sp.yaw:0; T.reset();
  const place=()=>{ cam.position.set(C.x-Math.sin(C.yaw)*7, C.h+3, C.z-Math.cos(C.yaw)*7); cam.lookAt(C.x+Math.sin(C.yaw)*10, C.h+1, C.z+Math.cos(C.yaw)*10); cam.updateMatrixWorld(true); };
  place(); const here={art:{n:0,mv:0,nm:0,st:0},mid:{n:0,mv:0,nm:0,st:0},nar:{n:0,mv:0,nm:0,st:0}}; let ns=0;
  for(let k=0;k<8;k++){ step(300); place(); if(k<3) continue; ns++;
    for(const c of T.cars){ if(!c.type) continue; if(Math.hypot(c.x-C.x,c.z-C.z)>400) continue; let sg=segs[c.plan[0]]; if(!sg.lane) sg=segs[sg.next[0]]; const A=here[K(sg)]; A.n++; if(c.v<0.3) A.st++; else { A.mv+=c.v*3.6; A.nm++; } } }
  const lenBy={art:0,mid:0,nar:0}; for(const g of segs){ if(!g.lane) continue; const p=g.P.P; if(Math.hypot(p[0]-C.x,p[2]-C.z)>400) continue; lenBy[K(g)]+=g.P.len; }
  for(const k in here){ for(const f of ["n","mv","nm","st"]) agg[k][f]+=here[k][f]; lenA[k]+=lenBy[k]*ns; } nS+=ns;
  per.push({spot:[x,z], perKm:Object.fromEntries(Object.keys(here).map(k=>[k,+(here[k].n/ns/(lenBy[k]/1000||1)).toFixed(1)]))});
}
const res={}; for(const k in agg){ const A=agg[k]; res[k]={perKm:+(A.n/(lenA[k]/1000)).toFixed(1), mvKmh:+(A.mv/Math.max(1,A.nm)).toFixed(1), stoppedPct:+(100*A.st/Math.max(1,A.n)).toFixed(0), share:0}; }
const tot=agg.art.n+agg.mid.n+agg.nar.n; for(const k in agg) res[k].share=+(100*agg[k].n/tot).toFixed(0);
return JSON.stringify({res,per});
})()
