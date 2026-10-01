#!/bin/bash
cd /home/claude/wx/tests
export URL=${URL:-http://localhost:8806/index.html}
echo "== redlight"; node redlight.js
echo "== carshare"; node carshare.js
echo "== jrdrive"; node jrdrive.js
echo "== hsfull"; node hsfull.js
echo "== done2"
