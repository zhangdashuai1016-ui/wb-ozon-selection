import { createHash } from "node:crypto";
import {
  assertValidProductionAuthorization,
  readAuthorizedProductionSnapshot
} from "./production-authorization.mjs";
import {
  createOzonProductionStrategy,
  validateOzonProductionStrategy
} from "./ozon-production-strategy.mjs";

export const PRODUCTION_PLAN_VERSION = "production-plan-v1.1";

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

function push(errors, path, message) {
  errors.push({ path, message });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function fingerprintProductionAuthorization(productionAuthorization) {
  assertValidProductionAuthorization(productionAuthorization);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(productionAuthorization)))
    .digest("hex");
}

export function fingerprintProductionPlan(productionPlan) {
  assertValidProductionPlan(productionPlan);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(productionPlan)))
    .digest("hex");
}

export function validateProductionPlan(plan) {
  const errors = [];
  if (!isObject(plan)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (plan.schemaVersion !== PRODUCTION_PLAN_VERSION) push(errors, "schemaVersion", `必须是${PRODUCTION_PLAN_VERSION}`);
  if (!nonEmptyString(plan.planId)) push(errors, "planId", "必须是非空字符串");
  if (plan.mode !== "simulation") push(errors, "mode", "第13A阶段只能是simulation");
  if (plan.status !== "prepared") push(errors, "status", "必须是prepared");
  if (!isoDateTime(plan.createdAt)) push(errors, "createdAt", "必须是有效时间");
  for (const field of [
    "sourceAuthorizationId", "sourceAuthorizationFingerprint", "platform", "store",
    "skuPackageId", "titleVersion", "attributeVersion", "assetsFinalUploadsVersion", "publishScope"
  ]) {
    if (!nonEmptyString(plan[field])) push(errors, field, "必须是非空字符串");
  }
  if (!Number.isInteger(plan.sourceAuthorizationRevision) || plan.sourceAuthorizationRevision < 0) {
    push(errors, "sourceAuthorizationRevision", "必须锁定非负授权修订号");
  }
  if (!isObject(plan.sku) || !nonEmptyString(plan.sku.supplierSkuId) || !nonEmptyString(plan.sku.variantKey)) {
    push(errors, "sku", "必须锁定供应SKU和变体");
  }
  if (!nonEmptyString(plan.title)) push(errors, "title", "必须锁定标题正文");
  if (!isObject(plan.attributes)) push(errors, "attributes", "必须锁定属性值");
  if (!isObject(plan.platformCategory)) push(errors, "platformCategory", "必须锁定平台类目");
  for (const field of ["buyerTargetPrice", "platformWritePrice"]) {
    if (!isObject(plan[field]) || !Number.isFinite(plan[field].amount) || plan[field].amount <= 0 || !nonEmptyString(plan[field].currency)) {
      push(errors, field, "必须锁定金额和币种");
    }
  }
  if (!isObject(plan.priceConversion) || !Number.isFinite(plan.priceConversion.rubPerCny) || plan.priceConversion.rubPerCny <= 0 || !nonEmptyString(plan.priceConversion.evidenceRef)) {
    push(errors, "priceConversion", "必须锁定价格换算证据");
  }
  if (String(plan.platform).toLowerCase() === "ozon" && (plan.buyerTargetPrice?.currency !== "RUB" || plan.platformWritePrice?.currency !== "CNY")) {
    push(errors, "platformWritePrice", "Ozon中国卖家计划必须将RUB买家价与CNY后台写入价分开");
  }
  const strategyValidation = validateOzonProductionStrategy(plan.executionStrategy);
  if (!strategyValidation.valid) push(errors, "executionStrategy", strategyValidation.errors.join("；"));
  if (plan.stock !== 100) push(errors, "stock", "新品库存必须为100");
  if (!Array.isArray(plan.finalUploads) || plan.finalUploads.length === 0) push(errors, "finalUploads", "必须锁定最终素材清单");
  if (!Array.isArray(plan.exclusions)) push(errors, "exclusions", "必须继承授权排除项");
  if (!Array.isArray(plan.allowedWriteFields) || plan.allowedWriteFields.length === 0) push(errors, "allowedWriteFields", "必须继承授权字段范围");
  if (plan.sourceReadPolicy !== "authorization_snapshot_only") push(errors, "sourceReadPolicy", "只能读取授权快照");
  if (plan.sourceDataAccess !== "production_authorization_only") push(errors, "sourceDataAccess", "不得读取A/B/C原始数据");
  if (plan.productResearchPerformed !== false) push(errors, "productResearchPerformed", "不得重新寻找商品信息");
  if (plan.platformWrites !== 0) push(errors, "platformWrites", "第13A阶段不得平台写入");
  if (plan.productCreated !== false) push(errors, "productCreated", "第13A阶段不得创建商品");
  if (plan.assetsUploaded !== 0) push(errors, "assetsUploaded", "第13A阶段不得上传素材");
  if (plan.readbackPerformed !== false) push(errors, "readbackPerformed", "第13A阶段不得执行E回读");
  return { valid: errors.length === 0, errors };
}

export function assertValidProductionPlan(plan) {
  const result = validateProductionPlan(plan);
  if (!result.valid) throw new Error(`ProductionPlan校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return plan;
}

/**
 * 第13A阶段只生成D执行模拟计划。所有业务字段仅来自ProductionAuthorization锁定快照。
 */
export function createProductionPlan({ productionAuthorization, createdAt }) {
  assertValidProductionAuthorization(productionAuthorization);
  if (!isoDateTime(createdAt)) throw new Error("PRODUCTION_PLAN_INPUT_GAP: 创建时间无效");
  const snapshot = readAuthorizedProductionSnapshot(productionAuthorization);
  const scope = snapshot.lockedScope;
  const authorizationFingerprint = fingerprintProductionAuthorization(productionAuthorization);
  const plan = {
    schemaVersion: PRODUCTION_PLAN_VERSION,
    planId: `production-plan:${snapshot.authorizationId}:${authorizationFingerprint.slice(0, 12)}`,
    mode: "simulation",
    status: "prepared",
    createdAt,
    sourceAuthorizationId: snapshot.authorizationId,
    sourceAuthorizationRevision: snapshot.authorizedDataRevision,
    sourceAuthorizationFingerprint: authorizationFingerprint,
    platform: scope.platform,
    store: scope.store,
    skuPackageId: scope.skuPackageId,
    sku: {
      supplierSkuId: scope.supplierSkuId,
      variantKey: scope.variantKey
    },
    titleVersion: scope.titleVersion,
    title: scope.title,
    attributeVersion: scope.attributeVersion,
    attributes: structuredClone(scope.attributes),
    platformCategory: structuredClone(scope.platformCategory),
    buyerTargetPrice: structuredClone(scope.buyerTargetPrice),
    platformWritePrice: structuredClone(scope.platformWritePrice),
    priceConversion: structuredClone(scope.priceConversion),
    stock: scope.stock,
    assetsFinalUploadsVersion: scope.assetsFinalUploadsVersion,
    finalUploads: structuredClone(scope.finalUploads),
    executionStrategy: createOzonProductionStrategy({
      platform: scope.platform,
      finalUploads: scope.finalUploads
    }),
    publishScope: scope.publishScope,
    exclusions: structuredClone(scope.exclusions),
    allowedWriteFields: structuredClone(scope.allowedWriteFields),
    sourceReadPolicy: snapshot.readPolicy,
    sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false,
    platformWrites: 0,
    productCreated: false,
    assetsUploaded: 0,
    readbackPerformed: false
  };
  assertValidProductionPlan(plan);
  return deepFreeze(plan);
}

/**
 * 计划创建后若授权对象发生任何变化，明确报告漂移；绝不更新既有计划。
 */
export function validateProductionPlanAuthorizationBinding(plan, productionAuthorization) {
  assertValidProductionPlan(plan);
  assertValidProductionAuthorization(productionAuthorization);
  const currentFingerprint = fingerprintProductionAuthorization(productionAuthorization);
  const matches = plan.sourceAuthorizationId === productionAuthorization.authorizationId &&
    plan.sourceAuthorizationRevision === productionAuthorization.authorizedDataRevision &&
    plan.sourceAuthorizationFingerprint === currentFingerprint;
  return deepFreeze({
    valid: matches,
    status: matches ? "authorization_unchanged" : "authorization_drift_detected",
    planId: plan.planId,
    sourceAuthorizationId: plan.sourceAuthorizationId,
    currentAuthorizationId: productionAuthorization.authorizationId
  });
}
