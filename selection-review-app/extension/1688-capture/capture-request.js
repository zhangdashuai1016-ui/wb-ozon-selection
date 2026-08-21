import { classify1688Source } from "./source-routing.js";

export const SUPPLIER_CAPTURE_REQUEST_TYPE = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
export const SUPPLIER_CAPTURE_MODE = "a_supplier_capture";

const ERROR_MESSAGES = Object.freeze({
  request_origin_invalid: "采集请求不是来自本机评审台",
  request_payload_missing: "采集请求缺少必要字段",
  capture_mode_invalid: "采集模式无效",
  revision_invalid: "采集修订号无效",
  extension_version_mismatch: "采集作业要求的插件版本与当前版本不一致",
  source_url_invalid: "1688来源链接不在允许范围内",
  short_link_resolution_not_allowed: "当前作业未授权解析1688短链",
  expected_offer_invalid: "1688精确链接与作业锁定的offer不一致"
});

export function captureRequestErrorMessage(code) {
  return ERROR_MESSAGES[code] || "采集请求未通过安全校验";
}

export function validateSupplierCaptureRequest({ payload, senderUrl = "", manifestVersion = "" } = {}) {
  if (senderUrl && !String(senderUrl).startsWith("http://127.0.0.1:4317/")) {
    return { ok: false, code: "request_origin_invalid" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "request_payload_missing" };
  }
  const requiredText = ["captureId", "token", "candidateId", "mode", "sourceUrl"];
  if (requiredText.some((key) => !String(payload[key] || "").trim())) {
    return { ok: false, code: "request_payload_missing" };
  }
  if (payload.mode !== SUPPLIER_CAPTURE_MODE) {
    return { ok: false, code: "capture_mode_invalid" };
  }
  if (!Number.isInteger(payload.dataRevision)) {
    return { ok: false, code: "revision_invalid" };
  }
  if (payload.requiredExtensionVersion && String(payload.requiredExtensionVersion) !== String(manifestVersion)) {
    return { ok: false, code: "extension_version_mismatch" };
  }
  const source = classify1688Source(payload.sourceUrl);
  if (!source) return { ok: false, code: "source_url_invalid" };
  if (source.type === "short") {
    if (payload.allowShortLinkResolution !== true || String(payload.expectedOfferId || "").trim()) {
      return { ok: false, code: "short_link_resolution_not_allowed" };
    }
  } else if (String(payload.expectedOfferId || "") !== source.offerId) {
    return { ok: false, code: "expected_offer_invalid" };
  }
  return { ok: true, source };
}
