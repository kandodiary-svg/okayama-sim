"""v32: 地形の高低差のある所の構造物（build_v5.py から使う）
  ・road_skirts: 道路の縁が地面より高い所（盛土・土手・斜面の谷側）に、縁から地面までの壁（擁壁・法面）
  ・bridge_structures: 橋・高架（PLATEAU の橋梁・高架橋の区間）の床版の下面・側面・高欄・橋脚
  ・building_plinths: 建物の壁の下端が地面より高い所に、地面までの基礎
どれも「足すだけ」（道路面・建物・地面の形は変えない）"""
import math
import numpy as np
import shapely
from shapely.geometry import Polygon, LineString, Point, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.strtree import STRtree


def grid_split(poly, cell=4.0):
    """多角形を cell の格子で切る（build_v5.grid_split と同じ）"""
    x0, z0, x1, z1 = poly.bounds
    xs = np.arange(np.floor(x0 / cell) * cell, x1 + cell, cell); zs = np.arange(np.floor(z0 / cell) * cell, z1 + cell, cell)
    boxes = shapely.box(*np.meshgrid(xs[:-1], zs[:-1]), *np.meshgrid(xs[1:], zs[1:])).ravel()
    boxes = boxes[shapely.intersects(boxes, poly)]
    parts = shapely.intersection(boxes, poly)
    return [g for g in parts if not g.is_empty and g.area > 1e-4]


class Ground:
    """画面に出る地面の高さ（app.js buildGroundOV と同じ: H/100 − 0.12 − 水面なら 0.25、4m の升目を 2 つの三角形に分ける分け方も同じ）"""
    def __init__(self, Hc, W, x0, z0, step):
        self.G = Hc.astype(np.float64) / 100 - 0.12 - np.where(W > 0, 0.25, 0.0)
        self.x0, self.z0, self.s = float(x0), float(z0), float(step)
    def __call__(self, x, z):
        x = np.asarray(x, np.float64); z = np.asarray(z, np.float64); G = self.G
        fi = (x - self.x0) / self.s; fj = (z - self.z0) / self.s
        i0 = np.clip(np.floor(fi).astype(int), 0, G.shape[1] - 2); j0 = np.clip(np.floor(fj).astype(int), 0, G.shape[0] - 2)
        tx = np.clip(fi - i0, 0, 1); tz = np.clip(fj - j0, 0, 1); up = tx + tz <= 1
        a = G[j0, i0]; b = G[j0, i0 + 1]; c = G[j0 + 1, i0]; d = G[j0 + 1, i0 + 1]
        return np.where(up, a + (b - a) * tx + (c - a) * tz, d + (c - d) * (1 - tx) + (b - d) * (1 - tz))


