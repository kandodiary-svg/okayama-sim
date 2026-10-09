"""v4 統合ビルド: 実線形の軌道・道路(縁石/舗装)・路面標示・航空写真の地面/屋根・推定外壁・
信号機・架線・ホーム を量子化バイナリにし、deflate+base64 テキストで出力する。"""
import os, sys, glob, json, pickle, math, zlib, base64
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
import mapbox_earcut as earcut
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load

OUT = "/home/claude/okaden-x/data"
def _rss():
    """v30: 今のメモリ（MB）。段ごとに表示してどこで増えるかを見る"""
    try: return int([l for l in open("/proc/self/status") if l.startswith("VmRSS")][0].split()[1]) // 1024
    except Exception: return -1
def ground_pred(Hc, dnx, dnz):
    """v30: 走行格子（2m・升目の中心）の高さの予測 = 地面の格子（4m・節点）の高さ（cm）の双線形補間 − 12cm。
    重みは 1/4 単位なので整数だけで計算する（geo_io・app.js で同じ値になる）"""
    nz_, nx_ = Hc.shape; H_ = np.asarray(Hc, np.int64)
    fi4 = 2 * np.arange(dnx) + 1; i0 = np.minimum(fi4 >> 2, nx_ - 2); a = np.minimum(fi4 - 4 * i0, 4)
    fj4 = 2 * np.arange(dnz) + 1; j0 = np.minimum(fj4 >> 2, nz_ - 2); b = np.minimum(fj4 - 4 * j0, 4)
    J = j0[:, None]; I = i0[None, :]; A = a[None, :]; B = b[:, None]
    P16 = (H_[J, I] * (4 - A) + H_[J, I + 1] * A) * (4 - B) + (H_[J + 1, I] * (4 - A) + H_[J + 1, I + 1] * A) * B
    return (P16 + 8) // 16 - 12
def gres_encode(H, Hc):
    """v30: 走行格子の高さを、地面の格子からの予測との差にし、下位・上位バイトの面に分ける（地面の所はほぼ 0 になり、よく縮む）"""
    E = np.asarray(H, np.int64) - ground_pred(Hc, H.shape[1], H.shape[0])
    assert np.abs(E).max() < 32768, "gres_encode: 差が int16 を超える"
    u = E.astype(np.int16).view(np.uint16)
    return (u & 255).astype(np.uint8).tobytes() + (u >> 8).astype(np.uint8).tobytes()
def grad_encode(H):
    """v30: int16 の格子を 2 次元の差分（左＋上−左上 の予測との差）にし、下位バイト・上位バイトの面に分ける（geo_io.grad_decode で戻す）"""
    H = np.asarray(H, np.int32); E = H.copy()
    E[:, 1:] -= H[:, :-1]; E[1:, :] -= H[:-1, :]; E[1:, 1:] += H[:-1, :-1]
    assert np.abs(E).max() < 32768, "grad_encode: 差が int16 を超える"
    u = E.astype(np.int16).view(np.uint16)
    return (u & 255).astype(np.uint8).tobytes() + (u >> 8).astype(np.uint8).tobytes()
os.makedirs(OUT, exist_ok=True)
if not os.environ.get("TRACK_ONLY"):
    # v38: ディレクトリ（outer/）と、別の工程が作るファイル（山陽道 mw.*・外側の地形 outer*）は消さない
    for f in glob.glob(OUT + "/*"):
        if os.path.isdir(f) or os.path.basename(f) in ("mw.json", "mw.bin", "outer.json", "outer_h.bin"): continue
        os.remove(f)

# v30: 道路の高さ・区分のラスタ（0.5m）はファイルのまま読む（範囲拡大で大きい。common.load_roads）
from common import load_roads, road_parts, PartsIndex, BX1 as _BX1, BZ1 as _BZ1
R = load_roads("/home/claude/wx/roads_final.pkl", "r")
# v41.20: 道路のトンネル（tunnels.py）。路面・壁・天井・走行格子の床・地面を下げる範囲
import tunnels as TUN
TUNNELS = pickle.load(open("/home/claude/wx/tunnels.pkl", "rb")) if os.path.exists("/home/claude/wx/tunnels.pkl") else []
print("tunnels", len(TUNNELS), [t["id"] for t in TUNNELS], flush=True)
T = pickle.load(open("/home/claude/wx/tracks.pkl", "rb"))
M = pickle.load(open("/home/claude/wx/markings_v13.pkl" if os.path.exists("/home/claude/wx/markings_v13.pkl") else "/home/claude/wx/markings.pkl", "rb"))
# v29: v28 の格子の端（最後の DEM 節点より外）の標示は、道路面の直し（merge_roads.py）と同じだけ高さを動かす
if os.path.exists("/home/claude/wx/dem_grid_core.npz"):
    _dO = np.load("/home/claude/wx/dem_grid_core.npz"); _nx0, _nz0 = float(_dO["x0"]), float(_dO["z0"])
    _nx1 = _nx0 + (_dO["H"].shape[1] - 1) * 4.0; _nz1 = _nz0 + (_dO["H"].shape[0] - 1) * 4.0
    def _demf(d, x, z):
        X0_, Z0_, S_ = float(d["x0"]), float(d["z0"]), float(d["step"]); A_ = d["H"].astype(np.float64)
        fx = (np.asarray(x) - X0_) / S_; fz = (np.asarray(z) - Z0_) / S_
        i0 = np.clip(np.floor(fx).astype(int), 0, A_.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, A_.shape[0] - 2)
        tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
        return (A_[j0, i0] * (1 - tx) + A_[j0, i0 + 1] * tx) * (1 - tz) + (A_[j0 + 1, i0] * (1 - tx) + A_[j0 + 1, i0 + 1] * tx) * tz
    _dN = np.load("/home/claude/wx/dem_grid.npz")
    for _k in ("white", "yellow"):
        _m = np.asarray(M[_k], np.float64)
        if not len(_m): continue
        _o = (_m[:, 0] > _nx1) | (_m[:, 2] > _nz1) | (_m[:, 0] < _nx0) | (_m[:, 2] < _nz0)
        if _o.any():
            _m = _m.copy(); _m[_o, 1] += _demf(_dN, _m[_o, 0], _m[_o, 2]) - _demf(_dO, _m[_o, 0], _m[_o, 2]); M[_k] = _m
            print("markings edge fix", _k, int(_o.sum()), flush=True)
# v41.20: 新しい高架に差し替えた領域（merge_roads.py の core_replace.pkl）の v28 の標示（地面に貼り付いた高さ）は捨てる
if os.path.exists("/home/claude/wx/core_replace.pkl"):
    import shapely as _shp
    _RC = _shp.from_wkb(pickle.load(open("/home/claude/wx/core_replace.pkl", "rb")))
    for _k in ("white", "yellow"):
        _m = np.asarray(M[_k], np.float64)
        if not len(_m): continue
        _c = _m.reshape(-1, 3, 3).mean(1); _in = _shp.contains_xy(_RC, _c[:, 0], _c[:, 2])
        if _in.any(): M[_k] = _m.reshape(-1, 3, 3)[~_in].reshape(-1, 3); print("markings: v28 markings dropped in replaced viaducts", _k, int(_in.sum()), flush=True)
