// v41.19: バイクの操作感を測る試験（repl.js の命令ファイル）。物理だけを見る（建物の当たりは切り、速度は一定に保つ項目と保たない項目がある）。
//   A. 長押しの立ち上がり: ← を押し続けたときの傾き(°)・横加速度(m/s²)・曲がる半径(m) を 0.1 秒ごと（速度 20/30/50/80 km/h で一定）
//   B. ちょん押し: ← を 0.1/0.2/0.3/0.5 秒だけ押したときの最大の傾きと、離して 1.5 秒後までに向きが変わった角度（車線変更・微修正の目安）
//   C. 加速: 0→100km/h の秒数・シフトした速度と回転数・最高速（全開）
//   D. 制動: 100→0 の距離（↓ 押しっぱなし／Space）、傾いたまま（50km/h・← 1 秒）で ↓ と Space を押したときの結果（ABS／転倒）
// 結果（v41.19、400cc クラス・乗る人を含めて約 230 kg を想定）:
//   A. ← を押し続けたときの傾き（°）: 20 km/h で 0.1 秒 4°→0.3 秒 19°→0.8 秒 37°→1.1 秒で最大 39°（横 7.9 m/s²、半径 4 m）。50 km/h は 3°→13°→36°→39°（半径 24 m）。80 km/h は最大 31°（半径 83 m）
//   B. ちょん押し（50 km/h）: 0.1 秒 5°（向き 0.9°）・0.2 秒 10°（2.1°）・0.3 秒 14°（3.8°）・0.5 秒 25°（9.1°）＝短押しは細かい修正・車線変更、長押しほど深く曲がる
//   C. 0→100 km/h 4.9 秒（69 m）、シフトアップは 67・96・125・152 km/h（約 9500〜10000 rpm）、最高速 157 km/h（60 秒全開）
//   D. 100→0: ↓ だけ 76 m（5.1 秒）、Space 58 m、↓+Space 41 m（最大 10 m/s²）。傾き 38° で 50 km/h から: ↓ は転ばず止まる、Shift+↓ は ABS が絞って 18 km/h まで、Space は 0.22 秒で転倒
// v41.22 の変更後（押し始めを大きく・立ち上がりを速く・倒し込みの途中から向きが変わり始める）:
//   A. 長押し: 20 km/h で 0.1 秒 6°→0.3 秒 26°→0.5 秒 37°→0.8 秒で最大 39°。50 km/h は 6°→26°→37°→39°（以前は 3°→13°→36°→39°）。80 km/h は最大 31° のまま。
//   B. ちょん押し（50 km/h）: 0.1 秒 12°（向き 2.1°）・0.2 秒 21°（4.7°）・0.3 秒 29°（8.1°）・0.5 秒 37°（15°）。C・D（加速・制動・ABS・転倒）は変わらない。
// 使い方: 車モードを開始した状態の repl.js に流す（メニューのままだと物理が動かず 0 になる）。
(()=>{
  const Car=__Car, C=Car.C; Car.setProfile('bike'); const ob0=C.obst; C.obst=null; const pass0=C.passable; C.passable=()=>true;
  const K={}; const press=(k,on)=>{ if(!!K[k]===on) return; K[k]=on; window.dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{key:k})); };
  const KEYS=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Shift'];
  const dt=1/60; const D=57.2958;
  function reset(V){ for(const k of KEYS) press(k,false); C.x=60; C.z=6.5; C.yaw=Math.PI/2; C.v=V; C._pv=V; C.h=Car.hAt(C.x,C.z); C.wheel=0; C.thr=0; C.brk=0; C.kT=0; C.kB=0; C.hitT=0; C.gear='D'; C.autopilot=null;
    C.lean=0; C.leanV=0; C.dCur=0; C.kS=0; C.kSd=0; C.fall=false; C.fallT=0; C.absK=1; C.tcK=1; C.loT=0; C.shT=0; C.gearN=1; C.rpm=1300; C.steer=0; C.accF=0; C.latF=0; C.roll=0; C.pitch=0; C.odo=0; }
  const out={};
  // A. 長押し
  out.A={};
  for(const kmh of [20,30,50,80]){ const V=kmh/3.6; reset(V); press('ArrowLeft',true); const rows=[]; let y0=C.yaw;
    for(let i=1;i<=Math.round(2.0/dt);i++){ C.v=V; C._pv=V; const yp=C.yaw; Car.tick(dt); C.v=V; if(i%6===0){ const yr=(C.yaw-yp)/dt; rows.push([+(i*dt).toFixed(1), +(C.lean*D).toFixed(1), +(C.aLat||0).toFixed(1), Math.abs(yr)>1e-3? Math.round(V/Math.abs(yr)):9999]); } }
    press('ArrowLeft',false); out.A[kmh]=rows.filter((r,i)=>[0,2,4,7,10,13,16,19].includes(i)).map(r=>r.join('/')).join('  '); }
  // B. ちょん押し
  out.B={};
  for(const kmh of [30,50,80]){ const V=kmh/3.6; out.B[kmh]={};
    for(const hold of [0.1,0.2,0.3,0.5]){ reset(V); press('ArrowLeft',true); let peak=0, y0=C.yaw, released=false;
      for(let i=0;i<Math.round((hold+1.5)/dt);i++){ if(!released && i*dt>=hold){ press('ArrowLeft',false); released=true; } C.v=V; C._pv=V; Car.tick(dt); C.v=V; peak=Math.max(peak,Math.abs(C.lean)); }
      out.B[kmh][hold]=(peak*D).toFixed(1)+'°/向き'+((C.yaw-y0)*D).toFixed(1)+'°'; } }
  // C. 加速
  { reset(0); press('ArrowUp',true); let t=0, t100=null, d100=null; const sh=[]; let g0=1, topT=0;
    for(let i=0;i<Math.round(60/dt);i++){ Car.tick(dt); t+=dt; const kmh=C.v*3.6; if(C.gearN!==g0){ sh.push((g0+'→'+C.gearN)+'@'+Math.round(kmh)+'km/h '+Math.round(C.rpm)+'rpm'); g0=C.gearN; }
      if(t100===null && kmh>=100){ t100=t; d100=C.odo; } }
    out.C={ t100:t100&&+t100.toFixed(2), d100:d100&&Math.round(d100), top:Math.round(C.v*3.6), rpmTop:Math.round(C.rpm), gear:C.gearN, shifts:sh.join(' | ') }; press('ArrowUp',false); }
  // D. 制動
  out.D={};
  for(const [name,key] of [['down','ArrowDown'],['space',' '],['down+space','both']]){ reset(100/3.6); if(key==='both'){ press('ArrowDown',true); press(' ',true); } else press(key,true); let t=0; const x0=C.odo; let peakDec=0, vp=C.v;
    for(let i=0;i<Math.round(12/dt) && C.v>0.05;i++){ Car.tick(dt); t+=dt; peakDec=Math.max(peakDec,(vp-C.v)/dt); vp=C.v; }
    out.D[name]={ t:+t.toFixed(2), dist:Math.round(C.odo-x0), peakDec:+peakDec.toFixed(1), fall:C.fall }; for(const k of KEYS) press(k,false); }
  // D2. 傾いたままブレーキ
  out.D2={};
  for(const [name,keys] of [['↓',['ArrowDown']],['Space',[' ']],['Shift+↓',['Shift','ArrowDown']]]){ reset(50/3.6); press('ArrowLeft',true); for(let i=0;i<60;i++){ C.v=50/3.6; C._pv=C.v; Car.tick(dt); } const leanAt=C.lean*D; press('ArrowLeft',false); /* 傾けたまま（離す前に）ブレーキ */
    reset(50/3.6); press('ArrowLeft',true); for(let i=0;i<60;i++){ C.v=50/3.6; C._pv=C.v; Car.tick(dt); } for(const k of keys) press(k,true); let fell=false, tFall=null, minAbs=1, vEnd=0; let t=0;
    for(let i=0;i<Math.round(3/dt);i++){ Car.tick(dt); t+=dt; minAbs=Math.min(minAbs,C.absK); if(C.fall && !fell){ fell=true; tFall=+t.toFixed(2); } }
    out.D2[name]={ lean:+leanAt.toFixed(1), fell, tFall, absMin:+minAbs.toFixed(2), vEnd:+(C.v*3.6).toFixed(1) }; for(const k of KEYS) press(k,false); }
  for(const k of KEYS) press(k,false); C.obst=ob0; C.passable=pass0; Car.setProfile('sedan'); reset(0);
  return JSON.stringify(out,null,1);
})()
