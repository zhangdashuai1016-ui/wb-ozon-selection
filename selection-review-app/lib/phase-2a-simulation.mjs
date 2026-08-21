import { createC1ProductPlan } from "./c1-product-plan.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";
import { PRODUCT_LIFECYCLE_SCHEMA_VERSION, assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { runSkuProfitModel } from "./profit-model.mjs";
import { collectMockOzonSalesSnapshot } from "./sales-snapshot.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "./supplier-selection-flow.mjs";
import { assertValidSupplierOption } from "./supplier-option.mjs";

export const PHASE_2A_SIMULATION_VERSION = "phase-2a-closure-v1.1";
export const PHASE_2A_DEMO_ID = "SIM-2A-ONE-CARD-001";

const FIXED_TIME = "2026-08-15T03:00:00.000Z";
const SALES_SNAPSHOT_ID = "sales-snapshot:sim-2a-unknown-001";
const OPPORTUNITY_ID = "opportunity:sim-2a-001";
const SUPPLIER_OPTION_ID = "supplier-option:1688:sim-2a-001";
const SUPPLIER_EVIDENCE_REF = "simulation:1688:sim-2a-001";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

function valid1688Url(value) {
  return /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#].*)?$/i.test(String(value || "").trim());
}

export function phase2ADemoCard() {
  return Object.freeze({
    simulationVersion: PHASE_2A_SIMULATION_VERSION,
    simulationId: PHASE_2A_DEMO_ID,
    isSimulation: true,
    sharedCandidateId: null,
    sharedCandidatesAffected: 0,
    title: "第2A单SKU模拟验收",
    productName: "模拟木质机械模型",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    directionDecisionOptions: ["confirm", "reject"],
    salesSnapshot: {
      schemaVersion: "sales-snapshot-v1.1",
      snapshotId: SALES_SNAPSHOT_ID,
      source: "模拟Ozon页面组件",
      sourceVersion: "mock-ozon-sales-snapshot-v1",
      validUntil: "2026-08-16T03:00:00.000Z",
      sellerType: "unknown",
      sellerIdentityEvidenceStatus: "unverified",
      sellerIdentityLabel: "卖家身份未确认，当前商品和价格证据可用。",
      comparability: "comparable",
      confidence: "limited",
      currentPriceRub: 1831,
      evidenceRef: "simulation:ozon:page-components:001"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/712421624571.html",
      supplierSkuId: "SIM-SKU-282",
      variantKey: "规格:282件机械火车",
      unitProductPrice: 35,
      unitDomesticFreight: 6,
      actualPurchaseCost: 41,
      weightKg: 0.21,
      dimensionsCm: { length: 23, width: 16, height: 3 }
    },
    initialStatus: {
      businessPhase: "A",
      businessResult: "pending",
      technicalStatus: "completed",
      ownerAction: "confirm_direction",
      uniqueOwner: "owner"
    },
    actionLabel: "确认方向和供应SKU，一次进入B利润计算",
    boundary: "纯模拟；不进入52条候选，不派发任务，不访问平台，不写店"
  });
}

export function validatePhase2AConfirmationCard(input) {
  const supplier = isObject(input?.supplierConfirmation) ? input.supplierConfirmation : {};
  const missing = [];
  if (!valid1688Url(supplier.productUrl)) missing.push({ field: "productUrl", label: "准确1688供应链接" });
  if (!String(supplier.supplierSkuId || "").trim()) missing.push({ field: "supplierSkuId", label: "具体供应SKU" });
  const unitProductPrice = number(supplier.unitProductPrice);
  const unitDomesticFreight = number(supplier.unitDomesticFreight);
  const actualPurchaseCost = number(supplier.actualPurchaseCost);
  const weightKg = number(supplier.weightKg);
  if (!(unitProductPrice > 0)) missing.push({ field: "unitProductPrice", label: "商品价" });
  if (!(unitDomesticFreight >= 0)) missing.push({ field: "unitDomesticFreight", label: "国内运费" });
  if (!(actualPurchaseCost > 0)) missing.push({ field: "actualPurchaseCost", label: "实际采购成本" });
  if (!(weightKg > 0)) missing.push({ field: "weightKg", label: "重量" });
  const dimensions = isObject(supplier.dimensionsCm) ? supplier.dimensionsCm : {};
  for (const [field, label] of [["length", "长度"], ["width", "宽度"], ["height", "高度"]]) {
    if (!(number(dimensions[field]) > 0)) missing.push({ field: `dimensionsCm.${field}`, label });
  }
  if (unitProductPrice > 0 && unitDomesticFreight >= 0 && actualPurchaseCost > 0 &&
      Math.abs(unitProductPrice + unitDomesticFreight - actualPurchaseCost) > 0.01) {
    missing.push({ field: "actualPurchaseCost", label: "实际采购成本需等于商品价加国内运费" });
  }
  return { valid: missing.length === 0, missing };
}

function salesSnapshot(sellerType = "unknown") {
  const verified = sellerType !== "unknown";
  return collectMockOzonSalesSnapshot({
    sourceMode: "mock_ozon_fixture",
    snapshotId: SALES_SNAPSHOT_ID,
    marketScope: sellerType === "cross_border_cn" ? "ozon_cn_cross_border" : "ozon_general_market",
    sellerType,
    sellerIdentityEvidence: {
      status: verified ? "verified" : "unverified",
      signals: verified ? [{ field: "seller_registered_country", value: sellerType === "local_ru" ? "RU" : "CN", sourcePath: "simulation.seller" }] : [],
      evidenceRef: "simulation:ozon:seller-identity:001"
    },
    productUrl: "https://www.ozon.ru/product/simulation-2a-001/",
    title: "Механический деревянный 3D-пазл",
    imageRefs: ["simulation://ozon/image-001"],
    currentPrice: 1831,
    currency: "RUB",
    categoryPath: "Хобби и творчество > 3D-пазлы",
    attributes: { productType: "3D-пазл" },
    collectedAt: FIXED_TIME,
    evidenceRef: "simulation:ozon:page-components:001"
  });
}

function opportunityWithSupply(input, { sellerType = "unknown", comparability = "comparable", priceEvidenceStatus = "verified" } = {}) {
  const snapshot = salesSnapshot(sellerType);
  const supplier = input.supplierConfirmation;
  const option = {
    supplierOptionId: SUPPLIER_OPTION_ID,
    sourcePlatform: "1688",
    productUrl: supplier.productUrl.trim(),
    offerId: new URL(supplier.productUrl).pathname.match(/(\d+)/)?.[1] || "unknown",
    supplierSalesEvidence: { salesVolume: 500, stabilityScore: 80 },
    supplierBadges: ["牛头供应商"],
    supplierSkus: [{
      supplierSkuId: supplier.supplierSkuId.trim(),
      variantKey: String(supplier.variantKey || supplier.supplierSkuId).trim(),
      attributes: { 规格: String(supplier.variantKey || supplier.supplierSkuId).trim() },
      unitProductPrice: number(supplier.unitProductPrice),
      unitDomesticFreight: number(supplier.unitDomesticFreight),
      actualPurchaseCost: number(supplier.actualPurchaseCost),
      weight: { value: number(supplier.weightKg), unit: "kg" },
      dimensions: {
        length: number(supplier.dimensionsCm.length),
        width: number(supplier.dimensionsCm.width),
        height: number(supplier.dimensionsCm.height),
        unit: "cm"
      },
      material: "unknown",
      powerProfile: "unknown",
      imageRefs: "unknown"
    }],
    captureTime: FIXED_TIME,
    evidenceRef: SUPPLIER_EVIDENCE_REF
  };
  assertValidSupplierOption(option);
  const opportunity = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: OPPORTUNITY_ID,
    directionName: "模拟木质机械模型",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    dataRevision: 1,
    businessPhase: "A",
    businessResult: "passed",
    technicalStatus: "completed",
    ownerAction: "confirm_supplier_option",
    salesSnapshots: [snapshot],
    marketAssessment: null,
    supplierOptions: [option],
    recommendedSupplierOptionId: null,
    confirmedSupplierOptionId: null,
    supplierSearch: {
      status: "completed",
      limits: { maxSearchRounds: 2, maxSupplierOptions: 3, maxConsecutiveNoEvidenceRounds: 1 },
      searchRounds: 1,
      supplierOptionsFound: 1,
      consecutiveNoEvidenceRounds: 0,
      stopReason: "enough_qualified_options",
      stoppedAt: FIXED_TIME
    },
    audit: {
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      history: [{ event: "phase_2a_simulation_created", at: FIXED_TIME }]
    }
  };
  opportunity.marketAssessment = assessAStageMarket({
    opportunityPackage: opportunity,
    sampleReviews: {
      [snapshot.snapshotId]: {
        comparability,
        priceEvidenceStatus,
        validityStatus: "current",
        evidenceTraceable: true
      }
    },
    assessedAt: FIXED_TIME,
    assessmentId: "a-market:sim-2a-001",
    supplyDataStatus: "ready"
  });
  opportunity.businessResult = opportunity.marketAssessment.businessResult;
  opportunity.ownerAction = opportunity.marketAssessment.ownerAction;
  assertValidLifecyclePackage(opportunity);
  return opportunity;
}

