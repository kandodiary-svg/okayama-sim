// AI 車の動きの実測（repl.js の命令ファイルとして使う）: 一定時間シミュレーションを進め、各車の 0.1 秒ごとの
//  ・横方向の動き（進行方向に対して直角のずれ）  ・向きの変わる速さ（度/秒）  ・走った距離と速度の食い違い
// を集計する。車線データを直したときに、前後で同じ数字を比べるための試験（v41.8）。
(async()=>{
  const T=__Traffic, S=__S, segs=T.segs;
  for(let i=0;i<150;i++) __sim(0.1);
  const prev=new Map(); const latv=[], yawv=[], jmpv=[], ev=[];
  for(let k=0;k<900;k++){
    __sim(0.1); S.t+=0.1;
    for(const c of T.cars){ if(!c.type) continue; const p=prev.get(c);
      if(p){ const sx=c.x-p.x, sz=c.z-p.z, sd=Math.hypot(sx,sz);
        if(sd<4 && p.v>1.5){
          latv.push(Math.abs(sx*p.dz-sz*p.dx)); jmpv.push(Math.abs(sd-p.v*0.1));
          const da=Math.atan2(c.dx*p.dz-c.dz*p.dx, c.dx*p.dx+c.dz*p.dz)*180/Math.PI/0.1; yawv.push(Math.abs(da));
          if(Math.abs(da)>90 && p.plan0===c.plan[0]){ const sg=segs[c.plan[0]]; ev.push({seg:c.plan[0], lane:sg.lane, s:+c.s.toFixed(1), len:+sg.P.len.toFixed(1)}); } } }
      prev.set(c,{x:c.x,z:c.z,dx:c.dx,dz:c.dz,v:c.v,plan0:c.plan[0]}); }
  }
  const pct=(a,q)=>{ a=a.slice().sort((x,y)=>x-y); return +(a[Math.min(a.length-1,Math.floor(a.length*q))]||0).toFixed(3); };
  return JSON.stringify({ cars:T.cars.filter(c=>c.type).length, moves:latv.length,
    side_per_step_m:{p50:pct(latv,.5),p99:pct(latv,.99),p999:pct(latv,.999),max:pct(latv,1)},
    yawrate_dps:{p50:pct(yawv,.5),p99:pct(yawv,.99),p999:pct(yawv,.999),max:pct(yawv,1)},
    speed_mismatch_m:{p99:pct(jmpv,.99),p999:pct(jmpv,.999)},
    over45dps:yawv.filter(x=>x>45).length, over90dps:yawv.filter(x=>x>90).length,
    over90_laneEnd:ev.filter(e=>e.len-e.s<4).length, over90_laneStart:ev.filter(e=>e.s<4).length, over90_conn:ev.filter(e=>!e.lane).length });
})()
