import { createHash } from "node:crypto";

export const SEERFAR_OPEN_API_BASE = "https://api.seerfar.cn";
export const SEERFAR_MIN_INTERVAL_MS = 3000;
const PATHS = Object.freeze({
  quota: "/open-api/quota",
  product_detail: { ozon: "/open-api/product/detail/search/ozon", wb: "/open-api/product/detail/search/wb" },
  category_detail: { ozon: "/open-api/category/detail/search/ozon", wb: "/open-api/category/detail/search/wb" },
  reverse_keywords: { ozon: "/open-api/keyword/backSearch/ozon", wb: "/open-api/keyword/backSearch/wb" }
});
const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function iso(v) { return nonEmpty(v) && !Number.isNaN(Date.parse(v)); }
function safeRef(value) { return createHash("sha256").update(String(value)).digest("hex").slice(0, 20); }
function assertNoSecrets(value, path = "value") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`SEERFAR_TRANSPORT_SECRET_FIELD_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}
function walk(value, visit) { visit(value); if (Array.isArray(value)) value.forEach((x) => walk(x, visit)); else if (isObject(value)) Object.values(value).forEach((x) => walk(x, visit)); }
function records(body) {
  let found = null;
  walk(body?.data, (value) => {
    if (found || !isObject(value)) return;
    for (const key of ["records", "productList"]) if (Array.isArray(value[key])) { found = value[key].filter(isObject); break; }
  });
  return found;
}
function quotaRemaining(body) {
  let remaining = null, limit = null, used = null;
  walk(body?.data, (value) => {
    if (!isObject(value)) return;
    for (const [key, raw] of Object.entries(value)) {
      if (!Number.isFinite(raw)) continue;
      const k = key.toLowerCase();
      if (["remaining", "remain", "balance", "available"].includes(k)) remaining = raw;
      if (["creditlimit", "quota", "total"].includes(k)) limit = raw;
      if (["creditused", "used", "usage"].includes(k)) used = raw;
    }
  });
  if (remaining === null && Number.isFinite(limit) && Number.isFinite(used)) remaining = limit - used;
  return Number.isFinite(remaining) ? remaining : null;
}
function range() { return { min: null, max: null }; }

export function buildSeerfarProductPayload({ platform, sku, dateRange }) {
  if (!["ozon", "wb"].includes(platform) || !nonEmpty(sku) || !nonEmpty(dateRange)) throw new Error("SEERFAR_PRODUCT_INPUT_INVALID");
  const payload = { sku, dateRange };
  if (platform === "wb") payload.includeFbs = true;
  return payload;
}

export function buildSeerfarCategoryPayload({ platform, categoryId, fulfillment }) {
  if (!["ozon", "wb"].includes(platform) || !nonEmpty(categoryId) || !nonEmpty(fulfillment)) throw new Error("SEERFAR_CATEGORY_INPUT_INVALID");
  if (platform === "ozon" && !/^\d+(?:_\d+)+$/.test(categoryId)) throw new Error("SEERFAR_OZON_CATEGORY_ID_NOT_COMPOSITE");
  const payload = {
    categoryId, date: null, reviewCount: range(), reviewRating: range(), questionsAndAnswers: range(), price: range(),
    monthlyRevenue: range(), monthlySales: range(), monthlySalesRate: range(), weight: range(), volume: range(), grossMargin: range(), variants: range(),
    creationDate: null, fulfillment, skus: [], sellerName: [], brand: { type: 0, brandName: [] }, keywords: [],
    page: { pageNumber: 1, pageSize: 20, orders: [{ field: "revenue", direction: "DESC" }] }
  };
  if (platform === "ozon") Object.assign(payload, { drr: range(), convToCartPdp: range(), returnCancellationRate: range(), labels: [], filterRemoveProduct: true, tag: "" });
  return payload;
}

export function buildSeerfarReversePayload({ skuIds }) {
  if (!Array.isArray(skuIds) || skuIds.length === 0 || skuIds.length > 20 || skuIds.some((x) => !(nonEmpty(x) || Number.isInteger(x)))) throw new Error("SEERFAR_REVERSE_SKUS_INVALID");
  const names = ["uniqQueriesWCa", "ca", "searchVolume", "searchChange30", "naturalRank", "adRank", "titleDensity", "wordCount", "products", "adRivalCount", "productViews", "conversionSharing", "sellers", "exposure", "conversion", "marketSpace"];
  return { ...Object.fromEntries(names.map((name) => [name, range()])), includeKeywords: [], excludeKeywords: [], type: [], matchType: 0,
    skuIds: skuIds.map((x) => typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x), historyDate: "", hasVariant: 0, page: { pageNumber: 1, pageSize: "100" } };
}

function endpoint(operation, platform) {
  if (operation === "quota") return { method: "GET", path: PATHS.quota, endpointCategory: "quota" };
  if (!PATHS[operation]?.[platform]) throw new Error("SEERFAR_ENDPOINT_NOT_ALLOWED");
  return { method: "POST", path: PATHS[operation][platform], endpointCategory: operation };
}
function payloadFor(plan, request) {
  if (plan.operation === "product_detail") return buildSeerfarProductPayload({ platform: request.targetPlatform, sku: request.exactSku, dateRange: plan.dateRange });
  if (plan.operation === "category_detail") return buildSeerfarCategoryPayload({ platform: request.targetPlatform, categoryId: plan.categoryId, fulfillment: request.fulfillment });
  if (plan.operation === "reverse_keywords") return buildSeerfarReversePayload({ skuIds: plan.skuIds });
  throw new Error("SEERFAR_OPERATION_INVALID");
}

function failureObservation(error, base) {
  const code = error?.code;
  const serverLike = ["provider_or_schema_error", "provider_error", "schema_error", "http_error"].includes(error?.failureKind);
  return { ...base, completed: false, completedAt: null, resultCount: null,
    loginRequired: code === "login_required", quotaExceeded: code === "quota_or_rate_limit", timeout: code === "network_timeout", networkError: code === "network_error",
    stale: code === "stale_result", httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : (code === "provider_server_error" || serverLike) ? 500 : null,
    failureKind: ["login_required", "quota_or_rate_limit", "network_timeout", "network_error", "stale_result"].includes(code) ? code : error?.failureKind ?? "provider_or_schema_error" };
}

export function createSeerfarOpenApiTransport({ httpTransport, secretProvider, clock = { now: () => Date.now() }, sleep = async () => {}, minIntervalMs = SEERFAR_MIN_INTERVAL_MS } = {}) {
  if (typeof httpTransport !== "function" || typeof secretProvider !== "function" || typeof clock?.now !== "function" || typeof sleep !== "function") throw new Error("SEERFAR_TRANSPORT_DEPENDENCY_INVALID");
  let lastRequestAt = null;
  let transportCalls = 0;
  async function call({ method, path, body, token, step }) {
    if (!Object.values(PATHS).some((entry) => typeof entry === "string" ? entry === path : Object.values(entry).includes(path))) throw new Error("SEERFAR_ENDPOINT_NOT_ALLOWED");
    const now = clock.now();
    if (lastRequestAt !== null) { const wait = minIntervalMs - (now - lastRequestAt); if (wait > 0) await sleep(wait); }
    lastRequestAt = clock.now();
    const response = await httpTransport({ url: `${SEERFAR_OPEN_API_BASE}${path}`, method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body, redirect: "error", attempt: 1, step });
    if (!isObject(response) || !Number.isInteger(response.status) || !isObject(response.json) || !nonEmpty(response.requestId) || !iso(response.completedAt)) throw Object.assign(new Error("invalid response"), { failureKind: "schema_error" });
    try { assertNoSecrets(response.json, "response"); }
    catch { throw Object.assign(new Error("unsafe response schema"), { failureKind: "schema_error" }); }
    if ([401, 403, 429].includes(response.status) || response.status >= 500) throw Object.assign(new Error("http failure"), { httpStatus: response.status, failureKind: "http_error" });
    if (response.status < 200 || response.status >= 300 || response.json.code !== 200) throw Object.assign(new Error("provider failure"), { failureKind: response.json.code === 429 ? "quota_or_rate_limit" : "provider_error", httpStatus: response.json.code === 429 ? 429 : 500 });
    return response;
  }
  return async function seerfarOpenApiTransport(request) {
    transportCalls += 1;
    if (transportCalls > 1 || request?.attemptLimit !== 1) throw new Error("SEERFAR_TRANSPORT_ATTEMPT_LIMIT_EXCEEDED");
    assertNoSecrets(request, "request");
    const plan = request?.seerfarRequest;
    if (!isObject(plan) || !["product_detail", "category_detail", "reverse_keywords"].includes(plan.operation) || plan.platform !== request.targetPlatform) throw new Error("SEERFAR_REQUEST_PLAN_INVALID");
    const target = endpoint(plan.operation, plan.platform);
    const base = { attemptId: plan.attemptId, provider: "seerfar-open-api", queryId: plan.queryId, requestId: null, receiptId: plan.receiptId ?? null, startedAt: plan.startedAt, traceRef: `seerfar:${target.endpointCategory}:${safeRef(plan.queryId)}` };
    let token;
    try { token = await secretProvider(); }
    catch { token = null; }
    if (!nonEmpty(token)) return {
      observation: { ...base, completed: false, completedAt: null, resultCount: null, loginRequired: true, failureKind: "secret_unavailable" },
      candidates: [], pointsBefore: null, pointsAfter: null, pointsSpent: null,
      evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: null, requestIds: [], quotaBefore: null, quotaAfter: null, pointsSpent: null, unknownFields: ["quotaBefore", "quotaAfter", "pointsSpent", "dataObservedAt"] }
    };
    let before = null, after = null, targetResponse = null;
    let failureStage = "quota_before";
    try {
      before = await call({ ...endpoint("quota"), body: null, token, step: "quota_before" });
      failureStage = "target_request";
      targetResponse = await call({ ...target, body: payloadFor(plan, request), token, step: target.endpointCategory });
      failureStage = "quota_after";
      after = await call({ ...endpoint("quota"), body: null, token, step: "quota_after" });
    } catch (error) {
      return { observation: failureObservation(error, { ...base, failureStage, requestId: targetResponse?.requestId ?? before?.requestId ?? null, receiptId: plan.receiptId ?? null }), candidates: [], pointsBefore: quotaRemaining(before?.json), pointsAfter: null, pointsSpent: null,
        evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: targetResponse?.completedAt ?? null, requestIds: [before?.requestId, targetResponse?.requestId].filter(Boolean), quotaBefore: quotaRemaining(before?.json), quotaAfter: null, pointsSpent: null, unknownFields: ["quotaAfter", "pointsSpent"] } };
    }
    const returned = records(targetResponse.json);
    if (!Array.isArray(returned)) {
      return { observation: failureObservation({ failureKind: "schema_error" }, { ...base, requestId: targetResponse.requestId, receiptId: plan.receiptId ?? null }), candidates: [], pointsBefore: quotaRemaining(before.json), pointsAfter: quotaRemaining(after.json), pointsSpent: null,
        evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: targetResponse.completedAt, requestIds: [before.requestId, targetResponse.requestId, after.requestId], quotaBefore: quotaRemaining(before.json), quotaAfter: quotaRemaining(after.json), pointsSpent: null, unknownFields: ["pointsSpent"] } };
    }
    const candidates = plan.operation === "reverse_keywords" ? returned.filter((x) => nonEmpty(x.query)).map((x, index) => ({ term: x.query.trim(), sourceRefs: [], factRefs: structuredClone(plan.factRefs ?? []), competitorRefs: structuredClone(plan.competitorRefs ?? []), sourceTrust: "seerfar_open_api", matchType: plan.matchType ?? "exact_match", providerRecordRef: `${base.traceRef}#record-${index}` })) : [];
    const beforePoints = quotaRemaining(before.json), afterPoints = quotaRemaining(after.json);
    const spent = Number.isFinite(beforePoints) && Number.isFinite(afterPoints) ? beforePoints - afterPoints : null;
    const explicitEmpty = returned.length === 0;
    return { observation: { ...base, requestId: targetResponse.requestId, receiptId: plan.receiptId ?? null, completed: true, completedAt: targetResponse.completedAt, resultCount: candidates.length }, candidates,
      pointsBefore: beforePoints, pointsAfter: afterPoints, pointsSpent: spent,
      evidence: { endpointCategory: target.endpointCategory, evidenceRef: base.traceRef, dataObservedAt: targetResponse.completedAt, requestIds: [before.requestId, targetResponse.requestId, after.requestId], quotaBefore: beforePoints, quotaAfter: afterPoints, pointsSpent: spent, unknownFields: [beforePoints, afterPoints, spent].some((x) => x === null) ? ["quota_or_points"] : [] },
      explicitEmpty };
  };
}
