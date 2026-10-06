// 新しい「受け取りながら base64 を戻す」処理が、旧処理（text → atob → 展開）と同じバイト列を返すかを、全ファイル（829）で確かめる
const { chromium } = require('playwright'); const fs=require('fs');
const src=fs.readFileSync(process.env.APP||'/home/claude/okayama-sim/tools/app/app.js','utf8');
const a=src.indexOf('const B64T'), b=src.indexOf('async function fetchPackedOnce');
const dec=src.slice(a,b);
const MODE=process.env.MODE||'all';
(async()=>{
  const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p=await (await br.newContext()).newPage();
  await p.goto('http://localhost:8811/data/scene.json');
  const r=await p.evaluate(async ({dec,MODE})=>{
    const b64Decoder=new Function(dec+";return b64Decoder;")();
    const sc=await (await fetch('/data/scene.json')).json();
    const files=Object.values(sc.files).map(f=>f.file);
    const hex=async buf=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const oldPath=async fn=>{ const txt=await (await fetch('/data/'+fn)).text(); const bin=atob(txt.trim()); const u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      return await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(); };
    // 受信の区切りをわざと不規則（1〜70000 バイト、4 の倍数でない）にして状態の持ち越しも試す
    const chunky=(body,seed)=>{ let s=seed; const rnd=()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; };
      const rd=body.getReader(); let buf=new Uint8Array(0);
      return new ReadableStream({ async pull(c){ const n=1+Math.floor(rnd()*70000);
        while(buf.length<n){ const {done,value}=await rd.read(); if(done){ if(buf.length) c.enqueue(buf); buf=new Uint8Array(0); c.close(); return; } const t=new Uint8Array(buf.length+value.length); t.set(buf); t.set(value,buf.length); buf=t; }
        c.enqueue(buf.slice(0,n)); buf=buf.slice(n); } }); };
    const newPath=async (fn,seed)=>{ const res=await fetch('/data/'+fn); let got=0;
      const ds=chunky(res.body,seed).pipeThrough(b64Decoder(n=>{got+=n;})).pipeThrough(new DecompressionStream('deflate'));
      const out=await new Response(ds).arrayBuffer(); return {out,got}; };
    let n=0, bad=[], bytes=0, chars=0;
    const list = MODE==='all' ? files : files.filter((_,i)=>i%25===0);
    for(let i=0;i<list.length;i++){ const fn=list[i];
      const o=await oldPath(fn); const nw=await newPath(fn,i+7);
      const same=o.byteLength===nw.out.byteLength && (await hex(o))===(await hex(nw.out));
      n++; bytes+=o.byteLength; chars+=nw.got; if(!same) bad.push(fn); }
    return {checked:n,mismatch:bad,inflatedMB:Math.round(bytes/1e6),recvMB:Math.round(chars/1e6)};
  },{dec,MODE});
  console.log(JSON.stringify(r)); await br.close();
})();
