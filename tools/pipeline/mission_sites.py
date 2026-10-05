"""v41.8: 配達ミッション用の地点データ（data/missions.json）を作る。

実在の配送センター・駐車場の位置データはこのプロジェクトに無い（OSM は道路・鉄道・ランドマークのみ）ので、
PLATEAU の土地利用・建物（走行格子の建物ビット）・道路網から「それらしい場所」を検出して作る。実在の施設ではない。
  ・配達先（drop）  : 住宅地の細い道（OSM の residential / unclassified の車線）の路上で、
                      「路地」= 道幅 5.8m 以下で両側 3m 以内に建物 ／ 「家の前」= 住宅用地で片側 0.8〜7m に建物
                      （道幅 3.4m 以上＝2t トラックが入れる。交差点から 14m 以上離す。本線につながった道だけ）
  ・配送センター（depot）: 商業・工業・交通用地の、建物・道路の無い平らな空き地（半径 14m 以上）で、道路から 22m 以内。
                      空き地の奥に倉庫を置き、手前に積み込み場所（dock）を取る。門（gate）は最寄りの車線上の点
  ・駐車場（park）   : 住宅・商業・工業・交通・その他の空地用地の、半径 5.5m 以上の空き地で、道路から 25m 以内。出発地点
  ・広場（heli）     : 半径 13m 以上の平らな空き地（ヘリの着陸先）
  町名は places.json の町丁（242 か所）で付ける。
出力: /home/claude/okaden-x/data/missions.json
"""
import os, sys, json, math, zlib, base64, time, random
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))

OUT = os.environ.get("OUT_DIR", "/home/claude/okaden-x/data")
t00 = time.time()
def log(*a): print(f"[{time.time() - t00:6.1f}s]", *a, flush=True)
rng = np.random.default_rng(418)

# ---------- 走行格子（高さ・種類・建物ビット）----------
sc = json.load(open(f"{OUT}/scene.json")); dm = sc["drive"]
import geo_io; raw = geo_io.read_legacy("drive")
nx, nz = dm["nx"], dm["nz"]; n_ = nx * nz
DH = np.frombuffer(raw[:n_ * 2], np.int16).reshape(nz, nx) / 100.0
DK = np.frombuffer(raw[n_ * 2:n_ * 3], np.uint8).reshape(nz, nx)
B = np.frombuffer(raw[n_ * 3:n_ * 3 + dm["brow"] * dm["bnz"]], np.uint8).reshape(dm["bnz"], dm["brow"])
BB = np.unpackbits(B, axis=1)[:, :dm["bnx"]]       # 1m の建物ビット（左端が最上位）
X0, Z0 = dm["x0"], dm["z0"]
log("drive", nx, nz, "building bits", BB.shape, int(BB.sum()))
def blocked(x, z):
    i = np.floor((np.asarray(x) - X0) / dm["bstep"]).astype(np.int64); j = np.floor((np.asarray(z) - Z0) / dm["bstep"]).astype(np.int64)
    ok = (i >= 0) & (i < BB.shape[1]) & (j >= 0) & (j < BB.shape[0]); r = np.ones(np.shape(x), bool); r[ok] = BB[j[ok], i[ok]] == 1; return r
# 土地利用（4m 格子・DEM と同じ原点）
LU = np.load("/home/claude/wx/luse_grid.npz")["C"]; dem = np.load("/home/claude/wx/dem_grid.npz"); LX0, LZ0, LST = float(dem["x0"]), float(dem["z0"]), float(dem["step"])
def luse(x, z):
    i = np.floor((np.asarray(x) - LX0) / LST).astype(np.int64); j = np.floor((np.asarray(z) - LZ0) / LST).astype(np.int64)
    ok = (i >= 0) & (i < LU.shape[1]) & (j >= 0) & (j < LU.shape[0]); r = np.zeros(np.shape(x), np.int16); r[ok] = LU[j[ok], i[ok]]; return r
