"""v3: 車線に平行な白線だけで、左右の最寄りの線までの距離を測る"""
import os, sys, json, zlib, base64, numpy as np
from scipy.spatial import cKDTree
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lane_common.py")).read())
q = np.load(os.environ.get("MARK_CACHE","/tmp/markq.npy")); tree = cKDTree(q)
dirs = np.load(os.environ.get("MARK_DIRS","/tmp/markdirs.npz"))["d"]; lin = np.load(os.environ.get("MARK_DIRS","/tmp/markdirs.npz"))["l"]
def resample(P, step=2.0):
    xz = P[:, [0, 2]]; d = np.r_[0, np.cumsum(np.hypot(*np.diff(xz, axis=0).T))]
    if d[-1] < step * 4: return None
    s = np.arange(0, d[-1], step)
    return np.stack([np.interp(s, d, xz[:, 0]), np.interp(s, d, xz[:, 1])], 1), d[-1]
R = 3.8; W = 2.3
rows = []
for li, e in enumerate(T["lanes"]):
    if e["c"] in ("u", "r"): continue
    P = A[e["o"]:e["o"]+e["m"]]
    r_ = resample(P)
    if r_ is None: continue
    pts, Ltot = r_
    t = np.gradient(pts, axis=0); t /= np.maximum(np.hypot(*t.T)[:, None], 1e-9)
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    idxs = tree.query_ball_point(pts, np.hypot(R, W))
    for i, ids in enumerate(idxs):
        s = i * 2.0
        if s < 8 or s > Ltot - 8: continue            # 交差点の近く（端 8m）は除く
        if not ids: rows.append((li, e["c"], e["n"], e["k"], pts[i,0], pts[i,1], np.nan, np.nan, 0)); continue
        ids = np.array(ids); d = q[ids] - pts[i]; al = d @ t[i]; la = d @ nrm[i]
        par = np.abs(dirs[ids] @ t[i]) > 0.94           # 約 20 度以内で平行
        m = (np.abs(al) < W) & (np.abs(la) < R) & par & (lin[ids] > 0.6)
        if not m.any(): rows.append((li, e["c"], e["n"], e["k"], pts[i,0], pts[i,1], np.nan, np.nan, 0)); continue
        la = la[m]; pos = la[la > 0]; neg = -la[la < 0]
        rows.append((li, e["c"], e["n"], e["k"], pts[i,0], pts[i,1], pos.min() if len(pos) else np.nan, neg.min() if len(neg) else np.nan, 1))
rows = np.array(rows, dtype=object)
np.save(os.environ.get("ROWS_OUT","/tmp/lines_rows.npy"), rows, allow_pickle=True)
cls = rows[:, 1]; n = rows[:, 2].astype(int); dL = rows[:, 6].astype(float); dR = rows[:, 7].astype(float)
def rep(mask, name):
    a = dL[mask]; bb = dR[mask]; tot = mask.sum(); mn = np.fmin(a, bb); ok = ~np.isnan(mn); both = ~np.isnan(a) & ~np.isnan(bb)
    print(f"{name:14s} 点={tot:7d} 平行線なし {100*(~ok).sum()/tot:5.1f}%  片側のみ {100*(ok&~both).sum()/tot:5.1f}%  両側 {100*both.sum()/tot:5.1f}% | 最寄り線 <0.9m {100*np.nansum(mn<0.9)/tot:5.1f}%  <0.6m {100*np.nansum(mn<0.6)/tot:5.1f}%  <0.3m {100*np.nansum(mn<0.3)/tot:5.1f}% | 両側ありで中央ずれ>0.5m {100*np.nansum(np.abs(a-bb)/2>0.5)/max(1,both.sum())*both.sum()/tot:5.1f}%  両側の間隔の中央値 {np.nanmedian((a+bb)[both]):.2f}m")
for c in ("p", "s", "t"):
    for nn in (1, 2, 3, 4):
        m = (cls == c) & (n == nn)
        if m.sum() > 500: rep(m, f"{c} n={nn}")
rep((cls == "p") | ((cls == "t") & (n >= 2)) | (cls == "s"), "大通り全体")
# 旧い指標（v41.8 と同じ考え方: 車線の点から最寄りの白線（向き問わず）までの距離）
lanesel = [i for i, e in enumerate(T["lanes"]) if e["c"] in ("p", "s", "t")]
tot = 0; c95 = 0; c60 = 0
for li in lanesel[::6]:
    e = T["lanes"][li]; P = A[e["o"]:e["o"]+e["m"]][:, [0, 2]]
    d, _ = tree.query(P); tot += len(P); c95 += (d < 0.95).sum(); c60 += (d < 0.6).sum()
print(f"旧指標（頂点のみ・向き問わず）: <0.95m {100*c95/tot:.1f}%  <0.6m {100*c60/tot:.1f}%  頂点数 {tot}")
