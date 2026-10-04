/* 画面部品の組み立て: メニュー・MCP（オートパイロット操作盤）・ボタン・スロットル・タッチ操作・コックピット枠・計器の配置。 */
(function(root){
"use strict";
const D2R=Math.PI/180, KT=0.514444, FT=0.3048, MV=()=>root.MAGVAR_NOW||7.5;
const $=id=>document.getElementById(id);
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
function bindUI(game, hud, audio){
  const ap=()=>game.c.ap;
  // ---------------- メニュー ----------------
  const scn=()=>document.querySelector("input[name=scn]:checked").value;
  // 空港・滑走路の選択肢（読み込んだ空港データから作る）
  const ORDER=["RJOB","RJTT","RJAA","RJCC","RJOO","RJBB","RJGG","RJFF","ROAH","RJSS","RJOA","RJFK","RJFT","RJFU","RJFM","RJOM","RJOT","RJSN","RJNK","RJBE","RJCH","RJFO","ROIG","RJSA","RJSK","RJEC","RJFR","RJOK"];
  const aps=Object.values(game.ap.ap).sort((a,b)=>(ORDER.indexOf(a.icao)+99)%99-(ORDER.indexOf(b.icao)+99)%99);
  const fillAp=el=>{ el.innerHTML=aps.map(a=>"<option value='"+a.icao+"'>"+a.info.name+" "+a.icao+"</option>").join(""); };
  const fillRwy=(el,icao,lab)=>{ const a=game.ap.ap[icao]; let h="<option value='auto'>"+lab+"</option>"; if(a) for(const r of a.runways) for(const e of r.ends) h+="<option value='"+e.name+"'>"+e.name+"（"+Math.round(r.L)+" m）</option>"; el.innerHTML=h; };
  fillAp($("oFrom")); fillAp($("oDest"));
  const PRESETS=[["RJOB","RJTT","岡山 → 羽田（デフォルト）"],["RJTT","RJCC","羽田 → 新千歳（札幌）"],["RJTT","RJFF","羽田 → 福岡"],["RJTT","ROAH","羽田 → 那覇"],["RJTT","RJOO","羽田 → 伊丹（大阪）"],["RJTT","RJOA","羽田 → 広島"],["RJTT","RJFK","羽田 → 鹿児島"],["RJTT","RJOB","羽田 → 岡山"],["RJCC","RJTT","新千歳 → 羽田"],["RJFF","RJTT","福岡 → 羽田"],["ROAH","RJTT","那覇 → 羽田"],["RJOO","RJCC","伊丹 → 新千歳"],["RJBB","ROAH","関西 → 那覇"],["RJGG","RJCC","中部 → 新千歳"],["RJAA","RJFF","成田 → 福岡"],["RJSS","RJOO","仙台 → 伊丹"],["RJFF","ROAH","福岡 → 那覇"],["RJOB","RJCC","岡山 → 新千歳"],["RJTT","RJFT","羽田 → 熊本"],["RJTT","RJFU","羽田 → 長崎"],["RJTT","RJFM","羽田 → 宮崎"],["RJTT","RJOM","羽田 → 松山"],["RJTT","RJOT","羽田 → 高松"],["RJTT","RJSN","羽田 → 新潟"],["RJTT","RJNK","羽田 → 小松"],["RJTT","RJBE","羽田 → 神戸"],["RJTT","RJCH","羽田 → 函館"],["RJTT","RJFO","羽田 → 大分"],["RJTT","ROIG","羽田 → 石垣"],["RJTT","RJSA","羽田 → 青森"],["RJTT","RJSK","羽田 → 秋田"],["RJTT","RJEC","羽田 → 旭川"],["RJTT","RJFR","羽田 → 北九州"],["RJTT","RJOK","羽田 → 高知"],["ROAH","ROIG","那覇 → 石垣"],["RJCC","RJCH","新千歳 → 函館"],["RJBB","ROIG","関西 → 石垣"],["RJOO","RJFT","伊丹 → 熊本"],["RJOO","RJSN","伊丹 → 新潟"],["RJFF","RJFU","福岡 → 長崎"]].filter(p=>game.ap.ap[p[0]]&&game.ap.ap[p[1]]);
  $("oPreset").innerHTML="<option value=''>（自分で選ぶ）</option>"+PRESETS.map((p,i)=>"<option value='"+i+"'>"+p[2]+"</option>").join("");
  const syncRoute=()=>{ const m=scn(); const useFrom=(m!=="app"), useFR=(m==="gate"||m==="rwy");
    $("rowFrom").style.display=useFrom?"":"none"; $("rowFromRwy").style.display=useFR?"":"none";
    if($("oFromRwy").dataset.ap!==$("oFrom").value){ fillRwy($("oFromRwy"),$("oFrom").value,"自動（目的地の方向）"); $("oFromRwy").dataset.ap=$("oFrom").value; }
    if($("oRwy").dataset.ap!==$("oDest").value){ fillRwy($("oRwy"),$("oDest").value,"自動（進入方向に合う滑走路）"); $("oRwy").dataset.ap=$("oDest").value; } };
  $("oFrom").value="RJOB"; $("oDest").value="RJTT";
  document.querySelectorAll("input[name=scn]").forEach(e=>e.onchange=syncRoute); $("oFrom").onchange=()=>{ $("oPreset").value=""; syncRoute(); }; $("oDest").onchange=()=>{ $("oPreset").value=""; syncRoute(); };
  $("oPreset").onchange=()=>{ const v=$("oPreset").value; if(v==="") return; const p=PRESETS[+v]; $("oFrom").value=p[0]; $("oDest").value=p[1]; syncRoute(); };
  syncRoute();
  $("bStart").onclick=()=>{
    audio.start(); const id=scn(); const o={id,hour:+$("oHour").value,cloud:$("oCloud").value,wx:{wind:$("oWind").value},fuelMode:$("oFuel")?$("oFuel").value:"std"};
    o.dest={icao:$("oDest").value,rwy:$("oRwy").value}; if(id!=="app") o.from={icao:$("oFrom").value,rwy:$("oFromRwy").value};
    if(id!=="app"&&o.from.icao===o.dest.icao&&id!=="cruise"){ /* 同じ空港への往復も可（離陸して戻る） */ }
    game.startScenario(o); showPlay(true); setTimeout(layout,0);
  };
  $("bHelp2").onclick=()=>{ $("help").style.display="flex"; }; $("bHelp").onclick=()=>{ $("help").style.display="flex"; game.paused=true; }; $("hClose").onclick=()=>{ $("help").style.display="none"; if($("pause").style.display!=="flex") game.paused=false; };
  addEventListener("keydown",e=>{ if(e.key==="?"||e.key==="/"&&e.shiftKey){ $("help").style.display=$("help").style.display==="flex"?"none":"flex"; } });
  $("bPause").onclick=()=>game.pauseMenu();
  $("pResume").onclick=()=>{ $("pause").style.display="none"; game.paused=false; };
  $("pRetry").onclick=()=>{ $("pause").style.display="none"; game.startScenario(game.sceneId); };
  $("pMenu").onclick=()=>{ $("pause").style.display="none"; game.state="menu"; game.paused=false; game.acft.root.visible=false; $("menu").style.display="flex"; showPlay(false); };
  function showPlay(on){ for(const id of ["mcp","topright","bar","thr","inst"]) $(id).style.display=on?(id==="mcp"||id==="topright"?"flex":"block"):"none"; if(on&&matchMedia("(pointer:coarse)").matches) $("touch").style.display="block"; if(!on) $("touch").style.display="none"; if(on) layout(); }
  // ---------------- ボタン ----------------
  $("bEasy").onclick=()=>game.keyDown({code:"KeyU"}); if(game.easy) $("bEasy").classList.toggle("on",game.easy.on);
  $("bView").onclick=()=>game.cycleView(); $("bMap").onclick=()=>{ if(game.FS&&game.FS.map) game.FS.map.cycle(); }; $("bTime").onclick=()=>{ game.keyDown({code:"KeyT"}); $("bTime").textContent="時間 ×"+game.timeScale; };
  $("bSnd").onclick=()=>{ audio.start(); audio.setMuted(!audio.muted); $("bSnd").textContent=audio.muted?"音 OFF":"音 ON"; };
  $("bGear").onclick=()=>game.keyDown({code:"KeyG"}); $("bFlapUp").onclick=()=>game.keyDown({code:"KeyV"}); $("bFlapDn").onclick=()=>game.keyDown({code:"KeyF"});
  $("bSpoil").onclick=()=>game.keyDown({code:"KeyL"}); $("bAB").onclick=()=>game.keyDown({code:"KeyO"}); $("bPark").onclick=()=>game.keyDown({code:"KeyP"});
  const hold=(id,flag)=>{ const b=$(id); const on=e=>{ game[flag]=true; e.preventDefault(); }, off=()=>{ game[flag]=false; }; b.addEventListener("pointerdown",on); b.addEventListener("pointerup",off); b.addEventListener("pointerleave",off); b.addEventListener("pointercancel",off); };
  hold("bBrake","touchBrake"); hold("bRev","touchRev");
  // ---------------- MCP ----------------
  const rep=(el,fn)=>{ let t=null,i=null; const stop=()=>{ clearTimeout(t); clearInterval(i); }; el.addEventListener("pointerdown",e=>{ e.preventDefault(); fn(1); let n=0; t=setTimeout(()=>{ i=setInterval(()=>{ n++; fn(n>12?10:(n>5?5:1)); },90); },450); }); ["pointerup","pointerleave","pointercancel"].forEach(ev=>el.addEventListener(ev,stop)); };
  document.querySelectorAll("#mcp .pm button").forEach(b=>{ const k=b.dataset.k, d=+b.dataset.d; rep(b,(mul)=>adjust(k,d,mul)); });
  function adjust(k,d,mul){ const a=ap(), s=game.s; mul=mul||1; manual();
    if(k==="spd"){ if(a.spdIsMach){ a.mach=clamp((a.mach||0.78)+d*0.01*(mul>1?1:1),0.4,0.84); } else a.spd=clamp(a.spd/KT+d*mul,120,340)*KT; }
    else if(k==="hdg"){ a.hdg=((a.hdg/D2R+d*mul)%360+360)%360*D2R; if(a.on&&a.latMode!=="HDG"&&a.latMode!=="LOC"){ a.latMode="HDG"; } }
    else if(k==="alt"){ a.alt=clamp(Math.round(a.alt/FT/100)*100+d*100*(mul>1?5:1),0,41000)*FT; }
    else if(k==="vs"){ a.vs=clamp(Math.round(a.vs/FT*60/100)*100+d*100*(mul>1?5:1),-3000,3000)*FT/60; if(a.on&&a.vertMode!=="VS"&&a.vertMode!=="GS") a.vertMode="VS"; }
    sync(); }
  const manual=()=>{ if(game.autoFlight) game.stopAutoFlight("オート航行を解除（手動の設定に切り替えました）"); };
  const need=()=>{ if(game.state!=="fly") return false; if(game.s.onGround){ game.say("離陸後に使えます","#ffb11a"); return false; } return true; };
  $("bAP").onclick=()=>{ if(game.state==="fly") game.toggleAP(); };
  $("bAT").onclick=()=>{ if(!need()) return; manual(); const a=ap(); a.athr=!a.athr; if(a.athr&&!a.on){ /* 推力だけ自動 */ a.on=true; a.latMode="HDG"; a.hdg=game.s.psi; a.vertMode="ALT"; a.alt=Math.round(game.s.pos[1]/FT/100)*100*FT; } sync(); };
  $("bLNAV").onclick=()=>{ if(!need()) return; manual(); const a=ap(); if(!game.route.length){ game.say("経路がありません","#ffb11a"); return; } a.on=true; a.latMode="LNAV"; a.route=game.route; if(a.vertMode==="GS") a.vertMode="ALT"; if(!a.athr){ a.athr=true; a.spd=Math.max(game.s.cas,160*KT); } sync(); };
  $("bHDG").onclick=()=>{ if(!need()) return; manual(); const a=ap(); if(!a.on){ game.toggleAP(true); } a.latMode="HDG"; if(a.hdg==null) a.hdg=game.s.psi; if(!game.hdgTouched){ a.hdg=game.s.psi; } sync(); };
  $("bALT").onclick=()=>{ if(!need()) return; manual(); const a=ap(); if(!a.on) game.toggleAP(true); a.vertMode="ALT"; sync(); };
  $("bVS").onclick=()=>{ if(!need()) return; manual(); const a=ap(); if(!a.on) game.toggleAP(true); a.vs=Math.round(game.s.vs/FT*60/100)*100*FT/60; a.vertMode="VS"; sync(); };
  $("bFLCH").onclick=()=>{ if(!need()) return; manual(); const a=ap(), s=game.s; if(!a.on) game.toggleAP(true); a.vertMode="FLCH"; a.athr=true; if(s.pos[1]>7600){ a.spdIsMach=true; a.mach=a.mach||0.78; } else { a.spdIsMach=false; a.spd=Math.min(Math.max(a.spd,200*KT),s.pos[1]<3050?250*KT:290*KT); } sync(); };
  $("bAPPR").onclick=()=>{ if(game.state==="fly") game.pressAPPR(); sync(); };
  $("bMACH").onclick=()=>{ const a=ap(), s=game.s; manual(); if(a.spdIsMach){ a.spdIsMach=false; a.spd=Math.max(150*KT,s.cas); } else { a.spdIsMach=true; a.mach=clamp(s.mach,0.5,0.82); } sync(); };
  function sync(){
    const a=ap(), s=game.s; if(game.state==="menu"||game.state==="loading") return;
    $("vspd").textContent=a.spdIsMach?"."+String(Math.round((a.mach||0.78)*100)):String(Math.round(a.spd/KT)); $("lblspd").textContent=a.spdIsMach?"マッハ MACH":"速度 SPD(kt)";
    $("vhdg").textContent=String(Math.round((a.hdg/D2R+MV()+360)%360)).padStart(3,"0"); $("valt").textContent=String(Math.round(a.alt/FT/100)*100);
    const vs=Math.round(a.vs/FT*60/100)*100; $("vvs").textContent=(vs>=0?"+":"")+vs;
    const set=(id,on,cls)=>{ const b=$(id); b.classList.toggle("on",!!on); };
    set("bAP",a.on); set("bAT",a.on&&a.athr); set("bLNAV",a.on&&a.latMode==="LNAV"); set("bHDG",a.on&&a.latMode==="HDG"); set("bALT",a.on&&a.vertMode==="ALT"); set("bVS",a.on&&a.vertMode==="VS"); set("bFLCH",a.on&&a.vertMode==="FLCH"); set("bAPPR",a.on&&a.latMode==="LOC");
    const p=game.pilot; set("bGear",p.gearTarget>0.5); set("bSpoil",p.spoilerArm); set("bPark",p.parking); set("bAB",p.autobrake>0); $("bAB").textContent="オートブレーキ "+["OFF","1","2","3","MAX"][p.autobrake]+" (O)";
    $("bFlapDn").title="フラップ "+[0,1,2,5,10,15,25,30,40][Math.round(p.flapsTarget)];
  }
  game.mcpSync=sync; setInterval(sync,200);
  // ---------------- スロットル ----------------
  const thr=$("thr"); let dragT=false; const setT=e=>{ const r=thr.getBoundingClientRect(); const v=clamp(1-(e.clientY-r.top)/r.height,0,1); game.pilot.throttle=Math.round(v*50)/50; };
  thr.addEventListener("pointerdown",e=>{ dragT=true; thr.setPointerCapture(e.pointerId); setT(e); e.preventDefault(); }); thr.addEventListener("pointermove",e=>{ if(dragT) setT(e); }); thr.addEventListener("pointerup",()=>{ dragT=false; });
  // ---------------- タッチ（仮想スティック） ----------------
  const st=$("stick"), kn=$("knob"); let sid=null; const mv=e=>{ const r=st.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2; let dx=(e.clientX-cx)/(r.width/2), dy=(e.clientY-cy)/(r.height/2); const L=Math.hypot(dx,dy); if(L>1){ dx/=L; dy/=L; } kn.style.left=(45+dx*45)+"px"; kn.style.top=(45+dy*45)+"px"; game.touchRoll=dx; game.touchPitch=dy; };
  st.addEventListener("pointerdown",e=>{ sid=e.pointerId; st.setPointerCapture(sid); mv(e); e.preventDefault(); }); st.addEventListener("pointermove",e=>{ if(e.pointerId===sid) mv(e); });
  const rel=()=>{ sid=null; kn.style.left="45px"; kn.style.top="45px"; game.touchRoll=0; game.touchPitch=0; }; st.addEventListener("pointerup",rel); st.addEventListener("pointercancel",rel);
  const tb=$("tbtns"); for(const [t,k] of [["ギア","KeyG"],["F＋","KeyF"],["F−","KeyV"],["視点","KeyC"],["AP","Enter"],["ILS","KeyI"]]){ const b=document.createElement("button"); b.textContent=t; b.onclick=()=>game.keyDown({code:k}); tb.appendChild(b); }
  // ---------------- レイアウト ----------------
  const frame=$("frame"), fx=frame.getContext("2d"), inst=$("inst");
  function layout(){
    const W=innerWidth,H=innerHeight, dpr=Math.min(devicePixelRatio||1,2);
    frame.width=W*dpr; frame.height=H*dpr; fx.setTransform(dpr,0,0,dpr,0,0); fx.clearRect(0,0,W,H);
    const cockpit=document.body.classList.contains("v-cockpit"), win=document.body.classList.contains("v-window");
    // 計器の大きさ
    const base=Math.min(W*0.98,940*Math.max(0.5,H/820)), scale=cockpit?1:0.62; const iw=Math.round(Math.min(W*0.98,base*(cockpit?1:0.62))), ih=Math.round(iw*310/940);
    inst.style.width=iw+"px"; inst.style.height=ih+"px"; hud.size(iw,ih,dpr); inst.style.opacity=cockpit?1:0.93; $("hint").style.bottom=(ih+(cockpit?18:16))+'px'; inst.style.bottom=(cockpit?0:6)+"px";
    if(cockpit){ // 窓枠と計器盤
      const py=H-ih-10; // 計器盤の上端
      let g=fx.createLinearGradient(0,py,0,H); g.addColorStop(0,"#2c333a"); g.addColorStop(0.08,"#1b2026"); g.addColorStop(1,"#101317"); fx.fillStyle=g; fx.fillRect(0,py,W,H-py);
      // グレアシールド
      fx.fillStyle="#14181d"; fx.beginPath(); fx.moveTo(0,py+6); fx.quadraticCurveTo(W/2,py-34,W,py+6); fx.lineTo(W,py+30); fx.lineTo(0,py+30); fx.closePath(); fx.fill();
      g=fx.createLinearGradient(0,py-26,0,py+6); g.addColorStop(0,"rgba(255,255,255,0.0)"); g.addColorStop(1,"rgba(255,255,255,0.08)"); fx.fillStyle=g; fx.fillRect(0,py-30,W,36);
      // 前方の窓柱
      fx.fillStyle="#171b20"; fx.beginPath(); fx.moveTo(0,0); fx.lineTo(W*0.085,0); fx.lineTo(W*0.035,py+8); fx.lineTo(0,py+8); fx.closePath(); fx.fill();
      fx.beginPath(); fx.moveTo(W,0); fx.lineTo(W*0.915,0); fx.lineTo(W*0.965,py+8); fx.lineTo(W,py+8); fx.closePath(); fx.fill();
      fx.fillStyle="#1d2228"; fx.beginPath(); fx.moveTo(W*0.485,0); fx.lineTo(W*0.515,0); fx.lineTo(W*0.505,py-24); fx.lineTo(W*0.495,py-24); fx.closePath(); fx.fill();
      fx.fillStyle="#12161a"; fx.fillRect(0,0,W,Math.max(10,H*0.025));
    } else if(win){
      // 客室の窓（角丸の穴）
      const ww=Math.min(W*0.62,H*0.9*0.78), wh=Math.min(H*0.72,ww*1.25), x0=(W-ww)/2, y0=(H-wh)/2-H*0.02;
      fx.fillStyle="#d8d4cc"; fx.beginPath(); fx.rect(0,0,W,H); const r=Math.min(ww,wh)*0.28; fx.moveTo(x0+r,y0); fx.arcTo(x0+ww,y0,x0+ww,y0+wh,r); fx.arcTo(x0+ww,y0+wh,x0,y0+wh,r); fx.arcTo(x0,y0+wh,x0,y0,r); fx.arcTo(x0,y0,x0+ww,y0,r); fx.closePath(); fx.fill("evenodd");
      fx.strokeStyle="rgba(0,0,0,.55)"; fx.lineWidth=10; fx.beginPath(); fx.moveTo(x0+r,y0); fx.arcTo(x0+ww,y0,x0+ww,y0+wh,r); fx.arcTo(x0+ww,y0+wh,x0,y0+wh,r); fx.arcTo(x0,y0+wh,x0,y0,r); fx.arcTo(x0,y0,x0+ww,y0,r); fx.closePath(); fx.stroke();
      fx.fillStyle="rgba(60,56,50,.35)"; fx.fillRect(0,0,W,H*0.0);
    }
  }
  addEventListener("resize",layout); new MutationObserver(layout).observe(document.body,{attributes:true,attributeFilter:["class"]}); layout();
  return {sync,layout,showPlay};
}
root.bindUI=bindUI;
})(typeof window!=="undefined"?window:globalThis);
