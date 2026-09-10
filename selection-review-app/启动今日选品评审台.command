#!/bin/bash
set -euo pipefail

# Open an existing healthy service only. Never install, restart or activate it.
if [ -z "${SELECTION_REVIEW_REVIEW_ORIGIN:-}" ]; then
  echo "打开运行包前必须明确提供 SELECTION_REVIEW_REVIEW_ORIGIN 服务地址。" >&2
  exit 64
fi
REVIEW_PACKAGE_ROOT="$(cd -P "$(dirname "$0")" && pwd)"
REVIEW_NODE="${SELECTION_REVIEW_LAUNCH_NODE:-$REVIEW_PACKAGE_ROOT/runtime/node}"
if [ ! -x "$REVIEW_NODE" ]; then
  echo "今日选品评审台运行包缺少 Node.js；请先完成运行包验收与部署确认。" >&2
  exit 66
fi
unset NODE_PATH NODE_OPTIONS
REVIEW_URL="$("$REVIEW_NODE" -e 'try{const u=new URL(process.argv[1]);if(u.protocol!=="http:"||!(["127.0.0.1","localhost","[::1]"].includes(u.hostname))||u.username||u.password||u.pathname!=="/"||u.search||u.hash)process.exit(1);process.stdout.write(u.origin)}catch{process.exit(1)}' "$SELECTION_REVIEW_REVIEW_ORIGIN")" || {
  echo "今日选品评审台地址必须是明确的本机 HTTP 服务地址。" >&2
  exit 64
}
if ! REVIEW_HEALTH="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --noproxy '*' "$REVIEW_URL/api/health")"; then
  echo "今日选品评审台当前不可用；请查看运行状态并完成明确的启动或部署确认。" >&2
  exit 69
fi
if ! printf '%s' "$REVIEW_HEALTH" | "$REVIEW_NODE" -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{try{const h=JSON.parse(s);if(h.ok!==true||h.service!=="selection-review-app"||h.version!==2||h.dataVersion!==2)process.exit(1)}catch{process.exit(1)}})'; then
  echo "当前地址未返回有效的今日选品评审台健康状态；未打开页面或重启服务。" >&2
  exit 69
fi
open "$REVIEW_URL/"
