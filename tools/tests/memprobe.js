// 読み込みの段ごとの JS メモリ（MB）: 全体 / JS のオブジェクト / 配列の中身（ArrayBuffer）。URL=...
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--js-flags=--expose-gc','--enable-precise-memory-info']});
  const p = await b.newPage({viewport:{width:1100,height:700}}); p.setDefaultTimeout(900000);
  p.on('pageerror', e => console.log('ERR', e.message));
  const c = await p.context().newCDPSession(p);
  await p.exposeFunction('__cdpmem', async ()=>{ const u=await c.send('Runtime.getHeapUsage'); return [Math.round(u.usedSize/1e6), Math.round(u.backingStorageSize/1e6)]; });
  await p.addInitScript(()=>{ window.__MEMLOG = []; });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById("start").disabled, null, {timeout:1800000});
  const r = await p.evaluate(()=>window.__MEMLOG);
  console.log('stage          total  (+)   objects  arraybuf');
  let prev=0; for(const [n,m,cd] of r){ console.log(n.padEnd(14), String(m).padStart(5), ('+'+(m-prev)).padStart(5), cd ? String(cd[0]).padStart(8)+String(cd[1]).padStart(9) : ''); prev=m; }
  if (process.env.EVAL) console.log(await p.evaluate(process.env.EVAL));
  await b.close();
})();
