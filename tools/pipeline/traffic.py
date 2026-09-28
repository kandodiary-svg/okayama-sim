"""自動車の車線網を作る（AI の車・バス用）。
OSM の車道(trunk〜tertiary, unclassified, residential)を交差点で区切り、PLATEAU の車道範囲（0.5m 格子）を
横断方向に走査して、左側通行の車線中心線を求める。路面電車の軌道敷は車線から外す。
交差点では車線どうしを曲線(3次ベジエ)で結び、信号交差点の流入車線には停止線と現示を付ける。
出力: /home/claude/okaden-x/data/traffic.json
"""
import os, sys, json, math, pickle, base64, zlib
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load

OUT = "/home/claude/okaden-x/data"
ways, nodes = osm_load()
R = pickle.load(open("/home/claude/wx/roads_final.pkl", "rb"))
KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]
sc = json.load(open(f"{OUT}/scene.json"))
rt = json.load(open(f"{OUT}/routes.json"))
ISECT = sc["isects"]
# 走行面の高さ（アプリの車モードと同じ格子。駅前広場の嵩上げも含む）
dm = sc["drive"]
import geo_io; raw = geo_io.read("drive")
n_ = dm["nx"] * dm["nz"]
DH = np.frombuffer(raw[:n_ * 2], np.int16).reshape(dm["nz"], dm["nx"]) / 100.0
DK = np.frombuffer(raw[n_ * 2:n_ * 3], np.uint8).reshape(dm["nz"], dm["nx"])
def h_at(x, z):
    fx = (x - dm["x0"]) / dm["step"] - 0.5; fz = (z - dm["z0"]) / dm["step"] - 0.5
    i = int(np.clip(math.floor(fx), 0, dm["nx"] - 2)); j = int(np.clip(math.floor(fz), 0, dm["nz"] - 2))
    tx = min(1, max(0, fx - i)); tz = min(1, max(0, fz - j))
    return float((DH[j, i] * (1 - tx) + DH[j, i + 1] * tx) * (1 - tz) + (DH[j + 1, i] * (1 - tx) + DH[j + 1, i + 1] * tx) * tz)
def road(x, z):
    i = int((x - GX0) / RES); j = int((z - GZ0) / RES)
    if 0 <= i < KIND.shape[1] and 0 <= j < KIND.shape[0]: return KIND[j, i] == 1
    return False

# 軌道（全路線の線路中心）
tp = np.concatenate([np.array(rt[k]["track"])[:, [0, 2]] for k in ("higashi", "seiki", "higashi_r", "seiki_r")])
tr_tree = cKDTree(tp)
TRK = LineString(np.array(rt["higashi"]["track"])[:, [0, 2]]).union(LineString(np.array(rt["seiki"]["track"])[:, [0, 2]]))

