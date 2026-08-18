import { adaptLegacyCandidateToOpportunity, UNKNOWN } from "./legacy-candidate-adapter.mjs";
import { validateSalesSnapshot } from "./sales-snapshot.mjs";

export const REAL_LIFECYCLE_ENTRY_PREVIEW_VERSION = "real-lifecycle-entry-preview-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function known(value) {
  return value !== null && value !== undefined && value !== "" && value !== UNKNOWN;
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function validDimensions(value) {
  return isObject(value) && [value.length, value.width, value.height].every(positiveNumber);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function newestValidSalesSnapshot(candidate) {
  const snapshots = Array.isArray(candidate.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [];
  return snapshots
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid)
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] || null;
}

function missingItem(key, label, reason, responsible, resolutionStage = "A") {
  return { key, label, reason, responsible, resolutionStage };
}

/**
 * 只读解释旧候选能否进入新版真实生命周期。
 * 不持久化、不派发，也不把历史自由文本推断成结构化确认。
 */
export function buildRealLifecycleEntryPreview(candidate) {
  if (!isObject(candidate)) throw new TypeError("候选必须是对象");
  const before = JSON.stringify(candidate);
  if (!candidate.id || !candidate.productName || !candidate.createdAt || !candidate.updatedAt) {
    return deepFreeze({
      previewVersion: REAL_LIFECYCLE_ENTRY_PREVIEW_VERSION,
      readOnly: true,
      available: false,
      sourceCandidateId: candidate.id || null,
      reason: "候选缺少只读适配所需的身份或审计字段",
      boundaries: {
        sharedCandidateWrites: 0,
        dispatchesCreated: 0,
        externalAccesses: 0,
        platformWrites: 0,
        businessStateChanged: false,
        automationStarted: false
      }
    });
  }
  const opportunity = adaptLegacyCandidateToOpportunity(candidate);
  const supplier = opportunity.supplierOptions[0];
  const sales = newestValidSalesSnapshot(candidate);

  const salesSnapshotAvailable = Boolean(sales);
  const currentPriceAvailable = positiveNumber(sales?.currentPrice) && known(sales?.currency);
  const evidenceTraceable = known(sales?.evidenceRef) && known(sales?.productUrl) && known(sales?.collectedAt);
  const exactSupplierLinkAvailable = known(supplier?.sourceUrl);
  const exactSupplierSkuAvailable = known(supplier?.supplierSkuId) && known(supplier?.variant);
  const productPriceAvailable = positiveNumber(supplier?.productPrice);
  const domesticFreightAvailable = Number.isFinite(supplier?.domesticShipping) && supplier.domesticShipping >= 0;
  const actualPurchaseCostAvailable = positiveNumber(supplier?.actualPurchaseCost);
  const weightAvailable = positiveNumber(supplier?.packedWeightKg);
  const dimensionsAvailable = validDimensions(supplier?.dimensionsCm);
  const ownerSupplyConfirmed = known(opportunity.confirmedSupplierOptionId);

  const missing = [];
  if (!salesSnapshotAvailable) {
    missing.push(missingItem("sales_snapshot", "有效销售快照", "没有通过Schema校验的当前销售快照", "system"));
  } else {
    if (!currentPriceAvailable) missing.push(missingItem("sales_price", "当前销售价格", "销售快照没有明确当前价格和币种", "system"));
    if (!evidenceTraceable) missing.push(missingItem("sales_evidence_trace", "销售证据引用", "销售页面、采集时间或证据引用不完整", "system"));
    missing.push(missingItem("sales_comparability_review", "商品可比性审查", "尚未保存A阶段对当前销售样本与目标SKU的正式可比性结论", "system"));
    missing.push(missingItem("sales_validity_review", "快照时效审查", "项目尚未保存本快照当前是否仍有效的正式结论", "system"));
  }
  if (!exactSupplierLinkAvailable) missing.push(missingItem("supplier_link", "精确供应链接", "没有保存可追溯的采购链接", "system"));
  if (!exactSupplierSkuAvailable) missing.push(missingItem("supplier_sku", "具体供应SKU", "供应链接存在，但具体款式/SKU尚未结构化锁定", "system"));
  if (!productPriceAvailable) missing.push(missingItem("unit_product_price", "商品单价", "历史只保存采购到手总价，禁止倒推商品价格", "system"));
  if (!domesticFreightAvailable) missing.push(missingItem("unit_domestic_freight", "单件国内运费", "历史只保存采购到手总价，禁止倒推国内运费", "system"));
  if (!actualPurchaseCostAvailable) missing.push(missingItem("actual_purchase_cost", "实际采购成本", "缺少货价、国内运费及其他采购费用合计", "owner"));
  if (!weightAvailable) missing.push(missingItem("packed_weight", "实际打包重量", "缺少具体SKU实际打包重量", "owner"));
  if (!dimensionsAvailable) missing.push(missingItem("package_dimensions", "实际包装尺寸", "缺少具体SKU实际包装长宽高", "owner"));
  if (!ownerSupplyConfirmed) missing.push(missingItem("owner_supply_confirmation", "主人供应方案确认", "尚未形成主人确认的供应方案对象；后续在一张A确认卡一次完成", "owner"));

  const canEnterB = missing.length === 0;
  const hasUsableStartingEvidence = salesSnapshotAvailable && currentPriceAvailable && evidenceTraceable && exactSupplierLinkAvailable;
  const classification = canEnterB ? "A" : hasUsableStartingEvidence ? "B" : "C";
  const after = JSON.stringify(candidate);
  if (before !== after) throw new Error("只读接入预览不得修改原候选");

  return deepFreeze({
    previewVersion: REAL_LIFECYCLE_ENTRY_PREVIEW_VERSION,
    readOnly: true,
    available: true,
    sourceCandidateId: candidate.id,
    sourceDataRevision: candidate.dataRevision,
    opportunityPackage: {
      schemaVersion: opportunity.schemaVersion,
      parentOpportunityId: opportunity.parentOpportunityId,
      directionName: opportunity.directionName,
      targetPlatform: opportunity.targetPlatform,
      targetStore: opportunity.targetStore,
      adapterMode: opportunity.legacySource.adapterMode
    },
    salesEvidence: sales ? {
      snapshotId: sales.snapshotId,
      productUrl: sales.productUrl,
      currentPrice: sales.currentPrice,
      currency: sales.currency,
      sellerType: sales.sellerType,
      sellerIdentityStatus: sales.sellerIdentityEvidence.status,
      collectedAt: sales.collectedAt,
      evidenceRef: sales.evidenceRef,
      schemaValid: true,
      priceEvidenceStatus: currentPriceAvailable ? "verified" : "missing",
      evidenceTraceable,
      comparabilityStatus: "unknown",
      validityStatus: "unknown",
      businessUseStatus: "pending_a_review"
    } : {
      snapshotId: null,
      schemaValid: false,
      businessUseStatus: "data_unavailable"
    },
    supplierEvidence: {
      sourceUrl: known(supplier?.sourceUrl) ? supplier.sourceUrl : null,
      supplierSkuId: known(supplier?.supplierSkuId) ? supplier.supplierSkuId : null,
      variant: known(supplier?.variant) ? supplier.variant : null,
      unitProductPrice: productPriceAvailable ? supplier.productPrice : null,
      unitDomesticFreight: domesticFreightAvailable ? supplier.domesticShipping : null,
      actualPurchaseCost: actualPurchaseCostAvailable ? supplier.actualPurchaseCost : null,
      actualPurchaseCostCurrency: actualPurchaseCostAvailable ? supplier.actualPurchaseCostCurrency : null,
      packedWeightKg: weightAvailable ? supplier.packedWeightKg : null,
      dimensionsCm: dimensionsAvailable ? structuredClone(supplier.dimensionsCm) : null,
      historicalComponentsInferred: false,
      ownerSupplyConfirmationStatus: ownerSupplyConfirmed ? "confirmed" : "not_structured"
    },
    readiness: {
      classification,
      canCreateReadOnlyOpportunityView: true,
      canEnterB,
      canAutoEnterC1: false,
      missing,
      nextAction: canEnterB
        ? "A确认卡提交后可以进入B"
        : "先在A确认卡补齐并确认缺失资料；本预览不会启动任务"
    },
    boundaries: {
      sharedCandidateWrites: 0,
      dispatchesCreated: 0,
      externalAccesses: 0,
      platformWrites: 0,
      businessStateChanged: false,
      automationStarted: false
    }
  });
}
