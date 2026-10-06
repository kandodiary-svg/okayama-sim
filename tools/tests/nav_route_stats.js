(async()=>{
const segs=__Traffic.segs; let seed=12345; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
const ok=[]; for(let i=0;i<segs.length && ok.length<1;i++){} 
const rows=[]; let fail=0; let ms=0, it=0;
for(let t=0;t<120;t++){
  // 町の中の出発点・目的地（岡山駅前から 4km 以内）
  const a=rnd()*Math.PI*2, r=Math.sqrt(rnd())*3500, px=Math.cos(a)*r, pz=Math.sin(a)*r;
  const L=800+rnd()*3500, b=rnd()*Math.PI*2, tx=px+Math.cos(b)*L, tz=pz+Math.sin(b)*L;
  const R=__Nav.plan(px,pz,0,tx,tz); if(!R){ fail++; continue; }
  ms+=R.ms; it+=R.iters;
  const sl=Math.hypot(tx-px,tz-pz); let big=0,mid=0,nar=0;
  for(const m of R.marks){ const g=segs[m.id]; if(!g.lane) continue; const d=m.d1-m.d0; const im=g.imp||1; if(im>=2.2) big+=d; else if(im>=1.4) mid+=d; else nar+=d; }
  const tot=big+mid+nar||1;
  rows.push({len:R.total, ratio:R.total/Math.max(200,sl), man:R.man.length-1, per:(R.man.length-1)/(R.total/1000), big:big/tot, mid:mid/tot, nar:nar/tot, time:R.time});
}
const q=(f,p)=>{ const a=rows.map(f).sort((x,y)=>x-y); return +a[Math.floor(a.length*p)].toFixed(2); };
const avg=(f)=>+(rows.reduce((s,r)=>s+f(r),0)/rows.length).toFixed(3);
return JSON.stringify({n:rows.length, fail, ratioMed:q(r=>r.ratio,.5), ratio90:q(r=>r.ratio,.9), manPerKmMed:q(r=>r.per,.5), manPerKm90:q(r=>r.per,.9), big:avg(r=>r.big), mid:avg(r=>r.mid), nar:avg(r=>r.nar), timeMed:q(r=>r.time,.5), msAvg:+(ms/rows.length).toFixed(1), itAvg:Math.round(it/rows.length)});
})()
