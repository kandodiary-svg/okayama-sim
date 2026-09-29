"""data/geo_*.bin（v26: deflate のバイナリ。以前は base64 の .txt）を読む共通関数"""
import os, zlib, base64
OUT = "/home/claude/okaden-x/data"
def read(name):
    b = os.path.join(OUT, f"geo_{name}.bin")
    if os.path.exists(b): return zlib.decompress(open(b, "rb").read())
    return zlib.decompress(base64.b64decode(open(os.path.join(OUT, f"geo_{name}.txt"), "rb").read().strip()))
def grad_decode(b, nx, nz):
    """v30: build_v5.grad_encode の逆（int16 の格子を返す）"""
    import numpy as np
    n = nx * nz; lo = np.frombuffer(b[:n], np.uint8).astype(np.uint16); hi = np.frombuffer(b[n:2 * n], np.uint8).astype(np.uint16)
    E = (lo | (hi << 8)).view(np.int16).astype(np.int64).reshape(nz, nx)
    return np.cumsum(np.cumsum(E, 0), 1).astype(np.int16)
def read_legacy(name):
    """v30: 高さを差分で持つ格子（drive・ground の enc=grad2）も、以前の並び（int16 の高さ＋残り）で返す"""
    import json
    raw = read(name)
    sc = json.load(open(os.path.join(OUT, "scene.json")))
    m = sc.get(name)
    if not m or m.get("enc") not in ("grad2", "gres"): return raw
    n = m["nx"] * m["nz"]
    if m["enc"] == "grad2": return grad_decode(raw, m["nx"], m["nz"]).tobytes() + raw[2 * n:]
    # gres: 地面の格子からの予測との差（build_v5.ground_pred と同じ整数の計算）
    import numpy as np
    g = sc["ground"]; gr = read_legacy("ground")
    Hc = np.frombuffer(gr[:2 * g["nx"] * g["nz"]], np.int16).reshape(g["nz"], g["nx"]).astype(np.int64)
    lo = np.frombuffer(raw[:n], np.uint8).astype(np.uint16); hi = np.frombuffer(raw[n:2 * n], np.uint8).astype(np.uint16)
    E = (lo | (hi << 8)).view(np.int16).astype(np.int64).reshape(m["nz"], m["nx"])
    nz_, nx_ = Hc.shape
    fi4 = 2 * np.arange(m["nx"]) + 1; i0 = np.minimum(fi4 >> 2, nx_ - 2); a = np.minimum(fi4 - 4 * i0, 4)
    fj4 = 2 * np.arange(m["nz"]) + 1; j0 = np.minimum(fj4 >> 2, nz_ - 2); b = np.minimum(fj4 - 4 * j0, 4)
    J = j0[:, None]; I = i0[None, :]; A = a[None, :]; B = b[:, None]
    P16 = (Hc[J, I] * (4 - A) + Hc[J, I + 1] * A) * (4 - B) + (Hc[J + 1, I] * (4 - A) + Hc[J + 1, I + 1] * A) * B
    return (E + (P16 + 8) // 16 - 12).astype(np.int16).tobytes() + raw[2 * n:]
def pw_encode(pos):
    """v30: 電線の線分（float32 の x,y,z ×2 の並び）を cm の整数にし、始点は前の線分の始点との差、終点は始点との差にして
    バイトの面に分ける（deflate がよく縮む。app.js の pwDecode で戻す）"""
    import numpy as np
    q = np.round(np.asarray(pos, np.float64).reshape(-1, 2, 3) * 100).astype(np.int64)
    st = q[:, 0].copy(); st[1:] -= q[:-1, 0]
    dd = np.concatenate([st, q[:, 1] - q[:, 0]], 0)
    assert np.abs(dd).max() < 2 ** 31
    u = dd.astype(np.int32).view(np.uint32)
    return b"".join(((u[:, c] >> s) & 255).astype(np.uint8).tobytes() for c in range(3) for s in (0, 8, 16, 24))
def pw_decode(b):
    import numpy as np
    M = len(b) // 12; A = np.zeros((M, 3), np.int64)
    for c in range(3):
        v = np.zeros(M, np.uint32)
        for k, s in enumerate((0, 8, 16, 24)): v |= np.frombuffer(b[(c * 4 + k) * M:(c * 4 + k + 1) * M], np.uint8).astype(np.uint32) << s
        A[:, c] = v.view(np.int32)
    N = M // 2; st = np.cumsum(A[:N], 0); en = st + A[N:]
    return (np.stack([st, en], 1).reshape(-1, 3) / 100.0).astype(np.float32)
