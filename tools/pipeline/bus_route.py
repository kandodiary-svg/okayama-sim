"""両備バス 西大寺線（岡山駅東口 13番のりば → 天満屋 → 県庁前 → 古京 → 門田屋敷 → 東山）の走行経路を作る。
停留所の順序と代表位置: 晴れバスナビ（okayama-bus.net）の経路ページ（岡山西大寺線 06:37 岡山駅発）。
のりば: 岡山駅東口 13番（岡山駅東口バスのりば行き先案内 PDF）、天満屋は両備バスの 2〜6番のうち 4番（推定）。
道路: OSM の車道（一方通行を守る）＋ 岡山駅東口のバス専用ループ（bus=yes）。停留所の標柱が左側（歩道側）に来る向きで通る。
経路は「辺単位のダイクストラ」（右左折・転回に費用）で停留所間を最短に結び、Viterbi で各停留所の標柱候補を選ぶ。
出力: /home/claude/okaden-x/data/bus.json
"""
import os, sys, json, math, heapq, base64, zlib
import numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load
from common import proj

OUT = "/home/claude/okaden-x/data"
ways, nodes = osm_load()
sc = json.load(open(f"{OUT}/scene.json")); dm = sc["drive"]
import geo_io; raw = geo_io.read("drive")
n_ = dm["nx"] * dm["nz"]
DH = np.frombuffer(raw[:n_ * 2], np.int16).reshape(dm["nz"], dm["nx"]) / 100.0
def h_at(x, z):
    fx = (x - dm["x0"]) / dm["step"] - 0.5; fz = (z - dm["z0"]) / dm["step"] - 0.5
    i = int(np.clip(math.floor(fx), 0, dm["nx"] - 2)); j = int(np.clip(math.floor(fz), 0, dm["nz"] - 2))
    tx = min(1, max(0, fx - i)); tz = min(1, max(0, fz - j))
    return float((DH[j, i] * (1 - tx) + DH[j, i + 1] * tx) * (1 - tz) + (DH[j + 1, i] * (1 - tx) + DH[j + 1, i + 1] * tx) * tz)

STOPS = [  # 名前, 緯度, 経度（晴れバスナビ）, OSM の標柱名, のりば
    ("岡山駅", 34.665673, 133.918221, "岡山駅東口", "13"),
    ("岡山駅前", 34.665295, 133.920383, "岡山駅前", None),
    ("NTT岡山前", 34.662906, 133.926125, "NTT岡山前", None),
    ("天満屋", 34.662027, 133.928879, "天満屋", "4"),
    ("中銀前", 34.662321, 133.931034, "中銀前", None),
    ("県庁前", 34.662234, 133.934464, "県庁前", None),
    ("古京", 34.660378, 133.940300, "古京", None),
    ("門田屋敷", 34.657795, 133.938885, "門田屋敷", None),
    ("山陽学園中学・高校前", 34.656142, 133.939612, "山陽学園 中学・高校前", None),
    ("東山電停前", 34.656239, 133.942686, "東山電停前", None),
    ("東山", 34.656406, 133.943601, "東山", None),
]
CLS = {"trunk": 1.0, "primary": 1.0, "secondary": 1.05, "tertiary": 1.1, "unclassified": 3.0, "residential": 5.0,   # v14: 路線バスは細い道を抜け道にしない
       "trunk_link": 1.0, "primary_link": 1.0, "secondary_link": 1.05, "tertiary_link": 1.1, "service": 1.3}
def usable(t):
    hw = t.get("highway")
    if hw not in CLS: return False
    if hw == "service": return t.get("bus") == "yes" or t.get("psv") == "yes"
    if t.get("access") in ("no", "private") and t.get("bus") != "yes": return False
    return True
rw = [w for w in ways if usable(w["tags"]) and len(w["nodes"]) >= 2]
coord = {}
adj = {}   # node -> list of (next_node, length, way_idx)
for wi, w in enumerate(rw):
    ns = w["nodes"]; xy = w["xy"]; t = w["tags"]
    ow = t.get("oneway"); fwd = ow != "-1"; bwd = not (ow in ("yes", "true", "1", "-1") or t.get("junction") == "roundabout") or ow == "-1"
    for k, nid in enumerate(ns): coord[nid] = np.array(xy[k], float)
    for a, b in zip(ns[:-1], ns[1:]):
        L = float(np.hypot(*(coord[a] - coord[b])))
        if L < 1e-6: continue
        if fwd: adj.setdefault(a, []).append((b, L, wi))
        if bwd: adj.setdefault(b, []).append((a, L, wi))
print("graph nodes", len(coord), "ways", len(rw))

