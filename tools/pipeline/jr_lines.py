"""JR の本線の線形（OSM）: 名前ごとにつながった way を 1 本の折れ線にする（試作・確認用の共通関数）"""
import numpy as np, collections
from osm_load import load as osm_load
GROUPS = {"shinkansen": ("山陽新幹線",), "sanyo": ("山陽本線", "JR山陽本線", "JR山陽線"), "uno": ("JR宇野線", "JR宇野線 島田高架橋"),
          "tsuyama": ("JR津山線",), "kibi": ("JR吉備線",)}
def chains():
    ways, nodes = osm_load()
    out = {}
    for g, names in GROUPS.items():
        W = [w for w in ways if w["tags"].get("railway") == "rail" and w["tags"].get("name") in names
             and w["tags"].get("service") not in ("yard", "siding", "crossover", "spur") and len(w["nodes"]) == len(w["xy"])]
        adj = collections.defaultdict(list)
        for wi, w in enumerate(W):
            a, b = w["nodes"][0], w["nodes"][-1]; L = float(np.hypot(*np.diff(np.asarray(w["xy"]), axis=0).T).sum())
            adj[a].append((b, wi, L)); adj[b].append((a, wi, L))
        seen = set(); res = []
        for s in list(adj):
            if s in seen: continue
            comp = set(); st = [s]
            while st:
                u = st.pop()
                if u in comp: continue
                comp.add(u); st += [v for v, _, _ in adj[u]]
            seen |= comp
            def far(src):
                dist = {src: (0.0, None, None)}; st = [src]
                while st:
                    u = st.pop()
                    for v, wi, L in adj[u]:
                        if v not in dist: dist[v] = (dist[u][0] + L, u, wi); st.append(v)
                t = max(dist, key=lambda k: dist[k][0]); return t, dist
            a, _ = far(s); b, dist = far(a)
            seq = []; u = b
            while dist[u][1] is not None: seq.append((dist[u][2], dist[u][1], u)); u = dist[u][1]
            seq.reverse()
            pts = []; tags = []
            for wi, frm, to in seq:
                w = W[wi]; xy = np.asarray(w["xy"], float)
                if w["nodes"][0] != frm: xy = xy[::-1]
                seg = xy if not pts else xy[1:]
                pts += list(seg); tags += [w["tags"]] * len(seg)
            if len(pts) > 1: res.append((np.array(pts), tags, dist[b][0]))
        res.sort(key=lambda r: -r[2]); out[g] = res
    return out
if __name__ == "__main__":
    for g, res in chains().items():
        print(g, [(round(L), r[0].round().tolist(), r[-1].round().tolist()) for r, t, L in res])
