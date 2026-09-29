"""建物GML(LOD1/LOD2+テクスチャ) -> 三角形データ(pickle)
出力: /home/claude/wx/out_bldg/<code>.pkl
  tex:   {image_path: [ (pos(k,3), uv(k,2)) ... ]}  非インデックス三角形
  plain: [ (pos(k,3), rgb(3,), kind) ]  kind: roof/wall/lod1
"""
import sys, os, pickle, glob, random
import numpy as np
from lxml import etree
from shapely.geometry import Point
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, triangulate, strip_closing, load_track_line, in_data, CORE

NS_GML = "http://www.opengis.net/gml"
NS_BLDG = "http://www.opengis.net/citygml/building/2.0"
NS_APP = "http://www.opengis.net/citygml/appearance/2.0"
G = "{%s}" % NS_GML; B = "{%s}" % NS_BLDG; A = "{%s}" % NS_APP
XLINK = "{http://www.w3.org/1999/xlink}href"
BUF = float(os.environ.get("BLDG_BUF", "380"))
TRACK = load_track_line()
# v14: バスの経路（県庁通り〜相生橋〜古京〜国道250号）沿いも、線路から離れていても建物を入れる
BUS_BUF = float(os.environ.get("BLDG_BUS_BUF", "260"))
try:
    import json as _json
    from shapely.geometry import LineString as _LS
    _bp = _json.load(open("/home/claude/wx/bus_path_v14.json"))
    BUSL = _LS([(p[0], p[2]) for p in _bp["path"]])
except Exception:
    BUSL = None

# 用途別の外壁色(LOD1用, 実色不明のため用途で傾向を付けた中間色)
USAGE_COL = {
    "401": (0.72, 0.70, 0.66),  # 業務施設
    "402": (0.74, 0.69, 0.62),  # 商業施設
    "403": (0.70, 0.68, 0.64),  # 宿泊施設
    "404": (0.68, 0.66, 0.60),  # 商業系複合
    "411": (0.78, 0.74, 0.66),  # 住宅
    "412": (0.76, 0.73, 0.68),  # 共同住宅
    "413": (0.74, 0.70, 0.62),  # 店舗等併用住宅
    "414": (0.74, 0.71, 0.66),  # 店舗等併用共同住宅
    "421": (0.70, 0.70, 0.68),  # 官公庁施設
    "422": (0.73, 0.71, 0.66),  # 文教厚生施設
    "431": (0.64, 0.64, 0.62),  # 運輸倉庫施設
    "441": (0.62, 0.62, 0.60),  # 工場
}

# 外壁色の推定（PLATEAU の構造種別・詳細用途・建築年・階数から。実際の色データは無いため推定）
PAL = {
    "house_old": [(0.66, 0.64, 0.60), (0.45, 0.36, 0.28), (0.72, 0.67, 0.57), (0.60, 0.58, 0.55)],
    "house": [(0.85, 0.81, 0.73), (0.71, 0.68, 0.62), (0.67, 0.58, 0.48), (0.59, 0.59, 0.58), (0.87, 0.86, 0.83), (0.52, 0.47, 0.42)],
    "apt": [(0.79, 0.73, 0.63), (0.60, 0.48, 0.40), (0.86, 0.85, 0.81), (0.75, 0.75, 0.73), (0.70, 0.62, 0.52)],
    "office": [(0.67, 0.67, 0.66), (0.83, 0.83, 0.81), (0.75, 0.72, 0.65), (0.58, 0.60, 0.62)],
    "shop": [(0.82, 0.81, 0.78), (0.70, 0.69, 0.67), (0.76, 0.70, 0.62)],
    "warehouse": [(0.62, 0.62, 0.61), (0.70, 0.71, 0.70), (0.56, 0.58, 0.60)],
    "temple": [(0.46, 0.36, 0.27), (0.82, 0.80, 0.74)],
}
def estimate_facade(struct, dusage, usage, year, storeys, rnd):
    try: yr = int(float(year))
    except Exception: yr = None
    st = storeys or 0
    du = dusage or ""
    if du == "4227": v = "temple"
    elif du in ("4312", "4313", "4521") or usage in ("431", "441"): v = "warehouse"
    elif du in ("4111", "4151") or (usage == "411"):
        v = "house" if struct in ("601", "605", None, "611") and st <= 3 else "apt"
    elif du in ("4121", "4141") or usage in ("412", "414"):
        v = "apt" if st >= 3 or struct in ("602", "603") else "house"
    elif du == "4131" or usage == "413":
        v = "shop" if st <= 2 else "apt"
    elif du.startswith("402") or usage == "402": v = "shop"
    else: v = "office" if st >= 3 or struct in ("602", "603", "604") else ("house" if struct == "601" else "shop")
    key = v
    if v == "house" and yr and yr < 1980: key = "house_old"
    c = PAL[key][rnd.randrange(len(PAL[key]))]
    c = tuple(min(1.0, x * (0.94 + rnd.random() * 0.08)) for x in c)
    tex = key   # house / house_old / apt / office / shop / warehouse / temple それぞれ別の外壁パターン
    return c, tex