def turn_cost(pa, pb, pc):
    d1 = pb - pa; d2 = pc - pb
    n1 = np.linalg.norm(d1); n2 = np.linalg.norm(d2)
    if n1 < 1e-6 or n2 < 1e-6: return 0.0
    cr = (d1[0] * d2[1] - d1[1] * d2[0]) / (n1 * n2); dt = (d1 @ d2) / (n1 * n2)
    th = math.degrees(math.atan2(cr, dt))
    if abs(th) > 150: return 1e6                  # 転回しない
    if abs(th) < 30: return 0.0
    return 25.0 if th > 0 else 10.0               # 右折（th>0）は左折より重い（左側通行）

def dijkstra(src_edges, dst_edges):
    """src_edges: [(u, v, offset_cost)] 始点の向き付き辺, dst_edges: {(u,v): end_cost}"""
    pq = []; dist = {}; prev = {}
    for u, v, c in src_edges:
        st = (u, v); dist[st] = c; heapq.heappush(pq, (c, u, v))
    best = None
    while pq:
        d, u, v = heapq.heappop(pq)
        if d > dist.get((u, v), 1e18): continue
        if (u, v) in dst_edges:
            tot = d + dst_edges[(u, v)]
            if best is None or tot < best[0]: best = (tot, (u, v))
        if best is not None and d > best[0]: break
        for w_, L, wi in adj.get(v, []):
            if w_ == u: continue
            tc = turn_cost(coord[u], coord[v], coord[w_])
            if tc >= 1e6: continue
            nd = d + L * CLS[rw[wi]["tags"]["highway"]] + tc
            if nd < dist.get((v, w_), 1e18):
                dist[(v, w_)] = nd; prev[(v, w_)] = (u, v); heapq.heappush(pq, (nd, v, w_))
    if best is None: return None, None
    path = [best[1]]
    while path[-1] in prev: path.append(prev[path[-1]])
    path.reverse()
    return best[0], path

# 有向辺の一覧（標柱の射影に使う）
E = []
for a, lst in adj.items():
    for b, L, wi in lst: E.append((a, b, wi))
Emid = np.array([(coord[a] + coord[b]) / 2 for a, b, _ in E]); ek = cKDTree(Emid)
def snap_candidates(p, rad=35.0, strict=False):
    """標柱 p を通る有向辺と、その辺上の位置。標柱が進行方向の右側になる向きは、
    反対側に標柱があるものとして（左側へ鏡映）罰則付きで候補にする（OSM に片側の標柱しか無い停留所用）"""
    out = []
    for i in ek.query_ball_point(p, rad + 60):
        a, b, wi = E[i]; A = coord[a]; B = coord[b]; d = B - A; L = np.linalg.norm(d)
        if L < 1e-6: continue
        t = float(np.clip((p - A) @ d / (L * L), 0, 1)); q = A + d * t
        dist = float(np.linalg.norm(p - q))
        if dist > rad: continue
        left = np.array([d[1], -d[0]]) / L
        side = float((p - q) @ left)
        pole = p; pen = 0.0
        if side < 0 and dist > 1.5:
            if strict: continue
            pole = q + left * max(4.0, dist); pen = 80.0
        out.append(dict(a=a, b=b, wi=wi, t=t, q=q, dist=dist, L=L, pole=pole, pen=pen))
    out.sort(key=lambda c: c["dist"] + c["pen"])
    return out[:8]

FORCE_WAYS = {"古京": (464078809, 1316254930)}   # 古京: 国道250号の南行き（古京交差点から門田屋敷方面）
bs_nodes = [n for n in nodes if n["tags"].get("highway") == "bus_stop" or n["tags"].get("public_transport") == "platform"]
cands = []
for nm, lat, lon, osm_nm, bay in STOPS:
    x, z = proj(lat, lon); p0 = np.array([x, z])
    poles = []
    for n in bs_nodes:
        t = n["tags"]
        if (t.get("name") or "").replace(" ", "") != osm_nm.replace(" ", ""): continue
        if bay and (t.get("local_ref") or t.get("ref")) != bay: continue
        q = np.array([n["x"], n["z"]])
        if np.linalg.norm(q - p0) < 160: poles.append(q)
    if not poles: poles = [p0]
    cs = []
    if nm in FORCE_WAYS:
        # v14: 向き別の本線（上下線が別の道になっている国道）で、進む向きの車道の左側に標柱を置く
        for h in ek.query_ball_point(p0, 80):
            a_, b_, wi = E[h]
            if rw[wi]["id"] not in FORCE_WAYS[nm]: continue
            A = coord[a_]; B = coord[b_]; d = B - A; L = np.linalg.norm(d)
            if L < 1e-6: continue
            t = float(np.clip((p0 - A) @ d / (L * L), 0, 1)); q = A + d * t
            left = np.array([d[1], -d[0]]) / L
            cs.append(dict(a=a_, b=b_, wi=wi, t=t, q=q, dist=float(np.linalg.norm(p0 - q)), L=L, pole=q + left * 4.0, pen=0.0))
        cs.sort(key=lambda c: c["dist"]); cs = cs[:2]
    for q in (poles if not cs else []):
        cs += snap_candidates(q, 14.0, True) if bay else snap_candidates(q)
    if not cs:
        for q in poles: cs += snap_candidates(q, 30.0, True)
    print(nm, "poles", len(poles), "candidates", len(cs))
    cands.append(cs)

