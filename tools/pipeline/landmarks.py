"""v17: ランドマークの作り込み（build_v5 から呼ぶ）
 1) 岡山城の石垣: OSM の barrier=retaining_wall（烏城公園の中）。DEM（4m）は石垣の段差を 10〜16m に渡って
    なだらかにしているので、壁の低い側 8m 以内の地面を下の高さへ、高い側 3〜10m を上の高さへそろえ、
    その境に反りのある石垣の面（下端は地中）と、上面の縁（航空写真の帯）を置く。
 2) 金鯱: 天守の最上部の大棟の両端（PLATEAU の天守の屋根から探す）。
 3) 後楽園の建物: PLATEAU では箱（LOD1）→ 同じ平面形で「和風の建物」（柱・腰板・障子の外壁、深い軒の寄棟の瓦屋根）に作り直す。
    屋根は平面形の外周からの距離で高さを決める（凸な平面では寄棟そのもの、L 字などでも破綻しない）。
 4) 後楽園の外周の土塀（OSM barrier=wall）: 白壁・瓦の笠。
"""
import json, math, pickle, glob
import numpy as np
from shapely.geometry import Polygon, LineString, Point, MultiPolygon
from shapely.ops import unary_union
from shapely.prepared import prep
from scipy.spatial import Delaunay
from scipy.ndimage import median_filter
from common import proj

LM = json.load(open("/home/claude/wx/osm/landmark.json"))
_WAYS = {e["id"]: e for e in LM["elements"] if e["type"] == "way"}
def _poly(i): return Polygon([proj(g["lat"], g["lon"]) for g in _WAYS[i]["geometry"]]).buffer(0)
KORAKUEN = _poly(82602383)       # 後楽園（leisure=park）
UJO = _poly(96200691)            # 烏城公園（岡山城）
TENSHU = _poly(363563168)        # 天守の平面（OSM）
MUSEUM = _poly(388229814)

class DemRef:
    def __init__(self, DH, x0, z0, step): self.DH, self.x0, self.z0, self.step = DH, x0, z0, step
    def at(self, x, z):
        DH = self.DH; fx = (np.asarray(x, float) - self.x0) / self.step; fz = (np.asarray(z, float) - self.z0) / self.step
        i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
        tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
        return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz

def _resample(xy, step):
    L = LineString(xy); n = max(2, int(math.ceil(L.length / step)) + 1)
    return np.array([L.interpolate(t, normalized=True).coords[0] for t in np.linspace(0, 1, n)])

