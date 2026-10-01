"""国土地理院 標高タイル (dem_png z14) の取得と、世界座標 (x=東, z=南) での補間。outer_tiles.py・mw.py で共有。"""
import math, os, sys, numpy as np, urllib.request, urllib.error
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LAT0, LON0, KX, KZ
CACHE = "/home/claude/wx/outer"; Z = 14
os.makedirs(f"{CACHE}/dem", exist_ok=True)
def ll(x, z): return LAT0 - z / KZ, LON0 + x / KX
def tile_xy(lat, lon, Zz=Z):
    n = 2 ** Zz
    lat = np.asarray(lat, float); lon = np.asarray(lon, float)
    return (lon + 180) / 360 * n, (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / np.pi) / 2 * n
def fetch(url, fn):
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    if os.path.exists(fn + ".404"): return False
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "okaden-sim/1.0"})
            d = urllib.request.urlopen(req, timeout=30).read(); open(fn, "wb").write(d); return True
        except urllib.error.HTTPError as e:
            if e.code == 404: open(fn + ".404", "w").write(""); return False
        except Exception: pass
    return False
def need_tiles(X, Zz, pad=0):
    la, lo = ll(np.asarray(X), np.asarray(Zz)); tx, ty = tile_xy(la, lo)
    return set(zip(np.floor(tx).astype(int).ravel().tolist(), np.floor(ty).astype(int).ravel().tolist()))
def ensure(tiles, workers=8):
    def gd(t): a, b = t; return t, fetch(f"https://cyberjapandata.gsi.go.jp/xyz/dem_png/{Z}/{a}/{b}.png", f"{CACHE}/dem/{Z}_{a}_{b}.png")
    with ThreadPoolExecutor(workers) as ex: return dict(ex.map(gd, sorted(tiles)))
_cache = {}
def dem_tile(a, b):
    k = (a, b)
    if k in _cache: return _cache[k]
    fn = f"{CACHE}/dem/{Z}_{a}_{b}.png"
    if not os.path.exists(fn) or os.path.getsize(fn) == 0: _cache[k] = None; return None
    arr = np.asarray(Image.open(fn).convert("RGB")).astype(np.int64)
    v = arr[:, :, 0] * 65536 + arr[:, :, 1] * 256 + arr[:, :, 2]
    h = np.where(v < 2 ** 23, v, v - 2 ** 24) * 0.01; h[v == 2 ** 23] = np.nan
    _cache[k] = h; return h
def sample(X, Zz):
    """X, Zz: 同形の配列（世界座標 m）→ 標高 m（データなしは NaN）"""
    X = np.asarray(X, float); Zz = np.asarray(Zz, float)
    la, lo = ll(X, Zz); n = 2 ** Z
    tx = (lo + 180) / 360 * n; ty = (1 - np.log(np.tan(np.radians(la)) + 1 / np.cos(np.radians(la))) / np.pi) / 2 * n
    fx = tx * 256 - 0.5; fy = ty * 256 - 0.5
    i0 = np.floor(fx).astype(int); j0 = np.floor(fy).astype(int); ax = fx - i0; ay = fy - j0
    def px(ii, jj):
        r = np.full(ii.shape, np.nan); ta = ii // 256; tb = jj // 256
        for a, b in set(zip(ta.ravel().tolist(), tb.ravel().tolist())):
            m = (ta == a) & (tb == b); h = dem_tile(a, b)
            if h is not None: r[m] = h[jj[m] % 256, ii[m] % 256]
        return r
    V = np.stack([px(i0, j0), px(i0 + 1, j0), px(i0, j0 + 1), px(i0 + 1, j0 + 1)]); good = ~np.isnan(V)
    W = np.stack([(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay]) * good
    s = W.sum(0)
    return np.where(s > 0, (np.nan_to_num(V) * W).sum(0) / np.maximum(s, 1e-9), np.nan)
