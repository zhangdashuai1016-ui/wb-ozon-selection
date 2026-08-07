#!/bin/bash
set -euo pipefail

REVIEW_URL="http://127.0.0.1:4317/"
HEALTH_URL="http://127.0.0.1:4317/api/health"
CHROME_APP="/Applications/Google Chrome.app"

for _ in {1..60}; do
  if /usr/bin/curl --fail --silent --show-error --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    if [[ ! -d "$CHROME_APP" ]]; then
      echo "未找到Google Chrome：$CHROME_APP" >&2
      exit 1
    fi
    /usr/bin/open -a "Google Chrome" "$REVIEW_URL"
    exit 0
  fi
  /bin/sleep 1
done

echo "评审台服务在60秒内未就绪，未打开Chrome。" >&2
exit 1
