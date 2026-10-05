/* 雨の描画（フロントガラス風の筋）。2D キャンバスを 3D の上・計器の下に重ねる。強さ 0 の時は何もしない。 */
(function(root){
class WxFx{
  constructor(cv){ this.cv=cv; this.cx=cv?cv.getContext("2d"):null; this.on=false; this.d=[]; this.b=[]; this.w=0; this.h=0; this.t=0; }
  size(){ const cv=this.cv, w=innerWidth, h=innerHeight, r=Math.min(1,1.0); if(cv.width!==Math.round(w*r)||cv.height!==Math.round(h*r)){ cv.width=Math.round(w*r); cv.height=Math.round(h*r); } this.w=cv.width; this.h=cv.height; }
  update(dt,k,tas,inside){
    if(!this.cv||!this.cx) return;
    if(k<0.02){ if(this.on){ this.on=false; this.cv.style.display="none"; this.cx.clearRect(0,0,this.w,this.h); this.d.length=0; } return; }
    if(!this.on){ this.on=true; this.cv.style.display="block"; }
    this.size(); const g=this.cx, W=this.w, H=this.h; g.clearRect(0,0,W,H);
    const N=Math.round(70+330*k), spd=Math.min(1,tas/90);              // 速いほど筋が横に流れる
    while(this.d.length<N) this.d.push({x:Math.random()*W,y:Math.random()*H,l:8+Math.random()*22,v:700+Math.random()*500});
    if(this.d.length>N) this.d.length=N;
    g.strokeStyle="rgba(215,225,235,"+(0.10+0.18*k).toFixed(2)+")"; g.lineWidth=1.1; g.beginPath();
    const ang=0.18+1.1*spd;                                            // 落下方向からの傾き（右から左へ流れる）
    const dx=-Math.sin(ang), dy=Math.cos(ang);
    for(const p of this.d){ p.x+=dx*p.v*dt; p.y+=dy*p.v*dt; if(p.y>H+30||p.x<-30){ p.x=Math.random()*(W+H*0.6); p.y=-20-Math.random()*40; }
      g.moveTo(p.x,p.y); g.lineTo(p.x-dx*p.l,p.y-dy*p.l); }
    g.stroke();
    // 操縦席（機内視点）: フロントガラスの水滴。ゆっくり付き、たまに流れ落ちる。速いほど横へ流れる
    if(inside){
      const M=Math.round(24+70*k); while(this.b.length<M) this.b.push({x:Math.random()*W,y:Math.random()*H*0.8,r:1.6+Math.random()*4.2,a:0,life:3+Math.random()*9,vy:0});
      if(this.b.length>M) this.b.length=M;
      for(const q of this.b){ q.life-=dt; q.a=Math.min(1,q.a+dt*1.6);
        if(q.life<0){ q.vy+=dt*60; q.y+=q.vy*dt; q.x-=spd*30*dt; if(q.y>H+10||q.x<-10){ q.x=Math.random()*W; q.y=Math.random()*H*0.5; q.r=1.6+Math.random()*4.2; q.a=0; q.life=4+Math.random()*10; q.vy=0; } }
        const rg=g.createRadialGradient(q.x-q.r*0.3,q.y-q.r*0.3,0.2,q.x,q.y,q.r*1.15);
        rg.addColorStop(0,"rgba(235,242,250,"+(0.55*q.a).toFixed(2)+")"); rg.addColorStop(0.7,"rgba(150,170,190,"+(0.18*q.a).toFixed(2)+")"); rg.addColorStop(1,"rgba(40,55,70,"+(0.28*q.a).toFixed(2)+")");
        g.fillStyle=rg; g.beginPath(); g.ellipse(q.x,q.y,q.r,q.r*(1.1+Math.min(0.9,q.vy/200)),0,0,6.2832); g.fill(); }
    } else this.b.length=0;
    // 暗い雨雲の下の薄い曇り
    g.fillStyle="rgba(70,80,92,"+(0.07*k).toFixed(3)+")"; g.fillRect(0,0,W,H);
  }
}
root.WxFx=WxFx;
})(typeof window!=="undefined"?window:globalThis);
