# tools: データを作るスクリプト

公開中の `data/` を、元のデータ（PLATEAU・OpenStreetMap・国土地理院）から作り直すためのスクリプトと、途中のファイルです。
ページ（`index.html`）を動かすだけなら、このフォルダは要りません。

## フォルダ
- `pipeline/`: 作成スクリプト（Python）。範囲は `bounds.json` で決める（x=東, z=南, m。原点は岡山駅前電停）
- `work/run_s2.sh`: 全体の手順（段ごとに `logs/s2/名前.DONE` を作り、止まっても続きから）
- `work/core/`: v28 の範囲（中心部）で手作業で合わせた途中のデータ。範囲を広げても中心部を同じにするために使う
  - `roads_final_core.pkl.xz` は `xz -d` で戻す
- `osm/`: OpenStreetMap の取得条件（Overpass）と、中心部の 2026-09-26 時点のデータ（`osm_core.tar.xz`）
- `tests/`: ブラウザ（Playwright）での試験・画面の撮影
- `app/`: `index.html` の元（`head.html` と `app.js` をつなげる。`work/mkx.sh`）

## 作業フォルダ
スクリプトは `/home/claude/wx`（途中のファイル）、`/home/claude/pipeline-x`（スクリプト）、`/home/claude/okaden-x/data`（出力）を前提にしています。
`work/core/` の中身は `/home/claude/wx/` へ、`osm_core.tar.xz` は `/home/claude/wx/osm_core/` へ展開してください。
PLATEAU の CityGML は `work/dl_x.py`、航空写真は `work/dl_ortho.py` で取得します。

## ライセンス
スクリプトはリポジトリの `LICENSE` に従います。`work/core/`・`osm/` のデータは PLATEAU（CC BY 4.0）・OpenStreetMap（ODbL）・国土地理院の規約に従います。
