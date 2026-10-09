"""v41.21: 車線の高さに合う層が走行格子に無い所へ層を足す（立体交差の下をくぐる道・堤防の下の道・高架の面の穴）。

走行格子は 2m 升ごとに「本線の層（H, K）」と、あれば「上の段（UH, UK）」を持ち、app.js は車の今の高さ（yref）に近い方を使う。
PLATEAU は高架・堤防が別の道の上を通る所の面を下の道に割り当てるので、下の道の升目が欠け、そこに車線（OSM の道の中心線）が
通っていると、車は高架・堤防の高さ（4〜6m 上）へ持ち上がってしまう（x≈1340 の高架の下・旭川の堤防の下 (950,1635) など）。

ここでは車線（traffic.json の lanes・conns）の点を 1m ごとに見て、
  ① 升目の本線が車線の高さより 2.5m 以上高く（高架・堤防・丘の上の面）、上の段が無い → その升目の「本線」を車線の高さの路面（K=1）にし、
     元の本線は「上の段」へ移す（下の道は地面の層、上の面は上の段になる）。車線の中心から 3.2m 以内の升目だけ。
  ② 升目の本線が車線の高さより 2.5m 以上低い連続区間（60m 以下）で、前後 12m 以内に車線の高さの層がある（高架の面の穴）
     → 上の段に車線の高さの路面（K=1）を足す。
  ③ 1m 升の「通れない」ビット（建物・壁・橋脚）が車線の中心から 1.0m 以内にあるものを消す（車線の上に橋脚・壁が載っていて、車線どおりに走ると
     見えない壁のように止まる所。3.87M 点のうち 約 1,100 点・約 300 か所）。
車線の高さ（ly）は traffic.py が出す（_flat_hills で高架の下の山を平らにしたもの）ので、層の高さはそれに従う。
入力: OUT_DIR（既定 /home/claude/okaden-x/data）の scene.json・geo_drive.txt・geo_ground.txt・traffic.json・traffic_pts.txt
出力: 同じ場所の geo_drive.txt・scene.json（drive.up・files.drive）を書き換える。--dry は書かずに数だけ出す
"""
import os, sys, json, zlib, base64
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_io

OUT = geo_io.OUT
DRY = "--dry" in sys.argv
DECK_ABOVE = 2.5      # 本線が車線より高い（上の面がある）と見なす差
HOLE_BELOW = 2.5      # 本線が車線より低い（面の穴）と見なす差。v41.21 で 1.8 も試したが、ランプ車線（11985/6・28853-56）の勾配・高さのずれは同程度（良し悪しが車線ごとに入れ替わる）で、改善といえるほどではなかったので 2.5 のまま
CORR_R = 3.2          # 車線の中心から升目の中心までの距離
HOLE_MAX = 60.0       # 穴の最大の長さ（m）
HOLE_ANCHOR = 12.0    # 穴の前後で車線の高さの層を探す距離（m）
LAYER_TOL = 1.5       # 「その高さの層がある」と見なす差
CLEAR_R = 1.0         # 車線の中心から、この距離以内に中心がある 1m 升の「通れない」ビットを消す（橋脚・壁が車線にかぶる所）

def ground_pred(Hc, dnx, dnz):
    nz_, nx_ = Hc.shape; H_ = np.asarray(Hc, np.int64)
    fi4 = 2 * np.arange(dnx) + 1; i0 = np.minimum(fi4 >> 2, nx_ - 2); a = np.minimum(fi4 - 4 * i0, 4)
    fj4 = 2 * np.arange(dnz) + 1; j0 = np.minimum(fj4 >> 2, nz_ - 2); b = np.minimum(fj4 - 4 * j0, 4)
    J = j0[:, None]; I = i0[None, :]; A = a[None, :]; B = b[:, None]
    P16 = (H_[J, I] * (4 - A) + H_[J, I + 1] * A) * (4 - B) + (H_[J + 1, I] * (4 - A) + H_[J + 1, I + 1] * A) * B
    return (P16 + 8) // 16 - 12

def gres_encode(H, Hc):
    E = np.asarray(H, np.int64) - ground_pred(Hc, H.shape[1], H.shape[0])
    assert np.abs(E).max() < 32768
    u = E.astype(np.int16).view(np.uint16)
    return (u & 255).astype(np.uint8).tobytes() + (u >> 8).astype(np.uint8).tobytes()

