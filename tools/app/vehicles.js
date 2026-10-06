/* ---------------- v41.9: 車・トラックの形（曲面の車体）----------------
   以前は箱を組み合わせた形だった。ここでは「側面の輪郭線（ボンネット・屋根・トランク）」「平面の丸み」「断面（肩・ガラス面の傾き）」から
   なめらかな車体を作る（断面を車の前後に並べて面でつなぐ）。AI の車（インスタンス描画。軽い形）と、自分の車（細部まで作る形）で同じ寸法・同じ関数を使う。
   座標: +z 前・+x 左・y 上。原点は車体の中心の真下（地面）。寸法は日本の同クラスの車の公表値に近い（特定の車種そのものではない）。
   AI 用: Veh.ai(name) → BufferGeometry（position, normal, color, aPaint）   自分の車: Veh.hi(name, opt) → THREE.Group */
const Veh = (() => {
  const V = {};
  const M4 = new THREE.Matrix4(), V3 = new THREE.Vector3(), N3 = new THREE.Matrix3();
  /* ---------- 曲線 ---------- */
  function pchip(pts){      // 単調な 3 次補間（行き過ぎない）。pts: [[x,y]...] x の昇順
    const n = pts.length, h = [], d = [], m = new Array(n);
    for(let i = 0; i < n - 1; i++){ h[i] = pts[i + 1][0] - pts[i][0]; d[i] = (pts[i + 1][1] - pts[i][1]) / h[i]; }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for(let i = 1; i < n - 1; i++){ if(d[i - 1] * d[i] <= 0) m[i] = 0; else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); } }
    return (x) => { if(x <= pts[0][0]) return pts[0][1]; if(x >= pts[n - 1][0]) return pts[n - 1][1];
      let i = 0; while(x > pts[i + 1][0]) i++; const t = (x - pts[i][0]) / h[i], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h[i] * m[i + 1]; };
  }
  /* 折れ線の角を半径 r で丸める → 細かい折れ線（x の昇順を保つ。折れ線は x 方向に単調なこと） */
  function fillet(pts, rad, step){
    const out = [pts[0].slice()];
    for(let i = 1; i < pts.length - 1; i++){
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const r = Math.min(rad[i] === undefined ? (rad.d || 0) : rad[i], l1 * 0.48, l2 * 0.48);
      if(r < 1e-4){ out.push(b.slice()); continue; }
      const p0 = [b[0] + (a[0] - b[0]) * r / l1, b[1] + (a[1] - b[1]) * r / l1], p1 = [b[0] + (c[0] - b[0]) * r / l2, b[1] + (c[1] - b[1]) * r / l2];
      const n = Math.max(2, Math.ceil(r * 3.2 / step));
      for(let k = 0; k <= n; k++){ const t = k / n, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * b[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * b[1] + t * t * p1[1]]); }
    }
    out.push(pts[pts.length - 1].slice());
    // 同じ x の点を除く
    const res = [out[0]]; for(let i = 1; i < out.length; i++) if(out[i][0] > res[res.length - 1][0] + 1e-5) res.push(out[i]);
    return res;
  }
  function linear(pts){ const n = pts.length; return (x) => { if(x <= pts[0][0]) return pts[0][1]; if(x >= pts[n - 1][0]) return pts[n - 1][1]; let i = 0; while(x > pts[i + 1][0]) i++; const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t; }; }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------- 部品をためる入れ物 ---------- */
  function Builder(){ this.g = {}; this.wheels = []; this.hi = false; }
  Builder.prototype.grp = function(k){ return this.g[k] || (this.g[k] = { p: [], n: [], u: [] }); };
  Builder.prototype.tri = function(k, a, b, c, na, nb, nc){ const g = this.grp(k); g.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); g.n.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]); };
  // BufferGeometry を行列で変換して入れる
  Builder.prototype.geo = function(k, geom, m){
    const gi = geom.index ? geom.toNonIndexed() : geom; const g = this.grp(k);
    const p = gi.attributes.position.array, n = gi.attributes.normal ? gi.attributes.normal.array : null, uv = gi.attributes.uv ? gi.attributes.uv.array : null;
    if(m){ N3.getNormalMatrix(m); }
    for(let i = 0; i < p.length; i += 3){ V3.set(p[i], p[i + 1], p[i + 2]); if(m) V3.applyMatrix4(m); g.p.push(V3.x, V3.y, V3.z);
      if(n){ V3.set(n[i], n[i + 1], n[i + 2]); if(m) V3.applyMatrix3(N3).normalize(); g.n.push(V3.x, V3.y, V3.z); } else g.n.push(0, 1, 0); }
    if(uv) for(let i = 0; i < uv.length; i++) g.u.push(uv[i]); else for(let i = 0; i < p.length / 3; i++) g.u.push(0, 0);
    if(gi !== geom) gi.dispose(); geom.dispose();
  };
  Builder.prototype.box = function(k, w, h, d, x, y, z, ry, rx, rz){ const g = new THREE.BoxGeometry(w, h, d); M4.makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, "YXZ")); M4.setPosition(x, y, z); this.geo(k, g, M4.clone()); };
  /* 面取りした箱（角が丸い。w×h×d・丸み r・分割 s） */
  function rboxGeo(w, h, d, r, s){
    const g = new THREE.BoxGeometry(w, h, d, s, s, s), p = g.attributes.position, hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
    for(let i = 0; i < p.count; i++){ const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const cx = clamp(x, -hx, hx), cy = clamp(y, -hy, hy), cz = clamp(z, -hz, hz); let dx = x - cx, dy = y - cy, dz = z - cz; const L = Math.hypot(dx, dy, dz) || 1;
      if(L > 1e-6){ p.setXYZ(i, cx + dx / L * r, cy + dy / L * r, cz + dz / L * r); } }
    g.computeVertexNormals(); return g;
  }
  Builder.prototype.rbox = function(k, w, h, d, r, x, y, z, ry, rx, rz){ const g = rboxGeo(w, h, d, r, 3); M4.makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, "YXZ")); M4.setPosition(x, y, z); this.geo(k, g, M4.clone()); };
  Builder.prototype.cyl = function(k, r0, r1, len, seg, x, y, z, axis){   // 軸 axis: "x" | "y" | "z"
    const g = new THREE.CylinderGeometry(r0, r1, len, seg); if(axis === "x") g.rotateZ(Math.PI / 2); else if(axis === "z") g.rotateX(Math.PI / 2); g.translate(x, y, z); this.geo(k, g, null); };

  Builder.prototype.disc = function(k, r, seg, x, y, z, sg, r0){   // x 軸に垂直な円板（r0 があれば輪）。sg=+1 なら +x 向き
    const g = r0 ? new THREE.RingGeometry(r0, r, seg, 1) : new THREE.CircleGeometry(r, seg); g.rotateY(sg > 0 ? Math.PI / 2 : -Math.PI / 2); g.translate(x, y, z); this.geo(k, g, null); };

  /* ---------- 面の格子（rings × cols）から三角形を作る ----------
     P[i][j] = [x,y,z]。i: 車の前後の断面、j: 断面の周り。classify(i, j) → 材質の名前（null なら作らない）。法線は周囲の面の平均 */
  function gridMesh(B, P, classify, closedCols, flip, off){
    const nr = P.length, nc = P[0].length, N = P.map((r) => r.map(() => [0, 0, 0]));
    const at = (i, j) => P[clamp(i, 0, nr - 1)][closedCols ? ((j % nc) + nc) % nc : clamp(j, 0, nc - 1)];
    const quads = nc - (closedCols ? 0 : 1);
    for(let i = 0; i < nr - 1; i++) for(let j = 0; j < quads; j++){
      const a = P[i][j], b = P[i][(j + 1) % nc], c = P[i + 1][(j + 1) % nc], d = P[i + 1][j];
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for(const [ii, jj] of [[i, j], [i, (j + 1) % nc], [i + 1, (j + 1) % nc], [i + 1, j]]){ const n = N[ii][jj]; n[0] += nx; n[1] += ny; n[2] += nz; } }
    for(const r of N) for(const n of r){ const L = Math.hypot(n[0], n[1], n[2]); if(L > 1e-9){ n[0] /= L; n[1] /= L; n[2] /= L; } else { n[0] = n[1] = n[2] = 0; } }
    // 端（面積 0 の列）で法線が定まらない所は隣の断面の法線を使う
    for(let i = 0; i < nr; i++) for(let j = 0; j < nc; j++){ const n = N[i][j]; if(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) < 1e-6){ const o = N[i === 0 ? 1 : i - 1][j]; n[0] = o[0]; n[1] = o[1]; n[2] = o[2]; } }
    if(off){ P = P.map((r, i) => r.map((p, j) => [p[0] + N[i][j][0] * off, p[1] + N[i][j][1] * off, p[2] + N[i][j][2] * off])); }
    if(flip) for(const r of N) for(const n of r){ n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
    for(let i = 0; i < nr - 1; i++) for(let j = 0; j < quads; j++){
      const k = classify(i, j); if(!k) continue; const j1 = (j + 1) % nc;
      const a = P[i][j], b = P[i][j1], c = P[i + 1][j1], d = P[i + 1][j], na = N[i][j], nb = N[i][j1], nc_ = N[i + 1][j1], nd = N[i + 1][j];
      if(typeof k === "function"){ k({ a, b, c, d, na, nb, nc: nc_, nd }); continue; }
      if(flip){ B.tri(k, a, c, b, na, nc_, nb); B.tri(k, a, d, c, na, nd, nc_); } else { B.tri(k, a, b, c, na, nb, nc_); B.tri(k, a, c, d, na, nc_, nd); } }
  }

  /* ---------- 2 次元の凸多角形の切り抜き（窓の形を車体の面にそのまま入れる）---------- */
  function clipEdge(poly, a, b, keep){      // 辺 a→b の左（keep=+1）または右（-1）側を残す（Sutherland–Hodgman）
    const out = [], n = poly.length; if(!n) return out;
    const sd = (p) => keep * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    for(let i = 0; i < n; i++){ const p = poly[i], q = poly[(i + 1) % n], sp = sd(p), sq = sd(q);
      if(sp >= 0) out.push(p);
      if((sp >= 0) !== (sq >= 0)){ const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); } }
    return out;
  }
  const polyArea = (p) => { let s = 0; for(let i = 0; i < p.length; i++){ const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  function emitUV(B, k, Q, poly, flip){      // 四角 Q の中の (u,v) 多角形を三角形にして入れる（格子の三角形 a,b,c と同じ向き）
    if(poly.length < 3 || Math.abs(polyArea(poly)) < 1e-7) return;
    const pt = (u, v) => { const w0 = (1 - u) * (1 - v), w1 = (1 - u) * v, w2 = u * v, w3 = u * (1 - v);
      return [Q.a[0] * w0 + Q.b[0] * w1 + Q.c[0] * w2 + Q.d[0] * w3, Q.a[1] * w0 + Q.b[1] * w1 + Q.c[1] * w2 + Q.d[1] * w3, Q.a[2] * w0 + Q.b[2] * w1 + Q.c[2] * w2 + Q.d[2] * w3]; };
    const nm = (u, v) => { const w0 = (1 - u) * (1 - v), w1 = (1 - u) * v, w2 = u * v, w3 = u * (1 - v);
      const x = Q.na[0] * w0 + Q.nb[0] * w1 + Q.nc[0] * w2 + Q.nd[0] * w3, y = Q.na[1] * w0 + Q.nb[1] * w1 + Q.nc[1] * w2 + Q.nd[1] * w3, z = Q.na[2] * w0 + Q.nb[2] * w1 + Q.nc[2] * w2 + Q.nd[2] * w3, l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const cw = polyArea(poly) < 0;
    const P0 = pt(poly[0][0], poly[0][1]), N0 = nm(poly[0][0], poly[0][1]);
    for(let i = 1; i < poly.length - 1; i++){ const P1 = pt(poly[i][0], poly[i][1]), P2 = pt(poly[i + 1][0], poly[i + 1][1]), N1 = nm(poly[i][0], poly[i][1]), N2 = nm(poly[i + 1][0], poly[i + 1][1]);
      if(cw !== !!flip) B.tri(k, P0, P1, P2, N0, N1, N2); else B.tri(k, P0, P2, P1, N0, N2, N1); }
  }
  /* 格子の四角 Q（z が zr、高さ方向の割合 t が tr の範囲）を、窓の多角形 polys で塗り分ける（残りは paint）。窓の多角形は (z, t) 平面の凸多角形 */
  function clipQuad(B, Q, zr, tr, polys, flip, inner){      // inner: 内側の殻（窓は作らず、残りを inner の材質名で）
    const dz = zr[1] - zr[0], dt = tr[1] - tr[0]; if(Math.abs(dz) < 1e-9 || Math.abs(dt) < 1e-9) return;
    const toUV = (p) => [(p[0] - zr[0]) / dz, (p[1] - tr[0]) / dt];
    let pieces = [[[zr[0], tr[0]], [zr[1], tr[0]], [zr[1], tr[1]], [zr[0], tr[1]]]];
    for(const pl of polys){ const nxt = [], V = pl.pts, n = V.length;
      for(const pc of pieces){ let inside = pc; for(let e = 0; e < n; e++) inside = clipEdge(inside, V[e], V[(e + 1) % n], 1);
        if(inside.length >= 3 && (!inner || pl.k !== "glass")) emitUV(B, inner ? (pl.ik || inner) : pl.k, Q, inside.map(toUV), flip);
        let rest = pc; for(let e = 0; e < n; e++){ const out = clipEdge(rest, V[e], V[(e + 1) % n], -1); if(out.length >= 3) nxt.push(out); rest = clipEdge(rest, V[e], V[(e + 1) % n], 1); if(rest.length < 3) break; } }
      pieces = nxt; }
    for(const pc of pieces) emitUV(B, inner || "paint", Q, pc.map(toUV), flip);
  }
  /* ---------- 材質: 光沢と空の映り込み ----------
     頂点の aPaint が材質の種類: 0 つや消し / 1 塗装（インスタンス色か uPaint が掛かる・つや）/ 2 ガラス・灯火（強く映る）/ 3 メッキ・ホイール
     映り込みの色は、街の半球ライト（空の色・地面の色）から取る → 朝・夕・夜・天気にそのまま追従する（環境マップは使わない） */
  V.lampU = { value: 0.35 };
  V.setNight = (n) => { V.lampU.value = 0.35 + 0.75 * n; };       // 夜は灯火が明るい（街の時間帯から呼ぶ）
  V.makeMat = function(opt){
    opt = opt || {};       // cabin: 車内（直射を弱める）  glass: 窓（外からは暗く・中からは透ける）  side: THREE.DoubleSide など
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0xffffff, shininess: opt.shininess || 70 });
    mat.defines = {};
    if(opt.cabin) mat.defines.CABIN = "";
    if(opt.side) mat.side = opt.side;
    if(opt.glass){ mat.defines.GLASS = ""; mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; }
    const U = { uPaint: { value: new THREE.Color(1, 1, 1) }, uLamp: V.lampU, uBrake: { value: 0 }, uCabin: { value: new THREE.Vector2(1, 1) } };
    mat.userData.U = U;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uPaint = U.uPaint; sh.uniforms.uLamp = U.uLamp; sh.uniforms.uBrake = U.uBrake; sh.uniforms.uCabin = U.uCabin;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aPaint;\nattribute float aBrake;\nvarying float vK;\nvarying float vBr;\nuniform vec3 uPaint;\nuniform float uBrake;")
        .replace("#include <color_vertex>", `vK = aPaint; vBr = aBrake + uBrake;
          vColor = vec3(1.0);
          #ifdef USE_COLOR
            vColor.xyz *= color.xyz;
          #endif
          float isP = step(0.5, aPaint) * (1.0 - step(1.5, aPaint));
          #ifdef USE_INSTANCING_COLOR
            vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, isP);
          #else
            vColor.xyz *= mix(vec3(1.0), uPaint, isP);
          #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vK;\nvarying float vBr;\nuniform float uLamp;\nuniform vec2 uCabin;")
        .replace("#include <specularmap_fragment>", "float kc = floor(vK + 0.5); float specularStrength = kc < 0.5 ? 0.04 : (kc < 1.5 ? 0.8 : (kc < 3.5 ? 1.0 : (kc < 4.5 ? 0.5 : (kc < 5.5 ? 0.25 : (kc < 6.5 ? 0.5 : 0.16)))));")
        .replace("#include <aomap_fragment>", `#include <aomap_fragment>
          #ifdef CABIN
            { vec3 ambS = vec3(0.7), ambG = vec3(0.3); float upn = 0.0;
              #if NUM_HEMI_LIGHTS > 0
                ambS = hemisphereLights[0].skyColor; ambG = hemisphereLights[0].groundColor; upn = dot(normal, hemisphereLights[0].direction);
              #endif
              vec3 amb = 0.5 * (ambS + ambG) * 1.15 + 0.18 * (ambS - ambG) * upn;
              reflectedLight.indirectDiffuse = diffuseColor.rgb * amb * uCabin.y;
              reflectedLight.directDiffuse *= uCabin.x; reflectedLight.directSpecular *= uCabin.x; }
          #endif`)
        .replace("#include <envmap_fragment>", `{
          vec3 vd = normalize(vViewPosition);
          float ndv = clamp(dot(normal, vd), 0.0, 1.0);
          vec3 rw = inverseTransformDirection(reflect(-vd, normal), viewMatrix);
          #if NUM_HEMI_LIGHTS > 0
            vec3 skyC = hemisphereLights[0].skyColor; vec3 grdC = hemisphereLights[0].groundColor;
          #else
            vec3 skyC = vec3(0.7); vec3 grdC = vec3(0.2);
          #endif
          float up = smoothstep(-0.10, 0.32, rw.y);
          vec3 env = mix(grdC * 0.7, skyC * 1.1, up) + skyC * 0.30 * exp(-pow(rw.y * 5.0, 2.0));
          float fr = pow(1.0 - ndv, 4.0);
          float k = kc < 0.5 ? 0.0 : (kc < 1.5 ? 0.07 + 0.38 * fr : (kc < 2.5 ? 0.14 + 0.55 * fr : (kc < 3.5 ? 0.42 : (kc < 4.5 ? 0.10 + 0.25 * fr : (kc < 5.5 ? 0.06 : (kc < 6.5 ? 0.10 + 0.25 * fr : 0.02 + 0.07 * fr))))));
          outgoingLight += env * k;
          if(kc > 3.5 && kc < 4.5) outgoingLight += diffuseColor.rgb * uLamp;
          if(kc > 5.5 && kc < 6.5) outgoingLight += diffuseColor.rgb * uLamp * 0.8 + vec3(1.0, 0.10, 0.06) * min(vBr, 1.0) * 1.5;
          #ifdef GLASS
            diffuseColor.a = gl_FrontFacing ? clamp(0.78 + 0.2 * fr, 0.0, 1.0) : 0.10;
          #endif
        }`);
    };
    return mat;
  };

  /* 平らな四角（p0..p3 を順に）。n の向きを表にする */
  Builder.prototype.quadN = function(k, a, b, c, d, n){
    const e = (p, q2, r2) => { const ux = q2[0] - p[0], uy = q2[1] - p[1], uz = q2[2] - p[2], vx = r2[0] - p[0], vy = r2[1] - p[1], vz = r2[2] - p[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if(cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.tri(k, p, q2, r2, n, n, n); else this.tri(k, p, r2, q2, n, n, n); };
    e(a, b, c); e(a, c, d); };

  /* ---------- 車種の寸法表 ----------
     L 全長・W 全幅・rcF/rcR 前後の角の丸みの長さ（平面形）・nF/nR その角の「四角さ」（2 で楕円、大きいほど四角）
     yb 車体の下面の高さ  top 車体の肩の高さの線（後ろ → 前の [z, y]）・topR 角の丸み（点の番号 → 半径）
     gh ガラス部分: z1 後ろ窓の下端・z0 前窓の下端・zr2/zr1 屋根の後ろ端/前端・yRoof 屋根の高さ・tumble 窓が上で内側に寄る量・win 窓の位置
     fx 灯火・グリル・ナンバー（at: F 前 / R 後ろ、x y 中心、w h 半分の大きさ、sh ななめ、m 左右対称） */
  const SPEC = {
    sedan: { L: 4.6, W: 1.76, rcF: 0.62, rcR: 0.55, nF: 3.0, nR: 2.8, trimFr: 0.2,
      yb: [[-2.3, 0.3], [-1.95, 0.22], [-1.4, 0.19], [1.4, 0.19], [1.95, 0.22], [2.3, 0.3]],
      top: [[-2.3, 0.88], [-2.18, 0.985], [-1.95, 0.99], [-1.5, 0.99], [-1.0, 0.96], [0.9, 0.95], [1.1, 0.97], [2.05, 0.85], [2.25, 0.79], [2.3, 0.72]], topR: { 1: 0.1, 2: 0.3, 3: 0.4, 6: 0.3, 7: 0.14, 8: 0.1 },
      crown: 0.04, wheels: { zf: 1.38, zr: -1.34, r: 0.32, tw: 0.205 },
      gh: { z1: -1.45, zr2: -0.72, zr1: 0.2, z0: 1.08, yRoof: 1.455, roofR: { 1: 0.5, 2: 0.55 }, tumble: 0.2, taperF: 0.9, taperR: 0.86, crownR: 0.03,
            win: [[0.04, 0.1, 0.86, 0.5], [-1.08, -0.8, -0.08, -0.14]], seams: [0.9, -0.04, -0.98], handles: [0.32, -0.62] },
      fx: [ { at: "F", k: "lamp", x: 0.62, y: 0.66, w: 0.21, h: 0.055, r: 0.025, sh: 0.7, m: 1 },
            { at: "F", k: "dark", x: 0, y: 0.63, w: 0.3, h: 0.05, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.46, w: 0.165, h: 0.083, r: 0.008 },
            { at: "F", k: "dark", x: 0.56, y: 0.4, w: 0.14, h: 0.03, r: 0.012, m: 1 },
            { at: "R", k: "tail", x: 0.6, y: 0.8, w: 0.25, h: 0.06, r: 0.02, sh: -0.6, m: 1 },
            { at: "R", k: "plate", x: 0, y: 0.6, w: 0.165, h: 0.083, r: 0.008 } ] },

    kei: { L: 3.4, W: 1.48, rcF: 0.45, rcR: 0.4, nF: 3, nR: 3, endF: 0.6, endR: 0.7, trimFr: 0.2, kei: 1,
      yb: [[-1.7, 0.34], [-1.35, 0.22], [-1.0, 0.19], [1.0, 0.19], [1.35, 0.22], [1.7, 0.34]],
      top: [[-1.7, 1.0], [-1.62, 1.04], [-1.4, 1.04], [-0.5, 1.0], [0.7, 0.96], [0.9, 0.98], [1.5, 0.9], [1.66, 0.84], [1.7, 0.76]], topR: { 1: 0.05, 2: 0.2, 4: 0.2, 5: 0.3, 6: 0.15, 7: 0.08 },
      crown: 0.03, wheels: { zf: 1.0, zr: -1.0, r: 0.28, tw: 0.165 },
      gh: { z1: -1.62, zr2: -1.52, zr1: 0.42, z0: 0.95, yRoof: 1.78, roofR: { 1: 0.18, 2: 0.25 }, tumble: 0.1, taperF: 0.95, taperR: 0.97, crownR: 0.02,
            win: [[0.06, 0.08, 0.84, 0.54], [-1.14, -1.1, -0.1, -0.1], [-1.5, -1.45, -1.2, -1.18]], seams: [0.88, -0.03, -1.17], handles: [0.3, -0.55] },
      fx: [ { at: "F", k: "lamp", x: 0.5, y: 0.7, w: 0.15, h: 0.075, r: 0.03, sh: 0.3, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.64, w: 0.3, h: 0.055, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.45, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.6, y: 0.85, w: 0.07, h: 0.17, r: 0.03, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.55, w: 0.165, h: 0.083, r: 0.008 } ] },
    kei2: { L: 3.4, W: 1.48, rcF: 0.45, rcR: 0.4, nF: 3, nR: 3, endF: 0.6, endR: 0.7, trimFr: 0.2, kei: 1,
      yb: [[-1.7, 0.32], [-1.35, 0.21], [-1.0, 0.18], [1.0, 0.18], [1.35, 0.21], [1.7, 0.32]],
      top: [[-1.7, 0.86], [-1.62, 0.93], [-1.4, 0.95], [-0.5, 0.93], [0.7, 0.9], [0.9, 0.92], [1.5, 0.82], [1.66, 0.76], [1.7, 0.7]], topR: { 1: 0.05, 2: 0.2, 4: 0.2, 5: 0.3, 6: 0.15, 7: 0.08 },
      crown: 0.035, wheels: { zf: 1.0, zr: -1.0, r: 0.28, tw: 0.165 },
      gh: { z1: -1.5, zr2: -1.12, zr1: 0.35, z0: 0.95, yRoof: 1.5, roofR: { 1: 0.4, 2: 0.4 }, tumble: 0.14, taperF: 0.93, taperR: 0.9, crownR: 0.03,
            win: [[0.06, 0.1, 0.82, 0.46], [-1.1, -0.9, -0.1, -0.12]], seams: [0.88, -0.03, -1.06], handles: [0.3, -0.5] },
      fx: [ { at: "F", k: "lamp", x: 0.5, y: 0.66, w: 0.15, h: 0.06, r: 0.025, sh: 0.6, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.6, w: 0.28, h: 0.045, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.45, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.58, y: 0.8, w: 0.09, h: 0.1, r: 0.03, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.55, w: 0.165, h: 0.083, r: 0.008 } ] },
    minivan: { L: 4.7, W: 1.72, rcF: 0.55, rcR: 0.45, nF: 3, nR: 3.2, endF: 0.6, endR: 0.75, trimFr: 0.2,
      yb: [[-2.35, 0.34], [-1.95, 0.23], [-1.5, 0.2], [1.5, 0.2], [2.0, 0.23], [2.35, 0.34]],
      top: [[-2.35, 1.0], [-2.28, 1.08], [-2.0, 1.1], [-0.8, 1.08], [0.9, 1.04], [1.3, 1.08], [2.1, 0.88], [2.3, 0.8], [2.35, 0.72]], topR: { 1: 0.06, 2: 0.25, 4: 0.2, 5: 0.3, 6: 0.15, 7: 0.1 },
      crown: 0.035, wheels: { zf: 1.5, zr: -1.4, r: 0.31, tw: 0.195 },
      gh: { z1: -2.28, zr2: -2.05, zr1: 0.12, z0: 1.25, yRoof: 1.85, roofR: { 1: 0.3, 2: 0.45 }, tumble: 0.12, taperF: 0.9, taperR: 0.95, crownR: 0.02,
            win: [[0.1, 0.2, 1.0, 0.52], [-0.95, -0.85, -0.02, -0.05], [-2.0, -1.9, -1.05, -1.0]], seams: [1.04, -0.02, -1.0], handles: [0.5, -0.5] },
      fx: [ { at: "F", k: "lamp", x: 0.6, y: 0.76, w: 0.22, h: 0.065, r: 0.025, sh: 0.6, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.7, w: 0.34, h: 0.06, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.48, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.66, y: 0.98, w: 0.07, h: 0.24, r: 0.03, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.62, w: 0.165, h: 0.083, r: 0.008 } ] },
    suv: { L: 4.6, W: 1.84, rcF: 0.6, rcR: 0.5, nF: 3, nR: 3, endF: 0.6, endR: 0.7, trimFr: 0.22,
      yb: [[-2.3, 0.42], [-1.9, 0.28], [-1.5, 0.22], [1.5, 0.22], [1.95, 0.26], [2.3, 0.4]],
      top: [[-2.3, 1.12], [-2.22, 1.18], [-1.9, 1.18], [-0.5, 1.1], [0.8, 1.06], [1.1, 1.08], [2.0, 0.98], [2.25, 0.92], [2.3, 0.84]], topR: { 1: 0.06, 2: 0.25, 4: 0.2, 5: 0.3, 6: 0.2, 7: 0.1 },
      crown: 0.04, wheels: { zf: 1.4, zr: -1.4, r: 0.37, tw: 0.225 },
      gh: { z1: -2.2, zr2: -1.8, zr1: 0.3, z0: 1.18, yRoof: 1.68, roofR: { 1: 0.3, 2: 0.4 }, tumble: 0.15, taperF: 0.92, taperR: 0.94, crownR: 0.03,
            win: [[0.04, 0.1, 0.9, 0.5], [-1.3, -1.1, -0.08, -0.14], [-2.0, -1.8, -1.35, -1.22]], seams: [0.92, -0.04, -1.34], handles: [0.35, -0.7] },
      fx: [ { at: "F", k: "lamp", x: 0.65, y: 0.86, w: 0.22, h: 0.07, r: 0.025, sh: 0.5, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.8, w: 0.38, h: 0.08, r: 0.02 }, { at: "F", k: "dark", x: 0, y: 0.52, w: 0.5, h: 0.05, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.68, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.68, y: 1.0, w: 0.08, h: 0.2, r: 0.03, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.78, w: 0.165, h: 0.083, r: 0.008 } ] },
    van: { L: 4.7, W: 1.7, rcF: 0.45, rcR: 0.35, nF: 3.2, nR: 3.4, endF: 0.7, endR: 0.85, trimFr: 0.2,
      yb: [[-2.35, 0.4], [-1.95, 0.26], [-1.5, 0.22], [1.2, 0.22], [1.8, 0.26], [2.35, 0.38]],
      top: [[-2.35, 1.12], [-2.3, 1.2], [-2.0, 1.22], [-0.8, 1.2], [1.3, 1.14], [1.7, 1.1], [2.3, 0.98], [2.35, 0.9]], topR: { 1: 0.05, 2: 0.2, 4: 0.3, 5: 0.25, 6: 0.1 },
      crown: 0.03, wheels: { zf: 1.45, zr: -1.2, r: 0.33, tw: 0.185 },
      gh: { z1: -2.3, zr2: -2.22, zr1: 1.1, z0: 1.72, yRoof: 1.95, roofR: { 1: 0.2, 2: 0.1 }, tumble: 0.1, taperF: 0.94, taperR: 0.98, crownR: 0.02,
            win: [[1.02, 1.08, 1.68, 1.38], [-0.1, -0.1, 0.84, 0.84]], seams: [1.7, 0.94, -0.26], handles: [1.35, 0.45] },
      fx: [ { at: "F", k: "lamp", x: 0.56, y: 0.74, w: 0.17, h: 0.075, r: 0.02, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.66, w: 0.4, h: 0.09, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.48, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.68, y: 1.0, w: 0.05, h: 0.2, r: 0.02, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.7, w: 0.165, h: 0.083, r: 0.008 } ] },
    taxi: { L: 4.4, W: 1.7, rcF: 0.5, rcR: 0.45, nF: 3, nR: 3, endF: 0.6, endR: 0.7, trimFr: 0.2,
      yb: [[-2.2, 0.34], [-1.8, 0.23], [-1.4, 0.2], [1.4, 0.2], [1.8, 0.23], [2.2, 0.34]],
      top: [[-2.2, 0.98], [-2.12, 1.04], [-1.8, 1.06], [-0.6, 1.04], [0.85, 1.0], [1.15, 1.03], [2.0, 0.86], [2.17, 0.8], [2.2, 0.72]], topR: { 1: 0.06, 2: 0.25, 4: 0.2, 5: 0.3, 6: 0.15, 7: 0.1 },
      crown: 0.035, wheels: { zf: 1.35, zr: -1.3, r: 0.31, tw: 0.195 },
      gh: { z1: -2.1, zr2: -1.8, zr1: 0.18, z0: 1.05, yRoof: 1.74, roofR: { 1: 0.3, 2: 0.4 }, tumble: 0.15, taperF: 0.92, taperR: 0.92, crownR: 0.03,
            win: [[0.1, 0.15, 0.9, 0.5], [-1.15, -1.0, -0.05, -0.1]], seams: [0.95, -0.03, -1.18], handles: [0.4, -0.6] },
      fx: [ { at: "F", k: "lamp", x: 0.58, y: 0.68, w: 0.2, h: 0.06, r: 0.025, sh: 0.6, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.64, w: 0.3, h: 0.05, r: 0.02 },
            { at: "F", k: "plate", x: 0, y: 0.46, w: 0.165, h: 0.083, r: 0.008 },
            { at: "R", k: "tail", x: 0.62, y: 0.84, w: 0.2, h: 0.06, r: 0.02, sh: -0.6, m: 1 }, { at: "R", k: "plate", x: 0, y: 0.62, w: 0.165, h: 0.083, r: 0.008 } ],
      extra: (B, q) => { B.rbox("white", 0.5, 0.18, 0.26, 0.05, 0, 1.84, -0.1); } },

    keitruck: { L: 1.7, zo: 0.85, W: 1.48, rcF: 0.28, rcR: 0.08, nF: 3, nR: 3, endF: 0.72, endR: 1.0, trimFr: 0.2, kei: 1,
      yb: [[-0.85, 0.34], [-0.4, 0.3], [0.4, 0.3], [0.85, 0.34]],
      top: [[-0.85, 1.0], [0.0, 1.02], [0.8, 1.0], [0.85, 0.94]], topR: { 1: 0.2, 2: 0.05 },
      crown: 0.03, wheels: { zf: 0.15, r: 0.27, tw: 0.165 },
      gh: { z1: -0.8, zr2: -0.75, zr1: 0.42, z0: 0.8, yRoof: 1.75, roofR: { 1: 0.12, 2: 0.15 }, tumble: 0.1, taperF: 0.95, taperR: 1.0, crownR: 0.02,
            win: [[-0.5, -0.45, 0.7, 0.46]], seams: [0.76, -0.58], handles: [0.3] },
      mir: { z: 0.62, y: 1.2, dx: 0.2, big: 1 },
      fx: [ { at: "F", k: "lamp", x: 0.5, y: 0.7, w: 0.12, h: 0.07, r: 0.025, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.62, w: 0.25, h: 0.08, r: 0.02 }, { at: "F", k: "plate", x: 0, y: 0.43, w: 0.165, h: 0.083, r: 0.008 } ],
      extra: (B, q) => {
        const xs = 0.74; for(const sg of [1, -1]) wheelAt(B, q, -0.95, xs, 0.27, 0.165, sg, false);
        B.box("paint", 1.46, 0.08, 1.7, 0, 0.74, -0.87);                                   // 荷台の床
        for(const s of [1, -1]) B.box("paint", 0.04, 0.3, 1.7, s * 0.72, 0.93, -0.87);       // 側のあおり
        B.box("paint", 1.46, 0.3, 0.04, 0, 0.93, -1.69);                                   // あおり（後ろ）
        B.box("gray", 1.44, 0.34, 0.05, 0, 0.95, -0.03);                                   // 前のあおり（アオリ板）
        B.box("trim", 1.2, 0.22, 1.6, 0, 0.58, -0.9);                                      // 荷台の下（フレーム）
        B.box("dark", 1.4, 0.08, 0.08, 0, 0.44, -1.72);
        for(const s of [1, -1]) B.box("tail", 0.1, 0.16, 0.03, s * 0.64, 0.7, -1.7);
        B.box("plateK", 0.33, 0.17, 0.02, 0, 0.56, -1.72); } },
    truck: { L: 1.7, zo: 2.25, W: 1.9, rcF: 0.3, rcR: 0.08, nF: 3, nR: 3, endF: 0.75, endR: 1.0, trimFr: 0.12,
      yb: [[-0.85, 0.56], [0, 0.5], [0.85, 0.46]],
      top: [[-0.85, 1.35], [0.0, 1.35], [0.8, 1.33], [0.85, 1.28]], topR: { 1: 0.2, 2: 0.05 },
      crown: 0.03, wheels: { zf: 0.3, r: 0.38, tw: 0.205 },
      gh: { z1: -0.82, zr2: -0.78, zr1: 0.4, z0: 0.8, yRoof: 2.12, roofR: { 1: 0.1, 2: 0.12 }, tumble: 0.1, taperF: 0.96, taperR: 1.0, crownR: 0.02,
            win: [[-0.5, -0.45, 0.72, 0.46]], seams: [0.78, -0.58], handles: [0.3] },
      mir: { z: 0.66, y: 1.7, dx: 0.24, big: 1 },
      fx: [ { at: "F", k: "lamp", x: 0.68, y: 0.84, w: 0.16, h: 0.08, r: 0.025, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.86, w: 0.46, h: 0.17, r: 0.02 }, { at: "F", k: "plate", x: 0, y: 0.62, w: 0.165, h: 0.083, r: 0.008 } ],
      extra: (B, q) => {
        const xs = 0.95; for(const sg of [1, -1]) wheelAt(B, q, -1.95, xs, 0.38, 0.205, sg, true);
        B.rbox("box", 1.86, 2.05, 4.45, 0.05, 0, 1.98, -0.9);                              // 荷箱（アルミ）
        B.box("blue", 1.875, 0.22, 4.4, 0, 1.45, -0.9);                                    // 荷箱の帯
        B.box("trim", 1.0, 0.26, 5.6, 0, 0.62, -0.4);                                      // フレーム
        B.box("dark", 1.8, 0.14, 0.12, 0, 0.5, -3.12);                                     // 後ろのバンパー
        for(const s of [1, -1]) B.box("tail", 0.12, 0.2, 0.03, s * 0.82, 0.8, -3.12);
        B.box("plate", 0.33, 0.17, 0.02, 0, 0.78, -3.13);
        B.box("dark", 0.012, 1.9, 0.02, 0, 1.98, -3.125);                                  // 観音開きの扉の合わせ目
        for(const s of [1, -1]) B.box("dark", 0.02, 1.9, 0.012, s * 0.0, 1.98, -3.125); } },
    truck4: { L: 2.0, zo: 3.2, W: 2.2, rcF: 0.32, rcR: 0.08, nF: 3, nR: 3, endF: 0.78, endR: 1.0, trimFr: 0.12,
      yb: [[-1, 0.7], [0, 0.62], [1, 0.56]],
      top: [[-1, 1.5], [0.0, 1.5], [0.95, 1.48], [1, 1.42]], topR: { 1: 0.2, 2: 0.05 },
      crown: 0.03, wheels: { zf: 0.1, r: 0.45, tw: 0.235 },
      gh: { z1: -0.96, zr2: -0.92, zr1: 0.5, z0: 0.94, yRoof: 2.4, roofR: { 1: 0.1, 2: 0.12 }, tumble: 0.1, taperF: 0.96, taperR: 1.0, crownR: 0.02,
            win: [[-0.55, -0.5, 0.8, 0.52]], seams: [0.86, -0.64], handles: [0.3] },
      mir: { z: 0.8, y: 1.9, dx: 0.28, big: 1 },
      fx: [ { at: "F", k: "lamp", x: 0.78, y: 0.95, w: 0.17, h: 0.09, r: 0.025, m: 1 }, { at: "F", k: "dark", x: 0, y: 0.96, w: 0.5, h: 0.2, r: 0.02 }, { at: "F", k: "plate", x: 0, y: 0.7, w: 0.165, h: 0.083, r: 0.008 } ],
      extra: (B, q) => {
        const xs = 1.09; for(const sg of [1, -1]) wheelAt(B, q, -2.35, xs, 0.45, 0.235, sg, true);
        B.rbox("box", 2.14, 2.4, 6.4, 0.06, 0, 2.3, -1.0);
        B.box("blue", 2.155, 0.26, 6.35, 0, 1.7, -1.0);
        B.box("trim", 1.1, 0.3, 7.6, 0, 0.72, -0.4);
        B.box("dark", 2.0, 0.16, 0.14, 0, 0.58, -4.22);
        for(const s of [1, -1]) B.box("tail", 0.14, 0.22, 0.03, s * 0.95, 0.95, -4.22);
        B.box("plate", 0.33, 0.17, 0.02, 0, 0.9, -4.23);
        B.box("dark", 0.012, 2.2, 0.02, 0, 2.3, -4.205); } },

    // 自分で運転する 2t トラックのキャブ・フレーム・車輪・灯火（荷箱は街のプログラムが模様つきで別に作る）。前軸 z=1.45・後軸 z=-1.9（軸距 3.35m）・全幅 1.88m
    truckP: { L: 1.7, zo: 1.95, W: 1.88, rcF: 0.3, rcR: 0.08, nF: 3, nR: 3, endF: 0.75, endR: 1.0, trimFr: 0.12, noBox: 1,
      yb: [[-0.85, 0.56], [0, 0.5], [0.85, 0.46]],
      top: [[-0.85, 1.5], [0.0, 1.5], [0.8, 1.48], [0.85, 1.42]], topR: { 1: 0.2, 2: 0.05 },
      crown: 0.03, wheels: { zf: -0.5, r: 0.42, tw: 0.235 },
      gh: { z1: -0.82, zr2: -0.78, zr1: 0.4, z0: 0.8, aPx: 0.26, yRoof: 2.45, roofR: { 1: 0.1, 2: 0.12 }, tumble: 0.1, taperF: 0.96, taperR: 1.0, crownR: 0.02,
            win: [[-0.5, -0.45, 0.76, 0.66]], seams: [0.78, -0.58], handles: [0.3] },
      mir: { z: 0.5, y: 1.95, dx: 0.24, big: 1 },
      cab: { x: -0.45, eye: [-0.45, 1.98, 1.55], hub: [-0.45, 1.7, 2.03], tilt: 40, R: 0.19, floorY: 0.95, seats: [[-0.45, 1.65, 0], [0.45, 1.65, 0]], seatDz: 1.98, xw: 0.9, kz: 1.15, kUp: 2.4, kDn: 1.4, noRvm: 1, pitch: 12 },
      fx: [ { at: "F", k: "lamp", x: 0.68, y: 1.0, w: 0.16, h: 0.08, r: 0.025, m: 1 }, { at: "F", k: "dark", x: 0, y: 1.0, w: 0.46, h: 0.17, r: 0.02 }, { at: "F", k: "plate", x: 0, y: 0.68, w: 0.165, h: 0.083, r: 0.008 } ],
      extra: (B, q) => {
        const xs = 0.94; for(const sg of [1, -1]) wheelAt(B, q, -1.9, xs, 0.42, 0.235, sg, true);
        B.box("trim", 1.0, 0.26, 5.5, 0, 0.7, -0.3);                                       // フレーム
        B.box("dark", 1.8, 0.14, 0.12, 0, 0.56, -3.12);                                    // 後ろのバンパー
        for(const s of [1, -1]) B.box("tail", 0.12, 0.2, 0.03, s * 0.82, 0.82, -3.13);
        B.box("plate", 0.33, 0.17, 0.02, 0, 0.78, -3.14); } },
    // 自分で運転する路線バスの運転席まわり（前の 3.25m）と車輪。外観の車体（模様つき）は街のプログラムが別に作る。全長 10.5m・全幅 2.49m・前軸 z=2.55・後軸 z=-2.75
    busP: { L: 3.25, zo: 3.625, W: 2.49, rcF: 0.3, rcR: 0.08, nF: 3, nR: 3, endF: 0.9, endR: 1.0, trimFr: 0.12, noBox: 1,
      yb: [[-1.6, 0.5], [0, 0.5], [1.6, 0.5]],
      top: [[-1.6, 1.15], [0.0, 1.15], [1.5, 1.28], [1.62, 1.22]], topR: { 1: 0.2, 2: 0.05 },
      crown: 0.02, wheels: { zf: -1.075, r: 0.52, tw: 0.275 },
      gh: { z1: -1.55, zr2: -1.5, zr1: 1.22, z0: 1.52, aPx: 0.5, rl1: 0.985, rl2: 0.95, rl3: 0.75, yRoof: 3.05, roofR: { 1: 0.1, 2: 0.12 }, tumble: 0.08, taperF: 0.97, taperR: 1.0, crownR: 0.02,
            win: [[-1.4, -1.35, 1.50, 1.36]], seams: [1.4, -1.2], handles: [] },
      mir: { z: 1.2, y: 2.1, dx: 0.3, big: 1 },
      cab: { x: -0.72, eye: [-0.72, 1.96, 4.2], hub: [-0.72, 1.58, 4.58], tilt: 58, R: 0.2, floorY: 0.9, seats: [[-0.72, 4.03, 0]], seatDz: 3.6, xw: 1.1, kz: 1.3, kUp: 1.6, kDn: 1.1, noRvm: 1, console: null, pitch: 12, binn: { y: 1.42, z: 4.98, w: 0.72, h: 0.3, d: 0.36, tilt: 0.5 } },
      fx: [],
      extra: (B, q) => {
        const xs = 1.245; for(const sg of [1, -1]) wheelAt(B, q, -2.75, xs, 0.52, 0.275, sg, true);
        for(const z of [2.55, -2.75]) B.cyl("dark", 0.09, 0.09, 2.0, 8, 0, 0.52, z, "x"); } },
    bus: { custom: (B, q) => {
      const W = 2.49, L = 10.5, hx = W / 2 - 0.004, X = hx + 0.004;
      B.rbox("paint", W, 2.55, L, 0.2, 0, 1.85, 0);                                           // 車体
      B.box("trim", 2.42, 0.34, L - 0.3, 0, 0.45, 0); B.box("under", 2.2, 0.1, L - 0.3, 0, 0.3, 0);       // 下まわり
      B.box("blue", W + 0.014, 0.22, L - 0.5, 0, 1.2, 0); B.box("blue", W + 0.014, 0.1, L - 0.5, 0, 1.0, 0);   // 帯（仮定の共通色）
      // 側面の窓: 左側（+x）は出入口の所をあける
      const doors = [[3.35, 4.55], [-0.35, 0.95]];
      const panes = (sg) => { const zs = []; if(q === 0){ zs.push([-4.9, 3.0]); } else for(let z = -4.9; z < 3.0; z += 1.14) zs.push([z, Math.min(3.0, z + 1.0)]);
        for(const [a, b] of zs){ if(sg > 0 && q > 0 && a < 0.95 && b > -0.35) continue; B.box("glass", 0.03, 0.95, b - a, sg * (hx + 0.012), 2.27, (a + b) / 2); } };
      panes(1); panes(-1);
      if(q === 0){ B.box("glass", 0.03, 0.95, 1.0, hx + 0.012, 2.27, 0.3); }
      for(const [a, b] of doors){ B.box("glass", 0.035, 1.75, b - a - 0.1, hx + 0.014, 1.88, (a + b) / 2); B.box("dark", 0.04, 1.8, 0.03, hx + 0.015, 1.88, (a + b) / 2); }
      B.box("glass", 0.03, 0.95, 0.95, -hx - 0.012, 2.27, 3.7); B.box("glass", 0.03, 0.95, 0.95, -hx - 0.012, 2.27, -0.1);
      // 前面
      B.box("glass", 2.0, 1.25, 0.03, 0, 2.38, L / 2 + 0.006); B.box("dark", 0.03, 1.25, 0.04, 0, 2.38, L / 2 + 0.008);
      B.box("dark", 1.9, 0.27, 0.03, 0, 3.0, L / 2 + 0.006); B.box("amber", 1.5, 0.08, 0.04, 0, 3.0, L / 2 + 0.01);       // 行き先表示
      for(const s of [1, -1]){ B.rbox("lamp", 0.34, 0.17, 0.05, 0.03, s * 0.88, 0.98, L / 2 + 0.004); B.box("amber", 0.14, 0.1, 0.04, s * 0.66, 1.2, L / 2 + 0.006); B.box("tail", 0.1, 0.08, 0.04, s * 1.1, 1.2, L / 2 + 0.006); }
      B.box("trim", 2.3, 0.3, 0.12, 0, 0.5, L / 2 - 0.03); B.box("dark", 1.1, 0.3, 0.03, 0, 1.0, L / 2 + 0.006);
      B.box("plate", 0.33, 0.17, 0.02, 0, 0.72, L / 2 + 0.07);
      // 後ろ
      B.box("glass", 1.7, 0.6, 0.03, 0, 2.5, -L / 2 - 0.006); B.box("dark", 1.5, 0.5, 0.03, 0, 1.15, -L / 2 - 0.006);
      for(const s of [1, -1]){ B.box("tail", 0.14, 0.5, 0.04, s * 1.0, 1.15, -L / 2 - 0.01); B.box("tail", 0.16, 0.1, 0.04, s * 0.95, 1.7, -L / 2 - 0.01); }
      B.box("trim", 2.3, 0.3, 0.12, 0, 0.5, -L / 2 + 0.03); B.box("plate", 0.33, 0.17, 0.02, 0, 0.72, -L / 2 - 0.07);
      // 屋根の空調・ミラー
      B.rbox("white", 1.5, 0.3, 2.6, 0.08, 0, 3.27, -1.0);
      if(q >= 1) for(const s of [1, -1]){ B.box("dark", 0.14, 0.55, 0.16, s * 1.42, 1.95, 4.9); B.box("dark", 0.3, 0.03, 0.04, s * 1.28, 2.2, 4.95); }
      // 車輪
      for(const z of [3.5, -2.45]) for(const sg of [1, -1]) wheelAt(B, q, z, X, 0.5, 0.28, sg, false);
    } },
    moto: { custom: (B, q) => {
      const r = 0.28, seg = q >= 1 ? 12 : 8;
      for(const z of [0.62, -0.62]){ B.cyl("tire", r, r, 0.12, seg, 0, r, z, "x"); B.cyl("rim", r * 0.6, r * 0.6, 0.125, seg, 0, r, z, "x"); }
      B.rbox("paint", 0.3, 0.34, 1.0, 0.07, 0, 0.5, -0.12);                                        // 車体
      B.rbox("paint", 0.34, 0.55, 0.09, 0.03, 0, 0.78, 0.5, 0, -0.35);                              // 前の覆い
      B.rbox("dark", 0.26, 0.1, 0.58, 0.04, 0, 0.78, -0.3);                                        // 座席
      B.box("dark", 0.64, 0.04, 0.05, 0, 1.05, 0.46); B.box("chrome", 0.04, 0.5, 0.04, 0.0, 0.7, 0.58, 0, 0.15);
      B.rbox("lamp", 0.16, 0.11, 0.06, 0.03, 0, 0.92, 0.55); B.box("tail", 0.14, 0.06, 0.03, 0, 0.74, -0.62); B.box("plate", 0.18, 0.12, 0.012, 0, 0.62, -0.63);
      B.box("dark", 0.3, 0.04, 0.4, 0, 0.8, -0.72);
      B.rbox("jacket", 0.4, 0.55, 0.26, 0.08, 0, 1.22, -0.2, 0, 0.12);                              // 人
      B.rbox("paint", 0.27, 0.27, 0.29, 0.1, 0, 1.64, -0.12);
      B.box("jeans", 0.14, 0.45, 0.15, 0.17, 0.78, 0.08, 0, -0.5); B.box("jeans", 0.14, 0.45, 0.15, -0.17, 0.78, 0.08, 0, -0.5);
      B.box("jacket", 0.1, 0.1, 0.5, 0.26, 1.15, 0.2, 0, 0.1); B.box("jacket", 0.1, 0.1, 0.5, -0.26, 1.15, 0.2, 0, 0.1);
    } },
  };
  V.SPEC = SPEC;
  SPEC.taxi2 = Object.assign({}, SPEC.sedan, { L: 4.6, extra: (B, q) => { B.rbox('white', 0.46, 0.17, 0.24, 0.05, 0, 1.55, -0.2); B.box('green', 1.78, 0.06, 3.0, 0, 0.62, -0.2); } });

  /* ---------- 車体 ---------- */
  function prep(S, q){
    const P = {};
    P.hwMax = S.W / 2;
    P.yb = pchip(S.yb);
    const topF = fillet(S.top, Object.assign({ d: 0.12 }, S.topR || {}), 0.04);
    P.yT = linear(topF);
    const g = S.gh; const roofPts = [[g.z1, P.yT(g.z1) - 0.01], [g.zr2, g.yRoof], [g.zr1, g.yRoof], [g.z0, P.yT(g.z0) - 0.01]];
    const roofF = fillet(roofPts, Object.assign({ d: 0.3 }, g.roofR || {}), 0.04); P.yR = linear(roofF);
    P.hw = (z) => { const L = S.L, hf = S.W / 2; let f = 1;
      const zF0 = L / 2 - S.rcF, zR0 = -L / 2 + S.rcR;
      const eF = S.endF === undefined ? 0.55 : S.endF, eR = S.endR === undefined ? 0.6 : S.endR;
      if(z > zF0){ const t = clamp((z - zF0) / S.rcF, 0, 1); f = eF + (1 - eF) * Math.pow(Math.max(0, 1 - Math.pow(t, S.nF)), 1 / S.nF); }
      else if(z < zR0){ const t = clamp((zR0 - z) / S.rcR, 0, 1); f = eR + (1 - eR) * Math.pow(Math.max(0, 1 - Math.pow(t, S.nR)), 1 / S.nR); }
      return hf * f; };
    P.crown = (z) => S.crown;
    P.sideFr = q >= 2 ? [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.91, 1.0] : q === 1 ? [0, 0.2, 0.42, 0.7, 1.0] : [0, 0.5, 1.0];
    return P;
  }
  const sideProf = (fr) => 0.955 + 0.045 * Math.sin(Math.PI * Math.min(1, fr / 0.72) * 0.5) - 0.03 * sstep(0.72, 1, fr);
  function bodyRing(S, P, z, q){
    const hw = P.hw(z), yb = P.yb(z), yT = P.yT(z), cr = P.crown(z), H = yT - yb, h = [];
    const rv = Math.min(0.055, H * 0.15), rh = 0.065, fTop = 1 - rv / H;
    h.push([0, yb], [hw * 0.86, yb + 0.004]);
    for(const fr of P.sideFr){ const f = fr <= 0.5 ? fr : 0.5 + (fr - 0.5) * (fTop - 0.5) / 0.5; h.push([hw * sideProf(fr), yb + H * f]); }
    const xA = hw * sideProf(1), xB = Math.max(0.02, xA - rh), arc = q >= 2 ? [30, 60, 90] : q === 1 ? [45, 90] : [90];
    for(const a of arc){ const th = a * Math.PI / 180; h.push([xB + rh * Math.cos(th), yT - rv + rv * Math.sin(th) + (a === 90 ? 0 : 0)]); }
    const tp = q >= 2 ? [0.62, 0.3] : q === 1 ? [0.5] : [];
    for(const u of tp) h.push([xB * u, yT + cr * (1 - u * u)]);
    h.push([0, yT + cr]);
    return h;      // 左半分（+x）: 下の中心 → 外側 → 肩 → 上の中心
  }
  function ringFull(h, z){   // 左半分 → 右半分（反対側）→ 閉じる
    const nh = h.length, out = [];
    for(let k = 0; k < nh; k++) out.push([h[k][0], h[k][1], z]);
    for(let k = nh - 2; k >= 1; k--) out.push([-h[k][0], h[k][1], z]);
    return out;
  }
  function knots(a, b, dz, extra, gap){
    const s = [];
    for(let z = a; z < b - 1e-6; z += dz) s.push(z); s.push(b);
    for(const e of extra) if(e > a + 1e-4 && e < b - 1e-4) s.push(e);
    s.sort((x, y) => x - y); const r = [s[0]]; for(let i = 1; i < s.length; i++) if(s[i] - r[r.length - 1] > (gap || 0.012)) r.push(s[i]); return r;
  }
  function buildBody(B, S, q){
    const P = prep(S, q), g = S.gh, L = S.L;
    // ---- 下の車体 ----
    P.hbAt = (z) => { const hwB = P.hw(z) * (0.93 - 0.04 * (1 - sstep(g.z1, g.zr2, z))), taper = (z > 0 ? 1 - (1 - g.taperF) * sstep(0, g.z0, z) : 1 - (1 - g.taperR) * sstep(0, g.z1, z)); return hwB * taper; };
    const rad = Object.assign({ d: 0.12 }, S.topR || {}), ex = [], m = q >= 2 ? 14 : q === 1 ? 7 : 3;
    for(let k = 1; k < m; k++){ const t = k / m * Math.PI / 2; ex.push(L / 2 - S.rcF + S.rcF * Math.sin(t)); ex.push(-L / 2 + S.rcR - S.rcR * Math.sin(t)); }
    S.top.forEach((p, i) => { const r = rad[i] === undefined ? rad.d : rad[i]; ex.push(p[0]); if(q >= 2){ ex.push(p[0] - r * 0.7, p[0] + r * 0.7); } if(q >= 2){ ex.push(p[0] - r * 0.35, p[0] + r * 0.35); } });
    S.yb.forEach((p) => ex.push(p[0]));
    const zs = knots(-L / 2, L / 2, q >= 2 ? 0.14 : q === 1 ? 0.3 : 0.6, ex, q >= 2 ? 0.02 : q === 1 ? 0.06 : 0.14);
    const rings = zs.map((z) => ringFull(bodyRing(S, P, z, q), z));
    { const cap = (r, z) => r.map((p) => [0, p[1], z]);       // 前後の面を平らにふさぐ（中心線につぶした輪）
      rings.push(cap(rings[rings.length - 1], L / 2)); zs.push(L / 2 + 0.001); rings.unshift(cap(rings[0], -L / 2)); zs.unshift(-L / 2 - 0.001); }
    const nh = rings[0].length, nhalf = (nh + 2) / 2;   // 左半分の頂点数
    const bumpZF = L / 2 - (S.bumperZF || 0.55), bumpZR = -L / 2 + (S.bumperZR || 0.55), sideN = P.sideFr.length, tfr = S.trimFr || 0.42;
    gridMesh(B, rings, (i, j) => {
      const zm = (zs[i] + zs[i + 1]) / 2;
      const jj = j < nhalf - 1 ? j : (nh - 1 - j);             // 左右対称の列番号（0 が下の中心側）
      if(jj < 1) return "under";
      if(zm > g.z1 - 0.02 && zm < g.z0 + 0.02 && jj >= nhalf - 7){ const pa = rings[i][j], pb = rings[i][(j + 1) % nh], hb = P.hbAt(zm) - 0.03, yTm = P.yT(zm);      // キャビンの下の甲板（窓の下にかくれて見えない面）は作らない
        if(Math.abs(pa[0]) < hb && Math.abs(pb[0]) < hb) return null;
        if(pa[1] > yTm - 0.07 && pb[1] > yTm - 0.07) return "trim"; }       // 窓のまわりの黒いモール
      const inB = zm > bumpZF || zm < bumpZR;                      // バンパーの範囲
      if(jj === 1) return inB ? "trim" : "under";                  // 下の面取り
      const row = jj - 2;                                           // 側面の段（0 が一番下）
      if(row < sideN - 1){ const fu = P.sideFr[row + 1]; if(fu <= tfr + 1e-6) return "trim"; }
      return "paint";
    }, true, false);
    // ---- ガラス部分（キャビン）----
    const gx = [g.z1, g.zr2, g.zr1, g.z0, ...g.win.flat()];
    for(const w of g.win) gx.push(w[0], w[1], w[2], w[3]);
    if(q >= 1) for(const r of [0.25, 0.5]){ gx.push(g.zr2 - r, g.zr1 + r * 0.6, g.zr2 + r * 0.4); }
    if(q >= 1) for(let z = g.z0 - 0.3; z > g.z0 - 0.7; z -= 0.1) gx.push(z);
    if(q >= 2) for(const r of [0.12, 0.38]){ gx.push(g.zr2 - r, g.zr1 + r * 0.6, g.zr2 + r * 0.4, g.z0 - r, g.z1 + r); }
    const gz = knots(g.z1, g.z0, q >= 2 ? 0.1 : q === 1 ? 0.3 : 0.9, gx.filter((v) => typeof v === "number"), q >= 2 ? 0.02 : q === 1 ? 0.07 : 0.2);
    const FS = q >= 2 ? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88] : q === 1 ? [0, 0.22, 0.44, 0.66, 0.88] : [0, 0.5, 0.88], nF = FS.length;
    const ghH = (z) => {
      const yB = P.yT(z) - 0.012, yR = P.yR(z), tu = g.tumble, hb = P.hbAt(z), hr = Math.max(0.12, hb - tu * (0.4 + 0.6 * Math.min(1, (yR - yB) / 0.45)));
      const dy = yR - yB, cr = g.crownR || 0.03, h = [];
      for(const f of FS) h.push([hb - (hb - hr) * 0.92 * Math.pow(f / 0.88, 1.7), yB + dy * 0.95 * f / 0.88 * 0.88]);
      h.push([hr * (g.rl1 || 0.93), yR - 0.012], [hr * (g.rl2 || 0.8), yR + cr * 0.3], [hr * (g.rl3 || 0.5), yR + cr * 0.75], [0, yR + cr]);
      return h; };
    P.ghH = ghH; P.nF = nF; P.FS = FS; P.gz = gz;
    const gr = gz.map((z) => { const h = ghH(z); const o = []; for(let k = 0; k < h.length; k++) o.push([h[k][0], h[k][1], z]); for(let k = h.length - 2; k >= 0; k--) o.push([-h[k][0], h[k][1], z]); return o; });
    const ncg = gr[0].length, midc = (ncg - 1) / 2, Hh = (ncg + 1) / 2;
    // 窓（左右・前後の位置は S.gh.win = [後ろ下, 後ろ上, 前下, 前上] の z）と、窓と窓のあいだの B ピラー（黒）を (z, t) 平面の凸多角形にする
    const winP = [], ccw = (p) => polyArea(p) >= 0 ? p : p.slice().reverse();
    for(const w of (g.win || [])){ const c = 0.045, ct = 0.05, tB = 0.04, tT = 0.97;
      winP.push({ k: "glass", pts: ccw([[w[0] + c, tB], [w[2] - c, tB], [w[2], tB + ct], [w[3], tT - ct], [w[3] - c, tT], [w[1] + c, tT], [w[1], tT - ct], [w[0], tB + ct]]) }); }
    if(g.win && g.win.length > 1){ const A = g.win[0], Bw = g.win[1]; if(A[0] - Bw[2] > 0.02) winP.push({ k: "dark", ik: "pillarB", pts: ccw([[Bw[2], -0.05], [A[0], -0.05], [A[1], 1.05], [Bw[3], 1.05]]) }); }
    P.winPi = winP.slice();      // 車内の殻用: 窓（穴）・B ピラー・前の柱・窓の下のふち
    if(g.win && g.win.length){ const W0 = g.win[0]; P.winPi.push({ k: "paint", ik: "pillarA", pts: ccw([[(W0[0] + W0[2]) / 2, -0.05], [g.z0 + 0.2, -0.05], [g.z0 + 0.2, 1.05], [(W0[1] + W0[3]) / 2, 1.05]]) });
      P.winPi.push({ k: "paint", ik: "door", pts: ccw([[-9, -0.06], [9, -0.06], [9, 0.07], [-9, 0.07]]) }); }
    const FSn = FS.map((f) => f / FS[nF - 1]); P.winP = winP; P.FSn = FSn;
    gridMesh(B, gr, (i, j) => {
      const zm = (gz[i] + gz[i + 1]) / 2;
      const left = j < midc, ja = left ? j : 2 * Hh - 2 - j - 0, jb = left ? j + 1 : 2 * Hh - 3 - j + 0;
      const jjj = Math.min(ja, jb);
      if(jjj <= nF - 2) return (Q) => clipQuad(B, Q, [gz[i], gz[i + 1]], [FSn[ja], FSn[jb]], winP, false);       // 側面（窓の段）
      if(jjj <= nF) return "paint";                                           // 窓の上の縁・ピラー・屋根の縁
      // 屋根の面: フロントガラス・リアガラス・屋根
      if(zm > g.zr1 + 0.03 && zm < g.z0 - 0.03) return "glass";
      if(zm < g.zr2 - 0.03 && zm > g.z1 + 0.03) return "glass";
      return "paint";
    }, false, false);
    return { P, S };
  }

  /* ---------- キャビン側面の曲面（窓を貼る）---------- */
  function ghSurf(P, sg){
    const nF = P.nF;
    const pt = (z, tt) => { const h = P.ghH(z), s = clamp(tt, 0, 1) * (nF - 1), i = Math.min(nF - 2, Math.floor(s)), u = s - i; return [h[i][0] + (h[i + 1][0] - h[i][0]) * u, h[i][1] + (h[i + 1][1] - h[i][1]) * u, z, i]; };
    return (z, tt) => { const a = pt(z, tt), e = 0.012, p1 = pt(z - e, tt), p2 = pt(z + e, tt), q1 = pt(z, tt - 0.02), q2 = pt(z, tt + 0.02);
      const dz = [(p2[0] - p1[0]) / (2 * e), (p2[1] - p1[1]) / (2 * e), 1], dt = [q2[0] - q1[0], q2[1] - q1[1], 0];
      let n = [dz[1] * dt[2] - dz[2] * dt[1], dz[2] * dt[0] - dz[0] * dt[2], dz[0] * dt[1] - dz[1] * dt[0]]; if(n[0] < 0) n = [-n[0], -n[1], -n[2]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1; return { p: [sg * a[0], a[1], z], n: [sg * n[0] / l, n[1] / l, n[2] / l] }; };
  }
  /* 台形の窓の輪郭（z, t 平面）: w = [後ろ下, 後ろ上, 前下, 前上]。角を少し落とす */
  function trapOutline(w, inset){
    const ins = inset || 0.012, c = (a, b) => (a + b) / 2, z0 = (w[0] + w[1] + w[2] + w[3]) / 4;
    const pts = [[w[0] + ins, 0.05], [w[2] - ins, 0.05], [w[3] - ins, 0.97], [w[1] + ins, 0.97]];
    const out = [];
    for(let i = 0; i < 4; i++){ const a = pts[i], b = pts[(i + 1) % 4], pr = pts[(i + 3) % 4];
      const d1 = [pr[0] - a[0], pr[1] - a[1]], d2 = [b[0] - a[0], b[1] - a[1]], l1 = Math.hypot(d1[0], d1[1] * 0.5), l2 = Math.hypot(d2[0], d2[1] * 0.5), k1 = Math.min(0.5, 0.05 / l1), k2 = Math.min(0.5, 0.05 / l2);
      out.push([a[0] + d1[0] * k1, a[1] + d1[1] * k1], [a[0] + d1[0] * k1 * 0.3 + d2[0] * k2 * 0.3, a[1] + d1[1] * k1 * 0.3 + d2[1] * k2 * 0.3], [a[0] + d2[0] * k2, a[1] + d2[1] * k2]); }
    const cx = z0, cy = 0.5; return { c: [cx, cy], ol: out.map((p) => [p[0] - cx, p[1] - cy]) };
  }
  function addWindows(B, S, P, q){
    const g = S.gh; if(!g.win) return; const nr = q >= 2 ? 3 : q === 1 ? 2 : 1, off = q >= 2 ? 0.006 : 0.012;
    for(const sg of [1, -1]){ const f = ghSurf(P, sg);
      for(const w of g.win){ const o = trapOutline(w); patch(B, "glass", f, o.c[0], o.c[1], o.ol, nr, off); }
      if(g.win.length > 1){ const A = g.win[0], Bw = g.win[1];       // 窓と窓のあいだ（B ピラー）は黒
        const w = [Bw[2], Bw[3], A[0], A[1]]; if(w[2] - w[0] > 0.02){ const cz = (w[0] + w[1] + w[2] + w[3]) / 4, ol = [[w[0] - cz, 0.05 - 0.5], [w[2] - cz, 0.05 - 0.5], [w[3] - cz, 0.97 - 0.5], [w[1] - cz, 0.97 - 0.5]]; patch(B, "dark", f, cz, 0.5, ol, 1, off * 0.6); } }
    }
  }

  /* ---------- 車体の表面の上の点（灯火・グリル・ナンバーを曲面に貼る）----------
     F(|x|, y, z) = 0 が車体の表面。正が外側。点と外向きの法線を返す */
  function mkSurf(S, P){
    const L = S.L, zF0 = L / 2 - S.rcF, zR0 = -L / 2 + S.rcR;
    const frOf = (z, y) => clamp((y - P.yb(z)) / (P.yT(z) - P.yb(z)), 0, 1);
    const F = (ax, y, z) => ax - P.hw(z) * sideProf(frOf(z, y));
    const grad = (x, y, z) => { const e = 2e-3, ax = Math.abs(x), sg = x < -1e-6 ? -1 : (x > 1e-6 ? 1 : 0);
      const gy = (F(ax, y + e, z) - F(ax, y - e, z)) / (2 * e), gz = (F(ax, y, z + e) - F(ax, y, z - e)) / (2 * e);
      const l = Math.hypot(sg, gy, gz) || 1; return [sg / l, gy / l, gz / l]; };
    const end = (dir) => { const a0 = dir > 0 ? zF0 : zR0, b0 = dir > 0 ? L / 2 : -L / 2;
      return (x, y) => { const ax = Math.abs(x); let a = a0, b = b0;
        if(F(ax, y, a) >= 0) return { p: [x, y, a], n: grad(x, y, a) };
        if(F(ax, y, b) < 0){ const yy = clamp(y, P.yb(b) + 0.01, P.yT(b) - 0.01); return { p: [x, yy, b], n: [0, 0, dir] }; }      // 平らな面
        for(let i = 0; i < 30; i++){ const mm = (a + b) / 2; if(F(ax, y, mm) < 0) a = mm; else b = mm; }
        const z = (a + b) / 2, yy = clamp(y, P.yb(z) + 0.01, P.yT(z) - 0.01); return { p: [x, yy, z], n: grad(x, yy, z) }; }; };
    const side = (sg) => (z, y) => { const x = sg * P.hw(z) * sideProf(frOf(z, y)); return { p: [x, clamp(y, P.yb(z), P.yT(z)), z], n: grad(x, y, z) }; };
    return { F: end(1), R: end(-1), S: side, frOf };
  }
  /* 角の丸い四角（半幅 w・半高 h・角の半径 r）。sh: 上下でずれる量（ななめの灯火） */
  function rr(w, h, r, seg, sh){
    const out = [], cs = [[1, 1, 0], [-1, 1, 0.5], [-1, -1, 1], [1, -1, 1.5]]; r = Math.min(r, w, h);
    for(const [sx, sy, a0] of cs) for(let k = 0; k <= seg; k++){ const a = (a0 + k / seg * 0.5) * Math.PI; out.push([sx * (w - r) + r * Math.cos(a) + (sh || 0) * (sy * (h - r) + r * Math.sin(a)), sy * (h - r) + r * Math.sin(a)]); }
    return out;
  }
  /* 曲面 f(u,v) の上に、中心 (cx,cy)・輪郭 outline（中心からの差）の板を貼る。nr: 中心から縁への分割数、off: 表面から浮かせる量 */
  function patch(B, k, f, cx, cy, outline, nr, off){
    const m = outline.length, c = f(cx, cy), rings = [];
    for(let j = 1; j <= nr; j++){ const s = j / nr, r = []; for(let i = 0; i < m; i++) r.push(f(cx + outline[i][0] * s, cy + outline[i][1] * s)); rings.push(r); }
    const P3 = (qq) => [qq.p[0] + qq.n[0] * off, qq.p[1] + qq.n[1] * off, qq.p[2] + qq.n[2] * off];
    const emit = (a, b, c3) => { const A = P3(a), Bp = P3(b), C = P3(c3);
      const ux = Bp[0] - A[0], uy = Bp[1] - A[1], uz = Bp[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const d = nx * (a.n[0] + b.n[0] + c3.n[0]) + ny * (a.n[1] + b.n[1] + c3.n[1]) + nz * (a.n[2] + b.n[2] + c3.n[2]);
      if(d >= 0) B.tri(k, A, Bp, C, a.n, b.n, c3.n); else B.tri(k, A, C, Bp, a.n, c3.n, b.n); };
    for(let i = 0; i < m; i++) emit(c, rings[0][i], rings[0][(i + 1) % m]);
    for(let j = 0; j < nr - 1; j++) for(let i = 0; i < m; i++){ const i1 = (i + 1) % m; emit(rings[j][i], rings[j + 1][i], rings[j + 1][i1]); emit(rings[j][i], rings[j + 1][i1], rings[j][i1]); }
  }
  function addFx(B, S, P, q){
    const sf = mkSurf(S, P), off = q >= 2 ? 0.008 : q === 1 ? 0.014 : 0.02, seg = q >= 2 ? 4 : q === 1 ? 3 : 2, nr = q >= 2 ? 3 : q === 1 ? 2 : 1;
    for(const it of S.fx || []){
      const f = it.at === "F" ? sf.F : sf.R, kk = it.k === "plate" && S.kei ? "plateK" : it.k;
      for(const sg of (it.m ? [1, -1] : [1])){
        const ol = rr(it.w, it.h, it.r || 0.02, seg, (it.sh || 0) * sg * (it.at === "R" ? 1 : 1));
        patch(B, kk, f, sg * it.x, it.y, ol.map((p) => [p[0], p[1]]), nr, off * (it.k === "lamp" || it.k === "tail" ? 1.3 : 1)); }
    }
    return sf;
  }
  /* ホイールの面（外向き）: 内側の暗い面・縁の輪・5 本のスポーク・中心 */
  function wheelFace(B, sg, xf, y, z, r, q, seg){
    if(q === 0){ B.disc("rim", r * 0.66, 8, xf, y, z, sg); return; }
    B.disc("dark", r * 0.62, seg, xf, y, z, sg);
    B.disc("rim", r * 0.66, seg, xf + sg * 0.002, y, z, sg, r * 0.58);
    const n = [sg, 0, 0], a0 = 0.3;
    for(let i = 0; i < 5; i++){ const a = a0 + i * Math.PI * 2 / 5, ca = Math.cos(a), sa = Math.sin(a), px = -sa, pz = ca, q2 = (rho, w) => [xf + sg * 0.004, y + ca * rho * r + px * w * r, z + sa * rho * r + pz * w * r];
      B.quadN("rim", q2(0.1, -0.05), q2(0.1, 0.05), q2(0.6, 0.085), q2(0.6, -0.085), n); }
    B.disc("rim", r * 0.14, 8, xf + sg * 0.005, y, z, sg);
  }
  /* 車輪 1 つ（z: 前後位置、xs: 側面の一番外側の x、dual: 後ろの双輪） */
  function wheelAt(B, q, z, xs, r, tw, sg, dual){
    const seg = q >= 2 ? 28 : q === 1 ? 14 : 8;
    B.wheels.push({ z, xs, r, tw, sg, dual: !!dual });
    B.disc("dark", r + 0.075, seg + 4, sg * (xs + 0.006), r, z, sg, r * 0.97);       // アーチの影（輪）
    if(B.hi) return;                                                                  // 自分の車は車輪を別の部品（回る・曲がる）として作る
    const g = new THREE.CylinderGeometry(r, r, tw, seg, 1, q === 0); g.rotateZ(Math.PI / 2); g.translate(sg * (xs + 0.02 - tw / 2), r, z); B.geo("tire", g, null);
    if(dual){ const g2 = new THREE.CylinderGeometry(r, r, tw, seg, 1, true); g2.rotateZ(Math.PI / 2); g2.translate(sg * (xs + 0.02 - tw * 1.55), r, z); B.geo("tire", g2, null);
      B.cyl("dark", r * 0.5, r * 0.5, tw * 0.9, 8, sg * (xs - tw * 0.9), r, z, "x"); }
    wheelFace(B, sg, sg * (xs + 0.0215), r, z, r, q, seg);
  }
  function addWheels(B, S, P, q){
    const W = S.wheels, axles = [W.zf, W.zr, W.zr2].filter((v) => typeof v === "number");
    for(const z of axles) for(const sg of [1, -1]) wheelAt(B, q, z, P.hw(z) * 1.0, W.r, W.tw, sg, false);
  }
  function addMirrors(B, S, P, q){
    const g = S.gh, m = S.mir || {}, z = m.z !== undefined ? m.z : g.z0 - 0.28;
    for(const sg of [1, -1]){ const hb = P.hbAt(z), dx = m.dx || 0.14, x = sg * (hb + dx), y = m.y !== undefined ? m.y : P.yT(z) + 0.1;
      if(q >= 1){ if(m.big) B.box("mirror", 0.06, 0.26, 0.004, x, y, z - 0.082); else B.box("mirror", 0.085, 0.058, 0.004, x, y + 0.004, z - 0.101); }
      if(m.big){ B.box("dark", 0.07, 0.3, 0.16, x, y, z); B.box("dark", dx, 0.03, 0.04, sg * (hb + dx / 2), y + 0.1, z); B.box("dark", dx, 0.03, 0.04, sg * (hb + dx / 2), y - 0.1, z); }
      else { B.rbox("paint", 0.1, 0.08, 0.2, 0.03, x, y, z, sg * 0.2); B.box("dark", dx, 0.03, 0.045, sg * (hb + dx / 2), y - 0.035, z); } }
  }
  /* ドアの合わせ目・取っ手（側面に貼る） */
  function addDoors(B, S, P, q){
    if(!S.gh.seams || q < 1) return;
    const sf = mkSurf(S, P), g = S.gh;
    for(const sg of [1, -1]){ const f = sf.S(sg);
      for(const zz of g.seams){ const yTop = P.yT(zz) - 0.02;
        const y0 = P.yb(zz) + 0.12, y1 = yTop, n = q >= 2 ? 6 : 3;
        for(let k = 0; k < n; k++){ const ya = y0 + (y1 - y0) * k / n, yb2 = y0 + (y1 - y0) * (k + 1) / n, a = f(zz - 0.0035, ya), b = f(zz + 0.0035, ya), c = f(zz + 0.0035, yb2), d = f(zz - 0.0035, yb2), o = 0.006;
          const P3 = (qq) => [qq.p[0] + qq.n[0] * o, qq.p[1] + qq.n[1] * o, qq.p[2] + qq.n[2] * o]; B.quadN("dark", P3(a), P3(b), P3(c), P3(d), a.n); } }
      for(const zz of g.handles || []){ const yy = P.yT(zz) - 0.1; const a = f(zz - 0.07, yy - 0.012), b = f(zz + 0.07, yy - 0.012), c = f(zz + 0.07, yy + 0.012), d = f(zz - 0.07, yy + 0.012), o = 0.012;
        const P3 = (qq) => [qq.p[0] + qq.n[0] * o, qq.p[1] + qq.n[1] * o, qq.p[2] + qq.n[2] * o]; B.quadN("chrome", P3(a), P3(b), P3(c), P3(d), a.n); }
    }
  }

  /* ---------- 出力 ---------- */
  const AIPAL = { paint: [0xffffff, 1], glass: [0x182026, 2], trim: [0x232527, 0], under: [0x161616, 0], tire: [0x141414, 0], rim: [0xa8acb0, 3], lamp: [0xf4f0e2, 4], tail: [0xb3160f, 6], plate: [0xf4f4ee, 0], plateK: [0xf2d84a, 0], chrome: [0xc4c8cc, 3], dark: [0x0f1012, 0], red: [0xc02018, 0], amber: [0xe89a20, 0], white: [0xe6e6e0, 0], body2: [0xd8dadc, 1], green: [0x2b6c3f, 0], blue: [0x1f4d8c, 0], gray: [0x8d9094, 0], box: [0xe4e6e8, 5], jacket: [0x2a2c30, 0], jeans: [0x2a2f3a, 0], mirror: [0x7d8b97, 3] };
  function toMerged(B, pal){
    const pos = [], nrm = [], col = [], pnt = [];
    for(const [k, g] of Object.entries(B.g)){ const pp = (pal && pal[k]) || AIPAL[k] || [0x888888, 0], c = new THREE.Color(pp[0]);
      for(let i = 0; i < g.p.length; i++){ pos.push(g.p[i]); nrm.push(g.n[i]); } for(let i = 0; i < g.p.length / 3; i++){ col.push(c.r, c.g, c.b); pnt.push(pp[1]); } }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); geo.setAttribute("aPaint", new THREE.Float32BufferAttribute(pnt, 1));
    return geo;
  }
  Builder.prototype.shiftZ = function(dz){ for(const g of Object.values(this.g)) for(let i = 2; i < g.p.length; i += 3) g.p[i] += dz; };
  V.build = (name, q, hi) => { const B = new Builder(), S = SPEC[name]; B.hi = !!hi;
    if(S.custom){ S.custom(B, q); return { B, S, P: null }; }
    const { P } = buildBody(B, S, q); addFx(B, S, P, q); addWheels(B, S, P, q); addMirrors(B, S, P, q); addDoors(B, S, P, q);
    if(S.zo){ B.shiftZ(S.zo); for(const w of B.wheels) w.z += S.zo; }       // 車輪の位置も車体と同じだけずらす（この後の extra の車輪は最初から最終位置）
    if(S.extra) S.extra(B, q, P);
    return { B, S, P }; };
  V.ai = (name, lod) => { const { B } = V.build(name, lod === undefined ? 1 : lod); return toMerged(B, null); };
  V.toMerged = toMerged; V.AIPAL = AIPAL;
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
    const matBody = opt.mat || V.makeMat(), matGlass = V.makeMat({ glass: true }), matCab = V.makeMat({ cabin: true, side: THREE.DoubleSide });
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
    ud.drive = (v, dt, steer) => { for(const w of ud.wheels){ w.spin.rotation.x += v * dt / w.r; if(w.front) w.steer.rotation.y = steer; } };
    ud.setInside = (inside) => { if(ud.rvmG) ud.rvmG.visible = !inside; };      // 運転席視点では画面上のルームミラー（街側で実際の後方映像を重ねる）を使うので、立体のルームミラーは隠す
    ud.setSky = (c) => { if(ud.rvm) ud.rvm.material.color.copy(c).multiplyScalar(1.05); };
    ud.update = (C) => {
      const kmh = Math.abs(C.v || 0) * 3.6, rpm = C.rpm === undefined ? 800 : C.rpm;
      if(ud.nSpeed){ ud.nSpeed.rotation.z = -(-135 + 270 * Math.min(1.04, kmh / 180)) * R2D; ud.nTacho.rotation.z = -(-135 + 270 * Math.min(1.02, rpm / 8000)) * R2D; }
      if(ud.steerG) ud.steerG.rotation.z = -(C.wheel || 0);
      matBody.userData.U.uBrake.value = (C.brk || 0) > 0.05 ? 1 : 0;
      if(ud.mid){ const key = (C.gear || "D") + "|" + Math.round(kmh) + "|" + Math.floor((C.odo || 0) / 100); if(key !== ud.mid.key){ ud.mid.key = key; const c = ud.mid.c.getContext("2d");
        c.fillStyle = "#07090b"; c.fillRect(0, 0, 256, 192); c.textAlign = "center"; c.textBaseline = "middle";
        c.fillStyle = C.gear === "R" ? "#ff7a3a" : "#7be08a"; c.font = "bold 74px sans-serif"; c.fillText(C.gear === "R" ? "R" : "D", 128, 58);
        c.fillStyle = "#e8eef2"; c.font = "bold 58px sans-serif"; c.fillText(String(Math.round(kmh)), 128, 122); c.fillStyle = "#8c959c"; c.font = "bold 22px sans-serif"; c.fillText("km/h   " + ((C.odo || 0) / 1000).toFixed(1) + " km", 128, 168);
        ud.mid.t.needsUpdate = true; } }
    };
    ud.update({ v: 0, rpm: 800, gear: "D", wheel: 0, brk: 0, odo: 0 });
    return g;
  };

  V._u = { pchip, fillet, linear, clamp, sstep, Builder, rboxGeo, gridMesh };
  return V;
})();
