/* 空: グラデーション天球＋太陽＋積雲（インスタンス化したビルボード）。 時刻(sunEl)で色と光を決め、霧の色を地平線に合わせる。 */
(function(root){
"use strict";
function mix3(a,b,t){ return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]; }
const sm=(a,b,x)=>{ const t=Math.max(0,Math.min(1,(x-a)/(b-a))); return t*t*(3-2*t); };
class Sky{
  constructor(THREE, scene, renderer){
    this.T=THREE; this.scene=scene; this.sunDir=new THREE.Vector3(0.4,0.7,0.3).normalize();
    this.hour=14; this.turb=0.35; this.cover=0.35;               // cover: 積雲の量 0..1
    this.zen=new THREE.Color(0.2,0.42,0.82); this.hor=new THREE.Color(0.64,0.77,0.92); this.fogColor=new THREE.Color(0.64,0.77,0.92);
    this.sunCol=new THREE.Color(1,0.96,0.88); this.hemiSky=new THREE.Color(0.55,0.68,0.9); this.hemiGround=new THREE.Color(0.35,0.33,0.28);
    this.night=0; this.light={ sunDir:{value:this.sunDir}, sunCol:{value:this.sunCol}, ambSky:{value:this.hemiSky}, ambGnd:{value:this.hemiGround}, night:{value:0}, fogCol:{value:this.fogColor}, fogDen:{value:1/52000} };
    // 天球
    const g=new THREE.SphereGeometry(1,32,20);
    this.domeMat=new THREE.ShaderMaterial({ side:THREE.BackSide, depthWrite:false, depthTest:false, fog:false,
      uniforms:{ zen:{value:this.zen}, hor:{value:this.hor}, sunDir:{value:this.sunDir}, night:this.light.night, sunVis:{value:1} },
      vertexShader:"varying vec3 vDir; void main(){ vDir=position; vec4 p=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*p; gl_Position.z=gl_Position.w*0.99999; }",
      fragmentShader:"varying vec3 vDir; uniform vec3 zen,hor,sunDir; uniform float night; void main(){ vec3 d=normalize(vDir); float e=d.y; "+
        "float k=pow(clamp(e,0.0,1.0),0.42); vec3 c=mix(hor,zen,k); "+
        "float below=smoothstep(0.0,-0.12,e); c=mix(c,hor*0.92,below); "+
        "float s=max(dot(d,sunDir),0.0); vec3 sunc=vec3(1.0,0.93,0.78); "+
        "c+=sunc*(pow(s,6.0)*0.10+pow(s,64.0)*0.28)*(1.0-0.9*night); "+
        "float disc=smoothstep(0.99955,0.99985,s); c=mix(c,vec3(1.6,1.45,1.15),disc*(1.0-night)); "+
        // 夜は星
        "if(night>0.01){ vec3 q=floor(d*420.0); float h=fract(sin(dot(q,vec3(12.9898,78.233,37.719)))*43758.5453); float st=step(0.9975,h)*smoothstep(0.02,0.35,e); c+=vec3(st)*night*0.9; } "+
        "gl_FragColor=vec4(c,1.0); }" });
    this.dome=new THREE.Mesh(g,this.domeMat); this.dome.scale.setScalar(150000); this.dome.renderOrder=-10; this.dome.frustumCulled=false; scene.add(this.dome);
    this.initClouds(); this.setHour(14);
  }
  // ---------- 時刻 ----------
  setHour(h, lat){
    this.hour=h; lat=(lat==null?35.2:lat)*Math.PI/180; const dec=0.2;  // 季節は初夏〜秋ごろ（太陽の赤緯 ≈ +11°）
    const H=(h-12)*Math.PI/12; const sinEl=Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(H); const el=Math.asin(sinEl);
    // 方位（北=0, 東=+）
    const az=Math.atan2(-Math.sin(H)*Math.cos(dec), Math.cos(lat)*Math.sin(dec)-Math.sin(lat)*Math.cos(dec)*Math.cos(H)); // 北基準
    const ce=Math.cos(el); this.sunDir.set(Math.sin(az)*ce, sinEl, -Math.cos(az)*ce).normalize(); this.sunEl=el;
    const day=sm(-0.05,0.18,sinEl), dusk=sm(-0.22,0.02,sinEl)*(1-sm(0.02,0.35,sinEl)), twi=sm(-0.30,-0.02,sinEl);
    // 色テーブル
    let zen=mix3([0.004,0.008,0.03],[0.07,0.11,0.28],twi); zen=mix3(zen,[0.17,0.38,0.80],day);
    let hor=mix3([0.015,0.025,0.06],[0.55,0.34,0.30],twi); hor=mix3(hor,[0.66,0.78,0.92],day);
    // 夕焼け（地平線を橙に）
    const warm=Math.max(0,1-Math.abs(sinEl-0.04)/0.18)*(sinEl>-0.2?1:0); hor=mix3(hor,[0.98,0.55,0.28],warm*0.55*(1-0.4*day));
    zen=mix3(zen,[0.25,0.30,0.55],warm*0.35);
    this.zen.setRGB(zen[0],zen[1],zen[2]); this.hor.setRGB(hor[0],hor[1],hor[2]); this.fogColor.copy(this.hor).lerp(this.zen,0.12);
    this.night=1-twi; this.light.night.value=this.night;
    const sunI=sm(-0.04,0.25,sinEl); this.sunCol.setRGB(1.0*sunI*(0.8+0.2*day)+0.0, (0.55+0.4*day)*sunI, (0.3+0.58*day)*sunI*(0.65+0.35*day));
    const ambDay=0.55+0.45*day;
    this.hemiSky.setRGB(0.20*ambDay*(0.2+0.8*twi)+0.02*(1-twi)+0.10*day, 0.27*ambDay*(0.2+0.8*twi)+0.025*(1-twi)+0.14*day, 0.42*ambDay*(0.2+0.8*twi)+0.05*(1-twi)+0.22*day);
    this.hemiGround.setRGB(0.10+0.12*day,0.09+0.11*day,0.08+0.08*day);
    this.tint=0.09+0.91*Math.pow(sm(-0.12,0.22,sinEl),0.9);    // 航空写真の明るさ係数
    this.tintCol=[this.tint*(1-0.15*(1-day)*0.0), this.tint, this.tint*(0.92+0.08*day)];
    this.cloudTint=this.hor.clone().lerp(new this.T.Color(1,1,1),0.55*day).multiplyScalar(0.35+0.65*Math.max(0.12,sinEl>0?Math.min(1,sinEl*2.2+0.2):0.12));
    if(this.clouds) this.clouds.material.uniforms.tint.value.copy(this.cloudTint);
  }
  // ---------- 雲 ----------
  makeCloudTex(){
    const S=256, c=document.createElement("canvas"); c.width=c.height=S; const x=c.getContext("2d"); x.clearRect(0,0,S,S);
    // 2x2 のバリエーション
    let seed=7; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
    for(let v=0;v<4;v++){
      const ox=(v%2)*128, oy=Math.floor(v/2)*128;
      const blobs=[]; const n=16+Math.floor(rnd()*8);
      for(let i=0;i<n;i++){ const a=rnd()*Math.PI*2, r=rnd()*0.28; blobs.push([0.5+Math.cos(a)*r*1.1, 0.60+Math.sin(a)*r*0.5-r*r*0.3, 0.10+rnd()*0.10]); }
      for(const [bx,by,br] of blobs){
        const cx=ox+bx*128, cy=oy+by*128, rad=br*128;
        const gr=x.createRadialGradient(cx-rad*0.15,cy-rad*0.25,rad*0.05,cx,cy,rad);
        const top=by<0.55; gr.addColorStop(0,"rgba(255,255,255,0.95)"); gr.addColorStop(0.55,"rgba(235,240,248,0.62)"); gr.addColorStop(1,"rgba(210,218,232,0)");
        x.fillStyle=gr; x.beginPath(); x.arc(cx,cy,rad,0,Math.PI*2); x.fill(); }
      // 底面を平らに暗く（積雲の特徴）
      const g2=x.createLinearGradient(0,oy+70,0,oy+104); g2.addColorStop(0,"rgba(120,130,150,0)"); g2.addColorStop(1,"rgba(120,130,150,0.55)");
      x.globalCompositeOperation="source-atop"; x.fillStyle=g2; x.fillRect(ox,oy+70,128,40); x.globalCompositeOperation="source-over";
      // 縁をなじませる（セル境界で切れないように）
      x.save(); x.beginPath(); x.rect(ox,oy,128,128); x.clip(); x.globalCompositeOperation="destination-in"; const gm=x.createRadialGradient(ox+64,oy+66,10,ox+64,oy+66,62); gm.addColorStop(0,"rgba(0,0,0,1)"); gm.addColorStop(0.7,"rgba(0,0,0,0.9)"); gm.addColorStop(1,"rgba(0,0,0,0)"); x.fillStyle=gm; x.fillRect(ox,oy,128,128); x.restore();
      // 下端をカット
      x.globalCompositeOperation="destination-out"; const g3=x.createLinearGradient(0,oy+96,0,oy+112); g3.addColorStop(0,"rgba(0,0,0,0)"); g3.addColorStop(1,"rgba(0,0,0,1)"); x.fillStyle=g3; x.fillRect(ox,oy+96,128,32); x.globalCompositeOperation="source-over";
    }
    const t=new this.T.CanvasTexture(c); t.minFilter=this.T.LinearMipmapLinearFilter; t.anisotropy=4; return t;
  }
  initClouds(){
    const T=this.T, MAXC=900;
    const base=new T.InstancedBufferGeometry(); base.setAttribute("position",new T.BufferAttribute(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]),3)); base.setIndex([0,1,2,0,2,3]);
    this.cOff=new Float32Array(MAXC*3); this.cScl=new Float32Array(MAXC*2); this.cVar=new Float32Array(MAXC);
    base.setAttribute("off",new T.InstancedBufferAttribute(this.cOff,3).setUsage(T.DynamicDrawUsage)); base.setAttribute("scl",new T.InstancedBufferAttribute(this.cScl,2).setUsage(T.DynamicDrawUsage)); base.setAttribute("vr",new T.InstancedBufferAttribute(this.cVar,1).setUsage(T.DynamicDrawUsage));
    base.instanceCount=0;
    const mat=new T.ShaderMaterial({ transparent:true, depthWrite:false, depthTest:true, fog:false,
      uniforms:{ map:{value:this.makeCloudTex()}, tint:{value:new T.Color(1,1,1)}, fadeNear:{value:260}, fogCol:this.light.fogCol, fogDen:this.light.fogDen, night:this.light.night },
      vertexShader:"#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute vec3 off; attribute vec2 scl; attribute float vr; varying vec2 vUv; varying float vDist; varying float vV; void main(){ "+
        "vec4 c=viewMatrix*vec4(off,1.0); vDist=length(c.xyz); vec3 vp=c.xyz+vec3(position.x*scl.x,position.y*scl.y,0.0); vUv=position.xy*0.5+0.5; vV=vr; gl_Position=projectionMatrix*vec4(vp,1.0);\n#include <logdepthbuf_vertex>\n}",
      fragmentShader:"#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform sampler2D map; uniform vec3 tint,fogCol; uniform float fadeNear,fogDen,night; varying vec2 vUv; varying float vDist; varying float vV; void main(){\n#include <logdepthbuf_fragment>\n"+
        "vec2 uv=vec2(mod(vV,2.0)*0.5,floor(vV*0.5)*0.5)+vUv*0.5; vec4 t=texture2D(map,uv); float fade=smoothstep(fadeNear*0.35,fadeNear*2.2,vDist); "+
        "float f=1.0-exp(-vDist*vDist*fogDen*fogDen*0.35); vec3 col=mix(t.rgb*tint*1.05,fogCol,f*0.85); gl_FragColor=vec4(col,t.a*fade*(1.0-0.7*f)); }" });
    this.clouds=new T.Mesh(base,mat); this.clouds.frustumCulled=false; this.clouds.renderOrder=5; this.scene.add(this.clouds);
    this.cloudAnchor=[1e12,1e12]; this.cloudBase=1900; this.cloudWind=[4,2]; this.cloudTime=0;
  }
  hash(i,j,k){ let h=(i*374761393+j*668265263+k*2147483647)|0; h=(h^(h>>>13))*1274126177|0; h^=h>>>16; return (h>>>0)/4294967295; }
  updateClouds(cam,dt){
    const mat=this.clouds.material; this.cloudTime+=dt;
    const CELL=1800, R=26000, nc=Math.ceil(R/CELL); const ox=this.cloudWind[0]*this.cloudTime, oz=this.cloudWind[1]*this.cloudTime;
    const gx=Math.floor((cam.x-ox)/CELL), gz=Math.floor((cam.z-oz)/CELL); let n=0; const MAX=this.cOff.length/3;
    const cov=this.cover, jx=cam.x, jy=cam.y;
    for(let i=-nc;i<=nc;i++) for(let j=-nc;j<=nc;j++){
      const ci=gx+i, cj=gz+j; const r1=this.hash(ci,cj,1); if(r1>cov*0.7) continue;
      // 大きな群れを作る（低周波）
      const lo=this.hash(Math.floor(ci/4),Math.floor(cj/4),9); if(lo>0.35+cov*0.75) continue;
      const wx=(ci+this.hash(ci,cj,2))*CELL+ox, wz=(cj+this.hash(ci,cj,3))*CELL+oz;
      const d2=(wx-cam.x)**2+(wz-cam.z)**2; if(d2>R*R) continue;
      const base=this.cloudBase+(this.hash(ci,cj,5)-0.5)*260; const ns=1+Math.floor(this.hash(ci,cj,4)*4);
      for(let s=0;s<ns&&n<MAX;s++){
        const sx=wx+(this.hash(ci,cj,10+s)-0.5)*1400, sz=wz+(this.hash(ci,cj,20+s)-0.5)*1400, sy=base+(this.hash(ci,cj,30+s)-0.3)*260+s*60;
        const sz2=300+this.hash(ci,cj,40+s)*520;
        this.cOff[n*3]=sx-cam.x; this.cOff[n*3+1]=sy-cam.y; this.cOff[n*3+2]=sz-cam.z; this.cScl[n*2]=sz2*1.35; this.cScl[n*2+1]=sz2*0.85; this.cVar[n]=Math.floor(this.hash(ci,cj,50+s)*4); n++; }
    }
    const g=this.clouds.geometry; g.instanceCount=n; g.attributes.off.needsUpdate=true; g.attributes.scl.needsUpdate=true; g.attributes.vr.needsUpdate=true;
  }
  update(cam,dt){
    this.dome.position.set(0,0,0);   // カメラ相対描画のためカメラ位置が原点
    this.updateClouds(cam,dt);
  }
}
root.Sky=Sky;
})(typeof window!=="undefined"?window:globalThis);
