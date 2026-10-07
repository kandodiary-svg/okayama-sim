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
/* v41.10: 文字を入力している間（ナビの検索欄など）は、走行・ホーン・視点などのキー操作を効かせない */
const typing = () => { const a = document.activeElement; return !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)); };
const S = {
  scene:null, routes:null, key:"higashi", route:null,
  track:null, arc:null, total:0, stops:[], cum:[], signals:[], speedLim:null,
  topH:90, pos:0, speed:0, acc:0, emergency:false, notch:0, doorOpen:true, running:false, view:"cab",
  mode:"tram", mc:0, bv:0, look:"photo", play:"mission", cveh:"sedan", playBy:{ tram:"mission", bus:"mission", car:"mission", heli:"mission" },
  score:1000, comfortHits:0, stopIndex:1, sigIndex:0, clock:9*3600, announced:new Set(), t:0
};

/* ---------------- レンダラ ---------------- */
const canvas = $("world");
/* v41.13: 起動の失敗は画面に理由を出す（head.html の OkadenBoot）。画質の設定は変えない */
const Boot = window.OkadenBoot || { box(){}, hide(){}, fail(m, e){ console.error(m, e); } };
const renderer = (() => {
  try { return new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:"high-performance", logarithmicDepthBuffer:false}); }
  catch(e){ Boot.fail("この端末・ブラウザでは 3D 表示（WebGL）を始められませんでした。ブラウザを最新にするか、「ハードウェアアクセラレーション」を有効にして、もう一度開いてください。", e, false); throw e; }
})();
window.__renderer = renderer;
/* 描画が止まった（メモリ不足・GPU の切替など）時は案内を出し、戻ったら消す。three.js が戻す処理（preventDefault）はそのまま */
canvas.addEventListener("webglcontextlost", () => { Boot.box("描画が止まりました。自動で戻るのを待っています。戻らない時は「再読み込み」を押してください。（ほかのタブやアプリを閉じるとメモリが空きます）", true); }, false);
canvas.addEventListener("webglcontextrestored", () => { Boot.hide(); }, false);
/* v31: 形の頂点の配列（位置・法線・UV）は GPU に送った後、JS 側の写しを捨てる（GPU の中の形は同じなので表示は変わらない。メモリだけ減る）。
   WebGL が失われて戻った時は、元のデータから同じ計算で配列を作り直して送り直す（regen）。一度も表示していない形は写しを持ったまま */
const GeoMem = (() => {
  const live = new Set();
  function drop(){ this.array = null; }
  // geo: BufferGeometry, names: 捨てる属性の名前, regen(): {名前: 同じ値の配列}
  function release(geo, names, regen){
    if(!geo.boundingSphere) geo.computeBoundingSphere();
    const e = { geo, names, regen }; live.add(e);
    geo.addEventListener("dispose", () => live.delete(e));
    for(const n of names){ const a = geo.attributes[n]; if(a) a.onUpload(drop); }
  }
  function restore(){
    let n = 0;
    for(const e of live){ let arrs = null;
      for(const k of e.names){ const a = e.geo.attributes[k]; if(a && !a.array){ arrs = arrs || e.regen(); a.array = arrs[k]; n++; } } }
    console.log("GeoMem restored", n);
  }
  canvas.addEventListener("webglcontextrestored", restore, false);
  return { release, restore, get count(){ return live.size; } };
})();
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
function progress(){ const p=Math.min(1,loaded/toLoad); $("loadbar").style.width=(p*100).toFixed(1)+"%"; if($("start").disabled) $("start-label").textContent="3D都市モデルを読み込み中… "+Math.round(p*100)+"%"; }
/* v41.13: 通信の一時的な失敗（切れた・混み合っている）は少し待って自動で再試行する。404（無いファイル）は再試行しない */
const _sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, tries){
  tries = tries || 3; let err;
  for(let i = 0; i < tries; i++){
    try { return await fn(i); }
    catch(e){ err = e; if(e && e.noRetry) break; console.warn("retry", label, (i + 1) + "/" + tries, e); if(i < tries - 1) await _sleep(500 * (i + 1) * (i + 1)); }
  }
  throw err;
}
async function fetchOK(url){
  const res = await fetch(url);
  if(!res.ok){ const e = new Error(url + " " + res.status); if(res.status === 404) e.noRetry = true; throw e; }
  return res;
}
const getJSON = url => withRetry(() => fetchOK(url).then(r => r.json()), url);
// base64（改行・空白は無視）を受け取りながらバイト列に戻す TransformStream。atob と同じ結果で、文字列全体を持たない
const B64T = (() => { const t = new Uint8Array(256).fill(255), A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for(let i = 0; i < 64; i++) t[A.charCodeAt(i)] = i; return t; })();
function b64Decoder(onBytes){
  let acc = 0, nb = 0;
  return new TransformStream({ transform(chunk, ctl){
    onBytes(chunk.length);
    const out = new Uint8Array(((chunk.length * 3) >> 2) + 3); let o = 0;
    for(let i = 0; i < chunk.length; i++){
      const v = B64T[chunk[i]]; if(v === 255) continue;   // "=" や空白
      acc = (acc << 6) | v; nb += 6;
      if(nb >= 8){ nb -= 8; out[o++] = (acc >> nb) & 255; acc &= (1 << nb) - 1; }
    }
    if(o) ctl.enqueue(o === out.length ? out : out.subarray(0, o));
  } });
}
async function fetchPackedOnce(fn){
  const res = await fetchOK("data/"+fn);
  let got = 0;
  try {
    if(fn.endsWith(".bin")){ const u8 = new Uint8Array(await res.arrayBuffer()); got = u8.length * 1.33; loaded += got; progress();   // v26: deflate のバイナリ（base64 をやめて約 25% 小さく）
      return await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer(); }
    if(res.body && typeof TransformStream !== "undefined"){
      // v41.13: 受け取りながら base64 を戻し、そのまま展開する（途中の巨大な文字列・配列を持たない。出来上がる ArrayBuffer は同じ）。バーも受信に合わせて滑らかに進む
      const ds = res.body.pipeThrough(b64Decoder(n => { got += n; loaded += n; progress(); })).pipeThrough(new DecompressionStream("deflate"));
      return await new Response(ds).arrayBuffer();
    }
    const txt = await res.text(); got = txt.length; loaded += got; const bin = atob(txt.trim()); const u8 = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    progress();
    return await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
  } catch(e){ loaded -= got; throw e; }   // 失敗した分の進みは戻して、再試行で二重に数えない
}
const fetchPacked = fn => withRetry(() => fetchPackedOnce(fn), fn);
/* v30: 高さの格子（ground・drive の enc=grad2）を戻す。2 次元の差分（左＋上−左上 との差）の下位・上位バイトの面 → int16 の高さ。
   残り（区分・ビット列など）はそのまま後ろに付け、以前と同じ並びの ArrayBuffer を返す */
function gradDecode(buf, nx, nz){
  const n = nx * nz, src = new Uint8Array(buf), out = new ArrayBuffer(buf.byteLength), H = new Int16Array(out, 0, n);
  for(let j = 0, k = 0; j < nz; j++) for(let i = 0; i < nx; i++, k++){
    const e = ((src[k] | (src[n + k] << 8)) << 16) >> 16;
    H[k] = e + (i ? H[k - 1] : 0) + (j ? H[k - nx] : 0) - (i && j ? H[k - nx - 1] : 0);
  }
  new Uint8Array(out, 2 * n).set(src.subarray(2 * n));
  return out;
}
/* v30: 走行格子（drive, enc=gres）の高さ = 地面の格子（ground・4m 節点・cm）からの予測（双線形補間 − 12cm、重みは 1/4 単位の整数計算）＋差。
   build_v5.ground_pred と同じ整数の計算。gH は戻した後の地面の高さ（Int16Array） */
function gresDecode(buf, nx, nz, gH, gnx, gnz){
  const n = nx * nz, src = new Uint8Array(buf), out = new ArrayBuffer(buf.byteLength), H = new Int16Array(out, 0, n);
  const I0 = new Int32Array(nx), A = new Int32Array(nx);
  for(let i = 0; i < nx; i++){ const f = 2 * i + 1, i0 = Math.min(f >> 2, gnx - 2); I0[i] = i0; A[i] = Math.min(f - 4 * i0, 4); }
  for(let j = 0, k = 0; j < nz; j++){
    const f = 2 * j + 1, j0 = Math.min(f >> 2, gnz - 2), b = Math.min(f - 4 * j0, 4), r0 = j0 * gnx, r1 = r0 + gnx;
    for(let i = 0; i < nx; i++, k++){
      const i0 = I0[i], a = A[i];
      const P16 = (gH[r0 + i0] * (4 - a) + gH[r0 + i0 + 1] * a) * (4 - b) + (gH[r1 + i0] * (4 - a) + gH[r1 + i0 + 1] * a) * b;
      H[k] = (((src[k] | (src[n + k] << 8)) << 16) >> 16) + Math.floor((P16 + 8) / 16) - 12;
    }
  }
  new Uint8Array(out, 2 * n).set(src.subarray(2 * n));
  return out;
}
/* v30: 電線の線分（pwires_enc=sd）: cm の整数、始点は前の線分の始点との差・終点は始点との差、バイトの面 → float32 の x,y,z ×2 */
function pwDecode(buf){
  const b = new Uint8Array(buf), M = b.length / 12, N = M / 2, out = new Float32Array(N * 6);
  const val = (r, c) => b[(c * 4) * M + r] | (b[(c * 4 + 1) * M + r] << 8) | (b[(c * 4 + 2) * M + r] << 16) | (b[(c * 4 + 3) * M + r] << 24);
  let x = 0, y = 0, z = 0;
  for(let i = 0; i < N; i++){
    x += val(i, 0); y += val(i, 1); z += val(i, 2);
    out[i * 6] = x / 100; out[i * 6 + 1] = y / 100; out[i * 6 + 2] = z / 100;
    out[i * 6 + 3] = (x + val(N + i, 0)) / 100; out[i * 6 + 4] = (y + val(N + i, 1)) / 100; out[i * 6 + 5] = (z + val(N + i, 2)) / 100;
  }
  return out;
}
/* v41.11: 制限速度の引き上げと「道路の大きさ」。
   data/traffic.json の v は OSM の道路種別ごとの既定値（幹線 50・準幹線/県道 40・細い道 30）で、実際の道路より遅かった。
   一般道の法定速度（60）を上限に、幹線 60・準幹線 50・県道 50・細い道(unclassified) 40・生活道路 30 に置き換える。
   HUD の「制限」・AI 車の走る速さ・ナビの所要時間・速度超過の判定がすべて同じ値を使うので、ここで 1 回だけ直す。
   imp: 道路の大きさ（交通量の配分とナビの道選びに使う）。幹線 4（片側 2 車線以上は 4.5）> 準幹線 2.4（2 車線 3.2）> 市道・県道 1.6（2 車線 2.6）> 細い道 0.7 > 生活道路 0.5。
        OSM の種別だけだと、岡山の大通り（市役所筋・けやき通りなど）が「県道・市道」に入ってしまうので、片側の車線数も使う
   sw : AI 車を出現させる重み（大通りに多く、細い道には少なく）。直進の幹線の接続（v=60）は 70 に */
function raiseLimits(tj){
  for(const l of tj.lanes){
    const trunk = l.c === "t" && l.v >= 50, two = l.n >= 2;
    let v, imp, sw;
    if(l.c === "p" || trunk){ v = 60; imp = two ? 4.5 : 4; sw = 1; }
    else if(l.c === "s"){ v = 50; imp = two ? 3.2 : 2.4; sw = two ? 0.9 : 0.7; }
    else if(l.c === "t"){ v = 50; imp = two ? 2.6 : 1.6; sw = two ? 0.6 : 0.08; }
    else if(l.c === "u"){ v = 40; imp = 0.7; sw = 0.02; }
    else { v = 30; imp = 0.5; sw = 0.012; }
    l.v = v; l.imp = imp; l.sw = sw;
  }
  for(const c of tj.conns) if(c.k === "s" && c.v >= 60) c.v = 70;
}
const SPEED_OVER_OK = 20;    // v41.11: 制限速度を 20 km/h 超えるまでは減点・注意しない
/* v30: traffic.json の点列は別ファイル（int32 の cm・点列ごとの差分・バイトの面）。e.o から e.m 点 */
async function loadTrafficPts(tj){
  if(!tj || !tj.pts) return tj;
  const b = new Uint8Array(await fetchPacked(tj.pts.file)), N = tj.pts.n, A = new Float64Array(N * 3);
  for(let c = 0; c < 3; c++){ const o = c * 4 * N; for(let i = 0; i < N; i++) A[i * 3 + c] = b[o + i] | (b[o + N + i] << 8) | (b[o + 2 * N + i] << 16) | (b[o + 3 * N + i] << 24); }
  for(const L of [tj.lanes, tj.conns]) for(const e of L) for(let k = e.o + 1; k < e.o + e.m; k++){ A[k * 3] += A[k * 3 - 3]; A[k * 3 + 1] += A[k * 3 - 2]; A[k * 3 + 2] += A[k * 3 - 1]; }
  for(let i = 0; i < A.length; i++) A[i] /= 100;
  tj.PTS = A; return tj;
}
function trafficPts(tj, e){
  if(e.p) return e.p;
  const A = tj.PTS, out = new Array(e.m);
  for(let k = 0; k < e.m; k++){ const q = (e.o + k) * 3; out[k] = [A[q], A[q + 1], A[q + 2]]; }
  return out;
}
function loadTex(fn){
  // v41.13: 画像の読み込みに失敗したら少し待って 2 回まで再試行（それでも駄目なら今まで通り null）
  return new Promise(res=>{ const go = n => new THREE.TextureLoader().load("data/"+fn, t=>{ t.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy()); loaded+=900e3; progress(); res(t); }, undefined,
    ()=>{ if(n < 3){ console.warn("retry tex", fn, n + "/3"); setTimeout(()=>go(n + 1), 500 * n * n); } else { console.warn("tex failed", fn); res(null); } }); go(1); });
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
  // 窓明かり（v36）: 実際の窓（外壁材質はガラス部分、写真の外壁は世界座標の窓格子）だけが灯る。
  //  事務所・商業ビル = 階ごとにまとめて点灯（蛍光灯・LED の白色）、住宅・マンション = 部屋ごとにばらばら（電球色・白色・ときどきテレビの青白さ）、
  //  1階は店・ロビーが明るい。カーテン越しの窓はやや暗く暖色。遠くは格子の平均に切り替えてちらつきを防ぐ
  const NWIN_GLSL = `
    float nH(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    vec3 nWin(float typ, float r1, float r2, float r3){
      vec3 c;
      if(typ < 0.5){ c = mix(vec3(0.86,0.95,1.0), vec3(1.0,0.93,0.78), step(0.72,r2)); }
      else if(typ < 1.5){ c = mix(vec3(1.0,0.70,0.40), vec3(1.0,0.84,0.62), r2); c = mix(c, vec3(0.92,0.96,1.0), step(0.78,r3)); c = mix(c, vec3(0.48,0.60,1.0), step(0.94,r3)); }
      else { c = mix(vec3(1.0,0.93,0.80), vec3(1.0,0.80,0.52), r2); }
      return c * (0.38 + 0.62*r1);
    }`;
  const NWIN_GRID = `
        if(uNight > 0.01 && abs(vWN.y) < 0.4 && !(vWP.x > 1476.0 && vWP.x < 1521.0 && vWP.z > 19.0 && vWP.z < 49.0)){   // 岡山城の天守は窓明かりでなくライトアップ
          float n = uNight;
          vec2 zone = floor(vWP.xz / 14.0) + floor(vWN.xz * 1.5) * 7.0;
          float s = nH(zone);
          float typ = (s < 0.26 || (vWP.y > 42.0 && s < 0.6)) ? 0.0 : (s > 0.9 ? 2.0 : 1.0);
          float pX = mix(2.2, 3.4, fract(s*7.3)), pY = mix(3.2, 3.8, fract(s*3.1));
          float along = dot(vWP.xz, normalize(vec2(-vWN.z, vWN.x)));
          float ux = along / pX, uy = (vWP.y - 1.0) / pY;
          vec2 cell = vec2(floor(ux), floor(uy)), f = vec2(fract(ux), fract(uy));
          float r  = nH(cell + zone * 13.1);
          float r1 = fract(r*37.7), r2 = fract(r*91.3 + 0.31), r3 = fract(r*53.9 + 0.77);
          float rowh = nH(vec2(cell.y, s * 91.0));
          float lit, area;
          vec2 wx = typ < 0.5 ? vec2(0.03, 0.97) : vec2(0.14, 0.86);
          vec2 wy = typ < 0.5 ? vec2(0.28, 0.80) : vec2(0.34, 0.78);
          float msk = smoothstep(wx.x, wx.x + 0.03, f.x) * (1.0 - smoothstep(wx.y - 0.03, wx.y, f.x)) * smoothstep(wy.x, wy.x + 0.03, f.y) * (1.0 - smoothstep(wy.y - 0.03, wy.y, f.y));
          float act;
          if(typ < 0.5){ act = mix(0.72, 0.42, n); lit = step(rowh, act) * step(0.08, r1); }
          else if(typ < 1.5){ act = mix(0.52, 0.30, n); lit = step(r, act); }
          else { act = mix(0.62, 0.45, n); lit = step(r, act); }
          area = (wx.y - wx.x) * (wy.y - wy.x) * act;
          float aa = clamp(max(fwidth(ux), fwidth(uy)) * 1.6, 0.0, 1.0);
          float em = mix(lit * msk, area, aa) * step(0.0, vWP.y - 2.5);
          vec3 col = nWin(typ, r1, r2, r3);
          totalEmissiveRadiance += col * em * n * 0.95;
        }`;
  const NWIN_FAC = `
        if(uNight > 0.01 && uTyp > -0.5 && glassF > 0.01){
          float n = uNight;
          float rowKey = vColor.r*91.7 + vColor.b*57.3;
          float r1 = fract(hh*37.7), r2 = fract(hh*91.3 + 0.31), r3 = fract(hh*53.9 + 0.77);
          float rowh = nH(vec2(cell.y, rowKey));
          float typ = uTyp, lit;
          if(flr < 0.5){                                            // 1階: 店・ロビー
            lit = step(r3, typ < 1.5 && typ > 0.5 ? 0.30 : 0.82); typ = typ > 0.5 && typ < 1.5 ? 1.0 : 2.0;
          } else if(typ < 0.5){ lit = step(rowh, mix(0.72, 0.42, n)) * step(0.08, r1); }
          else if(typ < 1.5){ lit = step(r3, mix(0.52, 0.30, n)); }
          else { lit = (rowh < 0.5) ? step(rowh*2.0, mix(0.72,0.42,n)) * step(0.08, r1) : step(r3, mix(0.5,0.3,n)); typ = rowh < 0.5 ? 0.0 : 1.0; }
          vec3 col = nWin(typ, r1, r2, r3);
          col *= mix(1.0, 0.72, step(0.86, hh));                      // カーテン・ブラインド越し
          col = mix(col, col * vec3(1.0, 0.82, 0.60), step(0.86, hh));
          totalEmissiveRadiance += col * lit * glassF * n * 0.95;
        }`;
  function addWindows(m, kind){
    const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
    const fk = kind && kind.startsWith("facade_") ? kind.slice(7) : "";
    const fac = !!fk && fk !== "station";   // 駅舎の外壁は専用の材質（窓の絵が違う）なので世界座標の格子
    const typ = (fk==="warehouse"||fk==="temple") ? -1 : (fk==="office"||fk==="curtain") ? 0 : (fk==="shop") ? 2 : 1;
    m.customProgramCacheKey = () => (fac ? "winF" : (prevKey ? prevKey() : "") + "|winG");
    m.onBeforeCompile = (sh, r) => {
      if(prev) prev(sh, r);
      sh.uniforms.uNight = NIGHT_U;
      if(fac){
        sh.uniforms.uTyp = { value: typ };
        sh.fragmentShader = "uniform float uNight; uniform float uTyp;\n" + NWIN_GLSL + "\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + NWIN_FAC);
      } else {
        sh.vertexShader = "varying vec3 vWP; varying vec3 vWN;\n" + sh.vertexShader.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vWP = (modelMatrix * vec4(transformed,1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);");
        sh.fragmentShader = "uniform float uNight; varying vec3 vWP; varying vec3 vWN;\n" + NWIN_GLSL + "\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + NWIN_GRID);
      }
    };
    m.needsUpdate = true;
  }
  function patch(m, kind){
    if(patched.has(m)) return; patched.add(m);
    if(kind==="tex" || kind==="texhi" || (kind && kind.startsWith("facade_"))) addWindows(m, kind);
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
    // v36: 街灯は「小さく鋭い光源 + 弱いにじみ」。両方向の車線で重なる分は 7m 以内で1本にまとめる。色は LED の白 6割・ナトリウム灯の橙 4割
    const raw = Traffic.segsForLamps(), seen = new Set(), pts = [], cols = [];
    for(let i=0;i<raw.length;i+=3){
      const kx = Math.round(raw[i]/7), kz = Math.round(raw[i+2]/7), key = kx*100003 + kz;
      if(seen.has(key)) continue; seen.add(key);
      pts.push(raw[i], raw[i+1], raw[i+2]);
      const h = Math.abs(Math.sin(kx*12.9898 + kz*78.233)*43758.5453) % 1;
      if(h < 0.6) cols.push(1.0, 0.95 - h*0.05, 0.84 - h*0.1); else cols.push(1.0, 0.66 + h*0.12, 0.34 + h*0.1);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    const tex = canvasTex(64,64,(c,w,h)=>{ const gr=c.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,"rgba(255,255,255,1)"); gr.addColorStop(0.07,"rgba(255,255,255,0.95)"); gr.addColorStop(0.16,"rgba(255,255,255,0.32)"); gr.addColorStop(0.4,"rgba(255,255,255,0.07)"); gr.addColorStop(1,"rgba(255,255,255,0)"); c.fillStyle=gr; c.fillRect(0,0,w,h); });
    lamps = new THREE.Points(g, new THREE.PointsMaterial({ map:tex, size:4.6, sizeAttenuation:true, vertexColors:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:true }));
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
    NIGHT_U.value = p.night; Veh.setNight(p.night); Veh.setRain(wet);   // v41.14: 雨の日は車の窓に水滴・ワイパー
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
      if((S.mode==="car"||S.mode==="bus") && Car.C.active){ head.distance = 115; head.intensity = 2.6; const C=Car.C, fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), f=Car.P.len/2;
        head.position.set(C.x+fx*f, C.h+0.9, C.z+fz*f); head.target.position.set(C.x+fx*(f+30), C.h, C.z+fz*(f+30)); }
      else if(S.running && S.track){ const p=pointAt(S.pos), t=tangentAt(S.pos); head.position.set(p.x+t.x*0.5, p.y+1.2, p.z+t.z*0.5); head.target.position.set(p.x+t.x*40, p.y, p.z+t.z*40); }
      else if(S.mode==="heli" && Heli.H.active){ const H=Heli.H, fx=Math.sin(H.yaw), fz=Math.cos(H.yaw);   // サーチライト（機首の下から前下方）
        head.position.set(H.x+fx*2, H.y+0.5, H.z+fz*2); head.target.position.set(H.x+fx*(20+H.agl*0.6), H.ground, H.z+fz*(20+H.agl*0.6)); head.distance = 120 + H.agl*1.6; }
      head.target.updateMatrixWorld();
    }
  }
  let timeHook = null;   // v41.7: 時間帯が変わったら時計も合わせる（Clock が登録）
  function set(time, rainOn){ const prev = st.time; if(time) st.time=time; if(rainOn!==undefined) st.rain=rainOn; apply(); if(time && time!==prev && timeHook) timeHook(time); }
  const order=["morning","noon","evening","night"];
  function cycle(){ set(order[(order.indexOf(st.time)+1)%order.length]); }
  return { patch, set, tick, cycle, st, apply, NIGHT_U, setTimeHook(f){ timeHook = f; } };
})();

/* ---------------- v41.7: 時計（どのモードでも、画面に「今の時刻」を出す） ----------------
   S.clock = 1 日の中の秒。始めるとき、選んだ時間帯（朝 7:30・昼 12:00・夕方 17:30・夜 20:00）の時刻から。
   走行中に時間帯を切り替える（N キー）と時計もその時刻へ進み、ダイヤの定刻も同じだけずらす（遅れ・早発の判定がずれないように）。 */
const Clock = (() => {
  const PRESET = { morning: 7*3600 + 30*60, noon: 12*3600, evening: 17*3600 + 30*60, night: 20*3600 };
  const TAGS = { morning: "朝", noon: "昼", evening: "夕方", night: "夜" };
  const shifts = [];
  const pad = (n) => String(n).padStart(2, "0");
  const menuEl = () => document.getElementById("menu");
  const inSession = () => { const m = menuEl(); return !!m && m.style.display === "none"; };
  const startT = () => PRESET[Env.st.time] || PRESET.noon;
  function reset(){ S.clock = startT(); }
  function jump(t){ const d = t - S.clock; if(!d) return; S.clock = t; for(const f of shifts) f(d); }
  Env.setTimeHook(() => { if(inSession()) jump(startT()); });
  const eT = document.querySelectorAll(".ckt"), eS = document.querySelectorAll(".cks"), eG = document.querySelectorAll(".ckg"); let lastKey = "";
  function render(){
    if(!inSession()) return;
    const t = Math.floor(S.clock), key = t + Env.st.time; if(key === lastKey) return; lastKey = key;
    const hhmm = pad(Math.floor(t / 3600) % 24) + ":" + pad(Math.floor(t / 60) % 60), sec = ":" + pad(t % 60), tag = TAGS[Env.st.time] || "";
    eT.forEach((e) => { e.textContent = hhmm; }); eS.forEach((e) => { e.textContent = sec; }); eG.forEach((e) => { e.textContent = tag; });
  }
  return { PRESET, TAGS, startT, reset, jump, onShift(f){ shifts.push(f); }, render, inSession };
})();

/* 試験用: window.__MEMLOG があれば、読み込みの段ごとに JS のメモリを記録する（普段は何もしない） */
async function _memlog(name){ if(!window.__MEMLOG) return; if(typeof gc==="function"){ gc(); await new Promise(r=>setTimeout(r,50)); gc(); }
  window.__MEMLOG.push([name, performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : -1, window.__cdpmem ? await window.__cdpmem() : null]); }
async function loadAll(){
  const [sc, rt] = await Promise.all([getJSON("data/scene.json"), getJSON("data/routes.json")]);
  S.scene=sc; S.routes=rt; S._atlas = S._atlas || [];   // v22: タイルの読み込み（Stream）が先に始まっても落ちないよう最初に用意
  // v29: 車・信号・歩行者・JR・バス・地名のデータは、地形・建物と並行して先に取り寄せる（範囲拡大で大きくなったため）
  const jget = n => getJSON("data/"+n).catch(e=>{ console.warn(n, e); return null; });   // v41.13: 一時的な失敗は再試行（無いファイルは今まで通り null）
  const JP = { traffic: jget("traffic.json").then(loadTrafficPts).catch(e=>{ console.warn("traffic pts", e); return null; }), signals: jget("signals.json"), peds: jget("peds.json"), jr: jget("jr.json"), bus: jget("bus.json"), places: jget("places.json") };
  // v16: "@" の付いたファイル（建物・植生のタイル）は Stream が近くの分だけ読み込む。それ以外は最初に全部読む
  const core = Object.entries(sc.files).filter(([k])=>!k.includes("@"));
  const OVM = !!sc.ortho_ov;   // v29: 縮小写真＋近くのページだけ（範囲拡大版）
  toLoad = core.reduce((a,[k,f])=>a+(f.size||f.raw*0.9),0) + (OVM ? 12*900e3 + 4e6 : sc.ortho.length*900e3) + 6e7;   // v30: size = 送る大きさ
  const bufs = {};
  const texP = OVM ? loadTex(sc.ortho_ov.file).then(t=>{ if(!t) throw new Error("航空写真（"+sc.ortho_ov.file+"）を読み込めませんでした"); t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy()); OrthoPages.setOverview(t, sc.ortho_ov); return []; })
                   : Promise.all(sc.ortho.map(o=>loadTex(o.file)));
  texP.catch(()=>{});   // 失敗は下の await texP で拾う（先に落ちても未処理扱いにしない）
  await Promise.all(core.map(async ([k,f])=>{ bufs[k]=await fetchPacked(f.file); }));
  for(const k of ["ground", "drive"]){ const m = sc[k]; if(m && m.enc === "grad2" && bufs[k]) bufs[k] = gradDecode(bufs[k], m.nx, m.nz); }   // v30
  if(sc.drive && sc.drive.enc === "gres" && bufs.drive && bufs.ground)
    bufs.drive = gresDecode(bufs.drive, sc.drive.nx, sc.drive.nz, new Int16Array(bufs.ground, 0, sc.ground.nx * sc.ground.nz), sc.ground.nx, sc.ground.nz);
  const ortho = await texP;
  await _memlog("core");
  S._bufs = bufs; S._ortho = ortho;
  if(OrthoPages.active){ await OrthoPages.prime({x:0, z:0}); buildGroundOV(sc.ground, bufs.ground); groundTick({x:0, y:0, z:0}, false, 0, 99); }
  else buildGround(sc.ground, bufs.ground, ortho);
  if(sc.drive && bufs.drive) Car.setGrid(sc.drive, bufs.drive);
  Car.setExt({ road:(x,z,yr)=>{ const r=MW.roadAt(x,z,yr); return r && Math.abs(r.y-yr)<4 ? r.y : NaN; }, h:(x,z)=>{ const o=Outer.h(x,z); return isNaN(o)?Heli.farH(x,z):o; }, blocked:(x,z,yr)=>MW.wallAt(x,z,yr) });
  if(sc.hmax && bufs.hmax) Heli.setHmax(sc.hmax, bufs.hmax);
  await _memlog("ground");
  if(sc.far && bufs.far){ Heli.setFar(sc.far, bufs.far); try { await buildFarTerrain(sc.far, bufs.far); } catch(e){ console.warn("far", e); } }
  buildChunks(sc.chunks.filter(c=>!c.file.includes("@")), bufs, S._atlas, ortho);
  await _memlog("chunks");
  buildWires(sc.wires); if(bufs.pwires) buildPowerWires(sc.pwires_enc === "sd" ? pwDecode(bufs.pwires) : new Float32Array(bufs.pwires));
  setVehicle(S.vehicle||"momo");
  // 出発地点（岡山駅前）の周りのタイルを先に読む
  $("start-label").textContent="周りの建物を読み込み中…";
  // v29: 最初は出発地点の近く（700m）だけ読み終わるのを待つ。その先は走り出してから順に読む（範囲拡大で数が多い）
  await Stream.update(0, 0, true, 700);
  await _memlog("stream");
  let tj=null;
  try { Trams.init(rt); tj = await JP.traffic; if(tj){ raiseLimits(tj); Traffic.init(tj); } } catch(e){ console.warn("traffic", e); }
  await _memlog("traffic");
  try { const sj = await JP.signals; buildSignals(sj, rt); } catch(e){ console.warn("signals", e); }
  await _memlog("signals");
  try { const pj = await JP.peds; if(pj) Peds.init(pj); } catch(e){ console.warn("peds", e); }
  await _memlog("peds");
  try { const jj = await JP.jr; if(jj){ JR.init(jj); buildJRPicker(); } } catch(e){ console.warn("jr", e); }
  await _memlog("jr");
  try { const [bj, pj] = await Promise.all([JP.bus, JP.places]);
    Loc.init(pj, tj); if(bj) Bus.init(bj); } catch(e){ console.warn("bus/places", e); }
  if(tj){ for(const l of tj.lanes) l.p=null; for(const c of tj.conns) c.p=null; tj.PTS=null; }   // v29: 車線の形は Traffic・Loc の中に作り終えたので、元の JSON の点は捨てる（メモリ）
  buildRoutePicker(); setupRoute(S.key, true);
  await _memlog("bus_loc_free");
  Prefs.restore();
  Trams.populate(S.key, S.cum[0]+40, S.vehicle);
  await _memlog("end");
  $("loadbar").style.width="100%"; $("start").disabled=false; applyMenu();
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
    update(p.x, p.z, false); Outer.tick(c); MW.tick(c);
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
  const om = await Outer.loadMan(), DR = om && om.drop ? om.drop : [];      // v37: 山陽道沿いの細かいブロック（outer_tiles.py の FF）の下は、遠景の地形を大きく下げて隠す
  for(let j = 0; j < nz; j++) for(let i = 0; i < nx; i++){
    const k = j * nx + i, x = meta.x0 + i * st, z = meta.z0 + j * st, inside = x > hx0 && x < hx1 && z > hz0 && z < hz1;
    let dn = 0; for(const r of DR) if(x > r[0] + 1e-3 && x < r[2] - 1e-3 && z > r[1] + 1e-3 && z < r[3] - 1e-3){ dn = 90; break; }
    pos[k * 3] = x; pos[k * 3 + 1] = A[k] / 10 - (inside ? 4 : 0.3) - dn; pos[k * 3 + 2] = z;
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
/* ---------------- v36: 外側の地形タイル（遠景の 20km 四方の外・山陽新幹線の線路沿い） ----------------
   pipeline/outer_tiles.py: 2km 四方・40m 格子の標高（国土地理院）と 512px の航空写真。近く（約 3.3km）の分だけ作り、離れたら捨てる。
   遠景の範囲の中に入る部分は作らない（遠景の地形がある）。 */
const Outer = (() => {
  let man = null, A = null, ready = false, busy = 0, lastT = 0, manP = null;
  const idxW = new Map(), idxF = new Map(), live = new Map(), loading = new Set(), R_LOAD = 3300, R_DROP = 4600;
  // v37: 目録は遠景の地形（buildFarTerrain）からも使う（山陽道沿いの細かいブロックの下に遠景を沈める）
  function loadMan(){ if(!manP) manP = getJSON("data/outer.json").catch(() => null); return manP; }
  async function init(){
    try{
      man = await loadMan(); if(!man) return;
      A = new Int16Array(await withRetry(() => fetchOK("data/outer_h.bin").then(r => r.arrayBuffer()), "outer_h.bin"));
      for(const t of man.tiles) (t.kind === "FF" ? idxF : idxW).set(t.i + "_" + t.j, t);
      ready = true;
    }catch(e){ console.warn("outer", e); }
  }
  // v37: タイルは種類ごと。W/F = 世界座標の 2km 格子（i=floor(x/2000)）、FF = 遠景の格子に揃えた 2km ブロック。解像度（nh）はタイルごと（W 51 点・F/FF 201 点）
  function tileAt(x, z){
    const C = man.cell, F = man.far;
    if(x >= F[0] && x < F[2] && z >= F[1] && z < F[3]) return idxF.get(Math.floor((x - F[0]) / C) + "_" + Math.floor((z - F[1]) / C)) || null;
    return idxW.get(Math.floor(x / C) + "_" + Math.floor(z / C)) || null;
  }
  function h(x, z){        // 標高（その場所にタイルが無ければ NaN）
    if(!ready) return NaN;
    const t = tileAt(x, z); if(!t) return NaN;
    const N = t.nh, n = N - 1, fx = (x - t.x0) / t.s * n, fz = (z - t.z0) / t.s * n, a = Math.max(0, Math.min(Math.floor(fx), n - 1)), b = Math.max(0, Math.min(Math.floor(fz), n - 1)), tx = fx - a, tz = fz - b, o = t.k;
    return ((A[o + b * N + a] * (1 - tx) + A[o + b * N + a + 1] * tx) * (1 - tz) + (A[o + (b + 1) * N + a] * (1 - tx) + A[o + (b + 1) * N + a + 1] * tx) * tz) / 10;
  }
  function inFar(x0, z0, x1, z1){ const F = man.far; return x0 >= F[0] - 1 && x1 <= F[2] + 1 && z0 >= F[1] - 1 && z1 <= F[3] + 1; }
  function build(t, tex){
    const N = t.nh, st = t.s / (N - 1), x0 = t.x0, z0 = t.z0, o = t.k, HL = man.hole, ff = t.kind === "FF";
    const pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2);
    for(let b = 0; b < N; b++) for(let a = 0; a < N; a++){ const k = b * N + a, x = x0 + a * st, z = z0 + b * st;
      const inH = HL && x > HL[0] && x < HL[2] && z > HL[1] && z < HL[3];
      pos[k * 3] = x; pos[k * 3 + 1] = A[o + k] / 10 - (inH ? 4 : 0.3); pos[k * 3 + 2] = z; uv[k * 2] = a / (N - 1); uv[k * 2 + 1] = 1 - b / (N - 1); }
    const ix = [], mg = Math.max(8, st * 1.05);
    for(let b = 0; b < N - 1; b++) for(let a = 0; a < N - 1; a++){
      const xa = x0 + a * st, za = z0 + b * st, xb = xa + st, zb = za + st;
      if(!ff && inFar(xa, za, xb, zb)) continue;                                                       // 遠景の地形がある所は作らない
      if(HL && xa > HL[0] + mg && xb < HL[2] - mg && za > HL[1] + mg && zb < HL[3] - mg) continue;    // データ（PLATEAU）の地面がある所は作らない
      const p = b * N + a; ix.push(p, p + N, p + 1, p + 1, p + N, p + N + 1); }
    if(!ix.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.setIndex(ix); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex })); m.name = "outer_" + t.key; m.renderOrder = -0.5; return m;
  }
  function load(t){
    const key = t.key; loading.add(key); busy++;
    new THREE.TextureLoader().load("data/outer/" + key + ".jpg", tex => {
      loading.delete(key); busy--; tex.anisotropy = t.nh > 100 ? 8 : 4;
      if(!live.has(key) && ready){ const m = build(t, tex); live.set(key, m || false); if(m) scene.add(m); } else tex.dispose();
    }, undefined, () => { loading.delete(key); busy--; live.set(key, false); });
  }
  function tick(c, force){
    const now = performance.now(); if(!force && now - lastT < 400) return; lastT = now;
    if(!ready){ if(!man && !Outer._started){ Outer._started = true; init(); } return; }
    for(const t of man.tiles){ const key = t.key, x0 = t.x0, z0 = t.z0, C = t.s;
      const d = Math.hypot(Math.max(x0 - c.x, 0, c.x - (x0 + C)), Math.max(z0 - c.z, 0, c.z - (z0 + C)));
      if(d < R_LOAD && !live.has(key) && !loading.has(key) && busy < (force ? 6 : 3)) load(t);
      else if(d > R_DROP && live.has(key)){ const m = live.get(key); if(m){ scene.remove(m); m.geometry.dispose(); if(m.material.map) m.material.map.dispose(); m.material.dispose(); } live.delete(key); } }
  }
  return { tick, h, loadMan, get live(){ return live; }, get ready(){ return ready; }, get man(){ return man; } };
})();
/* ---------------- v37: 山陽自動車道（県内。福山西〜上郡） ----------------
   pipeline/mw.py・mw_prof.py・mw_out.py: OSM の本線（上下線別）・ランプ・IC・料金所・SA/PA、縦断は国土地理院の標高から推定（勾配 3.2% 以下、橋・トンネルは OSM の区分）。
   data/mw.json（目録）・data/mw.bin（点 Float32 xyz × n、gap Uint8 × n）。道路は点（5m 間隔）から画面側で組み立てる（500m ごとのチャンクを近くだけ作る）。
   断面（標準断面からの推定）: 本線 = 車線 3.5m × N、左路肩 2.5m・右 1.0m。ランプ = 1 車線 4.5m（左 1.0m・右 0.8m）。
   路面の横断勾配 1.5%、カーブでは曲率から片勾配（最大 6.5%）。 */
const MW = (() => {
  const CH = 100, R_BUILD = 1500, R_DROP = 2100, C0 = 0.015;
  let man = null, PT = null, GP = null, ready = false, lastT = 0, busy = false, started = false;
  const chains = [], grid = new Map(), GC = 32, live = new Map();
  let M = null;                                        // 材質（初回に作る）
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* ---------- データ ---------- */
  async function init(){
    try{
      const [mj, buf] = await Promise.all([getJSON("data/mw.json").catch(() => null), withRetry(() => fetchOK("data/mw.bin").then(r => r.arrayBuffer()), "mw.bin").catch(() => null)]);
      if(!mj || !buf) return;
      man = mj; PT = new Float32Array(buf, 0, man.total * 3); GP = new Uint8Array(buf, man.total * 12, man.total);
      for(const c of man.chains) chains.push(prep(c));
      buildIndex(); findFreeEnds(); mapIC(); ready = true;
    }catch(e){ console.warn("mw", e); }
  }
  function runsToArr(n, runs){ const a = new Uint8Array(n); for(const [s, e] of runs) a.fill(1, s, Math.min(n, e + 1)); return a; }
  function prep(c){
    const n = c.n, o = c.o;
    c.X = new Float32Array(n); c.Y = new Float32Array(n); c.Z = new Float32Array(n);
    for(let i = 0; i < n; i++){ c.X[i] = PT[(o + i) * 3]; c.Y[i] = PT[(o + i) * 3 + 1]; c.Z[i] = PT[(o + i) * 3 + 2]; }
    c.tx = new Float32Array(n); c.tz = new Float32Array(n); c.rx = new Float32Array(n); c.rz = new Float32Array(n);
    for(let i = 0; i < n; i++){ const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); let dx = c.X[b] - c.X[a], dz = c.Z[b] - c.Z[a]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; c.tx[i] = dx; c.tz[i] = dz; c.rx[i] = -dz; c.rz[i] = dx; }
    c.ds = c.L / Math.max(1, n - 1);
    c.br = runsToArr(n, c.br); c.tn = runsToArr(n, c.tn); c.skip = runsToArr(n, c.skip);
    c.gap = new Float32Array(n); for(let i = 0; i < n; i++) c.gap[i] = GP[o + i] * 0.5;
    // 断面
    if(c.kind === "main") c.sec = { N: clamp(c.lanes, 2, 3), lw: 3.5, SL: 2.5, SR: 1.0 };
    else if(c.lanes >= 2) c.sec = { N: 2, lw: 3.5, SL: 1.5, SR: 1.0 };
    else c.sec = { N: 1, lw: 4.5, SL: 1.0, SR: 0.8 };
    c.hl = c.sec.N * c.sec.lw / 2 + c.sec.SL; c.hr = c.sec.N * c.sec.lw / 2 + c.sec.SR;
    // 片勾配: 曲率（右カーブが正）から。ガウス平滑して緩和区間にする
    const th = new Float32Array(n); let prev = 0, acc = 0;
    for(let i = 0; i < n; i++){ const a = Math.atan2(c.tz[i], c.tx[i]); if(i > 0){ let d = a - prev; while(d > Math.PI) d -= 2 * Math.PI; while(d < -Math.PI) d += 2 * Math.PI; acc += d; } prev = a; th[i] = acc; }
    const W = 5, e = new Float32Array(n);
    for(let i = 0; i < n; i++){ const a = Math.max(0, i - W), b = Math.min(n - 1, i + W), k = (th[b] - th[a]) / Math.max(1, (b - a)) / c.ds; e[i] = clamp(k * 40, -0.065, 0.065); }
    c.e = new Float32Array(n); const g = [0.054, 0.242, 0.399, 0.242, 0.054]; // σ≈1 の平滑を 3 回
    let src = e; for(let r = 0; r < 4; r++){ const dst = new Float32Array(n); for(let i = 0; i < n; i++){ let s = 0, w = 0; for(let q = -2; q <= 2; q++){ const j = clamp(i + q, 0, n - 1); s += src[j] * g[q + 2]; w += g[q + 2]; } dst[i] = s / w; } src = dst; }
    c.e = src;
    // 自分と同じ種類の本線で「他の車線とつながる」ことの目印（AI 車で使う）
    c.nch = Math.ceil((n - 1) / CH);
    return c;
  }
  function buildIndex(){
    for(const c of chains) for(let i = 0; i < c.n; i++){ if(c.skip[i]) continue; const k = Math.floor(c.X[i] / GC) * 100003 + Math.floor(c.Z[i] / GC); let a = grid.get(k); if(!a){ a = []; grid.set(k, a); } a.push(c.id, i); }
  }
  /* IC・JCT・PA/SA の照明: 各地点の近くの本線（上下線）にも照明柱を立てる（OSM の節点は料金所やランプ側の鎖に付いているため） */
  function mapIC(){
    const add = []; const seen = new Set();
    for(const ic of (man.ic || [])){ const cx = Math.floor(ic.x / GC), cz = Math.floor(ic.z / GC), best = {};
      for(let dx = -5; dx <= 5; dx++) for(let dz = -5; dz <= 5; dz++){ const a = grid.get((cx + dx) * 100003 + (cz + dz)); if(!a) continue;
        for(let q = 0; q < a.length; q += 2){ const c = chains[a[q]]; if(c.kind !== "main" || c.L < 10000) continue; const i = a[q + 1], d = Math.hypot(c.X[i] - ic.x, c.Z[i] - ic.z); if(d < 160 && (!best[c.id] || d < best[c.id][0])) best[c.id] = [d, i]; } }
      for(const id in best){ const key = id + "_" + Math.round(best[id][1] / 60); if(seen.has(key)) continue; seen.add(key); add.push({ name: ic.name, ref: ic.ref, x: ic.x, z: ic.z, c: +id, i: best[id][1] }); } }
    man.ic = (man.ic || []).concat(add);
  }
  /* 現在地の表示用（山陽道の上にいる時の文字列） */
  let _icn = null;
  function info(x, z, yref){
    if(!ready) return null; const r = roadAt(x, z, yref, true); if(!r) return null; const c = r.c;
    if(!_icn){ _icn = []; const seen = new Set(); for(const ic of (man.ic || [])){ const nm = (ic.name || "").replace(/\s*[（(](上り|下り)[）)]/, "").replace(" ", ""); if(!nm) continue; const k = nm + Math.round(ic.x / 400) + Math.round(ic.z / 400); if(seen.has(k)) continue; seen.add(k); _icn.push([nm, ic.x, ic.z]); } }
    let bn = "", bd = 6000 * 6000; for(const [nm, ix, iz] of _icn){ const d = (ix - x) ** 2 + (iz - z) ** 2; if(d < bd){ bd = d; bn = nm; } }
    const main = c.kind === "main" && c.L > 10000, dir = main ? (c.X[c.n - 1] < c.X[0] ? "下り" : "上り") : "";
    const road = main ? "山陽自動車道" : (c.name || (c.kind === "link" ? "ランプ" : "高速道路"));
    return { text: "<b>" + road + (dir ? " " + dir : "") + "</b>" + (bn ? "<i>／</i>" + bn + "付近（" + (Math.sqrt(bd) / 1000).toFixed(1) + " km）" : ""), v: c.ms > 0 ? c.ms : (main ? 100 : 40), road };
  }
  /* 行き止まり（OSM が途切れる所）: 近くに他の鎖が無い端 */
  function nearOther(c, x, z){
    const cx = Math.floor(x / GC), cz = Math.floor(z / GC);
    for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){ const a = grid.get((cx + dx) * 100003 + (cz + dz)); if(!a) continue;
      for(let q = 0; q < a.length; q += 2){ if(a[q] === c.id) continue; const o = chains[a[q]], i = a[q + 1]; if(Math.hypot(o.X[i] - x, o.Z[i] - z) < 15) return true; } }
    return false;
  }
  function findFreeEnds(){
    for(const c of chains){ c.free = [];
      for(const [e, dir] of [[0, -1], [c.n - 1, 1]]){
        let sk = false; for(let q = Math.max(0, e - 4); q <= Math.min(c.n - 1, e + 4); q++) if(c.skip[q]) sk = true;
        if(sk || c.n < 6) continue;
        if(nearOther(c, c.X[e], c.Z[e])) continue;
        c.free.push({ i: e, dir, x: c.X[e], z: c.Z[e], tx: c.tx[e] * dir, tz: c.tz[e] * dir, hw: Math.max(c.hl, c.hr) + 0.6 }); } }
  }
  function endWall(x, z){
    if(!ready) return false;
    for(const c of chains){ if(!c.free || !c.free.length) continue;
      for(const f of c.free){ const dx = x - f.x; if(dx > 60 || dx < -60) continue; const dz = z - f.z; if(dz > 60 || dz < -60) continue;
        const al = dx * f.tx + dz * f.tz, lat = Math.abs(-dx * f.tz + dz * f.tx); if(al > 0.2 && al < 9 && lat < f.hw + 2) return true; } }
    return false;
  }
  /* 出発地: (x, z) に近い本線（長い鎖）上の点を、進行方向（down=下り(西行き) / up=上り(東行き)）に合わせて返す。車線は左（左側通行） */
  function spawn(x, z, dir, lane){
    if(!ready) return null; let best = null, bd = 1e12;
    for(const c of chains){ if(c.kind !== "main" || c.L < 10000) continue;
      const west = c.X[c.n - 1] < c.X[0]; if((dir === "down") !== west) continue;
      for(let i = 0; i < c.n; i += 4){ if(c.skip[i] || c.tn[i]) continue; const d = (c.X[i] - x) ** 2 + (c.Z[i] - z) ** 2; if(d < bd){ bd = d; best = [c, i]; } } }
    if(!best) return null; const [c, i0] = best; let bi = i0, b2 = 1e12;
    for(let i = Math.max(0, i0 - 4); i <= Math.min(c.n - 1, i0 + 4); i++){ if(c.skip[i]) continue; const d = (c.X[i] - x) ** 2 + (c.Z[i] - z) ** 2; if(d < b2){ b2 = d; bi = i; } }
    const N = c.sec.N, lw = c.sec.lw, ln = lane === undefined ? 0 : lane, u = -lw * (N - 1) / 2 + ln * lw;
    const p = P(c, bi, u, 0);
    return { x: p[0], z: p[2], y: p[1], yaw: Math.atan2(c.tx[bi], c.tz[bi]), c, i: bi, dist: Math.sqrt(bd) };
  }
  /* いちばん近い車線の中央（救済用）: maxd m 以内 */
  function nearestLane(x, z, yref, maxd){
    if(!ready) return null; const R = Math.ceil((maxd || 80) / GC); const cx = Math.floor(x / GC), cz = Math.floor(z / GC); let best = null, bd = (maxd || 80) ** 2;
    for(let dx = -R; dx <= R; dx++) for(let dz = -R; dz <= R; dz++){ const a = grid.get((cx + dx) * 100003 + (cz + dz)); if(!a) continue;
      for(let q = 0; q < a.length; q += 2){ const c = chains[a[q]], i = a[q + 1]; if(c.tn[i] && false) continue;
        const N = c.sec.N, lw = c.sec.lw; for(let ln = 0; ln < N; ln++){ const u = -lw * (N - 1) / 2 + ln * lw, p = P(c, i, u, 0);
          if(yref !== undefined && Math.abs(p[1] - yref) > 12) continue; const d = (p[0] - x) ** 2 + (p[2] - z) ** 2; if(d < bd){ bd = d; best = { x: p[0], z: p[2], y: p[1], yaw: Math.atan2(c.tx[i], c.tz[i]), dist: Math.sqrt(d) }; } } } }
    return best;
  }
  /* ---------- 幾何 ---------- */
  const bankAt = (c, i, u) => (C0 - c.e[i]) * u;
  function P(c, i, u, dy){ return [c.X[i] + c.rx[i] * u, c.Y[i] + bankAt(c, i, u) + (dy || 0), c.Z[i] + c.rz[i] * u]; }
  function fracPoint(c, f){   // 小数の点番号 f での (x, y, z, rx, rz, tx, tz, e)
    f = clamp(f, 0, c.n - 1); const i = Math.min(c.n - 2, Math.floor(f)), t = f - i, j = i + 1, L = (a, b) => a + (b - a) * t;
    let rx = L(c.rx[i], c.rx[j]), rz = L(c.rz[i], c.rz[j]); const l = Math.hypot(rx, rz) || 1; rx /= l; rz /= l;
    return { x: L(c.X[i], c.X[j]), y: L(c.Y[i], c.Y[j]), z: L(c.Z[i], c.Z[j]), rx, rz, tx: rz, tz: -rx, e: L(c.e[i], c.e[j]) };
  }
  /* 路面の高さ・種類（車・ヘリ・歩行者から）。(x, z) が道路の上（路面 + 路肩 + 中央帯）なら { y, u, c, i, side } を返す */
  function roadAt(x, z, yref, strict, exceptId){
    if(!ready) return null;
    const cx = Math.floor(x / GC), cz = Math.floor(z / GC); let best = null, bd = 1e9;
    for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){
      const a = grid.get((cx + dx) * 100003 + (cz + dz)); if(!a) continue;
      for(let q = 0; q < a.length; q += 2){
        if(a[q] === exceptId) continue;
        const c = chains[a[q]], i = a[q + 1], j = i + 1 < c.n ? i + 1 : i - 1; if(j < 0) continue;
        const ax = c.X[i], az = c.Z[i], bx = c.X[j], bz = c.Z[j], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / l2; if(t < -0.25 || t > 1.25) continue; t = clamp(t, 0, 1);   // 区間の外の点は、その隣の区間が受け持つ（遠い点との横ずれの誤判定を防ぐ）
        const px = ax + vx * t, pz = az + vz * t, rx = c.rx[i] + (c.rx[j] - c.rx[i]) * t, rz = c.rz[i] + (c.rz[j] - c.rz[i]) * t, rl = Math.hypot(rx, rz) || 1;
        const u = ((x - px) * rx + (z - pz) * rz) / rl, along = ((x - px) * vx + (z - pz) * vz) / Math.sqrt(l2);
        if(Math.abs(along) > 0.01 && ((t === 0 && i === 0) || (t === 1 && j === c.n - 1)) && Math.abs(along) > 1.0) continue;   // 端より先は道路ではない
        const gp = c.gap[i], hr = c.hr + (!strict && gp > 0 ? Math.max(0, gp / 2 - c.hr) : 0);
        if(u < -c.hl - 0.2 || u > hr + 0.2) continue;
        const y = c.Y[i] + (c.Y[j] - c.Y[i]) * t + (C0 - (c.e[i] + (c.e[j] - c.e[i]) * t)) * u;
        const d = yref === undefined ? -y : Math.abs(y - yref);
        if(d < bd){ bd = d; best = { y, u, c, i, side: u < 0 ? -1 : 1, t }; }
      }
    }
    return best;
  }
  function deckAt(x, z, yref){ const r = roadAt(x, z, yref); return r ? r.y : NaN; }
  // 道路のわきの壁（ガードレール・遮音壁）の外か（車はそこから先へ出られない）。道路の端から 4m 以内の外側を見る
  function wallAt(x, z, yref, dbg){
    if(!ready) return false; if(endWall(x, z)) return true;
    const cx = Math.floor(x / GC), cz = Math.floor(z / GC);
    for(let dx = -1; dx <= 1; dx++) for(let dz = -1; dz <= 1; dz++){
      const a = grid.get((cx + dx) * 100003 + (cz + dz)); if(!a) continue;
      for(let q = 0; q < a.length; q += 2){
        const c = chains[a[q]], i = a[q + 1], j = i + 1 < c.n ? i + 1 : i - 1; if(j < 0) continue;
        if(c.tn[i]) { /* トンネルの壁 */ }
        const ax = c.X[i], az = c.Z[i], vx = c.X[j] - ax, vz = c.Z[j] - az, l2 = vx * vx + vz * vz || 1;
        const t0 = ((x - ax) * vx + (z - az) * vz) / l2; if(t0 < -0.25 || t0 > 1.25) continue; const t = clamp(t0, 0, 1), px = ax + vx * t, pz = az + vz * t, rx = c.rx[i], rz = c.rz[i];
        const u = (x - px) * rx + (z - pz) * rz, y = c.Y[i] + (c.Y[j] - c.Y[i]) * t;
        if(yref !== undefined && Math.abs(y - yref) > 6) continue;
        const rEdge = c.hr + 0.35, lEdge = c.hl + 0.35;
        if((u < -lEdge && u > -lEdge - 3.5) || (u > rEdge && u < rEdge + 3.5)){ if(roadAt(x, z, yref === undefined ? y : yref, true, c.id)) continue; return dbg ? { c: c.id, i, u: +u.toFixed(1), y: +y.toFixed(1), hr: c.hr, hl: c.hl, gap: c.gap[i], kind: c.kind } : true; }
      }
    }
    return false;
  }
  /* ---------- 材質 ---------- */
  function mats(){
    if(M) return M;
    const tex = (w, h, f, rep) => { const t = canvasTex(w, h, f); if(rep){ t.wrapS = t.wrapT = THREE.RepeatWrapping; } else { t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; } return t; };
    const road = n => { const sec = n === 1 ? { N: 1, lw: 4.5, SL: 1.0, SR: 0.8 } : n === 2 ? { N: 2, lw: 3.5, SL: 2.5, SR: 1.0 } : { N: 3, lw: 3.5, SL: 2.5, SR: 1.0 };
      return tex(512, 512, (g, w, h) => {
        const W = sec.SL + sec.N * sec.lw + sec.SR, pm = w / W, lenV = 20, pv = h / lenV;
        noise(g, w, h, "#47484a", 0.10, 14000);
        g.fillStyle = "rgba(255,255,255,0.045)"; g.fillRect(0, 0, sec.SL * pm, h); g.fillRect((sec.SL + sec.N * sec.lw) * pm, 0, sec.SR * pm, h);   // 路肩はやや明るい
        for(let k = 0; k < sec.N; k++){ const cx = (sec.SL + (k + 0.5) * sec.lw) * pm; for(const o of [-0.85, 0.85]){ const gr = g.createLinearGradient((cx + o * pm) - 0.45 * pm, 0, (cx + o * pm) + 0.45 * pm, 0); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(0.5, "rgba(0,0,0,0.20)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect((cx + o * pm) - 0.45 * pm, 0, 0.9 * pm, h); } }   // わだち
        for(let i = 0; i < 40; i++){ g.strokeStyle = `rgba(15,15,15,${0.12 + Math.random() * 0.1})`; g.lineWidth = 1 + Math.random() * 1.5; g.beginPath(); const x0 = Math.random() * w, y0 = Math.random() * h; g.moveTo(x0, y0); g.lineTo(x0 + (Math.random() - 0.5) * 60, y0 + (Math.random() - 0.5) * 80); g.stroke(); }
        g.fillStyle = "#f1f1ec";
        const lx = (m_) => (sec.SL + m_) * pm;
        g.fillRect(lx(0) - 0.08 * pm, 0, 0.16 * pm, h); g.fillRect(lx(sec.N * sec.lw) - 0.08 * pm, 0, 0.16 * pm, h);                              // 路側帯・中央側の実線
        for(let k = 1; k < sec.N; k++) for(let d = 0; d < 1; d++){ g.fillRect(lx(k * sec.lw) - 0.08 * pm, 0, 0.16 * pm, 8 * pv); }                  // 車線境界の破線（8m 引いて 12m 空ける）
        const gr2 = g.createLinearGradient(0, 0, 0, h); gr2.addColorStop(0, "rgba(0,0,0,0)"); gr2.addColorStop(1, "rgba(0,0,0,0)");
      }); };
    const noiseTex = (base, amp, n) => tex(128, 128, (g, w, h) => noise(g, w, h, base, amp, n), true);
    const lam = (o) => new THREE.MeshLambertMaterial(o);
    M = {
      road: [null, road(1), road(2), road(3)].map(t => t ? lam({ map: t }) : null),
      verge: lam({ map: noiseTex("#6a8a49", 0.22, 4500), side: THREE.DoubleSide }),
      slope: lam({ map: noiseTex("#718a4d", 0.28, 5500), vertexColors: true, side: THREE.DoubleSide }),
      conc: lam({ color: 0xbdbbb4, side: THREE.DoubleSide }), concDark: lam({ color: 0xa5a39d, side: THREE.DoubleSide }),
      rail: lam({ color: 0xcfd3d6, side: THREE.DoubleSide }), post: lam({ color: 0xa9adb0 }), pole: lam({ color: 0x9aa0a4 }),
      refl: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: false }), barrier: lam({ color: 0xd9d9d4 }), barrierRed: lam({ color: 0xc8302a }), reflO: new THREE.MeshBasicMaterial({ color: 0xff9a2a }),
      tube: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      lampStrip: new THREE.MeshBasicMaterial({ color: 0xfff0c8, side: THREE.DoubleSide }),
      lampHead: new THREE.MeshBasicMaterial({ color: 0xfff3d6 }),
      glow: new THREE.PointsMaterial({ map: canvasTex(64, 64, (c, w, h) => { const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.08, "rgba(255,255,255,0.9)"); gr.addColorStop(0.2, "rgba(255,255,255,0.28)"); gr.addColorStop(0.5, "rgba(255,255,255,0.06)"); gr.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = gr; c.fillRect(0, 0, w, h); }), size: 5.0, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true, opacity: 0 }),
    };
    M.road[1].userData.base = 1;
    M.roadTn = {}; for(const n of [1, 2, 3]) M.roadTn[n] = new THREE.MeshBasicMaterial({ map: M.road[n].map, color: new THREE.Color(1.7, 1.7, 1.65), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });   // トンネル内は照明で昼夜とも明るい
    return M;
  }
  /* ---------- 地面（地形）の高さ ---------- */
  const ground = (x, z) => { const o = Outer.h(x, z); if(!isNaN(o)) return o; return Heli.farH(x, z); };
  /* ---------- チャンクの組み立て ---------- */
  const mkB = () => ({ p: [], uv: [], c: [], ix: [] });
  function strip(B, rows, uvf, colf){            // rows: 行（点）ごとの [x,y,z] の列。全行の列数は同じ
    const nc = rows[0].length, base = B.p.length / 3;
    for(let r = 0; r < rows.length; r++) for(let k = 0; k < nc; k++){ const v = rows[r][k]; B.p.push(v[0], v[1], v[2]); if(uvf){ const t = uvf(r, k, v); B.uv.push(t[0], t[1]); } if(colf){ const t = colf(r, k, v); B.c.push(t[0], t[1], t[2]); } }
    for(let r = 0; r < rows.length - 1; r++) for(let k = 0; k < nc - 1; k++){ const a = base + r * nc + k, b = a + 1, c_ = a + nc, d = c_ + 1; B.ix.push(a, b, c_, b, d, c_); }
  }
  function mesh(B, mat, opt){
    if(!B.ix.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(B.p, 3));
    if(B.uv.length) g.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2));
    if(B.c.length) g.setAttribute("color", new THREE.Float32BufferAttribute(B.c, 3));
    g.setIndex(B.ix); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); if(opt && opt.shadow) m.receiveShadow = true; if(opt && opt.cast) m.castShadow = true; return m;
  }
  function inst(geo, mat, list){   // list: [x, y, z, 回転(Y), sx, sy, sz]
    if(!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for(let k = 0; k < list.length; k++){ const a = list[k]; q.setFromAxisAngle(up, a[3]); s.set(a[4], a[5], a[6]); p.set(a[0], a[1], a[2]); m4.compose(p, q, s); im.setMatrixAt(k, m4); }
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; return im;
  }
  const BOX = new THREE.BoxGeometry(1, 1, 1); BOX.translate(0, 0.5, 0);   // 底が y=0 の単位の箱
  const rotOf = (c, i) => Math.atan2(-c.rz[i], c.rx[i]);                    // 箱の x 軸を「右」へ向ける Y 回転
  const hash = (a, b) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };
  function buildChunk(c, k){
    const mt = mats(), i0 = k * CH, i1 = Math.min(c.n - 1, i0 + CH), g = new THREE.Group(), sec = c.sec, N = sec.N;
    g.name = "mw_" + c.id + "_" + k;
    const add = (m) => { if(m) g.add(m); };
    const runs = (pred, minLen) => { const out = []; let a = -1; for(let i = i0; i <= i1 + 1; i++){ const ok = i <= i1 && pred(i); if(ok && a < 0) a = i; if(!ok && a >= 0){ if(i - a >= (minLen || 2)) out.push([a, i - 1]); a = -1; } } return out; };
    const pairAt = (i) => c.gap[i] > 0 && c.gap[i] / 2 > c.hr + 0.3;
    const posts = [], pil = [], pilCap = [], refl = [], reflO = [], poles = [], arms = [], heads = [], glowP = [], glowC = [];
    // --- 路面 ---
    { const B = mkB(); for(const [a, b] of runs(i => !c.skip[i])){ const rows = []; for(let i = a; i <= b; i++) rows.push([P(c, i, -c.hl), P(c, i, c.hr)]); strip(B, rows, (r, kk) => [kk, (a + r) * c.ds / 20]); }
      add(mesh(B, mt.road[N], { shadow: true })); }
    { const B = mkB(); for(const [a, b] of runs(i => !c.skip[i] && c.tn[i])){ const rows = []; for(let i = a; i <= b; i++) rows.push([P(c, i, -c.hl, 0.004), P(c, i, c.hr, 0.004)]); strip(B, rows, (r, kk) => [kk, (a + r) * c.ds / 20]); }
      add(mesh(B, mt.roadTn[N])); }
    // --- 中央帯（上下線の間） ---
    { const B = mkB(); for(const [a, b] of runs(i => !c.skip[i] && !c.br[i] && !c.tn[i] && pairAt(i))){ const rows = []; for(let i = a; i <= b; i++) rows.push([P(c, i, c.hr - 0.02, -0.03), P(c, i, c.gap[i] / 2, -0.03)]); strip(B, rows, (r, kk, v) => [v[0] / 5, v[2] / 5]); }
      add(mesh(B, mt.verge, { shadow: true })); }
    // --- 斜面（盛土・切土）: 道路の端から、地形（山陽道沿いは道路に合わせて掘ってある）まで ---
    { const B = mkB(); const sx = hash(c.id, k);
      for(const side of [-1, 1]){
        const rr = []; const pend = () => { if(rr.length > 1) strip(B, rr.map(q => q.row), (r, kk, v) => [v[0] / 6, v[2] / 6], (r, kk) => { const q = rr[r]; const f = 0.9 + 0.2 * hash(Math.floor(rr[r].x / 9), Math.floor(rr[r].z / 9)); return q.cut ? (kk === 0 ? [0.80 * f, 0.76 * f, 0.66 * f] : [0.70 * f, 0.66 * f, 0.56 * f]) : [0.95 * f, 1.05 * f, 0.88 * f]; }); rr.length = 0; };
        for(let i = i0; i <= i1; i++){
          const ok = !c.skip[i] && !c.br[i] && !c.tn[i] && !(side > 0 && pairAt(i));
          if(!ok){ pend(); continue; }
          const ue = side < 0 ? -c.hl - 0.2 : c.hr + 0.2, yE = c.Y[i] + (C0 - c.e[i]) * ue - 0.10;
          const gx = (t) => c.X[i] + c.rx[i] * (ue + side * t), gz = (t) => c.Z[i] + c.rz[i] * (ue + side * t);
          const cut = ground(gx(3), gz(3)) > yE + 0.4, sl = cut ? 0.714 : -0.5556; let ts = 3;
          for(let t = 1.5; t <= 42; t += 1.5){ const ys = yE + sl * t, g_ = ground(gx(t), gz(t)); ts = t; if(cut ? ys >= g_ : ys <= g_) break; }
          ts = Math.max(3, ts); const row = [];
          for(let q = 0; q < 4; q++){ const t = ts * q / 3, x = gx(t), z = gz(t); let y = yE + sl * t; if(q === 3){ const g_ = ground(x, z); y = cut ? Math.min(y, g_ + 0.05) : Math.max(y, g_ - 0.4); } row.push([x, y, z]); }
          rr.push({ row, cut, x: c.X[i], z: c.Z[i] });
        }
        pend();
      }
      add(mesh(B, mt.slope, { shadow: true })); }
    // --- 防護柵（ガードレール）・中央分離帯のコンクリート壁 ---
    { const B = mkB(), BC = mkB();
      for(const side of [-1, 1]){
        const rr = [];
        const okf = (i) => !c.skip[i] && !c.br[i] && !c.tn[i] && (side < 0 || !pairAt(i) || (c.gap[i] / 2 - c.hr >= 3.0));
        for(const [a, b] of runs(okf)){
          const uo = side < 0 ? -c.hl - 0.35 : (pairAt(a) ? c.hr + 0.35 : c.hr + 0.35), rows = [];
          for(let i = a; i <= b; i++){ const u = side < 0 ? -c.hl - 0.35 : c.hr + 0.35; rows.push([P(c, i, u, 0.46), P(c, i, u, 0.80)]); }
          strip(B, rows, null, null);
          // 柱（4m おき）
          const L = (b - a) * c.ds; for(let s = 0; s <= L; s += 4){ const f = a + s / c.ds, q = fracPoint(c, f), u = side < 0 ? -c.hl - 0.35 : c.hr + 0.35, y = q.y + (C0 - q.e) * u; posts.push([q.x + q.rx * u, y, q.z + q.rz * u, Math.atan2(-q.rz, q.rx), 0.12, 0.84, 0.12]); }
        }
      }
      // 中央分離帯の壁（それぞれ自分の側の半分）
      for(const [a, b] of runs(i => !c.skip[i] && !c.br[i] && !c.tn[i] && pairAt(i) && (c.gap[i] / 2 - c.hr < 3.0))){
        const rows = []; for(let i = a; i <= b; i++){ const hm = c.gap[i] / 2; rows.push([P(c, i, hm - 0.26, 0), P(c, i, hm - 0.12, 0.82), P(c, i, hm, 0.82), P(c, i, hm, 0)]); }
        strip(BC, rows, null, null);
      }
      add(mesh(B, mt.rail)); add(mesh(BC, mt.conc, { cast: false }));
      const ip = inst(BOX, mt.post, posts); add(ip); }
    // --- 橋: 高欄・桁・橋脚 ---
    { const BP = mkB(), BG = mkB();
      for(const [a, b] of runs(i => !c.skip[i] && c.br[i] && !c.tn[i])){
        for(const side of [-1, 1]){
          const rows = []; for(let i = a; i <= b; i++){ const eu = side < 0 ? -c.hl : c.hr, iu = eu - side * 0.38; rows.push([P(c, i, eu, 0), P(c, i, eu, 1.05), P(c, i, iu, 1.05), P(c, i, iu, 0)]); }
          strip(BP, rows, null, null);
        }
        const rg = []; for(let i = a; i <= b; i++) rg.push([P(c, i, -c.hl, -0.05), P(c, i, -c.hl + 0.55, -1.9), P(c, i, c.hr - 0.55, -1.9), P(c, i, c.hr, -0.05)]);
        strip(BG, rg, null, null);
        for(let i = a + 3; i <= b - 3; i += 8){ const gh = ground(c.X[i], c.Z[i]), yb = c.Y[i] - 1.9 - 0.05 + bankAt(c, i, 0);
          if(gh + 0.5 < yb){ const h = yb - (gh - 0.5), rot = rotOf(c, i); pil.push([c.X[i], gh - 0.5, c.Z[i], rot, 2.4, h, 1.6]); pilCap.push([c.X[i], yb - 1.0, c.Z[i], rot, c.hl + c.hr - 0.9, 1.0, 2.0]); } }
      }
      add(mesh(BP, mt.conc, { cast: false })); add(mesh(BG, mt.concDark));
      add(inst(BOX, mt.concDark, pil)); add(inst(BOX, mt.concDark, pilCap)); }
    // --- トンネル: 内面（アーチ）・照明・坑口 ---
    { const TB = mkB(), LS = mkB(), PF = mkB(); const uc = (c.hr - c.hl) / 2, Wt = (c.hl + c.hr) / 2 + 0.6, Hw = 3.6, Hr = 3.8, J = 16;
      const prof = []; prof.push([-Wt, 0]); for(let j = 0; j <= J; j++){ const th = Math.PI * j / J; prof.push([-Wt * Math.cos(th), Hw + Hr * Math.sin(th)]); } prof.push([Wt, 0]);
      const colOf = (h, i) => { const f = 0.97 + 0.03 * ((i >> 1) & 1); return h < 2.3 ? [0.82 * f, 0.82 * f, 0.80 * f] : [0.74 * f, 0.73 * f, 0.69 * f]; };
      for(const [a, b] of runs(i => !c.skip[i] && c.tn[i])){
        const rows = []; for(let i = a; i <= b; i++) rows.push(prof.map(q => P(c, i, uc + q[0], q[1])));
        strip(TB, rows, null, (r, kk) => colOf(prof[kk][1], a + r));
        // 照明: 10m おきに 3m の帯を左右 2 列
        for(let i = a; i + 1 <= b; i += 2) for(const sgn of [-1, 1]){ const u = uc + sgn * 2.8, h = Hw + Hr * Math.sqrt(Math.max(0, 1 - (2.8 / Wt) ** 2)) - 0.12, p0 = P(c, i, u - 0.18, h), p1 = P(c, i, u + 0.18, h), p2 = P(c, Math.min(c.n - 1, i + 1), u + 0.18, h), p3 = P(c, Math.min(c.n - 1, i + 1), u - 0.18, h);
          const v0 = LS.p.length / 3; for(const p of [p0, p1, p2, p3]) LS.p.push(p[0], p[1], p[2]); LS.ix.push(v0, v0 + 1, v0 + 3, v0 + 1, v0 + 2, v0 + 3); }
        // 坑口の枠
        for(const [ip, dir] of [[a, -1], [b, 1]]){ const real = dir < 0 ? (ip > 0 && !c.tn[ip - 1]) : (ip < c.n - 1 && !c.tn[ip + 1]); if(!real) continue;
          const gi = ground(P(c, ip, uc, 0)[0], P(c, ip, uc, 0)[2]), gj = (() => { const q = P(c, Math.max(0, Math.min(c.n - 1, ip - dir * 2)), uc, 0); return ground(q[0], q[2]); })(), yr = P(c, ip, uc, 0)[1];
          const sh = new THREE.Shape(); const Wp = Wt + 4.2, Ht = Math.max(9.6, Math.min(26, Math.max(gi, gj) - yr + 1.6)); sh.moveTo(-Wp, -1.2); sh.lineTo(Wp, -1.2); sh.lineTo(Wp, Ht); sh.lineTo(-Wp, Ht); sh.lineTo(-Wp, -1.2);
          const hole = new THREE.Path(); hole.moveTo(prof[0][0], 0); for(const q of prof) hole.lineTo(q[0], q[1]); sh.holes.push(hole);
          const sg = new THREE.ShapeGeometry(sh), pa = sg.attributes.position, ix = sg.index.array, v0 = PF.p.length / 3, off = 0.06 * dir;
          for(let q = 0; q < pa.count; q++){ const p = P(c, ip, uc + pa.getX(q), pa.getY(q)); PF.p.push(p[0] + c.tx[ip] * off, p[1], p[2] + c.tz[ip] * off); }
          for(let q = 0; q < ix.length; q++) PF.ix.push(v0 + ix[q]); sg.dispose();
          // 坑口の壁に奥行き（上と左右の面を、トンネルの奥へ 8m）。山の斜面に埋まって「薄い板」に見えないように
          { const L8 = 12, A = [-Wp, -1.2], Bq = [Wp, -1.2], Cq = [Wp, Ht], Dq = [-Wp, Ht], v1 = PF.p.length / 3;
            for(const q of [A, Bq, Cq, Dq]){ const p = P(c, ip, uc + q[0], q[1]); PF.p.push(p[0] + c.tx[ip] * off, p[1], p[2] + c.tz[ip] * off); }
            for(const q of [A, Bq, Cq, Dq]){ const p = P(c, ip, uc + q[0], q[1]); PF.p.push(p[0] - c.tx[ip] * dir * L8, p[1], p[2] - c.tz[ip] * dir * L8); }
            PF.ix.push(v1 + 3, v1 + 2, v1 + 6, v1 + 3, v1 + 6, v1 + 7,  v1 + 0, v1 + 3, v1 + 7, v1 + 0, v1 + 7, v1 + 4,  v1 + 1, v1 + 2, v1 + 6, v1 + 1, v1 + 6, v1 + 5); } }
      }
      add(mesh(TB, mt.tube)); add(mesh(LS, mt.lampStrip)); add(mesh(PF, mt.conc)); }
    // --- 行き止まりの車止め ---
    if(c.free) for(const f of c.free){ if(f.i < i0 || f.i > i1) continue; const rot = rotOf(c, f.i), q = fracPoint(c, f.i), bx = f.x + f.tx * 0.6, bz = f.z + f.tz * 0.6, w = f.hw * 2 + 1.2;
      const ba = [], br = []; ba.push([bx, q.y + 0.0, bz, rot, w, 1.0, 0.3]); br.push([bx + f.tx * 0.2, q.y + 0.35, bz + f.tz * 0.2, rot, w + 0.02, 0.3, 0.32]);
      add(inst(BOX, mt.barrier, ba)); add(inst(BOX, mt.barrierRed, br)); }
    // --- 視線誘導標（反射板）---
    for(let s = 0; ; s += 50){ const f = i0 + s / c.ds; if(f > i1) break; const i = Math.round(f); if(c.skip[i] || c.tn[i]) continue; const q = fracPoint(c, f);
      let u = -c.hl - 0.05; refl.push([q.x + q.rx * u, q.y + (C0 - q.e) * u + (c.br[i] ? 1.05 : 0.0), q.z + q.rz * u, Math.atan2(-q.rz, q.rx), 0.09, 0.42, 0.09]);
      if(!pairAt(i)) { u = c.hr + 0.05; reflO.push([q.x + q.rx * u, q.y + (C0 - q.e) * u + (c.br[i] ? 1.05 : 0.0), q.z + q.rz * u, Math.atan2(-q.rz, q.rx), 0.09, 0.42, 0.09]); } }
    add(inst(BOX, mt.refl, refl)); add(inst(BOX, mt.reflO, reflO));
    // --- 照明柱: IC・JCT・PA/SA の前後 ---
    for(const ic of (man.ic || [])){ if(ic.c !== c.id) continue; const lo = Math.max(i0, ic.i - 90), hi = Math.min(i1, ic.i + 90);
      for(let i = Math.ceil(lo / 8) * 8; i <= hi; i += 8){ if(c.skip[i] || c.tn[i]) continue; const u = -c.hl - 0.7, p = P(c, i, u, 0), rot = rotOf(c, i);
        poles.push([p[0], p[1], p[2], rot, 0.22, 10.2, 0.22]); const ax = p[0] + c.rx[i] * 1.3, az = p[2] + c.rz[i] * 1.3;
        arms.push([ax, p[1] + 10.1, az, rot, 2.7, 0.16, 0.16]); const hx = p[0] + c.rx[i] * 2.5, hz = p[2] + c.rz[i] * 2.5;
        heads.push([hx, p[1] + 9.98, hz, rot, 1.0, 0.16, 0.45]); glowP.push(hx, p[1] + 9.9, hz); glowC.push(1.0, 0.92, 0.78); } }
    add(inst(BOX, mt.pole, poles)); add(inst(BOX, mt.pole, arms)); add(inst(BOX, mt.lampHead, heads));
    if(glowP.length){ const gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(glowP, 3)); gg.setAttribute("color", new THREE.Float32BufferAttribute(glowC, 3)); const pts = new THREE.Points(gg, mt.glow); pts.userData.glow = true; pts.frustumCulled = false; g.add(pts); }
    g.traverse(o => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    return g;
  }
  function disposeChunk(g){ g.traverse(o => { if(o.geometry) o.geometry.dispose(); if(o.isInstancedMesh) o.dispose(); }); }
  /* ---------- 読み込み・解放 ---------- */
  function tick(cam, force){
    if(!ready){ if(!started){ started = true; init(); } return; }
    const now = performance.now(); if(!force && now - lastT < 250) return; lastT = now;
    const x = cam.x, z = cam.z; let built = 0; const want = [];
    for(const c of chains){
      if(!c.cc){ c.cc = []; for(let k = 0; k < c.nch; k++){ const a = k * CH, b = Math.min(c.n - 1, a + CH), m = (a + b) >> 1; c.cc.push([c.X[m], c.Z[m], Math.hypot(c.X[a] - c.X[b], c.Z[a] - c.Z[b]) / 2 + 20]); } }
      // 粗い判定: 鎖の外接円
      for(let k = 0; k < c.nch; k++){ const q = c.cc[k], d = Math.hypot(q[0] - x, q[1] - z) - q[2], key = c.id + "_" + k;
        if(d < R_BUILD && !live.has(key)) want.push([d, c, k, key]);
        else if(d > R_DROP && live.has(key)){ const g = live.get(key); scene.remove(g); disposeChunk(g); live.delete(key); } }
    }
    want.sort((a, b) => a[0] - b[0]);
    const lim = force ? 12 : 2, t0 = performance.now();
    for(const [d, c, k, key] of want){ if(built >= lim || (!force && performance.now() - t0 > 9)) break; const g = buildChunk(c, k); live.set(key, g); scene.add(g); built++; }
    const night = Env.NIGHT_U.value; mats().glow.opacity = night; mats().glow.visible = night > 0.2;
  }
  return { init, tick, info, get ready(){ return ready; }, roadAt, deckAt, wallAt, endWall, spawn, nearestLane, mats, chains, get man(){ return man; }, get live(){ return live; }, fracPoint, P, ground };
})();

/* ---------------- 山陽道の交通（v37）: 本線を、車線を守って走る乗用車・トラック ---------------- */
const MWT = (() => {
  const MAXN = 90, RW = 1100, C0 = 0.015, DENS = 1 / 150;
  const cars = []; const lastP = [1e9, 1e9]; let imC = null, imT = null, imL = null, built = false, tU = 0, tScan = 0, first = true, lightN = -1, mains = null;
  const player = { c: null, s: 0, lane: -1, on: false };
  const rnd = (a, b) => a + Math.random() * (b - a);
  function merge(gs){ const P = [], Nn = [], I = []; let o = 0; for(const g of gs){ const p = g.attributes.position.array, n = g.attributes.normal.array, ix = g.index.array; for(let k = 0; k < p.length; k++){ P.push(p[k]); Nn.push(n[k]); } for(let k = 0; k < ix.length; k++) I.push(ix[k] + o); o += p.length / 3; }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(Nn, 3)); g.setIndex(I); return g; }
  const box = (w, h, l, x, y, z) => { const g = new THREE.BoxGeometry(w, h, l); g.translate(x, y, z); return g; };
  function build(){
    const gCar = merge([box(1.75, 0.72, 4.4, 0, 0.62, 0), box(1.52, 0.52, 2.35, 0, 1.24, -0.15), box(1.78, 0.18, 4.42, 0, 0.3, 0)]);
    const gTruck = merge([box(2.5, 2.9, 7.4, 0, 2.0, -1.2), box(2.4, 2.1, 2.2, 0, 1.55, 3.6), box(2.5, 0.5, 9.4, 0, 0.55, 0)]);
    const mk = (g, n) => { const m = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff }), n); m.setColorAt(0, new THREE.Color(1, 1, 1)); m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.castShadow = false; scene.add(m); return m; };
    imC = mk(gCar, MAXN); imT = mk(gTruck, 40);
    imL = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.14, 0.08), new THREE.MeshBasicMaterial({ color: 0xffffff }), (MAXN + 40) * 4); imL.setColorAt(0, new THREE.Color(1, 0, 0)); imL.count = 0; imL.frustumCulled = false; imL.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(imL);
    built = true;
  }
  const COL = [0xf2f2f0, 0xd8d8d8, 0x2a2d33, 0x9aa0a8, 0xb23a32, 0x2c4f8a, 0xe8e2cf, 0x4c5a48, 0x1c1c1e, 0xc9c9cc];
  function mains_(){ if(!mains) mains = MW.chains.filter(c => c.kind === "main" && c.L > 10000); return mains; }
  function laneU(c, ln){ return -c.sec.lw * (c.sec.N - 1) / 2 + ln * c.sec.lw; }
  function spawnOne(c, s, near){
    const f = s / c.ds; if(f < 3 || f > c.n - 4 || c.skip[Math.round(f)]) return false;
    const truck = Math.random() < 0.28, ln = truck ? 0 : (Math.random() < 0.5 ? 0 : c.sec.N - 1 - (Math.random() < 0.25 && c.sec.N > 2 ? 1 : 0));
    for(const o of cars) if(o.c === c && o.lane === ln && Math.abs(o.s - s) < 38) return false;
    if(player.on && player.c === c && Math.abs(player.s - s) < 60) return false;
    const L = truck ? 9.4 : 4.4, vmax = (truck ? rnd(21, 23.5) : (ln === 0 ? rnd(22, 27) : rnd(26, 29.5)));
    cars.push({ c, s, lane: ln, v: near ? vmax * rnd(0.85, 1) : vmax, vmax, truck, l: L, w: truck ? 2.5 : 1.78, col: new THREE.Color(truck ? COL[(Math.random() * 2) | 0] : COL[(Math.random() * COL.length) | 0]), x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dx: 0, dz: 1, brake: 0, type: { name: truck ? "truck" : "car", l: L, w: truck ? 2.5 : 1.78 } });
    return true;
  }
  /* プレイヤーが本線（の車線）のどこにいるか */
  function locate(C){
    player.on = false; const r = MW.roadAt(C.x, C.z, C.h, true); if(!r || r.c.kind !== "main" || r.c.L < 10000) return;
    const c = r.c; const N = c.sec.N, lw = c.sec.lw, ln = Math.round((r.u - laneU(c, 0)) / lw);
    player.on = true; player.c = c; player.s = (r.i + (r.t || 0)) * c.ds; player.lane = (ln >= 0 && ln < N && Math.abs(r.u - laneU(c, ln)) < 2.3) ? ln : -1;
  }
  function update(dt){
    if(!MW.ready) return; if(!built) build();
    const C = Car.C; if(!(S.mode === "car" && C.active)){ imC.visible = imT.visible = imL.visible = false; return; }
    imC.visible = imT.visible = imL.visible = true;
    locate(C);
    tScan -= dt;
    if(tScan <= 0){ tScan = 0.7; if(Math.hypot(C.x - lastP[0], C.z - lastP[1]) > 450) first = true; lastP[0] = C.x; lastP[1] = C.z;
      // プレイヤーに近い本線の点（粗く探す）
      const near = [];
      for(const c of mains_()){ let bd = 1e12, bi = -1; for(let i = 0; i < c.n; i += 4){ const d = (c.X[i] - C.x) ** 2 + (c.Z[i] - C.z) ** 2; if(d < bd){ bd = d; bi = i; } } if(bd < 1500 * 1500) near.push([c, bi * c.ds]); }
      // 遠くなった車は消す
      for(let k = cars.length - 1; k >= 0; k--){ const o = cars[k]; const e = near.find(q => q[0] === o.c); if(!e || Math.abs(o.s - e[1]) > RW + 250) cars.splice(k, 1); }
      for(const [c, sp] of near){
        const have = cars.filter(o => o.c === c).length, want = Math.round(c.sec.N * 2 * RW * DENS * 0.75);
        for(let t = 0, need = want - have; need > 0 && t < 40; t++){ const s = first ? sp + rnd(-RW, RW) : (Math.random() < 0.5 ? sp + rnd(650, RW) : sp - rnd(650, RW)); if(spawnOne(c, s, first)) need--; }
      }
      first = near.length === 0;      // 本線から離れていたら次に近づいた時に全域へ配る
    }
    // 走行
    for(let k = cars.length - 1; k >= 0; k--){ const o = cars[k]; let gap = 1e9, lv = o.vmax;
      for(const q of cars){ if(q === o || q.c !== o.c || q.lane !== o.lane) continue; const d = q.s - o.s - (q.l + o.l) / 2; if(d > -1 && d < gap){ gap = d; lv = q.v; } }
      if(player.on && player.c === o.c && player.lane === o.lane){ const d = player.s - o.s - (Car.P.len + o.l) / 2; if(d > -1 && d < gap){ gap = d; lv = Math.abs(C.v); } }
      const safe = 5 + o.v * 1.5; let vt = o.vmax; if(gap < safe * 2.2) vt = Math.max(0, Math.min(o.vmax, lv + (gap - safe) * 0.45)); if(gap < 3.5) vt = 0;
      const a = Math.max(-7, Math.min(1.8, (vt - o.v) * 0.9)); o.v = Math.max(0, o.v + a * dt); o.brake = a < -1.2 ? 1 : 0; o.s += o.v * dt;
      const c = o.c, f = o.s / c.ds; if(f >= c.n - 3 || f < 2 || c.skip[Math.round(f)] || c.skip[Math.min(c.n - 1, Math.round(f) + 2)]){ cars.splice(k, 1); continue; }
      const q = MW.fracPoint(c, f), u = laneU(c, o.lane), q2 = MW.fracPoint(c, Math.min(c.n - 1, f + 1.2)), q0 = MW.fracPoint(c, Math.max(0, f - 1.2));
      o.x = q.x + q.rx * u; o.z = q.z + q.rz * u; o.y = q.y + (C0 - q.e) * u; o.dx = q.tx; o.dz = q.tz; o.yaw = Math.atan2(q.tx, q.tz);
      const ya = q2.y + (C0 - q2.e) * u, yb = q0.y + (C0 - q0.e) * u; o.pitch = -Math.atan2(ya - yb, Math.hypot(q2.x - q0.x, q2.z - q0.z) || 1); }
    // 描画
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler(0, 0, 0, "YXZ"), sc1 = new THREE.Vector3(1, 1, 1), p3 = new THREE.Vector3(), off = new THREE.Vector3();
    let nc = 0, nt = 0, nl = 0; const night = Env.NIGHT_U.value, lc = new THREE.Color();
    for(const o of cars){
      if(Math.hypot(o.x - camera.position.x, o.z - camera.position.z) > 1300) continue;
      eu.set(o.pitch, o.yaw, 0, "YXZ"); qt.setFromEuler(eu); p3.set(o.x, o.y, o.z); m4.compose(p3, qt, sc1);
      if(o.truck){ if(nt >= 40) continue; imT.setMatrixAt(nt, m4); imT.setColorAt(nt, o.col); nt++; } else { if(nc >= MAXN) continue; imC.setMatrixAt(nc, m4); imC.setColorAt(nc, o.col); nc++; }
      const hy = o.truck ? 0.95 : 0.78, hz = o.l / 2 - 0.04, hx = o.w / 2 - 0.3;
      for(const [zz, red] of [[-hz, 1], [hz, 0]]) for(const sx of [-hx, hx]){ if(nl >= (MAXN + 40) * 4) break; off.set(sx, hy, zz).applyQuaternion(qt).add(p3); m4.compose(off, qt, sc1); imL.setMatrixAt(nl, m4);
        if(red) lc.setRGB(0.45 + 0.55 * night + o.brake * 0.6, 0.02, 0.02); else lc.setRGB(0.55 + 0.45 * night, 0.55 + 0.4 * night, 0.45 + 0.3 * night); imL.setColorAt(nl, lc); nl++; } }
    imC.count = nc; imT.count = nt; imL.count = nl;
    imC.instanceMatrix.needsUpdate = imT.instanceMatrix.needsUpdate = imL.instanceMatrix.needsUpdate = true;
    if(imC.instanceColor) imC.instanceColor.needsUpdate = true; if(imT.instanceColor) imT.instanceColor.needsUpdate = true; if(imL.instanceColor) imL.instanceColor.needsUpdate = true;
  }
  function register(){ if(!(S.mode === "car" && Car.C.active) || !cars.length) return; for(const o of cars){ if(Math.hypot(o.x - Car.C.x, o.z - Car.C.z) > 80) continue; Obs.addBody(o.x, o.z, o.dx, o.dz, o.l, o.w / 2 + 0.1, o, o.y); } }
  function reset(){ cars.length = 0; first = true; tScan = 0; if(imC){ imC.count = imT.count = imL.count = 0; } }
  return { update, register, reset, get cars(){ return cars; }, get count(){ return cars.length; } };
})();


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
  // v35: 節点ごとの法線を、前後左右の節点の標高の差（中央差分）から求める。三角形の面ごとの法線だと斜面で 4m の升目が見えてしまう
  const hs = (j,i)=>{ j=Math.max(0,Math.min(nz-1,j)); i=Math.max(0,Math.min(nx-1,i)); return H[j*nx+i]/100; };
  const smoothNormals = (cells, st)=>{
    const n=cells.length/2, out=new Float32Array(n*18), sp=2*st*g.step; let o=0;
    const put=(jj,ii)=>{ const dx=(hs(jj,ii+st)-hs(jj,ii-st))/sp, dz=(hs(jj+st,ii)-hs(jj-st,ii))/sp, l=Math.hypot(dx,1,dz); out[o++]=-dx/l; out[o++]=1/l; out[o++]=-dz/l; };
    for(let c=0;c<cells.length;c+=2){ const j=cells[c], i=cells[c+1];
      put(j,i); put(j+st,i); put(j,i+st); put(j,i+st); put(j+st,i); put(j+st,i+st); }   // 三角形の頂点の並びは pos と同じ
    return out;
  };
  // v31: 配列を作る所（arrs）と形を作る所（mk）を分けた。形は GPU に送った後に配列を捨て、WebGL が戻った時は arrs で作り直す
  const arrs = (cells, U, V, st)=>{
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
    geo.setAttribute("normal",new THREE.BufferAttribute(smoothNormals(cells, st),3));   // v35: 4m の格子の面ごとの法線（面が見えるギザギザ）をやめ、標高の勾配からなめらかな法線に
    return geo;
  };
  const mk = (cells_, U, V, st)=>{
    const cells = Int32Array.from(cells_);   // 作り直し用に小さく持つ
    const geo = arrs(cells, U, V, st); geo.computeBoundingSphere();
    GeoMem.release(geo, ["position", "uv", "normal"], ()=>{ const t = arrs(cells, U, V, st); return { position: t.attributes.position.array, uv: t.attributes.uv.array, normal: t.attributes.normal.array }; });
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
      { // v31: GPU に送った後に配列を捨てる（WebGL が戻った時は同じ計算で作り直す）
        const wc = Int32Array.from(cells);
        const wgen = ()=>{ const n=wc.length/2, pos=new Float32Array(n*18); let o=0;
          for(let c=0;c<wc.length;c+=2){ const j=wc[c], i=wc[c+1], y=WL[j*nx+i]/100;
            const x0=g.x0+i*g.step, z0=g.z0+j*g.step, x1=x0+g.step, z1=z0+g.step;
            pos.set([x0,lv(j,i,y),z0, x0,lv(j+1,i,y),z1, x1,lv(j,i+1,y),z0, x1,lv(j,i+1,y),z0, x0,lv(j+1,i,y),z1, x1,lv(j+1,i+1,y),z1], o); o+=18; }
          const t=new THREE.BufferGeometry(); t.setAttribute("position", new THREE.BufferAttribute(pos,3));
          const uv=new Float32Array(n*12); for(let q=0;q<n*6;q++){ uv[q*2]=pos[q*3]/18; uv[q*2+1]=pos[q*3+2]/18; } t.setAttribute("uv", new THREE.BufferAttribute(uv,2));
          t.computeVertexNormals(); return { position: pos, uv, normal: t.attributes.normal.array }; };
        GeoMem.release(geo, ["position", "uv", "normal"], wgen);
      }
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
const HIMASK = (() => { const d = new Uint8Array(64 * 64 * 4); const t = new THREE.DataTexture(d, 64, 64, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return { d, t }; })();
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
      sh.fragmentShader.replace("#include <map_fragment>", (far ? `if(vHC.z > 0.5 && texture2D(uHiMask, (floor(vHC.xy * 255.0 + 0.5) + 0.5) / 64.0).r > 0.5) discard;\n` : ``) + `#ifdef USE_MAP
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
  function setMask(key, on){ const [i, j] = key.split("_").map(Number); if(i < 0 || j < 0 || i >= 64 || j >= 64) return; HIMASK.d[(j * 64 + i) * 4] = on ? 255 : 0; HIMASK.t.needsUpdate = true; }
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
    // v31: ここで計算した配列（法線・路面の UV）は GPU に送った後に捨てる。位置などファイルの中を指す配列はそのまま（作り直しの元）
    { const names = []; if(c.nrm===undefined) names.push("normal"); if(c.uvi===undefined && c.uv===undefined && tm) names.push("uv");
      if(names.length) GeoMem.release(geo, names, ()=>{ const out = {};
        if(names.includes("normal")){ const t = new THREE.BufferGeometry(); t.setAttribute("position", new THREE.BufferAttribute(q,3)); t.computeVertexNormals(); out.normal = t.attributes.normal.array; }
        if(names.includes("uv")){ const uv=new Float32Array(c.count*2); for(let i=0;i<c.count;i++){ uv[i*2]=(c.origin[0]+q[i*3]*c.scale)/tm; uv[i*2+1]=(c.origin[2]+q[i*3+2]*c.scale)/tm; } out.uv = uv; }
        return out; }); }
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
  if(car.userData.jr){ JR.placePlayer(car, S.pos, pointAt); return; }
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
  if(VEHICLES[kind] && VEHICLES[kind].jr) return JR.makePlayer(kind);
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
  // v39: 高さ y（任意）。橋の上と下を通る車・電車は別の高さにあるので、高さが ZSEP(2.6m) 以上違えば互いを障害物にしない
  const ZSEP=2.6;
  function add(x, z, r, o, y){
    const e={x,z,r,o,y:(y===undefined||y===null||y!==y)?NaN:y}; list.push(e);
    const ix=Math.floor(x/CELL), iz=Math.floor(z/CELL), k=key(ix,iz);
    let a=map.get(k); if(!a){ a=[]; map.set(k,a); } a.push(e);
  }
  /* (x,z) から rad 以内にある自分以外の障害物（最初の1つ） */
  function hit(x, z, rad, self, skip, y){
    const hy=(y!==undefined && y!==null && y===y);
    const ix=Math.floor(x/CELL), iz=Math.floor(z/CELL);
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){
      const a=map.get(key(ix+dx,iz+dz)); if(!a) continue;
      for(const e of a){ if(e.o===self) continue; if(hy && e.y===e.y && Math.abs(e.y-y)>ZSEP) continue; const d=Math.hypot(e.x-x, e.z-z); if(d<e.r+rad && !(skip && skip(e.o))) return e; }
    }
    return null;
  }
  /* 車体に沿った円（長さ len、先頭 fx,fz、向き dx,dz） */
  function addBody(fx, fz, dx, dz, len, r, o, y){ const n=Math.max(2, Math.ceil(len/2.6)); for(let i=0;i<n;i++){ const t=(i+0.5)/n*len; add(fx-dx*t, fz-dz*t, r, o, y); } }
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
      const n=Math.max(2, Math.ceil(t.len/2.6)); for(let i=0;i<n;i++){ const s=t.pos-(i+0.5)/n*t.len; pathPt(t.leg.P, s, _p); Obs.add(_p.x,_p.z,1.25,t,_p.y); } }
  }
  /* 進路上の障害物までの距離（先頭から） */
  function gapAhead(P, pos, look, self, rad, skip){
    for(let d=1.2; d<=look; d+=2){ pathPt(P, pos+d, _p); const e=Obs.hit(_p.x,_p.z,rad,self,skip,_p.y); if(e) return {d:d-e.r, o:e.o}; }
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
  // v41.9: 車の形は vehicles.js（曲面の車体・ホイール・灯火・ナンバー。遠い車は軽い形）。ブレーキランプは車体の尾灯が光る
  const LOD_NEAR = 60;
  function buildMeshes(){
    meshes={}; const mat=Veh.makeMat();
    for(const T of TYPES) for(const lod of [0,1]){
      const g=Veh.ai(T.name, lod); g.setAttribute("aBrake", new THREE.InstancedBufferAttribute(new Float32Array(MAXN),1));
      const m=new THREE.InstancedMesh(g, mat, MAXN); m.setColorAt(0, new THREE.Color(1,1,1)); m.count=0; m.frustumCulled=false; m.castShadow=true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); meshes[T.name+lod]=m; }
  }
  function init(data){
    D=data; NL=D.lanes.length; segs=[];
    D.lanes.forEach((l,i)=>{ const P=mkPath(trafficPts(D, l)); segs.push({i, P, v:l.v, c:l.c, sig:l.sig, next:[], node:l.to, lane:true, k:l.k, n:l.n, nm:l.nm, imp:l.imp||1, sw:l.sw===undefined?1:l.sw}); });
    D.conns.forEach((c,i)=>{ const P=mkPath(trafficPts(D, c)); const s={i:NL+i, P, v:c.v, next:[c.b], node:c.node, lane:false, kind:c.k, from:c.a}; segs.push(s); segs[c.a].next.push(NL+i); });
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
    if(seg.lane){ let tot=0; const w=nx.map(j=>{ const k=segs[j].kind; let x = k==="s"?4:1.2;
      // v41.11: 道の大きさ（imp）で行き先を偏らせる。大きな道→細い道へは入りにくく、細い道→大きな道へは出やすく（細い道に車がたまらないように）
      { const nn=segs[j].lane ? segs[j] : segs[segs[j].next[0]]; if(nn && nn.lane){ const a=seg.imp||1, b=nn.imp||1; x *= b<a ? Math.pow(b/a, 2.2) : Math.min(2.5, Math.pow(b/a, 0.7)); } }
      tot+=x; return x; }); let r=Math.random()*tot; for(let i=0;i<nx.length;i++){ if((r-=w[i])<=0) return nx[i]; } return nx[0]; }
    return nx[0];
  }
  function planAhead(c){
    let tot=segs[c.plan[0]].P.len - c.s;
    for(let i=1;i<c.plan.length;i++) tot+=segs[c.plan[i]].P.len;
    c.endAhead=false;
    while(tot<170 && c.plan.length<10){ const last=segs[c.plan[c.plan.length-1]]; const n=chooseNext(last); if(n<0){ c.endAhead=true; break; } c.plan.push(n); tot+=segs[n].P.len; }
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
  /* v41.11: 出現させる車線を「重み（sw × 車線の長さ）」で抽選する表。従来は無作為に選んで重みで断っていたので、大通りの少ない所では出現がほとんど成功せず、台数が減っていた。
     中心が 40m 動くまで使い回す。W は範囲内の重みの合計（その場所の「道の多さ・大きさ」）で、出す台数の上限にも使う */
  const _spTabs = new Map();
  function spawnTable(center, rmin, rmax){
    const key = Math.round(center.x/40)+","+Math.round(center.z/40)+","+rmin+","+rmax; let t = _spTabs.get(key); if(t) return t;
    if(_spTabs.size>6) _spTabs.clear();
    const idx=[], cum=[]; let W=0; const cand = BK ? nearLanes(center, rmax) : [];
    for(const i of cand){ const g=segs[i]; if(!g.lane || g.P.len<20 || g.reach<250) continue; const m=(g.P.n>>1)*3, d=Math.hypot(g.P.P[m]-center.x, g.P.P[m+2]-center.z);
      if(d<rmin-g.P.len*0.5 || d>rmax+g.P.len*0.5) continue; W+=g.sw*Math.min(1,g.P.len/90); idx.push(i); cum.push(W); }
    t={idx,cum,W}; _spTabs.set(key,t); return t;
  }
  const CAR_PER_W=3.0;   // 出す台数の上限 = 範囲内の重みの合計 × 3.0（大通り 1km あたり 18 台前後）。MAXN が上限
  function spawnCar(c, center, rmin, rmax, avoidView){
    const tab = spawnTable(center, rmin, rmax); if(!(tab.W>0)) return false;
    for(let tries=0;tries<40;tries++){
      let lo=0, hi=tab.cum.length-1; const r=Math.random()*tab.W; while(lo<hi){ const m=(lo+hi)>>1; if(tab.cum[m]<r) lo=m+1; else hi=m; }
      const seg=segs[tab.idx[lo]];
      let s=4+Math.random()*(seg.P.len-8); let nearSig=false;
      // v35: 信号の停止線の手前 35m 以内・線を越えた所に出さない（赤で停止線を越えて現れる・急停止できない車をなくす）
      if(seg.sig){ const dd=seg.sig.s-s; if(dd>-3 && dd<35){ s=Math.min(s, seg.sig.s-7.5); nearSig=true; if(s<1) continue; } }
      const p=pathPt(seg.P, s);
      const d=Math.hypot(p.x-center.x, p.z-center.z); if(d<rmin||d>rmax) continue;
      if(avoidView){ const v=new THREE.Vector3(p.x-camera.position.x, 0, p.z-camera.position.z); const f=new THREE.Vector3(); camera.getWorldDirection(f); f.y=0; if(d<320 && v.normalize().dot(f.normalize())>0.2) continue; }
      if(Obs.hit(p.x,p.z,7,null,null,p.y)) continue;
      if(cars.some(o=>o!==c && o.x!==undefined && Math.hypot(o.x-p.x,o.z-p.z)<9)) continue;
      const T=pickType(); c.type=T; c.plan=[seg.i]; c.s=s; c.v=Math.min(seg.v/3.6*0.9, nearSig?1.5:12); c.passedG=undefined; c.passedT=0; c.stopT=0; c.v0=(0.98+Math.random()*0.2)*(T.name==="bus"||T.name==="truck4"?0.88:T.name==="truck"?0.95:1); /* v41.11: 流れに乗る速さ（制限の 98〜118%。以前は 72〜90%） */ c.dead=false; c.deadT=0; c.wait=0; c.ghost=0; c.blockedBy=null; c.hold=null; c.honkT=0; c.honkDly=0; c.jamT=0; c.nd=0; c.spImp=seg.imp;
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
    for(const c of cars){ if(!c.type) continue; Obs.addBody(c.x+c.dx*c.type.l/2, c.z+c.dz*c.type.l/2, c.dx, c.dz, c.type.l, c.type.w/2+0.1, c, c.y); }
  }
  let respT=0;
  const _f=new THREE.Vector3();
  function inView(x,z){ const dx=x-camera.position.x, dz=z-camera.position.z, d=Math.hypot(dx,dz); if(d>260) return false; camera.getWorldDirection(_f); return d<25 || (dx*_f.x+dz*_f.z)/d > 0.35; }
  function update(dt, simT, center){
    if(!ready) return;
    // 台数を保つ・遠い車は入れ替え
    respT-=dt;
    if(respT<=0){ respT=0.4;
      let nAct=0; for(const c of cars) if(c.type) nAct++;
      const cap = Math.min(MAXN, Math.round(spawnTable(center,0,450).W*CAR_PER_W));   // v41.11: 台数は道の多さ・大きさに比例（大通りは混みすぎず、細い道だけの郊外には少なく）
      for(const c of cars){ const far = c.type && Math.hypot(c.x-center.x, c.z-center.z)>480;
        if(!c.type || far || (c.dead && (!inView(c.x,c.z) || c.deadT>10))){ const had=!!c.type;
          if((nAct-(had?1:0))>=cap || !spawnCar(c, center, 200, 450, true)){ if(had) nAct--; c.type=null; } else if(!had) nAct++; } }
      let add=0; while(cars.length<MAXN && nAct<cap && add++<30){ const c={id:cars.length}; if(spawnCar(c, center, 20, 420, false)){ cars.push(c); nAct++; } else break; }
    }
    const wetK = Env.st.rain ? 0.86 : 1, gapK = Env.st.rain ? 1.3 : 1;   // v41.14: 雨は車間を 3 割広く、強いブレーキを控える
    for(const c of cars){
      if(!c.type) continue;
      const seg=segs[c.plan[0]]; const hl=c.type.l/2;
      // v41.8: クラクション（利用者）を聞いた車。少し間をおいて（反応時間）から、譲り合い待ち・歩行者待ちを解いて前へ進む（赤信号は守る）
      if(c.honkT>0){ c.honkT-=dt; if(c.honkDly>0) c.honkDly-=dt; } const hk = c.honkT>0 && !(c.honkDly>0);
      let vlim = (seg.lane ? seg.v : Math.min(segs[segs[c.plan[0]].next[0]].v, seg.v)) / 3.6 * c.v0 * wetK;   // v41.14: 雨では巡航を 14% 落とす
      let gap=1e9, gsrc=0, sigHold=false, jw=null;   // sigHold: 信号待ち  jw: 譲り合いで待っている相手
      // 前方の曲がり（接続の制限速度）
      let acc=seg.P.len-c.s;
      for(let i=1;i<c.plan.length && acc<150;i++){ const q=segs[c.plan[i]]; if(!q.lane){ const vc=q.v/3.6; vlim=Math.min(vlim, Math.sqrt(vc*vc+2*2.4*Math.max(0,acc-hl))); } acc+=q.P.len; }
      if(!seg.lane){ vlim=Math.min(vlim, seg.v/3.6); }
      // 信号（現在の車線と次の車線）
      acc=0;
      for(let i=0;i<c.plan.length && acc<170;i++){
        const q=segs[c.plan[i]]; const base = i===0 ? -c.s : acc;
        if(q.lane && q.sig){ const d=base+q.sig.s-hl;
          if(d<=-0.3 && d>-6){ c.passedG=q.sig.g; c.passedT=simT; }
          if(d>-0.3 && !(c.passedG===q.sig.g && simT-c.passedT<15)){ const st=phaseState(q.sig.g, q.sig.ph, simT);
            if(st===2 || (st===1 && d > c.v*c.v/2/3.5)) { if(d<gap){ gap=d; gsrc=1; } sigHold=true; break; } } }
        // 信号の無い交差点: 空くまで車線の終わりで待つ
        if(q.lane && i+1<c.plan.length){ const J=jnode.get(q.node);
          if(J){ const d=base+q.P.len-hl; if(d<18){ if(!hk && !(c.ghost>0) && J.owner && J.owner!==c && J.from!==q.i && simT-J.t<5){ if(d>-0.5){ if(d<gap){ gap=d; gsrc=2; } jw=J.owner; } }
            // 止まったままの持ち主は、場所取りの時刻を更新しない（5 秒で他の車に譲る＝交差点どうしの待ち合いで固まらない）
            else if(d<6){ if(J.owner!==c || J.from!==q.i || c.v>0.3){ J.owner=c; J.from=q.i; J.t=simT; } } } } }
        acc += i===0 ? q.P.len-c.s : q.P.len;
      }
      // 進路上の障害物（車・電車・プレイヤー）
      const look=Math.min(125, 8 + c.v*c.v/2/3.2 + c.v*1.4);   // v41.11: 速くなったぶん遠くまで見る（止まるのに要る距離）
      const self=c, pr=prio(c);
      // 相手も自分を待っているときは、優先度の低い方が待つ（電車に対しては車が先に抜ける＝線路上に居座らない）
      const e0r=(q)=>0.85;
      let pedSk=false;
      const skip=(o)=> c.ghost>0 && o.type ? true : o.leg ? o.blockedBy===c : (hk && o.ped && ((o.x-c.x)*c.dx+(o.z-c.z)*c.dz) > hl+2.2) ? (pedSk=true) : (o.type && (
        // 対向車（向きが逆）は、進路の中心から 1.2m 以内に車体の中心がある時だけ（狭い道のすれ違いで止まらない）
        ((o.dx*c.dx+o.dz*c.dz) < -0.5 && Math.hypot(o.x-_q.x, o.z-_q.z) > 1.2 + o.type.l*0.5) ||
        (o.blockedBy===c && (prio(o)<pr || (prio(o)===pr && o.id>c.id)))));
      c.blockedBy=null;
      for(let d=0.6; d<=look; d+= d<36 ? 1.8 : 2.4){ aheadPt(c, hl+d, _q); const e=Obs.hit(_q.x,_q.z, e0r(_q), self,skip,_q.y); if(e){ const g_=d-0.4-e.r*0.3; if(g_<gap){ gap=g_; gsrc=e.o.ped?3:e.o.type?4:e.o.leg?5:6; } c.blockedBy=e.o; break; } }
      if(!c.blockedBy && jw && jw.type) c.blockedBy=jw;   // 交差点の持ち主待ち（クラクションの伝言・待ち合い輪の検出に使う）
      if(pedSk) vlim=Math.min(vlim, 2.0);   // 歩行者が前にいるときは、人をよけさせながら徐行で進む
      // 前がつかえているなら、その前の車にもクラクションを伝える（先頭の車から順に動き出す）
      if(c.honkT>0 && c.blockedBy && c.blockedBy.type && !(c.blockedBy.honkT>c.honkT-0.5)){ c.blockedBy.honkT=c.honkT; c.blockedBy.honkDly=0.4+Math.random()*0.8; }
      // 交差点の先が詰まっていたら、交差点に入らず手前で待つ（交差点内で止まって横の流れをふさがない）
      if(c.plan.length>=3 && seg.lane && !(c.ghost>0)){ const cn=segs[c.plan[1]], ex=segs[c.plan[2]]; if(cn && !cn.lane && ex){
          const dEnd=seg.P.len-c.s-hl; if(dEnd<14 && dEnd>-0.5){ pathPt(ex.P, Math.min(ex.P.len, c.type.l+2.5), _q);
            const e=Obs.hit(_q.x,_q.z,1.4,self,(o)=>!o.type || o===c || o.v>1.5,_q.y); if(e){ if(dEnd<gap){ gap=dEnd; gsrc=7; } if(!c.blockedBy) c.blockedBy=e.o; } } } }
      // 道の終わり（行き止まり）では手前で止まる
      if(c.endAhead){ let rem=segs[c.plan[0]].P.len-c.s; for(let i=1;i<c.plan.length;i++) rem+=segs[c.plan[i]].P.len; { const g_=rem-hl-1; if(g_<gap){ gap=g_; gsrc=8; } } }
      // 利用者の車・バス: 進路の前方（左右 3.2m・扇形）にいれば止まる（割り込み・横切りにも対応）
      if(PLAYER_POS.on && Math.hypot(PLAYER_POS.x-c.x, PLAYER_POS.z-c.z)<110){
        for(const q of PLAYER_POS.pts){ const px=q[0]-c.x, pz=q[1]-c.z, fwd=px*c.dx+pz*c.dz, lat=Math.abs(px*c.dz-pz*c.dx);
          // 自分の車線の幅（左右 1.1m＋相手の半幅）に入っていれば、その手前で止まる
          if(fwd>0 && fwd<Math.max(40, c.v*3.2+12) && lat<1.1+PLAYER_POS.r){ const g_=fwd-hl-PLAYER_POS.r-1.5; if(g_<gap){ gap=g_; gsrc=9; } } } }
      c.gp = gap; c.vlimD = vlim;   // 試験用: 前方の空き・速度の上限
      c.gsrc = gap<8 ? gsrc : 0;   // 何で止まっているか（1 信号 2 交差点の持ち主 3 歩行者 4 車 5 電車 6 他 7 出口がつまっている 8 行き止まり 9 利用者）
      // 安全運転: 車間は 3m＋速度×1.5秒、加速は穏やか
      // v41.11: 前が車のときは、その車の速さ（vL）を考える。以前は前の車を「止まっている壁」として扱っていたため、車間 50m では時速 45km までしか出ず、流れに乗れなかった
      let vL=0; if(gsrc===4 && c.blockedBy && c.blockedBy.type && (c.blockedBy.dx*c.dx+c.blockedBy.dz*c.dz)>0.5) vL=Math.max(0, c.blockedBy.v||0);
      const vt=Math.min(vlim, Math.sqrt(vL*vL + Math.max(0, 2*2.5*Math.max(0,gap-(3.0+c.v*1.3)*gapK))));
      const a = vt>c.v ? Math.min(2.4, (vt-c.v)*2.0) : Math.max(-7.5*(wetK<1?0.8:1), (vt-c.v)*2.6);   // v41.11: 加速 1.3→2.4 m/s²（目標速度への追いつきも速く: 係数 0.9→2.0）
      c.brake = a < -0.6 || c.v < 0.5;
      c.v=Math.max(0, c.v + a*dt); if(gap<2.2 && c.v<0.5) c.v=Math.max(0,c.v-3*dt);
      // 行き詰まり（お互いに相手待ち）の解消
      // 相手待ちが輪になっている（または重なっている）ときだけ、少しの間ほかの車を無視して抜ける
      let cyc=false; if(c.v<0.2 && c.blockedBy && c.blockedBy.type){ let o=c.blockedBy; for(let k=0;k<8 && o && o.type;k++){ if(o===c){ cyc=true; break; } o=o.blockedBy; }
        if(Math.hypot(c.blockedBy.x-c.x, c.blockedBy.z-c.z)<2.5) cyc=true; }
      const nearP = PLAYER_POS.on && Math.hypot(PLAYER_POS.x-c.x, PLAYER_POS.z-c.z) < 30;
      if(cyc && (!nearP || hk)){ c.wait+=dt; if(c.wait>(hk?1.5:4)){ c.ghost=hk?2.0:2.5; c.wait=0; } } else c.wait=Math.max(0,c.wait-dt);
      // 信号待ちでもないのに 25 秒以上動けない車（交差点どうしの待ち合い・出口待ちの輪）は、3 秒だけ他の車を無視して抜ける。利用者のそばでは 45 秒待ってから。
      c.jamT = (c.v<0.2 && !sigHold) ? (c.jamT||0)+dt : 0;
      if(c.jamT>(nearP?45:25) && !(c.ghost>0)){ c.ghost=3.0; c.jamT=Math.min(c.jamT,10); }
      // 長く止まったまま（信号待ちではない）の車は入れ替える（見えていない所で）
      c.stopT = c.v<0.3 ? (c.stopT||0)+dt : 0;
      if(c.stopT>35 && !inView(c.x,c.z)) { c.dead=true; c.deadT=99; }
      if(c.endAhead && c.stopT>3) { c.dead=true; c.deadT=(c.deadT||0)+dt; }
      c.ghost=Math.max(0,c.ghost-dt);
      // v41.11: 細い道を 150m 以上走った車は、見えない所で（大通りに）入れ替える。細い道は数が多く、いったん入るとなかなか大通りへ出てこないため、車がたまってしまう
      if(seg.lane){ if(seg.imp<2.0){ c.nd=(c.nd||0)+c.v*dt; if(c.nd>(seg.imp<1.4?150:300) && !c.dead && !inView(c.x,c.z)){ c.dead=true; c.deadT=99; c.nd=0; } } else c.nd=0; }
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
  function draw(){
    const cnt={}; for(const T of TYPES){ cnt[T.name+"0"]=0; cnt[T.name+"1"]=0; }
    const cx=camera.position.x, cz=camera.position.z, n2=LOD_NEAR*LOD_NEAR;
    for(const c of cars){ if(!c.type) continue; const dx=c.x-cx, dz=c.z-cz, key=c.type.name+((dx*dx+dz*dz<n2)?"1":"0"); const m=meshes[key]; const i=cnt[key]++;
      _e.set(-c.pitch, Math.atan2(c.dx,c.dz), 0); _qt.setFromEuler(_e); _v.set(c.x, c.y, c.z); _m.compose(_v,_qt,_s); m.setMatrixAt(i,_m); m.setColorAt(i,c.color);
      m.geometry.attributes.aBrake.array[i]=c.brake?1:0; }
    for(const T of TYPES) for(const lod of [0,1]){ const key=T.name+lod, m=meshes[key]; m.count=cnt[key]; m.instanceMatrix.needsUpdate=true; if(m.instanceColor) m.instanceColor.needsUpdate=true; m.geometry.attributes.aBrake.needsUpdate=true; }
  }
  /* v41.8: 利用者のクラクション。前方（左右 4.5m＋距離×0.12 の扇形・55m 以内）で、同じ向きに止まっている・遅い車が聞く。
     対向車・横切る車は対象外。赤信号で止まっている車は動かない（update 側で信号は守る） */
  function honk(x, z, fx, fz){
    let n=0;
    for(const c of cars){ if(!c.type) continue;
      const px=c.x-x, pz=c.z-z, fwd=px*fx+pz*fz; if(fwd<-2 || fwd>55) continue;
      const lat=Math.abs(px*fz-pz*fx); if(lat>4.5+fwd*0.12) continue;
      if(c.dx*fx+c.dz*fz < 0.3) continue;
      if(c.v>3.0 && !c.blockedBy) continue;        // 普通に走っている車には関係ない
      c.honkT=8; c.honkDly=0.5+Math.random()*1.0; n++; }
    return n;
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
        if(cost<bc && !Obs.hit(px,pz,4.5,PCAR_REF.o,null,P.P[k*3+1])){ bc=cost; best={x:px, z:pz, yaw:Math.atan2(tx,tz)}; } } }
    return best;
  }
  /* v41.10: ナビ用。(x,z) に近い車線の点（折れ線への垂線の足）。yaw があれば進行方向が合う車線を優先。k 個まで近い順（同じ車線は 1 つ）
     戻り: [{i: 車線の番号, s: 車線の始点からの距離, x, y, z, d: 距離, dot: 向きの一致（-1〜1）}] */
  function locate(x, z, yaw, rmax, k, mask){
    const out=[]; if(!BK) return out;
    const r=Math.ceil(rmax/BKS)+1, ix=Math.floor(x/BKS), iz=Math.floor(z/BKS), seen=new Set();
    const fx=yaw==null?0:Math.sin(yaw), fz=yaw==null?0:Math.cos(yaw), rm2=rmax*rmax;
    for(let a=ix-r;a<=ix+r;a++) for(let b=iz-r;b<=iz+r;b++){ const L=BK.get(a+","+b); if(!L) continue;
      for(const i of L){ if(seen.has(i)) continue; seen.add(i); if(mask && !mask[i]) continue;
        const P=segs[i].P, A=P.P; let bd=1e18, bk=-1, bt=0;
        for(let q=0;q<P.n-1;q++){ const x0=A[q*3], z0=A[q*3+2], dx=A[q*3+3]-x0, dz=A[q*3+5]-z0, L2=dx*dx+dz*dz;
          let t=L2>1e-9?((x-x0)*dx+(z-z0)*dz)/L2:0; t=t<0?0:t>1?1:t; const px=x0+dx*t, pz=z0+dz*t, d2=(px-x)*(px-x)+(pz-z)*(pz-z);
          if(d2<bd){ bd=d2; bk=q; bt=t; } }
        if(bd>rm2 || bk<0) continue;
        const x0=A[bk*3], z0=A[bk*3+2], dx=A[bk*3+3]-x0, dz=A[bk*3+5]-z0, ll=Math.hypot(dx,dz)||1;
        out.push({i, s:P.C[bk]+ll*bt, x:x0+dx*bt, y:A[bk*3+1]+(A[bk*3+4]-A[bk*3+1])*bt, z:z0+dz*bt, d:Math.sqrt(bd), dot:yaw==null?1:(dx*fx+dz*fz)/ll}); } }
    if(yaw==null) out.sort((u,v)=>u.d-v.d); else out.sort((u,v)=>(u.d*u.d+(1-u.dot)*100)-(v.d*v.d+(1-v.dot)*100));
    return k>0 ? out.slice(0,k) : out;
  }
  // 街灯の位置（車線の左 3.2m・高さ 8m・30m おき）
  function segsForLamps(){ const out=[]; for(const g of segs){ if(!g.lane) continue; for(let s=10; s<g.P.len; s+=30){ const q=pathPt(g.P,s), t=pathTan(g.P,s); out.push(q.x+t.z*3.2, q.y+8.0, q.z-t.x*3.2); } } return out; }
  return {init, update, register, reset, startPose, spawnW(x,z){ return spawnTable({x,z},0,450).W; }, nearestLane, locate, segsForLamps, honk, get cars(){ return cars; }, get names(){ return D ? D.names : []; }, get NL(){ return NL; }, get ready(){ return ready; }, get segs(){ return segs; }, get jnode(){ return jnode; }};
})();
/* ================= バスモード（v11）: 両備バス 西大寺線 岡山駅 → 天満屋 → 県庁前 → 東山 =================
   経路: data/bus.json（OSM の道路・一方通行・停留所の標柱、晴れバスナビの停車順から作成）
   車両: 三菱ふそう エアロスター（ノンステップ 10.5m 級）相当の簡略モデル。前扉・中扉（左側）、行先LED
   ※塗装は白地に紺・赤の帯としたが、両備バスの現行標準塗装は資料で確認できていない（写真があれば合わせられる） */

function ryobiTex(dest, side){
  // 側面 1024×320（長さ 10.5m × 高さ 3.2m）。side: "L"（扉側）/ "R"
  return canvasTex(1024, 320, (g,w,h)=>{
    const Y=(m)=>h-(m/3.2)*h, X=(m)=>side==="L" ? (1-m/10.5)*w : (m/10.5)*w;           // m 単位 → px。m は後ろから測る。v41.9: 左の面は画像の左端が車の前（文字が正しく読める向き）なので左右を入れかえ、右の面は反転せずそのまま貼る
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
/* ---------------- v41.7: トラック（2t 級・キャブオーバー・箱型の荷台）----------------
   寸法は 2t 標準ロングの公表値に近い値: 全長 約 6.0m・全幅 1.88m（ワイドキャブ）・軸距 3.35m・荷台の内側 長さ約 4.0m。社名・ロゴは架空（実在の運送会社ではない）。
   +z = 前・+x = 左・y = 上（車の原点は後輪軸から 1.9m 前）。運転席は右ハンドル（x = -0.5）。 */
function makeTruck(){
  const g = new THREE.Group();
  const W = 1.88, y0 = 0.62;
  const white = new THREE.MeshPhongMaterial({ color: 0xf2f3f1, shininess: 45, specular: 0x555555 });
  const cabM = new THREE.MeshPhongMaterial({ color: 0xe9ecee, shininess: 60, specular: 0x667788 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1d2024 });
  const glassM = new THREE.MeshPhongMaterial({ color: 0x182229, specular: 0xaabbcc, shininess: 100 });
  const frameM = new THREE.MeshLambertMaterial({ color: 0x35383c });
  // 荷台の側面: 長さ 4.0m × 高さ 2.0m（箱の高さ 2.0m）。左右で文字が逆さ・鏡文字にならないよう、右側面は横を反転
  const sideTex = canvasTex(1024, 512, (c, w, h) => {
    c.fillStyle = "#f6f6f3"; c.fillRect(0, 0, w, h);
    c.fillStyle = "#1c5fb0"; c.fillRect(0, h * 0.82, w, h * 0.1); c.fillStyle = "#f08a1c"; c.fillRect(0, h * 0.93, w, h * 0.04);
    c.fillStyle = "#1c5fb0"; c.font = "900 150px 'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("お届け便", w * 0.5, h * 0.36);
    c.fillStyle = "#f08a1c"; c.font = "800 54px 'Hiragino Sans','Noto Sans JP',sans-serif"; c.fillText("DELIVERY SERVICE", w * 0.5, h * 0.64);
    c.strokeStyle = "rgba(0,0,0,.12)"; c.lineWidth = 4; c.strokeRect(2, 2, w - 4, h - 4);
  });
  const sideL = new THREE.MeshPhongMaterial({ map: sideTex, shininess: 40, specular: 0x444444 });
  const sideR = new THREE.MeshPhongMaterial({ map: sideTex.clone(), shininess: 40, specular: 0x444444 });
  sideR.map.needsUpdate = true; sideR.map.wrapS = THREE.RepeatWrapping; sideR.map.repeat.x = -1; sideR.map.offset.x = 1;
  const rearTex = canvasTex(256, 256, (c, w, h) => { c.fillStyle = "#f6f6f3"; c.fillRect(0, 0, w, h); c.fillStyle = "#1c5fb0"; c.fillRect(0, h * 0.84, w, h * 0.1);
    c.fillStyle = "#c8202c"; c.fillRect(14, h * 0.7, 26, 30); c.fillRect(w - 40, h * 0.7, 26, 30); c.fillStyle = "#1c5fb0"; c.font = "900 44px 'Hiragino Sans','Noto Sans JP',sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("お届け便", w / 2, h * 0.3); });
  const rear = new THREE.MeshPhongMaterial({ map: rearTex, shininess: 30 });
  const outer = [];
  // 荷台（長さ 4.0m: z -3.0 〜 1.0・高さ 2.0m: y 0.85 〜 2.85）。模様は上の canvas。キャブ・フレーム・車輪・灯火・運転席は vehicles.js（Veh.hi("truckP")）
  const box = new THREE.Mesh(new THREE.BoxGeometry(W, 2.0, 4.0), [sideL, sideR, white, dark, white, rear]); box.position.set(0, 1.85, -1.0); g.add(box);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.01, 0.07, 4.01), new THREE.MeshLambertMaterial({ color: 0xc9ccce })); stripe.position.set(0, 0.9, -1.0); g.add(stripe);
  const hi = Veh.hi("truckP", { color: new THREE.Color(0xe9ecee) }), hu = hi.userData;
  g.add(hu.body); const spin = [];
  for(const w of hu.wheels){ g.add(w.steer); spin.push({ m: w.spin, grp: w.steer, front: w.front }); }
  g.userData = { outer, cab: hu.cab, wheelG: { rotation: { z: 0 } }, spin, len: 6.0, hiU: hu };
  g.traverse(o => { if(o.isMesh) o.castShadow = true; });
  return g;
}
function makeRyobiBus(dest){
  const g = new THREE.Group();
  const Lb=10.5, W=2.49, y0=0.3, y1=3.1;
  const sideL=new THREE.MeshPhongMaterial({map:ryobiTex(dest,"L"), shininess:50, specular:0x555555});
  const sideR=new THREE.MeshPhongMaterial({map:ryobiTex(dest,"R"), shininess:50, specular:0x555555});
  const front=new THREE.MeshPhongMaterial({map:ryobiFrontTex(dest), shininess:70, specular:0x777777});
  const white=new THREE.MeshPhongMaterial({color:0xf2f3f1, shininess:40, specular:0x444444});
  const dark=new THREE.MeshLambertMaterial({color:0x202326});
  // 車体: +x=左（扉側）、+z=前。BoxGeometry の面順 [+x,-x,+y,-y,+z,-z]
  const rear=new THREE.MeshPhongMaterial({map:canvasTex(256,320,(g,w,h)=>{ g.fillStyle="#f4f5f3"; g.fillRect(0,0,w,h);
      g.fillStyle="#141a20"; g.fillRect(30,h*0.22,w-60,h*0.3); g.fillStyle="#0c0c0c"; g.fillRect(60,h*0.05,w-120,h*0.1); g.fillStyle="#7dff7a"; g.font="bold 22px Arial"; g.textAlign="center"; g.textBaseline="middle"; g.fillText("314",w/2,h*0.1);
      g.fillStyle="#1d3f86"; g.fillRect(0,h*0.8,w,h*0.2); g.fillStyle="#c8202c"; g.fillRect(0,h*0.77,w,h*0.025);
      g.fillStyle="#9a1010"; g.fillRect(14,h*0.56,26,h*0.16); g.fillRect(w-40,h*0.56,26,h*0.16); g.fillStyle="#1d3f86"; g.font="bold 20px sans-serif"; g.fillText("両備バス",w/2,h*0.66); }), shininess:40});
  // v41.9: 角をまるめ、車輪のところをアーチ状にくりぬいた車体（模様は箱のときと同じ向き）
  const body=new THREE.Mesh(Veh.busBody({W:W, L:Lb, y0:y0, y1:y1}), [sideL, sideR, white, dark, front, rear]); g.add(body);
  // 前面ガラスのつや・屋根上の冷房装置
  const ac=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.28,2.6), white); ac.position.set(0,y1+0.14,-0.5); g.add(ac);
  // バンパー・ミラー
  const bump=new THREE.Mesh(new THREE.BoxGeometry(W+0.04,0.3,0.25), dark); bump.position.set(0,0.42,Lb/2+0.05); g.add(bump);
  const bump2=bump.clone(); bump2.position.z=-Lb/2-0.05; g.add(bump2);
  const outer=[];
  const mirG=new THREE.MeshPhongMaterial({color:0x9fb3c2, shininess:90, specular:0xffffff});
  for(const s of [1,-1]){
    const arm=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.035,0.035), dark); arm.position.set(s*1.38,2.28,Lb/2-0.2); arm.rotation.y=s*0.35; g.add(arm);
    const arm2=new THREE.Mesh(new THREE.BoxGeometry(0.03,0.5,0.03), dark); arm2.position.set(s*1.5,2.1,Lb/2-0.12); g.add(arm2);
    const mir=new THREE.Mesh(new THREE.BoxGeometry(0.12,0.46,0.2), dark); mir.position.set(s*1.58,2.0,Lb/2-0.06); g.add(mir);
    const mg=new THREE.Mesh(new THREE.PlaneGeometry(0.1,0.42), mirG); mg.position.set(s*1.58,2.0,Lb/2-0.162); mg.rotation.y=Math.PI; g.add(mg); outer.push(arm,arm2,mir,mg); }
  outer.push(body, ac);
  // 運転席（運転席視点で表示）と車輪: vehicles.js（Veh.hi("busP")）。運転席の内側は車体の中に隠れていて、運転席視点のときだけ車体を消して見せる
  const hi=Veh.hi("busP", { color:new THREE.Color(0xf2f3f1), wipers:false }), hu=hi.userData, cab=hu.cab; cab.visible=false; g.add(cab);
  for(const ch of hu.body.children) if(ch!==cab && ch.geometry) ch.geometry.dispose();      // 使わない外観（キャブの車体）のぶんは捨てる
  const wheels=[], spin=[];
  for(const w of hu.wheels){ g.add(w.steer); wheels.push(w.steer); spin.push({ m:w.spin, grp:w.steer, front:w.front, r:w.r }); }
  // 扉（開閉するパネル: 左側面の外側に重ねる）
  const doorM=new THREE.MeshLambertMaterial({color:0x1b2127});
  const mkDoor=(zc, wlen)=>{ const panels=[]; for(const s of [-1,1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(0.04,2.35,wlen/2), doorM); p.position.set(W/2+0.02, 1.5, zc+s*wlen/4); g.add(p); panels.push({p, z0:zc+s*wlen/4, s}); } return panels; };
  const df=mkDoor(Lb/2-0.65, 1.0), dm=mkDoor(-0.12, 1.05);
  // 尾灯
  for(const s of [1,-1]){ const t=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.46,0.04), new THREE.MeshBasicMaterial({color:0x8a1010})); t.position.set(s*0.9,1.0,-Lb/2-0.025); g.add(t); }
  g.userData={doors:[df,dm], wheels, spin, len:Lb, open:0, outer, cab, wheelG:{ rotation:{ z:0 } }, hiU:hu};
  return g;
}
function setBusDoors(bus, t){      // t: 0=閉 1=開
  bus.userData.open=t;
  for(const panels of bus.userData.doors) for(const d of panels){ d.p.position.z = d.z0 + d.s*0.24*t; d.p.position.x = 2.49/2+0.02+0.06*t; }
}

/* 停留所の標柱（名前入り）・待っている人 */
// v39: 両面の看板・標識は、裏から見ると文字が鏡文字になる。裏面では横を反転して、どちらから見ても読めるようにする
function backFlip(m){
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `
    #ifdef USE_MAP
      vec4 texelColor = texture2D( map, gl_FrontFacing ? vUv : vec2( 1.0 - vUv.x, vUv.y ) );
      texelColor = mapTexelToLinear( texelColor );
      diffuseColor *= texelColor;
    #endif`); };
  m.customProgramCacheKey = () => "backflip"; return m;
}
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
    // 標柱の真後ろに、データ由来の高い電柱（架線柱）が重なって看板を半分隠す停留所は、柱ごと進行方向へずらす（岡山駅前: 柱どうしの距離 0.02m だった）
    for(const [nm, m] of [["岡山駅前", 1.2]]){ const s0 = D.stops.find(q => q.name === nm); if(s0 && !s0._nudged){ const t = pathTan(P, s0.arc); s0.pole = [s0.pole[0] + t.x * m, s0.pole[1] + t.z * m]; s0.arc += m; s0._nudged = true; } }
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
      const plate=new THREE.Mesh(new THREE.CircleGeometry(0.34,24), backFlip(new THREE.MeshLambertMaterial({map:stopPoleTex(s.name.replace(/・高校前$/,"・高校前")), side:THREE.DoubleSide})));
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
      const sign=new THREE.Mesh(new THREE.PlaneGeometry(1.9,0.6), backFlip(new THREE.MeshLambertMaterial({map:bayTex(b.ref, b.ref==="4"?["西大寺BC行","天満屋・県庁・東山経由","両備バス"]:["のりば "+b.ref]), side:THREE.DoubleSide})));
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
      const sign=new THREE.Mesh(new THREE.PlaneGeometry(1.7,0.53), backFlip(new THREE.MeshLambertMaterial({map:bayTex(b.ref, lines), side:THREE.DoubleSide})));
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
    Car.C.onDriverView=(drv)=>{ if(!model) return; for(const o of model.userData.outer) o.visible=!drv; model.userData.cab.visible=drv; if(drv) model.userData.hiU.update(Car.C); };
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
    ribbon.visible=true; active=true; bd.clk=S.clock; bdBuild();
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
  /* ---- ダイヤ（時刻表）: ゲーム内ダイヤ。区間ごとに 長さ ÷ 6.2 m/s ＋ 12 秒、停車は 20 秒。電車のダイヤ（Dia）と同じ評価 ---- */
  const bd = { clk: 32400, sc: null, pen: 0, rec: [], early: [], passed: 0, passedList: [], hold: null, stopClk: 0, moving: false };
  const bdOn = () => active && Dia.on && bd.sc && !st.done;
  function bdBuild(){
    bd.sc = null; bd.pen = 0; bd.rec = []; bd.early = []; bd.passed = 0; bd.passedList = []; bd.hold = null; bd.stopClk = 0; bd.moving = false; bd._ding = -1;
    const n = D.stops.length; if(!Dia.on || n < 3) return;
    const sc = []; let t = bd.clk + Math.max(30, st.dwellNeed + 15); sc[0] = { arr: null, dep: t };
    for(let i = 1; i < n; i++){ const arr = sc[i - 1].dep + (D.stops[i].arc - D.stops[i - 1].arc) / 6.2 + 12; sc[i] = { arr, dep: i < n - 1 ? arr + 20 : arr }; }
    bd.sc = sc; bdHud();
  }
  function bdHud(){
    const el = $("bus-dia"), row = $("bus-diarow"); if(!el || !row) return;
    if(!bdOn()){ row.style.display = "none"; paceSet("bus-pace", 0, false); return; } row.style.display = "";
    const lab = $("bus-dia-t");
    const a = (st.doors && st.atStop >= 0) ? st.atStop : -1; let txt, cls = "ok", d = 0, showBar = true;
    if(a >= 0){ if(a >= D.stops.length - 1){ txt = "終点"; if(lab) lab.textContent = "終点に到着"; showBar = false; }
      else { const rem = bd.sc[a].dep - bd.clk; d = -rem; if(lab) lab.textContent = "発車定刻 " + Dia.hms(bd.sc[a].dep);
        if(rem > 0.5){ txt = "あと " + fmtRem(rem); cls = "wait"; }
        else { txt = "発車OK"; if(bd._ding !== a){ bd._ding = a; Snd.blip("ok"); } if(rem < -5){ txt = "遅れ " + Math.round(-rem) + " 秒"; cls = "late"; } } } }
    else { const i = st.stopI, sc = bd.sc[i]; if(!sc || sc.arr == null){ row.style.display = "none"; paceSet("bus-pace", 0, false); return; }
      const prev = bd.sc[i - 1], a0 = D.stops[i - 1].arc, a1 = D.stops[i].arc, u = Math.max(0, Math.min(1, (st.s + 4.6 - a0) / Math.max(1, a1 - a0)));
      let lo = 0, hi = 1; for(let k = 0; k < 14; k++){ const m = (lo + hi) / 2; if(3 * m * m - 2 * m * m * m < u) lo = m; else hi = m; }
      d = bd.clk - (prev.dep + (sc.arr - prev.dep) * (lo + hi) / 2); if(lab) lab.textContent = "到着定刻 " + Dia.hms(sc.arr);
      txt = d > 5 ? "遅れ " + Math.round(d) + " 秒" : d < -5 ? "進み " + Math.round(-d) + " 秒" : "定刻"; cls = d > 5 ? "late" : d < -5 ? "early" : "ok"; }
    el.textContent = txt; el.className = cls; paceSet("bus-pace", d, showBar);
  }
  function bdOpen(i){
    if(!bdOn() || !bd.sc[i] || bd.sc[i].arr == null || bd.rec.some(r => r.i === i)) return;
    const at = (bd.clk - bd.stopClk < 120 && bd.stopClk > 0) ? bd.stopClk : bd.clk, dev = Math.round(at - bd.sc[i].arr), c = Dia.cfg;
    const pen = dev > c.GRACE ? Math.min(c.LATE_MAX, (dev - c.GRACE) * c.LATE_K) : 0; bd.pen += pen; bd.rec.push({ i, dev, pen });
    return dev > c.GRACE ? "定刻より " + dev + " 秒の遅れ（ダイヤ -" + Math.round(pen) + "点）。" : dev < -5 ? "定刻より " + (-dev) + " 秒早い到着。" + (i < D.stops.length - 1 ? "発車は " + Dia.hms(bd.sc[i].dep) + " まで待ちます。" : "") : "定刻どおりの到着です。";
  }
  function bdClose(i){
    if(!bdOn() || !bd.sc[i] || i >= D.stops.length - 1) return; const rem = bd.sc[i].dep - bd.clk;
    if(rem > 0.5){ bd.hold = i; return "発車定刻は " + Dia.hms(bd.sc[i].dep) + "（あと " + Math.ceil(rem) + " 秒）。定刻まで待ってから発車してください。"; }
  }
  function bdPass(i){ if(bdOn() && bd.sc[i] && bd.sc[i].arr != null && i < D.stops.length - 1 && !bd.rec.some(r => r.i === i)){ bd.passed++; bd.passedList.push(i); bd.pen += Dia.cfg.PASS_PEN; } }
  function bdTick(dt, v){
    bd.clk += dt; if(Math.abs(v) < 0.3){ if(bd.moving){ bd.moving = false; bd.stopClk = bd.clk; } } else bd.moving = true;
    if(!bdOn()) { bdHud(); return; }
    if(bd.hold != null){ const sc = bd.sc[bd.hold];
      if(!sc || bd.clk >= sc.dep - 0.5) bd.hold = null;
      else if(!st.doors && Math.abs(v) * 3.6 > 3){ const early = sc.dep - bd.clk, pen = Math.min(60, early * Dia.cfg.EARLY_K); bd.pen += pen; bd.early.push({ i: bd.hold, sec: Math.round(early) }); busSay("定刻前に発車しました（" + Math.round(early) + " 秒早い・ダイヤ -" + Math.round(pen) + "点）。"); bd.hold = null; } }
    bdHud();
  }
  function bdShift(d){ bd.clk += d; if(bd.stopClk > 0) bd.stopClk += d; if(bd.sc) for(const c of bd.sc){ if(!c) continue; if(c.arr != null) c.arr += d; if(c.dep != null) c.dep += d; } }
  function bdModel(){
    if(!(active && Dia.on && bd.sc)) return { on: false, kind: "bus", title: D.short + "（" + D.via + "）", rows: D.stops.map((s, i) => ({ name: s.name, arc: s.arc - D.stops[0].arc, cur: i === st.stopI })) };
    const rows = [];
    for(let i = 0; i < D.stops.length; i++){ const c = bd.sc[i]; if(!c) continue; const rec = bd.rec.find(q => q.i === i);
      rows.push({ name: D.stops[i].name, arr: c.arr, dep: c.dep, dev: rec ? rec.dev : null, passed: bd.passedList.includes(i), cur: i === ((st.doors && st.atStop >= 0) ? st.atStop : st.stopI), here: st.doors && st.atStop === i }); }
    return { on: true, kind: "bus", title: D.short + "（" + D.via + "）時刻表", rows, pen: bd.pen, ok: true };
  }
  function bdSummary(){
    if(!bd.sc || !(bd.rec.length || bd.passed)) return null;
    const dia = Math.max(0, Math.round(1000 - bd.pen)), ok = bd.rec.filter(r => r.dev <= Dia.cfg.GRACE).length, late = Math.max(0, ...bd.rec.map(r => r.dev));
    return { dia, g: dia > 900 ? "S" : dia > 750 ? "A" : dia > 550 ? "B" : "C", ok, n: bd.rec.length + bd.passed, late, passed: bd.passed, early: bd.early.length };
  }
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
        { const m=bdOpen(i); if(m){ $("bus-msg").textContent+="　"+m; $("subtitle").textContent+="　"+m; } }
        if(i===D.stops.length-1) setTimeout(finish, 2500);
      } else { st.atStop=-1; st.score=Math.max(0, st.score-5); busSay(z ? "停留所の標柱に扉を合わせてください（"+(z.along>0?"あと "+z.along.toFixed(1)+" m 前":Math.abs(z.along).toFixed(1)+" m 行き過ぎ")+"・歩道まで "+z.gap.toFixed(1)+" m）。" : "停留所以外で扉を開けました（-5点）。"); }
    } else {
      if(st.atStop>=0 && st.dwell<st.dwellNeed){ st.score=Math.max(0, st.score-10); busSay("まだ乗り降りしています（-10点）。"); }
      st.doors=false; Snd.door && Snd.door(false);
      if(st.atStop>=0){ const i=st.atStop; { const m=bdClose(i); if(m) setTimeout(()=>busSay(m), 300); } st.pax += (st.waiting[i]||0) - (st.alight[i]||0); st.pax=Math.max(0,st.pax); st.waiting[i]=0; placePeople();
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
    { const r=bdSummary(); if(r){ $("finish-text").textContent+="\nダイヤ運行: 定時点 "+r.dia+" / 1000（"+r.g+"）・定刻どおりの到着 "+r.ok+"/"+r.n+" 停留所・最大遅れ "+r.late+" 秒"+(r.passed?"・通過 "+r.passed+" 停留所":"")+(r.early?"・早発 "+r.early+" 回":"");
        const R2=Prefs.record("dia:bus", r.dia); setTimeout(()=>{ if(R2.newBest && R2.n>1) $("finish-text").textContent+="\nダイヤ自己ベスト更新！"; }, 0); } }
    TT.fillFinish(bdModel()); $("finish-overlay").classList.add("on"); $("turnback").style.display="none";
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
    bdTick(dt, C.v);
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
        if(need){ st.score=Math.max(0, st.score-40); bdPass(i); busSay(s.name+" を通過してしまいました（-40点・ダイヤ -"+Dia.cfg.PASS_PEN+"点）。"); }
        else busSay(s.name+" は乗り降りが無いので通過しました。");
        st.pax -= 0; st.waiting[i]=0; placePeople(); st.stopI=Math.min(D.stops.length-1,i+1); st.req=false; prepareNext(); setTimeout(()=>busAnn("next_"+st.stopI), 800); hudStops();
      }
    }
    // 乗り心地（乗客がいるとき）
    const cmf=(Car.P&&Car.P.cmf)||{acc:3.6,lat:3.6}, acc=Math.abs(C.accF||0), lat=C.latF||0;   // v41.16: 体に感じる加速度（なめらかにならした値）で判定
    if(st.pax>0 && Math.abs(C.v)>0.5 && (acc>cmf.acc || lat>cmf.lat)){ if(!st._harsh && performance.now()-(st._harshT||0)>6000){ st._harsh=true; st._harshT=performance.now(); st.comfortHits++; st.score=Math.max(0,st.score-5); busSay((acc>cmf.acc ? "急ブレーキ・急発進" : "急ハンドル")+"で車内が揺れました（-5点）。"); } } else if(acc<cmf.acc*0.6 && lat<cmf.lat*0.6) st._harsh=false;
    // 速度制限（車・タクシーと同じ: +20 km/h までは減点なし）
    const lim = st.lim || 50;
    if(Math.abs(C.v)*3.6 > lim+SPEED_OVER_OK){ st.score=Math.max(0, st.score-dt*4); if(performance.now()-st.lastWarn>3000){ st.lastWarn=performance.now(); busSay("制限速度 "+lim+" km/h を超えています。"); } }
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
    for(let tries=0; tries<20; tries++){ const q=pathPt(P,s); if(!Obs.hit(q.x,q.z,6,PCAR_REF.o,null,q.y)) break; s+=8; }
    const q=pathPt(P,s), t=pathTan(P,s); st.idx=Math.max(0,bi-2); return {x:q.x, z:q.z, yaw:Math.atan2(t.x,t.z)};
  }
  function onRoute(){ return !st.off; }
  return { init, begin, end, tick, doorKey, nearestOnRoute, onRoute, bd, bdSummary, bdBuild, bdShift, bdModel, get active(){ return active; }, get data(){ return D; }, st, setLimit:(v)=>{ st.lim=v; } };
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
      // v31: 升目ごとの点を小さな配列の並びではなく、1 本の Float64Array（x, z, 名前の番号, 制限速度 の繰り返し）で持つ（値と順番は同じ。メモリだけ減る）
      const cnt = new Map();
      traffic.lanes.forEach((ln,i)=>{ const p=trafficPts(traffic, ln); for(let k=0;k<p.length;k+=2){ const key=Math.floor(p[k][0]/20)*100003+Math.floor(p[k][2]/20); cnt.set(key, (cnt.get(key)||0)+1); } });
      LG = new Map(); const fill = new Map();
      for(const [key, n] of cnt){ LG.set(key, new Float64Array(n*4)); fill.set(key, 0); }
      traffic.lanes.forEach((ln,i)=>{ const p=trafficPts(traffic, ln); for(let k=0;k<p.length;k+=2){ const key=Math.floor(p[k][0]/20)*100003+Math.floor(p[k][2]/20); const a=LG.get(key), o=fill.get(key);
        a[o]=p[k][0]; a[o+1]=p[k][2]; a[o+2]=ln.nm; a[o+3]=ln.v; fill.set(key, o+4); } });
    }
  }
  function road(x, z){
    if(!LG) return null;
    let best=null, bo=-1, bd=144;
    const ix=Math.floor(x/20), iz=Math.floor(z/20);
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){ const a=LG.get((ix+dx)*100003+(iz+dz)); if(!a) continue;
      for(let o=0;o<a.length;o+=4){ const d=(a[o]-x)**2+(a[o+1]-z)**2; if(d<bd){ bd=d; best=a; bo=o; } } }
    return best ? { name: best[bo+2]>=0 ? names[best[bo+2]] : "", v: best[bo+3] } : null;
  }
  /* x,z の現在地。extra は先頭に付ける文字列（路線名など） */
  function update(dt, x, z, extra){
    t -= dt; if(t > 0) return last; t = 0.4;
    if(!PL){ return last; }
    if(Loc.mwInfo){ const m = Loc.mwInfo(x, z); if(m){ last = { town: null, ward: null, bridge: null, road: m.road, v: m.v }; const e2 = $("locchip"); e2.innerHTML = "📍 " + m.text; e2.classList.add("on"); return last; } }
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
  /* v41.10: 任意の点の町名・道路名（ナビの「地図で選ぶ」で使う）。町名は「津島東4」→「津島東四丁目」 */
  const KJ0 = "〇一二三四五六七八九";
  function at(x, z){ if(!PL) return null; const t = find(PL.towns, x, z), rd = road(x, z); let tn = t && t.name; if(tn){ const m = /^(.*\D)(\d)$/.exec(tn); if(m) tn = m[1] + KJ0[+m[2]] + "丁目"; } return { town: tn || "", road: rd && rd.name || "", v: rd && rd.v }; }
  return { init, update, hide, at, mwInfo: null, get last(){ return last; } };
})();
Loc.mwInfo = (x, z) => (S.mode === "car" && MW.ready) ? MW.info(x, z, Car.C.h) : null;


function setVehicle(kind){
  S.vehicle = VEHICLES[kind] ? kind : "momo";
  if(S.car){ scene.remove(S.car); if(S.car.userData.single && !S.car.userData.jr) S.car.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ if(m.map) m.map.dispose(); m.dispose(); }); } }); }
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
  if(!preview){ S.pos=S.cum[0]; S.speed=0; S.acc=0; S.emergency=false; S.notch=0; S.mc=0; S.bv=0; S.doorOpen=true; S.stopIndex=1; S.sigIndex=0; S.score=1000; S.comfortHits=0; S.announced=new Set(); }
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
  if(S.view==="cab" && VEH().jr){
    const V=VEH(), sE=S.pos-V.eyeBack, c=pointAt(sE), d=tangentAt(sE);
    if(!S._camD) S._camD=d.clone(); S._camD.lerp(d, 0.25).normalize();
    const D=S._camD;
    camera.position.set(c.x, c.y+V.eyeH, c.z);
    camera.lookAt(c.x+D.x*80, c.y+V.eyeH-1.6, c.z+D.z*80);
  } else if(S.view==="cab"){
    // 先頭車体(A車)の中心と向き。カメラは車体前面の運転席位置に置き、車体の向きに沿って前を見る
    const V=VEH(), sA=S.pos+0.6-V.front/2, c=pointAt(sA), d=tangentAt(sA);
    if(!S._camD) S._camD=d.clone(); S._camD.lerp(d, 0.25).normalize();
    const D=S._camD, eye=c.clone().addScaledVector(D, V.front/2-0.42);
    camera.position.set(eye.x, eye.y+2.35, eye.z);
    camera.lookAt(eye.x+D.x*40, eye.y+2.35-0.9, eye.z+D.z*40);
  } else {
    const side=new THREE.Vector3(t.z,0,-t.x), big=VEH().jr?(VEH().len>100?2.2:1.4):1, hp=VEH().jr?pointAt(S.pos-VEH().len*0.12):p;
    const b=hp.clone().addScaledVector(t,-32*big).addScaledVector(side,13*big);
    camera.position.set(b.x,b.y+16*big,b.z); camera.lookAt(hp.x,hp.y+2,hp.z);
  }
}

/* ---------------- HUD ---------------- */
const spd=$("speedometer").getContext("2d"), mapc=$("mini-map"), mapx=mapc.getContext("2d");
function drawSpeedo(){
  const c=spd,w=150,h=150,r=w/2-10; c.clearRect(0,0,w,h); c.save(); c.translate(w/2,h/2);
  c.strokeStyle="rgba(201,168,106,.5)"; c.lineWidth=2; c.beginPath(); c.arc(0,0,r,Math.PI*0.72,Math.PI*2.28); c.stroke();
  const DM=VEH().dial||60, DS=VEH().dstep||10;
  for(let v=0;v<=DM;v+=DS){ const a=Math.PI*0.72+(v/DM)*Math.PI*1.56; c.strokeStyle=v>DM*0.67?"#d6543f":"rgba(241,234,217,.7)";
    c.beginPath(); c.moveTo(Math.cos(a)*(r-6),Math.sin(a)*(r-6)); c.lineTo(Math.cos(a)*r,Math.sin(a)*r); c.stroke();
    c.fillStyle="rgba(241,234,217,.65)"; c.font="9px sans-serif"; c.textAlign="center"; c.textBaseline="middle"; c.fillText(v,Math.cos(a)*(r-16),Math.sin(a)*(r-16)); }
  const lim=limitAt(S.pos); const al=Math.PI*0.72+(Math.min(lim,DM)/DM)*Math.PI*1.56;
  c.strokeStyle="#e6a94d"; c.lineWidth=4; c.beginPath(); c.arc(0,0,r-2,al-0.03,al+0.03); c.stroke();
  const a=Math.PI*0.72+(Math.min(S.speed,DM)/DM)*Math.PI*1.56; c.strokeStyle="#e6a94d"; c.lineWidth=3; c.lineCap="round";
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
function buildNotchBar(){ const el=$("notch-bar"), nb=NB(), np=NP(); el.innerHTML=""; el.classList.toggle("wide", nb>5 || np>4); for(let i=-nb;i<=np;i++){ const d=document.createElement("i"); if(i<0)d.classList.add("brake"); if(i>0)d.classList.add("power"); el.appendChild(d);} }
function updateNotchBar(){ const b=$("notch-bar").children, nb=NB(), np=NP(); for(let i=-nb;i<=np;i++){ const el=b[i+nb]; if(!el) continue; el.classList.remove("on"); if(S.notch<0&&i>=S.notch&&i<0)el.classList.add("on"); if(S.notch>0&&i<=S.notch&&i>0)el.classList.add("on"); } $("notch").textContent=S.emergency?"EB":(S.notch===0?"N":(S.notch>0?"P"+S.notch:"B"+(-S.notch))); }
function setSubtitle(t){ $("subtitle").textContent=t; }

/* ---------------- ダイヤ運行（定時運転・v41） ----------------
   各停留所の到着・発車の定刻を作り、遅れ・早発を「定時点」で採点する（快適スコアとは別。評価は 1000 点から引く）。
   ・総所要時間は公表値: 東山線 岡山駅前〜東山 約15分、清輝橋線 岡山駅前〜清輝橋 約12分（Wikipedia「岡山電気軌道東山本線／清輝橋線」。渋滞等が無い場合）。
   ・停留所ごとの配分は、区間の距離・制限速度・信号の数から按分した推定（実際の時刻表の値ではない）。停車時間（DWELL）も仮定。
   ・到着は「停止した時刻」で測る。定刻より GRACE 秒を超えて遅れると減点、早着は減点なし（その代わり発車は定刻まで待つ）。
   ・定刻前の発車（早発）は 1 秒につき 3 点（最大 60 点）。 */
/* v41.7: 定刻とのずれ（秒。+ は遅れ）を横の帯に出す。左 = 進み・中央 = 定刻・右 = 遅れ（20 秒を超えると減点）。±60 秒で端 */
function paceSet(id, d, on){
  const p = document.getElementById(id), m = document.getElementById(id + "-m"); if(!p || !m) return;
  p.style.display = on ? "" : "none"; if(!on) return;
  m.style.left = (50 + Math.max(-60, Math.min(60, d)) / 60 * 50).toFixed(1) + "%";
  m.className = "pm " + (d > 20 ? "late" : d > 5 ? "warn" : d < -5 ? "early" : "ok");
}
const fmtRem = (s) => { s = Math.max(0, Math.ceil(s)); return s >= 60 ? Math.floor(s / 60) + "分" + String(s % 60).padStart(2, "0") + "秒" : s + "秒"; };
const Dia = (() => {
  const cfg = { TOTAL: { higashi: 1080, seiki: 870 }, DWELL: 25, GRACE: 20, START_WAIT: 30, LATE_K: 0.6, LATE_MAX: 40, EARLY_K: 3, PASS_PEN: 60 };
  const D = { on: true, sc: null, i0: 0, pen: 0, rec: [], early: [], passed: [], hold: null, moving: false, stopClock: 0, key: "" };
  const hms = (t) => { t = Math.round(t); const h = Math.floor(t / 3600) % 24, m = Math.floor(t / 60) % 60, s = t % 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); };
  function active(){ return D.on && S.mode === "tram" && !VEH().jr && S.running && D.sc; }
  function build(){
    D.sc = null; D.pen = 0; D.rec = []; D.early = []; D.passed = []; D.hold = null; D.moving = false;
    if(!D.on || S.mode !== "tram" || !S.stops || VEH().jr) return;
    const key = (S.baseKey || S.key || "").replace(/_r$/, ""), tot = cfg.TOTAL[key]; if(!tot) return;
    const st = S.stops, n = st.length, i0 = /引上線/.test(st[0].name) ? 1 : 0;
    if(n - i0 < 3) return;
    const ideal = [];
    for(let i = i0 + 1; i < n; i++){
      const a = st[i - 1].arc, b = st[i].arc; let t = 0;
      for(let j = idxAt(a); j < S.arc.length - 1 && S.arc[j] < b; j++){ const lo = Math.max(a, S.arc[j]), hi = Math.min(b, S.arc[j + 1]); if(hi > lo) t += (hi - lo) / (Math.max(10, S.speedLim[j]) * 0.9 / 3.6); }
      const nSig = S.signals.filter(g => g.stop >= a && g.stop < b).length;   // 信号の多い区間は余裕を多く（赤で止まる期待値 = 赤の長さ² / (2×周期) ≒ 14 秒）
      ideal.push(t + 12 + nSig * (((CYCLE - MAIN_G) ** 2) / (2 * CYCLE)));   // 加減速・停止のぶん + 信号待ち
    }
    const inter = n - 2 - i0, run = tot - cfg.DWELL * inter, sumI = ideal.reduce((x, y) => x + y, 0), k = run / sumI;
    const sc = []; let t = S.clock + cfg.START_WAIT; sc[i0] = { arr: null, dep: t };
    for(let i = i0 + 1; i < n; i++){ const arr = sc[i - 1].dep + ideal[i - i0 - 1] * k; sc[i] = { arr, dep: i < n - 1 ? arr + cfg.DWELL : arr }; }
    D.sc = sc; D.i0 = i0; D.key = key; D.total = sc[n - 1].arr - sc[i0].dep;
    show(true);
  }
  function atStop(){ return S.doorOpen ? (S._openedAt === S.stopIndex ? S.stopIndex : S.stopIndex - 1) : -1; }
  // 時刻 t0→t1 を距離 u(0..1)に割り付ける（加速・減速でなめらか: 距離 = 3τ²−2τ³ の逆）
  function expAt(i){
    const st = S.stops, a0 = st[i - 1].arc, a1 = st[i].arc, u = Math.max(0, Math.min(1, (S.pos - a0) / Math.max(1, a1 - a0)));
    let lo = 0, hi = 1; for(let k = 0; k < 14; k++){ const m = (lo + hi) / 2; if(3 * m * m - 2 * m * m * m < u) lo = m; else hi = m; }
    return D.sc[i - 1].dep + (D.sc[i].arr - D.sc[i - 1].dep) * (lo + hi) / 2;
  }
  function show(on){ const r = $("diarow"); if(r) r.style.display = on ? "" : "none"; }
  function hud(){
    const r = $("diarow"); if(!r) return;
    if(!active()){ r.style.display = "none"; paceSet("pace", 0, false); return; } r.style.display = "";
    const L = $("dia-t"), V = $("dia-d"); let a = atStop(), cls = "ok", txt = "", d = 0, showBar = true;
    if(a >= 0 && D.sc[a]){
      const last = a >= S.stops.length - 1;
      if(last){ L.textContent = "終点に到着"; txt = "定時点 " + Math.max(0, Math.round(1000 - D.pen)); showBar = false; }
      else { const rem = D.sc[a].dep - S.clock; L.textContent = "発車定刻 " + hms(D.sc[a].dep); d = -rem;
        if(rem > 0.5){ txt = "あと " + fmtRem(rem); cls = "wait"; }
        else { txt = "発車OK"; cls = "ok"; if(D._ding !== a){ D._ding = a; Snd.blip("ok"); }
          if(rem < -5){ txt = "遅れ " + Math.round(-rem) + " 秒"; cls = "late"; } } }
    } else {
      const i = S.stopIndex; if(!D.sc[i] || D.sc[i].arr == null || i - 1 < D.i0){ r.style.display = "none"; paceSet("pace", 0, false); return; }
      d = S.clock - expAt(i); L.textContent = "到着定刻 " + hms(D.sc[i].arr);
      if(d > 5){ txt = "遅れ " + Math.round(d) + " 秒"; cls = "late"; } else if(d < -5){ txt = "進み " + Math.round(-d) + " 秒"; cls = "early"; } else txt = "定刻";
    }
    V.textContent = txt; V.className = cls; paceSet("pace", d, showBar);
  }
  function tick(){
    if(S.speed < 0.3){ if(D.moving){ D.moving = false; D.stopClock = S.clock; } } else D.moving = true;
    if(!active()) return;
    if(D.hold != null){
      const sc = D.sc[D.hold];
      if(!sc || S.clock >= sc.dep - 0.5) D.hold = null;
      else if(!S.doorOpen && S.speed > 1.0){ const early = sc.dep - S.clock, pen = Math.min(60, early * cfg.EARLY_K); D.pen += pen; D.early.push({ i: D.hold, sec: Math.round(early) });
        setSubtitle("定刻前に発車しました（" + Math.round(early) + " 秒早い・-" + Math.round(pen) + "点）。この停留所の発車定刻は " + hms(sc.dep) + " です。"); D.hold = null; }
    }
    hud();
  }
  function onOpen(i){
    if(!active() || !D.sc[i] || D.sc[i].arr == null || D.rec.some(r => r.i === i)) return;   // 同じ停留所で開け閉めを繰り返しても 1 回だけ数える
    const at = (S.clock - D.stopClock < 180 && D.stopClock > 0) ? D.stopClock : S.clock, dev = Math.round(at - D.sc[i].arr);
    const pen = dev > cfg.GRACE ? Math.min(cfg.LATE_MAX, (dev - cfg.GRACE) * cfg.LATE_K) : 0; D.pen += pen; D.rec.push({ i, dev, pen });
    let m;
    if(dev > cfg.GRACE) m = "定刻 " + hms(D.sc[i].arr) + " より " + dev + " 秒の遅れ（-" + Math.round(pen) + "点）。";
    else if(dev < -5) m = "定刻より " + (-dev) + " 秒早い到着です。" + (i < S.stops.length - 1 ? "発車は " + hms(D.sc[i].dep) + " まで待ちます。" : "");
    else m = "定刻どおりの到着です（" + (dev >= 0 ? "+" : "") + dev + " 秒）。";
    $("subtitle").textContent += "　" + m;
  }
  function onPass(i){   // 停まらずに通過した停留所（ダイヤ上は停車駅）
    if(!active() || !D.sc[i] || D.sc[i].arr == null || i >= S.stops.length - 1 || D.rec.some(r => r.i === i) || D.passed.includes(i)) return;
    D.passed.push(i); D.pen += cfg.PASS_PEN;
  }
  function onClose(a){
    if(!active() || a < D.i0 || !D.sc[a]) return;
    const rem = D.sc[a].dep - S.clock;
    if(rem > 0.5){ D.hold = a; setSubtitle("発車定刻は " + hms(D.sc[a].dep) + " です（あと " + Math.ceil(rem) + " 秒）。定刻まで待ってから発車してください。"); }
  }
  function grade(v){ return v > 900 ? "S" : v > 750 ? "A" : v > 550 ? "B" : "C"; }
  function result(){
    if(!D.sc || !(D.rec.length || D.passed.length)) return null;
    const dia = Math.max(0, Math.round(1000 - D.pen)), ok = D.rec.filter(r => r.dev <= cfg.GRACE).length, late = Math.max(0, ...D.rec.map(r => r.dev));
    return { dia, g: grade(dia), ok, n: D.rec.length + D.passed.length, late, early: D.early.length, passed: D.passed.length };
  }
  function summary(){
    const r = result(); if(!r) return "";
    return "\nダイヤ運行: 定時点 " + r.dia + " / 1000（" + r.g + "）・定刻どおりの到着 " + r.ok + "/" + r.n + " 停留所・最大遅れ " + r.late + " 秒" + (r.passed ? "・通過 " + r.passed + " 停留所（-" + r.passed * cfg.PASS_PEN + "点）" : "") + (r.early ? "・早発 " + r.early + " 回" : "");
  }
  function setOn(v){ D.on = !!v; if(!v){ D.sc = null; show(false); } else if(S.running && S.mode === "tram") build(); }
  // v41.7: 時計を d 秒進めた（時間帯の切り替え）ぶん、定刻も同じだけずらす
  function shift(d){ if(D.sc) for(const c of D.sc){ if(!c) continue; if(c.arr != null) c.arr += d; if(c.dep != null) c.dep += d; } if(D.stopClock > 0) D.stopClock += d; }
  // v41.7: 時刻表パネル用（停留場ごとの定刻と実績）
  function model(force){
    if(!(D.on && S.mode === "tram" && !VEH().jr && (S.running || force) && D.sc)) return null;
    const rows = [], a = atStop();
    for(let i = D.i0; i < S.stops.length; i++){ const c = D.sc[i]; if(!c) continue; const rec = D.rec.find(q => q.i === i);
      rows.push({ name: S.stops[i].name.replace(/・.*$/, ""), arr: c.arr, dep: c.dep, dev: rec ? rec.dev : null, passed: D.passed.includes(i), cur: i === (a >= 0 ? a : S.stopIndex), here: i === a }); }
    return { title: (S.route && S.route.name || "路面電車") + " 時刻表", rows, pen: D.pen, ok: true, kind: "tram" };
  }
  return { build, tick, onOpen, onPass, onClose, summary, result, setOn, shift, model, cfg, D, get on(){ return D.on; }, hms };
})();

/* ---------------- 音と車内放送 ----------------
   走行音: 日本の路面電車の車内で録音した実音（函館・豊橋, CC0 / freesound.org Heigh-hoo）を
           速度に応じて2本のループをクロスフェード・再生速度変化。モーター音（VVVF）は合成で重ねる。
   制動: 停止直前のブレーキ鳴き（広島電鉄の実録音, CC0）、停車後の空気の緩解音（CC0）
   ドア: 開扉（函館の実録音）・閉扉（路面電車の閉扉音, CC0）/ 警鐘: 路面電車のベル（CC0）
   放送: 女性アナウンスの音声ファイル（事前生成。固有名詞はひらがなで読みを指定）。
         読み込めない場合のみブラウザの音声合成で代替。 */
Veh.wipeCb = (up) => { if(typeof Snd !== "undefined") Snd.wiper(up); };   // v41.14: ワイパーが払うたびに音（vehicles.js から呼ばれる）
const Snd = (() => {
  let ctx = null, master = null, sfxBus = null, annBus = null, on = true;
  const buf = {};
  let rollLo = null, rollHi = null, gLo, gHi, motorG, motorO1, motorO2, motorF, hsL = null;   // v39: 新幹線の車内録音（アイドル・巡航・轟音の3層）
  let lastJoint = 0, squealed = false, squealSrc = null, squealGain = null;
  const FILES = { roll_lo:"sfx/roll_lo.wav", roll_hi:"sfx/roll_hi.wav", squeal:"sfx/squeal.wav", air:"sfx/airrelease.wav",
                  dopen:"sfx/dooropen.wav", dclose:"sfx/doorclose.wav", bell:"sfx/bell.wav",
                  // v18: Freesound の CC0 素材を切り出し・ループ化（出典は画面下の注記）
                  car_engine:"sfx/car_engine.wav", car_road:"sfx/car_road.wav", car_squeal:"sfx/car_squeal.wav", car_horn:"sfx/car_horn.wav", car_crash:"sfx/car_crash.wav",
                  bus_engine:"sfx/bus_engine.wav", bus_cabin:"sfx/bus_cabin.wav", bus_horn:"sfx/bus_horn.wav", bus_air:"sfx/bus_air.wav",
                  bus_door_open:"sfx/bus_door_open.wav", bus_door_close:"sfx/bus_door_close.wav",
                  heli_rotor:"sfx/heli_rotor.wav", heli_body:"sfx/heli_body.wav", heli_cabin:"sfx/heli_cabin.wav",
                  mc_click:"sfx/mc_click.wav", bv_click:"sfx/bv_click.wav", lever_clunk:"sfx/lever_clunk.wav",
                  hs_idle:"sfx/hs_idle.wav", hs_cruise:"sfx/hs_u_cruise.wav", hs_roar:"sfx/hs_u_roar.wav", hs_chime:"sfx/hs_u_chime.mp3" };   // v40: 巡航・轟音・到着チャイムは制作者が用意した音源に差し替え（元の hs_cruise.wav / hs_roar.wav は予備として残してある）   // v39: 新幹線の車内録音（Freesound・CC0。出典は画面下の注記）
  async function load(name, url){
    try{ const r = await fetch(url); if(!r.ok) throw 0; buf[name] = await ctx.decodeAudioData(await r.arrayBuffer()); }
    catch(e){ console.warn("sound load failed", url); }
  }
  function startLoops(){
    if(buf.roll_lo && !rollLo){ rollLo = ctx.createBufferSource(); rollLo.buffer = buf.roll_lo; rollLo.loop = true; rollLo.connect(gLo); rollLo.start(0, Math.random()*10); }
    if(buf.roll_hi && !rollHi){ rollHi = ctx.createBufferSource(); rollHi.buffer = buf.roll_hi; rollHi.loop = true; rollHi.connect(gHi); rollHi.start(0, Math.random()*10); }
    if(buf.hs_idle && buf.hs_cruise && buf.hs_roar && !hsL){   // 新幹線の車内の音: 停車中の機器音 / 巡航の走行音 / 高速の轟音 を速度でつなぐ（再生速度は変えない）
      hsL = {};
      for(const k of ["idle", "cruise", "roar"]){
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6000; lp.Q.value = 0.4;
        const g = ctx.createGain(); g.gain.value = 0; const sN = ctx.createBufferSource(); sN.buffer = buf["hs_" + k]; sN.loop = true;
        sN.connect(lp).connect(g).connect(sfxBus); sN.start(0, Math.random() * sN.buffer.duration); hsL[k] = { g, lp, s: sN }; } }
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
    // 新幹線の風切り音・低い唸り: ピンクノイズをフィルターで整形（走行速度で音量・帯域が変わる）
    { const N = ctx.sampleRate * 3, nb = ctx.createBuffer(1, N, ctx.sampleRate), nd = nb.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0;
      for(let i = 0; i < N; i++){ const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; nd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      noiseBuf = nb;
      const mk = (type, f, q, dest) => { const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; src.connect(fl).connect(g).connect(dest); src.start(0, Math.random() * 2); return { src, fl, g }; };
      windN = mk("bandpass", 900, 0.35, sfxBus); rumbN = mk("lowpass", 140, 0.7, sfxBus); hissN = mk("highpass", 3200, 0.5, sfxBus); }
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
  let noiseBuf = null, windN = null, rumbN = null, hissN = null, lastTun = false, atcTimer = null;
  // 新幹線（N700）: 風切り音・低い唸り・IGBT インバータの磁励音（速度に連動して音程が上がる）・トンネル出入りの圧力変動音。
  // 溶接レールなので在来線のような継目音は鳴らさない。音は合成による近似で、実車の録音ではない
  const hsMotorLv = 0.3;
  function hsUpdate(t, st){
    const vk = Number.isFinite(st.vk) ? st.vk : 0, k = Math.min(1, vk / 300), tun = st.tun ? 1 : 0, lvl = sm(1, 50, vk);
    // v38: 在来線のような継目音は出さない（溶接レール）。低速だけ弱く残す。主役は車内録音のループ。
    const ins = st.inside !== false;                                  // 運転台（車内）か、外から見ているか
    gLo.gain.setTargetAtTime(lvl * (1 - sm(25, 90, vk)) * 0.16, t, 0.25); gHi.gain.setTargetAtTime(0, t, 0.25);
    if(rollLo) rollLo.playbackRate.setTargetAtTime(0.5 + Math.min(vk, 200) / 200 * 0.5, t, 0.3);
    if(hsL){
      const lv = ins ? 0.42 : 0.2, tg = tun ? 1.25 : 1;
      hsL.idle.g.gain.setTargetAtTime(lv * 0.6 * (1 - sm(40, 150, vk)), t, 0.4);
      const pw = Math.max(0, Math.min(1, Math.max(st.pf, st.bf * 0.7))) * sm(5, 120, vk) * (1 - sm(200, 290, vk));   // v39.2: 加速・回生中は録音の走行音が少し強まる（電子音の磁励音の代わり）
      hsL.cruise.g.gain.setTargetAtTime(lv * sm(15, 130, vk) * (1 - sm(200, 285, vk) * 0.8) * tg * (1 + 0.2 * pw), t, 0.5);
      hsL.roar.g.gain.setTargetAtTime(lv * sm(150, 270, vk) * tg, t, 0.5);
      const cut = (ins ? 7000 : 2500) * (tun ? 0.7 : 1);              // 外から聞くときはこもらせる
      for(const k in hsL) hsL[k].lp.frequency.setTargetAtTime(cut, t, 0.4);
    }
    const wk = hsL ? 0.3 : 1;                                       // 録音がある時は合成の風音を控えめに
    if(windN){
      windN.g.gain.setTargetAtTime((0.01 + 0.5 * Math.pow(k, 1.8)) * wk * (ins ? 0.8 : 1.3) * (tun ? 1.7 : 1) * sm(1, 30, vk), t, 0.25);
      windN.fl.frequency.setTargetAtTime((350 + vk * 6.5) * (tun ? 0.75 : 1), t, 0.3);
      rumbN.g.gain.setTargetAtTime((0.03 + 0.7 * Math.pow(k, 1.1)) * wk * (tun ? 1.9 : 1) * sm(1, 20, vk), t, 0.3);
      hissN.g.gain.setTargetAtTime(0.16 * Math.pow(k, 2.2) * wk * (tun ? 0.6 : 1), t, 0.3);
    }
    // 磁励音: 低速は搬送周波数が段階的に上がる。力行・回生ブレーキとも速度に連動
    const act = Math.max(st.pf, st.bf * 0.7);
    const f = vk < 20 ? 380 + vk * 14 : vk < 90 ? 660 + (vk - 20) * 9.5 : Math.min(2100, 1325 + (vk - 90) * 3.6);
    const step = vk < 90 ? Math.round(f / 55) * 55 : f;
    motorO1.frequency.setTargetAtTime(step, t, 0.06); motorO2.frequency.setTargetAtTime(step * 2, t, 0.06);
    motorF.Q.setTargetAtTime(2.5, t, 0.1); motorF.frequency.setTargetAtTime(Math.min(step * 1.2, 1500), t, 0.1);   // v39.2: 鋭いピーという電子音をやめ、帯域を広げて小さく（N700 は車内ではっきりした音階は出ない）
    motorG.gain.setTargetAtTime(act > 0 && vk > 1 ? hsMotorLv * (0.008 + 0.034 * act) * (1 - 0.7 * sm(120, 250, vk)) * (hsL ? 1 : 3) : 0, t, 0.3);
    if(tun !== (lastTun ? 1 : 0)){ if(vk > 70) boom(t, k, tun); lastTun = !!tun; }
  }
  function boom(t, k, enter){   // トンネル突入・脱出の圧力変動（ドンッ）
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((enter ? 0.7 : 0.4) * k * k + 0.02, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 1);
    if(noiseBuf){ const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = enter ? 380 : 700; const h = ctx.createGain();
      h.gain.setValueAtTime(0.0001, t); h.gain.exponentialRampToValueAtTime(0.9 * k, t + 0.08); h.gain.exponentialRampToValueAtTime(0.0001, t + 1.2); s.connect(f).connect(h).connect(sfxBus); s.start(t, Math.random() * 2, 1.3); }
  }
  function atc(on){   // ATC 速度超過の警報（ピンポーン…）。自動ブレーキが解除されるまで繰り返す
    if(atcTimer){ clearInterval(atcTimer); atcTimer = null; }
    if(!on || !ctx) return;
    const ding = () => { if(!ctx) return; const t = ctx.currentTime;
      for(const [f, d] of [[1568, 0], [1175, 0.28]]){ const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.28, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5); o.connect(g).connect(sfxBus); o.start(t + d); o.stop(t + d + 0.6); } };
    ding(); atcTimer = setInterval(ding, 1500);
  }
  function hsHorn(){   // 新幹線の電気警笛（近似: 低めの2音）
    if(!ctx || !on) return; const t = ctx.currentTime;
    for(const f of [370, 466]){ const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = 1500; const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.06); g.gain.setValueAtTime(0.16, t + 1.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6); o.connect(fl).connect(g).connect(sfxBus); o.start(t); o.stop(t + 1.7); }
  }
  function update(dt, st){
    if(!ctx || !on) return;
    const t = ctx.currentTime, v = st.speed, a = st.acc;
    if(st.hs){ hsUpdate(t, st); return; }
    if(windN){ windN.g.gain.setTargetAtTime(0, t, 0.2); rumbN.g.gain.setTargetAtTime(0, t, 0.2); hissN.g.gain.setTargetAtTime(0, t, 0.2); }
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
  function levers(mc, bv, emg){ emg = emg || 6;
    if(!ctx || !on){ lastMC = mc; lastBV = bv; return; }
    const dm = mc - lastMC, db = bv - lastBV, hsv = S.mode === "tram" && typeof VEH === "function" && VEH().hs;   // v39.2: 新幹線は 13 段のマスコンを一度に動かしても「カカカカ…」と連打しない
    const nm = hsv ? Math.min(2, Math.abs(dm)) : Math.abs(dm), nbv = hsv ? Math.min(2, Math.abs(db)) : Math.abs(db), kg = hsv ? 0.5 : 1;
    for(let i = 0; i < nm; i++) play("mc_click", {gain: kg * (0.55 + Math.random()*0.15), rate: (dm > 0 ? 1.0 : 0.93) * (0.97 + Math.random()*0.06), delay: i * 0.075});
    for(let i = 0; i < nbv; i++){
      const toEmg = bv >= emg && lastBV + (db > 0 ? i + 1 : -(i + 1)) >= emg;
      if(toEmg) play("lever_clunk", {gain: kg * 0.9, rate: 0.8, delay: i * 0.08});
      else play("bv_click", {gain: kg * (0.6 + Math.random()*0.15), rate: 0.9 + Math.random()*0.08, delay: i * 0.08});
    }
    lastMC = mc; lastBV = bv;
  }
  function door(open){
    if(S.mode === "bus"){ play(open ? "bus_door_open" : "bus_door_close", {gain: 0.9}); return; }
    if(open) play("dopen", {gain: 0.9}); else play("dclose", {gain: 0.9});
  }
  function horn(){
    if(S.mode === "tram" && typeof VEH === "function" && VEH().hs){ hsHorn(); return; }
    if(S.mode === "bus"){ play("bus_horn", {gain: 0.8}); return; }
    if(S.mode === "car"){ play("car_horn", {gain: 0.75}); return; }
    play("bell", {gain: 0.9}); play("bell", {gain: 0.8, delay: 0.42}); }
  function hsChime(){ return play("hs_chime", {gain: 0.7}); }   // v40: 新幹線の「まもなく到着」チャイム（提供音源）
  // v41.7: ミッションや発車時刻の合図（kind: ok=ピポッ / load=積み込み / done=到着・完了 / bad=減点）
  function blip(kind){ if(!ctx || !on) return; const t=ctx.currentTime;
    const seq = kind==="bad" ? [[196,0,"triangle"],[147,0.15,"triangle"]] : kind==="done" ? [[784,0],[988,0.11],[1319,0.22],[1568,0.36]] : kind==="load" ? [[659,0],[880,0.09]] : [[880,0],[1175,0.13]];
    for(const [f,d,ty] of seq){ const o=ctx.createOscillator(); o.type=ty||"sine"; o.frequency.value=f; const g=ctx.createGain(); const pk = kind==="bad" ? 0.3 : 0.22;
      g.gain.setValueAtTime(0.0001,t+d); g.gain.exponentialRampToValueAtTime(pk,t+d+0.012); g.gain.exponentialRampToValueAtTime(0.0001,t+d+(kind==="done"?0.55:0.32)); o.connect(g).connect(sfxBus); o.start(t+d); o.stop(t+d+0.7); } }
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
  function hush(){ if(annCur){ try{ annCur.stop(); }catch(e){} annCur = null; } if("speechSynthesis" in window) speechSynthesis.cancel();
    if(ctx){ const t = ctx.currentTime;   // v38: モードを変える時に、新幹線の連続音（録音・風・モーター）を止める（次の update で必要なら戻る）
      for(const n of [motorG, gLo, gHi]) if(n) n.gain.setTargetAtTime(0, t, 0.05);
      if(hsL) for(const k in hsL) hsL[k].g.gain.setTargetAtTime(0, t, 0.05);
      if(windN){ windN.g.gain.setTargetAtTime(0, t, 0.05); rumbN.g.gain.setTargetAtTime(0, t, 0.05); hissN.g.gain.setTargetAtTime(0, t, 0.05); } } }
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
    const bus = S.mode === "bus" || C.profile === "truck", sp = Math.abs(C.v), inside = C.view === "driver";
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
      set(eng.road, (inside ? 0.55 : 0.4) * Math.min(1, sp / 18) * (Env.st.rain ? 1.35 : 1));   // v41.14: 濡れた路面は「シャー」と大きい
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
  /* v41.14: 雨の音とワイパーの音（合成。録音ではない）。雨音は広帯域のノイズ（ザーッ）と、帯域を絞ってゆっくり揺らしたノイズ（パラパラ）。
     車内・運転台では高い音を削って小さく（屋根に当たる音）、外では大きめ、ヘリではローターの音が大きいので小さく */
  let rainN = null, rainLv = 0;
  function rainSound(dt, wet, place){
    if(!ctx || !noiseBuf) return;
    if(!rainN){
      const nz = (type, f, q) => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(0, Math.random() * 2.5); const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; s.connect(fl); return fl; };
      const hiG = ctx.createGain(); hiG.gain.value = 0; const hiLp = ctx.createBiquadFilter(); hiLp.type = "lowpass"; hiLp.frequency.value = 8000;
      nz("highpass", 1100, 0.5).connect(hiLp).connect(hiG).connect(sfxBus);
      const patG = ctx.createGain(); patG.gain.value = 0; nz("bandpass", 2400, 1.2).connect(patG).connect(sfxBus);
      const lfoG = ctx.createGain(); lfoG.gain.value = 0; nz("lowpass", 7, 0.7).connect(lfoG).connect(patG.gain);   // パラパラの強さをゆっくり揺らす（揺れの大きさは下で場所ごとに決める。計測: 7Hz に絞ったピンクノイズの実効値は 0.18）
      rainN = { hiG, hiLp, patG, lfoG };
    }
    rainLv += ((on && wet ? 1 : 0) - rainLv) * Math.min(1, dt * 0.8);
    const t = ctx.currentTime, cfg = place === "cab" ? { hi: 0.09, pat: 0.08, lp: 2600 } : place === "heli" ? { hi: 0.05, pat: 0.04, lp: 6000 } : { hi: 0.16, pat: 0.10, lp: 8000 };
    rainN.hiG.gain.setTargetAtTime(cfg.hi * rainLv, t, 0.25); rainN.patG.gain.setTargetAtTime(cfg.pat * rainLv, t, 0.25); rainN.lfoG.gain.setTargetAtTime(cfg.pat * 2.4 * rainLv, t, 0.25); rainN.hiLp.frequency.setTargetAtTime(cfg.lp, t, 0.3);
  }
  // ワイパーが 1 回払うごとの「スー」（上り・下りで音程が逆）と、折り返しの「コトッ」。運転席視点では大きく、外から見ているときは小さく
  function wiper(up){
    if(!ctx || !on || !noiseBuf || !sfxBus) return;
    const inside = (S.mode === "car" || S.mode === "bus") && Car.C.view === "driver", k = inside ? 1 : 0.25, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 0.9;
    f.frequency.setValueAtTime(up ? 900 : 2000, t); f.frequency.linearRampToValueAtTime(up ? 2000 : 900, t + 0.5);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.2 * k, t + 0.14); g.gain.linearRampToValueAtTime(0.0001, t + 0.56);
    s.connect(f).connect(g).connect(sfxBus); s.start(t, Math.random() * 2, 0.6);
    const th = ctx.createBufferSource(); th.buffer = noiseBuf; const tl = ctx.createBiquadFilter(); tl.type = "lowpass"; tl.frequency.value = 170;
    const tg = ctx.createGain(); tg.gain.setValueAtTime(0.0001, t + 0.62); tg.gain.linearRampToValueAtTime(0.22 * k, t + 0.635); tg.gain.linearRampToValueAtTime(0.0001, t + 0.72);
    th.connect(tl).connect(tg).connect(sfxBus); th.start(t + 0.6, Math.random() * 2, 0.15);
  }
  return {init, update, notch, levers, debug, brakeRelease, door, horn, atc, chime, blip, hsChime, ann, preload, text, hush, toggle, carSound, carHit, heliSound, jrSound, rainSound, wiper, get on(){ return on; }};
})();

/* 放送文は audio/ann.json（提供の書き起こしを整えた文面。広告は除外、運賃は改定があるため入れていない）。 */
function annStart(){ if(VEH().jr) return; Snd.ann("start_" + S.key); Snd.preload(["dep_" + S.key + "_1", "app_" + S.key + "_1", "arr_" + S.key + "_1"]); }
const AI = () => S.stopIndex + (S.annOff||0);
function annDepart(){
  if(VEH().jr){ if(S.stopIndex<S.stops.length) setSubtitle("（放送）次は "+S.stops[S.stopIndex].name+" です。"); return; }
  if(S.phase==="pull") return;
  const id = "dep_" + S.key + "_" + AI();
  Snd.ann(id);
  Snd.preload(["app_" + S.key + "_" + AI(), "arr_" + S.key + "_" + AI(), "dep_" + S.key + "_" + (AI() + 1)]);
  const t = Snd.text(id); setSubtitle("（放送）" + (t ? t.replace(/^この電車は、[^。]+。発車します。ご注意ください。/, "") : "次は " + S.stops[S.stopIndex].name));
}
function annApproach(){ if(VEH().jr){ if(VEH().hs && Snd.hsChime) Snd.hsChime(); setSubtitle("（放送）まもなく "+S.stops[S.stopIndex].name+" です。"); return; } if(S.phase==="pull" || AI()<=0) return; const id = "app_" + S.key + "_" + AI(); Snd.ann(id); const t = Snd.text(id); if(t) setSubtitle("（放送）" + t); }
function annArrive(){ if(VEH().jr) return; Snd.ann("arr_" + S.key + "_" + AI(), 0.8); }

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
  const paintMC = (g, w, h, n) => { g.fillStyle = "#e8e4d8"; g.fillRect(0, 0, w, h); g.fillStyle = "#222"; g.font = "bold " + (n > 6 ? 21 : 30) + "px sans-serif"; g.textBaseline = "middle";
    const st = (w - 24) / (n + 0.6); for(let i = 0; i <= n; i++) g.fillText(i ? String(i) : "切", 8 + i * st, h / 2); };
  const mcPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.05), new THREE.MeshBasicMaterial({ map: tex(512, 64, (g, w, h) => paintMC(g, w, h, 4)) }));
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
  const paintBV = (g, w, h, n) => { g.fillStyle = "#e8e4d8"; g.fillRect(0, 0, w, h); g.font = "bold " + (n > 6 ? 21 : 24) + "px sans-serif"; g.textBaseline = "middle";
    const lab = ["運"]; for(let i = 1; i < n; i++) lab.push(String(i)); lab.push("非"); const st = (w - 20) / (lab.length - 0.4);
    lab.forEach((s, i) => { g.fillStyle = s === "非" ? "#b01010" : "#222"; g.fillText(s, 8 + i * st, h / 2); }); };
  const bvPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.05), new THREE.MeshBasicMaterial({ map: tex(512, 64, (g, w, h) => paintBV(g, w, h, 6)) }));
  bvPlate.rotation.x = -Math.PI / 2; bvPlate.position.set(0, 0.017, 0.12); BV.add(bvPlate);
  // 運転台の小物: 戸閉スイッチ・警笛ペダルの代わりのボタン類
  cyl(0.02, 0.02, 0.02, new THREE.MeshLambertMaterial({ color: 0x2060c0 }), -0.05, -0.355, DZ + 0.2);
  cyl(0.02, 0.02, 0.02, new THREE.MeshLambertMaterial({ color: 0xc02020 }), 0.08, -0.355, DZ + 0.2);

  // ---- 状態: 角度（ノッチ位置）----
  let MC_STEP = -0.36, BV_STEP = -0.3, MC_N = 4, BV_N = 6;   // v36: 段数は車両ごと（新幹線: マスコン 13 段・ブレーキ 7段+非常）      // 右回り（上から見て時計回り）が正のノッチ
  const st = { mcAng: 0, bvAng: 0, drag: null };
  // ドラッグ用の当たり判定（見えない大きめの円柱）
  const hitM = new THREE.MeshBasicMaterial({ visible: false });
  const hitMC = cyl(0.17, 0.17, 0.3, hitM, 0, 0.12, 0, MC);
  const hitBV = cyl(0.3, 0.3, 0.2, hitM, 0.1, 0.09, 0, BV);
  // ================= v38: 新幹線（N700系）の運転台 =================
  // 参考: 実車の運転台の写真（曲面の計器盤・モニタ・黒い 2 本のハンドル）。配置は新幹線の標準（右手にマスコン・左手にブレーキハンドル）。
  // マスコンは奥へ押すほど加速（切→P1〜P13）、ブレーキハンドルは手前へ引くほど強い（運転→B1〜B7→非常）。
  // 形・色・計器の並びは写真と公開資料からの簡略再現で、実車の寸法ではない。
  const HS = new THREE.Group(); HS.visible = false; root.add(HS);
  let isHS = false;
  const pm = (c, o) => new THREE.MeshPhongMaterial(Object.assign({ color: c, shininess: 35, specular: 0x1c2024 }, o || {}));
  const HM = { slate: pm(0x3f5766), slate2: pm(0x344855), top: pm(0x58788c, { shininess: 55 }), trim: pm(0x2c6e49), pillar: pm(0x2c3943), ceil: pm(0x27333b),
    black: pm(0x0e1012, { shininess: 70, specular: 0x555a60 }), metal: pm(0xb9c0c6, { shininess: 90, specular: 0xffffff }), seat: pm(0x6f7b82, { shininess: 10 }), dark: pm(0x1b2127),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff4d6 }) };
  const hbox = (w, h, d, m, x, y, z, rx, ry, rz) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.set(rx || 0, ry || 0, rz || 0); HS.add(o); return o; };
  // 机の天板
  hbox(2.4, 0.03, 0.66, HM.top, 0, -0.335, -0.78);
  hbox(2.4, 0.016, 0.022, HM.trim, 0, -0.325, -0.455);                       // 手前の縁の緑の帯
  // 曲面の計器盤（円錐の一部。上が手前に傾く）
  const HB = { r0: 0.92, r1: 0.985, y0: -0.322, h: 0.30, L: 2.1, cz: 0.0 }; HB.tilt = Math.atan((HB.r1 - HB.r0) / HB.h);   // v39: 上が奥へ倒れた（目の方を向く）面。以前は逆向きで計器の上半分が盤面に隠れていた
  const bandR = (y) => HB.r0 + (HB.r1 - HB.r0) * ((y - HB.y0) / HB.h);
  { const g = new THREE.CylinderGeometry(HB.r1, HB.r0, HB.h, 40, 1, true, Math.PI - HB.L / 2, HB.L); const m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: 0x3f5766, shininess: 35, specular: 0x1c2024, side: THREE.DoubleSide }));
    m.position.set(0, HB.y0 + HB.h / 2, HB.cz); HS.add(m);
    const g2 = new THREE.CylinderGeometry(HB.r1 - 0.004, HB.r1, 0.012, 40, 1, true, Math.PI - HB.L / 2, HB.L); const m2 = new THREE.Mesh(g2, new THREE.MeshPhongMaterial({ color: 0x2c6e49, side: THREE.DoubleSide })); m2.position.set(0, HB.y0 + HB.h + 0.006, HB.cz); HS.add(m2); }
  const onBand = (th, y, w, h, mat, tilt) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); const r = bandR(y) - 0.010;
    m.position.set(r * Math.sin(th), y, r * Math.cos(th) + HB.cz); m.rotation.order = "YXZ"; m.rotation.y = th - Math.PI; m.rotation.x = -(tilt == null ? HB.tilt : tilt); HS.add(m); return m; };
  const bezel = (th, y, w, h) => { const m = onBand(th, y, w + 0.012, h + 0.012, HM.black); m.translateZ(-0.0035); return m; };
  // 計器・表示器（キャンバス）
  const mkCanvasMat = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return { c, t, m: new THREE.MeshBasicMaterial({ map: t }), key: "" }; };
  function drawGaugeHS(c, val, max, label, unit, ticks, red, allow) {
    drawGauge(c, val, max, label, unit, red, ticks);
    if (allow != null) { const g = c.getContext("2d"), a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, a = a0 + (a1 - a0) * Math.min(1, Math.max(0, allow / max));
      g.save(); g.translate(128, 128); g.strokeStyle = "#1c8fd8"; g.lineWidth = 8; g.beginPath(); g.arc(0, 0, 102, a - 0.035, a + 0.035); g.stroke(); g.restore(); }
  }
  const hsG = [];
  const addHsGauge = (th, y, rad, label, unit, max, ticks, red) => { { const b = bezel(th, y, 0.01, 0.01); b.geometry = new THREE.CircleGeometry(rad + 0.007, 32); } const cm = mkCanvasMat(256, 256); const m = new THREE.Mesh(new THREE.CircleGeometry(rad, 32), cm.m);
    const r = bandR(y) - 0.013; m.position.set(r * Math.sin(th), y, r * Math.cos(th) + HB.cz); m.rotation.order = "YXZ"; m.rotation.y = th - Math.PI; m.rotation.x = -HB.tilt; HS.add(m);
    const o = Object.assign(cm, { label, unit, max, ticks, red, last: null }); hsG.push(o); return o; };
  const gHS = addHsGauge(Math.PI + 0.31, -0.17, 0.097, "速度計", "km/h", 320, 8, false);
  const gMRh = addHsGauge(Math.PI + 0.485, -0.225, 0.043, "元空気溜", "kPa", 1000, 5, false);
  const gBCh = addHsGauge(Math.PI + 0.485, -0.118, 0.043, "ブレーキシリンダ", "kPa", 500, 5, true);
  // 中央左: 速度・ATC の表示器 / 右: モニタ（ノッチ・次駅・ドア）
  bezel(Math.PI + 0.04, -0.17, 0.26, 0.20).translateZ(0.008); const dAtc = mkCanvasMat(256, 192); onBand(Math.PI + 0.04, -0.17, 0.25, 0.188, dAtc.m).translateZ(0.008);   // 平面を円筒面に置くので、幅が広いほど端が面に埋まる → 手前へ 8mm   // v39.3: 速度・ATC の表示器を大きく
  bezel(Math.PI - 0.31, -0.17, 0.30, 0.225).translateZ(0.010); const dMon = mkCanvasMat(256, 192); onBand(Math.PI - 0.31, -0.17, 0.29, 0.213, dMon.m).translateZ(0.010);   // v39.3: モニタも大きく
  // 右: スイッチ盤（つまみ・表示灯）
  onBand(Math.PI - 0.74, -0.15, 0.15, 0.13, HM.dark);
  const hsLamps = [];
  for (let i = 0; i < 6; i++) { const l = onBand(Math.PI - 0.74 + (i - 2.5) * 0.04, -0.108, 0.022, 0.012, new THREE.MeshBasicMaterial({ color: 0x2c3338 })); hsLamps.push(l); }
  for (let i = 0; i < 4; i++) { const k = onBand(Math.PI - 0.74 + (i - 1.5) * 0.045, -0.18, 0.026, 0.026, HM.metal); k.geometry = new THREE.CircleGeometry(0.012, 16); }
  // 左端: 小さな表示灯盤
  onBand(Math.PI + 0.74, -0.15, 0.13, 0.13, HM.dark);
  for (let i = 0; i < 3; i++) onBand(Math.PI + 0.74, -0.11 - i * 0.035, 0.05, 0.02, new THREE.MeshBasicMaterial({ color: [0x3fb04f, 0xe0a030, 0xd04030][i] }));
  // 窓枠・天井・照明
  const pillar = (sx) => { const p = hbox(0.06, 1.05, 0.06, HM.pillar, sx * 0.86, 0.12, -0.95, 0, 0, sx * 0.26); return p; };
  pillar(-1); pillar(1);
  //   hbox(0.028, 0.34, 0.05, HM.pillar, 0, 0.30, -0.92);                          // 中央の支柱
  hbox(2.4, 0.07, 0.62, HM.ceil, 0, 0.455, -0.60);                            // 天井
  hbox(2.4, 0.045, 0.05, HM.pillar, 0, 0.395, -0.93);                         // 窓の上枠
  hbox(0.30, 0.016, 0.12, HM.lamp, 0, 0.415, -0.62);                          // 天井灯
  hbox(0.34, 0.07, 0.14, HM.dark, 0.0, 0.36, -0.78);                          // 天井の操作盤
  for (let i = 0; i < 8; i++) hbox(0.026, 0.014, 0.01, HM.metal, -0.14 + i * 0.04, 0.358, -0.708);
  hbox(0.30, 0.12, 0.10, HM.seat, -0.62, -0.50, -0.30, 0.2, 0.2, 0);          // 運転席の背もたれの肩（左下）
  // ハンドル 2 本（右: マスコン / 左: ブレーキ）。上下方向（前後に倒す）に動かす
  function makeLever(x, z, kind) {
    hbox(0.13, 0.012, 0.20, HM.dark, x, -0.316, z);
    hbox(0.026, 0.004, 0.17, HM.black, x, -0.309, z);
    const piv = new THREE.Group(); piv.position.set(x, -0.308, z); HS.add(piv);
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.011, 0.11, 14), HM.metal); sh.position.y = 0.055; piv.add(sh);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.08, 18), HM.black); grip.position.y = 0.15; piv.add(grip);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.022, 18, 12), HM.black); cap.scale.set(1, 0.8, 1.15); cap.position.y = 0.195; piv.add(cap);
    if (kind === "mc") { const fl = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 0.03), HM.black); fl.position.set(0, 0.112, 0); piv.add(fl); }
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.30, 10), hitM); hit.position.set(0, 0.13, 0); piv.add(hit);
    return { piv, hit };
  }
  const hsMC = makeLever(0.50, -0.74, "mc"), hsBV = makeLever(-0.50, -0.74, "bv");   // v39.3: 計器の前を横切らないよう外側へ
  // ノッチの目盛り板（ハンドルの横。手前に傾けて文字が読めるように）
  const PL_H = 0.27, PL_TILT = 1.0;
  function makePlate(x) {
    const cm = mkCanvasMat(96, 512); const m = new THREE.Mesh(new THREE.PlaneGeometry(0.075, PL_H), cm.m);
    m.rotation.x = -PL_TILT; m.position.set(x, -0.316 + PL_H / 2 * Math.sin(PL_TILT), -0.77 - PL_H / 2 * Math.cos(PL_TILT)); HS.add(m);
    const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.082, 0.014), new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.55, depthTest: false })); mk.renderOrder = 5; mk.rotation.x = -PL_TILT; HS.add(mk);
    return Object.assign(cm, { mk, x });
  }
  const plMC = makePlate(0.585), plBV = makePlate(-0.585);
  function paintPlate(pl, labels, redLast) {
    const c = pl.c, g = c.getContext("2d"), w = c.width, h = c.height, n = labels.length; g.fillStyle = "#e9edf0"; g.fillRect(0, 0, w, h);
    g.textAlign = "center"; g.textBaseline = "middle"; g.font = "bold " + Math.min(34, Math.floor(h / n * 0.62)) + "px sans-serif";
    labels.forEach((s, i) => { g.fillStyle = (redLast && i === n - 1) ? "#c01818" : "#161b20"; g.fillText(s, w / 2, (i + 0.5) * h / n); g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(6, (i + 1) * h / n - 1, w - 12, 1.5); });
    pl.n = n; pl.t.needsUpdate = true;
  }
  const hsFrac = { mc: 0, bv: 0 };
  function placeMarker(pl, row, n) {   // row: 上から数えた行
    const along = (row + 0.5) / n * PL_H;               // 板の上端からの距離
    pl.mk.position.set(pl.x, -0.316 + (PL_H - along) * Math.sin(PL_TILT), -0.77 - (PL_H - along) * Math.cos(PL_TILT));
  }
  const hsState = { mc: 0, bv: 0 };
  function drawATC(S) {
    const c = dAtc.c, g = c.getContext("2d"), v = Math.round(S.speed), al = Math.round(S.atcAllow == null ? 300 : S.atcAllow), br = !!S.atc;
    const key = v + "|" + al + "|" + br + "|" + !!S.emergency; if (key === dAtc.key) return; dAtc.key = key;
    g.fillStyle = "#06090c"; g.fillRect(0, 0, 256, 192);
    g.fillStyle = "#6b7b86"; g.font = "bold 15px sans-serif"; g.textAlign = "left"; g.fillText("ATC", 10, 20); g.textAlign = "right"; g.fillText("km/h", 246, 20);
    g.fillStyle = br || S.emergency ? "#e04030" : "#37c46a"; g.fillRect(52, 8, 70, 16); g.fillStyle = "#06090c"; g.font = "bold 13px sans-serif"; g.textAlign = "center"; g.fillText(S.emergency ? "非常" : br ? "ブレーキ" : "進行", 87, 20.5);
    g.fillStyle = "#f2f5f7"; g.font = "bold 86px 'Courier New',monospace"; g.textAlign = "right"; g.fillText(String(v), 238, 108);
    g.fillStyle = "#1c8fd8"; g.font = "bold 22px sans-serif"; g.textAlign = "left"; g.fillText("指示 " + al, 10, 140);
    // 速度バー（緑=現在、青の印=指示速度）
    g.fillStyle = "#1a232a"; g.fillRect(10, 156, 236, 18); g.fillStyle = v > al + 1 ? "#e04030" : "#37c46a"; g.fillRect(10, 156, 236 * Math.min(1, v / 320), 18);
    g.fillStyle = "#1c8fd8"; g.fillRect(10 + 236 * Math.min(1, al / 320) - 2, 150, 4, 30);
    g.fillStyle = "#6b7b86"; g.font = "11px sans-serif"; g.textAlign = "center"; for (let k = 0; k <= 320; k += 80) g.fillText(String(k), 10 + 236 * k / 320, 188);
    dAtc.t.needsUpdate = true;
  }
  function drawMON(S) {
    const c = dMon.c, g = c.getContext("2d"), n = S.notch, np = MC_N, nb = BV_N - 1;
    const nxt = S.stops && S.stops[S.stopIndex], dist = nxt ? Math.max(0, Math.round((nxt.arc - S.pos))) : 0;
    const key = n + "|" + (nxt ? nxt.name : "") + "|" + Math.round(dist / 10) + "|" + !!S.doorOpen + "|" + !!S.emergency; if (key === dMon.key) return; dMon.key = key;
    g.fillStyle = "#07090b"; g.fillRect(0, 0, 256, 192);
    g.fillStyle = "#8aa0ad"; g.font = "bold 14px sans-serif"; g.textAlign = "left"; g.fillText("運転状況", 8, 18);
    const lab = S.emergency ? "EB" : n > 0 ? "P" + n : n < 0 ? "B" + (-n) : "N"; g.fillStyle = S.emergency ? "#e04030" : n > 0 ? "#37c46a" : n < 0 ? "#f0b030" : "#c8d2d8"; g.font = "bold 56px 'Courier New',monospace"; g.textAlign = "left"; g.fillText(lab, 10, 78);
    // ノッチの棒（力行 13・制動 7）
    const bw = 9, x0 = 100; g.textAlign = "left"; g.font = "11px sans-serif"; g.fillStyle = "#8aa0ad"; g.fillText("力行", 100, 34);
    for (let i = 1; i <= np; i++) { g.fillStyle = n >= i ? "#37c46a" : "#1c262c"; g.fillRect(x0 + (i - 1) * (bw + 1), 38, bw, 20); }
    g.fillStyle = "#8aa0ad"; g.fillText("制動", 100, 74);
    for (let i = 1; i <= nb; i++) { g.fillStyle = (-n >= i) ? "#f0b030" : "#1c262c"; g.fillRect(x0 + (i - 1) * (bw + 4), 78, bw + 3, 20); }
    g.fillStyle = "#1a232a"; g.fillRect(8, 112, 240, 1.5);
    g.fillStyle = "#8aa0ad"; g.font = "13px sans-serif"; g.fillText("次の停車駅", 8, 132);
    g.fillStyle = "#f2f5f7"; g.font = "bold 28px sans-serif"; g.fillText(nxt ? nxt.name : "--", 8, 162);
    g.textAlign = "right"; g.font = "bold 22px sans-serif"; g.fillStyle = "#f0b030"; g.fillText(dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : dist + " m", 248, 162);
    g.font = "bold 13px sans-serif"; g.fillStyle = S.doorOpen ? "#f0b030" : "#37c46a"; g.fillText("ドア " + (S.doorOpen ? "開" : "閉"), 248, 186);
    dMon.t.needsUpdate = true;
  }
  function updateHS(dt, S) {
    const mcT = MC_N ? api.getMC() / MC_N : 0, bvT = BV_N ? api.getBV() / BV_N : 0;
    if (!st.drag || st.drag.w !== "mc") hsFrac.mc += (mcT - hsFrac.mc) * Math.min(1, dt * 14);
    if (!st.drag || st.drag.w !== "bv") hsFrac.bv += (bvT - hsFrac.bv) * Math.min(1, dt * 14);
    hsMC.piv.rotation.x = 0.30 - hsFrac.mc * 0.80;       // 手前（切）→ 奥（P13）
    hsBV.piv.rotation.x = -0.10 + hsFrac.bv * 0.78;      // 奥（運転）→ 手前（非常）
    placeMarker(plMC, MC_N - api.getMC(), MC_N + 1); placeMarker(plBV, api.getBV(), BV_N + 1);
    const bc = S.emergency ? 450 : Math.max(0, -S.notch) * (360 / Math.max(1, BV_N - 1)), mr = 880 + Math.sin(S.t * 0.2) * 6 - bc * 0.06;
    for (const [o, v, al] of [[gHS, S.speed, S.atcAllow == null ? null : S.atcAllow], [gMRh, mr, null], [gBCh, bc, null]]) { const q = Math.round(v / (o.max / 320)); if (q !== o.last || al !== o.al) { o.last = q; o.al = al; drawGaugeHS(o.c, v, o.max, o.label, o.unit, o.ticks, o.red, al); o.t.needsUpdate = true; } }
    drawATC(S); drawMON(S);
    const on = [!S.doorOpen, S.notch > 0, S.notch < 0, !!S.atc, true, !!S.emergency], cols = [0x37c46a, 0x37c46a, 0xf0b030, 0xe04030, 0x4aa0e0, 0xe04030];
    hsLamps.forEach((l, i) => l.material.color.setHex(on[i] ? cols[i] : 0x2c3338));
    // 走行中の揺れはごく小さく（ゆっくりした上下動と加減速の前後傾きだけ）
    const sh = Math.min(1, S.speed / 120);
    root.position.set(Math.sin(S.t * 0.7) * 0.0006 * sh, Math.sin(S.t * 1.3) * 0.0006 * sh - (S.acc || 0) * 0.0008, 0);
  }

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let api = null;   // {getMC, setMC, getBV, setBV}
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camC);
    const L2 = isHS ? [hsMC.hit, hsBV.hit] : [hitMC, hitBV];
    const h = ray.intersectObjects(L2, false);
    return h.length ? (h[0].object === L2[0] ? "mc" : "bv") : null;
  }
  function onDown(ev) {
    if (!Cab.active || !api) return;
    const w = pick(ev); if (!w) return;
    ev.preventDefault();
    st.drag = { w, x0: ev.clientX, y0: ev.clientY, f0: w === "mc" ? hsFrac.mc : hsFrac.bv, a0: w === "mc" ? api.getMC() * MC_STEP : api.getBV() * BV_STEP, id: ev.pointerId };
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function onMove(ev) {
    if (!st.drag) { if (Cab.active) renderer.domElement.style.cursor = pick(ev) ? "grab" : ""; return; }
    if (isHS) {   // 新幹線: マスコンは上へ（奥へ押す）、ブレーキは下へ（手前へ引く）でノッチが増える
      const dy = ev.clientY - st.drag.y0, w = st.drag.w, per = 200; let f = st.drag.f0 + (w === "mc" ? -dy : dy) / per; f = Math.max(0, Math.min(1, f)); hsFrac[w] = f;
      const N = w === "mc" ? MC_N : BV_N, n = Math.round(f * N); if (n !== (w === "mc" ? api.getMC() : api.getBV())) (w === "mc" ? api.setMC : api.setBV)(n); return; }
    const dx = ev.clientX - st.drag.x0;
    const ang = st.drag.a0 - dx * 0.011;          // 右へドラッグ = 右回り
    if (st.drag.w === "mc") { const n = Math.max(0, Math.min(MC_N, Math.round(ang / MC_STEP))); st.mcAng = Math.max(MC_N * MC_STEP, Math.min(0.05, ang)); if (n !== api.getMC()) api.setMC(n); }
    else { const n = Math.max(0, Math.min(BV_N, Math.round(ang / BV_STEP))); st.bvAng = Math.max(BV_N * BV_STEP, Math.min(0.05, ang)); if (n !== api.getBV()) api.setBV(n); }
  }
  function onUp() { st.drag = null; }
  renderer.domElement.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp); addEventListener("pointercancel", onUp);

  function update(dt, S) {
    if (isHS) { updateHS(dt, S); return; }
    // ハンドル角: ドラッグ中は指に追従、それ以外はノッチ位置へ滑らかに
    if (!st.drag || st.drag.w !== "mc") st.mcAng += (api.getMC() * MC_STEP - st.mcAng) * Math.min(1, dt * 14);
    if (!st.drag || st.drag.w !== "bv") st.bvAng += (api.getBV() * BV_STEP - st.bvAng) * Math.min(1, dt * 14);
    mcRot.rotation.y = st.mcAng; bvRot.rotation.y = st.bvAng;
    // 計器
    const bc = S.emergency ? 4.2 : Math.max(0, -S.notch) * (3.5 / Math.max(1, BV_N - 1));
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
    camC.aspect = camera.aspect; camC.fov = camera.fov * (isHS ? 0.95 : 1); camC.updateProjectionMatrix();   // v39.3: 新幹線は運転台だけ少し拡大して計器を読みやすく（外の景色の画角は変えない）
    r.clearDepth(); r.render(sceneC, camC);
  }
  function screenPos() {   // テスト用: ハンドル位置の画面座標
    const r = renderer.domElement.getBoundingClientRect(), out = {};
    for (const [k, o] of [["mc", knob], ["bv", grip]]) { const v = new THREE.Vector3(); o.getWorldPosition(v); v.project(camC); out[k] = [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }
    return out;
  }
  function setNotches(np, nb, hs) {   // np: 力行ノッチ数、nb: 常用ブレーキ段数（非常はその次）、hs: 新幹線配置（マスコン右・ブレーキ弁左）
    MC_N = np; BV_N = nb + 1; MC_STEP = -1.44 / np; BV_STEP = -1.8 / BV_N;
    isHS = !!hs; { const u = document.getElementById("ui"); if(u) u.classList.toggle("hs", isHS); } HS.visible = isHS; for (const ch of root.children) if (ch !== HS) ch.visible = !isHS; if (!isHS) root.position.set(0, 0, 0);
    if (isHS) { const lm = []; for (let i = np; i >= 1; i--) lm.push(String(i)); lm.push("切"); paintPlate(plMC, lm, false);
      const lb = ["運"]; for (let i = 1; i <= nb; i++) lb.push(String(i)); lb.push("非"); paintPlate(plBV, lb, true); dAtc.key = ""; dMon.key = ""; hsG.forEach(o => o.last = null); }
    for(const [p, fn, n] of [[mcPlate, paintMC, np], [bvPlate, paintBV, BV_N]]){ const m = p.material.map, c = m.image; fn(c.getContext("2d"), c.width, c.height, n); m.needsUpdate = true; }
    MC.position.x = hs ? 0.3 : -0.42; BV.position.x = hs ? -0.42 : 0.3; { const e = document.getElementById("cabhint"); if(e) e.textContent = hs ? "右: マスコン（上へドラッグ＝加速） ／ 左: ブレーキ（下へドラッグ＝強く）　キー: W/S・↓/↑・非常 Space" : "左のマスコン・右のブレーキハンドルを左右にドラッグして回せます（キー: マスコン W/S、ブレーキ ↓/↑）"; } st.mcAng = Math.max(MC_N * MC_STEP, st.mcAng); st.bvAng = Math.max(BV_N * BV_STEP, st.bvAng);
  }
  return { update, render, setNotches, bind(a) { api = a; }, setDial(max, ticks) { gSpeed.max = max; gSpeed.ticks = ticks; gSpeed.last = -1; }, active: false, dragging: () => !!st.drag, screenPos };
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
    sedan: { L: 2.7, rearOff: 1.35, vmax: 180 / 3.6, drive: 3.4, brake: 8.0, grip: 0.9, ratio: 14.5, maxW: 7.85, speedSens: 75, cmf: { acc: 4.6, lat: 4.6 },
             corners: [[2.2, 0.85], [2.2, -0.85], [-2.2, 0.85], [-2.2, -0.85], [2.3, 0]], len: 4.5, wid: 1.8,
             drv: { x: -0.37, y: 1.22, f: 0.15 }, cam: { back: 8.5, up: 3.2, look: 3 } },
    // v41.7: 2t トラック（キャブオーバー・箱型）: 軸距 3.35m・全長 6.0m・全幅 1.88m・最小回転半径 約 5.2m。最高 90km/h（速度抑制装置相当）
    truck: { L: 3.35, rearOff: 1.9, vmax: 90 / 3.6, drive: 2.2, brake: 6.2, grip: 0.7, ratio: 15, maxW: 7.85, speedSens: 105, cmf: { acc: 4.0, lat: 4.0 }, pitchK: 0.0055, rollK: 0.011,
             corners: [[2.8, 0.92], [2.8, -0.92], [-3.0, 0.92], [-3.0, -0.92], [2.8, 0], [1.2, 0.95], [1.2, -0.95], [-0.8, 0.95], [-0.8, -0.95], [-2.0, 0.95], [-2.0, -0.95]], len: 6.0, wid: 1.88,
             drv: { x: -0.5, y: 2.05, f: 1.75 }, cam: { back: 11.5, up: 4.3, look: 4, lookH: 1.8 } },
    // 三菱ふそう エアロスター（ノンステップ 10.5m 級）相当: 軸距 5.3m・全幅 2.49m・最小回転半径 約 8.3m
    bus:   { L: 5.3, rearOff: 2.75, vmax: 80 / 3.6, drive: 1.35, brake: 5.5, grip: 0.62, ratio: 13.5, maxW: 7.85, speedSens: 140, cmf: { acc: 3.6, lat: 3.6 },
             corners: [[5.2, 1.2], [5.2, -1.2], [-5.2, 1.2], [-5.2, -1.2], [5.3, 0], [2.6, 1.25], [2.6, -1.25], [0, 1.25], [0, -1.25], [-2.6, 1.25], [-2.6, -1.25]], len: 10.5, wid: 2.49,
             drv: { x: -0.7, y: 2.2, f: 4.6 }, cam: { back: 17, up: 5.6, look: 6 } },
  };
  let P = PROFILES.sedan;
  const L0 = 2.7;
  function setGrid(meta, buf) {
    const n = meta.nx * meta.nz;
    G = { ...meta, H: new Int16Array(buf, 0, n), K: new Uint8Array(buf, n * 2, n) };
    if (meta.bnx && buf.byteLength >= n * 3 + meta.brow * meta.bnz) G.B = new Uint8Array(buf, n * 3, meta.brow * meta.bnz);
    // v32: 橋・高架が道路の上を通る所の「上の段」（升目の番号・高さ cm・区分）。今の高さに近い段を使う
    G.UM = null;
    if (meta.up) { const o = n * 3 + meta.brow * meta.bnz, c = meta.up;
      const ui = new Int32Array(buf.slice(o, o + 4 * c)), uh = new Int16Array(buf.slice(o + 4 * c, o + 6 * c)), uk = new Uint8Array(buf.slice(o + 6 * c, o + 7 * c));
      G.UM = new Map(); for (let i = 0; i < c; i++) G.UM.set(ui[i], i); G.UH = uh; G.UK = uk; }
  }
  // v32: 升目 k の高さ（cm）。yref（m）があり上の段がある時は、yref に近い方の段
  function hk(k, yref) {
    const h = G.H[k]; if (!G.UM || yref === undefined) return h;
    const u = G.UM.get(k); if (u === undefined) return h;
    const hu = G.UH[u]; return Math.abs(yref * 100 - hu) < Math.abs(yref * 100 - h) ? hu : h;
  }
  // v14: 建物に入っているか（1m のビット列。無ければ 2m 格子の種類）
  // v37: データ（PLATEAU）の範囲の外（山陽道など）は ext（MW）から高さ・種類・壁を得る
  let ext = null; const inG = (x, z) => G && x >= G.x0 && z >= G.z0 && x < G.x0 + G.nx * G.step && z < G.z0 + G.nz * G.step;
  function blocked(x, z) {
    if (ext && ext.blocked(x, z, C.h)) return 1;
    if (ext && !inG(x, z)) return 0;
    if (G.B) { const i = Math.floor((x - G.x0) / G.bstep), j = Math.floor((z - G.z0) / G.bstep);
      if (i < 0 || j < 0 || i >= G.bnx || j >= G.bnz) return false;
      return (G.B[j * G.brow + (i >> 3)] >> (7 - (i & 7))) & 1; }
    return kindAt(x, z) === 9;
  }
  function cell(x, z) { const i = Math.floor((x - G.x0) / G.step), j = Math.floor((z - G.z0) / G.step); return (i < 0 || j < 0 || i >= G.nx || j >= G.nz) ? -1 : j * G.nx + i; }
  function hAt(x, z, yref) {
    if (!G) return 0;
    if (ext) { const yr = yref === undefined ? C.h : yref, r = ext.road(x, z, yr); if (r === r) return r; if (!inG(x, z)) return ext.h(x, z, yr); }
    const fx = (x - G.x0) / G.step - 0.5, fz = (z - G.z0) / G.step - 0.5;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(G.nz - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), k = j * G.nx + i;
    if (!G.UM || yref === undefined) return ((G.H[k] * (1 - tx) + G.H[k + 1] * tx) * (1 - tz) + (G.H[k + G.nx] * (1 - tx) + G.H[k + G.nx + 1] * tx) * tz) / 100;
    return ((hk(k, yref) * (1 - tx) + hk(k + 1, yref) * tx) * (1 - tz) + (hk(k + G.nx, yref) * (1 - tx) + hk(k + G.nx + 1, yref) * tx) * tz) / 100;
  }
  function kindAt(x, z, yref) { if (ext) { const yr = yref === undefined ? C.h : yref; const r = ext.road(x, z, yr); if (r === r) return 1; if (!inG(x, z)) return 0; } const k = cell(x, z); if (k < 0) return 9;
    if (G.UM && yref !== undefined) { const u = G.UM.get(k); if (u !== undefined && Math.abs(yref * 100 - G.UH[u]) < Math.abs(yref * 100 - G.H[k])) return G.UK[u]; }
    return G.K[k]; }
  // v41.8: addBlock で足した壁を外す（配送センターの倉庫など、ミッションの間だけ置く施設用。元は空き地だった所だけに使う）
  function clearBlock(x, z, r) { if (!G || !G.B) return; for (let dz = -r; dz <= r; dz += 1) for (let dx = -r; dx <= r; dx += 1) { const i = Math.floor((x + dx - G.x0) / G.bstep), j = Math.floor((z + dz - G.z0) / G.bstep); if (i < 0 || j < 0 || i >= G.bnx || j >= G.bnz) continue; G.B[j * G.brow + (i >> 3)] &= ~(1 << (7 - (i & 7))); } }
  // v23: 橋脚などを衝突判定（1m のビット列）に加える
  function addBlock(x, z, r) { if (!G || !G.B) return; for (let dz = -r; dz <= r; dz += 1) for (let dx = -r; dx <= r; dx += 1) { const i = Math.floor((x + dx - G.x0) / G.bstep), j = Math.floor((z + dz - G.z0) / G.bstep); if (i < 0 || j < 0 || i >= G.bnx || j >= G.bnz) continue; G.B[j * G.brow + (i >> 3)] |= (1 << (7 - (i & 7))); } }

  // ---- 車体 ----
  const car = new THREE.Group();
  const body = new THREE.Group(); car.add(body);
  // v41.9: 自分の車は vehicles.js の曲面の車体（窓は透明・車内あり・車輪は回る/曲がる）
  const HI = Veh.hi("sedan", { color: new THREE.Color(0xe9eaec) }), hiU = HI.userData;
  body.add(hiU.body); for (const w of hiU.wheels) car.add(w.steer);
  car.visible = false; scene.add(car);
  /* v41.10: タクシー営業の車（黄色い車体＋屋根の行灯。行灯は 空車=緑・迎車=橙・賃走=赤）。mode が "" なら普通の車（白）に戻す */
  const taxiL = { g: null, face: [], on: false, tex: {} };
  const lampTex = (txt, col) => canvasTex(128, 64, (g, w, h) => { g.fillStyle = col; g.fillRect(0, 0, w, h); g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 5; g.strokeRect(4, 4, w - 8, h - 8); g.fillStyle = "#fff"; g.font = "bold 42px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, w / 2, h / 2 + 2); });
  function setTaxi(mode, col){
    if(!mode){ if(taxiL.g) taxiL.g.visible = false; if(taxiL.on){ hiU.setPaint(new THREE.Color(0xe9eaec)); taxiL.on = false; } return; }
    if(!taxiL.g){ const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.28), new THREE.MeshLambertMaterial({ color: 0xe8e8e4 })));
      for(const sg of [1, -1]){ const f = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.17), new THREE.MeshBasicMaterial({ color: 0xffffff })); f.position.z = 0.141 * sg; if(sg < 0) f.rotation.y = Math.PI; g.add(f); taxiL.face.push(f); }
      g.position.set(0, 1.58, -0.2); body.add(g); taxiL.g = g; }
    const k = mode + col; if(!taxiL.tex[k]) taxiL.tex[k] = lampTex(mode, col);
    for(const f of taxiL.face){ f.material.map = taxiL.tex[k]; f.material.needsUpdate = true; }
    taxiL.g.visible = true; if(!taxiL.on){ hiU.setPaint(new THREE.Color(0xf2c230)); taxiL.on = true; }
  }
  const eyeV = new THREE.Vector3(), tgtV = new THREE.Vector3();
  /* v41.11: 運転席視点の見回し。Q=左 E=右 Z=後ろ（押している間）、画面のドラッグ、ゲームパッドの右スティック／LB・RB。離すとなめらかに正面へ戻る。
     手で見回していないときは、ハンドルを切った向き（曲がる向き）へ自動で視線を向ける。yaw は左が正（車の局所座標で +x が左） */
  const look = { m: 0, mp: 0, auto: 0, yaw: 0, pitch: 0, drag: false, x0: 0, y0: 0, dYaw: 0, dPitch: 0, hint: 0 };
  function lookUpdate(dt) {
    let tY = ((key["q"] ? 1 : 0) - (key["e"] ? 1 : 0)) * 1.25 + (key["z"] ? 3.0 : 0), tP = 0;
    const pin = (typeof Pad !== "undefined" && Pad.PIN.active) ? Pad.PIN : null;
    if (pin) { tY += -pin.lookX * 1.9; tP += -pin.lookY * 0.6; }
    if (look.drag) { tY += look.dYaw; tP += look.dPitch; }
    const manual = Math.abs(tY) > 0.01 || Math.abs(tP) > 0.01;
    look.m += (tY - look.m) * Math.min(1, dt * (manual ? 10 : 6)); look.mp += (tP - look.mp) * Math.min(1, dt * (manual ? 10 : 6));
    const aT = Math.max(-0.5, Math.min(0.5, C.steer * 1.1)) * Math.min(1, Math.abs(C.v) / 3);
    look.auto += (aT - look.auto) * Math.min(1, dt * 3.5);
    look.yaw = look.m + look.auto * (1 - Math.min(1, Math.abs(look.m) / 0.35)); look.pitch = look.mp;
  }
  function viewHint() { if (C.view === "driver" && look.hint < 3) { look.hint++; C.msg = "Q / E キー（または画面をドラッグ）で左右を見られます。Z で後ろ"; C.msgT = 4; } }
  function setView(v) { C.view = v; viewHint(); }
  canvas.addEventListener("pointerdown", e => { if (!C.active || C.view !== "driver" || (e.pointerType === "mouse" && e.button !== 0)) return; look.drag = true; look.x0 = e.clientX; look.y0 = e.clientY; look.dYaw = look.dPitch = 0; try { canvas.setPointerCapture(e.pointerId); } catch (x) {} });
  canvas.addEventListener("pointermove", e => { if (!look.drag) return; look.dYaw = Math.max(-2.1, Math.min(2.1, -(e.clientX - look.x0) * 0.006)); look.dPitch = Math.max(-0.5, Math.min(0.6, (look.y0 - e.clientY) * 0.004)); });
  const lookEnd = () => { look.drag = false; look.dYaw = look.dPitch = 0; };
  canvas.addEventListener("pointerup", lookEnd); canvas.addEventListener("pointercancel", lookEnd);

  // ---- 入力 ----
  const key = {};
  addEventListener("keydown", e => { if (!C.active || typing()) return; key[e.key.toLowerCase()] = true;
    if (e.key === "v" || e.key === "V") setView(C.view === "chase" ? "driver" : "chase");
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
    $("car-view").addEventListener("click", () => { setView(C.view === "chase" ? "driver" : "chase"); });
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
    const wet = Env.st.rain, brakeA = (C.brk * P.brake + (key[" "] ? 6 : 0)) * (wet ? 0.85 : 1);   // v41.14: 雨の路面は止まりにくい（ブレーキ ×0.85・横のグリップ ×0.78）
    const resist = 0.12 + 0.00045 * sp * sp + (C.thr < 0.05 ? 0.25 : 0);           // 転がり・空気抵抗・エンジンブレーキ
    // 勾配
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw);
    const hl = P.L / 2;
    // v39: 橋・高架の際や段の違う路面で、車輪の下の高さを段ごとに別々に拾うと、車が沈み込んだり跳ねたりする。
    //      中心の路面高さ hc からの差を ±0.7m に抑え（急な坂でも車体の前後で 0.7m 以上は違わない）、上下の動きの速さにも上限を付ける
    const hc = hAt(C.x, C.z, C.h), clW = (v) => Math.max(hc - 0.7, Math.min(hc + 0.7, v));
    const hf = clW(hAt(C.x + fx * hl, C.z + fz * hl, C.h)), hb = clW(hAt(C.x - fx * hl, C.z - fz * hl, C.h));
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
    const aLat = Math.abs(yawRate * C.v), aMax = P.grip * 9.8 * (wet ? 0.78 : 1);
    C.aLat = aLat;
    // v41.16: 乗り心地の判定用「体に感じる加速度」。坂の成分は除き、0.45 秒ぶんなめらかにならす（1 フレームの揺れや、キーを一瞬押しただけでは減点しない）。衝突の直後は数えない（衝突は別に減点）
    { const fAcc = C.acc + 9.8 * grade, fLat = Math.min(aLat, aMax), k = 1 - Math.exp(-dt / 0.45);
      if (C.hitT > 0.7) { C.accF = (C.accF || 0) * 0.9; C.latF = (C.latF || 0) * 0.9; }
      else { C.accF = (C.accF || 0) + (fAcc - (C.accF || 0)) * k; C.latF = (C.latF || 0) + (fLat - (C.latF || 0)) * k; } }
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
    const lz = clW(hAt(C.x + sx * P.wid * 0.45, C.z + sz * P.wid * 0.45, C.h)), rz = clW(hAt(C.x - sx * P.wid * 0.45, C.z - sz * P.wid * 0.45, C.h));
    { const hn = (hf + hb + lz + rz) / 4, vmax = (3 + 0.2 * Math.abs(C.v)) * dt;   // 上下は秒速 3m + 速度×0.2 まで（段差でも瞬間移動しない）
      C.h = Math.abs(hn - C.h) > 4 ? hn : C.h + Math.max(-vmax, Math.min(vmax, hn - C.h)); }
    const pitchT = Math.atan(grade) - (a - Math.sign(C.v) * brakeA) * (P.pitchK || (P === PROFILES.bus ? 0.006 : 0.004)), rollT = Math.atan((lz - rz) / (P.wid * 0.9)) + Math.sign(C.v) * yawRate * Math.abs(C.v) * (P.rollK || (P === PROFILES.bus ? 0.012 : 0.006));
    C.pitch += (pitchT - C.pitch) * Math.min(1, dt * 6); C.roll += (rollT - C.roll) * Math.min(1, dt * 6);
    // エンジン回転（6速 AT の簡易シフト）
    const kmh = sp * 3.6, gearN = C.gear === "R" ? 1 : Math.min(6, 1 + Math.floor(kmh / 22));
    const ratio = [0, 3.6, 2.1, 1.4, 1.0, 0.8, 0.65][gearN];
    const target = 800 + kmh * ratio * 32 + C.thr * 900;
    C.rpm += (Math.min(6500, target) - C.rpm) * Math.min(1, dt * 6); C.gearN = gearN;
    place(dt);
  }
  function place(dt) {
    car.position.set(C.x, C.h, C.z);
    car.rotation.set(0, 0, 0); car.rotateY(C.yaw); body.rotation.set(-C.pitch, 0, C.roll); if (extBody) extBody.rotation.set(-C.pitch, 0, C.roll);
    if (P === PROFILES.sedan) { hiU.drive(C.v, dt || 0.016, C.steer); hiU.update(C); }
    else if (P === PROFILES.truck && extBody && extBody.userData.hiU) extBody.userData.hiU.update(C);   // v41.14: トラックのワイパー・水滴
    if (extBody && extBody.userData.spin) for (const w of extBody.userData.spin) { w.m.rotation.x += C.v * 0.016 / (w.r || 0.42); if (w.front) w.grp.rotation.y = C.steer; }
  }
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCam(dt) {
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw);
    const isBus = P !== PROFILES.sedan;   // v41.7: バス・トラックなど外観を差し込む車（運転席・窓の扱いが乗用車と違う）
    if (C.view === "driver") {
      if (C.onDriverView) C.onDriverView(true);
      const rigB = !isBus ? body : (extBody && extBody.userData.hiU ? extBody : null), rigU = !isBus ? hiU : (rigB ? extBody.userData.hiU : null);
      if (rigB) {   // 乗用車・トラック: 車体に固定した目の位置（車体の傾き・ゆれがそのまま視界に入る）
        car.updateMatrixWorld(true);
        lookUpdate(dt);
        const e = rigU.eye; eyeV.set(e.x, e.y, e.z); rigB.localToWorld(eyeV); tgtV.set(e.x + Math.sin(look.yaw) * 20, e.y - Math.tan(e.pitch * Math.PI / 180) * 20 + Math.tan(look.pitch) * 20, e.z + Math.cos(look.yaw) * 20); rigB.localToWorld(tgtV);
        camera.up.set(0, 1, 0).transformDirection(rigB.matrixWorld);
        camera.position.copy(eyeV); camera.lookAt(tgtV);
        if (camera.near > 0.15) { camera.near = 0.12; camera.updateProjectionMatrix(); }
        rigU.setSky(hemi.color); rigU.setInside(true);
      } else {
        const sx = Math.cos(C.yaw), sz = -Math.sin(C.yaw), d = P.drv;
        lookUpdate(dt); const cy = Math.cos(look.yaw), sy = Math.sin(look.yaw);
        camera.position.set(C.x + sx * d.x + fx * d.f, C.h + d.y, C.z + sz * d.x + fz * d.f);
        camera.lookAt(C.x + (fx * cy + sx * sy) * 20 + fx * d.f + sx * d.x, C.h + d.y - 0.22 + Math.sin(-C.pitch) * 20 + Math.tan(look.pitch) * 20, C.z + (fz * cy + sz * sy) * 20 + fz * d.f + sz * d.x);
      }
      // 画角: 横が見えるように広く（横の画角が約 100°。縦長の画面でも縦 88° まで）。車の外から見る視点では元の 56° に戻す
      { const fv = Math.max(62, Math.min(88, 2 * Math.atan(Math.tan(50 * Math.PI / 180) / camera.aspect) * 180 / Math.PI)); if (Math.abs(camera.fov - fv) > 0.05) { camera.fov = fv; camera.updateProjectionMatrix(); } }
    } else {
      if (C.onDriverView) C.onDriverView(false);
      if (camera.near < 0.2 || camera.fov !== 56) { camera.near = 0.3; camera.fov = 56; camera.updateProjectionMatrix(); }
      camera.up.set(0, 1, 0); hiU.setInside(false); if (extBody && extBody.userData.hiU) extBody.userData.hiU.setInside(false);
      const back = C.v < -0.5 ? -1 : 1;   // 後退時も車の後ろ（進行方向の反対側）から
      const want = new THREE.Vector3(C.x - fx * P.cam.back, C.h + P.cam.up, C.z - fz * P.cam.back);
      if (camPos.lengthSq() === 0 || camPos.distanceTo(want) > 40) camPos.copy(want);
      camPos.lerp(want, Math.min(1, dt * 4));
      const gh = hAt(camPos.x, camPos.z, camPos.y) + 0.6; if (camPos.y < gh) camPos.y = gh;
      if (C.camCeil) { const cy = C.camCeil(camPos.x, camPos.z); if (camPos.y > cy) camPos.y = Math.max(gh, cy); }
      camLook.set(C.x + fx * P.cam.look, C.h + (P.cam.lookH || (isBus ? 2.0 : 1.0)), C.z + fz * P.cam.look);
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
    $("car-msg").textContent = C.hitT > 0 ? "衝突しました（" + (C.hitWhat || "建物") + "）" : C.msgT > 0 ? C.msg : C.gear === "R" ? "後退中 — ↓ で下がる・↑ で止まる（後方に注意）" : (kindAt(C.x, C.z, C.h) === 2 ? "歩道・交通島の上です" : "");
    $("car-place").textContent = "走行距離 " + (C.odo / 1000).toFixed(2) + " km";
  }
  function start() {
    C.active = true; car.visible = true; C.v = 0; C.gear = "D"; C.wheel = 0; C.x = 60; C.z = 6.5; C.yaw = Math.PI / 2;
    // 桃太郎大通り（岡山駅前〜）の東行き車線が見つからない場合は近くの車道へ
    if (G && kindAt(C.x, C.z) !== 1) { outer: for (let r = 1; r < 40; r++) for (let a = 0; a < 16; a++) { const x = 60 + Math.cos(a / 16 * 6.283) * r, z = 6.5 + Math.sin(a / 16 * 6.283) * r; if (kindAt(x, z) === 1) { C.x = x; C.z = z; break outer; } } }
    C.h = hAt(C.x, C.z); camPos.set(0, 0, 0);
    if (Env.st.rain) { C.msg = "雨です。路面が滑りやすいので、車間を広めに。ワイパーが動いています"; C.msgT = 5; }
  }
  function stop() { C.active = false; car.visible = false; camera.up.set(0, 1, 0); lookEnd(); if (camera.near < 0.2 || camera.fov !== 56) { camera.near = 0.3; camera.fov = 56; camera.updateProjectionMatrix(); } }
  // 車種の切り替え（バスモード）。外観は extBody（バスの車体など）を差し込んで使う
  let extBody = null;
  function setProfile(name, ext) {
    P = PROFILES[name] || PROFILES.sedan; C.profile = name;
    if (extBody) { car.remove(extBody); extBody = null; }
    const own = name === "sedan";
    body.visible = own; for (const w of hiU.wheels) w.steer.visible = own;
    if (!own && ext) { extBody = ext; car.add(ext); }
  }
  function setExt(e) { ext = e; }
  return { C, setGrid, tick, updateCam, hud, start, stop, bindUI, hAt, kindAt, blocked, addBlock, clearBlock, setProfile, setExt, setTaxi, inG, get G() { return G; }, get P() { return P; } };
})();

/* ---------------- 運転 ---------------- */
/* 加減速（一般的な路面電車の性能値。km/h/s）
   力行 P1〜P4: 低速域は一定、約20km/h 以上は定出力で低下 / 制動 B1〜B5（常用最大 4.0）/ 非常 5.0
   加減速度の変化は緩やか（ジャーク制限）。走行抵抗と勾配（軌道の実高さ）も加味 */
const P_ACC = [0, 0.9, 1.7, 2.4, 3.0];
const B_DEC = [0, 0.8, 1.6, 2.4, 3.2, 4.0];
const _sndS = { speed:0, acc:0, notch:0, emergency:false, motor:"vvvf", pos:0 };
function targetAccel(){
  const v = S.speed;
  let a = 0;
  const V=VEH(), kn=V.knee||20;
  if(S.emergency) a = -(V.ebk||5.0);
  else if(V.hs && S.atc) a = -2.2;                                   // ATC の自動ブレーキ（指示速度を超えたとき）
  else if(S.notch > 0 && V.hs){                                       // 新幹線: 全ノッチの力 × ノッチ/段数。定トルク→定出力→(高速で)自然特性
    const k1 = V.hsK[0], k2 = V.hsK[1], F = V.hsA * (v <= k1 ? 1 : v <= k2 ? k1 / v : k1 * k2 / (v * v));
    a = F * (S.notch / V.np) * Math.max(0, Math.min(1, (V.vmax - v) / 4)); }
  else if(S.notch > 0){ a = V.acc[S.notch] * (v > kn ? kn / v : 1) * Math.max(0, Math.min(1, (V.vmax - v) / 4)); }
  else if(S.notch < 0){ const T = V.bdec||B_DEC; a = -(T[Math.min(-S.notch, T.length-1)] || 0); }   // 非常位置（段数+1）は表の範囲外 → 最大値で頭打ち（undefined→NaN で動かなくなるのを防ぐ）
  if(v > 0.05){ const dg=V.drag; a -= dg ? dg[0] + dg[1]*v + dg[2]*v*v : 0.05 + 0.0012*v + 0.00003*v*v; }
  const g = (pointAt(S.pos+15).y - pointAt(S.pos-15).y) / 30;   // 勾配は ±15m で平均（路線高さデータの 0.6m の段差が ±4m だと 7% の急坂になり、電車が動けなくなっていた）
  if(v > 0.05 || a > 0) a -= 35.3 * g;
  return a;
}
function routeSignalState(sg){ if(sg.block!=null) return Trams.blockFree(sg.block, Trams.PLAYER) ? 0 : 2; return sg.g==null ? 0 : phaseState(sg.g, sg.ph, S.t); }
let lastWarn=0;
function atcUpdate(){      // 新幹線の ATC: 指示速度 = 現在の制限と、前方の制限へ向かう減速パターン（0.55m/s²）の小さいほう。超えたら自動ブレーキ、指示速度の 3km/h 下で解除
  const lim = limitAt(S.pos); let allow = lim;
  const i0 = idxAt(S.pos), mi = Math.min(S.speedLim.length - 1, i0 + 3000);
  for(let i = i0 + 5; i <= mi; i += 5){ const m = S.speedLim[i]; if(m >= allow) continue; const d = Math.max(0, S.arc[i] - S.pos - 10); allow = Math.min(allow, Math.sqrt((m / 3.6) ** 2 + 2 * 0.55 * d) * 3.6); }
  S.atcAllow = allow;
  if(!S.atc && S.speed > allow + 1 && S.speed > 3){ S.atc = true; S.score = Math.max(0, S.score - 15); setSubtitle("ATC 作動: 指示速度 " + Math.round(allow) + " km/h を超えたため自動ブレーキがかかります（-15点）。"); Snd.atc(true); }
  else if(S.atc && (S.speed <= allow - 3 || S.speed < 1)){ S.atc = false; Snd.atc(false); }
}
function tick(dt){
  S.t += dt;
  if(VEH().hs && S.running) atcUpdate(); else if(S.atc){ S.atc = false; Snd.atc(false); }
  let tgt = targetAccel(); if(!Number.isFinite(tgt)) tgt = 0;
  if(!Number.isFinite(S.acc)) S.acc = 0; if(!Number.isFinite(S.speed)) S.speed = 0;
  const VJ = VEH(); const rate = VJ.hs ? ((tgt < S.acc) ? 2.4 : 1.5) : ((tgt < S.acc) ? 4.5 : 3.0);   // 加減速度の変化の速さ（km/h/s²）。新幹線は緩やか
  const prevAcc = S.acc;
  S.acc += Math.max(-rate*dt, Math.min(rate*dt, tgt - S.acc));
  S.speed = Math.max(0, Math.min(VEH().jr ? VEH().vmax + 2 : 50, S.speed + S.acc*dt));
  if(S.speed === 0 && S.acc < 0) S.acc = 0;
  if(S.speed === 0 && S.emergency && S.bv < NB()+1) S.emergency = false;   // 非常ブレーキは停止後もハンドルを戻すまで保持（戻したら解除）
  $("accel").textContent = (S.acc>=0?"+":"") + S.acc.toFixed(1);
  const lim=limitAt(S.pos); { let nx=null; if(VEH().jr){ const i0=idxAt(S.pos), mi=Math.min(S.speedLim.length-1,i0+400); let m=lim; for(let i=i0+5;i<=mi;i+=5){ if(S.speedLim[i]<m){ m=S.speedLim[i]; nx=[m, S.arc[i]-S.pos]; } } } $("limit").textContent=nx?lim+"→"+nx[0]:lim; $("limit").title=nx?"あと "+Math.round(nx[1])+" m で制限 "+nx[0]+" km/h":""; }
  if(S.speed>lim+5){ S.score=Math.max(0,S.score-dt*8); if(performance.now()-lastWarn>1500){ setSubtitle("制限速度 "+lim+"km/h を超えています。"); lastWarn=performance.now(); } }
  const CMF=VEH().cmf||3.8;
  if(Math.abs(S.acc) > CMF && !S.emergency) S.score=Math.max(0,S.score-dt*6);
  if(S.speed>1 && Math.abs(S.acc)>CMF-0.2 && !S._harsh){ S._harsh=true; S.comfortHits++; } else if(Math.abs(S.acc)<CMF-0.8) S._harsh=false;
  const old=S.pos;
  if(!S.doorOpen) S.pos=Math.min(S.total-0.8, S.pos+S.speed/3.6*dt);
  // 閉そく区間の確保・解放
  if(S.blockIv) for(const q of S.blockIv){ const B=Trams.blocks[q.b]; if(!B) continue; const near=S.pos>q.s0-30 && S.pos-VEH().len<q.s1+1;
    if(near && B.owner===null) B.owner=Trams.PLAYER; if(!near && B.owner===Trams.PLAYER && !S.blockIv.some(r=>r.b===q.b && S.pos>r.s0-30 && S.pos-VEH().len<r.s1+1)) B.owner=null; }
  // 前方の電車・車
  if(S.P){ const JRV=VEH().jr; let ob=Trams.gapAhead(S.P, old, JRV ? Math.min(700, 60 + (S.speed/3.6)*(S.speed/3.6)/1.4) : 60, Trams.PLAYER, 1.15, JRV ? ((o)=>!!(o && (o.type || o.ped || o.danger))) : undefined);
    if(JRV){ const jg=JR.aheadGap(); if(jg!=null && (!ob || jg<ob.d)) ob={d:jg, o:{}}; }
    if(ob){ const what = ob.o && ob.o.type ? "車" : "電車";
      if(ob.d<0.6){ S.pos=old; if(S.speed>2 && performance.now()-(S._hitT||0)>4000){ S._hitT=performance.now(); const pen=JRV?Math.min(S.score, 60+S.speed):60; S.score=Math.max(0,S.score-pen); setSubtitle("前の"+what+"に衝突しました（-"+Math.round(pen)+"点）。"); } S.speed=0; S.acc=0; }
      else if(ob.d<(JRV?Math.min(500,80+S.speed*3):45) && S.speed>6 && performance.now()-(S._obT||0)>5000){ S._obT=performance.now(); setSubtitle("前方に"+what+"がいます（約"+Math.round(ob.d)+"m）。減速してください。"); } } }
  else if(S.speed>0.5){ setSubtitle("ドアが開いています。"); S.speed=Math.max(0,S.speed-2*dt); }
  if(S.pos>=S.total-0.8 && S.speed>0){ if(S.speed>3){ const pen=VEH().jr?Math.min(S.score, 40+S.speed*2):40; S.score=Math.max(0,S.score-pen); setSubtitle(VEH().jr?"線路の終端（再現範囲の端）に達しました（-"+Math.round(pen)+"点）。":"車止めに当たりました（-40点）。"); } S.speed=0; S.acc=0; }
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
    $("sgtxt").textContent = S.phase==="pull" ? (inZone && S.speed<0.4 ? "引上線に停車。D で運転台を交換します" : "引上線の停止目標まで "+Math.max(0,ds).toFixed(1)+" m") : S.doorOpen ? "停車中" : ds>60 ? (VEH().jr ? "次の停車まで "+(ds>=1000?(ds/1000).toFixed(1)+" km":Math.round(ds)+" m")+" ／ ブレーキ目安 "+Math.round(3.6*Math.sqrt(2*((VEH().bdec[Math.round(NB()*0.8)]||2.4)/3.6)*0.8*Math.max(0,ds-15)))+" km/h 以下" : "停止位置: ホーム先端の標識に車両先頭を合わせる") : inZone ? (S.speed<0.4?"ホーム内です。ドアを開けられます（D）"+(Math.abs(ds)>1?"　目標まで "+ds.toFixed(1)+" m":""):"ホーム内（停止目標まで "+ds.toFixed(1)+" m）") : ds>0 ? "停止位置まで "+ds.toFixed(1)+" m" : "停止位置を "+(-ds).toFixed(1)+" m 行き過ぎ";
    sg.classList.toggle("ok", inZone && !S.doorOpen);
    $("sgmark").style.left = (50 - Math.max(-15, Math.min(15, ds)) / 15 * 50) + "%"; }
  if(VEH().jr){ _sndS.speed=Math.min(S.speed,50); _sndS.acc=Math.max(-3,Math.min(3,S.acc)); _sndS.notch=S.notch; _sndS.emergency=S.emergency; _sndS.motor=S.motor; _sndS.pos=S.pos; _sndS.hs=!!VEH().hs; _sndS.vk=S.speed; _sndS.pf=S.notch>0?S.notch/NP():0; _sndS.bf=(S.notch<0&&!S.emergency)?-S.notch/NB():0; _sndS.tun=VEH().hs?JR.playerTun(S.pos):false; _sndS.atc=!!S.atc; _sndS.inside=(S.view==='cab'); Snd.update(dt, _sndS); } else Snd.update(dt, S);
  if(!S.doorOpen && S.stopIndex<S.stops.length-1 && S.pos > S.cum[S.stopIndex] + 6){
    const passed=S.stops[S.stopIndex].name; Dia.onPass(S.stopIndex); S.stopIndex++; S._appr=false;
    $("stop-seq").textContent=S.stopIndex+" / "+(S.stops.length-1); $("next-stop").textContent=S.stops[S.stopIndex].name;
    setSubtitle(passed.replace(/・.*$/,"")+" を通過しました。"); setTimeout(annDepart, 1200);
  }
  if(!S.doorOpen && !S._appr && ds < (VEH().jr ? 500 + S.speed*3 : 140) && ds > 20 && S.speed > 3){ S._appr = true; annApproach(); }
  const s0=S.cum[S.stopIndex-1]||0, s1=S.cum[S.stopIndex]; $("stop-progress").style.width=(Math.min(1,Math.max(0,(S.pos-s0)/(s1-s0||1)))*100).toFixed(1)+"%";
  const p=pointAt(S.pos);
  for(const lm of (S.routes.landmarks||[])){ if(S.announced.has(lm.name)) continue; if(Math.hypot(lm.x-p.x,lm.z-p.z)<60&&S.speed>1){ S.announced.add(lm.name); setSubtitle("「"+lm.name+"」付近を通過します。"); } }
  $("speed").textContent=Math.round(S.speed); $("cabspd").textContent=Math.round(S.speed); $("score").textContent=Math.round(S.score); $("comfort").textContent="快適 "+Math.round(S.score/10)+"%";
  $("drive-state").textContent=S.doorOpen?"停車中":(S.speed<1?"発車準備":"走行中");
  S.clock+=dt; Dia.tick(); const hh=Math.floor(S.clock/3600)%24, mm=Math.floor(S.clock/60)%60; $("clock").textContent=String(hh).padStart(2,"0")+":"+String(mm).padStart(2,"0");
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
      Dia.onOpen(S.stopIndex);
      if(S.stopIndex>=S.stops.length-1) setTimeout(()=>{ if(S.running) finishRide(); },1500);
    } else if(S.speed<0.4) setSubtitle(ds>0?"停止位置の手前です（あと"+Math.round(ds)+"m）。":"停止位置を"+Math.round(-ds)+"m 行き過ぎました。");
    else setSubtitle("走行中はドアを開けられません。");
  } else {
    S.doorOpen=false; $("door").textContent="閉"; Snd.door(false);
    if(S.phase==="pull"){ setSubtitle("奥の線路（引上線）へ進み、停止目標で止まったら D（ドア）で運転台を交換します。"); return; }
    Dia.onClose(S._openedAt===S.stopIndex ? S.stopIndex : S.stopIndex-1);
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
  $("finish-text").textContent=S.route.name+" "+S.stops[0].name.replace(/・.*$/,"")+" → "+S.stops[S.stops.length-1].name.replace(/・.*$/,"")+"（"+Math.round(S.endArc-S.cum[0])+" m）\n評価: "+g+"（快適スコア "+Math.round(S.score)+" / 1000）\n衝撃減点回数: "+S.comfortHits+"回"; { const dr=Dia.result(); if(dr){ $("finish-text").textContent+=Dia.summary(); const R2=Prefs.record("dia:"+(S.baseKey||S.key), dr.dia); if(R2.newBest && R2.n>1) $("finish-text").textContent+="（ダイヤ自己ベスト更新！）"; } }
  TT.fillFinish(Dia.model(true)); $("finish-overlay").classList.add("on"); }

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
  Dia.build();
  if(S.vehicle && S.vehicle!=="momo") setVehicle(S.vehicle);
  mapCache=null; $("route-name").textContent=S.route.name; $("next-stop").textContent=S.stops[S.stopIndex].name; $("stop-seq").textContent=S.stopIndex+" / "+(S.stops.length-1);
  if(S.doorOpen){ S._appr=false; setTimeout(annStart, 600); setSubtitle(S.stops[0].name.replace(/・.*$/,"")+"。折り返し、"+S.route.dest+"行きになります。ドアを閉めて発車してください。"); }
}
function fadeMsg(t, fn){ const f=$("fade"); $("fade-text").textContent=t; f.classList.add("on"); setTimeout(()=>{ fn(); setTimeout(()=>f.classList.remove("on"), 500); }, 900); }
function applyHandles(){
  const prev=S.notch;
  if(S.bv>=NB()+1){ if(!S.emergency){ S.emergency=true; S.score=Math.max(0,S.score-10); setSubtitle("非常ブレーキを作動しました。停止後、ブレーキハンドルを戻してください。"); } S.notch=-(NB()+1); }
  else { if(S.emergency && S.bv<NB()+1) S.emergency=false; S.notch = S.bv>0 ? -S.bv : S.mc; }
  if(S.notch!==prev) Snd.notch(S.notch,prev); Snd.levers(S.mc, S.bv, NB()+1); updateNotchBar();
}
const NP=()=>VEH().np||4, NB=()=>VEH().nb||5;   // 力行ノッチ数・常用ブレーキ段数（新幹線は 13 / 7、非常はその次）
function setMC(n){ n=Math.max(0,Math.min(NP(),n)); if(n>0 && S.doorOpen){ setSubtitle("ドアを閉めてから力行してください。"); n=0; } if(n>0 && S.bv>=NB()+1){ setSubtitle("非常ブレーキ中は力行できません。ブレーキハンドル（↑）を戻してください。"); } else if(n>0 && S.bv>0 && S.speed<1){ setSubtitle("ブレーキがかかっています。ブレーキハンドル（↑）を戻すと力行できます。"); } S.mc=n; applyHandles(); }
function setBV(n){ S.bv=Math.max(0,Math.min(NB()+1,n)); applyHandles(); }
function setNotch(n){ if(n>0){ S.bv=0; setMC(n); } else if(n<0){ S.mc=0; setBV(-n); } else { S.mc=0; setBV(0); } }
function powerUp(){ if(S.bv>0) setBV(S.bv-1); else setMC(S.mc+1); }
function brakeUp(){ if(S.mc>0) setMC(S.mc-1); else setBV(Math.min(NB(),S.bv+1)); }
function emergency(){ S.mc=0; setBV(NB()+1); }
function toggleView(){ S.view=S.view==="cab"?"chase":"cab"; $("view-toggle").textContent=S.view==="cab"?"⟲":"⌂"; $("ui").classList.toggle("cab", S.view==="cab"); }
document.addEventListener("keydown",e=>{ if(typing()) return; if((S.mode==="car"||S.mode==="bus") && !e.repeat && (e.key==="t"||e.key==="T")){ rescue(); return; } }, true);
// 時間帯（N）・天気（M）の切り替え（どのモードでも）
document.addEventListener("keydown",e=>{ if(e.repeat || typing()) return; if(e.key==="n"||e.key==="N"){ Env.cycle(); } else if(e.key==="m"||e.key==="M"){ Env.set(null, !Env.st.rain); } });
document.querySelectorAll(".time-opt").forEach(b=>b.addEventListener("click",()=>Env.set(b.dataset.time)));
document.querySelectorAll(".rain-opt").forEach(b=>b.addEventListener("click",()=>Env.set(null, !Env.st.rain)));
/* v41.8: クラクション。音に加えて、前方の止まっている車・道をふさぐ人に聞こえる（車・バス・路面電車・JR 共通） */
function doHorn(){
  Snd.horn();
  let x, z, fx, fz;
  if((S.mode==="car"||S.mode==="bus") && Car.C.active){ const C=Car.C; fx=Math.sin(C.yaw); fz=Math.cos(C.yaw); x=C.x+fx*Car.P.len/2; z=C.z+fz*Car.P.len/2; }
  else if(S.track && S.running){ const p=pointAt(S.pos), q=pointAt(S.pos+8); fx=q.x-p.x; fz=q.z-p.z; const L=Math.hypot(fx,fz)||1; fx/=L; fz/=L; x=p.x; z=p.z; }
  else return;
  if(Traffic.ready) Traffic.honk(x, z, fx, fz); if(Peds.ready) Peds.honk(x, z, fx, fz);
}
document.addEventListener("keydown",e=>{ if(typing()) return; if(S.mode==="car" && Car.C.active && !e.repeat && (e.key==="h"||e.key==="H")){ doHorn(); return; } }, true);
document.addEventListener("keydown",e=>{ if(typing()) return; if(S.mode==="bus" && Bus.active && !e.repeat){ if(e.key==="f"||e.key==="F"){ Bus.doorKey(); return; } if(e.key==="h"||e.key==="H"){ doHorn(); return; } } }, true);
$("bus-doorbtn").addEventListener("click",()=>Bus.doorKey());
$("rescue-btn").addEventListener("click",rescue);
document.addEventListener("keydown",e=>{ if(!S.running || e.repeat || typing()) return; switch(e.key){
  // マスコン: W 進める / S 戻す、ブレーキハンドル: ↓ 強める / ↑ 緩める（それぞれ独立）
  case "w": case "W": e.preventDefault(); setMC(S.mc+1); break; case "s": case "S": e.preventDefault(); setMC(S.mc-1); break;
  case "ArrowDown": e.preventDefault(); setBV(Math.min(S.bv>=NB()+1?NB()+1:NB(), S.bv+1)); break; case "ArrowUp": e.preventDefault(); setBV(S.bv-1); break;
  case "c": case "C": setNotch(0); break; case "d": case "D": doorAction(); break;
  case " ": e.preventDefault(); emergency(); break; case "v": case "V": toggleView(); break;
  case "h": case "H": doHorn(); break; } });
document.querySelectorAll(".touch button").forEach(b=>b.addEventListener("click",()=>{ if(!S.running) return; const a=b.dataset.action;
  if(a==="power")powerUp(); else if(a==="brake")brakeUp(); else if(a==="coast")setNotch(0); else if(a==="door")doorAction(); else if(a==="emergency")emergency(); else if(a==="horn")doHorn(); }));
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
    { const o = Outer.h(x, z); if(!isNaN(o)) return o; }   // v36: 遠景の外は外側タイルの標高。v37: 遠景の中の細かいブロック（山陽道沿い）もここ
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
  function groundAt(x, z, yref){ return inData(x, z) ? Car.hAt(x, z, yref === undefined ? H.y : yref) : farH(x, z); }   // v32: 橋・高架は今の高さに近い段
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
  // v41.7: ミッションの荷物ポッド（スキッドの間・胴の下。積んでいる時だけ表示）
  const podM = new THREE.MeshPhongMaterial({ color: 0xf08a1c, shininess: 40 });
  const pod = add(new THREE.BoxGeometry(0.95, 0.5, 1.9), podM, 0, 0.42, 0.3); pod.visible = false;
  add(new THREE.BoxGeometry(0.98, 0.52, 0.14), dark, 0, 0, 0.55, pod); add(new THREE.BoxGeometry(0.98, 0.52, 0.14), dark, 0, 0, -0.35, pod);   // 荷締めベルト
  heli.traverse(o => { if(o.isMesh){ o.castShadow = true; } });
  disc.castShadow = false;
  function setPod(on, color){ pod.visible = !!on; if(on && color != null) podM.color.setHex(color); }

  // ---- 入力 ----
  const key = {}, pad = { f:0, b:0, l:0, r:0, u:0, d:0, fast:0 };
  const K = k => key[k] ? 1 : 0;
  addEventListener("keydown", e => { if(!H.active || typing()) return; const k = e.key.toLowerCase(); key[k] = true;
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
    const top = footTop(H.x, H.z, H.yaw), wasLanded = H.landed;
    H.landed = H.y <= top + 0.02;
    if(H.y < top){ if(H.vY < -0.05 && !wasLanded){ H.tdV = -H.vY; H.tdT = performance.now(); } H.y = top; if(H.vY < 0) H.vY = 0; }   // v41.7: 接地した瞬間の降下速度（ミッションの着陸採点）
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
  return { H, heli, pad, setHmax, setFar, tick, updateCam, focus, hud, start, stop, bindUI, setStart, setPod, topAt, groundAt, farH, roofAt, get fogK(){ return Math.max(1, Math.min(6, 1 + (H.y - 20) / 160)); } };
})();

function beginRide(){ leaveJR(); Clock.reset(); setupRoute(S.key,false); if(S.vehicle && S.vehicle!=="momo") setVehicle(S.vehicle); S.baseKey=S.key; S._camD=null; mapCache=null; $("route-name").textContent=S.route.name; $("next-stop").textContent=S.stops[1].name;
  $("stop-seq").textContent="1 / "+(S.stops.length-1); $("menu").style.display="none"; $("ui").classList.add("on"); $("finish-overlay").classList.remove("on");
  S.mode="tram"; Car.stop(); $("carui").classList.remove("on"); buildNotchBar(); S.mc=0; S.bv=0; applyHandles();
  $("ui").classList.toggle("cab", S.view==="cab");
  S.running=true; buildNotchBar(); updateNotchBar(); Dia.build();
  setSubtitle((S.key.endsWith("_r") ? S.stops[0].name : "岡山駅前（駅前広場の新停留場）") + "。ドアを閉めて、ブレーキハンドルを運転位置に戻し、マスコンを入れてください。");
  Snd.init(); Snd.hush(); S._appr=false; setTimeout(annStart, 600);
  Trams.populate(S.key, S.pos, S.vehicle); Traffic.reset(); }
/* ---------------- v35: JR・新幹線を運転する ---------------- */
let JRSEL = null;
function leaveJR(){
  JR.end(); Cab.setDial(60, 6); Cab.setNotches(4, 5, false);
  if(VEHICLES[S.vehicle] && VEHICLES[S.vehicle].jr){ const o=document.querySelector(".veh-opt.on"); S.vehicle=o?o.dataset.veh:"momo"; setVehicle(S.vehicle); }
  if(/^jr_/.test(S.key||"")){ const r=document.querySelector("#routes .route-opt.on"); S.key=r?r.dataset.key:"higashi"; }
}
function buildJRPicker(){
  const wrap=$("jr-routes"), vw=$("jr-vehs"); if(!wrap || !JR.ready) return;
  const defs=JR.routeDefs(); wrap.innerHTML=""; if(!defs.length){ $("jr-wrap").querySelector(".foot").textContent="JR の線路データを読み込めませんでした。"; return; }
  const code={shinkansen:"新",sanyo:"山",uno:"宇",tsuyama:"津",kibi:"吉"}, col={shinkansen:"#1f4f9f",sanyo:"#2a7fc0",uno:"#d87a1d",tsuyama:"#b5452f",kibi:"#3c8d56"};
  const pickVeh=(def,vk)=>{ JRSEL.vkey=vk; vw.querySelectorAll(".veh-opt").forEach(x=>x.classList.toggle("on", x.dataset.veh===vk)); };
  const fillVeh=(def)=>{ vw.innerHTML=""; def.veh.forEach((vk,i)=>{ const V=VEHICLES[vk], M=JR.MODELS[V.mk], b=document.createElement("button"); b.type="button"; b.className="veh-opt"+(i===0?" on":""); b.dataset.veh=vk;
      b.innerHTML='<i class="sw" style="background:linear-gradient(#'+M.body.toString(16).padStart(6,"0")+' 55%,#'+M.band.toString(16).padStart(6,"0")+' 55%)"></i><b>'+V.name+'</b><small>'+V.desc+'・全長 約'+Math.round(V.len)+'m</small>';
      b.addEventListener("click",()=>pickVeh(def,vk)); vw.appendChild(b); }); JRSEL.vkey=def.veh[0]; };
  defs.forEach((def,i)=>{ const b=document.createElement("button"); b.type="button"; b.className="route-opt"+(i===0?" on":""); b.dataset.key=def.key;
    const chain=def.stops.map(q=>q.name).concat(def.farEnd?["再現範囲の端"]:[]).join(' <i>→</i> ');
    b.innerHTML='<span class="rcode" style="background:'+col[def.line]+';color:#fff">'+code[def.line]+'</span><span><strong>'+def.name+'</strong><span class="dir">'+chain+'</span></span>';
    b.addEventListener("click",()=>{ wrap.querySelectorAll(".route-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); JRSEL.def=def; fillVeh(def); });
    wrap.appendChild(b); });
  JRSEL={def:defs[0], vkey:defs[0].veh[0]}; fillVeh(defs[0]);
}
function beginJR(){
  if(!JRSEL || !JRSEL.def){ alert("JR の線路データを読み込めませんでした。"); return; }
  Clock.reset(); const def=JRSEL.def, vk=JRSEL.vkey, r=JR.buildRoute(def, vk);
  S.routes[def.key]=r; S.vehicle=vk; S.mode="tram"; Car.stop(); $("carui").classList.remove("on");
  setupRoute(def.key,false); setVehicle(vk); S.baseKey=def.key; S._camD=null; mapCache=null; JR.begin(r); Cab.setDial(VEH().dial, Math.round(VEH().dial/VEH().dstep)); Cab.setNotches(NP(), NB(), !!VEH().hs); buildNotchBar(); S.mc=0; S.bv=0; applyHandles();
  $("route-name").textContent=S.route.name; $("next-stop").textContent=S.stops[1]?S.stops[1].name:S.stops[0].name; $("stop-seq").textContent="1 / "+Math.max(1,S.stops.length-1);
  $("menu").style.display="none"; $("ui").classList.add("on"); $("finish-overlay").classList.remove("on"); $("turnback").style.display="none";
  buildNotchBar(); S.mc=0; S.bv=0; applyHandles(); $("ui").classList.toggle("cab", S.view==="cab");
  S.running=true; updateNotchBar();
  setSubtitle(S.stops[0].name+"。ドアを閉め、ブレーキ弁を運転位置に戻してマスコンを入れてください。次は "+(S.stops[1]?S.stops[1].name:"")+"。");
  Snd.init(); Snd.hush(); S._appr=false;
  Trams.populate(null, 0, "none"); Traffic.reset(); }
$("start").addEventListener("click",()=>{ if($("start").disabled) return; applyMenu(); const sel=document.querySelector(".mode-opt.on"); const m=sel ? sel.dataset.mode : S.mode;
  if(m==="car") beginCar(); else if(m==="bus") beginBus(); else if(m==="heli") beginHeli(); else if(m==="jr") beginJR(); else beginRide(); });
function beginHeli(){
  leaveJR(); Clock.reset(); S.mode="heli"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.remove("on"); $("heliui").classList.add("on");
  Car.stop(); setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush(); Quest.end();
  const mission = S.play==="mission" && Quest.def(Quest.sel.heli);
  if(mission) Heli.setStart(mission.start); else { const o=document.querySelector(".hstart-opt.on"); if(o) Heli.setStart(o.dataset.start); }
  Heli.start();
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false;
  Stream.tick(); if(mission) Quest.begin(mission.id); }
$("heli-menu").addEventListener("click",()=>{ Quest.end(); Heli.stop(); Snd.heliSound(Heli.H); S.mode="menu"; Loc.hide(); $("heliui").classList.remove("on"); $("menu").style.display="flex"; applyMenu(); });
document.querySelectorAll(".hstart-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".hstart-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); Heli.setStart(b.dataset.start); }));
Heli.bindUI();
function beginCar(){
  MWT.reset();   leaveJR(); Clock.reset(); S.mode="car"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.add("on");
  Quest.end(); Nav.clear(); const truck = S.cveh==="truck", mission = S.play==="mission" && Quest.def(Quest.sel.car);
  if(truck){ TRUCK = makeTruck(); Car.setProfile("truck", TRUCK); Car.C.onDriverView = truckDV; } else { TRUCK = null; Car.setProfile("sedan"); Car.C.onDriverView = null; }
  $("car-mode-lbl").textContent = mission ? mission.name : truck ? "トラックで自由に走る" : "車で自由に走る"; $("busui").classList.remove("on");
  setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush(); placeCar();
  // v37: 山陽自動車道から出発（ミッションは市街地から）
  if(!mission && S.carStart==="mw" && MW.ready){ const [px,pz]=$("mw-place").value.split(",").map(Number), q=MW.spawn(px,pz,S.mwDir||"up",0);
    if(q){ const C=Car.C; C.x=q.x; C.z=q.z; C.yaw=q.yaw; C.h=q.y; C.v=0; C.gear="D"; C.hitT=0; MW.tick({x:q.x,z:q.z},true); Outer.tick({x:q.x,z:q.z,y:q.y},true); } }
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false;
  if(mission) Quest.begin(mission.id); }
let TRUCK = null;
const truckDV = (drv) => { if(!TRUCK) return; TRUCK.userData.hiU.update(Car.C); };       // v41.9: 運転席は常にある（窓ごしに見える）。計器・ハンドルの動きだけ更新
// 出発点: 桃太郎大通りの東行き車線（左側通行）
function placeCar(){ Car.start(); const sp = Traffic.ready ? Traffic.startPose(40, -12, 1, 0) : null; if(sp){ Car.C.x=sp.x; Car.C.z=sp.z; Car.C.yaw=sp.yaw; Car.C.h=Car.hAt(sp.x, sp.z); } }
function beginBus(){
  leaveJR(); Clock.reset();
  if(!Bus.data){ alert("バスの経路データを読み込めませんでした。"); return; }
  S.mode="bus"; S.running=false; $("menu").style.display="none"; $("ui").classList.remove("on"); $("carui").classList.add("on");
  $("car-mode-lbl").textContent="両備バス 西大寺線"; $("finish-overlay").classList.remove("on");
  setupRoute("higashi", true); S.pos=S.cum[0]+60;
  Snd.init(); Snd.hush();
  Bus.begin();
  Trams.populate(null, 0, "none"); Traffic.reset(); if(S.car) S.car.visible=false; }
$("car-menu").addEventListener("click",()=>{ Quest.end(); if(Bus.active) Bus.end(); else { Car.setProfile("sedan"); Car.C.onDriverView=null; TRUCK=null; } Car.stop(); Snd.carSound(Car.C); S.mode="menu"; Loc.hide(); $("carui").classList.remove("on"); $("menu").style.display="flex"; applyMenu(); });
document.querySelectorAll(".veh-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".veh-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  S.vehicle=b.dataset.veh; if(S.car) setVehicle(S.vehicle); }));
/* ---------- v41.7: 開始画面（乗り物 → あそびかた → コース） ----------
   選んだ乗り物ごとに「あそびかた」（ミッション／自由）を覚える。路面電車とバスは Dia（ダイヤ運行）のオン・オフに、
   車とヘリはミッション（Quest）の有無に対応する。上の行先表示器は選んだ内容をそのまま映す */
const MENU = {
  tram:{ ic:"tram", title:"路線と車両", go:{ mission:"ダイヤ運行をはじめる", free:"運転をはじめる" },
    play:{ mission:["ダイヤ運行","時刻表どおりに走り、遅れ・早発を採点します"], free:["自由運転","時刻も採点もなし。好きなように走ります"] } },
  jr:  { ic:"jr", title:"路線と車両", go:{ free:"運転をはじめる" }, noplay:true },
  bus: { ic:"bus", title:"路線", go:{ mission:"ダイヤ運行をはじめる", free:"運転をはじめる" },
    play:{ mission:["ダイヤ運行","停留所ごとの定刻どおりに走り、遅れ・早発を採点します"], free:["自由運転","時刻も採点もなし。好きなように走ります"] } },
  car: { ic:"car", go:{ mission:"配達をはじめる", free:"走り出す" },
    play:{ mission:["配達ミッション","駐車場から出発して荷物やお客さんを運びます。行き先は毎回ちがう。時間と運転の丁寧さで採点"], free:["自由に走る","市街地でも山陽自動車道でも、好きな所へ"] } },
  heli:{ ic:"heli", go:{ mission:"ミッションに出発", free:"飛び立つ" },
    play:{ mission:["空のミッション","荷物や患者さんを運ぶ・名所をめぐる。着陸も採点"], free:["自由に飛ぶ","出発地を選んで、好きなように飛びます"] } },
};
let _bd = "";
function applyMenu(){
  const o = document.querySelector(".mode-opt.on"), m = o ? o.dataset.mode : "tram", C = MENU[m] || MENU.tram, menu = $("menu");
  if(!menu) return;
  menu.dataset.mode = m;
  const play = C.noplay ? "free" : (S.playBy[m] || "mission"), mis = play === "mission", car = m === "car", heli = m === "heli", truck = car && S.cveh === "truck";
  S.play = play;
  if(m === "tram" || m === "bus"){ const d = document.querySelector(".dia-opt"); if(d && d.classList.contains("on") !== mis) d.click(); }   // ダイヤ運行 = ミッション
  const show = (id, v) => { const e = $(id); if(e) e.style.display = v ? "" : "none"; };
  show("play-wrap", !C.noplay); show("routes-wrap", m === "tram"); show("jr-wrap", m === "jr"); show("bus-note", m === "bus");
  show("car-wrap", car); show("car-start-wrap", car && !mis); show("quest-wrap", (car || heli) && mis); show("heli-note", heli && !mis); show("heli-help", heli); show("car-note", car);
  $("mw-start-sel").style.display = (car && S.carStart === "mw") ? "" : "none";
  document.querySelectorAll(".play-opt").forEach(b => { b.classList.toggle("on", b.dataset.play === play); if(C.play){ const t = C.play[b.dataset.play]; b.querySelector(".po-t").firstChild.textContent = t[0]; b.querySelector(".po-s").textContent = t[1]; } });
  document.querySelectorAll(".cveh-opt").forEach(b => b.classList.toggle("on", b.dataset.cveh === S.cveh));
  $("course-title").textContent = C.title || (car ? (mis ? "車種とコース" : "車種と出発地") : (mis ? "コース" : "出発地"));
  $("quest-sub").textContent = car ? "配達先・コース" : "コース";
  if((car || heli) && mis) Quest.renderPicker($("quest-list"), m, car ? S.cveh : undefined, () => setTimeout(applyMenu, 0));
  // 行先表示器
  const q = (s) => document.querySelector(s), txt = (e) => e ? e.textContent.trim() : "";
  let l1 = "", l2 = "", ic = C.ic;
  if(m === "tram"){ l1 = "路面電車 " + txt(q("#routes .route-opt.on strong")); l2 = txt(q("#routes .route-opt.on .dir")).replace(/（.*$/, ""); }
  else if(m === "jr"){ l1 = txt(q("#jr-routes .route-opt.on strong")) || "JR・新幹線"; l2 = txt(q("#jr-vehs .veh-opt.on b")); }
  else if(m === "bus"){ l1 = "両備バス 314"; l2 = "西大寺線 岡山駅東口 → 東山"; }
  else if(car){ ic = truck ? "truck" : "car"; const vl = truck ? "トラック" : "乗用車", qd = mis ? Quest.def(Quest.sel.car) : null;
    if(mis && qd){ l1 = qd.name; l2 = vl + "　" + "★".repeat(qd.star) + "☆".repeat(3 - qd.star); }
    else { l1 = (truck ? "トラックで" : "車で") + "自由に走る"; l2 = vl + "　" + (S.carStart === "mw" ? "山陽自動車道 " + txt(q("#mw-place option:checked")).replace(/（.*$/, "") : "岡山駅前"); } }
  else { const qd = mis ? Quest.def(Quest.sel.heli) : null;
    if(mis && qd){ l1 = qd.name; l2 = "ヘリコプター　" + "★".repeat(qd.star) + "☆".repeat(3 - qd.star); }
    else { l1 = "ヘリで自由に飛ぶ"; l2 = "出発地　" + txt(q(".hstart-opt.on")); } }
  const tag = C.noplay ? "" : mis ? (car || heli ? "ミッション" : "ダイヤ運行") : "自由";
  const tm = Clock.PRESET[Env.st.time] || Clock.PRESET.noon, hh = String(Math.floor(tm / 3600)).padStart(2, "0") + ":" + String(Math.floor(tm / 60) % 60).padStart(2, "0");
  const key = [m, l1, l2, tag, ic, hh, Env.st.rain].join("|");
  $("dest-1").textContent = l1; $("dest-2").textContent = l2; const te = $("dest-tag"); te.textContent = tag; te.style.display = tag ? "" : "none";
  $("dest-ic").setAttribute("href", "#ic-" + ic); $("dest-clock").textContent = hh; $("dest-wx").textContent = (Clock.TAGS[Env.st.time] || "") + "・" + (Env.st.rain ? "雨" : "晴れ");
  if(key !== _bd){ if(_bd){ const bd = $("dest"); bd.classList.remove("flip"); void bd.offsetWidth; bd.classList.add("flip"); } _bd = key; }
  if(!$("start").disabled) $("start-label").textContent = C.go[play] || C.go.free;
}
document.querySelectorAll(".mode-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".mode-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  S.mode=["car","bus","heli"].includes(b.dataset.mode)?b.dataset.mode:"tram"; applyMenu(); }));
document.querySelectorAll(".play-opt").forEach(b=>b.addEventListener("click",()=>{ const o=document.querySelector(".mode-opt.on"); if(o) S.playBy[o.dataset.mode]=b.dataset.play; applyMenu(); }));
document.querySelectorAll(".cveh-opt").forEach(b=>b.addEventListener("click",()=>{ S.cveh=b.dataset.cveh; applyMenu(); }));
$("menu").addEventListener("click",(e)=>{ if(e.target.closest(".route-opt,.veh-opt,.hstart-opt,.cstart-opt,.cstart-dir,.time-opt,.rain-opt")) setTimeout(applyMenu,0); });
$("mw-place").addEventListener("change",applyMenu);
document.querySelectorAll(".cstart-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".cstart-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); S.carStart=b.dataset.cs; $("mw-start-sel").style.display=S.carStart==="mw"?"":"none"; }));
document.querySelectorAll(".cstart-dir").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".cstart-dir").forEach(x=>x.classList.remove("on")); b.classList.add("on"); S.mwDir=b.dataset.dir; }));
document.querySelectorAll(".look-opt").forEach(b=>b.addEventListener("click",()=>{ document.querySelectorAll(".look-opt").forEach(x=>x.classList.remove("on")); b.classList.add("on"); setLook(b.dataset.look); }));
document.querySelectorAll(".dia-opt").forEach(b=>b.addEventListener("click",()=>{ const on=!b.classList.contains("on"); b.classList.toggle("on",on); b.textContent="ダイヤ運行: "+(on?"あり":"なし"); Dia.setOn(on); }));
document.querySelectorAll(".shadow-opt").forEach(b=>b.addEventListener("click",()=>{ const on=!b.classList.contains("on"); b.classList.toggle("on",on); b.textContent="影: "+(on?"あり":"なし"); setShadows(on); }));
Car.bindUI();
// 車モード: 他の車・電車との接触（進む先の車体の範囲に何かあれば止める）
const CAR_OBST = (x, z, fx, fz, dir) => { if (!Trams.ready) return null; const hl = Car.P.len / 2 - 0.3, sx = fz, sz = -fx, hw = Car.P.wid / 2 - 0.35;
  // 進む向きの半分だけ調べる（前に何かあっても後ろへは下がれる）
  const u0 = dir < 0 ? 0 : hl, u1 = dir > 0 ? 0 : -hl;
  for (let u = u0; u >= u1; u -= 1.3) for (const w of (hw > 0.6 ? [hw, -hw] : [0])) { const e = Obs.hit(x + fx * u + sx * w, z + fz * u + sz * w, 0.55, PCAR, (o) => !!(o && (o.ped || o.danger)), Car.C.h); if (e) return e.o && e.o.ped !== undefined ? "歩行者" : e.o && e.o.type ? (e.o.type.name === "bus" ? "バス" : "他の車") : "電車"; } return null; };
Car.C.obst = CAR_OBST;
Cab.bind({ getMC:()=>S.mc, setMC:(n)=>{ if(S.running) setMC(n); }, getBV:()=>S.bv, setBV:(n)=>{ if(S.running) setBV(n); } });
$("sound-btn").addEventListener("click",()=>{ Snd.init(); const on=Snd.toggle(); Prefs.setSound(on); $("sound-btn").textContent=on?"音":"消"; $("sound-btn").title=on?"音を消す":"音を出す"; });
// v25: 音を消す設定を覚えている時は、始めた時に消す
$("start").addEventListener("click",()=>{ setTimeout(()=>{ if(!Prefs.soundOn && Snd.on){ Snd.init(); Snd.toggle(); $("sound-btn").textContent="消"; $("sound-btn").title="音を出す"; } }, 80); });
$("turnback").addEventListener("click", turnBack);
$("restart").addEventListener("click",()=>{ Snd.hush(); $("finish-overlay").classList.remove("on"); $("menu").style.display="flex"; $("ui").classList.remove("on");
  if(Bus.active){ Bus.end(); Car.stop(); $("carui").classList.remove("on"); S.mode="bus"; } Loc.hide(); $("turnback").style.display=""; applyMenu(); });

/* 案内パネル（次の停留場）の高さが変わっても、信号・制限速度・スコアの行が重ならないよう下に並べる */
let _hudT=0;
function layoutHud(){
  if(!S.running || performance.now()-_hudT<250) return; _hudT=performance.now();
  const m=document.querySelector("#ui .mission"), r=document.querySelector("#ui .rack"), mm=document.querySelector("#ui .minimap");
  if(!m||!r) return; const top=m.offsetTop+m.offsetHeight+8; r.style.top=((S.view==="cab" && VEH().hs) ? 64 : top)+"px";   // 新幹線の運転台: 情報カードは上の段へ（ミラーに重ねない）
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
  if(S.mode==="car" && MW.ready){ const m=MW.nearestLane(C.x, C.z, C.h, 90); if(m && (!t || Math.hypot(m.x-C.x,m.z-C.z) < Math.hypot(t.x-C.x,t.z-C.z))) t=m; }
  if(!t){ C.msg="近くに戻れる道路が見つかりませんでした"; C.msgT=3; return; }
  C.v=0;
  fadeMsg("すぐそばの道路へ戻しています…", ()=>{ C.x=t.x; C.z=t.z; C.yaw=t.yaw; C.v=0; C.wheel=0; C.gear="D"; C.hitT=0; C.h=(t.y!==undefined?t.y:Car.hAt(t.x,t.z)); Stuck.reset();
    C.msg="道路に戻りました（減点なし）"; C.msgT=3; });
}
/* 動けなくなったことを検知して、救済ボタンを光らせる */
const Stuck=(()=>{ let t=0, hits=0, lastHit=0, off=0;
  function tick(dt){
    if(!(S.mode==="car"||S.mode==="bus") || !Car.C.active){ $("rescue-btn").classList.remove("hint"); return; }
    const C=Car.C;
    if(C.hitT>1.1 && performance.now()-lastHit>900){ lastHit=performance.now(); hits++; }
    if(Math.abs(C.v)<0.4 && (C.thr||0)>0.3) t+=dt; else t=Math.max(0,t-dt*0.5);
    const k=Car.kindAt ? Car.kindAt(C.x,C.z,C.h) : 1; if(k!==1 && !(S.mode==="bus" && Bus.active && Bus.onRoute()) && !Quest.inYard(C.x,C.z)) off+=dt; else off=0;
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
  const NARROW_K = 0.35;   // v35: 車と共用の細い道を歩く人は少なく
  const DENS = 1 / 22;   // 人の多さ 1.0 の歩道で 22m に 1 人（両側の合計）
  function nearCells(cx, cz, r){ const out = []; const i0 = Math.floor((cx - r) / CS), i1 = Math.floor((cx + r) / CS), j0 = Math.floor((cz - r) / CS), j1 = Math.floor((cz + r) / CS);
    for(let i = i0; i <= i1; i++) for(let j = j0; j <= j1; j++){ const c = CELLS.get(i + "," + j); if(c) out.push(c); } return out; }
  let pool = null, poolW = 0, poolAt = null, target = 0;
  function rebuildPool(cx, cz){
    pool = []; poolW = 0; let wl = 0;
    for(const c of nearCells(cx, cz, R_IN)) for(const ei of c){ const e = E[ei]; const p = at(e, e.L / 2, {}); if(Math.hypot(p.x - cx, p.z - cz) > R_IN) continue;
      const nk = e.k === 5 ? NARROW_K : 1; const w = e.w * e.L * nk; if(w <= 0) continue; poolW += w; pool.push([poolW, ei]); wl += w; }
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
      if(e.k === 1) continue;   // v35: 横断歩道の途中には出さない（赤信号の真ん中に現れる人をなくす）
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
  function latOf(o, e){ const hy = o.hurryT > 0 ? 1.18 : 1;   // v41.8: クラクションを聞いた人は道の端へ寄る
    if(e.k === 5) return o.bike ? -e.lat * (0.8 + 0.2 * Math.abs(o.side)) * hy : e.lat * (0.8 + 0.2 * Math.abs(o.side)) * hy; return o.side * e.lat; }
  function chooseNext(o, node){
    const L = ADJ[node]; let best = -1, sum = 0; const cand = [];
    for(const ei of L){ if(ei === o.e && L.length > 1) continue; const e = E[ei]; if(o.bike && (!e.bike || e.k === 4 || e.k === 2)) continue;
      let w = Math.max(0.05, e.w); if(e.k === 1) w *= 0.55; else if(e.k === 5) w *= 0.5; cand.push([ei, w]); sum += w; }
    if(!cand.length) return o.e;
    let r = Math.random() * sum; for(const [ei, w] of cand){ if((r -= w) <= 0){ best = ei; break; } } return best < 0 ? cand[0][0] : best;
  }
  // 横断してよいか（辺 e を node 側から渡り始める時）
  function mayCross(e, t, w){
    if(e.k !== 1) return true;
    if(e.g >= 0) return pedState(e.g, e.ph, t) === 0;
    // v41.8: 信号のない横断歩道。渡る線の上に車体（止まっている車・自転車の上）がなければ渡る。
    //        （以前は横断歩道の中心から 9m 以内に止まった車がいると渡れず、歩行者を待って止まった車と、車を待つ歩行者が、お互いに待って動かなくなっていた）
    //        12 秒以上渡れずにいる人・クラクションを聞いた人は、止まっている車の横でも渡る（車を待つ歩行者と、歩行者を待つ車の行き詰まり対策）
    const m = at(e, e.L / 2, _p), R = Math.max(9, e.L / 2 + 5); let h = null, force = !!(w && (w.hurryT > 0 || w.wt > 12));
    const nS = Math.max(2, Math.ceil(e.L / 1.5)); for(let i = 0; i <= nS && !h && !force; i++){ const q = at(e, e.L * i / nS, _p); h = Obs.hit(q.x, q.z, 0.5, null, (o) => !!(o && o.ped)); }
    const mm = at(e, e.L / 2, _p), mx = mm.x, mz = mm.z;
    if(!h) h = Obs.hit(mx, mz, R + 14, null, (o) => !(o && o.type && o.v > 2.5));   // 速い車が近づいている間は渡らない
    return !h;
  }
  /* v35: 横断歩道の現示を、車線側（信号の停止線）から決め直す。
     OSM の横断歩道の向きと交差点の「主道路」の向きがずれる斜めの交差点で、車と歩行者が同時に青になっていた（57/1595 組）。
     停止線の先 22m 以内を、進行方向と 60° 以上の角度で横切る横断歩道は、その車線が青の間は赤にする。 */
  let phFixed = false;
  function fixPhases(){
    if(phFixed || !Traffic.ready) return; phFixed = true;
    const segs = Traffic.segs; let ch = 0, tot = 0;
    const byG = new Map(); for(const g of segs){ if(g.lane && g.sig){ let a = byG.get(g.sig.g); if(!a){ a = []; byG.set(g.sig.g, a); } a.push(g); } }
    for(const e of E){ if(e.k !== 1 || e.g < 0) continue; const L = byG.get(e.g); if(!L) continue;
      const n = e.P.length / 2, mx = (e.P[0] + e.P[2*n-2]) / 2, mz = (e.P[1] + e.P[2*n-1]) / 2, vx = e.P[2*n-2] - e.P[0], vz = e.P[2*n-1] - e.P[1], vl = Math.hypot(vx, vz) || 1;
      const votes = [0, 0];
      for(const g of L){ const sp = pathPt(g.P, g.sig.s), tg = pathTan(g.P, g.sig.s); const dx = mx - sp.x, dz = mz - sp.z;
        if(Math.hypot(dx, dz) > 22 || dx * tg.x + dz * tg.z < -3) continue;
        const c = Math.abs((vx * tg.x + vz * tg.z) / vl / (Math.hypot(tg.x, tg.z) || 1)); if(c > 0.5) continue;
        votes[1 - g.sig.ph]++; }
      tot++; if(votes[0] === votes[1]) continue; const ph = votes[1] > votes[0] ? 1 : 0; if(ph !== e.ph){ e.ph = ph; ch++; } }
    console.log("peds: crosswalk phases fixed", ch, "of", tot);
  }
  let respT = 0, poolT = 0;
  const PEDREG = [];
  function register(){
    // 横断歩道を渡っている人と、自分の車の近く（45m）の人は障害物（車・電車が止まる。自分の車が当たると衝突）
    PEDREG.length = 0;
    const px = PLAYER_POS.on ? PLAYER_POS.x : 1e9, pz = PLAYER_POS.on ? PLAYER_POS.z : 1e9;
    for(const L of [peds, bikes]) for(const o of L){ if(!o.on || o.x === undefined) continue; const e = E[o.e];
      if(e.k === 1 || Math.abs(o.x - px) + Math.abs(o.z - pz) < 45){ Obs.add(o.x, o.z, o.bike ? 0.6 : 0.35, o, o._y); } }
  }
  function update(dt, t, center){
    if(!ready) return; fixPhases();
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
          const nxt = E[o.nextE]; if(nxt && o.wait <= 0 && !mayCross(nxt, t, o)) o.wait = 0.5; }
        else o.v += (o.v0 * (e.k === 1 && e.g >= 0 && pedState(e.g, e.ph, t) > 0 ? 1.35 : 1) * (o.hurryT > 0 ? (o.bike ? 1.25 : 1.7) : 1) - o.v) * Math.min(1, dt * 2);
        o.wt = (o.nextE >= 0 && o.v === 0 && !(o.stand > 0)) ? (o.wt || 0) + dt : 0;   // 横断歩道の手前で待っている時間
        if(o.hurryT > 0) o.hurryT -= dt;
        if(o.v > 0 && o.wait <= 0 && o.stand <= 0){
          o.s += o.dir * o.v * dt;
          if(o.s < 0 || o.s > e.L){
            const node = o.s < 0 ? e.a : e.b, over = o.s < 0 ? -o.s : o.s - e.L;
            const ni = chooseNext(o, node), ne = E[ni];
            if(ne.k === 1 && !mayCross(ne, t, o)){ o.s = o.s < 0 ? 0 : e.L; o.nextE = ni; o.wait = 0.5; o.v = 0; o.waitSpot = (o.id % 5) * 0.45; }
            else { o.e = ni; e = ne; o.dir = ne.a === node ? 1 : -1; o.s = o.dir > 0 ? Math.min(ne.L, over) : Math.max(0, ne.L - over); o.nextE = -1; o.waitSpot = 0; }
          }
        } else if(o.wait <= 0 && o.nextE >= 0 && o.stand <= 0 && o.v === 0){
          // 待っていた横断歩道が青になった
          const node = o.s <= 0 ? e.a : e.b, ne = E[o.nextE];
          if(ne && mayCross(ne, t, o)){ o.e = o.nextE; e = ne; o.dir = ne.a === node ? 1 : -1; o.s = o.dir > 0 ? 0 : ne.L; o.nextE = -1; o.waitSpot = 0; o.v = 0.3; }
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
        const y = Car.hAt(o.x, o.z, o._y); o._y = y;   // v32: 橋の上を歩く人は橋の上（今の高さに近い段）
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
        sigData.push({ x, z, y: Car.hAt(x, z), yaw: Math.atan2(fx, fz), g: e.g, e });
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
    for(let i = 0; i < sigData.length; i++){ const s = sigData[i], st = pedState(s.g, s.e.ph, t);
      sigMesh.setColorAt(i * 2, st === 2 ? PR : lampOff); sigMesh.setColorAt(i * 2 + 1, st === 0 || (st === 1 && blink) ? PG : lampOff); }
    sigMesh.instanceColor.needsUpdate = true;
  }
  /* v41.8: 利用者のクラクション。前方 40m・左右 5m＋距離×0.1 の扇形にいる人は、立ち止まりをやめて足早に・道の端へ寄る */
  function honk(x, z, fx, fz){
    let n = 0;
    for(const L of [peds, bikes]) for(const o of L){ if(!o.on || o.x === undefined) continue;
      const px = o.x - x, pz = o.z - z, fwd = px * fx + pz * fz; if(fwd < -2 || fwd > 40) continue;
      if(Math.abs(px * fz - pz * fx) > 5 + fwd * 0.1) continue;
      o.hurryT = 5; if(o.stand > 0) o.stand = 0; n++; }
    return n;
  }
  return { init, update, register, honk, pedState, get peds(){ return peds; }, get bikes(){ return bikes; }, get ready(){ return ready; }, get E(){ return E; } };
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
  // ガウス窓でならす（端は窓を狭めて正規化）。sg=[横方向の標準偏差(点), 高さの標準偏差(点)]（点の間隔は 2m）
  function smoothLine(p, n, sg){
    const out = new Float64Array(n);
    for(let c = 0; c < 3; c++){
      const sd = c === 1 ? sg[1] : sg[0], hw = Math.ceil(sd * 3), ker = new Float64Array(hw + 1); for(let k = 0; k <= hw; k++) ker[k] = Math.exp(-0.5 * (k / sd) * (k / sd));
      for(let i = 0; i < n; i++){ let a = p[3 * i + c] * ker[0], w = ker[0], m = Math.min(hw, i, n - 1 - i);   // 端は左右対称に使える幅だけ（偏りを出さない）
        for(let k = 1; k <= m; k++){ a += (p[3 * (i - k) + c] + p[3 * (i + k) + c]) * ker[k]; w += 2 * ker[k]; } out[i] = a / w; }
      for(let i = 0; i < n; i++) p[3 * i + c] = out[i];
    }
  }
  function init(J){
    if(!J || !J.lines) return; D = J;
    for(const l of J.lines){
      const p = new Float32Array(l.p), n = p.length / 3;
      smoothLine(p, n, l.key === "shinkansen" ? [20, 25] : [4, 6]);   // v38: 座標が 0.1m 単位に丸められていて、そのままだと車体・カメラが細かく揺れる（新幹線で向きの揺れ 2°/2m）。線形（半径 4000m 以上）を崩さない範囲でならす
      const L = { key: l.key, ti: l.ti, p, n, len: (n - 1) * 2, stop: l.stop, el: l.el, tun: l.tun || null, inner: l.inner, mate: l.mate, hs: l.key === "shinkansen", i0: l.i0 != null ? l.i0 : 0, i1: l.i1 != null ? l.i1 : n - 1, stops: l.stops || [], lim: l.lim || null };
      // v36: 新幹線の岡山以外の駅（新倉敷・福山・相生）: ホームの前後の点に印（簡易ホーム・屋根を作る）
      if(L.hs && L.stops.length){ L.stn = new Uint8Array(n); for(const q of L.stops){ if(q.name === "岡山" || !(q.plat > 0)) continue; const c = Math.round(q.s / 2), w = Math.round(q.plat / 4); for(let k = Math.max(0, c - w); k <= Math.min(n - 1, c + w); k++) L.stn[k] = 1; } }
      // 走る向き: 左側通行（相手の線が進む向きの右にある向き）。単線の線は両方向
      const ms = l.mate.reduce((a, b) => a + b, 0); L.dir = Math.abs(ms) > n * 0.2 ? Math.sign(ms) : 0;
      lines.push(L);
    }
    buildStatic(); scene.add(root);
    for(const L of lines){ L.timer = [Math.random() * SERV[L.key].head, Math.random() * SERV[L.key].head]; }
    ready = true; console.log("jr lines", lines.length);
  }
  /* ---- 線路・高架橋（データの範囲の中だけ） ---- */
  const _a = {x:0,y:0,z:0}, _b = {x:0,y:0,z:0}, _qp = {x:0,y:0,z:0};
  // v31: 線路・高架の頂点を作る所（genStatic）。buildStatic と、WebGL が戻った時の作り直しで同じものを作る
  function buildStatic(){ const { G, poles } = genStatic(); buildStaticMeshes(G, poles); }
  function genStatic(){
    // v36: 2km（1000 点）ごとのまとまり（見えない所は描かない）
    const Gm = new Map(); let G = null; const poles = [];
    const chunkG = (L, i) => { const k = L.key + L.ti + "_" + Math.floor(i / 1000); let g = Gm.get(k); if(!g){ g = { deck: [], wall: [], slab: [], ballast: [], rail: [], tube: [], lamp: [] }; Gm.set(k, g); } return g; };
    const push = (A, ...v) => { for(const q of v) A.push(q[0], q[1], q[2]); };
    const quad = (A, a, b, c, d) => { push(A, a, b, c); push(A, a, c, d); };
    for(const L of lines){
      const gauge = L.hs ? 1.435 : 1.067;
      let str = 1;
      for(let i = 0; i < L.n - 1; i += str){
        pt(L, i * 2, _a);
        // v36: 新幹線は地図の外（遠景の地形の上）も作る。外は 20m 間隔の粗い区間（i を 10 の倍数にそろえてから）
        str = L.hs && !inData(_a.x, _a.z) && i % 10 === 0 ? Math.min(10, L.n - 1 - i) : 1;
        pt(L, (i + str) * 2, _b);
        if(!L.hs && (!inData(_a.x, _a.z) || !inData(_b.x, _b.z))) continue;
        G = chunkG(L, i);
        const dx = _b.x - _a.x, dz = _b.z - _a.z, ln = Math.hypot(dx, dz) || 1, rx = -dz / ln, rz = dx / ln;   // 右
        const P = (q, off, y) => [q.x + rx * off, y, q.z + rz * off];
        const el = L.el[i] && L.el[i + str];
        const ya = _a.y, yb = _b.y;
        const tn = !!(L.tun && L.tun[i] && L.tun[i + str]);
        if(tn && L.hs && (L.mate[i] <= 0 || L.ti === 0)){
          // v36: 新幹線のトンネル（複線 1 本の管: 幅 11m・レール面から天井 7.5m）。2 本の線の真ん中に 1 本だけ作る
          const ms = L.mate[i] || 0, c0 = ms * L.inner[i], c1 = ms * L.inner[i + str], R = 5.5;
          const ring = (q, c, y) => { const out = []; out.push([c - R, y - 0.6]); out.push([c - R, y + 2.0]);
            for(let k = 1; k < 12; k++){ const th = Math.PI - Math.PI * k / 12; out.push([c + R * Math.cos(th), y + 2.0 + R * Math.sin(th)]); }
            out.push([c + R, y + 2.0]); out.push([c + R, y - 0.6]); return out.map(([o, yy]) => P(q, o, yy)); };
          const A_ = ring(_a, c0, ya), B_ = ring(_b, c1, yb);
          for(let k = 0; k < A_.length - 1; k++) quad(G.tube, A_[k], A_[k + 1], B_[k + 1], B_[k]);
          if(i % 7 === 0 || (str > 1 && i % 10 === 0 && i % 20 === 0)){ for(const sd of [-1, 1]){ const o = c0 + sd * (R - 0.35), q0 = P(_a, o, ya + 3.6), q1 = P(_b, o + sd * 0.25, yb + 3.6), q2 = P(_b, o + sd * 0.25, yb + 3.9), q3 = P(_a, o, ya + 3.9); quad(G.lamp, q0, q1, q2, q3); } }
        }
        if(el){
          const ms = L.mate[i] || 0, inA = L.inner[i], inB = L.inner[i + str];
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
            if(L.stn && L.stn[i] && L.stn[i + str]){
              // v36: 駅（新倉敷・福山・相生）の簡易ホーム: 線路の外側にホーム（レール面から 1.1m 上・幅約 4m）と屋根・柱
              const o1 = s * 1.75, o2 = s * 5.7, pA = ya + 1.1, pB = yb + 1.1, dA = tA - 1.6, dB = tB - 1.6;
              quad(G.deck, P(_a, o1, pA), P(_a, o2, pA), P(_b, o2, pB), P(_b, o1, pB));
              quad(G.deck, P(_a, o2, pA), P(_a, o2, dA), P(_b, o2, dB), P(_b, o2, pB));
              quad(G.deck, P(_a, o1, dA), P(_a, o1, pA), P(_b, o1, pB), P(_b, o1, dB));
              quad(G.deck, P(_a, o1, dA), P(_a, o2, dA), P(_b, o2, dB), P(_b, o1, dB));
              const cA = ya + 5.3, cB = yb + 5.3, c1 = s * 1.2, c2 = s * 6.4;
              quad(G.wall, P(_a, c1, cA), P(_a, c2, cA), P(_b, c2, cB), P(_b, c1, cB));
              quad(G.wall, P(_a, c2, cA - 0.3), P(_a, c1, cA - 0.3), P(_b, c1, cB - 0.3), P(_b, c2, cB - 0.3));
              quad(G.wall, P(_a, c2, cA - 0.3), P(_b, c2, cB - 0.3), P(_b, c2, cB), P(_a, c2, cA));
              if(i % 12 === 0) for(const [ox, oz] of [[0.2, 0.2], [-0.2, -0.2]]){ const q0 = P(_a, s * 5.2 + ox, pA), q1 = P(_a, s * 5.2 + ox, cA - 0.3);
                quad(G.wall, [q0[0] - 0.2, q0[1], q0[2] - 0.2], [q0[0] + 0.2, q0[1], q0[2] + 0.2], [q1[0] + 0.2, q1[1], q1[2] + 0.2], [q1[0] - 0.2, q1[1], q1[2] - 0.2]); }
              continue;
            }
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
        // 架線柱（電化: 津山線・吉備線は非電化）: 50m おき、線の外側（粗い区間は区間の中の 25 点目ごとの点）
        if(L.key !== "tsuyama" && L.key !== "kibi" && !tn){
          const j0 = Math.ceil(i / 25) * 25;
          if(j0 < i + str){
            pt(L, j0 * 2, _qp);
            const ms = L.mate[i] || 0, side = ms > 0 ? -1 : 1, off = el ? (L.hs ? 3.2 : 2.1) * side : 2.6 * side;
            poles.push({ x: _qp.x + rx * off, z: _qp.z + rz * off, y0: el ? _qp.y - 0.35 : _qp.y - 0.4, y1: _qp.y + (L.hs ? 7.2 : 6.2), arm: -side * (Math.abs(off) + 0.4), rx, rz });
          }
        }
      }
    }
    return { G: Gm, poles };
  }
  function ballastUV(q){ const uv = []; for(let k = 0; k < q.length / 3; k += 6){ const a = k * 3, c = (k + 2) * 3; const L_ = Math.hypot(q[c] - q[a], q[c + 2] - q[a + 2]) / 2.4;
        uv.push(0, 0, 1, 0, 1, L_, 0, 0, 1, L_, 0, L_); } return uv; }
  function buildStaticMeshes(Gm, poles){
    // v31: GPU に送った後に配列を捨てる。作り直しは genStatic をもう一度（同じ入力なので同じ頂点。まとめて作った結果を数秒だけ使い回す）
    let memo = null, memoT = 0;
    const gen = () => { if(!memo) memo = genStatic(); memoT = performance.now(); setTimeout(() => { if(performance.now() - memoT > 4000) memo = null; }, 5000); return memo; };
    const regen = (ck, key, withUV) => () => { const t = new THREE.BufferGeometry(); const arr = gen().G.get(ck)[key];
      t.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); t.computeVertexNormals();
      const out = { position: t.attributes.position.array, normal: t.attributes.normal.array }; if(withUV) out.uv = new THREE.Float32BufferAttribute(ballastUV(arr), 2).array; return out; };
    const mk = (arr, mat, key, ck) => { if(!arr.length) return; const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals();
      GeoMem.release(g, ["position", "normal"], regen(ck, key, false));
      const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; root.add(m); return m; };
    const MT = { deck: new THREE.MeshLambertMaterial({ color: 0xaaa9a3, side: THREE.DoubleSide }), tube: new THREE.MeshLambertMaterial({ color: 0x8e8d88, side: THREE.DoubleSide }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff0c8, side: THREE.DoubleSide }), wall: new THREE.MeshLambertMaterial({ color: 0xc9c8c1, side: THREE.DoubleSide }),
      slab: new THREE.MeshLambertMaterial({ color: 0x8d8b86 }), rail: new THREE.MeshLambertMaterial({ color: 0x8b8781 }) };
    // バラスト＋枕木（手続き的テクスチャ。線路方向に 0.6m おきの枕木）
    const bt = canvasTex(64, 128, (g, w, h) => { noise(g, w, h, "#6d665d", 0.25, 2500); for(let y = 0; y < h; y += 32){ g.fillStyle = "#57534e"; g.fillRect(4, y + 4, w - 8, 12); g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(4, y + 15, w - 8, 2); } });
    const BM = new THREE.MeshLambertMaterial({ map: bt });
    for(const [ck, G] of Gm){
      mk(G.deck, MT.deck, "deck", ck); mk(G.tube, MT.tube, "tube", ck); mk(G.lamp, MT.lamp, "lamp", ck); mk(G.wall, MT.wall, "wall", ck); mk(G.slab, MT.slab, "slab", ck);
      if(G.ballast.length){ const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(G.ballast, 3)); g.computeVertexNormals();
        // UV: 横 = 0..1、縦 = 世界座標の長さ / 2.4m（4 本の枕木）
        g.setAttribute("uv", new THREE.Float32BufferAttribute(ballastUV(G.ballast), 2)); GeoMem.release(g, ["position", "normal", "uv"], regen(ck, "ballast", true)); const m = new THREE.Mesh(g, BM); m.receiveShadow = true; root.add(m); }
      mk(G.rail, MT.rail, "rail", ck);
    }
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
        L.timer[0] -= dt; if(L.timer[0] <= 0){ if(!trains.some(q => q.L === L) && !(PL && PL.L === L)){ L.timer[0] = sv.head * night * (0.85 + Math.random() * 0.3);
          const toStation = L.stop < L.len / 2 ? -1 : 1; spawn(L, toStation); } else L.timer[0] = 30; }
      }
    }
    for(let i = trains.length - 1; i >= 0; i--){
      const T = trains[i], sv = T.sv, L = T.L;
      if(T.state === "run"){
        const rem = T.stopped ? 1e9 : (T.stopS - T.s) * T.dir;
        let vt = rem > 0 ? Math.min(sv.vmax, Math.sqrt(2 * sv.dec * Math.max(0, rem - 0.5))) : 0;
        // v35: 利用者の運転する列車が前にいる間は、手前で止まる（同じ線・同じ向き）
        if(PL && PL.L === L && T.dir === PL.dir){ const ts = PL.a0 + PL.dir * S.pos - PL.dir * PL.len, gap = (ts - T.s) * T.dir;
          if(gap > -30 && gap < 3000) vt = Math.min(vt, Math.sqrt(2 * 0.8 * Math.max(0, gap - 80))); }
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
  /* ================= v35: JR・新幹線を運転する ================= */
  const LNAME = { shinkansen: "山陽新幹線", sanyo: "山陽本線", uno: "宇野線", tsuyama: "津山線", kibi: "吉備線" };
  const LVEH = { shinkansen: ["jr_n700", "jr_n700k"], sanyo: ["jr_u227_3", "jr_u227_5", "jr_y115_4"], uno: ["jr_ml223", "jr_u227_4"], tsuyama: ["jr_kiha47"], kibi: ["jr_kiha47"] };
  // 線区の最高速度とカーブの横加速度は仮定（新幹線 300km/h、山陽本線 120、宇野線 95、津山線・吉備線 85）。駅の位置は OSM の停車位置
  const LLIM = { shinkansen: 300, sanyo: 120, uno: 95, tsuyama: 85, kibi: 85 }, LCURVE = { shinkansen: 2.0, sanyo: 1.1, uno: 1.0, tsuyama: 0.9, kibi: 0.9 };
  let PL = null;     // 運転中: { L, dir, a0（路線の弧長 = a0 + dir × 進んだ距離）, len }
  const PDANGER = {}; // （未使用）
  function trainLen(mk, n){ const M = MODELS[mk]; return (n >= 2 ? 2 * M.lead + (n - 2) * M.len : M.lead) + 0.6 * n; }
  /* 選べる路線: 線路ごと・向きごと。最初の駅から、再現範囲の端（または最後の駅）まで */
  function routeDefs(){
    const out = [], P_ = {x:0,y:0,z:0}, Q_ = {x:0,y:0,z:0};
    for(const L of lines){
      const dirs = L.dir !== 0 ? [L.dir] : [1, -1], sa = L.i0 * 2, sb = L.i1 * 2;
      for(const d of dirs){
        const stAll = L.stops.slice().sort((a, b) => (a.s - b.s) * d);
        if(!stAll.length) continue;
        // v36: 新幹線は、始発の駅（端の駅）と、岡山から出発する 2 通り
        const okIdx = stAll.findIndex(q => q.name === "岡山");
        const starts = L.hs && okIdx > 0 ? [0, okIdx] : [0];
        for(const k0 of starts){
          const st = stAll.slice(k0);
          const ae = d > 0 ? sb : sa, last = st[st.length - 1], farEnd = !L.hs && Math.abs(ae - last.s) > 1200;
          if(st.length === 1 && !farEnd) continue;
          pt(L, st[0].s, P_); pt(L, ae, Q_);
          const dx = Q_.x - P_.x, dz = Q_.z - P_.z, brg = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "東行" : "西行") : (dz > 0 ? "南行" : "北行");
          const toOk = last.name === "岡山" && !farEnd;
          out.push({ key: "jr_" + L.key + "_" + L.ti + "_" + (d > 0 ? "f" : "b") + (k0 ? "_s" + k0 : ""), L, d, stops: st, farEnd, line: L.key,
            name: LNAME[L.key] + " " + (toOk ? "岡山行" : brg) + (k0 ? "（岡山から）" : ""), from: st[0].name, to: farEnd ? "再現範囲の端" : last.name, veh: LVEH[L.key] || ["jr_u227_3"] });
        }
      }
    }
    const ord = { shinkansen: 0, sanyo: 1, uno: 2, tsuyama: 3, kibi: 4 };
    out.sort((a, b) => ord[a.line] - ord[b.line] || a.key.localeCompare(b.key));
    return out;
  }
  function buildRoute(def, vkey){
    const V = VEHICLES[vkey], len = V.len, L = def.L, d = def.d, sa = L.i0 * 2, sb = L.i1 * 2, n = L.i1 - L.i0 + 1, total = (n - 1) * 2;
    const arcOf = (s) => d > 0 ? s - sa : sb - s;
    const track = []; for(let k = 0; k < n; k++){ const i = d > 0 ? L.i0 + k : L.i1 - k; track.push([L.p[3*i], L.p[3*i+1], L.p[3*i+2]]); }
    const stops = def.stops.map(q => { const cen = arcOf(q.s); return { name: q.name, arc: Math.max(len / 2 + 2, Math.min(total - 12, cen + len / 2)), cen, plat: 18 }; });
    if(def.farEnd) stops.push({ name: "再現範囲の端", arc: total - 80, cen: total - 80 - len / 2, plat: 18, virt: true });
    // 制限速度: 線区の最高速度 ∧ カーブ（外接円の半径 R から v = √(a·R)）∧ 岡山駅・各駅の構内
    const lim = new Float32Array(n).fill(LLIM[L.key]), K = 25, hs = L.key === "shinkansen";
    if(hs && L.lim && L.lim.length){   // v36: OSM の maxspeed（300/270/180/150km/h）。0 は不明で 300
      const per = new Float32Array(L.n).fill(LLIM[L.key]); for(let r = 0; r < L.lim.length; r++){ const k1 = r + 1 < L.lim.length ? L.lim[r + 1][0] : L.n; if(L.lim[r][1] > 0) per.fill(L.lim[r][1], L.lim[r][0], k1); }
      for(let k = 0; k < n; k++) lim[k] = Math.min(lim[k], per[d > 0 ? L.i0 + k : L.i1 - k]); }
    for(let k = 0; k < n; k++){
      const a = track[Math.max(0, k - K)], b = track[k], c = track[Math.min(n - 1, k + K)];
      const abx = b[0] - a[0], abz = b[2] - a[2], bcx = c[0] - b[0], bcz = c[2] - b[2], cax = a[0] - c[0], caz = a[2] - c[2];
      const cr = Math.abs(abx * bcz - abz * bcx), R = cr < 1e-6 ? 1e9 : Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(cax, caz) / (2 * cr);
      lim[k] = Math.min(lim[k], 3.6 * Math.sqrt(LCURVE[L.key] * Math.max(R, 60)));
    }
    for(const sp of stops){ if(sp.virt) continue; const ok = sp.name === "岡山";
      for(let k = 0; k < n; k++){ const dd = Math.abs(k * 2 - sp.cen);
        if(hs){ if(dd < 1500) lim[k] = Math.min(lim[k], 160); else if(dd < 3000) lim[k] = Math.min(lim[k], 240); }
        else if(ok){ if(dd < 500) lim[k] = Math.min(lim[k], 45); else if(dd < 1300) lim[k] = Math.min(lim[k], 75); }
        else if(dd < 300) lim[k] = Math.min(lim[k], 85); } }
    const W = 20, sm = new Float32Array(n), floor = hs ? 120 : 25;
    for(let k = 0; k < n; k++){ let m = 1e9; for(let j = Math.max(0, k - W); j <= Math.min(n - 1, k + W); j++) if(lim[j] < m) m = lim[j]; sm[k] = Math.max(floor, Math.round(m / 5) * 5); }
    return { name: def.name, dest: def.to, track, speed: Array.from(sm), stops, signals: [], jr: { L, dir: d, a0: d > 0 ? sa : sb, len }, vkey };
  }
  function makePlayer(vkey){
    const V = VEHICLES[vkey], M = MODELS[V.mk], g = new THREE.Group(), cars = []; let total = 0;
    for(let i = 0; i < V.n; i++){
      const lead = i === 0 || i === V.n - 1, len = lead ? M.lead : M.len, pan = M.pan.includes(i);
      const m = new THREE.Mesh(carGeo(V.mk, lead, pan), carMat); m.castShadow = true; m.userData.flip = i === V.n - 1 && V.n > 1;
      cars.push({ m, len, off: total + len / 2 }); total += len + 0.6; g.add(m);
    }
    g.userData = { jr: true, cars, len: total }; return g;
  }
  function placePlayer(car, headS, pa){      // pa(s)→{x,y,z}（軌道の点）
    for(const c of car.userData.cars){
      const sc = headS - c.off, hb = c.len * 0.34, p = pa(sc + hb), q = pa(sc - hb);
      const dx = p.x - q.x, dz = p.z - q.z, dy = p.y - q.y, hl = Math.hypot(dx, dz) || 1;
      c.m.position.set((p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2);
      c.m.rotation.order = "YXZ"; c.m.rotation.set(0, 0, 0);
      c.m.rotation.y = Math.atan2(dx, dz) + (c.m.userData.flip ? Math.PI : 0); c.m.rotation.x = -Math.atan2(dy, hl) * (c.m.userData.flip ? -1 : 1);
    }
  }
  const elAt = (L, s) => L.el[Math.max(0, Math.min(L.n - 1, Math.round(s / 2)))];
  function playerTun(arc){ return PL && PL.L.tun ? !!PL.L.tun[Math.max(0, Math.min(PL.L.n - 1, Math.round((PL.a0 + PL.dir * arc) / 2)))] : false; }
  function playerEl(arc){ return PL ? !!elAt(PL.L, PL.a0 + PL.dir * arc) : false; }       // 利用者の列車の arc の位置が高架・橋か（下の道路の車を止めないため）
  /* 利用者の前方の AI 列車までの距離（先頭から相手の最後尾まで。同じ線・同じ向き、単線は逆向きも）。いなければ null */
  function aheadGap(){
    if(!PL) return null; const hs = PL.a0 + PL.dir * S.pos; let best = null;
    for(const T of trains){ if(T.L !== PL.L) continue; const rel = (T.s - hs) * PL.dir;
      if(rel <= 0) continue;
      const d = T.dir === PL.dir ? Math.max(0, rel - T.len) : rel;
      if(best === null || d < best) best = d; }
    return best;
  }
  function begin(route){
    PL = route.jr; const hs = PL.a0 + PL.dir * route.stops[0].arc;
    for(let i = trains.length - 1; i >= 0; i--){ const T = trains[i]; if(T.L !== PL.L) continue;
      if(PL.L.dir === 0 || Math.abs(T.s - hs) < 3000){ root.remove(T.g); trains.splice(i, 1); } }
  }
  function end(){ PL = null; }
  /* 周りの車が踏切で突っ込まないよう、走行中の列車の前方にも「見えない障害物」を置く（車・歩行者が手前で止まる）。自分の車は無視する */
  function register(){
    if(!ready) return;
    for(const T of trains){ if(!T.g.visible) continue; const L = T.L;
      for(const c of T.cars){ const n = Math.max(2, Math.ceil(c.len / 2.6)); for(let i = 0; i < n; i++){ const s = T.s - T.dir * (c.off - c.len / 2 + (i + 0.5) / n * c.len); if(elAt(L, s)) continue; pt(L, s, _p); Obs.add(_p.x, _p.z, 1.6, T, _p.y); } }
      if(T.v > 3){ const reach = Math.min(280, 3 * T.v + 30); const dg = T.danger || (T.danger = { danger: true }); for(let d = 8; d <= reach; d += 10){ const s = T.s + T.dir * d; if(elAt(L, s)) continue; pt(L, s, _p); Obs.add(_p.x, _p.z, 3.0, dg, _p.y); } }
    }
  }
  return { init, update, register, routeDefs, buildRoute, makePlayer, placePlayer, trainLen, begin, end, playerEl, playerTun, aheadGap, _spawn: spawn, get trains(){ return trains; }, get lines(){ return lines; }, get ready(){ return ready; }, get playing(){ return !!PL; }, MODELS };
})();
/* v35: JR の運転用車両。加速は「起動加速度（km/h/s）× 定出力域（knee km/h 以上は反比例）」、抵抗は km/h/s の 2 次式。
   数値は各形式の公表値（起動加速度・常用最大減速度）に近い値を使った簡略モデルで、実車の制御特性そのものではない */
{
  const J = (name, mk, n, o) => Object.assign({ name, jr:true, mk, n, len: JR.trainLen(mk, n), front: 0, motor: "vvvf" }, o);
  Object.assign(VEHICLES, {
    jr_n700:   J("N700系 16両（山陽新幹線）", "n700", 16, { vmax:300, knee:80, hs:true, np:13, nb:7, hsA:2.6, hsK:[135,205], acc:[0,0.8,1.5,2.1,2.6], bdec:[0,0.45,0.85,1.25,1.65,2.05,2.4,2.7], ebk:3.1, drag:[0.03,0.0002,0.0000068], dial:320, dstep:40, eyeBack:7.0, eyeH:2.85, cmf:3.0, desc:"最高 300km/h・マスコン P1〜P13／ブレーキ B1〜B7＋非常・起動 2.6km/h/s・約3分で 270km/h（公表値に合わせた簡略モデル）・ATC あり" }),
    jr_n700k:  J("N700系 8両（九州直通）", "n700k", 8, { vmax:300, knee:80, hs:true, np:13, nb:7, hsA:2.6, hsK:[135,205], acc:[0,0.8,1.5,2.1,2.6], bdec:[0,0.45,0.85,1.25,1.65,2.05,2.4,2.7], ebk:3.1, drag:[0.03,0.00022,0.0000072], dial:320, dstep:40, eyeBack:7.0, eyeH:2.85, cmf:3.0, desc:"8両編成・最高 300km/h・P1〜P13／B1〜B7＋非常・ATC あり" }),
    jr_u227_3: J("227系 3両（Urara）", "u227", 3, { vmax:120, knee:55, acc:[0,0.9,1.6,2.2,2.6], bdec:[0,0.8,1.6,2.4,3.2,4.0], ebk:4.5, drag:[0.064,0.0005,0.0000205], dial:140, dstep:20, eyeBack:1.4, eyeH:2.65, cmf:3.8, desc:"最高 120km/h・起動 2.5km/h/s・常用最大減速 4.0km/h/s" }),
    jr_u227_4: J("227系 4両（Urara）", "u227", 4, { vmax:120, knee:55, acc:[0,0.9,1.6,2.2,2.6], bdec:[0,0.8,1.6,2.4,3.2,4.0], ebk:4.5, drag:[0.064,0.0005,0.0000205], dial:140, dstep:20, eyeBack:1.4, eyeH:2.65, cmf:3.8, desc:"4両編成" }),
    jr_u227_5: J("227系 5両（Urara）", "u227", 5, { vmax:120, knee:55, acc:[0,0.9,1.6,2.2,2.6], bdec:[0,0.8,1.6,2.4,3.2,4.0], ebk:4.5, drag:[0.064,0.0005,0.0000205], dial:140, dstep:20, eyeBack:1.4, eyeH:2.65, cmf:3.8, desc:"5両編成" }),
    jr_y115_4: J("115系 4両（黄色）", "y115", 4, { vmax:110, knee:45, acc:[0,0.7,1.2,1.6,1.9], bdec:[0,0.7,1.5,2.3,3.0,3.6], ebk:4.2, drag:[0.07,0.0008,0.000026], dial:120, dstep:20, eyeBack:1.4, eyeH:2.65, cmf:3.5, desc:"最高 110km/h・起動 1.9km/h/s（主電動機が旧式で加速は緩やか）", motor:"dc" }),
    jr_ml223:  J("223系 5両（快速マリンライナー）", "ml223", 5, { vmax:130, knee:70, acc:[0,1.0,1.7,2.3,2.7], bdec:[0,0.8,1.6,2.4,3.2,4.0], ebk:4.5, drag:[0.064,0.0005,0.000022], dial:140, dstep:20, eyeBack:1.4, eyeH:2.65, cmf:3.8, desc:"最高 130km/h（線区の制限は 95km/h とした）" }),
    jr_kiha47: J("キハ47 2両（ディーゼル）", "kiha47", 2, { vmax:95, knee:35, acc:[0,0.6,1.0,1.3,1.6], bdec:[0,0.7,1.4,2.1,2.8,3.5], ebk:4.0, drag:[0.07,0.0008,0.000028], dial:100, dstep:20, eyeBack:1.4, eyeH:2.7, cmf:3.5, desc:"最高 95km/h・起動 1.6km/h/s", motor:"dc" }),
  });
}
const _cen=new THREE.Vector3();
function simTraffic(dt){
  MWT.update(dt); Obs.clear(); Trams.registerAll(); Traffic.register(); Peds.register(); JR.register(); MWT.register();
  PLAYER_POS.on=false;
  if((S.mode==="car"||S.mode==="bus") && Car.C.active){ const C=Car.C, fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), bl=Car.P.len; Obs.addBody(C.x+fx*bl/2, C.z+fz*bl/2, fx, fz, bl, Car.P.wid/2+0.1, PCAR, C.h); _cen.set(C.x,0,C.z);
    PLAYER_POS.on=true; PLAYER_POS.x=C.x; PLAYER_POS.z=C.z; PLAYER_POS.r=Car.P.wid/2; PLAYER_POS.pts.length=0;
    for(let u=-bl/2; u<=bl/2+0.01; u+=Math.max(1.5, bl/6)) PLAYER_POS.pts.push([C.x+fx*u, C.z+fz*u]); }
  else if(S.track){ const len=VEH().len, jr=VEH().jr; for(let s=S.pos-1.3; s>S.pos-len; s-=2.6){ if(jr && JR.playerEl(s)) continue; const p=pointAt(s); Obs.add(p.x,p.z,1.25,Trams.PLAYER,p.y); } _cen.copy(pointAt(S.pos));
    if(jr && S.running && S.speed>10){ const v=S.speed/3.6, reach=Math.min(300,3*v+30); for(let d=8; d<=reach; d+=10){ if(JR.playerEl(S.pos+d)) continue; const p=pointAt(S.pos+d); Obs.add(p.x,p.z,3.0,Trams.PLAYER,p.y); } } }
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
    const bus = Car.P === undefined ? false : Car.P.len > 8, tr = C.profile === "truck";   // v41.7: トラックは左右ミラーだけ（荷台でルームミラーは使えない）
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
    frameN++;
    const use = (bus || tr) ? ["L", "R"] : ["L", "R", "C"];
    if (frameN % 2 === 0) {
      // ミラーには自分の車体（バスの外板）も写す
      if (C.onDriverView) C.onDriverView(false);
      const sm = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
      if (bus) { aim(M.L, C, Car.P, 1.45, 5.7, 2.1, 14, 3); aim(M.R, C, Car.P, -1.45, 5.7, 2.1, 14, 3); }
      else if (tr) { aim(M.L, C, Car.P, 1.4, 2.55, 1.95, 12, 3); aim(M.R, C, Car.P, -1.4, 2.55, 1.95, 12, 3); }
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
    M.C.q.img.visible = M.C.q.frame.visible = !(bus || tr);
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(ov, ocam); renderer.autoClear = true;
  }
  return { render, renderTram };
})();
/* ---------------- v25: 設定・記録の保存（このブラウザの中だけ）とゲームパッド ----------------
   保存: モード・路線・車両・建物の表示・影・時間帯・天気・ヘリの出発地・音、電車（路線ごと）とバスの最高点・評価・回数。
   ブラウザの保存領域が使えない時（プライベートウィンドウなど）は保存しないだけで、動きは変わらない */
const Prefs = (() => {
  const KEY = "okaden.v1"; let st = { set: {}, rec: {}, misc: {} }, restoring = false;
  try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); if(j && typeof j === "object") st = { set: j.set || {}, rec: j.rec || {}, misc: j.misc || {} }; } catch(e){}
  function write(){ try { localStorage.setItem(KEY, JSON.stringify(st)); } catch(e){} }
  function save(){
    if(restoring) return;
    const q = (s) => document.querySelector(s);
    const m = q(".mode-opt.on"), l = q(".look-opt.on"), h = q(".hstart-opt.on"), sh = q(".shadow-opt"), dp = q(".dia-opt");
    st.set = { mode: m && m.dataset.mode, route: S.key, veh: S.vehicle, look: l && l.dataset.look, shadow: sh ? sh.classList.contains("on") : true, dia: dp ? dp.classList.contains("on") : true,
               time: Env.st.time, rain: Env.st.rain, hstart: h && h.dataset.start, sound: st.set.sound !== false,
               play: Object.assign({}, S.playBy), cveh: S.cveh, qsel: { heli: Quest.sel.heli, car: Quest.sel.car } };
    write();
  }
  function setSound(on){ st.set.sound = on; write(); }
  /* v41.10: ナビの設定・最近の目的地・タクシーの収入など、設定画面の外で覚えておく値 */
  const getM = (k, d) => (st.misc && st.misc[k] !== undefined ? st.misc[k] : d);
  function setM(k, v){ if(!st.misc) st.misc = {}; st.misc[k] = v; write(); }
  function restore(){
    const s = st.set; if(!s || !s.mode) { applyMenu(); render(); return; }
    restoring = true;
    try {
      const click = (sel) => { const e = document.querySelector(sel); if(e && !e.classList.contains("on")) e.click(); };
      if(s.route) click('.route-opt[data-key="' + s.route + '"]');
      if(s.veh) click('.veh-opt[data-veh="' + s.veh + '"]');
      if(s.look) click('.look-opt[data-look="' + s.look + '"]');
      const sh = document.querySelector(".shadow-opt"); if(sh && s.shadow === false && sh.classList.contains("on")) sh.click();
      if(s.play && typeof s.play === "object"){ for(const k of ["tram", "bus", "car", "heli"]) if(s.play[k] === "mission" || s.play[k] === "free") S.playBy[k] = s.play[k]; }
      else if(s.dia === false){ S.playBy.tram = "free"; S.playBy.bus = "free"; }   // v41.6 までの「ダイヤ運行: なし」
      if(s.cveh === "sedan" || s.cveh === "truck") S.cveh = s.cveh;
      if(s.qsel){ if(typeof s.qsel.heli === "string") Quest.sel.heli = s.qsel.heli; if(typeof s.qsel.car === "string") Quest.sel.car = s.qsel.car; }
      if(s.time || s.rain != null) Env.set(s.time || null, !!s.rain);
      if(s.hstart) click('.hstart-opt[data-start="' + s.hstart + '"]');
      click('.mode-opt[data-mode="' + s.mode + '"]');
    } catch(e){ console.warn("prefs", e); }
    restoring = false; applyMenu(); render();
  }
  const RANK = (k, s) => k === "bus" ? (s >= 950 ? "S" : s >= 850 ? "A" : s >= 700 ? "B" : "C") : (s > 900 ? "S" : s > 750 ? "A" : s > 550 ? "B" : "C");
  function record(key, score){
    const r = st.rec[key] || { best: 0, n: 0 }; r.n++; const newBest = score > r.best; if(newBest){ r.best = Math.round(score); r.at = new Date().toISOString().slice(0, 10); }
    st.rec[key] = r; write(); render(); return { newBest, best: r.best, n: r.n };
  }
  const best = (k) => (st.rec[k] ? st.rec[k].best : 0);
  function render(){
    const el = document.getElementById("records"); if(!el) return;
    const parts = [];
    for(const [k, r] of Object.entries(st.rec)){
      const name = k === "bus" ? "バス 西大寺線" : k === "dia:bus" ? "ダイヤ運行 バス 西大寺線" : k.startsWith("dia:") ? "ダイヤ運行 " + (S.routes && S.routes[k.slice(4)] ? S.routes[k.slice(4)].name + (k.endsWith("_r") ? "（逆方向）" : "") : k.slice(4)) : (S.routes && S.routes[k.slice(5)] ? S.routes[k.slice(5)].name + (k.endsWith("_r") ? "（逆方向）" : "") : k);
      parts.push((k.startsWith("quest:") ? "ミッション " + ((Quest.def(k.slice(6)) || {}).name || k.slice(6)) : name) + " 最高 " + r.best + " 点（" + RANK(k, r.best) + "）・" + r.n + " 回");
    }
    el.textContent = parts.length ? "これまでの記録（このブラウザ）: " + parts.join(" ／ ") : "";
  }
  document.addEventListener("click", (e) => { if(e.target.closest(".mode-opt,.route-opt,.veh-opt,.look-opt,.shadow-opt,.dia-opt,.time-opt,.rain-opt,.hstart-opt,.play-opt,.cveh-opt,.quest-opt")) setTimeout(save, 0); });
  document.addEventListener("keydown", (e) => { if(e.key === "n" || e.key === "N" || e.key === "m" || e.key === "M") setTimeout(save, 0); });
  return { save, restore, record, render, setSound, best, getM, setM, get soundOn(){ return st.set.sound !== false; } };
})();
/* ゲームパッド（標準配置: Xbox / PlayStation 系）
   電車: RB・LB（または十字キー上下）= マスコン進め・戻し、RT・LT = ブレーキ強め・弱め、A = ドア、B = 非常ブレーキ、X = 警笛、Y = 視点
   車・バス: 左スティック = ハンドル、RT = アクセル、LT = ブレーキ、A = 扉（バス）、X = 警笛、Y = 視点、B = サイドブレーキ、Back = ギア D/R、Start = 道路に戻る
   ヘリ: 左スティック = 前後・旋回、右スティック = 横移動・上昇下降、RT・LT = 上昇・下降、RB = 速く、Y = 視点、X = 自動周回 */
const Pad = (() => {
  const prev = []; let on = false, msgT = 0;
  const PIN = { thr: 0, brk: 0, steer: 0, lookX: 0, lookY: 0, active: false };
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
      PIN.active = true; PIN.thr = b(7); PIN.brk = b(6); PIN.steer = ax(0); PIN.lookX = pressed(4) ? -1 : pressed(5) ? 1 : ax(2); PIN.lookY = ax(3);   // v41.11: 右スティック・LB/RB で見回し
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
/* ---------------- v41.10: ナビ（車・トラック・タクシー）----------------
   経路: AI 車が走る車線のつながり（data/traffic.json の車線・接続。一方通行・右左折・信号の位置が入っている）で A* 探索。
         所要時間 = 区間の長さ ÷（制限速度 × 0.85）＋ 信号 6 秒・右折 4 秒・左折 1.5 秒。
         v41.11: 大通りを優先する。経路のコスト = 所要時間 × 道の大きさの係数（幹線 1.0・準幹線/2 車線の市道 1.2・片側 1 車線の準幹線 1.5・片側 1 車線の市道 2.0・細い道 3.0・生活道路 3.5）
         ＋ 曲がるたびに +4 秒 ＋ 大きな道から細い道へ入る +8 秒 ＋ 細い道どうしの右左折 +8 秒。道の大きさ（imp）は raiseLimits() が車線ごとに付ける（OSM の種別＋片側の車線数）。
         ふつうの経路で、時間の差は 2% ほど・距離は 1 割ほど長くなる代わりに、大通りの割合が 35% → 55% ほどになる（tools/tests/nav_route_stats.js）。
   表示: ミニマップ・大きな地図の青い線（太く・進行方向の矢じり・次の曲がり角の印・通過ずみは灰色）・画面上部の案内（次に曲がる所までの距離と矢印・残り距離・到着の見込み）・音声。
         道路の上の青い帯（矢印が流れる）は v41.11 から既定で OFF（交差点で横にそれて見える）。「道路の線」ボタンで ON にできる。
   外れたら 2 秒で再探索。逆走は 2.5 秒で再探索。目的地は「地名・施設名」の検索（data/poi.json）か、地図で選ぶ。
   ミッション・タクシーでは目的地が変わるたびに自動で設定される（src="auto"）。山陽自動車道（MW）はこの車線網に入っていないので案内できない。
   ※ 一般の車のナビとちがい、実際の通行止め・工事・渋滞は考えない。経路は車線網の最短時間であり、現実のナビと同じとは限らない。 */
const Nav = (() => {
  const D2R = Math.PI / 180;
  const OPT = { voice: true, line: false };   // v41.11: 道路の上の青い帯は既定で OFF（交差点で横にそれて見える・地図で案内する）。「道路の線」ボタンで ON にできる
  const st = { target: null, src: "", R: null, prog: 0, mi: 0, lat: 0, offT: 0, wrongT: 0, tPlan: -99, state: "idle", fail: false, arrT: 0, nPlan: 0, planMs: 0, said: "", dirty: true, lastRem: 0 };
  let GR = null, POI = null, IDX = null;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const me = () => ({ x: Car.C.x, z: Car.C.z, yaw: Car.C.yaw, v: Math.abs(Car.C.v) });
  const carOn = () => S.mode === "car" && Car.C.active;
  const fmtD = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.max(0, Math.round(m / 10) * 10) + " m";
  const fmtMin = (s) => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? Math.floor(m / 60) + "時間" + (m % 60 ? m % 60 + "分" : "") : m + "分"; };
  const hhmm = (sec) => { sec = ((Math.round(sec) % 86400) + 86400) % 86400; return String(Math.floor(sec / 3600)).padStart(2, "0") + ":" + String(Math.floor(sec / 60) % 60).padStart(2, "0"); };

  /* ================= 経路探索 ================= */
  /* 車線のつながり（有向グラフ）の「いちばん大きい強連結成分」＝街の本線網を求め、
     そこへ入れる車線（出発に使える）・そこから行ける車線（到着に使える）に印を付ける。行き止まり・孤立した短い車線に当たっても、別の車線へ案内するため。 */
  function reachMasks(segs, N){
    const idx = new Int32Array(N).fill(-1), low = new Int32Array(N), onS = new Uint8Array(N), comp = new Int32Array(N).fill(-1), ptr = new Int32Array(N), st = [], cs = [];
    let counter = 0, nc = 0;
    for(let r = 0; r < N; r++){
      if(idx[r] !== -1) continue; cs.push(r); idx[r] = low[r] = counter++; st.push(r); onS[r] = 1;
      while(cs.length){
        const v = cs[cs.length - 1], nx = segs[v].next;
        if(ptr[v] < nx.length){ const w = nx[ptr[v]++];
          if(idx[w] === -1){ idx[w] = low[w] = counter++; st.push(w); onS[w] = 1; cs.push(w); } else if(onS[w] && idx[w] < low[v]) low[v] = idx[w]; }
        else { cs.pop(); if(cs.length){ const u = cs[cs.length - 1]; if(low[v] < low[u]) low[u] = low[v]; }
          if(low[v] === idx[v]){ let w; do{ w = st.pop(); onS[w] = 0; comp[w] = nc; }while(w !== v); nc++; } }
      }
    }
    const size = new Int32Array(nc); for(let i = 0; i < N; i++) size[comp[i]]++; let main = 0; for(let c = 1; c < nc; c++) if(size[c] > size[main]) main = c;
    const fromMain = new Uint8Array(N), toMain = new Uint8Array(N); let q = [];
    for(let i = 0; i < N; i++) if(comp[i] === main){ fromMain[i] = 1; toMain[i] = 1; q.push(i); }
    const fq = q.slice(); while(fq.length){ const c = fq.pop(); for(const j of segs[c].next) if(!fromMain[j]){ fromMain[j] = 1; fq.push(j); } }
    // 逆向きの辺（CSR）
    const deg = new Int32Array(N + 1); for(let i = 0; i < N; i++) for(const j of segs[i].next) deg[j + 1]++; for(let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const fill = deg.slice(0, N), rev = new Int32Array(deg[N]); for(let i = 0; i < N; i++) for(const j of segs[i].next) rev[fill[j]++] = i;
    while(q.length){ const c = q.pop(); for(let e = deg[c]; e < deg[c + 1]; e++){ const j = rev[e]; if(!toMain[j]){ toMain[j] = 1; q.push(j); } } }
    return { fromMain, toMain, mainN: size[main] };
  }
  function graph(){
    if(GR) return GR;
    const segs = Traffic.segs, N = segs.length; if(!N || !Traffic.ready) return null;
    const ex = new Float32Array(N), ez = new Float32Array(N), ec = new Float32Array(N), et = new Float32Array(N); let vmax = 10;
    for(let i = 0; i < N; i++){
      const g = segs[i], A = g.P.P, n = g.P.n; ex[i] = A[(n - 1) * 3]; ez[i] = A[(n - 1) * 3 + 2];
      const sp = Math.max(3, (g.v || 30) / 3.6); if(sp > vmax) vmax = sp;
      const t = g.P.len / (sp * 0.85); let c = t;
      if(g.lane){
        // v41.11: 大通りを優先（細い道は走りにくいので、時間が少し短くても選ばれにくくする）。幹線 ×1.0・準幹線/2車線の市道 ×1.2・片側1車線の準幹線 ×1.5・片側1車線の市道 ×2.0・細い道 ×3.0・生活道路 ×3.5
        const im = g.imp || 1; c *= im >= 3.5 ? 1 : im >= 2.5 ? 1.2 : im >= 2.0 ? 1.5 : im >= 1.4 ? 2.0 : im >= 0.6 ? 3.0 : 3.5;
        if(g.sig) c += 6;
      }
      else {
        c += g.kind === "r" ? 4 : g.kind === "l" ? 1.5 : g.kind === "s" ? 0 : 3;
        if(g.kind !== "s") c += 4;     // 曲がる回数を減らす（右左折ごとに +4 秒）
        // 大きな道から細い道へ入る（+8 秒＋道の差）・細い道どうしの右左折（さらに +8 秒＝くねくね曲がる経路を避ける）
        const a = segs[g.from], b = segs[g.next[0]];
        if(a && b && a.lane && b.lane){ const ia = a.imp || 1, ib = b.imp || 1;
          if(ib < ia - 0.5) c += 8 + (ia - ib) * 1.2;
          if((g.kind === "l" || g.kind === "r") && ia < 1.4 && ib < 1.4) c += 8; }
      }
      et[i] = t; ec[i] = c;
    }
    const masks = reachMasks(segs, N);
    GR = { N, ex, ez, ec, et, okS: masks.toMain, okG: masks.fromMain, mainN: masks.mainN, vmax: vmax * 0.85, stamp: new Uint32Array(N), gs: new Float32Array(N), pv: new Int32Array(N), run: 0, hk: new Float64Array(1 << 17), hv: new Int32Array(1 << 17), hn: 0 };
    return GR;
  }
  function hpush(G, k, v){
    if(G.hn >= G.hk.length){ const a = new Float64Array(G.hk.length * 2), b = new Int32Array(G.hv.length * 2); a.set(G.hk); b.set(G.hv); G.hk = a; G.hv = b; }
    let i = G.hn++; const K = G.hk, V = G.hv;
    while(i > 0){ const p = (i - 1) >> 1; if(K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = k; V[i] = v;
  }
  function hpop(G){
    const K = G.hk, V = G.hv, top = V[0], k = K[--G.hn], v = V[G.hn]; let i = 0, n = G.hn;
    while(true){ let c = i * 2 + 1; if(c >= n) break; if(c + 1 < n && K[c + 1] < K[c]) c++; if(K[c] >= k) break; K[i] = K[c]; V[i] = V[c]; i = c; }
    if(n > 0){ K[i] = k; V[i] = v; } return top;
  }
  /* sa: {i,s} 出発（車線の番号・始点からの距離）。goals: [{i,s}] 到着の候補。戻り {path:[区間の番号…], goal, cost} / null */
  function astar(sa, goals, gx, gz){
    const G = graph(), segs = Traffic.segs; if(!G) return null; const run = ++G.run;
    const gm = new Map(); for(const g of goals) gm.set(g.i, g);
    const h = (i) => Math.hypot(G.ex[i] - gx, G.ez[i] - gz) / G.vmax;
    let best = Infinity, bestPrev = -1, bestGoal = null; G.hn = 0;
    const L0 = Math.max(1, segs[sa.i].P.len), c0 = G.ec[sa.i] * (1 - sa.s / L0);
    const g0 = gm.get(sa.i); if(g0 && g0.s >= sa.s){ best = G.ec[sa.i] * (g0.s - sa.s) / L0 + (g0.pen || 0); bestPrev = -2; bestGoal = g0; }
    G.stamp[sa.i] = run; G.gs[sa.i] = c0; G.pv[sa.i] = -1; hpush(G, c0 + h(sa.i), sa.i);
    let it = 0;
    while(G.hn){
      const f = G.hk[0], cur = hpop(G); if(f >= best) break;
      const gc = G.gs[cur]; if(f > gc + h(cur) + 1e-3) continue;
      const nx = segs[cur].next;
      for(let q = 0; q < nx.length; q++){
        const j = nx[q], g2 = gm.get(j);
        if(g2){ const c = gc + G.ec[j] * g2.s / Math.max(1, segs[j].P.len) + (g2.pen || 0); if(c < best){ best = c; bestPrev = cur; bestGoal = g2; } }
        const cn = gc + G.ec[j];
        if(G.stamp[j] !== run || cn < G.gs[j] - 1e-4){ G.stamp[j] = run; G.gs[j] = cn; G.pv[j] = cur; hpush(G, cn + h(j), j); }
      }
      if(++it > 600000) break;
    }
    if(!bestGoal) return null;
    let path;
    if(bestPrev === -2) path = [sa.i];
    else { path = []; let c = bestPrev; while(c !== -1){ path.push(c); c = G.pv[c]; } path.reverse(); path.push(bestGoal.i); }
    return { path, goal: bestGoal, cost: best, iters: it };
  }

  /* ---- 経路の折れ線・曲がり角 ---- */
  function build(sol, sa, px, pz, tx, tz){
    const segs = Traffic.segs, G = graph(), path = sol.path, X = [], Y = [], Z = [], D = [], T = [], K = [];
    let dist = 0, time = 0, lx = 0, lz = 0, first = true;
    const marks = [];
    const add = (x, y, z, kd, tpm) => {
      if(!first){ const d = Math.hypot(x - lx, z - lz); if(d < 0.02) return; dist += d; time += d * tpm; }
      first = false; lx = x; lz = z; X.push(x); Y.push(y); Z.push(z); D.push(dist); T.push(time); K.push(kd);
    };
    for(let j = 0; j < path.length; j++){
      const id = path[j], g = segs[id], P = g.P, A = P.P, n = P.n, kd = g.lane ? 0 : 1;
      const s0 = j === 0 ? sa.s : 0, s1 = j === path.length - 1 ? sol.goal.s : P.len, tpm = G.et[id] / Math.max(1, P.len), d0 = dist;
      if(s1 < s0 + 0.05 && j > 0) { marks.push({ id, d0, d1: dist }); continue; }
      const at = (s) => { const q = pathPt(P, s); return q; };
      const a = at(s0); add(a.x, a.y, a.z, kd, tpm);
      for(let k = 0; k < n; k++){ const c = P.C[k]; if(c > s0 + 0.05 && c < s1 - 0.05) add(A[k * 3], A[k * 3 + 1], A[k * 3 + 2], kd, tpm); }
      const b = at(s1); add(b.x, b.y, b.z, kd, tpm);
      marks.push({ id, d0, d1: dist });
    }
    // 出発点と到着点がほぼ同じ（目的地のすぐそばの車線にいる）とき: 0.6m だけの経路にして、すぐ「到着」にする
    if(X.length === 1){ const gp = segs[path[path.length - 1]].P, sg = Math.min(gp.len, sol.goal.s), tg = pathTan(gp, sg); X.push(X[0] + tg.x * 0.6); Y.push(Y[0]); Z.push(Z[0] + tg.z * 0.6); D.push(0.6); T.push(0.1); K.push(0); dist = 0.6; time = 0.1; }
    const n = X.length; if(n < 2) return null;
    const R = { n, X: Float32Array.from(X), Y: Float32Array.from(Y), Z: Float32Array.from(Z), D: Float32Array.from(D), T: Float32Array.from(T), K: Uint8Array.from(K), total: dist, time, man: [], marks };
    // 曲がり角（接続の区間ごと）
    const ptAt = (d) => { d = Math.max(0, Math.min(R.total, d)); let lo = 0, hi = n - 1; while(hi - lo > 1){ const m = (lo + hi) >> 1; if(R.D[m] <= d) lo = m; else hi = m; } const L = R.D[hi] - R.D[lo] || 1, t = (d - R.D[lo]) / L; return [R.X[lo] + (R.X[hi] - R.X[lo]) * t, R.Z[lo] + (R.Z[hi] - R.Z[lo]) * t]; };
    R.ptAt = ptAt;
    const nm = (g) => { const k = g && g.lane ? g.nm : -1; const names = Traffic.names; return k >= 0 && names && names[k] ? names[k] : ""; };
    for(let j = 1; j < marks.length - 1; j++){
      const g = segs[marks[j].id]; if(g.lane) continue;
      const m = marks[j], dIn = Math.max(0, m.d0 - 9), dOut = Math.min(R.total, m.d1 + 9);
      if(m.d1 - m.d0 < 0.3 && m.d0 < 1) continue;
      const pa = ptAt(dIn), pb = ptAt(m.d0), pc = ptAt(m.d1), pd = ptAt(dOut);
      let ax = pb[0] - pa[0], az = pb[1] - pa[1], bx = pd[0] - pc[0], bz = pd[1] - pc[1]; const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz); if(la < 1 || lb < 1) continue;
      ax /= la; az /= la; bx /= lb; bz /= lb;
      const sinL = bx * az - bz * ax, cosA = ax * bx + az * bz, ang = Math.atan2(sinL, cosA), aa = Math.abs(ang) / D2R;
      if(aa < 22) continue;
      const side = ang > 0 ? "L" : "R", type = aa < 60 ? "slight" + side : aa < 125 ? (side === "L" ? "left" : "right") : aa < 165 ? "sharp" + side : "uturn";
      const prev = segs[marks[j - 1].id], next = segs[marks[j + 1].id];
      R.man.push({ d: m.d0, d1: m.d1, type, ang: ang / D2R, signal: !!(prev && prev.lane && prev.sig), from: nm(prev), to: nm(next), s1: false, s2: false, s3: false });
    }
    R.man.push({ d: R.total, d1: R.total, type: "arrive", ang: 0, signal: false, from: "", to: "", s1: false, s2: false, s3: false });
    return R;
  }

  /* 目的地までの経路を探す。戻り: ルート / null */
  function plan(px, pz, yaw, tx, tz){
    const t0 = performance.now();
    const G0 = graph(); if(!G0) return null; const starts = Traffic.locate(px, pz, yaw, 260, 5, G0.okS); if(!starts.length) return null;
    // 到着の候補: いちばん近い車線から 90m 以内の車線を最大 10 本。遠い車線ほど「道路を外れて歩く」ぶんの時間を足す（行き止まり・孤立した車線に当たっても、別の車線へ案内できる）
    const goalsOf = (rmax, k, span) => { const ok = Traffic.locate(tx, tz, null, rmax, k, G0.okG), raw = Traffic.locate(tx, tz, null, rmax, k, null); if(!ok.length) return null;
      // 本線から入れない車線（一方通行の入口・行き止まり側）も候補に。出発点がその車線の上なら、すぐ着ける。ほかの出発点からは行けないので、A* が自然に捨てる
      const dmin = Math.min(ok[0].d, raw.length ? raw[0].d : 1e9), seen = new Set(), all = [];
      for(const g of raw.slice(0, 3).concat(ok.filter((q) => q.d <= ok[0].d + span).slice(0, 10))){ if(seen.has(g.i)) continue; seen.add(g.i); all.push(g); }   // 入れる車線は従来どおり必ず含める（行き着けない候補だけにならないように）
      return all.map((g) => ({ i: g.i, s: g.s, x: g.x, z: g.z, y: g.y, pen: (g.d - dmin) / 3.5 })); };   // v41.11: 5→3.5（細い道のコストを上げたぶん、目的地から遠い大通りで終わりにしにくくする）
    // 出発の候補: 向きが合う近い車線（最大 2 本）を先に。見つからなければ、反対向き・行き止まりの車線（最大 3 本）も使う
    const pri = starts.filter((q) => q.dot > 0.2).slice(0, 2), rest = starts.filter((q) => q.dot <= 0.2).slice(0, 3);
    let best = null;
    for(const [rmax, k, span] of [[320, 14, 90], [900, 24, 250]]){
      const gl = goalsOf(rmax, k, span); if(!gl) continue;
      for(const group of [pri, rest]){
        for(const sa of group){ const sol = astar(sa, gl, tx, tz); if(!sol) continue;
          const sc = sol.cost + sa.d * 0.4 + (sa.dot < 0.2 ? 25 : 0); if(!best || sc < best.sc) best = { sol, sa, sc }; }
        if(best) break; }
      if(best) break; }
    if(!best) return null;
    const R = build(best.sol, best.sa, px, pz, tx, tz); if(!R) return null;
    R.sa = best.sa; R.px0 = px; R.pz0 = pz; R.goalPt = best.sol.goal; R.ms = performance.now() - t0; R.iters = best.sol.iters;
    // 道路の外の部分（出発点→道路・道路→目的地）は点線で
    R.legS = best.sa.d > 5 ? [[px, pz], [best.sa.x, best.sa.z]] : null;
    const ex = R.X[R.n - 1], ez = R.Z[R.n - 1], dEnd = Math.hypot(tx - ex, tz - ez);
    R.legE = dEnd > 8 ? [[ex, ez], [tx, tz]] : null; R.legEL = R.legE ? dEnd : 0; R.legSL = R.legS ? best.sa.d : 0;
    return R;
  }

  /* ================= 現在地の追跡・案内 ================= */
  function idxAt(R, d){ let lo = 0, hi = R.n - 1; while(hi - lo > 1){ const m = (lo + hi) >> 1; if(R.D[m] <= d) lo = m; else hi = m; } return lo; }
  function project(R, x, z, d0, d1){
    let bl = 1e9, ba = 0; const lo = idxAt(R, Math.max(0, d0)), hi = Math.min(R.n - 2, idxAt(R, d1) + 1);
    for(let k = lo; k <= hi; k++){
      const x0 = R.X[k], z0 = R.Z[k], dx = R.X[k + 1] - x0, dz = R.Z[k + 1] - z0, L2 = dx * dx + dz * dz; let t = L2 > 1e-9 ? ((x - x0) * dx + (z - z0) * dz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + dx * t, pz = z0 + dz * t, d = Math.hypot(px - x, pz - z);
      if(d < bl){ bl = d; ba = R.D[k] + Math.sqrt(L2) * t; }
    }
    return { lat: bl, arc: ba };
  }
  function tangentAt(R, d){ const a = R.ptAt(d - 3), b = R.ptAt(d + 3); const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; }
  function remDist(){ const R = st.R; if(!R) return st.target ? Math.hypot(st.target.x - Car.C.x, st.target.z - Car.C.z) : 0; return Math.max(0, R.total - st.prog) + R.legEL; }
  function remTime(){ const R = st.R; if(!R) return 0; const k = idxAt(R, st.prog); return Math.max(0, (R.T[R.n - 1] - R.T[k]) * 1.12 + R.legEL / 6 + R.legSL / 6); }

  /* ---- 音声 ---- */
  const Voice = { ok: typeof speechSynthesis !== "undefined", voice: null, last: "", t: 0, pend: null,
    pick(){ try{ const vs = speechSynthesis.getVoices(); this.voice = vs.find((v) => /^ja/i.test(v.lang)) || null; }catch(e){} },
    speak(text){
      try{ if(!Voice.voice) Voice.pick(); const u = new SpeechSynthesisUtterance(text); u.lang = "ja-JP"; if(Voice.voice) u.voice = Voice.voice; u.rate = 1.05;
        u.onend = () => { if(Voice.pend){ const t = Voice.pend; Voice.pend = null; Voice.speak(t); } }; speechSynthesis.speak(u); }catch(e){} },
    /* urgent: 話している途中でも割り込む（「まもなく右折」など）。ふつうは、いま話している案内が終わってから次を話す（最新の 1 件だけ待つ） */
    say(text, urgent){
      st.said = text; Voice.last = text; Voice.t = performance.now();
      if(!OPT.voice || !Voice.ok || (typeof Prefs !== "undefined" && Prefs.soundOn === false)) return;
      try{ if(urgent){ Voice.pend = null; speechSynthesis.cancel(); Voice.speak(text); }
        else if(speechSynthesis.speaking){ Voice.pend = text; } else Voice.speak(text); }catch(e){} },
    stop(){ Voice.pend = null; try{ if(Voice.ok) speechSynthesis.cancel(); }catch(e){} } };
  const ACT = { straight: ["直進", "直進"], slightL: ["斜め左", "斜め左方向"], slightR: ["斜め右", "斜め右方向"], left: ["左折", "左方向"], right: ["右折", "右方向"], sharpL: ["左へ急カーブ", "左へ大きく曲がる方向"], sharpR: ["右へ急カーブ", "右へ大きく曲がる方向"], uturn: ["Uターン", "Uターン"], arrive: ["目的地", "目的地"] };
  const distSay = (m) => m >= 950 ? (m < 1300 ? "1キロ" : "約" + (Math.round(m / 500) / 2).toString().replace(/\.0$/, "") + "キロ") : "約" + Math.max(100, Math.round(m / 50) * 50) + "メートル";
  function announce(m, d, v){
    const R = st.R; if(!R) return; const mv = R.man[st.mi]; if(!mv) return; if(S.t - st.tPlan < 5 && st.prog < 20) return;   // 案内の開始直後は、開始のメッセージを優先
    const far = Math.max(420, Math.min(1000, v * 20)), near = Math.max(90, v * 6);
    if(mv.type === "arrive"){ if(!mv.s2 && d < 120 && st.src !== "auto"){ mv.s2 = true; Voice.say("まもなく目的地周辺です。"); } return; }
    const act = ACT[mv.type][1];
    if(!mv.s1 && d < far && d > near + 40){ mv.s1 = true; Voice.say(distSay(d) + "先、" + (mv.signal ? "信号を" : "") + act + "です。"); }
    else if(!mv.s2 && d < near){ mv.s1 = true; mv.s2 = true; Voice.say("まもなく、" + act + "です。", true); }
  }

  /* ================= 目的地の設定・解除 ================= */
  function setTarget(t, src, opt){
    opt = opt || {};
    st.target = { x: t.x, z: t.z, name: t.name || "目的地", r: t.r || 40, kind: t.kind || "" }; st.src = src || "user"; st.R = null; st.prog = 0; st.mi = 0; st.state = "routing"; st.fail = false; st.tPlan = -99; st.arrT = 0; st.dirty = true; st.quiet = !!opt.quiet; st.first = true;
    if(src !== "auto" && Prefs && Prefs.setM) pushRecent(st.target);
    ui.show(true);
  }
  function clear(src){
    if(src && st.src !== src) return;
    st.target = null; st.src = ""; st.R = null; st.state = "idle"; st.fail = false; Voice.stop(); st.dirty = true; ribHide(); pinHide(); ui.show(false);
  }
  function pushRecent(t){
    if(!Prefs.getM) return; let L = Prefs.getM("navRecent", []); if(!Array.isArray(L)) L = [];
    L = L.filter((q) => q.name !== t.name); L.unshift({ name: t.name, x: Math.round(t.x), z: Math.round(t.z) }); Prefs.setM("navRecent", L.slice(0, 6));
  }
  function doPlan(reason){
    const m = me(), t = st.target; if(!t) return;
    const R = plan(m.x, m.z, m.v > 1 ? m.yaw : m.yaw, t.x, t.z); st.tPlan = S.t; st.nPlan++;
    if(!R){
      st.R = null; st.fail = true; st.state = "fail"; st.dirty = true;
      if(!st.quiet || reason !== "init") Voice.say("この目的地までのルートが見つかりません。直線で案内します。", true);
      ribHide(); return;
    }
    st.R = R; st.prog = 0; st.mi = 0; st.joined = false; st.fail = false; st.state = "guide"; st.dirty = true; st.planMs = R.ms;
    if(reason === "init"){ if(st.src === "auto"){ if(!st.quiet) Voice.say(st.target.name + "へ案内します。"); } else Voice.say("ルート案内を開始します。目的地まで約" + (R.total / 1000).toFixed(1) + "キロ、およそ" + fmtMin(remTime()) + "です。"); }
    else if(reason === "off" || reason === "wrong") Voice.say("ルートを再検索しました。", true);
    ribDirty();
  }

  /* ================= 3D の帯・目的地の柱 ================= */
  let ribR = null, ribL = null, pin = null;
  function makeRibbon(maxPts, draw, opacity, repeatV){
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(maxPts * 6), uv = new Float32Array(maxPts * 4), col = new Float32Array(maxPts * 8), idx = new Uint16Array((maxPts - 1) * 6);
    for(let i = 0; i < maxPts - 1; i++){ const a = i * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6); }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute("color", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.setDrawRange(0, 0);
    const tex = canvasTex(64, 128, draw); tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, vertexColors: true, depthWrite: false, side: THREE.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.visible = false; scene.add(mesh);
    return { mesh, geo, mat, tex, max: maxPts };
  }
  const drawRoute = (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = "#1c6df0"; g.fillRect(0, 0, w, h); g.fillStyle = "rgba(255,255,255,.95)"; g.fillRect(0, 0, 5, h); g.fillRect(w - 5, 0, 5, h);
    g.fillStyle = "#ffffff"; g.beginPath(); g.moveTo(w / 2, 6); g.lineTo(w - 12, 50); g.lineTo(w - 24, 50); g.lineTo(w / 2, 22); g.lineTo(24, 50); g.lineTo(12, 50); g.closePath(); g.fill(); };
  const drawLeg = (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = "rgba(255,255,255,.9)"; for(let y = 8; y < h; y += 32){ g.beginPath(); g.arc(w / 2, y + 8, 8, 0, 7); g.fill(); } };
  /* pts: [[x,y,z,d]…]（d は始点からの距離）。width m。fade: 先端の消え始めからの距離 */
  function ribSet(rb, pts, width, yoff, fadeFrom, fadeLen, vscale){
    const n = Math.min(pts.length, rb.max); if(n < 2){ rb.geo.setDrawRange(0, 0); rb.mesh.visible = false; return; }
    const pos = rb.geo.attributes.position.array, uv = rb.geo.attributes.uv.array, col = rb.geo.attributes.color.array, hw = width / 2;
    for(let i = 0; i < n; i++){
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]; let dx = b[0] - a[0], dz = b[2] - a[2]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = dz, nz = -dx, p = pts[i], y = p[1] + yoff, al = fadeLen > 0 ? Math.max(0, Math.min(1, 1 - (p[3] - fadeFrom) / fadeLen)) : 1;
      pos[i * 6] = p[0] - nx * hw; pos[i * 6 + 1] = y; pos[i * 6 + 2] = p[2] - nz * hw; pos[i * 6 + 3] = p[0] + nx * hw; pos[i * 6 + 4] = y; pos[i * 6 + 5] = p[2] + nz * hw;
      uv[i * 4] = 0; uv[i * 4 + 1] = p[3] / vscale; uv[i * 4 + 2] = 1; uv[i * 4 + 3] = p[3] / vscale;
      for(let q = 0; q < 2; q++){ const o = i * 8 + q * 4; col[o] = col[o + 1] = col[o + 2] = 1; col[o + 3] = al; }
    }
    rb.geo.attributes.position.needsUpdate = true; rb.geo.attributes.uv.needsUpdate = true; rb.geo.attributes.color.needsUpdate = true;
    rb.geo.setDrawRange(0, (n - 1) * 6); rb.mesh.visible = true;
  }
  function ribHide(){ if(ribR) ribR.mesh.visible = false; if(ribL) ribL.mesh.visible = false; }
  let ribDirtyF = true; function ribDirty(){ ribDirtyF = true; }
  let ribProg = -99;
  function updateRibbons(dt){
    if(!ribR){ ribR = makeRibbon(260, drawRoute, 0.82); ribL = makeRibbon(64, drawLeg, 0.9); }
    const R = st.R, m = me(); let any = false;
    if(OPT.line && carOn() && st.target){
      if(R && (ribDirtyF || Math.abs(st.prog - ribProg) > 2.5)){
        ribDirtyF = false; ribProg = st.prog;
        const d0 = Math.max(0, st.prog - 6), d1 = Math.min(R.total, st.prog + 420), pts = []; const step = 2.4;
        for(let d = d0; d < d1 + 0.01; d += step){ const k = idxAt(R, d), j = Math.min(R.n - 1, k + 1), L = R.D[j] - R.D[k] || 1, t = (d - R.D[k]) / L; pts.push([R.X[k] + (R.X[j] - R.X[k]) * t, R.Y[k] + (R.Y[j] - R.Y[k]) * t, R.Z[k] + (R.Z[j] - R.Z[k]) * t, d - d0]); }
        ribSet(ribR, pts, 1.7, 0.16, (d1 - d0) - 130, 130, 4);
      }
      if(R) ribR.mesh.visible = true;
      if(ribR.tex) ribR.tex.offset.y = -((performance.now() / 1000) * 0.75) % 1;
      // 点線: 出発点→道路、道路→目的地（残り）
      const L = (R && R.legE && st.prog > R.total - 60) ? R.legE : (!R && st.target ? [[m.x, m.z], [st.target.x, st.target.z]] : null);
      if(L){ const pts = []; const dx = L[1][0] - L[0][0], dz = L[1][1] - L[0][1], len = Math.hypot(dx, dz) || 1; for(let d = 0; d <= len; d += Math.max(2, len / 60)){ const x = L[0][0] + dx * d / len, z = L[0][1] + dz * d / len; pts.push([x, Car.hAt(x, z) + 0.05, z, d]); } pts.push([L[1][0], Car.hAt(L[1][0], L[1][1]) + 0.05, L[1][1], len]); ribSet(ribL, pts, 0.9, 0.12, 0, 0, 3); any = true; }
      else ribL.mesh.visible = false;
    } else ribHide();
    if(ribL && ribL.tex) ribL.tex.offset.y = -((performance.now() / 1000) * 0.5) % 1;
  }
  function pinShow(t){
    if(!pin){ const g = new THREE.Group(); const mb = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 120, 10, 1, true), mb(0xff3d8b, 0.42)); beam.position.y = 60; g.add(beam);
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 4.6, 40), mb(0xff3d8b, 0.85)); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2; g.add(ring);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshBasicMaterial({ map: canvasTex(128, 64, (c, w, h) => { for(let y = 0; y < 4; y++) for(let x = 0; x < 8; x++){ c.fillStyle = (x + y) % 2 ? "#111" : "#fff"; c.fillRect(x * w / 8, y * h / 4, w / 8, h / 4); } }), side: THREE.DoubleSide, fog: false })); flag.position.set(2.1, 13.5, 0); g.add(flag);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 15, 6), new THREE.MeshBasicMaterial({ color: 0x222222, fog: false })); pole.position.y = 7.5; g.add(pole);
      pin = { g, flag }; scene.add(g); }
    pin.g.position.set(t.x, Car.hAt(t.x, t.z) + 0.1, t.z); pin.g.visible = true;
  }
  function pinHide(){ if(pin) pin.g.visible = false; }

  /* ================= 毎フレーム ================= */
  let acc = 0, uiAcc = 0, mapAcc = 0, warm = false, lastMode = "";
  function tick(dt){
    const on = carOn();
    if(S.mode !== lastMode){ lastMode = S.mode; const nb = document.getElementById("nav-btn"); if(nb) nb.style.display = S.mode === "car" ? "" : "none"; }   // バスは専用の案内線があるので、ナビのボタンは出さない
    if(!on){ if(st.target && S.mode !== "car"){ clear(); } return; }
    if(!GR && !warm && Traffic.ready){ warm = true; setTimeout(graph, 500); }   // 経路探索の下準備（初回だけ 0.2 秒ほどかかるので、走り出しの直後に済ませる）
    acc += dt; if(acc < 0.1) { if(ribR && st.target) ribR.tex.offset.y = -((performance.now() / 1000) * 0.75) % 1; return; } const step = acc; acc = 0;
    const m = me();
    if(!st.target){ ui.show(false); if(ribR) ribHide(); return; }
    // 検索（初回・外れた時）
    if(st.state === "routing" && Traffic.ready) doPlan(st.first ? "init" : "re"), st.first = false;
    if(st.R){
      const R = st.R;
      // v41.11: 乗ってからは「いまの位置の少し前後」だけを探す（折り返しや平行な道が近いと、先の区間に飛んで案内が飛ぶため）
      let p = st.joined ? project(R, m.x, m.z, st.prog - 25, st.prog + Math.max(50, m.v * step * 2.5 + 30)) : project(R, m.x, m.z, st.prog - 40, st.prog + 160);
      if(p.lat > 22){ const g = project(R, m.x, m.z, Math.max(0, st.prog - 60), Math.min(R.total, st.prog + 400)); if(g.lat < p.lat) p = g; }
      st.lat = p.lat;
      if(p.lat <= 22){ st.offT = 0; st.joined = true; if(p.arc > st.prog - 30) { if(Math.abs(p.arc - st.prog) > 0.2) st.dirty = true; st.prog = p.arc; } }
      else st.offT += step;
      // まだ道路に乗っていない間（駐車場・敷地から出る途中）は「外れた」と数えない（40 秒たっても乗れなければ探し直す）
      if(!st.joined && Math.hypot(m.x - R.px0, m.z - R.pz0) < R.legSL + 90 && S.t - st.tPlan < 40) st.offT = 0;
      // 逆走
      const tg = tangentAt(R, st.prog), hd = [Math.sin(m.yaw), Math.cos(m.yaw)], cosH = tg[0] * hd[0] + tg[1] * hd[1];
      if(m.v > 3 && cosH < -0.45 && p.lat < 14) st.wrongT += step; else st.wrongT = Math.max(0, st.wrongT - step * 2);
      if((st.offT > 2.0 || (p.lat > 70 && st.offT > 0.5)) && S.t - st.tPlan > 3.5){ st.offT = 0; doPlan("off"); }
      else if(st.wrongT > 2.5 && S.t - st.tPlan > 3.5){ st.wrongT = 0; doPlan("wrong"); }
      // 曲がり角の更新・音声
      while(st.mi < R.man.length - 1 && R.man[st.mi].d1 < st.prog + 4) st.mi++;
      const mv = R.man[st.mi]; if(mv){ announce(mv, Math.max(0, mv.d - st.prog), m.v); }
    }
    // 到着
    const dT = Math.hypot(st.target.x - m.x, st.target.z - m.z);
    if(st.state !== "arrived" && dT < (st.target.r || 40) && (st.src !== "auto" || dT < 30)){
      if(st.src === "auto"){ if(st.state !== "near"){ st.state = "near"; } }
      else { st.state = "arrived"; st.arrT = 0; Voice.say("目的地周辺です。案内を終了します。"); st.dirty = true; Snd.blip("done"); }
    }
    if(st.state === "arrived"){ st.arrT += step; if(st.arrT > 5){ clear(); return; } }
    updateRibbons(step);
    mapAcc += step; if(mapAcc >= 0.5){ mapAcc = 0; ui.live(); }
    if(st.src === "user") pinShow(st.target); else pinHide();
    uiAcc += step; if(uiAcc >= 0.15 || st.dirty){ uiAcc = 0; st.dirty = false; ui.render(m, dT); }
  }

  /* ミニマップ用: 経路の点（x,z の列）。進行位置の少し後ろから d 先まで */
  function nextPoint(){
    const R = st.R; if(!R || !carOn()) return null; const mv = R.man[st.mi]; if(!mv) return null; const q = R.ptAt(mv.d);
    return { x: q[0], z: q[1], d: Math.max(0, mv.d - st.prog), type: mv.type };
  }
  function mapPoly(ahead){
    const R = st.R; if(!R || !carOn()) return null; const out = [], d0 = Math.max(0, st.prog - 30), d1 = Math.min(R.total, st.prog + (ahead || 3000));
    const step = Math.max(6, (d1 - d0) / 260);
    for(let d = d0; d <= d1 + 0.01; d += step){ const p = R.ptAt(d); out.push(p[0], p[1]); }
    return out;
  }

  /* ================= 検索 ================= */
  const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const nk = (s) => kataToHira(String(s).normalize("NFKC").toLowerCase()).replace(/[\s・･\-－ー]/g, "");
  const READ = [["岡山駅", "おかやまえき"], ["岡山城", "おかやまじょう うじょう からすじょう"], ["後楽園", "こうらくえん"], ["岡山大学", "おかやまだいがく"], ["県庁", "けんちょう"], ["市役所", "しやくしょ"], ["市民病院", "しみんびょういん"], ["大学病院", "だいがくびょういん"], ["赤十字", "せきじゅうじ"], ["川崎医科", "かわさきいか"], ["ハレノワ", "はれのわ"], ["オリエント", "おりえんと"], ["天満屋", "てんまや"], ["高島屋", "たかしまや"], ["北長瀬", "きたながせ"], ["大元", "おおもと"], ["西川原", "にしがわら"], ["法界院", "ほうかいいん"], ["備前三門", "びぜんみかど"], ["大安寺", "だいあんじ"], ["備前西市", "びぜんにしいち"], ["高島", "たかしま"], ["東岡山", "ひがしおかやま"], ["備前原", "びぜんはら"], ["津島", "つしま"], ["表町", "おもてちょう"], ["動物園", "どうぶつえん"], ["東山", "ひがしやま"], ["清輝橋", "せいきばし"], ["柳川", "やながわ"], ["城下", "しろした"], ["西川", "にしがわ"], ["岡南", "こうなん"], ["青江", "あおえ"], ["大供", "おおとも"], ["奉還町", "ほうかんちょう"], ["中山下", "なかさんげ"], ["下石井", "しもいしい"], ["野田", "のだ"], ["平井", "ひらい"], ["南方", "みなみがた"], ["丸の内", "まるのうち"], ["駅", "えき"], ["病院", "びょういん"], ["学校", "がっこう"], ["小学校", "しょうがっこう"], ["中学", "ちゅうがく"], ["郵便局", "ゆうびんきょく"], ["公園", "こうえん"], ["神社", "じんじゃ"], ["美術館", "びじゅつかん"], ["博物館", "はくぶつかん"]];
  function buildIndex(){
    // k1 = 名前、kr = 名前の中の語（岡山駅 など）をひらがなに置き換えたもの（「おかやまえき」で始まる名前も先頭一致にするため）、k = 検索に使う全部
    IDX = POI.p.map(([n, c, x, z]) => { const k1 = nk(n); let kr = k1, ex = ""; for(const [a, b] of READ) if(n.includes(a)){ kr = kr.split(nk(a)).join(nk(b.split(" ")[0])); ex += " " + nk(b); } return { n, c, x, z, k1, kr, k: k1 + " " + kr + ex }; });
  }
  getJSON("data/poi.json").then((j) => { POI = j; buildIndex(); }).catch((e) => { console.warn("poi", e); });
  const catName = (c) => (POI && POI.cats[c]) || "";
  function search(q, cat){
    if(!IDX) return []; const m = me(), out = [];
    if(cat === "taxi"){ if(!POI.taxi) return out; for(const s of POI.taxi){ out.push({ n: s[2], c: -1, x: s[0], z: s[1], d: Math.hypot(s[0] - m.x, s[1] - m.z), label: "タクシー乗り場" }); } out.sort((a, b) => a.d - b.d); return out.slice(0, 30); }
    if(cat !== undefined && cat !== null && cat >= 0){ for(const it of IDX) if(it.c === cat){ out.push({ n: it.n, c: it.c, x: it.x, z: it.z, d: Math.hypot(it.x - m.x, it.z - m.z) }); } out.sort((a, b) => a.d - b.d); return out.slice(0, 30); }
    const k = nk(q || ""); if(!k) return out;
    for(const it of IDX){
      if(it.k.indexOf(k) < 0) continue; const head = it.k1.startsWith(k) || it.kr.startsWith(k); if(k.length === 1 && !head) continue;
      let sc = head ? ((it.k1 === k || it.kr === k) ? -1 : 0) : 1;   // 完全一致 → 先頭一致 → 途中に含む
      sc += (it.c === 0 ? -0.35 : it.c === 14 ? 0.4 : it.c === 9 ? 0.2 : 0) + it.n.length * 0.01;       // 駅を前に・町やコンビニを後ろに・短い名前を前に
      out.push({ n: it.n, c: it.c, x: it.x, z: it.z, d: Math.hypot(it.x - m.x, it.z - m.z), sc }); }
    out.sort((a, b) => (a.sc - b.sc) || (a.d - b.d)); return out.slice(0, 40);
  }
  /* 地図の点（タップした場所）の呼び名: 近い施設（60m 以内）、無ければ町名・道路名 */
  function nameAt(x, z){
    let best = null, bd = 70; if(IDX) for(const it of IDX){ if(it.c === 14) continue; const d = Math.hypot(it.x - x, it.z - z); if(d < bd){ bd = d; best = it; } }
    if(best) return best.n;
    const L = Loc.at ? Loc.at(x, z) : null; if(L) return (L.road ? L.road + "沿い（" : "") + (L.town || "") + (L.road ? "）" : "") + "付近";
    return "選んだ場所";
  }

  /* ================= 画面（案内の帯・検索パネル・大きな地図）================= */
  const ui = (() => {
    const css = `
.navb{ position:fixed; z-index:12; left:50%; top:calc(58px + env(safe-area-inset-top,0px)); transform:translateX(-50%); width:min(392px, calc(100% - 24px)); display:none; background:rgba(20,17,12,.92); border:1px solid var(--line,#5a4a2a); border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,.45); backdrop-filter:blur(5px); color:var(--cream,#f1ead9); font-family:inherit; }
.navb.on{ display:block; }
.navb-main{ display:grid; grid-template-columns:62px 1fr; gap:10px; align-items:center; padding:8px 10px 6px; }
.navb-main canvas{ width:62px; height:62px; border-radius:10px; background:#0d5c3a; display:block; box-shadow:inset 0 0 0 2px rgba(255,255,255,.55); }
.navb-t b{ display:block; font-size:28px; line-height:1.05; color:#fff; font-variant-numeric:tabular-nums; letter-spacing:.01em; }
.navb-t span{ display:block; font-size:15px; font-weight:700; color:var(--amber,#ffb02e); margin-top:1px; }
.navb-t small{ display:block; font-size:11.5px; color:#b9ae94; min-height:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.navb-sub{ display:flex; gap:10px; align-items:baseline; padding:5px 12px 6px; border-top:1px solid rgba(201,168,106,.25); font-size:12px; color:#d6cba9; font-variant-numeric:tabular-nums; white-space:nowrap; }
.navb-sub #navb-to{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; color:#fff; font-weight:700; }
.navb-sub b{ color:#fff; }
.navb-btns{ display:flex; gap:6px; padding:0 10px 8px; }
.navb-btns button{ flex:1; font-family:inherit; font-size:11.5px; color:#cfc5ac; background:transparent; border:1px solid var(--line,#5a4a2a); border-radius:4px; padding:4px 6px; cursor:pointer; }
.navb-btns button:hover{ border-color:var(--amber,#ffb02e); color:var(--amber,#ffb02e); } .navb-btns button.off{ opacity:.55; }
.navb.arrived .navb-main canvas{ background:#8a1d4a; } .navb.fail .navb-main canvas{ background:#5a4a2a; }
.navb.auto .navb-btns #navb-stop{ display:none; }
body.nav-on .qtoast{ top:calc(212px + env(safe-area-inset-top,0px)); max-width:min(400px, max(220px, calc(100vw - 636px))); }
@media (max-width:900px){ body.nav-on .qhud, body.nav-on .navi{ top:calc(206px + env(safe-area-inset-top,0px)); } .navb{ width:min(392px, calc(100% - 24px)); } }
@media (max-width:619px){ body.nav-on .navi{ transform:scale(.62); transform-origin:top right; top:calc(174px + env(safe-area-inset-top,0px)); } body.nav-on .qhud{ top:calc(174px + env(safe-area-inset-top,0px)); }
  .qtoast{ left:12px; width:calc(100% - 24px); max-width:none; box-sizing:border-box; transform:translate(0,-8px); } .qtoast.on{ transform:translate(0,0); }
  body.nav-on .qtoast{ top:auto; bottom:calc(206px + env(safe-area-inset-bottom,0px)); max-width:none; }
  .navb:not(.open) .navb-btns{ display:none; } .navb.open{ z-index:14; } .navb-main{ cursor:pointer; } .navb-sub::after{ content:"⋯"; color:#b9ae94; font-weight:700; } .navb.open .navb-sub::after{ content:"▲"; font-size:10px; }
  #carui .topright .iconbtn small{ display:none; } .navbtn{ padding:0 9px; } }
.navbtn{ font-family:inherit; width:auto !important; padding:0 12px; white-space:nowrap; font-size:13px; } .navbtn small{ opacity:.6; margin-left:4px; }
.navp{ position:fixed; inset:0; z-index:30; display:none; align-items:flex-start; justify-content:center; padding:calc(54px + env(safe-area-inset-top,0px)) 12px 12px; background:rgba(8,6,3,.55); }
.navp.on{ display:flex; }
.navp-card{ width:min(520px,100%); max-height:100%; display:flex; flex-direction:column; background:rgba(24,20,14,.97); border:1px solid var(--line,#5a4a2a); border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,.6); color:var(--cream,#f1ead9); overflow:hidden; }
.navp-h{ display:flex; align-items:center; gap:8px; padding:11px 14px 8px; } .navp-h b{ font-size:16px; flex:1; } .navp-h small{ font-size:10px; letter-spacing:.14em; color:var(--brass,#c9a86a); }
.navp-h button, .navp-opts button, .navp-row button, .navp-cur button{ font-family:inherit; cursor:pointer; }
.navp-x{ font-size:18px; color:#cfc5ac; background:transparent; border:1px solid var(--line,#5a4a2a); border-radius:4px; width:30px; height:30px; }
.navp-in{ display:flex; gap:8px; padding:0 14px 8px; } .navp-in input{ flex:1; min-width:0; font-family:inherit; font-size:16px; color:#fff; background:#0f0c08; border:1px solid var(--line,#5a4a2a); border-radius:6px; padding:9px 11px; outline:none; } .navp-in input:focus{ border-color:var(--amber,#ffb02e); }
.navp-in button{ font-size:13px; font-weight:700; color:#1a1408; background:var(--amber,#ffb02e); border:0; border-radius:6px; padding:0 12px; }
.navp-chips{ display:flex; flex-wrap:wrap; gap:6px; padding:0 14px 8px; } .navp-chips button{ font-size:12px; color:#e6dcc0; background:#2a2418; border:1px solid var(--line,#5a4a2a); border-radius:14px; padding:4px 10px; } .navp-chips button.on{ background:#4a3a18; border-color:var(--amber,#ffb02e); color:var(--amber,#ffb02e); }
.navp-cur{ margin:0 14px 8px; padding:8px 10px; border:1px solid var(--line,#5a4a2a); border-radius:6px; background:rgba(255,176,46,.08); font-size:13px; display:none; } .navp-cur.on{ display:block; } .navp-cur b{ color:#fff; } .navp-cur small{ display:block; color:#b9ae94; margin-top:2px; } .navp-cur button{ margin-top:6px; font-size:12px; color:#ffd0bd; background:transparent; border:1px solid #ff8a5c; border-radius:4px; padding:3px 10px; }
.navp-lbl{ padding:2px 14px 4px; font-size:11px; color:#a99f88; letter-spacing:.06em; }
.navp-res{ overflow:auto; padding:0 8px 6px; flex:1; min-height:60px; max-height:46vh; }
.navp-row{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; padding:7px 8px; border-radius:6px; cursor:pointer; } .navp-row:hover{ background:rgba(255,176,46,.1); }
.navp-row .nm{ font-size:14px; color:#fff; font-weight:700; } .navp-row .sb{ font-size:11px; color:#a99f88; } .navp-row .ds{ font-size:12px; color:var(--amber,#ffb02e); font-variant-numeric:tabular-nums; text-align:right; }
.navp-empty{ padding:10px 14px; font-size:12.5px; color:#a99f88; }
.navp-opts{ display:flex; gap:8px; padding:8px 14px 12px; border-top:1px solid rgba(201,168,106,.2); flex-wrap:wrap; } .navp-opts button{ font-size:12px; color:#cfc5ac; background:transparent; border:1px solid var(--line,#5a4a2a); border-radius:4px; padding:5px 10px; } .navp-opts button.on{ color:var(--amber,#ffb02e); border-color:var(--amber,#ffb02e); }
.navmap{ position:fixed; inset:0; z-index:31; display:none; background:#cfcab8; }
.navmap.on{ display:block; } .navmap canvas{ position:absolute; inset:0; width:100%; height:100%; touch-action:none; cursor:grab; image-rendering:auto; }
.navmap-top{ position:absolute; left:10px; right:10px; top:calc(10px + env(safe-area-inset-top,0px)); display:flex; gap:8px; align-items:center; pointer-events:none; }
.navmap-top > *{ pointer-events:auto; } .navmap-top .ttl{ background:rgba(23,20,15,.9); color:var(--cream,#f1ead9); border:1px solid var(--line,#5a4a2a); border-radius:6px; padding:7px 12px; font-size:13px; font-weight:700; flex:1; max-width:420px; }
.navmap-top button, .navmap-side button{ font-family:inherit; font-size:15px; font-weight:700; color:var(--cream,#f1ead9); background:rgba(23,20,15,.92); border:1px solid var(--line,#5a4a2a); border-radius:6px; min-width:38px; height:38px; cursor:pointer; padding:0 10px; }
.navmap-side{ position:absolute; right:10px; top:calc(62px + env(safe-area-inset-top,0px)); display:flex; flex-direction:column; gap:6px; }
.navmap-sheet{ position:absolute; left:50%; transform:translateX(-50%); bottom:calc(14px + env(safe-area-inset-bottom,0px)); width:min(460px, calc(100% - 20px)); background:rgba(24,20,14,.97); border:1px solid var(--line,#5a4a2a); border-radius:10px; padding:12px 14px; color:var(--cream,#f1ead9); display:none; box-shadow:0 12px 40px rgba(0,0,0,.55); }
.navmap-sheet.on{ display:block; } .navmap-sheet b{ font-size:16px; display:block; } .navmap-sheet small{ color:#b9ae94; font-size:12px; } .navmap-sheet .bt{ display:flex; gap:8px; margin-top:8px; } .navmap-sheet button{ flex:1; font-family:inherit; font-size:14px; font-weight:700; border-radius:6px; padding:9px; cursor:pointer; border:1px solid var(--line,#5a4a2a); color:#e6dcc0; background:#2a2418; } .navmap-sheet button.go{ background:var(--amber,#ffb02e); color:#1a1408; border:0; }
`;
    let built = false, banner, ic, panel, mapEl;
    function dom(){
      if(built) return; built = true;
      const sty = document.createElement("style"); sty.textContent = css; document.head.appendChild(sty);
      const div = document.createElement("div");
      div.innerHTML = `
<div class="navb" id="navb" role="status" aria-live="polite"><div class="navb-main"><canvas id="navb-ic" width="124" height="124"></canvas><div class="navb-t"><b id="navb-dist">--</b><span id="navb-act">--</span><small id="navb-road"></small></div></div>
<div class="navb-sub"><span id="navb-to">目的地</span><span id="navb-rem">--</span><span id="navb-eta">--</span><span id="navb-arr">--</span></div>
<div class="navb-btns"><button type="button" id="navb-voice">音声 ON</button><button type="button" id="navb-line">道路の線 OFF</button><button type="button" id="navb-map">地図</button><button type="button" id="navb-set">目的地</button><button type="button" id="navb-stop">案内終了</button></div></div>
<div class="navp" id="navp"><div class="navp-card"><div class="navp-h"><b>ナビ</b><small>DESTINATION</small><button class="navp-x" id="navp-x" type="button" aria-label="閉じる">×</button></div>
<div class="navp-cur" id="navp-cur"></div>
<div class="navp-in"><input id="navp-q" type="search" placeholder="目的地（例: 岡山城、イオンモール、津島、北長瀬駅）" autocomplete="off" enterkeyhint="search"><button type="button" id="navp-map">地図で選ぶ</button></div>
<div class="navp-chips" id="navp-chips"></div><div class="navp-lbl" id="navp-lbl"></div><div class="navp-res" id="navp-res"></div>
<div class="navp-opts"><button type="button" id="navp-voice">音声案内</button><button type="button" id="navp-line">道路の青い帯</button></div></div></div>
<div class="navmap" id="navmap"><canvas id="navmap-cv"></canvas><div class="navmap-top"><button type="button" id="navmap-x">← もどる</button><div class="ttl" id="navmap-ttl">地図をタップして目的地を選ぶ</div></div>
<div class="navmap-side"><button type="button" id="navmap-zi">＋</button><button type="button" id="navmap-zo">－</button><button type="button" id="navmap-me" title="いまの場所">⌖</button></div>
<div class="navmap-sheet" id="navmap-sheet"><b id="navmap-sn">--</b><small id="navmap-sd">--</small><div class="bt"><button type="button" id="navmap-cancel">やめる</button><button type="button" class="go" id="navmap-go">ここへ案内</button></div></div></div>`;
      while(div.firstChild) document.body.appendChild(div.firstChild);
      banner = $("navb"); ic = $("navb-ic").getContext("2d"); panel = $("navp"); mapEl = $("navmap");
      banner.addEventListener("click", (e) => { if(!matchMedia("(max-width:619px)").matches) return; const b = e.target.closest && e.target.closest("button"); if(b){ if(b.id !== "navb-voice" && b.id !== "navb-line") banner.classList.remove("open"); return; } banner.classList.toggle("open"); });
      // 車の画面のボタン
      const tr = document.querySelector("#carui .topright");
      if(tr){ const b = document.createElement("button"); b.className = "iconbtn navbtn"; b.id = "nav-btn"; b.type = "button"; b.title = "ナビ（G）"; b.innerHTML = "ナビ <small>G</small>"; tr.insertBefore(b, tr.firstChild); b.addEventListener("click", () => openPanel()); }
      $("navb-voice").addEventListener("click", () => { OPT.voice = !OPT.voice; if(!OPT.voice) Voice.stop(); savePref(); syncOpts(); });
      $("navb-line").addEventListener("click", () => { OPT.line = !OPT.line; savePref(); syncOpts(); ribDirty(); });
      $("navb-map").addEventListener("click", () => openMap(false));
      $("navb-set").addEventListener("click", () => openPanel());
      $("navb-stop").addEventListener("click", () => { clear(); });
      $("navp-x").addEventListener("click", closePanel);
      $("navp-map").addEventListener("click", () => { closePanel(); openMap(true); });
      $("navp-voice").addEventListener("click", () => { OPT.voice = !OPT.voice; if(!OPT.voice) Voice.stop(); savePref(); syncOpts(); });
      $("navp-line").addEventListener("click", () => { OPT.line = !OPT.line; savePref(); syncOpts(); ribDirty(); });
      panel.addEventListener("click", (e) => { if(e.target === panel) closePanel(); });
      const q = $("navp-q"); q.addEventListener("input", () => renderList()); q.addEventListener("keydown", (e) => { e.stopPropagation(); if(e.key === "Enter"){ const r = listNow[0]; if(r) choose(r); } if(e.key === "Escape") closePanel(); }); q.addEventListener("keyup", (e) => e.stopPropagation());
      const ch = $("navp-chips"); ch.innerHTML = "";
      for(const [lab, c] of [["タクシー乗り場", "taxi"], ["駅", 0], ["病院", 2], ["コンビニ", 9], ["スーパー", 8], ["商業施設", 7], ["ホテル", 10], ["観光・文化", 11], ["公園・運動", 12], ["学校", 4], ["大学・短大", 3], ["公共施設", 5], ["郵便局", 6], ["寺社", 13], ["バス・電停", 1]]){
        const b = document.createElement("button"); b.type = "button"; b.textContent = lab; b.dataset.c = c; b.addEventListener("click", () => { catSel = catSel === c ? null : c; $("navp-q").value = ""; renderList(); }); ch.appendChild(b); }
      addEventListener("keydown", (e) => { if(e.repeat || e.ctrlKey || e.metaKey || e.altKey) return; const a = document.activeElement; if(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
        if((e.key === "g" || e.key === "G") && carOn()){ if(mapEl.classList.contains("on")) closeMap(); else if(panel.classList.contains("on")) closePanel(); else openPanel(); }
        else if(e.key === "Escape"){ if(mapEl.classList.contains("on")) closeMap(); else if(panel.classList.contains("on")) closePanel(); } });
      syncOpts();
    }
    function savePref(){ if(Prefs.setM) Prefs.setM("nav", { voice: OPT.voice, line: OPT.line, ver: 2 }); }
    function loadPref(){ if(Prefs.getM){ const o = Prefs.getM("nav", null); if(o){ OPT.voice = o.voice !== false; OPT.line = o.ver >= 2 ? o.line === true : false; } } }
    function syncOpts(){ const t = (id, on, a, b) => { const e = $(id); if(e){ e.textContent = a + (on ? " ON" : " OFF"); e.classList.toggle("on", on); e.classList.toggle("off", !on); } };
      t("navb-voice", OPT.voice, "音声", ""); t("navb-line", OPT.line, "道路の線", ""); t("navp-voice", OPT.voice, "音声案内", ""); t("navp-line", OPT.line, "道路の青い帯", ""); }
    let catSel = null, listNow = [];
    function choose(r){
      if(r.dst !== undefined){ /* 最近 */ }
      setTarget({ x: r.x, z: r.z, name: r.n || r.name }, "user"); closePanel(); closeMap();
    }
    function renderList(){
      const q = $("navp-q").value.trim(), res = $("navp-res"), lbl = $("navp-lbl");
      document.querySelectorAll("#navp-chips button").forEach((b) => b.classList.toggle("on", String(b.dataset.c) === String(catSel) && catSel !== null));
      let L = [], title = "";
      if(!POI){ res.innerHTML = '<div class="navp-empty">地点データを読み込み中です…</div>'; lbl.textContent = ""; return; }
      if(q){ L = search(q); title = "検索結果 " + L.length + " 件（名前が近いものを先に）"; }
      else if(catSel !== null){ L = search("", catSel === "taxi" ? "taxi" : +catSel); title = (catSel === "taxi" ? "タクシー乗り場" : catName(+catSel)) + "（いまの場所から近い順）"; }
      else { const R = Prefs.getM ? Prefs.getM("navRecent", []) : []; L = (R || []).map((r) => ({ n: r.name, x: r.x, z: r.z, c: -2, d: Math.hypot(r.x - Car.C.x, r.z - Car.C.z) })); title = L.length ? "最近の目的地" : ""; }
      listNow = L; lbl.textContent = title;
      if(!L.length){ res.innerHTML = '<div class="navp-empty">' + (q ? "見つかりませんでした。別の言い方（駅名・町名・施設名）か、「地図で選ぶ」を使ってください。" : "名前を入れるか、下の分類（駅・病院・コンビニなど）を押してください。") + "</div>"; return; }
      res.innerHTML = L.map((r, i) => '<div class="navp-row" data-i="' + i + '"><div><div class="nm">' + esc(r.n) + '</div><div class="sb">' + esc(r.label || (r.c >= 0 ? catName(r.c) : "最近")) + '</div></div><div class="ds">' + fmtD(r.d) + '</div></div>').join("");
      res.querySelectorAll(".navp-row").forEach((e) => e.addEventListener("click", () => choose(listNow[+e.dataset.i])));
    }
    function openPanel(){
      dom(); if(!carOn()) return; closeMap(); panel.classList.add("on");
      const cur = $("navp-cur");
      if(st.target){ cur.classList.add("on"); cur.innerHTML = (st.src === "auto" ? "ミッションの目的地へ案内中: " : "案内中: ") + "<b>" + esc(st.target.name) + "</b><small>あと " + fmtD(remDist()) + "・約 " + fmtMin(remTime()) + "</small>" + (st.src === "auto" ? "" : '<br><button type="button" id="navp-stop">案内を終了</button>'); const b = $("navp-stop"); if(b) b.addEventListener("click", () => { clear(); closePanel(); }); }
      else cur.classList.remove("on");
      catSel = null; $("navp-q").value = ""; renderList(); syncOpts();
      if(!matchMedia("(pointer:coarse)").matches) setTimeout(() => $("navp-q").focus(), 30);
    }
    function closePanel(){ if(panel) panel.classList.remove("on"); const a = document.activeElement; if(a && a.blur && a.tagName === "INPUT") a.blur(); }
    // ----- 案内の帯 -----
    function icon(type){
      const g = ic, W = 124, c = W / 2; g.clearRect(0, 0, W, W); g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#fff"; g.fillStyle = "#fff"; g.lineWidth = 15;
      if(type === "arrive"){ g.lineWidth = 8; g.beginPath(); g.moveTo(38, 100); g.lineTo(38, 24); g.stroke(); g.beginPath(); g.moveTo(40, 26); g.lineTo(96, 26); g.lineTo(80, 46); g.lineTo(96, 66); g.lineTo(40, 66); g.closePath(); g.fill(); return; }
      if(type === "uturn"){ g.beginPath(); g.moveTo(82, 104); g.lineTo(82, 52); g.quadraticCurveTo(82, 22, 52, 22); g.quadraticCurveTo(24, 22, 24, 52); g.lineTo(24, 70); g.stroke(); g.beginPath(); g.moveTo(8, 66); g.lineTo(24, 92); g.lineTo(40, 66); g.closePath(); g.fill(); return; }
      let a = 0; const t = { straight: 0, slightL: 40, slightR: -40, left: 90, right: -90, sharpL: 140, sharpR: -140 }[type] || 0; a = t * D2R;
      const bx = c, by = 108, mx = c, my = 62, L = 46, tx = mx - Math.sin(a) * L, ty = my - Math.cos(a) * L;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(mx, my); g.lineTo(tx, ty); g.stroke();
      const hx = tx - Math.sin(a) * 4, hy = ty - Math.cos(a) * 4, ux = -Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
      g.beginPath(); g.moveTo(hx + ux * 14, hy + uy * 14); g.lineTo(hx + px * 17, hy + py * 17); g.lineTo(hx - px * 17, hy - py * 17); g.closePath(); g.fill();
    }
    let lastIc = "";
    function render(m, dT){
      dom(); const R = st.R; banner.classList.add("on"); document.body.classList.add("nav-on");
      banner.classList.toggle("auto", st.src === "auto"); banner.classList.toggle("arrived", st.state === "arrived"); banner.classList.toggle("fail", st.fail);
      $("navb-to").textContent = st.target ? st.target.name : "";
      let type = "straight", dist = 0, act = "道なり", road = "";
      if(st.fail){ type = "straight"; dist = dT; act = "直線で案内"; road = "道路のルートが見つかりません"; }
      else if(st.state === "arrived"){ type = "arrive"; dist = 0; act = "到着しました"; }
      else if(R){ const mv = R.man[st.mi]; if(mv){ type = mv.type; dist = Math.max(0, mv.d - st.prog); act = mv.type === "arrive" ? "目的地周辺" : ACT[mv.type][0]; road = mv.type === "arrive" ? "" : (mv.to ? "→ " + mv.to : ""); if(mv.type === "arrive" && R.legE) road = "この先は道路を外れます（点線）"; }
        if(R.man[st.mi] && R.man[st.mi].type !== "arrive" && dist > 600 && !road) road = "しばらく道なり"; }
      else { type = "straight"; act = "ルートを探しています"; dist = dT; }
      if(type !== lastIc){ lastIc = type; icon(type); }
      $("navb-dist").textContent = type === "arrive" && st.state === "arrived" ? "" : fmtD(dist);
      $("navb-act").textContent = act; $("navb-road").textContent = road || (Loc.last && Loc.last.road ? "いま: " + Loc.last.road : "");
      const rd = remDist(), rt = remTime(); $("navb-rem").innerHTML = "あと <b>" + fmtD(rd) + "</b>"; $("navb-eta").innerHTML = "<b>" + fmtMin(rt) + "</b>"; $("navb-arr").innerHTML = "到着 <b>" + hhmm((S.clock || 0) + rt) + "</b>";
    }
    function show(on){ dom(); if(!on){ banner.classList.remove("on"); document.body.classList.remove("nav-on"); } else { banner.classList.add("on"); document.body.classList.add("nav-on"); } lastIc = ""; st.dirty = true; }

    // ----- 大きな地図 -----
    const MZ = [2, 4, 8, 16, 32, 64]; let mz = 2, mcx = 0, mcz = 0, base = null, pick = null, pdown = null, offX = 0, offZ = 0, picking = false;
    const bc = document.createElement("canvas"), bg = bc.getContext("2d");
    function paintBase(cv){
      const G = Car.G; const w = cv.width, h = cv.height, mpp = MZ[mz]; bc.width = w; bc.height = h; if(!G){ bg.fillStyle = "#d8d3c2"; bg.fillRect(0, 0, w, h); return; }
      const sub = mpp <= 3 ? 1 : mpp <= 6 ? 2 : 3, n2 = sub * sub, Wl = S._WL, img = bg.createImageData(w, h), px = new Uint32Array(img.data.buffer);
      const rgba = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0, C_ROAD = rgba(255, 255, 255, 255), C_SIDE = rgba(236, 231, 218, 255), C_BLD = rgba(176, 168, 154, 255), C_WATER = rgba(135, 187, 228, 255), C_BG = rgba(216, 211, 194, 255);
      const x0 = mcx - w / 2 * mpp, z0 = mcz - h / 2 * mpp;
      for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
        let road = 0, bld = 0, wat = 0, side = 0;
        for(let sj = 0; sj < sub; sj++) for(let si = 0; si < sub; si++){
          const x = x0 + (i + (si + 0.5) / sub) * mpp, z = z0 + (j + (sj + 0.5) / sub) * mpp, ci = Math.floor((x - G.x0) / G.step), cj = Math.floor((z - G.z0) / G.step);
          if(ci >= 0 && cj >= 0 && ci < G.nx && cj < G.nz){ const k = cj * G.nx + ci, kd = G.K[k];
            if(kd === 1) road++; else if(kd === 9) bld++; else if(kd > 0) side++;
            if(Wl && kd === 0){ const wi = Math.round((x - Wl.x0) / Wl.step), wj = Math.round((z - Wl.z0) / Wl.step); if(wi >= 0 && wj >= 0 && wi < Wl.nx && wj < Wl.nz){ const v = Wl.A[wj * Wl.nx + wi]; if(v !== -32768 && v > G.H[k] + 30) wat++; } } }
        }
        px[j * w + i] = road ? C_ROAD : bld * 2 >= n2 ? C_BLD : wat * 2 >= n2 ? C_WATER : side ? C_SIDE : C_BG;
      }
      bg.putImageData(img, 0, 0);
      const W2S = (x, z) => [(x - x0) / mpp, (z - z0) / mpp];
      const stroke = (arr, col, lw, dash) => { bg.strokeStyle = col; bg.lineWidth = lw; bg.setLineDash(dash || []); bg.beginPath(); let pen = false; for(const [x, z] of arr){ const q = W2S(x, z); if(q[0] < -50 || q[0] > w + 50 || q[1] < -50 || q[1] > h + 50){ pen = false; continue; } if(pen) bg.lineTo(q[0], q[1]); else { bg.moveTo(q[0], q[1]); pen = true; } } bg.stroke(); bg.setLineDash([]); };
      try{
        if(MW.ready) for(const c of MW.chains){ const pts = []; const stp = Math.max(1, Math.round(mpp / 5)); for(let i = 0; i < c.n; i += stp) pts.push([c.X[i], c.Z[i]]); stroke(pts, c.kind === "main" ? "#e29a2e" : "#e8b866", Math.max(1.5, (c.kind === "main" ? 14 : 7) / mpp)); }
        if(JR.ready) for(const L of JR.lines){ const pts = []; const stp = Math.max(1, Math.round(mpp / 2)); for(let i = 0; i < L.n; i += stp) pts.push([L.p[3 * i], L.p[3 * i + 2]]); stroke(pts, L.hs ? "#2a62b5" : "#5a5750", Math.max(1.4, (L.hs ? 7 : 4) / mpp)); }
        for(const k in S.routes){ const r = S.routes[k]; if(!r || !r.track) continue; const pts = []; const stp = Math.max(1, Math.round(mpp / 3)); for(let i = 0; i < r.track.length; i += stp) pts.push([r.track[i][0], r.track[i][2]]); stroke(pts, "#b3407a", Math.max(1.4, 5 / mpp)); }
      }catch(e){}
      base = { cx: mcx, cz: mcz, mz, w, h };
    }
    const LABELS = { 0: 12, 1: 5, 2: 3, 3: 2, 7: 3, 11: 3, 13: 1, 12: 1.5, 10: 1.5, 5: 1.5, 8: 1, 9: 0.6, 4: 1, 6: 0.8, 14: 0.5 };
    function redraw(){
      const cv = $("navmap-cv"), g = cv.getContext("2d"), w = cv.width, h = cv.height, mpp = MZ[mz]; if(!base) return;
      g.fillStyle = "#cfcab8"; g.fillRect(0, 0, w, h);
      const ox = (base.cx - mcx) / MZ[base.mz] * (MZ[base.mz] / mpp), oz = (base.cz - mcz) / mpp; // 平行移動（拡大率が違う時は無効にして描き直す）
      g.drawImage(bc, ox + offX, oz + offZ);
      const sx = (x) => (x - mcx) / mpp + w / 2 + offX, sz = (z) => (z - mcz) / mpp + h / 2 + offZ;
      // 経路
      if(st.R){ const R = st.R; g.lineCap = "round"; g.lineJoin = "round"; const stp = Math.max(1, Math.round(mpp * 1.5 / 3)), k0 = Math.min(R.n - 1, idxAt(R, Math.max(0, st.prog)));
        const trace = (i0, i1) => { if(i1 <= i0) return; g.beginPath(); let pen = false; for(let i = i0; i < i1; i += stp){ const x = sx(R.X[i]), y = sz(R.Z[i]); if(pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; } } g.lineTo(sx(R.X[i1]), sz(R.Z[i1])); g.stroke(); };
        // v41.11: 通過ずみは灰色、これから走る所は太い青（白ふち）
        g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 8; trace(0, k0); g.strokeStyle = "#8d9bb3"; g.lineWidth = 4.5; trace(0, k0);
        g.strokeStyle = "rgba(255,255,255,.97)"; g.lineWidth = 12; trace(k0, R.n - 1); g.strokeStyle = "#1c6df0"; g.lineWidth = 7.5; trace(k0, R.n - 1);
        // 進行方向の矢じり
        { g.strokeStyle = "rgba(255,255,255,.95)"; g.lineWidth = 2; const gap = 44, sz2 = 4.2; let acc2 = gap * 0.5, px0 = sx(R.X[k0]), py0 = sz(R.Z[k0]);
          for(let i = k0 + stp; i < R.n + stp; i += stp){ const ii = Math.min(i, R.n - 1), x1 = sx(R.X[ii]), y1 = sz(R.Z[ii]), L = Math.hypot(x1 - px0, y1 - py0);
            if(L > 1e-6){ const ux = (x1 - px0) / L, uy = (y1 - py0) / L; let t = acc2; while(t < L){ const cx = px0 + ux * t, cy = py0 + uy * t; g.beginPath(); g.moveTo(cx - ux * sz2 * 1.4 - uy * sz2, cy - uy * sz2 * 1.4 + ux * sz2); g.lineTo(cx + ux * sz2 * 0.5, cy + uy * sz2 * 0.5); g.lineTo(cx - ux * sz2 * 1.4 + uy * sz2, cy - uy * sz2 * 1.4 - ux * sz2); g.stroke(); t += gap; } acc2 = t - L; }
            px0 = x1; py0 = y1; if(ii === R.n - 1) break; } }
        // 曲がり角（番号）と出発点
        if(mpp <= 14){ g.font = "bold 11px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; let no = 0;
          for(const mv of R.man){ if(mv.type === "arrive") continue; no++; if(mv.d < st.prog - 5) continue; const q = R.ptAt(mv.d), x = sx(q[0]), y = sz(q[1]); if(x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
            g.beginPath(); g.arc(x, y, 8, 0, 7); g.fillStyle = "#fff"; g.fill(); g.lineWidth = 2.5; g.strokeStyle = "#1c6df0"; g.stroke(); g.fillStyle = "#123d8f"; g.fillText(String(no), x, y + 0.5); }
          g.textAlign = "left"; }
        { const x = sx(R.X[0]), y = sz(R.Z[0]); g.beginPath(); g.arc(x, y, 6, 0, 7); g.fillStyle = "#2fb457"; g.fill(); g.lineWidth = 2.5; g.strokeStyle = "#fff"; g.stroke(); } }
      // タクシー乗り場・地名
      g.textBaseline = "middle"; g.font = "bold 12px sans-serif";
      if(POI){
        const lim = mpp <= 2 ? 0.5 : mpp <= 4 ? 1.5 : mpp <= 8 ? 3 : mpp <= 16 ? 6 : mpp <= 32 ? 12 : 99; const drawn = [];
        const items = IDX.filter((it) => (LABELS[it.c] || 0) * 1 >= 0 && (LABELS[it.c] || 0) >= (mpp <= 2 ? 0 : mpp <= 4 ? 0.8 : mpp <= 8 ? 1.5 : mpp <= 16 ? 3 : 5) - (mpp <= 2 ? 99 : 0));
        for(const it of items){ const x = sx(it.x), y = sz(it.z); if(x < -20 || x > w + 20 || y < -10 || y > h + 10) continue;
          const box = [x - 4, y - 8, x + 4 + it.n.length * 12, y + 8]; if(drawn.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue; drawn.push(box);
          g.fillStyle = "#c0392b"; g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill(); g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,.92)"; g.strokeText(it.n, x + 7, y); g.fillStyle = "#3a2d12"; g.fillText(it.n, x + 7, y); }
        if(mpp <= 32) for(const [ti, s] of POI.taxi.entries()){ const x = sx(s[0]), y = sz(s[1]); if(x < -20 || x > w + 20 || y < -20 || y > h + 20) continue; g.fillStyle = "#f2c230"; g.strokeStyle = "#1a1408"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill(); g.stroke(); g.fillStyle = "#1a1408"; g.font = "bold 10px sans-serif"; g.textAlign = "center"; g.fillText("T", x, y + 0.5);
          const cn = Taxi.standCount(ti); if(cn > 0){ g.fillStyle = "#e0342a"; g.strokeStyle = "#fff"; g.lineWidth = 2; g.beginPath(); g.arc(x + 9, y - 9, 7, 0, 7); g.fill(); g.stroke(); g.fillStyle = "#fff"; g.fillText(String(cn), x + 9, y - 8.5); }
          g.textAlign = "left"; g.font = "bold 12px sans-serif"; }
      }
      // 目的地・ピン・いまの場所
      const T = st.target; if(T){ drawPin(g, sx(T.x), sz(T.z), "#ff3d8b"); }
      if(pick) drawPin(g, sx(pick.x), sz(pick.z), "#1c6df0");
      const cx = sx(Car.C.x), cy = sz(Car.C.z); g.save(); g.translate(cx, cy); g.rotate(-(Car.C.yaw) + Math.PI); g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(0, 5); g.lineTo(-8, 9); g.closePath(); g.fillStyle = "#f0a020"; g.fill(); g.lineWidth = 2; g.strokeStyle = "#241a08"; g.stroke(); g.restore();
    }
    function drawPin(g, x, y, c){ g.save(); g.translate(x, y); g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-14, -16, -12, -34, 0, -34); g.bezierCurveTo(12, -34, 14, -16, 0, 0); g.fillStyle = c; g.fill(); g.lineWidth = 2.5; g.strokeStyle = "#fff"; g.stroke(); g.beginPath(); g.arc(0, -22, 4.5, 0, 7); g.fillStyle = "#fff"; g.fill(); g.restore(); }
    function sizeCv(){ const cv = $("navmap-cv"), w = Math.max(200, Math.ceil(innerWidth / 2)), h = Math.max(200, Math.ceil(innerHeight / 2)); if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; return true; } return false; }
    function rebuild(){ sizeCv(); const cv = $("navmap-cv"); offX = 0; offZ = 0; paintBase(cv); redraw(); }
    function openMap(pickMode){
      dom(); if(!carOn()) return; closePanel(); mapEl.classList.add("on"); picking = !!pickMode; pick = null; $("navmap-sheet").classList.remove("on");
      $("navmap-ttl").textContent = picking ? "地図をタップして目的地を選ぶ" : (st.target ? "案内中: " + st.target.name : "地図"); mz = 2; mcx = Car.C.x; mcz = Car.C.z;
      if(st.R){ // 経路が入る縮尺
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for(let i = 0; i < st.R.n; i += 4){ x0 = Math.min(x0, st.R.X[i]); x1 = Math.max(x1, st.R.X[i]); z0 = Math.min(z0, st.R.Z[i]); z1 = Math.max(z1, st.R.Z[i]); }
        x0 = Math.min(x0, Car.C.x); x1 = Math.max(x1, Car.C.x); z0 = Math.min(z0, Car.C.z); z1 = Math.max(z1, Car.C.z); mcx = (x0 + x1) / 2; mcz = (z0 + z1) / 2;
        const need = Math.max((x1 - x0) / (innerWidth / 2 * 0.8), (z1 - z0) / (innerHeight / 2 * 0.8)); mz = 0; while(mz < MZ.length - 1 && MZ[mz] < need) mz++; }
      setTimeout(rebuild, 20);
    }
    function closeMap(){ if(mapEl) mapEl.classList.remove("on"); }
    function mapBind(){
      const cv = $("navmap-cv"); let drag = null;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * cv.width, (e.clientY - r.top) / r.height * cv.height]; };
      cv.addEventListener("pointerdown", (e) => { drag = { p: pos(e), moved: false }; try{ cv.setPointerCapture(e.pointerId); }catch(x){} cv.style.cursor = "grabbing"; });
      cv.addEventListener("pointermove", (e) => { if(!drag) return; const p = pos(e), dx = p[0] - drag.p[0], dz = p[1] - drag.p[1]; if(Math.abs(dx) + Math.abs(dz) > 4) drag.moved = true; if(drag.moved){ offX = dx; offZ = dz; redraw(); } });
      cv.addEventListener("pointerup", (e) => { cv.style.cursor = "grab"; if(!drag) return; const p = pos(e), mpp = MZ[mz];
        if(drag.moved){ mcx -= offX * mpp; mcz -= offZ * mpp; offX = offZ = 0; paintBase(cv); redraw(); }
        else { const x = mcx + (p[0] - cv.width / 2) * mpp, z = mcz + (p[1] - cv.height / 2) * mpp; // 近くの地名（タップの 22px 以内）を優先
          let hit = null, hd = 26 * mpp / 2; if(IDX) for(const it of IDX){ if(it.c === 14) continue; const d = Math.hypot(it.x - x, it.z - z); if(d < hd){ hd = d; hit = it; } }
          pick = hit ? { x: hit.x, z: hit.z, name: hit.n } : { x, z, name: nameAt(x, z) }; $("navmap-sn").textContent = pick.name; $("navmap-sd").textContent = "いまの場所から " + fmtD(Math.hypot(pick.x - Car.C.x, pick.z - Car.C.z)) + "（直線）"; $("navmap-sheet").classList.add("on"); redraw(); }
        drag = null; });
      cv.addEventListener("wheel", (e) => { e.preventDefault(); zoomMap(e.deltaY < 0 ? -1 : 1); }, { passive: false });
      $("navmap-x").addEventListener("click", closeMap); $("navmap-zi").addEventListener("click", () => zoomMap(-1)); $("navmap-zo").addEventListener("click", () => zoomMap(1));
      $("navmap-me").addEventListener("click", () => { mcx = Car.C.x; mcz = Car.C.z; rebuild(); });
      $("navmap-cancel").addEventListener("click", () => { pick = null; $("navmap-sheet").classList.remove("on"); redraw(); });
      $("navmap-go").addEventListener("click", () => { if(pick) setTarget({ x: pick.x, z: pick.z, name: pick.name }, "user"); closeMap(); });
      addEventListener("resize", () => { if(mapEl.classList.contains("on")) rebuild(); });
    }
    function zoomMap(d){ const n = Math.max(0, Math.min(MZ.length - 1, mz + d)); if(n === mz) return; mz = n; rebuild(); }
    function init(){ dom(); loadPref(); syncOpts(); mapBind(); }
    /* v41.11: 大きな地図を開いている間は、いまの位置・通過ずみの経路・残りを 0.5 秒ごとに描き直す */
    function live(){ if(!mapEl || !mapEl.classList.contains("on") || !base) return; if(st.target && !picking) $("navmap-ttl").textContent = "案内中: " + st.target.name + "　あと " + fmtD(remDist()) + "・" + fmtMin(remTime()); redraw(); }
    return { dom, init, show, render, openPanel, closePanel, openMap, closeMap, syncOpts, live };
  })();

  return { tick, setTarget, clear, search, nameAt, plan, mapPoly, nextPoint, ui, OPT, st, get active(){ return !!st.target; }, get target(){ return st.target; }, get src(){ return st.src; }, get route(){ return st.R; }, remDist, remTime, Voice, catName, get POI(){ return POI; }, get ready(){ return !!graph(); }, astar, graph, project };
})();

Nav.ui.init();

/* ---------------- v41.10: 信号無視・逆走の検出（車のミッション・タクシー共通）----------------
   AI 車が走る車線網（Traffic.locate）の上で判定する。自分の車の前端が、信号のある車線の停止線（lane.sig.s）を「赤が 1 秒以上続いている間」に
   2.2 m/s 以上で越えたら信号無視。進行方向と逆向きの車線を 3 秒以上走ったら逆走（その向きの車線が近くに無い時だけ）。
   ※ OSM の車線網にある信号・向きだけが対象。駐車場の中・車線の無い道は判定しない。 */
const Rules = (() => {
  const subs = []; let prev = new Map(), wrongT = 0, cdRed = 0, cdWrong = 0, acc = 0;
  const on = (fn) => subs.push(fn);
  const emit = (kind, info) => { for(const f of subs){ try{ f(kind, info); }catch(e){ console.warn("rules", e); } } };
  function reset(){ prev = new Map(); wrongT = 0; cdRed = 0; cdWrong = 0; acc = 0; }
  function tick(dt){
    if(!(S.mode === "car" && Car.C.active) || !Traffic.ready){ if(prev.size) prev = new Map(); return; }
    acc += dt; if(acc < 0.08) return; const step = acc; acc = 0; cdRed -= step; cdWrong -= step;
    const C = Car.C, v = Math.abs(C.v), fwd = C.gear !== "R" && C.v > 0.3;
    if(!fwd){ prev = new Map(); wrongT = Math.max(0, wrongT - step * 2); return; }
    const fx = Math.sin(C.yaw), fz = Math.cos(C.yaw), segs = Traffic.segs;
    const hits = Traffic.locate(C.x + fx * 2.2, C.z + fz * 2.2, C.yaw, 9, 4), cur = new Map();
    for(const h of hits){
      if(h.d > 3.4 || h.dot < 0.75) continue; const g = segs[h.i]; if(!g.lane || !g.sig) continue;
      const p = prev.get(h.i); cur.set(h.i, h.s);
      if(p !== undefined && p < g.sig.s && h.s >= g.sig.s && h.s - p < 14){
        const t = S.t;
        if(phaseState(g.sig.g, g.sig.ph, t) === 2 && phaseState(g.sig.g, g.sig.ph, t - 1.0) === 2 && v > 2.2 && cdRed <= 0){ cdRed = 6; emit("red", { x: C.x, z: C.z }); }
      }
    }
    prev = cur;
    // 逆走: 車の真下の車線（2.2m 以内）が反対向きだけ（同じ向きの車線が無い）で、3 秒以上走ったら
    let compat = false, opp = false; for(const h of Traffic.locate(C.x, C.z, C.yaw, 4, 0)){ if(h.d > 2.2 || !segs[h.i].lane) continue; if(h.dot > -0.3) compat = true; else if(h.dot < -0.6) opp = true; }
    if(opp && !compat && v > 3) wrongT += step; else wrongT = Math.max(0, wrongT - step * 2);
    if(wrongT > 3 && cdWrong <= 0){ cdWrong = 25; wrongT = 0; emit("wrong", { x: C.x, z: C.z }); }
  }
  return { on, tick, reset };
})();

/* ---------------- v41.10: タクシー営業 ----------------
   岡山駅東口の乗り場から出発して、街を流しながらお金を稼ぐ。終わりたい時は「営業終了」。
   ・乗り場: data/poi.json の実在のタクシー乗り場 30 か所（OSM の amenity=taxi＋駅・病院・商業施設）。待ち客は乗り場ごとの「重み」と時間帯でランダムに現れる（重みは推定）。
   ・配車依頼: 空車のあいだ 30〜80 秒ごとにランダムな住宅・施設から無線で依頼。Y か「受ける」で迎車（ナビに自動セット）。
   ・料金: 岡山県の普通車運賃（2025-11 改定: 初乗り 1.1 km で 700 円・以降 250 m ごとに 100 円）を基準に、時速 10 km 以下は 90 秒ごとに 100 円相当の時間加算。
     深夜早朝（22〜5 時）2 割増・迎車料金 300 円は一般的な値からの推定。実際の会社の運賃・メーターとは違う。
   ・お客さんの満足度（5.0 から減点）: 急発進・急ブレーキ・急ハンドル、衝突、速度超過、信号無視、逆走、遠回り、待たせすぎ。高いと「おつりはいらない」。
   ・お客さん・行き先は架空。地点は実在の場所（OSM／PLATEAU）。 */
/* ---------------- v41.15: 岡山めぐり（スタンプラリー）----------------
   どの乗り物で走っても（電車・バス・車・ヘリ）、名所のそばを通るとスタンプが押される。記録はこのブラウザに保存（Prefs の misc "stamps"）。
   J キー（画面上の「スタンプ」ボタン）でスタンプ帳。位置は data/poi.json（OpenStreetMap）の座標。豆知識は、短く、確かな内容だけにした。
   電車・ヘリは決まった道筋・高い所を通るので、判定の半径を広げる（電車 ×1.5・ヘリ ×1.7）。
   talk: タクシーのお客さんが、そばを通ったときに話す一言（d: 岡山弁、s: ふつうの言葉）。 */
const Stamps = (() => {
  const LIST = [
    { id: "eki", name: "岡山駅 東口", x: -85, z: 36, r: 90, fact: "新幹線・在来線・路面電車・バスが集まる、岡山の玄関口。駅前には桃太郎の像があります。",
      talk: { d: "駅前は、いつ来ても人が多いなぁ。", s: "駅前は、いつ来ても人が多いですね。" } },
    { id: "aeon", name: "イオンモール岡山", x: -213, z: 380, r: 80, fact: "岡山駅のすぐ近くにある、大きな商業施設。",
      talk: { d: "このへんは、買い物の人が多いなぁ。", s: "このあたりは、買い物の人が多いですね。" } },
    { id: "nishikawa", name: "西川緑道公園", x: 278, z: 24, r: 90, fact: "かつて街を流れていた用水路（西川）の跡につくられた、街なかの散歩道。",
      talk: { d: "西川の緑道は、散歩にちょうどええんじゃ。", s: "西川の緑道は、散歩にちょうどいいんですよ。" } },
    { id: "orient", name: "岡山市立オリエント美術館", x: 958, z: -95, r: 80, fact: "古代オリエント（エジプトやメソポタミアなど）の美術品や考古資料を集めた美術館。",
      talk: { d: "オリエント美術館、いっぺん行ってみたいんじゃけどなぁ。", s: "オリエント美術館、一度行ってみたいんですよね。" } },
    { id: "symphony", name: "岡山シンフォニーホール", x: 940, z: 39, r: 80, fact: "音楽会がひらかれる、岡山のコンサートホール。" },
    { id: "castle", name: "岡山城", x: 1518, z: 78, r: 100, fact: "黒い外壁から「烏城（うじょう）」とも呼ばれるお城。",
      talk: { d: "お城が見えるなぁ。烏城じゃ。", s: "お城が見えますね。烏城です。" } },
    { id: "korakuen", name: "後楽園", x: 1507, z: -90, r: 120, fact: "旭川をはさんで岡山城の向かい側にある庭園。日本三名園の一つ。",
      talk: { d: "後楽園は、ええ庭じゃけぇ、行ってみんさいな。", s: "後楽園は、いい庭ですよ。ぜひ行ってみてください。" } },
    { id: "hakubutsu", name: "岡山県立博物館", x: 1293, z: -327, r: 115, fact: "岡山の歴史や文化を紹介する県立の博物館。後楽園のそばにあります。" },
    { id: "hayashibara", name: "林原美術館", x: 1252, z: 209, r: 80, fact: "岡山城のすぐそばにある美術館。" },
    { id: "yumeji", name: "夢二郷土美術館", x: 1370, z: -575, r: 100, fact: "岡山県出身の画家・詩人、竹久夢二の作品を紹介する美術館。",
      talk: { d: "夢二の絵は、ええ雰囲気じゃなぁ。", s: "夢二の絵は、いい雰囲気ですよね。" } },
    { id: "tenmaya", name: "天満屋", x: 847, z: 414, r: 80, fact: "岡山の街を代表する、老舗の百貨店。",
      talk: { d: "天満屋で買い物して帰ろうかなぁ。", s: "天満屋で買い物して帰ろうかな。" } },
    { id: "kencho", name: "岡山県庁", x: 1395, z: 415, r: 80, fact: "岡山県の県庁がある場所。路面電車の電停「県庁前」が目の前です。" },
    { id: "harenowa", name: "ハレノワ（岡山芸術創造劇場）", x: 909, z: 959, r: 90, fact: "路面電車の電停の名前にもなっている、岡山芸術創造劇場。",
      talk: { d: "ハレノワで芝居を観てみたいなぁ。", s: "ハレノワで観劇してみたいんですよね。" } },
    { id: "koukichi", name: "鳥人幸吉ゆかりの地", x: 817, z: 178, r: 80, fact: "江戸時代に翼で空を飛んだと伝わる「鳥人幸吉」が、奉公した紙屋の跡。",
      talk: { d: "鳥人幸吉いう、空を飛んだ人がおったんじゃってなぁ。", s: "鳥人幸吉という、空を飛んだ人がいたそうですね。" } },
    { id: "hangaku", name: "旧岡山藩藩学", x: 690, z: -209, r: 90, fact: "江戸時代に岡山藩がつくった学校の跡。" },
    { id: "okaden", name: "おかでんミュージアム", x: 2150, z: 1045, r: 90, fact: "路面電車を走らせる岡山電気軌道の、東山の車庫のそばにある電車の博物館。",
      talk: { d: "路面電車は、ええなぁ。のんびり走りよる。", s: "路面電車は、のんびりしていていいですね。" } },
    { id: "tenji", name: "点字ブロック発祥の地", x: 2960, z: -403, r: 90, fact: "世界で最初の点字ブロックは、岡山でうまれました。",
      talk: { d: "点字ブロックは、岡山で生まれたんじゃって。", s: "点字ブロックは、岡山生まれなんですよ。" } },
    { id: "stadium", name: "JFE晴れの国スタジアム", x: -11, z: -1671, r: 130, fact: "サッカー・ファジアーノ岡山のホームスタジアム。",
      talk: { d: "ファジアーノ、応援に行きたいなぁ。", s: "ファジアーノを応援しに行きたいな。" } },
    { id: "zoo", name: "池田動物園", x: -1230, z: -1029, r: 100, fact: "岡山市北区にある動物園。",
      talk: { d: "動物園、子どもを連れて行きてぇなぁ。", s: "動物園、子どもを連れて行きたいな。" } },
    { id: "handayama", name: "岡山市半田山植物園", x: 988, z: -3063, r: 145, fact: "半田山のふもとにある、市立の植物園。" },
  ];
  const N = LIST.length, KEY = "stamps";
  let got = {}; try { const o = Prefs.getM(KEY, {}); if(o && typeof o === "object") got = o; } catch(e){}
  const count = () => LIST.filter((s) => got[s.id]).length;
  const title = (n) => n >= N ? "岡山マスター" : n >= N * 0.9 ? "岡山の達人" : n >= N * 0.65 ? "岡山通" : n >= N * 0.4 ? "地元ドライバー" : n >= N * 0.2 ? "まち歩き見習い" : n >= 1 ? "岡山ビギナー" : "スタンプ帳を手に入れた";
  const byId = (id) => LIST.find((s) => s.id === id);

  /* いまの位置（走っていないときは null）。k = 判定の半径にかける倍率 */
  function where(){
    const mo = S.mode;
    if(mo === "car" || mo === "bus"){ const C = Car.C; return C.active ? { x: C.x, z: C.z, k: 1 } : null; }
    if(mo === "heli"){ const H = Heli.H; return H.active ? { x: H.x, z: H.z, k: 1.7 } : null; }
    if(mo === "tram"){ if(!S.running || !S.track || !S.track.length) return null; const p = pointAt(S.pos); return { x: p.x, z: p.z, k: 1.5 }; }
    return null;
  }
  const $s = (id) => document.getElementById(id);
  let popT = 0; const subs = [];
  function pop(s, n){
    const done = n >= N, el = $s("stpop"); if(!el) return;
    $s("stpop-n").textContent = done ? "コンプリート！ 称号「" + title(n) + "」" : "スタンプ " + n + " / " + N + "　称号「" + title(n) + "」";
    $s("stpop-name").textContent = s.name; $s("stpop-fact").textContent = s.fact;
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); popT = done ? 9 : 6;   // 押す動きをもう一度見せるため、いったん外して付け直す
    Snd.blip(done ? "done" : "stamp");
  }
  function collect(s){
    got[s.id] = new Date().toISOString().slice(0, 10);
    try { Prefs.setM(KEY, got); } catch(e){}
    pop(s, count()); renderAll(); for(const f of subs){ try{ f(s); }catch(e){ console.warn("stamp", e); } }
  }
  let acc = 0;
  function tick(dt){
    if(popT > 0){ popT -= dt; if(popT <= 0){ const el = $s("stpop"); if(el) el.classList.remove("on"); } }
    acc += dt; if(acc < 0.25) return; acc = 0;
    const w = where(); if(!w) return;
    for(const s of LIST){ if(got[s.id]) continue; if(Math.hypot(s.x - w.x, s.z - w.z) <= s.r * w.k){ collect(s); break; } }
  }
  /* タクシーのお客さんが話す名所（そばにあって、一言があるもの） */
  function nearTalk(x, z, d){ let b = null, bd = d; for(const s of LIST){ if(!s.talk) continue; const q = Math.hypot(s.x - x, s.z - z); if(q < bd){ bd = q; b = s; } } return b; }

  /* ---- スタンプ帳（ゲーム中の画面 #stp と、メニューの「岡山めぐり」）---- */
  const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  const dirOf = (dx, dz) => DIRS[Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) / 45) % 8];
  const dstr = (m) => m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m / 10) * 10 + " m";
  function rowsHtml(live){
    const w = live ? where() : null, car = live && S.mode === "car";
    return LIST.map((s) => {
      if(got[s.id]) return '<li class="stp-row got"><i>✓</i><div><b>' + s.name + '</b><small>' + s.fact + '</small></div><em>' + got[s.id] + '</em></li>';
      const where_ = w ? dirOf(s.x - w.x, s.z - w.z) + "へ " + dstr(Math.hypot(s.x - w.x, s.z - w.z)) : "まだ行っていない";
      return '<li class="stp-row"><i>○</i><div><b>' + s.name + '</b><small>' + where_ + '</small></div>' + (car ? '<button type="button" data-nav="' + s.id + '">ナビ</button>' : '<span></span>') + '</li>';
    }).join("");
  }
  function renderAll(){
    const n = count(), t = title(n);
    const cnt = $s("stp-cnt"); if(cnt) cnt.textContent = n + " / " + N;
    const bar = $s("stp-bar"); if(bar) bar.style.width = (n / N * 100).toFixed(0) + "%";
    const tt = $s("stp-title"); if(tt) tt.textContent = "称号「" + t + "」";
    const m = $s("stp-menu"); if(m){ m.innerHTML = '<b>岡山めぐり（スタンプラリー）　' + n + ' / ' + N + '</b>　称号「' + t + '」<br>電車・バス・車・ヘリ、どれで走っても、名所のそばを通るとスタンプが押されます（記録はこのブラウザに保存）。ゲーム中は J キーか「スタンプ」ボタンでスタンプ帳が開きます。<ol class="stp-rows">' + rowsHtml(false) + '</ol>'; }
    const sm = $s("stp-sum"); if(sm) sm.textContent = "岡山めぐり " + n + "/" + N;
    if(open) { const r = $s("stp-rows"); if(r) r.innerHTML = rowsHtml(true); }
  }
  let open = false;
  function setOpen(v){
    open = !!v; const el = $s("stp"); if(!el) return; el.classList.toggle("on", open);
    if(open){ if(typeof TT !== "undefined" && TT.open) TT.setOpen(false); const r = $s("stp-rows"); if(r) r.innerHTML = rowsHtml(true); }
  }
  const toggle = () => { if(typeof Clock !== "undefined" && !Clock.inSession()) return; setOpen(!open); };
  document.addEventListener("keydown", (e) => {
    if(e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    if(e.key === "j" || e.key === "J") toggle(); else if(e.key === "Escape" && open) setOpen(false);
  });
  document.addEventListener("click", (e) => {
    if(e.target.closest(".stbtn")){ toggle(); return; }
    if(e.target.id === "stp" || e.target.closest("#stp-close")){ setOpen(false); return; }
    const b = e.target.closest("button[data-nav]"); if(b){ const s = byId(b.dataset.nav); if(s && S.mode === "car"){ Nav.setTarget({ x: s.x, z: s.z, name: s.name, r: Math.round(s.r * 0.6), kind: "drop" }, "user"); setOpen(false); } }
  });
  // 開いている間、まだ行っていない名所の方角・距離を更新する
  setInterval(() => { if(open){ const r = $s("stp-rows"); if(r) r.innerHTML = rowsHtml(true); } }, 1500);
  renderAll();
  return { LIST, tick, count, title, byId, nearTalk, on(f){ subs.push(f); }, uncollected(){ return LIST.filter((q) => !got[q.id]); }, setOpen, toggle, renderAll, where, collect, reset(){ got = {}; try { Prefs.setM(KEY, got); } catch(e){} renderAll(); }, get got(){ return got; }, get open(){ return open; } };
})();

const Taxi = (() => {
  const FARE = { base: 700, baseM: 1100, step: 100, stepM: 250, slowV: 10 / 3.6, slowEq: 250 / 90, night: 1.2, dispatch: 300, goal: 10000 };
  const T = { on: false, st: "idle", t: 0, money: 0, tips: 0, rides: 0, cancels: 0, passed: 0, full: 0, empty: 0, rateSum: 0, rateN: 0, goalHit: false,
    stands: [], call: null, offer: null, ride: null, nextCall: 0, hold: 0, payT: 0, lastHit: false, comfortT: 0, speedT: 0, speedAcc: 0, near: null, nearT: 0, hudT: 0, toastT: 0, summary: false, pending: false, walkers: [] };
  const rnd = Math.random, pick = (a) => a[Math.floor(rnd() * a.length)];
  const me = () => ({ x: Car.C.x, z: Car.C.z, yaw: Car.C.yaw, v: Math.abs(Car.C.v) });
  const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
  const hr = () => ((S.clock / 3600) % 24 + 24) % 24;
  const tf = (h) => h >= 7 && h < 9.5 ? 1.5 : h >= 9.5 && h < 16 ? 1.0 : h >= 16 && h < 19.5 ? 1.5 : h >= 19.5 && h < 23 ? 1.2 : 0.5;
  const fmtKm = (m) => m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m / 10) * 10 + " m";
  const fmtT = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const night = () => { const h = hr(); return h >= 22 || h < 5; };
  function saved(){ const o = Prefs.getM("taxi", null); return o && typeof o === "object" ? o : { total: 0, shifts: 0, rides: 0, best: 0, bestHourly: 0 }; }
  const bestText = () => { const o = saved(); return o.shifts ? "最高 " + yen(o.best) + "・" + o.shifts + " 回営業" : ""; };

  /* ---- 運賃 ---- */
  function meterFare(R){
    const eq = R.dist + R.slowT * FARE.slowEq, n = Math.max(0, Math.ceil((eq - FARE.baseM) / FARE.stepM)), f = FARE.base + n * FARE.step;
    return R.night ? Math.round(f * FARE.night / 10) * 10 : f;
  }

  /* ---- 3D: 乗り場の標識・光の柱・お客さん ---- */
  const grp = new THREE.Group(); grp.visible = false; scene.add(grp);
  const PG = { leg: new THREE.BoxGeometry(0.3, 0.82, 0.2), body: new THREE.BoxGeometry(0.44, 0.62, 0.26), head: new THREE.SphereGeometry(0.13, 8, 6) };
  const PM = {}; const mat = (c) => PM[c] || (PM[c] = new THREE.MeshLambertMaterial({ color: c }));
  const CLOTH = [0x2f4b7c, 0x7c2f3f, 0x3f6b4a, 0x6b5b3a, 0x444a55, 0xb08a3c, 0x7a4b7a, 0x2a7a8a, 0xc9c2b2];
  function person(seed){
    const g = new THREE.Group(), col = CLOTH[Math.abs(seed | 0) % CLOTH.length];
    const leg = new THREE.Mesh(PG.leg, mat(0x2a2d36)); leg.position.y = 0.41; g.add(leg);
    const bd = new THREE.Mesh(PG.body, mat(col)); bd.position.y = 1.13; g.add(bd);
    const hd = new THREE.Mesh(PG.head, mat(0xe3b995)); hd.position.y = 1.58; g.add(hd);
    const hair = new THREE.Mesh(PG.head, mat(0x1d1a17)); hair.scale.set(1.06, 0.72, 1.06); hair.position.y = 1.645; g.add(hair);
    return g;
  }
  const beamMat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
  let signTexC = null;
  function signTex(){ return signTexC || (signTexC = canvasTex(128, 128, (g, w, h) => { g.fillStyle = "#f2c230"; g.fillRect(0, 0, w, h); g.strokeStyle = "#1a1408"; g.lineWidth = 6; g.strokeRect(5, 5, w - 10, h - 10);
    g.fillStyle = "#1a1408"; g.font = "bold 78px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("T", w / 2, h * 0.38); g.font = "bold 21px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.fillText("タクシー", w / 2, h * 0.76); })); }
  function buildStand(s){
    const y = Car.hAt(s.x, s.z), g = new THREE.Group(); g.position.set(s.x, y, s.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6), mat(0x6d7076)); pole.position.y = 1.25; g.add(pole);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ map: signTex(), side: THREE.DoubleSide })); pl.position.y = 2.55; g.add(pl);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 70, 10, 1, true), beamMat(0xffd54a, 0.32)); beam.position.y = 35; beam.visible = false; g.add(beam);
    grp.add(g); s.g = g; s.beam = beam; s.figs = []; s.figN = 0;
  }
  function figsSync(s, near){
    const want = near ? Math.min(3, s.q.reduce((a, c) => a + c.n, 0)) : 0;
    if(want === s.figN) return; for(const f of s.figs){ s.g.remove(f); } s.figs.length = 0; s.figN = want;
    for(let k = 0; k < want; k++){ const p = person(s.i * 7 + k * 3 + (s.q[0] ? s.q[0].seed : 0)); p.position.set(0.9 + k * 0.62, 0, 0.5 - k * 0.2); p.rotation.y = -1.2 + k * 0.3; s.g.add(p); s.figs.push(p); }
  }
  let mk = null;
  function markerSet(x, z, y, r, col){
    if(!mk){ const g = new THREE.Group(); const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 150, 12, 1, true), beamMat(col, 0.42)); beam.position.y = 75; g.add(beam);
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 1.2, r, 48), beamMat(col, 0.9)); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15; g.add(ring);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 40), beamMat(col, 0.14)); disc.rotation.x = -Math.PI / 2; disc.position.y = 0.12; g.add(disc); mk = { g, beam, ring, disc }; grp.add(g); }
    mk.g.position.set(x, y, z); mk.g.visible = true; mk.beam.material.color.setHex(col); mk.ring.material.color.setHex(col); mk.disc.material.color.setHex(col);
    mk.ring.geometry.dispose(); mk.ring.geometry = new THREE.RingGeometry(Math.max(1, r - 1.2), r, 48); mk.disc.geometry.dispose(); mk.disc.geometry = new THREE.CircleGeometry(r, 40);
  }
  const markerOff = () => { if(mk) mk.g.visible = false; };
  function clean3d(){
    for(const s of T.stands){ if(s.g){ grp.remove(s.g); s.g.traverse((o) => { if(o.geometry && o.geometry !== PG.leg && o.geometry !== PG.body && o.geometry !== PG.head) o.geometry.dispose(); if(o.material && o.material.map === undefined) o.material.dispose(); }); } }
    for(const w of T.walkers) grp.remove(w.m); T.walkers.length = 0;
    if(T.call && T.call.figs) for(const f of T.call.figs) grp.remove(f);
    markerOff(); grp.visible = false;
  }

  /* ---- 画面 ---- */
  const css = `
.txcol{ position:fixed; z-index:12; left:12px; top:calc(58px + env(safe-area-inset-top,0px)); width:min(300px, calc(100% - 24px)); display:none; flex-direction:column; gap:8px; pointer-events:none; }
.txcol.on{ display:flex; } .txcol button{ pointer-events:auto; font-family:inherit; cursor:pointer; }
.txhud{ background:rgba(20,17,12,.88); border:1px solid var(--line,#5a4a2a); border-radius:6px; padding:9px 12px 10px; backdrop-filter:blur(5px); box-shadow:0 10px 30px rgba(0,0,0,.4); color:var(--cream,#f1ead9); }
.tx-top{ display:flex; align-items:center; gap:8px; } .tx-top b{ font-size:14px; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tx-top button{ font-size:11px; color:#cfc5ac; background:transparent; border:1px solid var(--line,#5a4a2a); border-radius:3px; padding:2px 8px; } .tx-top button:hover{ border-color:var(--amber,#ffb02e); color:var(--amber,#ffb02e); }
.tx-badge{ font-size:12px; font-weight:800; letter-spacing:.08em; padding:2px 9px; border-radius:11px; color:#10200f; background:#5fe08a; } .tx-badge.pick{ background:#ffb02e; color:#241804; } .tx-badge.ride{ background:#ff5b4a; color:#fff; } .tx-badge.pay{ background:#9aa3ad; color:#111; }
.tx-money{ display:flex; align-items:baseline; justify-content:space-between; margin-top:7px; } .tx-money b{ font-size:25px; color:var(--amber,#ffb02e); font-variant-numeric:tabular-nums; } .tx-money small{ font-size:11px; color:#a99f88; }
.tx-bar{ height:5px; margin-top:5px; border-radius:3px; background:rgba(255,255,255,.12); overflow:hidden; } .tx-bar i{ display:block; height:100%; width:0; background:linear-gradient(90deg,#ffb02e,#ffe27a); }
.tx-info{ margin-top:7px; font-size:12.5px; line-height:1.45; color:#e6dcc0; min-height:18px; } .tx-info b{ color:#fff; }
.tx-meter{ display:none; margin-top:7px; padding:6px 10px; border-radius:4px; background:#150a08; border:1px solid #5a2a22; font-variant-numeric:tabular-nums; } .tx-meter.on{ display:flex; align-items:baseline; justify-content:space-between; }
.tx-meter b{ font-family:'Courier New',monospace; font-size:28px; letter-spacing:.06em; color:#ff4b3a; text-shadow:0 0 8px rgba(255,75,58,.55); } .tx-meter small{ font-size:11px; color:#c9a79f; text-align:right; line-height:1.35; }
.tx-stats{ margin-top:7px; padding-top:6px; border-top:1px solid var(--line,#5a4a2a); display:flex; justify-content:space-between; gap:6px; font-size:11.5px; color:#cfc5ac; font-variant-numeric:tabular-nums; } .tx-stats b{ color:var(--cream,#f1ead9); }
.tx-btns{ display:flex; gap:6px; margin-top:7px; } .tx-btns button{ flex:1; font-size:11.5px; color:#e6dcc0; background:#2a2418; border:1px solid var(--line,#5a4a2a); border-radius:4px; padding:5px 6px; } .tx-btns button:hover{ border-color:var(--amber,#ffb02e); color:var(--amber,#ffb02e); }
.txcall{ display:none; background:rgba(40,28,8,.95); border:2px solid var(--amber,#ffb02e); border-radius:8px; padding:10px 12px 11px; box-shadow:0 0 0 0 rgba(255,176,46,.5), 0 14px 34px rgba(0,0,0,.5); color:var(--cream,#f1ead9); animation:txPulse 1.4s ease-out infinite; }
.txcall.on{ display:block; } @keyframes txPulse{ 0%{ box-shadow:0 0 0 0 rgba(255,176,46,.55), 0 14px 34px rgba(0,0,0,.5);} 100%{ box-shadow:0 0 0 14px rgba(255,176,46,0), 0 14px 34px rgba(0,0,0,.5);} } @media (prefers-reduced-motion: reduce){ .txcall{ animation:none; } }
.txcall small.k{ display:block; font-size:10px; letter-spacing:.16em; color:var(--amber,#ffb02e); } .txcall b.nm{ display:block; font-size:16px; margin-top:2px; line-height:1.3; } .txcall .sub{ font-size:12px; color:#d6cba9; margin-top:3px; }
.txcall .tbar{ height:4px; margin-top:7px; background:rgba(255,255,255,.14); border-radius:2px; overflow:hidden; } .txcall .tbar i{ display:block; height:100%; width:100%; background:var(--amber,#ffb02e); }
.txcall .bt{ display:flex; gap:8px; margin-top:9px; } .txcall .bt button{ flex:1; font-size:14px; font-weight:800; padding:9px; border-radius:6px; border:1px solid var(--line,#5a4a2a); color:#e6dcc0; background:#2a2418; } .txcall .bt button.go{ background:var(--amber,#ffb02e); color:#1a1408; border:0; }
.txrc{ position:fixed; z-index:14; left:50%; top:calc(120px + env(safe-area-inset-top,0px)); transform:translate(-50%,-8px); width:min(340px, calc(100% - 24px)); display:none; background:rgba(250,246,234,.97); color:#2a2418; border-radius:6px; padding:12px 16px 12px; box-shadow:0 18px 44px rgba(0,0,0,.55); font-family:inherit; }
.txrc.on{ display:block; transform:translate(-50%,0); } .txrc h4{ margin:0 0 6px; font-size:12px; letter-spacing:.18em; color:#7a5d1c; border-bottom:1px dashed #b9a468; padding-bottom:5px; display:flex; justify-content:space-between; }
.txrc .r{ display:flex; justify-content:space-between; font-size:13px; margin:2px 0; font-variant-numeric:tabular-nums; } .txrc .tot{ font-size:19px; font-weight:800; border-top:1px solid #2a2418; margin-top:5px; padding-top:5px; } .txrc .cm{ margin-top:7px; font-size:12.5px; color:#5a4a2a; } .txrc .st{ color:#c07a10; letter-spacing:.06em; }
body.nav-on .txcol{ top:calc(58px + env(safe-area-inset-top,0px)); }
@media (max-width:900px){ body.nav-on .txcol{ top:calc(172px + env(safe-area-inset-top,0px)); } body.nav-on .txrc{ top:calc(250px + env(safe-area-inset-top,0px)); } }
@media (max-width:619px){ .txcol{ width:calc(100% - 24px); } }
`;
  let built = false, E = {};
  const $e = (id) => E[id] || (E[id] = document.getElementById(id));
  function dom(){
    if(built) return; built = true;
    const sty = document.createElement("style"); sty.textContent = css; document.head.appendChild(sty);
    const div = document.createElement("div");
    div.innerHTML = `
<div class="txcol" id="txcol"><section class="txhud" id="txhud">
<div class="tx-top"><span class="tx-badge" id="tx-badge">空車</span><b id="tx-ttl">タクシー営業</b><button type="button" id="tx-end">営業終了</button></div>
<div class="tx-money"><b id="tx-money">¥0</b><small id="tx-goal">目標 ¥10,000</small></div><div class="tx-bar"><i id="tx-gbar"></i></div>
<div class="tx-info" id="tx-info"></div>
<div class="tx-meter" id="tx-meter"><b id="tx-fare">¥700</b><small id="tx-msub"></small></div>
<div class="tx-btns" id="tx-btns"><button type="button" id="tx-go" style="display:none">客のいる乗り場へ案内</button><button type="button" id="tx-cancel" style="display:none">依頼を取り消す</button></div>
<div class="tx-stats"><span>乗車 <b id="tx-rides">0</b> 回</span><span>実車率 <b id="tx-rate">--</b></span><span>評価 <b id="tx-star">--</b></span></div>
</section>
<section class="txcall" id="txcall"><small class="k">配車依頼</small><b class="nm" id="txc-nm">--</b><div class="sub" id="txc-sub">--</div><div class="tbar"><i id="txc-bar"></i></div>
<div class="bt"><button type="button" id="txc-no">見送る</button><button type="button" class="go" id="txc-ok">受ける（Y）</button></div></section></div>
<div class="txrc" id="txrc"></div>`;
    while(div.firstChild) document.body.appendChild(div.firstChild);
    $e("tx-end").addEventListener("click", () => endShift());
    $e("txc-ok").addEventListener("click", () => accept()); $e("txc-no").addEventListener("click", () => decline());
    $e("tx-cancel").addEventListener("click", () => cancelCall(false));
    $e("tx-go").addEventListener("click", () => { const s = T.near; if(s) Nav.setTarget({ x: s.x, z: s.z, name: s.name, r: 30, kind: "load" }, "user", {}); });
    addEventListener("keydown", (e) => { if(e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing()) return; if((e.key === "y" || e.key === "Y") && T.on && T.offer) accept(); });
  }
  function toast(msg, kind, ms){
    const t = document.getElementById("qtoast"); if(!t) return; t.textContent = msg; t.className = "qtoast on " + (kind || ""); T.toastT = ms || 3.6;
    if(kind === "good") Snd.blip("done"); else if(kind === "bad") Snd.blip("bad"); else if(kind === "load") Snd.blip("load"); else Snd.blip("ok");
  }
  const say = (txt, urgent) => { try{ Nav.Voice.say(txt, urgent); }catch(e){} };

  /* ---- 車の見た目（黄色い車体・屋根の行灯） ---- */
  const LAMP = { "空車": "#18a05a", "迎車": "#e08a12", "賃走": "#d8352a" };
  const lamp = (m) => { try{ Car.setTaxi(m, LAMP[m]); }catch(e){} };

  /* ---- 乗り場 ---- */
  function setupStands(){
    const P = Nav.POI; T.stands = [];
    for(const [i, a] of ((P && P.taxi) || []).entries()){ const s = { i, x: a[0], z: a[1], name: a[2], w: a[3], q: [], tNext: 0, g: null, beam: null, figs: [], figN: 0, curb: null, dc: 1e9 }; buildStand(s); T.stands.push(s);
      { const ln = laneAt(s.x, s.z, 45); if(ln && ln.d > 14) s.curb = { x: ln.x, z: ln.z }; }   // 乗り場の標識が道から離れているとき、いちばん近い車線の上に停まっても乗せられるように
      if(s.w >= 3){ for(let k = 0, n = 1 + Math.floor(rnd() * 2); k < n; k++) s.q.push(newGroup()); } else if(rnd() < 0.3) s.q.push(newGroup());
      s.tNext = T.t + 240 / (s.w * tf(hr())) * (0.4 + rnd()); }
    grp.visible = true;
  }
  const newGroup = () => ({ n: rnd() < 0.7 ? 1 : rnd() < 0.75 ? 2 : 3, t: T.t, seed: Math.floor(rnd() * 99) });
  function standTick(dt){
    const m = me(), f = tf(hr());
    for(const s of T.stands){
      if(T.t >= s.tNext){ if(s.q.length < 3) s.q.push(newGroup()); s.tNext = T.t + 240 / (s.w * f) * (0.5 + rnd()); }
      if(s.q.length && T.t - s.q[0].t > 600){ s.q.shift(); }
      const d = Math.hypot(s.x - m.x, s.z - m.z); s.dist = d; s.dc = s.curb ? Math.hypot(s.curb.x - m.x, s.curb.z - m.z) : 1e9;
      s.beam.visible = s.q.length > 0 && d < 1800; figsSync(s, d < 520);
    }
    T.nearT -= dt;
    if(T.nearT <= 0){ T.nearT = 0.6; let b = null; for(const s of T.stands) if(s.q.length && (!b || s.dist < b.dist)) b = s; T.near = b; }
  }
  const standCount = (i) => (T.stands[i] ? T.stands[i].q.reduce((a, c) => a + c.n, 0) : 0);

  /* ---- 配車依頼 ---- */
  function laneAt(x, z, rmax){ const L = Traffic.locate(x, z, null, rmax, 1)[0]; if(!L) return null; const t = pathTan(Traffic.segs[L.i].P, L.s); return { x: L.x, z: L.z, y: L.y, d: L.d, tx: t.x, tz: t.z, i: L.i, s: L.s }; }
  function makeCall(){
    const m = me(), sites = Quest.sites, P = Nav.POI; if(!P) return null;
    for(let tries = 0; tries < 40; tries++){
      const home = rnd() < 0.55 && sites && sites.drop.length;
      let c = null;
      if(home){
        const s = pick(sites.drop), d = Math.hypot(s.x - m.x, s.z - m.z); if(s.rw < 3.6 || d < 400 || d > 2300) continue;
        const yaw = s.yaw * Math.PI / 180, nx = Math.cos(yaw), nz = -Math.sin(yaw), off = (s.rw / 2 + 0.9) * (s.side || 1);
        c = { kind: "home", name: Quest.town(s.town) + "のお客さん宅前", x: s.x, z: s.z, y: s.y, r: 8, px: s.x + nx * off, pz: s.z + nz * off, dist: d };
      } else {
        const cats = [2, 2, 10, 7, 7, 8, 0, 3, 5, 11, 4], cat = pick(cats), L = P.p.filter((q) => q[1] === cat), it = L.length ? pick(L) : null; if(!it) continue;
        const d = Math.hypot(it[2] - m.x, it[3] - m.z); if(d < 400 || d > 2300) continue;
        const ln = laneAt(it[2], it[3], 90); if(!ln || ln.d > 60) continue;
        c = { kind: "poi", name: it[0] + "前", x: ln.x, z: ln.z, y: ln.y, r: 11, px: ln.x + ln.tz * 2.4, pz: ln.z - ln.tx * 2.4, dist: d };
      }
      const R = Nav.plan(m.x, m.z, m.yaw, c.x, c.z); if(!R) continue;   // 行き着けない場所は選ばない
      if(R.total > 3600 || R.total > Math.max(1500, c.dist * 2.2)) continue;   // 一方通行などで大回りになる依頼は出さない（待ってもらえる時間に間に合わない）
      c.route = R.total; c.eta = R.time * 1.12 + 15;
      c.n = rnd() < 0.7 ? 1 : rnd() < 0.75 ? 2 : 3; c.fee = FARE.dispatch; c.seed = Math.floor(rnd() * 99);
      return c;
    }
    return null;
  }
  function offerCall(){
    const c = makeCall(); if(!c){ T.nextCall = T.t + 20; return; }
    T.offer = { c, left: 20 };
    $e("txc-nm").textContent = c.name; $e("txc-sub").textContent = "約 " + fmtKm(c.route) + "・およそ " + Math.max(1, Math.round(c.eta / 60)) + " 分 ／ 迎車料金 " + yen(c.fee) + (c.n > 1 ? " ／ " + c.n + " 名様" : "");
    $e("txcall").classList.add("on"); Snd.blip("load"); say("配車依頼です。" + c.name + "。");
  }
  function closeOffer(){ T.offer = null; $e("txcall").classList.remove("on"); }
  function decline(){ if(!T.offer) return; closeOffer(); T.passed++; T.nextCall = T.t + 25 + rnd() * 45; toast("依頼を見送りました", ""); }
  function accept(){
    const o = T.offer; if(!o || T.st !== "cruise") return; const c = o.c; closeOffer();
    { const m = me(), R = Nav.plan(m.x, m.z, m.yaw, c.x, c.z); if(R){ c.route = R.total; c.eta = R.time * 1.12 + 15; } }   // 受けた時点の位置から、もう一度道のりを計算
    T.call = c; c.t0 = T.t; c.limit = Math.max(150, c.eta * 1.7 + 60); c.promised = c.eta * 1.4 + 40; T.st = "pick"; T.hold = 0; lamp("迎車");
    c.figs = []; for(let k = 0; k < c.n; k++){ const p = person(c.seed + k * 5); p.position.set(c.px + k * 0.6, Car.hAt(c.px, c.pz), c.pz + k * 0.15); p.rotation.y = rnd() * 6; grp.add(p); c.figs.push(p); }
    markerSet(c.x, c.z, c.y + 0.1, c.r, 0x35d0ff);
    Nav.setTarget({ x: c.x, z: c.z, name: c.name, r: c.r, kind: "load" }, "auto");
    toast("配車を受けました — " + c.name + " へ（待ってくれるのは約 " + Math.round(c.limit / 60 * 10) / 10 + " 分）", "load");
  }
  function cancelCall(byCustomer){
    const c = T.call; if(!c) return; if(c.figs) for(const f of c.figs) grp.remove(f); c.figs = null; T.call = null; T.st = "cruise"; T.hold = 0; markerOff(); Nav.clear("auto"); lamp("空車");
    T.cancels++; T.nextCall = T.t + 25 + rnd() * 45;
    toast(byCustomer ? "お客さんが待ちきれず、キャンセルしました" : "依頼を取り消しました", "bad");
  }

  /* ---- 乗せる・行き先・降ろす ---- */
  function pickDest(fx, fz, startPlan, tour){
    const P = Nav.POI, sites = Quest.sites, m = me(); if(!P) return null;
    const want = Math.min(6500, 800 + -Math.log(1 - rnd()) * 1700), W = { 0: 3, 2: 2.2, 3: 1.4, 4: 0.5, 5: 1, 7: 2.2, 8: 1.2, 9: 0.3, 10: 1.6, 11: 1.4, 12: 0.8, 13: 0.5, 14: 1.2, 1: 0.6, 6: 0.4 };
    for(let tries = 0; tries < 8; tries++){
      const cand = [];
      if(tour){ for(const q of Stamps.uncollected()){ const d = Math.hypot(q.x - fx, q.z - fz); if(d < 500) continue; cand.push({ c: { name: q.name, x: q.x, z: q.z, r: 14, stamp: q.id }, e: Math.abs(d - want) }); } }   // v41.15: 観光のお客さん
      else for(let k = 0; k < 70; k++){
        let c;
        if(rnd() < 0.3 && sites && sites.drop.length){ const s = pick(sites.drop); if(s.rw < 3.6) continue; c = { name: Quest.town(s.town) + "の自宅", x: s.x, z: s.z, y: s.y, r: 8, home: true }; }
        else { const it = pick(P.p); if(rnd() > (W[it[1]] || 0.5) / 3) continue; c = { name: it[0], x: it[2], z: it[3], r: 12 }; }
        const d = Math.hypot(c.x - fx, c.z - fz); if(d < 600) continue; cand.push({ c, e: Math.abs(d - want) });
      }
      cand.sort((a, b) => a.e - b.e);
      for(const { c } of cand.slice(0, 3)){
        if(!c.home){ const ln = laneAt(c.x, c.z, c.stamp ? 260 : 140); if(!ln || ln.d > (c.stamp ? 260 : 120)) continue; c.x = ln.x; c.z = ln.z; c.y = ln.y; }   // 名所は敷地が広く、道が遠いことがある（岡山城・後楽園）
        const R = Nav.plan(startPlan.x, startPlan.z, startPlan.yaw, c.x, c.z); if(!R) continue;
        if(R.total > 9000 || R.total > Math.max(2600, Math.hypot(c.x - fx, c.z - fz) * 3.0)) continue;   // 直線の 3 倍を超える大回りは選ばない
        c.routeM = R.total; c.eta = R.time * 1.12; return c;
      }
    }
    return null;
  }
  function startRide(from, n, dispatchFee, label){
    const m = me(); let dest = null; const tour = Stamps.uncollected().length > 0 && rnd() < 0.2;   // v41.15: 2 割は観光のお客さん（まだ行っていない名所へ）
    if(tour) dest = pickDest(m.x, m.z, m, true);
    if(!dest) dest = pickDest(m.x, m.z, m); if(!dest){ toast("お客さんの行き先が決まりませんでした。もう一度", "bad"); return false; }
    T.ride = { n, from: label, dest, dist: 0, slowT: 0, sat: 5, events: [], t0: T.t, fee: dispatchFee, night: night(), routeM: dest.routeM, eta: dest.eta, detourDone: false, tour: !!dest.stamp, dial: dest.stamp ? false : rnd() < 0.6, talkT: 4, talkN: 0, said: {}, lastDing: -99 };
    closeOffer(); T.st = "ride"; T.hold = 0; lamp("賃走"); markerSet(dest.x, dest.z, dest.y + 0.1, Math.max(10, dest.r + 2), 0xffb02e);
    Nav.setTarget({ x: dest.x, z: dest.z, name: dest.name, r: dest.r, kind: "drop" }, "auto");
    T.comfortT = 0; T.speedT = 0; T.speedAcc = 0; T.lastHit = false;
    toast("「" + (dest.stamp ? "観光で来ました。" : "") + dest.name + " までお願いします」 — 目安 " + fmtKm(dest.routeM) + "・約 " + Math.max(1, Math.round(dest.eta / 60)) + " 分", "load", 4.2); say((dest.stamp ? "観光で来ました。" : "") + dest.name + "までお願いします。");
    return true;
  }
  function boardCall(){
    const c = T.call; if(!c) return; let sat0 = 5; const ev = [];
    if(T.t - c.t0 > c.promised){ sat0 -= 0.5; ev.push("late"); toast("お待たせしました…（お客さんはだいぶ待っていた）", "bad"); }
    if(c.figs) for(const f of c.figs) grp.remove(f); c.figs = null; markerOff(); T.call = null;
    if(startRide(c, c.n, c.fee, c.name)){ T.ride.sat = sat0; T.ride.events.push(...ev); } else { T.st = "cruise"; lamp("空車"); }
  }
  function boardStand(s){
    const g = s.q.shift(); s.figN = -1; Snd.blip("load");
    if(!startRide(s, g.n, 0, s.name)){ s.q.unshift(g); }
  }
  function ding(pts, msg, tag){ const R = T.ride; if(!R) return; R.sat = Math.max(1, R.sat - pts); R.events.push(tag); R.lastDing = T.t; toast(msg + "（評価 −" + pts.toFixed(1) + "）", "bad");
    if(TALK.ding[tag]) bubble(tk(R, TALK.ding[tag]), 4.2); }
  /* v41.15: お客さんの会話（吹き出し）。お客さんの約 6 割は岡山弁（言い回しは作り手の知識で書いたもの。違和感があれば TALK を直す）。
     乗ってしばらくのあいさつ → 走っている間は 25〜50 秒おきに、そばの名所・遅れ・なめらかな運転・世間話。ぶつかる・急ブレーキなどは、その場で声が出る */
  const TALK = {
    hello: { d: ["よろしゅうお願いします。", "お願いしますけぇな。急がんでもええけぇ、安全にな。"], s: ["よろしくお願いします。", "お願いします。急がなくて大丈夫ですよ。"] },
    rain: { d: ["雨じゃなぁ。晴れの国いうても、降る時は降るんじゃなぁ。", "雨の日は運転しにくかろう。気ぃつけてな。"], s: ["雨ですね。晴れの国といっても、降るときは降りますね。", "雨の日の運転は大変でしょう。気をつけてくださいね。"] },
    night: { d: ["こねぇな遅うにすみません。", "夜遅うまで、ご苦労さんじゃなぁ。"], s: ["遅い時間にすみません。", "遅くまでお疲れさまです。"] },
    morn: { d: ["朝から忙しいなぁ。", "朝は道が混むけぇなぁ。"], s: ["朝は道が混みますね。", "朝から忙しいですね。"] },
    fine: { d: ["ええ天気じゃなぁ。", "今日は気持ちがええなぁ。"], s: ["いい天気ですね。", "気持ちのいい日ですね。"] },
    hurry: { d: ["ちぃと急いでもらえるかなぁ。", "間に合うかなぁ…。"], s: ["少し急いでもらえますか？", "間に合うかな…。"] },
    smooth: { d: ["ええ運転じゃなぁ。ゆっくり走ってくれて助かるわ。", "運転がなめらかじゃなぁ。眠とうなるわ。"], s: ["運転がなめらかで、助かります。", "運転が上手ですね。"] },
    chat: { d: ["桃太郎のふるさとじゃけぇなぁ、岡山は。", "きびだんご、買うて帰ろうかなぁ。", "ばら寿司が食べとうなったわ。", "岡山は晴れの日が多うて、ええ街じゃなぁ。", "白桃の季節になったら、ええなぁ。", "路面電車がのんびり走りよるのを見ると、ほっとするなぁ。"],
            s: ["桃太郎のふるさと、岡山ですからね。", "きびだんご、買って帰ろうかな。", "ばら寿司が食べたくなりました。", "岡山は晴れの日が多くて、いい街ですね。", "白桃の季節が楽しみです。", "路面電車がのんびり走っているのを見ると、ほっとします。"] },
    ding: { hit: { d: "いってぇ！ ぶつかったんか？", s: "えっ、ぶつかりました？" }, comfort: { d: "ひゃっ、あぶねぇ！", s: "わっ、びっくりした！" }, red: { d: "信号、赤じゃがな！", s: "信号、赤ですよ！" },
            speed: { d: "ちぃとはえぇなぁ。ゆっくりでええで。", s: "少し速くないですか？" }, wrong: { d: "逆じゃがな！", s: "逆走ですよ！" } },
    end: { top: { d: "ぼっけぇ快適じゃった。ありがとうなぁ！", s: "とても快適でした。ありがとう！" }, good: { d: "ありがとうなぁ。助かったわ。", s: "ありがとうございました。" },
           hit: { d: "ぶつかって、びっくりしたわ…", s: "ぶつかって、びっくりしました…" }, red: { d: "信号が赤じゃったで！", s: "信号が赤でしたよ！" }, wrong: { d: "逆走しとらんかったかな？", s: "逆走していませんでしたか？" },
           comfort: { d: "急ブレーキ・急ハンドルが、こわかったわ。", s: "急ブレーキ・急ハンドルが怖かったです。" }, speed: { d: "もうちぃとゆっくりでええんじゃが。", s: "もう少しゆっくりでお願いしたかったです。" },
           detour: { d: "遠回りされた気がするなぁ。", s: "遠回りされた気がします。" }, late: { d: "ずいぶん待ったで。", s: "ずいぶん待ちました。" } },
  };
  const tk = (R, o) => (R && R.dial ? o.d : o.s);
  const tkPick = (R, o) => { const a = R && R.dial ? o.d : o.s; return a[Math.floor(rnd() * a.length)]; };
  function bubble(txt, ms){
    const b = document.getElementById("txtalk"); if(!b) return; document.getElementById("txtalk-t").textContent = "「" + txt + "」"; b.classList.add("on"); T.talkShow = ms || 5.6;
  }
  Stamps.on((s) => {   // 乗せている間に初めての名所を通ると、お客さんが喜ぶ
    const R = T.ride; if(!T.on || T.st !== "ride" || !R) return; R.lastDing = -99;
    if(R.dest && R.dest.stamp === s.id){ bubble(R.dial ? "おぉ、ここが" + s.name + "かぁ！" : "わぁ、ここが" + s.name + "なんですね！", 5.2); return; }   // 行き先そのものは「通った名所」に数えない
    R.sights = (R.sights || 0) + 1;
    bubble(R.dial ? "ほぉ、" + s.name + "か。いっぺん見たかったんじゃ。" : "へぇ、" + s.name + "ですか。一度見てみたかったんです。", 5.2);
  });
  function bubbleOff(){ T.talkShow = 0; const b = document.getElementById("txtalk"); if(b) b.classList.remove("on"); }
  /* 次に話すこと（優先: そばの名所 → 遅れ → なめらかな運転 → あいさつ／世間話） */
  function chatLine(R, m){
    const s = Stamps.nearTalk(m.x, m.z, 230);
    if(s && !R.said["s_" + s.id]){ R.said["s_" + s.id] = 1; return tk(R, s.talk); }
    if(!R.said.hurry && T.t - R.t0 > R.eta * 1.3 + 30){ R.said.hurry = 1; return tkPick(R, TALK.hurry); }
    if(!R.said.smooth && !R.events.length && T.t - R.t0 > 45){ R.said.smooth = 1; return tkPick(R, TALK.smooth); }
    const pool = (R.dial ? TALK.chat.d : TALK.chat.s).filter((_, i) => !R.said["c" + i]); if(!pool.length) return null;
    const line = pool[Math.floor(rnd() * pool.length)]; R.said["c" + (R.dial ? TALK.chat.d : TALK.chat.s).indexOf(line)] = 1; return line;
  }
  function openingLine(R){
    if(R.tour) return ["初めての岡山なんです。楽しみです。", "観光で来ました。道中、よろしくお願いします。"][Math.floor(rnd() * 2)];
    const h = hr(); const k = Env.st.rain ? "rain" : (h >= 22 || h < 5) ? "night" : (h >= 7 && h < 9.5) ? "morn" : (h >= 10 && h < 16 && !Env.st.rain) ? "fine" : "hello";
    return tkPick(R, TALK[k]);
  }
  function talkTick(dt, m){
    const R = T.ride; if(!R || R.talkN >= 6) return;
    R.talkT -= dt; if(R.talkT > 0) return;
    if(m.v < 2 || T.t - (R.lastDing || -99) < 8){ R.talkT = 3; return; }   // 止まっているとき・ひやっとした直後は話さない
    const line = R.talkN === 0 ? openingLine(R) : chatLine(R, m);
    if(line){ bubble(line); R.talkN++; }
    R.talkT = 25 + rnd() * 25;
  }
  const COMMENTS = { hit: "ぶつかって、びっくりしました…", red: "信号が赤でしたよ！", wrong: "逆走していませんでしたか？", comfort: "急ブレーキ・急ハンドルが怖かったです。", speed: "もう少しゆっくりでお願いしたかったです。", detour: "遠回りされた気がします。", late: "ずいぶん待ちました。" };
  function finishRide(){
    const R = T.ride, fare = meterFare(R), fee = R.fee || 0, base = fare + fee, stars = Math.max(1, Math.min(5, Math.round(R.sat * 10) / 10));
    if(!R.detourDone && R.dist > R.routeM * 1.45 + 500){ R.sat = Math.max(1, R.sat - 0.4); R.events.push("detour"); }
    const st2 = Math.max(1, Math.min(5, Math.round(R.sat * 10) / 10));
    let tip = 0; if(st2 >= 4.5 && rnd() < 0.55){ tip = Math.ceil((base * 1.04) / 100) * 100 - base; if(tip < 20) tip += 100; } else if(st2 >= 4.0 && rnd() < 0.2){ tip = Math.ceil(base / 100) * 100 - base; }
    const sightTip = R.sights && st2 >= 3.5 ? Math.min(300, R.sights * 100) : 0;   // v41.15: 初めての名所を通ったぶん、観光チップ（1 か所 ¥100・最大 ¥300・評価 3.5 以上）
    const tourTip = R.tour ? (st2 >= 4.5 ? 400 : st2 >= 3.5 ? 200 : 0) : 0;   // 観光のお客さんは、評価が高いとお礼がはずむ
    T.money += base; T.tips += tip + sightTip + tourTip; T.rides++; T.rateSum += st2; T.rateN++;
    const worst = ["hit", "red", "wrong", "comfort", "speed", "detour", "late"].find((k) => R.events.includes(k));
    const cm = tk(R, st2 >= 4.8 ? TALK.end.top : st2 >= 4.2 ? TALK.end.good : worst ? TALK.end[worst] : TALK.end.good); bubbleOff();
    const stars5 = "★".repeat(Math.round(st2)) + "☆".repeat(5 - Math.round(st2));
    const rc = $e("txrc");
    rc.innerHTML = '<h4><span>領収書</span><span class="st">' + stars5 + " " + st2.toFixed(1) + "</span></h4>" +
      '<div class="r"><span>' + R.dest.name + " まで</span><span>" + fmtKm(R.dist) + "</span></div>" +
      '<div class="r"><span>運賃' + (R.night ? "（深夜早朝 2 割増）" : "") + "</span><span>" + yen(fare) + "</span></div>" +
      (fee ? '<div class="r"><span>迎車料金</span><span>' + yen(fee) + "</span></div>" : "") + (tip ? '<div class="r"><span>おつりはいらない</span><span>+' + yen(tip) + "</span></div>" : "") + (sightTip ? '<div class="r"><span>観光チップ（名所 ' + R.sights + ' か所）</span><span>+' + yen(sightTip) + "</span></div>" : "") + (tourTip ? '<div class="r"><span>観光案内のお礼</span><span>+' + yen(tourTip) + "</span></div>" : "") +
      '<div class="r tot"><span>合計</span><span>' + yen(base + tip + sightTip + tourTip) + '</span></div><div class="cm">「' + cm + "」</div>";
    rc.classList.add("on"); T.payT = 3.4; T.st = "pay"; T.hold = 0; markerOff(); Nav.clear("auto"); lamp("空車"); Snd.blip("done");
    // お客さんが降りて歩いていく
    const C = Car.C, lx = Math.cos(C.yaw), lz = -Math.sin(C.yaw);
    for(let k = 0; k < R.n; k++){ const p = person(R.dest.name.length * 3 + k * 5); const x0 = C.x + lx * 1.9 + Math.sin(C.yaw) * (-0.8 + k * 0.6), z0 = C.z + lz * 1.9 + Math.cos(C.yaw) * (-0.8 + k * 0.6); p.position.set(x0, Car.hAt(x0, z0), z0); p.rotation.y = Math.atan2(lx, lz); grp.add(p); T.walkers.push({ m: p, vx: lx * 1.3, vz: lz * 1.3, t: 5 }); }
    T.nextCall = Math.min(T.nextCall || 1e9, T.t + 20 + rnd() * 35); if(T.nextCall < T.t + 12) T.nextCall = T.t + 12;
    if(R.tour && R.dest.stamp && !Stamps.got[R.dest.stamp]){ const q = Stamps.byId(R.dest.stamp); if(q) Stamps.collect(q); }   // 敷地まで道が遠い名所（岡山城・後楽園）も、お客さんを降ろしたらスタンプ
    T.ride = null;
    if(!T.goalHit && T.money + T.tips >= FARE.goal){ T.goalHit = true; setTimeout(() => toast("営業目標 " + yen(FARE.goal) + " を達成！ このまま続けても、終了してもOKです", "good", 4.4), 3200); }
  }

  /* ---- 営業の開始・終了 ---- */
  function begin(d0){
    dom(); Rules.reset();
    if(!Nav.POI || !Traffic.ready){ const q = document.getElementById("qtoast"); if(q){ q.textContent = "地点データを読み込み中です。少し待ってからもう一度お試しください"; q.className = "qtoast on bad"; } return false; }
    clean3d(); Object.assign(T, { on: true, st: "cruise", t: 0, money: 0, tips: 0, rides: 0, cancels: 0, passed: 0, full: 0, empty: 0, rateSum: 0, rateN: 0, goalHit: false, call: null, offer: null, ride: null, hold: 0, payT: 0, near: null, nearT: 0, hudT: 0, summary: false, pending: false, walkers: [], stands: [] });
    T.def = d0; Nav.clear();
    setupStands();
    // 出発: 岡山駅 東口の乗り場の脇の車線（なければ初期位置）
    const s0 = T.stands.find((s) => /岡山駅 東口/.test(s.name)) || T.stands[0];
    if(s0){ const ln = laneAt(s0.x, s0.z, 120); if(ln){ const C = Car.C, P = Traffic.segs[ln.i].P, s1 = Math.max(2, ln.s - 55), q = pathPt(P, s1), tg = pathTan(P, s1);   // 乗り場の手前 55m（なるべく前方に乗り場が見える所）から出発
      C.x = q.x; C.z = q.z; C.yaw = Math.atan2(tg.x, tg.z); C.h = Car.hAt(q.x, q.z); C.v = 0; C.gear = "D"; C.wheel = 0; C.hitT = 0; Stuck.reset(); Traffic.reset(); } }
    T.nextCall = 70 + rnd() * 40; lamp("空車");
    $e("txcol").classList.add("on"); $e("txcall").classList.remove("on"); $e("txrc").classList.remove("on");
    $e("tx-goal").textContent = "目標 " + yen(FARE.goal);
    const q = document.getElementById("qfin"); if(q) q.classList.remove("on");
    toast("タクシー営業スタート — 岡山駅 東口の乗り場でお客さんが待っています。光の柱へ", "load", 4.8);
    if(s0) Nav.setTarget({ x: s0.x, z: s0.z, name: s0.name, r: 30, kind: "load" }, "auto", { quiet: true });
    return true;
  }
  function stop(){   // 中断（メニューへ戻る・別のモード）: まとめは出さない
    if(!T.on && !T.summary) return;
    T.on = false; T.st = "idle"; clean3d(); lamp("");
    const c = document.getElementById("txcol"); if(c) c.classList.remove("on"); const r = document.getElementById("txrc"); if(r) r.classList.remove("on");
    const kk = document.querySelector("#qfin .kicker"); if(kk) kk.textContent = "MISSION COMPLETE";
    T.summary = false; T.pending = false; Nav.clear("auto");
  }
  function endShift(){
    if(!T.on) return;
    if(T.st === "ride" || T.st === "pay"){ toast("お客さんを降ろしてから営業を終了してください", "bad"); return; }
    if(T.st === "pick") cancelCall(false);
    const total = T.money + T.tips, hours = Math.max(1 / 60, T.t / 3600), hourly = total / hours, rate = (T.full + T.empty) > 50 ? T.full / (T.full + T.empty) : 0;
    const avg = T.rateN ? T.rateSum / T.rateN : 0;
    const g = !T.rides ? "C" : hourly >= 15000 ? "S" : hourly >= 11000 ? "A" : hourly >= 7000 ? "B" : "C";
    const sv = saved(); sv.total = (sv.total || 0) + total; sv.shifts = (sv.shifts || 0) + 1; sv.rides = (sv.rides || 0) + T.rides; const newBest = total > (sv.best || 0) && T.rides > 0; if(newBest) sv.best = total; if(hourly > (sv.bestHourly || 0) && T.rides > 0) sv.bestHourly = Math.round(hourly); Prefs.setM("taxi", sv);
    T.on = false; T.summary = true; T.pending = true; closeOffer(); clean3d(); lamp(""); Nav.clear("auto");
    $e("txcol").classList.remove("on"); $e("txrc").classList.remove("on");
    const f = (id) => document.getElementById(id);
    f("qf-name").textContent = "タクシー営業 お疲れさまでした"; f("qf-score").textContent = yen(total); f("qf-grade").textContent = g; f("qf-grade").className = "qgrade g" + g;
    const kk = document.querySelector("#qfin .kicker"); if(kk) kk.textContent = "SHIFT END";
    const rows = [["営業時間", fmtT(T.t), ""], ["乗車", T.rides + " 回", T.rides ? "" : "—"], ["運賃・迎車料金", yen(T.money), ""], ["おつりはいらない（チップ）", yen(T.tips), ""],
      ["走行距離", "実車 " + (T.full / 1000).toFixed(1) + " km／空車 " + (T.empty / 1000).toFixed(1) + " km", ""], ["実車率", rate ? Math.round(rate * 100) + " %" : "—", ""],
      ["お客さんの評価（平均）", avg ? "★ " + avg.toFixed(2) : "—", ""], ["時給の目安", T.rides ? yen(hourly) + " /時" : "—", ""], ["見送り・取り消し", T.passed + " 件・" + T.cancels + " 件", ""]];
    f("qf-rows").innerHTML = rows.map((r) => '<div class="qr"><span>' + r[0] + "</span><span>" + r[1] + "</span><b>" + r[2] + "</b></div>").join("");
    f("qf-best").textContent = newBest ? "自己ベスト更新！（これまでの最高 " + yen(sv.best) + "）" : "これまでの最高 " + yen(sv.best || 0) + "・通算 " + sv.shifts + " 回営業・累計 " + yen(sv.total);
    const rt = f("qf-retry"), nw = f("qf-new"); if(rt) rt.firstElementChild.textContent = "もう一度営業する"; if(nw) nw.style.display = "none";
    f("qfin").classList.add("on"); Snd.blip("done");
  }
  function again(){ const d = T.def; document.getElementById("qfin").classList.remove("on"); const kk = document.querySelector("#qfin .kicker"); if(kk) kk.textContent = "MISSION COMPLETE"; T.summary = false; T.pending = false; if(d) begin(d); }

  /* ---- 毎フレーム ---- */
  function tick(dt){
    if(!T.on) return;
    if(S.mode !== "car"){ stop(); return; }
    if(T.toastT > 0){ T.toastT -= dt; if(T.toastT <= 0){ const t = document.getElementById("qtoast"); if(t) t.className = "qtoast"; } }
    if(T.talkShow > 0){ T.talkShow -= dt; if(T.talkShow <= 0){ const b = document.getElementById("txtalk"); if(b) b.classList.remove("on"); } }
    T.t += dt; const m = me(); standTick(dt);
    for(let i = T.walkers.length - 1; i >= 0; i--){ const w = T.walkers[i]; w.t -= dt; w.m.position.x += w.vx * dt; w.m.position.z += w.vz * dt; w.m.position.y = Car.hAt(w.m.position.x, w.m.position.z); if(w.t <= 0){ grp.remove(w.m); T.walkers.splice(i, 1); } }
    if(mk && mk.g.visible){ const k = performance.now() / 1000, p = 0.6 + 0.4 * Math.sin(k * 3.2); mk.beam.material.opacity = 0.28 + 0.2 * p; mk.ring.material.opacity = 0.6 + 0.35 * p; }
    if(T.st === "ride" && T.ride){ const R = T.ride; R.dist += m.v * dt; T.full += m.v * dt; if(m.v < FARE.slowV) R.slowT += dt; } else T.empty += m.v * dt;
    if(T.st === "pay"){ T.payT -= dt; if(T.payT <= 0){ T.st = "cruise"; $e("txrc").classList.remove("on"); } }
    // 依頼の受付
    if(T.offer){ T.offer.left -= dt; $e("txc-bar").style.width = Math.max(0, T.offer.left / 20 * 100) + "%"; if(T.offer.left <= 0){ closeOffer(); T.passed++; T.nextCall = T.t + 20 + rnd() * 40; toast("依頼は他の車へ回りました", ""); } }
    else if(T.st === "cruise" && T.t >= T.nextCall && !T.offer){ if(T.t < 5) T.nextCall = T.t + 5; else { offerCall(); if(!T.offer) T.nextCall = T.t + 15; else T.nextCall = T.t + 30 + rnd() * 50 / Math.max(0.6, tf(hr())); } }
    // 迎車中: 待ち時間の上限
    if(T.st === "pick" && T.call){
      const c = T.call; if(T.t - c.t0 > c.limit){ cancelCall(true); }
      else { const d = Math.hypot(c.x - m.x, c.z - m.z); if(d < c.r && m.v < 1.3){ T.hold += dt; if(T.hold >= 1.4) boardCall(); } else T.hold = Math.max(0, T.hold - dt * 1.5); }
    }
    // 空車: 乗り場で乗せる
    else if(T.st === "cruise"){
      let hit = null; for(const s of T.stands){ if(s.q.length && (s.dist < (s.w >= 3 ? 24 : 18) || s.dc < 9)){ if(!hit || s.dist < hit.dist) hit = s; } }
      if(hit && m.v < 1.3){ T.hold += dt; if(T.hold >= 1.4){ T.hold = 0; boardStand(hit); } } else T.hold = Math.max(0, T.hold - dt * 1.5);
    }
    // 賃走: 到着・満足度
    if(T.st === "ride" && T.ride){
      const R = T.ride, d = Math.hypot(R.dest.x - m.x, R.dest.z - m.z);
      if(!R.routeM && Nav.route){ R.routeM = Nav.route.total; }
      if(d < R.dest.r && m.v < 1.3){ T.hold += dt; if(T.hold >= 1.4) finishRide(); } else T.hold = Math.max(0, T.hold - dt * 1.5);
      if(T.st === "ride"){
        const C = Car.C;
        if(C.hitT > 1.0 && !T.lastHit){ ding(1.0, "衝突！ お客さんがおどろいている", "hit"); } T.lastHit = C.hitT > 1.0;
        const cmf = Car.P.cmf || { acc: 4.6, lat: 4.6 };
        if(m.v > 0.5 && (Math.abs(C.accF || 0) > cmf.acc || (C.latF || 0) > cmf.lat) && T.comfortT <= 0){ ding(0.3, (Math.abs(C.accF || 0) > cmf.acc ? "急ブレーキ・急発進" : "急ハンドル") + "でお客さんが驚いた", "comfort"); T.comfortT = 4; } T.comfortT = Math.max(0, T.comfortT - dt);
        const L = Loc.last, lim = L && L.v; if(lim && m.v * 3.6 > lim + SPEED_OVER_OK){ T.speedAcc += dt; if(T.speedAcc > 3 && T.speedT <= 0){ ding(0.3, "制限速度 " + lim + " km/h を超えています", "speed"); T.speedT = 12; } } else T.speedAcc = Math.max(0, T.speedAcc - dt);
        T.speedT = Math.max(0, T.speedT - dt);
        talkTick(dt, m);   // v41.15: お客さんの会話
      }
    }
    T.hudT -= dt; if(T.hudT <= 0){ T.hudT = 0.15; hud(m); }
  }
  Rules.on((kind) => { if(!T.on || T.st !== "ride" || !T.ride) return; if(kind === "red") ding(1.0, "信号無視！ お客さんが怒っています", "red"); else if(kind === "wrong") ding(0.5, "逆走です！", "wrong"); });

  function hud(m){
    dom(); const st = T.st, R = T.ride, c = T.call;
    const b = $e("tx-badge"); b.textContent = st === "ride" ? "賃走" : st === "pick" ? "迎車" : st === "pay" ? "精算" : "空車"; b.className = "tx-badge " + (st === "ride" ? "ride" : st === "pick" ? "pick" : st === "pay" ? "pay" : "");
    const total = T.money + T.tips; $e("tx-money").textContent = yen(total); $e("tx-gbar").style.width = Math.min(100, total / FARE.goal * 100) + "%";
    let info = "";
    if(st === "ride" && R){ const rd = Nav.target ? Nav.remDist() : Math.hypot(R.dest.x - m.x, R.dest.z - m.z); info = "<b>" + R.dest.name + "</b> まで　あと " + fmtKm(rd) + "<br>満足度 " + "★".repeat(Math.round(R.sat)) + "☆".repeat(5 - Math.round(R.sat)); }
    else if(st === "pick" && c){ const left = c.limit - (T.t - c.t0), d = Nav.target ? Nav.remDist() : Math.hypot(c.x - m.x, c.z - m.z); info = "迎車: <b>" + c.name + "</b><br>あと " + fmtKm(d) + "　お客さんが待ってくれるのはあと " + fmtT(left); }
    else if(st === "pay") info = "お会計中…";
    else { const n = T.near; info = n ? "空車 — 近くの乗り場にお客さん: <b>" + n.name.replace(" タクシー乗り場", "") + "</b>（" + standCount(n.i) + " 人・" + fmtKm(n.dist) + "）" : "空車 — 街を流して、乗り場や配車依頼を待つ"; }
    $e("tx-info").innerHTML = info;
    const mt = $e("tx-meter"); mt.classList.toggle("on", st === "ride" || st === "pay");
    if(R){ $e("tx-fare").textContent = yen(meterFare(R) + (R.fee || 0)); $e("tx-msub").innerHTML = fmtKm(R.dist) + "<br>" + (R.slowT >= 1 ? "時間 " + fmtT(R.slowT) : "") + (R.night ? " 深夜割増" : "") + (R.fee ? " 迎車込み" : ""); }
    $e("tx-go").style.display = st === "cruise" && T.near && (!Nav.target || Nav.src !== "user") ? "" : "none";
    $e("tx-cancel").style.display = st === "pick" ? "" : "none";
    $e("tx-rides").textContent = T.rides; $e("tx-rate").textContent = (T.full + T.empty) > 50 ? Math.round(T.full / (T.full + T.empty) * 100) + "%" : "--"; $e("tx-star").textContent = T.rateN ? "★" + (T.rateSum / T.rateN).toFixed(1) : "--";
  }
  /* ナビ・ミニマップ用の点 */
  function mapPts(){
    if(!T.on) return []; const out = [], m = me();
    for(const s of T.stands) if(s.q.length && s.dist < 3000) out.push({ x: s.x, z: s.z, kind: "stand", d: s.dist });
    out.sort((a, b) => a.d - b.d); const r = out.slice(0, 5);
    if(T.call) r.push({ x: T.call.x, z: T.call.z, kind: "load" }); if(T.ride) r.push({ x: T.ride.dest.x, z: T.ride.dest.z, kind: "drop" });
    return r;
  }
  return { begin, stop, tick, again, endShift, mapPts, standCount, bestText, FARE, meterFare, T, get on(){ return T.on; }, get pending(){ return T.pending; }, accept, decline };
})();


/* ---------------- v38: ナビ地図（車・ヘリ）----------------
   走行位置のまわりを、データから描く: 道路（PLATEAU の車道の升目・山陽道）、建物（PLATEAU の建物の升目）、水面（水位の格子）、
   線路（JR・新幹線・路面電車）、陰影（標高）。進行方向を上にして回転（「⌖」で北を上にも切替）。拡大・縮小は「＋」「－」か ] [ キー。
   位置の表示は緯度・経度（データの原点 = 岡山駅前駅 34.66551°N 133.91968°E からの距離を平面近似で換算。おおよその値）。 */
const NaviMap = (() => {
  const LAT0 = 34.66551, LON0 = 133.91968, KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KZ = 110540;
  const root = $("navi"), cv = $("navi-cv"), g = cv.getContext("2d"), llEl = $("navi-ll"), rdEl = $("navi-rd");
  const N = 320, VIEW = 256;                      // 元画像の 1 辺・画面に出す直径（どちらもサンプル数）
  const base = document.createElement("canvas"); base.width = base.height = N; const bg = base.getContext("2d");
  const win = document.createElement("canvas"); win.width = win.height = N; const wg = win.getContext("2d"), img = wg.createImageData(N, N), px = new Uint32Array(img.data.buffer);
  const HS = 64, hsC = document.createElement("canvas"); hsC.width = hsC.height = HS + 1; const hg = hsC.getContext("2d"), himg = hg.createImageData(HS + 1, HS + 1), hpx = new Uint32Array(himg.data.buffer);
  const ZOOMS = [1.5, 3, 6, 12, 24, 48];
  let zi = 1, northUp = false, on = false, cache = null, lastMode = "", manualT = 0, zWant = 1, zT = 0;
  const rgba = (r, gg, b, a) => ((a << 24) | (b << 16) | (gg << 8) | r) >>> 0;
  const C_ROAD = rgba(255, 255, 255, 255), C_SIDE = rgba(236, 231, 218, 255), C_BLD = rgba(176, 168, 154, 255), C_WATER = rgba(135, 187, 228, 255), C_NONE = 0;
  const hAtG = (x, z) => Heli.groundAt(x, z, -50);          // 橋の下の地面（下の段）の高さ
  function renderBase(cx, cz, mpp){
    const G = Car.G, Wl = S._WL, sub = mpp <= 3 ? 1 : mpp <= 6 ? 2 : 3, n2 = sub * sub, half = N / 2;
    // 1) 陰影（粗い格子の標高から）
    const sp = N * mpp / HS; const Hc = new Float32Array((HS + 3) * (HS + 3));
    for(let j = 0; j < HS + 3; j++) for(let i = 0; i < HS + 3; i++) Hc[j * (HS + 3) + i] = hAtG(cx - half * mpp + (i - 1) * sp, cz - half * mpp + (j - 1) * sp);
    for(let j = 0; j <= HS; j++) for(let i = 0; i <= HS; i++){
      const a = (j + 1) * (HS + 3) + i + 1, h = Hc[a], dx = (Hc[a + 1] - Hc[a - 1]) / (2 * sp), dz = (Hc[a + HS + 3] - Hc[a - HS - 3]) / (2 * sp);
      const ex = mpp < 8 ? 3 : 1.6, sh = Math.max(-0.6, Math.min(0.6, (dx * 0.55 + dz * 0.75) * ex * 6)), hh = Math.max(0, Math.min(1, h / 500));
      const r = 214 + 22 * hh - sh * 70, gg = 222 - 6 * hh - sh * 62, b = 196 - 10 * hh - sh * 66;
      hpx[j * (HS + 1) + i] = rgba(Math.max(0, Math.min(255, r)) | 0, Math.max(0, Math.min(255, gg)) | 0, Math.max(0, Math.min(255, b)) | 0, 255);
    }
    hg.putImageData(himg, 0, 0);
    // 2) 道路・建物・水（2m の升目から）
    for(let j = 0; j < N; j++){
      for(let i = 0; i < N; i++){
        let road = 0, bld = 0, wat = 0, side = 0;
        for(let sj = 0; sj < sub; sj++) for(let si = 0; si < sub; si++){
          const x = cx + (i - half + (si + 0.5) / sub) * mpp, z = cz + (j - half + (sj + 0.5) / sub) * mpp;
          if(G){
            const ci = Math.floor((x - G.x0) / G.step), cj = Math.floor((z - G.z0) / G.step);
            if(ci >= 0 && cj >= 0 && ci < G.nx && cj < G.nz){
              const k = cj * G.nx + ci, kd = G.K[k];
              if(kd === 1) road++; else if(kd === 9) bld++; else if(kd > 0) side++;
              if(Wl && kd === 0){ const wi = Math.round((x - Wl.x0) / Wl.step), wj = Math.round((z - Wl.z0) / Wl.step);
                if(wi >= 0 && wj >= 0 && wi < Wl.nx && wj < Wl.nz){ const v = Wl.A[wj * Wl.nx + wi]; if(v !== -32768 && v > G.H[k] + 30) wat++; } }
            }
          }
        }
        px[j * N + i] = road ? C_ROAD : bld * 2 >= n2 ? C_BLD : wat * 2 >= n2 ? C_WATER : side ? C_SIDE : C_NONE;
      }
    }
    wg.putImageData(img, 0, 0);
    bg.clearRect(0, 0, N, N); bg.fillStyle = "#d8d3c2"; bg.fillRect(0, 0, N, N);
    bg.imageSmoothingEnabled = true; bg.drawImage(hsC, 0.5, 0.5, HS, HS, 0, 0, N, N);
    // 道路の縁（建物・歩道と区別するための薄い影）: 道路画素のまわりを暗く
    bg.drawImage(win, 0, 0);
    // 3) 線（山陽道・線路・路面電車）
    const W2S = (x, z) => [(x - cx) / mpp + half, (z - cz) / mpp + half];
    const x0 = cx - (half + 8) * mpp, x1 = cx + (half + 8) * mpp, z0 = cz - (half + 8) * mpp, z1 = cz + (half + 8) * mpp;
    const stroke = (arrX, arrZ, nPts, step, col, lw, dash) => {
      bg.strokeStyle = col; bg.lineWidth = lw; bg.setLineDash(dash || []); bg.beginPath(); let pen = false;
      for(let i = 0; i < nPts; i += step){ const x = arrX(i), z = arrZ(i); if(x < x0 || x > x1 || z < z0 || z > z1){ pen = false; continue; } const q = W2S(x, z); if(pen) bg.lineTo(q[0], q[1]); else { bg.moveTo(q[0], q[1]); pen = true; } }
      bg.stroke(); bg.setLineDash([]);
    };
    const lw = (m) => Math.max(1.2, m / mpp);
    try{
      if(MW.ready) for(const c of MW.chains){ if(c.kind !== "main" && c.lanes < 2) { /* ランプ */ }
        const stp = Math.max(1, Math.round(mpp / 5)); stroke(i => c.X[i], i => c.Z[i], c.n, stp, c.kind === "main" ? "#e29a2e" : "#e8b866", lw(c.kind === "main" ? 14 : 7)); }
      if(JR.ready) for(const L of JR.lines){ const stp = Math.max(1, Math.round(mpp / 2));
        stroke(i => L.p[3 * i], i => L.p[3 * i + 2], L.n, stp, L.hs ? "#2a62b5" : "#5a5750", lw(L.hs ? 7 : 4)); }
      for(const k in S.routes){ const r = S.routes[k]; if(!r || !r.track) continue; const stp = Math.max(1, Math.round(mpp / 3));
        stroke(i => r.track[i][0], i => r.track[i][2], r.track.length, stp, "#b3407a", lw(5)); }
    }catch(e){}
    cache = { x: cx, z: cz, mpp };
  }
  function niceLen(mpp){ const target = 70 * mpp / (VIEW / 220 * 1.0) / (cv.width / 220); const opts = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]; let best = opts[0]; for(const o of opts) if(o / mpp * (cv.width / VIEW) <= cv.width * 0.34) best = o; return best; }
  function src(){ return S.mode === "heli" ? { x: Heli.H.x, z: Heli.H.z, yaw: Heli.H.yaw } : { x: Car.C.x, z: Car.C.z, yaw: Car.C.yaw }; }
  function draw(p){
    const D = cv.width, R = D / 2, mpp = ZOOMS[zi], k = D / VIEW;
    g.clearRect(0, 0, D, D); g.save(); g.beginPath(); g.arc(R, R, R - 3, 0, Math.PI * 2); g.clip();
    g.fillStyle = "#cfcab8"; g.fillRect(0, 0, D, D);
    const a = northUp ? 0 : p.yaw + Math.PI;
    g.translate(R, R); g.rotate(a); g.scale(k, k); g.imageSmoothingEnabled = true;
    g.drawImage(base, -N / 2 + (cache.x - p.x) / mpp, -N / 2 + (cache.z - p.z) / mpp);
    { const rp = S.mode === "car" ? Nav.mapPoly(Math.max(1500, mpp * 220)) : null;   // v41.10: ナビの経路（青い線）  v41.11: 太く・矢じり・次の曲がり角
      if(rp && rp.length > 3){ g.lineCap = "round"; g.lineJoin = "round";
        for(const pass of [[10 / k, "rgba(255,255,255,.97)"], [6.4 / k, "#1c6df0"]]){ g.strokeStyle = pass[1]; g.lineWidth = pass[0]; g.beginPath(); g.moveTo((rp[0] - p.x) / mpp, (rp[1] - p.z) / mpp); for(let i = 2; i < rp.length; i += 2) g.lineTo((rp[i] - p.x) / mpp, (rp[i + 1] - p.z) / mpp); g.stroke(); }
        g.strokeStyle = "rgba(255,255,255,.96)"; g.lineWidth = 1.9 / k; const gap = 30 / k, sz2 = 3.1 / k; let acc2 = gap * 0.6;
        for(let i = 2; i < rp.length; i += 2){ const x0 = (rp[i - 2] - p.x) / mpp, y0 = (rp[i - 1] - p.z) / mpp, x1 = (rp[i] - p.x) / mpp, y1 = (rp[i + 1] - p.z) / mpp, L = Math.hypot(x1 - x0, y1 - y0); if(L < 1e-6) continue;
          const ux = (x1 - x0) / L, uy = (y1 - y0) / L; let t = acc2; while(t < L){ const cx = x0 + ux * t, cy = y0 + uy * t; g.beginPath(); g.moveTo(cx - ux * sz2 * 1.4 - uy * sz2, cy - uy * sz2 * 1.4 + ux * sz2); g.lineTo(cx + ux * sz2 * 0.5, cy + uy * sz2 * 0.5); g.lineTo(cx - ux * sz2 * 1.4 + uy * sz2, cy - uy * sz2 * 1.4 - ux * sz2); g.stroke(); t += gap; } acc2 = t - L; }
        const np = Nav.nextPoint(); if(np && np.type !== "arrive"){ g.beginPath(); g.arc((np.x - p.x) / mpp, (np.z - p.z) / mpp, 7.5 / k, 0, 7); g.fillStyle = "#fff"; g.fill(); g.lineWidth = 3 / k; g.strokeStyle = "#e8532b"; g.stroke(); } } }
    g.restore();
    // v41.7: ミッションの目的地（円の外ならふちに三角で方向を示す）
    const nt = S.mode === "car" && Nav.target && Nav.src === "user" ? [{ x: Nav.target.x, z: Nav.target.z, kind: "nav" }] : [];
    for(const q of Quest.mapPts().concat(nt, Taxi.mapPts())){
      const sx = (q.x - p.x) / mpp * k, sz = (q.z - p.z) / mpp * k, ca = Math.cos(a), sa = Math.sin(a);
      let X = sx * ca - sz * sa, Y = sx * sa + sz * ca; const dist = Math.hypot(X, Y), lim = R - 20; let edge = false; if(dist > lim){ X *= lim / dist; Y *= lim / dist; edge = true; }
      const col = q.kind === "load" ? "#35d0ff" : q.kind === "drop" ? "#ffb02e" : q.kind === "nav" ? "#ff3d8b" : q.kind === "stand" ? "#f2c230" : "#7dff9a";
      g.save(); g.translate(R + X, R + Y);
      if(edge){ g.rotate(Math.atan2(Y, X) + Math.PI / 2); g.beginPath(); g.moveTo(0, -11); g.lineTo(9, 7); g.lineTo(-9, 7); g.closePath(); g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = "#1a1408"; g.stroke(); }
      else { g.beginPath(); g.arc(0, 0, 10, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.lineWidth = 3; g.strokeStyle = "#fff"; g.stroke(); g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.fillStyle = "#1a1408"; g.fill(); }
      g.restore();
    }
    // 自車の矢印（進行方向を上。北固定の時は回転）
    g.save(); g.translate(R, R); g.rotate(northUp ? -(p.yaw + Math.PI) : 0);
    g.beginPath(); g.moveTo(0, -R * 0.1); g.lineTo(R * 0.065, R * 0.07); g.lineTo(0, R * 0.035); g.lineTo(-R * 0.065, R * 0.07); g.closePath();
    g.fillStyle = "#f0a020"; g.fill(); g.lineWidth = 2; g.strokeStyle = "#241a08"; g.stroke(); g.restore();
    // 方位（N）・縮尺・枠
    const nx = Math.sin(a), ny = -Math.cos(a); g.save(); g.fillStyle = "#c0392b"; g.font = "bold " + Math.round(D * 0.07) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.beginPath(); g.arc(R + nx * (R - 18), R + ny * (R - 18), 11, 0, 7); g.fillStyle = "rgba(255,255,255,.9)"; g.fill(); g.fillStyle = "#c0392b"; g.fillText("N", R + nx * (R - 18), R + ny * (R - 17)); g.restore();
    const len = niceLen(mpp), lpx = len / mpp * k; g.save(); g.translate(R - lpx / 2, D - 26); g.fillStyle = "rgba(20,16,10,.8)"; g.fillRect(-6, -14, lpx + 12, 26);
    g.strokeStyle = "#fff"; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 2); g.lineTo(0, 8); g.lineTo(lpx, 8); g.lineTo(lpx, 2); g.stroke(); g.fillStyle = "#fff"; g.font = "bold " + Math.round(D * 0.052) + "px sans-serif"; g.textAlign = "center"; g.fillText(len >= 1000 ? (len / 1000) + " km" : len + " m", lpx / 2, -3); g.restore();
  }
  function update(dt){
    const act = (S.mode === "car" && Car.C.active) || (S.mode === "heli" && Heli.H.active);
    if(act !== on){ on = act; root.classList.toggle("on", on); if(on) cache = null; }
    if(!on) return;
    if(S.mode !== lastMode){ lastMode = S.mode; zi = S.mode === "heli" ? 3 : 1; cache = null; }
    // v41.11: ナビ中は、次の曲がり角が近いほど拡大（140m 以内→細かく／420m 以内→ふつう／それ以外→広く）。手で拡大・縮小したら 25 秒は手動
    if(S.mode === "car" && Nav.active && Nav.route && performance.now() > manualT){
      const np = Nav.nextPoint(); let want = !np || np.d >= 420 ? 2 : np.d < 140 ? 0 : 1; if(Car.C.v > 22 && want === 2 && (!np || np.d > 1500)) want = 3;
      if(want !== zi){ if(want !== zWant){ zWant = want; zT = 0; } zT += dt; if(zT > 1.2){ zi = want; cache = null; zT = 0; } } else { zWant = zi; zT = 0; } }
    const p = src(), mpp = ZOOMS[zi];
    if(!Car.G) return;
    if(!cache || cache.mpp !== mpp || Math.hypot(p.x - cache.x, p.z - cache.z) > 26 * mpp){ renderBase(p.x, p.z, mpp); }
    draw(p);
    // 位置（緯度・経度）と道路名
    const lat = LAT0 - p.z / KZ, lon = LON0 + p.x / KX;
    llEl.textContent = lat.toFixed(5) + "°N  " + lon.toFixed(5) + "°E";
    const L = Loc.last || {}; let t = "";
    if(S.mode === "heli") t = ((L.ward || "") + " " + (L.town || "")).trim() || "上空"; else t = L.bridge || L.road || ((L.ward || "") + " " + (L.town || "")).trim() || "";
    rdEl.textContent = t + (S.mode === "car" && L.v ? "　制限 " + L.v + " km/h" : "");
  }
  const zoom = (d) => { zi = Math.max(0, Math.min(ZOOMS.length - 1, zi + d)); cache = null; manualT = performance.now() + 25000; };
  $("navi-zi").addEventListener("click", () => zoom(-1)); $("navi-zo").addEventListener("click", () => zoom(1));
  $("navi-rot").addEventListener("click", () => { northUp = !northUp; $("navi-rot").classList.toggle("on", northUp); });
  cv.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? -1 : 1); }, { passive: false });
  addEventListener("keydown", (e) => { if(!on || typing()) return; if(e.key === "]") zoom(-1); else if(e.key === "[") zoom(1); });
  return { update, zoom, get on(){ return on; }, get zoomIndex(){ return zi; }, stats(){ const G = Car.G; const h = new Array(16).fill(0); if(G) for(let i = 0; i < G.K.length; i += 97) h[G.K[i] & 15]++; return h; } };
})();

/* ---------------- v41.7: ミッション（配達・搬送・名所めぐり）----------------
   ヘリ・車（乗用車／トラック）で「目的地へ行って → 荷物を積む／降ろす」を順にこなす。自由に操縦するモードはそのまま残してあり、
   メニューの「あそびかた」でミッション／自由を選ぶ。走行中でも「中止」で自由走行に切り替えられる。
   地点は実在の場所（OSM の停留場・PLATEAU/OSM のランドマーク。座標は x=東・z=南、岡山駅前が原点）。荷物・患者・客は架空の設定。
   採点: 1000 点から 遅れ（目安時間を超えた分）・衝突・ハードランディング・乗り心地・速度超過 を引き、ソフトランディングや「ぴたり」を足す。 */
const Quest = (() => {
  const PL = {
    eki:       { name: "岡山駅 東口", x: -85, z: 36 },
    ekimae:    { name: "岡山駅前", x: 192, z: -20 },
    nishikawa: { name: "西川緑道公園", x: 331, z: -8 },
    yanagawa:  { name: "柳川", x: 575, z: -16 },
    jouge:     { name: "城下", x: 939, z: -17 },
    ntt:       { name: "NTT岡山前", x: 619, z: 254 },
    kenchodori:{ name: "県庁通り", x: 988, z: 331 },
    tenmaya:   { name: "天満屋", x: 808, z: 406 },
    chugin:    { name: "中銀前", x: 1043, z: 349 },
    kencho:    { name: "県庁前", x: 1355, z: 359 },
    harenowa:  { name: "ハレノワ前", x: 996, z: 777 },
    kobashi:   { name: "小橋", x: 1530, z: 865 },
    kyoukyo:   { name: "古京", x: 1910, z: 576 },
    higashiyama:{ name: "東山", x: 2105, z: 1024 },
    seikibashi:{ name: "清輝橋", x: 559, z: 1518 },
    castle:    { name: "岡山城", x: 1498, z: 35 },
    korakuen:  { name: "後楽園", x: 1513, z: -172 },
    orient:    { name: "オリエント美術館", x: 958, z: -96 },
    kawasaki:  { name: "川崎医科大学総合医療センター", x: 740, z: 604 },
  };
  // 停止して行う地点（kind: load=積む・乗せる / drop=降ろす・届ける / pass=くぐる）
  const st_ = (k, kind, verb, o) => Object.assign({ key: k, kind, verb }, PL[k], o || {});
  const COURSES = [
    { id: "heli_parcel", mode: "heli", name: "宅配ヘリ", star: 1, cargo: "荷物", start: "station", pod: 0xf08a1c, gen: "heli",
      blurb: "岡山駅から飛び立ち、配送センターの敷地に着陸して荷物を積み、街の広場 3 か所へ届ける。毎回ちがう組み合わせ。",
      stops: [ st_("eki", "load", "荷物を積む", { r: 32 }), st_("tenmaya", "drop", "届ける", { r: 36 }), st_("kencho", "drop", "届ける", { r: 36 }), st_("castle", "drop", "届ける", { r: 42 }) ] },
    { id: "heli_rescue", mode: "heli", name: "急患搬送", star: 2, cargo: "患者さん", start: "castle", pod: 0xe9eef2, gentle: true,
      blurb: "後楽園で患者さんを乗せ、病院へ。時間との勝負 — でも着陸はそっと。",
      stops: [ st_("korakuen", "load", "患者さんを乗せる", { r: 40 }), st_("kawasaki", "drop", "病院へ送り届ける", { r: 38 }) ] },
    { id: "heli_rings", mode: "heli", name: "名所めぐり", star: 2, cargo: "", start: "station",
      blurb: "空に浮かぶ輪をくぐって、岡山の名所を一周する。着陸は不要。",
      stops: [ st_("eki", "pass", "輪をくぐる", { r: 55, agl: 90 }), st_("orient", "pass", "輪をくぐる", { r: 55, agl: 110 }), st_("korakuen", "pass", "輪をくぐる", { r: 55, agl: 110 }),
               st_("castle", "pass", "輪をくぐる", { r: 55, agl: 120 }), st_("kencho", "pass", "輪をくぐる", { r: 55, agl: 110 }), st_("higashiyama", "pass", "輪をくぐる", { r: 55, agl: 110 }) ] },
    { id: "car_taxi", mode: "car", veh: "sedan", name: "タクシー送迎", star: 1, cargo: "お客さん", comfortK: 5, gen: "taxi",
      blurb: "駐車場を出て、お客さんの家の前で乗せて送り届ける。毎回ちがう場所。急発進・急ブレーキ・急ハンドルは減点（曲がる前に減速すれば大丈夫）。",
      stops: [ st_("ekimae", "load", "お客さんを乗せる", { r: 13 }), st_("kencho", "drop", "お客さんを降ろす", { r: 13 }), st_("chugin", "load", "次のお客さんを乗せる", { r: 13 }), st_("higashiyama", "drop", "お客さんを降ろす", { r: 13 }) ] },
    { id: "car_taxishift", mode: "car", veh: "sedan", name: "タクシー営業", star: 2, cargo: "お客さん", shift: true, stops: [],
      blurb: "岡山駅 東口の乗り場から出発。街を流して、乗り場で待つお客さんを乗せたり、無線の配車依頼を受けたりして、メーター運賃で売上を稼ぐ。終わる時は「営業終了」。" },
    { id: "car_check", mode: "car", veh: "sedan", name: "街角チェックポイント", star: 1, cargo: "", gen: "check",
      blurb: "駐車場を出て、幹線道路に置かれたチェックポイントを順に通過するタイムアタック。毎回ちがうコース。",
      stops: [ st_("nishikawa", "pass", "通過", { r: 14 }), st_("yanagawa", "pass", "通過", { r: 14 }), st_("jouge", "pass", "通過", { r: 14 }), st_("kenchodori", "pass", "通過", { r: 14 }),
               st_("tenmaya", "pass", "通過", { r: 14 }), st_("ntt", "pass", "通過", { r: 14 }), st_("ekimae", "pass", "通過", { r: 14 }) ] },
    { id: "truck_parcel", mode: "car", veh: "truck", name: "宅配トラック", star: 1, cargo: "荷物", comfortK: 3, gen: "truck",
      blurb: "駐車場を出て、配送センターで荷物を積み、住宅街の路地や家の前へ 4〜6 件届ける。毎回ちがう配達先。荷物が揺れる急ブレーキ・急ハンドルは減点。",
      stops: [ st_("ekimae", "load", "荷物を積む", { r: 13 }), st_("yanagawa", "drop", "届ける", { r: 13 }), st_("ntt", "drop", "届ける", { r: 13 }), st_("tenmaya", "drop", "届ける", { r: 13 }), st_("chugin", "drop", "届ける", { r: 13 }) ] },
    { id: "truck_far", mode: "car", veh: "truck", name: "長距離配達", star: 3, cargo: "荷物", comfortK: 3, gen: "truckfar",
      blurb: "配送センターで積み、市内の遠い住宅街 4 件へ。道を選んで効率よく回る。毎回ちがう配達先。",
      stops: [ st_("ekimae", "load", "荷物を積む", { r: 13 }), st_("kyoukyo", "drop", "届ける", { r: 13 }), st_("higashiyama", "drop", "届ける", { r: 13 }), st_("seikibashi", "drop", "届ける", { r: 13 }) ] },
  ];
  const Q = { on: false, done: false, def: null, i: 0, t: 0, hold: 0, loaded: false, hits: 0, pen: null, bonus: null, stops: [], parT: 0, lastHit: false, comfortT: 0, speedT: 0, tdSeen: 0, log: [], toastT: 0 };
  const sel = { heli: "heli_parcel", car: "car_taxi" };
  const heliMode = () => Q.def && Q.def.mode === "heli";
  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const list = (mode, veh) => COURSES.filter((c) => c.mode === mode && (!veh || !c.veh || c.veh === veh));
  const def = (id) => COURSES.find((c) => c.id === id);

  /* ---- 道路への吸着（車の地点: 一番近い車道の升目へ） ---- */
  function snapRoad(x, z){
    if(!Car.G) return { x, z, ok: false };
    let best = null, bd = 1e18;
    for(let r = 0; r <= 80; r += 2){
      const n = Math.max(1, Math.round(r / 2.5) * 4);
      for(let a = 0; a < n; a++){ const t = a / n * Math.PI * 2, px = x + Math.cos(t) * r, pz = z + Math.sin(t) * r;
        if(Car.kindAt(px, pz) === 1 && !Car.blocked(px, pz)){ const d = r; if(d < bd){ bd = d; best = { x: px, z: pz, ok: true, d }; } } }
      if(best) break;
    }
    return best || { x, z, ok: false };
  }

  /* ---- v41.8: 自動生成ミッション（配送センター・駐車場・路地・家の前）----
     data/missions.json は tools/pipeline/mission_sites.py が、土地利用・建物・道路網から検出した「それらしい場所」。実在の配送センター・駐車場ではない。
     開始のたびに 駐車場（出発）→ 配送センター（積み込み）→ 路地・家の前（配達）を組み合わせる。同じ組み合わせにならないよう、毎回乱数で選ぶ（もう一度は同じ内容）。 */
  let SITES = null;
  getJSON("data/missions.json").then((j) => {
    SITES = { towns: j.towns,
      drop: j.drop.map((a) => ({ x: a[0], z: a[1], yaw: a[2], typ: a[3], town: a[4], rw: a[5] / 10, side: a[6], y: a[7] })),
      depot: j.depot.map((a) => ({ bx: a[0], bz: a[1], ux: a[2], uz: a[3], dx: a[4], dz: a[5], gx: a[6], gz: a[7], town: a[8], y: a[10] })),
      park: j.park.map((a) => ({ x: a[0], z: a[1], yaw: a[2], gx: a[3], gz: a[4], town: a[5], r: a[6], y: a[8] })),
      heli: j.heli.map((a) => ({ x: a[0], z: a[1], r: a[2], town: a[3], y: a[4] })) };
  }).catch(() => { SITES = null; });
  const KJ = "〇一二三四五六七八九";
  const town = (i) => { const n = (SITES && SITES.towns[i]) || "住宅街"; const m = /^(.*\D)(\d)$/.exec(n); return m ? m[1] + KJ[+m[2]] + "丁目" : n; };   // 「津島東4」→「津島東四丁目」
  function rngOf(seed){ let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const dd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const choice = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
  /* 駅前から近い順に重みを付けず、条件に合う地点から無作為に選ぶ。前の地点から遠すぎ・近すぎない・互いに 200m 以上離れた所を順につなぐ */
  function chain(pool, start, n, lo, hi, rnd, alleyP){
    const picks = []; let cur = start;
    for(let k = 0; k < n; k++){
      const far200 = (s) => picks.every((p) => dd(p, s) > 200);
      let c = pool.filter((s) => { const q = dd(s, cur); return q > lo && q < hi && far200(s); });
      if(!c.length) c = pool.filter((s) => { const q = dd(s, cur); return q > lo * 0.5 && q < hi * 1.6 && far200(s); });
      if(!c.length) c = pool.filter(far200);
      if(!c.length) break;
      const c3 = c.filter((s) => !picks.some((p) => p.town === s.town)); if(c3.length >= 3) c = c3;   // なるべく別の町へ
      if(alleyP !== undefined){ const want = rnd() < alleyP, c2 = c.filter((s) => (s.typ === 0) === want); if(c2.length) c = c2; }
      const s = choice(c, rnd); picks.push(s); cur = s;
    }
    return picks;
  }
  /* 駐車場の中心から出入口まで、車幅（左右 1m）ぶん塞がれていないか */
  const parkOk = (p) => { const L = Math.hypot(p.gx - p.x, p.gz - p.z) || 1, n = Math.max(2, Math.ceil(L)), nx = -(p.gz - p.z) / L, nz = (p.gx - p.x) / L;
    for(let i = 0; i <= n; i++){ const x = p.x + (p.gx - p.x) * i / n, z = p.z + (p.gz - p.z) * i / n; for(const o of [-1, 0, 1]) if(Car.blocked(x + nx * o, z + nz * o)) return false; } return true; };
  function genTruck(far, rnd){
    const deps = SITES.depot.filter((s) => Math.hypot(s.bx, s.bz) < 5000);
    for(let tries = 0; tries < 80 && deps.length; tries++){
      const dep = choice(deps, rnd), dock = { x: dep.dx, z: dep.dz };
      const parks = SITES.park.filter((p) => { const k = dd(p, dock); return k > 120 && k < 650 && p.r >= 6.5 && parkOk(p); });
      if(!parks.length) continue;
      const park = choice(parks, rnd), n = far ? 4 : 4 + Math.floor(rnd() * 2), rmin = far ? 1000 : 400, rmax = far ? 2200 : 1700;
      const pool = SITES.drop.filter((s) => { const k = dd(s, dock); return s.rw >= 3.4 && k > rmin && k < rmax; });
      if(pool.length < n * 6) continue;
      const picks = chain(pool, dock, n, far ? 350 : 200, far ? 1000 : 900, rnd, 0.4);
      if(picks.length >= n) return { dep, park, picks };
    }
    return null;
  }
  function genTaxi(rnd){
    for(let tries = 0; tries < 80; tries++){
      const pool = SITES.drop.filter((s) => Math.hypot(s.x, s.z) < 4200 && s.rw >= 3.6);
      const park = choice(SITES.park.filter((p) => Math.hypot(p.x, p.z) < 4200 && p.r >= 6.5 && parkOk(p)), rnd); if(!park) return null;
      const near = pool.filter((s) => dd(s, park) > 150 && dd(s, park) < 600); if(near.length < 5) continue;
      const a = choice(near, rnd);
      const b = chain(pool, a, 1, 500, 1300, rnd, 0.2)[0]; if(!b) continue;
      const c = chain(pool.filter((s) => s !== a && s !== b), b, 1, 150, 600, rnd, 0.2)[0]; if(!c) continue;
      const d = chain(pool.filter((s) => s !== a && s !== b && s !== c), c, 1, 500, 1300, rnd, 0.2)[0]; if(!d) continue;
      if(tries < 50 && new Set([a, b, c, d].map((q) => q.town)).size < 4) continue;   // なるべく 4 か所とも別の町
      return { park, picks: [a, b, c, d] };
    }
    return null;
  }
  let ARTS = null;
  function arterials(){
    if(ARTS) return ARTS; ARTS = [];
    for(const g of Traffic.segs){ if(!g.lane || !(g.c === "p" || g.c === "t" || g.c === "s") || g.P.len < 60) continue;
      for(let s = 30; s < g.P.len - 30; s += 70){ const q = pathPt(g.P, s); ARTS.push({ x: q.x, z: q.z, y: q.y, seg: g.i }); } }
    return ARTS;
  }
  function genCheck(rnd){
    const A = arterials().filter((s) => Math.hypot(s.x, s.z) < 3800); if(A.length < 50) return null;
    for(let tries = 0; tries < 20; tries++){
      const c0 = choice(A, rnd), picks = [];
      const park = choice(SITES.park.filter((p) => dd(p, c0) > 150 && dd(p, c0) < 900 && p.r >= 6.5 && parkOk(p)), rnd); if(!park) continue;
      for(let a = 0; a < 7; a++){ const ang = rnd() * 6.283, R0 = 200 + rnd() * 400, tx = c0.x + Math.cos(ang) * R0, tz = c0.z + Math.sin(ang) * R0;
        let best = null, bd = 1e9; for(const s of A){ const q = Math.hypot(s.x - tx, s.z - tz); if(q < bd && picks.every((p) => dd(p, s) > 200)) { bd = q; best = s; } }
        if(best) picks.push(best); }
      if(picks.length < 6) continue;
      // 近い順につなぐ（出発の駐車場から）
      const out = []; let cur = park; const left = picks.slice();
      while(left.length){ left.sort((u, v) => dd(u, cur) - dd(v, cur)); cur = left.shift(); out.push(cur); }
      return { park, picks: out };
    }
    return null;
  }
  function genHeli(rnd){
    const deps = SITES.depot.filter((s) => Math.hypot(s.bx, s.bz) < 4000);
    for(let tries = 0; tries < 60 && deps.length; tries++){
      const dep = choice(deps, rnd), dock = { x: dep.dx, z: dep.dz };
      const pool = SITES.heli.filter((s) => { const k = dd(s, dock); return k > 700 && k < 3200 && dd(s, dep.bx === undefined ? dock : { x: dep.bx, z: dep.bz }) > 60; });
      const picks = chain(pool, dock, 3, 500, 2600, rnd);
      if(picks.length >= 3) return { dep, picks };
    }
    return null;
  }
  /* ---- 施設の 3D（配送センターの倉庫・駐車場・配達先の標識）---- */
  const fac = { g: new THREE.Group(), blocks: [], yards: [] }; fac.g.visible = false; scene.add(fac.g);
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  function boxM(w, h, d, x, y, z, c, parent){ const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(c)); m.position.set(x, y, z); parent.add(m); return m; }
  function planeM(w, d, x, y, z, c, parent){ const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); parent.add(m); return m; }
  function blockRect(cx, cz, ux, uz, hw, hd){   // 長方形（中心・奥行き方向・半幅・半奥行き）の範囲を、自分の車が通れない壁にする
    const vx = -uz, vz = ux;
    for(let a = -hw; a <= hw + 0.01; a += 1.8) for(let b = -hd; b <= hd + 0.01; b += 1.8){ const x = cx + vx * a + ux * b, z = cz + vz * a + uz * b; Car.addBlock(x, z, 1); fac.blocks.push([x, z]); }
  }
  function clearFac(){
    for(const [x, z] of fac.blocks) Car.clearBlock(x, z, 1); fac.blocks.length = 0; fac.yards.length = 0;
    while(fac.g.children.length){ const o = fac.g.children.pop(); o.traverse((q) => { if(q.geometry) q.geometry.dispose(); if(q.material){ if(q.material.map) q.material.map.dispose(); q.material.dispose(); } }); }
    fac.g.visible = false;
  }
  function signTex(txt, bg, fg, w, h){
    return canvasTex(w || 512, h || 96, (g, W, H) => { g.fillStyle = bg; g.fillRect(0, 0, W, H); g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 4; g.strokeRect(5, 5, W - 10, H - 10);
      g.fillStyle = fg; g.font = "bold " + Math.round(H * 0.58) + "px 'Hiragino Sans','Noto Sans JP',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, W / 2, H / 2 + 2); });
  }
  function buildDepot(dep){
    const g = new THREE.Group(), y = dep.y + 0.03, yaw = Math.atan2(dep.ux, dep.uz);
    g.position.set(dep.bx, y, dep.bz); g.rotation.y = yaw;
    // 路面（アスファルト）と積み込み場所の枠
    planeM(22, 15, 0, 0.02, -11.5, 0x5a5e63, g); planeM(9, 0.25, 0, 0.04, -7.2, 0xf1d54a, g); planeM(9, 0.25, 0, 0.04, -15.8, 0xf1d54a, g);
    planeM(0.25, 8.6, -4.5, 0.04, -11.5, 0xf1d54a, g); planeM(0.25, 8.6, 4.5, 0.04, -11.5, 0xf1d54a, g);
    // 倉庫（幅 16m・奥行き 8m・高さ 6m。手前の面に出入口 3 つ・看板）
    boxM(16, 6, 8, 0, 3, 0, 0xdfe3e6, g); boxM(16.6, 0.4, 8.6, 0, 6.2, 0, 0x7d858c, g); boxM(16.05, 1.1, 8.05, 0, 0.55, 0, 0x4a5560, g);
    for(const x of [-5, 0, 5]){ boxM(3.4, 3.6, 0.12, x, 1.9, -4.05, 0x2f4a6b, g); for(let k = 0; k < 5; k++) boxM(3.4, 0.05, 0.14, x, 0.5 + k * 0.7, -4.08, 0x24384f, g); }
    boxM(15, 0.25, 3.2, 0, 4.1, -5.6, 0xb9c0c6, g);
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.7), new THREE.MeshBasicMaterial({ map: signTex("配送センター", "#12407a", "#ffffff", 768, 144) })); sg.position.set(0, 5.1, -4.13); sg.rotation.y = Math.PI; g.add(sg);
    // 三角コーンと荷物のかご
    for(const [x, z] of [[-6.2, -7.5], [6.2, -7.5], [-6.2, -15.5], [6.2, -15.5]]) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 8), lam(0xff6a1a)); c.position.set(x, 0.28, z); g.add(c); }
    for(const [x, z] of [[-7.4, -6.5], [-8.2, -6.5], [7.6, -6.2]]) boxM(0.9, 1.4, 0.7, x, 0.75, z, 0x9aa7b2, g);
    // 看板柱（道路側から見える）: 門の方向へ 14m 先に小さな標識
    const gx = dep.gx - dep.bx, gz = dep.gz - dep.bz;
    fac.g.add(g); fac.g.visible = true;
    blockRect(dep.bx, dep.bz, dep.ux, dep.uz, 8.2, 4.2);
    fac.yards.push({ x: dep.dx, z: dep.dz, r: 24 }, { x: dep.bx, z: dep.bz, r: 24 });
  }
  function buildPark(p){
    // 駐車場: 路面・P の標識・（広ければ）左右に駐車枠と停まっている車。中央 6.4m は出ていく通路として空ける。+z が門（道路）の方向
    const g = new THREE.Group(), y = p.y + 0.03, yaw = p.yaw * Math.PI / 180, W = Math.min(2 * p.r * 0.95, 24), D = Math.min(2 * p.r * 0.95, 16);
    g.position.set(p.x, y, p.z); g.rotation.y = yaw;
    planeM(W, D, 0, 0.02, 0, 0x585c61, g);
    const Ls = W / 2 - 3.2, nSl = Math.floor((D - 1) / 2.9), z0 = -((nSl - 1) * 2.9) / 2;
    if(Ls >= 4.6 && nSl >= 2){
      const cols = [0xe8e8e6, 0x2a2e36, 0x9aa3ad, 0xb23a3a, 0x31527a, 0xd9d3c4, 0x6d7f5a];
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for(const sx of [-1, 1]){
        for(let k = 0; k <= nSl; k++) planeM(Ls, 0.1, sx * (3.2 + Ls / 2), 0.045, z0 + (k - 0.5) * 2.9, 0xffffff, g);     // 区切りの白線（横）
        for(let k = 0; k < nSl; k++){ if(Math.random() < 0.4) continue;
          const lx = sx * (3.2 + Ls / 2), lz = z0 + k * 2.9, cg = new THREE.Group(), c = cols[Math.floor(Math.random() * cols.length)];
          boxM(4.2, 0.7, 1.7, 0, 0.62, 0, c, cg); boxM(2.3, 0.55, 1.55, -0.2 * sx, 1.2, 0, 0x1d2630, cg); boxM(2.0, 0.12, 1.5, -0.2 * sx, 1.52, 0, c, cg);
          cg.position.set(lx, 0, lz); g.add(cg);
          const wx = p.x + cy * lx + sy * lz, wz = p.z - sy * lx + cy * lz; Car.addBlock(wx, wz, 1); fac.blocks.push([wx, wz]); } }
    }
    boxM(0.1, 2.6, 0.1, W / 2 - 0.4, 1.3, D / 2 - 0.4, 0x6d7076, g);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: signTex("P", "#1858b8", "#ffffff", 128, 128), side: THREE.DoubleSide })); pl.position.set(W / 2 - 0.4, 2.6, D / 2 - 0.4); g.add(pl);
    fac.g.add(g); fac.g.visible = true; fac.yards.push({ x: p.x, z: p.z, r: Math.max(12, p.r + 6) });
  }
  function buildDropProp(s){
    // 配達先の標識（道の脇、建物のある側）: 橙の板に「荷」
    const yaw = s.yaw * Math.PI / 180, nx = Math.cos(yaw), nz = -Math.sin(yaw);   // 進行方向の左
    const off = (s.rw / 2 + 0.5) * (s.side || 1), g = new THREE.Group();
    g.position.set(s.x + nx * off, s.y + 0.0, s.z + nz * off);
    boxM(0.08, 1.9, 0.08, 0, 0.95, 0, 0x6d7076, g);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ map: signTex("荷", "#e8761a", "#ffffff", 128, 128), side: THREE.DoubleSide })); pl.position.set(0, 1.95, 0); pl.rotation.y = Math.atan2(-nx * (s.side || 1), -nz * (s.side || 1)); g.add(pl);
    fac.g.add(g); fac.g.visible = true;
  }

  /* ---- 3D の目印: 光の柱・地面の輪・空の輪 ---- */
  const grp = new THREE.Group(); grp.visible = false; scene.add(grp);
  const matBeam = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
  const matSolid = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, fog: false, side: THREE.DoubleSide });   // 明るい空でも見える輪（加算合成だと白く飛ぶ）
  let mk = null;   // { kind, beam, ring, wall, torus, y }
  const COL = { load: 0x35d0ff, drop: 0xffb02e, pass: 0x7dff9a };
  function buildMarker(s){
    if(mk){ grp.remove(mk.g); mk.g.traverse((o) => { if(o.geometry) o.geometry.dispose(); if(o.material) o.material.dispose(); }); mk = null; }
    if(!s) return;
    const g = new THREE.Group(), col = COL[s.kind] || 0xffffff, heli = heliMode();
    if(s.kind === "pass" && heli){
      const t = new THREE.Mesh(new THREE.TorusGeometry(s.r, 2.2, 10, 56), matSolid(0x1fd45f, 0.92)); g.add(t);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(s.r, 40), matSolid(0x1fd45f, 0.10)); g.add(inner);
      g.position.set(s.x, s.y, s.z); g.rotation.y = s.face || 0; mk = { g, kind: "ring", t, inner };
    } else if(s.kind === "pass"){
      const t = new THREE.Mesh(new THREE.TorusGeometry(s.r * 0.55, 0.35, 8, 40), matBeam(col, 0.9)); t.position.y = s.r * 0.55; g.add(t);
      const gate = new THREE.Mesh(new THREE.CircleGeometry(s.r * 0.55, 32), matBeam(col, 0.1)); gate.position.y = s.r * 0.55; g.add(gate);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 90, 10, 1, true), matBeam(col, 0.4)); beam.position.y = 45; g.add(beam);
      g.position.set(s.x, s.y, s.z); g.rotation.y = s.face || 0; mk = { g, kind: "gate", t, gate, beam };
    } else {
      const H = heli ? 700 : 150, bw = heli ? 2.6 : 1.4;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(bw, bw, H, 12, 1, true), matBeam(col, 0.42)); beam.position.y = H / 2; g.add(beam);
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(s.r, s.r, heli ? 12 : 5, 40, 1, true), matBeam(col, 0.2)); glow.position.y = heli ? 6 : 2.5; g.add(glow);
      const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 1.4, s.r, 56), matBeam(col, 0.9)); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15; g.add(ring);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(s.r, 48), matBeam(col, 0.14)); disc.rotation.x = -Math.PI / 2; disc.position.y = 0.12; g.add(disc);
      g.position.set(s.x, s.y, s.z); mk = { g, kind: "zone", beam, glow, ring, disc };
    }
    grp.add(g);
  }
  function animMarker(dt){
    if(!mk) return; const k = performance.now() / 1000;
    if(mk.kind === "zone"){ const p = 0.6 + 0.4 * Math.sin(k * 3.2); mk.beam.material.opacity = 0.28 + 0.2 * p; mk.ring.material.opacity = 0.6 + 0.35 * p; mk.ring.scale.setScalar(1 + 0.02 * Math.sin(k * 3.2)); }
    else if(mk.kind === "ring"){ mk.t.material.opacity = 0.78 + 0.18 * Math.sin(k * 4); mk.inner.material.opacity = 0.09 + 0.04 * Math.sin(k * 4); }
    else if(mk.kind === "gate"){ mk.t.material.opacity = 0.65 + 0.3 * Math.sin(k * 4); mk.beam.material.opacity = 0.25 + 0.15 * Math.sin(k * 4); }
  }

  /* ---- 画面（HUD） ---- */
  const E = {};
  const el = (id) => E[id] || (E[id] = document.getElementById(id));
  function toast(msg, kind){
    const t = el("qtoast"); if(!t) return; t.textContent = msg; t.className = "qtoast on " + (kind || ""); Q.toastT = 3.2;
    if(kind === "good") Snd.blip("done"); else if(kind === "bad") Snd.blip("bad"); else if(kind === "load") Snd.blip("load"); else Snd.blip("ok");
  }
  function dots(){
    const d = el("q-dots"); let h = "";
    Q.stops.forEach((s, i) => { h += '<i class="' + (i < Q.i ? "done" : i === Q.i ? "cur" : "") + " " + s.kind + '"></i>'; });
    d.innerHTML = h;
  }
  function showHud(on){ const h = el("qhud"); if(h) h.classList.toggle("on", !!on); }
  function me(){
    if(heliMode()){ const H = Heli.H; return { x: H.x, z: H.z, y: H.y, v: Math.hypot(H.vF, H.vS), on: H.landed, yaw: H.yaw, hit: H.hitT > 0.3, heli: true }; }
    const C = Car.C; return { x: C.x, z: C.z, y: C.h, v: Math.abs(C.v), on: true, yaw: C.yaw, hit: C.hitT > 1.0, acc: C.accF || 0, lat: C.latF || 0, cmf: Car.P.cmf || { acc: 4.6, lat: 4.6 }, heli: false };
  }

  /* ---- 開始・終了 ---- */
  /* 生成した組み合わせ → 地点の並び */
  function stopsOf(d0, gen){
    const L = stopsOf0(d0, gen), seen = {};
    for(const s of L){ if(s.kind === "pass") continue; const n = s.name; seen[n] = (seen[n] || 0) + 1; if(seen[n] > 1) s.name = n + "（" + seen[n] + "件目）"; }
    return L;
  }
  function stopsOf0(d0, gen){
    const dropOf = (s, verb, nm, r) => ({ key: "g", kind: "drop", verb, name: nm, x: s.x, z: s.z, y: s.y, r, noSnap: true, prop: s });
    if(d0.gen === "truck" || d0.gen === "truckfar"){
      const dep = gen.dep;
      return [{ key: "depot", kind: "load", verb: "荷物を積む", name: "配送センター（" + town(dep.town) + "）", x: dep.dx, z: dep.dz, y: dep.y, r: 9, noSnap: true }]
        .concat(gen.picks.map((s) => dropOf(s, "荷物を届ける", town(s.town) + (s.typ === 0 ? "の路地" : "の家の前"), s.typ === 0 ? 6.5 : 7)));
    }
    if(d0.gen === "taxi"){
      const [a, b, c, d] = gen.picks;
      const ld = (s, nm) => ({ key: "g", kind: "load", verb: "お客さんを乗せる", name: nm, x: s.x, z: s.z, y: s.y, r: 7, noSnap: true, prop: s });
      return [ld(a, town(a.town) + "のお客さん宅前"), dropOf(b, "お客さんを降ろす", town(b.town) + "の行き先", 7), ld(c, town(c.town) + "のお客さん宅前"), dropOf(d, "お客さんを降ろす", town(d.town) + "の行き先", 7)];
    }
    if(d0.gen === "check") return gen.picks.map((s, i) => ({ key: "c" + i, kind: "pass", verb: "通過", name: "チェックポイント " + (i + 1), x: s.x, z: s.z, y: s.y, r: 14, noSnap: true }));
    if(d0.gen === "heli"){
      const dep = gen.dep;
      return [{ key: "depot", kind: "load", verb: "荷物を積む", name: "配送センター（" + town(dep.town) + "）", x: dep.dx, z: dep.dz, y: dep.y, r: 22 }]
        .concat(gen.picks.map((s) => ({ key: "g", kind: "drop", verb: "荷物を届ける", name: town(s.town) + "の広場", x: s.x, z: s.z, y: s.y, r: Math.max(18, Math.min(34, s.r + 6)) })));
    }
    return d0.stops;
  }
  function begin(id, seed){
    const d0 = def(id); if(!d0) return false;
    if(d0.shift){ clearFac(); Q.on = false; Q.done = false; Q.gen = null; Q.def = null; showHud(false); return Taxi.begin(d0); }   // v41.10: タクシー営業は Taxi が受け持つ
    clearFac(); Q.gen = null; Q.seed = undefined; Q.startName = "";
    let d = d0, gen = null;
    if(d0.gen && SITES && (d0.gen !== "check" || Traffic.ready)){
      const sd = seed === undefined ? ((Math.random() * 4294967296) >>> 0) : seed, rnd = rngOf(sd);
      gen = d0.gen === "truck" ? genTruck(false, rnd) : d0.gen === "truckfar" ? genTruck(true, rnd) : d0.gen === "taxi" ? genTaxi(rnd) : d0.gen === "check" ? genCheck(rnd) : d0.gen === "heli" ? genHeli(rnd) : null;
      if(gen){ d = Object.assign({}, d0, { stops: stopsOf(d0, gen) }); Q.seed = sd; }
    }
    Q.gen = gen;
    // 車: 駐車場から出発（自分の車をそこへ置く）。施設（倉庫・駐車場・標識）を建てる
    if(gen && d.mode === "car" && gen.park){
      const C = Car.C, p = gen.park; C.x = p.x; C.z = p.z; C.yaw = p.yaw * Math.PI / 180; C.h = Car.hAt(p.x, p.z); C.v = 0; C.gear = "D"; C.wheel = 0; C.hitT = 0; Stuck.reset(); Traffic.reset();
      Q.startName = town(p.town) + "の駐車場";
    }
    if(gen){
      if(gen.dep) buildDepot(gen.dep);
      if(gen.park && d.mode === "car") buildPark(gen.park);
      for(const s of d.stops) if(s.prop) buildDropProp(s.prop);
    }
    Q.def = d; Q.on = true; Q.done = false; Q.i = 0; Q.t = 0; Q.hold = 0; Q.loaded = false; Q.hits = 0; Q.lastHit = false; Q.comfortT = 0; Q.speedT = 0; Q.tdSeen = Heli.H.tdT || 0; Q.log = [];
    Q.pen = { time: 0, hit: 0, hard: 0, comfort: 0, speed: 0, red: 0 }; Q.bonus = { soft: 0, pin: 0 };
    const heli = d.mode === "heli", m = me();
    // 地点を解決（車: 道路へ吸着・高さ。ヘリ: 地面の高さ・輪の向き）
    Q.stops = d.stops.map((s) => Object.assign({}, s));
    let prev = { x: m.x, z: m.z };
    Q.stops.forEach((s) => {
      if(heli){ s.y = Heli.groundAt(s.x, s.z); if(s.kind === "pass") s.y = Math.max(Heli.topAt(s.x, s.z), s.y) + (s.agl || 100); }
      else if(s.noSnap){ s.snapOk = true; s.y = Car.hAt(s.x, s.z) + 0.1; }
      else { const q = snapRoad(s.x, s.z); s.sx = s.x; s.sz = s.z; s.x = q.x; s.z = q.z; s.snapOk = q.ok; s.y = Car.hAt(s.x, s.z) + 0.1; }
      s.face = Math.atan2(s.x - prev.x, s.z - prev.z); prev = s;
    });
    // 目安時間（累積）: 距離 ÷ 平均速度 ＋ 停止・着陸の時間
    const V = heli ? (d.gentle ? 34 : 32) : (Car.C.profile === "truck" ? 8.2 : 9.4), F = heli ? 1.04 : (Q.gen ? 1.6 : 1.38), DW = heli ? 22 : 12;
    let t = 0; prev = { x: m.x, z: m.z };
    Q.stops.forEach((s) => { const dist = Math.hypot(s.x - prev.x, s.z - prev.z); t += dist * F / V + (s.kind === "pass" ? 3 : DW); s.parCum = t; prev = s; });
    Q.parT = t;
    buildMarker(Q.stops[0]); grp.visible = true; navTo(Q.stops[0]);
    el("q-name").textContent = d.name; el("q-kick").textContent = (heli ? "HELI MISSION" : (d.veh === "truck" ? "TRUCK MISSION" : "DRIVE MISSION"));
    dots(); showHud(true); el("qfin").classList.remove("on"); hud(true);
    toast(d.name + " スタート" + (Q.startName ? "（" + Q.startName + "から）" : "") + " — 最初は「" + Q.stops[0].name + "」", "");
    return true;
  }
  function end(){
    clearFac(); Q.gen = null;
    Q.on = false; Q.done = false; grp.visible = false; buildMarker(null); showHud(false); Nav.clear("auto"); Taxi.stop();
    const f = el("qfin"); if(f) f.classList.remove("on"); const t = el("qtoast"); if(t) t.className = "qtoast";
    setPod(false);
  }
  /* ---- ヘリの機体に付ける荷物ポッド ---- */
  function setPod(on, color){ if(Heli.setPod) Heli.setPod(on, color); }

  /* ---- 毎フレーム ---- */
  function nextStop(){
    const s = Q.stops[Q.i], i = Q.i;
    if(s.kind === "load"){ Q.loaded = true; setPod(heliMode(), Q.def.pod); toast(s.name + " — " + s.verb + "。次は「" + (Q.stops[i + 1] ? Q.stops[i + 1].name : "") + "」へ", "load"); }
    else if(s.kind === "drop"){ const more = Q.stops[i + 1] && Q.stops[i + 1].kind === "drop"; if(!more){ Q.loaded = false; setPod(false); }
      toast(s.name + " に" + s.verb + "（" + (i + 1) + "/" + Q.stops.length + "）", "good"); }
    else toast(s.name + " 通過（" + (i + 1) + "/" + Q.stops.length + "）", "good");
    Q.i++; Q.hold = 0;
    if(Q.i >= Q.stops.length){ finish(); return; }
    buildMarker(Q.stops[Q.i]); dots(); navTo(Q.stops[Q.i]);
  }
  /* v41.10: 車のミッションでは、次の地点をナビに自動でセットする（src="auto"。ヘリには付けない） */
  function navTo(s){ if(heliMode() || !s) return; Nav.setTarget({ x: s.x, z: s.z, name: s.name, r: s.r, kind: s.kind }, "auto"); }
  function tick(dt){
    if(!Q.on) return;
    const t = el("qtoast"); if(Q.toastT > 0){ Q.toastT -= dt; if(Q.toastT <= 0 && t) t.className = "qtoast"; }
    if(Q.done) return;
    const heli = heliMode(); if((heli && S.mode !== "heli") || (!heli && S.mode !== "car")) return;
    const m = me(), s = Q.stops[Q.i]; if(!s) return;
    Q.t += dt; animMarker(dt);
    const dx = s.x - m.x, dz = s.z - m.z, d = Math.hypot(dx, dz);
    // ---- 到着の判定 ----
    if(s.kind === "pass"){
      const dy = heli ? m.y - s.y : 0;
      if(d < s.r * (heli ? 0.9 : 1) && Math.abs(dy) < (heli ? s.r * 0.9 : 99)) nextStop();
    } else {
      const ok = heli ? (m.on && d < s.r && m.v < 3) : (d < s.r && m.v < 1.3);
      if(ok){ Q.hold += dt; if(Q.hold >= (heli ? 2.0 : 1.4)){
        if(!heli && d < 4) { Q.bonus.pin += 10; Q.log.push("ぴたり +10（" + s.name + "）"); }
        if(heli && d < s.r * 0.35) { Q.bonus.pin += 10; Q.log.push("ぴたり +10（" + s.name + "）"); }
        nextStop(); } }
      else Q.hold = Math.max(0, Q.hold - dt * 1.5);
    }
    if(Q.done) return;
    // ---- 減点・加点 ----
    if(m.hit && !Q.lastHit){ Q.pen.hit += 30; Q.hits++; toast("衝突 −30 点", "bad"); } Q.lastHit = m.hit;
    if(Q.t > Q.parT) Q.pen.time = Math.min(300, (Q.t - Q.parT) * 1.2);
    if(heli){
      const H = Heli.H;
      if(H.tdT && H.tdT !== Q.tdSeen){ Q.tdSeen = H.tdT; const v = H.tdV || 0, near = Q.stops[Q.i] && Math.hypot(Q.stops[Q.i].x - H.x, Q.stops[Q.i].z - H.z) < Q.stops[Q.i].r + 25, g = !!Q.def.gentle;
        if(v > (g ? 1.6 : 4.5)){ const p = g ? (v > 3 ? 150 : 60) : (v > 6 ? 150 : 100); Q.pen.hard += p; toast("ハードランディング −" + p + " 点（降下 " + v.toFixed(1) + " m/s）", "bad"); }
        else if(v > (g ? 0.9 : 2.8)){ const p = g ? 25 : 30; Q.pen.hard += p; toast("着陸が少し荒い −" + p + " 点（降下 " + v.toFixed(1) + " m/s）", "bad"); }
        else if(near && Q.stops[Q.i].kind !== "pass"){ const b = g ? 25 : 15; Q.bonus.soft += b; toast("ソフトランディング +" + b + " 点", "good"); } }
    } else {
      // 乗り心地（乗せている間）・速度超過
      if(Q.loaded && Q.def.comfortK && m.v > 0.5 && (Math.abs(m.acc) > m.cmf.acc || m.lat > m.cmf.lat) && Q.comfortT <= 0){ Q.pen.comfort += Q.def.comfortK; Q.comfortT = 4; toast((Math.abs(m.acc) > m.cmf.acc ? "急ブレーキ・急発進で" : "急ハンドルで") + (Q.def.cargo === "お客さん" ? "お客さんが驚いた" : "荷物が揺れた") + " −" + Q.def.comfortK + " 点", "bad"); }
      Q.comfortT = Math.max(0, Q.comfortT - dt);
      const L = Loc.last, lim = L && L.v; if(lim && m.v * 3.6 > lim + SPEED_OVER_OK){ Q.pen.speed += dt * 1.2; Q.speedT -= dt; if(Q.speedT <= 0){ Q.speedT = 6; toast("制限速度 " + lim + " km/h を超えています", "bad"); } }
    }
    hud();
  }
  const score = () => Math.max(0, Math.min(1000, Math.round(1000 - Q.pen.time - Q.pen.hit - Q.pen.hard - Q.pen.comfort - Q.pen.speed - (Q.pen.red || 0) + Q.bonus.soft + Q.bonus.pin)));
  let lastH = "";
  function hud(force){
    const s = Q.stops[Q.i]; if(!s) return; const m = me();
    const dx = s.x - m.x, dz = s.z - m.z, d = Math.hypot(dx, dz);
    const a = el("q-arrow"); if(a){ const rel = Math.atan2(dx, dz) - m.yaw; a.style.transform = "rotate(" + (-rel * 180 / Math.PI).toFixed(1) + "deg)"; }
    const ahead = s.parCum - Q.t, late = ahead < 0;
    const key = [s.name, d < 100 ? d.toFixed(0) : Math.round(d / 10) * 10, Math.round(ahead), score(), Math.round(Q.hold * 4), Q.i, Q.loaded].join("|");
    if(!force && key === lastH) return; lastH = key;
    el("q-verb").textContent = s.verb; el("q-target").textContent = s.name;
    el("q-dist").textContent = d >= 1000 ? (d / 1000).toFixed(2) : Math.round(d); el("q-du").textContent = d >= 1000 ? "km" : "m";
    const tm = el("q-time"); tm.textContent = (late ? "遅れ " : "目安まで ") + fmt(Math.abs(ahead)); tm.className = late ? "late" : "";
    el("q-score").textContent = score(); el("q-el").textContent = fmt(Q.t);
    el("q-hold").style.width = (Math.min(1, Q.hold / (heliMode() ? 2.0 : 1.4)) * 100).toFixed(0) + "%";
    const hint = el("q-hint");
    if(s.kind === "pass") hint.textContent = heliMode() ? "輪の中をくぐる" : "チェックポイントを通過";
    else if(heliMode()) hint.textContent = d > s.r ? "目標の円の上へ" : (m.on ? "着陸中… そのまま" : "降下して着陸（降下は ゆっくり）");
    else hint.textContent = d > s.r ? "光の柱の円の中へ" : (m.v >= 1.3 ? "止まる（ブレーキ）" : "停止中… そのまま");
    el("q-cargo").textContent = Q.loaded ? "積載中: " + (Q.def.cargo || "") : (Q.def.cargo ? "積載なし" : "");
  }
  function finish(){
    Q.done = true; grp.visible = false; buildMarker(null); showHud(false); Nav.clear("auto");
    const sc = score(), g = sc >= 900 ? "S" : sc >= 750 ? "A" : sc >= 550 ? "B" : "C", R = Prefs.record("quest:" + Q.def.id, sc);
    el("qf-name").textContent = Q.def.name; el("qf-score").textContent = sc; el("qf-grade").textContent = g; el("qf-grade").className = "qgrade g" + g;
    const rows = [["所要時間", fmt(Q.t) + "（目安 " + fmt(Q.parT) + "）", Q.pen.time ? "−" + Math.round(Q.pen.time) : "±0"],
                  ["衝突", Q.hits + " 回", Q.pen.hit ? "−" + Q.pen.hit : "±0"]];
    if(heliMode()) rows.push(["ランディング", Q.pen.hard ? "荒い着陸あり" : (Q.bonus.soft ? "ソフトランディング" : "—"), (Q.pen.hard ? "−" + Q.pen.hard : "") + (Q.bonus.soft ? " +" + Q.bonus.soft : "") || "±0"]);
    else { rows.push(["乗り心地・荷物", Q.pen.comfort ? "急な操作あり" : "なめらか", Q.pen.comfort ? "−" + Q.pen.comfort : "±0"]); rows.push(["速度超過", Q.pen.speed > 0.5 ? "あり" : "なし", Q.pen.speed > 0.5 ? "−" + Math.round(Q.pen.speed) : "±0"]); rows.push(["信号無視・逆走", Q.pen.red ? "あり" : "なし", Q.pen.red ? "−" + Math.round(Q.pen.red) : "±0"]); }
    if(Q.bonus.pin) rows.push(["ぴたり停止", "", "+" + Q.bonus.pin]);
    el("qf-rows").innerHTML = rows.map((r) => '<div class="qr"><span>' + r[0] + '</span><span>' + r[1] + '</span><b>' + r[2] + '</b></div>').join("");
    el("qf-best").textContent = R.newBest && R.n > 1 ? "自己ベスト更新！（これまでの最高 " + R.best + " 点）" : "最高 " + R.best + " 点・" + R.n + " 回目";
    const rt = el("qf-retry"), nw = el("qf-new");
    if(rt) rt.firstElementChild.textContent = Q.gen ? "同じ内容でもう一度" : "もう一度";
    if(nw) nw.style.display = Q.gen ? "" : "none";
    el("qfin").classList.add("on"); Snd.blip("done");
  }
  function mapPts(){ return (Q.on && !Q.done && Q.stops[Q.i]) ? [{ x: Q.stops[Q.i].x, z: Q.stops[Q.i].z, kind: Q.stops[Q.i].kind }] : []; }

  /* ---- メニュー用: コース一覧の描画 ---- */
  function best(id){ return Prefs.best ? Prefs.best("quest:" + id) : 0; }
  function renderPicker(host, mode, veh, onPick){
    const L = list(mode, veh); if(!L.some((c) => c.id === sel[mode])) sel[mode] = L[0] && L[0].id;
    host.innerHTML = "";
    for(const c of L){
      const b = document.createElement("button"); b.type = "button"; b.className = "quest-opt" + (c.id === sel[mode] ? " on" : ""); b.dataset.qid = c.id;
      const bs = c.shift ? 0 : best(c.id), bt = c.shift ? Taxi.bestText() : "";
      b.innerHTML = '<span class="qs">' + "★".repeat(c.star) + '<i>' + "★".repeat(3 - c.star) + '</i></span><b>' + c.name + '</b><small>' + c.blurb + '</small>' + (bs ? '<em>最高 ' + bs + '</em>' : bt ? '<em>' + bt + '</em>' : "");
      b.addEventListener("click", () => { host.querySelectorAll(".quest-opt").forEach((x) => x.classList.toggle("on", x === b)); sel[mode] = c.id; if(onPick) onPick(c); });
      host.appendChild(b);
    }
  }
  const inYard = (x, z) => fac.yards.some((y) => Math.hypot(x - y.x, z - y.z) < y.r);
  Rules.on((kind) => { if(!Q.on || Q.done || heliMode() || S.mode !== "car") return;   // v41.10: 信号無視・逆走の減点
    if(kind === "red"){ Q.pen.red += 60; toast("信号無視 −60 点", "bad"); } else if(kind === "wrong"){ Q.pen.red += 30; toast("逆走 −30 点", "bad"); } });
  return { begin, end, tick, list, def, sel, renderPicker, mapPts, Q, snapRoad, COURSES, PL, inYard, town, get sites(){ return SITES; }, get on(){ return Q.on; }, get done(){ return Q.done; }, score };
})();

// v41.7: ミッションの画面の操作
$("q-quit").addEventListener("click", () => Quest.end());
$("qf-free").addEventListener("click", () => Quest.end());
$("qf-menu").addEventListener("click", () => { Quest.end(); $(S.mode === "heli" ? "heli-menu" : "car-menu").click(); });
function questAgain(same){ if(Taxi.pending){ Taxi.again(); return; } const d = Quest.Q.def; if(!d) return; const sd = same ? Quest.Q.seed : undefined; Quest.end();
  if(d.mode === "heli"){ Heli.setStart(d.start); Heli.start(); } else { placeCar(); }
  Quest.begin(d.id, sd); }
$("qf-retry").addEventListener("click", () => questAgain(true));
$("qf-new").addEventListener("click", () => questAgain(false));
/* ---------------- v41.7: 時刻表パネル（電車・バス）----------------
   I キー（または「時刻表」ボタン）で開閉。停留場ごとの 着・発の定刻と、実際の到着のずれ。ダイヤ運行をオフにしている時は停留場の一覧と距離だけ。 */
const TT = (() => {
  const el = $("ttp"), rowsEl = $("ttp-rows"), ttl = $("ttp-title"), clk = $("ttp-clock"), sub = $("ttp-sub"), foot = $("ttp-foot"), tag = $("ttp-tag");
  let open = false, acc = 0, lastCur = -1;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hm = (t) => (t == null ? "" : Dia.hms(t));
  function model(){
    if(S.mode === "bus" && Bus.active) return Bus.bdModel();
    if(S.mode === "tram" && S.running && !VEH().jr){
      const m = Dia.model(); if(m) return m;
      return { on: false, kind: "tram", title: (S.route && S.route.name || "路面電車"), rows: S.stops.map((s, i) => ({ name: s.name.replace(/・.*$/, ""), arc: S.cum[i] - S.cum[0], cur: i === S.stopIndex })) };
    }
    return null;
  }
  const resCell = (r) => r.passed ? ["通過", "pass"] : r.dev == null ? ["", ""] : r.dev > 20 ? ["+" + r.dev + "秒", "late"] : r.dev > 5 ? ["+" + r.dev + "秒", "warn"] : r.dev < -5 ? [r.dev + "秒", "early"] : ["定刻", "ok"];
  function render(){
    const m = model(); if(!m){ setOpen(false); return; }
    ttl.textContent = m.title; clk.textContent = hm(S.clock); tag.textContent = m.on === false ? "ダイヤ運行なし" : m.kind === "bus" ? "バス" : "路面電車";
    el.classList.toggle("plain", m.on === false);
    let h = "", cur = -1;
    m.rows.forEach((r, i) => { if(r.cur) cur = i;
      if(m.on === false){ h += '<li class="row' + (r.cur ? " cur" : "") + '"><span class="nm">' + esc(r.name) + '</span><span class="t arc">' + (r.arc < 1000 ? Math.round(r.arc) + " m" : (r.arc / 1000).toFixed(2) + " km") + '</span></li>'; return; }
      const [rt, rc] = resCell(r);
      h += '<li class="row' + (r.cur ? " cur" : "") + (r.here ? " here" : "") + (r.passed ? " passed" : "") + '"><span class="nm">' + esc(r.name) + '</span><span class="t">' + (r.arr != null ? hm(r.arr) : "—") + '</span><span class="t d">' + (r.dep != null && r.dep !== r.arr ? hm(r.dep) : "") + '</span><span class="res ' + rc + '">' + rt + '</span></li>'; });
    rowsEl.innerHTML = h;
    if(cur >= 0 && cur !== lastCur){ lastCur = cur; const e = rowsEl.children[cur]; if(e && e.scrollIntoView) e.scrollIntoView({ block: "nearest" }); }
    if(m.on === false){ sub.textContent = "走った距離の目安です。ダイヤ運行（定刻・採点）はメニューの「あそびかた」で選べます。"; foot.textContent = ""; }
    else { const score = Math.max(0, Math.round(1000 - m.pen)), g = score > 900 ? "S" : score > 750 ? "A" : score > 550 ? "B" : "C";
      sub.textContent = "着 = 到着の定刻　発 = 発車の定刻（定刻前に出ると減点）　実績 = 実際の到着のずれ";
      foot.innerHTML = '定時点 <b>' + score + '</b> / 1000　<b class="g">' + g + '</b><span>遅れは ' + Dia.cfg.GRACE + ' 秒までは減点なし・通過は −' + Dia.cfg.PASS_PEN + ' 点</span>'; }
  }
  function setOpen(v){ open = !!v; el.classList.toggle("on", open); if(open){ lastCur = -1; render(); } const b = $("tt-btn"), b2 = $("tt-btn2"); if(b) b.classList.toggle("on", open); if(b2) b2.classList.toggle("on", open); }
  function toggle(){ if(!model()){ const ms = $("subtitle"); return; } setOpen(!open); }
  function tick(dt){
    const t1 = $("tt-btn"), t2 = $("tt-btn2");
    if(t1) t1.style.display = (S.mode === "tram" && S.running && !VEH().jr) ? "" : "none";
    if(t2) t2.style.display = (S.mode === "bus" && Bus.active) ? "" : "none";
    if(!open) return; acc += dt; if(acc < 0.25) return; acc = 0; render();
  }
  // 運転終了の画面に、停留場ごとの結果を表で出す
  function fillFinish(m){
    const c = $("finish-tt"); if(!c) return;
    if(!m || m.on === false || !m.rows.some(r => r.dev != null || r.passed)){ c.innerHTML = ""; c.style.display = "none"; return; }
    let h = '<div class="ftt-h"><span>停留場</span><span>定刻</span><span>結果</span></div>';
    for(const r of m.rows){ if(r.arr == null) continue; const [rt, rc] = resCell(r); h += '<div class="ftt-r"><span class="nm">' + esc(r.name) + '</span><span class="t">' + hm(r.arr).slice(0, 5) + hm(r.arr).slice(5) + '</span><span class="res ' + rc + '">' + (rt || "—") + '</span></div>'; }
    c.innerHTML = h; c.style.display = "";
  }
  $("ttp-x").addEventListener("click", () => setOpen(false));
  { const b1 = $("tt-btn"), b2 = $("tt-btn2"); if(b1) b1.addEventListener("click", toggle); if(b2) b2.addEventListener("click", toggle); }
  document.addEventListener("keydown", (e) => { if(e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing()) return; if((e.key === "i" || e.key === "I") && Clock.inSession()) toggle(); });
  Clock.onShift((d) => { Dia.shift(d); Bus.bdShift(d); });
  return { toggle, setOpen, tick, render, fillFinish, model, get open(){ return open; } };
})();

function loop(now){
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  Pad.poll(dt);
  if(Trams.ready) simTraffic(dt);
  Stream.tick(); HiStream.tick(); Env.tick(dt);
  updateSun(); if(S._waterTex){ S._waterTex.offset.x=(S.t*0.012)%1; S._waterTex.offset.y=(S.t*0.007)%1; }
  if(S.mode==="car"||S.mode==="bus"){ S.t+=dt; Car.tick(dt); Stuck.tick(dt); if(S.car) S.car.visible=false; Car.updateCam(dt); Car.hud();
    if(S.mode==="bus"){ Bus.tick(dt, S.t); S.clock=Bus.bd.clk; const L=Loc.update(dt, Car.C.x, Car.C.z, "西大寺線"); if(L && L.v) Bus.setLimit(L.v); }
    else { S.clock+=dt; Loc.update(dt, Car.C.x, Car.C.z, ""); }
    Snd.carSound(Car.C); }
  if(S.mode!=="car" && S.mode!=="bus") Snd.carSound(Car.C);   // 他のモードでは車・バスの音を止めておく
  { const carM = S.mode==="car" || S.mode==="bus";   // v41.14: 雨音（走っているときだけ。運転席・運転台の中では小さく）
    const live = carM ? Car.C.active : S.mode==="heli" ? Heli.H.active : S.running;
    const inCab = carM ? Car.C.view==="driver" : (S.mode==="tram" && S.view==="cab");
    Snd.rainSound(dt, !!(Env.st.rain && live), S.mode==="heli" ? "heli" : inCab ? "cab" : "out"); }
  Stamps.tick(dt);   // v41.15: 岡山めぐり
  if(S.mode!=="heli") Snd.heliSound(Heli.H);
  if(S.mode==="car"||S.mode==="bus"){}
  else if(S.mode==="heli"){ S.t+=dt; S.clock+=dt; Heli.tick(dt); if(S.car) S.car.visible=false; Heli.updateCam(dt); Heli.hud(); Loc.update(dt, Heli.H.x, Heli.H.z, ""); Snd.heliSound(Heli.H); }
  else if(S.running){ tick(dt); if(S.track){ const p=pointAt(S.pos); Loc.update(dt, p.x, p.z, S.route && S.route.name ? S.route.name.replace(/（.*$/,"") : ""); } } else { S.t+=dt; if(S.track && $("menu").style.display!=="none"){ S.pos=S.cum[0]+40+((S.t*5)%Math.max(1,S.endArc-120)); } }
  Quest.tick(dt); Rules.tick(dt); Taxi.tick(dt); Nav.tick(dt);
  NaviMap.update(dt);
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
  layoutHud(); Clock.render(); TT.tick(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
applyMenu();
loadAll().catch(e=>{ console.error(e); Boot.fail("データの読み込みに失敗しました。通信の状態を確認して、もう一度お試しください。", e, true); });
window.__scene = scene; window.__Quest = Quest; window.__Clock = Clock; window.__TT = TT; window.__phase = phaseState; window.__Dia = Dia; window.__VEHICLES = VEHICLES; window.__limitAt = limitAt; window.__doorAction = doorAction; window.__setNotch = setNotch; window.__tick = tick; window.__Bus = Bus; window.__busP = ()=>mkPath(Bus.data.path); window.__pathPt = pathPt; window.__pathTan = pathTan; window.__Loc = Loc; window.__applyHandles = applyHandles; window.__Traffic = Traffic; window.__Trams = Trams; window.__sim = simTraffic; window.__Obs = Obs;
window.__Obs = Obs; window.__Outer = Outer; window.__MW = MW; window.__MWT = MWT; window.__OrthoPages = OrthoPages; window.__GT = GROUND_TILES; window.__dataIn = dataIn; window.__cam = camera; window.__updateCamera = updateCamera; window.__NaviMap = NaviMap; window.__Nav = Nav; window.__Taxi = Taxi; window.__Rules = Rules;   // v29: 試験用
window.__doHorn = doHorn; window.__S = S; window.__Snd = Snd; window.__Heli = Heli; window.__Env = Env; window.__Stream = Stream; window.__world = world; window.__cabpos = () => Cab.screenPos(); window.__Car = Car; window.__Peds = Peds; window.__JR = JR; window.__FACADE_U = FACADE_U; window.__HiStream = HiStream; window.__Stamps = Stamps;
})();
