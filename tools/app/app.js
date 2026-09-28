(function(){
"use strict";
/* =====================================================================
   OKADEN 運転席 v4 — 実データ版
   建物・道路・植生・地形: 国土交通省 PLATEAU 岡山市2025 (CC BY 4.0)
   軌道(上下線)・電停・制限速度・信号・横断歩道・車線数: OpenStreetMap (ODbL)
   地面・屋根: 国土地理院 シームレス空中写真
   座標: 岡山駅前駅を原点とするローカル平面 (m)。x=東, z=南, y=標高(T.P.)
   ===================================================================== */
const $ = id => document.getElementById(id);
const S = {
  scene:null, routes:null, key:"higashi", route:null,
  track:null, arc:null, total:0, stops:[], cum:[], signals:[], speedLim:null,
  topH:90, pos:0, speed:0, acc:0, emergency:false, notch:0, doorOpen:true, running:false, view:"cab",
  mode:"tram", mc:0, bv:0, look:"photo",
  score:1000, comfortHits:0, stopIndex:1, sigIndex:0, clock:9*3600, announced:new Set(), t:0
};

/* ---------------- レンダラ ---------------- */
const canvas = $("world");
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:"high-performance", logarithmicDepthBuffer:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.75));
const scene = new THREE.Scene();
const SKY_H = new THREE.Color(0x8fb4d6), SKY_L = new THREE.Color(0xdfe6e8);
scene.background = SKY_L.clone();
scene.fog = new THREE.Fog(0xd6dfe2, 280, 1700);
const FOG_BASE = { near:280, far:1700 };   // v17: ヘリで高く上がると霧を遠ざける
const camera = new THREE.PerspectiveCamera(56, innerWidth/innerHeight, 0.3, 3500);
(function(){
  const g = new THREE.SphereGeometry(3000, 24, 12), cols=[], p=g.attributes.position;
  for(let i=0;i<p.count;i++){ const t=Math.max(0,p.getY(i)/3000); const c=SKY_L.clone().lerp(SKY_H,Math.pow(t,0.55)); cols.push(c.r,c.g,c.b); }
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols,3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({vertexColors:true, side:THREE.BackSide, fog:false, depthWrite:false}));
  m.name="sky"; m.renderOrder=-1; scene.add(m);
})();
const hemi = new THREE.HemisphereLight(0xeef2f5, 0x5d574b, 0.80); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 0.72); sun.position.set(-450, 820, 380); scene.add(sun); scene.add(sun.target);
let SUN_DIR = new THREE.Vector3(-450, 820, 380).normalize();
// 影（v11）: カメラの周り約 340m 四方だけ。PC の性能に合わせて「影: なし」にできる
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = true;
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
{ const c=sun.shadow.camera; c.left=-170; c.right=170; c.top=170; c.bottom=-170; c.near=50; c.far=2600; }
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.35;
let SHADOW_SPAN = 340;
function updateSun(){
  if(!renderer.shadowMap.enabled) return;
  const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; if(f.lengthSq()>0) f.normalize();
  // v17: ヘリで高い所からは影の範囲を広げる（そのぶん粗くなる）
  const heli = S.mode==="heli" && Heli.H.active;
  const span = heli ? Math.min(1400, Math.max(340, Math.round((340 + Math.max(0,Heli.H.agl)*1.6)/60)*60)) : 340;
  if(span!==SHADOW_SPAN){ SHADOW_SPAN=span; const sc=sun.shadow.camera; sc.left=-span/2; sc.right=span/2; sc.top=span/2; sc.bottom=-span/2; sc.far=2600+span; sc.updateProjectionMatrix(); }
  const c=camera.position.clone().addScaledVector(f, heli ? Math.min(600, 90 + Math.max(0,Heli.H.agl)*0.9) : 90); const tex=span/2048;
  c.x=Math.round(c.x/tex)*tex; c.z=Math.round(c.z/tex)*tex; c.y=0;
  sun.target.position.copy(c); sun.position.copy(c).addScaledVector(SUN_DIR, 1200); sun.target.updateMatrixWorld();
}
function setShadows(on){ renderer.shadowMap.enabled=on; sun.castShadow=on; scene.traverse(o=>{ if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.needsUpdate=true); } }); }
const world = new THREE.Group(); scene.add(world);

/* ---------------- 手続き的テクスチャ（路面材質） ---------------- */
function canvasTex(w,h,draw,repeat){
  const c=document.createElement("canvas"); c.width=w; c.height=h; draw(c.getContext("2d"),w,h);
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=Math.min(8, renderer.capabilities.getMaxAnisotropy()); return t;
}
function noise(g,w,h,base,amp,n){
  g.fillStyle=base; g.fillRect(0,0,w,h);
  for(let i=0;i<n;i++){ const v=Math.random(); g.fillStyle=`rgba(${v>0.5?255:0},${v>0.5?255:0},${v>0.5?255:0},${Math.random()*amp})`;
    g.fillRect(Math.random()*w,Math.random()*h,1+Math.random()*2,1+Math.random()*2); }
}
const TEX = {
  asphalt: canvasTex(256,256,(g,w,h)=>{ noise(g,w,h,"#4a4b4d",0.10,9000);
    g.strokeStyle="rgba(20,20,20,0.18)"; g.lineWidth=1; for(let i=0;i<6;i++){ g.beginPath(); g.moveTo(Math.random()*w,Math.random()*h); g.lineTo(Math.random()*w,Math.random()*h); g.stroke(); } }),
  paving: canvasTex(256,256,(g,w,h)=>{ // インターロッキング(約30cm角)
    g.fillStyle="#b3aa9b"; g.fillRect(0,0,w,h);
    const s=32; for(let y=0;y<h;y+=s){ for(let x=0;x<w;x+=s){ const off=(y/s)%2? s/2:0; const v=0.9+Math.random()*0.16;
      g.fillStyle=`rgb(${179*v|0},${170*v|0},${155*v|0})`; g.fillRect((x+off)%w+1,y+1,s-2,s-2); } }
    noise(g,w,h,"rgba(0,0,0,0)",0.06,3000); }),
  island: canvasTex(128,128,(g,w,h)=>{ noise(g,w,h,"#9d9a92",0.08,2500); }),
  grass: canvasTex(128,128,(g,w,h)=>{ noise(g,w,h,"#5c7a3e",0.2,5000); }),
  trackbed: canvasTex(256,256,(g,w,h)=>{ // 併用軌道のコンクリートブロック舗装
    g.fillStyle="#8c8a85"; g.fillRect(0,0,w,h);
    for(let y=0;y<h;y+=64) for(let x=0;x<w;x+=128){ const v=0.9+Math.random()*0.15; g.fillStyle=`rgb(${140*v|0},${138*v|0},${133*v|0})`; g.fillRect(x+2,y+2,124,60); }
    noise(g,w,h,"rgba(0,0,0,0)",0.08,4000); }),
};
const TEX_SCALE = {asphalt:4, paving:2.4, island:2, grass:3, trackbed:2.6};

/* 岡山駅 東口駅舎の外壁（写真を参考にした1スパン=6.3m・全高分の絵）: 下から
   1階の店舗ガラス → 白い帯 → 窓の並ぶ白い外壁 → 白い帯 → 最上部の鉄骨とガラスの格子 → 笠木 */
function stationTex(){
  return canvasTex(512,1024,(g,w,h)=>{
    const Y = f => h*(1-f);   // f: 下からの高さの割合
    g.fillStyle="#f2f2ef"; g.fillRect(0,0,w,h);
    // 最上部のガラス格子（2段）
    g.fillStyle="#b9c6cf"; g.fillRect(0,Y(0.95),w,Y(0.61)-Y(0.95));
    for(let i=0;i<40;i++){ g.fillStyle=`rgba(255,255,255,${0.05+Math.random()*0.12})`; g.fillRect(Math.random()*w, Y(0.95)+Math.random()*(Y(0.61)-Y(0.95)), 40+Math.random()*80, 6); }
    g.fillStyle="#6f757a"; for(let k=0;k<=4;k++) g.fillRect(k*w/4-4, Y(0.95), 8, Y(0.61)-Y(0.95));
    for(const f of [0.95,0.86,0.78,0.70,0.61]) g.fillRect(0, Y(f)-4, w, 8);
    g.fillStyle="#8b9196"; for(let k=0;k<8;k++){ const x=k*w/8; g.fillRect(x-1.5, Y(0.95), 3, Y(0.61)-Y(0.95)); }
    // 笠木
    g.fillStyle="#9ea3a6"; g.fillRect(0,0,w,Y(0.965)); g.fillStyle="#5d6266"; g.fillRect(0,Y(0.965)-4,w,6);
    // 白い帯と窓の列（中層）
    g.fillStyle="#e9e9e6"; g.fillRect(0,Y(0.61),w,Y(0.52)-Y(0.61));
    g.fillStyle="#7d8c97"; for(let k=0;k<4;k++){ g.fillRect(k*w/4+14, Y(0.50), w/4-28, Y(0.33)-Y(0.50)); }
    g.fillStyle="#c9d3d9"; for(let k=0;k<4;k++){ g.fillRect(k*w/4+14, Y(0.50), w/4-28, 10); }
    g.fillStyle="#d8d8d4"; g.fillRect(0,Y(0.33),w,6);
    // 1階: 店舗のガラスとサッシ（上屋の陰になる部分）
    g.fillStyle="#e4e4e0"; g.fillRect(0,Y(0.27),w,Y(0.21)-Y(0.27));
    g.fillStyle="#4b5359"; g.fillRect(0,Y(0.21),w,h-Y(0.21));
    g.fillStyle="#6b7680"; for(let k=0;k<6;k++) g.fillRect(k*w/6+6, Y(0.19), w/6-12, Y(0.02)-Y(0.19));
    g.fillStyle="#2f3438"; for(let k=0;k<=6;k++) g.fillRect(k*w/6-3, Y(0.21), 6, h-Y(0.21));
  });
}
function stationSignTex(){
  return canvasTex(1024,512,(g,w,h)=>{
    g.fillStyle="#f4f4f1"; g.fillRect(0,0,w,h);
    g.strokeStyle="rgba(0,0,0,0.06)"; g.lineWidth=2; for(let x=0;x<w;x+=64){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke(); } for(let y=0;y<h;y+=64){ g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke(); }
    g.fillStyle="#141414"; g.textAlign="center"; g.textBaseline="middle";
    g.font="bold 150px 'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP',serif"; g.fillText("岡　山　駅", w/2, h*0.36);
    g.font="bold 80px 'Helvetica Neue',Arial,sans-serif"; g.fillText("OKAYAMA STATION", w/2, h*0.72);
  });
}
/* 外壁（v11）: 512×1024 のキャンバスに「上の階（上半分）」「1階（下半分）」の2枚。α=0 はガラス（シェーダーで空の映り込み）。
   白い部分に建物ごとの色（PLATEAU の写真から推定）が掛かる。u=柱間（2.7〜6m）、v=階（階高は PLATEAU の高さ÷階数） */
function facadeTex(kind){
  if(kind==="station") return stationTex();
  return canvasTex(512,1024,(g,w,h)=>{
    const T=512;
    const wall=(y0)=>{ g.fillStyle="#ffffff"; g.fillRect(0,y0,w,T); };
    const glass=(x,y,ww,hh)=>{ g.clearRect(x,y,ww,hh); };
    const frame=(x,y,ww,hh,c,lw)=>{ g.strokeStyle=c||"#3b4046"; g.lineWidth=lw||8; g.strokeRect(x+lw/2||x,y+(lw||8)/2,ww-(lw||8),hh-(lw||8)); };
    const box=(x,y,ww,hh,c)=>{ g.fillStyle=c; g.fillRect(x,y,ww,hh); };
    const grain=(y0,a)=>{ const r=(i)=>((Math.sin(i*12.9898)*43758.5453)%1+1)%1; g.fillStyle="rgba(0,0,0,"+(a||0.03)+")"; for(let i=0;i<900;i++){ g.fillRect(r(i)*w, y0+r(i+7)*T, 2, 2); } };
    // --- 上の階 (0..512) ---
    wall(0); grain(0);
    if(kind==="curtain"){
      glass(0,0,w,440); for(let x=0;x<=w;x+=128) box(x-4,0,8,440,"#2d3238"); box(0,210,w,6,"#2d3238");
      box(0,440,w,72,"#39424c"); box(0,436,w,6,"#1f2328");
    } else if(kind==="office"){
      box(0,120,w,8,"rgba(0,0,0,.18)"); glass(0,130,w,250); for(let x=0;x<=w;x+=256) box(x-6,130,12,250,"#40464d"); box(0,126,w,8,"#40464d"); box(0,378,w,10,"#40464d");
      box(0,388,w,10,"rgba(255,255,255,.6)"); box(0,398,w,6,"rgba(0,0,0,.18)");
    } else if(kind==="apt"){
      glass(70,70,372,330); box(70,64,372,8,"#555b60"); box(250,70,10,330,"#555b60"); box(70,70,8,330,"#555b60"); box(434,70,8,330,"#555b60");
      box(0,300,w,170,"#f4f4f2"); box(0,300,w,6,"rgba(0,0,0,.12)"); for(let x=20;x<w;x+=24) box(x,300,3,170,"rgba(0,0,0,.05)");
      box(0,470,w,42,"#e3e3df"); box(0,470,w,5,"rgba(0,0,0,.2)"); box(0,0,16,512,"#dcdcd7"); box(496,0,16,512,"#dcdcd7");
      box(120,330,70,60,"#c9c9c4"); // 室外機
    } else if(kind==="shop"){
      for(const x0 of [60,300]){ glass(x0,130,150,230); box(x0-8,122,166,10,"#50565c"); box(x0-8,360,166,14,"#b9b7b0"); box(x0+71,130,8,230,"#50565c"); }
      box(0,500,w,12,"rgba(0,0,0,.12)");
    } else if(kind==="house"){
      glass(150,150,220,190); box(144,144,232,8,"#4c5257"); box(256,150,8,190,"#4c5257"); box(140,340,240,12,"#d6d3cc");
      for(let y=0;y<T;y+=22) box(0,y,w,2,"rgba(0,0,0,.06)");
    } else if(kind==="house_old"){
      g.fillStyle="#d9ccb4"; g.fillRect(0,0,w,T); for(let y=6;y<T;y+=18) box(0,y,w,4,"rgba(60,40,20,.35)");
      glass(170,170,180,150); box(170,170,180,150,"rgba(0,0,0,0)"); for(let x=170;x<=350;x+=36) box(x-3,170,6,150,"#5b4630"); box(164,164,192,8,"#5b4630"); box(160,320,200,10,"#6b5a48");
    } else if(kind==="warehouse"){
      for(let x=0;x<w;x+=32) box(x,0,12,T,"rgba(0,0,0,.10)"); box(0,0,w,12,"rgba(0,0,0,.18)");
    } else if(kind==="temple"){
      g.fillStyle="#f1ece2"; g.fillRect(0,0,w,T); box(0,0,w,36,"#5a4332"); box(0,476,w,36,"#5a4332"); box(0,0,36,T,"#5a4332"); box(476,0,36,T,"#5a4332");
    } else {
      glass(100,140,312,220); box(100,134,312,8,"#4a5057"); box(100,360,312,12,"#c8c6c0");
    }
    // --- 1階 (512..1024) ---
    const Y=512; wall(Y); grain(Y,0.04);
    if(kind==="curtain"||kind==="office"){
      box(0,Y,w,70,"#ffffff"); box(0,Y+62,w,8,"rgba(0,0,0,.25)");
      glass(0,Y+80,w,400); for(let x=0;x<=w;x+=170) box(x-6,Y+80,12,400,"#30363c"); box(0,Y+76,w,10,"#30363c"); box(0,Y+478,w,34,"#6c6f72");
    } else if(kind==="shop"||kind==="apt"&&false){
      box(0,Y,w,90,"#ffffff"); box(20,Y+18,w-40,54,"rgba(0,0,0,.10)"); box(0,Y+88,w,10,"#3a3f44");
      glass(0,Y+98,w,340); for(let x=0;x<=w;x+=256) box(x-6,Y+98,12,340,"#3a3f44"); box(0,Y+438,w,74,"#7b7e80"); box(0,Y+438,w,6,"#3a3f44");
    } else if(kind==="apt"){
      box(0,Y,w,T,"#e9e8e4"); box(40,Y+120,432,392,"#34383c"); glass(80,Y+160,160,300); box(76,Y+156,168,8,"#1f2226"); box(300,Y+200,130,220,"#5c6064");
    } else if(kind==="house"){
      glass(80,Y+150,180,190); box(74,Y+144,192,8,"#4c5257"); box(330,Y+120,110,392,"#6a5846"); box(330,Y+120,110,8,"#3b3027");
      for(let y=0;y<T;y+=22) box(0,Y+y,w,2,"rgba(0,0,0,.06)");
    } else if(kind==="house_old"){
      g.fillStyle="#d2c3a8"; g.fillRect(0,Y,w,T); box(40,Y+110,432,402,"#5b4630"); glass(56,Y+126,400,380); for(let x=56;x<=456;x+=20) box(x,Y+126,5,380,"#6d5638"); box(40,Y+100,432,12,"#3b2d1f");
    } else if(kind==="warehouse"){
      for(let x=0;x<w;x+=32) box(x,Y,12,T,"rgba(0,0,0,.10)"); box(60,Y+120,392,392,"#a9adb0"); for(let y=Y+124;y<Y+512;y+=14) box(60,y,392,3,"rgba(0,0,0,.14)");
    } else if(kind==="temple"){
      g.fillStyle="#f1ece2"; g.fillRect(0,Y,w,T); box(0,Y,36,T,"#5a4332"); box(476,Y,36,T,"#5a4332"); box(160,Y+160,192,352,"#6a4e38");
    } else {
      glass(60,Y+140,392,300); box(54,Y+134,404,8,"#3a3f44"); box(0,Y+440,w,72,"#8a8c8e");
    }
  });
}
/* 外壁の材質: 1階と上の階を描き分け、ガラスには空の映り込み・窓ごとに少し違う色（カーテン・ブラインド） */
const FACADE_UNIFORMS = { uSkyTop:{value:new THREE.Color(0x7fa7cf)}, uSkyHor:{value:new THREE.Color(0xd9e4ea)} };
function facadeMaterial(kind){
  const t=facadeTex(kind);
  if(kind==="station"){ t.repeat.set(0.01,0.01); return new THREE.MeshLambertMaterial({map:t, vertexColors:true}); }
  t.repeat.set(0.01,0.01); t.generateMipmaps=true; t.minFilter=THREE.LinearMipmapLinearFilter;
  const m=new THREE.MeshPhongMaterial({map:t, vertexColors:true, shininess:28, specular:0x1a1a1a});
  m.onBeforeCompile=(sh)=>{
    sh.uniforms.uSkyTop=FACADE_UNIFORMS.uSkyTop; sh.uniforms.uSkyHor=FACADE_UNIFORMS.uSkyHor;
    sh.fragmentShader = "uniform vec3 uSkyTop; uniform vec3 uSkyHor;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", `
        vec2 fuv = vUv; float flr = floor(fuv.y); vec2 frc = fract(fuv);
        vec2 tuv = vec2(frc.x, flr < 0.5 ? frc.y*0.5 : 0.5 + frc.y*0.5);
        vec4 tex = textureGrad(map, tuv, dFdx(fuv)*vec2(1.0,0.5), dFdy(fuv)*vec2(1.0,0.5));
        float glassF = 1.0 - smoothstep(0.3, 0.7, tex.a);
        vec2 cell = floor(fuv);
        float hh = fract(sin(dot(cell + vec2(vColor.r*91.7, vColor.b*57.3), vec2(12.9898,78.233)))*43758.5453);
        vec3 gcol = mix(vec3(0.07,0.10,0.13), vec3(0.16,0.20,0.24), fract(hh*7.3));
        gcol = mix(gcol, vec3(0.62,0.58,0.50), step(0.86, hh));        // カーテン・ブラインド
        gcol = mix(gcol, vec3(0.80,0.78,0.70), step(0.965, hh));
        diffuseColor.rgb = mix(tex.rgb, gcol, glassF);`)
      .replace("#include <color_fragment>", "diffuseColor.rgb *= mix(vColor, vec3(1.0), glassF);")
      .replace("#include <envmap_fragment>", `
        { vec3 vd = normalize(vViewPosition); vec3 rv = reflect(vd, normal);
          vec3 upv = normalize((viewMatrix * vec4(0.0,1.0,0.0,0.0)).xyz);
          float e = dot(rv, upv);
          vec3 sky = mix(uSkyHor, uSkyTop, clamp(e,0.0,1.0)); sky = mix(vec3(0.30,0.31,0.30), sky, smoothstep(-0.25,0.05,e));
          float fres = 0.28 + 0.55*pow(1.0 - clamp(dot(-vd, normal),0.0,1.0), 3.0);
          outgoingLight = mix(outgoingLight, sky, glassF*fres); }`);
  };
  return m;
}

/* v29: データ範囲（地形・道路・建物のある所）。scene.json の drive 格子の範囲 */
function dataIn(x, z, m){ const d = S.scene && S.scene.drive; if(!d) return false; m = m || 0;
  return x > d.x0 + m && x < d.x0 + d.nx * d.step - m && z > d.z0 + m && z < d.z0 + d.nz * d.step - m; }
/* ---------------- v29: 航空写真のページ（1024m 四方・0.5m/画素）を近くだけ読み込む ----------------
   範囲を広げたので、全部のページを最初に読むと重い（GPU のメモリ）。範囲全体の縮小写真（2m/画素, ortho_ov）を先に読み、
   近くのページだけ元の解像度で読む。ページを使う面（近くの地面・屋根）は、ページが無い間は縮小写真を同じ位置に貼る */
const OrthoPages = (() => {
  let ovTex = null, OV = null, active = false;
  const tex = [], loading = new Set(), regs = new Map(), pmats = new Map(), omats = new Map();
  let lastT = 0;
  function setOverview(t, meta){ ovTex = t; OV = meta; active = true; }
  function ovMat(p, kind){
    const key = kind + p; if(omats.has(key)) return omats.get(key);
    const pg = S.scene.ortho[p];
    const T = new THREE.Vector4(pg.size / OV.w, pg.size / OV.d, (pg.x0 - OV.x0) / OV.w, 1 - (pg.z0 - OV.z0 + pg.size) / OV.d);
    const m = kind === "roof" ? new THREE.MeshLambertMaterial({ map:ovTex, emissive:0x1c1c1c, emissiveMap:ovTex }) : new THREE.MeshLambertMaterial({ map:ovTex });
    m.customProgramCacheKey = () => "ovT_" + kind;
    m.onBeforeCompile = (sh) => { sh.uniforms.uOvT = { value:T };
      sh.vertexShader = "uniform vec4 uOvT;\n" + sh.vertexShader.replace("#include <uv_vertex>", "#ifdef USE_UV\n vUv = uv * uOvT.xy + uOvT.zw;\n#endif"); };
    if(kind === "roof") Env.patch(m, "ortho");
    omats.set(key, m); return m;
  }
  function pageMat(p, kind){
    const key = kind + p; if(pmats.has(key)) return pmats.get(key);
    const t = tex[p];
    const m = kind === "roof" ? new THREE.MeshLambertMaterial({ map:t, emissive:0x1c1c1c, emissiveMap:t }) : new THREE.MeshLambertMaterial({ map:t });
    if(kind === "roof") Env.patch(m, "ortho");
    pmats.set(key, m); return m;
  }
  function mat(p, kind){ return tex[p] ? pageMat(p, kind) : ovMat(p, kind); }
  function reg(mesh, p, kind){ mesh.userData.op = p; mesh.userData.ok = kind; let s = regs.get(p); if(!s){ s = new Set(); regs.set(p, s); } s.add(mesh); }
  function unreg(mesh){ const p = mesh.userData.op; if(p === undefined) return; const s = regs.get(p); if(s) s.delete(mesh); }
  function swap(p){ const s = regs.get(p); if(s) for(const m of s) m.material = mat(p, m.userData.ok); }
  function dist(p, c, lift){ const P = S.scene.ortho[p]; const dx = Math.max(P.x0 - c.x, 0, c.x - (P.x0 + P.size)), dz = Math.max(P.z0 - c.z, 0, c.z - (P.z0 + P.size)); return Math.hypot(dx, dz, lift); }
  // 読む範囲: 地面の細かい面（GROUND_NEAR）より広く。ヘリで高く上がると広げる（最大 MAXP 枚。v28 までは全部で 12 枚を常に持っていた）
  const MAXP = 20;
  function radius(agl){ return 1300 + Math.min(1500, agl * 2.5); }
  function tick(c, lift, agl){
    if(!active) return;
    const now = performance.now(); if(now - lastT < 400) return; lastT = now;
    const R_IN = radius(agl), R_OUT = R_IN + 350;
    const n = S.scene.ortho.length, d = new Array(n);
    for(let p = 0; p < n; p++) d[p] = dist(p, c, lift);
    const want = [...Array(n).keys()].filter(p => d[p] < R_IN).sort((a, b) => d[a] - d[b]).slice(0, MAXP), wset = new Set(want);
    for(let p = 0; p < n; p++) if(tex[p] && (d[p] > R_OUT || (!wset.has(p) && d[p] > R_IN))) release(p);
    for(const p of want){ if(tex[p] || loading.has(p)) continue; if(loading.size >= 2) break; load(p); }
  }
  function load(p){
    loading.add(p);
    return loadTex(S.scene.ortho[p].file).then(t => { loading.delete(p); if(!t) return; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex[p] = t; swap(p); });
  }
  function release(p){
    const t = tex[p]; delete tex[p];
    swap(p);
    for(const k of ["roof", "ground"]){ const m = pmats.get(k + p); if(m){ m.dispose(); pmats.delete(k + p); } }
    if(t) t.dispose();
  }
  // 最初の画面: 出発地点の周りのページを読み終わるまで待つ
  async function prime(c){
    if(!active) return;
    const n = S.scene.ortho.length, R_IN = radius(0);
    const want = [...Array(n).keys()].filter(p => dist(p, c, 0) < R_IN).sort((a, b) => dist(a, c, 0) - dist(b, c, 0)).slice(0, MAXP);
    await Promise.all(want.map(p => load(p)));
  }
  return { setOverview, mat, reg, unreg, tick, prime, get active(){ return active; }, get ovTex(){ return ovTex; }, get OV(){ return OV; },
           get loadedCount(){ return tex.filter(Boolean).length; } };
})();
/* ---------------- 読み込み ---------------- */
let loaded=0, toLoad=1;
function progress(){ const p=Math.min(1,loaded/toLoad); $("loadbar").style.width=(p*100).toFixed(1)+"%"; $("start-label").textContent="3D都市モデルを読み込み中… "+Math.round(p*100)+"%"; }
async function fetchPacked(fn){
  const res = await fetch("data/"+fn); if(!res.ok) throw new Error(fn+" "+res.status);
  let u8;
  if(fn.endsWith(".bin")){ u8 = new Uint8Array(await res.arrayBuffer()); loaded += u8.length * 1.33; }   // v26: deflate のバイナリ（base64 をやめて約 25% 小さく）
  else { const txt = await res.text(); loaded += txt.length; const bin = atob(txt.trim()); u8 = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); }
  progress();
  const ds = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
  return await new Response(ds).arrayBuffer();
}
function loadTex(fn){
  return new Promise(res=>new THREE.TextureLoader().load("data/"+fn, t=>{ t.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy()); loaded+=900e3; progress(); res(t); }, undefined, ()=>res(null)));
}
/* ---------------- 時間帯・天気（v16） ----------------
   朝（7時・東から低い日差し）/ 昼 / 夕方（17時半・西日）/ 夜（街灯・窓明かり・前照灯）。天気は 晴れ / 雨（雨筋・路面が濡れて暗く・霧が近い）。
   建物の窓明かりは、写真の外壁でも壁面を 2.6m×3.2m の格子に分けて乱数で一部を灯す（窓の位置は実際とは一致しない）。 */
const Env = (() => {
  const P = {
    morning: { sun:[0.78,0.32,0.30], sunC:0xffd9a8, sunI:0.78, hemi:[0xf4ead8,0x5b5448,0.72], skyL:0xf1e3cf, skyH:0x9dbad6, fog:0xe6ddd0, near:260, far:1600, exp:1.0, night:0 },
    noon:    { sun:[-0.45,0.82,0.38], sunC:0xfff0d8, sunI:0.72, hemi:[0xeef2f5,0x5d574b,0.80], skyL:0xdfe6e8, skyH:0x8fb4d6, fog:0xd6dfe2, near:280, far:1700, exp:1.0, night:0 },
    evening: { sun:[-0.86,0.2,0.1], sunC:0xffa15a, sunI:0.85, hemi:[0xf2c8a8,0x4a3d36,0.55], skyL:0xf3b98a, skyH:0x6d7fa6, fog:0xd9b49a, near:240, far:1500, exp:0.95, night:0.35 },
    night:   { sun:[-0.3,0.7,0.5], sunC:0x8da6d6, sunI:0.12, hemi:[0x40506e,0x14161c,0.32], skyL:0x1a2438, skyH:0x05080f, fog:0x141a26, near:150, far:1100, exp:0.9, night:1 },
  };
  const st = { time:"noon", rain:false };
  const NIGHT_U = { value:0 }, WET_U = { value:0 };
  const patched = new WeakSet();   // v29: 読み込み・解放をくり返すので、捨てた材質を持ち続けない
  // 窓明かり: 鉛直面の世界座標で格子を作り、乱数で灯す（写真の外壁・簡略の外壁の両方）
  function addWindows(m){
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if(prev) prev(sh, r);
      sh.uniforms.uNight = NIGHT_U;
      sh.vertexShader = "varying vec3 vWP; varying vec3 vWN;\n" + sh.vertexShader.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vWP = (modelMatrix * vec4(transformed,1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);");
      sh.fragmentShader = "uniform float uNight; varying vec3 vWP; varying vec3 vWN;\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        if(uNight > 0.01 && abs(vWN.y) < 0.4 && !(vWP.x > 1476.0 && vWP.x < 1521.0 && vWP.z > 19.0 && vWP.z < 49.0)){   // 岡山城の天守は窓明かりでなくライトアップ
          float along = dot(vWP.xz, normalize(vec2(-vWN.z, vWN.x)));
          vec2 cell = vec2(floor(along/2.6), floor((vWP.y-2.0)/3.2));
          vec2 f = vec2(fract(along/2.6), fract((vWP.y-2.0)/3.2));
          float h = fract(sin(dot(cell + floor(vWP.xz*0.02), vec2(12.9898,78.233)))*43758.5453);
          float win = step(0.18,f.x)*step(f.x,0.82)*step(0.3,f.y)*step(f.y,0.85);
          float lit = step(0.58, h) * win * step(0.0, vWP.y-3.0);
          vec3 wc = mix(vec3(1.0,0.76,0.42), vec3(0.62,0.70,0.78), step(0.82,h)) * (0.55 + 0.45*fract(h*13.7));
          totalEmissiveRadiance += wc * lit * uNight * 0.8;
        }`);
    };
    m.needsUpdate = true;
  }
  function patch(m, kind){
    if(patched.has(m)) return; patched.add(m);
    if(kind==="tex" || kind==="texhi" || (kind && kind.startsWith("facade_"))) addWindows(m);
    if(kind==="asphalt" || kind==="trackbed"){ m.userData.baseColor = m.color.clone(); }
    apply1(m, kind);
  }
  function apply1(m, kind){
    const p = P[st.time];
    if(kind==="asphalt" || kind==="trackbed") m.color.copy(m.userData.baseColor).multiplyScalar(st.rain ? 0.72 : 1.0);
    if(kind==="tex" || kind==="texhi"){ m.emissive && m.emissive.setHex(p.night>0.5 ? 0x080808 : 0x161616); }
    if(kind==="vend" || kind==="signs"){ m.emissive && m.emissive.setHex(p.night>0.5 ? 0xdddddd : (kind==="vend"?0x555555:0x2a2a2a)); }
  }
  // ---- 街灯の光（夜・夕方）: 車線に沿って 30m おきの光の粒 ----
  let lamps = null, rain = null, head = null;
  function buildLamps(){
    if(lamps || !Traffic.ready) return;
    const pts = Traffic.segsForLamps();
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const tex = canvasTex(64,64,(c,w,h)=>{ const gr=c.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,"rgba(255,236,190,1)"); gr.addColorStop(0.25,"rgba(255,210,140,0.55)"); gr.addColorStop(1,"rgba(255,200,120,0)"); c.fillStyle=gr; c.fillRect(0,0,w,h); });
    lamps = new THREE.Points(g, new THREE.PointsMaterial({ map:tex, size:7, sizeAttenuation:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:true }));
    lamps.name="streetlamps"; scene.add(lamps);
  }
  function buildRain(){
    const N = 7000, pos = new Float32Array(N*6);
    for(let i=0;i<N;i++){ const x=(Math.random()-0.5)*90, y=Math.random()*40, z=(Math.random()-0.5)*90; pos.set([x,y,z, x+0.05,y-0.9,z+0.05], i*6); }
    const g=new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos,3));
    rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color:0xb8c4d0, transparent:true, opacity:0.45 })); rain.frustumCulled=false; rain.visible=false; scene.add(rain);
  }
  function apply(){
    const p = P[st.time], wet = st.rain;
    SUN_DIR = new THREE.Vector3(...p.sun).normalize();
    sun.color.setHex(p.sunC); sun.intensity = p.sunI * (wet ? 0.35 : 1);
    hemi.color.setHex(p.hemi[0]); hemi.groundColor.setHex(p.hemi[1]); hemi.intensity = p.hemi[2] * (wet ? 0.85 : 1);
    const L = new THREE.Color(p.skyL), H = new THREE.Color(p.skyH);
    if(wet){ const grey = new THREE.Color(p.night>0.5 ? 0x121620 : 0x9aa2aa); L.lerp(grey, 0.7); H.lerp(grey, 0.75); }
    const sky = scene.getObjectByName("sky");
    if(sky){ const g=sky.geometry, pp=g.attributes.position, col=g.attributes.color; for(let i=0;i<pp.count;i++){ const t=Math.max(0,pp.getY(i)/3000); const c=L.clone().lerp(H,Math.pow(t,0.55)); col.setXYZ(i,c.r,c.g,c.b); } col.needsUpdate=true; }
    const fogC = new THREE.Color(p.fog); if(wet) fogC.lerp(new THREE.Color(p.night>0.5?0x10141c:0xa3aab0), 0.6);
    scene.fog.color.copy(fogC); scene.fog.near = wet ? p.near*0.45 : p.near; scene.fog.far = wet ? p.far*0.55 : p.far; scene.background.copy(fogC);
    FOG_BASE.near = scene.fog.near; FOG_BASE.far = scene.fog.far;
    FACADE_UNIFORMS.uSkyTop.value.copy(H); FACADE_UNIFORMS.uSkyHor.value.copy(L);
    NIGHT_U.value = p.night;
    for(const [k, m] of Object.entries(MATS)){ const kind = k.replace(/_\d+$/,""); apply1(m, kind); }
    buildLamps(); if(lamps){ lamps.visible = p.night > 0.3; lamps.material.opacity = p.night; }
    if(!rain) buildRain(); rain.visible = wet;
    // 自分の車・電車の前照灯（夜・雨）
    if(!head){ head = new THREE.SpotLight(0xfff2d8, 0, 90, 0.45, 0.6, 1.2); head.castShadow=false; scene.add(head); scene.add(head.target); }
    head.intensity = (p.night > 0.3 || wet) ? 1.6 : 0;
    const sb=document.querySelectorAll(".time-opt"); sb.forEach(b=>b.classList.toggle("on", b.dataset.time===st.time));
    document.querySelectorAll(".rain-opt").forEach(b=>{ b.classList.toggle("on", st.rain); b.textContent = st.rain ? "天気: 雨" : "天気: 晴れ"; });
  }
  const _v = new THREE.Vector3(), _f = new THREE.Vector3();
  function tick(dt){
    if(rain && rain.visible){ rain.position.copy(camera.position); rain.position.y = camera.position.y - 20 - ((performance.now()/1000*22) % 20); }
    if(head && head.intensity > 0){
      // 前照灯: 車・バスは車体の前、電車は運転台の前
      head.distance = 90;
      if((S.mode==="car"||S.mode==="bus") && Car.C.active){ const C=Car.C, fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), f=Car.P.len/2;
        head.position.set(C.x+fx*f, C.h+0.9, C.z+fz*f); head.target.position.set(C.x+fx*(f+30), C.h, C.z+fz*(f+30)); }
      else if(S.running && S.track){ const p=pointAt(S.pos), t=tangentAt(S.pos); head.position.set(p.x+t.x*0.5, p.y+1.2, p.z+t.z*0.5); head.target.position.set(p.x+t.x*40, p.y, p.z+t.z*40); }
      else if(S.mode==="heli" && Heli.H.active){ const H=Heli.H, fx=Math.sin(H.yaw), fz=Math.cos(H.yaw);   // サーチライト（機首の下から前下方）
        head.position.set(H.x+fx*2, H.y+0.5, H.z+fz*2); head.target.position.set(H.x+fx*(20+H.agl*0.6), H.ground, H.z+fz*(20+H.agl*0.6)); head.distance = 120 + H.agl*1.6; }
      head.target.updateMatrixWorld();
    }
  }
  function set(time, rainOn){ if(time) st.time=time; if(rainOn!==undefined) st.rain=rainOn; apply(); }
  const order=["morning","noon","evening","night"];
  function cycle(){ set(order[(order.indexOf(st.time)+1)%order.length]); }
  return { patch, set, tick, cycle, st, apply, NIGHT_U };
})();

async function loadAll(){
  const [sc, rt] = await Promise.all([fetch("data/scene.json").then(r=>r.json()), fetch("data/routes.json").then(r=>r.json())]);
  S.scene=sc; S.routes=rt; S._atlas = S._atlas || [];   // v22: タイルの読み込み（Stream）が先に始まっても落ちないよう最初に用意
  // v29: 車・信号・歩行者・JR・バス・地名のデータは、地形・建物と並行して先に取り寄せる（範囲拡大で大きくなったため）
  const jget = n => fetch("data/"+n).then(r=>r.ok?r.json():null).catch(e=>{ console.warn(n, e); return null; });
  const JP = { traffic: jget("traffic.json"), signals: jget("signals.json"), peds: jget("peds.json"), jr: jget("jr.json"), bus: jget("bus.json"), places: jget("places.json") };
  // v16: "@" の付いたファイル（建物・植生のタイル）は Stream が近くの分だけ読み込む。それ以外は最初に全部読む
  const core = Object.entries(sc.files).filter(([k])=>!k.includes("@"));
  const OVM = !!sc.ortho_ov;   // v29: 縮小写真＋近くのページだけ（範囲拡大版）
  toLoad = core.reduce((a,[k,f])=>a+f.raw*0.9,0) + (OVM ? 12*900e3 + 4e6 : sc.ortho.length*900e3) + 6e7;
  const bufs = {};
  const texP = OVM ? loadTex(sc.ortho_ov.file).then(t=>{ if(t){ t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy()); OrthoPages.setOverview(t, sc.ortho_ov); } return []; })
                   : Promise.all(sc.ortho.map(o=>loadTex(o.file)));
  await Promise.all(core.map(async ([k,f])=>{ bufs[k]=await fetchPacked(f.file); }));
  const ortho = await texP;
  S._bufs = bufs; S._ortho = ortho;
  if(OrthoPages.active){ await OrthoPages.prime({x:0, z:0}); buildGroundOV(sc.ground, bufs.ground); groundTick({x:0, y:0, z:0}, false, 0, 99); }
  else buildGround(sc.ground, bufs.ground, ortho);
  if(sc.drive && bufs.drive) Car.setGrid(sc.drive, bufs.drive);
  if(sc.hmax && bufs.hmax) Heli.setHmax(sc.hmax, bufs.hmax);
  if(sc.far && bufs.far){ Heli.setFar(sc.far, bufs.far); try { await buildFarTerrain(sc.far, bufs.far); } catch(e){ console.warn("far", e); } }
  buildChunks(sc.chunks.filter(c=>!c.file.includes("@")), bufs, S._atlas, ortho);
  buildWires(sc.wires); if(bufs.pwires) buildPowerWires(new Float32Array(bufs.pwires));
  setVehicle(S.vehicle||"momo");
  // 出発地点（岡山駅前）の周りのタイルを先に読む
  $("start-label").textContent="周りの建物を読み込み中…";
  // v29: 最初は出発地点の近く（700m）だけ読み終わるのを待つ。その先は走り出してから順に読む（範囲拡大で数が多い）
  await Stream.update(0, 0, true, 700);
  let tj=null;
  try { Trams.init(rt); tj = await JP.traffic; if(tj) Traffic.init(tj); } catch(e){ console.warn("traffic", e); }
  try { const sj = await JP.signals; buildSignals(sj, rt); } catch(e){ console.warn("signals", e); }
  try { const pj = await JP.peds; if(pj) Peds.init(pj); } catch(e){ console.warn("peds", e); }
  try { const jj = await JP.jr; if(jj) JR.init(jj); } catch(e){ console.warn("jr", e); }
  try { const [bj, pj] = await Promise.all([JP.bus, JP.places]);
    Loc.init(pj, tj); if(bj) Bus.init(bj); } catch(e){ console.warn("bus/places", e); }
  if(tj){ for(const l of tj.lanes) l.p=null; for(const c of tj.conns) c.p=null; }   // v29: 車線の形は Traffic・Loc の中に作り終えたので、元の JSON の点は捨てる（メモリ）
  buildRoutePicker(); setupRoute(S.key, true);
  Prefs.restore();
  Trams.populate(S.key, S.cum[0]+40, S.vehicle);
  $("loadbar").style.width="100%"; $("start").disabled=false; $("start-label").textContent="運転を開始する";
}

/* ---------------- タイルの読み込み・解放（v16） ----------------
   800m 四方のタイルごとに、建物（写真の外壁 bldg_tex / 簡略の外壁 bldg_proc / その他の建物 bldg_plain）と植生（veg）。
   近く（NEAR 以内）: 写真表示なら bldg_tex＋そのタイルのアトラス、植生も。遠く（FAR 以内）: 軽い bldg_proc と bldg_plain だけ。
   さらに離れたら解放（ジオメトリ・テクスチャを捨てる）。 */
const Stream = (() => {
  const NEAR = 650, FAR = 1600, HYST = 250;
  const loaded = new Map();    // fileKey -> {meshes:[], tile}
  const loading = new Map();   // fileKey -> Promise
  const pageRef = new Map();   // atlas page -> 参照数
  let busy = false, lastT = 0;
  function tileDist(t, x, z){ const T=S.scene.tiles[t]; const dx=Math.max(T.x0-x, 0, x-(T.x0+T.size)), dz=Math.max(T.z0-z, 0, z-(T.z0+T.size)); return Math.hypot(dx,dz); }
  // v17: ヘリで高く上がると遠くまで読む（R.near/R.far/R.veg/R.detail を足す）
  const R = { near:0, far:0, veg:0, detail:0 };
  const PRI = fk => fk.startsWith("road") ? 0 : fk.startsWith("bldg_tex") ? 1 : 2;   // v29
  function wanted(x, z, slack){
    const w = new Set(), photo = S.look==="photo";
    for(const t of Object.keys(S.scene.tiles||{})){
      const d = tileDist(t, x, z);
      const near = d < NEAR + R.near + slack, far = d < FAR + R.far + slack;
      if(!far) continue;
      w.add("bldg_plain@"+t);
      if(near && photo) w.add("bldg_tex@"+t); else w.add("bldg_proc@"+t);
      if(d < NEAR + R.veg + slack) w.add("veg@"+t);
      if(d < NEAR + R.detail + slack) w.add("detail@"+t);
      w.add("road@"+t);                                   // v29: 道路（路面・縁石・標示）は建物と同じ範囲
      if(d < NEAR + 600 + R.far * 0.3 + slack) w.add("cat@"+t);   // v29: 架線柱・バス停の柱など
    }
    return w;
  }
  async function loadPages(pages){
    await Promise.all(pages.map(async p=>{
      pageRef.set(p, (pageRef.get(p)||0)+1);
      if(!S._atlas[p]) S._atlas[p] = loadTex(S.scene.atlas[p]);
      S._atlas[p] = await S._atlas[p];
    }));
  }
  function releasePages(pages){
    for(const p of pages){ const n=(pageRef.get(p)||1)-1; pageRef.set(p,n);
      if(n<=0){ const t=S._atlas[p]; if(t && t.dispose) t.dispose(); delete S._atlas[p]; const m=MATS["tex_"+p]; if(m){ m.dispose(); delete MATS["tex_"+p]; } } }
  }
  async function load(fk){
    const f = S.scene.files[fk]; if(!f) return;
    const buf = await fetchPacked(f.file);
    const chunks = S.scene.chunks.filter(c=>c.file===fk);
    const pages = [...new Set(chunks.filter(c=>c.page!==undefined && c.mat==="tex").map(c=>c.page))];
    if(pages.length) await loadPages(pages);
    const before = world.children.length;
    buildChunks(chunks, {[fk]:buf}, S._atlas, S._ortho);
    const meshes = world.children.slice(before);
    loaded.set(fk, {meshes, pages});
  }
  function unload(fk){
    const e = loaded.get(fk); if(!e) return;
    for(const m of e.meshes){ world.remove(m); m.geometry.dispose(); OrthoPages.unreg(m); }
    if(e.pages.length) releasePages(e.pages);
    loaded.delete(fk);
  }
  // x,z の周りを読み込む（wait=true なら全部読み終わるまで待つ）
  async function update(x, z, wait, waitDist){
    if(!S.scene || !S.scene.tiles) return;
    const want = wanted(x, z, 0), keep = wanted(x, z, HYST);
    for(const fk of [...loaded.keys()]) if(!keep.has(fk)) unload(fk);
    // 近いものから
    const todo = [...want].filter(fk=>!loaded.has(fk) && !loading.has(fk) && S.scene.files[fk])
      .sort((a,b)=>tileDist(a.split("@")[1],x,z)-tileDist(b.split("@")[1],x,z) || (PRI(a)-PRI(b)));
    const run = async (fk)=>{ const pr = load(fk).catch(e=>console.warn("tile", fk, e)).finally(()=>loading.delete(fk)); loading.set(fk, pr); return pr; };
    if(wait){
      const now_ = waitDist ? todo.filter(fk=>tileDist(fk.split("@")[1],x,z) < waitDist) : todo;   // v29: 近いものだけ待つ（残りは tick で）
      for(let i=0;i<now_.length;i+=3) await Promise.all(now_.slice(i,i+3).map(run)); return; }
    let n = loading.size;
    for(const fk of todo){ if(n>=2) break; run(fk); n++; }
  }
  // 毎フレーム呼ぶ（0.5 秒ごとに判定）
  const _fp = {x:0, z:0};
  function tick(){
    const now=performance.now(); if(now-lastT<500) return; lastT=now;
    const c = camera.position, heli = S.mode==="heli" && Heli.H.active;
    const agl = heli ? Math.max(0, Heli.H.agl) : 0;
    R.near = heli ? Math.min(250, agl*0.5) : 0; R.far = heli ? Math.min(3200, agl*4) : 0;
    R.veg = heli ? Math.min(350, agl*0.8) : 0; R.detail = heli ? -Math.min(400, agl*2) : 0;
    const p = heli ? Heli.focus(_fp) : c;
    update(p.x, p.z, false);
    const gy = heli ? Heli.H.ground : 0;
    if(OrthoPages.active){ OrthoPages.tick(c, heli ? (c.y-gy)*0.7 : 0, agl); groundTick(c, heli, gy, 1); }
    else for(const T of GROUND_TILES){ const dx=Math.max(T.x0-c.x,0,c.x-(T.x0+T.size)), dz=Math.max(T.z0-c.z,0,c.z-(T.z0+T.size)); const near=Math.hypot(dx,dz, heli ? (c.y-gy)*0.7 : 0)<700;
      for(const m of T.hi) m.visible=near; for(const m of T.lo) m.visible=!near; }
    // 電線（v17）: 近くのタイルだけ・高い所からは出さない（遠くで黒い筋になっていた）
    for(const W of PWIRES){ const dx=Math.max(W.x0-c.x,0,c.x-(W.x0+W.size)), dz=Math.max(W.z0-c.z,0,c.z-(W.z0+W.size)); W.obj.visible = Math.hypot(dx,dz) < 380 && c.y - (heli ? gy : 0) < 160; }
  }
  return { update, tick, R, get loaded(){ return loaded; } };
})();

/* 建物の外観の切替（写真 ⇄ 簡略）。タイルの読み込みで入れ替える */
async function setLook(look){
  S.look=look; if(!S.scene) return;
  const p = camera.position; Stream.update(p.x, p.z, false);
}
/* ---------------- v17: 遠景の地形（地図の範囲の外・国土地理院の標高と写真。約 20km 四方） ----------------
   範囲の内側（データのある所）は穴にして、縁は 4m 下げて手前の地面の下にもぐらせる（段差・ちらつきを出さない）。 */
async function buildFarTerrain(meta, buf){
  const A = new Int16Array(buf), nx = meta.nx, nz = meta.nz, st = meta.step;
  const tex = await loadTex(meta.tex); if(!tex) return; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const [hx0, hz0, hx1, hz1] = meta.hole, W = st * (nx - 1), D = st * (nz - 1);
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  for(let j = 0; j < nz; j++) for(let i = 0; i < nx; i++){
    const k = j * nx + i, x = meta.x0 + i * st, z = meta.z0 + j * st, inside = x > hx0 && x < hx1 && z > hz0 && z < hz1;
    pos[k * 3] = x; pos[k * 3 + 1] = A[k] / 10 - (inside ? 4 : 0.3); pos[k * 3 + 2] = z;
    uv[k * 2] = (x - meta.x0) / W; uv[k * 2 + 1] = 1 - (z - meta.z0) / D;
  }
  const idx = [], m = st * 1.05;
  for(let j = 0; j < nz - 1; j++) for(let i = 0; i < nx - 1; i++){
    const x0 = meta.x0 + i * st, z0 = meta.z0 + j * st;
    if(x0 > hx0 + m && x0 + st < hx1 - m && z0 > hz0 + m && z0 + st < hz1 - m) continue;   // データのある所は穴
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex })); mesh.name = "farTerrain"; mesh.receiveShadow = false; mesh.renderOrder = -0.5;
  scene.add(mesh);
}
/* ---------------- 地面（標高 + 航空写真） ---------------- */
const GROUND_TILES = [];   // v16: 地面は 800m 四方ごと・細かい(4m)と粗い(16m)の 2 段。近くだけ細かい方を表示
/* v29: 範囲拡大版の地面。粗い(16m)面は最初に全部（範囲全体の縮小写真）、細かい(4m)面は近づいたタイルだけ作り、離れたら捨てる */
const GROUND_NEAR = 1100, GROUND_DROP = 1450;
let _gb = null;
function buildGroundOV(g, buf){
  const nx=g.nx, nz=g.nz, N=nx*nz;
  const H=new Int16Array(buf,0,N), MK=new Uint8Array(buf,N*4,N), RD=new Uint8Array(buf,N*3,N), W=new Uint8Array(buf,N*2,N);
  const pages = S.scene.ortho, OV = OrthoPages.OV;
  const h = (j,i)=>{ j=Math.min(nz-1,j); i=Math.min(nx-1,i); const k=j*nx+i; return H[k]/100 - (RD[k]?0.35:0.12) - (W[k]?0.25:0); };
  const pageOf=(cx,cz)=>{ for(let q=0;q<pages.length;q++){ const p=pages[q]; if(cx>=p.x0&&cx<p.x0+p.size&&cz>=p.z0&&cz<p.z0+p.size) return q; } return -1; };
  const TS=800, cellsPer=Math.round(TS/g.step);
  const mk = (cells, U, V, st)=>{
    const n=cells.length/2; const pos=new Float32Array(n*18), uv=new Float32Array(n*12); let o=0,u=0;
    for(let c=0;c<cells.length;c+=2){
      const j=cells[c], i=cells[c+1];
      const x0=g.x0+i*g.step, z0=g.z0+j*g.step, x1=x0+g.step*st, z1=z0+g.step*st;
      const a=h(j,i), b=h(j,i+st), cc=h(j+st,i), d=h(j+st,i+st);
      pos.set([x0,a,z0, x0,cc,z1, x1,b,z0, x1,b,z0, x0,cc,z1, x1,d,z1], o); o+=18;
      uv.set([U(x0),V(z0), U(x0),V(z1), U(x1),V(z0), U(x1),V(z0), U(x0),V(z1), U(x1),V(z1)], u); u+=12;
    }
    const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
    geo.setAttribute("uv",new THREE.BufferAttribute(uv,2));
    geo.computeVertexNormals(); geo.computeBoundingSphere();
    return geo;
  };
  const ovMat = new THREE.MeshLambertMaterial({map:OrthoPages.ovTex});
  const U0=x=>(x-OV.x0)/OV.w, V0=z=>1-(z-OV.z0)/OV.d;
  for(let tj=0; tj<nz-1; tj+=cellsPer) for(let ti=0; ti<nx-1; ti+=cellsPer){
    const T={x0:g.x0+ti*g.step, z0:g.z0+tj*g.step, size:TS, ti, tj, hi:null, lo:[]};
    const cells=[];
    for(let j=tj;j<Math.min(nz-1,tj+cellsPer);j+=4) for(let i=ti;i<Math.min(nx-1,ti+cellsPer);i+=4){ if(MK[j*nx+i]) cells.push(j,i); }
    if(cells.length){ const m=new THREE.Mesh(mk(cells, U0, V0, 4), ovMat); m.name="ground"; m.receiveShadow=true; world.add(m); T.lo.push(m); }
    GROUND_TILES.push(T);
  }
  // 近くの細かい面（ページごとに分ける。ページが無い間は縮小写真を同じ位置に貼る）
  function buildHi(T){
    const groups=new Map();
    for(let j=T.tj;j<Math.min(nz-1,T.tj+cellsPer);j++) for(let i=T.ti;i<Math.min(nx-1,T.ti+cellsPer);i++){
      const k=j*nx+i; if(!MK[k]) continue;
      const q=pageOf(g.x0+(i+0.5)*g.step, g.z0+(j+0.5)*g.step); if(q<0) continue;
      let a=groups.get(q); if(!a){ a=[]; groups.set(q,a); } a.push(j,i);
    }
    T.hi=[];
    for(const [q,cells] of groups){ const p=pages[q];
      const m=new THREE.Mesh(mk(cells, x=>(x-p.x0)/p.size, z=>1-(z-p.z0)/p.size, 1), OrthoPages.mat(q, "ground"));
      OrthoPages.reg(m, q, "ground"); m.name="ground"; m.receiveShadow=true; m.visible=false; world.add(m); T.hi.push(m); }
  }
  function dropHi(T){ for(const m of T.hi){ world.remove(m); m.geometry.dispose(); OrthoPages.unreg(m); } T.hi=null; }
  _gb = { buildHi, dropHi };
  // 水面（v11）: buildGround と同じ
  buildWater(g, buf);
}
/* v29: 近くのタイルの細かい地面を作る・捨てる（budget: 1 回に作るタイルの数） */
function groundTick(c, heli, gy, budget){
  if(!_gb) return;
  const lift = heli ? (c.y-gy)*0.7 : 0;
  const L = GROUND_TILES.map(T=>{ const dx=Math.max(T.x0-c.x,0,c.x-(T.x0+T.size)), dz=Math.max(T.z0-c.z,0,c.z-(T.z0+T.size)); return [T, Math.hypot(dx,dz,lift)]; }).sort((a,b)=>a[1]-b[1]);
  for(const [T,d] of L){
    if(d<GROUND_NEAR && !T.hi && budget>0){ _gb.buildHi(T); budget--; }
    if(T.hi && d>GROUND_DROP){ _gb.dropHi(T); }
    const near = !!T.hi && d<GROUND_NEAR;
    if(T.hi) for(const m of T.hi) m.visible=near;
    for(const m of T.lo) m.visible=!near;
  }
}
function buildGround(g, buf, ortho){
  const nx=g.nx, nz=g.nz, N=nx*nz;
  const H=new Int16Array(buf,0,N), W=new Uint8Array(buf,N*2,N), RD=new Uint8Array(buf,N*3,N), MK=new Uint8Array(buf,N*4,N);
  const pages = S.scene.ortho;
  const h = (j,i)=>{ j=Math.min(nz-1,j); i=Math.min(nx-1,i); const k=j*nx+i; return H[k]/100 - (RD[k]?0.35:0.12) - (W[k]?0.25:0); };
  const pageOf=(cx,cz)=>{ for(let q=0;q<pages.length;q++){ const p=pages[q]; if(cx>=p.x0&&cx<p.x0+p.size&&cz>=p.z0&&cz<p.z0+p.size) return q; } return -1; };
  const TS=800, cellsPer=Math.round(TS/g.step);
  const mk = (cells, page, st)=>{
    const n=cells.length/2; const pos=new Float32Array(n*18), uv=new Float32Array(n*12); let o=0,u=0;
    for(let c=0;c<cells.length;c+=2){
      const j=cells[c], i=cells[c+1];
      const x0=g.x0+i*g.step, z0=g.z0+j*g.step, x1=x0+g.step*st, z1=z0+g.step*st;
      const a=h(j,i), b=h(j,i+st), cc=h(j+st,i), d=h(j+st,i+st);
      pos.set([x0,a,z0, x0,cc,z1, x1,b,z0, x1,b,z0, x0,cc,z1, x1,d,z1], o); o+=18;
      if(page){ const U=x=>(x-page.x0)/page.size, V=z=>1-(z-page.z0)/page.size;
        uv.set([U(x0),V(z0), U(x0),V(z1), U(x1),V(z0), U(x1),V(z0), U(x0),V(z1), U(x1),V(z1)], u); u+=12; }
    }
    const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
    if(page) geo.setAttribute("uv",new THREE.BufferAttribute(uv,2));
    geo.computeVertexNormals();
    return geo;
  };
  const mats = pages.map((p,q)=>new THREE.MeshLambertMaterial({map:ortho[q]||null, color: ortho[q]?0xffffff:0x777a70}));
  const other = new THREE.MeshLambertMaterial({color:0x767a6e});
  for(let tj=0; tj<nz-1; tj+=cellsPer) for(let ti=0; ti<nx-1; ti+=cellsPer){
    const T={x0:g.x0+ti*g.step, z0:g.z0+tj*g.step, size:TS, hi:[], lo:[]};
    for(const [st, list] of [[1,T.hi],[4,T.lo]]){
      const groups=new Map();
      for(let j=tj;j<Math.min(nz-1,tj+cellsPer);j+=st) for(let i=ti;i<Math.min(nx-1,ti+cellsPer);i+=st){
        const k=j*nx+i; if(!MK[k]) continue;
        const q=pageOf(g.x0+(i+st/2)*g.step, g.z0+(j+st/2)*g.step);
        let a=groups.get(q); if(!a){ a=[]; groups.set(q,a); } a.push(j,i);
      }
      for(const [q,cells] of groups){ const m=new THREE.Mesh(mk(cells, q>=0?pages[q]:null, st), q>=0?mats[q]:other); m.name="ground"; m.receiveShadow=true; m.visible = st===4; world.add(m); list.push(m); }
    }
    GROUND_TILES.push(T);
  }
  world.children.forEach(o=>{ if(o.name==="ground") o.receiveShadow=true; });
  buildWater(g, buf);
}
function buildWater(g, buf){
  const nx=g.nx, nz=g.nz, N=nx*nz;
  // 水面（v11）: 川・池。水位は OSM の水域内の地形を平滑化した値（ビルド時）
  if(buf.byteLength >= N*7){
    const WL = (N*5) % 2 === 0 ? new Int16Array(buf, N*5, N) : new Int16Array(buf.slice(N*5, N*7));   // v29: 升目の数が奇数だと位置が 2 の倍数にならない
    S._WL = { x0:g.x0, z0:g.z0, step:g.step, nx, nz, A:WL };   // v17: ヘリが水面に降りないように
    const cells=[]; for(let j=0;j<nz-1;j++) for(let i=0;i<nx-1;i++){ const k=j*nx+i; if(WL[k]!==-32768) cells.push(j,i); }
    if(cells.length){
      const n=cells.length/2, pos=new Float32Array(n*18); let o=0;
      const lv=(j,i,f)=>{ const k=j*nx+i; return WL[k]!==-32768 ? WL[k]/100 : f; };
      for(let c=0;c<cells.length;c+=2){ const j=cells[c], i=cells[c+1], y=WL[j*nx+i]/100;
        const x0=g.x0+i*g.step, z0=g.z0+j*g.step, x1=x0+g.step, z1=z0+g.step;
        pos.set([x0,lv(j,i,y),z0, x0,lv(j+1,i,y),z1, x1,lv(j,i+1,y),z0, x1,lv(j,i+1,y),z0, x0,lv(j+1,i,y),z1, x1,lv(j+1,i+1,y),z1], o); o+=18; }
      const geo=new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos,3));
      const uv=new Float32Array(n*12); for(let q=0;q<n*6;q++){ uv[q*2]=pos[q*3]/18; uv[q*2+1]=pos[q*3+2]/18; } geo.setAttribute("uv", new THREE.BufferAttribute(uv,2));
      geo.computeVertexNormals();
      const nrm=canvasTex(256,256,(gg,w,h)=>{ const im=gg.createImageData(w,h); for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const a=Math.sin(x*0.19+Math.sin(y*0.07)*2.0)*0.5+Math.sin((x+y)*0.11)*0.3+Math.sin(y*0.23-x*0.05)*0.2;
          const b=Math.cos(y*0.17+Math.sin(x*0.09)*1.7)*0.5+Math.cos((x-y)*0.13)*0.3; const k=(y*w+x)*4; im.data[k]=128+a*40; im.data[k+1]=128+b*40; im.data[k+2]=255; im.data[k+3]=255; } gg.putImageData(im,0,0); });
      const wm=new THREE.MeshPhongMaterial({color:0x33545c, specular:0xb8c8d0, shininess:120, normalMap:nrm, normalScale:new THREE.Vector2(0.35,0.35), transparent:true, opacity:0.9, depthWrite:true});
      const water=new THREE.Mesh(geo, wm); water.name="water"; water.receiveShadow=true; world.add(water); S._waterTex=nrm;
    }
  }
}

/* ---------------- v26: 写真の外壁を近くで見た時の粗さを和らげる（写真そのものは変えない） ----------------
   ・輪郭の強調（アンシャープマスク）: 周り 4 画素との差を足す。カメラから 30m 以内で最大、150m で 0
   ・細かなむら: 近く（10〜70m）だけ、壁の上に 25cm 程度の明るさのむら（±4%）を重ねる（コンクリート・タイルの質感）
   どちらも表示の時の計算だけで、写真のデータ（画質）は元のまま */
const FACADE_U = { uSharp: { value: 0.6 }, uGrain: { value: 0.045 } };
// v26: 近景（元の解像度の写真）を読み込んだ 200m の升目。遠景用のアトラスの建物は、その升目のものを描かない（頂点色に升目の番号）
const HIMASK = (() => { const d = new Uint8Array(32 * 32 * 4); const t = new THREE.DataTexture(d, 32, 32, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return { d, t }; })();
function sharpFacade(m, far){
  m.customProgramCacheKey = () => "sharpFacade_" + (far ? 1 : 0);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    if(prev) prev(sh, r);
    sh.uniforms.uSharp = FACADE_U.uSharp; sh.uniforms.uGrain = FACADE_U.uGrain; sh.uniforms.uHiMask = { value: HIMASK.t };
    sh.vertexShader = "varying vec3 vDW;" + (far ? " attribute vec3 color; varying vec3 vHC;" : "") + "\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n vDW = (modelMatrix * vec4(transformed, 1.0)).xyz;" + (far ? " vHC = color;" : ""));
    sh.fragmentShader = "uniform float uSharp; uniform float uGrain; uniform sampler2D uHiMask; varying vec3 vDW;" + (far ? " varying vec3 vHC;" : "") + "\n" +
      "float fHash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }\n" +
      "float fNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);\n" +
      "  return mix(mix(mix(fHash(i), fHash(i+vec3(1,0,0)), f.x), mix(fHash(i+vec3(0,1,0)), fHash(i+vec3(1,1,0)), f.x), f.y),\n" +
      "             mix(mix(fHash(i+vec3(0,0,1)), fHash(i+vec3(1,0,1)), f.x), mix(fHash(i+vec3(0,1,1)), fHash(i+vec3(1,1,1)), f.x), f.y), f.z); }\n" +
      sh.fragmentShader.replace("#include <map_fragment>", (far ? `if(vHC.z > 0.5 && texture2D(uHiMask, (floor(vHC.xy * 255.0 + 0.5) + 0.5) / 32.0).r > 0.5) discard;\n` : ``) + `#ifdef USE_MAP
        vec4 texelColor = texture2D( map, vUv );
        float dCam = length(vDW - cameraPosition);
        float kS = uSharp * clamp(1.0 - (dCam - 30.0) / 120.0, 0.0, 1.0);
        if(kS > 0.001){
          vec2 px = vec2(1.0 / 2048.0);
          vec3 nb = texture2D(map, vUv + vec2(px.x, 0.0)).rgb + texture2D(map, vUv - vec2(px.x, 0.0)).rgb
                  + texture2D(map, vUv + vec2(0.0, px.y)).rgb + texture2D(map, vUv - vec2(0.0, px.y)).rgb;
          texelColor.rgb = clamp(texelColor.rgb + kS * (texelColor.rgb - nb * 0.25), 0.0, 1.0);
        }
        float kD = clamp(1.0 - (dCam - 10.0) / 60.0, 0.0, 1.0);
        if(kD > 0.001){ float n = fNoise(vDW * 4.0) * 0.6 + fNoise(vDW * 11.0) * 0.4; texelColor.rgb *= 1.0 + (n - 0.5) * 2.0 * uGrain * kD; }
        texelColor = mapTexelToLinear( texelColor );
        diffuseColor *= texelColor;
      #endif`).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        // v27: 岡山城の天守のライトアップ（毎日 日没〜24時・白色。夜・夕方に、壁を下から照らしたように明るく）
        if(uNightC > 0.01 && vDW.x > 1476.0 && vDW.x < 1521.0 && vDW.z > 19.0 && vDW.z < 49.0 && vDW.y > 11.0){
          float up = clamp(1.0 - (vDW.y - 14.0) / 34.0, 0.35, 1.0);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.97, 0.9) * uNightC * 1.25 * up;
        }`);
    sh.uniforms.uNightC = Env.NIGHT_U;
    sh.fragmentShader = "uniform float uNightC;\n" + sh.fragmentShader;
  };
}
/* ---------------- チャンク ---------------- */
const MATS = {};
/* v26: 近景の外壁写真（元の解像度）の読み込み: カメラから 140m 以内の 200m 升目（高い所では読まない）。遠ざかったら解放 */
const HiStream = (() => {
  const loaded = new Map(), loading = new Set(); let lastT = 0, enabled = true; const R_IN = 140, R_OUT = 230;
  function dist(c, x, z){ const dx = Math.max(c.x0 - x, 0, x - (c.x0 + c.size)), dz = Math.max(c.z0 - z, 0, z - (c.z0 + c.size)); return Math.hypot(dx, dz); }
  function setMask(key, on){ const [i, j] = key.split("_").map(Number); if(i < 0 || j < 0 || i >= 32 || j >= 32) return; HIMASK.d[(j * 32 + i) * 4] = on ? 255 : 0; HIMASK.t.needsUpdate = true; }
  const bufs = new Map();     // 形のファイル（800m のタイルごと）→ 読み込んだ中身
  async function load(key){
    const c = S.scene.hicells[key], f = S.scene.files[c.file]; if(!f) return;
    if(!bufs.has(c.file)) bufs.set(c.file, fetchPacked(f.file));
    const buf = await bufs.get(c.file);
    const pages = c.pages, ps = new Set(pages); S._hiAtlas = S._hiAtlas || [];
    await Promise.all(pages.map(async p => { if(!S._hiAtlas[p]) S._hiAtlas[p] = await loadTex(S.scene.hiatlas[p]); }));
    const chunks = S.scene.chunks.filter(q => q.file === c.file && ps.has(q.page));
    const before = world.children.length;
    buildChunks(chunks, { [c.file]: buf }, S._hiAtlas, S._ortho);
    loaded.set(key, { meshes: world.children.slice(before), pages });
    setMask(key, true);
  }
  function unload(key){
    const e = loaded.get(key); if(!e) return;
    setMask(key, false);
    for(const m of e.meshes){ world.remove(m); m.geometry.dispose(); }
    for(const p of e.pages){ const t = S._hiAtlas[p]; if(t && t.dispose) t.dispose(); delete S._hiAtlas[p]; const m = MATS["texhi_" + p]; if(m){ m.dispose(); delete MATS["texhi_" + p]; } }
    loaded.delete(key);
    const file = S.scene.hicells[key].file;
    if(![...loaded.keys()].some(k => S.scene.hicells[k].file === file)) bufs.delete(file);
  }
  function tick(){
    if(!S.scene || !S.scene.hicells) return;
    const now = performance.now(); if(now - lastT < 400) return; lastT = now;
    const cam = camera.position, heli = S.mode === "heli" && Heli.H.active, photo = S.look === "photo";
    const high = (heli && Heli.H.agl > 90) || !enabled;
    for(const key of [...loaded.keys()]) if(!photo || high || dist(S.scene.hicells[key], cam.x, cam.z) > R_OUT) unload(key);
    if(!photo || high) return;
    const want = Object.keys(S.scene.hicells).map(k => [k, dist(S.scene.hicells[k], cam.x, cam.z)]).filter(q => q[1] < R_IN && !loaded.has(q[0]) && !loading.has(q[0])).sort((a, b) => a[1] - b[1]);
    if(want.length && loading.size < 1){ const key = want[0][0]; loading.add(key); load(key).catch(e => console.warn("hi", key, e)).finally(() => loading.delete(key)); }
  }
  return { tick, get loaded(){ return loaded; }, set enabled(v){ enabled = v; lastT = 0; } };
})();
function mat(c, atlas, ortho){
  const key = c.mat + (c.page!==undefined? "_"+c.page : "");
  if(MATS[key]) return MATS[key];
  let m;
  const off = {polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-2};
  switch(c.mat){
    case "tex": m = new THREE.MeshLambertMaterial({map:atlas[c.page], emissive:0x161616, emissiveMap:atlas[c.page]}); sharpFacade(m, true); break;
    case "texhi": m = new THREE.MeshLambertMaterial({map:atlas[c.page], emissive:0x161616, emissiveMap:atlas[c.page]}); sharpFacade(m, false); break;
    case "ortho": m = new THREE.MeshLambertMaterial({map:ortho[c.page], emissive:0x1c1c1c, emissiveMap:ortho[c.page]}); break;
    case "asphalt": case "paving": case "island": case "grass": case "trackbed":
      m = new THREE.MeshLambertMaterial({map:TEX[c.mat], vertexColors:true}); break;
    case "paint": m = new THREE.MeshLambertMaterial({vertexColors:true, polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-8}); break;
    case "rail": m = new THREE.MeshPhongMaterial({vertexColors:true, shininess:60, specular:0x666666, polygonOffset:true, polygonOffsetFactor:-3, polygonOffsetUnits:-6}); break;
    case "fence": m = new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide}); break;
    case "leaf": m = new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide}); break;
    case "vend": m = new THREE.MeshLambertMaterial({map:vendTex(), side:THREE.DoubleSide, emissive:0x555555, emissiveMap:vendTex()}); break;
    case "signs": m = new THREE.MeshLambertMaterial({map:signsTex(), side:THREE.DoubleSide, emissive:0x2a2a2a, emissiveMap:signsTex()}); break;
    case "arcroof": m = new THREE.MeshPhongMaterial({vertexColors:true, map:arcRoofTex(), side:THREE.DoubleSide, transparent:true, opacity:0.78, shininess:80, specular:0xb8c4cc, emissive:0x303234, depthWrite:false}); break;
    case "wafu": m = new THREE.MeshLambertMaterial({map:wafuTex(), side:THREE.DoubleSide}); break;
    case "kawara": m = new THREE.MeshLambertMaterial({map:kawaraTex(), vertexColors:true, side:THREE.DoubleSide}); break;
    case "ishigaki": m = new THREE.MeshLambertMaterial({map:ishigakiTex(), side:THREE.DoubleSide});
      // v27: 夜は天守の近くの石垣も照らす
      m.onBeforeCompile = (sh) => { sh.uniforms.uNightC = Env.NIGHT_U;
        sh.vertexShader = "varying vec3 vIW;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n vIW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        sh.fragmentShader = "uniform float uNightC; varying vec3 vIW;\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          float dC = length(vIW.xz - vec2(1498.0, 35.0));
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.95, 0.85) * uNightC * 0.9 * clamp(1.0 - (dC - 30.0) / 60.0, 0.0, 1.0);`); };
      break;
    case "gold": m = new THREE.MeshPhongMaterial({color:0xe0b04a, specular:0xfff2c0, shininess:90, emissive:0x3a2600, side:THREE.DoubleSide}); break;
    case "stationsign": m = new THREE.MeshLambertMaterial({map:(()=>{ const t=stationSignTex(); t.repeat.x=-1; t.offset.x=1; return t; })(), polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-4}); break;
    default:
      if(c.mat.startsWith("facade_")){ m=facadeMaterial(c.mat.slice(7)); }
      else m = new THREE.MeshLambertMaterial({vertexColors:true});
  }
  if(c.layer==="track" && c.mat!=="rail") Object.assign(m, off);
  Env.patch(m, c.mat); MATS[key]=m; return m;
}
function buildChunks(chunks, bufs, atlas, ortho){
  for(const c of chunks){
    if(c.layer==="signal") continue;   // v19: 信号機は車線の信号データから画面側で作る（buildSignalsFromTraffic）
    const buf=bufs[c.file]; if(!buf) continue; const geo=new THREE.BufferGeometry();
    const q=new Int16Array(buf, c.pos, c.count*3);
    geo.setAttribute("position", new THREE.BufferAttribute(q,3));
    const tm = TEX_SCALE[c.mat];
    if(c.uvi!==undefined) geo.setAttribute("uv", new THREE.BufferAttribute(new Int16Array(buf,c.uvi,c.count*2),2,false));
    else if(c.uv!==undefined) geo.setAttribute("uv", new THREE.BufferAttribute(new Uint16Array(buf,c.uv,c.count*2),2,true));
    else if(tm){ // 路面材質は世界座標で UV
      const uv=new Float32Array(c.count*2);
      for(let i=0;i<c.count;i++){ uv[i*2]=(c.origin[0]+q[i*3]*c.scale)/tm; uv[i*2+1]=(c.origin[2]+q[i*3+2]*c.scale)/tm; }
      geo.setAttribute("uv", new THREE.BufferAttribute(uv,2));
    }
    if(c.col!==undefined){ const ib=new THREE.InterleavedBuffer(new Uint8Array(buf,c.col,c.count*4),4); geo.setAttribute("color", new THREE.InterleavedBufferAttribute(ib,3,0,true)); }
    if(c.nrm!==undefined){ const ib=new THREE.InterleavedBuffer(new Int8Array(buf,c.nrm,c.count*4),4); geo.setAttribute("normal", new THREE.InterleavedBufferAttribute(ib,3,0,true)); }
    else geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const OPG = c.mat==="ortho" && OrthoPages.active;   // v29: 屋根の写真はページの読み込みに合わせて差し替える
    const mesh=new THREE.Mesh(geo, OPG ? OrthoPages.mat(c.page, "roof") : mat(c,atlas,ortho));
    if(OPG) OrthoPages.reg(mesh, c.page, "roof");
    mesh.position.set(c.origin[0],c.origin[1],c.origin[2]); mesh.scale.setScalar(c.scale);
    mesh.matrixAutoUpdate=false; mesh.updateMatrix(); mesh.name=c.layer; mesh.userData.file=c.file;
    mesh.receiveShadow = true; mesh.castShadow = /^(bldg|veg|frn|bridge|signal|stop|wire)$/.test(c.layer);
    world.add(mesh);
  }
}
/* v16: 自動販売機の前面（4 種）と袖看板（4×4 種。店名ではなく業種の一般名だけ） */
let _vendT=null, _signT=null;
function vendTex(){
  if(_vendT) return _vendT;
  _vendT = canvasTex(512,256,(g,w,h)=>{
    const body=["#c8272d","#1f5fae","#f2f2ee","#2e8a52"];
    for(let k=0;k<4;k++){ const x0=k*128;
      g.fillStyle=body[k]; g.fillRect(x0,0,128,h);
      g.fillStyle="#e9f1f6"; g.fillRect(x0+8,18,112,118);                       // 見本の窓
      const cols=["#d33","#fa3","#3a6","#36c","#eee","#963","#c3c","#39c"];
      for(let r=0;r<3;r++) for(let c=0;c<6;c++){ g.fillStyle=cols[(r*6+c+k*3)%cols.length]; g.fillRect(x0+13+c*18,24+r*38,11,26); g.fillStyle="#fff"; g.fillRect(x0+14+c*18,24+r*38,3,26); }
      for(let r=0;r<3;r++) for(let c=0;c<6;c++){ g.fillStyle="#2c2"; g.fillRect(x0+15+c*18,52+r*38,6,3); }
      g.fillStyle="#1b1b1b"; g.fillRect(x0+80,150,32,40); g.fillStyle="#444"; g.fillRect(x0+20,210,88,22);   // 投入口・取出口
      g.fillStyle=k===2?"#1f5fae":"#fff"; g.font="bold 15px sans-serif"; g.fillText("つめた〜い", x0+14, 170);
    } });
  _vendT.wrapS=_vendT.wrapT=THREE.ClampToEdgeWrapping; return _vendT;
}
function signsTex(){
  if(_signT) return _signT;
  const words=["ラーメン","居酒屋","喫茶","薬","歯科","美容室","不動産","焼肉","うどん","書店","眼科","カラオケ","寿司","ホテル","学習塾","整骨院"];
  const bg=["#b3261e","#1d3f86","#f4efe2","#2d6a3e","#f0c419","#222","#7a3d9a","#e86a1c"];
  _signT = canvasTex(1024,1024,(g,w,h)=>{
    for(let k=0;k<16;k++){ const x0=(k%4)*256, y0=(3-Math.floor(k/4))*256, b=bg[k%bg.length];
      g.fillStyle=b; g.fillRect(x0,y0,256,256); g.strokeStyle="rgba(255,255,255,.85)"; g.lineWidth=8; g.strokeRect(x0+10,y0+10,236,236);
      const dark = b==="#f4efe2"||b==="#f0c419"; g.fillStyle=dark?"#1b1b1b":"#fff";
      // 縦書き（上から下）。看板の面は 幅 0.75m × 高さ 約 3m に 1 マス（256×256）を貼るので、縦を 1/4 に縮めて描く（貼ると正方形の字になる）
      const t=words[k]; const n=t.length, sM=Math.min(0.6, 2.5/n), fs=Math.floor(sM*341);
      g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle";
      for(let i=0;i<n;i++){ g.save(); g.translate(x0+128, y0+128+(i-(n-1)/2)*fs*0.27); g.scale(1,0.25); g.fillText(t[i],0,0); g.restore(); } }
  });
  _signT.wrapS=_signT.wrapT=THREE.ClampToEdgeWrapping; return _signT;
}
/* アーケードの屋根: 半透明のパネル（乳白）と鉄骨の枠 */
/* v17: 和風の建物（後楽園）・瓦・石垣の手続き的テクスチャ。UV は 100 倍の整数 */
function wafuTex(){
  const t=canvasTex(256,256,(g,w,h)=>{
    const y=v=>h*(1-v);                                     // v=0 が壁の下端
    g.fillStyle="#ebe6d8"; g.fillRect(0,0,w,h);
    // 小壁（白い漆喰）
    g.fillStyle="#efece4"; g.fillRect(0,y(1),w,y(0.9)-y(1));
    // 障子（格子）
    g.fillStyle="#e8e2d2"; g.fillRect(0,y(0.88),w,y(0.31)-y(0.88));
    g.strokeStyle="#a99d86"; g.lineWidth=2;
    for(let i=1;i<6;i++){ const x=14+(w-28)*i/6; g.beginPath(); g.moveTo(x,y(0.88)); g.lineTo(x,y(0.31)); g.stroke(); }
    for(let j=1;j<8;j++){ const yy=y(0.31)+(y(0.88)-y(0.31))*j/8; g.beginPath(); g.moveTo(14,yy); g.lineTo(w-14,yy); g.stroke(); }
    // 腰板（縦の板）
    g.fillStyle="#4d3827"; g.fillRect(0,y(0.28),w,h-y(0.28));
    g.strokeStyle="#3a291c"; g.lineWidth=2; for(let x=22;x<w;x+=22){ g.beginPath(); g.moveTo(x,y(0.28)); g.lineTo(x,h); g.stroke(); }
    // 長押・貫・柱
    g.fillStyle="#3b2a1d"; g.fillRect(0,y(0.31),w,y(0.28)-y(0.31)); g.fillRect(0,y(0.9),w,y(0.87)-y(0.9));
    g.fillRect(0,0,14,h); g.fillRect(w-14,0,14,h);
  });
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.01,0.01); return t;
}
function kawaraTex(){
  const t=canvasTex(64,64,(g,w,h)=>{
    const gr=g.createLinearGradient(0,0,0,h); gr.addColorStop(0,"#d9dadd"); gr.addColorStop(0.78,"#b9bbc0"); gr.addColorStop(0.8,"#6f7176"); gr.addColorStop(1,"#8e9095");
    g.fillStyle=gr; g.fillRect(0,0,w,h);
    for(let i=0;i<260;i++){ const v=180+Math.random()*50|0; g.fillStyle=`rgba(${v},${v},${v+4},0.25)`; g.fillRect(Math.random()*w,Math.random()*h*0.78,2,2); }
  });
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.01,0.01); return t;
}
function ishigakiTex(){
  // 野面積み風: 大小の不揃いな石（ずらした格子の点のボロノイ分割）。石と石の間は暗い目地、石ごとに色と陰影を変える。端は折り返しでつながる
  const W=256, H=256, pts=[]; let seed=11; const R=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
  const rows=6; for(let r=0;r<rows;r++){ const n=5+(R()*2|0); for(let c=0;c<n;c++) pts.push([ (c+0.5+(R()-0.5)*0.7)/n*W, (r+0.5+(R()-0.5)*0.6)/rows*H, 118+R()*52, R()*14, R()*6.28 ]); }
  const t=canvasTex(W,H,(g)=>{
    const im=g.createImageData(W,H), d=im.data;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      let d1=1e9, d2=1e9, k1=0;
      for(let k=0;k<pts.length;k++){ let dx=Math.abs(x-pts[k][0]), dy=Math.abs(y-pts[k][1]); if(dx>W/2) dx=W-dx; if(dy>H/2) dy=H-dy; const q=dx*dx*0.8+dy*dy*1.3;
        if(q<d1){ d2=d1; d1=q; k1=k; } else if(q<d2) d2=q; }
      const e=Math.sqrt(d2)-Math.sqrt(d1), P=pts[k1];
      let dy=y-P[1]; if(dy>H/2) dy-=H; if(dy<-H/2) dy+=H;
      const shade = e<2.2 ? 0.38 : e<4 ? 0.62 : 1 - Math.max(0, dy)/90 + Math.sin((x+P[4]*40)*0.09)*0.03;
      const b=P[2]*shade + (R()-0.5)*10, i=(y*W+x)*4;
      d[i]=b+8-P[3]*0.3; d[i+1]=b+4-P[3]*0.5; d[i+2]=b-6-P[3]; d[i+3]=255;
    }
    g.putImageData(im,0,0);
  });
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.01,0.01); return t;
}
function arcRoofTex(){
  const t=canvasTex(256,256,(g,w,h)=>{ g.clearRect(0,0,w,h); g.fillStyle="rgba(236,242,246,0.55)"; g.fillRect(0,0,w,h);
    g.fillStyle="rgba(255,255,255,0.25)"; g.fillRect(0,0,w,h*0.5);
    g.fillStyle="rgba(70,76,82,0.95)"; g.fillRect(0,0,w,10); g.fillRect(0,0,8,h); g.fillRect(w/2-2,0,4,h); });
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(0.01,0.01); return t;   // UV は 100 倍の整数で入っている
}
const PWIRES = [];   // v17: 200m 四方ごとに分けて、近くだけ表示
function buildPowerWires(pos){
  if(!pos || !pos.length) return;
  const T=200, groups=new Map(), m=new THREE.LineBasicMaterial({color:0x2a2a2a, transparent:true, opacity:0.85});
  for(let i=0;i<pos.length;i+=6){ const mx=(pos[i]+pos[i+3])/2, mz=(pos[i+2]+pos[i+5])/2, k=Math.floor(mx/T)+","+Math.floor(mz/T);
    let a=groups.get(k); if(!a){ a=[]; groups.set(k,a); } for(let j=0;j<6;j++) a.push(pos[i+j]); }
  const all=new THREE.Group(); all.name="pwires"; world.add(all);
  for(const [k,a] of groups){ const [ix,iz]=k.split(",").map(Number); const g=new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a),3));
    const l=new THREE.LineSegments(g, m); l.visible=false; all.add(l); PWIRES.push({x0:ix*T, z0:iz*T, size:T, obj:l}); }
}
function buildWires(lines){
  const m=new THREE.LineBasicMaterial({color:0x2b2b2b});
  for(const l of lines){ const g=new THREE.BufferGeometry().setFromPoints(l.map(p=>new THREE.Vector3(p[0],p[1],p[2]))); world.add(new THREE.Line(g,m)); }
}
/* 信号灯: 交差点ごとに 60 秒周期（向きで青・赤が入れ替わる）。実際の現示時間は公開データが無いため仮定 */
/* 信号現示: 交差点ごとの実際の秒数は非公開。幹線道路で一般的な 120 秒周期を仮定し、
   軌道(主道路)方向 青62・黄3・全赤2秒、交差方向 青48・黄3・全赤2秒。開始時刻は交差点ごとにずらす。 */
const CYCLE=120, MAIN_G=62, CROSS_G=48, Y_T=3, AR=2;
/* 現示: 交差点ごとの2現示（主道路=軌道方向 ph0、交差方向 ph1）。1周期120秒:
   ph0 青62・黄3・全赤2 → ph1 青48・黄3・全赤2。交差点ごとのずれ(off)はビルド時に固定。
   ※実際の秒数・系統オフセットは公開データが無いため、幹線道路で一般的な値による仮定 */
function phaseState(g, ph, t){
  const I = S.scene && S.scene.isects && S.scene.isects[g]; if(!I) return 0;
  const tt = ((t + I.off) % CYCLE + CYCLE) % CYCLE;
  if(ph===0) return tt<MAIN_G?0:(tt<MAIN_G+Y_T?1:2);
  const u = tt - (MAIN_G+Y_T+AR); if(u<0) return 2;
  return u<CROSS_G?0:(u<CROSS_G+Y_T?1:2);
}
function lampState(x,z,fx,fz,t,main){ return 0; }   // 旧方式（未使用）
const lampOn = [new THREE.Color(0x28e0a0), new THREE.Color(0xffc320), new THREE.Color(0xff3b2b)];
const lampOff = new THREE.Color(0x202326);
let lampMesh=null, lampData=[];
/* v19: 信号機の配置（data/signals.json: pipeline/signals.py）。交差点ごとに OSM の道路網で実際につながる進入路だけに 1 基ずつ、
   日本の標準的な配置（交差点の向こう側・進行方向左の歩道の柱から車道の上へ張り出した横型 3 灯）で、灯器は進入してくる車の方を向く。
   柱は向こう側の左端（fx,fz）の近くの歩道（無ければ車道でない地面）。水面・建物・軌道の上には立てない。 */
function buildSignals(list, routes){
  if(!list || !list.length) return;
  const TR = new Set(), tk = (x, z) => Math.floor(x / 2) + "," + Math.floor(z / 2);
  for(const k of ["higashi","higashi_r","seiki","seiki_r"]){ const r = routes[k]; if(!r) continue; for(const p of r.track) for(let dx=-1; dx<=1; dx++) for(let dz=-1; dz<=1; dz++) TR.add(tk(p[0] + dx*2, p[2] + dz*2)); }
  const onTrack = (x, z) => TR.has(tk(x, z));
  const W = S._WL;
  const wet = (x, z) => { if(!W) return false; const i = Math.round((x - W.x0) / W.step), j = Math.round((z - W.z0) / W.step); return i >= 0 && j >= 0 && i < W.nx && j < W.nz && W.A[j * W.nx + i] !== -32768 && W.A[j * W.nx + i] / 100 > Car.hAt(x, z) - 0.3; };
  const pos = [], lamps = [];
  const box = (cx, cy, cz, ax, az, lx, ly, lz) => {
    const bx = -az, bz = ax, v = [];
    for(const [sa, sb, sy] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]])
      v.push([cx + ax*sa*lx/2 + bx*sb*lz/2, cy + sy*ly/2, cz + az*sa*lx/2 + bz*sb*lz/2]);
    for(const f of [[0,1,2,3],[4,7,6,5],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]]){ const [a,b,c,e] = f.map(i => v[i]); pos.push(...a, ...c, ...b, ...a, ...e, ...c); }
  };
  const cyl = (x, z, y0, y1, r) => { const n = 8; for(let i = 0; i < n; i++){ const a0 = i/n*6.283, a1 = (i+1)/n*6.283;
    const p0 = [x + Math.cos(a0)*r, z + Math.sin(a0)*r], p1 = [x + Math.cos(a1)*r, z + Math.sin(a1)*r];
    pos.push(p0[0], y0, p0[1], p1[0], y1, p1[1], p1[0], y0, p1[1], p0[0], y0, p0[1], p0[0], y1, p0[1], p1[0], y1, p1[1]); } };
  let n = 0, skipped = 0;
  const placed = [];
  for(const A of list){
    const dx = A.dx, dz = A.dz, lx = dz, lz = -dx;      // 進行方向・その左（x=東, z=南）
    // 柱の位置: 向こう側の左端のまわり（左へ −3〜+9m・前後 −5〜+4m）で、いちばん近い歩道。無ければ車道のそばの地面
    let best = null, bc = 1e9;
    for(const tmax of [9, 16]){                           // 見つからなければ広げて探す（広い広場・幅の広い道）
      for(let t = -3; t <= tmax; t += 0.5) for(let u = -5; u <= 4; u += 1){
        const x = A.fx + lx * t + dx * u, z = A.fz + lz * t + dz * u, k = Car.kindAt(x, z);
        if(k === 1 || k === 9 || onTrack(x, z) || wet(x, z)) continue;
        if(Car.kindAt(x + lx * 0.5, z + lz * 0.5) === 9) continue;
        // 歩道を優先。道路面のデータが無い所（路面区分がすべて地面）は、左端から 1.5m の地面
        const cost = Math.abs(t - 1.5) + Math.abs(u) * 0.7 + (k === 2 ? 0 : 2);
        if(cost < bc){ bc = cost; best = [x, z]; }
      }
      if(best) break;
    }
    if(!best){ skipped++; continue; }
    const [bx, bz] = best;
    // 同じ所に 2 本立たないように（上下線の重なりなど）
    if(placed.some(q => Math.hypot(q[0] - bx, q[1] - bz) < 1.5 && q[2] * dx + q[3] * dz > 0.9)){ skipped++; continue; }
    placed.push([bx, bz, dx, dz]);
    const yb = Car.hAt(bx, bz);
    // 腕: 柱から進入車線（左側の車線群）の中ほどまで（2.5〜6.5m）
    const lat = (bx - A.fx) * lx + (bz - A.fz) * lz;
    const reach = Math.max(2.5, Math.min(6.5, lat + Math.min(A.n_in, 3) * 3.25 * 0.5));
    const tx = bx - lx * reach, tz = bz - lz * reach;
    cyl(bx, bz, yb - 0.1, yb + 5.6, 0.11);
    box((bx + tx) / 2, yb + 5.25, (bz + tz) / 2, -lx, -lz, reach, 0.1, 0.1);
    box(tx, yb + 5.2, tz, dx, dz, 0.36, 0.45, 1.4);
    for(let k = 0; k < 3; k++){ const off = 0.45 - 0.45 * k;   // 運転者から見て左から 青・黄・赤
      lamps.push({ p: [tx + lx * off - dx * 0.19, yb + 5.22, tz + lz * off - dz * 0.19], k, f: [-dx, -dz], g: A.g, ph: A.ph }); }
    n++;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x46494c, side: THREE.DoubleSide })); m.name = "signal"; m.castShadow = true; m.receiveShadow = true;
  world.add(m);
  buildSignalLamps(lamps);
  S._sigLamps = lamps; S._sigPlaced = placed; console.log("signals", n, "skipped", skipped);
}
function buildSignalLamps(list){
  lampData=list; if(!list.length) return;
  const g=new THREE.CircleGeometry(0.15,12);
  lampMesh=new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({color:0xffffff}), list.length);
  const m4=new THREE.Matrix4(), q=new THREE.Quaternion(), up=new THREE.Vector3(0,0,1);
  list.forEach((l,i)=>{ q.setFromUnitVectors(up, new THREE.Vector3(l.f[0],0,l.f[1]).normalize());
    m4.compose(new THREE.Vector3(l.p[0],l.p[1],l.p[2]), q, new THREE.Vector3(1,1,1)); lampMesh.setMatrixAt(i,m4); lampMesh.setColorAt(i,lampOff); });
  world.add(lampMesh);
}
function updateLamps(t){
  if(!lampMesh) return;
  for(let i=0;i<lampData.length;i++){ const l=lampData[i]; const st=phaseState(l.g,l.ph,t); lampMesh.setColorAt(i, st===l.k?lampOn[l.k]:lampOff); }
  lampMesh.instanceColor.needsUpdate=true;
}

/* ---------------- 車両: 9200形（公表諸元に基づく簡略モデル）
   2車体連接・編成全長18.0m・各車体8.54m・全幅2.4m・全高3.745m（集電装置折畳み）
   塗装: メタリックのライトシルバー基調、車体裾にコバルトブルーの帯。100%低床 */
function makeCarBody(withPanto){
  const g = new THREE.Group();
  const L = 8.54, W = 2.4, R = W/2, straight = L - R;
  const silver = new THREE.MeshPhongMaterial({color:0xc8ccd1, specular:0x9aa0a8, shininess:70});
  const blue = new THREE.MeshPhongMaterial({color:0x1d4f9e, specular:0x335577, shininess:60});
  const glass = new THREE.MeshPhongMaterial({color:0x1c2830, specular:0x88a0b0, shininess:90});
  const grey = new THREE.MeshLambertMaterial({color:0x8e9296});
  const dark = new THREE.MeshLambertMaterial({color:0x2a2d30});
  const zc = -R/2;                               // 直線部の中心（+z 側が丸い先頭）
  function slab(y0, y1, mat, grow){
    const w = W + (grow||0)*2, r = R + (grow||0);
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, y1-y0, straight), mat);
    box.position.set(0, (y0+y1)/2, zc); g.add(box);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1-y0, 24, 1, false, -Math.PI/2, Math.PI), mat);
    cyl.position.set(0, (y0+y1)/2, zc + straight/2); g.add(cyl);
  }
  slab(0.22, 0.62, blue);
  slab(0.62, 1.00, silver);
  slab(1.00, 2.55, glass, -0.01);
  slab(2.55, 3.20, silver);
  for(let k=-1;k<=1;k++){ const post=new THREE.Mesh(new THREE.BoxGeometry(W+0.02,1.55,0.2), silver); post.position.set(0,1.775,zc+k*2.2); g.add(post); }
  const roofBox = new THREE.Mesh(new THREE.BoxGeometry(1.7,0.42,3.4), grey); roofBox.position.set(0,3.41,zc-0.6); g.add(roofBox);
  for(const x of [-0.75,0.75]){ const l=new THREE.Mesh(new THREE.CircleGeometry(0.11,12), new THREE.MeshBasicMaterial({color:0xf5f2e0}));
    l.position.set(x,0.82,zc+straight/2+Math.sqrt(R*R-x*x)+0.012); g.add(l); }
  if(withPanto){
    const base=new THREE.Mesh(new THREE.BoxGeometry(1.0,0.12,1.0), dark); base.position.set(0,3.68,zc+1.2); g.add(base);
    const a1=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,1.9), dark); a1.position.set(0,4.25,zc+0.7); a1.rotation.x=-0.62; g.add(a1);
    const a2=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.06,1.8), dark); a2.position.set(0,4.95,zc+0.8); a2.rotation.x=0.72; g.add(a2);
    const shoe=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.06,0.28), dark); shoe.position.set(0,5.43,zc+1.35); g.add(shoe);
  }
  return g;
}
function makeTram(){
  const g = new THREE.Group();
  const a = makeCarBody(true);                        // A車（前・集電装置）
  const bInner = makeCarBody(false); bInner.rotation.y = Math.PI;
  const b = new THREE.Group(); b.add(bInner);          // B車（後ろ向き）
  const j = new THREE.Mesh(new THREE.BoxGeometry(2.2,2.8,1.0), new THREE.MeshLambertMaterial({color:0x3b3f44}));
  g.userData = {a, b, j}; g.add(a, b, j);
  return g;
}
function placeTram(car){
  if(car.userData.single){ const s=S.pos+0.6-car.userData.len/2, p=pointAt(s), t=tangentAt(s); car.userData.a.position.copy(p); car.userData.a.rotation.set(0, Math.atan2(t.x,t.z), 0); return; }
  // 各車体の中心を軌道上に置き、それぞれの接線方向へ向ける（連接車の曲線追従）
  const put = (obj, s) => { const p = pointAt(s), t = tangentAt(s); obj.position.copy(p); obj.rotation.set(0, Math.atan2(t.x,t.z), 0); };
  put(car.userData.a, S.pos - 4.27 + 0.6);
  put(car.userData.b, S.pos - 13.73 - 0.6);
  put(car.userData.j, S.pos - 9.0); car.userData.j.position.y += 1.75;
}
/* ---------------- 車両の種類 ----------------
   9200形 MOMO: 2車体連接・全長18.0m（低床・VVVF）
   3000形: 元 東武日光軌道線100形（1953年 宇都宮車両製、1968〜69年に岡電へ）。12m級の半鋼製単車、定員96名、
           主電動機 45kW×2・直接制御・直通空気ブレーキ、集電装置は石津式パンタグラフ（岡電標準）。
     3005号 … 東武日光軌道線時代の塗装に復元（上半分が淡い緑、下半分が橙）
     3007号 … 「KURO」（黒の車体に金の線、赤いパンタグラフと救助網） */
const VEHICLES = {
  momo:  { name:"9200形 MOMO", len:18.0, front:8.54, acc:[0,0.9,1.7,2.4,3.0], vmax:50, motor:"vvvf" },
  t3005: { name:"3000形 3005号（東武日光軌道線 復元塗装）", len:12.0, front:12.0, acc:[0,0.6,1.1,1.6,2.0], vmax:40, motor:"dc" },
  t3007: { name:"3000形 3007号 KURO", len:12.0, front:12.0, acc:[0,0.6,1.1,1.6,2.0], vmax:40, motor:"dc" },
};
function tram3000Textures(kind, dest){
  const L = kind==="t3007" ? {
      body:"#141414", upper:"#141414", belt:"#141414", line:"#c9a54a", frame:"#0c0c0c", roof:"#1a1a1a", num:"#d8b860", numText:"3007", name:"KURO" }
    : { body:"#e2772e", upper:"#a9cfb4", belt:"#8ab89a", line:"#3f8a64", frame:"#7fb393", roof:"#8d9a93", num:"#ffffff", numText:"3005", name:"" };
  // 側面（長さ12m×高さ2.75m）: 1024×240
  const side = canvasTex(1024, 240, (g,w,h)=>{
    g.fillStyle = L.upper; g.fillRect(0,0,w,h*0.62);
    g.fillStyle = L.body; g.fillRect(0,h*0.58,w,h*0.42);
    g.fillStyle = L.line; g.fillRect(0,h*0.585,w,kind==="t3007"?3:7);
    if(kind==="t3007"){ g.fillRect(0,h*0.2,w,2); g.fillRect(0,h*0.9,w,2); }
    else { g.fillStyle=L.belt; g.fillRect(0,h*0.1,w,h*0.06); }
    // 扉（前後）と窓
    const door = (x)=>{ g.fillStyle=L.frame; g.fillRect(x,h*0.16,80,h*0.8); g.fillStyle="#1d2328"; g.fillRect(x+8,h*0.2,28,h*0.33); g.fillRect(x+44,h*0.2,28,h*0.33); g.strokeStyle="rgba(0,0,0,.5)"; g.lineWidth=2; g.strokeRect(x+2,h*0.16,76,h*0.8); };
    door(70); door(w-150);
    for(let i=0;i<9;i++){ const x=175+i*76; g.fillStyle=L.frame; g.fillRect(x-4,h*0.18,72,h*0.4); g.fillStyle="#26303a"; g.fillRect(x,h*0.21,64,h*0.34);
      g.fillStyle="rgba(255,255,255,.12)"; g.fillRect(x,h*0.21,64,5); g.fillStyle=L.frame; g.fillRect(x,h*0.36,64,3); }
    g.fillStyle=L.num; g.font="bold 26px Arial,sans-serif"; g.textAlign="center"; g.fillText(L.numText, w*0.5, h*0.8);
    if(L.name){ g.font="bold 20px Georgia,serif"; g.fillText(L.name, w*0.5, h*0.12); }
  });
  // 前面（幅2.3m×高さ2.75m）: 256×300
  const front = canvasTex(256, 300, (g,w,h)=>{
    g.fillStyle = L.upper; g.fillRect(0,0,w,h*0.62); g.fillStyle=L.body; g.fillRect(0,h*0.58,w,h*0.42);
    g.fillStyle = L.line; g.fillRect(0,h*0.585,w,kind==="t3007"?3:7);
    if(kind==="t3007"){ g.beginPath(); g.moveTo(10,h*0.62); g.quadraticCurveTo(w/2,h*0.95,w-10,h*0.62); g.strokeStyle=L.line; g.lineWidth=3; g.stroke(); }
    g.fillStyle=L.frame; g.fillRect(8,h*0.16,w-16,h*0.4);
    g.fillStyle="#26303a"; g.fillRect(14,h*0.2,70,h*0.34); g.fillRect(93,h*0.2,70,h*0.34); g.fillRect(172,h*0.2,70,h*0.34);
    g.fillStyle="#f4f1e6"; g.fillRect(70,h*0.04,116,h*0.1); g.fillStyle="#111"; g.font="bold 22px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle";
    const dt=(dest||"東山").replace(/・.*$/,"")+" 行"; let fs=22; do { g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; } while(g.measureText(dt).width>108 && fs>12);
    g.fillText(dt, w/2, h*0.09);
    g.fillStyle=L.num; g.font="bold 20px Arial,sans-serif"; g.fillText(L.numText, 48, h*0.72);
  });
  return {side, front, L};
}
function makeTram3000(kind, dest){
  const g = new THREE.Group();
  const T = tram3000Textures(kind, dest), L = T.L;
  const len = 12.0, W = 2.3, y0 = 0.62, y1 = 3.35;
  const sideM = new THREE.MeshLambertMaterial({map:T.side});
  const frontM = new THREE.MeshLambertMaterial({map:T.front});
  const roofM = new THREE.MeshLambertMaterial({color:new THREE.Color(L.roof)});
  const darkM = new THREE.MeshLambertMaterial({color:0x222426});
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, y1-y0, len-0.6), [sideM, sideM, roofM, darkM, frontM, frontM]);
  body.position.set(0,(y0+y1)/2,0); g.add(body);
  // 前後の妻面（わずかに丸い前面）
  for(const s of [1,-1]){
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(W/2, W/2, y1-y0, 24, 1, false, s>0?-Math.PI/2:Math.PI/2, Math.PI), new THREE.MeshPhongMaterial({map:T.front, shininess:40, specular:0x333333}));
    cap.scale.set(1,1,0.26); cap.position.set(0,(y0+y1)/2, s*(len/2-0.3)); g.add(cap);
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.15,0.18,16), new THREE.MeshPhongMaterial({color:0x111111, shininess:60}));
    hl.rotation.x=Math.PI/2; hl.position.set(0, y0+0.55, s*(len/2-0.3+0.3)); g.add(hl);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1,16), new THREE.MeshBasicMaterial({color:s>0?0xfff2cc:0x551111}));
    lens.position.set(0, y0+0.55, s*(len/2-0.3+0.4)); if(s<0) lens.rotation.y=Math.PI; g.add(lens);
    // 救助網（KURO は赤）
    const netM = new THREE.MeshLambertMaterial({color: kind==="t3007"?0xd8321f:0x333333});
    for(const x of [-0.45,-0.15,0.15,0.45]){ const b=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.05,0.5), netM); b.position.set(x,0.35,s*(len/2+0.15)); g.add(b); }
    const bar=new THREE.Mesh(new THREE.BoxGeometry(1.1,0.06,0.06), netM); bar.position.set(0,0.35,s*(len/2+0.38)); g.add(bar);
  }
  // 屋根（丸屋根）と台車
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, len-0.7, 24, 1, false, -Math.PI/2*0.62, Math.PI*0.62), roofM);
  roof.scale.set(1,1,0.28); roof.rotation.set(-Math.PI/2, 0, 0); roof.position.set(0, y1-0.12, 0); g.add(roof);
  const cap2 = new THREE.Mesh(new THREE.BoxGeometry(W-0.3, 0.08, len-0.8), roofM); cap2.position.set(0,y1+0.03,0); g.add(cap2);
  for(const s of [1,-1]){ const bg = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.45,2.2), darkM); bg.position.set(0,0.42,s*3.4); g.add(bg);
    for(const z of [-0.7,0.7]) for(const x of [-0.72,0.72]){ const wh=new THREE.Mesh(new THREE.CylinderGeometry(0.33,0.33,0.1,16), darkM); wh.rotation.z=Math.PI/2; wh.position.set(x,0.33,s*3.4+z); g.add(wh); } }
  // 石津式パンタグラフ（菱形を上下に重ねた独特の枠）
  const pM = new THREE.MeshLambertMaterial({color: kind==="t3007"?0xd8321f:0x2b2b2b});
  const pan = new THREE.Group(); pan.position.set(0, y1+0.22, 1.2); g.add(pan);
  const bx=(w,h,d,x,y,z,rx,rz)=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),pM); m.position.set(x,y,z); if(rx)m.rotation.x=rx; if(rz)m.rotation.z=rz; pan.add(m); };
  bx(1.3,0.08,1.3,0,0.04,0); bx(0.06,0.06,1.2,-0.6,0.12,0); bx(0.06,0.06,1.2,0.6,0.12,0);
  for(const x of [-0.45,0.45]){ bx(0.05,0.9,0.05,x,0.55,-0.3,0.5); bx(0.05,0.9,0.05,x,0.55,0.3,-0.5); bx(0.05,0.9,0.05,x,1.3,-0.3,-0.5); bx(0.05,0.9,0.05,x,1.3,0.3,0.5); }
  bx(1.0,0.05,0.05,0,0.95,0); bx(1.7,0.06,0.18,0,1.72,0); bx(1.2,0.06,0.06,0,1.72,0.25); bx(1.2,0.06,0.06,0,1.72,-0.25);
  g.userData = { single:true, body:g, len };
  return g;
}
function makeVehicle(kind, dest){
  if(kind==="t3005" || kind==="t3007"){ const outer=new THREE.Group(); const inner=makeTram3000(kind, dest); outer.add(inner); outer.userData={single:true, a:inner, len:12.0, kind}; return outer; }
  const g = makeTram(); g.userData.kind="momo"; g.userData.len=18.0; return g;
}

window.__setVehicle=(k)=>setVehicle(k);
function VEH(){ return VEHICLES[S.vehicle||"momo"]; }
/* ================= 周りを走る電車・自動車（v10） =================
   ・電車: 4 系統（東山線・清輝橋線 × 往復）を複数の電車が走る。各停留場で停車、信号・前の電車に従う。
          終点では東山は引上線で、清輝橋・岡山駅前はその場で運転台を替えて折り返す。
          単線区間（引上線・終端の行き止まり線）は1編成ずつ（閉そく）。プレイヤーの電車にも閉そく信号を出す。
   ・自動車: OSM の車道を PLATEAU の車道範囲で車線に分けた網（data/traffic.json）を走る。
          左側通行・車線維持、交差点で左折/直進/右折、信号（交差点ごとの現示）で停止、前の車・電車・プレイヤーに追従。
   ・両者とも「進路上の点の近くに何かあるか」を空間ハッシュで調べて止まる（曲線でも隣の車線は拾わない）。 */

/* ---------- 一般車（7000形・8000形相当の 12.5m 級単車。塗装は広告ラッピング風の単色＝架空） ---------- */
const LIVERIES_7000 = [
  { body:"#e8c02a", band:"#ffffff", num:"7101" }, { body:"#c8372d", band:"#f2ede0", num:"7301" },
  { body:"#4d8fd1", band:"#ffffff", num:"7701" }, { body:"#3f9a5c", band:"#f4f1e6", num:"8101" },
  { body:"#f0efe8", band:"#d85a2a", num:"7401" }, { body:"#8a4fb0", band:"#ffffff", num:"8501" },
];
function tram7000Textures(lv, dest){
  const side = canvasTex(1024, 240, (g,w,h)=>{
    g.fillStyle=lv.body; g.fillRect(0,0,w,h);
    g.fillStyle=lv.band; g.fillRect(0,h*0.66,w,h*0.07);
    g.fillStyle="rgba(255,255,255,.10)"; g.fillRect(0,0,w,h*0.12);
    const door=(x)=>{ g.fillStyle="#2a3036"; g.fillRect(x,h*0.14,86,h*0.82); g.fillStyle="#141a20"; g.fillRect(x+6,h*0.18,34,h*0.46); g.fillRect(x+46,h*0.18,34,h*0.46); };
    door(40); door(w*0.55);
    for(let i=0;i<9;i++){ const x=150+i*86; if(x>w*0.55-80 && x<w*0.55+90) continue; g.fillStyle="#1b2229"; g.fillRect(x,h*0.16,74,h*0.44); g.fillStyle="rgba(255,255,255,.14)"; g.fillRect(x,h*0.16,74,4); }
    g.fillStyle="#1b2229"; g.fillRect(w-120,h*0.16,90,h*0.44);
    g.fillStyle=lv.band; g.font="bold 24px Arial,sans-serif"; g.textAlign="center"; g.fillText(lv.num, w*0.82, h*0.9);
  });
  const front = canvasTex(256, 300, (g,w,h)=>{
    g.fillStyle=lv.body; g.fillRect(0,0,w,h);
    g.fillStyle=lv.band; g.fillRect(0,h*0.66,w,h*0.06);
    g.fillStyle="#141a20"; g.beginPath(); g.moveTo(12,h*0.14); g.lineTo(w-12,h*0.14); g.lineTo(w-18,h*0.58); g.lineTo(18,h*0.58); g.closePath(); g.fill();
    g.fillStyle="#0b0b0b"; g.fillRect(56,h*0.02,144,h*0.1);
    g.fillStyle="#ffb13a"; g.textAlign="center"; g.textBaseline="middle";
    const dt=(dest||"東山").replace(/・.*$/,"")+" 行"; let fs=22; do { g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; } while(g.measureText(dt).width>136 && fs>12);
    g.fillText(dt, w/2, h*0.07);
    g.fillStyle="#fff7da"; g.beginPath(); g.arc(46,h*0.8,11,0,7); g.arc(w-46,h*0.8,11,0,7); g.fill();
    g.fillStyle=lv.band; g.font="bold 18px Arial,sans-serif"; g.fillText(lv.num, w/2, h*0.85);
  });
  return {side, front};
}
function makeTram7000(lv, dest){
  const g = new THREE.Group();
  const T = tram7000Textures(lv, dest);
  const len = 12.5, W = 2.35, y0 = 0.72, y1 = 3.45;
  const sideM = new THREE.MeshLambertMaterial({map:T.side}), frontM = new THREE.MeshPhongMaterial({map:T.front, shininess:30, specular:0x333333});
  const roofM = new THREE.MeshLambertMaterial({color:0xb9bcbf}), darkM = new THREE.MeshLambertMaterial({color:0x222426});
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, y1-y0, len-0.3), [sideM, sideM, roofM, darkM, frontM, frontM]);
  body.position.set(0,(y0+y1)/2,0); g.add(body);
  for(const s of [1,-1]){
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(W/2, W/2, y1-y0, 20, 1, false, s>0?-Math.PI/2:Math.PI/2, Math.PI), frontM);
    cap.scale.set(1,1,0.1); cap.position.set(0,(y0+y1)/2, s*(len/2-0.15)); g.add(cap);
    const sk = new THREE.Mesh(new THREE.BoxGeometry(W-0.1, 0.35, 0.3), darkM); sk.position.set(0, y0-0.1, s*(len/2-0.2)); g.add(sk);
  }
  const eq = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 3.2), roofM); eq.position.set(0, y1+0.17, -1.8); g.add(eq);
  for(const s of [1,-1]){ const bg = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.5,2.2), darkM); bg.position.set(0,0.45,s*3.3); g.add(bg); }
  // シングルアーム・パンタグラフ
  const pM = new THREE.MeshLambertMaterial({color:0x2b2b2b});
  const base=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.1,0.9), pM); base.position.set(0,y1+0.08,1.4); g.add(base);
  const a1=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.06,1.6), pM); a1.position.set(0,y1+0.55,1.0); a1.rotation.x=-0.62; g.add(a1);
  const a2=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.05,1.5), pM); a2.position.set(0,y1+1.15,1.05); a2.rotation.x=0.72; g.add(a2);
  const shoe=new THREE.Mesh(new THREE.BoxGeometry(1.3,0.05,0.25), pM); shoe.position.set(0,y1+1.62,1.5); g.add(shoe);
  g.userData = { single:true, body:g, len };
  return g;
}

/* ---------- 経路（折れ線）ユーティリティ ---------- */
function mkPath(track){
  const n=track.length, P=new Float32Array(n*3), C=new Float32Array(n);
  for(let i=0;i<n;i++){ P[i*3]=track[i][0]; P[i*3+1]=track[i][1]; P[i*3+2]=track[i][2]; if(i) C[i]=C[i-1]+Math.hypot(track[i][0]-track[i-1][0], track[i][2]-track[i-1][2]); }
  return {P, C, n, len:C[n-1]};
}
function pathIdx(p, s){ let lo=0, hi=p.n-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(p.C[m]<=s) lo=m; else hi=m; } return lo; }
function pathPt(p, s, out){
  out=out||new THREE.Vector3();
  if(s<0 || s>p.len){ const e=s<0, a=e?0:p.n-1, b=e?Math.min(4,p.n-1):Math.max(0,p.n-5);
    let dx=p.P[b*3]-p.P[a*3], dz=p.P[b*3+2]-p.P[a*3+2]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L; const k=e?s:-(s-p.len);
    return out.set(p.P[a*3]+dx*k, p.P[a*3+1], p.P[a*3+2]+dz*k); }
  const i=pathIdx(p,s), j=Math.min(i+1,p.n-1), L=p.C[j]-p.C[i]||1, t=(s-p.C[i])/L;
  return out.set(p.P[i*3]+(p.P[j*3]-p.P[i*3])*t, p.P[i*3+1]+(p.P[j*3+1]-p.P[i*3+1])*t, p.P[i*3+2]+(p.P[j*3+2]-p.P[i*3+2])*t);
}
const _pa=new THREE.Vector3(), _pb=new THREE.Vector3();
function pathTan(p, s, out){ pathPt(p, s-2, _pa); pathPt(p, s+2, _pb); return (out||new THREE.Vector3()).set(_pb.x-_pa.x, 0, _pb.z-_pa.z).normalize(); }
/* 車体の配置（連接車・単車とも）。pos = 先頭位置の軌道上の距離 */
function placeOn(car, P, pos){
  const put=(obj, s)=>{ pathPt(P, s, obj.position); const t=pathTan(P, s, _pa); obj.rotation.set(0, Math.atan2(t.x,t.z), 0); };
  if(car.userData.single){ put(car.userData.a, pos+0.6-car.userData.len/2); return; }
  put(car.userData.a, pos-4.27+0.6); put(car.userData.b, pos-13.73-0.6); put(car.userData.j, pos-9.0); car.userData.j.position.y+=1.75;
}

/* ---------- 障害物の空間ハッシュ（毎フレーム作り直す） ---------- */
const Obs = (()=>{
  const CELL=8, map=new Map(); let list=[];
  const key=(ix,iz)=>ix*73856093 ^ iz*19349663;
  function clear(){ map.clear(); list.length=0; }
  function add(x, z, r, o){
    const e={x,z,r,o}; list.push(e);
    const ix=Math.floor(x/CELL), iz=Math.floor(z/CELL), k=key(ix,iz);
    let a=map.get(k); if(!a){ a=[]; map.set(k,a); } a.push(e);
  }
  /* (x,z) から rad 以内にある自分以外の障害物（最初の1つ） */
  function hit(x, z, rad, self, skip){
    const ix=Math.floor(x/CELL), iz=Math.floor(z/CELL);
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){
      const a=map.get(key(ix+dx,iz+dz)); if(!a) continue;
      for(const e of a){ if(e.o===self) continue; const d=Math.hypot(e.x-x, e.z-z); if(d<e.r+rad && !(skip && skip(e.o))) return e; }
    }
    return null;
  }
  /* 車体に沿った円（長さ len、先頭 fx,fz、向き dx,dz） */
  function addBody(fx, fz, dx, dz, len, r, o){ const n=Math.max(2, Math.ceil(len/2.6)); for(let i=0;i<n;i++){ const t=(i+0.5)/n*len; add(fx-dx*t, fz-dz*t, r, o); } }
  return {clear, add, hit, addBody, get list(){ return list; }};
})();

/* ---------- 電車（AI） ---------- */
const Trams = (()=>{
  const list=[]; let R=null, blocks=[], ready=false;
  const PLAYER={kind:"player"};
  const legCache={};
  function routeLeg(key){                      // 路線（東山は引上線まで延ばす）
    if(legCache[key]) return legCache[key];
    const r=R[key], tn=R.turn && R.turn[key];
    const pull=tn && tn.pull && tn.pull.length ? tn.pull : null;
    const track=pull ? r.track.concat(pull.slice(1)) : r.track;
    const P=mkPath(track);
    const stops=r.stops.map(s=>({arc:s.arc, name:s.name, dwell:18}));
    stops[0].dwell=0; stops[stops.length-1].dwell = pull ? 25 : 40;
    if(pull) stops.push({arc:P.len-1.0, name:"引上線", dwell:12, turn:true});
    else stops[stops.length-1].turn=true;
    return legCache[key]={key, P, stops, signals:r.signals, speed:r.speed, dest:r.dest, base:r.track.length};
  }
  function backLeg(key){                       // 引上線から出て次の路線へ
    const k2="back_"+key; if(legCache[k2]) return legCache[k2];
    const tn=R.turn[key], nx=R[tn.next], back=tn.back;
    const P0=mkPath(back), lenB=P0.len;
    const P=mkPath(back.concat(nx.track.slice(1)));
    const stops=[{arc:0,name:"引上線",dwell:0}].concat(nx.stops.map((s,i)=>({arc:s.arc+lenB, name:s.name, dwell:i===0?30:18})));
    stops[stops.length-1].dwell=40; stops[stops.length-1].turn=true;
    const signals=nx.signals.map(g=>Object.assign({},g,{stop:g.stop+lenB}));
    const sp=back.map(()=>15).concat(nx.speed.slice(1));
    return legCache[k2]={key:tn.next, P, stops, signals, speed:sp, dest:nx.dest, viaBack:true};
  }
  function limit(L, s){ const i=Math.min(L.speed.length-1, pathIdx(L.P, Math.max(0,s))); return L.speed[i]; }

  /* 単線区間（同じレールを逆向きにも走る所）を自動で見つけて閉そくにする */
  function findBlocks(){
    const legs=[];
    for(const k of ["higashi","seiki","higashi_r","seiki_r"]){ legs.push(routeLeg(k)); const tn=R.turn&&R.turn[k]; if(tn && tn.pull && tn.pull.length) legs.push(backLeg(k)); }
    const smp=[]; const G=new Map(), gk=(x,z)=>Math.floor(x/3)*92821 ^ Math.floor(z/3)*68917;
    legs.forEach((L,li)=>{ for(let s=0;s<=L.P.len;s+=2){ const p=pathPt(L.P,s), t=pathTan(L.P,s); const e={x:p.x,z:p.z,tx:t.x,tz:t.z,li,single:false,b:-1}; smp.push(e); const k=gk(p.x,p.z); let a=G.get(k); if(!a){a=[];G.set(k,a);} a.push(e); } });
    const near=(x,z,rad,f)=>{ const ix=Math.floor(x/3), iz=Math.floor(z/3); for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){ const a=G.get((ix+dx)*92821 ^ (iz+dz)*68917); if(a) for(const e of a) if(Math.hypot(e.x-x,e.z-z)<rad) f(e); } };
    for(const e of smp) near(e.x,e.z,0.7,o=>{ if(o.li!==e.li && o.tx*e.tx+o.tz*e.tz < -0.8){ e.single=true; o.single=true; } });
    const sg=smp.filter(e=>e.single); let nb=0;
    for(const e of sg){ if(e.b>=0) continue; const st=[e]; e.b=nb; while(st.length){ const q=st.pop(); near(q.x,q.z,4.5,o=>{ if(o.single && o.b<0){ o.b=nb; st.push(o); } }); } nb++; }
    // 短いもの（平面交差など）は閉そくにしない
    blocks=[]; let bi=0; for(let i=0;i<nb;i++){ const pts=sg.filter(e=>e.b===i); if(pts.length<10){ for(const e of pts){ e.single=false; e.b=-1; } continue; } for(const e of pts) e.b=bi; blocks.push({owner:null, pts}); bi++; }
    Trams._sg=sg; Trams._near=near;
  }
  /* 経路上の閉そく区間 [{b, s0, s1}] */
  function intervals(P){
    const out=[]; if(!Trams._sg) return out;
    let cur=null;
    for(let s=0;s<=P.len;s+=2){ const p=pathPt(P,s); let b=-1; Trams._near(p.x,p.z,0.9,o=>{ if(o.single) b=o.b; });
      if(b>=0){ if(cur && cur.b===b && s-cur.s1<=6) cur.s1=s; else { cur={b,s0:s,s1:s}; out.push(cur); } } }
    return out;
  }
  function blockFree(b, who){ const o=blocks[b].owner; return o===null || o===who; }

  function kinds(playerKind){
    // 3005号・3007号・MOMO は実在の両数に合わせて重複させない（MOMO は2編成）
    const pool=[];
    if(playerKind!=="t3005") pool.push("t3005");
    if(playerKind!=="t3007") pool.push("t3007");
    pool.push("momo"); if(playerKind!=="momo") pool.push("momo");
    return pool;
  }
  let lvI=0;
  function makeBody(t){
    if(t.obj){ scene.remove(t.obj); t.obj.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material) (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ if(m.map) m.map.dispose(); m.dispose(); }); }); }
    const dest=t.leg.dest;
    if(t.kind==="t7000"){ const outer=new THREE.Group(), inner=makeTram7000(t.lv, dest); outer.add(inner); outer.userData={single:true,a:inner,len:12.5}; t.obj=outer; }
    else t.obj=makeVehicle(t.kind, dest);
    t.len = t.obj.userData.len || 18.0;
    t.obj.traverse(o=>{ if(o.isMesh) o.castShadow=true; });
    scene.add(t.obj);
  }
  function spawn(key, pos, kind){
    const leg=routeLeg(key);
    const t={leg, pos, v:0, dwell:0, stopI:1, sigI:0, kind, lv:LIVERIES_7000[(lvI++)%LIVERIES_7000.length], own:new Set(), id:list.length, wait:0};
    while(t.stopI<leg.stops.length && leg.stops[t.stopI].arc < pos-1) t.stopI++;
    while(t.sigI<leg.signals.length && leg.signals[t.sigI].stop < pos-1) t.sigI++;
    t.iv=intervals(leg.P);
    makeBody(t); list.push(t); return t;
  }
  function clearAll(){ for(const t of list){ if(t.obj) scene.remove(t.obj); } list.length=0; for(const b of blocks) b.owner=null; }
  /* 走らせ始める: プレイヤーの電車（key, pos）とかぶらない位置に各系統2編成 */
  function populate(playerKey, playerPos, playerKind){
    if(!ready) return; clearAll();
    const pool=kinds(playerKind||"none"); let pi=0;
    const pick=()=> pi<pool.length && Math.random()<0.55 ? pool[pi++] : "t7000";
    const pp = playerKey ? pathPt(routeLeg(playerKey.replace(/^back_/,"")).P, playerPos||0) : null;
    for(const key of ["higashi","higashi_r","seiki","seiki_r"]){
      const L=routeLeg(key), n=2;
      for(let i=0;i<n;i++){
        let pos = (i+0.35+Math.random()*0.3)/n * (L.stops[L.stops.length-1].arc - 60) + 40;
        if(key===playerKey) pos = Math.min(L.stops[L.stops.length-1].arc-30, (playerPos||0) + 700 + i*1100);
        // 閉そく区間・プレイヤーの近く（120m）は避ける
        const iv=intervals(L.P); let tries=0;
        const bad=(s)=> iv.some(q=>s>q.s0-25 && s<q.s1+25) || (pp && pathPt(L.P,s).distanceTo(pp)<120) || list.some(o=>o.leg.key===key && Math.abs(o.pos-s)<150);
        while(bad(pos) && tries++<40) pos = 40 + Math.random()*(L.stops[L.stops.length-1].arc-80);
        if(tries>=40) continue;
        spawn(key, pos, pick());
      }
    }
  }
  function init(routes){ R=routes; findBlocks(); ready=true; }

  const _p=new THREE.Vector3(), _t=new THREE.Vector3();
  function registerAll(){
    for(const t of list){ pathPt(t.leg.P, t.pos, _p); pathTan(t.leg.P, t.pos, _t);
      // 曲線でも車体に沿うよう、後ろ側は軌道上の点で置く
      const n=Math.max(2, Math.ceil(t.len/2.6)); for(let i=0;i<n;i++){ const s=t.pos-(i+0.5)/n*t.len; pathPt(t.leg.P, s, _p); Obs.add(_p.x,_p.z,1.25,t); } }
  }
  /* 進路上の障害物までの距離（先頭から） */
  function gapAhead(P, pos, look, self, rad, skip){
    for(let d=1.2; d<=look; d+=2){ pathPt(P, pos+d, _p); const e=Obs.hit(_p.x,_p.z,rad,self,skip); if(e) return {d:d-e.r, o:e.o}; }
    return null;
  }
  function flip(t){
    // 最後部を新しい先頭にして次の路線へ
    const rear=pathPt(t.leg.P, t.pos-(t.len-0.6), new THREE.Vector3());
    const key=t.leg.key, tn=R.turn && R.turn[key.replace(/^back_/,"")];
    let nl;
    if(t.leg.viaBack===undefined && tn && tn.pull && tn.pull.length && t.leg.stops[t.leg.stops.length-1].name==="引上線") nl=backLeg(key);
    else nl=routeLeg(tn ? tn.next : key);
    let best=0, bd=1e18; const lim=Math.min(nl.P.n, 260);
    for(let i=0;i<lim;i++){ const d=(nl.P.P[i*3]-rear.x)**2+(nl.P.P[i*3+2]-rear.z)**2; if(d<bd){ bd=d; best=i; } }
    t.leg=nl; t.pos=nl.P.C[best]+0.6; t.v=0; t.stopI=0; t.sigI=0; t.iv=intervals(nl.P);
    while(t.stopI<nl.stops.length && nl.stops[t.stopI].arc < t.pos-3) t.stopI++;
    while(t.sigI<nl.signals.length && nl.signals[t.sigI].stop < t.pos-1) t.sigI++;
    makeBody(t);
  }
  function update(dt, simT){
    for(const t of list){
      const L=t.leg;
      // 閉そく: 区間に掛かっていれば確保、抜けたら解放
      for(const q of t.iv){ const near = t.pos > q.s0-30 && t.pos-t.len < q.s1+1; const B=blocks[q.b];
        if(near && B.owner===null) B.owner=t; }
      for(const b of blocks) if(b.owner===t && !t.iv.some(q=>blocks[q.b]===b && t.pos > q.s0-30 && t.pos-t.len < q.s1+1)) b.owner=null;
      if(t.dwell>0){ t.dwell-=dt; t.v=0; if(t.dwell<=0){ const st=L.stops[t.stopI]; if(st && st.turn){ flip(t); continue; } t.stopI++; } placeOn(t.obj, L.P, t.pos); continue; }
      // 目標速度
      let vmax = limit(L, t.pos) * 0.9 / 3.6, gap = 1e9;
      const st=L.stops[t.stopI];
      if(st){ const d=st.arc-t.pos; gap=Math.min(gap, d+0.4); if(d<0.6 && t.v<0.4){ t.dwell = st.dwell>0 ? st.dwell*(0.8+Math.random()*0.4) : 0.01; } }
      while(t.sigI<L.signals.length && L.signals[t.sigI].stop < t.pos-1) t.sigI++;
      const sg=L.signals[t.sigI];
      if(sg && sg.g!=null){ const d=sg.stop-t.pos, s=phaseState(sg.g, sg.ph, simT);
        if(d>-0.5 && (s===2 || (s===1 && d > t.v*t.v/2/1.0))) gap=Math.min(gap, d); }
      for(const q of t.iv){ if(t.pos < q.s0-1 && !blockFree(q.b, t)) gap=Math.min(gap, q.s0-4-t.pos); }
      const look = 12 + t.v*t.v/2/1.0 + t.v*2;
      const ob=gapAhead(L.P, t.pos, Math.min(80,look), t, 1.15);
      t.blockedBy = ob ? ob.o : null;
      if(ob) gap=Math.min(gap, ob.d-3.0);
      const vt = Math.min(vmax, Math.sqrt(Math.max(0, 2*1.0*Math.max(0,gap))));
      const a = vt>t.v ? Math.min(0.75, (vt-t.v)*0.8) : Math.max(-1.6, (vt-t.v)*2.0);
      t.v=Math.max(0, t.v + a*dt);
      if(gap<0.05 && t.v<0.3) t.v=0;
      t.pos=Math.min(L.P.len+2, t.pos + t.v*dt);
      placeOn(t.obj, L.P, t.pos);
    }
  }
  return {init, populate, update, registerAll, intervals, blockFree, clearAll, gapAhead, PLAYER, get list(){ return list; }, get blocks(){ return blocks; }, get ready(){ return ready; }};
})();

/* ---------- 自動車（AI） ---------- */
const PLAYER_POS={on:false,x:0,z:0,r:1,pts:[]};
const PCAR_REF={o:null};
const Traffic = (()=>{
  let D=null, segs=[], NL=0, sigNodes=null, jnode=null, meshes=null, ready=false;
  const cars=[]; const MAXN=240;
  // v24: 車種を増やし（日本の街の構成に近い割合）、形を細かく（車輪は円柱、ボンネット・窓の傾き、灯火・ナンバーは塗装色に染まらない）
  // 割合は仮定: 普通車 20%・軽（背の高い型 16%・一般 8%）・ミニバン 14%・SUV 8%・商用バン 6%・軽トラ 4%・2t 箱車 5%・4t 車 3%・路線バス 5%・タクシー 6%・バイク 5%
  const TYPES = [
    {name:"sedan", w:1.76, l:4.6, p:0.20, tl:0.85}, {name:"kei", w:1.48, l:3.4, p:0.16, tl:0.9}, {name:"kei2", w:1.48, l:3.4, p:0.08, tl:0.85},
    {name:"minivan", w:1.72, l:4.7, p:0.14, tl:1.0}, {name:"suv", w:1.84, l:4.6, p:0.08, tl:0.95}, {name:"van", w:1.7, l:4.7, p:0.06, tl:0.95},
    {name:"keitruck", w:1.48, l:3.4, p:0.04, tl:0.75}, {name:"truck", w:1.9, l:6.2, p:0.05, tl:0.9}, {name:"truck4", w:2.2, l:8.4, p:0.03, tl:0.95},
    {name:"bus", w:2.49, l:10.5, p:0.05, tl:0.9}, {name:"taxi", w:1.7, l:4.4, p:0.04, tl:0.95}, {name:"taxi2", w:1.7, l:4.6, p:0.02, tl:0.85},
    {name:"moto", w:0.75, l:1.9, p:0.05, tl:0.8} ];
  const PAINT = [["#f2f2f0",28],["#e9e7e1",8],["#c9ccd0",16],["#1c1d20",15],["#6b6f75",9],["#8a1d1d",4],["#1f3f78",5],["#5b4a3a",3],["#dfd6c0",4],["#2f5a3a",2],["#9fb7c9",3],["#e0c24a",1],["#b8a88a",2]];
  function paint(){ let r=Math.random()*PAINT.reduce((a,b)=>a+b[1],0); for(const [c,w] of PAINT){ if((r-=w)<=0) return c; } return PAINT[0][0]; }
  function geoFor(name){
    // 部品: 塗装（インスタンス色が掛かる）か固定色か（aPaint）。 +z 前
    const pos=[], nrm=[], col=[], pnt=[];
    const add=(g, c, paintIt)=>{ const n=g.toNonIndexed(); n.computeVertexNormals(); const pa=n.attributes.position.array, na=n.attributes.normal.array; const C=new THREE.Color(c);
      for(let i=0;i<pa.length;i++){ pos.push(pa[i]); nrm.push(na[i]); } for(let i=0;i<pa.length/3;i++){ col.push(C.r,C.g,C.b); pnt.push(paintIt?1:0); } g.dispose(); n.dispose(); };
    const PAINTC=0xffffff, GLASS=0x1f262d, TIRE=0x151515, RIM=0x8d9094, LAMP=0xf3efe4, TAIL=0x8a1410, TRIM=0x2a2c2f, PLATE=0xf4f4ee, KPLATE=0xf2d84a;
    const box=(w,h,l,x,y,z,c,p)=>{ const g=new THREE.BoxGeometry(w,h,l); g.translate(x,y,z); add(g,c,p); };
    // 台形の箱（上面が狭く・前後に傾く）: 下面 w0×l0、上面 w1×l1、上面の前後のずれ dz
    const tbox=(w0,w1,l0,l1,h,x,y,z,dz,c,p)=>{ const g=new THREE.BoxGeometry(1,1,1); const a=g.attributes.position;
      for(let i=0;i<a.count;i++){ const top=a.getY(i)>0; const W=top?w1:w0, L=top?l1:l0; a.setXYZ(i, x+a.getX(i)*W, y+(top?h:0), z+a.getZ(i)*L+(top?dz:0)); }
      add(g,c,p); };
    const wheel=(x,z,r,w)=>{ const g=new THREE.CylinderGeometry(r,r,w,12); g.rotateZ(Math.PI/2); g.translate(x,r,z); add(g,TIRE,false);
      const h=new THREE.CylinderGeometry(r*0.6,r*0.6,w+0.02,10); h.rotateZ(Math.PI/2); h.translate(x,r,z); add(h,RIM,false); };
    const wheels=(w,zf,zr,r)=>{ for(const z of [zf,zr]) for(const s of [1,-1]) wheel(s*(w/2-0.13),z,r,0.22); };
    const lamps=(w,l,y,kei)=>{ for(const s of [1,-1]){ box(0.34,0.12,0.04,s*(w/2-0.3),y,l/2+0.01,LAMP,false); box(0.3,0.14,0.04,s*(w/2-0.25),y,-l/2-0.01,TAIL,false); }
      box(0.33,0.17,0.02,0,y-0.25,l/2+0.02,kei?KPLATE:PLATE,false); box(0.33,0.17,0.02,0,y-0.2,-l/2-0.02,kei?KPLATE:PLATE,false); };
    if(name==="sedan"||name==="taxi2"){
      tbox(1.76,1.72,4.6,4.5,0.5,0,0.3,0,0,PAINTC,true);                      // 下の車体
      tbox(1.72,1.62,2.1,1.2,0.14,0,0.8,1.35,0.25,PAINTC,true);                // ボンネット
      tbox(1.66,1.34,2.6,1.7,0.6,0,0.8,-0.25,-0.1,GLASS,false);               // 窓（キャビン）
      tbox(1.36,1.3,1.7,1.6,0.05,0,1.4,-0.35,0,PAINTC,true);                   // 屋根
      box(1.7,0.12,0.6,0,0.62,-2.05,PAINTC,true);
      wheels(1.76,1.38,-1.38,0.32); lamps(1.76,4.6,0.72,false);
      if(name==="taxi2"){ box(0.5,0.2,0.26,0,1.55,-0.35,0xf2efe0,false); box(1.78,0.08,4.3,0,0.62,0,0x2b6c3f,false); }
    } else if(name==="kei"){      // 背の高い軽（N-BOX 型）
      tbox(1.48,1.46,3.4,3.35,0.55,0,0.3,0,0,PAINTC,true);
      tbox(1.46,1.4,3.3,2.5,0.95,0,0.85,-0.25,-0.1,GLASS,false);
      box(1.46,0.5,2.4,0,1.25,-0.35,PAINTC,true);                           // 窓の下の帯（側面の塗装）を重ねて窓を上下に分ける
      tbox(1.4,1.38,2.5,2.4,0.06,0,1.8,-0.3,0,PAINTC,true);
      tbox(1.44,1.42,0.7,0.35,0.35,0,0.85,1.3,-0.15,PAINTC,true);
      wheels(1.48,1.12,-1.12,0.28); lamps(1.48,3.4,0.78,true);
    } else if(name==="kei2"){
      tbox(1.48,1.46,3.4,3.3,0.5,0,0.3,0,0,PAINTC,true);
      tbox(1.44,1.3,2.5,1.9,0.72,0,0.8,-0.3,-0.05,GLASS,false);
      tbox(1.32,1.28,1.9,1.8,0.05,0,1.52,-0.35,0,PAINTC,true);
      tbox(1.44,1.4,0.8,0.5,0.2,0,0.8,1.25,-0.1,PAINTC,true);
      wheels(1.48,1.12,-1.12,0.28); lamps(1.48,3.4,0.72,true);
    } else if(name==="minivan"){
      tbox(1.72,1.7,4.7,4.65,0.55,0,0.3,0,0,PAINTC,true);
      tbox(1.7,1.6,3.9,3.3,1.0,0,0.85,-0.3,-0.2,GLASS,false);
      box(1.7,0.42,3.5,0,1.1,-0.45,PAINTC,true);
      tbox(1.6,1.56,3.3,3.2,0.06,0,1.85,-0.5,0,PAINTC,true);
      tbox(1.68,1.6,0.9,0.4,0.3,0,0.85,1.9,-0.2,PAINTC,true);
      wheels(1.72,1.45,-1.45,0.33); lamps(1.72,4.7,0.85,false);
    } else if(name==="suv"){
      tbox(1.84,1.8,4.6,4.5,0.62,0,0.38,0,0,PAINTC,true);
      tbox(1.8,1.72,1.3,1.0,0.16,0,1.0,1.6,0.1,PAINTC,true);
      tbox(1.76,1.5,2.9,2.2,0.62,0,1.0,-0.35,-0.15,GLASS,false);
      tbox(1.52,1.48,2.2,2.1,0.06,0,1.62,-0.5,0,PAINTC,true);
      box(1.2,0.05,1.6,0,1.7,-0.5,TRIM,false);
      wheels(1.84,1.4,-1.4,0.37); lamps(1.84,4.6,0.9,false);
    } else if(name==="van"){       // 商用バン（ハイエース型）
      tbox(1.7,1.7,4.7,4.7,0.6,0,0.3,0,0,PAINTC,true);
      tbox(1.7,1.66,4.55,4.3,1.0,0,0.9,-0.1,-0.1,GLASS,false);
      box(1.7,0.55,4.0,0,1.25,-0.35,PAINTC,true);
      box(1.66,0.08,4.3,0,1.94,-0.15,PAINTC,true);
      wheels(1.7,1.4,-1.35,0.33); lamps(1.7,4.7,0.85,false);
    } else if(name==="keitruck"){
      tbox(1.48,1.46,1.45,1.3,0.55,0,0.35,1.0,0,PAINTC,true);
      tbox(1.46,1.4,1.3,1.0,0.7,0,0.9,1.0,-0.1,GLASS,false);
      box(1.42,0.05,1.0,0,1.62,0.95,PAINTC,true);
      box(1.46,0.08,1.95,0,0.72,-0.72,PAINTC,true);                      // 荷台の床
      for(const s of [1,-1]) box(0.04,0.3,1.95,s*0.72,0.9,-0.72,PAINTC,true);
      box(1.46,0.3,0.04,0,0.9,-1.68,PAINTC,true); box(1.44,0.3,0.05,0,0.9,0.25,0x333333,false);
      box(1.3,0.3,3.2,0,0.35,0,TRIM,false);
      wheels(1.48,1.0,-0.95,0.27); lamps(1.48,3.4,0.6,true);
    } else if(name==="truck"||name==="truck4"){     // 2t・4t の箱車（荷台はアルミの箱。キャブが塗装色）
      const W=name==="truck"?1.9:2.2, L=name==="truck"?6.2:8.4, H=name==="truck"?2.9:3.3, cab=name==="truck"?1.7:1.9;
      tbox(W,W-0.05,cab,cab-0.1,0.9,0,0.5,L/2-cab/2,0,PAINTC,true);
      tbox(W-0.05,W-0.12,cab-0.1,cab-0.5,0.75,0,1.4,L/2-cab/2,-0.2,GLASS,false);
      box(W-0.12,0.35,cab-0.6,0,1.9,L/2-cab/2-0.2,PAINTC,true);
      box(W,H-0.9,L-cab-0.2,0,0.95+(H-0.9)/2,-cab/2-0.1,0xd8dadc,false);   // 荷箱
      box(W+0.01,0.25,L-cab-0.2,0,1.5,-cab/2-0.1,0x2d5a8c,false);         // 荷箱の帯
      box(W-0.3,0.35,L-0.6,0,0.55,0,TRIM,false);
      wheels(W,L/2-cab/2-0.1,-(L/2-1.4),0.42); if(name==="truck4") wheels(W,-(L/2-2.6),-(L/2-2.6),0.42);
      lamps(W,L,0.75,false);
    } else if(name==="bus"){
      box(2.49,2.5,10.5,0,1.75,0,PAINTC,true); box(2.51,1.05,9.3,0,2.1,-0.3,GLASS,false); box(2.3,1.3,0.06,0,2.15,5.25,GLASS,false);
      box(2.51,0.18,10.5,0,1.05,0,0x1f4d8c,false);                         // 窓の下の帯（事業者ごとの塗装は仮定の共通色）
      box(2.2,0.3,0.3,0,3.15,-1,0xbfc2c5,false); box(1.7,0.25,0.05,0,3.02,5.27,0x101010,false); box(1.5,0.14,0.04,0,2.95,5.29,0xff9a2a,false);
      wheels(2.49,3.4,-2.6,0.48); lamps(2.49,10.5,0.75,false);
    } else if(name==="taxi"){      // JPN TAXI 型（背の高いセダン、濃い藍色は塗装＝インスタンス色）
      tbox(1.7,1.68,4.4,4.35,0.55,0,0.3,0,0,PAINTC,true);
      tbox(1.66,1.5,3.3,2.4,0.8,0,0.85,-0.2,-0.1,GLASS,false);
      tbox(1.5,1.46,2.4,2.3,0.05,0,1.65,-0.3,0,PAINTC,true);
      tbox(1.66,1.6,0.9,0.5,0.2,0,0.85,1.75,-0.15,PAINTC,true);
      box(0.46,0.2,0.24,0,1.8,-0.2,0xf5f1df,false);
      wheels(1.7,1.35,-1.35,0.31); lamps(1.7,4.4,0.78,false);
    } else if(name==="moto"){      // 原付・バイク＋乗る人
      wheel(0,0.62,0.28,0.12); wheel(0,-0.62,0.28,0.12);
      box(0.3,0.35,1.1,0,0.55,0,PAINTC,true); box(0.28,0.12,0.6,0,0.82,-0.25,TRIM,false); box(0.6,0.04,0.04,0,1.05,0.5,TRIM,false);
      box(0.4,0.55,0.26,0,1.2,-0.2,0x2a2c30,false); box(0.26,0.26,0.28,0,1.62,-0.15,PAINTC,true);   // 人・ヘルメット
      box(0.14,0.45,0.14,0.15,0.75,0.0,0x2a2f3a,false); box(0.14,0.45,0.14,-0.15,0.75,0.0,0x2a2f3a,false);
      box(0.12,0.1,0.04,0,0.8,0.96,LAMP,false); box(0.12,0.08,0.04,0,0.7,-0.96,TAIL,false);
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos,3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm,3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col,3)); g.setAttribute("aPaint", new THREE.Float32BufferAttribute(pnt,1));
    return g;
  }
  function buildMeshes(){
    meshes={}; const mat=new THREE.MeshLambertMaterial({vertexColors:true});
    // v24: 塗装の部分だけインスタンス色を掛ける（灯火・窓・ナンバー・タイヤは固定色）
    mat.onBeforeCompile=(sh)=>{ sh.vertexShader=sh.vertexShader.replace("#include <common>","#include <common>\nattribute float aPaint;")
      .replace("#include <color_vertex>",`vColor = vec3(1.0);
        #ifdef USE_COLOR
          vColor.xyz *= color.xyz;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, aPaint);
        #endif`); };
    for(const T of TYPES){ const m=new THREE.InstancedMesh(geoFor(T.name), mat, MAXN); m.setColorAt(0, new THREE.Color(1,1,1)); m.count=0; m.frustumCulled=false; m.castShadow=true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); meshes[T.name]=m; }
    // 尾灯（ブレーキで明るく）
    const tg=new THREE.BoxGeometry(0.34,0.16,0.05);
    meshes.tail=new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({color:0xffffff}), MAXN*2); meshes.tail.setColorAt(0, new THREE.Color(1,0,0)); meshes.tail.count=0; meshes.tail.frustumCulled=false; scene.add(meshes.tail);
  }
  function init(data){
    D=data; NL=D.lanes.length; segs=[];
    D.lanes.forEach((l,i)=>{ const P=mkPath(l.p); segs.push({i, P, v:l.v, c:l.c, sig:l.sig, next:[], node:l.to, lane:true, k:l.k, n:l.n}); });
    D.conns.forEach((c,i)=>{ const P=mkPath(c.p); const s={i:NL+i, P, v:c.v, next:[c.b], node:c.node, lane:false, kind:c.k, from:c.a}; segs.push(s); segs[c.a].next.push(NL+i); });
    // v29: 出現させる車線を近くから選ぶための升目（250m）。範囲を広げると、全部の車線から無作為に選んでは近くに当たらない
    BK = new Map();
    for(let i=0;i<NL;i++){ const P=segs[i].P, seen=new Set();
      for(let k=0;k<P.n;k+=5){ const key=Math.floor(P.P[k*3]/BKS)+","+Math.floor(P.P[k*3+2]/BKS); if(seen.has(key)) continue; seen.add(key); let a=BK.get(key); if(!a){ a=[]; BK.set(key,a); } a.push(i); }
      const key=Math.floor(P.P[(P.n-1)*3]/BKS)+","+Math.floor(P.P[(P.n-1)*3+2]/BKS); if(!seen.has(key)){ let a=BK.get(key); if(!a){ a=[]; BK.set(key,a); } a.push(i); } }
    sigNodes=new Set(D.sig_nodes);
    // 信号の無い交差点（別方向から2本以上の車線が入る節点）は1台ずつ通す
    const dirs=new Map();
    for(const c of D.conns){ const a=segs[c.a].P; const n=a.n; const dx=a.P[(n-1)*3]-a.P[(n-2)*3], dz=a.P[(n-1)*3+2]-a.P[(n-2)*3+2]; const q=Math.round(Math.atan2(dz,dx)/(Math.PI/6));
      let s=dirs.get(c.node); if(!s){ s=new Set(); dirs.set(c.node,s); } s.add(q); }
    jnode=new Map(); for(const [n,s] of dirs) if(s.size>=2 && !sigNodes.has(n)) jnode.set(n, {owner:null, from:-1, t:0});
    // v14: 各区間から先へ走れる距離（上限 400m）。行き止まりへ入らないように使う
    for(const g of segs) g.reach=g.P.len;
    for(let it=0; it<40; it++){ let ch=false; for(const g of segs){ let m=0; for(const j of g.next) m=Math.max(m, segs[j].reach); const r=Math.min(400, g.P.len+m); if(r>g.reach+0.01){ g.reach=r; ch=true; } } if(!ch) break; }
    buildMeshes(); ready=true;
  }
  function chooseNext(seg){
    let nx=seg.next; if(!nx.length) return -1;
    const good=nx.filter(j=>segs[j].reach>=250); if(good.length) nx=good;     // 行き止まりの方へは曲がらない
    if(seg.lane){ let tot=0; const w=nx.map(j=>{ const k=segs[j].kind; const x = k==="s"?4:1.2; tot+=x; return x; }); let r=Math.random()*tot; for(let i=0;i<nx.length;i++){ if((r-=w[i])<=0) return nx[i]; } return nx[0]; }
    return nx[0];
  }
  function planAhead(c){
    let tot=segs[c.plan[0]].P.len - c.s;
    for(let i=1;i<c.plan.length;i++) tot+=segs[c.plan[i]].P.len;
    c.endAhead=false;
    while(tot<110 && c.plan.length<8){ const last=segs[c.plan[c.plan.length-1]]; const n=chooseNext(last); if(n<0){ c.endAhead=true; break; } c.plan.push(n); tot+=segs[n].P.len; }
  }
  /* 計画した経路上で、先頭から d 先の点 */
  function aheadPt(c, d, out){
    let s=c.s+d, i=0;
    while(i<c.plan.length-1 && s>segs[c.plan[i]].P.len){ s-=segs[c.plan[i]].P.len; i++; }
    return pathPt(segs[c.plan[i]].P, s, out);
  }
  let pmap=null;
  let BK=null; const BKS=250; let _cand=null, _candKey="";
  function nearLanes(center, rmax){
    const key=Math.round(center.x/50)+","+Math.round(center.z/50)+","+rmax; if(key===_candKey) return _cand;
    const set=new Set(), r=Math.ceil(rmax/BKS), ix=Math.floor(center.x/BKS), iz=Math.floor(center.z/BKS);
    for(let a=ix-r;a<=ix+r;a++) for(let b=iz-r;b<=iz+r;b++){ const L=BK.get(a+","+b); if(L) for(const i of L) set.add(i); }
    _cand=[...set]; _candKey=key; return _cand;
  }
  function spawnCar(c, center, rmin, rmax, avoidView){
    const cand = BK ? nearLanes(center, rmax) : null;
    if(cand && !cand.length) return false;
    for(let tries=0;tries<80;tries++){
      const seg=segs[cand ? cand[Math.floor(Math.random()*cand.length)] : Math.floor(Math.random()*NL)];
      if(seg.P.len<20 || seg.reach<250 || Math.random()>seg.P.len/90) continue;
      if((seg.c==="u"||seg.c==="r") && Math.random()<0.8) continue;
      const s=4+Math.random()*(seg.P.len-8); const p=pathPt(seg.P, s);
      const d=Math.hypot(p.x-center.x, p.z-center.z); if(d<rmin||d>rmax) continue;
      if(avoidView){ const v=new THREE.Vector3(p.x-camera.position.x, 0, p.z-camera.position.z); const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; if(d<320 && v.normalize().dot(f.normalize())>0.2) continue; }
      if(Obs.hit(p.x,p.z,7,null)) continue;
      if(cars.some(o=>o!==c && o.x!==undefined && Math.hypot(o.x-p.x,o.z-p.z)<9)) continue;
      const T=pickType(); c.type=T; c.plan=[seg.i]; c.s=s; c.v=Math.min(seg.v/3.6*0.7, 8); c.v0=0.72+Math.random()*0.18; c.dead=false; c.deadT=0; c.wait=0; c.ghost=0; c.blockedBy=null; c.hold=null;
      c.color=new THREE.Color(T.name==="bus" ? ["#f3efe2","#e9eef2","#f2e7cf"][Math.floor(Math.random()*3)] : T.name==="taxi" ? (Math.random()<0.8?"#1d2440":"#1c1d20") : T.name==="taxi2" ? (Math.random()<0.5?"#e9d23c":"#f2f2ef") : (T.name==="van"||T.name==="keitruck") ? (Math.random()<0.85?"#f2f2f0":paint()) : (T.name==="truck"||T.name==="truck4") ? ["#f2f2f0","#f2f2f0","#2c5d9a","#3a8a4a","#d9d9d6"][Math.floor(Math.random()*5)] : paint());
      planAhead(c); pose(c); return true;
    }
    return false;
  }
  function pickType(){ let r=Math.random(); for(const T of TYPES){ if((r-=T.p)<=0) return T; } return TYPES[0]; }
  const _a=new THREE.Vector3(), _b=new THREE.Vector3(), _q=new THREE.Vector3();
  function pose(c){
    const hl=c.type.l/2; aheadPtBack(c, hl*0.8, _a); aheadPtBack(c, -hl*0.8, _b);
    c.x=(_a.x+_b.x)/2; c.y=(_a.y+_b.y)/2; c.z=(_a.z+_b.z)/2;
    c.dx=_a.x-_b.x; c.dz=_a.z-_b.z; const L=Math.hypot(c.dx,c.dz)||1; c.dx/=L; c.dz/=L;
    c.pitch=Math.atan2(_a.y-_b.y, L);
  }
  // 後ろ側（現在の区間の手前）は、区間の始点より前なら直線延長
  function aheadPtBack(c, d, out){ if(d>=0) return aheadPt(c, d, out); return pathPt(segs[c.plan[0]].P, c.s+d, out); }
  function prio(c){ const s=segs[c.plan[0]]; const k=s.lane ? (c.plan[1]!=null ? segs[c.plan[1]].kind : "s") : s.kind; return k==="s"?3:k==="l"?2:1; }
  function register(){
    for(const c of cars){ if(!c.type) continue; Obs.addBody(c.x+c.dx*c.type.l/2, c.z+c.dz*c.type.l/2, c.dx, c.dz, c.type.l, c.type.w/2+0.1, c); }
  }
  let respT=0;
  const _f=new THREE.Vector3();
  function inView(x,z){ const dx=x-camera.position.x, dz=z-camera.position.z, d=Math.hypot(dx,dz); if(d>260) return false; camera.getWorldDirection(_f); return d<25 || (dx*_f.x+dz*_f.z)/d > 0.35; }
  function update(dt, simT, center){
    if(!ready) return;
    // 台数を保つ・遠い車は入れ替え
    respT-=dt;
    if(respT<=0){ respT=0.4;
      for(const c of cars){ const far = c.type && Math.hypot(c.x-center.x, c.z-center.z)>480;
        if(!c.type || far || (c.dead && (!inView(c.x,c.z) || c.deadT>10))){ if(!spawnCar(c, center, 200, 450, true)) c.type=null; } }
      let add=0; while(cars.length<MAXN && add++<30){ const c={id:cars.length}; if(spawnCar(c, center, 20, 420, false)) cars.push(c); else break; }
    }
    for(const c of cars){
      if(!c.type) continue;
      const seg=segs[c.plan[0]]; const hl=c.type.l/2;
      let vlim = (seg.lane ? seg.v : Math.min(segs[segs[c.plan[0]].next[0]].v, seg.v)) / 3.6 * c.v0;
      let gap=1e9;
      // 前方の曲がり（接続の制限速度）
      let acc=seg.P.len-c.s;
      for(let i=1;i<c.plan.length && acc<80;i++){ const q=segs[c.plan[i]]; if(!q.lane){ const vc=q.v/3.6; vlim=Math.min(vlim, Math.sqrt(vc*vc+2*2.0*Math.max(0,acc-hl))); } acc+=q.P.len; }
      if(!seg.lane){ vlim=Math.min(vlim, seg.v/3.6); }
      // 信号（現在の車線と次の車線）
      acc=0;
      for(let i=0;i<c.plan.length && acc<120;i++){
        const q=segs[c.plan[i]]; const base = i===0 ? -c.s : acc;
        if(q.lane && q.sig){ const d=base+q.sig.s-hl;
          if(d<=-0.3 && d>-6){ c.passedG=q.sig.g; c.passedT=simT; }
          if(d>-0.3 && !(c.passedG===q.sig.g && simT-c.passedT<45)){ const st=phaseState(q.sig.g, q.sig.ph, simT);
            if(st===2 || (st===1 && d > c.v*c.v/2/3.5)) { gap=Math.min(gap, d); break; } } }
        // 信号の無い交差点: 空くまで車線の終わりで待つ
        if(q.lane && i+1<c.plan.length){ const J=jnode.get(q.node);
          if(J){ const d=base+q.P.len-hl; if(d<18){ if(J.owner && J.owner!==c && J.from!==q.i && simT-J.t<5){ if(d>-0.5) gap=Math.min(gap, d); } else if(d<6){ J.owner=c; J.from=q.i; J.t=simT; } } } }
        acc += i===0 ? q.P.len-c.s : q.P.len;
      }
      // 進路上の障害物（車・電車・プレイヤー）
      const look=Math.min(70, 8 + c.v*c.v/2/3.0 + c.v*1.4);
      const self=c, pr=prio(c);
      // 相手も自分を待っているときは、優先度の低い方が待つ（電車に対しては車が先に抜ける＝線路上に居座らない）
      const e0r=(q)=>0.85;
      const skip=(o)=> c.ghost>0 && o.type ? true : o.leg ? o.blockedBy===c : (o.type && (
        // 対向車（向きが逆）は、進路の中心から 1.2m 以内に車体の中心がある時だけ（狭い道のすれ違いで止まらない）
        ((o.dx*c.dx+o.dz*c.dz) < -0.5 && Math.hypot(o.x-_q.x, o.z-_q.z) > 1.2 + o.type.l*0.5) ||
        (o.blockedBy===c && (prio(o)<pr || (prio(o)===pr && o.id>c.id)))));
      c.blockedBy=null;
      for(let d=0.6; d<=look; d+=1.8){ aheadPt(c, hl+d, _q); const e=Obs.hit(_q.x,_q.z, e0r(_q), self,skip); if(e){ gap=Math.min(gap, d-0.4-e.r*0.3); c.blockedBy=e.o; break; } }
      // 交差点の先が詰まっていたら、交差点に入らず手前で待つ（交差点内で止まって横の流れをふさがない）
      if(c.plan.length>=3 && seg.lane){ const cn=segs[c.plan[1]], ex=segs[c.plan[2]]; if(cn && !cn.lane && ex){
          const dEnd=seg.P.len-c.s-hl; if(dEnd<14 && dEnd>-0.5){ pathPt(ex.P, Math.min(ex.P.len, c.type.l+2.5), _q);
            const e=Obs.hit(_q.x,_q.z,1.4,self,(o)=>!o.type || o===c || o.v>1.5); if(e){ gap=Math.min(gap, dEnd); if(!c.blockedBy) c.blockedBy=e.o; } } } }
      // 道の終わり（行き止まり）では手前で止まる
      if(c.endAhead){ let rem=segs[c.plan[0]].P.len-c.s; for(let i=1;i<c.plan.length;i++) rem+=segs[c.plan[i]].P.len; gap=Math.min(gap, rem-hl-1); }
      // 利用者の車・バス: 進路の前方（左右 3.2m・扇形）にいれば止まる（割り込み・横切りにも対応）
      if(PLAYER_POS.on && Math.hypot(PLAYER_POS.x-c.x, PLAYER_POS.z-c.z)<45){
        for(const q of PLAYER_POS.pts){ const px=q[0]-c.x, pz=q[1]-c.z, fwd=px*c.dx+pz*c.dz, lat=Math.abs(px*c.dz-pz*c.dx);
          // 自分の車線の幅（左右 1.1m＋相手の半幅）に入っていれば、その手前で止まる
          if(fwd>0 && fwd<40 && lat<1.1+PLAYER_POS.r) gap=Math.min(gap, fwd-hl-PLAYER_POS.r-1.5); } }
      // 安全運転: 車間は 3m＋速度×1.5秒、加速は穏やか
      const vt=Math.min(vlim, Math.sqrt(Math.max(0, 2*2.5*Math.max(0,gap-3.0-c.v*1.5))));
      const a = vt>c.v ? Math.min(1.3, (vt-c.v)*0.9) : Math.max(-6, (vt-c.v)*2.6);
      c.brake = a < -0.6 || c.v < 0.5;
      c.v=Math.max(0, c.v + a*dt); if(gap<2.2 && c.v<0.5) c.v=Math.max(0,c.v-3*dt);
      // 行き詰まり（お互いに相手待ち）の解消
      // 相手待ちが輪になっている（または重なっている）ときだけ、少しの間ほかの車を無視して抜ける
      let cyc=false; if(c.v<0.2 && c.blockedBy && c.blockedBy.type){ let o=c.blockedBy; for(let k=0;k<8 && o && o.type;k++){ if(o===c){ cyc=true; break; } o=o.blockedBy; }
        if(Math.hypot(c.blockedBy.x-c.x, c.blockedBy.z-c.z)<2.5) cyc=true; }
      const nearP = PLAYER_POS.on && Math.hypot(PLAYER_POS.x-c.x, PLAYER_POS.z-c.z) < 30;
      if(cyc && !nearP){ c.wait+=dt; if(c.wait>4){ c.ghost=2.5; c.wait=0; } } else c.wait=Math.max(0,c.wait-dt);
      // 長く止まったまま（信号待ちではない）の車は入れ替える（見えていない所で）
      c.stopT = c.v<0.3 ? (c.stopT||0)+dt : 0;
      if(c.stopT>35 && !inView(c.x,c.z)) { c.dead=true; c.deadT=99; }
      if(c.endAhead && c.stopT>3) { c.dead=true; c.deadT=(c.deadT||0)+dt; }
      c.ghost=Math.max(0,c.ghost-dt);
      // 進める
      c.s+=c.v*dt;
      while(c.plan.length>1 && c.s>segs[c.plan[0]].P.len+hl){ const q=segs[c.plan[0]]; c.s-=q.P.len; if(!q.lane){ const J=jnode.get(q.node); if(J && J.owner===c) J.owner=null; } c.plan.shift(); }
      if(c.endAhead && c.v<0.2){ let rem=segs[c.plan[0]].P.len-c.s; for(let i=1;i<c.plan.length;i++) rem+=segs[c.plan[i]].P.len; if(rem<hl+4){ c.dead=true; c.deadT=(c.deadT||0)+dt; } }
      planAhead(c);
      pose(c);
    }
    draw();
  }
  const _m=new THREE.Matrix4(), _e=new THREE.Euler(), _qt=new THREE.Quaternion(), _s=new THREE.Vector3(1,1,1), _v=new THREE.Vector3();
  const RED_ON=new THREE.Color(1.0,0.12,0.08), RED_OFF=new THREE.Color(0.45,0.05,0.04);
  function draw(){
    const cnt={}; for(const T of TYPES) cnt[T.name]=0; let tc=0;
    for(const c of cars){ if(!c.type) continue; const m=meshes[c.type.name]; const i=cnt[c.type.name]++;
      _e.set(-c.pitch, Math.atan2(c.dx,c.dz), 0); _qt.setFromEuler(_e); _v.set(c.x, c.y, c.z); _m.compose(_v,_qt,_s); m.setMatrixAt(i,_m); m.setColorAt(i,c.color);
      // 尾灯2つ
      for(const sx of (c.type.name==="moto"?[0]:[-1,1])){ const lx=sx*(c.type.w/2-0.25), lz=-c.type.l/2-0.03, ly = c.type.tl||0.82;
        const ox=Math.cos(Math.atan2(c.dx,c.dz))*lx + c.dx*lz, oz=-Math.sin(Math.atan2(c.dx,c.dz))*lx + c.dz*lz;
        _v.set(c.x+ox, c.y+ly, c.z+oz); _m.compose(_v,_qt,_s); meshes.tail.setMatrixAt(tc, _m); meshes.tail.setColorAt(tc, c.brake?RED_ON:RED_OFF); tc++; } }
    for(const T of TYPES){ const m=meshes[T.name]; m.count=cnt[T.name]; m.instanceMatrix.needsUpdate=true; if(m.instanceColor) m.instanceColor.needsUpdate=true; }
    meshes.tail.count=tc; meshes.tail.instanceMatrix.needsUpdate=true; if(meshes.tail.instanceColor) meshes.tail.instanceColor.needsUpdate=true;
  }
  function reset(){ cars.length=0; if(jnode) for(const J of jnode.values()) J.owner=null; }
  /* プレイヤーの車の出発点: 指定点に近い、指定方向の車線 */
  function startPose(x, z, dirx, dirz){
    let best=null, bd=1e9;
    for(let i=0;i<NL;i++){ const P=segs[i].P; for(let k=0;k<P.n-1;k++){ const px=P.P[k*3], pz=P.P[k*3+2]; const d=Math.hypot(px-x,pz-z); if(d>bd) continue;
      const tx=P.P[k*3+3]-px, tz=P.P[k*3+5]-pz, L=Math.hypot(tx,tz)||1; if((tx*dirx+tz*dirz)/L<0.9) continue; bd=d; best={x:px,z:pz,yaw:Math.atan2(tx,tz), lane:segs[i].k, n:segs[i].n}; } }
    return best;
  }
  /* 救済: いちばん近い車線（周りに車がいない所）。yaw に近い向きを優先 */
  function nearestLane(x, z, yaw){
    let best=null, bc=1e18; const fx=Math.sin(yaw), fz=Math.cos(yaw);
    for(let i=0;i<NL;i++){ const P=segs[i].P; if(P.len<12) continue;
      for(let k=1;k<P.n-1;k++){ const px=P.P[k*3], pz=P.P[k*3+2]; const d2=(px-x)**2+(pz-z)**2; if(d2>200*200 || d2>bc) continue;
        const s=P.C[k]; if(s<4 || s>P.len-6) continue;
        const tx=P.P[k*3+3]-P.P[k*3-3], tz=P.P[k*3+5]-P.P[k*3-3+2], L=Math.hypot(tx,tz)||1;
        const cost=d2 + (1-(tx*fx+tz*fz)/L)*60 + ((segs[i].c==="u"||segs[i].c==="r") ? 400 : 0);
        if(cost<bc && !Obs.hit(px,pz,4.5,PCAR_REF.o)){ bc=cost; best={x:px, z:pz, yaw:Math.atan2(tx,tz)}; } } }
    return best;
  }
  // 街灯の位置（車線の左 3.2m・高さ 8m・30m おき）
  function segsForLamps(){ const out=[]; for(const g of segs){ if(!g.lane) continue; for(let s=10; s<g.P.len; s+=30){ const q=pathPt(g.P,s), t=pathTan(g.P,s); out.push(q.x+t.z*3.2, q.y+8.0, q.z-t.x*3.2); } } return out; }
  return {init, update, register, reset, startPose, nearestLane, segsForLamps, get cars(){ return cars; }, get ready(){ return ready; }, get segs(){ return segs; }, get jnode(){ return jnode; }};
})();
/* ================= バスモード（v11）: 両備バス 西大寺線 岡山駅 → 天満屋 → 県庁前 → 東山 =================
   経路: data/bus.json（OSM の道路・一方通行・停留所の標柱、晴れバスナビの停車順から作成）
   車両: 三菱ふそう エアロスター（ノンステップ 10.5m 級）相当の簡略モデル。前扉・中扉（左側）、行先LED
   ※塗装は白地に紺・赤の帯としたが、両備バスの現行標準塗装は資料で確認できていない（写真があれば合わせられる） */

function ryobiTex(dest, side){
  // 側面 1024×320（長さ 10.5m × 高さ 3.2m）。side: "L"（扉側）/ "R"
  return canvasTex(1024, 320, (g,w,h)=>{
    const Y=(m)=>h-(m/3.2)*h, X=(m)=>(m/10.5)*w;           // m 単位 → px（x は後ろ 0 → 前 10.5）
    g.fillStyle="#f4f5f3"; g.fillRect(0,0,w,h);
    // 窓帯（黒）
    g.fillStyle="#141a20"; g.fillRect(X(0.35), Y(2.62), X(9.6)-X(0.35), Y(1.3)-Y(2.62));
    // 帯: 紺の裾・赤の細線（※推定）
    g.fillStyle="#1d3f86"; g.fillRect(0, Y(0.95), w, Y(0.3)-Y(0.95));
    g.fillStyle="#c8202c"; g.fillRect(0, Y(1.06), w, Y(0.98)-Y(1.06));
    g.fillStyle="rgba(0,0,0,.08)"; g.fillRect(0, Y(3.2), w, Y(3.05)-Y(3.2));
    // 窓柱
    g.fillStyle="#f4f5f3";
    for(let x=1.4; x<9.5; x+=1.28) g.fillRect(X(x), Y(2.62), 7, Y(1.3)-Y(2.62));
    if(side==="L"){
      // 前扉（前輪の前）・中扉（4枚折戸）
      const door=(x0,x1)=>{ g.fillStyle="#1b2127"; g.fillRect(X(x0), Y(2.7), X(x1)-X(x0), Y(0.28)-Y(2.7));
        g.fillStyle="#c9ccce"; g.fillRect(X(x0), Y(2.7), X(x1)-X(x0), 6); g.fillRect(X((x0+x1)/2)-2, Y(2.7), 4, Y(0.28)-Y(2.7)); };
      door(9.35, 10.35); door(4.6, 5.65);
      // 行先LED（側面・前扉の後ろ）
      g.fillStyle="#0c0c0c"; g.fillRect(X(7.6), Y(2.55), X(9.2)-X(7.6), Y(2.25)-Y(2.55));
      g.fillStyle="#ffb13a"; g.font="bold 20px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle";
      g.fillText((dest||"西大寺BC")+" 行", X(8.4), Y(2.4));
      g.fillStyle="#1d3f86"; g.font="bold 22px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.fillText("両備バス", X(7.2), Y(0.62));
    } else {
      g.fillStyle="#1d3f86"; g.font="bold 22px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle";
      g.fillText("両備バス", X(3.3), Y(0.62));
    }
    g.fillStyle="#1d3f86"; g.font="italic bold 26px Georgia,serif"; g.textAlign="center"; g.fillText("Ryobi", X(side==="L"?2.8:7.2), Y(1.75));
    g.fillStyle="#333"; g.font="bold 15px Arial,sans-serif"; g.fillText("2507", X(side==="L"?9.9:0.8), Y(0.5));
  });
}
function ryobiFrontTex(dest){
  return canvasTex(256, 320, (g,w,h)=>{
    g.fillStyle="#f4f5f3"; g.fillRect(0,0,w,h);
    g.fillStyle="#141a20"; g.fillRect(10, h*0.16, w-20, h*0.52);                     // 大きな前面ガラス
    g.fillStyle="#0c0c0c"; g.fillRect(24, h*0.03, w-48, h*0.1);                       // 行先LED
    g.fillStyle="#ffb13a"; g.textAlign="center"; g.textBaseline="middle";
    const t=(dest||"西大寺BC"); let fs=24; do{ g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; }while(g.measureText(t).width>w-80 && fs>10);
    g.fillText(t, w/2+14, h*0.08); g.fillStyle="#7dff7a"; g.font="bold 18px Arial"; g.fillText("314", 42, h*0.08);
    g.fillStyle="#1d3f86"; g.fillRect(0, h*0.8, w, h*0.2); g.fillStyle="#c8202c"; g.fillRect(0, h*0.77, w, h*0.025);
    g.fillStyle="#fff7da"; g.beginPath(); g.arc(34, h*0.86, 12, 0, 7); g.arc(w-34, h*0.86, 12, 0, 7); g.fill();
    g.fillStyle="#fff"; g.font="bold 16px Arial"; g.fillText("RYOBI", w/2, h*0.9);
  });
}
function makeRyobiBus(dest){
  const g = new THREE.Group();
  const Lb=10.5, W=2.49, y0=0.3, y1=3.1;
  const sideL=new THREE.MeshPhongMaterial({map:ryobiTex(dest,"L"), shininess:50, specular:0x555555});
  const sideR=new THREE.MeshPhongMaterial({map:ryobiTex(dest,"R"), shininess:50, specular:0x555555});
  sideR.map.wrapS=THREE.RepeatWrapping; sideR.map.repeat.x=-1; sideR.map.offset.x=1;
  const front=new THREE.MeshPhongMaterial({map:ryobiFrontTex(dest), shininess:70, specular:0x777777});
  const white=new THREE.MeshPhongMaterial({color:0xf2f3f1, shininess:40, specular:0x444444});
  const dark=new THREE.MeshLambertMaterial({color:0x202326});
  // 車体: +x=左（扉側）、+z=前。BoxGeometry の面順 [+x,-x,+y,-y,+z,-z]
  const rear=new THREE.MeshPhongMaterial({map:canvasTex(256,320,(g,w,h)=>{ g.fillStyle="#f4f5f3"; g.fillRect(0,0,w,h);
      g.fillStyle="#141a20"; g.fillRect(30,h*0.22,w-60,h*0.3); g.fillStyle="#0c0c0c"; g.fillRect(60,h*0.05,w-120,h*0.1); g.fillStyle="#7dff7a"; g.font="bold 22px Arial"; g.textAlign="center"; g.textBaseline="middle"; g.fillText("314",w/2,h*0.1);
      g.fillStyle="#1d3f86"; g.fillRect(0,h*0.8,w,h*0.2); g.fillStyle="#c8202c"; g.fillRect(0,h*0.77,w,h*0.025);
      g.fillStyle="#9a1010"; g.fillRect(14,h*0.56,26,h*0.16); g.fillRect(w-40,h*0.56,26,h*0.16); g.fillStyle="#1d3f86"; g.font="bold 20px sans-serif"; g.fillText("両備バス",w/2,h*0.66); }), shininess:40});
  const body=new THREE.Mesh(new THREE.BoxGeometry(W, y1-y0, Lb), [sideL, sideR, white, dark, front, rear]);
  body.position.set(0,(y0+y1)/2,0); g.add(body);
  // 前面ガラスのつや・屋根上の冷房装置
  const ac=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.28,2.6), white); ac.position.set(0,y1+0.14,-0.5); g.add(ac);
  const hood=new THREE.Mesh(new THREE.BoxGeometry(W*0.96,0.08,0.4), white); hood.position.set(0,y1-0.02,Lb/2-0.15); g.add(hood);
  // バンパー・ミラー
  const bump=new THREE.Mesh(new THREE.BoxGeometry(W+0.04,0.3,0.25), dark); bump.position.set(0,0.42,Lb/2+0.05); g.add(bump);
  const bump2=bump.clone(); bump2.position.z=-Lb/2-0.05; g.add(bump2);
  const outer=[];
  for(const s of [1,-1]){ const arm=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.05,0.6), dark); arm.position.set(s*1.35,2.4,Lb/2+0.2); g.add(arm);
    const mir=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.36,0.2), dark); mir.position.set(s*1.45,2.1,Lb/2+0.45); g.add(mir); outer.push(arm,mir); }
  outer.push(body, ac, hood);
  // 運転席（運転席視点で表示）: 大きな平たいハンドル・計器盤・前面ガラスの枠
  const cab=new THREE.Group(); cab.visible=false; g.add(cab);
  const dashM=new THREE.MeshLambertMaterial({color:0x2b2e31}), trimM=new THREE.MeshLambertMaterial({color:0x3c4044});
  const dashB=new THREE.Mesh(new THREE.BoxGeometry(2.3,0.35,0.7), dashM); dashB.position.set(0,1.62,Lb/2-0.45); cab.add(dashB);
  const inst=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.22,0.12), new THREE.MeshLambertMaterial({color:0x14171a})); inst.position.set(-0.72,1.86,Lb/2-0.62); inst.rotation.x=-0.5; cab.add(inst);
  const wheelG=new THREE.Group(); wheelG.position.set(-0.72,1.78,Lb/2-0.98); wheelG.rotation.x=-1.25; cab.add(wheelG);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(0.24,0.022,10,40), new THREE.MeshLambertMaterial({color:0x1c1c1c})); wheelG.add(rim);
  const sp=new THREE.Mesh(new THREE.BoxGeometry(0.46,0.04,0.02), trimM); wheelG.add(sp);
  for(const s of [1,-1]){ const pil=new THREE.Mesh(new THREE.BoxGeometry(0.05,1.5,0.05), trimM); pil.position.set(s*1.22,2.35,Lb/2-0.03); cab.add(pil); }
  const top=new THREE.Mesh(new THREE.BoxGeometry(2.45,0.36,0.12), trimM); top.position.set(0,2.95,Lb/2-0.08); cab.add(top);
  const ledIn=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.14,0.05), new THREE.MeshBasicMaterial({color:0x221a08})); ledIn.position.set(0.5,2.82,Lb/2-0.18); cab.add(ledIn);
  const fare=new THREE.Mesh(new THREE.BoxGeometry(0.35,0.9,0.35), trimM); fare.position.set(0.1,1.2,Lb/2-1.3); cab.add(fare);
  // 車輪（前 2.55m・後 -2.75m）
  const wg=new THREE.CylinderGeometry(0.48,0.48,0.3,18); wg.rotateZ(Math.PI/2);
  const wheels=[];
  for(const z of [2.55,-2.75]) for(const s of [1,-1]){ const w=new THREE.Mesh(wg, dark); w.position.set(s*(W/2-0.2),0.48,z); g.add(w); wheels.push(w); }
  // 扉（開閉するパネル: 左側面の外側に重ねる）
  const doorM=new THREE.MeshLambertMaterial({color:0x1b2127});
  const mkDoor=(zc, wlen)=>{ const panels=[]; for(const s of [-1,1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(0.04,2.35,wlen/2), doorM); p.position.set(W/2+0.02, 1.5, zc+s*wlen/4); g.add(p); panels.push({p, z0:zc+s*wlen/4, s}); } return panels; };
  const df=mkDoor(Lb/2-0.65, 1.0), dm=mkDoor(-0.12, 1.05);
  // 尾灯
  for(const s of [1,-1]){ const t=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.5,0.04), new THREE.MeshBasicMaterial({color:0x8a1010})); t.position.set(s*1.0,1.0,-Lb/2-0.03); g.add(t); }
  g.userData={doors:[df,dm], wheels, len:Lb, open:0, outer, cab, wheelG};
  return g;
}
function setBusDoors(bus, t){      // t: 0=閉 1=開
  bus.userData.open=t;
  for(const panels of bus.userData.doors) for(const d of panels){ d.p.position.z = d.z0 + d.s*0.24*t; d.p.position.x = 2.49/2+0.02+0.06*t; }
}

/* 停留所の標柱（名前入り）・待っている人 */
function stopPoleTex(name){
  return canvasTex(256, 256, (g,w,h)=>{
    g.fillStyle="#ffffff"; g.beginPath(); g.arc(w/2,h/2,120,0,7); g.fill();
    g.strokeStyle="#1d3f86"; g.lineWidth=14; g.stroke();
    g.fillStyle="#1d3f86"; g.font="bold 22px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle";
    g.fillText("両備バス", w/2, h*0.3);
    let fs=40; do{ g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; }while(g.measureText(name).width>196 && fs>14);
    g.fillStyle="#111"; g.fillText(name, w/2, h*0.55);
    g.fillStyle="#1d3f86"; g.font="bold 18px Arial"; g.fillText("BUS STOP", w/2, h*0.78);
  });
}
function bayTex(num, lines){
  return canvasTex(512, 160, (g,w,h)=>{
    g.fillStyle="#1d2a44"; g.fillRect(0,0,w,h);
    g.fillStyle="#ffd33d"; g.fillRect(0,0,120,h); g.fillStyle="#111"; g.font="bold 86px Arial"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(num, 60, h/2+4);
    g.fillStyle="#fff"; g.textAlign="left";
    lines.slice(0,3).forEach((t,i)=>{ let fs=30; do{ g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; }while(g.measureText(t).width>370 && fs>12); g.fillText(t, 136, 32+i*48); });
  });
}
function signBoardTex(text, sub){
  return canvasTex(1024, 128, (g,w,h)=>{
    g.fillStyle="#f6f6f2"; g.fillRect(0,0,w,h); g.fillStyle="#1d3f86"; g.fillRect(0,h-14,w,14);
    g.fillStyle="#172033"; g.font="bold 64px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(text, w/2, sub?46:h/2-4);
    if(sub){ g.font="bold 30px Arial"; g.fillStyle="#556"; g.fillText(sub, w/2, 98); }
  });
}
function makePerson(seed){
  const g=new THREE.Group(); const r=((seed*9301+49297)%233280)/233280;
  const cols=[0x2d3a4a,0x6a4b3a,0x8c2f2f,0x3d5c3a,0xd8d2c4,0x1f1f24,0x4a5a8a];
  const body=new THREE.Mesh(new THREE.CylinderGeometry(0.19,0.21,0.95,8), new THREE.MeshLambertMaterial({color:cols[Math.floor(r*cols.length)]})); body.position.y=1.0; g.add(body);
  const legs=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.13,0.55,8), new THREE.MeshLambertMaterial({color:0x26282c})); legs.position.y=0.28; g.add(legs);
  const head=new THREE.Mesh(new THREE.SphereGeometry(0.13,10,8), new THREE.MeshLambertMaterial({color:0xe0bfa0})); head.position.y=1.6; g.add(head);
  const hair=new THREE.Mesh(new THREE.SphereGeometry(0.135,10,6,0,Math.PI*2,0,Math.PI*0.55), new THREE.MeshLambertMaterial({color:r>0.8?0x8a8a8a:0x1b1612})); hair.position.y=1.62; g.add(hair);
  g.scale.setScalar(0.92+r*0.14); return g;
}

const CEIL=[[-150,-26,-73,110,6.5]];   // 屋根の下（カメラを屋根より下に）[x0,z0,x1,z1,y]。最初は岡山駅東口バスターミナルの上屋
const Bus = (() => {
  let D=null, P=null, active=false, model=null, furn=null, ribbon=null;
  const st = { idx:0, s:0, stopI:1, doors:false, doorT:0, dwell:0, dwellNeed:0, score:1000, pax:12, req:false, reqT:0, done:false,
               sigI:0, off:false, offT:0, annNext:false, comfortHits:0, lastWarn:0, waiting:[], alight:[] };
  function init(data){
    D=data; P=mkPath(data.path);
    D.stops.forEach((s,i)=>{ if(i>0) BUS_ANN["next_"+i]={ text: i===D.stops.length-1 ? "次は、終点、"+s.name+"です。" : "次は、"+s.name+"です。お降りの方は、お近くのボタンでお知らせください。" }; });
    buildFurniture();
  }
  /* ---- 停留所・ターミナルの設備 ---- */
  function buildFurniture(){
    furn=new THREE.Group(); scene.add(furn);
    const poleM=new THREE.MeshLambertMaterial({color:0x9aa0a6});
    const hAt=(x,z)=>Car.hAt(x,z);
    D.stops.forEach((s,i)=>{
      if(s.bay) return;                                    // のりば（ターミナル）は別に作る
      const [x,z]=s.pole, y=hAt(x,z)+0.15;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,2.6,8), poleM); pole.position.set(x,y+1.3,z); furn.add(pole);
      const plate=new THREE.Mesh(new THREE.CircleGeometry(0.34,24), new THREE.MeshLambertMaterial({map:stopPoleTex(s.name.replace(/・高校前$/,"・高校前")), side:THREE.DoubleSide}));
      plate.position.set(x,y+2.45,z); plate.userData.face=true; furn.add(plate); s._plate=plate;
      const box=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.55,0.08), new THREE.MeshLambertMaterial({color:0xf2f2ef})); box.position.set(x,y+1.45,z); furn.add(box); s._box=box;
      const base=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.3,0.12,12), new THREE.MeshLambertMaterial({color:0x6d7176})); base.position.set(x,y+0.06,z); furn.add(base);
    });
    buildTenmaya(); buildStationBays();
    // 経路の案内帯
    ribbon=new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({color:0x3fa0ff, transparent:true, opacity:0.38, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-6, polygonOffsetUnits:-10}));
    ribbon.visible=false; scene.add(ribbon);
  }
  function orientPlates(){
    // 標柱の板は道路側（経路の点）へ向ける
    for(const s of D.stops){ if(!s._plate) continue; const q=pathPt(P, s.arc); const a=Math.atan2(q.x-s.pole[0], q.z-s.pole[1]); s._plate.rotation.y=a+Math.PI/2; s._box.rotation.y=a+Math.PI/2; }
  }
  // 天満屋バスステーション: 建物（PLATEAU）の東西両側にバスの乗り場。庇（ひさし）・のりば番号・案内板
  function buildTenmaya(){
    const g=new THREE.Group(); furn.add(g);
    const canM=new THREE.MeshLambertMaterial({color:0xd9dbdc}), canU=new THREE.MeshLambertMaterial({color:0xf4f4f0, emissive:0x202020}), curbM=new THREE.MeshLambertMaterial({color:0xb7b4ad});
    const y0=Car.hAt(810,410);
    for(const [xb, dir] of [[809.9, 1], [788.5, -1]]){           // 東側（1〜8番）・西側（9〜17番）
      const x0=xb, x1=xb+dir*10.5, xm=(x0+x1)/2;
      const top=new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1-x0),0.35,108), canM); top.position.set(xm, y0+5.3, 409); g.add(top);
      CEIL.push([Math.min(x0,x1)-1, 354, Math.max(x0,x1)+1, 464, y0+4.7]);
      const und=new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1-x0),108), canU); und.rotation.x=Math.PI/2; und.position.set(xm, y0+5.12, 409); g.add(und);
      // のりばの縁石: 駅舎の壁（東 808.6・西 788.5）から車道側へ 1.3m
      const cx0 = dir>0 ? 808.6 : 787.2; const curb=new THREE.Mesh(new THREE.BoxGeometry(1.3,0.18,96), curbM); curb.position.set(cx0+0.65, y0+0.09, 407); g.add(curb);
      for(let z=362; z<=458; z+=12){ const lamp=new THREE.Mesh(new THREE.BoxGeometry(1.2,0.05,0.25), new THREE.MeshBasicMaterial({color:0xfdfbf2})); lamp.position.set(xm, y0+5.09, z); g.add(lamp); }
    }
    // のりば番号（OSM の標柱位置。東 1〜8、西 9〜17）
    const tenBays = (D.bays && D.bays.tenmaya) || [];
    for(const b of tenBays){
      const east = b.x > 798, xs = east ? 811.2 : 787.2;
      const sign=new THREE.Mesh(new THREE.PlaneGeometry(1.9,0.6), new THREE.MeshLambertMaterial({map:bayTex(b.ref, b.ref==="4"?["西大寺BC行","天満屋・県庁・東山経由","両備バス"]:["のりば "+b.ref]), side:THREE.DoubleSide}));
      sign.position.set(xs, y0+3.3, b.z); sign.rotation.y = east ? Math.PI/2 : -Math.PI/2; g.add(sign);
      const rod=new THREE.Mesh(new THREE.BoxGeometry(0.04,1.7,0.04), new THREE.MeshLambertMaterial({color:0x444})); rod.position.set(xs, y0+4.4, b.z); g.add(rod);
    }
    const nm=new THREE.Mesh(new THREE.PlaneGeometry(14,1.75), new THREE.MeshLambertMaterial({map:signBoardTex("天満屋バスステーション","TENMAYA BUS STATION")}));
    nm.position.set(799, y0+6.3, 356.2); nm.rotation.y=Math.PI; g.add(nm);
    CEIL.push([774, 459.4, 825, 465.5, y0+4.8]);      // 南側の構内通路（2階の連絡通路の下）
    CEIL.push([809, 367.2, 829, 374.8, y0+4.8]);      // 東側の道路の上の連絡通路
  }
  // 岡山駅東口: のりば番号の案内板（OSM の 1〜13 番の標柱位置）
  function buildStationBays(){
    const bays=(D.bays && D.bays.station) || [];
    for(const b of bays){
      const y=Car.hAt(b.x,b.z);
      const lines = b.ref==="13" ? ["西大寺BC行（両備）","天満屋・県庁・東山経由","沖元経由 ほか"] : ["のりば "+b.ref];
      const sign=new THREE.Mesh(new THREE.PlaneGeometry(1.7,0.53), new THREE.MeshLambertMaterial({map:bayTex(b.ref, lines), side:THREE.DoubleSide}));
      sign.position.set(b.x, y+2.9, b.z); furn.add(sign); b._sign=sign;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,3.0,8), new THREE.MeshLambertMaterial({color:0x2b4f86})); pole.position.set(b.x, y+1.5, b.z); furn.add(pole);
    }
  }
  /* ---- 待つ人 ---- */
  const people=[];
  function placePeople(){
    for(const p of people) scene.remove(p); people.length=0;
    D.stops.forEach((s,i)=>{
      const n=st.waiting[i]||0; const [x,z]=s.pole; const q=pathPt(P, s.arc); let dx=x-q.x, dz=z-q.z; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      const t=pathTan(P, s.arc);
      for(let k=0;k<n;k++){ const m=makePerson(i*13+k); const back=0.8+(k%2)*0.7, along=-1.2-k*0.8;
        m.position.set(x+dx*back+t.x*along, Car.hAt(x,z)+0.15, z+dz*back+t.z*along); m.rotation.y=Math.atan2(-dx,-dz); scene.add(m); people.push(m); m.userData.stop=i; }
    });
  }
  /* ---- 開始 ---- */
  function begin(){
    if(!D) return false;
    model=makeRyobiBus(D.dest.replace("バスセンター","BC")); model.traverse(o=>{ if(o.isMesh) o.castShadow=true; });
    Car.C.onDriverView=(drv)=>{ if(!model) return; for(const o of model.userData.outer) o.visible=!drv; model.userData.cab.visible=drv; model.userData.wheelG.rotation.z=-Car.C.wheel; };
    // 経路の帯（中心から 2.7m）は通れる（のりばの上屋・アーケードの下など、建物の範囲に重なる所）
    Car.C.passable=(x,z)=>{ for(let k=Math.max(0,st.idx-20);k<Math.min(P.n,st.idx+40);k++){ const dx=P.P[k*3]-x, dz=P.P[k*3+2]-z; if(dx*dx+dz*dz<7.3) return true; } return false; };
    Car.C.camCeil=(x,z)=>{ for(const r of CEIL) if(x>r[0]&&x<r[2]&&z>r[1]&&z<r[3]) return r[4]; return 1e9; };
    Car.setProfile("bus", model); Car.start();
    // のりば（岡山駅東口 13 番）の少し手前、経路の向きに
    // 前扉（車体中心から前へ 4.6m）が 13番のりばの標柱の横に来る位置
    const sc=D.stops[0].arc-4.6, p=pathPt(P, sc), t=pathTan(P, sc);
    Car.C.x=p.x; Car.C.z=p.z; Car.C.yaw=Math.atan2(t.x,t.z); Car.C.h=Car.hAt(p.x,p.z); Car.C.view="chase";
    Object.assign(st, {idx:0, s:0, stopI:1, doors:true, doorT:1, dwell:0, dwellNeed:6, score:1000, pax:0, req:false, reqT:0, done:false, sigI:0, off:false, offT:0, comfortHits:0});
    st.waiting = D.stops.map((s,i)=> i===0 ? 7 : i===D.stops.length-1 ? 0 : Math.floor(Math.random()*(s.name==="天満屋"?7:4)));
    st.alight = D.stops.map(()=>0);
    setBusDoors(model,1); placePeople(); orientPlates(); buildStopMarks();
    st.atStop=0; st.dwell=0; st.dwellNeed=3+1.1*st.waiting[0];
    ribbon.visible=true; active=true;
    $("busui").classList.add("on"); $("bus-route").textContent=D.short+"（"+D.via+"）"; hudStops();
    busAnn("start"); setTimeout(()=>busSay("岡山駅東口 13番のりばに停車中。お客様が乗り終わったら（約"+Math.ceil(st.dwellNeed)+"秒）F で扉を閉め、青い帯に沿って発車してください。"), 400);
    return true;
  }
  function end(){ active=false; if(marks){ scene.remove(marks); marks=null; } Car.C.onDriverView=null; Car.C.camCeil=null; Car.C.passable=null; if(ribbon) ribbon.visible=false; $("busui").classList.remove("on"); for(const p of people) scene.remove(p); people.length=0; Car.setProfile("sedan"); }
  /* ---- 停留所の目印: 路面の「バス停車帯」（黄色の枠・文字）と、次の停留所の光の柱・看板 ---- */
  let marks=null, beacon=null, beaconSign=null;
  function stopBoxTex(name){
    return canvasTex(128, 512, (g,w,h)=>{ g.clearRect(0,0,w,h);
      g.strokeStyle="rgba(255,205,40,0.95)"; g.lineWidth=10; g.strokeRect(6,6,w-12,h-12);
      
      // 近づく運転士から読めるよう、文字の上を進行方向（キャンバスの下側）へ。奥から「バ」「ス」の順（日本の路面表示と同じ）
      g.fillStyle="rgba(255,255,255,0.0)"; g.fillRect(0,0,1,1);
      for(const [ch,y] of [["バ",h*0.62],["ス",h*0.38]]){ g.save(); g.translate(w/2,y); g.rotate(Math.PI); g.fillStyle="rgba(255,215,60,0.95)"; g.font="bold 84px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(ch,0,0); g.restore(); }
      g.fillStyle="rgba(255,255,255,0.95)"; g.fillRect(10,h-40,w-20,12);  // 前扉の位置（標柱の横）
    });
  }
  function buildStopMarks(){
    if(marks) scene.remove(marks); marks=new THREE.Group(); scene.add(marks);
    D.stops.forEach((s,i)=>{
      // バスの車体（前扉が標柱の横）に合わせた長さ 12m・幅 2.9m の枠（経路の曲がりに沿わせる）
      const a0=s.arc+0.65-11.3, a1=s.arc+0.65+0.3, n=12, pos=[], uv=[];
      for(let k=0;k<n;k++){ const sa=a0+(a1-a0)*k/n, sb=a0+(a1-a0)*(k+1)/n;
        const A=pathPt(P,sa), B=pathPt(P,sb), ta=pathTan(P,sa), tb=pathTan(P,sb);
        const la=[ta.z,-ta.x], lb=[tb.z,-tb.x], w=1.45, ya=Car.hAt(A.x,A.z)+0.06, yb=Car.hAt(B.x,B.z)+0.06;
        const v0=1-k/n, v1=1-(k+1)/n;
        const pA0=[A.x+la[0]*w,ya,A.z+la[1]*w], pA1=[A.x-la[0]*w,ya,A.z-la[1]*w], pB0=[B.x+lb[0]*w,yb,B.z+lb[1]*w], pB1=[B.x-lb[0]*w,yb,B.z-lb[1]*w];
        pos.push(...pA0,...pA1,...pB0, ...pB0,...pA1,...pB1); uv.push(1,v0, 0,v0, 1,v1, 1,v1, 0,v0, 0,v1); }
      const g=new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos,3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv,2));
      const m=new THREE.Mesh(g, new THREE.MeshBasicMaterial({map:stopBoxTex(s.name), transparent:true, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-8, polygonOffsetUnits:-12}));
      marks.add(m);
    });
    // 次の停留所の光の柱（標柱の位置・遠くから見える）と名前の看板
    beacon=new THREE.Mesh(new THREE.CylinderGeometry(0.45,0.45,14,16,1,true), new THREE.MeshBasicMaterial({color:0xffb020, transparent:true, opacity:0.35, depthWrite:false, side:THREE.DoubleSide}));
    marks.add(beacon);
    beaconSign=new THREE.Sprite(new THREE.SpriteMaterial({depthTest:false, transparent:true})); beaconSign.scale.set(7,1.75,1); marks.add(beaconSign);
  }
  function signTex(name, sub){
    return canvasTex(512,128,(g,w,h)=>{ g.fillStyle="rgba(20,24,30,0.85)"; g.fillRect(0,0,w,h); g.fillStyle="#ffb020"; g.fillRect(0,0,14,h);
      g.fillStyle="#fff"; g.textAlign="left"; g.textBaseline="middle"; let fs=46; do{ g.font="bold "+fs+"px 'Hiragino Sans','Noto Sans JP',sans-serif"; fs--; }while(g.measureText(name).width>470 && fs>16);
      g.fillText(name, 30, 48); g.fillStyle="#ffcf6a"; g.font="bold 26px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.fillText(sub, 30, 100); });
  }
  let beaconFor=-1;
  function updateBeacon(){
    if(!beacon) return; const i=st.stopI, s=D.stops[i];
    const show = s && !st.done && !st.doors;
    beacon.visible=show; beaconSign.visible=show; if(!show) return;
    const y=Car.hAt(s.pole[0],s.pole[1]);
    beacon.position.set(s.pole[0], y+7, s.pole[1]);
    const d=Math.max(0, s.arc-(st.s+4.6));
    beaconSign.position.set(s.pole[0], y+(d>60?9:5.2), s.pole[1]);
    const sc=d>60?Math.min(3, 1+d/250):1; beaconSign.scale.set(7*sc,1.75*sc,1);
    if(beaconFor!==i){ beaconFor=i; if(beaconSign.material.map) beaconSign.material.map.dispose(); beaconSign.material.map=signTex("🚏 "+s.name, "次の停留所 — 前扉をこの柱の横に"); beaconSign.material.needsUpdate=true; }
  }
  /* ---- 路線図（右上の小さな地図） ---- */
  let mm=null;
  function drawMap(){
    const c=$("bus-map"); if(!c) return; const g=c.getContext("2d"), w=c.width, h=c.height;
    if(!mm){ let a=1e9,b=-1e9,z0=1e9,z1=-1e9; for(let k=0;k<P.n;k++){ a=Math.min(a,P.P[k*3]); b=Math.max(b,P.P[k*3]); z0=Math.min(z0,P.P[k*3+2]); z1=Math.max(z1,P.P[k*3+2]); }
      const pad=10, sc=Math.min((w-2*pad)/(b-a),(h-2*pad)/(z1-z0)); mm=(x,z)=>[pad+(x-a)*sc, pad+(z-z0)*sc]; }
    g.clearRect(0,0,w,h); g.strokeStyle="rgba(120,170,255,.8)"; g.lineWidth=2.5; g.beginPath();
    for(let k=0;k<P.n;k+=4){ const q=mm(P.P[k*3],P.P[k*3+2]); k?g.lineTo(q[0],q[1]):g.moveTo(q[0],q[1]); } g.stroke();
    D.stops.forEach((s,i)=>{ const q=mm(s.pole[0],s.pole[1]); g.fillStyle=i===st.stopI?"#ffb020":(i<st.stopI?"rgba(160,160,160,.7)":"#f1ead9"); g.beginPath(); g.arc(q[0],q[1],i===st.stopI?4.5:2.6,0,7); g.fill(); });
    const q=mm(Car.C.x,Car.C.z); g.fillStyle="#e6503e"; g.beginPath(); g.arc(q[0],q[1],4,0,7); g.fill();
  }
  /* ---- 放送（録音があれば再生、無ければ字幕のみ） ---- */
  function busAnn(id, extra){ const txt = BUS_ANN[id] ? BUS_ANN[id].text : null; if(txt) busSay("（放送）"+txt); Snd.ann && Snd.ann("bus_"+id); }
  function busSay(t){ if(typeof setSubtitle==="function") setSubtitle(t); $("bus-msg").textContent=t; st.msgT=6; }
  function doorKey(){
    if(!active || st.done) return;
    const C=Car.C;
    if(!st.doors){
      if(Math.abs(C.v)>0.3){ busSay("停車してから扉を開けてください。"); return; }
      const z=zoneInfo();
      st.doors=true; Snd.door && Snd.door(true);
      if(z && z.ok){ const i=st.stopI; st.atStop=i; st.dwell=0; const a=st.alight[i]||0, b=st.waiting[i]||0; st.dwellNeed=3+1.1*(a+b);
        const acc=Math.max(0, 40-Math.abs(z.along)*10-Math.max(0,z.gap-0.8)*25); st.score=Math.min(1000, st.score+acc);
        busSay(D.stops[i].name+"。"+(a?a+"人が降ります。":"")+(b?b+"人が乗ります。":"")+"乗り降りが終わるまでお待ちください。");
        if(i===D.stops.length-1) setTimeout(finish, 2500);
      } else { st.atStop=-1; st.score=Math.max(0, st.score-5); busSay(z ? "停留所の標柱に扉を合わせてください（"+(z.along>0?"あと "+z.along.toFixed(1)+" m 前":Math.abs(z.along).toFixed(1)+" m 行き過ぎ")+"・歩道まで "+z.gap.toFixed(1)+" m）。" : "停留所以外で扉を開けました（-30点）。"); }
    } else {
      if(st.atStop>=0 && st.dwell<st.dwellNeed){ st.score=Math.max(0, st.score-10); busSay("まだ乗り降りしています（-10点）。"); }
      st.doors=false; Snd.door && Snd.door(false);
      if(st.atStop>=0){ const i=st.atStop; st.pax += (st.waiting[i]||0) - (st.alight[i]||0); st.pax=Math.max(0,st.pax); st.waiting[i]=0; placePeople();
        st.stopI=Math.min(D.stops.length-1, i+1); st.req=false; st.annNext=false; setTimeout(()=>busAnn("depart"), 600); setTimeout(()=>{ busAnn("next_"+st.stopI); prepareNext(); }, 3200); }
      st.atStop=-1; hudStops();
    }
  }
  function prepareNext(){
    const i=st.stopI; const n=D.stops.length;
    // 降りる人: 乗っている人の一部。終点は全員
    st.alight[i] = i===n-1 ? st.pax : Math.min(st.pax, Math.floor(Math.random()*Math.min(4, st.pax+1)));
    if(st.alight[i]>0){ st.reqAt = 4+Math.random()*10; } else st.reqAt=-1;
  }
  /* ---- 停留所に合っているか（前扉と標柱の前後差・歩道までの距離） ---- */
  function zoneInfo(){
    const i=st.stopI, s=D.stops[i]; if(!s) return null;
    const C=Car.C, f=[Math.sin(C.yaw), Math.cos(C.yaw)], l=[Math.cos(C.yaw), -Math.sin(C.yaw)];
    const door=[C.x+f[0]*(5.25-0.65)+l[0]*1.25, C.z+f[1]*(5.25-0.65)+l[1]*1.25];
    const d=[s.pole[0]-door[0], s.pole[1]-door[1]];
    const along=d[0]*f[0]+d[1]*f[1], gap=d[0]*l[0]+d[1]*l[1];
    if(Math.abs(along)>25 || Math.abs(gap)>8) return null;
    return {along, gap, ok: along>-3.0 && along<3.0 && gap>-0.4 && gap<2.4};
  }
  function finish(){
    st.done=true;
    const s=Math.round(st.score);
    $("finish-score").textContent=s;
    { const R=Prefs.record("bus", s); setTimeout(()=>{ if(R.newBest && R.n>1) $("finish-text").textContent+="　自己ベスト更新！"; }, 0); }
    $("finish-text").textContent="両備バス 西大寺線 岡山駅 → 東山　ランク "+(s>=950?"S":s>=850?"A":s>=700?"B":"C")+"　乗り心地 "+Math.max(0,100-st.comfortHits*5)+"%";
    $("finish-overlay").classList.add("on"); $("turnback").style.display="none";
    busAnn("terminal");
  }
  /* ---- 毎フレーム ---- */
  let ribT=0;
  function tick(dt, simT){
    if(!active) return;
    const C=Car.C;
    // 扉の開閉（開いている間は発進しない）
    st.doorT += ((st.doors?1:0)-st.doorT)*Math.min(1,dt*3); setBusDoors(model, st.doorT);
    if(st.doors && Math.abs(C.v)>0.2){ C.v*=0.9; if(performance.now()-st.lastWarn>2500){ st.lastWarn=performance.now(); busSay("扉が開いています。閉めてから発車してください。"); } }
    if(st.doors && st.atStop>=0) st.dwell+=dt;
    // 経路上の位置（近傍だけ探す）
    let best=1e18, bi=st.idx;
    for(let k=Math.max(0,st.idx-15); k<Math.min(P.n-1, st.idx+80); k++){ const dx=P.P[k*3]-C.x, dz=P.P[k*3+2]-C.z, d=dx*dx+dz*dz; if(d<best){ best=d; bi=k; } }
    if(best>40*40){ for(let k=0;k<P.n;k+=2){ const dx=P.P[k*3]-C.x, dz=P.P[k*3+2]-C.z, d=dx*dx+dz*dz; if(d<best){ best=d; bi=k; } } }
    st.idx=bi; const sOld=st.s; st.s=P.C[bi];
    const off=Math.sqrt(best)>14; if(off && !st.off){ busSay("経路から外れています。青い帯の道へ戻ってください。"); } st.off=off;
    // 信号
    while(st.sigI<D.signals.length && D.signals[st.sigI].s < sOld-2) st.sigI++;
    const sg=D.signals[st.sigI];
    let sTxt="--", sCls="green", sDist="--";
    if(sg){ const d=sg.s-(st.s+5); const s_=phaseState(sg.g, sg.ph, simT);
      if(d<200){ sTxt=["進行","注意","停止"][s_]; sCls=["green","yellow","red"][s_]; sDist=Math.max(0,Math.round(d))+" m"; }
      if(d<0 && d>-8){ if(s_===2 && !sg._run){ sg._run=true; st.score=Math.max(0,st.score-50); busSay("赤信号を越えました（-50点）。"); } st.sigI++; } }
    $("bus-siglamp").className="siglamp "+sCls; $("bus-sig").textContent=sTxt; $("bus-sigd").textContent=sDist;
    // 降車ボタン
    if(!st.req && st.reqAt>0){ st.reqAt-=dt; if(st.reqAt<=0){ st.req=true; Snd.chime ? Snd.chime() : null; busAnn("request"); } }
    // 停留所
    const i=st.stopI, s=D.stops[i];
    if(s){
      const ds=s.arc-(st.s+4.6);
      const need = st.req || (st.waiting[i]||0)>0 || i===D.stops.length-1;
      $("bus-next").textContent=s.name; $("bus-dist").textContent = ds<60 ? Math.max(-9.9,ds).toFixed(1) : Math.round(ds);
      $("bus-req").classList.toggle("on", st.req);
      $("bus-wait").textContent = (st.waiting[i]||0)>0 ? "待っている人 "+st.waiting[i]+"人" : "待っている人なし";
      if(!st.doors && ds<120 && ds>15 && st._apprFor!==i){ st._apprFor=i; busSay("まもなく "+s.name+"。"+(need?"停車します。":"乗り降りが無ければ通過できます。")+"道路の黄色い「バス」の枠に入り、枠の先の白線（＝前扉が標柱の横）で止まって F で扉を開けてください。"); }
      const z=zoneInfo();
      $("bus-zone").textContent = st.doors ? "停車中" : !z ? (ds>0 ? "黄色い「バス」の枠と光の柱が停留所です" : "") :
        z.ok ? (Math.abs(C.v)<0.3 ? "停車位置OK — F で扉を開ける" : "停車位置の範囲内 — 止まって F") :
        (z.along>3 ? "前扉が標柱の横に来るまで あと "+z.along.toFixed(1)+" m" : z.along<-3 ? "行き過ぎ "+(-z.along).toFixed(1)+" m" : "") + (z.gap>2.4 ? "（歩道側へ寄せる: "+(z.gap-0.9).toFixed(1)+" m）" : "");
      $("bus-guide").classList.toggle("ok", !!(z && z.ok));
      $("bus-gmark").style.left = (50 - Math.max(-15, Math.min(15, z ? z.along : ds)) / 15 * 50) + "%";
      // 通過判定
      if(ds < -12 && !st.doors){
        if(need){ st.score=Math.max(0, st.score-40); busSay(s.name+" を通過してしまいました（-40点）。"); }
        else busSay(s.name+" は乗り降りが無いので通過しました。");
        st.pax -= 0; st.waiting[i]=0; placePeople(); st.stopI=Math.min(D.stops.length-1,i+1); st.req=false; prepareNext(); setTimeout(()=>busAnn("next_"+st.stopI), 800); hudStops();
      }
    }
    // 乗り心地（乗客がいるとき）
    const acc=Math.abs(C.acc||0), lat=C.aLat||0;
    if(st.pax>0 && Math.abs(C.v)>0.5 && (acc>3.4 || lat>3.6)){ if(!st._harsh && performance.now()-(st._harshT||0)>6000){ st._harsh=true; st._harshT=performance.now(); st.comfortHits++; st.score=Math.max(0,st.score-5); busSay("急な操作で車内が揺れました（-5点）。"); } } else if(acc<2.0 && lat<2.2) st._harsh=false;
    // 速度制限
    const lim = st.lim || 50;
    if(Math.abs(C.v)*3.6 > lim+10){ st.score=Math.max(0, st.score-dt*4); if(performance.now()-st.lastWarn>3000){ st.lastWarn=performance.now(); busSay("制限速度 "+lim+" km/h を超えています。"); } }
    $("bus-score").textContent=Math.round(st.score); $("bus-pax").textContent=st.pax+"人"; $("bus-door").textContent=st.doors?"開":"閉"; $("bus-door").classList.toggle("open", st.doors);
    $("bus-lim").textContent=lim;
    // 案内帯（前方 180m）
    ribT-=dt; if(ribT<=0){ ribT=0.35; drawRibbon(); drawMap(); }
    updateBeacon();
    // 待っている人: 扉を開けて停車中は順に乗る
    if(st.doors && st.atStop>=0){ const i2=st.atStop; const left=Math.max(0, (st.waiting[i2]||0) - Math.floor(st.dwell/1.1));
      let k=0; for(const p of people){ if(p.userData.stop===i2){ p.visible = k<left; k++; } } }
    st.msgT=(st.msgT||0)-dt; if(st.msgT<=0) $("bus-msg").textContent="";
  }
  function drawRibbon(){
    const a=st.s-5, b=st.s+180, pts=[];
    for(let s=a; s<=b; s+=2){ const p=pathPt(P, s), t=pathTan(P, s); pts.push([p.x,p.y,p.z,t.x,t.z]); }
    const pos=new Float32Array((pts.length-1)*18); let o=0;
    const w=0.55;
    for(let k=0;k<pts.length-1;k++){ const A=pts[k], B=pts[k+1];
      const la=[A[4],-A[3]], lb=[B[4],-B[3]], ya=Car.hAt(A[0],A[2])+0.12, yb=Car.hAt(B[0],B[2])+0.12;
      const a0=[A[0]+la[0]*w, ya, A[2]+la[1]*w], a1=[A[0]-la[0]*w, ya, A[2]-la[1]*w], b0=[B[0]+lb[0]*w, yb, B[2]+lb[1]*w], b1=[B[0]-lb[0]*w, yb, B[2]-lb[1]*w];
      pos.set([...a0,...a1,...b0, ...b0,...a1,...b1], o); o+=18; }
    ribbon.geometry.dispose(); const g=new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos,3)); ribbon.geometry=g;
  }
  function hudStops(){
    const n=D.stops.length, i=st.stopI;
    $("bus-seq").textContent=i+" / "+(n-1);
    $("bus-progress").style.width=((i-1)/(n-1)*100).toFixed(0)+"%";
  }
  function nearestOnRoute(x,z){
    let best=1e18, bi=st.idx;
    for(let k=0;k<P.n;k++){ const d=(P.P[k*3]-x)**2+(P.P[k*3+2]-z)**2 + (k<st.idx-60 ? 900 : 0); if(d<best){ best=d; bi=k; } }
    let s=P.C[bi];
    for(let tries=0; tries<20; tries++){ const q=pathPt(P,s); if(!Obs.hit(q.x,q.z,6,PCAR_REF.o)) break; s+=8; }
    const q=pathPt(P,s), t=pathTan(P,s); st.idx=Math.max(0,bi-2); return {x:q.x, z:q.z, yaw:Math.atan2(t.x,t.z)};
  }
  function onRoute(){ return !st.off; }
  return { init, begin, end, tick, doorKey, nearestOnRoute, onRoute, get active(){ return active; }, get data(){ return D; }, st, setLimit:(v)=>{ st.lim=v; } };
})();

/* 放送文（バス）。読み仮名は tts に */
const BUS_ANN = {
  start:   { text:"ご乗車ありがとうございます。このバスは、天満屋、県庁、東山経由、西大寺バスセンター行きです。" },
  depart:  { text:"発車します。お立ちのお客様は、つり革や手すりにおつかまりください。" },
  request: { text:"次、止まります。バスが止まってから、席をお立ちください。" },
  terminal:{ text:"東山です。ご乗車ありがとうございました。お忘れ物のないよう、ご注意ください。" },
};

/* ================= 現在地の表示（v11）=================
   町丁目・区: OpenStreetMap の行政区域（admin_level=10 / 7・8）、道路名: OSM の道路の name（車線網 traffic.json）、
   橋: OSM の man_made=bridge の名前。0.4 秒ごとに判定して画面上部に表示する */
const Loc = (() => {
  let PL = null, LG = null, names = [], last = {}, t = 0;
  function bbox(r){ let x0=1e9,z0=1e9,x1=-1e9,z1=-1e9; for(const [x,z] of r){ if(x<x0)x0=x; if(x>x1)x1=x; if(z<z0)z0=z; if(z>z1)z1=z; } return [x0,z0,x1,z1]; }
  function inRing(r, x, z){ let c=false; for(let i=0,j=r.length-1;i<r.length;j=i++){ const a=r[i], b=r[j]; if(((a[1]>z)!==(b[1]>z)) && (x < (b[0]-a[0])*(z-a[1])/(b[1]-a[1]+1e-12)+a[0])) c=!c; } return c; }
  function prep(list){ for(const e of list){ e.bb=e.r.map(bbox); } return list; }
  function find(list, x, z){
    for(const e of list){ for(let k=0;k<e.r.length;k++){ const b=e.bb[k]; if(x<b[0]||x>b[2]||z<b[1]||z>b[3]) continue; if(inRing(e.r[k],x,z)) return e; } }
    return null;
  }
  function init(places, traffic){
    if(places){ PL={ towns:prep(places.towns||[]), wards:prep(places.wards||[]), bridges:prep(places.bridges||[]) }; }
    if(traffic){
      names = traffic.names || [];
      LG = new Map();
      traffic.lanes.forEach((ln,i)=>{ const p=ln.p; for(let k=0;k<p.length;k+=2){ const key=Math.floor(p[k][0]/20)*100003+Math.floor(p[k][2]/20); let a=LG.get(key); if(!a){ a=[]; LG.set(key,a); } a.push([p[k][0],p[k][2],ln.nm,ln.v]); } });
    }
  }
  function road(x, z){
    if(!LG) return null;
    let best=null, bd=144;
    const ix=Math.floor(x/20), iz=Math.floor(z/20);
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){ const a=LG.get((ix+dx)*100003+(iz+dz)); if(!a) continue;
      for(const q of a){ const d=(q[0]-x)**2+(q[1]-z)**2; if(d<bd){ bd=d; best=q; } } }
    return best ? { name: best[2]>=0 ? names[best[2]] : "", v: best[3] } : null;
  }
  /* x,z の現在地。extra は先頭に付ける文字列（路線名など） */
  function update(dt, x, z, extra){
    t -= dt; if(t > 0) return last; t = 0.4;
    if(!PL){ return last; }
    const town = find(PL.towns, x, z), ward = find(PL.wards.filter(w=>w.name!=="岡山市"), x, z), br = find(PL.bridges, x, z), rd = road(x, z);
    last = { town: town && town.name, ward: ward && ward.name, bridge: br && br.name, road: rd && rd.name, v: rd && rd.v };
    const el = $("locchip");
    const parts = [];
    if(extra) parts.push("<b>"+extra+"</b>");
    parts.push("岡山市"+(last.ward||"")+" "+(last.town||""));
    if(last.bridge) parts.push(last.bridge+"（旭川）".replace("（旭川）", /京橋|中橋|小橋|相生橋|新京橋|鶴見橋|新鶴見橋/.test(last.bridge)?"（旭川）":""));
    else if(last.road) parts.push(last.road);
    el.innerHTML = "📍 " + parts.join("<i>／</i>");
    el.classList.add("on");
    return last;
  }
  function hide(){ $("locchip").classList.remove("on"); }
  return { init, update, hide, get last(){ return last; } };
})();


function setVehicle(kind){
  S.vehicle = VEHICLES[kind] ? kind : "momo";
  if(S.car){ scene.remove(S.car); if(S.car.userData.single) S.car.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ if(m.map) m.map.dispose(); m.dispose(); }); } }); }
  S.car = makeVehicle(S.vehicle, S.route && S.route.dest); S.car.traverse(o=>{ if(o.isMesh) o.castShadow=true; }); scene.add(S.car); S.motor = VEHICLES[S.vehicle].motor;
}

/* ---------------- 路線 ---------------- */
function setupRoute(key, preview){ applyRoute(S.routes[key], key, preview); S.annOff=0; S.phase="service"; }
function applyRoute(r, key, preview){
  S.key=key; S.route=r;
  S.track=r.track; S.speedLim=r.speed;
  const n=S.track.length; S.arc=new Float64Array(n);
  for(let i=1;i<n;i++){ const a=S.track[i-1], b=S.track[i]; S.arc[i]=S.arc[i-1]+Math.hypot(b[0]-a[0],b[2]-a[2]); }
  S.total=S.arc[n-1];
  S.stops=r.stops; S.cum=r.stops.map(s=>s.arc); S.endArc=S.cum[S.cum.length-1];
  // 同じ停止位置（6m以内）に複数の交差点が掛かる場合は、最初の交差点の信号に従う
  S.signals=r.signals.filter((g,i,arr)=>i===0 || g.stop-arr[i-1].stop>6);
  // 単線区間（行き止まり線・引上線）の閉そく信号
  S.P=mkPath(S.track); S.blockIv = Trams.ready ? Trams.intervals(S.P) : [];
  for(const q of S.blockIv) if(q.s0>8) S.signals.push({stop:q.s0-4, center:q.s0, block:q.b});
  S.signals.sort((a,b)=>a.stop-b.stop);
  if(!preview){ S.pos=S.cum[0]; S.speed=0; S.acc=0; S.emergency=false; S.notch=0; S.doorOpen=true; S.stopIndex=1; S.sigIndex=0; S.score=1000; S.comfortHits=0; S.announced=new Set(); }
  else S.pos = S.cum[0]+40;
}
function idxAt(s){ let lo=0, hi=S.arc.length-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(S.arc[m]<=s) lo=m; else hi=m; } return lo; }
function pointAt(s){
  // 線路の両端より外は端の向きで直線延長（車体・カメラが端で潰れないように）
  if(s<0 || s>S.total){ const n=S.track.length, e=s<0, A=e?S.track[0]:S.track[n-1], B=e?S.track[Math.min(4,n-1)]:S.track[Math.max(0,n-5)];
    let dx=B[0]-A[0], dz=B[2]-A[2]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L; const k=e?s:-(s-S.total);
    return new THREE.Vector3(A[0]+dx*k, A[1], A[2]+dz*k); } const i=idxAt(s), j=Math.min(i+1,S.arc.length-1);
  const a=S.track[i], b=S.track[j], L=S.arc[j]-S.arc[i]||1, t=(s-S.arc[i])/L;
  return new THREE.Vector3(a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t);
}
function tangentAt(s){ const p=pointAt(s-2), q=pointAt(s+2); return q.sub(p).setY(0).normalize(); }
function limitAt(s){ return S.speedLim[Math.min(S.speedLim.length-1, idxAt(s))]; }

/* ---------------- カメラ ---------------- */
function updateCamera(){
  if(!S.track) return;
  const p=pointAt(S.pos), t=tangentAt(S.pos);
  const ah=pointAt(S.pos+22);
  if(S.car){ placeTram(S.car); S.car.visible = S.view!=="cab"; }
  if(S.view==="top"){ camera.position.set(p.x, p.y+S.topH, p.z+0.01); camera.lookAt(p.x, p.y, p.z); return; }
  if(S.view==="cab"){
    // 先頭車体(A車)の中心と向き。カメラは車体前面の運転席位置に置き、車体の向きに沿って前を見る
    const V=VEH(), sA=S.pos+0.6-V.front/2, c=pointAt(sA), d=tangentAt(sA);
    if(!S._camD) S._camD=d.clone(); S._camD.lerp(d, 0.25).normalize();
    const D=S._camD, eye=c.clone().addScaledVector(D, V.front/2-0.42);
    camera.position.set(eye.x, eye.y+2.35, eye.z);
    camera.lookAt(eye.x+D.x*40, eye.y+2.35-0.9, eye.z+D.z*40);
  } else {
    const side=new THREE.Vector3(t.z,0,-t.x);
    const b=p.clone().addScaledVector(t,-32).addScaledVector(side,13);
    camera.position.set(b.x,b.y+16,b.z); camera.lookAt(p.x,p.y+2,p.z);
  }
}

/* ---------------- HUD ---------------- */
const spd=$("speedometer").getContext("2d"), mapc=$("mini-map"), mapx=mapc.getContext("2d");
function drawSpeedo(){
  const c=spd,w=150,h=150,r=w/2-10; c.clearRect(0,0,w,h); c.save(); c.translate(w/2,h/2);
  c.strokeStyle="rgba(201,168,106,.5)"; c.lineWidth=2; c.beginPath(); c.arc(0,0,r,Math.PI*0.72,Math.PI*2.28); c.stroke();
  for(let v=0;v<=60;v+=10){ const a=Math.PI*0.72+(v/60)*Math.PI*1.56; c.strokeStyle=v>40?"#d6543f":"rgba(241,234,217,.7)";
    c.beginPath(); c.moveTo(Math.cos(a)*(r-6),Math.sin(a)*(r-6)); c.lineTo(Math.cos(a)*r,Math.sin(a)*r); c.stroke();
    c.fillStyle="rgba(241,234,217,.65)"; c.font="9px sans-serif"; c.textAlign="center"; c.textBaseline="middle"; c.fillText(v,Math.cos(a)*(r-16),Math.sin(a)*(r-16)); }
  const lim=limitAt(S.pos); const al=Math.PI*0.72+(lim/60)*Math.PI*1.56;
  c.strokeStyle="#e6a94d"; c.lineWidth=4; c.beginPath(); c.arc(0,0,r-2,al-0.03,al+0.03); c.stroke();
  const a=Math.PI*0.72+(Math.min(S.speed,60)/60)*Math.PI*1.56; c.strokeStyle="#e6a94d"; c.lineWidth=3; c.lineCap="round";
  c.beginPath(); c.moveTo(0,0); c.lineTo(Math.cos(a)*(r-14),Math.sin(a)*(r-14)); c.stroke(); c.restore();
}
let mapCache=null;
function drawMiniMap(){
  const c=mapx,w=mapc.width,h=mapc.height; if(!S.track) return;
  if(!mapCache||mapCache.key!==S.key){ let a=1e9,b=-1e9,z0=1e9,z1=-1e9; S.track.forEach(p=>{a=Math.min(a,p[0]);b=Math.max(b,p[0]);z0=Math.min(z0,p[2]);z1=Math.max(z1,p[2]);});
    const pad=12, sc=Math.min((w-2*pad)/Math.max(1,b-a),(h-2*pad)/Math.max(1,z1-z0)); mapCache={key:S.key,P:(x,z)=>[pad+(x-a)*sc,pad+(z-z0)*sc]}; }
  const P=mapCache.P; c.clearRect(0,0,w,h); c.strokeStyle="rgba(201,168,106,.6)"; c.lineWidth=2; c.beginPath();
  for(let i=0;i<S.track.length;i+=6){ const q=P(S.track[i][0],S.track[i][2]); i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]); } c.stroke();
  S.stops.forEach((s,i)=>{ const p=pointAt(s.arc), q=P(p.x,p.z); c.fillStyle=i===S.stopIndex?"#e6a94d":"rgba(241,234,217,.7)"; c.beginPath(); c.arc(q[0],q[1],i===S.stopIndex?4:2.4,0,7); c.fill(); });
  const p=pointAt(S.pos), q=P(p.x,p.z); c.fillStyle="#d6543f"; c.beginPath(); c.arc(q[0],q[1],3.6,0,7); c.fill();
}
function buildNotchBar(){ const el=$("notch-bar"); el.innerHTML=""; for(let i=-5;i<=4;i++){ const d=document.createElement("i"); if(i<0)d.classList.add("brake"); if(i>0)d.classList.add("power"); el.appendChild(d);} }
function updateNotchBar(){ const b=$("notch-bar").children; for(let i=-5;i<=4;i++){ const el=b[i+5]; el.classList.remove("on"); if(S.notch<0&&i>=S.notch&&i<0)el.classList.add("on"); if(S.notch>0&&i<=S.notch&&i>0)el.classList.add("on"); } $("notch").textContent=S.notch===0?"N":(S.notch>0?"P"+S.notch:"B"+(-S.notch)); }
function setSubtitle(t){ $("subtitle").textContent=t; }

/* ---------------- 音と車内放送 ----------------
   走行音: 日本の路面電車の車内で録音した実音（函館・豊橋, CC0 / freesound.org Heigh-hoo）を
           速度に応じて2本のループをクロスフェード・再生速度変化。モーター音（VVVF）は合成で重ねる。
   制動: 停止直前のブレーキ鳴き（広島電鉄の実録音, CC0）、停車後の空気の緩解音（CC0）
   ドア: 開扉（函館の実録音）・閉扉（路面電車の閉扉音, CC0）/ 警鐘: 路面電車のベル（CC0）
   放送: 女性アナウンスの音声ファイル（事前生成。固有名詞はひらがなで読みを指定）。
         読み込めない場合のみブラウザの音声合成で代替。 */
const Snd = (() => {
  let ctx = null, master = null, sfxBus = null, annBus = null, on = true;
  const buf = {};
  let rollLo = null, rollHi = null, gLo, gHi, motorG, motorO1, motorO2, motorF;
  let lastJoint = 0, squealed = false, squealSrc = null, squealGain = null;
  const FILES = { roll_lo:"sfx/roll_lo.wav", roll_hi:"sfx/roll_hi.wav", squeal:"sfx/squeal.wav", air:"sfx/airrelease.wav",
                  dopen:"sfx/dooropen.wav", dclose:"sfx/doorclose.wav", bell:"sfx/bell.wav",
                  // v18: Freesound の CC0 素材を切り出し・ループ化（出典は画面下の注記）
                  car_engine:"sfx/car_engine.wav", car_road:"sfx/car_road.wav", car_squeal:"sfx/car_squeal.wav", car_horn:"sfx/car_horn.wav", car_crash:"sfx/car_crash.wav",
                  bus_engine:"sfx/bus_engine.wav", bus_cabin:"sfx/bus_cabin.wav", bus_horn:"sfx/bus_horn.wav", bus_air:"sfx/bus_air.wav",
                  bus_door_open:"sfx/bus_door_open.wav", bus_door_close:"sfx/bus_door_close.wav",
                  heli_rotor:"sfx/heli_rotor.wav", heli_body:"sfx/heli_body.wav", heli_cabin:"sfx/heli_cabin.wav",
                  mc_click:"sfx/mc_click.wav", bv_click:"sfx/bv_click.wav", lever_clunk:"sfx/lever_clunk.wav" };
  async function load(name, url){
    try{ const r = await fetch(url); if(!r.ok) throw 0; buf[name] = await ctx.decodeAudioData(await r.arrayBuffer()); }
    catch(e){ console.warn("sound load failed", url); }
  }
  function startLoops(){
    if(buf.roll_lo && !rollLo){ rollLo = ctx.createBufferSource(); rollLo.buffer = buf.roll_lo; rollLo.loop = true; rollLo.connect(gLo); rollLo.start(0, Math.random()*10); }
    if(buf.roll_hi && !rollHi){ rollHi = ctx.createBufferSource(); rollHi.buffer = buf.roll_hi; rollHi.loop = true; rollHi.connect(gHi); rollHi.start(0, Math.random()*10); }
  }
  function init(){
    if(ctx){ ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 1.0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 1.9; sfxBus.connect(master);   // 走行音・効果音は大きめ（v8.2）
    // 放送: 車内スピーカー風（帯域を絞り、わずかに残響）
    annBus = ctx.createGain(); annBus.gain.value = 0.95;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 220;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6500;
    const pk = ctx.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 2200; pk.gain.value = 3; pk.Q.value = 0.8;
    annBus.connect(hp).connect(pk).connect(lp).connect(master);
    const dl = ctx.createDelay(); dl.delayTime.value = 0.045; const fb = ctx.createGain(); fb.gain.value = 0.18;
    lp.connect(dl).connect(fb).connect(master);
    gLo = ctx.createGain(); gLo.gain.value = 0; gLo.connect(sfxBus);
    gHi = ctx.createGain(); gHi.gain.value = 0; gHi.connect(sfxBus);
    // モーター（VVVFインバータの磁励音を控えめに合成）
    motorO1 = ctx.createOscillator(); motorO1.type = "sawtooth"; motorO2 = ctx.createOscillator(); motorO2.type = "triangle";
    motorF = ctx.createBiquadFilter(); motorF.type = "bandpass"; motorF.Q.value = 6; motorF.frequency.value = 900;
    motorG = ctx.createGain(); motorG.gain.value = 0;
    const m2 = ctx.createGain(); m2.gain.value = 0.5;
    motorO1.connect(motorF); motorO2.connect(m2).connect(motorF); motorF.connect(motorG).connect(sfxBus);
    motorO1.start(); motorO2.start();
    Promise.all(Object.entries(FILES).map(([k,u]) => load(k,u))).then(startLoops);
  }
  function play(name, opt){
    if(!ctx || !on || !buf[name]) return null;
    opt = opt || {};
    const s = ctx.createBufferSource(); s.buffer = buf[name]; s.playbackRate.value = opt.rate || 1;
    const g = ctx.createGain(); g.gain.value = opt.gain == null ? 1 : opt.gain;
    s.connect(g).connect(sfxBus); s.start(ctx.currentTime + (opt.delay || 0), opt.offset || 0, opt.dur);
    return {s, g};
  }
  function thump(t, v){                           // レール継目（録音にも含まれるため控えめに）
    const o = ctx.createOscillator(); o.type="sine"; o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(40, t+0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.45*v, t+0.006); g.gain.exponentialRampToValueAtTime(0.0001, t+0.18);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t+0.2);
  }
  const sm = (a,b,x) => { const t = Math.min(1, Math.max(0, (x-a)/(b-a))); return t*t*(3-2*t); };
  function update(dt, st){
    if(!ctx || !on) return;
    const t = ctx.currentTime, v = st.speed, a = st.acc;
    // 走行音: 低速ループ→高速ループへクロスフェード。再生速度も速度に比例
    const lvl = Math.pow(sm(0.3, 14, v), 0.8), wHi = sm(14, 32, v);
    gLo.gain.setTargetAtTime(lvl * (1 - wHi) * 1.3, t, 0.15);
    gHi.gain.setTargetAtTime(lvl * wHi * 1.2 + lvl * 0.18, t, 0.15);
    if(rollLo) rollLo.playbackRate.setTargetAtTime(0.55 + Math.min(v, 30) / 30 * 0.6, t, 0.2);
    if(rollHi) rollHi.playbackRate.setTargetAtTime(0.75 + Math.min(v, 45) / 45 * 0.4, t, 0.2);
    // モーター: 力行・電気ブレーキ時。低速は一定音程、速度とともに上昇
    const load = Math.min(1, Math.abs(a) / 3) * (v > 0.3 || a > 0 ? 1 : 0);
    if(st.motor === "dc"){
      // 吊り掛け駆動・直流直接制御: 速度に比例して唸る歯車音（惰行中も小さく鳴る）
      const f = 60 + v * 11;
      motorO1.frequency.setTargetAtTime(f, t, 0.1); motorO2.frequency.setTargetAtTime(f * 3.02, t, 0.1);
      motorF.Q.setTargetAtTime(2.5, t, 0.1); motorF.frequency.setTargetAtTime(f * 2.2, t, 0.1);
      motorG.gain.setTargetAtTime(v > 0.5 ? (0.02 + 0.05 * Math.min(1, v / 35)) * (st.notch > 0 ? 1.6 : 0.8) : 0.0, t, 0.15);
    } else {
      const f = v < 8 ? 520 + v * 8 : 584 + (v - 8) * 26;
      motorO1.frequency.setTargetAtTime(f, t, 0.08); motorO2.frequency.setTargetAtTime(f * 2, t, 0.08);
      motorF.Q.setTargetAtTime(6, t, 0.1); motorF.frequency.setTargetAtTime(f * 1.5, t, 0.1);
      motorG.gain.setTargetAtTime((st.notch !== 0 || st.emergency) && v < 48 ? 0.012 + 0.03 * load : 0.0, t, 0.15);
    }
    // ブレーキ鳴き: 制動中に 9km/h を下回ったら一度だけ（停止で消える）
    const braking = st.notch < 0 || st.emergency;
    if(braking && v < 9 && v > 1.0 && !squealed && buf.squeal){ squealed = true; const p = play("squeal", {gain: 0.55, offset: 0.3}); if(p){ squealSrc = p.s; squealGain = p.g; } }
    if(v > 14) squealed = false;
    if(squealGain && (v < 0.2 || !braking)) { squealGain.gain.setTargetAtTime(0, t, 0.12); squealGain = null; }
    // 継目音
    if(v > 3){
      if(st.pos - lastJoint >= 25){
        lastJoint = st.pos; const ms = v / 3.6, vol = Math.min(1, 0.3 + v / 45);
        for(const d of [1.5, 3.3, 14.7, 16.5]) thump(t + d / ms, vol);
      }
    } else lastJoint = st.pos;
  }
  function notch(n, prev){
    if(!ctx || !on) return;
    if(n < prev && n < 0) play("air", {gain: 0.18, rate: 1.6, dur: 0.6});      // ブレーキ込め
  }
  function brakeRelease(){ play("air", {gain: 0.6}); }
  // v18: 電車のマスコン・ブレーキ弁のノッチの音（1 段ごとに「カチッ」。まとめて動かすと「カクカク」と続けて鳴る）
  let lastMC = 0, lastBV = 0;
  function levers(mc, bv){
    if(!ctx || !on){ lastMC = mc; lastBV = bv; return; }
    const dm = mc - lastMC, db = bv - lastBV;
    for(let i = 0; i < Math.abs(dm); i++) play("mc_click", {gain: 0.55 + Math.random()*0.15, rate: (dm > 0 ? 1.0 : 0.93) * (0.97 + Math.random()*0.06), delay: i * 0.075});
    for(let i = 0; i < Math.abs(db); i++){
      const toEmg = bv >= 6 && lastBV + (db > 0 ? i + 1 : -(i + 1)) >= 6;
      if(toEmg) play("lever_clunk", {gain: 0.9, rate: 0.8, delay: i * 0.08});
      else play("bv_click", {gain: 0.6 + Math.random()*0.15, rate: 0.9 + Math.random()*0.08, delay: i * 0.08});
    }
    lastMC = mc; lastBV = bv;
  }
  function door(open){
    if(S.mode === "bus"){ play(open ? "bus_door_open" : "bus_door_close", {gain: 0.9}); return; }
    if(open) play("dopen", {gain: 0.9}); else play("dclose", {gain: 0.9});
  }
  function horn(){
    if(S.mode === "bus"){ play("bus_horn", {gain: 0.8}); return; }
    if(S.mode === "car"){ play("car_horn", {gain: 0.75}); return; }
    play("bell", {gain: 0.9}); play("bell", {gain: 0.8, delay: 0.42}); }
  function chime(){ if(!ctx || !on) return; const t=ctx.currentTime;
    for(const [f,d] of [[1318.5,0],[1046.5,0.32]]){ const o=ctx.createOscillator(); o.type="sine"; o.frequency.value=f; const g=ctx.createGain();
      g.gain.setValueAtTime(0.0001,t+d); g.gain.exponentialRampToValueAtTime(0.35,t+d+0.01); g.gain.exponentialRampToValueAtTime(0.0001,t+d+0.9); o.connect(g).connect(sfxBus); o.start(t+d); o.stop(t+d+1); } }
  // ---- 放送 ----
  let annCur = null, ANNF = null;
  fetch("audio/ann.json").then(r => r.json()).then(j => { ANNF = j; }).catch(() => {});
  const annBuf = {};
  async function annLoad(f){
    if(!annBuf[f]) annBuf[f] = fetch("audio/" + f).then(r => r.arrayBuffer()).then(a => ctx.decodeAudioData(a)).catch(e => { delete annBuf[f]; throw e; });
    return annBuf[f];
  }
  function preload(ids){ if(!ctx || !ANNF) return; for(const id of ids){ const c = ANNF[id]; if(c && !annBuf[c.f]) annLoad(c.f).catch(()=>{}); } }
  async function ann(id, delay){
    if(!on) return;
    const c = ANNF && ANNF[id];
    if(c && ctx){
      try{
        const b = await annLoad(c.f);
        if(annCur){ try{ annCur.stop(); }catch(e){} }
        const s = ctx.createBufferSource(); s.buffer = b; s.connect(annBus); s.start(ctx.currentTime + (delay || 0)); annCur = s;
        return;
      }catch(e){}
    }
    if(c) say(c.tts);
  }
  let voice = null;
  function pickVoice(){
    if(!("speechSynthesis" in window)) return null;
    const vs = speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang));
    voice = vs.find(v => /female|kyoko|nanami|haruka|ayumi|sayaka|google/i.test(v.name)) || vs[0] || null;
    return voice;
  }
  if("speechSynthesis" in window){ speechSynthesis.onvoiceschanged = pickVoice; }
  function say(text){
    if(!on || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text); u.lang = "ja-JP"; if(voice || pickVoice()) u.voice = voice;
    u.rate = 0.98; u.pitch = 1.05; speechSynthesis.speak(u);
  }
  function hush(){ if(annCur){ try{ annCur.stop(); }catch(e){} annCur = null; } if("speechSynthesis" in window) speechSynthesis.cancel(); }
  // ---- v17: ヘリの音（ローターの羽音＝雑音を翼の通過周波数で断続・タービンの高音） ----
  // ---- ヘリの音（v18: 実録音のループ）: ローターの羽音（回転数で速さ）・機体とタービン・操縦席の中の音。外からは距離で小さく・こもらせる ----
  let hs = null;
  function loopNode(name, dest){
    if(!buf[name]) return null;
    const src = ctx.createBufferSource(); src.buffer = buf[name]; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0; src.connect(g).connect(dest); src.start(0, Math.random() * buf[name].duration);
    return { src, g };
  }
  function heliSound(H){
    if(!ctx) return;
    if(!hs){
      if(!buf.heli_rotor || !buf.heli_body) return;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6000; lp.Q.value = 0.5; lp.connect(sfxBus);
      hs = { lp, rotor: loopNode("heli_rotor", lp), body: loopNode("heli_body", lp), cabin: loopNode("heli_cabin", lp) };
    }
    const t = ctx.currentTime;
    const set = (n, v, tc) => { if(n) n.g.gain.setTargetAtTime(v, t, tc || 0.12); };
    if(!on || !H.active){ set(hs.rotor, 0); set(hs.body, 0); set(hs.cabin, 0); return; }
    const load = Math.min(1, Math.abs(H.vY) / 9 * 0.5 + Math.abs(H.vF) / 60 * 0.5);
    const inside = Heli.H.view !== "chase";
    const dist = camera.position.distanceTo(Heli.heli.position), near = inside ? 1 : Math.min(1, 36 / Math.max(18, dist));
    // 地上でアイドル中は回転がやや遅い
    const rpm = H.landed && Math.abs(H.vY) < 0.1 ? 0.9 : 1.0 + load * 0.08;
    if(hs.rotor) hs.rotor.src.playbackRate.setTargetAtTime(rpm, t, 0.4);
    if(hs.body) hs.body.src.playbackRate.setTargetAtTime(0.95 + load * 0.1, t, 0.4);
    set(hs.rotor, (inside ? 0.28 : 0.55) * near * (0.85 + load * 0.3));
    set(hs.body, (inside ? 0.12 : 0.35) * near * (0.9 + load * 0.2));
    set(hs.cabin, inside ? 0.55 : 0);
    hs.lp.frequency.setTargetAtTime(inside ? 2600 : 900 + 5000 * near, t, 0.2);
  }
  // v23: 近くを通る JR の列車の音（走行音の素材を低く・こもらせて使う）。k: 近さ×速さ 0〜1
  let js = null;
  function jrSound(k, v){
    if(!ctx) return;
    if(!js){ if(!buf.roll_lo) return; const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 800; lp.connect(sfxBus);
      js = { lp, lo: loopNode("roll_lo", lp), hi: loopNode("roll_hi", lp) }; }
    const t = ctx.currentTime, kk = on ? k : 0;
    if(js.lo){ js.lo.g.gain.setTargetAtTime(0.9 * kk, t, 0.3); js.lo.src.playbackRate.setTargetAtTime(0.55 + Math.min(1.1, v / 45), t, 0.5); }
    if(js.hi){ js.hi.g.gain.setTargetAtTime(0.3 * kk, t, 0.3); js.hi.src.playbackRate.setTargetAtTime(0.6 + Math.min(1.0, v / 50), t, 0.5); }
    js.lp.frequency.setTargetAtTime(450 + 1800 * kk, t, 0.3);
  }
  function toggle(){
    on = !on;
    if(!on){ hush(); if(master) master.gain.value = 0; } else if(master) master.gain.value = 1.0;
    return on;
  }
  function text(id){ return ANNF && ANNF[id] ? ANNF[id].text : ""; }
  // ---- 車モードの音: エンジン（回転数に応じた倍音）・ロードノイズ・タイヤ鳴き・衝突 ----
  // ---- 車・バスの音（v18: 実録音のループ）: エンジン（回転数で再生速度・踏み込みで明るく）・ロードノイズ・タイヤ鳴き。バスはディーゼルと車内の音 ----
  let eng = null, wasMoving = false;
  function carSound(C){
    if(!ctx) return;
    if(!eng){
      if(!buf.car_engine || !buf.bus_engine) return;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2000; lp.Q.value = 0.7; lp.connect(sfxBus);
      eng = { lp, car: loopNode("car_engine", lp), bus: loopNode("bus_engine", lp), road: loopNode("car_road", sfxBus), cabin: loopNode("bus_cabin", sfxBus), sq: loopNode("car_squeal", sfxBus) };
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 1050; const g = ctx.createGain(); g.gain.value = 0; o.connect(g).connect(sfxBus); o.start(); eng.bp = g;
    }
    const t = ctx.currentTime, set = (n, v, tc) => { if(n) n.g.gain.setTargetAtTime(v, t, tc || 0.1); };
    if(!on || !C.active){ for(const k of ["car","bus","road","cabin","sq"]) set(eng[k], 0); eng.bp.gain.setTargetAtTime(0, t, 0.02); wasMoving = false; return; }
    const bus = S.mode === "bus", sp = Math.abs(C.v), inside = C.view === "driver";
    const r = Math.max(0, Math.min(1, (C.rpm - 800) / 5200));
    if(bus){
      set(eng.car, 0);
      eng.bus.src.playbackRate.setTargetAtTime(0.72 + r * 0.85 + C.thr * 0.06, t, 0.12);
      set(eng.bus, (inside ? 0.38 : 0.5) * (0.55 + C.thr * 0.6));
      set(eng.cabin, inside ? Math.min(0.6, 0.12 + sp / 18 * 0.5) : 0);
      set(eng.road, (inside ? 0.15 : 0.35) * Math.min(1, sp / 16));
      eng.lp.frequency.setTargetAtTime(900 + C.thr * 2500 + r * 1500, t, 0.1);
      // 停車するとエアの音（プシュー）
      if(wasMoving && sp < 0.15){ play("bus_air", {gain: 0.55}); wasMoving = false; }
      if(sp > 2) wasMoving = true;
    } else {
      set(eng.bus, 0); set(eng.cabin, 0);
      eng.car.src.playbackRate.setTargetAtTime(0.8 + r * 1.7, t, 0.06);
      set(eng.car, (inside ? 0.3 : 0.42) * (0.5 + C.thr * 0.7));
      set(eng.road, (inside ? 0.55 : 0.4) * Math.min(1, sp / 18));
      eng.lp.frequency.setTargetAtTime(1100 + C.thr * 4000 + r * 2500, t, 0.08);
    }
    if(eng.road) eng.road.src.playbackRate.setTargetAtTime(0.7 + Math.min(sp, 30) / 30 * 0.6, t, 0.2);
    set(eng.sq, Math.min(0.6, C.slip * 0.7), 0.05);
    // 後退時の警告音: 約 1kHz を 0.4 秒ごとに断続
    const beepOn = C.gear === "R" && (ctx.currentTime % 0.8) < 0.4;
    eng.bp.gain.setTargetAtTime(beepOn ? 0.06 : 0, t, 0.01);
  }
  function carHit(v){ play("car_crash", {gain: Math.min(1, 0.3 + v / 12), rate: S.mode === "bus" ? 0.75 : 1}); }
    // 試験用: 読み込んだ音・ループの音量
  let plays = 0; const _play = play; play = function(n, o){ plays++; Snd._last = n; return _play(n, o); };
  function debug(){ const g = o => o ? +o.g.gain.value.toFixed(3) : null; return { ctx: ctx && ctx.state, bufs: Object.keys(buf).length, plays, last: Snd._last,
    car: eng && { car: g(eng.car), bus: g(eng.bus), road: g(eng.road), cabin: g(eng.cabin), rate: eng.car && +eng.car.src.playbackRate.value.toFixed(2), brate: eng.bus && +eng.bus.src.playbackRate.value.toFixed(2) },
    heli: hs && { rotor: g(hs.rotor), body: g(hs.body), cabin: g(hs.cabin) } }; }
  return {init, update, notch, levers, debug, brakeRelease, door, horn, chime, ann, preload, text, hush, toggle, carSound, carHit, heliSound, jrSound, get on(){ return on; }};
})();

/* 放送文は audio/ann.json（提供の書き起こしを整えた文面。広告は除外、運賃は改定があるため入れていない）。 */
function annStart(){ Snd.ann("start_" + S.key); Snd.preload(["dep_" + S.key + "_1", "app_" + S.key + "_1", "arr_" + S.key + "_1"]); }
const AI = () => S.stopIndex + (S.annOff||0);
function annDepart(){
  if(S.phase==="pull") return;
  const id = "dep_" + S.key + "_" + AI();
  Snd.ann(id);
  Snd.preload(["app_" + S.key + "_" + AI(), "arr_" + S.key + "_" + AI(), "dep_" + S.key + "_" + (AI() + 1)]);
  const t = Snd.text(id); setSubtitle("（放送）" + (t ? t.replace(/^この電車は、[^。]+。発車します。ご注意ください。/, "") : "次は " + S.stops[S.stopIndex].name));
}
function annApproach(){ if(S.phase==="pull" || AI()<=0) return; const id = "app_" + S.key + "_" + AI(); Snd.ann(id); const t = Snd.text(id); if(t) setSubtitle("（放送）" + t); }
function annArrive(){ Snd.ann("arr_" + S.key + "_" + AI(), 0.8); }

/* ---------------- 運転台（3D）: 参考写真の在来形路面電車の運転台を再現 ----------------
   左: 主幹制御器（マスコン）… 箱形の台に縦軸のハンドル、黒い握り玉。右へ回すと 1〜4 ノッチ
   右: ブレーキ弁 … 真鍮のハンドルに木の握り。右へ回すと B1〜B5、いちばん奥が非常
   中央: 速度計・圧力計（元空気溜・ブレーキシリンダ）、表示灯、窓枠
   どちらのハンドルもドラッグ（タッチ可）で回せる。キーはマスコン W/S、ブレーキ ↓/↑ でそれぞれ独立に操作 */
const Cab = (() => {
  const sceneC = new THREE.Scene();
  const camC = new THREE.PerspectiveCamera(56, 1, 0.05, 10);
  sceneC.add(new THREE.HemisphereLight(0xfff6ea, 0x3a342c, 0.95));
  const dl = new THREE.DirectionalLight(0xfff2dc, 0.55); dl.position.set(0.3, 1.2, 0.6); sceneC.add(dl);
  const root = new THREE.Group(); sceneC.add(root);
  const tex = (w, h, f) => { const c = document.createElement("canvas"); c.width = w; c.height = h; f(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; };
  const wood = tex(256, 128, (g, w, h) => {
    g.fillStyle = "#b58a55"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { g.strokeStyle = `rgba(${90 + Math.random() * 40},${55 + Math.random() * 25},25,${0.12 + Math.random() * 0.18})`; g.lineWidth = 1 + Math.random() * 2;
      const y = Math.random() * h; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x / 30 + i) * 3); g.stroke(); }
  });
  const M = {
    wood: new THREE.MeshLambertMaterial({ map: wood }),
    green: new THREE.MeshPhongMaterial({ color: 0xc9d9c6, shininess: 25, specular: 0x333333 }),
    steel: new THREE.MeshPhongMaterial({ color: 0xd4d6d8, shininess: 90, specular: 0xffffff }),
    black: new THREE.MeshPhongMaterial({ color: 0x151515, shininess: 80, specular: 0x666666 }),
    brass: new THREE.MeshPhongMaterial({ color: 0xc49a4a, shininess: 90, specular: 0xffe6a0 }),
    grip: new THREE.MeshLambertMaterial({ color: 0xd8a86e }),
    panel: new THREE.MeshLambertMaterial({ color: 0xe9e3d3 }),
    frame: new THREE.MeshLambertMaterial({ color: 0x4a4038 }),
    dark: new THREE.MeshLambertMaterial({ color: 0x2b2b2b }),
  };
  const box = (w, h, d, m, x, y, z, parent) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); (parent || root).add(o); return o; };
  const cyl = (r0, r1, h, m, x, y, z, parent, seg) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg || 20), m); o.position.set(x, y, z); (parent || root).add(o); return o; };

  // ---- 運転台の机・前面パネル（木目）----
  const DZ = -0.95;
  box(2.4, 0.05, 0.62, M.wood, 0, -0.385, DZ + 0.02);            // 机の天板
  box(2.4, 0.5, 0.05, M.wood, 0, -0.6, DZ + 0.33);                // 手前の立ち上がり
  // 計器盤（天板の奥で少し起きている）
  const gp = new THREE.Group(); gp.position.set(0, -0.33, DZ - 0.24); gp.scale.setScalar(0.85); gp.rotation.x = -0.35; root.add(gp);
  box(0.78, 0.2, 0.03, M.panel, 0, 0, 0, gp);
  // 窓枠（左右の柱と下枠）
  box(0.09, 1.6, 0.09, M.frame, -0.98, 0.25, DZ - 0.35);
  box(0.09, 1.6, 0.09, M.frame, 0.98, 0.25, DZ - 0.35);
  box(2.1, 0.06, 0.08, M.frame, 0, -0.37, DZ - 0.33);
  box(2.1, 0.07, 0.08, M.frame, 0, 0.72, DZ - 0.35);
  // 左右の壁（木目）
  box(0.05, 0.6, 0.9, M.wood, -1.12, -0.45, DZ + 0.1);
  box(0.05, 0.6, 0.9, M.wood, 1.12, -0.45, DZ + 0.1);

  // ---- 計器（キャンバスで描画し、速度計は毎フレーム更新）----
  function gaugeCanvas() { const c = document.createElement("canvas"); c.width = c.height = 256; return c; }
  function drawGauge(c, val, max, label, unit, red, ticks) {
    const g = c.getContext("2d"), r = 118; g.clearRect(0, 0, 256, 256); g.save(); g.translate(128, 128);
    g.fillStyle = "#1c1c1c"; g.beginPath(); g.arc(0, 0, 127, 0, 7); g.fill();
    g.fillStyle = "#f4f1e6"; g.beginPath(); g.arc(0, 0, r - 6, 0, 7); g.fill();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    g.strokeStyle = "#222"; g.fillStyle = "#222"; g.font = "bold 20px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    for (let k = 0; k <= ticks; k++) { const v = max * k / ticks, a = a0 + (a1 - a0) * k / ticks;
      g.lineWidth = 3; g.beginPath(); g.moveTo(Math.cos(a) * (r - 10), Math.sin(a) * (r - 10)); g.lineTo(Math.cos(a) * (r - 26), Math.sin(a) * (r - 26)); g.stroke();
      g.fillText(Number.isInteger(v) ? v : v.toFixed(1), Math.cos(a) * (r - 46), Math.sin(a) * (r - 46)); }
    g.font = "14px sans-serif"; g.fillText(label, 0, 38); g.fillText(unit, 0, 58);
    const a = a0 + (a1 - a0) * Math.min(1, Math.max(0, val / max));
    g.strokeStyle = red ? "#c8261c" : "#111"; g.lineWidth = 6; g.lineCap = "round";
    g.beginPath(); g.moveTo(-Math.cos(a) * 16, -Math.sin(a) * 16); g.lineTo(Math.cos(a) * (r - 22), Math.sin(a) * (r - 22)); g.stroke();
    g.fillStyle = "#333"; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill(); g.restore();
  }
  const gauges = [];
  function addGauge(x, label, unit, max, red, ticks) {
    const c = gaugeCanvas(); const t = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.075, 32), new THREE.MeshBasicMaterial({ map: t }));
    m.position.set(x, 0.0, 0.017); gp.add(m);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.077, 0.008, 8, 32), M.steel); rim.position.set(x, 0, 0.018); gp.add(rim);
    const gg = { c, t, label, unit, max, red, ticks, last: -1 }; gauges.push(gg); return gg;
  }
  const gSpeed = addGauge(-0.22, "速度計", "km/h", 60, false, 6);
  const gMR = addGauge(0.0, "元空気溜", "kgf/cm²", 10, true, 5);
  const gBC = addGauge(0.22, "ブレーキシリンダ", "kgf/cm²", 5, true, 5);
  // 表示灯の列（上部）
  const lamps = [];
  const lampBar = box(0.62, 0.05, 0.05, M.dark, 0, 0.13, 0.0, gp);
  ["#7cd07c", "#e0b030", "#e05040", "#60a0e0", "#e0e0e0", "#e05040"].forEach((col, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    m.position.set(-0.26 + i * 0.104, 0.13, 0.03); gp.add(m); lamps.push({ m, on: new THREE.Color(col), off: new THREE.Color(0x2a2a2a) });
  });

  // ---- 主幹制御器（左）----
  const MC = new THREE.Group(); MC.position.set(-0.42, -0.36, DZ + 0.1); MC.scale.setScalar(0.78); root.add(MC);
  box(0.3, 0.42, 0.3, M.green, 0, -0.21, 0, MC);                   // 箱
  box(0.31, 0.02, 0.31, M.steel, 0, 0.005, 0, MC);                 // 天板（金属）
  cyl(0.035, 0.04, 0.03, M.steel, 0, 0.03, 0, MC);
  const mcRot = new THREE.Group(); mcRot.position.set(0, 0.03, 0); MC.add(mcRot);
  cyl(0.018, 0.018, 0.13, M.steel, 0, 0.07, 0, mcRot);               // 縦軸
  const arm = box(0.16, 0.03, 0.035, M.steel, -0.07, 0.13, 0, mcRot); // 腕（左へ伸びる）
  cyl(0.012, 0.012, 0.06, M.steel, -0.14, 0.165, 0, mcRot);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), M.black); knob.scale.set(1, 0.7, 1); knob.position.set(-0.14, 0.205, 0); mcRot.add(knob);
  // ノッチ表示板
  const mcPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.05), new THREE.MeshBasicMaterial({ map: tex(256, 64, (g, w, h) => {
    g.fillStyle = "#e8e4d8"; g.fillRect(0, 0, w, h); g.fillStyle = "#222"; g.font = "bold 30px sans-serif"; g.textBaseline = "middle";
    ["切", "1", "2", "3", "4"].forEach((s, i) => g.fillText(s, 12 + i * 50, h / 2)); }) }));
  mcPlate.rotation.x = -Math.PI / 2; mcPlate.position.set(0, 0.017, 0.1); MC.add(mcPlate);
  // 逆転ハンドル（固定・前進）
  cyl(0.012, 0.012, 0.05, M.steel, 0.1, 0.035, -0.08, MC); box(0.02, 0.02, 0.08, M.steel, 0.1, 0.06, -0.05, MC);

  // ---- ブレーキ弁（右）----
  const BV = new THREE.Group(); BV.position.set(0.3, -0.36, DZ + 0.1); BV.scale.setScalar(0.78); root.add(BV);
  box(0.32, 0.42, 0.32, M.green, 0, -0.21, 0, BV);
  box(0.33, 0.02, 0.33, M.steel, 0, 0.005, 0, BV);
  cyl(0.06, 0.07, 0.07, M.steel, 0, 0.045, 0, BV);                  // 弁本体
  const bvRot = new THREE.Group(); bvRot.position.set(0, 0.09, 0); BV.add(bvRot);
  cyl(0.045, 0.045, 0.035, M.brass, 0, 0.0, 0, bvRot);                // 真鍮のハブ
  box(0.2, 0.025, 0.035, M.brass, 0.11, 0.0, 0, bvRot);              // 腕（右へ）
  const grip = cyl(0.022, 0.024, 0.13, M.grip, 0.26, 0.0, 0, bvRot); grip.rotation.z = Math.PI / 2;
  const bvPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.05), new THREE.MeshBasicMaterial({ map: tex(320, 64, (g, w, h) => {
    g.fillStyle = "#e8e4d8"; g.fillRect(0, 0, w, h); g.fillStyle = "#222"; g.font = "bold 24px sans-serif"; g.textBaseline = "middle";
    ["運", "1", "2", "3", "4", "5", "非"].forEach((s, i) => { g.fillStyle = s === "非" ? "#b01010" : "#222"; g.fillText(s, 8 + i * 44, h / 2); }); }) }));
  bvPlate.rotation.x = -Math.PI / 2; bvPlate.position.set(0, 0.017, 0.12); BV.add(bvPlate);
  // 運転台の小物: 戸閉スイッチ・警笛ペダルの代わりのボタン類
  cyl(0.02, 0.02, 0.02, new THREE.MeshLambertMaterial({ color: 0x2060c0 }), -0.05, -0.355, DZ + 0.2);
  cyl(0.02, 0.02, 0.02, new THREE.MeshLambertMaterial({ color: 0xc02020 }), 0.08, -0.355, DZ + 0.2);

  // ---- 状態: 角度（ノッチ位置）----
  const MC_STEP = -0.36, BV_STEP = -0.3;      // 右回り（上から見て時計回り）が正のノッチ
  const st = { mcAng: 0, bvAng: 0, drag: null };
  // ドラッグ用の当たり判定（見えない大きめの円柱）
  const hitM = new THREE.MeshBasicMaterial({ visible: false });
  const hitMC = cyl(0.17, 0.17, 0.3, hitM, 0, 0.12, 0, MC);
  const hitBV = cyl(0.3, 0.3, 0.2, hitM, 0.1, 0.09, 0, BV);
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let api = null;   // {getMC, setMC, getBV, setBV}
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camC);
    const h = ray.intersectObjects([hitMC, hitBV], false);
    return h.length ? (h[0].object === hitMC ? "mc" : "bv") : null;
  }
  function onDown(ev) {
    if (!Cab.active || !api) return;
    const w = pick(ev); if (!w) return;
    ev.preventDefault();
    st.drag = { w, x0: ev.clientX, a0: w === "mc" ? api.getMC() * MC_STEP : api.getBV() * BV_STEP, id: ev.pointerId };
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function onMove(ev) {
    if (!st.drag) { if (Cab.active) renderer.domElement.style.cursor = pick(ev) ? "grab" : ""; return; }
    const dx = ev.clientX - st.drag.x0;
    const ang = st.drag.a0 - dx * 0.011;          // 右へドラッグ = 右回り
    if (st.drag.w === "mc") { const n = Math.max(0, Math.min(4, Math.round(ang / MC_STEP))); st.mcAng = Math.max(4 * MC_STEP, Math.min(0.05, ang)); if (n !== api.getMC()) api.setMC(n); }
    else { const n = Math.max(0, Math.min(6, Math.round(ang / BV_STEP))); st.bvAng = Math.max(6 * BV_STEP, Math.min(0.05, ang)); if (n !== api.getBV()) api.setBV(n); }
  }
  function onUp() { st.drag = null; }
  renderer.domElement.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp); addEventListener("pointercancel", onUp);

  function update(dt, S) {
    // ハンドル角: ドラッグ中は指に追従、それ以外はノッチ位置へ滑らかに
    if (!st.drag || st.drag.w !== "mc") st.mcAng += (api.getMC() * MC_STEP - st.mcAng) * Math.min(1, dt * 14);
    if (!st.drag || st.drag.w !== "bv") st.bvAng += (api.getBV() * BV_STEP - st.bvAng) * Math.min(1, dt * 14);
    mcRot.rotation.y = st.mcAng; bvRot.rotation.y = st.bvAng;
    // 計器
    const bc = S.emergency ? 4.2 : Math.max(0, -S.notch) * 0.7;
    const vals = [S.speed, 7.6 + Math.sin(S.t * 0.2) * 0.3 - bc * 0.08, bc];
    gauges.forEach((g, i) => { const v = Math.round(vals[i] * 10) / 10; if (v !== g.last) { g.last = v; drawGauge(g.c, v, g.max, g.label, g.unit, g.red, g.ticks); g.t.needsUpdate = true; } });
    // 表示灯: 戸閉・力行・制動・非常・電源・ATS風
    const on = [!S.doorOpen, S.notch > 0, S.notch < 0, true, true, S.emergency];
    lamps.forEach((l, i) => l.m.material.color.copy(on[i] ? l.on : l.off));
    // 走行中の小さな揺れ
    const sh = Math.min(1, S.speed / 40);
    root.position.set(Math.sin(S.t * 13.1) * 0.0025 * sh, Math.sin(S.t * 17.3) * 0.003 * sh - (S.acc || 0) * 0.0012, 0);
  }
  function render(r) {
    camC.aspect = camera.aspect; camC.fov = camera.fov; camC.updateProjectionMatrix();
    r.clearDepth(); r.render(sceneC, camC);
  }
  function screenPos() {   // テスト用: ハンドル位置の画面座標
    const r = renderer.domElement.getBoundingClientRect(), out = {};
    for (const [k, o] of [["mc", knob], ["bv", grip]]) { const v = new THREE.Vector3(); o.getWorldPosition(v); v.project(camC); out[k] = [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }
    return out;
  }
  return { update, render, bind(a) { api = a; }, active: false, dragging: () => !!st.drag, screenPos };
})();

/* ---------------- 車モード: 岡山の道路を自由に運転 ----------------
   路面: 2m 格子の路面高さ（PLATEAU 道路面・地形）/ 建物: PLATEAU の建物範囲に入ると衝突
   車両: 5ドアセダン（全長4.6m・全幅1.8m・軸距2.7m・右ハンドル）
   運動: 自転車モデル（前輪の切れ角→ヨーレート、横加速度はタイヤのグリップ 0.9G で頭打ち）、
         エンジン（6速AT相当の駆動力）、ブレーキ、空気抵抗・転がり抵抗、路面勾配 */
const Car = (() => {
  const C = { x: 60, z: 6, h: 0, yaw: Math.PI / 2, v: 0, steer: 0, wheel: 0, gear: "D", thr: 0, brk: 0, view: "chase",
              pitch: 0, roll: 0, rpm: 800, slip: 0, odo: 0, active: false, hitT: 0 };
  let G = null;           // {nx,nz,x0,z0,step,H(Int16),K(Uint8)}
  // 車種ごとの諸元（v11: バスを追加）
  const PROFILES = {
    sedan: { L: 2.7, rearOff: 1.35, vmax: 180 / 3.6, drive: 3.4, brake: 8.0, grip: 0.9, ratio: 14.5, maxW: 7.85, speedSens: 75,
             corners: [[2.2, 0.85], [2.2, -0.85], [-2.2, 0.85], [-2.2, -0.85], [2.3, 0]], len: 4.5, wid: 1.8,
             drv: { x: -0.37, y: 1.22, f: 0.15 }, cam: { back: 8.5, up: 3.2, look: 3 } },
    // 三菱ふそう エアロスター（ノンステップ 10.5m 級）相当: 軸距 5.3m・全幅 2.49m・最小回転半径 約 8.3m
    bus:   { L: 5.3, rearOff: 2.75, vmax: 80 / 3.6, drive: 1.35, brake: 5.5, grip: 0.62, ratio: 13.5, maxW: 7.85, speedSens: 140,
             corners: [[5.2, 1.2], [5.2, -1.2], [-5.2, 1.2], [-5.2, -1.2], [5.3, 0], [2.6, 1.25], [2.6, -1.25], [0, 1.25], [0, -1.25], [-2.6, 1.25], [-2.6, -1.25]], len: 10.5, wid: 2.49,
             drv: { x: -0.7, y: 2.2, f: 4.6 }, cam: { back: 17, up: 5.6, look: 6 } },
  };
  let P = PROFILES.sedan;
  const L0 = 2.7;
  function setGrid(meta, buf) {
    const n = meta.nx * meta.nz;
    G = { ...meta, H: new Int16Array(buf, 0, n), K: new Uint8Array(buf, n * 2, n) };
    if (meta.bnx && buf.byteLength >= n * 3 + meta.brow * meta.bnz) G.B = new Uint8Array(buf, n * 3, meta.brow * meta.bnz);
  }
  // v14: 建物に入っているか（1m のビット列。無ければ 2m 格子の種類）
  function blocked(x, z) {
    if (G.B) { const i = Math.floor((x - G.x0) / G.bstep), j = Math.floor((z - G.z0) / G.bstep);
      if (i < 0 || j < 0 || i >= G.bnx || j >= G.bnz) return false;
      return (G.B[j * G.brow + (i >> 3)] >> (7 - (i & 7))) & 1; }
    return kindAt(x, z) === 9;
  }
  function cell(x, z) { const i = Math.floor((x - G.x0) / G.step), j = Math.floor((z - G.z0) / G.step); return (i < 0 || j < 0 || i >= G.nx || j >= G.nz) ? -1 : j * G.nx + i; }
  function hAt(x, z) {
    if (!G) return 0;
    const fx = (x - G.x0) / G.step - 0.5, fz = (z - G.z0) / G.step - 0.5;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(G.nz - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), k = j * G.nx + i;
    return ((G.H[k] * (1 - tx) + G.H[k + 1] * tx) * (1 - tz) + (G.H[k + G.nx] * (1 - tx) + G.H[k + G.nx + 1] * tx) * tz) / 100;
  }
  function kindAt(x, z) { const k = cell(x, z); return k < 0 ? 9 : G.K[k]; }
  // v23: 橋脚などを衝突判定（1m のビット列）に加える
  function addBlock(x, z, r) { if (!G || !G.B) return; for (let dz = -r; dz <= r; dz += 1) for (let dx = -r; dx <= r; dx += 1) { const i = Math.floor((x + dx - G.x0) / G.bstep), j = Math.floor((z + dz - G.z0) / G.bstep); if (i < 0 || j < 0 || i >= G.bnx || j >= G.bnz) continue; G.B[j * G.brow + (i >> 3)] |= (1 << (7 - (i & 7))); } }

  // ---- 車体 ----
  const car = new THREE.Group();
  const body = new THREE.Group(); car.add(body);
  const paint = new THREE.MeshPhongMaterial({ color: 0xe9eaec, specular: 0x8899aa, shininess: 80 });
  const glass = new THREE.MeshPhongMaterial({ color: 0x1b242c, specular: 0x9ab, shininess: 100 });
  const blackM = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const lightM = new THREE.MeshBasicMaterial({ color: 0xfff6dd }), tailM = new THREE.MeshBasicMaterial({ color: 0x8a1010 });
  const mk = (g, m, x, y, z) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); body.add(o); return o; };
  mk(new THREE.BoxGeometry(1.78, 0.62, 4.55), paint, 0, 0.62, 0);            // 下半分
  const cabin = mk(new THREE.BoxGeometry(1.56, 0.5, 2.3), glass, 0, 1.17, -0.15);
  const roof = mk(new THREE.BoxGeometry(1.5, 0.06, 2.0), paint, 0, 1.44, -0.2);          // 屋根
  mk(new THREE.BoxGeometry(1.8, 0.2, 0.2), blackM, 0, 0.42, 2.25);          // バンパー
  mk(new THREE.BoxGeometry(1.8, 0.2, 0.2), blackM, 0, 0.42, -2.25);
  for (const s of [-1, 1]) {
    mk(new THREE.BoxGeometry(0.34, 0.12, 0.04), lightM, s * 0.6, 0.72, 2.28);
    mk(new THREE.BoxGeometry(0.34, 0.12, 0.04), tailM, s * 0.62, 0.78, -2.28);
  }
  const wheels = [];
  const wg = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 18); wg.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.78, 1.35], [0.78, 1.35], [-0.78, -1.35], [0.78, -1.35]]) {
    const w = new THREE.Group(); w.position.set(x, 0.32, z); const m = new THREE.Mesh(wg, blackM); w.add(m); car.add(w); wheels.push({ w, m, front: z > 0 });
  }
  car.visible = false; car.traverse(o=>{ if(o.isMesh) o.castShadow=true; }); scene.add(car);

  // ---- 運転席（車内視点で表示）: ダッシュボードとハンドル ----
  const inner = new THREE.Group(); car.add(inner); inner.visible = false;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.22, 0.55), new THREE.MeshLambertMaterial({ color: 0x2a2c2e })); dash.position.set(0, 0.8, 1.12); inner.add(dash);
  const meterHood = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.2), new THREE.MeshLambertMaterial({ color: 0x1f2022 })); meterHood.position.set(-0.37, 0.95, 0.92); inner.add(meterHood);
  const header = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.3), new THREE.MeshLambertMaterial({ color: 0x3a3a3c })); header.position.set(0, 1.5, 0.75); inner.add(header);
  const swG = new THREE.Group(); swG.position.set(-0.37, 0.9, 0.62); swG.rotation.x = -1.05; inner.add(swG);   // 右ハンドル（進行方向右 = -x 側）
  const swRim = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.018, 10, 36), new THREE.MeshLambertMaterial({ color: 0x1c1c1c })); swG.add(swRim);
  const swSpoke = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.02), new THREE.MeshLambertMaterial({ color: 0x333333 })); swG.add(swSpoke);
  const swHub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16), new THREE.MeshLambertMaterial({ color: 0x3a3a3a })); swHub.rotation.x = Math.PI / 2; swG.add(swHub);
  for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.75, 0.07), new THREE.MeshLambertMaterial({ color: 0x2a2a2a })); p.position.set(s * 0.72, 1.2, 1.05); p.rotation.x = -0.62; inner.add(p); }

  // ---- 入力 ----
  const key = {};
  addEventListener("keydown", e => { if (!C.active) return; key[e.key.toLowerCase()] = true;
    if (e.key === "v" || e.key === "V") C.view = C.view === "chase" ? "driver" : "chase";
    if ((e.key === "r" || e.key === "R")) toggleGear();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) e.preventDefault(); });
  addEventListener("keyup", e => { key[e.key.toLowerCase()] = false; });
  const touch = { thr: 0, brk: 0, wheel: null };
  function setGear(g) { if (C.gear === g) return; if (Math.abs(C.v) >= 0.5) { C.msgT = 2; C.msg = "停止してからギアを切り替えてください"; return; } C.gear = g; C.msgT = 1.5; C.msg = g === "R" ? "R（後退）に入れました" : "D（前進）に入れました"; hud(); }
  function toggleGear() { setGear(C.gear === "D" ? "R" : "D"); }
  function bindUI() {
    const hold = (el, k) => { const on = e => { e.preventDefault(); touch[k] = 1; el.classList.add("on"); }, off = () => { touch[k] = 0; el.classList.remove("on"); };
      el.addEventListener("pointerdown", on); el.addEventListener("pointerup", off); el.addEventListener("pointerleave", off); el.addEventListener("pointercancel", off); };
    hold($("car-acc"), "thr"); hold($("car-brk"), "brk");
    $("car-gd").addEventListener("click", () => setGear("D")); $("car-gr").addEventListener("click", () => setGear("R"));
    $("car-view").addEventListener("click", () => { C.view = C.view === "chase" ? "driver" : "chase"; });
    // ハンドル: 中心からの角度差で回す（最大 ±450°）
    const sw = $("car-wheel"); let a0 = 0, w0 = 0, drag = false;
    const ang = e => { const r = sw.getBoundingClientRect(); return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))); };
    sw.addEventListener("pointerdown", e => { e.preventDefault(); drag = true; a0 = ang(e); w0 = C.wheel; touch.wheel = C.wheel; try { sw.setPointerCapture(e.pointerId); } catch (x) {} });
    sw.addEventListener("pointermove", e => { if (!drag) return; let d = ang(e) - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      a0 = ang(e); w0 = Math.max(-7.85, Math.min(7.85, w0 - d)); touch.wheel = w0; });
    const up = () => { drag = false; touch.wheel = null; };
    sw.addEventListener("pointerup", up); sw.addEventListener("pointercancel", up);
  }

  // ---- 物理 ----
  function tick(dt) {
    if (!G) return;
    const kb = (k) => key[k] ? 1 : 0;
    const up = Math.max(kb("arrowup"), kb("w")), dn = Math.max(kb("arrowdown"), kb("s"));
    // キー: D では ↑=アクセル ↓=ブレーキ、R では ↓=アクセル（後退）↑=ブレーキ。画面のペダルはギアに関係なくそのまま
    // 試験用の自動運転（C.autopilot が {thr, brk, wheel} を返す）
    const AP = C.autopilot ? C.autopilot(C) : null;
    const PI_ = (typeof Pad !== "undefined" && Pad.PIN.active) ? Pad.PIN : null;
    const thrIn = AP ? AP.thr : Math.max(C.gear === "R" ? dn : up, touch.thr, PI_ ? PI_.thr : 0), brkIn = AP ? AP.brk : Math.max(C.gear === "R" ? up : dn, touch.brk, PI_ ? PI_.brk : 0);
    // アクセル・ブレーキの踏み込みは 0.25 秒程度で立ち上がる
    C.thr += (thrIn - C.thr) * Math.min(1, dt * 5); C.brk += (brkIn - C.brk) * Math.min(1, dt * 7);
    // 停止中にブレーキを押し続けると R、アクセルで D（AT 車の操作に近い簡易版）
    if (Math.abs(C.v) < 0.3) {
      if (C.gear === "D" && dn && !up) { C._rT = (C._rT || 0) + dt; if (C._rT > 0.35) { C._rT = 0; setGear("R"); } } else C._rT = 0;
      if (C.gear === "R" && up && !dn) setGear("D");
    }
    // ハンドル
    const kSteer = kb("arrowleft") || kb("a") ? 1 : (kb("arrowright") || kb("d") ? -1 : 0);
    // v10.1: キーは「押している間その向きへ切る・離すと素早く真っすぐに戻る」。
    // 速度が上がるほど最大の切れ角を小さくする（車速感応）ので、低速では大きく曲がれ、高速でもふらつかない。
    const maxW = P.maxW * Math.max(0.22, Math.min(1, 1 - (Math.abs(C.v) * 3.6 - 12) / P.speedSens));
    if (AP) C.wheel = AP.wheel;
    else if (touch.wheel !== null) C.wheel = touch.wheel;
    else if (PI_ && PI_.steer !== 0) { const tgt = -Math.sign(PI_.steer) * Math.pow(Math.abs(PI_.steer), 1.4) * maxW; C.wheel += Math.max(-14 * dt, Math.min(14 * dt, tgt - C.wheel)); }
    else if (kSteer) {
      const tgt = kSteer * maxW, rate = Math.sign(tgt - C.wheel) === Math.sign(C.wheel) || C.wheel === 0 ? 11 : 18;   // 切り返しは速く
      C.wheel += Math.max(-rate * dt, Math.min(rate * dt, tgt - C.wheel));
    }
    else C.wheel -= Math.sign(C.wheel) * Math.min(Math.abs(C.wheel), dt * (Math.abs(C.v) > 0.5 ? 16 : 9));   // 手を離すと真っすぐに戻る
    C.steer = C.wheel / P.ratio;                                                  // ステアリングギア比
    // 駆動力（km/h 別に 6速 AT 相当の包絡線）
    const sp = Math.abs(C.v);
    let a = 0;
    const fwd = C.gear === "D" ? 1 : -1;
    const drive = C.gear === "D" ? P.drive * Math.min(1, 9 / Math.max(6, sp)) * Math.max(0, 1 - sp / P.vmax) : Math.min(2.0, P.drive * 1.2) * Math.max(0, 1 - sp / 6);
    a += fwd * C.thr * drive;
    if (C.thr < 0.05 && sp < 1.8 && !brkIn) a += fwd * 0.35 * (1 - sp / 1.8);   // クリープ
    const brakeA = C.brk * P.brake + (key[" "] ? 6 : 0);
    const resist = 0.12 + 0.00045 * sp * sp + (C.thr < 0.05 ? 0.25 : 0);           // 転がり・空気抵抗・エンジンブレーキ
    // 勾配
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw);
    const hl = P.L / 2;
    const hf = hAt(C.x + fx * hl, C.z + fz * hl), hb = hAt(C.x - fx * hl, C.z - fz * hl);
    const grade = (hf - hb) / P.L;
    a -= 9.8 * grade;
    let v = C.v + a * dt;
    const dec = (brakeA + resist) * dt;
    if (Math.abs(v) <= dec) v = 0; else v -= Math.sign(v) * dec;
    if (C.gear === "D" && v < 0 && C.thr > 0.05) v = 0;
    C.v = Math.max(-8, Math.min(P.vmax, v));
    C.acc = (C.v - (C._pv || 0)) / Math.max(1e-3, dt); C._pv = C.v;
    // 旋回: 自転車モデル + グリップ限界
    let yawRate = C.v * Math.tan(C.steer) / P.L;
    const aLat = Math.abs(yawRate * C.v), aMax = P.grip * 9.8;
    C.aLat = aLat;
    C.slip = aLat > aMax ? Math.min(1, (aLat - aMax) / 4) : 0;
    if (aLat > aMax) yawRate *= aMax / aLat;
    // 後輪軸を基準に動かす（長い車体は前が外へ振り出す）
    const rx0 = C.x - Math.sin(C.yaw) * P.rearOff, rz0 = C.z - Math.cos(C.yaw) * P.rearOff;
    const rx1 = rx0 + Math.sin(C.yaw) * C.v * dt, rz1 = rz0 + Math.cos(C.yaw) * C.v * dt;
    const yaw0 = C.yaw;
    C.yaw += yawRate * dt;
    // 位置と衝突（車体の四隅が建物に入ったら止める）
    const nx = rx1 + Math.sin(C.yaw) * P.rearOff, nz = rz1 + Math.cos(C.yaw) * P.rearOff;
    const sx = Math.cos(C.yaw), sz = -Math.sin(C.yaw), f2x = Math.sin(C.yaw), f2z = Math.cos(C.yaw);
    let hit = false;
    // 今の位置ですでに建物に入っている角は数えない（めり込んだ状態から前後どちらにも抜け出せるように）
    const sx0 = Math.cos(yaw0), sz0 = -Math.sin(yaw0), f0x = Math.sin(yaw0), f0z = Math.cos(yaw0);
    const inB = (px, pz) => blocked(px, pz) && !(C.passable && C.passable(px, pz));
    for (const [u, w] of P.corners) { const px = nx + f2x * u + sx * w, pz = nz + f2z * u + sz * w;
      if (inB(px, pz) && !inB(C.x + f0x * u + sx0 * w, C.z + f0z * u + sz0 * w)) hit = true; }
    C.hitWhat = "建物";
    if (!hit && C.obst) { const w = C.obst(nx, nz, f2x, f2z, Math.sign(C.v)); if (w) { hit = true; C.hitWhat = w; } }
    if (hit) { if (Math.abs(C.v) > 3) { C.hitT = 1.2; Snd.carHit && Snd.carHit(Math.abs(C.v)); } C.v = -C.v * 0.15; C.yaw = yaw0; }
    else { C.odo += Math.abs(C.v) * dt; C.x = nx; C.z = nz; }
    C.hitT = Math.max(0, C.hitT - dt);
    // 高さ・姿勢（ピッチ: 勾配＋加減速、ロール: 横加速度）
    const lz = hAt(C.x + sx * P.wid * 0.45, C.z + sz * P.wid * 0.45), rz = hAt(C.x - sx * P.wid * 0.45, C.z - sz * P.wid * 0.45);
    C.h = (hf + hb + lz + rz) / 4;
    const pitchT = Math.atan(grade) - (a - Math.sign(C.v) * brakeA) * (P === PROFILES.bus ? 0.006 : 0.004), rollT = Math.atan((lz - rz) / (P.wid * 0.9)) + Math.sign(C.v) * yawRate * Math.abs(C.v) * (P === PROFILES.bus ? 0.012 : 0.006);
    C.pitch += (pitchT - C.pitch) * Math.min(1, dt * 6); C.roll += (rollT - C.roll) * Math.min(1, dt * 6);
    // エンジン回転（6速 AT の簡易シフト）
    const kmh = sp * 3.6, gearN = C.gear === "R" ? 1 : Math.min(6, 1 + Math.floor(kmh / 22));
    const ratio = [0, 3.6, 2.1, 1.4, 1.0, 0.8, 0.65][gearN];
    const target = 800 + kmh * ratio * 32 + C.thr * 900;
    C.rpm += (Math.min(6500, target) - C.rpm) * Math.min(1, dt * 6); C.gearN = gearN;
    place();
  }
  function place() {
    car.position.set(C.x, C.h, C.z);
    car.rotation.set(0, 0, 0); car.rotateY(C.yaw); body.rotation.set(-C.pitch, 0, C.roll); if (extBody) extBody.rotation.set(-C.pitch, 0, C.roll);
    for (const w of wheels) { w.m.rotation.x += C.v * 0.016 / 0.32; if (w.front) w.w.rotation.y = C.steer; }
    swG.rotation.z = -C.wheel;
  }
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCam(dt) {
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw);
    const isBus = P === PROFILES.bus;
    if (C.view === "driver") {
      inner.visible = !isBus; cabin.visible = false; roof.visible = false; if (C.onDriverView) C.onDriverView(true);
      const sx = Math.cos(C.yaw), sz = -Math.sin(C.yaw), d = P.drv;
      camera.position.set(C.x + sx * d.x + fx * d.f, C.h + d.y, C.z + sz * d.x + fz * d.f);
      camera.lookAt(C.x + fx * (20 + d.f) + sx * d.x, C.h + d.y - 0.22 + Math.sin(-C.pitch) * 20, C.z + fz * (20 + d.f) + sz * d.x);
    } else {
      inner.visible = false; cabin.visible = !isBus; roof.visible = !isBus; if (C.onDriverView) C.onDriverView(false);
      const back = C.v < -0.5 ? -1 : 1;   // 後退時も車の後ろ（進行方向の反対側）から
      const want = new THREE.Vector3(C.x - fx * P.cam.back, C.h + P.cam.up, C.z - fz * P.cam.back);
      if (camPos.lengthSq() === 0 || camPos.distanceTo(want) > 40) camPos.copy(want);
      camPos.lerp(want, Math.min(1, dt * 4));
      const gh = hAt(camPos.x, camPos.z) + 0.6; if (camPos.y < gh) camPos.y = gh;
      if (C.camCeil) { const cy = C.camCeil(camPos.x, camPos.z); if (camPos.y > cy) camPos.y = Math.max(gh, cy); }
      camLook.set(C.x + fx * P.cam.look, C.h + (isBus ? 2.0 : 1.0), C.z + fz * P.cam.look);
      camera.position.copy(camPos); camera.lookAt(camLook);
    }
  }
  function hud() {
    $("car-speed").textContent = Math.round(Math.abs(C.v) * 3.6);
    $("car-gd").classList.toggle("on", C.gear === "D"); $("car-gr").classList.toggle("on", C.gear === "R");
    $("car-gearlbl").textContent = C.gear === "R" ? "R 後退" : "D 前進"; $("car-gearlbl").classList.toggle("rev", C.gear === "R");
    $("car-rpm").style.width = Math.min(100, C.rpm / 65) + "%";
    $("car-wheel").style.transform = `rotate(${-C.wheel}rad)`;
    C.msgT = Math.max(0, (C.msgT || 0) - 0.016);
    $("car-msg").textContent = C.hitT > 0 ? "衝突しました（" + (C.hitWhat || "建物") + "）" : C.msgT > 0 ? C.msg : C.gear === "R" ? "後退中 — ↓ で下がる・↑ で止まる（後方に注意）" : (kindAt(C.x, C.z) === 2 ? "歩道・交通島の上です" : "");
    $("car-place").textContent = "走行距離 " + (C.odo / 1000).toFixed(2) + " km";
  }
  function start() {
    C.active = true; car.visible = true; C.v = 0; C.gear = "D"; C.wheel = 0; C.x = 60; C.z = 6.5; C.yaw = Math.PI / 2;
    // 桃太郎大通り（岡山駅前〜）の東行き車線が見つからない場合は近くの車道へ
    if (G && kindAt(C.x, C.z) !== 1) { outer: for (let r = 1; r < 40; r++) for (let a = 0; a < 16; a++) { const x = 60 + Math.cos(a / 16 * 6.283) * r, z = 6.5 + Math.sin(a / 16 * 6.283) * r; if (kindAt(x, z) === 1) { C.x = x; C.z = z; break outer; } } }
    C.h = hAt(C.x, C.z); camPos.set(0, 0, 0);
  }
  function stop() { C.active = false; car.visible = false; }
  // 車種の切り替え（バスモード）。外観は extBody（バスの車体など）を差し込んで使う
  let extBody = null;
  function setProfile(name, ext) {
    P = PROFILES[name] || PROFILES.sedan; C.profile = name;
    if (extBody) { car.remove(extBody); extBody = null; }
    const own = name === "sedan";
    body.visible = own; for (const w of wheels) w.w.visible = own;
    if (!own && ext) { extBody = ext; car.add(ext); }
  }
  return { C, setGrid, tick, updateCam, hud, start, stop, bindUI, hAt, kindAt, blocked, addBlock, setProfile, get P() { return P; } };
})();

/* ---------------- 運転 ---------------- */
/* 加減速（一般的な路面電車の性能値。km/h/s）
   力行 P1〜P4: 低速域は一定、約20km/h 以上は定出力で低下 / 制動 B1〜B5（常用最大 4.0）/ 非常 5.0
   加減速度の変化は緩やか（ジャーク制限）。走行抵抗と勾配（軌道の実高さ）も加味 */
const P_ACC = [0, 0.9, 1.7, 2.4, 3.0];
const B_DEC = [0, 0.8, 1.6, 2.4, 3.2, 4.0];
function targetAccel(){
  const v = S.speed;
  let a = 0;
  if(S.emergency) a = -5.0;
  else if(S.notch > 0){ const V=VEH(); a = V.acc[S.notch] * (v > 20 ? 20 / v : 1) * Math.max(0, Math.min(1, (V.vmax - v) / 4)); }
  else if(S.notch < 0) a = -B_DEC[-S.notch];
  if(v > 0.05) a -= 0.05 + 0.0012*v + 0.00003*v*v;
  const g = (pointAt(S.pos+4).y - pointAt(S.pos-4).y) / 8;
  if(v > 0.05 || a > 0) a -= 35.3 * g;
  return a;
}
function routeSignalState(sg){ if(sg.block!=null) return Trams.blockFree(sg.block, Trams.PLAYER) ? 0 : 2; return sg.g==null ? 0 : phaseState(sg.g, sg.ph, S.t); }
let lastWarn=0;
function tick(dt){
  S.t += dt;
  const tgt = targetAccel();
  const rate = (tgt < S.acc) ? 4.5 : 3.0;
  const prevAcc = S.acc;
  S.acc += Math.max(-rate*dt, Math.min(rate*dt, tgt - S.acc));
  S.speed = Math.max(0, Math.min(50, S.speed + S.acc*dt));
  if(S.speed === 0 && S.acc < 0) S.acc = 0;
  if(S.speed === 0 && S.emergency) S.emergency = false;
  $("accel").textContent = (S.acc>=0?"+":"") + S.acc.toFixed(1);
  const lim=limitAt(S.pos); $("limit").textContent=lim;
  if(S.speed>lim+5){ S.score=Math.max(0,S.score-dt*8); if(performance.now()-lastWarn>1500){ setSubtitle("制限速度 "+lim+"km/h を超えています。"); lastWarn=performance.now(); } }
  if(Math.abs(S.acc) > 3.8 && !S.emergency) S.score=Math.max(0,S.score-dt*6);
  if(S.speed>1 && Math.abs(S.acc)>3.6 && !S._harsh){ S._harsh=true; S.comfortHits++; } else if(Math.abs(S.acc)<3.0) S._harsh=false;
  const old=S.pos;
  if(!S.doorOpen) S.pos=Math.min(S.total-0.8, S.pos+S.speed/3.6*dt);
  // 閉そく区間の確保・解放
  if(S.blockIv) for(const q of S.blockIv){ const B=Trams.blocks[q.b]; if(!B) continue; const near=S.pos>q.s0-30 && S.pos-VEH().len<q.s1+1;
    if(near && B.owner===null) B.owner=Trams.PLAYER; if(!near && B.owner===Trams.PLAYER && !S.blockIv.some(r=>r.b===q.b && S.pos>r.s0-30 && S.pos-VEH().len<r.s1+1)) B.owner=null; }
  // 前方の電車・車
  if(S.P){ const ob=Trams.gapAhead(S.P, old, 60, Trams.PLAYER, 1.15);
    if(ob){ const what = ob.o && ob.o.type ? "車" : "電車";
      if(ob.d<0.6){ S.pos=old; if(S.speed>2 && performance.now()-(S._hitT||0)>4000){ S._hitT=performance.now(); S.score=Math.max(0,S.score-60); setSubtitle("前の"+what+"に衝突しました（-60点）。"); } S.speed=0; S.acc=0; }
      else if(ob.d<45 && S.speed>6 && performance.now()-(S._obT||0)>5000){ S._obT=performance.now(); setSubtitle("前方に"+what+"がいます（約"+Math.round(ob.d)+"m）。減速してください。"); } } }
  else if(S.speed>0.5){ setSubtitle("ドアが開いています。"); S.speed=Math.max(0,S.speed-2*dt); }
  if(S.pos>=S.total-0.8 && S.speed>0){ if(S.speed>3){ S.score=Math.max(0,S.score-40); setSubtitle("車止めに当たりました（-40点）。"); } S.speed=0; S.acc=0; }
  // 信号
  while(S.sigIndex<S.signals.length && S.signals[S.sigIndex].stop < old-1) S.sigIndex++;
  const sg=S.signals[S.sigIndex];
  let stTxt="進行", stCls="green", dTxt="--";
  if(sg){ const d=sg.stop-S.pos, st=routeSignalState(sg);
    if(d<250){ dTxt=Math.max(0,Math.round(d))+" m"; stTxt=sg.block!=null ? ["閉そく 進行","注意","閉そく 停止"][st] : ["進行","注意","停止"][st]; stCls=["green","yellow","red"][st]; }
    if(old<=sg.stop && S.pos>sg.stop){ if(st===2){ S.score=Math.max(0,S.score-50); setSubtitle("赤信号を越えました（-50点）。"); } S.sigIndex++; }
  }
  $("siglamp").className="siglamp "+stCls; $("signal-text").textContent=stTxt; $("signal-distance").textContent=dTxt;
  const ds=S.cum[S.stopIndex]-S.pos; $("distance").textContent=ds<50?Math.max(-9.9,ds).toFixed(1):Math.round(ds);
  { const sg=$("stopguide"); const z=doorZone(); const inZone=ds>=z[0] && ds<=z[1];
    $("sgtxt").textContent = S.phase==="pull" ? (inZone && S.speed<0.4 ? "引上線に停車。D で運転台を交換します" : "引上線の停止目標まで "+Math.max(0,ds).toFixed(1)+" m") : S.doorOpen ? "停車中" : ds>60 ? "停止位置: ホーム先端の標識に車両先頭を合わせる" : inZone ? (S.speed<0.4?"ホーム内です。ドアを開けられます（D）"+(Math.abs(ds)>1?"　目標まで "+ds.toFixed(1)+" m":""):"ホーム内（停止目標まで "+ds.toFixed(1)+" m）") : ds>0 ? "停止位置まで "+ds.toFixed(1)+" m" : "停止位置を "+(-ds).toFixed(1)+" m 行き過ぎ";
    sg.classList.toggle("ok", inZone && !S.doorOpen);
    $("sgmark").style.left = (50 - Math.max(-15, Math.min(15, ds)) / 15 * 50) + "%"; }
  Snd.update(dt, S);
  if(!S.doorOpen && S.stopIndex<S.stops.length-1 && S.pos > S.cum[S.stopIndex] + 6){
    const passed=S.stops[S.stopIndex].name; S.stopIndex++; S._appr=false;
    $("stop-seq").textContent=S.stopIndex+" / "+(S.stops.length-1); $("next-stop").textContent=S.stops[S.stopIndex].name;
    setSubtitle(passed.replace(/・.*$/,"")+" を通過しました。"); setTimeout(annDepart, 1200);
  }
  if(!S.doorOpen && !S._appr && ds < 140 && ds > 20 && S.speed > 3){ S._appr = true; annApproach(); }
  const s0=S.cum[S.stopIndex-1]||0, s1=S.cum[S.stopIndex]; $("stop-progress").style.width=(Math.min(1,Math.max(0,(S.pos-s0)/(s1-s0||1)))*100).toFixed(1)+"%";
  const p=pointAt(S.pos);
  for(const lm of (S.routes.landmarks||[])){ if(S.announced.has(lm.name)) continue; if(Math.hypot(lm.x-p.x,lm.z-p.z)<60&&S.speed>1){ S.announced.add(lm.name); setSubtitle("「"+lm.name+"」付近を通過します。"); } }
  $("speed").textContent=Math.round(S.speed); $("cabspd").textContent=Math.round(S.speed); $("score").textContent=Math.round(S.score); $("comfort").textContent="快適 "+Math.round(S.score/10)+"%";
  $("drive-state").textContent=S.doorOpen?"停車中":(S.speed<1?"発車準備":"走行中");
  S.clock+=dt; const hh=Math.floor(S.clock/3600)%24, mm=Math.floor(S.clock/60)%60; $("clock").textContent=String(hh).padStart(2,"0")+":"+String(mm).padStart(2,"0");
  drawSpeedo(); drawMiniMap();
}
/* ドアを開けられる範囲: 先頭が停止目標の 3.5m 先から、ホーム長−4m 手前まで（ホームの無い電停は 12m 区間） */
function doorZone(){ const st=S.stops[S.stopIndex]; const pl=(st && st.plat) || 12; return [-3.5, Math.max(6, pl-4)]; }
function doorAction(){
  if(S.phase==="pull" && !S.doorOpen){
    const ds=S.cum[S.stopIndex]-S.pos, z=[-3.5, 6];
    if(S.speed<0.4 && ds>=z[0] && ds<=z[1]) changeCab();
    else setSubtitle(S.speed<0.4 ? "引上線の停止目標まで進んでください（あと "+ds.toFixed(1)+" m）。" : "停車してから運転台を交換します。");
    return;
  }
  if(!S.doorOpen){
    const ds=S.cum[S.stopIndex]-S.pos;
    const z=doorZone();
    if(S.speed<0.4 && ds>=z[0] && ds<=z[1]){
      S.score=Math.min(1000,S.score+Math.max(0,40-Math.abs(ds)*12)); S._openedAt=S.stopIndex; S.doorOpen=true; $("door").textContent="開";
      Snd.brakeRelease(); setTimeout(()=>Snd.door(true), 500);
      if(AI()===0){ annStart(); setSubtitle(S.stops[S.stopIndex].name+"（乗車）。お客様が乗り終わったらドアを閉めて発車してください。"); }
      else { annArrive(); setSubtitle(S.stops[S.stopIndex].name+"。停車しました。乗降が終わったらドアを閉めて発車してください。"); }
      if(S.stopIndex>=S.stops.length-1) setTimeout(finishRide,1500);
    } else if(S.speed<0.4) setSubtitle(ds>0?"停止位置の手前です（あと"+Math.round(ds)+"m）。":"停止位置を"+Math.round(-ds)+"m 行き過ぎました。");
    else setSubtitle("走行中はドアを開けられません。");
  } else {
    S.doorOpen=false; $("door").textContent="閉"; Snd.door(false);
    if(S.phase==="pull"){ setSubtitle("奥の線路（引上線）へ進み、停止目標で止まったら D（ドア）で運転台を交換します。"); return; }
    if(S._openedAt===S.stopIndex && S.stopIndex<S.stops.length-1) S.stopIndex++;
    S._openedAt=-1;
    S._appr = false; setTimeout(annDepart, 1800);
    $("stop-seq").textContent=S.stopIndex+" / "+(S.stops.length-1); $("next-stop").textContent=S.stops[S.stopIndex].name;
  }
}
function finishRide(){ S.running=false; const tn=S.routes.turn && S.routes.turn[S.baseKey||S.key];
  $("turnback").style.display = tn ? "" : "none";
  $("turnback-label").textContent = tn ? (tn.deadhead ? "折り返し運転（回送で乗り場を移って出発）" : (tn.pull.length ? "折り返し運転（引上線で運転台を交換）" : "折り返し運転（運転台を交換）")) : ""; $("finish-score").textContent=Math.round(S.score); const g=S.score>900?"S":S.score>750?"A":S.score>550?"B":"C";
  { const R=Prefs.record("tram:"+(S.baseKey||S.key), Math.round(S.score)); setTimeout(()=>{ if(R.newBest && R.n>1) $("finish-text").textContent+="\n自己ベスト更新！"; }, 0); }
  $("finish-text").textContent=S.route.name+" "+S.stops[0].name.replace(/・.*$/,"")+" → "+S.stops[S.stops.length-1].name.replace(/・.*$/,"")+"（"+Math.round(S.endArc-S.cum[0])+" m）\n評価: "+g+"（快適スコア "+Math.round(S.score)+" / 1000）\n衝撃減点回数: "+S.comfortHits+"回"; $("finish-overlay").classList.add("on"); }

/* マスコン(S.mc: 切・1〜4) とブレーキ弁(S.bv: 運転・1〜5・非常=6) を別々に持ち、実際の指令(S.notch)を合成する。
   ブレーキ弁が運転位置以外なら制動が優先（力行は遮断）。キー・ボタンは従来どおり1本の軸で操作できる。 */
/* ---- 折り返し ----
   東山: 到着線の先の引上線へ進み、停止 → 運転台交換 → 渡り線を通って発車側の乗り場へ（OSM の配線どおり）
   清輝橋: その場で運転台を交換して発車 / 岡山駅前(新停留場): 回送で発車側の乗り場へ移って出発 */
function routeFromTrack(track, speed, stops, signals, name, dest){ return {name, dest, track, speed, stops, signals:signals||[]}; }
function trackTail(r, len){ const T=r.track; let acc=0, i=T.length-1; while(i>0 && acc<len){ acc+=Math.hypot(T[i][0]-T[i-1][0],T[i][2]-T[i-1][2]); i--; } return {pts:T.slice(i), len:acc}; }
function turnBack(){
  const key=S.baseKey||S.key, tn=S.routes.turn[key]; if(!tn) return;
  $("finish-overlay").classList.remove("on"); S.running=true; S.mc=0; S.bv=Math.max(S.bv,2); applyHandles();
  if(tn.deadhead){
    const sc=S.score, hits=S.comfortHits;
    fadeMsg("回送で折り返しの乗り場へ移動します…", ()=>{ setupRoute(tn.next,false); S.baseKey=tn.next; S.score=sc; S.comfortHits=hits; afterTurn(); });
    return;
  }
  if(tn.pull.length){
    // 引上線へ: 到着経路の最後の 30m + 引上線
    const tail=trackTail(S.route, 30), pts=tail.pts.concat(tn.pull);
    const r=routeFromTrack(pts, pts.map(()=>15), [{name:tn.place+"（降車）", arc:0, plat:12}, {name:"引上線（折り返し）", arc:0, plat:12}], [], S.route.name, "引上線");
    const cur=S.key; applyRoute(r, cur, true); S.stops[1].arc=S.total-1.0; S.cum=S.stops.map(s=>s.arc); S.endArc=S.cum[1];
    S.pos=tail.len; S.speed=0; S.stopIndex=1; S.phase="pull"; S.baseKey=key; S.sigIndex=0; S._openedAt=-1;
    $("next-stop").textContent="引上線（折り返し）"; $("stop-seq").textContent="入換";
    setSubtitle("ドアを閉めて、奥の線路（引上線）へ進んでください。停止目標で止まったら D（ドア）で運転台を交換します。");
    return;
  }
  changeCab();
}
function changeCab(){
  const key=S.baseKey||S.key, tn=S.routes.turn[key];
  const rear=pointAt(S.pos-(VEH().len-0.6));                 // いまの最後部（交換後はこちらが先頭）
  let r, off=0;
  if(tn.pull.length){
    const nx=S.routes[tn.next], back=tn.back, lenB=back.reduce((s,p,i)=>i?s+Math.hypot(p[0]-back[i-1][0],p[2]-back[i-1][2]):0,0);
    const pts=back.concat(nx.track.slice(1));
    r=routeFromTrack(pts, back.map(()=>15).concat(nx.speed.slice(1)), [{name:"引上線", arc:0, plat:12}].concat(nx.stops.map(s=>Object.assign({},s,{arc:s.arc+lenB}))),
                     nx.signals.map(g=>Object.assign({},g,{stop:g.stop+lenB, center:g.center+lenB})), nx.name, nx.dest);
    off=-1;
  } else r=S.routes[tn.next];
  const sc=S.score, hits=S.comfortHits;
  fadeMsg("運転台を交換しています…", ()=>{
    applyRoute(r, tn.next, true); S.annOff=off; S.baseKey=tn.next; S.phase="service";
    // 交換前の最後部に最も近い位置を先頭に
    let best=0, bd=1e18; for(let i=0;i<Math.min(S.track.length,200);i++){ const p=S.track[i], d=(p[0]-rear.x)**2+(p[2]-rear.z)**2; if(d<bd){bd=d; best=i;} }
    S.pos=S.arc[best]+0.6; S.speed=0; S.acc=0; S.sigIndex=0; S.stopIndex=1; S.score=sc; S.comfortHits=hits; S._openedAt=-1;
    S.doorOpen = !tn.pull.length; $("door").textContent=S.doorOpen?"開":"閉";
    afterTurn();
    if(tn.pull.length) setSubtitle("運転台を交換しました。渡り線を通って "+S.stops[1].name.replace(/・.*$/,"")+" の乗り場まで進み、停車したらドアを開けてください。");
  });
}
function afterTurn(){
  if(S.vehicle && S.vehicle!=="momo") setVehicle(S.vehicle);
  mapCache=null; $("route-name").textContent=S.route.name; $("next-stop").textContent=S.stops[S.stopIndex].name; $("stop-seq").textContent=S.stopIndex+" / "+(S.stops.length-1);
  if(S.doorOpen){ S._appr=false; setTimeout(annStart, 600); setSubtitle(S.stops[0].name.replace(/・.*$/,"")+"。折り返し、"+S.route.dest+"行きになります。ドアを閉めて発車してください。"); }
}
function fadeMsg(t, fn){ const f=$("fade"); $("fade-text").textContent=t; f.classList.add("on"); setTimeout(()=>{ fn(); setTimeout(()=>f.classList.remove("on"), 500); }, 900); }
function applyHandles(){
  const prev=S.notch;
  if(S.bv>=6){ if(!S.emergency){ S.emergency=true; S.score=Math.max(0,S.score-10); setSubtitle("非常ブレーキを作動しました。停止後、ブレーキハンドルを戻してください。"); } S.notch=-5; }
  else { if(S.emergency && S.bv<6) S.emergency=false; S.notch = S.bv>0 ? -S.bv : S.mc; }
  if(S.notch!==prev) Snd.notch(S.notch,prev); Snd.levers(S.mc, S.bv); updateNotchBar();
}
function setMC(n){ n=Math.max(0,Math.min(4,n)); if(n>0 && S.doorOpen){ setSubtitle("ドアを閉めてから力行してください。"); n=0; } if(n>0 && S.bv>=6){ setSubtitle("非常ブレーキ中は力行できません。"); } S.mc=n; applyHandles(); }
function setBV(n){ S.bv=Math.max(0,Math.min(6,n)); applyHandles(); }
function setNotch(n){ if(n>0){ S.bv=0; setMC(n); } else if(n<0){ S.mc=0; setBV(-n); } else { S.mc=0; setBV(0); } }
function powerUp(){ if(S.bv>0) setBV(S.bv-1); else setMC(S.mc+1); }
function brakeUp(){ if(S.mc>0) setMC(S.mc-1); else setBV(Math.min(5,S.bv+1)); }
function emergency(){ S.mc=0; setBV(6); }
function toggleView(){ S.view=S.view==="cab"?"chase":"cab"; $("view-toggle").textContent=S.view==="cab"?"⟲":"⌂"; $("ui").classList.toggle("cab", S.view==="cab"); }
document.addEventListener("keydown",e=>{ if((S.mode==="car"||S.mode==="bus") && !e.repeat && (e.key==="t"||e.key==="T")){ rescue(); return; } }, true);
// 時間帯（N）・天気（M）の切り替え（どのモードでも）
document.addEventListener("keydown",e=>{ if(e.repeat) return; if(e.key==="n"||e.key==="N"){ Env.cycle(); } else if(e.key==="m"||e.key==="M"){ Env.set(null, !Env.st.rain); } });
document.querySelectorAll(".time-opt").forEach(b=>b.addEventListener("click",()=>Env.set(b.dataset.time)));
document.querySelectorAll(".rain-opt").forEach(b=>b.addEventListener("click",()=>Env.set(null, !Env.st.rain)));
document.addEventListener("keydown",e=>{ if(S.mode==="car" && Car.C.active && !e.repeat && (e.key==="h"||e.key==="H")){ Snd.horn(); return; } }, true);
document.addEventListener("keydown",e=>{ if(S.mode==="bus" && Bus.active && !e.repeat){ if(e.key==="f"||e.key==="F"){ Bus.doorKey(); return; } if(e.key==="h"||e.key==="H"){ Snd.horn(); return; } } }, true);
$("bus-doorbtn").addEventListener("click",()=>Bus.doorKey());
$("rescue-btn").addEventListener("click",rescue);
document.addEventListener("keydown",e=>{ if(!S.running || e.repeat) return; switch(e.key){
  // マスコン: W 進める / S 戻す、ブレーキハンドル: ↓ 強める / ↑ 緩める（それぞれ独立）
  case "w": case "W": e.preventDefault(); setMC(S.mc+1); break; case "s": case "S": e.preventDefault(); setMC(S.mc-1); break;
  case "ArrowDown": e.preventDefault(); setBV(Math.min(S.bv>=6?6:5, S.bv+1)); break; case "ArrowUp": e.preventDefault(); setBV(S.bv-1); break;
  case "c": case "C": setNotch(0); break; case "d": case "D": doorAction(); break;
  case " ": e.preventDefault(); emergency(); break; case "v": case "V": toggleView(); break;
  case "h": case "H": Snd.horn(); break; } });
document.querySelectorAll(".touch button").forEach(b=>b.addEventListener("click",()=>{ if(!S.running) return; const a=b.dataset.action;
  if(a==="power")powerUp(); else if(a==="brake")brakeUp(); else if(a==="coast")setNotch(0); else if(a==="door")doorAction(); else if(a==="emergency")emergency(); else if(a==="horn")Snd.horn(); }));
$("view-toggle").addEventListener("click",toggleView);
$("help-btn").addEventListener("click",()=>$("help-overlay").classList.add("on"));
$("src-btn").addEventListener("click",()=>$("src-overlay").classList.add("on"));
$("close-src").addEventListener("click",()=>$("src-overlay").classList.remove("on"));
$("src-overlay").addEventListener("click",(e)=>{ if(e.target.id==="src-overlay") $("src-overlay").classList.remove("on"); });
$("close-help").addEventListener("click",()=>$("help-overlay").classList.remove("on"));
function buildRoutePicker(){
  const wrap=$("routes"); wrap.innerHTML="";
  [["higashi","H"],["higashi_r","H"],["seiki","S"],["seiki_r","S"]].forEach(([key,code])=>{ const r=S.routes[key]; if(!r) return; const b=document.createElement("button"); b.type="button";
    b.className="route-opt"+(key===S.key?" on":""); b.dataset.key=key; const len=r.stops[r.stops.length-1].arc-r.stops[0].arc;
    const from=r.stops[0].name.replace(/・.*$/,""), to=r.stops[r.stops.length-1].name.replace(/・.*$/,"");
    b.innerHTML='<span class="rcode '+code.toLowerCase()+'">'+code+'</span><span><strong>'+r.name+'</strong><span class="dir">'+from+' <i>→</i> '+to+'（'+r.stops.length+'停留場・約'+(len/1000).toFixed(1)+'km）</span></span>';
    b.addEventListener("click",()=>{ wrap.querySelectorAll(".route-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); setupRoute(key,true); mapCache=null; });
    wrap.appendChild(b); });
}
/* ---------------- v17: ヘリコプター（空から街を一望する） ----------------
   操作: W/↑ 前進  S/↓ 後退  A/← D/→ 旋回  Q/E 横移動  R・Space 上昇  F・C 下降  Shift 速く  V 視点  O 自動周回
   高さの判定: 地面（2m 格子の路面高さ）と建物の屋上の高さ（4m 格子 hmax）。地図の外は遠景の地形（far）の高さ。
   建物の横から突っ込むと止まり、上から降りると屋上・地面に着地する。 */
const Heli = (() => {
  const H = { active:false, x:0, y:0, z:0, yaw:0, vF:0, vS:0, vY:0, yr:0, pitch:0, roll:0, rotor:0,
              view:"chase", camYaw:0, camPitch:0.32, camDist:30, auto:false, ground:0, agl:0, landed:false, msg:"", msgT:0, hitT:0 };
  let HM = null, FAR = null;
  // 屋上の高さ（4m 格子・1m 単位の uint8。0 = 建物なし）
  function setHmax(meta, buf){ HM = { ...meta, A:new Uint8Array(buf) }; }
  function setFar(meta, buf){ FAR = { ...meta, A:new Int16Array(buf) }; }
  const inData = (x, z) => dataIn(x, z, 2);   // v29: データ範囲は scene.json の drive 格子から
  function farH(x, z){
    if(!FAR) return 0;
    const fx = (x - FAR.x0) / FAR.step, fz = (z - FAR.z0) / FAR.step;
    const i = Math.max(0, Math.min(FAR.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(FAR.nz - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), k = j * FAR.nx + i, A = FAR.A;
    return ((A[k] * (1 - tx) + A[k + 1] * tx) * (1 - tz) + (A[k + FAR.nx] * (1 - tx) + A[k + FAR.nx + 1] * tx) * tz) / 10;
  }
  function waterAt(x, z){
    const W = S._WL; if(!W) return -1e9;
    const i = Math.round((x - W.x0) / W.step), j = Math.round((z - W.z0) / W.step);
    if(i < 0 || j < 0 || i >= W.nx || j >= W.nz) return -1e9;
    const v = W.A[j * W.nx + i]; return v === -32768 ? -1e9 : v / 100;
  }
  function groundAt(x, z){ return inData(x, z) ? Car.hAt(x, z) : farH(x, z); }
  function roofAt(x, z){
    if(!HM) return -1e9;
    const i = Math.floor((x - HM.x0) / HM.step), j = Math.floor((z - HM.z0) / HM.step);
    if(i < 0 || j < 0 || i >= HM.nx || j >= HM.nz) return -1e9;
    const v = HM.A[j * HM.nx + i]; return v ? v : -1e9;
  }
  // 水面の上は 1.2m より下へは降りない（着陸できない）
  const topAt = (x, z) => Math.max(groundAt(x, z), roofAt(x, z), waterAt(x, z) + 1.2);
  // 機体の足元（スキッド 4 点＋中心）で一番高い所
  function footTop(x, z, yaw){
    const fx = Math.sin(yaw), fz = Math.cos(yaw), sx = fz, sz = -fx; let m = topAt(x, z);
    for(const [u, w] of [[2.2, 1.1], [2.2, -1.1], [-1.6, 1.1], [-1.6, -1.1]]) m = Math.max(m, topAt(x + fx * u + sx * w, z + fz * u + sz * w));
    return m;
  }

  // ---- 機体（全長 約12m・ローター直径 10.2m の小型双発ヘリ程度） ----
  const heli = new THREE.Group(); heli.rotation.order = "YXZ"; heli.visible = false; scene.add(heli);
  const body = new THREE.Group(); heli.add(body);
  const white = new THREE.MeshPhongMaterial({ color: 0xf1f1ee, specular: 0x667788, shininess: 60 });
  const blue = new THREE.MeshPhongMaterial({ color: 0x1f4fa0, specular: 0x334455, shininess: 40 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a2c2e });
  const glassM = new THREE.MeshPhongMaterial({ color: 0x142029, specular: 0xaabbcc, shininess: 110, transparent: true, opacity: 0.88 });
  const add = (g, m, x, y, z, p) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); (p || body).add(o); return o; };
  const fus = add(new THREE.SphereGeometry(1, 24, 16), white, 0, 1.55, 0.2); fus.scale.set(1.2, 1.25, 2.55);
  const belly = add(new THREE.SphereGeometry(1, 20, 12), blue, 0, 1.2, 0.3); belly.scale.set(1.16, 0.7, 2.35);
  const can = add(new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), glassM, 0, 1.55, 1.25); can.scale.set(1.08, 1.02, 1.55); can.rotation.x = 1.25;
  const eng = add(new THREE.BoxGeometry(1.3, 0.55, 2.4), white, 0, 2.72, -0.4);
  const boom = add(new THREE.CylinderGeometry(0.2, 0.42, 5.6, 14), white, 0, 1.95, -4.6); boom.rotation.x = Math.PI / 2 + 0.05;
  add(new THREE.BoxGeometry(0.1, 1.5, 1.0), blue, 0, 2.55, -7.2).rotation.x = -0.35;
  add(new THREE.BoxGeometry(2.0, 0.07, 0.42), white, 0, 1.85, -6.1);
  for(const s of [-1, 1]){
    add(new THREE.BoxGeometry(0.03, 0.22, 3.4), blue, s * 1.18, 1.45, 0.1);            // 胴の帯
    const sk = add(new THREE.CylinderGeometry(0.055, 0.055, 3.4, 8), dark, s * 1.08, 0.07, 0.25); sk.rotation.x = Math.PI / 2;
    for(const z of [-0.6, 1.1]){ const st = add(new THREE.CylinderGeometry(0.045, 0.045, 0.95, 6), dark, s * 0.92, 0.5, z); st.rotation.z = s * 0.35; }
  }
  add(new THREE.CylinderGeometry(0.1, 0.12, 0.55, 10), dark, 0, 3.2, -0.2);
  const rotor = new THREE.Group(); rotor.position.set(0, 3.5, -0.2); body.add(rotor);
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 12), dark, 0, 0, 0, rotor);
  const bladeG = new THREE.BoxGeometry(0.28, 0.045, 4.9); bladeG.translate(0, 0, 2.6);
  for(let k = 0; k < 4; k++){ const b = new THREE.Mesh(bladeG, dark); b.rotation.y = k * Math.PI / 2; rotor.add(b); }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.1, 40), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2; disc.position.set(0, 3.52, -0.2); body.add(disc);
  const trot = new THREE.Group(); trot.position.set(0.14, 2.45, -7.35); body.add(trot);
  for(let k = 0; k < 2; k++){ const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.5, 0.14), dark); b.rotation.x = k * Math.PI / 2; trot.add(b); }
  const beacon = add(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }), 0, 2.98, -1.6);
  const navL = add(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3020 }), 1.2, 1.5, 0.2);
  const navR = add(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshBasicMaterial({ color: 0x20ff50 }), -1.2, 1.5, 0.2);
  heli.traverse(o => { if(o.isMesh){ o.castShadow = true; } });
  disc.castShadow = false;

  // ---- 入力 ----
  const key = {}, pad = { f:0, b:0, l:0, r:0, u:0, d:0, fast:0 };
  const K = k => key[k] ? 1 : 0;
  addEventListener("keydown", e => { if(!H.active) return; const k = e.key.toLowerCase(); key[k] = true;
    if(k === "shift") key.shift = true;
    if(!e.repeat){ if(k === "v") cycleView(); else if(k === "o") setAuto(!H.auto); }
    if(["arrowup","arrowdown","arrowleft","arrowright"," ","pageup","pagedown"].includes(k)) e.preventDefault();
    if(["w","s","a","d","q","e","r","f","c"," ","arrowup","arrowdown","arrowleft","arrowright","pageup","pagedown"].includes(k) && H.auto) setAuto(false); });
  addEventListener("keyup", e => { key[e.key.toLowerCase()] = false; if(e.key === "Shift") key.shift = false; });
  addEventListener("blur", () => { for(const k in key) key[k] = false; });
  function cycleView(){ H.view = H.view === "chase" ? "cockpit" : H.view === "cockpit" ? "down" : "chase"; H.msg = { chase:"視点: 機体の後ろ", cockpit:"視点: 操縦席", down:"視点: 真下" }[H.view]; H.msgT = 1.6; H.camYaw = 0; }
  function setAuto(on){ H.auto = on; H.msg = on ? "自動で街の上を周回します（操作するといつでも解除）" : "自動周回を解除しました"; H.msgT = 2.5; const b = $("heli-auto"); if(b) b.classList.toggle("on", on); }
  // マウス・指のドラッグで視点を回す／ホイールで距離
  let drag = null;
  canvas.addEventListener("pointerdown", e => { if(!H.active) return; drag = { x:e.clientX, y:e.clientY, yaw:H.camYaw, pitch:H.camPitch }; });
  addEventListener("pointermove", e => { if(!drag || !H.active) return; H.camYaw = drag.yaw - (e.clientX - drag.x) * 0.006; H.camPitch = Math.max(-0.2, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * 0.005)); });
  addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("wheel", e => { if(!H.active) return; e.preventDefault(); H.camDist = Math.max(14, Math.min(260, H.camDist * Math.exp(e.deltaY * 0.0012))); }, { passive:false });
  function bindUI(){
    const hold = (id, k) => { const el = $(id); if(!el) return; const on = e => { e.preventDefault(); pad[k] = 1; el.classList.add("on"); if(H.auto && k !== "fast") setAuto(false); }, off = () => { pad[k] = 0; el.classList.remove("on"); };
      el.addEventListener("pointerdown", on); el.addEventListener("pointerup", off); el.addEventListener("pointerleave", off); el.addEventListener("pointercancel", off); };
    hold("hp-f", "f"); hold("hp-b", "b"); hold("hp-l", "l"); hold("hp-r", "r"); hold("hp-u", "u"); hold("hp-d", "d"); hold("hp-fast", "fast");
    $("heli-view").addEventListener("click", cycleView);
    $("heli-auto").addEventListener("click", () => setAuto(!H.auto));
  }

  // ---- 出発地 ----
  const STARTS = {
    station: { x: 90, z: -40, y: 120, look: [-150, -110], name: "岡山駅の東の上空" },
    castle:  { x: 1330, z: 150, y: 70, look: [1491, 40], name: "岡山城の南西" },
    garden:  { x: 1500, z: 120, y: 120, look: [1470, -260], name: "岡山城の上空（北に後楽園）" },
    high:    { x: 300, z: 1500, y: 650, look: [1300, 400], name: "市街の南西・上空 650m" }
  };
  let startKey = "station";
  function setStart(k){ if(STARTS[k]) startKey = k; }
  function start(){
    const s = STARTS[startKey];
    H.active = true; heli.visible = true; H.x = s.x; H.z = s.z; H.yaw = Math.atan2(s.look[0] - s.x, s.look[1] - s.z); H.vF = H.vS = H.vY = H.yr = 0; H.auto = false;
    H.y = Math.max(groundAt(s.x, s.z) + s.y, footTop(s.x, s.z, H.yaw));
    H.view = "chase"; H.camYaw = 0; H.camPitch = 0.3; H.camDist = 30; H.msg = s.name + "から出発します"; H.msgT = 3;
    camPos.set(0, 0, 0);
    const b = $("heli-auto"); if(b) b.classList.remove("on");
  }
  function stop(){ H.active = false; heli.visible = false; H.auto = false; camera.up.set(0, 1, 0); }

  // ---- 物理（簡略: 機体座標の前後・左右・上下の速度を目標値へ近づける） ----
  const CEN = { x: 1050, z: 800 }, RAD = 1250;
  function tick(dt){
    if(!H.active) return;
    const fast = key.shift || pad.fast;
    let inF = (K("w") || K("arrowup") || pad.f) - (K("s") || K("arrowdown") || pad.b);
    let inT = (K("a") || K("arrowleft") || pad.l) - (K("d") || K("arrowright") || pad.r);
    let inS = K("q") - K("e") + (pad.s || 0);
    let inY = (K("r") || K(" ") || K("pageup") || pad.u) - (K("f") || K("c") || K("pagedown") || pad.d);
    if(H.auto){
      // 市の中心の周りを反時計回り（半径 1.25km・対地 330m 以上）
      const dx = H.x - CEN.x, dz = H.z - CEN.z, r = Math.hypot(dx, dz) || 1;
      const tx = -dz / r, tz = dx / r, corr = Math.max(-0.6, Math.min(0.6, (r - RAD) / 600));
      const wx = tx - dx / r * corr, wz = tz - dz / r * corr;
      let d = Math.atan2(wx, wz) - H.yaw; while(d > Math.PI) d -= 2 * Math.PI; while(d < -Math.PI) d += 2 * Math.PI;
      inT = Math.max(-1, Math.min(1, d * 2.2)); inF = 0.75; inS = 0;
      const want = Math.max(330, H.agl); inY = Math.max(-1, Math.min(1, (want - H.agl) / 40));
    }
    const vmax = fast ? 83 : 45, amax = fast ? 11 : 7;
    const approach = (v, t, a) => v + Math.max(-a * dt, Math.min(a * dt, t - v));
    const vF0 = H.vF;
    H.vF = approach(H.vF, inF * vmax, inF ? amax : 5);
    H.vS = approach(H.vS, inS * 14, 6);
    H.vY = approach(H.vY, inY * (fast ? 16 : 9), 9);
    H.yr += ((inT * (fast ? 0.45 : 0.6)) - H.yr) * Math.min(1, dt * 3);
    H.yaw += H.yr * dt;
    const fx = Math.sin(H.yaw), fz = Math.cos(H.yaw), sx = fz, sz = -fx;
    const vx = fx * H.vF + sx * H.vS, vz = fz * H.vF + sz * H.vS;
    let nx = H.x + vx * dt, nz = H.z + vz * dt;
    // 行ける範囲: 遠景の地形の内側
    const lim = FAR ? { x0: FAR.x0 + 300, x1: FAR.x0 + FAR.step * (FAR.nx - 1) - 300, z0: FAR.z0 + 300, z1: FAR.z0 + FAR.step * (FAR.nz - 1) - 300 } : { x0: -690, x1: 2790, z0: -390, z1: 2190 };
    if(nx < lim.x0 || nx > lim.x1 || nz < lim.z0 || nz > lim.z1){ nx = Math.max(lim.x0, Math.min(lim.x1, nx)); nz = Math.max(lim.z0, Math.min(lim.z1, nz)); H.vF *= 0.9; H.vS *= 0.9; H.msg = "これより先へは行けません"; H.msgT = 1.2; }
    // 建物の横から当たる: 機首の少し先が今の高さより高い → 止めて少し戻す
    const hv = Math.hypot(vx, vz);
    if(hv > 0.1){
      const ux = vx / hv, uz = vz / hv; let wall = false;
      for(const a of [3.5, 6.5]) for(const w of [0, 1.1, -1.1]){ const t = topAt(nx + ux * a + uz * w, nz + uz * a - ux * w); if(t > H.y + 0.6) wall = true; }
      if(wall){ H.msg = "建物にぶつかりそうです — 上昇するか向きを変えてください"; H.msgT = 1.8;
        H.hitT = 0.4; nx = H.x - ux * 0.4; nz = H.z - uz * 0.4; H.vF *= -0.2; H.vS *= -0.2; }
    }
    H.hitT = Math.max(0, H.hitT - dt);
    H.x = nx; H.z = nz;
    H.y += H.vY * dt;
    H.y = Math.min(H.y, 1500);
    const top = footTop(H.x, H.z, H.yaw);
    H.landed = H.y <= top + 0.02;
    if(H.y < top){ H.y = top; if(H.vY < 0) H.vY = 0; }
    if(H.landed){ H.vF *= Math.max(0, 1 - dt * 2.5); H.vS *= Math.max(0, 1 - dt * 2.5); }
    H.ground = groundAt(H.x, H.z); H.agl = H.y - Math.max(H.ground, roofAt(H.x, H.z));
    // 見た目の傾き（前進で機首下げ・旋回でバンク）
    const accF = (H.vF - vF0) / Math.max(dt, 1e-3);
    const wantP = H.landed ? 0 : Math.max(-0.3, Math.min(0.3, H.vF * 0.0023 + accF * 0.012));
    const wantR = H.landed ? 0 : Math.max(-0.45, Math.min(0.45, -H.yr * H.vF * 0.016 - H.vS * 0.02));
    H.pitch += (wantP - H.pitch) * Math.min(1, dt * 2.5); H.roll += (wantR - H.roll) * Math.min(1, dt * 2.5);
    H.rotor += dt * (H.landed && Math.abs(H.vY) < 0.1 && inY <= 0 ? 36 : 42);
    heli.position.set(H.x, H.y, H.z); heli.rotation.set(H.pitch, H.yaw, H.roll);
    rotor.rotation.y = H.rotor; trot.rotation.x = H.rotor * 4.3;
    const blink = (performance.now() % 1200) < 110; beacon.visible = blink;
    H.msgT = Math.max(0, H.msgT - dt);
  }

  // ---- 視点 ----
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), _w = new THREE.Vector3();
  function updateCam(dt){
    const fx = Math.sin(H.yaw), fz = Math.cos(H.yaw);
    if(H.view === "cockpit"){
      body.visible = false; camera.up.set(0, 1, 0);
      const sx = fz, sz = -fx;
      camera.position.set(H.x + fx * 1.9 + sx * 0.35, H.y + 1.75, H.z + fz * 1.9 + sz * 0.35);
      const a = H.yaw + H.camYaw, p = -0.14 - (H.camPitch - 0.3) * 0.8 - H.pitch * 0.6;
      camera.lookAt(camera.position.x + Math.sin(a) * Math.cos(p) * 30, camera.position.y + Math.sin(p) * 30, camera.position.z + Math.cos(a) * Math.cos(p) * 30);
      camPos.set(0, 0, 0); return;
    }
    body.visible = true;
    if(H.view === "down"){
      camera.up.set(fx, 0, fz);
      camera.position.set(H.x, H.y - 0.3, H.z); camera.lookAt(H.x, H.y - 100, H.z);
      body.visible = false; camPos.set(0, 0, 0); return;
    }
    camera.up.set(0, 1, 0);
    const a = H.yaw + H.camYaw, p = H.camPitch, d = H.camDist;
    _w.set(H.x - Math.sin(a) * Math.cos(p) * d, H.y + 2.5 + Math.sin(p) * d, H.z - Math.cos(a) * Math.cos(p) * d);
    if(camPos.lengthSq() === 0 || camPos.distanceTo(_w) > 200) camPos.copy(_w);
    camPos.lerp(_w, Math.min(1, dt * 5));
    const gh = topAt(camPos.x, camPos.z) + 1.5; if(camPos.y < gh) camPos.y = gh;
    camLook.set(H.x, H.y + 2.2, H.z);
    camera.position.copy(camPos); camera.lookAt(camLook);
  }
  // 読み込み範囲の中心（高い所では前方の地面の先）
  function focus(out){
    const fx = Math.sin(H.yaw + (H.view === "chase" ? H.camYaw : 0)), fz = Math.cos(H.yaw + (H.view === "chase" ? H.camYaw : 0));
    const ahead = H.view === "down" ? 0 : Math.min(700, Math.max(0, H.agl) * 1.1);
    out.x = H.x + fx * ahead; out.z = H.z + fz * ahead; return out;
  }
  const DIRS = ["北","北東","東","南東","南","南西","西","北西"];
  function hud(){
    // 方位: yaw=0 は南向き（+z）。x=東
    const hd = ((Math.atan2(Math.sin(H.yaw), -Math.cos(H.yaw)) * 180 / Math.PI) + 360) % 360;   // 北=0・東=90
    $("heli-speed").textContent = Math.round(Math.hypot(H.vF, H.vS) * 3.6);
    $("heli-alt").textContent = Math.round(H.y);
    $("heli-agl").textContent = Math.max(0, Math.round(H.agl));
    $("heli-hdg").textContent = DIRS[Math.round(hd / 45) % 8] + " " + String(Math.round(hd)).padStart(3, "0") + "°";
    $("heli-vs").textContent = (H.vY >= 0 ? "+" : "") + H.vY.toFixed(1);
    const overWater = waterAt(H.x, H.z) > groundAt(H.x, H.z) + 0.3;
    $("heli-msg").textContent = H.msgT > 0 ? H.msg : H.landed ? (overWater ? "水面の上です（着陸できません）— 上昇してください" : "着地しています — R・Space（または 上昇）で離陸") : "";
  }
  return { H, heli, pad, setHmax, setFar, tick, updateCam, focus, hud, start, stop, bindUI, setStart, topAt, groundAt, farH, roofAt, get fogK(){ return Math.max(1, Math.min(6, 1 + (H.y - 20) / 160)); } };
})();

function beginRide(){ setupRoute(S.key,false); if(S.vehicle && S.vehicle!=="momo") setVehicle(S.vehicle); S.baseKey=S.key; S._camD=null; mapCache=null; $("route-name").textContent=S.route.name; $("next-stop").textContent=S.stops[1].name;
  $("stop-seq").textContent="1 / "+(S.stops.length-1); $("menu").style.display="none"; $("ui").classList.add("on"); $("finish-overlay").classList.remove("on");
  S.mode="tram"; Car.stop(); $("carui").classList.remove("on"); buildNotchBar(); S.mc=0; S.bv=0; applyHandles();
  $("ui").classList.toggle("cab", S.view==="cab");
  S.running=true; buildNotchBar(); updateNotchBar();
  setSubtitle((S.key.endsWith("_r") ? S.stops[0].name : "岡山駅前（駅前広場の新停留場）") + "。ドアを閉めて、ブレーキハンドルを運転位置に戻し、マスコンを入れてください。");
  Snd.init(); Snd.hush(); S._appr=false; setTimeout(annStart, 600);
  Trams.populate(S.key, S.pos, S.vehicle); Traffic.reset(); }
$("start").addEventListener("click",()=>{ if($("start").disabled) return; const sel=document.querySelector(".mode-opt.on"); const m=sel ? sel.dataset.mode : S.mode;
  if(m==="car") beginCar(); else if(m==="bus") beginBus(); else if(m==="heli") beginHeli(); else beginRide(); });
function beginHeli(){
  S.mode="heli"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.remove("on"); $("heliui").classList.add("on");
  Car.stop(); setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush(); Heli.start();
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false;
  Stream.tick(); }
$("heli-menu").addEventListener("click",()=>{ Heli.stop(); Snd.heliSound(Heli.H); S.mode="menu"; Loc.hide(); $("heliui").classList.remove("on"); $("menu").style.display="flex"; });
document.querySelectorAll(".hstart-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".hstart-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); Heli.setStart(b.dataset.start); }));
Heli.bindUI();
function beginCar(){
  S.mode="car"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.add("on");
  Car.setProfile("sedan"); $("car-mode-lbl").textContent="車で自由に走る"; $("busui").classList.remove("on");
  setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush(); Car.start();
  // 出発点: 桃太郎大通りの東行き車線（左側通行）
  const sp = Traffic.ready ? Traffic.startPose(40, -12, 1, 0) : null; if(sp){ Car.C.x=sp.x; Car.C.z=sp.z; Car.C.yaw=sp.yaw; }
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false; }
function beginBus(){
  if(!Bus.data){ alert("バスの経路データを読み込めませんでした。"); return; }
  S.mode="bus"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.add("on");
  $("car-mode-lbl").textContent="両備バス 西大寺線"; $("finish-overlay").classList.remove("on");
  setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush();
  Bus.begin();
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false; }
$("car-menu").addEventListener("click",()=>{ if(Bus.active) Bus.end(); Car.stop(); Snd.carSound(Car.C); S.mode="menu"; Loc.hide(); $("carui").classList.remove("on"); $("menu").style.display="flex"; });
document.querySelectorAll(".veh-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".veh-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  S.vehicle=b.dataset.veh; if(S.car) setVehicle(S.vehicle); }));
document.querySelectorAll(".mode-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".mode-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  S.mode=["car","bus","heli"].includes(b.dataset.mode)?b.dataset.mode:"tram"; $("routes-wrap").style.display=S.mode==="tram"?"":"none"; $("car-note").style.display=S.mode==="car"?"":"none"; $("bus-note").style.display=S.mode==="bus"?"":"none"; $("heli-note").style.display=S.mode==="heli"?"":"none";
  $("start-label").textContent=S.mode==="car"?"車で走り出す":S.mode==="bus"?"バスの運転を始める":S.mode==="heli"?"ヘリで飛び立つ":"運転を開始する"; }));
document.querySelectorAll(".look-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".look-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); setLook(b.dataset.look); }));
document.querySelectorAll(".shadow-opt").forEach(b=>b.addEventListener("click",()=>{ const on=!b.classList.contains("on"); b.classList.toggle("on",on); b.textContent="影: "+(on?"あり":"なし"); setShadows(on); }));
Car.bindUI();
// 車モード: 他の車・電車との接触（進む先の車体の範囲に何かあれば止める）
const CAR_OBST = (x, z, fx, fz, dir) => { if (!Trams.ready) return null; const hl = Car.P.len / 2 - 0.3, sx = fz, sz = -fx, hw = Car.P.wid / 2 - 0.35;
  // 進む向きの半分だけ調べる（前に何かあっても後ろへは下がれる）
  const u0 = dir < 0 ? 0 : hl, u1 = dir > 0 ? 0 : -hl;
  for (let u = u0; u >= u1; u -= 1.3) for (const w of (hw > 0.6 ? [hw, -hw] : [0])) { const e = Obs.hit(x + fx * u + sx * w, z + fz * u + sz * w, 0.55, PCAR); if (e) return e.o && e.o.ped !== undefined ? "歩行者" : e.o && e.o.type ? (e.o.type.name === "bus" ? "バス" : "他の車") : "電車"; } return null; };
Car.C.obst = CAR_OBST;
Cab.bind({ getMC:()=>S.mc, setMC:(n)=>{ if(S.running) setMC(n); }, getBV:()=>S.bv, setBV:(n)=>{ if(S.running) setBV(n); } });
$("sound-btn").addEventListener("click",()=>{ Snd.init(); const on=Snd.toggle(); Prefs.setSound(on); $("sound-btn").textContent=on?"音":"消"; $("sound-btn").title=on?"音を消す":"音を出す"; });
// v25: 音を消す設定を覚えている時は、始めた時に消す
$("start").addEventListener("click",()=>{ setTimeout(()=>{ if(!Prefs.soundOn && Snd.on){ Snd.init(); Snd.toggle(); $("sound-btn").textContent="消"; $("sound-btn").title="音を出す"; } }, 80); });
$("turnback").addEventListener("click", turnBack);
$("restart").addEventListener("click",()=>{ Snd.hush(); $("finish-overlay").classList.remove("on"); $("menu").style.display="flex"; $("ui").classList.remove("on");
  if(Bus.active){ Bus.end(); Car.stop(); $("carui").classList.remove("on"); S.mode="bus"; } Loc.hide(); $("turnback").style.display=""; });

/* 案内パネル（次の停留場）の高さが変わっても、信号・制限速度・スコアの行が重ならないよう下に並べる */
let _hudT=0;
function layoutHud(){
  if(!S.running || performance.now()-_hudT<250) return; _hudT=performance.now();
  const m=document.querySelector("#ui .mission"), r=document.querySelector("#ui .rack"), mm=document.querySelector("#ui .minimap");
  if(!m||!r) return; const top=m.offsetTop+m.offsetHeight+8; r.style.top=top+"px";
  if(mm) mm.style.top = S.view==="cab" ? "64px" : top+"px";
}
function onResize(){ renderer.setSize(innerWidth,innerHeight); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); }
addEventListener("resize",onResize); onResize();
let last=performance.now(), lampT=0;
const PCAR={kind:"playercar"}; PCAR_REF.o=PCAR;
/* ---------------- 救済: すぐそばの道路へ戻す（車・バス） ---------------- */
function rescue(){
  if(!(S.mode==="car"||S.mode==="bus") || !Car.C.active) return;
  const C=Car.C; let t=null;
  if(S.mode==="bus" && Bus.active){ t=Bus.nearestOnRoute(C.x, C.z); }
  else if(Traffic.ready){ t=Traffic.nearestLane(C.x, C.z, C.yaw); }
  if(!t){ C.msg="近くに戻れる道路が見つかりませんでした"; C.msgT=3; return; }
  C.v=0;
  fadeMsg("すぐそばの道路へ戻しています…", ()=>{ C.x=t.x; C.z=t.z; C.yaw=t.yaw; C.v=0; C.wheel=0; C.gear="D"; C.hitT=0; C.h=Car.hAt(t.x,t.z); Stuck.reset();
    C.msg="道路に戻りました（減点なし）"; C.msgT=3; });
}
/* 動けなくなったことを検知して、救済ボタンを光らせる */
const Stuck=(()=>{ let t=0, hits=0, lastHit=0, off=0;
  function tick(dt){
    if(!(S.mode==="car"||S.mode==="bus") || !Car.C.active){ $("rescue-btn").classList.remove("hint"); return; }
    const C=Car.C;
    if(C.hitT>1.1 && performance.now()-lastHit>900){ lastHit=performance.now(); hits++; }
    if(Math.abs(C.v)<0.4 && (C.thr||0)>0.3) t+=dt; else t=Math.max(0,t-dt*0.5);
    const k=Car.kindAt ? Car.kindAt(C.x,C.z) : 1; if(k!==1 && !(S.mode==="bus" && Bus.active && Bus.onRoute())) off+=dt; else off=0;
    const stuck = t>2.5 || hits>=3 || off>5;
    $("rescue-btn").classList.toggle("hint", stuck);
    if(stuck && !C._stuckMsg){ C._stuckMsg=true; C.msg="動けないときは「道路に戻る」（T キー）で近くの道路へ戻れます"; C.msgT=5; }
    if(!stuck) C._stuckMsg=false;
    if(performance.now()-lastHit>8000) hits=0;
  }
  function reset(){ t=0; hits=0; off=0; }
  return {tick, reset};
})();
/* ---------------- 歩行者・自転車（v22） ----------------
   通り道: data/peds.json（pipeline/peds.py: OSM の歩道・横断歩道・歩行者道・商店街・細い道）。
   ・カメラ（運転中は自分の車両）の周り 230m に、通り道の人の多さ（商店街・駅前・表町ほど多い）×時間帯×天気に応じた人数を出す
   ・歩く速さ 0.9〜1.6 m/s、自転車 3.4〜5.0 m/s。交差点で次の道を選び、横断歩道は歩行者用信号（車の青の終わり 14 秒前に点滅・8 秒前に赤）に従う。
     信号の無い横断歩道は、近くに車・電車がいない時に渡る。渡っている人は車・電車の障害物になる（右左折の車は待つ）
   ・細い道（歩道の無い道）は道の右端を歩く（人は右）。自転車は左
   ・自分の車・バスの前では立ち止まる。自分の車が人に当たると「衝突（歩行者）」
   ・雨の日は傘をさす。夜は少なく
   人の多さ・速さ・信号の秒数は一般的な値による仮定 */
const Peds = (() => {
  let E = [], NODE = null, ADJ = [], CELLS = new Map(), ready = false;
  const CS = 60;       // 出現位置を探す升目（m）
  const MAXP = 760, MAXB = 110, R_IN = 230, R_OUT = 290;
  const peds = [], bikes = [];
  const U = { uRain: { value: 0 } };
  let meshP = null, meshB = null, sigMesh = null, sigData = [];
  const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  function pedState(g, ph, t){      // 0 青 1 点滅 2 赤
    const I = S.scene && S.scene.isects && S.scene.isects[g]; if(!I) return 0;
    const tt = ((t + I.off) % CYCLE + CYCLE) % CYCLE;
    const u = ph === 0 ? tt : tt - (MAIN_G + Y_T + AR), G = ph === 0 ? MAIN_G : CROSS_G;
    if(u < 0 || u >= G) return 2;
    return u < G - 14 ? 0 : u < G - 8 ? 1 : 2;
  }
  function init(J){
    if(!J || !J.nodes) return;
    NODE = J.nodes; ADJ = NODE.map(() => []);
    E = J.edges.map((e, i) => {
      const P = new Float32Array(e[8]), n = P.length / 2, cum = new Float32Array(n);
      for(let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(P[2*k] - P[2*k-2], P[2*k+1] - P[2*k-1]);
      const o = { a: e[0], b: e[1], k: e[2], w: e[3], lat: e[4], g: e[5], ph: e[6], bike: e[7], P, cum, L: cum[n - 1], i };
      ADJ[o.a].push(i); ADJ[o.b].push(i);
      // 出現用の升目（辺の中点）
      const mx = (P[0] + P[2*n-2]) / 2, mz = (P[1] + P[2*n-1]) / 2, key = Math.floor(mx / CS) + "," + Math.floor(mz / CS);
      let c = CELLS.get(key); if(!c){ c = []; CELLS.set(key, c); } c.push(i);
      return o;
    });
    buildMeshes(); buildPedSignals(); ready = true;
    console.log("peds: edges", E.length, "nodes", NODE.length);
  }
  // 辺の上の位置（s: 始点からの距離）と向き
  function at(e, s, out){
    const P = e.P, c = e.cum, n = c.length; s = Math.max(0, Math.min(e.L, s));
    let lo = 0, hi = n - 1; while(hi - lo > 1){ const m = (lo + hi) >> 1; if(c[m] <= s) lo = m; else hi = m; }
    const L = c[hi] - c[lo] || 1e-6, t = (s - c[lo]) / L;
    out.x = P[2*lo] + (P[2*hi] - P[2*lo]) * t; out.z = P[2*lo+1] + (P[2*hi+1] - P[2*lo+1]) * t;
    out.dx = (P[2*hi] - P[2*lo]) / L; out.dz = (P[2*hi+1] - P[2*lo+1]) / L; return out;
  }
  /* ---- 形 ---- aPart: 0 肌 1 上着 2 下 3 靴・タイヤ 4 髪 5 傘 6 自転車の車体 7 金属。aLimb: 1 左脚 2 右脚 3 左腕 4 右腕 */
  function geo(kind){
    const pos = [], nrm = [], part = [], limb = [];
    const add = (g, p, l) => { g = g.toNonIndexed(); const pa = g.attributes.position.array, na = g.attributes.normal.array;
      for(let i = 0; i < pa.length; i++){ pos.push(pa[i]); nrm.push(na[i]); } for(let i = 0; i < pa.length / 3; i++){ part.push(p); limb.push(l); } g.dispose(); };
    const box = (w, h, d, x, y, z, p, l, rx) => { const g = new THREE.BoxGeometry(w, h, d); if(rx) g.rotateX(rx); g.translate(x, y, z); add(g, p, l || 0); };
    if(kind === "ped"){
      const hd = new THREE.SphereGeometry(0.105, 10, 8); hd.scale(1, 1.12, 1.05); hd.translate(0, 1.6, 0.01); add(hd, 0, 0);
      const hr = new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI*2, 0, Math.PI*0.55); hr.scale(1, 1.1, 1.08); hr.translate(0, 1.615, -0.012); add(hr, 4, 0);
      box(0.08, 0.08, 0.08, 0, 1.47, 0, 0);                             // 首
      box(0.36, 0.52, 0.21, 0, 1.19, 0, 1); box(0.33, 0.1, 0.2, 0, 0.9, 0, 2);   // 胴・腰
      for(const sx of [-1, 1]){
        box(0.13, 0.5, 0.14, sx*0.09, 0.62, 0, 2, sx < 0 ? 1 : 2);         // 太もも〜すね
        box(0.12, 0.36, 0.13, sx*0.09, 0.2, 0, 2, sx < 0 ? 1 : 2);
        box(0.11, 0.07, 0.25, sx*0.09, 0.035, 0.04, 3, sx < 0 ? 1 : 2);     // 靴
        box(0.09, 0.3, 0.1, sx*0.235, 1.28, 0, 1, sx < 0 ? 3 : 4);          // 上腕
        box(0.08, 0.26, 0.09, sx*0.235, 1.0, 0.01, 1, sx < 0 ? 3 : 4);      // 前腕
        box(0.07, 0.09, 0.08, sx*0.235, 0.83, 0.01, 0, sx < 0 ? 3 : 4);     // 手
      }
      box(0.22, 0.26, 0.09, 0.26, 0.86, -0.02, 3, 3);                       // かばん（左手）
      // 傘（右手で持つ。雨の時だけ）
      const um = new THREE.ConeGeometry(0.52, 0.28, 10, 1, true); um.translate(0.12, 2.12, 0.08); add(um, 5, 0);
      const um2 = new THREE.ConeGeometry(0.52, 0.28, 10, 1, true); um2.rotateX(Math.PI); um2.scale(1, 0.05, 1); um2.translate(0.12, 1.985, 0.08); add(um2, 5, 0);
      box(0.02, 0.95, 0.02, 0.14, 1.52, 0.08, 7, 0);
    } else {
      // ママチャリ＋乗る人（+z 前）
      const wheel = (z) => { const g = new THREE.TorusGeometry(0.33, 0.035, 6, 16); g.rotateY(Math.PI/2); g.translate(0, 0.35, z); add(g, 3, 0);
        const h = new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6); h.rotateZ(Math.PI/2); h.translate(0, 0.35, z); add(h, 7, 0); };
      wheel(0.55); wheel(-0.52);
      box(0.04, 0.04, 0.9, 0, 0.55, 0.02, 6, 0, -0.35); box(0.04, 0.5, 0.04, 0, 0.62, -0.22, 6, 0, 0.3); box(0.04, 0.5, 0.04, 0, 0.62, 0.48, 6, 0, -0.25);
      box(0.5, 0.03, 0.03, 0, 1.0, 0.44, 7, 0); box(0.3, 0.2, 0.25, 0, 0.88, 0.72, 7, 0);       // ハンドル・かご
      box(0.18, 0.05, 0.24, 0, 0.9, -0.24, 3, 0);                                               // サドル
      box(0.08, 0.05, 0.52, 0, 0.72, -0.62, 7, 0);                                              // 荷台
      box(0.1, 0.2, 0.5, 0, 0.47, -0.52, 6, 0);                                                 // 泥よけ（後）
      const hd = new THREE.SphereGeometry(0.105, 10, 8); hd.scale(1, 1.12, 1.05); hd.translate(0, 1.66, 0.12); add(hd, 0, 0);
      const hr = new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI*2, 0, Math.PI*0.55); hr.scale(1, 1.1, 1.08); hr.translate(0, 1.675, 0.1); add(hr, 4, 0);
      box(0.36, 0.5, 0.22, 0, 1.25, -0.02, 1, 0, 0.25); box(0.33, 0.12, 0.26, 0, 0.97, -0.18, 2, 0);
      for(const sx of [-1, 1]){
        box(0.13, 0.42, 0.14, sx*0.1, 0.8, -0.02, 2, sx < 0 ? 1 : 2, -1.1);   // ペダルをこぐ脚
        box(0.12, 0.36, 0.13, sx*0.1, 0.45, 0.14, 2, sx < 0 ? 1 : 2);
        box(0.11, 0.07, 0.24, sx*0.1, 0.28, 0.2, 3, sx < 0 ? 1 : 2);
        box(0.08, 0.5, 0.09, sx*0.2, 1.2, 0.26, 1, 0, -0.9);                    // 腕（ハンドルへ）
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Array(pos.length).fill(1), 3));
    g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1)); g.setAttribute("aLimb", new THREE.Float32BufferAttribute(limb, 1));
    return g;
  }
  function mat(bike){
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRain = U.uRain;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", `#include <common>
        attribute float aPart; attribute float aLimb; attribute vec2 iAnim; attribute vec3 iTop; attribute vec3 iBot; attribute vec3 iHair; attribute vec3 iExtra; uniform float uRain;`)
        .replace("#include <begin_vertex>", `vec3 transformed = vec3(position);
          float sw = sin(iAnim.x) * iAnim.y;
          if(aLimb > 0.5){
            float leg = step(aLimb, 2.5);
            float piv = ${bike ? "0.95" : "0.92"} * leg + 1.43 * (1.0 - leg);
            float sgn = (abs(aLimb - 1.0) < 0.1 || abs(aLimb - 4.0) < 0.1) ? 1.0 : -1.0;
            float ang = sgn * sw * (leg > 0.5 ? ${bike ? "0.75" : "0.55"} : 0.42);
            if(aLimb > 3.5) ang *= (1.0 - uRain);
            float c = cos(ang), s = sin(ang); float y = transformed.y - piv, z = transformed.z;
            transformed.y = piv + y * c - z * s; transformed.z = y * s + z * c;
          }
          ${bike ? "" : "if(aPart > 4.5 && aPart < 7.5) transformed = mix(vec3(0.0, 1.0, 0.0), transformed, uRain); if(aLimb < 0.5) transformed.y += abs(cos(iAnim.x)) * 0.025 * min(iAnim.y * 3.0, 1.0);"}
          ${bike ? "if(aPart > 4.5 && aPart < 5.5) transformed = vec3(0.0);" : ""}`)
        .replace("#include <color_vertex>", `vColor = vec3(1.0);
          vec3 skin = vec3(0.92, 0.75, 0.62);
          vColor = aPart < 0.5 ? skin : aPart < 1.5 ? iTop : aPart < 2.5 ? iBot : aPart < 3.5 ? vec3(0.09, 0.085, 0.08) : aPart < 4.5 ? iHair : aPart < 5.5 ? iExtra : aPart < 6.5 ? iExtra : vec3(0.55, 0.56, 0.58);`);
    };
    return m;
  }
  function buildMeshes(){
    const mk = (kind, N) => {
      const g = geo(kind);
      g.setAttribute("iAnim", new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2).setUsage(THREE.DynamicDrawUsage));
      for(const a of ["iTop", "iBot", "iHair", "iExtra"]) g.setAttribute(a, new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
      const m = new THREE.InstancedMesh(g, mat(kind === "bike"), N); m.count = 0; m.frustumCulled = false; m.castShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m); return m;
    };
    meshP = mk("ped", MAXP); meshB = mk("bike", MAXB);
  }
  /* ---- 服の色（日本の街の一般的な配色: 黒・紺・灰・白・ベージュが多い） ---- */
  const TOPS = [["#1d1e22",20],["#f0efe9",16],["#3a3f4a",10],["#26324d",10],["#8d8b86",9],["#c9b79a",8],["#6e2a2a",3],["#2e4a3a",3],["#9fb3c8",5],["#d9c9b0",5],["#e8d6d0",3],["#b5543f",2],["#e2c14c",1],["#4c5b8a",4],["#3c3c3c",6]];
  const BOTS = [["#1b1c20",26],["#2a3346",18],["#6f7278",8],["#c2b39a",8],["#3d3a36",10],["#d8d4cc",4],["#4a5f7c",10],["#5b4636",5]];
  const HAIR = [["#15110e",55],["#2b1f18",25],["#4a3526",10],["#7a7672",6],["#b8b3ad",4]];
  const UMB = [["#f4f4f2",30],["#1c1c1e",20],["#1f3a66",12],["#7c1f2a",6],["#2f5d3a",5],["#e7d24a",3],["#c7ccd2",14],["#e58fb0",4]];
  const FRAME = [["#d8d8d6",20],["#1e1e20",18],["#8a1b1f",10],["#1d3d73",10],["#6b7d5a",6],["#c9b37a",6],["#e8e3cf",8]];
  const pick = (A) => { let r = Math.random() * A.reduce((a, b) => a + b[1], 0); for(const [c, w] of A){ if((r -= w) <= 0) return c; } return A[0][0]; };
  const _c = new THREE.Color();
  function setCols(mesh, i, o){
    const at = mesh.geometry.attributes;
    _c.set(o.top); at.iTop.setXYZ(i, _c.r, _c.g, _c.b); _c.set(o.bot); at.iBot.setXYZ(i, _c.r, _c.g, _c.b);
    _c.set(o.hair); at.iHair.setXYZ(i, _c.r, _c.g, _c.b); _c.set(o.ext); at.iExtra.setXYZ(i, _c.r, _c.g, _c.b);
    for(const a of ["iTop", "iBot", "iHair", "iExtra"]) at[a].needsUpdate = true;
  }
  /* ---- 人の多さ ---- */
  function timeK(){ const t = Env.st.time; return (t === "night" ? 0.3 : t === "morning" ? 0.8 : t === "evening" ? 1.1 : 1.0) * (Env.st.rain ? 0.6 : 1.0); }
  const DENS = 1 / 22;   // 人の多さ 1.0 の歩道で 22m に 1 人（両側の合計）
  function nearCells(cx, cz, r){ const out = []; const i0 = Math.floor((cx - r) / CS), i1 = Math.floor((cx + r) / CS), j0 = Math.floor((cz - r) / CS), j1 = Math.floor((cz + r) / CS);
    for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++){ const c = CELLS.get(i + "," + j); if(c) out.push(c); } return out; }
  let pool = null, poolW = 0, poolAt = null, target = 0;
  function rebuildPool(cx, cz){
    pool = []; poolW = 0; let wl = 0;
    for(const c of nearCells(cx, cz, R_IN)) for(const ei of c){ const e = E[ei]; const p = at(e, e.L / 2, {}); if(Math.hypot(p.x - cx, p.z - cz) > R_IN) continue;
      const w = e.w * e.L; if(w <= 0) continue; poolW += w; pool.push([poolW, ei]); wl += e.w * e.L; }
    target = Math.min(MAXP + MAXB, Math.round(wl * DENS * timeK()));
    poolAt = { x: cx, z: cz };
  }
  function pickEdge(){ if(!pool || !pool.length) return -1; const r = Math.random() * poolW; let lo = 0, hi = pool.length - 1; while(lo < hi){ const m = (lo + hi) >> 1; if(pool[m][0] < r) lo = m + 1; else hi = m; } return pool[lo][1]; }
  const _p = { x: 0, z: 0, dx: 0, dz: 1 };
  function inView(x, z){ const dx = x - camera.position.x, dz = z - camera.position.z, d = Math.hypot(dx, dz); if(d > 150) return false; camera.getWorldDirection(_v); return d < 18 || (dx * _v.x + dz * _v.z) / d > 0.3; }
  function spawn(o, bike, avoidView){
    for(let tries = 0; tries < 8; tries++){
      const ei = pickEdge(); if(ei < 0) return false; const e = E[ei];
      if(bike && (!e.bike || e.k === 2 || e.k === 4)) continue;
      if(!bike && e.k === 6 && Math.random() < 0.7) continue;
      const s = Math.random() * e.L; at(e, s, _p);
      if(avoidView && inView(_p.x, _p.z)) continue;
      o.e = ei; o.dir = Math.random() < 0.5 ? 1 : -1; o.s = s; o.bike = bike;
      const kid = !bike && Math.random() < 0.06, old = !bike && !kid && Math.random() < 0.14;
      o.v0 = bike ? 3.4 + Math.random() * 1.6 : kid ? 1.1 + Math.random() * 0.4 : old ? 0.85 + Math.random() * 0.3 : 1.15 + Math.random() * 0.4;
      o.sc = kid ? 0.62 + Math.random() * 0.12 : 0.92 + Math.random() * 0.14; o.v = o.v0;
      o.side = Math.random() * 2 - 1; o.latC = null; o.wait = 0; o.stand = !bike && Math.random() < 0.08 ? 6 + Math.random() * 30 : 0; o.face = Math.random() * 6.283;
      o.ph = Math.random() * 6.283; o.hit = 0;
      o.top = pick(TOPS); o.bot = pick(BOTS); o.hair = old ? (Math.random() < 0.6 ? "#b8b3ad" : "#7a7672") : pick(HAIR); o.ext = bike ? pick(FRAME) : pick(UMB); o.skin = Math.random();
      o.ped = true; o.dirty = true; o.on = true; return true;
    }
    return false;
  }
  /* 横位置（進む向きの右が +）: 細い道は人は右端・自転車は左端、歩道・横断歩道は幅の中でばらける */
  function latOf(o, e){ if(e.k === 5) return o.bike ? -e.lat * (0.8 + 0.2 * Math.abs(o.side)) : e.lat * (0.8 + 0.2 * Math.abs(o.side)); return o.side * e.lat; }
  function chooseNext(o, node){
    const L = ADJ[node]; let best = -1, sum = 0; const cand = [];
    for(const ei of L){ if(ei === o.e && L.length > 1) continue; const e = E[ei]; if(o.bike && (!e.bike || e.k === 4 || e.k === 2)) continue;
      let w = Math.max(0.05, e.w); if(e.k === 1) w *= 0.55; cand.push([ei, w]); sum += w; }
    if(!cand.length) return o.e;
    let r = Math.random() * sum; for(const [ei, w] of cand){ if((r -= w) <= 0){ best = ei; break; } } return best < 0 ? cand[0][0] : best;
  }
  // 横断してよいか（辺 e を node 側から渡り始める時）
  function mayCross(e, t){
    if(e.k !== 1) return true;
    if(e.g >= 0) return pedState(e.g, e.ph, t) === 0;
    const m = at(e, e.L / 2, _p); const h = Obs.hit(m.x, m.z, Math.max(9, e.L / 2 + 5), null, (o) => !!(o && o.ped));
    return !h;
  }
  let respT = 0, poolT = 0;
  const PEDREG = [];
  function register(){
    // 横断歩道を渡っている人と、自分の車の近く（45m）の人は障害物（車・電車が止まる。自分の車が当たると衝突）
    PEDREG.length = 0;
    const px = PLAYER_POS.on ? PLAYER_POS.x : 1e9, pz = PLAYER_POS.on ? PLAYER_POS.z : 1e9;
    for(const L of [peds, bikes]) for(const o of L){ if(!o.on || o.x === undefined) continue; const e = E[o.e];
      if(e.k === 1 || Math.abs(o.x - px) + Math.abs(o.z - pz) < 45){ Obs.add(o.x, o.z, o.bike ? 0.6 : 0.35, o); } }
  }
  function update(dt, t, center){
    if(!ready) return;
    const hi = S.mode === "heli" && Heli.H.active && Heli.H.agl > 160;
    U.uRain.value = Env.st.rain ? 1 : 0;
    poolT -= dt; if(!pool || poolT <= 0 || Math.hypot(center.x - poolAt.x, center.z - poolAt.z) > 40){ rebuildPool(center.x, center.z); poolT = 3; }
    const nb = Math.min(MAXB, Math.round(target * 0.12)), np = Math.min(MAXP, target - nb);
    respT -= dt;
    if(respT <= 0){ respT = 0.3;
      for(const [L, N, bike] of [[peds, np, false], [bikes, nb, true]]){
        for(const o of L){ if(o.on && Math.hypot(o.x - center.x, o.z - center.z) > R_OUT && !inView(o.x, o.z)) o.on = false; }
        let add = 0, on = 0; for(const o of L) if(o.on) on++;
        for(const o of L){ if(add > 40 || on >= N) break; if(!o.on && spawn(o, bike, S.t > 2)){ add++; on++; } }
        while(L.length < N && add++ < 60){ const o = { id: L.length }; if(!spawn(o, bike, false)) break; L.push(o); on++; }
        // 多すぎる時（時間帯・場所が変わった）は見えない人から消す
        for(const o of L){ if(on <= N) break; if(o.on && !inView(o.x, o.z)){ o.on = false; on--; } }
      }
    }
    for(const L of [peds, bikes]){
      for(const o of L){
        if(!o.on) continue;
        let e = E[o.e];
        // 立ち止まっている人
        if(o.stand > 0){ o.stand -= dt; o.v = 0; }
        else if(o.wait > 0){ o.wait -= dt; o.v = 0;
          const nxt = E[o.nextE]; if(nxt && o.wait <= 0 && !mayCross(nxt, t)) o.wait = 0.5; }
        else o.v += (o.v0 * (e.k === 1 && e.g >= 0 && pedState(e.g, e.ph, t) > 0 ? 1.35 : 1) - o.v) * Math.min(1, dt * 2);
        // 自分の車・バスの前では止まる
        if(PLAYER_POS.on && o.v > 0){ for(const q of PLAYER_POS.pts){ const dx = q[0] - o.x, dz = q[1] - o.z; if(dx * dx + dz * dz < (PLAYER_POS.r + 1.4) ** 2 && dx * o.fx + dz * o.fz > -0.3){ o.v = 0; break; } } }
        if(o.v > 0 && o.wait <= 0 && o.stand <= 0){
          o.s += o.dir * o.v * dt;
          if(o.s < 0 || o.s > e.L){
            const node = o.s < 0 ? e.a : e.b, over = o.s < 0 ? -o.s : o.s - e.L;
            const ni = chooseNext(o, node), ne = E[ni];
            if(ne.k === 1 && !mayCross(ne, t)){ o.s = o.s < 0 ? 0 : e.L; o.nextE = ni; o.wait = 0.5; o.v = 0; o.waitSpot = (o.id % 5) * 0.45; }
            else { o.e = ni; e = ne; o.dir = ne.a === node ? 1 : -1; o.s = o.dir > 0 ? Math.min(ne.L, over) : Math.max(0, ne.L - over); o.nextE = -1; o.waitSpot = 0; }
          }
        } else if(o.wait <= 0 && o.nextE >= 0 && o.stand <= 0 && o.v === 0){
          // 待っていた横断歩道が青になった
          const node = o.s <= 0 ? e.a : e.b, ne = E[o.nextE];
          if(ne && mayCross(ne, t)){ o.e = o.nextE; e = ne; o.dir = ne.a === node ? 1 : -1; o.s = o.dir > 0 ? 0 : ne.L; o.nextE = -1; o.waitSpot = 0; o.v = 0.3; }
        }
        // 位置
        at(e, o.s - o.dir * (o.waitSpot || 0), _p);
        const fx = _p.dx * o.dir, fz = _p.dz * o.dir, rx = -fz, rz = fx;       // 右 = (-fz, fx)（x 東・z 南）
        const lt = latOf(o, e); o.latC = o.latC == null ? lt : o.latC + (lt - o.latC) * Math.min(1, dt * 1.5);
        o.x = _p.x + rx * o.latC; o.z = _p.z + rz * o.latC; o.fx = fx; o.fz = fz;
        o.ph += dt * (o.bike ? o.v * 1.9 : o.v * 5.2);
      }
    }
    // 描画
    const vis = !hi;
    for(const [L, mesh] of [[peds, meshP], [bikes, meshB]]){
      const an = mesh.geometry.attributes.iAnim; let n = 0;
      if(vis) for(const o of L){
        if(!o.on) continue;
        const dx = o.x - camera.position.x, dz = o.z - camera.position.z; if(dx * dx + dz * dz > 260 * 260) continue;
        const y = Car.hAt(o.x, o.z);
        const yaw = o.stand > 0 ? o.face : Math.atan2(o.fx, o.fz);
        _q.setFromAxisAngle(_up, yaw); _v.set(o.x, y, o.z); _s.set(o.sc, o.sc, o.sc); _m.compose(_v, _q, _s); mesh.setMatrixAt(n, _m);
        an.setXY(n, o.ph, o.v > 0.05 ? Math.min(1, o.v / (o.bike ? 2.5 : 1.0)) : 0);
        if(o.slot !== n || o.dirty || o.mesh !== mesh){ setCols(mesh, n, o); o.slot = n; o.dirty = false; o.mesh = mesh; }
        n++;
      }
      // 空いた番号の色は次に入る人で上書きされるよう、使われた番号の持ち主を記録
      for(const o of L) if(o.on && o.slot >= n) o.slot = -1;
      mesh.count = n; mesh.instanceMatrix.needsUpdate = true; an.needsUpdate = true;
    }
    updateSignals(t);
  }
  /* ---- 歩行者用信号（信号のある横断歩道の両端。横断歩道の向こう側を向く、赤（上）と青（下）の 2 灯） ---- */
  function buildPedSignals(){
    const box = [], lamps = [];
    for(const e of E){
      if(e.k !== 1 || e.g < 0 || e.L < 5) continue;
      for(const end of [0, 1]){
        const p = at(e, end ? e.L : 0, {}), d = end ? -1 : 1;        // d: 横断の向き（この端から向こうへ）
        const fx = p.dx * d, fz = p.dz * d, rx = -fz, rz = fx;
        const side = e.lat + 0.9;
        const x = p.x - fx * 0.9 + rx * side, z = p.z - fz * 0.9 + rz * side;
        if(Car.blocked(x, z) || Car.kindAt(x, z) === 1) continue;
        // 灯器は向こう側（渡ってくる人の方）を向く。ここの柱には、向こう側から渡って来る人に見せる灯器
        sigData.push({ x, z, y: Car.hAt(x, z), yaw: Math.atan2(fx, fz), g: e.g, ph: e.ph });
      }
    }
    const N = sigData.length; if(!N) return;
    const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.9, 6); pole.translate(0, 1.45, 0);
    const head = new THREE.BoxGeometry(0.3, 0.62, 0.2); head.translate(0, 2.55, 0.08);
    const lampG = new THREE.PlaneGeometry(0.22, 0.22);
    const pm = new THREE.InstancedMesh(pole, new THREE.MeshLambertMaterial({ color: 0x6d7076 }), N);
    const hm = new THREE.InstancedMesh(head, new THREE.MeshLambertMaterial({ color: 0x2a2c30 }), N);
    sigMesh = new THREE.InstancedMesh(lampG, new THREE.MeshBasicMaterial({ color: 0xffffff }), N * 2);
    const tmp = new THREE.Object3D();
    sigData.forEach((s, i) => {
      tmp.position.set(s.x, s.y, s.z); tmp.rotation.set(0, s.yaw + Math.PI, 0); tmp.updateMatrix(); pm.setMatrixAt(i, tmp.matrix); hm.setMatrixAt(i, tmp.matrix);
      for(const k of [0, 1]){ const o = new THREE.Object3D(); o.position.set(0, 2.55 + (k ? -0.15 : 0.15), 0.185); o.updateMatrix(); const mm = tmp.matrix.clone().multiply(o.matrix); sigMesh.setMatrixAt(i * 2 + k, mm); sigMesh.setColorAt(i * 2 + k, lampOff); }
    });
    for(const m of [pm, hm, sigMesh]){ m.frustumCulled = false; scene.add(m); }
    pm.castShadow = true;
    console.log("ped signals", N);
  }
  const PR = new THREE.Color(0xff3b2b), PG = new THREE.Color(0x3fe0b0);
  let sigT = 0;
  function updateSignals(t){
    if(!sigMesh) return; sigT += 1; if(sigT % 8) return;
    const blink = Math.floor(t * 2.5) % 2 === 0;
    for(let i = 0; i < sigData.length; i++){ const s = sigData[i], st = pedState(s.g, s.ph, t);
      sigMesh.setColorAt(i * 2, st === 2 ? PR : lampOff); sigMesh.setColorAt(i * 2 + 1, st === 0 || (st === 1 && blink) ? PG : lampOff); }
    sigMesh.instanceColor.needsUpdate = true;
  }
  return { init, update, register, pedState, get peds(){ return peds; }, get bikes(){ return bikes; }, get ready(){ return ready; }, get E(){ return E; } };
})();
/* ---------------- JR の列車・線路・高架橋（v23） ----------------
   線形: data/jr.json（pipeline/jr.py。OSM の山陽新幹線・山陽本線・宇野線・津山線・吉備線の本線）。
   ・線路: 新幹線は高架橋（床版・防音壁・橋脚・スラブ軌道）、在来線はバラスト（砂利）と枕木。電化区間は架線柱
   ・列車: 山陽新幹線 N700系（16 両）・九州直通（8 両）、山陽本線・宇野線 227系「Urara」・115系・213系・瀬戸大橋線の快速、津山線・吉備線 キハ47（朱色）。
     岡山駅に止まり（新幹線 60 秒前後、在来線 30〜50 秒）、津山線・吉備線・宇野線の列車は岡山で折り返す。
     本数は昼間の平均的な値（新幹線 各方向 7.5 分おき、山陽本線 10 分おき、宇野線 15 分おき、吉備線・津山線 30 分おき）を仮定。夜は少なめ
   ・高架の高さ（新幹線 地面＋10.5m）と車両の形・色は簡略・仮定 */
const JR = (() => {
  let D = null, ready = false; const lines = [], trains = []; const root = new THREE.Group(); root.name = "jr";
  const MODELS = {
    n700:   { len: 25.0, lead: 27.35, w: 3.36, h: 3.6, nose: 10.7, body: 0xf3f3f1, band: 0x1f4f9f, band2: 0x1f4f9f, win: 0x2b3038, skirt: 0xb9bcc0, pan: [2, 6, 10, 13] },
    n700k:  { len: 25.0, lead: 27.35, w: 3.36, h: 3.6, nose: 10.7, body: 0xe6edf0, band: 0x1b2b4d, band2: 0xc9a54a, win: 0x2b3038, skirt: 0xb0b6bb, pan: [2, 5] },
    u227:   { len: 19.5, lead: 19.57, w: 2.95, h: 3.65, nose: 0.9, body: 0xc4c7cb, band: 0xe36f97, band2: 0xe36f97, win: 0x2a2e33, skirt: 0x8b8f94, pan: [1], ends: 0xe36f97 },
    y115:   { len: 20.0, lead: 20.0, w: 2.9, h: 3.65, nose: 0.6, body: 0xf0c418, band: 0xf0c418, band2: 0xf0c418, win: 0x25282c, skirt: 0x5a5c5e, pan: [1] },
    ml223:  { len: 19.5, lead: 19.5, w: 2.95, h: 3.65, nose: 1.0, body: 0xc9ccd0, band: 0x1d4f9c, band2: 0x7fb2e0, win: 0x282c31, skirt: 0x7b7f84, pan: [1, 3] },
    kiha47: { len: 21.3, lead: 21.3, w: 2.9, h: 3.7, nose: 0.5, body: 0xd8572b, band: 0xd8572b, band2: 0xd8572b, win: 0x26292d, skirt: 0x3c3a38, pan: [] },
  };
  // 線ごとの列車（本数は仮定）: 秒間隔・両数・車種・停車秒・最高速度
  const SERV = {
    shinkansen: { head: 450, vmax: 62, dec: 0.72, acc: 0.45, dwell: [55, 75], sets: [["n700", 16, 0.6], ["n700k", 8, 0.4]], both: false },
    sanyo:      { head: 600, vmax: 30, dec: 0.9, acc: 0.6, dwell: [30, 50], sets: [["u227", 3, 0.35], ["u227", 5, 0.2], ["y115", 4, 0.3], ["y115", 6, 0.15]], both: false },
    uno:        { head: 900, vmax: 28, dec: 0.9, acc: 0.6, dwell: [120, 300], sets: [["ml223", 5, 0.5], ["u227", 2, 0.25], ["u227", 4, 0.25]], both: true, term: true },
    tsuyama:    { head: 1800, vmax: 22, dec: 0.8, acc: 0.45, dwell: [240, 480], sets: [["kiha47", 2, 1]], both: true, term: true },
    kibi:       { head: 1800, vmax: 22, dec: 0.8, acc: 0.45, dwell: [240, 480], sets: [["kiha47", 2, 1]], both: true, term: true },
  };
  const inData = (x, z) => dataIn(x, z, 2);   // v29
  function pt(L, s, out){ const n = L.n; let f = Math.max(0, Math.min(n - 1.001, s / 2)); const i = Math.floor(f), t = f - i, p = L.p;
    out.x = p[3*i] + (p[3*i+3] - p[3*i]) * t; out.y = p[3*i+1] + (p[3*i+4] - p[3*i+1]) * t; out.z = p[3*i+2] + (p[3*i+5] - p[3*i+2]) * t; return out; }
  function init(J){
    if(!J || !J.lines) return; D = J;
    for(const l of J.lines){
      const p = new Float32Array(l.p), n = p.length / 3;
      const L = { key: l.key, ti: l.ti, p, n, len: (n - 1) * 2, stop: l.stop, el: l.el, inner: l.inner, mate: l.mate, hs: l.key === "shinkansen" };
      // 走る向き: 左側通行（相手の線が進む向きの右にある向き）。単線の線は両方向
      const ms = l.mate.reduce((a, b) => a + b, 0); L.dir = Math.abs(ms) > n * 0.2 ? Math.sign(ms) : 0;
      lines.push(L);
    }
    buildStatic(); scene.add(root);
    for(const L of lines){ L.timer = [Math.random() * SERV[L.key].head, Math.random() * SERV[L.key].head]; }
    ready = true; console.log("jr lines", lines.length);
  }
  /* ---- 線路・高架橋（データの範囲の中だけ） ---- */
  const _a = {x:0,y:0,z:0}, _b = {x:0,y:0,z:0};
  function buildStatic(){
    const G = { deck: [], wall: [], slab: [], ballast: [], rail: [] }; const poles = [];
    const push = (A, ...v) => { for(const q of v) A.push(q[0], q[1], q[2]); };
    const quad = (A, a, b, c, d) => { push(A, a, b, c); push(A, a, c, d); };
    for(const L of lines){
      const gauge = L.hs ? 1.435 : 1.067;
      for(let i = 0; i < L.n - 1; i++){
        pt(L, i * 2, _a); pt(L, i * 2 + 2, _b);
        if(!inData(_a.x, _a.z) || !inData(_b.x, _b.z)) continue;
        const dx = _b.x - _a.x, dz = _b.z - _a.z, ln = Math.hypot(dx, dz) || 1, rx = -dz / ln, rz = dx / ln;   // 右
        const P = (q, off, y) => [q.x + rx * off, y, q.z + rz * off];
        const el = L.el[i] && L.el[i + 1];
        const ya = _a.y, yb = _b.y;
        if(el){
          const ms = L.mate[i] || 0, inA = L.inner[i], inB = L.inner[i + 1];
          const outO = L.hs ? 3.5 : 2.4;
          // 右端・左端（相手の線がいる側は内側の幅まで）
          const rA = ms > 0 ? inA : outO, lA = ms < 0 ? -inA : -outO, rB = ms > 0 ? inB : outO, lB = ms < 0 ? -inB : -outO;
          const tA = ya - 0.35, tB = yb - 0.35, bA = tA - 1.6, bB = tB - 1.6;
          quad(G.deck, P(_a, lA, tA), P(_a, rA, tA), P(_b, rB, tB), P(_b, lB, tB));                   // 上面
          quad(G.deck, P(_a, rA, bA), P(_a, lA, bA), P(_b, lB, bB), P(_b, rB, bB));                   // 下面
          if(ms <= 0) quad(G.deck, P(_a, rA, bA), P(_b, rB, bB), P(_b, rB, tB), P(_a, rA, tA));       // 外側の側面
          if(ms >= 0) quad(G.deck, P(_a, lA, tA), P(_b, lB, tB), P(_b, lB, bB), P(_a, lA, bA));
          // 防音壁・高欄（外側）
          const wh = L.hs ? 2.0 : 1.1;
          for(const [oA, oB, s] of [[rA, rB, 1], [lA, lB, -1]]){
            if((s > 0 && ms > 0) || (s < 0 && ms < 0)) continue;
            const iA = oA - s * 0.3, iB = oB - s * 0.3;
            quad(G.wall, P(_a, oA, tA), P(_b, oB, tB), P(_b, oB, tB + wh), P(_a, oA, tA + wh));
            quad(G.wall, P(_a, iA, tA + wh), P(_b, iB, tB + wh), P(_b, iB, tA + 0.01 + (tB - tA)), P(_a, iA, tA + 0.01));
            quad(G.wall, P(_a, oA, tA + wh), P(_b, oB, tB + wh), P(_b, iB, tB + wh), P(_a, iA, tA + wh));
          }
        }
        // 軌道: 新幹線はスラブ、在来線はバラスト
        const bw = L.hs ? 1.4 : 1.55, by = el ? -0.3 : -0.28;
        const T = L.hs || el ? G.slab : G.ballast;
        quad(T, P(_a, -bw, ya + by), P(_a, bw, ya + by), P(_b, bw, yb + by), P(_b, -bw, yb + by));
        if(!el && !L.hs){ quad(T, P(_a, -bw - 0.6, ya - 0.5), P(_a, -bw, ya + by), P(_b, -bw, yb + by), P(_b, -bw - 0.6, yb - 0.5));
                          quad(T, P(_a, bw, ya + by), P(_a, bw + 0.6, ya - 0.5), P(_b, bw + 0.6, yb - 0.5), P(_b, bw, yb + by)); }
        for(const s of [-1, 1]){ const o = s * gauge / 2, w = 0.035;
          quad(G.rail, P(_a, o - w, ya), P(_a, o + w, ya), P(_b, o + w, yb), P(_b, o - w, yb));
          quad(G.rail, P(_a, o - w, ya - 0.15), P(_a, o - w, ya), P(_b, o - w, yb), P(_b, o - w, yb - 0.15));
          quad(G.rail, P(_a, o + w, ya), P(_a, o + w, ya - 0.15), P(_b, o + w, yb - 0.15), P(_b, o + w, yb)); }
        // 架線柱（電化: 津山線・吉備線は非電化）: 50m おき、線の外側
        if(L.key !== "tsuyama" && L.key !== "kibi" && i % 25 === 0){
          const ms = L.mate[i] || 0, side = ms > 0 ? -1 : 1, off = el ? (L.hs ? 3.2 : 2.1) * side : 2.6 * side;
          poles.push({ x: _a.x + rx * off, z: _a.z + rz * off, y0: el ? ya - 0.35 : ya - 0.4, y1: ya + (L.hs ? 7.2 : 6.2), arm: -side * (Math.abs(off) + 0.4), rx, rz });
        }
      }
    }
    const mk = (arr, mat) => { if(!arr.length) return; const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; root.add(m); return m; };
    mk(G.deck, new THREE.MeshLambertMaterial({ color: 0xaaa9a3, side: THREE.DoubleSide }));
    mk(G.wall, new THREE.MeshLambertMaterial({ color: 0xc9c8c1, side: THREE.DoubleSide }));
    mk(G.slab, new THREE.MeshLambertMaterial({ color: 0x8d8b86 }));
    // バラスト＋枕木（手続き的テクスチャ。線路方向に 0.6m おきの枕木）
    const bt = canvasTex(64, 128, (g, w, h) => { noise(g, w, h, "#6d665d", 0.25, 2500); for(let y = 0; y < h; y += 32){ g.fillStyle = "#57534e"; g.fillRect(4, y + 4, w - 8, 12); g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(4, y + 15, w - 8, 2); } });
    if(G.ballast.length){ const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(G.ballast, 3)); g.computeVertexNormals();
      // UV: 横 = 0..1、縦 = 世界座標の長さ / 2.4m（4 本の枕木）
      const uv = []; for(let k = 0; k < G.ballast.length / 3; k += 6){ const q = G.ballast; const a = k * 3, c = (k + 2) * 3; const L_ = Math.hypot(q[c] - q[a], q[c + 2] - q[a + 2]) / 2.4;
        uv.push(0, 0, 1, 0, 1, L_, 0, 0, 1, L_, 0, L_); }
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: bt })); m.receiveShadow = true; root.add(m); }
    mk(G.rail, new THREE.MeshLambertMaterial({ color: 0x8b8781 }));
    // 橋脚
    if(D.piers && D.piers.length){
      const N = D.piers.length, g = new THREE.BoxGeometry(1.3, 1, 1.5); g.translate(0, 0.5, 0);
      const cap = new THREE.BoxGeometry(4.2, 1.0, 1.7); cap.translate(0, -0.5, 0);
      const m = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xa4a39d }), N), mc = new THREE.InstancedMesh(cap, new THREE.MeshLambertMaterial({ color: 0xa4a39d }), N);
      const o = new THREE.Object3D();
      D.piers.forEach((q, i) => { const [x, z, g0, top, yaw] = q; const h = Math.max(0.5, top - g0 + 0.2);
        o.position.set(x, g0 - 0.2, z); o.rotation.set(0, yaw, 0); o.scale.set(1, h, 1); o.updateMatrix(); m.setMatrixAt(i, o.matrix);
        o.position.set(x, top + 0.05, z); o.scale.set(1, 1, 1); o.updateMatrix(); mc.setMatrixAt(i, o.matrix); });
      for(const q of [m, mc]){ q.castShadow = true; q.receiveShadow = true; q.frustumCulled = false; root.add(q); }
      // 衝突判定（1m の建物マスク）に橋脚を加える
      if(Car.addBlock) for(const q of D.piers) Car.addBlock(q[0], q[1], 1.0);
    }
    // 架線柱
    if(poles.length){
      const N = poles.length, pg = new THREE.BoxGeometry(0.3, 1, 0.3); pg.translate(0, 0.5, 0);
      const ag = new THREE.BoxGeometry(0.12, 0.12, 1); ag.translate(0, 0, 0.5);
      const pm = new THREE.InstancedMesh(pg, new THREE.MeshLambertMaterial({ color: 0x8c8f93 }), N), am = new THREE.InstancedMesh(ag, new THREE.MeshLambertMaterial({ color: 0x6f7276 }), N);
      const o = new THREE.Object3D();
      poles.forEach((q, i) => { o.position.set(q.x, q.y0, q.z); o.rotation.set(0, 0, 0); o.scale.set(1, q.y1 - q.y0, 1); o.updateMatrix(); pm.setMatrixAt(i, o.matrix);
        o.position.set(q.x, q.y1 - 0.4, q.z); o.rotation.set(0, Math.atan2(q.rx * Math.sign(q.arm), q.rz * Math.sign(q.arm)), 0); o.scale.set(1, 1, Math.abs(q.arm)); o.updateMatrix(); am.setMatrixAt(i, o.matrix); });
      for(const q of [pm, am]){ q.castShadow = true; q.frustumCulled = false; root.add(q); }
    }
  }
  /* ---- 車両の形（+z 前、原点は車体中央のレール面） ---- */
  const geoCache = {};
  function carGeo(mk, lead, pan){
    const k = mk + (lead ? "L" : "M") + (pan ? "P" : ""); if(geoCache[k]) return geoCache[k];
    const M = MODELS[mk], len = lead ? M.lead : M.len, w = M.w, fl = 1.05, top = fl + M.h - 0.35, pos = [], col = [];
    const C = new THREE.Color();
    const box = (bw, y0, y1, z0, z1, c, seg) => { const g = new THREE.BoxGeometry(bw, y1 - y0, z1 - z0, 1, 1, seg || 1); g.translate(0, (y0 + y1) / 2, (z0 + z1) / 2);
      const nx = g.toNonIndexed(); const a = nx.attributes.position.array; C.set(c);
      for(let i = 0; i < a.length; i += 3){ pos.push(a[i], a[i + 1], a[i + 2]); col.push(C.r, C.g, C.b); } g.dispose(); nx.dispose(); };
    const zf = len / 2, zb = -len / 2, ns = lead ? M.nose : 0, segs = lead && M.nose > 3 ? 24 : 2;
    // 下から: 床下・スカート、帯、車体、窓の帯、車体（上）、屋根
    box(w - 0.2, 0.25, fl, zb + 0.2, zf - (lead ? Math.min(ns, 3) : 0.2), M.skirt, segs);
    box(w, fl, fl + 0.55, zb, zf, M.band === M.body ? M.body : M.body, segs);
    box(w + 0.01, fl + 0.55, fl + 0.72, zb, zf, M.band, segs);
    box(w, fl + 0.72, fl + 1.2, zb, zf, M.body, segs);
    box(w + 0.02, fl + 1.2, fl + 2.1, zb + 1.2, zf - (lead ? Math.max(ns, 1.8) : 1.2), M.win, segs);
    box(w, fl + 1.2, fl + 2.1, zb, zf, M.body, segs);
    box(w - 0.05, fl + 2.1, top, zb, zf, M.body, segs);
    if(M.band2 !== M.band) box(w + 0.015, fl + 0.46, fl + 0.52, zb, zf, M.band2, segs);
    if(M.ends){ box(w + 0.03, fl + 0.2, top - 0.2, zf - 2.2, zf - 0.3, M.ends); box(w + 0.03, fl + 0.2, top - 0.2, zb + 0.3, zb + 2.2, M.ends); }
    box(w - 0.6, top, top + 0.25, zb + 2, zf - 2, 0x9a9da2);                                // 屋根上の機器
    // 台車
    for(const zc of [zb + 2.6, zf - 2.6]) box(w - 0.5, 0.15, 0.95, zc - 1.3, zc + 1.3, 0x2a2b2d);
    if(pan){ box(0.12, top + 0.25, top + 1.1, -1.5, -1.3, 0x3d3f42); box(1.6, top + 1.05, top + 1.12, -1.8, -1.0, 0x3d3f42); }
    // 先頭の形: 前の ns m を細く・低く（新幹線は長い流線形、在来線は前面の傾斜のみ）
    if(lead){
      for(let i = 0; i < pos.length; i += 3){
        const z = pos[i + 2]; if(z < zf - ns) continue;
        const t = Math.min(1, (z - (zf - ns)) / Math.max(0.01, ns));
        if(ns > 3){ const wsc = Math.sqrt(Math.max(0.05, 1 - Math.pow(t, 2.2) * 0.92)); pos[i] *= wsc;
          const yT = top - (top - (fl + 0.35)) * Math.pow(t, 1.35); if(pos[i + 1] > fl + 0.35) pos[i + 1] = fl + 0.35 + (pos[i + 1] - (fl + 0.35)) * (yT - (fl + 0.35)) / (top - (fl + 0.35));
          if(pos[i + 1] < fl) pos[i + 1] = Math.max(pos[i + 1], 0.25 + 0.5 * t); }
        else { const yy = pos[i + 1]; if(yy > fl + 1.3) pos[i + 2] -= (yy - (fl + 1.3)) * 0.18 * t; }
      }
      // 運転台の窓（流線形の上面の一部を暗く）・前照灯
      if(ns > 3){ const Cw = new THREE.Color(0x1a1d22);
        for(let i = 0; i < pos.length; i += 3){ const z = pos[i + 2]; const t = (z - (zf - ns)) / ns; if(t < 0.3 || t > 0.56) continue;
          if(pos[i + 1] > fl + 1.25 && Math.abs(pos[i]) < w * 0.26){ col[i] = Cw.r; col[i + 1] = Cw.g; col[i + 2] = Cw.b; } } }
      else { box(w - 0.3, fl + 1.3, fl + 2.15, zf - 0.02, zf + 0.03, M.win); box(0.35, fl + 0.6, fl + 0.8, zf, zf + 0.05, 0xfff4d0); pos.push(); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    return geoCache[k] = g;
  }
  const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  function makeTrain(L, dir, mk, ncar, sv){
    const M = MODELS[mk], cars = [], g = new THREE.Group();
    let total = 0;
    for(let i = 0; i < ncar; i++){
      const lead = i === 0 || i === ncar - 1, len = lead ? M.lead : M.len;
      const pan = M.pan.includes(i);
      const m = new THREE.Mesh(carGeo(mk, lead, pan), carMat); m.castShadow = true;
      m.userData.flip = i === ncar - 1 && ncar > 1; cars.push({ m, len, off: total + len / 2 }); total += len + 0.6; g.add(m);
    }
    g.visible = false; root.add(g);
    return { L, dir, mk, cars, g, len: total, sv, v: 0, s: 0, state: "run", dwell: 0, stopped: false, turned: false };
  }
  function spawn(L, dir){
    const sv = SERV[L.key]; let r = Math.random(), set = sv.sets[0]; for(const q of sv.sets){ if((r -= q[2]) <= 0){ set = q; break; } }
    const T = makeTrain(L, dir, set[0], set[1], sv);
    T.s = dir > 0 ? 0 : L.len;
    // 停車位置（編成の中央を駅の中心に。折り返し線の端を越えない）
    T.stopS = dir > 0 ? Math.min(L.len - 5, Math.max(T.len + 5, L.stop + T.len / 2)) : Math.max(5, Math.min(L.len - T.len - 5, L.stop - T.len / 2));
    T.v = Math.min(sv.vmax, Math.sqrt(2 * sv.dec * Math.abs(T.stopS - T.s)));
    trains.push(T); return T;
  }
  const _p = {x:0,y:0,z:0}, _q = {x:0,y:0,z:0}, _v = new THREE.Vector3();
  function update(dt, t){
    if(!ready) return;
    const night = Env.st.time === "night" ? 1.7 : 1;
    for(const L of lines){
      const sv = SERV[L.key];
      if(L.dir !== 0){
        L.timer[0] -= dt; if(L.timer[0] <= 0){ L.timer[0] = sv.head * night * (0.85 + Math.random() * 0.3); spawn(L, L.dir); }
      } else {
        // 単線・折り返しの線: 線の上に列車がいない時だけ（岡山から離れた端から出す）
        L.timer[0] -= dt; if(L.timer[0] <= 0){ if(!trains.some(q => q.L === L)){ L.timer[0] = sv.head * night * (0.85 + Math.random() * 0.3);
          const toStation = L.stop < L.len / 2 ? -1 : 1; spawn(L, toStation); } else L.timer[0] = 30; }
      }
    }
    for(let i = trains.length - 1; i >= 0; i--){
      const T = trains[i], sv = T.sv, L = T.L;
      if(T.state === "run"){
        const rem = T.stopped ? 1e9 : (T.stopS - T.s) * T.dir;
        const vt = rem > 0 ? Math.min(sv.vmax, Math.sqrt(2 * sv.dec * Math.max(0, rem - 0.5))) : 0;
        if(T.v > vt) T.v = Math.max(vt, T.v - sv.dec * 1.4 * dt); else T.v = Math.min(vt, T.v + sv.acc * dt);
        T.s += T.dir * T.v * dt;
        if(!T.stopped && rem <= 0.6 && T.v < 0.3){ T.v = 0; T.state = "dwell"; T.dwell = sv.dwell[0] + Math.random() * (sv.dwell[1] - sv.dwell[0]); }
        if(T.s < -5 || T.s > L.len + 5){ root.remove(T.g); trains.splice(i, 1); continue; }
      } else {
        T.dwell -= dt;
        if(T.dwell <= 0){ T.state = "run"; T.stopped = true;
          if(sv.term && !T.turned){ // 折り返し: 向きを変え、今の最後尾が先頭になる
            T.turned = true; T.s = T.s - T.dir * T.len; T.dir = -T.dir; } }
      }
      place(T);
    }
    sound();
  }
  function place(T){
    const L = T.L; pt(L, T.s, _p);
    const d = camera.position.distanceTo(_v.set(_p.x, _p.y, _p.z));
    T.g.visible = d < 2600 + T.len; if(!T.g.visible) return;
    for(const c of T.cars){
      const sc = T.s - T.dir * c.off, hb = c.len * 0.34;
      pt(L, sc + T.dir * hb, _p); pt(L, sc - T.dir * hb, _q);
      const dx = _p.x - _q.x, dz = _p.z - _q.z, dy = _p.y - _q.y, hl = Math.hypot(dx, dz) || 1;
      c.m.position.set((_p.x + _q.x) / 2, (_p.y + _q.y) / 2, (_p.z + _q.z) / 2);
      c.m.rotation.set(0, 0, 0); c.m.rotation.order = "YXZ";
      c.m.rotation.y = Math.atan2(dx, dz) + (c.m.userData.flip ? Math.PI : 0); c.m.rotation.x = -Math.atan2(dy, hl) * (c.m.userData.flip ? -1 : 1);
    }
  }
  // 近くを通る列車の音（電車の走行音を低めに）
  function sound(){
    let best = 0, bv = 0;
    for(const T of trains){ if(!T.g.visible || T.v < 1) continue; for(const c of [T.cars[0], T.cars[Math.floor(T.cars.length / 2)], T.cars[T.cars.length - 1]]){ const dd = camera.position.distanceTo(c.m.position); const k = Math.min(1, 60 / Math.max(20, dd)) * Math.min(1, T.v / 20); if(k > best){ best = k; bv = T.v; } } }
    if(Snd.jrSound) Snd.jrSound(best, bv);
  }
  return { init, update, _spawn: spawn, get trains(){ return trains; }, get lines(){ return lines; }, get ready(){ return ready; } };
})();
const _cen=new THREE.Vector3();
function simTraffic(dt){
  Obs.clear(); Trams.registerAll(); Traffic.register(); Peds.register();
  PLAYER_POS.on=false;
  if((S.mode==="car"||S.mode==="bus") && Car.C.active){ const C=Car.C, fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), bl=Car.P.len; Obs.addBody(C.x+fx*bl/2, C.z+fz*bl/2, fx, fz, bl, Car.P.wid/2+0.1, PCAR); _cen.set(C.x,0,C.z);
    PLAYER_POS.on=true; PLAYER_POS.x=C.x; PLAYER_POS.z=C.z; PLAYER_POS.r=Car.P.wid/2; PLAYER_POS.pts.length=0;
    for(let u=-bl/2; u<=bl/2+0.01; u+=Math.max(1.5, bl/6)) PLAYER_POS.pts.push([C.x+fx*u, C.z+fz*u]); }
  else if(S.track){ const len=VEH().len; for(let s=S.pos-1.3; s>S.pos-len; s-=2.6){ const p=pointAt(s); Obs.add(p.x,p.z,1.25,Trams.PLAYER); } _cen.copy(pointAt(S.pos)); }
  if(S.mode==="heli" && Heli.H.active){ const f=Heli.focus({x:0,z:0}); _cen.set(f.x, 0, f.z); }
  else if(S.mode!=="car" && S.mode!=="bus" && !S.running) _cen.copy(camera.position);
  const t = S.t;
  Trams.update(dt, t); Traffic.update(dt, t, _cen); Peds.update(dt, t, _cen); JR.update(dt, t);
}
/* ---------------- サイドミラー・ルームミラー（v15: 車・バスの運転席視点） ----------------
   ミラーの位置にカメラを置いて後ろ（少し外向き）を写し、左右反転して画面の左右（とルームミラーは上中央）に重ねる。
   軽くするため解像度は小さめ・描く距離は 350m まで・影は作り直さない・1 フレームおきに更新。 */
const Mirrors = (() => {
  const RT_W = 384, RT_H = 240;
  const mk = () => { const rt = new THREE.WebGLRenderTarget(RT_W, RT_H, { depthBuffer: true }); rt.texture.generateMipmaps = false; return rt; };
  const M = { L: { rt: mk(), cam: new THREE.PerspectiveCamera(30, RT_W / RT_H, 0.3, 260) },
              R: { rt: mk(), cam: new THREE.PerspectiveCamera(30, RT_W / RT_H, 0.3, 260) },
              C: { rt: mk(), cam: new THREE.PerspectiveCamera(24, RT_W / RT_H * 1.6, 0.3, 260) } };
  const ov = new THREE.Scene(); const ocam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  function quad(rt, flip) {
    const g = new THREE.PlaneGeometry(1, 1); const uv = g.attributes.uv;
    if (flip) for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));      // 鏡なので左右反転
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x111214 }));
    const img = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: rt.texture }));
    frame.renderOrder = 0; img.renderOrder = 1; ov.add(frame, img); return { frame, img };
  }
  M.L.q = quad(M.L.rt, true); M.R.q = quad(M.R.rt, true); M.C.q = quad(M.C.rt, true);
  let frameN = 0;
  const place = (q, x, y, w, h) => { q.img.position.set(x, y, 0); q.img.scale.set(w, h, 1); q.frame.position.set(x, y, -0.5); q.frame.scale.set(w + 8, h + 8, 1); };
  function aim(m, C, P, side, fwd, up, outDeg, pitch) {
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw), sx = Math.cos(C.yaw), sz = -Math.sin(C.yaw);   // s = 車の左
    const px = C.x + sx * side + fx * fwd, pz = C.z + sz * side + fz * fwd, py = C.h + up;
    m.cam.position.set(px, py, pz);
    const o = Math.tan(outDeg * Math.PI / 180) * Math.sign(side || 1);
    m.cam.lookAt(px - fx * 20 + sx * o * 20, py - 20 * Math.tan(pitch * Math.PI / 180), pz - fz * 20 + sz * o * 20);
  }
  // v15: 電車の運転台視点。前面の左右の角（車体の外 0.3m・レール面から 2.3m・前面から 0.4m 後ろ）から後ろを写す
  function renderTram(renderer, scene) {
    if (!(S.mode === "tram" && S.running && S.view === "cab" && S.track)) return;
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
    frameN++;
    if (frameN % 2 === 0) {
      const V = VEH(), sF = S.pos - 0.4, p = pointAt(sF), t = tangentAt(sF - 3);
      const sx = t.z, sz = -t.x;                        // 進行方向の左
      const half = (V.len > 15 ? 1.2 : 1.15) + 0.3, up = 2.3;
      for (const [k, sg] of [["L", 1], ["R", -1]]) {
        const m = M[k], px = p.x + sx * half * sg, pz = p.z + sz * half * sg, py = p.y + up;
        m.cam.position.set(px, py, pz);
        const o = Math.tan(10 * Math.PI / 180) * sg;
        m.cam.lookAt(px - t.x * 20 + sx * o * 20, py - 20 * Math.tan(4 * Math.PI / 180), pz - t.z * 20 + sz * o * 20);
      }
      const vis = S.car ? S.car.visible : false; if (S.car) S.car.visible = true;     // ミラーには自分の車体の横が写る
      const sm = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      for (const k of ["L", "R"]) { renderer.setRenderTarget(M[k].rt); renderer.clear(); renderer.render(scene, M[k].cam); }
      renderer.setRenderTarget(null); renderer.shadowMap.autoUpdate = sm; if (S.car) S.car.visible = vis;
    }
    ocam.left = 0; ocam.right = W; ocam.top = H; ocam.bottom = 0; ocam.updateProjectionMatrix();
    const mw = Math.min(W * 0.18, 250), mh = mw * RT_H / RT_W, y = H * 0.5;
    place(M.L.q, 18 + mw / 2, y, mw, mh); place(M.R.q, W - 18 - mw / 2, y, mw, mh);
    M.C.q.img.visible = M.C.q.frame.visible = false;
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(ov, ocam); renderer.autoClear = true;
  }
  function render(renderer, scene) {
    const C = Car.C; if (!C.active || C.view !== "driver") return;
    const bus = Car.P === undefined ? false : Car.P.len > 8;
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
    frameN++;
    const use = bus ? ["L", "R"] : ["L", "R", "C"];
    if (frameN % 2 === 0) {
      // ミラーには自分の車体（バスの外板）も写す
      if (C.onDriverView) C.onDriverView(false);
      const sm = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      if (bus) { aim(M.L, C, Car.P, 1.45, 5.7, 2.1, 14, 3); aim(M.R, C, Car.P, -1.45, 5.7, 2.1, 14, 3); }
      else { aim(M.L, C, Car.P, 0.98, 0.55, 1.02, 16, 2); aim(M.R, C, Car.P, -0.98, 0.55, 1.02, 16, 2); aim(M.C, C, Car.P, -0.1, -0.2, 1.28, 0, 1); }
      for (const k of use) { renderer.setRenderTarget(M[k].rt); renderer.clear(); renderer.render(scene, M[k].cam); }
      renderer.setRenderTarget(null); renderer.shadowMap.autoUpdate = sm;
      if (C.onDriverView) C.onDriverView(true);
    }
    // 画面への配置（ピクセル）: 左右のミラーは画面の端・高さ中ほど、ルームミラーは上中央
    ocam.left = 0; ocam.right = W; ocam.top = H; ocam.bottom = 0; ocam.updateProjectionMatrix();
    const mw = Math.min(W * 0.2, 280), mh = mw * RT_H / RT_W, y = H * 0.42;
    place(M.L.q, 18 + mw / 2, y, mw, mh); place(M.R.q, W - 18 - mw / 2, y, mw, mh);
    const cw = Math.min(W * 0.26, 360), ch = cw * 0.28;
    place(M.C.q, W / 2, H - 92 - ch / 2, cw, ch);
    M.C.q.img.visible = M.C.q.frame.visible = !bus;
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(ov, ocam); renderer.autoClear = true;
  }
  return { render, renderTram };
})();
/* ---------------- v25: 設定・記録の保存（このブラウザの中だけ）とゲームパッド ----------------
   保存: モード・路線・車両・建物の表示・影・時間帯・天気・ヘリの出発地・音、電車（路線ごと）とバスの最高点・評価・回数。
   ブラウザの保存領域が使えない時（プライベートウィンドウなど）は保存しないだけで、動きは変わらない */
const Prefs = (() => {
  const KEY = "okaden.v1"; let st = { set: {}, rec: {} }, restoring = false;
  try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); if(j && typeof j === "object") st = { set: j.set || {}, rec: j.rec || {} }; } catch(e){}
  function write(){ try { localStorage.setItem(KEY, JSON.stringify(st)); } catch(e){} }
  function save(){
    if(restoring) return;
    const q = (s) => document.querySelector(s);
    const m = q(".mode-opt.on"), l = q(".look-opt.on"), h = q(".hstart-opt.on"), sh = q(".shadow-opt");
    st.set = { mode: m && m.dataset.mode, route: S.key, veh: S.vehicle, look: l && l.dataset.look, shadow: sh ? sh.classList.contains("on") : true,
               time: Env.st.time, rain: Env.st.rain, hstart: h && h.dataset.start, sound: st.set.sound !== false };
    write();
  }
  function setSound(on){ st.set.sound = on; write(); }
  function restore(){
    const s = st.set; if(!s || !s.mode) { render(); return; }
    restoring = true;
    try {
      const click = (sel) => { const e = document.querySelector(sel); if(e && !e.classList.contains("on")) e.click(); };
      if(s.route) click('.route-opt[data-key="' + s.route + '"]');
      if(s.veh) click('.veh-opt[data-veh="' + s.veh + '"]');
      if(s.look) click('.look-opt[data-look="' + s.look + '"]');
      const sh = document.querySelector(".shadow-opt"); if(sh && s.shadow === false && sh.classList.contains("on")) sh.click();
      if(s.time || s.rain != null) Env.set(s.time || null, !!s.rain);
      if(s.hstart) click('.hstart-opt[data-start="' + s.hstart + '"]');
      click('.mode-opt[data-mode="' + s.mode + '"]');
    } catch(e){ console.warn("prefs", e); }
    restoring = false; render();
  }
  const RANK = (k, s) => k === "bus" ? (s >= 950 ? "S" : s >= 850 ? "A" : s >= 700 ? "B" : "C") : (s > 900 ? "S" : s > 750 ? "A" : s > 550 ? "B" : "C");
  function record(key, score){
    const r = st.rec[key] || { best: 0, n: 0 }; r.n++; const newBest = score > r.best; if(newBest){ r.best = Math.round(score); r.at = new Date().toISOString().slice(0, 10); }
    st.rec[key] = r; write(); render(); return { newBest, best: r.best, n: r.n };
  }
  function render(){
    const el = document.getElementById("records"); if(!el) return;
    const parts = [];
    for(const [k, r] of Object.entries(st.rec)){
      const name = k === "bus" ? "バス 西大寺線" : (S.routes && S.routes[k.slice(5)] ? S.routes[k.slice(5)].name + (k.endsWith("_r") ? "（逆方向）" : "") : k);
      parts.push(name + " 最高 " + r.best + " 点（" + RANK(k, r.best) + "）・" + r.n + " 回");
    }
    el.textContent = parts.length ? "これまでの記録（このブラウザ）: " + parts.join(" ／ ") : "";
  }
  document.addEventListener("click", (e) => { if(e.target.closest(".mode-opt,.route-opt,.veh-opt,.look-opt,.shadow-opt,.time-opt,.rain-opt,.hstart-opt")) setTimeout(save, 0); });
  document.addEventListener("keydown", (e) => { if(e.key === "n" || e.key === "N" || e.key === "m" || e.key === "M") setTimeout(save, 0); });
  return { save, restore, record, render, setSound, get soundOn(){ return st.set.sound !== false; } };
})();
/* ゲームパッド（標準配置: Xbox / PlayStation 系）
   電車: RB・LB（または十字キー上下）= マスコン進め・戻し、RT・LT = ブレーキ強め・弱め、A = ドア、B = 非常ブレーキ、X = 警笛、Y = 視点
   車・バス: 左スティック = ハンドル、RT = アクセル、LT = ブレーキ、A = 扉（バス）、X = 警笛、Y = 視点、B = サイドブレーキ、Back = ギア D/R、Start = 道路に戻る
   ヘリ: 左スティック = 前後・旋回、右スティック = 横移動・上昇下降、RT・LT = 上昇・下降、RB = 速く、Y = 視点、X = 自動周回 */
const Pad = (() => {
  const prev = []; let on = false, msgT = 0;
  const PIN = { thr: 0, brk: 0, steer: 0, active: false };
  addEventListener("gamepadconnected", (e) => { on = true; msgT = 4; console.log("gamepad", e.gamepad.id); });
  const key = (k, down) => document.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { key: k, bubbles: true }));
  const tap = (k) => { key(k, true); setTimeout(() => key(k, false), 60); };
  function poll(dt){
    const gps = navigator.getGamepads ? navigator.getGamepads() : []; let g = null;
    for(const q of gps) if(q && q.connected){ g = q; break; }
    PIN.active = false; const hp = Heli.pad;
    if(!g){ return; }
    const b = (i) => g.buttons[i] ? g.buttons[i].value : 0, pressed = (i) => b(i) > 0.5, edge = (i) => pressed(i) && !prev[i];
    const ax = (i) => { const v = g.axes[i] || 0; return Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88; };
    const mode = S.mode;
    if(mode === "tram" && S.running){
      if(edge(5) || edge(12)) tap("w"); if(edge(4) || edge(13)) tap("s");
      if(edge(7)) tap("ArrowDown"); if(edge(6)) tap("ArrowUp");
      if(edge(0)) tap("d"); if(edge(1)) tap(" "); if(edge(2)) tap("h"); if(edge(3)) tap("v");
    } else if((mode === "car" || mode === "bus") && Car.C.active){
      PIN.active = true; PIN.thr = b(7); PIN.brk = b(6); PIN.steer = ax(0);
      if(edge(0) && mode === "bus") tap("f"); if(edge(2)) tap("h"); if(edge(3)) tap("v"); if(edge(1)) tap(" ");
      if(edge(8)) tap("r"); if(edge(9)) tap("t");
    } else if(mode === "heli" && Heli.H.active){
      const ly = ax(1), lx = ax(0), rx = ax(2), ry = ax(3);
      const any = ly || lx || rx || ry || b(7) > 0.05 || b(6) > 0.05 || pressed(5);
      if(any){ hp.f = Math.max(0, -ly); hp.b = Math.max(0, ly); hp.l = Math.max(0, -lx); hp.r = Math.max(0, lx);
        hp.u = Math.max(Math.max(0, -ry), b(7)); hp.d = Math.max(Math.max(0, ry), b(6)); hp.s = -rx; hp.fast = pressed(5) ? 1 : 0; hp._pad = true; }
      else if(hp._pad){ for(const k of ["f", "b", "l", "r", "u", "d", "s", "fast"]) hp[k] = 0; hp._pad = false; }
      if(edge(3)) tap("v"); if(edge(2)) tap("o");
    }
    if(mode !== "heli" && hp && hp._pad){ for(const k of ["f", "b", "l", "r", "u", "d", "s", "fast"]) hp[k] = 0; hp._pad = false; }
    for(let i = 0; i < g.buttons.length; i++) prev[i] = pressed(i);
    if(msgT > 0){ msgT -= dt; }
  }
  return { poll, PIN, get connected(){ return on; } };
})();
function loop(now){
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  Pad.poll(dt);
  if(Trams.ready) simTraffic(dt);
  Stream.tick(); HiStream.tick(); Env.tick(dt);
  updateSun(); if(S._waterTex){ S._waterTex.offset.x=(S.t*0.012)%1; S._waterTex.offset.y=(S.t*0.007)%1; }
  if(S.mode==="car"||S.mode==="bus"){ S.t+=dt; Car.tick(dt); Stuck.tick(dt); if(S.car) S.car.visible=false; Car.updateCam(dt); Car.hud();
    if(S.mode==="bus"){ Bus.tick(dt, S.t); const L=Loc.update(dt, Car.C.x, Car.C.z, "西大寺線"); if(L && L.v) Bus.setLimit(L.v); }
    else Loc.update(dt, Car.C.x, Car.C.z, "");
    Snd.carSound(Car.C); }
  if(S.mode!=="car" && S.mode!=="bus") Snd.carSound(Car.C);   // 他のモードでは車・バスの音を止めておく
  if(S.mode!=="heli") Snd.heliSound(Heli.H);
  if(S.mode==="car"||S.mode==="bus"){}
  else if(S.mode==="heli"){ S.t+=dt; Heli.tick(dt); if(S.car) S.car.visible=false; Heli.updateCam(dt); Heli.hud(); Loc.update(dt, Heli.H.x, Heli.H.z, ""); Snd.heliSound(Heli.H); }
  else if(S.running){ tick(dt); if(S.track){ const p=pointAt(S.pos); Loc.update(dt, p.x, p.z, S.route && S.route.name ? S.route.name.replace(/（.*$/,"") : ""); } } else { S.t+=dt; if(S.track && $("menu").style.display!=="none"){ S.pos=S.cum[0]+40+((S.t*5)%Math.max(1,S.endArc-120)); } }
  lampT+=dt; if(lampT>0.25){ lampT=0; updateLamps(S.t); }
  if(S.mode!=="car" && S.mode!=="bus" && S.mode!=="heli") updateCamera();
  { const hk = S.mode==="heli" && Heli.H.active ? Heli.fogK : 1;   // v17: 高い所では霧・描画距離を遠く
    scene.fog.near = FOG_BASE.near*hk; scene.fog.far = FOG_BASE.far*hk; const cf = hk>1 ? 14000 : 3500; if(camera.far!==cf){ camera.far=cf; camera.updateProjectionMatrix(); } }
  if(window.__camfix){ const c=window.__camfix; camera.position.set(c.pos[0],c.pos[1],c.pos[2]); camera.lookAt(c.look[0],c.look[1],c.look[2]); }   // 確認用の固定カメラ
  const sky=scene.getObjectByName("sky"); if(sky) sky.position.copy(camera.position);
  renderer.render(scene,camera);
  if(S.mode==="car"||S.mode==="bus") Mirrors.render(renderer, scene);
  Cab.active = S.mode==="tram" && S.running && S.view==="cab";
  if(Cab.active){ Cab.update(dt,S); renderer.autoClear=false; Cab.render(renderer); renderer.autoClear=true; Mirrors.renderTram(renderer, scene); }
  layoutHud();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
loadAll().catch(e=>{ console.error(e); $("start-label").textContent="読み込みに失敗しました: "+e.message; });
window.__tick = tick; window.__Bus = Bus; window.__busP = ()=>mkPath(Bus.data.path); window.__pathPt = pathPt; window.__pathTan = pathTan; window.__Loc = Loc; window.__applyHandles = applyHandles; window.__Traffic = Traffic; window.__Trams = Trams; window.__sim = simTraffic; window.__Obs = Obs;
window.__OrthoPages = OrthoPages; window.__GT = GROUND_TILES; window.__dataIn = dataIn; window.__cam = camera;   // v29: 試験用
window.__S = S; window.__Snd = Snd; window.__Heli = Heli; window.__Env = Env; window.__Stream = Stream; window.__world = world; window.__cabpos = () => Cab.screenPos(); window.__Car = Car; window.__Peds = Peds; window.__JR = JR; window.__FACADE_U = FACADE_U; window.__HiStream = HiStream;
})();
