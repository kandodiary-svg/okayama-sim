"""OSM(Overpass JSON) をローカル座標で読むための共通関数"""
import json, numpy as np
from common import proj
def load():
    d = json.load(open("/home/claude/wx/osm/osm.json"))
    ways, nodes = [], []
    for e in d["elements"]:
        if e["type"] == "way" and "geometry" in e:
            xy = np.array([proj(g["lat"], g["lon"]) for g in e["geometry"]])
            ways.append(dict(id=e["id"], tags=e.get("tags", {}), xy=xy, nodes=e.get("nodes", [])))
        elif e["type"] == "node":
            x, z = proj(e["lat"], e["lon"])
            nodes.append(dict(id=e["id"], tags=e.get("tags", {}), x=x, z=z))
    _synthetic(ways)
    return ways, nodes

def _insert_node(w, nid, p):
    """way w の最も近い区間に点 p を射影して節点 nid を差し込む。差し込んだ座標を返す"""
    xy = np.asarray(w["xy"], float); best = None
    for k in range(len(xy) - 1):
        a, b = xy[k], xy[k + 1]; d = b - a; L2 = float(d @ d)
        if L2 < 1e-9: continue
        t = float(np.clip((p - a) @ d / L2, 0.02, 0.98)); q = a + d * t; e = float(np.linalg.norm(p - q))
        if best is None or e < best[0]: best = (e, k, q)
    _, k, q = best
    w["xy"] = np.concatenate([xy[:k + 1], q[None], xy[k + 1:]]); w["nodes"] = list(w["nodes"][:k + 1]) + [nid] + list(w["nodes"][k + 1:])
    return q

def _synthetic(ways):
    """v13: OSM に無い道。天満屋バスステーション南側の構内通路（西側の道 → 東側の道、東向き一方通行・バス専用）"""
    byid = {w["id"]: w for w in ways}
    W_, E_ = byid.get(182104553), byid.get(182105083)
    if W_ is None or E_ is None: return
    qa = _insert_node(W_, -910001, np.array([780.5, 461.6]))
    qb = _insert_node(E_, -910002, np.array([818.0, 461.6]))
    ways.append(dict(id=-91000, tags={"highway": "service", "bus": "yes", "psv": "yes", "access": "no", "oneway": "yes",
                                      "name": "天満屋バスステーション構内"},
                     xy=np.array([qa, [qa[0] + 4.0, 461.6], [qb[0] - 4.0, 461.6], qb]), nodes=[-910001, -910011, -910012, -910002]))
