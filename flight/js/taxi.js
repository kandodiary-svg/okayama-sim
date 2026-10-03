/* 地上走行（ゲート → 滑走路）。
   空港データ（OpenStreetMap の誘導路・駐機位置）から経路をつくる。
   ・ゲート（スタンド）の位置と機首の向き
   ・プッシュバック（トーイングカーで後ろへ押し出し、誘導路の向きに機首を回す）の動き
   ・誘導路を通って滑走路の端まで行く経路（角は丸めてある）と、曲がり具合に応じた速度の目安
   ・自動タキシー用の制御（前輪の舵角・スロットル・ブレーキを返す）
   Node でも動くよう、描画や DOM には触れない。 */
(function(root){
"use strict";
const G=root.GEO;
const D2R=Math.PI/180;
const NOSE=13.0, MAIN=-1.3, WB=NOSE-MAIN;       // CG基準の前脚・主脚の位置[m] と ホイールベース
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const n180=a=>{ a=(a+Math.PI)%(2*Math.PI); if(a<0) a+=2*Math.PI; return a-Math.PI; };

// ---------- 誘導路のグラフ ----------
function buildGraph(data){
  const V=[], E=[]; const cell=new Map();
  const key=(i,j)=>i+","+j;
  const vid=(p)=>{ const ci=Math.floor(p[0]/3), cj=Math.floor(p[1]/3);
    for(let i=ci-1;i<=ci+1;i++) for(let j=cj-1;j<=cj+1;j++){ const c=cell.get(key(i,j)); if(!c) continue; for(const k of c){ if(Math.hypot(V[k][0]-p[0],V[k][1]-p[1])<3) return k; } }
    const k=V.length; V.push(p); E.push([]); const kk=key(ci,cj); if(!cell.has(kk)) cell.set(kk,[]); cell.get(kk).push(k); return k; };
  for(const w of (data.ways||[])){
    if(w.t!=="taxiway"&&w.t!=="taxilane"&&w.t!=="parking_position") continue;
    const ids=w.g.map(p=>vid(G.ll2xz(p[1],p[0])));
    for(let i=0;i<ids.length-1;i++){ const a=ids[i], b=ids[i+1]; if(a===b) continue; const l=Math.hypot(V[a][0]-V[b][0],V[a][1]-V[b][1]); E[a].push([b,l]); E[b].push([a,l]); }
  }
  return {V,E};
}
function nearestVertex(g,x,z){ let b=-1,bd=1e18; for(let i=0;i<g.V.length;i++){ const d=(g.V[i][0]-x)**2+(g.V[i][1]-z)**2; if(d<bd){ bd=d; b=i; } } return b; }
function dijkstra(g,s,t){
  const n=g.V.length, dist=new Float64Array(n).fill(1e18), prev=new Int32Array(n).fill(-1), done=new Uint8Array(n); dist[s]=0;
  for(;;){ let u=-1,bd=1e18; for(let i=0;i<n;i++) if(!done[i]&&dist[i]<bd){ bd=dist[i]; u=i; } if(u<0||u===t) break; done[u]=1;
    for(const [v,l] of g.E[u]){ const nd=dist[u]+l; if(nd<dist[v]){ dist[v]=nd; prev[v]=u; } } }
  if(dist[t]>=1e17) return null; const p=[t]; while(p[p.length-1]!==s) p.push(prev[p[p.length-1]]); return p.reverse();
}

// ---------- ゲート（スタンド） ----------
// 駐機位置の線のうちターミナルに近い側の端を停止位置とし、機首はそこへ向ける（parked.js と同じ決め方）
function gateStand(data,gateRef){
  const ways=data.ways||[]; const terms=[];
  for(const w of ways){ if(w.t==="terminal"||w.t==="hangar"||w.t==="jet_bridge") terms.push(w.g.map(p=>G.ll2xz(p[1],p[0]))); }
  const nearTerm=(x,z)=>{ let b=1e12; for(const t of terms) for(const q of t){ const d=(q[0]-x)**2+(q[1]-z)**2; if(d<b) b=d; } return Math.sqrt(b); };
  const gate=(data.nodes||[]).find(n=>n.t==="gate"&&String(n.ref)===String(gateRef)); if(!gate) return null;
  const gp=G.ll2xz(gate.p[1],gate.p[0]); let best=null,bd=1e18;
  for(const w of ways){
    if(w.t!=="parking_position") continue; let pts=w.g.map(p=>G.ll2xz(p[1],p[0])); if(pts.length<2) continue;
    let L=0; for(let i=0;i<pts.length-1;i++) L+=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]); if(L<40) continue;
    if(Math.hypot(pts[pts.length-1][0]-pts[0][0],pts[pts.length-1][1]-pts[0][1])/L<0.98) continue;
    if(nearTerm(pts[0][0],pts[0][1])<nearTerm(pts[pts.length-1][0],pts[pts.length-1][1])) pts=pts.slice().reverse();
    const e=pts[pts.length-1], d=Math.hypot(e[0]-gp[0],e[1]-gp[1]); if(d<bd){ bd=d; best={pts,e}; }
  }
  if(!best) return null; const seq=best.pts, e=best.e; let dx=0,dz=0,acc=0;
  for(let i=seq.length-1;i>0&&acc<12;i--){ const ax=seq[i-1][0],az=seq[i-1][1],bx=seq[i][0],bz=seq[i][1]; dx+=bx-ax; dz+=bz-az; acc+=Math.hypot(bx-ax,bz-az); }
  const l=Math.hypot(dx,dz); dx/=l; dz/=l;
  return {stop:e, dx, dz, hdg:Math.atan2(dx,-dz), start:seq[0], gate:gp};
}

