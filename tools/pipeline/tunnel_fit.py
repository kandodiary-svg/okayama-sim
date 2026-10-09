"""v41.21: トンネルの床の左右の縁を、そこを通る車線（traffic.json。位置合わせ後）に沿わせる（tunnels.py が /home/claude/wx/tunnel_fit.json を読む）。
これまで: 床は OSM の道の中心線を軸に、タグ（lanes・width）から決めた一定の幅で作っていたが、車線は PLATEAU の道の面・白線に合わせて並べ直されるため、
          中心線から片側に偏り、坑口では外へ広がる（巌井野田線: 中ほどは 3 車線が −3.0・+0.1・+3.2 m、坑口では −5.1・−1.5・+1.3 m）。
          外側の車線の脇に壁の「通れない」帯が迫り、坑口で車が壁の角に当たった（実際の車の物理で走る試験 lane_drive_test.js で確認）。
やること: 中心線に沿った距離 s を 4m ごとに区切り、トンネルに沿って走る車線（トンネルの長さの 6 割以上にわたる車線）の、s ごとの横位置（中心線の左が +）の
          最小 lo(s)・最大 hi(s) を出す（前後 1 区切りで平らにならす）。床の右の縁 = lo − 1.95、左の縁 = hi + 1.95（車体の半幅 0.95 + 余裕 1.0）。
          上り・下りが別のトンネル（隣の中心線が 30m 以内）は、向かい合う側の縁を「2 本の最も近い車線の真ん中」（隙間 0.1m）にする（床が重ならない）。
使い方: python3 tunnel_fit.py [OUT_DIR（既定 /home/claude/okaden-x/data）]   前提: tunnels.pkl（tunnels.py の出力。xy は元の OSM の中心線）と traffic.json・traffic_pts.txt
出力: /home/claude/wx/tunnel_fit.json  { 道の id: {"s": [...], "lo": [...], "hi": [...]} }（元の中心線に対する左右の縁。tools/pipeline/tunnel_fit.json にも保存して再現できるようにする）"""
import os, sys, json, zlib, base64, pickle
import numpy as np
import shapely
from shapely.geometry import LineString

OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/okaden-x/data"
W = "/home/claude/wx"
CAR_HALF = 0.95; MARGIN = 1.0; GAP = 0.1; BIN = 4.0; COVER = 0.6; EXT = 14.0
T = json.load(open(f"{OUT}/traffic.json"))
raw = zlib.decompress(base64.b64decode(open(f"{OUT}/traffic_pts.txt").read().strip()))
N = T["pts"]["n"]; b = np.frombuffer(raw, np.uint8); A = np.zeros((N, 3), np.int64)
for c in range(3):
    o = c * 4 * N
    v = (b[o:o + N].astype(np.uint32) | (b[o + N:o + 2 * N].astype(np.uint32) << 8) | (b[o + 2 * N:o + 3 * N].astype(np.uint32) << 16) | (b[o + 3 * N:o + 4 * N].astype(np.uint32) << 24)).view(np.int32).astype(np.int64)
    A[:, c] = v
for L in (T["lanes"], T["conns"]):
    for e in L: A[e["o"]:e["o"] + e["m"]] = np.cumsum(A[e["o"]:e["o"] + e["m"]], axis=0)
A = A / 100.0
TUN = pickle.load(open(f"{W}/tunnels.pkl", "rb"))
lines = [LineString(t["xy"]) for t in TUN]
LP = [(i, A[e["o"]:e["o"] + e["m"]]) for i, e in enumerate(T["lanes"])]
def smooth(a):
    p = np.pad(a, 1, mode="edge"); return (p[:-2] + 2 * p[1:-1] + p[2:]) / 4
def fill(a):
    ok = np.isfinite(a)
    if not ok.any(): return a
    idx = np.arange(len(a)); return np.interp(idx, idx[ok], a[ok])
