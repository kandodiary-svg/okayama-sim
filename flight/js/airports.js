/* 空港: 滑走路（標識・数字・接地帯）、誘導路、エプロン、ターミナル、ボーディングブリッジ、風向吹き流し、地上の灯火。
   形状は OpenStreetMap（滑走路・誘導路・駐機位置・建物の高さなど）から。滑走路の端は公表されている滑走路の長さ・方位に合わせて手で与えている。
   描画は空港ごとの原点基準（浮動原点）。 */
(function(root){
"use strict";
const G=root.GEO, D2R=Math.PI/180;
// 滑走路・空港名・基準点は data/airports.json の各空港の meta から読む（tools/build_airports2.py が作る）
const DEFAULT_TAXI_W=23;
const MAGVAR=7.5;   // 西偏 [度]
function ring2xz(g){ return g.map(p=>G.ll2xz(p[1],p[0])); }
function pip(x,z,poly){ let c=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const a=poly[i],b=poly[j]; if((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) c=!c; } return c; }
function segDist(px,pz,ax,az,bx,bz){ const dx=bx-ax,dz=bz-az; const L2=dx*dx+dz*dz; let t=L2>0?((px-ax)*dx+(pz-az)*dz)/L2:0; t=t<0?0:t>1?1:t; const qx=ax+t*dx-px, qz=az+t*dz-pz; return Math.sqrt(qx*qx+qz*qz); }

class Airports{
  constructor(THREE, scene, baseUrl, data, terrain, sky, B){
    this.T=THREE; this.scene=scene; this.data=data; this.terrain=terrain; this.sky=sky; this.B=B; this.ap={};
    this.tint=terrain.tint;      // 昼夜の明るさ（地形と共有）
    this.group=new THREE.Group(); scene.add(this.group);
    for(const icao of Object.keys(data)) if(data[icao].meta) this.setupAirport(icao);
  }
  // ---------- 諸元 ----------
  setupAirport(icao){
    const M=this.data[icao].meta; const a=this.ap[icao]={icao,info:{name:M.name,short:M.short||M.name,taxiW:M.taxiW||DEFAULT_TAXI_W,R:M.R||3800},meta:M,runways:[],built:false,group:null,ref:G.ll2xz(M.ref[0],M.ref[1]),ways:[],polys:[],taxi:[],apron:[]};
    for(const r of M.rwys){
      const pa=G.ll2xz(r.A[1],r.A[2]), pb=G.ll2xz(r.B[1],r.B[2]); const dx=pb[0]-pa[0], dz=pb[1]-pa[1], L=Math.hypot(dx,dz);
      const hdg=Math.atan2(dx,-dz), ux=dx/L, uz=dz/L;
      a.runways.push({id:r.id,icao,w:r.w,L,hdg,ux,uz,ax:pa[0],az:pa[1],bx:pb[0],bz:pb[1],names:[r.A[0],r.B[0]],
        ends:[{name:r.A[0],x:pa[0],z:pa[1],hdg:hdg,ux:ux,uz:uz},{name:r.B[0],x:pb[0],z:pb[1],hdg:(hdg+Math.PI)%(2*Math.PI),ux:-ux,uz:-uz}], hA:0,hB:0});
    }
    a.skipPolys=[]; for(const w of (this.data[icao].ways||[])){ if(w.t!=="terminal"&&w.t!=="hangar") continue; const p=ring2xz(w.g); let x0=1e12,x1=-1e12,z0=1e12,z1=-1e12; for(const q of p){ x0=Math.min(x0,q[0]); x1=Math.max(x1,q[0]); z0=Math.min(z0,q[1]); z1=Math.max(z1,q[1]); } a.skipPolys.push({p,x0,x1,z0,z1}); }
  }
  // 標高を確定して地形に平坦化ゾーンを登録（DEM が必要）
  fixElevations(icao){
    const a=this.ap[icao]; if(a.elevFixed) return true;
    for(const r of a.runways){
      const s=(x,z)=>this.terrain.rawAt(x,z);
      const hs=(px,pz,dx,dz)=>{ let t=0; for(let i=0;i<6;i++) t+=s(px+dx*25*i,pz+dz*25*i); return t/6; };
      r.hA=hs(r.ax,r.az,r.ux,r.uz); r.hB=hs(r.bx,r.bz,-r.ux,-r.uz);
      if(!isFinite(r.hA)||!isFinite(r.hB)) return false;
    }
    a.elevFixed=true;
    for(const r of a.runways){
      this.terrain.addFlat({ax:r.ax-r.ux*60,az:r.az-r.uz*60,bx:r.bx+r.ux*60,bz:r.bz+r.uz*60,hw:r.w/2+45,blend:220,ha:r.hA,hb:r.hB});
      r.hAt=(x,z)=>{ const t=Math.max(0,Math.min(1,((x-r.ax)*r.ux+(z-r.az)*r.uz)/r.L)); return r.hA+(r.hB-r.hA)*t; };
    }
    a.fieldElev=a.runways.reduce((s,r)=>s+(r.hA+r.hB)/2,0)/a.runways.length;
    this.terrain.rebuildFlat();
    return true;
  }
  // 建物生成の除外（OSM の空港建物で置き換えるので PLATEAU の同じ場所は作らない）
  skipAt(x,z){ for(const a of Object.values(this.ap)){ const dx=x-a.ref[0], dz=z-a.ref[1]; if(dx*dx+dz*dz>16e6) continue; for(const sp of a.skipPolys){ if(x<sp.x0||x>sp.x1||z<sp.z0||z>sp.z1) continue; if(pip(x,z,sp.p)) return true; } } return false; }
  prepare(cam){
    for(const a of Object.values(this.ap)){
      if(a.built) continue; const d=Math.hypot(cam.x-a.ref[0],cam.z-a.ref[1]); if(d>45000) continue;
      const R=a.info.R; let ok=this.terrain.ensureDem(a.ref[0],a.ref[1],R);
      for(const r of a.runways){ ok=this.terrain.ensureDem(r.ax,r.az,300)&&ok; ok=this.terrain.ensureDem(r.bx,r.bz,300)&&ok; }
      if(ok&&this.fixElevations(a.icao)) this.build(a.icao);
    }
  }
  // ---------- 構築 ----------
  build(icao){
    const a=this.ap[icao]; if(a.built) return; a.built=true; const T=this.T, d=this.data[icao], P=a.ref;
    const grp=a.group=new T.Group(); grp.userData.ref=P; this.group.add(grp);
    const H=(x,z)=>this.terrain.heightAt(x,z);
    const pav={pos:[],col:[],idx:[]}, paint={pos:[],col:[],idx:[]};
    const addTri=(S,a1,a2,a3)=>{ const n=S.pos.length/3; S.pos.push(a1[0]-P[0],a1[1],a1[2]-P[1],a2[0]-P[0],a2[1],a2[2]-P[1],a3[0]-P[0],a3[1],a3[2]-P[1]); S.idx.push(n,n+1,n+2); return n; };
    const quad=(S,c,p0,p1,p2,p3)=>{ const n=S.pos.length/3; for(const p of [p0,p1,p2,p3]){ S.pos.push(p[0]-P[0],p[1],p[2]-P[1]); S.col.push(c[0],c[1],c[2]); } S.idx.push(n,n+2,n+1,n,n+3,n+2); };
    // --- 滑走路 ---
    a.rwMeshes=[];
    for(const r of a.runways){
      const hw=r.w/2, sh=hw+9;           // 舗装本体 + 路肩
      const cA=[r.ax,r.az], right=[-r.uz,r.ux];   // 右（進行方向 A→B の右）
      // 路肩（アスファルト色）
      const yA=r.hA+0.10, yB=r.hB+0.10;
      const corner=(t,s,y)=>[r.ax+r.ux*t+right[0]*s, y, r.az+r.uz*t+right[1]*s];
      quad(pav,[0.30,0.31,0.33], corner(-60,-sh,yA-0.02),corner(-60,sh,yA-0.02),corner(r.L+60,sh,yB-0.02),corner(r.L+60,-sh,yB-0.02));
      // 本体（マーキング付きテクスチャ）
      const tex=this.runwayTexture(r); const geo=new T.BufferGeometry();
      const y0=r.hA+0.13, y1=r.hB+0.13;
      const c=[corner(0,-hw,y0),corner(0,hw,y0),corner(r.L,hw,y1),corner(r.L,-hw,y1)];
      const pos=new Float32Array(12); c.forEach((p,i)=>{ pos[i*3]=p[0]-P[0]; pos[i*3+1]=p[1]; pos[i*3+2]=p[2]-P[1]; });
      geo.setAttribute("position",new T.BufferAttribute(pos,3)); geo.setAttribute("uv",new T.BufferAttribute(new Float32Array([0,1, 0,0, 1,0, 1,1]),2)); geo.setIndex([0,1,2,0,2,3]);
      const mat=new T.MeshBasicMaterial({map:tex,color:this.tint,fog:true}); const m=new T.Mesh(geo,mat); m.frustumCulled=false; grp.add(m); a.rwMeshes.push(m);
    }
    // --- 誘導路 ---
    const tw=a.info.taxiW; const segs=[];     // 誘導路の線分（kindAt 用 & 灯火用）
    for(const w of d.ways){
      if(w.t!=="taxiway"&&w.t!=="taxilane") continue;
      const pts=ring2xz(w.g); if(pts.length<2) continue; const W=parseFloat(w.width)||(w.t==="taxilane"?18:tw);
      const asph=(w.surface==="concrete")?[0.50,0.50,0.50]:[0.31,0.32,0.34];
      this.ribbon(pav,pts,W,asph,0.10,H,P); segs.push({pts,W,t:w.t});
      this.ribbon(paint,pts,0.22,[0.93,0.78,0.14],0.14,H,P,true);
    }
    a.taxi=segs;
    // --- エプロン ---
    for(const w of d.ways){ if(w.t!=="apron") continue; const pts=ring2xz(w.g); if(pts.length<3) continue;
      if(pts[0][0]===pts[pts.length-1][0]&&pts[0][1]===pts[pts.length-1][1]) pts.pop();
      this.poly(pav,pts,[0.55,0.55,0.55],0.08,H,P); a.apron.push(pts); }
    // --- 駐機位置の誘導線 ---
    for(const w of d.ways){ if(w.t!=="parking_position") continue; const pts=ring2xz(w.g); if(pts.length<2) continue; this.ribbon(paint,pts,0.28,[0.95,0.80,0.12],0.145,H,P,true); }
    // --- 停止線（誘導路が滑走路に入る手前） ---
    const holds=d.nodes.filter(n=>n.t==="holding_position"); const hmark=[];
    for(const n of holds){ const p=G.ll2xz(n.p[1],n.p[0]); let best=1e9,bs=null;
      for(const sg of segs){ for(let i=0;i<sg.pts.length-1;i++){ const dd=segDist(p[0],p[1],sg.pts[i][0],sg.pts[i][1],sg.pts[i+1][0],sg.pts[i+1][1]); if(dd<best){ best=dd; bs=[sg,i]; } } }
      if(bs&&best<25){ const sg=bs[0], i=bs[1]; const dx=sg.pts[i+1][0]-sg.pts[i][0], dz=sg.pts[i+1][1]-sg.pts[i][1], L=Math.hypot(dx,dz)||1; const ux=dx/L,uz=dz/L, rx=-uz, rz=ux; const W=sg.W;
        const col=[0.93,0.78,0.14];
        for(let k=0;k<2;k++){ const off=k*0.9; const c0=[p[0]+ux*off,p[1]+uz*off]; const y=H(c0[0],c0[1])+0.15;
          quad(paint,col,[c0[0]-rx*W/2,y,c0[1]-rz*W/2],[c0[0]+rx*W/2,y,c0[1]+rz*W/2],[c0[0]+rx*W/2+ux*0.45,y,c0[1]+rz*W/2+uz*0.45],[c0[0]-rx*W/2+ux*0.45,y,c0[1]-rz*W/2+uz*0.45]); }
        hmark.push([p[0],p[1],ux,uz,W]); }
    }
    a.hold=hmark;
    const mkMesh=(S,order)=>{ const g=new T.BufferGeometry(); g.setAttribute("position",new T.BufferAttribute(new Float32Array(S.pos),3)); g.setAttribute("color",new T.BufferAttribute(new Float32Array(S.col),3)); g.setIndex(new T.BufferAttribute(new Uint32Array(S.idx),1));
      const m=new T.Mesh(g,new T.MeshBasicMaterial({vertexColors:true,color:this.tint,fog:true,side:T.DoubleSide})); m.frustumCulled=false; m.renderOrder=order; grp.add(m); return m; };
    if(pav.pos.length) mkMesh(pav,1); if(paint.pos.length) mkMesh(paint,2);
    // --- 建物（ターミナル・格納庫・OSM 建物） ---
    this.buildings(a,d);
    // --- 灯火 ---
    if(this.L) this.L.build(a);
  }
  ribbon(S,pts,W,col,lift,H,P,thin){
    // 折れ線を幅 W の帯にする（各頂点で内側にミター）
    const n=pts.length; const L=[],R=[];
    for(let i=0;i<n;i++){
      let dx0=0,dz0=0,dx1=0,dz1=0; if(i>0){ dx0=pts[i][0]-pts[i-1][0]; dz0=pts[i][1]-pts[i-1][1]; const l=Math.hypot(dx0,dz0)||1; dx0/=l; dz0/=l; } if(i<n-1){ dx1=pts[i+1][0]-pts[i][0]; dz1=pts[i+1][1]-pts[i][1]; const l=Math.hypot(dx1,dz1)||1; dx1/=l; dz1/=l; }
      if(i===0){ dx0=dx1; dz0=dz1; } if(i===n-1){ dx1=dx0; dz1=dz0; }
      let tx=dx0+dx1, tz=dz0+dz1; let tl=Math.hypot(tx,tz); if(tl<1e-6){ tx=dx1; tz=dz1; tl=1; } tx/=tl; tz/=tl;
      let rx=-tz, rz=tx; const cosh=Math.max(0.5, rx*(-dz1)+rz*dx1); const k=W/2/cosh;     // ミター長（上限）
      L.push([pts[i][0]-rx*k,pts[i][1]-rz*k]); R.push([pts[i][0]+rx*k,pts[i][1]+rz*k]); }
    for(let i=0;i<n-1;i++){ const y0=H(pts[i][0],pts[i][1])+lift, y1=H(pts[i+1][0],pts[i+1][1])+lift;
      const b=S.pos.length/3; const ps=[[L[i],y0],[R[i],y0],[R[i+1],y1],[L[i+1],y1]];
      for(const [p,y] of ps){ S.pos.push(p[0]-P[0],y,p[1]-P[1]); S.col.push(col[0],col[1],col[2]); } S.idx.push(b,b+2,b+1,b,b+3,b+2); }
  }
  poly(S,pts,col,lift,H,P){
    const xs=pts.map(p=>p[0]), zs=pts.map(p=>p[1]); const tri=[]; this.B.ear(xs,zs,pts.length,tri); const b=S.pos.length/3;
    for(const p of pts){ S.pos.push(p[0]-P[0],H(p[0],p[1])+lift,p[1]-P[1]); S.col.push(col[0],col[1],col[2]); }
    // 上向き
    const a=tri[0],bb=tri[1],c=tri[2]; const cy=(zs[bb]-zs[a])*(xs[c]-xs[a])-(xs[bb]-xs[a])*(zs[c]-zs[a]);
    for(let t=0;t<tri.length;t+=3){ if(cy>0) S.idx.push(b+tri[t],b+tri[t+1],b+tri[t+2]); else S.idx.push(b+tri[t],b+tri[t+2],b+tri[t+1]); }
  }
  // ---------- 滑走路テクスチャ ----------
  runwayTexture(r){
    const s=Math.min(2.5, 8192/r.L), W=Math.round(r.L*s), Hh=Math.round(r.w*s); const cv=document.createElement("canvas"); cv.width=W; cv.height=Hh; const x=cv.getContext("2d");
    x.fillStyle="#46484c"; x.fillRect(0,0,W,Hh);
    // 舗装の濃淡（打ち継ぎ・補修・ゴム跡）
    let sd=r.L|0; const rnd=()=>{ sd=(sd*16807)%2147483647; return sd/2147483647; };
    for(let i=0;i<Math.round(r.L/3);i++){ const gx=rnd()*W, gy=rnd()*Hh, gw=(4+rnd()*30)*s, gh=(1+rnd()*5)*s; const v=Math.floor(62+rnd()*20); x.fillStyle="rgba("+v+","+(v+1)+","+(v+4)+",0.18)"; x.fillRect(gx,gy,gw,gh); }
    for(let i=0;i<Math.round(r.L/25);i++){ x.fillStyle="rgba(30,30,32,0.16)"; x.fillRect(Math.floor(rnd()*W),0,1,Hh); }       // 横目地
    const mx=(m,c)=>(m)*s, cy=Hh/2;      // 距離[m] → px
    const W0="#e9e9e4"; x.fillStyle=W0;
    const rectM=(d0,d1,c0,c1)=>{ x.fillRect(d0*s,(c0+r.w/2)*s,(d1-d0)*s,(c1-c0)*s); };   // 距離 d0..d1[m], 横 c0..c1[m]
    const hw=r.w/2, wide=r.w>=45;
    // ゴム跡（接地帯）
    x.fillStyle="rgba(18,18,20,0.30)";
    for(const end of [0,1]){ for(const side of [-1,1]){ for(let k=0;k<3;k++){ const c=side*(3.0+k*1.2+rnd()*0.5); const d0=end===0?250+rnd()*80:r.L-250-rnd()*80-380, d1=d0+380+rnd()*150; rectM(Math.min(d0,d1),Math.max(d0,d1),c-0.35,c+0.35); } } }
    x.fillStyle=W0;
    // 縁線
    rectM(0,r.L,-hw+0.9,-hw+1.8); rectM(0,r.L,hw-1.8,hw-0.9);
    // センターライン（30m 線 + 20m 切れ目）
    for(let d=75; d<r.L-75-30; d+=50) rectM(d,d+30,-0.45,0.45);
    // しきい値バー・番号・接地帯・目標点
    const nthr=r.w>=60?16:(r.w>=45?12:8);
    for(let end=0;end<2;end++){
      const fwd=end===0?1:-1; const D=(d)=>end===0?d:r.L-d;       // しきい値からの距離 → A 起点距離
      const R=(d0,d1,c0,c1)=>{ const a0=D(d0),a1=D(d1); rectM(Math.min(a0,a1),Math.max(a0,a1),c0,c1); };
      // しきい値バー
      const span=r.w-6; const pitch=span/nthr; for(let i=0;i<nthr;i++){ const c=-span/2+pitch*(i+0.5); R(6,36,c-0.9,c+0.9); }
      // 目標点（長さ 400 m、幅 10m の 2 本）
      if(r.L>=2400){ R(400,445,-hw*0.40-10, -hw*0.40); R(400,445, hw*0.40, hw*0.40+10); } else { R(300,345,-hw*0.40-8,-hw*0.40); R(300,345,hw*0.40,hw*0.40+8); }
      // 接地帯標識（150m 間隔 3,2,1 本）
      const tz=[[150,3],[300,2],[500,2],[650,1],[800,1],[950,1]]; for(const [d,nn] of tz){ if(d+25>r.L/2-100) continue; for(const side of [-1,1]) for(let k=0;k<nn;k++){ const c=side*(hw*0.40+2.0+k*2.7); R(d,d+22.5,c-0.9,c+0.9); } }
      // 番号
      const nm=r.ends?null:null; const name=r.names[end]; const digits=name.slice(0,2), ltr=name.length>2?name[2]:"";
      x.save(); const dpos=D(48), fs=Math.round(r.w>=45?11*s*0.98:9*s); x.translate(dpos*s, Hh/2); x.rotate(end===0?Math.PI/2:-Math.PI/2);
      x.font="bold "+Math.round(fs*1.5)+"px 'Arial Narrow','Helvetica Neue',Arial,sans-serif"; x.textAlign="center"; x.textBaseline="bottom"; x.fillStyle=W0;
      x.save(); x.scale(0.85,1); x.fillText(digits,0,ltr?-fs*0.25:fs*0.8); if(ltr){ x.textBaseline="top"; x.fillText(ltr,0,fs*0.0); } x.restore(); x.restore();
    }
    const t=new this.T.CanvasTexture(cv); t.anisotropy=8; t.minFilter=this.T.LinearMipmapLinearFilter; t.magFilter=this.T.LinearFilter; t.wrapS=t.wrapT=this.T.ClampToEdgeWrapping; return t;
  }
  // ---------- 建物 ----------
  buildings(a,d){
    const T=this.T, P=a.ref, B=this.B; const pos=[],nrm=[],col=[],idx=[]; let nv=0;
    const H=(x,z)=>this.terrain.heightAt(x,z);
    const add=(pts,h,color,seed,base)=>{
      let xs=pts.map(p=>p[0]-P[0]), zs=pts.map(p=>p[1]-P[1]); let n=xs.length; if(n>1&&Math.abs(xs[0]-xs[n-1])<1e-3&&Math.abs(zs[0]-zs[n-1])<1e-3){ xs.pop(); zs.pop(); n--; } if(n<3) return;
      let cx=0,cz=0; for(let i=0;i<n;i++){ cx+=xs[i]; cz+=zs[i]; } cx/=n; cz/=n;
      let g=base!=null?base:H(pts[0][0],pts[0][1]); for(const p of pts) g=Math.max(g,H(p[0],p[1])*0+g); const y0=g-1.5, y1=g+h;
      for(let k=0;k<n;k++){ let ax=xs[k],az=zs[k],bx=xs[(k+1)%n],bz=zs[(k+1)%n]; const ex=bx-ax,ez=bz-az,L=Math.hypot(ex,ez); if(L<0.2) continue; let nx=-ez/L,nz=ex/L; if(((ax+bx)/2-cx)*nx+((az+bz)/2-cz)*nz<0){ let t=ax;ax=bx;bx=t; t=az;az=bz;bz=t; nx=-nx; nz=-nz; }
        for(const p of [[ax,y0,az],[bx,y0,bz],[bx,y1,bz],[ax,y1,az]]){ pos.push(p[0],p[1],p[2]); nrm.push(nx,0,nz,1); col.push(color[0],color[1],color[2],seed); } idx.push(nv,nv+1,nv+2,nv,nv+2,nv+3); nv+=4; }
      const tri=[]; B.ear(xs,zs,n,tri); if(tri.length){ const b0=nv; for(let k=0;k<n;k++){ pos.push(xs[k],y1,zs[k]); nrm.push(0,1,0,-1); col.push(0.55,0.56,0.58,0.1); }
        const a0=tri[0],b1=tri[1],c0=tri[2]; const cy=(zs[b1]-zs[a0])*(xs[c0]-xs[a0])-(xs[b1]-xs[a0])*(zs[c0]-zs[a0]);
        for(let t=0;t<tri.length;t+=3){ if(cy>0) idx.push(b0+tri[t],b0+tri[t+1],b0+tri[t+2]); else idx.push(b0+tri[t],b0+tri[t+2],b0+tri[t+1]); } nv+=n; } };
    for(const w of d.ways){
      if(w.t==="terminal"||w.t==="hangar"){ const pts=ring2xz(w.g); const h=parseFloat(w.height)||(w.t==="terminal"?20:14); add(pts,h,w.t==="terminal"?[0.80,0.82,0.85]:[0.74,0.75,0.77],w.t==="terminal"?0.95:0.3); }
    }
    // OSM の建物（岡山空港周辺）
    for(const b of (d.bldg||[])){ const pts=ring2xz(b.g); const h=parseFloat(b.h)||8; add(pts,h,[0.82,0.82,0.80],0.5); }
    // ボーディングブリッジ
    for(const w of d.ways){ if(w.t!=="jet_bridge") continue; const pts=ring2xz(w.g); if(pts.length<2) continue;
      const base=H(pts[0][0],pts[0][1])+4.3;
      for(let i=0;i<pts.length-1;i++){ const ax=pts[i][0],az=pts[i][1],bx=pts[i+1][0],bz=pts[i+1][1]; const dx=bx-ax,dz=bz-az,L=Math.hypot(dx,dz); if(L<1) continue; const ux=dx/L,uz=dz/L,rx=-uz,rz=ux; const hw=1.5;
        const c4=[[ax-rx*hw,az-rz*hw],[ax+rx*hw,az+rz*hw],[bx+rx*hw,bz+rz*hw],[bx-rx*hw,bz-rz*hw]];
        add(c4,2.9,[0.90,0.90,0.88],0.0,base); }
      // 支柱
      const e=pts[pts.length-1]; add([[e[0]-0.5,e[1]-0.5],[e[0]+0.5,e[1]-0.5],[e[0]+0.5,e[1]+0.5],[e[0]-0.5,e[1]+0.5]],4.3,[0.5,0.5,0.52],0.0,H(e[0],e[1])+0.0);
    }
    if(!nv) return;
    const g=new T.BufferGeometry(); g.setAttribute("position",new T.BufferAttribute(new Float32Array(pos),3)); g.setAttribute("nrm",new T.BufferAttribute(new Float32Array(nrm),4)); g.setAttribute("col",new T.BufferAttribute(new Float32Array(col),4));
    g.setIndex(new T.BufferAttribute(new (nv>65535?Uint32Array:Uint16Array)(idx),1));
    const m=new T.Mesh(g,this.B.floatMaterial); m.frustumCulled=false; a.group.add(m); a.bldMesh=m;
  }
  // ---------- 地表の種類 ----------
  kindAt(x,z){
    for(const a of Object.values(this.ap)){
      const dx=x-a.ref[0], dz=z-a.ref[1]; if(dx*dx+dz*dz>9e6) continue;
      for(const r of a.runways){ const t=(x-r.ax)*r.ux+(z-r.az)*r.uz; if(t<-60||t>r.L+60) continue; const c=Math.abs(-(x-r.ax)*r.uz+(z-r.az)*r.ux); if(c<r.w/2+9) return "runway"; }
      if(a.built){ for(const p of a.apron) if(pip(x,z,p)) return "taxi"; for(const sg of a.taxi){ for(let i=0;i<sg.pts.length-1;i++) if(segDist(x,z,sg.pts[i][0],sg.pts[i][1],sg.pts[i+1][0],sg.pts[i+1][1])<sg.W/2) return "taxi"; } }
    }
    return null;
  }
  // 滑走路の検索（最寄り）
  nearestRunway(x,z,icao){ let best=null,bd=1e12; for(const a of Object.values(this.ap)){ if(icao&&a.icao!==icao) continue; for(const r of a.runways){ const mx=(r.ax+r.bx)/2, mz=(r.az+r.bz)/2; const d=Math.hypot(x-mx,z-mz); if(d<bd){ bd=d; best=r; } } } return best; }
  runwayEnd(icao,name){ const a=this.ap[icao]; for(const r of a.runways) for(let i=0;i<2;i++) if(r.ends[i].name===name){ const e=r.ends[i]; return {r,i,e,h:i===0?r.hA:r.hB}; } return null; }
  update(cam,frustum){
    for(const a of Object.values(this.ap)){
      if(!a.group) continue; const d=Math.hypot(cam.x-a.ref[0],cam.z-a.ref[1]);
      a.group.visible=d<60000; if(a.group.visible) a.group.position.set(a.ref[0]-cam.x,0,a.ref[1]-cam.z);
    }
  }
}
Airports.MAGVAR=MAGVAR;
root.Airports=Airports;
})(typeof window!=="undefined"?window:globalThis);