class Deck:
    """道路面の高さ（0.5m の格子 HR と、橋が道路の上を通る所の「上の段」UP）"""
    def __init__(self, HR, grid, upper):
        self.HR = HR; self.GX0, self.GZ0, self.RES = grid
        ui, uv, uk = upper if upper is not None else (np.zeros(0, np.int64), np.zeros(0, np.float32), np.zeros(0, np.uint8))
        o = np.argsort(ui); self.ui = np.asarray(ui)[o]; self.uv = np.asarray(uv)[o]
    def cells(self, x, z):
        i = np.clip(((np.asarray(x) - self.GX0) / self.RES).astype(np.int64), 0, self.HR.shape[1] - 1)
        j = np.clip(((np.asarray(z) - self.GZ0) / self.RES).astype(np.int64), 0, self.HR.shape[0] - 1)
        return j, i
    def lower(self, x, z):
        j, i = self.cells(x, z); return np.asarray(self.HR[j, i], np.float64)
    def upper_h(self, x, z):
        """上の段の高さ（無ければ nan）"""
        j, i = self.cells(x, z); k = j * self.HR.shape[1] + i
        h = np.full(np.shape(k), np.nan)
        if len(self.ui):
            p = np.clip(np.searchsorted(self.ui, k), 0, len(self.ui) - 1); hit = self.ui[p] == k
            h = np.where(hit, self.uv[p], np.nan)
        return h
    def deck_fn(self, g):
        """橋の面 g（1 つの区間）の床版の高さを、近い 4 升の平均で返す関数（面の縁・升目の無い点でも値が出る）。
        v33: 升目ごとに「下の段 HR」「上の段 UP」のうち、面の中の高さの中央値に近い方を使い、中央値から離れた升（別の段の橋・下の道路）は使わない
        （橋の上に橋が重なる所で、下の橋の縁に上の橋の高さが入って三角の突起になっていた）"""
        from scipy.spatial import cKDTree
        from scipy.ndimage import maximum_filter
        x0, z0, x1, z1 = g.bounds
        i0 = max(0, int((x0 - 1 - self.GX0) / self.RES)); i1 = min(self.HR.shape[1], int((x1 + 1 - self.GX0) / self.RES) + 1)
        j0 = max(0, int((z0 - 1 - self.GZ0) / self.RES)); j1 = min(self.HR.shape[0], int((z1 + 1 - self.GZ0) / self.RES) + 1)
        if i1 <= i0 or j1 <= j0: return None
        jj, ii = np.mgrid[j0:j1, i0:i1]; jj = jj.ravel(); ii = ii.ravel()
        cx = self.GX0 + (ii + 0.5) * self.RES; cz = self.GZ0 + (jj + 0.5) * self.RES
        inside = shapely.contains_xy(g.buffer(0.3), cx, cz)
        if not inside.any(): return None
        jj, ii, cx, cz = jj[inside], ii[inside], cx[inside], cz[inside]
        hL = np.asarray(self.HR[jj, ii], np.float64); hU = self.upper_h(cx, cz)
        fu = np.isfinite(hU)
        base = np.where(fu, hU, hL) if fu.sum() > 0.5 * len(cx) else hL
        base = base[np.isfinite(base)]
        if len(base) < 3: return None
        ref = float(np.median(base)); tol = float(min(6.0, max(1.2, 0.07 * max(x1 - x0, z1 - z0))))
        cL = np.where(np.isfinite(hL), np.abs(hL - ref), np.inf); cU = np.where(fu, np.abs(hU - ref), np.inf)
        h = np.where(cU < cL, hU, hL); dev = np.minimum(cL, cU)
        ok = np.isfinite(h) & (dev <= tol)
        if ok.sum() < 3: return None
        # 近くの最大より 1m 以上低い升目は使わない
        Hm = np.full((j1 - j0, i1 - i0), -np.inf, np.float32)
        jc = jj[ok] - j0; ic = ii[ok] - i0; hh = h[ok]
        Hm[jc, ic] = hh
        mx = maximum_filter(Hm, size=13, mode="nearest")
        keep = hh >= mx[jc, ic] - 1.0
        if keep.sum() < 3: keep = np.ones(len(hh), bool)
        kd = cKDTree(np.stack([cx[ok][keep], cz[ok][keep]], 1)); hv = hh[keep]
        def f(x, z):
            x = np.atleast_1d(np.asarray(x, np.float64)); z = np.atleast_1d(np.asarray(z, np.float64))
            d, i = kd.query(np.stack([x, z], 1), k=min(4, len(hv))); return hv[i].reshape(len(x), -1).mean(1)
        return f
    def upper(self, x, z):
        """上の段があればその高さ、無ければ HR（橋の上の点に使う）"""
        j, i = self.cells(x, z); k = j * self.HR.shape[1] + i
        h = np.asarray(self.HR[j, i], np.float64)
        if len(self.ui):
            p = np.clip(np.searchsorted(self.ui, k), 0, len(self.ui) - 1); hit = self.ui[p] == k
            h = np.where(hit, self.uv[p], h)
        return h


