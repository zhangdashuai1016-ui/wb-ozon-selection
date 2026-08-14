import { collectRealOzonSalesSnapshot } from "./sales-snapshot.mjs";

const FAILURE_MESSAGES = Object.freeze({
  extension_not_installed: "未检测到本机商品采集扩展",
  wrong_product: "Ozon页面商品ID与当前候选不一致",
  site_login_required: "Ozon页面要求先登录",
  site_verification_required: "Ozon页面要求人工完成验证",
  permission_required: "Chrome尚未授予当前Ozon商品页只读权限",
  structured_data_unavailable: "Ozon页面没有返回可验证的结构化商品数据",
  precise_price_missing: "Ozon结构化数据中没有当前直接价格",
  timeout: "Ozon商品页或结构化接口读取超时",
  revision_conflict: "商品资料已变化，本次采集结果已拒绝",
  invalid_capture: "Ozon采集结果格式无效",
  system_error: "Ozon只读采集器发生系统错误"
});

function text(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractOzonProductId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)ozon\.ru$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})(?:\/|$)/i);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export function canonicalOzonProductUrl(value, expectedProductId = "") {
  const productId = extractOzonProductId(value);
  if (!productId || (expectedProductId && productId !== String(expectedProductId))) return "";
  return `https://www.ozon.ru/product/${productId}/`;
}

export function ozonCaptureFailureMessage(code) {
  return FAILURE_MESSAGES[code] || FAILURE_MESSAGES.system_error;
}

export function sanitizeOzonCaptureEvidence(input, expectedProductId, context = {}) {
  if (!isObject(input)) throw new Error("invalid_capture");
  const productId = text(input.productId, 40);
  if (!productId || productId !== String(expectedProductId)) throw new Error("wrong_product");
  const productUrl = canonicalOzonProductUrl(input.productUrl, productId);
  if (!productUrl) throw new Error("wrong_product");
  const title = text(input.title, 1000);
  if (!title) throw new Error("invalid_capture");
  const currentPrice = Number(input.currentPrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("precise_price_missing");
  const currency = text(input.currency, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("invalid_capture");
  const observedAt = text(input.observedAt, 100);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("invalid_capture");
  const imageRefs = Array.isArray(input.imageRefs)
    ? [...new Set(input.imageRefs.map((item) => text(item, 3000)).filter((item) => /^https:\/\//i.test(item)))].slice(0, 40)
    : [];
  const attributes = isObject(input.attributes) ? structuredClone(input.attributes) : {};
  const sellerIdentitySignals = Array.isArray(input.sellerIdentitySignals)
    ? input.sellerIdentitySignals
      .filter(isObject)
      .map((signal) => ({
        field: text(signal.field, 100),
        value: text(signal.value, 500),
        sourcePath: text(signal.sourcePath, 500)
      }))
      .filter((signal) => signal.field && signal.value && signal.sourcePath)
      .slice(0, 20)
    : [];
  const snapshotId = text(context.snapshotId, 200);
  const captureId = text(context.captureId, 200);
  if (!snapshotId || !captureId) throw new Error("invalid_capture");

  return collectRealOzonSalesSnapshot({
    sourceMode: "real_ozon_page_observation",
    technicalStatus: "completed",
    snapshotId,
    marketScope: text(input.marketScope, 100) || "unknown",
    sellerIdentitySignals,
    sellerIdentityEvidenceRef: `ozon-loaded-page-widgets:${captureId}:seller`,
    productUrl,
    title,
    imageRefs,
    currentPrice,
    currency,
    categoryPath: text(input.categoryPath, 1000) || "unknown",
    attributes,
    collectedAt: new Date(observedAt).toISOString(),
    evidenceRef: `ozon-loaded-page-widgets:${captureId}:${productId}`
  });
}
