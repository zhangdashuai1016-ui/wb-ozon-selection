import {
  assertValidLifecyclePackage,
  validateLifecycleTransition
} from "./product-lifecycle-schema.mjs";
import {
  assertValidFinalProductPlanConfirmationCard
} from "./final-product-plan-confirmation-card.mjs";
import { assertValidC2AssetLifecycle } from "./c2-asset-lifecycle.mjs";

export const PRODUCTION_AUTHORIZATION_VERSION = "production-authorization-v1.1";
export const DEFAULT_NEW_PRODUCT_STOCK = 100;
export const DRAFT_ONLY_PUBLISH_SCOPE = "create_draft_only";
export const VALIDATION_MODERATION_PUBLISH_SCOPE = "create_and_allow_validation_moderation";
export const PRODUCTION_PUBLISH_SCOPES = Object.freeze([
  DRAFT_ONLY_PUBLISH_SCOPE,
  VALIDATION_MODERATION_PUBLISH_SCOPE
]);
export const PRODUCTION_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "stock",
  "assets.finalUploads",
  "publish_scope"
]);

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

function uniqueNonEmptyStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(nonEmptyString))];
}

function validMoney(value) {
  return isObject(value) && Number.isFinite(value.amount) && value.amount > 0 && nonEmptyString(value.currency);
}

function validPriceConversion(value) {
  return isObject(value) && Number.isFinite(value.rubPerCny) && value.rubPerCny > 0 &&
    nonEmptyString(value.evidenceRef) && nonEmptyString(value.checkedAt);
}

function validateOzonChinaPriceSemantics(scope, errors) {
  if (String(scope.platform).toLowerCase() !== "ozon") return;
  if (scope.buyerTargetPrice?.currency !== "RUB") {
    push(errors, "lockedScope.buyerTargetPrice.currency", "Ozon俄罗斯买家目标价必须以RUB保存");
  }
  if (scope.platformWritePrice?.currency !== "CNY") {
    push(errors, "lockedScope.platformWritePrice.currency", "中国卖家Ozon后台写入价必须以CNY保存");
  }
  if (validMoney(scope.buyerTargetPrice) && validMoney(scope.platformWritePrice) && validPriceConversion(scope.priceConversion)) {
    const converted = scope.buyerTargetPrice.amount / scope.priceConversion.rubPerCny;
    if (Math.abs(converted - scope.platformWritePrice.amount) > 0.02) {
      push(errors, "lockedScope.platformWritePrice", "平台写入价与锁定汇率换算结果不一致");
    }
  }
}