# Viterbi: 各停留所の候補の組み合わせで総距離最小
def leg(c1, c2):
    src = [(c1["a"], c1["b"], (1 - c1["t"]) * c1["L"])]
    dst = {(c2["a"], c2["b"]): -(1 - c2["t"]) * c2["L"]}
    if c1["a"] == c2["a"] and c1["b"] == c2["b"] and c2["t"] >= c1["t"]:
        return (c2["t"] - c1["t"]) * c1["L"], [(c1["a"], c1["b"])]
    return dijkstra(src, dst)
V = [[(0.0, None, None) for _ in cands[0]]]
for si in range(1, len(cands)):
    row = []
    for j, c2 in enumerate(cands[si]):
        best = (1e18, None, None)
        for i, c1 in enumerate(cands[si - 1]):
            if V[-1][i][0] >= 1e17: continue
            cost, path = leg(c1, c2)
            if cost is None: continue
            tot = V[-1][i][0] + cost + c2["dist"] * 3 + c2["pen"]
            if tot < best[0]: best = (tot, i, path)
        row.append(best)
    V.append(row)
    print("stop", STOPS[si][0], "best", round(min(r[0] for r in row)) if row else None)
j = int(np.argmin([r[0] for r in V[-1]]))
sel = [None] * len(cands); legs = [None] * len(cands)
for si in range(len(cands) - 1, -1, -1):
    sel[si] = cands[si][j]
    if si > 0: legs[si] = V[si][j][2]; j = V[si][j][1]

# 折れ線にする（停留所の射影点から次の停留所の射影点まで）
pts = [sel[0]["q"]]; stop_idx = [0]
for si in range(1, len(sel)):
    path = legs[si]
    for k, (u, v) in enumerate(path):
        if k == 0: continue
        pts.append(coord[u])
    pts.append(sel[si]["q"]); stop_idx.append(len(pts) - 1)
pts = np.array(pts)
# 重複点を除く
keep = [0]
for i in range(1, len(pts)):
    if np.linalg.norm(pts[i] - pts[keep[-1]]) > 0.3 or i in stop_idx: keep.append(i)
remap = {i: n for n, i in enumerate(keep)}
pts = pts[keep]; stop_idx = [remap.get(i, None) for i in stop_idx]
seg = np.hypot(*np.diff(pts, axis=0).T); arc = np.concatenate([[0], np.cumsum(seg)])
print("route length", round(arc[-1]), "m")

# 車線へ寄せる: 同じ向きの車線（traffic.json）があればその中心へ。停留所の前後 60m は一番左の車線
TJ = json.load(open(f"{OUT}/traffic.json"))
LP, LT, LK = [], [], []
for ln in TJ["lanes"]:
    p = np.array(ln["p"])[:, [0, 2]]; t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
    LP.append(p); LT.append(t); LK += [(ln["k"], ln["n"])] * len(p)
LP = np.concatenate(LP); LT = np.concatenate(LT); lk = cKDTree(LP)
def resample(xy, step):
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    t = np.arange(0, s[-1], step); t = np.append(t, s[-1])
    return np.stack([np.interp(t, s, xy[:, 0]), np.interp(t, s, xy[:, 1])], 1), t, s
R, rs, s0 = resample(pts, 2.0)
# 小さな折り返し・輪（標柱の射影が並行する別の道に乗った所など）を取り除く
changed = True
while changed:
    changed = False
    for i in range(len(R) - 3):
        for j in range(min(len(R) - 1, i + 34), i + 2, -1):
            if np.linalg.norm(R[i] - R[j]) < 3.5 and (rs[j] - rs[i]) > 3 * max(1.0, np.linalg.norm(R[i] - R[j])) and (rs[j] - rs[i]) < 90:
                R = np.concatenate([R[:i + 1], R[j:]]); rs = np.concatenate([rs[:i + 1], rs[j:]]); changed = True; break
        if changed: break
