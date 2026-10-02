/* ランドマーク: 東京タワー、東京スカイツリー、レインボーブリッジ。
   位置は公表されている座標と航空写真（橋の線形）から。形は簡略化した手作りモデル（実物の細部とは違う）。
   空港と同じくカメラ相対（浮動原点）で置く。 */
(function(root){
"use strict";
const G=root.GEO, D2R=Math.PI/180;
function lattice(base,band){   // 格子（X ブレース）の透過テクスチャ。band=true なら赤白の縞
  const c=document.createElement("canvas"); c.width=128; c.height=512; const x=c.getContext("2d"); x.clearRect(0,0,128,512);
  const col=y=>band?((Math.floor(y/64)%2)?"#f4f1ea":"#e4521e"):base; x.lineWidth=5;
  for(let k=0;k<8;k++){ const y0=k*64; x.strokeStyle=col(y0+10); x.beginPath(); x.moveTo(0,y0); x.lineTo(128,y0+64); x.moveTo(128,y0); x.lineTo(0,y0+64); x.stroke(); x.fillStyle=col(y0+10); x.fillRect(0,y0,128,5); x.fillRect(0,y0,6,64); x.fillRect(122,y0,6,64); }
  const t=new THREE.CanvasTexture(c); t.anisotropy=4; t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping; return t; }
function frustum(T,h,w0,w1,y0,tex,rep,mats){   // 4 面の台形（格子テクスチャ）
  const g=new T.Group(); const mat=new T.MeshBasicMaterial({map:tex,transparent:true,alphaTest:0.4,side:T.DoubleSide,fog:true}); if(mats) mats.push(mat);
  for(let f=0;f<4;f++){ const a=f*Math.PI/2; const geo=new T.BufferGeometry(); const c=Math.cos(a), s=Math.sin(a);
    const P=(w,y,u)=>{ const px=w*(c*(u)-s*1), pz=w*(s*(u)+c*1); return [px,y,pz]; };
    // 面は中心から w の位置に、幅 2w の台形
    const bl=[w0*(c*-1-s*1),y0,w0*(s*-1+c*1)], br=[w0*(c*1-s*1),y0,w0*(s*1+c*1)], tl=[w1*(c*-1-s*1),y0+h,w1*(s*-1+c*1)], tr=[w1*(c*1-s*1),y0+h,w1*(s*1+c*1)];
    geo.setAttribute("position",new T.BufferAttribute(new Float32Array([...bl,...br,...tr,...tl]),3)); geo.setAttribute("uv",new T.BufferAttribute(new Float32Array([0,0,1,0,1,rep,0,rep]),2)); geo.setIndex([0,1,2,0,2,3]);
    g.add(new T.Mesh(geo,mat)); }
  return g; }
class Landmarks{
  constructor(THREE,scene,terrain,sky){
    this.T=THREE; this.scene=scene; this.terrain=terrain; this.sky=sky; this.items=[]; this.group=new THREE.Group(); scene.add(this.group); this.glow=[]; this.bmats=[];
    const add=(name,lat,lon,rad,build)=>{ const p=G.ll2xz(lat,lon); this.items.push({name,x:p[0],z:p[1],rad,build,built:false,group:null,h:0}); };
    add("tokyotower",35.65858,139.74544,40000,()=>this.tokyoTower());
    add("skytree",35.71006,139.81070,70000,()=>this.skytree());
    add("rainbow",35.63623,139.76455,35000,()=>this.rainbow());
  }
  // ---- 東京タワー（高さ 333 m。展望台 150 m / 250 m） ----
  tokyoTower(){
    const T=this.T, g=new T.Group(); const tex=lattice("#e4521e",true);
    g.add(frustum(T,150,40,12,0,tex,2.4,this.bmats)); g.add(frustum(T,100,10,3.2,150,tex,1.6,this.bmats));
    const red=new T.MeshStandardMaterial({color:0xe4521e,roughness:0.6}), white=new T.MeshStandardMaterial({color:0xf2efe8,roughness:0.6});
    const box=(w,h,d,y,m)=>{ const b=new T.Mesh(new T.BoxGeometry(w,h,d),m); b.position.y=y; g.add(b); return b; };
    box(30,13,30,150,red); box(26,5,26,157,white); box(12,8,12,246,red); box(8,4,8,252,white);
    for(let i=0;i<5;i++){ const h=83/5; const c=new T.Mesh(new T.CylinderGeometry(1.1-i*0.14,1.3-i*0.14,h,8),i%2?white:red); c.position.y=250+h*(i+0.5); g.add(c); }
    // 足元の 4 本の脚の基部
    for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){ const f=new T.Mesh(new T.BoxGeometry(6,12,6),red); f.position.set(sx*40,6,sz*40); g.add(f); }
    this.light(g,[0,334,0],0xff3a2a,6,"blink"); this.glowPts(g,[[0,150,0],[0,246,0]],0xffb060,10);
    return g; }
  // ---- 東京スカイツリー（634 m。展望台 350 m / 450 m） ----
  skytree(){
    const T=this.T, g=new T.Group(); const prof=[[17,0],[14,60],[11,150],[9,300],[8.2,345],[8.2,380],[8,440],[6.5,480],[5,497],[2.6,500],[2.0,560],[0.9,634]].map(p=>new T.Vector2(p[0],p[1]));
    const m=new T.MeshStandardMaterial({color:0xdfe6ec,roughness:0.35,metalness:0.55,emissive:0x3a6fb0,emissiveIntensity:0}); this.skyMat=m;
    const shaft=new T.Mesh(new T.LatheGeometry(prof,20),m); g.add(shaft);
    const disc=(r,h,y)=>{ const d=new T.Mesh(new T.CylinderGeometry(r,r*0.82,h,24),m); d.position.y=y; g.add(d); };
    disc(20,10,355); disc(18,9,365); disc(14,8,455); disc(12,6,465);
    this.light(g,[0,636,0],0xff3a2a,7,"blink"); this.light(g,[0,497,0],0xff3a2a,5,"blink"); this.glowPts(g,[[0,355,0],[0,365,0],[0,455,0],[0,300,0],[0,200,0],[0,100,0]],0x9cc8ff,16);
    return g; }
  // ---- レインボーブリッジ（芝浦側アンカレイジ ↔ お台場側。吊橋部 約 800 m、主塔 126 m、桁下 52 m） ----
  rainbow(){
    const T=this.T, g=new T.Group(); const A=G.ll2xz(35.63763,139.76017), B=G.ll2xz(35.63477,139.76892); const mid=G.ll2xz(35.63623,139.76455);
    const dx=B[0]-A[0], dz=B[1]-A[1], L=Math.hypot(dx,dz), ux=dx/L, uz=dz/L; const ang=Math.atan2(dz,dx);   // 橋軸
    const rig=new T.Group(); rig.rotation.y=-ang; rig.position.set(0,0,0); g.add(rig);          // ローカル: +x が橋軸
    const wm=new T.MeshStandardMaterial({color:0xe9ebee,roughness:0.55,metalness:0.2}), gm=new T.MeshStandardMaterial({color:0xaeb3ba,roughness:0.6,metalness:0.3});
    const deck=new T.Mesh(new T.BoxGeometry(L,5,31),wm); deck.position.set(0,50,0); rig.add(deck); const under=new T.Mesh(new T.BoxGeometry(L,3,26),gm); under.position.set(0,46,0); rig.add(under);
    const rail=new T.Mesh(new T.BoxGeometry(L,1.2,31),gm); rail.position.set(0,53.1,0); rig.add(rail);
    // 主塔: 中心から ±285 m
    const towers=[-285,285]; const cableMat=new T.LineBasicMaterial({color:0xcfd3d8,fog:true}); const pts=[];
    for(const tx of towers){ for(const sz of [-13.5,13.5]){ const leg=new T.Mesh(new T.CylinderGeometry(1.6,2.4,126-50,8),wm); leg.position.set(tx,50+(126-50)/2,sz); rig.add(leg); }
      for(const yy of [78,100,122]){ const bm=new T.Mesh(new T.BoxGeometry(2.4,2.2,28),wm); bm.position.set(tx,yy,0); rig.add(bm); } }
    // 主ケーブル（左右 2 本、放物線）。塔頂 126 m → 径間中央 約 62 m。側径間はアンカレイジ（端）へ。
    const half=L/2;
    for(const sz of [-13.5,13.5]){ const poly=[]; const segs=40; for(let i=0;i<=segs;i++){ const t=i/segs; const x=-285+570*t; const y=62+ (126-62)*Math.pow((x/285),2); poly.push([x,y,sz]); }
      const line=(arr)=>{ const geo=new T.BufferGeometry().setFromPoints(arr.map(p=>new T.Vector3(p[0],p[1],p[2]))); rig.add(new T.Line(geo,cableMat)); };
      line(poly); line([[-285,126,sz],[-half,52,sz]]); line([[285,126,sz],[half,52,sz]]);
      // ハンガー
      const seg=[]; for(let x=-280;x<=280;x+=14){ const y=62+(126-62)*Math.pow(x/285,2); seg.push(new T.Vector3(x,y,sz),new T.Vector3(x,52,sz)); } rig.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(seg),cableMat)); }
    this.glowPts(rig,[[-285,126,-13.5],[-285,126,13.5],[285,126,-13.5],[285,126,13.5],[-285,100,0],[285,100,0],...Array.from({length:21},(_,i)=>[-half+i*(L/20),53,-15.5]),...Array.from({length:21},(_,i)=>[-half+i*(L/20),53,15.5])],0xfff0d0,9);
    this.light(rig,[-285,128,0],0xff3a2a,5,"blink"); this.light(rig,[285,128,0],0xff3a2a,5,"blink");
    g.userData.center=mid; g.userData.deckY=0; return g; }
  light(g,pos,color,size,kind){
    const tex=this.glowTex(); const m=new this.T.SpriteMaterial({map:tex,color,transparent:true,depthWrite:false,blending:this.T.AdditiveBlending}); const s=new this.T.Sprite(m); s.position.set(...pos); s.scale.setScalar(size*3); s.userData={kind,size}; g.add(s); this.glow.push(s); return s; }
  glowPts(g,list,color,size){
    const tex=this.glowTex(); const geo=new this.T.BufferGeometry(); const a=new Float32Array(list.length*3); list.forEach((p,i)=>{ a[i*3]=p[0]; a[i*3+1]=p[1]; a[i*3+2]=p[2]; }); geo.setAttribute("position",new this.T.BufferAttribute(a,3));
    const m=new this.T.PointsMaterial({map:tex,color,size,sizeAttenuation:true,transparent:true,depthWrite:false,blending:this.T.AdditiveBlending,opacity:0}); const p=new this.T.Points(geo,m); p.frustumCulled=false; g.add(p); this.glow.push(p); p.userData={kind:"night"}; return p; }
  glowTex(){ if(this._gt) return this._gt; const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const gr=x.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,"rgba(255,255,255,1)"); gr.addColorStop(0.3,"rgba(255,255,255,0.45)"); gr.addColorStop(1,"rgba(255,255,255,0)"); x.fillStyle=gr; x.fillRect(0,0,64,64); return this._gt=new this.T.CanvasTexture(c); }
  update(cam,time){
    const night=this.sky.night;
    for(const it of this.items){
      const d=Math.hypot(cam.x-it.x,cam.z-it.z);
      if(!it.built){ if(d>it.rad) continue; if(!this.terrain.ensureDem(it.x,it.z,400)) continue; it.group=it.build(); it.h=this.terrain.heightAt(it.x,it.z); this.group.add(it.group); it.built=true; }
      it.group.visible=d<it.rad*1.15; if(!it.group.visible) continue;
      const isBridge=it.name==="rainbow"; it.group.position.set(isBridge?it.group.userData.center[0]-cam.x:it.x-cam.x, isBridge?0:it.h, isBridge?it.group.userData.center[1]-cam.z:it.z-cam.z);
    }
    // 橋は中心基準で置くので、モデル内の座標を中心基準に
    if(this.skyMat) this.skyMat.emissiveIntensity=night*1.1; const tc=this.sky.tintCol; for(const m of this.bmats) m.color.setRGB(Math.min(1,tc[0]*1.15),Math.min(1,tc[1]*1.15),Math.min(1,tc[2]*1.15));
    for(const s of this.glow){ const k=s.userData.kind; if(k==="blink"){ s.visible=(Math.sin(time*2.4)>-0.2); s.material.opacity=Math.max(0.15,0.55+0.45*night); } else if(k==="night"){ s.material.opacity=Math.max(0,night-0.1)*1.2; } }
  }
}
root.Landmarks=Landmarks;
})(typeof window!=="undefined"?window:globalThis);
