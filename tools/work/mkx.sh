#!/bin/bash
# v46: 公開用のページを組み立てる（このフォルダ = リポジトリの tools/work）。
#   index.html = メニューだけ（3D は読まない。背景は menu_bg.jpg）、play.html = 各モード（?m=tram|jr|bus|car|heli）、okaden.js = 本体（vehicles.js + app.js）
#   使い方: bash tools/work/mkx.sh [出力先（既定: リポジトリの一番上）]
set -e
R=$(cd "$(dirname "$0")/../.." && pwd); A=$R/tools/app; O=${1:-$R}
node --check $A/app.js
cat $A/vehicles.js $A/app.js > $O/okaden.js
H=$(md5sum $O/okaden.js | cut -c1-10)
tail -n1 $A/head.html | grep -q '^<script>$' || { echo "head.html の最後の行が <script> ではない"; exit 1; }
for pg in menu play; do f=$O/index.html; [ $pg = play ] && f=$O/play.html
  { printf '<!doctype html><meta charset="utf-8">\n'; head -n -1 $A/head.html; printf '<script>window.OKA_PAGE="%s";</script>\n<script src="okaden.js?v=%s"></script>\n' $pg $H; } > $f; done
echo "built $O (okaden.js v=$H)"