stop_arc = [float(arc[i]) for i in stop_idx]
# v14: 走る位置（横方向）を決める。以前は 2m ごとに一番近い車線の点へ移していたため、交差点の前後で車線の本数・位置が
# 変わるたびに行き来してジグザグになっていた。ここでは
# ① OSM の中心線を軽くならし（角は半径 8m 程度の曲線に）、② 中心線から左の縁石（車道の端）までの距離を測り、
# ③ 交差点・右左折車線でのふくらみを長い窓の中央値で無視してから、「左端の車線＝縁石から 1.8m」を目標にする。
#    右折の手前（60m）は右の車線へ（一方通行は右端の車線、両方向の道は中央線の左 1.8m）。
# ④ ずれ量の列をならし（車線変更はおよそ 40m かけて）、中心線＋法線×ずれ量を経路にする。
from scipy.ndimage import gaussian_filter1d, median_filter
import pickle as _pk0
_R0 = _pk0.load(open("/home/claude/wx/roads_final.pkl", "rb")); _K0 = _R0["KIND"]; _G0 = _R0["grid"]
def _k0(x, z):
    i = int((x - _G0[0]) / _G0[2]); j = int((z - _G0[1]) / _G0[2])
    return _K0[j, i] if 0 <= j < _K0.shape[0] and 0 <= i < _K0.shape[1] else 0
