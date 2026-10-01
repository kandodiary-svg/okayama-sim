"""v37: 山陽自動車道（県内）の線形と縦断。
入力: wx/exp/osm_mw.json（OSM の highway=motorway|motorway_link, overpass.openstreetmap.fr）, osm_mwx.json（IC・料金所・SA/PA）
標高: 国土地理院 dem_png z14（demz.py）
処理:
  1. 山陽道の本線（ref E2・名前が山陽自動車道）と、つながるランプ（motorway_link）・他路線の最初の 3km（ジャンクションの先）を選ぶ。
  2. 同じ向きにつながる way は 1 本の線（chain）にする。5m 間隔に打つ。
  3. 縦断（道路面の高さ）: 地形に沿いつつなめらか（3 次のスムージングスプライン）。橋・トンネルは地形に引かれない。
     勾配 3.5%（ランプ・短い所は 6%）を超える所は平滑を強めて解き直す。上下線は近い所で高さをそろえる。
  4. 上下線の間隔（中央帯）を求める。
出力: wx/exp/mw_prof.pkl（outer_tiles.py・mw_out.py が使う）
"""
import os, sys, json, math, pickle, collections
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import proj
import demz

EXP = "/home/claude/wx/exp"
BOX = (-52500.0, 52000.0)                 # 県内（福山西〜上郡）の x の範囲
DS = 5.0
STUB = 3000.0                             # 他路線は、つながる所から 3km まで

def load():
    d = json.load(open(f"{EXP}/osm_mw.json"))
    ways = {}
    for e in d["elements"]:
        if e["type"] != "way": continue
        xy = np.array([proj(g["lat"], g["lon"]) for g in e["geometry"]])
        e["xy"] = xy; ways[e["id"]] = e
    return ways

def is_main(e):
    t = e["tags"]
    return t["highway"] == "motorway" and (t.get("ref") in ("E2", "E2;AH1") or t.get("name", "").startswith("山陽自動車道"))

def select(ways):
    inbox = {i: e for i, e in ways.items() if BOX[0] < e["xy"][:, 0].mean() < BOX[1]}
    main = {i for i, e in inbox.items() if is_main(e)}
    node_ways = collections.defaultdict(set)
    for i, e in inbox.items():
        for n in e["nodes"]: node_ways[n].add(i)
    sel = set(main); frontier = set(main)
    # ランプ（motorway_link）は、つながる限り全部
    while frontier:
        nodes = {n for i in frontier for n in inbox[i]["nodes"]}
        new = set()
        for n in nodes:
            for j in node_ways[n]:
                if j not in sel and inbox[j]["tags"]["highway"] == "motorway_link": new.add(j)
        sel |= new; frontier = new
    # 他路線の本線は、選んだ way のノードにつながる所から 3km（STUB）
    stubs = {}
    selnodes = {n for i in sel for n in inbox[i]["nodes"]}
    for n in selnodes:
        for j in node_ways[n]:
            if j in sel or inbox[j]["tags"]["highway"] != "motorway": continue
            e = inbox[j]; k = e["nodes"].index(n); xy = e["xy"]
            # k から前後へ STUB まで
            for dirn in (1, -1):
                idx = [k]; L = 0.0; q = k
                while 0 <= q + dirn < len(xy) and L < STUB:
                    L += float(np.hypot(*(xy[q + dirn] - xy[q]))); q += dirn; idx.append(q)
                if len(idx) < 2: continue
                key = (j, min(idx), max(idx))
                stubs[key] = dict(e=e, idx=sorted(idx))
    return inbox, sel, stubs

def mk_pieces(inbox, sel, stubs):
    """way（と stub の切れ端）を [{nodes, xy, tags, stub}] に。stub は oneway の向き（way の向き）に沿う"""
    P = []
    for i in sorted(sel):
        e = inbox[i]; P.append(dict(id=i, nodes=list(e["nodes"]), xy=e["xy"], tags=e["tags"], stub=False))
    # stub: 同じ way の重なり（両方向）をまとめる
    byway = collections.defaultdict(list)
    for (j, a, b), s in stubs.items(): byway[j].append((a, b))
    for j, rng in byway.items():
        e = inbox[j]; rng.sort(); merged = []
        for a, b in rng:
            if merged and a <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], b)
            else: merged.append([a, b])
        for a, b in merged:
            if b - a < 1: continue
            P.append(dict(id=j * 1000 + a % 1000, nodes=e["nodes"][a:b + 1], xy=e["xy"][a:b + 1], tags=e["tags"], stub=True))
    return P

def _tang(p, atend):
    xy = p["xy"]
    if atend:
        a = xy[-1]; k = len(xy) - 2
        while k > 0 and np.hypot(*(xy[k] - a)) < 8: k -= 1
        v = a - xy[k]
    else:
        a = xy[0]; k = 1
        while k < len(xy) - 1 and np.hypot(*(xy[k] - a)) < 8: k += 1
        v = xy[k] - a
    return v / (np.hypot(*v) + 1e-9)

