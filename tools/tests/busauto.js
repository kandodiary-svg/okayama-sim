const { chromium } = require('playwright');
// バスを車の物理で経路に沿って自動運転（pure pursuit）し、建物への衝突の場所と回数を数える
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:640,height:400}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto((process.env.URL||'http://localhost:8805/index.html'));
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:600000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="'+('bus')+'"]').click(); document.getElementById('start').click(); });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(({s0, s1, vk, clearSky})=>{
    const C=__Car.C, P=__busP(), Pr=__Car.P; const out={hits:[], minClear:[]}; const ob0=C.obst; C.obst=null;
    __Bus.doorKey();
    if(clearSky){ const m=__S.scene.drive, B=new Uint8Array(__S._bufs.drive, m.nx*m.nz*3, m.brow*m.bnz);
      for(const [a,b,c,d] of [[774.5,459.4,824.5,465.5],[809.5,367.3,828.4,374.6]]) for(let z=Math.floor(b);z<=d;z++) for(let x=Math.floor(a);x<=c;x++){ const i=Math.floor(x-m.x0), j=Math.floor(z-m.z0); B[j*m.brow+(i>>3)] &= ~(1<<(7-(i&7))); } }
    // 開始位置
    const q0=__pathPt(P,s0), t0=__pathTan(P,s0); C.x=q0.x; C.z=q0.z; C.yaw=Math.atan2(t0.x,t0.z); C.v=0;
    let s=s0, lastHit=-99;
    C.autopilot=(C)=>{
      // 経路上の最近点
      let best=1e9, bs=s; for(let d=-10; d<=25; d+=0.5){ const q=__pathPt(P,s+d); const e=(q.x-C.x)**2+(q.z-C.z)**2; if(e<best){best=e; bs=s+d;} } s=bs;
      // 経路の向き・曲率（車体の中心 C の軌跡として）と横ずれ
      const q=__pathPt(P,s), t=__pathTan(P,s), t2=__pathTan(P,s+2), t1=__pathTan(P,s-2);
      const th=Math.atan2(t.x,t.z); let dh=th-C.yaw; dh=Math.atan2(Math.sin(dh),Math.cos(dh));
      const kap=Math.atan2(t1.x*t2.z-t1.z*t2.x, t1.x*t2.x+t1.z*t2.z)/4;   // 符号付き曲率（左が正）
      const lx=Math.cos(C.yaw), lz=-Math.sin(C.yaw); const e=(q.x-C.x)*lx+(q.z-C.z)*lz;    // 経路が左にあれば正
      const a=Pr.rearOff, Rc=1/Math.max(Math.abs(kap),1e-4), Rr=Math.sqrt(Math.max(Rc*Rc-a*a, 1));
      const ff=Math.sign(kap)*Math.atan(Pr.L/Rr)*(Math.abs(kap)>1e-3?1:0);
      // 旋回中の車体の向きは、中心の軌跡の接線から β=atan(a/Rr) だけ内側の逆（後輪軸の接線）
      const beta = Math.abs(kap)>1e-3 ? Math.sign(kap)*Math.atan(a/Rr) : 0;
      let dh2 = dh + beta; dh2=Math.atan2(Math.sin(dh2),Math.cos(dh2));
      const steer=-ff + dh2*1.0 + Math.atan(1.2*e/(Math.abs(C.v)+1.0));
      // 先の曲がりで減速
      let curv=0; for(let d=5; d<30; d+=5){ const t1=__pathTan(P,s+d), t2=__pathTan(P,s+d+5); curv=Math.max(curv, Math.abs(Math.atan2(t1.x*t2.z-t1.z*t2.x, t1.x*t2.x+t1.z*t2.z))/5); }
      const vt = Math.min(vk/3.6, Math.sqrt(1.6/Math.max(curv,1e-3)));
      return { thr: C.v < vt ? 0.6 : 0, brk: C.v > vt+1 ? 0.5 : 0, wheel: Math.max(-7.85, Math.min(7.85, steer*Pr.ratio)) };
    };
    for(let i=0;i<20*400 && s<s1;i++){ __Car.tick(0.05); __S.t+=0.05;
      if(C.hitT>1.1 && i-lastHit>20){ lastHit=i; const fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), sx=fz, sz=-fx; const cs=[]; for(const [u,w] of __Car.P.corners){ const px=C.x+fx*u+sx*w, pz=C.z+fz*u+sz*w; if(__Car.blocked(px,pz)) cs.push([u,w,+px.toFixed(1),+pz.toFixed(1)]); } const q=__pathPt(P,s); out.hits.push([+C.x.toFixed(1),+C.z.toFixed(1),Math.round(s),C.hitWhat,'yaw',+(C.yaw*57.3).toFixed(0),'path',+q.x.toFixed(1),+q.z.toFixed(1),'corners',cs, 'pass', C.passable?1:0]); }
      if(i%10==0){ let m=99; const fx=Math.sin(C.yaw), fz=Math.cos(C.yaw), sx=fz, sz=-fx; for(let u=-5.25;u<=5.25;u+=0.75) for(const w of [-1.9,-1.6,1.6,1.9]) if(__Car.blocked(C.x+fx*u+sx*w, C.z+fz*u+sz*w)) m=Math.min(m, Math.abs(w)-1.245);
        if(m<0.7) out.minClear.push([Math.round(C.x),Math.round(C.z),Math.round(s),+m.toFixed(2)]); }
      if(C.v<0.05 && i>200 && out.hits.length>40) break; }
    out.end=Math.round(s); C.autopilot=null; return out; }, {s0:+process.env.S0||0, s1:+process.env.S1||4000, vk:+process.env.VK||30, clearSky:!!process.env.CLEAR});
  console.log(JSON.stringify({end:r.end, nhits:r.hits.length, hits:r.hits.slice(0,30)}));
  const mc={}; for(const q of r.minClear){ const k=Math.round(q[2]/50)*50; mc[k]=(mc[k]||0)+1; } console.log('tight spots (<0.7m clearance to buildings) by route km:', JSON.stringify(mc));
  await b.close();
})();
