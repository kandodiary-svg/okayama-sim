import os
"""共通: 座標変換・三角形分割・軌道距離"""
import math, json
import numpy as np
import mapbox_earcut as earcut
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

LAT0, LON0 = 34.66551000032155, 133.91967999999633  # 岡山駅前駅
KX = math.cos(math.radians(LAT0)) * 111320.0
KZ = 110540.0

# 範囲拡大（v29）: データ範囲はこのファイルと同じフォルダの bounds.json で一か所に決める（x=東, z=南, m）。
# core は v28 までのデータ範囲（手作業で合わせた所。DEM などは core の中を v28 と同じ値に保つ）
_BJ = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bounds.json")))
BX0, BZ0, BX1, BZ1 = float(_BJ["x0"]), float(_BJ["z0"]), float(_BJ["x1"]), float(_BJ["z1"])
CORE = tuple(float(v) for v in _BJ.get("core", (BX0, BZ0, BX1, BZ1)))
def in_data(x, z, m=0.0):
    """データ範囲（から m 内側）に入っているか。x, z は数でも numpy 配列でもよい"""
    return (BX0 + m < x) & (x < BX1 - m) & (BZ0 + m < z) & (z < BZ1 - m)
def latlon_bbox(pad=0.0):
    """データ範囲（pad m 外側まで）を囲む緯度経度 (lat_min, lat_max, lon_min, lon_max)"""
    return (LAT0 - (BZ1 + pad) / KZ, LAT0 - (BZ0 - pad) / KZ, LON0 + (BX0 - pad) / KX, LON0 + (BX1 + pad) / KX)

def proj(lat, lon):
    """緯度経度 -> ローカル平面 (x=東, z=南) [m]"""
    return (lon - LON0) * KX, -(lat - LAT0) * KZ

def proj_arr(a):
    """a: (N,3) lat,lon,h -> (N,3) x,h,z"""
    x = (a[:, 1] - LON0) * KX
    z = -(a[:, 0] - LAT0) * KZ
    return np.stack([x, a[:, 2], z], axis=1)

def load_track_line():
    r = json.load(open("/home/claude/okaden-real/data/routes.json", encoding="utf-8"))
    xz = lambda p: (p[0], p[-1])   # 2D [x,z] と 3D [x,y,z] の両形式に対応
    pts = [xz(p) for p in r["higashi"]["track"]]
    pts2 = [xz(p) for p in r["seiki"]["track"]]
    from shapely.geometry import MultiLineString
    lines = [pts, pts2]
    # v14: WITH_BUS=1 のときはバスの経路も含める（線路から離れた 県庁通り〜相生橋〜古京 の植生・樹木用）
    if os.environ.get("WITH_BUS") and os.path.exists("/home/claude/wx/bus_path_v14.json"):
        bp = json.load(open("/home/claude/wx/bus_path_v14.json"))
        lines.append([(p[0], p[2]) for p in bp["path"]])
    return MultiLineString(lines)

def newell_normal(p):
    n = np.zeros(3)
    for i in range(len(p)):
        a = p[i]; b = p[(i + 1) % len(p)]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    l = np.linalg.norm(n)
    return n / l if l > 1e-12 else None

def triangulate(rings):
    """rings: list of (N,3) arrays in local xyz (first=exterior). returns index triples into concatenated verts."""
    ext = rings[0]
    n = newell_normal(ext)
    if n is None:
        return None, None
    # 2D projection onto dominant plane
    ax = int(np.argmax(np.abs(n)))
    keep = [i for i in range(3) if i != ax]
    verts = np.concatenate(rings, axis=0)
    v2 = verts[:, keep].astype(np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    try:
        idx = earcut.triangulate_float64(v2, ends)
    except Exception:
        return None, None
    if len(idx) == 0:
        return None, None
    idx = np.asarray(idx).reshape(-1, 3)
    # 向きを法線に合わせる
    a = verts[idx[:, 0]]; b = verts[idx[:, 1]]; c = verts[idx[:, 2]]
    cr = np.cross(b - a, c - a)
    flip = (cr @ n) < 0
    idx[flip] = idx[flip][:, [0, 2, 1]]
    return verts, idx

def strip_closing(a):
    if len(a) > 1 and np.allclose(a[0], a[-1]):
        return a[:-1]
    return a

# ---- v30: 道路のデータ（roads_*.pkl）の読み書き。0.5m の高さ・種類の格子（HR・KIND）は大きいので、別の .npy に置いて
#      必要な所だけ読む（np.load の mmap）。v28 の形式（pickle の中に HR・KIND）もそのまま読める ----
def save_roads(R, path):
    import pickle as _pk
    R = dict(R)
    for k in ("HR", "KIND"):
        a = R.pop(k)
        fn = f"{path}.{k}.npy"
        if isinstance(a, np.memmap) and os.path.abspath(getattr(a, "filename", "") or "") == os.path.abspath(fn):
            a.flush()
        else:
            np.save(fn + ".tmp.npy", np.asarray(a)); os.replace(fn + ".tmp.npy", fn)
        R[k + "_file"] = fn
    _pk.dump(R, open(path + ".tmp", "wb")); os.replace(path + ".tmp", path)
def load_roads(path, mode="r"):
    """mode: 'r'（読むだけ）/ 'r+'（その場で書き換え）/ 'c'（書き換えてもファイルは変えない）/ None（全部メモリへ）"""
    import pickle as _pk
    R = _pk.load(open(path, "rb"))
    for k in ("HR", "KIND"):
        if k + "_file" in R: R[k] = np.load(R.pop(k + "_file"), mmap_mode=mode)
    return R
def road_parts(R, key):
    """R["lanes"] / R["raised"] を多角形の部分のリストで返す（v30 は R["lanes_parts"] などのリスト、v28 は 1 つの和集合）"""
    if key + "_parts" in R: return R[key + "_parts"]
    g = R.get(key)
    if g is None or g.is_empty: return []
    return list(g.geoms) if hasattr(g, "geoms") else [g]
class PartsIndex:
    """多角形の部分のリストから、ある範囲の近くの部分だけを和集合にする"""
    def __init__(self, parts):
        from shapely.strtree import STRtree as _T
        self.parts = [p for p in parts if p is not None and not p.is_empty]; self.tree = _T(self.parts)
    def near(self, geom, pad=0.0):
        from shapely.ops import unary_union as _uu
        from shapely.geometry import Polygon as _P
        if geom.is_empty: return _P()
        idx = self.tree.query(geom.buffer(pad) if pad else geom)
        return _uu([self.parts[i] for i in idx]) if len(idx) else _P()
