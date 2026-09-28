"""街路樹を1本ずつの属性として抽出（樹種・樹高・樹冠径・根元位置）-> /home/claude/wx/trees.pkl
形状は LOD3 メッシュではなく、実測属性から樹種別に生成する（build 側）"""
import glob, sys, os, pickle
import numpy as np
from lxml import etree
from shapely.geometry import Point
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, load_track_line, in_data
G = "{http://www.opengis.net/gml}"; V = "{http://www.opengis.net/citygml/vegetation/2.0}"
TR = load_track_line()
def f(el, tag):
    t = el.findtext(V + tag)
    try: return float(t)
    except Exception: return None
out = []
for fn in sorted(glob.glob("/home/claude/wx/p25/udx/veg/*_op.gml")):
    for ev, el in etree.iterparse(fn, tag=V + "SolitaryVegetationObject", huge_tree=True):
        pts = [np.array(p.text.split(), float).reshape(-1, 3) for p in el.iter(G + "posList")]
        if not pts:
            ps = el.find(".//" + G + "pos")
            if ps is None: el.clear(); continue
            pts = [np.array(ps.text.split(), float).reshape(-1, 3)]
        a = proj_arr(np.concatenate(pts))
        x, z = a[:, 0].mean(), a[:, 2].mean()
        if not in_data(x, z, 5.0): el.clear(); continue   # v16: データ範囲（地形のある所）だけ
        if TR.distance(Point(x, z)) > float(os.environ.get("TREE_BUF", "330")): el.clear(); continue
        low = a[a[:, 1] <= a[:, 1].min() + 0.5]
        bx, bz = (low[:, 0].mean(), low[:, 2].mean()) if len(low) else (x, z)
        mesh_h = a[:, 1].max() - a[:, 1].min()
        mesh_w = max(np.ptp(a[:, 0]), np.ptp(a[:, 2]))
        out.append(dict(x=bx, z=bz, y=a[:, 1].min(), h=f(el, "height"), cd=f(el, "crownDiameter"),
                        td=f(el, "trunkDiameter"), sp=(el.findtext(V + "species") or "").strip(),
                        cls=(el.findtext(V + "class") or "").strip(), mh=mesh_h, mw=mesh_w))
        el.clear()
pickle.dump(out, open("/home/claude/wx/trees.pkl", "wb"))
import collections
print("trees", len(out), "with attrs", sum(1 for t in out if t["h"]), collections.Counter(t["sp"] for t in out).most_common(8))
hs = np.array([t["h"] or t["mh"] for t in out]); ws = np.array([t["cd"] or t["mw"] for t in out])
print("height pct", np.percentile(hs, [10, 50, 90]).round(1), "crown pct", np.percentile(ws, [10, 50, 90]).round(1))
print("mesh width pct", np.percentile([t["mw"] for t in out], [10, 50, 90]).round(1))
