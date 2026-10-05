// 渋滞・行き詰まりの試験（repl.js の命令ファイル）: 利用者を道から外して置き、15 分シミュレーション。信号待ちでない 60 秒以上の停車を数える（v41.8）
(async()=>{
  const T=__Traffic, S=__S, segs=T.segs, C=__Car.C, cam=__cam; const step=(n)=>{ for(let i=0;i<n;i++){ __sim(0.1); S.t+=0.1; } };
  const names=['none','sig','jnOwner','ped','car','tram','other','exitFull','deadend','player'];
  const out=[];
  for(const P of [[-797,4014],[-1090,1793],[-630,3900],[-2043,3264]]) for(let att=0; att<2; att++){
    const sp=T.startPose(P[0],P[1],1,0)||T.startPose(P[0],P[1],0,1);
    const nx=-Math.cos(sp.yaw), nz=Math.sin(sp.yaw);
    C.x=sp.x+nx*12; C.z=sp.z+nz*12; C.h=__Car.hAt(C.x,C.z); C.v=0; C.yaw=sp.yaw; T.reset();
    const place=()=>{ cam.position.set(C.x-Math.sin(C.yaw)*7, C.h+3, C.z-Math.cos(C.yaw)*7); cam.lookAt(C.x+Math.sin(C.yaw)*10, C.h+1, C.z+Math.cos(C.yaw)*10); cam.updateMatrixWorld(true); };
    place(); for(let k=0;k<9;k++){ step(1000); place(); }
    const cars=T.cars.filter(c=>c.type), long=cars.filter(c=>c.v<0.2 && (c.stopT||0)>60);
    const cnt={}; for(const c of long){ const kk=names[c.gsrc||0]+(c.blockedBy? ('>'+(c.blockedBy.ped?'ped':c.blockedBy.type?'car':c.blockedBy.leg?'tram':'o')):''); cnt[kk]=(cnt[kk]||0)+1; }
    out.push({spot:P.join(','), att, near:cars.filter(c=>Math.hypot(c.x-C.x,c.z-C.z)<150).length, long:long.length, max:Math.round(Math.max(0,...long.map(c=>c.stopT))), cnt});
  }
  return JSON.stringify(out);
})()
