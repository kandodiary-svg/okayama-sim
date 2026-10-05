// ミッション自動生成の試験（repl.js の命令ファイル）: コースごとに 8 通り作り、目安時間・出発の駐車場・地点名を一覧する（v41.8）
(async()=>{
  const Q=__Quest, out={};
  if(!Q.sites) return 'NOSITES';
  const dist=(a,b)=>Math.round(Math.hypot(a.x-b.x,a.z-b.z));
  for(const id of ['car_taxi','car_check','truck_parcel','truck_far','heli_parcel']){
    const rows=[];
    for(let sd=1;sd<=8;sd++){
      Q.end(); const ok=Q.begin(id, sd*7919); const q=Q.Q;
      rows.push((ok&&q.gen?'':'NOGEN ')+'par='+Math.round(q.parT/6)/10+'min | '+q.startName+' | '+q.stops.map(s=>s.name.replace('チェックポイント ','CP')).join(' / '));
    }
    out[id]=rows;
  }
  Q.end(); return JSON.stringify(out,null,1);
})()
