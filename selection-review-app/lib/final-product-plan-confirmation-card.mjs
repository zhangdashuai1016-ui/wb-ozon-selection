import {
  assertValidLifecyclePackage,
  validateLifecycleTransition
} from "./product-lifecycle-schema.mjs";
import { assertValidC1ProductPlan } from "./c1-product-plan.mjs";
import { assertValidC2AssetLifecycle } from "./c2-asset-lifecycle.mjs";

export const FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION = "final-product-plan-confirmation-card-v1.1";

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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function sourceValue(value, sourceRefs) {
  return {
    value: structuredClone(value),
    sourceRefs: [...new Set(sourceRefs.filter(nonEmptyString))]
  };
}

function collectUnknownFacts(value, path = "", output = [], context = {}) {
  if (isObject(value) && value.verificationStatus === "unknown" && value.value === "unknown") {
    output.push({
      path,
      fieldKey: context.fieldKey || null,
      label: context.label || null,
      value: "unknown",
      reason: value.reason || "not_confirmed_in_frozen_evidence",
      sourceRefs: Array.isArray(value.sourceRefs) ? structuredClone(value.sourceRefs) : []
    });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnknownFacts(item, `${path}[${index}]`, output, context));
    return output;
  }
  if (isObject(value)) {
    const nextContext = {
      fieldKey: nonEmptyString(value.fieldKey) ? value.fieldKey : context.fieldKey,
      label: nonEmptyString(value.label) ? value.label : context.label
    };
    for (const [key, child] of Object.entries(value)) {
      collectUnknownFacts(child, path ? `${path}.${key}` : key, output, nextContext);
    }
  }
  return output;
}

function validateSourceValue(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是带来源的值");
    return;
  }
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0 || value.sourceRefs.some((ref) => !nonEmptyString(ref))) {
    push(errors, `${path}.sourceRefs`, "必须至少有一个来源");
  }
}

