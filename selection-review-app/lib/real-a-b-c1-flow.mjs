import { createC1ProductPlan } from "./c1-product-plan.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";
import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  assertValidLifecyclePackage
} from "./product-lifecycle-schema.mjs";
import { runSkuProfitModel } from "./profit-model.mjs";
import { createLifecycleBInputBundle } from "./lifecycle-b-input-bundle.mjs";
import {
  buildRealAConfirmationCard,
  validateRealAConfirmationSubmission
} from "./real-a-confirmation-card.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "./supplier-selection-flow.mjs";
import { assertValidSupplierOption, UNKNOWN } from "./supplier-option.mjs";

export const REAL_A_B_C1_FLOW_VERSION = "real-a-b-c1-flow-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function offerIdFromUrl(value) {
  return new URL(value).pathname.match(/\/offer\/(\d+)\.html/i)?.[1] || null;
}

function salesSnapshot(candidate, snapshotId) {
  return (candidate.salesSnapshotsV11 || []).find((snapshot) => snapshot.snapshotId === snapshotId) || null;
}

function supplierOption(normalized, candidate, confirmedAt) {
  const supplier = normalized.supplierConfirmation;
  const offerId = offerIdFromUrl(supplier.productUrl);
  const evidenceRef = `owner-a-confirmation:${candidate.id}:${candidate.dataRevision}`;
  const option = {
    supplierOptionId: `supplier-option:1688:${offerId}`,
    sourcePlatform: "1688",
    productUrl: supplier.productUrl,
    offerId,
    supplierSalesEvidence: UNKNOWN,
    supplierBadges: UNKNOWN,
    supplierSkus: [{
      supplierSkuId: supplier.supplierSkuId,
      variantKey: supplier.variantKey,
      attributes: {
        purchaseCostComponents: {
          unitProductPrice: supplier.unitProductPrice,
          unitDomesticFreight: supplier.unitDomesticFreight,
          otherPurchaseCosts: supplier.otherPurchaseCosts,
          actualPurchaseCost: supplier.actualPurchaseCost,
          currency: "CNY"
        }
      },
      unitProductPrice: supplier.unitProductPrice,
      unitDomesticFreight: supplier.unitDomesticFreight,
      actualPurchaseCost: supplier.actualPurchaseCost,
      weight: { value: supplier.weightKg, unit: "kg", evidenceRef },
      dimensions: { ...structuredClone(supplier.dimensionsCm), unit: "cm", evidenceRef },
      material: UNKNOWN,
      powerProfile: UNKNOWN,
      imageRefs: UNKNOWN
    }],
    captureTime: confirmedAt,
    evidenceRef
  };
  assertValidSupplierOption(option);
  return option;
}

function opportunityPackage(candidate, normalized, confirmedAt) {
  const snapshot = salesSnapshot(candidate, normalized.salesReview.snapshotId);
  if (!snapshot) throw new Error("REAL_A_SNAPSHOT_CHANGED: 确认卡销售快照已经不存在");
  const option = supplierOption(normalized, candidate, confirmedAt);
  const opportunity = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: `opportunity:${candidate.id}`,
    directionName: candidate.productName,
    targetPlatform: candidate.targetStore === "wb" ? "wb" : "ozon",
    targetStore: candidate.targetStore,
    dataRevision: candidate.dataRevision,
    businessPhase: "A",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "confirm_supplier_option",
    salesSnapshots: [structuredClone(snapshot)],
    marketAssessment: null,
    supplierOptions: [option],
    recommendedSupplierOptionId: null,
    confirmedSupplierOptionId: null,
    supplierSearch: {
      status: "completed",
      limits: { maxSearchRounds: 1, maxSupplierOptions: 1, maxConsecutiveNoEvidenceRounds: 1 },
      searchRounds: 1,
      supplierOptionsFound: 1,
      consecutiveNoEvidenceRounds: 0,
      stopReason: "scope_completed",
      stoppedAt: confirmedAt
    },
    audit: {
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
      history: [{
        event: "real_a_one_card_inputs_frozen",
        at: confirmedAt,
        sourceCandidateId: candidate.id,
        sourceCandidateRevision: candidate.dataRevision,
        externalAccesses: 0
      }]
    }
  };
  opportunity.marketAssessment = assessAStageMarket({
    opportunityPackage: opportunity,
    sampleReviews: {
      [snapshot.snapshotId]: {
        comparability: normalized.salesReview.comparability,
        priceEvidenceStatus: "verified",
        validityStatus: normalized.salesReview.validityStatus,
        evidenceTraceable: true
      }
    },
    assessedAt: confirmedAt,
    assessmentId: `a-market:${candidate.id}:${candidate.dataRevision}`,
    supplyDataStatus: "ready"
  });
  if (opportunity.marketAssessment.status !== "passed") {
    throw new Error(`REAL_A_MARKET_GATE_REJECTED: ${opportunity.marketAssessment.gateReason}`);
  }
  opportunity.businessResult = "passed";
  opportunity.ownerAction = "confirm_supplier_option";
  assertValidLifecyclePackage(opportunity);
  return opportunity;
}

