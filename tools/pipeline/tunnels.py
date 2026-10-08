"""v41.20: 道路のトンネル（線路・道路の下をくぐる道など）。

これまで: PLATEAU のトンネル区間（sectionType 6）の道路面は描かず（roads.py）、OSM のトンネルの道（tunnel=yes）は縦断を持たなかった。
          そのため入口の先に路面が無く、車は上の地面（線路・丘）の高さへ乗り上げて越えていた。トンネルの中は車線も通らなかった。
ここでは、roads.py（road_profile.py）が書き出したトンネルの床の縦断（tunnels_prof.pkl: 坑口の谷底の高さの間を直線）から、
  ・床（路面）の三角形・路面標示（外側線・中央線）
  ・壁（床の縁から天井まで・内向き）・天井（下向き）・屋根の上面（地面より低い坑口の近くだけ）・坑口の端面
  ・走行格子（2m）の床の升目（高さ・区分=1）と、壁の外側の 1m の「通れない」ビット
  ・地面（地形の格子）を下げる範囲（屋根の高さ。かぶりの浅い所だけ。深い山岳トンネルは山を削らない）
  ・道路の縁の法面・擁壁を作らない範囲
を作り、build_v5.py が読む。出力: /home/claude/wx/tunnels.pkl
"""
import os, sys, pickle, math
import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
W = "/home/claude/wx"
DRV_T = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MAJ_T = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
FLOOR_LIFT = 0.04      # 路面（他の道路面と同じ: 中心線の高さ + 0.04）
SLAB = 0.6             # 天井の厚み
MIN_LEN = 10.0
BOX_COVER = 4.4        # 地面 − 床 がこれより深い区間だけ箱（壁・天井）を作る
MIN_CLEAR = 3.9        # 天井の最低の高さ（バス・トラックが通れる）
SHALLOW = 3.0          # 屋根の上面から地面（DEM）までがこれ以下の所だけ、地面を屋根の高さへ下げる・屋根の上面を描く
WALL_BAND = 1.6        # 壁の外側の「通れない」帯

def width_of(t):
    try:
        if t.get("width"): return max(float(str(t["width"]).split(";")[0]), 3.0)
    except Exception: pass
    try: ln = int(str(t.get("lanes", "")).split(";")[0])
    except Exception: ln = None
    hw = t.get("highway", "").replace("_link", "")
    base = {"motorway": 8.0, "trunk": 7.5, "primary": 7.5, "secondary": 7.0, "tertiary": 6.5, "unclassified": 5.0, "residential": 4.8, "living_street": 4.0, "service": 4.0}.get(hw, 5.0)
    if ln: return max(3.2, min(ln * 3.2 + 0.8, 14.0)) if t.get("oneway") in ("yes", "1", "true") else max(base, ln * 3.0 + 0.8)
    return base

def _orient(T, want):
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); flip = (n * want).sum(1) < 0
    T = T.copy(); T[flip] = T[flip][:, [0, 2, 1]]
    return T

def _strip(P, Q, want):
    """曲線 P と Q（(m,3)）の間の帯の三角形（向きは want (m-1,3) の側）"""
    a = np.stack([P[:-1], Q[:-1], P[1:]], 1); b = np.stack([Q[:-1], Q[1:], P[1:]], 1)
    w = np.concatenate([want, want]) if np.ndim(want) == 2 else np.broadcast_to(np.asarray(want, float), (2 * (len(P) - 1), 3))
    return _orient(np.concatenate([a, b]), w).reshape(-1, 3)

def _dem():
    d = np.load(f"{W}/dem_grid.npz"); DX0, DZ0, DS = float(d["x0"]), float(d["z0"]), float(d["step"]); DH = d["H"].astype(np.float64)
    def at(x, z):
        fx = (np.asarray(x, float) - DX0) / DS; fz = (np.asarray(z, float) - DZ0) / DS
        i0 = np.clip(np.floor(fx).astype(int), 0, DH.shape[1] - 2); j0 = np.clip(np.floor(fz).astype(int), 0, DH.shape[0] - 2)
        tx = np.clip(fx - i0, 0, 1); tz = np.clip(fz - j0, 0, 1)
        return (DH[j0, i0] * (1 - tx) + DH[j0, i0 + 1] * tx) * (1 - tz) + (DH[j0 + 1, i0] * (1 - tx) + DH[j0 + 1, i0 + 1] * tx) * tz
    return at

def build(prof, dem_at, bx=None):
    """prof: [(id, tags, xz (n,2), z (n,))]。戻り値: トンネルのリスト"""
    out = []
    for wid, tags, xy, z in prof:
        hw_ = tags.get("highway")
        if hw_ not in DRV_T or tags.get("tunnel") != "yes": continue
        xy = np.asarray(xy, float); z = np.asarray(z, float)
        if len(xy) < 3: continue
        seg = np.hypot(*np.diff(xy, axis=0).T); L = float(seg.sum())
        if L < MIN_LEN: continue
        if bx is not None:
            cx, cz = xy.mean(0)
            if not (bx[0] < cx < bx[2] and bx[1] < cz < bx[3]): continue
        r = _one(wid, tags, xy, z, L, dem_at)
        if r is not None: out.append(r)
    return out

