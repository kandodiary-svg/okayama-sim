"""v13: 走行面の手直し（patch_bridges.py の後に実行。/home/claude/wx/roads_final.pkl を書き換える）
 1) 橋の取り付け部の段差・くぼみ（京橋・中橋・小橋 など PLATEAU の橋面の両端）を、橋軸方向になめらかな縦断へ直す
 2) PLATEAU の道路データが無い区域（岡山城・県庁の東〜相生橋〜旭川東岸）の車道・歩道を OSM の道路中心線から作る
    （縦断は DEM と既存の路面・橋面を拘束条件にした最小二乗の平滑化。交差点で連続）
 3) 天満屋バスステーション南側の構内通路（西側の道路 → 東側の道路）を路面として足す
 路面標示(/home/claude/wx/markings.pkl)も 1) と同じだけ動かして /home/claude/wx/markings_v13.pkl に書く。
"""
import json, pickle, sys, os, math
import numpy as np
import shapely
from shapely.geometry import Polygon, Point, LineString, box, MultiPolygon
from shapely.ops import unary_union
from shapely.prepared import prep
import mapbox_earcut as earcut
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))
from common import proj
from osm_load import load as osm_load

SRC = "/home/claude/wx/roads_final.pkl"
R = pickle.load(open(SRC, "rb"))
M = pickle.load(open("/home/claude/wx/markings.pkl", "rb"))
HR = R["HR"]; KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]
dem = np.load("/home/claude/wx/dem_grid.npz"); DX0, DZ0, DS = float(dem["x0"]), float(dem["z0"]), float(dem["step"]); DH = dem["H"].astype(np.float64)
def dem_at(x, z):
    fx = (np.asarray(x, float) - DX0) / DS - 0.5; fz = (np.asarray(z, float) - DZ0) / DS - 0.5
    i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
    tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
    return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz
def cell(x, z):
    return int((x - GX0) / RES), int((z - GZ0) / RES)
def hr_at(x, z):
    i, j = cell(x, z)
    if 0 <= j < HR.shape[0] and 0 <= i < HR.shape[1] and np.isfinite(HR[j, i]): return float(HR[j, i])
    return None
def hr_bilinear(x, z):
    """HR の有限値だけで重み付けした双一次補間（無ければ None）"""
    fx = (x - GX0) / RES - 0.5; fz = (z - GZ0) / RES - 0.5
    i0 = int(math.floor(fx)); j0 = int(math.floor(fz)); tx = fx - i0; tz = fz - j0
    if not (0 <= j0 < HR.shape[0] - 1 and 0 <= i0 < HR.shape[1] - 1): return None
    blk = HR[j0:j0 + 2, i0:i0 + 2].astype(np.float64); w = np.array([[(1 - tx) * (1 - tz), tx * (1 - tz)], [(1 - tx) * tz, tx * tz]])
    m = np.isfinite(blk)
    if not m.any(): return None
    return float((blk[m] * w[m]).sum() / max(w[m].sum(), 1e-9)) if w[m].sum() > 1e-6 else float(np.nanmean(blk))

def grid_tris(poly, hfun, step=2.0):
    """多角形を step 格子で切って三角形化（頂点の高さは hfun）。上向き（y+）の巻き"""
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
                rings = [v]; holes = [np.array(h.coords)[:-1] for h in q.interiors]
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
    """歩道の縁の立ち上がり面（両面・12頂点/区間）。top_fn は歩道上面の高さ"""
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

# ============ 1) 橋の取り付け部 ============
EX = json.load(open("/home/claude/wx/osm/extra.json"))
BR = {}
for e in EX["elements"]:
    t = e.get("tags", {})
    if e["type"] == "way" and t.get("man_made") == "bridge" and "geometry" in e and t.get("name"):
        BR[t["name"]] = Polygon([proj(g["lat"], g["lon"]) for g in e["geometry"]]).buffer(0)
