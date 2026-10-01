"""v23: JR の線路・高架橋・列車の走る線（build_v5 の後に実行 → data/jr.json）
線形: OSM の本線（山陽新幹線・山陽本線・宇野線・津山線・吉備線。側線・車庫線は除く）。名前ごとにつながった way を 1 本の折れ線にする。
高さ:
・地面: 地図の範囲は路面・地面の高さ（2m 格子）、外は遠景の標高（80m 格子）。進行方向に 20m でならす
・山陽新幹線は全線高架（OSM: bridge=viaduct, layer 1〜2）。レール面は地面＋10.5m と仮定（実際の高さは公表資料で確認できない）
・在来線の橋・高架（bridge=yes/viaduct）はレール面を地面＋6.5m と仮定し、前後 80m でなめらかに上り下り
停車位置: 岡山駅（在来線ホームの中央付近 (-165, -40) に最も近い線上の点）
複線の新幹線: 2 本の線の間隔の半分を「内側の幅」として持ち、高架橋の床版が 2 本の間でちょうど接するようにする
橋脚: 10m おきに、車道・歩道・水面・建物の上を避けて置く（道路の上は桁で渡る）
"""
import json, base64, zlib, math
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from jr_lines import chains

OUT = "/home/claude/okaden-x/data"
sc = json.load(open(f"{OUT}/scene.json", encoding="utf-8"))
d = sc["drive"]; n = d["nx"] * d["nz"]
import geo_io; raw = geo_io.read_legacy("drive")
H = np.frombuffer(raw[:n * 2], np.int16).reshape(d["nz"], d["nx"]) / 100.0
K = np.frombuffer(raw[n * 2:n * 3], np.uint8).reshape(d["nz"], d["nx"])
BM = np.unpackbits(np.frombuffer(raw[n * 3:n * 3 + d["brow"] * d["bnz"]], np.uint8).reshape(d["bnz"], d["brow"]), axis=1)[:, :d["bnx"]]
fm = sc["far"]; FA = np.frombuffer(geo_io.read("far"), np.int16).reshape(fm["nz"], fm["nx"]) / 10.0
# 水面（地面の下に水がある所）: scene の water があれば使う
from common import BX0, BZ0, BX1, BZ1
def inData(x, z): return BX0 + 2 < x < BX1 - 2 and BZ0 + 2 < z < BZ1 - 2   # v29: bounds.json
# v36: 外側の地形タイル（outer_tiles.py）。遠景の範囲の外は、これを先に引く
import os as _os
_OUT_MAN = json.load(open(f"{OUT}/outer.json")) if _os.path.exists(f"{OUT}/outer.json") else None
if _OUT_MAN:
    # v38: outer.json は v37 の形式（タイルごとに nh・x0・z0・s。種類 W/F/FF。k は outer_h.bin の先頭からの要素番号）
    _OH = np.frombuffer(open(f"{OUT}/outer_h.bin", "rb").read(), np.int16)
    _OT = _OUT_MAN["tiles"]
    _OX0 = np.array([t["x0"] for t in _OT], float); _OZ0 = np.array([t["z0"] for t in _OT], float); _OS = np.array([t["s"] for t in _OT], float)
    _OPR = np.array([{"FF": 2, "F": 1}.get(t["kind"], 0) for t in _OT])   # 細かいタイルを優先
def outer_ground(x, z):
    if not _OUT_MAN: return None
    m = (_OX0 <= x) & (x < _OX0 + _OS) & (_OZ0 <= z) & (z < _OZ0 + _OS)
    if not m.any(): return None
    q = np.nonzero(m)[0]; q = q[np.argmax(_OPR[q])]; t = _OT[q]
    n = t["nh"] - 1; fx = (x - t["x0"]) / t["s"] * n; fz = (z - t["z0"]) / t["s"] * n
    a = min(int(fx), n - 1); b = min(int(fz), n - 1); tx = fx - a; tz = fz - b
    T = _OH[t["k"]:t["k"] + (n + 1) * (n + 1)].reshape(n + 1, n + 1) / 10.0
    return float((T[b, a] * (1 - tx) + T[b, a + 1] * tx) * (1 - tz) + (T[b + 1, a] * (1 - tx) + T[b + 1, a + 1] * tx) * tz)
