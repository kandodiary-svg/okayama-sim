"""v41.10: ナビの目的地検索用の地点（data/poi.json）とタクシー乗り場を作る。
入力: tools/osm/osm_v41_10_poi.json.xz（Overpass の結果。クエリは tools/osm/q_v41_10_poi.txt、2026-10-06 取得）、
      data/places.json（町丁の境界）、data/routes.json（電停）、data/bus.json（バス停）
出力: data/poi.json
  { cats:[分類名…], p:[[名前, 分類番号, x, z]…], taxi:[[x, z, 名前, 重み]…], note:"…" }
座標は岡山駅前（原点）からの x=東・z=南（m）。common.proj と同じ平面近似。
※ 地点は OpenStreetMap の位置（ODbL）。タクシー乗り場の「重み」（お客さんの出やすさ）は、駅・商業施設・病院を大きくした推定で、実際の統計ではない。"""
import json, lzma, math, os, re, sys
OUT = os.environ.get("OUT_DIR", "/home/claude/okaden-x/data")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "osm", "osm_v41_10_poi.json.xz")
LAT0, LON0 = 34.66551000032155, 133.91967999999633
KX = math.cos(math.radians(LAT0)) * 111320.0; KZ = 110540.0
BX0, BZ0, BX1, BZ1 = -4048, -4692, 7312, 4436

def proj(lat, lon): return (lon - LON0) * KX, -(lat - LAT0) * KZ

CATS = ["駅", "バス・船", "病院", "大学・短大", "学校", "公共施設", "郵便局", "商業施設", "スーパー", "コンビニ", "ホテル", "観光・文化", "公園・運動", "寺社", "町"]
C = {n: i for i, n in enumerate(CATS)}

def kind(t):
    a = t.get("amenity"); s = t.get("shop"); tr = t.get("tourism"); le = t.get("leisure"); hi = t.get("historic")
    if t.get("railway") in ("station", "halt") or t.get("public_transport") == "station" and t.get("railway") != "tram_stop":
        return "駅" if t.get("railway") else "バス・船"
    if a in ("bus_station", "ferry_terminal"): return "バス・船"
    if a == "hospital": return "病院"
    if a in ("university", "college"): return "大学・短大"
    if a == "school": return "学校"
    if a in ("townhall", "police", "fire_station", "courthouse", "community_centre", "library"): return "公共施設"
    if a == "post_office": return "郵便局"
    if s in ("mall", "department_store", "electronics", "doityourself"): return "商業施設"
    if s == "supermarket": return "スーパー"
    if s == "convenience": return "コンビニ"
    if tr == "hotel": return "ホテル"
    if tr in ("attraction", "museum", "gallery", "zoo", "theme_park", "viewpoint", "aquarium") or a in ("theatre", "cinema", "arts_centre") or hi in ("castle", "monument", "memorial") or le == "garden": return "観光・文化"
    if le in ("park", "stadium", "sports_centre", "swimming_pool"): return "公園・運動"
    if a == "place_of_worship": return "寺社"
    return None

def clean(n):
    n = re.sub(r"[（(].*?[）)]", "", n).strip()
    return n

raw = json.load(lzma.open(RAW, "rt", encoding="utf-8"))
els = raw["elements"]
pts, taxi = [], []
for e in els:
    t = e.get("tags", {})
    la = e.get("lat") if "lat" in e else (e.get("center") or {}).get("lat")
    lo = e.get("lon") if "lon" in e else (e.get("center") or {}).get("lon")
    if la is None: continue
    x, z = proj(la, lo)
    if not (BX0 < x < BX1 and BZ0 < z < BZ1): continue
    if t.get("amenity") == "taxi":
        taxi.append(dict(x=x, z=z, name=t.get("name", ""), op=t.get("operator", "")))
        continue
    k = kind(t)
    nm = t.get("name")
    if not k or not nm: continue
    nm = clean(nm)
    if k == "駅" and not nm.endswith("駅"): nm += "駅"
    if len(nm) < 2 and k != "駅": continue
    pts.append(dict(name=nm, cat=C[k], x=x, z=z))

