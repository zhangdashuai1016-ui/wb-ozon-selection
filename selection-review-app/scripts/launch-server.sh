#!/bin/bash
set -euo pipefail

# Start this package only, using explicit persistent data and a listening port.
REVIEW_RUNTIME_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
REVIEW_NODE="$REVIEW_RUNTIME_ROOT/runtime/node"
case "${SELECTION_REVIEW_DATA_FILE:-}" in
  /*) ;;
  *) echo "启动前必须明确提供候选数据文件的绝对路径。" >&2; exit 64 ;;
esac
case "${SELECTION_REVIEW_PORT:-}" in
  ''|*[!0-9]*) echo "启动前必须明确提供服务端口。" >&2; exit 64 ;;
esac
if [ "${#SELECTION_REVIEW_PORT}" -gt 5 ] || [ "$SELECTION_REVIEW_PORT" -lt 1 ] || [ "$SELECTION_REVIEW_PORT" -gt 65535 ]; then
  echo "服务端口必须在 1 到 65535 之间。" >&2
  exit 64
fi

if [ ! -x "$REVIEW_NODE" ]; then
  echo "运行包缺少 Node.js，今日选品评审台未启动。" >&2
  exit 66
fi

if [ ! -r "$SELECTION_REVIEW_DATA_FILE" ]; then
  echo "指定的候选数据文件不可读，今日选品评审台未启动。" >&2
  exit 66
fi

unset NODE_PATH NODE_OPTIONS
if ! "$REVIEW_NODE" -e 'const fs=require("node:fs");try{const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(data.meta?.version!==2||!Array.isArray(data.candidates))process.exit(1)}catch{process.exit(1)}' "$SELECTION_REVIEW_DATA_FILE"; then
  echo "候选数据必须是有效的 v2 结构；文件未修改，服务未启动。" >&2
  exit 65
fi

export SELECTION_REVIEW_API_PORT="$SELECTION_REVIEW_PORT"
export SELECTION_REVIEW_PUBLIC_ORIGIN="${SELECTION_REVIEW_PUBLIC_ORIGIN:-http://127.0.0.1:$SELECTION_REVIEW_PORT}"
export SELECTION_REVIEW_AUTO_DELIVER="${SELECTION_REVIEW_AUTO_DELIVER:-off}"
export SELECTION_REVIEW_CODEX_DISPATCH="${SELECTION_REVIEW_CODEX_DISPATCH:-off}"
cd "$REVIEW_RUNTIME_ROOT"
echo "启动今日选品评审台运行包；本地启动不代表平台业务完成。"
exec "$REVIEW_NODE" "$REVIEW_RUNTIME_ROOT/server.mjs" "$@"
