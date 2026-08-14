import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  assertValidLifecyclePackage,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { UNKNOWN, validateSupplierOption } from "./supplier-option.mjs";

export const SUPPLIER_RECOMMENDATION_VERSION = "supplier-recommendation-v1.1";
export const OWNER_SUPPLY_CONFIRMATION_VERSION = "owner-supply-confirmation-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function known(value) {
  return value !== UNKNOWN && value !== null && value !== undefined && value !== "";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requireOpportunity(pkg) {
  const result = validateOpportunityPackage(pkg);
  if (!result.valid) throw new Error("SUPPLIER_FLOW_INPUT_GAP: OpportunityPackage校验失败");
  if (!Array.isArray(pkg.salesSnapshots) || pkg.salesSnapshots.length === 0) {
    throw new Error("SUPPLIER_FLOW_INPUT_GAP: 缺少销售端快照");
  }
  for (const snapshot of pkg.salesSnapshots) {
    if (!isObject(snapshot) || !nonEmptyString(snapshot.snapshotId)) {
      throw new Error("SUPPLIER_FLOW_INPUT_GAP: 销售端快照缺少snapshotId");
    }
  }
  if (!Array.isArray(pkg.supplierOptions) || pkg.supplierOptions.length === 0) {
    throw new Error("SUPPLIER_FLOW_INPUT_GAP: 缺少供应端方案");
  }
  for (const option of pkg.supplierOptions) {
    const validation = validateSupplierOption(option);
    if (!validation.valid) throw new Error("SUPPLIER_FLOW_INPUT_GAP: SupplierOption校验失败");
  }
  return pkg;
}

export function validateOwnerSupplyConfirmation(confirmation) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  if (!isObject(confirmation)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (confirmation.confirmationVersion !== OWNER_SUPPLY_CONFIRMATION_VERSION) {
    push("confirmationVersion", `必须是${OWNER_SUPPLY_CONFIRMATION_VERSION}`);
  }
  if (confirmation.status !== "confirmed") push("status", "必须是confirmed");
  for (const field of [
    "parentOpportunityId",
    "recommendationVersion",
    "recommendedSupplierOptionId",
    "supplierOptionId",
    "supplierSkuId",
    "variantKey"
  ]) {
    if (!nonEmptyString(confirmation[field])) push(field, "必须是非空字符串");
  }
  if (!Number.isInteger(confirmation.sourceOpportunityRevision) || confirmation.sourceOpportunityRevision < 0) {
    push("sourceOpportunityRevision", "必须是非负整数");
  }
  if (confirmation.confirmedBy !== "owner") push("confirmedBy", "必须由owner确认");
  if (!isoDateTime(confirmation.confirmedAt)) push("confirmedAt", "必须是有效时间");
  if (typeof confirmation.selectedRecommendedOption !== "boolean") {
    push("selectedRecommendedOption", "必须是布尔值");
  }
  return { valid: errors.length === 0, errors };
}

function salesStabilityScore(evidence) {
  if (!isObject(evidence)) return 0;
  const volume = Number.isFinite(evidence.salesVolume) && evidence.salesVolume >= 0
    ? Math.min(60, Math.log10(evidence.salesVolume + 1) * 20)
    : 0;
  const stability = Number.isFinite(evidence.stabilityScore)
    ? Math.max(0, Math.min(40, evidence.stabilityScore * 0.4))
    : 0;
  return Number((volume + stability).toFixed(2));
}

function trustBadgeScore(badges) {
  if (!Array.isArray(badges)) return 0;
  const normalized = new Set(badges.map((item) => String(item).trim().toLowerCase()));
  let score = 0;
  for (const badge of normalized) {
    if (/牛头|实力商家|超级工厂|深度验厂/.test(badge)) score += 25;
    else score += 5;
  }
  return Math.min(100, score);
}

