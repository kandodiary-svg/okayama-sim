// 車だけの試験ページ（街なし）で形を確かめる。使い方: node vehicle_lab.js out.png 'query' ...  例: node vehicle_lab.js /tmp/a.png 't=sedan&m=ai&az=35'
// サーバ: cd tools && python3 -m http.server 8810（tests/lab/lab.html と app/vehicles.js を配る）。tests/lab/three.min.js（three.js r128）を置いておく（リポジトリには入れていない）。LAB_URL で別の場所を指定できる
// 指定の例: t=sedan|truckP|busP|taxi 等の車種、m=ai（遠く・近くの AI 用の形。lod=0/1）|hi（自分の車の形）|busbody（バスの外側の車体）、az/el/d/tx/ty/tz/fov（カメラ）、cab=1（運転席の目）、solo=cab（車内だけ）、n=1（夜）、v/rpm/wh/br（速度・回転・ハンドル・ブレーキ）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const args = process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){
    const qq = new URLSearchParams(args[i+1]); const p = await b.newPage({viewport:{width:+(qq.get('w')||900),height:+(qq.get('h')||560)}});
    p.on('pageerror', e => console.log('ERR', e.message)); p.on('console', m => { if(m.type()==='error') console.log('CONSOLE', m.text().slice(0,200)); });
    await p.goto((process.env.LAB_URL||'http://localhost:8810/tests/lab/lab.html')+'?'+args[i+1]);
    await p.waitForFunction(()=>window.__done, null, {timeout:60000}).catch(()=>console.log('timeout'));
    console.log(args[i], 'tris', await p.evaluate(()=>window.__tris), await p.evaluate(()=>window.__grp||''));
    await p.screenshot({path:args[i]}); await p.close();
  }
  await b.close();
})();