def _quads(A, B, ta, tb, ba, bb, outward):
    """A,B: (n,2) 上端の水平位置。ta,tb: 上端の高さ、ba,bb: 下端の高さ。outward: (n,2) 面の向き（外）。→ 三角形 (n*6,3)"""
    n = len(A)
    At = np.stack([A[:, 0], ta, A[:, 1]], 1); Bt = np.stack([B[:, 0], tb, B[:, 1]], 1)
    Ab = np.stack([A[:, 0], ba, A[:, 1]], 1); Bb = np.stack([B[:, 0], bb, B[:, 1]], 1)
    T1 = np.stack([At, Ab, Bb], 1); T2 = np.stack([At, Bb, Bt], 1)
    nrm = np.cross(T1[:, 1] - T1[:, 0], T1[:, 2] - T1[:, 0])
    flip = (nrm[:, 0] * outward[:, 0] + nrm[:, 2] * outward[:, 1]) < 0
    T1[flip] = T1[flip][:, [0, 2, 1]]; T2[flip] = T2[flip][:, [0, 2, 1]]
    return np.concatenate([T1, T2], 1).reshape(-1, 3)


def _ring_segments(g, step=2.0):
    """多角形の輪郭を step 以下の区間に（多角形の内側が左）。戻り値: A, B (n,2)"""
    g = orient(g, 1.0); out = []
    for ring in [g.exterior] + list(g.interiors):
        c = np.asarray(shapely.segmentize(ring, step).coords)
        if len(c) >= 2: out.append((c[:-1], c[1:]))
    if not out: return np.zeros((0, 2)), np.zeros((0, 2))
    return np.concatenate([a for a, b in out]), np.concatenate([b for a, b in out])


def road_skirts(parts_index, tiles, bridge_union, deck, ground, min_gap=0.35, log=print):
    """道路（橋以外）の外周で、道路の縁が地面より min_gap 以上高い所に、縁から地面までの面。
    高さ 1.5m までは 1:1 の土の法面（外へ下がる斜面・土の色）、それより高い所は垂直の擁壁（コンクリートの色）。戻り値: 三角形, 色"""
    out = []; cols = []; n_seg = 0
    bprep = bridge_union if bridge_union is not None else None
    EARTH = np.array([0.47, 0.46, 0.37]); CONC = np.array([0.60, 0.59, 0.55])
    for (x0, z0, x1, z1) in tiles:
        loc = parts_index.near(box(x0 - 30, z0 - 30, x1 + 30, z1 + 30))
        if loc.is_empty: continue
        for g in (loc.geoms if hasattr(loc, "geoms") else [loc]):
            if g.geom_type != "Polygon" or g.is_empty: continue
            A, B = _ring_segments(g, 4.0)
            if not len(A): continue
            M = (A + B) / 2
            own = (M[:, 0] >= x0) & (M[:, 0] < x1) & (M[:, 1] >= z0) & (M[:, 1] < z1)
            if not own.any(): continue
            A = A[own]; B = B[own]; M = M[own]
            d = B - A; L = np.hypot(d[:, 0], d[:, 1]); ok = L > 0.05
            A, B, M, d, L = A[ok], B[ok], M[ok], d[ok], L[ok]
            nl = np.stack([-d[:, 1], d[:, 0]], 1) / L[:, None]   # 左 = 道路の内側
            if bprep is not None:
                pout = M - nl * 0.6
                nb = ~shapely.intersects_xy(bprep, pout[:, 0], pout[:, 1]) & ~shapely.intersects_xy(bprep, M[:, 0], M[:, 1])
                A, B, M, nl = A[nb], B[nb], M[nb], nl[nb]
            if not len(A): continue
            ai = A + nl * 0.3; bi = B + nl * 0.3
            ta = deck.lower(ai[:, 0], ai[:, 1]); tb = deck.lower(bi[:, 0], bi[:, 1])
            ga = ground(A[:, 0], A[:, 1]); gb = ground(B[:, 0], B[:, 1])
            fin = np.isfinite(ta) & np.isfinite(tb)
            gap = np.maximum(ta - ga, tb - gb)
            need = fin & (gap > min_gap)
            if not need.any(): continue
            A, B, ta, tb, ga, gb, nl, gap = A[need], B[need], ta[need], tb[need], ga[need], gb[need], nl[need], gap[need]
            slope = gap <= 1.5
            off = np.where(slope, np.clip(gap, 0, 1.5), 0.0)[:, None]
            Ao = A - nl * off; Bo = B - nl * off
            ba = np.minimum(ground(Ao[:, 0], Ao[:, 1]), ta - 0.05) - 0.15; bb = np.minimum(ground(Bo[:, 0], Bo[:, 1]), tb - 0.05) - 0.15
            # 斜面は上端（道路の縁）と下端（外）で位置が違う四角形
            At = np.stack([A[:, 0], ta - 0.02, A[:, 1]], 1); Bt = np.stack([B[:, 0], tb - 0.02, B[:, 1]], 1)
            Ab = np.stack([Ao[:, 0], ba, Ao[:, 1]], 1); Bb = np.stack([Bo[:, 0], bb, Bo[:, 1]], 1)
            T1 = np.stack([At, Ab, Bb], 1); T2 = np.stack([At, Bb, Bt], 1)
            nrm = np.cross(T1[:, 1] - T1[:, 0], T1[:, 2] - T1[:, 0])
            flip = (nrm[:, 0] * -nl[:, 0] + nrm[:, 2] * -nl[:, 1]) < 0
            T1[flip] = T1[flip][:, [0, 2, 1]]; T2[flip] = T2[flip][:, [0, 2, 1]]
            out.append(np.concatenate([T1, T2], 1).reshape(-1, 3))
            c = np.where(slope[:, None], EARTH, CONC); cols.append(np.repeat(c, 6, 0))
            n_seg += len(A)
    log("  road skirts: segments", n_seg)
    if not out: return np.zeros((0, 3)), np.zeros((0, 3))
    a = np.concatenate(out).reshape(-1, 3, 3); c = np.concatenate(cols).reshape(-1, 3, 3)
    ok = np.isfinite(a).all(axis=(1, 2))
    return a[ok].reshape(-1, 3), c[ok].reshape(-1, 3)



