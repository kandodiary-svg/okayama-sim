"""v48: PLATEAU の街路樹データに無い木（西川緑道公園・駅前広場・公園など）を、航空写真（国土地理院 シームレス空中写真 z18）の緑から推定して足す。
- 範囲: 路面電車の沿線（x -300〜2200, z -520〜1820。駅前・桃太郎大通り・西川・城下・県庁通り・東山・清輝橋）
- 木の画素: 緑の強さ ExG = 2G−R−B > 0.06 かつ 明るさ < 0.50（芝生・人工芝は明るく平らなので、さらに 3m 四方の明るさのばらつき > 0.025 の所だけ）
- 除く所: 建物（PLATEAU の屋根の平面形 + 1m）、線路の中心から 3m、既にある PLATEAU の木の樹冠（半径 + 1.5m）
- 木の位置: 木の画素の塊の中で、縁からの距離（距離変換）の極大を 5m 以上離して選ぶ。樹冠の半径 = その距離（1.6〜5m）、樹高 = 2.3×半径 + 2（4〜14m）
- 出力: /home/claude/wx/trees_aerial.json  [[x, z, 樹高, 樹冠径], ...]（trees_rt.py が読んで区分 9 = 航空写真から推定、として足す）
推定なので、樹種・樹高は分からない（一般の広葉樹の形）。屋上緑化・芝生の取り違えが少し残る可能性がある。
"""
import math, os, glob, pickle, json, urllib.request, sys
import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LAT0, LON0, KX, KZ
X0, Z0, X1, Z1, PPM, ZM = -300.0, -520.0, 2200.0, 1820.0, 2.0, 18
CACHE = "/home/claude/wx/aer18"; os.makedirs(CACHE, exist_ok=True)
W, H = int((X1 - X0) * PPM), int((Z1 - Z0) * PPM)
xs = X0 + (np.arange(W) + 0.5) / PPM; zs = Z0 + (np.arange(H) + 0.5) / PPM
n = 2 ** ZM
def tile(tx, ty):
    p = f"{CACHE}/{tx}_{ty}.jpg"
    if not os.path.exists(p):
        urllib.request.urlretrieve(f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{ZM}/{tx}/{ty}.jpg", p)
    return np.asarray(Image.open(p).convert("RGB"))
img = np.zeros((H, W, 3), np.uint8)
for j0 in range(0, H, 512):
    zz = zs[j0:j0 + 512]
    X, Z = np.meshgrid(xs, zz)
    LA = LAT0 - Z / KZ; LO = LON0 + X / KX
    TX = (LO + 180) / 360 * n; TY = (1 - np.log(np.tan(np.radians(LA)) + 1 / np.cos(np.radians(LA))) / np.pi) / 2 * n
    ix, iy = np.floor(TX).astype(int), np.floor(TY).astype(int)
    blk = np.zeros((len(zz), W, 3), np.uint8)
    for a in np.unique(ix):
        for b in np.unique(iy):
            m = (ix == a) & (iy == b)
            if not m.any(): continue
            t = tile(a, b)
            blk[m] = t[np.clip(((TY[m] - b) * 256).astype(int), 0, 255), np.clip(((TX[m] - a) * 256).astype(int), 0, 255)]
    img[j0:j0 + 512] = blk
print("aerial", W, H, flush=True)
f = img.astype(np.float32) / 255; r, g, b = f[..., 0], f[..., 1], f[..., 2]
exg = 2 * g - r - b; lum = (r + g + b) / 3
var = ndimage.uniform_filter(lum ** 2, 6) - ndimage.uniform_filter(lum, 6) ** 2
tree = (exg > 0.06) & (lum < 0.50) & (np.sqrt(np.maximum(var, 0)) > 0.025)
tree = ndimage.binary_opening(tree, iterations=1); tree = ndimage.binary_closing(tree, iterations=2)
# 建物の平面形
bm = Image.new("L", (W, H), 0)
from PIL import ImageDraw
dr = ImageDraw.Draw(bm)
for fn in sorted(glob.glob("/home/claude/wx/out_bldg/*.pkl")):
    d = pickle.load(open(fn, "rb"))
    for it in d["plain"] + d.get("proc", []):
        tris = np.asarray(it[0], np.float64).reshape(-1, 3, 3)
        if tris[:, :, 0].max() < X0 or tris[:, :, 0].min() > X1 or tris[:, :, 2].max() < Z0 or tris[:, :, 2].min() > Z1: continue
        nn = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]); flat = np.abs(nn[:, 1]) / (np.linalg.norm(nn, axis=1) + 1e-12) > 0.35
        for t in tris[flat]:
            dr.polygon([((p[0] - X0) * PPM, (p[2] - Z0) * PPM) for p in t], fill=255)
