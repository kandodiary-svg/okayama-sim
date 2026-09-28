"""道路GML(LOD1/LOD3) -> 用途別三角形 /home/claude/wx/out_tran/<code>.pkl
cat: 'lane'(車道部) 'xing'(車道交差部) 'walk'(歩道部) 'island'(島・中央帯等) 'road1'(LOD1道路面, 高さは後でDEM)
bridge フラグ(sectionType=3 橋梁)
"""
import sys, os, glob, pickle
import numpy as np
from lxml import etree
from shapely.geometry import Polygon
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, triangulate, strip_closing, load_track_line, in_data, BX0, BZ0, BX1, BZ1

G = "{http://www.opengis.net/gml}"
T = "{http://www.opengis.net/citygml/transportation/2.0}"
U = "{https://www.geospatial.jp/iur/uro/3.1}"
BUF = float(os.environ.get("TRAN_BUF", "400"))   # v29: 範囲拡大では全域（1e9）
TRACK = load_track_line()

TA = {"1000": "lane", "1010": "lane", "1020": "xing", "1030": "lane", "1040": "lane", "1050": "rail",
      "1070": "lane", "1130": "lane", "2000": "walk", "2010": "walk", "2020": "walk", "2030": "walk",
      "6000": "walk", "7000": "lane"}
AUX = {"1000": "lane", "1060": "island", "1080": "island", "1090": "lane", "1100": "lane", "1110": "lane",
       "1120": "walk", "3000": "island", "3010": "island", "3020": "island", "4000": "tramstop",
       "5000": "green", "5010": "green", "5020": "green"}

def pl(txt):
    return strip_closing(proj_arr(np.array(txt.split(), dtype=np.float64).reshape(-1, 3)))

def polys_of(el):
    for poly in el.iter(G + "Polygon"):
        ext = poly.find(G + "exterior/" + G + "LinearRing/" + G + "posList")
        if ext is None: continue
        rings = [pl(ext.text)]
        for it in poly.findall(G + "interior/" + G + "LinearRing/" + G + "posList"):
            rings.append(pl(it.text))
        yield rings

def process(path):
    code = os.path.basename(path).split("_")[0]
    out = {}
    pid = {}
    n = 0
    for ev, r in etree.iterparse(path, events=("end",), tag=T + "Road", huge_tree=True):
        sect = None
        for st in r.iter():
            if isinstance(st.tag, str) and st.tag.endswith("sectionType"):
                sect = (st.text or "").strip()
        bridge = sect == "3"
        lod3_parts = []
        for ta in r.iter(T + "TrafficArea"):
            f = (ta.findtext(T + "function") or "").strip()
            lod3_parts.append((TA.get(f, "lane"), ta))
        for ta in r.iter(T + "AuxiliaryTrafficArea"):
            f = (ta.findtext(T + "function") or "").strip()
            lod3_parts.append((AUX.get(f, "island"), ta))
        items = []
        if lod3_parts:
            for cat, el in lod3_parts:
                for rings in polys_of(el):
                    items.append((cat, rings))
        else:
            l1 = r.find(T + "lod1MultiSurface")
            if l1 is not None:
                for rings in polys_of(l1):
                    items.append(("road1", rings))
        for cat, rings in items:
            ext = rings[0]
            # v29: データ範囲に掛からない面は捨てる（範囲の縁で切るのは roads.py）
            if ext[:, 0].max() < BX0 or ext[:, 0].min() > BX1 or ext[:, 2].max() < BZ0 or ext[:, 2].min() > BZ1: continue
            try:
                d = 0.0 if BUF > 1e8 else TRACK.distance(Polygon(ext[:, [0, 2]]).buffer(0))
            except Exception:
                continue
            if d > BUF: continue
            verts, idx = triangulate(rings)
            if verts is None: continue
            tri = verts[idx.reshape(-1)].astype(np.float32)
            # 道路面は上向きに揃える
            t = tri.reshape(-1, 3, 3)
            nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
            down = nrm[:, 1] < 0
            t[down] = t[down][:, [0, 2, 1]]
            key = cat + ("_bridge" if bridge else "")
            out.setdefault(key, []).append(t.reshape(-1, 3))
            pid.setdefault(key, []).append(np.full(len(t), n, np.int32))
            n += 1
        r.clear()
        while r.getprevious() is not None:
            del r.getparent()[0]
    os.makedirs("/home/claude/wx/out_tran", exist_ok=True)
    out = {k: np.concatenate(v) for k, v in out.items()}
    out["_pid"] = {k: np.concatenate(v) for k, v in pid.items()}
    pickle.dump(out, open(f"/home/claude/wx/out_tran/{code}.pkl", "wb"))
    return code, {k: len(v) // 3 for k, v in out.items() if k != '_pid'}

if __name__ == "__main__":
    from multiprocessing import Pool
    files = sys.argv[1:] or sorted(glob.glob("/home/claude/wx/p25/udx/tran/*_op.gml"))
    with Pool(int(os.environ.get("NPROC", "2"))) as p:
        for code, st in p.imap_unordered(process, files):
            print(code, st, flush=True)
