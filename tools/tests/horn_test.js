// クラクション試験（repl.js の命令ファイル）: 歩行者でふさがれた車 2 台のうち 1 台だけクラクション。鳴らした車だけが前へ詰める（v41.8）
(async()=>{
  const T=__Traffic, S=__S, segs=T.segs; const step=(n)=>{ for(let i=0;i<n;i++){ __sim(0.1); S.t+=0.1; } };
  step(120);
  const cand=T.cars.filter(c=>c.type && c.v>4 && segs[c.plan[0]].lane && segs[c.plan[0]].P.len-c.s>45 && c.type.name!=='bus'&& c.type.name!=='moto');
  if(cand.length<2) return 'NOCAND '+cand.length;
  const A=cand[0]; let B=null; for(const c of cand){ if(Math.hypot(c.x-A.x,c.z-A.z)>300){ B=c; break; } } if(!B) return 'NOB';
  const fake=[]; for(const c of [A,B]){ const P=segs[c.plan[0]].P, q=__pathPt(P, c.s+c.type.l/2+16); fake.push({ped:true,x:q.x,z:q.z,on:true,v:0,y:q.y,name:'fake'}); }
  const origReg=__Peds.register; __Peds.register=function(){ origReg(); for(const f of fake){ if(!f.gone) __Obs.add(f.x,f.z,0.35,f,f.y); } };
  const d=(c,f)=>Math.hypot(c.x-f.x,c.z-f.z);
  const res={};
  step(150);
  res.beforeHonk={A:{v:+A.v.toFixed(2),dist:+d(A,fake[0]).toFixed(1)}, B:{v:+B.v.toFixed(2),dist:+d(B,fake[1]).toFixed(1)}};
  const px=B.x-B.dx*10, pz=B.z-B.dz*10;
  res.honkHit=T.honk(px,pz,B.dx,B.dz);
  const trackB=[], trackA=[];
  for(let k=0;k<100;k++){ step(1); if(k%10===9){ trackB.push([+B.v.toFixed(2),+d(B,fake[1]).toFixed(1)]); trackA.push([+A.v.toFixed(2),+d(A,fake[0]).toFixed(1)]); } }
  res.afterHonk={A:trackA,B:trackB};
  fake[0].gone=true; fake[1].gone=true; step(100);
  res.afterClear={A:+A.v.toFixed(2),B:+B.v.toFixed(2)};
  __Peds.register=origReg; return JSON.stringify(res);
})()