HW = {"trunk": 5, "primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 1, "residential": 1}
def cls_of(w): return w["tags"]["highway"].replace("_link", "")
rw = [w for w in ways if "highway" in w["tags"] and cls_of(w) in HW]
rw = [w for w in rw if w["tags"].get("area") != "yes" and w["tags"].get("access") not in ("no", "private")]
# 範囲: 走行格子内かつ軌道から 380m 以内
def inside(p):
    return (dm["x0"] + 5 < p[0] < dm["x0"] + dm["nx"] * dm["step"] - 5) and (dm["z0"] + 5 < p[1] < dm["z0"] + dm["nz"] * dm["step"] - 5)
cnt = {}
for w in rw:
    for nid in w["nodes"]: cnt[nid] = cnt.get(nid, 0) + 1
nxy = {}
for w in rw:
    for nid, p in zip(w["nodes"], w["xy"]): nxy[nid] = np.array(p, float)

# ---- 交差点で区切った辺 ----
edges = []
for w in rw:
    ns = w["nodes"]; cut = [0] + [i for i in range(1, len(ns) - 1) if cnt[ns[i]] >= 2] + [len(ns) - 1]
    for a, b in zip(cut[:-1], cut[1:]):
        xy = np.array([nxy[n] for n in ns[a:b + 1]])
        if len(xy) < 2: continue
        L = float(np.sum(np.hypot(*np.diff(xy, axis=0).T)))
        if L < 0.5: continue
        mid = xy[len(xy) // 2]
        if not all(inside(p) for p in xy): continue
        if TRK.distance(Point(*mid)) > float(os.environ.get("TRAFFIC_BUF", "1e9")): continue
        t = w["tags"]; ow = t.get("oneway"); rb = t.get("junction") == "roundabout"
        edges.append(dict(n0=ns[a], n1=ns[b], xy=xy, L=L, cls=cls_of(w), tags=t,
                          fwd=ow != "-1", bwd=not (ow in ("yes", "true", "1", "-1") or rb) or ow == "-1"))
print("edges", len(edges))

def resample(xy, step):
    seg = np.hypot(*np.diff(xy, axis=0).T); arc = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(math.ceil(arc[-1] / step)) + 1); t = np.linspace(0, arc[-1], n)
    return np.stack([np.interp(t, arc, xy[:, 0]), np.interp(t, arc, xy[:, 1])], 1), t

def nlanes(e, forward):
    t = e["tags"]
    def num(k):
        try: return max(1, int(str(t.get(k, "")).split(";")[0]))
        except Exception: return None
    oneway = not (e["fwd"] and e["bwd"])
    v = num("lanes:forward" if forward else "lanes:backward")
    if v: return v
    L = num("lanes")
    if L: return L if oneway else max(1, L // 2)
    return {"trunk": 2, "primary": 2, "secondary": 1, "tertiary": 1}.get(e["cls"], 1) * (1 if not oneway else 1)

OFFS = np.arange(-32, 32.01, 0.5)
def scan(p, nrm):
    """横断方向の車道区間 [r, l]（左が正）と軌道敷区間"""
    rd = np.array([road(p[0] + nrm[0] * o, p[1] + nrm[1] * o) for o in OFFS])
    q = p[None, :] + nrm[None, :] * OFFS[:, None]
    dtr, _ = tr_tree.query(q, distance_upper_bound=4.0)
    tram = dtr < 2.7
    rd = rd | tram                          # 併用軌道も車道として連続させる
    c = int(np.argmin(np.abs(OFFS)))
    if not rd[c]:
        near = [i for i in range(len(OFFS)) if rd[i] and abs(OFFS[i]) <= 4]
        if not near: return None
        c = min(near, key=lambda i: abs(OFFS[i]))
    def grow(i, d):
        gap = 0
        while 0 <= i + d < len(OFFS):
            if rd[i + d]: i += d; gap = 0
            else:
                gap += 1
                if gap > 2: break
                i += d
        return i
    lo, hi = grow(c, -1), grow(c, 1)
    while lo < hi and not rd[lo]: lo += 1
    while hi > lo and not rd[hi]: hi -= 1
    r, l = OFFS[lo], OFFS[hi]
    tri = [OFFS[i] for i in range(lo, hi + 1) if tram[i]]
    return r - 0.25, l + 0.25, (min(tri), max(tri)) if tri else None

def smooth(v, k=5):
    v = np.asarray(v, float)
    if len(v) < 3: return v
    pad = np.pad(v, (k, k), mode="edge")
    med = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(len(v))])
    return np.convolve(np.pad(med, (3, 3), mode="edge"), np.ones(7) / 7, mode="valid")

