/* 飛行力学（B737-800 相当の簡略 6 自由度）
   内部は航空機の標準規約: 機体軸 FRD（前 X・右 Y・下 Z）、地上座標 NED（北・東・下）。姿勢 q = [w,x,y,z]（機体→NED）。
   描画側の世界座標は x=東, y=上, z=南（北が -z）。 pos/vel は世界座標で持つ（pos[1] は海抜高度 m）。
   単位は SI。操作入力は -1..1 に正規化（elevator: +で機首上げ, aileron: +で右ロール, rudder: +で機首右）。 */
(function(root){
"use strict";
const G = 9.80665, D2R = Math.PI/180, KT = 0.514444;
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
/* ---- クォータニオン [w,x,y,z] ---- */
const qmul=(a,b)=>[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2], a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
const qnorm=q=>{ const n=Math.hypot(q[0],q[1],q[2],q[3])||1; return [q[0]/n,q[1]/n,q[2]/n,q[3]/n]; };
function qrot(q,v){ // 機体 → NED（v を q で回す）
  const w=q[0],x=q[1],y=q[2],z=q[3];
  const tx=2*(y*v[2]-z*v[1]), ty=2*(z*v[0]-x*v[2]), tz=2*(x*v[1]-y*v[0]);
  return [v[0]+w*tx+(y*tz-z*ty), v[1]+w*ty+(z*tx-x*tz), v[2]+w*tz+(x*ty-y*tx)];
}
const qinv=q=>[q[0],-q[1],-q[2],-q[3]];
function eulerToQ(psi,theta,phi){ const cy=Math.cos(psi/2),sy=Math.sin(psi/2),cp=Math.cos(theta/2),sp=Math.sin(theta/2),cr=Math.cos(phi/2),sr=Math.sin(phi/2);
  return [cr*cp*cy+sr*sp*sy, sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy]; }
function qToEuler(q){ const [w,x,y,z]=q;
  const phi=Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)); const theta=Math.asin(clamp(2*(w*y-z*x),-1,1)); let psi=Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z)); if(psi<0) psi+=2*Math.PI;
  return {psi,theta,phi}; }
const ned2w=v=>[v[1],-v[2],-v[0]], w2ned=v=>[-v[2],v[0],-v[1]];
const b2w=(q,b)=>ned2w(qrot(q,b)), w2b=(q,w)=>qrot(qinv(q),w2ned(w));
/* ---- 標準大気 ---- */
function atmos(h){ h=Math.max(-400,h); let T,p;
  if(h<11000){ T=288.15-0.0065*h; p=101325*Math.pow(T/288.15,5.25588); } else { T=216.65; p=22632.06*Math.exp(-(h-11000)/6341.62); }
  const rho=p/(287.058*T); return { T,p,rho,a:Math.sqrt(1.4*287.058*T),sigma:rho/1.225 }; }
/* ---- 機体諸元 ---- */
const AC = { name:"Boeing 737-800", S:124.6, b:34.3, c:4.17, emptyMass:41400, payload:7000, fuelMax:20800,
  Ixx:1.15e6, Iyy:3.4e6, Izz:4.3e6, Tmax:121000, vmo:340*KT, mmo:0.82, flapSpeeds:[999,250,235,225,215,195,190,185,162].map(v=>v*KT),
  flapLabels:[0,1,2,5,10,15,25,30,40], vgearOp:235*KT, vgearExt:270*KT,
  // 接地点（機体軸: 前, 右, 下。重心基準）。脚の車輪は接地点（タイヤ下端）
  gear:[ {n:"nose", p:[13.0, 0.0,3.85], k:4.5e5, c:7e4, steer:true},
         {n:"mainL",p:[-1.3,-3.6,3.85], k:1.25e6,c:1.6e5, brake:true},
         {n:"mainR",p:[-1.3, 3.6,3.85], k:1.25e6,c:1.6e5, brake:true} ],
  hard:[ {n:"tail",p:[-17.0,0,1.2],m:"尾部を滑走路に擦りました"}, {n:"belly",p:[-3.0,0,2.2],m:"胴体が地面に接触しました（脚が出ていません）"}, {n:"nose",p:[17.5,0,1.8],m:"機首が地面に接触しました"},
         {n:"engL",p:[3.5,-5.1,2.35],m:"エンジンが地面に接触しました"}, {n:"engR",p:[3.5,5.1,2.35],m:"エンジンが地面に接触しました"},
         {n:"wingL",p:[-5.0,-16.6,-0.4],m:"翼端が地面に接触しました"}, {n:"wingR",p:[-5.0,16.6,-0.4],m:"翼端が地面に接触しました"} ] };
