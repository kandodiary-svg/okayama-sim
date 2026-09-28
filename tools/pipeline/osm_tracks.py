"""OSM の路面電車線路(上下線別)から走行経路・全線路・電停・ホーム・信号・制限速度を作る。
出力: /home/claude/wx/tracks.pkl
"""
import os, sys, json, math, pickle, heapq
import numpy as np
from shapely.geometry import LineString, Point, Polygon
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load

ways, nodes = osm_load()
R = pickle.load(open("/home/claude/wx/roads_final.pkl", "rb"))
HR = R["HR"]; GX0, GZ0, RES = R["grid"]
dem = np.load("/home/claude/wx/dem_grid.npz")
DX0, DZ0, DSTEP = float(dem["x0"]), float(dem["z0"]), float(dem["step"]); DH = dem["H"]
def dem_at(x, z):
    i = int(np.clip((x - DX0) / DSTEP, 0, DH.shape[1] - 1)); j = int(np.clip((z - DZ0) / DSTEP, 0, DH.shape[0] - 1))
    return float(DH[j, i])

def surf_at(x, z, rad=1.3):
    """線路幅の範囲の車道面の最高点（埋もれ防止）"""
    i0 = int((x - rad - GX0) / RES); i1 = int((x + rad - GX0) / RES) + 1
    j0 = int((z - rad - GZ0) / RES); j1 = int((z + rad - GZ0) / RES) + 1
    sub = HR[max(0, j0):j1, max(0, i0):i1]
    v = sub[np.isfinite(sub)]
    return float(v.max()) if len(v) else None

# ---------------- 線路グラフ ----------------
tram = [w for w in ways if w["tags"].get("railway") == "tram"]
coord = {}
adj = {}
edge_info = {}
for w in tram:
    ns = w["nodes"]; xy = w["xy"]
    for k, nid in enumerate(ns): coord[nid] = xy[k]
    for a, b in zip(ns[:-1], ns[1:]):
        L = float(np.hypot(*(coord[a] - coord[b])))
        adj.setdefault(a, []).append((b, L, w)); adj.setdefault(b, []).append((a, L, w))
print("tram ways", len(tram), "nodes", len(coord))

old = json.load(open("/home/claude/okaden-real/data/routes.json", encoding="utf-8"))
_V7 = pickle.load(open("/home/claude/wx/tracks_v7.pkl", "rb"))
def ref_line(key):
    if key.endswith("_r"):
        # 逆方向: 正方向の走行線(左側の線路)を逆向きにしたものを基準にし、その左側(=対向線)を選ばせる
        return LineString(_V7["routes"][key[:-2]]["xyz"][:, [0, 2]][::-1])
    return LineString(old[key]["track"])

def route(key, start_xy, end_xy):
    ref = ref_line(key)
    def side(p):
        s = ref.project(Point(p)); a = ref.interpolate(max(0, s - 2)); b = ref.interpolate(min(ref.length, s + 2))
        t = np.array([b.x - a.x, b.y - a.y]); t /= np.linalg.norm(t) + 1e-9
        c = ref.interpolate(s); left = np.array([t[1], -t[0]])
        return float(np.dot(np.array(p) - np.array([c.x, c.y]), left)), s
    def pick(xy, want_left=True, rad=30):
        best = None
        for nid, p in coord.items():
            d = np.hypot(*(p - xy))
            if d > rad: continue
            sd, _ = side(p)
            if want_left and sd < 0.3: continue
            if best is None or d < best[0]: best = (d, nid)
        if best is None and want_left:
            return pick(xy, False, rad)   # 単線区間(清輝橋手前など)
        return best[1]
    s_id = pick(np.array(start_xy)); e_id = pick(np.array(end_xy))
    dist = {s_id: 0.0}; prev = {}; pq = [(0.0, s_id)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == e_id: break
        if d > dist.get(u, 1e18): continue
        for v, L, w in adj.get(u, []):
            m = (coord[u] + coord[v]) / 2
            sd, su = side(m); _, sv = side(coord[v]); _, s0 = side(coord[u])
            cost = L
            if sd < (1.2 if key.endswith("_r") else 0.2): cost *= 30          # 進行方向右側の線路(対向線)は避ける
            if sv < s0 - 0.5: cost *= 30     # 逆行しない
            svc = w["tags"].get("service")
            if svc == "crossover": cost += 400
            if svc == "yard": cost += 2000
            nd = d + cost
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = (u, w); heapq.heappush(pq, (nd, v))
    path = [e_id]; wlist = []
    while path[-1] != s_id:
        u, w = prev[path[-1]]; wlist.append(w); path.append(u)
    path.reverse(); wlist.reverse()
    xy = np.array([coord[n] for n in path])
    speeds = [float(w["tags"].get("maxspeed", 40)) for w in wlist]
    return xy, speeds

def densify(xy, speeds, step=1.0):
    out, sp = [xy[0]], [speeds[0]]
    for i, (a, b) in enumerate(zip(xy[:-1], xy[1:])):
        L = np.hypot(*(b - a)); n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1):
            out.append(a + (b - a) * k / n); sp.append(speeds[i])
    return np.array(out), np.array(sp)