export function validateProductionAuthorization(authorization) {
  const errors = [];
  if (!isObject(authorization)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (authorization.schemaVersion !== PRODUCTION_AUTHORIZATION_VERSION) push(errors, "schemaVersion", `必须是${PRODUCTION_AUTHORIZATION_VERSION}`);
  if (!nonEmptyString(authorization.authorizationId)) push(errors, "authorizationId", "必须是非空字符串");
  if (authorization.status !== "confirmed") push(errors, "status", "必须是confirmed");
  if (authorization.confirmedBy !== "owner") push(errors, "confirmedBy", "只能由主人确认");
  if (!isoDateTime(authorization.confirmedAt)) push(errors, "confirmedAt", "必须是有效时间");
  if (!nonEmptyString(authorization.sourceConfirmationCardId)) push(errors, "sourceConfirmationCardId", "必须关联确认卡");
  if (!Number.isInteger(authorization.authorizedDataRevision) || authorization.authorizedDataRevision < 0) push(errors, "authorizedDataRevision", "必须锁定非负修订号");
  if (!isObject(authorization.lockedScope)) {
    push(errors, "lockedScope", "必须是对象");
  } else {
    const scope = authorization.lockedScope;
    for (const field of ["platform", "store", "skuPackageId", "supplierSkuId", "titleVersion", "attributeVersion", "assetsFinalUploadsVersion", "publishScope"]) {
      if (!nonEmptyString(scope[field])) push(errors, `lockedScope.${field}`, "必须是非空字符串");
    }
    if (!PRODUCTION_PUBLISH_SCOPES.includes(scope.publishScope)) push(errors, "lockedScope.publishScope", "生产授权范围无效");
    if (!nonEmptyString(scope.title)) push(errors, "lockedScope.title", "必须锁定标题正文");
    if (!isObject(scope.attributes)) push(errors, "lockedScope.attributes", "必须锁定属性值");
    if (!isObject(scope.platformCategory)) push(errors, "lockedScope.platformCategory", "必须锁定平台类目");
    if (!isObject(scope.recommendedPrice) || !Number.isFinite(scope.recommendedPrice.rub) || !Number.isFinite(scope.recommendedPrice.cny)) {
      push(errors, "lockedScope.recommendedPrice", "必须锁定建议售价");
    }
    if (!validMoney(scope.buyerTargetPrice)) push(errors, "lockedScope.buyerTargetPrice", "必须锁定买家目标成交价和币种");
    if (!validMoney(scope.platformWritePrice)) push(errors, "lockedScope.platformWritePrice", "必须锁定店铺后台实际写入价和币种");
    if (!validPriceConversion(scope.priceConversion)) push(errors, "lockedScope.priceConversion", "必须锁定价格换算证据");
    validateOzonChinaPriceSemantics(scope, errors);
    if (scope.stock !== DEFAULT_NEW_PRODUCT_STOCK) push(errors, "lockedScope.stock", "新品库存必须锁定为100");
    if (!Array.isArray(scope.finalUploads) || scope.finalUploads.length === 0) push(errors, "lockedScope.finalUploads", "必须锁定最终素材");
    if (scope.finalUploads?.some((asset) => asset.ownerConfirmed !== true || asset.productionEligible !== true)) push(errors, "lockedScope.finalUploads", "每份素材必须已由主人确认");
    if (!Array.isArray(scope.exclusions)) push(errors, "lockedScope.exclusions", "必须明确排除项数组");
    if (!Array.isArray(scope.allowedWriteFields) || scope.allowedWriteFields.length === 0) push(errors, "lockedScope.allowedWriteFields", "必须明确允许写入字段");
    if (scope.allowedWriteFields?.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field))) push(errors, "lockedScope.allowedWriteFields", "不得扩大授权写入范围");
  }
  if (authorization.scopeExpansionAllowed !== false) push(errors, "scopeExpansionAllowed", "禁止自动扩大范围");
  if (authorization.fieldMutationAllowed !== false) push(errors, "fieldMutationAllowed", "禁止自动修改字段");
  if (authorization.skuReplacementAllowed !== false) push(errors, "skuReplacementAllowed", "禁止替换SKU");
  if (authorization.assetReplacementAllowed !== false) push(errors, "assetReplacementAllowed", "禁止替换素材");
  if (authorization.productionExecuted !== false) push(errors, "productionExecuted", "第12阶段不得执行D");
  if (authorization.platformWrites !== 0) push(errors, "platformWrites", "第12阶段不得平台写入");
  if (authorization.readPolicy !== "authorization_snapshot_only") push(errors, "readPolicy", "未来D只能读取授权快照");
  return { valid: errors.length === 0, errors };
}

