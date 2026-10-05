"""v41.8: 車線網（data/traffic.json）の後処理。AI の車が白線をまたぐ・横にずれる・交差点で横にワープする、を直す。

原因（traffic.py の作り方）:
  1. 車線を作ったあとで nudge()（車体が車道から出る点を最大 3m 横へずらす）をかけているが、交差点の接続カーブはその前の位置で作ってある
     → 車線の端と接続カーブの始点・終点が最大 1.6m ずれ、車が曲がるたびに横へ飛ぶ
  2. nudge の横ずれは 5 点平均しかかけていないので、途中でいきなり数 m 動く（ジグザグ）
  3. 車線の中心は PLATEAU の車道幅から、白線（markings.py）は OSM の車線数＋車道幅から別々に決めているので、
     主要道路では約 2 割の地点で車体（半幅 0.9m）が白線にかかる
  4. OSM の曲がり角（90 度）がそのまま折れ線になっていて、車の向きが急に変わる

直し方（車線の本数・つながり・信号・制限速度・高さは変えない）:
  A. 折れ線をなめらかにする（角を丸める。端 6m までは元の位置のまま）
  B. 白線・車道の端を避ける横ずれを、動的計画法（Viterbi）で決める（横ずれ ±1.2m、1 点あたりの変化は傾き 8 度まで）
  C. 交差点の接続カーブを、新しい車線の端に合わせて作り直す（traffic.py と同じ 3 次ベジエ）
  D. 停止線の位置（sig.s）は、同じ頂点の新しい弧長に合わせる

入力 : /home/claude/okaden-x/data/traffic.json（＋traffic_pts.txt）、/home/claude/wx/markings_ext.pkl、/home/claude/wx/roads_final.pkl
出力 : 同じファイルを上書き（元は /home/claude/wx/traffic_pre_align.json と traffic_pts_pre_align.txt に退避。退避済みなら、そこから作り直す）
"""
import os, sys, json, math, zlib, base64, pickle, shutil, time
import numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))

OUT = os.environ.get("OUT_DIR", "/home/claude/okaden-x/data")
BK_J = "/home/claude/wx/traffic_pre_align.json"; BK_P = "/home/claude/wx/traffic_pts_pre_align.txt"
CLEAR = float(os.environ.get("CLEAR", "0.95"))     # 車線の中心から白線までの望ましい距離（車の半幅 0.9m + 余裕）
OMAX = 1.2; H = 0.1; NS = int(round(OMAX / H)) * 2 + 1; C0 = NS // 2
t00 = time.time()
def log(*a): print(f"[{time.time() - t00:6.1f}s]", *a, flush=True)

# ---------- 読み込み（退避済みなら元のデータから）----------
if not os.path.exists(BK_J):
    shutil.copy(f"{OUT}/traffic.json", BK_J); shutil.copy(f"{OUT}/traffic_pts.txt", BK_P)
T = json.load(open(BK_J))
raw = zlib.decompress(base64.b64decode(open(BK_P).read().strip()))
N = T["pts"]["n"]; b = np.frombuffer(raw, np.uint8)
A = np.zeros((N, 3), np.int64)
for c in range(3):
    o = c * 4 * N
    v = (b[o:o + N].astype(np.uint32) | (b[o + N:o + 2 * N].astype(np.uint32) << 8) | (b[o + 2 * N:o + 3 * N].astype(np.uint32) << 16) | (b[o + 3 * N:o + 4 * N].astype(np.uint32) << 24)).view(np.int32).astype(np.int64)
    A[:, c] = v
for L in (T["lanes"], T["conns"]):
    for e in L: A[e["o"]:e["o"] + e["m"]] = np.cumsum(A[e["o"]:e["o"] + e["m"]], axis=0)
A = A / 100.0
lanes = T["lanes"]; conns = T["conns"]
LP = [A[e["o"]:e["o"] + e["m"]].copy() for e in lanes]
log("lanes", len(lanes), "conns", len(conns), "points", N)

