  /* ================= 自分の車（細部まで作る・車輪は回る/曲がる・車内あり）=================
     V.hi(name, opt) → THREE.Group。 g.userData: { body, cab, wheels, eye, drive(v, dt, steer), update(C), setPaint(color), setSky(color) }
     車内の座標も同じ（+z 前・+x 左・y 上）。右ハンドルなので運転席は x < 0 */
  const PALH = Object.assign({}, AIPAL, {
    glass: [0x1c262c, 2], tire: [0x131313, 0],
    dash: [0x24272b, 7], dashHi: [0x32363c, 7], visor: [0x17181a, 7], door: [0x30333a, 7], doorLow: [0x26272a, 0], carpet: [0x2a2928, 0],
    head: [0xc2c0b8, 0], pillarA: [0x4f5154, 0], pillarB: [0x4f5154, 0], seat: [0x3a3835, 0], seatLt: [0x4b4743, 0], steer: [0x1a1a1b, 7],
    metalS: [0x9a9ea4, 3], shelf: [0x222324, 0], discM: [0x4a4d50, 0], spoke: [0xcdd0d4, 3], calip: [0x2d2f32, 0], barrel: [0x2a2c2f, 0], rubber: [0x161617, 0],
  });
  const R2D = Math.PI / 180;
  function canvasT(w, h, draw){ const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); draw(g, w, h); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; t.needsUpdate = true; return t; }
  function toGeo(B, pal, keys, excl){      // Builder の一部の群だけを BufferGeometry にする
    const sub = new Builder(); for(const [k, g] of Object.entries(B.g)){ if(keys ? keys.indexOf(k) < 0 : false) continue; if(excl && excl.indexOf(k) >= 0) continue; sub.g[k] = g; }
    return toMerged(sub, pal);
  }
  /* ---------- 車輪 1 つ（原点は車輪の中心・車軸は x）---------- */
  function lathe(Bw, k, prof, seg){      // prof: [ρ, a]（a は車軸方向）
    const pts = prof.map((p) => new THREE.Vector2(p[0], p[1])), g = new THREE.LatheGeometry(pts, seg); g.rotateZ(-Math.PI / 2); Bw.geo(k, g, null); }
  function buildWheel(w){
    const Bw = new Builder(), r = w.r, tw = w.tw, sg = w.sg, seg = 30, a0 = sg * tw * 0.495, hi = tw;
    const one = (off) => {      // 1 本分のタイヤ（off: 車軸方向のずれ）
      const prof = [[0.61, -0.40], [0.66, -0.48], [0.80, -0.505], [0.93, -0.495], [0.985, -0.43], [1.0, -0.33], [1.0, 0.33], [0.985, 0.43], [0.93, 0.495], [0.80, 0.505], [0.66, 0.48], [0.61, 0.40]].map((p) => [p[0] * r, p[1] * tw + off]);
      lathe(Bw, "tire", prof.reverse(), seg); };
    one(0);
    if(w.dual){ one(-sg * tw * 1.1); Bw.cyl("barrel", r * 0.5, r * 0.5, tw * 1.1, 14, -sg * tw * 0.55, 0, 0, "x"); }
    // ホイール: 内側の筒・縁の輪・ブレーキの円板・5 本のスポーク・中心のふた
    const rr0 = r * 0.585;
    { const g = new THREE.CylinderGeometry(rr0, rr0, tw * 0.95, seg, 1, true); g.rotateZ(Math.PI / 2); g.translate(sg * tw * 0.03, 0, 0); Bw.geo("barrel", g, null); }
    Bw.disc("barrel", rr0 * 1.0, seg, a0 - sg * tw * 0.42, 0, 0, sg);
    Bw.disc("spoke", r * 0.668, seg, a0, 0, 0, sg, rr0 * 0.97);
    Bw.disc("discM", r * 0.52, seg, a0 - sg * tw * 0.30, 0, 0, sg, r * 0.18);
    Bw.disc("dark", r * 0.20, 14, a0 - sg * tw * 0.31, 0, 0, sg);
    const n = [sg, 0, 0], ph = 0.31;
    for(let i = 0; i < 5; i++){ const a = ph + i * Math.PI * 2 / 5, ca = Math.cos(a), sa = Math.sin(a), px = -sa, pz = ca, xf = a0 - sg * tw * 0.04, dep = (rho) => xf - sg * tw * 0.06 * (1 - rho / 0.6);
      const q2 = (rho, wd, dd) => [dep(rho) + sg * (dd || 0), ca * rho * r + px * wd * r, sa * rho * r + pz * wd * r];
      Bw.quadN("spoke", q2(0.17, -0.075, 0.004), q2(0.17, 0.075, 0.004), q2(0.62, 0.12, 0.004), q2(0.62, -0.12, 0.004), n);
      // 側面の縁（スポークの厚み）
      Bw.quadN("discM", q2(0.17, 0.075, 0.004), q2(0.17, 0.075, -0.02), q2(0.62, 0.12, -0.02), q2(0.62, 0.12, 0.004), [0, px, pz]);
      Bw.quadN("discM", q2(0.17, -0.075, 0.004), q2(0.17, -0.075, -0.02), q2(0.62, -0.12, -0.02), q2(0.62, -0.12, 0.004), [0, -px, -pz]); }
    Bw.disc("spoke", r * 0.19, 16, a0 - sg * tw * 0.01, 0, 0, sg); Bw.disc("dark", r * 0.12, 14, a0 - sg * tw * 0.005 + sg * 0.003, 0, 0, sg);
    const spin = toGeo(Bw, PALH);
    const Bc = new Builder();      // キャリパー（回らない）: 円板の上の方
    Bc.rbox("calip", tw * 0.22, r * 0.32, r * 0.24, 0.012, 0, r * 0.36, r * 0.1);
    const calip = toGeo(Bc, PALH); calip.translate(a0 - sg * tw * 0.36, 0, 0);
    return { spin, calip };
  }

  /* ---------- 車内 ---------- */
  function dialFace(g, cx, cy, r, major, minorPer, lbl, ang0, sweep, redFrom){
    const grd = g.createRadialGradient(cx, cy, r * 0.05, cx, cy, r); grd.addColorStop(0, "#1c2026"); grd.addColorStop(1, "#0a0c0f");
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#4a5058"; g.lineWidth = r * 0.045; g.beginPath(); g.arc(cx, cy, r * 0.985, 0, Math.PI * 2); g.stroke();
    const pol = (a, rad) => [cx + Math.sin(a * R2D) * rad, cy - Math.cos(a * R2D) * rad];
    if(redFrom !== undefined){ g.strokeStyle = "#d8301e"; g.lineWidth = r * 0.06; g.beginPath(); const a1 = ang0 + sweep * redFrom, a2 = ang0 + sweep; g.arc(cx, cy, r * 0.83, (a1 - 90) * R2D, (a2 - 90) * R2D); g.stroke(); }
    for(let i = 0; i <= major; i++){ const a = ang0 + sweep * i / major, p1 = pol(a, r * 0.78), p2 = pol(a, r * 0.93);
      g.strokeStyle = "#f2f2ee"; g.lineWidth = r * 0.034; g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
      const tp = pol(a, r * 0.62); g.fillStyle = "#f0f0ea"; g.font = "bold " + Math.round(r * 0.19) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(lbl(i)), tp[0], tp[1]);
      if(i < major) for(let m = 1; m < minorPer; m++){ const a2 = ang0 + sweep * (i + m / minorPer) / major, q1 = pol(a2, r * 0.85), q2 = pol(a2, r * 0.93); g.strokeStyle = "#a9adb2"; g.lineWidth = r * 0.016; g.beginPath(); g.moveTo(q1[0], q1[1]); g.lineTo(q2[0], q2[1]); g.stroke(); } }
  }
  function clusterTex(){      // 計器盤の文字盤（左: エンジン回転計・右: 速度計）
    return canvasT(1024, 364, (g, w, h) => {
      g.fillStyle = "#0b0d10"; g.fillRect(0, 0, w, h);
      const r = h * 0.43, cy = h * 0.5;
      dialFace(g, w * 0.185, cy, r, 8, 2, (i) => i, -135, 270, 6.5 / 8);
      dialFace(g, w * 0.815, cy, r, 9, 2, (i) => i * 20, -135, 270, undefined);
      g.fillStyle = "#9aa0a6"; g.font = "bold " + Math.round(r * 0.13) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("x1000 r/min", w * 0.185, cy + r * 0.36); g.fillText("km/h", w * 0.815, cy + r * 0.36);
      // 警告灯（消灯の暗い色）
      const ic = [["#5a1a14", w * 0.40], ["#5a4a14", w * 0.44], ["#164a22", w * 0.56], ["#14304e", w * 0.60]];
      for(const [c, x] of ic){ g.fillStyle = c; g.beginPath(); g.arc(x, h * 0.13, h * 0.032, 0, Math.PI * 2); g.fill(); }
    });
  }
  function screenTex(){      // 中央の画面（地図風の絵）
    return canvasT(512, 256, (g, w, h) => {
      g.fillStyle = "#0e1a24"; g.fillRect(0, 0, w, h);
      g.fillStyle = "#1b2b38"; g.fillRect(0, 26, w, h - 26);
      g.strokeStyle = "#3a5368"; g.lineWidth = 3; let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for(let i = 0; i < 9; i++){ g.beginPath(); g.moveTo(rnd() * w, 26); g.lineTo(rnd() * w, h); g.stroke(); }
      for(let i = 0; i < 6; i++){ g.beginPath(); g.moveTo(0, 30 + rnd() * (h - 30)); g.lineTo(w, 30 + rnd() * (h - 30)); g.stroke(); }
      g.strokeStyle = "#e9b43a"; g.lineWidth = 6; g.beginPath(); g.moveTo(40, h - 30); g.lineTo(150, h - 100); g.lineTo(260, h - 110); g.lineTo(330, 90); g.lineTo(450, 70); g.stroke();
      g.fillStyle = "#4fa3ff"; g.beginPath(); g.moveTo(150, h - 82); g.lineTo(163, h - 112); g.lineTo(137, h - 112); g.fill();
      g.fillStyle = "#0a1016"; g.fillRect(0, 0, w, 26); g.fillStyle = "#d7dde2"; g.font = "bold 18px sans-serif"; g.textBaseline = "middle"; g.textAlign = "left"; g.fillText("MAP", 10, 13); g.textAlign = "right"; g.fillText("12:00", w - 10, 13);
      g.fillStyle = "#0a1016"; g.fillRect(0, h - 34, w, 34); g.fillStyle = "#9fb0bd"; g.textAlign = "center"; for(let i = 0; i < 4; i++) g.fillText(["MENU", "AUDIO", "NAVI", "AIR"][i], w * (i + 0.5) / 4, h - 17);
    });
  }
  function mirrorTex(){ return canvasT(128, 32, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#c9d6e0"); gr.addColorStop(0.46, "#dfe6ea"); gr.addColorStop(0.5, "#6d7176"); gr.addColorStop(1, "#4a4c4f"); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(20,24,28,0.5)"; g.fillRect(0, h * 0.5, w, 3); }); }

  /* 計器盤の下の「ダッシュボード」の断面（z, y）。運転席側（pD）は計器の覆いが盛り上がる。p[0] がフロントガラスの根もと、最後が足もと */
  const DASH_D = [[1.06, 0.955], [0.97, 0.985], [0.80, 1.040], [0.66, 1.078], [0.600, 1.092], [0.585, 1.075], [0.66, 1.062], [0.665, 1.055], [0.600, 0.89], [0.62, 0.86], [0.72, 0.72], [0.85, 0.50], [1.02, 0.30]];
  const DASH_P = [[1.06, 0.955], [0.97, 0.975], [0.88, 0.995], [0.80, 1.003], [0.765, 1.000], [0.752, 0.985], [0.752, 0.965], [0.752, 0.94], [0.74, 0.80], [0.72, 0.70], [0.74, 0.58], [0.86, 0.46], [1.02, 0.30]];
  const dashBump = (x, dx) => { x -= dx || 0; return sstep(-0.70, -0.62, x) * (1 - sstep(-0.14, -0.06, x)); };
  const dashCol = (x, tf) => DASH_P.map((p, k) => { const b = dashBump(x, tf.dx), d = DASH_D[k]; return tf([p[0] + (d[0] - p[0]) * b, p[1] + (d[1] - p[1]) * b]); });
  function dashFaceAt(x, y, tf){       // 面の上の点と、運転席の方を向く法線
    const c = dashCol(x, tf);
    for(let k = 7; k < 10; k++){ const a = c[k], b = c[k + 1]; if(y <= a[1] && y >= b[1]){ const t = (a[1] - y) / (a[1] - b[1]), z = a[0] + (b[0] - a[0]) * t, dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy); return { p: [x, y, z], n: [0, -dz / l, dy / l] }; } }
    const a = c[7]; return { p: [x, y, a[0]], n: [0, 0.1, -0.995] };
  }

  function buildInterior(S, P, Bc, ud){
    const g = S.gh, z0 = g.z0 + (S.zo || 0), gz = P.gz, winP = P.winPi, FSn = P.FSn, nF = P.nF, cb = S.cab || {};
    const drvX = cb.x === undefined ? -0.37 : cb.x, zo = S.zo || 0, flY = cb.floorY, dyF = flY === undefined ? 0 : flY - 0.34;
    const bz = z0 - 0.02, by = P.yT(g.z0) - 0.012, kz = cb.kz || 1, kUp = cb.kUp || 1, kDn = cb.kDn || 1, tf = (p) => [bz + (p[0] - 1.06) * kz, by + (p[1] > 0.955 ? (p[1] - 0.955) * kUp : (p[1] - 0.955) * kDn)]; tf.dx = drvX + 0.37;     // 乗用車の断面（根もとが 1.06, 0.955）を、この車のフロントガラスの根もとへ移す
    // ---- 内張りの殻（床・ドア内張り・ピラー・天井）: 窓の所は穴 ----
    { const rings = gz.map((zl) => {
        const h = P.ghH(zl), hbl = h[0][0], yB = h[0][1], hw = P.hw(zl), yfl = flY === undefined ? P.yb(zl) + 0.15 : flY, xd = Math.max(0.25, hbl - 0.055), xo = Math.max(xd, hw * sideProf(0.45) - 0.075), z = zl + zo;
        const L = [[0, yfl], [xo * 0.72, yfl], [xo * 0.92, yfl + 0.06], [xo, yfl + 0.2], [xo, Math.max(yfl + 0.3, yB - 0.2)], [xd + 0.012, yB - 0.06], [xd, yB]].concat(h.slice(1));
        const o = []; for(const p of L) o.push([p[0], p[1], z]); for(let k = L.length - 2; k >= 0; k--) o.push([-L[k][0], L[k][1], z]); return o; });
      const nL = (rings[0].length + 1) / 2, ob = 6;      // ob: 窓の下のふち（belt）の点の番号
      const cls = (i, j) => {
        const jl = j < nL - 1 ? j : (rings[0].length - 2 - j), zm = (gz[i] + gz[i + 1]) / 2;
        if(jl < 2) return "carpet"; if(jl === 2) return "doorLow"; if(jl < ob) return "door";
        const jg = jl - ob, aPil = zm > g.win[0][3] - 0.04 - (g.aPx || 0), bPil = zm > g.win[1 < g.win.length ? 1 : 0][3] - 0.06 && zm < g.win[0][1] + 0.1;
        const inner = aPil ? "pillarA" : (bPil ? "pillarB" : "head");
        if(jg <= nF - 2) return (Q) => clipQuad(Bc, Q, [gz[i], gz[i + 1]], j < nL - 1 ? [FSn[jg], FSn[jg + 1]] : [FSn[jg + 1], FSn[jg]], winP, false, "pillarB");
        if(jg <= nF) return inner;
        if(zm > g.zr1 + 0.03 && zm < g.z0 - 0.03) return null; if(zm < g.zr2 - 0.03 && zm > g.z1 + 0.03) return null;
        return "head"; };
      gridMesh(Bc, rings, cls, false, false, -0.028);
      // 後ろ（リアシートの背・荷室との仕切り）
      const rr0 = rings[0]; const fan = []; for(const p of rr0) fan.push(p); const zE = rr0[0][2] + 0.03;
      for(let k = 1; k < fan.length - 1; k++) Bc.tri("shelf", [fan[0][0], fan[0][1], zE], [fan[k][0], fan[k][1], zE], [fan[k + 1][0], fan[k + 1][1], zE], [0, 0, 1], [0, 0, 1], [0, 0, 1]);
    }
    // ---- ダッシュボード（断面を x に並べた面）----
    { const xw = cb.xw || 0.8, xs = []; for(let i = 0; i <= 38; i++) xs.push(-xw + 2 * xw * i / 38);
      const rings = xs.map((x) => dashCol(x, tf).map((p) => [x, p[1], p[0]]));
      gridMesh(Bc, rings, () => "dash", false, false, 0);
      const e = tf([0.583, 1.086]); Bc.rbox("dashHi", 0.52, 0.012, 0.02, 0.004, drvX + 0.01, e[1] + 0.001, e[0]);
    }
    // ---- 計器盤（面に貼る）----
    const fT = tf(DASH_D[7]), fB = tf(DASH_D[8]), fl = Math.hypot(fT[0] - fB[0], fT[1] - fB[1]);
    let cz = (fT[0] + fB[0]) / 2, cy = (fT[1] + fB[1]) / 2, nz = -(fT[1] - fB[1]) / fl, ny = (fT[0] - fB[0]) / fl;       // 運転席の方を向く法線（z, y）
    if(cb.binn){ const bn = cb.binn;       // バス: ハンドルのすぐ向こうに計器の覆い（ひさし）を立て、その面に計器盤を貼る
      ny = Math.sin(bn.tilt); nz = -Math.cos(bn.tilt); cy = bn.y + ny * bn.d / 2; cz = bn.z + nz * bn.d / 2;
      Bc.rbox("dash", bn.w, bn.h, bn.d, 0.05, drvX, bn.y, bn.z, 0, bn.tilt, 0); Bc.rbox("dashHi", bn.w * 0.9, 0.012, 0.05, 0.004, drvX, bn.y + bn.h / 2 * Math.cos(bn.tilt) + 0.002, bn.z + 0.02 + (bn.h / 2) * Math.sin(bn.tilt), 0, bn.tilt, 0); }
    { const clu = new THREE.Group(); const Xv = new THREE.Vector3(-1, 0, 0), Zv = new THREE.Vector3(0, ny, nz), Yv = new THREE.Vector3().crossVectors(Zv, Xv);
      clu.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xv, Yv, Zv)); clu.position.set(drvX + 0.0, cy, cz); clu.position.addScaledVector(Zv, 0.004);
      const W = 0.5, H = W * 364 / 1024, face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: clusterTex() })); clu.add(face);
      const needleG = (len) => { const sh = new THREE.Shape(); sh.moveTo(-0.0026, -0.012); sh.lineTo(0.0026, -0.012); sh.lineTo(0.0009, len); sh.lineTo(-0.0009, len); sh.closePath(); return new THREE.ShapeGeometry(sh); };
      const nm = new THREE.MeshBasicMaterial({ color: 0xff6a2b, side: THREE.DoubleSide }), cap = new THREE.MeshBasicMaterial({ color: 0x15181b });
      const mkN = (px) => { const n = new THREE.Mesh(needleG(H * 0.43 * 0.86), nm); n.position.set(px, 0, 0.0025); clu.add(n); const c = new THREE.Mesh(new THREE.CircleGeometry(0.0085, 14), cap); c.position.set(px, 0, 0.0035); clu.add(c); return n; };
      ud.nTacho = mkN((0.185 - 0.5) * W); ud.nSpeed = mkN((0.815 - 0.5) * W);
      const midC = document.createElement("canvas"); midC.width = 256; midC.height = 192; const midT = new THREE.CanvasTexture(midC);
      const mid = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.075), new THREE.MeshBasicMaterial({ map: midT })); mid.position.set(0, -0.004, 0.002); clu.add(mid);
      ud.mid = { c: midC, t: midT, key: "" };
      ud.clu = clu; ud.cabItems.push(clu);
    }
    // ---- 中央の画面・空調の吹き出し口 ----
    { const ff = (x, y) => dashFaceAt(x, y, tf), sy = cy - 0.09;
      const f = ff(0.09, by - 0.08), pos = new THREE.Vector3(f.p[0], f.p[1], f.p[2]), nn = new THREE.Vector3(f.n[0], f.n[1], f.n[2]).normalize();
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.135), new THREE.MeshBasicMaterial({ map: screenTex() })); scr.position.copy(pos).addScaledVector(nn, 0.006); scr.lookAt(pos.clone().add(nn)); ud.screen = scr; ud.cabItems.push(scr);
      patch(Bc, "dark", ff, 0.09, by - 0.08, rr(0.155, 0.078, 0.01, 3, 0), 1, 0.003);
      const vent = (x, y, w, h) => { patch(Bc, "dark", ff, x, y, rr(w, h, 0.012, 3, 0), 1, 0.003); for(let k = -1; k <= 1; k++) patch(Bc, "metalS", ff, x, y + k * h * 0.52, rr(w * 0.86, h * 0.06, 0.002, 2, 0), 1, 0.006); };
      vent(0.40, by - 0.04, 0.075, 0.036); vent(0.60, by - 0.04, 0.075, 0.036); vent(0.72, by - 0.05, 0.05, 0.034);
      patch(Bc, "metalS", ff, 0.46, by - 0.093, rr(0.34, 0.004, 0.001, 2, 0), 1, 0.004);
      for(const [x, y, w, h] of [[0.46, by - 0.235, 0.28, 0.0025], [0.46, by - 0.335, 0.28, 0.0025], [0.18, by - 0.285, 0.0025, 0.055], [0.74, by - 0.285, 0.0025, 0.055]]) patch(Bc, "visor", ff, x, y, rr(w, h, 0.001, 2, 0), 1, 0.004);
    }
    // ---- 天井の部品（バックミラー・サンバイザー・ルームランプ）----
    if(!cb.noRvm){ const e = cb.eye || [-0.37, 1.2, -0.12], rz = z0 - 0.72 + (cb.mirDz || 0), ry = P.yR(z0 - zo - 0.72 - (cb.mirDz || 0)) - 0.065;
      const Br = new Builder(); Br.rbox("visor", 0.25, 0.062, 0.03, 0.012, 0, ry, rz, 0, 0, 0); Br.cyl("visor", 0.011, 0.011, 0.04, 8, 0, ry + 0.045, rz + 0.012, "y");
      const rvmG = new THREE.Group(); rvmG.add(new THREE.Mesh(toGeo(Br, PALH), ud.matCab)); ud.rvmG = rvmG; ud.cabItems.push(rvmG);
      const mm = new THREE.Mesh(new THREE.PlaneGeometry(0.228, 0.052), new THREE.MeshBasicMaterial({ map: mirrorTex(), color: 0xffffff })); mm.position.set(0, ry, rz - 0.0165);
      mm.lookAt(new THREE.Vector3(e[0], e[1], e[2])); ud.rvm = mm; rvmG.add(mm);
      const vy = P.yR(g.zr1 + 0.1) - 0.032; for(const sx of [drvX, -drvX]) Bc.rbox("head", 0.3, 0.014, 0.15, 0.006, sx, vy, g.zr1 + 0.1 + zo, 0, 0.5, 0);
      Bc.rbox("dashHi", 0.12, 0.012, 0.07, 0.004, 0, P.yR(g.zr2 + 0.3) - 0.02, g.zr2 + 0.3 + zo);
    }
    // ---- シート・センターコンソール ----
    const seats = cb.seats || [[drvX, -0.28, 0], [-drvX, -0.28, 0], [-0.4, -0.74, 1], [0.4, -0.74, 1]];
    const seat = (x, zc, rear) => { Bc.rbox("seat", 0.5, 0.13, 0.5, 0.05, x, 0.43 + dyF, zc); Bc.rbox("seat", 0.5, rear ? 0.5 : 0.6, 0.13, 0.05, x, (rear ? 0.76 : 0.8) + dyF, zc - 0.27, 0, -0.27);
      Bc.rbox("seat", 0.255, 0.2, 0.1, 0.045, x, (rear ? 1.03 : 1.2) + dyF, zc - (rear ? 0.36 : 0.42), 0, -0.2); Bc.rbox("seatLt", 0.34, 0.5, 0.01, 0.01, x, 0.83 + dyF, zc - 0.205, 0, -0.27);
      Bc.box("rubber", 0.45, 0.04, 0.4, x, 0.3 + dyF, zc); };
    for(const s of seats) seat(s[0], s[1], s[2]);
    const cx = (cb.console === undefined ? 0 : cb.console);
    if(cb.console !== null){ Bc.rbox("dash", 0.26, 0.2, 0.9, 0.05, cx, 0.5 + dyF, 0.27 + (cb.seatDz || 0)); Bc.rbox("dashHi", 0.2, 0.012, 0.3, 0.004, cx, 0.605 + dyF, 0.4 + (cb.seatDz || 0));
      Bc.rbox("rubber", 0.075, 0.03, 0.1, 0.01, cx, 0.62 + dyF, 0.3 + (cb.seatDz || 0)); Bc.cyl("rubber", 0.009, 0.009, 0.1, 8, cx, 0.66 + dyF, 0.285 + (cb.seatDz || 0), "y"); Bc.rbox("rubber", 0.04, 0.055, 0.04, 0.015, cx, 0.72 + dyF, 0.28 + (cb.seatDz || 0)); }
    // ---- ステアリング ----
    { const hubA = cb.hub || [drvX, 0.82, 0.47], hub = new THREE.Vector3(hubA[0], hubA[1], hubA[2]), baseG = new THREE.Group(); baseG.position.copy(hub); baseG.rotation.x = (cb.tilt || 25) * R2D;
      const Bs = new Builder(), Bk = new Builder(), R = cb.R || 0.178, sc = R / 0.178;
      Bs.geo("steer", new THREE.TorusGeometry(R, 0.0175, 10, 40), null);
      const spoke = (ang, len) => { const ca = Math.cos(ang), sa = Math.sin(ang), c = 0.05 * sc + len / 2; Bs.rbox("steer", len, 0.034, 0.014, 0.006, ca * c, sa * c, -0.004, 0, 0, ang); };
      spoke(-12 * R2D, 0.14 * sc); spoke(180 * R2D + 12 * R2D, 0.14 * sc); spoke(-90 * R2D, 0.12 * sc);
      Bs.cyl("steer", 0.06, 0.066, 0.042, 22, 0, 0, -0.014, "z"); Bs.cyl("dashHi", 0.055, 0.055, 0.006, 22, 0, 0, -0.037, "z"); Bs.cyl("metalS", 0.02, 0.02, 0.004, 14, 0, 0, -0.041, "z");
      for(const sx of [-1, 1]) Bs.rbox("dashHi", 0.05, 0.022, 0.006, 0.003, sx * 0.105 * sc, -0.018, -0.012, 0, 0, sx * 12 * R2D);
      Bk.cyl("dash", 0.052, 0.058, 0.22, 20, 0, 0, 0.11, "z");
      Bk.cyl("rubber", 0.009, 0.009, 0.115, 8, -0.1, 0.012, 0.045, "x"); Bk.cyl("rubber", 0.009, 0.009, 0.115, 8, 0.1, 0.012, 0.045, "x");
      const sm = ud.matCab, steer = new THREE.Mesh(toGeo(Bs, PALH), sm), col = new THREE.Mesh(toGeo(Bk, PALH), sm);
      const sg2 = new THREE.Group(); sg2.add(steer); baseG.add(sg2); baseG.add(col); ud.steerG = sg2; ud.cabItems.push(baseG); }
  }

  /* 路線バスの外側の車体: 四角い箱の角をまるめ、車輪のところをアーチ状にくりぬく。
     BoxGeometry と同じ向き・同じ UV・同じ材質の並び [左(+x), 右(-x), 屋根, 下, 前, 後ろ] にしてあるので、箱に貼っていた模様をそのまま使える */
  V.busBody = (o) => {
    o = o || {};
    const W = o.W || 2.49, Lb = o.L || 10.5, y0 = o.y0 !== undefined ? o.y0 : 0.3, y1 = o.y1 || 3.1, H = Lb / 2, hx0 = W / 2;
    const rr = 0.22, rcF = 0.24, rcR = 0.2, crown = 0.03, hA = 0.84, ra = 0.62, depth = 0.62, arches = o.arches || [2.55, -2.75], NA = 6, nl = 4 + NA + 1, nr = 2 * nl - 1;
    const zset = [];
    for(let k = 0; k <= 8; k++){ const a = k / 8 * Math.PI / 2; zset.push(H - rcF + rcF * Math.sin(a), -(H - rcR + rcR * Math.sin(a))); }
    for(let z = -(H - rcR); z < H - rcF; z += 1.0) zset.push(z);
    for(const zc of arches) for(let k = 0; k <= 18; k++) zset.push(zc + ra * Math.cos(k / 18 * Math.PI));
    zset.sort((a, b) => a - b); const zs = [zset[0]]; for(const z of zset) if(z - zs[zs.length - 1] > 0.006) zs.push(z);
    const yb = (z) => { let y = y0; for(const zc of arches){ const dz = z - zc; if(Math.abs(dz) < ra) y = Math.max(y, y0 + hA * Math.sqrt(Math.max(0, 1 - (dz / ra) * (dz / ra)))); } return y; };
    const dEnd = (z) => { if(z > H - rcF) return rcF * (1 - Math.cos(Math.asin(Math.min(1, (z - (H - rcF)) / rcF)))); if(z < -(H - rcR)) return rcR * (1 - Math.cos(Math.asin(Math.min(1, (-z - (H - rcR)) / rcR)))); return 0; };
    const nS = zs.length, dA = zs.map(dEnd), P = [];
    for(let i = 0; i < nS; i++){ const z = zs[i], d = dA[i], hx = hx0 - d, ytop = y1 - d, r = Math.max(0.03, rr * (1 - d / 0.24)), b = yb(z), yw = ytop - r, Lh = [];
      for(let k = 0; k < 4; k++) Lh.push([hx, b + (yw - b) * k / 3]);
      for(let k = 1; k <= NA; k++){ const th = k / NA * Math.PI / 2; Lh.push([hx - r + r * Math.cos(th), yw + r * Math.sin(th)]); }
      Lh.push([0, ytop + crown * Math.max(0, 1 - d / 0.2)]);
      const R = Lh.map((q) => [q[0], q[1], z]); for(let k = nl - 2; k >= 0; k--) R.push([-Lh[k][0], Lh[k][1], z]); P.push(R); }
    // なめらかな法線（隣り合う面の平均）
    const N = P.map((R) => R.map(() => [0, 0, 0])), sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for(let i = 0; i < nS - 1; i++) for(let k = 0; k < nr - 1; k++){ const a = P[i][k], b = P[i][k + 1], c = P[i + 1][k], n = crs(sub(b, a), sub(c, a)), n2 = crs(sub(P[i][k + 1], P[i + 1][k]), sub(P[i + 1][k + 1], P[i + 1][k]));
      for(const [ii, kk] of [[i, k], [i, k + 1], [i + 1, k], [i + 1, k + 1]]) for(let t = 0; t < 3; t++) N[ii][kk][t] += n[t] + n2[t]; }
    for(const R of N) for(const n of R){ const l = Math.hypot(n[0], n[1], n[2]) || 1; n[0] /= l; n[1] /= l; n[2] /= l; }
    const G = [[], [], [], [], [], []], vh = y1 - y0;
    const uvOf = (g, p) => g === 0 ? [(H - p[2]) / Lb, (p[1] - y0) / vh] : g === 1 ? [(p[2] + H) / Lb, (p[1] - y0) / vh] : g === 4 ? [(p[0] + hx0) / W, (p[1] - y0) / vh] : g === 5 ? [(hx0 - p[0]) / W, (p[1] - y0) / vh] : [0, 0];
    const push = (g, pa, pb, pc, na, nb, nc) => {      // 三角形を、法線の向きに合わせた巻き順で入れる
      const fn = crs(sub(pb, pa), sub(pc, pa)), av = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
      if(fn[0] * av[0] + fn[1] * av[1] + fn[2] * av[2] < 0){ [pb, pc] = [pc, pb]; [nb, nc] = [nc, nb]; }
      for(const [pp, nn] of [[pa, na], [pb, nb], [pc, nc]]) G[g].push([pp, nn, uvOf(g, pp)]); };
    for(let i = 0; i < nS - 1; i++){ const straight = dA[i] === 0 && dA[i + 1] === 0, zm = (zs[i] + zs[i + 1]) / 2;
      for(let k = 0; k < nr - 1; k++){ const kk = k < nl - 1 ? k : nr - 2 - k; let g;
        if(kk < 3) g = straight ? (k < nl - 1 ? 0 : 1) : (zm > 0 ? 4 : 5); else g = 2;
        push(g, P[i][k], P[i][k + 1], P[i + 1][k], N[i][k], N[i][k + 1], N[i + 1][k]); push(g, P[i + 1][k], P[i][k + 1], P[i + 1][k + 1], N[i + 1][k], N[i][k + 1], N[i + 1][k + 1]); } }
    // 前後の面（平ら）
    for(const [i, g, sg] of [[nS - 1, 4, 1], [0, 5, -1]]){ const R = P[i], cy = (R[0][1] + R[nl - 1][1]) / 2, c = [0, cy, R[0][2]], nn = [0, 0, sg];
      for(let k = 0; k < nr; k++){ const a = R[k], b = R[(k + 1) % nr]; push(g, c, a, b, nn, nn, nn); } }
    // 車輪のアーチの内側（暗い筒と奥の板）
    for(const zc of arches) for(const sg of [1, -1]){ const pts = []; for(let k = 0; k <= 18; k++){ const ph = k / 18 * Math.PI; pts.push([zc + ra * Math.cos(ph), y0 + hA * Math.sin(ph)]); }
      const xo = sg * hx0, xi = sg * (hx0 - depth);
      for(let k = 0; k < 18; k++){ const a = pts[k], b = pts[k + 1], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l = Math.hypot(zc - m[0], y0 + 0.1 - m[1]) || 1, nn = [0, (y0 + 0.1 - m[1]) / l, (zc - m[0]) / l];
        push(3, [xo, a[1], a[0]], [xi, a[1], a[0]], [xo, b[1], b[0]], nn, nn, nn); push(3, [xi, a[1], a[0]], [xi, b[1], b[0]], [xo, b[1], b[0]], nn, nn, nn); }
      const nd = [sg, 0, 0]; for(let k = 0; k < 18; k++) push(3, [xi, y0, zc], [xi, pts[k][1], pts[k][0]], [xi, pts[k + 1][1], pts[k + 1][0]], nd, nd, nd); }
    const pos = [], nor = [], uv = [], geo = new THREE.BufferGeometry(); let st = 0;
    G.forEach((arr, gi) => { for(const [p, n, u] of arr){ pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); uv.push(u[0], u[1]); } geo.addGroup(st, arr.length, gi); st += arr.length; });
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return geo;
  };

  V.hi = (name, opt) => {
    opt = opt || {};
    const S = SPEC[name], { B, P } = V.build(name, 2, true), g = new THREE.Group(), ud = g.userData; ud.cabItems = [];
    const matBody = opt.mat || V.makeMat(), matGlass = V.makeMat({ glass: true, rainGlass: true }), matCab = V.makeMat({ cabin: true, side: THREE.DoubleSide });
    matCab.userData.U.uCabin.value.set(0.55, 0.95); ud.matBody = matBody; ud.matCab = matCab; ud.matGlass = matGlass;
    if(opt.color) matBody.userData.U.uPaint.value.copy(opt.color);
    ud.setPaint = (c) => matBody.userData.U.uPaint.value.copy(c);
    const body = new THREE.Group(); g.add(body); ud.body = body;
    const bm = new THREE.Mesh(toGeo(B, PALH, null, ["glass"]), matBody); bm.castShadow = true; body.add(bm);
    const gm = new THREE.Mesh(toGeo(B, PALH, ["glass"]), matGlass); gm.renderOrder = 2; body.add(gm);
    // 車内
    const cab = new THREE.Group(); body.add(cab); ud.cab = cab;
    if(S.interior !== false && P){ const Bc = new Builder(); buildInterior(S, P, Bc, ud); const cm = new THREE.Mesh(toGeo(Bc, PALH), matCab); cab.add(cm); for(const it of ud.cabItems) cab.add(it); }
    // 車輪
    ud.wheels = []; const frontZ = S.wheels && S.wheels.zf !== undefined ? S.wheels.zf + (S.zo || 0) : undefined, zo = 0;
    const cache = {};
    for(const w of B.wheels){ const key = [w.r, w.tw, w.sg, w.dual].join(); const geo = cache[key] || (cache[key] = buildWheel(w));
      const steer = new THREE.Group(), spin = new THREE.Group(); steer.position.set(w.sg * (w.xs + 0.02 - w.tw / 2), w.r, w.z + zo);
      const wm = new THREE.Mesh(geo.spin, matBody); wm.castShadow = true; spin.add(wm); steer.add(spin);
      const cp = new THREE.Mesh(geo.calip, matBody); steer.add(cp); g.add(steer);
      ud.wheels.push({ steer, spin, r: w.r, front: frontZ !== undefined && Math.abs(w.z - frontZ) < 1e-6 }); }
    { const e = (S.cab && S.cab.eye) || [-0.37, 1.2, -0.12]; ud.eye = { x: e[0], y: e[1], z: e[2], pitch: (S.cab && S.cab.pitch) || 4 }; }
    // v41.14: ワイパー（フロントガラスの下に 2 本。雨の間は 1.3 秒で 1 往復して、少し休む（周期 2.6 秒）。止まっているときはガラスの下の縁に寄せる）と、ガラスの水滴の面
    const RU = matGlass.userData.RU, rots = [], SW = 1.45, SWP = 1.3, CYC = 2.6;
    if(RU && opt.wipers !== false && S.gh && S.gh.z0 !== undefined && P && P.yR){
      const gh = S.gh, zo = S.zo || 0, zb = gh.z0 - 0.03, zt = gh.zr1 + 0.03, yb = P.yR(zb), yt = P.yR(zt);
      const Av = new THREE.Vector3(1, 0, 0), Bv = new THREE.Vector3(0, yt - yb, zt - zb).normalize(), Nv = new THREE.Vector3().crossVectors(Av, Bv).normalize();
      const Ov = new THREE.Vector3(0, yb, zb + zo), hb = P.ghH(zb)[0][0];
      const WP = [[-0.58 * hb, 0.05, 0.92 * hb], [0.12 * hb, 0.05, 0.84 * hb]];   // 運転席側（右）と中央寄りの 2 本（軸の u: 左が +、v: ガラスの下の縁から上、長さ）
      RU.uWO.value.copy(Ov); RU.uWA.value.copy(Av); RU.uWB.value.copy(Bv); RU.uWN.value.copy(Nv);
      RU.uWP1.value.set(WP[0][0], WP[0][1], WP[0][2], 0); RU.uWP2.value.set(WP[1][0], WP[1][1], WP[1][2], 0); RU.uWS.value.set(SW, SWP, CYC);
      const blackM = new THREE.MeshPhongMaterial({ color: 0x0e0f11, shininess: 25, specular: 0x333333 });
      for(const [u, v, L] of WP){
        const h = new THREE.Group(); h.matrixAutoUpdate = false;
        h.matrix.makeBasis(Av, Bv, Nv).setPosition(Ov.x + Av.x * u + Bv.x * v, Ov.y + Av.y * u + Bv.y * v, Ov.z + Av.z * u + Bv.z * v); h.matrixWorldNeedsUpdate = true;
        const rot = new THREE.Group(); h.add(rot);
        const armG = new THREE.BoxGeometry(L, 0.011, 0.009); armG.translate(L / 2, 0, 0.013);
        const bladeG = new THREE.BoxGeometry(L * 0.8, 0.017, 0.012); bladeG.translate(L * 0.6, 0, 0.007);
        const capG = new THREE.CylinderGeometry(0.014, 0.014, 0.022, 10); capG.rotateX(Math.PI / 2); capG.translate(0, 0, 0.011);
        for(const gg of [armG, bladeG, capG]) rot.add(new THREE.Mesh(gg, blackM));
        body.add(h); rots.push(rot); }
    }
    const rainUp = () => {
      if(!rots.length) return;
      const nowS = performance.now() / 1000, rain = V.rainU.value > 0.5;
      if(rain){
        if(!ud._rain){ ud._rain = true; ud._t0 = nowS; ud._r0 = nowS - (CYC - 1.2); ud._sub = -1; }   // 降り始めて 1.2 秒でまず 1 回払う（それまでは休みの状態から始める）
        const rt = nowS - ud._r0, tm = rt % CYC, sub = tm < SWP / 2 ? 0 : (tm < SWP ? 1 : 2), key = Math.floor(rt / CYC) * 3 + sub;
        RU.uRain.value = 1; RU.uRainT.value = nowS - ud._t0; RU.uWipeT.value = rt;
        const th = tm < SWP ? SW * (0.5 - 0.5 * Math.cos(2 * Math.PI * tm / SWP)) : 0; for(const r of rots) r.rotation.z = th;
        if(key !== ud._sub){ ud._sub = key; if(sub < 2 && V.wipeCb) V.wipeCb(sub === 1); }
      } else if(ud._rain){ ud._rain = false; RU.uRain.value = 0; RU.uWipeT.value = -1; for(const r of rots) r.rotation.z = 0; }
    };
    ud.drive = (v, dt, steer) => { for(const w of ud.wheels){ w.spin.rotation.x += v * dt / w.r; if(w.front) w.steer.rotation.y = steer; } };
    ud.setInside = (inside) => { if(ud.rvmG) ud.rvmG.visible = !inside; };      // 運転席視点では画面上のルームミラー（街側で実際の後方映像を重ねる）を使うので、立体のルームミラーは隠す
    ud.setSky = (c) => { if(ud.rvm) ud.rvm.material.color.copy(c).multiplyScalar(1.05); };
    ud.update = (C) => {
      const kmh = Math.abs(C.v || 0) * 3.6, rpm = C.rpm === undefined ? 800 : C.rpm;
      if(ud.nSpeed){ ud.nSpeed.rotation.z = -(-135 + 270 * Math.min(1.04, kmh / 180)) * R2D; ud.nTacho.rotation.z = -(-135 + 270 * Math.min(1.02, rpm / 8000)) * R2D; }
      if(ud.steerG) ud.steerG.rotation.z = -(C.wheel || 0);
      matBody.userData.U.uBrake.value = (C.brk || 0) > 0.05 ? 1 : 0;
      rainUp();
      if(ud.mid){ const key = (C.gear || "D") + "|" + Math.round(kmh) + "|" + Math.floor((C.odo || 0) / 100); if(key !== ud.mid.key){ ud.mid.key = key; const c = ud.mid.c.getContext("2d");
        c.fillStyle = "#07090b"; c.fillRect(0, 0, 256, 192); c.textAlign = "center"; c.textBaseline = "middle";
        c.fillStyle = C.gear === "R" ? "#ff7a3a" : "#7be08a"; c.font = "bold 74px sans-serif"; c.fillText(C.gear === "R" ? "R" : "D", 128, 58);
        c.fillStyle = "#e8eef2"; c.font = "bold 58px sans-serif"; c.fillText(String(Math.round(kmh)), 128, 122); c.fillStyle = "#8c959c"; c.font = "bold 22px sans-serif"; c.fillText("km/h   " + ((C.odo || 0) / 1000).toFixed(1) + " km", 128, 168);
        ud.mid.t.needsUpdate = true; } }
    };
    ud.update({ v: 0, rpm: 800, gear: "D", wheel: 0, brk: 0, odo: 0 });
    return g;
  };