export function validateFinalProductPlanConfirmationCard(card) {
  const errors = [];
  if (!isObject(card)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (card.schemaVersion !== FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION) push(errors, "schemaVersion", `必须是${FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION}`);
  if (!nonEmptyString(card.cardId)) push(errors, "cardId", "必须是非空字符串");
  if (!["awaiting_owner_business_confirmation", "owner_business_approved"].includes(card.status)) {
    push(errors, "status", "必须是等待确认或主人已通过");
  }
  if (!isoDateTime(card.createdAt)) push(errors, "createdAt", "必须是有效时间");
  if (card.status === "awaiting_owner_business_confirmation" && card.ownerDecision !== null) {
    push(errors, "ownerDecision", "等待阶段不得自动替主人决定");
  }
  if (card.status === "owner_business_approved") {
    const decision = card.ownerDecision;
    if (!isObject(decision) ||
        decision.selectedOption !== "approve_for_production_authorization" ||
        decision.confirmedBy !== "owner" ||
        !isoDateTime(decision.confirmedAt)) {
      push(errors, "ownerDecision", "通过状态必须保存主人的准确决定和时间");
    }
  }
  if (!Array.isArray(card.decisionOptions) || !sameJson(card.decisionOptions, ["approve_for_production_authorization", "return_to_c_stage", "reject_product"])) {
    push(errors, "decisionOptions", "必须提供通过、退回和淘汰三个商业选项");
  }
  for (const section of ["productInformation", "profitResult", "c1Facts", "seoDraft", "c2Assets", "riskAndUnknowns", "productionBoundary"]) {
    if (!isObject(card[section])) push(errors, section, "必须是对象");
  }
  if (isObject(card.productInformation)) {
    for (const field of ["productName", "sku", "supplierOption", "targetPlatform"]) validateSourceValue(card.productInformation[field], `productInformation.${field}`, errors);
  }
  if (isObject(card.profitResult)) {
    for (const field of ["recommendedSalePrice", "unitProfitRmb", "profitMargin"]) validateSourceValue(card.profitResult[field], `profitResult.${field}`, errors);
  }
  if (isObject(card.c2Assets)) {
    if (card.c2Assets.sourceArea !== "assets.finalUploads") push(errors, "c2Assets.sourceArea", "确认卡只能读取assets.finalUploads");
    if (!Array.isArray(card.c2Assets.finalUploads) || card.c2Assets.finalUploads.length === 0) push(errors, "c2Assets.finalUploads", "必须包含主人确认的最终素材");
    if ("collected" in card.c2Assets || "aiDrafts" in card.c2Assets) push(errors, "c2Assets", "确认卡不得包含采集素材或AI草稿");
    if (card.c2Assets.finalUploads?.some((asset) => asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
      push(errors, "c2Assets.finalUploads", "最终素材必须逐项由主人确认");
    }
  }
  if (isObject(card.riskAndUnknowns) && !Array.isArray(card.riskAndUnknowns.unknownFields)) {
    push(errors, "riskAndUnknowns.unknownFields", "必须是数组");
  }
  if (isObject(card.productionBoundary)) {
    if (card.productionBoundary.productionAuthorized !== false) push(errors, "productionBoundary.productionAuthorized", "确认卡自身不得执行生产");
    if (card.productionBoundary.dStarted !== false) push(errors, "productionBoundary.dStarted", "确认卡不得进入D");
    if (card.productionBoundary.platformWrites !== 0) push(errors, "productionBoundary.platformWrites", "确认卡不得产生平台写入");
    if (card.productionBoundary.requiresSeparateExactAuthorization !== true) push(errors, "productionBoundary.requiresSeparateExactAuthorization", "D必须另行取得精确授权");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidFinalProductPlanConfirmationCard(card) {
  const result = validateFinalProductPlanConfirmationCard(card);
  if (!result.valid) throw new Error(`最终商品方案确认卡校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return card;
}

/**
 * 第11阶段只生成主人商业确认视图，不记录决定、不创建生产授权、不进入D。
 */
export function createFinalProductPlanConfirmationCard({ skuPackage, createdAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertValidC1ProductPlan(skuPackage.c1ProductPlan);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.businessPhase !== "C2" || skuPackage.c2FinalAssets.status !== "completed") {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: C2最终素材尚未由主人确认");
  }
  if (skuPackage.productionAuthorization !== null || skuPackage.productionRecord !== null) {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: 已存在生产授权或生产记录");
  }
  if (!isoDateTime(createdAt)) throw new Error("FINAL_PLAN_CARD_INPUT_GAP: 创建时间无效");
  if (skuPackage.productionConfirmationCard !== undefined && skuPackage.productionConfirmationCard !== null) {
    throw new Error("FINAL_PLAN_CARD_GATE_REJECTED: 确认卡已经存在");
  }

  const c1 = skuPackage.c1ProductPlan;
  const profit = skuPackage.profitModels.find((model) => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  if (!profit || profit.result !== "passed") throw new Error("FINAL_PLAN_CARD_INPUT_GAP: 缺少当前通过的B利润结果");
  const sales = c1.inputSnapshots.salesSnapshot;
  const supply = c1.inputSnapshots.confirmedSupplierSkuSnapshot;
  const supplyIdentity = supply.supplierOptionIdentity;
  const unknownFields = collectUnknownFacts({
    productAttributes: c1.productAttributes,
    platformCategory: c1.platformCategory,
    batteryAssessment: c1.batteryAssessment,
    categoryRestrictions: c1.categoryRestrictions,
    platformCompliance: c1.platformCompliance
  });
  const materialRisks = [
    c1.batteryAssessment?.assessment?.value === "unknown" ? "battery_status_unknown" : null,
    c1.categoryRestrictions?.restrictions?.value === "unknown" ? "category_restrictions_unknown" : null,
    c1.platformCompliance?.assessment?.value === "unknown" ? "platform_compliance_unknown" : null,
    c1.productAttributes?.requiredPlatformFields?.some((field) => field.fact?.value === "unknown") ? "required_platform_attributes_incomplete" : null,
    c1.marketReferenceMismatch?.status === "known" ? "sales_reference_spec_differs_from_exact_supplier_sku" : null
  ].filter(Boolean);

  const card = {
    schemaVersion: FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION,
    cardId: `final-plan-card:${skuPackage.skuPackageId}:${skuPackage.dataRevision}`,
    status: "awaiting_owner_business_confirmation",
    createdAt,
    ownerDecision: null,
    decisionOptions: ["approve_for_production_authorization", "return_to_c_stage", "reject_product"],
    productInformation: {
      productName: sourceValue(sales.title, [c1.inputRefs.salesSnapshotId, `${c1.inputRefs.salesSnapshotId}#/title`]),
      sku: sourceValue({
        skuPackageId: skuPackage.skuPackageId,
        supplierSkuId: skuPackage.supplierSkuId,
        variantKey: skuPackage.variantKey
      }, [c1.inputRefs.selectedSupplySnapshotId, `${c1.inputRefs.selectedSupplySnapshotId}#/supplierSku`]),
      supplierOption: sourceValue({
        supplierOptionId: skuPackage.supplierOptionId,
        sourcePlatform: supplyIdentity.sourcePlatform,
        offerId: supplyIdentity.offerId,
        productUrl: supplyIdentity.productUrl,
        ownerConfirmedAt: supply.ownerSupplyConfirmation.confirmedAt
      }, [c1.inputRefs.selectedSupplySnapshotId, `${c1.inputRefs.selectedSupplySnapshotId}#/ownerSupplyConfirmation`]),
      targetPlatform: sourceValue({ platform: skuPackage.targetPlatform, store: skuPackage.targetStore }, [c1.inputRefs.platformSchemaEvidenceId])
    },
    profitResult: {
      profitModelVersion: profit.profitModelVersion,
      recommendedSalePrice: sourceValue({ rub: profit.recommendedSalePriceRub, cny: profit.recommendedSalePriceCny }, [profit.profitModelVersion]),
      unitProfitRmb: sourceValue(profit.unitProfitRmb, [profit.profitModelVersion]),
      profitMargin: sourceValue(profit.profitMargin, [profit.profitModelVersion]),
      result: sourceValue(profit.result, [profit.profitModelVersion])
    },
    c1Facts: {
      exactSku: structuredClone(c1.exactSkuVerification),
      platformCategory: structuredClone(c1.platformCategory),
      productAttributes: structuredClone(c1.productAttributes),
      batteryStatus: structuredClone(c1.batteryAssessment),
      categoryRestrictions: structuredClone(c1.categoryRestrictions),
      platformCompliance: structuredClone(c1.platformCompliance)
    },
    seoDraft: {
      status: "draft_only",
      title: structuredClone(c1.seoTitleDraft),
      description: structuredClone(c1.descriptionDraft),
      bulletPoints: structuredClone(c1.bulletPointsDraft),
      searchKeywords: structuredClone(c1.searchKeywordsDraft),
      finalSeoConfirmed: false
    },
    c2Assets: {
      sourceArea: "assets.finalUploads",
      finalUploads: structuredClone(skuPackage.c2FinalAssets.assets.finalUploads),
      ownerFinalUploadConfirmation: structuredClone(skuPackage.c2FinalAssets.ownerFinalUploadConfirmation)
    },
    riskAndUnknowns: {
      status: materialRisks.length === 0 && unknownFields.length === 0 ? "no_recorded_gaps" : "owner_review_required",
      materialRisks,
      unknownFields,
      unknownCount: unknownFields.length,
      marketReferenceMismatch: structuredClone(c1.marketReferenceMismatch || null)
    },
    productionBoundary: {
      productionAuthorized: false,
      dStarted: false,
      platformWrites: 0,
      requiresSeparateExactAuthorization: true,
      authorizationScopeRequired: ["platform", "store", "product", "sku", "price", "stock", "finalUploads", "publishScope", "exclusions"]
    }
  };
  assertValidFinalProductPlanConfirmationCard(card);

  const protectedC1 = structuredClone(skuPackage.c1ProductPlan);
  const protectedC2 = structuredClone(skuPackage.c2FinalAssets);
  const protectedProfit = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.productionConfirmationCard = card;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "confirm_c1_plan";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "final_product_plan_confirmation_card_created",
    at: createdAt,
    cardId: card.cardId,
    ownerDecision: null,
    productionAuthorized: false,
    dStarted: false,
    platformWrites: 0
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`最终商品方案确认卡生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(protectedC1, next.c1ProductPlan) || !sameJson(protectedC2, next.c2FinalAssets) || !sameJson(protectedProfit, next.profitModels)) {
    throw new Error("FINAL_PLAN_CARD_PROTECTED_DATA_CHANGED: B、C1或C2数据被改写");
  }
  if (next.productionAuthorization !== null || next.productionRecord !== null || next.businessPhase !== "C2") {
    throw new Error("FINAL_PLAN_CARD_BOUNDARY_VIOLATION: 确认卡不得自动授权或进入D");
  }
  return deepFreeze({
    flowVersion: "final-product-plan-confirmation-card-flow-v1.1",
    skuPackage: next,
    confirmationCard: next.productionConfirmationCard
  });
}
