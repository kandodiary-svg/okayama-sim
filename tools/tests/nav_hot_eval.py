import sys,json
s=open("/home/claude/okaden-x/app.js",encoding="utf-8").read()
a=s.index("const Nav = (() => {"); b=s.index("Nav.ui.init();")
code=s[a:b]
test=open(sys.argv[1],encoding="utf-8").read()
shim='''const Traffic=__Traffic, Car=__Car, S=__S, Snd=__Snd, Loc=__Loc, MW=__MW, JR=__JR, scene=__scene, pathPt=__pathPt, pathTan=(p,s)=>{const a=__pathPt(p,s-2),b=__pathPt(p,s+2);const dx=b.x-a.x,dz=b.z-a.z,L=Math.hypot(dx,dz)||1;return {x:dx/L,y:0,z:dz/L};}, $=(i)=>document.getElementById(i);
const Prefs={soundOn:true,getM:(k,d)=>d,setM(){}}; const canvasTex=(w,h,d)=>{const c=document.createElement("canvas");c.width=w;c.height=h;d(c.getContext("2d"),w,h);return new THREE.CanvasTexture(c);};
'''
out="(() => {\n"+shim+code+"\n"+test+"\n})()"
open(sys.argv[2],"w",encoding="utf-8").write(out)