def _one(wid, tags, xy, z, L, dem_at):
    hw_t = tags.get("highway"); w = width_of(tags); hw = max(w / 2.0, 2.0)
    CL0 = 4.9 if hw_t in MAJ_T else 4.4
    # 上の地面（DEM。14m の幅でならす）。かぶり（地面 − 床）が深い区間だけ「箱」（壁・天井）を作る。
    # かぶりの浅い所（線路・道路の高架の下をくぐるだけで、DEM が床とほぼ同じ高さ）は、上の構造物（橋）が別にあるので、床（路面）だけ
    dem_s = np.convolve(np.pad(dem_at(xy[:, 0], xy[:, 1]), 3, mode="edge"), np.ones(7) / 7, mode="valid")
    cov = dem_s - z
    box_sec = (cov[:-1] + cov[1:]) / 2 > BOX_COVER
    # 短い切れ端（12m 未満）は箱にしない
    i = 0
    while i < len(box_sec):
        if box_sec[i]:
            j = i
            while j < len(box_sec) and box_sec[j]: j += 1
            if (j - i) * 2.0 < 12.0: box_sec[i:j] = False
            i = j
        else: i += 1
    if box_sec.sum() * 2.0 < 25.0: return None
    CL = np.clip(dem_s - SLAB - 0.15 - z, MIN_CLEAR, CL0)
    cum = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    t = np.gradient(xy, axis=0); t /= np.linalg.norm(t, axis=1)[:, None] + 1e-9
    ts = t.copy()
    for _ in range(2): ts[1:-1] = (ts[:-2] + ts[1:-1] * 2 + ts[2:]) / 4
    ts /= np.linalg.norm(ts, axis=1)[:, None] + 1e-9
    nv = np.stack([-ts[:, 1], ts[:, 0]], 1)
    yf = z + FLOOR_LIFT
    def pts(off, y): return np.stack([xy[:, 0] + nv[:, 0] * off, y, xy[:, 1] + nv[:, 1] * off], 1)
    up = np.array([0.0, 1.0, 0.0]); dn = -up
    n3 = lambda v: np.stack([v[:, 0], np.zeros(len(v)), v[:, 1]], 1)
    nvm = n3(nv)[:-1]
    floorL, floorR = pts(+hw, yf), pts(-hw, yf)
    floor = _strip(floorL, floorR, up)
    wo = hw + 0.1
    wbL, wtL = pts(+wo, z - 0.05), pts(+wo, z + CL); wbR, wtR = pts(-wo, z - 0.05), pts(-wo, z + CL)
    def sel_strip(P, Q, want, mask):
        res = [_strip(P[i:i + 2], Q[i:i + 2], want[i:i + 1] if np.ndim(want) == 2 else want) for i in np.nonzero(mask)[0]]
        return np.concatenate(res) if res else np.zeros((0, 3))
    wallL = sel_strip(wbL, wtL, -nvm, box_sec); wallR = sel_strip(wbR, wtR, +nvm, box_sec)
    ceil = sel_strip(wtL, wtR, dn, box_sec)
    # 屋根の上面・端面: 地面が屋根の上面より低い所（坑口の近く）だけ
    ytop = z + CL + SLAB
    mid = (xy[:-1] + xy[1:]) / 2; dem_mid = dem_at(mid[:, 0], mid[:, 1]); ymid = (ytop[:-1] + ytop[1:]) / 2
    exposed = (dem_mid < ymid + 0.4) & box_sec
    shallow = ((dem_mid - ymid) < SHALLOW) & box_sec
    ttL, ttR = pts(+wo, ytop), pts(-wo, ytop)
    roof = sel_strip(ttL, ttR, up, exposed)
    tf = n3(ts)
    caps = []
    for i in np.nonzero(box_sec)[0]:
        if (i == 0 or not box_sec[i - 1]) and exposed[i]: caps.append(_strip(np.stack([wtL[i], wtR[i]]), np.stack([ttL[i], ttR[i]]), -tf[i:i + 1]))
        if (i == len(box_sec) - 1 or not box_sec[i + 1]) and exposed[i]: caps.append(_strip(np.stack([wtL[i + 1], wtR[i + 1]]), np.stack([ttL[i + 1], ttR[i + 1]]), +tf[i + 1:i + 2]))
    cap = np.concatenate(caps) if caps else np.zeros((0, 3))
    white, yellow = [], []
    def line_tris(off, y, hwid, dash=None):
        a = pts(off + hwid, y + 0.005); b = pts(off - hwid, y + 0.005)
        if dash is None: return _strip(a, b, up)
        res = []; per = dash[0] + dash[1]
        for i in range(len(cum) - 1):
            s0 = cum[i]; ph = (s0 % per)
            if ph < dash[0]: res.append(_strip(a[i:i + 2], b[i:i + 2], up))
        return np.concatenate(res) if res else np.zeros((0, 3))
    if w >= 4.2:
        white.append(line_tris(+(hw - 0.4), yf, 0.075)); white.append(line_tris(-(hw - 0.4), yf, 0.075))
    oneway = tags.get("oneway") in ("yes", "1", "true")
    if w >= 5.6 and not oneway and hw_t in MAJ_T: yellow.append(line_tris(0.0, yf, 0.075))
    elif w >= 5.6: white.append(line_tris(0.0, yf, 0.075, (3.0, 5.0)))
    ln = LineString(xy)
    floor_poly = ln.buffer(hw, cap_style=2, join_style=2)
    def sec_poly(L_, R_, mask, grow=0.0):
        qs = []
        for i in np.nonzero(mask)[0]:
            q = Polygon([L_[i][[0, 2]], L_[i + 1][[0, 2]], R_[i + 1][[0, 2]], R_[i][[0, 2]]]).buffer(0)
            if not q.is_empty: qs.append(q)
        return unary_union(qs).buffer(grow) if qs else None
    band_poly = None
    bp_ = sec_poly(pts(+(hw + WALL_BAND), z), pts(-(hw + WALL_BAND), z), box_sec, 0.05)
    if bp_ is not None: band_poly = bp_.difference(sec_poly(floorL, floorR, box_sec, 0.05) or Polygon())
    roof_poly = sec_poly(ttL, ttR, shallow, 0.05)                      # 地面を屋根の高さへ下げる範囲（かぶりの浅い箱の区間）
    floor_only_poly = sec_poly(floorL, floorR, ~box_sec, 0.05)         # 箱でない区間: 地面を床の高さへ下げる範囲
    p0 = xy[0] - ts[0] * 8.0; p1 = xy[-1] + ts[-1] * 8.0
    zone = LineString(np.vstack([p0[None], xy, p1[None]])).buffer(hw + 1.5, cap_style=2, join_style=2)
    return dict(id=wid, name=tags.get("name", ""), hw=hw, L=L, xy=xy, z=z, cum=cum, line=ln, floor_poly=floor_poly, band_poly=band_poly,
                roof_poly=roof_poly, floor_only_poly=floor_only_poly, zone=zone, ytop=ytop, box_frac=float(box_sec.mean()),
                exposed_frac=float(exposed.mean()), shallow_frac=float(shallow.mean()), cov_max=float(cov.max()),
                tris=dict(floor=floor, wall=np.concatenate([wallL, wallR]), ceil=ceil, roof=roof, cap=cap,
                          white=np.concatenate(white) if white else np.zeros((0, 3)), yellow=np.concatenate(yellow) if yellow else np.zeros((0, 3))))