# 同名・同分類で 160m 以内のものは 1 つに（大学の学部ごとの点、駅の出入口など）
pts.sort(key=lambda p: (p["cat"], p["name"]))
keep = []
for p in pts:
    if any(q["name"] == p["name"] and q["cat"] == p["cat"] and math.hypot(q["x"] - p["x"], q["z"] - p["z"]) < (160 if p["cat"] != C["コンビニ"] else 40) for q in keep): continue
    keep.append(p)
pts = keep

# 岡山駅は東口・西口に分ける（OSM の「岡山」の 2 点は駅舎の中心。ここでは広場・乗り場の位置を使う）
pts = [p for p in pts if not (p["cat"] == C["駅"] and p["name"] == "岡山駅")]
pts += [dict(name="岡山駅 東口", cat=C["駅"], x=-85.0, z=36.0), dict(name="岡山駅 西口", cat=C["駅"], x=-217.0, z=-161.0)]

# 町丁目（境界の代表点）
KJ = "〇一二三四五六七八九"
def town_name(n):
    m = re.match(r"^(.*\D)(\d)$", n)
    return m.group(1) + KJ[int(m.group(2))] + "丁目" if m else n
places = json.load(open(os.path.join(OUT, "places.json"), encoding="utf-8"))
towns = []
for tw in places["towns"]:
    best = None
    for ring in tw["r"]:
        if len(ring) < 4: continue
        a = 0.0; cx = 0.0; cz = 0.0
        for i in range(len(ring) - 1):
            x0, z0 = ring[i]; x1, z1 = ring[i + 1]; c = x0 * z1 - x1 * z0; a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c
        if abs(a) < 1e-6: continue
        cx /= 3 * a; cz /= 3 * a
        if best is None or abs(a) > best[0]: best = (abs(a), cx, cz)
    if best and BX0 < best[1] < BX1 and BZ0 < best[2] < BZ1:
        towns.append(dict(name=town_name(tw["name"]), cat=C["町"], x=best[1], z=best[2]))
pts += towns

# 電停・バス停（検索できるように）
routes = json.load(open(os.path.join(OUT, "routes.json"), encoding="utf-8"))
seen = set()
for key in ("higashi", "seiki"):
    r = routes[key]; tr = r["track"]; acc = [0.0]
    for i in range(1, len(tr)): acc.append(acc[-1] + math.hypot(tr[i][0] - tr[i - 1][0], tr[i][2] - tr[i - 1][2]))
    for s in r["stops"]:
        nm = s["name"].split("・")[0] if "ハレノワ" not in s["name"] and "おかでん" not in s["name"] else s["name"]
        if "ハレノワ" in nm: nm = "ハレノワ前"
        if "東山" in nm: nm = "東山"
        nm = nm + "電停"
        if nm in seen or nm == "岡山駅前電停" and False: continue
        seen.add(nm)
        lo = 0; hi = len(acc) - 1; a = s["arc"]
        while hi - lo > 1:
            m = (lo + hi) // 2
            if acc[m] <= a: lo = m
            else: hi = m
        pts.append(dict(name=nm, cat=C["バス・船"], x=tr[lo][0], z=tr[lo][2]))
bus = json.load(open(os.path.join(OUT, "bus.json"), encoding="utf-8"))
for s in bus["stops"]:
    pts.append(dict(name=s["name"] + "バス停", cat=C["バス・船"], x=s["pole"][0], z=s["pole"][1]))

# タクシー乗り場: OSM の amenity=taxi ＋ 駅・大きな病院・商業施設の前
def near(x, z, cats, r):
    b = None; bd = r
    for p in pts:
        if p["cat"] in cats:
            d = math.hypot(p["x"] - x, p["z"] - z)
            if d < bd: bd = d; b = p
    return b
