"""v32: 道路の高さの縦断（OSM の道路の中心線に沿った高さ）。

PLATEAU の LOD1 の道路面には高さが無い（z=0）ので、以前は頂点ごとに地形（DEM）の高さを付けていた。そのため
  ・高架橋・橋が地形（川底・下の道路）に貼り付く、・斜面・土手で道路が横に傾く、・頂点ごとの地形の凹凸がそのまま出る
という壊れ方をしていた。ここでは次のように高さを決める。
  1) 地上の道路（OSM の highway、橋・トンネルでないもの）: 中心線の上の DEM の高さ（2m おき）。道路面は横に水平（頂点は一番近い中心線の高さ）
  2) 橋・高架（OSM の bridge）: 両端（地上の道路とつながる点）の高さの間をなめらかにつなぐ。下を横切る道路・線路の上には
     すき間（道路 5.9m・線路 7.2m・歩道 3.9m ＝ 通れる高さ＋桁の厚さ）を取る
  3) トンネル: 高さは使わない（道路面を描かない）
使い方: P = Profiles(ways, dem_at); P.height(x, z, level) → (高さ, 中心線までの距離)。level は "ground" / "bridge" / "any"
"""
import math
import numpy as np
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve
from scipy.sparse.csgraph import connected_components

SKIP_HW = {"steps", "elevator", "corridor", "proposed", "platform", "bus_stop", "services", "rest_area", "raceway"}
CLEAR = {"road": 5.9, "rail": 7.2, "foot": 3.9}
FOOT = {"footway", "path", "cycleway", "pedestrian", "bridleway", "track"}
STEP = 2.0

def _yes(v): return v is not None and v not in ("no", "0", "false")
def level_of(t):
    if _yes(t.get("tunnel")) and t.get("tunnel") != "building_passage": return "tunnel"
    if _yes(t.get("bridge")): return "bridge"
    return "ground"

def _densify(xy, step=STEP):
    """頂点の間を step 以下に分ける。戻り値: 点, 元の頂点の番号"""
    xy = np.asarray(xy, np.float64); out = [xy[0]]; vidx = [0]
    for a, b in zip(xy[:-1], xy[1:]):
        L = float(np.hypot(*(b - a))); n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1): out.append(a + (b - a) * k / n)
        vidx.append(len(out) - 1)
    return np.array(out), vidx