export function assertValidProductionAuthorization(authorization) {
  const result = validateProductionAuthorization(authorization);
  if (!result.valid) throw new Error(`ProductionAuthorization校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return authorization;
}

function validateOwnerApproval(ownerDecision, card) {
  if (!isObject(ownerDecision) ||
      ownerDecision.selectedOption !== "approve_for_production_authorization" ||
      ownerDecision.confirmedBy !== "owner" ||
      ownerDecision.cardId !== card.cardId) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED: 必须由主人对准确确认卡选择通过");
  }
}

/**
 * 第12阶段只固化授权对象。授权保留在C2，不启动D，也不进行任何平台操作。
 */
export function createProductionAuthorization({
  skuPackage,
  ownerDecision,
  buyerTargetPrice,
  platformWritePrice,
  priceConversion,
  publishScope,
  exclusions,
  allowedWriteFields = PRODUCTION_WRITE_FIELDS,
  confirmedAt
}) {
  assertValidLifecyclePackage(skuPackage);
  const sourceCard = skuPackage.productionConfirmationCard;
  assertValidFinalProductPlanConfirmationCard(sourceCard);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.businessPhase !== "C2" || sourceCard.status !== "awaiting_owner_business_confirmation") {
    throw new Error("PRODUCTION_AUTHORIZATION_GATE_REJECTED: 商品方案不在等待主人确认状态");
  }
  if (skuPackage.productionAuthorization !== null || skuPackage.productionRecord !== null) {
    throw new Error("PRODUCTION_AUTHORIZATION_GATE_REJECTED: 已存在授权或生产记录");
  }
  validateOwnerApproval(ownerDecision, sourceCard);
  if (sourceCard.riskAndUnknowns?.materialRisks?.includes("exact_commission_required_before_production")) {
    throw new Error("PRODUCTION_AUTHORIZATION_GATE_REJECTED: B阶段使用估算佣金，C阶段尚未补取当前精确佣金");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 确认时间无效");
  if (!validMoney(buyerTargetPrice)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 必须确认买家目标成交价和币种");
  if (!validMoney(platformWritePrice)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 必须确认店铺后台实际写入价和币种");
  if (!validPriceConversion(priceConversion)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 必须确认价格换算证据");
  if (!PRODUCTION_PUBLISH_SCOPES.includes(publishScope)) throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED: 发布范围无效");
  if (!Array.isArray(exclusions)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 必须提供排除项数组，可为空数组");
  const safeAllowedFields = uniqueNonEmptyStrings(allowedWriteFields);
  if (safeAllowedFields.length === 0 || safeAllowedFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field))) {
    throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED: 写入字段超出固定授权面");
  }

  const card = structuredClone(sourceCard);
  card.status = "owner_business_approved";
  card.ownerDecision = {
    selectedOption: "approve_for_production_authorization",
    confirmedBy: "owner",
    confirmedAt,
    note: ownerDecision.note || null
  };
  assertValidFinalProductPlanConfirmationCard(card);

  const c1 = skuPackage.c1ProductPlan;
  const c2 = skuPackage.c2FinalAssets;
  const authorization = {
    schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
    authorizationId: `production-auth:${skuPackage.skuPackageId}:${skuPackage.dataRevision}`,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt,
    sourceConfirmationCardId: card.cardId,
    authorizedDataRevision: skuPackage.dataRevision,
    lockedScope: {
      platform: skuPackage.targetPlatform,
      store: skuPackage.targetStore,
      skuPackageId: skuPackage.skuPackageId,
      supplierSkuId: skuPackage.supplierSkuId,
      variantKey: skuPackage.variantKey,
      titleVersion: `${c1.seoEvidenceLayer.draftVersion}:${c1.seoEvidenceLayer.createdAt}`,
      title: c1.seoTitleDraft.text,
      attributeVersion: `${c1.factVerificationVersion}:${c1.factsVerifiedAt}`,
      attributes: structuredClone(c1.productAttributes),
      platformCategory: structuredClone(c1.platformCategory),
      recommendedPrice: structuredClone(sourceCard.profitResult.recommendedSalePrice.value),
      buyerTargetPrice: structuredClone(buyerTargetPrice),
      platformWritePrice: structuredClone(platformWritePrice),
      priceConversion: structuredClone(priceConversion),
      stock: DEFAULT_NEW_PRODUCT_STOCK,
      assetsFinalUploadsVersion: `${c2.assetPackageId}:${c2.ownerFinalUploadConfirmation.confirmedAt}`,
      finalUploads: structuredClone(c2.assets.finalUploads),
      publishScope,
      exclusions: structuredClone(exclusions),
      allowedWriteFields: safeAllowedFields
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
  assertValidProductionAuthorization(authorization);

  const protectedC1 = structuredClone(skuPackage.c1ProductPlan);
  const protectedC2 = structuredClone(skuPackage.c2FinalAssets);
  const protectedProfit = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.productionConfirmationCard = card;
  next.productionAuthorization = authorization;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "passed";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = confirmedAt;
  next.audit.history.push({
    event: "production_authorization_created_without_execution",
    at: confirmedAt,
    authorizationId: authorization.authorizationId,
    sourceConfirmationCardId: card.cardId,
    authorizedDataRevision: authorization.authorizedDataRevision,
    scopeExpansionAllowed: false,
    productionExecuted: false,
    platformWrites: 0
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`生产授权生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(protectedC1, next.c1ProductPlan) || !sameJson(protectedC2, next.c2FinalAssets) || !sameJson(protectedProfit, next.profitModels)) {
    throw new Error("PRODUCTION_AUTHORIZATION_PROTECTED_DATA_CHANGED: B、C1或C2数据被改写");
  }
  if (next.businessPhase !== "C2" || next.productionRecord !== null || next.productionAuthorization.productionExecuted !== false) {
    throw new Error("PRODUCTION_AUTHORIZATION_BOUNDARY_VIOLATION: 第12阶段不得进入D");
  }
  return deepFreeze({
    flowVersion: "production-authorization-flow-v1.1",
    skuPackage: next,
    productionAuthorization: next.productionAuthorization
  });
}

