"""土地利用GML -> DEMグリッドと同じ4m格子のクラスラスタ /home/claude/wx/luse_grid.npz"""
import sys, os
import numpy as np
from lxml import etree
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, latlon_bbox

G = "{http://www.opengis.net/gml}"
L = "{http://www.opengis.net/citygml/landuse/2.0}"
d = np.load("/home/claude/wx/dem_grid.npz")
x0, z0, step = float(d["x0"]), float(d["z0"]), float(d["step"])
H = d["H"]; nz, nx = H.shape
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = latlon_bbox(300.0)   # v29: データ範囲（bounds.json）の 300m 外側まで

img = Image.new("I", (nx, nz), 0)
draw = ImageDraw.Draw(img)
polys = []
n = 0
import itertools
for ev, el in itertools.chain(*[etree.iterparse(f, tag=L + "LandUse", huge_tree=True) for f in ["/home/claude/wx/p25/udx/luse/513377_luse_6697_op.gml","/home/claude/wx/p25/udx/luse/523307_luse_6697_op.gml"]]):
    cls = (el.findtext(L + "class") or "0").strip()
    for poly in el.iter(G + "Polygon"):
        ext = poly.find(G + "exterior/" + G + "LinearRing/" + G + "posList")
        if ext is None: continue
        a = np.array(ext.text.split(), float).reshape(-1, 3)
        if a[:, 0].max() < LAT_MIN or a[:, 0].min() > LAT_MAX or a[:, 1].max() < LON_MIN or a[:, 1].min() > LON_MAX:
            continue
        p = proj_arr(a)
        holes = []
        for it in poly.findall(G + "interior/" + G + "LinearRing/" + G + "posList"):
            holes.append(proj_arr(np.array(it.text.split(), float).reshape(-1, 3)))
        polys.append((int(cls), p, holes))
    n += 1
    el.clear()
    while el.getprevious() is not None:
        del el.getparent()[0]
print("landuse objects", n, "polys in bbox", len(polys), flush=True)

def to_px(p):
    return [((x - x0) / step, (z - z0) / step) for x, _, z in p]

# 大きい面から先に描き、小さい面で上書き
polys.sort(key=lambda t: -abs(np.ptp(t[1][:, 0]) * np.ptp(t[1][:, 2])))
for cls, p, holes in polys:
    draw.polygon(to_px(p), fill=cls)
    for h in holes:
        draw.polygon(to_px(h), fill=0)
C = np.array(img, dtype=np.int32)
vals, cnt = np.unique(C, return_counts=True)
print(dict(zip(vals.tolist(), cnt.tolist())))
# v29: core（v28 の範囲）の中は v28 の値をそのまま使う
_CF = "/home/claude/wx/luse_grid_core.npz"
if os.path.exists(_CF) and os.path.exists("/home/claude/wx/dem_grid_core.npz"):
    _c = np.load(_CF)["C"]; _d = np.load("/home/claude/wx/dem_grid_core.npz")
    _i0 = int(round((float(_d["x0"]) - x0) / step)); _j0 = int(round((float(_d["z0"]) - z0) / step)); _nz, _nx = _c.shape
    if _i0 >= 0 and _j0 >= 0 and _j0 + _nz <= C.shape[0] and _i0 + _nx <= C.shape[1]:
        print("core paste: changed cells", int((C[_j0:_j0 + _nz, _i0:_i0 + _nx] != _c).sum()))
        C[_j0:_j0 + _nz, _i0:_i0 + _nx] = _c
np.savez("/home/claude/wx/luse_grid.npz", C=C.astype(np.int16))
