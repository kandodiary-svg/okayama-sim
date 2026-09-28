"""v29: 出力済みの走行格子（data/geo_drive）で、v28 の範囲（core）の縁をまたぐ所の高さの段差を調べる。
道路（区分 1=車道）の升目で、core の縁の内側と外側の隣どうしの高さの差を数える。"""
import json, base64, zlib, sys
import numpy as np
D = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/okaden-x/data"
sc = json.load(open(f"{D}/scene.json")); d = sc["drive"]
raw = zlib.decompress(base64.b64decode(open(f"{D}/{sc['files']['drive']['file']}").read()))
n = d["nx"] * d["nz"]
H = np.frombuffer(raw[:n * 2], np.int16).reshape(d["nz"], d["nx"]) / 100.0
K = np.frombuffer(raw[n * 2:n * 3], np.uint8).reshape(d["nz"], d["nx"])
CORE = (-700, -400, 2800, 2200)
x = d["x0"] + (np.arange(d["nx"]) + 0.5) * d["step"]; z = d["z0"] + (np.arange(d["nz"]) + 0.5) * d["step"]
res = []
for name, axis, val in (("west", 1, CORE[0]), ("east", 1, CORE[2]), ("north", 0, CORE[1]), ("south", 0, CORE[3])):
    if axis == 1:
        i = int(np.searchsorted(x, val)); a = H[:, i - 1]; b = H[:, i]; ka = K[:, i - 1]; kb = K[:, i]
        span = (z > CORE[1]) & (z < CORE[3])
    else:
        j = int(np.searchsorted(z, val)); a = H[j - 1]; b = H[j]; ka = K[j - 1]; kb = K[j]
        span = (x > CORE[0]) & (x < CORE[2])
    m = span & (ka == 1) & (kb == 1)
    dd = np.abs(a - b)[m]
    # 比べるための「core の中の隣どうし」の差（同じ向き、3 升内側）
    if axis == 1: ref = np.abs(H[:, i - 4] - H[:, i - 3])[span & (K[:, i - 4] == 1) & (K[:, i - 3] == 1)]
    else: ref = np.abs(H[j - 4] - H[j - 3])[span & (K[j - 4] == 1) & (K[j - 3] == 1)]
    print(name, "road cells across edge", int(m.sum()), "step max %.2f p95 %.3f mean %.3f" % (dd.max() if len(dd) else 0, np.percentile(dd, 95) if len(dd) else 0, dd.mean() if len(dd) else 0),
          "| inside ref p95 %.3f max %.2f" % (np.percentile(ref, 95) if len(ref) else 0, ref.max() if len(ref) else 0))
    big = np.nonzero(m & (np.abs(a - b) > 0.08))[0]
    for q in big[:8]:
        print("   >8cm at", ("z %.0f" % z[q]) if axis == 1 else ("x %.0f" % x[q]), "%.2f -> %.2f" % (a[q], b[q]))
