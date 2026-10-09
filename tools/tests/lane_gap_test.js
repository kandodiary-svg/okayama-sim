// v41.21: 車線（__Traffic の車線の点）の高さに、走行格子の層（本線・上の段）が合っているかを測る。車モードを始めた repl.js に流す（結果は JSON）。
//   d = hAt(x, z, 車線の高さ) − 車線の高さ。|d| > 2.5m の点（n25）= 車線の高さに合う層が無い（正: 車線の上に面がある＝下の道の層が欠けている、
//   負: 車線の下に面がある＝高架の面に穴がある）。n15 = 1.5m 超、n5 = 5m 超。top = 40m の升目ごとの集計（点の多い順）。
//   v41.20 → v41.21（lane_underfill.py ＋ 車線の位置合わせ〔align〕）: n25 446 → 263（中心部はほぼ 0。残りは範囲の端のランプ。うち 68 点は (−2541,4108) の車線 14515 ほか:
//   位置合わせで車線が高架の縁の外へ 2.3m 寄り、面の無い所（地面 1.6m）に車線の高さ 6.6m が載る＝AI の車が地面の高さを走る。v41.20 では 1.2m のずれ）、瞬間移動 70 → 14
(()=>{ const T=__Traffic, segs=T.segs, NL=T.NL, Cr=__Car, G=Cr.G; const out=[]; let nP=0, n15=0, n25=0, n5=0;
 const cl=new Map();
 for(let i=0;i<NL;i++){ const P=segs[i].P, a=P.P, n=P.n; if(P.len<10) continue;
  for(let q=0;q<n;q++){ const x=a[q*3], ly=a[q*3+1], z=a[q*3+2]; if(!(x>=G.x0+10&&z>=G.z0+10&&x<G.x0+G.nx*2-10&&z<G.z0+G.nz*2-10)) continue; nP++;
   const h=Cr.hAt(x,z,ly), d=h-ly; const ad=Math.abs(d); if(ad>1.5) n15++; if(ad>2.5){ n25++; const key=Math.round(x/40)+','+Math.round(z/40); let c=cl.get(key); if(!c){c={x:Math.round(x),z:Math.round(z),n:0,lanes:new Set(),dmax:0,dsum:0}; cl.set(key,c);} c.n++; c.lanes.add(i); c.dsum+=d; if(ad>Math.abs(c.dmax)) c.dmax=d; } if(ad>5) n5++; } }
 const arr=[...cl.values()].map(c=>({x:c.x,z:c.z,n:c.n,lanes:c.lanes.size,dmax:+c.dmax.toFixed(1),dmean:+(c.dsum/c.n).toFixed(1)})).sort((a,b)=>b.n-a.n);
 return JSON.stringify({nP,n15,n25,n5,clusters:arr.length,top:arr.slice(0,60)}); })()
