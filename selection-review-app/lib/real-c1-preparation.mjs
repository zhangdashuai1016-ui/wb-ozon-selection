import { adaptLegacyCandidateToOpportunity } from "./legacy-candidate-adapter.mjs";
import { UNKNOWN, assertValidSupplierOption } from "./supplier-option.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "./supplier-selection-flow.mjs";
import { runSkuProfitModel } from "./profit-model.mjs";
import { createC1ProductPlan, verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { createC1SeoDraft } from "./c1-seo-draft.mjs";
import { createC2AssetLifecycle, confirmFinalUploads } from "./c2-asset-lifecycle.mjs";
import { createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";

export const REAL_C1_PREPARATION_VERSION = "real-c1-preparation-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function requireValue(value, message) {
  if (value === null || value === undefined || value === "" || value === "unknown") throw new Error(message);
  return value;
}

function requireNumber(value, message, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0)) throw new Error(message);
  return value;
}

function confirmExactOwnerFacts(confirmation) {
  if (!isObject(confirmation) || confirmation.confirmedBy !== "owner" || !isoDateTime(confirmation.confirmedAt)) {
    throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 缺少当前主人确认");
  }
  if (confirmation.brandDecision !== "no_brand") throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 品牌状态尚未确认");
  if (!nonEmptyString(confirmation.material)) throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 材质尚未确认");
  if (!Number.isInteger(confirmation.pieceCount) || confirmation.pieceCount <= 0) throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 片数尚未确认");
  if (confirmation.mechanism !== "mechanical_wind_up") throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 机械结构尚未确认");
  if (confirmation.powered !== false || confirmation.containsBattery !== false) {
    throw new Error("REAL_C1_OWNER_CONFIRMATION_REQUIRED: 非电和无电池事实尚未确认");
  }
  return structuredClone(confirmation);
}

function currentEvidence(candidate) {
  const capture = candidate.sourceCapture;
  const cStage = candidate.codexReview?.cStageReview;
  const profit = candidate.codexReview?.profitCalculation;
  if (candidate.id !== "CX-20260803-010") throw new Error("REAL_C1_SCOPE_REJECTED: 第13C当前只允许CX-20260803-010");
  if (!Number.isInteger(candidate.dataRevision)) throw new Error("REAL_C1_INPUT_GAP: 缺少候选修订号");
  if (capture?.status !== "verified" || !nonEmptyString(capture.captureId)) throw new Error("REAL_C1_INPUT_GAP: 1688采集结果未验证");
  if (capture.offerId !== "712421624571") throw new Error("REAL_C1_INPUT_CONFLICT: 1688 offerId不一致");
  if (!Array.isArray(capture.selectedSkus) || capture.selectedSkus.length !== 1) throw new Error("REAL_C1_INPUT_GAP: 必须锁定一个精确供应SKU");
  const selectedSku = capture.selectedSkus[0];
  if (selectedSku.sourceSkuId !== "4993364145574") throw new Error("REAL_C1_INPUT_CONFLICT: 精确供应SKU不一致");
  if (cStage?.sourceCaptureId !== capture.captureId || cStage?.exactSourceSku !== selectedSku.sourceSkuId) {
    throw new Error("REAL_C1_INPUT_CONFLICT: C阶段证据与当前1688采集不一致");
  }
  if (cStage.commission?.sourceType !== "real_same_description_category_seller_api") {
    throw new Error("REAL_C1_INPUT_GAP: 当前精确佣金证据未取得");
  }
  requireNumber(cStage.commission.rate, "REAL_C1_INPUT_GAP: 缺少当前佣金");
  requireNumber(cStage.logistics?.freightRmb, "REAL_C1_INPUT_GAP: 缺少当前国际物流");
  requireNumber(candidate.purchasePriceRmb, "REAL_C1_INPUT_GAP: 缺少采购到手总价");
  requireNumber(candidate.packedWeightKg, "REAL_C1_INPUT_GAP: 缺少实际打包重量", { positive: true });
  requireNumber(candidate.expectedPriceRub, "REAL_C1_INPUT_GAP: 缺少B阶段建议售价", { positive: true });
  requireNumber(candidate.codexReview?.exchangeRate?.rubPerCny, "REAL_C1_INPUT_GAP: 缺少B阶段汇率", { positive: true });
  if (profit?.directionalStatus !== "passed") throw new Error("REAL_C1_INPUT_GAP: B阶段利润未通过");
  return { capture, cStage, profit, selectedSku };
}

