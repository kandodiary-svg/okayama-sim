"""PLATEAU の道路データに橋面が無い橋（相生橋など）に、OSM の橋の輪郭から橋面を作って roads_final.pkl に足す。
高さは両岸の路面高さを直線でつなぐ（中央をわずかに持ち上げる）。両側 2.5m は歩道。"""
import json, pickle, sys, os, shutil
import numpy as np
from shapely.geometry import Polygon, Point, LineString, box
from shapely.ops import unary_union
import shapely, mapbox_earcut as earcut
sys.path.insert(0, os.path.dirname(__file__))
from common import proj
SRC = "/home/claude/wx/roads_final.pkl"
from common import load_roads, save_roads
R = load_roads(SRC, "r+")   # v30: 格子はその場で書き換える（roads_final.pkl は merge_roads.py が毎回作り直す）
HR = R["HR"]; KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]
dem = np.load("/home/claude/wx/dem_grid.npz"); DX0, DZ0, DS = float(dem["x0"]), float(dem["z0"]), float(dem["step"]); DH = dem["H"]
def dem_at(x, z):
    i = int(np.clip((x - DX0) / DS, 0, DH.shape[1] - 1)); j = int(np.clip((z - DZ0) / DS, 0, DH.shape[0] - 1)); return float(DH[j, i])
d = json.load(open("/home/claude/wx/osm/extra.json"))
added = []
# v29: 広げた所（core の外）では、車道の橋（OSM の highway が橋の上を通る）だけに橋面を作る（鉄道・歩道橋・水路橋に作らない）
from common import CORE
from osm_load import load as _osm_load
_CARW = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service",
         "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
_RB = [LineString(w["xy"]) for w in _osm_load()[0] if w["tags"].get("highway") in _CARW and w["tags"].get("bridge") in ("yes", "viaduct") and len(w["xy"]) >= 2]
def _road_bridge(P, L):
    return sum(ln.intersection(P).length for ln in _RB if ln.intersects(P)) > 0.5 * L
