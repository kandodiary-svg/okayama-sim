"""v29: PLATEAU の道路面が無い所（OSM の車道があるのに、道路面のラスタが無い所）を数える。
使い方: python3 gap_check.py [roads.pkl] [出力PNG]"""
import sys, os, pickle, math
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from osm_load import load as osm_load
from common import CORE, BX0, BZ0, BX1, BZ1
fn = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/wx/roads_final.pkl"
from common import load_roads
R = load_roads(fn, "r"); HR = R["HR"]; GX0, GZ0, RES = R["grid"]
fin = np.isfinite(HR)
from scipy import ndimage
near = ndimage.binary_dilation(fin, iterations=6)   # 3m 以内に道路面
ways, nodes = osm_load()
DRV = {"trunk": 1, "primary": 1, "secondary": 1, "tertiary": 1, "unclassified": 2, "residential": 2, "trunk_link": 1, "primary_link": 1,
       "secondary_link": 1, "tertiary_link": 1, "living_street": 2}
tot = {1: 0.0, 2: 0.0}; miss = {1: 0.0, 2: 0.0}; pts_miss = []
for w in ways:
    c = DRV.get(w["tags"].get("highway"))
    if not c or w["tags"].get("area") == "yes": continue
    if w["tags"].get("tunnel") in ("yes",) : continue
    xy = np.asarray(w["xy"], float)
    for a, b in zip(xy[:-1], xy[1:]):
        L = float(np.hypot(*(b - a))); n = max(1, int(L // 4))
        for k in range(n):
            p = a + (b - a) * (k + 0.5) / n
            if not (BX0 + 20 < p[0] < BX1 - 20 and BZ0 + 20 < p[1] < BZ1 - 20): continue
            incore = CORE[0] < p[0] < CORE[2] and CORE[1] < p[1] < CORE[3]
            if incore: continue
            tot[c] += L / n
            i = int((p[0] - GX0) / RES); j = int((p[1] - GZ0) / RES)
            if not near[j, i]:
                miss[c] += L / n; pts_miss.append((p[0], p[1], c))
print("outside core: major roads km", round(tot[1] / 1e3, 1), "missing km", round(miss[1] / 1e3, 2),
      "| minor roads km", round(tot[2] / 1e3, 1), "missing km", round(miss[2] / 1e3, 2))
P = np.array(pts_miss) if pts_miss else np.zeros((0, 3))
if len(P):
    # 1km 升目ごとの欠け
    import collections
    cnt = collections.Counter((int(math.floor(x / 1000)), int(math.floor(z / 1000)), int(c)) for x, z, c in P)
    for k, v in sorted(cnt.items(), key=lambda t: -t[1])[:25]: print("  cell", k[:2], "class", k[2], "missing m ~", v * 4)
if len(sys.argv) > 2:
    from PIL import Image, ImageDraw
    s = 0.25
    im = Image.new("RGB", (int((BX1 - BX0) * s), int((BZ1 - BZ0) * s)), (255, 255, 255))
    sub = fin[::8, ::8]
    a = np.where(sub, 170, 255).astype(np.uint8)
    im.paste(Image.fromarray(np.stack([a, a, a], -1)).resize(im.size), (0, 0))
    d = ImageDraw.Draw(im)
    for x, z, c in P:
        u = (x - BX0) * s; v = (z - BZ0) * s
        d.ellipse([u - 1.5, v - 1.5, u + 1.5, v + 1.5], fill=(220, 30, 30) if c == 1 else (240, 150, 0))
    cx0, cz0, cx1, cz1 = [(CORE[0] - BX0) * s, (CORE[1] - BZ0) * s, (CORE[2] - BX0) * s, (CORE[3] - BZ0) * s]
    d.rectangle([cx0, cz0, cx1, cz1], outline=(0, 0, 255), width=2)
    im.save(sys.argv[2])