def load_lanes():
    T = json.load(open(f"{OUT}/traffic.json"))
    raw = zlib.decompress(base64.b64decode(open(f"{OUT}/{T['pts']['file']}").read().strip()))
    N = T["pts"]["n"]; b = np.frombuffer(raw, np.uint8)
    A = np.zeros((N, 3), np.int64)
    for c in range(3):
        o = c * 4 * N
        v = (b[o:o + N].astype(np.uint32) | (b[o + N:o + 2 * N].astype(np.uint32) << 8) | (b[o + 2 * N:o + 3 * N].astype(np.uint32) << 16) | (b[o + 3 * N:o + 4 * N].astype(np.uint32) << 24)).view(np.int32).astype(np.int64)
        A[:, c] = v
    for L in (T["lanes"], T["conns"]):
        for e in L: A[e["o"]:e["o"] + e["m"]] = np.cumsum(A[e["o"]:e["o"] + e["m"]], axis=0)
    A = A / 100.0
    lines = [(e["o"], e["m"]) for e in T["lanes"] + T["conns"] if e["m"] >= 2]
    return A, lines

def densify(A, lines, step=1.0):
    """全車線の点列を step ごとに補間（x, ly, z, 車線の番号, 車線内の通し番号）"""
    xs = []; ls = []; zs = []; lid = []; idx = []
    for li, (o, m) in enumerate(lines):
        P = A[o:o + m]
        d = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 2]))
        keep = np.r_[True, d > 1e-6]
        P = P[keep]
        if len(P) < 2: continue
        d = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 2])); cum = np.r_[0, np.cumsum(d)]
        s = np.arange(0, cum[-1] + 1e-6, step)
        if s[-1] < cum[-1] - 0.01: s = np.r_[s, cum[-1]]
        xs.append(np.interp(s, cum, P[:, 0])); ls.append(np.interp(s, cum, P[:, 1])); zs.append(np.interp(s, cum, P[:, 2]))
        lid.append(np.full(len(s), li, np.int32)); idx.append(np.arange(len(s), dtype=np.int32))
    return np.concatenate(xs), np.concatenate(ls), np.concatenate(zs), np.concatenate(lid), np.concatenate(idx)

def clear_lane_bits(bbits, dm, X, Z):
    """1m 升の「通れない」ビットのうち、車線の点から CLEAR_R 以内に中心がある升を消す。戻り値: (新しいビット列, 消した升の数)"""
    nbx, nbz, brow, bs = dm["bnx"], dm["bnz"], dm["brow"], dm["bstep"]
    B = np.unpackbits(np.frombuffer(bbits, np.uint8).reshape(nbz, brow), axis=1)[:, :nbx].copy()
    before = int(B.sum()); x0, z0 = dm["x0"], dm["z0"]
    ci0 = np.floor((X - x0) / bs).astype(np.int64); cj0 = np.floor((Z - z0) / bs).astype(np.int64)
    for dz in range(-2, 3):
        for dx in range(-2, 3):
            cx = ci0 + dx; cz = cj0 + dz
            ok = (cx >= 0) & (cz >= 0) & (cx < nbx) & (cz < nbz)
            cx, cz, xx, zz = cx[ok], cz[ok], X[ok], Z[ok]
            m = np.hypot(x0 + (cx + 0.5) * bs - xx, z0 + (cz + 0.5) * bs - zz) <= CLEAR_R
            B[cz[m], cx[m]] = 0
    pad = brow * 8 - nbx
    if pad: B = np.pad(B, ((0, 0), (0, pad)))
    return np.packbits(B, axis=1).tobytes(), before - int(B.sum())

def _backup():
    # v41.21: 作り直しやパラメータ調整を繰り返せるよう、層を足す前（build_v5 の出力そのまま）を /home/claude/wx/pre_underfill/ に取っておく。
    #   UF_RESTORE=1: 取っておいた物へ戻してから処理する（何度流しても同じ結果）。既定: 今のデータが build の出力とみなして取り直す
    import shutil
    bd = "/home/claude/wx/pre_underfill"; os.makedirs(bd, exist_ok=True)
    if os.environ.get("UF_RESTORE"):
        for f in ("geo_drive.txt", "scene.json"): shutil.copy(f"{bd}/{f}", f"{OUT}/{f}")
        print("restored pre-underfill drive grid", flush=True)
    else:
        for f in ("geo_drive.txt", "scene.json"): shutil.copy(f"{OUT}/{f}", f"{bd}/{f}")

