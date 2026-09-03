import { createHash } from "node:crypto";

export const OZON_DE_READONLY_PROBE_VERSION = "ozon-de-readonly-probe-v1";

const STEPS = Object.freeze([
  ["attributes", "/v4/product/info/attributes"],
  ["info", "/v3/product/info/list"],
  ["prices", "/v5/product/info/prices"],
  ["stocks", "/v4/product/info/stocks"],
  ["state_failed", "/v3/product/list"]
]);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function rows(payload, path) {
  let value = payload;
  for (const key of path) value = value?.[key];
  return Array.isArray(value) ? value : null;
}

function identity(item) {
  return {
    offerId: String(item?.offer_id || ""),
    productId: String(item?.product_id ?? item?.id ?? "")
  };
}

function itemForOffer(items, offerId) {
  return items?.find((item) => String(item?.offer_id || "") === offerId) || null;
}

function fixedFailure(step) {
  const error = new Error(`OZON_DE_READONLY_PROBE_FAILED:${step}`);
  error.code = "OZON_DE_READONLY_PROBE_FAILED";
  error.failureLayer = step;
  return error;
}

/**
 * 只验证当前Ozon E回读协议的响应形状。requestJson由持有钥匙串权限的本机服务注入；
 * 本模块不接收、记录或返回Token，也不输出商品身份。
 */
export async function probeOzonDEReadOnlyCapabilities({ store, requestJson, checkedAt }) {
  if (typeof requestJson !== "function") throw fixedFailure("transport_missing");
  if (typeof store !== "string" || !store.trim()) throw fixedFailure("store_missing");
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) throw fixedFailure("checked_at_invalid");

  const observations = [];
  let attributes;
  try {
    attributes = await requestJson({
      store,
      endpoint: STEPS[0][1],
      body: { filter: { visibility: "ALL" }, limit: 1, sort_dir: "ASC" },
      write: false
    });
  } catch {
    throw fixedFailure("attributes_transport");
  }
  const attributeItems = rows(attributes, ["result"]);
  if (!attributeItems || attributeItems.length !== 1) throw fixedFailure("attributes_response_shape");
  const sample = identity(attributeItems[0]);
  if (!sample.offerId || !/^\d+$/u.test(sample.productId)) throw fixedFailure("attributes_identity");
  observations.push({ step: "attributes", status: "verified" });

  const requests = [
    ["info", "/v3/product/info/list", { offer_id: [sample.offerId] }, ["items"]],
    ["prices", "/v5/product/info/prices", { cursor: "", filter: { offer_id: [sample.offerId], visibility: "ALL" }, limit: 10 }, ["items"]],
    ["stocks", "/v4/product/info/stocks", { cursor: "", filter: { offer_id: [sample.offerId] }, limit: 10 }, ["items"]],
    ["state_failed", "/v3/product/list", { filter: { offer_id: [sample.offerId], product_id: [Number(sample.productId)], visibility: "STATE_FAILED" }, last_id: "", limit: 10 }, ["result", "items"]]
  ];

  for (const [step, endpoint, body, responsePath] of requests) {
    let payload;
    try {
      payload = await requestJson({ store, endpoint, body, write: false });
    } catch {
      throw fixedFailure(`${step}_transport`);
    }
    const items = rows(payload, responsePath);
    if (!items) throw fixedFailure(`${step}_response_shape`);
    if (step !== "state_failed") {
      const item = itemForOffer(items, sample.offerId);
      if (!item) throw fixedFailure(`${step}_identity`);
      const observed = identity(item);
      if (observed.productId && observed.productId !== sample.productId) throw fixedFailure(`${step}_identity`);
      if (step === "info" && (!item.statuses || !Array.isArray(item.errors))) throw fixedFailure("info_fields");
      if (step === "prices" && String(item?.price?.currency_code || item?.currency_code || "") !== "CNY") throw fixedFailure("prices_currency");
      if (step === "stocks" && !Array.isArray(item.stocks)) throw fixedFailure("stocks_fields");
    }
    observations.push({ step, status: "verified" });
  }

  return freeze({
    schemaVersion: OZON_DE_READONLY_PROBE_VERSION,
    status: "verified",
    platform: "ozon",
    store: store.trim().toLowerCase(),
    checkedAt,
    writeAllowed: false,
    platformWrites: 0,
    automaticRetry: false,
    verifiedSteps: observations,
    evidenceRef: `ozon-de-readonly-probe:${digest({ store: store.trim().toLowerCase(), checkedAt, observations })}`
  });
}
