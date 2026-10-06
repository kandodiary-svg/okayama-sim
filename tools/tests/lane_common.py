"""車線データ（traffic.json + traffic_pts.txt）を読む共通部分（v41.12）。OUT_DIR で読む場所を変える。
A = 全点列（m）、T = traffic.json。lane_vs_lines.py / lane_spacing.py / lane_group_spacing.py が exec する"""
import os, sys, json, zlib, base64, numpy as np
from scipy.spatial import cKDTree
OUT = os.environ.get("OUT_DIR", "/home/claude/okaden-x/data")
T = json.load(open(f"{OUT}/traffic.json"))
raw = zlib.decompress(base64.b64decode(open(f"{OUT}/traffic_pts.txt").read().strip()))
N = T["pts"]["n"]; b = np.frombuffer(raw, np.uint8)
A = np.zeros((N, 3), np.int64)
for c in range(3):
    o = c * 4 * N
    v = (b[o:o+N].astype(np.uint32) | (b[o+N:o+2*N].astype(np.uint32) << 8) | (b[o+2*N:o+3*N].astype(np.uint32) << 16) | (b[o+3*N:o+4*N].astype(np.uint32) << 24)).view(np.int32).astype(np.int64)
    A[:, c] = v
for L in (T["lanes"], T["conns"]):
    for e in L: A[e["o"]:e["o"]+e["m"]] = np.cumsum(A[e["o"]:e["o"]+e["m"]], axis=0)
A = A / 100.0
