#!/bin/bash
set -e

cd "/Users/shuaizhang/Documents/wb & ozon 选品/selection-review-app"
REVIEW_RUNTIME_ROOT="/Users/shuaizhang/Library/Application Support/今日选品评审台"
REVIEW_STARTER="$REVIEW_RUNTIME_ROOT/scripts/launch-server.sh"
REVIEW_URL="http://127.0.0.1:4317/"
REVIEW_SERVICE="gui/501/com.shuaizhang.selection-review-app"

if curl --fail --silent "$REVIEW_URL/api/health" >/dev/null 2>&1; then
  open "$REVIEW_URL"
  exit 0
fi

launchctl kickstart -k "$REVIEW_SERVICE" >/dev/null 2>&1 || true
for REVIEW_ATTEMPT in 1 2 3 4 5 6 7 8 9 10; do
  if curl --fail --silent "$REVIEW_URL/api/health" >/dev/null 2>&1; then
    open "$REVIEW_URL"
    exit 0
  fi
  sleep 0.5
done

if [ ! -x "$REVIEW_STARTER" ]; then
  osascript -e 'display dialog "没有找到今日选品评审台的运行副本，请让 Codex 重新检查。" buttons {"好"} default button "好"'
  exit 1
fi

"$REVIEW_STARTER" &
REVIEW_SERVER_PID=$!
trap 'kill "$REVIEW_SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 1
open "$REVIEW_URL"
wait "$REVIEW_SERVER_PID"