def chaikin(xy, it=2):
    for _ in range(it):
        q = 0.75 * xy[:-1] + 0.25 * xy[1:]; r = 0.25 * xy[:-1] + 0.75 * xy[1:]
        xy = np.vstack([xy[:1], np.stack([q, r], 1).reshape(-1, 2), xy[-1:]])
    return xy

def resample(xy, step):
    seg = np.hypot(*(np.diff(xy, axis=0).T)); arc = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, arc[-1], step); t = np.append(t, arc[-1])
    return np.stack([np.interp(t, arc, xy[:, 0]), np.interp(t, arc, xy[:, 1])], 1)

def heights(xy):
    raw = np.array([surf_at(x, z) if surf_at(x, z) is not None else dem_at(x, z) + 0.04 for x, z in xy])
    # 外れ値を除きつつ、局所最高点より下げない
    k = 7
    pad = np.pad(raw, (k, k), mode="edge")
    med = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(len(raw))])
    sm = np.convolve(np.pad(med, (5, 5), mode="edge"), np.ones(11) / 11, mode="valid")
    return np.maximum(sm, raw - 0.03) + 0.015

STARTS = {"higashi": ((-35, -2), (2110, 1024)), "seiki": ((-35, -2), (559, 1522)),
          # 逆方向（終点 → 岡山駅前）: 左側通行なので進行方向左の線路を選ぶ
          "higashi_r": ((2110, 1024), (-35, -2)), "seiki_r": ((559, 1522), (-35, -2))}
routes = {}
for key, (s, e) in STARTS.items():
    xy, sp = route(key, s, e)
    d, spd = densify(xy, sp, 2.0)
    d0 = d.copy()
    d = resample(chaikin(d, 2), 1.0)
    # 制限速度は元の点の最近傍から
    from scipy.spatial import cKDTree
    _, ii = cKDTree(d0).query(d); spd2 = spd[ii]
    y = heights(d)
    seg = np.hypot(*(np.diff(d, axis=0).T)); arc = np.concatenate([[0], np.cumsum(seg)])
    routes[key] = dict(xyz=np.stack([d[:, 0], y, d[:, 1]], 1), arc=arc, speed=spd2)
    print(key, "length", round(arc[-1]), "pts", len(d), "y", y.min().round(2), y.max().round(2),
          "speed segs", sorted(set(spd2.tolist())))

# ---------------- 全線路（描画用、上下線・渡り線・車庫線） ----------------
all_tracks = []
for w in tram:
    d, _ = densify(w["xy"], [0] * (len(w["xy"]) - 1), 2.0)
    if len(d) > 4 and w["tags"].get("service") not in ("crossover",):
        d = chaikin(d, 2)
    d = resample(d, 1.0)
    y = heights(d)
    all_tracks.append(dict(xyz=np.stack([d[:, 0], y, d[:, 1]], 1), service=w["tags"].get("service"),
                           bridge=w["tags"].get("bridge") == "yes"))

