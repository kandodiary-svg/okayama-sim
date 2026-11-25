import json,numpy as np,pickle
from shapely.geometry import Polygon
from shapely.ops import unary_union
import glob
a=np.array([r for f in glob.glob('/tmp/v56/roofs_*.txt')+['/tmp/roofs.txt'] if __import__('os').path.exists(f) for r in json.load(open(f))])
# dedupe triangles
key=lambda r: tuple(np.round(r[:6],0))
uniq={};
for r in a: uniq.setdefault(key(r),r)
a=np.array(list(uniq.values()))
n=len(a); par=list(range(n))
def f(i):
    while par[i]!=i: par[i]=par[par[i]]; i=par[i]
    return i
vm={}
for i,r in enumerate(a):
    for k in range(3):
        vk=(round(r[2*k]*2),round(r[2*k+1]*2))
        if vk in vm: par[f(i)]=f(vm[vk])
        else: vm[vk]=i
G={}
for i in range(n): G.setdefault(f(i),[]).append(i)
B=[]
for g in G.values():
    polys=[Polygon([(a[i][0],a[i][1]),(a[i][2],a[i][3]),(a[i][4],a[i][5])]).buffer(0.05) for i in g]
    u=unary_union(polys)
    if u.area<40: continue
    h=max(a[i][7] for i in g)
    B.append(dict(poly=u, h=h, area=u.area, c=(u.centroid.x,u.centroid.y)))
B.sort(key=lambda b:-b['h'])
pickle.dump(B,open('bldgs2.pkl','wb'))
print(len(B))
for k,b in enumerate(B[:80]): print(k, round(b['h']), round(b['area']), [round(x) for x in b['c']])