def main():
    _backup()
    sc = json.load(open(f"{OUT}/scene.json")); dm = sc["drive"]; nx, nz = dm["nx"], dm["nz"]; n = nx * nz; x0, z0, st = dm["x0"], dm["z0"], dm["step"]
    raw_orig = zlib.decompress(base64.b64decode(open(f"{OUT}/geo_drive.txt", "rb").read().strip()))
    raw = geo_io.read_legacy("drive")
    DH = np.frombuffer(raw[:2 * n], np.int16).reshape(nz, nx).astype(np.int32).copy()
    DK = np.frombuffer(raw[2 * n:3 * n], np.uint8).reshape(nz, nx).copy()
    bbits = raw[3 * n:3 * n + dm["brow"] * dm["bnz"]]
    c0 = dm.get("up", 0); o = 3 * n + dm["brow"] * dm["bnz"]
    ui = np.frombuffer(raw[o:o + 4 * c0], np.int32).astype(np.int64); uh = np.frombuffer(raw[o + 4 * c0:o + 6 * c0], np.int16).astype(np.int32); uk = np.frombuffer(raw[o + 6 * c0:o + 7 * c0], np.uint8)
    UH = np.full(n, -32768, np.int32); UK = np.zeros(n, np.uint8); UH[ui] = uh; UK[ui] = uk
    UH = UH.reshape(nz, nx); UK = UK.reshape(nz, nx)
    # 自己検査: 戻して同じバイト列になること
    g = sc["ground"]; Hc = np.frombuffer(geo_io.read_legacy("ground")[:2 * g["nx"] * g["nz"]], np.int16).reshape(g["nz"], g["nx"])
    rt = gres_encode(DH, Hc) + DK.tobytes() + bbits + (ui.astype(np.int32).tobytes() + uh.astype(np.int16).tobytes() + uk.tobytes())
    assert rt == raw_orig, "drive の再符号化が元と一致しない"
    print("drive", nx, nz, "upper cells", c0, "(round trip ok)", flush=True)

    A, lines = load_lanes()
    X, Y, Z, LID, IDX = densify(A, lines)
    ci = np.floor((X - x0) / st).astype(np.int64); cj = np.floor((Z - z0) / st).astype(np.int64)
    inb = (ci >= 2) & (cj >= 2) & (ci < nx - 2) & (cj < nz - 2)
    X, Y, Z, LID, IDX, ci, cj = X[inb], Y[inb], Z[inb], LID[inb], IDX[inb], ci[inb], cj[inb]
    print("lane points (1 m)", len(X), flush=True)
    bbits, ncl = clear_lane_bits(bbits, dm, X, Z)
    print("building bits cleared near lane centers:", ncl, flush=True)
    Hm = DH[cj, ci] / 100.0; hasU = UH[cj, ci] != -32768; Hu = np.where(hasU, UH[cj, ci] / 100.0, np.nan)
    Km = DK[cj, ci]
    near_u = hasU & (np.abs(Hu - Y) <= LAYER_TOL)
    near_m = np.abs(Hm - Y) <= LAYER_TOL
    # ① 面の下をくぐる（本線が車線より高い）
    dup = hasU & (np.abs(np.where(hasU, Hu, 0) - Hm) <= 1.0)     # 本線と上の段がほぼ同じ高さ（面が二重に入っている）
    f1 = (Hm - Y > DECK_ABOVE) & (~hasU | dup) & (Km != 9) & (Km != 255)
    # ② 面の穴（本線が車線より低い）: 連続区間で前後に車線の高さの層がある
    f2 = (Y - Hm > HOLE_BELOW) & ~near_u & ~near_m
    have = near_m | near_u
    f2_ok = np.zeros(len(X), bool)
    order = np.arange(len(X))
    # 車線ごとの連続区間（IDX は 1m ごと）
    brk = np.r_[True, (LID[1:] != LID[:-1]) | (IDX[1:] != IDX[:-1] + 1)]
    seg_start = np.nonzero(brk)[0]; seg_end = np.r_[seg_start[1:], len(X)]
    n_holes = 0
    for a, b in zip(seg_start, seg_end):
        if not f2[a:b].any(): continue
        ff = f2[a:b]; hv = have[a:b]; m = b - a
        # 連続する True の区間
        d = np.diff(np.r_[0, ff.astype(np.int8), 0]); s_ = np.nonzero(d == 1)[0]; e_ = np.nonzero(d == -1)[0]
        for ss, ee in zip(s_, e_):
            if ee - ss > HOLE_MAX: continue
            lo = hv[max(0, ss - int(HOLE_ANCHOR)):ss].any(); hi = hv[ee:min(m, ee + int(HOLE_ANCHOR))].any()
            if lo and hi: f2_ok[a + ss:a + ee] = True; n_holes += 1
    print("under-deck points", int(f1.sum()), "hole points", int(f2_ok.sum()), "holes", n_holes, flush=True)

    # 升目への割り当て（車線の点から CORR_R 以内の升目。最も近い車線の点の高さ）
    best = {}   # 升目の番号 -> (距離, 高さ, 種類)
    def spread(sel, kind):
        px, pz, py = X[sel], Z[sel], Y[sel]; pi, pj = ci[sel], cj[sel]
        for dj in range(-2, 3):
            for di in range(-2, 3):
                qi = pi + di; qj = pj + dj
                cx = x0 + (qi + 0.5) * st; cz = z0 + (qj + 0.5) * st
                d = np.hypot(cx - px, cz - pz); ok = d <= CORR_R
                if not ok.any(): continue
                key = qj[ok] * nx + qi[ok]; dd = d[ok]; hh = py[ok]
                # 同じ升目の中で最も近い点を残す
                o_ = np.lexsort((dd, key)); key, dd, hh = key[o_], dd[o_], hh[o_]
                first = np.r_[True, key[1:] != key[:-1]]
                for k_, d_, h_ in zip(key[first].tolist(), dd[first].tolist(), hh[first].tolist()):
                    cur = best.get((k_, kind))
                    if cur is None or d_ < cur[0]: best[(k_, kind)] = (d_, h_)
    spread(f1, 1); spread(f2_ok, 2)
    new_ui = []; new_uh = []; new_uk = []
    n1 = n2 = skip = 0
    DHf = DH.reshape(-1); DKf = DK.reshape(-1); UHf = UH.reshape(-1)
    applied = []
    for (k, kind), (d_, h_) in sorted(best.items()):
        if kind == 1:
            if DKf[k] == 9: skip += 1; continue
            has_u = UHf[k] != -32768
            if has_u and abs(int(UHf[k]) - int(DHf[k])) > 100: skip += 1; continue      # 3 層は触らない
            if DHf[k] / 100.0 - h_ <= DECK_ABOVE: skip += 1; continue
            # 元の本線は上の段へ（上の段が既にあれば、それが上の面）、本線は車線の高さの路面
            applied.append([1, round(x0 + ((k % nx) + 0.5) * st, 1), round(z0 + ((k // nx) + 0.5) * st, 1), round(h_, 2), round(float(DHf[k]) / 100.0, 2)])
            if not has_u: new_ui.append(k); new_uh.append(int(DHf[k])); new_uk.append(int(DKf[k]))
            DHf[k] = int(round(h_ * 100)); DKf[k] = 1; n1 += 1
        else:
            if UHf[k] != -32768: skip += 1; continue
            if h_ - DHf[k] / 100.0 <= HOLE_BELOW: skip += 1; continue
            applied.append([2, round(x0 + ((k % nx) + 0.5) * st, 1), round(z0 + ((k // nx) + 0.5) * st, 1), round(h_, 2), round(float(DHf[k]) / 100.0, 2)])
            new_ui.append(k); new_uh.append(int(round(h_ * 100))); new_uk.append(1); n2 += 1
    print("cells: under-deck converted", n1, "deck-hole upper added", n2, "skipped", skip, flush=True)
    if os.environ.get("UF_DUMP"): json.dump(applied, open(os.environ["UF_DUMP"], "w"))
    if DRY or not new_ui:
        print("dry/no change"); return
    ui2 = np.concatenate([ui, np.asarray(new_ui, np.int64)]); uh2 = np.concatenate([uh, np.asarray(new_uh, np.int32)]); uk2 = np.concatenate([uk, np.asarray(new_uk, np.uint8)])
    o_ = np.argsort(ui2); ui2, uh2, uk2 = ui2[o_], uh2[o_], uk2[o_]
    upd = ui2.astype(np.int32).tobytes() + uh2.astype(np.int16).tobytes() + uk2.astype(np.uint8).tobytes()
    buf = gres_encode(DH, Hc) + DK.tobytes() + bbits + upd
    comp = zlib.compress(buf, 9); b64 = base64.b64encode(comp)
    open(f"{OUT}/geo_drive.txt", "wb").write(b64)
    dm["up"] = int(len(ui2))
    sc.setdefault("files", {})["drive"] = dict(file="geo_drive.txt", raw=len(buf), size=len(b64))
    json.dump(sc, open(f"{OUT}/scene.json", "w", encoding="utf-8"), ensure_ascii=False)
    print("wrote geo_drive.txt upper", len(ui2), "raw", round(len(buf) / 1e6, 2), "MB", flush=True)

if __name__ == "__main__":
    main()
