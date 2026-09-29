"""v22: 歩行者・自転車の通り道（build_v5 の後に実行 → data/peds.json）
OSM の歩道（footway=sidewalk）・横断歩道（footway=crossing）・歩道/遊歩道（footway, path）・歩行者道/商店街（pedestrian）・
階段（steps）・自転車道（cycleway）と、歩道の無い細い道（residential / unclassified / living_street。道の端を歩く）をつないだ網。
・交差点（3 本以上がつながる節点）と行き止まりで区切った折れ線を「辺」にする
・建物の中（1m の建物マスク）・橋や地下・2 階以上（layer / level / indoor）を通る道は除く（高さが合わないため）。
  ただし車道・歩道の上にある橋（京橋などの歩道）は、路面の高さがあるので残す
・横断歩道: 節点の crossing=traffic_signals、または近く（35m 以内）の信号交差点 → その交差点の現示に合わせて渡る
  （横断の向きが交差点の主道路と平行なら ph0、直交なら ph1）。信号の無い横断歩道は車・電車が近くにいない時に渡る
・人の多さ（辺ごとの重み）: 商店街・歩行者道 > 駅前・表町の周り > 一般の歩道 > 遊歩道 > 細い道
"""
import json, base64, zlib, math
import numpy as np
from osm_load import load as osm_load
from common import BX0, BZ0, BX1, BZ1