Rs = np.stack([gaussian_filter1d(R[:, 0], 2.0, mode="nearest"), gaussian_filter1d(R[:, 1], 2.0, mode="nearest")], 1)
tg = np.gradient(Rs, axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
left_ = np.stack([tg[:, 1], -tg[:, 0]], 1)
hd = np.unwrap(np.arctan2(tg[:, 1], tg[:, 0]))
N_ = len(Rs)
# OSM の中心線が PLATEAU の車道から外れている所（歩道・地面の上）は、横に一番近い車道の点を基準にする
base = np.full(N_, np.nan)
for i in range(N_):
    if _k0(*Rs[i]) == 1: base[i] = 0.0; continue
    for o in np.arange(0.5, 10.01, 0.5):
        if _k0(*(Rs[i] + left_[i] * o)) == 1: base[i] = o + 0.5; break
        if _k0(*(Rs[i] - left_[i] * o)) == 1: base[i] = -o - 0.5; break
def edge(i, sgn):
    if not np.isfinite(base[i]): return np.nan
    for o in np.arange(0.25, 25.0, 0.25):
        q = Rs[i] + left_[i] * (base[i] + o * sgn)
        if _k0(*q) != 1: return o + sgn * base[i]
    return np.nan
dL = np.array([edge(i, 1) for i in range(N_)]); dR = np.array([edge(i, -1) for i in range(N_)])
onroad = np.isfinite(base) & ~((Rs[:, 0] < 0) & (Rs[:, 0] > -170) & (Rs[:, 1] > -60) & (Rs[:, 1] < 125))   # 駅前広場のバス路は中心線どおり
# 一方通行か（同じ向きの一番近い辺の道）
ow = np.zeros(N_, bool)
for i in range(N_):
    best = None
    for h in ek.query_ball_point(Rs[i], 25.0):
        a_, b_, wi = E[h]; d = coord[b_] - coord[a_]; L = np.linalg.norm(d)
        if L < 1e-6 or (d / L) @ tg[i] < 0.8: continue
        t_ = float(np.clip((Rs[i] - coord[a_]) @ d / (L * L), 0, 1)); dd = np.linalg.norm(Rs[i] - (coord[a_] + d * t_))
        if best is None or dd < best[0]: best = (dd, wi)
    if best: ow[i] = rw[best[1]]["tags"].get("oneway") in ("yes", "true", "1", "-1")
def nanmed(v, w):
    out = np.full(len(v), np.nan); h = w // 2
    for i in range(len(v)):
        seg_ = v[max(0, i - h):i + h + 1]; seg_ = seg_[np.isfinite(seg_)]
        if len(seg_): out[i] = np.median(seg_)
    return out
dLs = nanmed(dL, 41); dRs = nanmed(dR, 41)
tgtL = dLs - 1.8
tgtR = np.where(ow, -(dRs - 1.8), 1.8)
# 右折の準備（60m 先までに右へ 50°以上）
rt = np.array([(hd[min(N_ - 1, i + 30)] - hd[i]) > np.radians(50) for i in range(N_)]).astype(float)
rt = gaussian_filter1d(np.maximum.accumulate(rt[::-1])[::-1] * 0 + rt, 6.0, mode="nearest")
rt = np.clip(rt * 2.0, 0, 1)
offs = np.where(np.isfinite(tgtL), tgtL, 0.0)
offs = np.where(ow | np.isfinite(tgtL), offs, 0.0)
offs = np.where(~ow & np.isfinite(tgtL), np.maximum(offs, 1.6), offs)             # 両方向の道は中央線より左
offs = offs * (1 - rt) + np.where(np.isfinite(tgtR), tgtR, 0.0) * rt
offs = np.where(onroad, offs, 0.0)                                                # 車道の外（駅前広場のバス路など）は中心線
offs = median_filter(offs, size=9, mode="nearest")
offs = gaussian_filter1d(offs, 6.0, mode="nearest")
# 交差点の曲がり角では横ずれを弱める（法線の向きが回るため、ずれを付けたままだと角で鉤形になる）
kc = np.abs(np.gradient(hd)) / 2.0                    # 1m あたりの向きの変化
corner = gaussian_filter1d((kc > 0.025).astype(float), 5.0, mode="nearest")
corner = np.clip(corner * 2.5, 0, 1)
offs = offs * (1 - corner)
out = Rs + left_ * offs[:, None]
# 車体（幅 2.5m）の両側に縁石まで 0.55m 以上の余裕を取る（曲がり角の内側・車道の縁の凹凸で歩道に乗らないように）
tgo = np.gradient(out, axis=0); tgo /= np.linalg.norm(tgo, axis=1)[:, None] + 1e-9
lo_ = np.stack([tgo[:, 1], -tgo[:, 0]], 1)
push = np.zeros(N_)
for i in range(N_):
    if not onroad[i] or _k0(*out[i]) != 1: continue
    el = next((o for o in np.arange(0.25, 3.01, 0.25) if _k0(*(out[i] + lo_[i] * o)) != 1), 3.25)
    er = next((o for o in np.arange(0.25, 3.01, 0.25) if _k0(*(out[i] - lo_[i] * o)) != 1), 3.25)
    need = 1.8
    if el < need and er > need: push[i] = -min(need - el, er - need)
    elif er < need and el > need: push[i] = min(need - er, el - need)
push = gaussian_filter1d(-gaussian_filter1d(-push, 0.1) if False else push, 3.0, mode="nearest")
push = np.where(np.abs(push) > 0.05, push, 0.0)
out = out + lo_ * push[:, None]
snapped = onroad
seg = np.hypot(*np.diff(out, axis=0).T); arc2 = np.concatenate([[0], np.cumsum(seg)])
stops = []
for si, (nm, lat, lon, osm_nm, bay) in enumerate(STOPS):
    k = int(np.argmin(np.abs(rs - stop_arc[si])))
    pole = sel[si]["pole"]
    stops.append(dict(name=nm, arc=round(float(arc2[k]), 1), pole=[round(float(pole[0]), 2), round(float(pole[1]), 2)], bay=bay))
# ---- 停留所: 標柱を「経路の左側の歩道の縁」に置き直し、バスを縁石へ寄せる（前扉が標柱の横、車体側面と縁石の間 0.4m） ----
import pickle as _pk
_R = _pk.load(open("/home/claude/wx/roads_final.pkl", "rb")); _K = _R["KIND"]; _G = _R["grid"]
def _kind(x, z):
    i = int((x - _G[0]) / _G[2]); j = int((z - _G[1]) / _G[2])
    return _K[j, i] if 0 <= j < _K.shape[0] and 0 <= i < _K.shape[1] else 0
tg3 = np.gradient(out, axis=0); tg3 /= np.linalg.norm(tg3, axis=1)[:, None] + 1e-9
shift = np.zeros(len(out))
for si, st_ in enumerate(stops):
    k = int(np.argmin(np.abs(arc2 - st_["arc"])))
    c = out[k]; t = tg3[k]; left = np.array([t[1], -t[0]])
    curb = 0
    if st_["bay"]:
        pole = np.array(st_["pole"]); lat = float((pole - c) @ left)
        if st_["name"] == "岡山駅":
            # 岡山駅東口: 標柱は幅 6.4m の島（上屋の下）の中央。島の縁は標柱から 3.2m、車体中心は縁から 1.65m
            st_["pole_osm"] = st_["pole"]
            edge = pole - left * 3.2
            st_["pole"] = [round(float(edge[0]), 2), round(float(edge[1]), 2)]
            want = lat - 3.2 - 1.65
        else:
            want = lat - 3.1                   # 天満屋: 標柱は駅舎の壁際。のりばの縁石（壁から 1.3m）＋車体半幅 1.25m＋すき間 0.4m
    else:
        curb = None
        for o in np.arange(0.5, 12.0, 0.25):
            q = c + left * o
            if _kind(*q) == 2 and _kind(*(c + left * (o - 0.5))) != 2: curb = o; break
        if curb is None:
            # 歩道のデータが無い所: 車道の端（車道でなくなる所）を縁石とみなす
            for o in np.arange(0.5, 18.0, 0.25):
                if _kind(*(c + left * o)) != 1: curb = o; break
        if curb is None:
            pole = np.array(st_["pole"]); want = float((pole - c) @ left) - 1.9
        else:
            pole = c + left * (curb + 0.5)
            want = curb - 1.65                     # 縁石から車体中心まで 1.65m（側面と縁石 0.4m）
        st_["pole"] = [round(float(pole[0]), 2), round(float(pole[1]), 2)]
    want = float(np.clip(want, -1.0, 8.0 if (st_["bay"] or curb is None) else 4.5))
    # 停留所の前後に台形状に寄せる（手前 45m・先 25m でなめらかに）
    for j in range(len(out)):
        d = arc2[j] - st_["arc"]
        if -45 < d < 25:
            w = 1.0 if -12 < d < 6 else ((d + 45) / 33 if d <= -12 else (25 - d) / 19)
            w = w * w * (3 - 2 * w)
            if abs(want * w) > abs(shift[j]): shift[j] = want * w
    print("  stop", st_["name"], "shift to curb", round(want, 2), "curb", curb)
out = out + np.stack([tg3[:, 1], -tg3[:, 0]], 1) * shift[:, None]
# v20: 天満屋バスステーション東側（北向き・4番のりば）: 車体中心を x=811.6 の直線に固定する
#   駅舎の壁 808.6 ＋ のりばの縁石 1.3m ＋ すき間 0.4m ＋ 車体半幅 1.25m。裏の通路から曲がって来た後になめらかに寄せ、のりばの先でなめらかに戻す
#   （経路が停止位置の手前で壁際 x≈808 を通り、車体が駅舎に食い込んで通れなかった）
# v20: 天満屋の裏の通路（駅舎の南・2 階の連絡通路の下）の 2 つの左折を、バスが曲がれる半径 8.5m の円弧で作り直す
#   （これまでの経路は半径 3〜5m の直角で、最小回転半径 約 8.3m のバスでは曲がれず建物に当たっていた）
#   西側: x=781.5 を南へ → 円弧（中心 790.0, 452.7）→ 通路 z=461.2 を東へ → 円弧（中心 809.5, 452.7）→ x=818 を北へ
_idx = np.arange(len(out))
_stop_xy = [out[int(round(np.interp(st_["arc"], arc2, _idx)))].copy() for st_ in stops]   # 停留所の位置（経路の点の数が変わるので位置で持つ）
_lo = np.nonzero((out[:, 0] > 770) & (out[:, 0] < 792) & (out[:, 1] > 425) & (out[:, 1] < 470))[0]
_hi = np.nonzero((out[:, 0] > 805) & (out[:, 0] < 830) & (out[:, 1] > 425) & (out[:, 1] < 470))[0]
if len(_lo) and len(_hi):
    i0 = int(_lo[0]); i1 = int(_hi[-1])
    while i0 > 0 and out[i0 - 1, 1] > 405 and out[i0 - 1, 0] < 792: i0 -= 1        # 西側の道の z≈405 から
    xa = float(out[i0, 0]); za = float(out[i0, 1])
    R_ = 10.0; pts = []          # 半径 10m（最小回転半径 約 8.3m に余裕。ハンドルは最大の 87%）。線・半径は建物とのすき間が最大になるよう探した（最小 0.55m）
    XW, ZP = 778.5, 461.0                                                        # 西の道の線（左折の前に外へふくらむ）・裏の通路の線
    for z in np.arange(za, ZP - R_, 1.0):
        t = np.clip((z - max(za, 420.0)) / (446.0 - max(za, 420.0)), 0, 1); t = t * t * (3 - 2 * t)
        pts.append([xa * (1 - t) + XW * t, z])
    for th in np.linspace(np.pi, np.pi / 2, 17): pts.append([XW + R_ + R_ * np.cos(th), ZP - R_ + R_ * np.sin(th)])
    _env = __import__("os").environ
    RE = float(_env.get("RE", "9.5")); XE = float(_env.get("XE", "815.6")) - RE    # 東の円弧 半径 9.5m・出口 x=815.6（駅舎の南東の角と、のりばへ寄せる時の尻振りの両方で すき間 0.26m 以上になるよう探した）
    for x in np.arange(XW + R_ + 1.0, XE, 1.0): pts.append([x, ZP])
    for th in np.linspace(np.pi / 2, 0, 17): pts.append([XE + RE * np.cos(th), ZP - RE + RE * np.sin(th)])
    zb = float(out[i1, 1])
    for z in np.arange(ZP - RE - 1.0, zb, -1.0): pts.append([XE + RE, z])
    out = np.concatenate([out[:i0], np.array(pts), out[i1 + 1:]])
    tg3 = np.gradient(out, axis=0); tg3 /= np.linalg.norm(tg3, axis=1)[:, None] + 1e-9
    print("  tenmaya back passage rebuilt with R=10 arcs:", i0, i1, len(pts))
TX = 811.6
_m = (out[:, 0] > 800) & (out[:, 0] < 830) & (out[:, 1] > 350) & (out[:, 1] < 458)
if _m.any():
    zz = out[:, 1]
    # 寄せる重み: z 452→440 で 0→1、z 392→380 で 1→0（なめらかに）
    def _ss(a, b, v): t = np.clip((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
    w = np.where(_m, _ss(451.0, 436.0, zz) * _ss(362.0, 396.0, zz), 0.0)
    out[:, 0] = out[:, 0] * (1 - w) + TX * w
    print("  tenmaya east leg fixed to x=%.1f points %d" % (TX, int((w > 0.99).sum())))
# v21: 岡山駅東口の出口。OSM のバス専用ループの出口（北側 z≈-14 を東へ）は、駅前広場へ延伸した軌道・新停留場（2027年3月開業予定）の
#   ホームと大屋根の真上を通る（OSM は延伸前の形）。延伸後は広場の中央を軌道が占めるため、ループを北東へ上がって来た所で
#   軌道の南側を東へ出て、駅前交差点（市役所筋との交差点・電車も通る所）で信号に従って軌道を斜めに渡り、岡山停車場線（桃太郎大通り）の
#   東行き車線へ入る。曲がりは半径 10m（最小回転半径 約 8.3m）
def _fillet_path(P, R):
    P = [np.asarray(q, float) for q in P]; res = [P[0]]
    for a, b, c in zip(P[:-2], P[1:-1], P[2:]):
        u = (b - a) / np.linalg.norm(b - a); v = (c - b) / np.linalg.norm(c - b)
        th = np.arccos(np.clip(u @ v, -1, 1))
        if th < 1e-3: res.append(b); continue
        tl = R * np.tan(th / 2); t0 = b - u * tl; t1 = b + v * tl
        crs = u[0] * v[1] - u[1] * v[0]; nrm = np.array([-u[1], u[0]]) * np.sign(crs)
        cc = t0 + nrm * R; a0 = np.arctan2(*(t0 - cc)[::-1]); a1 = np.arctan2(*(t1 - cc)[::-1])
        da = (a1 - a0 + np.pi) % (2 * np.pi) - np.pi
        for k in range(0, 13): an = a0 + da * k / 12; res.append(cc + R * np.array([np.cos(an), np.sin(an)]))
    res.append(P[-1])
    # 1m おきに並べ直す
    Q = np.array(res); d_ = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(Q, axis=0).T))])
    ss = np.arange(0, d_[-1], 1.0)
    return np.stack([np.interp(ss, d_, Q[:, 0]), np.interp(ss, d_, Q[:, 1])], 1)