class Profiles:
    def __init__(self, ways, dem_at, rails=None, verbose=True):
        self.dem_at = dem_at
        W = [w for w in ways if w["tags"].get("highway") and w["tags"]["highway"] not in SKIP_HW and len(w["xy"]) >= 2]
        self.ways = W
        lv = [level_of(w["tags"]) for w in W]
        # 点を作る（way ごと）。OSM の節点は同じ番号を共有する
        pts = []; wp = []   # wp[i] = (start, end) 点の範囲
        node_pt = {}         # (osm node, way i) -> 点の番号
        for i, w in enumerate(W):
            p, vidx = _densify(w["xy"]); s0 = len(pts); pts.extend(p); wp.append((s0, s0 + len(p)))
            for k, nid in zip(vidx, w["nodes"]): node_pt[(nid, i)] = s0 + k
        P = np.array(pts); N = len(P); self.P = P
        self.pway = np.zeros(N, np.int64)
        for i, (a, b) in enumerate(wp): self.pway[a:b] = i
        self.wlines = [LineString(w["xy"]) for w in W]; self.wtree = STRtree(self.wlines); self.wlevel = lv
        lvl = np.empty(N, object)
        for i, (a, b) in enumerate(wp): lvl[a:b] = lv[i]
        Z = np.asarray(dem_at(P[:, 0], P[:, 1]), np.float64).copy()   # 地上の道路の高さ（中心線の DEM）
        # 節点ごと: どの way（どの level）に属するか
        from collections import defaultdict
        nodes_ways = defaultdict(list)
        for (nid, i), k in node_pt.items(): nodes_ways[nid].append((i, k))
        # ---- v38: 橋の端の手前（地上）は、堤防の天端まで上げる ----
        # OSM の橋の端は川側（堤防の下・水際）にあることが多く、DEM の高さをそのまま使うと、橋の床が堤防の天端より 3〜6m 低くなり、
        # 手前の道（天端の高さ）と橋が段差でつながらなかった。橋の端の周り R m の地上の点を、天端（近くの最高）から勾配 G で下がる包絡線より下にしない
        from scipy.spatial import cKDTree
        _gm = np.array([l == "ground" for l in lvl]); _tree = cKDTree(P); Z0 = Z.copy(); self.n_raised = 0
        for nid, L in nodes_ways.items():
            bp_ = [k for i, k in L if lv[i] == "bridge"]; gp_ = [k for i, k in L if lv[i] == "ground"]
            if not bp_ or not gp_: continue
            c_ = P[gp_[0]]
            ix_ = np.array(_tree.query_ball_point(c_, self.RAISE_R), np.int64)
            if len(ix_): ix_ = ix_[_gm[ix_]]
            if len(ix_) < 2: continue
            Q_ = P[ix_]; D_ = np.hypot(Q_[:, None, 0] - Q_[None, :, 0], Q_[:, None, 1] - Q_[None, :, 1])
            env_ = (Z0[ix_][None, :] - self.RAISE_G * D_).max(axis=1)
            zn_ = np.minimum(np.maximum(Z0[ix_], env_), Z0[ix_] + self.RAISE_MAX)
            up_ = zn_ > Z[ix_] + 0.02
            if up_.any(): Z[ix_[up_]] = zn_[up_]; self.n_raised += int(up_.sum())
        # ---- 橋: 橋の点だけのグラフで、地上とつながる点を固定して、間をなめらかにつなぐ ----
        isb = np.array([l == "bridge" for l in lvl])
        bidx = np.nonzero(isb)[0]; self.n_bridge_pts = len(bidx)
        if len(bidx):
            loc = -np.ones(N, np.int64); loc[bidx] = np.arange(len(bidx))
            ea, eb = [], []
            for i, (a, b) in enumerate(wp):
                if lv[i] != "bridge": continue
                ea.extend(range(a, b - 1)); eb.extend(range(a + 1, b))
            # 同じ OSM 節点を共有する橋の点どうしをつなぐ（長さ 0 の辺 = 同じ高さ）
            same = []
            anchor = {}   # 橋の点 -> 固定の高さ
            for nid, L in nodes_ways.items():
                bpts = [k for i, k in L if lv[i] == "bridge"]
                if not bpts: continue
                for k in bpts[1:]: same.append((bpts[0], k))
                g = [k for i, k in L if lv[i] != "bridge"]
                if g:
                    zg = float(np.mean(Z[g]))
                    for k in bpts: anchor[k] = zg
            ea = np.array(ea, np.int64); eb = np.array(eb, np.int64)
            wlen = np.hypot(*(P[ea] - P[eb]).T); wlen = np.maximum(wlen, 0.05)
            wgt = 1.0 / wlen
            if same:
                sa = np.array([a for a, b in same]); sb = np.array([b for a, b in same])
                ea = np.concatenate([ea, sa]); eb = np.concatenate([eb, sb]); wgt = np.concatenate([wgt, np.full(len(sa), 1e4)])
            nb = len(bidx)
            A = coo_matrix((np.ones(len(ea)), (loc[ea], loc[eb])), shape=(nb, nb))
            ncomp, lab = connected_components(A, directed=False)
            # 端（次数 1）の点で、地上につながらないもの: DEM の高さで固定（データの外・切れ目）
            deg = np.bincount(loc[ea], minlength=nb) + np.bincount(loc[eb], minlength=nb)
            for c in range(ncomp):
                members = bidx[lab == c]
                if not any(int(m) in anchor for m in members):
                    ends = [int(m) for m in members if deg[loc[m]] <= 1] or [int(members[0])]
                    for m in ends: anchor[m] = float(Z[m])
            # 下を横切る道路・線路（交わる所で節点を共有しないもの）のすき間
            cons = self._crossings(W, lv, wp, P, Z, rails, bidx, nodes_ways)
            self.n_cons = len(cons)
            zb = self._solve(P, bidx, loc, ea, eb, wgt, anchor, cons)
            Z[bidx] = zb
        else:
            self.n_cons = 0
        self.Z = Z
        # 検索用: 2m の区間（level ごと）
        segs = {"ground": [], "bridge": []}
        for i, (a, b) in enumerate(wp):
            if lv[i] == "tunnel": continue
            for k in range(a, b - 1): segs[lv[i]].append(k)
        self._idx = {}; self._tree = {}
        for key, L in segs.items():
            L = np.array(L, np.int64); self._idx[key] = L
            self._tree[key] = STRtree(shapely.linestrings(np.stack([P[L], P[L + 1]], 1))) if len(L) else None
        allL = np.concatenate([self._idx["ground"], self._idx["bridge"]]); self._idx["any"] = allL
        self._tree["any"] = STRtree(shapely.linestrings(np.stack([P[allL], P[allL + 1]], 1))) if len(allL) else None
        if verbose:
            print("profiles: ways", len(W), "points", N, "bridge points", self.n_bridge_pts, "raised ground points", self.n_raised, "crossing constraints", self.n_cons,
                  "segments", {k: len(v) for k, v in self._idx.items()}, flush=True)

    def _crossings(self, W, lv, wp, P, Z, rails, bidx, nodes_ways):
        """橋の点ごとの最低の高さ（下を横切るもの＋すき間）"""
        bw = [i for i in range(len(W)) if lv[i] == "bridge"]
        under = []   # (LineString, 種類, way 番号 or -1)
        for i in range(len(W)):
            if lv[i] != "ground": continue
            hw = W[i]["tags"].get("highway")
            under.append((LineString(W[i]["xy"]), "foot" if hw in FOOT else "road", i))
        for r in (rails or []):
            under.append((LineString(r), "rail", -1))
        tree = STRtree([u[0] for u in under])
        cons = {}
        wnodes = [set(w["nodes"]) for w in W]
        for i in bw:
            a, b = wp[i]; ln = LineString(P[a:b])
            for j in tree.query(ln):
                ul, kind, wj = under[j]
                if wj >= 0 and wnodes[wj] & wnodes[i]: continue      # つながっている（同じ高さで交わる）
                x = ln.intersection(ul)
                if x.is_empty: continue
                pts = [x] if x.geom_type == "Point" else [g for g in getattr(x, "geoms", []) if g.geom_type == "Point"]
                for q in pts:
                    if wj >= 0:
                        # 下の道路の高さ（地上）: その way の点のうち一番近いもの
                        c0, c1 = wp[wj]; d_ = np.hypot(P[c0:c1, 0] - q.x, P[c0:c1, 1] - q.y); zu = float(Z[c0 + int(np.argmin(d_))])
                    else:
                        zu = float(self.dem_at(np.array([q.x]), np.array([q.y]))[0])
                    need = zu + CLEAR[kind]
                    # 橋の点のうち交点の周り（±4m）に最低の高さ
                    d = np.hypot(P[a:b, 0] - q.x, P[a:b, 1] - q.y)
                    for k in np.nonzero(d < 4.0)[0]:
                        kk = a + int(k); cons[kk] = max(cons.get(kk, -1e9), need)
        return cons

    RAISE_R = 40.0; RAISE_G = 0.08; RAISE_MAX = 8.0   # v38: 橋の端の手前を堤防の天端まで上げる範囲・勾配・上限
    GRADE = 0.05    # 橋・高架の取り付け（地上とつながる端から）の最大の勾配
    GRADE_C = 0.015 # すき間の点から離れる時の下がり方（高架の途中で大きく垂れないように）
    def _msd(self, nb, ia, ib, ln, src, val, g, sign):
        """多点からの最短距離で sign=+1: min_a(val_a + g*d_a)、sign=-1: max_a(val_a - g*d_a)"""
        from scipy.sparse.csgraph import dijkstra
        src = np.asarray(src, np.int64); val = np.asarray(val, np.float64)
        v = val * sign; v0 = float(v.min())
        rows = np.concatenate([ia, ib, np.full(len(src), nb)]); cols = np.concatenate([ib, ia, src])
        vals = np.concatenate([ln, ln, (v - v0) / g + 1e-6])
        G = coo_matrix((vals, (rows, cols)), shape=(nb + 1, nb + 1)).tocsr()
        dd = dijkstra(G, directed=True, indices=nb)[:nb]
        return sign * (v0 + g * dd)
    def _solve(self, P, bidx, loc, ea, eb, wgt, anchor, cons):
        """1) 両端（地上とつながる点）の間は直線（調和）
        2) 下を横切るもののすき間: その点から 1.5% の勾配で下がる上側の包絡線より下にしない（高架は途中で垂れない）
        3) 地上とつながる端から 5% より急にならないよう上を抑える（取り付け部）
        4) 軽くならす（端は固定）"""
        nb = len(bidx); ia = loc[ea]; ib = loc[eb]
        ln = 1.0 / wgt
        A = coo_matrix((ln, (ia, ib)), shape=(nb, nb)).tocsr(); A = A + A.T
        ncomp, lab = connected_components(A, directed=False)
        an = {loc[k]: v for k, v in anchor.items()}
        z = np.zeros(nb)
        for c in range(ncomp):
            mem = np.nonzero(lab == c)[0]
            z[mem] = self._harmonic_sub(mem, bidx, loc, ia, ib, wgt, {bidx[m]: an[m] for m in mem if m in an})
        if cons:
            ck = np.array([loc[k] for k in cons]); cv = np.array([cons[k] for k in cons])
            env = self._msd(nb, ia, ib, ln, ck, cv, self.GRADE_C, -1)
            z = np.maximum(z, np.where(np.isfinite(env), env, -1e9))
        am = np.array(sorted(an.keys()), np.int64)
        if len(am):
            cap = self._msd(nb, ia, ib, ln, am, [an[m] for m in am], self.GRADE, +1)
            z = np.minimum(z, np.where(np.isfinite(cap), cap, z))
        pinned = np.zeros(nb, bool); pinned[am] = True
        for it in range(25):
            s_ = np.zeros(nb); n_ = np.zeros(nb)
            np.add.at(s_, ia, z[ib] * wgt); np.add.at(n_, ia, wgt)
            np.add.at(s_, ib, z[ia] * wgt); np.add.at(n_, ib, wgt)
            zn = np.where(n_ > 0, s_ / np.maximum(n_, 1e-9), z)
            z = np.where(pinned, z, 0.5 * z + 0.5 * zn)
        return z

    def _harmonic_sub(self, mem, bidx, loc, ia, ib, wgt, fixed):
        """成分 mem（橋の点の番号の中の番号）の中で、fixed（全体の点の番号 → 高さ）を固定した調和の解。固定の無い成分は 0"""
        pos = -np.ones(len(bidx), np.int64); pos[mem] = np.arange(len(mem))
        m = (pos[ia] >= 0) & (pos[ib] >= 0); a = pos[ia[m]]; b = pos[ib[m]]; w = wgt[m]; n = len(mem)
        rows = np.concatenate([a, b, a, b]); cols = np.concatenate([a, b, b, a]); vals = np.concatenate([w, w, -w, -w])
        L = coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()
        fx = np.zeros(n, bool); zf = np.zeros(n)
        for k, v in fixed.items(): fx[pos[loc[k]]] = True; zf[pos[loc[k]]] = v
        if not fx.any(): return zf
        free = np.nonzero(~fx)[0]; z = zf.copy()
        if len(free):
            Lff = L[free][:, free]; rhs = -(L[free][:, np.nonzero(fx)[0]] @ zf[fx])
            z[free] = spsolve(Lff.tocsc(), rhs)
        return z

    def _harmonic(self, nb, bidx, loc, ea, eb, wgt, fixed):
        ia = loc[ea]; ib = loc[eb]
        rows = np.concatenate([ia, ib, ia, ib]); cols = np.concatenate([ia, ib, ib, ia])
        vals = np.concatenate([wgt, wgt, -wgt, -wgt])
        L = coo_matrix((vals, (rows, cols)), shape=(nb, nb)).tocsr()
        fx = np.zeros(nb, bool); zf = np.zeros(nb)
        for k, v in fixed.items(): fx[loc[k]] = True; zf[loc[k]] = v
        free = np.nonzero(~fx)[0]
        z = zf.copy()
        if len(free):
            Lff = L[free][:, free]; rhs = -(L[free][:, np.nonzero(fx)[0]] @ zf[fx])
            # つながらない（固定の無い）ものは無い前提（上で必ず固定を置いている）
            z[free] = spsolve(Lff.tocsc(), rhs)
        return z

    def level_lengths(self, poly):
        """面 poly の中を通る道の長さ（level ごと）"""
        out = {"ground": 0.0, "bridge": 0.0, "tunnel": 0.0}
        for i in self.wtree.query(poly):
            L = self.wlines[i].intersection(poly).length
            if L > 0: out[self.wlevel[i]] += L
        return out
    def ways_in(self, poly, level, min_len=2.0):
        """面 poly の中を通る way（その level）の番号。中を通る長さ min_len 以上（面の中心線を持つ道）"""
        out = set()
        for i in self.wtree.query(poly):
            if self.wlevel[i] != level and not (level == "any" and self.wlevel[i] != "tunnel"): continue
            if self.wlines[i].intersection(poly).length >= min_len: out.add(int(i))
        return out
    def height_own(self, x, z, level, own, maxd=25.0):
        """一番近い中心線の高さ。ただし own（way の番号の集合）があれば、その way の中から選ぶ（隣の別の道の高さを拾わない）"""
        if not own: return self.height(x, z, level, maxd)
        x = np.asarray(x, np.float64); z = np.asarray(z, np.float64)
        T = self._tree.get(level); out = np.full(len(x), np.nan); dist = np.full(len(x), np.inf)
        if T is None or not len(x): return out, dist
        q = shapely.points(x, z)
        pi, si = T.query(q, predicate="dwithin", distance=maxd * 2)
        L = self._idx[level][si]; keep = np.isin(self.pway[L], np.fromiter(own, np.int64))
        pi, L = pi[keep], L[keep]
        if len(pi):
            A = self.P[L]; B = self.P[L + 1]; v = B - A; w = np.stack([x[pi], z[pi]], 1) - A
            t = np.clip((w * v).sum(1) / np.maximum((v * v).sum(1), 1e-9), 0, 1)
            d = np.hypot(*(A + v * t[:, None] - np.stack([x[pi], z[pi]], 1)).T); h = self.Z[L] + (self.Z[L + 1] - self.Z[L]) * t
            o = np.lexsort((d, pi)); pi, d, h = pi[o], d[o], h[o]
            first = np.concatenate([[True], pi[1:] != pi[:-1]])
            out[pi[first]] = h[first]; dist[pi[first]] = d[first]
        miss = ~np.isfinite(out)
        if miss.any():
            h2, d2 = self.height(x[miss], z[miss], level, maxd); out[miss] = h2; dist[miss] = d2
        return out, dist
    def height(self, x, z, level="any", maxd=25.0):
        """一番近い中心線（その level）の高さ。戻り値: 高さ（無ければ nan）, 距離"""
        x = np.asarray(x, np.float64); z = np.asarray(z, np.float64)
        T = self._tree.get(level); out = np.full(len(x), np.nan); dist = np.full(len(x), np.inf)
        if T is None or not len(x): return out, dist
        q = shapely.points(x, z)
        (ii, jj), dd = T.query_nearest(q, max_distance=maxd, return_distance=True, all_matches=False)
        L = self._idx[level][jj]
        A = self.P[L]; B = self.P[L + 1]; v = B - A; w = np.stack([x[ii], z[ii]], 1) - A
        t = np.clip((w * v).sum(1) / np.maximum((v * v).sum(1), 1e-9), 0, 1)
        out[ii] = self.Z[L] + (self.Z[L + 1] - self.Z[L]) * t; dist[ii] = dd
        return out, dist
