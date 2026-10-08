// v41.20: 高架・高架の下をくぐる道・橋の試験。車モードを始めた repl.js に流す（結果は JSON）。
//   1) 指定した範囲の車線（__Traffic の車線の中心線）を、車の高さの追い方（Car.tick と同じ: 前後 ±4m の平均＋左右の平均、レート制限、4m 超は瞬間移動）
//      で 1m ごとにたどり、車線ごとに 高さの最小・最大・最大勾配（10m）・こぶ（±12m 平均との差）・瞬間移動（4m 超）を測る
//      範囲: 国道250号の高架（岡山駅の東、x 1090〜1545, z 1010〜1050）、駅西の高架（x -495〜-255, z 55〜285）
//   2) 高架の下の道（x=1225 付近の南北の道）の上で、yref=地面の高さ / 高架の高さ で hAt を引き、2 段の格子が効いていること
//      window.__vdBox で範囲を変えられる（[x0,z0,x1,z1]）
//   bad = 急勾配（>20%）・こぶ（>0.5m）・瞬間移動のある車線の一覧（top は長い順 8 本）
//   結果（v41.20）: 国道250号 17 車線中 16 本が高架（高さ 11.4m）の上、駅西 33 車線中 4 本。旧（v41.19）は高さ 8m 以上の車線が 0 本、x=1225 の hAt は 3.1m の 1 層のみ
(()=>{ const T=__Traffic, segs=T.segs, NL=T.NL, Cr=__Car, G=Cr.G; const hl=1.35, hw=0.9; const R={};
 function lanesIn(bx){ const out=[]; for(let i=0;i<NL;i++){ const P=segs[i].P, a=P.P, n=P.n; if(P.len<10) continue; let k=0; for(let q=0;q<n;q++){ const x=a[q*3], z=a[q*3+2]; if(x>=bx[0]&&x<=bx[2]&&z>=bx[1]&&z<=bx[3]) k++; } if(k>=Math.max(8,n*0.5)) out.push(i); } return out; }
 function drive(i){ const P=segs[i].P, a=P.P, n=P.n; const cum=[0]; for(let q=1;q<n;q++) cum.push(cum[q-1]+Math.hypot(a[q*3]-a[(q-1)*3],a[q*3+2]-a[(q-1)*3+2])); const L=cum[n-1];
   let q=0, h=null; const hs=[], xs=[], zs=[]; let tele=0;
   for(let s=0;s<=L;s+=1){ while(q<n-2&&cum[q+1]<s) q++; const t=(s-cum[q])/Math.max(1e-6,cum[q+1]-cum[q]);
     const x=a[q*3]+(a[(q+1)*3]-a[q*3])*t, ly=a[q*3+1]+(a[(q+1)*3+1]-a[q*3+1])*t, z=a[q*3+2]+(a[(q+1)*3+2]-a[q*3+2])*t;
     if(!(x>=G.x0+10&&z>=G.z0+10&&x<G.x0+G.nx*2-10&&z<G.z0+G.nz*2-10)) break;
     let dx=a[(q+1)*3]-a[q*3], dz=a[(q+1)*3+2]-a[q*3+2]; const dl=Math.hypot(dx,dz)||1; dx/=dl; dz/=dl;
     if(h===null) h=Cr.hAt(x,z,ly);
     const hc=Cr.hAt(x,z,h), cl=(v)=>Math.max(hc-0.7,Math.min(hc+0.7,v));
     const lz_=cl(Cr.hAt(x+dz*hw,z-dx*hw,h)), rz_=cl(Cr.hAt(x-dz*hw,z+dx*hw,h));
     const wS=Math.max(6,Math.ceil(hl+1.5)); let hS=0,nS=0; for(let d=-wS;d<=wS;d+=2){ const hh=d===0?hc:cl(Cr.hAt(x+dx*d,z+dz*d,h)); if(Math.abs(d)<=4){ hS+=hh; nS++; } }
     const hn=(hS/nS+(lz_+rz_)/2)/2, vmax=(3+0.2*12)/12; if(Math.abs(hn-h)>4){ h=hn; tele++; } else h+=Math.max(-vmax,Math.min(vmax,hn-h));
     hs.push(h); xs.push(x); zs.push(z); }
   const m=hs.length; if(m<20) return null; let mn=1e9,mx=-1e9; for(const v of hs){ mn=Math.min(mn,v); mx=Math.max(mx,v); }
   const pre=[0]; for(let j=0;j<m;j++) pre.push(pre[j]+hs[j]); let wg=0,wgj=0,wb=0,wbj=0,ns=0;
   for(let j=5;j<m-5;j++){ const g=Math.abs(hs[j+5]-hs[j-5])/10; if(g>0.2) ns++; if(g>wg){wg=g;wgj=j;} if(j>=12&&j<m-12){ const avg=(pre[j+13]-pre[j-12])/25; const bd=Math.abs(hs[j]-avg); if(bd>wb){wb=bd;wbj=j;} } }
   return { lane:i, len:Math.round(L), hMin:+mn.toFixed(1), hMax:+mx.toFixed(1), maxGrade:+wg.toFixed(2), at:[Math.round(xs[wgj]),Math.round(zs[wgj])], steepN:ns, maxBump:+wb.toFixed(2), bumpAt:[Math.round(xs[wbj]),Math.round(zs[wbj])], tele, prof:hs.filter((_,j)=>j%30===0).map(v=>+v.toFixed(1)) }; }
 const boxes=window.__vdBox?{custom:window.__vdBox}:{k250:[1090,1010,1545,1050], west:[-495,55,-255,285]};
 for(const [name,bx] of Object.entries(boxes)){ const L=lanesIn(bx).map(drive).filter(Boolean); L.sort((a,b)=>b.len-a.len);
   const hi=L.filter(r=>r.hMax>=8);
   R[name]={ lanes:L.length, onDeck:hi.length, worstGrade:Math.max(0,...L.map(r=>r.maxGrade)), worstBump:Math.max(0,...L.map(r=>r.maxBump)), tele:L.reduce((s,r)=>s+r.tele,0), steepN:L.reduce((s,r)=>s+r.steepN,0), top:L.slice(0,8), bad:L.filter(r=>r.maxGrade>0.2||r.maxBump>0.5||r.tele>0).map(r=>({lane:r.lane,len:r.len,hMin:r.hMin,hMax:r.hMax,g:r.maxGrade,at:r.at,b:r.maxBump,bat:r.bumpAt,tele:r.tele})) }; }
 const g0=Cr.hAt(1225,985); R.deckAt1225=+Cr.hAt(1225,1034,12).toFixed(2); R.groundAt1225=+Cr.hAt(1225,1034,4.4).toFixed(2);
 R.checks={ deckHigh:R.deckAt1225>=9, twoLayers:(R.deckAt1225-R.groundAt1225)>=4 };
 return JSON.stringify(R); })()
