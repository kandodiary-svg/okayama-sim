#!/bin/bash
# v29 stage 2: 範囲拡大（bounds.json の範囲）で全部を作り直す。途中で止まっても、出来ている段はとばして続きから（DONE 印）
set -e
P=/home/claude/pipeline-x
W=/home/claude/wx
L=$W/logs/s2
mkdir -p $L
cd $P
M="python3 $W/memrun.py python3"
step(){ # step 名前 コマンド...
  local name=$1; shift
  if [ -f $L/$name.DONE ]; then echo "skip $name"; return 0; fi
  echo "$(date +%T) start $name"
  "$@" > $L/$name.log 2>&1
  touch $L/$name.DONE
  echo "$(date +%T) done $name $(tail -1 $L/$name.log)"
}
# 0) OSM（v28 の範囲の中は v28 のまま）
step osm $M merge_osm.py osm_cur.json extra_cur.json
# 1) 地形・土地利用・航空写真
step dem $M parse_dem.py
step luse $M parse_luse.py
step ortho $M fetch_ortho.py
# 2) PLATEAU（全域）
prep_dirs(){ rm -rf $W/out_bldg $W/out_tran $W/out_veg; mkdir -p $W/out_bldg $W/out_tran $W/out_veg; }
step dirs prep_dirs
step bldg env NPROC=2 BLDG_BUF=1e9 BLDG_BUS_BUF=1e9 $M parse_bldg.py
step tran env NPROC=2 TRAN_BUF=1e9 $M parse_tran.py
step veg env NPROC=2 VEG_BUF=1e9 $M parse_veg.py
step trees env TREE_BUF=1e9 $M parse_trees.py
# 3) 道路（v28 の道路＋足りない所）
step roads env ROADS_OUT=$W/roads_new.pkl RELIEF_GRID=0.6 $M roads.py
step merge $M merge_roads.py
rm_v10(){ rm -f $W/roads_final_v10.pkl; }
step rmv10 rm_v10
step bridges $M patch_bridges.py
step gaps $M gap_roads.py
restore_marks(){ cp $W/markings_v13_core.pkl $W/markings_v13.pkl; cp $W/markings_core.pkl $W/markings.pkl; rm -f $W/markings_ext.pkl; }
step marks0 restore_marks
step marks env MARK_ALL=1 MARK_EXT=1 $M markings.py
# 4) 組み立て
step build env TILE_PAGES=9 TEX_BUDGET=430e6 $M build_v5.py
restore_turn(){ cd /home/claude/okaden-x/data && python3 - <<'PY'
import json,numpy as np
a=json.load(open('routes.json')); old=json.load(open('/home/claude/wx/routes_v12_local.json'))
t=old['turn']
for k,v in t.items():
    for key in ('pull','back'):
        if v.get(key):
            tr=np.array(a['higashi' if 'higashi' in k else 'seiki']['track'])
            P=np.array(v[key])
            for q in P:
                d=np.hypot(tr[:,0]-q[0],tr[:,2]-q[2]); i=np.argmin(d)
                if d[i]<3: q[1]=tr[i,1]
            v[key]=P.round(3).tolist()
a['turn']=t
json.dump(a,open('routes.json','w'),ensure_ascii=False,separators=(',',':'))
print('turn restored')
PY
cd $P; }
step turn restore_turn
step traffic $M traffic.py
step bus $M bus_route.py
step places $M places.py
step signals $M signals.py
step peds $M peds.py
step jr $M jr.py
echo "$(date +%T) ALL DONE"