// ---------- 経路の整形 ----------
// 折れ線の角を半径 R の円弧で丸め、約 step[m] 間隔に並べ直す
function smoothPath(pts,R,step){
  const out=[pts[0].slice()];
  for(let i=1;i<pts.length-1;i++){
    const a=pts[i-1], b=pts[i], c=pts[i+1];
    let ux=b[0]-a[0], uz=b[1]-a[1], vx=c[0]-b[0], vz=c[1]-b[1]; const l1=Math.hypot(ux,uz), l2=Math.hypot(vx,vz); if(l1<1e-6||l2<1e-6) continue;
    ux/=l1; uz/=l1; vx/=l2; vz/=l2; const cr=ux*vz-uz*vx, dt=ux*vx+uz*vz; const th=Math.atan2(Math.abs(cr),dt);   // 曲がる角
    if(th<2*D2R){ out.push(b.slice()); continue; }
    const T=Math.min(R*Math.tan(th/2), 0.48*l1, 0.48*l2); const r=T/Math.tan(th/2); const sg=cr>0?1:-1;
    const p0=[b[0]-ux*T,b[1]-uz*T];
    const cen=[p0[0]+(-uz*sg)*r, p0[1]+(ux*sg)*r];   // 円の中心は曲がる側（右折なら進行方向の右）
    const a0=Math.atan2(p0[1]-cen[1],p0[0]-cen[0]); const n=Math.max(2,Math.ceil(r*th/step));
    for(let k=0;k<=n;k++){ const aa=a0+sg*th*k/n; out.push([cen[0]+r*Math.cos(aa),cen[1]+r*Math.sin(aa)]); }
  }
  out.push(pts[pts.length-1].slice());
  // 等間隔に再サンプル
  const res=[out[0]]; let carry=0;
  for(let i=1;i<out.length;i++){ let a=res[res.length-1], b=out[i]; let d=Math.hypot(b[0]-a[0],b[1]-a[1]); while(d>=step){ const t=step/d; a=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]; res.push(a); d=Math.hypot(b[0]-a[0],b[1]-a[1]); } if(i===out.length-1&&d>0.5) res.push(b); }
  return res;
}
// 経路に 距離 s・進行方位 psi・曲率 k・目標速度 v を付ける
function annotate(pts,o){
  o=o||{}; const vmax=o.vmax||9, aLat=o.aLat||0.55, aDec=o.aDec||0.35, vend=o.vend!=null?o.vend:0;
  const n=pts.length, P=[]; let s=0;
  for(let i=0;i<n;i++){ if(i>0) s+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]); P.push({x:pts[i][0],z:pts[i][1],s,psi:0,k:0,v:vmax}); }
  for(let i=0;i<n;i++){ const a=P[Math.max(0,i-1)], b=P[Math.min(n-1,i+1)]; P[i].psi=Math.atan2(b.x-a.x,-(b.z-a.z)); }
  for(let i=0;i<n;i++){ const j0=Math.max(0,i-7), j1=Math.min(n-1,i+7); const ds=P[j1].s-P[j0].s; P[i].k=ds>1?Math.abs(n180(P[j1].psi-P[j0].psi))/ds:0; }
  for(let i=0;i<n;i++){ P[i].v=Math.min(vmax,Math.max(2.8,Math.sqrt(aLat/Math.max(P[i].k,1e-4)))); }
  P[n-1].v=Math.min(P[n-1].v,vend);
  for(let i=n-2;i>=0;i--){ const ds=P[i+1].s-P[i].s; P[i].v=Math.min(P[i].v,Math.sqrt(P[i+1].v*P[i+1].v+2*aDec*ds)); }   // 手前から減速
  for(let i=1;i<n;i++){ const ds=P[i].s-P[i-1].s; P[i].v=Math.min(P[i].v,Math.sqrt(P[i-1].v*P[i-1].v+2*0.5*ds)+0.01); }          // 加速も控えめに
  return P;
}

