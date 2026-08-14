import { SELLER_TYPES, validateSalesSnapshot } from "./sales-snapshot.mjs";

export const A_MARKET_ASSESSMENT_SCHEMA_VERSION = "a-market-assessment-v1.1";
export const SELLER_SAMPLE_PRIORITY = Object.freeze([
  "cross_border_cn",
  "other_cross_border",
  "unknown",
  "local_ru"
]);

const PRIMARY_SELLER_TYPES = new Set(["cross_border_cn", "other_cross_border", "unknown"]);
const COMPARABILITY = new Set(["comparable", "not_comparable", "unknown"]);
const PRICE_EVIDENCE = new Set(["verified", "missing", "anomalous"]);
const VALIDITY = new Set(["current", "expired", "unknown"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sellerRank(sellerType) {
  const rank = SELLER_SAMPLE_PRIORITY.indexOf(sellerType);
  return rank < 0 ? SELLER_SAMPLE_PRIORITY.length : rank;
}

function confidenceFor(primarySamples) {
  if (primarySamples.some((sample) => sample.sellerType === "cross_border_cn")) return "high";
  if (primarySamples.some((sample) => sample.sellerType === "other_cross_border")) return "medium";
  if (primarySamples.some((sample) => sample.sellerType === "unknown")) return "limited";
  return "unavailable";
}

function requireReview(review, snapshotId) {
  if (!isObject(review)) throw new Error("A_MARKET_INPUT_GAP: 缺少样本" + snapshotId + "的可比性审查");
  if (!COMPARABILITY.has(review.comparability)) throw new Error("A_MARKET_INPUT_GAP: 样本" + snapshotId + "的可比性状态无效");
  if (!PRICE_EVIDENCE.has(review.priceEvidenceStatus)) throw new Error("A_MARKET_INPUT_GAP: 样本" + snapshotId + "的价格证据状态无效");
  if (!VALIDITY.has(review.validityStatus)) throw new Error("A_MARKET_INPUT_GAP: 样本" + snapshotId + "的时效状态无效");
  return review;
}

function sampleRole(snapshot, review) {
  const evidenceComplete =
    review.comparability === "comparable" &&
    review.priceEvidenceStatus === "verified" &&
    review.validityStatus === "current" &&
    review.evidenceTraceable === true &&
    positiveNumber(snapshot.currentPrice) &&
    snapshot.currency !== "unknown" &&
    !review.explicitIncompatibleLocalPricing;

  if (!evidenceComplete) return "excluded";
  if (snapshot.sellerType === "local_ru") return "background";
  if (PRIMARY_SELLER_TYPES.has(snapshot.sellerType)) return "primary";
  return "excluded";
}

function exclusionReason(snapshot, review) {
  if (review.comparability !== "comparable") return "商品可比性不足";
  if (review.priceEvidenceStatus !== "verified" || !positiveNumber(snapshot.currentPrice)) return "当前价格证据不足";
  if (review.validityStatus !== "current") return "销售证据已过期或时效未确认";
  if (review.evidenceTraceable !== true) return "页面证据不可追溯";
  if (review.explicitIncompatibleLocalPricing) return "有证据表明属于不可比的俄罗斯本土价格体系";
  return "销售证据不足或商品可比性不足";
}

export function validateAMarketAssessment(assessment) {
  const errors = [];
  if (!isObject(assessment)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (assessment.schemaVersion !== A_MARKET_ASSESSMENT_SCHEMA_VERSION) errors.push({ path: "schemaVersion", message: "必须是" + A_MARKET_ASSESSMENT_SCHEMA_VERSION });
  if (!nonEmptyString(assessment.assessmentId)) errors.push({ path: "assessmentId", message: "必须是非空字符串" });
  if (!isoDateTime(assessment.assessedAt)) errors.push({ path: "assessedAt", message: "必须是有效时间" });
  if (!Number.isInteger(assessment.sourceOpportunityRevision) || assessment.sourceOpportunityRevision < 0) errors.push({ path: "sourceOpportunityRevision", message: "必须是非负整数" });
  if (!["passed", "data_gap"].includes(assessment.status)) errors.push({ path: "status", message: "状态无效" });
  if (!["passed", "pending"].includes(assessment.businessResult)) errors.push({ path: "businessResult", message: "业务结果无效" });
  if (!Array.isArray(assessment.primarySampleIds)) errors.push({ path: "primarySampleIds", message: "必须是数组" });
  if (!Array.isArray(assessment.backgroundSampleIds)) errors.push({ path: "backgroundSampleIds", message: "必须是数组" });
  if (!Array.isArray(assessment.sampleSummaries)) errors.push({ path: "sampleSummaries", message: "必须是数组" });
  if (!isObject(assessment.sellerTypeCounts) || SELLER_TYPES.some((type) => !Number.isInteger(assessment.sellerTypeCounts[type]) || assessment.sellerTypeCounts[type] < 0)) {
    errors.push({ path: "sellerTypeCounts", message: "必须记录四类卖家样本数量" });
  }
  if (!Array.isArray(assessment.sellerTypesUsed)) errors.push({ path: "sellerTypesUsed", message: "必须是数组" });
  if (!["high", "medium", "limited", "unavailable"].includes(assessment.confidence)) errors.push({ path: "confidence", message: "可信度无效" });
  if (typeof assessment.containsLocalRuBackground !== "boolean") errors.push({ path: "containsLocalRuBackground", message: "必须是布尔值" });
  if (typeof assessment.manualReviewRequired !== "boolean") errors.push({ path: "manualReviewRequired", message: "必须是布尔值" });
  if (assessment.status === "passed") {
    if (assessment.businessResult !== "passed") errors.push({ path: "businessResult", message: "A放行时必须为passed" });
    if (!assessment.primarySampleIds?.length) errors.push({ path: "primarySampleIds", message: "A放行必须有主要价格样本" });
    if (!isObject(assessment.priceBand) || !positiveNumber(assessment.priceBand.minimum) || !positiveNumber(assessment.priceBand.maximum)) errors.push({ path: "priceBand", message: "A放行必须有有效价格带" });
    if (!isObject(assessment.recommendedSalePrice) || !positiveNumber(assessment.recommendedSalePrice.amount) || !nonEmptyString(assessment.recommendedSalePrice.currency)) errors.push({ path: "recommendedSalePrice", message: "A放行必须保存建议成交价" });
  }
  if (assessment.sampleSummaries?.some((sample) => sample.sellerType === "unknown" && sample.identityEvidenceStatus !== "unverified")) {
    errors.push({ path: "sampleSummaries", message: "unknown不得被伪装成已确认身份" });
  }
  if (assessment.primarySampleIds?.some((id) => assessment.sampleSummaries?.find((sample) => sample.snapshotId === id)?.sellerType === "local_ru")) {
    errors.push({ path: "primarySampleIds", message: "俄罗斯本土卖家不得成为主要中国跨境价格样本" });
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidAMarketAssessment(assessment) {
  const result = validateAMarketAssessment(assessment);
  if (!result.valid) {
    throw new Error("A阶段市场评估校验失败：" + result.errors.map((item) => item.path + ": " + item.message).join("；"));
  }
  return assessment;
}

/**
 * 第2A模拟层和后续真实A阶段共用的纯函数。
 * 卖家身份只决定优先级和展示方式；商品可比性、价格证据、时效与可追溯性决定样本能否使用。
 */
export function assessAStageMarket({
  opportunityPackage,
  sampleReviews,
  assessedAt,
  assessmentId,
  marketCriteriaStatus = "passed",
  supplyDataStatus = "ready",
  priceBandStatus = "coherent"
}) {
  if (!isObject(opportunityPackage) || !Array.isArray(opportunityPackage.salesSnapshots)) throw new Error("A_MARKET_INPUT_GAP: 缺少销售快照");
  if (!isoDateTime(assessedAt)) throw new Error("A_MARKET_INPUT_GAP: 缺少有效评估时间");
  if (!nonEmptyString(assessmentId)) throw new Error("A_MARKET_INPUT_GAP: 缺少评估编号");
  if (!isObject(sampleReviews)) throw new Error("A_MARKET_INPUT_GAP: 缺少样本审查结果");

  const summaries = opportunityPackage.salesSnapshots.map((snapshot) => {
    const validation = validateSalesSnapshot(snapshot);
    if (!validation.valid) throw new Error("A_MARKET_INPUT_GAP: 销售快照" + (snapshot?.snapshotId || "unknown") + "无效");
    const review = requireReview(sampleReviews[snapshot.snapshotId], snapshot.snapshotId);
    const role = sampleRole(snapshot, review);
    return {
      snapshotId: snapshot.snapshotId,
      sellerType: snapshot.sellerType,
      identityEvidenceStatus: snapshot.sellerIdentityEvidence.status,
      role,
      priority: sellerRank(snapshot.sellerType) + 1,
      comparability: review.comparability,
      priceEvidenceStatus: review.priceEvidenceStatus,
      validityStatus: review.validityStatus,
      evidenceTraceable: review.evidenceTraceable === true,
      currentPrice: snapshot.currentPrice,
      currency: snapshot.currency,
      collectedAt: snapshot.collectedAt,
      evidenceRef: snapshot.evidenceRef,
      reason: role === "excluded"
        ? exclusionReason(snapshot, review)
        : role === "background"
          ? "俄罗斯本土卖家，仅作市场背景参考"
          : snapshot.sellerType === "unknown"
            ? "卖家身份未确认，当前商品和价格证据可用。"
            : "证据完整，可用于主要价格判断"
    };
  }).sort((left, right) => left.priority - right.priority);

  const primary = summaries.filter((sample) => sample.role === "primary");
  const background = summaries.filter((sample) => sample.role === "background");
  const primaryCurrencies = [...new Set(primary.map((sample) => sample.currency))];
  const sellerTypeCounts = Object.fromEntries(SELLER_TYPES.map((type) => [type, summaries.filter((sample) => sample.sellerType === type).length]));
  const passed =
    primary.length > 0 &&
    primaryCurrencies.length === 1 &&
    marketCriteriaStatus === "passed" &&
    supplyDataStatus === "ready" &&
    priceBandStatus === "coherent";

  const primaryPrices = primary.map((sample) => sample.currentPrice);
  const currency = primaryCurrencies.length === 1 ? primaryCurrencies[0] : null;
  const priceBand = primary.length && currency ? {
    currency,
    minimum: Math.min(...primaryPrices),
    maximum: Math.max(...primaryPrices),
    sampleIds: primary.map((sample) => sample.snapshotId)
  } : null;
  const recommendedSalePrice = passed ? {
    amount: roundMoney(median(primaryPrices)),
    currency,
    method: "median_of_comparable_primary_samples",
    evidenceRefs: primary.map((sample) => sample.evidenceRef)
  } : null;

  let gateReason = "A阶段销售证据和供应端资料满足进入B前条件";
  if (marketCriteriaStatus !== "passed") gateReason = "A阶段其他市场判断尚未达到标准";
  else if (supplyDataStatus !== "ready") gateReason = "供应端资料不足，尚不能进入B阶段";
  else if (!primary.length || primaryCurrencies.length !== 1 || priceBandStatus !== "coherent") gateReason = "销售证据不足或商品可比性不足";

  const assessment = {
    schemaVersion: A_MARKET_ASSESSMENT_SCHEMA_VERSION,
    assessmentId,
    assessedAt,
    sourceOpportunityRevision: opportunityPackage.dataRevision,
    status: passed ? "passed" : "data_gap",
    businessResult: passed ? "passed" : "pending",
    technicalStatus: "completed",
    ownerAction: passed ? "confirm_supplier_option" : "none",
    sellerPriority: [...SELLER_SAMPLE_PRIORITY],
    sampleSummaries: summaries,
    primarySampleIds: primary.map((sample) => sample.snapshotId),
    backgroundSampleIds: background.map((sample) => sample.snapshotId),
    excludedSampleIds: summaries.filter((sample) => sample.role === "excluded").map((sample) => sample.snapshotId),
    sellerTypeCounts,
    sellerTypesUsed: [...new Set(primary.map((sample) => sample.sellerType))],
    identityConfirmation: {
      verifiedCount: summaries.filter((sample) => sample.identityEvidenceStatus === "verified").length,
      unverifiedCount: summaries.filter((sample) => sample.identityEvidenceStatus === "unverified").length
    },
    confidence: confidenceFor(primary),
    priceBand,
    recommendedSalePrice,
    containsLocalRuBackground: background.length > 0,
    manualReviewRequired: false,
    gateReason,
    bEligibility: passed ? "eligible_after_owner_supply_confirmation" : "not_ready",
    rule: "cross_border_cn_preferred_not_exclusive"
  };
  assertValidAMarketAssessment(assessment);
  return deepFreeze(assessment);
}

export function resolveBMarketPrice(opportunityPackage, salesSnapshotId) {
  const assessment = opportunityPackage?.marketAssessment;
  assertValidAMarketAssessment(assessment);
  if (assessment.status !== "passed" || assessment.businessResult !== "passed") {
    throw new Error("B_INPUT_GAP: A阶段销售证据尚未正式通过");
  }
  if (!assessment.primarySampleIds.includes(salesSnapshotId)) {
    throw new Error("B_INPUT_GAP: 所选销售快照不属于A阶段主要价格样本");
  }
  const snapshot = opportunityPackage.salesSnapshots.find((item) => item.snapshotId === salesSnapshotId);
  if (!snapshot) throw new Error("B_INPUT_GAP: A阶段销售快照不存在");
  if (snapshot.sellerType === "local_ru") throw new Error("B_INPUT_GAP: 俄罗斯本土卖家不能单独作为主要利润价格基准");
  if (!PRIMARY_SELLER_TYPES.has(snapshot.sellerType)) throw new Error("B_INPUT_GAP: 销售样本类型不允许作为主要价格基准");
  const price = assessment.recommendedSalePrice;
  if (!positiveNumber(price?.amount) || !nonEmptyString(price?.currency)) throw new Error("B_INPUT_GAP: A阶段建议成交价依据缺失");
  return deepFreeze({ assessment, snapshot, recommendedSalePrice: price });
}
