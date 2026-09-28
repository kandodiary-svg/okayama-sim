"""v19: 信号機の配置（build_v5 の後に実行 → data/signals.json）
交差点（scene.json の isects）ごとに、OSM の道路網で交差点の節点（3 本以上の道がつながる点）に実際につながっている道だけを「腕」とし、
・交差点の中の区間（交差点の節点どうしを結ぶ道）は腕にしない
・一方通行で交差点から出ていくだけの道には灯器を付けない
・腕の向き＝節点から道に沿って 14m 先への向き（曲がった道でも正しい向き）
灯器は日本の標準的な配置（交差点の向こう側・進行方向左の柱から車道の上へ張り出した横型 3 灯）で、進入してくる車の方を向く。
柱の位置（歩道の探し方）と高さは画面側（app.js buildSignals）で 2m 格子の路面区分から決める。"""
import json, math
import numpy as np
from osm_load import load as osm_load

OUT = "/home/claude/okaden-x/data"
sc = json.load(open(f"{OUT}/scene.json", encoding="utf-8"))
ISECT = sc["isects"]
ways, nodes = osm_load()
CLS = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
       "trunk_link", "primary_link", "secondary_link", "tertiary_link")
HW_CLASS = {"trunk": 4, "primary": 4, "secondary": 2, "tertiary": 2, "unclassified": 2, "residential": 2, "living_street": 1, "motorway": 4}
road = [w for w in ways if w["tags"].get("highway") in CLS and len(w["xy"]) >= 2]
def lanes_of(w):
    t = w["tags"]
    try: return max(1, int(str(t.get("lanes", "")).split(";")[0]))
    except Exception: return HW_CLASS.get(t["highway"].replace("_link", ""), 2) if t.get("oneway") != "yes" else 1
def oneway(w):
    t = w["tags"]; o = t.get("oneway")
    if o in ("yes", "true", "1") or t.get("junction") == "roundabout": return 1
    if o == "-1": return -1
    return 0
# 節点 → (way, index)
inc = {}
for wi, w in enumerate(road):
    for k, nid in enumerate(w["nodes"]): inc.setdefault(nid, []).append((wi, k))
nxy = {}
for w in road:
    for nid, p in zip(w["nodes"], w["xy"]): nxy[nid] = np.asarray(p, float)
def degree(nid):
    d = 0
    for wi, k in inc.get(nid, []):
        n = len(road[wi]["nodes"]); d += (k > 0) + (k < n - 1)
    return d
sig_nodes = {n["id"] for n in nodes if n["tags"].get("highway") == "traffic_signals"}
all_nids = np.array(list(nxy.keys())); all_xy = np.array([nxy[k] for k in all_nids])

def walk(w, k, step, dist):
    """way w の節点 k から step(±1) の向きに dist m 進んだ点と、途中で通った節点"""
    xy = w["xy"]; acc = 0.0; i = k; passed = []
    while 0 <= i + step < len(xy):
        a, b = np.asarray(xy[i], float), np.asarray(xy[i + step], float); L = float(np.linalg.norm(b - a))
        passed.append((w["nodes"][i + step], acc + L))
        if acc + L >= dist: return a + (b - a) * ((dist - acc) / max(L, 1e-9)), passed
        acc += L; i += step
    return np.asarray(xy[i], float), passed

out = []; stats = dict(isects=0, arms=0, skipped_out=0, skipped_internal=0)
for g, I in enumerate(ISECT):
    c = np.array([I["x"], I["z"]]); main = np.array(I["main"])
    d = np.hypot(*(all_xy - c).T)
    near = [all_nids[i] for i in np.nonzero(d < 24)[0]]
    J = {n for n in near if degree(n) >= 3}
    if not J: J = {n for n in near if n in sig_nodes} or ({all_nids[int(np.argmin(d))]} if d.min() < 12 else set())
    if not J: continue
    arms = []
    for nid in J:
        for wi, k in inc.get(nid, []):
            w = road[wi]; ow = oneway(w)
            for step in (1, -1):
                if not (0 <= k + step < len(w["nodes"])): continue
                p, passed = walk(w, k, step, 14.0)
                # 交差点の中の区間（別の交差点節点に 14m 以内で着く）
                if any(pn in J for pn, s in passed if s < 14.0 and pn != nid): stats["skipped_internal"] += 1; continue
                v = p - nxy[nid]; L = np.linalg.norm(v)
                if L < 3: continue
                v /= L
                # 中心から離れた節点（11m 超）につながる道は、中心から外へ向かって延びる時だけ腕にする
                # （交差点の少し手前で横から合流する路地などを除く）
                rc = nxy[nid] - c; rcl = np.linalg.norm(rc)
                if rcl > 11 and float(v @ (rc / rcl)) < 0.35: stats["skipped_side"] = stats.get("skipped_side", 0) + 1; continue
                # 進入できるか: 道の向き（節点 k から step 方向へ出る向き）。一方通行で出ていく向きなら進入なし
                inbound_ok = ow == 0 or (ow == 1 and step == -1) or (ow == -1 and step == 1)
                if not inbound_ok: stats["skipped_out"] += 1; continue
                ln = lanes_of(w); n_in = ln if ow else max(1, ln // 2)
                hw = (ln * 3.25 / 2) if ow else (ln * 3.25 / 2)
                arms.append(dict(node=nxy[nid], v=v, hw=hw, n_in=n_in, ow=ow, cls=w["tags"]["highway"], wid=w["id"]))
    if not arms: continue
    # 同じ向き（25° 以内）の進入はまとめる（上下線分離の道・同じ道の重複）
    merged = []
    for a in sorted(arms, key=lambda q: -q["hw"]):
        for m in merged:
            if float(a["v"] @ m["v"]) > math.cos(math.radians(25)) and np.linalg.norm(a["node"] - m["node"]) < 30: break
        else: merged.append(a)
    stats["isects"] += 1
    for a in merged:
        dvec = -a["v"]                                      # 交差点へ向かう進行方向
        left = np.array([dvec[1], -dvec[0]])                # 進行方向の左（x=東, z=南）
        cross = [m["hw"] for m in merged if abs(float(m["v"] @ a["v"])) < 0.7]
        cross_hw = max(cross + [6.0])
        ph = 0 if abs(float(dvec @ main)) > 0.707 else 1
        # 停止線のあたり（交差点の手前・進入車線の左端）と、交差点の向こう側の左端
        # 交差点の広がり: 交差点の節点のうち、進行方向にいちばん先のもの（上下線分離の大きな交差点でも向こう側の縁に置く）
        ext = max(float((nxy[j] - a["node"]) @ dvec) for j in J)
        stop = a["node"] - dvec * (cross_hw + 2.0) + left * a["hw"]
        far = a["node"] + dvec * (max(0.0, ext) + cross_hw + 2.5) + left * a["hw"]
        out.append(dict(g=g, ph=ph, fx=round(float(far[0]), 2), fz=round(float(far[1]), 2), dx=round(float(dvec[0]), 4), dz=round(float(dvec[1]), 4),
                        sx=round(float(stop[0]), 2), sz=round(float(stop[1]), 2), n_in=int(a["n_in"]), hw=round(float(a["hw"]), 2)))
        stats["arms"] += 1
json.dump(out, open(f"{OUT}/signals.json", "w"), separators=(",", ":"))
print("signals", stats, flush=True)
