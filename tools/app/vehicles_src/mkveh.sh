#!/bin/bash
# vehicles.js（車・トラック・バスの形を作るコード）を作る。veh_base.js の「V._u = {」の直前に、自分の車の部品 veh_hi.js を差し込む。
# 使い方: bash tools/app/vehicles_src/mkveh.sh  →  tools/app/vehicles.js ができる（index.html には tools/work/mkx.sh が head.html・vehicles.js・app.js をつないで入れる）
cd "$(dirname "$0")" && python3 - <<'PY'
b=open('veh_base.js',encoding='utf8').read(); h=open('veh_hi.js',encoding='utf8').read()
m='  V._u = {'; i=b.index(m)
open('../vehicles.js','w',encoding='utf8').write(b[:i]+h+'\n'+b[i:])
PY
node --check ../vehicles.js && echo OK
