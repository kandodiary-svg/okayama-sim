#!/bin/bash
# v30 で広げた所の画面（8806）
cd /home/claude/wx/tests
export PRE="__Env.set(\"noon\", false)" URL=http://localhost:8806/index.html OUT=/home/claude/wx/tests/v30_
export SHOTS='[[5200,180,500,6500,5,300],[-600,250,-2600,-600,40,-4000],[500,150,2800,1000,3,4000],[-2500,150,1600,-3700,3,1600],[4200,250,-2500,5800,40,-4000],[5000,150,3000,6500,3,4000],[6300,140,0,8600,20,0],[-150,75,230,-700,25,120]]'
WAIT=${WAIT:-80} node camshot2.js
