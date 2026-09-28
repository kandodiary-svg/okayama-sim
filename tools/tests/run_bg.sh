#!/bin/bash
# 使い方: run_bg.sh 名前 コマンド...（バックグラウンドで実行、ログは /home/claude/wx/tests/名前.log）
n=$1; shift
( "$@" > /home/claude/wx/tests/$n.log 2>&1; echo "EXIT $?" >> /home/claude/wx/tests/$n.log ) &
