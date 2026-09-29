#!/bin/bash
cd /home/claude/wx/tests
export SHOTS='[[1100,120,-60,1350,5,-230],[300,90,2700,700,3,3200],[-250,80,300,-700,20,150],[5600,120,700,6300,3,400]]' WAIT=60
URL=http://localhost:8810/index.html OUT=/tmp/claude-0/cmp_v30_ node cmpstatic.js
URL=http://localhost:8806/index.html OUT=/tmp/claude-0/cmp_v31_ CTX=1 node cmpstatic.js
