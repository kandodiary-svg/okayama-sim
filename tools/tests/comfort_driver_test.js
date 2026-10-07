// v41.16: 乗り心地の判定の試験（repl.js の命令ファイル）。キーボードで運転する人をモデルにして、経路どおりに走らせ、
//   「旧しきい値（生の加速度 > 3.4 / 横加速度 > 3.6）」と「新しい判定（体に感じる加速度 C.accF / C.latF が Car.P.cmf を超える）」で、1 km あたり何回「急な操作」になるかを数える。
// 使い方: 先に window.__cmfCfg を設定する命令を流す。例（車・街なか）:
//   (()=>{ window.__cmfCfg={ src:'routes', sigma:6, vks:[40], modes:['pwm','hold'], AYs:[2.0,3.0,4.5], styles:[[true,2.0]], maxM:2200, routes:[[-85,36,847,414]] }; return 'ok'; })()
//   バスは __Car.setProfile('bus') のあとに src:'bus'、トラックは __Car.setProfile('truck')。
//   modes: pwm = アクセル・ブレーキを細かく押し離す／hold = 目標速度まで押しっぱなし。AYs = 曲がり角で許す横加速度（小さいほど慎重）。styles = [先を見て減速するか, 快適な減速度]。
// 結果（v41.16 のとき）: 慎重〜ふつう（AY 2〜3）は新判定で 0 回/km（旧は 5〜7 回/km）。荒い運転（AY 4.5・手前で強く踏む）は新判定でも数回/km。
(()=>{
  // キーボード運転者のモデル（経路に沿うハンドル角を、キーの押し・離しで作る）。評価する「減点ルール」を RULES に並べ、同じ運転で比べる。
  const SRC = (window.__cmfCfg && window.__cmfCfg.src) || 'routes';
  const CFG = Object.assign({ styles:[[true,2.0]], vks:[30,40], modes:['pwm','hold'], AYs:[2.5], dt:1/60, maxM:3000, routes:[[-85,36,847,414]] }, window.__cmfCfg||{});
  const C=__Car.C, Pr=__Car.P, N=__Nav; const res={L:Pr.L, src:SRC, cfg:CFG};
  const ob0=C.obst; C.obst=null; const hitFn=ob0;
  function mk(track){ const n=track.length, P=new Float32Array(n*3), Cc=new Float32Array(n); for(let i=0;i<n;i++){ P[i*3]=track[i][0]; P[i*3+1]=track[i][1]; P[i*3+2]=track[i][2]; if(i) Cc[i]=Cc[i-1]+Math.hypot(track[i][0]-track[i-1][0], track[i][2]-track[i-1][2]); } return {P, C:Cc, n, len:Cc[n-1]}; }
  function pathOf(k){ if(SRC==='bus') return __busP(); const [x0,z0,x1,z1]=CFG.routes[k%CFG.routes.length]; const R=N.plan(x0,z0,0,x1,z1); const raw=[]; for(let i=0;i<R.n;i++) raw.push([R.X[i], R.Z[i]]);
    // 1 m ごとに取り直して、ガウス平滑（σ m）で交差点の角を実際の車が通る程度の円弧にする
    const cum=[0]; for(let i=1;i<raw.length;i++) cum.push(cum[i-1]+Math.hypot(raw[i][0]-raw[i-1][0], raw[i][1]-raw[i-1][1])); const L=cum[cum.length-1]; const rs=[]; let j=0;
    for(let d=0; d<=L; d+=1){ while(j<cum.length-2 && cum[j+1]<d) j++; const t=(d-cum[j])/Math.max(1e-6,cum[j+1]-cum[j]); rs.push([raw[j][0]+(raw[j+1][0]-raw[j][0])*t, raw[j][1]+(raw[j+1][1]-raw[j][1])*t]); }
    const sg=CFG.sigma||6, W=Math.ceil(sg*3), ker=[]; let ks=0; for(let k=-W;k<=W;k++){ const w=Math.exp(-k*k/(2*sg*sg)); ker.push(w); ks+=w; }
    const tr=[]; for(let i=0;i<rs.length;i++){ let x=0,z=0,wsum=0; for(let k=-W;k<=W;k++){ const ii=i+k; if(ii<0||ii>=rs.length) continue; const w=ker[k+W]; x+=rs[ii][0]*w; z+=rs[ii][1]*w; wsum+=w; } x/=wsum; z/=wsum; tr.push([x, __Car.hAt(x,z), z]); }
    return mk(tr); }
  const K={}; const press=(k,on)=>{ if(!!K[k]===on) return; K[k]=on; window.dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{key:k})); };
  const RULES = { old:{ f:(c)=>Math.abs(c.acc||0)>3.4 || (c.aLat||0)>3.6, off:(c)=>Math.abs(c.acc||0)<2.0 && (c.aLat||0)<2.2, cd:6 } };
  if(Pr.cmf){ const a=Pr.cmf.acc, l=Pr.cmf.lat; RULES.neu={ f:(c)=>Math.abs(c.accF||0)>a || (c.latF||0)>l, off:(c)=>Math.abs(c.accF||0)<a*0.6 && (c.latF||0)<l*0.6, cd:6 }; }
  function run(P, vk, mode, ay, dt, maxM, ANT, ay2){
    const s0=15, s1=Math.min(P.len-20, s0+maxM);
    const q0=__pathPt(P,s0), t0=__pathTan(P,s0); C.x=q0.x; C.z=q0.z; C.yaw=Math.atan2(t0.x,t0.z); C.v=0; C._pv=0; C.h=__Car.hAt(C.x,C.z); C.wheel=0; C.thr=0; C.brk=0; C.autopilot=null; C.accF=0; C.latF=0; C.hitT=0;
    let s=s0; const st={t:0,n:0,hits:0,maxAcc:0,maxLat:0,maxAccF:0,maxLatF:0}; const rs={}; for(const k in RULES) rs[k]={ev:0,harsh:false,last:-99,evT:[]};
    const accs=[],lats=[]; let brkHold=false, lastHit=false, stuck=0, lastS=s0;
    for(let i=0;i<Math.ceil(2400/dt) && s<s1;i++){
      let best=1e9, bs=s; for(let d=-10; d<=25; d+=0.5){ const q=__pathPt(P,s+d); const e=(q.x-C.x)**2+(q.z-C.z)**2; if(e<best){best=e; bs=s+d;} } s=bs;
      const q=__pathPt(P,s), t=__pathTan(P,s), t2=__pathTan(P,s+2), t1=__pathTan(P,s-2);
      const th=Math.atan2(t.x,t.z); let dh=th-C.yaw; dh=Math.atan2(Math.sin(dh),Math.cos(dh));
      const kap=Math.atan2(t1.x*t2.z-t1.z*t2.x, t1.x*t2.x+t1.z*t2.z)/4;
      const lx=Math.cos(C.yaw), lz=-Math.sin(C.yaw); const e=(q.x-C.x)*lx+(q.z-C.z)*lz;
      const a=Pr.rearOff, Rc=1/Math.max(Math.abs(kap),1e-4), Rr=Math.sqrt(Math.max(Rc*Rc-a*a, 1));
      const ff=Math.sign(kap)*Math.atan(Pr.L/Rr)*(Math.abs(kap)>1e-3?1:0); const beta = Math.abs(kap)>1e-3 ? Math.sign(kap)*Math.atan(a/Rr) : 0;
      let dh2 = dh + beta; dh2=Math.atan2(Math.sin(dh2),Math.cos(dh2));
      const steer=-ff + dh2*1.0 + Math.atan(1.2*e/(Math.abs(C.v)+1.0)); const Wd=Math.max(-7.85, Math.min(7.85, steer*Pr.ratio));
      // 先の曲がりに合わせた目標速度: 距離 d 先の曲がりの許容速度 vc に、快適な減速 aB で間に合う速度 sqrt(vc²+2·aB·d) の最小値（anticipate=false は手前 30m だけ見る＝遅れて強く踏む運転）
      let vt=vk/3.6; let curv_dbg=0; { const dmax = ANT ? 90 : 30, aB = ay2;
        for(let d=0; d<=dmax; d+=2.5){ const u1=__pathTan(P,s+d), u2=__pathTan(P,s+d+5); const cv=Math.abs(Math.atan2(u1.x*u2.z-u1.z*u2.x, u1.x*u2.x+u1.z*u2.z))/5; const vc=Math.sqrt(ay/Math.max(cv,1e-3)); if(d===0) curv_dbg=cv; vt=Math.min(vt, ANT ? Math.sqrt(vc*vc+2*aB*d) : vc); } }
      press('ArrowLeft', Wd > C.wheel + 0.12); press('ArrowRight', Wd < C.wheel - 0.12);
      if(mode==='pwm'){ press('ArrowUp', C.v < vt-0.2); press('ArrowDown', C.v > vt+0.6); }
      else { if(C.v > vt+0.6) brkHold=true; else if(C.v < vt-0.3) brkHold=false; press('ArrowDown', brkHold); press('ArrowUp', !brkHold && C.v < vt-0.5); }
      __Car.tick(dt); if(window.__cmfHook) window.__cmfHook(dt); st.t+=dt; st.n++;
      if(C.hitT>1.0 && !lastHit) st.hits++; lastHit=C.hitT>1.0;
      if(i%120===0){ if(s-lastS<0.5) stuck++; else stuck=0; lastS=s; if(stuck>12) break; }
      const acc=Math.abs(C.acc||0), lat=C.aLat||0; if(C.v>0.5){ accs.push(acc); lats.push(lat); st.maxAcc=Math.max(st.maxAcc,acc); st.maxLat=Math.max(st.maxLat,lat); st.maxAccF=Math.max(st.maxAccF,Math.abs(C.accF||0)); st.maxLatF=Math.max(st.maxLatF,C.latF||0);
        for(const k in RULES){ const R=RULES[k], r=rs[k]; if(R.f(C)){ if(!r.harsh && st.t-r.last>R.cd){ r.harsh=true; r.last=st.t; r.ev++; if(r.evT.length<6) r.evT.push([Math.round(s), +acc.toFixed(1), +lat.toFixed(1), +(C.v*3.6).toFixed(0), +(C.accF||0).toFixed(1), +(C.latF||0).toFixed(1), +e.toFixed(2), +Wd.toFixed(2), +C.wheel.toFixed(2), +vt.toFixed(1), +(1/Math.max(1e-3,curv_dbg)).toFixed(0)]); } } else if(R.off(C)) r.harsh=false; } }
    }
    for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']) press(k,false);
    const km=Math.max(0.1,(s-s0)/1000); accs.sort((a,b)=>a-b); lats.sort((a,b)=>a-b); const pc=(a,p)=>+(a[Math.floor(a.length*p)]||0).toFixed(2);
    const o={ vk, mode, ay, km:+km.toFixed(2), sec:Math.round(st.t), hits:st.hits, maxAcc:+st.maxAcc.toFixed(1), maxLat:+st.maxLat.toFixed(1), maxAccF:+st.maxAccF.toFixed(1), maxLatF:+st.maxLatF.toFixed(1), acc:[pc(accs,.5),pc(accs,.95),pc(accs,.99)], lat:[pc(lats,.5),pc(lats,.95),pc(lats,.99)], vavg:+((s-s0)/st.t*3.6).toFixed(0) };
    for(const k in RULES){ o['perKm_'+k]=+(rs[k].ev/km).toFixed(2); o['ev_'+k]=rs[k].evT.slice(0,6); }
    return o;
  }
  res.runs=[]; let ri=0;
  for(const ay of CFG.AYs) for(const vk of CFG.vks) for(const mode of CFG.modes){ const P=pathOf(ri++); for(const [ANT,ay2] of CFG.styles){ const o=run(P, vk, mode, ay, CFG.dt, CFG.maxM, ANT, ay2); o.ant=ANT; o.aB=ay2; res.runs.push(o); } }
  C.obst=ob0; return JSON.stringify(res);
})()
