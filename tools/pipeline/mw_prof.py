"""v37: 山陽道の縦断（道路面の高さ）を解く。mw.py の chain を読み、wx/exp/mw_prof.pkl に書く。
目的関数: Σ w_i (h_i − T_i)²（地形に沿う。橋は w=0.01・トンネルは 0.002）+ Σ λ_i (h_{i-1} − 2h_i + h_{i+1})²（なめらか）
          + 接続の一致（ジャンクションのノード・上下線の近い所）。 λ=(ℓ/5)⁴ で ℓ=250m が基準。勾配が上限を超えた所は ℓ を伸ばして解き直す。"""
import os, sys, pickle, collections, math
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mw import DS, EXP, build
from common import in_data

GMAX = {"main": 0.032, "link": 0.06, "stub": 0.05}
ELL0 = 250.0

def pair_chains(C, maxgap=45.0):
    """上下線: 各点について、右側（中央帯側）にある逆向きの chain の最も近い点（gap m）。戻り: gap 配列, 相手 (chain, idx)"""
    allQ = np.concatenate([c["Q"] for c in C]); own = np.concatenate([[k] * len(c["Q"]) for k, c in enumerate(C)])
    loc = np.concatenate([np.arange(len(c["Q"])) for c in C])
    tr = cKDTree(allQ)
    for k, c in enumerate(C):
        Q = c["Q"]; n = len(Q)
        t = np.gradient(Q, axis=0); t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
        # 右（進行方向の右 = (z 軸が南なので) x=東,z=南 の座標では、進行 (tx,tz) の右は (-tz, tx)）
        rgt = np.stack([-t[:, 1], t[:, 0]], axis=1)
        c["tan"] = t; c["rgt"] = rgt
        gap = np.zeros(n, np.float32); pc = np.full(n, -1, np.int32); pi = np.full(n, -1, np.int32)
        if c["kind"] == "stub" and False: continue
        d, ids = tr.query(Q, k=12, distance_upper_bound=maxgap)
        for q in range(n):
            best = None
            for dd, ii in zip(d[q], ids[q]):
                if not np.isfinite(dd): break
                if own[ii] == k: continue
                o = C[own[ii]]; j = loc[ii]
                if o["kind"] == "stub" and c["kind"] != "stub": pass
                v = allQ[ii] - Q[q]
                side = v @ rgt[q]
                if side <= 0.5: continue                       # 右側にあるものだけ
                to = o["tan"][j] if "tan" in o else None
                if to is None: continue
                if t[q] @ to > -0.7: continue                   # 逆向き
                if abs(v @ t[q]) > 0.6 * max(dd, 1.0) + 3: continue   # 真横に近い
                best = (dd, own[ii], j); break
            if best: gap[q] = best[0]; pc[q] = best[1]; pi[q] = best[2]
        c["gap"] = gap; c["pc"] = pc; c["pi"] = pi

def run():
    C = build()
    pair_chains(C)
    print("paired samples", sum(int((c["gap"] > 0).sum()) for c in C), flush=True)
    for c in C: c["ellk"] = np.ones(len(c["Q"])); c["act"] = np.zeros(len(c["Q"]) - 1, np.int8)     # act: 勾配の制約を入れた区間（+1 上り・-1 下り）
    for it in range(30):
        hs = solve_pt(C)
        bad_total = 0; new_total = 0
        for k, c in enumerate(C):
            dh = np.diff(hs[k]); lim = GMAX[c["kind"]] * DS
            viol = np.abs(dh) > lim * 1.02
            new = viol & (c["act"] == 0)
            c["act"] = np.where(new, np.sign(dh), c["act"]).astype(np.int8)
            bad_total += int(viol.sum()); new_total += int(new.sum())
        print("iter", it, "violating", bad_total, "newly active", new_total, flush=True)
        if bad_total == 0: break
    for k, c in enumerate(C): c["h"] = hs[k]
    return C

