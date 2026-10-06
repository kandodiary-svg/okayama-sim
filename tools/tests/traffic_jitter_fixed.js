(async()=>{
  const T=__Traffic, S=__S, segs=T.segs, C=__Car.C; const spots=[[500,300],[-1200,1700],[1500,1500],[2000,-800]];
  const latv=[], yawv=[], jmpv=[]; let nCars=0, ev={laneEnd:0,laneStart:0,conn:0}; let n90=0;
  for(const [x,z] of spots){
    const sp=T.startPose(x,z,1,0)||T.startPose(x,z,0,1); C.x=sp?sp.x:x; C.z=sp?sp.z:z; C.h=__Car.hAt(C.x,C.z); C.v=0; C.yaw=sp?sp.yaw:0; T.reset();
    for(let i=0;i<150;i++){ __sim(0.1); S.t+=0.1; }
    const prev=new Map();
    for(let k=0;k<500;k++){ __sim(0.1); S.t+=0.1;
      for(const c of T.cars){ if(!c.type) continue; const p=prev.get(c);
        if(p){ const sx=c.x-p.x, sz=c.z-p.z, sd=Math.hypot(sx,sz);
          if(sd<4 && p.v>1.5){ latv.push(Math.abs(sx*p.dz-sz*p.dx)); jmpv.push(Math.abs(sd-p.v*0.1));
            const da=Math.atan2(c.dx*p.dz-c.dz*p.dx, c.dx*p.dx+c.dz*p.dz)*180/Math.PI/0.1; yawv.push(Math.abs(da));
            if(Math.abs(da)>90 && p.plan0===c.plan[0]){ n90++; const sg=segs[c.plan[0]]; if(!sg.lane) ev.conn++; else if(sg.P.len-c.s<4) ev.laneEnd++; else if(c.s<4) ev.laneStart++; } } }
        prev.set(c,{x:c.x,z:c.z,dx:c.dx,dz:c.dz,v:c.v,plan0:c.plan[0]}); }
    }
    nCars+=T.cars.filter(c=>c.type).length;
  }
  const pct=(a,q)=>{ a=a.slice().sort((x,y)=>x-y); return +(a[Math.min(a.length-1,Math.floor(a.length*q))]||0).toFixed(3); };
  return JSON.stringify({ cars:nCars, moves:latv.length, side:{p50:pct(latv,.5),p99:pct(latv,.99),p999:pct(latv,.999),max:pct(latv,1)}, yaw:{p50:pct(yawv,.5),p99:pct(yawv,.99),p999:pct(yawv,.999),max:pct(yawv,1)}, mism:{p99:pct(jmpv,.99),p999:pct(jmpv,.999)}, over45:yawv.filter(x=>x>45).length, over90:n90, ev });
})()