def ground(x, z):
    if not inData(x, z) and not (fm["x0"] < x < fm["x0"] + fm["step"] * (fm["nx"] - 1) and fm["z0"] < z < fm["z0"] + fm["step"] * (fm["nz"] - 1)):
        g_ = outer_ground(x, z)
        if g_ is not None: return g_
    if inData(x, z):
        i = int((x - d["x0"]) // d["step"]); j = int((z - d["z0"]) // d["step"])
        return float(H[min(max(j, 0), d["nz"] - 1), min(max(i, 0), d["nx"] - 1)])
    fx = (x - fm["x0"]) / fm["step"]; fz = (z - fm["z0"]) / fm["step"]
    i = int(np.clip(np.floor(fx), 0, fm["nx"] - 2)); j = int(np.clip(np.floor(fz), 0, fm["nz"] - 2)); tx = np.clip(fx - i, 0, 1); tz = np.clip(fz - j, 0, 1)
    return float((FA[j, i] * (1 - tx) + FA[j, i + 1] * tx) * (1 - tz) + (FA[j + 1, i] * (1 - tx) + FA[j + 1, i + 1] * tx) * tz)
def kind(x, z):
    if not inData(x, z): return 0
    i = int((x - d["x0"]) // d["step"]); j = int((z - d["z0"]) // d["step"])
    return int(K[j, i]) if 0 <= i < d["nx"] and 0 <= j < d["nz"] else 0
def bld(x, z):
    i = int((x - d["x0"]) // d["bstep"]); j = int((z - d["z0"]) // d["bstep"])
    return bool(BM[j, i]) if 0 <= i < d["bnx"] and 0 <= j < d["bnz"] else False
# 水域: build の水位（water level grid）が scene に無い場合は地面の低さで代用しない（橋脚は川の中にも立つ）

STN = np.array([-165.0, -40.0])
HS_RAIL = 10.5; BR_RAIL = 6.5


HS_GRADE = 0.012      # v36: 新幹線の縦断勾配の上限（山陽新幹線の最急勾配は 15‰ とされる。設計は余裕を見て 12‰）
HS_CLEAR = 9.5        # 高架のレール面は、近く（前後 20m）の地面の最高より 9.5m 以上上（道路・川の上を渡る空き）
HS_STN_Y = 14.55      # 岡山駅の新幹線ホームのレール面（build_v5 の STN_LIFT 12.6m ＋ 床版の厚さ 1.95m）
def _grade_env(y, g):
    """区間ごとの勾配が g 以下になる最小の包絡（前向き・後ろ向きに y[i] ≥ y[i∓1] − g）"""
    y = y.copy()
    for i in range(1, len(y)): y[i] = max(y[i], y[i - 1] - g)
    for i in range(len(y) - 2, -1, -1): y[i] = max(y[i], y[i + 1] - g)
    return y
def hs_profile(g_raw, tn, stations, ds=2.0):
    """v36: 新幹線のレール面の縦断。以前は「地面（10m でならした）＋10.5m」で、地形の凸凹と丘（トンネルの上）をそのまま写し、
    最大で 468‰・高さ 10〜48m の上下があった。今は、地面の最高＋9.5m を下限に、勾配 12‰ 以下・なめらかな縦断（反復: 勾配の包絡 → ガウス平滑 → 下限）。
    トンネルと、その前後 80m は下限なし（丘の下をくぐる）。駅のホーム（前後 250m）は水平:
    岡山駅は 14.55m（駅舎モデルに合わせた値）、そのほかの駅は、駅の前後の下限の最大"""
    from scipy.ndimage import maximum_filter1d, gaussian_filter1d, binary_dilation
    n = len(g_raw)
    gm = maximum_filter1d(g_raw, 21, mode="nearest")
    free = binary_dilation(tn.astype(bool), iterations=int(80 / ds)) if tn.any() else np.zeros(n, bool)
    LB = np.where(free, -1e9, gm + HS_CLEAR)
    wins = []
    for k_stn, yfix in stations:
        w = np.zeros(n, bool); w[max(0, k_stn - int(250 / ds)):min(n, k_stn + int(250 / ds) + 1)] = True
        if yfix is None: yfix = float(np.max(LB[w])) if np.max(LB[w]) > -1e8 else float(np.max(gm[w]) + HS_CLEAR)
        LB = np.where(w, np.maximum(LB, yfix), LB); wins.append((w, yfix))
    y = np.where(free, gm.min(), LB)
    G = HS_GRADE * ds
    LB2 = np.where(free, -1e9, LB + 0.3)             # 平滑で下限を割らないよう、反復の間は 0.3m 上げて作る
    def setstn(y):
        for w, yf in wins: y[w] = yf
    for w, yf in wins: LB2 = np.where(w, np.maximum(LB2, yf), LB2)
    for it in range(14):
        y = _grade_env(np.maximum(y, LB2), G)
        y = gaussian_filter1d(y, 40, mode="nearest")                  # 80m（鉛直曲線）
        setstn(y)
    for it in range(3):                                                # 仕上げ: 下限・勾配の順にそろえ、小さな段を平滑
        y = _grade_env(np.maximum(y, LB), G)
        y = gaussian_filter1d(y, 4, mode="nearest"); setstn(y)
    setstn(y)
    y = _grade_env(np.maximum(y, LB), G * 1.2)
    return y

def resample(P, tags, step=2.0):
    seg = np.hypot(*np.diff(P, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)])
    ss = np.arange(0, cum[-1], step)
    idx = np.clip(np.searchsorted(cum, ss, side="right") - 1, 0, len(P) - 2)
    t = (ss - cum[idx]) / np.maximum(seg[idx], 1e-9)
    Q = P[idx] + (P[idx + 1] - P[idx]) * t[:, None]
    br = np.array([1 if (tags[k + 1].get("bridge") in ("yes", "viaduct")) else 0 for k in idx])
    tn = np.array([1 if (tags[k + 1].get("tunnel") not in (None, "no")) else 0 for k in idx])
    def _ms(t):
        try: return int(str(t.get("maxspeed", "")).split()[0])
        except Exception: return 0
    ms = np.array([_ms(tags[k + 1]) for k in idx])
    return Q, ss, br, tn, ms

J = dict(note="JR の線形: OpenStreetMap (ODbL)。高架のレール面の高さ（新幹線 地面＋10.5m、在来線の橋 地面＋6.5m）・列車の本数・車両の形は仮定・簡略", lines=[])
all_tracks = []
from jr_hs import chains_hs
_CH = chains(); _CH["shinkansen"] = chains_hs()          # v36: 新幹線は福山〜相生の全線（wx/hs/osm_hs2.json）
# 新幹線の駅（OSM の railway=stop）: 岡山・新倉敷・福山・相生
_HS_ST = {"岡山": None, "新倉敷": None, "福山": None, "相生": None}
_stj = json.load(open("/home/claude/wx/hs/osm_st.json"))["elements"]
HS_NODES = {}
for e in _stj:
    if e["type"] == "node" and e.get("tags", {}).get("railway") == "stop" and e["tags"].get("name") in ("新倉敷", "福山", "相生"):
        from common import proj as _proj
        HS_NODES.setdefault(e["tags"]["name"], []).append(np.array(_proj(e["lat"], e["lon"])))
for key, res in _CH.items():
    hs = key == "shinkansen"
    if hs:        # 福山の西 1.5km 〜 相生の東 1km で切る
        res = [(P[(P[:, 0] > -52500) & (P[:, 0] < 51800)], [t for t, p in zip(tags, P) if -52500 < p[0] < 51800], L) for P, tags, L in res]
    for ti, (P, tags, L) in enumerate(res[:2]):
        Q, ss, br, tn, ms = resample(P, tags, 2.0)
        g_raw = np.array([ground(x, z) for x, z in Q])
        g = ndimage.gaussian_filter1d(g_raw, 5.0, mode="nearest")
        if hs:
            k_stn = int(np.argmin(np.hypot(*(Q - STN).T)))
            stl = [(k_stn, HS_STN_Y)]
            for nm, L_ in HS_NODES.items():
                c_ = np.mean(L_, axis=0); k_ = int(np.argmin(np.hypot(*(Q - c_).T)))
                if np.hypot(*(Q[k_] - c_)) < 120: stl.append((k_, None))
            yh = hs_profile(g_raw, tn, stl)
            lift = np.where(tn > 0, 0.0, 10.5)   # el の判定用（トンネル以外は高架）
        else:
            b = ndimage.maximum_filter1d(br.astype(float), 1)      # 橋の区間
            # 前後 80m（40 点）でなめらかに
            lift = ndimage.gaussian_filter1d(ndimage.maximum_filter1d(b, 30) * BR_RAIL, 14.0, mode="nearest")
        y = (yh + 0.0) if hs else g + 0.35 + lift
        el = (lift > 1.5).astype(np.int8)
        k_ = int(np.argmin(np.hypot(*(Q - STN).T)))
        all_tracks.append(dict(key=key, ti=ti, Q=Q, y=y, g=g, el=el, tun=tn.astype(np.int8), ms=ms, stop=float(ss[k_]), L=float(ss[-1])))
# 複線の新幹線: 相手の線までの距離（床版の内側の幅）
def inner_half(T, others):
    if not others: return np.full(len(T["Q"]), 2.0)
    tree = cKDTree(np.concatenate([o["Q"] for o in others]))
    dd, _ = tree.query(T["Q"])
    return np.where(dd < 9.0, dd / 2.0, 2.0)
piers_all = []
# 在来線の線路の上（2.6m 以内）には橋脚を立てない（岡山駅では新幹線の高架の下を在来線が通る）
from shapely.geometry import LineString as _LS, Point as _Pt
from shapely.ops import unary_union as _uu
from shapely.prepared import prep as _prep
# 新幹線ホームの西半分（PLATEAU c9f7。build_v5 で高架の上へ持ち上げた建物）の下は、建物マスクがあっても橋脚を立てる
from shapely.geometry import Polygon as _Pg
_LIFT = _prep(_Pg([(-55.7, -220.2), (-260.4, 122.0), (-245.7, 130.8), (-41.1, -211.5)]).buffer(-0.5))
_CONV = _prep(_uu([_LS(T["Q"]).buffer(2.6) for T in all_tracks if T["key"] != "shinkansen"]))
for T in all_tracks:
    mates = [o for o in all_tracks if o is not T and o["key"] == T["key"]]
    T["inner"] = inner_half(T, mates) if T["key"] == "shinkansen" else np.full(len(T["Q"]), 2.0)
    # 外側は「進む向きの右」か「左」か: 相手の線と反対側
    if mates:
        tree = cKDTree(np.concatenate([o["Q"] for o in mates])); _, ii = tree.query(T["Q"]); M = np.concatenate([o["Q"] for o in mates])[ii]
        tg = np.gradient(T["Q"], axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
        rt = np.stack([-tg[:, 1], tg[:, 0]], 1)              # 右（x 東・z 南）
        side = np.sign(np.sum((M - T["Q"]) * rt, axis=1)); side[side == 0] = 1
        T["mate_side"] = ndimage.median_filter(side, 25)      # 相手のいる側（+1 右）
    else:
        T["mate_side"] = np.zeros(len(T["Q"]))
    # 橋脚（高架の区間・データの範囲の中）: 10m おき、車道・歩道・建物の上は避ける
    tg = np.gradient(T["Q"], axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    last = -99
    for k in range(0, len(T["Q"])):
        if not T["el"][k]: continue
        x, z = T["Q"][k]
        if not inData(x, z) and T["key"] != "shinkansen": continue     # v36: 新幹線は地図の外（遠景の地形の上）にも橋脚を立てる
        s = k * 2.0
        if s - last < 10.0: continue
        rt = np.array([-tg[k, 1], tg[k, 0]])
        # 柱は線の外側寄り（複線の新幹線は外側 1.6m）
        off = -T["mate_side"][k] * 1.4 if T["key"] == "shinkansen" else 0.0
        px, pz = T["Q"][k] + rt * off
        if kind(px, pz) in (1, 2) or (bld(px, pz) and not _LIFT.contains(_Pt(px, pz))) or _CONV.contains(_Pt(px, pz)): continue
        piers_all.append([round(float(px), 2), round(float(pz), 2), round(float(T["g"][k]), 2), round(float(T["y"][k] - 0.35 - 1.7), 2),
                          round(float(math.atan2(tg[k, 0], tg[k, 1])), 3)])
        last = s
# v35: 運転用の駅（OSM の railway=stop・JR 西日本。貨物ターミナルは除く）と、再現範囲の中の区間
from osm_load import load as _osm_load
_ways, _nodes = _osm_load()
_stops = [n for n in _nodes if n["tags"].get("railway") == "stop" and n["tags"].get("train") == "yes" and "貨物" not in (n["tags"].get("operator") or "") and n["tags"].get("name")]
_plat = [w for w in _ways if w["tags"].get("railway") == "platform" or w["tags"].get("public_transport") == "platform"]
def _arc_of(T, p):
    d = np.hypot(*(T["Q"] - p).T); k = int(np.argmin(d)); return k * 2.0, float(d[k])
for T in all_tracks:
    inside = [k for k in range(len(T["Q"])) if inData(*T["Q"][k])]
    T["i0"], T["i1"] = (inside[0], inside[-1]) if inside else (0, len(T["Q"]) - 1)
    if T["key"] == "shinkansen": T["i0"], T["i1"] = 0, len(T["Q"]) - 1      # v36: 新幹線は OSM で取れた全線（遠景の地形の上まで）
    # 近い（36m 以内）停車位置を駅ごとにまとめる（上下ホームの重複は、線に近い方を採る）
    best = {}
    for n in _stops:
        s_, d_ = _arc_of(T, np.array([n["x"], n["z"]]))
        nm = n["tags"]["name"]
        if d_ > 36.0 or not (T["i0"] * 2.0 + 10 < s_ < T["i1"] * 2.0 - 10): continue
        if T["key"] == "shinkansen" and nm != "岡山": continue     # 並走する在来線の駅は新幹線は止まらない
        # 同じ駅名の複数の停車位置は、近い順の中央値（ホームの途中）
        best.setdefault(nm, []).append((d_, s_))
    T["stops"] = []
    for nm, L_ in best.items():
        L_.sort(); near = [s for d, s in L_ if d <= L_[0][0] + 8.0]; s_ = float(np.median(near))
        # ホームの長さ: 線から 14m 以内の platform の点が、駅の前後 350m に広がる長さ（取れなければ 0）
        pts = []
        for w in _plat:
            for q in np.asarray(w["xy"]):
                ss, dd = _arc_of(T, q)
                if dd < 14.0 and abs(ss - s_) < 350: pts.append(ss)
        plat = float(max(pts) - min(pts)) if len(pts) > 2 else 0.0
        T["stops"].append(dict(name=nm, s=round(s_, 1), plat=round(plat, 0)))
    if T["key"] == "shinkansen":     # v36: 新倉敷・福山・相生（OSM の停車位置。ホームの長さは 12 両編成+α として 420m と仮定）
        for nm, L_ in HS_NODES.items():
            ar = [_arc_of(T, p) for p in L_]; ar = [(d_, s_) for s_, d_ in ar if d_ < 80]
            if ar: T["stops"].append(dict(name=nm, s=round(float(np.median([s_ for d_, s_ in ar])), 1), plat=420.0))
    if not any(q["name"] == "岡山" for q in T["stops"]): T["stops"].append(dict(name="岡山", s=round(T["stop"], 1), plat=0.0))
    T["stops"].sort(key=lambda q: q["s"])
for T in all_tracks:
    J["lines"].append(dict(key=T["key"], ti=T["ti"], stop=round(T["stop"], 1), L=round(T["L"], 1), i0=int(T["i0"]), i1=int(T["i1"]), stops=T["stops"],
                           p=[round(float(v), 1 if T["key"] == "shinkansen" else 2) for q, y in zip(T["Q"], T["y"]) for v in (q[0], y, q[1])],
                           lim=([[int(k), int(v)] for k, v in enumerate(T["ms"]) if k == 0 or v != T["ms"][k - 1]] if T["key"] == "shinkansen" else []),
                           el=T["el"].tolist(), tun=T["tun"].tolist(), inner=[round(float(v), 1) for v in T["inner"]], mate=[int(v) for v in T["mate_side"]]))
J["piers"] = piers_all
s = json.dumps(J, ensure_ascii=False, separators=(",", ":"))
open(f"{OUT}/jr.json", "w").write(s)
for T in all_tracks:
    print(T["key"], T["ti"], "len", round(T["L"]), "stop", round(T["stop"]), "elevated pts", int(T["el"].sum()), "y range", round(float(T["y"].min()), 1), round(float(T["y"].max()), 1))
print("piers", len(piers_all), "size %.2f MB" % (len(s) / 1e6))

# 検証用（v36）: 新幹線の縦断の確認
_h = [T for T in all_tracks if T["key"] == "shinkansen"]
np.savez("/home/claude/wx/hs_dbg.npz", **{f"Q{T['ti']}": T["Q"] for T in _h}, **{f"y{T['ti']}": T["y"] for T in _h}, **{f"g{T['ti']}": T["g"] for T in _h}, **{f"tn{T['ti']}": T["tun"] for T in _h})
