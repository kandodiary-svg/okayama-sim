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
OLD = pickle.load(open(f"{W}/roads_final_core.pkl", "rb"))
NEW = pickle.load(open(f"{W}/roads_new.pkl", "rb"))

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
tris = {}; NEWT = {}
for cat in sorted(set(OLD["tris"]) | set(NEW["tris"])):
    o = OLD["tris"].get(cat, np.zeros((0, 3))); n = NEW["tris"].get(cat, np.zeros((0, 3)))
    if len(n):
        c = n.reshape(-1, 3, 3).mean(1)
        keep = ~shapely.contains_xy(COVo, c[:, 0], c[:, 2])
        # v28 の範囲（core）で軌道から 395m 以内は、v28 の道路（parse_tran の範囲＝軌道から 400m）がすべて。ここに新しい面は足さない
        # （作り方の細かな違いで出る切れ端を入れない）
        inc = (CORE[0] < c[:, 0]) & (c[:, 0] < CORE[2]) & (CORE[1] < c[:, 2]) & (c[:, 2] < CORE[3])
        if inc.any():
            keep &= ~(inc & shapely.dwithin(TRK, shapely.points(c[:, 0], c[:, 2]), 395.0))
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
def _tu(cats):
    L = [tri_union(NEWT[c]) for c in cats if len(NEWT.get(c, []))]
    L = [g for g in L if g is not None and not g.is_empty]
    return unary_union(L) if L else shapely.Polygon()
new_l = _clean(_tu(("lane", "xing", "rail")).difference(COVo)); new_r = _clean(_tu(("walk", "island", "green", "tramstop")).difference(COVo))
lanes = unary_union([OLD["lanes"], new_l]) if not new_l.is_empty else OLD["lanes"]      # 足す物が無ければ v28 の形をそのまま（頂点の並びも同じ）
raised = unary_union([OLD["raised"], new_r]) if not new_r.is_empty else OLD["raised"]
NEWONLY = unary_union([new_l, new_r]).buffer(0.4); shapely.prepare(NEWONLY)
print("  lanes/raised merged; new-only area m2", round(NEWONLY.area), "time", round(time.time() - t0), flush=True)
# ---- 縁石 ----
nc = NEW["curb"].reshape(-1, 12, 3)
if len(nc):
    m = nc.mean(1)
    nc = nc[shapely.contains_xy(NEWONLY, m[:, 0], m[:, 2]) & ~shapely.contains_xy(COVi, m[:, 0], m[:, 2])]
curb = np.concatenate([OLD["curb"], nc.reshape(-1, 3)])
print("  curb v28", len(OLD["curb"]) // 12, "+ new", len(nc), flush=True)
# ---- ラスタ ----
GX0, GZ0, RES = NEW["grid"]
HR = np.full(NEW["HR"].shape, np.nan, np.float32); KIND = np.zeros(NEW["KIND"].shape, np.uint8); del NEW
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
print("  raster: v28 cells", int(fo.sum()), "total finite", int(np.isfinite(HR).sum()), flush=True)
out = dict(tris=tris, curb=curb, lanes=lanes, raised=raised, HR=HR, KIND=KIND, grid=(GX0, GZ0, RES))
pickle.dump(out, open(f"{W}/roads_final.pkl", "wb"))
print("wrote roads_final.pkl", {k: len(v) // 3 for k, v in tris.items()}, "time", round(time.time() - t0), flush=True)