bmask = ndimage.binary_dilation(np.asarray(bm) > 0, iterations=2)
tree &= ~bmask
# 線路
Tk = pickle.load(open("/home/claude/wx/tracks.pkl", "rb"))
trk = unary_union([LineString(t["xyz"][:, [0, 2]]) for t in Tk["tracks"]]).buffer(3.0)
tm = Image.new("L", (W, H), 0); dt = ImageDraw.Draw(tm)
for gm in (trk.geoms if hasattr(trk, "geoms") else [trk]):
    dt.polygon([((x - X0) * PPM, (z - Z0) * PPM) for x, z in gm.exterior.coords], fill=255)
tree &= ~(np.asarray(tm) > 0)
# 既にある PLATEAU の木
TR = pickle.load(open("/home/claude/wx/trees.pkl", "rb"))
pm = Image.new("L", (W, H), 0); dp = ImageDraw.Draw(pm)
for t in TR:
    x, z = float(t["x"]), float(t["z"])
    if not (X0 < x < X1 and Z0 < z < Z1): continue
    cd = t["cd"] if t["cd"] and t["cd"] > 0 else 3.0
    rr = (cd / 2 + 1.5) * PPM
    dp.ellipse(((x - X0) * PPM - rr, (z - Z0) * PPM - rr, (x - X0) * PPM + rr, (z - Z0) * PPM + rr), fill=255)
tree &= ~(np.asarray(pm) > 0)
lab, nl = ndimage.label(tree)
sizes = ndimage.sum(tree, lab, range(1, nl + 1))
keep = np.zeros(nl + 1, bool); keep[1:] = sizes >= 12 * PPM * PPM   # 12 m² 以上の塊
tree = keep[lab]
dist = ndimage.distance_transform_edt(tree) / PPM
# 極大（5m 以上離す）
mx = ndimage.maximum_filter(dist, size=int(5 * PPM)) == dist
cand = np.argwhere(mx & (dist >= 1.2))
cand = sorted(cand.tolist(), key=lambda p: -dist[p[0], p[1]])
out, taken = [], []
from scipy.spatial import cKDTree
for (j, i) in cand:
    x, z = X0 + (i + 0.5) / PPM, Z0 + (j + 0.5) / PPM; R = float(np.clip(dist[j, i] + 0.6, 1.6, 5.0))
    if taken:
        kd = cKDTree(np.array([[a, b_] for a, b_, _ in taken]))
        d_, k_ = kd.query([x, z])
        if d_ < max(4.5, 0.8 * (R + taken[k_][2])): continue
    taken.append((x, z, R))
    h = float(np.clip(2.3 * R + 2.0, 4.0, 14.0))
    out.append([round(x, 1), round(z, 1), round(h, 1), round(2 * R, 1)])
json.dump(out, open("/home/claude/wx/trees_aerial.json", "w"))
Image.fromarray((np.clip(f * 0.6 + np.stack([np.zeros_like(lum), tree * 0.4, np.zeros_like(lum)], -1), 0, 1) * 255).astype(np.uint8)).resize((W // 2, H // 2)).save("/home/claude/wx/trees_aerial_chk.jpg")
print("aerial trees", len(out))
