#!/usr/bin/env python3
"""開始画面の行先表示器用ドット文字 fonts/dotgothic16-okaden.woff2 を作る（DotGothic16, SIL OFL 1.1）。

手順:
  npm pack @fontsource/dotgothic16 && tar xzf fontsource-dotgothic16-*.tgz      # → package/files/*.woff2（Unicode 範囲ごとの断片）
  pip install fonttools brotli
  python3 make_dot_font.py package/files  head.html app.js  ../../fonts/dotgothic16-okaden.woff2

断片を 1 つの TTF に結合し、head.html・app.js・data/*.json の "name" に出てくる文字だけ（＋ASCII）を残して woff2 にする（約 60KB）。
画面に新しい文字を足したときは、これを作り直す（足りない文字は端末の標準フォントで表示されるだけで、動作は変わらない）。
"""
import glob, os, re, sys
from fontTools.ttLib import TTFont
from fontTools.merge import Merger
from fontTools import subset

frag_dir, *srcs, out = sys.argv[1:]
paths = []
os.makedirs('/tmp/dotfont_ttf', exist_ok=True)
for f in sorted(glob.glob(os.path.join(frag_dir, '*.woff2'))):
    o = '/tmp/dotfont_ttf/' + os.path.basename(f).replace('.woff2', '.ttf')
    ft = TTFont(f); ft.flavor = None; ft.save(o); paths.append(o)
font = Merger().merge(paths)
txt = ''.join(open(s, encoding='utf-8').read() for s in srcs)
for j in glob.glob(os.path.join(os.path.dirname(srcs[0]) or '.', 'data', '*.json')):
    s = open(j, encoding='utf-8').read()
    if len(s) < 3e7: txt += ''.join(re.findall(r'"name":"([^"]*)"', s))
cmap = font.getBestCmap()
keep = ''.join(sorted(c for c in set(txt) if ord(c) > 0x20 and ord(c) != 0x7f and ord(c) in cmap))
opts = subset.Options(); opts.flavor = 'woff2'; opts.layout_features = []; opts.notdef_outline = True
sub = subset.Subsetter(opts); sub.populate(text=''.join(chr(i) for i in range(0x20, 0x7f)) + keep + '★☆→・　×〜'); sub.subset(font)
font.flavor = 'woff2'; font.save(out)
print(out, os.path.getsize(out), 'bytes,', len(keep), 'chars')
