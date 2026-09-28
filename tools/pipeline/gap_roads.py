"""v29: PLATEAU の道路データが無い所（OSM の車道はある所）の車道・歩道を、OSM の道路中心線から作る（core＝v28 の範囲の外だけ）。
patch_surface.py 2)（岡山城・県庁の東の区域）と同じ作り方を、範囲全体に広げたもの。
・欠けの見つけ方: OSM の車道（trunk〜tertiary・unclassified・residential・living_street）を 1m ごとに見て、
  2.5m 以内に道路面（ラスタ）が無い所が 12m 以上続く区間（前後 4m ずつ延ばして既存の道路面につなぐ）
・幅: OSM の width → lanes×3.25+1.0 → 道路の種類ごとの標準の幅（推定）。幹線（trunk〜tertiary）は両側に歩道 2.5m（推定）
・高さ: 1m ごとの点の縦断を、DEM に近く・なめらか（2 階差分）・既存の路面（車道）に乗る点は強く拘束、の最小二乗で解く。水面の上は DEM を使わない
出力: /home/claude/wx/roads_final.pkl を書き換える
"""
import json, pickle, sys, os, math
import numpy as np
import shapely
from shapely.geometry import Polygon, Point, LineString, box
from shapely.ops import unary_union, substring
from shapely.prepared import prep
import mapbox_earcut as earcut
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))
from common import proj, CORE, BX0, BZ0, BX1, BZ1
from osm_load import load as osm_load

SRC = "/home/claude/wx/roads_final.pkl"
R = pickle.load(open(SRC, "rb"))
HR = R["HR"]; KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]
dem = np.load("/home/claude/wx/dem_grid.npz"); DX0, DZ0, DS = float(dem["x0"]), float(dem["z0"]), float(dem["step"]); DH = dem["H"].astype(np.float64)
def dem_at(x, z):
    fx = (np.asarray(x, float) - DX0) / DS; fz = (np.asarray(z, float) - DZ0) / DS
    i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
    tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
    return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz
def cell(x, z): return int((x - GX0) / RES), int((z - GZ0) / RES)
def hr_bilinear(x, z):
    fx = (x - GX0) / RES - 0.5; fz = (z - GZ0) / RES - 0.5
    i0 = int(math.floor(fx)); j0 = int(math.floor(fz)); tx = fx - i0; tz = fz - j0
    if not (0 <= j0 < HR.shape[0] - 1 and 0 <= i0 < HR.shape[1] - 1): return None
    blk = HR[j0:j0 + 2, i0:i0 + 2].astype(np.float64); w = np.array([[(1 - tx) * (1 - tz), tx * (1 - tz)], [(1 - tx) * tz, tx * tz]])
    m = np.isfinite(blk)
    if not m.any(): return None
    return float((blk[m] * w[m]).sum() / max(w[m].sum(), 1e-9)) if w[m].sum() > 1e-6 else float(np.nanmean(blk))

def grid_tris(poly, hfun, step=2.0):
    """多角形を step 格子で切って三角形化。範囲全体に散らばるので、ばらばらの多角形ごとに切る"""
    if poly.is_empty: return np.zeros((0, 3))
    out = [grid_tris1(q, hfun, step) for q in (poly.geoms if hasattr(poly, "geoms") else [poly])]
    out = [o for o in out if len(o)]
    return np.concatenate(out) if out else np.zeros((0, 3))