function factCompletenessScore(sku) {
  const checks = [
    isObject(sku.attributes) && Object.keys(sku.attributes).length > 0,
    known(sku.weight),
    known(sku.dimensions),
    known(sku.material),
    known(sku.powerProfile),
    Array.isArray(sku.imageRefs) && sku.imageRefs.length > 0
  ];
  return Number(((checks.filter(Boolean).length / checks.length) * 100).toFixed(2));
}

function targetSku(option, targetVariantKey) {
  const matches = option.supplierSkus.filter((sku) => sku.variantKey === targetVariantKey);
  return matches.length === 1 ? matches[0] : null;
}

function compareScorecards(left, right) {
  if (left.actualPurchaseCostKnown !== right.actualPurchaseCostKnown) {
    return left.actualPurchaseCostKnown ? -1 : 1;
  }
  if (left.actualPurchaseCostKnown && left.actualPurchaseCost !== right.actualPurchaseCost) {
    return left.actualPurchaseCost - right.actualPurchaseCost;
  }
  if (left.salesAndStabilityScore !== right.salesAndStabilityScore) {
    return right.salesAndStabilityScore - left.salesAndStabilityScore;
  }
  if (left.trustBadgeScore !== right.trustBadgeScore) {
    return right.trustBadgeScore - left.trustBadgeScore;
  }
  if (left.factCompletenessScore !== right.factCompletenessScore) {
    return right.factCompletenessScore - left.factCompletenessScore;
  }
  return left.supplierOptionId.localeCompare(right.supplierOptionId);
}

export function recommendSupplierOption({ opportunityPackage, targetVariantKey, scoredAt }) {
  const source = requireOpportunity(opportunityPackage);
  if (!nonEmptyString(targetVariantKey)) throw new Error("SUPPLIER_FLOW_INPUT_GAP: 缺少目标变体");
  if (!isoDateTime(scoredAt)) throw new Error("SUPPLIER_FLOW_INPUT_GAP: 缺少有效评分时间");

  const scorecards = source.supplierOptions.map((option) => {
    const sku = targetSku(option, targetVariantKey);
    const costKnown = Number.isFinite(sku?.actualPurchaseCost) && sku.actualPurchaseCost >= 0;
    return {
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: sku?.supplierSkuId ?? null,
      targetVariantMatched: Boolean(sku),
      eligibleForRecommendation: Boolean(sku) && costKnown,
      actualPurchaseCostKnown: costKnown,
      actualPurchaseCost: costKnown ? sku.actualPurchaseCost : UNKNOWN,
      salesAndStabilityScore: salesStabilityScore(option.supplierSalesEvidence),
      trustBadgeScore: trustBadgeScore(option.supplierBadges),
      factCompletenessScore: sku ? factCompletenessScore(sku) : 0,
      comparisonOrder: [
        "actualPurchaseCost_ascending",
        "supplierSalesAndStability_descending",
        "trustedBadges_descending",
        "factsCompleteness_descending"
      ]
    };
  });
  const eligible = scorecards.filter((item) => item.eligibleForRecommendation).sort(compareScorecards);
  if (!eligible.length) {
    throw new Error("SUPPLIER_FLOW_INPUT_GAP: 没有同时具备目标变体和实际采购到手成本的供应方案");
  }

  const recommended = eligible[0];
  const recommendedOpportunity = structuredClone(source);
  recommendedOpportunity.recommendedSupplierOptionId = recommended.supplierOptionId;
  recommendedOpportunity.confirmedSupplierOptionId = null;
  recommendedOpportunity.ownerAction = "confirm_supplier_option";
  recommendedOpportunity.audit.updatedAt = scoredAt;
  recommendedOpportunity.audit.history.push({
    event: "supplier_option_recommended",
    at: scoredAt,
    supplierOptionId: recommended.supplierOptionId,
    supplierSkuId: recommended.supplierSkuId,
    confirmationStatus: "not_confirmed"
  });
  assertValidLifecyclePackage(recommendedOpportunity);

  return deepFreeze({
    recommendationVersion: SUPPLIER_RECOMMENDATION_VERSION,
    parentOpportunityId: source.parentOpportunityId,
    sourceOpportunityRevision: source.dataRevision,
    salesSnapshotRefs: source.salesSnapshots.map((item) => item.snapshotId),
    targetVariantKey,
    scoredAt,
    scorecards: scorecards.sort(compareScorecards),
    recommendedSupplierOptionId: recommended.supplierOptionId,
    recommendedSupplierSkuId: recommended.supplierSkuId,
    ownerConfirmationStatus: "not_confirmed",
    recommendationReason: "按实际采购到手成本、供应商销量和稳定性、可信标识、事实完整度四级顺序推荐；系统未代替主人确认",
    opportunityPackage: recommendedOpportunity
  });
}