def merge_chains(P):
    """端のノードでつながる piece を結合する。ノードに他の piece（ランプ）が付いていても、
    進行方向がなめらかにつながる（cos>0.9）同じ種類の組は本線として結合（最良の組から順に）"""
    start = collections.defaultdict(list); end = collections.defaultdict(list)
    for k, p in enumerate(P):
        start[p["nodes"][0]].append(k); end[p["nodes"][-1]].append(k)
    nxt = {}; prv = {}
    for n in start:
        ins = end.get(n, []); outs = start[n]
        if not ins: continue
        cand = []
        for a in ins:
            for b in outs:
                if a == b: continue
                if P[a]["tags"]["highway"] != P[b]["tags"]["highway"] or P[a]["stub"] != P[b]["stub"]: continue
                c = float(_tang(P[a], True) @ _tang(P[b], False))
                if c > 0.9: cand.append((c, a, b))
        cand.sort(reverse=True)
        for c, a, b in cand:
            if a in nxt or b in prv: continue
            nxt[a] = b; prv[b] = a
    chains = []; seen = set()
    def walk(k):
        seq = [k]; seen.add(k)
        while seq[-1] in nxt and nxt[seq[-1]] not in seen: seq.append(nxt[seq[-1]]); seen.add(seq[-1])
        return seq
    for k in range(len(P)):
        if k in prv or k in seen: continue
        chains.append(walk(k))
    for k in range(len(P)):
        if k not in seen: chains.append(walk(k))
    return chains

def _ms(t):
    try: return int(str(t.get("maxspeed", "")).split()[0])
    except Exception: return 0

def resample_chain(P, seq):
    """chain の piece を連結して 5m 間隔に。戻り: xy (n,2), 各点の piece 由来の tags（bridge・tunnel・lanes・maxspeed）, ノード位置"""
    pts = []; tg = []; nodeat = []
    for q, k in enumerate(seq):
        p = P[k]; xy = p["xy"]
        for m in range(len(xy)):
            if q > 0 and m == 0: continue
            pts.append(xy[m]); nodeat.append(p["nodes"][m])
        # 区間ごとの tags は way 内の各セグメントに（最後の点の次が無いので、各点に「次のセグメントの tags」）
        for m in range(1 if q > 0 else 0, len(xy)): tg.append(p["tags"])
    pts = np.array(pts); seg = np.hypot(*np.diff(pts, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]; n = max(2, int(math.ceil(L / DS)) + 1); ss = np.linspace(0, L, n)
    idx = np.clip(np.searchsorted(cum, ss, side="right") - 1, 0, len(pts) - 2)
    t = (ss - cum[idx]) / np.maximum(seg[idx], 1e-9)
    Q = pts[idx] + (pts[idx + 1] - pts[idx]) * t[:, None]
    # セグメント idx の tags: tg は点ごと（先頭点は最初の piece の tags）→ セグメント idx は tg[idx+1]
    br = np.array([tg[j + 1].get("bridge") in ("yes", "viaduct") for j in idx], bool)
    tn = np.array([tg[j + 1].get("tunnel") not in (None, "no") for j in idx], bool)
    lanes = np.array([int(str(tg[j + 1].get("lanes", "2")).split(";")[0]) if str(tg[j + 1].get("lanes", "2"))[:1].isdigit() else 2 for j in idx], np.int8)
    ms = np.array([_ms(tg[j + 1]) for j in idx], np.int16)
    # ノード → 位置（弧長）
    nodepos = {}
    for j, nid in enumerate(nodeat): nodepos.setdefault(nid, cum[j])
    return Q, ss, br, tn, lanes, ms, nodepos

def sample_dem(Q):
    need = demz.need_tiles(Q[:, 0], Q[:, 1])
    ext = set()
    for a, b in need:
        for da in (-1, 0, 1):
            for db in (-1, 0, 1): ext.add((a + da, b + db))
    demz.ensure(ext)
    T = demz.sample(Q[:, 0], Q[:, 1])
    return T

def dilate(b, k):
    if not b.any(): return b
    from scipy.ndimage import binary_dilation
    return binary_dilation(b, iterations=k)

def build():
    ways = load(); inbox, sel, stubs = select(ways)
    P = mk_pieces(inbox, sel, stubs); chains = merge_chains(P)
    print("pieces", len(P), "chains", len(chains), flush=True)
    C = []
    for ci, seq in enumerate(chains):
        Q, ss, br, tn, lanes, ms, nodepos = resample_chain(P, seq)
        p0 = P[seq[0]]; main = all(is_main_ for is_main_ in [is_main(inbox[P[k]["id"]]) if not P[k]["stub"] and P[k]["id"] in inbox else False for k in seq])
        t0 = p0["tags"]
        C.append(dict(ci=ci, Q=Q, s=ss, br=br, tn=tn, lanes=lanes, ms=ms, nodepos=nodepos, nodes=(p0["nodes"][0], P[seq[-1]]["nodes"][-1]),
                      kind="main" if main else ("stub" if P[seq[0]]["stub"] else "link"), name=t0.get("name", ""), ref=t0.get("ref", ""), L=float(ss[-1]),
                      way_ids=[P[k]["id"] for k in seq], dest=[P[k]["tags"].get("destination", "") for k in seq][:1]))
    print("chains kinds", collections.Counter(c["kind"] for c in C), "total km", sum(c["L"] for c in C) / 1000, flush=True)
    # 標高
    allQ = np.concatenate([c["Q"] for c in C]); T_all = sample_dem(allQ)
    o = 0
    for c in C:
        n = len(c["Q"]); c["T"] = T_all[o:o + n]; o += n
        bad = np.isnan(c["T"])
        if bad.all(): c["T"] = np.zeros(n)
        elif bad.any(): c["T"][bad] = np.interp(np.flatnonzero(bad), np.flatnonzero(~bad), c["T"][~bad])
        # 横方向の平滑（5m 間隔で 21 点 ≒ 100m の移動平均で、DEM の細かい凸凹を除く）
        k = 5; pad = np.pad(c["T"], k, mode="edge"); c["Ts"] = np.convolve(pad, np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
    return C

if __name__ == "__main__":
    C = build()
    pickle.dump(C, open(f"{EXP}/mw_chains.pkl", "wb"))
