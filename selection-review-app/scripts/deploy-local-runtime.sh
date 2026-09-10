#!/bin/bash
set -euo pipefail

# Prepare a new code package only. Installation and activation require a
# separately confirmed deployment card and are not performed by this entry.
if [ "$#" -ne 3 ] || [ "$1" != "--prepare-only" ] || [ "$2" != "--output" ]; then
  echo "用法：SELECTION_REVIEW_BUILD_NODE=/绝对路径/node $0 --prepare-only --output /全新目录" >&2
  exit 64
fi
case "${SELECTION_REVIEW_BUILD_NODE:-}" in
  /*) ;;
  *) echo "准备运行包必须明确提供 Node.js 的绝对路径。" >&2; exit 64 ;;
esac
if [ ! -x "$SELECTION_REVIEW_BUILD_NODE" ]; then
  echo "指定的 Node.js 不可执行。" >&2
  exit 66
fi
PROJECT_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
unset NODE_PATH NODE_OPTIONS
exec "$SELECTION_REVIEW_BUILD_NODE" "$PROJECT_ROOT/scripts/prepare-local-runtime.mjs" --output "$3"