# ---------- 白線（細い三角形だけ）と車道 ----------
MQ = os.environ.get("MARK_CACHE", "/tmp/markq.npy")
if os.path.exists(MQ): q = np.load(MQ)
else:
    m = pickle.load(open("/home/claude/wx/markings_ext.pkl", "rb"))
    tt = m["white"].reshape(-1, 3, 3)[:, :, [0, 2]]
    e3 = np.stack([np.hypot(*(tt[:, 1] - tt[:, 0]).T), np.hypot(*(tt[:, 2] - tt[:, 1]).T), np.hypot(*(tt[:, 0] - tt[:, 2]).T)], 1)
    area = np.abs((tt[:, 1, 0] - tt[:, 0, 0]) * (tt[:, 2, 1] - tt[:, 0, 1]) - (tt[:, 2, 0] - tt[:, 0, 0]) * (tt[:, 1, 1] - tt[:, 0, 1])) / 2
    alt = 2 * area / np.maximum(e3.max(1), 1e-9)
    sel = (alt < 0.2) & (area > 1e-4); TT = tt[sel]; pts = []
    for a_, b_ in ((0, 1), (1, 2), (2, 0)):
        Ln = np.hypot(*(TT[:, b_] - TT[:, a_]).T); nn = np.maximum(2, np.ceil(Ln / 0.4).astype(int) + 1)
        for k in np.unique(nn):
            idx = np.where(nn == k)[0]; t = np.linspace(0, 1, k)[None, :, None]
            pts.append((TT[idx, a_][:, None, :] * (1 - t) + TT[idx, b_][:, None, :] * t).reshape(-1, 2))
    P = np.concatenate(pts); q = np.unique(np.round(P / 0.2).astype(np.int32), axis=0) * 0.2; np.save(MQ, q)
mtree = cKDTree(q); log("marking samples", len(q))

from common import load_roads
R = load_roads("/home/claude/wx/roads_final.pkl", "r"); KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]; del R["tris"]
rt = json.load(open(f"{OUT}/routes.json"))
tp = np.concatenate([np.array(rt[k]["track"])[:, [0, 2]] for k in ("higashi", "seiki", "higashi_r", "seiki_r")])
tr_tree = cKDTree(tp)
def on_road(x, z):
    i = ((x - GX0) / RES).astype(np.int64); j = ((z - GZ0) / RES).astype(np.int64)
    ok = (i >= 0) & (i < KIND.shape[1]) & (j >= 0) & (j < KIND.shape[0])
    r = np.zeros(x.shape, bool); r[ok] = KIND[j[ok], i[ok]] == 1
    bad = ~r
    if bad.any():   # 併用軌道は車道として数える
        d, _ = tr_tree.query(np.stack([x[bad], z[bad]], 1), distance_upper_bound=2.7); r[bad] = np.isfinite(d)
    return r
log("road grid", KIND.shape)

# ---------- A. なめらかにする ----------
K5 = np.array([1, 4, 6, 4, 1], float) / 16
def smooth_xz(p, passes=2):
    n = len(p)
    if n < 5: return p
    seg = np.hypot(*np.diff(p[:, [0, 2]], axis=0).T); arc = np.r_[0, np.cumsum(seg)]
    q_ = p.copy()
    for _ in range(passes):
        pad = np.pad(q_[:, [0, 2]], ((2, 2), (0, 0)), mode="edge")
        sm = sum(K5[k] * pad[k:k + n] for k in range(5))
        q_[:, [0, 2]] = sm
    w = np.clip(np.minimum(arc, arc[-1] - arc) / 6.0, 0, 1)[:, None]   # 端 6m までは元の位置
    out = p.copy(); out[:, [0, 2]] = p[:, [0, 2]] * (1 - w) + q_[:, [0, 2]] * w
    return out

def dedup_pts(p):
    keep = [0]
    for i in range(1, len(p)):
        if math.hypot(p[i, 0] - p[keep[-1], 0], p[i, 2] - p[keep[-1], 2]) > 0.05: keep.append(i)
    if len(keep) < 2: return p
    p = p[keep]
    # 端の 1m 未満の短い区間は、1 つ手前の点を捨ててまとめる（短い区間だけ向きが違う「ひげ」を作らない）
    if len(p) > 3 and math.hypot(p[-1, 0] - p[-2, 0], p[-1, 2] - p[-2, 2]) < 1.0: p = np.delete(p, -2, axis=0)
    if len(p) > 3 and math.hypot(p[1, 0] - p[0, 0], p[1, 2] - p[0, 2]) < 1.0: p = np.delete(p, 1, axis=0)
    return p

def arc_of(p): return np.r_[0, np.cumsum(np.hypot(*np.diff(p[:, [0, 2]], axis=0).T))]
def max_turn(p):
    if len(p) < 3: return 0.0
    d = np.diff(p[:, [0, 2]], axis=0); h = np.arctan2(d[:, 1], d[:, 0]); return float(np.abs((np.diff(h) + np.pi) % (2 * np.pi) - np.pi).max())
def smooth_lane(p):
    # 角が急（1 点で 22 度超）な間は、なめらかにする回数を増やす（最大 8 回）
    passes = 2; base = smooth_xz(p, passes)
    while max_turn(base[2:-2] if len(base) > 6 else base) > math.radians(22) and passes < 8: passes += 2; base = smooth_xz(p, passes)
    return base

