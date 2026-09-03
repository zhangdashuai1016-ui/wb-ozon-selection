import { createHash } from "node:crypto";

export const EXTERNAL_LISTING_RECORD_VERSION = "external-listing-record-v1.1";
export const E_VERIFICATION_RECORD_VERSION = "e-verification-record-v1.1";

const OUTCOMES = Object.freeze({
  SYSTEM_CREATED: "listed_verified",
  EXTERNAL_DISCOVERED: "externally_verified"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function knownOrNonNegativeInteger(value) {
  return value === "unknown" || (Number.isInteger(value) && value >= 0);
}

function validMoney(value) {
  return isObject(value) && Number.isFinite(value.amount) && value.amount >= 0 && nonEmpty(value.currency);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function validateObservedState(record, errors) {
  for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku", "saleStatus", "platformEvidenceRef"]) {
    if (!nonEmpty(record[field])) push(errors, field, "必须是非空字符串");
  }
  if (!validMoney(record.currentPrice)) push(errors, "currentPrice", "必须包含当前价格和币种");
  if (!knownOrNonNegativeInteger(record.currentStock)) push(errors, "currentStock", "必须是非负整数或unknown");
  if (!knownOrNonNegativeInteger(record.imageCount)) push(errors, "imageCount", "必须是非负整数或unknown");
  if (!(record.moderationStatus === "unknown" || nonEmpty(record.moderationStatus))) push(errors, "moderationStatus", "必须记录当前状态或unknown");
  if (!(record.validationStatus === "unknown" || nonEmpty(record.validationStatus))) push(errors, "validationStatus", "必须记录当前状态或unknown");
  if (!Array.isArray(record.errors) && record.errors !== "unknown") push(errors, "errors", "必须是错误数组或unknown");
}

export function validateExternalListingRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== EXTERNAL_LISTING_RECORD_VERSION) push(errors, "schemaVersion", `必须是${EXTERNAL_LISTING_RECORD_VERSION}`);
  if (!nonEmpty(record.externalListingRecordId)) push(errors, "externalListingRecordId", "必须是非空字符串");
  if (!isoDate(record.discoveredAt)) push(errors, "discoveredAt", "必须是有效时间");
  if (!['seller_api', 'seller_portal'].includes(record.discoverySource)) push(errors, "discoverySource", "发现来源必须是Seller API或卖家后台");
  if (record.createdByCurrentRun !== false) push(errors, "createdByCurrentRun", "外部发现商品不得记为本轮创建");
  validateObservedState(record, errors);
  const decision = record.ownerPriceDecision;
  if (!isObject(decision) || decision.decision !== "keep_current_live_price" || decision.confirmedBy !== "owner" || !isoDate(decision.confirmedAt) || !validMoney(decision.price)) {
    push(errors, "ownerPriceDecision", "必须保存主人保留当前价格的精确决定");
  } else if (decision.price.amount !== record.currentPrice.amount || decision.price.currency !== record.currentPrice.currency) {
    push(errors, "ownerPriceDecision.price", "主人保留价格必须等于平台当前价格");
  }
  return { valid: errors.length === 0, errors };
}

export function validateEVerificationRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== E_VERIFICATION_RECORD_VERSION) push(errors, "schemaVersion", `必须是${E_VERIFICATION_RECORD_VERSION}`);
  for (const field of ["verificationId", "sourceRecordId", "platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku", "platformEvidenceRef"]) {
    if (!nonEmpty(record[field])) push(errors, field, "必须是非空字符串");
  }
  if (!isoDate(record.verifiedAt)) push(errors, "verifiedAt", "必须是有效时间");
  if (!['system_created', 'external_discovered'].includes(record.verificationPath)) push(errors, "verificationPath", "E验证路径无效");
  if (!['ProductionRecord', 'ExternalListingRecord'].includes(record.sourceRecordType)) push(errors, "sourceRecordType", "来源记录类型无效");
  if (!Object.values(OUTCOMES).includes(record.outcome)) push(errors, "outcome", "E验证结果无效");
  const systemPath = record.verificationPath === "system_created";
  if (systemPath && (record.sourceRecordType !== "ProductionRecord" || record.outcome !== OUTCOMES.SYSTEM_CREATED || record.createdByCurrentRun !== true)) {
    push(errors, "verificationPath", "系统创建路径必须来自ProductionRecord并形成listed_verified");
  }
  if (!systemPath && (record.sourceRecordType !== "ExternalListingRecord" || record.outcome !== OUTCOMES.EXTERNAL_DISCOVERED || record.createdByCurrentRun !== false)) {
    push(errors, "verificationPath", "外部发现路径必须来自ExternalListingRecord并形成externally_verified");
  }
  validateObservedState(record, errors);
  const priceDecision = record.ownerPriceDecision?.decision;
  if (!isObject(record.ownerPriceDecision) ||
      (systemPath
        ? !["keep_current_live_price", "authorized_platform_write_price"].includes(priceDecision)
        : priceDecision !== "keep_current_live_price")) {
    push(errors, "ownerPriceDecision", "必须传递与验证路径一致的主人最终价格决定");
  }
  return { valid: errors.length === 0, errors };
}

