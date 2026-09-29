#!/bin/bash
cd /home/claude/wx/osm_new2
EP=https://overpass.openstreetmap.fr/api/interpreter
for pair in "q_cur.txt osm_cur.json" "qx_cur.txt extra_cur.json"; do
  set -- $pair
  for i in 1 2 3 4 5 6; do
    code=$(curl -sS -m 1500 -A "okayama-sim/1.0" --data-urlencode "data@$1" $EP -o $2.part -w "%{http_code}" 2>>fr.err)
    echo "$(date +%T) $2 try $i -> $code $(stat -c %s $2.part 2>/dev/null)"
    if [ "$code" = "200" ] && python3 -c "import json;d=json.load(open('$2.part'));assert len(d['elements'])>100 and 'remark' not in d, d.get('remark')" 2>>fr.err; then mv $2.part $2; break; fi
    sleep 90
  done
done
echo ALLDONE