# ---------- B. 横ずれの動的計画 ----------
OFFS = (np.arange(NS) - C0) * H
def solve_lane(base):
    """base: (n,3) なめらかにした車線 → 横ずれ (n,)"""
    n = len(base); xz = base[:, [0, 2]]
    t = np.zeros((n, 2)); t[1:-1] = xz[2:] - xz[:-2]; t[0] = xz[1] - xz[0]; t[-1] = xz[-1] - xz[-2]
    t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9; nl = np.stack([t[:, 1], -t[:, 0]], 1)
    Q = xz[:, None, :] + nl[:, None, :] * OFFS[None, :, None]               # (n, NS, 2)
    flat = Q.reshape(-1, 2)
    d, _ = mtree.query(flat, distance_upper_bound=CLEAR, workers=2); d = np.where(np.isfinite(d), d, CLEAR).reshape(n, NS)
    cost = 60.0 * np.maximum(0, CLEAR - d) ** 2
    rd = np.zeros((n, NS))
    for w in (-0.9, 0.0, 0.9):
        qq = Q + nl[:, None, :] * w
        rd += (~on_road(qq[:, :, 0].ravel(), qq[:, :, 1].ravel())).reshape(n, NS)
    cost += 40.0 * rd + 1.2 * OFFS[None, :] ** 2
    return t, nl, cost

def viterbi(cost, ds):
    n, K = cost.shape
    acc = np.full((n, K), 1e18); acc[0] = cost[0]; bp = np.zeros((n, K), np.int8)
    for i in range(1, n):
        M = max(1, int(0.14 * ds[i - 1] / H + 1e-9)); best = np.full(K, 1e18); arg = np.zeros(K, np.int8)
        for dlt in range(-M, M + 1):
            c = 6.0 * (dlt * H) ** 2
            # 状態 k へは k-dlt から来る
            if dlt >= 0: cand = np.r_[np.full(dlt, 1e18), acc[i - 1][:K - dlt]] + c
            else: cand = np.r_[acc[i - 1][-dlt:], np.full(-dlt, 1e18)] + c
            m_ = cand < best; best = np.where(m_, cand, best); arg = np.where(m_, dlt, arg)
        acc[i] = best + cost[i]; bp[i] = arg
    k = int(np.argmin(acc[-1])); ks = np.zeros(n, int); ks[-1] = k
    for i in range(n - 1, 0, -1): k -= int(bp[i, k]); ks[i - 1] = k
    return ks

def clearance_stats(lp_list, tag):
    ds_ = []; ok = []
    for i, p in enumerate(lp_list):
        if len(p) < 4: continue
        c = arc_of(p)
        if c[-1] < 40: continue
        m = (c > 15) & (c < c[-1] - 15); ds_.append(p[m][:, [0, 2]]); ok.append(np.full(m.sum(), i))
    P_ = np.concatenate(ds_); d, _ = mtree.query(P_, distance_upper_bound=3, workers=2)
    cl = np.array([lanes[i]["c"] for i in np.concatenate(ok)])
    r = {"all<0.9": float((d < 0.9).mean()), "all<0.5": float((d < 0.5).mean())}
    for c in "stp": r[c + "<0.9"] = float((d[cl == c] < 0.9).mean())
    # 車体（左右 0.75m）が車道から出ている点の割合（全頂点）
    allp = np.concatenate([p[:, [0, 2]] for p in lp_list if len(p) >= 3]); tg = []
    for p in lp_list:
        if len(p) < 3: continue
        x_ = p[:, [0, 2]]; t_ = np.zeros_like(x_); t_[1:-1] = x_[2:] - x_[:-2]; t_[0] = x_[1] - x_[0]; t_[-1] = x_[-1] - x_[-2]; t_ /= np.linalg.norm(t_, axis=1)[:, None] + 1e-9; tg.append(t_)
    tg = np.concatenate(tg); nl_ = np.stack([tg[:, 1], -tg[:, 0]], 1); bad = np.zeros(len(allp), bool)
    for w in (-0.75, 0.0, 0.75):
        qq = allp + nl_ * w; bad |= ~on_road(qq[:, 0], qq[:, 1])
    r["offroad"] = float(bad.mean())
    log(tag, {k: round(v, 4) for k, v in r.items()})
    return r

clearance_stats(LP, "before")