def bridge_frame(P):
    rr = np.array(P.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr[1] - rr[0]; e2 = rr[2] - rr[1]
    ax = (e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2).copy(); L = float(np.linalg.norm(ax)); ax /= L
    W = float(min(np.linalg.norm(e1), np.linalg.norm(e2)))
    c = np.array(P.centroid.coords[0]); nrm = np.array([-ax[1], ax[0]])
    return c - ax * L / 2, ax, nrm, L, W

TRI_CATS = list(R["tris"].keys())
def tri_surface_fn(t):
    A, B, C = t
    v0 = C[[0, 2]] - A[[0, 2]]; v1 = B[[0, 2]] - A[[0, 2]]
    d00 = v0 @ v0; d01 = v0 @ v1; d11 = v1 @ v1; den = d00 * d11 - d01 * d01
    if abs(den) < 1e-12: return lambda x, z: float(np.mean(t[:, 1]))
    def hf(x, z):
        px, pz = x - A[0], z - A[2]
        d02 = v0[0] * px + v0[1] * pz; d12 = v1[0] * px + v1[1] * pz
        u = (d11 * d02 - d01 * d12) / den; v = (d00 * d12 - d01 * d02) / den
        return A[1] + u * (C[1] - A[1]) + v * (B[1] - A[1])
    return hf

WALKCAT = ("walk", "island", "tramstop", "green")
def reshape_zone(zone, hfun):
    """zone 内の路面三角形を 1m 格子で切り直し、高さを hfun(x,z)（車道面の高さ）＋歩道なら 0.15 にする。HR も同じ"""
    zp = prep(zone)
    x0, z0, x1, z1 = zone.bounds
    for cat in TRI_CATS:
        T = R["tris"][cat].reshape(-1, 3, 3)
        if not len(T): continue
        polys = shapely.polygons(np.concatenate([T[:, :, [0, 2]], T[:, :1, [0, 2]]], 1))
        hit = shapely.intersects(polys, zone)
        if not hit.any(): continue
        keep = [T[~hit].reshape(-1, 3)]; new = []
        dy = 0.15 if cat in WALKCAT else 0.0
        for k in np.nonzero(hit)[0]:
            hf = tri_surface_fn(T[k])
            pg = shapely.make_valid(polys[k])
            outside = pg.difference(zone); inside = pg.intersection(zone)
            if not outside.is_empty and outside.area > 1e-4:
                r_ = grid_tris(outside, lambda x, z: hf(x, z), step=50.0)
                if len(r_): new.append(r_)
            if not inside.is_empty and inside.area > 1e-4:
                r_ = grid_tris(inside, lambda x, z: hfun(x, z) + dy, step=1.0)
                if len(r_): new.append(r_)
        R["tris"][cat] = np.concatenate(keep + new) if new else np.concatenate(keep)
    # 縁石・路面標示: 頂点ごとに、その位置の新旧の車道面の差だけ移す
    for arr in (R["curb"], M["white"], M["yellow"]):
        if not len(arr): continue
        m = np.nonzero((arr[:, 0] > x0 - 1) & (arr[:, 0] < x1 + 1) & (arr[:, 2] > z0 - 1) & (arr[:, 2] < z1 + 1))[0]
        for k in m:
            if not zp.contains(Point(arr[k, 0], arr[k, 2])): continue
            old = lane_ref(arr[k, 0], arr[k, 2])
            if old is not None: arr[k, 1] += hfun(arr[k, 0], arr[k, 2]) - old
    i0, j0 = cell(x0, z0); i1, j1 = cell(x1, z1)
    for j in range(max(0, j0), min(HR.shape[0], j1 + 1)):
        for i in range(max(0, i0), min(HR.shape[1], i1 + 1)):
            if np.isfinite(HR[j, i]):
                x = GX0 + (i + 0.5) * RES; z = GZ0 + (j + 0.5) * RES
                if zp.contains(Point(x, z)): HR[j, i] = hfun(x, z) + (0.15 if KIND[j, i] == 2 else 0.0)

LANE0 = None
def lane_ref(x, z):
    """書き換え前の車道面（KIND==1 のセル）の高さ。半径 1.5m の中央値"""
    i, j = cell(x, z)
    sub = LANE0[max(0, j - 3):j + 4, max(0, i - 3):i + 4]; v = sub[np.isfinite(sub)]
    return float(np.median(v)) if len(v) else None

def smooth01(u):
    u = np.clip(u, 0, 1); return u * u * (3 - 2 * u)

def fix_bridge_ends(name, s_out=30.0, s_in=8.0, feather=4.0):
    global LANE0
    LANE0 = np.where(KIND == 1, HR, np.nan).astype(np.float32)
    P = BR[name]; A, ax, nrm, L, W = bridge_frame(P)
    def sec(s, o):
        p = A + ax * s + nrm * o; return lane_ref(*p)
    def med(s):
        v = [sec(s, o) for o in np.arange(-W / 2 + 1.5, W / 2 - 1.4, 1.0)]
        v = [q for q in v if q is not None]
        return float(np.median(v)) if v else None
    log = []
    for end in (0, 1):
        sb = -s_out if end == 0 else L + s_out
        sd = s_in if end == 0 else L - s_in
        hb, hd = med(sb), med(sd)
        if hb is None or hd is None: log.append((end, "skip")); continue
        offs = np.arange(-W / 2 - feather, W / 2 + feather + 0.01, 0.5)
        def cross(s, h0):
            v = np.array([(lambda q: q - h0 if q is not None else np.nan)(sec(s, o)) for o in offs]); ok = np.isfinite(v)
            return np.interp(offs, offs[ok], v[ok]) if ok.any() else np.zeros_like(offs)
        cb = cross(sb, hb); cd = cross(sd, hd)
        lo, hi = min(sb, sd), max(sb, sd)
        def hfun(x, z, sb=sb, sd=sd, hb=hb, hd=hd, cb=cb, cd=cd):
            q = np.array([x, z]) - A; s = float(q @ ax); o = float(q @ nrm)
            u = float(np.clip((s - sb) / (sd - sb), 0, 1))
            want = hb + (hd - hb) * float(smooth01(u)) + (1 - u) * float(np.interp(o, offs, cb)) + u * float(np.interp(o, offs, cd))
            f = float(smooth01((W / 2 + feather - abs(o)) / feather))
            if f >= 1.0: return want
            cur = lane_ref(x, z)
            return want if cur is None else cur + f * (want - cur)
        zone = Polygon([A + ax * lo + nrm * (W / 2 + feather), A + ax * hi + nrm * (W / 2 + feather),
                        A + ax * hi - nrm * (W / 2 + feather), A + ax * lo - nrm * (W / 2 + feather)])
        reshape_zone(zone, hfun)
        LANE0 = np.where(KIND == 1, HR, np.nan).astype(np.float32)
        log.append((end, round(hb, 2), round(hd, 2)))
    print("bridge ends", name, "L", round(L), "W", round(W), log, flush=True)

for nm in ("京橋", "中橋", "小橋"):
    if nm in BR: fix_bridge_ends(nm)

# ============ 2) PLATEAU の道路が無い区域の道路（OSM から） ============
REG = box(1250, 100, 2060, 560)
ways, _nodes = osm_load()
DRV = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
def width_of(t):
    try:
        if t.get("width"): return float(str(t["width"]).split(";")[0]) + 0.5
    except Exception: pass
    try: ln = int(str(t.get("lanes", "")).split(";")[0])
    except Exception: ln = None
    hw = t.get("highway", "").replace("_link", "")
    if ln: return ln * 3.25 + 1.0
    return {"trunk": 10.0, "primary": 10.0, "secondary": 8.5, "tertiary": 7.5, "unclassified": 5.0, "residential": 4.5}.get(hw, 5.0)
sel = [w for w in ways if w["tags"].get("highway") in DRV and len(w["xy"]) >= 2 and LineString(w["xy"]).intersects(REG)]
existing = unary_union([R["lanes"], R["raised"]]).buffer(0.05)
ex_p = prep(existing)
# 水面（川）: この上の DEM は使わない
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

# 変数: OSM ノード（共有）と、辺の途中 1m ごとの点
var_of_node = {}; X = []; wdata = []; ydata = []; wanch = []; yanch = []
edges1 = []; chains = []
def new_var(p):
    X.append(p); x, z = p
    d = float(dem_at(x, z)); inw = WATER is not None and WATER.contains(Point(x, z))
    wdata.append(0.0 if inw else 1.0); ydata.append(d)
    # 既存の路面（PLATEAU・橋面）に乗っている点は強く拘束
    i, j = cell(x, z)
    sub = HR[max(0, j - 2):j + 3, max(0, i - 2):i + 3]; kk = KIND[max(0, j - 2):j + 3, max(0, i - 2):i + 3]
    v = sub[np.isfinite(sub) & (kk == 1)]
    if len(v) >= 4: wanch.append(400.0); yanch.append(float(np.median(v)))
    else: wanch.append(0.0); yanch.append(0.0)
    return len(X) - 1
for w in sel:
    ns = w["nodes"]; xy = np.asarray(w["xy"], float)
    seq = []
    for k in range(len(xy)):
        nid = ns[k] if k < len(ns) else None
        if nid is not None and nid in var_of_node: vi = var_of_node[nid]
        else:
            vi = new_var(tuple(xy[k]))
            if nid is not None: var_of_node[nid] = vi
        if k > 0:
            a = xy[k - 1]; b = xy[k]; L = float(np.linalg.norm(b - a)); n = int(L // 1.0)
            for m in range(1, n):
                seq.append(new_var(tuple(a + (b - a) * m / n)))
        seq.append(vi)
    chains.append(seq)
    for a, b in zip(seq[:-1], seq[1:]): edges1.append((a, b))
N = len(X); X = np.array(X)
print("gap roads: ways", len(sel), "samples", N, "anchored", int(np.sum(np.array(wanch) > 0)), flush=True)
LAM1, LAM2 = 30.0, 900.0
rows, cols, vals = [], [], []
def add(i, j, v): rows.append(i); cols.append(j); vals.append(v)
diag = np.array(wdata) * 1.0 + np.array(wanch)
rhs = np.array(wdata) * np.array(ydata) + np.array(wanch) * np.array(yanch)
for a, b in edges1:
    add(a, a, LAM1); add(b, b, LAM1); add(a, b, -LAM1); add(b, a, -LAM1)
for seq in chains:
    for a, b, c in zip(seq[:-2], seq[1:-1], seq[2:]):
        # (y_a - 2 y_b + y_c)^2
        for (i, ci) in ((a, 1), (b, -2), (c, 1)):
            for (j, cj) in ((a, 1), (b, -2), (c, 1)):
                add(i, j, LAM2 * ci * cj)
for i in range(N): add(i, i, diag[i] + 1e-6)
Amat = sparse.csr_matrix((vals, (rows, cols)), shape=(N, N))
Y = spsolve(Amat.tocsc(), rhs)
print("  profile solved: y range", round(float(Y.min()), 2), round(float(Y.max()), 2), flush=True)
ktree = cKDTree(X)
def y_road(x, z):
    d, ii = ktree.query([x, z], k=6)
    w = 1.0 / (d + 0.5) ** 2
    return float((Y[ii] * w).sum() / w.sum())

# 車道・歩道の多角形
lane_polys = []; walk_polys = []
for w in sel:
    t = w["tags"]; ln = LineString(w["xy"]); wd = width_of(t)
    lane_polys.append(ln.buffer(wd / 2, cap_style=1, join_style=1))
    hw = t.get("highway", "").replace("_link", "")
    if hw in ("trunk", "primary", "secondary", "tertiary") and t.get("embankment") != "yes" and t.get("bridge") != "yes":
        walk_polys.append(ln.buffer(wd / 2 + 2.5, cap_style=2, join_style=2))
# 相生橋の取り付け部（橋面の車道幅から道路の幅へ 15m で絞る）
if "相生橋" in BR:
    A, ax, nrm, L, W = bridge_frame(BR["相生橋"])
    WL = W - 5.0
    for end, sgn in ((A, -1), (A + ax * L, 1)):
        q = end + ax * sgn * 0.3
        wa = 8.0
        lane_polys.append(Polygon([q + nrm * WL / 2, q - nrm * WL / 2, q + ax * sgn * 16 - nrm * wa / 2, q + ax * sgn * 16 + nrm * wa / 2]).buffer(0))
        walk_polys.append(Polygon([q + nrm * W / 2, q - nrm * W / 2, q + ax * sgn * 16 - nrm * (wa / 2 + 2.5), q + ax * sgn * 16 + nrm * (wa / 2 + 2.5)]).buffer(0))
LANE = unary_union(lane_polys).intersection(REG).difference(existing)
LANE = unary_union([g for g in (LANE.geoms if hasattr(LANE, "geoms") else [LANE]) if isinstance(g, Polygon) and g.area > 2.0])
WALK = unary_union(walk_polys).intersection(REG).difference(unary_union(lane_polys)).difference(existing)
WALK = unary_union([g for g in (WALK.geoms if hasattr(WALK, "geoms") else [WALK]) if isinstance(g, Polygon) and g.area > 3.0 and g.buffer(-0.6).area > 0])
print("  new lane area", round(LANE.area), "walk area", round(WALK.area), flush=True)

# HR / KIND に書き込む（車道=道路面、歩道=+0.15）
def raster_fill(poly, kind, dy):
    x0, z0, x1, z1 = poly.bounds
    i0, j0 = cell(x0, z0); i1, j1 = cell(x1, z1)
    jj, ii = np.mgrid[j0:j1 + 1, i0:i1 + 1]
    cx = GX0 + (ii + 0.5) * RES; cz = GZ0 + (jj + 0.5) * RES
    ins = shapely.contains_xy(poly, cx, cz) & ~np.isfinite(HR[jj, ii])
    for j, i, x, z in zip(jj[ins], ii[ins], cx[ins], cz[ins]):
        HR[j, i] = y_road(x, z) + dy; KIND[j, i] = kind
    return ins.sum()
newmask = np.zeros(HR.shape, bool)
x0_, z0_, x1_, z1_ = REG.bounds
I0, J0 = cell(x0_, z0_); I1, J1 = cell(x1_, z1_)
before = np.isfinite(HR[J0:J1, I0:I1]).copy()
n1 = raster_fill(LANE, 1, 0.0); n2 = raster_fill(WALK, 2, 0.15)
newmask[J0:J1, I0:I1] = np.isfinite(HR[J0:J1, I0:I1]) & ~before
print("  cells lane", n1, "walk", n2, flush=True)
# 継ぎ目をならす（新しいセルだけ、既存の面も参照して σ=1m）
sub = HR[J0:J1, I0:I1].astype(np.float64); fin = np.isfinite(sub); nm = newmask[J0:J1, I0:I1]
kk = KIND[J0:J1, I0:I1]
for kind_ in (1, 2):
    m = fin & (kk == kind_)
    num = ndimage.gaussian_filter(np.where(m, sub, 0.0), 2.0); den = ndimage.gaussian_filter(m.astype(float), 2.0)
    sm = np.where(den > 1e-3, num / np.maximum(den, 1e-9), np.nan)
    upd = nm & (kk == kind_) & np.isfinite(sm)
    sub[upd] = sm[upd]
HR[J0:J1, I0:I1] = sub.astype(HR.dtype)
def top_at(x, z, dy):
    v = hr_bilinear(x, z)
    return v if v is not None else y_road(x, z) + dy
lt = grid_tris(LANE, lambda x, z: top_at(x, z, 0.0), 2.0)
wt = grid_tris(WALK, lambda x, z: top_at(x, z, 0.15), 2.0)
R["tris"]["lane"] = np.concatenate([R["tris"]["lane"], lt]); R["tris"]["walk"] = np.concatenate([R["tris"]["walk"], wt])
cb = curb_faces(WALK, lambda x, z: top_at(x, z, 0.15))
R["curb"] = np.concatenate([R["curb"], cb])
R["lanes"] = unary_union([R["lanes"], LANE]); R["raised"] = unary_union([R["raised"], WALK])
print("  tris lane", len(lt) // 3, "walk", len(wt) // 3, "curb", len(cb) // 12, flush=True)

# ============ 3) 天満屋バスステーション南側の構内通路 ============
# 駅舎（PLATEAU: 南面 z≒459.0）と南隣の建物（北面 z≒464.3）の間。西の道路 (x≒780) から東の道路 (x≒818) まで
TP = Polygon([(779.0, 459.3), (819.5, 459.3), (819.5, 464.0), (779.0, 464.0)]).difference(existing)
TP = unary_union([g for g in (TP.geoms if hasattr(TP, "geoms") else [TP]) if isinstance(g, Polygon) and g.area > 1.0])
hw_ = hr_at(781.5, 461.6) or 3.72; he_ = hr_at(817.0, 461.6) or 3.81
def h_tp(x, z): return hw_ + (he_ - hw_) * float(np.clip((x - 781.5) / (817.0 - 781.5), 0, 1))
x0, z0, x1, z1 = TP.bounds; i0, j0 = cell(x0, z0); i1, j1 = cell(x1, z1)
nt = 0
for j in range(j0, j1 + 1):
    for i in range(i0, i1 + 1):
        x = GX0 + (i + 0.5) * RES; z = GZ0 + (j + 0.5) * RES
        if TP.contains(Point(x, z)) and not np.isfinite(HR[j, i]): HR[j, i] = h_tp(x, z); KIND[j, i] = 1; nt += 1
# 駅舎の東西の、のりばに沿う車線（PLATEAU では道路面が無く地面のままだった所）: 東 809.9〜、西 〜787.2
existing2 = unary_union([R["lanes"], R["raised"]]).buffer(0.05)
BAYS = unary_union([Polygon([(809.9, 356.5), (816.0, 356.5), (816.0, 459.5), (809.9, 459.5)]),
                    Polygon([(781.0, 356.5), (787.2, 356.5), (787.2, 459.5), (781.0, 459.5)])]).difference(existing2)
BAYS = unary_union([g for g in (BAYS.geoms if hasattr(BAYS, "geoms") else [BAYS]) if isinstance(g, Polygon) and g.area > 1.0])
def h_bay(x, z):
    xs = 818.0 if x > 798 else 780.0
    v = hr_at(xs, z)
    return v if v is not None else h_tp(x, 461.6)
x0, z0, x1, z1 = BAYS.bounds; i0, j0 = cell(x0, z0); i1, j1 = cell(x1, z1)
for j in range(j0, j1 + 1):
    for i in range(i0, i1 + 1):
        x = GX0 + (i + 0.5) * RES; z = GZ0 + (j + 0.5) * RES
        if BAYS.contains(Point(x, z)) and not np.isfinite(HR[j, i]): HR[j, i] = h_bay(x, z); KIND[j, i] = 1; nt += 1
tb_ = grid_tris(BAYS, h_bay, 2.0)
R["tris"]["lane"] = np.concatenate([R["tris"]["lane"], tb_]); R["lanes"] = unary_union([R["lanes"], BAYS])
tt = grid_tris(TP, lambda x, z: h_tp(x, z), 2.0)
R["tris"]["lane"] = np.concatenate([R["tris"]["lane"], tt]); R["lanes"] = unary_union([R["lanes"], TP])
print("tenmaya passage area", round(TP.area, 1), "cells", nt, "tris", len(tt) // 3, flush=True)

# ============ 4) 走行経路（バス・電車の道路）沿いの路面の段差・横傾き・崖の均し ============
# PLATEAU の道路面には、頂点の高さの誤りで道路が横に大きく傾いたり、交差点で 1〜2m の崖になったりする所がある。
# 経路の近くでそういう所を見つけ、その周りの路面を「元の高さに近く・なめらか」な面に解き直して（最小二乗）、1m 格子で張り直す。
def regularize_routes():
    global LANE0
    import json as _j
    paths = []
    B = _j.load(open("/home/claude/wx/bus_ref.json")); paths.append(np.array(B["path"])[:, [0, 2]])
    RT = _j.load(open("/home/claude/wx/routes_ref.json"))
    for k in ("higashi", "seiki"): paths.append(np.array(RT[k]["track"])[:, [0, 2]])
    ROUTE = unary_union([LineString(p) for p in paths]).buffer(14.0)
    # v29: 範囲拡大でラスタが大きいので、経路の外接矩形＋40m の窓だけで計算する（経路から 40m 以上離れた所は元から対象外なので結果は同じ）
    _bx0, _bz0, _bx1, _bz1 = ROUTE.bounds
    WI0, WJ0 = [max(0, v) for v in cell(_bx0 - 40, _bz0 - 40)]; WI1, WJ1 = cell(_bx1 + 40, _bz1 + 40)
    WI1 = min(HR.shape[1], WI1 + 1); WJ1 = min(HR.shape[0], WJ1 + 1)
    HRw = HR[WJ0:WJ1, WI0:WI1]; KDw = KIND[WJ0:WJ1, WI0:WI1]
    Hf = HRw.astype(np.float64); fin = np.isfinite(Hf)
    walk = KDw == 2
    Lv = np.where(fin, Hf - np.where(walk, 0.15, 0.0), np.nan)       # 車道面の高さに揃えた値
    st = np.zeros(HRw.shape, bool)
    dx = np.abs(np.diff(Lv, axis=1)); dz = np.abs(np.diff(Lv, axis=0))
    bx = np.nan_to_num(dx) > 0.10; bz = np.nan_to_num(dz) > 0.10
    st[:, 1:] |= bx; st[:, :-1] |= bx; st[1:, :] |= bz; st[:-1, :] |= bz
    jj, ii = np.nonzero(st)
    cx = GX0 + (ii + WI0 + 0.5) * RES; cz = GZ0 + (jj + WJ0 + 0.5) * RES
    inr = shapely.contains_xy(ROUTE, cx, cz)
    pts = np.stack([cx[inr], cz[inr]], 1)
    print("regularize: steep cells near routes", len(pts), flush=True)
    if not len(pts): return
    # 近い点をまとめて円で覆う
    kt = cKDTree(pts); used = np.zeros(len(pts), bool); circles = []
    for k in range(len(pts)):
        if used[k]: continue
        nb = kt.query_ball_point(pts[k], 3.0); used[nb] = True
        circles.append(Point(*pts[k]).buffer(9.0, 12))
    Z = unary_union(circles)
    comps = list(Z.geoms) if hasattr(Z, "geoms") else [Z]
    print("  zones", len(comps), "area", round(Z.area), flush=True)
    LAM = 30.0
    newL = Lv.copy()
    for zp_ in comps:
        x0, z0, x1, z1 = zp_.bounds
        i0, j0 = cell(x0 - 2, z0 - 2); i1, j1 = cell(x1 + 2, z1 + 2)
        i0 = max(i0, 1); j0 = max(j0, 1); i1 = min(i1, HR.shape[1] - 2); j1 = min(j1, HR.shape[0] - 2)
        i0 -= WI0; i1 -= WI0; j0 -= WJ0; j1 -= WJ0   # v29: 窓の中の番号
        sub = Lv[j0:j1 + 1, i0:i1 + 1]; f = np.isfinite(sub)
        J, I = np.mgrid[j0:j1 + 1, i0:i1 + 1]
        ins = shapely.contains_xy(zp_, GX0 + (I + WI0 + 0.5) * RES, GZ0 + (J + WJ0 + 0.5) * RES) & f
        if ins.sum() < 4: continue
        vid = -np.ones(sub.shape, int); vid[ins] = np.arange(ins.sum())
        n = int(ins.sum()); d = sub[ins]
        w = np.ones(n)
        for it in range(3):
            rows, cols, vals = [], [], []; rhs = w * d; diag = w.copy()
            for (dj, di) in ((0, 1), (1, 0)):
                a = ins[:sub.shape[0] - dj, :sub.shape[1] - di]; b_ = f[dj:, di:]
                A_ = vid[:sub.shape[0] - dj, :sub.shape[1] - di]; B_ = vid[dj:, di:]
                # 両方とも変数
                m = a & ins[dj:, di:]
                ia = A_[m]; ib = B_[m]
                diag_add = np.bincount(ia, minlength=n) * LAM + np.bincount(ib, minlength=n) * LAM
                diag += diag_add
                rows += list(ia) + list(ib); cols += list(ib) + list(ia); vals += [-LAM] * (2 * len(ia))
                # 片方が固定（区域外の路面）
                m2 = a & b_ & ~ins[dj:, di:]
                ia2 = A_[m2]; fv = sub[dj:, di:][m2]
                np.add.at(diag, ia2, LAM); np.add.at(rhs, ia2, LAM * fv)
                m3 = ins[dj:, di:] & f[:sub.shape[0] - dj, :sub.shape[1] - di] & ~ins[:sub.shape[0] - dj, :sub.shape[1] - di]
                ib3 = B_[m3]; fv3 = sub[:sub.shape[0] - dj, :sub.shape[1] - di][m3]
                np.add.at(diag, ib3, LAM); np.add.at(rhs, ib3, LAM * fv3)
            rows += list(range(n)); cols += list(range(n)); vals += list(diag)
            A = sparse.csr_matrix((vals, (rows, cols)), shape=(n, n))
            h = spsolve(A.tocsc(), rhs)
            r = np.abs(h - d); w = 1.0 / (1.0 + (r / 0.12) ** 2)
        blk = newL[j0:j1 + 1, i0:i1 + 1]; blk[ins] = h
    NEWL = newL
    def hfun(x, z):
        fx = (x - GX0) / RES - 0.5 - WI0; fz = (z - GZ0) / RES - 0.5 - WJ0
        i0 = int(math.floor(fx)); j0 = int(math.floor(fz)); tx = fx - i0; tz = fz - j0
        blk = NEWL[j0:j0 + 2, i0:i0 + 2]; wv = np.array([[(1 - tx) * (1 - tz), tx * (1 - tz)], [(1 - tx) * tz, tx * tz]])
        m = np.isfinite(blk)
        if m.any() and wv[m].sum() > 1e-6: return float((blk[m] * wv[m]).sum() / wv[m].sum())
        sub = NEWL[j0 - 3:j0 + 5, i0 - 3:i0 + 5]; v = sub[np.isfinite(sub)]
        return float(np.median(v)) if len(v) else float(dem_at(x, z))
    LANE0 = np.where(KIND == 1, HR, np.nan).astype(np.float32)
    for zp_ in comps: reshape_zone(zp_, hfun)
    print("  regularized", flush=True)
regularize_routes()

pickle.dump(R, open(SRC, "wb"))
pickle.dump(M, open("/home/claude/wx/markings_v13.pkl", "wb"))
print("wrote", SRC)