// ---------- ゲート出発の計画 ----------
// rwy: runwayEnd(...).e （x,z,ux,uz,hdg）。 戻り値: {stand, push:{poses,len}, taxi:[...], lineup}
function planDeparture(data,gateRef,rwy,opt){
  opt=opt||{}; const g=buildGraph(data); const st=gateStand(data,gateRef); if(!st) return null;
  const sv=nearestVertex(g,st.start[0],st.start[1]);
  // 目的: 滑走路の中心線上にある誘導路の端（滑走端に近いもの）
  const u=[rwy.ux,rwy.uz]; let goal=-1,gt=1e18;
  for(let i=0;i<g.V.length;i++){ const dx=g.V[i][0]-rwy.x, dz=g.V[i][1]-rwy.z; const t=dx*u[0]+dz*u[1], c=Math.abs(dx*(-u[1])+dz*u[0]); if(c<4&&t>-20&&t<600&&g.E[i].length>=1&&t<gt){ gt=t; goal=i; } }
  if(goal<0) return null;
  const path=dijkstra(g,sv,goal); if(!path) return null;
  // 駐機線から出て最初の長い誘導路
  let k=0; for(;k<path.length-1;k++){ const a=g.V[path[k]], b=g.V[path[k+1]]; if(Math.hypot(a[0]-b[0],a[1]-b[1])>25) break; }
  if(k>=path.length-1) return null;
  const A=g.V[path[k]], B=g.V[path[k+1]]; let fx=B[0]-A[0], fz=B[1]-A[1]; const fl=Math.hypot(fx,fz); fx/=fl; fz/=fl;     // 誘導路上の進行方向
  // 駐機線の延長（機体の後ろ側）と誘導路中心線の交点 I
  const bx=-st.dx, bz=-st.dz; const den=bx*fz-bz*fx; let sI=((A[0]-st.stop[0])*fz-(A[1]-st.stop[1])*fx)/den;
  const I=[st.stop[0]+bx*sI, st.stop[1]+bz*sI];
  // プッシュバック: 主脚中心 M は、駐機線を後ろへまっすぐ → 半径 Rt の円弧で誘導路の向きへ
  const Rt=opt.pushR||38; const dF=[-fx,-fz]; const cr=bx*dF[1]-bz*dF[0], dt=bx*dF[0]+bz*dF[1]; const th=Math.atan2(Math.abs(cr),dt), sg=cr>0?1:-1; const T=Rt*Math.tan(th/2);
  const M0=[st.stop[0]-st.dx*WB, st.stop[1]-st.dz*WB];     // 前脚が停止位置にあるときの主脚中心
  const L1=Math.hypot(I[0]-M0[0],I[1]-M0[1])-T; if(L1<5) return null;
  const poses=[]; const add=(m,psi)=>poses.push({mx:m[0],mz:m[1],psi});
  const ds=1; for(let d=0;d<=L1;d+=ds) add([M0[0]+bx*d,M0[1]+bz*d], st.hdg);
  const P1=[M0[0]+bx*L1, M0[1]+bz*L1];
  // 円弧の中心: P1 から、曲がる側（右へ曲がるなら進行方向の右 = (−bz, bx)）へ Rt
  const side=sg>0?[-bz, bx]:[bz, -bx];
  const C=[P1[0]+side[0]*Rt, P1[1]+side[1]*Rt]; const a0=Math.atan2(P1[1]-C[1],P1[0]-C[0]); const arcLen=Rt*th; const n=Math.ceil(arcLen/ds);
  for(let k2=1;k2<=n;k2++){ const f=k2/n, aa=a0+sg*th*f; const m=[C[0]+Rt*Math.cos(aa),C[1]+Rt*Math.sin(aa)]; const trav=Math.atan2(bx,-bz)+sg*th*f; add(m,trav+Math.PI); }
  const pf=poses[poses.length-1]; const psiF=Math.atan2(fx,-fz);
  // 最終位置: 前脚 N_f = M_f + WB*前
  const NF=[pf.mx+Math.sin(pf.psi)*WB, pf.mz-Math.cos(pf.psi)*WB];
  // タキシー経路: N_f → 誘導路 → 滑走路中心線
  const pts=[NF]; for(let i=k+1;i<path.length;i++) pts.push(g.V[path[i]].slice());
  const last=pts[pts.length-1]; const tl=(last[0]-rwy.x)*u[0]+(last[1]-rwy.z)*u[1];
  const endT=opt.lineupT!=null?opt.lineupT:Math.max(tl+110,170);
  pts.push([rwy.x+u[0]*endT, rwy.z+u[1]*endT]);
  const sm=smoothPath(pts,opt.R||45,2);
  const taxi=annotate(sm,{vmax:opt.vmax||9,vend:0});
  return {stand:st, graph:g, I, psiF, push:{poses,len:poses.length*ds,L1,arc:arcLen,Rt}, taxi, goalVertex:goal, rwyT:tl};
}