function ownerFactRef(candidate, ownerFacts) {
  return `owner-confirmation:${candidate.id}:${ownerFacts.confirmedAt}`;
}

function replaceTextDeep(value, from, to) {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((item) => replaceTextDeep(item, from, to));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceTextDeep(child, from, to)]));
  }
  return value;
}

function buildSupplierOption(candidate, evidence, ownerFacts) {
  const { capture, selectedSku } = evidence;
  const dimensions = candidate.dimensionsCm;
  const option = {
    supplierOptionId: `supplier-option:1688:${capture.offerId}`,
    sourcePlatform: "1688",
    productUrl: capture.sourceUrl,
    offerId: capture.offerId,
    supplierSalesEvidence: UNKNOWN,
    supplierBadges: UNKNOWN,
    supplierSkus: [{
      supplierSkuId: selectedSku.sourceSkuId,
      variantKey: selectedSku.propPath || `规格=${selectedSku.attributes?.规格 || "豪华小火车"}`,
      attributes: {
        ...(selectedSku.attributes || {}),
        brand: "Нет бренда",
        model_name: "Механический 3D-пазл «Паровоз»",
        type: "3D-пазл",
        piece_count: ownerFacts.pieceCount,
        mechanism: ownerFacts.mechanism,
        powered: ownerFacts.powered,
        contains_battery: ownerFacts.containsBattery
      },
      unitProductPrice: UNKNOWN,
      unitDomesticFreight: UNKNOWN,
      actualPurchaseCost: candidate.purchasePriceRmb,
      weight: { value: candidate.packedWeightKg, unit: "kg", evidenceRef: `candidate:${candidate.id}:revision-${candidate.dataRevision}#packedWeightKg` },
      dimensions: { length: dimensions.length, width: dimensions.width, height: dimensions.height, unit: "cm", evidenceRef: `candidate:${candidate.id}:revision-${candidate.dataRevision}#dimensionsCm` },
      material: ownerFacts.material,
      powerProfile: {
        powered: false,
        containsBattery: false,
        batteryType: "not_applicable",
        batteryCount: 0,
        mechanism: ownerFacts.mechanism,
        evidenceRef: ownerFactRef(candidate, ownerFacts)
      },
      imageRefs: UNKNOWN
    }],
    captureTime: capture.observedAt,
    evidenceRef: `source-capture:${capture.captureId}`
  };
  assertValidSupplierOption(option);
  return option;
}