function createC1Handoff({ opportunityPackage, skuPackage, profitModel, createdAt }) {
  return {
    handoffId: `c1-handoff:${skuPackage.skuPackageId}:${profitModel.profitModelVersion}`,
    status: "created",
    createdAt,
    trigger: "b_passed_auto_c1",
    fromOwner: "selection_task",
    toOwner: "listing_task",
    uniqueOwner: "listing_task",
    parentOpportunityId: opportunityPackage.parentOpportunityId,
    skuPackageId: skuPackage.skuPackageId,
    supplierSkuId: skuPackage.supplierSkuId,
    inheritedOpportunityRevision: opportunityPackage.dataRevision,
    inheritedSkuRevision: skuPackage.dataRevision,
    inputPackageRefs: [
      opportunityPackage.parentOpportunityId,
      skuPackage.skuPackageId,
      profitModel.profitModelVersion
    ],
    selectionTaskStopped: true,
    realTaskDispatched: false
  };
}

function replayExistingLifecycle(candidate, validation) {
  const lifecycle = candidate.lifecycleV11;
  const opportunity = lifecycle?.opportunityPackage;
  const skuPackage = lifecycle?.skuPackage;
  if (!opportunity || !skuPackage) return null;
  if (validation.decision !== "confirm" || !validation.normalized) {
    throw new Error("REAL_A_ALREADY_CONFIRMED_CONFLICT: 已有SKU生命周期与本次决定不一致");
  }
  const expected = validation.normalized;
  const supply = skuPackage.selectedSupplySnapshot;
  const supplierSku = supply?.supplierSku;
  const components = supplierSku?.attributes?.purchaseCostComponents;
  const identity = supply?.supplierOption;
  const sameSales = opportunity.salesSnapshots?.some((item) => item.snapshotId === expected.salesReview.snapshotId);
  const sameSupply = identity?.productUrl === expected.supplierConfirmation.productUrl &&
    supplierSku?.supplierSkuId === expected.supplierConfirmation.supplierSkuId &&
    supplierSku?.variantKey === expected.supplierConfirmation.variantKey &&
    components?.unitProductPrice === expected.supplierConfirmation.unitProductPrice &&
    components?.unitDomesticFreight === expected.supplierConfirmation.unitDomesticFreight &&
    components?.otherPurchaseCosts === expected.supplierConfirmation.otherPurchaseCosts &&
    supplierSku?.actualPurchaseCost === expected.supplierConfirmation.actualPurchaseCost &&
    supplierSku?.weight?.value === expected.supplierConfirmation.weightKg &&
    supplierSku?.dimensions?.length === expected.supplierConfirmation.dimensionsCm.length &&
    supplierSku?.dimensions?.width === expected.supplierConfirmation.dimensionsCm.width &&
    supplierSku?.dimensions?.height === expected.supplierConfirmation.dimensionsCm.height;
  if (!sameSales || !sameSupply) {
    throw new Error("REAL_A_ALREADY_CONFIRMED_CONFLICT: 本次A确认输入与已冻结销售或供应数据不一致");
  }
  const profitModel = skuPackage.profitModels?.find((item) => item.profitModelVersion === skuPackage.activeProfitModelVersion);
  if (!profitModel) throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: 缺少当前B利润版本");
  const handoffs = Array.isArray(lifecycle.c1Handoffs) ? lifecycle.c1Handoffs : [];
  if (handoffs.length > 1) throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: 同一SKU存在多个C1交接");
  const c1Handoff = handoffs[0] || null;
  if (c1Handoff && (c1Handoff.skuPackageId !== skuPackage.skuPackageId || c1Handoff.inheritedSkuRevision !== skuPackage.dataRevision)) {
    throw new Error("REAL_A_EXISTING_LIFECYCLE_INVALID: C1交接没有锁定同一SKU包及修订号");
  }
  assertValidLifecyclePackage(opportunity);
  assertValidLifecyclePackage(skuPackage);
  return deepFreeze({
    flowVersion: REAL_A_B_C1_FLOW_VERSION,
    decision: "confirm",
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: lifecycle.aConfirmationReceipt?.sourceCandidateRevision ?? opportunity.dataRevision,
    confirmationReceiptId: lifecycle.aConfirmationReceipt?.receiptId || `a-confirmation:${candidate.id}:${opportunity.dataRevision}:confirm`,
    systemEvidenceBundle: structuredClone(lifecycle.bSystemEvidenceBundle || null),
    opportunityPackage: structuredClone(opportunity),
    ownerSupplyConfirmation: structuredClone(lifecycle.ownerSupplyConfirmation),
    skuPackage: structuredClone(skuPackage),
    profitModel: structuredClone(profitModel),
    c1Handoff: structuredClone(c1Handoff),
    uniqueOwner: c1Handoff ? "listing_task" : "none",
    idempotentReplay: true,
    externalAccesses: [],
    taskDispatches: 0,
    platformWrites: 0
  });
}