// 経路上で主脚中心に最も近い点（前回位置の近くだけ探す）
function progress(P,x,z,from){
  let b=from, bd=1e18; const lo=Math.max(0,from-5), hi=Math.min(P.length-1,from+60);
  for(let i=lo;i<=hi;i++){ const d=(P[i].x-x)**2+(P[i].z-z)**2; if(d<bd){ bd=d; b=i; } }
  return b;
}

// ---------- 自動タキシーの制御 ----------
class AutoTaxi{
  constructor(P){ this.P=P; this.i=0; this.int=0; this.done=false; this.ste=0; }
  // s: FDM の状態。 戻り値 {thr,brake,nws(-1..1),cte,vref,done}
  update(s,dt){
    const P=this.P; const fw=[Math.sin(s.psi),-Math.cos(s.psi)];
    const mx=s.pos[0]+fw[0]*MAIN, mz=s.pos[2]+fw[1]*MAIN;     // 主脚中心（基準点）
    this.i=progress(P,mx,mz,this.i);
    const v=Math.hypot(s.vel[0],s.vel[2]);
    // 目標速度は先読みして（今の速度で 3 秒先まで）最小値を取る
    let vref=P[this.i].v; const sLook=P[this.i].s+Math.max(10,v*3.0); for(let j=this.i;j<P.length&&P[j].s<sLook;j++) vref=Math.min(vref,P[j].v+ (P[j].s-P[this.i].s)*0.0);
    const remain=P[P.length-1].s-P[this.i].s; if(remain<2.0&&v<0.6) this.done=true;
    // 舵: pure pursuit（主脚中心から先読み点へ）
    const Ld=clamp(7+1.6*v,8,26); let j=this.i; while(j<P.length-1&&P[j].s<P[this.i].s+Ld) j++;
    const tx=P[j].x-mx, tz=P[j].z-mz; const brg=Math.atan2(tx,-tz); const al=n180(brg-s.psi); const dist=Math.max(4,Math.hypot(tx,tz));
    let del=Math.atan(2*WB*Math.sin(al)/dist);
    // 経路からのずれ（左右）
    const pp=P[this.i]; const cte=(mx-pp.x)*Math.cos(pp.psi)+(mz-pp.z)*Math.sin(pp.psi);   // 進行方向の右が +
    const nws=clamp(del/0.9,-1,1);
    // 速度
    let thr=0, br=0; const ev=vref-v;
    if(ev>0.2){ this.int=clamp(this.int+ev*dt*0.01,0,0.08); thr=clamp(0.03+0.03*ev+this.int,0,0.30); }
    else { this.int=Math.max(0,this.int-dt*0.02); thr=0; if(ev<-0.5) br=clamp((-ev-0.5)*0.12,0,0.45); }
    if(remain<25){ const vs=Math.max(0,Math.sqrt(2*0.35*Math.max(0,remain-1.5))); if(v>vs+0.3){ thr=0; br=clamp((v-vs)*0.2,0.05,0.5); } }
    if(this.done){ thr=0; br=1; }
    return {thr,brake:br,nws,cte,vref,v,remain,al};
  }
}

// 機体の占める範囲を小さな円の並びで近似する（衝突の判定用）。x,z=重心、(dx,dz)=機首の向き。 out に [x,z,半径] を追加
const FOOT=(function(){ const a=[]; for(let o=-17;o<=19;o+=4) a.push([o,0,3.3]);                 // 胴体
  for(const l of [5,9,13,16.5]) for(const sg of [-1,1]) a.push([-1-0.4*l,sg*l,3.0]);                // 主翼（後退角つき）
  for(const l of [3,6]) for(const sg of [-1,1]) a.push([-15.5-0.3*l,sg*l,2.5]);                      // 水平尾翼
  return a; })();
function footprint(x,z,dx,dz,out){ const rx=-dz, rz=dx; for(const [o,l,r] of FOOT) out.push([x+dx*o+rx*l,z+dz*o+rz*l,r]); return out; }

root.TAXI={ footprint, buildGraph, nearestVertex, dijkstra, gateStand, smoothPath, annotate, planDeparture, progress, AutoTaxi, NOSE, MAIN, WB };
})(typeof window!=="undefined"?window:globalThis);