function prepareOpportunity(candidate, option, preparedAt) {
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.salesSnapshots = opportunity.salesSnapshots.filter((snapshot) => snapshot?.schemaVersion === "sales-snapshot-v1.1");
  if (!opportunity.salesSnapshots.length) throw new Error("REAL_C1_INPUT_GAP: 缺少可追溯的A阶段销售快照");
  const sampleReviews = Object.fromEntries(opportunity.salesSnapshots.map((snapshot) => [
    snapshot.snapshotId,
    {
      comparability: snapshot.productUrl === candidate.productUrl ? "comparable" : "unknown",
      priceEvidenceStatus: Number.isFinite(snapshot.currentPrice) && snapshot.currentPrice > 0 ? "verified" : "missing",
      validityStatus: "current",
      evidenceTraceable: nonEmptyString(snapshot.evidenceRef)
    }
  ]));
  opportunity.marketAssessment = assessAStageMarket({
    opportunityPackage: opportunity,
    sampleReviews,
    assessedAt: preparedAt,
    assessmentId: "a-market:" + candidate.id + ":revision-" + candidate.dataRevision,
    marketCriteriaStatus: "passed",
    supplyDataStatus: "ready"
  });
  if (opportunity.marketAssessment.status !== "passed") {
    throw new Error("REAL_C1_INPUT_GAP: 销售证据不足或商品可比性不足");
  }
  opportunity.businessPhase = "A";
  opportunity.businessResult = "passed";
  opportunity.technicalStatus = "completed";
  opportunity.ownerAction = "confirm_supplier_option";
  opportunity.salesSnapshots[0].categoryPath = candidate.codexReview?.cStageReview?.categoryPath || candidate.codexReview?.category?.path || UNKNOWN;
  opportunity.supplierOptions = [option];
  opportunity.recommendedSupplierOptionId = null;
  opportunity.confirmedSupplierOptionId = null;
  opportunity.supplierSearch = {
    status: "completed",
    limits: { maxSearchRounds: 1, maxSupplierOptions: 1, maxConsecutiveNoEvidenceRounds: 1 },
    searchRounds: 1,
    supplierOptionsFound: 1,
    consecutiveNoEvidenceRounds: 0,
    stopReason: "scope_completed",
    stoppedAt: preparedAt
  };
  opportunity.audit.updatedAt = preparedAt;
  opportunity.audit.history.push({
    event: "real_single_sku_supplier_evidence_frozen_for_13c",
    at: preparedAt,
    sourceCandidateRevision: candidate.dataRevision,
    sourceCaptureId: candidate.sourceCapture.captureId,
    externalAccesses: [],
    platformWrites: 0
  });
  return opportunity;
}

function schemaEvidence(candidate, evidence, ownerFacts) {
  const ref = ownerFactRef(candidate, ownerFacts);
  return {
    evidenceId: `schema:ozon:dandanshu:${evidence.cStage.descriptionCategoryId}:${evidence.cStage.typeId}:${evidence.cStage.checkedAt}`,
    platform: "ozon",
    store: candidate.targetStore,
    descriptionCategoryId: String(evidence.cStage.descriptionCategoryId),
    typeId: String(evidence.cStage.typeId),
    categoryName: "3D-пазл",
    schemaRevision: `ozon-schema:${evidence.cStage.descriptionCategoryId}:${evidence.cStage.typeId}:${evidence.cStage.checkedAt}`,
    requiredFields: [
      { fieldKey: "brand", label: "品牌", required: true, sourceAttributeKeys: ["brand"] },
      { fieldKey: "model_name", label: "模型名", required: true, sourceAttributeKeys: ["model_name"] },
      { fieldKey: "type", label: "类型", required: true, sourceAttributeKeys: ["type"] }
    ],
    categoryRestrictions: [],
    platformCompliance: {
      status: "c1_facts_clear_pending_final_asset_rights",
      evidenceRefs: [ref, `candidate:${candidate.id}:revision-${candidate.dataRevision}#complianceStatus`],
      limitation: "最终图片和视频的授权及顺序在C2单独确认"
    },
    collectedAt: evidence.cStage.checkedAt
  };
}

function supplierFactPath(plan, fieldKey) {
  const index = plan.productAttributes.supplierAttributes.findIndex((item) => item.fieldKey === fieldKey);
  if (index < 0) throw new Error(`REAL_C1_SEO_INPUT_GAP: 缺少事实字段${fieldKey}`);
  return `productAttributes.supplierAttributes.${index}.fact`;
}

