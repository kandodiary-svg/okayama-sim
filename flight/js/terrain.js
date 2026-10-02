/* 地形: Web メルカトルのタイル四分木。国土地理院の標高(65x65, 0.125 m 単位)と航空写真(256px)を事前に焼いたものを読む。
   カメラ相対描画（浮動原点）: 各タイルのメッシュは「タイル中心」基準のローカル座標で、毎フレーム position = 中心 − カメラ。 */
(function(root){
"use strict";
const G=root.GEO;
class Terrain{
  constructor(THREE, scene, baseUrl, man, opts){
    this.T=THREE; this.scene=scene; this.base=baseUrl; this.N=man.n; this.h0=man.h0; this.hs=man.hs;
    opts=opts||{}; this.lodK=opts.lodK||1.7; this.maxZ=opts.maxZ||14; this.cap=opts.cap||380;
    this.nodes=new Map(); this.roots=[]; this.byZ={};
    for(const zz of Object.keys(man.z)){ const m=this.byZ[zz]=new Map(); for(const [x,y,hd,hp] of man.z[zz]) m.set(x+"_"+y,[hd,hp]); }
    for(const [x,y] of man.z["7"]) this.roots.push(this.node(7,x,y));
    this.group=new THREE.Group(); scene.add(this.group);
    this.tint=new THREE.Color(1,1,1);                       // 昼夜の明るさ
    this.fallbackTex=null;
    this.queue=[]; this.active=0; this.maxActive=opts.maxActive||8; this.frame=0;
    this.flat=[];                                           // 滑走路などの平坦化
    this.drawn=[]; this.stat={tiles:0,loading:0,loaded:0};
    this.loader=new THREE.TextureLoader(); this.loader.crossOrigin="";
    this.mats=new Set(); this.nlK={value:0}; this.lcv=null; this.sky=null; this.lightQ=0;
  }
  // ---------- 夜の街明かり: 航空写真から「建物が多そうな所」を推定して発光テクスチャを作る ----------
  makeLights(n){
    const img=n.tex&&n.tex.image; if(!img||!img.width) return null; const T=this.T;
    if(!this.lcv){ this.lcv=document.createElement("canvas"); this.lcv.width=this.lcv.height=256; this.lctx=this.lcv.getContext("2d",{willReadFrequently:true}); }
    const cx=this.lctx; cx.drawImage(img,0,0,256,256); const px=cx.getImageData(0,0,256,256).data; const M=256; const f=new Float32Array(M*M);
    for(let j=0;j<M;j++) for(let i=0;i<M;i++){ const k=(j*M+i)*4; const r=px[k],g=px[k+1],b=px[k+2]; const mx=Math.max(r,g,b), mn=Math.min(r,g,b); const br=(r+g+b)/765, sat=(mx-mn)/(mx+1), gr=(g-Math.max(r,b))/255; f[j*M+i]=(sat<0.30&&br>0.22&&gr<0.045&&!(b>r+12&&br<0.4))?1:0; }
    // 7x7 平均 → 密度（建物が多そうな所だけ）
    const tmp=new Float32Array(M*M), den=new Float32Array(M*M), R=3;
    for(let j=0;j<M;j++){ let a=0; for(let i=-R;i<=R;i++) a+=f[j*M+Math.min(M-1,Math.max(0,i))]; for(let i=0;i<M;i++){ tmp[j*M+i]=a/(2*R+1); const i1=Math.min(M-1,i+R+1), i0=Math.max(0,i-R); a+=f[j*M+i1]-f[j*M+i0]; } }
    for(let i=0;i<M;i++){ let a=0; for(let j=-R;j<=R;j++) a+=tmp[Math.min(M-1,Math.max(0,j))*M+i]; for(let j=0;j<M;j++){ den[j*M+i]=a/(2*R+1); const j1=Math.min(M-1,j+R+1), j0=Math.max(0,j-R); a+=tmp[j1*M+i]-tmp[j0*M+i]; } }
    const out=new Uint8Array(M*M*4); let any=0; const hs=(a,b)=>{ let h=Math.sin(a*127.1+b*311.7+n.x*17.3+n.y*5.1)*43758.5453; return h-Math.floor(h); };
    for(let j=0;j<M;j++) for(let i=0;i<M;i++){ const u=Math.min(1,Math.max(0,(den[j*M+i]-0.45)/0.4)); const h=hs(i,j), h2=hs(j,i); const e=(u>0&&f[j*M+i]>0)?u*(h>0.78?(0.55+0.45*h2):0.0):0; const k=(j*M+i)*4;
      out[k]=Math.min(255,e*255); out[k+1]=Math.min(255,e*255*(0.80+0.12*h2)); out[k+2]=Math.min(255,e*255*(0.50+0.25*h2)); out[k+3]=255; if(e>0) any=1; }
    if(!any) return null;
    const t=new T.DataTexture(out,M,M,T.RGBAFormat); t.generateMipmaps=true; t.minFilter=T.LinearMipmapLinearFilter; t.magFilter=T.LinearFilter; t.wrapS=t.wrapT=T.ClampToEdgeWrapping; t.flipY=false; t.needsUpdate=true; return t;
  }
  attachLights(n){
    if(!n.mat||!n.tex) return; if(n.lt===undefined){ n.lt=this.makeLights(n); } if(!n.lt||n.ltOn) return; n.ltOn=true; const m=n.mat, self=this;
    m.onBeforeCompile=sh=>{ sh.uniforms.nlMap={value:n.lt}; sh.uniforms.nlK=this.nlK; sh.fragmentShader=sh.fragmentShader.replace("#include <common>","#include <common>\nuniform sampler2D nlMap; uniform float nlK;").replace("#include <map_fragment>","#include <map_fragment>\n diffuseColor.rgb += texture2D(nlMap, vec2(vUv.x,1.0-vUv.y)).rgb*nlK;"); };
    m.customProgramCacheKey=()=>"nl"; m.needsUpdate=true;
  }
  node(zz,x,y){ const key=zz+"/"+x+"/"+y; let n=this.nodes.get(key); if(n) return n;
    const info=this.byZ[zz]&&this.byZ[zz].get(x+"_"+y); if(!info) return null;
    const size=G.tileSize(zz), o=G.tileOrigin(zz,x,y);
    n={z:zz,x,y,key,size,x0:o[0],z0:o[1],cx:o[0]+size/2,cz:o[1]+size/2,hd:info[0],hp:info[1],kids:null,dem:null,demState:info[0]?0:2,tex:null,texState:info[1]?0:2,
       mesh:null,minH:-50,maxH:3800,lastUsed:0,want:0,mat:null};
    if(!info[0]){ n.minH=-5; n.maxH=5; }
    this.nodes.set(key,n); return n; }
  kids(n){ if(n.kids) return n.kids; const k=[]; if(n.z<this.maxZ){ for(let j=0;j<2;j++) for(let i=0;i<2;i++){ const c=this.node(n.z+1,n.x*2+i,n.y*2+j); if(c) k.push(c); } } n.kids=k; return k; }
  ready(n){ return n.demState===2 && n.texState===2; }
  // ---------- 読み込み ----------
  request(n,pri){ n.want=this.frame; if(n.demState===0||n.texState===0){ n.pri=pri; if(!n.queued){ n.queued=true; this.queue.push(n); } } }
  pump(){
    if(!this.queue.length) return;
    this.queue=this.queue.filter(n=>n.queued&&(n.demState===0||n.texState===0));
    this.queue.sort((a,b)=>a.pri-b.pri);
    while(this.active<this.maxActive && this.queue.length){
      const n=this.queue[0];
      if(n.demState===0){ n.demState=1; this.active++; this.loadDem(n); continue; }
      if(n.texState===0){ n.texState=1; this.active++; this.loadTex(n); continue; }
      this.queue.shift(); n.queued=false;
    }
  }
  loadDem(n){
    fetch(this.base+"dem/"+n.z+"/"+n.x+"_"+n.y+".bin").then(r=>{ if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(b=>{
      n.dem=new Uint16Array(b); let mn=1e9,mx=-1e9; for(let i=0;i<n.dem.length;i++){ const v=n.dem[i]/this.hs+this.h0; if(v<mn) mn=v; if(v>mx) mx=v; } n.minH=mn; n.maxH=mx; n.demState=2; this.active--; this.stat.loaded++; this.dirty=true;
    }).catch(()=>{ n.dem=null; n.demState=2; n.minH=-5; n.maxH=5; this.active--; });
  }
  loadTex(n){
    this.loader.load(this.base+"pho/"+n.z+"/"+n.x+"_"+n.y+".jpg",t=>{
      t.anisotropy=4; t.generateMipmaps=true; t.minFilter=this.T.LinearMipmapLinearFilter; t.magFilter=this.T.LinearFilter; t.wrapS=t.wrapT=this.T.ClampToEdgeWrapping;
      n.tex=t; n.texState=2; this.active--; if(n.mat){ n.mat.map=t; n.mat.needsUpdate=true; }
    },undefined,()=>{ n.texState=2; this.active--; });
  }
  // ---------- 高さ ----------
  sampleNode(n,x,z){ const d=n.dem; if(!d) return 0; const N=this.N, u=(x-n.x0)/n.size*(N-1), v=(z-n.z0)/n.size*(N-1);
    let i=Math.floor(u), j=Math.floor(v); if(i<0) i=0; else if(i>N-2) i=N-2; if(j<0) j=0; else if(j>N-2) j=N-2; let fu=u-i, fv=v-j; if(fu<0) fu=0; else if(fu>1) fu=1; if(fv<0) fv=0; else if(fv>1) fv=1;
    const k=j*N+i, a=d[k],b=d[k+1],c=d[k+N],e=d[k+N+1];
    return ((a*(1-fu)+b*fu)*(1-fv)+(c*(1-fu)+e*fu)*fv)/this.hs+this.h0; }
  rawAt(x,z){
    for(let zz=this.maxZ; zz>=7; zz--){ const t=G.xz2tile(zz,x,z); const n=this.nodes.get(zz+"/"+t[0]+"/"+t[1]); if(n&&n.dem) return this.sampleNode(n,x,z); }
    return 0; }
  addFlat(f){ // f: {ax,az,bx,bz,hw,blend,ha,hb}
    f.dx=f.bx-f.ax; f.dz=f.bz-f.az; f.len2=f.dx*f.dx+f.dz*f.dz; this.flat.push(f); }
  flatten(x,z,h){
    for(const f of this.flat){
      let t=((x-f.ax)*f.dx+(z-f.az)*f.dz)/f.len2; t=t<0?0:(t>1?1:t);
      const px=f.ax+t*f.dx-x, pz=f.az+t*f.dz-z, d=Math.sqrt(px*px+pz*pz); if(d>f.hw+f.blend) continue;
      const hf=f.ha+(f.hb-f.ha)*t; let w=d<=f.hw?1:1-(d-f.hw)/f.blend; w=w*w*(3-2*w); h=h*(1-w)+hf*w; }
    return h; }
  heightAt(x,z){ return this.flatten(x,z,this.rawAt(x,z)); }
  // ---------- メッシュ ----------
  build(n){
    const T=this.T, N=this.N, step=(n.z>=13?1:2), M=((N-1)/step)+1;       // 低ズームは 33x33
    const nv=M*M+4*M, pos=new Float32Array(nv*3), uv=new Float32Array(nv*2); const idx=new (nv>65535?Uint32Array:Uint16Array)((M-1)*(M-1)*6+4*(M-1)*6);
    const sk=Math.max(25,n.size*0.012); let p=0;
    const hh=new Float32Array(M*M);
    for(let j=0;j<M;j++) for(let i=0;i<M;i++){
      const x=n.x0+i/(M-1)*n.size, z=n.z0+j/(M-1)*n.size;
      let h=n.dem? n.dem[j*step*N+i*step]/this.hs+this.h0 : 0; if(this.flat.length) h=this.flatten(x,z,h); hh[j*M+i]=h;
      pos[p*3]=x-n.cx; pos[p*3+1]=h; pos[p*3+2]=z-n.cz; uv[p*2]=i/(M-1); uv[p*2+1]=1-j/(M-1); p++; }
    let q=0; for(let j=0;j<M-1;j++) for(let i=0;i<M-1;i++){ const a=j*M+i,b=a+1,c=a+M,d=c+1; idx[q++]=a; idx[q++]=c; idx[q++]=b; idx[q++]=b; idx[q++]=c; idx[q++]=d; }
    // スカート（隣接 LOD とのすき間隠し）
    const edge=[]; for(let i=0;i<M;i++) edge.push(i); for(let j=1;j<M;j++) edge.push(j*M+M-1); for(let i=M-2;i>=0;i--) edge.push((M-1)*M+i); for(let j=M-2;j>=1;j--) edge.push(j*M);
    const ne=edge.length, base=p;
    for(let e=0;e<ne;e++){ const s=edge[e]; pos[p*3]=pos[s*3]; pos[p*3+1]=pos[s*3+1]-sk; pos[p*3+2]=pos[s*3+2]; uv[p*2]=uv[s*2]; uv[p*2+1]=uv[s*2+1]; p++; }
    for(let e=0;e<ne;e++){ const e2=(e+1)%ne, a=edge[e], b=edge[e2], c=base+e, d=base+e2; idx[q++]=a; idx[q++]=b; idx[q++]=c; idx[q++]=b; idx[q++]=d; idx[q++]=c; }
    const g=new T.BufferGeometry(); g.setAttribute("position",new T.BufferAttribute(pos.subarray(0,p*3),3)); g.setAttribute("uv",new T.BufferAttribute(uv.subarray(0,p*2),2)); g.setIndex(new T.BufferAttribute(idx.subarray(0,q),1));
    g.boundingSphere=new T.Sphere(new T.Vector3(0,(n.minH+n.maxH)/2,0), Math.hypot(n.size*0.71,(n.maxH-n.minH)/2+sk)+10);
    const mat=new T.MeshBasicMaterial({map:n.tex||null,side:T.FrontSide,fog:true}); mat.color=n.tex?this.tint:new T.Color((n.maxH>2||n.hd&&n.maxH>1)?0x6d7a5a:0x0e2a40).multiply(this.tint); n.mat=mat; this.mats.add(mat);
    const m=new T.Mesh(g,mat); m.frustumCulled=false; m.matrixAutoUpdate=true; m.visible=false; n.mesh=m; n.hh=hh; this.group.add(m); }
  ensureDem(x,z,r){ let ready=true; const zz=this.maxZ; const t0=G.xz2tile(zz,x-r,z-r), t1=G.xz2tile(zz,x+r,z+r);
    for(let ty=t0[1];ty<=t1[1];ty++) for(let tx=t0[0];tx<=t1[0];tx++){ const n=this.node(zz,tx,ty); if(!n) continue; n.lastUsed=this.frame; if(n.demState!==2){ ready=false; this.request(n,-1e9); } } return ready; }
  rebuildFlat(){ // 平坦化を追加したので既存タイルを作り直す
    for(const n of this.nodes.values()) if(n.mesh){ this.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh=null; } }
  free(n){ if(n.mesh){ this.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh=null; }
    if(n.mat){ this.mats.delete(n.mat); n.mat.dispose(); n.mat=null; } if(n.tex){ n.tex.dispose(); n.tex=null; }
    if(n.lt&&n.lt.dispose) n.lt.dispose(); n.lt=undefined; n.ltOn=false; n.dem=null; n.demState=n.hd?0:2; n.texState=n.hp?0:2; n.queued=false; if(!n.hd){ n.minH=-5; n.maxH=5; } }
  // ---------- 毎フレーム ----------
  update(cam, frustum, fbase){
    this.frame++; const draw=[]; const self=this;
    const cx=cam.x, cy=cam.y, cz=cam.z; const sph=new this.T.Sphere();
    function inView(n){ sph.center.set(n.cx-cx,(n.minH+n.maxH)/2,n.cz-cz); sph.radius=Math.hypot(n.size*0.72,(n.maxH-n.minH)/2)+30; return frustum.intersectsSphere(sph); }
    function dist(n){ const h=n.size/2; const dx=Math.max(Math.abs(cx-n.cx)-h,0), dz=Math.max(Math.abs(cz-n.cz)-h,0); const dy=cy<n.minH?n.minH-cy:(cy>n.maxH?cy-n.maxH:0); return Math.sqrt(dx*dx+dz*dz+dy*dy); }
    function visit(n){
      if(!inView(n)) return;
      const d=dist(n); n.lastUsed=self.frame;
      if(n.z<self.maxZ && d<n.size*self.lodK){
        const ks=self.kids(n);
        if(ks.length){
          let ok=true; for(const k of ks){ if(!self.ready(k)){ ok=false; self.request(k,d); } }
          if(ok){ for(const k of ks) visit(k); if(ks.length<4) draw.push([n,true]); return; }
        }
      }
      if(!self.ready(n)){ self.request(n,d-1e5+n.z); /* 親が未読込でも読み込みつつ、さらに上位があればそれを描く */ }
      draw.push([n,false]);
    }
    for(const r of this.roots) visit(r);
    // 描画
    for(const n of this.drawn) if(n.mesh) n.mesh.visible=false;
    this.drawn=[]; let cnt=0;
    for(const [n,back] of draw){
      if(n.demState!==2) continue;
      if(!n.mesh) this.build(n);
      if(n.mat && n.tex && n.mat.map!==n.tex){ n.mat.map=n.tex; n.mat.color=this.tint; n.mat.needsUpdate=true; }
      if(this.nlK.value>0.02&&n.tex&&!n.ltOn&&n.lt!==null&&this.lightQ<3){ this.lightQ++; this.attachLights(n); }
      const m=n.mesh; m.visible=true; m.position.set(n.cx-cx, back?-Math.max(4,n.size*0.004):0, n.cz-cz); this.drawn.push(n); cnt++; }
    this.lightQ=0;
    this.stat.tiles=cnt; this.stat.loading=this.active+this.queue.length;
    this.pump();
    // 古いものを破棄
    if(this.frame%120===0 && this.nodes.size>0){ let loaded=0; const L=[]; for(const n of this.nodes.values()) if(n.dem||n.tex){ loaded++; L.push(n); }
      if(loaded>this.cap){ L.sort((a,b)=>a.lastUsed-b.lastUsed); for(let i=0;i<loaded-this.cap*0.85;i++){ const n=L[i]; if(this.frame-n.lastUsed>240) this.free(n); } } }
  }
  // 現在のカメラまわりの必要タイルがそろっているか（読み込み画面用）
  settled(){ return this.queue.length===0 && this.active===0; }
}
root.Terrain=Terrain;
})(typeof window!=="undefined"?window:globalThis);
