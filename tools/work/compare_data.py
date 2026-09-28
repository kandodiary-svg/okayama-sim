"""2 つの data フォルダの形（チャンク）を比べる。ファイルの分け方（タイル）が違っても、層・材質ごとの三角形の集合で比べる。
使い方: python3 compare_data.py OLD_DIR NEW_DIR [layers...]"""
import sys, json, base64, zlib, collections
import numpy as np

def load(d):
    sc = json.load(open(f"{d}/scene.json"))
    cache = {}
    def buf(fk):
        if fk not in cache:
            f = sc["files"][fk]["file"]
            cache[fk] = zlib.decompress(base64.b64decode(open(f"{d}/{f}").read()))
        return cache[fk]
    return sc, buf

def tris(sc, buf, layers):
    out = collections.defaultdict(list)
    for c in sc["chunks"]:
        if layers and c["layer"] not in layers: continue
        b = buf(c["file"])
        q = np.frombuffer(b, np.int16, c["count"] * 3, c["pos"]).reshape(-1, 3).astype(np.float64)
        p = q * c["scale"] + np.array(c["origin"])
        key = (c["layer"], c["mat"], c.get("page", -1) if c["mat"] in ("ortho", "tex", "texhi") else -1)
        out[key].append(np.round(p.reshape(-1, 9), 2))
    return {k: np.concatenate(v) for k, v in out.items()}

A, ba = load(sys.argv[1]); B, bb = load(sys.argv[2])
layers = set(sys.argv[3:])
TA = tris(A, ba, layers); TB = tris(B, bb, layers)
allk = sorted(set(TA) | set(TB), key=str)
bad = 0
for k in allk:
    a = TA.get(k, np.zeros((0, 9))); b = TB.get(k, np.zeros((0, 9)))
    sa = set(map(tuple, a.tolist())); sb = set(map(tuple, b.tolist()))
    only_a = len(sa - sb); only_b = len(sb - sa)
    flag = "" if (only_a == 0 and only_b == 0) else "  <-- DIFF"
    if flag: bad += 1
    print(k, "A", len(a), "B", len(b), "onlyA", only_a, "onlyB", only_b, flag)
print("keys with differences:", bad)