HALF = {}
for ei, e in enumerate(edges):
    xy, s = resample(e["xy"], 4.0)
    tg = np.gradient(xy, axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    nrm = np.stack([tg[:, 1], -tg[:, 0]], 1)            # 進行方向（辺の向き）の左
    scans = [scan(p, n) for p, n in zip(xy, nrm)]
    two = e["fwd"] and e["bwd"]
    nf, nb = nlanes(e, True), nlanes(e, False)
    lanes_f, lanes_b = [], []
    for i, S_ in enumerate(scans):
        if S_ is None:
            lanes_f.append(None); lanes_b.append(None); continue
        r, l, tr = S_
        if two:
            if tr: a_f, b_f, a_b, b_b = tr[1] + 1.25, l, -(tr[0] - 1.25), -r
            else:
                m = (l + r) / 2 if abs((l + r) / 2) < 3 else 0.0
                a_f, b_f, a_b, b_b = m + 0.1, l, -m + 0.1, -r
        else:
            if tr:
                if 0 >= tr[1] or (tr[0] < 0 < tr[1] and l - tr[1] > tr[0] - r): a_f, b_f = tr[1] + 1.25, l
                else: a_f, b_f = r, tr[0] - 1.25
            else: a_f, b_f = r, l
            a_b, b_b = -b_f, -a_f
        lanes_f.append((a_f, b_f)); lanes_b.append((a_b, b_b))
    HALF[ei] = float(np.median([(S_[1] - S_[0]) / 2 for S_ in scans if S_] or [3.5 + 1.6 * (nf + nb - 1)]))
    def offsets(reg, n, oneway):
        """区間 [a,b]（進行方向の左が正）に n 車線。内側(中央寄り)が k=0"""
        out = np.zeros((len(reg), n)); ok = np.zeros(len(reg), bool)
        for i, rg in enumerate(reg):
            if rg is None: continue
            a, b = rg; W = b - a
            if W < 2.2: continue
            nn = n
            w = min(3.4, W / nn)
            if oneway:
                c0 = (a + b) / 2 - w * nn / 2
                for k in range(nn): out[i, k] = c0 + w * (k + 0.5)
            else:
                w = min(3.4, max(2.4, (W - 0.3) / nn)) if W / nn < 3.4 else min(3.3, W / nn)
                for k in range(nn): out[i, k] = a + 0.15 + w * (k + 0.5)
            ok[i] = True
        # 走査できなかった点は既定値で埋める
        dflt = np.array([(1.8 if not oneway else -1.6 * (n - 1)) + 3.2 * k for k in range(n)]) if not oneway else np.array([-3.2 * (n - 1) / 2 + 3.2 * k for k in range(n)])
        for k in range(n):
            if ok.any():
                idx = np.nonzero(ok)[0]; out[:, k] = np.interp(np.arange(len(reg)), idx, out[idx, k])
            else: out[:, k] = dflt[k]
            out[:, k] = smooth(out[:, k])
        return out
    oneway = not two
    e["lane_geo"] = {}
    if e["fwd"]:
        o = offsets(lanes_f, nf, oneway)
        # 一方通行の OSM 向きが逆(-1)のときは後で反転
        e["lane_geo"]["f"] = [np.column_stack([xy + nrm * o[:, k:k + 1]]) for k in range(nf)]
    if e["bwd"]:
        o = offsets(lanes_b, nb, oneway)
        # 逆方向: 辺を反転した向きの左 = 元の右
        e["lane_geo"]["b"] = [(xy - nrm * o[:, k:k + 1])[::-1] for k in range(nb)]
print("scanned")

# ---- 節点 ----
deg = {}
for ei, e in enumerate(edges):
    deg.setdefault(e["n0"], []).append(ei); deg.setdefault(e["n1"], []).append(ei)
isec_xy = np.array([[I["x"], I["z"]] for I in ISECT])
def isect_of(p, rad=26):
    d = np.hypot(*(isec_xy - p).T); i = int(np.argmin(d))
    return i if d[i] < rad else -1
node_trim = {}; node_sig = {}
for nid, es in deg.items():
    p = nxy[nid]; gi = isect_of(p)
    node_sig[nid] = gi
    if len(es) <= 1: node_trim[nid] = 0.0; continue
    if len(es) == 2: node_trim[nid] = 3.0; continue
    hw = sorted([HALF[ei] for ei in es], reverse=True)
    node_trim[nid] = float(np.clip(hw[1] + 1.5, 4.0, 20.0))

def trim(pl, t0, t1):
    seg = np.hypot(*np.diff(pl, axis=0).T); arc = np.concatenate([[0], np.cumsum(seg)])
    L = arc[-1]
    if t0 + t1 > L - 2:
        f = max(0.0, (L - 2) / (t0 + t1 + 1e-9)); t0 *= f; t1 *= f
    s = np.arange(t0, L - t1, 2.0); s = np.append(s, L - t1)
    if len(s) < 2: s = np.array([t0, max(t0 + 0.5, L - t1)])
    return np.stack([np.interp(s, arc, pl[:, 0]), np.interp(s, arc, pl[:, 1])], 1)

lanes = []   # dict(p (N,2), e, dir, k, n, from_node, to_node, cls)
for ei, e in enumerate(edges):
    for d, geos in e["lane_geo"].items():
        rev = d == "b"
        fn, tn = (e["n1"], e["n0"]) if rev else (e["n0"], e["n1"])
        for k, g in enumerate(geos):
            p = trim(g, node_trim[fn], node_trim[tn])
            lanes.append(dict(p=p, e=ei, rev=rev, k=k, n=len(geos), fn=fn, tn=tn, cls=e["cls"]))
print("lanes", len(lanes))
def dedup(lanes):
    # 重なった車線の整理: 逆向きどうしが同じ線に乗っていたら左右に分け、同じ向きの重複は片方を捨てる
    LP = []; LI = []; LT = []
    for li, ln in enumerate(lanes):
        p = ln["p"]; t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
        LP.append(p); LI += [li] * len(p); LT.append(t)
    LP_ = np.concatenate(LP); LI = np.array(LI); LT_ = np.concatenate(LT)
    ktree = cKDTree(LP_)
    drop = set(); shifted = 0
    for li, ln in enumerate(lanes):
        if li in drop: continue
        p = ln["p"]; t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
        hits = ktree.query_ball_point(p, 1.3)
        opp = np.zeros(len(p), bool); same = {}
        for i, hs in enumerate(hits):
            for h in hs:
                o = LI[h]
                if o == li or o in drop: continue
                d = float(LT_[h] @ t[i])
                if d < -0.8: opp[i] = True
                elif d > 0.8: same[o] = same.get(o, 0) + 1
        if opp.mean() > 0.4:
            nrm = np.stack([t[:, 1], -t[:, 0]], 1)
            from scipy.ndimage import uniform_filter1d; w = uniform_filter1d(opp.astype(float), 5, mode="nearest")
            ln["p"] = p + nrm * (1.6 * w)[:, None]; shifted += 1
        for o, c in same.items():
            if c > 0.6 * len(p) and len(lanes[o]["p"]) <= len(p) and lanes[o]["e"] != ln["e"]: drop.add(o)
    print("overlap: shifted", shifted, "dropped", len(drop))
    lanes = [ln for i, ln in enumerate(lanes) if i not in drop]
    return lanes
for _ in range(3): lanes = dedup(lanes)
by_from = {}; by_to = {}
for li, ln in enumerate(lanes):
    by_from.setdefault(ln["fn"], []).append(li); by_to.setdefault(ln["tn"], []).append(li)

def ang(v): return math.atan2(v[1], v[0])
conns = []
for nid in deg:
    ins = by_to.get(nid, []); outs = by_from.get(nid, [])
    for li in ins:
        a = lanes[li]; pa = a["p"]; da = pa[-1] - pa[-2]; da /= np.linalg.norm(da) + 1e-9
        cand = []
        for lo in outs:
            b = lanes[lo]
            if b["e"] == a["e"] and len(deg[nid]) > 1: continue          # 転回はしない（行き止まり以外）
            pb = b["p"]; db = pb[1] - pb[0]; db /= np.linalg.norm(db) + 1e-9
            cr = da[0] * db[1] - da[1] * db[0]; dt = float(da @ db)
            th = math.degrees(math.atan2(cr, dt))
            if abs(th) > 150: continue
            kind = "s" if abs(th) < 32 else ("l" if th < 0 else "r")
            cand.append((lo, kind, th))
        if not cand: continue
        # 車線の使い分け: 左折は一番左(外側)、右折は一番右(内側)、直進は同じ番号
        sel = []
        for lo, kind, th in cand:
            b = lanes[lo]
            if kind == "s":
                okk = min(a["k"], b["n"] - 1) == b["k"] or (a["n"] < b["n"] and b["k"] >= a["k"] and a["k"] == a["n"] - 1)
            elif kind == "l": okk = a["k"] == a["n"] - 1 and b["k"] == b["n"] - 1
            else: okk = a["k"] == 0 and b["k"] == 0
            if okk: sel.append((lo, kind, th))
        if not sel:
            # 少なくとも1本はつなぐ
            lo, kind, th = min(cand, key=lambda q: abs(q[2])); sel = [(lo, kind, th)]
        for lo, kind, th in sel:
            b = lanes[lo]; P0 = pa[-1]; P3 = b["p"][0]
            db = b["p"][1] - b["p"][0]; db /= np.linalg.norm(db) + 1e-9
            D = float(np.linalg.norm(P3 - P0)); c = D * (0.42 if kind != "s" else 0.35)
            P1 = P0 + da * c; P2 = P3 - db * c
            n = max(3, int(D / 2) + 2); t = np.linspace(0, 1, n)[:, None]
            pts = (1 - t) ** 3 * P0 + 3 * (1 - t) ** 2 * t * P1 + 3 * (1 - t) * t ** 2 * P2 + t ** 3 * P3
            L = float(np.sum(np.hypot(*np.diff(pts, axis=0).T)))
            thr = abs(math.radians(th))
            vmax = 60.0 if thr < 0.3 else float(np.clip(math.sqrt(2.2 * max(3.0, L / max(thr, 0.05))) * 3.6, 12, 60))
            conns.append(dict(a=li, b=lo, p=pts, k=kind, node=nid, v=vmax))
print("connections", len(conns))

# ---- 信号: 交差点域(26m)の外から入ってくる車線に停止線 ----
cross_hw = {}
for gi, I in enumerate(ISECT):
    c = np.array([I["x"], I["z"]]); mn = np.array(I["main"]); hwp = {0: 0.0, 1: 0.0}
    for ei, e in enumerate(edges):
        d = LineString(e["xy"]).distance(Point(*c))
        if d > 12: continue
        pr = LineString(e["xy"]); s = pr.project(Point(*c)); a_ = pr.interpolate(max(0, s - 6)); b_ = pr.interpolate(min(pr.length, s + 6))
        v = np.array([b_.x - a_.x, b_.y - a_.y]); v /= np.linalg.norm(v) + 1e-9
        ph = 0 if abs(v @ mn) > 0.707 else 1
        hwp[ph] = max(hwp[ph], HALF[ei])
    cross_hw[gi] = hwp
nsig = 0
for li, ln in enumerate(lanes):
    gi = node_sig.get(ln["tn"], -1)
    if gi < 0: continue
    if node_sig.get(ln["fn"], -1) == gi: continue   # 交差点内の区間（両端とも同じ交差点）
    if len(ln["p"]) < 2 or np.sum(np.hypot(*np.diff(ln["p"], axis=0).T)) < 10: continue
    I = ISECT[gi]; c = isec_xy[gi]; p = ln["p"]
    d = p[-1] - p[-4 if len(p) >= 4 else 0]; d /= np.linalg.norm(d) + 1e-9
    # v19: 交差点の中心から離れた節点（26m 以内の別の丁字路など）で終わる車線は、交差点の方を向いて入ってくる時だけ信号の対象にする
    #      （横から合流する脇道に信号が付き、変な向きの灯器が立っていた）
    dn = float(np.hypot(*(nxy[ln["tn"]] - c)))
    if dn > 11.0:
        tc = c - p[-1]; tcn = np.linalg.norm(tc)
        if tcn > 1.0 and (tc / tcn) @ d < math.cos(math.radians(35)): n_skip = globals().get("n_skip", 0) + 1; globals()["n_skip"] = n_skip; continue
    ph = 0 if abs(d @ np.array(I["main"])) > 0.707 else 1
    rs = max(6.0, cross_hw[gi][1 - ph] + 3.0)
    seg = np.hypot(*np.diff(p, axis=0).T); arc = np.concatenate([[0], np.cumsum(seg)])
    dist = np.hypot(*(p - c).T)
    inside_ = np.nonzero(dist <= rs)[0]
    stop = float(arc[inside_[0]]) if len(inside_) else float(arc[-1])
    stop = max(0.0, min(arc[-1], stop) - 0.5)
    ln["sig"] = dict(g=gi, ph=ph, s=round(stop, 1)); nsig += 1
print("signal approaches", nsig, "skipped side approaches", globals().get("n_skip", 0))

# ---- 路面電車の軌道に重なる車線は除く（交差点の横断を除く）----
def to3(p):
    return [[round(float(x), 2), round(h_at(x, z) + 0.02, 2), round(float(z), 2)] for x, z in p]
def offroad(p, halfw=0.75):
    """点列の左右（車体幅）が車道（または軌道敷）から外れている割合"""
    if len(p) < 2: return 1.0
    seg = np.hypot(*np.diff(p, axis=0).T); arc = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, arc[-1] + 1e-6, 1.0)
    q = np.stack([np.interp(t, arc, p[:, 0]), np.interp(t, arc, p[:, 1])], 1)
    tg = np.gradient(q, axis=0) if len(q) > 1 else np.array([[1.0, 0.0]]); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    nl = np.stack([tg[:, 1], -tg[:, 0]], 1)
    bad = 0
    dtr, _ = tr_tree.query(q)
    for k in range(len(q)):
        ok = True
        for w in (-halfw, 0.0, halfw):
            x, z = q[k] + nl[k] * w
            if not (road(x, z) or dtr[k] < 2.7): ok = False; break
        bad += not ok
    return bad / len(q)
