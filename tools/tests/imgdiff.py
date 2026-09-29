"""2 枚の画面の違い: 違う画素の数・割合・最大差、違う所を赤くした図"""
import sys, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int); b = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(int)
d = np.abs(a - b).max(2)
print(sys.argv[1].split("/")[-1], "vs", sys.argv[2].split("/")[-1], "diff px", int((d > 0).sum()), "(%.3f%%)" % (100 * (d > 0).mean()), ">8:", int((d > 8).sum()), "max", int(d.max()))
if len(sys.argv) > 3:
    o = (b * 0.5).astype(np.uint8); o[d > 0] = [255, 0, 0]; Image.fromarray(o).save(sys.argv[3])
