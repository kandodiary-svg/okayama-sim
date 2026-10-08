"""v29: 範囲拡大の道路面を作る。
  v28 の道路（/home/claude/wx/roads_final_core.pkl。橋・駅前・天満屋構内などを手作業で直してある）はそのまま使い、
  新しく作った道路（roads.py → /home/claude/wx/roads_new.pkl。データ範囲の全域）のうち、v28 の道路の無い所だけを足す。
  ・三角形: 新しい三角形の重心が v28 の道路の範囲（全部の種類の和集合＋5cm）に入るものは捨てる
  ・縁石: 新しい縁石（区間ごと 12 頂点）は、中点が「新しく足した道路の面」から 0.4m 以内のものだけ残す
  ・高さ・種類のラスタ（0.5m）: v28 の値がある升目は v28 の値。それ以外は、残した新しい三角形だけを roads.py と同じ方法で塗る
出力: /home/claude/wx/roads_final.pkl
"""
import os, sys, pickle, time
import numpy as np
import shapely
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(__file__))

from common import CORE, load_track_line
W = "/home/claude/wx"
TRK = load_track_line(); shapely.prepare(TRK)
t0 = time.time()
from common import load_roads, save_roads
OLD = load_roads(f"{W}/roads_final_core.pkl", None)
NEW = load_roads(f"{W}/roads_new.pkl", "r")   # v30: 格子はファイルから必要な所だけ

def tri_union(t):
    tt = t.reshape(-1, 3, 3)[:, :, [0, 2]]
    polys = shapely.polygons(np.concatenate([tt, tt[:, :1]], 1))
    polys = polys[shapely.area(polys) > 1e-4]
    if len(polys) == 0: return None
    return shapely.union_all(shapely.make_valid(polys)).buffer(0.03).buffer(-0.03)

parts = [OLD["lanes"], OLD["raised"]] + [tri_union(t) for t in OLD["tris"].values() if len(t)]
COV = unary_union([p for p in parts if p is not None and not p.is_empty])
COVo = COV.buffer(0.05); COVi = COV.buffer(-0.05)
shapely.prepare(COVo); shapely.prepare(COVi)
print("v28 road coverage m2", round(COV.area), "time", round(time.time() - t0), flush=True)

# ---- 三角形 ----
# v29: v28 の格子の端（最後の DEM 節点より外、例: x 2796〜2800）の LOD1 の道路の頂点は、v28 では DEM を端の値で延ばした高さだった。
#      範囲を広げると外側と段差になる（丘の斜面の道で最大 1.4m）ので、その頂点だけ今の DEM（core の中は v28 と同じ値）で高さを付け直す。
#      LOD1 の頂点（高さ = v28 の DEM＋0.04、歩道は＋0.15 も）だけが対象（実測の高さの LOD3 などは変えない）
_dO = np.load(f"{W}/dem_grid_core.npz"); _dN = np.load(f"{W}/dem_grid.npz")
def _dem(d, x, z):
    DX0_, DZ0_, DS_ = float(d["x0"]), float(d["z0"]), float(d["step"]); DH_ = d["H"].astype(np.float64)
    fx = (np.asarray(x) - DX0_) / DS_; fz = (np.asarray(z) - DZ0_) / DS_
    i0 = np.clip(np.floor(fx).astype(int), 0, DH_.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH_.shape[0] - 2)
    tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
    return (DH_[j0, i0] * (1 - tx) + DH_[j0, i0 + 1] * tx) * (1 - tz) + (DH_[j0 + 1, i0] * (1 - tx) + DH_[j0 + 1, i0 + 1] * tx) * tz
