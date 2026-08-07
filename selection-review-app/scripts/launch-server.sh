#!/bin/bash
set -e

REVIEW_RUNTIME_ROOT="/Users/shuaizhang/Library/Application Support/今日选品评审台"
REVIEW_NODE="$REVIEW_RUNTIME_ROOT/runtime/node"
REVIEW_DATA="$REVIEW_RUNTIME_ROOT/data/candidates.json"

cd "$REVIEW_RUNTIME_ROOT"

if [ ! -x "$REVIEW_NODE" ]; then
  echo "运行副本缺少 Node.js，今日选品评审台无法启动。" >&2
  exit 127
fi

if [ ! -r "$REVIEW_DATA" ]; then
  echo "运行副本缺少可读候选数据：$REVIEW_DATA" >&2
  exit 66
fi

if ! "$REVIEW_NODE" -e 'const fs=require("fs");const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,"utf8"));if(Number(data.meta?.version)!==2||!Array.isArray(data.candidates)){throw new Error("候选数据不是v2结构")}' "$REVIEW_DATA"; then
  echo "运行副本候选数据校验失败，服务未启动。" >&2
  exit 65
fi

export SELECTION_REVIEW_DATA_FILE="$REVIEW_DATA"
export SELECTION_REVIEW_PORT="4317"
echo "$(date '+%Y-%m-%d %H:%M:%S') 启动运行副本：$REVIEW_RUNTIME_ROOT"
exec "$REVIEW_NODE" "$REVIEW_RUNTIME_ROOT/server.mjs"
