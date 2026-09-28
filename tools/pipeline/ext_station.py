"""岡山駅前広場への路面電車乗り入れ（2027年3月開業予定）の再現
公表内容: 延伸 約100m（幅員6.5m）、駅前広場内に新停留場、2面3線（東山・清輝橋・将来のハレノワ線）、
現・岡山駅前電停は存続。細部の線形・ホーム寸法は未公表のため、公表の完成イメージ図と
現地の航空写真・PLATEAU建物位置から推定した配置。
座標: x=東, z=南（ローカル平面, m）。経路は駅側(西)へ向かう向きで定義。
"""
import numpy as np
from shapely.geometry import LineString, Polygon, Point

# 延伸区間の中心線（現電停の終端 → 駅前広場）
PATH = np.array([(-6.7, -3.1), (-30.0, -3.6), (-55.0, -6.5), (-75.0, -11.0), (-93.0, -14.8), (-112.0, -18.6)])
S_STOP0, S_STOP1 = 72.0, 108.0     # 新停留場ホームの範囲（中心線上の距離）

def _dense(P, step=1.0):
    out = [P[0]]
    for a, b in zip(P[:-1], P[1:]):
        n = max(1, int(np.ceil(np.hypot(*(b - a)) / step)))
        for k in range(1, n + 1): out.append(a + (b - a) * k / n)
    return np.array(out)

def _chaikin(P, it=3):
    for _ in range(it):
        q = 0.75 * P[:-1] + 0.25 * P[1:]; r = 0.25 * P[:-1] + 0.75 * P[1:]
        P = np.vstack([P[:1], np.stack([q, r], 1).reshape(-1, 2), P[-1:]])
    return P

C = _dense(_chaikin(PATH), 0.5)
seg = np.hypot(*np.diff(C, axis=0).T); ARC = np.concatenate([[0], np.cumsum(seg)])
TOTAL = ARC[-1]
TAN = np.gradient(C, axis=0); TAN /= np.linalg.norm(TAN, axis=1)[:, None]
NORTH = np.stack([-TAN[:, 1], TAN[:, 0]], 1)   # 西向き進行の右手=北(−z)側を + にする
# 符号確認: 西向き(−x)で右は北(−z)。TAN=(-1,0) -> (-0,-1) = 北。OK

def sstep(a, b, s):
    t = np.clip((s - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def track(offset_fn, s0=0.0, s1=None):
    s1 = TOTAL if s1 is None else s1
    m = (ARC >= s0) & (ARC <= s1)
    off = np.array([offset_fn(s) for s in ARC[m]])
    return C[m] + NORTH[m] * off[:, None]

# 現電停の終端: 北線(発車) z=-6.05 / 南線(到着) z=-0.19 → 中心線 z=-3.1 から ±2.95
def off_N(s):   # 北側の本線（発車線）: ±2.95 → +1.65 → 停留場手前で 2番線(+1.6)へ
    return 2.95 + (1.65 - 2.95) * sstep(0, 22, s) + (1.6 - 1.65) * sstep(55, 70, s)
def off_S(s):   # 南側の本線（到着線）: -2.95 → -1.65 → 3番線(-5.2)へ
    return -2.95 + (-1.65 + 2.95) * sstep(0, 22, s) + (-5.2 + 1.65) * sstep(48, 70, s)
def off_T1(s):  # 1番線（北の片面ホーム側）: 北線から分岐
    return off_N(s) + (5.0 - off_N(s)) * sstep(44, 66, s)
def off_X(s):   # 到着線から 2番線への渡り
    return off_S(min(s, 44)) + (1.6 - off_S(min(s, 44))) * sstep(44, 68, s)

def build():
    T_N = track(off_N); T_S = track(off_S)
    T_1 = track(off_T1, 40.0); T_X = track(off_X, 40.0, 80.0)
    tracks = [dict(xy=T_N, service="station"), dict(xy=T_S, service="station"),
              dict(xy=T_1, service="station"), dict(xy=T_X, service="station")]
    # ホーム: 北の片面（1番線用）、2番線・3番線の間の島式
    def band(o0, o1, s0=S_STOP0, s1=S_STOP1):
        m = (ARC >= s0) & (ARC <= s1)
        a = C[m] + NORTH[m] * o0; b = C[m] + NORTH[m] * o1
        return Polygon(np.vstack([a, b[::-1]]))
    side = band(6.4, 9.2)
    island = band(0.2, -3.8)
    plats = [dict(xy=np.array(side.exterior.coords)[:-1], name="岡山駅前(新)1番のりば", covered=True, bigroof=True),
             dict(xy=np.array(island.exterior.coords)[:-1], name="岡山駅前(新)2・3番のりば", covered=True, bigroof=True)]
    # 屋根: 公表イメージの大屋根（片流れ・濃灰）。ホームと線路をまとめて覆う
    roof = band(10.0, -6.8, S_STOP0 - 2, S_STOP1 + 1)
    clear = LineString(C).buffer(9.0)     # 延伸区間で撤去・移設される既存物の範囲
    grass = band(10.5, -7.5, 58.0, TOTAL)  # 芝生軌道の範囲（イメージ図）。v21: 駅前交差点（市役所筋・バスの出口が軌道を渡る所）は舗装のまま（s≈54 より西から芝生）
    return dict(tracks=tracks, platforms=plats, roof=roof, clear=clear, grass=grass,
                stop_s=(S_STOP0, S_STOP1))

def departure_prefix(line_off, s_front):
    """停留場の s_front（車両先頭位置）から東へ現電停の終端まで（東向きの点列）"""
    m = ARC <= s_front
    P = C[m] + NORTH[m] * np.array([line_off(s) for s in ARC[m]])[:, None]
    return P[::-1]