/**
 * 主人改变生产范围后生成新的版本化授权。旧授权不覆盖执行，也不复用其指纹。
 */
export function reviseProductionAuthorization({
  skuPackage,
  ownerDecision,
  publishScope,
  exclusions,
  allowedWriteFields,
  confirmedAt
}) {
  assertValidLifecyclePackage(skuPackage);
  const previous = skuPackage.productionAuthorization;
  assertValidProductionAuthorization(previous);
  if (skuPackage.productionRecord !== null) throw new Error("PRODUCTION_AUTHORIZATION_REVISION_REJECTED: 已存在生产记录");
  if (!isObject(ownerDecision) || ownerDecision.confirmedBy !== "owner" || ownerDecision.confirmed !== true) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED: 必须由主人确认新的生产范围");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 确认时间无效");
  if (!PRODUCTION_PUBLISH_SCOPES.includes(publishScope)) throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED: 发布范围无效");
  if (!Array.isArray(exclusions)) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP: 必须提供排除项数组");
  const safeAllowedFields = uniqueNonEmptyStrings(allowedWriteFields);
  if (safeAllowedFields.length === 0 || safeAllowedFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field))) {
    throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED: 写入字段超出固定授权面");
  }
  if (publishScope === VALIDATION_MODERATION_PUBLISH_SCOPE) {
    if (exclusions.includes("no_moderation_submission")) throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_CONFLICT: 已允许校验/审核，不能继续排除送审");
    if (safeAllowedFields.includes("stock")) throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_CONFLICT: 本轮明确禁止库存写入");
    for (const required of ["no_publish_or_activation", "no_inventory_write", "no_warehouse_or_logistics_change", "no_promotion_change", "no_advertising_change", "no_other_sku_write"]) {
      if (!exclusions.includes(required)) throw new Error(`PRODUCTION_AUTHORIZATION_SCOPE_GAP: 缺少排除项 ${required}`);
    }
  }

  const authorization = structuredClone(previous);
  authorization.authorizationId = `production-auth:${skuPackage.skuPackageId}:${skuPackage.dataRevision}:${publishScope}`;
  authorization.confirmedAt = confirmedAt;
  authorization.authorizedDataRevision = skuPackage.dataRevision;
  authorization.lockedScope.publishScope = publishScope;
  authorization.lockedScope.exclusions = structuredClone(exclusions);
  authorization.lockedScope.allowedWriteFields = safeAllowedFields;
  assertValidProductionAuthorization(authorization);

  const next = structuredClone(skuPackage);
  next.productionAuthorization = authorization;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "passed";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = confirmedAt;
  next.audit.history.push({
    event: "production_authorization_scope_revised_without_execution",
    at: confirmedAt,
    previousAuthorizationId: previous.authorizationId,
    authorizationId: authorization.authorizationId,
    publishScope,
    inventoryWriteAuthorized: safeAllowedFields.includes("stock"),
    productionExecuted: false,
    platformWrites: 0
  });
  assertValidLifecyclePackage(next);
  return deepFreeze({
    flowVersion: "production-authorization-revision-flow-v1.1",
    skuPackage: next,
    productionAuthorization: next.productionAuthorization
  });
}

