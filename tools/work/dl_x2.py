import pickle, os, sys
from remotezip import RemoteZip
from concurrent.futures import ThreadPoolExecutor
url="https://assets.cms.plateau.reearth.io/assets/0a/984fc5-6af6-4a7c-9188-d825eea4a17f/33100_okayama-shi_city_2025_citygml_1_op.zip"
L=pickle.load(open("/tmp/list2025.pkl","rb"))
codes=[f"513377{a}{b}" for a in "56789" for b in "0123456789"]+[f"523307{a}{b}" for a in "01234" for b in "0123456789"]
want=[n for n,s in L if not n.endswith("/") and any(n.startswith(f"udx/{ly}/{c}_") for ly in ("bldg","tran","veg","frn") for c in codes)]
want=[n for n in want if not os.path.exists("/tmp/p25/"+n)]
print("files to fetch", len(want), flush=True)
def work(chunk):
    with RemoteZip(url) as z:
        for n in chunk:
            out=os.path.join("/tmp/p25",n)
            if os.path.exists(out): continue
            os.makedirs(os.path.dirname(out),exist_ok=True)
            for attempt in range(4):
                try:
                    with z.open(n) as src, open(out+".part","wb") as dst:
                        while True:
                            b=src.read(1<<20)
                            if not b: break
                            dst.write(b)
                    os.rename(out+".part",out); print("ok",n,flush=True); break
                except Exception as e:
                    print("retry",n,e,flush=True)
chunks=[want[i::4] for i in range(4)]
with ThreadPoolExecutor(4) as ex: list(ex.map(work,chunks))
print("ALL DONE", flush=True)