/**
 * 真实A确认后的纯函数闭环。调用者负责在一个原子持久化事务中保存结果。
 * 本函数不访问平台、不派发Codex任务，也不修改输入候选。
 */
export function runRealAConfirmationToBAndC1({
  candidate,
  submission,
  evidencePacks,
  confirmedAt,
  processedAt = confirmedAt
}) {
  if (!isObject(candidate) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("REAL_A_INPUT_GAP: 候选或修订号无效");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("REAL_A_INPUT_GAP: 确认时间无效");
  if (!isoDateTime(processedAt) || Date.parse(processedAt) < Date.parse(confirmedAt)) {
    throw new Error("REAL_A_INPUT_GAP: B处理时间不得早于主人确认时间");
  }
  const before = JSON.stringify(candidate);
  const card = buildRealAConfirmationCard(candidate);
  const validation = validateRealAConfirmationSubmission(card, submission);
  if (!validation.valid) {
    const detail = validation.errors.map((item) => `${item.label}：${item.reason}`).join("；");
    throw new Error(`REAL_A_CONFIRMATION_INVALID: ${detail}`);
  }
  if (candidate.lifecycleV11?.skuPackage) return replayExistingLifecycle(candidate, validation);
  if (validation.decision === "reject") {
    return deepFreeze({
      flowVersion: REAL_A_B_C1_FLOW_VERSION,
      decision: "reject",
      sourceCandidateId: candidate.id,
      sourceCandidateRevision: candidate.dataRevision,
      confirmationReceiptId: `a-confirmation:${candidate.id}:${candidate.dataRevision}:reject`,
      opportunityPackage: null,
      ownerSupplyConfirmation: null,
      skuPackage: null,
      profitModel: null,
      c1Handoff: null,
      uniqueOwner: "none",
      externalAccesses: [],
      taskDispatches: 0,
      platformWrites: 0
    });
  }

  const evidence = createLifecycleBInputBundle({
    candidate,
    evidencePacks,
    normalizedSubmission: validation.normalized,
    createdAt: processedAt
  });
  let opportunity = opportunityPackage(candidate, validation.normalized, confirmedAt);
  const targetVariantKey = validation.normalized.supplierConfirmation.variantKey;
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey,
    scoredAt: confirmedAt
  });
  const confirmationResult = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: recommendation.recommendedSupplierOptionId,
      supplierSkuId: validation.normalized.supplierConfirmation.supplierSkuId,
      variantKey: targetVariantKey
    },
    confirmedAt
  });
  opportunity = confirmationResult.opportunityPackage;
  let skuPackage = createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: opportunity,
    ownerSupplyConfirmation: confirmationResult.confirmation,
    skuPackageId: `sku-lifecycle:${candidate.id}:${validation.normalized.supplierConfirmation.supplierSkuId}`,
    createdAt: confirmedAt
  });
  const bResult = runSkuProfitModel({
    opportunityPackage: opportunity,
    skuPackage,
    salesSelection: { salesSnapshotId: validation.normalized.salesReview.snapshotId },
    platformFeeEvidence: evidence.platformFeeEvidence,
    logisticsEvidence: evidence.logisticsEvidence,
    exchangeRateEvidence: evidence.exchangeRateEvidence,
    calculatedAt: processedAt
  });
  skuPackage = bResult.skuPackage;

  let c1Handoff = null;
  if (bResult.profitModel.result === "passed") {
    const c1Result = createC1ProductPlan({
      opportunityPackage: opportunity,
      skuPackage,
      platformSchemaEvidence: evidence.platformSchemaEvidence,
      createdAt: processedAt
    });
    skuPackage = c1Result.skuPackage;
    c1Handoff = createC1Handoff({
      opportunityPackage: opportunity,
      skuPackage,
      profitModel: bResult.profitModel,
      createdAt: processedAt
    });
  }
  if (JSON.stringify(candidate) !== before) throw new Error("REAL_A_INPUT_MUTATED");
  assertValidLifecyclePackage(opportunity);
  assertValidLifecyclePackage(skuPackage);

  return deepFreeze({
    flowVersion: REAL_A_B_C1_FLOW_VERSION,
    decision: "confirm",
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: candidate.dataRevision,
    confirmationReceiptId: `a-confirmation:${candidate.id}:${candidate.dataRevision}:confirm`,
    systemEvidenceBundle: evidence,
    opportunityPackage: opportunity,
    ownerSupplyConfirmation: confirmationResult.confirmation,
    skuPackage,
    profitModel: bResult.profitModel,
    c1Handoff,
    uniqueOwner: c1Handoff ? "listing_task" : "none",
    idempotentReplay: false,
    externalAccesses: [],
    taskDispatches: 0,
    platformWrites: 0
  });
}
