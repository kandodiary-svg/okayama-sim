/* 空港の灯火: 滑走路灯（縁灯・しきい値灯・末端灯・中心線灯）、進入灯（シーケンシャルフラッシュ）、誘導路灯、停止線灯、PAPI。
   点光源をシェーダーで描く（大きさは距離に応じて、向きのある灯は後ろから見ると消える）。夜は明るく昼は弱く。 */
(function(root){
"use strict";
const G=root.GEO, D2R=Math.PI/180;
const VS="#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec3 col; attribute float size; attribute vec4 ex;\nuniform float pxScale,night,time,dayK; uniform vec3 camLocal; uniform float maxD;\nvarying vec3 vCol; varying float vI;\n"+
 "void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); float depth=max(1.0,-mv.z); float I=1.0;\n"+
 "  // 向き\n  if(abs(ex.x)+abs(ex.y)>0.0){ vec3 v=normalize(camLocal-position); float a=dot(vec2(v.x,v.z),normalize(vec2(ex.x,ex.y)))/max(0.001,length(v.xz)); I*=smoothstep(-0.15,0.35,a); }\n"+
 "  // シーケンシャルフラッシュ\n  if(ex.z>=0.0){ float ph=fract(time*2.0-ex.z); float f=exp(-ph*14.0); I*=0.18+1.3*f; }\n"+
 "  I*=mix(ex.w*dayK,1.0,night); I*=1.0-smoothstep(maxD*0.7,maxD,depth);\n"+
 "  vI=I; vCol=col; gl_PointSize=clamp(size*1.8*pxScale/depth+1.6,1.0,34.0); if(I<0.02) gl_PointSize=0.0;\n"+
 "  gl_Position=projectionMatrix*mv;\n#include <logdepthbuf_vertex>\n}";
const FS="#include <common>\n#include <logdepthbuf_pars_fragment>\nvarying vec3 vCol; varying float vI;\nvoid main(){\n#include <logdepthbuf_fragment>\n"+
 "vec2 p=gl_PointCoord-0.5; float d=length(p)*2.0; float a=smoothstep(1.0,0.0,d); a=a*a; float core=smoothstep(0.35,0.0,d); vec3 c=vCol*vI*(a*1.4+core*1.2); gl_FragColor=vec4(c,1.0); }";

class AirLights{
  constructor(THREE, scene, airports, sky, renderer){
    this.T=THREE; this.scene=scene; this.A=airports; this.sky=sky; this.renderer=renderer; this.time=0;
    airports.L=this;
    this.mat=new THREE.ShaderMaterial({ vertexShader:VS, fragmentShader:FS, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:true,
      uniforms:{ pxScale:{value:600}, night:sky.light.night, time:{value:0}, dayK:{value:0.55}, camLocal:{value:new THREE.Vector3()}, maxD:{value:42000} } });
  }
  build(a){
    const T=this.T, P=a.ref; const pos=[],col=[],size=[],ex=[];
    const H=(x,z)=>this.A.terrain.heightAt(x,z);
    const add=(x,z,c,sz,dx,dz,ph,dayI,dy)=>{ pos.push(x-P[0],H(x,z)+(dy==null?0.35:dy),z-P[1]); col.push(c[0],c[1],c[2]); size.push(sz); ex.push(dx||0,dz||0,ph==null?-1:ph,dayI==null?0.5:dayI); };
    const WHITE=[1,0.96,0.86], AMBER=[1,0.62,0.12], GREEN=[0.1,1,0.35], RED=[1,0.1,0.06], BLUE=[0.12,0.3,1], YEL=[1,0.8,0.2];
    a.papi=[]; a.alsOSM=this.A.data[a.icao].nodes.some(n=>n.t==="nav:als");
    for(const r of a.runways){
      const hw=r.w/2, rx=-r.uz, rz=r.ux;           // A→B の右
      const at=(t,s)=>[r.ax+r.ux*t+rx*s, r.az+r.uz*t+rz*s];
      // 縁灯（60m）
      for(let t=0;t<=r.L;t+=60){ const amber=(t>r.L-600||t<600); for(const s of [-hw-1.0,hw+1.0]){ const p=at(t,s); add(p[0],p[1],amber?AMBER:WHITE,0.55,0,0,-1,0.45); } }
      // 中心線灯（15m 間隔・最後の 900m は赤白交互、300m は赤）
      for(let t=15;t<r.L-10;t+=15){ const e=Math.min(t,r.L-t); const p=at(t,0); let c=WHITE; if(e<300) c=RED; else if(e<900) c=(Math.floor(t/15)%2?RED:WHITE); add(p[0],p[1],c,0.34,0,0,-1,0.30); }
      // しきい値灯: 緑（進入側から見える）、末端灯: 赤（滑走路上から見える）
      for(let i=0;i<2;i++){ const end=r.ends[i]; const t0=i===0?0:r.L, ox=end.ux, oz=end.uz;     // end.u は滑走路内向き
        for(let k=-10;k<=10;k++){ const s=k*(hw*0.95)/10; const p=at(t0,s); add(p[0],p[1],GREEN,0.7,-ox,-oz,-1,0.55); add(p[0],p[1],RED,0.6,ox,oz,-1,0.35); }
        // 進入灯
        const outx=-ox, outz=-oz;
        if(a.alsOSM){ /* OSM の点を使う（下で追加） */ }
        else {
          for(let d=30; d<=900; d+=30){ const ph=((900-d)/900)*0.5; const cx=end.x+outx*d, cz=end.z+outz*d; add(cx,cz,WHITE,0.85,0,0,ph,0.65,6.0); if(d%150===0||d===300){ for(const s of [-1,1]){ for(let m=1;m<=3;m++){ add(cx+(-outz)*s*m*1.5,cz+outx*s*m*1.5,WHITE,0.7,0,0,-1,0.5,6.0); } } } }
          for(const s of [-1,1]) for(let m=1;m<=5;m++){ const d=300; const cx=end.x+outx*d+(-outz)*s*m*2.0, cz=end.z+outz*d+outx*s*m*2.0; add(cx,cz,WHITE,0.7,0,0,-1,0.5,6.0); }
          // サイド列（しきい値付近の赤）
          for(const s of [-1,1]) for(let d=15; d<=270; d+=30){ add(end.x+outx*d+(-outz)*s*(hw*0.5+10),end.z+outz*d+outx*s*(hw*0.5+10),RED,0.7,0,0,-1,0.5,1.5); }
        }
        // PAPI（滑走路の左側、しきい値から 300m）。進入方向 = 外向き(-u)から滑走路へ
        const lx=end.ux, lz=end.uz;               // 滑走路内向き
        const leftx=lz, leftz=-lx;                // 進行方向の左（内向き u に対する左）
        const px=end.x+lx*300+leftx*(hw+16), pz=end.z+lz*300+leftz*(hw+16);
        const units=[]; for(let k=0;k<4;k++){ const ux=px+leftx*(9+k*9)*0.5*1.0, uz=pz+leftz*(9+k*9)*0.5*1.0; units.push({x:ux,z:uz,idx:pos.length/3}); add(ux,uz,WHITE,1.1,-lx,-lz,-1,0.9,0.9); }
        a.papi.push({r,i,end,units,gs:3.0*D2R,hThr:i===0?r.hA:r.hB,px,pz,lx,lz});
      }
    }
    // OSM に進入灯の点があれば、それを使う
    if(a.alsOSM){ const d=this.A.data[a.icao]; const als=d.nodes.filter(n=>n.t==="nav:als"); for(const n of als){ const p=G.ll2xz(n.p[1],n.p[0]); // しきい値からの距離でフラッシュ位相
        let ph=-1; let best=1e9; for(const r of a.runways) for(const e of r.ends){ const dd=Math.hypot(p[0]-e.x,p[1]-e.z); if(dd<best){ best=dd; ph=Math.max(0,(1-Math.min(1,dd/900))*0.5); } } add(p[0],p[1],WHITE,0.85,0,0,ph,0.65,5.0); } }
    // 誘導路: 縁灯（青）・中心線灯（緑）
    for(const sg of a.taxi){
      let acc=0; const spE=35, spC=22; let nextE=0,nextC=0;
      for(let i=0;i<sg.pts.length-1;i++){ const ax=sg.pts[i][0],az=sg.pts[i][1],bx=sg.pts[i+1][0],bz=sg.pts[i+1][1]; const dx=bx-ax,dz=bz-az,L=Math.hypot(dx,dz); if(L<1) continue; const ux=dx/L,uz=dz/L,rx=-uz,rz=ux;
        let t=nextE-acc; while(t<L){ if(t>=0){ const p=[ax+ux*t,az+uz*t]; for(const s of [-1,1]) add(p[0]+rx*s*(sg.W/2+0.8),p[1]+rz*s*(sg.W/2+0.8),BLUE,0.45,0,0,-1,0.0,0.3); nextE+=spE; } t+=spE; }
        let u=nextC-acc; while(u<L){ if(u>=0){ add(ax+ux*u,az+uz*u,GREEN,0.38,0,0,-1,0.0,0.25); nextC+=spC; } u+=spC; }
        acc+=L; }
    }
    // 停止線灯（誘導路を横切る赤）
    for(const h of (a.hold||[])){ const [x,z,ux,uz,W]=h; const rx=-uz,rz=ux; for(let s=-W/2;s<=W/2;s+=2.5) add(x+rx*s,z+rz*s,RED,0.5,0,0,-1,0.1,0.3); }
    // 風向吹き流し（OSM の点）
    const g=new T.BufferGeometry(); g.setAttribute("position",new T.BufferAttribute(new Float32Array(pos),3)); g.setAttribute("col",new T.BufferAttribute(new Float32Array(col),3)); g.setAttribute("size",new T.BufferAttribute(new Float32Array(size),1)); g.setAttribute("ex",new T.BufferAttribute(new Float32Array(ex),4));
    g.boundingSphere=new T.Sphere(new T.Vector3(0,0,0),20000);
    const pts=new T.Points(g,this.mat); pts.frustumCulled=false; pts.renderOrder=20; a.group.add(pts); a.lightPts=pts; a.lightGeo=g; a.lightCount=size.length;
  }
  update(cam,dt,fovRad,height,pilotPos){
    this.time+=dt; const u=this.mat.uniforms; u.time.value=this.time; u.pxScale.value=0.5*height/Math.tan(fovRad/2);
    for(const a of Object.values(this.A.ap)){
      if(!a.lightPts||!a.group.visible) continue;
      // camLocal はグループごとに違うので、描画直前に設定
      a.lightPts.onBeforeRender=()=>{ u.camLocal.value.set(cam.x-a.ref[0],cam.y,cam.z-a.ref[1]); };
      // PAPI 色
      if(pilotPos){ for(const pp of a.papi){ const dx=pilotPos.x-pp.end.x, dz=pilotPos.z-pp.end.z; const along=-(dx*pp.lx+dz*pp.lz); /* 進入側が正 */ if(along<300||along>16000) continue;
          const lat=Math.abs(dx*(-pp.lz)+dz*pp.lx); if(lat>6000) continue; const ang=Math.atan2(pilotPos.y-pp.hThr, along+300);
          const th=[pp.gs-0.5*D2R-0.0, pp.gs-0.17*D2R, pp.gs+0.17*D2R, pp.gs+0.5*D2R]; // 外側から: 左端が最も低い角
          const colAttr=a.lightGeo.attributes.col; for(let k=0;k<4;k++){ const white=ang>th[k]; const j=pp.units[k].idx; colAttr.array[j*3]=white?1:1.0; colAttr.array[j*3+1]=white?0.96:0.08; colAttr.array[j*3+2]=white?0.86:0.05; } colAttr.needsUpdate=true; } }
    }
  }
}
root.AirLights=AirLights;
})(typeof window!=="undefined"?window:globalThis);
