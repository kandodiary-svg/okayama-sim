#!/bin/bash
cd /home/claude/wx/tests
export URL=${URL:-http://localhost:8806/index.html}
echo "== tramrun"; node tramrun.js
echo "== bus2"; node bus2.js
echo "== busauto"; node busauto.js
echo "== jam4"; SEC=300 node jam4.js
echo "== done"
