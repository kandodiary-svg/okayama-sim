import sys, os, math, numpy as np, shapely
sys.path.insert(0,'/home/claude/pipeline-x')
from shapely.geometry import box
from scipy import ndimage
import common, importlib; STR = importlib.import_module(os.environ.get('STRMOD','structures'))
cx, cz, hw = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
tag = sys.argv[4]
R = common.load_roads('/home/claude/wx/roads_final.pkl')
HR = R['HR']; GX0,GZ0,RES = R['grid'] if 'grid' in R else (-4048,-4692,0.5)
d = np.load('/home/claude/wx/dem_grid.npz'); DX0,DZ0,DS = float(d['x0']),float(d['z0']),float(d['step']); DH=d['H'].astype(np.float64)
# 窓の DEM 節点
i0=int((cx-hw-60-DX0)//DS); i1=int((cx+hw+60-DX0)//DS)+2; j0=int((cz-hw-60-DZ0)//DS); j1=int((cz+hw+60-DZ0)//DS)+2
nx=i1-i0; nz=j1-j0
nz=min(nz,DH.shape[0]-j0); j1=j0+nz
Hg_orig=DH[j0:j1,i0:i1].copy()
# HRMIN 窓 ±4m
fac=int(round(DS/RES)); hwc=fac
r0=int((DZ0+j0*DS-GZ0)/RES)-60; r1=int((DZ0+j1*DS-GZ0)/RES)+60
c0=int((DX0+i0*DS-GX0)/RES)-60; c1=int((DX0+i1*DS-GX0)/RES)+60
rA=max(r0,0); rB=min(r1,HR.shape[0]); cA=max(c0,0); cB=min(c1,HR.shape[1])
h=np.full((r1-r0,c1-c0),np.nan,np.float32); h[rA-r0:rB-r0,cA-c0:cB-c0]=np.asarray(HR[rA:rB,cA:cB],np.float32); nr=~np.isfinite(h)
mf=ndimage.minimum_filter(np.where(nr,np.inf,h),size=2*hwc+1,mode='constant',cval=np.inf)
dd,(ji,ii)=ndimage.distance_transform_edt(nr,return_indices=True)
rr=(np.round((DZ0+(np.arange(nz)+j0)*DS-GZ0)/RES).astype(int)-r0)
cc=(np.round((DX0+(np.arange(nx)+i0)*DS-GX0)/RES).astype(int)-c0)
sub=mf[np.ix_(rr,cc)]; Hg=Hg_orig.copy(); fin=np.isfinite(sub); Hg[fin]=np.minimum(Hg[fin],sub[fin]-0.08)
dist=dd[np.ix_(rr,cc)]*RES; hn=h[ji[np.ix_(rr,cc)],ii[np.ix_(rr,cc)]]
cap=np.where(dist<=12.0, hn-0.08+1.0*np.maximum(0,dist-0.5), np.inf)
Hg=np.minimum(Hg,cap)
GR=STR.Ground(np.round(Hg*100).astype(np.int16),np.zeros_like(Hg,np.uint8),DX0+i0*DS,DZ0+j0*DS,DS)
GRo=STR.Ground(np.round(Hg_orig*100).astype(np.int16),np.zeros_like(Hg,np.uint8),DX0+i0*DS,DZ0+j0*DS,DS)
DK=STR.Deck(HR,(GX0,GZ0,RES),R.get('upper'))
bparts=[q for q in (R.get('bridge_parts') or []) if q is not None and not q.is_empty]
bun=shapely.union_all(bparts) if bparts else None
if bun is not None: shapely.prepare(bun)
PI=common.PartsIndex(list(common.road_parts(R,'lanes'))+list(common.road_parts(R,'raised')))
tiles=[(cx-hw,cz-hw,cx+hw,cz+hw)]
sk,skc=STR.road_skirts(PI,tiles,bun,DK,GR,0.35)
cf,cfc=STR.cut_faces(PI,tiles,bun,DK,GRo,1.0,0.3,12.0)
WB=box(cx-hw-30,cz-hw-30,cx+hw+30,cz+hw+30)
bp_loc=[q for q in bparts if q.intersects(WB)]
def dem_at(x,z): return np.full(np.shape(x),0.0)
BS=STR.bridge_structures(bp_loc,DK,dem_at,[],DK.lower,[],STR.grid_split,lambda *a,**k:np.zeros((0,3))) if bp_loc else dict(sides=np.zeros((0,3)),rails=np.zeros((0,3)))
import pickle
pickle.dump(dict(sk=sk,skc=skc,cf=cf,cfc=cfc,cx=cx,cz=cz,hw=hw,bs=BS),open(f'/home/claude/wx/gore/{tag}.pkl','wb'))
# 図
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
fig,ax=plt.subplots(1,2,figsize=(18,9))
loc=PI.near(box(cx-hw,cz-hw,cx+hw,cz+hw))
for a in ax:
    for g in (loc.geoms if hasattr(loc,'geoms') else [loc]):
        if g.geom_type=='Polygon': a.plot(*g.exterior.xy,'k-',lw=0.5)
    # 橋
    if bun is not None:
        b=bun.intersection(box(cx-hw,cz-hw,cx+hw,cz+hw))
        for g in (b.geoms if hasattr(b,'geoms') else [b]):
            if g.geom_type=='Polygon': a.fill(*g.exterior.xy,color='#ccccff',alpha=.5)
def draw(a,t,c,mode):
    T=t.reshape(-1,3,3); m=(np.abs(T[:,:,0].mean(1)-cx)<hw)&(np.abs(T[:,:,2].mean(1)-cz)<hw)
    T=T[m]; C=c.reshape(-1,3,3)[m][:,0]
    xy=T[:,:,[0,2]]
    if mode=='col': pc=PolyCollection(xy,facecolors=C,edgecolors='none',alpha=.8)
    a.add_collection(pc)
draw(ax[0],cf,cfc,'col'); draw(ax[0],sk,skc,'col')
for nm,colr in (('sides','#c06020'),('rails','#2020c0')):
    T=BS[nm].reshape(-1,3,3)
    if len(T): ax[0].add_collection(PolyCollection(T[:,:,[0,2]],facecolors='none',edgecolors=colr,lw=0.6))
ax[0].set_xlim(cx-hw,cx+hw); ax[0].set_ylim(cz+hw,cz-hw); ax[0].set_aspect('equal'); ax[0].set_title('plan: cut(green) skirt(earth/conc)')
# 高さ
T=np.concatenate([sk,cf]).reshape(-1,3,3); m=(np.abs(T[:,:,0].mean(1)-cx)<hw)&(np.abs(T[:,:,2].mean(1)-cz)<hw); T=T[m]
pc=PolyCollection(T[:,:,[0,2]],array=T[:,:,1].mean(1),cmap='terrain',edgecolors='none'); ax[1].add_collection(pc); plt.colorbar(pc,ax=ax[1])
ax[1].set_xlim(cx-hw,cx+hw); ax[1].set_ylim(cz+hw,cz-hw); ax[1].set_aspect('equal'); ax[1].set_title('height')
plt.tight_layout(); plt.savefig(f'/home/claude/wx/gore/{tag}.png',dpi=70)
print('ok',len(sk)//3,len(cf)//3)
