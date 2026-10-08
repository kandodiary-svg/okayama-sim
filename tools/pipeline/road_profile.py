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
        # ---- v41.20: 地上の道の縦断をなめらかに ----
        # DEM（4m 格子）の細かなノイズ（±0.2〜0.3m・十数 m 周期）が、そのまま路面の凸凹（車がカタカタ揺れる）になっていた。
        # 道の点をつなぐグラフ（同じ OSM 節点を共有する点どうしも）の上で、拡散（ラプラシアン）を繰り返して平均をとる。
        # 標準偏差で約 9m ぶん。もとの高さからの変化は ±0.6m までに抑え、トンネルの入口など本当の高低差をつぶさない
        self.n_smoothed = 0; _ia = None; _m = None
        if self.SMOOTH_IT > 0:
            _ia, _ib = [], []
            for i, (a, b) in enumerate(wp):
                if lv[i] != "ground": continue
                _ia.extend(range(a, b - 1)); _ib.extend(range(a + 1, b))
            for nid, L in nodes_ways.items():
                g_ = [k for i, k in L if lv[i] == "ground"]
                for k in g_[1:]: _ia.append(g_[0]); _ib.append(k)
            if _ia:
                _ia = np.array(_ia, np.int64); _ib = np.array(_ib, np.int64)
                _A = coo_matrix((np.ones(2 * len(_ia)), (np.concatenate([_ia, _ib]), np.concatenate([_ib, _ia]))), shape=(N, N)).tocsr()
                _deg = np.asarray(_A.sum(1)).ravel(); _m = _deg > 0
                _Zs = Z.copy()
                for _it in range(self.SMOOTH_IT):
                    _nb = _A @ _Zs
                    _Zs[_m] += self.SMOOTH_L * (_nb[_m] / _deg[_m] - _Zs[_m])
                _d = np.clip(_Zs - Z, -self.SMOOTH_MAX, self.SMOOTH_MAX); _d[~_m] = 0.0
                self.n_smoothed = int((np.abs(_d) > 0.05).sum()); Z = Z + _d
                self._gA, self._gdeg = _A, _deg
                del _Zs, _d
        # ---- v41.20: 地上の道の勾配の上限（LIP_G）。DEM の崖・OSM と DEM の位置のずれ・OSM に無い橋の谷で、道が 2m で 3〜8m 上下する段（勾配 100% 超）が
        #      できていた（車が壁にぶつかる・跳ねる）。「下からの包絡線（min(Z_j + g·d)）と上からの包絡線（max(Z_j − g·d)）の平均」にする
        #      （勾配が g 以下の所はそのまま。段は両側にまたがる勾配 g の坂になる。一様な急坂は両端以外ほぼ変わらない）。変化は ±LIP_MAX まで
        self.n_lip = 0
        if self.LIP_G > 0 and _ia is not None and len(_ia):
            # 長い周期の成分（約 20m の拡散）を引いた「残り」にだけ包絡線をかける: 続く急坂（山の道）は残りがほぼ 0 なので変わらず、段（崖）だけが坂になる
            _A, _deg = self._gA, self._gdeg
            _T = Z.copy()
            for _it in range(self.LIP_IT):
                _nb = _A @ _T; _T[_m] += 0.5 * (_nb[_m] / _deg[_m] - _T[_m])
            _res = Z - _T
            _gi = np.nonzero(_m)[0]; _lg = -np.ones(N, np.int64); _lg[_gi] = np.arange(len(_gi))
            _ln = np.maximum(np.hypot(*(P[_ia] - P[_ib]).T), 0.02)
            _lo = self._msd(len(_gi), _lg[_ia], _lg[_ib], _ln, np.arange(len(_gi)), _res[_gi], self.LIP_G, +1)
            _hi = self._msd(len(_gi), _lg[_ia], _lg[_ib], _ln, np.arange(len(_gi)), _res[_gi], self.LIP_G, -1)
            _dl = np.clip((_lo + _hi) / 2 - _res[_gi], -self.LIP_MAX, self.LIP_MAX)
            self.n_lip = int((np.abs(_dl) > 0.1).sum()); Z[_gi] += _dl
            del _gi, _lg, _ln, _lo, _hi, _dl, _T, _res, _A, _deg
            self._gA = self._gdeg = None
        # ---- v41.20: トンネルの出入口の手前（地上の道の点）は、DEM が坑口の壁で立ち上がる分を取り除く ----
        # トンネルの入口の DEM は、坑口の壁（トンネルの上の地面へ立ち上がる斜面）の高さになる。道路の点を入口から離れる向きに見て、
        # それより遠い点の最低の高さ（谷底）より上にならないようにする（入口に向かって上り坂にならず、路面は谷底の高さのまま坑口へ入る）
        self.tunnel_anchor = {}   # トンネルの点（全体の番号）-> 坑口の高さ
        _gmask = np.array([l == "ground" for l in lvl])
        for nid, L in nodes_ways.items():
            tp_ = [k for i, k in L if lv[i] == "tunnel"]; gp_ = [k for i, k in L if lv[i] == "ground"]
            if not tp_ or not gp_: continue
            c_ = P[gp_[0]]; _gw = np.array(sorted({i for i, k in L if lv[i] == "ground"}), np.int64)
            ix_ = np.nonzero(np.isin(self.pway, _gw) & _gmask & (np.hypot(P[:, 0] - c_[0], P[:, 1] - c_[1]) < self.PORTAL_R))[0]
            if len(ix_) < 2:
                for k in tp_: self.tunnel_anchor[k] = float(Z[gp_[0]])
                continue
            d_ = np.hypot(P[ix_, 0] - c_[0], P[ix_, 1] - c_[1]); ix_ = ix_[np.argsort(-d_)]    # 遠い点から近い点へ
            run_ = np.minimum.accumulate(Z[ix_])       # 遠い側からの最低（谷底）
            Z[ix_] = np.minimum(Z[ix_], run_)
            for k in tp_: self.tunnel_anchor[k] = float(run_[-1])
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
            # v39: 橋につながる道（この節点を通る地上の way）の点だけを上げる。橋の下をくぐる別の道（山陽道など）まで上げてしまい、
            #      橋の下の道が最大 8m 盛り上がっていた
            if len(ix_):
                _gw = np.array(sorted({i for i, k in L if lv[i] == "ground"}), np.int64)
                ix_ = ix_[np.isin(self.pway[ix_], _gw)]
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
                # v41.20: 橋の端（OSM の橋の way の最初・最後の点）だけを、地上の高さに固定する。橋の途中の点が地上の way
                #         （歩道・階段・下の道の誤った共有節点）と同じ節点でも、橋の床を地上まで引き下げない（高架の途中に穴・谷ができていた）
                if g and (not self.BR_END_ONLY or any(k in (wp[i][0], wp[i][1] - 1) for i, k in L if lv[i] == "bridge")):
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
        # ---- v41.20: トンネルの床（路面）の高さ: 坑口（地上の道とつながる点）の間を直線でつなぐ ----
        # つながる地上の道が無い端は、その点の DEM より 4.5m 下（線路や道の下をくぐる深さ）に固定
        self.n_tunnel_pts = 0
        isT = np.array([l == "tunnel" for l in lvl]); tidx = np.nonzero(isT)[0]
        if len(tidx):
            loc_t = -np.ones(N, np.int64); loc_t[tidx] = np.arange(len(tidx))
            ea_t, eb_t = [], []
            for i, (a, b) in enumerate(wp):
                if lv[i] != "tunnel": continue
                ea_t.extend(range(a, b - 1)); eb_t.extend(range(a + 1, b))
            sa_t, sb_t = [], []
            for nid, L in nodes_ways.items():
                tp_ = [k for i, k in L if lv[i] == "tunnel"]
                for k in tp_[1:]: sa_t.append(tp_[0]); sb_t.append(k)
            ea_t = np.array(ea_t, np.int64); eb_t = np.array(eb_t, np.int64)
            wl_t = np.maximum(np.hypot(*(P[ea_t] - P[eb_t]).T), 0.05); wg_t = 1.0 / wl_t
            if sa_t:
                ea_t = np.concatenate([ea_t, np.array(sa_t, np.int64)]); eb_t = np.concatenate([eb_t, np.array(sb_t, np.int64)])
                wg_t = np.concatenate([wg_t, np.full(len(sa_t), 1e4)])
            nt = len(tidx); anc_t = dict(self.tunnel_anchor)
            At = coo_matrix((np.ones(len(ea_t)), (loc_t[ea_t], loc_t[eb_t])), shape=(nt, nt))
            nct, lab_t = connected_components(At, directed=False)
            deg_t = np.bincount(loc_t[ea_t], minlength=nt) + np.bincount(loc_t[eb_t], minlength=nt)
            zt = np.zeros(nt)
            for c in range(nct):
                mem = tidx[lab_t == c]
                if not any(int(m) in anc_t for m in mem):
                    ends = [int(m) for m in mem if deg_t[loc_t[m]] <= 1] or [int(mem[0])]
                    for m in ends: anc_t[m] = float(Z[m]) - 4.5
                fixed = {int(m): anc_t[int(m)] for m in mem if int(m) in anc_t}
                # 片方の端にしか固定が無い（もう一方は地上とつながらない）時は、もう一方の端も DEM-4.5 で固定
                ends_ = [int(m) for m in mem if deg_t[loc_t[m]] <= 1]
                for m in ends_:
                    if m not in fixed: fixed[m] = float(Z[m]) - 4.5
                zt[lab_t == c] = self._harmonic_sub(np.nonzero(lab_t == c)[0], tidx, loc_t, loc_t[ea_t], loc_t[eb_t], wg_t, fixed)
            Z[tidx] = zt; self.n_tunnel_pts = nt
        self.Z = Z; self.wp = wp
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
            print("profiles: ways", len(W), "points", N, "bridge points", self.n_bridge_pts, "raised ground points", self.n_raised, "smoothed", self.n_smoothed, "lip", self.n_lip, "tunnel points", self.n_tunnel_pts, "crossing constraints", self.n_cons,
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

    SMOOTH_IT = 40; SMOOTH_L = 0.5; SMOOTH_MAX = 0.6   # v41.20: 地上の縦断のなめらかさ（拡散の回数・1 回の重み・変化の上限 m）
    LIP_G = 0.30; LIP_MAX = 3.5; LIP_IT = 200                          # v41.20: 地上の道の勾配の上限（30%）・その平坦化での変化の上限 m
    PORTAL_R = 30.0                                     # v41.20: トンネルの坑口の手前（地上の点）をならす範囲 m
    RAISE_R = 40.0; RAISE_G = 0.08; RAISE_MAX = 8.0   # v38: 橋の端の手前を堤防の天端まで上げる範囲・勾配・上限
    GRADE_OBST = 0.08   # v41.20: 障害物のある膜の時の、取り付けの最大の勾配（枝の道が高架の途中から降りる所で、本線を引き下げない）
    GRADE = 0.05    # 橋・高架の取り付け（地上とつながる端から）の最大の勾配
    BR_END_ONLY = True; BR_OBST = True   # v41.20: 橋の床の縦断（端だけ固定・障害物のある膜）。False で v41.19 の方法
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
        if cons and self.BR_OBST:
            # v41.20: 下を横切るもののすき間は「障害物のある膜」で解く（すき間の高さより下にならない中で、一番まっすぐ・なめらかな縦断）。
            #         以前の「すき間の点ごとに 1.5% で垂れる包絡線」は、すき間の点が散らばる長い高架で上下に波打っていた
            need = np.full(nb, -1e9)
            for k, v in cons.items(): need[loc[k]] = max(need[loc[k]], v)
            # すき間の高さは、固定の点（地上とつながる端）から「同じ way の中で」勾配 GRADE_OBST で上がれる高さまで（短い橋で急な坂にしない）
            _am0 = np.array(sorted(an.keys()), np.int64)
            if len(_am0):
                _ms = wgt < 1e3
                _cp = self._msd(nb, ia[_ms], ib[_ms], ln[_ms], _am0, [an[m] for m in _am0], self.GRADE_OBST, +1)
                _ok = np.isfinite(_cp) & (need > -1e8)
                need[_ok] = np.minimum(need[_ok], _cp[_ok])
            sA = np.concatenate([ia, ib]); sB = np.concatenate([ib, ia]); sW = np.concatenate([wgt, wgt])
            for c in range(ncomp):
                mem = np.nonzero(lab == c)[0]
                cm = mem[(need[mem] > -1e8) & ~np.isin(mem, list(an.keys()))]
                if not len(cm): continue
                act = set(); inm = np.zeros(nb, bool); inm[mem] = True
                fx0 = {bidx[m]: an[m] for m in mem if m in an}
                for it in range(60):
                    fx = dict(fx0); fx.update({bidx[m]: need[m] for m in act})
                    zc = self._harmonic_sub(mem, bidx, loc, ia, ib, wgt, fx)
                    zz = np.zeros(nb); zz[mem] = zc[mem] if len(zc) == nb else zc
                    viol = [m for m in cm if m not in act and zz[m] < need[m] - 0.01]
                    # 解放: 固定している点で、近傍の（重みつき）平均が need より高ければ、固定しなくても need 以上になる
                    sm = np.zeros(nb); sn = np.zeros(nb); np.add.at(sm, sA, zz[sB] * sW); np.add.at(sn, sA, sW)
                    rel = [m for m in act if sn[m] > 0 and sm[m] / sn[m] > need[m] + 0.01]
                    if not viol and not rel: break
                    act |= set(viol); act -= set(rel)
                z[mem] = zz[mem]
        elif cons:
            ck = np.array([loc[k] for k in cons]); cv = np.array([cons[k] for k in cons])
            env = self._msd(nb, ia, ib, ln, ck, cv, self.GRADE_C, -1)
            z = np.maximum(z, np.where(np.isfinite(env), env, -1e9))
        am = np.array(sorted(an.keys()), np.int64)
        if len(am):
            if self.BR_OBST:
                pass   # v41.20: 勾配はすき間の高さ（上で GRADE_OBST までに制限）で決まる。床を後から引き下げない
            else:
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

    def tunnel_export(self):
        """v41.20: トンネルの床の縦断 [(way の OSM id, tags, 点列 xz (n,2), 床の高さ (n,))]（道路のトンネルだけを tunnels.py に渡す）"""
        out = []
        for i, (a, b) in enumerate(self.wp):
            if self.wlevel[i] != "tunnel": continue
            out.append((self.ways[i].get("id"), self.ways[i]["tags"], self.P[a:b].copy(), self.Z[a:b].copy()))
        return out
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