NEW = []
nmoved = 0; maxoff = 0; LIMIT = int(os.environ.get("LIMIT", "0"))
for li, p0 in enumerate(LP):
    p = dedup_pts(p0)
    if (LIMIT and li >= LIMIT) or len(p) < 3 or arc_of(p)[-1] < 6: NEW.append(p if not (LIMIT and li >= LIMIT) else p0); continue
    base = smooth_lane(p)
    ds = np.diff(arc_of(base))
    t, nl, cost = solve_lane(base)
    ks = viterbi(cost, ds); o = OFFS[ks]
    # 量子化（0.1m 刻み）の階段をならす
    if len(o) >= 5:
        pad = np.pad(o, (1, 1), mode="edge"); o2 = (pad[:-2] + 2 * pad[1:-1] + pad[2:]) / 4; o = o2
    out = base.copy(); out[:, 0] += nl[:, 0] * o; out[:, 2] += nl[:, 1] * o
    NEW.append(out); nmoved += 1; maxoff = max(maxoff, float(np.abs(o).max()))
    if li % 5000 == 0: log("lane", li, "/", len(LP))
log("moved", nmoved, "max offset", round(maxoff, 2))
clearance_stats(NEW, "after ")
log("lanes with >25deg kink: before", sum(max_turn(p) > math.radians(25) for p in LP), "after", sum(max_turn(p) > math.radians(25) for p in NEW))

# ---------- D. 停止線 ----------
for li, e in enumerate(lanes):
    sg = e.get("sig")
    if not sg: continue
    old = arc_of(LP[li]); new = arc_of(NEW[li]); s = sg["s"]
    # 元の弧長 s に最も近い頂点を、新しい弧長で言い換える（頂点の数が減った分は割合で）
    f = (new[-1] / old[-1]) if old[-1] > 1e-6 else 1.0
    sg["s"] = round(float(min(max(0.0, s * f), new[-1])), 1)

# ---------- C. 接続カーブを作り直す ----------
def tan_end(p, last):
    if last: v = p[-1, [0, 2]] - p[max(0, len(p) - 3), [0, 2]]
    else: v = p[min(2, len(p) - 1), [0, 2]] - p[0, [0, 2]]
    return v / (np.linalg.norm(v) + 1e-9)
NC = []; maxgap = 0
for c in conns:
    a = NEW[c["a"]]; bl = NEW[c["b"]]
    P0 = a[-1, [0, 2]]; P3 = bl[0, [0, 2]]; da = tan_end(a, True); db = tan_end(bl, False)
    D = float(np.linalg.norm(P3 - P0)); cl = D * (0.42 if c["k"] != "s" else 0.35)
    P1 = P0 + da * cl; P2 = P3 - db * cl
    n = max(6, int(math.ceil(D / 1.5)) + 1); tt_ = np.linspace(0, 1, n)[:, None]    # 短い接続でも曲線の形が出るよう 1.5m 間隔以下（traffic.py は 2m 間隔・最小 3 点で、急な右左折が折れ線になっていた）
    xz = (1 - tt_) ** 3 * P0 + 3 * (1 - tt_) ** 2 * tt_ * P1 + 3 * (1 - tt_) * tt_ ** 2 * P2 + tt_ ** 3 * P3
    ya = a[-1, 1]; yb = bl[0, 1]
    ds = np.hypot(*np.diff(xz, axis=0).T); s = np.r_[0, np.cumsum(ds)]; s = s / s[-1] if s[-1] > 1e-6 else np.zeros(n)
    s = s * s * (3 - 2 * s)
    NC.append(np.column_stack([xz[:, 0], ya + (yb - ya) * s, xz[:, 1]]))
log("conns rebuilt", len(NC))

# ---------- 書き出し（compact_traffic.py と同じ形式）----------
if os.environ.get("DRY"): log("DRY run: not written"); sys.exit(0)
chunks = []; off = 0
for e, p in zip(lanes, NEW):
    pp = np.round(p * 100).astype(np.int64); d = pp.copy(); d[1:] -= pp[:-1]; chunks.append(d.astype(np.int32)); e["o"] = off; e["m"] = len(pp); off += len(pp)
for e, p in zip(conns, NC):
    pp = np.round(p * 100).astype(np.int64); d = pp.copy(); d[1:] -= pp[:-1]; chunks.append(d.astype(np.int32)); e["o"] = off; e["m"] = len(pp); off += len(pp)
Aout = np.concatenate(chunks).reshape(-1, 3)
u = Aout.astype(np.int32).view(np.uint32)
rawo = b"".join(((u[:, c] >> s_) & 255).astype(np.uint8).tobytes() for c in range(3) for s_ in (0, 8, 16, 24))
open(f"{OUT}/traffic_pts.txt", "w").write(base64.b64encode(zlib.compress(rawo, 9)).decode())
T["pts"] = dict(file="traffic_pts.txt", n=int(off), enc="d4")
json.dump(T, open(f"{OUT}/traffic.json", "w"), ensure_ascii=False, separators=(",", ":"))
log("wrote", off, "points; json MB", round(os.path.getsize(f"{OUT}/traffic.json") / 1e6, 2), "pts MB", round(os.path.getsize(f"{OUT}/traffic_pts.txt") / 1e6, 2))
