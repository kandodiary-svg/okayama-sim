/* 飛行中の地図（北が上・自機中心）。
   ・背景: 国土地理院の標高データ（地形と同じタイル）から、海・陸・山の高さを色分け＋陰影で描く。タイルは必要な分だけ読み込む。
   ・重ねる物: 空港（名前・滑走路）、飛行経路、いままでの航跡、目的地、燃料で行ける範囲、自機。
   ・操作: ＋／−（拡大・縮小）、「自動」（目的地が収まる縮尺に自動で合わせる）、⤢（大きく）、✕（消す）。キー: ` （バッククォート）で 小→大→消す。 */
(function(root){
"use strict";
const G=root.GEO, D2R=Math.PI/180, KT=0.514444, NM=1852;
const ZOOMS=[10,20,40,80,160,320,640,1200];     // 地図の一辺の半分 [km]
const RAMP=[[0.5,[104,152,94]],[150,[134,168,100]],[400,[172,178,110]],[800,[198,180,122]],[1400,[178,150,110]],[2200,[152,132,114]],[3000,[236,233,227]]];
const SEA=[20,56,90];
function ramp(h){ if(h<=RAMP[0][0]) return RAMP[0][1]; for(let i=1;i<RAMP.length;i++){ if(h<=RAMP[i][0]){ const a=RAMP[i-1],b=RAMP[i],t=(h-a[0])/(b[0]-a[0]); return [a[1][0]+(b[1][0]-a[1][0])*t,a[1][1]+(b[1][1]-a[1][1])*t,a[1][2]+(b[1][2]-a[1][2])*t]; } } return RAMP[RAMP.length-1][1]; }
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
function fmtLL(x,z){ const ll=G.xz2ll(x,z); const f=(v,p,n)=>{ const a=Math.abs(v), d=Math.floor(a), m=(a-d)*60; return (v<0?n:p)+d+"°"+m.toFixed(1)+"′"; }; return f(ll[0],"N","S")+" "+f(ll[1],"E","W"); }
function niceKm(km){ const p=Math.pow(10,Math.floor(Math.log10(km))); for(const m of [1,2,5,10]) if(m*p>=km) return m*p; return 10*p; }

class FlightMap{
  constructor(game,terrain,ap){
    this.g=game; this.T=terrain; this.A=ap; this.mode=1; this.zi=3; this.auto=true; this.trail=[]; this.sRef=null; this.lastPush=-1e9;
    this.cache={}; this.bg=null; this.bgInfo=null; this.dirty=true; this.lastDraw=0; this.lastBg=0; this.pending=false; this.tick=0; this.autoT=0;
    try{ const m=localStorage.getItem("fs.map.mode"); if(m!==null&&+m>=0&&+m<=2) this.mode=+m; }catch(e){}
    const box=this.box=document.createElement("div"); box.id="mapbox"; box.style.display="none";
    box.innerHTML="<canvas id='mapcv'></canvas><div class='mp-bar'><button data-a='in' title='拡大'>＋</button><button data-a='out' title='縮小'>−</button><button data-a='auto' title='目的地が収まる縮尺に自動で合わせる'>自動</button><button data-a='big' title='大きさを変える (`)'>⤢</button><button data-a='x' title='地図を消す (`)'>✕</button></div>";
    document.body.appendChild(box); this.cv=box.querySelector("canvas"); this.cx=this.cv.getContext("2d");
    box.addEventListener("click",e=>{ const a=e.target&&e.target.getAttribute&&e.target.getAttribute("data-a"); if(!a) return;
      if(a==="in"){ this.auto=false; this.zi=Math.max(0,this.zi-1); } else if(a==="out"){ this.auto=false; this.zi=Math.min(ZOOMS.length-1,this.zi+1); }
      else if(a==="auto"){ this.auto=!this.auto; this.autoT=0; } else if(a==="big"){ this.setMode(this.mode===2?1:2); } else if(a==="x"){ this.setMode(0); }
      this.dirty=true; e.stopPropagation(); });
    box.addEventListener("wheel",e=>{ e.preventDefault(); this.auto=false; this.zi=clamp(this.zi+(e.deltaY>0?1:-1),0,ZOOMS.length-1); this.dirty=true; },{passive:false});
    const st=document.createElement("style"); st.textContent="#mapbox{position:fixed;left:8px;top:8px;z-index:8;background:rgba(6,14,22,.86);border:1px solid #2b4560;border-radius:10px;padding:0;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.45)}#mapbox canvas{display:block}#mapbox .mp-bar{position:absolute;right:3px;top:3px;display:flex;gap:3px}#mapbox .mp-bar button{font-size:12px;line-height:1;padding:4px 7px;border-radius:6px;background:rgba(10,20,30,.78);color:#dfeaf5;border:1px solid #3a5470;cursor:pointer}#mapbox .mp-bar button.on{background:#1f6fb5;border-color:#58c4ff}body.map-on.v-cockpit #bar,body.map-on.v-window #bar{top:calc(var(--mapH,0px) + 18px)}";
    document.head.appendChild(st);
    addEventListener("resize",()=>{ this.dirty=true; });
  }
  setMode(m){ this.mode=m; this.dirty=true; try{ localStorage.setItem("fs.map.mode",String(m)); }catch(e){} }
  cycle(){ this.setMode((this.mode+1)%3); }
  // ---- 大きさ ----
  size(){ if(this.mode===2) return Math.round(Math.min(innerHeight*0.72,innerWidth*0.92,600)); return innerWidth<760?132:Math.min(190,Math.round(innerHeight*0.34)); }
  // ---- 標高の取得（読み込み済みの一番細かいタイルから）----
  node(zz,tx,ty){ let m=this.cache[zz]; if(!m) m=this.cache[zz]=new Map(); const k=tx*20000+ty; let n=m.get(k); if(n===undefined){ n=this.T.node(zz,tx,ty)||null; m.set(k,n); } return n; }
  hAt(x,z,zmax){ for(let zz=zmax;zz>=7;zz--){ const t=G.xz2tile(zz,x,z); const n=this.node(zz,t[0],t[1]); if(n&&n.dem) return this.T.sampleNode(n,x,z); } return 0; }
  request(cx,cz,half,zmax){
    let pend=false; const levels=new Set([7,Math.min(zmax,Math.floor((7+zmax)/2)),zmax]);
    for(const zz of levels){ const t0=G.xz2tile(zz,cx-half,cz-half), t1=G.xz2tile(zz,cx+half,cz+half);
      for(let ty=t0[1];ty<=t1[1];ty++) for(let tx=t0[0];tx<=t1[0];tx++){ const n=this.node(zz,tx,ty); if(!n) continue; n.lastUsed=this.T.frame; if(n.demState!==2){ this.T.request(n,-1e9+zz); if(zz===zmax||zz===7) pend=true; } } }
    return pend;
  }
  // ---- 背景の描き直し（自機を中心に、表示範囲の 1.4 倍）----
  renderBg(cx,cz,halfView){
    const side=halfView*2*1.4, B=this.mode===2?210:128; const sp=side/B; const T0=G.KR*2*Math.PI;
    const zmax=clamp(Math.ceil(Math.log2(T0/(64*sp))),7,Math.min(12,this.T.maxZ||12));
    const pend=this.request(cx,cz,side/2,zmax);
    const N=B+2, H=new Float32Array(N*N); const x0=cx-side/2-sp, z0=cz-side/2-sp;
    for(let j=0;j<N;j++) for(let i=0;i<N;i++) H[j*N+i]=this.hAt(x0+i*sp,z0+j*sp,zmax);
    if(!this.bg){ this.bg=document.createElement("canvas"); }
    this.bg.width=this.bg.height=B; const c=this.bg.getContext("2d"); const im=c.createImageData(B,B); const d=im.data;
    for(let j=0;j<B;j++) for(let i=0;i<B;i++){
      const h=H[(j+1)*N+i+1]; let r,g,b;
      if(h<=0.5){ r=SEA[0]; g=SEA[1]; b=SEA[2]; }
      else { const col=ramp(h); const sh=1+clamp((H[(j+2)*N+i+2]-H[j*N+i])/sp*2.6,-0.5,0.5); r=col[0]*sh; g=col[1]*sh; b=col[2]*sh; }
      const k=(j*B+i)*4; d[k]=r; d[k+1]=g; d[k+2]=b; d[k+3]=255; }
    c.putImageData(im,0,0);
    this.bgInfo={cx,cz,side}; this.pending=pend; this.lastBg=performance.now();
  }
  // ---- 毎フレーム ----
  update(dt){
    const g=this.g, playing=(g.state==="fly"||g.state==="crashed");
    const on=playing&&this.mode>0; if(this.box.style.display!==(on?"block":"none")) this.box.style.display=on?"block":"none";
    document.body.classList.toggle("map-on",on); if(!playing){ this.sRef=null; return; }
    const s=g.s; if(this.sRef!==s){ this.sRef=s; this.trail=[]; this.lastPush=-1e9; this.auto=true; this.dirty=true; }
    if(s.t-this.lastPush>4||s.t<this.lastPush){ this.lastPush=s.t; this.trail.push([s.pos[0],s.pos[2]]); if(this.trail.length>1800){ const t=[]; for(let i=0;i<this.trail.length;i+=2) t.push(this.trail[i]); this.trail=t; } }
    if(!on) return;
    const now=performance.now(); if(now-this.lastDraw<100&&!this.dirty) return; this.lastDraw=now;
    this.draw();
  }
  destPoint(){ const g=this.g; if(!g.destRwy) return null; const re=this.A.runwayEnd(g.destRwy.icao,g.destRwy.name); return re?{x:re.e.x,z:re.e.z,icao:g.destRwy.icao,name:g.destRwy.name}:null; }
  draw(){
    const g=this.g, s=g.s, S=this.size(), dpr=Math.min(2,window.devicePixelRatio||1);
    if(this.cv.width!==Math.round(S*dpr)){ this.cv.width=Math.round(S*dpr); this.cv.height=Math.round(S*dpr); this.cv.style.width=S+"px"; this.cv.style.height=S+"px"; this.box.style.setProperty("--mapH",S+"px"); this.bgInfo=null; }
    const x=this.cx; x.setTransform(dpr,0,0,dpr,0,0);
    const px=s.pos[0], pz=s.pos[2]; const dest=this.destPoint();
    // 自動の縮尺: 目的地が収まるように（近づくと拡大）
    if(this.auto){ this.autoT-=0.1; if(this.autoT<=0||this.dirty){ this.autoT=4; const d=dest?Math.hypot(dest.x-px,dest.z-pz)/1000:60; let zi=ZOOMS.findIndex(h=>h*0.82>=d); if(zi<0) zi=ZOOMS.length-1; zi=Math.max(zi,1); if(zi!==this.zi){ if(zi>this.zi||d<ZOOMS[this.zi]*0.34) this.zi=zi; } } }
    const half=ZOOMS[this.zi]*1000, sc=S/(half*2);       // m → px
    const bi=this.bgInfo; const stale=!bi||Math.hypot(px-bi.cx,pz-bi.cz)>half*0.38||Math.abs(bi.side-half*2*1.4)>1||(this.pending&&performance.now()-this.lastBg>1400);
    if(stale||this.dirty&&!bi) this.renderBg(px,pz,half);
    this.dirty=false;
    const P=(wx,wz)=>[S/2+(wx-px)*sc,S/2+(wz-pz)*sc];
    x.save(); x.beginPath(); x.rect(0,0,S,S); x.clip(); x.fillStyle="#142a40"; x.fillRect(0,0,S,S);
    if(this.bg&&this.bgInfo){ const b=this.bgInfo; const o=P(b.cx-b.side/2,b.cz-b.side/2); const w=b.side*sc; x.imageSmoothingEnabled=true; x.imageSmoothingQuality="high"; x.drawImage(this.bg,o[0],o[1],w,w); }
    // 距離の同心円（地図の端の 1/2）
    x.strokeStyle="rgba(255,255,255,.16)"; x.lineWidth=1; x.beginPath(); x.arc(S/2,S/2,S/4,0,7); x.stroke();
    // 燃料で行ける範囲
    const fu=g.fu; if(fu&&fu.endMin!=null&&!s.onGround){ const rng=fu.endMin*60*Math.max(s.gs,120); if(rng*sc<S*1.6&&fu.endMin<150){ x.strokeStyle=fu.endMin<20?"#ff5a4d":"#ffb11a"; x.lineWidth=1.6; x.setLineDash([5,4]); x.beginPath(); x.arc(S/2,S/2,rng*sc,0,7); x.stroke(); x.setLineDash([]); } }
    // 航跡
    if(this.trail.length>1){ x.strokeStyle="rgba(255,226,120,.9)"; x.lineWidth=2; x.beginPath(); let first=true; for(const t of this.trail){ const p=P(t[0],t[1]); if(first){ x.moveTo(p[0],p[1]); first=false; } else x.lineTo(p[0],p[1]); } const q=P(px,pz); x.lineTo(q[0],q[1]); x.stroke(); }
    // 経路（これから）
    const rt=g.route||[]; if(rt.length){ const act=Math.min(g.c.ap.wpIndex||0,rt.length-1); x.strokeStyle="#ff6ee0"; x.lineWidth=2; x.setLineDash([6,4]); x.beginPath(); let p=P(px,pz); x.moveTo(p[0],p[1]); for(let i=act;i<rt.length;i++){ p=P(rt[i].x,rt[i].z); x.lineTo(p[0],p[1]); } if(dest){ p=P(dest.x,dest.z); x.lineTo(p[0],p[1]); } x.stroke(); x.setLineDash([]);
      x.fillStyle="#ff6ee0"; for(let i=act;i<rt.length;i++){ const q=P(rt[i].x,rt[i].z); x.beginPath(); x.moveTo(q[0],q[1]-4); x.lineTo(q[0]+4,q[1]); x.lineTo(q[0],q[1]+4); x.lineTo(q[0]-4,q[1]); x.closePath(); x.fill(); } }
    // 空港
    const showRw=half<=45000, showName=half<=170000; x.font="600 10px -apple-system,'Hiragino Sans',sans-serif"; x.textBaseline="middle";
    for(const k of Object.keys(this.A.ap)){ const a=this.A.ap[k]; const p=P(a.ref[0],a.ref[1]); if(p[0]<-30||p[0]>S+30||p[1]<-30||p[1]>S+30) continue; const isDest=dest&&dest.icao===k;
      if(showRw){ x.strokeStyle="#f2f5f8"; x.lineWidth=Math.max(1.5,60*sc); for(const r of a.runways){ const A1=P(r.ax,r.az),B1=P(r.bx,r.bz); x.beginPath(); x.moveTo(A1[0],A1[1]); x.lineTo(B1[0],B1[1]); x.stroke(); } }
      x.fillStyle=isDest?"#58e0ff":"#ffffff"; x.strokeStyle="#0a1520"; x.lineWidth=1.5; x.beginPath(); x.arc(p[0],p[1],isDest?5:3.2,0,7); x.fill(); x.stroke();
      if(!isDest&&half>(this.mode===2?400000:160000)) continue; const label=showName?(g.apName(k)+" "+k):k; x.fillStyle=isDest?"#9fefff":"#eaf2fa"; x.strokeStyle="rgba(5,12,20,.9)"; x.lineWidth=3; x.textAlign="left"; x.strokeText(label,p[0]+7,p[1]-1); x.fillText(label,p[0]+7,p[1]-1); }
    // 自機
    x.save(); x.translate(S/2,S/2); x.rotate(s.psi); x.fillStyle="#ffd84a"; x.strokeStyle="#1a1200"; x.lineWidth=1.6; x.beginPath(); x.moveTo(0,-11); x.lineTo(2.4,-3); x.lineTo(10,3); x.lineTo(10,5.5); x.lineTo(2.2,3); x.lineTo(1.8,8); x.lineTo(5,10.5); x.lineTo(5,12); x.lineTo(0,10.6); x.lineTo(-5,12); x.lineTo(-5,10.5); x.lineTo(-1.8,8); x.lineTo(-2.2,3); x.lineTo(-10,5.5); x.lineTo(-10,3); x.lineTo(-2.4,-3); x.closePath(); x.fill(); x.stroke(); x.restore();
    x.restore();
    // 文字
    x.textBaseline="alphabetic"; const txt=(t,tx,ty,col,sz,al)=>{ x.font=(sz>=12?"700 ":"600 ")+sz+"px -apple-system,'Hiragino Sans',sans-serif"; x.textAlign=al||"left"; x.lineWidth=3; x.strokeStyle="rgba(4,10,16,.92)"; x.strokeText(t,tx,ty); x.fillStyle=col; x.fillText(t,tx,ty); };
    // 北
    const small0=S<150;
    x.save(); x.translate(S-14,small0?36:40); x.strokeStyle="#fff"; x.fillStyle="#fff"; x.lineWidth=1.4; x.beginPath(); x.moveTo(0,10); x.lineTo(0,-6); x.stroke(); x.beginPath(); x.moveTo(0,-9); x.lineTo(4,-3); x.lineTo(-4,-3); x.closePath(); x.fill(); x.restore(); txt("N",S-10,small0?40:44,"#fff",10);
    // 縮尺バー
    const SB=S-(S<150?46:50);
    const km=niceKm(ZOOMS[this.zi]*0.5), barW=km*1000*sc; x.strokeStyle="#fff"; x.lineWidth=2; x.beginPath(); x.moveTo(8,SB-5); x.lineTo(8,SB); x.lineTo(8+barW,SB); x.lineTo(8+barW,SB-5); x.stroke(); txt(km+" km",12+barW,SB-2,"#fff",10);
    // 下の情報（小さい地図では緯度経度を省く）
    const ln=[]; const small=S<150; if(!small) ln.push([fmtLL(px,pz)+"  高度 "+Math.round(s.pos[1]/0.3048).toLocaleString()+" ft","#e8f3ff"]);
    if(dest){ const d=Math.hypot(dest.x-px,dest.z-pz); const eta=s.gs>40?d/s.gs/60:null; ln.push([(small?"":g.apName(dest.icao)+" ")+dest.icao+" まで "+(d/1000).toFixed(0)+" km"+(eta!=null&&!s.onGround&&!small?"（約"+Math.round(eta)+"分）":""),"#e8f3ff"]); }
    if(fu){ const em=fu.endMin; ln.push(["燃料 "+Math.round(s.fuel).toLocaleString()+" kg"+(em!=null&&em<999&&!s.onGround?(small?" あと"+Math.round(em)+"分":" ・あと約"+Math.round(em)+"分"):""),fu.lv>=2?"#ff7a6e":(fu.lv===1?"#ffcf66":"#e8f3ff")]); }
    x.font="600 10px -apple-system,'Hiragino Sans',sans-serif"; let pw=0; for(const l of ln) pw=Math.max(pw,x.measureText(l[0]).width); const ph=ln.length*12+6;
    if(ln.length){ x.fillStyle="rgba(5,12,20,.72)"; x.fillRect(4,S-ph-4,Math.min(S-8,pw+10),ph); }
    const y0=S-ph-4+14; ln.forEach((l,i)=>txt(l[0],9,y0+i*12-1,l[1],10));
    // ボタンの状態
    const ab=this.box.querySelector("[data-a=auto]"); if(ab) ab.classList.toggle("on",this.auto);
  }
}
root.FlightMap=FlightMap;
})(typeof window!=="undefined"?window:globalThis);
