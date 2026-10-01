const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:640,height:400}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ document.querySelector('.mode-opt[data-mode="jr"]').click(); [...document.querySelectorAll('#jr-routes .route-opt')][0].click(); [...document.querySelectorAll('#jr-vehs .veh-opt')][0].click(); document.getElementById('start').click(); });
  await p.waitForTimeout(3000);
  const poss = (process.env.POS||'3000,15000,30000,50000,70000,90000').split(',').map(Number);
  const view = process.env.VIEW||'cab';
  for(const pos of poss){
    const r = await p.evaluate(({pos,view})=>{
      const S=__S, cam=__cam; S.view=view; S.doorOpen=false; S._camD=null;
      const V=270, dt=1/60, N=60*14, out=[]; S.pos=pos;
      const f=new cam.position.constructor(); const up=new cam.position.constructor(); const rt=new cam.position.constructor();
      for(let i=0;i<N;i++){ S.speed=V; S.acc=0; S.pos+=V/3.6*dt; __updateCamera(1/60);
        cam.updateMatrixWorld(); cam.getWorldDirection(f); up.set(0,1,0).applyQuaternion(cam.quaternion);
        out.push([cam.position.x,cam.position.y,cam.position.z,f.x,f.y,f.z,up.x,up.y,up.z]); }
      // metrics
      const m=(arr)=>Math.sqrt(arr.reduce((a,x)=>a+x*x,0)/arr.length), mx=(arr)=>arr.reduce((a,x)=>Math.max(a,Math.abs(x)),0);
      const vy=[],ay=[],lat=[],yaw=[],pit=[],rol=[]; let pv=null,pa=null;
      for(let i=1;i<N;i++){ const a=out[i-1],c=out[i];
        const vx_=(c[0]-a[0])/dt, vy_=(c[1]-a[1])/dt, vz_=(c[2]-a[2])/dt; vy.push(vy_);
        const hd=Math.hypot(c[3],c[5]); const yw=Math.atan2(c[3],c[5]), yw0=Math.atan2(a[3],a[5]); let dy=yw-yw0; if(dy>Math.PI)dy-=2*Math.PI; if(dy<-Math.PI)dy+=2*Math.PI; yaw.push(dy/dt);
        pit.push((Math.asin(c[4])-Math.asin(a[4]))/dt);
        rol.push(Math.atan2(c[6],c[7])); }
      for(let i=1;i<vy.length;i++) ay.push((vy[i]-vy[i-1])/dt);
      // lateral accel: second derivative of position perpendicular to heading
      for(let i=2;i<N;i++){ const a=out[i-2],b2=out[i-1],c=out[i]; const ax=(c[0]-2*b2[0]+a[0])/dt/dt, az=(c[2]-2*b2[2]+a[2])/dt/dt; const hx=c[5], hz=-c[3]; const n=Math.hypot(hx,hz)||1; lat.push((ax*hx+az*hz)/n); }
      const ma=(a,w)=>a.map((_,i)=>{let s=0,c=0;for(let j=Math.max(0,i-w);j<=Math.min(a.length-1,i+w);j++){s+=a[j];c++;}return s/c;});
      const latm=ma(lat,30), hf=lat.map((x,i)=>x-latm[i]); const yawm=ma(yaw,30), yhf=yaw.map((x,i)=>x-yawm[i]);
      return {hfLatAccRMS:+m(hf).toFixed(3), hfYawRateRMSdeg:+(m(yhf)*57.3).toFixed(3), yawRateAbsMeanDeg:+(m(yawm)*57.3).toFixed(2), vertAccRMS:+m(ay).toFixed(3), vertAccMax:+mx(ay).toFixed(2), latAccRMS:+m(lat).toFixed(3), latAccMax:+mx(lat).toFixed(2), yawRateRMSdeg:+(m(yaw)*57.3).toFixed(3), yawRateMaxdeg:+(mx(yaw)*57.3).toFixed(2), pitchRateRMSdeg:+(m(pit)*57.3).toFixed(3), rollMaxdeg:+(mx(rol)*57.3).toFixed(2)};
    },{pos,view});
    console.log(view,pos,JSON.stringify(r));
  }
  await b.close();
})();
