// タクシー営業の一連の流れの試験（repl.js の命令ファイル）。先にメニューから「車 → ミッション → タクシー営業」を開始しておく。
// 流れ: ①乗り場で乗せる → ②運賃（メーター）→ ③配車の依頼を受ける → ④迎えに行って乗せる（迎車料金）→ ⑤待たせすぎてキャンセル → ⑥見送り
// 結果の checks がすべて true なら合格。dt を大きく取って tick を回すので、描画の速さには左右されない。
(()=>{
  const Tx = __Taxi, T = Tx.T, C = __Car.C, N = __Nav, S = __S, out = { checks: {}, info: {} }, ck = (k, v) => { out.checks[k] = !!v; };
  if(!T.on) return JSON.stringify({ error: "タクシー営業が始まっていません" });
  const tp = (x, z, yaw) => { C.x = x; C.z = z; if(yaw !== undefined) C.yaw = yaw; C.v = 0; C.h = __Car.hAt(x, z); };
  const run = (n, dt, v) => { for(let i = 0; i < n; i++){ if(v !== undefined) C.v = v; Tx.tick(dt); } };
  const park = (i) => { const sp = T.stands[i % T.stands.length]; tp(sp.x + 90, sp.z + 90, 0); run(5, 0.1, 0); };   // 乗り場から離れた所（乗り場に停まると、お客さんが乗ってしまう）
  const waitOffer = () => { T.nextCall = 0; for(let i = 0; i < 80 && !T.offer; i++){ C.v = 0; Tx.tick(0.25); } return T.offer; };   // 依頼は 20 秒で他の車へ回るので、入った瞬間で止める
  // ① 乗り場で乗せる
  const s = T.stands.slice().sort((a, b) => b.w - a.w)[0]; s.q.length = 0; s.q.push({ n: 2, t: T.t, seed: 3 });
  tp(s.x + 3, s.z + 3, 0); run(40, 0.1, 0); C.v = 0;
  ck("1乗り場で乗車", T.st === "ride" && T.ride && T.ride.n === 2);
  ck("1ナビが自動で目的地にセット", N.target && N.src === "auto" && N.target.kind === "drop");
  out.info.dest = T.ride && T.ride.dest.name; out.info.routeM = T.ride && Math.round(T.ride.routeM);
  T.stands.forEach((x) => { x.q.length = 0; x.tNext = 1e12; });   // 以降は乗り場のお客さんを出さない（乗り場の近くに置いても勝手に乗らないように）
  // ② 運賃: 走行距離・低速時間を直接入れて、メーターの式と一致するか
  const R = T.ride, d0 = R.dest; R.dist = 2400; R.slowT = 60; R.night = false; R.fee = 0; const exp = Tx.meterFare(R); const m0 = T.money;
  const cal = 700 + Math.max(0, Math.ceil((2400 + 60 * (250 / 90) - 1100) / 250)) * 100; ck("2メーターの式", exp === cal);
  tp(d0.x, d0.z, 0); run(25, 0.1, 0); C.v = 0;
  ck("2到着して支払い（メーター通りの金額）", T.st === "pay" && T.money - m0 === exp); out.info.fare = T.money - m0; out.info.exp = exp;
  run(60, 0.1, 0); ck("2支払い後は空車に戻る", T.st === "cruise");
  // ③ 配車の依頼
  waitOffer(); ck("3依頼が入る", !!T.offer);
  const c = T.offer && T.offer.c; if(c){ const straight = Math.hypot(c.x - C.x, c.z - C.z); out.info.callDist = Math.round(straight); out.info.callName = c.name; ck("3依頼の距離が 300〜2500 m", straight > 300 && straight < 2500); Tx.accept(); }
  ck("3受けると迎車", T.st === "pick" && !!T.call && N.target && N.target.kind === "load" && N.src === "auto");
  // ④ 迎えに行く
  if(c){ tp(c.x, c.z, 0); run(60, 0.1, 0); C.v = 0; ck("4乗せたら賃走（迎車料金つき）", T.st === "ride" && T.ride.fee === 300); }
  // 降ろして次へ
  if(T.ride){ const d1 = T.ride.dest; T.ride.dist = 1500; tp(d1.x, d1.z, 0); run(60, 0.1, 0); C.v = 0; run(60, 0.1, 0); }
  ck("4降ろして空車へ", T.st === "cruise");
  // ⑤ 待たせすぎて取り消し
  park(3); waitOffer(); const c2 = T.offer && T.offer.c; if(c2) Tx.accept(); const can0 = T.cancels;
  const lim = T.call ? T.call.limit : 0; out.info.limit = Math.round(lim); tp(c2 ? c2.x + 3000 : 0, c2 ? c2.z : 0, 0); run(Math.ceil(lim) + 30, 1, 0);   // 遠くで待たせる（お客さんが待ってくれる時間を過ぎるまで）
  ck("5待たせすぎるとキャンセル", T.st === "cruise" && T.cancels === can0 + 1 && !N.target);
  // ⑥ 見送り
  park(5); waitOffer(); const pass0 = T.passed; if(T.offer){ Tx.decline(); ck("6見送り", T.passed === pass0 + 1 && !T.offer && T.st === "cruise"); } else ck("6見送り（依頼が来なかった）", false);
  // ⑦ 依頼の道のり: いろいろな場所から依頼を出し、道のりが 3.6 km 以下・直線の 2.2 倍以下（または 1.5 km 以下）か、待ってもらえる時間が移動時間の 1.7 倍＋60 秒以上か
  { let n = 0, bad = 0, short = 0, maxR = 0, maxRatio = 0; const cancel = document.getElementById("tx-cancel");
    for(const sp of T.stands.slice(0, 16)){
      tp(sp.x + 90, sp.z + 90, 0); run(5, 0.1, 0); waitOffer(); const o = T.offer; if(!o) continue; n++; const c = o.c, st = Math.hypot(c.x - C.x, c.z - C.z);
      maxR = Math.max(maxR, c.route); maxRatio = Math.max(maxRatio, c.route / Math.max(1, st));
      if(!(c.route <= 3600 && (c.route <= 1500 || c.route <= c.dist * 2.2 + 1))) bad++;
      Tx.accept(); if(!(T.call && T.call.limit >= T.call.eta * 1.7 + 59)) short++;
      if(T.st === "pick" && cancel) cancel.click(); }
    out.info.offers = { n, bad, short, maxRoute: Math.round(maxR), maxRatio: +maxRatio.toFixed(2) }; ck("7依頼の道のりが妥当（16 か所）", n >= 12 && bad === 0 && short === 0); }
  out.info.money = T.money; out.info.rides = T.rides; out.ok = Object.values(out.checks).every(Boolean);
  return JSON.stringify(out);
})()
