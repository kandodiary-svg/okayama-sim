"""v37: 外側の地形タイル（遠景の 20km 四方の外・山陽新幹線と山陽自動車道の沿線）。
v36 は新幹線の沿線だけ（2km 四方・40m 格子・512px）だった。v37 は山陽道の沿線を足し、道路の近くは細かくして道路に合わせて掘る。
  粗いタイル  : 2km（世界座標の格子 i=floor(x/2000)）・51×51 点（40m）・512px。 新幹線・山陽道の 2.6km 以内。
  細かいタイル: 山陽道の 700m 以内。201×201 点（10m）・1024px。道路の切土（のりめん）を標高に反映する（carve）。
  遠景の中の細かいタイル（FF）: 遠景の範囲（20km 四方）の中は遠景の地形があるので、山陽道が通る所だけ、遠景の格子（80m）に揃えた 2km 四方のブロックを細かいタイルにする
      （遠景の地形は、このブロックの内側の頂点を大きく下げて下に隠す。ブロックの縁の標高は遠景の格子の補間に合わせる）。
  縁: 解像度が違うタイルが接する縁は、細かい方を粗い方の補間に合わせる（割れ目を出さない）。
出力: data/outer.json（目録）・data/outer_h.bin（全タイルの標高 Int16, 0.1m）・data/outer/{t_i_j, f_a_b}.jpg
標高: 国土地理院 dem_png z14（demz.py）・写真: シームレス空中写真（粗い: z15, 細かい: z16）"""
import math, os, sys, json, zlib, base64, pickle, urllib.request, numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LAT0, LON0, KX, KZ
from jr_hs import chains_hs
import demz
from demz import ll, tile_xy, fetch
OUT = "/home/claude/okaden-x/data"; CACHE = "/home/claude/wx/outer"; EXP = "/home/claude/wx/exp"
CELL = 2000.0
FAR = (-8950.0, -9100.0, 11050.0, 10900.0)       # 遠景の範囲 (x0, z0, x1, z1)
HOLE = (-4048.0, -4692.0, 7308.0, 4432.0)        # データ（PLATEAU）の範囲
WEST, EAST = -52500.0, 51800.0                    # 福山駅の西 1.5km 〜 相生駅の東 1km
BUF = 2600.0                                      # 粗いタイル: 線路・道路から
BUF_FINE = 700.0                                  # 細かいタイル: 山陽道から
NH_C, NH_F = 51, 201
PX_C, PX_F = 512, 1024
CARVE_SLOPE = 0.7                                 # 切土ののりめん（1:1.4）
os.makedirs(f"{CACHE}/pho", exist_ok=True); os.makedirs(f"{OUT}/outer", exist_ok=True)

def far_heights():
    s = json.load(open(f"{OUT}/scene.json")); m = s["far"]
    raw = zlib.decompress(base64.b64decode(open(f"{OUT}/geo_far.txt", "rb").read()))
    A = np.frombuffer(raw, np.int16).reshape(m["nz"], m["nx"]).astype(float) / 10.0
    return m, A
def far_interp(m, A, X, Z):
    fx = (X - m["x0"]) / m["step"]; fz = (Z - m["z0"]) / m["step"]
    i = np.clip(np.floor(fx).astype(int), 0, m["nx"] - 2); j = np.clip(np.floor(fz).astype(int), 0, m["nz"] - 2)
    tx = np.clip(fx - i, 0, 1); tz = np.clip(fz - j, 0, 1)
    return (A[j, i] * (1 - tx) + A[j, i + 1] * tx) * (1 - tz) + (A[j + 1, i] * (1 - tx) + A[j + 1, i + 1] * tx) * tz

def road_samples():
    """山陽道の点（道路面の高さ付き）。戻り: 全点 (x,z), 掘る点 (x,z,h,W)"""
    C = pickle.load(open(f"{EXP}/mw_prof.pkl", "rb"))
    allp = []; car = []
    for c in C:
        Q = c["Q"]; n = len(Q); allp.append(Q)
        tn = c["tn"].copy()
        # 坑口の前後 25m（5 点）は掘る点に入れる（坑口へつながる切土）
        d = np.diff(tn.astype(int)); edge = np.zeros(n, bool)
        for q in list(np.flatnonzero(d == 1)) + list(np.flatnonzero(d == -1)):
            edge[max(0, q - 4):q + 6] = True
        use = ~tn | edge
        W = np.maximum(c["lanes"], 1) * 1.75 + 3.0
        car.append(np.stack([Q[use, 0], Q[use, 1], c["h"][use], W[use]], axis=1))
    return np.concatenate(allp), np.concatenate(car)

