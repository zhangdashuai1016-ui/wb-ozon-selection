import { adaptLegacyCandidateToOpportunity } from "./legacy-candidate-adapter.mjs";
import { UNKNOWN, assertValidSupplierOption } from "./supplier-option.mjs";
import { assessAStageMarket } from "./market-sample-policy.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
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

// Historical inputs remain inspectable; they are not a formal C1/provider receipt.
export function readLegacyC1PreparationInputs({ candidate, ownerFactConfirmation, preparedAt }) {
  if (!isObject(candidate) || !isoDateTime(preparedAt)) throw new Error("REAL_C1_INPUT_GAP: 输入无效");
  const evidence = currentEvidence(candidate);
  const ownerFacts = confirmExactOwnerFacts(ownerFactConfirmation);
  const supplierOption = buildSupplierOption(candidate, evidence, ownerFacts);
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
  return {
    status: "read_only_legacy_input",
    sourceCandidateRevision: candidate.dataRevision,
    supplierOption,
    ownerFacts,
    marketAssessment: opportunity.marketAssessment,
    formalC1Ready: false,
    gaps: ["exact_unit_product_price_missing", "exact_domestic_freight_missing", "persisted_c1_provider_receipt_required"],
    externalAccesses: [],
    platformWrites: 0
  };
}
