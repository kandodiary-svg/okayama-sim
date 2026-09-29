"""v30 の作り直し（同じ範囲）を v29 の出力と比べる。使い方: python3 val_compare.py [新しい data] [v29 の data]"""
import sys, os, json, zlib, base64, glob
import numpy as np
sys.path.insert(0, "/home/claude/pipeline-x")
NEW = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/okaden-x/data"
OLD = sys.argv[2] if len(sys.argv) > 2 else "/home/claude/wx/data_v29"
def raw(d, fn):
    t = open(os.path.join(d, fn), "rb").read()
    b = base64.b64decode(t.strip())
    return zlib.decompress(b)
def grad_decode(b, nx, nz):
    n = nx * nz; lo = np.frombuffer(b[:n], np.uint8).astype(np.uint16); hi = np.frombuffer(b[n:2 * n], np.uint8).astype(np.uint16)
    E = (lo | (hi << 8)).view(np.int16).astype(np.int64).reshape(nz, nx)
    return np.cumsum(np.cumsum(E, 0), 1).astype(np.int16).tobytes() + b[2 * n:]
sn = json.load(open(f"{NEW}/scene.json")); so = json.load(open(f"{OLD}/scene.json"))
fn_n = {k: v["file"] for k, v in sn["files"].items()}; fn_o = {k: v["file"] for k, v in so["files"].items()}
print("files: only new", sorted(set(fn_n) - set(fn_o))[:20], "only old", sorted(set(fn_o) - set(fn_n))[:20])
diff = []
for k in sorted(set(fn_n) & set(fn_o)):
    a = raw(NEW, fn_n[k]); b = raw(OLD, fn_o[k])
    m = sn.get(k)
    if isinstance(m, dict) and m.get("enc") == "grad2": a = grad_decode(a, m["nx"], m["nz"])
    if a != b:
        diff.append(k)
        if k in ("drive", "ground"):
            mo = so[k]; n = mo["nx"] * mo["nz"]
            A = np.frombuffer(a[:2 * n], np.int16); B = np.frombuffer(b[:2 * n], np.int16)
            print(" ", k, "H diff cells", int((A != B).sum()), "max cm", int(np.abs(A.astype(int) - B).max()),
                  "rest same", a[2 * n:] == b[2 * n:], "len", len(a), len(b))
            if k == "drive":
                K1 = np.frombuffer(a[2 * n:3 * n], np.uint8); K2 = np.frombuffer(b[2 * n:3 * n], np.uint8)
                print("    K diff", int((K1 != K2).sum()), "bits diff bytes", int((np.frombuffer(a[3 * n:], np.uint8) != np.frombuffer(b[3 * n:], np.uint8)).sum()))
print("geo files differ:", len(diff), diff[:40])
# 画像
for f in sorted(glob.glob(f"{OLD}/*.jpg") + glob.glob(f"{OLD}/*.webp") + glob.glob(f"{OLD}/*.png")):
    g = os.path.join(NEW, os.path.basename(f))
    if not os.path.exists(g): print("missing image", os.path.basename(f)); continue
    if open(f, "rb").read() != open(g, "rb").read(): print("image differs", os.path.basename(f))
# JSON
for f in ("routes.json", "signals.json", "peds.json", "jr.json", "bus.json", "places.json"):
    if not os.path.exists(f"{NEW}/{f}"): print("missing", f); continue
    print(f, "same" if json.load(open(f"{NEW}/{f}")) == json.load(open(f"{OLD}/{f}")) else "DIFFERS")
# traffic
tn = json.load(open(f"{NEW}/traffic.json")); to = json.load(open(f"{OLD}/traffic.json"))
if "pts" in tn:
    b = raw(NEW, tn["pts"]["file"]); N = tn["pts"]["n"]
    A = np.zeros((N, 3), np.int64)
    for c in range(3):
        v = np.zeros(N, np.uint32)
        for s in range(4): v |= np.frombuffer(b[(c * 4 + s) * N:(c * 4 + s + 1) * N], np.uint8).astype(np.uint32) << (8 * s)
        A[:, c] = v.view(np.int32)
    for key in ("lanes", "conns"):
        for e in tn[key]:
            o, m = e.pop("o"), e.pop("m"); P = np.cumsum(A[o:o + m], 0) / 100.0
            e["p"] = P.tolist()
    tn.pop("pts")
ok = tn.keys() == to.keys() and len(tn["lanes"]) == len(to["lanes"]) and len(tn["conns"]) == len(to["conns"])
mx = 0.0
if ok:
    for key in ("lanes", "conns"):
        for a, b in zip(tn[key], to[key]):
            if {k: v for k, v in a.items() if k != "p"} != {k: v for k, v in b.items() if k != "p"}: ok = False; break
            pa, pb = np.array(a["p"]), np.array(b["p"])
            if pa.shape != pb.shape: ok = False; break
            mx = max(mx, float(np.abs(pa - pb).max()))
    ok = ok and tn["sig_nodes"] == to["sig_nodes"] and tn["names"] == to["names"]
print("traffic", "same (max point diff %.4f m)" % mx if ok else "DIFFERS")
