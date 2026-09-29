"""路面標示を生成する。
- 横断歩道: OSM footway=crossing の実線形（無い所は highway=crossing 点から道路に直交）
- 停止線: 信号交差点の横断歩道の手前 2m、接近側の半分
- 車線境界線(破線)・中央線: OSM の lanes / oneway / lanes:forward/backward と PLATEAU 車道幅から
- 車道外側線・軌道敷境界線: 航空写真で線状の明部が確認できた所だけ
- 中央線の色(白/黄): 航空写真の色から判定
出力: /home/claude/wx/markings.pkl {white: tris, yellow: tris}
"""
import os, sys, math, pickle
import numpy as np
import shapely
import shapely.affinity
from shapely.geometry import LineString, Point, Polygon, MultiLineString, box
from shapely.ops import unary_union, substring
from shapely.prepared import prep
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load
from common import BX0, BZ0, BX1, BZ1

from common import load_roads
R = load_roads("/home/claude/wx/roads_final.pkl", "r")
T = pickle.load(open("/home/claude/wx/tracks.pkl", "rb"))
HR = R["HR"]; GX0, GZ0, RES = R["grid"]
O = np.load("/home/claude/wx/ortho/ortho_local.npy", mmap_mode="r")
OX0, OZ0, ORES = BX0, BZ0, 0.5   # v29: 航空写真の格子の原点 = データ範囲の北西の角
ways, nodes = osm_load()

def tri_union(t):
    tt = t.reshape(-1, 3, 3)[:, :, [0, 2]]
    polys = shapely.polygons(np.concatenate([tt, tt[:, :1]], 1))
    polys = polys[shapely.area(polys) > 1e-4]
    return shapely.union_all(shapely.make_valid(polys)).buffer(0.03).buffer(-0.03)

TILEGEO = bool(os.environ.get("MARK_EXT") or os.environ.get("MARK_TILEGEO"))   # v29: 範囲拡大では道路面を 50m 升目ごとに三角形から作る（全域の和集合は重すぎる）
xing = (tri_union(R["tris"]["xing"]) if "xing" in R["tris"] else Polygon()) if not TILEGEO else None
lanes = R["lanes"] if not TILEGEO else None
# 軌道敷: 全線路の両側 1.4m、上下線の間も埋める
tl = [LineString(t["xyz"][:, [0, 2]]) for t in T["tracks"]]
TB = unary_union([l.buffer(1.4, cap_style=2) for l in tl]).buffer(0.9).buffer(-0.9)
carriage = lanes.difference(TB) if not TILEGEO else None
from shapely.strtree import STRtree
def _parts(g): return [q for q in (g.geoms if hasattr(g, "geoms") else [g]) if not q.is_empty]
class Local:
    """巨大な多角形を 50m タイルに分割して近傍演算を速くする"""
    def __init__(self, g, tile=50.0):
        parts = []
        for q in _parts(g):
            x0, z0, x1, z1 = q.bounds
            if max(x1 - x0, z1 - z0) <= tile * 1.5:
                parts.append(q); continue
            for gx in np.arange(math.floor(x0 / tile) * tile, x1, tile):
                for gz in np.arange(math.floor(z0 / tile) * tile, z1, tile):
                    c = q.intersection(box(gx, gz, gx + tile, gz + tile))
                    if not c.is_empty and c.area > 1e-4: parts.append(c)
        self.parts = parts; self.tree = STRtree(self.parts)
    def near(self, geom, pad=0.0):
        b = geom.buffer(pad).envelope if pad else geom.envelope
        idx = self.tree.query(b)
        return unary_union([self.parts[i] for i in idx]) if len(idx) else Polygon()