def in_ring(r, x, z):
    c = False; j = len(r) - 1
    for i in range(len(r)):
        a = r[i]; b = r[j]
        if ((a[1] > z) != (b[1] > z)) and (x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0]): c = not c
        j = i
    return c
def town_at(x, z):
    for tw in places["towns"]:
        for ring in tw["r"]:
            if in_ring(ring, x, z): return town_name(tw["name"])
    return ""
stands = []
BIG = re.compile(r"イオンモール岡山|天満屋|岡山城|後楽園|病院|医療センター|大学$|大学（|ブランチ|岡山ドーム|ハレノワ")
EKI = (-129.4, -137.1)
for t in taxi:
    x, z = t["x"], t["z"]
    if math.hypot(x - EKI[0], z - EKI[1]) < 380:
        base = "岡山駅 " + ("東口" if x > -160 else "西口"); w = 3.0
    else:
        nb = near(x, z, {C["駅"]}, 220)
        if nb: base = nb["name"].replace("駅 東口", "駅").replace("駅 西口", "駅") + "前"; w = 1.2
        else:
            nb = None; bd = 200
            for p in pts:
                if p["cat"] in (C["商業施設"], C["病院"], C["観光・文化"], C["大学・短大"]) and BIG.search(p["name"]):
                    d = math.hypot(p["x"] - x, p["z"] - z)
                    if d < bd: bd = d; nb = p
            if nb: base = nb["name"] + "前"; w = 1.0
            else:
                nb2 = near(x, z, {C[k] for k in ("公共施設", "観光・文化", "ホテル", "スーパー", "商業施設", "学校", "病院", "寺社")}, 350)
                base = (nb2["name"] + "付近") if nb2 else ((town_at(x, z) or "市内") + "付近"); w = 0.7
    stands.append([round(x, 1), round(z, 1), base + " タクシー乗り場", w])
cnt = {}
for s in stands: cnt[s[2]] = cnt.get(s[2], 0) + 1
idx = {}
for s in stands:
    if cnt[s[2]] > 1: idx[s[2]] = idx.get(s[2], 0) + 1; s[2] = s[2].replace(" タクシー乗り場", "（" + str(idx[s[2]]) + "）タクシー乗り場") if False else s[2] + "（" + str(idx[s[2]]) + "）"
def have(x, z, r=320): return any(math.hypot(s[0] - x, s[1] - z) < r for s in stands)
for p in sorted(pts, key=lambda q: q["cat"]):
    nm = p["name"]
    if nm in ("岡山駅 東口", "岡山駅 西口"): continue
    ok = (p["cat"] == C["駅"]) or (p["cat"] == C["病院"] and re.search(r"大学病院|医療センター|赤十字|市民病院|県立|総合", nm)) or (p["cat"] == C["商業施設"] and re.search(r"イオンモール岡山|天満屋 本館|NISHIGAWA|クレド", nm))
    if ok and not have(p["x"], p["z"]):
        stands.append([round(p["x"], 1), round(p["z"], 1), nm + ("" if nm.endswith("駅") else "") + "前 タクシー乗り場", 1.0 if p["cat"] != C["駅"] else 1.2])
out = dict(cats=CATS, p=[[p["name"], p["cat"], round(p["x"], 1), round(p["z"], 1)] for p in pts], taxi=stands,
           note="地点: OpenStreetMap (ODbL, 2026-10-06)。町丁の代表点は境界から計算。電停・バス停は路線データから。タクシー乗り場の重みは推定。")
json.dump(out, open(os.path.join(OUT, "poi.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("poi", len(out["p"]), "taxi stands", len(stands), "bytes", os.path.getsize(os.path.join(OUT, "poi.json")))
for s in stands: print(" ", s)
import collections
print(collections.Counter(CATS[p["cat"]] for p in pts))