/**
 * 修复旧授权中把RUB买家价误当成中国卖家后台写入价的语义缺陷。
 * 只允许从既有推荐价和同一ProfitModel汇率证据生成新版本，不改变主人确认的商业价格。
 */
export function reviseProductionAuthorizationPriceSemantics({
  skuPackage,
  buyerTargetPrice,
  platformWritePrice,
  priceConversion,
  repairedAt
}) {
  if (!isObject(skuPackage) || !nonEmptyString(skuPackage.skuPackageId)) {
    throw new Error("PRODUCTION_PRICE_REPAIR_REJECTED: SKU生命周期数据无效");
  }
  const previous = skuPackage.productionAuthorization;
  if (!isObject(previous) || previous.status !== "confirmed") throw new Error("PRODUCTION_PRICE_REPAIR_REJECTED: 当前没有可修复授权");
  if (skuPackage.productionRecord !== null) throw new Error("PRODUCTION_PRICE_REPAIR_REJECTED: 已存在生产记录");
  if (!isoDateTime(repairedAt)) throw new Error("PRODUCTION_PRICE_REPAIR_INPUT_GAP: 修复时间无效");
  if (!validMoney(buyerTargetPrice) || !validMoney(platformWritePrice) || !validPriceConversion(priceConversion)) {
    throw new Error("PRODUCTION_PRICE_REPAIR_INPUT_GAP: 价格或换算证据不完整");
  }
  const recommended = previous.lockedScope?.recommendedPrice;
  if (!isObject(recommended) || buyerTargetPrice.amount !== recommended.rub || platformWritePrice.amount !== recommended.cny) {
    throw new Error("PRODUCTION_PRICE_REPAIR_SCOPE_REJECTED: 修复值必须来自原授权已锁定的双币种建议价");
  }

  const authorization = structuredClone(previous);
  delete authorization.lockedScope.finalPrice;
  authorization.authorizationId = `production-auth:${skuPackage.skuPackageId}:${skuPackage.dataRevision}:price-semantics`;
  authorization.confirmedAt = repairedAt;
  authorization.authorizedDataRevision = skuPackage.dataRevision;
  authorization.lockedScope.buyerTargetPrice = structuredClone(buyerTargetPrice);
  authorization.lockedScope.platformWritePrice = structuredClone(platformWritePrice);
  authorization.lockedScope.priceConversion = structuredClone(priceConversion);
  assertValidProductionAuthorization(authorization);

  const next = structuredClone(skuPackage);
  next.productionAuthorization = authorization;
  next.dataRevision += 1;
  next.audit.updatedAt = repairedAt;
  next.audit.history.push({
    event: "production_authorization_price_semantics_repaired_without_platform_write",
    at: repairedAt,
    previousAuthorizationId: previous.authorizationId,
    authorizationId: authorization.authorizationId,
    buyerTargetPrice: structuredClone(buyerTargetPrice),
    platformWritePrice: structuredClone(platformWritePrice),
    priceConversionEvidenceRef: priceConversion.evidenceRef,
    platformWrites: 0
  });
  assertValidLifecyclePackage(next);
  return deepFreeze({
    flowVersion: "production-price-semantics-repair-v1.1",
    skuPackage: next,
    productionAuthorization: next.productionAuthorization
  });
}

/**
 * 未来D唯一可用输入：返回授权时锁定的深拷贝，不读取C1/C2现场字段。
 */
export function readAuthorizedProductionSnapshot(productionAuthorization) {
  assertValidProductionAuthorization(productionAuthorization);
  return deepFreeze({
    authorizationId: productionAuthorization.authorizationId,
    authorizedDataRevision: productionAuthorization.authorizedDataRevision,
    readPolicy: productionAuthorization.readPolicy,
    lockedScope: structuredClone(productionAuthorization.lockedScope),
    productionExecuted: false
  });
}
