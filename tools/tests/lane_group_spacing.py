"""同じ道（fr,to）の中の隣り合う車線の横距離の分布（v41.12）"""
import os
import numpy as np, collections
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lane_common.py")).read())
G=collections.defaultdict(list)
for i,e in enumerate(T["lanes"]):
    G[(e["fr"],e["to"],e["c"])].append(i)
def lat_between(a,b):
    """レーン a の各点から b までの横距離（a の進行方向に直角）の中央値と、b が a の左右どちらか"""
    Pa=A[T["lanes"][a]["o"]:T["lanes"][a]["o"]+T["lanes"][a]["m"]][:,[0,2]]
    Pb=A[T["lanes"][b]["o"]:T["lanes"][b]["o"]+T["lanes"][b]["m"]][:,[0,2]]
    if len(Pa)<3 or len(Pb)<3: return None
    t=np.gradient(Pa,axis=0); t/=np.maximum(np.hypot(*t.T)[:,None],1e-9)
    mid=slice(len(Pa)//4, max(len(Pa)//4+1, 3*len(Pa)//4))
    out=[]
    for i in range(len(Pa))[mid]:
        d=Pb-Pa[i]; al=d@t[i]; j=np.argmin(np.abs(al)); lat=d[j,0]*t[i,1]-d[j,1]*t[i,0]
        out.append(lat)
    return float(np.median(out))
rows=[]
for key,ids in G.items():
    if len(ids)<2: continue
    ids=sorted(ids,key=lambda i:T["lanes"][i]["k"])
    for a,b in zip(ids[:-1],ids[1:]):
        if T["lanes"][b]["k"]!=T["lanes"][a]["k"]+1: continue
        l=lat_between(a,b)
        if l is not None: rows.append((key[2],T["lanes"][a]["n"],abs(l), T["lanes"][a]["m"]))
rows=np.array([(r[1],r[2],r[3]) for r in rows if r[0] in "pst"])
print("同じ辺・同じ向きの隣り合う車線の組:", len(rows))
for n in (2,3,4):
    m=rows[:,0]==n; v=rows[m,1]
    print("n=",n,len(v),"中央値 %.2f  <2.0m %.0f%%  <2.4m %.0f%%  2.8〜3.8m %.0f%%"%(np.median(v),100*(v<2.0).mean(),100*(v<2.4).mean(),100*((v>2.8)&(v<3.8)).mean()))
h,_=np.histogram(rows[:,1],bins=np.arange(0,6.01,0.25)); print(" ".join(f"{a:.2f}:{c}" for a,c in zip(np.arange(0,6,0.25),h)))