def grid_tris1(poly, hfun, step=2.0):
    """多角形を step 格子で切って三角形化（頂点の高さは hfun）。上向き（y+）の巻き（patch_surface.py と同じ）"""
    out = []
    if poly.is_empty: return np.zeros((0, 3))
    x0, z0, x1, z1 = poly.bounds
    xs = np.arange(math.floor(x0 / step) * step, x1 + step, step); zs = np.arange(math.floor(z0 / step) * step, z1 + step, step)
    pp = prep(poly)
    for xa in xs:
        for za in zs:
            b = box(xa, za, xa + step, za + step)
            if not pp.intersects(b): continue
            g = b if pp.contains(b) else poly.intersection(b)
            for q in (g.geoms if hasattr(g, "geoms") else [g]):
                if not isinstance(q, Polygon) or q.area < 1e-3: continue
                v = np.array(q.exterior.coords)[:-1]
                holes = [np.array(h.coords)[:-1] for h in q.interiors]
                allv = np.concatenate([v] + holes) if holes else v
                ends = np.cumsum([len(r) for r in [v] + holes]).astype(np.uint32)
                if len(v) < 3: continue
                idx = np.asarray(earcut.triangulate_float64(allv, ends)).reshape(-1, 3)
                for a_, b_, c_ in idx:
                    pa, pb, pc = allv[a_], allv[b_], allv[c_]
                    cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
                    if cr > 0: pb, pc = pc, pb
                    out += [[p[0], hfun(p[0], p[1]), p[1]] for p in (pa, pb, pc)]
    return np.array(out) if out else np.zeros((0, 3))

def curb_faces(walk_poly, top_fn, drop=0.17):
    out = []
    for g in (walk_poly.geoms if hasattr(walk_poly, "geoms") else [walk_poly]):
        if g.is_empty: continue
        for ring in [g.exterior] + list(g.interiors):
            L = ring.length; n = max(1, int(math.ceil(L / 1.0)))
            pts = [np.array(ring.interpolate(L * k / n).coords[0]) for k in range(n + 1)]
            for a, b in zip(pts[:-1], pts[1:]):
                if np.linalg.norm(b - a) < 0.05: continue
                ya = top_fn(*a); yb = top_fn(*b)
                A0 = [a[0], ya, a[1]]; B0 = [b[0], yb, b[1]]; A1 = [a[0], ya - drop, a[1]]; B1 = [b[0], yb - drop, b[1]]
                out += [A0, A1, B0, B0, A1, B1, A0, B0, A1, B0, B1, A1]
    return np.array(out) if out else np.zeros((0, 3))

DRV = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
       "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MAJ = {"trunk", "primary", "secondary", "tertiary"}
def width_of(t):
    try:
        if t.get("width"): return float(str(t["width"]).split(";")[0]) + 0.5
    except Exception: pass
    try: ln = int(str(t.get("lanes", "")).split(";")[0])
    except Exception: ln = None
    hw = t.get("highway", "").replace("_link", "")
    if ln: return ln * 3.25 + 1.0
    return {"trunk": 10.0, "primary": 10.0, "secondary": 8.5, "tertiary": 7.5, "unclassified": 5.0, "residential": 4.5, "living_street": 4.0}.get(hw, 5.0)

