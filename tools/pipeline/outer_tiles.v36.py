"""v36: 外側の地形タイル（遠景の 20km 四方の外）。山陽新幹線の線路沿い（福山〜相生）に、2km 四方のタイルを置く。
標高: 国土地理院 標高タイル dem_png (z14, 約 8m 格子) → 40m 格子（51×51 点）の 0.1m 単位 Int16
写真: シームレス空中写真 (z15, 約 3.9m/画素) → 512×512 の JPEG
出力: data/outer.json（目録）・data/outer_h.bin（全タイルの標高）・data/outer/t_{i}_{j}.jpg
世界座標の 2000m 格子（i = floor(x/2000), j = floor(z/2000)）に合わせる。遠景の 20km 四方の中は、遠景の地形があるので作らない。"""
import math, os, sys, json, urllib.request, numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LAT0, LON0, KX, KZ
from jr_hs import chains_hs
OUT = "/home/claude/okaden-x/data"; CACHE = "/home/claude/wx/outer"
CELL = 2000.0; NH = 51; NP = 512
FAR = (-8950.0, -9100.0, 11050.0, 10900.0)       # 遠景の範囲 (x0, z0, x1, z1)
WEST, EAST = -52500.0, 51800.0                    # 福山駅の西 1.5km 〜 相生駅の東 1km
BUF = 2600.0
os.makedirs(f"{CACHE}/dem", exist_ok=True); os.makedirs(f"{CACHE}/pho", exist_ok=True); os.makedirs(f"{OUT}/outer", exist_ok=True)
def ll(x, z): return LAT0 - z / KZ, LON0 + x / KX
def fetch(url, fn):
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "okaden-sim/1.0"})
            d = urllib.request.urlopen(req, timeout=30).read(); open(fn, "wb").write(d); return True
        except urllib.error.HTTPError as e:
            if e.code == 404: open(fn + ".404", "w").write(""); return False
        except Exception: pass
    return False
def tile_xy(lat, lon, Z):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
def pick_cells():
    P = chains_hs()[0][0]; P = P[(P[:, 0] > WEST) & (P[:, 0] < EAST)]
    pts = []
    for a, b in zip(P[:-1], P[1:]):
        L = np.hypot(*(b - a)); k = max(1, int(L / 200))
        for t in np.linspace(0, 1, k, endpoint=False): pts.append(a + (b - a) * t)
    pts = np.array(pts)
    i0, i1 = int(math.floor(pts[:, 0].min() / CELL)) - 2, int(math.floor(pts[:, 0].max() / CELL)) + 2
    j0, j1 = int(math.floor(pts[:, 1].min() / CELL)) - 2, int(math.floor(pts[:, 1].max() / CELL)) + 2
    from scipy.spatial import cKDTree
    tr = cKDTree(pts); cells = []
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            cx, cz = (i + 0.5) * CELL, (j + 0.5) * CELL
            x0, z0, x1, z1 = i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL
            if x0 >= FAR[0] and x1 <= FAR[2] and z0 >= FAR[1] and z1 <= FAR[3]: continue       # 遠景の中
            d, _ = tr.query([cx, cz])
            if d < BUF: cells.append((i, j))
    return cells, P
