/* 建物: PLATEAU（国土交通省 3D都市モデル 東京23区）の建物外形と高さを 1 km 区画に焼いたデータから、押し出しメッシュを作る。
   近く(〜4.2km)は全建物、遠く(〜11.5km)は高層・大型のみ。壁の窓は距離でフェードするシェーダーで描く（夜は点灯）。 */
(function(root){
"use strict";
const G=root.GEO;
const VS="#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec4 pq; attribute vec4 nrm; attribute vec4 col;\nvarying vec3 vL; varying vec3 vN; varying vec4 vC; varying float vK; varying float vD;\n"+
 "void main(){ vec3 lp=pq.xyz*0.05; vL=lp; vN=nrm.xyz; vK=nrm.w; vC=col; vec4 mv=modelViewMatrix*vec4(lp,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv;\n#include <logdepthbuf_vertex>\n}";
const VS2="#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec4 nrm; attribute vec4 col;\nvarying vec3 vL; varying vec3 vN; varying vec4 vC; varying float vK; varying float vD;\n"+
 "void main(){ vL=position; vN=nrm.xyz; vK=nrm.w; vC=col; vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv;\n#include <logdepthbuf_vertex>\n}";
const FS="#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform vec3 sunDir,sunCol,ambSky,ambGnd,fogCol; uniform float fogDen,night;\nvarying vec3 vL; varying vec3 vN; varying vec4 vC; varying float vK; varying float vD;\n"+
 "float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }\n"+
 "void main(){\n#include <logdepthbuf_fragment>\n"+
 "vec3 n=normalize(vN); float wall=step(0.0,vK); vec3 base=vC.rgb; float seed=vC.a;\n"+
 "vec3 emis=vec3(0.0);\n"+
 "if(wall>0.5){ float u=dot(vL.xz,vec2(n.z,-n.x)); float v=vL.y; vec2 cell=vec2(u/3.1,v/3.4); vec2 f=fract(cell); vec2 id=floor(cell);\n"+
 "  float win=step(0.16,f.x)*step(f.x,0.84)*step(0.24,f.y)*step(f.y,0.80); float con=1.0-smoothstep(500.0,2600.0,vD); float hasWin=step(0.12,seed);\n"+
 "  win*=hasWin; vec3 glass=vec3(0.34,0.38,0.43)*(0.75+0.5*h21(id+seed*17.0)); base=mix(base,glass,0.55*win*con);\n"+
 "  float lit=step(0.52,h21(id*1.7+vec2(seed*91.0,seed*13.0)))*win; emis=vec3(1.0,0.82,0.52)*lit*night*(0.9+0.4*h21(id)); base*=1.0-0.12*(1.0-win)*con*step(f.y,0.12);\n"+
 "} else { base*=0.86; }\n"+
 "float diff=max(dot(n,sunDir),0.0); vec3 amb=mix(ambGnd,ambSky,n.y*0.5+0.5);\n"+
 "vec3 c=base*(sunCol*diff*0.95+amb*1.15)+emis;\n"+
 "float f2=1.0-exp(-fogDen*fogDen*vD*vD); c=mix(c,fogCol,clamp(f2,0.0,1.0)); gl_FragColor=vec4(c,1.0);\n}";

function ear(xs,zs,n,out){            // 単純多角形の耳切り。out に頂点インデックス(3つ組)を追加
  if(n<3) return;
  if(n===3){ out.push(0,1,2); return; }
  let area=0; for(let i=0;i<n;i++){ const j=(i+1)%n; area+=xs[i]*zs[j]-xs[j]*zs[i]; }
  const idx=[]; if(area>0) for(let i=0;i<n;i++) idx.push(i); else for(let i=n-1;i>=0;i--) idx.push(i);
  let guard=0;
  while(idx.length>3 && guard++<n*n+8){
    let found=false; const m=idx.length;
    for(let k=0;k<m;k++){
      const a=idx[(k+m-1)%m], b=idx[k], c=idx[(k+1)%m];
      const cr=(xs[b]-xs[a])*(zs[c]-zs[a])-(zs[b]-zs[a])*(xs[c]-xs[a]); if(cr<=1e-9) continue;     // 凹の頂点
      let inside=false;
      for(let t=0;t<m;t++){ const p=idx[t]; if(p===a||p===b||p===c) continue;
        const d1=(xs[b]-xs[a])*(zs[p]-zs[a])-(zs[b]-zs[a])*(xs[p]-xs[a]), d2=(xs[c]-xs[b])*(zs[p]-zs[b])-(zs[c]-zs[b])*(xs[p]-xs[b]), d3=(xs[a]-xs[c])*(zs[p]-zs[c])-(zs[a]-zs[c])*(xs[p]-xs[c]);
        if(d1>=0&&d2>=0&&d3>=0){ inside=true; break; } }
      if(inside) continue;
      out.push(a,b,c); idx.splice(k,1); found=true; break;
    }
    if(!found){ break; }
  }
  if(idx.length===3) out.push(idx[0],idx[1],idx[2]);
  else { for(let i=1;i<idx.length-1;i++) out.push(idx[0],idx[i],idx[i+1]); }
}
const PAL_WALL=[[0.86,0.85,0.82],[0.80,0.78,0.74],[0.88,0.86,0.80],[0.74,0.76,0.78],[0.90,0.90,0.90],[0.70,0.68,0.64],[0.82,0.80,0.84],[0.78,0.82,0.84]];
const PAL_ROOF=[[0.42,0.44,0.47],[0.50,0.40,0.34],[0.55,0.56,0.58],[0.33,0.38,0.45],[0.62,0.60,0.55],[0.30,0.32,0.34],[0.45,0.30,0.26]];
function rnd(i){ let h=(i*374761393)|0; h=(h^(h>>>13))*1274126177|0; h^=h>>>16; return (h>>>0)/4294967295; }

class Buildings{
  constructor(THREE, scene, baseUrl, index, sky, opts){
    this.T=THREE; this.scene=scene; this.base=baseUrl; this.cs=index.cs; this.cells=index.cells; opts=opts||{};
    this.rDetail=opts.rDetail||4200; this.rFar=opts.rFar||11500; this.frame=0;
    this.chunks=new Map(); this.queue=[]; this.active=0; this.buildQ=[];
    this.group=new THREE.Group(); scene.add(this.group);
    this.mat=new THREE.ShaderMaterial({ vertexShader:VS, fragmentShader:FS, uniforms:{ sunDir:sky.light.sunDir, sunCol:sky.light.sunCol, ambSky:sky.light.ambSky, ambGnd:sky.light.ambGnd, fogCol:sky.light.fogCol, fogDen:sky.light.fogDen, night:sky.light.night }, side:THREE.FrontSide });
    this.floatMaterial=new THREE.ShaderMaterial({ vertexShader:VS2, fragmentShader:FS, uniforms:this.mat.uniforms, side:THREE.FrontSide });
    this.ear=ear;
    this.skip=opts.skip||null;     // (x,z)→true なら建物を作らない（空港敷地など）
    this.stat={chunks:0,meshes:0,bld:0};
  }
  key(cx,cz){ return cx+"_"+cz; }
  // ---------- 読み込み ----------
  async inflate(buf){
    if(typeof DecompressionStream!=="undefined"){ const ds=new DecompressionStream("deflate"); const r=new Response(new Blob([buf]).stream().pipeThrough(ds)); return await r.arrayBuffer(); }
    throw new Error("DecompressionStream 非対応");
  }
  load(c){
    c.state=1; this.active++;
    fetch(this.base+"bld/"+c.key+".z").then(r=>{ if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(b=>this.inflate(b)).then(raw=>{
      this.parse(c,raw); c.state=2; this.active--; }).catch(e=>{ c.state=3; this.active--; });
  }
  parse(c,raw){
    const dv=new DataView(raw); const nb=dv.getUint32(0,true); let off=4;
    const cnt=new Uint8Array(raw,off,nb); off+=nb;
    const h=new Uint16Array(raw.slice(off,off+2*nb)); off+=2*nb;
    const g=new Int16Array(raw.slice(off,off+2*nb)); off+=2*nb;
    const first=new Int16Array(raw.slice(off,off+4*nb)); off+=4*nb;
    const de=new Int16Array(raw.slice(off));
    c.nb=nb; c.cnt=cnt; c.h=h; c.g=g; c.first=first; c.de=de;
    // 点列の開始位置（deltas は (n-1)*2 個）
    const ds=new Uint32Array(nb); let p=0; for(let i=0;i<nb;i++){ ds[i]=p; p+=(cnt[i]-1)*2; } c.ds=ds;
    // 概算面積（スカイライン抽出用）
    const big=new Uint8Array(nb); let nbig=0;
    for(let i=0;i<nb;i++){ const n=cnt[i]; let x=first[i*2], z=first[i*2+1], a=0, minx=x,maxx=x,minz=z,maxz=z; const xs=[x],zs=[z]; let q=ds[i];
      for(let k=1;k<n;k++){ x+=de[q++]; z+=de[q++]; xs.push(x); zs.push(z); if(x<minx)minx=x; if(x>maxx)maxx=x; if(z<minz)minz=z; if(z>maxz)maxz=z; }
      for(let k=0;k<n;k++){ const j=(k+1)%n; a+=xs[k]*zs[j]-xs[j]*zs[k]; } a=Math.abs(a)/2/100;   // m²
      const hh=h[i]/10; if(hh>=21||a>=520||(hh>=14&&a>=220)){ big[i]=1; nbig++; } }
    c.big=big; c.nbig=nbig;
  }
  // ---------- メッシュ生成 ----------
  makeMesh(c,mode){   // mode 0: 近景（全建物） / 1: 遠景（大型のみ）  → Group を返す（複数メッシュ）
    const T=this.T, grp=new T.Group(); const nb=c.nb; const ox=c.x0, oz=c.z0;
    let pq=[],nr=[],cl=[],ix=[]; let nv=0; let cnt=0; const meshes=[];
    const flush=()=>{ if(!nv) return; const g=new T.BufferGeometry();
      g.setAttribute("pq",new T.BufferAttribute(new Int16Array(pq),4)); g.setAttribute("nrm",new T.BufferAttribute(new Int8Array(nr),4,true)); g.setAttribute("col",new T.BufferAttribute(new Uint8Array(cl),4,true));
      g.setIndex(new T.BufferAttribute(new Uint16Array(ix),1)); g.boundingSphere=new T.Sphere(new T.Vector3(500,100,500),900);
      const m=new T.Mesh(g,this.mat); m.frustumCulled=false; grp.add(m); meshes.push(m); pq=[];nr=[];cl=[];ix=[]; nv=0; };
    const xs=[],zs=[];
    for(let i=0;i<nb;i++){
      if(mode===1&&!c.big[i]) continue;
      const n=c.cnt[i]; if(n<3) continue;
      xs.length=0; zs.length=0; let x=c.first[i*2], z=c.first[i*2+1]; xs.push(x/10); zs.push(z/10); let q=c.ds[i];
      for(let k=1;k<n;k++){ x+=c.de[q++]; z+=c.de[q++]; xs.push(x/10); zs.push(z/10); }
      if(this.skip){ let mx=0,mz=0; for(let k=0;k<n;k++){ mx+=xs[k]; mz+=zs[k]; } if(this.skip(ox+mx/n,oz+mz/n)) continue; }
      const hh=c.h[i]/10, gg=c.g[i]/10, y0=gg-3.0, y1=gg+hh; let cx=0,cz=0; for(let k=0;k<n;k++){ cx+=xs[k]; cz+=zs[k]; } cx/=n; cz/=n;
      const gi=c.ci*100003+i; const r0=rnd(gi), r1=rnd(gi+7), r2=rnd(gi+13);
      let wc=PAL_WALL[Math.floor(r0*PAL_WALL.length)].slice(); const rc=PAL_ROOF[Math.floor(r1*PAL_ROOF.length)];
      if(hh>30){ wc=[0.70+0.1*r0,0.76+0.1*r1,0.82+0.1*r2]; } else if(hh>18){ wc=[0.78,0.79,0.80]; }
      const seed=hh<4?0.05:(0.2+0.8*r2);
      if(nv+n*5>64000) flush();
      // 壁
      for(let k=0;k<n;k++){
        let ax=xs[k],az=zs[k],bx=xs[(k+1)%n],bz=zs[(k+1)%n]; const ex=bx-ax, ez=bz-az; const L=Math.hypot(ex,ez); if(L<0.2) continue;
        // 外向き法線 (-ez,0,ex)/L が重心から離れる向きになるよう向きを揃える
        let nx=-ez/L, nz=ex/L; if(((ax+bx)/2-cx)*nx+((az+bz)/2-cz)*nz<0){ let t=ax; ax=bx; bx=t; t=az; az=bz; bz=t; nx=-nx; nz=-nz; }
        const nxq=Math.round(nx*127), nzq=Math.round(nz*127);
        const P=[[ax,y0,az],[bx,y0,bz],[bx,y1,bz],[ax,y1,az]];
        for(const p of P){ pq.push(Math.round(p[0]*20),Math.round(p[1]*20),Math.round(p[2]*20),0); nr.push(nxq,0,nzq,127); cl.push(Math.round(wc[0]*255),Math.round(wc[1]*255),Math.round(wc[2]*255),Math.round(seed*255)); }
        ix.push(nv,nv+1,nv+2,nv,nv+2,nv+3); nv+=4;
      }
      // 屋根
      const tri=[]; ear(xs,zs,n,tri);
      if(tri.length){ const base0=nv; for(let k=0;k<n;k++){ pq.push(Math.round(xs[k]*20),Math.round(y1*20),Math.round(zs[k]*20),0); nr.push(0,127,0,-127); cl.push(Math.round(rc[0]*255),Math.round(rc[1]*255),Math.round(rc[2]*255),30); }
        // 上向きに向きを揃える
        const a=tri[0],b=tri[1],c2=tri[2]; const cy=(zs[b]-zs[a])*(xs[c2]-xs[a])-(xs[b]-xs[a])*(zs[c2]-zs[a]);
        for(let t=0;t<tri.length;t+=3){ if(cy>0) ix.push(base0+tri[t],base0+tri[t+1],base0+tri[t+2]); else ix.push(base0+tri[t],base0+tri[t+2],base0+tri[t+1]); }
        nv+=n; }
      cnt++;
    }
    flush();
    for(const m of meshes){ m.position.set(0,0,0); }
    grp.userData.count=cnt; return grp;
  }
  // ---------- 毎フレーム ----------
  update(cam, frustum){
    this.frame++; const cs=this.cs, R=this.rFar;
    const ci0=Math.floor((cam.x-R)/cs), ci1=Math.floor((cam.x+R)/cs), cj0=Math.floor((cam.z-R)/cs), cj1=Math.floor((cam.z+R)/cs);
    const want=[];
    for(let i=ci0;i<=ci1;i++) for(let j=cj0;j<=cj1;j++){
      const k=this.key(i,j); if(!this.cells[k]) continue;
      const cx=(i+0.5)*cs, cz=(j+0.5)*cs; const d=Math.hypot(cx-cam.x,cz-cam.z); if(d>R+cs*0.72) continue;
      let c=this.chunks.get(k); if(!c){ c={key:k,ci:(i*7919+j*104729)&0xffff,x0:i*cs,z0:j*cs,state:0,detail:null,far:null,d:d}; this.chunks.set(k,c); }
      c.d=d; c.lastUsed=this.frame; want.push(c); }
    want.sort((a,b)=>a.d-b.d);
    for(const c of want){ if(c.state===0 && this.active<5) this.load(c); }
    // メッシュ生成は 1 フレーム 1 つ
    let built=0; const sph=new this.T.Sphere();
    for(const c of want){
      if(c.state!==2) continue;
      const wantDetail=c.d<this.rDetail, wantFar=c.d<this.rFar&&!wantDetail;
      if(wantDetail && !c.detail && built<1){ c.detail=this.makeMesh(c,0); this.group.add(c.detail); built++; }
      else if(!c.far && (wantFar||(wantDetail&&!c.detail)) && c.nbig>0 && built<1){ c.far=this.makeMesh(c,1); this.group.add(c.far); built++; }
    }
    let nm=0,nbld=0,nch=0;
    for(const c of this.chunks.values()){
      const inR=c.lastUsed===this.frame;
      for(const key of ["detail","far"]){ const grp=c[key]; if(!grp) continue;
        let vis=inR && ((key==="detail"&&c.d<this.rDetail+300)||(key==="far"&&c.d<this.rFar&&!(c.detail&&c.d<this.rDetail)));
        if(vis){ sph.center.set(c.x0+this.cs/2-cam.x,100,c.z0+this.cs/2-cam.z); sph.radius=this.cs*0.75+150; vis=frustum.intersectsSphere(sph); }
        grp.visible=vis; if(vis){ for(const m of grp.children) m.position.set(c.x0-cam.x,0,c.z0-cam.z); nm+=grp.children.length; nbld+=grp.userData.count; } }
      if(inR) nch++;
      // 遠くなったら破棄
      if(!inR && this.frame-c.lastUsed>300 && (c.detail||c.far||c.state===2)){ for(const key of ["detail","far"]){ const grp=c[key]; if(grp){ for(const m of grp.children) m.geometry.dispose(); this.group.remove(grp); c[key]=null; } }
        if(this.frame-c.lastUsed>1200){ this.chunks.delete(c.key); } }
      else if(inR && c.detail && c.d>this.rDetail+1200){ for(const m of c.detail.children) m.geometry.dispose(); this.group.remove(c.detail); c.detail=null; }
    }
    this.stat.chunks=nch; this.stat.meshes=nm; this.stat.bld=nbld;
  }
}
root.Buildings=Buildings;
})(typeof window!=="undefined"?window:globalThis);
