#!/bin/bash
cd /home/claude/wx/tests
export PRE="__Env.set(\"noon\", false)" WAIT=60
export SHOTS='[[-380,70,200,-800,20,120],[-330,55,330,-760,25,200]]'
URL=http://localhost:8809/index.html OUT=/home/claude/wx/tests/wall29_ node camshot2.js
URL=http://localhost:8806/index.html OUT=/home/claude/wx/tests/wall30_ node camshot2.js
