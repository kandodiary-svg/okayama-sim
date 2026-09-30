"""道路面の最終形状を作る。
- LOD3 区間: PLATEAU の車道部/車道交差部/歩道部/島 をそのまま使い、歩道・島を +0.15m 上げて縁石面を付ける
- LOD1 区間: PLATEAU の道路面(道路用地)を、OSM の中心線・車線数・歩道タグで 車道/歩道 に分割
- 高さ: LOD3=実測, LOD1=DEM, 橋梁=両岸の最高標高
出力: /home/claude/wx/roads_final.pkl  {cat: tris(N*3,3)}, curb tris, polygons(2D), height raster
"""
import os, sys, glob, pickle, math
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, box
from shapely.ops import unary_union
from shapely.prepared import prep
import shapely
from shapely.strtree import STRtree
import mapbox_earcut as earcut
sys.path.insert(0, os.path.dirname(__file__))
from common import load_track_line, BX0, BZ0, BX1, BZ1
from osm_load import load as osm_load

CURB = 0.15
dem = np.load("/home/claude/wx/dem_grid.npz")
DX0, DZ0, DSTEP = float(dem["x0"]), float(dem["z0"]), float(dem["step"])
DH = dem["H"].astype(np.float64)
def dem_at(x, z):
    fx = (np.asarray(x) - DX0) / DSTEP; fz = (np.asarray(z) - DZ0) / DSTEP
    i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
    tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
    return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz

def tris_to_polys(t):
    """三角形群 -> 2D多角形(和集合)"""
    tt = t.reshape(-1, 3, 3)[:, :, [0, 2]]
    polys = shapely.polygons(np.concatenate([tt, tt[:, :1]], 1))
    polys = polys[shapely.area(polys) > 1e-4]
    if len(polys) == 0: return None
    return shapely.union_all(shapely.make_valid(polys)).buffer(0.02).buffer(-0.02)

def poly_parts(g):
    if g is None or g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]

