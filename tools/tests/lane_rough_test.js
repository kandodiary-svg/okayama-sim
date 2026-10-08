// v41.20: 車線に沿って走ったときの路面の凸凹・急勾配・瞬間移動（4m 超の段）を測る。車モードを始めた repl.js に流す。結果は JSON（末尾）と window.__s3 / __s3c。
//   window.__roughMode = 'new'（既定。v41.20 の車体の高さの追い方: 前後 ±4m の平均）/ 'old'（v41.19 まで: 前後の車輪の位置の 2 点）
//   nSteep = 5m 区間で 20% を超えた回数、nBump = ±12m の平均との差が 0.35m を超えた回数（1m ごとの標本）、nTele = 高さの瞬間移動（4m 超）
//   v41.20 の前後比較: 同じ道路データで 'old' と 'new' を流すと、車の動き側の効果だけが比べられる
(()=>{ const T=__Traffic, segs=T.segs, NL=T.NL, Cr=__Car, G=Cr.G; const hl=1.35, hw=0.9; const ev=[]; let nSamp=0, nSteep=0, nBump=0, nTele=0;
 for(let i=0;i<NL;i++){ const P=segs[i].P, a=P.P, n=P.n; if(P.len<20) continue;
   const cum=[0]; for(let q=1;q<n;q++) cum.push(cum[q-1]+Math.hypot(a[q*3]-a[(q-1)*3],a[q*3+2]-a[(q-1)*3+2])); const L=cum[n-1];
   const lx0=a[0],lz0=a[2]; if(!(lx0>=G.x0+20&&lz0>=G.z0+20&&lx0<G.x0+G.nx*2-20&&lz0<G.z0+G.nz*2-20)) continue;
   let q=0, h=null; const hs=[], xs=[], zs=[], tel=[];
   for(let s=0;s<=L;s+=1){ while(q<n-2&&cum[q+1]<s) q++; const t=(s-cum[q])/Math.max(1e-6,cum[q+1]-cum[q]);
     const x=a[q*3]+(a[(q+1)*3]-a[q*3])*t, ly=a[q*3+1]+(a[(q+1)*3+1]-a[q*3+1])*t, z=a[q*3+2]+(a[(q+1)*3+2]-a[q*3+2])*t;
     if(!(x>=G.x0+10&&z>=G.z0+10&&x<G.x0+G.nx*2-10&&z<G.z0+G.nz*2-10)) break;
     let dx=a[(q+1)*3]-a[q*3], dz=a[(q+1)*3+2]-a[q*3+2]; const dl=Math.hypot(dx,dz)||1; dx/=dl; dz/=dl;
     if(h===null) h=Cr.hAt(x,z,ly);
     const hc=Cr.hAt(x,z,h), cl=(v)=>Math.max(hc-0.7,Math.min(hc+0.7,v));
     const lz_=cl(Cr.hAt(x+dz*hw,z-dx*hw,h)), rz_=cl(Cr.hAt(x-dz*hw,z+dx*hw,h)); let hn;
     if(window.__roughMode==='old'){ const hf=cl(Cr.hAt(x+dx*hl,z+dz*hl,h)), hb=cl(Cr.hAt(x-dx*hl,z-dz*hl,h)); hn=(hf+hb+lz_+rz_)/4; }
     else { const wS=Math.max(6,Math.ceil(hl+1.5)); let hS=0,nS=0; for(let d=-wS;d<=wS;d+=2){ const hh=d===0?hc:cl(Cr.hAt(x+dx*d,z+dz*d,h)); if(Math.abs(d)<=4){ hS+=hh; nS++; } } hn=(hS/nS+(lz_+rz_)/2)/2; }
     const vmax=(3+0.2*12)/12; let tp=0; if(Math.abs(hn-h)>4){ h=hn; nTele++; tp=1; } else h+=Math.max(-vmax,Math.min(vmax,hn-h));
     hs.push(h); xs.push(x); zs.push(z); tel.push(tp); }
   const m=hs.length; nSamp+=m; if(m<20) continue;
   // 勾配（5m）と こぶ（±12m 平均との差）
   const pre=[0]; for(let j=0;j<m;j++) pre.push(pre[j]+hs[j]);
   let wg=0,wgj=0,wb=0,wbj=0,ns=0,nb=0,tc=0;
   for(let j=5;j<m-5;j++){ const g=Math.abs(hs[j+5]-hs[j-5])/10; if(g>0.2) ns++; if(g>wg){wg=g;wgj=j;}
     const a0=Math.max(0,j-12), a1=Math.min(m,j+13); const avg=(pre[a1]-pre[a0])/(a1-a0); const bd=Math.abs(hs[j]-avg); if(j>=12&&j<m-12){ if(bd>0.35) nb++; if(bd>wb){wb=bd;wbj=j;} } }
   for(const t_ of tel) tc+=t_;
   nSteep+=ns; nBump+=nb;
   if(wg>0.2||wb>0.35||tc>0) ev.push([i,Math.round(xs[wgj]),Math.round(zs[wgj]),+wg.toFixed(2),Math.round(xs[wbj]),Math.round(zs[wbj]),+wb.toFixed(2),tc]);
 }
 window.__s3=ev;
 const cl=new Map(); for(const e of ev){ for(const [x,z,sc,kind] of [[e[1],e[2],e[3]*3,'g'],[e[4],e[5],e[6]*8,'b']]){ if(sc<0.6) continue; const key=Math.round(x/50)+','+Math.round(z/50); let c=cl.get(key); if(!c){ c={x,z,n:0,sc:0,lanes:[],g:0,b:0,tp:0}; cl.set(key,c);} c.n++; if(kind==='g') c.g=Math.max(c.g,e[3]); else c.b=Math.max(c.b,e[6]); c.tp+=e[7]; if(sc>c.sc){c.sc=sc;c.x=x;c.z=z;} if(c.lanes.length<4&&!c.lanes.includes(e[0])) c.lanes.push(e[0]); } }
 const arr=[...cl.values()].sort((a,b)=>b.sc-a.sc); window.__s3c=arr;
 return JSON.stringify({nSamp,nSteep,nBump,nTele,lanesFlag:ev.length,clusters:arr.length,top:arr.slice(0,80)}); })()
