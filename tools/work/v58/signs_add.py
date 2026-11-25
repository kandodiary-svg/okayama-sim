"""v58: 看板を足す。建物の平面形（v56 の屋根から取り出したもの）に通り側から水平に光線を当てて、壁の位置と向きを決める -> data/signs.json に追記（同じ text+src は置き換え）"""
import pickle, json, sys
from shapely.geometry import LineString, Point
B = pickle.load(open(sys.argv[1], 'rb')); S = json.load(open(sys.argv[2])); out = json.load(open(sys.argv[3]))
polys = [b['poly'] for b in B if b['h'] > 4 and b['area'] < 60000]
def ray(o, d, tgt=None):
    PP = [p for p in polys if tgt and p.contains(Point(tgt))] or polys
    L = LineString([o, (o[0] + d[0] * 200, o[1] + d[1] * 200)]); best = None
    for p in PP:
        if not p.bounds or not L.intersects(p): continue
        g = L.intersection(p.boundary)
        pts = [g] if g.geom_type == 'Point' else list(getattr(g, 'geoms', []))
        for q in pts:
            t = Point(o).distance(q)
            if best is None or t < best[0]:
                # 壁の向き: 交点を含む辺
                ring = list(p.exterior.coords) if p.geom_type == 'Polygon' else []
                n = None
                for a, b in zip(ring, ring[1:]):
                    if LineString([a, b]).distance(q) < 0.05:
                        ex, ez = b[0] - a[0], b[1] - a[1]; l = (ex * ex + ez * ez) ** 0.5; n = (ez / l, -ex / l)
                        if n[0] * d[0] + n[1] * d[1] > 0: n = (-n[0], -n[1])
                        break
                best = (t, q, n or (-d[0], -d[1]))
    return best
keys = {(s['text'], s['src']) for s in S}
out = [o for o in out if (o['text'], o['src']) not in keys]
for s in S:
    r = ray(s['o'], s['d'], s.get('t'))
    if not r: print('MISS', s['text']); continue
    t, q, n = r; blade = s.get('blade', False)
    if blade: c = (q.x + n[0] * (0.25 + s['w'] / 2), q.y + n[1] * (0.25 + s['w'] / 2)); nn = (-n[1], n[0])
    else: off = s.get('off', 0.12); c = (q.x + n[0] * off, q.y + n[1] * off); nn = n
    out.append(dict(text=s['text'], sub=s.get('sub', ''), c=[round(c[0], 2), s['y'], round(c[1], 2)], n=[round(nn[0], 4), round(nn[1], 4)], w=s['w'], h=s['h'],
                    bg=s.get('bg'), fg=s['fg'], vert=s.get('vert', False), blade=blade, glow=s.get('glow', True), src=s['src']))
    print('%-14s hit (%.1f, %.1f) n=(%.2f, %.2f) dist %.1f' % (s['text'], q.x, q.y, n[0], n[1], t))
json.dump(out, open(sys.argv[3], 'w'), ensure_ascii=False, separators=(',', ':'))
