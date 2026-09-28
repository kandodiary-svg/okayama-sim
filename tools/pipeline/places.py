"""現在地表示用: 町丁目（OSM admin_level=10）・区（admin_level=7/8）の境界と、橋の名前を data/places.json に出力"""
import json, sys, os
import numpy as np
from shapely.geometry import LineString, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union
sys.path.insert(0, os.path.dirname(__file__))
from common import proj
d = json.load(open("/home/claude/wx/osm/extra.json"))
from common import BX0, BZ0, BX1, BZ1
BB = box(BX0, BZ0, BX1, BZ1)
out = dict(towns=[], wards=[], bridges=[])
def rel_poly(e):
    ol = [LineString([proj(g["lat"], g["lon"]) for g in m["geometry"]]) for m in e.get("members", []) if m.get("geometry") and m.get("role") == "outer"]
    il = [LineString([proj(g["lat"], g["lon"]) for g in m["geometry"]]) for m in e.get("members", []) if m.get("geometry") and m.get("role") == "inner"]
    ps = list(polygonize(linemerge(ol))) if ol else []
    if not ps: return None
    P = unary_union(ps)
    if il:
        hs = list(polygonize(linemerge(il)))
        if hs: P = P.difference(unary_union(hs))
    return P
def rings(P):
    res = []
    for g in (P.geoms if hasattr(P, "geoms") else [P]):
        if not isinstance(g, Polygon) or g.is_empty: continue
        g = g.simplify(1.0)
        res.append([[round(x, 1), round(z, 1)] for x, z in g.exterior.coords])
    return res
for e in d["elements"]:
    t = e.get("tags", {})
    if e["type"] == "relation" and t.get("boundary") == "administrative":
        P = rel_poly(e)
        if P is None or not P.intersects(BB): continue
        lv = t.get("admin_level")
        if lv == "10": out["towns"].append(dict(name=t.get("name"), r=rings(P.intersection(BB.buffer(300)))))
        elif lv in ("7", "8"): out["wards"].append(dict(name=t.get("name"), lv=lv, r=rings(P.intersection(BB.buffer(300)))))
    if e["type"] == "way" and t.get("man_made") == "bridge" and t.get("name") and "geometry" in e:
        P = Polygon([proj(g["lat"], g["lon"]) for g in e["geometry"]]).buffer(0)
        if P.intersects(BB): out["bridges"].append(dict(name=t["name"], r=rings(P)))
# 岡山市の区（北区・中区）は admin_level=7/8 のどちらかにある
print("towns", len(out["towns"]), "wards", [w["name"] for w in out["wards"]], "bridges", [b["name"] for b in out["bridges"]])
json.dump(out, open("/home/claude/okaden-x/data/places.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(os.path.getsize("/home/claude/okaden-x/data/places.json") / 1e3, "KB")
