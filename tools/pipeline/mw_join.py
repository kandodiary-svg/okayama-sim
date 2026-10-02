"""v39: 山陽道（mw.bin）の高さを、PLATEAU の領域（走行格子）との境目でそろえる。
mw の skip（PLATEAU 側が道路を持つ区間）の両端で、鎖の高さと PLATEAU の路面の高さがずれていると（岡山 IC の南東端で最大 5m）、
境目で道路に段差ができ、車は境目で落ちる。境目の外側の鎖の高さを、境目の差の分だけ、なだらかに（約 70m あたり 1m）寄せる。
使い方: python3 mw_join.py [--apply]   （--apply なしは差の一覧だけ）"""
import json, sys, os, math, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo_io
D = geo_io.OUT
sc = json.load(open(f"{D}/scene.json")); dm = sc["drive"]
raw = geo_io.read_legacy("drive"); n_ = dm["nx"] * dm["nz"]
DH = np.frombuffer(raw[:n_ * 2], np.int16).reshape(dm["nz"], dm["nx"]) / 100.0
DK = np.frombuffer(raw[n_ * 2:n_ * 3], np.uint8).reshape(dm["nz"], dm["nx"])
UPH = {}
if dm.get("up"):
    _o = n_ * 3 + dm["brow"] * dm["bnz"]; _c = dm["up"]
    _ui = np.frombuffer(raw[_o:_o + 4 * _c], np.int32); _uh = np.frombuffer(raw[_o + 4 * _c:_o + 6 * _c], np.int16)
    UPH = dict(zip(_ui.tolist(), (_uh / 100.0).tolist()))
def surf(x, z, yref):
    i = int((x - dm["x0"]) / dm["step"]); j = int((z - dm["z0"]) / dm["step"])
    if i < 0 or j < 0 or i >= dm["nx"] or j >= dm["nz"]: return None, None
    lo = DH[j, i]; u = UPH.get(j * dm["nx"] + i); k = int(DK[j, i])
    if u is not None and abs(u - yref) < abs(lo - yref): return float(u), int(k)
    return float(lo), k
m = json.load(open(f"{D}/mw.json")); T = m["total"]
buf = bytearray(open(f"{D}/mw.bin", "rb").read())
PT = np.frombuffer(buf, dtype=np.float32, count=T * 3).reshape(T, 3)        # buf を直接書き換える
apply = "--apply" in sys.argv
smooth = lambda t: t * t * (3 - 2 * t)
rep = []
for c in m["chains"]:
    o, n = c["o"], c["n"]; ds = c["L"] / max(1, n - 1)
    X = PT[o:o + n, 0].copy(); Z = PT[o:o + n, 2].copy(); Y = PT[o:o + n, 1].copy(); Y0 = Y.copy()
    for a, b in c["skip"]:
        for side in ("a", "b"):
            if side == "a" and a <= 0: continue
            if side == "b" and b >= n - 1: continue
            step, bi = (-1, a) if side == "a" else (1, b)            # step: 外側（鎖の MW 側）へ進む向き
            best = None
            for q in range(14):                                       # 境目から内側へ数点探す（路面の升目に当たる所）
                i = bi - step * q
                if not (a <= i <= b): break
                sv, k = surf(X[i], Z[i], Y0[i])
                if sv is not None and k == 1 and abs(sv - Y0[i]) < 14: best = (i, sv); break
            if best is None: continue
            i0, sv = best; delta = sv - float(Y0[i0])
            rep.append((c["id"], side, i0, round(float(X[i0])), round(float(Z[i0])), round(float(Y0[i0]), 1), round(sv, 1), round(delta, 1)))
            if abs(delta) < 0.25: continue
            Lb = min(1500.0, max(300.0, 70.0 * abs(delta)))
            i = i0
            while a <= i <= b and (i - bi) * -step >= 0:               # 境目から i0 までの内側（描かない区間）
                Y[i] += delta; i += step
                if i == bi + step: break
            j = 1
            while True:
                i = bi + step * j; d = j * ds
                if i < 0 or i >= n or d >= Lb: break
                Y[i] += delta * (1 - smooth(d / Lb)); j += 1
    PT[o:o + n, 1] = Y
for r in rep: print(r)
if apply:
    bak = f"{D}/../mw.bin.v38.bak"
    if not os.path.exists(bak): open(bak, "wb").write(open(f"{D}/mw.bin", "rb").read())
    open(f"{D}/mw.bin", "wb").write(bytes(buf)); print("mw.bin 書き換え済み（バックアップ:", bak, ")")
