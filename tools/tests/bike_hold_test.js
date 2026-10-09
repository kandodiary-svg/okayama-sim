// v41.22: 「← を押し続けたとき、向きが何度変わるか」を車（セダン）とバイクで並べて測る試験（repl.js の命令ファイル。車モードを始めた状態で流す。結果は JSON）。
//   速度 15/25/35/45/60 km/h（走り出しの速度。アクセルは踏まず惰行）で ← を押し続け、0.3/0.5/1/1.5/2.5 秒後の向きの変化(°)と（）内の速度(km/h)。バイクは転倒したら FELL。建物の当たりは切ってある。
//   v41.21 のバイク: 45 km/h で 0.5 秒 5°・1 秒 20°（セダンは 13°・33°）、60 km/h で 1 秒 14°（セダン 23°）＝街なかの速度で車よりかなり遅く、「全然曲がらない」と感じた。
//   v41.22 のバイク: 45 km/h で 0.5 秒 11°・1 秒 30°、60 km/h で 1 秒 22°（セダンとほぼ同じ）。35 km/h 以下はセダン以上。
(()=>{
  const Car=__Car, C=Car.C; const ob0=C.obst; C.obst=null; const pass0=C.passable; C.passable=()=>true;
  const K={}; const press=(k,on)=>{ if(!!K[k]===on) return; K[k]=on; window.dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{key:k})); };
  const KEYS=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Shift'];
  const dt=1/60, D=57.2958;
  function reset(V){ for(const k of KEYS) press(k,false); C.x=60; C.z=6.5; C.yaw=Math.PI/2; C.v=V; C._pv=V; C.h=Car.hAt(C.x,C.z); C.wheel=0; C.thr=0; C.brk=0; C.kT=0; C.kB=0; C.hitT=0; C.gear='D'; C.autopilot=null;
    C.lean=0; C.leanV=0; C.dCur=0; C.kS=0; C.kSd=0; C.fall=false; C.fallT=0; C.absK=1; C.tcK=1; C.loT=0; C.shT=0; C.gearN=1; C.rpm=1300; C.steer=0; C.accF=0; C.latF=0; C.roll=0; C.pitch=0; C.odo=0; }
  const res={};
  for(const prof of ['sedan','bike']){ Car.setProfile(prof); res[prof]={};
    for(const kmh of [15,25,35,45,60]){ const V=kmh/3.6; reset(V); press('ArrowLeft',true); const y0=C.yaw; const row=[]; let fell=false;
      for(let i=1;i<=Math.round(2.5/dt);i++){ Car.tick(dt); if(C.fall) fell=true; if([18,30,60,90,150].includes(i)) row.push(+(i*dt).toFixed(1)+'s:'+((C.yaw-y0)*D).toFixed(0)+'°'+'('+(C.v*3.6).toFixed(0)+')'); }
      press('ArrowLeft',false); res[prof][kmh]=row.join(' ')+(fell?' FELL':''); } }
  Car.setProfile('sedan'); C.obst=ob0; C.passable=pass0; return JSON.stringify(res,null,1); })()
