"""v30: build_v5 の出力（data/）の drive・pwires を、作り直さずに新しい並べ方へ変える（build_v5 の今の版と同じ結果）。
  drive: enc=grad2 → gres（地面の格子からの予測との差）
  pwires: float32 → sd（cm の整数・差分）
何度実行しても同じ（もう変えてあれば何もしない）。変えた後に元へ戻して一致を確かめる。"""
import os, sys, json, zlib, base64
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import geo_io
OUT = geo_io.OUT
sc_fn = os.path.join(OUT, "scene.json")
sc = json.load(open(sc_fn, encoding="utf-8"))
def write(fk, raw):
    b64 = base64.b64encode(zlib.compress(raw, 9)); fn = f"geo_{fk}.txt"
    open(os.path.join(OUT, fn), "wb").write(b64); sc["files"][fk] = dict(file=fn, raw=len(raw), size=len(b64))
    print("wrote", fn, "raw", round(len(raw) / 1e6, 2), "MB -> txt", round(len(b64) / 1e6, 2), "MB")
changed = False
if sc["drive"].get("enc") == "grad2":
    legacy = geo_io.read_legacy("drive"); m = sc["drive"]; n = m["nx"] * m["nz"]
    H = np.frombuffer(legacy[:2 * n], np.int16).reshape(m["nz"], m["nx"])
    g = sc["ground"]; gl = geo_io.read_legacy("ground")
    Hc = np.frombuffer(gl[:2 * g["nx"] * g["nz"]], np.int16).reshape(g["nz"], g["nx"])
    assert m["x0"] == g["x0"] and m["z0"] == g["z0"] and m["step"] * 2 == g["step"] and m["nx"] == 2 * g["nx"] and m["nz"] == 2 * g["nz"]
    src = open(os.path.join(os.path.dirname(__file__), "build_v5.py"), encoding="utf-8").read()
    i = src.index("def ground_pred("); j = src.index("def grad_encode(")
    ns = {"np": np}; exec(src[i:j], ns)
    write("drive", ns["gres_encode"](H, Hc) + legacy[2 * n:])
    m["enc"] = "gres"; changed = True
    json.dump(sc, open(sc_fn, "w", encoding="utf-8"), ensure_ascii=False)
    assert geo_io.read_legacy("drive") == legacy, "drive: 戻した値が一致しない"
    print("drive ok (gres)")
if sc.get("pwires_enc") != "sd" and "pwires" in sc["files"]:
    raw = geo_io.read("pwires")
    enc = geo_io.pw_encode(np.frombuffer(raw, np.float32))
    write("pwires", enc); sc["pwires_enc"] = "sd"; changed = True
    json.dump(sc, open(sc_fn, "w", encoding="utf-8"), ensure_ascii=False)
    assert geo_io.pw_decode(geo_io.read("pwires")).tobytes() == raw, "pwires: 戻した値が一致しない"
    print("pwires ok (sd)")
# 送る大きさ（size）が無い項目に付ける（読み込みの進み具合の表示用）
for fk, f in sc["files"].items():
    if "size" not in f: f["size"] = os.path.getsize(os.path.join(OUT, f["file"])); changed = True
json.dump(sc, open(sc_fn, "w", encoding="utf-8"), ensure_ascii=False)
print("changed" if changed else "nothing to do")
