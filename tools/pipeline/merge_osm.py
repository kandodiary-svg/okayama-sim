"""v29: 範囲拡大の OSM データを作る。
  v28 のデータ（2026-09-26 時点。/home/claude/wx/osm_core/osm.json・extra.json）はそのまま使い、
  新しく取得したデータ（範囲全体。取得時点のもの）から、v28 に無い要素のうち v28 の取得範囲（緯度 34.640〜34.676・経度 133.908〜133.956）
  に掛からないものだけを足す。
  → v28 の範囲の中は 2026-09-26 時点のまま変わらない（その後の編集は入れない）。範囲の外は新しく取得した時点のもの。
  （Overpass の過去の時点の取得（attic）は、使える公開サーバーが混んでいて取得できなかったため）
使い方: python3 merge_osm.py osm_cur.json extra_cur.json   （/home/claude/wx/osm_new の中のファイル名）
出力: /home/claude/wx/osm/osm.json, extra.json（landmark.json はそのまま）
"""
import json, sys, os
W = "/home/claude/wx"
LAT0, LAT1, LON0, LON1 = 34.640, 34.676, 133.908, 133.956   # v28 の取得範囲（q.txt）

def touches_old(e):
    if e["type"] == "node":
        return LAT0 <= e["lat"] <= LAT1 and LON0 <= e["lon"] <= LON1
    b = e.get("bounds")
    if b:
        if b["maxlat"] < LAT0 or b["minlat"] > LAT1 or b["maxlon"] < LON0 or b["minlon"] > LON1: return False
    pts = []
    if "geometry" in e: pts = [g for g in e["geometry"] if g]
    for m in e.get("members", []):
        pts += [g for g in m.get("geometry", []) or [] if g]
        if "lat" in m: pts.append(m)
    if not pts: return b is not None
    return any(LAT0 <= g["lat"] <= LAT1 and LON0 <= g["lon"] <= LON1 for g in pts)

def merge(old_fn, new_fn, out_fn):
    old = json.load(open(old_fn)); new = json.load(open(new_fn))
    have = {(e["type"], e["id"]) for e in old["elements"]}
    add = []; skip_new_in_old = 0; dup = 0
    for e in new["elements"]:
        k = (e["type"], e["id"])
        if k in have: dup += 1; continue
        if touches_old(e): skip_new_in_old += 1; continue
        add.append(e)
    out = dict(old)
    out["elements"] = old["elements"] + add
    out["osm3s"] = dict(old.get("osm3s", {}))
    out["osm3s"]["note_v29"] = ("v28 範囲の中は %s 時点（v28 と同じ）。範囲の外は %s 時点の取得を足した" %
                                (old.get("osm3s", {}).get("timestamp_osm_base"), new.get("osm3s", {}).get("timestamp_osm_base")))
    json.dump(out, open(out_fn, "w"), ensure_ascii=False)
    print(os.path.basename(out_fn), "v28", len(old["elements"]), "+ added", len(add), "(same id kept from v28:", dup,
          "; new-only touching v28 area, not added:", skip_new_in_old, ")")

if __name__ == "__main__":
    a, b = sys.argv[1], sys.argv[2]
    merge(f"{W}/osm_core/osm.json", f"{W}/osm_new/{a}", f"{W}/osm/osm.json")
    merge(f"{W}/osm_core/extra.json", f"{W}/osm_new/{b}", f"{W}/osm/extra.json")
