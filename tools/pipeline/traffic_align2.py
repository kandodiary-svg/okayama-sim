"""v41.12: 車線網（data/traffic.json）の後処理その2。大通りで車が「白線と白線の間」を走らない問題を直す。

v41.8 の traffic_align.py は「白線から 0.95m 離れる」だけを見ていた。測り直すと大通り（p・s・t 級）で次のことが残っていた:
  1. 同じ向きの隣り合う車線が 1.6〜2.0m 間隔に詰まっている組が約 3 割（車幅 1.76m とほぼ同じ。白線をまたぎ、横並びの車が重なる）
  2. 車線の中心が、左右の白線の真ん中からずれている（両側の白線が見える所の約 6% で 0.5m 超）
  3. 車体（半幅 0.88m）が車線に平行な白線に掛かる点が約 15%

直し方（traffic_align.py と同じく、車線の本数・つながり・信号・制限速度・高さは変えない。大通り以外は v41.8 のまま）:
  - 大通り（p・s・t）の車線ごとに、横ずれ（±3.6m）を動的計画法で決める。費用は
      a. 車線に平行な白線に車体が掛からない（半幅 0.88m + 余裕。向きが平行な白線だけ数える。横断歩道・停止線は除く）
      b. 左右に白線が見えて間隔が 2.3〜5.8m のとき、その真ん中を走る
      c. 隣の車線との間隔: 同じ辺・同じ向きは 3.0m 以上、反対向きは 3.0m 以上（やわらかい目標）。2.3m（反対向きは 2.4m）未満は強い罰。
         間隔は「元の位置でどちら側にいたか」で符号をつけて測り、車線の並びが入れ替わらないようにする
         反対向きの隣は辺の組（fr,to）ではなく形（向きが逆で 3 点以上並ぶ車線）から探す。上り・下りが別の OSM の線で節点が違う道があるため
      d. 目標の横ずれ: 各頂点で、近くの全車線（自分と隣）を元の横位置の順に並べ、隣り合う間隔を G_TARGET(3.2m) 以上にする最小の移動を
         単調回帰（PAV）で求め、そこへ寄せる（重み W_T）。2 車線ずつの押し合いでは 6 車線ぶんの詰まりが伝わらず、
         車線が道の真ん中に寄って作られていた所（幅 23m の道に 6 車線が 11m に詰まる）が直らなかった
      e. 車体が車道から出ない・なめらか・元の位置から離れすぎない（従来どおり）
         重み: 白線 150・車道の外 150・隣の車線 8（下限未満は +80）・真ん中 10・目標 4
  - 隣の車線の位置は動くので、全車線を 4 回なめる（座標降下。SWEEPS）。
  - 接続カーブ・停止線は v41.8 と同じ手順で作り直す。

試験用の環境変数: BBOX="x0,z0,x1,z1"（その中の大通りの車線だけ直す）、ART_ONLY=1（大通りだけ直して評価を表示して終了。ART_DUMP=ファイル に結果を保存）、
DBG_LANE=車線番号 DBG_XZ=x,z（その頂点の費用の内訳を表示）。評価の物差しは tests/lane_vs_lines.py・lane_spacing.py・lane_group_spacing.py。

入力・出力・環境変数は traffic_align.py と同じ（元は /home/claude/wx/traffic_pre_align.json 等に退避済み。何度流しても同じ結果。OUT_DIR=/tmp/x で別出力、LIMIT で試験）。
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
# v41.12: 白線の各点の向き（半径 0.7m の近傍の主成分）と直線らしさ。車線に平行な白線だけを数えるのに使う
MD = os.environ.get("MARK_DIRS", "/tmp/markdirs.npz")
if os.path.exists(MD):
    _z = np.load(MD); mdir = _z["d"]; mlin = _z["l"]
else:
    mdir = np.zeros((len(q), 2), np.float32); mlin = np.zeros(len(q), np.float32)
    _nb = mtree.query_ball_point(q, 0.7, workers=-1)
    for _i, _ids in enumerate(_nb):
        if len(_ids) < 4: continue
        _p = q[_ids] - q[_ids].mean(0); _w, _v = np.linalg.eigh(_p.T @ _p)
        mdir[_i] = _v[:, 1]; mlin[_i] = 1 - _w[0] / max(_w[1], 1e-9)
    np.savez(MD, d=mdir, l=mlin); del _nb
log("marking directions", len(q))

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
ARTS = ("p", "s", "t")
BASE = [None] * len(LP); TAN = [None] * len(LP); NRM = [None] * len(LP)
for li, p0 in enumerate(LP):
    p = dedup_pts(p0)
    if (LIMIT and li >= LIMIT) or len(p) < 3 or arc_of(p)[-1] < 6: continue
    BASE[li] = smooth_lane(p)

# ---------- B2. 大通りの車線: 費用の用意（白線・道路）。隣の車線の項は掃引ごとに足す ----------
OFFR = float(os.environ.get("OFFR", "3.6"))            # 横ずれの範囲（元の車線の位置から）。車線が道の真ん中に寄って生成された所を広げるため ±3.6m
OFFS2 = np.arange(-OFFR, OFFR + 1e-4, 0.1); NS2 = len(OFFS2)
CLEARB = float(os.environ.get("CLEARB", "1.0"))       # 車体の半幅 0.88m + 余裕
WIN_B = 2.4; WIN_C = 6.0; RQ = OFFR + 6.6; LAMAX = OFFR + 4.0
W_CLEAR = float(os.environ.get("W_CLEAR", "150.0")); W_ROAD = float(os.environ.get("W_ROAD", "150.0")); W_CENTER = float(os.environ.get("W_CENTER", "10.0")); W_DEV = 0.3
SMIN_SAME = float(os.environ.get("SMIN_SAME", "3.0")); SMIN_OPP = float(os.environ.get("SMIN_OPP", "3.0")); W_NBR = float(os.environ.get("W_NBR", "8.0"))
HARD_MIN = float(os.environ.get("HARD_MIN", "2.3")); W_HARD = float(os.environ.get("W_HARD", "80.0")); HARD_OPP = float(os.environ.get("HARD_OPP", "2.4"))
def frame(base):
    xz = base[:, [0, 2]]; n = len(xz)
    t = np.zeros((n, 2)); t[1:-1] = xz[2:] - xz[:-2]; t[0] = xz[1] - xz[0]; t[-1] = xz[-1] - xz[-2]
    t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
    return xz, t, np.stack([t[:, 1], -t[:, 0]], 1)
def lane_terms(base):
    """車線の各頂点・各横ずれ候補について、費用の元になる量を返す: 平行な白線までの最短距離（候補ごと）、真ん中からのずれ（二乗。両側に白線が見えるときだけ）、車道の外に出る点の数"""
    xz, t, nl = frame(base); n = len(xz)
    mind = np.full((n, NS2), 9.0, np.float32); cen = np.zeros((n, NS2), np.float32)
    ids_all = mtree.query_ball_point(xz, RQ, workers=-1)
    for v in range(n):
        ids = ids_all[v]
        if not ids: continue
        ids = np.asarray(ids); d = q[ids] - xz[v]; al = d @ t[v]; la = d @ nl[v]
        m = (np.abs(mdir[ids] @ t[v]) > 0.8) & (mlin[ids] > 0.5) & (np.abs(la) < LAMAX)
        if not m.any(): continue
        mb = m & (np.abs(al) < WIN_B)
        if mb.any(): mind[v] = np.abs(la[mb][None, :] - OFFS2[:, None]).min(1)
        mc = m & (np.abs(al) < WIN_C)
        if mc.sum() >= 2:
            lc = np.sort(la[mc]); cut = np.nonzero(np.diff(lc) > 0.3)[0] + 1
            L = np.array([g.mean() for g in np.split(lc, cut)])
            if len(L) >= 2:
                idx = np.searchsorted(L, OFFS2); both = (idx > 0) & (idx < len(L))
                dL = np.where(both, L[np.minimum(idx, len(L) - 1)] - OFFS2, 0); dR = np.where(both, OFFS2 - L[np.maximum(idx - 1, 0)], 0)
                wd = dL + dR; ok = both & (wd > 2.3) & (wd < 5.8)
                cen[v] = np.where(ok, ((dL - dR) / 2) ** 2, 0)
    Q = xz[:, None, :] + nl[:, None, :] * OFFS2[None, :, None]
    rd = np.zeros((n, NS2), np.float32)
    for w in (-0.9, 0.0, 0.9):
        qq = Q + nl[:, None, :] * w
        rd += (~on_road(qq[:, :, 0].ravel(), qq[:, :, 1].ravel())).reshape(n, NS2)
    return mind, cen, rd, t, nl
def lane_cost0(terms):
    mind, cen, rd, t, nl = terms
    return W_CLEAR * np.maximum(0, CLEARB - mind) ** 2 + W_CENTER * cen + W_ROAD * rd + W_DEV * OFFS2[None, :] ** 2

art_ids = [li for li in range(len(LP)) if BASE[li] is not None and lanes[li]["c"] in ARTS]
_bb = os.environ.get("BBOX")      # 試験用: "x0,z0,x1,z1" の中に点がある大通りの車線だけを直す
if _bb:
    _x0, _z0, _x1, _z1 = map(float, _bb.split(","))
    art_ids = [li for li in art_ids if ((BASE[li][:, 0] > _x0) & (BASE[li][:, 0] < _x1) & (BASE[li][:, 2] > _z0) & (BASE[li][:, 2] < _z1)).any()]
log("大通りの車線", len(art_ids), "（全", len(LP), "）")
TERMS = {}; _cc = os.environ.get("COST_CACHE", "")
if _cc and os.path.exists(_cc):
    import pickle as _pk; TERMS = _pk.load(open(_cc, "rb")); log("費用の元をキャッシュから読み込み", len(TERMS))
else:
    for k_, li in enumerate(art_ids):
        TERMS[li] = lane_terms(BASE[li])
        if k_ % 2000 == 0: log("費用の元", k_, "/", len(art_ids))
    if _cc:
        import pickle as _pk; _pk.dump(TERMS, open(_cc, "wb"), protocol=4)
COST0 = {}
for li in art_ids:
    COST0[li] = lane_cost0(TERMS[li]); TAN[li] = TERMS[li][3]; NRM[li] = TERMS[li][4]
G = {}
for li, e in enumerate(lanes): G.setdefault((e["fr"], e["to"]), []).append(li)
SAME = {li: [j for j in G[(lanes[li]["fr"], lanes[li]["to"])] if j != li and j in COST0] for li in art_ids}
# 反対向きの隣は、辺の組（fr,to）ではなく形から探す: 上り・下りが別の OSM の線（節点の番号が違う）でも、向きが逆で近い車線は離す。
# （辺の組で探すと 3+3 車線の道の内側の車線どうしが 1m まで寄った所があった）
_dp = []; _dl = []; _dt = []; _own = {}
for li in art_ids:
    pb = BASE[li]; arc_ = arc_of(pb)
    if arc_[-1] < 0.1: continue
    ss_ = np.append(np.arange(0, arc_[-1], 1.5), arc_[-1])
    P_ = np.stack([np.interp(ss_, arc_, pb[:, 0]), np.interp(ss_, arc_, pb[:, 2])], 1)
    t_ = np.gradient(P_, axis=0) if len(P_) > 1 else np.array([[1.0, 0.0]]); t_ /= np.maximum(np.hypot(*t_.T)[:, None], 1e-9)
    _own[li] = (P_, t_); _dp.append(P_); _dt.append(t_); _dl.append(np.full(len(P_), li))
_dp = np.concatenate(_dp); _dt = np.concatenate(_dt); _dl = np.concatenate(_dl)
_atree = cKDTree(_dp); NBR_R = 2 * OFFR + 3.0
# 隣の車線ごとに「元の位置でどちら側にいるか」(sg=±1) を決めておく。横の間隔は符号つきで測り、車線の並び順が入れ替わらないようにする
NB = {}; _SAMEL = {li: set(SAME[li]) for li in art_ids}
for li in art_ids:
    NB[li] = []
    if li not in _own: continue
    P_, t_ = _own[li]; n_ = np.stack([t_[:, 1], -t_[:, 0]], 1); acc = {}
    for v, ids in enumerate(_atree.query_ball_point(P_, NBR_R, workers=-1)):
        for k in ids:
            j = int(_dl[k])
            if j == li: continue
            dot = t_[v] @ _dt[k]
            if abs(dot) < 0.85 or (dot > 0 and j not in _SAMEL[li]): continue
            r = _dp[k] - P_[v]
            if abs(r @ t_[v]) > 1.5: continue
            acc.setdefault(j, ([], dot > 0))[0].append(float(r @ n_[v]))
    for j, (ss_, same_) in acc.items():
        if len(ss_) >= 3 and j in COST0: NB[li].append((j, 1.0 if np.median(ss_) > 0 else -1.0, same_))
OPP = {li: [j for j, sg, same in NB[li] if not same] for li in art_ids}

# 目標の横ずれ: 各頂点で「近くにいる全部の車線（自分と隣）を元の横位置の順に並べ、隣り合う間隔を G_TARGET 以上にする最小の移動」を
# 単調回帰（PAV）で求める。2 点ずつ押し合う座標降下では 6 車線ぶんの詰まりが伝わらず、内側の対向車線が 1〜2m に寄ったままだった
G_TARGET = float(os.environ.get("G_TARGET", "3.2")); W_T = float(os.environ.get("W_T", "4.0"))
def pav_targets(b, g):
    """b: 昇順の横位置 → 隣り合う間隔 ≥ g で、移動の二乗和が最小の位置"""
    y = b - np.arange(len(b)) * g; vals = []; wts = []
    for v in y:
        vals.append(v); wts.append(1.0)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            w = wts[-2] + wts[-1]; vals[-2] = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / w; wts[-2] = w; vals.pop(); wts.pop()
    out = np.concatenate([np.full(int(w), v) for v, w in zip(vals, wts)])
    return out + np.arange(len(b)) * g
_btree = {}
def btree(j):
    t_ = _btree.get(j)
    if t_ is None: t_ = _btree[j] = cKDTree(_own[j][0])
    return t_
TGT = {}; HASNB = {}
for li in art_ids:
    n = len(BASE[li]); TGT[li] = np.zeros(n); HASNB[li] = np.zeros(n, bool)
    if not NB[li]: continue
    xz = BASE[li][:, [0, 2]]; nl = NRM[li]; t = TAN[li]
    Bm = np.full((n, len(NB[li])), np.nan)
    for c_, (j, sg, same) in enumerate(NB[li]):
        d, ix = btree(j).query(xz); r = _own[j][0][ix] - xz
        ok = (np.abs((r * t).sum(1)) < 1.5) & (d < 2 * OFFR + 3.0)
        Bm[ok, c_] = (r * nl).sum(1)[ok]
    for v in range(n):
        row = Bm[v]; m_ = ~np.isnan(row)
        if not m_.any(): continue
        vals = np.append(row[m_], 0.0); me = len(vals) - 1; order = np.argsort(vals, kind="stable"); pos = int(np.nonzero(order == me)[0][0])
        tg = pav_targets(vals[order], G_TARGET)
        TGT[li][v] = np.clip(tg[pos], -OFFR, OFFR); HASNB[li][v] = True
log("目標の横ずれを計算", sum(int(h.sum()) for h in HASNB.values()), "頂点")
log("隣の車線（同じ向き・反対向き）", sum(len(v) for v in NB.values()), "組。うち反対向き", sum(len(v) for v in OPP.values()))

CUR = {li: BASE[li].copy() for li in art_ids}; _dense = {}
def dense_tree(j):
    tr = _dense.get(j)
    if tr is None:
        p = CUR[j][:, [0, 2]]; arc = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
        if arc[-1] < 0.1: pts = p[:1]
        else:
            ss = np.arange(0, arc[-1], 0.5); ss = np.append(ss, arc[-1]); pts = np.stack([np.interp(ss, arc, p[:, 0]), np.interp(ss, arc, p[:, 1])], 1)
        tr = _dense[j] = cKDTree(pts)
    return tr
SWEEPS = int(os.environ.get("SWEEPS", "4"))
for sw in range(SWEEPS):
    moved_sum = 0.0; nmv = 0
    for k_, li in enumerate(art_ids):
        base = BASE[li]; xz = base[:, [0, 2]]; t = TAN[li]; nl = NRM[li]; n = len(xz)
        cost = COST0[li].copy()
        if W_T > 0 and HASNB[li].any(): cost += (W_T * (OFFS2[None, :] - TGT[li][:, None]) ** 2) * HASNB[li][:, None]
        if NB[li]:
            Qf = (xz[:, None, :] + nl[:, None, :] * OFFS2[None, :, None]).reshape(-1, 2); c = np.zeros(len(Qf))
            nlr = np.repeat(nl, NS2, axis=0); tr_ = np.repeat(t, NS2, axis=0)
            for j, sg, same in NB[li]:
                trj = dense_tree(j); d, ix = trj.query(Qf); r = trj.data[ix] - Qf
                g = sg * (r * nlr).sum(1); ok = (np.abs((r * tr_).sum(1)) < 2.5) & (d < 8.0)
                smin = SMIN_SAME if same else SMIN_OPP; hard = HARD_MIN if same else HARD_OPP
                c += np.where(ok, W_NBR * np.maximum(0, smin - g) ** 2 + W_HARD * np.maximum(0, hard - g) ** 2, 0.0)
            cost += c.reshape(n, NS2)
        if os.environ.get("DBG_LANE") and li == int(os.environ["DBG_LANE"]):
            _x, _z = map(float, os.environ["DBG_XZ"].split(",")); v_ = int(np.argmin(np.hypot(xz[:, 0] - _x, xz[:, 1] - _z)))
            mind_, cen_, rd_, _, _ = TERMS[li]
            print("DBG sweep", sw, "lane", li, "vertex", v_, "of", n, "arcLen", round(arc_of(base)[-1], 1), "xz", xz[v_].round(2))
            for kk in range(0, NS2, 4):
                print("  off %5.1f  mind %.2f  cen %.2f  road %d  cost0 %.1f  total %.1f" % (OFFS2[kk], mind_[v_, kk], cen_[v_, kk], rd_[v_, kk], COST0[li][v_, kk], cost[v_, kk]))
        ds = np.diff(arc_of(base)); ks = viterbi(cost, ds); o = OFFS2[ks]
        if n >= 5:
            pad = np.pad(o, (1, 1), mode="edge"); o = (pad[:-2] + 2 * pad[1:-1] + pad[2:]) / 4
        out = base.copy(); out[:, 0] += nl[:, 0] * o; out[:, 2] += nl[:, 1] * o
        CUR[li] = out; _dense.pop(li, None); moved_sum += float(np.abs(o).mean()); nmv += 1
        if k_ % 3000 == 0: log("掃引", sw + 1, k_, "/", len(art_ids))
    log("掃引", sw + 1, "終わり。平均の動き", round(moved_sum / max(1, nmv), 3), "m")

if os.environ.get("ART_ONLY"):
    if os.environ.get("ART_DUMP"): pickle.dump({li: CUR[li] for li in art_ids}, open(os.environ["ART_DUMP"], "wb"))
    # 試験用: 大通りの車線だけで、白線への掛かり・隣の車線との間隔・車道はみ出しを数えて終わる
    cnt = {"n": 0, "l09": 0, "l06": 0, "both": 0, "off": 0}; nL = 0; nSp = 0; spn = 0; sp24 = 0; sp20 = 0; opn = 0; op24 = 0; op20 = 0
    for li in art_ids:
        p = CUR[li]; xz = p[:, [0, 2]]; arc = arc_of(p)
        if arc[-1] < 24: continue
        ss = np.arange(8, arc[-1] - 8, 2.0)
        P_ = np.stack([np.interp(ss, arc, xz[:, 0]), np.interp(ss, arc, xz[:, 1])], 1); t_ = np.gradient(P_, axis=0); t_ /= np.maximum(np.hypot(*t_.T)[:, None], 1e-9); n_ = np.stack([t_[:, 1], -t_[:, 0]], 1)
        ids_all = mtree.query_ball_point(P_, 4.5, workers=-1)
        for v, ids in enumerate(ids_all):
            cnt["n"] += 1
            if not ids: continue
            ids = np.asarray(ids); d = q[ids] - P_[v]; al = d @ t_[v]; la = d @ n_[v]
            m = (np.abs(mdir[ids] @ t_[v]) > 0.8) & (mlin[ids] > 0.5) & (np.abs(al) < 2.3) & (np.abs(la) < 3.8)
            if m.any():
                mn = np.abs(la[m]).min(); cnt["l09"] += mn < 0.9; cnt["l06"] += mn < 0.6
        for w in (-0.75, 0.0, 0.75):
            qq = P_ + n_ * w; cnt["off"] += int((~on_road(qq[:, 0], qq[:, 1])).any()) * 0
        bad = np.zeros(len(P_), bool)
        for w in (-0.75, 0.0, 0.75):
            qq = P_ + n_ * w; bad |= ~on_road(qq[:, 0], qq[:, 1])
        cnt["both"] += int(bad.sum())
        for j in SAME[li]:
            if j <= li: continue
            d, _ = dense_tree(j).query(P_); d = d[(d > 0)]
            spn += len(d); sp24 += int((d < 2.4).sum()); sp20 += int((d < 2.0).sum())
        for j in OPP[li]:
            if j <= li: continue
            d, _ = dense_tree(j).query(P_); d = d[(d > 0) & (d < 4.5)]
            opn += len(d); op24 += int((d < 2.4).sum()); op20 += int((d < 2.0).sum())
    N_ = cnt["n"]
    log("評価: 点", N_, " 白線<0.9m %.1f%%  <0.6m %.1f%%  車体が車道の外 %.2f%%  同じ向きの隣と<2.4m %.1f%% <2.0m %.1f%% (点対 %d)" % (100*cnt["l09"]/N_, 100*cnt["l06"]/N_, 100*cnt["both"]/N_, 100*sp24/max(1,spn), 100*sp20/max(1,spn), spn))
    log("評価: 反対向きの隣（4.5m 以内の点対 %d）<2.4m %.1f%%  <2.0m %.1f%%" % (opn, 100*op24/max(1,opn), 100*op20/max(1,opn)))
    sys.exit(0)

# ---------- 大通り以外は v41.8 のまま（白線を避ける ±1.2m）----------
for li, p0 in enumerate(LP):
    if li in CUR: NEW.append(CUR[li]); nmoved += 1; maxoff = max(maxoff, float(np.abs(CUR[li][:, [0, 2]] - BASE[li][:, [0, 2]]).max())); continue
    base = BASE[li]
    if base is None: NEW.append(dedup_pts(p0) if not (LIMIT and li >= LIMIT) else p0); continue
    ds = np.diff(arc_of(base))
    t, nl, cost = solve_lane(base)
    ks = viterbi(cost, ds); o = OFFS[ks]
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
