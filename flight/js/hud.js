/* 計器（キャンバス描画）: PFD（姿勢・速度・高度・方位・ILS）、ND（地図）、エンジン／機体状態。
   ここは「表示」だけ。値は game.js が view オブジェクトで渡す。単位は表示用に kt / ft / fpm / 磁方位。 */
(function(root){
"use strict";
const D2R=Math.PI/180, KT=0.514444, FT=0.3048, MV=()=>root.MAGVAR_NOW||7.5;
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const n180=a=>{ a=((a+180)%360+360)%360-180; return a; };
const mag=(trueRad)=>(((trueRad/D2R)+MV())%360+360)%360;
const COL={ sky:"#2f6fd0", sky2:"#5aa0ec", gnd:"#7b5a2e", gnd2:"#4d3819", w:"#f4f6f8", g:"#38e06a", m:"#ff5ad8", c:"#3ddcff", a:"#ffb11a", r:"#ff3b30", bg:"#0a0f14", dim:"#8a97a6", panel:"#11181f" };
function txt(x,t,px,py,col,size,al,font){ x.fillStyle=col; x.font=(font||"")+" "+size+"px ui-monospace,Menlo,Consolas,'DejaVu Sans Mono',monospace"; x.textAlign=al||"left"; x.textBaseline="middle"; x.fillText(t,px,py); }

class Hud{
  constructor(canvas){ this.cv=canvas; this.x=canvas.getContext("2d"); this.ndRange=20; this.t=0; }
  size(w,h,dpr){ this.cv.width=Math.round(w*dpr); this.cv.height=Math.round(h*dpr); this.dpr=dpr; this.w=w; this.h=h; }
  draw(v){
    const x=this.x; this.t+=1/30; x.setTransform(this.dpr,0,0,this.dpr,0,0); x.clearRect(0,0,this.w,this.h);
    // 論理座標: 3 枚のパネル（各 300x300）を横に並べる 940x310
    const k=Math.min(this.w/940,this.h/310); x.save(); x.translate((this.w-940*k)/2,(this.h-310*k)/2); x.scale(k,k);
    this.pfd(x,v,0,0); this.nd(x,v,320,0); this.eng(x,v,640,0);
    x.restore();
  }
  // ---------------- PFD ----------------
  pfd(x,v,ox,oy){
    const s=v.s, ap=v.ap; x.save(); x.translate(ox,oy);
    x.fillStyle=COL.bg; x.fillRect(0,0,300,310); x.strokeStyle="#2a3541"; x.lineWidth=2; x.strokeRect(1,1,298,308);
    const cx=150, cy=140, R=104, ppd=4.2;                 // 姿勢指示器の中心・半径・1° あたりの px
    // --- 姿勢 ---
    x.save(); x.beginPath(); x.rect(cx-R-14,cy-R,2*R+28,2*R); x.clip(); x.translate(cx,cy); x.rotate(-s.phi);
    const py=s.theta/D2R*ppd; x.translate(0,py);
    let g=x.createLinearGradient(0,-600,0,0); g.addColorStop(0,COL.sky); g.addColorStop(1,COL.sky2); x.fillStyle=g; x.fillRect(-500,-900,1000,900);
    g=x.createLinearGradient(0,0,0,300); g.addColorStop(0,COL.gnd); g.addColorStop(1,COL.gnd2); x.fillStyle=g; x.fillRect(-500,0,1000,900);
    x.strokeStyle="#fff"; x.lineWidth=2; x.beginPath(); x.moveTo(-500,0); x.lineTo(500,0); x.stroke();
    x.lineWidth=1.5; x.fillStyle="#fff"; x.font="11px ui-monospace,Menlo,monospace"; x.textAlign="center"; x.textBaseline="middle";
    for(let p=-30;p<=30;p+=2.5){ if(p===0) continue; const yy=-p*ppd; const L=(p%10===0)?44:(p%5===0)?26:12; x.beginPath(); x.moveTo(-L,yy); x.lineTo(L,yy); x.stroke(); if(p%10===0){ x.fillText(Math.abs(p),-L-12,yy); x.fillText(Math.abs(p),L+12,yy); } }
    x.restore();
    // バンク目盛り
    x.save(); x.translate(cx,cy); x.strokeStyle="#fff"; x.lineWidth=2; for(const a of [-60,-45,-30,-20,-10,0,10,20,30,45,60]){ const r=a*D2R; const L=(a%30===0||Math.abs(a)===45||a===0)?12:7; x.beginPath(); x.moveTo(Math.sin(r)*R,-Math.cos(r)*R); x.lineTo(Math.sin(r)*(R-L),-Math.cos(r)*(R-L)); x.stroke(); }
    x.rotate(-s.phi); x.fillStyle=COL.a; x.beginPath(); x.moveTo(0,-R+1); x.lineTo(-7,-R+14); x.lineTo(7,-R+14); x.closePath(); x.fill(); x.restore();
    // 機体シンボル
    x.strokeStyle=COL.a; x.lineWidth=3.5; x.beginPath(); x.moveTo(cx-48,cy); x.lineTo(cx-18,cy); x.lineTo(cx-18,cy+8); x.moveTo(cx+48,cy); x.lineTo(cx+18,cy); x.lineTo(cx+18,cy+8); x.stroke(); x.fillStyle=COL.a; x.fillRect(cx-2.5,cy-2.5,5,5);
    // 飛行経路ベクトル
    if(s.gs>5){ const trk=Math.atan2(s.vel[0],-s.vel[2]), gam=Math.atan2(s.vel[1],s.gs); const dx=clamp(n180((trk-s.psi)/D2R)*ppd,-90,90), dy=clamp(-(gam-s.theta)/D2R*ppd,-90,90);
      // ロールで回す
      const c=Math.cos(s.phi), sn=Math.sin(s.phi); const rx=dx*c-(dy)*sn*0+0; const X=cx+dx*c-0, Y=cy+dy+dx*sn*0; x.save(); x.translate(cx,cy); x.rotate(0); x.strokeStyle=COL.g; x.lineWidth=2; const fx=dx, fy=dy; x.beginPath(); x.arc(fx,fy,6,0,7); x.moveTo(fx-6,fy); x.lineTo(fx-16,fy); x.moveTo(fx+6,fy); x.lineTo(fx+16,fy); x.moveTo(fx,fy-6); x.lineTo(fx,fy-12); x.stroke(); x.restore(); }
    // --- FMA ---
    x.fillStyle="#0d141b"; x.fillRect(0,0,300,26); x.strokeStyle="#26323d"; x.lineWidth=1; x.strokeRect(0.5,0.5,299,25);
    const thrM = ap.on&&ap.athr ? (ap.vertMode==="FLCH"?(ap.flchThr>0.5?"N1":"RETARD"):(v.s.onGround?"":(ap.spdIsMach?"MCP SPD":"MCP SPD"))) : (s.onGround?"":"");
    const latM = ap.on ? (ap.latMode==="LOC"?"LOC":ap.latMode==="LNAV"?"LNAV":"HDG SEL") : "";
    const vertM= ap.on ? (ap.vertMode==="GS"?(v.gsCap?"G/S":"G/S ARM"):ap.vertMode==="ALT"?"ALT HOLD":ap.vertMode==="VS"?"V/S":"FLCH SPD") : "";
    x.textAlign="center"; txt(x,"",0,0,"#fff",1); txt(x,thrM,50,13,COL.g,12,"center"); txt(x,latM,150,13,COL.g,12,"center"); txt(x,vertM,250,13,COL.g,12,"center");
    if(ap.on){ txt(x,"A/P",150,36,COL.g,11,"center","bold"); }
    if(ap.athr) txt(x,"A/T",50,36,COL.g,11,"center","bold");
    if(v.assist===false) txt(x,"DIRECT",250,36,COL.a,11,"center","bold");
    // --- 速度テープ ---
    const cas=s.cas/KT; x.save(); x.beginPath(); x.rect(4,40,56,200); x.clip(); x.fillStyle="rgba(20,28,36,.92)"; x.fillRect(4,40,56,200);
    const sc=1.9; const yv=u=>140-(u-cas)*sc;   // 1kt = 1.9px
    x.strokeStyle="#cfd6de"; x.lineWidth=1.5; x.fillStyle="#cfd6de"; x.font="12px ui-monospace,Menlo,monospace"; x.textAlign="right"; x.textBaseline="middle";
    for(let u=Math.floor((cas-60)/10)*10;u<=cas+60;u+=10){ if(u<30) continue; const yy=yv(u); x.beginPath(); x.moveTo(60,yy); x.lineTo(u%20===0?46:52,yy); x.stroke(); if(u%20===0) x.fillText(String(u),42,yy); }
    // 速度域（赤: Vmo 超過 / 琥珀: 失速警報速度）
    const vmo=340; x.fillStyle="#d02a20"; const yvmo=yv(vmo); if(yvmo<240){ for(let yy=Math.max(40,yvmo);yy<240;yy+=8){ x.fillRect(56,yy,4,4); } }
    if(v.vStall){ const ys=yv(v.vStall*1.0); x.fillStyle="#d02a20"; for(let yy=Math.min(240,ys);yy>40;yy-=8) x.fillRect(56,yy-4,4,4); const yw=yv(v.vStall*1.07); x.fillStyle=COL.a; x.fillRect(58,Math.min(240,yw),2,Math.max(0,Math.min(240,ys)-Math.min(240,yw))); }
    // 離陸・進入の基準速度
    const bug=(val,label,col)=>{ const yy=yv(val); if(yy<42||yy>238) return; x.strokeStyle=col; x.fillStyle=col; x.lineWidth=2; x.beginPath(); x.moveTo(60,yy); x.lineTo(50,yy); x.stroke(); x.font="10px ui-monospace,monospace"; x.textAlign="left"; x.fillText(label,6,yy); };
    if(v.vs_){ if(s.onGround||v.phase==="takeoff"){ bug(v.vs_.v1,"V1","#fff"); bug(v.vs_.vr,"VR",COL.c); bug(v.vs_.v2,"V2",COL.g); } if(v.phase==="approach"||s.flaps>5.5) bug(v.vs_.vref,"REF",COL.c); }
    // 目標速度（シアン）
    if(ap.on&&ap.athr&&!(ap.vertMode==="GS"&&0)){ const ts=ap.spdIsMach?(v.machCas||0):ap.spd/KT; const yy=clamp(yv(ts),42,238); x.fillStyle=COL.m; x.beginPath(); x.moveTo(60,yy); x.lineTo(50,yy-7); x.lineTo(50,yy+7); x.closePath(); x.fill(); }
    x.restore();
    // 現在速度ボックス
    x.fillStyle="#000"; x.strokeStyle="#cfd6de"; x.lineWidth=1.5; x.beginPath(); x.moveTo(4,140); x.lineTo(14,128); x.lineTo(56,128); x.lineTo(56,152); x.lineTo(14,152); x.closePath(); x.fill(); x.stroke();
    txt(x,String(Math.max(0,Math.round(cas))),52,140,s.overspeed?COL.r:(s.stallWarn?COL.a:"#fff"),17,"right","bold");
    txt(x,v.machTxt||"",32,252,"#fff",12,"center"); txt(x,"GS "+Math.round(s.gs/KT),32,266,COL.dim,11,"center");
    // --- 高度テープ ---
    const alt=s.pos[1]/FT; x.save(); x.beginPath(); x.rect(236,40,60,200); x.clip(); x.fillStyle="rgba(20,28,36,.92)"; x.fillRect(236,40,60,200);
    const ya=u=>140-(u-alt)*0.19; x.strokeStyle="#cfd6de"; x.fillStyle="#cfd6de"; x.lineWidth=1.5; x.textAlign="left"; x.font="12px ui-monospace,Menlo,monospace";
    for(let u=Math.floor((alt-600)/100)*100;u<=alt+600;u+=100){ const yy=ya(u); x.beginPath(); x.moveTo(236,yy); x.lineTo(u%500===0?252:246,yy); x.stroke(); if(u%200===0) x.fillText(String(u),256,yy); }
    if(v.fieldElevFt!=null&&alt<v.fieldElevFt+600){ const yy=ya(v.fieldElevFt); x.fillStyle="rgba(180,120,40,.55)"; x.fillRect(236,yy,24,300); }
    const tgt=ap.alt/FT; if(ap.on||v.showAltBug){ const yy=clamp(ya(tgt),44,236); x.fillStyle=COL.c; x.beginPath(); x.moveTo(236,yy); x.lineTo(248,yy-8); x.lineTo(248,yy+8); x.closePath(); x.fill(); }
    x.restore();
    x.fillStyle="#000"; x.strokeStyle="#cfd6de"; x.lineWidth=1.5; x.beginPath(); x.moveTo(296,140); x.lineTo(286,128); x.lineTo(236,128); x.lineTo(236,152); x.lineTo(286,152); x.closePath(); x.fill(); x.stroke();
    txt(x,String(Math.round(alt)),284,140,"#fff",17,"right","bold");
    txt(x,"目標 "+Math.round(tgt/100)*100,266,34,ap.on?COL.c:COL.dim,11,"center");
    const ra=s.radAlt/FT; if(ra<2500){ x.fillStyle="#000"; x.fillRect(244,226,48,16); txt(x,String(Math.round(ra)),288,234,ra<400?COL.a:COL.g,13,"right","bold"); txt(x,"RA",250,234,COL.dim,9,"left"); }
    // 昇降率
    { const vs=s.vel[1]/FT*60; x.fillStyle="rgba(20,28,36,.9)"; x.fillRect(214,60,18,160); x.strokeStyle="#9aa6b2"; x.lineWidth=1; for(const f of [-4000,-2000,-1000,0,1000,2000,4000]){ const yy=140-clamp(f,-4000,4000)/4000*76*(f>=0?1:1); x.beginPath(); x.moveTo(214,yy); x.lineTo(f%2000===0||f===0?224:221,yy); x.stroke(); }
      const yp=140-clamp(vs,-4000,4000)/4000*76; x.strokeStyle="#fff"; x.lineWidth=2.5; x.beginPath(); x.moveTo(232,140); x.lineTo(218,yp); x.stroke(); txt(x,(vs>=0?"+":"")+Math.round(vs/50)*50,223,yp+(vs>=0?-12:12),"#fff",10,"center"); }
    // --- 方位テープ ---
    x.save(); x.beginPath(); x.rect(40,258,220,44); x.clip(); x.fillStyle="rgba(20,28,36,.92)"; x.fillRect(40,258,220,44);
    const hd=mag(s.psi), tk=s.gs>8?mag(Math.atan2(s.vel[0],-s.vel[2])):hd; const xh=u=>150+n180(u-hd)*3.4;
    x.strokeStyle="#cfd6de"; x.fillStyle="#cfd6de"; x.lineWidth=1.5; x.font="11px ui-monospace,Menlo,monospace"; x.textAlign="center";
    for(let u=Math.floor(hd/5)*5-35;u<=hd+35;u+=5){ const xx=xh(((u%360)+360)%360); x.beginPath(); x.moveTo(xx,258); x.lineTo(xx,u%10===0?270:264); x.stroke(); if(u%10===0){ const nn=(((u%360)+360)%360)/10; let lb=String(Math.round(nn)).padStart(2,"0"); if(nn===0) lb="N"; else if(nn===9) lb="E"; else if(nn===18) lb="S"; else if(nn===27) lb="W"; x.fillText(lb,xx,281); } }
    const hb=ap.hdg/D2R+MV(); if(ap.on&&ap.latMode==="HDG"){ const xx=clamp(xh(((hb%360)+360)%360),44,256); x.fillStyle=COL.m; x.beginPath(); x.moveTo(xx,258); x.lineTo(xx-6,264); x.lineTo(xx+6,264); x.closePath(); x.fill(); }
    x.restore();
    x.fillStyle="#000"; x.strokeStyle="#cfd6de"; x.strokeRect(124,288,52,15); txt(x,String(Math.round(hd)%360).padStart(3,"0")+"°",150,296,"#fff",13,"center","bold");
    x.strokeStyle=COL.a; x.lineWidth=2; x.beginPath(); x.moveTo(150,258); x.lineTo(150,252); x.stroke();
    // --- ILS ---
    if(v.ils){ const I=v.ils; x.save(); // ローカライザー（姿勢指示器の下）
      x.strokeStyle="#fff"; x.fillStyle="#fff"; x.lineWidth=1; for(let i=-2;i<=2;i++){ if(i===0) continue; x.beginPath(); x.arc(cx+i*22,cy+R+10,3,0,7); x.stroke(); } x.beginPath(); x.moveTo(cx,cy+R+3); x.lineTo(cx,cy+R+17); x.stroke();
      const lx=clamp(I.loc,-2.4,2.4)*22; x.fillStyle=COL.m; x.beginPath(); x.moveTo(cx+lx,cy+R+3); x.lineTo(cx+lx+8,cy+R+10); x.lineTo(cx+lx,cy+R+17); x.lineTo(cx+lx-8,cy+R+10); x.closePath(); x.fill();
      // グライドスロープ（高度テープの内側）
      const gxx=206; for(let i=-2;i<=2;i++){ if(i===0) continue; x.beginPath(); x.arc(gxx,cy+i*22*0.8,3,0,7); x.strokeStyle="#fff"; x.stroke(); } x.beginPath(); x.moveTo(gxx-7,cy); x.lineTo(gxx+7,cy); x.strokeStyle="#fff"; x.stroke();
      if(I.gs!=null){ const gy=clamp(-I.gs,-2.4,2.4)*17.6; x.fillStyle=COL.m; x.beginPath(); x.moveTo(gxx,cy+gy-8); x.lineTo(gxx+7,cy+gy); x.lineTo(gxx,cy+gy+8); x.lineTo(gxx-7,cy+gy); x.closePath(); x.fill(); }
      txt(x,I.name,66,60,COL.m,11,"left","bold"); txt(x,I.dist.toFixed(1)+"NM",66,74,COL.m,11,"left"); x.restore(); }
    // 警報
    if(v.warn&&v.warn.length){ const w=v.warn[0]; const on=Math.floor(this.t*3)%2===0; if(on||w.steady){ x.fillStyle=w.col||COL.r; x.fillRect(75,96,150,26); txt(x,w.t,150,109,"#fff",16,"center","bold"); } }
    x.restore();
  }
  // ---------------- ND ----------------
  nd(x,v,ox,oy){
    const s=v.s, ap=v.ap; x.save(); x.translate(ox,oy); x.fillStyle=COL.bg; x.fillRect(0,0,300,310); x.strokeStyle="#2a3541"; x.lineWidth=2; x.strokeRect(1,1,298,308);
    const cx=150, cy=232, Rpx=170; const rangeM=this.ndRange*1852; const sc=Rpx/rangeM;   // m → px
    const hd=s.psi;
    // 地図座標 → 画面（機首上）
    const P=(wx,wz)=>{ const dx=wx-s.pos[0], dz=wz-s.pos[2]; const E=dx, N=-dz; const c=Math.cos(hd), sn=Math.sin(hd); const fwd=N*c+E*sn, rgt=E*c-N*sn; return [cx+rgt*sc, cy-fwd*sc]; };
    x.save(); x.beginPath(); x.rect(2,28,296,280); x.clip();
    // 距離リング
    x.strokeStyle="#27414a"; x.lineWidth=1; for(const f of [0.5,1]){ x.beginPath(); x.arc(cx,cy,Rpx*f,Math.PI*1.12,Math.PI*1.88); x.stroke(); }
    // 空港・滑走路
    for(const a of (v.apts||[])){ const p=P(a.x,a.z); if(Math.hypot(p[0]-cx,p[1]-cy)>Rpx*1.5) continue; x.strokeStyle="#cfd6de"; x.lineWidth=Math.max(1.5,60*sc); for(const r of a.rw){ const A=P(r[0],r[1]),B=P(r[2],r[3]); x.beginPath(); x.moveTo(A[0],A[1]); x.lineTo(B[0],B[1]); x.stroke(); } txt(x,a.name,p[0]+8,p[1]-10,COL.c,10,"left"); }
    // 経路
    if(v.route&&v.route.length){ x.lineWidth=2; let last=[s.pos[0],s.pos[2]]; const act=v.wpIndex||0;
      for(let i=act;i<v.route.length;i++){ const w=v.route[i]; const A=P(last[0],last[1]),B=P(w.x,w.z); x.strokeStyle=(i===act&&ap.latMode==="LNAV")?COL.m:"#b8b8c8"; x.setLineDash(i===act?[]:[6,4]); x.beginPath(); x.moveTo(A[0],A[1]); x.lineTo(B[0],B[1]); x.stroke(); last=[w.x,w.z]; }
      x.setLineDash([]);
      for(let i=0;i<v.route.length;i++){ const w=v.route[i]; const p=P(w.x,w.z); if(p[1]<20||p[1]>340||p[0]<-40||p[0]>340) continue; x.fillStyle=(i===act)?COL.m:"#d8dce4"; x.beginPath(); x.moveTo(p[0],p[1]-5); x.lineTo(p[0]+5,p[1]); x.lineTo(p[0],p[1]+5); x.lineTo(p[0]-5,p[1]); x.closePath(); x.fill(); txt(x,w.name||"",p[0]+8,p[1],i===act?COL.m:"#d8dce4",10,"left"); } }
    // 降下開始点
    if(v.todPt){ const p=P(v.todPt.x,v.todPt.z); x.strokeStyle=COL.g; x.lineWidth=1.5; x.beginPath(); x.arc(p[0],p[1],5,0,7); x.stroke(); txt(x,"T/D",p[0]+8,p[1],COL.g,10,"left"); }
    // 進入コース
    if(v.finalLine){ const A=P(v.finalLine[0],v.finalLine[1]),B=P(v.finalLine[2],v.finalLine[3]); x.strokeStyle="#00d0ff"; x.lineWidth=1.5; x.setLineDash([2,5]); x.beginPath(); x.moveTo(A[0],A[1]); x.lineTo(B[0],B[1]); x.stroke(); x.setLineDash([]); }
    // 風・予測進路
    if(s.gs>8){ x.strokeStyle=COL.g; x.lineWidth=1.5; const trk=Math.atan2(s.vel[0],-s.vel[2]); const dd=trk-hd; x.beginPath(); x.moveTo(cx,cy); x.lineTo(cx+Math.sin(dd)*Rpx*0.9,cy-Math.cos(dd)*Rpx*0.9); x.stroke(); }
    // ヘディングバグ
    x.restore();
    // コンパスアーク（上部）
    x.save(); x.beginPath(); x.rect(2,2,296,40); x.clip(); x.fillStyle="#0d141b"; x.fillRect(2,2,296,40); x.restore();
    x.save(); x.translate(cx,cy); x.strokeStyle="#9fb0c0"; x.fillStyle="#cfd6de"; x.lineWidth=1.5; const hdm=mag(hd);
    for(let a=-50;a<=50;a+=5){ const b=((Math.round((hdm+a)/5)*5)%360+360)%360; const rel=(b-hdm); const rr=n180(rel)*D2R; if(Math.abs(rr)>60*D2R) continue; const L=(b%10===0)?10:5; x.beginPath(); x.moveTo(Math.sin(rr)*Rpx,-Math.cos(rr)*Rpx); x.lineTo(Math.sin(rr)*(Rpx-L),-Math.cos(rr)*(Rpx-L)); x.stroke(); if(b%30===0){ x.save(); x.translate(Math.sin(rr)*(Rpx-22),-Math.cos(rr)*(Rpx-22)); x.rotate(rr); txt(x,String(b/10),0,0,"#cfd6de",11,"center"); x.restore(); } }
    if(ap.on&&ap.latMode==="HDG"){ const rr=n180(ap.hdg/D2R-hd/D2R)*D2R; if(Math.abs(rr)<60*D2R){ x.fillStyle=COL.m; x.save(); x.rotate(rr); x.beginPath(); x.moveTo(0,-Rpx); x.lineTo(-6,-Rpx-9); x.lineTo(6,-Rpx-9); x.closePath(); x.fill(); x.restore(); } }
    x.restore();
    // 自機シンボル
    x.fillStyle="#ffd24a"; x.beginPath(); x.moveTo(cx,cy-9); x.lineTo(cx+7,cy+8); x.lineTo(cx,cy+4); x.lineTo(cx-7,cy+8); x.closePath(); x.fill();
    // 上段の情報
    x.fillStyle="#0d141b"; x.fillRect(2,2,296,22);
    txt(x,"GS",8,13,COL.dim,10,"left"); txt(x,String(Math.round(s.gs/KT)),26,13,"#fff",13,"left","bold"); txt(x,"TAS",58,13,COL.dim,10,"left"); txt(x,String(Math.round(s.tas/KT)),84,13,"#fff",13,"left","bold");
    txt(x,String(Math.round(hdm)).padStart(3,"0")+"°",150,13,"#fff",14,"center","bold");
    txt(x,"風 "+v.windTxt,292,13,COL.g,11,"right");
    if(v.nextWp){ txt(x,v.nextWp.name,8,40,COL.m,12,"left","bold"); txt(x,(v.nextWp.dist/1852).toFixed(0)+"NM",8,54,COL.m,11,"left"); if(v.nextWp.eta) txt(x,v.nextWp.eta,8,67,COL.m,11,"left"); }
    if(v.destInfo){ txt(x,v.destInfo,292,40,"#fff",11,"right"); }
    if(v.todTxt){ txt(x,v.todTxt,292,54,COL.g,11,"right"); }
    txt(x,"ND "+this.ndRange+"NM",292,298,COL.dim,10,"right");
    x.restore();
  }
  // ---------------- エンジン・機体状態 ----------------
  eng(x,v,ox,oy){
    const s=v.s; x.save(); x.translate(ox,oy); x.fillStyle=COL.bg; x.fillRect(0,0,300,310); x.strokeStyle="#2a3541"; x.lineWidth=2; x.strokeRect(1,1,298,308);
    const n1=th=>th<0.01?22:(22+78*Math.pow(th,0.9));
    const gauge=(gx,gy,val,label)=>{ x.strokeStyle="#3b4854"; x.lineWidth=5; x.beginPath(); x.arc(gx,gy,34,Math.PI*0.75,Math.PI*2.25); x.stroke(); const f=clamp(val/110,0,1); x.strokeStyle=val>104?COL.r:COL.g; x.beginPath(); x.arc(gx,gy,34,Math.PI*0.75,Math.PI*(0.75+1.5*f)); x.stroke(); const a=Math.PI*(0.75+1.5*f); x.strokeStyle="#fff"; x.lineWidth=2.5; x.beginPath(); x.moveTo(gx,gy); x.lineTo(gx+Math.cos(a)*30,gy+Math.sin(a)*30); x.stroke(); txt(x,val.toFixed(1),gx,gy+24,"#fff",13,"center","bold"); txt(x,label,gx,gy-44,COL.dim,10,"center"); };
    gauge(80,62,n1(s.thr[0]),"N1 左"); gauge(220,62,n1(s.thr[1]),"N1 右");
    txt(x,"推力",150,62,COL.dim,10,"center"); txt(x,String(Math.round(s.thrustN/1000))+" kN",150,78,"#fff",11,"center");
    // 燃料
    txt(x,"燃料",14,128,COL.dim,10,"left"); x.fillStyle="#26323d"; x.fillRect(54,121,150,14); x.fillStyle=s.fuel<1200?COL.a:COL.g; x.fillRect(54,121,150*clamp(s.fuel/9000,0,1),14); txt(x,Math.round(s.fuel)+" kg",292,128,"#fff",12,"right");
    // フラップ
    const fl=[0,1,2,5,10,15,25,30,40]; txt(x,"フラップ",14,158,COL.dim,10,"left"); const fi=Math.round(v.flapIdx!=null?v.flapIdx:s.flaps); for(let i=0;i<fl.length;i++){ const xx=64+i*26; x.fillStyle=(i===Math.round(s.flapsTarget))?COL.g:"#3b4854"; x.fillRect(xx,150,22,16); txt(x,String(fl[i]),xx+11,158,(i===Math.round(s.flapsTarget))?"#001":"#aeb9c4",10,"center"); }
    x.fillStyle=COL.c; const fxp=64+clamp(s.flaps,0,8)*26+11; x.beginPath(); x.moveTo(fxp,170); x.lineTo(fxp-5,178); x.lineTo(fxp+5,178); x.closePath(); x.fill();
    // 脚
    txt(x,"ギア",14,196,COL.dim,10,"left"); const gcol=s.gear>0.98?COL.g:(s.gear<0.02?"#3b4854":COL.r); for(let i=0;i<3;i++){ x.fillStyle=gcol; x.fillRect(64+i*40,189,32,14); txt(x,["前","左","右"][i],80+i*40,196,s.gear<0.02?"#6b7a88":"#001",10,"center"); }
    txt(x,s.gear>0.98?"DOWN":(s.gear<0.02?"UP":"移動中"),200,196,gcol===COL.r?COL.r:"#fff",11,"left");
    // ブレーキ・スポイラー
    txt(x,"ブレーキ",14,222,COL.dim,10,"left"); x.fillStyle="#26323d"; x.fillRect(64,215,90,14); x.fillStyle=s.parking?COL.r:COL.a; x.fillRect(64,215,90*(s.parking?1:s.brake),14); txt(x,s.parking?"PARK":(v.autobrake>0?"AUTO "+["","1","2","3","MAX"][v.autobrake]:"MAN"),160,222,s.parking?COL.r:"#fff",11,"left");
    txt(x,"スポイラー",14,244,COL.dim,10,"left"); x.fillStyle="#26323d"; x.fillRect(64,237,90,14); x.fillStyle=COL.g; x.fillRect(64,237,90*Math.max(s.speedbrake,s.groundSpoilers?1:0),14); txt(x,v.spoilerArm?"ARM":"",160,244,COL.g,11,"left");
    txt(x,"荷重",14,266,COL.dim,10,"left"); txt(x,s.nz.toFixed(1)+" G",64,266,"#fff",12,"left"); txt(x,"迎角",120,266,COL.dim,10,"left"); txt(x,(s.aoa/D2R).toFixed(1)+"°",156,266,"#fff",12,"left"); txt(x,"時刻",210,266,COL.dim,10,"left"); txt(x,v.clock||"",246,266,"#fff",12,"left");
    txt(x,"機重 "+(s.mass/1000).toFixed(1)+" t",14,290,COL.dim,11,"left"); txt(x,v.msg||"",292,290,v.msgCol||COL.a,11,"right");
    x.restore();
  }
}
root.Hud=Hud;
})(typeof window!=="undefined"?window:globalThis);
