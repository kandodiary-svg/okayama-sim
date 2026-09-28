"""出力済みの地形・道路・軌道のジオメトリ（data/geo_*.txt）を読み、指定範囲の「いちばん上の走行面」をラスタ化して
・隙間（道路・軌道敷の三角形が無い所 → 下の地面や水が見える）
・段差（隣り合うセルの高さの差）
・凸凹（道路の進行方向の 2 階差分）
を数える。使い方: python3 check_surface.py x0 z0 x1 z1 [out.png] [axis_deg]
"""
import sys, os, json, base64, zlib, numpy as np
from PIL import Image, ImageDraw
D = "/home/claude/okaden-x/data"
sc = json.load(open(f"{D}/scene.json"))
x0, z0, x1, z1 = [float(v) for v in sys.argv[1:5]]
out = sys.argv[5] if len(sys.argv) > 5 else None
RES = 0.25
nx = int((x1 - x0) / RES); nz = int((z1 - z0) / RES)
top = np.full((nz, nx), -1e9); kind = np.zeros((nz, nx), np.uint8)   # 1 road/track 2 paving/walk 3 bridge rail etc
bufs = {}
def buf(k):
    if k not in bufs: import geo_io; bufs[k] = geo_io.read(k)
    return bufs[k]
LAY = {("road", "asphalt"): 1, ("road", "color"): 1, ("road", "paving"): 2, ("road", "island"): 2, ("track", "trackbed"): 1, ("track", "grass"): 1,
       ("mark", "paint"): 0, ("track", "color"): 0, ("track", "rail"): 0}
def raster(tri, val):
    # 三角形を高さ付きでラスタ化（z-buffer の最大値）
    for t in tri:
        xs = (t[:, 0] - x0) / RES; zs = (t[:, 2] - z0) / RES
        i0 = max(0, int(np.floor(xs.min()))); i1 = min(nx - 1, int(np.ceil(xs.max())))
        j0 = max(0, int(np.floor(zs.min()))); j1 = min(nz - 1, int(np.ceil(zs.max())))
        if i1 < i0 or j1 < j0: continue
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1) + 0.5, np.arange(j0, j1 + 1) + 0.5)
        a = np.array([xs[0], zs[0]]); b = np.array([xs[1], zs[1]]); c = np.array([xs[2], zs[2]])
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-9: continue
        w0 = ((b[1] - c[1]) * (ii - c[0]) + (c[0] - b[0]) * (jj - c[1])) / den
        w1 = ((c[1] - a[1]) * (ii - c[0]) + (a[0] - c[0]) * (jj - c[1])) / den
        w2 = 1 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any(): continue
        y = w0 * t[0, 1] + w1 * t[1, 1] + w2 * t[2, 1]
        sub = top[j0:j1 + 1, i0:i1 + 1]; ks = kind[j0:j1 + 1, i0:i1 + 1]
        upd = m & (y > sub)
        sub[upd] = y[upd]; ks[upd] = val
USE_PKL = os.environ.get("PKL")
if USE_PKL:
    import pickle
    _R = pickle.load(open(USE_PKL, "rb"))
    for cat, tri in _R["tris"].items():
        t = np.asarray(tri, float).reshape(-1, 3, 3); cen = t.mean(1)
        m = (cen[:, 0] > x0 - 5) & (cen[:, 0] < x1 + 5) & (cen[:, 2] > z0 - 5) & (cen[:, 2] < z1 + 5)
        if m.any(): raster(t[m], 2 if cat in ("walk", "island", "tramstop") else 1)
for c in ([] if USE_PKL else sc["chunks"]):
    key = (c["layer"], c["mat"])
    if key not in LAY or LAY[key] == 0: continue
    o = np.array(c["origin"]); s = c["scale"]
    b = buf(c["file"]); q = np.frombuffer(b, np.int16, c["count"] * 3, c["pos"]).reshape(-1, 3).astype(np.float64) * s + o
    t = q.reshape(-1, 3, 3)
    cen = t.mean(1)
    m = (cen[:, 0] > x0 - 5) & (cen[:, 0] < x1 + 5) & (cen[:, 2] > z0 - 5) & (cen[:, 2] < z1 + 5)
    if m.any(): raster(t[m], LAY[key])
# 地面（2m 格子→ここでは 4m の DEM）と水面
g = sc["ground"]; gb = buf("ground"); N = g["nx"] * g["nz"]
H = np.frombuffer(gb, np.int16, N, 0).reshape(g["nz"], g["nx"]) / 100
WL = np.frombuffer(gb, np.int16, N, N * 5).reshape(g["nz"], g["nx"]) if len(gb) >= N * 7 else None
ci = ((np.arange(nx) + 0.5) * RES + x0 - g["x0"]) / g["step"]; cj = ((np.arange(nz) + 0.5) * RES + z0 - g["z0"]) / g["step"]
I, J = np.meshgrid(np.clip(ci.astype(int), 0, g["nx"] - 1), np.clip(cj.astype(int), 0, g["nz"] - 1))
water = None
if WL is not None:
    w = WL[J, I]; water = np.where(w != -32768, w / 100, np.nan)
covered = kind > 0
res = dict(cells=int(nx * nz), covered=int(covered.sum()))
# 段差: 隣接セル（道路どうし）の高さ差
dy_x = np.abs(np.diff(np.where(covered, top, np.nan), axis=1)); dy_z = np.abs(np.diff(np.where(covered, top, np.nan), axis=0))
res["step_gt_5cm"] = int(np.nansum(dy_x > 0.05) + np.nansum(dy_z > 0.05))
res["step_gt_10cm"] = int(np.nansum(dy_x > 0.10) + np.nansum(dy_z > 0.10))
sk_x = (kind[:, 1:] == kind[:, :-1]); sk_z = (kind[1:, :] == kind[:-1, :])
res["same_kind_step_gt_5cm"] = int(np.nansum((dy_x > 0.05) & sk_x) + np.nansum((dy_z > 0.05) & sk_z))
res["same_kind_step_gt_10cm"] = int(np.nansum((dy_x > 0.10) & sk_x) + np.nansum((dy_z > 0.10) & sk_z))
res["step_max"] = float(np.nanmax([np.nanmax(dy_x) if np.isfinite(dy_x).any() else 0, np.nanmax(dy_z) if np.isfinite(dy_z).any() else 0]))
# 水面が道路面より上に出ている所
if water is not None:
    over = covered & np.isfinite(water) & (water > top - 0.05)
    res["water_over_road"] = int(over.sum())
    wo = np.isfinite(water)
else: wo = np.zeros_like(covered)
print(json.dumps(res))
if out:
    img = np.zeros((nz, nx, 3), np.uint8)
    img[kind == 1] = (110, 110, 110); img[kind == 2] = (170, 150, 120)
    img[~covered & wo] = (40, 90, 120)
    bad = np.zeros_like(covered)
    bad[:, 1:] |= (np.nan_to_num(dy_x) > 0.05) & sk_x; bad[1:, :] |= (np.nan_to_num(dy_z) > 0.05) & sk_z
    cb_ = np.zeros_like(covered); cb_[:, 1:] |= (np.nan_to_num(dy_x) > 0.05) & ~sk_x; cb_[1:, :] |= (np.nan_to_num(dy_z) > 0.05) & ~sk_z
    img[cb_] = (255, 220, 0)
    img[bad] = (255, 40, 40)
    if water is not None: img[covered & np.isfinite(water) & (water > top - 0.05)] = (0, 200, 255)
    Image.fromarray(img).save(out)
    np.save(out + ".top.npy", np.where(covered, top, np.nan))