# ================= 1) 石垣 =================
def castle_walls(ways, dem):
    """dem.DH を書き換え（段差をくっきり）、石垣の面・上面の帯の三角形を返す"""
    ujo = prep(UJO.buffer(20))
    walls = [w for w in ways if w["tags"].get("barrier") == "retaining_wall" and len(w["xy"]) >= 2
             and ujo.intersects(LineString(w["xy"])) and LineString(w["xy"]).length > 6]
    face_pos, face_uv, cap_pos, info = [], [], [], []
    DH0 = dem.DH.copy()
    ref = DemRef(DH0, dem.x0, dem.z0, dem.step)
    edits = []   # (polygon, value, mode)
    for w in walls:
        P = _resample(w["xy"], 2.0)
        if len(P) < 2: continue
        T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1)[:, None] + 1e-9
        Nn = np.stack([T[:, 1], -T[:, 0]], 1)          # 進行方向の右
        dd = np.arange(6, 15, 1.0)
        R_ = np.stack([ref.at(P[:, 0] + Nn[:, 0] * d, P[:, 1] + Nn[:, 1] * d) for d in dd], 1)
        L_ = np.stack([ref.at(P[:, 0] - Nn[:, 0] * d, P[:, 1] - Nn[:, 1] * d) for d in dd], 1)
        # 高い側は点ごとに決める（閉じた輪の石垣では、途中で内外が入れ替わる）
        df = median_filter(R_.mean(1) - L_.mean(1), size=7, mode="nearest")
        side = np.where(df >= 0, 1.0, -1.0)
        n = Nn * side[:, None]                              # 高い側
        hi = np.where(side > 0, R_.max(1), L_.max(1))
        lo = np.where(side > 0, L_.min(1), R_.min(1))
        hi = median_filter(hi, size=5, mode="nearest"); lo = median_filter(lo, size=5, mode="nearest")
        ok = (hi - lo >= 1.3)
        segok = ok[:-1] & ok[1:] & (side[:-1] == side[1:])
        if segok.sum() < 2: continue
        info.append((w["id"], round(float(np.median((hi - lo)[ok])), 1), int(segok.sum()) * 2))
        for k in range(len(P) - 1):
            if not segok[k]: continue
            a, b = P[k], P[k + 1]; na, nb = n[k], n[k + 1]
            q_lo = Polygon([a - na * 9, b - nb * 9, b + nb * 3.0, a + na * 3.0])
            q_hi = Polygon([a + na * 3.0, b + nb * 3.0, b + nb * 10, a + na * 10])
            edits.append((q_lo, min(lo[k], lo[k + 1]), "min"))
            edits.append((q_hi, max(hi[k], hi[k + 1]), "max"))
        # 石垣の面: 下端 s=-1.8（地中 0.8m）→ 中ほど（反り）→ 上端 s=+1.0
        s_rows = [(-1.8, -0.8), (-1.0, 0.18), (-0.3, 0.55), (0.35, 0.82), (1.0, 1.0)]
        cum = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        rows = []
        for s, f in s_rows:
            y = lo - 0.8 + (hi - lo + 0.8) * f if f >= 0 else lo - 0.8 + 0 * hi
            xz = P + n * s
            rows.append(np.stack([xz[:, 0], y, xz[:, 1]], 1))
        # 面の v は斜面に沿った長さ
        vs = [np.zeros(len(P))]
        for r0, r1 in zip(rows[:-1], rows[1:]): vs.append(vs[-1] + np.linalg.norm(r1 - r0, axis=1))
        for r in range(len(rows) - 1):
            A, B = rows[r], rows[r + 1]
            for k in range(len(P) - 1):
                if not segok[k]: continue
                a0, a1, b0, b1 = A[k], A[k + 1], B[k], B[k + 1]
                u0, u1 = cum[k] / 2.4, cum[k + 1] / 2.4
                va0, va1, vb0, vb1 = vs[r][k] / 2.4, vs[r][k + 1] / 2.4, vs[r + 1][k] / 2.4, vs[r + 1][k + 1] / 2.4
                # 外向き（低い側）が表になる向き
                tri1 = [a0, b0, a1]; tri2 = [a1, b0, b1]
                uv1 = [(u0, va0), (u0, vb0), (u1, va1)]; uv2 = [(u1, va1), (u0, vb0), (u1, vb1)]
                nrm = np.cross(np.array(b0) - a0, np.array(a1) - a0)
                if (nrm[0] * -n[k][0] + nrm[2] * -n[k][1]) < 0:
                    tri1 = [a0, a1, b0]; tri2 = [a1, b1, b0]; uv1 = [uv1[0], uv1[2], uv1[1]]; uv2 = [uv2[0], uv2[2], uv2[1]]
                face_pos += tri1 + tri2; face_uv += uv1 + uv2
        # 上面の帯（s=+1.0〜+10、高さ hi）: 航空写真で塗る
        for k in range(len(P) - 1):
            if not segok[k]: continue
            a, b = P[k], P[k + 1]; na, nb = n[k], n[k + 1]
            A0 = [a[0] + na[0] * 1.0, hi[k] + 0.04, a[1] + na[1] * 1.0]; B0 = [b[0] + nb[0] * 1.0, hi[k + 1] + 0.04, b[1] + nb[1] * 1.0]
            A1 = [a[0] + na[0] * 10, hi[k] + 0.04, a[1] + na[1] * 10]; B1 = [b[0] + nb[0] * 10, hi[k + 1] + 0.04, b[1] + nb[1] * 10]
            t = [A0, A1, B0, B0, A1, B1]
            nrm = np.cross(np.array(A1) - A0, np.array(B0) - A0)
            if nrm[1] < 0: t = [A0, B0, A1, B0, B1, A1]
            cap_pos += t
    # 地面の書き換え（格子点ごと）: 低い側は min、高い側は max。低い側を先に
    DH = dem.DH
    for mode in ("min", "max"):
        for q, v, m in edits:
            if m != mode: continue
            x0, z0, x1, z1 = q.bounds
            i0 = max(0, int(math.floor((x0 - dem.x0) / dem.step))); i1 = min(DH.shape[1] - 1, int(math.ceil((x1 - dem.x0) / dem.step)))
            j0 = max(0, int(math.floor((z0 - dem.z0) / dem.step))); j1 = min(DH.shape[0] - 1, int(math.ceil((z1 - dem.z0) / dem.step)))
            pq = prep(q)
            for j in range(j0, j1 + 1):
                for i in range(i0, i1 + 1):
                    x = dem.x0 + i * dem.step; z = dem.z0 + j * dem.step
                    if pq.contains(Point(x, z)):
                        DH[j, i] = min(DH[j, i], v) if mode == "min" else max(DH[j, i], v)
    print("  castle walls", len(info), info[:12], flush=True)
    return np.array(face_pos, float).reshape(-1, 3), np.array(face_uv, float).reshape(-1, 2), np.array(cap_pos, float).reshape(-1, 3)

