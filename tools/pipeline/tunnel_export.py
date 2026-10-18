"""v43: 道路のトンネル（箱）の形を app 用に書き出す（data/tunnels_v.json）。
app は坑口の近くで地面（高さの格子）がトンネルの口をふさぐ斜面（「道の真ん中の盛り土」）になる所を、この形の中だけ描かない。
点 = 中心線に沿って約 8m ごと: [x, z, 床の高さ, 半幅, 上限の高さ（箱の区間 = 屋根の上面 - 0.35m、坑口の外の切り通し = 床 + 9m）]"""
import pickle, json, numpy as np, shapely
from shapely.geometry import Point
T = pickle.load(open("/home/claude/wx/tunnels.pkl", "rb"))
out = []
for t in T:
    ln = t["line"]; L = ln.length; cum = np.asarray(t["cum"]); z = np.asarray(t["z"]); yt = np.asarray(t["ytop"])
    oL = np.abs(np.asarray(t["offL"])); oR = np.abs(np.asarray(t["offR"]))
    rp = t.get("roof_poly"); n = max(2, int(np.ceil(L / 8.0)) + 1)
    pts = []
    for s in np.linspace(0, L, n):
        p = ln.interpolate(s); f = float(np.interp(s, cum, z)); hw = float(max(np.interp(s, cum, oL), np.interp(s, cum, oR))) + 0.3
        box = rp is not None and rp.buffer(0.5).contains(p)
        top = float(np.interp(s, cum, yt)) - 0.35 if box else f + 9.0   # 箱 = 屋根の上面より 0.35m 下（屋根の板の中。上面の地面は残す）
        pts.append([round(p.x, 2), round(p.y, 2), round(f, 2), round(hw, 2), round(top, 2)])
    out.append({"id": int(t["id"]), "name": t["name"], "p": pts})
    print(t["name"], t["id"], "points", len(pts), "hw", round(min(q[3] for q in pts), 1), round(max(q[3] for q in pts), 1), "box", sum(q[4] - q[2] < 8 for q in pts))
json.dump(out, open("/home/claude/okaden-x/data/tunnels_v.json", "w"), ensure_ascii=False, separators=(",", ":"))