def pick(road_pts, shin_pts):
    """タイルの一覧。戻り: [dict(kind='W'|'F'|'FF', i,j or a,b, x0,z0, nh)]"""
    tr_r = cKDTree(road_pts); tr_s = cKDTree(shin_pts)
    tiles = []
    def near(cx, cz, tr, buf): return tr.query([cx, cz])[0] < buf + CELL * 0.71
    def dist_box(x0, z0, x1, z1, tr):
        # セルの箱から木までの最短（箱の中の格子点で近似）
        g = np.array([[x, z] for x in np.linspace(x0, x1, 5) for z in np.linspace(z0, z1, 5)])
        return tr.query(g)[0].min()
    lo = (int(math.floor(min(road_pts[:, 0].min(), shin_pts[:, 0].min()) / CELL)) - 2, int(math.floor(min(road_pts[:, 1].min(), shin_pts[:, 1].min()) / CELL)) - 2)
    hi = (int(math.floor(max(road_pts[:, 0].max(), shin_pts[:, 0].max()) / CELL)) + 2, int(math.floor(max(road_pts[:, 1].max(), shin_pts[:, 1].max()) / CELL)) + 2)
    for j in range(lo[1], hi[1] + 1):
        for i in range(lo[0], hi[0] + 1):
            x0, z0, x1, z1 = i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL
            if x0 >= FAR[0] and x1 <= FAR[2] and z0 >= FAR[1] and z1 <= FAR[3]: continue       # 遠景の中
            cx, cz = x0 + CELL / 2, z0 + CELL / 2
            dr = tr_r.query([cx, cz])[0]; ds = tr_s.query([cx, cz])[0]
            if dr > BUF + CELL * 1.5 and ds > BUF + CELL * 1.5: continue
            dr = dist_box(x0, z0, x1, z1, tr_r); ds = dist_box(x0, z0, x1, z1, tr_s)
            if dr < BUF_FINE: tiles.append(dict(kind="F", i=i, j=j, x0=x0, z0=z0, s=CELL, nh=NH_F, px=PX_F, key=f"t_{i}_{j}"))
            elif dr < BUF or ds < BUF: tiles.append(dict(kind="W", i=i, j=j, x0=x0, z0=z0, s=CELL, nh=NH_C, px=PX_C, key=f"t_{i}_{j}"))
    # 遠景の中の細かいブロック
    for b in range(10):
        for a in range(10):
            x0, z0 = FAR[0] + a * CELL, FAR[1] + b * CELL
            if dist_box(x0, z0, x0 + CELL, z0 + CELL, tr_r) < BUF_FINE:
                tiles.append(dict(kind="FF", i=a, j=b, x0=x0, z0=z0, s=CELL, nh=NH_F, px=PX_F, key=f"f_{a}_{b}"))
    return tiles

def carve(X, Z, H, tr, car, step):
    """H（標高 m）を、道路面 − 0.7m を上限にした切土の形に下げる。のりめんは 1:1.4。底の平らな幅は 道路の半幅 + 格子の間隔"""
    d0, _ = tr.query(np.stack([X.ravel(), Z.ravel()], 1), k=1, distance_upper_bound=120.0)
    near = np.flatnonzero(np.isfinite(d0))
    if len(near) == 0: return H, 0
    P = np.stack([X.ravel()[near], Z.ravel()[near]], 1)
    d, ids = tr.query(P, k=24, distance_upper_bound=120.0)
    ok = np.isfinite(d); ids = np.where(ok, ids, 0)
    hr = car[ids, 2]; W = car[ids, 3]
    ceil = hr - 0.7 + CARVE_SLOPE * np.maximum(0, d - (W + step))
    ceil = np.where(ok, ceil, np.inf).min(axis=1)
    Hf = H.ravel().copy(); old = Hf[near].copy(); Hf[near] = np.minimum(old, ceil)
    return Hf.reshape(H.shape), int((Hf[near] < old - 0.05).sum())

