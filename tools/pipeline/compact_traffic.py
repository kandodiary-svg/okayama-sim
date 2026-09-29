"""v30: data/traffic.json（車線網）を軽くする。
車線・接続の点列（p）を JSON から外し、1 本のバイナリ（int32 の cm、点列ごとに先頭は絶対値・以降は前の点との差）にする。
JSON には各点列の位置（o＝何点目から, m＝点の数）だけ残す。画面側（app.js）は traffic.json の pts を見て読む。
元の JSON は /home/claude/wx/traffic_full.json に残す（何度実行しても同じ結果）。"""
import json, os, zlib, base64
import numpy as np

OUT = os.environ.get("OUT_DIR", "/home/claude/okaden-x/data")
FULL = os.environ.get("TRAFFIC_FULL", "/home/claude/wx/traffic_full.json")
T = json.load(open(os.path.join(OUT, "traffic.json")))
if "pts" in T:
    T = json.load(open(FULL))   # もう軽くしてある → 元から作り直す
else:
    json.dump(T, open(FULL, "w"), ensure_ascii=False, separators=(",", ":"))
chunks = []; off = 0
for key in ("lanes", "conns"):
    for e in T[key]:
        p = np.round(np.asarray(e.pop("p"), np.float64) * 100).astype(np.int64)
        d = p.copy(); d[1:] -= p[:-1]
        assert np.abs(d).max() < 2 ** 31
        chunks.append(d.astype(np.int32)); e["o"] = off; e["m"] = len(p); off += len(p)
A = np.concatenate(chunks).reshape(-1, 3)
# バイト面に分けて並べる（x の下位・…、deflate がよく縮む）
u = A.astype(np.int32).view(np.uint32)
raw = b"".join(((u[:, c] >> s) & 255).astype(np.uint8).tobytes() for c in range(3) for s in (0, 8, 16, 24))
fn = "traffic_pts.txt"
open(os.path.join(OUT, fn), "w").write(base64.b64encode(zlib.compress(raw, 9)).decode())
T["pts"] = dict(file=fn, n=int(off), enc="d4")
json.dump(T, open(os.path.join(OUT, "traffic.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print("points", off, "json MB", round(os.path.getsize(os.path.join(OUT, "traffic.json")) / 1e6, 2),
      "pts MB", round(os.path.getsize(os.path.join(OUT, fn)) / 1e6, 2))
