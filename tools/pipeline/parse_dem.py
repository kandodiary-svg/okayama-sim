"""DEM(TIN, 約5m格子) -> 沿線の標高グリッド /home/claude/wx/dem_grid.npz
グリッド: ローカル座標 x,z を 4m 間隔で補間
"""
import sys, os, re
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, latlon_bbox, BX0, BZ0, BX1, BZ1, CORE

# v29: データ範囲（bounds.json）の 400m 外側まで（v28 は範囲の外側 約 400〜600m まで）
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = latlon_bbox(400.0)
# 2 次メッシュ 513377（北半分 50/55）・523307（南半分 00/05）の 4 つで、緯度 34.625〜34.7083・経度 133.875〜134.0 を覆う
# v30: 範囲を DEM のファイルの端のすぐ内側まで広げたので、外側の余白はファイルの範囲までにする（データ範囲そのものはファイルの中）
_b = latlon_bbox(0.0)
assert _b[0] > 34.6250 and _b[1] < 34.70834 and _b[2] > 133.875 and _b[3] < 134.0, "DEM ファイルの範囲外"
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = max(LAT_MIN, 34.6250), min(LAT_MAX, 34.708334), max(LON_MIN, 133.875), min(LON_MAX, 134.0)
files = ["/home/claude/wx/p25/udx/dem/513377_dem_6697_50_op.gml", "/home/claude/wx/p25/udx/dem/513377_dem_6697_55_op.gml", "/home/claude/wx/p25/udx/dem/523307_dem_6697_00_op.gml", "/home/claude/wx/p25/udx/dem/523307_dem_6697_05_op.gml"]

pts = {}
for f in files:
    buf = []
    with open(f, "r", encoding="utf-8") as fh:
        for line in fh:
            if "<gml:posList>" not in line:
                continue
            s = line.strip()[13:-14]
            buf.append(s)
            if len(buf) >= 200000:
                a = np.array(" ".join(buf).split(), dtype=np.float64).reshape(-1, 3)
                m = (a[:, 0] >= LAT_MIN) & (a[:, 0] <= LAT_MAX) & (a[:, 1] >= LON_MIN) & (a[:, 1] <= LON_MAX)
                a = a[m]
                for la, lo, h in a:
                    pts[(round(la * 18000), round(lo * 18000))] = h
                buf = []
        if buf:
            a = np.array(" ".join(buf).split(), dtype=np.float64).reshape(-1, 3)
            m = (a[:, 0] >= LAT_MIN) & (a[:, 0] <= LAT_MAX) & (a[:, 1] >= LON_MIN) & (a[:, 1] <= LON_MAX)
            for la, lo, h in a[m]:
                pts[(round(la * 18000), round(lo * 18000))] = h
    print(f, "unique pts so far", len(pts), flush=True)

keys = np.array(list(pts.keys()), dtype=np.float64)
vals = np.array(list(pts.values()), dtype=np.float64)
ll = np.stack([keys[:, 0] / 18000, keys[:, 1] / 18000, vals], axis=1)
xyz = proj_arr(ll)
np.savez("/home/claude/wx/dem_pts.npz", xyz=xyz)
print("saved", xyz.shape, "h range", vals.min(), vals.max())

# 規則グリッドへ(4m)
from scipy.interpolate import griddata
xs = np.arange(BX0, BX1, 4.0)
zs = np.arange(BZ0, BZ1, 4.0)
GX, GZ = np.meshgrid(xs, zs)
H = griddata(xyz[:, [0, 2]], xyz[:, 1], (GX, GZ), method="linear")
Hn = griddata(xyz[:, [0, 2]], xyz[:, 1], (GX, GZ), method="nearest")
H = np.where(np.isnan(H), Hn, H)
# v29: core（v28 の範囲）の中は v28 の格子の値をそのまま使う（同じ DEM だが、三角形分割の違いで mm〜cm の差が出るため。
#      core の中は路面・橋・軌道を手作業で合わせてある）
_CF = "/home/claude/wx/dem_grid_core.npz"
if os.path.exists(_CF):
    _c = np.load(_CF); _i0 = int(round((float(_c["x0"]) - BX0) / 4.0)); _j0 = int(round((float(_c["z0"]) - BZ0) / 4.0))
    _hc = _c["H"].astype(np.float64); _nz, _nx = _hc.shape
    if _i0 >= 0 and _j0 >= 0 and _j0 + _nz <= H.shape[0] and _i0 + _nx <= H.shape[1]:
        _D = _hc - H[_j0:_j0 + _nz, _i0:_i0 + _nx]
        print("core paste: max diff", float(np.abs(_D).max()), "mean", float(np.abs(_D).mean()))
        # core の外側 BLEND m の帯で、core の縁の差（v28 の値 − 今回の値）を距離に応じて 0 まで減らしながら足す（縁で段差を作らない）
        BLEND = 60.0
        from scipy import ndimage as _nd
        _core = np.zeros(H.shape, bool); _core[_j0:_j0 + _nz, _i0:_i0 + _nx] = True
        _Dfull = np.zeros(H.shape); _Dfull[_j0:_j0 + _nz, _i0:_i0 + _nx] = _D
        _dist, (_jj, _ii) = _nd.distance_transform_edt(~_core, return_indices=True)
        _w = np.clip(1.0 - _dist * 4.0 / BLEND, 0.0, 1.0); _w = _w * _w * (3 - 2 * _w)
        _corr = _Dfull[_jj, _ii] * _w
        _corr[_core] = 0.0
        H = H + _corr
        H[_j0:_j0 + _nz, _i0:_i0 + _nx] = _hc
        print("  blend band", BLEND, "m: max correction", float(np.abs(_corr).max()))
np.savez("/home/claude/wx/dem_grid.npz", x0=xs[0], z0=zs[0], step=4.0, H=H.astype(np.float32))
print("grid", H.shape, np.nanmin(H), np.nanmax(H))