def solve_pt(C):
    off = np.cumsum([0] + [len(c["Q"]) for c in C]); N = off[-1]
    R = []; Cc = []; V = []; B = []; nr = 0
    def addm(rr, cc, vv, bb):
        nonlocal nr
        R.append(rr + nr); Cc.append(cc); V.append(vv); B.append(bb); nr += len(bb)
    for k, c in enumerate(C):
        n = len(c["Q"]); o = off[k]; idx = np.arange(n)
        w = np.where(c["tn"], 0.002, np.where(c["br"], 0.01, 1.0)); sw = np.sqrt(w)
        addm(idx, o + idx, sw, sw * c["Ts"])
        if n >= 3:
            m = np.arange(1, n - 1); lam = ((ELL0 * c["ellk"][m]) / DS) ** 4; sl = np.sqrt(lam)
            rr = np.arange(len(m))
            addm(np.concatenate([rr, rr, rr]), np.concatenate([o + m - 1, o + m, o + m + 1]), np.concatenate([sl, -2 * sl, sl]), np.zeros(len(m)))
    node_pos = collections.defaultdict(list)
    for k, c in enumerate(C):
        step = c["s"][-1] / (len(c["Q"]) - 1)
        for nid, s in c["nodepos"].items():
            j = min(int(round(s / step)), len(c["Q"]) - 1)
            node_pos[nid].append((k, j))
    tr = []; tc = []; tv = []; q = 0
    for nid, lst in node_pos.items():
        if len(lst) < 2: continue
        k0, j0 = lst[0]
        for k1, j1 in lst[1:]:
            if k1 == k0 and abs(j1 - j0) < 3: continue
            tr += [q, q]; tc += [off[k0] + j0, off[k1] + j1]; tv += [100.0, -100.0]; q += 1
    if q: addm(np.array(tr), np.array(tc), np.array(tv), np.zeros(q))
    pr = []; pcc = []; pv = []; q = 0
    for k, c in enumerate(C):
        sel = np.flatnonzero((c["gap"] > 0) & (c["pc"] > k))[::2]
        for i in sel:
            pr += [q, q]; pcc += [off[k] + i, off[c["pc"][i]] + c["pi"][i]]; pv += [3.0, -3.0]; q += 1
    if q: addm(np.array(pr), np.array(pcc), np.array(pv), np.zeros(q))
    # 勾配の上限（制約を入れた区間は、その勾配の上限に固定するペナルティ）
    for k, c in enumerate(C):
        act = np.flatnonzero(c["act"] != 0)
        if len(act) == 0: continue
        o = off[k]; tgt = c["act"][act] * GMAX[c["kind"]] * DS * 0.995; mu = 6000.0
        rr = np.arange(len(act))
        addm(np.concatenate([rr, rr]), np.concatenate([o + act + 1, o + act]), np.concatenate([np.full(len(act), mu), np.full(len(act), -mu)]), mu * tgt)
    Rr = np.concatenate(R); Cc_ = np.concatenate(Cc); Vv = np.concatenate(V); Bb = np.concatenate(B)
    A = sparse.csr_matrix((Vv, (Rr, Cc_)), shape=(nr, N))
    AtA = (A.T @ A).tocsc(); Atb = A.T @ Bb
    h = splu(AtA).solve(Atb)
    return [h[off[k]:off[k + 1]] for k in range(len(C))]

if __name__ == "__main__":
    C = run()
    for c in C:
        d = c["Ts"] - c["h"]
        g = np.abs(np.diff(c["h"])) / DS
        if c["kind"] == "main": print(c["ci"], round(c["L"]), "grade max %.3f p99 %.3f" % (g.max(), np.percentile(g, 99)), "cut(T-h) min %.1f max %.1f" % (d.min(), d.max()), "tn cover min %.1f" % (d[c["tn"]].min() if c["tn"].any() else 0))
    pickle.dump(C, open(f"{EXP}/mw_prof.pkl", "wb"))
