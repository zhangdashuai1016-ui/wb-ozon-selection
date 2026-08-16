export const EXPECTED_EXTENSION_VERSION = "1.2.1";
export const EXTENSION_STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
export const EXTENSION_STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
export const EXTENSION_LAST_SEEN_KEY = "selection-review-extension-last-seen";
export const EXTENSION_CAPTURE_ACK_TIMEOUT_MS = 8000;
export const EXTENSION_STATUS_RESPONSE_TIMEOUT_MS = 5000;

export function extensionConnectionStatus({ liveVersion = "", cachedVersion = "", backgroundReady = false } = {}) {
  const live = String(liveVersion || "").trim();
  const cached = String(cachedVersion || "").trim();
  if (live) {
    if (live !== EXPECTED_EXTENSION_VERSION) {
      return { code: "reload_required", label: `插件代码已更新 · 请重新加载（当前v${live}，需要v${EXPECTED_EXTENSION_VERSION}）` };
    }
    return backgroundReady
      ? { code: "connected", label: `插件已连接 · 后台可用 · v${live}` }
      : { code: "background_unavailable", label: `插件已安装 · 后台暂未响应 · 系统会自动重连（v${live}）` };
  }
  if (cached === EXPECTED_EXTENSION_VERSION) {
    return { code: "page_refresh_required", label: "插件已安装 · 当前页面需要刷新" };
  }
  if (cached) {
    return { code: "reload_required", label: `插件代码已更新 · 请重新加载（当前v${cached}，需要v${EXPECTED_EXTENSION_VERSION}）` };
  }
  return { code: "disconnected", label: "插件未安装或未连接" };
}

export function readCachedExtensionVersion(storage = window.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(EXTENSION_LAST_SEEN_KEY) || "null");
    return String(value?.version || "").trim();
  } catch {
    return "";
  }
}
