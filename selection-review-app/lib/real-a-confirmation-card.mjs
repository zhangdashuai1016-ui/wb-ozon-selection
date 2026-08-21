import { validateSalesSnapshot } from "./sales-snapshot.mjs";
import { sourceCaptureFailureDestinationLabel } from "./source-capture.mjs";

export const REAL_A_CONFIRMATION_CARD_VERSION = "real-a-confirmation-card-v1.1";

const UNKNOWN = "unknown";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function known(value) {
  return value !== null && value !== undefined && value !== "" && value !== UNKNOWN;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined || value === UNKNOWN) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed > 0;
}

function nonNegative(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0;
}

function newestValidSalesSnapshot(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid)
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] || null;
}

function selectedCaptureSku(candidate) {
  const capture = candidate?.sourceCapture;
  if (!isObject(capture) || capture.status !== "verified") return null;
  const selectedIds = Array.isArray(capture.selectedSkuIds) ? capture.selectedSkuIds : [];
  const choices = Array.isArray(capture.skuChoices) ? capture.skuChoices : [];
  if (selectedIds.length !== 1) return null;
  return choices.find((choice) => String(choice.sourceSkuId) === String(selectedIds[0])) || null;
}

function exact1688Url(value) {
  return /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#].*)?$/i.test(String(value || "").trim());
}

function aSupplierInputUrl(value) {
  const input = String(value || "").trim();
  return exact1688Url(input) || /^https:\/\/qr\.1688\.com\/s\/[A-Za-z0-9_-]{1,160}\/?$/i.test(input);
}

function field(value, source, status = known(value) ? "available" : "missing") {
  return { value: known(value) ? value : null, source, status };
}

function unavailableSystemEvidence() {
  return {
    ready: false,
    contextReady: false,
    fields: [],
    missing: ["服务端尚未匹配到当前商品的B系统证据包"],
    ownerMustProvide: false
  };
}

/**
 * 只为真实候选生成一张A阶段确认卡的数据契约。
 * 不修改候选、不创建生命周期、不启动B、不派发任务。
 */