from common import load_roads
R = load_roads("/home/claude/wx/roads_final.pkl", "r"); KIND = R["KIND"]; GX0, GZ0, RES = R["grid"]; del R["tris"]
def kind(x, z):
    i = ((np.asarray(x) - GX0) / RES).astype(np.int64); j = ((np.asarray(z) - GZ0) / RES).astype(np.int64)
    ok = (i >= 0) & (i < KIND.shape[1]) & (j >= 0) & (j < KIND.shape[0]); r = np.zeros(np.shape(x), np.uint8); r[ok] = KIND[j[ok], i[ok]]; return r
log("road grid", KIND.shape)

# ---------- 車線 ----------
T = json.load(open(f"{OUT}/traffic.json"))
rawp = zlib.decompress(base64.b64decode(open(f"{OUT}/traffic_pts.txt").read().strip())); N = T["pts"]["n"]; bb = np.frombuffer(rawp, np.uint8)
A = np.zeros((N, 3), np.int64)
for c in range(3):
    o = c * 4 * N
    A[:, c] = (bb[o:o + N].astype(np.uint32) | (bb[o + N:o + 2 * N].astype(np.uint32) << 8) | (bb[o + 2 * N:o + 3 * N].astype(np.uint32) << 16) | (bb[o + 3 * N:o + 4 * N].astype(np.uint32) << 24)).view(np.int32).astype(np.int64)
for L in (T["lanes"], T["conns"]):
    for e in L: A[e["o"]:e["o"] + e["m"]] = np.cumsum(A[e["o"]:e["o"] + e["m"]], axis=0)
A = A / 100.0
lanes = T["lanes"]; conns = T["conns"]
LP = [A[e["o"]:e["o"] + e["m"]] for e in lanes]
# 本線につながった車線（最大の連結成分）
par = list(range(len(lanes)))
def find(a):
    while par[a] != a: par[a] = par[par[a]]; a = par[a]
    return a
for c in conns:
    ra, rb = find(c["a"]), find(c["b"])
    if ra != rb: par[ra] = rb
roots = np.array([find(i) for i in range(len(lanes))]); main_root = np.bincount(roots).argmax(); MAIN = roots == main_root
log("lanes", len(lanes), "in main network", int(MAIN.sum()))

# ---------- 町名 ----------
import shapely
from shapely.geometry import Polygon, Point
from shapely.strtree import STRtree
pl = json.load(open(f"{OUT}/places.json")); TOWNS = []; tpoly = []
for t in pl["towns"]:
    rings = t["r"]
    try:
        pg = Polygon(rings[0], rings[1:]) if len(rings) > 1 else Polygon(rings[0])
        if not pg.is_valid: pg = pg.buffer(0)
    except Exception: continue
    TOWNS.append(t["name"]); tpoly.append(pg)
ttree = STRtree(tpoly)
def town_of(x, z):
    h = ttree.query(Point(x, z), predicate="within")
    if len(h): return int(h[0])
    k = ttree.nearest(Point(x, z)); return int(k) if k is not None else -1
log("towns", len(TOWNS))

# ---------- 配達先: 路地・家の前 ----------
S_STEP = 9.0; END = 14.0
pos = []; nrm = []; tan = []; lid = []; ys = []
for i, e in enumerate(lanes):
    if e["c"] not in ("r", "u") or not MAIN[i]: continue
    p = LP[i]
    if len(p) < 4: continue
    c = np.r_[0, np.cumsum(np.hypot(*np.diff(p[:, [0, 2]], axis=0).T))]; Ln = c[-1]
    if Ln < 2 * END + 6: continue
    ss = np.arange(END, Ln - END + 1e-6, S_STEP)
    x = np.interp(ss, c, p[:, 0]); z = np.interp(ss, c, p[:, 2]); y = np.interp(ss, c, p[:, 1])
    dx = np.interp(ss + 2, c, p[:, 0]) - np.interp(ss - 2, c, p[:, 0]); dz = np.interp(ss + 2, c, p[:, 2]) - np.interp(ss - 2, c, p[:, 2]); l_ = np.hypot(dx, dz) + 1e-9
    tx, tz = dx / l_, dz / l_
    pos.append(np.stack([x, z], 1)); tan.append(np.stack([tx, tz], 1)); lid.append(np.full(len(ss), i)); ys.append(y)