def nudge(p, halfw=0.9):
    """車体幅が車道からはみ出す点を、横方向 ±3m の範囲で車道の内側へずらす"""
    if len(p) < 2: return p
    tg = np.gradient(p, axis=0); tg /= np.linalg.norm(tg, axis=1)[:, None] + 1e-9
    nl = np.stack([tg[:, 1], -tg[:, 0]], 1); out = p.copy(); sh = np.zeros(len(p))
    dtr, _ = tr_tree.query(p)
    okf = lambda q: all(road(*(q + nlk * w)) for w in (-halfw, 0.0, halfw))
    for k in range(len(p)):
        nlk = nl[k]
        if dtr[k] < 2.7 or okf(p[k]): continue
        for o in (0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.0, -2.0, 2.5, -2.5, 3.0, -3.0):
            if okf(p[k] + nlk * o): sh[k] = o; break
    from scipy.ndimage import uniform_filter1d
    sh = uniform_filter1d(sh, 5, mode="nearest")
    return p + nl * sh[:, None]
for ln in lanes: ln["p"] = nudge(ln["p"])
keep = []; n_off = 0
for li, ln in enumerate(lanes):
    d, _ = tr_tree.query(ln["p"]); frac = float(np.mean(d < 1.6))
    off = offroad(ln["p"], 0.6)
    ln["off"] = off
    if off > 0.3: n_off += 1
    keep.append(frac < 0.5 and off <= 0.3)
