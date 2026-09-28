"""国土地理院 シームレス空中写真(z18) を取得し、ローカル座標(0.5m/px)のオルソ画像に再投影"""
import math, os, io, sys, urllib.request
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from common import LAT0, LON0, KX, KZ, latlon_bbox, BX0, BZ0, BX1, BZ1
Z = 18
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = latlon_bbox(300.0)   # v29: データ範囲（bounds.json）の 300m 外側まで
def t_of(lat, lon):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
x0, y1 = t_of(LAT_MIN, LON_MIN); x1, y0 = t_of(LAT_MAX, LON_MAX)
xs = range(int(x0), int(x1) + 1); ys = range(int(y0), int(y1) + 1)
jobs = [(x, y) for x in xs for y in ys]
print("tiles", len(jobs), flush=True)
def get(xy):
    x, y = xy
    fn = f"/home/claude/wx/ortho/tiles/{x}_{y}.jpg"
    if os.path.exists(fn): return
    for _ in range(3):
        try:
            d = urllib.request.urlopen(f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{Z}/{x}/{y}.jpg", timeout=20).read()
            open(fn, "wb").write(d); return
        except Exception as e:
            err = e
    print("fail", xy, err, flush=True)
with ThreadPoolExecutor(12) as ex: list(ex.map(get, jobs))
# モザイク(タイル画素)
TX0, TY0 = int(x0), int(y0)
W = (len(xs)) * 256; H = (len(ys)) * 256
mos = Image.new("RGB", (W, H), (90, 90, 90))
for x, y in jobs:
    fn = f"/home/claude/wx/ortho/tiles/{x}_{y}.jpg"
    if os.path.exists(fn):
        try: mos.paste(Image.open(fn).convert("RGB"), ((x - TX0) * 256, (y - TY0) * 256))
        except Exception: pass
M = np.asarray(mos)
# ローカル格子 0.5m
RES = 0.5
GX0, GZ0 = BX0, BZ0
NX, NZ = int(round((BX1 - BX0) / RES)), int(round((BZ1 - BZ0) / RES))
gx = GX0 + (np.arange(NX) + 0.5) * RES
gz = GZ0 + (np.arange(NZ) + 0.5) * RES
lon = LON0 + gx / KX
lat = LAT0 - gz / KZ
n = 2 ** Z
px = ((lon + 180) / 360 * n - TX0) * 256
latr = np.radians(lat)
py = ((1 - np.log(np.tan(latr) + 1 / np.cos(latr)) / math.pi) / 2 * n - TY0) * 256
# 双線形補間（メモリ節約のため行ブロックごと）
out = np.lib.format.open_memmap("/home/claude/wx/ortho/ortho_local.npy", mode="w+", dtype=np.uint8, shape=(NZ, NX, 3))
i0 = np.clip(np.floor(px - 0.5).astype(int), 0, W - 2); fx = np.clip(px - 0.5 - i0, 0, 1)[None, :, None]
for r0 in range(0, NZ, 256):
    r1 = min(NZ, r0 + 256)
    PY = py[r0:r1]
    j0 = np.clip(np.floor(PY - 0.5).astype(int), 0, H - 2); fy = np.clip(PY - 0.5 - j0, 0, 1)[:, None, None]
    A = M[j0][:, i0].astype(np.float32); B = M[j0][:, i0 + 1].astype(np.float32)
    C = M[j0 + 1][:, i0].astype(np.float32); D = M[j0 + 1][:, i0 + 1].astype(np.float32)
    v = (A * (1 - fx) + B * fx) * (1 - fy) + (C * (1 - fx) + D * fx) * fy
    out[r0:r1] = np.clip(v, 0, 255).astype(np.uint8)
out.flush()

Image.fromarray(out).resize((NX // 8, NZ // 8)).save("/home/claude/wx/ortho/preview.jpg")
print("ortho", out.shape, "origin", GX0, GZ0, "res", RES)
