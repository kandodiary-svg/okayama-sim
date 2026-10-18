"""v44: 山陽道の PA・SA の中（駐車場・場内の通路・建物）を書き出す。
入力: wx/exp/osm_sa_detail.json（Overpass: 休憩施設の区域の外接矩形の中の amenity=parking・highway=service・building、out geom）
      data/mw.json（man.sa: 休憩施設の区域の多角形。平面直角座標）
出力: data/mw_sa.json  [{name, parking:[[[x,z],...]], aisles:[[[x,z],...]], bld:[{p:[[x,z],...], h, name, wc}]}]（man.sa と同じ順）
（OSM ODbL）"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import proj
from matplotlib.path import Path
D = "/home/claude/okaden-x/data"
src = json.load(open("/home/claude/wx/exp/osm_sa_detail.json"))
man = json.load(open(f"{D}/mw.json"))
els = []
for e in src["elements"]:
    if e["type"] != "way" or "geometry" not in e: continue
    xy = [[round(a, 1), round(b, 1)] for a, b in (proj(g["lat"], g["lon"]) for g in e["geometry"])]
    els.append((e, xy))
out = []; used = set()
for a in man["sa"]:
    P = Path(a["poly"]); r = dict(name=a["name"], parking=[], aisles=[], bld=[])
    for e, xy in els:
        if e["id"] in used: continue
        cx = sum(p[0] for p in xy) / len(xy); cz = sum(p[1] for p in xy) / len(xy)
        if not (P.contains_point((cx, cz), radius=15) or P.contains_point((cx, cz), radius=-15)): continue
        t = e["tags"]; closed = len(xy) > 3 and xy[0] == xy[-1]
        if t.get("amenity") == "parking" and closed: r["parking"].append(xy[:-1]); used.add(e["id"])
        elif t.get("highway") == "service": r["aisles"].append(xy); used.add(e["id"])
        elif "building" in t and closed:
            lv = t.get("building:levels"); h = 3.6 * float(lv) + 1.2 if lv and lv.replace(".", "").isdigit() else (4.5 if t.get("amenity") == "toilets" or t.get("building") in ("toilets", "roof") else 6.0)
            if t.get("building") == "roof": h = 4.0
            r["bld"].append(dict(p=xy[:-1], h=round(h, 1), name=t.get("name", ""), wc=1 if t.get("amenity") == "toilets" else 0, roof=1 if t.get("building") == "roof" else 0)); used.add(e["id"])
    out.append(r)
json.dump(out, open(f"{D}/mw_sa.json", "w"), ensure_ascii=False, separators=(",", ":"))
for r in out: print(r["name"], len(r["parking"]), len(r["aisles"]), len(r["bld"]))
print("KB", os.path.getsize(f"{D}/mw_sa.json") / 1e3)
