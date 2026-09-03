import { createHash } from "node:crypto";
import {
  assertValidProductionPlan,
  fingerprintProductionPlan,
  validateProductionPlanAuthorizationBinding
} from "./production-plan.mjs";
import {
  assertValidProductionAuthorization,
  DRAFT_ONLY_PUBLISH_SCOPE,
  VALIDATION_MODERATION_PUBLISH_SCOPE,
  PRODUCTION_WRITE_FIELDS
} from "./production-authorization.mjs";
import { assertValidPlatformWritePreflight } from "./platform-write-preflight.mjs";

export const PRODUCTION_RECORD_VERSION = "production-record-v1.1";

const DRAFT_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "stock",
  "assets.finalUploads",
  "publish_scope"
]);
const MODERATION_WRITE_FIELDS = Object.freeze([
  "create_product",
  "title",
  "attributes",
  "price",
  "assets.finalUploads",
  "publish_scope"
]);

function writeFieldsFor(plan) {
  return plan.publishScope === VALIDATION_MODERATION_PUBLISH_SCOPE ? MODERATION_WRITE_FIELDS : DRAFT_WRITE_FIELDS;
}

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

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function containsUnknown(value) {
  if (value === "unknown") return true;
  if (Array.isArray(value)) return value.some(containsUnknown);
  if (!isObject(value)) return false;
  if (value.verificationStatus === "unknown" || value.status === "unknown") return true;
  return Object.values(value).some(containsUnknown);
}

function requiredAttributesKnown(attributes) {
  const fields = attributes?.requiredPlatformFields;
  return Array.isArray(fields) && fields.length > 0 && fields.every((field) =>
    isObject(field) && isObject(field.fact) && !containsUnknown(field.fact)
  );
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function categoryValue(category, key) {
  const field = category?.[key];
  if (isObject(field) && "value" in field) return field.value;
  return field;
}

function validateDraftInputs(productionPlan, preflight) {
  if (![DRAFT_ONLY_PUBLISH_SCOPE, VALIDATION_MODERATION_PUBLISH_SCOPE].includes(productionPlan.publishScope)) {
    throw new Error("DRAFT_SCOPE_REJECTED: 生产范围无效");
  }
  if (productionPlan.allowedWriteFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field))) {
    throw new Error("DRAFT_SCOPE_REJECTED: 生产计划包含未授权字段");
  }
  const requiredWriteFields = writeFieldsFor(productionPlan);
  const missing = requiredWriteFields.filter((field) => !productionPlan.allowedWriteFields.includes(field));
  if (missing.length > 0) throw new Error(`DRAFT_SCOPE_REJECTED: 授权缺少草稿创建字段 ${missing.join(",")}`);
  if (!requiredAttributesKnown(productionPlan.attributes)) throw new Error("DRAFT_DATA_GAP: 平台必填属性仍有unknown，禁止真实创建");
  if (productionPlan.stock !== 100) throw new Error("DRAFT_DATA_GAP: 新品库存必须锁定为100");
  if (!Array.isArray(productionPlan.finalUploads) || productionPlan.finalUploads.length === 0 ||
      productionPlan.finalUploads.some((asset) => !nonEmptyString(asset.assetId) || !nonEmptyString(asset.assetRef) || asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
    throw new Error("DRAFT_DATA_GAP: 最终上传素材未完整锁定");
  }
  const descriptionCategoryId = categoryValue(productionPlan.platformCategory, "descriptionCategoryId");
  const typeId = categoryValue(productionPlan.platformCategory, "typeId");
  if (!nonEmptyString(String(descriptionCategoryId || "")) || descriptionCategoryId === "unknown" ||
      !nonEmptyString(String(typeId || "")) || typeId === "unknown") {
    throw new Error("DRAFT_DATA_GAP: 平台类目或商品类型未锁定");
  }
  if (preflight.sourceProductionPlanId !== productionPlan.planId ||
      preflight.sourceProductionPlanFingerprint !== fingerprintProductionPlan(productionPlan)) {
    throw new Error("DRAFT_PREFLIGHT_STALE: 前置检查不属于当前ProductionPlan");
  }
  if (preflight.technicalStatus !== "completed" ||
      preflight.storeIdentity.status !== "matched" ||
      preflight.permission.status !== "verified" ||
      preflight.priceCurrency?.status !== "matched" ||
      preflight.connectionStatus.api.status !== "connected") {
    throw new Error("DRAFT_PREFLIGHT_NOT_READY: 平台连接、店铺身份或权限检查未通过");
  }
  const unavailable = requiredWriteFields.filter((field) => !preflight.effectiveWritableFields.includes(field));
  if (unavailable.length > 0) throw new Error(`DRAFT_PREFLIGHT_NOT_READY: 平台当前不可写字段 ${unavailable.join(",")}`);
}

