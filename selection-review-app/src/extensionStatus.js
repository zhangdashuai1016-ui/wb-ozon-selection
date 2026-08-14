export const EXPECTED_EXTENSION_VERSION = "1.2.0";
export const EXTENSION_STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
export const EXTENSION_STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
export const EXTENSION_LAST_SEEN_KEY = "selection-review-extension-last-seen";

export function extensionConnectionStatus({ liveVersion = "", cachedVersion = "" } = {}) {
  const live = String(liveVersion || "").trim();
  const cached = String(cachedVersion || "").trim();
  if (live) {
    return live === EXPECTED_EXTENSION_VERSION
      ? { code: "connected", label: `插件已连接 · v${live}` }
      : { code: "reload_required", label: `插件代码已更新 · 请重新加载（当前v${live}，需要v${EXPECTED_EXTENSION_VERSION}）` };
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