export function buildRealAConfirmationCard(candidate, options = {}) {
  if (!isObject(candidate) || !candidate.id || !Number.isInteger(candidate.dataRevision)) {
    throw new TypeError("REAL_A_CARD_INPUT_GAP: 候选身份或修订号无效");
  }
  const before = JSON.stringify(candidate);
  const sales = newestValidSalesSnapshot(candidate);
  const capturedSku = selectedCaptureSku(candidate);
  const supplierCapture = isObject(candidate.sourceCapture) && candidate.sourceCapture.mode === "a_supplier_capture"
    ? candidate.sourceCapture
    : null;
  const legacySupply = candidate.lifecycleV11?.opportunityPackage?.supplierOptions?.[0] || null;
  const capturedUrl = candidate.sourceCapture?.sourceUrl;
  const sourceUrl = aSupplierInputUrl(capturedUrl)
    ? capturedUrl
    : aSupplierInputUrl(candidate.sourceUrl)
      ? candidate.sourceUrl
      : null;
  const dimensions = isObject(candidate.dimensionsCm) ? candidate.dimensionsCm : {};

  const card = {
    cardVersion: REAL_A_CONFIRMATION_CARD_VERSION,
    readOnlyPreparation: true,
    sourceCandidateId: candidate.id,
    sourceDataRevision: candidate.dataRevision,
    productName: candidate.productName,
    targetPlatform: candidate.targetStore === "wb" ? "wb" : "ozon",
    targetStore: candidate.targetStore,
    decisions: ["confirm", "reject"],
    salesReview: sales ? {
      snapshotId: sales.snapshotId,
      sourceDataRevision: sales.sourceDataRevision,
      productUrl: sales.productUrl,
      title: sales.title,
      currentPrice: sales.currentPrice,
      currency: sales.currency,
      sellerType: sales.sellerType,
      sellerIdentityStatus: sales.sellerIdentityEvidence.status,
      collectedAt: sales.collectedAt,
      evidenceRef: sales.evidenceRef,
      comparability: "unknown",
      validityStatus: "unknown",
      confidence: "unknown"
    } : null,
    supplierConfirmation: {
      productUrl: field(sourceUrl, sourceUrl ? "exact_1688_url" : "missing_exact_1688_url"),
      supplierSkuId: field(capturedSku?.sourceSkuId, capturedSku ? "verified_source_capture" : "missing_verified_sku"),
      variantKey: field(capturedSku?.variantKey || capturedSku?.variantName, capturedSku ? "verified_source_capture" : "missing_verified_sku"),
      unitProductPrice: field(capturedSku?.unitProductPrice, capturedSku ? "verified_source_capture" : "unknown_not_inferred"),
      unitDomesticFreight: field(null, "unknown_not_inferred"),
      otherPurchaseCosts: field(null, "unknown_requires_explicit_confirmation"),
      actualPurchaseCost: field(candidate.purchasePriceRmb ?? legacySupply?.actualPurchaseCost, "candidate_confirmed_all_in_cost"),
      weightKg: field(candidate.packedWeightKg ?? legacySupply?.packedWeightKg, "candidate_confirmed_packaging"),
      dimensionsCm: {
        length: field(dimensions.length ?? legacySupply?.dimensionsCm?.length, "candidate_confirmed_packaging"),
        width: field(dimensions.width ?? legacySupply?.dimensionsCm?.width, "candidate_confirmed_packaging"),
        height: field(dimensions.height ?? legacySupply?.dimensionsCm?.height, "candidate_confirmed_packaging")
      }
    },
    supplierCapture: supplierCapture ? {
      status: supplierCapture.status,
      captureId: supplierCapture.captureId,
      jobId: supplierCapture.jobId || null,
      jobStatus: supplierCapture.jobStatus || null,
      attempt: Number(supplierCapture.attempt || 0),
      requiredExtensionVersion: supplierCapture.requiredExtensionVersion || null,
      claimedExtensionVersion: supplierCapture.claimedExtensionVersion || null,
      originalSourceUrl: supplierCapture.originalSourceUrl || null,
      sourceUrl: supplierCapture.sourceUrl || null,
      offerId: supplierCapture.offerId || null,
      observedAt: supplierCapture.observedAt || null,
      pageFields: structuredClone(supplierCapture.pageFields || {
        unitProductPriceCny: null,
        unitProductPriceSource: null,
        unitDomesticFreightCny: null,
        unitDomesticFreightSource: null
      }),
      skuChoices: structuredClone(Array.isArray(supplierCapture.skuChoices) ? supplierCapture.skuChoices : []),
      selectedSkuIds: [],
      ownerSupplyConfirmed: false,
      failureCode: supplierCapture.failureCode || null,
      failureDiagnostics: isObject(supplierCapture.failureDiagnostics)
        ? structuredClone(supplierCapture.failureDiagnostics)
        : null,
      failureDestinationLabel: supplierCapture.failureDestinationLabel ||
        sourceCaptureFailureDestinationLabel(supplierCapture.failureDiagnostics, supplierCapture.failureCode) || null,
      reason: supplierCapture.reason || null
    } : null,
    confirmation: {
      ownerSupplyConfirmed: false,
      oneCardSubmission: true,
      startsB: true,
      createsDispatch: false,
      businessStateChanged: false
    },
    systemEvidenceReadiness: isObject(options.systemEvidenceReadiness)
      ? structuredClone(options.systemEvidenceReadiness)
      : unavailableSystemEvidence(),
    systemEvidencePreparationPlan: isObject(options.systemEvidencePreparationPlan)
      ? structuredClone(options.systemEvidencePreparationPlan)
      : null,
    boundaries: {
      candidateWrites: 0,
      platformAccesses: 0,
      platformWrites: 0,
      taskDispatches: 0,
      automationStarted: false
    }
  };
  if (JSON.stringify(candidate) !== before) throw new Error("REAL_A_CARD_READ_ONLY_VIOLATION");
  return Object.freeze(card);
}

