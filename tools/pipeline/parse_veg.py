"""植生GML -> /home/claude/wx/out_veg/<code>.pkl
trees_mesh: LOD3樹木メッシュ(幹/樹冠で色分け)  trees_pt: (x,y,z,height,crown) 形状なしの樹木
cover: 植栽(PlantCover)面
"""
import sys, os, glob, pickle
import numpy as np
from lxml import etree
from shapely.geometry import Point
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, triangulate, strip_closing, load_track_line, in_data

G = "{http://www.opengis.net/gml}"
V = "{http://www.opengis.net/citygml/vegetation/2.0}"
BUF = float(os.environ.get("VEG_BUF", "320"))
TRACK = load_track_line()

def pl(txt):
    return strip_closing(proj_arr(np.array(txt.split(), dtype=np.float64).reshape(-1, 3)))

def fnum(el, tag):
    t = el.findtext(V + tag)
    try: return float(t)
    except Exception: return None

def tris_of(el):
    out = []
    for poly in el.iter(G + "Polygon"):
        ext = poly.find(G + "exterior/" + G + "LinearRing/" + G + "posList")
        if ext is None: continue
        rings = [pl(ext.text)] + [pl(i.text) for i in poly.findall(G + "interior/" + G + "LinearRing/" + G + "posList")]
        if len(rings[0]) < 3: continue
        v, idx = triangulate(rings)
        if v is None: continue
        out.append(v[idx.reshape(-1)])
    return np.concatenate(out) if out else None

def process(path):
    code = os.path.basename(path).split("_")[0]
    mesh_crown, mesh_trunk, pts, cover = [], [], [], []
    for ev, el in etree.iterparse(path, events=("end",), huge_tree=True,
                                  tag=[V + "SolitaryVegetationObject", V + "PlantCover"]):
        tag = el.tag.split("}")[1]
        first = el.find(".//" + G + "posList")
        if first is None:
            first_pos = el.find(".//" + G + "pos")
            if first_pos is None:
                el.clear(); continue
            p = proj_arr(np.array(first_pos.text.split(), float).reshape(-1, 3))
        else:
            p = pl(first.text)
        cx, cz = p[:, 0].mean(), p[:, 2].mean()
        if not in_data(cx, cz, 5.0): el.clear(); continue   # v16: データ範囲だけ
        if TRACK.distance(Point(cx, cz)) > BUF:
            el.clear(); continue
        if tag == "SolitaryVegetationObject":
            h = fnum(el, "height") or 6.0
            cd = fnum(el, "crownDiameter") or max(2.0, h * 0.45)
            geo = el.find(V + "lod3Geometry")
            tri = tris_of(geo) if geo is not None else None
            if tri is not None and len(tri) >= 9:
                base = tri[:, 1].min(); top = tri[:, 1].max()
                t = tri.reshape(-1, 3, 3)
                mx = t[:, :, 1].max(axis=1)
                # 樹冠の下端より下にある細い面は幹とみなす
                crown_bottom = base + (top - base) * 0.38
                trunk = mx < crown_bottom
                if trunk.any(): mesh_trunk.append(t[trunk].reshape(-1, 3))
                if (~trunk).any(): mesh_crown.append(t[~trunk].reshape(-1, 3))
            else:
                lod0 = el.find(".//" + G + "pos")
                if lod0 is not None:
                    q = proj_arr(np.array(lod0.text.split(), float).reshape(-1, 3))[0]
                else:
                    q = np.array([cx, p[:, 1].min(), cz])
                pts.append((q[0], q[1], q[2], h, cd))
        else:
            geo = el.find(V + "lod3MultiSurface")
            if geo is None:
                geo = el.find(V + "lod1MultiSurface")
            if geo is not None:
                tri = tris_of(geo)
                if tri is not None:
                    t = tri.reshape(-1, 3, 3)
                    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
                    t = t[nrm[:, 1] > -1e-6 * 0 - 0.2 * np.linalg.norm(nrm, axis=1)]
                    cover.append(t.reshape(-1, 3))
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
    cat = lambda L: np.concatenate(L).astype(np.float32) if L else np.zeros((0, 3), np.float32)
    out = dict(crown=cat(mesh_crown), trunk=cat(mesh_trunk), cover=cat(cover),
               pts=np.array(pts, np.float32).reshape(-1, 5))
    os.makedirs("/home/claude/wx/out_veg", exist_ok=True)
    pickle.dump(out, open(f"/home/claude/wx/out_veg/{code}.pkl", "wb"))
    return code, {k: len(v) for k, v in out.items()}

if __name__ == "__main__":
    from multiprocessing import Pool
    files = sys.argv[1:] or sorted(glob.glob("/home/claude/wx/p25/udx/veg/*_op.gml"))
    with Pool(int(os.environ.get("NPROC", "2"))) as p:
        for code, st in p.imap_unordered(process, files):
            print(code, st, flush=True)
