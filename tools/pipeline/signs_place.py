"""v50: 店名・看板の位置を PLATEAU の建物の壁に合わせて決める -> data/signs.json
看板ごとに「通りの側の点」から壁へ水平に光線を飛ばし、当たった壁の面（位置・外向きの法線）に看板の板を置く。
看板の内容（店名・色）は、ユーザー提供の写真資料（Wikimedia Commons のライセンス写真）と調査ガイドで確かめられたものだけ。
文字は一般の書体で書く（ロゴのマーク・独自の字形は写さない）。"""
import pickle, glob, json, sys, os
import numpy as np
X0, Z0, X1, Z1 = -230, -200, 430, 140
W = []
for f in sorted(glob.glob("/home/claude/wx/out_bldg/*.pkl")):
    d = pickle.load(open(f, "rb"))
    items = list(d["plain"]) + list(d.get("proc", []))
    for img, L in d["tex"].items():
        for p_, u_ in L: items.append((p_, None, "wall", 0, 0, ""))
    for it in items:
        t = np.asarray(it[0], np.float64).reshape(-1, 3, 3)
        c = t.mean(1)
        m = (c[:, 0] > X0) & (c[:, 0] < X1) & (c[:, 2] > Z0) & (c[:, 2] < Z1)
        if not m.any(): continue
        t = t[m]; n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]); ln = np.linalg.norm(n, axis=1) + 1e-12
        v = np.abs(n[:, 1]) / ln < 0.3
        if v.any(): W.append(t[v])
# 駅舎（STN）は out_bldg に入っていないので build と同じ所から
STN = pickle.load(open("/home/claude/wx/station_geo.pkl", "rb"))
for k, L in STN.items():
    for s_, q in L:
        if s_ != "WallSurface" or len(q) < 3: continue
        q = np.asarray(q, float)
        for i in range(1, len(q) - 1): W.append(np.array([[q[0], q[i], q[i + 1]]]))
T = np.concatenate(W); print("wall tris", len(T), file=sys.stderr)
def ray(o, d):
    o = np.asarray(o, float); d = np.asarray(d, float); d /= np.linalg.norm(d)
    e1 = T[:, 1] - T[:, 0]; e2 = T[:, 2] - T[:, 0]; p = np.cross(d, e2); det = (e1 * p).sum(1)
    ok = np.abs(det) > 1e-9; inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    s = o - T[:, 0]; u = (s * p).sum(1) * inv; q = np.cross(s, e1); v = (q * d).sum(1) * inv; t = (e2 * q).sum(1) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0.2)
    if not hit.any(): return None
    i = np.where(hit)[0][np.argmin(t[hit])]
    n = np.cross(e1[i], e2[i]); n[1] = 0; n /= np.linalg.norm(n)
    if np.dot(n, d) > 0: n = -n
    return o + d * t[i], n, t[i]
S = json.load(open(sys.argv[1]))
out = []
for s in S:
    o = [s["o"][0], s["y"], s["o"][1]]; d = [s["d"][0], 0, s["d"][1]]
    r = ray(o, d)
    if r is None: print("MISS", s["text"], file=sys.stderr); continue
    p, n, dist = r
    # 看板の幅の両端でも同じ壁か（奥行きの差）
    tg = np.array([-n[2], 0, n[0]]); chk = []
    for k in (-0.45, 0.45):
        r2 = ray(np.array(o) + tg * s["w"] * k, d); chk.append(None if r2 is None else round(float(r2[2] - dist), 2))
    blade = s.get("blade", False)
    if blade:   # 袖看板: 壁から直角に突き出す（板の面は壁と直角、中心は壁から 0.25 + 幅/2）
        c = p + n * (0.25 + s["w"] / 2); nn = tg
    else:
        c = p + n * s.get("off", 0.12); nn = n
    out.append(dict(text=s["text"], sub=s.get("sub", ""), c=[round(float(v), 2) for v in c], n=[round(float(nn[0]), 4), round(float(nn[2]), 4)],
                    w=s["w"], h=s["h"], bg=s.get("bg"), fg=s["fg"], vert=s.get("vert", False), blade=blade, glow=s.get("glow", True), src=s["src"]))
    print("%-22s hit (%.1f, %.1f, %.1f) n=(%.2f, %.2f) dist %.1f edges %s" % (s["text"], p[0], p[1], p[2], n[0], n[2], dist, chk), file=sys.stderr)
json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, separators=(",", ":"))
