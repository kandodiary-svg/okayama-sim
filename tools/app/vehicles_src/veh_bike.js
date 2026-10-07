  /* ================= バイク（v41.19）=================
     V.bike(opt) → THREE.Group。 g.userData: { body, eye, update(C, dt), setPaint(color), setSky(color), setInside(inside), setCargo(on), matBody }
     400cc クラスの標準的なネイキッド（実在の車種そのものではない）。座標: +z 前・+x 左・y 上。原点は車体の中心の真下（地面）。
     軸距 1.45m（前輪の軸 z=+0.72・後輪の軸 z=-0.73）、前輪 120/70-17（外径 0.60m）、後輪 160/60-17（外径 0.62m）、ステアリングヘッド 25°、座面高 0.80m、ハンドル幅 0.75m。
     ステアリング（フォーク・ハンドル・ヘッドライト・メーター・前輪・ライダーの手）は傾いた軸を中心に回る。ライダーの腕は 2 関節の簡易 IK で、ハンドルを切ると肘が動く。
     運転席視点の目の位置はライダーのヘルメットの中（ヘルメット・バイザーは視点の間だけ隠す）。 */
  const PALB = Object.assign({}, PALH, {
    engine: [0x2a2c30, 0], engineHi: [0x80858c, 3], fin: [0x383a3e, 0], frame: [0x17181a, 0], exh: [0xb4b9bf, 3], exhD: [0x1a1b1c, 0],
    rimM: [0x2d2f33, 3], discB: [0xa5a9ae, 3], hub: [0x8f9398, 3], seatB: [0x1f2022, 0], tireB: [0x121212, 0], rubber: [0x161617, 0],
    sig: [0xe8981c, 4], rad: [0x202225, 0], spring: [0xc8321e, 0], fork: [0xc9cdd2, 3], forkD: [0x2a2c30, 3], cal: [0xb98a2c, 0], chain: [0x2d2a22, 0], bar: [0x24262a, 3],
    jacket: [0x23272e, 0], jackR: [0xc9ccc4, 0], pants: [0x1b1e24, 0], glove: [0x131416, 0], boot: [0x17181b, 0], helm: [0xeceef0, 0], helmS: [0xc33a1d, 0],
    cargo: [0xd7a21c, 0], cargoD: [0x1d1d1f, 0], mirrorH: [0x1b1c1e, 0], mirrorG: [0x78838d, 3],
  });
  const _bQ = new THREE.Quaternion(), _bY = new THREE.Vector3(0, 1, 0), _bM = new THREE.Matrix4(), _bP = new THREE.Vector3(), _bS = new THREE.Vector3(1, 1, 1), _bD = new THREE.Vector3();
  function tubeB(B, k, a, b, r, seg){      // 2 点 a→b をつなぐ円柱（半径 r）
    _bD.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); const len = _bD.length(); if(len < 1e-5) return; _bD.multiplyScalar(1 / len);
    _bQ.setFromUnitVectors(_bY, _bD); _bP.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); _bM.compose(_bP, _bQ, _bS.set(1, 1, 1));
    B.geo(k, new THREE.CylinderGeometry(r, r, len, seg || 8, 1), _bM.clone());
  }
  function quadS(B, k, p, n){      // 四角（4 点・4 つの法線）。法線の向きに合わせた巻き順で三角形にする（なめらかな陰影）
    const e = (i, j, l) => { const ux = p[j][0] - p[i][0], uy = p[j][1] - p[i][1], uz = p[j][2] - p[i][2], vx = p[l][0] - p[i][0], vy = p[l][1] - p[i][1], vz = p[l][2] - p[i][2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, sx = n[i][0] + n[j][0] + n[l][0], sy = n[i][1] + n[j][1] + n[l][1], sz = n[i][2] + n[j][2] + n[l][2];
      if(cx * sx + cy * sy + cz * sz >= 0) B.tri(k, p[i], p[j], p[l], n[i], n[j], n[l]); else B.tri(k, p[i], p[l], p[j], n[i], n[l], n[j]); };
    e(0, 1, 2); e(0, 2, 3);
  }
  /* x 軸まわりの円弧の帯（フェンダー）: 中心 (cy, cz)・半径 R・幅 w・角は +y から +z 側へ th0→th1。外面と内面（R-t）の 2 枚 */
  function arcB(B, k, cx, cy, cz, R, w, th0, th1, n, t){
    for(const [rad, sg] of [[R, 1], [R - (t || 0.006), -1]]) for(let i = 0; i < n; i++){
      const a0 = th0 + (th1 - th0) * i / n, a1 = th0 + (th1 - th0) * (i + 1) / n, P = (a, x) => [cx + x, cy + rad * Math.cos(a), cz + rad * Math.sin(a)], N = (a) => [0, sg * Math.cos(a), sg * Math.sin(a)];
      quadS(B, k, [P(a0, w / 2), P(a0, -w / 2), P(a1, -w / 2), P(a1, w / 2)], [N(a0), N(a0), N(a1), N(a1)]); }
  }
  /* バイクの車輪 1 つ（原点は車軸・車軸は x）: 丸いタイヤ・5 本スポークの鋳造ホイール（両面）・ブレーキディスク（前は両側・後ろは片側）・ハブ */
  function bikeWheelGeo(r, tw, front){
    const Bw = new Builder(), seg = 40, rr = 0.215, h = r - rr;
    const pr = [[rr, -0.38], [rr + 0.25 * h, -0.46], [rr + 0.5 * h, -0.5], [rr + 0.75 * h, -0.465], [rr + 0.92 * h, -0.37], [rr + 0.99 * h, -0.21], [r, 0], [rr + 0.99 * h, 0.21], [rr + 0.92 * h, 0.37], [rr + 0.75 * h, 0.465], [rr + 0.5 * h, 0.5], [rr + 0.25 * h, 0.46], [rr, 0.38]].map((p) => [p[0], p[1] * tw]);
    lathe(Bw, "tireB", pr.reverse(), seg);
    { const g = new THREE.CylinderGeometry(rr * 0.97, rr * 0.97, tw * 0.74, seg, 1, true); g.rotateZ(Math.PI / 2); Bw.geo("engine", g, null); }
    for(const sg of [1, -1]){
      const xo = sg * tw * 0.37;
      Bw.disc("rimM", rr * 1.01, seg, xo, 0, 0, sg, rr * 0.86);                      // リムの縁
      for(let i = 0; i < 5; i++){ const a = 0.31 + i * Math.PI * 2 / 5, rm = (0.05 + rr * 0.88) / 2, len = rr * 0.88 - 0.05;
        Bw.rbox("rimM", 0.014, len, 0.036, 0.005, sg * tw * 0.27, rm * Math.cos(a), rm * Math.sin(a), 0, a, 0);
        // スポークの根もと（太く）と縁（先を広げる）
        Bw.rbox("rimM", 0.014, len * 0.3, 0.06, 0.005, sg * tw * 0.27, (0.05 + len * 0.15) * Math.cos(a), (0.05 + len * 0.15) * Math.sin(a), 0, a, 0);
        Bw.rbox("rimM", 0.014, len * 0.28, 0.07, 0.005, sg * tw * 0.27, (rr * 0.88 - len * 0.14) * Math.cos(a), (rr * 0.88 - len * 0.14) * Math.sin(a), 0, a, 0); }
      Bw.cyl("hub", 0.045, 0.045, tw * 0.62, 16, 0, 0, 0, "x");
      Bw.disc("hub", 0.05, 16, sg * tw * 0.33, 0, 0, sg); }
    // ブレーキディスク（外周が波形のウェーブディスク風に、穴あきの輪）
    const disc = (sg, rO) => { Bw.disc("discB", rO, 40, sg * (tw * 0.36), 0, 0, sg, rO * 0.66); Bw.disc("hub", rO * 0.66, 28, sg * (tw * 0.36), 0, 0, sg, rO * 0.40); for(let i = 0; i < 6; i++){ const a = i * Math.PI / 3 + 0.2; Bw.box("hub", 0.01, rO * 0.30, 0.03, sg * tw * 0.35, rO * 0.52 * Math.cos(a), rO * 0.52 * Math.sin(a), 0, a, 0); } };
    if(front){ disc(1, 0.155); disc(-1, 0.155); } else { disc(-1, 0.13); }
    if(!front){ Bw.disc("hub", 0.095, 30, tw * 0.36, 0, 0, 1, 0.052); for(let i = 0; i < 38; i++){ const a = i / 38 * Math.PI * 2; Bw.box("chain", 0.012, 0.012, 0.012, tw * 0.36 + 0.004, 0.097 * Math.cos(a), 0.097 * Math.sin(a), 0, a, 0); } }   // 後輪の左側のスプロケット
    return toGeo(Bw, PALB);
  }
  function bikeClusterTex(){      // 二連メーター（左: 回転計 0〜12 ×1000rpm・右: 速度計 0〜200km/h）
    return canvasT(1024, 364, (g, w, h) => {
      g.fillStyle = "#0b0d10"; g.fillRect(0, 0, w, h);
      const r = h * 0.43, cy = h * 0.5;
      dialFace(g, w * 0.215, cy, r, 12, 2, (i) => i, -135, 270, 10.6 / 12);
      dialFace(g, w * 0.785, cy, r, 10, 2, (i) => i * 20, -135, 270, undefined);
      g.fillStyle = "#9aa0a6"; g.font = "bold " + Math.round(r * 0.13) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("x1000 r/min", w * 0.215, cy + r * 0.40); g.fillText("km/h", w * 0.785, cy + r * 0.40);
      for(const [c, x] of [["#5a1a14", 0.42], ["#5a4a14", 0.46], ["#164a22", 0.54], ["#14304e", 0.58]]){ g.fillStyle = c; g.beginPath(); g.arc(w * x, h * 0.13, h * 0.034, 0, Math.PI * 2); g.fill(); }
    });
  }

  V.bike = (opt) => {
    opt = opt || {};
    const g = new THREE.Group(), ud = g.userData;
    const matBody = V.makeMat({ shininess: 85 }), matGlass = V.makeMat({ glass: true });
    ud.matBody = matBody; ud.matGlass = matGlass; if(opt.color) matBody.userData.U.uPaint.value.copy(opt.color);
    ud.setPaint = (c) => matBody.userData.U.uPaint.value.copy(c);
    const body = new THREE.Group(); g.add(body); ud.body = body;
    const RAKE = 25 * R2D, HEAD = [0, 0.934, 0.424], AX = [0, Math.cos(RAKE), -Math.sin(RAKE)];       // ステアリングヘッドの位置・軸（上向き）
    const onAx = (u, x, zp) => [x || 0, HEAD[1] + AX[1] * u + Math.sin(RAKE) * 0 + (zp || 0) * Math.sin(RAKE), HEAD[2] + AX[2] * u + (zp || 0) * Math.cos(RAKE)];    // 軸上の u と、軸に垂直で前向きの zp から車体座標へ
    const mesh = (geo, m, cast) => { const o = new THREE.Mesh(geo, m || matBody); if(cast !== false) o.castShadow = true; return o; };

    /* ---------- 車体（ステアリングしない部分）---------- */
    const Bs = new Builder();
    // フレーム（ダイヤモンド＋エンジンを抱えるクレードル）
    for(const sx of [1, -1]){
      tubeB(Bs, "frame", onAx(-0.02, sx * 0.035), [sx * 0.10, 0.62, 0.22], 0.019);            // ヘッドから下がる主管
      tubeB(Bs, "frame", [sx * 0.10, 0.62, 0.22], [sx * 0.115, 0.31, 0.20], 0.018);
      tubeB(Bs, "frame", [sx * 0.115, 0.31, 0.20], [sx * 0.115, 0.30, -0.20], 0.018);         // 下のクレードル
      tubeB(Bs, "frame", [sx * 0.115, 0.30, -0.20], [sx * 0.105, 0.42, -0.29], 0.018);
      tubeB(Bs, "frame", onAx(-0.05, sx * 0.04), [sx * 0.10, 0.90, -0.24], 0.021);            // 上の主管（タンクの下）
      tubeB(Bs, "frame", [sx * 0.10, 0.90, -0.24], [sx * 0.105, 0.42, -0.29], 0.021);
      tubeB(Bs, "frame", [sx * 0.10, 0.80, -0.26], [sx * 0.085, 0.86, -0.70], 0.016);         // シートレール
      tubeB(Bs, "frame", [sx * 0.105, 0.42, -0.29], [sx * 0.09, 0.78, -0.62], 0.013);
      Bs.rbox("frame", 0.02, 0.14, 0.11, 0.008, sx * 0.118, 0.38, -0.27);                    // スイングアームの付け根の板
      Bs.rbox("frame", 0.045, 0.085, 0.50, 0.014, sx * 0.108, 0.34, -0.50, 0, -0.13);        // スイングアーム
      Bs.cyl("frame", 0.016, 0.016, 0.09, 10, sx * 0.108, 0.37, -0.27, "x");
      // ステップ
      tubeB(Bs, "frame", [sx * 0.11, 0.37, -0.10], [sx * 0.19, 0.355, -0.10], 0.012);
      Bs.cyl("exh", 0.013, 0.013, 0.085, 10, sx * 0.235, 0.355, -0.10, "x"); Bs.cyl("rubber", 0.016, 0.016, 0.05, 10, sx * 0.265, 0.355, -0.10, "x");
      tubeB(Bs, "frame", [sx * 0.10, 0.50, -0.50], [sx * 0.20, 0.44, -0.52], 0.011); Bs.cyl("exh", 0.011, 0.011, 0.07, 8, sx * 0.235, 0.44, -0.52, "x");   // 後ろに乗る人のステップ
    }
    tubeB(Bs, "frame", onAx(-0.13), onAx(0.01), 0.034, 12);                                     // ヘッドパイプ
    // エンジン（水冷 4 気筒・前に傾いたシリンダー）
    Bs.rbox("engine", 0.25, 0.24, 0.40, 0.045, 0, 0.36, -0.03);
    Bs.cyl("engineHi", 0.078, 0.078, 0.035, 20, 0.135, 0.38, -0.13, "x"); Bs.cyl("engine", 0.07, 0.07, 0.03, 20, 0.14, 0.38, -0.13, "x");
    Bs.cyl("engineHi", 0.058, 0.058, 0.03, 18, -0.135, 0.40, 0.02, "x"); Bs.cyl("engine", 0.05, 0.05, 0.03, 18, -0.14, 0.40, 0.02, "x");
    Bs.rbox("engine", 0.255, 0.27, 0.20, 0.03, 0, 0.58, 0.115, 0, 0.30);
    for(let i = 0; i < 6; i++){ const t = 0.02 + i * 0.045; Bs.rbox("fin", 0.275, 0.014, 0.215, 0.005, 0, 0.47 + t * Math.cos(0.3), 0.115 - 0.095 * 0 + t * Math.sin(0.3) - 0.01, 0, 0.30); }
    Bs.rbox("engineHi", 0.26, 0.075, 0.19, 0.025, 0, 0.715, 0.15, 0, 0.30);                         // ヘッドカバー
    for(let i = -2; i <= 2; i++) Bs.box("engine", 0.004, 0.06, 0.18, i * 0.05, 0.725, 0.15, 0, 0.30);
    Bs.rbox("rad", 0.27, 0.27, 0.04, 0.01, 0, 0.56, 0.305, 0, 0.18);                                 // ラジエーター
    for(let i = 0; i < 9; i++) Bs.box("frame", 0.262, 0.004, 0.03, 0, 0.45 + i * 0.026, 0.325, 0, 0.18);
    // 排気（4 本のエキゾーストパイプ → 集合 → 右側のマフラー）
    for(const x of [-0.085, -0.028, 0.028, 0.085]){ tubeB(Bs, "exh", [x, 0.60, 0.225], [x * 0.55, 0.43, 0.28], 0.016); tubeB(Bs, "exh", [x * 0.55, 0.43, 0.28], [x * 0.2, 0.25, 0.22], 0.016); }
    Bs.rbox("exh", 0.17, 0.07, 0.26, 0.03, 0, 0.225, 0.08);                                         // エンジン下の集合部
    tubeB(Bs, "exh", [-0.06, 0.225, -0.04], [-0.19, 0.25, -0.16], 0.04);
    tubeB(Bs, "exh", [-0.19, 0.25, -0.16], [-0.205, 0.35, -0.80], 0.062, 14);
    Bs.cyl("exhD", 0.05, 0.05, 0.012, 14, -0.206, 0.355, -0.805, "z"); Bs.cyl("exh", 0.066, 0.066, 0.04, 14, -0.20, 0.34, -0.72, "z");
    // タンク・カバー・テール・シート
    Bs.rbox("paint", 0.32, 0.17, 0.43, 0.075, 0, 1.00, 0.17, 0, 0.11);
    Bs.rbox("paint", 0.25, 0.15, 0.20, 0.06, 0, 0.975, 0.36, 0, 0.30);
    Bs.cyl("exh", 0.045, 0.045, 0.012, 16, 0, 1.092, 0.12, "y");
    for(const sx of [1, -1]) Bs.rbox("rubber", 0.018, 0.09, 0.20, 0.008, sx * 0.165, 0.97, 0.12, 0, 0.11);       // タンクの膝あて
    Bs.rbox("seatB", 0.30, 0.075, 0.38, 0.03, 0, 0.855, -0.16);                                       // 乗る人のシート
    Bs.rbox("seatB", 0.26, 0.065, 0.28, 0.026, 0, 0.885, -0.47, 0, -0.07);                            // 後ろのシート
    for(const sx of [1, -1]) Bs.rbox("paint", 0.045, 0.14, 0.32, 0.018, sx * 0.135, 0.82, -0.31);     // サイドカバー
    Bs.rbox("paint", 0.20, 0.105, 0.36, 0.045, 0, 0.935, -0.66, 0, -0.14);                            // テールカウル
    Bs.rbox("frame", 0.17, 0.085, 0.34, 0.03, 0, 0.845, -0.62, 0, -0.14);                              // テールの下の受け皿
    Bs.box("tail", 0.15, 0.048, 0.03, 0, 0.935, -0.85, 0, -0.14); Bs.box("tail", 0.04, 0.046, 0.03, 0.09, 0.935, -0.84, 0, -0.14); Bs.box("tail", 0.04, 0.046, 0.03, -0.09, 0.935, -0.84, 0, -0.14);
    // 後輪の泥除け・ナンバー・ウインカー
    arcB(Bs, "frame", 0, 0.31, -0.73, 0.345, 0.16, -1.7, -0.35, 8);
    tubeB(Bs, "frame", [0, 0.62, -0.82], [0, 0.72, -0.86], 0.012);
    Bs.rbox("frame", 0.18, 0.05, 0.14, 0.012, 0, 0.745, -0.90, 0, 0.55); Bs.rbox("plate", 0.2, 0.105, 0.008, 0.004, 0, 0.74, -0.97, 0, 0.45);
    for(const sx of [1, -1]){ tubeB(Bs, "frame", [sx * 0.10, 0.84, -0.78], [sx * 0.14, 0.86, -0.86], 0.008); Bs.rbox("sig", 0.045, 0.035, 0.05, 0.012, sx * 0.145, 0.865, -0.87); }
    // サスペンション（モノショック）・チェーン・後輪のブレーキ
    tubeB(Bs, "exh", [0, 0.64, -0.33], [0, 0.40, -0.43], 0.013); tubeB(Bs, "spring", [0, 0.60, -0.34], [0, 0.45, -0.41], 0.03, 12);
    Bs.cyl("chain", 0.045, 0.045, 0.01, 20, 0.09, 0.37, -0.255, "x");
    tubeB(Bs, "chain", [0.10, 0.415, -0.255], [0.10, 0.395, -0.73], 0.007); tubeB(Bs, "chain", [0.10, 0.325, -0.255], [0.10, 0.225, -0.73], 0.007);
    Bs.rbox("cal", 0.04, 0.085, 0.07, 0.012, -0.075, 0.40, -0.63, 0, -0.1); tubeB(Bs, "frame", [-0.095, 0.37, -0.50], [-0.075, 0.40, -0.63], 0.012);
    // ブレーキペダル・シフトレバー
    tubeB(Bs, "frame", [-0.13, 0.33, -0.09], [-0.22, 0.30, 0.06], 0.009); Bs.rbox("rubber", 0.05, 0.012, 0.03, 0.005, -0.235, 0.30, 0.07);
    tubeB(Bs, "frame", [0.15, 0.38, -0.02], [0.25, 0.33, -0.01], 0.008); Bs.rbox("rubber", 0.04, 0.012, 0.025, 0.005, 0.27, 0.33, -0.01);
    body.add(mesh(toGeo(Bs, PALB), matBody));

    /* ---------- 後輪 ---------- */
    const rw = new THREE.Group(); rw.position.set(0, 0.31, -0.73); rw.add(mesh(bikeWheelGeo(0.31, 0.16, false))); body.add(rw);

    /* ---------- ステアリング群（傾いた軸のまわりに回る）---------- */
    const steerG = new THREE.Group(); steerG.position.set(HEAD[0], HEAD[1], HEAD[2]); steerG.rotation.x = -RAKE; body.add(steerG); steerG.updateMatrix();
    const fork = new THREE.Group(); steerG.add(fork);
    const Bf = new Builder(), GR = [0.315, 0.095, -0.05];       // 左のグリップの位置（フォークの座標: x, y（軸方向）, z（前）。右は x を反転）
    for(const sx of [1, -1]){
      tubeB(Bf, "fork", [sx * 0.095, -0.30, 0], [sx * 0.095, 0.05, 0], 0.0205, 10);               // インナーチューブ
      tubeB(Bf, "forkD", [sx * 0.095, -0.70, 0], [sx * 0.095, -0.27, 0], 0.031, 10);              // アウターチューブ
      Bf.cyl("hub", 0.022, 0.022, 0.03, 10, sx * 0.112, -0.70, 0, "x");
      Bf.rbox("cal", 0.04, 0.09, 0.075, 0.012, sx * 0.108, -0.60, 0.112, 0, -0.5);                 // ブレーキキャリパー
      tubeB(Bf, "bar", [sx * 0.0, 0.075, -0.01], [sx * 0.22, 0.085, -0.012], 0.0115, 10);          // ハンドル
      tubeB(Bf, "bar", [sx * 0.22, 0.085, -0.012], [sx * 0.26, 0.092, -0.045], 0.0115, 10);
      Bf.cyl("rubber", 0.0175, 0.0175, 0.125, 12, sx * 0.315, 0.095, -0.05, "x");                  // グリップ
      tubeB(Bf, "exh", [sx * 0.27, 0.088, -0.02], [sx * 0.30, 0.075, 0.115], 0.0065);             // レバー
      tubeB(Bf, "bar", [sx * 0.25, 0.092, -0.03], [sx * 0.30, 0.285, -0.06], 0.0065);             // ミラーのステー
      Bf.rbox("mirrorH", 0.125, 0.082, 0.026, 0.012, sx * 0.31, 0.325, -0.065, 0, -0.05, sx * -0.1); Bf.rbox("mirrorG", 0.105, 0.064, 0.004, 0.002, sx * 0.31, 0.325, -0.0795, 0, -0.05, sx * -0.1);
      tubeB(Bf, "frame", [sx * 0.095, -0.12, 0.0], [sx * 0.13, -0.11, 0.115], 0.01); Bf.rbox("sig", 0.045, 0.036, 0.05, 0.012, sx * 0.14, -0.11, 0.135);   // ウインカー
    }
    Bf.rbox("frame", 0.23, 0.04, 0.075, 0.015, 0, 0.03, -0.005);                                   // トップブリッジ
    Bf.rbox("frame", 0.21, 0.04, 0.075, 0.015, 0, -0.105, -0.005);                                 // アンダーブラケット
    Bf.rbox("frame", 0.07, 0.035, 0.07, 0.012, 0, 0.068, -0.01);                                   // ハンドルホルダー
    // ヘッドライト（丸形）
    Bf.cyl("exhD", 0.092, 0.075, 0.13, 24, 0, -0.07, 0.115, "z"); Bf.cyl("exh", 0.098, 0.098, 0.022, 26, 0, -0.07, 0.185, "z"); Bf.cyl("lamp", 0.083, 0.083, 0.012, 26, 0, -0.07, 0.198, "z");
    tubeB(Bf, "frame", [-0.095, -0.07, 0.0], [-0.095, -0.07, 0.06], 0.012); tubeB(Bf, "frame", [0.095, -0.07, 0.0], [0.095, -0.07, 0.06], 0.012);
    // 前輪の泥除け
    arcB(Bf, "paint", 0, -0.70, 0, 0.342, 0.145, -0.55, 1.22, 12);
    for(const sx of [1, -1]) tubeB(Bf, "frame", [sx * 0.07, -0.70 + 0.34 * Math.cos(0.3), 0.34 * Math.sin(0.3)], [sx * 0.095, -0.45, 0.0], 0.009);
    fork.add(mesh(toGeo(Bf, PALB), matBody));
    // 前輪（フォークの下端）
    const fw = new THREE.Group(); fw.position.set(0, -0.70, 0); fw.add(mesh(bikeWheelGeo(0.30, 0.12, true))); fork.add(fw);
    // メーター
    { const clu = new THREE.Group(), n = new THREE.Vector3(0, 0.979, -0.206), Xv = new THREE.Vector3(-1, 0, 0), Zv = n.clone().normalize(), Yv = new THREE.Vector3().crossVectors(Zv, Xv);
      clu.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xv, Yv, Zv)); clu.position.set(0, 0.104, 0.062);
      const W = 0.16, H = W * 364 / 1024, hs = new THREE.Mesh(toGeo((() => { const b = new Builder(); b.rbox("frame", W + 0.014, H + 0.012, 0.03, 0.01, 0, 0, -0.016); return b; })(), PALB), matBody); clu.add(hs);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: bikeClusterTex() })); face.position.z = 0.0015; clu.add(face);
      const needleG = (len) => { const sh = new THREE.Shape(); sh.moveTo(-0.0022, -0.01); sh.lineTo(0.0022, -0.01); sh.lineTo(0.0007, len); sh.lineTo(-0.0007, len); sh.closePath(); return new THREE.ShapeGeometry(sh); };
      const nm = new THREE.MeshBasicMaterial({ color: 0xff6a2b, side: THREE.DoubleSide }), cap = new THREE.MeshBasicMaterial({ color: 0x15181b });
      const mkN = (px) => { const nd = new THREE.Mesh(needleG(H * 0.43 * 0.86), nm); nd.position.set(px, 0, 0.0028); clu.add(nd); const c = new THREE.Mesh(new THREE.CircleGeometry(0.0075, 14), cap); c.position.set(px, 0, 0.0036); clu.add(c); return nd; };
      ud.nTacho = mkN((0.215 - 0.5) * W); ud.nSpeed = mkN((0.785 - 0.5) * W);
      const midC = document.createElement("canvas"); midC.width = 128; midC.height = 96; const midT = new THREE.CanvasTexture(midC);
      const mid = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.027), new THREE.MeshBasicMaterial({ map: midT })); mid.position.set(0, -0.002, 0.002); clu.add(mid); ud.mid = { c: midC, t: midT, key: "" };
      fork.add(clu); }

    /* ---------- ライダー ---------- */
    const Br = new Builder(), Bh = new Builder(), Bg = new Builder();
    const HIP = [0.0, 0.89, -0.20], SH = [0.0, 1.29, 0.07];
    // 胴（ジャケット）・腰
    const Bt = new Builder();   // 上半身（運転席視点では目のすぐ下にあるので、その視点では隠す）
    Bt.rbox("jacket", 0.37, 0.50, 0.23, 0.08, 0, 1.085, -0.065, 0, 0.62);
    Bt.rbox("jackR", 0.375, 0.035, 0.235, 0.012, 0, 1.00, -0.115, 0, 0.62); Bt.rbox("jackR", 0.375, 0.03, 0.235, 0.012, 0, 1.17, -0.015, 0, 0.62);       // 反射テープ
    Bt.rbox("jacket", 0.40, 0.12, 0.26, 0.05, 0, 1.285, 0.07, 0, 0.5);                                                                              // 肩
    Bt.cyl("jacket", 0.058, 0.066, 0.1, 12, 0, 1.36, 0.115, "y");                                                                                      // 襟
    Br.rbox("pants", 0.34, 0.2, 0.3, 0.08, 0, 0.90, -0.20);
    for(const sx of [1, -1]){ const hp = [sx * 0.14, 0.89, -0.21], kn = [sx * 0.215, 0.84, 0.16], an = [sx * 0.2, 0.425, -0.075];
      tubeB(Br, "pants", hp, kn, 0.075, 12); Br.geo("pants", new THREE.SphereGeometry(0.075, 12, 8), new THREE.Matrix4().makeTranslation(kn[0], kn[1], kn[2]));
      tubeB(Br, "pants", kn, an, 0.058, 12); Br.rbox("boot", 0.105, 0.11, 0.27, 0.035, an[0], 0.385, an[2] + 0.075); Br.rbox("boot", 0.1, 0.14, 0.1, 0.03, an[0], 0.47, an[2] - 0.01); }
    // 手袋（ハンドルの動きに合わせてフォークの座標に付ける）
    for(const sx of [1, -1]){ Bg.rbox("glove", 0.115, 0.065, 0.085, 0.028, sx * GR[0], GR[1] + 0.0, GR[2] + 0.0); Bg.rbox("glove", 0.035, 0.05, 0.075, 0.015, sx * (GR[0] - 0.07), GR[1] + 0.01, GR[2] + 0.015); }
    fork.add(mesh(toGeo(Bg, PALB), matBody));
    const riderMesh = mesh(toGeo(Br, PALB), matBody); body.add(riderMesh); const riderTop = mesh(toGeo(Bt, PALB), matBody); body.add(riderTop);
    // ヘルメット（フルフェイス）とバイザー
    { const hc = [0, 1.455, 0.145], hm = (sx, sy, sz, rx) => new THREE.Matrix4().compose(new THREE.Vector3(hc[0], hc[1], hc[2]), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, 0, 0)), new THREE.Vector3(sx, sy, sz));
      Bh.geo("helm", new THREE.SphereGeometry(0.135, 28, 18), hm(1.0, 1.07, 1.22, 0.12));
      Bh.rbox("helm", 0.17, 0.09, 0.12, 0.04, 0, 1.385, 0.255, 0, 0.35);                          // あご
      const helm = mesh(toGeo(Bh, PALB), matBody); body.add(helm);
      const Bv = new Builder(); Bv.geo("glass", new THREE.SphereGeometry(0.139, 24, 10, Math.PI / 2 - 0.95, 1.9, 1.0, 0.72), hm(1.0, 1.07, 1.22, 0.12));
      const visor = mesh(toGeo(Bv, PALB), matGlass, false); visor.renderOrder = 2; body.add(visor); ud.helmet = [helm, visor, riderTop]; }
    // 腕（肩 → 肘 → グリップの 2 関節の IK。フォークの動きに追従する）
    const unitCyl = (r, col) => { const b = new Builder(); b.geo(col, (() => { const c = new THREE.CylinderGeometry(r, r * 0.88, 1, 10, 1); c.translate(0, 0.5, 0); return c; })(), null); return toGeo(b, PALB); };
    const upG = unitCyl(0.052, "jacket"), foG = unitCyl(0.045, "jacket");
    const arms = [1, -1].map((sx) => { const up = new THREE.Mesh(upG, matBody), fo = new THREE.Mesh(foG, matBody), el = new THREE.Mesh(toGeo((() => { const b = new Builder(); b.geo("jacket", new THREE.SphereGeometry(0.056, 12, 8), null); return b; })(), PALB), matBody);
      up.castShadow = fo.castShadow = true; body.add(up); body.add(fo); body.add(el); return { sx, up, fo, el, S: new THREE.Vector3(sx * 0.205, SH[1] - 0.015, SH[2]) }; });
    const _H = new THREE.Vector3(), _E = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Matrix4(), UPLEN = 0.31, FOLEN = 0.29;
    const setLimb = (mesh, a, b) => { _d.copy(b).sub(a); const l = _d.length(); mesh.position.copy(a); mesh.scale.set(1, l, 1); _bQ.setFromUnitVectors(_bY, _d.multiplyScalar(1 / Math.max(l, 1e-6))); mesh.quaternion.copy(_bQ); };
    const armsUpdate = () => {
      _m.copy(steerG.matrix).multiply(fork.matrix);
      for(const a of arms){
        _H.set(a.sx * (GR[0] - 0.01), GR[1] + 0.012, GR[2] + 0.0).applyMatrix4(_m);
        _d.copy(_H).sub(a.S); let d = _d.length(); const dm = UPLEN + FOLEN - 0.01; if(d > dm){ _d.multiplyScalar(dm / d); _H.copy(a.S).add(_d); d = dm; }
        const cA = (UPLEN * UPLEN - FOLEN * FOLEN + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, UPLEN * UPLEN - cA * cA));
        _d.multiplyScalar(1 / d);                                                                                       // 肩 → 手の向き
        _p.set(a.sx * 0.75, -0.55, -0.3); _p.addScaledVector(_d, -_p.dot(_d)).normalize();                               // 肘を出す向き（外側・下）
        _E.copy(a.S).addScaledVector(_d, cA).addScaledVector(_p, hh);
        setLimb(a.up, a.S, _E); setLimb(a.fo, _E, _H); a.el.position.copy(_E); }
    };
    // 荷物（後ろのリアボックス）: 宅配のミッションのときに見せる
    { const Bc = new Builder(); Bc.rbox("cargo", 0.44, 0.38, 0.42, 0.05, 0, 1.19, -0.78); Bc.rbox("cargoD", 0.45, 0.04, 0.43, 0.02, 0, 1.015, -0.78); Bc.box("cargoD", 0.3, 0.012, 0.2, 0, 1.385, -0.78);
      Bc.rbox("frame", 0.36, 0.03, 0.36, 0.01, 0, 0.99, -0.78); tubeB(Bc, "frame", [0.14, 0.99, -0.62], [0.12, 0.84, -0.52], 0.011); tubeB(Bc, "frame", [-0.14, 0.99, -0.62], [-0.12, 0.84, -0.52], 0.011);
      const cargo = mesh(toGeo(Bc, PALB), matBody); cargo.visible = false; body.add(cargo); ud.cargo = cargo; ud.setCargo = (on) => { cargo.visible = !!on; }; }

    /* ---------- 視点・更新 ---------- */
    ud.eye = { x: 0, y: 1.50, z: 0.02, pitch: 10 };
    ud.setInside = (inside) => { if(ud.helmet) for(const m of ud.helmet) m.visible = !inside; };      // 運転席視点では頭の中にカメラがある → ヘルメットは隠す
    ud.setSky = () => {};
    ud.update = (C, dt) => {
      dt = dt || 0.016; const v = C.v || 0, kmh = Math.abs(v) * 3.6;
      rw.rotation.x += v * dt / 0.31; fw.rotation.x += v * dt / 0.30;
      fork.rotation.y = C.steer || 0; fork.updateMatrix(); armsUpdate();
      if(ud.nSpeed){ ud.nSpeed.rotation.z = -(-135 + 270 * Math.min(1.04, kmh / 200)) * R2D; ud.nTacho.rotation.z = -(-135 + 270 * Math.min(1.04, (C.rpm === undefined ? 1300 : C.rpm) / 12000)) * R2D; }
      matBody.userData.U.uBrake.value = (C.brk || 0) > 0.05 ? 1 : 0;
      if(ud.mid){ const key = (C.gear === "R" ? "R" : (C.gearN || 1)) + "|" + Math.round(kmh); if(key !== ud.mid.key){ ud.mid.key = key; const c = ud.mid.c.getContext("2d");
        c.fillStyle = "#07090b"; c.fillRect(0, 0, 128, 96); c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = C.gear === "R" ? "#ff7a3a" : "#7be08a"; c.font = "bold 58px sans-serif"; c.fillText(C.gear === "R" ? "R" : String(C.gearN || 1), 64, 36);
        c.fillStyle = "#e8eef2"; c.font = "bold 28px sans-serif"; c.fillText(String(Math.round(kmh)), 64, 78); ud.mid.t.needsUpdate = true; } }
    };
    ud.update({ v: 0, rpm: 1300, gear: "D", gearN: 1, steer: 0, brk: 0 }, 0.016);
    return g;
  };
