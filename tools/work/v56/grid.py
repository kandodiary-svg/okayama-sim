import hashlib,urllib.parse,sys,json
def u(n,w=960):
    n=n.replace(' ','_'); h=hashlib.md5(n.encode()).hexdigest(); e=urllib.parse.quote(n)
    return f"https://thumb.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{e}/{w}px-{e}"
U=[u(f) for f in sys.argv[1:]]
cols=2 if len(U)<=4 else 3; rows=(len(U)+cols-1)//cols; hv=98//rows
imgs="".join(f"<img src='{x}' style='width:100%;height:{hv}vh;object-fit:contain'>" for x in U)
print("document.documentElement.innerHTML="+json.dumps(f"<body style='margin:0;background:#000;display:grid;grid-template-columns:repeat({cols},1fr);gap:2px'>{imgs}</body>")+";1")