OUT = "/home/claude/okaden-x/data"
sc = json.load(open(f"{OUT}/scene.json", encoding="utf-8"))
m = sc["drive"]
import geo_io; raw = geo_io.read_legacy("drive")
n = m["nx"] * m["nz"]
KIND = np.frombuffer(raw[n * 2:n * 3], np.uint8).reshape(m["nz"], m["nx"])
BM = np.unpackbits(np.frombuffer(raw[n * 3:n * 3 + m["brow"] * m["bnz"]], np.uint8).reshape(m["bnz"], m["brow"]), axis=1)[:, :m["bnx"]]
X0, Z0 = m["x0"], m["z0"]
def kind(x, z):
    i, j = int((x - X0) // m["step"]), int((z - Z0) // m["step"])
    return int(KIND[j, i]) if 0 <= i < m["nx"] and 0 <= j < m["nz"] else 9
def bld(x, z):
    i, j = int((x - X0) // m["bstep"]), int((z - Z0) // m["bstep"])
    return bool(BM[j, i]) if 0 <= i < m["bnx"] and 0 <= j < m["bnz"] else True
ISECT = sc["isects"]
IXY = np.array([[I["x"], I["z"]] for I in ISECT])

ways, nodes = osm_load()
ntag = {nd["id"]: nd["tags"] for nd in nodes}
# 種類: 0 歩道 1 横断歩道 2 歩行者道・商店街 3 遊歩道(path) 4 階段 5 細い道（車と共用） 6 自転車道
def kind_of(t):
    h = t.get("highway")
    if h == "footway":
        f = t.get("footway")
        if f == "crossing": return 1
        return 0
    if h == "pedestrian": return 2
    if h == "path": return 2 if t.get("covered") == "arcade" else 3
    if h == "steps": return 4
    if h == "cycleway": return 6
    if h in ("residential", "unclassified", "living_street"): return 5
    return None
BASE_W = {0: 1.0, 1: 0.6, 2: 3.0, 3: 0.35, 4: 0.3, 5: 0.22, 6: 0.5}
def usable(t, xy):
    if t.get("indoor") == "yes" or t.get("area") == "yes" or t.get("access") in ("private", "no"): return False
    try:
        if float(str(t.get("layer", "0")).split(";")[0]) != 0 and t.get("bridge") != "yes": return False
    except ValueError: pass
    if str(t.get("level", "0")).split(";")[0] not in ("0", ""): return False
    if t.get("tunnel") in ("yes", "building_passage") and kind_of(t) != 2: return False
    # 範囲（地面のデータがある所）
    if (xy[:, 0] < BX0 + 10).any() or (xy[:, 0] > BX1 - 10).any() or (xy[:, 1] < BZ0 + 10).any() or (xy[:, 1] > BZ1 - 10).any(): return False
    return True
cand = []
for w in ways:
    t = w["tags"]; k = kind_of(t)
    if k is None or len(w["xy"]) < 2 or len(w["nodes"]) != len(w["xy"]): continue
    xy = np.asarray(w["xy"], float)
    if not usable(t, xy): continue
    cand.append((w, k))
# 節点の次数
deg = {}
for w, k in cand:
    ns = w["nodes"]
    for i, nid in enumerate(ns): deg[nid] = deg.get(nid, 0) + (i > 0) + (i < len(ns) - 1)
pos = {}
for w, k in cand:
    for nid, p in zip(w["nodes"], w["xy"]): pos[nid] = np.asarray(p, float)

def dense(P, step=1.0):
    out = [P[0]]
    for a, b in zip(P[:-1], P[1:]):
        L = float(np.hypot(*(b - a))); s = max(1, int(math.ceil(L / step)))
        for q in range(1, s + 1): out.append(a + (b - a) * q / s)
    return np.array(out)
def seg_ok(P, k, t):
    Q = dense(P, 1.0)
    bad = sum(bld(x, z) for x, z in Q)
    if bad > max(1, 0.08 * len(Q)): return False
    if t.get("bridge") == "yes" and any(kind(x, z) not in (1, 2) for x, z in Q[::2]): return False
    return True

# 辺 = 交差点（次数≠2）で区切った折れ線
edges = []   # (a, b, poly, k, tags)
for w, k in cand:
    ns, xy = w["nodes"], np.asarray(w["xy"], float)
    cut = [0] + [i for i in range(1, len(ns) - 1) if deg.get(ns[i], 0) != 2] + [len(ns) - 1]
    for i0, i1 in zip(cut[:-1], cut[1:]):
        P = xy[i0:i1 + 1]
        if np.hypot(*(P[-1] - P[0])) < 0.3 and len(P) < 3: continue
        if not seg_ok(P, k, w["tags"]): continue
        edges.append((ns[i0], ns[i1], P, k, w["tags"], ns[i0:i1 + 1]))
# 節点番号
nid2i = {}; NODES = []
def nidx(nid):
    if nid not in nid2i: nid2i[nid] = len(NODES); NODES.append(pos[nid])
    return nid2i[nid]
# 盛り場（人が多い所）: 岡山駅東口・表町・駅前町・西川
HOT = [(-40.0, 0.0, 380.0, 2.2), (760.0, 420.0, 380.0, 2.0), (330.0, 60.0, 260.0, 1.5), (560.0, 250.0, 300.0, 1.3), (-330.0, 40.0, 250.0, 1.4)]
def hot(x, z):
    f = 1.0
    for hx, hz, r, a in HOT:
        d = math.hypot(x - hx, z - hz)
        if d < r: f = max(f, 1.0 + (a - 1.0) * (1.0 - d / r))
    return f
E = []
nsig = nun = 0
for a, b, P, k, t, ns in edges:
    L = float(np.sum(np.hypot(*np.diff(P, axis=0).T)))
    if L < 0.5: continue
    c = P.mean(0)
    wgt = BASE_W[k] * hot(*c)
    nm = t.get("name", "")
    if "商店街" in nm or t.get("covered") in ("arcade", "yes"): wgt = max(wgt, 4.0) * 1.3
    # 横幅（人が左右にばらける幅、細い道は道の端を歩く位置）
    if k == 5:
        try: rw = float(t.get("width", "0"))
        except ValueError: rw = 0.0
        rw = rw or (4.0 if t.get("highway") != "unclassified" else 5.0)
        lat = max(0.6, rw / 2 - 0.7)
    elif k == 2:
        try: rw = float(t.get("width", "0"))
        except ValueError: rw = 0.0
        lat = max(1.2, (rw or 7.0) / 2 - 1.0)
    elif k == 1: lat = 1.1
    else: lat = 0.6
    g = -1; ph = 0; sig = 0
    if k == 1:
        tags_ = [ntag.get(q, {}) for q in ns]
        tl = any(tg.get("crossing") == "traffic_signals" or tg.get("highway") == "traffic_signals" for tg in tags_) or t.get("crossing") == "traffic_signals"
        d = np.hypot(*(IXY - c).T); j = int(np.argmin(d))
        if tl or (d[j] < 22 and t.get("crossing") not in ("uncontrolled", "zebra", "unmarked")):
            if d[j] < 40:
                v = P[-1] - P[0]; v /= (np.linalg.norm(v) + 1e-9)
                mn = np.array(ISECT[j]["main"], float); mn /= (np.linalg.norm(mn) + 1e-9)
                g = j; ph = 0 if abs(float(v @ mn)) > 0.707 else 1; sig = 1; nsig += 1
        if not sig: nun += 1
    bike = 0 if k in (4,) else 1
    E.append([nidx(a), nidx(b), k, round(wgt, 2), round(lat, 2), g, ph, bike,
              [round(float(v), 1) for v in P.reshape(-1)]])
# 孤立した小さな網は除く（連結成分が 60m 未満）
import collections
adj = collections.defaultdict(list)
for ei, e in enumerate(E): adj[e[0]].append(ei); adj[e[1]].append(ei)
comp = [-1] * len(NODES); sizes = []
for s in range(len(NODES)):
    if comp[s] >= 0 or not adj[s]: continue
    cid = len(sizes); st = [s]; comp[s] = cid; tot = 0.0; es = set()
    while st:
        u = st.pop()
        for ei in adj[u]:
            if ei in es: continue
            es.add(ei); e = E[ei]; P = np.array(e[8]).reshape(-1, 2); tot += float(np.sum(np.hypot(*np.diff(P, axis=0).T)))
            for v in (e[0], e[1]):
                if comp[v] < 0: comp[v] = cid; st.append(v)
    sizes.append(tot)
keep = [e for e in E if sizes[comp[e[0]]] >= 60.0]
# 節点を詰め直す
used = sorted({e[0] for e in keep} | {e[1] for e in keep}); remap = {o: i for i, o in enumerate(used)}
for e in keep: e[0] = remap[e[0]]; e[1] = remap[e[1]]
J = dict(note="歩行者・自転車の通り道: OpenStreetMap (ODbL) の歩道・横断歩道・歩行者道・細い道。人の多さ・歩く速さ・信号の待ち方は一般的な値による仮定",
         nodes=[[round(float(NODES[o][0]), 1), round(float(NODES[o][1]), 1)] for o in used],
         edges=keep)
s = json.dumps(J, ensure_ascii=False, separators=(",", ":"))
open(f"{OUT}/peds.json", "w").write(s)
cnt = collections.Counter(e[2] for e in keep)
print("peds: edges", len(keep), "nodes", len(used), "by kind", dict(cnt), "signal crossings", nsig, "unsignalized", nun, "size %.2f MB" % (len(s) / 1e6))