def build(only_geom=False):
    road_pts, car = road_samples()
    P = chains_hs()[0][0]; P = P[(P[:, 0] > WEST) & (P[:, 0] < EAST)]
    shin = []
    for a, b in zip(P[:-1], P[1:]):
        L = np.hypot(*(b - a)); k = max(1, int(L / 200))
        for t in np.linspace(0, 1, k, endpoint=False): shin.append(a + (b - a) * t)
    shin = np.array(shin)
    tiles = pick(road_pts, shin)
    print("tiles", len(tiles), {k: sum(1 for t in tiles if t["kind"] == k) for k in ("W", "F", "FF")}, flush=True)
    # ---- 標高 (z14) ----
    need = set()
    for t in tiles:
        g = np.array([[t["x0"] - 160, t["z0"] - 160], [t["x0"] + t["s"] + 160, t["z0"] - 160], [t["x0"] - 160, t["z0"] + t["s"] + 160], [t["x0"] + t["s"] + 160, t["z0"] + t["s"] + 160]])
        la, lo = ll(g[:, 0], g[:, 1]); ta, tb = tile_xy(la, lo)
        for a in range(int(ta.min()), int(ta.max()) + 1):
            for b in range(int(tb.min()), int(tb.max()) + 1): need.add((a, b))
    res = demz.ensure(need)
    print("dem tiles", len(need), "ok", sum(res.values()), flush=True)
    fm, FA = far_heights()
    tr_car = cKDTree(car[:, :2])
    for t in tiles:
        n = t["nh"]; st = t["s"] / (n - 1)
        gx = t["x0"] + np.arange(n) * st; gz = t["z0"] + np.arange(n) * st
        X, Z = np.meshgrid(gx, gz); h = demz.sample(X, Z)
        h = np.where(np.isnan(h), 0.0, h)
        h = np.maximum(h, -1.0)
        t["H"] = h; t["step"] = st
        if t["kind"] != "W":
            h2, cnt = carve(X, Z, h, tr_car, car, st); t["H"] = h2; t["carved"] = cnt
        # 遠景の格子の縁（FF ブロックの縁・遠景の範囲の縁に載る頂点）は遠景の補間に合わせる
        if t["kind"] in ("FF", "F"):
            on = (np.abs(X - FAR[0]) < 1e-6) | (np.abs(X - FAR[2]) < 1e-6) | (np.abs(Z - FAR[1]) < 1e-6) | (np.abs(Z - FAR[3]) < 1e-6)
            if t["kind"] == "FF":
                on = on | (np.abs(X - t["x0"]) < 1e-6) | (np.abs(X - t["x0"] - t["s"]) < 1e-6) | (np.abs(Z - t["z0"]) < 1e-6) | (np.abs(Z - t["z0"] - t["s"]) < 1e-6)
            inrect = (X >= FAR[0] - 1e-6) & (X <= FAR[2] + 1e-6) & (Z >= FAR[1] - 1e-6) & (Z <= FAR[3] + 1e-6)
            m = on & inrect
            if m.any(): t["H"] = np.where(m, far_interp(fm, FA, X, Z), t["H"])
    # ---- 解像度の違う縁: 細かい方を粗い方の補間に合わせる ----
    byw = {(t["i"], t["j"]): t for t in tiles if t["kind"] in ("W", "F")}
    byf = {(t["i"], t["j"]): t for t in tiles if t["kind"] == "FF"}
    def edge(t, side):
        n = t["nh"]
        return {"W": (slice(None), 0), "E": (slice(None), n - 1), "N": (0, slice(None)), "S": (n - 1, slice(None))}[side]   # H[z, x]
    adj = [("W", -1, 0, "E"), ("E", 1, 0, "W"), ("N", 0, -1, "S"), ("S", 0, 1, "N")]
    nfix = 0
    for lat in (byw, byf):
        for (i, j), t in lat.items():
            for side, di, dj, opp in adj:
                u = lat.get((i + di, j + dj))
                if u is None or u["nh"] >= t["nh"]: continue
                # u の縁の標高を t の縁の位置へ線形補間
                ev = u["H"][edge(u, opp)]; pu = np.linspace(0, 1, u["nh"]); pt = np.linspace(0, 1, t["nh"])
                t["H"][edge(t, side)] = np.interp(pt, pu, ev); nfix += 1
    print("edge fixes", nfix, flush=True)
    # ---- 書き出し ----
    arr = []; o = 0; man_t = []
    for t in tiles:
        q = np.round(t["H"] * 10).astype(np.int16); arr.append(q.ravel())
        man_t.append(dict(k=o, key=t["key"], kind=t["kind"], i=t["i"], j=t["j"], x0=t["x0"], z0=t["z0"], s=t["s"], nh=t["nh"], px=t["px"])); o += q.size
    open(f"{OUT}/outer_h.bin", "wb").write(np.concatenate(arr).tobytes())
    print("heights", o, "int16 =", o * 2 / 1e6, "MB", flush=True)
    # ---- 写真 ----
    photos(tiles)
    drop = [[t["x0"], t["z0"], t["x0"] + t["s"], t["z0"] + t["s"]] for t in tiles if t["kind"] == "FF"]
    man = dict(cell=CELL, far=list(FAR), hole=list(HOLE), drop=drop, tiles=man_t,
               note="標高: 国土地理院 標高タイル(dem_png z14)、写真: 国土地理院 シームレス空中写真(z15/z16)。山陽道の沿線は道路面に合わせて切土を標高に反映（推定）")
    json.dump(man, open(f"{OUT}/outer.json", "w"), ensure_ascii=False, separators=(",", ":"))
    print("done", len(tiles), flush=True)

