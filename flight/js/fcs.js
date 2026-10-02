/* 操縦系統（FBW 風の補助）とオートパイロット。 FDM の ctl（elevator/aileron/rudder/throttle ほか）を作る。
   補助 ON: 操縦桿は「縦=経路角の変化率」「横=ロールレート」を指令、離すと経路角・バンクを保持（バンク 5° 以内は水平へ）。ラダーは自動で旋回を協調。
   補助 OFF: 操縦桿は舵面をそのまま動かす（上級者向け）。 */
(function(root){
"use strict";
const F = root.FDM, D2R=Math.PI/180, KT=0.514444, G=9.80665, clamp=F.clamp;
function norm180(a){ a=((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI; return a; }
function create(){ return { K:{kg:0.32,kn:0.075,ki:0.2,kq:0.62,gmax:0.05,fh:30,fs:0.12,ff:0.20}, assist:true, gammaHold:0, phiHold:0, eInt:0, aInt:0, thrInt:0, thrCmd:0, pitchTrimAuto:0, last:{},
  ap:{ on:false, athr:false, latMode:"HDG", vertMode:"ALT", hdg:0, alt:3000, vs:0, spd:250*KT, mach:null, spdIsMach:false, wpIndex:0, route:null, loc:null, appr:false, autoland:false, status:"" },
  // 内部
  _flare:false }; }
// ゲイン調整用の動圧スケール（基準 6000 Pa）
const qscale=(q)=>clamp(6000/Math.max(1500,q),0.35,3.2);

function compute(c, s, pilot, env, dt){
  const a=F.atmos(s.pos[1]), V=Math.max(30,s.tas), qbar=0.5*a.rho*V*V, sc=qscale(qbar);
  const ap=c.ap; const gammaNow=Math.atan2(s.vel[1], Math.max(1,s.gs));
  const ctl={ elevator:0, aileron:0, rudder:0, throttle:pilot.throttle, brake:pilot.brake, parking:pilot.parking, speedbrake:pilot.speedbrake, reverse:pilot.reverse,
              flapsTarget:pilot.flapsTarget, gearTarget:pilot.gearTarget, trim:pilot.trim, nws:0, eng:pilot.eng, groundSpoilers:false };
  let pIn=pilot.pitch, rIn=pilot.roll, yIn=pilot.yaw;
  // ---- オートパイロット（縦・横の指令を作る） ----
  let apGamma=null, apPhi=null, apSpdThr=null;
  if(ap.on){
    // 横
    if(ap.latMode==="HDG"){ const e=norm180(ap.hdg-s.psi); apPhi=clamp(e*1.6,-25*D2R,25*D2R); }
    else if(ap.latMode==="LNAV" && ap.route && ap.wpIndex<ap.route.length){
      const wp=ap.route[ap.wpIndex], dx=wp.x-s.pos[0], dz=wp.z-s.pos[2]; const dist=Math.hypot(dx,dz);
      const brg=Math.atan2(dx,-dz); // 北=0 東=+
      const turnR=s.gs*s.gs/(G*Math.tan(25*D2R)); const reach=Math.max(1500,turnR*0.9);
      if(dist<reach && ap.wpIndex<ap.route.length-1){ ap.wpIndex++; }
      let e=norm180(brg-s.psi); apPhi=clamp(e*1.4,-25*D2R,25*D2R);
      ap.status="→ "+(wp.name||("WP"+ap.wpIndex))+" "+(dist/1852).toFixed(0)+"NM";
    } else if(ap.latMode==="LOC" && ap.loc){
      const L=ap.loc; // L: {x,z,crs(rad), } 滑走路しきい値と進入方位
      const relx=s.pos[0]-L.x, relz=s.pos[2]-L.z; const fx=Math.sin(L.crs), fz=-Math.cos(L.crs);   // 進入方向（滑走路に向かう向き）
      const along = relx*fx+relz*fz, cross = relx*(-fz)*-1 + relz*(fx)*-1;                          // along<0 なら手前
      const rx=-fz, rz=fx; const xt = relx*rx+relz*rz;   // 右方向への横ずれ(m)（右が正）
      const dist=-along;                                  // しきい値までの距離（手前が正）
      ap.xt=xt; ap.distThr=dist;
      const trk=Math.atan2(s.vel[0],-s.vel[2]);            // 対地進行方位（風があっても滑走路の延長線に乗せる）
      const gsp=Math.max(40,s.gs), dlt=clamp(-xt/(gsp*22), -0.6, 0.6);
      const e=norm180(L.crs + dlt - trk); apPhi=clamp(e*2.0,-25*D2R,25*D2R);
      ap.status="LOC "+(xt>=0?"R":"L")+Math.abs(xt).toFixed(0)+"m";
    }
    // 縦
    if(ap.vertMode!=="FLCH") c.fInit=null;
    if(ap.vertMode!=="GS"){ c.gsCap=false; c.gsHold=null; }
    if(ap.latMode!=="LOC") c.locI=0;
    if(ap.vertMode==="ALT"){ const e=ap.alt-s.pos[1]; const vsT=clamp(e*0.045,-13,13); // 目標 vs
      const sp=Math.max(0.05,V); apGamma=Math.asin(clamp(vsT/sp,-0.25,0.25)); }
    else if(ap.vertMode==="VS"){ apGamma=Math.asin(clamp(ap.vs/Math.max(0.05,V),-0.25,0.25)); }
    else if(ap.vertMode==="FLCH"){   // 速度を機首上げ下げで保ち、推力は上昇=高め／降下=アイドル。目標高度が近づいたら ALT に移る
      const dh=ap.alt-s.pos[1];
      if(Math.abs(dh)<Math.max(45, Math.abs(s.vel[1])*7)){ ap.vertMode="ALT"; }
      else {
        let tgtCas=ap.spd; if(ap.spdIsMach && ap.mach){ const m=ap.mach, pt=a.p*Math.pow(1+0.2*m*m,3.5), qc=pt-a.p; tgtCas=340.294*Math.sqrt(5*(Math.pow(qc/101325+1,2/7)-1)); }
        if(c.fInit!==ap.vertMode){ c.fInit=ap.vertMode; c.fInt=clamp(gammaNow,-0.1,0.2); }
        const es=s.cas-tgtCas;   // 速すぎ(+) → もっと上げる
        c.fInt=clamp(c.fInt+es*0.0012*dt, -0.08, 0.2);
        apGamma = clamp(c.fInt + es*0.006, dh>0?-0.02:-0.12, dh>0?0.2:0.02);
        ap.flchThr = dh>0 ? 0.82 : 0.0;
      }
    }
    else if(ap.vertMode==="GS" && ap.loc){
      const L=ap.loc, relx=s.pos[0]-L.x, relz=s.pos[2]-L.z; const fx=Math.sin(L.crs), fz=-Math.cos(L.crs);
      const dist=-(relx*fx+relz*fz); const gsAlt=L.h + Math.tan(L.gs||3*D2R)*Math.max(0,dist+(L.aim==null?300:L.aim)); const err=s.pos[1]-gsAlt;   // 滑走路を通る面から上がプラス
      ap.gsErr=err;
      if(!c.gsCap && err>-25 && err<40) c.gsCap=true;          // グライドパスを横切ったら捕捉
      if(!c.gsCap && err>=40){ apGamma=-0.085; }     // グライドパスより高い: 5° で降りて上から捕捉
      else if(!c.gsCap){ const vsT=clamp((c.gsHold!=null?c.gsHold-s.pos[1]:0)*0.045,-6,6); if(c.gsHold==null) c.gsHold=s.pos[1]; apGamma=Math.asin(clamp(vsT/Math.max(30,V),-0.1,0.1)); }
      else apGamma = -(L.gs||3*D2R)*1.0 - clamp(err*0.0025,-0.05,0.05);
      if(s.radAlt<c.K.fh){ const vsT=-clamp(s.radAlt*c.K.fs+c.K.ff, c.K.ff, 4.2); apGamma=Math.asin(clamp(vsT/Math.max(30,V),-0.2,0.2)); }   // フレア: 高度に応じて降下率を絞る
    }
    // 自動推力
    if(!ap.athr) c.athrWas=false; else if(!c.athrWas){ c.athrWas=true; c.thrInt=clamp(0.5*(s.thr[0]+s.thr[1]),0,1); }
    if(ap.athr && ap.vertMode==="FLCH" && ap.flchThr!=null){ apSpdThr=ap.flchThr; c.thrInt=ap.flchThr; }
    else if(ap.athr){
      let tgtCas = ap.spd; if(ap.spdIsMach && ap.mach){ // マッハ→CAS 近似
        const m=ap.mach; const pt=a.p*Math.pow(1+0.2*m*m,3.5); const qc=pt-a.p; tgtCas=340.294*Math.sqrt(5*(Math.pow(qc/101325+1,2/7)-1)); }
      const e=tgtCas-s.cas; c.thrInt=clamp(c.thrInt+e*0.00035*dt*60*0.5, -0.5, 1); apSpdThr = clamp(c.thrInt + e*0.045 + (s.vel[1]*0.0)*0, 0.0, 1);
      // 上昇・降下で推力の目安を持つ（積分が追いつくまで）
      if(c.thrInt!==c.thrInt) c.thrInt=0;
    }
  }
  // ---- 補助（縦） ----
  const onGround=s.onGround;
  if(c.assist && !onGround){
    const stickP = Math.abs(pIn)>0.03;
    let gdCmd;
    if(apGamma!=null && !stickP){ gdCmd = clamp((apGamma-gammaNow)*c.K.kg, -c.K.gmax, c.K.gmax); c.gammaHold=apGamma; }
    else if(stickP){ gdCmd = pIn*0.05; c.gammaHold=gammaNow; }
    else { gdCmd = clamp((c.gammaHold-gammaNow)*0.9,-0.06,0.06); }
    // 荷重倍数の指令
    const cosphi=Math.max(0.5,Math.cos(s.phi));
    let nzc = (V*gdCmd/G + Math.cos(gammaNow))/cosphi;
    // 失速防止: 迎角が失速迎角に近づいたら引き起こしを抑える
    const aLim = s.aStall-0.055; if(s.aoa>aLim) nzc = Math.min(nzc, s.nz - (s.aoa-aLim)*14);
    if(s.aoa<-0.12) nzc=Math.max(nzc, s.nz+(-0.12-s.aoa)*8);
    nzc = clamp(nzc, -0.2, 2.2);
    const e = nzc - s.nz;
    c.eInt = clamp(c.eInt + e*dt*c.K.ki*sc, -0.45, 0.45);
    ctl.elevator = clamp( (c.K.kn*e*sc + c.eInt) - c.K.kq*s.w[1]*Math.min(1.5,sc) , -1, 1);
    // 速度超過防止
    if(s.cas>F.AC.vmo-3 || s.mach>F.AC.mmo-0.008){ c.eInt = clamp(c.eInt + 0.0, -0.45,0.45); ctl.elevator = clamp(ctl.elevator+0.12, -1, 1); }
  } else if(c.assist && onGround){
    ctl.elevator = clamp(pIn*0.9 + 0.0, -1,1); c.eInt*=0.98; c.gammaHold=gammaNow;
  } else { ctl.elevator = clamp(pIn,-1,1); }
  // ---- 補助（横） ----
  if(c.assist && !onGround){
    const stickR = Math.abs(rIn)>0.03; let pCmd;
    if(stickR){ pCmd = rIn*0.30; c.phiHold=s.phi; }
    else if(apPhi!=null){ pCmd = clamp((apPhi-s.phi)*1.1,-0.2,0.2); c.phiHold=apPhi; }
    else { if(Math.abs(c.phiHold)<5*D2R) c.phiHold=0; pCmd = clamp((c.phiHold-s.phi)*1.2,-0.2,0.2); }
    // 傾き制限: 35°（入力時 45°）を超えたら戻す
    const lim = stickR?45*D2R:35*D2R; if(s.phi>lim && pCmd>0) pCmd=0; if(s.phi<-lim && pCmd<0) pCmd=0;
    if(Math.abs(s.phi)>60*D2R) pCmd = clamp(-s.phi*1.2,-0.3,0.3);
    const ep = pCmd - s.w[0];
    c.aInt = clamp(c.aInt + ep*dt*0.12*sc, -0.35, 0.35);
    ctl.aileron = clamp(0.9*ep*sc + c.aInt*0.0 , -1, 1) ;
    // 旋回の協調（ヨーダンパ）+ ペダル
    const rCoord = (G/V)*Math.sin(s.phi)*Math.cos(s.theta);
    ctl.rudder = clamp( (rCoord - s.w[2])*1.6*Math.min(2.0,sc) + s.beta*1.0*Math.min(2.0,sc) + yIn*0.6, -1, 1);
  } else if(c.assist && onGround){
    if(ap.on && ap.latMode==="LOC" && ap.loc && ap.xt!=null && s.gs>20){ yIn = clamp(yIn + norm180(ap.loc.crs-s.psi)*2.2 - ap.xt*0.004, -0.6, 0.6); }   // ローカライザーに沿って滑走
    ctl.aileron = clamp(rIn*0.7,-1,1); ctl.rudder = clamp(yIn,-1,1); ctl.nws = clamp(yIn,-1,1);
    if(s.gs>45) { ctl.nws = clamp(yIn*0.35,-1,1); }
    c.phiHold=0; c.aInt=0;
  } else { ctl.aileron=clamp(rIn,-1,1); ctl.rudder=clamp(yIn,-1,1); ctl.nws = onGround?clamp(yIn,-1,1):0; }
  // 地上: 前輪操舵は低速ほど大きく
  if(onGround){ const k = s.gs<12?1:(s.gs<45?0.5:0.2); ctl.nws = clamp(yIn,-1,1)*k; }
  // ---- 推力 ----
  if(ap.on && ap.athr && apSpdThr!=null){
    let t=apSpdThr;
    // フレア: 高度 7m 未満（機体下面）でアイドル
    if(ap.vertMode==="GS" && s.radAlt<12) { t=Math.min(t,0.0); }
    ctl.throttle = t; c.thrCmd=t;
  }
  // 逆噴射・スポイラ・オートブレーキ
  if(s.onGround && pilot.autobrake>0 && s.gs>2 && !pilot.brake){ ctl.brake = [0,0.28,0.42,0.55,0.9][Math.min(4,pilot.autobrake|0)]; }   // 1=LOW 2=MED 3=HIGH 4=MAX
  if(s.onGround && s.gs>15 && pilot.spoilerArm) ctl.groundSpoilers=true;
  return ctl;
}
root.FCS = { create, compute, norm180 };
})(typeof window!=="undefined"?window:globalThis);
