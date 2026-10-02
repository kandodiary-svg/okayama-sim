/* 機体の外観（ボーイング 737-800 風）。 機体軸 FRD（前・右・下, 重心基準）で寸法を書き、Three のローカル軸 (右, 上, 後ろ) に変換して作る。
   脚・フラップ・スラット・補助翼・昇降舵・方向舵・スポイラー・灯火が動く。塗装は架空（桃色の帯）。 */
(function(root){
"use strict";
const D2R=Math.PI/180;
function M(T,f,r,d){ return new T.Vector3(r,-d,-f); }          // FRD → モデル座標
function buildGeo(T,verts,idx,uvs,smooth){ const g=new T.BufferGeometry(); const p=new Float32Array(verts.length*3); verts.forEach((v,i)=>{ p[i*3]=v.x; p[i*3+1]=v.y; p[i*3+2]=v.z; });
  g.setAttribute("position",new T.BufferAttribute(p,3)); if(uvs){ const u=new Float32Array(uvs.length*2); uvs.forEach((v,i)=>{ u[i*2]=v[0]; u[i*2+1]=v[1]; }); g.setAttribute("uv",new T.BufferAttribute(u,2)); }
  g.setIndex(idx); g.computeVertexNormals(); return g; }
// リング列からメッシュ（各リングは同数の頂点。閉じた断面）
function ringGeo(T,rings,uvFn,capStart,capEnd){
  const n=rings[0].length, verts=[],uvs=[],idx=[];
  rings.forEach((rg,i)=>{ rg.forEach((v,j)=>{ verts.push(v); uvs.push(uvFn?uvFn(i,j,rings.length,n):[i/(rings.length-1),j/n]); }); });
  // 周方向を 1 周分余分に取って UV の継ぎ目を作るため j=n の複製頂点も追加
  const rowStride=n+1; verts.length=0; uvs.length=0;
  rings.forEach((rg,i)=>{ for(let j=0;j<=n;j++){ verts.push(rg[j%n]); uvs.push(uvFn?uvFn(i,j,rings.length,n):[i/(rings.length-1),j/n]); } });
  for(let i=0;i<rings.length-1;i++) for(let j=0;j<n;j++){ const a=i*rowStride+j,b=a+1,c=a+rowStride,d=c+1; idx.push(a,c,b,b,c,d); }
  return buildGeo(T,verts,idx,uvs); }
// 主翼などの積層（断面: 翼型の上面・下面）。stations: [{le:[f,r,d], chord, thick, twist}] 、翼型は対称+軽いキャンバー
function airfoil(n){ const pts=[]; for(let i=0;i<=n;i++){ const x=i/n, xc=Math.pow(x,1.4); const yt=5*0.12*(0.2969*Math.sqrt(xc)-0.126*xc-0.3516*xc*xc+0.2843*xc*xc*xc-0.1015*xc*xc*xc*xc); pts.push([xc,yt]); } return pts; }
function wingGeo(T,st,opts){
  opts=opts||{}; const NS=14, af=airfoil(NS); const verts=[],idx=[]; const rows=st.length; const per=(NS+1)*2;       // 上面(前→後) + 下面(後→前)
  const profile=[]; for(let i=0;i<=NS;i++) profile.push([af[i][0],af[i][1]*1.0+0.012*Math.sin(Math.PI*af[i][0])]); for(let i=NS;i>=0;i--) profile.push([af[i][0],-af[i][1]*0.9+0.012*Math.sin(Math.PI*af[i][0])]);
  st.forEach(s=>{ const th=s.thick==null?1:s.thick; for(const [x,y] of profile){ const f=s.le[0]-x*s.chord, d=s.le[2]-y*s.chord*th*(s.thickK||1)*1.0; verts.push(M(T,f,s.le[1],d)); } });
  for(let i=0;i<rows-1;i++) for(let j=0;j<per;j++){ const j2=(j+1)%per; const a=i*per+j,b=i*per+j2,c=(i+1)*per+j,d=(i+1)*per+j2; idx.push(a,b,c,b,d,c); }
  // 翼端のふた
  const base=(rows-1)*per; for(let j=1;j<per-1;j++) idx.push(base,base+j+1,base+j);
  const g=buildGeo(T,verts,idx,null); return g; }
// 平板（舵面・フラップ）: 4 隅 (FRD) から厚み付きの箱
function slab(T,c4,t){ const v=[]; const n=new T.Vector3(); // c4: [前縁内側, 前縁外側, 後縁外側, 後縁内側] FRD
  const P=c4.map(p=>M(T,p[0],p[1],p[2])); const o=new T.Vector3(0,t,0); const verts=[...P.map(p=>p.clone().add(o)),...P.map(p=>p.clone().sub(o))];
  const idx=[0,1,2,0,2,3, 4,6,5,4,7,6, 0,4,5,0,5,1, 1,5,6,1,6,2, 2,6,7,2,7,3, 3,7,4,3,4,0]; return buildGeo(T,verts,idx,null); }

class Aircraft{
  constructor(THREE,opts){
    const T=this.T=THREE; opts=opts||{}; this.root=new T.Group(); this.root.name="aircraft";
    const L=this.liv=opts.livery||{};
    const white=new T.MeshStandardMaterial({color:0xf2f3f5,roughness:0.42,metalness:0.08});
    this.matBody=new T.MeshStandardMaterial({map:this.liveryTexture(L),roughness:0.40,metalness:0.10});
    const gray=new T.MeshStandardMaterial({color:0xb9bdc4,roughness:0.5,metalness:0.3}), dark=new T.MeshStandardMaterial({color:0x202226,roughness:0.7,metalness:0.1}), tire=new T.MeshStandardMaterial({color:0x151515,roughness:0.95});
    const wingM=new T.MeshStandardMaterial({color:0xe6e8ec,roughness:0.5,metalness:0.12,side:T.DoubleSide}), underM=new T.MeshStandardMaterial({color:0xb4b8c0,roughness:0.55,metalness:0.2,side:T.DoubleSide});
    const stripeM=new T.MeshStandardMaterial({color:L.accent||0xf08a9a,roughness:0.45,metalness:0.1,side:T.DoubleSide});
    const glass=new T.MeshStandardMaterial({color:0x0c1520,roughness:0.12,metalness:0.6});
    const nac=new T.MeshStandardMaterial({color:0xd8dbe0,roughness:0.4,metalness:0.4});
    this.m={white,gray,dark,tire,wingM,stripeM,glass,nac,under:underM};
    // ---------------- 胴体 ----------------
    const rings=[]; const NR=40, NA=28;
    const prof=(f)=>{ // 半径と軸の上下オフセット（下向き正）
      const nose=19.4, tail=-20.2; let r=1.88, off=0;
      if(f>13){ const t=(nose-f)/(nose-13); r=1.88*Math.pow(Math.max(0,1-Math.pow(1-Math.min(1,t),2.2)),0.55); off=0.45*(1-t)*0.0+0.35*(1-Math.min(1,t)); }
      else if(f<-9){ const t=(-9-f)/(-9-tail); r=1.88*(1-0.82*Math.pow(t,1.35)); off=-1.15*Math.pow(t,2.0); }
      return [Math.max(r,0.02),off]; };
    const fs=[]; for(let i=0;i<NR;i++){ const t=i/(NR-1); let f; if(t<0.25) f=19.4-Math.pow(t/0.25,0.8)*(19.4-13); else if(t<0.72) f=13-(t-0.25)/0.47*22; else f=-9-(t-0.72)/0.28*(-9+20.2)*(-1)*(-1); fs.push(f); }
    // 均等に再配置
    fs.length=0; const stops=[19.4,19.1,18.6,17.6,16.2,14.6,13,10,6,2,-2,-6,-9,-11,-13,-15,-17,-18.6,-19.7,-20.2]; for(let i=0;i<stops.length;i++) fs.push(stops[i]);
    for(const f of fs){ const [r,off]=prof(f); const ring=[]; for(let j=0;j<NA;j++){ const th=j/NA*2*Math.PI; ring.push(M(T,f,Math.sin(th)*r*(1.0),-Math.cos(th)*r*0.98+off)); } rings.push(ring); }
    const fg=ringGeo(T,rings,(i,j,nr,n)=>{ const f=fs[i]; return [ (19.4-f)/39.6, j/n ]; });
    const fus=new T.Mesh(fg,this.matBody); this.root.add(fus); this.fuselage=fus;
    // コックピット窓（風防）
    const wnd=(f0,f1,r,d0,d1)=>{ const c4=[[f0,r,d0],[f0,r*0.97,d1],[f1,r*0.97,d1],[f1,r,d0]]; };
    const mkWin=(pts)=>{ const geo=buildGeo(T,pts.map(p=>M(T,p[0],p[1],p[2])),[0,1,2,0,2,3,0,2,1,0,3,2],null); const m=new T.Mesh(geo,glass); this.root.add(m); };
    // ---------------- 主翼 ----------------
    const dz0=0.92, tipUp=1.35;
    const wsta=[ {le:[2.5,1.9,dz0],chord:6.9,thick:1.45}, {le:[0.8,5.9,dz0-0.38],chord:6.0,thick:1.15}, {le:[-5.4,17.0,dz0-tipUp-0.2],chord:1.55,thick:0.80} ];
    // 中間断面を補って緩やかに
    const lerp=(a,b,t)=>a+(b-a)*t; const stations=[];
    const stp=[0,0.35,1]; // dummy
    const secs=[ {y:1.9,le:2.5,ch:6.9,th:1.5,dz:dz0}, {y:5.9,le:0.7,ch:6.2,th:1.25,dz:dz0-0.38}, {y:11.5,le:-2.4,ch:3.6,th:0.95,dz:dz0-0.95}, {y:16.9,le:-5.4,ch:1.55,th:0.8,dz:dz0-1.55} ];
    this.wingParts=[];
    for(const sd of [-1,1]){
      const st=secs.map(s=>({le:[s.le,sd*s.y,s.dz],chord:s.ch,thick:s.th*0.5}));
      const wg=new T.Mesh(wingGeo(T,sd<0?st:st),wingM); this.root.add(wg);
      // 翼下面の色
      // ウイングレット
      const wl=slab(T,[[ -5.0,sd*16.9,dz0-1.55],[ -5.05,sd*17.2,dz0-1.55-0.2],[ -6.55,sd*17.25,dz0-1.55-0.2],[ -6.55,sd*16.9,dz0-1.55]],0.03);
      const gl=new T.BufferGeometry(); // 傾いた板（立ち上がり）
      const wv=[[-5.2,sd*16.9,dz0-1.55],[-6.7,sd*16.9,dz0-1.55],[-7.1,sd*17.55,dz0-1.55-2.3],[-7.9,sd*17.55,dz0-1.55-2.3]];
      const wlg=buildGeo(T,[M(T,...wv[0]),M(T,...wv[1]),M(T,...wv[3]),M(T,...wv[2]), M(T,wv[0][0],wv[0][1]+sd*0.06,wv[0][2]),M(T,wv[1][0],wv[1][1]+sd*0.06,wv[1][2]),M(T,wv[3][0],wv[3][1]+sd*0.06,wv[3][2]),M(T,wv[2][0],wv[2][1]+sd*0.06,wv[2][2])],[0,1,2,0,2,3,4,6,5,4,7,6],null);
      const wlm=new T.Mesh(wlg,wingM); this.root.add(wlm);
      // 翼端の色帯
      // フラップ（後縁）: 内側・外側の二つ。ヒンジは後縁（前方に移した位置）で回転
      const flaps=[]; const defs=[ {y0:2.6,y1:5.6}, {y0:6.3,y1:10.3} ];
      for(const fdef of defs){
        const chordAt=(y)=>{ for(let i=0;i<secs.length-1;i++){ const a=secs[i],b=secs[i+1]; if(y>=a.y&&y<=b.y){ const t=(y-a.y)/(b.y-a.y); return {le:lerp(a.le,b.le,t),ch:lerp(a.ch,b.ch,t),dz:lerp(a.dz,b.dz,t)}; } } return {le:secs[0].le,ch:secs[0].ch,dz:secs[0].dz}; };
        const A=chordAt(fdef.y0), B=chordAt(fdef.y1); const fr=0.30; const teA=A.le-A.ch, teB=B.le-B.ch;
        // ヒンジ位置: 後縁から fr*chord 手前
        const hA=[teA+fr*A.ch, A.dz], hB=[teB+fr*B.ch, B.dz];
        const grp=new T.Group(); const flap=slab(T,[[hA[0],sd*fdef.y0,A.dz+0.04],[hB[0],sd*fdef.y1,B.dz+0.04],[teB,sd*fdef.y1,B.dz+0.06],[teA,sd*fdef.y0,A.dz+0.06]],0.02);
        const mesh=new T.Mesh(flap,wingM); grp.add(mesh);
        // 回転軸: ヒンジ線（翼幅方向に近い）。ヒンジ線の中点にピボット
        const mid=M(T,(hA[0]+hB[0])/2,sd*(fdef.y0+fdef.y1)/2,(A.dz+B.dz)/2); grp.position.copy(mid); mesh.position.copy(mid).negate();
        const axis=M(T,hB[0]-hA[0],sd*(fdef.y1-fdef.y0),B.dz-A.dz).normalize();
        grp.userData={axis,sd,kind:"flap"}; this.root.add(grp); flaps.push(grp); }
      // スラット（前縁）
      const slats=[]; for(const sdef of [{y0:2.6,y1:6.0},{y0:6.6,y1:15.8}]){
        const chordAt=(y)=>{ for(let i=0;i<secs.length-1;i++){ const a=secs[i],b=secs[i+1]; if(y>=a.y&&y<=b.y){ const t=(y-a.y)/(b.y-a.y); return {le:lerp(a.le,b.le,t),ch:lerp(a.ch,b.ch,t),dz:lerp(a.dz,b.dz,t)}; } } return secs[secs.length-1]; };
        const A=chordAt(sdef.y0),B=chordAt(sdef.y1); const grp=new T.Group(); const sl=slab(T,[[A.le+0.06,sd*sdef.y0,A.dz],[B.le+0.06,sd*sdef.y1,B.dz],[B.le-B.ch*0.12,sd*sdef.y1,B.dz+0.02],[A.le-A.ch*0.12,sd*sdef.y0,A.dz+0.02]],0.02);
        const mesh=new T.Mesh(sl,wingM); grp.add(mesh); const mid=M(T,(A.le+B.le)/2,sd*(sdef.y0+sdef.y1)/2,(A.dz+B.dz)/2); grp.position.copy(mid); mesh.position.copy(mid).negate(); grp.userData={sd,kind:"slat",f0:(A.le+B.le)/2}; this.root.add(grp); slats.push(grp); }
      // 補助翼
      { const A={le:-2.4,ch:3.6,dz:dz0-0.95}, y0=11.0, y1=15.8; const chordAt=(y)=>{ for(let i=0;i<secs.length-1;i++){ const a=secs[i],b=secs[i+1]; if(y>=a.y&&y<=b.y){ const t=(y-a.y)/(b.y-a.y); return {le:lerp(a.le,b.le,t),ch:lerp(a.ch,b.ch,t),dz:lerp(a.dz,b.dz,t)}; } } return secs[secs.length-1]; };
        const a0=chordAt(y0), a1=chordAt(y1); const fr=0.28; const grp=new T.Group(); const sl=slab(T,[[a0.le-a0.ch*(1-fr),sd*y0,a0.dz+0.03],[a1.le-a1.ch*(1-fr),sd*y1,a1.dz+0.03],[a1.le-a1.ch,sd*y1,a1.dz+0.04],[a0.le-a0.ch,sd*y0,a0.dz+0.04]],0.02);
        const mesh=new T.Mesh(sl,wingM); grp.add(mesh); const hmid=M(T,((a0.le-a0.ch*(1-fr))+(a1.le-a1.ch*(1-fr)))/2,sd*(y0+y1)/2,(a0.dz+a1.dz)/2); grp.position.copy(hmid); mesh.position.copy(hmid).negate();
        grp.userData={axis:M(T,(a1.le-a1.ch*(1-fr))-(a0.le-a0.ch*(1-fr)),sd*(y1-y0),a1.dz-a0.dz).normalize(),sd,kind:"aileron"}; this.root.add(grp); this.wingParts.push(grp); }
      // スポイラー（上面）
      const spo=[]; for(const sdef of [{y0:6.8,y1:8.2},{y0:8.4,y1:9.9},{y0:10.1,y1:10.9}]){
        const chordAt=(y)=>{ for(let i=0;i<secs.length-1;i++){ const a=secs[i],b=secs[i+1]; if(y>=a.y&&y<=b.y){ const t=(y-a.y)/(b.y-a.y); return {le:lerp(a.le,b.le,t),ch:lerp(a.ch,b.ch,t),dz:lerp(a.dz,b.dz,t)}; } } return secs[secs.length-1]; };
        const A=chordAt(sdef.y0), B=chordAt(sdef.y1); const fr=0.36; const grp=new T.Group(); const th=0.30;
        const sl=slab(T,[[A.le-A.ch*(1-fr),sd*sdef.y0,A.dz-0.18],[B.le-B.ch*(1-fr),sd*sdef.y1,B.dz-0.18],[B.le-B.ch*(1-fr)*0.0-B.ch*0.97,sd*sdef.y1,B.dz-0.12],[A.le-A.ch*0.97,sd*sdef.y0,A.dz-0.12]],0.015);
        const mesh=new T.Mesh(sl,wingM); grp.add(mesh); const hmid=M(T,((A.le-A.ch*(1-fr))+(B.le-B.ch*(1-fr)))/2,sd*(sdef.y0+sdef.y1)/2,(A.dz+B.dz)/2-0.16); grp.position.copy(hmid); mesh.position.copy(hmid).negate();
        grp.userData={axis:M(T,(B.le-B.ch*(1-fr))-(A.le-A.ch*(1-fr)),sd*(sdef.y1-sdef.y0),B.dz-A.dz).normalize(),sd,kind:"spoiler"}; this.root.add(grp); spo.push(grp); }
      this.wingParts.push(...flaps,...slats,...spo);
    }
    // ---------------- 水平尾翼・垂直尾翼 ----------------
    this.tailParts=[];
    const hsec=[ {y:0.9,le:-14.8,ch:4.6,dz:-0.35}, {y:3.8,le:-16.7,ch:2.9,dz:-0.62}, {y:7.1,le:-18.9,ch:1.45,dz:-0.92} ];
    for(const sd of [-1,1]){
      const st=hsec.map(s=>({le:[s.le,sd*s.y,s.dz],chord:s.ch,thick:0.48}));
      this.root.add(new T.Mesh(wingGeo(T,st),wingM));
      // 昇降舵
      const A=hsec[0], B=hsec[2]; const fr=0.30; const grp=new T.Group(); const y0=1.0,y1=7.0; const chordAt=(y)=>{ for(let i=0;i<hsec.length-1;i++){ const a=hsec[i],b=hsec[i+1]; if(y>=a.y&&y<=b.y){ const t=(y-a.y)/(b.y-a.y); return {le:lerp(a.le,b.le,t),ch:lerp(a.ch,b.ch,t),dz:lerp(a.dz,b.dz,t)}; } } return hsec[hsec.length-1]; };
      const a0=chordAt(y0), a1=chordAt(y1); const sl=slab(T,[[a0.le-a0.ch*(1-fr),sd*y0,a0.dz+0.02],[a1.le-a1.ch*(1-fr),sd*y1,a1.dz+0.02],[a1.le-a1.ch,sd*y1,a1.dz+0.03],[a0.le-a0.ch,sd*y0,a0.dz+0.03]],0.02);
      const mesh=new T.Mesh(sl,wingM); grp.add(mesh); const hm=M(T,((a0.le-a0.ch*(1-fr))+(a1.le-a1.ch*(1-fr)))/2,sd*(y0+y1)/2,(a0.dz+a1.dz)/2); grp.position.copy(hm); mesh.position.copy(hm).negate();
      grp.userData={axis:M(T,(a1.le-a1.ch*(1-fr))-(a0.le-a0.ch*(1-fr)),sd*(y1-y0),a1.dz-a0.dz).normalize(),kind:"elevator",sd}; this.root.add(grp); this.tailParts.push(grp);
    }
    // 垂直尾翼: 断面を積層（中心 y=0）。高さ方向に積む
    { const vst=[ {z:-1.5,le:-10.6,ch:7.4}, {z:-4.2,le:-13.1,ch:4.7}, {z:-8.6,le:-17.0,ch:2.5} ];
      const verts=[],idx=[]; const NS=12, af=airfoil(NS); const prof=[]; for(let i=0;i<=NS;i++) prof.push([af[i][0],af[i][1]]); for(let i=NS;i>=0;i--) prof.push([af[i][0],-af[i][1]]); const per=prof.length;
      // 中間点
      const sec=[]; for(let k=0;k<=6;k++){ const t=k/6; const zz=lerp(vst[0].z,vst[2].z,t); let le,ch; if(t<0.4){ const u=t/0.4; le=lerp(vst[0].le,vst[1].le,u); ch=lerp(vst[0].ch,vst[1].ch,u); } else { const u=(t-0.4)/0.6; le=lerp(vst[1].le,vst[2].le,u); ch=lerp(vst[1].ch,vst[2].ch,u); } sec.push({z:zz,le,ch}); }
      const fuv=[]; sec.forEach((s,si)=>{ for(const [x,y] of prof){ verts.push(M(T,s.le-x*s.ch,y*s.ch*0.55,s.z)); fuv.push([ (1-x)*0.9+ (si/6)*0.05, 1-si/6 ]); } });
      for(let i=0;i<sec.length-1;i++) for(let j=0;j<per;j++){ const j2=(j+1)%per; const a=i*per+j,b=i*per+j2,c=(i+1)*per+j,d=(i+1)*per+j2; idx.push(a,b,c,b,d,c); }
      const base=(sec.length-1)*per; for(let j=1;j<per-1;j++) idx.push(base,base+j+1,base+j);
      this.fin=new T.Mesh(buildGeo(T,verts,idx,fuv),this.matBody.clone()); this.fin.material.map=this.finTexture(L); this.fin.material.side=T.DoubleSide; this.root.add(this.fin);
      // 方向舵
      const fr=0.30; const a0=sec[0], a1=sec[sec.length-1]; const grp=new T.Group(); const sl=slab(T,[[a0.le-a0.ch*(1-fr),0,a0.z],[a1.le-a1.ch*(1-fr),0,a1.z],[a1.le-a1.ch,0,a1.z],[a0.le-a0.ch,0,a0.z]],0.045);
      const mesh=new T.Mesh(sl,wingM); grp.add(mesh); const hm=M(T,((a0.le-a0.ch*(1-fr))+(a1.le-a1.ch*(1-fr)))/2,0,(a0.z+a1.z)/2); grp.position.copy(hm); mesh.position.copy(hm).negate();
      grp.userData={axis:M(T,(a1.le-a1.ch*(1-fr))-(a0.le-a0.ch*(1-fr)),0,a1.z-a0.z).normalize(),kind:"rudder"}; this.root.add(grp); this.tailParts.push(grp); this.finTop=M(T,-17.0,0,-8.6); }
    // ---------------- エンジン ----------------
    this.engines=[];
    for(const sd of [-1,1]){
      const grp=new T.Group(); const cy=sd*5.1, cz=1.15; const fr0=4.3, ba=-2.2;
      const pr=[ [4.4,0.0],[4.35,0.78],[4.1,1.0],[3.0,1.06],[1.2,1.04],[-0.4,0.95],[-1.4,0.78],[-2.1,0.55],[-2.5,0.40] ];
      const rings=[]; for(const [f,r] of pr){ const ring=[]; for(let j=0;j<20;j++){ const th=j/20*2*Math.PI; const rr=Math.max(r,0.001); ring.push(M(T,f,cy+Math.sin(th)*rr*1.0,cz-Math.cos(th)*rr*0.97+(th>Math.PI/2&&th<3*Math.PI/2?0.06*rr:0))); } rings.push(ring); }
      const nacg=ringGeo(T,rings,(i,j,nr,n)=>[i/(nr-1),j/n]); const nm=new T.Mesh(nacg,nac); grp.add(nm);
      // 吸気口（黒）とファン
      const inlet=new T.Mesh(new T.CircleGeometry(0.76,24),dark); inlet.position.copy(M(T,4.30,cy,cz)); inlet.rotation.y=Math.PI; grp.add(inlet);
      const fanTex=this.fanTexture(); const fan=new T.Mesh(new T.CircleGeometry(0.74,28),new T.MeshBasicMaterial({map:fanTex,transparent:true})); fan.position.copy(M(T,4.26,cy,cz)); fan.rotation.y=Math.PI; grp.add(fan); this.engines.push({fan,sd});
      // スピナー
      const sp=new T.Mesh(new T.ConeGeometry(0.22,0.5,16),new T.MeshStandardMaterial({color:0xe8e8ea,roughness:0.4,metalness:0.4})); sp.rotation.x=Math.PI/2; sp.position.copy(M(T,4.28+0.0,cy,cz)); sp.rotation.set(-Math.PI/2,0,0); sp.position.z-=0.2; fan.add(sp); sp.position.set(0,0,-0.0); sp.rotation.set(Math.PI/2,0,0); sp.position.z=-0.25;
      // 排気コーン
      const ex=new T.Mesh(new T.ConeGeometry(0.34,1.1,16),gray); ex.rotation.x=-Math.PI/2; ex.position.copy(M(T,-2.2,cy,cz)); grp.add(ex);
      // パイロン
      const py=slab(T,[[3.6,cy*0.98,0.2],[3.6,cy*0.98,cz-0.55],[-1.4,cy*0.98,cz-0.55],[-1.0,cy*0.98,0.2]],0.12); grp.add(new T.Mesh(py,wingM));
      this.root.add(grp); }
    // ---------------- 脚 ----------------
    this.gearNodes={};
    const mkWheel=(r,w)=>{ const g=new T.Group(); const t=new T.Mesh(new T.CylinderGeometry(r,r,w,20),tire); t.rotation.z=Math.PI/2; g.add(t); const hub=new T.Mesh(new T.CylinderGeometry(r*0.55,r*0.55,w*1.04,14),gray); hub.rotation.z=Math.PI/2; g.add(hub); return g; };
    // 前脚: ヒンジ(前輪格納庫上部) → 下へ。格納は前方へ回転
    { const piv=new T.Group(); piv.position.copy(M(T,12.6,0,1.3)); const strut=new T.Mesh(new T.CylinderGeometry(0.075,0.075,2.2,10),gray); strut.position.set(0,-1.1,0); piv.add(strut);
      const oleo=new T.Mesh(new T.CylinderGeometry(0.1,0.1,0.9,10),gray); oleo.position.set(0,-0.5,0); piv.add(oleo);
      const wl=new T.Group(); wl.position.set(0,-2.2,0); for(const sx of [-0.2,0.2]){ const w=mkWheel(0.34,0.2); w.position.set(sx,0,0); wl.add(w); } piv.add(wl);
      const door=new T.Mesh(new T.BoxGeometry(0.9,0.02,1.4),white); door.position.set(0,-0.15,0); piv.add(door);
      this.root.add(piv); this.gearNodes.nose={piv,wheels:[wl],steer:piv,retract:"fwd",wheelR:0.34}; }
    for(const sd of [-1,1]){
      const piv=new T.Group(); piv.position.copy(M(T,-0.3,sd*2.6,0.9)); const strut=new T.Mesh(new T.CylinderGeometry(0.12,0.12,2.1,10),gray); strut.position.set(sd*0.55,-1.0,0); strut.rotation.z=sd*0.25; piv.add(strut);
      const truck=new T.Group(); truck.position.set(sd*1.0,-2.45,-1.0); piv.add(truck); // ホイール
      const wl=new T.Group(); wl.position.set(0,0,0); for(const dz of [-0.4,0.4]){ for(const k of [0]){ const w=mkWheel(0.5,0.26); w.position.set(sd*0.0,0,dz*1.0); wl.add(w); } } truck.add(wl);
      // 4輪: 左右(進行方向前後)
      const wl2=new T.Group(); for(const dz of [-0.45,0.45]) for(const dx of [-0.3,0.3]){ const w=mkWheel(0.5,0.26); w.position.set(sd*dx,0,dz); wl2.add(w); } truck.remove(wl); truck.add(wl2);
      const door=new T.Mesh(new T.BoxGeometry(0.02,1.7,1.8),white); door.position.set(sd*1.6,-0.3,0); piv.add(door);
      this.root.add(piv); this.gearNodes[sd<0?"mainL":"mainR"]={piv,wheels:[wl2],retract:"in",sd,wheelR:0.5}; }
    // ---------------- 灯火 ----------------
    this.lights=this.makeLights();
    this.root.traverse(o=>{ if(o.isMesh){ o.castShadow=false; o.frustumCulled=true; } });
    this.root.frustumCulled=false; this.t=0;
  }
  // ---------- テクスチャ ----------
  liveryTexture(L){
    const W=4096,H=1024; const c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
    x.fillStyle="#f1f2f4"; x.fillRect(0,0,W,H);
    const accent=L.accentCss||"#ef7f93", dk=L.darkCss||"#2a3140";
    // u: 機首(0)→機尾(1)。v: 上(0)→右(0.25)→下(0.5)→左(0.75)
    const U=f=>(19.4-f)/39.6*W; const V=th=>th/360*H;
    // 下面グレー
    x.fillStyle="#c9ccd2"; x.fillRect(0,V(125),W,V(110));
    const side=(vmid,rot)=>{
      x.save(); const cy=V(vmid);
      if(rot){ x.translate(0,2*cy); x.scale(1,-1); }   // 右舷側は貼り付けが上下反転するので、描画も反転しておく
      x.fillStyle="#1b2230"; for(let f=14.0; f>-14.5; f-=0.76){ const wx=U(f); if(f>12.9&&f<14.2) continue; x.fillRect(wx,cy-V(6.2),12,V(5.0)); }
      x.fillStyle=accent; x.fillRect(U(15.5),cy+V(8),U(-17.5)-U(15.5),V(3.2)); x.fillStyle=dk; x.fillRect(U(15.5),cy+V(11.5),U(-17.5)-U(15.5),V(0.9));
      x.strokeStyle="#9aa0a8"; x.lineWidth=2; for(const f of [13.3,-1.0,-14.2]){ x.strokeRect(U(f)-18,cy-V(10),36,V(18)); } for(const f of [5.0,-4.4]){ x.strokeRect(U(f)-14,cy-V(7),28,V(11)); }
      // 社名ロゴ（架空）。右舷は 180° 回転して貼られる（機首が右側に見える）
      x.translate(rot?U(3.5)+140:U(3.5)-110, cy-V(12)); if(rot) x.scale(-1,1);
      x.fillStyle=dk; x.font="bold "+Math.round(H*0.075)+"px 'Helvetica Neue',Arial,sans-serif"; x.textBaseline="alphabetic"; x.fillText(L.name||"MOMOTARO AIR",-30,0); x.restore(); };
    side(90,false); side(270,true);
    // 上面（細い帯）
    x.fillStyle="#e4e6ea"; x.fillRect(0,0,W,V(40)); x.fillRect(0,V(320),W,V(40));
    // 風防（機首の上側。θ=0 が真上）
    x.fillStyle="#0d141d"; const win=(f0,f1,t0,t1,sd)=>{ // θ 範囲を左右に
      const quad=(a0,a1)=>{ x.beginPath(); x.moveTo(U(f0),V(a0)); x.lineTo(U(f1),V(a0+ (a1-a0)*0.0+ (f1<f0?-2:2)*0)); x.lineTo(U(f1),V(a1)); x.lineTo(U(f0),V(a1+3)); x.closePath(); x.fill(); };
      if(sd>0) quad(t0,t1); else quad(360-t1,360-t0); };
    for(const sd of [1,-1]){ win(16.5,15.6,30,62,sd); win(15.5,14.6,34,70,sd); win(14.45,13.5,66,92,sd); }
    // 先端の色（レドーム）
    x.fillStyle="#cfd2d8"; x.fillRect(0,0,U(18.2),H);
    const t=new this.T.CanvasTexture(c); t.anisotropy=8; t.wrapS=this.T.ClampToEdgeWrapping; t.wrapT=this.T.RepeatWrapping; t.minFilter=this.T.LinearMipmapLinearFilter; return t; }
  finTexture(L){ const c=document.createElement("canvas"); c.width=512; c.height=512; const x=c.getContext("2d"); x.fillStyle=L.accentCss||"#ef7f93"; x.fillRect(0,0,512,512);
    // 桃のマーク（単純化）
    x.fillStyle="#fff"; x.beginPath(); x.arc(256,290,120,0,Math.PI*2); x.fill(); x.fillStyle="#f6b7c1"; x.beginPath(); x.arc(256,290,92,0,Math.PI*2); x.fill(); x.fillStyle="#5bb26f"; x.beginPath(); x.ellipse(305,170,70,26,-0.5,0,Math.PI*2); x.fill();
    const t=new this.T.CanvasTexture(c); return t; }
  fanTexture(){ const c=document.createElement("canvas"); c.width=c.height=128; const x=c.getContext("2d"); x.translate(64,64); x.fillStyle="#15171b"; x.beginPath(); x.arc(0,0,63,0,Math.PI*2); x.fill();
    x.strokeStyle="rgba(190,195,205,0.85)"; x.lineWidth=5; for(let i=0;i<24;i++){ x.rotate(Math.PI*2/24); x.beginPath(); x.moveTo(8,0); x.quadraticCurveTo(30,-9,58,-4); x.stroke(); }
    x.fillStyle="#2a2d33"; x.beginPath(); x.arc(0,0,10,0,Math.PI*2); x.fill(); return new this.T.CanvasTexture(c); }
  // ---------- 灯火（スプライト） ----------
  glowTexture(){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const g=x.createRadialGradient(32,32,0,32,32,32); g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.25,"rgba(255,255,255,0.55)"); g.addColorStop(1,"rgba(255,255,255,0)"); x.fillStyle=g; x.fillRect(0,0,64,64); return new this.T.CanvasTexture(c); }
  makeLights(){
    const T=this.T, tex=this.glowTexture(); const mk=(color,pos,size,kind)=>{ const m=new T.SpriteMaterial({map:tex,color,transparent:true,depthWrite:false,blending:T.AdditiveBlending}); const s=new T.Sprite(m); s.position.copy(M(T,...pos)); s.scale.setScalar(size); s.userData={kind,base:size}; this.root.add(s); return s; };
    const L=[];
    L.push(mk(0xff2a1a,[-6.9,-17.6,-0.9-1.2],0.7,"nav"));                  // 左翼端 赤
    L.push(mk(0x20ff60,[-6.9,17.6,-0.9-1.2],0.7,"nav"));                   // 右 緑
    L.push(mk(0xffffff,[-20.1,0,-1.6],0.6,"nav"));                          // 尾灯
    L.push(mk(0xffffff,[-8.0,-17.55,-0.9-1.5],0.9,"strobe")); L.push(mk(0xffffff,[-8.0,17.55,-0.9-1.5],0.9,"strobe")); L.push(mk(0xffffff,[-20.0,0,-1.7],0.9,"strobe"));
    L.push(mk(0xff2200,[3.0,0,-1.95],0.8,"beacon")); L.push(mk(0xff2200,[3.0,0,1.95],0.8,"beacon"));
    L.push(mk(0xffffff,[1.2,-3.6,1.1],1.6,"landing")); L.push(mk(0xffffff,[1.2,3.6,1.1],1.6,"landing"));
    L.push(mk(0xffffee,[12.4,0,2.2],1.3,"taxi"));
    L.push(mk(0xffffff,[-3.0,-3.0,-1.4],0.5,"logo"));
    return L; }
  // ---------- 毎フレーム ----------
  update(s,ctl,dt,night,lightsOn,env){
    this.t+=dt; const T=this.T, t=this.t;
    // 脚
    const g=s.gear; const gn=this.gearNodes;
    for(const k of ["nose","mainL","mainR"]){ const n=gn[k]; const a=(1-g); n.piv.visible=g>0.02||true;
      if(k==="nose"){ n.piv.rotation.x=a*Math.PI*0.5; n.piv.rotation.y=(s.nws||0)*0.0; }
      else n.piv.rotation.z=n.sd*(-a)*Math.PI*0.5*(-1)*(-1)*(-1)*(-1);
      n.piv.visible=g>0.005;
      if(g>0.9){ const rate=(s.gs||0)/n.wheelR; for(const w of n.wheels) for(const c of w.children){ c.rotation.x=0; } for(const w of n.wheels){ w.children.forEach(ch=>{ ch.children[0]&&(ch.children[0].rotation.x=(ch.children[0].rotation.x+rate*dt)%(Math.PI*2)); }); } } }
    if(gn.nose) gn.nose.piv.children.forEach(c=>{});
    // フラップ・スラット
    const fl=s.flaps; const flapDef=[0,1,2,5,10,15,25,30,40]; const i0=Math.min(8,Math.floor(fl)), i1=Math.min(8,i0+1), tt=fl-i0; const deg=flapDef[i0]+(flapDef[i1]-flapDef[i0])*tt;
    const aileron=(s.ail||0), elev=(s.elev||0), rud=(s.rud||0), spoil=Math.max(s.speedbrake||0,s.groundSpoilers?1:0);
    for(const p of this.wingParts){ const u=p.userData; p.quaternion.identity();
      if(u.kind==="flap"){ p.quaternion.setFromAxisAngle(u.axis,-u.sd*0+(-deg*D2R*0.9)*(u.sd<0?1:1)*(1)); p.position.z=p.userData.z0===undefined?p.position.z:p.position.z; }
      else if(u.kind==="slat"){ const ext=Math.min(1,deg/5); p.position.z=(p.userData.pz0===undefined?(p.userData.pz0=p.position.z):p.userData.pz0)-ext*0.0; p.rotation.x=0; p.scale.set(1,1,1); p.position.z=p.userData.pz0-ext*0.14; p.rotation.x=ext*0.22*(1); }
      else if(u.kind==="aileron"){ p.quaternion.setFromAxisAngle(u.axis,aileron*u.sd*(-1)*0.4); }
      else if(u.kind==="spoiler"){ p.quaternion.setFromAxisAngle(u.axis,-spoil*0.9*(-1)); } }
    for(const p of this.tailParts){ const u=p.userData; p.quaternion.identity(); if(u.kind==="elevator") p.quaternion.setFromAxisAngle(u.axis,elev*0.40*(u.sd<0?-1:-1)*(-1)); else if(u.kind==="rudder") p.quaternion.setFromAxisAngle(u.axis,rud*0.45*(-1)); }
    // ファン回転
    for(const e of this.engines){ const th=Math.max(0.02,(s.thr&&s.thr[e.sd<0?0:1])||0); e.fan.rotation.z+=dt*(8+th*55); }
    // 灯火
    const flash=(Math.sin(t*2*Math.PI*1.0)>0.92)||(Math.sin(t*2*Math.PI*1.0+0.7)>0.94); const bc=Math.sin(t*2*Math.PI*0.7)>0.2;
    const dayK=night>0.5?1.0:0.55;
    for(const l of this.lights){ const k=l.userData.kind; let on=false,sz=l.userData.base; const m=l.material;
      if(k==="nav") on=lightsOn.nav; else if(k==="strobe") on=lightsOn.strobe&&flash; else if(k==="beacon") on=lightsOn.beacon&&bc; else if(k==="landing") on=lightsOn.landing&&g>0.9; else if(k==="taxi") on=lightsOn.taxi&&(g>0.9); else if(k==="logo") on=lightsOn.logo&&night>0.4;
      l.visible=on; if(on){ m.opacity=(k==="landing"?0.9:(k==="strobe"?1:0.95))*(night>0.3?1:0.55); } }
  }
}
root.Aircraft=Aircraft;
})(typeof window!=="undefined"?window:globalThis);
