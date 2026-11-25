# exp.sh x z  -> moves heli, waits, exports roofs to /tmp/v56/roofs_x_z.txt
source /tmp/runfn.sh
run <<EOT >/dev/null
//wait:25000
(()=>{ Object.assign(__Heli.H,{x:$1,z:$2,y:__Car.hAt($1,$2)+150,vF:0,vS:0,vY:0}); window.__camfix={pos:[$1,__Car.hAt($1,$2)+150,$2],look:[$1+10,0,$2+10]}; return 'ok'; })()
EOT
run <<'EOT' > /tmp/v56/roofs_$1_$2.txt
(()=>{ const T=[]; const v=new THREE.Vector3(); const seen=new Set(); __scene.traverse(o=>{ if(!o.isMesh||o.name!=='bldg'||o.material.type!=='MeshLambertMaterial') return; const p=o.geometry.attributes.position; if(!p||!p.array||!p.array.length) return; const key=o.userData.file+p.count+o.position.x; if(seen.has(key)) return; seen.add(key); const A=[]; for(let i=0;i<p.count;i++){ v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld); A.push(v.x,v.y,v.z);} for(let t=0;t+8<A.length;t+=9){ const ax=A[t+3]-A[t],ay=A[t+4]-A[t+1],az=A[t+5]-A[t+2],bx=A[t+6]-A[t],by=A[t+7]-A[t+1],bz=A[t+8]-A[t+2]; const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,l=Math.hypot(nx,ny,nz); if(l<1e-6||Math.abs(ny)/l<0.9) continue; const cx=(A[t]+A[t+3]+A[t+6])/3,cz=(A[t+2]+A[t+5]+A[t+8])/3; if(cx<-1500||cx>2000||cz<-1500||cz>2000) continue; const y=(A[t+1]+A[t+4]+A[t+7])/3; T.push([A[t],A[t+2],A[t+3],A[t+5],A[t+6],A[t+8],y,y-__Car.hAt(cx,cz)].map(a=>Math.round(a*10)/10)); } }); return JSON.stringify(T); })()
EOT
wc -c /tmp/v56/roofs_$1_$2.txt