export function createOwnerSupplyConfirmation({
  recommendedOpportunityPackage,
  recommendation,
  ownerDecision,
  confirmedAt
}) {
  const source = requireOpportunity(recommendedOpportunityPackage);
  if (!isObject(recommendation) || recommendation.recommendationVersion !== SUPPLIER_RECOMMENDATION_VERSION) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 缺少有效供应推荐");
  }
  if (recommendation.parentOpportunityId !== source.parentOpportunityId ||
      recommendation.sourceOpportunityRevision !== source.dataRevision ||
      source.recommendedSupplierOptionId !== recommendation.recommendedSupplierOptionId) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 供应推荐与当前OpportunityPackage不一致");
  }
  if (!isObject(ownerDecision) || ownerDecision.status !== "confirmed") {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 供应方案未经主人明确确认");
  }
  if (ownerDecision.confirmedBy !== "owner") {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 只有主人确认才能进入SKU生命周期");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 缺少有效确认时间");
  const option = source.supplierOptions.find((item) => item.supplierOptionId === ownerDecision.supplierOptionId);
  if (!option) throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 主人选择的供应方案不存在");
  const sku = option.supplierSkus.find((item) => item.supplierSkuId === ownerDecision.supplierSkuId);
  if (!sku) throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 主人选择的供应SKU不存在");
  if (sku.variantKey !== ownerDecision.variantKey) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 主人确认的变体与供应SKU不一致");
  }

  const confirmation = {
    confirmationVersion: OWNER_SUPPLY_CONFIRMATION_VERSION,
    status: "confirmed",
    parentOpportunityId: source.parentOpportunityId,
    sourceOpportunityRevision: source.dataRevision,
    recommendationVersion: recommendation.recommendationVersion,
    recommendedSupplierOptionId: recommendation.recommendedSupplierOptionId,
    selectedRecommendedOption: ownerDecision.supplierOptionId === recommendation.recommendedSupplierOptionId,
    supplierOptionId: ownerDecision.supplierOptionId,
    supplierSkuId: ownerDecision.supplierSkuId,
    variantKey: ownerDecision.variantKey,
    confirmedBy: "owner",
    confirmedAt
  };
  const validation = validateOwnerSupplyConfirmation(confirmation);
  if (!validation.valid) throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: OwnerSupplyConfirmation校验失败");

  const confirmedOpportunity = structuredClone(source);
  confirmedOpportunity.confirmedSupplierOptionId = option.supplierOptionId;
  confirmedOpportunity.ownerAction = "none";
  confirmedOpportunity.audit.updatedAt = confirmedAt;
  confirmedOpportunity.audit.history.push({
    event: "supplier_option_owner_confirmed",
    at: confirmedAt,
    supplierOptionId: option.supplierOptionId,
    supplierSkuId: sku.supplierSkuId
  });
  assertValidLifecyclePackage(confirmedOpportunity);
  return deepFreeze({ confirmation, opportunityPackage: confirmedOpportunity });
}