function buildSeoEvidence(candidate, factsPlan, preparedAt, ownerFacts) {
  const sourceSku = "3126033809";
  const factRef = ownerFactRef(candidate, ownerFacts);
  const sourceRef = candidate.productUrl;
  const keyword = (query, group, factBindingPaths, reason) => ({
    query,
    group,
    keywordEvidenceRef: `${factRef}#ru-RU/${encodeURIComponent(query)}`,
    sourcePlatform: "ozon",
    sourceSku,
    relevanceStatus: "retained",
    factBindingPaths,
    reason
  });
  return {
    competitorTextSnapshot: {
      snapshotId: `competitor-text:${candidate.id}:revision-${candidate.dataRevision}`,
      sourceSalesSnapshotId: factsPlan.inputRefs.salesSnapshotId,
      observedAt: candidate.codexReview?.marketEvidence?.checkedAt || candidate.updatedAt,
      evidenceRef: `sales-snapshot:${factsPlan.inputRefs.salesSnapshotId}#current_product`,
      texts: [{
        textId: `ozon-current-product-${sourceSku}`,
        text: candidate.productName,
        sourceRef,
        role: "frozen_current_product_reference"
      }]
    },
    keywordEvidence: {
      evidenceId: `seo-evidence:${candidate.id}:current-facts:${preparedAt}`,
      status: "ready",
      targetPlatform: factsPlan.identity.targetPlatform,
      targetSkuPackageId: factsPlan.identity.skuPackageId,
      sourcePlatform: "ozon",
      collectionMode: "current_frozen_facts_no_volume",
      pointsSpent: 0,
      observedAt: preparedAt,
      reuseEvidenceNote: "未发现与本SKU匹配的现成Seerfar结果，本轮未扣点；只用当前冻结商品事实生成俄语事实词，不声明搜索量或热度，草稿仍需主人审核。",
      keywords: [
        keyword("механический 3D-пазл", "core_product_type", ["platformCategory.categoryName", supplierFactPath(factsPlan, "mechanism")], "对应当前3D拼图类目和主人确认的机械发条事实"),
        keyword(`паровоз, ${ownerFacts.pieceCount} детали`, "product_form", ["exactSkuVerification.variantKey", supplierFactPath(factsPlan, "piece_count")], `对应豪华小火车精确SKU和主人确认的${ownerFacts.pieceCount}件`),
        keyword("из ДВП", "material", ["productAttributes.material"], "对应主人确认的DVP材质"),
        keyword("заводной механизм", "mechanism", [supplierFactPath(factsPlan, "mechanism")], "对应主人确认的机械发条结构"),
        keyword("без батареек", "power", ["batteryAssessment.assessment"], "对应主人确认的无电池事实")
      ]
    }
  };
}