class TileGeo:
    """v29: 三角形（道路面）を 50m 升目ごとにまとめた面。Local と同じ near() と、点が入るかの contains()。
    升目の面は、その升目に掛かる三角形の和集合を升目で切ったもの（必要になった時に作って覚えておく）"""
    def __init__(self, tris, tile=50.0, minus=None):
        t = np.asarray(tris, np.float64).reshape(-1, 3, 3)[:, :, [0, 2]]
        polys = shapely.polygons(np.concatenate([t, t[:, :1]], 1))
        self.polys = polys[shapely.area(polys) > 1e-4]; self.tree = STRtree(self.polys)
        self.T = tile; self.cache = {}; self.pcache = {}; self.minus = minus
    def tg(self, i, j):
        k = (i, j)
        if k in self.cache: return self.cache[k]
        b = box(i * self.T, j * self.T, (i + 1) * self.T, (j + 1) * self.T)
        idx = self.tree.query(b)
        g = shapely.union_all(shapely.make_valid(self.polys[idx])).buffer(0.03).buffer(-0.03).intersection(b) if len(idx) else Polygon()
        if self.minus is not None and not g.is_empty and self.minus.intersects(b): g = g.difference(self.minus)
        self.cache[k] = g
        return g
    def near(self, geom, pad=0.0):
        if geom.is_empty: return Polygon()
        x0, z0, x1, z1 = geom.bounds
        i0, i1 = int(math.floor((x0 - pad) / self.T)), int(math.floor((x1 + pad) / self.T))
        j0, j1 = int(math.floor((z0 - pad) / self.T)), int(math.floor((z1 + pad) / self.T))
        L = [self.tg(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
        L = [g for g in L if not g.is_empty]
        return unary_union(L) if L else Polygon()
    def contains(self, p, buf=0.0):
        i, j = int(math.floor(p.x / self.T)), int(math.floor(p.y / self.T)); k = (i, j, buf)
        if k not in self.pcache:
            g = self.near(box(i * self.T, j * self.T, (i + 1) * self.T, (j + 1) * self.T), pad=buf + 0.01) if buf > 0 else self.tg(i, j)
            self.pcache[k] = prep(g.buffer(buf) if buf > 0 else g)
        return self.pcache[k].contains(p)
class _Prep:
    def __init__(self, tg, buf): self.tg = tg; self.buf = buf
    def contains(self, p): return self.tg.contains(p, self.buf)
if TILEGEO:
    _lt = [R["tris"][c] for c in ("lane", "xing", "rail") if c in R["tris"] and len(R["tris"][c])]
    LANES = TileGeo(np.concatenate(_lt)); CARR = TileGeo(np.concatenate(_lt), minus=TB)
    XING = TileGeo(R["tris"]["xing"]) if "xing" in R["tris"] else TileGeo(np.zeros((0, 3)))
    carr_p = _Prep(CARR, 0.05); xing_p = _Prep(XING, 0.3); tb_p = prep(TB)
    print("tile geo: lane tris", len(LANES.polys), "xing tris", len(XING.polys), "TB", round(TB.area), flush=True)
else:
    LANES = Local(lanes); CARR = Local(carriage); XING = Local(xing)
    carr_p = prep(carriage.buffer(0.05)); xing_p = prep(xing.buffer(0.3)); tb_p = prep(TB)
    print("areas: lanes", round(lanes.area), "xing", round(xing.area), "TB", round(TB.area), flush=True)

# v32: 橋・高架が道路の上を通る所は「上の段」。橋の区間の線（BR_LINES）を塗る間だけ上の段を使う
_UPR = R.get("upper"); CUR_UP = [False]
if _UPR is not None and len(_UPR[0]):
    _uo = np.argsort(_UPR[0]); _UI = np.asarray(_UPR[0])[_uo]; _UV = np.asarray(_UPR[1])[_uo]
else:
    _UI = np.zeros(0, np.int64); _UV = np.zeros(0, np.float32)
BR_LINES = set()
def h_at(x, z):
    i = int((x - GX0) / RES); j = int((z - GZ0) / RES)
    if 0 <= j < HR.shape[0] and 0 <= i < HR.shape[1]:
        if CUR_UP[0] and len(_UI):
            k = j * HR.shape[1] + i; p_ = int(np.searchsorted(_UI, k))
            if p_ < len(_UI) and _UI[p_] == k: return float(_UV[p_])
        v = HR[j, i]
        if np.isfinite(v): return float(v)
    return None

def ortho_rgb(x, z):
    i = int((x - OX0) / ORES); j = int((z - OZ0) / ORES)
    if 0 <= j < O.shape[0] and 0 <= i < O.shape[1]:
        return O[j, i].astype(float)
    return None

WHITE, YELLOW = [], []
def emit_poly(poly, color, lift=0.012):
    """平面の多角形(2D)を路面に貼る"""
    import mapbox_earcut as earcut
    if MARK_EXT:
        poly = poly.difference(OLDCOV.near(poly, 0.1).buffer(0.02))
        if poly.is_empty: return
    for q in (poly.geoms if hasattr(poly, "geoms") else [poly]):
        if not isinstance(q, Polygon) or q.area < 0.005: continue
        rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
        v = np.concatenate(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        idx = np.asarray(earcut.triangulate_float64(v, ends)).reshape(-1, 3)
        if len(idx) == 0: continue
        a, b, c = v[idx[:, 0]], v[idx[:, 1]], v[idx[:, 2]]
        cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        idx[cr > 0] = idx[cr > 0][:, [0, 2, 1]]
        xz = v[idx.reshape(-1)]
        ys = []
        for x, z in xz:
            h = h_at(x, z)
            ys.append((h if h is not None else np.nan))
        ys = np.array(ys)
        if np.isnan(ys).all(): continue
        ys = np.where(np.isnan(ys), np.nanmedian(ys), ys) + lift
        (WHITE if color == "w" else YELLOW).append(np.stack([xz[:, 0], ys, xz[:, 1]], 1))

def strip(line, width):
    return line.buffer(width / 2, cap_style=2, join_style=2)

MAJOR = {"trunk", "primary", "secondary", "tertiary", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
ROADS = MAJOR | {"unclassified", "residential"}
road_ways = [w for w in ways if w["tags"].get("highway") in ROADS and len(w["xy"]) >= 2]
signals = np.array([[n["x"], n["z"]] for n in nodes if n["tags"].get("highway") == "traffic_signals" or n["tags"].get("railway") == "signal"])
def near_signal(p, r=35):
    return len(signals) and np.min(np.hypot(signals[:, 0] - p[0], signals[:, 1] - p[1])) < r

# 対象範囲: 軌道から 400m
track_zone = unary_union(tl).buffer(400)
if os.environ.get("MARK_ALL"):   # v29: 範囲拡大ではデータ範囲の全域
    track_zone = box(BX0 + 2, BZ0 + 2, BX1 - 2, BZ1 - 2)
zone_p = prep(track_zone)
# v29: MARK_EXT=1 のときは、データ範囲の全域で作り、v28 の道路面（roads_final_core.pkl の車道・交差部）の上の部分は捨てる
#      （v28 の標示 markings_v13.pkl をそのまま使い、道路の増えた所だけ足す。境目では同じ線がつながる）
MARK_EXT = bool(os.environ.get("MARK_EXT"))
if MARK_EXT:
    zone_p = prep(box(BX0 + 2, BZ0 + 2, BX1 - 2, BZ1 - 2))
    _OR = pickle.load(open("/home/claude/wx/roads_final_core.pkl", "rb"))
    OLDCOV = TileGeo(np.concatenate([t for t in _OR["tris"].values() if len(t)]))   # v28 の道路面（全部の種類の三角形）
    del _OR
def zl(ln): return zone_p.intersects(ln)
def zp(p): return zone_p.contains(p)

# ---------------- 横断歩道 ----------------
cw_bands = []
n_cw = 0
cross_ways = [w for w in ways if w["tags"].get("footway") == "crossing" or
              (w["tags"].get("highway") in ("footway", "path", "cycleway") and "crossing" in w["tags"])]
for w in cross_ways:
    if w["tags"].get("crossing") in ("unmarked", "no", "informal"): continue
    ln = LineString(w["xy"])
    if not zl(ln): continue
    band = strip(ln, 4.0)
    area = band.intersection(LANES.near(band).buffer(0.05))
    if area.area < 2: continue
    cw_bands.append((ln, band))
    # 縞: 歩行方向に 0.45m 白 / 0.45m 空き
    L = ln.length
    s = 0.25
    stripes = []
    while s < L - 0.2:
        seg = substring(ln, s, min(L, s + 0.45))
        if seg.length > 0.05: stripes.append(strip(seg, 4.0))
        s += 0.9
    if stripes:
        U = unary_union(stripes); emit_poly(U.intersection(LANES.near(U).buffer(-0.1)), "w"); n_cw += 1
# 横断歩道の線が無い点(highway=crossing)は道路に直交で生成
road_lines = [(w, LineString(w["xy"])) for w in road_ways if w["tags"].get("highway") in MAJOR]
cw_lines = [c[0] for c in cw_bands]
cw_union = unary_union(cw_lines) if cw_lines else LineString()
for n in nodes:
    t = n["tags"]
    if t.get("highway") != "crossing" or t.get("crossing") in ("unmarked", "no", "informal"): continue
    p = Point(n["x"], n["z"])
    if not zp(p) or cw_union.distance(p) < 8: continue
    best = None
    for w, ln in road_lines:
        d = ln.distance(p)
        if d < 1.0 and (best is None or d < best[0]): best = (d, ln)
    if not best: continue
    ln = best[1]; s = ln.project(p)
    a = ln.interpolate(max(0, s - 1)); b = ln.interpolate(min(ln.length, s + 1))
    tv = np.array([b.x - a.x, b.y - a.y]); tv /= np.linalg.norm(tv) + 1e-9
    nv = np.array([-tv[1], tv[0]])
    q = np.array([p.x, p.y])
    _l = LineString([q - nv * 18, q + nv * 18]); cross = _l.intersection(LANES.near(_l))
    if cross.is_empty: continue
    # 点を含む連続区間だけ
    parts = list(cross.geoms) if hasattr(cross, "geoms") else [cross]
    parts = [g for g in parts if g.distance(p) < 1.0]
    if not parts: continue
    cl = parts[0]
    band = strip(cl, 4.0)
    cw_bands.append((cl, band))
    L = cl.length; s = 0.25; stripes = []
    while s < L - 0.2:
        seg = substring(cl, s, min(L, s + 0.45))
        if seg.length > 0.05: stripes.append(strip(seg, 4.0))
        s += 0.9
    if stripes:
        U = unary_union(stripes); emit_poly(U.intersection(LANES.near(U).buffer(-0.1)), "w"); n_cw += 1
print("crosswalks", n_cw, flush=True)
cw_area = unary_union([b for _, b in cw_bands]).buffer(1.0) if cw_bands else Polygon()
CWA = Local(cw_area); cwa_p = prep(cw_area)

# ---------------- 停止線 ----------------
n_sl = 0
for ln, band in cw_bands:
    c = np.array(ln.interpolate(0.5, normalized=True).coords[0])
    if not near_signal(c): continue
    coords = np.array(ln.coords); d = coords[-1] - coords[0]; d /= np.linalg.norm(d) + 1e-9
    r = np.array([-d[1], d[0]])  # 車の進行方向(横断歩道に直交)
    for sgn in (1, -1):
        off = sgn * (2.0 + 2.0 + 0.225)  # 横断歩道半幅 2m + 2m 手前
        sl = LineString([c - d * 30 + r * off, c + d * 30 + r * off])
        v = -sgn * r                     # 停止線へ向かう車の進行方向
        left = np.array([v[1], -v[0]])    # 左側通行: 進行方向の左半分が接近車線
        half = Polygon([c + r * off - d * 40, c + r * off + d * 40,
                        c + r * off + d * 40 + left * 0.0 + v * 0.0, c + r * off - d * 40])
        # 接近側の半分 = 中心線から left 側
        side_poly = Polygon([c + r * off + left * 0.0 - v * 1, c + r * off + left * 30 - v * 1,
                             c + r * off + left * 30 + v * 1, c + r * off + left * 0.0 + v * 1])
        _g = strip(sl, 0.45).intersection(side_poly); g = _g.intersection(CARR.near(_g).buffer(-0.1))
        if g.area > 0.3:
            emit_poly(g, "w"); n_sl += 1
print("stop lines", n_sl, flush=True)

# ---------------- 車線境界線・中央線・外側線 ----------------
def lanes_num(t, k):
    try: return int(float(t.get(k)))
    except Exception: return None

def dashed(line, on=5.0, off=5.0):
    L = line.length; s = 0; out = []
    while s < L:
        seg = substring(line, s, min(L, s + on))
        if seg.length > 0.3: out.append(seg)
        s += on + off
    return out

def bright_line_ratio(pts, nv):
    """線の位置が両脇より明るい割合（航空写真で実在確認）"""
    ok = 0; tot = 0
    for p in pts:
        c = ortho_rgb(*p); a = ortho_rgb(*(p + nv * 1.2)); b = ortho_rgb(*(p - nv * 1.2))
        if c is None or a is None or b is None: continue
        tot += 1
        if c.mean() > max(a.mean(), b.mean()) + 12: ok += 1
    return ok / tot if tot else 0

def yellowish(pts):
    ys = []
    for p in pts:
        c = ortho_rgb(*p)
        if c is not None and c.mean() > 110: ys.append((c[0] + c[1]) / 2 - c[2])
    return len(ys) > 5 and np.median(ys) > 22

lane_lines_w, lane_lines_y = [], []
edge_cands = []
for w in road_ways:
    t = w["tags"]; hw = t["highway"]
    n = lanes_num(t, "lanes")
    oneway = t.get("oneway") in ("yes", "1", "-1")
    if n is None:
        if hw in MAJOR: n = 1 if oneway else 2
        else: continue
    ln = LineString(w["xy"])
    if not zl(ln) or ln.length < 8: continue
    nf = lanes_num(t, "lanes:forward"); nb = lanes_num(t, "lanes:backward")
    if not oneway:
        if nf is None and nb is None: nf = nb = max(1, n // 2) if n >= 2 else 0
        elif nf is None: nf = n - nb
        elif nb is None: nb = n - nf
    samples = []
    step = 2.0
    s = 1.0
    while s < ln.length - 1.0:
        p = ln.interpolate(s); a = ln.interpolate(max(0, s - 1)); b = ln.interpolate(min(ln.length, s + 1))
        tv = np.array([b.x - a.x, b.y - a.y]); tv /= np.linalg.norm(tv) + 1e-9
        nv = np.array([-tv[1], tv[0]])   # 進行方向の右 (x東 z南で (−tz, tx)... 左右は下で判定)
        q = np.array([p.x, p.y])
        if xing_p.contains(Point(q)) or cwa_p.contains(Point(q)):
            samples.append(None); s += step; continue
        _l = LineString([q - nv * 22, q + nv * 22]); cut = _l.intersection(CARR.near(_l))
        parts = list(cut.geoms) if hasattr(cut, "geoms") else ([cut] if not cut.is_empty else [])
        segs = []
        for g in parts:
            cc = np.array(g.coords)
            if len(cc) < 2: continue
            u0 = float(np.dot(cc[0] - q, nv)); u1 = float(np.dot(cc[-1] - q, nv))
            segs.append((min(u0, u1), max(u0, u1)))
        segs.sort()
        samples.append((q, tv, nv, segs))
        s += step
    # 方向別の車道幅を決めて線の横位置を得る
    polylines = {}   # key -> list of points (連続区間ごと)
    def push(key, pt):
        polylines.setdefault(key, [[]])
        polylines[key][-1].append(pt)
    def brk():
        for k in polylines:
            if polylines[k][-1]: polylines[k].append([])
    for smp in samples:
        if smp is None: brk(); continue
        q, tv, nv, segs = smp
        if not segs: brk(); continue
        # 中心線(u=0)を含む区間, もしくは左右の区間
        inside = [sg for sg in segs if sg[0] - 0.5 <= 0 <= sg[1] + 0.5]
        width_ok = True
        if oneway:
            if not inside: brk(); continue
            a_, b_ = inside[0]
            if b_ - a_ < 2.5: brk(); continue
            for k in range(1, n):
                push(("div", k), q + nv * (a_ + (b_ - a_) * k / n))
            push(("edgeL",), q + nv * (a_ + 0.3)); push(("edgeR",), q + nv * (b_ - 0.3))
        else:
            if inside and inside[0][1] - inside[0][0] > 4.5:
                a_, b_ = inside[0]
                # 中心線は OSM 線形上（u=0）とし、左右の車道幅は実測
                push(("center",), q)
                # 右側(+nv)と左側(-nv)
                for sign, cnt, lo, hi in ((1, nf, 0.0, b_), (-1, nb, 0.0, -a_)):
                    if cnt and cnt >= 2:
                        wd = hi - lo
                        for k in range(1, cnt):
                            push(("div", sign, k), q + nv * sign * (wd * k / cnt))
                push(("edgeL",), q + nv * (a_ + 0.3)); push(("edgeR",), q + nv * (b_ - 0.3))
            else:
                # 中央に軌道敷・分離帯がある: 左右それぞれの区間
                left = [sg for sg in segs if sg[1] <= 0.5]; right = [sg for sg in segs if sg[0] >= -0.5]
                for sign, grp, cnt in ((1, right, nf), (-1, left, nb)):
                    if not grp: continue
                    sg = grp[0] if sign > 0 else grp[-1]
                    a_, b_ = sg
                    if b_ - a_ < 2.5: continue
                    cnt = cnt or 1
                    for k in range(1, cnt):
                        push(("div", sign, k), q + nv * (a_ + (b_ - a_) * k / cnt))
                    push(("edgeIn", sign), q + nv * (a_ + 0.3 if sign > 0 else b_ - 0.3))
                    push(("edgeOut", sign), q + nv * (b_ - 0.3 if sign > 0 else a_ + 0.3))
    for key, runs in polylines.items():
        for run in runs:
            if len(run) < 3: continue
            pl = LineString(run)
            if pl.length < 4: continue
            _isb = t.get("bridge") not in (None, "no")
            if key[0] == "div":
                _dl = dashed(pl, 5.0, 5.0); lane_lines_w.extend(_dl)
                if _isb: BR_LINES.update(id(q) for q in _dl)
            elif key[0] == "center":
                pts = np.array(pl.coords)
                (lane_lines_y if yellowish(pts[::2]) else lane_lines_w).append(pl)
                if _isb: BR_LINES.add(id(pl))
            else:
                edge_cands.append(pl)
                if _isb: BR_LINES.add(id(pl))
print("lane dividers", len(lane_lines_w), "yellow center", len(lane_lines_y), "edge candidates", len(edge_cands), flush=True)

# 外側線・軌道敷境界: 航空写真で確認できた区間のみ（10m 窓で判定）
edge_ok = []
for pl in edge_cands:
    L = pl.length; s = 0
    while s < L:
        seg = substring(pl, s, min(L, s + 10))
        if seg.length > 2:
            cc = np.array(seg.coords)
            pts = np.array([seg.interpolate(f, normalized=True).coords[0] for f in np.linspace(0, 1, 8)])
            d = cc[-1] - cc[0]; d /= np.linalg.norm(d) + 1e-9; nv = np.array([-d[1], d[0]])
            # 線はずれるので ±0.5m の範囲で最も明るい位置を探す
            best = 0; best_o = 0
            for o in (-0.5, -0.25, 0, 0.25, 0.5):
                r = bright_line_ratio(pts + nv * o, nv)
                if r > best: best, best_o = r, o
            if best >= 0.5:
                edge_ok.append(shapely.affinity.translate(seg, *(nv * best_o)))
                if id(pl) in BR_LINES: BR_LINES.add(id(edge_ok[-1]))
        s += 10
print("edge lines confirmed by ortho", len(edge_ok), "of", sum(int(math.ceil(p.length / 10)) for p in edge_cands), flush=True)

def lines_to_strips(lines, width, color):
    for l in lines:
        CUR_UP[0] = id(l) in BR_LINES
        g = strip(l, width); g = g.intersection(CARR.near(g).buffer(-0.05))
        g = g.difference(CWA.near(g)).difference(XING.near(g).buffer(0.5))
        if not g.is_empty: emit_poly(g, color)
lines_to_strips(lane_lines_w, 0.15, "w")
lines_to_strips(lane_lines_y, 0.15, "y")
lines_to_strips(edge_ok, 0.15, "w")
CUR_UP[0] = False

out = dict(white=np.concatenate(WHITE) if WHITE else np.zeros((0, 3)),
           yellow=np.concatenate(YELLOW) if YELLOW else np.zeros((0, 3)))
pickle.dump(out, open("/home/claude/wx/markings_ext.pkl" if MARK_EXT else "/home/claude/wx/markings.pkl", "wb"))
print({k: len(v) // 3 for k, v in out.items()})