print("lanes dropped as off-road (sidewalk etc.)", n_off)
conns = [c for c in conns if offroad(c["p"], 0.4) <= 0.35]
print("conns after off-road filter", len(conns))
idmap = {}; out_l = []
for li, ln in enumerate(lanes):
    if not keep[li]: continue
    idmap[li] = len(out_l)
    out_l.append(ln)
out_c = [c for c in conns if c["a"] in idmap and c["b"] in idmap]

print("kept lanes", len(out_l), "conns", len(out_c))
SPEED = {"trunk": 50, "primary": 50, "secondary": 40, "tertiary": 40, "unclassified": 30, "residential": 30}
NAMES = []
def nm_id(e):
    n = edges[e]["tags"].get("name") or ""
    if not n: return -1
    if n not in NAMES: NAMES.append(n)
    return NAMES.index(n)
J = dict(
    lanes=[dict(p=to3(ln["p"]), c=ln["cls"][0], v=SPEED[ln["cls"]], n=ln["n"], k=ln["k"], to=ln["tn"] and str(ln["tn"]),
                fr=str(ln["fn"]), nm=nm_id(ln["e"]), sig=ln.get("sig")) for ln in out_l],
    conns=[dict(a=idmap[c["a"]], b=idmap[c["b"]], p=to3(c["p"]), k=c["k"], v=round(c["v"]), node=str(c["node"])) for c in out_c],
    sig_nodes=[str(n) for n, g in node_sig.items() if g >= 0],
    names=NAMES,
)
# 同じ節点の接続は相互に排他（信号の無い交差点で使う）
json.dump(J, open(f"{OUT}/traffic.json", "w"), separators=(",", ":"))
print("wrote", os.path.getsize(f"{OUT}/traffic.json") / 1e6, "MB")
