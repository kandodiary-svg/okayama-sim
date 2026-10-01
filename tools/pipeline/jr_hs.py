"""v36: 山陽新幹線の全線（OSM: wx/hs/osm_hs.json、岡山県の東西をふくむ）。上り・下りの 2 本を分けて取り出す。
駅などの分岐でつながっていても、最短の道（1 本目）→ その道を除いた最短の道（2 本目）で分ける。"""
import json, heapq, collections, numpy as np
from common import proj
HS_JSON = "/home/claude/wx/hs/osm_hs2.json"
def load_ways():
    d = json.load(open(HS_JSON)); ways = []
    for e in d["elements"]:
        if e["type"] != "way" or "geometry" not in e: continue
        t = e.get("tags", {})
        nm_ = t.get("name") or ""
        if t.get("railway") != "rail" or t.get("service") in ("yard", "siding", "crossover", "spur"): continue
        if not (nm_.startswith("山陽新幹線") or (not nm_ and t.get("usage") == "main")): continue      # 名前の無い本線（usage=main）もある
        xy = np.array([proj(g["lat"], g["lon"]) for g in e["geometry"]])
        if len(e.get("nodes", [])) != len(xy): continue
        ways.append(dict(id=e["id"], tags=t, xy=xy, nodes=e["nodes"]))
    return ways
def _path(W, banned, src, dst):
    adj = collections.defaultdict(list)
    for wi, w in enumerate(W):
        if wi in banned: continue
        L = float(np.hypot(*np.diff(w["xy"], axis=0).T).sum()); a, b = w["nodes"][0], w["nodes"][-1]
        adj[a].append((b, wi, L)); adj[b].append((a, wi, L))
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        dd, u = heapq.heappop(pq)
        if dd > dist.get(u, 1e18): continue
        if u == dst: break
        for v, wi, L in adj[u]:
            nd = dd + L
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = (u, wi); heapq.heappush(pq, (nd, v))
    if dst not in prev: return None
    seq = []; u = dst
    while u != src: p, wi = prev[u]; seq.append((wi, p, u)); u = p
    return seq[::-1]
def _assemble(W, seq):
    pts = []; tags = []
    for wi, frm, to in seq:
        w = W[wi]; xy = np.asarray(w["xy"], float)
        if w["nodes"][0] != frm: xy = xy[::-1]
        seg = xy if not pts else xy[1:]
        pts += list(seg); tags += [w["tags"]] * len(seg)
    return np.array(pts), tags
def _snap(W, r=3.0):
    """OSM で別々の節点になっている（座標がほぼ同じ）端点を同じ節点にまとめる"""
    from scipy.spatial import cKDTree
    ids = []; pts = []
    for wi, w in enumerate(W):
        ids += [(wi, 0), (wi, -1)]; pts += [w["xy"][0], w["xy"][-1]]
    pts = np.array(pts); par = list(range(len(pts)))
    def f(a):
        while par[a] != a: par[a] = par[par[a]]; a = par[a]
        return a
    for a, b in cKDTree(pts).query_pairs(r):
        par[f(a)] = f(b)
    for k, (wi, e) in enumerate(ids):
        W[wi]["nodes"] = list(W[wi]["nodes"]); W[wi]["nodes"][e] = ("n", f(k))
def _reach(W, banned, src):
    adj = collections.defaultdict(list)
    for wi, w in enumerate(W):
        if wi in banned: continue
        L = float(np.hypot(*np.diff(w["xy"], axis=0).T).sum()); a, b = w["nodes"][0], w["nodes"][-1]
        adj[a].append((b, wi, L)); adj[b].append((a, wi, L))
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        dd, u = heapq.heappop(pq)
        if dd > dist.get(u, 1e18): continue
        for v, wi, L in adj[u]:
            nd = dd + L
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = (u, wi); heapq.heappush(pq, (nd, v))
    return dist, prev
def chains_hs(x_max=51800.0):
    """西の端の 2 つの端点から、それぞれ東へ最短でつながる道（1 本目 → それを除いた 2 本目）。東は x_max（相生駅の手前）で切る"""
    W = load_ways(); pos = {}; deg = collections.Counter()
    for w in W:
        for n_, p in ((w["nodes"][0], w["xy"][0]), (w["nodes"][-1], w["xy"][-1])): deg[n_] += 1; pos[n_] = p
    west = sorted([n_ for n_, k in deg.items() if k == 1 and pos[n_][0] < -40000], key=lambda n_: pos[n_][0])
    out = []; banned = set()
    for src in west[:2]:
        dist, prev = _reach(W, banned, src)
        tgt = max((n_ for n_ in dist if pos[n_][0] <= x_max), key=lambda n_: pos[n_][0])
        seq = []; u = tgt
        while u != src: p_, wi = prev[u]; seq.append((wi, p_, u)); u = p_
        seq.reverse(); banned |= {wi for wi, _, _ in seq}
        P, tags = _assemble(W, seq); L = float(np.hypot(*np.diff(P, axis=0).T).sum()); out.append((P, tags, L))
    return out
if __name__ == "__main__":
    for P, tags, L in chains_hs():
        print(len(P), "L", round(L), "x", P[:, 0].min().round(), P[:, 0].max().round(), "z", P[:, 1].min().round(), P[:, 1].max().round(), P[0].round(), P[-1].round())
