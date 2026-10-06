// ナビの経路計算の試験（repl.js の命令ファイル）: 主要道路の 6 地点 × 全 POI の 1/4 で、経路が見つかる割合・計算時間・直線距離との比を出す（v41.10）
// 期待: failRate = 0、ratioMin >= 1、msMed < 100、ms95 < 300
(()=>{
const N = __Nav, T = __Traffic;
// POI を読む（ページ内の本物の Nav から）
const POI = __Nav.POI; const segs = T.segs;
const out = { starts: [], fails: [], ratios: [], ms: [] };
// 出発点: 主要道路の車線をランダムに 14 本（乱数固定）
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const arts = []; for(let i = 0; i < segs.length; i++){ const g = segs[i]; if(g.lane && (g.c === "p" || g.c === "t" || g.c === "s") && g.P.len > 80 && g.next.length) arts.push(i); }
const nStart = 6, starts = [];
while(starts.length < nStart){ const i = arts[Math.floor(rnd() * arts.length)], g = segs[i]; const q = __pathPt(g.P, g.P.len * 0.4); if(Math.hypot(q.x, q.z) < 4200) starts.push({ x: q.x, z: q.z, i }); }
const goals = POI.p.filter((_, k) => k % 4 === 0 && _[1] !== 14);
let n = 0, fail = 0; const failBy = new Map();
for(const st of starts){
  const tg = __pathPt(segs[st.i].P, segs[st.i].P.len * 0.4 + 3), yaw = Math.atan2(tg.x - st.x, tg.z - st.z);
  for(const [nm, c, x, z] of goals){
    const R = N.plan(st.x, st.z, yaw, x, z); n++;
    if(!R){ fail++; failBy.set(nm, (failBy.get(nm) || 0) + 1); continue; }
    out.ms.push(R.ms); (out.leg=out.leg||[]).push(R.legEL||0); const sl = Math.hypot(x - st.x, z - st.z); if(sl > 400) out.ratios.push(R.total / sl);
  }
}
const q = (a, p) => { const b = a.slice().sort((u, v) => u - v); return +b[Math.min(b.length - 1, Math.floor(b.length * p))].toFixed(2); };
out.n = n; out.fail = fail; out.failRate = +(fail / n).toFixed(4); out.msMed = q(out.ms, .5); out.ms95 = q(out.ms, .95); out.msMax = q(out.ms, 1); out.ratioMed = q(out.ratios, .5); out.ratio95 = q(out.ratios, .95); out.ratioMax = q(out.ratios, 1); out.ratioMin = q(out.ratios, 0);
out.failNames = [...failBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0] + ":" + e[1]);
out.legMed=q(out.leg,.5); out.leg90=q(out.leg,.9); out.leg99=q(out.leg,.99); out.legMax=q(out.leg,1); out.leg40=out.leg.filter(v=>v>40).length; delete out.leg; delete out.ms; delete out.ratios; delete out.starts; delete out.fails;
return JSON.stringify(out);
})()
