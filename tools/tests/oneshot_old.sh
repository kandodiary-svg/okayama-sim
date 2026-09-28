#!/bin/bash
cd /home/claude/wx/tests
export PRE="__Env.set(\"noon\", false)" URL=http://localhost:8805/index.html OUT=/home/claude/wx/tests/oldarea_
export SHOTS='[[-450,90,160,-800,6,20]]'
node camshot2.js
