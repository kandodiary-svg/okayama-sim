// 路面電車の簡易自動運転（試験用）。常駐ブラウザ（repl.js）の命令として評価する。
//   window.__drv.run(秒) で指定した模擬時間だけ運転する。FAC=制限速度の何割で走るか、HOLD=発車を定刻まで待つか。
//   __drv.reset() で始発へ戻して Dia.build() し直す。
(()=>{
 const S=__S; const D=__Dia; const Bm=[0,0.8,1.6,2.4,3.2,4.0].map(x=>x/3.6);
 const drv=window.__drv={FAC:0.95,HOLD:true,log:[],doorT:0,last:null,t00:S.clock}; drv.run=function(maxSim){ const dt=0.05; const t0=S.clock; let n=0;
   while(S.running && (S.clock-t0)<maxSim){
    __sim(dt); __tick(dt); n++;
    const st=`${S.stopIndex}|${S.doorOpen?1:0}|${S._openedAt}`; if(st!==this.last){ this.last=st; this.log.push([Math.round(S.clock-this.t00),'idx',S.stopIndex,'door',S.doorOpen,'opened',S._openedAt,'pos',Math.round(S.pos),'v',+S.speed.toFixed(1)]); }
    if(S.doorOpen){ this.doorT+=dt; const a=(S._openedAt===S.stopIndex?S.stopIndex:S.stopIndex-1); const sc=D.D.sc&&D.D.sc[a];
      const ready=(this.HOLD&&sc)?(S.clock>=sc.dep):this.doorT>10;
      if(this.doorT>3&&ready&&S.running){ this.log.push([Math.round(S.clock-this.t00),'close a=',a,'dep',sc&&Math.round(sc.dep-this.t00)]); __doorAction(); this.doorT=0; }
      continue; }
    this.doorT=0;
    const v=S.speed/3.6, ds=S.cum[S.stopIndex]-S.pos, vlim=__limitAt(S.pos)*this.FAC/3.6;
    let need=0; const dst=Math.max(0.3,ds-1.6); need=Math.max(need, v*v/(2*dst));   // 停止目標の手前 1.6m を狙う（行き過ぎ防止）
    for(let d=10; d<=220; d+=10){ const vl=__limitAt(S.pos+d)*this.FAC/3.6; if(v>vl) need=Math.max(need,(v*v-vl*vl)/(2*d)); }
    // 信号: 到着時に青なら止まらず通る（見越して速度を合わせる）。赤なら青になる時刻に合わせて近づく
    let vsig=1e9; { const sg=S.signals[S.sigIndex];
      if(sg && sg.g!=null){ const d=sg.stop-S.pos; if(d>-3){ const ph=(t)=>__phase(sg.g,sg.ph,t); const vc=Math.max(v,3), tA=d/Math.min(Math.max(vc,5),vlim||11);
        if(ph(S.t+tA)!==0 || ph(S.t+tA*0.8)!==0){ let tg=null; for(let k=Math.ceil(tA); k<=130; k++){ if(ph(S.t+k)===0){ tg=k; break; } }
          vsig = tg==null ? 0 : Math.max(0, d/Math.max(tg,1)); if(vsig<1.2) vsig=0; if(d<2) vsig=0;
          if(v>vsig+0.2) need=Math.max(need,(v*v-vsig*vsig)/(2*Math.max(0.5,d-2))); } } } }
    let va=Math.min(vlim, Math.sqrt(2*0.55*dst), vsig<1e8?vsig:1e9);
    if(need>0.06 && v>0.3){ let k=1; while(k<5 && Bm[k]<need*1.25) k++; __setNotch(-k); }
    else if(v>va+0.5){ __setNotch(-1); }
    else if(v<va-1.0 && dst>2){ __setNotch(v<va-4?3:2); }
    else if(v<va-0.4 && dst>2){ __setNotch(1); }
    else if(v<0.6 && ds>1.2 && vsig>1e8){ __setNotch(1); }   // 最後は這って目標へ
    else __setNotch(0);
    if(ds<1.5&&ds>-3.4&&v<0.6){ __setNotch(-3); if(S.speed<0.4) __doorAction(); }   // 目標に着いたらしっかり止めてドアを開ける
   }
   return n; };

 drv.reset=function(){ Object.assign(S,{running:true,pos:S.cum[0],speed:0,acc:0,stopIndex:1,doorOpen:true,_openedAt:-1,sigIndex:0,mc:0,bv:0,notch:0,emergency:false,score:1000}); D.build(); this.t00=S.clock; this.last=null; this.log.length=0; this.doorT=0; };
 return "driver ready";
})()