export function validateRealAConfirmationSubmission(card, input) {
  if (!isObject(card) || card.cardVersion !== REAL_A_CONFIRMATION_CARD_VERSION) {
    throw new TypeError("REAL_A_CARD_INVALID: 确认卡版本无效");
  }
  const decision = input?.decision;
  if (decision === "reject") {
    return Object.freeze({
      valid: true,
      decision,
      sourceCandidateId: card.sourceCandidateId,
      sourceDataRevision: card.sourceDataRevision,
      normalized: null,
      errors: []
    });
  }
  const supplier = isObject(input?.supplierConfirmation) ? input.supplierConfirmation : {};
  const sales = isObject(input?.salesReview) ? input.salesReview : {};
  const errors = [];
  const push = (fieldName, label, reason) => errors.push({ field: fieldName, label, reason });

  if (decision !== "confirm") push("decision", "方向决定", "请选择确认或淘汰");
  if (!card.salesReview || sales.snapshotId !== card.salesReview.snapshotId) {
    push("salesReview.snapshotId", "销售快照", "必须确认当前卡片展示的销售快照");
  }
  if (sales.comparability !== "comparable") {
    push("salesReview.comparability", "商品可比性", "只有确认商品合理可比才能进入B");
  }
  if (sales.validityStatus !== "current") {
    push("salesReview.validityStatus", "销售快照时效", "当前快照必须经系统确认仍然有效");
  }
  if (!exact1688Url(supplier.productUrl)) push("productUrl", "精确1688供应链接", "必须是detail.1688.com的准确商品链接");
  if (!String(supplier.supplierSkuId || "").trim()) push("supplierSkuId", "具体供应SKU", "必须锁定具体供应SKU");
  if (!String(supplier.variantKey || "").trim()) push("variantKey", "规格/变体", "必须明确具体规格或变体");
  if (!positive(supplier.unitProductPrice)) push("unitProductPrice", "商品价", "必须填写大于0的单件商品价");
  if (!nonNegative(supplier.unitDomesticFreight)) push("unitDomesticFreight", "国内运费", "必须明确填写，免运费时填0");
  if (!nonNegative(supplier.otherPurchaseCosts)) push("otherPurchaseCosts", "其他采购费用", "必须明确填写，没有时填0");
  if (!positive(supplier.actualPurchaseCost)) push("actualPurchaseCost", "实际采购成本", "必须填写实际采购到手总成本");
  if (!positive(supplier.weightKg)) push("weightKg", "实际打包重量", "必须填写大于0的打包重量");
  const dimensions = isObject(supplier.dimensionsCm) ? supplier.dimensionsCm : {};
  for (const [key, label] of [["length", "长度"], ["width", "宽度"], ["height", "高度"]]) {
    if (!positive(dimensions[key])) push(`dimensionsCm.${key}`, label, `必须填写大于0的包装${label}`);
  }
  if (supplier.ownerSupplyConfirmed !== true) {
    push("ownerSupplyConfirmed", "主人供应方案确认", "主人必须明确确认当前链接、SKU和成本包装属于同一采购方案");
  }

  const goods = numberOrNull(supplier.unitProductPrice);
  const freight = numberOrNull(supplier.unitDomesticFreight);
  const other = numberOrNull(supplier.otherPurchaseCosts);
  const total = numberOrNull(supplier.actualPurchaseCost);
  if ([goods, freight, other, total].every((value) => value !== null) && Math.abs(goods + freight + other - total) > 0.01) {
    push("actualPurchaseCost", "实际采购成本", "必须等于商品价＋国内运费＋其他采购费用");
  }

  const valid = errors.length === 0;
  return Object.freeze({
    valid,
    decision,
    sourceCandidateId: card.sourceCandidateId,
    sourceDataRevision: card.sourceDataRevision,
    normalized: valid ? {
      salesReview: {
        snapshotId: sales.snapshotId,
        comparability: sales.comparability,
        validityStatus: sales.validityStatus,
        confidence: String(sales.confidence || "limited")
      },
      supplierConfirmation: {
        productUrl: supplier.productUrl.trim(),
        supplierSkuId: String(supplier.supplierSkuId).trim(),
        variantKey: String(supplier.variantKey).trim(),
        unitProductPrice: goods,
        unitDomesticFreight: freight,
        otherPurchaseCosts: other,
        actualPurchaseCost: total,
        weightKg: numberOrNull(supplier.weightKg),
        dimensionsCm: {
          length: numberOrNull(dimensions.length),
          width: numberOrNull(dimensions.width),
          height: numberOrNull(dimensions.height)
        },
        ownerSupplyConfirmed: true
      }
    } : null,
    errors
  });
}
