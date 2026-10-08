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
# ---- v41.20: 高架・橋の面の欠け（下を横切る道路の所）をつなぐ ----
# PLATEAU は、高架が別の道路の上を通る所の面を、下の道路の方に割り当てていて、高架の面に幅 5〜35m の穴が開く
# （穴の所で、車は下の道路の高さへ落ちる・高架の下をくぐる道が高架にふさがれずに見える・高架の下面や橋脚が途切れる）。
# OSM の車道の橋の中心線に沿って、橋の面に覆われていない区間（両側は橋の面）を見つけ、その前後の橋の面の幅を断面でとって、
# 間をつなぐ四角形（前の端の高さから後の端の高さへ直線）を橋の面として足す。下に道路がある升目は「上の段」（R["upper"]）に入れる。
import mapbox_earcut as _ec
GAP_MIN = 3; GAP_MAX = 45
_bparts = [q for q in (R.get("bridge_parts") or []) if q is not None and not q.is_empty]
_BU = unary_union(_bparts).buffer(0.05) if _bparts else Polygon()
shapely.prepare(_BU)
_NXh = HR.shape[1]; _NZh = HR.shape[0]
_UPd = {}
if R.get("upper") is not None and len(R["upper"][0]):
    for _k, _y, _kd in zip(np.asarray(R["upper"][0]).tolist(), np.asarray(R["upper"][1]).tolist(), np.asarray(R["upper"][2]).tolist()): _UPd[_k] = (_y, _kd)
def _deck_h(x, z):
    i = int((x - GX0) / RES); j = int((z - GZ0) / RES)
    if not (0 <= i < _NXh and 0 <= j < _NZh): return None
    v = HR[j, i]; u = _UPd.get(j * _NXh + i)
    c = [float(v)] if np.isfinite(v) else []
    if u is not None: c.append(float(u[0]))
    return max(c) if c else None
def _chord(p, nrm):
    """点 p（橋の面の中）を通り nrm 方向の直線で橋の面を切った線分のうち、p を含む 1 本の両端"""
    seg = LineString([p - nrm * 30.0, p + nrm * 30.0]); g = _BU.intersection(seg)
    parts = [q for q in (g.geoms if hasattr(g, "geoms") else [g]) if q.geom_type == "LineString" and not q.is_empty]
    best = None; bd = 1e9
    for q in parts:
        d = q.distance(Point(*p))
        if d < bd: bd = d; best = q
    if best is None or bd > 0.8: return None
    c = np.array(best.coords); a_, b_ = c[0], c[-1]
    if np.dot(b_ - a_, nrm) < 0: a_, b_ = b_, a_      # nrm の向きに並べる（前後の断面で左右をそろえる）
    return a_, b_