def build():
    cells, P = pick_cells(); print("cells", len(cells), flush=True)
    # ---- 標高 (z14) ----
    Z = 14; need = set(); sub = 8
    for (i, j) in cells:
        for x in (i * CELL - 160, (i + 1) * CELL + 160):
            for z in (j * CELL - 160, (j + 1) * CELL + 160):
                la, lo = ll(x, z); tx, ty = tile_xy(la, lo, Z); need.add((int(tx), int(ty)))
    xs0 = min(a for a, b in need); xs1 = max(a for a, b in need); ys0 = min(b for a, b in need); ys1 = max(b for a, b in need)
    allneed = {(a, b) for a in range(xs0, xs1 + 1) for b in range(ys0, ys1 + 1)}
    # 使うタイルだけ（セルの四隅の外接で足りない場合に備え、セルごとに範囲を取る）
    need = set()
    for (i, j) in cells:
        la0, lo0 = ll(i * CELL - 160, (j + 1) * CELL + 160); la1, lo1 = ll((i + 1) * CELL + 160, j * CELL - 160)
        ta, tb = tile_xy(la0, lo0, Z); tc, td = tile_xy(la1, lo1, Z)
        for a in range(int(ta), int(tc) + 1):
            for b in range(int(td), int(tb) + 1): need.add((a, b))
    def gd(t): a, b = t; return t, fetch(f"https://cyberjapandata.gsi.go.jp/xyz/dem_png/{Z}/{a}/{b}.png", f"{CACHE}/dem/{Z}_{a}_{b}.png")
    with ThreadPoolExecutor(8) as ex: dres = dict(ex.map(gd, sorted(need)))
    print("dem tiles", len(need), "ok", sum(dres.values()), flush=True)
    cache = {}
    def dem_tile(a, b):
        k = (a, b)
        if k in cache: return cache[k]
        fn = f"{CACHE}/dem/{Z}_{a}_{b}.png"
        if not os.path.exists(fn) or os.path.getsize(fn) == 0: cache[k] = None; return None
        arr = np.asarray(Image.open(fn).convert("RGB")).astype(np.int64)
        v = arr[:, :, 0] * 65536 + arr[:, :, 1] * 256 + arr[:, :, 2]
        h = np.where(v < 2 ** 23, v, v - 2 ** 24) * 0.01; h[v == 2 ** 23] = np.nan
        cache[k] = h; return h
    def sample_dem(X, Zz):
        la, lo = ll(X, Zz); n = 2 ** Z
        tx = (lo + 180) / 360 * n; ty = (1 - np.log(np.tan(np.radians(la)) + 1 / np.cos(np.radians(la))) / np.pi) / 2 * n
        out = np.full(X.shape, np.nan)
        # 画素の中心で補間
        fx = tx * 256 - 0.5; fy = ty * 256 - 0.5
        i0 = np.floor(fx).astype(int); j0 = np.floor(fy).astype(int); ax = fx - i0; ay = fy - j0
        def px(ii, jj):
            r = np.full(ii.shape, np.nan)
            ta = ii // 256; tb = jj // 256
            for a, b in set(zip(ta.ravel().tolist(), tb.ravel().tolist())):
                m = (ta == a) & (tb == b); h = dem_tile(a, b)
                if h is not None: r[m] = h[jj[m] % 256, ii[m] % 256]
            return r
        v00 = px(i0, j0); v10 = px(i0 + 1, j0); v01 = px(i0, j0 + 1); v11 = px(i0 + 1, j0 + 1)
        V = np.stack([v00, v10, v01, v11]); good = ~np.isnan(V)
        W = np.stack([(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay]) * good
        s = W.sum(0); val = np.where(s > 0, (np.nan_to_num(V) * W).sum(0) / np.maximum(s, 1e-9), np.nan)
        return val
    hs = np.zeros((len(cells), NH, NH), np.int16)
    for k, (i, j) in enumerate(cells):
        gx = i * CELL + np.arange(NH) * (CELL / (NH - 1)); gz = j * CELL + np.arange(NH) * (CELL / (NH - 1))
        X, Zz = np.meshgrid(gx, gz); h = sample_dem(X, Zz)
        h = np.where(np.isnan(h), 0.0, h)                       # データのない所（海）は 0m
        hs[k] = np.round(np.maximum(h, -1.0) * 10).astype(np.int16)
    open(f"{OUT}/outer_h.bin", "wb").write(hs.tobytes())
    print("heights", hs.shape, "range", hs.min() / 10, hs.max() / 10, flush=True)
    # ---- 写真 (z15) ----
    Zp = 15; need = set(); n = 2 ** Zp
    for (i, j) in cells:
        la0, lo0 = ll(i * CELL - 8, (j + 1) * CELL + 8); la1, lo1 = ll((i + 1) * CELL + 8, j * CELL - 8)
        ta, tb = tile_xy(la0, lo0, Zp); tc, td = tile_xy(la1, lo1, Zp)
        for a in range(int(ta), int(tc) + 1):
            for b in range(int(td), int(tb) + 1): need.add((a, b))
    def gp(t): a, b = t; return t, fetch(f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{Zp}/{a}/{b}.jpg", f"{CACHE}/pho/{Zp}_{a}_{b}.jpg")
    with ThreadPoolExecutor(8) as ex: pres = dict(ex.map(gp, sorted(need)))
    print("photo tiles", len(need), "ok", sum(pres.values()), flush=True)
    pc = {}
    def ptile(a, b):
        if (a, b) not in pc:
            fn = f"{CACHE}/pho/{Zp}_{a}_{b}.jpg"
            pc[(a, b)] = np.asarray(Image.open(fn).convert("RGB")) if os.path.exists(fn) and os.path.getsize(fn) > 0 else None
        return pc[(a, b)]
    for k, (i, j) in enumerate(cells):
        u = i * CELL + (np.arange(NP) + 0.5) * (CELL / NP); v = j * CELL + (np.arange(NP) + 0.5) * (CELL / NP)
        UX, VZ = np.meshgrid(u, v); la, lo = ll(UX, VZ)
        tx = (lo + 180) / 360 * n; ty = (1 - np.log(np.tan(np.radians(la)) + 1 / np.cos(np.radians(la))) / np.pi) / 2 * n
        fx = tx * 256 - 0.5; fy = ty * 256 - 0.5
        i0 = np.floor(fx).astype(int); j0 = np.floor(fy).astype(int); ax = (fx - i0)[..., None]; ay = (fy - j0)[..., None]
        def px(ii, jj):
            r = np.full(ii.shape + (3,), 100.0)
            ta = ii // 256; tb = jj // 256
            for a, b in set(zip(ta.ravel().tolist(), tb.ravel().tolist())):
                m = (ta == a) & (tb == b); t = ptile(a, b)
                if t is not None: r[m] = t[jj[m] % 256, ii[m] % 256]
            return r
        img = px(i0, j0) * (1 - ax) * (1 - ay) + px(i0 + 1, j0) * ax * (1 - ay) + px(i0, j0 + 1) * (1 - ax) * ay + px(i0 + 1, j0 + 1) * ax * ay
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(f"{OUT}/outer/t_{i}_{j}.jpg", quality=80)
        if k % 20 == 0: print("photo", k, "/", len(cells), flush=True)
    man = dict(cell=CELL, nh=NH, far=list(FAR), tiles=[dict(i=i, j=j, k=k) for k, (i, j) in enumerate(cells)],
               note="標高: 国土地理院 標高タイル(dem_png z14)、写真: 国土地理院 シームレス空中写真(z15)")
    json.dump(man, open(f"{OUT}/outer.json", "w"), ensure_ascii=False)
    print("done", len(cells), "tiles", sum(os.path.getsize(f"{OUT}/outer/t_{i}_{j}.jpg") for i, j in cells) / 1e6, "MB photos", flush=True)
if __name__ == "__main__": build()
