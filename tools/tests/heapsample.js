// 読み込み後に残っているメモリを、確保した関数ごとに集計（サンプリング）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--js-flags=--expose-gc']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  const c = await p.context().newCDPSession(p);
  await c.send('HeapProfiler.enable'); await c.send('HeapProfiler.startSampling', {samplingInterval: 16384});
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  await p.evaluate(()=>{ gc(); });
  const { profile } = await c.send('HeapProfiler.getSamplingProfile');
  const agg = new Map();
  const walk = (n, stack) => { const f = n.callFrame; const name = (f.functionName||'(anon)') + ':' + f.lineNumber; const st = stack.concat([name]);
    const self = n.selfSize; if(self){ const key = st.slice(-3).join(' < '); agg.set(key, (agg.get(key)||0) + self); }
    for(const ch of n.children) walk(ch, st); };
  walk(profile.head, []);
  const L = [...agg.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30);
  for(const [k,v] of L) console.log((v/1e6).toFixed(1).padStart(7), k);
  await b.close();
})();
