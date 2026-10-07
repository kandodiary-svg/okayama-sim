// v41.15: 各スタンプの最寄りの車線までの距離と、スタンプの範囲の比較（repl.js の命令ファイル）。TIGHT は車線の距離＋14 m が範囲を超える所
(()=>{ const out=[]; for(const q of __Stamps.LIST){ const L = __Traffic.locate(q.x,q.z,null,140,1)[0]; out.push([q.id, q.r, L? Math.round(L.d):null, L && L.d + 14 > q.r ? "TIGHT" : "ok"]); } return JSON.stringify(out); })()