n_gap = 0; gap_info = []; gap_new_tris = []; gap_new_polys = []; gap_up = {}
for w in _osm_load()[0]:
    t_ = w["tags"]
    if t_.get("highway") not in _CARW or t_.get("bridge") not in ("yes", "viaduct") or len(w["xy"]) < 2: continue
    ln = LineString(w["xy"]); Lw = ln.length
    if Lw < GAP_MIN + 2: continue
    ss = np.arange(0.5, Lw, 1.0); pts = shapely.line_interpolate_point(ln, ss)
    cov = shapely.contains(_BU, pts)
    k = 0; nS = len(ss)
    while k < nS:
        if cov[k]: k += 1; continue
        e = k
        while e < nS and not cov[e]: e += 1
        if k >= 2 and e < nS - 1 and GAP_MIN <= e - k <= GAP_MAX:
            sb = ss[k - 2] if k >= 2 else None; sa = ss[min(e + 1, nS - 1)]
            pb = np.array(ln.interpolate(sb).coords[0]); pa = np.array(ln.interpolate(sa).coords[0])
            dB = np.array(ln.interpolate(sb + 1.0).coords[0]) - np.array(ln.interpolate(max(0.0, sb - 1.0)).coords[0]); dA = np.array(ln.interpolate(min(Lw, sa + 1.0)).coords[0]) - np.array(ln.interpolate(sa - 1.0).coords[0])
            if np.linalg.norm(dB) < 1e-6 or np.linalg.norm(dA) < 1e-6: k = e; continue
            nB = np.array([-dB[1], dB[0]]) / np.linalg.norm(dB); nA = np.array([-dA[1], dA[0]]) / np.linalg.norm(dA)
            cB = _chord(pb, nB); cA = _chord(pa, nA); hB = _deck_h(*pb); hA = _deck_h(*pa)
            if cB is None or cA is None or hB is None or hA is None: k = e; continue
            quad = Polygon([cB[0], cB[1], cA[1], cA[0]]).buffer(0)
            if quad.is_empty or quad.area < 3.0: k = e; continue
            patch = quad.difference(_BU)
            patch = unary_union([q for q in (patch.geoms if hasattr(patch, "geoms") else [patch]) if q.geom_type == "Polygon" and q.area > 1.0])
            if patch.is_empty: k = e; continue
            if abs(hA - hB) > 0.12 * max(5.0, e - k + 4.0) + 1.0: print("  deck gap skipped (height step too large):", t_.get("name"), round(pb[0]), round(pb[1]), round(hB, 1), round(hA, 1)); k = e; continue
            ax = pa - pb; Ls = float(np.dot(ax, ax))
            def Hq(x, z, _pb=pb, _ax=ax, _Ls=Ls, _hB=hB, _hA=hA):
                s_ = np.clip(((np.stack([x, z], 1) - _pb) @ _ax) / max(_Ls, 1e-6), 0.0, 1.0); return _hB + (_hA - _hB) * s_
            # 三角形
            tri_ = []
            for q in (patch.geoms if hasattr(patch, "geoms") else [patch]):
                if q.geom_type != "Polygon": continue
                rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
                rings = [r for r in rings if len(r) >= 3]
                if not rings: continue
                v = np.concatenate(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
                idx = np.asarray(_ec.triangulate_float64(v, ends)).reshape(-1, 3)
                for a_, b_, c_ in idx:
                    pa_, pb_, pc_ = v[a_], v[b_], v[c_]
                    cr = (pb_[0] - pa_[0]) * (pc_[1] - pa_[1]) - (pb_[1] - pa_[1]) * (pc_[0] - pa_[0])
                    if cr > 0: pb_, pc_ = pc_, pb_
                    for p_ in (pa_, pb_, pc_): tri_.append([p_[0], float(Hq(np.array([p_[0]]), np.array([p_[1]]))[0]), p_[1]])
            if not tri_: k = e; continue
            gap_new_tris.append(np.array(tri_)); gap_new_polys.append(patch)
            # 升目（0.5m）: 下に道路（2.5m 以上低い）があれば上の段へ、無ければその升目の高さに
            x0_, z0_, x1_, z1_ = patch.bounds
            i0 = max(0, int((x0_ - GX0) / RES)); i1 = min(_NXh, int((x1_ - GX0) / RES) + 1); j0 = max(0, int((z0_ - GZ0) / RES)); j1 = min(_NZh, int((z1_ - GZ0) / RES) + 1)
            jj, ii = np.mgrid[j0:j1, i0:i1]; cx = GX0 + (ii + 0.5) * RES; cz = GZ0 + (jj + 0.5) * RES
            ins = shapely.contains_xy(patch, cx, cz)
            yy = Hq(cx[ins], cz[ins]) + 0.0; sub = HR[j0:j1, i0:i1]; ks = KIND[j0:j1, i0:i1]
            cur = sub[ins]; low = np.isfinite(cur) & (cur < yy - 2.5)
            ji = np.nonzero(ins)
            for q_, (jq, iq) in enumerate(zip(ji[0].tolist(), ji[1].tolist())):
                if low[q_]: gap_up[(j0 + jq) * _NXh + (i0 + iq)] = (float(yy[q_]), 1)
                else: sub[jq, iq] = yy[q_]; ks[jq, iq] = 1
            n_gap += 1; gap_info.append((t_.get("name"), round(float(pb[0])), round(float(pb[1])), e - k, round(hB, 1), round(hA, 1), round(patch.area), int(low.sum())))
            _BU = unary_union([_BU, patch.buffer(0.05)]); shapely.prepare(_BU)
        k = e
print("deck gaps filled:", n_gap, gap_info, flush=True)
# ---- v41.20 その 2: 斜めに交差する道の穴など、中心線に沿った補修で埋め残した所 ----
# 橋の面の和集合を閉じる（半径 20m の膨張→収縮）と、幅 40m 以下の隙間が埋まる。その差（元の面に覆われていない所）の
# うち、(1) 面積 3〜1500 m²、(2) 縁の橋の面の高さが 1 つの平面（二乗平均の残差 0.6m 以下・高低差 6m 以下）に載る、
# (3) 面の 45% 以上の下に道路がある（面より 2.5m 以上低い）ものだけを、橋の面として足す（高さは縁の高さの平面）
from shapely.geometry.polygon import orient as _orient
def _phase2():
    global _BU
    n2 = 0; info2 = []
    _BUc = _BU.buffer(20.0, quad_segs=2).buffer(-20.0, quad_segs=2)
    _res = _BUc.difference(_BU)
    for q in (_res.geoms if hasattr(_res, "geoms") else [_res]):
        if q.geom_type != "Polygon" or q.area < 3.0 or q.area > 1500: continue
        q = _orient(q, 1.0); ring = np.array(q.exterior.coords); S = []
        for a_, b_ in zip(ring[:-1], ring[1:]):
            d_ = b_ - a_; L_ = float(np.hypot(*d_))
            if L_ < 1e-6: continue
            nn = np.array([d_[1], -d_[0]]) / L_
            for s_ in np.arange(0.25, L_, 1.0):
                po = a_ + d_ * (s_ / L_) + nn * 0.4
                if shapely.contains_xy(_BU, po[0], po[1]):
                    h_ = _deck_h(po[0], po[1])
                    if h_ is not None: S.append((po[0], po[1], h_))
        if len(S) < 12: continue
        S = np.array(S); mx_, mz_ = S[:, 0].mean(), S[:, 1].mean(); A_ = np.c_[np.ones(len(S)), S[:, 0] - mx_, S[:, 1] - mz_]
        co, _, _, _ = np.linalg.lstsq(A_, S[:, 2], rcond=None); r_ = S[:, 2] - A_ @ co
        if float(np.sqrt((r_ ** 2).mean())) > 0.6 or float(S[:, 2].max() - S[:, 2].min()) > 6.0 or float(np.abs(r_).max()) > 1.8: continue
        hlo, hhi = float(S[:, 2].min()) - 0.3, float(S[:, 2].max()) + 0.3
        def Hq2(x, z, _co=co, _mx=mx_, _mz=mz_, _lo=hlo, _hi=hhi): return np.clip(_co[0] + _co[1] * (np.asarray(x) - _mx) + _co[2] * (np.asarray(z) - _mz), _lo, _hi)
        # 升目（0.5m）: 下に道路があるか
        x0_, z0_, x1_, z1_ = q.bounds
        i0 = max(0, int((x0_ - GX0) / RES)); i1 = min(_NXh, int((x1_ - GX0) / RES) + 1); j0 = max(0, int((z0_ - GZ0) / RES)); j1 = min(_NZh, int((z1_ - GZ0) / RES) + 1)
        jj, ii = np.mgrid[j0:j1, i0:i1]; cx = GX0 + (ii + 0.5) * RES; cz = GZ0 + (jj + 0.5) * RES
        ins = shapely.contains_xy(q, cx, cz)
        if not ins.any(): continue
        yy = Hq2(cx[ins], cz[ins]); sub = HR[j0:j1, i0:i1]; ks = KIND[j0:j1, i0:i1]
        cur = sub[ins]; low = np.isfinite(cur) & (cur < yy - 2.5)
        if float(low.mean()) < 0.45: continue
        # 三角形
        tri_ = []
        rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
        rings = [r for r in rings if len(r) >= 3]
        v = np.concatenate(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        idx = np.asarray(_ec.triangulate_float64(v, ends)).reshape(-1, 3)
        for a_, b_, c_ in idx:
            pa_, pb_, pc_ = v[a_], v[b_], v[c_]
            cr = (pb_[0] - pa_[0]) * (pc_[1] - pa_[1]) - (pb_[1] - pa_[1]) * (pc_[0] - pa_[0])
            if cr > 0: pb_, pc_ = pc_, pb_
            for p_ in (pa_, pb_, pc_): tri_.append([p_[0], float(Hq2(p_[0], p_[1])), p_[1]])
        if not tri_: continue
        gap_new_tris.append(np.array(tri_)); gap_new_polys.append(q)
        ji = np.nonzero(ins)
        for q_, (jq, iq) in enumerate(zip(ji[0].tolist(), ji[1].tolist())):
            if low[q_]: gap_up[(j0 + jq) * _NXh + (i0 + iq)] = (float(yy[q_]), 1)
            else: sub[jq, iq] = yy[q_]; ks[jq, iq] = 1
        n2 += 1; info2.append((round(q.centroid.x), round(q.centroid.y), round(q.area), round(float(low.mean()), 2), round(hlo + 0.3, 1), round(hhi - 0.3, 1)))
        _BU = unary_union([_BU, q.buffer(0.05)]); shapely.prepare(_BU)
    return n2, info2
_n2, _i2 = _phase2()
print("deck gaps filled (phase 2):", _n2, _i2, flush=True)
if gap_new_tris:
    R["tris"]["lane"] = np.concatenate([R["tris"]["lane"]] + gap_new_tris)
    R["bridge_parts"] = list(R.get("bridge_parts") or []) + gap_new_polys
    R["lanes_parts"] = R.get("lanes_parts", []) + gap_new_polys
    if gap_up:
        _UPd.update(gap_up); _ks = np.array(sorted(_UPd.keys()), np.int64)
        R["upper"] = (_ks, np.array([_UPd[q][0] for q in _ks.tolist()], np.float32), np.array([_UPd[q][1] for q in _ks.tolist()], np.uint8))
print("bridge decks added:", added)
save_roads(R, SRC)
