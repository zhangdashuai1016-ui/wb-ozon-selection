#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="/Users/shuaizhang/Library/Application Support/今日选品评审台"
RUNTIME_DATA="$RUNTIME_ROOT/data/candidates.json"

if [ ! -f "$RUNTIME_DATA" ]; then
  echo "运行副本共享数据不存在，停止部署。" >&2
  exit 66
fi

# 只部署代码、Schema与构建产物；共享候选数据由运行副本继续持有，绝不覆盖。
cp "$PROJECT_ROOT/server.mjs" "$RUNTIME_ROOT/server.mjs"
rsync -a --delete "$PROJECT_ROOT/lib/" "$RUNTIME_ROOT/lib/"
rsync -a --delete "$PROJECT_ROOT/schema/" "$RUNTIME_ROOT/schema/"
rsync -a --delete "$PROJECT_ROOT/dist/" "$RUNTIME_ROOT/dist/"

launchctl kickstart -k gui/$(id -u)/com.shuaizhang.selection-review-app