function assertValid(result, label) {
  if (!result.valid) throw new Error(`${label}校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
}

function observedFields(observation) {
  return {
    platform: String(observation.platform || "").toLowerCase(),
    store: String(observation.store || "").toLowerCase(),
    skuPackageId: String(observation.skuPackageId || ""),
    supplierSkuId: String(observation.supplierSkuId || ""),
    platformProductId: String(observation.platformProductId || ""),
    merchantSku: String(observation.merchantSku || ""),
    currentPrice: structuredClone(observation.currentPrice),
    currentStock: observation.currentStock ?? "unknown",
    imageCount: observation.imageCount ?? "unknown",
    moderationStatus: observation.moderationStatus || "unknown",
    validationStatus: observation.validationStatus || "unknown",
    saleStatus: String(observation.saleStatus || ""),
    errors: observation.errors === "unknown" ? "unknown" : structuredClone(observation.errors || []),
    platformEvidenceRef: String(observation.platformEvidenceRef || "")
  };
}

export function createExternalListingRecord({ observation, ownerPriceDecision, discoveredAt }) {
  const base = observedFields(observation);
  const record = {
    schemaVersion: EXTERNAL_LISTING_RECORD_VERSION,
    externalListingRecordId: `external-listing:${base.skuPackageId}:${fingerprint({ base, discoveredAt }).slice(0, 12)}`,
    discoverySource: observation.discoverySource,
    discoveredAt,
    createdByCurrentRun: false,
    ...base,
    ownerPriceDecision: structuredClone(ownerPriceDecision)
  };
  assertValid(validateExternalListingRecord(record), "ExternalListingRecord");
  return freeze(record);
}

export function verifyExternalListing({ externalListingRecord, verifiedObservation, verifiedAt }) {
  assertValid(validateExternalListingRecord(externalListingRecord), "ExternalListingRecord");
  const observed = observedFields(verifiedObservation);
  for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "platformProductId", "merchantSku"]) {
    if (observed[field] !== externalListingRecord[field]) throw new Error(`E_READBACK_IDENTITY_MISMATCH: ${field}与外部发现记录不一致`);
  }
  if (observed.currentPrice.amount !== externalListingRecord.currentPrice.amount || observed.currentPrice.currency !== externalListingRecord.currentPrice.currency) {
    throw new Error("E_READBACK_PRICE_MISMATCH: 当前价格与主人保留决定不一致");
  }
  const record = {
    schemaVersion: E_VERIFICATION_RECORD_VERSION,
    verificationId: `e-verification:${externalListingRecord.externalListingRecordId}:${fingerprint({ observed, verifiedAt }).slice(0, 12)}`,
    verificationPath: "external_discovered",
    sourceRecordType: "ExternalListingRecord",
    sourceRecordId: externalListingRecord.externalListingRecordId,
    outcome: OUTCOMES.EXTERNAL_DISCOVERED,
    createdByCurrentRun: false,
    verifiedAt,
    ...observed,
    ownerPriceDecision: structuredClone(externalListingRecord.ownerPriceDecision)
  };
  assertValid(validateEVerificationRecord(record), "EVerificationRecord");
  return freeze(record);
}

export function verifySystemCreatedListing({ productionRecord, verifiedObservation, verifiedAt, ownerPriceDecision }) {
  if (!isObject(productionRecord) || !nonEmpty(productionRecord.productionRecordId)) throw new Error("E_PRODUCTION_RECORD_REQUIRED: 系统创建路径必须存在ProductionRecord");
  const observed = observedFields(verifiedObservation);
  if (String(productionRecord.platformProductId) !== observed.platformProductId || String(productionRecord.supplierSkuId) !== observed.supplierSkuId) {
    throw new Error("E_READBACK_IDENTITY_MISMATCH: 平台商品或SKU与ProductionRecord不一致");
  }
  const record = {
    schemaVersion: E_VERIFICATION_RECORD_VERSION,
    verificationId: `e-verification:${productionRecord.productionRecordId}:${fingerprint({ observed, verifiedAt }).slice(0, 12)}`,
    verificationPath: "system_created",
    sourceRecordType: "ProductionRecord",
    sourceRecordId: productionRecord.productionRecordId,
    outcome: OUTCOMES.SYSTEM_CREATED,
    createdByCurrentRun: true,
    verifiedAt,
    ...observed,
    ownerPriceDecision: structuredClone(ownerPriceDecision)
  };
  assertValid(validateEVerificationRecord(record), "EVerificationRecord");
  return freeze(record);
}

export const E_VERIFICATION_OUTCOMES = OUTCOMES;