_ES = None
_a = np.nonzero((out[:, 0] > -110) & (out[:, 0] < -95) & (out[:, 1] > 10) & (out[:, 1] < 40))[0]
_b = np.nonzero((out[:, 0] > -30) & (out[:, 0] < -20) & (out[:, 1] > -16) & (out[:, 1] < -10))[0]
if len(_a) and len(_b) and _a[-1] < _b[0]:
    i0 = int(_a[0]); i1 = int(_b[0])
    A0 = out[i0]; dA = out[i0 + 3] - out[i0]; dA /= np.linalg.norm(dA)
    ZE = 1.5                                                     # 軌道の南側を東へ（軌道敷の縁から約 4m）
    t_ = (ZE - A0[1]) / dA[1]; P1 = A0 + dA * t_
    P2 = np.array([-56.0, ZE]); P3 = np.array([-43.0, -13.2]); P4 = out[i1]
    seg_ = _fillet_path([A0, P1, P2, P3, P4], 10.0)
    out = np.concatenate([out[:i0], seg_, out[i1 + 1:]])
    tg3 = np.gradient(out, axis=0); tg3 /= np.linalg.norm(tg3, axis=1)[:, None] + 1e-9
    _ES = P2
    print("  station exit rerouted south of the tram stop:", i0, i1, len(seg_), "P1", P1.round(1))