# ---------------- 電停 ----------------
FULL = {"岡山駅前": "岡山駅前", "西大寺町": "西大寺町・岡山芸術創造劇場ハレノワ前", "東山": "東山・おかでんミュージアム駅"}
ORDER = {k: [s["name"] for s in old[k]["stops"]] for k in ("higashi", "seiki")}
ORDER.update({k + "_r": ORDER[k][::-1] for k in ("higashi", "seiki")})
stops_osm = [n for n in nodes if n["tags"].get("railway") == "tram_stop"]
for key, r in routes.items():
    line = LineString(r["xyz"][:, [0, 2]])
    res = []
    for full in ORDER[key]:
        short = {v: k for k, v in FULL.items()}.get(full, full)
        cands = [n for n in stops_osm if n["tags"].get("name") == short]
        best = None
        for n in cands:
            dd = line.distance(Point(n["x"], n["z"]))
            if best is None or dd < best[0]: best = (dd, n)
        if best and best[0] < 4:
            s = line.project(Point(best[1]["x"], best[1]["z"]))
        else:
            st = [q for q in old[key.replace("_r", "")]["stops"] if q["name"] == full][0]
            ol = LineString([(p[0], p[-1]) for p in old[key.replace("_r", "")]["track"]])
            s = line.project(ol.interpolate(st["arc"]))
        res.append(dict(name=full, arc=float(s), osm=bool(best and best[0] < 4)))
    res[0]["arc"] = max(res[0]["arc"], 0.0)
    r["stops"] = res
    print(key, [(q["name"][:6], round(q["arc"]), q["osm"]) for q in res])

# ---------------- ホーム(安全地帯) ----------------
platforms = []
for w in ways:
    t = w["tags"]
    if t.get("railway") == "platform" or (t.get("public_transport") == "platform" and t.get("railway")):
        xy = w["xy"]
        if len(xy) < 4 or np.hypot(*(xy[0] - xy[-1])) > 0.5: continue
        P = Polygon(xy)
        if min(LineString(tt["xyz"][:, [0, 2]]).distance(P) for tt in all_tracks) > 6: continue
        c = np.array(P.centroid.coords[0])
        base = surf_at(c[0], c[1], 3) or dem_at(*c)
        platforms.append(dict(xy=xy[:-1], base=base, covered=t.get("covered") == "yes" or t.get("shelter") == "yes",
                              name=t.get("name")))
print("platforms", len(platforms))

# ---------------- 信号（軌道信号・交差点信号） ----------------
sig_nodes = [n for n in nodes if n["tags"].get("railway") == "signal" or n["tags"].get("highway") == "traffic_signals"]
for key, r in routes.items():
    line = LineString(r["xyz"][:, [0, 2]])
    pts = []
    for n in sig_nodes:
        p = Point(n["x"], n["z"]); dd = line.distance(p)
        if n["tags"].get("railway") == "signal" and dd < 2.5:
            pts.append((line.project(p), "tram"))
        elif n["tags"].get("highway") == "traffic_signals" and dd < 18:
            pts.append((line.project(p), "road"))
    pts.sort()
    # 30m 以内は同じ交差点としてまとめ、停止位置は最初の信号の 3m 手前
    grp = []
    for s, kind in pts:
        if grp and s - grp[-1]["s1"] < 30:
            grp[-1]["s1"] = s; grp[-1]["kinds"].add(kind)
        else:
            grp.append(dict(s0=s, s1=s, kinds={kind}))
    r["signals"] = [dict(stop=max(0.0, g["s0"] - 3.0), center=(g["s0"] + g["s1"]) / 2, tram="tram" in g["kinds"]) for g in grp
                    if g["s0"] > 5]
    print(key, "signals", len(r["signals"]), [round(g["stop"]) for g in r["signals"]])

# 正方向は v7 と同一のものを使う（逆方向のみ追加）
for k in ("higashi", "seiki"): routes[k] = _V7["routes"][k]
pickle.dump(dict(routes=routes, tracks=all_tracks, platforms=platforms), open("/home/claude/wx/tracks.pkl", "wb"))
