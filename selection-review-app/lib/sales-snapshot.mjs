export const SALES_SNAPSHOT_SCHEMA_VERSION = "sales-snapshot-v1.1";
export const MOCK_OZON_COLLECTOR_VERSION = "mock-ozon-sales-snapshot-v1";
export const REAL_OZON_COLLECTOR_VERSION = "real-ozon-sales-snapshot-v1";
export const OZON_COLLECTION_RESULT_VERSION = "ozon-sales-collection-result-v1";
export const UNKNOWN = "unknown";

export const SELLER_TYPES = Object.freeze([
  "cross_border_cn",
  "local_ru",
  "other_cross_border",
  "unknown"
]);

export const MARKET_SCOPES = Object.freeze([
  "ozon_cn_cross_border",
  "ozon_general_market",
  "unknown"
]);

export const TECHNICAL_COLLECTION_STATUSES = Object.freeze([
  "completed",
  "data_acquisition_failed"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function validUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateSalesSnapshot(snapshot) {
  const errors = [];
  if (!isObject(snapshot)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (snapshot.schemaVersion !== SALES_SNAPSHOT_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `必须是${SALES_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(snapshot.snapshotId)) push(errors, "snapshotId", "必须是非空字符串");
  if (snapshot.platform !== "ozon") push(errors, "platform", "SalesSnapshot只接受ozon");
  if (!MARKET_SCOPES.includes(snapshot.marketScope)) push(errors, "marketScope", "市场范围值无效");
  if (!SELLER_TYPES.includes(snapshot.sellerType)) push(errors, "sellerType", "卖家类型值无效");

  if (!isObject(snapshot.sellerIdentityEvidence)) {
    push(errors, "sellerIdentityEvidence", "必须是对象");
  } else {
    if (!["verified", "unverified"].includes(snapshot.sellerIdentityEvidence.status)) {
      push(errors, "sellerIdentityEvidence.status", "必须是verified或unverified");
    }
    if (!Array.isArray(snapshot.sellerIdentityEvidence.signals)) {
      push(errors, "sellerIdentityEvidence.signals", "必须是数组");
    }
    if (!nonEmptyString(snapshot.sellerIdentityEvidence.evidenceRef)) {
      push(errors, "sellerIdentityEvidence.evidenceRef", "必须是非空字符串");
    }
    if (snapshot.sellerType === UNKNOWN && snapshot.sellerIdentityEvidence.status !== "unverified") {
      push(errors, "sellerIdentityEvidence.status", "sellerType为unknown时不得标记身份已验证");
    }
    if (snapshot.sellerType !== UNKNOWN && snapshot.sellerIdentityEvidence.status !== "verified") {
      push(errors, "sellerIdentityEvidence.status", "明确卖家类型必须有已验证身份依据");
    }
  }

  if (!validUrl(snapshot.productUrl)) push(errors, "productUrl", "必须是有效HTTP(S)链接");
  if (!nonEmptyString(snapshot.title)) push(errors, "title", "必须是非空字符串");
  if (!Array.isArray(snapshot.imageRefs)) {
    push(errors, "imageRefs", "必须是数组");
  } else if (snapshot.imageRefs.some((item) => !nonEmptyString(item))) {
    push(errors, "imageRefs", "图片引用必须都是非空字符串");
  }
  if (!(snapshot.currentPrice === UNKNOWN || (Number.isFinite(snapshot.currentPrice) && snapshot.currentPrice > 0))) {
    push(errors, "currentPrice", "必须是正数或unknown");
  }
  if (!(snapshot.currency === UNKNOWN || /^[A-Z]{3}$/.test(String(snapshot.currency)))) {
    push(errors, "currency", "必须是三位货币代码或unknown");
  }
  if (!(snapshot.categoryPath === UNKNOWN || nonEmptyString(snapshot.categoryPath))) {
    push(errors, "categoryPath", "必须是非空字符串或unknown");
  }
  if (snapshot.platformCategoryEvidence !== undefined) {
    const category = snapshot.platformCategoryEvidence;
    if (!isObject(category)) {
      push(errors, "platformCategoryEvidence", "必须是对象");
    } else {
      if (category.status !== "verified") push(errors, "platformCategoryEvidence.status", "必须是verified");
      if (!Number.isInteger(category.descriptionCategoryId) || category.descriptionCategoryId <= 0) {
        push(errors, "platformCategoryEvidence.descriptionCategoryId", "必须是准确正整数");
      }
      if (!Number.isInteger(category.typeId) || category.typeId <= 0) {
        push(errors, "platformCategoryEvidence.typeId", "必须是准确正整数");
      }
      if (!nonEmptyString(category.categoryToken)) push(errors, "platformCategoryEvidence.categoryToken", "必须是稳定类目token");
      if (category.sourceSnapshotId !== snapshot.snapshotId) {
        push(errors, "platformCategoryEvidence.sourceSnapshotId", "必须指向当前销售快照");
      }
      if (!Array.isArray(category.sourceEvidenceRefs) ||
          category.sourceEvidenceRefs.length < 2 ||
          category.sourceEvidenceRefs.some((item) => !nonEmptyString(item))) {
        push(errors, "platformCategoryEvidence.sourceEvidenceRefs", "必须同时保留佣金和Schema证据引用");
      }
      if (!isoDateTime(category.verifiedAt)) push(errors, "platformCategoryEvidence.verifiedAt", "必须有有效核验时间");
    }
  }
  if (!isObject(snapshot.attributes)) push(errors, "attributes", "必须是对象");
  if (!isoDateTime(snapshot.collectedAt)) push(errors, "collectedAt", "必须是有效时间");
  if (!nonEmptyString(snapshot.evidenceRef)) push(errors, "evidenceRef", "必须是非空字符串");
  const validCollectorPair =
    (snapshot.collectorMode === "mock_only" && snapshot.collectorVersion === MOCK_OZON_COLLECTOR_VERSION) ||
    (snapshot.collectorMode === "real_page_read_only" && snapshot.collectorVersion === REAL_OZON_COLLECTOR_VERSION);
  if (!validCollectorPair) {
    push(errors, "collectorMode", "采集模式与采集器版本不匹配");
  }
  if (snapshot.readOnly !== true) push(errors, "readOnly", "必须为true");
  return { valid: errors.length === 0, errors };
}

export function assertValidSalesSnapshot(snapshot) {
  const result = validateSalesSnapshot(snapshot);
  if (!result.valid) {
    const detail = result.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`SalesSnapshot校验失败：${detail}`);
  }
  return snapshot;
}

export function collectMockOzonSalesSnapshot(fixture) {
  if (!isObject(fixture)) throw new TypeError("模拟Ozon输入必须是对象");
  if (fixture.sourceMode !== "mock_ozon_fixture") {
    throw new Error("5A只允许mock_ozon_fixture，不得连接真实平台");
  }
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: fixture.snapshotId,
    platform: "ozon",
    marketScope: fixture.marketScope,
    sellerType: fixture.sellerType,
    sellerIdentityEvidence: structuredClone(fixture.sellerIdentityEvidence),
    productUrl: fixture.productUrl,
    title: fixture.title,
    imageRefs: structuredClone(fixture.imageRefs),
    currentPrice: fixture.currentPrice,
    currency: fixture.currency,
    categoryPath: fixture.categoryPath,
    attributes: structuredClone(fixture.attributes),
    collectedAt: fixture.collectedAt,
    evidenceRef: fixture.evidenceRef,
    collectorVersion: MOCK_OZON_COLLECTOR_VERSION,
    collectorMode: "mock_only",
    readOnly: true
  };
  assertValidSalesSnapshot(snapshot);
  return deepFreeze(snapshot);
}

function normalizedCountry(value) {
  if (!nonEmptyString(value)) return UNKNOWN;
  const normalized = value.trim().toLowerCase();
  if (["cn", "chn", "china", "中国", "китай"].includes(normalized)) return "CN";
  if (["ru", "rus", "russia", "俄罗斯", "россия"].includes(normalized)) return "RU";
  return normalized.toUpperCase();
}

/**
 * 只有页面直接给出的卖家注册地/发货主体国家可确认卖家类型。
 * 店名、语言、商品产地或普通“中国发货”文案都不足以证明卖家身份。
 */
export function classifyOzonSellerIdentity(signals = []) {
  const safeSignals = Array.isArray(signals) ? structuredClone(signals) : [];
  const directSignal = safeSignals.find((signal) =>
    isObject(signal) &&
    ["seller_registered_country", "seller_legal_country"].includes(signal.field) &&
    nonEmptyString(signal.value) &&
    nonEmptyString(signal.sourcePath)
  );

  if (!directSignal) {
    return deepFreeze({
      sellerType: UNKNOWN,
      status: "unverified",
      signals: safeSignals
    });
  }

  const country = normalizedCountry(directSignal.value);
  const sellerType = country === "CN"
    ? "cross_border_cn"
    : country === "RU"
      ? "local_ru"
      : "other_cross_border";

  return deepFreeze({ sellerType, status: "verified", signals: safeSignals });
}

export function collectRealOzonSalesSnapshot(observation) {
  if (!isObject(observation)) throw new TypeError("真实Ozon页面观察必须是对象");
  if (observation.sourceMode !== "real_ozon_page_observation") {
    throw new Error("5B只接受real_ozon_page_observation");
  }
  if (observation.technicalStatus !== "completed") {
    throw new Error("页面未成功读取时不得生成SalesSnapshot");
  }

  const identity = classifyOzonSellerIdentity(observation.sellerIdentitySignals);
  const snapshot = {
    schemaVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: observation.snapshotId,
    platform: "ozon",
    marketScope: MARKET_SCOPES.includes(observation.marketScope) ? observation.marketScope : UNKNOWN,
    sellerType: identity.sellerType,
    sellerIdentityEvidence: {
      status: identity.status,
      signals: structuredClone(identity.signals),
      evidenceRef: observation.sellerIdentityEvidenceRef
    },
    productUrl: observation.productUrl,
    title: observation.title,
    imageRefs: structuredClone(observation.imageRefs),
    currentPrice: observation.currentPrice,
    currency: observation.currency,
    categoryPath: observation.categoryPath,
    attributes: structuredClone(observation.attributes),
    collectedAt: observation.collectedAt,
    evidenceRef: observation.evidenceRef,
    collectorVersion: REAL_OZON_COLLECTOR_VERSION,
    collectorMode: "real_page_read_only",
    readOnly: true
  };
  assertValidSalesSnapshot(snapshot);
  return deepFreeze(snapshot);
}

export function createOzonCollectionFailure(observation) {
  if (!isObject(observation)) throw new TypeError("Ozon采集失败记录必须是对象");
  if (!nonEmptyString(observation.collectionId)) throw new Error("collectionId必须是非空字符串");
  if (!nonEmptyString(observation.sourceCandidateId)) throw new Error("sourceCandidateId必须是非空字符串");
  if (!validUrl(observation.productUrl)) throw new Error("productUrl必须是有效HTTP(S)链接");
  if (!nonEmptyString(observation.collectedAt) || !isoDateTime(observation.collectedAt)) {
    throw new Error("collectedAt必须是有效时间");
  }
  if (!nonEmptyString(observation.failureLayer) || !nonEmptyString(observation.reason)) {
    throw new Error("失败层和失败原因必须明确");
  }

  return deepFreeze({
    schemaVersion: OZON_COLLECTION_RESULT_VERSION,
    collectionId: observation.collectionId,
    sourceCandidateId: observation.sourceCandidateId,
    sourceDataRevision: observation.sourceDataRevision ?? UNKNOWN,
    productUrl: observation.productUrl,
    collectedAt: observation.collectedAt,
    technicalStatus: "data_acquisition_failed",
    businessStateEffect: "unchanged",
    snapshot: null,
    failure: {
      layer: observation.failureLayer,
      reason: observation.reason,
      retryAttempted: false
    },
    evidenceRef: observation.evidenceRef,
    readOnly: true
  });
}