from PIL import Image as _Image
_IMC = {}
def _img(path):
    im = _IMC.get(path)
    if im is None:
        if len(_IMC) > 64: _IMC.clear()
        try: im = np.asarray(_Image.open(path).convert("RGB").reduce(2), np.float32) / 255.0
        except Exception: im = None
        _IMC[path] = im
    return im
_ISZ = {}
def _imsize(path):
    if path not in _ISZ:
        try:
            with _Image.open(path) as im_: _ISZ[path] = im_.size
        except Exception: _ISZ[path] = None
    return _ISZ[path]
_IMF = {}
def _texel(path, u, v):
    """元の解像度の画像の 1 画素の色（0〜1）"""
    im = _IMF.get(path)
    if im is None:
        if len(_IMF) > 16: _IMF.clear()
        im = np.asarray(_Image.open(path).convert("RGB"), np.float32) / 255.0; _IMF[path] = im
    H, W = im.shape[:2]
    return im[int(np.clip((1 - v) * H, 0, H - 1)), int(np.clip(u * W, 0, W - 1))]
def uv_collapsed(uv, img):
    """v30: 壁の UV が 1 点につぶれている（写真の 1.5 画素以内に収まる）か。PLATEAU では写真の無い壁がこうなっている"""
    sz = _imsize(img)
    if sz is None: return False
    return float(np.ptp(uv[:, 0])) * sz[0] < 1.5 and float(np.ptp(uv[:, 1])) * sz[1] < 1.5
def sample_tri(im, uv, n=40):
    """UV 三角形の内側の画素（最大 n 点、重心座標で一様に）"""
    H, W = im.shape[:2]
    r = np.random.default_rng(0).random((n, 2)); m = r.sum(1) > 1; r[m] = 1 - r[m]
    p = uv[0] + (uv[1] - uv[0]) * r[:, :1] + (uv[2] - uv[0]) * r[:, 1:]
    x = np.clip((p[:, 0] * W).astype(int), 0, W - 1); y = np.clip(((1 - p[:, 1]) * H).astype(int), 0, H - 1)
    return im[y, x]
def facade_colors(faces):
    """写真テクスチャから外壁の地の色・ガラスの割合・屋根色を推定"""
    wall, roof, wa = [], [], []
    for st, tri, uv, img, *_ in faces:
        im = _img(img)
        if im is None: continue
        t = tri.reshape(-1, 3, 3); u = uv.reshape(-1, 3, 2)
        for k in range(len(t)):
            n = np.cross(t[k, 1] - t[k, 0], t[k, 2] - t[k, 0]); a = np.linalg.norm(n) / 2
            if a < 0.5: continue
            px = sample_tri(im, u[k], int(min(60, 8 + a / 4)))
            px = px[px.sum(1) > 0.06]                       # 黒い余白は除く
            if not len(px): continue
            if abs(n[1]) / (2 * a) < 0.35: wall.append(px); wa.append(a)
            else: roof.append(px)
    out = {}
    if wall:
        P = np.concatenate(wall); L = P @ np.array([0.3, 0.59, 0.11])
        lo, hi = np.percentile(L, [45, 92])
        base = P[(L >= lo) & (L <= hi)]
        c = np.median(base, 0) if len(base) else np.median(P, 0)
        m = c.mean(); c = m + (c - m) * 1.15                 # 写真はやや色が浅いので少しだけ彩度を上げる
        out["wall"] = np.clip(c * 1.06, 0.05, 0.97)
        med = np.median(L)
        glass = float(np.mean((L < med * 0.62) | ((P[:, 2] > P[:, 0] * 1.12) & (L < med * 0.9))))
        out["glass"] = glass
    if roof:
        P = np.concatenate(roof); out["roof"] = np.clip(np.median(P, 0), 0.05, 0.95)
    return out

