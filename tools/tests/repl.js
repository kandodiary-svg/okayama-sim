// 常駐テストブラウザ: /tmp/repl/cmd_<n>.js を順に実行し、結果を /tmp/repl/out_<n>.txt に書く。
// 命令ファイルの先頭行が "//shot:<path>" なら実行後にスクリーンショットも撮る。"//mode:<heli|car|jr...>" で開始モードを選ぶ。
const { chromium } = require('playwright'); const fs=require('fs');
(async () => {
  const W=Number(process.env.W||1100), H=Number(process.env.HT||700);
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:W,height:H}}); p.setDefaultTimeout(1800000);
  p.on('pageerror', e => fs.appendFileSync('/tmp/repl/errors.txt', e.message+'\n'));
  p.on('console', m => { if(m.type()==='error'||m.type()==='warning') fs.appendFileSync('/tmp/repl/console.txt', m.text().slice(0,300)+'\n'); });
  await p.goto(process.env.URL||'http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  if((process.env.MODE||'heli')!=='menu') await p.evaluate((m)=>{ document.querySelector('.mode-opt[data-mode="'+m+'"]').click(); document.getElementById('start').click(); }, process.env.MODE||'heli');
  await p.waitForTimeout(2000);
  fs.writeFileSync('/tmp/repl/ready','1');
  let n=0;
  for(;;){
    const f='/tmp/repl/cmd_'+n+'.js';
    if(!fs.existsSync(f)){ await new Promise(r=>setTimeout(r,500)); if(fs.existsSync('/tmp/repl/quit')) break; continue; }
    await new Promise(r=>setTimeout(r,200));
    const src=fs.readFileSync(f,'utf8'); let out;
    try{
      const wait=/\/\/wait:(\d+)/.exec(src); 
      const r = await p.evaluate(src);
      out = typeof r==='string' ? r : JSON.stringify(r);
      if(wait) await p.waitForTimeout(Number(wait[1]));
      const sh=/\/\/shot:(\S+)/.exec(src); if(sh) await p.screenshot({path:sh[1], timeout:600000});
    }catch(e){ out='ERR '+e.message; }
    fs.writeFileSync('/tmp/repl/out_'+n+'.txt', String(out)); n++;
  }
  await b.close();
})();
