/* ゲーム本体: シナリオ配置、物理ステップ、操作入力、視点、計器データの組み立て、警報・ガイド。
   座標は x=東, z=南(北が -z), y=海抜高度[m]。方位は真方位（rad）で持ち、表示のときだけ磁方位（+7.5°）にする。 */
(function(root){
"use strict";
const G=root.GEO, F=root.FDM, C=root.FCS, D2R=Math.PI/180, KT=F.KT, FT=0.3048, NM=1852, MV=()=>root.MAGVAR_NOW||7.5;
const clamp=F.clamp, n180=a=>((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
const $=id=>document.getElementById(id);
const TAXI=root.TAXI, GATE_REF="3", NOSE_X=13.0;   // 岡山桃太郎空港は 3 番ゲート固定。ほかの空港は自動でゲートを選ぶ
const magDeg=r=>(((r/D2R)+MV())%360+360)%360;
const fmtClock=h=>{ const hh=Math.floor(h)%24, mm=Math.floor((h%1)*60); return String(hh).padStart(2,"0")+":"+String(mm).padStart(2,"0"); };

// ---------------- 経路（地名だけの簡略経路。実在の航空路・手順ではない） ----------------
const GEO_WPT={ himeji:[34.8394,134.6939,"姫路"], kyoto:[35.0116,135.7681,"京都"], nagoya:[35.1815,136.9066,"名古屋"], shizuoka:[34.98,138.38,"静岡"], fuji:[35.3606,138.7274,"富士山"] };
// 目的地・滑走路ごとの進入経路（進入開始点と最終進入点は滑走路の延長線上に計算で置く）
function buildApproachRoute(ap, icao, rwy, base){
  const re=ap.runwayEnd(icao,rwy); if(!re) return base.slice();
  const e=re.e; const dir=[e.ux,e.uz];    // 着陸方向（滑走路の内向き）
  const pt=(d,name)=>({x:e.x-dir[0]*d,z:e.z-dir[1]*d,name});
  return base.concat([pt(40000,"進入開始点"),pt(19000,"最終進入点")]);
}
function baseRouteToTokyo(){
  return ["himeji","kyoto","nagoya","shizuoka","fuji"].map(k=>{ const w=GEO_WPT[k], p=G.ll2xz(w[0],w[1]); return {x:p[0],z:p[1],name:w[2]}; });
}

class Game{
  constructor(FS, opts){
    this.FS=FS; this.T=FS.T; this.scene=FS.scene; this.camera=FS.camera; this.terrain=FS.terrain; this.sky=FS.sky; this.ap=FS.ap; this.lights=FS.lights; this.bld=FS.bld;
    this.cam={x:0,y:500,z:0}; this.view="chase"; this.camZoom=1; this.look={yaw:0,pitch:0}; this.orbit={az:0.55,el:0.18,d:62}; this.smPsi=0;
    this.keys={}; this.pilot={pitch:0,roll:0,yaw:0,throttle:0,brake:0,parking:false,speedbrake:0,reverse:false,flapsTarget:0,gearTarget:1,trim:0,autobrake:0,spoilerArm:false,eng:[true,true]};
    this.c=C.create(); this.s=F.createState({}); this.env={groundAt:(x,z)=>this.groundAt(x,z),wind:[0,0,0],turb:0};
    this.state="menu"; this.timeScale=1; this.paused=false; this.hint=true; this.msgQ=[]; this.sceneId=null; this.pending=null; this.ndRange=20;
    this.light={hemi:new this.T.HemisphereLight(0xffffff,0x444444,1.0), sun:new this.T.DirectionalLight(0xffffff,1.6)}; this.scene.add(this.light.hemi,this.light.sun);
    this.acft=new Aircraft(this.T,{}); this.scene.add(this.acft.root); this.acft.root.visible=false; this.lightsOn={nav:true,strobe:false,beacon:false,landing:false,taxi:false,logo:false};
    this.vsp={v1:0,vr:0,v2:0,vref:0}; this.route=[]; this.audio=opts.audio; this.hud=opts.hud; this.wx={wind:0,dir:0,jet:0,turb:0}; this.log={};
    this.assistConfig=true; this.simT=0; this.groundCache=null; this.warn=[]; this.eventT=0; this.touch=null; this.t=0; this.stats={};
    this.makeTug();
    this.bindInput();
  }
  // プッシュバック用のトーイングカー（箱を組み合わせた簡単な形）
  makeTug(){
    const T=this.T, g=new T.Group(); const mat=(c)=>new T.MeshLambertMaterial({color:c});
    const box=(w,h,l,x,y,z,c)=>{ const m=new T.Mesh(new T.BoxGeometry(w,h,l),mat(c)); m.position.set(x,y,z); g.add(m); return m; };
    box(2.5,0.9,6.0,0,0.85,0,0xe2b100); box(2.3,1.1,2.4,0,1.85,-1.2,0x24303c); box(2.5,0.35,0.5,0,0.5,3.05,0x222222);
    for(const sx of [-1,1]) for(const z of [-2.0,2.0]) box(0.5,1.0,1.0,sx*1.3,0.5,z,0x151515);
    box(0.25,0.25,4.2,0,0.55,5.0,0x555555);     // トーバー（機首側へ）
    g.visible=false; this.scene.add(g); this.tug=g;
  }
  updateTug(){
    const g=this.tug, s=this.s; if(!g) return; if(!(this.push&&this.state==="fly")){ g.visible=false; return; }
    const fw=[Math.sin(s.psi),-Math.cos(s.psi)]; const d=NOSE_X+7.2; const x=s.pos[0]+fw[0]*d, z=s.pos[2]+fw[1]*d; const h=this.terrain.heightAt(x,z);
    g.visible=true; g.position.set(x-this.cam.x,h+0.12,z-this.cam.z); g.rotation.y=-s.psi;    // 車体の +z 側（トーバー）が機首のほうを向く
  }
  // ---------------- 地面 ----------------
  groundAt(x,z){
    const gc=this.groundCache; if(gc&&gc.on) return gc.v;
    const h=this.terrain.heightAt(x,z); let kind=this.ap.kindAt(x,z); if(!kind) kind=(h<=0.7?"water":"grass");
    return {h,kind};
  }
  // ---------------- シナリオ ----------------
  startScenario(o){
    this.sceneId=o; this.state="loading"; this.paused=false; this.ended=false; this.stats={}; this.log={}; this.pending=o; this.wxOpts=o.wx||{}; this.loadT=0;
    this.startHour=o.hour!=null?o.hour:14; this.sky.setHour(this.startHour); this.sky.cover=({clear:0.08,fair:0.35,cloudy:0.7}[o.cloud||"fair"]); this.sky.cloudBase=o.cloud==="cloudy"?1500:2000;
    this.sky.turb=0; this.wx.turbBase=({clear:0.0,fair:0.12,cloudy:0.3}[o.cloud||"fair"]);
    this.c=C.create(); this.acft.root.visible=false; this.msgQ=[]; this.setMsg("");
    // 開始地点付近の地形・空港をあらかじめ読み込ませる
    const p=this.startPoint(o); this.cam.x=p.x; this.cam.z=p.z; this.cam.y=p.alt+80; this.loadHold=p;
    $("menu").style.display="none"; $("end").style.display="none"; $("loadmsg").style.display="block"; $("loadmsg").textContent="地形・空港を読み込み中…";
  }
  // ---- シナリオの正規化: {mode: gate|rwy|app|cruise, from:{icao,rwy}, dest:{icao,rwy}} ----
  rwyList(icao){ const a=this.ap.ap[icao]; const out=[]; if(!a) return out; for(const r of a.runways) for(const e of r.ends) out.push({name:e.name,L:r.L}); return out; }
  apName(icao){ const a=this.ap.ap[icao]; return (a&&a.info&&a.info.short)||icao; }
  // 滑走路を自動で選ぶ: 離陸なら目的地の方向へ、着陸なら進入してくる方向へ向く滑走路（短い滑走路は避ける）
  rankRwy(icao,tx,tz,arrive){
    const list=this.rwyList(icao); if(!list.length) return [];
    const maxL=Math.max(...list.map(q=>q.L)); const out=[];
    for(const q of list){ const e=this.ap.runwayEnd(icao,q.name).e; const dx=tx-e.x, dz=tz-e.z, d=Math.hypot(dx,dz)||1; let c=(dx*e.ux+dz*e.uz)/d; if(arrive) c=-c;
      out.push({name:q.name,sc:c+(q.L>=Math.min(2000,maxL*0.9)?0.3:-1)+0.1*q.L/maxL}); }
    return out.sort((a,b)=>b.sc-a.sc).map(q=>q.name);
  }
  pickRwy(icao,want,tx,tz,arrive){
    const list=this.rwyList(icao); if(!list.length) return want; if(want&&want!=="auto"&&list.some(q=>q.name===want)) return want;
    return this.rankRwy(icao,tx,tz,arrive)[0];
  }
  resolveSpec(o){
    const id=o.id; let mode=o.mode, from=o.from?Object.assign({},o.from):null, dest=o.dest?Object.assign({},o.dest):null;
    if(id==="rjob_gate"){ mode="gate"; from={icao:"RJOB",rwy:"07"}; }
    else if(id==="rjob_to"){ mode="rwy"; from={icao:"RJOB",rwy:"07"}; }
    else if(id==="rjob_app"){ mode="app"; dest={icao:"RJOB",rwy:"25"}; }
    else if(id==="rjtt_app"){ mode="app"; dest={icao:"RJTT",rwy:o.rwy||"16L"}; }
    else if(id==="cruise"&&!from){ mode="cruise"; from=null; }
    else if(id==="gate"||id==="rwy"||id==="app"||id==="cruise") mode=id;
    if(!dest) dest={icao:"RJTT",rwy:o.rwy||"16L"};
    const A=this.ap; const refOf=icao=>{ const a=A.ap[icao]; return a?a.ref:[0,0]; };
    const spec={mode,from,dest,legacy:!!(id==="rjob_gate"||id==="rjob_to"||id==="rjob_app"||id==="rjtt_app"||(id==="cruise"&&!o.from))};
    if(mode==="gate"||mode==="rwy"){
      const dr=refOf(dest.icao); const wantAuto=!from.rwy||from.rwy==="auto";
      if(mode==="gate"&&wantAuto){   // 自動のときは、ゲートからの誘導路が作れる滑走路を優先する
        const rank=this.rankRwy(from.icao,dr[0],dr[1],false); let found=null;
        for(const nm of rank){ const pl=this.planGate(from.icao,nm); if(pl){ found={nm,pl}; break; } }
        if(found){ from.rwy=found.nm; spec.plan=found.pl; } else from.rwy=rank[0];
      } else from.rwy=this.pickRwy(from.icao,from.rwy,dr[0],dr[1],false);
      const e=A.runwayEnd(from.icao,from.rwy).e; spec.dep=e;
      // 到着滑走路: 出発地から来る方向に合わせる
      dest.rwy=this.pickRwy(dest.icao,dest.rwy,e.x,e.z,true);
    } else if(mode==="app"){
      const r=refOf(dest.icao); dest.rwy=this.pickRwy(dest.icao,dest.rwy,r[0]-1e5,r[1],true);
    } else {
      const from2=from||{icao:"RJOO"}; const r0=from?refOf(from.icao):G.ll2xz(GEO_WPT.nagoya[0],GEO_WPT.nagoya[1]); dest.rwy=this.pickRwy(dest.icao,dest.rwy,r0[0],r0[1],true);
    }
    if(mode==="gate"){ if(!spec.plan){ const plan=this.planGate(from.icao,from.rwy); if(plan) spec.plan=plan; } if(!spec.plan){ spec.mode="rwy"; spec.noGate=true; } }
    return spec;
  }
  startScenario(o){
    this.sceneId=o; this.state="loading"; this.paused=false; this.ended=false; this.stats={}; this.log={}; this.pending=o; this.wxOpts=o.wx||{}; this.loadT=0;
    this.startHour=o.hour!=null?o.hour:14; this.sky.setHour(this.startHour); this.sky.cover=({clear:0.08,fair:0.35,cloudy:0.7}[o.cloud||"fair"]); this.sky.cloudBase=o.cloud==="cloudy"?1500:2000;
    this.sky.turb=0; this.wx.turbBase=({clear:0.0,fair:0.12,cloudy:0.3}[o.cloud||"fair"]);
    this.c=C.create(); this.acft.root.visible=false; this.msgQ=[]; this.setMsg("");
    this.spec=this.resolveSpec(o); this.destRwy={icao:this.spec.dest.icao,name:this.spec.dest.rwy};
    // 開始地点付近の地形・空港をあらかじめ読み込ませる
    const p=this.startPoint(this.spec); this.cam.x=p.x; this.cam.z=p.z; this.cam.y=p.alt+80; this.loadHold=p;
    $("menu").style.display="none"; $("end").style.display="none"; $("loadmsg").style.display="block"; $("loadmsg").textContent="地形・空港を読み込み中…";
  }
  cruiseStart(spec){   // 巡航開始位置: 出発地から目的地へ向かう直線上で、最終進入点の手前
    const A=this.ap, d=spec.dest; const e=A.runwayEnd(d.icao,d.rwy).e; const f=[e.x-e.ux*42000,e.z-e.uz*42000];
    if(!spec.from) { const p=G.ll2xz(GEO_WPT.nagoya[0],GEO_WPT.nagoya[1]); return {x:p[0],z:p[1],alt:10668,R:Math.hypot(p[0]-f[0],p[1]-f[1])+42000}; }
    const a=A.ap[spec.from.icao].ref; const D=Math.hypot(a[0]-f[0],a[1]-f[1])||1; const R=Math.min(230000,0.65*D);
    const x=f[0]+(a[0]-f[0])/D*R, z=f[1]+(a[1]-f[1])/D*R; const h=A.runwayEnd(d.icao,d.rwy).h||0;
    return {x,z,alt:clamp(h+(R-45000)*0.045,3000,10668),R:R+42000};
  }
  startPoint(spec){
    const A=this.ap;
    if(spec.mode==="gate"&&spec.plan){ const st=spec.plan.stand; return {x:st.stop[0],z:st.stop[1],alt:(A.runwayEnd(spec.from.icao,spec.from.rwy).h||0)+30}; }
    if(spec.mode==="gate"||spec.mode==="rwy"){ const re=A.runwayEnd(spec.from.icao,spec.from.rwy); return {x:re.e.x,z:re.e.z,alt:(re.h||0)+30}; }
    if(spec.mode==="app"){ const re=A.runwayEnd(spec.dest.icao,spec.dest.rwy); return {x:re.e.x-re.e.ux*3000,z:re.e.z-re.e.uz*3000,alt:(re.h||0)+600}; }
    if(spec.mode==="cruise"){ const c=this.cruiseStart(spec); return {x:c.x,z:c.z,alt:c.alt}; }
    return {x:0,z:0,alt:1000};
  }
  ready(dt){   // 読み込み完了の判定
    const o=this.pending; if(!o) return false; const A=this.ap; this.loadT+=dt; const sp=this.spec;
    const icaoNeed=(sp.mode==="gate"||sp.mode==="rwy")?sp.from.icao:(sp.mode==="app"?sp.dest.icao:null);
    const loaded=this.terrain.settled();
    if(icaoNeed){ const a=A.ap[icaoNeed]; if(!a.built) return this.loadT>120; return loaded||this.loadT>30; }
    return loaded||this.loadT>6;
  }
  // 出発地から目的地までの経路（地名だけの簡略経路。実在の航空路・手順ではない）
  routeFor(spec,depE){
    const A=this.ap, d=spec.dest; const re=A.runwayEnd(d.icao,d.rwy).e; const pt=(dd,name)=>({x:re.x-re.ux*dd,z:re.z-re.uz*dd,name});
    const fin=[pt(42000,"進入開始点"),pt(19000,"最終進入点")];
    if(spec.from&&spec.from.icao==="RJOB"&&d.icao==="RJTT") return baseRouteToTokyo().concat(fin);
    const out=[]; const a=depE?[depE.x,depE.z]:[A.ap[spec.from.icao].ref[0],A.ap[spec.from.icao].ref[1]];
    const f=[fin[0].x,fin[0].z]; const D=Math.hypot(f[0]-a[0],f[1]-a[1])||1; const cs=((f[0]-a[0])*re.ux+(f[1]-a[1])*re.uz)/D;
    if(cs<0.35){   // 進入方向と逆側から来る場合は、横から回り込んで最終進入コースに入る
      const nx=-re.uz, nz=re.ux; const mk=sg=>[re.x-re.ux*60000+nx*sg*45000, re.z-re.uz*60000+nz*sg*45000];
      const p1=mk(1), p2=mk(-1); const p=(Math.hypot(p1[0]-a[0],p1[1]-a[1])<Math.hypot(p2[0]-a[0],p2[1]-a[1]))?p1:p2; out.push({x:p[0],z:p[1],name:"進入経路"});
    }
    return out.concat(fin);
  }
  routeLen(route,s){ let L=0,px=s[0],pz=s[1]; for(const w of route){ L+=Math.hypot(w.x-px,w.z-pz); px=w.x; pz=w.z; } return L; }
  placeAircraft(o){
    const A=this.ap, T=this.terrain; const spec=this.spec; const mode0=spec.mode;
    let fuel=o.fuel; if(fuel==null){ if(spec.legacy) fuel=(mode0==="app"?(spec.dest.icao==="RJOB"?5200:2600):(mode0==="cruise"?3200:5200)); else if(mode0==="app") fuel=2600; }
    const s=F.createState({fuel:fuel!=null?fuel:5200}); this.s=s; const c=this.c, ap=c.ap, pilot=this.pilot;
    Object.assign(pilot,{pitch:0,roll:0,yaw:0,throttle:0,brake:0,parking:false,speedbrake:0,reverse:false,flapsTarget:0,gearTarget:1,trim:0,autobrake:0,spoilerArm:false});
    ap.on=false; ap.athr=false; this.route=[]; ap.route=null; ap.wpIndex=0; ap.loc=null; ap.appr=false; this.apprState=null; this.landed=false; this.touchRep=null; this.firstThr=false; this.todPt=null; this.rwyFocus=null; this.takeoffRwy=null; this.takeoffRef=null; this.cruiseAlt=null; this.autoFlight=false; this.af=null;
    this.ndRange=20; this.vStall=null;
    // 天候（風）
    const wxo=this.wxOpts||{}; this.wx.windKt=({calm:0,light:8,cross:14,strong:22}[wxo.wind||"light"]); this.wx.jet=({calm:0,light:18,cross:22,strong:30}[wxo.wind||"light"]);
    this.wx.turb=this.wx.turbBase||0; this.env.turb=this.wx.turb;
    const setAir=(x,z,alt,hdgTrue,cas,thr,flaps,gear)=>{ s.pos=[x,alt,z]; const a=F.atmos(alt); const tas=cas*KT/Math.sqrt(a.sigma); s.q=F.eulerToQ(hdgTrue,2.5*D2R,0); F.derived(s); s.vel=[s.fwd[0]*tas,0,s.fwd[2]*tas]; s.thr=[thr,thr]; pilot.throttle=thr; s.flaps=s.flapsTarget=flaps; pilot.flapsTarget=flaps; s.gear=s.gearTarget=gear; pilot.gearTarget=gear; F.derived(s); this.s.onGround=false; };
    let windFrom=null, mode=mode0;
    this.push=null; this.autoTaxi=null; this.taxiPhase=null; this.taxiPlan=null; this.arrival=null; this.arrivalPlan=null; this.autoTO=null; this.autoPitch=0; if(this.FS.pk) for(const k of Object.keys(A.ap)) this.FS.pk.release(k);
    const dest=spec.dest;
    const fuelFor=(Lm)=>{ const cap=79000*0.97-F.AC.emptyMass-F.AC.payload; return Math.round(Math.min(Math.max(3500,2500+3.4*Lm/1000),cap,14000)/100)*100; };
    if(mode==="gate"){
      const e=spec.dep, plan=spec.plan; const p0=plan.push.poses[0], fw=[Math.sin(p0.psi),-Math.cos(p0.psi)]; const x=p0.mx-fw[0]*TAXI.MAIN, z=p0.mz-fw[1]*TAXI.MAIN, h=T.heightAt(x,z);
      s.pos=[x,h+3.85-0.16,z]; s.q=F.eulerToQ(p0.psi,0,0); s.vel=[0,0,0]; s.flaps=s.flapsTarget=3; pilot.flapsTarget=3; s.gear=s.gearTarget=1; pilot.parking=true; s.parking=true; s.onGround=true; F.derived(s);
      this.taxiPlan=plan; this.taxiPhase="push"; this.push={i:0,d:0,v:0,t:0}; this.takeoffRwy=e; this.takeoffRef={icao:spec.from.icao,name:spec.from.rwy}; windFrom=e.hdg;
      if(this.FS.pk){ const sw=[]; const cg=(mx,mz,psi)=>TAXI.footprint(mx-Math.sin(psi)*TAXI.MAIN,mz+Math.cos(psi)*TAXI.MAIN,Math.sin(psi),-Math.cos(psi),sw);
        const po=plan.push.poses; for(let i=0;i<po.length;i+=3) cg(po[i].mx,po[i].mz,po[i].psi); const tx=plan.taxi; for(let i=0;i<tx.length;i+=3) cg(tx[i].x,tx[i].z,tx[i].psi);
        this.FS.pk.reserve(spec.from.icao,x,z,30,sw); }
      this.setMsg("プッシュバック中（Enter でスキップ）","#3ddcff",8);
      ap.alt=3000*FT; ap.hdg=e.hdg; ap.spd=250*KT; ap.vs=0; ap.spdIsMach=false;
      this.route=this.routeFor(spec,e);
    } else if(mode==="rwy"){
      const e=spec.dep; const d=60; const x=e.x+e.ux*d, z=e.z+e.uz*d, h=T.heightAt(x,z);
      s.pos=[x,h+3.85-0.16,z]; s.q=F.eulerToQ(e.hdg,0,0); s.vel=[0,0,0]; s.flaps=s.flapsTarget=3; pilot.flapsTarget=3; s.gear=s.gearTarget=1; pilot.parking=true; s.parking=true; F.derived(s);
      this.route=this.routeFor(spec,e); windFrom=e.hdg; this.takeoffRwy=e; this.takeoffRef={icao:spec.from.icao,name:spec.from.rwy};
      this.setMsg(spec.noGate?"この空港はゲート・誘導路のデータが足りないため、滑走路から開始します。スロットルを上げて離陸滑走（Shift / PageUp）":"離陸準備完了。スロットルを上げて離陸滑走（Shift / PageUp）","#ffb11a",8);
      ap.alt=3000*FT; ap.hdg=e.hdg; ap.spd=250*KT; ap.vs=0; ap.spdIsMach=false;
    } else if(mode==="app"){
      const re=A.runwayEnd(dest.icao,dest.rwy), e=re.e; const hdg=e.hdg; const dist=spec.legacy&&dest.icao==="RJOB"?22000:(spec.legacy?28000:26000);
      let alt=spec.legacy?(dest.icao==="RJOB"?re.h+900:3000*FT):re.h+900; if(!spec.legacy){ let mh=0; for(let k=2000;k<=dist;k+=1500){ mh=Math.max(mh,T.heightAt(e.x-e.ux*k,e.z-e.uz*k)); } alt=Math.max(alt,mh+450); }
      const cas=spec.legacy&&dest.icao==="RJOB"?200:220; setAir(e.x-e.ux*dist,e.z-e.uz*dist,alt,hdg,cas,0.38,0,0); pilot.gearTarget=0; s.gear=s.gearTarget=0;
      this.route=[{x:e.x-e.ux*19000,z:e.z-e.uz*19000,name:"最終進入点"}]; windFrom=hdg; ap.alt=alt; ap.hdg=hdg; ap.spd=cas*KT; ap.spdIsMach=false; this.engageBasic(); this.rwyFocus={icao:dest.icao,name:dest.rwy};
    } else if(mode==="cruise"){
      const cs=this.cruiseStart(spec); const e=A.runwayEnd(dest.icao,dest.rwy).e;
      this.route=spec.from?this.routeFor(spec,null):baseRouteToTokyo().slice(3).concat(this.finalRoutePart(o));
      let tgt=this.route.length?this.route[0]:{x:e.x-e.ux*42000,z:e.z-e.uz*42000}; if(!spec.from){ const w=G.ll2xz(35.36,138.73); tgt={x:w[0],z:w[1]}; }
      const hdg=Math.atan2(tgt.x-cs.x,-(tgt.z-cs.z));
      s.fuel=fuel!=null?fuel:Math.max(2200,Math.round((1800+3.4*cs.R/1000)/100)*100); setAir(cs.x,cs.z,cs.alt,hdg,260,0.62,0,0); ap.spdIsMach=true; ap.mach=0.78; ap.spd=270*KT; ap.alt=cs.alt; ap.vertMode="ALT";
      windFrom=270*D2R; this.engageBasic(true);
    }
    if(mode==="gate"||mode==="rwy"){ if(o.fuel==null&&!spec.legacy) s.fuel=fuelFor(this.routeLen(this.route,[spec.dep.x,spec.dep.z])); }
    // 巡航高度の目安（距離が短い路線では低くする）
    { const st=[s.pos[0],s.pos[2]]; const Lr=(mode==="app")?0:this.routeLen(this.route,st)+(this.takeoffRwy?0:0);
      const capH=(Lr-30000)/30.5; this.cruiseAlt=(mode==="app")?35000*FT:(mode==="cruise")?Math.max(s.pos[1],6000*FT):clamp(Math.floor(capH/FT/1000)*1000,4000,35000)*FT; if(spec.legacy&&(mode==="gate"||mode==="rwy")) this.cruiseAlt=35000*FT; }
    // 風（滑走路に合わせた風向き）
    const wk=this.wx.windKt*KT; let wf=windFrom!=null?windFrom:270*D2R; const wxw=wxo.wind||"light"; if(wxw==="cross") wf+=60*D2R; else if(wxw==="light"||wxw==="strong") wf+=8*D2R; this.wx.dirFrom=wf; this.wx.speed=wk;
    this.updateWind();
    const mass=F.AC.emptyMass+F.AC.payload+s.fuel; const kv=(mass-50000)/1000;
    this.vsp={v1:Math.round(132+1.5*kv),vr:Math.round(135+1.5*kv),v2:Math.round(145+1.5*kv),vref:Math.round(135+1.3*kv)};
    ap.route=this.route; ap.wpIndex=0; this.stats.startFuel=s.fuel; this.stats.t0=this.t;
    this.state="fly"; this.pending=null; $("loadmsg").style.display="none"; this.acft.root.visible=true; this.applyView(this.view); this.sound("start");
    if(mode==="cruise") this.startAutoFlight(true);   // 巡航中から: 最初からオート航行（降下〜ILS進入まで自動）
  }
  planGate(icao,rwy){
    const d=this.ap.data&&this.ap.data[icao]; if(!d) return null; const re=this.ap.runwayEnd(icao,rwy); if(!re) return null;
    try{ let p=null; if(icao==="RJOB"&&rwy==="07") p=TAXI.planDeparture(d,GATE_REF,re.e); if(!p) p=TAXI.autoPlan(d,re.e); return p; }catch(err){ console.error(err); return null; }
  }
  finalRoutePart(o){ const dest=this.spec?this.spec.dest:(o.dest||{icao:"RJTT",rwy:o.rwy||"16L"}); const A=this.ap; const re=A.runwayEnd(dest.icao,dest.rwy); if(!re) return []; const e=re.e; const pt=(d,name)=>({x:e.x-e.ux*d,z:e.z-e.uz*d,name}); return [pt(42000,"進入開始点"),pt(19000,"最終進入点")]; }
  engageBasic(cruise){ const ap=this.c.ap; ap.on=true; ap.athr=true; ap.latMode=this.route.length>0&&cruise?"LNAV":"HDG"; ap.vertMode=cruise?"ALT":"ALT"; if(!cruise){ ap.alt=Math.round(this.s.pos[1]/(100*FT))*100*FT; } }
  updateWind(){
    const s=this.s, wx=this.wx; const hAGL=Math.max(0,s.pos[1]); const f=clamp(hAGL/9000,0,1);
    // 地表風 → 上空ほど強い西風（ジェット気流）。風向は高度で西風へ寄せる
    const sp=wx.speed*(1-f)+wx.jet*KT*f; let dir=wx.dirFrom; const to=270*D2R; const dd=n180(to-dir); dir=dir+dd*f*0.8;
    this.env.wind=[-sp*Math.sin(dir),0,sp*Math.cos(dir)]; this.wx.curSpd=sp; this.wx.curDir=dir; this.env.turb=wx.turb*(s.pos[1]<2500?1:(s.pos[1]>9000?0.2:0.55));
  }
  // ---------------- 毎フレーム ----------------
  frame(dt){
    this.t+=dt;
    if(this.state==='fly'||this.state==='crashed'){ const ll=G.xz2ll(this.s.pos[0],this.s.pos[2]); root.MAGVAR_NOW=clamp(4.9+0.24*(ll[0]-26),4,10); }   // 磁気偏角の近似（西偏。那覇 約5° 〜 札幌 約9°）
    if(this.state==="loading"){ this.pollLoad(dt); this.updateEnvironment(); return; }
    if(this.state!=="fly"&&this.state!=="crashed") { this.updateEnvironment(); return; }
    if(!this.paused) this.simulate(dt);
    this.updateEnvironment();
  }
  pollLoad(dt){
    const o=this.pending; if(!o) return; const p=this.loadHold; this.cam.x=p.x; this.cam.z=p.z; this.cam.y=p.alt+80;
    if(this.ready(dt)) this.placeAircraft(o);
    else { $("loadmsg").textContent="地形・空港を読み込み中… 経過 "+this.loadT.toFixed(0)+" 秒"; }
  }
  simulate(dt){
    const s=this.s, c=this.c, pilot=this.pilot, env=this.env; this.readInput(dt);
    this.updateWind();
    if(this.push&&this.state==="fly"){ this.pushStep(dt); this.afterStep(dt); return; }
    // 時間圧縮（低高度では 1x。ただし自動タキシー中の地上走行は早送りできる）
    let ts=this.timeScale; if(s.radAlt<600||s.onGround) ts=(this.autoTaxi&&s.onGround&&this.state==="fly"&&s.gs<12)?Math.min(ts,4):1; if(this.state==="crashed") ts=1;
    const sub=1/60; this.acc=(this.acc||0)+dt*ts; let n=0;
    // 高度が十分あるときは地面判定を簡略化
    const hc=this.terrain.heightAt(s.pos[0],s.pos[2]); const clr=s.pos[1]-hc; this.groundCache=(clr>900)?{on:true,v:{h:hc,kind:hc<=0.7?"water":"grass"}}:null;
    while(this.acc>=sub&&n<12){ this.acc-=sub; n++;
      const ctl=C.compute(c,s,this.effectivePilot(),env,sub); if(this.state==="crashed"){ ctl.throttle=0; }
      F.step(s,ctl,env,sub); this.lastCtl=ctl; }
    if(n===12) this.acc=0;
    s.groundSpoilersArmed=!!(pilot_spoil(this)); this.simT+=dt*ts; if(this.simT-(this.lastSkyT||0)>30){ this.lastSkyT=this.simT; this.sky.setHour(((this.startHour||14)+this.simT/3600)%24); }
    this.afterStep(dt);
  }
  effectivePilot(){
    const p=Object.assign({},this.pilot), s=this.s, ap=this.c.ap;
    if(this.autoTaxi&&this.taxiPhase==="taxi"&&s.onGround&&this.state==="fly"){
      const a=this.autoTaxi.update(s,1/60); this.taxiInfo=a; this.pilot.throttle=a.thr; p.throttle=a.thr; p.brake=a.brake; p.yaw=a.nws; p.parking=false; this.pilot.parking=false; s.parking=false;
      if(this.autoTaxi.done){ if(this.arrival){ this.autoTaxi=null; this.timeScale=1; this.taxiPhase="done"; this.pilot.throttle=0; p.throttle=0; this.pilot.parking=true; p.parking=true; this.arrival.done=true; this.arrival.doneT=this.t; this.say("ゲートに到着しました ― パーキングブレーキをセット","#38e06a",8); } else { this.autoTaxi=null; this.timeScale=1; this.taxiPhase="done"; this.pilot.throttle=0; p.throttle=0; this.pilot.parking=true; this.say("滑走路に整列しました ― パーキングブレーキを外し、スロットルを上げて離陸（Shift / PageUp / 9）","#38e06a",8); } }
      return p;
    }
    // 離陸滑走中は滑走路中心線に沿うよう自動で方向舵（入力があれば手動優先）
    if(s.onGround && !(ap.on&&ap.latMode==="LOC") && Math.abs(p.yaw)<0.05 && s.gs>6 && this.takeoffAssist!==false){
      const r=this.runwayUnder(s.pos[0],s.pos[2]); if(r){ const kind=this.ap.kindAt(s.pos[0],s.pos[2]);
        if(kind==="runway"){ const e=(Math.abs(n180(s.psi-r.hdg))<Math.abs(n180(s.psi-r.hdg-Math.PI)))?r.hdg:r.hdg+Math.PI; const err=n180(s.psi-e); if(Math.abs(err)<14*D2R){ const off=(s.pos[0]-r.ax)*(-r.uz)+(s.pos[2]-r.az)*(r.ux); const sgn=Math.abs(n180(e-r.hdg))<1?1:-1; const lat=off*sgn; p.yaw=clamp(-err*2.2-s.w[2]*1.2-lat*0.012,-0.6,0.6); } } } }
    // 電源・自動解除（スロットルを入れたらパーキングブレーキ解除）
    return p;
  }
  // プッシュバック: 主脚中心が計画した経路を後ろ向きに進む（物理計算はせず位置と向きを直接動かす）
  pushStep(dt){
    const s=this.s, pu=this.push, poses=this.taxiPlan.push.poses, n=poses.length; pu.t+=dt;
    const rem=(n-1)-pu.d, vmax=5.0, acc=0.9;
    if(this.keys.Enter||pu.skip){ pu.d=n-1; }
    else { const vt=Math.min(vmax,Math.sqrt(2*acc*Math.max(0,rem))+0.25); pu.v+=clamp(vt-pu.v,-acc*dt*1.6,acc*dt); pu.d=Math.min(n-1,pu.d+pu.v*dt); }
    const i0=Math.min(n-2,Math.floor(pu.d)), f=pu.d-i0, a=poses[i0], b=poses[i0+1];
    const mx=a.mx+(b.mx-a.mx)*f, mz=a.mz+(b.mz-a.mz)*f, psi=a.psi+n180(b.psi-a.psi)*f;
    const fw=[Math.sin(psi),-Math.cos(psi)]; const x=mx-fw[0]*TAXI.MAIN, z=mz-fw[1]*TAXI.MAIN, h=this.terrain.heightAt(x,z);
    s.pos=[x,h+3.85-0.16,z]; s.q=F.eulerToQ(psi,0,0); s.vel=[0,0,0]; s.w=[0,0,0]; s.onGround=true; s.parking=true; this.pilot.parking=true; s.nws=0; F.derived(s);
    if(pu.d>=n-1-1e-6){ this.push=null; this.taxiPhase="taxi"; this.afterPush(); }
  }
  afterPush(){
    this.say("プッシュバック完了 ― Enter で自動タキシー（手動なら P でブレーキを外して前進）","#3ddcff",9);
  }
  startAutoTaxi(){
    const s=this.s; if(this.taxiPhase!=="taxi") return; this.autoTaxi=new TAXI.AutoTaxi(this.taxiPlan.taxi); this.pilot.parking=false; s.parking=false; this.say("自動タキシー開始（操作すると手動に戻ります。T キーで早送り）","#3ddcff",5);
  }
  cancelAutoTaxi(why){ if(!this.autoTaxi) return; this.autoTaxi=null; if(this.timeScale>1&&this.s.onGround) this.timeScale=1; this.say(why||"手動操縦に切り替え","#ffb11a",2.5); }
  // タキシー段階の管理（手動で滑走路に乗ったら「完了」）
  taxiTick(){
    if(this.taxiPhase!=="taxi"||this.autoTaxi||this.arrival) return; const s=this.s, e=this.takeoffRwy; if(!e) return;
    if(this.ap.kindAt(s.pos[0],s.pos[2])==="runway"&&Math.abs(n180(s.psi-e.hdg))<25*D2R){ this.taxiPhase="done"; this.say("滑走路に乗りました ― スロットルを上げて離陸","#38e06a",5); }
  }
  afterStep(dt){
    const s=this.s, pilot=this.pilot, c=this.c, ap=c.ap;
    if(s.parking&&pilot.throttle>0.4){ pilot.parking=false; s.parking=false; }
    // 状態遷移・イベント
    const now=this.t; const onG=s.onGround;
    if(this.prevOnG===false&&onG&&!this.landed&&s.radAlt<8){ this.onTouchdown(); }
    if(this.prevOnG===true&&!onG&&!this.stats.liftoff&&s.gs>40){ this.stats.liftoff=now; this.say("離陸","#38e06a"); }
    this.prevOnG=onG;
    // 水没
    if(onG&&this.state==="fly"){ const g=this.groundAt(s.pos[0],s.pos[2]); if(g.kind==="water"&&s.gs>3){ s.crashed=true; s.crashMsg="海面（水面）に降りてしまいました"; } }
    if(s.crashed&&this.state==="fly"){ this.state="crashed"; this.crashT=this.t; this.sound("crash"); }
    if(this.state==="crashed"&&this.t-this.crashT>2.2&&!this.ended){ this.ended=true; this.showEnd("crash"); }
    // 着陸後の停止
    if(this.landed&&!this.ended&&s.gs<1.5&&onG&&this.t-this.touchT>5){ this.ended=true; this.arrivalPlan=this.planArrivalNow(); this.showEnd("landed"); }
    if(this.arrival&&this.arrival.done&&!this.arrival.shown&&this.t-this.arrival.doneT>3){ this.arrival.shown=true; this.showEnd("parked"); }
    this.taxiTick(); if(this.taxiPhase==="taxi"&&s.parking&&pilot.throttle>0.04&&s.onGround){ pilot.parking=false; s.parking=false; this.say("パーキングブレーキ解除","#fff",1.4); }
    if(this.stats.liftoff&&this.taxiPhase&&!this.arrival){ this.taxiPhase=null; this.autoTaxi=null; }
    // 自動機能
    this.autoLights(); this.autoTakeoffStep(dt); this.autoFlightStep(dt); this.apprAssist(dt); this.takeoffCalls(); this.computeWarnings(dt); this.updateHints();
    // 失速速度（見かけの目安）
    this.vStall=Math.sqrt(2*s.mass*F.G/(1.225*F.AC.S*(F.flapParams(s.flaps)[1])))/KT*1.0;
    // 飛行機の見た目
    this.acft.update(s,{},dt,this.sky.night,this.lightsOn);
  }
  autoLights(){
    const s=this.s, L=this.lightsOn; L.nav=true; L.beacon=s.fuel>0; L.strobe=!s.onGround||s.gs>25; L.landing=s.radAlt<3000*FT&&s.gear>0.9&&(s.pos[1]<3050||s.onGround&&s.gs>25); L.taxi=s.onGround; L.logo=this.sky.night>0.4;
  }
  say(t,col,sec){ this.setMsg(t,col||"#fff",sec||2.2); }
  setMsg(t,col,sec){ const e=$("bigmsg"); if(!e) return; e.textContent=t||""; e.style.color=col||"#fff"; e.style.opacity=t?1:0; this.msgUntil=this.t+(sec||2.2); }
  takeoffCalls(){
    const s=this.s, cas=s.cas/KT, ap=this.c.ap; const k=this.log;
    if(s.onGround&&s.gs>20&&pilotThrust(s)>0.6&&!this.stats.liftoff){ if(!k.c80&&cas>80){ k.c80=1; this.say("80 ノット","#fff"); } if(!k.cv1&&cas>this.vsp.v1){ k.cv1=1; this.say("V1","#38e06a"); } if(!k.cvr&&cas>this.vsp.vr){ k.cvr=1; this.say("ローテート ― 操縦桿を引く","#3ddcff",3); } }
    if(this.stats.liftoff&&!k.pos&&s.radAlt>12&&s.vs>2&&!s.onGround){ k.pos=1; this.say("上昇中 ― ギア上げ（G）","#38e06a",4); }
    if(this.msgUntil&&this.t>this.msgUntil){ this.setMsg(""); this.msgUntil=0; }
  }
  onTouchdown(){
    const s=this.s; this.landed=true; this.touchT=this.t; const vs=s.lastTouchVs!=null?s.lastTouchVs:s.vel[1]; const fpm=vs/FT*60;
    const r=this.runwayUnder(s.pos[0],s.pos[2]); let rep={vs,fpm,cas:s.cas/KT,gs:s.gs/KT,hard:vs<-3.3};
    if(r){ const tA=(s.pos[0]-r.ax)*r.ux+(s.pos[2]-r.az)*r.uz; const lat=(s.pos[0]-r.ax)*(-r.uz)+(s.pos[2]-r.az)*(r.ux); const fromA=Math.abs(n180(s.psi-r.hdg))<Math.PI/2; const dist=fromA?tA:r.L-tA; const name=fromA?r.names[0]:r.names[1]; rep.rwy=name; rep.dist=dist; rep.lat=fromA?lat:-lat; rep.onRwy=this.ap.kindAt(s.pos[0],s.pos[2])==="runway"; rep.icao=r.icao; rep.len=r.L; }
    this.touchRep=rep; const rate=Math.abs(vs); const q=rate<1.5?"なめらかな接地":rate<2.5?"良い接地":rate<3.3?"やや硬い接地":"ハードランディング";
    this.say("接地 "+Math.round(fpm)+" fpm（"+q+"）",rate<2.5?"#38e06a":rate<3.3?"#ffb11a":"#ff3b30",4); this.sound("touch",rate);
    // 自動で地上操作へ
    const ap=this.c.ap; if(ap.on&&ap.vertMode==="GS"){ pilot_set(this); }
  }
  runwayUnder(x,z){ let best=null,bs=1e12; for(const a of Object.values(this.ap.ap)){ for(const r of a.runways){ const t=(x-r.ax)*r.ux+(z-r.az)*r.uz; const lat=Math.abs(-(x-r.ax)*r.uz+(z-r.az)*r.ux); if(t<-80||t>r.L+80) continue; const sc=lat; if(lat<r.w/2+30&&sc<bs){ bs=sc; best=r; } } } return best||this.ap.nearestRunway(x,z); }
  // ---------------- 進入支援 ----------------
  approachGeometry(icao,name){
    const A=this.ap, s=this.s; const re=A.runwayEnd(icao,name); if(!re) return null; const e=re.e;
    const dx=s.pos[0]-e.x, dz=s.pos[2]-e.z; const along=-(dx*e.ux+dz*e.uz); const xt=dx*(-e.uz)+dz*(e.ux);
    return {e,re,along,xt,h:re.h};
  }
  findApproach(){   // 現在地から使える進入コースを探す
    const A=this.ap, s=this.s; let best=null;
    for(const icao of Object.keys(A.ap)){ const a=A.ap[icao]; for(const r of a.runways) for(const e of r.ends){ const g=this.approachGeometry(icao,e.name); if(!g) continue; if(g.along<1500||g.along>60000) continue; const ang=Math.atan2(Math.abs(g.xt),g.along); if(ang>35*D2R) continue; const hdgErr=Math.abs(n180(s.psi-e.hdg)); if(hdgErr>75*D2R) continue; let sc=ang+hdgErr*0.3; if(this.destRwy&&this.destRwy.icao===icao&&this.destRwy.name===e.name) sc*=0.4; if(!best||sc<best.sc) best={icao,name:e.name,g,sc}; } }
    return best;
  }
  pressAPPR(){
    const ap=this.c.ap, s=this.s; if(this.state!=="fly") return;
    if(ap.latMode==="LOC"&&ap.vertMode==="GS"&&ap.on){ // 解除
      ap.vertMode="ALT"; ap.latMode="HDG"; ap.hdg=s.psi; ap.alt=Math.max(s.pos[1],this.s.pos[1]); this.say("進入モード解除","#ffb11a"); return; }
    const f=this.findApproach(); if(!f){ this.say("進入コースに乗っていません（滑走路の延長線の前方 60km 以内、方位 ±35° 以内）","#ffb11a",4); return; }
    const e=f.g.e; ap.loc={x:e.x,z:e.z,crs:e.hdg,h:f.g.h,gs:3*D2R,aim:300,name:f.icao+" "+f.name}; ap.on=true; ap.athr=true; ap.latMode="LOC"; ap.vertMode="GS"; ap.appr=true; ap.spdIsMach=false; this.apprState={icao:f.icao,name:f.name,e}; this.rwyFocus={icao:f.icao,name:f.name};
    ap.spd=Math.min(Math.max(s.cas,this.vsp.vref*KT),230*KT); this.pilot.autobrake=2; this.pilot.spoilerArm=true; this.say("進入モード ― "+this.apName(f.icao)+" 滑走路 "+f.name,"#3ddcff",3);
  }
  // ---------------- 到着（着陸して止まったあと、ゲートまで自動タキシー）----------------
  planArrivalNow(){
    try{
      const r=this.touchRep; const s=this.s; if(!r||!r.rwy||!r.icao||r.onRwy===false) return null;
      const re=this.ap.runwayEnd(r.icao,r.rwy); const d=this.ap.data&&this.ap.data[r.icao]; if(!re||!d) return null;
      const e=re.e; const fw=[Math.sin(s.psi),-Math.cos(s.psi)]; const mx=s.pos[0]+fw[0]*TAXI.MAIN, mz=s.pos[2]+fw[1]*TAXI.MAIN;
      if(Math.abs(n180(s.psi-e.hdg))>30*D2R) return null;
      const pl=TAXI.autoArrival(d,e,{nx:mx,nz:mz,psi:s.psi}); if(pl) pl.icao=r.icao; return pl;
    }catch(err){ return null; }
  }
  startArrivalTaxi(){
    const pl=this.arrivalPlan, s=this.s, p=this.pilot; if(!pl||this.state!=="fly") return;
    this.arrival={plan:pl}; this.taxiPlan={taxi:pl.taxi,stand:pl.stand}; this.taxiPhase="taxi"; this.push=null;
    p.flapsTarget=0; p.spoilerArm=false; p.autobrake=0; p.reverse=false; p.speedbrake=0; p.throttle=0; p.parking=false; s.parking=false;
    this.autoTaxi=new TAXI.AutoTaxi(pl.taxi); this.say("ゲートへ自動タキシー開始（操作すると手動に戻ります。T キーで早送り）","#3ddcff",6);
  }
  // ---------------- オート離陸（滑走路上で Enter：推力全開 → VR で機首上げ → ギア上げ → 一定高度でオート航行へ）----------------
  startAutoTakeoff(){
    const s=this.s, p=this.pilot; if(this.state!=="fly"||!s.onGround||this.stats.liftoff||this.landed) return false;
    if(this.taxiPhase==="push"||this.taxiPhase==="taxi"){ this.say("滑走路に整列してから使えます（自動タキシーで滑走路まで進めます）","#ffb11a",3); return false; }
    const re=this.rwyFocus; if(this.autoTO) { this.stopAutoTakeoff("オート離陸を止めました"); return false; }
    this.autoTO={phase:"roll",t0:this.t}; p.parking=false; s.parking=false; p.throttle=Math.max(p.throttle,0.3); p.brake=0;
    this.say("オート離陸 ― 推力全開 → VR で機首を上げ、上昇したらギアを上げて自動航行へ（操作すると手動に戻ります）","#38e06a",6); return true;
  }
  stopAutoTakeoff(msg){ if(!this.autoTO) return; this.autoTO=null; this.autoPitch=0; if(msg) this.say(msg,"#ffb11a",3); }
  autoTakeoffStep(dt){
    const to=this.autoTO; if(!to) return; const s=this.s, p=this.pilot; if(this.state!=="fly"||this.landed){ this.autoTO=null; this.autoPitch=0; return; }
    const cas=s.cas/KT, raFt=s.radAlt/FT, th=s.theta;
    p.parking=false; s.parking=false;
    if(to.phase==="roll"){
      p.throttle=Math.min(1,p.throttle+dt*0.5); this.autoPitch=0;
      if(s.onGround&&cas>=this.vsp.vr){ to.phase="rotate"; }
      if(!s.onGround&&this.stats.liftoff) to.phase="climb";
    }
    if(to.phase==="rotate"){
      p.throttle=1; this.autoPitch=clamp((6.8*D2R-th)/(2.2*D2R),0,1);
      if(!s.onGround&&this.stats.liftoff) to.phase="climb";
    }
    if(to.phase==="climb"){
      p.throttle=1; this.autoPitch=clamp((7.5*D2R-th)/(2.2*D2R),-0.3,1);
      if(raFt>25&&s.vs>1&&p.gearTarget===1){ p.gearTarget=0; this.say("ギア上げ","#38e06a"); }
      if(raFt>260||(raFt>90&&cas>this.vsp.v2+25)){
        this.autoPitch=0; this.autoTO=null;
        if(this.route.length&&this.destRwy&&this.startAutoFlight(true)) this.say("オート航行へ ― 上昇・巡航・降下・ILS進入まで自動","#38e06a",5);
        else { const ap=this.c.ap; ap.on=true; ap.athr=true; ap.latMode="HDG"; ap.hdg=s.psi; ap.vertMode="FLCH"; ap.alt=Math.max(s.pos[1]+600*FT,4000*FT); this.syncMCP&&this.syncMCP(); }
      }
    }
  }
  // ---------------- オート航行（離陸後の上昇 → 巡航 → 降下 → ILS 進入を、経路に沿って自動で行う）----------------
  startAutoFlight(quiet){
    const ap=this.c.ap, s=this.s; if(this.state!=="fly") return false;
    if(s.onGround){ this.say("離陸後に使えます","#ffb11a"); return false; }
    if(!this.route.length||!this.destRwy){ this.say("経路がありません","#ffb11a"); return false; }
    const rt=this.route; let k=Math.min(Math.max(0,ap.wpIndex||0),rt.length-1);
    while(k<rt.length-1){ const a=rt[k], b=rt[k+1]; if((s.pos[0]-a.x)*(b.x-a.x)+(s.pos[2]-a.z)*(b.z-a.z)>0) k++; else break; }   // すでに通り過ぎた経由地は飛ばす
    ap.on=true; ap.athr=true; ap.latMode="LNAV"; ap.route=rt; ap.wpIndex=k; ap.appr=false; ap.loc=null; this.apprState=null; this.c.legFrom=null;
    if(ap.vertMode==="GS") ap.vertMode="ALT";
    this.autoFlight=true; this.af={phase:null,sayT:0};
    if(!quiet) this.say("オート航行 ON ― 上昇・巡航・降下・ILS進入まで自動（MCP を触ると手動に戻ります）","#38e06a",5);
    this.syncMCP(); return true;
  }
  stopAutoFlight(msg){ if(!this.autoFlight) return; this.autoFlight=false; this.af=null; if(msg) this.say(msg,"#ffb11a",3); }
  routeRemain(){   // いまの位置から経路を通って滑走路しきい値までの道のり
    const rt=this.route, s=this.s, ap=this.c.ap; const re=this.ap.runwayEnd(this.destRwy.icao,this.destRwy.name); if(!re||!rt.length) return 0;
    let i=Math.min(ap.wpIndex||0,rt.length-1); let L=Math.hypot(rt[i].x-s.pos[0],rt[i].z-s.pos[2]); for(let k=i;k<rt.length-1;k++) L+=Math.hypot(rt[k+1].x-rt[k].x,rt[k+1].z-rt[k].z);
    const last=rt[rt.length-1]; return L+Math.hypot(re.e.x-last.x,re.e.z-last.z);
  }
  autoFlightStep(dt){
    if(!this.autoFlight||this.state!=="fly") return; const s=this.s, ap=this.c.ap, p=this.pilot, af=this.af; const rt=this.route;
    if(!ap.on||this.landed||s.onGround&&this.stats.liftoff&&s.gs<60){ this.autoFlight=false; return; }
    if(ap.latMode==="LOC"||ap.vertMode==="GS"){ this.autoFlight=false; return; }       // ILS 進入に入ったら、あとは進入モードが担当
    if(s.onGround||!rt.length||!this.destRwy) return;
    const raFt=s.radAlt/FT, altFt=s.pos[1]/FT, cas=s.cas/KT; const re=this.ap.runwayEnd(this.destRwy.icao,this.destRwy.name); if(!re) return; const e=re.e;
    const ph=af.phase; const setPh=(n,msg)=>{ if(af.phase!==n){ af.phase=n; if(msg) this.say(msg,"#3ddcff",3.5); } };
    ap.latMode="LNAV"; ap.route=rt; ap.athr=true;
    const lim=(i)=>F.AC.flapSpeeds[Math.max(0,Math.min(8,i))]/KT;
    // ギア・フラップのかたづけ（離陸直後）
    if(raFt>60&&s.vs>1&&p.gearTarget===1&&!af.descend){ p.gearTarget=0; this.say("ギア上げ","#38e06a"); }
    const fi=Math.round(p.flapsTarget);
    if(!af.descend&&fi>0&&raFt>700&&this.t>(af.flT||0)&&cas>(fi>1?lim(fi-1)-22:lim(1)-30)){ p.flapsTarget=fi-1; af.flT=this.t+4; }
    // 降下を始める点: しきい値までの道のりが「降下に必要な距離」以下になったら
    if(!af.descend){
      if(!af.tgt){ let mt=0; for(let d=3000;d<=42000;d+=3000) mt=Math.max(mt,this.terrain.heightAt(e.x-e.ux*d,e.z-e.uz*d)); af.tgt=Math.max(re.h+880,mt+400); }
      const drop=s.pos[1]-af.tgt; const need=Math.max(0,drop)/Math.tan(2.8*D2R)+9000;
      if(drop>250&&this.routeRemain()<=need){ af.descend=true; }
    }
    const spdLim=lim(fi)-8;     // いまのフラップで出してよい速度
    if(af.descend){
      setPh("descend","オート航行 ― 降下開始");
      ap.alt=af.tgt; ap.vertMode=(Math.abs(af.tgt-s.pos[1])<45)?"ALT":"FLCH"; if(ap.vertMode==="FLCH"&&Math.abs(af.tgt-s.pos[1])<45) ap.vertMode="ALT";
      if(altFt>28500){ ap.spdIsMach=true; ap.mach=0.76; } else { ap.spdIsMach=false; ap.spd=Math.min((altFt>10500?280:250),spdLim)*KT; }
      if(s.pos[1]-af.tgt<45&&ap.vertMode!=="ALT") ap.vertMode="ALT";
    } else {
      const cr=this.cruiseAlt||35000*FT;
      if(s.pos[1]<cr-120){ setPh("climb",null); ap.alt=cr; if(ap.vertMode!=="FLCH") ap.vertMode="FLCH"; }
      else { setPh("cruise","オート航行 ― 巡航"); ap.alt=cr; ap.vertMode="ALT"; }
      if(altFt>26000){ ap.spdIsMach=true; ap.mach=0.78; }
      else { ap.spdIsMach=false; const v=raFt<1500&&fi>0?this.vsp.v2+15:(altFt>10500?290:250); ap.spd=Math.min(v,spdLim)*KT; }
    }
    // 最終進入コースに乗ったら ILS 進入へ（経路の最後の脚に入り、滑走路の延長線の近くに来たとき）
    if(ap.wpIndex>=rt.length-1&&rt.length>=1){
      const g=this.approachGeometry(this.destRwy.icao,this.destRwy.name); if(g&&g.along>2500&&g.along<36000&&Math.abs(g.xt)<2600&&Math.abs(n180(s.psi-e.hdg))<35*D2R){
        const f=this.findApproach(); if(f&&f.icao===this.destRwy.icao&&f.name===this.destRwy.name){ this.pressAPPR(); this.autoFlight=false; }
      }
    }
  }
  apprAssist(dt){   // 進入中のギア・フラップ・速度を自動設定
    const s=this.s, ap=this.c.ap, pilot=this.pilot; if(!this.assistConfig||!ap.on||ap.latMode!=="LOC"||!this.apprState||s.onGround) return;
    const g=this.approachGeometry(this.apprState.icao,this.apprState.name); if(!g) return; const d=g.along; const vref=this.vsp.vref+4;
    let spd,fl,gear=pilot.gearTarget;
    if(d>38000){ spd=230; fl=0; } else if(d>26000){ spd=210; fl=Math.max(0,Math.min(pilot.flapsTarget,1)); if(d<30000) fl=1; } else if(d>19000){ spd=190; fl=3; } else if(d>14000){ spd=170; fl=4; } else if(d>10500){ spd=155; fl=5; gear=1; } else if(d>7500){ spd=vref+14; fl=7; gear=1; } else if(d>5200){ spd=vref+8; fl=7; gear=1; } else { spd=vref+3; fl=8; gear=1; }
    if(d<30000 && fl<1) fl=1;
    pilot.flapsTarget=Math.max(pilot.flapsTarget,fl); if(fl<pilot.flapsTarget&&d>40000) pilot.flapsTarget=fl;
    if(gear===1&&pilot.gearTarget!==1){ pilot.gearTarget=1; this.say("ギア下げ","#ffb11a"); }
    // 速度は現在のフラップの制限を超えない
    const lim=F.AC.flapSpeeds[Math.min(8,Math.round(s.flapsTarget))]/KT-5; ap.spd=Math.min(spd,lim)*KT; ap.spdIsMach=false; ap.athr=true;
  }
  // ---------------- 警報 ----------------
  computeWarnings(dt){
    const s=this.s, W=[]; const raFt=s.radAlt/FT, vsF=s.vs/FT*60; const ap=this.c.ap; const near=this.nearAirportDist();
    if(s.stallWarn&&!s.onGround) W.push({t:"STALL",steady:true,sound:"stall"});
    if(s.overspeed) W.push({t:"OVERSPEED",steady:true,sound:"overspeed"});
    if(!s.onGround&&this.state==="fly"){
      const lim=1500+raFt*1.4; if(raFt<2400&&-vsF>lim*1.5&&raFt>40) W.push({t:"PULL UP",steady:true,sound:"gpws"}); else if(raFt<2400&&-vsF>lim&&raFt>40) W.push({t:"SINK RATE",col:"#ffb11a",sound:"gpws"});
      if(raFt<800&&s.gear<0.9&&raFt>30&&s.flaps>=4&&near<12000) W.push({t:"GEAR",col:"#ffb11a",sound:"gpws"});
      // 前方地形
      this.tAccum=(this.tAccum||0)+dt; if(this.tAccum>0.5){ this.tAccum=0; const v=s.vel; const sp=Math.hypot(v[0],v[2]); let thr=false; if(sp>60&&near>9000){ for(const T of [15,30]){ const h=this.terrain.heightAt(s.pos[0]+v[0]*T,s.pos[2]+v[2]*T); if(h>s.pos[1]+Math.min(0,v[1])*T*0.0-120+ (s.vel[1]>2?s.vel[1]*T*0.8:0)) thr=true; } } this.terrainWarn=thr; }
      if(this.terrainWarn&&near>9000) W.push({t:"TERRAIN",steady:true,sound:"gpws"});
    }
    this.warn=W;
  }
  nearAirportDist(){ let m=1e9; const s=this.s; for(const a of Object.values(this.ap.ap)) m=Math.min(m,Math.hypot(s.pos[0]-a.ref[0],s.pos[2]-a.ref[1])); return m; }
  // ---------------- ヒント ----------------
  updateHints(){
    const s=this.s, ap=this.c.ap, p=this.pilot; let h="";
    const cas=s.cas/KT, raFt=s.radAlt/FT, altFt=s.pos[1]/FT;
    if(this.state==="crashed") h="";
    else if(this.push) h="プッシュバック中です。まもなく自分で動かせます（Enter でスキップ）";
    else if(this.arrival&&this.arrival.done) h="ゲートに到着しました。おつかれさま！";
    else if(this.taxiPhase==="taxi"){ if(this.autoTaxi) h=this.arrival?"ゲートへ自動タキシー中。手で操作するか Enter で止められます（T で早送り）":"自動タキシー中。手で操作するか Enter で止められます（T で早送り）"; else if(s.parking) h="パーキングブレーキを外す（P）→ スロットルを少し上げて（数字キー 1 → しばらくしたら 0）前進。A / D で曲がる。Enter で自動タキシー"; else h="青いラインに沿って進む。A / D で操舵、速度が出すぎたら Space でブレーキ（目安 15 kt 以下、曲がり角は 8 kt）"; }
    else if(s.onGround&&!this.stats.liftoff&&!this.landed){ if(this.autoTO) h="オート離陸中 ― 自動で加速・離陸します"; else if(p.throttle<0.1) h="Enter でオート離陸（おまかせ）／ 自分で: スロットルを上げて離陸滑走（Shift / PageUp / 数字キー 9）。パーキングブレーキは自動で外れます"; else if(cas<this.vsp.vr) h="加速中。滑走路中心線は自動で維持されます。VR（"+this.vsp.vr+" kt）で操縦桿を引く（↓ / S）"; else h="操縦桿を引いて機首を約 10° 上げる"; }
    else if(this.stats.liftoff&&!this.landed&&s.gear>0.5&&raFt>30&&s.vs>0) h="正の上昇率 → ギア上げ（G）";
    else if(!this.landed&&s.gear<0.5&&s.flaps>0.5&&altFt>1500&&cas>180) h="フラップ上げ（V でフラップを一段ずつ引き上げ）";
    else if(!ap.on&&!s.onGround&&altFt>1500&&!this.landed) h="Enter キーで「オート航行」（上昇→巡航→降下→ILS進入まで経路に沿って自動）。自分で飛ばすなら上の MCP で高度・速度・方位を設定";
    else if(ap.on&&ap.vertMode==="ALT"&&Math.abs(ap.alt-s.pos[1])>150&&!this.landed) h="MCP の高度を設定して FLCH（高度変更）を押すと上昇／降下します";
    else if(this.landed&&s.onGround&&s.gs>20) h="接地後：リバース（R 長押し）とブレーキ（Space / B 長押し）。オートブレーキ作動中";
    const tod=this.todInfo(); if(tod&&tod.msg&&!this.landed) h=tod.msg;
    this.hintText=h; const he=$("hint"); if(he){ he.textContent=h; he.style.display=(this.hint&&h&&!this.easyOn)?"block":"none"; }
  }
  todInfo(){
    const s=this.s, ap=this.c.ap; if(!this.destRwy||this.landed) return null; const re=this.ap.runwayEnd(this.destRwy.icao,this.destRwy.name); if(!re) return null;
    const e=re.e; const dist=Math.hypot(s.pos[0]-e.x,s.pos[2]-e.z); const altAbove=s.pos[1]-re.h; if(altAbove<2500) return null;
    // 目標: 最終進入点（19 km 手前）で約 2,600 ft。降下 3° 相当 + 減速 20 km の余裕
    const need=(altAbove-800)/Math.tan(2.9*D2R)+20000; const toTod=dist-need;
    const pt={x:e.x+(s.pos[0]-e.x)/dist*need,z:e.z+(s.pos[2]-e.z)/dist*need};
    this.todPt=(dist>need)?pt:null; const msg=(toTod<30000&&toTod>-5000&&ap.vertMode==="ALT"&&Math.abs(ap.alt-s.pos[1])<100)?(toTod>2000?"降下開始まであと "+(toTod/NM).toFixed(0)+" NM":"降下開始点です。MCP 高度を 3000 ft にして FLCH を押す"):null;
    return {toTod,msg,text:toTod>0?"T/D "+(toTod/NM).toFixed(0)+"NM":"T/D 通過"};
  }
  // ---------------- 入力 ----------------
  bindInput(){
    const K=this.keys; const down=e=>{ if(e.target&&/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return; K[e.code]=true; this.keyDown(e); if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space","PageUp","PageDown","Tab"].includes(e.code)) e.preventDefault(); };
    addEventListener("keydown",down); addEventListener("keyup",e=>{ K[e.code]=false; });
    addEventListener("blur",()=>{ for(const k in K) K[k]=false; });
    const cv=this.FS.renderer.domElement; let drag=null; const dn=e=>{ if(e.target!==cv) return; drag={x:e.clientX,y:e.clientY}; };
    addEventListener("pointerdown",dn); addEventListener("pointerup",()=>{ drag=null; });
    addEventListener("pointermove",e=>{ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; drag.x=e.clientX; drag.y=e.clientY; if(this.view==="chase"){ this.orbit.az-=dx*0.006; this.orbit.el=clamp(this.orbit.el+dy*0.005,-0.2,1.3); } else { this.look.yaw=clamp(this.look.yaw-dx*0.006,-2.6,2.6); this.look.pitch=clamp(this.look.pitch-dy*0.005,-1.2,1.2); } });
    cv.addEventListener("wheel",e=>{ e.preventDefault(); if(this.view==="chase") this.orbit.d=clamp(this.orbit.d*(e.deltaY>0?1.1:0.91),14,260); else this.camZoom=clamp(this.camZoom*(e.deltaY>0?1.06:0.94),0.5,2.2); },{passive:false});
    cv.addEventListener("dblclick",()=>{ this.look.yaw=0; this.look.pitch=0; this.orbit.az=0.55; this.orbit.el=0.18; this.orbit.d=62; this.camZoom=1; });
  }
  keyDown(e){
    if(this.state!=="fly"&&this.state!=="crashed") return; const p=this.pilot, s=this.s, ap=this.c.ap; const sh=e.shiftKey;
    switch(e.code){
      case "KeyG": p.gearTarget=p.gearTarget>0.5?0:1; this.say(p.gearTarget?"ギア下げ":"ギア上げ","#fff",1.4); break;
      case "KeyF": p.flapsTarget=clamp(Math.round(p.flapsTarget)+1,0,8); this.say("フラップ "+[0,1,2,5,10,15,25,30,40][p.flapsTarget],"#fff",1.4); break;
      case "KeyV": p.flapsTarget=clamp(Math.round(p.flapsTarget)-1,0,8); this.say("フラップ "+[0,1,2,5,10,15,25,30,40][p.flapsTarget],"#fff",1.4); break;
      case "KeyP": p.parking=!p.parking; this.say(p.parking?"パーキングブレーキ ON":"パーキングブレーキ OFF","#fff",1.4); break;
      case "KeyK": p.speedbrake=p.speedbrake>0.5?0:1; this.say(p.speedbrake?"スピードブレーキ":"スピードブレーキ格納","#fff",1.2); break;
      case "KeyL": p.spoilerArm=!p.spoilerArm; this.say(p.spoilerArm?"グラウンドスポイラー ARM":"スポイラー ARM 解除","#fff",1.4); break;
      case "KeyO": p.autobrake=(p.autobrake+1)%5; this.say("オートブレーキ "+["OFF","1","2","3","MAX"][p.autobrake],"#fff",1.4); break;
      case "KeyC": this.cycleView(); break;
      case "Enter": if(this.push) break; if(this.taxiPhase==="taxi"){ if(this.autoTaxi) this.cancelAutoTaxi("自動タキシーを止めました"); else this.startAutoTaxi(); } else if(this.s.onGround&&!this.stats.liftoff&&!this.landed) this.startAutoTakeoff(); else this.toggleAP(); break;
      case "KeyY": this.c.assist=!this.c.assist; this.say(this.c.assist?"操縦補助 ON":"操縦補助 OFF（直接操縦）","#ffb11a",2); break;
      case "KeyT": this.timeScale=this.timeScale>=4?1:this.timeScale*2; this.say("時間 ×"+this.timeScale,"#fff",1.4); break;
      case "KeyU": if(this.easy){ this.easy.toggle(); const b=$("bEasy"); if(b) b.classList.toggle("on",this.easy.on); } break;
      case "KeyH": this.hint=!this.hint; this.updateHints(); break;
      case "KeyN": this.ndRange=this.ndRange>=160?10:this.ndRange*2; this.hud.ndRange=this.ndRange; break;
      case "KeyM": this.audio&&this.audio.setMuted(!this.audio.muted); this.say(this.audio&&this.audio.muted?"消音":"音 ON","#fff",1); break;
      case "Home": p.throttle=1; break; case "End": p.throttle=0; break;
      case "KeyE": if(false) break; break;
      case "Escape": this.pauseMenu(); break;
      case "KeyI": case "KeyJ": this.pressAPPR(); break;
      case "Pause": this.paused=!this.paused; break;
    }
    if(/^Digit[0-9]$/.test(e.code)&&!sh){ const d=+e.code.slice(5); p.throttle=d===9?1:d/10; if(this.autoTaxi) this.cancelAutoTaxi(); }
  }
  readInput(dt){
    const K=this.keys, p=this.pilot; const axis=(a,b)=>(K[a]?1:0)-(K[b]?1:0);
    let pitch=axis("ArrowDown","ArrowUp")+axis("KeyS","KeyW"), roll=axis("ArrowRight","ArrowLeft")+axis("KeyD","KeyA"), yaw=axis("KeyX","KeyZ")+axis("KeyE","KeyQ");
    if(this.autoTO&&(K.ArrowUp||K.ArrowDown||K.KeyW||K.KeyS||K.ArrowLeft||K.ArrowRight||K.KeyA||K.KeyD||K.KeyQ||K.KeyE||K.KeyZ||K.KeyX||K.Space||K.KeyB||K.ControlLeft||K.ControlRight||K.PageDown||this.touchBrake||Math.abs(this.padPitch||0)>0.3||Math.abs(this.touchPitch||0)>0.3)) this.stopAutoTakeoff("オート離陸を止めました（手動操縦）");
    pitch+=this.autoPitch||0; pitch+=this.padPitch||0; roll+=this.padRoll||0; yaw+=this.padYaw||0; pitch+=this.touchPitch||0; roll+=this.touchRoll||0;
    const sm=(cur,tgt,r)=>{ const d=tgt-cur; return Math.abs(d)<r*dt?tgt:cur+Math.sign(d)*r*dt; };
    this.sPitch=sm(this.sPitch||0,clamp(pitch,-1,1),4.2); this.sRoll=sm(this.sRoll||0,clamp(roll,-1,1),4.2); this.sYaw=sm(this.sYaw||0,clamp(yaw,-1,1),3.5);
    p.pitch=this.sPitch; p.roll=this.sRoll; p.yaw=this.sYaw;
    if(K.ShiftLeft||K.ShiftRight||K.PageUp||K.Equal||K.NumpadAdd) p.throttle=clamp(p.throttle+dt*0.45,0,1);
    if(K.ControlLeft||K.ControlRight||K.PageDown||K.Minus||K.NumpadSubtract) p.throttle=clamp(p.throttle-dt*0.45,0,1);
    p.brake=(K.Space||K.KeyB||this.padBrake>0.1||this.touchBrake)?1:0; if(this.padBrake>0.1) p.brake=this.padBrake;
    p.reverse=!!(K.KeyR||this.touchRev);
    if(this.autoTaxi&&(K.Space||K.KeyB||K.KeyA||K.KeyD||K.KeyQ||K.KeyE||K.KeyZ||K.KeyX||K.ArrowLeft||K.ArrowRight||K.ShiftLeft||K.ShiftRight||K.PageUp||K.PageDown||K.ControlLeft||K.ControlRight||this.touchBrake)) this.cancelAutoTaxi();
    if(K.Comma) p.trim=clamp(p.trim-dt*0.2,-1,1); if(K.Period) p.trim=clamp(p.trim+dt*0.2,-1,1);
    this.pollPad();
    $("thrfill")&&($("thrfill").style.height=(p.throttle*100).toFixed(0)+"%");
  }
  pollPad(){ const gp=(navigator.getGamepads&&navigator.getGamepads())||[]; let g=null; for(const x of gp){ if(x&&x.connected){ g=x; break; } } if(!g){ this.padPitch=this.padRoll=this.padYaw=0; this.padBrake=0; return; }
    const dz=v=>Math.abs(v)<0.1?0:v; this.padRoll=dz(g.axes[0]||0); this.padPitch=dz(g.axes[1]||0); this.padYaw=dz(g.axes[2]||0); this.padBrake=(g.buttons[6]&&g.buttons[6].value)||0;
    if(g.axes[3]!=null&&Math.abs(g.axes[3])>0.15) this.pilot.throttle=clamp(this.pilot.throttle-g.axes[3]*0.012,0,1);
    const bt=(i,k)=>{ const on=g.buttons[i]&&g.buttons[i].pressed; if(on&&!this["pb"+i]) this.keyDown({code:k,shiftKey:false}); this["pb"+i]=!!on; }; bt(0,"KeyG"); bt(1,"KeyF"); bt(2,"KeyV"); bt(3,"KeyC"); bt(4,"KeyA"); bt(5,"KeyJ"); }
  toggleAP(manualOnly){ const ap=this.c.ap, s=this.s; if(!manualOnly&&!ap.on&&!s.onGround&&this.route.length&&this.destRwy&&this.startAutoFlight()) return; if(!ap.on){ ap.on=true; ap.athr=this.route.length>0&&!s.onGround?ap.athr:false; if(s.onGround) { ap.on=false; this.say("離陸後に使えます","#ffb11a"); return; }
      ap.latMode=(ap.latMode==="LNAV"&&this.route.length)?"LNAV":"HDG"; if(ap.latMode==="HDG") ap.hdg=s.psi; ap.vertMode="ALT"; ap.alt=Math.round(s.pos[1]/(100*FT))*100*FT; if(!ap.athr){ ap.spd=Math.max(s.cas,150*KT); ap.athr=true; } this.say("オートパイロット ON","#38e06a"); }
    else { ap.on=false; ap.athr=false; this.autoFlight=false; this.say("オートパイロット OFF","#ffb11a"); } this.syncMCP(); }
  cycleView(){ const order=["cockpit","chase","window"]; this.applyView(order[(order.indexOf(this.view)+1)%order.length]); }
  applyView(v){ this.view=v; this.look.yaw=(v==="window"?1.15:0); this.look.pitch=(v==="window"?-0.12:0); this.camZoom=1; document.body.classList.toggle("v-cockpit",v==="cockpit"); document.body.classList.toggle("v-window",v==="window"); document.body.classList.toggle("v-chase",v==="chase"); this.acft.root.visible=(v!=="cockpit"); const vb=$("viewname"); if(vb) vb.textContent={cockpit:"コックピット",chase:"外から",window:"客室の窓"}[v]; }
  pauseMenu(){ this.paused=true; $("pause").style.display="flex"; }
  // ---------------- 視点とシーン更新 ----------------
  updateEnvironment(){
    const T=this.T, cam=this.cam, camera=this.camera, s=this.s; const fly=(this.state==="fly"||this.state==="crashed");
    let camY=cam.y;
    if(fly){
      const b=(v)=>F.b2w(s.q,v); const mat=new T.Matrix4(); const right=new T.Vector3(...s.right), up=new T.Vector3(-s.down[0],-s.down[1],-s.down[2]), back=new T.Vector3(-s.fwd[0],-s.fwd[1],-s.fwd[2]);
      mat.makeBasis(right,up,back); const qa=new T.Quaternion().setFromRotationMatrix(mat);
      let fov=60;
      if(this.view==="chase"){
        // 機体の向き（滑らかに）を基準に周回
        const dpsi=n180(s.psi-this.smPsi); this.smPsi+=dpsi*Math.min(1,0.05+0.02*Math.abs(dpsi)*10); const az=this.smPsi+Math.PI+this.orbit.az, el=this.orbit.el, d=this.orbit.d;
        const tx=s.pos[0]+s.fwd[0]*4, ty=s.pos[1]+1.5, tz=s.pos[2]+s.fwd[2]*4; let px=tx+Math.sin(az)*Math.cos(el)*d, pz=tz-Math.cos(az)*Math.cos(el)*d, py=ty+Math.sin(el)*d;
        const gh=this.terrain.heightAt(px,pz); py=Math.max(py,gh+3);
        cam.x=px; cam.z=pz; cam.y=py; camY=py; const dx=tx-px,dy=ty-py,dz=tz-pz; const yaw=Math.atan2(dx,-dz), pitch=Math.atan2(dy,Math.hypot(dx,dz));
        camera.quaternion.setFromEuler(new T.Euler(pitch,-yaw,0,"YXZ")); fov=50*this.camZoom;
      } else {
        const eye=this.view==="cockpit"?[14.2,-0.55,-0.95]:[3.0,1.45,-0.35]; const w=b(eye); cam.x=s.pos[0]+w[0]; cam.z=s.pos[2]+w[2]; cam.y=s.pos[1]+w[1]; camY=cam.y;
        const ql=new T.Quaternion().setFromEuler(new T.Euler(this.look.pitch,this.look.yaw,0,"YXZ")); camera.quaternion.copy(qa).multiply(ql); fov=(this.view==="cockpit"?62:56)*this.camZoom;
      }
      if(Math.abs(camera.fov-fov)>0.01){ camera.fov=fov; camera.updateProjectionMatrix(); }
      this.acft.root.quaternion.copy(qa); this.acft.root.position.set(s.pos[0]-cam.x,s.pos[1],s.pos[2]-cam.z); this.updateTug();
    } else if(this.state==="loading"){ camera.quaternion.setFromEuler(new T.Euler(-0.12,0.6,0,"YXZ")); }
    else if(this.state==="menu"){ const re=this.ap.runwayEnd("RJOB","07"); const mx=re.e.x+re.e.ux*700+re.e.uz*-90, mz=re.e.z+re.e.uz*700+re.e.ux*90; cam.x=mx; cam.z=mz; cam.y=(re.h||240)+60; camY=cam.y; camera.quaternion.setFromEuler(new T.Euler(-0.05,-(re.e.hdg)-0.9+Math.sin(this.t*0.07)*0.25,0,"YXZ")); if(Math.abs(camera.fov-55)>0.01){ camera.fov=55; camera.updateProjectionMatrix(); } }
    camera.position.set(0,camY,0);
    camera.updateMatrixWorld();
    // 光
    const sk=this.sky, L=this.light; L.sun.position.copy(sk.sunDir).multiplyScalar(100); L.sun.color.copy(sk.sunCol); L.sun.intensity=1.5; L.hemi.color.copy(sk.hemiSky); L.hemi.groundColor.copy(sk.hemiGround); L.hemi.intensity=2.4+this.sky.night*1.6; if(!this.nightFill){ this.nightFill=new T.AmbientLight(0x6a7aa0,0); this.scene.add(this.nightFill); } this.nightFill.intensity=this.sky.night*0.55;
    if(this.state==="fly"&&this.view!=="cockpit") { /* 機体の影は付けない */ }
  }
  // ---------------- 計器へ渡すデータ ----------------
  hudView(){
    const s=this.s, c=this.c, ap=c.ap; const F2=F; const a=F2.atmos(s.pos[1]);
    let windTxt=(((this.wx.curDir||0)/D2R+MV()+360)%360).toFixed(0).padStart(3,"0")+"/"+Math.round((this.wx.curSpd||0)/KT);
    // 次の経由地
    let nextWp=null; if(ap.latMode==="LNAV"&&this.route.length&&ap.wpIndex<this.route.length){ const w=this.route[ap.wpIndex]; const d=Math.hypot(w.x-s.pos[0],w.z-s.pos[2]); const eta=s.gs>30?Math.round(d/s.gs/60)+" 分":""; nextWp={name:w.name,dist:d,eta}; }
    // ILS 表示
    let ils=null; const rf=this.apprState||((ap.latMode==="LOC"&&ap.loc)?{}:null); const fr=this.findApprHint();
    if(ap.loc&&(ap.latMode==="LOC")){ const L=ap.loc; const relx=s.pos[0]-L.x, relz=s.pos[2]-L.z; const fx=Math.sin(L.crs), fz=-Math.cos(L.crs); const dist=-(relx*fx+relz*fz); const xt=relx*(-fz)+relz*fx; const locA=Math.atan2(xt,Math.max(300,dist)); const gsAlt=L.h+Math.tan(L.gs)*(Math.max(0,dist)+(L.aim||300)); const gsA=Math.atan2(s.pos[1]-gsAlt,Math.max(300,dist+300)); ils={name:L.name||"ILS",dist:Math.max(0,dist)/NM,loc:-locA/(1.25*D2R)*1.0*(-1)*(-1),gs:Math.abs(gsA)<6*D2R?gsA/(0.35*D2R):null}; ils.loc=locA/(1.25*D2R); ils.gs=gsA/(0.35*D2R); }
    else if(this.rwyFocus&&!s.onGround){ const g=this.approachGeometry(this.rwyFocus.icao,this.rwyFocus.name); if(g&&g.along>0&&g.along<60000){ const L=g.e; const locA=Math.atan2(g.xt,Math.max(300,g.along)); const gsAlt=g.h+Math.tan(3*D2R)*(g.along+300); const gsA=Math.atan2(s.pos[1]-gsAlt,Math.max(300,g.along+300)); if(Math.abs(locA)<12*D2R) ils={name:this.rwyFocus.icao+" "+this.rwyFocus.name,dist:g.along/NM,loc:locA/(1.25*D2R),gs:gsA/(0.35*D2R)}; } }
    const tod=this.todInfo(); const mach=s.mach; const machCas=(()=>{ if(!(ap.spdIsMach&&ap.mach)) return 0; const m=ap.mach, pt=a.p*Math.pow(1+0.2*m*m,3.5), qc=pt-a.p; return 340.294*Math.sqrt(5*(Math.pow(qc/101325+1,2/7)-1))/KT; })();
    let destInfo=null; if(this.destRwy){ const re=this.ap.runwayEnd(this.destRwy.icao,this.destRwy.name); if(re){ const d=Math.hypot(s.pos[0]-re.e.x,s.pos[2]-re.e.z); destInfo=(this.apName(this.destRwy.icao)+" ")+(d/NM).toFixed(0)+"NM"; } }
    const fe=this.fieldElev();
    let finalLine=null; const rwy=this.rwyFocus||this.destRwy; if(rwy){ const re=this.ap.runwayEnd(rwy.icao,rwy.name); if(re){ const e=re.e; finalLine=[e.x-e.ux*40000,e.z-e.uz*40000,e.x,e.z]; } }
    const apts=[]; for(const a of Object.values(this.ap.ap)){ apts.push({name:this.apName(a.icao),x:a.ref[0],z:a.ref[1],rw:a.runways.map(r=>[r.ax,r.az,r.bx,r.bz])}); }
    const phase=(s.onGround&&!this.landed&&!this.stats.liftoff)?"takeoff":((ap.latMode==="LOC"||s.flaps>3.5||(this.apprState))?"approach":"cruise");
    return { s, ap, assist:c.assist, route:this.route, wpIndex:ap.wpIndex, nextWp, ils, todPt:this.todPt, todTxt:tod?tod.text:null, destInfo, windTxt, machTxt:"M"+mach.toFixed(2).replace(/^0/,""), machCas, vs_:this.vsp, vStall:this.vStall, phase, fieldElevFt:fe, apts, finalLine,
      gsCap:c.gsCap, autobrake:this.pilot.autobrake, spoilerArm:this.pilot.spoilerArm, warn:this.warn, clock:fmtClock(this.sky.hour), msg:this.state==="crashed"?"破損":"" , showAltBug:true };
  }
  findApprHint(){ return null; }
  fieldElev(){ const s=this.s; let best=null,bd=1e12; for(const a of Object.values(this.ap.ap)){ const d=Math.hypot(s.pos[0]-a.ref[0],s.pos[2]-a.ref[1]); if(d<bd&&a.fieldElev!=null){ bd=d; best=a.fieldElev; } } return (bd<30000&&best!=null)?best/FT:null; }
  // ---------------- 音とUI ----------------
  sound(kind,v){ const a=this.audio; if(!a||!a.ok) return; if(kind==="touch") a.bump("touch",clamp(0.25+Math.abs(v)*0.35,0.2,1)); else if(kind==="crash") a.bump("touch",1.4); }
  updateAudio(dt){ const a=this.audio; if(!a||!a.ok||this.state==="loading"||this.state==="menu") return; const w=this.warn[0]; a.update(this.s,{inside:this.view!=="chase",warn:w?w.sound:null,dt}); }
  syncMCP(){ if(this.mcpSync) this.mcpSync(); }
  showEnd(kind){
    const e=$("end"); const s=this.s; let h=""; 
    if(kind==="crash"){ h="<h2>飛行終了</h2><p class='bad'>"+(s.crashMsg||"機体が破損しました")+"</p>"; }
    else { const r=this.touchRep||{}; const parked=kind==="parked"; const rate=Math.abs(r.vs||0); const grade=r.hard?"ハードランディング（機体に負担）":rate<1.5?"とてもなめらかな着陸":rate<2.5?"良い着陸":rate<3.3?"やや硬い着陸":"硬い着陸"; const used=this.stats.startFuel-s.fuel;
      h="<h2>"+(parked?"ゲートに到着しました":"着陸しました")+"</h2><p class='ok'>"+grade+"</p><table>"+
      "<tr><td>接地の降下率</td><td>"+Math.round(r.fpm||0)+" fpm（"+(r.vs||0).toFixed(1)+" m/s）</td></tr>"+
      "<tr><td>接地速度</td><td>"+Math.round(r.cas||0)+" kt（対気）</td></tr>"+
      (r.rwy?"<tr><td>滑走路</td><td>"+this.apName(r.icao)+" RWY "+r.rwy+"（"+(r.onRwy?"滑走路上":"滑走路外！")+"）</td></tr><tr><td>接地位置</td><td>しきい値から "+Math.round(r.dist)+" m ／ 中心線から "+(r.lat>=0?"右":"左")+" "+Math.abs(r.lat).toFixed(0)+" m</td></tr>":"")+
      "<tr><td>使った燃料</td><td>"+Math.round(used)+" kg</td></tr></table>"; }
    h+="<div class='btns'>"+((kind==="landed"&&this.arrivalPlan)?"<button id='endGate'>ゲートまで自動で走る</button>":"")+"<button id='endRetry'>もう一度（同じ条件）</button><button id='endMenu'>メニューへ</button></div>"; e.firstElementChild.innerHTML=h; e.style.display="flex";
    if($("endGate")) $("endGate").onclick=()=>{ e.style.display="none"; this.startArrivalTaxi(); };
    $("endRetry").onclick=()=>{ e.style.display="none"; this.startScenario(this.sceneId); }; $("endMenu").onclick=()=>{ e.style.display="none"; this.state="menu"; $("menu").style.display="flex"; this.acft.root.visible=false; if(this.ui) this.ui.showPlay(false); };
  }
}
function pilot_spoil(g){ return g.pilot.spoilerArm&&g.landed; }
function pilotThrust(s){ return (s.thr[0]+s.thr[1])/2; }
function pilot_set(g){ g.c.ap.on=false; g.c.ap.athr=false; if(g.c.ap.vertMode==="GS"){ g.c.ap.vertMode="ALT"; } g.pilot.throttle=0; }
root.Game=Game; Game.GEO_WPT=GEO_WPT; Game.fmtClock=fmtClock;
})(typeof window!=="undefined"?window:globalThis);