seg = np.hypot(*np.diff(out, axis=0).T); arc3 = np.concatenate([[0], np.cumsum(seg)])
_prev = 0
for st_, q in zip(stops, _stop_xy):
    d_ = np.hypot(*(out - q).T); d_[:_prev] = 1e9; k_ = int(np.argmin(d_)); _prev = k_
    st_["arc"] = round(float(arc3[k_]), 1)
arc2 = arc3
# 終点（東山）: 標柱が二つの道の分かれ目にあり、そのままでは道の間へ曲がり込む → 手前 70m から、東へ向かう下の道の
# 左車線へなめらかにつないで止める（前扉の位置＝E）
E_ = np.array([2184.5, 1012.2]); dE = np.array([1.0, 0.04]); dE /= np.linalg.norm(dE)
k0 = int(np.searchsorted(arc2, arc2[-1] - 45.0))
A_ = out[k0]; tA = out[min(len(out) - 1, k0 + 1)] - out[max(0, k0 - 1)]; tA /= np.linalg.norm(tA) + 1e-9
Lc = float(np.linalg.norm(E_ - A_)); n_ = max(8, int(Lc))
uu = np.linspace(0, 1, n_ + 1)[1:, None]
h00 = 2 * uu**3 - 3 * uu**2 + 1; h10 = uu**3 - 2 * uu**2 + uu; h01 = -2 * uu**3 + 3 * uu**2; h11 = uu**3 - uu**2
curve = h00 * A_ + h10 * tA * Lc * 0.6 + h01 * E_ + h11 * dE * Lc * 0.6
out = np.concatenate([out[:k0 + 1], curve])
seg = np.hypot(*np.diff(out, axis=0).T); arc2 = np.concatenate([[0], np.cumsum(seg)])
stops[-1]["arc"] = round(float(arc2[-1]), 1)
leftE = np.array([dE[1], -dE[0]]); pe = E_ + leftE * 2.3
stops[-1]["pole"] = [round(float(pe[0]), 2), round(float(pe[1]), 2)]
y = np.array([h_at(x, z) for x, z in out])
roads = []
for (u, v) in [e for L_ in legs[1:] for e in L_]:
    pass
