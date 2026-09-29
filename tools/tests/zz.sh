#!/bin/bash
cd /home/claude/wx/tests
export URL=http://localhost:8806/index.html WAIT=50 REL=1
export SHOTS='[[-3640,22,300,-3780,12,330]]'
export PRE='__Env.set("noon", false)'
OUT=/home/claude/wx/tests/zzA_ node camshot2.js
export PRE='__Env.set("noon", false); setInterval(()=>__world.children.forEach(o=>{ if(o.name==="bridge") o.visible=false; }),300)'
OUT=/home/claude/wx/tests/zzB_ node camshot2.js
