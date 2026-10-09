# tools: データを作るスクリプト

公開中の `data/` を、元のデータ（PLATEAU・OpenStreetMap・国土地理院）から作り直すためのスクリプトと、途中のファイルです。
ページ（`index.html`）を動かすだけなら、このフォルダは要りません。

## フォルダ
- `pipeline/`: 作成スクリプト（Python）。範囲は `bounds.json` で決める（x=東, z=南, m。原点は岡山駅前電停）
  - v30 の範囲: x −4048〜7312, z −4692〜4436（PLATEAU の地形データ 4 ファイルの範囲いっぱい。`parse_dem.py` が範囲の外なら止める）
  - v41.20（高架・橋・トンネル）: `road_profile.py`（道路の縦断。橋の端だけを固定し、交差する道の上をくぐる床の高さを障害物の制約として解く・坑口の盛り上がりをならす・トンネルの床の縦断を出す）、`roads.py`（`tunnels_prof.pkl` を出す）、`merge_roads.py`（v28 の高架の面を新しい面に置き換える `core_replace.pkl`）、`patch_bridges.py`（橋の面の欠けを埋める。中心線に沿った補修と、閉じた領域の差による補修の 2 段）、`tunnels.py`（道路のトンネル 3 本の路面・壁・天井・走行格子の床。`run_s2.sh` の `tunnels` 段）、`build_v5.py`（トンネルの地形・走行格子・坑口の隙間、走行格子の「上の段」を 2m 升の中の 0.5m 升 2 つ以上で持たせる）、`traffic.py`（トンネルの中の車線）、`markings.py`（置き換えた高架の古い白線を除く）
  - v41.21（車線と地形のそろえ直し）: `lane_underfill.py`（車線の高さに合う層が走行格子に無い所へ層を足す〔立体交差の下をくぐる道・堤防の下・高架の面の穴〕・車線の中心にかぶる 1m 升の「通れない」ビットを消す。`UF_RESTORE=1` で足す前に戻して流し直せる。`wx/pre_underfill/` に退避）、`tunnel_fit.py`（トンネルの床の左右の縁を、位置合わせ後の車線の横位置から、中心線に沿った 4m ごとに出して `tunnel_fit.json` に書く。上り・下りが別のトンネルは向かい合う側を車線の真ん中で仕切る。`run_s2.sh` の `tunnelfit` 段。出力は次に `tunnels` 段を流す時の入力で、値が前回と違えば build からやり直す）、`tunnels.py`（床の縁を `tunnel_fit.json` の位置にする。壁の「通れない」帯は縁から 0.3m 離して始める）、`build_v5.py`（トンネルの壁の帯は、隣のトンネルの床を除いてから建物の升に書く。坑口の外側 7m の隙間は端の床の縁から作る）、`patch_bridges.py`（高架の面の補修を 5 回繰り返し、縁の高さが合う穴を足す）
  - **車線の位置合わせ（`traffic_align2.py`）は `traffic.py` → `compact_traffic.py` の後に必ず流す**（v41.20 は流し忘れて公開し、大通りの同じ向きの隣の車線が 3.1m → 1.8m に戻った。v41.21 で `run_s2.sh` の `align` 段にした）
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
  - v41.14: `glass_rain.html` と `glass_rain_shot.js`（車のガラスの雨だけを映す軽い確認。街なしで、雨が降り始めてから何秒の水滴・ワイパーを撮る。晴れは `rain=0`）
  - v41.15: `stamp_tour_test.js`（観光のお客さん: 岡山城・後楽園だけ未取得にして乗せ、降ろしたらスタンプ・お礼の行を確かめる。`car_taxishift` を始めてから流す）、`stamp_lane_check.js`（20 か所のスタンプそれぞれの最寄りの車線までの距離と範囲の比較。どちらも `repl.js` の命令ファイル）
  - v41.16: `comfort_driver_test.js`（キーボードで運転する人をモデルにして、旧しきい値と新しい判定で「急な操作」が 1 km に何回出るかを比べる。`repl.js` の命令ファイル。使い方は冒頭のコメント）
  - v41.17: `handling_feel_test.js`（キーボードの押しっぱなしで、ハンドルの横加速度・ブレーキ・アクセル・Space の感触を車種ごとに測る。`window.__feelShift=true` で Shift（スポーツ）を押した状態＝従来の値。`repl.js` の命令ファイル）
  - v41.18: `corner_turn_test.js`（街なかの経路の交差点・カーブを、速度ごとに「←→ だけで曲がれるか」を測る。旧版・現行版の比較表が冒頭のコメント。`repl.js` の命令ファイル）
  - v41.19: `bike_feel_test.js`（バイクの長押し・ちょん押しの傾き、加速・シフト・制動・傾いたままのブレーキ/転倒を測る）と `bike_corner_test.js`（バイクで交差点・カーブを速度ごとに通れるか。先に `__Car.setProfile('bike')` と `window.__cornerCfg` を設定。結果は冒頭のコメント）。どちらも車モードを始めた `repl.js` に流す
  - v41.20: `lane_rough_test.js`（全車線を車の高さの追い方でたどり、急勾配・こぶ・瞬間移動〔4m 超の段〕を数える。`window.__roughMode='old'|'new'` で v41.19 までの追い方と比べる）と `viaduct_test.js`（高架・高架の下をくぐる道の試験。国道250号の高架・駅西の高架の車線をたどり、段・こぶ・瞬間移動と、高架の下の道の 2 段の格子を調べる。`window.__vdBox=[x0,z0,x1,z1]` で範囲を変える）と `underpass_test.js`（高架の下をくぐる道を地面の層のまま通り抜けられるか。3 か所×横 13 通り）。いずれも車モードを始めた `repl.js` に流す
  - v41.21: `lane_gap_test.js`（車線の高さと走行格子の層の差を全車線で測る。差 1.5m 超の点の数・場所）、`lane_drive_test.js`（車線に沿って実際の車の物理 `Car.tick` で走り、高さの追い方・段・勾配・衝突・車線からのずれを測る。`window.__ldCfg={v,probes:[{name,box,min,max}|{name,ids}]}`。既定の対象は高架・下の道・斜めの道・堤防の下・トンネル 3 本・駅西のランプ）、`lane_rough_test.js`（瞬間移動の一覧つきに）。いずれも車モードを始めた `repl.js` に流す
- `app/`: `index.html` の元（`head.html`・`vehicles.js`・`app.js` をつなげる。`work/mkx.sh`）
  - `vehicles.js`: 車・トラック・バス・バイクの形を作るコード（v41.9、バイクは v41.19）。`vehicles_src/veh_base.js`（周りの車の形・車体の作り方・材質）と `vehicles_src/veh_hi.js`（自分の車・運転席・バスの車体）と `vehicles_src/veh_bike.js`（自分のバイクとライダー）から `bash app/vehicles_src/mkveh.sh` で作る（直接は編集しない）
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