pos = np.concatenate(pos); tan = np.concatenate(tan); lid = np.concatenate(lid); ys = np.concatenate(ys)
nl = np.stack([tan[:, 1], -tan[:, 0]], 1)     # 進行方向の「左」（x 東・z 南）
log("delivery candidates (raw)", len(pos))
def scan_side(sign):
    """道の端までの距離（道路の外へ出た所）と、その外側で最初に建物のある所までの距離"""
    edge = np.full(len(pos), 20.0); bld = np.full(len(pos), 99.0); gone = np.zeros(len(pos), bool); gap = np.zeros(len(pos), int)
    for k in range(1, 41):
        d = 0.5 * k; q = pos + nl * sign * d
        isroad = kind(q[:, 0], q[:, 1]) == 1
        # 道路の外へ出た最初の所を端とする（1 マス分の欠けは許す）
        newgap = ~isroad & ~gone; gap = np.where(newgap, gap + 1, 0); out = newgap & (gap >= 2) & (edge >= 20.0)
        edge = np.where(out, d - 1.0, edge); gone |= out
        hit = blocked(q[:, 0], q[:, 1]) & (bld >= 99.0); bld = np.where(hit, d, bld)
    return edge, bld
eL, bL = scan_side(+1); eR, bR = scan_side(-1)
roadW = eL + eR
here_blocked = blocked(pos[:, 0], pos[:, 1]); here_road = kind(pos[:, 0], pos[:, 1]) == 1
lu = luse(pos[:, 0], pos[:, 1])
def gapL(e, b): return b - e
alley = (roadW >= 3.4) & (roadW <= 5.8) & (bL - eL <= 3.0) & (bR - eR <= 3.0) & here_road & ~here_blocked
houseL = (gapL(eL, bL) >= 0.8) & (gapL(eL, bL) <= 7.0); houseR = (gapL(eR, bR) >= 0.8) & (gapL(eR, bR) <= 7.0)
house = (roadW >= 3.4) & (roadW <= 7.5) & (houseL | houseR) & (lu == 211) & here_road & ~here_blocked & ~alley
log("alley", int(alley.sum()), "house", int(house.sum()))
# 間引き（35m 間隔）してから種類ごとに数を絞る
def thin(idx, cell=35.0, cap=3500):
    idx = np.array(idx); rng.shuffle(idx); seen = set(); keep = []
    for k in idx:
        key = (int(pos[k, 0] // cell), int(pos[k, 1] // cell))
        if key in seen: continue
        seen.add(key); keep.append(k)
        if len(keep) >= cap: break
    return keep
ka = thin(np.nonzero(alley)[0], 35.0, 2500); kh = thin(np.nonzero(house)[0], 35.0, 4000)
DROP = []
for typ, ks in ((0, ka), (1, kh)):
    for k in ks:
        side = 1 if (typ == 1 and houseL[k] and not houseR[k]) or (typ == 0 and bL[k] <= bR[k]) else -1       # 建物のある側（左 = +1）
        yaw = math.degrees(math.atan2(tan[k, 0], tan[k, 1]))
        DROP.append([round(float(pos[k, 0]), 1), round(float(pos[k, 1]), 1), round(yaw, 1), typ, town_of(pos[k, 0], pos[k, 1]), int(round(roadW[k] * 10)), side, round(float(ys[k]), 2)])
log("drop points", len(DROP), "alley", len(ka), "house", len(kh))

# ---------- 空き地（配送センター・駐車場・広場）----------
Lu2 = np.repeat(np.repeat(LU, 2, axis=0), 2, axis=1)[:nz, :nx]
B2 = BB[:nz * 2:2, :nx * 2:2].astype(bool) | BB[1:nz * 2:2, :nx * 2:2].astype(bool) | BB[:nz * 2:2, 1:nx * 2:2].astype(bool) | BB[1:nz * 2:2, 1:nx * 2:2].astype(bool)
gy, gx = np.gradient(ndimage.uniform_filter(DH, 3), 2.0); slope = np.hypot(gx, gy)
base = (DK == 0) & ~B2 & (slope < 0.10) & (Lu2 != 204) & (Lu2 != 0)
base = ndimage.binary_opening(base, iterations=1)
# 線路（JR・路面電車）の 26m 以内は空き地に数えない（駅の構内・線路わきの空き地に施設を置かない）
rail = np.zeros((nz, nx), bool)
_jr = json.load(open(f"{OUT}/jr.json"))
for _l in _jr["lines"]:
    _p = np.asarray(_l["p"], float).reshape(-1, 3)
    _i = np.floor((_p[:, 0] - X0) / dm["step"]).astype(int); _j = np.floor((_p[:, 2] - Z0) / dm["step"]).astype(int); _ok = (_i >= 0) & (_i < nx) & (_j >= 0) & (_j < nz); rail[_j[_ok], _i[_ok]] = True
_rt = json.load(open(f"{OUT}/routes.json"))
for _k in ("higashi", "seiki", "higashi_r", "seiki_r"):
    _p = np.asarray(_rt[_k]["track"], float); _i = np.floor((_p[:, 0] - X0) / dm["step"]).astype(int); _j = np.floor((_p[:, 2] - Z0) / dm["step"]).astype(int); _ok = (_i >= 0) & (_i < nx) & (_j >= 0) & (_j < nz); rail[_j[_ok], _i[_ok]] = True
base &= ~ndimage.binary_dilation(rail, iterations=13)
log("rail cells", int(rail.sum()))
def dt_for(codes):
    free = base & np.isin(Lu2, codes); return ndimage.distance_transform_edt(free) * 2.0, free
# 近い車線の点（門）
RP = []; RL = []
for i, e in enumerate(lanes):
    if e["c"] not in ("r", "u", "t", "s") or not MAIN[i]: continue
    p = LP[i]; c = np.r_[0, np.cumsum(np.hypot(*np.diff(p[:, [0, 2]], axis=0).T))]
    if c[-1] < 16: continue
    ss = np.arange(8, c[-1] - 8 + 1e-6, 3.0)
    RP.append(np.stack([np.interp(ss, c, p[:, 0]), np.interp(ss, c, p[:, 2])], 1)); RL.append(np.full(len(ss), i))
RP = np.concatenate(RP); RL = np.concatenate(RL); rtree = cKDTree(RP)
def to_xz(j, i): return X0 + (i + 0.5) * dm["step"], Z0 + (j + 0.5) * dm["step"]
def local_max(dtm, thr, size):
    mx = ndimage.maximum_filter(dtm, size=size); cand = np.argwhere((dtm >= thr) & (dtm == mx)); return cand
def line_free(a, b, free_or_road):
    n = int(np.hypot(*(b - a)) / 1.0) + 2; t = np.linspace(0, 1, n)[:, None]; q = a + (b - a) * t
    i = np.floor((q[:, 0] - X0) / dm["step"]).astype(int); j = np.floor((q[:, 1] - Z0) / dm["step"]).astype(int)
    if i.min() < 0 or j.min() < 0 or i.max() >= nx or j.max() >= nz: return False
    return bool(np.all(free_or_road[j, i]))
# 道路・路肩も通れる印（門から空き地までの通り道）
passable = base | (DK == 1)
def sites(codes, thr, gate_max, thin_cell, cap, need_gate=True, label=""):
    dtm, free = dt_for(codes); cand = local_max(dtm, thr, 15); log(label, "local maxima", len(cand))
    out = []; order = rng.permutation(len(cand))
    seen = set()
    for q in order:
        j, i = cand[q]; x, z = to_xz(j, i); r = float(dtm[j, i])
        key = (int(x // thin_cell), int(z // thin_cell))
        if key in seen: continue
        if not need_gate:
            seen.add(key); out.append(dict(x=x, z=z, r=r));
            if len(out) >= cap: break
            continue
        d, k = rtree.query([x, z]);
        if d - r > gate_max: continue
        g = RP[k]; u = np.array([x - g[0], z - g[1]]); ul = np.linalg.norm(u)
        if ul < 1e-6: continue
        u /= ul
        if not line_free(g, np.array([x, z]), passable): continue
        seen.add(key); out.append(dict(x=x, z=z, r=r, gx=float(g[0]), gz=float(g[1]), ux=float(u[0]), uz=float(u[1]), lane=int(RL[k])))
        if len(out) >= cap: break
    return out, free
def rect_free(c, ux, uz, w, d, free, step=2.0):
    """中心 c・奥行き方向 (ux,uz)・幅 w・奥行き d の長方形がすべて空き地か"""
    nx_ = int(w / step) + 1; nd = int(d / step) + 1
    a = np.linspace(-w / 2, w / 2, nx_); b = np.linspace(-d / 2, d / 2, nd)
    A_, B_ = np.meshgrid(a, b)
    x = c[0] + A_ * (-uz) + B_ * ux; z = c[1] + A_ * ux + B_ * uz
    i = np.floor((x - X0) / dm["step"]).astype(int); j = np.floor((z - Z0) / dm["step"]).astype(int)
    if i.min() < 0 or j.min() < 0 or i.max() >= nx or j.max() >= nz: return False
    return bool(np.all(free[j, i]))
# 配送センター
dep_raw, dfree = sites([212, 213], 14.0, 22.0, 150.0, 300, label="depot")
DEPOT = []
for s in dep_raw:
    c = np.array([s["x"], s["z"]]); u = np.array([s["ux"], s["uz"]]); done = None
    for k in np.arange(min(s["r"], 24.0) - 3.0, 3.0, -1.0):
        bc = c + u * k                      # 倉庫の中心
        if not rect_free(bc, u[0], u[1], 16.0, 8.0, dfree): continue
        dock = bc - u * 11.0                # 倉庫の手前 11m（積み込み場所）
        if not (rect_free(dock, u[0], u[1], 8.0, 8.0, dfree) or rect_free(dock, u[0], u[1], 8.0, 8.0, passable)): continue
        done = (bc, dock); break
    if not done: continue
    bc, dock = done
    DEPOT.append([round(float(bc[0]), 1), round(float(bc[1]), 1), round(float(u[0]), 3), round(float(u[1]), 3), round(float(dock[0]), 1), round(float(dock[1]), 1),
                  round(s["gx"], 1), round(s["gz"], 1), town_of(s["x"], s["z"]), s["lane"], round(float(DH[int((s["z"] - Z0) // dm["step"]), int((s["x"] - X0) // dm["step"])]), 2)])
log("depots", len(DEPOT))
# 駐車場
par_raw, pfree = sites([211, 212, 213, 216, 218], 5.5, 25.0, 60.0, 4000, label="parking")
PARK = []
for s in par_raw:
    yaw = math.degrees(math.atan2(-s["ux"], -s["uz"]))    # 門（道路）の方を向く
    PARK.append([round(s["x"], 1), round(s["z"], 1), round(yaw, 1), round(s["gx"], 1), round(s["gz"], 1), town_of(s["x"], s["z"]), round(min(s["r"], 14.0), 1), s["lane"],
                 round(float(DH[int((s["z"] - Z0) // dm["step"]), int((s["x"] - X0) // dm["step"])]), 2)])
log("parking", len(PARK))
# 広場（ヘリの着陸先）
hel_raw, hfree = sites([211, 212, 213, 214, 216, 217, 218], 13.0, 0, 120.0, 900, need_gate=False, label="heli")
HELI = [[round(s["x"], 1), round(s["z"], 1), round(min(s["r"], 30.0), 1), town_of(s["x"], s["z"]), round(float(DH[int((s["z"] - Z0) // dm["step"]), int((s["x"] - X0) // dm["step"])]), 2)] for s in hel_raw]
log("heli sites", len(HELI))

J = dict(note="PLATEAU の土地利用・建物・道路網から検出した「それらしい場所」。実在の配送センター・駐車場ではない（tools/pipeline/mission_sites.py）",
         towns=TOWNS,
         drop_cols=["x", "z", "yaw", "type(0路地,1家の前)", "town", "roadW*10", "side(建物のある側 左=1)", "y"], drop=DROP,
         depot_cols=["bx", "bz", "ux", "uz", "dockx", "dockz", "gx", "gz", "town", "lane", "y"], depot=DEPOT,
         park_cols=["x", "z", "yaw(門の方)", "gx", "gz", "town", "r", "lane", "y"], park=PARK,
         heli_cols=["x", "z", "r", "town", "y"], heli=HELI)
json.dump(J, open(f"{OUT}/missions.json", "w"), ensure_ascii=False, separators=(",", ":"))
log("wrote", os.path.getsize(f"{OUT}/missions.json") / 1e3, "KB")