_nx0, _nz0 = float(_dO["x0"]), float(_dO["z0"]); _nx1 = _nx0 + (_dO["H"].shape[1] - 1) * 4.0; _nz1 = _nz0 + (_dO["H"].shape[0] - 1) * 4.0
EDGE_FIX = {}
for cat, t in OLD["tris"].items():
    t = np.asarray(t, np.float64)
    if not len(t): continue
    out_ = (t[:, 0] > _nx1) | (t[:, 2] > _nz1) | (t[:, 0] < _nx0) | (t[:, 2] < _nz0)
    if not out_.any(): continue
    lift = 0.15 if cat in ("walk", "island", "green", "tramstop") else 0.0
    old_f = _dem(_dO, t[out_, 0], t[out_, 2]) + 0.04 + lift
    lod1 = np.abs(t[out_, 1] - old_f) < 0.02
    idx = np.nonzero(out_)[0][lod1]
    if len(idx):
        t = t.copy(); t[idx, 1] = _dem(_dN, t[idx, 0], t[idx, 2]) + 0.04 + lift
        tri_ids = np.unique(idx // 3)
        EDGE_FIX[cat] = t.reshape(-1, 3, 3)[tri_ids].reshape(-1, 3)
        OLD["tris"][cat] = t
        print("  edge fix", cat, "vertices", len(idx), "max change", round(float(np.abs(t[idx, 1] - old_f[lod1]).max()), 2), flush=True)
# 縁石も同じだけ動かす（縁石の高さは路面の高さから作ったもの）
_c = np.asarray(OLD["curb"], np.float64).copy()
_co = (_c[:, 0] > _nx1) | (_c[:, 2] > _nz1) | (_c[:, 0] < _nx0) | (_c[:, 2] < _nz0)
if _co.any():
    _c[_co, 1] += _dem(_dN, _c[_co, 0], _c[_co, 2]) - _dem(_dO, _c[_co, 0], _c[_co, 2]); OLD["curb"] = _c
    print("  edge fix curb vertices", int(_co.sum()), flush=True)
# ---- v41.20: 中心部（v28）の古い高架を、新しい縦断の高架に差し替える領域 R ----
# v28 の道路は、高架・橋の路面が地面に貼り付いている（鉄道や道路をまたぐ所で谷底を走る・高架の下をくぐれない）。
# 新しい道路（roads.py）の高さが、地形より 2.5m 以上高く、v28 の路面が地面に貼り付いている（または無い）所を種にして、
# 新旧の高さがちがう（0.35m 超）つながった範囲を R とし、R の中は新しい道路（三角形・縁石・格子・橋の面・上の段）に差し替える
from scipy import ndimage as _ndi
def _core_replace():
    ogx0, ogz0, ores = OLD["grid"]; gx0, gz0, res = NEW["grid"]
    oi_ = int(round((ogx0 - gx0) / res)); oj_ = int(round((ogz0 - gz0) / res))
    onz_, onx_ = OLD["HR"].shape; NH = NEW["HR"]; OH = OLD["HR"]; S = 4
    A = np.array(NH[oj_:oj_ + onz_:S, oi_:oi_ + onx_:S], np.float64); B = np.array(OH[::S, ::S], np.float64)
    xs = ogx0 + (np.arange(0, onx_, S) + 0.5) * res; zs = ogz0 + (np.arange(0, onz_, S) + 0.5) * res
    XX, ZZ = np.meshgrid(xs, zs); D = _dem(_dN, XX, ZZ); Dmax = _ndi.maximum_filter(D, size=9); del XX, ZZ
    fa = np.isfinite(A); fb = np.isfinite(B)
    with np.errstate(invalid="ignore"):
        cand = fa & (A - Dmax >= 2.5) & (~fb | ((B - D < 1.5) & (np.abs(A - B) > 0.5)))
    lab, n = _ndi.label(_ndi.binary_dilation(cand, iterations=8))
    rects = []; info = []
    for k in range(1, n + 1):
        m = (lab == k) & cand
        if int(m.sum()) < 10: continue
        ys, xs_ = np.nonzero(m)
        j0 = max(0, (int(ys.min()) - 20)) * S; j1 = min(onz_, (int(ys.max()) + 20) * S)
        i0 = max(0, (int(xs_.min()) - 20)) * S; i1 = min(onx_, (int(xs_.max()) + 20) * S)
        a = np.array(NH[oj_ + j0:oj_ + j1, oi_ + i0:oi_ + i1], np.float64); b = np.array(OH[j0:j1, i0:i1], np.float64)
        fa2 = np.isfinite(a); fb2 = np.isfinite(b)
        Dm = np.kron(Dmax[j0 // S:(j1 + S - 1) // S, i0 // S:(i1 + S - 1) // S], np.ones((S, S)))[:j1 - j0, :i1 - i0]
        with np.errstate(invalid="ignore"):
            mask = (fa2 & fb2 & (np.abs(a - b) > 0.35)) | (fa2 & ~fb2)
        mask = _ndi.binary_closing(mask, iterations=3)
        lb, nn = _ndi.label(mask)
        with np.errstate(invalid="ignore"):
            seed = fa2 & (a - Dm >= 2.5) & (~fb2 | (a - b > 2.0))
        ids = np.unique(lb[seed & (lb > 0)])
        reg = np.isin(lb, ids) & (lb > 0) & fa2
        if not reg.any(): continue
        x0 = ogx0 + i0 * res; z0 = ogz0 + j0 * res
        for r_ in np.nonzero(reg.any(1))[0]:
            d_ = np.diff(np.concatenate([[0], reg[r_].astype(np.int8), [0]]))
            for s_, e_ in zip(np.nonzero(d_ == 1)[0], np.nonzero(d_ == -1)[0]):
                rects.append(shapely.box(x0 + s_ * res, z0 + r_ * res, x0 + e_ * res, z0 + (r_ + 1) * res))
        info.append((oj_ + j0, oi_ + i0, reg))      # 最終の格子の番号での窓と、R の升目
        print("  core replace region: cells", int(reg.sum()), "area m2", round(reg.sum() * res * res), "centre x", round(x0 + float(np.nonzero(reg.any(0))[0].mean()) * res), "z", round(z0 + float(np.nonzero(reg.any(1))[0].mean()) * res), flush=True)
    if not rects: return shapely.Polygon(), info
    return unary_union(rects).buffer(0.3).buffer(-0.3), info
RCORE, RCORE_INFO = _core_replace()
print("  core replace area m2", round(RCORE.area), "regions", len(RCORE_INFO), flush=True)
if not RCORE.is_empty:
    pickle.dump(shapely.to_wkb(RCORE), open(f"{W}/core_replace.pkl", "wb"))
    COVo = COVo.difference(RCORE); COVi = COVi.difference(RCORE.buffer(0.1)); shapely.prepare(COVo); shapely.prepare(COVi)
    for cat in list(OLD["tris"]):
        t = np.asarray(OLD["tris"][cat], np.float64)
        if not len(t): continue
        c = t.reshape(-1, 3, 3).mean(1); inR = shapely.contains_xy(RCORE, c[:, 0], c[:, 2])
        if inR.any(): OLD["tris"][cat] = t.reshape(-1, 3, 3)[~inR].reshape(-1, 3); print("  core replace: v28 tris dropped", cat, int(inR.sum()), flush=True)
    _c = np.asarray(OLD["curb"], np.float64).reshape(-1, 12, 3); _m = _c.mean(1); _inR = shapely.contains_xy(RCORE, _m[:, 0], _m[:, 2])
    OLD["curb"] = _c[~_inR].reshape(-1, 3); print("  core replace: v28 curb segments dropped", int(_inR.sum()), flush=True)
else:
    if os.path.exists(f"{W}/core_replace.pkl"): os.remove(f"{W}/core_replace.pkl")
tris = {}; NEWT = {}
for cat in sorted(set(OLD["tris"]) | set(NEW["tris"])):
    o = OLD["tris"].get(cat, np.zeros((0, 3))); n = NEW["tris"].get(cat, np.zeros((0, 3)))
    if len(n):
        c = n.reshape(-1, 3, 3).mean(1)
        keep = ~shapely.contains_xy(COVo, c[:, 0], c[:, 2])
        # v28 の範囲（core）で軌道から 395m 以内は、v28 の道路（parse_tran の範囲＝軌道から 400m）がすべて。ここに新しい面は足さない
        # （作り方の細かな違いで出る切れ端を入れない）。v41.20: 差し替える領域 R の中は新しい面を使う
        inc = (CORE[0] < c[:, 0]) & (c[:, 0] < CORE[2]) & (CORE[1] < c[:, 2]) & (CORE[3] > c[:, 2])
        if inc.any():
            _drop = inc & shapely.dwithin(TRK, shapely.points(c[:, 0], c[:, 2]), 395.0)
            if not RCORE.is_empty: _drop &= ~shapely.contains_xy(RCORE, c[:, 0], c[:, 2])
            keep &= ~_drop
        n = n.reshape(-1, 3, 3)[keep].reshape(-1, 3)
    NEWT[cat] = n
    tris[cat] = np.concatenate([np.asarray(o, np.float64), np.asarray(n, np.float64)]) if len(n) else np.asarray(o, np.float64)
    print("  tris", cat, "v28", len(o) // 3, "+ new", len(n) // 3, flush=True)
# ---- 面（2D）----
def _clean(g):
    """細い切れ端（v28 の道路の縁との差の帯など）を捨てる: 面積 2m² 以上・内側へ 0.3m 縮めても残るものだけ"""
    ps = [q for q in (g.geoms if hasattr(g, "geoms") else [g]) if q.geom_type == "Polygon" and q.area > 2.0 and not q.buffer(-0.3).is_empty]
    return unary_union(ps) if ps else shapely.Polygon()
# 足した面（2D）は、残した新しい三角形から作る（新しい道路の面のうち、三角形を捨てた所を含めないように）
# v30: 範囲全体の和集合は作らず、500m の升目ごとに作って部分のリストにする
TS_ = 500.0
def _tu_tiles(cats):
    T = [np.asarray(NEWT[c], np.float64).reshape(-1, 3, 3) for c in cats if len(NEWT.get(c, []))]
    if not T: return []
    T = np.concatenate(T); cen = T.mean(1)
    key = np.floor(cen[:, 0] / TS_).astype(np.int64) * 100000 + np.floor(cen[:, 2] / TS_).astype(np.int64)
    out_ = []
    for k in np.unique(key):
        g = tri_union(T[key == k].reshape(-1, 3))
        if g is None or g.is_empty: continue
        g = _clean(g.difference(COVo))
        out_ += [q for q in (g.geoms if hasattr(g, "geoms") else [g]) if not q.is_empty]
    return out_
new_l = _tu_tiles(("lane", "xing", "rail")); new_r = _tu_tiles(("walk", "island", "green", "tramstop"))
from common import road_parts
def _cut_R(parts):
    if RCORE.is_empty: return parts
    arr = np.array(parts, dtype=object); hit = shapely.intersects(arr, RCORE); out_ = []
    for p, h in zip(parts, hit):
        if not h: out_.append(p); continue
        q = p.difference(RCORE)
        out_ += [g for g in (q.geoms if hasattr(q, "geoms") else [q]) if not g.is_empty]
    return out_
lanes_parts = _cut_R(road_parts(OLD, "lanes")) + new_l; raised_parts = _cut_R(road_parts(OLD, "raised")) + new_r
_NT = shapely.STRtree(new_l + new_r) if (new_l or new_r) else None
print("  lanes/raised parts: new", len(new_l), len(new_r), "area m2", round(sum(q.area for q in new_l + new_r)), "time", round(time.time() - t0), flush=True)
# ---- 縁石 ----
nc = NEW["curb"].reshape(-1, 12, 3)
if len(nc):
    m = nc.mean(1)
    near_new = np.zeros(len(m), bool)
    if _NT is not None:
        _hit = _NT.query(shapely.points(m[:, 0], m[:, 2]), predicate="dwithin", distance=0.4)
        near_new[np.unique(_hit[0])] = True
    nc = nc[near_new & ~shapely.contains_xy(COVi, m[:, 0], m[:, 2])]
curb = np.concatenate([OLD["curb"], nc.reshape(-1, 3)])
print("  curb v28", len(OLD["curb"]) // 12, "+ new", len(nc), flush=True)
# ---- ラスタ ----
GX0, GZ0, RES = NEW["grid"]
_shape = NEW["HR"].shape
_NHR = NEW["HR"]; _NKD = NEW["KIND"]   # v32: 橋が道路の上を通る所は、roads_new の格子（下の段）を使う
_NEWB = NEW.get("bridge_parts"); _NEWU = NEW.get("upper"); _NGRID = NEW["grid"]
del NEW
HR = np.lib.format.open_memmap(f"{W}/roads_final.pkl.HR.npy", mode="w+", dtype=np.float32, shape=_shape)
for _r in range(0, _shape[0], 2048): HR[_r:_r + 2048] = np.nan
KIND = np.lib.format.open_memmap(f"{W}/roads_final.pkl.KIND.npy", mode="w+", dtype=np.uint8, shape=_shape)
NX, NZ = HR.shape[1], HR.shape[0]
def raster(tris, kind):
    """roads.py の raster と同じ（升目の中心が三角形に入れば、その高さ。車道は上書き、歩道は車道でない所だけ）"""
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
        if kind == 1:
            sub[m] = y[m]; ks[m] = 1
        else:
            upd = m & (ks != 1)
            sub[upd] = y[upd]; ks[upd] = 2
# v28 の三角形も塗る（v28 の格子の外にはみ出した部分の升目のため。v28 の格子の中は、あとで v28 の値で上書き）
_ow = (OLD["grid"][0], OLD["grid"][1], OLD["grid"][0] + OLD["HR"].shape[1] * RES, OLD["grid"][1] + OLD["HR"].shape[0] * RES)
def _outside_old(t):
    tt = t.reshape(-1, 3, 3)
    m = (tt[:, :, 0].min(1) < _ow[0] + 1) | (tt[:, :, 0].max(1) > _ow[2] - 1) | (tt[:, :, 2].min(1) < _ow[1] + 1) | (tt[:, :, 2].max(1) > _ow[3] - 1)
    return tt[m].reshape(-1, 3)
for cat in ("lane", "xing", "rail"):
    if len(OLD["tris"].get(cat, [])): raster(_outside_old(OLD["tris"][cat]), 1)
    if len(NEWT.get(cat, [])): raster(NEWT[cat], 1)
for cat in ("walk", "island", "green", "tramstop"):
    if len(OLD["tris"].get(cat, [])): raster(_outside_old(OLD["tris"][cat]), 2)
    if len(NEWT.get(cat, [])): raster(NEWT[cat], 2)
# v32: 上の段（橋）の升目は、下の段（地上の道路）の値に戻す（三角形を塗り直すと、橋と下の道路のどちらかが後から上書きしていた）
if _NEWU is not None and len(_NEWU[0]):
    _ui_ = np.asarray(_NEWU[0]); _jj = _ui_ // NX; _ii = _ui_ % NX
    HR[_jj, _ii] = _NHR[_jj, _ii]; KIND[_jj, _ii] = _NKD[_jj, _ii]
print("  new-only raster cells", int(np.isfinite(HR).sum()), "time", round(time.time() - t0), flush=True)
OGX0, OGZ0, ORES = OLD["grid"]
assert abs(ORES - RES) < 1e-9
oi = int(round((OGX0 - GX0) / RES)); oj = int(round((OGZ0 - GZ0) / RES))
assert abs(oi * RES - (OGX0 - GX0)) < 1e-6 and abs(oj * RES - (OGZ0 - GZ0)) < 1e-6 and oi >= 0 and oj >= 0
ohr = OLD["HR"]; okd = OLD["KIND"]; onz, onx = ohr.shape
sub = HR[oj:oj + onz, oi:oi + onx]; ksub = KIND[oj:oj + onz, oi:oi + onx]
fo = np.isfinite(ohr)
sub[fo] = ohr[fo]; ksub[fo] = okd[fo]
# 端の頂点を直した三角形を塗り直す（v28 の値の上から）
for cat in ("lane", "xing", "rail"):
    if cat in EDGE_FIX: raster(EDGE_FIX[cat], 1)
for cat in ("walk", "island", "green", "tramstop"):
    if cat in EDGE_FIX: raster(EDGE_FIX[cat], 2)
# v41.20: 差し替える領域 R の升目は、新しい道路の格子の値（高架の路面・下の段の道路）
for _j0, _i0, _reg in RCORE_INFO:
    _h, _w = _reg.shape
    _nh = np.asarray(_NHR[_j0:_j0 + _h, _i0:_i0 + _w]); _nk = np.asarray(_NKD[_j0:_j0 + _h, _i0:_i0 + _w])
    _sh = HR[_j0:_j0 + _h, _i0:_i0 + _w]; _sk = KIND[_j0:_j0 + _h, _i0:_i0 + _w]
    _sh[_reg] = _nh[_reg]; _sk[_reg] = _nk[_reg]
    print("  core replace raster cells", int(_reg.sum()), flush=True)
print("  raster: v28 cells", int(fo.sum()), "total finite", int(np.isfinite(HR).sum()), flush=True)
# v32: 橋・高架の面（2D）と、橋が道路の上を通る所の「上の段」（v28 の道路の範囲の外の分だけ）
_bp = []
for q in _NEWB or []:
    if q is None or q.is_empty: continue
    q2 = _clean(q.difference(COVo))
    _bp += [g for g in (q2.geoms if hasattr(q2, "geoms") else [q2]) if not g.is_empty]
_up = _NEWU
if _up is not None and len(_up[0]):
    _nx_ = _shape[1]; _ui = np.asarray(_up[0]); _uj = _ui // _nx_; _uii = _ui % _nx_
    _gx0n, _gz0n, _resn = _NGRID
    _ux = _gx0n + (_uii + 0.5) * _resn; _uz = _gz0n + (_uj + 0.5) * _resn
    _keep = ~shapely.contains_xy(COVo, _ux, _uz)
    # 新しい格子と最終の格子の原点が違う時は番号を付け直す
    _fi = np.floor((_ux - GX0) / RES).astype(np.int64); _fj = np.floor((_uz - GZ0) / RES).astype(np.int64)
    _keep &= (_fi >= 0) & (_fj >= 0) & (_fi < HR.shape[1]) & (_fj < HR.shape[0])
    _upper = ((_fj * HR.shape[1] + _fi)[_keep], np.asarray(_up[1])[_keep], np.asarray(_up[2])[_keep])
else:
    _upper = (np.zeros(0, np.int64), np.zeros(0, np.float32), np.zeros(0, np.uint8))
print("  bridge parts", len(_bp), "upper cells", len(_upper[0]), flush=True)
out = dict(tris=tris, curb=curb, lanes_parts=lanes_parts, raised_parts=raised_parts, bridge_parts=_bp, upper=_upper, HR=HR, KIND=KIND, grid=(GX0, GZ0, RES))
save_roads(out, f"{W}/roads_final.pkl")
print("wrote roads_final.pkl", {k: len(v) // 3 for k, v in tris.items()}, "time", round(time.time() - t0), flush=True)
