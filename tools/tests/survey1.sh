#!/bin/bash
cd /home/claude/wx/tests
export PRE="__Env.set(\"noon\", false)" URL=http://localhost:8806/index.html OUT=/home/claude/wx/tests/sv1_ WAIT=70 REL=1
export SHOTS='[[3290,35,1300,3380,0,1400],[5800,30,-600,5880,0,-650],[2560,30,2300,2630,0,2380],[-2430,40,-4330,-2370,0,-4420],[-2150,25,3900,-2240,0,4010],[-3550,25,250,-3680,0,290],[980,35,-1700,1100,0,-1850]]'
node camshot2.js