# ================= 2) 金鯱 =================
def _ellipsoid(c, r, n=8, m=6):
    out = []
    for i in range(m):
        t0, t1 = math.pi * i / m, math.pi * (i + 1) / m
        for j in range(n):
            p0, p1 = 2 * math.pi * j / n, 2 * math.pi * (j + 1) / n
            def P(t, p): return [c[0] + r[0] * math.sin(t) * math.cos(p), c[1] + r[1] * math.cos(t), c[2] + r[2] * math.sin(t) * math.sin(p)]
            a, b, cc, d = P(t0, p0), P(t1, p0), P(t1, p1), P(t0, p1)
            out += [a, b, cc, a, cc, d]
    return out
def shachi(tex_tris):
    """天守（PLATEAU の写真テクスチャの三角形のうち OSM の天守の平面内）の最上部の大棟の両端に金鯱"""
    tp = prep(TENSHU.buffer(3))
    T = [t for t in tex_tris if tp.contains(Point(t[:, 0].mean(), t[:, 2].mean()))]
    if not T: return np.zeros((0, 3))
    V = np.concatenate(T); top = V[:, 1].max()
    R = V[V[:, 1] > top - 0.35]
    # 大棟の向き: 最上部の点群の主軸
    c = R[:, [0, 2]].mean(0); U, S_, Vt = np.linalg.svd(R[:, [0, 2]] - c); ax = Vt[0]
    s = (R[:, [0, 2]] - c) @ ax
    out = []
    for e in (s.min(), s.max()):
        p = c + ax * e; sg = 1 if e > 0 else -1
        y0 = top
        # 胴（反り上がった魚。頭を内側、尾を上に）
        out += _ellipsoid((p[0], y0 + 0.75, p[1]), (0.34, 0.8, 0.34))
        out += _ellipsoid((p[0] - ax[0] * sg * 0.25, y0 + 0.35, p[1] - ax[1] * sg * 0.25), (0.42, 0.36, 0.4))
        # 尾びれ（上で外へ開く）
        tip = (p[0] + ax[0] * sg * 0.45, y0 + 1.95, p[1] + ax[1] * sg * 0.45)
        b0 = (p[0], y0 + 1.35, p[1])
        side = np.array([-ax[1], ax[0]]) * 0.32
        out += [[b0[0] + side[0], b0[1], b0[2] + side[1]], [b0[0] - side[0], b0[1], b0[2] - side[1]], list(tip)]
        out += [[b0[0] - side[0], b0[1], b0[2] - side[1]], [b0[0] + side[0], b0[1], b0[2] + side[1]], list(tip)]
    print("  shachi at top", round(float(top), 1), "ridge", np.round(c + ax * s.min(), 1), np.round(c + ax * s.max(), 1), flush=True)
    return np.array(out, float)

