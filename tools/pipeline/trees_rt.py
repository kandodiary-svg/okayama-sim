"""v48: 街路樹を画面側（app.js の Trees）で作るための一覧 -> data/trees.json
PLATEAU の街路樹（parse_trees.py の trees.pkl: 位置・樹種・樹高・樹冠径・幹径・高木/中木の区分）から、
build_v5.py と同じ除外（線路の中心から 2.8m 以内、駅前広場の延伸工事の範囲）をしてタイル（scene.json の tiles）ごとに並べる。
1 本 = [x(dm), z(dm), y(cm、根元の高さが無い時は -99999), 樹高(dm、無い時 0), 樹冠径(dm、無い時 0), 幹径(cm、無い時 0), 樹種コード(数、無い時 0), 区分(0/1/2、9 = 航空写真から推定)]
"""
import json, pickle, sys, os
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ext_station as EXT

DATA = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/okaden-x/data"
TREES = pickle.load(open("/home/claude/wx/trees.pkl", "rb"))
T = pickle.load(open("/home/claude/wx/tracks.pkl", "rb"))
EXTD = EXT.build()
lines = [LineString(t["xyz"][:, [0, 2]]) for t in T["tracks"]] + [LineString(tr["xy"]) for tr in EXTD["tracks"]]
TRK = unary_union(lines)
tiles = json.load(open(os.path.join(DATA, "scene.json")))["tiles"]
def tile_of(x, z):
    for k, t in tiles.items():
        if t["x0"] <= x < t["x0"] + t["size"] and t["z0"] <= z < t["z0"] + t["size"]: return k
    return None
def num(v, k=1.0):
    return int(round(v * k)) if v is not None and v > 0 else 0
out, n, skip = {}, 0, 0
for t in TREES:
    x, z = float(t["x"]), float(t["z"])
    if TRK.distance(Point(x, z)) < 2.8 or (x < -12 and EXTD["clear"].contains(Point(x, z))): skip += 1; continue
    k = tile_of(x, z)
    if k is None: skip += 1; continue
    y = float(t["y"]); yv = int(round(y * 100)) if (-20 < y < 80 and y > 0.01) else -99999
    sp = int(t["sp"]) if str(t["sp"]).isdigit() else 0
    out.setdefault(k, []).append([int(round(x * 10)), int(round(z * 10)), yv, num(t["h"], 10), num(t["cd"], 10), num(t["td"], 100), sp, int(t["cls"] or 0)])
    n += 1
# v48: 航空写真から推定した木（trees_aerial.py。PLATEAU に無い所だけ）。区分 9、樹種 0、根元の高さは画面側で地面に合わせる
na = 0
if os.path.exists("/home/claude/wx/trees_aerial.json"):
    for x, z, h, cd in json.load(open("/home/claude/wx/trees_aerial.json")):
        k = tile_of(x, z)
        if k is None or TRK.distance(Point(x, z)) < 2.8 or (x < -12 and EXTD["clear"].contains(Point(x, z))): continue
        out.setdefault(k, []).append([int(round(x * 10)), int(round(z * 10)), -99999, int(round(h * 10)), int(round(cd * 10)), 0, 0, 9]); na += 1
print("aerial trees added", na)
json.dump({"v": 1, "tiles": out}, open(os.path.join(DATA, "trees.json"), "w"), separators=(",", ":"))
print("trees", n, "skipped", skip, "tiles", len(out), "bytes", os.path.getsize(os.path.join(DATA, "trees.json")))
