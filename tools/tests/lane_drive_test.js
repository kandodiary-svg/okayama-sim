// v41.21: 車線に沿って「実際の車の物理（Car.tick）」で走り、高さの追い方（C.h）を測る。車モードを始めた repl.js に流す（結果は JSON）。
//   lane_rough_test.js・viaduct_test.js は車の高さの追い方を「まねた」計算だったが、これは Car.tick そのもの（隣の升の制限・勾配の上限・層の選び方・衝突）を使う。
//   自動運転（C.autopilot）で車線の中心を追う（先を見る距離 = max(6, 速度+4)m・目標 v m/s）。人が車線どおりに運転したときの高さの動きに相当。
//   各走行で測るもの:
//     dev   = 車線の高さ（ly）との差の最大（|C.h − ly|）。層を間違えて高架・堤防へ乗ると大きくなる（>1.5m を off とする）
//     grade = 4m の間の高さの変化の最大（勾配）、step = 0.5m の間の高さの変化の最大（段差）
//     hits  = 建物・壁との衝突（C.hitT > 1）の回数（hitAt = 最初の衝突の [x, z, 向き°, 車線の上の距離 s]）、lat = 車線の中心からのずれの最大（m）
//   window.__ldCfg = { v: 9, probes: [{name, box:[x0,z0,x1,z1], min:100, max:4} または {name, ids:[車線番号, ...]}, ...] } で対象を変える。既定は v41.20 で直した場所（国道250号の高架の上・
//   x=1225 / x=1468 の下の道・斜めの道 x≈1343・堤防の下 (950,1635)・トンネル 3 本・駅西のランプ）
(()=>{
  const T=__Traffic, Cr=__Car, C=Cr.C, Pr=Cr.P, segs=T.segs, NL=T.NL;
  const CFG=Object.assign({ v:9, dt:1/60, probes:[
    {name:'国道250号 高架の上', box:[1100,1020,1500,1048], min:150, max:3},
    {name:'x=1225 下の道', box:[1205,985,1245,1090], min:60, max:3},
    {name:'x=1468 下の道', box:[1450,980,1485,1090], min:60, max:3},
    {name:'x≈1343 斜めの道', box:[1318,1000,1365,1110], min:50, max:4},
    {name:'堤防の下 (950,1635)', box:[925,1600,985,1670], min:40, max:4},
    {name:'島田筋トンネル', box:[-745,360,-690,465], min:60, max:3},
    {name:'巌井野田線トンネル', box:[-1800,640,-1660,935], min:200, max:4},
    {name:'駅西のランプ', box:[-480,60,-410,150], min:80, max:3}
  ]}, window.__ldCfg||{});
  const K={}; const ob0=C.obst; C.obst=null;
  function lanesIn(bx,min,max){ const out=[]; for(let i=0;i<NL;i++){ const P=segs[i].P, a=P.P, n=P.n; if(P.len<min) continue; let k=0; for(let q=0;q<n;q++){ const x=a[q*3], z=a[q*3+2]; if(x>=bx[0]&&x<=bx[2]&&z>=bx[1]&&z<=bx[3]) k++; } if(k>=Math.max(6,n*0.45)) out.push([i,P.len]); } out.sort((a,b)=>b[1]-a[1]); return out.slice(0,max).map(o=>o[0]); }
  function drive(i){
    const P=segs[i].P, a=P.P, n=P.n; const cum=[0]; for(let q=1;q<n;q++) cum.push(cum[q-1]+Math.hypot(a[q*3]-a[(q-1)*3],a[q*3+2]-a[(q-1)*3+2])); const L=cum[n-1];
    const at=(s)=>{ s=Math.max(0,Math.min(L,s)); let q=0; while(q<n-2&&cum[q+1]<s) q++; const t=(s-cum[q])/Math.max(1e-6,cum[q+1]-cum[q]); return { x:a[q*3]+(a[(q+1)*3]-a[q*3])*t, y:a[q*3+1]+(a[(q+1)*3+1]-a[q*3+1])*t, z:a[q*3+2]+(a[(q+1)*3+2]-a[q*3+2])*t, tx:a[(q+1)*3]-a[q*3], tz:a[(q+1)*3+2]-a[q*3+2] }; };
    const s0=Math.min(8,L*0.1), s1=L-4; const p0=at(s0); C.gear='D'; C.x=p0.x; C.z=p0.z; C.yaw=Math.atan2(p0.tx,p0.tz); C.v=CFG.v; C._pv=CFG.v; C.h=Cr.hAt(p0.x,p0.z,p0.y); C.wheel=0; C.thr=0; C.brk=0; C.hitT=0; C.fall=false;
    let s=s0; const hs=[], ds=[], lys=[], xs=[], zs=[]; let hits=0, hitAt=null, lastHit=false, latMax=0, stuck=0, lastS=s0, steps=0; const dt=CFG.dt;
    C.autopilot=(c)=>{ // 先を見て追う（純追従）
      const Ld=Math.max(6,Math.abs(c.v)+4); const pt=at(s+Ld); const dx=pt.x-c.x, dz=pt.z-c.z; const hd=Math.atan2(dx,dz); let dh=hd-c.yaw; dh=Math.atan2(Math.sin(dh),Math.cos(dh));
      const steer=Math.atan(2*Pr.L*Math.sin(dh)/Math.max(1,Math.hypot(dx,dz))); const Wd=Math.max(-7.85,Math.min(7.85,steer*Pr.ratio));
      const vt=CFG.v; return { thr: c.v<vt-0.3?0.6:0, brk: c.v>vt+0.8?0.3:0, wheel: Wd }; };
    for(let it=0; it<Math.ceil(600/dt) && s<s1; it++){
      let best=1e9, bs=s; for(let d=-4; d<=14; d+=0.5){ const q=at(s+d); const e=(q.x-C.x)**2+(q.z-C.z)**2; if(e<best){best=e; bs=s+d;} } s=Math.max(s,bs);
      Cr.tick(dt); steps++;
      const q=at(s); latMax=Math.max(latMax,Math.sqrt(best));
      if(C.hitT>1.0&&!lastHit){ hits++; if(!hitAt) hitAt=[+C.x.toFixed(1),+C.z.toFixed(1),+(C.yaw*57.2958).toFixed(0),+s.toFixed(0)]; } lastHit=C.hitT>1.0;
      if(it%30===0){ hs.push(C.h); ds.push(s); lys.push(q.y); xs.push(C.x); zs.push(C.z); }
      if(it%120===0){ if(s-lastS<0.5) stuck++; else stuck=0; lastS=s; if(stuck>8) break; }
    }
    C.autopilot=null; C.v=0; C.thr=0; C.brk=0;
    const m=hs.length; if(m<6) return { lane:i, len:Math.round(L), note:'短い・止まった', s:Math.round(s) };
    let hMin=1e9,hMax=-1e9,dev=0,devAt=null,off=0; for(let j=0;j<m;j++){ hMin=Math.min(hMin,hs[j]); hMax=Math.max(hMax,hs[j]); const d=Math.abs(hs[j]-lys[j]); if(d>dev){ dev=d; devAt=[Math.round(xs[j]),Math.round(zs[j])]; } if(d>1.5) off++; }
    // 距離 0.5m ごとに取り直した高さで、勾配（4m）と段差（0.5m）
    const rs=[]; for(let d=ds[0]; d<=ds[m-1]; d+=0.5){ let j=0; while(j<m-2&&ds[j+1]<d) j++; const t=(d-ds[j])/Math.max(1e-6,ds[j+1]-ds[j]); rs.push(hs[j]+(hs[j+1]-hs[j])*Math.max(0,Math.min(1,t))); }
    let grade=0, step=0, gAt=0; for(let j=4;j<rs.length-4;j++){ const g=Math.abs(rs[j+4]-rs[j-4])/4; if(g>grade){ grade=g; gAt=j; } } for(let j=1;j<rs.length;j++) step=Math.max(step,Math.abs(rs[j]-rs[j-1]));
    return { lane:i, len:Math.round(L), run:Math.round(s-s0), hMin:+hMin.toFixed(1), hMax:+hMax.toFixed(1), dev:+dev.toFixed(2), devAt, off, grade:+grade.toFixed(2), step:+step.toFixed(2), hits, hitAt, lat:+latMax.toFixed(1), prof:hs.filter((_,j)=>j%6===0).map(v=>+v.toFixed(1)) };
  }
  const res={ cfg:{v:CFG.v}, probes:[] };
  for(const p of CFG.probes){ const ids=p.ids?p.ids.slice():lanesIn(p.box,p.min||50,p.max||3); const runs=ids.map(drive); res.probes.push({ name:p.name, lanes:ids.length, worstDev:Math.max(0,...runs.map(r=>r.dev||0)), worstGrade:Math.max(0,...runs.map(r=>r.grade||0)), worstStep:Math.max(0,...runs.map(r=>r.step||0)), hits:runs.reduce((s,r)=>s+(r.hits||0),0), off:runs.reduce((s,r)=>s+(r.off||0),0), runs }); }
  C.obst=ob0; return JSON.stringify(res); })()
