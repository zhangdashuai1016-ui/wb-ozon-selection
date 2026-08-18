import {
  MINIMUM_PROFIT_MARGIN,
  MINIMUM_UNIT_PROFIT_RMB,
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  appendProfitModelVersion,
  assertValidLifecyclePackage,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { resolveBMarketPrice } from "./market-sample-policy.mjs";

export const B_FLOW_VERSION = "single-sku-b-flow-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`B_INPUT_GAP: 缺少${label}`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value === "unknown") {
    throw new Error(`B_INPUT_GAP: 缺少${label}`);
  }
  return value;
}

function requireNumber(value, label, { positive = false, nonNegative = false } = {}) {
  if (!Number.isFinite(value)) throw new Error(`B_INPUT_GAP: 缺少${label}`);
  if (positive && value <= 0) throw new Error(`B_INPUT_GAP: ${label}必须大于0`);
  if (nonNegative && value < 0) throw new Error(`B_INPUT_GAP: ${label}不得小于0`);
  return value;
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

function roundRate(value) {
  return Number(value.toFixed(4));
}

export function createSkuLifecyclePackage({
  opportunityPackage,
  confirmedSupplierSelection,
  skuPackageId,
  readbackLimits,
  createdAt
}) {
  const opportunityValidation = validateOpportunityPackage(opportunityPackage);
  if (!opportunityValidation.valid) throw new Error("B_INPUT_GAP: OpportunityPackage校验失败");
  const confirmation = requireObject(confirmedSupplierSelection, "主人确认供应方案");
  if (confirmation.status !== "confirmed") throw new Error("B_INPUT_GAP: 供应方案未经主人确认");
  requireString(confirmation.confirmedBy, "供应方案确认人");
  requireString(confirmation.confirmedAt, "供应方案确认时间");

  const supplierOptionId = requireString(confirmation.supplierOptionId, "供应方案ID");
  const supplierOption = opportunityPackage.supplierOptions.find((item) => item.supplierOptionId === supplierOptionId);
  if (!supplierOption) throw new Error("B_INPUT_GAP: 确认的供应方案不在OpportunityPackage中");
  const supplierSkuId = requireString(confirmation.supplierSkuId, "供应商SKU ID");
  if (supplierOption.supplierSkuId !== supplierSkuId) throw new Error("B_INPUT_GAP: 供应商SKU与上游供应快照不一致");

  requireNumber(supplierOption.actualPurchaseCost, "采购到手总价", { nonNegative: true });
  const limits = requireObject(readbackLimits, "E阶段回读停止上限");
  requireNumber(limits.maxAutomaticAttempts, "最大自动回读次数", { positive: true });
  requireNumber(limits.maxConsecutiveSameFailure, "同层连续失败上限", { positive: true });

  const pkg = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "SkuLifecyclePackage",
    skuPackageId: requireString(skuPackageId, "SKU生命周期ID"),
    parentOpportunityId: opportunityPackage.parentOpportunityId,
    supplierOptionId,
    supplierSkuId,
    variantKey: requireString(confirmation.variantKey, "供应商变体"),
    targetPlatform: opportunityPackage.targetPlatform,
    targetStore: opportunityPackage.targetStore,
    dataRevision: 0,
    businessPhase: "B",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    inheritedSalesSnapshotRefs: opportunityPackage.salesSnapshots.map((item) => item.snapshotId),
    selectedSupplySnapshot: {
      snapshotId: supplierOption.supplierOptionId,
      sourceOpportunityId: opportunityPackage.parentOpportunityId,
      sourceOpportunityRevision: opportunityPackage.dataRevision,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      data: structuredClone(supplierOption)
    },
    skuFacts: {
      actualPurchaseCost: supplierOption.actualPurchaseCost,
      actualPurchaseCostCurrency: supplierOption.actualPurchaseCostCurrency,
      packedWeightKg: supplierOption.packedWeightKg,
      dimensionsCm: structuredClone(supplierOption.dimensionsCm)
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
      maxAutomaticAttempts: limits.maxAutomaticAttempts,
      automaticAttempts: 0,
      maxConsecutiveSameFailure: limits.maxConsecutiveSameFailure,
      consecutiveSameFailureCount: 0,
      lastFailureLayer: null,
      stopReason: null,
      stoppedAt: null
    },
    readbackHistory: [],
    audit: {
      createdAt: requireString(createdAt, "SKU包创建时间"),
      updatedAt: createdAt,
      history: [{
        event: "supplier_option_confirmed_for_b",
        at: confirmation.confirmedAt,
        sourceOpportunityRevision: opportunityPackage.dataRevision,
        supplierOptionId
      }]
    }
  };
  assertValidLifecyclePackage(pkg);
  return deepFreeze(pkg);
}

