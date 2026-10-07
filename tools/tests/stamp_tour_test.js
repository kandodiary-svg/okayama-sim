// v41.15: 観光のお客さん（行き先は未取得の名所）の試験（repl.js の命令ファイル）。岡山城・後楽園だけ未取得にして、降ろしたらスタンプ・お礼の行・名所チップを数えない、を確かめる。
(()=>{
  __Quest.begin('car_taxishift');
  const Tx = __Taxi, T = Tx.T, C = __Car.C, St = __Stamps, out = { checks: {}, info: {} }, ck = (k, v) => { out.checks[k] = !!v; };
  const tp = (x, z, yaw) => { C.x = x; C.z = z; if(yaw !== undefined) C.yaw = yaw; C.v = 0; C.h = __Car.hAt(x, z); };
  const run = (n, dt, v) => { for(let i = 0; i < n; i++){ if(v !== undefined) C.v = v; Tx.tick(dt); } };
  St.reset();
  const g = St.got; for(const q of St.LIST) if(q.id !== "castle" && q.id !== "korakuen") g[q.id] = "2026-01-01";
  out.info.unc = St.uncollected().map((q) => q.id);
  const s = T.stands.slice().sort((a, b) => b.w - a.w)[0]; const rides = []; let tourRide = null;
  for(let k = 0; k < 80 && !tourRide; k++){
    T.stands.forEach((x) => { x.q.length = 0; x.tNext = 1e12; });
    s.q.length = 0; s.q.push({ n: 1, t: T.t, seed: k + 1 });
    tp(s.x + 3, s.z + 3, 0); run(40, 0.1, 0); C.v = 0;
    const R = T.ride; if(!R){ rides.push("noride"); break; }
    rides.push(R.tour ? "T:" + R.dest.name : "n"); if(R.tour){ tourRide = R; break; }
    R.dist = 1500; tp(R.dest.x, R.dest.z, 0); run(60, 0.1, 0); C.v = 0; run(80, 0.1, 0);
  }
  out.info.rides = rides.join(",");
  ck("観光のお客さんが出る", !!tourRide);
  if(tourRide){
    const R = tourRide, d = R.dest; out.info.dest = d.name; out.info.routeM = Math.round(R.routeM); out.info.fromLane = Math.round(Math.hypot(d.x - St.byId(d.stamp).x, d.z - St.byId(d.stamp).z));
    R.dist = Math.max(R.dist, R.routeM); tp(d.x, d.z, 0); run(60, 0.1, 0); C.v = 0; run(10, 0.1, 0);
    out.info.collectedImmediately = !!St.got[d.stamp];
    ck("降ろしたらスタンプ", !!St.got[d.stamp] && St.got[d.stamp] !== "2026-01-01");
    const rc = document.getElementById("txrc"); out.info.receipt = rc.textContent.replace(/\s+/g, " ").slice(0, 260);
    ck("名所チップは行き先ぶんを含まない", !/観光チップ/.test(rc.textContent));
    ck("お礼の行", /観光案内のお礼/.test(rc.textContent));
  }
  St.reset();
  out.ok = Object.values(out.checks).every(Boolean); return JSON.stringify(out);
})()
