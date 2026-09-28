"""data/geo_*.bin（v26: deflate のバイナリ。以前は base64 の .txt）を読む共通関数"""
import os, zlib, base64
OUT = "/home/claude/okaden-x/data"
def read(name):
    b = os.path.join(OUT, f"geo_{name}.bin")
    if os.path.exists(b): return zlib.decompress(open(b, "rb").read())
    return zlib.decompress(base64.b64decode(open(os.path.join(OUT, f"geo_{name}.txt"), "rb").read().strip()))