export function prepareRealC1ForFinalAssets({ candidate, ownerFactConfirmation, preparedAt }) {
  if (!isObject(candidate) || !isoDateTime(preparedAt)) throw new Error("REAL_C1_INPUT_GAP: 输入无效");
  if (candidate.lifecycleV11?.skuPackage) throw new Error("REAL_C1_DUPLICATE: 当前候选已经存在真实生命周期包");
  const ownerFacts = confirmExactOwnerFacts(ownerFactConfirmation);
  const evidence = currentEvidence(candidate);
  const option = buildSupplierOption(candidate, evidence, ownerFacts);
  const opportunity = prepareOpportunity(candidate, option, preparedAt);
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: option.supplierSkus[0].variantKey,
    scoredAt: preparedAt
  });
  const confirmed = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: option.supplierSkus[0].supplierSkuId,
      variantKey: option.supplierSkus[0].variantKey
    },
    confirmedAt: ownerFacts.confirmedAt
  });
  let skuPackage = createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: confirmed.opportunityPackage,
    ownerSupplyConfirmation: confirmed.confirmation,
    skuPackageId: `sku-lifecycle:${candidate.id}:${option.supplierSkus[0].supplierSkuId}`,
    createdAt: preparedAt
  });
  const cost = candidate.codexReview.completeCost;
  const profitResult = runSkuProfitModel({
    opportunityPackage: confirmed.opportunityPackage,
    skuPackage,
    salesSelection: {
      salesSnapshotId: confirmed.opportunityPackage.salesSnapshots[0].snapshotId,
      currency: "RUB"
    },
    platformFeeEvidence: {
      evidenceId: `platform-fees:ozon:${candidate.targetStore}:${evidence.cStage.descriptionCategoryId}:rfbs:${evidence.cStage.commission.checkedAt}`,
      commissionRate: evidence.cStage.commission.rate,
      sourceType: evidence.cStage.commission.sourceType,
      otherCosts: {
        packagingRmb: candidate.packagingCostRmb,
        labelRmb: cost.labelRmb,
        fixedOtherRmb: 0,
        advertisingRate: cost.advertisingReserveRate,
        returnReserveRate: cost.returnOpsReserveRate,
        damageReserveRate: cost.damageLossReserveRate
      }
    },
    logisticsEvidence: {
      evidenceId: `logistics:guoo:${evidence.cStage.logistics.tariffEffectiveDate}:${evidence.cStage.logistics.billableWeightKg}kg`,
      route: evidence.cStage.logistics.route,
      amountRmb: evidence.cStage.logistics.freightRmb,
      billableWeightKg: evidence.cStage.logistics.billableWeightKg,
      effectiveDate: evidence.cStage.logistics.tariffEffectiveDate
    },
    exchangeRateEvidence: {
      evidenceId: `fx:cbr:${candidate.codexReview.exchangeRate.rateDate}:RUB-CNY`,
      rubPerCny: candidate.codexReview.exchangeRate.rubPerCny,
      sourceType: candidate.codexReview.exchangeRate.sourceType
    },
    calculatedAt: preparedAt
  });
  skuPackage = profitResult.skuPackage;
  const c1Inputs = createC1ProductPlan({
    opportunityPackage: confirmed.opportunityPackage,
    skuPackage,
    platformSchemaEvidence: schemaEvidence(candidate, evidence, ownerFacts),
    createdAt: preparedAt
  });
  const c1Facts = verifyC1ProductFacts({ skuPackage: c1Inputs.skuPackage, verifiedAt: preparedAt });
  const seoInputs = buildSeoEvidence(candidate, c1Facts.c1ProductPlan, preparedAt, ownerFacts);
  const c1Seo = createC1SeoDraft({ skuPackage: c1Facts.skuPackage, ...seoInputs, createdAt: preparedAt });
  const collectedAssets = nonEmptyString(candidate.imageUrl) ? [{
    assetId: `collected:ozon:${candidate.id}:main`,
    mediaType: "image",
    assetRef: candidate.imageUrl,
    sourcePlatform: "ozon",
    sourceEvidenceRef: `sales-snapshot:${c1Facts.c1ProductPlan.inputRefs.salesSnapshotId}#imageUrl`
  }] : [];
  const c2 = createC2AssetLifecycle({ skuPackage: c1Seo.skuPackage, collectedAssets, createdAt: preparedAt });
  assertValidLifecyclePackage(c2.skuPackage);
  return Object.freeze({
    preparationVersion: REAL_C1_PREPARATION_VERSION,
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: candidate.dataRevision,
    preparedAt,
    ownerFactConfirmation: ownerFacts,
    opportunityPackage: confirmed.opportunityPackage,
    supplierRecommendation: recommendation,
    ownerSupplyConfirmation: confirmed.confirmation,
    skuPackage: c2.skuPackage,
    status: "awaiting_final_assets",
    externalAccesses: [],
    platformWrites: 0
  });
}

/**
 * 第13C主人纠正精确SKU事实后，重建当前C1/C2读取包。
 * 历史利润版本原样保留，新利润只追加为profit-v2；不执行任何平台写入。
 */
