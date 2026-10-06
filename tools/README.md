# tools: データを作るスクリプト

公開中の `data/` を、元のデータ（PLATEAU・OpenStreetMap・国土地理院）から作り直すためのスクリプトと、途中のファイルです。
ページ（`index.html`）を動かすだけなら、このフォルダは要りません。

## フォルダ
- `pipeline/`: 作成スクリプト（Python）。範囲は `bounds.json` で決める（x=東, z=南, m。原点は岡山駅前電停）
  - v30 の範囲: x −4048〜7312, z −4692〜4436（PLATEAU の地形データ 4 ファイルの範囲いっぱい。`parse_dem.py` が範囲の外なら止める）
- `work/run_s2.sh`: 全体の手順（段ごとに `logs/s2/名前.DONE` を作り、止まっても続きから。`STOP_AFTER=段の名前` でそこまで、`LOGDIR` で印の場所を変える）
- `work/core/`: v28 の範囲（中心部）で手作業で合わせた途中のデータ。範囲を広げても中心部を同じにするために使う
  - `roads_final_core.pkl.xz` は `xz -d` で戻す
  - `tex_old_centroids.json`: v28 の写真外壁の画像ごとの重心（アトラスの並びを v28 と同じにする。`out_bldg_core` が無い時に使う）
- `osm/`: OpenStreetMap の取得条件（Overpass）と取得したデータ
  - `osm_core.tar.xz`: 中心部（2026-09-26）。`osm_v29_fetch.tar.xz`: v29 の範囲（2026-09-28）。`osm_v30_fetch.tar.xz`: v30 の範囲（2026-09-29）
  - `merge_osm.py osm_cur.json extra_cur.json v30` で 3 段に重ねる（内側の範囲の中は古い取得のまま）
  - v41.10: `q_v41_10_poi.txt`（ナビの目的地・タクシー乗り場の取得条件）と `osm_v41_10_poi.json.xz`（取得結果、2026-10-06）。`pipeline/poi.py` が `data/poi.json`（目的地 1263 件・タクシー乗り場 30 か所）を作る
- `tests/`: ブラウザ（Playwright）での試験・画面の撮影
  - v41.10: `nav_plan_test.js`（ナビの経路計算: 1548 通りで失敗 0・計算時間）、`taxi_test.js`（タクシー営業の流れ: 乗り場・メーター・配車・迎車・取り消し・見送りの 13 項目）。どちらも `repl.js` の命令ファイル
  - v41.11: `nav_route_stats.js`（ランダムな出発地・目的地の経路が大通りをどれだけ通るか・遠回り率）、`nav_plan_leg_test.js`（経路計算の成功数と、経路の終点と目的地のずれ）、`traffic_dist_test.js`（道の大きさ別の車の密度・平均速度・停止率）。いずれも `repl.js` の命令ファイル
  - v41.12: `lane_common.py`（車線データの読み込み）、`lane_vs_lines.py`（大通りの車線と白線の位置関係: 最寄りの平行な白線までの距離・左右の白線の真ん中からのずれ）、`lane_spacing.py`・`lane_group_spacing.py`（隣の車線との間隔: 同じ向き・反対向き）、`traffic_jitter_fixed.js`（決めた 4 地点で車の横ぶれ・向きの急変を測る。`repl.js` の命令ファイル）。`OUT_DIR` で測るデータの場所を変える（白線の点は `traffic_align2.py` が `/tmp/markq.npy`・`/tmp/markdirs.npz` に作る）
- `app/`: `index.html` の元（`head.html`・`vehicles.js`・`app.js` をつなげる。`work/mkx.sh`）
  - `vehicles.js`: 車・トラック・バスの形を作るコード（v41.9）。`vehicles_src/veh_base.js`（周りの車の形・車体の作り方・材質）と `vehicles_src/veh_hi.js`（自分の車・運転席・バスの車体）から `bash app/vehicles_src/mkveh.sh` で作る（直接は編集しない）
  - 形の確認用ページ: `tests/lab/lab.html`（街なしで車だけを表示）と `tests/vehicle_lab.js`（撮影）

## 作業フォルダ
スクリプトは `/home/claude/wx`（途中のファイル）、`/home/claude/pipeline-x`（スクリプト）、`/home/claude/okaden-x/data`（出力）を前提にしています。
`work/core/` の中身は `/home/claude/wx/` へ、`osm_core.tar.xz` は `/home/claude/wx/osm_core/`、`osm_v29_fetch.tar.xz` は `/home/claude/wx/osm_new/`、`osm_v30_fetch.tar.xz` は `/home/claude/wx/osm_new2/` へ展開してください。
PLATEAU の CityGML は `work/dl_x.py`・`work/dl_x2.py`、航空写真は `work/dl_ortho.py`・`work/dl_ortho2.py` で取得します。

## メモリ
作業環境は全部のプロセスの合計 約 6GB で強制終了されます。道路の 0.5m の格子（範囲全体で 4 億升）は `.npy` のファイルのまま読み書きし（`common.load_roads`・`save_roads`）、
build_v5.py の大きな格子の計算は行の帯ごとに行います（結果は全体で計算した時と同じ。`work/val_compare.py` で確かめた）。ブラウザの試験と同時に動かさないでください。

## 出力の並べ方（v30）
- `geo_ground`（enc=grad2）: 地面の高さは 2 次元の差分。`geo_drive`（enc=gres）: 走行格子の高さは地面の格子からの予測との差。`geo_pwires`（pwires_enc=sd）: 電線は cm の整数の差分。
  Python では `pipeline/geo_io.py` の `read_legacy` で以前の並びに戻せます。
- `traffic.json` の車線の点列は `traffic_pts.txt`（`compact_traffic.py`）。元の形は作業フォルダの `traffic_full.json`。
- 車線の位置合わせ（`pipeline/`）: `traffic_align.py`（v41.8。白線を避ける ±1.2m）→ `traffic_align2.py`（v41.12。大通りの車線を白線の間・隣と 3m 以上に並べ直す。元は `wx/traffic_pre_align.json` に退避して、何度流しても同じ結果。`traffic_align.py` の代わりに流す）

## ライセンス
スクリプトはリポジトリの `LICENSE` に従います。`work/core/`・`osm/` のデータは PLATEAU（CC BY 4.0）・OpenStreetMap（ODbL）・国土地理院の規約に従います。
