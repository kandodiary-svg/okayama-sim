#!/bin/bash
# v30（v29 から）stage 2: 範囲拡大（bounds.json の範囲）で全部を作り直す。途中で止まっても、出来ている段はとばして続きから（DONE 印）
set -e
P=/home/claude/pipeline-x
W=/home/claude/wx
L=${LOGDIR:-$W/logs/s2}
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
  if [ "$name" == "${STOP_AFTER:-}" ]; then echo "stop after $name"; exit 0; fi
}
# 0) OSM（v28 の範囲の中は v28 のまま）
step osm $M merge_osm.py osm_cur.json extra_cur.json v30
# 1) 地形・土地利用・航空写真
step dem $M parse_dem.py
step luse $M parse_luse.py
step ortho $M fetch_ortho.py
# 2) PLATEAU（全域）
prep_dirs(){ rm -rf $W/out_bldg $W/out_tran $W/out_veg; mkdir -p $W/out_bldg $W/out_tran $W/out_veg; }
step dirs prep_dirs
step bldg env NPROC=2 BLDG_BUF=1e9 BLDG_BUS_BUF=1e9 FIX_FLAT_WALLS=1 $M parse_bldg.py
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
# v41.20: 道路のトンネル（路面・壁・天井。roads.py が書いた tunnels_prof.pkl から）
step tunnels $M tunnels.py
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
# v30: traffic.json の点列を別ファイル（バイナリ）に
step compact $M compact_traffic.py
# v41.21: 車線の位置合わせ。traffic.py の出力は車線が詰まって並ぶ（同じ向きの隣と 1.8m）ので、compact の後に必ず流す（traffic_align2.py は v41.8 の traffic_align.py の処理を含む）。
#   v41.20 はこの段を流し忘れて公開した（大通りの同じ向きの隣の車線が 3.1m → 1.8m に戻り、白線の間を走らなくなった）。
#   退避ファイル（traffic_pre_align.*）と白線の点のキャッシュは前の出力のものなので消してから流す。
align_traffic(){ rm -f $W/traffic_pre_align.json $W/traffic_pts_pre_align.txt /tmp/markq.npy /tmp/markdirs.npz; python3 $W/memrun.py python3 traffic_align2.py; }
step align align_traffic
# v41.21: トンネルの床の幅を車線に合わせる（次に tunnels 段を流す時の入力 tunnel_fit.json。この回の値と違えば build をやり直す）
step tunnelfit python3 tunnel_fit.py
# v41.21: 車線の高さに合う層が走行格子に無い所（立体交差の下をくぐる道・堤防の下・高架の面の穴）へ層を足す（位置合わせの後＝最終の車線の点列がある）
step underfill $M lane_underfill.py
# 山陽道（mw.bin）の高さを走行格子にそろえる（走行格子を作り直したら毎回。元の mw.bin は mw.bin.v38.bak）
restore_mw(){ cp /home/claude/okaden-x/mw.bin.v38.bak /home/claude/okaden-x/data/mw.bin && python3 mw_join.py --apply; }
step mwjoin restore_mw
echo "$(date +%T) ALL DONE"