export function reprepareRealC1AfterOwnerCorrection({ candidate, ownerFactConfirmation, preparedAt }) {
  if (!isObject(candidate?.lifecycleV11?.skuPackage)) throw new Error("REAL_C1_CORRECTION_INPUT_GAP: 缺少现有真实生命周期包");
  const previousLifecycle = structuredClone(candidate.lifecycleV11);
  const previousSkuPackage = previousLifecycle.skuPackage;
  assertValidLifecyclePackage(previousSkuPackage);
  if (previousSkuPackage.productionAuthorization !== null || previousSkuPackage.productionRecord !== null) {
    throw new Error("REAL_C1_CORRECTION_SCOPE_REJECTED: 已授权或已生产的SKU不能走C阶段事实纠正");
  }
  if (previousSkuPackage.profitModels.length !== 1 || previousSkuPackage.profitModels[0].profitModelVersion !== "profit-v1") {
    throw new Error("REAL_C1_CORRECTION_SCOPE_REJECTED: 当前只允许从单一profit-v1追加一次纠正版本");
  }

  const cleanCandidate = structuredClone(candidate);
  delete cleanCandidate.lifecycleV11;
  const rebuilt = prepareRealC1ForFinalAssets({
    candidate: cleanCandidate,
    ownerFactConfirmation,
    preparedAt
  });
  const nextLifecycle = structuredClone(rebuilt);
  let nextSkuPackage = replaceTextDeep(nextLifecycle.skuPackage, "profit-v1", "profit-v2");
  nextSkuPackage.profitModels = [
    structuredClone(previousSkuPackage.profitModels[0]),
    nextSkuPackage.profitModels[0]
  ];
  nextSkuPackage.activeProfitModelVersion = "profit-v2";

  // A阶段销售快照属于历史市场证据，纠正供应SKU时不得伪装成新采集。
  // 新生命周期内仍保留它的原始文本和来源；只通过独立差异字段说明它与精确SKU不完全同规格。
  nextSkuPackage.c1ProductPlan.marketReferenceMismatch = {
    status: "known",
    salesReferencePieceCount: 320,
    exactSupplierSkuPieceCount: ownerFactConfirmation.pieceCount,
    impact: "A阶段价格参考与当前精确供应SKU不是同件数规格；保留为有限市场参考，不冒充完全同款。",
    sourceRefs: [
      previousSkuPackage.c1ProductPlan.inputRefs.salesSnapshotId,
      `owner-confirmation:${candidate.id}:${ownerFactConfirmation.confirmedAt}`
    ]
  };
  nextSkuPackage.dataRevision = previousSkuPackage.dataRevision + 1;
  nextSkuPackage.readbackPolicy = structuredClone(previousSkuPackage.readbackPolicy);
  nextSkuPackage.readbackHistory = structuredClone(previousSkuPackage.readbackHistory);
  nextSkuPackage.audit.history = [
    ...structuredClone(previousSkuPackage.audit.history),
    {
      event: "owner_corrected_exact_sku_facts_and_appended_profit_version",
      at: preparedAt,
      previousProfitModelVersion: "profit-v1",
      activeProfitModelVersion: "profit-v2",
      previousPieceCount: previousLifecycle.ownerFactConfirmation.pieceCount,
      correctedPieceCount: ownerFactConfirmation.pieceCount,
      previousPackedWeightKg: previousSkuPackage.skuFacts.weight.value,
      correctedPackedWeightKg: nextSkuPackage.skuFacts.weight.value,
      platformWrites: 0
    }
  ];
  nextSkuPackage.audit.updatedAt = preparedAt;
  assertValidLifecyclePackage(nextSkuPackage);

  nextLifecycle.skuPackage = nextSkuPackage;
  nextLifecycle.sourceCandidateRevision = candidate.dataRevision;
  nextLifecycle.preparedAt = preparedAt;
  nextLifecycle.ownerFactConfirmation = structuredClone(ownerFactConfirmation);
  nextLifecycle.status = "awaiting_final_assets";
  nextLifecycle.externalAccesses = [];
  nextLifecycle.platformWrites = 0;
  return Object.freeze(nextLifecycle);
}