def photos(tiles):
    jobs = []
    for t in tiles:
        fn = f"{OUT}/outer/{t['key']}.jpg"
        if os.path.exists(fn):
            try:
                if Image.open(fn).size == (t["px"], t["px"]): continue
            except Exception: pass
        jobs.append(t)
    print("photos to make", len(jobs), flush=True)
    need = {15: set(), 16: set()}
    for t in jobs:
        Zp = 15 if t["px"] == PX_C else 16; n = 2 ** Zp
        la0, lo0 = ll(t["x0"] - 8, t["z0"] + t["s"] + 8); la1, lo1 = ll(t["x0"] + t["s"] + 8, t["z0"] - 8)
        ta, tb = tile_xy(la0, lo0, Zp); tc, td = tile_xy(la1, lo1, Zp)
        for a in range(int(ta), int(tc) + 1):
            for b in range(int(td), int(tb) + 1): need[Zp].add((a, b))
    for Zp, s in need.items():
        def gp(tt, Zp=Zp): a, b = tt; return tt, fetch(f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{Zp}/{a}/{b}.jpg", f"{CACHE}/pho/{Zp}_{a}_{b}.jpg")
        with ThreadPoolExecutor(12) as ex: r = dict(ex.map(gp, sorted(s)))
        print("photo tiles z", Zp, len(s), "ok", sum(r.values()), flush=True)
    pc = {}
    def ptile(Zp, a, b):
        k = (Zp, a, b)
        if k not in pc:
            fn = f"{CACHE}/pho/{Zp}_{a}_{b}.jpg"
            pc[k] = np.asarray(Image.open(fn).convert("RGB")) if os.path.exists(fn) and os.path.getsize(fn) > 0 else None
            if len(pc) > 400: pc.pop(next(iter(pc)))
        return pc[k]
    for q, t in enumerate(jobs):
        Zp = 15 if t["px"] == PX_C else 16; n = 2 ** Zp; NP = t["px"]; CELLs = t["s"]
        u = t["x0"] + (np.arange(NP) + 0.5) * (CELLs / NP); v = t["z0"] + (np.arange(NP) + 0.5) * (CELLs / NP)
        UX, VZ = np.meshgrid(u, v); la, lo = ll(UX, VZ)
        tx = (lo + 180) / 360 * n; ty = (1 - np.log(np.tan(np.radians(la)) + 1 / np.cos(np.radians(la))) / np.pi) / 2 * n
        fx = tx * 256 - 0.5; fy = ty * 256 - 0.5
        i0 = np.floor(fx).astype(int); j0 = np.floor(fy).astype(int); ax = (fx - i0)[..., None]; ay = (fy - j0)[..., None]
        def px(ii, jj):
            r = np.full(ii.shape + (3,), 100.0); ta = ii // 256; tb = jj // 256
            for a, b in set(zip(ta.ravel().tolist(), tb.ravel().tolist())):
                m = (ta == a) & (tb == b); tt = ptile(Zp, a, b)
                if tt is not None: r[m] = tt[jj[m] % 256, ii[m] % 256]
            return r
        img = px(i0, j0) * (1 - ax) * (1 - ay) + px(i0 + 1, j0) * ax * (1 - ay) + px(i0, j0 + 1) * (1 - ax) * ay + px(i0 + 1, j0 + 1) * ax * ay
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(f"{OUT}/outer/{t['key']}.jpg", quality=80 if NP == PX_C else 76)
        if q % 10 == 0: print("photo", q, "/", len(jobs), flush=True)

if __name__ == "__main__": build()
