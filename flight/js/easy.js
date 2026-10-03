/* かんたんモード: 進む道を青いライン（ゲート）で空中に描き、いま押すキーを案内する。
   ・青いライン: 経由地 → 最終進入点 → 滑走路 を結ぶ道。コースからずれていると、ラインがそこへ戻る向きに曲がる。
     高さは「巡航高度／3°の降下路／5°の上昇」から決める（ILS の降下路と同じ 3°）。
   ・案内パネル: 向き・高さ・速度・設定（ギア／フラップ等）について、いまやること と そのキーを表示する。
   操縦そのものは変えない（キー操作はこれまでどおり）。 */
(function(root){
"use strict";
const F=root.FDM, KT=F.KT, FT=0.3048, D2R=Math.PI/180, NM=1852;
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const n180=a=>{ while(a>Math.PI) a-=2*Math.PI; while(a<-Math.PI) a+=2*Math.PI; return a; };
const CRUISE_ALT=35000*FT, CLIMB_TAN=Math.tan(5*D2R), GLIDE_TAN=Math.tan(3*D2R);
const MAXN=40;                     // ゲートの最大数
const FRAME_W=100, FRAME_H=50;      // ゲートの大きさ [m]
const GROUND_N=90;                 // 地上の破線の最大数
const TAXI=root.TAXI;
const fmt=(n)=>Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",");
const kc=(...ks)=>ks.map(k=>"<kbd>"+k+"</kbd>").join('<i>/</i>');

class Easy{
  constructor(THREE,scene,game){
    const T=this.T=THREE; this.game=game; this.on=true; this.t=0; this.accum=1; this.routeRef=null; this.idx=0; this.start=null; this.last="";
    try{ const v=localStorage.getItem("okfl_easy"); if(v==="0") this.on=false; }catch(e){}
    const box=new T.BoxGeometry(1,1,1);
    const mk=(color,op)=>new T.MeshBasicMaterial({color,transparent:true,opacity:op,fog:false,depthWrite:false});
    this.gates=new T.InstancedMesh(box,mk(0x1f8fff,0.92),MAXN*4); this.line=new T.InstancedMesh(box,mk(0x58c4ff,0.95),MAXN);
    this.ground=new T.InstancedMesh(box,mk(0x58c4ff,0.95),GROUND_N);      // 地上走行用: 誘導路に敷く青い破線
    for(const m of [this.gates,this.line,this.ground]){ m.frustumCulled=false; m.count=0; m.renderOrder=5; scene.add(m); }
    this.m4=new T.Matrix4(); this.q=new T.Quaternion(); this.pv=new T.Vector3(); this.sv=new T.Vector3(); this.zax=new T.Vector3(0,0,1); this.dir=new T.Vector3(); this.qy=new T.Quaternion(); this.yax=new T.Vector3(0,1,0);
    this.el=document.getElementById("easy");
    this.info={};
  }
  setOn(v){ this.on=!!v; try{ localStorage.setItem("okfl_easy",this.on?"1":"0"); }catch(e){} if(!this.on){ this.gates.count=0; this.line.count=0; this.ground.count=0; if(this.el) this.el.style.display="none"; } this.game.easyOn=this.on; this.game.updateHints&&this.game.updateHints(); }
  toggle(){ this.setOn(!this.on); this.game.say(this.on?"かんたんモード ON（青いラインと操作ガイド）":"かんたんモード OFF","#58c4ff",2); return this.on; }

  // ---- 目的地の滑走路（しきい値・延長線） ----
  dest(){
    const g=this.game; const d=g.destRwy||g.rwyFocus; if(!d) return null; const nm=d.name||d.rwy; const re=g.ap.runwayEnd(d.icao,nm); if(!re) return null;
    const e=re.e; return {icao:d.icao,name:nm,x:e.x,z:e.z,ux:e.ux,uz:e.uz,h:re.h,L:re.r.L,hdg:e.hdg};
  }
  // ---- 経路（水平）: 現在の脚に沿い、ずれていればそこへ戻る ----
  buildPath(){
    const g=this.game, s=g.s, X=s.pos[0], Z=s.pos[2]; const dst=this.dest();
    if(this.routeRef!==g.route){ this.routeRef=g.route; this.idx=0; this.start={x:X,z:Z}; this.depDone=false; this.base0=s.onGround?T_h(g,X,Z):s.pos[1]; this.anchor=null; this.segMin=0; }
    const wps=[]; const rt=g.route||[];
    // 離陸直後は滑走路の延長線をまっすぐ
    const tr=g.takeoffRwy; let dep=null;
    if(tr&&!this.depDone){ const rw=g.takeoffRef?g.ap.runwayEnd(g.takeoffRef.icao,g.takeoffRef.name):null; const L=rw?rw.r.L:3000; dep={x:tr.x+tr.ux*(L+2800),z:tr.z+tr.uz*(L+2800),name:"滑走路の延長線",startX:tr.x,startZ:tr.z};
      const along=(X-tr.x)*tr.ux+(Z-tr.z)*tr.uz; if(g.stats.liftoff&&(along>L+300||s.radAlt>450)) this.depDone=true; }
    // 通過した経由地を飛ばす
    while(this.idx<rt.length){ const w=rt[this.idx]; const dd=Math.hypot(w.x-X,w.z-Z); let pass=dd<6000;
      { const nx=this.idx<rt.length-1?rt[this.idx+1]:(dst?{x:dst.x,z:dst.z}:null); if(nx&&!(dep&&!this.depDone)&&(X-w.x)*(nx.x-w.x)+(Z-w.z)*(nx.z-w.z)>0&&dd<60000) pass=true; }   // 経由地の横を通り過ぎた（脇を通っても戻らせない）
      if(dst&&(w.name==="進入開始点"||w.name==="最終進入点")){ const dp=Math.hypot(X-dst.x,Z-dst.z), dw=Math.hypot(w.x-dst.x,w.z-dst.z); if(dp<dw+500) pass=true; }
      if(pass&&!dep) this.idx++; else if(pass&&dep&&this.depDone) this.idx++; else break; }
    if(dep&&!this.depDone) wps.push(dep);
    for(let i=this.idx;i<rt.length;i++) wps.push(rt[i]);
    const landedRoll=g.landed&&dst;
    if(dst&&!landedRoll) wps.push({x:dst.x,z:dst.z,name:"滑走路 "+dst.name,thr:true});
    if(!wps.length&&!dst) return null;
    // 最初の脚の始点
    const B=wps[0]||{x:dst.x+dst.ux*Math.min(2200,dst.L*0.8),z:dst.z+dst.uz*Math.min(2200,dst.L*0.8)}; let A;
    if(B.thr) A={x:dst.x-dst.ux*30000,z:dst.z-dst.uz*30000};
    else if(B===dep) A={x:dep.startX,z:dep.startZ};
    else if(this.idx>0&&rt[this.idx-1]) A=rt[this.idx-1]; else A=this.start;
    let ux=B.x-A.x, uz=B.z-A.z; const LAB=Math.hypot(ux,uz)||1; ux/=LAB; uz/=LAB; const nx=-uz, nz=ux;
    const at=(X-A.x)*ux+(Z-A.z)*uz, xt=(X-A.x)*nx+(Z-A.z)*nz;
    const pts=[]; let off=0, Lc=1, nrm=[nx,nz];
    if(at>=0&&at<=LAB&&Math.abs(xt)<20000){ pts.push([A.x+ux*at,A.z+uz*at]); off=xt; Lc=Math.min(clamp(Math.abs(xt)*7,2500,14000),Math.max(2000,LAB-at)); }
    else pts.push([X,Z]);
    for(const w of wps) pts.push([w.x,w.z]);
    let thrIdx=-1; if(dst&&!landedRoll) thrIdx=pts.length-1;
    if(dst){ if(landedRoll){ pts.length=0; pts.push([X,Z]); thrIdx=0; }
      pts.push([dst.x+dst.ux*Math.min(2200,dst.L*0.8),dst.z+dst.uz*Math.min(2200,dst.L*0.8)]); }
    if(landedRoll){ off=0; }
    // 累積長
    const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
    return {pts,cum,off,Lc,nrm,thrIdx,thrLen:thrIdx>=0?cum[thrIdx]:cum[cum.length-1],total:cum[cum.length-1],next:landedRoll?null:wps[0],dst,dep:!!(dep&&!this.depDone)};
  }
  // ---- 空中に固定したゲート用の経路（経路の出発点から最後まで。機体の位置では動かない）----
  anchorPath(){
    const g=this.game, rt=g.route||[], tr=g.takeoffRwy, dst=this.dest(); const dk=dst?dst.icao+dst.name:"";
    if(this.anchor&&this.anchor.rt===rt&&this.anchor.tr===tr&&this.anchor.dk===dk) return this.anchor;
    const pts=[]; const add=(x,z)=>{ const l=pts[pts.length-1]; if(!l||Math.hypot(x-l[0],z-l[1])>1) pts.push([x,z]); };
    if(tr){ const rw=g.takeoffRef?g.ap.runwayEnd(g.takeoffRef.icao,g.takeoffRef.name):null; const L=rw?rw.r.L:3000; add(tr.x,tr.z); add(tr.x+tr.ux*(L+2800),tr.z+tr.uz*(L+2800)); }
    else if(this.start) add(this.start.x,this.start.z);
    for(const w of rt) add(w.x,w.z);
    let thrIdx=-1; if(dst){ add(dst.x,dst.z); thrIdx=pts.length-1; const o=Math.min(2200,dst.L*0.8); add(dst.x+dst.ux*o,dst.z+dst.uz*o); }
    if(pts.length<2) pts.push([pts[0][0]+1,pts[0][1]]);
    const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
    this.anchor={rt,tr,dk,pts,cum,total:cum[cum.length-1],thrLen:thrIdx>=0?cum[thrIdx]:1e12,dst,hasTr:!!tr};
    this.segMin=0; return this.anchor;
  }
  anchorAt(A,sd){ const {pts,cum}=A; sd=clamp(sd,0,A.total); let i=1; while(i<pts.length-1&&cum[i]<sd) i++; const a=pts[i-1], b=pts[i]; const l=Math.max(1e-6,cum[i]-cum[i-1]); const u=clamp((sd-cum[i-1])/l,0,1); let tx=b[0]-a[0], tz=b[1]-a[1]; const tl=Math.hypot(tx,tz)||1; return {x:a[0]+(b[0]-a[0])*u,z:a[1]+(b[1]-a[1])*u,tx:tx/tl,tz:tz/tl}; }
  anchorAlt(A,sd,gh){   // 高さ: 巡航高度／出発点からの 5° 上昇／しきい値へ向かう 3° 降下
    const g=this.game; let alt=g.cruiseAlt||CRUISE_ALT;
    if(A.dst){ if(sd>A.thrLen) alt=Math.min(alt,A.dst.h+4); else alt=Math.min(alt,A.dst.h+15+(A.thrLen-sd)*GLIDE_TAN); }
    const climbS=A.hasTr?1800:0; alt=Math.min(alt,(this.base0!=null?this.base0:0)+Math.max(0,sd-climbS)*CLIMB_TAN);
    if((!A.dst||A.thrLen-sd>30000)&&sd>climbS+500) alt=Math.max(alt,gh+300);
    return alt;
  }
  at(P,sd){   // 経路上の点（ずれの補正つき）
    const {pts,cum}=P; sd=clamp(sd,0,P.total); let i=1; while(i<pts.length-1&&cum[i]<sd) i++;
    const a=pts[i-1], b=pts[i]; const l=Math.max(1e-6,cum[i]-cum[i-1]); const u=clamp((sd-cum[i-1])/l,0,1);
    let tx=b[0]-a[0], tz=b[1]-a[1]; const tl=Math.hypot(tx,tz)||1; tx/=tl; tz/=tl;
    let x=a[0]+(b[0]-a[0])*u, z=a[1]+(b[1]-a[1])*u;
    if(P.off){ let f=clamp(1-sd/P.Lc,0,1); f=f*f*(3-2*f); x+=P.nrm[0]*P.off*f; z+=P.nrm[1]*P.off*f; }
    return {x,z,tx,tz,D:Math.max(0,P.thrLen-sd)};
  }
  // ---- 高さの基準線 ----
  altProfile(P,p,sd,base,onGround){
    const dst=P.dst, g=this.game, T=g.terrain; const gh=T.heightAt(p.x,p.z);
    let alt=g.cruiseAlt||CRUISE_ALT;
    if(dst){ if(sd>P.thrLen) alt=Math.min(alt,dst.h+4); else alt=Math.min(alt,dst.h+15+p.D*GLIDE_TAN); }
    const climbS=onGround?1800:0; alt=Math.min(alt,base+Math.max(0,sd-climbS)*CLIMB_TAN);
    if((!dst||p.D>30000)&&!onGround&&base-gh>250) alt=Math.max(alt,gh+300);
    return alt;
  }
  // ---- 毎フレーム ----
  update(dt){
    const g=this.game; if(g.state!=="fly"){ this.gates.count=0; this.line.count=0; this.ground.count=0; if(this.el) this.el.style.display="none"; return; }
    this.game.easyOn=this.on;
    if(!this.on){ if(this.gates.count||this.ground.count){ this.gates.count=0; this.line.count=0; this.ground.count=0; } return; }
    if(g.taxiPhase==="push"||g.taxiPhase==="taxi"){ this.updateTaxi(dt); return; }
    this.ground.count=0; this.tIdx=0;
    const s=g.s, cam=g.cam; const P=this.buildPath(); if(!P){ this.gates.count=0; this.line.count=0; return; }
    const onG=!!s.onGround, ap=g.c.ap; const base=onG?T_h(g,s.pos[0],s.pos[2]):s.pos[1];
    // ゲートの位置（空中に固定。経路の上に一定間隔で置き、機体が近づくと順に現れて、通り過ぎると消える）
    const A=this.anchorPath(); const T=this.T, m4=this.m4, q=this.q, pv=this.pv, sv=this.sv, dir=this.dir; const pos=[]; let gc=0, lc=0;
    const STEP=380; let sAir=0;
    { let bd=1e18, bi=this.segMin||0; for(let i=Math.max(0,this.segMin||0);i<A.pts.length-1;i++){ const a0=A.pts[i], b0=A.pts[i+1]; const dx=b0[0]-a0[0], dz=b0[1]-a0[1], l2=dx*dx+dz*dz||1; const t=clamp(((s.pos[0]-a0[0])*dx+(s.pos[2]-a0[1])*dz)/l2,0,1); const d=Math.hypot(s.pos[0]-(a0[0]+dx*t),s.pos[2]-(a0[1]+dz*t)); if(d<bd-1){ bd=d; bi=i; sAir=A.cum[i]+t*Math.sqrt(l2); } } this.segMin=bi; }
    const sList=[]; for(let k=Math.max(1,Math.ceil((sAir+140)/STEP)); sList.length<MAXN; k++){ const sk=k*STEP; if(sk>A.total) break; if(sk-sAir>3600&&(k%8)) continue; sList.push(sk); }
    let prevS=null;
    for(const sk of sList){ const p=this.anchorAt(A,sk); const gh=g.terrain.heightAt(p.x,p.z); const y=Math.max(this.anchorAlt(A,sk,gh),gh+27); const ps=prevS!=null?prevS:Math.max(0,sk-STEP); const pp=this.anchorAt(A,ps); const pgh=g.terrain.heightAt(pp.x,pp.z); const py=Math.max(this.anchorAlt(A,ps,pgh),pgh+27);
      pos.push({x:p.x,y,z:p.z,tx:p.tx,tz:p.tz,prev:{x:pp.x,y:py,z:pp.z}}); prevS=sk; }
    const th=(x,y,z,mx)=>{ const d=Math.hypot(x-cam.x,y-cam.y,z-cam.z); return clamp(d*0.0042,0.9,mx||5); };
    for(let i=0;i<pos.length;i++){
      const p=pos[i], rx=p.x-cam.x, rz=p.z-cam.z; const t=th(p.x,p.y,p.z); const hd=Math.atan2(p.tx,-p.tz);
      q.setFromAxisAngle(this.yax,-hd); const cx=Math.cos(hd), cz=Math.sin(hd);
      const W=FRAME_W, H=FRAME_H;
      // 上・下
      sv.set(W+t,t,t); pv.set(rx,p.y+H/2,rz); m4.compose(pv,q,sv); this.gates.setMatrixAt(gc++,m4);
      pv.set(rx,p.y-H/2,rz); m4.compose(pv,q,sv); this.gates.setMatrixAt(gc++,m4);
      // 左・右
      sv.set(t,H+t,t); pv.set(rx+cx*W/2,p.y,rz+cz*W/2); m4.compose(pv,q,sv); this.gates.setMatrixAt(gc++,m4);
      pv.set(rx-cx*W/2,p.y,rz-cz*W/2); m4.compose(pv,q,sv); this.gates.setMatrixAt(gc++,m4);
      // 中心線（前のゲートへ）
      const pr=p.prev;
      dir.set(p.x-pr.x,p.y-pr.y,p.z-pr.z); const len=dir.length(); if(len>1){ dir.multiplyScalar(1/len); q.setFromUnitVectors(this.zax,dir); const tl=th((p.x+pr.x)/2,(p.y+pr.y)/2,(p.z+pr.z)/2,14)*1.2; sv.set(tl,tl,len); pv.set((p.x+pr.x)/2-cam.x,(p.y+pr.y)/2,(p.z+pr.z)/2-cam.z); m4.compose(pv,q,sv); this.line.setMatrixAt(lc++,m4); }
    }
    this.gates.count=gc; this.line.count=lc; this.gates.instanceMatrix.needsUpdate=true; this.line.instanceMatrix.needsUpdate=true;
    // 案内（約 8 回／秒）
    this.accum+=dt; if(this.accum<0.12) return; this.accum=0; this.guide(P,base,onG);
  }
  // ---- 地上走行（プッシュバック → 誘導路 → 滑走路）----
  updateTaxi(dt){
    const g=this.game, s=g.s, cam=g.cam, plan=g.taxiPlan; this.gates.count=0; this.line.count=0; if(!plan){ this.ground.count=0; return; }
    const P=plan.taxi, n=P.length, m4=this.m4, q=this.q, pv=this.pv, sv=this.sv, yax=this.yax;
    const fw=[Math.sin(s.psi),-Math.cos(s.psi)]; const mx=s.pos[0]+fw[0]*TAXI.MAIN, mz=s.pos[2]+fw[1]*TAXI.MAIN;
    this.tIdx=TAXI.progress(P,mx,mz,this.tIdx||0); const i0=this.tIdx;
    // 青い破線（先 約 700m）
    let gc=0; const th=(x,z,mn,mxv)=>clamp(Math.hypot(x-cam.x,z-cam.z)*0.004,mn,mxv);
    for(let i=i0;i<n-1&&gc<GROUND_N;i+=5){
      const a=P[i], b=P[Math.min(n-1,i+3)]; const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz); if(len<0.5) continue; const hd=Math.atan2(dx,-dz);
      const gy=g.terrain.heightAt((a.x+b.x)/2,(a.z+b.z)/2); const w=th(a.x,a.z,1.3,6);
      q.setFromAxisAngle(yax,-hd); sv.set(w,0.3,len+w*0.5); pv.set((a.x+b.x)/2-cam.x,gy+0.45,(a.z+b.z)/2-cam.z); m4.compose(pv,q,sv); this.ground.setMatrixAt(gc++,m4);
    }
    this.ground.count=gc; this.ground.instanceMatrix.needsUpdate=true;
    // 門（アーチ）: 先の 6 か所
    let ac=0; const W=34, H=9;
    for(let k=1;k<=6;k++){
      const i=Math.min(n-1,i0+Math.round(k*70/2)); const a=P[i]; if(i>=n-1&&k>1) break; const hd=a.psi; const gy=g.terrain.heightAt(a.x,a.z); const t=th(a.x,a.z,0.5,2.2);
      q.setFromAxisAngle(yax,-hd); const cx=Math.cos(hd), cz=Math.sin(hd), rx=a.x-cam.x, rz=a.z-cam.z;
      sv.set(W+t,t,t); pv.set(rx,gy+H,rz); m4.compose(pv,q,sv); this.gates.setMatrixAt(ac++,m4);
      sv.set(t,H,t); pv.set(rx+cx*W/2,gy+H/2,rz+cz*W/2); m4.compose(pv,q,sv); this.gates.setMatrixAt(ac++,m4);
      pv.set(rx-cx*W/2,gy+H/2,rz-cz*W/2); m4.compose(pv,q,sv); this.gates.setMatrixAt(ac++,m4);
    }
    this.gates.count=ac; this.gates.instanceMatrix.needsUpdate=true;
    this.accum+=dt; if(this.accum<0.12) return; this.accum=0; this.guideTaxi(P,i0,mx,mz);
  }
  guideTaxi(P,i0,mx,mz){
    const g=this.game, s=g.s, pil=g.pilot; const rows=[]; const n=P.length;
    const v=Math.hypot(s.vel[0],s.vel[2]), kt=v/KT; const remain=P[n-1].s-P[i0].s;
    // 先読み点への向き
    let j=i0; while(j<n-1&&P[j].s<P[i0].s+28) j++; const brg=Math.atan2(P[j].x-mx,-(P[j].z-mz)); const err=n180(brg-s.psi); const deg=Math.round(Math.abs(err)/D2R);
    const cte=(mx-P[i0].x)*Math.cos(P[i0].psi)+(mz-P[i0].z)*Math.sin(P[i0].psi);
    let vref=P[i0].v; const sLook=P[i0].s+Math.max(15,v*3); for(let k=i0;k<n&&P[k].s<sLook;k++) vref=Math.min(vref,P[k].v); const vtk=vref/KT;
    const phase=g.taxiPhase==="push"?"プッシュバック中":(remain<250?"滑走路へ進入":"地上走行（誘導路）");
    const next={name:"滑走路"+((g.takeoffRef&&g.takeoffRef.name)||"")+" 離陸位置",dist:remain};
    if(g.taxiPhase==="push"){
      rows.push({ico:"🚜",lab:"プッシュバック",st:"ok",txt:"トーイングカーが機体を後ろへ押しています。そのまま待つ（"+kc("Enter")+" でスキップ）"});
    } else if(g.autoTaxi){
      rows.push({ico:"🤖",lab:"自動タキシー",st:"ok",txt:"作動中。誘導路を自動で走っています。止めるには "+kc("Enter")+"、手動にするには "+kc("A","D")+" やブレーキ",sub:"滑走路まであと約 "+(remain/1000).toFixed(1)+" km ／ "+kc("T")+" で早送り"});
    } else {
      if(s.parking) rows.push({ico:"🅿",lab:"パーキングブレーキ",st:"act",txt:"外す "+kc("P")});
      if(deg>=4) rows.push({ico:"🧭",lab:"向き",st:"act",txt:(err>0?"右へ ":"左へ ")+(err>0?kc("D","→"):kc("A","←"))+"（押している間、前輪が切れる）",sub:"青いラインまで あと約 "+deg+"° "+(err>0?"右":"左")+(Math.abs(cte)>3?" ／ 中心線から "+Math.abs(cte).toFixed(0)+" m "+(cte>0?"右":"左"):"")});
      else rows.push({ico:"🧭",lab:"向き",st:"ok",txt:"向きOK（青いラインに沿って進んでいます）"+(Math.abs(cte)>3?"":"")});
      if(!s.parking){
        if(kt>vtk+3) rows.push({ico:"⚙",lab:"速度",st:"act",txt:"ブレーキ "+kc("Space","B")+"（速すぎ）、スロットルは "+kc("0"),sub:"いま "+Math.round(kt)+" kt ／ 目安 "+Math.round(vtk)+" kt"});
        else if(kt<vtk-3&&pil.throttle<0.04) rows.push({ico:"⚙",lab:"速度",st:"act",txt:"スロットルを少し "+kc("1")+"（10%）。動き出したら "+kc("0")+" に戻す",sub:"いま "+Math.round(kt)+" kt ／ 目安 "+Math.round(vtk)+" kt"});
        else if(kt>vtk-1&&pil.throttle>0.04&&kt>2) rows.push({ico:"⚙",lab:"速度",st:"act",txt:"スロットルを戻す "+kc("0"),sub:"いま "+Math.round(kt)+" kt ／ 目安 "+Math.round(vtk)+" kt"});
        else rows.push({ico:"⚙",lab:"速度",st:"ok",txt:"速度OK（"+Math.round(kt)+" kt）",sub:"曲がり角では目安 "+Math.round(vtk)+" kt まで落とす"});
      }
      rows.push({ico:"💡",lab:"らくに進む",st:"info",txt:kc("Enter")+" で自動タキシー（滑走路の手前まで連れて行きます）"});
    }
    this.render(phase,next.name,next.dist,err,rows,{next:next});
    this.info={phase,nextName:next.name,dNext:remain,err};
  }
  guide(P,base,onG){
    const g=this.game, s=g.s, ap=g.c.ap, pil=g.pilot; const cas=s.cas/KT, raFt=s.radAlt/FT, altFt=s.pos[1]/FT, gs=Math.max(s.gs,30);
    // 目標点（先 18 秒）
    const Lk=clamp(gs*18,1500,12000); const aim=this.at(P,Math.min(P.total,Lk)); const aimBase=onG?base:s.pos[1];
    const aimAlt=Math.max(this.altProfile(P,aim,Math.min(P.total,Lk),aimBase,onG),g.terrain.heightAt(aim.x,aim.z)+(P.dst&&aim.D<30000?0:27));
    const brg=Math.atan2(aim.x-s.pos[0],-(aim.z-s.pos[2])); const err=n180(brg-s.psi);
    const final=P.dst&&P.thrLen<38000&&!g.landed;      // 進入（ドアの手前 38km 以内）
    const D=P.dst?P.thrLen:1e9;
    const tgtV=this.targetSpeed(D,altFt,raFt);
    const rows=[]; const apOn=ap.on;
    // 段階名
    let phase;
    if(g.landed) phase="着陸後（止まるまで）"; else if(onG&&!g.stats.liftoff) phase="離陸滑走"; else if(final) phase=raFt<60?"着陸（フレア）":"着陸の進入"; else if(!g.stats.liftoff&&!onG) phase="飛行中";
    else if(Math.abs(s.pos[1]-CRUISE_ALT)<250*FT*3&&Math.abs(aimAlt-s.pos[1])<400) phase="巡航"; else phase=aimAlt>s.pos[1]+30?"上昇":(aimAlt<s.pos[1]-30?"降下":"巡航");
    // 向き
    const nextName=P.next?P.next.name:"滑走路の先";
    const dNext=P.next?Math.hypot(P.next.x-s.pos[0],P.next.z-s.pos[2]):0;
    const info={phase,nextName,dNext,err,altTgt:aimAlt/FT,vsTgt:0,spdTgt:tgtV.kt};
    if(g.landed){
      const st=s.gs>30?"リバース "+kc("R")+" とブレーキ "+kc("Space","B")+" を押し続ける":(s.gs>2?"ブレーキ "+kc("Space","B")+" で止まる":"停止しました。おつかれさま！");
      rows.push({ico:"🛑",lab:"減速",st:s.gs>2?"act":"ok",txt:st});
    } else if(onG&&!g.stats.liftoff){
      rows.push({ico:"🧭",lab:"向き",st:"ok",txt:"中心線は自動で保たれます（青いラインに沿って進む）"});
      const thr=pil.throttle;
      if(thr<0.85) rows.push({ico:"⚙",lab:"スロットル",st:"act",txt:"上げる "+kc("Shift","PageUp")+" 長押し（"+kc("9")+"＝最大）"});
      else rows.push({ico:"⚙",lab:"スロットル",st:"ok",txt:"離陸推力。加速中…"});
      const vr=g.vsp.vr; if(cas>=vr-4) rows.push({ico:"↕",lab:"高さ",st:"act",txt:"いま！ 操縦桿を引いて機首を上げる "+kc("↓","S")+"（約10°）"}); else rows.push({ico:"↕",lab:"高さ",st:"ok",txt:"VR（"+vr+" kt）になったら "+kc("↓","S")+" で引く（いま "+Math.round(cas)+" kt）"});
    } else if(apOn&&!g.landed){
      { const af=g.autoFlight&&g.af?({climb:"上昇中",cruise:"巡航中",descend:"降下中"}[g.af.phase]||""):""; rows.push({ico:"🤖",lab:g.autoFlight?"オート航行":"オートパイロット",st:"ok",txt:(g.autoFlight?"自動で目的地の滑走路まで飛んでいます"+(af?"（"+af+"）":"")+"。":"作動中（自動で飛んでいます）。")+"自分で操縦するには "+kc("Enter")+" か MCP のボタンで解除"}); }
    } else if(raFt<40&&!onG&&final&&D<3500){
      rows.push({ico:"🛬",lab:"フレア",st:"act",txt:"操縦桿を少し引いて "+kc("↓","S")+"、スロットルを絞る "+kc("End")+"（アイドル）"});
    } else {
      // 向き
      const maxBank=(raFt<1500?15:25)*D2R; const want=clamp(err*1.5,-maxBank,maxBank); const d=(want-s.phi)/D2R;
      const deg=Math.round(Math.abs(err)/D2R);
      if(d>6) rows.push({ico:"🧭",lab:"向き",st:"act",txt:"右へ曲がる "+kc("→","D")+"（短く押して、目標の向きになったら離す）",sub:deg>=3?"青いラインまで あと約 "+deg+"° 右":"傾きを調整"});
      else if(d<-6) rows.push({ico:"🧭",lab:"向き",st:"act",txt:"左へ曲がる "+kc("←","A")+"（短く押して、目標の向きになったら離す）",sub:deg>=3?"青いラインまで あと約 "+deg+"° 左":"傾きを調整"});
      else rows.push({ico:"🧭",lab:"向き",st:"ok",txt:"向きOK（青いラインのほうへ飛んでいます）"});
      // 高さ
      const lim=final?[-6,6]:[-10,13]; const waitPath=final&&aimAlt>s.pos[1]+20&&raFt>120; const dvs=waitPath?0:clamp((aimAlt-s.pos[1])/Math.max(12,Lk/gs),lim[0],lim[1]); info.vsTgt=dvs/FT*60; const dv=dvs-s.vs; const tgtTxt=Math.abs(dvs)<0.6?"水平":(dvs>0?"上昇 約 ":"降下 約 ")+fmt(Math.abs(Math.round(dvs/FT*60/100)*100))+" ft/分";
      if(dv>2) rows.push({ico:"↕",lab:"高さ",st:"act",txt:"機首を上げる "+kc("↓","S")+"（短く引いて離す）",sub:"目標：" +tgtTxt});
      else if(dv<-2) rows.push({ico:"↕",lab:"高さ",st:"act",txt:"機首を下げる "+kc("↑","W")+"（短く押して離す）",sub:"目標："+tgtTxt});
      else rows.push({ico:"↕",lab:"高さ",st:"ok",txt:"高さOK（"+tgtTxt+"）",sub:waitPath?"青いラインがこの高さまで降りてくるのを待つ":""});
      // 速度
      const diff=tgtV.mach?(s.mach-tgtV.mach)*590:(cas-tgtV.kt); const nowTxt=tgtV.mach?"M"+s.mach.toFixed(2):Math.round(cas)+" kt"; const tg=tgtV.mach?"M"+tgtV.mach.toFixed(2):Math.round(tgtV.kt)+" kt";
      if(diff<-8) rows.push({ico:"⚙",lab:"速度",st:"act",txt:"スロットルを上げる "+kc("Shift","PageUp")+"（長押し）",sub:"いま "+nowTxt+" ／ 目標 "+tg});
      else if(diff>12) rows.push({ico:"⚙",lab:"速度",st:"act",txt:"スロットルを下げる "+kc("Ctrl","PageDown")+"（長押し）",sub:"いま "+nowTxt+" ／ 目標 "+tg});
      else rows.push({ico:"⚙",lab:"速度",st:"ok",txt:"速度OK（"+nowTxt+"）"});
    }
    // 設定（ギア・フラップなど）
    const cf=g.landed?null:this.config(P,D,cas,raFt,altFt,onG,final);
    if(cf) rows.push(cf);
    // 進入のすすめ
    if(!apOn&&!g.landed&&P.dst&&final&&!onG&&g.findApproach&&raFt>150) rows.push({ico:"💡",lab:"らくに着陸",st:"info",txt:kc("I")+" キーで ILS 自動進入（ギア・フラップも自動）"});
    this.render(phase,nextName,dNext,err,rows,P);
    this.info=info;
  }
  targetSpeed(D,altFt,raFt){
    const g=this.game, vsp=g.vsp; const vref=vsp.vref+4;
    if(!g.stats.liftoff&&!g.landed&&g.s.onGround) return {kt:vsp.v2};
    if(D<38000){ let v; if(D>26000) v=210; else if(D>19000) v=190; else if(D>14000) v=170; else if(D>10500) v=155; else if(D>7500) v=vref+14; else if(D>5200) v=vref+8; else v=vref+3; if(D>38000) v=230; return {kt:v}; }
    if(D<60000&&altFt<12000) return {kt:230};
    if(altFt<2500&&raFt<2500&&g.stats.liftoff&&D>60000) return {kt:Math.max(g.vsp.v2+15,200)};
    if(altFt<10000) return {kt:250};
    if(altFt<26000) return {kt:290};
    return {kt:0,mach:0.78};
  }
  config(P,D,cas,raFt,altFt,onG,final){
    const g=this.game, s=g.s, pil=g.pilot; const F_=F.AC.flapSpeeds; const idx=Math.round(s.flapsTarget); const fdeg=[0,1,2,5,10,15,25,30,40];
    const row=(txt,sub)=>({ico:"🔧",lab:"設定",st:"act",txt,sub});
    if(g.stats.liftoff&&!onG&&s.gear>0.5&&raFt>40&&s.vs>0&&!final) return row("ギアを上げる "+kc("G"),"上昇率がプラスになりました");
    if(!final&&!onG&&s.gear<0.5&&idx>0&&raFt>350&&cas>F_[idx]/KT-40) return row("フラップを一段上げる "+kc("V"),"いま "+fdeg[idx]+"°（速度が上がったので）");
    if(P.dst&&D<38000&&!g.landed&&!onG){
      // 進入のスケジュール（apprAssist と同じ）
      let fl=0,gear=false; if(D>38000) fl=0; else if(D>26000) fl=D<30000?1:0; else if(D>19000) fl=3; else if(D>14000) fl=4; else if(D>10500){ fl=5; gear=true; } else if(D>7500){ fl=7; gear=true; } else if(D>5200){ fl=7; gear=true; } else { fl=8; gear=true; }
      if(D<30000&&fl<1) fl=1;
      if(gear&&pil.gearTarget<0.5) return row("ギアを下げる "+kc("G"),"着陸まであと約 "+Math.round(D/NM)+" NM");
      if(idx<fl) return row("フラップを下げる "+kc("F")+"（"+fdeg[Math.min(8,idx+1)]+"° へ）","目標は "+fdeg[fl]+"°");
      if(D<16000&&!pil.spoilerArm) return row("スポイラーを待機させる "+kc("L"),"着陸したら自動で開きます");
      if(D<16000&&pil.autobrake===0) return row("オートブレーキを入れる "+kc("O"),"着陸後に自動で止まります");
    }
    return null;
  }
  render(phase,nextName,dNext,err,rows,P){
    const el=this.el; if(!el) return; if(el.style.display!=="block") el.style.display="block";
    const deg=Math.round(err/D2R); const km=dNext/1000;
    let h='<div class="ez-h"><b>かんたんモード</b><span>'+phase+'</span></div>';
    if(P.next&&!this.game.landed) h+='<div class="ez-t"><div class="ez-arrow" style="transform:rotate('+clamp(deg,-120,120)+'deg)">▲</div><div><div class="ez-n">次の目標：'+nextName+'</div><div class="ez-d">'+(km>=10?km.toFixed(0):km.toFixed(1))+' km ／ '+(Math.abs(deg)<3?"正面":(deg>0?"右 "+deg+"°":"左 "+(-deg)+"°"))+'</div></div></div>';
    for(const r of rows) h+='<div class="ez-r '+r.st+'"><span class="ez-i">'+r.ico+'</span><div><div class="ez-l">'+r.lab+'</div><div class="ez-x">'+r.txt+'</div>'+(r.sub?'<div class="ez-s">'+r.sub+'</div>':'')+'</div></div>';
    h+='<div class="ez-f"><kbd>U</kbd> でオン／オフ</div>';
    if(h!==this.last){ el.innerHTML=h; this.last=h; }
  }
}
function T_h(g,x,z){ return g.terrain.heightAt(x,z); }
root.Easy=Easy;
})(typeof window!=="undefined"?window:globalThis);
