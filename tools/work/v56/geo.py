import urllib.request,urllib.parse,json,math,pickle,sys
from shapely.geometry import Point
B=pickle.load(open('bldgs2.pkl','rb'))
KX=math.cos(34.66551*math.pi/180)*111320
for name,addr in [l.split('=') for l in sys.argv[1:]]:
    r=json.load(urllib.request.urlopen("https://msearch.gsi.go.jp/address-search/AddressSearch?q="+urllib.parse.quote("岡山市北区"+addr),timeout=20))
    if not r: print(name,'none'); continue
    lon,lat=r[0]['geometry']['coordinates']; x=(lon-133.91968)*KX; z=(34.66551-lat)*110540
    c=sorted(((b['poly'].distance(Point(x,z)),k) for k,b in enumerate(B) if b['h']>10))[:3]
    print(name,r[0]['properties']['title'][9:],round(x),round(z),' '.join(f"#{k}:d{d:.0f},h{B[k]['h']:.0f},A{B[k]['area']:.0f}" for d,k in c))