// フラップ段(0,1,2,5,10,15,25,30,40) → [CL0増, CLmax, CD0増]
const FLAP=[[0,1.45,0],[0.10,1.58,0.004],[0.17,1.70,0.007],[0.28,1.92,0.012],[0.40,2.08,0.018],[0.48,2.20,0.026],[0.60,2.36,0.040],[0.70,2.48,0.054],[0.80,2.60,0.074]];
function flapParams(f){ const i=clamp(Math.floor(f),0,FLAP.length-1), j=Math.min(FLAP.length-1,i+1), t=clamp(f-i,0,1), a=FLAP[i], b=FLAP[j]; return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]; }

function createState(o){ o=o||{};
  return { pos:o.pos||[0,0,0], vel:o.vel||[0,0,0], q:eulerToQ(o.psi||0,o.theta||0,o.phi||0), w:[0,0,0],     // w = (p,q,r) 機体角速度（右翼下げ+, 機首上げ+, 機首右+）
    fuel:o.fuel!=null?o.fuel:6000, flaps:o.flaps||0, flapsTarget:o.flaps||0, gear:o.gear!=null?o.gear:1, gearTarget:o.gear!=null?o.gear:1,
    thr:[o.thr||0,o.thr||0], speedbrake:0, brake:0, rev:0, parking:!!o.parking, trim:o.trim||0, elev:0, ail:0, rud:0, nws:0,
    onGround:false, crashed:false, crashMsg:"", t:0, stallWarn:false, stalled:false, overspeed:false, gearForce:[0,0,0], hardHit:{},
    aoa:0, beta:0, cas:0, mach:0, nz:1, tas:0, radAlt:99, gust:[0,0,0], windUsed:[0,0,0], touchdownVs:null, groundSpoilers:false,
    fwd:[0,0,-1], right:[1,0,0], down:[0,-1,0], psi:0, theta:0, phi:0, gs:0, vs:0 };
}
function derived(s){ const e=qToEuler(s.q); s.psi=e.psi; s.theta=e.theta; s.phi=e.phi;
  s.fwd=b2w(s.q,[1,0,0]); s.right=b2w(s.q,[0,1,0]); s.down=b2w(s.q,[0,0,1]); s.gs=Math.hypot(s.vel[0],s.vel[2]); s.vs=s.vel[1]; }
const slew=(cur,tgt,rate,dt)=>{ const d=tgt-cur; return Math.abs(d)<=rate*dt?tgt:cur+Math.sign(d)*rate*dt; };

/* ---- 1 ステップ ----
   env: { groundAt(x,z) -> {h, kind:'runway'|'grass'|'water'}, wind:[x,y,z] (世界, 風が向かう方向), turb:0..1 } */
