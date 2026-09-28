"""街路設備(LOD3) -> /home/claude/wx/out_frn.pkl  {function: tris}"""
import sys, os, pickle
import numpy as np
from lxml import etree
sys.path.insert(0, os.path.dirname(__file__))
from common import proj_arr, triangulate, strip_closing
G="{http://www.opengis.net/gml}"; F="{http://www.opengis.net/citygml/cityfurniture/2.0}"
out={}
for ev,el in etree.iterparse("/home/claude/wx/p25/udx/frn/51337793_frn_6697_op.gml",tag=F+"CityFurniture",huge_tree=True):
    fn=(el.findtext(F+"function") or "0").strip()
    tris=[]
    for poly in el.iter(G+"Polygon"):
        ext=poly.find(G+"exterior/"+G+"LinearRing/"+G+"posList")
        if ext is None: continue
        rings=[strip_closing(proj_arr(np.array(ext.text.split(),float).reshape(-1,3)))]
        for it in poly.findall(G+"interior/"+G+"LinearRing/"+G+"posList"):
            rings.append(strip_closing(proj_arr(np.array(it.text.split(),float).reshape(-1,3))))
        if len(rings[0])<3: continue
        v,idx=triangulate(rings)
        if v is None: continue
        tris.append(v[idx.reshape(-1)])
    if tris:
        t=np.concatenate(tris).astype(np.float32)
        out.setdefault(fn,[]).append(t)
        c=t.mean(0); print(fn, len(t)//3, "tris at x=%.0f z=%.0f"%(c[0],c[2]))
    el.clear()
out={k:np.concatenate(v) for k,v in out.items()}
pickle.dump(out,open("/home/claude/wx/out_frn.pkl","wb"))
print({k:len(v)//3 for k,v in out.items()})
