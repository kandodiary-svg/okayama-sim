/* 音（WebAudio による合成）: エンジン、風切り音、地上走行、接地、警報。録音素材は使わない。
   ブラウザの制限で、最初の操作（スタートボタン）の後でないと鳴らない。 */
(function(root){
"use strict";
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
class Sound{
  constructor(){ this.ok=false; this.muted=false; this.vol=0.7; }
  start(){
    if(this.ok) { try{ this.ctx.resume(); }catch(e){} return; }
    const AC=root.AudioContext||root.webkitAudioContext; if(!AC) return;
    try{ this.ctx=new AC(); }catch(e){ return; }
    const c=this.ctx; this.master=c.createGain(); this.master.gain.value=this.vol; this.master.connect(c.destination);
    this.room=c.createBiquadFilter(); this.room.type="lowpass"; this.room.frequency.value=2400; this.room.connect(this.master);   // 機内(低め)/機外(高め)
    // ノイズ
    const len=c.sampleRate*2, buf=c.createBuffer(1,len,c.sampleRate), d=buf.getChannelData(0); let b0=0,b1=0,b2=0; for(let i=0;i<len;i++){ const w=Math.random()*2-1; b0=0.99765*b0+w*0.0990460; b1=0.96300*b1+w*0.2965164; b2=0.57000*b2+w*1.0526913; d[i]=(b0+b1+b2+w*0.1848)*0.18; }
    this.noiseBuf=buf;
    const noise=()=>{ const s=c.createBufferSource(); s.buffer=buf; s.loop=true; s.start(0, Math.random()*1.5); return s; };
    // エンジン: 低域ごう音 + 高域ファン音
    this.eLow=c.createBiquadFilter(); this.eLow.type="lowpass"; this.eLow.frequency.value=300; this.eLowG=c.createGain(); this.eLowG.gain.value=0; const n1=noise(); n1.connect(this.eLow); this.eLow.connect(this.eLowG); this.eLowG.connect(this.room);
    this.eHi=c.createBiquadFilter(); this.eHi.type="bandpass"; this.eHi.frequency.value=2200; this.eHi.Q.value=1.1; this.eHiG=c.createGain(); this.eHiG.gain.value=0; const n2=noise(); n2.connect(this.eHi); this.eHi.connect(this.eHiG); this.eHiG.connect(this.room);
    this.osc=[0,1].map(i=>{ const o=c.createOscillator(); o.type="sawtooth"; o.frequency.value=200+i*3; const g=c.createGain(); g.gain.value=0; const f=c.createBiquadFilter(); f.type="lowpass"; f.frequency.value=1800; o.connect(f); f.connect(g); g.connect(this.room); o.start(); return {o,g}; });
    // 風切り
    this.wF=c.createBiquadFilter(); this.wF.type="bandpass"; this.wF.frequency.value=900; this.wF.Q.value=0.5; this.wG=c.createGain(); this.wG.gain.value=0; const n3=noise(); n3.connect(this.wF); this.wF.connect(this.wG); this.wG.connect(this.room);
    // 地上走行（ゴロゴロ）
    this.rF=c.createBiquadFilter(); this.rF.type="lowpass"; this.rF.frequency.value=160; this.rG=c.createGain(); this.rG.gain.value=0; const n4=noise(); n4.connect(this.rF); this.rF.connect(this.rG); this.rG.connect(this.room);
    // 警報
    this.wo=c.createOscillator(); this.wo.type="square"; this.wo.frequency.value=700; this.woG=c.createGain(); this.woG.gain.value=0; this.wo.connect(this.woG); this.woG.connect(this.master); this.wo.start();
    this.ok=true; this.t=0;
  }
  setMuted(m){ this.muted=m; if(this.ok) this.master.gain.value=m?0:this.vol; }
  bump(kind,amp){ if(!this.ok) return; const c=this.ctx, s=c.createBufferSource(); s.buffer=this.noiseBuf; const f=c.createBiquadFilter(); f.type="lowpass"; f.frequency.value=kind==="touch"?260:900; const g=c.createGain(); const t=c.currentTime; g.gain.setValueAtTime(amp,t); g.gain.exponentialRampToValueAtTime(0.001,t+(kind==="touch"?0.5:0.25)); s.connect(f); f.connect(g); g.connect(this.room); s.start(t,Math.random()); s.stop(t+0.7); }
  chirp(freq,dur,amp){ if(!this.ok) return; const c=this.ctx, o=c.createOscillator(); o.type="sine"; o.frequency.value=freq; const g=c.createGain(); const t=c.currentTime; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(amp,t+0.01); g.gain.setValueAtTime(amp,t+dur-0.02); g.gain.linearRampToValueAtTime(0,t+dur); o.connect(g); g.connect(this.master); o.start(t); o.stop(t+dur+0.02); }
  update(s,o){   // o: {inside, warn:"stall"|"overspeed"|"gpws"|null, dt}
    if(!this.ok) return; const c=this.ctx, t=c.currentTime; const set=(p,v,k)=>p.setTargetAtTime(v,t,k||0.08);
    const th=(s.thr[0]+s.thr[1])/2, n1=th<0.01?0.22:(0.22+0.78*Math.pow(th,0.9));
    const run=s.fuel>0?1:0; const alt=s.radAlt, near=clamp(1-s.pos[1]/12000,0.3,1);
    const inside=o.inside; const rm=inside?1400:5200; set(this.room.frequency,rm,0.2);
    const amb=inside?0.55:1.0;
    set(this.eLowG.gain, run*(0.10+0.55*n1*n1)*amb, 0.15); set(this.eLow.frequency, 140+n1*260, 0.15);
    set(this.eHiG.gain, run*(0.015+0.20*Math.pow(n1,2.2))*(inside?0.5:1.0), 0.15); set(this.eHi.frequency, 900+n1*2200, 0.15);
    for(let i=0;i<2;i++){ set(this.osc[i].o.frequency, 160+n1*520+i*5, 0.1); set(this.osc[i].g.gain, run*0.012*n1*n1*(inside?0.5:1.2), 0.15); }
    const V=s.tas; const w=clamp(Math.pow(V/230,2)*(0.2+0.8*(s.pos[1]<8000?1:0.7)),0,1.1); set(this.wG.gain, w*(inside?0.18:0.4)*(s.onGround?0.4:1), 0.2); set(this.wF.frequency, 500+V*3.2, 0.2);
    const rl=s.onGround?clamp(s.gs/70,0,1):0; set(this.rG.gain, rl*(inside?0.6:0.9)*0.55, 0.1); set(this.rF.frequency, 90+rl*150, 0.1);
    // 警報
    let on=0, f=700; const ph=Math.floor((this.t=(this.t||0)+(o.dt||0.016))*4)%2;
    if(o.warn==="stall"){ f=520+ (Math.floor(this.t*7)%2)*220; on=0.07; } else if(o.warn==="overspeed"){ f=900; on=ph?0.07:0.0; } else if(o.warn==="gpws"){ f=880; on=Math.floor(this.t*5)%2?0.06:0; }
    this.wo.frequency.setTargetAtTime(f,t,0.01); set(this.woG.gain,on,0.01);
  }
}
root.Sound=Sound;
})(typeof window!=="undefined"?window:globalThis);