function step(s, ctl, env, dt){
  const a = atmos(s.pos[1]);
  // 操作系の動き
  if(ctl.flapsTarget!=null) s.flapsTarget=ctl.flapsTarget;
  if(ctl.gearTarget!=null) s.gearTarget=ctl.gearTarget;
  s.flaps = slew(s.flaps, s.flapsTarget, 0.14, dt);
  s.gear = slew(s.gear, s.gearTarget, 1/8, dt);
  s.speedbrake = slew(s.speedbrake, ctl.speedbrake||0, 0.7, dt);
  s.brake = slew(s.brake, ctl.brake||0, 4, dt);
  s.rev = slew(s.rev, (ctl.reverse&&s.onGround)?1:0, 0.8, dt);
  s.elev = slew(s.elev, clamp(ctl.elevator||0,-1,1), 6, dt); s.ail = slew(s.ail, clamp(ctl.aileron||0,-1,1), 8, dt); s.rud = slew(s.rud, clamp(ctl.rudder||0,-1,1), 6, dt);
  s.nws = clamp(ctl.nws||0,-1,1)*0.9;           // ステアリング（前輪の最大切れ角 約 52°）
  s.trim = clamp(ctl.trim!=null?ctl.trim:s.trim,-1,1);
  s.parking = ctl.parking!=null ? !!ctl.parking : s.parking;
  const thc=clamp(ctl.throttle||0,0,1);
  for(let i=0;i<2;i++){ const tgt = (ctl.eng && ctl.eng[i]===false || s.fuel<=0) ? 0 : thc; s.thr[i]=slew(s.thr[i], tgt, tgt>s.thr[i] ? (s.thr[i]<0.55?0.30:0.8) : 0.5, dt); }
  // 乱気流（相関のある突風）
  const tb=env.turb||0; { const k=Math.exp(-dt/1.5), sg=tb*2.2*Math.sqrt(1-k*k); for(let i=0;i<3;i++) s.gust[i]=s.gust[i]*k+sg*(Math.random()*2-1)*(i===1?0.6:1); }
  const wind=[env.wind[0]+s.gust[0], env.wind[1]+s.gust[1], env.wind[2]+s.gust[2]]; s.windUsed=wind;
  // 速度（対気・機体軸）
  const vair = [s.vel[0]-wind[0], s.vel[1]-wind[1], s.vel[2]-wind[2]];
  const vb = w2b(s.q, vair), u=vb[0], v=vb[1], w=vb[2];
  const V = Math.max(1, Math.hypot(u,v,w));
  const alpha = Math.atan2(w, Math.max(0.5,u)), beta = Math.asin(clamp(v/V,-1,1));
  const mach = V/a.a, qbar = 0.5*a.rho*V*V;
  { const pt=a.p*Math.pow(1+0.2*mach*mach,3.5); s.cas = 340.294*Math.sqrt(5*(Math.pow((pt-a.p)/101325+1,2/7)-1)); }
  s.aoa=alpha; s.beta=beta; s.tas=V; s.mach=mach;
  const mass = AC.emptyMass+AC.payload+s.fuel;
  // ---- 空力 ----
  const [dCL0,CLmaxF,dCD0] = flapParams(s.flaps);
  const aSlope = 5.0/Math.sqrt(Math.max(0.5,1-0.65*mach*mach));
  const CL0 = 0.18+dCL0, aStall = (CLmaxF-CL0)/aSlope + 0.03;
  const aLin = aStall-0.06;
  let CL;
  if(alpha<=aLin) CL = CL0+aSlope*alpha;
  else if(alpha<=aStall){ const t=(alpha-aLin)/0.06; CL = CL0+aSlope*aLin + aSlope*0.06*(t-0.5*t*t)*(1.0); }       // 頂点に向かって傾きが 0 へ
  else { const t=alpha-aStall; CL = CL0+aSlope*aLin + aSlope*0.06*0.5 - 1.1*t - 0.6*Math.max(0,t-0.12); }
  if(alpha<-0.3) CL = CL0+aSlope*-0.3;
  s.stalled = alpha>aStall && !s.onGround; s.stallWarn = alpha>aStall-0.05 && s.radAlt>3;
  const hAGL = Math.max(1, s.radAlt+3.6);      // 主翼の高さ（地面効果）
  const ge = 1/(1+ 30*Math.pow(hAGL/AC.b,1.6));
  CL*= (1+0.08*ge);
  const spoil = Math.max(s.speedbrake, s.groundSpoilers?1:0);
  CL*= (1-0.30*spoil);
  const gearAmt = s.gear;
  let CD = 0.0210 + dCD0 + 0.0170*gearAmt + (0.043*(1-0.5*ge))*CL*CL + 0.055*spoil;
  if(mach>0.77) CD += 30*Math.pow(mach-0.77,2.6);                    // 造波抗力
  if(alpha>aStall) CD += 0.9*(alpha-aStall);
  CD += 0.9*beta*beta;
  const cA=Math.cos(alpha), sA=Math.sin(alpha), Lf=qbar*AC.S*CL, Df=qbar*AC.S*CD;
  let Fx = -Df*cA + Lf*sA, Fz = -Df*sA - Lf*cA, Fy = qbar*AC.S*(-0.95*beta - 0.12*s.rud);      // 右ペダルで尾翼の力は左向き → 機首が右へ
  // ---- 推力 ----
  const Mf = Math.max(0.2, 1-0.45*mach+0.12*mach*mach), Tav = AC.Tmax*Math.pow(a.sigma,0.82)*Mf;
  const idle=0.032, thF = th => th<0.01 ? idle : idle+(1-idle)*Math.pow(th,1.15);
  const TL = Tav*thF(s.thr[0]), TR = Tav*thF(s.thr[1]);
  const revK = s.rev*(0.38*(V>12?1:0.5));                            // 逆噴射: 前進推力を反転して約 38%
  const Teff = (TL+TR)*(1-s.rev) - (TL+TR)*revK;
  Fx += Teff;
  // 推力による機首上げ（エンジンは重心より低い）とヨー（左右差）
  const Mthr = -(TL+TR)*0.9*(1-s.rev)*0.0;                            // 微小: 無視
  const Nthr = (TR-TL)*5.1*(1-s.rev);                                 // 右が強いと機首左 → ヨーは -。TL が強い → 右へ(+)  →  N = (TL-TR)*5.1
  const Nthr2 = (TL-TR)*5.1*(1-s.rev);
  const sfc = (0.040+0.025*mach)/3600;                                 // kg/(N·s)
  s.fuel = Math.max(0, s.fuel - sfc*(TL*(s.thr[0]>0.005?1:0.0)+TR*(s.thr[1]>0.005?1:0.0))*dt);
  // ---- 重力（機体軸へ） ----
  const gb = qrot(qinv(s.q),[0,0,G*mass]);
  // ---- 地面との接触 ----
  let Fgx=0,Fgy=0,Fgz=0,Lg=0,Mg=0,Ng=0; let anyContact=false; let minClear=1e9; const gf=[0,0,0]; s.hardHit={};
  const pts=[]; if(s.gear>0.8) AC.gear.forEach((g,i)=>pts.push({g,i,hard:false})); AC.hard.forEach((g,i)=>pts.push({g,i:10+i,hard:true}));
  const w3=s.w; // 角速度
  const velB = w2b(s.q, s.vel);                                  // 地面に対する機体軸速度
  for(const P of pts){
    const pb=P.g.p, pw=b2w(s.q,pb); const wx=s.pos[0]+pw[0], wy=s.pos[1]+pw[1], wz=s.pos[2]+pw[2];
    const gr = env.groundAt(wx,wz);
    const clr = wy - gr.h; minClear=Math.min(minClear, P.hard?clr+9:clr);   // 脚の接地点の対地高さ（接地点は車輪下端）
    if(clr>=0) continue;
    const pen=-clr; anyContact=true;
    // 接地点の速度（機体軸）= v + ω × r
    const vpt=[velB[0]+(w3[1]*pb[2]-w3[2]*pb[1]), velB[1]+(w3[2]*pb[0]-w3[0]*pb[2]), velB[2]+(w3[0]*pb[1]-w3[1]*pb[0])];
    const vptW = b2w(s.q,vpt);                                    // 世界座標の速度 (x東,y上,z南)
    if(P.hard){
      if(!s.crashed && V>10 && pen>0.12){ s.crashed=true; s.crashMsg=P.g.m; }
      s.hardHit[P.g.n]=pen;
      const N = Math.min(8e6, 2.0e6*pen) + Math.max(0,-vptW[1])*1.5e5;   // 接触面の強い反力
      const fw = [ -vptW[0]*Math.min(3e4*pen+2e4,1e5)*0.4, N, -vptW[2]*Math.min(3e4*pen+2e4,1e5)*0.4 ];
      const fb = w2b(s.q,fw); Fgx+=fb[0]; Fgy+=fb[1]; Fgz+=fb[2];
      Lg+=pb[1]*fb[2]-pb[2]*fb[1]; Mg+=pb[2]*fb[0]-pb[0]*fb[2]; Ng+=pb[0]*fb[1]-pb[1]*fb[0];
      continue;
    }
    // 脚: ばね・ダンパ
    const Pg=P.g, comp=Math.min(pen,0.7);
    let N = Pg.k*comp - Pg.c*vptW[1]; if(N<0) N=0;                 // ばね＋ダンパ（上向き速度が正）
    if(N<=0) continue;
    gf[P.i]=N;
    if(!s.crashed && -vptW[1]>7.5 && N>5e4){ s.crashed=true; s.crashMsg="降下率が大きすぎて脚が壊れました（"+(-vptW[1]).toFixed(1)+" m/s）"; }
    if(s.touchdownVs==null && !s.onGround && P.g.n!=="nose") s.touchdownVs = vptW[1];
    // 車輪の進行方向（水平面）
    let fw = b2w(s.q,[1,0,0]); fw=[fw[0],0,fw[2]]; const fl=Math.hypot(fw[0],fw[2])||1; fw=[fw[0]/fl,0,fw[2]/fl];
    const rt0=[-fw[2],0,fw[0]]; // 前が (0,0,-1)（北）のとき右(東)=(1,0,0) → [-(-1),0,0]=(1,0,0) ✓
    const st = Pg.steer ? s.nws : 0, cs=Math.cos(st), sn=Math.sin(st);
    const wf=[fw[0]*cs+rt0[0]*sn,0,fw[2]*cs+rt0[2]*sn], wr=[-wf[2],0,wf[0]];
    const vf=vptW[0]*wf[0]+vptW[2]*wf[2], vr=vptW[0]*wr[0]+vptW[2]*wr[2];
    const surf = gr.kind==="runway"?1:(gr.kind==="grass"?0.45:(gr.kind==="water"?0.12:0.8));
    const bk = Pg.brake ? (s.parking?1:s.brake):0;
    const wetK = gr.kind==="grass" ? 0 : (s.wet||0);                 // 雨・霧で舗装が濡れている度合い（制動 -27%・横力 -10% 程度）
    const mu = Math.min(1.0,(0.018+(gr.kind==="grass"?0.10:0)) + bk*0.52*surf*(1-0.32*wetK));
    const Ff = -Math.tanh(vf/0.4)*mu*N;                           // 前後（転がり抵抗＋ブレーキ）
    const Fr = -Math.tanh(vr/0.35)*0.85*surf*(1-0.12*wetK)*N;                  // 横（タイヤの横力）
    const fW=[wf[0]*Ff+wr[0]*Fr, N, wf[2]*Ff+wr[2]*Fr];
    const fb=w2b(s.q,fW); Fgx+=fb[0]; Fgy+=fb[1]; Fgz+=fb[2];
    Lg+=pb[1]*fb[2]-pb[2]*fb[1]; Mg+=pb[2]*fb[0]-pb[0]*fb[2]; Ng+=pb[0]*fb[1]-pb[1]*fb[0];
  }
  const wasGround=s.onGround; s.onGround = anyContact && (gf[0]+gf[1]+gf[2])>2e4;
  { const g0=env.groundAt(s.pos[0],s.pos[2]); s.radAlt = Math.max(0, s.pos[1]-g0.h-(s.gear>0.5?3.85:2.5)); }
  if(!wasGround && s.onGround && s.touchdownVs!=null){ s.lastTouchVs=s.touchdownVs; }
  if(!s.onGround && s.radAlt>15) s.touchdownVs=null;
  // 自動スポイラー（接地後）
  if(s.onGround && s.groundSpoilersArmed) s.groundSpoilers=true; if(!s.onGround) s.groundSpoilers=false;
  // ---- 空力モーメント ----
  const p_=w3[0], q_=w3[1], r_=w3[2], Vs=Math.max(35,V);
  const qh=q_*AC.c/(2*Vs), ph=p_*AC.b/(2*Vs), rh=r_*AC.b/(2*Vs);
  const cmAlpha=-1.15, cmq=-24;
  let Cm = 0.025 + cmAlpha*(alpha-0.05) + cmq*qh + 0.85*clamp(s.elev,-1,1) + 0.55*s.trim - 0.12*(dCL0/0.8) + 0.02*gearAmt;
  if(alpha>aStall) Cm -= 1.2*(alpha-aStall);                       // 失速で機首下げ
  const Mpitch = qbar*AC.S*AC.c*Cm;                                // 機首上げ+
  const spoilRoll = 1-0.2*spoil;
  let Cl = -0.12*beta - 0.46*ph + 0.050*clamp(s.ail,-1,1)*spoilRoll + 0.04*rh;
  if(alpha>aStall) Cl += 0.10*Math.sin(s.t*2.3)*(alpha-aStall)*8;  // 翼落ち
  const Mroll = qbar*AC.S*AC.b*Cl;                                  // 右翼下げ+
  const Cn = 0.105*beta - 0.28*rh + 0.075*clamp(s.rud,-1,1);
  const Myaw = qbar*AC.S*AC.b*Cn + Nthr2;                          // 機首右+（Cn の符号: β>0(右から風)で右へ回す…）
  // 機体軸の合計（前: 右翼下げ L, 右: 機首上げ M, 下: 機首右 N）
  const Lt = Mroll + Lg, Mt = Mpitch + Mg, Nt = Myaw + Ng;
  const Ixx=AC.Ixx, Iyy=AC.Iyy, Izz=AC.Izz;
  s.w[0] += ((Lt + (Iyy-Izz)*q_*r_)/Ixx)*dt;
  s.w[1] += ((Mt + (Izz-Ixx)*r_*p_)/Iyy)*dt;
  s.w[2] += ((Nt + (Ixx-Iyy)*p_*q_)/Izz)*dt;
  // 地面で静止中の微小な揺れを抑える
  if(s.onGround && s.gs<1.5 && s.parking){ s.w[0]*=0.9; s.w[2]*=0.9; }
  // 姿勢更新
  const om=[s.w[0],s.w[1],s.w[2]], wl=Math.hypot(om[0],om[1],om[2]);
  if(wl>1e-10){ const ha=wl*dt/2, sn=Math.sin(ha)/wl, dq=[Math.cos(ha),om[0]*sn,om[1]*sn,om[2]*sn]; s.q=qnorm(qmul(s.q,dq)); }
  // 並進
  const Fb=[Fx+Fgx+gb[0]*0+gb[0], Fy+Fgy+gb[1], Fz+Fgz+gb[2]];
  const aw = b2w(s.q,[Fb[0]/mass,Fb[1]/mass,Fb[2]/mass]);
  s.nz = -(Fz+Fgz)/(mass*G);                                         // 機体の上向き荷重倍数
  s.vel[0]+=aw[0]*dt; s.vel[1]+=aw[1]*dt; s.vel[2]+=aw[2]*dt;
  s.pos[0]+=s.vel[0]*dt; s.pos[1]+=s.vel[1]*dt; s.pos[2]+=s.vel[2]*dt;
  if(s.crashed){ const g0=env.groundAt(s.pos[0],s.pos[2]); if(s.pos[1]<g0.h+1){ s.pos[1]=g0.h+1; if(s.vel[1]<0) s.vel[1]=0; const k=Math.pow(0.35,dt); s.vel[0]*=k; s.vel[2]*=k; s.w[0]*=k; s.w[1]*=k; s.w[2]*=k; } }
  s.overspeed = s.cas>AC.vmo+3 || mach>AC.mmo+0.01;
  s.aStall=aStall; s.CL=CL; s.CD=CD; s.mass=mass; s.thrustN=Teff; s.Tav=Tav; s.t+=dt; s.gearForce=gf;
  derived(s); return s;
}
root.FDM = { step, createState, derived, AC, atmos, eulerToQ, qToEuler, b2w, w2b, ned2w, w2ned, qrot, flapParams, G, KT, clamp };
})(typeof window!=="undefined"?window:globalThis);