function listPriceScenarios(recommendedSalePriceRub) {
  return [0.2, 0.25, 0.3].map((discountRate) => ({
    discountRate,
    suggestedListPriceRub: Math.ceil(recommendedSalePriceRub / (1 - discountRate)),
    formula: "建议成交价÷(1-促销率)"
  }));
}

export function ensurePhase2AC1Handoff(records, { skuPackage, opportunityPackage, profitModel, createdAt = FIXED_TIME }) {
  const handoffId = `c1-handoff:${skuPackage.skuPackageId}:${profitModel.profitModelVersion}`;
  const current = Array.isArray(records) ? structuredClone(records) : [];
  const existing = current.find((item) => item.handoffId === handoffId);
  if (existing) return { records: current, handoff: existing, created: false };
  const handoff = {
    handoffId,
    status: "queued",
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
  current.push(handoff);
  return { records: current, handoff, created: true };
}

export function runPhase2AConfirmation(input, options = {}) {
  const decision = input?.decision;
  if (decision === "reject") {
    return Object.freeze({
      simulationVersion: PHASE_2A_SIMULATION_VERSION,
      simulationId: PHASE_2A_DEMO_ID,
      isSimulation: true,
      status: "eliminated",
      statusLines: {
        businessPhase: "A",
        businessResult: "rejected",
        technicalStatus: "completed",
        ownerAction: "none"
      },
      uniqueOwner: "none",
      bExecution: null,
      c1Handoffs: [],
      sharedCandidatesAffected: 0,
      realTaskDispatches: 0,
      externalAccesses: [],
      platformWrites: 0
    });
  }
  if (decision !== "confirm") throw new Error("PHASE_2A_DECISION_REQUIRED: 请选择确认方向或淘汰");
  const cardValidation = validatePhase2AConfirmationCard(input);
  if (!cardValidation.valid) {
    return Object.freeze({
      simulationVersion: PHASE_2A_SIMULATION_VERSION,
      simulationId: PHASE_2A_DEMO_ID,
      isSimulation: true,
      status: "a_input_gap",
      missing: cardValidation.missing,
      statusLines: {
        businessPhase: "A",
        businessResult: "pending",
        technicalStatus: "completed",
        ownerAction: "provide_supply_data"
      },
      uniqueOwner: "owner",
      bExecution: null,
      c1Handoffs: [],
      sharedCandidatesAffected: 0,
      realTaskDispatches: 0,
      externalAccesses: [],
      platformWrites: 0
    });
  }

  const opportunity = opportunityWithSupply(input, options);
  if (opportunity.marketAssessment.status !== "passed") {
    return Object.freeze({
      simulationVersion: PHASE_2A_SIMULATION_VERSION,
      simulationId: PHASE_2A_DEMO_ID,
      isSimulation: true,
      status: "a_evidence_gap",
      reason: opportunity.marketAssessment.gateReason,
      opportunityPackage: opportunity,
      statusLines: {
        businessPhase: "A",
        businessResult: "pending",
        technicalStatus: "completed",
        ownerAction: "none"
      },
      uniqueOwner: "selection_task",
      bExecution: null,
      c1Handoffs: [],
      sharedCandidatesAffected: 0,
      realTaskDispatches: 0,
      externalAccesses: [],
      platformWrites: 0
    });
  }

  const targetVariantKey = input.supplierConfirmation.variantKey || input.supplierConfirmation.supplierSkuId;
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey,
    scoredAt: "2026-08-14T03:01:00.000Z"
  });
  const confirmed = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: recommendation.recommendedSupplierOptionId,
      supplierSkuId: input.supplierConfirmation.supplierSkuId,
      variantKey: targetVariantKey
    },
    confirmedAt: "2026-08-14T03:02:00.000Z"
  });
  const skuPackage = createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: confirmed.opportunityPackage,
    ownerSupplyConfirmation: confirmed.confirmation,
    skuPackageId: `sku-lifecycle:${PHASE_2A_DEMO_ID}:${input.supplierConfirmation.supplierSkuId}`,
    createdAt: "2026-08-14T03:03:00.000Z"
  });
  const bResult = runSkuProfitModel({
    opportunityPackage: confirmed.opportunityPackage,
    skuPackage,
    salesSelection: { salesSnapshotId: SALES_SNAPSHOT_ID },
    platformFeeEvidence: {
      evidenceId: "simulation:fees:ozon:001",
      commissionRate: 0.14,
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0.05,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    },
    logisticsEvidence: {
      evidenceId: "simulation:logistics:guoo:001",
      route: "GUOO Economy Small",
      amountRmb: 26.4
    },
    exchangeRateEvidence: {
      evidenceId: "simulation:fx:rub-cny:001",
      rubPerCny: 12.0637
    },
    calculatedAt: "2026-08-14T03:04:00.000Z"
  });

  let currentSku = bResult.skuPackage;
  let c1Handoffs = [];
  let c1Handoff = null;
  if (bResult.profitModel.result === "passed") {
    const c1 = createC1ProductPlan({
      opportunityPackage: confirmed.opportunityPackage,
      skuPackage: currentSku,
      platformSchemaEvidence: {
        evidenceId: "simulation:schema:ozon:dandanshu:001",
        platform: "ozon",
        store: "dandanshu",
        schemaRevision: "simulation-2026-08-14",
        collectedAt: "2026-08-14T03:04:30.000Z",
        requiredFields: [
          { fieldKey: "brand", label: "品牌", required: true, sourceAttributeKeys: ["brand"] },
          { fieldKey: "model", label: "型号", required: true, sourceAttributeKeys: ["model"] }
        ]
      },
      createdAt: "2026-08-14T03:05:00.000Z"
    });
    currentSku = c1.skuPackage;
    const handoffResult = ensurePhase2AC1Handoff([], {
      skuPackage: currentSku,
      opportunityPackage: confirmed.opportunityPackage,
      profitModel: bResult.profitModel,
      createdAt: "2026-08-14T03:05:00.000Z"
    });
    c1Handoffs = handoffResult.records;
    c1Handoff = handoffResult.handoff;
  }

  return Object.freeze({
    simulationVersion: PHASE_2A_SIMULATION_VERSION,
    simulationId: PHASE_2A_DEMO_ID,
    isSimulation: true,
    status: bResult.profitModel.result === "passed" ? "c1_handed_off" : "b_rejected",
    opportunityPackage: confirmed.opportunityPackage,
    ownerSupplyConfirmation: confirmed.confirmation,
    skuPackage: currentSku,
    bExecution: {
      autoStarted: true,
      externalPlatformAccessCounts: { ozon: 0, wb: 0, "1688": 0, pinduoduo: 0 },
      supplierResearchCount: 0,
      repeatedQuestionFields: [],
      inputRefs: structuredClone(bResult.profitModel.inputSnapshotRefs),
      profitModel: bResult.profitModel,
      suggestedListPricesRub: listPriceScenarios(bResult.profitModel.recommendedSalePriceRub)
    },
    statusLines: {
      businessPhase: currentSku.businessPhase,
      businessResult: currentSku.businessResult,
      technicalStatus: currentSku.technicalStatus,
      ownerAction: currentSku.ownerAction
    },
    uniqueOwner: c1Handoff ? "listing_task" : "selection_task",
    c1Handoffs,
    c1Handoff,
    sharedCandidatesAffected: 0,
    realTaskDispatches: 0,
    externalAccesses: [],
    platformWrites: 0,
    proof: {
      sameParentOpportunityId: currentSku.parentOpportunityId === confirmed.opportunityPackage.parentOpportunityId,
      inheritedOpportunityRevision: c1Handoff?.inheritedOpportunityRevision ?? null,
      inheritedSkuRevision: c1Handoff?.inheritedSkuRevision ?? null,
      selectionTaskStopped: c1Handoff?.selectionTaskStopped === true,
      noDualOwnership: c1Handoff ? c1Handoff.uniqueOwner === "listing_task" : true,
      profitHistoryAppendOnly: true
    }
  });
}