def raster_cells(T, poly, x0, z0, step, nx, nz, val):
    """多角形 poly の中に中心がある升目（原点 x0,z0・升目 step・nx × nz）の (行, 列, 値)。val: 'floor'（中心線に沿った床の高さ + 0.04）/
    'roof'（屋根の上面の高さ）/ 数値。値は float64"""
    if poly is None or poly.is_empty: return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0)
    bx0, bz0, bx1, bz1 = poly.bounds
    i0 = max(0, int(math.floor((bx0 - x0) / step))); i1 = min(nx - 1, int(math.floor((bx1 - x0) / step)))
    j0 = max(0, int(math.floor((bz0 - z0) / step))); j1 = min(nz - 1, int(math.floor((bz1 - z0) / step)))
    if i1 < i0 or j1 < j0: return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0)
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
    X = x0 + (ii + 0.5) * step; Z = z0 + (jj + 0.5) * step
    m = shapely.contains_xy(poly, X.ravel(), Z.ravel())
    ii = ii.ravel()[m]; jj = jj.ravel()[m]; X = X.ravel()[m]; Z = Z.ravel()[m]
    if not len(ii): return jj, ii, np.zeros(0)
    s = shapely.line_locate_point(T["line"], shapely.points(X, Z))
    if val == "floor": v = np.interp(s, T["cum"], T["z"]) + FLOOR_LIFT
    elif val == "roof": v = np.interp(s, T["cum"], T["ytop"])
    else: v = np.full(len(ii), float(val))
    return jj.astype(np.int64), ii.astype(np.int64), v

if __name__ == "__main__":
    from common import BX0, BZ0, BX1, BZ1
    prof = pickle.load(open(f"{W}/tunnels_prof.pkl", "rb"))
    dem_at = _dem()
    T = build(prof, dem_at, (BX0 + 3, BZ0 + 3, BX1 - 3, BZ1 - 3))
    for t in T:
        print(f"  tunnel {t['id']} {t['name']} L={t['L']:.0f} floor z {t['z'][0]:.2f}..{t['z'][-1]:.2f} hw={t['hw']:.1f} exposed {t['exposed_frac']:.2f} shallow {t['shallow_frac']:.2f}"
              f" tris floor {len(t['tris']['floor']) // 3} wall {len(t['tris']['wall']) // 3} roof {len(t['tris']['roof']) // 3}", flush=True)
    pickle.dump(T, open(f"{W}/tunnels.pkl", "wb"))
    print("wrote tunnels.pkl", len(T), "tunnels", flush=True)
