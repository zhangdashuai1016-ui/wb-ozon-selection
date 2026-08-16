const ROUTES = Object.freeze({
  SELECTION_REVIEW_1688_CAPTURE_REQUEST: "SELECTION_REVIEW_1688_CAPTURE_ACK",
  SELECTION_REVIEW_OZON_CAPTURE_REQUEST: "SELECTION_REVIEW_OZON_CAPTURE_ACK"
});
const STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
const STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const LAST_SEEN_KEY = "selection-review-extension-last-seen";
const version = chrome.runtime.getManifest().version;

async function readBackgroundStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: BACKGROUND_PING });
    return {
      backgroundReady: response?.accepted === true,
      backgroundError: response?.accepted === true ? "" : "插件后台没有确认可用状态"
    };
  } catch (error) {
    return { backgroundReady: false, backgroundError: String(error?.message || error) };
  }
}

async function publishStatus(nonce = "") {
  const background = await readBackgroundStatus();
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ version, seenAt: new Date().toISOString() }));
  } catch {}
  window.postMessage({ type: STATUS_RESPONSE, version, nonce, ...background }, window.location.origin);
}

void publishStatus();

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== "http://127.0.0.1:4317") return;
  const message = event.data;
  if (message?.type === STATUS_PING) {
    await publishStatus(String(message.nonce || ""));
    return;
  }
  const ackType = message && ROUTES[message.type];
  if (!ackType || !message.payload?.captureId) return;

  let response = { accepted: false, error: "扩展后台没有响应" };
  try {
    response = await chrome.runtime.sendMessage({
      type: message.type,
      payload: message.payload
    });
  } catch (error) {
    response = { accepted: false, code: "background_unavailable", error: String(error?.message || error) };
  }

  window.postMessage({
    type: ackType,
    captureId: message.payload.captureId,
    accepted: response?.accepted === true,
    code: response?.code || "",
    error: response?.error || ""
  }, window.location.origin);
});