# ---- 欠けている区間 ----
fin = np.isfinite(HR)
near = ndimage.binary_dilation(fin, iterations=5)            # 2.5m 以内に道路面
DATA = box(BX0 + 3, BZ0 + 3, BX1 - 3, BZ1 - 3)
COREB = box(*CORE)
ways, _nodes = osm_load()
segs = []   # (LineString, tags)
for w in ways:
    t = w["tags"]
    if t.get("highway") not in DRV or t.get("area") == "yes" or t.get("tunnel") == "yes" or len(w["xy"]) < 2: continue
    if t.get("access") in ("private", "no") and t.get("highway") not in MAJ: continue
    ln = LineString(w["xy"])
    if not ln.intersects(DATA): continue
    L = ln.length; n = max(2, int(L // 1.0) + 1)
    ss = np.linspace(0, L, n); P = np.array([ln.interpolate(s).coords[0] for s in ss])
    miss = np.zeros(n, bool)
    for k, (x, z) in enumerate(P):
        if not (BX0 + 3 < x < BX1 - 3 and BZ0 + 3 < z < BZ1 - 3): continue
        if CORE[0] <= x <= CORE[2] and CORE[1] <= z <= CORE[3]: continue
        i, j = cell(x, z)
        miss[k] = not near[j, i]
    if not miss.any(): continue
    lab, nl = ndimage.label(miss)
    for q in range(1, nl + 1):
        idx = np.nonzero(lab == q)[0]
        s0, s1 = ss[idx[0]], ss[idx[-1]]
        if s1 - s0 < 12.0: continue
        sub = substring(ln, max(0.0, s0 - 4.0), min(L, s1 + 4.0))
        if sub.length > 1.0: segs.append((sub, t))
print("gap segments", len(segs), "length km", round(sum(g.length for g, t in segs) / 1e3, 2), flush=True)
if not segs:
    print("nothing to add"); sys.exit(0)

existing = unary_union([R["lanes"], R["raised"]]).buffer(0.05)
EX = json.load(open("/home/claude/wx/osm/extra.json"))
_wp = []
for e in EX["elements"]:
    t_ = e.get("tags", {})
    if e["type"] == "way" and "geometry" in e and len(e["geometry"]) > 3 and t_.get("natural") == "water":
        _wp.append(Polygon([proj(g["lat"], g["lon"]) for g in e["geometry"]]).buffer(0))
    if e["type"] == "relation" and t_.get("natural") == "water":
        from shapely.ops import linemerge, polygonize
        ol = [LineString([proj(g["lat"], g["lon"]) for g in m["geometry"]]) for m in e.get("members", []) if m.get("geometry") and m.get("role") == "outer"]
        ps = list(polygonize(linemerge(ol))) if ol else []
        if ps: _wp.append(unary_union(ps))
WATER = prep(unary_union(_wp).buffer(6.0)) if _wp else None

# ---- 縦断（最小二乗） ----
X = []; wdata = []; ydata = []; wanch = []; yanch = []; chains = []
key_of = {}
def new_var(p):
    k = (round(p[0], 2), round(p[1], 2))
    if k in key_of: return key_of[k]
    X.append(p); x, z = p
    d = float(dem_at(x, z)); inw = WATER is not None and WATER.contains(Point(x, z))
    wdata.append(0.0 if inw else 1.0); ydata.append(d)
    i, j = cell(x, z)
    sub = HR[max(0, j - 2):j + 3, max(0, i - 2):i + 3]; kk = KIND[max(0, j - 2):j + 3, max(0, i - 2):i + 3]
    v = sub[np.isfinite(sub) & (kk == 1)]
    if len(v) >= 4: wanch.append(400.0); yanch.append(float(np.median(v)))
    else: wanch.append(0.0); yanch.append(0.0)
    key_of[k] = len(X) - 1
    return len(X) - 1
for g, t in segs:
    L = g.length; n = max(2, int(L // 1.0) + 1)
    seq = [new_var(tuple(g.interpolate(L * k / (n - 1)).coords[0])) for k in range(n)]
    chains.append(seq)
N = len(X); X = np.array(X)
print("samples", N, "anchored", int(np.sum(np.array(wanch) > 0)), flush=True)
LAM1, LAM2 = 30.0, 900.0
rows, cols, vals = [], [], []
def add(i, j, v): rows.append(i); cols.append(j); vals.append(v)
diag = np.array(wdata) * 1.0 + np.array(wanch)
rhs = np.array(wdata) * np.array(ydata) + np.array(wanch) * np.array(yanch)
for seq in chains:
    for a, b in zip(seq[:-1], seq[1:]):
        add(a, a, LAM1); add(b, b, LAM1); add(a, b, -LAM1); add(b, a, -LAM1)
    for a, b, c in zip(seq[:-2], seq[1:-1], seq[2:]):
        for (i, ci) in ((a, 1), (b, -2), (c, 1)):
            for (j, cj) in ((a, 1), (b, -2), (c, 1)):
                add(i, j, LAM2 * ci * cj)
for i in range(N): add(i, i, diag[i] + 1e-6)
Y = spsolve(sparse.csr_matrix((vals, (rows, cols)), shape=(N, N)).tocsc(), rhs)
print("profile solved: y range", round(float(Y.min()), 2), round(float(Y.max()), 2), flush=True)
ktree = cKDTree(X)
def y_road(x, z):
    d, ii = ktree.query([x, z], k=6)
    w = 1.0 / (d + 0.5) ** 2
    return float((Y[ii] * w).sum() / w.sum())

# ---- 車道・歩道の多角形 ----
lane_polys = []; walk_polys = []
for g, t in segs:
    wd = width_of(t)
    lane_polys.append(g.buffer(wd / 2, cap_style=1, join_style=1))
    hw = t.get("highway", "").replace("_link", "")
    if hw in MAJ and t.get("embankment") != "yes" and t.get("bridge") != "yes":
        walk_polys.append(g.buffer(wd / 2 + 2.5, cap_style=2, join_style=2))
LANE = unary_union(lane_polys).intersection(DATA).difference(COREB).difference(existing)
LANE = unary_union([q for q in (LANE.geoms if hasattr(LANE, "geoms") else [LANE]) if isinstance(q, Polygon) and q.area > 2.0])
WALK = (unary_union(walk_polys).intersection(DATA).difference(COREB).difference(unary_union(lane_polys)).difference(existing)
        if walk_polys else Polygon())
WALK = unary_union([q for q in (WALK.geoms if hasattr(WALK, "geoms") else [WALK]) if isinstance(q, Polygon) and q.area > 3.0 and q.buffer(-0.6).area > 0]) if not WALK.is_empty else Polygon()
print("new lane area m2", round(LANE.area), "walk area m2", round(WALK.area), flush=True)

# ---- HR / KIND（車道=路面、歩道=+0.15） ----
def raster_fill(poly, kind, dy):
    n = 0
    for q in (poly.geoms if hasattr(poly, "geoms") else [poly]):
        if q.is_empty: continue
        x0, z0, x1, z1 = q.bounds
        i0, j0 = cell(x0, z0); i1, j1 = cell(x1, z1)
        i0 = max(0, i0); j0 = max(0, j0); i1 = min(HR.shape[1] - 1, i1); j1 = min(HR.shape[0] - 1, j1)
        jj, ii = np.mgrid[j0:j1 + 1, i0:i1 + 1]
        cx = GX0 + (ii + 0.5) * RES; cz = GZ0 + (jj + 0.5) * RES
        ins = shapely.contains_xy(q, cx, cz) & ~np.isfinite(HR[jj, ii])
        for j, i, x, z in zip(jj[ins], ii[ins], cx[ins], cz[ins]):
            HR[j, i] = y_road(x, z) + dy; KIND[j, i] = kind
        n += int(ins.sum())
    return n
n1 = raster_fill(LANE, 1, 0.0); n2 = raster_fill(WALK, 2, 0.15) if not WALK.is_empty else 0
print("cells lane", n1, "walk", n2, flush=True)
def top_at(x, z, dy):
    v = hr_bilinear(x, z)
    return v if v is not None else y_road(x, z) + dy
lt = grid_tris(LANE, lambda x, z: top_at(x, z, 0.0), 2.0)
wt = grid_tris(WALK, lambda x, z: top_at(x, z, 0.15), 2.0) if not WALK.is_empty else np.zeros((0, 3))
R["tris"]["lane"] = np.concatenate([R["tris"]["lane"], lt]) if len(lt) else R["tris"]["lane"]
if len(wt): R["tris"]["walk"] = np.concatenate([R["tris"]["walk"], wt])
cb = curb_faces(WALK, lambda x, z: top_at(x, z, 0.15)) if not WALK.is_empty else np.zeros((0, 3))
if len(cb): R["curb"] = np.concatenate([R["curb"], cb])
R["lanes"] = unary_union([R["lanes"], LANE]); R["raised"] = unary_union([R["raised"], WALK]) if not WALK.is_empty else R["raised"]
print("tris lane", len(lt) // 3, "walk", len(wt) // 3, "curb", len(cb) // 12, flush=True)
pickle.dump(R, open(SRC, "wb"))
print("wrote", SRC)
