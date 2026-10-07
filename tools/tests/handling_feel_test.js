// v41.17: キーボード操作の感触の測定（repl.js の命令ファイル）。建物・他の車との衝突は無効にして、平らな所で測る。
//   1) steer: ハンドルを押しっぱなし（速度一定）にしたときの 0.3 / 1.0 / 2.0 秒後の [横加速度 m/s², ハンドル角 rad]
//   2) brake: ↓ を押しっぱなし（50・100 km/h から）の減速度（m/s²）の経過と停止時間・距離
//   3) tap30: ↓ を 0.3 秒ずつ押して止める（30 km/h から）  4) space50: Space（急ブレーキ）  5) accel: ↑ 全開の加速度の経過
//   window.__feelShift = true を先に設定すると Shift（スポーツ操作）を押した状態で測る（v41.16 までと同じ鋭い値になる）。window.__feelProfs = ['sedan'] などで車種を絞る。
//   結果（v41.16 → v41.17、セダン）: 30 km/h 以上で押しっぱなしの横加速度 8.8 → 4.4（0.3 秒後は 5.9〜8.8 → 2.1）。↓ 押しっぱなしの減速は 0.3 秒後 7.5 → 2.1・1.5 秒後 8.3 → 3.7（50 km/h からの停止 1.8 秒/13 m → 3.9 秒/29 m）。Space は 6.4 のまま。
(()=>{
  // キーボード操作の感触の測定（repl.js の命令ファイル）。建物・他の車との衝突は無効にして、平らな所で測る。
  const C=__Car.C, out={}, dt=1/60; const K={}; const press=(k,on)=>{ if(!!K[k]===on) return; K[k]=on; window.dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{key:k})); };
  const ob0=C.obst, ps0=C.passable; C.obst=null; C.passable=()=>true;
  const reset=(v0)=>{ C.x=-85; C.z=36; C.yaw=0; C.v=v0; C._pv=v0; C.h=__Car.hAt(C.x,C.z); C.wheel=0; C.thr=0; C.brk=0; C.kT=0; C.kB=0; C.hitT=0; C.accF=0; C.latF=0; C.gear='D'; C.roll=0; C.pitch=0; for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Shift']) press(k,false); if(window.__feelShift) press('Shift',true); };
  const profs=(window.__feelProfs)||['sedan','truck','bus'];
  for(const name of profs){
    __Car.setProfile(name); const P=__Car.P, o={}; out[name]=o;
    // 1) ハンドルを左に切りっぱなし（速度は一定に保つ）。0.3 s・1.0 s・2.0 s 時点の横加速度（実際＝グリップで頭打ち）と、切れ角（ハンドル rad）
    o.steer={}; for(const kmh of [10,15,20,30,40,60,80,100]){ const v0=kmh/3.6; reset(v0); press('ArrowLeft',true); const rec={};
      for(let i=1;i<=120;i++){ C.v=v0; C._pv=v0; __Car.tick(dt); const t=i*dt; for(const tt of [0.3,1.0,2.0]) if(Math.abs(t-tt)<dt/2){ const aMax=P.grip*9.8; rec[tt]=[+Math.min(C.aLat,aMax).toFixed(1), +Math.abs(C.wheel).toFixed(2)]; } }
      press('ArrowLeft',false); o.steer[kmh]=rec; }
    // 2) ブレーキを押しっぱなし（50 km/h から）。経過時間ごとの減速度（m/s²）
    o.brake={}; for(const kmh of [50,100]){ reset(kmh/3.6); press('ArrowDown',true); const rec={}; let d=0;
      for(let i=1;i<=240;i++){ const v1=C.v; __Car.tick(dt); const t=i*dt; d+=C.v*dt; for(const tt of [0.1,0.2,0.3,0.5,1.0,1.5,2.0,3.0]) if(Math.abs(t-tt)<dt/2) rec[tt]=+((v1-C.v)/dt).toFixed(1); if(C.v<0.05){ rec.stopAt=+t.toFixed(1); rec.dist=Math.round(d); break; } }
      press('ArrowDown',false); o.brake[kmh]=rec; }
    // 3) ブレーキを 0.3 秒だけ押す（タップ）。最大の減速度と、止まるまでに何回タップが要るか（30 km/h から）
    { reset(30/3.6); let peak=0, taps=0, t=0, d=0; while(C.v>0.1 && t<40){ taps++; press('ArrowDown',true); for(let i=0;i<18;i++){ const v1=C.v; __Car.tick(dt); peak=Math.max(peak,(v1-C.v)/dt); d+=C.v*dt; t+=dt; } press('ArrowDown',false); for(let i=0;i<24;i++){ __Car.tick(dt); d+=C.v*dt; t+=dt; } } o.tap30={ peak:+peak.toFixed(1), taps, sec:+t.toFixed(1), dist:Math.round(d) }; }
    // 4) Space（サイドブレーキ）: 50 km/h からの減速度と停止距離
    { reset(50/3.6); press(' ',true); let d=0,t=0,pk=0; while(C.v>0.05 && t<10){ const v1=C.v; __Car.tick(dt); pk=Math.max(pk,(v1-C.v)/dt); d+=C.v*dt; t+=dt; } press(' ',false); o.space50={ peak:+pk.toFixed(1), sec:+t.toFixed(1), dist:Math.round(d) }; }
    // 5) アクセル全開（停止から）。経過時間ごとの加速度
    { reset(0); press('ArrowUp',true); const rec={}; let tp=0; for(let i=1;i<=180;i++){ const v1=C.v; __Car.tick(dt); const t=i*dt; for(const tt of [0.1,0.2,0.3,0.5,1.0,2.0]) if(Math.abs(t-tt)<dt/2) rec[tt]=+((C.v-v1)/dt).toFixed(1); if(C.v*3.6>=50 && !tp){ tp=t; } } press('ArrowUp',false); rec.to50=+tp.toFixed(1); o.accel=rec; }
  }
  C.obst=ob0; C.passable=ps0; __Car.setProfile('sedan'); return JSON.stringify(out);
})()