def parse_poslist(txt):
    a = np.array(txt.split(), dtype=np.float64).reshape(-1, 3)
    return strip_closing(proj_arr(a))

def load_textures(path):
    """ring gml:id -> (image, uv(N,2))"""
    tex = {}
    for ev, el in etree.iterparse(path, events=("end",), tag=A + "ParameterizedTexture", huge_tree=True):
        img = el.findtext(A + "imageURI")
        for tg in el.iter(A + "textureCoordinates"):
            ring = tg.get("ring", "").lstrip("#")
            uv = np.array(tg.text.split(), dtype=np.float64).reshape(-1, 2)
            if len(uv) > 1 and np.allclose(uv[0], uv[-1]):
                uv = uv[:-1]
            tex[ring] = (img, uv)
        el.clear()
    return tex

def polygon_rings(poly):
    rings = []
    ext = poly.find(G + "exterior/" + G + "LinearRing")
    if ext is None:
        return None
    rings.append(ext)
    for it in poly.findall(G + "interior/" + G + "LinearRing"):
        rings.append(it)
    return rings

def process(path):
    code = os.path.basename(path).split("_")[0]
    base = os.path.dirname(path)
    texmap = load_textures(path)
    out_tex = {}
    out_plain = []
    out_proc = []   # 写真テクスチャの建物を、推定色の外壁（くっきり表示）で描くためのもの
    stats = dict(bldg=0, kept=0, lod2=0, texfaces=0)
    # v29: 外壁の推定色の乱数。core（v28 までの範囲）の建物は v28 と同じ順番で同じ乱数を使い（見た目を変えない）、
    # 広げた所の建物は別の乱数列を使う
    rnd_core = random.Random(int(code)); rnd_ext = random.Random(int(code) * 7919 + 17)
    _c0, _z0, _c1, _z1 = CORE
    for ev, b in etree.iterparse(path, events=("end",), tag=B + "Building", huge_tree=True):
        stats["bldg"] += 1
        # 位置判定: lod0RoofEdge か lod1 の最初の posList
        pl = b.find(".//" + G + "posList")
        if pl is None:
            b.clear(); continue
        p0 = parse_poslist(pl.text)
        cx, cz = p0[:, 0].mean(), p0[:, 2].mean()
        if not in_data(cx, cz, 5.0):   # v16: データ範囲（地形のある所）だけ
            b.clear(); continue
        if TRACK.distance(Point(cx, cz)) > BUF and (BUSL is None or BUSL.distance(Point(cx, cz)) > BUS_BUF):
            b.clear(); continue
        stats["kept"] += 1
        rnd = rnd_core if (_c0 + 5 < cx < _c1 - 5 and _z0 + 5 < cz < _z1 - 5) else rnd_ext
        usage = (b.findtext(B + "usage") or "").strip()
        try: mh = float(b.findtext(B + "measuredHeight"))
        except Exception: mh = None
        try: st_n = int(float(b.findtext(B + "storeysAboveGround")))
        except Exception: st_n = None
        allz = [float(v) for pl_ in b.iter(G + "posList") for v in pl_.text.split()[2::3]]
        base_y = min(allz) if allz else 0.0
        if st_n and st_n > 0 and mh:
            floor_h = min(5.0, max(2.7, mh / st_n))
        else:
            floor_h = 3.4
        attrs = {}
        for el_ in b.iter():
            if not isinstance(el_.tag, str): continue
            nm = el_.tag.split('}')[-1]
            if nm in ("buildingStructureType", "detailedUsage", "yearOfConstruction") and el_.text:
                attrs[nm] = el_.text.strip()
        col, variant = estimate_facade(attrs.get("buildingStructureType"), attrs.get("detailedUsage"), usage,
                                       attrs.get("yearOfConstruction"), st_n, rnd)
        col = np.array(col)

        surfaces = []
        for st in ("WallSurface", "RoofSurface", "ClosureSurface", "OuterCeilingSurface", "OuterFloorSurface"):
            for s in b.iter(B + st):
                for poly in s.iter(G + "Polygon"):
                    surfaces.append((st, poly))
        bfaces = []
        if surfaces:
            stats["lod2"] += 1
            for st, poly in surfaces:
                rings = polygon_rings(poly)
                if not rings:
                    continue
                arrs = []
                ok = True
                for r in rings:
                    t = r.findtext(G + "posList")
                    if not t:
                        ok = False; break
                    arrs.append(parse_poslist(t))
                if not ok or len(arrs[0]) < 3:
                    continue
                verts, idx = triangulate(arrs)
                if verts is None:
                    continue
                tri = verts[idx.reshape(-1)]
                rid = rings[0].get(G + "id")
                tx = texmap.get(rid)
                if tx is not None:
                    uvs = [tx[1]]
                    good = len(tx[1]) == len(arrs[0])
                    for r, a in zip(rings[1:], arrs[1:]):
                        t2 = texmap.get(r.get(G + "id"))
                        if t2 is None or len(t2[1]) != len(a):
                            good = False; break
                        uvs.append(t2[1])
                    if good:
                        uv = np.concatenate(uvs, axis=0)[idx.reshape(-1)]
                        img = os.path.join(base, tx[0])
                        # v30: 壁で UV が 1 点につぶれている面は、写真ではなく推定外壁（窓割り）に。色は PLATEAU のその 1 画素の色
                        #      （縮小したアトラスでは周りの黒い余白と混ざって黒っぽく見えていた）
                        if st == "WallSurface" and os.environ.get("FIX_FLAT_WALLS") and uv_collapsed(uv, img):
                            c_ = _texel(img, float(uv[:, 0].mean()), float(uv[:, 1].mean()))
                            bfaces.append((st, tri.astype(np.float32), uv.astype(np.float32), img, "flat"))
                            out_plain.append((tri.astype(np.float32), np.clip(c_, 0.05, 0.97).astype(np.float32), "wall", base_y, floor_h, variant))
                            stats["flatwalls"] = stats.get("flatwalls", 0) + 1
                            continue
                        out_tex.setdefault(img, []).append((tri.astype(np.float32), uv.astype(np.float32)))
                        bfaces.append((st, tri.astype(np.float32), uv.astype(np.float32), img))
                        stats["texfaces"] += 1
                        continue
                kind = "roof" if st == "RoofSurface" else "wall"
                c = col * (0.82 if kind == "roof" else 1.0)
                out_plain.append((tri.astype(np.float32), c.astype(np.float32), kind, base_y, floor_h, variant))
        else:
            solid = b.find(".//" + B + "lod1Solid")
            if solid is None:
                b.clear(); continue
            for poly in solid.iter(G + "Polygon"):
                rings = polygon_rings(poly)
                arrs = [parse_poslist(r.findtext(G + "posList")) for r in rings]
                if len(arrs[0]) < 3:
                    continue
                verts, idx = triangulate(arrs)
                if verts is None:
                    continue
                tri = verts[idx.reshape(-1)]
                # 床面(下向き)は描かない
                n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                if n[1] < -0.5 * np.linalg.norm(n):
                    continue
                flat = abs(n[1]) > 0.9 * (np.linalg.norm(n) + 1e-9)
                c = col * (0.8 if flat else 1.0)
                out_plain.append((tri.astype(np.float32), c.astype(np.float32), "roof" if flat else "wall", base_y, floor_h, variant))
        if bfaces:
            fc = facade_colors(bfaces)
            bfaces = [f for f in bfaces if len(f) < 5]   # v30: 推定外壁にした壁は「くっきり表示」版にも入れない（重なりを作らない）
            wc = fc.get("wall", col); rc = fc.get("roof", col * 0.82)
            var2 = variant
            if fc.get("glass", 0) > 0.5 and (st_n or 0) >= 4 and variant in ("office", "shop", "apt"): var2 = "curtain"
            for st_, tri_, uv_, img_ in bfaces:
                kind = "roof" if st_ == "RoofSurface" else "wall"
                out_proc.append((tri_, (rc if kind == "roof" else wc).astype(np.float32), kind, base_y, floor_h, var2))
        b.clear()
        while b.getprevious() is not None:
            del b.getparent()[0]
    os.makedirs("/home/claude/wx/out_bldg", exist_ok=True)
    pickle.dump(dict(tex=out_tex, plain=out_plain, proc=out_proc, stats=stats), open(f"/home/claude/wx/out_bldg/{code}.pkl", "wb"))
    return code, stats

if __name__ == "__main__":
    from multiprocessing import Pool
    files = sys.argv[1:] or sorted(glob.glob("/home/claude/wx/p25/udx/bldg/*_op.gml"))
    with Pool(int(os.environ.get("NPROC", "2"))) as p:
        for code, st in p.imap_unordered(process, files):
            print(code, st, flush=True)
