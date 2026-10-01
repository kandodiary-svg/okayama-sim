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
def ground(x, z):
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

def resample(P, tags, step=2.0):
    seg = np.hypot(*np.diff(P, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)])
    ss = np.arange(0, cum[-1], step)
    idx = np.clip(np.searchsorted(cum, ss, side="right") - 1, 0, len(P) - 2)
    t = (ss - cum[idx]) / np.maximum(seg[idx], 1e-9)
    Q = P[idx] + (P[idx + 1] - P[idx]) * t[:, None]
    br = np.array([1 if (tags[k + 1].get("bridge") in ("yes", "viaduct")) else 0 for k in idx])
    return Q, ss, br

J = dict(note="JR の線形: OpenStreetMap (ODbL)。高架のレール面の高さ（新幹線 地面＋10.5m、在来線の橋 地面＋6.5m）・列車の本数・車両の形は仮定・簡略", lines=[])
all_tracks = []
for key, res in chains().items():
    hs = key == "shinkansen"
    for ti, (P, tags, L) in enumerate(res[:2]):
        Q, ss, br = resample(P, tags, 2.0)
        g = np.array([ground(x, z) for x, z in Q])
        g = ndimage.gaussian_filter1d(g, 5.0, mode="nearest")
        if hs:
            lift = np.full(len(Q), HS_RAIL)
        else:
            b = ndimage.maximum_filter1d(br.astype(float), 1)      # 橋の区間
            # 前後 80m（40 点）でなめらかに
            lift = ndimage.gaussian_filter1d(ndimage.maximum_filter1d(b, 30) * BR_RAIL, 14.0, mode="nearest")
        y = g + 0.35 + lift
        el = (lift > 1.5).astype(np.int8)
        k_ = int(np.argmin(np.hypot(*(Q - STN).T)))
        all_tracks.append(dict(key=key, ti=ti, Q=Q, y=y, g=g, el=el, stop=float(ss[k_]), L=float(ss[-1])))
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
        if not inData(x, z): continue
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
for T in all_tracks:
    J["lines"].append(dict(key=T["key"], ti=T["ti"], stop=round(T["stop"], 1), L=round(T["L"], 1),
                           p=[round(float(v), 2) for q, y in zip(T["Q"], T["y"]) for v in (q[0], y, q[1])],
                           el=T["el"].tolist(), inner=[round(float(v), 2) for v in T["inner"]], mate=[int(v) for v in T["mate_side"]]))
J["piers"] = piers_all
s = json.dumps(J, ensure_ascii=False, separators=(",", ":"))
open(f"{OUT}/jr.json", "w").write(s)
for T in all_tracks:
    print(T["key"], T["ti"], "len", round(T["L"]), "stop", round(T["stop"]), "elevated pts", int(T["el"].sum()), "y range", round(float(T["y"].min()), 1), round(float(T["y"].max()), 1))
print("piers", len(piers_all), "size %.2f MB" % (len(s) / 1e6))
