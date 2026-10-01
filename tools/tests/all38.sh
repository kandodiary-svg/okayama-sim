#!/bin/bash
cd /home/claude/wx/tests
export URL=http://localhost:8806/index.html
bash func_tests.sh
bash func2.sh
echo "== mwdrive"; node mwdrive.js
echo "== ALL38 DONE"
