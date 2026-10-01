const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport:{width:640,height:400}}); p.setDefaultTimeout(1800000);
  await p.goto('http://localhost:8806/index.html');
  await p.waitForFunction(() => !document.getElementById('start').disabled, null, {timeout:1800000});
  const WS = JSON.parse(process.env.WINS); let wi=0; for(const W of WS){
  const r = await p.evaluate(([x0,z0,x1,z1])=>{
    const C=__Car, G=C.G; const out=[]; 
    for(let z=z0; z<=z1; z+=2){ let row=''; for(let x=x0; x<=x1; x+=2){
      const i=Math.floor((x-G.x0)/G.step), j=Math.floor((z-G.z0)/G.step), k=j*G.nx+i; const K=G.K[k], H=G.H[k]/100;
      const u=G.UM&&G.UM.get(k); row+= (K===9?'#':(K===0?'.':(K===1?'r':'o')))+(u!==undefined?'U':' '); } out.push(row); }
    const hs=[]; for(let z=z0; z<=z1; z+=2){ const row=[]; for(let x=x0; x<=x1; x+=2){ const i=Math.floor((x-G.x0)/G.step), j=Math.floor((z-G.z0)/G.step), k=j*G.nx+i; row.push(Math.round(G.H[k]/100)); } hs.push(row.join(',')); }
    return {kinds:out, heights:hs};
  }, W);
  require('fs').writeFileSync('/tmp/gridmap'+(wi++)+'.json', JSON.stringify(r)); }
  await b.close();
})();
