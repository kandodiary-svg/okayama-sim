"""同じ向きの隣の車線との間隔（中央値・<2.0m の割合）。OUT_DIR の traffic.json を測る（v41.12）。MARK_CACHE/MARK_DIRS は traffic_align2.py が作る"""
import os
import numpy as np
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lane_common.py")).read())
from scipy.spatial import cKDTree
pts=[]; dirs=[]; lid=[]; cls=[]; nn=[]; arc=[]; rem=[]
for i,e in enumerate(T["lanes"]):
    if e["c"] in ("u","r"): continue
    P=A[e["o"]:e["o"]+e["m"]][:,[0,2]]
    d=np.r_[0,np.cumsum(np.hypot(*np.diff(P,axis=0).T))]
    if d[-1]<40: continue
    s=np.arange(15,d[-1]-15,2.0)
    if len(s)<2: continue
    xz=np.stack([np.interp(s,d,P[:,0]),np.interp(s,d,P[:,1])],1)
    t=np.gradient(xz,axis=0); t/=np.maximum(np.hypot(*t.T)[:,None],1e-9)
    pts.append(xz); dirs.append(t); lid+= [i]*len(xz); cls+=[e["c"]]*len(xz); nn+=[e["n"]]*len(xz)
pts=np.concatenate(pts); dirs=np.concatenate(dirs); lid=np.array(lid); cls=np.array(cls); nn=np.array(nn)
tree=cKDTree(pts); nb=tree.query_ball_point(pts,3.0)
mind_same=np.full(len(pts),9.0); mind_opp=np.full(len(pts),9.0)
for i,ids in enumerate(nb):
    for j in ids:
        if lid[j]==lid[i]: continue
        dd=dirs[i]@dirs[j]
        if abs(dd)<0.9: continue
        r=pts[j]-pts[i]; lat=abs(r[0]*dirs[i][1]-r[1]*dirs[i][0]); al=abs(r@dirs[i])
        if al>2.5: continue
        if dd>0: mind_same[i]=min(mind_same[i],lat)
        else: mind_opp[i]=min(mind_opp[i],lat)
m=np.isin(cls,["p","s","t"])
print("車線の中ほど（両端 15m を除く）の点:", m.sum())
for name,arr in (("同じ向きの隣",mind_same),("反対向きの隣",mind_opp)):
    print(name, " <1.8m %.1f%%  <2.4m %.1f%%  <2.9m %.1f%%" % tuple(100*(arr[m]<v).mean() for v in (1.8,2.4,2.9)))
for k in (1,2,3,4):
    mm=m&(nn==k); print("n=",k, mm.sum(), "同向<2.4m %.1f%%  反対向<2.4m %.1f%%"%(100*(mind_same[mm]<2.4).mean(),100*(mind_opp[mm]<2.4).mean()))
# 同向で <2.4m の分布の例の位置
idx=np.where(m&(mind_same<2.4))[0]
print("例:", [(round(float(pts[i,0])),round(float(pts[i,1])),round(float(mind_same[i]),2),int(nn[i]),cls[i]) for i in idx[::max(1,len(idx)//12)][:12]])
print("--- 同じ向きの隣までの距離（n=2・n=3 の車線の中ほど）---")
for k in (2,3):
    mm=m&(nn==k)&(mind_same<5)
    h,_=np.histogram(mind_same[mm],bins=np.arange(0,5.01,0.2))
    print("n=",k, " ".join(f"{a:.1f}:{100*c/mm.sum():.0f}" for a,c in zip(np.arange(0,5,0.2),h) if c/mm.sum()>0.01))