export function createSkuLifecycleFromConfirmedSupply({
  opportunityPackage,
  ownerSupplyConfirmation,
  skuPackageId,
  createdAt,
  readbackLimits = { maxAutomaticAttempts: 2, maxConsecutiveSameFailure: 1 }
}) {
  const source = requireOpportunity(opportunityPackage);
  const confirmation = ownerSupplyConfirmation;
  if (!validateOwnerSupplyConfirmation(confirmation).valid) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 未确认供应方案不能进入SKU生命周期");
  }
  if (source.confirmedSupplierOptionId !== confirmation.supplierOptionId) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: OpportunityPackage未保存本次主人确认");
  }
  if (confirmation.parentOpportunityId !== source.parentOpportunityId || confirmation.sourceOpportunityRevision !== source.dataRevision) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 主人确认与当前OpportunityPackage版本不一致");
  }
  const option = source.supplierOptions.find((item) => item.supplierOptionId === confirmation.supplierOptionId);
  const sku = option?.supplierSkus.find((item) => item.supplierSkuId === confirmation.supplierSkuId);
  if (!sku || sku.variantKey !== confirmation.variantKey) {
    throw new Error("SUPPLIER_CONFIRMATION_REQUIRED: 已确认SKU与供应快照不一致");
  }
  if (!nonEmptyString(skuPackageId) || !isoDateTime(createdAt)) {
    throw new Error("SUPPLIER_FLOW_INPUT_GAP: SKU包身份或创建时间无效");
  }
  if (!Number.isInteger(readbackLimits.maxAutomaticAttempts) || readbackLimits.maxAutomaticAttempts <= 0 ||
      !Number.isInteger(readbackLimits.maxConsecutiveSameFailure) || readbackLimits.maxConsecutiveSameFailure <= 0) {
    throw new Error("SUPPLIER_FLOW_INPUT_GAP: E阶段回读上限无效");
  }

  const pkg = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "SkuLifecyclePackage",
    skuPackageId,
    parentOpportunityId: source.parentOpportunityId,
    supplierOptionId: option.supplierOptionId,
    supplierSkuId: sku.supplierSkuId,
    variantKey: sku.variantKey,
    targetPlatform: source.targetPlatform,
    targetStore: source.targetStore,
    dataRevision: 0,
    businessPhase: "B",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    inheritedSalesSnapshotRefs: source.salesSnapshots.map((item) => item.snapshotId),
    selectedSupplySnapshot: {
      snapshotId: `${option.evidenceRef}:${sku.supplierSkuId}`,
      sourceOpportunityId: source.parentOpportunityId,
      sourceOpportunityRevision: source.dataRevision,
      ownerSupplyConfirmation: structuredClone(confirmation),
      supplierOption: structuredClone(option),
      supplierSku: structuredClone(sku)
    },
    skuFacts: {
      actualPurchaseCost: sku.actualPurchaseCost,
      actualPurchaseCostCurrency: "CNY",
      weight: structuredClone(sku.weight),
      dimensions: structuredClone(sku.dimensions),
      material: structuredClone(sku.material),
      powerProfile: structuredClone(sku.powerProfile)
    },
    profitModels: [],
    activeProfitModelVersion: null,
    c1ProductPlan: null,
    c2FinalAssets: null,
    productionAuthorization: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    readbackPolicy: {
      status: "not_started",
      maxAutomaticAttempts: readbackLimits.maxAutomaticAttempts,
      automaticAttempts: 0,
      maxConsecutiveSameFailure: readbackLimits.maxConsecutiveSameFailure,
      consecutiveSameFailureCount: 0,
      lastFailureLayer: null,
      stopReason: null,
      stoppedAt: null
    },
    readbackHistory: [],
    audit: {
      createdAt,
      updatedAt: createdAt,
      history: [{
        event: "sku_lifecycle_created_from_owner_confirmed_supply",
        at: createdAt,
        supplierOptionId: option.supplierOptionId,
        supplierSkuId: sku.supplierSkuId,
        profitCalculationStarted: false
      }]
    }
  };
  assertValidLifecyclePackage(pkg);
  return deepFreeze(pkg);
}