# 経路上の信号（traffic.json の停止線を経路へ射影）
sigs = []
tree_path = cKDTree(out)
tg2 = np.gradient(out, axis=0); tg2 /= np.linalg.norm(tg2, axis=1)[:, None] + 1e-9
for ln in TJ["lanes"]:
    sg = ln.get("sig")
    if not sg: continue
    p = np.array(ln["p"])[:, [0, 2]]; sa = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    q = np.array([np.interp(sg["s"], sa, p[:, 0]), np.interp(sg["s"], sa, p[:, 1])])
    k = min(len(p) - 1, int(np.searchsorted(sa, sg["s"]))); d_ = p[k] - p[max(0, k - 1)]; d_ /= np.linalg.norm(d_) + 1e-9
    dd, ii = tree_path.query(q)
    if dd < 3.5 and tg2[ii] @ d_ > 0.8:
        sigs.append(dict(s=round(float(arc2[ii]), 1), g=sg["g"], ph=sg["ph"]))
sigs.sort(key=lambda g: g["s"])
ded = []
for g in sigs:
    if ded and g["s"] - ded[-1]["s"] < 8: continue
    ded.append(g)
if _ES is not None:
    _k = int(np.argmin(np.hypot(out[:, 0] - (_ES[0] - 4.0), out[:, 1] - _ES[1])))
    ded = [g for g in ded if abs(g["s"] - float(arc2[_k])) > 15] + [dict(s=round(float(arc2[_k]), 1), g=145, ph=0)]
    ded.sort(key=lambda g: g["s"])
print("signals on route", len(ded))
J = dict(name="両備バス 西大寺線（岡山駅 → 天満屋 → 東山）", short="西大寺線", dest="西大寺バスセンター", via="天満屋・県庁・東山経由",
         path=[[round(float(x), 2), round(float(h), 2), round(float(z), 2)] for (x, z), h in zip(out, y)],
         stops=stops, signals=ded, snapped=float(snapped.mean()),
         bays=dict(tenmaya=[dict(ref=n["tags"].get("local_ref"), x=round(n["x"], 2), z=round(n["z"], 2)) for n in bs_nodes if n["tags"].get("name") == "天満屋" and n["tags"].get("local_ref")],
                   station=[dict(ref=n["tags"].get("local_ref"), x=round(n["x"], 2), z=round(n["z"], 2)) for n in bs_nodes if n["tags"].get("name") == "岡山駅東口" and n["tags"].get("local_ref")]))
json.dump(J, open(f"{OUT}/bus.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("stops", [(s["name"], s["arc"]) for s in stops], "snapped", round(float(snapped.mean()), 2))
# どの道路を通るか（確認用）
names = []
for (u, v) in [e for L_ in legs[1:] for e in L_]:
    for b, L, wi in adj.get(u, []):
        if b == v:
            nm = rw[wi]["tags"].get("name") or rw[wi]["tags"].get("highway");
            if not names or names[-1] != nm: names.append(nm)
            break
print(" → ".join(names))
