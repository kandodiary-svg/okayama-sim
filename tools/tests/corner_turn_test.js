// v41.18: 交差点・カーブを「速度ごとに曲がれるか」を測る試験（repl.js の命令ファイル）。
//   実際の経路（街なかの車の経路 / バスの経路）から、向きが 24 m で 60° 以上変わる角を探し、
//   角の 45 m 手前から、速度を一定（V km/h）に保ったまま、キー（←→）だけでハンドルを切って通り抜けられるかを調べる。
//   通り抜けられた = 建物にぶつからず（hit なし）、経路からのずれが 2.5 m 以内。
//   結果: 速度ごとの「通り抜けられた角の割合」と、角ごとの「通り抜けられる最高速度」の中央値・最小値、通り抜けたときの最大横加速度（体感の目安）。
// 結果（セダン・街なかの経路の角 15 か所〔向きが 24 m で約 90° 変わる〕、通り抜けられた割合）:
//   速度 km/h   20    25    30    35    40
//   v41.16     .93   .93   .93   .67   .13
//   v41.17     .93   .60   .07   0     0      ← 横加速度を全速度で 4.4 に抑えたため、30 km/h 付近の角を曲がり切れなかった
//   v41.18     .93   .93   .93   .47   .13
//   ゆるいカーブ（向きが 25〜55° 変わる 14 か所）: 45 km/h で v41.16 .79 → v41.18 .79、50 km/h で .79 → .64、55 km/h で .57 → .29（v41.17 は未測定）。
//   （1701 m の 137° の角は経路が U ターンする所で、どの版でも 10 km/h でも通れない）
// 使い方: 先に window.__cornerCfg を設定する命令を流す。例:
//   (()=>{ window.__cornerCfg={ src:'routes', speeds:[10,15,20,25,30,35,40], routes:[[-85,36,847,414],[847,414,-85,36]] }; return 'ok'; })()
//   ゆるいカーブだけ見るときは minTurn:25, maxTurn:55, speeds:[30,40,50,60,70] など。バスは __Car.setProfile('bus') のあとに src:'bus'。window.__cornerShift=true で Shift（スポーツ）を押した状態。
(()=>{
  const SRC = (window.__cornerCfg && window.__cornerCfg.src) || 'routes';
  const CFG = Object.assign({ speeds:[10,15,20,25,30,35,40], routes:[[-85,36,847,414],[847,414,-85,36]], sigma:4, minTurn:60, maxTurn:999, maxCorners:16, dt:1/60, errMax:2.5 }, window.__cornerCfg||{});
  const C=__Car.C, Pr=__Car.P, N=__Nav; const ob0=C.obst; C.obst=null;
  function mk(track){ const n=track.length, P=new Float32Array(n*3), Cc=new Float32Array(n); for(let i=0;i<n;i++){ P[i*3]=track[i][0]; P[i*3+1]=track[i][1]; P[i*3+2]=track[i][2]; if(i) Cc[i]=Cc[i-1]+Math.hypot(track[i][0]-track[i-1][0], track[i][2]-track[i-1][2]); } return {P, C:Cc, n, len:Cc[n-1]}; }
  function smooth(raw, sg){ const cum=[0]; for(let i=1;i<raw.length;i++) cum.push(cum[i-1]+Math.hypot(raw[i][0]-raw[i-1][0], raw[i][1]-raw[i-1][1])); const L=cum[cum.length-1]; const rs=[]; let j=0;
    for(let d=0; d<=L; d+=1){ while(j<cum.length-2 && cum[j+1]<d) j++; const t=(d-cum[j])/Math.max(1e-6,cum[j+1]-cum[j]); rs.push([raw[j][0]+(raw[j+1][0]-raw[j][0])*t, raw[j][1]+(raw[j+1][1]-raw[j][1])*t]); }
    const W=Math.ceil(sg*3), ker=[]; for(let k=-W;k<=W;k++) ker.push(Math.exp(-k*k/(2*sg*sg)));
    const tr=[]; for(let i=0;i<rs.length;i++){ let x=0,z=0,ws=0; for(let k=-W;k<=W;k++){ const ii=i+k; if(ii<0||ii>=rs.length) continue; const w=ker[k+W]; x+=rs[ii][0]*w; z+=rs[ii][1]*w; ws+=w; } tr.push([x/ws, __Car.hAt(x/ws,z/ws), z/ws]); }
    return mk(tr); }
  const paths=[];
  if(SRC==='bus') paths.push(__busP());
  else for(const [x0,z0,x1,z1] of CFG.routes){ const R=N.plan(x0,z0,0,x1,z1); const raw=[]; for(let i=0;i<R.n;i++) raw.push([R.X[i],R.Z[i]]); paths.push(smooth(raw, CFG.sigma)); }
  // 角を探す: 24 m の窓での向きの変化の合計が minTurn°以上。窓の中央を角の位置とする
  const corners=[];
  paths.forEach((P,pi)=>{ const hd=(s)=>{ const t=__pathTan(P,s); return Math.atan2(t.x,t.z); }; let last=-1e9;
    for(let s=30; s<P.len-40; s+=1){ let a0=hd(s-12), a1=hd(s+12); let d=a1-a0; d=Math.atan2(Math.sin(d),Math.cos(d)); if(Math.abs(d)*180/Math.PI>=CFG.minTurn){
      // 窓内の最大変化の位置に寄せる
      let bs=s,bd=Math.abs(d); for(let u=s;u<s+12;u++){ const dd=Math.abs(Math.atan2(Math.sin(hd(u+12)-hd(u-12)),Math.cos(hd(u+12)-hd(u-12)))); if(dd>bd){bd=dd;bs=u;} }
      if(bs-last>60 && bd*180/Math.PI<=CFG.maxTurn){ corners.push({pi, s:bs, turn:Math.round(bd*180/Math.PI)}); last=bs; } s=bs+12; } } });
  // 偏らないように均等に間引く
  let sel=corners; if(sel.length>CFG.maxCorners){ const st=sel.length/CFG.maxCorners; sel=[]; for(let i=0;i<CFG.maxCorners;i++) sel.push(corners[Math.floor(i*st)]); }
  const K={}; const press=(k,on)=>{ if(!!K[k]===on) return; K[k]=on; window.dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{key:k})); };
  function runOne(P, sc, V){
    const dt=CFG.dt, s0=Math.max(5, sc-45), s1=Math.min(P.len-5, sc+35);
    const q0=__pathPt(P,s0), t0=__pathTan(P,s0); C.x=q0.x; C.z=q0.z; C.yaw=Math.atan2(t0.x,t0.z); C.v=V; C._pv=V; C.h=__Car.hAt(C.x,C.z); C.wheel=0; C.thr=0; C.brk=0; C.kT=0; C.kB=0; C.hitT=0; C.accF=0; C.latF=0; C.gear='D'; C.autopilot=null;
    for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Shift']) press(k,false); if(window.__cornerShift) press('Shift',true);
    let s=s0, maxErr=0, peakLat=0, hit=false, peakLatF=0;
    for(let i=0;i<Math.ceil(30/dt) && s<s1;i++){
      let best=1e9, bs=s; for(let d=-10; d<=25; d+=0.5){ const q=__pathPt(P,s+d); const e=(q.x-C.x)**2+(q.z-C.z)**2; if(e<best){best=e; bs=s+d;} } s=bs;
      const q=__pathPt(P,s), t=__pathTan(P,s), t2=__pathTan(P,s+2), t1=__pathTan(P,s-2);
      const th=Math.atan2(t.x,t.z); let dh=th-C.yaw; dh=Math.atan2(Math.sin(dh),Math.cos(dh));
      const kap=Math.atan2(t1.x*t2.z-t1.z*t2.x, t1.x*t2.x+t1.z*t2.z)/4;
      const lx=Math.cos(C.yaw), lz=-Math.sin(C.yaw); const e=(q.x-C.x)*lx+(q.z-C.z)*lz;
      const a=Pr.rearOff, Rc=1/Math.max(Math.abs(kap),1e-4), Rr=Math.sqrt(Math.max(Rc*Rc-a*a, 1));
      const ff=Math.sign(kap)*Math.atan(Pr.L/Rr)*(Math.abs(kap)>1e-3?1:0); const beta=Math.abs(kap)>1e-3 ? Math.sign(kap)*Math.atan(a/Rr) : 0;
      let dh2=dh+beta; dh2=Math.atan2(Math.sin(dh2),Math.cos(dh2));
      const steer=-ff + dh2*1.0 + Math.atan(1.2*e/(Math.abs(C.v)+1.0)); const Wd=Math.max(-7.85, Math.min(7.85, steer*Pr.ratio));
      press('ArrowLeft', Wd > C.wheel + 0.12); press('ArrowRight', Wd < C.wheel - 0.12);
      C.v=V; C._pv=V;                      // 速度は一定に保つ（操舵だけを見る）
      __Car.tick(dt);
      C.v=V;
      peakLat=Math.max(peakLat, Math.min(C.aLat||0, Pr.grip*9.8)); peakLatF=Math.max(peakLatF, C.latF||0);
      const err=Math.abs(e); if(err>maxErr) maxErr=err; if(C.hitT>1.0) hit=true;
      if(hit || err>6) break;
    }
    for(const k of ['ArrowLeft','ArrowRight','Shift']) press(k,false);
    return { ok: !hit && maxErr<=CFG.errMax, hit, maxErr:+maxErr.toFixed(1), lat:+peakLat.toFixed(1), latF:+peakLatF.toFixed(1) };
  }
  const bySpeed={}, maxOk=[]; const rows=[];
  for(const V of CFG.speeds) bySpeed[V]={ n:0, ok:0, latF:[], lat:[] };
  for(const c of sel){ let mp=0; const row={ s:Math.round(c.s), turn:c.turn, res:{} };
    for(const V of CFG.speeds){ const r=runOne(paths[c.pi], c.s, V/3.6); const b=bySpeed[V]; b.n++; if(r.ok){ b.ok++; mp=Math.max(mp,V); b.latF.push(r.latF); b.lat.push(r.lat); } row.res[V]=r.ok?('ok '+r.lat+'/'+r.latF):('NG e'+r.maxErr+(r.hit?' hit':'')); }
    maxOk.push(mp); rows.push(row); }
  maxOk.sort((a,b)=>a-b);
  const out={ src:SRC, profile:Pr.L, shift:!!window.__cornerShift, corners:sel.length, turnMedian:sel.map(c=>c.turn).sort((a,b)=>a-b)[Math.floor(sel.length/2)],
    passRate:Object.fromEntries(CFG.speeds.map(V=>[V, +(bySpeed[V].ok/Math.max(1,bySpeed[V].n)).toFixed(2)])),
    maxPassSpeed:{ min:maxOk[0], median:maxOk[Math.floor(maxOk.length/2)], max:maxOk[maxOk.length-1] },
    peakLatWhenPassed:Object.fromEntries(CFG.speeds.map(V=>[V, (()=>{ const a=bySpeed[V].lat.slice().sort((x,y)=>x-y); return a.length? a[Math.floor(a.length/2)]:null; })()])),
    rows };
  C.obst=ob0; for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Shift']) press(k,false); return JSON.stringify(out);
})()
