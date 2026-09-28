"""v17: 遠景の地形（地図の外）。国土地理院 標高タイル dem_png(z13) と シームレス空中写真(z14) から約 20km 四方。
出力: /home/claude/wx/far_grid.npz（80m 格子の標高 0.1m 単位）・/home/claude/okaden-x/data/far.jpg（2048px）"""
import math, os, io, sys, urllib.request, numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from common import LAT0, LON0, KX, KZ
X0, X1, Z0, Z1, STEP = -8950.0, 11050.0, -9100.0, 10900.0, 80.0
def ll(x, z): return LAT0 - z / KZ, LON0 + x / KX
def tile_xy(lat, lon, Z):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
def fetch(url, fn):
    if os.path.exists(fn): return True
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "okaden-sim/1.0"})
            d = urllib.request.urlopen(req, timeout=30).read(); open(fn, "wb").write(d); return True
        except urllib.error.HTTPError as e:
            if e.code == 404: return False
        except Exception: pass
    return False
def mosaic(kind, Z, ext, sub):
    la0, lo0 = ll(X0, Z1); la1, lo1 = ll(X1, Z0)          # 南西・北東
    tx0, ty1 = tile_xy(la0, lo0, Z); tx1, ty0 = tile_xy(la1, lo1, Z)
    xs = range(int(tx0), int(tx1) + 1); ys = range(int(ty0), int(ty1) + 1)
    jobs = [(x, y) for x in xs for y in ys]
    def get(j):
        x, y = j; return j, fetch(f"https://cyberjapandata.gsi.go.jp/xyz/{kind}/{Z}/{x}/{y}.{ext}", f"/home/claude/wx/far/{sub}/{Z}_{x}_{y}.{ext}")
    with ThreadPoolExecutor(8) as ex: res = dict(ex.map(get, jobs))
    print(kind, "tiles", len(jobs), "ok", sum(res.values()), flush=True)
    W = len(xs) * 256; Hh = len(ys) * 256
    return xs, ys, res, W, Hh
# ---- 標高 ----
Z = 13
xs, ys, res, W, Hh = mosaic("dem_png", Z, "png", "dem")
DEM = np.zeros((Hh, W), np.float32)
for (x, y), ok in res.items():
    if not ok: continue
    a = np.asarray(Image.open(f"/home/claude/wx/far/dem/{Z}_{x}_{y}.png").convert("RGB")).astype(np.int64)
    v = a[:, :, 0] * 65536 + a[:, :, 1] * 256 + a[:, :, 2]
    h = np.where(v < 2 ** 23, v, v - 2 ** 24) * 0.01
    h[v == 2 ** 23] = 0.0
    DEM[(y - ys[0]) * 256:(y - ys[0] + 1) * 256, (x - xs[0]) * 256:(x - xs[0] + 1) * 256] = h
gx = np.arange(X0, X1 + 0.1, STEP); gz = np.arange(Z0, Z1 + 0.1, STEP)
GX, GZ = np.meshgrid(gx, gz)
LA, LO = ll(GX, GZ)
n = 2 ** Z
px = ((LO + 180) / 360 * n - xs[0]) * 256
py = ((1 - np.log(np.tan(np.radians(LA)) + 1 / np.cos(np.radians(LA))) / np.pi) / 2 * n - ys[0]) * 256
i0 = np.clip(np.floor(px - 0.5).astype(int), 0, W - 2); j0 = np.clip(np.floor(py - 0.5).astype(int), 0, Hh - 2)
tx = np.clip(px - 0.5 - i0, 0, 1); tz = np.clip(py - 0.5 - j0, 0, 1)
Hgrid = (DEM[j0, i0] * (1 - tx) + DEM[j0, i0 + 1] * tx) * (1 - tz) + (DEM[j0 + 1, i0] * (1 - tx) + DEM[j0 + 1, i0 + 1] * tx) * tz
Hgrid = np.maximum(Hgrid, -1.0)
print("grid", Hgrid.shape, "h range", float(Hgrid.min()), float(Hgrid.max()), flush=True)
np.savez("/home/claude/wx/far_grid.npz", H=np.round(Hgrid * 10).astype(np.int16), x0=X0, z0=Z0, step=STEP)
# ---- 写真 ----
Z = 14
xs, ys, res, W, Hh = mosaic("seamlessphoto", Z, "jpg", "pho")
M = Image.new("RGB", (W, Hh), (110, 120, 100))
for (x, y), ok in res.items():
    if not ok: continue
    try: M.paste(Image.open(f"/home/claude/wx/far/pho/{Z}_{x}_{y}.jpg").convert("RGB"), ((x - xs[0]) * 256, (y - ys[0]) * 256))
    except Exception as e: print("bad", x, y, e)
M = np.asarray(M)
N = 2048
u = np.linspace(X0, X1, N); v = np.linspace(Z0, Z1, N)
UX, VZ = np.meshgrid(u, v)
LA, LO = ll(UX, VZ); n = 2 ** Z
px = ((LO + 180) / 360 * n - xs[0]) * 256
py = ((1 - np.log(np.tan(np.radians(LA)) + 1 / np.cos(np.radians(LA))) / np.pi) / 2 * n - ys[0]) * 256
# 縮小なので 2x2 の平均で取る
out = np.zeros((N, N, 3), np.float32)
for dx in (-0.25, 0.25):
    for dz in (-0.25, 0.25):
        sc = (X1 - X0) / N / (40075016.0 * math.cos(math.radians(LAT0)) / n / 256)
        ii = np.clip((px + dx * sc).astype(int), 0, W - 1); jj = np.clip((py + dz * sc).astype(int), 0, Hh - 1)
        out += M[jj, ii]
out /= 4
Image.fromarray(out.astype(np.uint8)).save("/home/claude/wx/far_raw.jpg", quality=90)
# 写真の出どころ（撮影時期）の違いで色の違う区画を合わせる（2048px での境界: x=496・1108・1313、y=448）
I = out.astype(np.float64); O = I.copy()
def _st(sl): r = I[sl].reshape(-1, 3); return r.mean(0), r.std(0) + 1e-6
def _xfer(block, src, ref):
    ms, ss = _st(src); mr, sr = _st(ref); O[block] = (I[block] - ms) / ss * sr + mr
_C = (slice(0, 448), slice(1313, 2048))
_xfer((slice(0, 448), slice(0, 1108)), (slice(0, 448), slice(0, 1108)), _C)
_xfer((slice(0, 448), slice(1108, 1313)), (slice(0, 448), slice(1108, 1313)), _C)
_xfer((slice(448, 2048), slice(0, 496)), (slice(448, 2048), slice(406, 496)), (slice(448, 2048), slice(497, 587)))
Image.fromarray(np.clip(O, 0, 255).astype(np.uint8)).save("/home/claude/wx/far.jpg", quality=84)
print("far.jpg", os.path.getsize("/home/claude/wx/far.jpg"), "(build_v5 がデータへ写す)", flush=True)