# ================= 3) 後楽園の建物 =================
def _hip_roof(E, y_eave, slope=0.6, rmax=4.2, grid=0.6):
    """平面 E（軒の出を含む）の上に、外周からの距離×勾配の屋根。三角形と各頂点の外周からの距離"""
    E = E.buffer(0)
    if E.area < 1: return None
    bpts = []
    for ring in ([E.exterior] + list(E.interiors)):
        L = ring.length; n = max(8, int(L / (grid * 0.8)))
        bpts += [ring.interpolate(t, normalized=True).coords[0] for t in np.linspace(0, 1, n, endpoint=False)]
    x0, z0, x1, z1 = E.bounds
    gx, gz = np.meshgrid(np.arange(x0, x1, grid), np.arange(z0, z1, grid))
    inner = prep(E.buffer(-grid * 0.3))
    ipts = [(x, z) for x, z in zip(gx.ravel(), gz.ravel()) if inner.contains(Point(x, z))]
    pts = np.array(bpts + ipts)
    if len(pts) < 4: return None
    tri = Delaunay(pts)
    pe = prep(E)
    keep = [s for s in tri.simplices if pe.contains(Point(pts[s].mean(0)))]
    bnd = E.boundary
    d = np.array([bnd.distance(Point(p)) for p in pts]); d[:len(bpts)] = 0
    top = min(rmax, slope * d.max())
    y = y_eave + np.minimum(slope * d, top)
    V = np.stack([pts[:, 0], y, pts[:, 1]], 1)
    out, dist = [], []
    for s in keep:
        a, b, c = V[s]
        nrm = np.cross(b - a, c - a)
        if nrm[1] < 0: s = s[[0, 2, 1]]
        out += list(V[s]); dist += list(d[s])
    return np.array(out), np.array(dist)

def _walls(g, y0, y1):
    """平面 g の外周の壁。uv は u=外周に沿った長さ/1.82m（1 間）、v=高さの割合"""
    pos, uv = [], []
    for ring in [g.exterior]:
        c = np.array(ring.coords)
        if not ring.is_ccw: c = c[::-1]   # 外向きの面にする（shapely の x-z 平面で反時計回り）
        s = 0.0
        for a, b in zip(c[:-1], c[1:]):
            L = float(np.linalg.norm(b - a))
            if L < 0.05: continue
            u0, u1 = s / 1.82, (s + L) / 1.82
            A0 = [a[0], y0, a[1]]; B0 = [b[0], y0, b[1]]; A1 = [a[0], y1, a[1]]; B1 = [b[0], y1, b[1]]
            pos += [A0, A1, B0, B0, A1, B1]; uv += [(u0, 0), (u0, 1), (u1, 0), (u1, 0), (u0, 1), (u1, 1)]
            s += L
    return pos, uv