export function applyPhase2ATechnicalFailure(result, technicalStatus = "system_error") {
  if (!isObject(result?.statusLines)) throw new Error("PHASE_2A_RESULT_REQUIRED");
  return Object.freeze({
    ...structuredClone(result),
    statusLines: {
      ...structuredClone(result.statusLines),
      technicalStatus
    },
    technicalFailureEffect: "business_state_unchanged"
  });
}

export function phase2AResultSummary(result) {
  if (!result?.bExecution) return null;
  const profit = result.bExecution.profitModel;
  return Object.freeze({
    recommendedSalePriceRub: profit.recommendedSalePriceRub,
    recommendedSalePriceCny: profit.recommendedSalePriceCny,
    suggestedListPricesRub: structuredClone(result.bExecution.suggestedListPricesRub),
    settlementRevenueCny: profit.sellerSettlementRevenue.amount,
    actualPurchaseCostCny: profit.actualPurchaseCost.amount,
    internationalFreightCny: profit.internationalFreight.amount,
    otherCostsCny: profit.otherCosts.amount,
    unitProfitRmb: profit.unitProfitRmb,
    profitMargin: profit.profitMargin,
    formula: profit.formula,
    result: profit.result,
    formulaCheck: rounded(
      profit.sellerSettlementRevenue.amount -
      profit.internationalFreight.amount -
      profit.actualPurchaseCost.amount -
      profit.otherCosts.amount
    )
  });
}