def frame(k):
    """トンネル k の中心線に対する、近くの車線の (車線, s の配列, 符号つきの横位置の配列, いちばん近いトンネル)。
    トンネルの長さの COVER 以上にわたって走る車線だけ（交差する車線は除く）。横位置は中心線の左が +"""
    t = TUN[k]; xy = np.asarray(t["xy"]); seg = np.diff(xy, axis=0); sl = np.hypot(*seg.T); cumL = np.r_[0, np.cumsum(sl)]; Ltot = cumL[-1]
    out = []
    for i, Pn in LP:
        if len(Pn) < 6 or Pn[:, 0].max() < xy[:, 0].min() - 16 or Pn[:, 0].min() > xy[:, 0].max() + 16 or Pn[:, 2].max() < xy[:, 1].min() - 16 or Pn[:, 2].min() > xy[:, 1].max() + 16: continue
        Q = Pn[:, [0, 2]]; d = Q[:, None, :] - xy[None, :-1, :]
        tr = (d * seg[None]).sum(2) / (sl ** 2)[None]
        tt = np.clip(tr, 0, 1)
        proj = xy[None, :-1, :] + tt[..., None] * seg[None]
        diff = Q[:, None, :] - proj
        dist = np.hypot(diff[..., 0], diff[..., 1]); j = dist.argmin(1); ar = np.arange(len(Q)); dm = dist[ar, j]
        s_ = cumL[j] + tt[ar, j] * sl[j]
        sg = np.sign(seg[j, 0] * diff[ar, j, 1] - seg[j, 1] * diff[ar, j, 0])   # 線分の向きと、線分から点への向きの外積（左 = +）
        inside = (dm < 16) & ~((j == 0) & (tr[ar, j] < 0)) & ~((j == len(sl) - 1) & (tr[ar, j] > 1))
        if inside.sum() < 6: continue
        s_ = s_[inside]; off = (sg * dm)[inside]
        if s_.max() - s_.min() < COVER * Ltot: continue
        o = np.argsort(s_); s_ = s_[o]; off = off[o]
        dn = np.stack([shapely.distance(l2, shapely.points(Q[inside][o])) for l2 in lines], 1)
        mid = (s_ > 0.2 * Ltot) & (s_ < 0.8 * Ltot)
        if mid.sum() < 6: continue
        near = int(np.bincount(dn[mid].argmin(1), minlength=len(lines)).argmax())
        if near == k and np.abs(off[mid]).max() > 14: continue
        out.append((i, s_, off, near))
    return out
FR = [frame(k) for k in range(len(TUN))]
fit = {}
for k, t in enumerate(TUN):
    Ltot = float(np.hypot(*np.diff(np.asarray(t["xy"]), axis=0).T).sum())
    sb = np.arange(0.0, Ltot + BIN * 0.5, BIN); sb[-1] = min(sb[-1], Ltot)
    def prof(lanes):
        M = np.full((len(lanes), len(sb)), np.nan)
        for r, (i, s_, off, nr) in enumerate(lanes):
            c = (sb >= s_.min() - EXT) & (sb <= s_.max() + EXT)   # 車線の端から EXT 先までは端の値を延ばす（車線が坑口の少し手前で終わる所）
            M[r, c] = np.interp(sb[c], s_, off)
        return M
    mine = [x for x in FR[k] if x[3] == k]
    if not mine: continue
    M = prof(mine)
    lo = fill(np.nanmin(np.where(np.isfinite(M), M, np.inf), 0).astype(float)); hi = fill(np.nanmax(np.where(np.isfinite(M), M, -np.inf), 0).astype(float))
    lo[~np.isfinite(lo) | (np.abs(lo) > 1e6)] = np.nan; hi[~np.isfinite(hi) | (np.abs(hi) > 1e6)] = np.nan
    lo = smooth(fill(lo)); hi = smooth(fill(hi))
    E_lo = lo - CAR_HALF - MARGIN; E_hi = hi + CAR_HALF + MARGIN
    note = ""
    for k2, l2 in enumerate(lines):
        if k2 == k or lines[k].distance(l2) >= 30: continue
        oth = [x for x in FR[k] if x[3] == k2]
        if not oth: continue
        Mo = prof(oth)
        if np.nanmedian(Mo) > 0:   # 隣は + 側
            nb = fill(np.nanmin(np.where(np.isfinite(Mo), Mo, np.inf), 0).astype(float)); nb[np.abs(nb) > 1e6] = np.nan; nb = smooth(fill(nb))
            mid = (hi + nb) / 2; E_hi = np.minimum(E_hi, mid - GAP / 2); note += f" +側は隣（{TUN[k2]['id']}）との真ん中 {mid.min():+.2f}..{mid.max():+.2f}"
        else:
            nb = fill(np.nanmax(np.where(np.isfinite(Mo), Mo, -np.inf), 0).astype(float)); nb[np.abs(nb) > 1e6] = np.nan; nb = smooth(fill(nb))
            mid = (lo + nb) / 2; E_lo = np.maximum(E_lo, mid + GAP / 2); note += f" −側は隣（{TUN[k2]['id']}）との真ん中 {mid.min():+.2f}..{mid.max():+.2f}"
    print(f"tunnel {t['id']} {t['name']} L={Ltot:.0f}: 車線 {[x[0] for x in mine]}{note}")
    for q in range(0, len(sb), max(1, len(sb) // 8)):
        print(f"    s {sb[q]:5.0f}  車線 {lo[q]:+.2f}..{hi[q]:+.2f}  → 床の縁 {E_lo[q]:+.2f}..{E_hi[q]:+.2f}  半幅 {(E_hi[q] - E_lo[q]) / 2:.2f}")
    fit[str(t["id"])] = {"s": [round(float(v), 1) for v in sb], "lo": [round(float(v), 2) for v in E_lo], "hi": [round(float(v), 2) for v in E_hi]}
json.dump(fit, open(f"{W}/tunnel_fit.json", "w"), indent=0)
print("wrote tunnel_fit.json", {k: (len(v["s"]), round(min(v["lo"]), 2), round(max(v["hi"]), 2)) for k, v in fit.items()})
