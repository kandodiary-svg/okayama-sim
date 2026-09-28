#!/bin/bash
cd /home/claude/wx/tests
export SHOTS="$1" PRE="__Env.set(\"noon\", false)"
URL=http://localhost:8805/index.html OUT=/home/claude/wx/tests/old_ node camshot2.js
URL=http://localhost:8807/index.html OUT=/home/claude/wx/tests/new_ node camshot2.js