# v29: 範囲拡大で道路の増えた所の標示（markings.py MARK_EXT=1）
if os.path.exists("/home/claude/wx/markings_ext.pkl") and not os.environ.get("NO_MARK_EXT"):
    _ME = pickle.load(open("/home/claude/wx/markings_ext.pkl", "rb"))
    for _k in ("white", "yellow"):
        if len(_ME.get(_k, [])): M[_k] = np.concatenate([M[_k], _ME[_k]]) if len(M[_k]) else _ME[_k]
    print("markings ext", {k: len(v) // 3 for k, v in _ME.items()}, flush=True)
# ---- v11: OSM で細切れ（橋の前後など）になっている本線の線路を、向きの揃う端点どうしでつないで1本にする ----
# （整形・平滑化が区切りごとに元の位置へ戻って、橋の前後で線路が S 字に折れていたため）
def _merge_tracks(tracks):
    main = [t for t in tracks if t["service"] not in ("yard", "crossover", "station")]
    rest = [t for t in tracks if t["service"] in ("yard", "crossover", "station")]
    L = [t["xyz"].copy() for t in main]
    while True:
        best = None
        for i in range(len(L)):
            A = L[i]
            if len(A) < 5: continue
            ta = A[-1, [0, 2]] - A[-5, [0, 2]]; ta /= np.linalg.norm(ta) + 1e-9
            for j in range(len(L)):
                if i == j or len(L[j]) < 5: continue
                for rb in (False, True):
                    Bb = L[j][::-1] if rb else L[j]
                    d = float(np.hypot(*(A[-1, [0, 2]] - Bb[0, [0, 2]])))
                    if d > 0.8: continue
                    tb = Bb[4, [0, 2]] - Bb[0, [0, 2]]; tb /= np.linalg.norm(tb) + 1e-9
                    c = float(ta @ tb)
                    if c < 0.95: continue
                    if best is None or c > best[0]: best = (c, i, j, rb)
        if best is None: break
        _, i, j, rb = best
        Bb = L[j][::-1] if rb else L[j]
        L[i] = np.concatenate([L[i], Bb[1:]])
        del L[j]
    out = [dict(xyz=x, service=None, bridge=False) for x in L]
    print("  tracks merged", len(main), "->", len(out), flush=True)
    return out + rest
T["tracks"] = _merge_tracks(T["tracks"])
HR = R["HR"]; GX0, GZ0, RES = R["grid"]
dem = np.load("/home/claude/wx/dem_grid.npz")
DX0, DZ0, DSTEP = float(dem["x0"]), float(dem["z0"]), float(dem["step"]); DH = dem["H"].astype(np.float64)
LUSE = np.load("/home/claude/wx/luse_grid.npz")["C"]
ways, nodes = osm_load()
# v17: ランドマーク（岡山城の石垣は DEM の段差をくっきりさせるので、地面を作る前に）
import landmarks as LMK
_LDEM = LMK.DemRef(DH, DX0, DZ0, DSTEP)
LM_FACE, LM_FUV, LM_CAP = LMK.castle_walls(ways, _LDEM)
_gard = LMK.garden_remove_mask()


def dem_at(x, z):
    fx = (np.asarray(x) - DX0) / DSTEP; fz = (np.asarray(z) - DZ0) / DSTEP
    i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
    tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
    return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz

def surf(x, z):
    i = int((x - GX0) / RES); j = int((z - GZ0) / RES)
    if 0 <= j < HR.shape[0] and 0 <= i < HR.shape[1] and np.isfinite(HR[j, i]): return float(HR[j, i])
    return float(dem_at(x, z))

EXT_PAD_PTS = [(-160.0, -60.0), (10.0, 40.0)]   # v29: 駅前広場の延伸区間（F を使う所）
# 軌道面の高さ: 車道面(KIND==1)の実測高さラスタを、欠測を無視して σ=1.0m で平滑化したもの。
# 線路・軌道敷・走行位置はすべてこの面に載せ、軌道敷の範囲の道路面は切り抜く（重なり＝埋もれの解消）。
from scipy import ndimage
_K = R["KIND"]
# v29: 範囲拡大でラスタが大きい（float64 で全域を 4 枚持つと 5GB を超える）ので、軌道の周り（線路の外接矩形＋300m）だけで計算する。
#      平滑化の半径（σ=2 格子・打ち切り 8 格子）より十分広い余白なので、値は全域で計算した時と同じ
_txz = np.concatenate([t["xyz"][:, [0, 2]] for t in T["tracks"]] + [np.array(EXT_PAD_PTS)])
_fi0 = max(0, int((_txz[:, 0].min() - 300 - GX0) / RES)); _fi1 = min(HR.shape[1], int((_txz[:, 0].max() + 300 - GX0) / RES) + 1)
_fj0 = max(0, int((_txz[:, 1].min() - 300 - GZ0) / RES)); _fj1 = min(HR.shape[0], int((_txz[:, 1].max() + 300 - GZ0) / RES) + 1)
_Kc = _K[_fj0:_fj1, _fi0:_fi1]; _Hc = HR[_fj0:_fj1, _fi0:_fi1]
_lane = np.where((_Kc == 1) & np.isfinite(_Hc), _Hc, 0.0).astype(np.float64)
_w = ((_Kc == 1) & np.isfinite(_Hc)).astype(np.float64)
_num = ndimage.gaussian_filter(_lane, 2.0); _den = ndimage.gaussian_filter(_w, 2.0)
FS = np.where(_den > 0.05, _num / np.maximum(_den, 1e-9), np.nan).astype(np.float32)
del _lane, _w, _num, _den, _Kc, _Hc
FS_X0 = GX0 + _fi0 * RES; FS_Z0 = GZ0 + _fj0 * RES
print("  track surface raster", FS.shape, "origin", FS_X0, FS_Z0, flush=True)
def F(x, z):
    fx = (x - FS_X0) / RES - 0.5; fz = (z - FS_Z0) / RES - 0.5
    i0 = int(np.floor(fx)); j0 = int(np.floor(fz)); tx = fx - i0; tz = fz - j0
    if 0 <= j0 < FS.shape[0] - 1 and 0 <= i0 < FS.shape[1] - 1:
        blk = FS[j0:j0 + 2, i0:i0 + 2]
        if np.isfinite(blk).all():
            return float((blk[0, 0] * (1 - tx) + blk[0, 1] * tx) * (1 - tz) + (blk[1, 0] * (1 - tx) + blk[1, 1] * tx) * tz)
        if np.isfinite(blk).any():
            return float(np.nanmean(blk))
    return float(dem_at(x, z)) + 0.04
# ---- 駅前広場延伸区間の縦断: 既存の車道(2.78m)から広場(≒3.6m)へ 1.3% 程度の一様な勾配でつなぐ ----
# （広場内は車道面データが無く DEM に切り替わるため、そのままでは段差・盛り上がりが出る）
import ext_station as _EXTH
from scipy.interpolate import PchipInterpolator as _Pchip
_F0 = F
_EC = _EXTH.C; _EA = _EXTH.ARC
_hj = _F0(float(_EC[0, 0]) + 3.0, float(_EC[0, 1]))
_HEXT = _Pchip([0.0, 10.0, 66.0, 112.0, 140.0], [_hj, _hj, 3.55, 3.80, 3.85])
def ext_w(x, z):
    """延伸区間の縦断を使う重み(0..1)と、その位置の縦断高さ"""
    if x > -2.0 or x < -140 or z < -45 or z > 30: return 0.0, 0.0
    d2 = (_EC[:, 0] - x) ** 2 + (_EC[:, 1] - z) ** 2; k = int(np.argmin(d2)); d = math.sqrt(d2[k])
    sv = float(_EA[k])
    if sv < 0.6 and x > _EC[0, 0]: sv = 0.0
    w = float(np.clip((16.0 - d) / 6.0, 0, 1)) * float(np.clip((x - 0.0) / -6.0, 0, 1) if x > -6.0 else 1.0)
    return w, float(_HEXT(sv))
def F(x, z):
    w, h = ext_w(x, z)
    if w <= 0: return _F0(x, z)
    return _F0(x, z) * (1 - w) + h * w if w < 1 else h
def restamp(xyz):
    y = np.array([F(x, z) for x, _, z in xyz])
    # 進行方向に 3m 程度で軽くならす（縦断の細かな凹凸を除く）
    y = ndimage.gaussian_filter1d(y, 2.0, mode="nearest")
    out = xyz.copy(); out[:, 1] = y + 0.01
    return out
# ---- 岡山駅前広場への乗り入れ（2027年3月開業予定・新停留場 2面3線） ----
import ext_station as EXT
EXTD = EXT.build()
for tr_ in EXTD["tracks"]:
    xy = tr_["xy"]; T["tracks"].append(dict(xyz=np.stack([xy[:, 0], np.zeros(len(xy)), xy[:, 1]], 1), service="station", bridge=False))
for key, r in T["routes"].items():
    if key.endswith("_r"):
        # 逆方向: 現電停の終端から到着線(3番線)を通って新停留場へ。車両先頭はホームの西端(進行方向側)
        m_ = (EXT.ARC > 0.3) & (EXT.ARC <= EXT.S_STOP1 - 1.0)
        suf = EXT.C[m_] + EXT.NORTH[m_] * np.array([EXT.off_S(sv) for sv in EXT.ARC[m_]])[:, None]
        suf3 = np.stack([suf[:, 0], np.full(len(suf), r["xyz"][-1, 1]), suf[:, 1]], 1)
        r["xyz"] = np.concatenate([r["xyz"], suf3])
        seg_ = np.hypot(*np.diff(r["xyz"][:, [0, 2]], axis=0).T); r["arc"] = np.concatenate([[0], np.cumsum(seg_)])
        r["speed"] = np.concatenate([r["speed"], np.full(len(suf3), 15.0)])
        r["stops"] = r["stops"][:-1] + [dict(name="岡山駅前", arc=float(r["arc"][-1]), osm=False, new=True)]
        print("  station extension", key, "arrival suffix", round(float(np.sum(np.hypot(*np.diff(suf, axis=0).T))), 1), "m", flush=True)
        continue
    offf = EXT.off_N if key == "higashi" else EXT.off_T1      # 東山=2番線, 清輝橋=1番線
    pre = EXT.departure_prefix(offf, EXT.S_STOP0 + 2.0)
    pre3 = np.stack([pre[:, 0], np.zeros(len(pre)), pre[:, 1]], 1)
    Lp = float(np.sum(np.hypot(*np.diff(pre, axis=0).T)))
    # 接続点の重複を避ける
    r["xyz"] = np.concatenate([pre3[:-1], r["xyz"]])
    seg_ = np.hypot(*np.diff(r["xyz"][:, [0, 2]], axis=0).T); r["arc"] = np.concatenate([[0], np.cumsum(seg_)])
    r["speed"] = np.concatenate([np.full(len(pre3) - 1, 15.0), r["speed"]])
    old_first = r["stops"][0]
    r["stops"] = [dict(name="岡山駅前", arc=0.0, osm=False, new=True)] + [dict(st, arc=st["arc"] + Lp) for st in r["stops"][1:]]
    r["signals"] = [dict(g, stop=g["stop"] + Lp, center=g["center"] + Lp) for g in r["signals"]]
    r["prefix_len"] = Lp
    print("  station extension", key, "prefix", round(Lp, 1), "m (old 岡山駅前 at", round(old_first["arc"] + Lp, 1), "m is passed)", flush=True)
# 反対線の整形: OSM の線路は上下線の間隔が 2.5〜6m と揺れるため、走行線からの横距離を
# 沿線方向に平滑化し(約60m)、最小 3.3m を確保して並行させる（どちら側か・概ねの間隔は OSM のまま）
from shapely.geometry import LineString as _LS, Point as _P
from scipy.spatial import cKDTree as _KD0
_rlines = [_LS(r["xyz"][:, [0, 2]]) for k_, r in T["routes"].items() if not k_.endswith("_r")]
_TRK0 = [(t, t["xyz"][:, [0, 2]].copy()) for t in T["tracks"] if t["service"] not in ("yard",)]
def _frame(ln, sv):
    a = ln.interpolate(max(0, sv - 1.5)); b = ln.interpolate(min(ln.length, sv + 1.5)); c = ln.interpolate(sv)
    t_ = np.array([b.x - a.x, b.y - a.y]); t_ /= np.linalg.norm(t_) + 1e-9
    return np.array([c.x, c.y]), np.array([t_[1], -t_[0]])
_n_reg = 0
_REGD = []
for t in T["tracks"]:
    if t["service"] in ("yard", "crossover", "station"): continue
    P = t["xyz"][:, [0, 2]].copy(); n = len(P)
    base = np.zeros((n, 2)); nor = np.zeros((n, 2)); off = np.full(n, np.nan)
    for k in range(n):
        q = _P(*P[k]); ln = min(_rlines, key=lambda L: L.distance(q))
        c, nv = _frame(ln, ln.project(q)); d = float(np.dot(P[k] - c, nv))
        base[k] = c; nor[k] = nv
        # 自線の接線と走行線の接線が平行（±6°）な区間だけを整形の対象にする（分岐・曲線部は OSM 形状のまま）
        tk = P[min(n - 1, k + 2)] - P[max(0, k - 2)]; tk = tk / (np.linalg.norm(tk) + 1e-9)
        par = abs(tk[0] * nv[1] - tk[1] * nv[0]) > 0.9945
        if 1.5 < abs(d) < 8.0 and par: off[k] = d
    ok = np.isfinite(off)
    if ok.sum() < 10: continue
    sgn = np.sign(np.nanmedian(off))
    mag = np.where(ok, np.abs(off), np.nan)
    # 移動中央値→ガウス平滑
    med = np.array([np.nanmedian(mag[max(0, k - 30):k + 31]) if np.isfinite(mag[max(0, k - 30):k + 31]).any() else np.nan for k in range(n)])
    med = np.where(np.isfinite(med), med, np.nanmedian(mag))
    med = np.maximum(ndimage.gaussian_filter1d(med, 10.0, mode="nearest"), 3.3)
    newP = base + nor * (sgn * med)[:, None]
    w = ok.astype(float)
    # 非対象点から 12m 以内は重みを下げる（整形区間と原形区間を滑らかにつなぐ）
    dist_bad = ndimage.distance_transform_edt(ok)
    w = np.clip((dist_bad - 2.0) / 12.0, 0, 1)
    w = w * w * (3 - 2 * w)
    # 端が他の線路（分岐）につながっている場合だけ、端を元の位置に戻す（行き止まり＝終端の電停は整形する）
    _oth = np.concatenate([u["xyz"][:, [0, 2]] for u in T["tracks"] if u is not t and u["service"] not in ("yard", "crossover")])
    _con = lambda q: float(np.min(np.hypot(*(_oth - q).T))) < 2.0
    r0 = np.clip(np.arange(n) / 20.0, 0, 1) if _con(P[0]) else np.ones(n)
    r1 = np.clip(np.arange(n)[::-1] / 20.0, 0, 1) if _con(P[-1]) else np.ones(n)
    w = w * np.minimum(r0, r1)
    P2 = P * (1 - w[:, None]) + newP * w[:, None]

    t["xyz"] = np.stack([P2[:, 0], t["xyz"][:, 1], P2[:, 1]], 1)
    _REGD.append((P.copy(), P2.copy()))
    _n_reg += 1
print("opposite tracks regularized", _n_reg, flush=True)
# 引上線・渡り線など、動かした本線の端につながる線路も同じだけずらす（つながりを保つ）
if _REGD:
    _O = np.concatenate([o for o, n2 in _REGD]); _N = np.concatenate([n2 for o, n2 in _REGD]); _ok = _KD0(_O)
    for t in T["tracks"]:
        if t["service"] not in ("yard", "crossover"): continue
        P = t["xyz"][:, [0, 2]].copy(); n = len(P); D = np.zeros_like(P)
        s_ = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
        for end, sd in ((0, s_), (n - 1, s_[-1] - s_)):
            dd, ii = _ok.query(P[end])
            if dd < 1.0:
                dv = _N[ii] - _O[ii]
                wgt = np.clip(1 - sd / 25.0, 0, 1); wgt = wgt * wgt * (3 - 2 * wgt)
                D += wgt[:, None] * dv[None, :]
        if np.abs(D).max() > 0.01:
            t["xyz"] = np.stack([P[:, 0] + D[:, 0], t["xyz"][:, 1], P[:, 1] + D[:, 1]], 1)
# 逆方向の走行線を、整形後の線路へ合わせる（最寄りの元線路点の移動量をそのまま与える）
from scipy.spatial import cKDTree as _KD
_P0 = np.concatenate([p0 for t, p0 in _TRK0]); _P1 = np.concatenate([t["xyz"][:, [0, 2]] for t, p0 in _TRK0])
_kd = _KD(_P0)
for key, r in T["routes"].items():
    if not key.endswith("_r"): continue
    P = r["xyz"][:, [0, 2]]; dd, ii = _kd.query(P)
    D = np.where((dd < 1.5)[:, None], _P1[ii] - _P0[ii], 0.0)
    D = ndimage.gaussian_filter1d(D, 3.0, axis=0, mode="nearest")
    r["xyz"] = np.stack([P[:, 0] + D[:, 0], r["xyz"][:, 1], P[:, 1] + D[:, 1]], 1)
    seg_ = np.hypot(*np.diff(r["xyz"][:, [0, 2]], axis=0).T); newarc = np.concatenate([[0], np.cumsum(seg_)])
    remap = lambda a: float(np.interp(a, r["arc"], newarc))
    r["stops"] = [dict(st, arc=remap(st["arc"])) for st in r["stops"]]
    r["signals"] = [dict(g, stop=remap(g["stop"]), center=remap(g["center"])) for g in r["signals"]]
    r["arc"] = newarc
    print("  reverse route snapped", key, "max shift", round(float(np.abs(D).max()), 2), flush=True)
# 電停（島式ホーム）の区間は、車両がホームに当たらないよう線路をホームから 1.32m（軌道中心〜ホーム縁）まで離す。
# OSM では上下線の間隔がホーム幅に対して狭いため。ホーム端から 25m で元の線形へ滑らかに戻す。
_PLS = []
for p in T["platforms"]:
    if p.get("bigroof"): continue
    Pp = Polygon(p["xy"]).buffer(0); rr = np.array(Pp.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr[1] - rr[0]; e2 = rr[2] - rr[1]
    u = e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2; hl = np.linalg.norm(u) / 2; u = u / (2 * hl)
    hw = min(np.linalg.norm(e1), np.linalg.norm(e2)) / 2
    _c = np.array(Pp.centroid.coords[0]); _v = np.array([-u[1], u[0]])
    # 島式（両側に線路がある）ホームだけ線路を押し広げる。片側だけのホーム（相対式・終端）はホーム側を切って幅を確保する
    _allp = np.concatenate([t["xyz"][:, [0, 2]] for t in T["tracks"] if t["service"] not in ("yard",)])
    _d = _allp - _c; _al = _d @ u; _la = _d @ _v; _m = (np.abs(_al) < hl) & (np.abs(_la) < 7.0)
    if not (_m.any() and (_la[_m] < -0.5).any() and (_la[_m] > 0.5).any()): continue
    _PLS.append((_c, u, _v, hl, hw, Pp))
def plat_push(P):
    """点列 P(N,2) をホームから離す変位"""
    D = np.zeros_like(P)
    Tg = np.gradient(P, axis=0); Tg /= np.linalg.norm(Tg, axis=1)[:, None] + 1e-9
    for c, u, v, hl, hw, Pp in _PLS:
        d = P - c; al = d @ u; la = d @ v
        par = np.clip((np.abs(Tg @ u) - 0.97) / 0.02, 0, 1)          # ホームと平行な線路だけ（分岐曲線は動かさない）
        near = (np.abs(la) < hw + 2.6) & (np.abs(al) < hl + 30)
        dist = np.full(len(P), 9.0)
        # ホーム縁までの横距離（ホーム端より先は、端の断面での横距離）
        for k in np.nonzero(near)[0]:
            q = c + u * np.clip(al[k], -hl + 0.3, hl - 0.3) + v * la[k]
            dist[k] = Pp.distance(Point(*q)) if not Pp.contains(Point(*q)) else 0.0
        need = np.clip(1.32 - dist, 0, 0.8) * near * par
        t = np.clip((np.abs(al) - (hl + 2.0)) / 25.0, 0, 1); wl = 1 - t * t * (3 - 2 * t)
        sh = np.sign(la) * need * wl
        cur = D @ v
        D += v[None, :] * (np.where(np.abs(sh) > np.abs(cur), sh - cur, 0.0))[:, None]
    return D
_npush = 0
for t in T["tracks"]:
    if t["service"] in ("yard", "station"): continue
    P = t["xyz"][:, [0, 2]]; D = plat_push(P)
    if np.abs(D).max() > 0.01: _npush += 1
    t["xyz"] = np.stack([P[:, 0] + D[:, 0], t["xyz"][:, 1], P[:, 1] + D[:, 1]], 1)
for key, r in T["routes"].items():
    P = r["xyz"][:, [0, 2]]; D = plat_push(P)
    r["xyz"] = np.stack([P[:, 0] + D[:, 0], r["xyz"][:, 1], P[:, 1] + D[:, 1]], 1)
    seg_ = np.hypot(*np.diff(r["xyz"][:, [0, 2]], axis=0).T); newarc = np.concatenate([[0], np.cumsum(seg_)])
    # 距離が僅かに変わるので電停・信号の位置を新しい距離へ写す
    remap = lambda a: float(np.interp(a, r["arc"], newarc))
    r["stops"] = [dict(st, arc=remap(st["arc"])) for st in r["stops"]]
    r["signals"] = [dict(g, stop=remap(g["stop"]), center=remap(g["center"])) for g in r["signals"]]
    r["arc"] = newarc
    print("  platform push", key, "max", round(float(np.abs(D).max()), 2), flush=True)
print("  tracks pushed from platforms", _npush, flush=True)
for t in T["tracks"]:
    t["xyz"] = restamp(t["xyz"])
for key, r in T["routes"].items():
    r["xyz"] = restamp(r["xyz"])
for pl_ in EXTD["platforms"]:
    c_ = np.array(pl_["xy"]).mean(0); T["platforms"].append(dict(pl_, base=F(c_[0], c_[1])))
print("track heights restamped", flush=True)
# ---- v11: 走行線（往復とも）を描画するレールの中心線へ正確に載せる（電車がレールからずれて走らないように） ----
_SN = [t for t in T["tracks"] if t["service"] != "yard"]
_SP = np.concatenate([t["xyz"] for t in _SN]); _ST = np.concatenate([np.gradient(t["xyz"][:, [0, 2]], axis=0) for t in _SN])
_ST /= np.linalg.norm(_ST, axis=1)[:, None] + 1e-9
_SK = _KD(_SP[:, [0, 2]])
for key, r in T["routes"].items():
    P = r["xyz"][:, [0, 2]].copy(); tg = np.gradient(P, axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    Q = P.copy(); moved = np.zeros(len(P))
    for k in range(len(P)):
        best = None
        for h in _SK.query_ball_point(P[k], 1.8):
            if abs(_ST[h] @ tg[k]) < 0.94: continue
            # 線路の点列（1m 間隔）上の最近点へ: 接線方向の成分を除いた横ずれだけ動かす
            dv = _SP[h, [0, 2]] - P[k]; lat = dv - _ST[h] * (dv @ _ST[h])
            dd = float(np.linalg.norm(lat))
            if best is None or dd < best[0]: best = (dd, lat)
        if best is not None: Q[k] = P[k] + best[1]; moved[k] = best[0]
    Q = np.stack([ndimage.gaussian_filter1d(Q[:, 0], 1.0, mode="nearest"), ndimage.gaussian_filter1d(Q[:, 1], 1.0, mode="nearest")], 1)
    r["xyz"] = np.stack([Q[:, 0], r["xyz"][:, 1], Q[:, 1]], 1)
    seg_ = np.hypot(*np.diff(Q, axis=0).T); newarc = np.concatenate([[0], np.cumsum(seg_)])
    remap = lambda a: float(np.interp(a, r["arc"], newarc))
    r["stops"] = [dict(st, arc=remap(st["arc"])) for st in r["stops"]]
    r["signals"] = [dict(g, stop=remap(g["stop"]), center=remap(g["center"])) for g in r["signals"]]
    r["arc"] = newarc
    print("  route snapped to rails", key, "mean shift", round(float(moved.mean()), 3), "max", round(float(moved.max()), 2), flush=True)
if os.environ.get("TRACK_ONLY"):
    pickle.dump(T, open("/home/claude/wx/T_dbg.pkl", "wb")); print("track-only dump"); sys.exit(0)

# ---------------- 出力器 ----------------
manifest = {"chunks": [], "atlas": [], "ortho": [], "facade": {}}
bins = {}
CHUNK = 400.0
# v16: 建物・植生は 800m 四方のタイルごとのファイルに分け、画面側で近くのタイルだけ読み込む
STILE = 800.0
STREAM_KEYS = {"bldg_tex", "bldg_proc", "bldg_plain", "veg", "detail", "road", "cat"}   # v29: 道路・架線柱などもタイルに分ける（範囲拡大）
def tile_of(x, z): return f"{int(math.floor(x / STILE))}_{int(math.floor(z / STILE))}"
def add_chunk(layer, pos, uv=None, col=None, mat="color", page=None, file_key=None, uv_int=False, nrm=None):
    if pos is None or len(pos) == 0: return
    # v29: 範囲拡大でメモリが足りなくなるので、全体を float64 にせず、区画（400m）ごとに取り出してから float64 にする（値は同じ）
    pos = np.asarray(pos).reshape(-1, 3, 3)
    cen = pos.astype(np.float64).mean(axis=1) if pos.dtype != np.float64 else pos.mean(axis=1)
    keys = np.floor(cen[:, 0] / CHUNK).astype(int) * 1000 + np.floor(cen[:, 2] / CHUNK).astype(int)
    del cen
    uv3 = None if uv is None else np.asarray(uv).reshape(-1, 3, 2)
    col3 = None if col is None else np.asarray(col).reshape(-1, 3, 3)
    nrm3 = None if nrm is None else np.asarray(nrm).reshape(-1, 3, 3)
    for k in np.unique(keys):
        m = keys == k
        p = pos[m].reshape(-1, 3).astype(np.float64)
        n_tri = len(p) // 3
        for s in range(0, n_tri, 21000):
            e = min(n_tri, s + 21000)
            pp = p[s * 3:e * 3]
            mn = pp.min(0); mx = pp.max(0); origin = (mn + mx) / 2
            scale = max((mx - mn).max() / 2 / 32000.0, 1e-4)
            q = np.round((pp - origin) / scale).astype(np.int16)
            fk = file_key or layer
            if fk in STREAM_KEYS:
                cx_, cz_ = float(pp[:, 0].mean()), float(pp[:, 2].mean())
                tl_ = _FORCE_TILE or tile_of(cx_, cz_); fk = fk + "@" + tl_
                tx_, tz_ = [int(v) for v in tl_.split("_")]
                manifest.setdefault("tiles", {}).setdefault(tl_, dict(x0=tx_ * STILE, z0=tz_ * STILE, size=STILE))
            buf = bins.setdefault(fk, bytearray())
            entry = dict(layer=layer, mat=mat, file=fk, count=len(pp), origin=[round(float(v), 3) for v in origin], scale=float(scale))
            def put(arr):
                off = len(buf); buf.extend(arr.tobytes())
                while len(buf) % 4: buf.append(0)
                return off
            entry["pos"] = put(q)
            if uv3 is not None:
                u = uv3[m].reshape(-1, 2)[s * 3:e * 3].astype(np.float64)
                if uv_int: entry["uvi"] = put(np.clip(np.round(u * 100), -32767, 32767).astype(np.int16))
                else: entry["uv"] = put(np.round(np.clip(u, 0, 1) * 65535).astype(np.uint16))
            if col3 is not None:
                c = col3[m].reshape(-1, 3)[s * 3:e * 3].astype(np.float64)
                entry["col"] = put(np.concatenate([np.clip(c * 255, 0, 255), np.full((len(c), 1), 255)], 1).astype(np.uint8))
            if nrm3 is not None:
                nn = nrm3[m].reshape(-1, 3)[s * 3:e * 3].astype(np.float64)
                entry["nrm"] = put(np.concatenate([np.clip(np.round(nn * 127), -127, 127), np.zeros((len(nn), 1))], 1).astype(np.int8))
            if page is not None: entry["page"] = page
            manifest["chunks"].append(entry)

def add_chunk_tile(layer, pos, tile=None, **kw):
    """タイルを指定して add_chunk（アトラスのページとタイルを一致させるため）"""
    global _FORCE_TILE
    _FORCE_TILE = tile
    try: add_chunk(layer, pos, **kw)
    finally: _FORCE_TILE = None
_FORCE_TILE = None
def tri_colors(n, rgb, jitter=0.0, seed=0):
    c = np.repeat(np.asarray(rgb, float)[None, :], n, 0)
    if jitter: c = c * np.random.default_rng(seed).uniform(1 - jitter, 1 + jitter, (n, 1))
    return np.repeat(c, 3, 0)

def tri_poly(poly, hfun, lift=0.0):
    out = []
    for q in (poly.geoms if hasattr(poly, "geoms") else [poly]):
        if not isinstance(q, Polygon) or q.area < 1e-3: continue
        rings = [np.array(q.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in q.interiors]
        rings = [r for r in rings if len(r) >= 3]
        v = np.concatenate(rings); ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        idx = np.asarray(earcut.triangulate_float64(v, ends)).reshape(-1, 3)
        if len(idx) == 0: continue
        a, b, c = v[idx[:, 0]], v[idx[:, 1]], v[idx[:, 2]]
        cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        idx[cr > 0] = idx[cr > 0][:, [0, 2, 1]]
        xz = v[idx.reshape(-1)]
        y = np.array([hfun(x, z) for x, z in xz]) + lift
        out.append(np.stack([xz[:, 0], y, xz[:, 1]], 1))
    return np.concatenate(out) if out else np.zeros((0, 3))

def extrude_ring(ring, y0f, y1f):
    """多角形外周の側面(外向き)"""
    c = np.array(ring.coords); out = []
    for a, b in zip(c[:-1], c[1:]):
        ya0, yb0 = y0f(*a), y0f(*b); ya1, yb1 = y1f(*a), y1f(*b)
        A0 = [a[0], ya0, a[1]]; B0 = [b[0], yb0, b[1]]; A1 = [a[0], ya1, a[1]]; B1 = [b[0], yb1, b[1]]
        out.append([A0, B0, A1, A1, B0, B1, A0, A1, B0, B0, A1, B1])
    return np.array(out).reshape(-1, 3) if out else np.zeros((0, 3))

def cyl(c, r, y0, y1, n=8):
    return extrude_ring(Point(*c).buffer(r, max(2, n // 4)).exterior, lambda x, z: y0, lambda x, z: y1)
def beam(a, b, y, w=0.12, h=0.12):
    ln = LineString([a, b]).buffer(w / 2, cap_style=2)
    return np.concatenate([tri_poly(ln, lambda x, z: y + h), extrude_ring(ln.exterior, lambda x, z: y, lambda x, z: y + h)])

# ================= 1) 航空写真（地面・屋根用） =================
print("ortho pages...", flush=True); print("  [rss MB]", _rss(), flush=True)
O = np.load("/home/claude/wx/ortho/ortho_local.npy", mmap_mode="r")
from common import BX0 as _BX0, BZ0 as _BZ0
OX0, OZ0, ORES = _BX0, _BZ0, 0.5   # v29: 航空写真の格子の原点 = データ範囲の北西の角
PAGE = 2048
nz, nx = DH.shape
track_lines = [LineString(t["xyz"][:, [0, 2]]) for t in T["tracks"]]
TRACKS = unary_union(track_lines)
# v16: データ範囲（25 区画）全体を地面・航空写真の範囲にする（以前は軌道から 520m）
corr = shapely.box(DX0 + 2, DZ0 + 2, DX0 + nx * DSTEP - 2, DZ0 + nz * DSTEP - 2)
pages = []
for r in range(int(math.ceil(O.shape[0] / PAGE))):
    for c in range(int(math.ceil(O.shape[1] / PAGE))):
        x0 = OX0 + c * PAGE * ORES; z0 = OZ0 + r * PAGE * ORES
        bx = shapely.box(x0, z0, x0 + PAGE * ORES, z0 + PAGE * ORES)
        if not bx.intersects(corr): continue
        sub = np.array(O[r * PAGE:(r + 1) * PAGE, c * PAGE:(c + 1) * PAGE])
        img = np.full((PAGE, PAGE, 3), 110, np.uint8); img[:sub.shape[0], :sub.shape[1]] = sub
        fn = f"ortho_{r}_{c}.jpg"
        Image.fromarray(img).save(os.path.join(OUT, fn), quality=80, optimize=True)
        pages.append(dict(file=fn, x0=x0, z0=z0, size=PAGE * ORES))
manifest["ortho"] = pages
print("  pages", len(pages), flush=True)
# v29: 範囲全体の縮小写真（2m/画素）。遠くの地面と、写真のページを読み込む前の屋根に使う（ページは近くだけ読み込む）
_OVS = 4
_ovh, _ovw = O.shape[0] // _OVS, O.shape[1] // _OVS
_ov = np.zeros((_ovh, _ovw, 3), np.uint8)
for _r0 in range(0, _ovh, 256):
    _r1 = min(_ovh, _r0 + 256)
    _blk = np.asarray(O[_r0 * _OVS:_r1 * _OVS, :_ovw * _OVS], np.float32)
    _ov[_r0:_r1] = np.clip(_blk.reshape(_r1 - _r0, _OVS, _ovw, _OVS, 3).mean((1, 3)) + 0.5, 0, 255).astype(np.uint8)
Image.fromarray(_ov).save(os.path.join(OUT, "ortho_ov.jpg"), quality=86, optimize=True)
manifest["ortho_ov"] = dict(file="ortho_ov.jpg", x0=OX0, z0=OZ0, w=_ovw * _OVS * ORES, d=_ovh * _OVS * ORES)
print("  overview", _ov.shape, "MB", round(os.path.getsize(os.path.join(OUT, "ortho_ov.jpg")) / 1e6, 2), flush=True)
del _ov, _blk
def page_of(x, z):
    for i, p in enumerate(pages):
        if p["x0"] <= x < p["x0"] + p["size"] and p["z0"] <= z < p["z0"] + p["size"]: return i
    return None
# v29: 多数の点をまとめて（ページは OX0, OZ0 から 1024m の格子。page_of と同じ結果。無ければ -1）
_PGI = {(int(round((p["x0"] - OX0) / (PAGE * ORES))), int(round((p["z0"] - OZ0) / (PAGE * ORES)))): i for i, p in enumerate(pages)}
def pages_of(x, z):
    cx = np.floor((np.asarray(x, np.float64) - OX0) / (PAGE * ORES)).astype(int); cz = np.floor((np.asarray(z, np.float64) - OZ0) / (PAGE * ORES)).astype(int)
    return np.array([_PGI.get((a, b), -1) for a, b in zip(cx.tolist(), cz.tolist())], int)

TBpoly = shapely.make_valid(unary_union([ln.buffer(1.45, cap_style=2) for ln in track_lines]).buffer(0.9).buffer(-0.9)).buffer(0)
TBpoly = shapely.segmentize(TBpoly, 1.0)
TBp = prep(TBpoly)

# ================= 2) 地面（DEM + 土地利用 マスク） =================
print("ground...", flush=True); print("  [rss MB]", _rss(), flush=True)
# 地面セル: 軌道から520m以内
mask_img = Image.new("L", (nx, nz), 0); dm = ImageDraw.Draw(mask_img)
for g in (corr.geoms if hasattr(corr, "geoms") else [corr]):
    dm.polygon([((x - DX0) / DSTEP, (z - DZ0) / DSTEP) for x, z in g.exterior.coords], fill=255)
Mk = (np.array(mask_img) > 0).astype(np.uint8)
# 道路・歩道の面(0.5m)の最低値より 0.3m 下へ地面を下げる（航空写真の地面が路面に被らないように）
Hg = DH.copy()
HRMIN = np.full(DH.shape, np.inf)
fac = int(round(DSTEP / RES))
# v29: 以前は升目ごとの二重ループ（範囲拡大で遅い）。同じ窓（節点を中心に ±fac/2 の 0.5m 格子）の最小値を
#      minimum_filter でまとめて求め、節点の位置で読む（結果は同じ）
assert abs((DX0 - GX0) / RES - round((DX0 - GX0) / RES)) < 1e-6 and abs((DZ0 - GZ0) / RES - round((DZ0 - GZ0) / RES)) < 1e-6 and fac % 2 == 0
_rj = (np.round((DZ0 - GZ0) / RES).astype(int) + np.arange(nz) * fac); _ci = (np.round((DX0 - GX0) / RES).astype(int) + np.arange(nx) * fac)
_okj = (_rj >= 0) & (_rj < HR.shape[0]); _oki = (_ci >= 0) & (_ci < HR.shape[1])
_sub = np.full((nz, nx), np.inf, np.float32)
# v41.20: トンネルの上の地面を下げる範囲を、道路の高さのラスタ（HR と同じ 0.5m 格子）の升目として持つ。
#   箱（壁・天井）の区間でかぶりが浅い所 = 屋根の上面の高さ、箱でない区間（坑口の近く）= 床の高さ。深い山岳トンネルの山は削らない
_tj, _ti, _tv = [], [], []
for _t in TUNNELS:
    for _poly, _val in ((_t["roof_poly"], "roof"), (_t["floor_only_poly"], "floor")):
        _a, _b, _c = TUN.raster_cells(_t, _poly, GX0, GZ0, RES, HR.shape[1], HR.shape[0], _val)
        _tj.append(_a); _ti.append(_b); _tv.append(_c)
if _tj:
    _tj = np.concatenate(_tj); _ti = np.concatenate(_ti); _tv = np.concatenate(_tv)
    _o = np.argsort(_tj, kind="stable"); _tj, _ti, _tv = _tj[_o], _ti[_o], _tv[_o]
else:
    _tj = np.zeros(0, np.int64); _ti = np.zeros(0, np.int64); _tv = np.zeros(0)
print("  tunnel terrain cells", len(_tj), flush=True)
def _paint_tun(h, r0):
    """行 r0 から始まる HR の帯 h（float32 のコピー）に、トンネルの升目を（HR が無い所だけでなく）低い方の値で入れる"""
    if not len(_tj): return h
    a = np.searchsorted(_tj, r0); b = np.searchsorted(_tj, r0 + h.shape[0])
    if b > a:
        jj = _tj[a:b] - r0; ii = _ti[a:b]; cur = h[jj, ii]
        h[jj, ii] = np.where(np.isfinite(cur), np.minimum(cur, _tv[a:b]), _tv[a:b]).astype(np.float32)
    return h
# v30: 0.5m のラスタ全体を一度に持たず、節点の行 64 本ずつ（上下に窓の半分の余白）で求める（結果は全体で求めた時と同じ）
# v32: 窓を ±2m → ±4m（地面の 4m 格子の 1 升）に。地面の三角形のどの頂点も、その三角形に重なる道路の点の高さより下になる
#      （斜面で地面の三角形が道路の縁にかぶり、縁がギザギザに埋もれていた）
_hw = int(os.environ.get("HRMIN_HW", str(fac)))
_jl = np.nonzero(_okj)[0]
for _b0 in range(0, len(_jl), 64):
    _js = _jl[_b0:_b0 + 64]; _r0 = int(_rj[_js[0]]) - _hw; _r1 = int(_rj[_js[-1]]) + _hw + 1
    _blk = np.full((_r1 - _r0, HR.shape[1]), np.inf, np.float32)
    _a0, _a1 = max(0, _r0), min(HR.shape[0], _r1)
    _h = _paint_tun(np.array(HR[_a0:_a1], np.float32), _a0); _blk[_a0 - _r0:_a1 - _r0] = np.where(np.isfinite(_h), _h, np.inf); del _h
    _mf = ndimage.minimum_filter(_blk, size=2 * _hw + 1, mode="constant", cval=np.inf)
    _sub[np.ix_(_js, np.nonzero(_oki)[0])] = _mf[np.ix_(_rj[_js] - _r0, _ci[_oki])]
    del _blk, _mf
Hg_orig = Hg.copy()   # v32: 下げる前の地形（切土の法面の上端に使う）
_fin = np.isfinite(_sub)
HRMIN[_fin] = _sub[_fin].astype(np.float64)
Hg[_fin] = np.minimum(Hg[_fin], HRMIN[_fin] - 0.08)
del _sub, _fin
# v32: 道路の外側 12m までの地面は、道路（一番近い道路の升目）から 1:1 の勾配より高くしない（切土の法面。
#      structures.cut_faces が道路の縁から同じ勾配の面を描くので、その下に地面が隠れる。4m 格子のギザギザが見えない）
CUT_S = 1.0; _MG = 26
_cap = np.full((nz, nx), np.inf)
for _b0 in range(0, len(_jl), 64):
    _js = _jl[_b0:_b0 + 64]; _r0 = max(0, int(_rj[_js[0]]) - _MG); _r1 = min(HR.shape[0], int(_rj[_js[-1]]) + _MG + 1)
    _h = _paint_tun(np.array(HR[_r0:_r1], np.float32), _r0); _nr = ~np.isfinite(_h)
    if _nr.all(): continue
    _dd, (_ji, _ii) = ndimage.distance_transform_edt(_nr, return_indices=True)
    _cols = np.nonzero(_oki)[0]; _rr = _rj[_js] - _r0; _cc = _ci[_oki]
    _d = _dd[np.ix_(_rr, _cc)] * RES; _hn = _h[_ji[np.ix_(_rr, _cc)], _ii[np.ix_(_rr, _cc)]]
    _cap[np.ix_(_js, _cols)] = np.where(_d <= 12.0, _hn - 0.08 + CUT_S * np.maximum(0.0, _d - 0.5), np.inf)
    del _h, _nr, _dd, _ji, _ii, _d, _hn
Hg = np.minimum(Hg, _cap); print("  cut-slope cap nodes", int((_cap < Hg_orig - 0.01).sum()), flush=True); del _cap
_tb_img = Image.new("L", (nx, nz), 0); _d = ImageDraw.Draw(_tb_img)
for _g in (TBpoly.buffer(4.5).geoms if hasattr(TBpoly.buffer(4.5), "geoms") else [TBpoly.buffer(4.5)]):
    _d.polygon([((x - DX0) / DSTEP, (z - DZ0) / DSTEP) for x, z in _g.exterior.coords], fill=255)
# 広場の延伸区間周り: 地面・路面を軌道の縦断へ同じ量だけ移す（段差を作らない）
def ext_target(x, z, y, off=-0.03):
    """延伸区間の周り: 地面・路面を軌道面(芝生軌道と同じ高さ)へなじませる"""
    w, h = ext_w(x, z)
    return y if w <= 0 else y * (1 - w) + (h + off) * w
def ext_delta(x, z):
    w, h = ext_w(x, z)
    return 0.0 if w <= 0 else w * (h - _F0(x, z))
_surf0 = surf
def surf(x, z):
    return _surf0(x, z) + (ext_delta(x, z) if -145 < x < 0 else 0.0)
for j in range(nz):
    zc = DZ0 + j * DSTEP
    if zc < -50 or zc > 35: continue
    for i in range(nx):
        xc = DX0 + i * DSTEP
        if -145 < xc < 0: Hg[j, i] += ext_delta(xc, zc)
for j, i in zip(*np.nonzero(np.array(_tb_img) > 0)):
    Hg[j, i] = min(Hg[j, i], F(DX0 + i * DSTEP, DZ0 + j * DSTEP) - 0.15)
for j in range(nz):
    zc = DZ0 + j * DSTEP
    if zc < -50 or zc > 35: continue
    for i in range(nx):
        xc = DX0 + i * DSTEP
        if -145 < xc < -6: Hg[j, i] = ext_target(xc, zc, Hg[j, i], -0.06)
# ---- v11: 川・池の水面（OSM の水域＋PLATEAU 土地利用の水面）。水位は水域内の DEM を平滑化、川底は水位の 1.2m 下 ----
from common import proj as _proj
from shapely.ops import linemerge as _lm, polygonize as _pz
_EX = json.load(open("/home/claude/wx/osm/extra.json"))
_wp = []; BRIDGES = []
for e in _EX["elements"]:
    t_ = e.get("tags", {})
    if e["type"] == "way" and "geometry" in e and len(e["geometry"]) > 3:
        xy_ = [_proj(g["lat"], g["lon"]) for g in e["geometry"]]
        if t_.get("natural") == "water": _wp.append(Polygon(xy_).buffer(0))
        if t_.get("man_made") == "bridge": BRIDGES.append((t_.get("name"), Polygon(xy_).buffer(0)))
    if e["type"] == "relation" and t_.get("natural") == "water":
        ol = [LineString([_proj(g["lat"], g["lon"]) for g in m["geometry"]]) for m in e.get("members", []) if m.get("geometry") and m.get("role") == "outer"]
        il = [LineString([_proj(g["lat"], g["lon"]) for g in m["geometry"]]) for m in e.get("members", []) if m.get("geometry") and m.get("role") == "inner"]
        ps = list(_pz(_lm(ol))) if ol else []
        if ps:
            P_ = unary_union(ps)
            if il:
                hs = list(_pz(_lm(il)))
                if hs: P_ = P_.difference(unary_union(hs))
            _wp.append(P_)
_WATER = unary_union(_wp).intersection(shapely.box(DX0, DZ0, DX0 + nx * DSTEP, DZ0 + nz * DSTEP)) if _wp else Polygon()
def _water_raster(step, w, h):
    """v30: 水域の多角形を 1 つずつ（穴を抜いて）塗って重ねる。以前は全体の画像に順に塗っていたので、
    川の中の島（穴）にある池（後楽園の花葉の池など）が、塗る順によって川の穴で消えていた（範囲で順が変わる）"""
    out = np.zeros((h, w), bool)
    for g in (_WATER.geoms if hasattr(_WATER, "geoms") else [_WATER]):
        if not isinstance(g, Polygon) or g.is_empty: continue
        bx0, bz0, bx1, bz1 = g.bounds
        i0 = max(0, int(math.floor((bx0 - DX0) / step)) - 2); j0 = max(0, int(math.floor((bz0 - DZ0) / step)) - 2)
        i1 = min(w, int(math.ceil((bx1 - DX0) / step)) + 3); j1 = min(h, int(math.ceil((bz1 - DZ0) / step)) + 3)
        if i1 <= i0 or j1 <= j0: continue
        im = Image.new("L", (i1 - i0, j1 - j0), 0); dr = ImageDraw.Draw(im)
        dr.polygon([((x - DX0) / step - i0, (z - DZ0) / step - j0) for x, z in g.exterior.coords], fill=255)
        for hole in g.interiors: dr.polygon([((x - DX0) / step - i0, (z - DZ0) / step - j0) for x, z in hole.coords], fill=0)
        out[j0:j1, i0:i1] |= np.array(im) > 0
    return out
Wm = _water_raster(DSTEP, nx, nz) | (LUSE == 204)
_num = ndimage.gaussian_filter(np.where(Wm, DH, 0.0), 3.0); _den = ndimage.gaussian_filter(Wm.astype(float), 3.0)
LVL = np.where(_den > 0.02, _num / np.maximum(_den, 1e-6), np.nan)
# v13: 水位は周りの路面・岸（水域外の地面）より必ず下（西川など細い水路で DEM が岸の高さを拾い、道路へあふれていた）
_bank = ndimage.minimum_filter(np.where(Wm, np.inf, DH), size=7)
_road = ndimage.minimum_filter(HRMIN, size=7)
LVL = np.minimum(LVL, np.minimum(_bank - 0.6, _road - 0.5))
Wd_ = ndimage.binary_dilation(Wm, iterations=2)
WL = np.where(Wd_ & np.isfinite(LVL), np.round(LVL * 100), -32768).astype(np.int16)
_bed = Wm & np.isfinite(LVL)
# v17: 岸をなめらかに。水域の外周までの符号付き距離（1m 格子で計算、外が正）で、岸から水中へ一定の勾配で下げる
# （4m の升目ごとに川底を掘っていたので、水面と地面の交わる線が階段状になっていた）。道路の近くは従来どおり
_FS1 = 1.0; _fw, _fh = int(nx * DSTEP / _FS1), int(nz * DSTEP / _FS1)
# v30: 1m 格子は範囲拡大で大きい（1 億升）ので、節点の行ごとの帯（上下に 48m の余白）で求める。
#      使うのは岸から 6m 以内（と水中 2.4m まで）だけなので、距離を ±32m で打ち切れば全体で求めた時と同じ
_wa1 = _water_raster(_FS1, _fw, _fh)
_lum = (LUSE == 204).astype(np.float32); _KR1 = int(DSTEP / _FS1)
_sdn = np.zeros((nz, nx), np.float64)
_rows = np.clip((np.arange(nz) * DSTEP / _FS1).astype(int), 0, _fh - 1); _cols = np.clip((np.arange(nx) * DSTEP / _FS1).astype(int), 0, _fw - 1)
_MG = 48; _SDC = 32.0
for _b0 in range(0, nz, 128):
    _js = np.arange(_b0, min(nz, _b0 + 128)); _r0 = max(0, int(_rows[_js[0]]) - _MG); _r1 = min(_fh, int(_rows[_js[-1]]) + _MG + 1)
    # 土地利用の水面（4m）を 1m にして平滑化（σ=1.5m、打ち切り 6m。余白 48m の中で足りる）
    _q0 = _r0 // _KR1; _q1 = min(LUSE.shape[0], -(-_r1 // _KR1))
    _k1 = np.kron(_lum[max(0, _q0 - 3):min(LUSE.shape[0], _q1 + 3)], np.ones((_KR1, _KR1), np.float32))
    _kofs = _r0 - max(0, _q0 - 3) * _KR1
    # 全体の配列の上下端では gaussian_filter の端の扱い（reflect）が全体と同じになるよう、端の行を含む時は端から切る
    _g = ndimage.gaussian_filter(_k1, 1.5)
    _lu = _g[_kofs:_kofs + (_r1 - _r0), :_fw] > 0.5; del _k1, _g
    _W1 = _wa1[_r0:_r1, :_fw] | _lu; del _lu
    if _W1.all(): _sd = np.full(_W1.shape, -_SDC)
    elif not _W1.any(): _sd = np.full(_W1.shape, _SDC)
    else: _sd = np.clip(ndimage.distance_transform_edt(~_W1) - ndimage.distance_transform_edt(_W1), -_SDC, _SDC)
    _sdn[_js] = _sd[_rows[_js] - _r0][:, _cols]
    del _W1, _sd
del _wa1, _lum
_nearroad = ndimage.binary_dilation(np.isfinite(HRMIN), iterations=2)
_shore = np.isfinite(LVL) & (_sdn < 6.0) & ~_nearroad
_tgt = np.maximum(LVL - 1.2, LVL + 0.45 * _sdn - 0.12)
Hg = np.where(_shore, np.minimum(Hg, _tgt), Hg)
_old = _bed & ~_shore
Hg[_old] = np.minimum(Hg[_old], LVL[_old] - 1.2)
print("  shore nodes smoothed", int(_shore.sum()), "old carve", int(_old.sum()), flush=True)
print("  water cells", int(Wm.sum()), "level range", np.nanmin(LVL[Wm]).round(2) if Wm.any() else None, np.nanmax(LVL[Wm]).round(2) if Wm.any() else None, flush=True)
Hc = np.round(Hg * 100).astype(np.int16)
water = Wm.astype(np.uint8)
road_cls = (LUSE == 215).astype(np.uint8)
road_cls[:] = 0  # 高さは上で調整済み
gbuf = grad_encode(Hc) + water.tobytes() + road_cls.tobytes() + Mk.tobytes() + WL.tobytes()   # v30: 高さは差分（grad2）
bins["ground"] = bytearray(gbuf)
manifest["ground"] = dict(file="ground", nx=int(nx), nz=int(nz), x0=DX0, z0=DZ0, step=DSTEP, enc="grad2")

# ================= 3) 道路 =================
print("roads...", flush=True); print("  [rss MB]", _rss(), flush=True)
RT = R["tris"]
ROAD_TINT = {"lane": (1.0, 1.0, 1.0), "xing": (0.97, 0.97, 0.97), "walk": (1.0, 1.0, 1.0), "island": (1.0, 1.0, 1.0),
             "green": (1.0, 1.0, 1.0), "tramstop": (1.0, 1.0, 1.0), "rail": (1.0, 1.0, 1.0)}
MAT = {"lane": "asphalt", "xing": "asphalt", "rail": "asphalt", "walk": "paving", "tramstop": "paving", "island": "island", "green": "grass"}
def clip_tris(tri, poly, keep_inside=False):
    """三角形群から poly の内側を取り除き、元の面の高さで再三角形化"""
    t = tri.reshape(-1, 3, 3)
    # v38: 三角形ごとの shapely 図形を全部いっぺんに作るとメモリが 1GB 以上増えるので、50 万個ずつ判定する
    hit = np.zeros(len(t), bool); shapely.prepare(poly)
    for _a in range(0, len(t), 500000):
        _q = t[_a:_a + 500000]
        _pl = shapely.polygons(np.concatenate([_q[:, :, [0, 2]], _q[:, :1, [0, 2]]], 1))
        hit[_a:_a + 500000] = shapely.intersects(_pl, poly); del _pl
    out = [t[~hit].reshape(-1, 3)]
    for k in np.nonzero(hit)[0]:
        g = shapely.polygons(np.concatenate([t[k][:, [0, 2]], t[k][:1, [0, 2]]], 0)).difference(poly)
        if g.is_empty or g.area < 1e-4: continue
        A, B, C = t[k]
        v0 = C[[0, 2]] - A[[0, 2]]; v1 = B[[0, 2]] - A[[0, 2]]
        d00 = v0 @ v0; d01 = v0 @ v1; d11 = v1 @ v1; den = d00 * d11 - d01 * d01
        if abs(den) < 1e-12: continue
        def hf(x, z, A=A, B=B, C=C, v0=v0, v1=v1, d00=d00, d01=d01, d11=d11, den=den):
            px, pz = x - A[0], z - A[2]
            d02 = v0[0] * px + v0[1] * pz; d12 = v1[0] * px + v1[1] * pz
            u = (d11 * d02 - d01 * d12) / den; v = (d00 * d12 - d01 * d02) / den
            return A[1] + u * (C[1] - A[1]) + v * (B[1] - A[1])
        r_ = tri_poly(g, hf)
        if len(r_): out.append(r_)
    return np.concatenate(out)
for cat in list(RT.keys()):
    before = len(RT[cat]) // 3
    RT[cat] = clip_tris(RT[cat], TBpoly)
    print("  clip", cat, before, "->", len(RT[cat]) // 3, flush=True)
def shift_ext(P):
    if not len(P): return P
    P = P.copy()
    m = np.nonzero((P[:, 0] > -145) & (P[:, 0] < 0) & (P[:, 2] > -50) & (P[:, 2] < 35))[0]
    for k in m:
        x_, z_ = float(P[k, 0]), float(P[k, 2])
        P[k, 1] = ext_target(x_, z_, P[k, 1] + ext_delta(x_, z_), -0.01) if x_ < -6 else P[k, 1] + ext_delta(x_, z_)
    return P
for cat in list(RT.keys()): RT[cat] = shift_ext(RT[cat])
R["curb"] = shift_ext(R["curb"]); M["white"] = shift_ext(M["white"]); M["yellow"] = shift_ext(M["yellow"])
for cat, tri in RT.items():
    t = tri.reshape(-1, 3, 3)
    if cat in ("island", "green"):
        # 軌道敷と重なる島(=軌道敷そのもの)は描かない
        cen = t.mean(1)
        keep = np.array([not TBp.contains(Point(c[0], c[2])) for c in cen])
        t = t[keep]
    _t = t.reshape(-1, 3)
    add_chunk("road", _t, col=tri_colors(len(t), ROAD_TINT[cat], 0.04, len(t)), mat=MAT[cat], file_key="road", nrm=np.tile([0.0, 1.0, 0.0], (len(_t), 1)))
_cb = R["curb"].reshape(-1, 12, 3); _cm = _cb.mean(1)
R["curb"] = _cb[np.array([not TBp.contains(Point(c[0], c[2])) for c in _cm])].reshape(-1, 3)
add_chunk("road", R["curb"], col=tri_colors(len(R["curb"]) // 3, (0.74, 0.73, 0.70), 0.03, 1), mat="color", file_key="road")
# 路面標示
def lift_marks(P):
    if not len(P): return P
    t = P.reshape(-1, 3, 3).copy(); cen = t.mean(1)
    inside = np.array([TBp.contains(Point(c[0], c[2])) for c in cen])
    for k in np.nonzero(inside)[0]:
        for v in range(3): t[k, v, 1] = F(t[k, v, 0], t[k, v, 2]) + 0.015
    return t.reshape(-1, 3)
M["white"] = lift_marks(M["white"]); M["yellow"] = lift_marks(M["yellow"])
add_chunk("mark", M["white"], col=tri_colors(len(M["white"]) // 3, (0.92, 0.92, 0.90)), mat="paint", file_key="road", nrm=np.tile([0.0, 1.0, 0.0], (len(M["white"]), 1)))
add_chunk("mark", M["yellow"], col=tri_colors(len(M["yellow"]) // 3, (0.93, 0.74, 0.20)), mat="paint", file_key="road")
print("  marks white", len(M["white"]) // 3, "yellow", len(M["yellow"]) // 3, flush=True)
del M; RT.clear(); R["tris"] = {}; R["curb"] = None   # v29: 出力済み（メモリ）

print("bridge rails...", flush=True); print("  [rss MB]", _rss(), flush=True)
# v30: 道路は部分のリスト（lanes_parts・raised_parts）。v29 と同じく全体の和集合の輪郭のうち、軌道の近くを通る輪郭を使う
allroad = unary_union(list(road_parts(R, "lanes")) + list(road_parts(R, "raised")))
brail = []
near_tr = TRACKS.buffer(250)
def _in(pt):
    i_ = int((pt[0] - GX0) / RES); j_ = int((pt[1] - GZ0) / RES)
    return 0 <= j_ < HR.shape[0] and 0 <= i_ < HR.shape[1] and np.isfinite(HR[j_, i_])
for g in (allroad.geoms if hasattr(allroad, "geoms") else [allroad]):
    for ring in [g.exterior] + list(g.interiors):
        if not ring.intersects(near_tr): continue
        L = ring.length; segs = []
        for k in range(int(L)):
            a = np.array(ring.interpolate(k).coords[0]); b = np.array(ring.interpolate(min(L, k + 1.0)).coords[0])
            d = b - a; n_ = np.linalg.norm(d)
            if n_ < 0.2: segs.append(None); continue
            nv = np.array([-d[1], d[0]]) / n_; m = (a + b) / 2
            pa, pb = m + nv * 1.2, m - nv * 1.2
            if _in(pa) and _in(pb): segs.append(None); continue
            out_p = pa if not _in(pa) else pb
            top = surf(*m)
            segs.append((a, b, top) if top - float(dem_at(*out_p)) >= 1.4 else None)
        # 1〜2m の途切れは埋め、孤立した 1〜2m は捨てる（連続した壁高欄にする）
        ok = np.array([x is not None for x in segs])
        ok2 = ok.copy()
        for k in range(len(ok)):
            if not ok[k] and ok[max(0, k - 2):k].any() and ok[k + 1:k + 3].any(): ok2[k] = True
        for k in range(len(ok2)):
            if ok2[k] and ok2[max(0, k - 2):k + 3].sum() < 3: ok2[k] = False
        last_top = None
        for k in range(len(segs)):
            if not ok2[k]: continue
            if segs[k] is None:
                a = np.array(ring.interpolate(k).coords[0]); b = np.array(ring.interpolate(min(L, k + 1.0)).coords[0]); top = last_top
                if top is None: continue
            else:
                a, b, top = segs[k]; last_top = top
            wall_ = LineString([a, b]).buffer(0.125, cap_style=2)
            brail.append(extrude_ring(wall_.exterior, lambda x, z, t=top: t - 1.2, lambda x, z, t=top: t + 1.0))
            brail.append(tri_poly(wall_, lambda x, z, t=top: t + 1.0))
brail = np.concatenate(brail) if brail else np.zeros((0, 3))
add_chunk("bridge", brail, col=tri_colors(len(brail) // 3, (0.72, 0.72, 0.70)), mat="color", file_key="road")
del allroad   # v29: メモリ
# ---- v11: 橋の構造（床版の下面・側面の桁・橋脚）。OSM の man_made=bridge の輪郭から ----
bdeck = []; bpier = []
_rk = None
# v29: v28 の範囲（core）の外では、車道の橋（OSM の highway の橋が上を通る）だけ（鉄道の橋・高架は jr.py が作る）
from common import CORE as _CORE3
_CARW3 = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service",
          "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
_RB3 = [LineString(w["xy"]) for w in ways if w["tags"].get("highway") in _CARW3 and w["tags"].get("bridge") in ("yes", "viaduct") and len(w["xy"]) >= 2]
def _road_bridge3(P):
    rr = np.array(P.minimum_rotated_rectangle.exterior.coords)[:-1]; L = max(np.linalg.norm(rr[1] - rr[0]), np.linalg.norm(rr[2] - rr[1]))
    return sum(ln.intersection(P).length for ln in _RB3 if ln.intersects(P)) > 0.5 * L
for bname, bpoly in BRIDGES:
    if bpoly.area < 400 or not bpoly.intersects(corr): continue
    _bc = bpoly.centroid
    if not (_CORE3[0] < _bc.x < _CORE3[2] and _CORE3[1] < _bc.y < _CORE3[3]):
        continue   # v32: core の外の橋の構造は、PLATEAU の橋・高架の面から作る（下の structures.bridge_structures）
    x0_, z0_, x1_, z1_ = bpoly.bounds
    i0_ = max(0, int((x0_ - GX0) / RES)); i1_ = min(HR.shape[1], int((x1_ - GX0) / RES) + 1)
    j0_ = max(0, int((z0_ - GZ0) / RES)); j1_ = min(HR.shape[0], int((z1_ - GZ0) / RES) + 1)
    sub = HR[j0_:j1_, i0_:i1_]; jj, ii = np.nonzero(np.isfinite(sub))
    if len(jj) < 20: continue
    pts_ = np.stack([GX0 + (ii + i0_ + 0.5) * RES, GZ0 + (jj + j0_ + 0.5) * RES], 1); hv = sub[jj, ii]
    kd_ = _KD(pts_)
    def deck_top(x, z, _kd=kd_, _hv=hv):
        d_, i_ = _kd.query([x, z], k=6); return float(np.mean(_hv[i_]))
    under = lambda x, z: deck_top(x, z) - 1.35
    # 下面（下向き）と側面
    uf = tri_poly(bpoly, under)
    if len(uf): bdeck.append(uf.reshape(-1, 3, 3)[:, ::-1].reshape(-1, 3))
    bdeck.append(extrude_ring(bpoly.exterior, under, lambda x, z: deck_top(x, z) - 0.05))
    # 橋脚: 長手方向に 25〜32m 間隔、川底（地面が deck より 3m 以上低い所）だけ
    rr = np.array(bpoly.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr[1] - rr[0]; e2 = rr[2] - rr[1]
    ax_ = e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2; Lb = float(np.linalg.norm(ax_)); ax_ = ax_ / Lb
    Wb = float(min(np.linalg.norm(e1), np.linalg.norm(e2))); cen = np.array(bpoly.centroid.coords[0]); nrm_ = np.array([-ax_[1], ax_[0]])
    nsp = max(1, int(round(Lb / 30.0)))
    for k in range(1, nsp):
        c_ = cen + ax_ * (-Lb / 2 + Lb * k / nsp)
        top = deck_top(*c_) - 1.35; bot = float(dem_at(*c_)) - 1.5
        if top - bot < 3.0: continue
        body = LineString([c_ - nrm_ * (Wb * 0.42), c_ + nrm_ * (Wb * 0.42)]).buffer(0.8, cap_style=1)
        bpier.append(extrude_ring(body.exterior, lambda x, z, b=bot: b, lambda x, z, t=top: t))
        cap = LineString([c_ - nrm_ * (Wb * 0.46), c_ + nrm_ * (Wb * 0.46)]).buffer(1.1, cap_style=2)
        bpier.append(extrude_ring(cap.exterior, lambda x, z, t=top: t - 0.9, lambda x, z, t=top: t))
    print("  bridge", bname, "len", round(Lb), "width", round(Wb), "piers", nsp - 1, flush=True)
_cat0 = lambda L: np.concatenate([x for x in L if len(x)]) if any(len(x) for x in L) else np.zeros((0, 3))
if bdeck:
    g_ = _cat0(bdeck); add_chunk("bridge", g_, col=tri_colors(len(g_) // 3, (0.60, 0.60, 0.58)), mat="color", file_key="road")
if bpier:
    g_ = _cat0(bpier); add_chunk("bridge", g_, col=tri_colors(len(g_) // 3, (0.64, 0.63, 0.60), 0.03, 11), mat="color", file_key="road")
print("  bridge rail tris", len(brail) // 3, flush=True)
# ---- v32: 地形の高低差のある所の構造物（structures.py）: 橋・高架の構造、道路の縁の擁壁、建物の基礎（建物の所で） ----
import structures as STR
_GR = STR.Ground(Hc, water, DX0, DZ0, DSTEP)
_DK = STR.Deck(HR, (GX0, GZ0, RES), R.get("upper"))
_bparts = [q for q in (R.get("bridge_parts") or []) if q is not None and not q.is_empty]
_bunion = unary_union(_bparts) if _bparts else None
if _bunion is not None: shapely.prepare(_bunion)
# v41.20: トンネルの坑口の周り（床の幅＋両端 8m）は、道路の縁の法面・擁壁を作らない（坑口をふさがない）
_zones = [t["zone"] for t in TUNNELS]
_bunion_t = unary_union(([_bunion] if _bunion is not None else []) + _zones) if (_bunion is not None or _zones) else None
if _bunion_t is not None: shapely.prepare(_bunion_t)
print("  v32 bridge parts", len(_bparts), "upper cells", 0 if R.get("upper") is None else len(R["upper"][0]), flush=True)
_blines = [LineString(w["xy"]) for w in ways if w["tags"].get("highway") and w["tags"].get("bridge") not in (None, "no") and len(w["xy"]) >= 2]
_rlines = [LineString(w["xy"]) for w in ways if w["tags"].get("railway") in ("rail", "light_rail", "narrow_gauge", "tram") and len(w["xy"]) >= 2]
if _bparts:
    _BS = STR.bridge_structures(_bparts, _DK, dem_at, _blines, _DK.lower, _rlines, STR.grid_split, tri_poly, log=lambda *a: print(*a, flush=True))
    for _k, _c, _j in (("under", (0.60, 0.60, 0.58), 0.0), ("sides", (0.66, 0.66, 0.63), 0.0), ("rails", (0.74, 0.74, 0.71), 0.02), ("piers", (0.64, 0.63, 0.60), 0.03)):
        g_ = _BS[_k]
        if len(g_): add_chunk("bridge", g_, col=tri_colors(len(g_) // 3, _c, _j, 13), mat="color", file_key="road")
    del _BS
# 道路の縁の擁壁（道路の縁が地面より 0.35m 以上高い所）
_PI = PartsIndex(list(road_parts(R, "lanes")) + list(road_parts(R, "raised")))
_tl = [(x_, z_, x_ + 500.0, z_ + 500.0) for x_ in np.arange(math.floor(_BX0 / 500) * 500, _BX1, 500.0) for z_ in np.arange(math.floor(_BZ0 / 500) * 500, _BZ1, 500.0)]
_sk, _skc = STR.road_skirts(_PI, _tl, _bunion_t, _DK, _GR, 0.35, log=lambda *a: print(*a, flush=True))
if len(_sk): add_chunk("skirt", _sk, col=_skc * np.random.default_rng(14).uniform(0.96, 1.04, (len(_skc) // 3, 1)).repeat(3, 0), mat="color", file_key="road")
del _sk, _skc
# 切土の法面（道路の縁から 1:1 で上がって地形に当たるまで）
_GRo = STR.Ground(np.round(Hg_orig * 100).astype(np.int16), water, DX0, DZ0, DSTEP)
_cf, _cfc = STR.cut_faces(_PI, _tl, _bunion_t, _DK, _GRo, CUT_S, 0.3, 12.0, log=lambda *a: print(*a, flush=True))
if len(_cf): add_chunk("cutface", _cf, col=_cfc * np.random.default_rng(15).uniform(0.95, 1.05, (len(_cfc) // 3, 1)).repeat(3, 0), mat="color", file_key="road")
del _cf, _cfc, _GRo, _PI
# v41.20: トンネルの路面・壁・天井・屋根・路面標示
if TUNNELS:
    def _tcat(key): 
        L_ = [t["tris"][key] for t in TUNNELS if len(t["tris"][key])]
        return np.concatenate(L_) if L_ else np.zeros((0, 3))
    _g = _tcat("floor")
    if len(_g): add_chunk("road", _g, col=tri_colors(len(_g) // 3, ROAD_TINT["lane"], 0.04, 21), mat=MAT["lane"], file_key="road", nrm=np.tile([0.0, 1.0, 0.0], (len(_g), 1)))
    for _k, _c, _j in (("wall", (0.64, 0.63, 0.60), 0.03), ("ceil", (0.52, 0.52, 0.50), 0.02), ("roof", (0.62, 0.62, 0.59), 0.02), ("cap", (0.66, 0.65, 0.62), 0.02)):
        _g = _tcat(_k)
        if len(_g): add_chunk("bridge", _g, col=tri_colors(len(_g) // 3, _c, _j, 22), mat="color", file_key="road")
    _g = _tcat("white")
    if len(_g): add_chunk("mark", _g, col=tri_colors(len(_g) // 3, (0.92, 0.92, 0.90)), mat="paint", file_key="road", nrm=np.tile([0.0, 1.0, 0.0], (len(_g), 1)))
    _g = _tcat("yellow")
    if len(_g): add_chunk("mark", _g, col=tri_colors(len(_g) // 3, (0.93, 0.74, 0.20)), mat="paint", file_key="road")
    print("  tunnel meshes: floor", len(_tcat("floor")) // 3, "wall", len(_tcat("wall")) // 3, "ceil", len(_tcat("ceil")) // 3, "roof", len(_tcat("roof")) // 3, flush=True)

# ================= 4) 軌道（軌道敷・レール） =================
print("track...", flush=True); print("  [rss MB]", _rss(), flush=True)
from scipy.spatial import cKDTree
allpts = np.concatenate([t["xyz"] for t in T["tracks"]])
ktree = cKDTree(allpts[:, [0, 2]])
def track_h(x, z):
    return F(x, z) + 0.01
# 軌道敷は 2m 格子で分割してから三角形化（長い三角形で高さが補間されて浮く・沈むのを防ぐ）
def grid_split(poly, cell=2.0):
    x0, z0, x1, z1 = poly.bounds
    xs = np.arange(np.floor(x0 / cell) * cell, x1 + cell, cell); zs = np.arange(np.floor(z0 / cell) * cell, z1 + cell, cell)
    boxes = shapely.box(*np.meshgrid(xs[:-1], zs[:-1]), *np.meshgrid(xs[1:], zs[1:]))
    boxes = boxes.ravel()
    boxes = boxes[shapely.intersects(boxes, poly)]
    parts = shapely.intersection(boxes, poly)
    return [g for g in parts if not g.is_empty and g.area > 1e-4]
_pieces = grid_split(TBpoly)
bed = np.concatenate([tri_poly(g, track_h, 0.0) for g in _pieces if isinstance(g, Polygon) or hasattr(g, "geoms")])
_gp = prep(EXTD["grass"]); _bt = bed.reshape(-1, 3, 3); _gm = np.array([_gp.contains(Point(c[0], c[2])) for c in _bt.mean(1)])
_bg = _bt[_gm].reshape(-1, 3); bed = _bt[~_gm].reshape(-1, 3)
add_chunk("track", bed, col=tri_colors(len(bed) // 3, (0.52, 0.51, 0.49), 0.05, 7), mat="trackbed", file_key="track", nrm=np.tile([0.0, 1.0, 0.0], (len(bed), 1)))
if len(_bg): add_chunk("track", _bg, col=tri_colors(len(_bg) // 3, (0.95, 1.0, 0.9), 0.05, 8), mat="grass", file_key="track", nrm=np.tile([0.0, 1.0, 0.0], (len(_bg), 1)))
side = []
for g in (TBpoly.geoms if hasattr(TBpoly, "geoms") else [TBpoly]):
    for ring in [g.exterior] + list(g.interiors):
        side.append(extrude_ring(ring, lambda x, z: track_h(x, z) - 0.3, track_h))
side = np.concatenate(side)
add_chunk("track", side, col=tri_colors(len(side) // 3, (0.48, 0.47, 0.45)), mat="color", file_key="track")
def ribbon(xyz, off, w, lift):
    p = xyz[:, [0, 2]]
    t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
    nvec = np.stack([t[:, 1], -t[:, 0]], 1)
    c = p + nvec * off
    L = c + nvec * w / 2; Rr = c - nvec * w / 2
    # レール・溝は軌道敷と同じ面(F)に載せる
    y = np.array([F(px, pz) + 0.01 for px, pz in c]) + lift
    out = []
    for i in range(len(p) - 1):
        a0 = [L[i, 0], y[i], L[i, 1]]; a1 = [L[i + 1, 0], y[i + 1], L[i + 1, 1]]
        b0 = [Rr[i, 0], y[i], Rr[i, 1]]; b1 = [Rr[i + 1, 0], y[i + 1], Rr[i + 1, 1]]
        out += [a0, b0, a1, a1, b0, b1]
    return np.array(out)
rails, grooves = [], []
G2 = 1.067 / 2 + 0.0325
for t in T["tracks"]:
    for s in (1, -1):
        rails.append(ribbon(t["xyz"], s * G2, 0.065, 0.035))
        grooves.append(ribbon(t["xyz"], s * (G2 - 0.055), 0.045, 0.025))
rails = np.concatenate(rails); grooves = np.concatenate(grooves)
add_chunk("track", rails, col=tri_colors(len(rails) // 3, (0.78, 0.77, 0.74)), mat="rail", file_key="track")
add_chunk("track", grooves, col=tri_colors(len(grooves) // 3, (0.16, 0.15, 0.14)), mat="color", file_key="track")
print("  bed", len(bed) // 3, "rails", len(rails) // 3, flush=True)

# ================= 5) ホーム・路面表示のみの電停 =================
print("platforms...", flush=True); print("  [rss MB]", _rss(), flush=True)
# ホームの整形: OSM のホーム形状が線路に掛かる・幅が 1.8m 未満のものは、線路側を車両限界(軌道中心から1.40m)で切り、
# 車道側へ広げて有効幅を確保する（岡電の電停は幅 1.8〜2.5m 程度）
_TB140 = TRACKS.buffer(1.30)
_nfix = 0
for p in T["platforms"]:
    if p.get("bigroof"): continue
    P0 = Polygon(p["xy"]).buffer(0)
    rr = P0.minimum_rotated_rectangle; cc = np.array(rr.exterior.coords)[:-1]
    wid = min(np.linalg.norm(cc[1] - cc[0]), np.linalg.norm(cc[2] - cc[1]))
    if P0.distance(TRACKS) > 1.38 and wid >= 1.8: continue
    P1 = P0.buffer(max(0.0, (2.0 - wid)) + 0.3, join_style=2).difference(_TB140)
    if P1.is_empty: continue
    parts = list(P1.geoms) if hasattr(P1, "geoms") else [P1]
    P1 = max(parts, key=lambda g: g.intersection(P0.buffer(0.3)).area)
    # 長手方向には伸ばさない
    P1 = P1.intersection(P0.minimum_rotated_rectangle.buffer(3.0, join_style=2).intersection(
        LineString(P0.minimum_rotated_rectangle.exterior.coords[:2] if np.linalg.norm(cc[1]-cc[0]) > np.linalg.norm(cc[2]-cc[1]) else P0.minimum_rotated_rectangle.exterior.coords[1:3]).buffer(20, cap_style=2)))
    if hasattr(P1, "geoms"): P1 = max(P1.geoms, key=lambda g: g.area)
    if P1.area < P0.area * 0.8: continue
    p["xy"] = np.array(P1.exterior.coords)[:-1]; _nfix += 1
print("  platforms widened/cut", _nfix, flush=True)
plat_top, plat_side, plat_edge, fences, roofs, namebd = [], [], [], [], [], []
for p in T["platforms"]:
    P = Polygon(p["xy"]).buffer(0)
    top = p["base"] + 0.25
    plat_top.append(tri_poly(P, lambda x, z: top))
    plat_side.append(extrude_ring(P.exterior, lambda x, z: top - 0.3, lambda x, z: top))
    # 乗降側(線路から2m以内)に黄色の点字ブロック帯, それ以外に柵
    c = np.array(P.exterior.coords)
    for a, b in zip(c[:-1], c[1:]):
        m = (a + b) / 2; L = np.hypot(*(b - a))
        if L < 0.5: continue
        if TRACKS.distance(Point(*m)) < 2.2:
            ln = LineString([a, b]); inner = ln.parallel_offset(0.45, "left" if P.contains(Point(*(m + np.array([-(b - a)[1], (b - a)[0]]) / L * 0.3))) else "right")
            band = LineString([a, b]).buffer(0.2, cap_style=2).intersection(P.buffer(-0.35).buffer(0.55)).intersection(P)
            plat_edge.append(tri_poly(band, lambda x, z: top, 0.006))
        else:
            fences.append(beam(a, b, top + 1.0, 0.05, 0.05)); fences.append(beam(a, b, top + 0.5, 0.04, 0.04))
            for k in range(int(L // 2) + 1):
                q_ = a + (b - a) * min(1.0, k * 2 / max(L, 1e-6)); fences.append(cyl(q_, 0.03, top, top + 1.05, 4))
    if p["covered"] and not p.get("bigroof"):
        rr = P.minimum_rotated_rectangle
        # 上屋は車両限界（軌道中心から約1.3m・高さ3.8m）に掛からないよう、ホーム内側 0.2m までに収める
        roof_poly = rr.buffer(0.3, join_style=2).intersection(P.buffer(-0.2)).difference(TRACKS.buffer(1.45))
        roofs.append(tri_poly(roof_poly, lambda x, z: top + 2.55))
        roofs.append(extrude_ring(roof_poly.exterior, lambda x, z: top + 2.45, lambda x, z: top + 2.55))
        cc = np.array(rr.exterior.coords)[:-1]
        e1 = cc[1] - cc[0]; e2 = cc[2] - cc[1]
        long_ = e1 if np.linalg.norm(e1) > np.linalg.norm(e2) else e2
        ctr = cc.mean(0); n_posts = max(2, int(np.linalg.norm(long_) // 6) + 1)
        # 上屋の端に電停名の看板（屋根上に載る白い板）
        for sgn_ in (-0.5, 0.5):
            e_ = ctr + long_ * sgn_ * 0.92; wv = long_ / (np.linalg.norm(long_) + 1e-9); nv_ = np.array([-wv[1], wv[0]])
            p0 = e_ - nv_ * 0.7; p1 = e_ + nv_ * 0.7; y0 = top + 2.55; y1 = top + 3.05
            qd = np.array([[p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y0, p0[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]])
            namebd.append(qd); namebd.append(qd[[0, 2, 1, 3, 5, 4]])
        for k in range(n_posts):
            q = ctr + long_ * (k / (n_posts - 1) - 0.5) * 0.85
            post = Point(*q).buffer(0.07, 6)
            roofs.append(extrude_ring(post.exterior, lambda x, z: top, lambda x, z: top + 2.5))
broofs = []
# 新停留場の大屋根（公表イメージの片流れ屋根・濃灰。寸法は推定）
_R = EXTD["roof"]; _rc = np.array(_R.centroid.coords[0]); _yb = F(*_rc)
def _roof_h(x, z):
    # 北(−z)側が高い片流れ: 高さ 6.4〜7.6m
    return _yb + 7.0 + (-(z - _rc[1])) * 0.07
broofs.append(tri_poly(_R, _roof_h)); broofs.append(tri_poly(_R, lambda x, z: _roof_h(x, z) - 0.25))
broofs.append(extrude_ring(_R.exterior, lambda x, z: _roof_h(x, z) - 0.25, _roof_h))
for pl_ in [q for q in T["platforms"] if q.get("bigroof")]:
    Pp = Polygon(pl_["xy"]); ln_ = LineString(Pp.minimum_rotated_rectangle.exterior.coords[:3])
    cc_ = np.array(Pp.centroid.coords[0]); rr_ = np.array(Pp.minimum_rotated_rectangle.exterior.coords)[:-1]
    e1 = rr_[1] - rr_[0]; e2 = rr_[2] - rr_[1]; lg = e1 if np.linalg.norm(e1) > np.linalg.norm(e2) else e2
    for k_ in range(6):
        q_ = cc_ + lg * (k_ / 5 - 0.5) * 0.9
        broofs.append(cyl(q_, 0.12, pl_["base"] + 0.25, _roof_h(*q_) - 0.25, 8))
def cat_(L): return np.concatenate([x for x in L if len(x)]) if any(len(x) for x in L) else np.zeros((0, 3))
add_chunk("stop", cat_(plat_top), col=tri_colors(len(cat_(plat_top)) // 3, (0.70, 0.68, 0.64), 0.03, 2), mat="paving", file_key="stop")
add_chunk("stop", cat_(plat_side), col=tri_colors(len(cat_(plat_side)) // 3, (0.62, 0.61, 0.58)), mat="color", file_key="stop")
add_chunk("stop", cat_(plat_edge), col=tri_colors(len(cat_(plat_edge)) // 3, (0.93, 0.76, 0.18)), mat="color", file_key="stop")
add_chunk("stop", cat_(fences), col=tri_colors(len(cat_(fences)) // 3, (0.27, 0.21, 0.16)), mat="fence", file_key="stop")   # 岡電の電停: 焦茶の柵
add_chunk("stop", cat_(broofs), col=tri_colors(len(cat_(broofs)) // 3, (0.20, 0.21, 0.22)), mat="color", file_key="stop")
add_chunk("stop", cat_(roofs), col=tri_colors(len(cat_(roofs)) // 3, (0.36, 0.26, 0.19)), mat="color", file_key="stop")   # 茶色の鋼製上屋
add_chunk("stop", cat_(namebd), col=tri_colors(len(cat_(namebd)) // 3, (0.93, 0.93, 0.90)), mat="color", file_key="stop")

# ---- 停止位置: 車両の先頭をホームの進行方向側の端（端から 0.8m 手前）に合わせる ----
stop_boards = []; stop_posts = []
for key, r in T["routes"].items():
    xyz = r["xyz"]; arc = r["arc"]; RL = LineString(xyz[:, [0, 2]])
    for k_, st in enumerate(r["stops"]):
        if k_ == 0: continue
        best = None
        for p in T["platforms"]:
            Pp = Polygon(p["xy"])
            if Pp.distance(RL.interpolate(st["arc"])) > 12: continue
            i0_ = int(np.searchsorted(arc, st["arc"] - 40)); i1_ = int(np.searchsorted(arc, st["arc"] + 40))
            if Pp.distance(LineString(xyz[i0_:i1_ + 1][:, [0, 2]])) > 2.0: continue   # 自線に面したホームのみ
            V = np.array(Pp.exterior.coords)[:-1]
            sv = np.array([RL.project(Point(*v)) for v in V]); dv = np.array([RL.distance(Point(*v)) for v in V])
            m_ = (dv < 4.5) & (np.abs(sv - st["arc"]) < 45)
            if m_.sum() < 2: continue
            fr = float(sv[m_].max()); bk = float(sv[m_].min())
            if fr - bk < 8: continue
            if best is None or abs((fr + bk) / 2 - st["arc"]) < abs((best[0] + best[1]) / 2 - st["arc"]): best = (fr, bk, p)
        if best is not None:
            st["arc_osm"] = st["arc"]; st["arc"] = best[0] - 0.8; st["plat_len"] = round(best[0] - best[1], 1)
    print("  stop targets", key, [(s["name"][:4], round(s["arc"] - s.get("arc_osm", s["arc"]), 1), s.get("plat_len")) for s in r["stops"]], flush=True)
    # 停止位置目標: 軌道中心に白い停止目標線、ホームがあればホーム端に停止位置標識
    for k_, st in enumerate(r["stops"]):
        i = min(int(np.searchsorted(arc, st["arc"] + 0.6)), len(xyz) - 1)     # 車両先端（前面）の位置
        q = xyz[i, [0, 2]]; a = xyz[max(0, i - 3), [0, 2]]; b = xyz[min(len(xyz) - 1, i + 3), [0, 2]]
        tv = (b - a) / (np.linalg.norm(b - a) + 1e-9); nv = np.array([-tv[1], tv[0]])
        bar = LineString([q - nv * 0.55, q + nv * 0.55]).buffer(0.09, cap_style=2)
        stop_boards.append(tri_poly(bar, lambda x, z: F(x, z) + 0.035))
        # 標識はホーム上（線路から 1.9〜3.0m の側）に置く
        for sd, off_, lat_ in [(sd_, o_, l_) for o_ in (1.2, 0.6, 0.0, -0.6, -1.2) for l_ in (2.1, 1.8, 2.5, 3.0) for sd_ in (1, -1)]:
            c_ = q + tv * off_ + nv * sd * lat_      # ホーム先端（なるべく前方）に標識
            if any(Polygon(p["xy"]).buffer(-0.15).contains(Point(*c_)) for p in T["platforms"]):
                pl_ = min(T["platforms"], key=lambda p: Polygon(p["xy"]).distance(Point(*c_)))
                top_ = pl_["base"] + 0.25
                stop_posts.append(cyl(c_, 0.035, top_, top_ + 2.2, 6))
                # 板（進行方向に正対）: 幅 0.5m × 高さ 0.4m
                p0 = c_ - nv * 0.25; p1 = c_ + nv * 0.25
                quad = np.array([[p0[0], top_ + 1.8, p0[1]], [p1[0], top_ + 1.8, p1[1]], [p1[0], top_ + 2.2, p1[1]],
                                 [p0[0], top_ + 1.8, p0[1]], [p1[0], top_ + 2.2, p1[1]], [p0[0], top_ + 2.2, p0[1]]])
                back = quad[:, :].copy(); back[:, [0, 2]] -= tv * 0.02; back = back[[0, 2, 1, 3, 5, 4]]
                stop_boards.append(quad + np.r_[tv[0], 0, tv[1]] * 0.0); stop_boards.append(back)
                break
add_chunk("stop", cat_(stop_boards), col=tri_colors(len(cat_(stop_boards)) // 3, (0.95, 0.95, 0.93)), mat="color", file_key="stop")
add_chunk("stop", cat_(stop_posts), col=tri_colors(len(cat_(stop_posts)) // 3, (0.45, 0.47, 0.50)), mat="color", file_key="stop")

# ホームの無い電停（小橋・中納言など）は乗降位置の路面表示
stop_marks = []
routes_out = {}
for key, r in T["routes"].items():
    xyz = r["xyz"]; arc = r["arc"]
    for st in r["stops"]:
        i = int(np.searchsorted(arc, st["arc"])); i = min(i, len(xyz) - 1)
        q = xyz[i, [0, 2]]
        if any(Polygon(p["xy"]).distance(Point(*q)) < 4 for p in T["platforms"]): continue
        # 進行方向左側(車道側)に 12m x 1.8m の枠
        a = xyz[max(0, i - 8), [0, 2]]; b = xyz[min(len(xyz) - 1, i + 1), [0, 2]]
        tv = (b - a) / (np.linalg.norm(b - a) + 1e-9); lv = np.array([tv[1], -tv[0]])
        c0 = q + lv * 2.2 - tv * 12; c1 = q + lv * 2.2
        box_ = LineString([c0, c1]).buffer(0.9, cap_style=2)
        ring = box_.exterior.buffer(0.1)
        stop_marks.append(tri_poly(ring, lambda x, z: max(surf(x, z), F(x, z)), 0.013))
add_chunk("mark", cat_(stop_marks), col=tri_colors(len(cat_(stop_marks)) // 3, (0.92, 0.92, 0.90)), mat="paint", file_key="road")

# ================= 6) 架線柱・架線 =================
print("catenary...", flush=True); print("  [rss MB]", _rss(), flush=True)
KIND = R["KIND"]
def raised_near(q, dirv, maxd=16):
    for d in np.arange(2.0, maxd, 0.25):
        p = q + dirv * d
        i = int((p[0] - GX0) / RES); j = int((p[1] - GZ0) / RES)
        if 0 <= j < KIND.shape[0] and 0 <= i < KIND.shape[1] and KIND[j, i] == 2:
            return p + dirv * 0.6
    return None
poles, arms, wires, lamps = [], [], [], []
def cyl(c, r, y0, y1, n=8):
    return extrude_ring(Point(*c).buffer(r, n // 2 if n > 4 else 2).exterior, lambda x, z: y0, lambda x, z: y1)
def beam(a, b, y, w=0.12, h=0.12):
    ln = LineString([a, b]).buffer(w / 2, cap_style=2)
    return np.concatenate([tri_poly(ln, lambda x, z: y + h), extrude_ring(ln.exterior, lambda x, z: y, lambda x, z: y + h)])
main_tracks = [t for t in T["tracks"] if t["service"] not in ("yard", "crossover")]
mt_lines = [LineString(t["xyz"][:, [0, 2]]) for t in main_tracks]
done = []
for key, r in T["routes"].items():
    xyz = r["xyz"]
    for i in range(0, len(xyz), 30):
        q = xyz[i, [0, 2]]
        if any(np.hypot(*(q - d)) < 20 for d in done): continue
        done.append(q)
        a = xyz[max(0, i - 2), [0, 2]]; b = xyz[min(len(xyz) - 1, i + 2), [0, 2]]
        tv = (b - a) / (np.linalg.norm(b - a) + 1e-9); lv = np.array([tv[1], -tv[0]])
        y = xyz[i, 1]
        # 反対線の位置
        other = None
        for ln in mt_lines:
            d = ln.distance(Point(*q))
            if 2.0 < d < 8.0:
                pp = ln.interpolate(ln.project(Point(*q))); other = np.array([pp.x, pp.y]); break
        # 反対線が平行でない（分岐・曲線の内側）ときは中柱にしない
        if other is not None:
            for ln in mt_lines:
                if ln.distance(Point(*other)) < 0.05:
                    s2 = ln.project(Point(*other)); pa = ln.interpolate(max(0, s2 - 2)); pb = ln.interpolate(min(ln.length, s2 + 2))
                    ov = np.array([pb.x - pa.x, pb.y - pa.y]); ov /= np.linalg.norm(ov) + 1e-9
                    if abs(float(ov @ tv)) < 0.985: other = None
                    break
        wire_pts = [q] + ([other] if other is not None else [])
        gap = np.hypot(*(other - q)) if other is not None else 0
        # 急曲線(半径 60m 未満)では柱を立てない位置があるので、そこは側柱に回す
        a2 = xyz[max(0, i - 10), [0, 2]]; b2 = xyz[min(len(xyz) - 1, i + 10), [0, 2]]
        t1 = (q - a2) / (np.linalg.norm(q - a2) + 1e-9); t2 = (b2 - q) / (np.linalg.norm(b2 - q) + 1e-9)
        curved = float(t1 @ t2) < 0.985
        if other is not None and gap >= 3.9 and not curved and TRACKS.distance(Point(*((q + other) / 2))) > 1.9:
            mid = (q + other) / 2   # センターポール（上下線の間）
            poles.append(cyl(mid, 0.14, y - 0.2, y + 8.2))
            for w in wire_pts:
                arms.append(beam(mid, w + (w - mid) / (np.linalg.norm(w - mid) + 1e-9) * 0.4, y + 5.9))
            lamps.append(beam(mid - lv * 0.1, mid + lv * 0.1, y + 8.2, 0.5, 0.25))
        else:
            # 側柱: 両側の歩道・島に立て、スパン線で吊る
            for sgn in (1, -1):
                base = raised_near(q, lv * sgn)
                if base is None or TRACKS.distance(Point(*base)) < 2.2: continue
                poles.append(cyl(base, 0.13, surf(*base) - 0.1, surf(*base) + 8.0))
                arms.append(beam(base, q, y + 6.2, 0.04, 0.04))
all_pos = [np.concatenate(poles)] if poles else []
poles = cat_(poles); arms = cat_(arms); lamps = cat_(lamps)
add_chunk("cat", poles, col=tri_colors(len(poles) // 3, (0.55, 0.57, 0.58)), mat="color", file_key="cat")
add_chunk("cat", arms, col=tri_colors(len(arms) // 3, (0.30, 0.31, 0.32)), mat="color", file_key="cat")
add_chunk("cat", lamps, col=tri_colors(len(lamps) // 3, (0.85, 0.85, 0.82)), mat="color", file_key="cat")
# トロリ線（全本線）
wire_lines = []
for t in main_tracks:
    xyz = t["xyz"]
    wire_lines.append([[round(p[0], 2), round(p[1] + 5.4, 2), round(p[2], 2)] for p in xyz[::3]])
manifest["wires"] = wire_lines
print("  poles tris", len(poles) // 3, flush=True)

# ================= 7) 信号機 =================
# 交差点ごとに組み立てる: OSM の traffic_signals ノードを 30m でまとめて交差点とし、
# 交差点に入る道路（腕）ごとに、日本の標準的な配置（交差点の向こう側・進行方向左の柱から張り出した横型3灯）で灯器を置く。
# 向かい合う腕どうしは同じ現示、直交する腕はもう一方の現示（2現示）。主道路＝路面電車の軌道に沿う方向。
print("signals...", flush=True); print("  [rss MB]", _rss(), flush=True)
sig_geo = []; sig_heads = []; ISECT = []
HW_CLASS = {"trunk": 4, "primary": 4, "secondary": 2, "tertiary": 2, "unclassified": 2, "residential": 2}
road_ways = [w for w in ways if w["tags"].get("highway") in ("trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "trunk_link", "primary_link", "secondary_link", "tertiary_link")]
def _halfw(w):
    t = w["tags"]
    try: ln_ = int(str(t.get("lanes", "")).split(";")[0])
    except Exception: ln_ = HW_CLASS.get(t["highway"].replace("_link", ""), 2)
    if t.get("oneway") == "yes": return ln_ * 3.25 / 2 + 0.5
    return ln_ * 3.25 / 2 + 0.8
rw_lines = [LineString(w["xy"]) for w in road_ways]
from shapely.strtree import STRtree
rw_tree = STRtree(rw_lines)
sig_nodes = [n for n in nodes if n["tags"].get("highway") == "traffic_signals" and corr.contains(Point(n["x"], n["z"]))]
# 30m 以内をまとめる（単連結）
P_ = np.array([[n["x"], n["z"]] for n in sig_nodes]); lab = -np.ones(len(P_), int); nl = 0
for i in range(len(P_)):
    if lab[i] >= 0: continue
    stack = [i]; lab[i] = nl
    while stack:
        k = stack.pop(); d = np.hypot(*(P_ - P_[k]).T)
        for j in np.nonzero((d < 30) & (lab < 0))[0]: lab[j] = nl; stack.append(j)
    nl += 1
node_cnt = {}
for w in road_ways:
    for nid in w["nodes"]: node_cnt[nid] = node_cnt.get(nid, 0) + 1
node_xy = {}
for w in road_ways:
    for nid, p in zip(w["nodes"], w["xy"]): node_xy[nid] = p
junc = np.array([node_xy[k] for k, c in node_cnt.items() if c >= 2]) if node_cnt else np.zeros((0, 2))
def _ang(v): return math.atan2(v[1], v[0])
def _adiff(a, b):
    d = (a - b) % (2 * math.pi); return min(d, 2 * math.pi - d)
n_sig = 0
for L in range(nl):
    cen0 = P_[lab == L].mean(0)
    dj = np.hypot(*(junc - cen0).T) if len(junc) else np.array([])
    near = junc[dj < 28] if len(dj) else np.zeros((0, 2))
    cen = near.mean(0) if len(near) else cen0
    # 腕: 中心から半径 16m の円を横切る道路の外向き方向
    RAD = 16.0; arms = []
    for k in rw_tree.query(Point(*cen).buffer(RAD + 2)):
        ln = rw_lines[k]; w = road_ways[k]
        cut = ln.intersection(Point(*cen).buffer(RAD).exterior)
        pts = [cut] if cut.geom_type == "Point" else (list(cut.geoms) if hasattr(cut, "geoms") else [])
        for pt in pts:
            if pt.geom_type != "Point": continue
            v = np.array([pt.x, pt.y]) - cen; v /= np.linalg.norm(v) + 1e-9
            arms.append(dict(ang=_ang(v), v=v, hw=_halfw(w), cls=w["tags"]["highway"]))
    # 同じ方向の腕（上下分離の車道など）をまとめる
    merged = []
    for am in sorted(arms, key=lambda q: -q["hw"]):
        for m in merged:
            if _adiff(am["ang"], m["ang"]) < math.radians(28): m["hw"] = max(m["hw"], am["hw"]); m["n"] += 1; break
        else: merged.append(dict(am, n=1))
    if len(merged) < 2: continue
    # 主方向: 軌道が通っていれば軌道の向き、なければ最も広い腕の向き
    tr_near = TRACKS.distance(Point(*cen)) < 20
    if tr_near:
        tl = min((g for g in (TRACKS.geoms if hasattr(TRACKS, "geoms") else [TRACKS])), key=lambda g: g.distance(Point(*cen)))
        s0 = tl.project(Point(*cen)); pa = tl.interpolate(max(0, s0 - 10)); pb = tl.interpolate(min(tl.length, s0 + 10))
        main_ang = _ang(np.array([pb.x - pa.x, pb.y - pa.y]))
    else:
        main_ang = max(merged, key=lambda m: m["hw"])["ang"]
    for m in merged:
        d_ = min(_adiff(m["ang"], main_ang), _adiff(m["ang"], main_ang + math.pi))
        m["ph"] = 0 if d_ < math.radians(45) else 1
    iid = len(ISECT)
    # オフセット: 交差点ごとに決まった値（実際の系統制御の値は非公開のため擬似的に）
    off = int((abs(hash((round(cen[0]), round(cen[1])))) % 1200) / 10)
    ISECT.append(dict(x=round(float(cen[0]), 1), z=round(float(cen[1]), 1), off=off, main=[round(math.cos(main_ang), 3), round(math.sin(main_ang), 3)]))
    for m in merged:
        dvec = -m["v"]                                   # 交差点へ向かう進行方向
        cross_hw = max([q["hw"] for q in merged if q["ph"] != m["ph"]] + [7.0])
        left = np.array([dvec[1], -dvec[0]])             # 進行方向の左（x=東, z=南）
        far = cen + dvec * (cross_hw + 3.0)
        base = raised_near(far, left, 18)
        if base is None: base = far + left * (m["hw"] + 1.0)
        if TRACKS.distance(Point(*base)) < 2.3: continue
        yb = surf(*base)
        sig_geo.append(cyl(base, 0.11, yb - 0.1, yb + 5.6))
        tip = base - left * min(5.0, max(2.5, np.linalg.norm(base - far) * 0.8))
        sig_geo.append(beam(base, tip, yb + 5.2, 0.1, 0.1))
        face = -dvec                                     # 近づく車に向ける
        c = tip; along = (tip - base) / (np.linalg.norm(tip - base) + 1e-9)
        box_ = Polygon([c - along * 0.7 - face * 0.18, c + along * 0.7 - face * 0.18, c + along * 0.7 + face * 0.18, c - along * 0.7 + face * 0.18])
        sig_geo.append(np.concatenate([tri_poly(box_, lambda x, z: yb + 5.0 + 0.45), tri_poly(box_, lambda x, z: yb + 5.0), extrude_ring(box_.exterior, lambda x, z: yb + 5.0, lambda x, z: yb + 5.45)]))
        # 横型3灯: 運転者から見て左から 青・黄・赤
        for k, col in enumerate(((0.1, 0.8, 0.5), (0.95, 0.75, 0.1), (0.9, 0.15, 0.1))):
            cc = c + left * (0.45 - 0.45 * k) + face * 0.19
            sig_heads.append(dict(p=[round(cc[0], 2), round(yb + 5.22, 2), round(cc[1], 2)], k=k, f=[round(face[0], 3), round(face[1], 3)], g=iid, ph=m["ph"]))
        n_sig += 1
sg = cat_(sig_geo)
add_chunk("signal", sg, col=tri_colors(len(sg) // 3, (0.28, 0.29, 0.30)), mat="color", file_key="cat")
manifest["signal_lamps"] = sig_heads
manifest["isects"] = ISECT
print("  intersections", len(ISECT), "signal heads", n_sig, flush=True)

# ================= 7b) バス停（OpenStreetMap の実位置） =================
print("bus stops...", flush=True); print("  [rss MB]", _rss(), flush=True)
bs_geo, bs_plate = [], []
KND = R["KIND"]
def nearest_walk(q, rad=8.0):
    i0 = int((q[0] - GX0) / RES); j0 = int((q[1] - GZ0) / RES); r = int(rad / RES)
    best = None
    for dj in range(-r, r + 1):
        for di in range(-r, r + 1):
            j, i = j0 + dj, i0 + di
            if 0 <= j < KND.shape[0] and 0 <= i < KND.shape[1] and KND[j, i] == 2:
                d = di * di + dj * dj
                if best is None or d < best[0]: best = (d, np.array([GX0 + (i + 0.5) * RES, GZ0 + (j + 0.5) * RES]))
    return None if best is None else best[1]
n_bs = 0
for n in nodes:
    if n["tags"].get("highway") != "bus_stop": continue
    q = np.array([n["x"], n["z"]])
    if not corr.contains(Point(*q)): continue
    base = q
    i = int((q[0] - GX0) / RES); j = int((q[1] - GZ0) / RES)
    if not (0 <= j < KND.shape[0] and 0 <= i < KND.shape[1]) or KND[j, i] != 2:
        base = nearest_walk(q)
        if base is None: continue
    if TRACKS.distance(Point(*base)) < 2.5: continue
    yb = surf(*base)
    bs_geo.append(cyl(base, 0.045, yb, yb + 2.3, 6))
    plate = Point(*base).buffer(0.28, 8)
    bs_plate.append(np.concatenate([tri_poly(plate, lambda x, z: yb + 2.3), tri_poly(plate, lambda x, z: yb + 2.38),
                                    extrude_ring(plate.exterior, lambda x, z: yb + 2.3, lambda x, z: yb + 2.38)]))
    box_ = Point(*base).buffer(0.2, cap_style=3)
    bs_geo.append(np.concatenate([tri_poly(box_, lambda x, z: yb + 1.6), extrude_ring(box_.exterior, lambda x, z: yb + 1.0, lambda x, z: yb + 1.6)]))
    n_bs += 1
if bs_geo:
    g_ = cat_(bs_geo); add_chunk("frn", g_, col=tri_colors(len(g_) // 3, (0.62, 0.63, 0.64)), mat="color", file_key="cat")
    g_ = cat_(bs_plate); add_chunk("frn", g_, col=tri_colors(len(g_) // 3, (0.20, 0.42, 0.72)), mat="color", file_key="cat")
print("  bus stops", n_bs, flush=True)

# ================= 8) 建物 =================
print("buildings...", flush=True); print("  [rss MB]", _rss(), flush=True)
_clr = prep(EXTD["clear"])
# v21: 電停のホームの上の PLATEAU の建物（旧 岡山駅前電停の上屋が地面までの箱になり、ホームがブロックで埋まっていた）は除く。
#   上屋はホームの側（platforms）で柱と屋根として作る
_PLAT_U = unary_union([Polygon(p_["xy"]).buffer(0.8) for p_ in T["platforms"] if not p_.get("bigroof")])
_platp = prep(_PLAT_U); _PLB = _PLAT_U.bounds
def _cleared(P):
    t = P.reshape(-1, 3, 3); c = t.mean(1)
    return np.array([((q[0] < -12.0) and _clr.contains(Point(q[0], q[2]))) or
                     (_PLB[0] < q[0] < _PLB[2] and _PLB[1] < q[2] < _PLB[3] and _platp.contains(Point(q[0], q[2]))) for q in c])
# v13: 天満屋バスステーション南側の連絡通路（2階の歩道橋）。PLATEAU では地面まで下りた箱になっていて、
# バスの周回路（駅舎の南の構内通路）と東西の道路をふさいでいた → 下端を地上 5.2m へ持ち上げ、下面を付ける
# （東側の道路の上、駅舎と天満屋本館を結ぶ連絡通路 z≒368〜374 も同じ）
_SKYS = [Polygon([(775.0, 459.75), (824.1, 459.65), (824.2, 462.25), (822.3, 462.95), (775.1, 465.15)]).buffer(0.25),
         Polygon([(809.8, 367.6), (828.1, 367.6), (828.1, 374.35), (809.8, 374.35)]).buffer(0.2)]
_SKY = unary_union(_SKYS)
_SKYp = prep(_SKY); _SKY_Y = 3.75 + 5.2
def _skylift(P):
    t = np.asarray(P, np.float64).reshape(-1, 3, 3)
    c = t.mean(1)
    if c[:, 0].max() < 770 or c[:, 0].min() > 832 or c[:, 2].max() < 362 or c[:, 2].min() > 470: return P
    m = np.array([_SKYp.contains(Point(q[0], q[2])) for q in c])
    if not m.any(): return P
    t = t.copy(); tt = t[m]; tt[:, :, 1] = np.maximum(tt[:, :, 1], _SKY_Y); t[m] = tt
    return t.reshape(np.asarray(P).shape).astype(np.asarray(P).dtype)
wall = {}; roof_pos, roof_col = [], []
tex_groups = {}
# ---- 岡山駅（東口の駅舎）とバスターミナル: PLATEAU の形状を使い、外観は写真に合わせて作り直す ----
# A=東口駅舎(高さ22m・長さ約380m) は写真の外観（白い外壁・窓の格子・最上部のガラス面）の専用外壁、
# B・C=駅舎の奥の棟は白い一般外壁、D・E・F=バスターミナル・乗り場の上屋は「屋根と柱」として作り直す（PLATEAU では地面までの箱）
STN = pickle.load(open("/home/claude/wx/station_geo.pkl", "rb"))
# v23: 32ab = 在来線ホームの上屋（PLATEAU では地面までの箱で、線路と列車を埋めていた）→ 屋根＋柱に。
#      c9f7 = 新幹線ホーム（高架の上）の西半分。下は在来線の線路（OSM 山陽本線）→ 下端を新幹線の高架の床版の下（標高 12.6m）まで持ち上げる
STN_LIFT = {"bldg_c9f7e625-ba88-4f84-8959-02807e631359": 12.6}
STN_ROLE = {"bldg_8783b583-597a-4e56-9c95-8bcb3e615f37": "face", "bldg_c9f7e625-ba88-4f84-8959-02807e631359": "plain",
            "bldg_32ab8d7c-81c6-464c-88bf-89048e280c18": "canopy", "bldg_cc73f594-b78a-45f9-89ab-0b21781f08a4": "canopy",
            "bldg_aa61b3a9-5a88-47e5-a7d8-59f614c4bd0e": "canopy", "bldg_4cc9b2c9-f7d4-44c1-bef8-7e394d86ec92": "canopy"}
_STN_FP = prep(unary_union([Polygon(q[:, [0, 2]]).buffer(0) for i_, polys in STN.items() if i_ in STN_ROLE for s_, q in polys if s_ == "GroundSurface"]).buffer(0.8))
def _stn(P):
    t = P.reshape(-1, 3, 3); c = t.mean(1)
    return np.array([_STN_FP.contains(Point(q[0], q[2])) for q in c])
def _plain_items():
    for f in sorted(glob.glob("/home/claude/wx/out_bldg/*.pkl")):
        d = pickle.load(open(f, "rb"))
        for it in d["plain"]: yield it, d
    # 駅舎の差し替え分
    from common import triangulate as _tri
    for bid, role in STN_ROLE.items():
        if role == "canopy": continue
        polys = STN[bid]; ys = np.concatenate([q[:, 1] for s_, q in polys]); base = float(ys.min()); top = float(ys.max())
        lift = STN_LIFT.get(bid)
        for s_, q in polys:
            if len(q) < 3: continue
            if s_ == "GroundSurface" and lift is None: continue
            v_, ix = _tri([q])
            if v_ is None: continue
            tri = v_[ix.reshape(-1)].astype(np.float32)
            if lift is not None:
                tri = tri.copy(); tri[:, 1] = np.maximum(tri[:, 1], lift)
                if s_ == "GroundSurface":      # 下面（下向き）
                    t3 = tri.reshape(-1, 3, 3); nz_ = np.cross(t3[:, 1] - t3[:, 0], t3[:, 2] - t3[:, 0])[:, 1]
                    t3[nz_ > 0] = t3[nz_ > 0][:, [0, 2, 1]]; tri = t3.reshape(-1, 3)
            if role == "face": yield (tri, np.array([0.95, 0.95, 0.94], np.float32), "wall" if s_ == "WallSurface" else "roof", base, top - base, "station"), None
            else: yield (tri, np.array([0.88, 0.88, 0.86], np.float32), "wall" if s_ == "WallSurface" else "roof", base, 4.2, "office"), None
_STN_BB = (-275.0, -345.0, -25.0, 145.0)
def _stn_fast(P):
    t = P.reshape(-1, 3, 3)
    if t[:, :, 0].max() < _STN_BB[0] or t[:, :, 0].min() > _STN_BB[2] or t[:, :, 2].max() < _STN_BB[1] or t[:, :, 2].min() > _STN_BB[3]:
        return np.zeros(len(t), bool)
    return _stn(P)
for f in sorted(glob.glob("/home/claude/wx/out_bldg/*.pkl")):
    d = pickle.load(open(f, "rb"))
    for img, L in d["tex"].items():
        for p_, u_ in L:
            p_ = _skylift(p_)
            k_ = ~_cleared(p_) & ~_stn_fast(p_) & ~_gard(p_.reshape(-1, 3, 3))
            if k_.any(): tex_groups.setdefault(img, []).append((p_.reshape(-1, 3, 3)[k_].reshape(-1, 3), u_.reshape(-1, 3, 2)[k_].reshape(-1, 2)))
# v29: v28 の写真外壁のアトラスを変えないため、v28 の建物（out_bldg_core）で使っていた画像と、その重心（v28 と同じ計算）を求める
TEX_OLD = {}
_OBC = "/home/claude/wx/out_bldg_core"
if os.path.isdir(_OBC):
    for f in sorted(glob.glob(_OBC + "/*.pkl")):
        d = pickle.load(open(f, "rb"))
        for img, L in d["tex"].items():
            for p_, u_ in L:
                p_ = _skylift(p_)
                k_ = ~_cleared(p_) & ~_stn_fast(p_) & ~_gard(p_.reshape(-1, 3, 3))
                if k_.any(): TEX_OLD.setdefault(img, []).append(p_.reshape(-1, 3, 3)[k_].reshape(-1, 3))
    # 画像のパスは v28 では /tmp/p25/…、今回は /home/claude/wx/p25/…（同じファイル）。p25/ から後ろで照合する
    _pk = lambda s_: s_.split("/p25/", 1)[-1]
    TEX_OLD = {_pk(img): np.concatenate(L)[:, [0, 2]].mean(0) for img, L in TEX_OLD.items()}
    print("  v28 facade images", len(TEX_OLD), "now", len(tex_groups), flush=True)
    # v30: 重心を保存（out_bldg_core が無くても同じアトラスを作れるように。tools/work/core にも入れる）
    json.dump({k_: [float(v_[0]), float(v_[1])] for k_, v_ in TEX_OLD.items()}, open("/home/claude/wx/tex_old_centroids.json", "w"))
elif os.path.exists("/home/claude/wx/tex_old_centroids.json"):
    _pk = lambda s_: s_.split("/p25/", 1)[-1]
    TEX_OLD = {k_: np.array(v_, np.float64) for k_, v_ in json.load(open("/home/claude/wx/tex_old_centroids.json")).items()}
    print("  v28 facade images (json)", len(TEX_OLD), "now", len(tex_groups), flush=True)
_plinth = []   # v32: 建物の基礎（壁の下端が地面より高い所）
for (p, c, kind, base_y, floor_h, variant), d in _plain_items():
    if True:
        t = _skylift(p).reshape(-1, 3, 3).astype(np.float64)
        _k = ~_cleared(t) & (~_stn_fast(t) if d is not None else np.ones(len(t), bool)) & ~_gard(t)
        if not _k.any(): continue
        t = t[_k]
        if kind == "wall" and d is not None and np.array_equal(np.asarray(p, np.float64).reshape(-1, 3, 3)[_k], t):   # 持ち上げた連絡通路・駅舎は除く
            _pp = STR.building_plinths([(t.reshape(-1, 3), c, kind, base_y, floor_h, variant)], _GR, 0.05, log=lambda *a: None)
            if len(_pp[0]): _plinth.append(_pp)
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]); ln_ = np.linalg.norm(n, axis=1) + 1e-12
        vert = np.abs(n[:, 1]) / ln_ < 0.35
        if (~vert).any():
            roof_pos.append(t[~vert].reshape(-1, 3).astype(np.float32)); roof_col.append(np.repeat(np.asarray(c, np.float32)[None, :], (~vert).sum() * 3, 0))
        if vert.any():
            tv = t[vert]; nv = n[vert]
            h = np.stack([-nv[:, 2], np.zeros(len(nv)), nv[:, 0]], 1); h /= (np.linalg.norm(h, axis=1)[:, None] + 1e-12)
            mod = {"office": 3.6, "apt": 3.6, "warehouse": 6.0, "temple": 3.0, "house_old": 1.8, "station": 6.3}.get(variant, 2.7)
            u = (tv[:, :, 0] * h[:, None, 0] + tv[:, :, 2] * h[:, None, 2]) / mod
            v = (tv[:, :, 1] - base_y) / floor_h
            u = u - np.floor(u.min(axis=1))[:, None]
            W = wall.setdefault(variant, [[], [], []])
            W[0].append(tv.reshape(-1, 3).astype(np.float32)); W[1].append(np.stack([u, v], -1).reshape(-1, 2)); W[2].append(np.repeat(np.asarray(c, np.float32)[None, :], len(tv) * 3, 0))
_sky_under = []
for _sp in _SKYS:
    _sv = np.array(_sp.buffer(-0.2).exterior.coords)[:-1]
    _sidx = np.asarray(earcut.triangulate_float64(_sv, np.array([len(_sv)], np.uint32))).reshape(-1, 3)
    for a_, b_, c_ in _sidx:
        pa, pb, pc = _sv[a_], _sv[b_], _sv[c_]
        cr = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
        if cr < 0: pb, pc = pc, pb          # 下向き
        _sky_under += [[q[0], _SKY_Y, q[1]] for q in (pa, pb, pc)]
add_chunk("bldg", np.array(_sky_under), col=tri_colors(len(_sky_under) // 3, (0.62, 0.62, 0.60)), mat="color", file_key="bldg_plain")
for variant, (P_, U_, C_) in wall.items():
    add_chunk("bldg", np.concatenate(P_), uv=np.concatenate(U_), col=np.concatenate(C_), mat="facade_" + variant, file_key="bldg_plain", uv_int=True)
WALL_COUNT = {k: sum(len(x) for x in v[0]) // 3 for k, v in wall.items()}; del wall   # v29: メモリ
if _plinth:
    _pp = np.concatenate([q[0] for q in _plinth]); _pc = np.concatenate([q[1] for q in _plinth])
    add_chunk("bldg", _pp, col=_pc, mat="color", file_key="bldg_plain")
    print("  v32 building plinths: tris", len(_pp) // 3, "walls", len(_plinth), flush=True)
    del _pp, _pc
del _plinth
# ---- v11: 写真テクスチャの建物を「くっきり表示」で描く版（外壁=推定色＋窓割りの外壁、屋根=航空写真） ----
wallP = {}; roofP_pos = []
def _proc_items():
    for f in sorted(glob.glob("/home/claude/wx/out_bldg/*.pkl")):
        d = pickle.load(open(f, "rb"))
        for it in d.get("proc", []): yield it, d
_MOD = {"office": 3.6, "apt": 3.6, "warehouse": 6.0, "temple": 3.0, "house_old": 1.8, "station": 6.3, "curtain": 3.2}
def _fix_col(c):
    """写真から推定した外壁色の補正: 全体の色かぶり（やや青緑）を除き、日陰で暗く写った分を明るく、彩度を少し戻す"""
    c = np.asarray(c, float) * np.array([1.018, 0.982, 1.0])
    L = float(c @ np.array([0.3, 0.59, 0.11])) + 1e-6
    L2 = float(np.clip(0.74 * (L / 0.545) ** 0.75, 0.25, 0.95))
    c = c * (L2 / L)
    c = L2 + (c - L2) * 1.25
    return np.clip(c, 0.08, 0.97)
for (p, c, kind, base_y, floor_h, variant), d in _proc_items():
    t = _skylift(p).reshape(-1, 3, 3).astype(np.float64)
    _k = ~_cleared(t) & ~_stn_fast(t) & ~_gard(t)
    if not _k.any(): continue
    t = t[_k]
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]); ln_ = np.linalg.norm(n, axis=1) + 1e-12
    vert = np.abs(n[:, 1]) / ln_ < 0.35
    if (~vert).any(): roofP_pos.append(t[~vert].reshape(-1, 3).astype(np.float32))
    if vert.any():
        tv = t[vert]; nv = n[vert]
        h = np.stack([-nv[:, 2], np.zeros(len(nv)), nv[:, 0]], 1); h /= (np.linalg.norm(h, axis=1)[:, None] + 1e-12)
        mod = _MOD.get(variant, 2.7)
        u = (tv[:, :, 0] * h[:, None, 0] + tv[:, :, 2] * h[:, None, 2]) / mod
        v = (tv[:, :, 1] - base_y) / floor_h
        u = u - np.floor(u.min(axis=1))[:, None]
        W = wallP.setdefault(variant, [[], [], []])
        W[0].append(tv.reshape(-1, 3).astype(np.float32)); W[1].append(np.stack([u, v], -1).reshape(-1, 2)); W[2].append(np.repeat(_fix_col(c)[None, :], len(tv) * 3, 0))
for variant, (P_, U_, C_) in wallP.items():
    add_chunk("bldg", np.concatenate(P_), uv=np.concatenate(U_), col=np.concatenate(C_), mat="facade_" + variant, file_key="bldg_proc", uv_int=True)
print("  crisp walls", {k: sum(len(x) for x in v[0]) // 3 for k, v in wallP.items()}, flush=True)
del wallP   # v29: メモリ
# ---- バスターミナル・乗り場の上屋（屋根板＋青い柱。下は吹き抜け） ----
from common import triangulate as _tri2
can_top, can_bot, can_edge, can_col = [], [], [], []
can_col2 = []   # v23: 在来線ホームの上屋の柱（灰色）
# v23: JR の本線（OSM）。上屋の柱を線路の上に立てないため
from jr_lines import chains as _jr_chains
_JRT = unary_union([LineString(P_) for _k, _res in _jr_chains().items() for P_, _t, _L in _res])
# 在来線の全ての線路（側線・構内の線を含む。岡山駅のホームの間の線路）
import osm_load as _ol
_RAILALL = unary_union([LineString(w_["xy"]) for w_ in _ol.load()[0] if w_["tags"].get("railway") == "rail" and w_["tags"].get("name") != "山陽新幹線" and len(w_["xy"]) >= 2
                        and (np.asarray(w_["xy"])[:, 0] > -330).any() and (np.asarray(w_["xy"])[:, 0] < 60).any() and (np.asarray(w_["xy"])[:, 1] > -360).any() and (np.asarray(w_["xy"])[:, 1] < 200).any()])
_RAILB = _RAILALL.buffer(1.6, cap_style=2)
# 在来線のホーム（上屋 32ab の屋根の下で、線路（両側 1.6m）を除いた所。高さはレール面＋1.0m）
_plat_poly = []; _plat_roof = []
for s_, q in STN["bldg_32ab8d7c-81c6-464c-88bf-89048e280c18"]:
    if s_ == "RoofSurface" and len(q) >= 3:
        _pp = Polygon(q[:, [0, 2]]).buffer(0)
        if not _pp.is_empty: _plat_poly.append(_pp); _plat_roof.append((_pp, float(q[:, 1].mean())))
_PLAT = unary_union(_plat_poly).buffer(0.3).buffer(-0.6).difference(_RAILB)
_PLAT = [g for g in (list(_PLAT.geoms) if hasattr(_PLAT, "geoms") else [_PLAT]) if g.area > 30 and g.buffer(-1.0).area > 0]
_PLATU = unary_union(_PLAT)
_pt_top, _pt_side = [], []
for g in _PLAT:
    _pt_top.append(tri_poly(g, lambda x, z: surf(x, z) + 1.25))
    for ring in [g.exterior] + list(g.interiors):
        _pt_side.append(extrude_ring(ring, lambda x, z: surf(x, z) - 0.1, lambda x, z: surf(x, z) + 1.25))
if _pt_top:
    add_chunk("bldg", cat_(_pt_top), col=tri_colors(len(cat_(_pt_top)) // 3, (0.74, 0.72, 0.68), 0.03, 5), mat="color", file_key="bldg_plain")
    add_chunk("bldg", cat_(_pt_side), col=tri_colors(len(cat_(_pt_side)) // 3, (0.62, 0.61, 0.58), 0.02), mat="color", file_key="bldg_plain")
# 上屋の柱: ホームの中心線上に 10m おき（線路から 2m 以上離す）
for g in _PLAT:
    rr = g.minimum_rotated_rectangle; cc = np.array(rr.exterior.coords)[:-1]
    e1 = cc[1] - cc[0]; e2 = cc[2] - cc[1]
    lg, sh, a0 = (e1, e2, cc[0] + e2 / 2) if np.linalg.norm(e1) > np.linalg.norm(e2) else (e2, e1, cc[1] + e1 / 2)
    if np.linalg.norm(sh) < 3.0: continue
    L_ = np.linalg.norm(lg)
    for k in range(int(L_ // 10) + 1):
        pt = a0 + lg * ((5 + k * 10) / L_) if L_ > 10 else a0 + lg * 0.5
        P_ = Point(*pt)
        if not g.buffer(-0.5).contains(P_) or _RAILALL.distance(P_) < 2.0: continue
        yr = [yy for pp, yy in _plat_roof if pp.contains(P_)]
        if not yr: continue
        yb = surf(*pt) + 1.25
        if max(yr) - 0.35 - yb < 2.2: continue
        can_col2.append(cyl(pt, 0.16, yb - 0.05, max(yr) - 0.35, 10))
print("  JR conventional platforms", len(_PLAT), "area", round(_PLATU.area), "columns", len(can_col2), flush=True)
def _clr_pt(x, z): return x < -12.0 and _clr.contains(Point(x, z))
for bid, role in STN_ROLE.items():
    if role != "canopy": continue
    for s_, q in STN[bid]:
        if s_ != "RoofSurface" or len(q) < 3: continue
        v_, ix = _tri2([q])
        if v_ is None: continue
        tri = v_[ix.reshape(-1)].reshape(-1, 3, 3)
        keep = np.array([not _clr_pt(c[0], c[2]) for c in tri.mean(1)])
        if not keep.any(): continue
        tri = tri[keep]
        can_top.append(tri.reshape(-1, 3))
        bt = tri[:, [0, 2, 1]].copy(); bt[:, :, 1] -= 0.35; can_bot.append(bt.reshape(-1, 3))
        P2 = Polygon(q[:, [0, 2]]).buffer(0)
        if P2.is_empty or P2.area < 2: continue
        ytop = lambda x, z, q=q: float(np.interp(0, [0], [q[:, 1].mean()]))
        yroof = float(q[:, 1].mean())
        for ring in ([P2.exterior] if isinstance(P2, Polygon) else [g.exterior for g in P2.geoms]):
            can_edge.append(extrude_ring(ring, lambda x, z: yroof - 0.45, lambda x, z: yroof + 0.05))
        # 柱: 細長い上屋は中心線上、幅のある上屋は縁の内側に 7m 間隔
        rr = P2.minimum_rotated_rectangle; cc = np.array(rr.exterior.coords)[:-1]
        e1 = cc[1] - cc[0]; e2 = cc[2] - cc[1]; wid = min(np.linalg.norm(e1), np.linalg.norm(e2))
        if wid < 6.0:
            lg, sh = (e1, e2) if np.linalg.norm(e1) > np.linalg.norm(e2) else (e2, e1)
            a0 = cc[0] + sh / 2 if np.linalg.norm(e1) > np.linalg.norm(e2) else cc[1] + sh / 2
            L_ = np.linalg.norm(lg); n_ = max(2, int(L_ // 7) + 1)
            pts = [a0 + lg * (0.06 + 0.88 * k / (n_ - 1)) for k in range(n_)]
        else:
            ins = P2.buffer(-0.8)
            rings_ = [ins.exterior] if isinstance(ins, Polygon) and not ins.is_empty else ([g.exterior for g in ins.geoms] if hasattr(ins, "geoms") else [])
            pts = []
            for rg in rings_:
                for k in range(int(rg.length // 7.5) + 1):
                    pp = rg.interpolate(k * 7.5); pts.append(np.array([pp.x, pp.y]))
        for pt in pts:
            if not P2.buffer(0.1).contains(Point(*pt)) or _clr_pt(*pt) or TRACKS.distance(Point(*pt)) < 2.2 or _JRT.distance(Point(*pt)) < 2.4: continue
            yb = surf(*pt)
            if yroof - 0.35 - yb < 2.2: continue
            if bid.startswith("bldg_32ab"): continue      # 在来線ホームの柱は上（ホームの中心線上）で作った
            (can_col2 if bid.startswith("bldg_32ab") else can_col).append(cyl(pt, 0.16 if bid.startswith("bldg_32ab") else 0.14, yb - 0.05, yroof - 0.35, 10))
add_chunk("bldg", cat_(can_top), col=tri_colors(len(cat_(can_top)) // 3, (0.58, 0.59, 0.61), 0.02), mat="color", file_key="bldg_plain")
add_chunk("bldg", cat_(can_bot), col=tri_colors(len(cat_(can_bot)) // 3, (0.88, 0.88, 0.86), 0.01), mat="color", file_key="bldg_plain")
add_chunk("bldg", cat_(can_edge), col=tri_colors(len(cat_(can_edge)) // 3, (0.93, 0.93, 0.92), 0.01), mat="color", file_key="bldg_plain")
add_chunk("bldg", cat_(can_col), col=tri_colors(len(cat_(can_col)) // 3, (0.24, 0.45, 0.68), 0.02), mat="color", file_key="bldg_plain")
if can_col2: add_chunk("bldg", cat_(can_col2), col=tri_colors(len(cat_(can_col2)) // 3, (0.72, 0.73, 0.74), 0.02), mat="color", file_key="bldg_plain")
print("  bus terminal canopies: slabs", len(cat_(can_top)) // 3, "columns", len(can_col), flush=True)
# ---- 駅名の看板（東口の中央）: 白いタイル張りの壁面に「岡山駅 OKAYAMA STATION」 ----
_A = STN["bldg_8783b583-597a-4e56-9c95-8bcb3e615f37"]
_Ag = Polygon([q for s_, q in _A if s_ == "GroundSurface"][0][:, [0, 2]]).buffer(0)
_Ab = min(q[:, 1].min() for s_, q in _A); _At = max(q[:, 1].max() for s_, q in _A)
_zc = -15.0
_ln = LineString([(-400, _zc), (100, _zc)]).intersection(_Ag.exterior)
_xs = [g.x for g in (_ln.geoms if hasattr(_ln, "geoms") else [_ln]) if g.geom_type == "Point"]
if _xs:
    q0 = np.array([max(_xs), _zc])
    sB = _Ag.exterior.project(Point(*q0)); pa = _Ag.exterior.interpolate(sB - 3); pb = _Ag.exterior.interpolate(sB + 3)
    tv = np.array([pb.x - pa.x, pb.y - pa.y]); tv /= np.linalg.norm(tv)
    nv = np.array([tv[1], -tv[0]])
    if _Ag.contains(Point(*(q0 + nv * 1.0))): nv = -nv          # 外向き（広場側）
    c0 = q0 + nv * 0.25; W_ = 22.0; y0 = _Ab + 6.5; y1 = min(_At - 1.0, _Ab + 17.5)
    a_ = c0 - tv * W_ / 2; b_ = c0 + tv * W_ / 2
    # 外から見て左→右が u=0→1 になるよう並べる
    if np.cross(np.r_[b_ - a_, 0.0][[0, 1, 2]] if False else [b_[0] - a_[0], b_[1] - a_[1], 0], [nv[0], nv[1], 0])[2] > 0: a_, b_ = b_, a_
    quad = np.array([[a_[0], y0, a_[1]], [b_[0], y0, b_[1]], [b_[0], y1, b_[1]], [a_[0], y0, a_[1]], [b_[0], y1, b_[1]], [a_[0], y1, a_[1]]])
    quv = np.array([[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]], float)
    add_chunk("bldg", quad, uv=quv, mat="stationsign", file_key="bldg_plain")
    add_chunk("bldg", quad[[0, 2, 1, 3, 5, 4]], uv=quv[[0, 2, 1, 3, 5, 4]], mat="stationsign", file_key="bldg_plain")
    print("  station sign at", c0.round(1), "normal", nv.round(2), flush=True)
# 屋根: 航空写真を真上から投影（ページ別）
RP = np.concatenate(roof_pos).astype(np.float64); RC = np.concatenate(roof_col).astype(np.float64); del roof_pos, roof_col
rt = RP.reshape(-1, 3, 3); cen = rt.mean(1)
pg = pages_of(cen[:, 0], cen[:, 2])
for pi in np.unique(pg):
    m = pg == pi
    if pi < 0:
        add_chunk("bldg", rt[m].reshape(-1, 3), col=RC.reshape(-1, 3, 3)[m].reshape(-1, 3) * 0.85, mat="color", file_key="bldg_plain")
        continue
    P0 = pages[pi]
    pos = rt[m].reshape(-1, 3)
    uv = np.stack([(pos[:, 0] - P0["x0"]) / P0["size"], 1 - (pos[:, 2] - P0["z0"]) / P0["size"]], 1)
    add_chunk("bldg", pos, uv=uv, mat="ortho", page=int(pi), file_key="bldg_plain")

if roofP_pos:
    rtP = np.concatenate(roofP_pos).astype(np.float64).reshape(-1, 3, 3); cenP = rtP.mean(1); del roofP_pos
    pgP = pages_of(cenP[:, 0], cenP[:, 2])
    for pi in np.unique(pgP):
        m = pgP == pi
        if pi < 0:
            add_chunk("bldg", rtP[m].reshape(-1, 3), col=tri_colors(int(m.sum()), (0.55, 0.55, 0.54)), mat="color", file_key="bldg_proc"); continue
        P0 = pages[pi]; pos = rtP[m].reshape(-1, 3)
        uv = np.stack([(pos[:, 0] - P0["x0"]) / P0["size"], 1 - (pos[:, 2] - P0["z0"]) / P0["size"]], 1)
        add_chunk("bldg", pos, uv=uv, mat="ortho", page=int(pi), file_key="bldg_proc")
# ================= v17: ランドマーク（後楽園の建物・土塀、岡山城の石垣・金鯱） =================
print("landmarks...", flush=True); print("  [rss MB]", _rss(), flush=True)
_GB = LMK.garden_buildings(_LDEM)
_gwp, _gwu, _grp, _gru, _grc, _gtp = _GB
if len(_gwp): add_chunk("bldg", _gwp, uv=_gwu, mat="wafu", file_key="bldg_plain", uv_int=True)
if len(_grp):
    _gru2 = np.stack([np.zeros(len(_gru)), _gru[:, 1]], 1)
    add_chunk("bldg", _grp, uv=_gru2, col=_grc, mat="kawara", file_key="bldg_plain", uv_int=True)
if len(_gtp): add_chunk("bldg", _gtp, col=tri_colors(len(_gtp) // 3, (0.24, 0.19, 0.15)), mat="color", file_key="bldg_plain")
_dwp, _dwc = LMK.garden_walls(ways, _LDEM)
if len(_dwp): add_chunk("bldg", _dwp, col=_dwc, mat="color", file_key="bldg_plain")
if len(LM_FACE): add_chunk("bldg", LM_FACE, uv=LM_FUV, mat="ishigaki", file_key="bldg_plain", uv_int=True)
if len(LM_CAP):
    _ct = LM_CAP.reshape(-1, 3, 3); _cc = _ct.mean(1)
    _cpg = np.array([page_of(c[0], c[2]) if page_of(c[0], c[2]) is not None else -1 for c in _cc])
    for pi in np.unique(_cpg):
        m = _cpg == pi
        if pi < 0: continue
        P0 = pages[pi]; pos = _ct[m].reshape(-1, 3)
        uv = np.stack([(pos[:, 0] - P0["x0"]) / P0["size"], 1 - (pos[:, 2] - P0["z0"]) / P0["size"]], 1)
        add_chunk("lmcap", pos, uv=uv, mat="ortho", page=int(pi), file_key="bldg_plain")
_tx0, _tz0, _tx1, _tz1 = LMK.TENSHU.bounds
_tt = [p_.reshape(-1, 3, 3) for L_ in tex_groups.values() for p_, u_ in L_
       if p_[:, 0].max() > _tx0 - 5 and p_[:, 0].min() < _tx1 + 5 and p_[:, 2].max() > _tz0 - 5 and p_[:, 2].min() < _tz1 + 5]
_sh = LMK.shachi([t for a in _tt for t in a]) if _tt else np.zeros((0, 3))
if len(_sh): add_chunk("bldg", _sh, col=tri_colors(len(_sh) // 3, (0.95, 0.76, 0.3)), mat="gold", file_key="bldg_plain")
# ---- 車モード用: 2m 格子の路面高さ(cm)と区分（0=地面 1=車道 2=歩道・島 9=建物） ----
print("drive grid...", flush=True); print("  [rss MB]", _rss(), flush=True)
DG = 2.0; dnx = int(nx * DSTEP / DG); dnz = int(nz * DSTEP / DG)
gx = DX0 + (np.arange(dnx) + 0.5) * DG; gz = DZ0 + (np.arange(dnz) + 0.5) * DG
# v30: 範囲拡大（2m 格子で 2600 万升）のため、行の帯ごとに求める。道路の縁の穴埋め（1.5 升以内）のため上下に 3 行の余白。結果は全体で求めた時と同じ
DH_ = np.zeros((dnz, dnx), np.float64); DC_ = np.zeros((dnz, dnx), np.uint8)
_KRD = R["KIND"]; _SB = 256; _SM = 3
for _b0 in range(0, dnz, _SB):
    _b1s = min(dnz, _b0 + _SB); _e0 = max(0, _b0 - _SM); _e1 = min(dnz, _b1s + _SM); _sl = slice(_b0 - _e0, _b1s - _e0)
    GXX, GZZ = np.meshgrid(gx, gz[_e0:_e1])
    fi = (GXX - DX0) / DSTEP; fj = (GZZ - DZ0) / DSTEP
    i0 = np.clip(np.floor(fi).astype(int), 0, nx - 2); j0 = np.clip(np.floor(fj).astype(int), 0, nz - 2)
    tx = np.clip(fi - i0, 0, 1); tz = np.clip(fj - j0, 0, 1)
    Hgv = (Hg[j0, i0] * (1 - tx) + Hg[j0, i0 + 1] * tx) * (1 - tz) + (Hg[j0 + 1, i0] * (1 - tx) + Hg[j0 + 1, i0 + 1] * tx) * tz - 0.12
    del fi, fj, i0, j0, tx, tz
    ri = np.clip(((GXX - GX0) / RES).astype(int), 0, HR.shape[1] - 1); rj = np.clip(((GZZ - GZ0) / RES).astype(int), 0, HR.shape[0] - 1)
    hr = np.asarray(HR[rj, ri]); kd = np.asarray(_KRD[rj, ri]); del ri, rj
    # v13: 道路の縁の格子（中心が道路の外）は、近くの路面の高さでふさぐ（狭い道で地面との高さの差が段差・揺れになっていた）
    _hn = ~np.isfinite(hr)
    if _hn.any() and (~_hn).any():
        _dist, (_ji, _ii) = ndimage.distance_transform_edt(_hn, return_indices=True)
        _fill = hr[_ji, _ii]
        _ok = _hn & (_dist <= 1.5) & ~((GXX > -165) & (GXX < 5) & (GZZ > -60) & (GZZ < 125))   # 駅前広場は除く
        hr = np.where(_ok, _fill, hr)
        kd = np.where(_ok, 0, kd)
        del _dist, _ji, _ii, _fill, _ok
    hr = hr[_sl]; kd = kd[_sl]; Hgv = Hgv[_sl]; GXs = GXX[_sl]; GZs = GZZ[_sl]; del GXX, GZZ
    _dh = np.where(np.isfinite(hr), hr, Hgv).astype(np.float64)
    m_ext = (GXs > -145) & (GXs < 0) & (GZs > -50) & (GZs < 35) & np.isfinite(hr)
    for j_, i_ in zip(*np.nonzero(m_ext)): _dh[j_, i_] += ext_delta(GXs[j_, i_], GZs[j_, i_])
    DH_[_b0:_b1s] = _dh; DC_[_b0:_b1s] = np.where(np.isfinite(hr), kd, 0).astype(np.uint8)
    del hr, kd, Hgv, GXs, GZs, _dh, m_ext, _hn
# v41.20: トンネルの床の升目（高さ・区分=1）
_ntc = 0
for _t in TUNNELS:
    _jj, _ii, _vv = TUN.raster_cells(_t, _t["floor_poly"], DX0, DZ0, DG, dnx, dnz, "floor")
    if len(_jj): DH_[_jj, _ii] = _vv; DC_[_jj, _ii] = 1; _ntc += len(_jj)
print("  drive grid tunnel floor cells", _ntc, flush=True)
# v41.20: トンネルの両端の外側 7m（PLATEAU の道路の面が坑口から数 m 離れて始まる所の隙間）で、走行格子が地面（切土の法面）の高さになって
#   1m ほどの盛り上がりになっていた。隙間の升目（道路が無く、地面の高さで埋まっている升目）だけ、端の床の高さで埋める
_nte = 0
for _t in TUNNELS:
    for _pe, _ze, _gq in _t["gaps"]:   # tunnels.py の gaps: （端の位置, 端の床の高さ, 端の床の縁を外向きに 7m 延ばした四角）
        _q = _gq.difference(_t["floor_poly"])
        _jj, _ii, _vv = TUN.raster_cells(_t, _q, DX0, DZ0, DG, dnx, dnz, float(_ze) + TUN.FLOOR_LIFT)
        if not len(_jj): continue
        _sel = DC_[_jj, _ii] == 0
        DH_[_jj[_sel], _ii[_sel]] = _vv[_sel]; DC_[_jj[_sel], _ii[_sel]] = 1; _nte += int(_sel.sum())
print("  drive grid tunnel end-gap cells", _nte, flush=True)
import gc as _gc; _gc.collect()
_rtl = [RP.reshape(-1, 3, 3)]
for L_ in tex_groups.values():
    for p_, u_ in L_:
        t_ = p_.reshape(-1, 3, 3); n_ = np.cross(t_[:, 1] - t_[:, 0], t_[:, 2] - t_[:, 0])
        up_ = np.abs(n_[:, 1]) / (np.linalg.norm(n_, axis=1) + 1e-12) > 0.35
        if up_.any(): _rtl.append(t_[up_])
_rtl.append(_grp.reshape(-1, 3, 3))
_rt = np.concatenate(_rtl); del _rtl
if os.environ.get("DUMP_RT"): np.save("/home/claude/wx/dbg_rt.npy", _rt)   # 試験用
import cv2 as _cv2
def _tri_pts(step):
    """三角形群（_rt）の頂点を塗り用の固定小数点（1/8 画素）に。z の範囲（行）も返す"""
    pts = np.round(np.stack([(_rt[:, :, 0] - DX0) / step, (_rt[:, :, 2] - DZ0) / step], -1) * 8).astype(np.int32)
    return pts, pts[:, :, 1].min(1) >> 3, (pts[:, :, 1].max(1) >> 3) + 1
def _fill_rows(ptsz, w, r0, r1, fullh=None):
    """行 r0..r1 の帯だけ塗る（頂点を整数の画素だけずらすので、全体を塗った時と同じ画素になる）。
    帯に掛かる三角形は画像の上下の端で切られないよう、三角形の全体が入る高さの画像に塗ってから帯を切り出す
    （cv2 は画像の外に出る多角形を切る時に辺の位置が少し変わるため。全体の画像の上下端は全体の時と同じく切る）"""
    pts, zlo, zhi = ptsz
    fullh = r1 if fullh is None else fullh
    sel = np.nonzero((zhi >= r0 - 1) & (zlo <= r1 + 1))[0]
    if not len(sel): return np.zeros((r1 - r0, w), np.uint8)
    R0 = max(0, min(r0, int(zlo[sel].min()) - 2)); R1 = min(fullh, max(r1, int(zhi[sel].max()) + 2))
    img = np.zeros((R1 - R0, w), np.uint8)
    # cv2.fillPoly は 1 回の呼び出しの中で重なる多角形を偶奇で塗る（重なりが抜ける）。v29 と同じ結果にするため、
    # 全体を 20 万個ずつ塗っていた時と同じ組（元の番号 // 200000）ごとに呼ぶ
    grp = sel // 200000
    for g in np.unique(grp):
        s_ = sel[grp == g]; p_ = pts[s_].copy(); p_[:, :, 1] -= R0 * 8
        _cv2.fillPoly(img, list(p_), 255, lineType=_cv2.LINE_8, shift=3)
    return img[r0 - R0:r1 - R0]
def _fill_tris(shape, step):
    return _fill_rows(_tri_pts(step), shape[1], 0, shape[0])
_bmask = _fill_tris((dnz, dnx), DG) > 0
# v20: 道路の上の 2 階の連絡通路（下端を地上 5.2m へ持ち上げた _SKYS）は、下を車・バスが通れるので建物扱いにしない
def _sky_rows(w, step, r0, r1):
    im = Image.new("L", (w, r1 - r0), 0); dr_ = ImageDraw.Draw(im)
    for sp_ in _SKYS: dr_.polygon([((x - DX0) / step, (z - DZ0) / step - r0) for x, z in sp_.exterior.coords], fill=255)
    return np.array(im) > 0
def _sky_raster(shape, step): return _sky_rows(shape[1], step, 0, shape[0])
_bmask &= ~_sky_raster((dnz, dnx), DG)
# 道路上に張り出した建物（デッキ等）は通れるよう、車道セルは建物扱いにしない
DC_[_bmask & (DC_ != 1)] = 9
del _bmask
# v14: 衝突判定用の細かい建物マスク（1m・ビット列）。2m 格子では狭い道の縁が建物扱いになり、当たっていないのに衝突していた。
# 屋根の輪郭（軒の出を含む）を 0.5m で描き 0.5m 内側へ縮め、車道（KIND==1）の所は除く。
# v30: 0.5m の格子（範囲拡大で 4 億升）は、行の帯（1024 行＋上下 2 行の余白）ごとに求める（結果は全体の時と同じ）
_FS = 0.5; _fnx = int(round(nx * DSTEP / _FS)); _fnz = int(round(nz * DSTEP / _FS))
_KR = R["KIND"]
_oi = int(round((DX0 - GX0) / RES)); _oj = int(round((DZ0 - GZ0) / RES))
assert _oi >= 0 and _oj >= 0
_h = min(_fnz, _KR.shape[0] - _oj); _w = min(_fnx, _KR.shape[1] - _oi)
_ptsF = _tri_pts(_FS)
_b1L = []; _fmL = []
_FB = 1024
for _r0 in range(0, _fnz, _FB):
    _r1 = min(_fnz, _r0 + _FB); _q0 = max(0, _r0 - 2); _q1 = min(_fnz, _r1 + 2)
    _ft = _fill_rows(_ptsF, _fnx, _q0, _q1, _fnz) > 0
    _fm = ndimage.binary_erosion(_ft, iterations=1)[_r0 - _q0:_r1 - _q0]; del _ft
    _kr = np.zeros_like(_fm)
    _a = min(_r1, _h)
    if _a > _r0: _kr[:_a - _r0, :_w] = np.asarray(_KR[_oj + _r0:_oj + _a, _oi:_oi + _w]) == 1
    _fm &= ~_kr; del _kr
    _fm &= ~_sky_rows(_fnx, _FS, _r0, _r1)
    _b1L.append(_fm[1::2, 1::2]); _fmL.append(np.packbits(_fm, axis=1)); del _fm
del _ptsF
_b1 = np.concatenate(_b1L); del _b1L
# v41.20: トンネルの床の上は「建物」にしない（上の建物の屋根が通れなくしていた）。箱の壁の外側の帯は通れなくする（壁をすり抜けて地面へ出ない）
_nb_clr = 0; _nb_set = 0
for _t in TUNNELS:
    _jj, _ii, _ = TUN.raster_cells(_t, _t["floor_poly"], DX0, DZ0, 1.0, _b1.shape[1], _b1.shape[0], 0)
    if len(_jj): _b1[_jj, _ii] = False; _nb_clr += len(_jj)
_FPALL = unary_union([_t["floor_poly"] for _t in TUNNELS]) if TUNNELS else None
for _t in TUNNELS:
    if _t["band_poly"] is None: continue
    # v41.21: 隣のトンネル（上り・下りが別々の箱）の床の上は「通れない」にしない（隣の壁の帯が、こちらの外側の車線に重なっていた）
    _bp = _t["band_poly"].difference(_FPALL)
    if _bp.is_empty: continue
    _jj, _ii, _ = TUN.raster_cells(_t, _bp, DX0, DZ0, 1.0, _b1.shape[1], _b1.shape[0], 0)
    if len(_jj): _b1[_jj, _ii] = True; _nb_set += len(_jj)
print("  tunnel building-mask bits cleared", _nb_clr, "wall bits set", _nb_set, flush=True)
_FMB = np.concatenate(_fmL); del _fmL   # v30: 0.5m の建物マスク（アーケード・小物で使う）はビット列で持つ
_bnz, _bnx = _b1.shape
_bbits = np.packbits(_b1.astype(np.uint8), axis=1)
# v30: 高さは 2 次元の差分（左＋上−左上 からの差）を下位・上位のバイトに分けて持つ（deflate がよく縮む。geo_io・app.js で戻す）
_DHi = np.round(DH_ * 100).astype(np.int16)
np.save("/home/claude/wx/drive_H.npy", _DHi)
# v30: 高さは地面の格子（ground）からの予測との差（gres。地面の所はほぼ 0）。原点が同じで升目が半分の時だけ
assert DG * 2 == DSTEP and dnx == 2 * nx and dnz == 2 * nz
# v32: 橋・高架が道路の上を通る所の「上の段」（走行格子の升目の番号 int32・高さ cm int16・区分 uint8）。app.js は車・人の今の高さに近い段を使う
_UPD = b""; _nup = 0
_up = R.get("upper")
if _up is not None and len(_up[0]):
    _ui = np.asarray(_up[0], np.int64); _uj = _ui // HR.shape[1]; _uii = _ui % HR.shape[1]
    _ux = GX0 + (_uii + 0.5) * RES; _uz = GZ0 + (_uj + 0.5) * RES
    _di = np.floor((_ux - DX0) / DG).astype(np.int64); _dj = np.floor((_uz - DZ0) / DG).astype(np.int64)
    _ok = (_di >= 0) & (_dj >= 0) & (_di < dnx) & (_dj < dnz)
    # v41.20: 走行格子の升目（2m）の中に「上の段」の升目（0.5m）が 2 つ以上あれば、その升目に上の段を持たせる（高さは平均）。
    #   以前は升目の中心の 1 つの 0.5m 升だけを見ていたので、橋の面の 0.5〜1m の隙間・縁の欠けが、2m 升の欠け（高架の面に開いた穴＝
    #   下の道路の高さへ落ちる）になっていた
    _gid = (_dj * dnx + _di)[_ok]; _gh = np.asarray(_up[1], np.float64)[_ok]; _gk = np.asarray(_up[2])[_ok].astype(np.int64)
    _cid, _inv, _cnt = np.unique(_gid, return_inverse=True, return_counts=True)
    _hs = np.bincount(_inv, weights=_gh); _kmin = np.full(len(_cid), 9, np.int64); np.minimum.at(_kmin, _inv, _gk)
    _keep = _cnt >= 2
    _cid = _cid[_keep].astype(np.int32); _ch = np.round((_hs[_keep] / _cnt[_keep]) * 100).astype(np.int16); _ck = _kmin[_keep].astype(np.uint8)
    _UPD = _cid.tobytes() + _ch.tobytes() + _ck.tobytes(); _nup = len(_cid)
print("  drive upper cells (bridge over road)", _nup, flush=True)
bins["drive"] = bytearray(gres_encode(_DHi, Hc) + DC_.tobytes() + _bbits.tobytes() + _UPD)
manifest["drive"] = dict(file="drive", nx=int(dnx), nz=int(dnz), x0=float(DX0), z0=float(DZ0), step=DG,
                         bnx=int(_bnx), bnz=int(_bnz), bstep=1.0, brow=int(_bbits.shape[1]), enc="gres", up=int(_nup))
del _DHi
print("  building mask 1m", _bnx, _bnz, "cells", int(_b1.sum()), flush=True)
# v17: ヘリ用の屋上の高さ（4m 格子・1m 単位の絶対高さ。0 = 建物なし）。低い屋根から順に塗り、高い屋根で上書き
_HS = 4.0; _hnx = int(round(nx * DSTEP / _HS)); _hnz = int(round(nz * DSTEP / _HS))
_hm = np.zeros((_hnz, _hnx), np.uint8)
_ym = np.clip(np.ceil(_rt[:, :, 1].max(1)), 1, 255).astype(int)
_hp = np.round(np.stack([(_rt[:, :, 0] - DX0) / _HS - 0.5, (_rt[:, :, 2] - DZ0) / _HS - 0.5], -1) * 8).astype(np.int32)
for _v in np.unique(_ym):
    _sel = np.nonzero(_ym == _v)[0]
    for k in range(0, len(_sel), 200000):
        _cv2.fillPoly(_hm, list(_hp[_sel[k:k + 200000]]), int(_v), lineType=_cv2.LINE_8, shift=3)
bins["hmax"] = bytearray(_hm.tobytes())
manifest["hmax"] = dict(file="hmax", nx=int(_hnx), nz=int(_hnz), x0=float(DX0), z0=float(DZ0), step=_HS)
print("  hmax grid", _hnx, _hnz, "cells", int((_hm > 0).sum()), "max", int(_hm.max()), flush=True)
# v17: 遠景の地形（far_terrain.py の出力）
if os.path.exists("/home/claude/wx/far_grid.npz") and os.path.exists("/home/claude/wx/far.jpg"):
    import shutil; shutil.copy("/home/claude/wx/far.jpg", os.path.join(OUT, "far.jpg"))   # far_terrain.py の写真（色合わせ済み）
    _far = np.load("/home/claude/wx/far_grid.npz")
    bins["far"] = bytearray(_far["H"].astype(np.int16).tobytes())
    manifest["far"] = dict(file="far", nx=int(_far["H"].shape[1]), nz=int(_far["H"].shape[0]), x0=float(_far["x0"]), z0=float(_far["z0"]),
                           step=float(_far["step"]), tex="far.jpg", hole=[float(DX0), float(DZ0), float(DX0 + (nx - 1) * DSTEP), float(DZ0 + (nz - 1) * DSTEP)])
print("  drive grid", dnx, dnz, "building cells", int((DC_ == 9).sum()), flush=True)
print("  wall variants", WALL_COUNT, "roof tris", len(RP) // 3, flush=True)

# LOD2 テクスチャのアトラス（v16: タイルごとにページを分ける。1 タイル最大 TILE_PAGES 枚、全体で TEX_BUDGET まで）
TEX_BUDGET = float(os.environ.get("TEX_BUDGET", "330e6")); APAGE = 2048; PAD = 2; TILE_PAGES = int(os.environ.get("TILE_PAGES", "7"))
# v26: 近くで見る時の元の解像度の外壁写真（200m 四方の升目ごとのページ）。遠くは従来の縮小したアトラス
HCELL = 200.0
# v29: 近景の升目の原点。v28（原点 = core の北西の角）と同じ格子で、番号が負にならないよう 10 升ずらす（HIMASK は 32×32）
from common import CORE as _CORE2
HC_X0, HC_Z0 = _CORE2[0] - 10 * HCELL, _CORE2[1] - 10 * HCELL
info = []
for img, L in tex_groups.items():
    if TEX_OLD and _pk(img) in TEX_OLD: cxz = TEX_OLD[_pk(img)]      # v28 の画像: v28 と同じ重心（タイル・升目・縮小率を v28 と同じにする）
    else: allp = np.concatenate([p for p, u in L]); cxz = allp[:, [0, 2]].mean(0)
    with Image.open(img) as im: w, h = im.size
    hc_ = (int((cxz[0] - HC_X0) // HCELL), int((cxz[1] - HC_Z0) // HCELL))
    assert 0 <= hc_[0] < 64 and 0 <= hc_[1] < 64, ("hi cell out of HIMASK（app.js は 64×64）", hc_)
    info.append([img, w, h, tile_of(*cxz), hc_, (not TEX_OLD) or (_pk(img) in TEX_OLD)])
# v29: v28 の画像と、広げた所の画像は別々に詰める（v28 の画像のページは v28 と同じ。広げた所の画像は後ろのページ）
tiles_img = {}
for i, it in enumerate(info): tiles_img.setdefault((0 if it[5] else 1, it[3]), []).append(i)
raw_px = {t: sum(info[i][1] * info[i][2] for i in ids) for t, ids in tiles_img.items()}
tot_raw = sum(v for t, v in raw_px.items() if t[0] == 0)   # 縮小率の基準は v28 の画像の合計（広げた所の画像も同じ割合の予算）
def pack(ids, k, APAGE=APAGE):
    """ids の画像を倍率 k で詰める。ページのリストと配置を返す"""
    S = {i: (min(APAGE - 2 * PAD, max(8, int(info[i][1] * k))), min(APAGE - 2 * PAD, max(8, int(info[i][2] * k)))) for i in ids}
    order = sorted(ids, key=lambda i: -S[i][1]); pages = []; plc = {}
    for i in order:
        w, h = S[i]; Wd, Hd = w + 2 * PAD, h + 2 * PAD; placed = False
        for pi_, pg_ in enumerate(pages):
            for sh in pg_["shelves"]:
                if Hd <= sh["h"] and sh["x"] + Wd <= APAGE:
                    plc[i] = (pi_, sh["x"], sh["y"]); sh["x"] += Wd; placed = True; break
            if placed: break
            if pg_["y"] + Hd <= APAGE:
                sh = {"y": pg_["y"], "h": Hd, "x": Wd}; pg_["shelves"].append(sh); pg_["y"] += Hd; plc[i] = (pi_, 0, sh["y"]); placed = True; break
        if not placed:
            pages.append({"shelves": [{"y": 0, "h": Hd, "x": Wd}], "y": Hd}); plc[i] = (len(pages) - 1, 0, 0)
    return pages, plc, S
apage_count = 0; manifest["atlas_tile"] = []
for gk_, ids in sorted(tiles_img.items()):
    tl_ = gk_[1]
    budget_px = min(TILE_PAGES * APAGE * APAGE * 0.9, TEX_BUDGET * raw_px[gk_] / max(1, tot_raw))
    lo, hi = 0.01, 1.0
    for _ in range(22):
        k = (lo + hi) / 2
        pages, plc, S = pack(ids, k)
        if len(pages) > TILE_PAGES or sum((S[i][0] + 2 * PAD) * (S[i][1] + 2 * PAD) for i in ids) > budget_px: hi = k
        else: lo = k
    pages, plc, S = pack(ids, lo)
    pimgs = [Image.new("RGB", (APAGE, APAGE), (150, 145, 138)) for _ in pages]
    tpos = {q: [] for q in range(len(pages))}; tuv = {q: [] for q in range(len(pages))}; tcol = {q: [] for q in range(len(pages))}
    for i in ids:
        img = info[i][0]; q, px, py = plc[i]; w, h = S[i]; hc_ = info[i][4]
        im = Image.open(img).convert("RGB")
        # 航空斜め写真由来で眠い外壁写真を補正（軽い輪郭強調・コントラスト・彩度）
        im = ImageEnhance.Contrast(ImageEnhance.Color(im).enhance(1.12)).enhance(1.07)
        im = im.resize((w, h), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=70, threshold=2))
        big = im.resize((w + 2 * PAD, h + 2 * PAD)); big.paste(im, (PAD, PAD)); pimgs[q].paste(big, (px, py))
        for p, u in tex_groups[img]:
            tpos[q].append(p); tuv[q].append(np.stack([(px + PAD + u[:, 0] * w) / APAGE, 1 - (py + PAD + (1 - u[:, 1]) * h) / APAGE], 1))
            # v26: 頂点色に建物の近景の升目（x, z）を入れる（画面側で、近景の写真を読み込んだ升目の建物は遠景用を描かない）
            tcol[q].append(np.tile([(hc_[0] + 0.5) / 255.0, (hc_[1] + 0.5) / 255.0, 1.0], (len(p), 1)))
    for q, im in enumerate(pimgs):
        gp = apage_count + q
        fn = f"atlas_{gp:03d}.jpg"; im.save(os.path.join(OUT, fn), quality=82, optimize=True)
        manifest["atlas"].append(fn); manifest["atlas_tile"].append(tl_)
        # このページを使う三角形は、画像の属するタイル（tl_）のファイルへ入れる
        P_ = np.concatenate(tpos[q]); U_ = np.concatenate(tuv[q])
        add_chunk_tile("bldg", P_, uv=U_, col=np.concatenate(tcol[q]), mat="tex", page=gp, file_key="bldg_tex", tile=tl_)
    print("  atlas tile", tl_, "ext" if gk_[0] else "", "images", len(ids), "pages", len(pages), "k", round(lo, 3), flush=True)
    apage_count += len(pages)
print("  LOD2 atlas pages", apage_count, flush=True)
# ---- v26: 近景用（元の解像度）: 200m の升目ごとに、建物の外壁写真を縮小せずにページへ詰める（WebP 品質 90） ----
hi_cells = {}
for i, it in enumerate(info): hi_cells.setdefault(it[4], []).append(i)
manifest["hiatlas"] = []; manifest["hicells"] = {}
hp_count = 0; hi_bytes = 0
HPAGE = 4096      # 近景用のページは 4096 幅（使った高さで切る。ファイル数と無駄な余白を減らす）
for hc_, ids in sorted(hi_cells.items()):
    pages, plc, S = pack(ids, 1.0, HPAGE)
    PH = [min(HPAGE, int(np.ceil(pg_["y"] / 256.0)) * 256) for pg_ in pages]
    pimgs = [Image.new("RGB", (HPAGE, PH[q]), (150, 145, 138)) for q in range(len(pages))]
    tpos = {q: [] for q in range(len(pages))}; tuv = {q: [] for q in range(len(pages))}
    for i in ids:
        img = info[i][0]; q, px, py = plc[i]; w, h = S[i]
        im = Image.open(img).convert("RGB")
        im = ImageEnhance.Contrast(ImageEnhance.Color(im).enhance(1.12)).enhance(1.07)
        if (w, h) != im.size: im = im.resize((w, h), Image.LANCZOS)
        im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=70, threshold=2))
        big = im.resize((w + 2 * PAD, h + 2 * PAD)); big.paste(im, (PAD, PAD)); pimgs[q].paste(big, (px, py))
        for p, u in tex_groups[img]:
            tpos[q].append(p); tuv[q].append(np.stack([(px + PAD + u[:, 0] * w) / HPAGE, 1 - (py + PAD + (1 - u[:, 1]) * h) / PH[q]], 1))
    key_ = f"{hc_[0]}_{hc_[1]}"
    for q, im in enumerate(pimgs):
        gp = hp_count + q; fn = f"hi_{gp:03d}.webp"
        im.save(os.path.join(OUT, fn), quality=90, method=4); hi_bytes += os.path.getsize(os.path.join(OUT, fn))
        manifest["hiatlas"].append(fn)
        # 形は 800m のタイルごとの 1 ファイルにまとめる（ファイル数を抑える）。画面側はページの番号で升目の分だけ作る
        hfile_ = "bldghi@" + tile_of(HC_X0 + (hc_[0] + 0.5) * HCELL, HC_Z0 + (hc_[1] + 0.5) * HCELL)
        add_chunk("bldg", np.concatenate(tpos[q]), uv=np.concatenate(tuv[q]), mat="texhi", page=gp, file_key=hfile_)
    manifest["hicells"][key_] = dict(file=hfile_, x0=float(HC_X0 + hc_[0] * HCELL), z0=float(HC_Z0 + hc_[1] * HCELL), size=HCELL, pages=list(range(hp_count, hp_count + len(pages))))
    hp_count += len(pages)
print("  hi-res facade pages", hp_count, "cells", len(hi_cells), "MB", round(hi_bytes / 1e6, 1), flush=True)

# ================= v16: 商店街のアーケード（表町・西大寺町・岡山駅前・奉還町 など） =================
# OSM の商店街の道（covered=arcade/yes または名前が「〜商店街」の歩行者道）に沿って、両側の建物の間に屋根を架ける。
# 幅は 0.5m の建物マスクで両側の建物までを測り（2〜7m の半幅）、高さは軒 7.2m・頂部 +1.6m の半円筒形。10m ごとにアーチ梁と柱。
print("arcades...", flush=True); print("  [rss MB]", _rss(), flush=True)
ARC_NAMES = ("表町商店街", "西大寺町商店街", "岡山駅前商店街", "奉還町商店街", "千日前商店街", "新西大寺町商店街")
arc_roof, arc_frame, arc_uv = [], [], []
def _bm_at(x, z):
    i = int((x - DX0) / 0.5); j = int((z - DZ0) / 0.5)
    return 0 <= j < _fnz and 0 <= i < _fnx and bool((_FMB[j, i >> 3] >> (7 - (i & 7))) & 1)
n_arc = 0
for w in ways:
    t_ = w["tags"]
    if t_.get("highway") not in ("pedestrian", "footway", "path", "unclassified", "residential", "living_street", "service"): continue
    if not (t_.get("covered") in ("arcade", "yes") and t_.get("highway") in ("pedestrian", "footway", "path")) and t_.get("name") not in ARC_NAMES: continue
    if t_.get("layer") and t_.get("layer").startswith("-"): continue
    xy = np.asarray(w["xy"], float)
    if len(xy) < 2: continue
    seg = np.hypot(*np.diff(xy, axis=0).T); arc_ = np.concatenate([[0], np.cumsum(seg)])
    if arc_[-1] < 30: continue
    ss = np.arange(0, arc_[-1] + 0.01, 2.0)
    q = np.stack([np.interp(ss, arc_, xy[:, 0]), np.interp(ss, arc_, xy[:, 1])], 1)
    tg = np.gradient(q, axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    nv = np.stack([-tg[:, 1], tg[:, 0]], 1)
    wl = np.array([next((o for o in np.arange(0.5, 10, 0.5) if _bm_at(*(q[i] + nv[i] * o))), np.nan) for i in range(len(q))])
    wr = np.array([next((o for o in np.arange(0.5, 10, 0.5) if _bm_at(*(q[i] - nv[i] * o))), np.nan) for i in range(len(q))])
    ok = np.isfinite(wl) & np.isfinite(wr)
    if ok.mean() < 0.4: continue                     # 両側に建物が並んでいない所（広場・道路）は屋根を架けない
    wl = np.where(np.isfinite(wl), wl, np.nanmedian(wl)); wr = np.where(np.isfinite(wr), wr, np.nanmedian(wr))
    from scipy.ndimage import median_filter as _mf, gaussian_filter1d as _gf
    wl = _gf(_mf(wl, 41, mode="nearest"), 8, mode="nearest"); wr = _gf(_mf(wr, 41, mode="nearest"), 8, mode="nearest")
    half = np.clip((wl + wr) / 2 - 0.2, 2.0, 7.0); mid = q + nv * ((wl - wr) / 2)[:, None]
    ys = np.array([surf(*p_) for p_ in q]); ys = _gf(ys, 3, mode="nearest")
    NU = 10; us = np.linspace(-1, 1, NU + 1)
    def pt(i, u):
        c = mid[i] + nv[i] * (u * half[i]); return [c[0], ys[i] + 7.2 + 1.6 * (1 - u * u), c[1]]
    for i in range(len(q) - 1):
        for k in range(NU):
            A = pt(i, us[k]); B = pt(i, us[k + 1]); C = pt(i + 1, us[k]); D = pt(i + 1, us[k + 1])
            arc_roof += [A, C, B, B, C, D]
            u0, u1 = ss[i] / 4.0, ss[i + 1] / 4.0; v0, v1 = k / NU * 3, (k + 1) / NU * 3      # 4m × 約 1/3 幅のパネル
            arc_uv += [[u0, v0], [u1, v0], [u0, v1], [u0, v1], [u1, v0], [u1, v1]]
        if i % 5 == 0:                                                # 10m ごとのアーチ梁と柱
            for k in range(NU):
                A = np.array(pt(i, us[k])); B = np.array(pt(i, us[k + 1]))
                arc_frame.append(beam(A[[0, 2]], B[[0, 2]], (A[1] + B[1]) / 2 - 0.15, 0.16, 0.22))
            for u in (-1, 1):
                c = mid[i] + nv[i] * (u * (half[i] - 0.15))
                arc_frame.append(cyl(c, 0.11, ys[i], ys[i] + 7.25, 8))
    n_arc += 1
if arc_roof:
    R_ = np.array(arc_roof, float)
    add_chunk("arcade", R_, uv=np.array(arc_uv, float), col=tri_colors(len(R_) // 3, (0.95, 0.97, 1.0)), mat="arcroof", file_key="arcade", uv_int=True)
    F_ = np.concatenate(arc_frame)
    add_chunk("arcade", F_, col=tri_colors(len(F_) // 3, (0.56, 0.58, 0.60), 0.03, 7), mat="color", file_key="arcade")
print("  arcades", n_arc, "roof tris", len(arc_roof) // 3, flush=True)

# ================= v16: 街の小物（電柱と電線・自動販売機・袖看板） =================
# 電柱: 幹線以外の道（tertiary・unclassified・residential・living_street）の片側の縁、約 32m おき（主要道路は無電柱化のため立てない）。
# 自動販売機: 建物の前（道路の縁から 3m 以内に建物がある所）に確率的に。袖看板: 2 車線以上の道に面した建物の壁に。
print("street details...", flush=True); print("  [rss MB]", _rss(), flush=True)
import random as _rnd
_rng = _rnd.Random(2027)
KND_ = R["KIND"]
def _kn(x, z):
    i = int((x - GX0) / RES); j = int((z - GZ0) / RES)
    return KND_[j, i] if 0 <= j < KND_.shape[0] and 0 <= i < KND_.shape[1] else 0
upole, uarm, utr, pw_segs = [], [], [], []
vend_body, vend_front, vend_front_uv = [], [], []
sign_side, sign_face, sign_face_uv = [], [], []
def box_tris(c, fx, fz, w, d, y0, y1):
    """中心 c・前向き (fx,fz)・幅 w・奥行 d の箱（側面と天面）"""
    sx, sz = fz, -fx
    P = [np.array([c[0] + sx * a * w / 2 + fx * b_ * d / 2, c[1] + sz * a * w / 2 + fz * b_ * d / 2]) for a, b_ in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return np.concatenate([extrude_ring(LineString(P + [P[0]]), lambda x, z: y0, lambda x, z: y1), tri_poly(Polygon(P), lambda x, z: y1)])
def cyl6(c, r, y0, y1):
    """六角柱（側面のみ・12 三角形）"""
    P = [(c[0] + r * math.cos(a), c[1] + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)[:-1]]
    return extrude_ring(LineString(P + [P[0]]), lambda x, z: y0, lambda x, z: y1)
def quad(a, b, y0, y1, uv=None):
    A = [a[0], y0, a[1]]; B = [b[0], y0, b[1]]; C = [b[0], y1, b[1]]; D = [a[0], y1, a[1]]
    return [A, B, C, A, C, D]
SMALL = ("unclassified", "residential", "living_street")        # 電柱・自販機は細い道だけ（中心部の幹線・2 車線道路は無電柱化が多い）
n_pole = n_vend = n_sign = 0
for w in ways:
    t_ = w["tags"]; hw = t_.get("highway")
    if hw not in SMALL + ("primary", "secondary", "trunk"): continue
    if t_.get("bridge") or t_.get("tunnel") or t_.get("area") == "yes": continue
    xy = np.asarray(w["xy"], float)
    if len(xy) < 2: continue
    seg = np.hypot(*np.diff(xy, axis=0).T); arc_ = np.concatenate([[0], np.cumsum(seg)])
    if arc_[-1] < 25: continue
    ss = np.arange(8, arc_[-1] - 4, 2.0)
    if not len(ss): continue
    q = np.stack([np.interp(ss, arc_, xy[:, 0]), np.interp(ss, arc_, xy[:, 1])], 1)
    tg = np.gradient(q, axis=0) if len(q) > 1 else np.array([[1.0, 0.0]]); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    nv = np.stack([-tg[:, 1], tg[:, 0]], 1)
    side = 1 if (w["id"] % 2) else -1
    def edge_pt(i, sg):
        """道の縁（車道でなくなる所）の少し外側の点と、そこから建物までの距離"""
        for o in np.arange(0.5, 14, 0.5):
            p_ = q[i] + nv[i] * o * sg
            if _kn(*p_) != 1:
                bd = next((b_ for b_ in np.arange(0.0, 4.0, 0.5) if _bm_at(*(p_ + nv[i] * b_ * sg))), None)
                return p_, bd
        return None, None
    last_pole = None; prev_top = None
    for i in range(len(q)):
        if not corr.contains(Point(*q[i])) or TRACKS.distance(Point(*q[i])) < 8: prev_top = None; continue
        # 電柱
        if hw in SMALL and (last_pole is None or ss[i] - last_pole >= 32):
            p_, bd = edge_pt(i, side)
            if p_ is not None and (bd is None or bd > 0.4) and not _bm_at(*p_):
                base = p_ + nv[i] * side * 0.35; y0 = surf(*base)
                upole.append(cyl6(base, 0.15, y0 - 0.1, y0 + 11.0))
                arm_c = base - nv[i] * side * 0.4
                uarm.append(beam(arm_c - tg[i] * 0.0 + nv[i] * side * 0.9, arm_c - nv[i] * side * 0.9, y0 + 10.2, 0.1, 0.1))
                if n_pole % 3 == 0: utr.append(cyl6(base + nv[i] * side * 0.45, 0.3, y0 + 7.8, y0 + 8.9))
                top = [(base - nv[i] * side * 0.3, y0 + 10.3), (base - nv[i] * side * 1.0, y0 + 10.3), (base, y0 + 9.0)]
                if prev_top is not None and ss[i] - last_pole < 45:
                    for (a_, ya), (b_, yb) in zip(prev_top, top):
                        L_ = 6
                        pts = [[a_[0] + (b_[0] - a_[0]) * k / L_, ya + (yb - ya) * k / L_ - 0.35 * 4 * (k / L_) * (1 - k / L_), a_[1] + (b_[1] - a_[1]) * k / L_] for k in range(L_ + 1)]
                        for u_, v_ in zip(pts[:-1], pts[1:]): pw_segs.append([round(c, 2) for c in u_ + v_])
                prev_top = top; last_pole = ss[i]; n_pole += 1
        # 自動販売機（小さい道の建物の前）
        if hw in SMALL and i % 20 == 7 and _rng.random() < 0.3:
            p_, bd = edge_pt(i, -side)
            if p_ is not None and bd is not None and 0.5 <= bd <= 3.0:
                c = p_ + nv[i] * (-side) * (bd - 0.45)          # 建物の壁の 0.45m 手前
                fx, fz = nv[i] * side                           # 道の方を向く
                y0 = surf(*c)
                vend_body.append(box_tris(c, fx, fz, 1.0, 0.75, y0, y0 + 1.83))
                fc = c + np.array([fx, fz]) * 0.376; sx, sz = fz, -fx
                a_ = fc - np.array([sx, sz]) * 0.47; b_ = fc + np.array([sx, sz]) * 0.47
                vend_front.append(quad(a_, b_, y0 + 0.1, y0 + 1.78)); k = _rng.randrange(4)
                vend_front_uv.append([[k / 4, 0], [(k + 1) / 4, 0], [(k + 1) / 4, 1], [k / 4, 0], [(k + 1) / 4, 1], [k / 4, 1]])
                n_vend += 1
        # 袖看板（2 車線以上の道・両側）
        if hw in ("tertiary", "secondary", "primary", "unclassified", "residential") and i % 6 == 3 and _rng.random() < 0.5:
            sg = 1 if _rng.random() < 0.5 else -1
            p_, bd = edge_pt(i, sg)
            if p_ is not None and bd is not None and bd <= 3.0:
                wall = p_ + nv[i] * sg * bd                    # 建物の壁
                y0 = surf(*wall); h0 = y0 + 3.2 + _rng.random() * 2.0; h1 = h0 + 2.2 + _rng.random() * 2.2
                if any(_bm_at(*(wall + nv[i] * sg * 0.6 + tg[i] * dd)) for dd in (-0.4, 0.4)):
                    a_ = wall - nv[i] * sg * 0.1; b_ = wall - nv[i] * sg * 0.85       # 壁から道の方へ 0.75m 張り出す
                    t2 = tg[i] * 0.12
                    for off in (t2, -t2):
                        sign_face.append(quad(a_ + off, b_ + off, h0, h1))
                        k = _rng.randrange(16); u0, v0 = (k % 4) / 4, (k // 4) / 4
                        uv_ = [[u0, v0], [u0 + 0.25, v0], [u0 + 0.25, v0 + 0.25], [u0, v0], [u0 + 0.25, v0 + 0.25], [u0, v0 + 0.25]]
                        sign_face_uv.append(uv_ if (off @ tg[i]) * sg > 0 else [[u0 + 0.25 - (x_ - u0), y_] for x_, y_ in uv_])   # v39: 面の向きは sg*tg。外向きの面が正しい向きになるよう sg も考慮（以前は sg=-1 側の看板の文字が全部鏡文字だった）
                    ring = [b_ + t2, b_ - t2, a_ - t2, a_ + t2]
                    sign_side.append(np.array(quad(ring[0], ring[1], h0, h1) + quad(ring[1], ring[0], h0, h1)))
                    n_sign += 1
def _cat(L):
    L = [np.asarray(x, float).reshape(-1, 3) for x in L if len(x)]
    return np.concatenate(L) if L else np.zeros((0, 3))
for nm_, L_, col_ in (("upole", upole, (0.64, 0.64, 0.62)), ("uarm", uarm, (0.35, 0.36, 0.37)), ("utr", utr, (0.52, 0.56, 0.54)),
                      ("vend", vend_body, (0.86, 0.87, 0.88)), ("signside", sign_side, (0.9, 0.9, 0.88))):
    P_ = _cat(L_)
    if len(P_): add_chunk("frn", P_, col=tri_colors(len(P_) // 3, col_, 0.04, 3), mat="color", file_key="detail")
P_ = _cat(vend_front)
if len(P_): add_chunk("frn", P_, uv=np.array(vend_front_uv, float).reshape(-1, 2), mat="vend", file_key="detail")
P_ = _cat(sign_face)
if len(P_): add_chunk("frn", P_, uv=np.array(sign_face_uv, float).reshape(-1, 2), mat="signs", file_key="detail")
# v30: cm の整数・差分・バイトの面（geo_io.pw_encode。以前は float32 のまま）
import geo_io as _gio
bins["pwires"] = bytearray(_gio.pw_encode(np.asarray(pw_segs, np.float32).reshape(-1))) if pw_segs else bytearray()
manifest["pwires_enc"] = "sd"
print("  utility poles", n_pole, "wire segs", len(pw_segs), "vending", n_vend, "signs", n_sign, flush=True)

# ================= 9) 植生（軌道敷に掛かるものを除く） =================
print("vegetation...", flush=True); print("  [rss MB]", _rss(), flush=True)
cr, trk, cv, pts = [], [], [], []
for f in sorted(glob.glob("/home/claude/wx/out_veg/*.pkl")):
    d = pickle.load(open(f, "rb"))
    for k, L in (("crown", cr), ("trunk", trk), ("cover", cv)):
        if len(d[k]): L.append(d[k])
    if len(d["pts"]): pts.append(d["pts"])
TBv = prep(TBpoly.buffer(0.4))
def drop_on_track(t, maxh=None):
    if not len(t): return t
    tt = t.reshape(-1, 3, 3); cen = tt.mean(1)
    keep = np.array([not TBv.contains(Point(c[0], c[2])) or (maxh is not None and c[1] - track_h(c[0], c[2]) > maxh) for c in cen])
    return tt[keep].reshape(-1, 3)
allc = drop_on_track(np.concatenate(cr) if cr else np.zeros((0, 3)), 5.5)
allt = drop_on_track(np.concatenate(trk) if trk else np.zeros((0, 3)))
allv = np.concatenate(cv) if cv else np.zeros((0, 3))
if len(allv): allv = clip_tris(allv, TBpoly.buffer(0.3))
def leafy(n, seed):
    r = np.random.default_rng(seed); base = np.array([0.30, 0.45, 0.22])
    return np.repeat(base * r.uniform(0.95, 1.05, (n, 1)), 3, 0)
# 樹冠の法線: 同じ木(頂点を共有する連結成分)の中心からの放射方向と面法線の混合で柔らかく
def radial_normals(P):
    t = P.reshape(-1, 3, 3)
    key = np.round(P / 0.02).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.reshape(-1)
    parent = np.arange(inv.max() + 1)
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    iv = inv.reshape(-1, 3)
    for a, b, c in iv:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra; parent[find(c)] = ra
    root = np.array([find(v) for v in inv])
    cen = {}
    for r in np.unique(root):
        cen[r] = P[root == r].mean(0)
    C = np.array([cen[r] for r in root])
    rad = P - C; rad[:, 1] *= 0.6
    rad /= np.linalg.norm(rad, axis=1)[:, None] + 1e-9
    fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]); fn /= np.linalg.norm(fn, axis=1)[:, None] + 1e-9
    fn = np.repeat(fn, 3, 0)
    n = 0.75 * rad + 0.25 * fn
    return n / (np.linalg.norm(n, axis=1)[:, None] + 1e-9)
# ---- 街路樹: PLATEAU の実測属性（位置・樹種・樹高・樹冠径）から樹種別の形で生成 ----
TREES = pickle.load(open("/home/claude/wx/trees.pkl", "rb"))
# 樹種コード: 15 クスノキ, 17 クロガネモチ, 24 シラカシ, 27 タイワンフウ, 37 ハナミズキ, 41 フジ, 47 ムクノキ, 50 モミジバフウ, 53 ユリノキ
SPEC = {  # (樹冠下端/樹高, 形 [縦横比], 葉色, 塊の数)
    "15": (0.30, 0.75, (0.30, 0.47, 0.20), 11), "17": (0.28, 1.05, (0.18, 0.33, 0.15), 8),
    "24": (0.25, 1.05, (0.20, 0.34, 0.17), 9), "27": (0.38, 1.35, (0.30, 0.44, 0.19), 8),
    "37": (0.35, 0.80, (0.33, 0.48, 0.22), 6), "47": (0.35, 0.85, (0.28, 0.42, 0.19), 9),
    "50": (0.35, 1.45, (0.28, 0.43, 0.18), 8), "53": (0.30, 1.50, (0.32, 0.47, 0.21), 8),
}
_rng = np.random.default_rng(42)
def _ico(sub=1):
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], float)
    f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
         [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
    tris = v[np.array(f)]
    for _ in range(sub):
        a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
        ab, bc, ca = (a + b) / 2, (b + c) / 2, (c + a) / 2
        tris = np.concatenate([np.stack(x, 1) for x in ([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca])])
    tris /= np.linalg.norm(tris, axis=2)[:, :, None]
    return tris.reshape(-1, 3)
ICO1 = _ico(1); ICO0 = _ico(0)
def _trunk(x, y, z, r0, h, n=6):
    out = []
    for k in range(n):
        a0 = 2 * np.pi * k / n; a1 = 2 * np.pi * (k + 1) / n
        p0 = np.array([np.cos(a0), 0, np.sin(a0)]); p1 = np.array([np.cos(a1), 0, np.sin(a1)])
        b0 = [x + p0[0] * r0, y, z + p0[2] * r0]; b1 = [x + p1[0] * r0, y, z + p1[2] * r0]
        t0 = [x + p0[0] * r0 * 0.6, y + h, z + p0[2] * r0 * 0.6]; t1 = [x + p1[0] * r0 * 0.6, y + h, z + p1[2] * r0 * 0.6]
        out += [b0, t0, b1, b1, t0, t1]
    return np.array(out)
tc_pos, tc_col, tc_nrm, tt_pos = [], [], [], []
TRK_LINES = TRACKS
n_tree = 0
# v29: core（v28 までの範囲）の木は v28 と同じ乱数列（同じ形）、広げた所の木は別の乱数列
from common import CORE as _CORE
_rng_core = _rng; _rng_ext = np.random.default_rng(4242)
for t in TREES:
    _rng = _rng_core if (_CORE[0] + 5 < t["x"] < _CORE[2] - 5 and _CORE[1] + 5 < t["z"] < _CORE[3] - 5) else _rng_ext
    h = t["h"] if (t["h"] and t["h"] > 0) else None
    cd = t["cd"] if (t["cd"] and t["cd"] > 0) else None
    if h is None:
        h = {"2": 2.0, "1": 7.0}.get(t["cls"], 3.0) * _rng.uniform(0.85, 1.15)   # 中木・高木・不明の標準的な大きさ
    if cd is None:
        cd = min(5.0, max(1.2, h * 0.45)) if t["cls"] != "2" else h * 0.7
    if TRK_LINES.distance(Point(t["x"], t["z"])) < 2.8: continue
    if t["x"] < -12 and EXTD["clear"].contains(Point(t["x"], t["z"])): continue
    y0 = t["y"] if -20 < t["y"] < 80 else float(dem_at(t["x"], t["z"]))
    if t["y"] <= 0.01: y0 = float(dem_at(t["x"], t["z"]))
    cb, asp, leaf, nl = SPEC.get(t["sp"], (0.33, 1.0, (0.29, 0.44, 0.20), 7))
    if h < 3.0: cb, nl = 0.05, 3                  # 中木・低木は根元から葉
    near_ = TRK_LINES.distance(Point(t["x"], t["z"])) < 70 and h >= 5
    crown_h = h * (1 - cb)
    # 樹冠径の実測値は剪定直後の値のことがあり細く見えるため、樹高の 22% を下限にする
    R = max(cd / 2, 0.22 * h if h >= 3 else cd / 2)
    ry = min(crown_h / 2, max(R * asp, crown_h * 0.42))
    cy = y0 + h - ry
    if t["cls"] != "2" and h >= 3.0:
        tt_pos.append(_trunk(t["x"], y0, t["z"], max(0.08, (t["td"] or 0.2) / 2 if (t["td"] or 0) > 0 else 0.12), h * cb + ry * 0.6))
    base_col = np.array(leaf) * _rng.uniform(0.8, 1.12) * np.array([_rng.uniform(0.9, 1.1), 1.0, _rng.uniform(0.9, 1.1)])
    for k in range(nl):
        # 樹冠を複数の塊で構成（形の単調さを避ける）
        ang = _rng.uniform(0, 2 * np.pi); rr = R * _rng.uniform(0.2, 0.45) if k else 0.0
        oy = ry * _rng.uniform(-0.35, 0.35) if k else 0.0
        c = np.array([t["x"] + np.cos(ang) * rr, cy + oy, t["z"] + np.sin(ang) * rr])
        s = np.array([R, ry, R]) * (_rng.uniform(0.55, 0.75) if k else 0.8)
        IC = ICO1 if (near_ and k < 5) else ICO0
        P = IC * s * (1 + _rng.uniform(-0.07, 0.07, (len(IC), 1)))
        tc_pos.append(P + c)
        nrm = P / (np.linalg.norm(P, axis=1)[:, None] + 1e-9)
        tc_nrm.append(nrm)
        shade = 0.82 + 0.3 * (nrm[:, 1] * 0.5 + 0.5)    # 上面ほど明るい
        tc_col.append(np.clip(base_col[None, :] * shade[:, None] * _rng.uniform(0.92, 1.08), 0, 1))
    n_tree += 1
allc = np.concatenate(tc_pos); crown_n = np.concatenate(tc_nrm); ccol = np.concatenate(tc_col)
allt = np.concatenate(tt_pos) if tt_pos else np.zeros((0, 3))
add_chunk("veg", allc, col=ccol, mat="leaf", file_key="veg", nrm=crown_n)
add_chunk("veg", allt, col=tri_colors(len(allt) // 3, (0.36, 0.29, 0.22), 0.1, 4), mat="color", file_key="veg")
print("  trees generated", n_tree, "crown tris", len(allc) // 3, flush=True)
add_chunk("veg", allv, col=tri_colors(len(allv) // 3, (0.27, 0.40, 0.20), 0.1, 5), mat="leaf", file_key="veg")
print("  crown", len(allc) // 3, "cover", len(allv) // 3, flush=True)

# 街路設備
FRN_COL = {"4200": (0.55, 0.56, 0.58), "4800": (0.5, 0.5, 0.5), "8160": (0.45, 0.33, 0.22), "2000": (0.52, 0.52, 0.5),
           "4010": (0.60, 0.60, 0.62), "4000": (0.62, 0.60, 0.56), "9000": (0.56, 0.55, 0.53), "9001": (0.70, 0.68, 0.62)}
for k, t in pickle.load(open("/home/claude/wx/out_frn.pkl", "rb")).items():
    add_chunk("frn", t, col=tri_colors(len(t) // 3, FRN_COL.get(k, (0.55, 0.55, 0.55))), mat="color", file_key="frn")

# ================= 10) 路線データ =================
def route_signals(r):
    """走行ルート上の信号: 最寄りの交差点(35m以内)と、進入方向の現示を割り当てる。
    停止位置は交差点中心から「交差道路の半幅+3m」手前（OSM の信号位置と比べ手前の方）"""
    xyz = r["xyz"]; arc = r["arc"]; out = []; used = set()
    RL = LineString(xyz[:, [0, 2]])
    for I_, I in enumerate(ISECT):
        q = Point(I["x"], I["z"])
        if RL.distance(q) > 14: continue
        sc_ = RL.project(q)
        i = min(int(np.searchsorted(arc, sc_)), len(xyz) - 2)
        tv = xyz[min(len(xyz) - 1, i + 3), [0, 2]] - xyz[max(0, i - 3), [0, 2]]; tv /= np.linalg.norm(tv) + 1e-9
        ph = 0 if abs(tv @ np.array(I["main"])) > 0.707 else 1
        cross = [h for h in sig_heads if h["g"] == I_ and h["ph"] != ph]
        stop = sc_ - 11.0
        # 同じ交差点の手前にある OSM 信号（停止線付近）があればそれを優先
        cand = [g["stop"] for g in r["signals"] if sc_ - 40 < g["stop"] < sc_ - 4]
        if cand: stop = max(min(cand), sc_ - 30)
        if stop < 5: continue
        out.append(dict(stop=round(float(stop), 1), center=round(float(sc_), 1), g=I_, ph=ph))
    out.sort(key=lambda q: q["stop"])
    return out

old = json.load(open("/home/claude/pipeline/routes_old.json", encoding="utf-8"))
routes = {"landmarks": old.get("landmarks", [])}
for key, r in T["routes"].items():
    xyz = r["xyz"]
    _nm = {"higashi_r": ("東山線（岡山駅前行き）", "岡山駅前"), "seiki_r": ("清輝橋線（岡山駅前行き）", "岡山駅前")}
    nm_, dest_ = _nm.get(key, (old.get(key, {}).get("name"), old.get(key, {}).get("dest")))
    routes[key] = dict(name=nm_, dest=dest_,
                       track=[[round(p[0], 2), round(p[1], 3), round(p[2], 2)] for p in xyz],
                       speed=[int(v) for v in r["speed"]],
                       stops=[dict(name=s["name"], arc=round(s["arc"], 2), plat=round(s.get("plat_len") or 12.0, 1)) for s in r["stops"]],
                       signals=route_signals(r))
routes["note"] = "軌道・電停・制限速度・信号位置: OpenStreetMap (ODbL)。建物・道路・植生・地形: 国土交通省 PLATEAU 岡山市2025 (CC BY 4.0)。航空写真: 国土地理院 シームレス空中写真。"
json.dump(routes, open(os.path.join(OUT, "routes.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

# ================= 書き出し（deflate + base64。v26 でバイナリを試したが、公開先が .bin を配信しないため戻した） =================
tot = 0
for fk, buf in bins.items():
    raw = bytes(buf)
    comp = zlib.compress(raw, 9)
    b64 = base64.b64encode(comp)      # 公開先がバイナリ（.bin）を配信できないため base64 の .txt のまま
    fn = f"geo_{fk}.txt"
    open(os.path.join(OUT, fn), "wb").write(b64)
    manifest.setdefault("files", {})[fk] = dict(file=fn, raw=len(raw), size=len(b64))   # v30: size = 送る大きさ（読み込みの進み具合の表示用）
    tot += len(b64)
    print("wrote", fn, "raw", round(len(raw) / 1e6, 2), "MB -> txt", round(len(b64) / 1e6, 2), "MB")
manifest["source"] = routes["note"]
json.dump(manifest, open(os.path.join(OUT, "scene.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("chunks", len(manifest["chunks"]), "total geo txt MB", round(tot / 1e6, 1))