def _smooth_reach(A, B, Da, Db, k=7):
    """法面の外縁の距離を、つながった外周に沿って「近く k 個の最大 → 平均」でならす（元の距離以上を保つので地形は面の下に隠れたまま。地形の 4m 格子のギザギザを写さない）"""
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    n = len(A)
    if n < 2: return Da, Db
    brk = np.r_[True, np.hypot(A[1:, 0] - B[:-1, 0], A[1:, 1] - B[:-1, 1]) > 0.05]
    st = np.flatnonzero(brk); en = np.r_[st[1:], n]
    Da = Da.copy(); Db = Db.copy()
    for s, e in zip(st, en):
        if e - s < 2: continue
        V = np.r_[Da[s], np.maximum(Db[s:e - 1], Da[s + 1:e]), Db[e - 1]]
        Vs = uniform_filter1d(maximum_filter1d(V, k, mode="nearest"), k, mode="nearest")
        Da[s:e] = Vs[:-1]; Db[s:e] = Vs[1:]
    return Da, Db

def cut_faces(parts_index, tiles, bridge_union, deck, ground_orig, S=1.0, min_h=0.3, maxd=12.0, log=print):
    """切土の法面: 道路（橋以外）の外周で、外の地形（下げる前）が道路の縁より高い所に、縁から勾配 S で上がって地形に当たるまでの面。
    地面の格子はこの面より下に下げてある（build_v5 の cut-slope cap）ので、4m 格子のギザギザは面の下に隠れる。戻り値: 三角形, 色"""
    out = []; cols = []; n_seg = 0
    DS = np.arange(0.25, maxd + 0.01, 0.5)
    GR1 = np.array([0.40, 0.45, 0.31]); GR2 = np.array([0.50, 0.49, 0.40])
    for (x0, z0, x1, z1) in tiles:
        loc = parts_index.near(box(x0 - 30, z0 - 30, x1 + 30, z1 + 30))
        if loc.is_empty: continue
        for g in (loc.geoms if hasattr(loc, "geoms") else [loc]):
            if g.geom_type != "Polygon" or g.is_empty: continue
            A, B = _ring_segments(g, 3.0)
            if not len(A): continue
            M = (A + B) / 2
            own = (M[:, 0] >= x0) & (M[:, 0] < x1) & (M[:, 1] >= z0) & (M[:, 1] < z1)
            if not own.any(): continue
            A = A[own]; B = B[own]; M = M[own]
            d = B - A; L = np.hypot(d[:, 0], d[:, 1]); ok = L > 0.05
            A, B, M, d, L = A[ok], B[ok], M[ok], d[ok], L[ok]
            nl = np.stack([-d[:, 1], d[:, 0]], 1) / L[:, None]
            if bridge_union is not None:
                pout = M - nl * 0.6
                nb = ~shapely.intersects_xy(bridge_union, pout[:, 0], pout[:, 1]) & ~shapely.intersects_xy(bridge_union, M[:, 0], M[:, 1])
                A, B, M, nl = A[nb], B[nb], M[nb], nl[nb]
            if not len(A): continue
            # 外側が道路なら（別の道路の面とのすき間）作らない
            po = M - nl * 0.8
            other = np.isfinite(deck.lower(po[:, 0], po[:, 1]))
            A, B, M, nl = A[~other], B[~other], M[~other], nl[~other]
            if not len(A): continue
            ta = deck.lower((A + nl * 0.3)[:, 0], (A + nl * 0.3)[:, 1]); tb = deck.lower((B + nl * 0.3)[:, 0], (B + nl * 0.3)[:, 1])
            fin = np.isfinite(ta) & np.isfinite(tb)
            A, B, nl, ta, tb = A[fin], B[fin], nl[fin], ta[fin], tb[fin]
            if not len(A): continue
            def reach(P0, t0):
                # 外へ DS の距離ごとに、法面 t0 + S*d と下げる前の地形を比べ、最初に地形より上になる所
                X = P0[:, None, 0] - nl[:, None, 0] * DS[None, :]; Z = P0[:, None, 1] - nl[:, None, 1] * DS[None, :]
                Hg_ = ground_orig(X.ravel(), Z.ravel()).reshape(X.shape)
                F = t0[:, None] + S * DS[None, :]
                above = F >= Hg_
                k = np.where(above.any(1), above.argmax(1), len(DS) - 1)
                D = DS[k]; return D, t0 + S * D
            Da, ha = reach(A, ta); Db, hb = reach(B, tb)
            Da, Db = _smooth_reach(A, B, Da, Db); ha = ta + S * Da; hb = tb + S * Db
            need = np.maximum(ha - ta, hb - tb) > min_h
            if not need.any(): continue
            A, B, nl, ta, tb, Da, Db, ha, hb = A[need], B[need], nl[need], ta[need], tb[need], Da[need], Db[need], ha[need], hb[need]
            Ao = A - nl * Da[:, None]; Bo = B - nl * Db[:, None]
            At = np.stack([A[:, 0], ta - 0.03, A[:, 1]], 1); Bt = np.stack([B[:, 0], tb - 0.03, B[:, 1]], 1)
            Ah = np.stack([Ao[:, 0], ha, Ao[:, 1]], 1); Bh = np.stack([Bo[:, 0], hb, Bo[:, 1]], 1)
            T1 = np.stack([At, Ah, Bh], 1); T2 = np.stack([At, Bh, Bt], 1)
            T = np.concatenate([T1, T2]); nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
            T[nrm[:, 1] < 0] = T[nrm[:, 1] < 0][:, [0, 2, 1]]          # 上向き（斜面を上から見る）
            out.append(T.reshape(-1, 3))
            mix = np.clip((np.concatenate([ha - ta, hb - tb]) - 0.3) / 3.0, 0, 1)[:, None]
            cols.append(np.repeat(GR1 * (1 - mix) + GR2 * mix, 3, 0))
            n_seg += len(A)
    log("  cut faces: segments", n_seg)
    if not out: return np.zeros((0, 3)), np.zeros((0, 3))
    a = np.concatenate(out).reshape(-1, 3, 3); c = np.concatenate(cols).reshape(-1, 3, 3)
    ok = np.isfinite(a).all(axis=(1, 2))
    return a[ok].reshape(-1, 3), c[ok].reshape(-1, 3)


