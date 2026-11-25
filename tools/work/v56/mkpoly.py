import pickle,sys
from shapely.geometry import Polygon
B=pickle.load(open('bldgs2.pkl','rb'))
def poly(k,buf=0.8,tol=0.5,hmin=None):
    p=B[k]['poly']
    if p.geom_type!='Polygon': p=max(p.geoms,key=lambda g:g.area)
    p=Polygon(p.exterior).buffer(buf,join_style=2).simplify(tol)
    return [[round(x,1),round(y,1)] for x,y in p.exterior.coords][:-1]
for k in map(int,sys.argv[1:]): print(k, str(poly(k)).replace(' ',''))
