import { createHash } from "node:crypto";
import {
  assertValidProductionAuthorization
} from "./production-authorization.mjs";
import {
  assertValidProductionPlan,
  fingerprintProductionPlan,
  validateProductionPlanAuthorizationBinding
} from "./production-plan.mjs";
import { assertValidPlatformWritePreflight } from "./platform-write-preflight.mjs";
import { buildOzonSellerImportRequest } from "./ozon-seller-api-production-adapter.mjs";
import { resolveFinalUploads as resolveOzonFinalUploads } from "./ozon-seller-api-de-adapter.mjs";
import {
  PRODUCTION_RECORD_VERSION,
  assertValidProductionRecord
} from "./draft-production-execution.mjs";
import { verifySystemCreatedListing } from "./e-stage-readback.mjs";

export const D_SOFTWARE_EXECUTION_VERSION = "d-software-execution-v1";
export const E_SYSTEM_READBACK_VERSION = "e-system-readback-v1";

const REQUIRED_WRITE_FIELDS = Object.freeze([
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

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function gap(code, field, message) {
  return { code, field, message };
}

function validPreflight(plan, preflight, gaps) {
  if (preflight.sourceProductionPlanId !== plan.planId ||
      preflight.sourceProductionPlanFingerprint !== fingerprintProductionPlan(plan)) {
    gaps.push(gap("preflight_stale", "platformWritePreflight", "前检不属于当前ProductionPlan"));
  }
  if (preflight.targetPlatform !== plan.platform || preflight.storeIdentity.expectedStore !== plan.store ||
      preflight.storeIdentity.observedStore !== plan.store || preflight.storeIdentity.status !== "matched") {
    gaps.push(gap("store_identity_not_ready", "platformWritePreflight.storeIdentity", "Seller API店铺身份未与授权店铺一致"));
  }
  if (preflight.permission.status !== "verified" || preflight.connectionStatus.api.status !== "connected") {
    gaps.push(gap("seller_api_not_ready", "platformWritePreflight.connectionStatus.api", "Seller API权限或连接未验证"));
  }
  if (preflight.priceCurrency.status !== "matched" || preflight.priceCurrency.expected !== "CNY") {
    gaps.push(gap("price_currency_not_ready", "platformWritePreflight.priceCurrency", "Ozon中国卖家写入币种必须验证为CNY"));
  }
  const missing = REQUIRED_WRITE_FIELDS.filter((field) => !preflight.effectiveWritableFields.includes(field));
  if (missing.length > 0) gaps.push(gap("write_fields_not_ready", "platformWritePreflight.effectiveWritableFields", `平台当前不可写：${missing.join(",")}`));
}

function resolveAssets(plan, capabilities, gaps) {
  const resolution = resolveOzonFinalUploads({ finalUploads: plan.finalUploads, adapterCapabilities: capabilities });
  if (resolution.status !== "ready") gaps.push(...resolution.gaps);
  return resolution.resolvedAssets;
}

function validateCapabilities(plan, capabilities, gaps) {
  if (!isObject(capabilities) || capabilities.platform !== "ozon" || capabilities.store !== plan.store ||
      !nonEmpty(capabilities.adapterVersion) || !nonEmpty(capabilities.evidenceRef)) {
    gaps.push(gap("adapter_capabilities_missing", "adapterCapabilities", "缺少当前Ozon店铺Seller API能力证据"));
    return;
  }
  if (capabilities.productImport?.status !== "verified" || !nonEmpty(capabilities.productImport.evidenceRef)) {
    gaps.push(gap("product_import_protocol_not_ready", "adapterCapabilities.productImport", "商品导入协议未验证"));
  }
  if (capabilities.assetTransport?.status !== "verified" || !nonEmpty(capabilities.assetTransport.evidenceRef)) {
    gaps.push(gap("asset_transport_protocol_not_ready", "adapterCapabilities.assetTransport", "最终素材URL或上传能力未经Ozon当前协议验证"));
  }
  const inventory = capabilities.inventoryWrite;
  if (!isObject(inventory) || inventory.status !== "verified" || !nonEmpty(inventory.endpoint) ||
      !nonEmpty(inventory.warehouseId) || !nonEmpty(inventory.protocolVersion) || !nonEmpty(inventory.evidenceRef)) {
    gaps.push(gap("inventory_protocol_not_ready", "adapterCapabilities.inventoryWrite", "库存100所需接口、仓库和协议证据未锁定"));
  }
  if (capabilities.independentReadback?.status !== "verified" || !nonEmpty(capabilities.independentReadback.evidenceRef)) {
    gaps.push(gap("readback_protocol_not_ready", "adapterCapabilities.independentReadback", "Seller API独立回读协议未验证"));
  }
}

export function prepareSingleSkuDExecution({
  productionPlan,
  productionAuthorization,
  platformWritePreflight,
  adapterCapabilities,
  preparedAt
}) {
  assertValidProductionPlan(productionPlan);
  assertValidProductionAuthorization(productionAuthorization);
  assertValidPlatformWritePreflight(platformWritePreflight);
  if (!isoDateTime(preparedAt)) throw new Error("D_SOFTWARE_INPUT_INVALID: 准备时间无效");
  const binding = validateProductionPlanAuthorizationBinding(productionPlan, productionAuthorization);
  if (!binding.valid) throw new Error("D_SOFTWARE_AUTHORIZATION_DRIFT: ProductionPlan与主人授权不一致");

  const gaps = [];
  if (productionPlan.platform !== "ozon" || productionPlan.executionStrategy?.primaryPath !== "seller_api") {
    gaps.push(gap("unsupported_platform_path", "platform", "首期D软件执行只支持Ozon Seller API"));
  }
  if (productionPlan.publishScope !== "create_and_allow_validation_moderation") {
    gaps.push(gap("seller_api_publish_scope_not_ready", "publishScope", "当前Ozon Seller API导入路径只支持创建并进入校验/审核"));
  }
  if (productionPlan.stock !== 100) gaps.push(gap("stock_not_locked", "stock", "新品库存必须由授权快照锁定为100"));
  const missingFields = REQUIRED_WRITE_FIELDS.filter((field) => !productionPlan.allowedWriteFields.includes(field));
  if (missingFields.length > 0) gaps.push(gap("authorization_write_scope_incomplete", "allowedWriteFields", `主人授权未覆盖：${missingFields.join(",")}`));
  validPreflight(productionPlan, platformWritePreflight, gaps);
  validateCapabilities(productionPlan, adapterCapabilities, gaps);
  const assets = resolveAssets(productionPlan, adapterCapabilities, gaps);

  const common = {
    schemaVersion: D_SOFTWARE_EXECUTION_VERSION,
    preparedAt,
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: productionPlan.sourceAuthorizationFingerprint,
    platform: productionPlan.platform,
    store: productionPlan.store,
    skuPackageId: productionPlan.skuPackageId,
    merchantSku: productionPlan.sku.supplierSkuId,
    supplierSkuId: productionPlan.sku.supplierSkuId,
    assetsFinalUploadsVersion: productionPlan.assetsFinalUploadsVersion,
    publishScope: productionPlan.publishScope,
    exclusions: structuredClone(productionPlan.exclusions),
    allowedWriteFields: structuredClone(productionPlan.allowedWriteFields),
    gaps,
    executionPolicy: {
      path: "ozon_seller_api",
      batchSize: 1,
      attemptLimit: 1,
      automaticRetry: false,
      browserFallback: false,
      manualFallback: false,
      codexDispatch: false,
      nextSkuAutomaticStart: false
    }
  };
  if (gaps.length > 0) return deepFreeze({ ...common, status: "not_ready", executableRequest: null });

  const resolvedUploads = productionPlan.finalUploads.map((asset, index) => ({
    ...structuredClone(asset),
    assetRef: assets[index].platformAcceptedUrl
  }));
  const payload = {
    mode: "single_sku_create_and_moderate",
    platform: productionPlan.platform,
    store: productionPlan.store,
    skuPackageId: productionPlan.skuPackageId,
    supplierSkuId: productionPlan.sku.supplierSkuId,
    variantKey: productionPlan.sku.variantKey,
    title: productionPlan.title,
    content: structuredClone(productionPlan.content),
    attributes: structuredClone(productionPlan.attributes),
    packing: structuredClone(productionPlan.packing),
    schemaWriteBindings: structuredClone(productionPlan.schemaWriteBindings),
    platformCategory: structuredClone(productionPlan.platformCategory),
    platformWritePrice: structuredClone(productionPlan.platformWritePrice),
    finalUploads: resolvedUploads,
    publishScope: productionPlan.publishScope
  };
  let importRequest;
  try {
    importRequest = buildOzonSellerImportRequest(payload);
  } catch (error) {
    return deepFreeze({
      ...common,
      status: "not_ready",
      gaps: [gap("ozon_import_payload_not_ready", "executableRequest.productImport", error.message)],
      executableRequest: null
    });
  }
  const requestCore = {
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: common.sourceProductionPlanFingerprint,
    sourceAuthorizationId: productionAuthorization.authorizationId,
    sourceAuthorizationFingerprint: productionPlan.sourceAuthorizationFingerprint,
    platform: "ozon",
    store: productionPlan.store,
    skuPackageId: productionPlan.skuPackageId,
    merchantSku: productionPlan.sku.supplierSkuId,
    supplierSkuId: productionPlan.sku.supplierSkuId,
    platformWritePrice: structuredClone(productionPlan.platformWritePrice),
    stock: 100,
    assetsFinalUploadsVersion: productionPlan.assetsFinalUploadsVersion,
    finalUploads: assets,
    publishScope: productionPlan.publishScope,
    exclusions: structuredClone(productionPlan.exclusions),
    allowedWriteFields: [...REQUIRED_WRITE_FIELDS],
    productImport: importRequest,
    inventoryWrite: {
      endpoint: adapterCapabilities.inventoryWrite.endpoint,
      warehouseId: adapterCapabilities.inventoryWrite.warehouseId,
      protocolVersion: adapterCapabilities.inventoryWrite.protocolVersion,
      evidenceRef: adapterCapabilities.inventoryWrite.evidenceRef,
      stock: 100
    },
    independentReadback: {
      evidenceRef: adapterCapabilities.independentReadback.evidenceRef,
      expectedPrice: structuredClone(productionPlan.platformWritePrice),
      expectedStock: 100,
      expectedImageCount: assets.length
    },
    protocolEvidence: {
      adapter: adapterCapabilities.evidenceRef,
      productImport: adapterCapabilities.productImport.evidenceRef,
      assetTransport: adapterCapabilities.assetTransport.evidenceRef,
      inventoryWrite: adapterCapabilities.inventoryWrite.evidenceRef,
      independentReadback: adapterCapabilities.independentReadback.evidenceRef
    }
  };
  const executionKey = `d-execution:${sha256({
    sourceAuthorizationFingerprint: productionPlan.sourceAuthorizationFingerprint,
    sourceProductionPlanFingerprint: common.sourceProductionPlanFingerprint,
    requestCore
  })}`;
  return deepFreeze({
    ...common,
    status: "ready",
    gaps: [],
    executableRequest: { ...requestCore, executionKey, idempotencyKey: executionKey }
  });
}

export function beginDSoftwareExecution({ preparedExecution, startedAt }) {
  if (!isObject(preparedExecution) || preparedExecution.schemaVersion !== D_SOFTWARE_EXECUTION_VERSION ||
      preparedExecution.status !== "ready" || !isObject(preparedExecution.executableRequest)) {
    throw new Error("D_SOFTWARE_NOT_READY: 只有ready请求可以开始执行");
  }
  if (!isoDateTime(startedAt)) throw new Error("D_SOFTWARE_INPUT_INVALID: 开始时间无效");
  const request = preparedExecution.executableRequest;
  return deepFreeze({
    schemaVersion: D_SOFTWARE_EXECUTION_VERSION,
    attemptId: `d-attempt:${sha256({ executionKey: request.executionKey })}`,
    executionKey: request.executionKey,
    status: "in_flight",
    startedAt,
    request: structuredClone(request),
    persistBeforeWrite: true,
    attemptNumber: 1,
    retryAllowed: false,
    productionRecord: null
  });
}

export function markDSoftwareUnknownOutcome({ executionAttempt, reason, markedAt }) {
  if (!isObject(executionAttempt) || executionAttempt.status !== "in_flight" || !nonEmpty(reason) || !isoDateTime(markedAt)) {
    throw new Error("D_SOFTWARE_UNKNOWN_OUTCOME_INVALID: 只能把已持久化的in_flight执行标记为unknown_outcome");
  }
  return deepFreeze({
    ...structuredClone(executionAttempt),
    status: "unknown_outcome",
    markedAt,
    reason,
    retryAllowed: false,
    productionRecord: null
  });
}

function readbackMatches(request, observation) {
  const errors = [];
  for (const [field, expected] of [
    ["platform", request.platform],
    ["store", request.store],
    ["merchantSku", request.merchantSku],
    ["supplierSkuId", request.supplierSkuId]
  ]) if (String(observation[field] || "") !== String(expected)) errors.push(field);
  if (!nonEmpty(String(observation.platformProductId || ""))) errors.push("platformProductId");
  if (!isObject(observation.currentPrice) || observation.currentPrice.amount !== request.platformWritePrice.amount ||
      observation.currentPrice.currency !== request.platformWritePrice.currency) errors.push("currentPrice");
  if (observation.currentStock !== 100) errors.push("currentStock");
  if (observation.imageCount !== request.finalUploads.length) errors.push("imageCount");
  if (!nonEmpty(observation.moderationStatus) || !nonEmpty(observation.validationStatus) || !nonEmpty(observation.saleStatus)) errors.push("platformStatus");
  if (!Array.isArray(observation.errors) || !nonEmpty(observation.platformEvidenceRef)) errors.push("platformEvidence");
  return errors;
}

export async function executeDSoftwareAttempt({ executionAttempt, executeSellerApi, readbackSellerApi, completedAt }) {
  if (!isObject(executionAttempt) || executionAttempt.schemaVersion !== D_SOFTWARE_EXECUTION_VERSION || executionAttempt.status !== "in_flight") {
    throw new Error("D_SOFTWARE_ATTEMPT_STATE_REJECTED: 只能执行一次in_flight状态；成功、失败或未知结果均禁止重复写入");
  }
  if (typeof executeSellerApi !== "function" || typeof readbackSellerApi !== "function" || !isoDateTime(completedAt)) {
    throw new Error("D_SOFTWARE_EXECUTOR_INVALID: 缺少受控Seller API执行器、独立回读器或时间");
  }
  const request = executionAttempt.request;
  let platformResult;
  try {
    platformResult = await executeSellerApi(deepFreeze(structuredClone(request)));
  } catch (error) {
    return markDSoftwareUnknownOutcome({ executionAttempt, reason: `seller_api_transport:${error.message}`, markedAt: completedAt });
  }
  if (platformResult?.status === "rejected_before_write" && platformResult.writeOccurred === false) {
    return deepFreeze({
      ...structuredClone(executionAttempt),
      status: "failed",
      completedAt,
      failure: { layer: "seller_api", code: platformResult.code || "rejected_before_write", message: platformResult.message || "平台写前拒绝" },
      retryAllowed: false,
      productionRecord: null
    });
  }
  if (!isObject(platformResult) || platformResult.status !== "accepted" || !nonEmpty(String(platformResult.productId || "")) ||
      !nonEmpty(String(platformResult.offerId || "")) || !nonEmpty(platformResult.requestReceiptRef) ||
      !nonEmpty(platformResult.inventoryReceiptRef) || String(platformResult.offerId) !== request.merchantSku) {
    return markDSoftwareUnknownOutcome({ executionAttempt, reason: "seller_api_response_identity_or_receipt_missing", markedAt: completedAt });
  }

  let observation;
  try {
    observation = await readbackSellerApi(deepFreeze({
      mode: "independent_read_only",
      platform: request.platform,
      store: request.store,
      platformProductId: String(platformResult.productId),
      merchantSku: request.merchantSku,
      supplierSkuId: request.supplierSkuId,
      writeAllowed: false
    }));
  } catch (error) {
    return markDSoftwareUnknownOutcome({ executionAttempt, reason: `independent_readback:${error.message}`, markedAt: completedAt });
  }
  const mismatches = readbackMatches(request, observation);
  if (String(observation.platformProductId || "") !== String(platformResult.productId)) mismatches.push("platformProductId");
  if (mismatches.length > 0) {
    return markDSoftwareUnknownOutcome({ executionAttempt, reason: `write_readback_mismatch:${[...new Set(mismatches)].join(",")}`, markedAt: completedAt });
  }

  const record = {
    schemaVersion: PRODUCTION_RECORD_VERSION,
    productionRecordId: `production-record:${request.skuPackageId}:${sha256({ executionKey: request.executionKey, platformResult }).slice(0, 16)}`,
    executionMode: "single_sku_seller_api",
    executionKey: request.executionKey,
    sourceProductionPlanId: request.sourceProductionPlanId,
    sourceProductionPlanFingerprint: request.sourceProductionPlanFingerprint,
    sourceAuthorizationId: request.sourceAuthorizationId,
    sourceAuthorizationFingerprint: request.sourceAuthorizationFingerprint,
    platform: request.platform,
    store: request.store,
    skuPackageId: request.skuPackageId,
    supplierSkuId: request.supplierSkuId,
    merchantSku: request.merchantSku,
    platformProductId: String(platformResult.productId),
    platformOfferId: String(platformResult.offerId),
    status: "validation_or_moderation",
    writtenFields: [...REQUIRED_WRITE_FIELDS],
    platformEvidenceRef: observation.platformEvidenceRef,
    platformWriteEvidenceRef: platformResult.requestReceiptRef,
    platformReadbackEvidenceRef: observation.platformEvidenceRef,
    requestReceiptRef: platformResult.requestReceiptRef,
    inventoryReceiptRef: platformResult.inventoryReceiptRef,
    createdAt: completedAt,
    businessStateEffect: "D_created_entered_validation_moderation",
    batchSize: 1,
    published: false,
    activated: false,
    advertisingOpened: false,
    inventoryModified: true,
    stockWritten: 100,
    imagesUploaded: request.finalUploads.length,
    finalUploadAssetIds: request.finalUploads.map((asset) => asset.assetId),
    mainImageAssetId: request.finalUploads[0].assetId,
    expectedPrice: structuredClone(request.platformWritePrice),
    expectedStock: 100,
    expectedImageCount: request.finalUploads.length,
    independentReadbackVerified: true
  };
  assertValidProductionRecord(record);
  return deepFreeze({
    ...structuredClone(executionAttempt),
    status: "succeeded",
    completedAt,
    retryAllowed: false,
    platformResult: structuredClone(platformResult),
    immediateReadback: structuredClone(observation),
    productionRecord: record
  });
}

function listedState(observation) {
  return observation.moderationStatus === "approved" && observation.validationStatus === "success" &&
    ["on_sale", "active", "selling"].includes(observation.saleStatus) && Array.isArray(observation.errors) && observation.errors.length === 0;
}

export async function runSystemCreatedEReadback({ productionRecord, readPlatform, verifiedAt }) {
  assertValidProductionRecord(productionRecord);
  if (productionRecord.executionMode !== "single_sku_seller_api") throw new Error("E_SYSTEM_PATH_REQUIRED: 软件E回读只接受Seller API ProductionRecord");
  if (typeof readPlatform !== "function" || !isoDateTime(verifiedAt)) throw new Error("E_SYSTEM_READBACK_INPUT_INVALID: 缺少只读回读器或时间");
  let observation;
  try {
    observation = await readPlatform(deepFreeze({
      mode: "independent_read_only",
      sourceRecordType: "ProductionRecord",
      platform: productionRecord.platform,
      store: productionRecord.store,
      skuPackageId: productionRecord.skuPackageId,
      platformProductId: productionRecord.platformProductId,
      merchantSku: productionRecord.merchantSku,
      supplierSkuId: productionRecord.supplierSkuId,
      writeAllowed: false
    }));
  } catch (error) {
    return deepFreeze({
      schemaVersion: E_SYSTEM_READBACK_VERSION,
      status: "not_verified",
      outcome: null,
      verifiedAt,
      sourceProductionRecordId: productionRecord.productionRecordId,
      gaps: [`technical_readback_failure:${error.message}`],
      observation: {},
      eVerificationRecord: null,
      automaticRetry: false,
      platformWrites: 0
    });
  }
  const expected = {
    platform: productionRecord.platform,
    store: productionRecord.store,
    skuPackageId: productionRecord.skuPackageId,
    platformProductId: productionRecord.platformProductId,
    merchantSku: productionRecord.merchantSku,
    supplierSkuId: productionRecord.supplierSkuId,
    platformWritePrice: productionRecord.expectedPrice,
    stock: productionRecord.expectedStock,
    imageCount: productionRecord.expectedImageCount,
    finalUploads: productionRecord.finalUploadAssetIds.map((assetId) => ({ assetId }))
  };
  const mismatches = readbackMatches(expected, observation);
  if (String(observation.skuPackageId || "") !== productionRecord.skuPackageId) mismatches.push("skuPackageId");
  if (!listedState(observation)) mismatches.push("listedStatus");
  if (mismatches.length > 0) return deepFreeze({
    schemaVersion: E_SYSTEM_READBACK_VERSION,
    status: "not_verified",
    outcome: null,
    verifiedAt,
    sourceProductionRecordId: productionRecord.productionRecordId,
    gaps: [...new Set(mismatches)],
    observation: structuredClone(observation),
    eVerificationRecord: null,
    automaticRetry: false,
    platformWrites: 0
  });
  const verification = verifySystemCreatedListing({
    productionRecord,
    verifiedObservation: observation,
    verifiedAt,
    ownerPriceDecision: {
      decision: "authorized_platform_write_price",
      confirmedBy: "owner",
      authorizationId: productionRecord.sourceAuthorizationId,
      price: structuredClone(productionRecord.expectedPrice)
    }
  });
  return deepFreeze({
    schemaVersion: E_SYSTEM_READBACK_VERSION,
    status: "verified",
    outcome: "listed_verified",
    verifiedAt,
    sourceProductionRecordId: productionRecord.productionRecordId,
    gaps: [],
    observation: structuredClone(observation),
    eVerificationRecord: verification,
    automaticRetry: false,
    platformWrites: 0
  });
}