def tri_polygon(p, hfun):
    """2D多角形を三角形化し、高さ関数で y を付ける"""
    out = []
    p = p.simplify(0.05)
    for q in poly_parts(p):
        rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
        rings = [r for r in rings if len(r) >= 3]
        if not rings: continue
        v = np.concatenate(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        idx = np.asarray(earcut.triangulate_float64(v, ends)).reshape(-1, 3)
        if len(idx) == 0: continue
        a, b, c = v[idx[:, 0]], v[idx[:, 1]], v[idx[:, 2]]
        cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        # x=東, z=南 の平面で上向き(+y)になる巻き方向へ
        flip = cr > 0
        idx[flip] = idx[flip][:, [0, 2, 1]]
        xz = v[idx.reshape(-1)]
        y = hfun(xz[:, 0], xz[:, 1])
        out.append(np.stack([xz[:, 0], y, xz[:, 1]], 1))
    return np.concatenate(out) if out else np.zeros((0, 3))

def _wind_up(xz_tri):
    """(N,3,2) の三角形を上向き（x=東, z=南で +y）の巻きにそろえる"""
    a, b, c = xz_tri[:, 0], xz_tri[:, 1], xz_tri[:, 2]
    cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    f = cr > 0
    xz_tri[f] = xz_tri[f][:, [0, 2, 1]]
    return xz_tri
def tri_polygon_grid(p, hfun, step=4.0):
    """v29: 起伏のある所の LOD1 道路面。多角形を DEM と同じ 4m の格子で切って三角形にし、頂点ごとに hfun（DEM）で高さを付ける
    （細長い三角形の頂点だけに高さを付けると、斜面の道で面が DEM から最大 1m 以上離れ、隣の三角形と段差になっていた）"""
    p = p.simplify(0.05)
    if p.is_empty: return np.zeros((0, 3))
    x0, z0, x1, z1 = p.bounds
    xs = np.arange(math.floor(x0 / step) * step, x1, step); zs = np.arange(math.floor(z0 / step) * step, z1, step)
    X, Z = np.meshgrid(xs, zs); X = X.ravel(); Z = Z.ravel()
    boxes = shapely.box(X, Z, X + step, Z + step)
    shapely.prepare(p)
    full = shapely.contains(p, boxes); part = shapely.intersects(p, boxes) & ~full
    tris = []
    if full.any():
        fx, fz = X[full], Z[full]
        A = np.stack([fx, fz], 1); B = np.stack([fx + step, fz], 1); C = np.stack([fx + step, fz + step], 1); Dd = np.stack([fx, fz + step], 1)
        tris.append(np.stack([A, B, C], 1)); tris.append(np.stack([A, C, Dd], 1))
    if part.any():
        for g in shapely.intersection(boxes[part], p):
            for q in poly_parts(g):
                if q.area < 1e-3: continue
                rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
                rings = [r for r in rings if len(r) >= 3]
                if not rings: continue
                v = np.concatenate(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
                idx = np.asarray(earcut.triangulate_float64(v, ends)).reshape(-1, 3)
                if len(idx): tris.append(v[idx])
    if not tris: return np.zeros((0, 3))
    xz = _wind_up(np.concatenate(tris)).reshape(-1, 2)
    y = hfun(xz[:, 0], xz[:, 1])
    return np.stack([xz[:, 0], y, xz[:, 1]], 1)
def relief(p):
    """多角形の外接矩形の中の DEM の節点に平面を当てはめた時の、平面からの最大のずれ（平らでない＝格子で切る必要がある）"""
    x0, z0, x1, z1 = p.bounds
    i0 = max(0, int((x0 - DX0) / DSTEP)); i1 = min(DH.shape[1], int((x1 - DX0) / DSTEP) + 2)
    j0 = max(0, int((z0 - DZ0) / DSTEP)); j1 = min(DH.shape[0], int((z1 - DZ0) / DSTEP) + 2)
    if i1 - i0 < 2 or j1 - j0 < 2: return 0.0
    b = DH[j0:j1, i0:i1]; J, I = np.mgrid[j0:j1, i0:i1]
    A = np.stack([I.ravel(), J.ravel(), np.ones(b.size)], 1)
    c, *_ = np.linalg.lstsq(A, b.ravel(), rcond=None)
    return float(np.abs(A @ c - b.ravel()).max())
RELIEF_GRID = float(os.environ.get("RELIEF_GRID", "1e9"))   # v29: この起伏（m）を超える LOD1 の道路面は格子で切る（範囲拡大では 0.5）
n_grid = 0

# ---------------- 読み込み ----------------
lod3 = {}      # cat -> list of tris (実測高さ)
lod1 = []      # (tris, bridge, code, pid, sect)
for f in sorted(glob.glob("/home/claude/wx/out_tran/*.pkl")):
    code = os.path.basename(f)[:-4]
    d = pickle.load(open(f, "rb"))
    pids = d.pop("_pid", {}); sects = d.pop("_sect", {})
    for key, tri in d.items():
        cat = key.replace("_bridge", ""); bridge = key.endswith("_bridge")
        if cat == "road1":
            pid = pids[key]; sc_ = sects.get(key)
            t = tri.reshape(-1, 3, 3)
            for p_ in np.unique(pid):
                m_ = pid == p_
                lod1.append((t[m_], bridge, code, int(p_), int(sc_[m_][0]) if sc_ is not None else (3 if bridge else 1)))
        else:
            lod3.setdefault(cat, []).append((tri.astype(np.float64), bridge))
print("lod3 cats", {k: sum(len(t) for t, b in v) // 3 for k, v in lod3.items()}, "lod1 polys", len(lod1), flush=True)

ways, nodes = osm_load()
MAJOR = {"trunk", "primary", "secondary", "tertiary", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MINOR = {"unclassified", "residential", "living_street", "service"}
tram_lines = [LineString(w["xy"]) for w in ways if w["tags"].get("railway") == "tram"]
tram_union = unary_union(tram_lines)
TRAM_BUF = tram_union.buffer(3.6)
# 主要道路どうしの交差点(共有ノード)は車道で埋める
from collections import Counter
_cnt = Counter()
for w in ways:
    if w["tags"].get("highway") in MAJOR:
        for nid in set(w["nodes"]): _cnt[nid] += 1
_junc_xy = {}
for w in ways:
    for nid, p_ in zip(w["nodes"], w["xy"]):
        if _cnt.get(nid, 0) >= 2: _junc_xy[nid] = p_
JUNC = unary_union([Point(*p_).buffer(11.0) for p_ in _junc_xy.values()]) if _junc_xy else Polygon()
print("junctions", len(_junc_xy), flush=True)
road_ways = [w for w in ways if w["tags"].get("highway") in MAJOR | MINOR and len(w["xy"]) >= 2]
# v32: 道路の高さは OSM の中心線に沿った縦断から（road_profile.py）。橋・高架は両端をつなぎ、下を横切る道路・線路の上にすき間を取る
import road_profile as RPF
_rails = [w["xy"] for w in ways if w["tags"].get("railway") in ("rail", "light_rail", "narrow_gauge") and not RPF._yes(w["tags"].get("bridge"))
          and not RPF._yes(w["tags"].get("tunnel")) and len(w["xy"]) >= 2]
PROF = RPF.Profiles(ways, dem_at, _rails)
PROFILE_ON = not os.environ.get("NO_PROFILE")
_OWN = [None]   # v32: 今の面の中を通る道（隣の別の高さの道を拾わないように）
def _prof_ground(x, z):
    h, d = PROF.height_own(x, z, "ground", _OWN[0], 25.0)
    return np.where(np.isfinite(h), h, dem_at(x, z))
def _bridge_hfun(P2):
    """橋・高架の面の高さ: 近くの OSM の橋の縦断。無ければ（OSM に橋が無い小さな橋など）、面の長い向きの両端の外側 3m の
    地上の道路の高さを直線でつなぐ（川・水路の上で地形に沿って下がらないように）"""
    xs = np.array(P2.exterior.coords)
    hb, db = PROF.height(xs[:, 0], xs[:, 1], "bridge", 30.0)
    if np.isfinite(hb).mean() > 0.6:
        own_b = PROF.ways_in(P2, "bridge")
        def hf(x, z):
            h, d = PROF.height_own(x, z, "bridge", own_b, 40.0)
            if (~np.isfinite(h)).any():
                h2 = _span(x, z); h = np.where(np.isfinite(h), h, h2)
            return h
        return hf
    return _span_fun(P2)
def _span_fun(P2):
    rr = np.array(P2.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr[1] - rr[0]; e2 = rr[2] - rr[1]
    ax = (e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2).copy(); L = float(np.linalg.norm(ax)); ax /= max(L, 1e-6)
    c = np.array(P2.centroid.coords[0]); A = c - ax * (L / 2 + 3.0); B = c + ax * (L / 2 + 3.0)
    hA = float(_prof_ground(np.array([A[0]]), np.array([A[1]]))[0]); hB = float(_prof_ground(np.array([B[0]]), np.array([B[1]]))[0])
    def hf(x, z):
        s_ = np.clip(((np.stack([x, z], 1) - A) @ ax) / (L + 6.0), 0, 1)
        return hA + (hB - hA) * s_
    return hf
_span_cur = [None]
def _span(x, z): return _span_cur[0](x, z)
road_lines = [LineString(w["xy"]) for w in road_ways]
road_tree = STRtree(road_lines)

def lanes_of(t):
    try: return float(t.get("lanes"))
    except Exception: return None

# ---------------- LOD1 区間の分割 ----------------
out = {k: [] for k in ("lane", "xing", "walk", "island", "green", "tramstop", "rail")}
walk_polys, lane_polys, island_polys = [], [], []
lod3_extent = []
for cat, L in lod3.items():
    for t, b in L:
        lod3_extent.append(tris_to_polys(t))
lod3_area = unary_union([g for g in lod3_extent if g is not None]).buffer(0.5)
print("lod3 area km2", lod3_area.area / 1e6, flush=True)

n_split = 0
DATA_BOX = box(BX0 + 1.0, BZ0 + 1.0, BX1 - 1.0, BZ1 - 1.0)
bridge_parts = []; bridge_walk = []; n_tunnel = 0; n_bridge_osm = 0
outB = {"lane": [], "walk": []}
for t, bridge, code, pid, sect in lod1:
    if sect == 6 and PROFILE_ON: n_tunnel += 1; continue   # v32: トンネルの中の道路面は描かない（山の表面に出ていた）
    bridge = sect in (2, 3) if PROFILE_ON else bridge          # v32: 高架橋（2）も橋として扱う（以前は地形に貼り付いていた）
    P = tris_to_polys(t)
    if P is None or P.is_empty: continue
    P = P.difference(lod3_area)  # LOD3 がある所は LOD3 を優先
    P = P.intersection(DATA_BOX)  # v29: データ範囲の外（地形の無い所）は作らない
    if P.area < 1.0: continue
    if PROFILE_ON and not bridge:
        # v32: PLATEAU では通常・交差部の区間でも、中を通る OSM の道が主に橋なら橋として扱う（長い橋の河川敷の部分など）
        _ll = PROF.level_lengths(P)
        if _ll["bridge"] > 5.0 and _ll["bridge"] > 1.5 * _ll["ground"]: bridge = True; n_bridge_osm += 1
    if not PROFILE_ON:
        if bridge:
            deck = float(np.max(dem_at(t.reshape(-1, 3)[:, 0], t.reshape(-1, 3)[:, 2]))) + 0.05
            hfun = lambda x, z, d=deck: np.full(len(x), d)
        else:
            hfun = lambda x, z: dem_at(x, z) + 0.04
    elif bridge:
        _P2 = max(poly_parts(P), key=lambda q: q.area)
        _OWN[0] = None
        _span_cur[0] = _span_fun(_P2)
        _hb = _bridge_hfun(_P2)
        hfun = lambda x, z, f=_hb: f(np.asarray(x, np.float64), np.asarray(z, np.float64)) + 0.05
        bridge_parts.append(P)
    else:
        _own = PROF.ways_in(P, "ground")
        hfun = lambda x, z, o=_own: (_OWN.__setitem__(0, o), _prof_ground(np.asarray(x, np.float64), np.asarray(z, np.float64)) + 0.04)[1]
    # この面を通る OSM 道路
    cand = road_tree.query(P)
    carriage = []
    has_major = False
    for i in cand:
        w = road_ways[i]; ln = road_lines[i]
        if not ln.intersects(P): continue
        hw = w["tags"]["highway"]
        n = lanes_of(w["tags"])
        on_tram = ln.buffer(4).intersection(tram_union).length > 10
        if hw in MAJOR:
            has_major = True
            n = n or 2
            width = n * 3.0 + 0.5 + (6.4 if on_tram else 0.0)
        else:
            n = n or 0
            width = None if n == 0 else n * 2.75 + 0.5
            if on_tram: width = (width or 5.5) + 6.4
        if width is None:
            carriage.append(P)   # 生活道路: 歩道なし
        else:
            carriage.append(ln.buffer(width / 2, cap_style=1, join_style=1).intersection(P))
    if not carriage:
        C = P; S = None
    else:
        # 車道 = 道路中心線の帯 + 軌道敷 を和集合し、上下線の間・交差点の隅を埋める(閉処理)
        tb = TRAM_BUF.intersection(P) if P.intersects(TRAM_BUF) else Polygon()
        jn = JUNC.intersection(P) if P.intersects(JUNC) else Polygon()
        C = unary_union(carriage + [tb, jn]).buffer(4.0, join_style=1).buffer(-4.0, join_style=1).intersection(P)
        S = P.difference(C).intersection(P.boundary.buffer(4.5)) if has_major else None
    # 歩道は道路面の外周に沿った帯だけ（幅 1.2m 以上）
    if S is not None and not S.is_empty:
        edge = P.boundary.buffer(0.6)
        keep = [q for q in poly_parts(S) if q.area > 4 and q.intersection(edge).area > 0.35 * min(q.area, q.length * 0.6)
                and q.buffer(-0.6).area > 0]
        S = unary_union(keep) if keep else None
        C = P.difference(S) if S is not None else P
    else:
        S = None; C = P if not carriage else C
    _tp = tri_polygon
    if (bridge and PROFILE_ON) or (not bridge and relief(P) > RELIEF_GRID): _tp = tri_polygon_grid; n_grid += 1   # v32: 橋は縦断に沿うよう格子で切る
    lane_t = _tp(C, hfun)
    OUT_ = outB if (bridge and PROFILE_ON) else out   # v32: 橋・高架の面は別に持つ（下を通る道路と重なる所の高さを分ける）
    if len(lane_t): OUT_["lane"].append(lane_t); lane_polys.append(C)
    if S is not None:
        walk_t = _tp(S, lambda x, z: hfun(x, z) + CURB)
        if len(walk_t): OUT_["walk"].append(walk_t); walk_polys.append(S)
        if bridge and PROFILE_ON: bridge_walk.append(S)
        n_split += 1
print("lod1 split into carriage/sidewalk:", n_split, "gridded (relief >", RELIEF_GRID, "m / bridges):", n_grid, "tunnel polys skipped", n_tunnel,
      "bridge polys", len(bridge_parts), "(of which by OSM", n_bridge_osm, ")", flush=True)

# ---------------- LOD3 区間 ----------------
for cat, L in lod3.items():
    for t, bridge in L:
        t = t.copy()
        if cat in ("walk", "island", "green", "tramstop"):
            t[:, 1] += CURB
        else:
            t[:, 1] += 0.02
        out.setdefault(cat, []).append(t)
        g = tris_to_polys(t)
        if g is None: continue
        if cat in ("walk", "tramstop"): walk_polys.append(g)
        elif cat in ("island", "green"): island_polys.append(g)
        else: lane_polys.append(g)

# v30: 範囲全体の和集合は作らない（広い範囲では重い）。部分のリストのまま持ち、縁石は 500m の升目ごとに近くだけ和集合にする
lane_parts = [g for g in lane_polys if g is not None and not g.is_empty]
raised_parts = [g for g in walk_polys + island_polys if g is not None and not g.is_empty]

# ---------------- 高さラスタ(0.5m) : 車道面の高さ ----------------
RES = 0.5; GX0, GZ0 = BX0, BZ0; NX, NZ = int(round((BX1 - BX0) / RES)), int(round((BZ1 - BZ0) / RES))   # v29: bounds.json
# v30: 格子はディスク上のファイル（.npy）に置く（範囲全体を一度にメモリに持たない）
_ROUT = os.environ.get("ROADS_OUT", "/home/claude/wx/roads_final.pkl")
HR = np.lib.format.open_memmap(_ROUT + ".HR.npy", mode="w+", dtype=np.float32, shape=(NZ, NX))
for _r in range(0, NZ, 2048): HR[_r:_r + 2048] = np.nan
KIND = np.lib.format.open_memmap(_ROUT + ".KIND.npy", mode="w+", dtype=np.uint8, shape=(NZ, NX))  # 1=車道 2=歩道/島
def raster(tris, kind):
    t = tris.reshape(-1, 3, 3)
    for tt in t:
        x0 = int((tt[:, 0].min() - GX0) / RES); x1 = int((tt[:, 0].max() - GX0) / RES) + 1
        z0 = int((tt[:, 2].min() - GZ0) / RES); z1 = int((tt[:, 2].max() - GZ0) / RES) + 1
        x0 = max(0, x0); z0 = max(0, z0); x1 = min(NX, x1); z1 = min(NZ, z1)
        if x1 <= x0 or z1 <= z0: continue
        gx = GX0 + (np.arange(x0, x1) + 0.5) * RES; gz = GZ0 + (np.arange(z0, z1) + 0.5) * RES
        X, Z = np.meshgrid(gx, gz)
        A, B, C = tt[0], tt[1], tt[2]
        v0 = C[[0, 2]] - A[[0, 2]]; v1 = B[[0, 2]] - A[[0, 2]]
        d00 = v0 @ v0; d01 = v0 @ v1; d11 = v1 @ v1; den = d00 * d11 - d01 * d01
        if abs(den) < 1e-12: continue
        px = X - A[0]; pz = Z - A[2]
        d02 = v0[0] * px + v0[1] * pz; d12 = v1[0] * px + v1[1] * pz
        u = (d11 * d02 - d01 * d12) / den; v = (d00 * d12 - d01 * d02) / den
        m = (u >= -1e-3) & (v >= -1e-3) & (u + v <= 1 + 1e-3)
        if not m.any(): continue
        y = A[1] + u * (C[1] - A[1]) + v * (B[1] - A[1])
        sub = HR[z0:z1, x0:x1]; ks = KIND[z0:z1, x0:x1]
        upd = m & (np.isnan(sub) | (y > sub) | (kind == 1))
        if kind == 1:
            sub[m] = y[m]; ks[m] = 1
        else:
            upd = m & (ks != 1)
            sub[upd] = y[upd]; ks[upd] = 2
for cat in ("lane", "xing", "rail"):
    for t in out.get(cat, []): raster(t, 1)
for cat in ("walk", "island", "green", "tramstop"):
    for t in out.get(cat, []): raster(t, 2)
# v32: 橋・高架の面。下に（地上の）道路が無い升目はそのまま（以前と同じ）、下に道路がある升目は「上の段」（UP）に分けて持つ
UP = {}   # 升目の番号 j*NX+i -> (高さ, 区分)
def raster_b(tris, kind):
    t = tris.reshape(-1, 3, 3)
    for tt in t:
        x0 = max(0, int((tt[:, 0].min() - GX0) / RES)); x1 = min(NX, int((tt[:, 0].max() - GX0) / RES) + 1)
        z0 = max(0, int((tt[:, 2].min() - GZ0) / RES)); z1 = min(NZ, int((tt[:, 2].max() - GZ0) / RES) + 1)
        if x1 <= x0 or z1 <= z0: continue
        gx = GX0 + (np.arange(x0, x1) + 0.5) * RES; gz = GZ0 + (np.arange(z0, z1) + 0.5) * RES
        X, Z = np.meshgrid(gx, gz); A, B, C = tt[0], tt[1], tt[2]
        v0 = C[[0, 2]] - A[[0, 2]]; v1 = B[[0, 2]] - A[[0, 2]]
        d00 = v0 @ v0; d01 = v0 @ v1; d11 = v1 @ v1; den = d00 * d11 - d01 * d01
        if abs(den) < 1e-12: continue
        px = X - A[0]; pz = Z - A[2]; d02 = v0[0] * px + v0[1] * pz; d12 = v1[0] * px + v1[1] * pz
        u = (d11 * d02 - d01 * d12) / den; v = (d00 * d12 - d01 * d02) / den
        m = (u >= -1e-3) & (v >= -1e-3) & (u + v <= 1 + 1e-3)
        if not m.any(): continue
        y = A[1] + u * (C[1] - A[1]) + v * (B[1] - A[1])
        sub = HR[z0:z1, x0:x1]; ks = KIND[z0:z1, x0:x1]
        low = m & np.isfinite(sub) & (sub < y - 2.5)           # 下に道路（2.5m 以上低い）→ 上の段
        own = m & ~low
        if kind == 1:
            sub[own] = y[own]; ks[own] = 1
        else:
            o2 = own & (ks != 1); sub[o2] = y[o2]; ks[o2] = 2
        jj, ii = np.nonzero(low)
        for j_, i_, y_ in zip((jj + z0).tolist(), (ii + x0).tolist(), y[low].tolist()):
            k_ = (j_ * NX + i_); prev = UP.get(k_)
            if kind == 1 or prev is None or prev[1] != 1: UP[k_] = (y_, kind)
for t in outB["lane"]: raster_b(t, 1)
for t in outB["walk"]: raster_b(t, 2)
print("raster done", sum(int(np.isfinite(HR[_r:_r + 2048]).sum()) for _r in range(0, NZ, 2048)), "upper cells (bridge over road)", len(UP), flush=True)
for k_ in ("lane", "walk"): out[k_] = out[k_] + outB[k_]

# ---------------- 縁石(歩道・島の外周の立ち上がり) ----------------
curb = []
_RT = STRtree(raised_parts) if raised_parts else None; _LT = STRtree(lane_parts) if lane_parts else None
_BT = STRtree([g for g in bridge_parts if not g.is_empty]) if bridge_parts else None
CT = 500.0
_tiles = sorted({(int(math.floor(x / CT)), int(math.floor(z / CT))) for g in raised_parts
                 for x in (g.bounds[0], g.bounds[2]) for z in (g.bounds[1], g.bounds[3])} |
                {(i, j) for g in raised_parts for i in range(int(math.floor(g.bounds[0] / CT)), int(math.floor(g.bounds[2] / CT)) + 1)
                 for j in range(int(math.floor(g.bounds[1] / CT)), int(math.floor(g.bounds[3] / CT)) + 1)})
for (ti, tj) in _tiles:
  tx0, tz0 = ti * CT, tj * CT; TB_ = box(tx0 - 60, tz0 - 60, tx0 + CT + 60, tz0 + CT + 60)
  ri = _RT.query(TB_)
  if not len(ri): continue
  raised_loc = unary_union([raised_parts[k] for k in ri])
  li = _LT.query(TB_) if _LT is not None else []
  lanes_prep = prep(unary_union([lane_parts[k] for k in li]).buffer(0.05)) if len(li) else prep(Polygon())
  for g in poly_parts(raised_loc):
    if not g.intersects(box(tx0, tz0, tx0 + CT, tz0 + CT)): continue
    gp = prep(g)
    on_b = _BT is not None and len(_BT.query(g.representative_point())) > 0   # v32: 橋・高架の上の歩道
    for ring in [g.exterior] + list(g.interiors):
        c = np.array(ring.coords)
        for a, b in zip(c[:-1], c[1:]):
            L = math.hypot(*(b - a))
            if L < 0.05: continue
            m = (a + b) / 2
            if not (tx0 <= m[0] < tx0 + CT and tz0 <= m[1] < tz0 + CT): continue   # この升目の分だけ（重ならない）
            # 外側が車道のときだけ縁石を立てる
            nvec = np.array([-(b - a)[1], (b - a)[0]]) / L
            ok = False
            for s in (0.4, -0.4):
                q = Point(*(m + nvec * s))
                if lanes_prep.contains(q) and not gp.contains(q): ok = True
            if not ok: continue
            ya = float(dem_at(a[0], a[1])); yb = float(dem_at(b[0], b[1]))
            # 実高さ: ラスタから
            def h_at(p):
                i = int((p[0] - GX0) / RES); j = int((p[1] - GZ0) / RES)
                j = min(max(j, 0), NZ - 1); i = min(max(i, 0), NX - 1)
                if on_b and (j * NX + i) in UP: return float(UP[j * NX + i][0])   # v32: 橋の上の縁石は上の段
                v = HR[j, i]
                return float(v) if np.isfinite(v) else float(dem_at(p[0], p[1])) + CURB
            ta = h_at(a); tb = h_at(b)
            A0 = [a[0], ta - CURB, a[1]]; B0 = [b[0], tb - CURB, b[1]]
            A1 = [a[0], ta, a[1]]; B1 = [b[0], tb, b[1]]
            curb.append(np.array([A0, B0, A1, A1, B0, B1, A0, A1, B0, B0, A1, B1]))
curb = np.concatenate(curb) if curb else np.zeros((0, 3))
print("curb tris", len(curb) // 3, flush=True)

final = {k: np.concatenate(v) for k, v in out.items() if v}
from common import save_roads
_ui = np.fromiter(UP.keys(), np.int64, len(UP)); _uv = np.array([UP[k][0] for k in _ui.tolist()], np.float32); _uk = np.array([UP[k][1] for k in _ui.tolist()], np.uint8)
save_roads(dict(tris=final, curb=curb, lanes_parts=lane_parts, raised_parts=raised_parts, bridge_parts=bridge_parts,
                upper=(_ui, _uv, _uk), HR=HR, KIND=KIND, grid=(GX0, GZ0, RES)), _ROUT)   # v29: 範囲拡大では roads_new.pkl（merge_roads.py で v28 の道路と合わせる）
print({k: len(v) // 3 for k, v in final.items()})
