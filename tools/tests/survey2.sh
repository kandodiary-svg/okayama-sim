#!/bin/bash
cd /home/claude/wx/tests
export PRE="__Env.set(\"noon\", false)" URL=http://localhost:8806/index.html OUT=/home/claude/wx/tests/sv2_ WAIT=${WAIT:-70} REL=1
export SHOTS=${SHOTS:-'[[1200,12,-1560,1300,5,-1720],[2500,15,4050,2640,5,4180],[-2150,20,3900,-2240,5,4010],[-3550,20,250,-3680,5,290],[-2430,40,-4330,-2370,0,-4420],[3290,30,1300,3380,0,1400],[4000,25,2900,4080,0,3000],[5950,15,2600,6060,5,2700]]'}
node camshot2.js