export function finalizeReal13CForOwnerCard({
  candidate,
  ownerFactConfirmation,
  packedWeightKg,
  dimensionsCm,
  finalUploadAssets,
  excludedAssets,
  preparedAt
}) {
  if (candidate?.id !== "CX-20260803-010") throw new Error("REAL_13C_SCOPE_REJECTED: 当前只允许CX-20260803-010");
  if (!Number.isFinite(packedWeightKg) || packedWeightKg <= 0) throw new Error("REAL_13C_INPUT_GAP: 实际打包重量无效");
  if (![dimensionsCm?.length, dimensionsCm?.width, dimensionsCm?.height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("REAL_13C_INPUT_GAP: 包装尺寸无效");
  }
  const corrected = structuredClone(candidate);
  corrected.productName = `机械发条DVP火车${ownerFactConfirmation.pieceCount}件3D拼图`;
  corrected.packedWeightKg = packedWeightKg;
  corrected.dimensionsCm = structuredClone(dimensionsCm);
  const existingLogistics = corrected.codexReview.cStageReview.logistics;
  const volumetricWeightKg = Number(((dimensionsCm.length * dimensionsCm.width * dimensionsCm.height) / 12000).toFixed(3));
  const billableWeightKg = Math.max(packedWeightKg, volumetricWeightKg);
  const freightRmb = Number((28.1 * billableWeightKg + 17.97).toFixed(2));
  corrected.codexReview.cStageReview.logistics = {
    ...existingLogistics,
    actualWeightKg: packedWeightKg,
    volumetricWeightKg,
    billableWeightKg,
    formula: `28.1 CNY/kg × ${billableWeightKg} kg + 17.97 CNY/parcel`,
    freightRmb,
    correctedAt: preparedAt,
    correctionSource: `owner-confirmation:${candidate.id}:${preparedAt}`
  };

  const ownerFacts = {
    ...structuredClone(ownerFactConfirmation),
    confirmedBy: "owner",
    confirmedAt: preparedAt
  };
  const rebuilt = reprepareRealC1AfterOwnerCorrection({
    candidate: corrected,
    ownerFactConfirmation: ownerFacts,
    preparedAt
  });
  const confirmedAssets = confirmFinalUploads({
    skuPackage: rebuilt.skuPackage,
    finalUploadAssets,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      approvedAssetIds: finalUploadAssets.map((asset) => asset.assetId),
      confirmationNote: "主人指定09为首图，其余由总控在不改变商品事实的前提下排序；冲突或无证据宣称素材不进入最终上传区。"
    },
    confirmedAt: preparedAt
  });
  const cardResult = createFinalProductPlanConfirmationCard({
    skuPackage: confirmedAssets.skuPackage,
    createdAt: preparedAt
  });
  const lifecycle = structuredClone(rebuilt);
  lifecycle.skuPackage = structuredClone(cardResult.skuPackage);
  lifecycle.ownerFactConfirmation = ownerFacts;
  lifecycle.status = "awaiting_owner_business_confirmation";
  lifecycle.assetReview = {
    reviewedAt: preparedAt,
    finalUploadAssetIds: finalUploadAssets.map((asset) => asset.assetId),
    excludedAssets: structuredClone(excludedAssets || []),
    platformUploads: 0
  };
  lifecycle.platformWrites = 0;
  return Object.freeze({
    lifecycle,
    logistics: corrected.codexReview.cStageReview.logistics,
    activeProfitModel: lifecycle.skuPackage.profitModels.find((model) => model.profitModelVersion === lifecycle.skuPackage.activeProfitModelVersion),
    confirmationCard: lifecycle.skuPackage.productionConfirmationCard,
    correctedProductName: corrected.productName
  });
}
/**
 * 历史火车SKU专属适配器。
 * 只保留旧数据审计和既有单元测试；服务端默认关闭对应legacy路由。
 * 新版商品必须使用 lifecycle-c-stage.mjs 的通用C1/C2流程。
 */
export const LEGACY_FIRE_TRAIN_ADAPTER = true;
