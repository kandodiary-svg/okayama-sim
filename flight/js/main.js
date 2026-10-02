(function(){
"use strict";
const G=GEO, D2R=Math.PI/180, T=THREE;
const FS=window.FS={T};
const q=new URLSearchParams(location.search);
async function init(){
  const msg=t=>{ const e=document.getElementById("lmsg"); if(e) e.textContent=t; };
  if(q.get("dbg")) document.body.classList.add("dbg");
  const cv=document.getElementById("gl");
  const renderer=new T.WebGLRenderer({canvas:cv,antialias:q.get("aa")!=="0",logarithmicDepthBuffer:true,powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,+q.get("pr")||1.5));
  const scene=new T.Scene(); const camera=new T.PerspectiveCamera(60,1,0.3,400000); scene.add(camera);
  Object.assign(FS,{renderer,scene,camera});
  msg("データ索引を読み込み中…");
  const [tiles,bidx,apd]=await Promise.all([fetch("data/tiles.json").then(r=>r.json()),fetch("data/bld_index.json").then(r=>r.json()),fetch("data/airports.json").then(r=>r.json())]);
  const sky=FS.sky=new Sky(T,scene,renderer);
  scene.fog=new T.FogExp2(sky.fogColor,1/52000);
  const terrain=FS.terrain=new Terrain(T,scene,"data/",tiles,{maxActive:+q.get("act")||8});
  let ap=null; const bld=FS.bld=new Buildings(T,scene,"data/",bidx,sky,{skip:(x,z)=>ap&&ap.skipAt(x,z)});
  ap=FS.ap=new Airports(T,scene,"data/",apd,terrain,sky,bld); const lights=FS.lights=new AirLights(T,scene,ap,sky,renderer);
  const lm=FS.lm=new Landmarks(T,scene,terrain,sky); const pk=FS.pk=new Parked(T,ap,terrain); const hudCv=document.getElementById("inst"); const hud=FS.hud=new Hud(hudCv); const audio=FS.audio=new Sound();
  const game=FS.game=new Game(FS,{hud,audio}); const easy=FS.easy=new Easy(T,scene,game); game.easy=easy; game.easyOn=easy.on; const ui=FS.ui=bindUI(game,hud,audio); game.ui=ui;
  sky.setHour(+q.get("h")||14); game.cam.x=0;
  const frustum=new T.Frustum(), pm=new T.Matrix4();
  function resize(){ const w=innerWidth,h=innerHeight; renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix(); }
  addEventListener("resize",resize); resize();
  const dbg=document.getElementById("dbg"); let last=performance.now(), fps=0, frames=0, hudT=0;
  function frame(now){
    const dt=Math.min(0.1,(now-last)/1000); last=now; frames++; fps+=(1/Math.max(dt,1e-3)-fps)*0.1;
    game.frame(dt); easy.update(dt);
    const cam=game.cam; pm.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    sky.update(cam,dt); scene.fog.color.copy(sky.fogColor);
    const tc=sky.tintCol; terrain.tint.setRGB(tc[0],tc[1],tc[2]); terrain.nlK.value=Math.max(0,sky.night-0.2)*1.0;
    lm.update(cam,game.t); terrain.update(cam,frustum); bld.update(cam,frustum); ap.prepare(cam); pk.ensure("RJOB"); pk.ensure("RJTT"); ap.update(cam,frustum);
    const s=game.s; const pp=(game.state==="fly"||game.state==="crashed")?{x:s.pos[0],y:s.pos[1],z:s.pos[2]}:null;
    lights.update(cam,dt,camera.fov*D2R,renderer.domElement.height,pp);
    renderer.render(scene,camera);
    if(game.state==="fly"||game.state==="crashed"){ hudT+=dt; if(hudT>1/30){ hudT=0; if(game.view!=="window") hud.draw(game.hudView()); } game.updateAudio(dt); }
    if(frames%20===0&&document.body.classList.contains("dbg")){ const ll=G.xz2ll(cam.x,cam.z); dbg.textContent="fps "+fps.toFixed(0)+"  tiles "+terrain.stat.tiles+" load "+terrain.stat.loading+"  bld "+bld.stat.chunks+"/"+bld.stat.meshes+"\n"+ll.map(v=>v.toFixed(4)).join(", ")+"  alt "+cam.y.toFixed(0)+"\nstate "+game.state+" cas "+(s.cas/0.514444).toFixed(0)+" thr "+s.thr[0].toFixed(2)+" vs "+s.vs.toFixed(1); }
    requestAnimationFrame(frame);
  }
  document.getElementById("load").style.display="none";
  game.state="menu"; document.getElementById("menu").style.display="flex";
  // 試験用: ?scn=rjob_to&view=chase で自動開始
  if(q.get("scn")){ const o={id:q.get("scn"),hour:+q.get("h")||14,cloud:q.get("cloud")||"fair",wx:{wind:q.get("wind")||"light"},rwy:q.get("rwy")||"16L"}; if(o.id==="rjob_to"||o.id==="cruise"||o.id==="rjtt_app") o.dest={icao:"RJTT",rwy:o.rwy}; if(o.id==="rjob_app") o.dest={icao:"RJOB",rwy:"25"}; game.destRwy=o.dest||null; game.view=q.get("view")||"chase"; document.getElementById("menu").style.display="none"; game.startScenario(o); ui.showPlay(true); }
  requestAnimationFrame(frame);
}
init().catch(e=>{ console.error(e); const l=document.getElementById("lmsg"); if(l) l.textContent="エラー: "+e.message; });
})();