export function validateProductionRecord(record) {
  const errors = [];
  if (!isObject(record)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (record.schemaVersion !== PRODUCTION_RECORD_VERSION) push(errors, "schemaVersion", `必须是${PRODUCTION_RECORD_VERSION}`);
  for (const field of [
    "productionRecordId", "sourceProductionPlanId", "sourceProductionPlanFingerprint",
    "sourceAuthorizationId", "sourceAuthorizationFingerprint", "platform", "store",
    "skuPackageId", "supplierSkuId", "platformProductId", "platformEvidenceRef", "createdAt"
  ]) if (!nonEmptyString(record[field])) push(errors, field, "必须是非空字符串");
  if (!isoDateTime(record.createdAt)) push(errors, "createdAt", "必须是有效时间");
  if (!["draft", "validation_or_moderation"].includes(record.status)) push(errors, "status", "平台状态无效");
  if (!["single_sku_draft_only", "single_sku_create_and_moderate", "single_sku_seller_api"].includes(record.executionMode)) push(errors, "executionMode", "只能执行单SKU授权范围");
  const expectedFields = record.executionMode === "single_sku_create_and_moderate" ? MODERATION_WRITE_FIELDS : DRAFT_WRITE_FIELDS;
  if (!sameStringArray(record.writtenFields, expectedFields)) push(errors, "writtenFields", "写入字段与授权范围不一致");
  if (!["D_draft_created", "D_created_entered_validation_moderation"].includes(record.businessStateEffect)) push(errors, "businessStateEffect", "业务效果无效");
  if (record.batchSize !== 1) push(errors, "batchSize", "只能创建一个SKU");
  if (record.published !== false || record.activated !== false || record.advertisingOpened !== false) push(errors, "status", "禁止发布、激活或开广告");
  if (record.executionMode === "single_sku_draft_only" && (record.inventoryModified !== true || record.stockWritten !== 100)) push(errors, "inventoryModified", "草稿模式必须记录库存100已写入");
  if (record.executionMode === "single_sku_create_and_moderate" && (record.inventoryModified !== false || record.stockWritten !== null)) push(errors, "inventoryModified", "旧校验/审核模式必须记录库存未写");
  if (record.executionMode === "single_sku_seller_api") {
    for (const field of ["merchantSku", "requestReceiptRef", "inventoryReceiptRef", "executionKey"]) {
      if (!nonEmptyString(record[field])) push(errors, field, "Seller API软件执行记录必须保存非空值");
    }
    if (!nonEmptyString(record.platformOfferId) || record.platformOfferId !== record.merchantSku) push(errors, "platformOfferId", "平台offer必须等于锁定merchantSku");
    if (record.inventoryModified !== true || record.stockWritten !== 100) push(errors, "inventoryModified", "Seller API软件执行必须回读库存100");
    if (!isObject(record.expectedPrice) || !Number.isFinite(record.expectedPrice.amount) || !nonEmptyString(record.expectedPrice.currency)) push(errors, "expectedPrice", "必须锁定E回读价格");
    if (record.expectedStock !== 100) push(errors, "expectedStock", "必须锁定E回读库存100");
    if (record.expectedImageCount !== record.imagesUploaded) push(errors, "expectedImageCount", "必须锁定E回读图片数");
  }
  if (!Number.isInteger(record.imagesUploaded) || record.imagesUploaded < 1) push(errors, "imagesUploaded", "必须记录草稿内最终图片写入数量");
  if (!Array.isArray(record.finalUploadAssetIds) || record.finalUploadAssetIds.length !== record.imagesUploaded || record.finalUploadAssetIds.some((item) => !nonEmptyString(item))) push(errors, "finalUploadAssetIds", "必须按顺序记录已写入的最终素材");
  if (!nonEmptyString(record.mainImageAssetId) || record.mainImageAssetId !== record.finalUploadAssetIds?.[0]) push(errors, "mainImageAssetId", "首图必须是最终素材顺序第一张");
  if (record.independentReadbackVerified !== true || !nonEmptyString(record.platformWriteEvidenceRef) || !nonEmptyString(record.platformReadbackEvidenceRef)) push(errors, "independentReadbackVerified", "草稿创建后必须保存独立回读证据");
  return { valid: errors.length === 0, errors };
}

export function assertValidProductionRecord(record) {
  const result = validateProductionRecord(record);
  if (!result.valid) throw new Error(`ProductionRecord校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return record;
}

/**
 * 第13B-2阶段唯一真实写入口：一个SKU，只创建draft，并严格写入授权中的库存与最终素材。
 */
export async function executeSingleSkuDraftCreation({
  productionPlan,
  productionAuthorization,
  platformWritePreflight,
  createPlatformDraft,
  readbackPlatformDraft,
  executedAt
}) {
  assertValidProductionPlan(productionPlan);
  assertValidProductionAuthorization(productionAuthorization);
  assertValidPlatformWritePreflight(platformWritePreflight);
  if (!isoDateTime(executedAt)) throw new Error("DRAFT_EXECUTION_INPUT_GAP: 执行时间无效");
  if (typeof createPlatformDraft !== "function") throw new Error("DRAFT_EXECUTION_ADAPTER_REQUIRED: 缺少真实平台草稿创建器");
  if (typeof readbackPlatformDraft !== "function") throw new Error("DRAFT_READBACK_ADAPTER_REQUIRED: 缺少独立草稿回读器");

  const binding = validateProductionPlanAuthorizationBinding(productionPlan, productionAuthorization);
  if (!binding.valid) throw new Error("DRAFT_AUTHORIZATION_VERSION_CHANGED: 授权版本或内容已变化，拒绝执行");
  validateDraftInputs(productionPlan, platformWritePreflight);

  const protectedPlan = structuredClone(productionPlan);
  const protectedAuthorization = structuredClone(productionAuthorization);
  const moderationMode = productionPlan.publishScope === VALIDATION_MODERATION_PUBLISH_SCOPE;
  const payload = deepFreeze({
    mode: moderationMode ? "single_sku_create_and_moderate" : "single_sku_draft_only",
    platform: productionPlan.platform,
    store: productionPlan.store,
    skuPackageId: productionPlan.skuPackageId,
    supplierSkuId: productionPlan.sku.supplierSkuId,
    variantKey: productionPlan.sku.variantKey,
    title: productionPlan.title,
    titleVersion: productionPlan.titleVersion,
    content: structuredClone(productionPlan.content),
    contentVersion: productionPlan.contentVersion,
    attributes: structuredClone(productionPlan.attributes),
    attributeVersion: productionPlan.attributeVersion,
    packing: structuredClone(productionPlan.packing),
    schemaWriteBindings: structuredClone(productionPlan.schemaWriteBindings),
    platformCategory: structuredClone(productionPlan.platformCategory),
    buyerTargetPrice: structuredClone(productionPlan.buyerTargetPrice),
    platformWritePrice: structuredClone(productionPlan.platformWritePrice),
    priceConversion: structuredClone(productionPlan.priceConversion),
    stock: productionPlan.stock,
    finalUploads: structuredClone(productionPlan.finalUploads),
    publishScope: productionPlan.publishScope,
    batchSize: 1,
    publish: false,
    activate: false,
    openAdvertising: false,
    writeInventory: !moderationMode,
    uploadImages: true
  });

  const platformResult = await createPlatformDraft(payload);
  if (JSON.stringify(protectedPlan) !== JSON.stringify(productionPlan) ||
      JSON.stringify(protectedAuthorization) !== JSON.stringify(productionAuthorization)) {
    throw new Error("DRAFT_EXECUTION_INPUT_MUTATED: 平台适配器修改了冻结输入");
  }
  const expectedStatus = moderationMode ? "validation_or_moderation" : "draft";
  if (!isObject(platformResult) || platformResult.status !== expectedStatus || !nonEmptyString(String(platformResult.productId || "")) || !nonEmptyString(platformResult.writeEvidenceRef)) {
    throw new Error(`DRAFT_PLATFORM_RESULT_INVALID: 平台必须返回${expectedStatus}状态、商品ID和写入证据引用`);
  }
  if (platformResult.published === true || platformResult.activated === true || (!moderationMode && platformResult.moderationSubmitted === true) || platformResult.advertisingOpened === true) {
    throw new Error("DRAFT_PLATFORM_SCOPE_VIOLATION: 平台返回了禁止的发布、激活、送审或广告变化");
  }

  const readback = await readbackPlatformDraft(deepFreeze({
    mode: moderationMode ? "independent_validation_moderation_readback" : "independent_draft_readback",
    platform: productionPlan.platform,
    store: productionPlan.store,
    productId: String(platformResult.productId),
    supplierSkuId: productionPlan.sku.supplierSkuId,
    expectedTitle: productionPlan.title,
    expectedPrice: structuredClone(productionPlan.platformWritePrice),
    expectedStock: moderationMode ? null : productionPlan.stock,
    expectedFinalUploadAssetIds: productionPlan.finalUploads.map((asset) => asset.assetId),
    expectedMainImageAssetId: productionPlan.finalUploads[0].assetId
  }));
  if (!isObject(readback) || readback.status !== expectedStatus || String(readback.productId || "") !== String(platformResult.productId) ||
      readback.title !== productionPlan.title || (!moderationMode && readback.stock !== productionPlan.stock) || (moderationMode && readback.inventoryModified !== false) ||
      !isObject(readback.price) || readback.price.amount !== productionPlan.platformWritePrice.amount || readback.price.currency !== productionPlan.platformWritePrice.currency ||
      !sameStringArray(readback.finalUploadAssetIds, productionPlan.finalUploads.map((asset) => asset.assetId)) ||
      readback.mainImageAssetId !== productionPlan.finalUploads[0].assetId || !nonEmptyString(readback.evidenceRef) ||
      readback.published === true || readback.activated === true || (!moderationMode && readback.moderationSubmitted === true)) {
    throw new Error("DRAFT_READBACK_MISMATCH: 独立回读未证明授权状态、标题、价格、库存边界和最终素材完全一致");
  }

  const record = {
    schemaVersion: PRODUCTION_RECORD_VERSION,
    productionRecordId: `production-record:${productionPlan.skuPackageId}:${fingerprint(platformResult).slice(0, 12)}`,
    executionMode: moderationMode ? "single_sku_create_and_moderate" : "single_sku_draft_only",
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: productionPlan.sourceAuthorizationFingerprint,
    platform: productionPlan.platform,
    store: productionPlan.store,
    skuPackageId: productionPlan.skuPackageId,
    supplierSkuId: productionPlan.sku.supplierSkuId,
    platformProductId: String(platformResult.productId),
    platformOfferId: nonEmptyString(String(platformResult.offerId || "")) ? String(platformResult.offerId) : null,
    status: expectedStatus,
    writtenFields: [...writeFieldsFor(productionPlan)],
    platformEvidenceRef: readback.evidenceRef,
    platformWriteEvidenceRef: platformResult.writeEvidenceRef,
    platformReadbackEvidenceRef: readback.evidenceRef,
    createdAt: executedAt,
    businessStateEffect: moderationMode ? "D_created_entered_validation_moderation" : "D_draft_created",
    batchSize: 1,
    published: false,
    activated: false,
    advertisingOpened: false,
    inventoryModified: !moderationMode,
    stockWritten: moderationMode ? null : productionPlan.stock,
    imagesUploaded: productionPlan.finalUploads.length,
    finalUploadAssetIds: productionPlan.finalUploads.map((asset) => asset.assetId),
    mainImageAssetId: productionPlan.finalUploads[0].assetId,
    independentReadbackVerified: true
  };
  assertValidProductionRecord(record);
  return deepFreeze({
    flowVersion: "single-sku-draft-execution-v1.1",
    productionRecord: record,
    productionPlanChanged: false,
    productionAuthorizationChanged: false,
    otherSkuExecuted: false
  });
}