def bridge_structures(bparts, deck, dem_at, bridge_lines, lower_road_at, rail_lines, grid_split, tri_poly, log=print):
    """橋・高架の床版の下面（上面の 1.2m 下）・側面・高欄（地上の道路とつながる端を除く外周）・橋脚（約 30m おき）
    v33: 区間（PLATEAU の面）ごとに作る。区間どうしが同じ高さで接する辺（床版の中の継ぎ目）には側面・高欄を付けない。
    橋の上に橋が重なる所は、それぞれの段の高さで作る（以前は和集合で 1 つにして段が混ざっていた）"""
    parts = []
    for p in bparts:
        if p is None or p.is_empty: continue
        for g in (p.geoms if hasattr(p, "geoms") else [p]):
            if g.geom_type == "Polygon" and g.area > 3: parts.append(g)
    tree = STRtree(parts)
    DF = {}
    def dfn(i):
        if i not in DF: DF[i] = deck.deck_fn(parts[i])
        return DF[i]
    U = unary_union(parts)
    polys = [g for g in (U.geoms if hasattr(U, "geoms") else [U]) if g.geom_type == "Polygon" and g.area > 30]
    under, sides, rails_, piers = [], [], [], []
    rtree = STRtree(rail_lines) if rail_lines else None
    bl_tree = STRtree(bridge_lines) if bridge_lines else None
    TH = 1.2
    n_int = 0
    for pi_, g in enumerate(parts):
        df = dfn(pi_)
        if df is None: continue
        top = lambda x, z, df=df: df(x, z)
        if g.area > 30:
            for piece in grid_split(g, 4.0):
                t = tri_poly(piece, lambda x, z, top=top: float(top(x, z)[0]) - TH)
                if len(t): under.append(t.reshape(-1, 3, 3)[:, ::-1].reshape(-1, 3))
        A, B = _ring_segments(g, 2.0)
        if not len(A): continue
        d = B - A; L = np.hypot(d[:, 0], d[:, 1]); ok = L > 0.05; A, B, d, L = A[ok], B[ok], d[ok], L[ok]
        nl = np.stack([-d[:, 1], d[:, 0]], 1) / L[:, None]
        ai = A + nl * 0.3; bi = B + nl * 0.3
        ta = top(ai[:, 0], ai[:, 1]); tb = top(bi[:, 0], bi[:, 1])
        fin = np.isfinite(ta) & np.isfinite(tb)
        A, B, ta, tb, nl = A[fin], B[fin], ta[fin], tb[fin], nl[fin]
        if not len(A): continue
        # 隣の区間と同じ高さで接する辺（継ぎ目）は付けない
        M = (A + B) / 2; po = M - nl * 0.6
        seam = np.zeros(len(A), bool)
        pr, tr = tree.query(shapely.points(po[:, 0], po[:, 1]), predicate="intersects")
        if len(pr):
            m = tr != pi_; pr, tr = pr[m], tr[m]
            for oi in np.unique(tr):
                dfo = dfn(int(oi))
                if dfo is None: continue
                sel = pr[tr == oi]
                ho = dfo(po[sel, 0], po[sel, 1])
                same = np.isfinite(ho) & (np.abs(ho - (ta[sel] + tb[sel]) / 2) < 1.5)
                seam[sel[same]] = True
        n_int += int(seam.sum())
        keep = ~seam
        if not keep.any(): continue
        A, B, ta, tb, nl, M, po = A[keep], B[keep], ta[keep], tb[keep], nl[keep], M[keep], po[keep]
        sides.append(_quads(A, B, ta - 0.04, tb - 0.04, ta - TH, tb - TH, -nl))
        # 高欄: 外が地上の道路（橋の端）でない所
        po5 = M - nl * 0.5
        lr = lower_road_at(po5[:, 0], po5[:, 1])
        endj = np.isfinite(lr) & (np.abs(lr - (ta + tb) / 2) < 1.5)   # 外が同じ高さの道路 = 橋の端（つながっている）
        k = ~endj
        if k.any():
            A2, B2, ta2, tb2, nl2 = A[k], B[k], ta[k], tb[k], nl[k]
            Ai = A2 + nl2 * 0.25; Bi = B2 + nl2 * 0.25
            rails_.append(_quads(A2, B2, ta2 + 1.0, tb2 + 1.0, ta2 - 0.05, tb2 - 0.05, -nl2))      # 外面
            rails_.append(_quads(Ai, Bi, ta2 + 1.0, tb2 + 1.0, ta2 - 0.05, tb2 - 0.05, nl2))      # 内面
            T1 = np.stack([np.stack([A2[:, 0], ta2 + 1.0, A2[:, 1]], 1), np.stack([B2[:, 0], tb2 + 1.0, B2[:, 1]], 1), np.stack([Bi[:, 0], tb2 + 1.0, Bi[:, 1]], 1)], 1)
            T2 = np.stack([np.stack([A2[:, 0], ta2 + 1.0, A2[:, 1]], 1), np.stack([Bi[:, 0], tb2 + 1.0, Bi[:, 1]], 1), np.stack([Ai[:, 0], ta2 + 1.0, Ai[:, 1]], 1)], 1)
            T = np.concatenate([T1, T2]); nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); T[nrm[:, 1] < 0] = T[nrm[:, 1] < 0][:, [0, 2, 1]]
            rails_.append(T.reshape(-1, 3))
    # 橋脚: 橋の中の OSM の橋の中心線に沿って約 30m おき（つながった橋ごと。高さはその点を含む区間のうち一番低い段）
    def pier_top(p0):
        idx = tree.query(Point(*p0), predicate="intersects")
        tops = []
        for oi in np.atleast_1d(idx):
            f = dfn(int(oi))
            if f is not None:
                v = float(f(p0[0], p0[1])[0])
                if np.isfinite(v): tops.append(v)
        return min(tops) if tops else float("nan")
    for g in polys:
        if bl_tree is None: break
        for li in bl_tree.query(g):
            seg = bridge_lines[li].intersection(g)
            for s in (seg.geoms if hasattr(seg, "geoms") else [seg]):
                if s.geom_type != "LineString" or s.length < 40: continue
                n = int(s.length // 30)
                for q in range(1, n + 1):
                    sp = s.length * q / (n + 1); p0 = np.array(s.interpolate(sp).coords[0]); p1 = np.array(s.interpolate(min(s.length, sp + 1.0)).coords[0])
                    tv = p1 - p0; tv /= (np.linalg.norm(tv) + 1e-9); nv = np.array([-tv[1], tv[0]])
                    tp = pier_top(p0); bot = float(dem_at(np.array([p0[0]]), np.array([p0[1]]))[0]) - 0.8
                    if not np.isfinite(tp) or tp - TH - bot < 2.5: continue
                    lr_ = lower_road_at(np.array([p0[0]]), np.array([p0[1]]))[0]
                    if np.isfinite(lr_) and lr_ < tp - 2.5: continue          # 下に道路 → 置かない
                    if rtree is not None and any(rail_lines[r].distance(Point(*p0)) < 4.5 for r in rtree.query(Point(*p0).buffer(5))): continue
                    # 幅: 中心線に直角な線と橋の面の交わり
                    cross = LineString([p0 - nv * 40, p0 + nv * 40]).intersection(g)
                    w = cross.length if not cross.is_empty else 8.0
                    w = min(max(w, 4.0), 30.0)
                    body = LineString([p0 - nv * w * 0.38, p0 + nv * w * 0.38]).buffer(0.8, cap_style=1)
                    cap = LineString([p0 - nv * w * 0.45, p0 + nv * w * 0.45]).buffer(1.1, cap_style=2)
                    for poly_, y0, y1 in ((body, bot, tp - TH), (cap, tp - TH - 0.9, tp - TH)):
                        c_ = np.asarray(shapely.segmentize(poly_.exterior, 1.0).coords)
                        a_ = c_[:-1]; b_ = c_[1:]; dd = b_ - a_; ll = np.maximum(np.hypot(dd[:, 0], dd[:, 1]), 1e-6)
                        cen = np.array(poly_.centroid.coords[0]); mid = (a_ + b_) / 2; ow = mid - cen
                        piers.append(_quads(a_, b_, np.full(len(a_), y1), np.full(len(a_), y1), np.full(len(a_), y0), np.full(len(a_), y0), ow))
    def cat(L):
        if not L: return np.zeros((0, 3))
        a = np.concatenate(L).reshape(-1, 3, 3); a = a[np.isfinite(a).all(axis=(1, 2))]   # 念のため: 高さの無い三角形は捨てる
        return a.reshape(-1, 3)
    res = dict(under=cat(under), sides=cat(sides), rails=cat(rails_), piers=cat(piers))
    log("  bridge structures: parts", len(parts), "seam edges skipped", n_int, {k: len(v) // 3 for k, v in res.items()})
    return res


def building_plinths(items, ground, min_gap=0.05, log=print):
    """items: (三角形, 色, 種類, 基準の高さ, …) の並び。壁の下端（基準の高さ）が地面より高い所に、地面の 0.3m 下までの基礎（色は壁の 75%）"""
    pos, col = [], []; n = 0
    for tri, c, kind, base_y, fh, var in items:
        if kind != "wall": continue
        t = np.asarray(tri, np.float64).reshape(-1, 3, 3)
        if t[:, :, 1].min() > base_y + 0.3: continue   # 上の階の壁
        # 下端の辺（両端が基準の高さ）
        E = []
        for (i, j) in ((0, 1), (1, 2), (2, 0)):
            m = (np.abs(t[:, i, 1] - base_y) < 0.05) & (np.abs(t[:, j, 1] - base_y) < 0.05)
            if m.any():
                nrm = np.cross(t[m, 1] - t[m, 0], t[m, 2] - t[m, 0])
                E.append((t[m, i][:, [0, 2]], t[m, j][:, [0, 2]], nrm[:, [0, 2]]))
        if not E: continue
        A = np.concatenate([e[0] for e in E]); B = np.concatenate([e[1] for e in E]); O = np.concatenate([e[2] for e in E])
        ok = np.hypot(*(B - A).T) > 0.05; A, B, O = A[ok], B[ok], O[ok]
        if not len(A): continue
        ga = ground(A[:, 0], A[:, 1]); gb = ground(B[:, 0], B[:, 1])
        need = np.maximum(base_y - ga, base_y - gb) > min_gap
        if not need.any(): continue
        A, B, O, ga, gb = A[need], B[need], O[need], ga[need], gb[need]
        q = _quads(A, B, np.full(len(A), base_y + 0.01), np.full(len(A), base_y + 0.01), np.minimum(ga, base_y) - 0.3, np.minimum(gb, base_y) - 0.3, O)
        pos.append(q); col.append(np.repeat(np.asarray(c, np.float64)[None, :] * 0.75, len(q), 0)); n += len(A)
    log("  building plinths: edges", n)
    return (np.concatenate(pos), np.concatenate(col)) if pos else (np.zeros((0, 3)), np.zeros((0, 3)))
