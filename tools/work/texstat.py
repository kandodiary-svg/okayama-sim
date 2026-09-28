import pickle, glob, os, math, numpy as np
from PIL import Image
def stat(d):
    groups = {}
    for f in sorted(glob.glob(d + "/*.pkl")):
        t = pickle.load(open(f, "rb"))["tex"]
        for img, L in t.items(): groups.setdefault(img, []).extend(p for p, u in L)
    tiles = {}; sizes = {}
    for img, L in groups.items():
        c = np.concatenate(L)[:, [0, 2]].mean(0); tl = (math.floor(c[0] / 800), math.floor(c[1] / 800))
        if img not in sizes:
            with Image.open(img) as im: sizes[img] = im.size[0] * im.size[1]
        tiles.setdefault(tl, [0, 0]); tiles[tl][0] += sizes[img]; tiles[tl][1] += 1
    return tiles, groups
to, go = stat("/tmp/out_bldg"); tn, gn = stat("/home/claude/wx/out_bldg")
print("images old", len(go), "new", len(gn), "tot raw old %.3g new %.3g" % (sum(v[0] for v in to.values()), sum(v[0] for v in tn.values())))
for k in sorted(set(to) | set(tn)): print(k, "old", to.get(k), "new", tn.get(k))
# 共有画像: core と外の両方の建物が使う画像
CORE = (-700, -400, 2800, 2200); sh = 0
for img, L in gn.items():
    c = np.concatenate(L).reshape(-1, 3, 3).mean(1)
    inc = (c[:, 0] > CORE[0]) & (c[:, 0] < CORE[2]) & (c[:, 2] > CORE[1]) & (c[:, 2] < CORE[3])
    if inc.any() and (~inc).any(): sh += 1
print("images shared core/outside", sh)