for e in d["elements"]:
    t = e.get("tags", {})
    if e["type"] != "way" or t.get("man_made") != "bridge" or "geometry" not in e: continue
    P = Polygon([proj(g["lat"], g["lon"]) for g in e["geometry"]]).buffer(0)
    if P.area < 400: continue
    x0, z0, x1, z1 = P.bounds
    if x1 < GX0 or z1 < GZ0 or x0 > GX0 + HR.shape[1] * RES or z0 > GZ0 + HR.shape[0] * RES: continue
    i0 = max(0, int((x0 - GX0) / RES)); i1 = min(HR.shape[1], int((x1 - GX0) / RES) + 1)
    j0 = max(0, int((z0 - GZ0) / RES)); j1 = min(HR.shape[0], int((z1 - GZ0) / RES) + 1)
    jj, ii = np.mgrid[j0:j1, i0:i1]
    cx = GX0 + (ii + 0.5) * RES; cz = GZ0 + (jj + 0.5) * RES
    inside = shapely.contains_xy(P, cx, cz)
    if inside.sum() < 50: continue
    cov = np.isfinite(HR[j0:j1, i0:i1][inside]).mean()
    if cov > 0.4: continue
    rr = np.array(P.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr[1] - rr[0]; e2 = rr[2] - rr[1]
    W = float(min(np.linalg.norm(e1), np.linalg.norm(e2)))
    ax = (e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2).copy(); L = float(np.linalg.norm(ax)); ax /= L
    c = np.array(P.centroid.coords[0]); nrm = np.array([-ax[1], ax[0]])
    A = c - ax * L / 2; B = c + ax * L / 2
    if not (CORE[0] < c[0] < CORE[2] and CORE[1] < c[1] < CORE[3]) and not _road_bridge(P, L):
        print("  skip (not a road bridge / outside core):", t.get("name"), round(c[0]), round(c[1]), round(L)); continue
    def end_h(q):
        # 橋端の外側 3〜25m の路面高さ
        k0 = int((q[0] - GX0) / RES); l0 = int((q[1] - GZ0) / RES); r = int(25 / RES)
        sub = HR[max(0, l0 - r):l0 + r, max(0, k0 - r):k0 + r]
        v = sub[np.isfinite(sub)]
        return float(np.median(v)) if len(v) > 20 else dem_at(*q) + 0.3
    hA, hB = end_h(A), end_h(B)
    W = float(min(np.linalg.norm(e1), np.linalg.norm(e2)))
    def H(x, z):
        s = float(np.clip(((np.array([x, z]) - A) @ ax) / L, 0, 1))
        return hA + (hB - hA) * s + 0.6 * 4 * s * (1 - s)      # 中央がわずかに高い
    # ラスタ（車道＝1、両側 2.5m＝歩道 2）
    lat = np.abs((cx - c[0]) * nrm[0] + (cz - c[1]) * nrm[1])
    for (j, i), ins, la in zip(zip(jj.ravel(), ii.ravel()), inside.ravel(), lat.ravel()):
        if not ins: continue
        x = GX0 + (i + 0.5) * RES; z = GZ0 + (j + 0.5) * RES
        KIND[j, i] = 2 if la > W / 2 - 2.5 else 1
        HR[j, i] = H(x, z) + (0.15 if KIND[j, i] == 2 else 0.0)
    if W >= 9:
        lane = P.intersection(LineString([c - ax * L, c + ax * L]).buffer(W / 2 - 2.5, cap_style=2)); walk = P.difference(lane)
    else:
        lane = P; walk = Polygon()
    def tris(poly):
        out = []
        if poly.is_empty: return np.zeros((0, 3))
        xs = np.arange(np.floor(poly.bounds[0] / 2) * 2, poly.bounds[2] + 2, 2.0); zs = np.arange(np.floor(poly.bounds[1] / 2) * 2, poly.bounds[3] + 2, 2.0)
        for xa in xs:
            for za in zs:
                g = poly.intersection(box(xa, za, xa + 2, za + 2))
                for q in (g.geoms if hasattr(g, "geoms") else [g]):
                    if not isinstance(q, Polygon) or q.area < 1e-3: continue
                    v = np.array(q.exterior.coords)[:-1]
                    if len(v) < 3: continue
                    idx = np.asarray(earcut.triangulate_float64(v, np.array([len(v)], np.uint32))).reshape(-1, 3)
                    for a_, b_, c_ in idx:
                        pa, pb, pc = v[a_], v[b_], v[c_]
                        cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
                        if cr > 0: pb, pc = pc, pb
                        out += [[p[0], H(*p), p[1]] for p in (pa, pb, pc)]
        return np.array(out)
    lt = tris(lane); wt = tris(walk)
    if len(wt): wt[:, 1] += 0.15
    R["tris"]["lane"] = np.concatenate([R["tris"]["lane"], lt]); R["tris"]["walk"] = np.concatenate([R["tris"]["walk"], wt])
    # 歩道の縁の立ち上がり面（無いと車道と歩道の間に隙間が見える）
    cf = []
    for g in (walk.geoms if hasattr(walk, "geoms") else [walk]):
        if g.is_empty: continue
        ring = g.exterior; Lr = ring.length; n = max(1, int(np.ceil(Lr)))
        pts = [np.array(ring.interpolate(Lr * k / n).coords[0]) for k in range(n + 1)]
        for a_, b_ in zip(pts[:-1], pts[1:]):
            ya = H(*a_) + 0.15; yb = H(*b_) + 0.15
            A0 = [a_[0], ya, a_[1]]; B0 = [b_[0], yb, b_[1]]; A1 = [a_[0], ya - 0.17, a_[1]]; B1 = [b_[0], yb - 0.17, b_[1]]
            cf += [A0, A1, B0, B0, A1, B1, A0, B0, A1, B0, B1, A1]
    if cf: R["curb"] = np.concatenate([R["curb"], np.array(cf)])
    R["lanes_parts"] = R.get("lanes_parts", []) + [lane]; R["raised_parts"] = R.get("raised_parts", []) + ([walk] if not walk.is_empty else [])
    added.append((t.get("name"), round(L), round(W), round(hA, 2), round(hB, 2), round(float(cov), 2)))
print("bridge decks added:", added)
save_roads(R, SRC)
