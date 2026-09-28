import math, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
Z=18
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = 34.630, 34.695, 133.884, 133.966
def t_of(lat, lon):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
x0, y1 = t_of(LAT_MIN, LON_MIN); x1, y0 = t_of(LAT_MAX, LON_MAX)
jobs = [(x, y) for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)]
todo=[j for j in jobs if not os.path.exists(f"/tmp/ortho/tiles/{j[0]}_{j[1]}.jpg")]
print("tiles", len(jobs), "todo", len(todo), flush=True)
fails=[]
def get(xy):
    x, y = xy; fn = f"/tmp/ortho/tiles/{x}_{y}.jpg"
    for _ in range(4):
        try:
            d = urllib.request.urlopen(f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{Z}/{x}/{y}.jpg", timeout=30).read()
            open(fn + ".part", "wb").write(d); os.rename(fn + ".part", fn); return
        except Exception as e: err = e
    fails.append(xy); print("fail", xy, err, flush=True)
with ThreadPoolExecutor(8) as ex: list(ex.map(get, todo))
print("DONE fails", len(fails), flush=True)
