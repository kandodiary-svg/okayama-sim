"""v37: 山陽道のデータを書き出す。入力 wx/exp/mw_prof.pkl（mw_prof.py）・osm_mwx.json。出力 data/mw.json・data/mw.bin
mw.bin: 全 chain の点 Float32 (x, y, z) × n、続けて gap Uint8（上下線の間隔 0.5m 単位, 0=なし）× n"""
import os, sys, json, pickle, collections
import numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import proj, in_data
EXP = "/home/claude/wx/exp"; OUT = "/home/claude/okaden-x/data"
def runs(b):
    d = np.diff(np.concatenate([[0], b.astype(np.int8), [0]])); s = np.flatnonzero(d == 1); e = np.flatnonzero(d == -1)
    return [[int(a), int(c)] for a, c in zip(s, e)]
def main():
    C = pickle.load(open(f"{EXP}/mw_prof.pkl", "rb"))
    X = json.load(open(f"{EXP}/osm_mwx.json"))["elements"]
    pts = []; gaps = []; meta = []; o = 0
    nodeidx = collections.defaultdict(list)
    for k, c in enumerate(C):
        for nid, s in c["nodepos"].items():
            step = c["s"][-1] / (len(c["Q"]) - 1); nodeidx[nid].append((k, min(int(round(s / step)), len(c["Q"]) - 1)))
    for k, c in enumerate(C):
        n = len(c["Q"]); P = np.stack([c["Q"][:, 0], c["h"], c["Q"][:, 1]], axis=1).astype(np.float32)
        pts.append(P); gaps.append(np.minimum(255, np.round(c["gap"] * 2)).astype(np.uint8))
        skip = in_data(c["Q"][:, 0], c["Q"][:, 1], 0.0)
        # 続き（終端ノードが他の chain にもある）
        nx = []
        for nid in [c["nodes"][1]]:
            for (k2, j2) in nodeidx.get(nid, []):
                if k2 != k: nx.append([k2, j2])
        lanes = int(np.bincount(np.clip(c["lanes"], 1, 6)).argmax()); ms = c["ms"][c["ms"] > 0]; ms = int(np.bincount(ms).argmax()) if len(ms) else 0
        meta.append(dict(id=k, kind=c["kind"], name=c["name"], ref=c["ref"], lanes=lanes, ms=ms, n=n, o=o, L=round(c["L"], 1), br=runs(c["br"]), tn=runs(c["tn"]), skip=runs(skip), nx=nx,
                         ln=[int(v) for v in c["lanes"][::20]]))
        o += n
    P = np.concatenate(pts); G = np.concatenate(gaps)
    open(f"{OUT}/mw.bin", "wb").write(P.tobytes() + G.tobytes())
    # IC・JCT・PA/SA・料金所
    allQ = np.concatenate([c["Q"] for c in C]); own = np.concatenate([[k] * len(c["Q"]) for k, c in enumerate(C)]); loc = np.concatenate([np.arange(len(c["Q"])) for c in C])
    tr = cKDTree(allQ)
    ic = []; toll = []; sa = []
    for e in X:
        t = e.get("tags", {})
        if e["type"] == "node":
            x, z = proj(e["lat"], e["lon"])
            if not (-52500 < x < 52000): continue
            d, i = tr.query([x, z])
            if t.get("highway") == "motorway_junction" and d < 200: ic.append(dict(name=t.get("name", ""), ref=t.get("ref", ""), x=round(x, 1), z=round(z, 1), c=int(own[i]), i=int(loc[i])))
            elif t.get("barrier") == "toll_booth" and d < 300: toll.append(dict(name=t.get("name", ""), x=round(x, 1), z=round(z, 1), c=int(own[i]), i=int(loc[i])))
        elif e["type"] == "way" and t.get("highway") in ("services", "rest_area"):
            xy = np.array([proj(g["lat"], g["lon"]) for g in e["geometry"]])
            if not (-52500 < xy[:, 0].mean() < 52000): continue
            d, i = tr.query(xy.mean(0))
            if d < 800: sa.append(dict(name=t.get("name", ""), poly=[[round(float(a), 1), round(float(b), 1)] for a, b in xy], c=int(own[i]), i=int(loc[i])))
    man = dict(note="山陽自動車道の線形・IC・料金所・SA/PA: OpenStreetMap (ODbL)。道路面の高さ: 国土地理院の標高から推定した縦断（勾配 3.2% 以下・橋とトンネルは OSM の区分）。車線数・幅は OSM と標準断面からの推定。",
               ds=5.0, chains=meta, ic=ic, toll=toll, sa=sa, total=int(len(P)))
    json.dump(man, open(f"{OUT}/mw.json", "w"), ensure_ascii=False, separators=(",", ":"))
    print("points", len(P), "bin MB", (len(P) * 13) / 1e6, "json KB", os.path.getsize(f"{OUT}/mw.json") / 1e3, "ic", len(ic), "toll", len(toll), "sa", len(sa))
if __name__ == "__main__": main()