export function runBProfitModel({
  opportunityPackage,
  skuPackage,
  priceSelection,
  feeEvidence,
  exchangeRateEvidence,
  calculatedAt
}) {
  if (!validateOpportunityPackage(opportunityPackage).valid) throw new Error("B_INPUT_GAP: OpportunityPackage校验失败");
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "B") throw new Error("B_INPUT_GAP: 当前SKU不在B阶段");
  if (skuPackage.parentOpportunityId !== opportunityPackage.parentOpportunityId) {
    throw new Error("B_INPUT_GAP: SKU与OpportunityPackage不属于同一商品方向");
  }
  if (skuPackage.selectedSupplySnapshot.sourceOpportunityRevision !== opportunityPackage.dataRevision) {
    throw new Error("B_INPUT_GAP: 供应快照不是当前OpportunityPackage版本");
  }

  const selection = requireObject(priceSelection, "A阶段销售价格选择");
  const salesSnapshotId = requireString(selection.salesSnapshotId, "销售快照ID");
  const resolvedMarket = resolveBMarketPrice(opportunityPackage, salesSnapshotId);
  const salesSnapshot = resolvedMarket.snapshot;
  if (!salesSnapshot) throw new Error("B_INPUT_GAP: 销售快照不在OpportunityPackage中");
  if (!skuPackage.inheritedSalesSnapshotRefs.includes(salesSnapshotId)) {
    throw new Error("B_INPUT_GAP: SKU没有继承所选销售快照");
  }
  if (salesSnapshot.sourceDataRevision !== opportunityPackage.dataRevision) {
    throw new Error("B_INPUT_GAP: 销售快照不是当前OpportunityPackage版本");
  }
  const marketPriceRub = requireNumber(resolvedMarket.recommendedSalePrice.amount, "A阶段销售价格", { positive: true });
  if (resolvedMarket.recommendedSalePrice.currency !== "RUB") throw new Error("B_INPUT_GAP: 当前单SKU测试只接受明确的RUB销售快照");

  const supply = requireObject(skuPackage.selectedSupplySnapshot?.data, "主人确认供应快照");
  const actualPurchaseCost = requireNumber(supply.actualPurchaseCost, "采购到手总价", { nonNegative: true });
  const fees = requireObject(feeEvidence, "费用证据");
  const feeEvidenceId = requireString(fees.evidenceId, "费用证据ID");
  const commissionRate = requireNumber(fees.commissionRate, "佣金率", { nonNegative: true });
  const logisticsRmb = requireNumber(fees.internationalLogisticsRmb, "国际物流", { nonNegative: true });
  const packagingRmb = requireNumber(fees.packagingRmb, "包装成本", { nonNegative: true });
  const labelRmb = requireNumber(fees.labelRmb, "贴标成本", { nonNegative: true });
  const advertisingReserveRate = requireNumber(fees.advertisingReserveRate, "广告预留率", { nonNegative: true });
  const returnReserveRate = requireNumber(fees.returnReserveRate, "退货运营预留率", { nonNegative: true });
  const damageReserveRate = requireNumber(fees.damageReserveRate, "破损丢失预留率", { nonNegative: true });
  const otherCostRmb = requireNumber(fees.otherCostRmb, "其他成本", { nonNegative: true });
  const totalVariableRate = commissionRate + advertisingReserveRate + returnReserveRate + damageReserveRate;
  if (totalVariableRate >= 1) throw new Error("B_INPUT_GAP: 费率合计必须小于100%");

  const fx = requireObject(exchangeRateEvidence, "汇率证据");
  const exchangeRateEvidenceId = requireString(fx.evidenceId, "汇率证据ID");
  const rubPerCny = requireNumber(fx.rubPerCny, "RUB/CNY汇率", { positive: true });
  const recommendedSalePriceCny = roundMoney(marketPriceRub / rubPerCny);
  const sellerRevenueAfterCommissionCny = roundMoney(recommendedSalePriceCny * (1 - commissionRate));
  const unitProfitRmb = roundMoney(
    recommendedSalePriceCny * (1 - totalVariableRate) -
    actualPurchaseCost - logisticsRmb - packagingRmb - labelRmb - otherCostRmb
  );
  const profitMargin = roundRate(unitProfitRmb / recommendedSalePriceCny);
  const result = unitProfitRmb >= MINIMUM_UNIT_PROFIT_RMB || profitMargin >= MINIMUM_PROFIT_MARGIN
    ? "passed"
    : "rejected";
  const version = `profit-v${skuPackage.profitModels.length + 1}`;
  const model = {
    profitModelVersion: version,
    calculatedAt: requireString(calculatedAt, "利润计算时间"),
    inputSnapshotRefs: [
      salesSnapshotId,
      skuPackage.selectedSupplySnapshot.snapshotId,
      feeEvidenceId,
      exchangeRateEvidenceId
    ],
    marketAssessmentRef: resolvedMarket.assessment.assessmentId,
    marketSampleRefs: structuredClone(resolvedMarket.assessment.primarySampleIds),
    marketSellerTypesUsed: structuredClone(resolvedMarket.assessment.sellerTypesUsed),
    marketConfidence: resolvedMarket.assessment.confidence,
    containsLocalRuBackground: resolvedMarket.assessment.containsLocalRuBackground,
    recommendedSalePriceCny,
    unitProfitRmb,
    profitMargin,
    result,
    sellerRevenueAfterCommissionCny,
    executionMode: "upstream_snapshots_only",
    externalAccesses: [],
    requestedExistingFields: [],
    inputs: {
      salesPrice: { value: marketPriceRub, currency: "RUB", sourceRef: salesSnapshotId, sourcePath: "marketAssessment.recommendedSalePrice.amount" },
      purchaseCost: { value: actualPurchaseCost, currency: "CNY", sourceRef: skuPackage.selectedSupplySnapshot.snapshotId },
      logistics: { value: logisticsRmb, currency: "CNY", sourceRef: feeEvidenceId },
      commission: { rate: commissionRate, sourceRef: feeEvidenceId, evidenceType: fees.commissionEvidenceType },
      exchangeRate: { rubPerCny, sourceRef: exchangeRateEvidenceId },
      otherCosts: {
        packagingRmb,
        labelRmb,
        otherCostRmb,
        advertisingReserveRate,
        returnReserveRate,
        damageReserveRate,
        sourceRef: feeEvidenceId
      }
    },
    formula: "建议成交价CNY=销售快照RUB÷RUB/CNY；利润=建议成交价×(1-佣金-广告预留-退货预留-破损预留)-采购到手价-国际物流-包装-贴标-其他成本；利润率=利润÷建议成交价"
  };

  const next = appendProfitModelVersion(skuPackage, model);
  const completed = structuredClone(next);
  completed.businessResult = result;
  completed.technicalStatus = "completed";
  completed.audit.history.push({
    event: "b_profit_model_completed",
    at: calculatedAt,
    profitModelVersion: version,
    inputSnapshotRefs: structuredClone(model.inputSnapshotRefs)
  });
  assertValidLifecyclePackage(completed);
  return deepFreeze({
    flowVersion: B_FLOW_VERSION,
    skuPackage: completed,
    profitModel: completed.profitModels.at(-1)
  });
}
