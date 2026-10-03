/* 駐機中の飛行機: 空港データ（OSM の駐機位置 parking_position）の端点に、ターミナル側へ機首を向けて置く。
   塗装は架空の3種類。材質ごとに形状をまとめ、InstancedMesh で描くので重くならない。 */
(function(root){
"use strict";
const G=root.GEO;
const LIVERIES=[
  {name:"SETO AIR",accentCss:"#1f7fb8",accent:0x1f7fb8,darkCss:"#12395a"},
  {name:"KIBI JET",accentCss:"#d9473b",accent:0xd9473b,darkCss:"#4a1d1a"},
  {name:"NORTH WING",accentCss:"#2e9b62",accent:0x2e9b62,darkCss:"#17432c"}
];
const NOSE_TO_CG=13.5;   // 前脚から重心まで [m]
function hash(i){ let x=Math.sin(i*127.1+311.7)*43758.5453; return x-Math.floor(x); }
// 他の機体 k が、プレイヤーの通る範囲 swept（[x,z,r] の配列）に触れるか
function hits(k,swept){
  const mine=root.TAXI.footprint(k.x,k.z,k.dx,k.dz,[]); let hit=false;
  for(const [x,z,r] of mine){ for(const q of swept){ if(Math.hypot(x-q[0],z-q[1])<r+q[2]+3){ hit=true; break; } } if(hit) break; }
  k.hide=hit; return hit;
}
function pip(x,z,poly){ let c=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const a=poly[i],b=poly[j]; if((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; }

// 1機分のモデルを「材質ごとの結合形状」に変換
function bake(T,ac){
  ac.root.updateMatrixWorld(true);
  const groups=new Map(); let minY=1e9;
  ac.root.traverse(o=>{
    if(!o.isMesh||!o.geometry||!o.visible) return; if(o.isSprite) return;
    let g=o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    if(!g.attributes.normal) g.computeVertexNormals();
    if(!g.attributes.uv){ g.setAttribute("uv",new T.BufferAttribute(new Float32Array(g.attributes.position.count*2),2)); }
    if(!g.index){ const n=g.attributes.position.count, ix=new Uint32Array(n); for(let i=0;i<n;i++) ix[i]=i; g.setIndex(new T.BufferAttribute(ix,1)); }
    const key=o.material.uuid; if(!groups.has(key)) groups.set(key,{mat:o.material,gs:[]}); groups.get(key).gs.push(g);
    g.computeBoundingBox(); minY=Math.min(minY,g.boundingBox.min.y);
  });
  const out=[];
  for(const {mat,gs} of groups.values()){
    let nv=0,ni=0; for(const g of gs){ nv+=g.attributes.position.count; ni+=g.index.count; }
    const pos=new Float32Array(nv*3), nor=new Float32Array(nv*3), uv=new Float32Array(nv*2), idx=new Uint32Array(ni); let vo=0,io=0;
    for(const g of gs){ const n=g.attributes.position.count; pos.set(g.attributes.position.array,vo*3); nor.set(g.attributes.normal.array,vo*3); uv.set(g.attributes.uv.array,vo*2);
      for(let i=0;i<g.index.count;i++) idx[io+i]=g.index.array[i]+vo; vo+=n; io+=g.index.count; g.dispose(); }
    const geo=new T.BufferGeometry(); geo.setAttribute("position",new T.BufferAttribute(pos,3)); geo.setAttribute("normal",new T.BufferAttribute(nor,3)); geo.setAttribute("uv",new T.BufferAttribute(uv,2)); geo.setIndex(new T.BufferAttribute(idx,1));
    out.push({geo,mat});
  }
  return {parts:out,minY};
}

// 駐機位置の候補（位置・機首方位）を作る
function stands(data,P,apron){
  const ways=data.ways||[];
  const terms=[]; for(const w of ways){ if(w.t==="terminal"||w.t==="hangar"||w.t==="jet_bridge") terms.push(w.g.map(p=>G.ll2xz(p[1],p[0]))); }
  const termPoly=terms.filter((_,i)=>true);
  const nearTerm=(x,z)=>{ let b=1e12; for(const t of terms) for(const q of t){ const d=(q[0]-x)*(q[0]-x)+(q[1]-z)*(q[1]-z); if(d<b) b=d; } return Math.sqrt(b); };
  const out=[];
  for(const w of ways){
    if(w.t!=="parking_position") continue; const pts=w.g.map(p=>G.ll2xz(p[1],p[0])); if(pts.length<2) continue;
    let L=0; for(let i=0;i<pts.length-1;i++) L+=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]); if(L<40) continue;
    // 誘導路へ曲がっていく短い曲線（ターンの出口線）は駐機位置ではないので除く。まっすぐな線だけ使う
    if(Math.hypot(pts[pts.length-1][0]-pts[0][0],pts[pts.length-1][1]-pts[0][1])/L<0.98) continue;
    // ターミナルに近い側の端を停止位置とみなし、そこへ向かう向きに機首を向ける
    let seq=pts; if(nearTerm(pts[0][0],pts[0][1])<nearTerm(pts[pts.length-1][0],pts[pts.length-1][1])) seq=pts.slice().reverse();
    const e=seq[seq.length-1]; let dx=0,dz=0,acc=0;
    for(let i=seq.length-1;i>0&&acc<12;i--){ const ax=seq[i-1][0],az=seq[i-1][1],bx=seq[i][0],bz=seq[i][1]; const l=Math.hypot(bx-ax,bz-az); dx+=bx-ax; dz+=bz-az; acc+=l; }
    const l=Math.hypot(dx,dz); if(l<1) continue; dx/=l; dz/=l;
    out.push({x:e[0]-dx*NOSE_TO_CG,z:e[1]-dz*NOSE_TO_CG,dx,dz,stopDist:nearTerm(e[0],e[1])});
  }
  return {list:out,terms};
}

class Parked{
  constructor(THREE,airports,terrain){ this.T=THREE; this.ap=airports; this.terrain=terrain; this.done={}; this.baked=null; this.res={}; this.recs={}; }
  // プレイヤーが出発するゲートの駐機機を隠す／戻す
  reserve(icao,x,z,r,swept){ this.res[icao]={x,z,r,swept:swept||null}; this.applyRes(icao); }
  release(icao){ if(!this.res[icao]) return; delete this.res[icao]; this.applyRes(icao); }
  applyRes(icao){
    const recs=this.recs[icao]; if(!recs) return; const r=this.res[icao]; const zero=new this.T.Matrix4().makeScale(0,0,0); const ims=new Set();
    for(const k of recs){ let hide=!!r&&Math.hypot(k.x-r.x,k.z-r.z)<r.r; if(!hide&&r&&r.swept) hide=hits(k,r.swept); k.im.setMatrixAt(k.k,hide?zero:k.m); ims.add(k.im); }
    if(r&&r.swept) this.hidden=recs.filter(k=>k.hide).length;
    for(const im of ims) im.instanceMatrix.needsUpdate=true;
  }
  ensure(icao){
    const a=this.ap.ap[icao]; if(!a||!a.built||this.done[icao]) return; this.done[icao]=true;
    const T=this.T, P=a.ref, data=this.ap.data[icao];
    if(!this.baked) this.baked=LIVERIES.map(L=>bake(T,new Aircraft(T,{livery:L})));
    const {list,terms}=stands(data,P,a.apron);
    // 重なり・建物との干渉を避けて選ぶ（決まった乱数なので毎回同じ配置）
    const placed=[]; const cnt=LIVERIES.map(()=>[]);
    const cand=list.map((s,i)=>({s,i})).sort((p,q)=>p.s.stopDist-q.s.stopDist);
    for(const {s,i} of cand){
      if(hash(i+(icao==="RJTT"?7:0))>(icao==="RJTT"?0.62:0.9)) continue;      // 空きスタンドも残す
      let bad=false;
      for(const t of terms){ if(pip(s.x,s.z,t)) { bad=true; break; } }
      if(!bad){ const fx=s.x+s.dx*17, fz=s.z+s.dz*17, bx=s.x-s.dx*17, bz=s.z-s.dz*17; for(const t of terms){ if(pip(fx,fz,t)||pip(bx,bz,t)){ bad=true; break; } } }
      if(!bad) for(const q of placed){ if(Math.hypot(q.x-s.x,q.z-s.z)<34){ bad=true; break; } }
      if(!bad&&a.apron.length){ let on=false; for(const ap of a.apron) if(pip(s.x,s.z,ap)){ on=true; break; } if(!on) bad=true; }
      if(bad) continue;
      placed.push(s); cnt[Math.floor(hash(i*3.1+5)*LIVERIES.length)%LIVERIES.length].push(s);
    }
    const grp=new T.Group(); a.group.add(grp); a.parkedGroup=grp; a.parkedCount=placed.length; a.parked=placed;
    const m4=new T.Matrix4(), q=new T.Quaternion(), pv=new T.Vector3(), sc=new T.Vector3(1,1,1), up=new T.Vector3(0,1,0); const recs=this.recs[icao]=[];
    cnt.forEach((arr,li)=>{
      if(!arr.length) return; const b=this.baked[li];
      for(const part of b.parts){
        const im=new T.InstancedMesh(part.geo,part.mat,arr.length); im.frustumCulled=false;
        arr.forEach((s,k)=>{
          const hdg=Math.atan2(s.dx,-s.dz);          // 機首の真方位（北=−z, 東=+x）
          q.setFromAxisAngle(up,-hdg);
          const gy=this.terrain.heightAt(s.x,s.z)+0.12;      // 舗装面
          pv.set(s.x-P[0],gy-b.minY,s.z-P[1]); m4.compose(pv,q,sc); im.setMatrixAt(k,m4); recs.push({x:s.x,z:s.z,dx:s.dx,dz:s.dz,im,k,m:m4.clone()});
        });
        im.instanceMatrix.needsUpdate=true; grp.add(im);
      }
    });
    this.applyRes(icao);
  }
}
root.Parked=Parked;
})(typeof window!=="undefined"?window:globalThis);
