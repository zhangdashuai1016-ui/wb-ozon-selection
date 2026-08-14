const ROUTES = Object.freeze({
  SELECTION_REVIEW_1688_CAPTURE_REQUEST: "SELECTION_REVIEW_1688_CAPTURE_ACK",
  SELECTION_REVIEW_OZON_CAPTURE_REQUEST: "SELECTION_REVIEW_OZON_CAPTURE_ACK"
});
const STATUS_PING = "SELECTION_REVIEW_EXTENSION_STATUS_PING";
const STATUS_RESPONSE = "SELECTION_REVIEW_EXTENSION_STATUS_RESPONSE";
const LAST_SEEN_KEY = "selection-review-extension-last-seen";
const version = chrome.runtime.getManifest().version;

function publishStatus(nonce = "") {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ version, seenAt: new Date().toISOString() }));
  } catch {}
  window.postMessage({ type: STATUS_RESPONSE, version, nonce }, window.location.origin);
}

publishStatus();

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== "http://127.0.0.1:4317") return;
  const message = event.data;
  if (message?.type === STATUS_PING) {
    publishStatus(String(message.nonce || ""));
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
    response = { accepted: false, error: String(error?.message || error) };
  }

  window.postMessage({
    type: ackType,
    captureId: message.payload.captureId,
    accepted: response?.accepted === true,
    error: response?.error || ""
  }, window.location.origin);
});
