// v41.20: 高架の下をくぐる南北の道を、地面の高さから歩いて（Car.tick と同じ追い方・上限 0.25m/歩）高架の面の層へ乗り上げないかを調べる（repl.js の命令ファイル）。
//   3 か所（国道250号の高架の下: x=1225・x=1468・x=1343 付近の斜めの道）で、横の位置を ±6m ずらした 13 本の経路を z=985→1075 へたどり、
//   各経路の 高さの最小/最大/4m 超の瞬間移動の回数 を返す。「mx < 8」の経路が地面の層のまま通り抜けられた経路（高架の面は約 11.4m）。
//   結果（v41.20）: x=1225 は横 −6〜+4 m の 11 本、x=1468 は −6〜+2 m の 9 本、x=1343 は経路 1 本が地面の層で通り抜け（斜めの道の幅は約 3m）。
//   旧データ（v41.19）は全経路が地面の層（最大 6.1m 以下）のまま通れるが、走行格子に高架の面の層が無い（x=1225 の hAt は高さ 3.1m の 1 層のみ）ので、高架の上は走れない。
(()=>{ const Cr=__Car; const out={};
 function run(x0,z0,z1,dxdz,yref){ let h=Cr.hAt(x0,z0,yref); let mx=-1e9,mn=1e9,tele=0; const dir=z1>z0?1:-1;
   for(let z=z0; dir>0? z<=z1 : z>=z1; z+=dir){ const x=x0+dxdz*(z-z0); const hn=Cr.hAt(x,z,h); if(Math.abs(hn-h)>3){ tele++; } h+=Math.max(-0.25,Math.min(0.25,hn-h)); mx=Math.max(mx,h); mn=Math.min(mn,h); }
   return {mx:+mx.toFixed(1),mn:+mn.toFixed(1),tele}; }
 const cases={ c1225:[1225,985,1075,0], c1468:[1468,985,1075,0], c1343:[1348,1000,1065,-0.19] };
 for(const [k,[xc,za,zb,sl]] of Object.entries(cases)){ const res=[]; for(let ox=-6;ox<=6;ox+=1){ const g=Cr.hAt(xc+ox,za,0); const r=run(xc+ox,za,zb,sl,g); res.push([ox,r.mn,r.mx,r.tele]); }
   out[k]=res.filter(r=>r[2]<8).map(r=>r[0]).join(',')+' | all: '+res.map(r=>r[0]+':'+r[1]+'/'+r[2]+(r[3]?'!'+r[3]:'')).join(' '); }
 return JSON.stringify(out,null,1); })()