def garden_buildings(dem):
    """PLATEAU の後楽園内の建物（箱）を和風の建物にする。/home/claude/wx/lm_fp_kora.pkl（平面・下端・上端）を使う"""
    fps = pickle.load(open("/home/claude/wx/lm_fp_kora.pkl", "rb"))
    wall_pos, wall_uv, roof_pos, roof_uv, roof_col, trim_pos = [], [], [], [], [], []
    rng = np.random.default_rng(17)
    n = 0
    for g, ymin, ymax in fps:
        if g.area < 4.0: continue
        g = g.buffer(0.3, join_style=2).buffer(-0.3, join_style=2).simplify(0.35)
        if g.is_empty: continue
        if isinstance(g, MultiPolygon): g = max(g.geoms, key=lambda q: q.area)
        base = float(dem.at(*np.array(g.representative_point().coords[0])))
        base = min(base, ymin) if abs(base - ymin) < 2.5 else base
        H = ymax - ymin
        eave = base + float(np.clip(H * 0.5, 2.5, 3.6)) if H < 7.5 else base + 5.2
        ww, wu = _walls(g, base - 0.3, eave)
        wall_pos += ww; wall_uv += wu
        E = g.buffer(0.95 if g.area > 30 else 0.7, join_style=2, mitre_limit=2.0)
        r = _hip_roof(E, eave - 0.1, slope=0.62 if g.area > 30 else 0.7, rmax=4.5)
        if r is None: continue
        rp, rd = r
        roof_pos += list(rp)
        # 瓦の段: v = 外周からの距離 / 0.3m、u = 世界 x（模様は u 方向に一様）
        roof_uv += [(p[0] * 0.2, dd / 0.3) for p, dd in zip(rp, rd)]
        tone = rng.uniform(0.92, 1.06)
        roof_col += [np.array([0.36, 0.37, 0.39]) * tone] * len(rp)
        # 鼻隠し（軒先の厚み）
        ring = np.array(E.exterior.coords)
        for a, b in zip(ring[:-1], ring[1:]):
            A0 = [a[0], eave - 0.4, a[1]]; B0 = [b[0], eave - 0.4, b[1]]; A1 = [a[0], eave - 0.08, a[1]]; B1 = [b[0], eave - 0.08, b[1]]
            trim_pos += [A0, A1, B0, B0, A1, B1, A0, B0, A1, B0, B1, A1]
        n += 1
    print("  garden buildings", n, "roof tris", len(roof_pos) // 3, flush=True)
    return (np.array(wall_pos, float).reshape(-1, 3), np.array(wall_uv, float).reshape(-1, 2),
            np.array(roof_pos, float).reshape(-1, 3), np.array(roof_uv, float).reshape(-1, 2), np.array(roof_col, float).reshape(-1, 3),
            np.array(trim_pos, float).reshape(-1, 3))

def garden_remove_mask():
    """後楽園の中の PLATEAU の建物を除く判定（博物館は後楽園の外）"""
    kp = prep(KORAKUEN.buffer(-0.5))
    def f(t):
        c = t.mean(1)
        if c[:, 0].max() < 1240 or c[:, 0].min() > 1780 or c[:, 2].max() < -440 or c[:, 2].min() > 260: return np.zeros(len(t), bool)
        return np.array([kp.contains(Point(q[0], q[2])) for q in c])
    return f

# ================= 4) 土塀 =================
def garden_walls(ways, dem):
    kb = prep(KORAKUEN.buffer(25))
    pos, col = [], []
    WHITE, BASE, TILE = np.array([0.9, 0.89, 0.85]), np.array([0.42, 0.4, 0.37]), np.array([0.3, 0.31, 0.33])
    n = 0
    for w in ways:
        if w["tags"].get("barrier") != "wall" or len(w["xy"]) < 2: continue
        L = LineString(w["xy"])
        if not kb.intersects(L) or L.length < 3: continue
        P = _resample(w["xy"], 2.0)
        y = dem.at(P[:, 0], P[:, 1])
        T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1)[:, None] + 1e-9
        N = np.stack([T[:, 1], -T[:, 0]], 1)
        def quad(a, b, c, d, cl): pos.extend([a, b, c, a, c, d]); col.extend([cl] * 6)
        for k in range(len(P) - 1):
            for sg in (1, -1):
                na, nb = N[k] * 0.22 * sg, N[k + 1] * 0.22 * sg
                pa, pb = P[k] + na, P[k + 1] + nb
                # 腰（石）・白壁
                for y0, y1, cl in ((-0.3, 0.45, BASE), (0.45, 2.0, WHITE)):
                    a = [pa[0], y[k] + y0, pa[1]]; b = [pb[0], y[k + 1] + y0, pb[1]]; c = [pb[0], y[k + 1] + y1, pb[1]]; d = [pa[0], y[k] + y1, pa[1]]
                    quad(a, b, c, d, cl) if sg > 0 else quad(b, a, d, c, cl)
                # 笠（瓦）: 外へ 0.35m 張り出して棟へ
                qa, qb = P[k] + N[k] * 0.55 * sg, P[k + 1] + N[k + 1] * 0.55 * sg
                a = [qa[0], y[k] + 1.95, qa[1]]; b = [qb[0], y[k + 1] + 1.95, qb[1]]
                c = [P[k + 1][0], y[k + 1] + 2.35, P[k + 1][1]]; d = [P[k][0], y[k] + 2.35, P[k][1]]
                quad(a, d, c, b, TILE) if sg > 0 else quad(b, c, d, a, TILE)
        n += 1
    print("  garden walls", n, flush=True)
    return np.array(pos, float).reshape(-1, 3), np.array(col, float).reshape(-1, 3)
