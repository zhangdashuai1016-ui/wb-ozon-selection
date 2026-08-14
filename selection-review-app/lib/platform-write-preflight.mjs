import { createHash } from "node:crypto";
import { assertValidProductionPlan, fingerprintProductionPlan } from "./production-plan.mjs";

export const PLATFORM_WRITE_PREFLIGHT_VERSION = "platform-write-preflight-v1.1";

const PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);
const CONNECTION_STATUSES = new Set(["connected", "unavailable", "system_error", "permission_required", "unknown"]);
const IMAGE_PERMISSION_STATUSES = new Set(["verified", "denied", "permission_required", "unknown"]);
const TECHNICAL_STATUSES = new Set(["completed", "system_error", "permission_required", "data_unavailable"]);

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

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validateConnection(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是对象");
    return;
  }
  if (!CONNECTION_STATUSES.has(value.status)) push(errors, `${path}.status`, "连接状态无效");
  if (!nonEmptyString(value.checkedVia)) push(errors, `${path}.checkedVia`, "必须说明检查路径");
  if (!nonEmptyString(value.evidenceRef)) push(errors, `${path}.evidenceRef`, "必须保存证据引用");
}

export function validatePlatformWritePreflight(preflight) {
  const errors = [];
  if (!isObject(preflight)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (preflight.schemaVersion !== PLATFORM_WRITE_PREFLIGHT_VERSION) push(errors, "schemaVersion", `必须是${PLATFORM_WRITE_PREFLIGHT_VERSION}`);
  for (const field of ["preflightId", "sourceProductionPlanId", "sourceProductionPlanFingerprint", "targetPlatform", "checkedAt"]) {
    if (!nonEmptyString(preflight[field])) push(errors, field, "必须是非空字符串");
  }
  if (!isoDateTime(preflight.checkedAt)) push(errors, "checkedAt", "必须是有效时间");
  if (!isObject(preflight.storeIdentity) || !nonEmptyString(preflight.storeIdentity.expectedStore) || !nonEmptyString(preflight.storeIdentity.observedStore) || !["matched", "mismatched", "unverified"].includes(preflight.storeIdentity.status) || !nonEmptyString(preflight.storeIdentity.evidenceRef)) {
    push(errors, "storeIdentity", "必须保存预期店铺、观察店铺、匹配状态和证据");
  }
  if (!isObject(preflight.permission) || !PERMISSION_STATUSES.has(preflight.permission.status) || !nonEmptyString(preflight.permission.evidenceRef)) {
    push(errors, "permission", "必须保存权限状态和证据");
  }
  if (!isObject(preflight.connectionStatus)) {
    push(errors, "connectionStatus", "必须是对象");
  } else {
    validateConnection(preflight.connectionStatus.api, "connectionStatus.api", errors);
    validateConnection(preflight.connectionStatus.sellerBackend, "connectionStatus.sellerBackend", errors);
  }
  if (!stringArray(preflight.authorizedWriteFields) || preflight.authorizedWriteFields.length === 0) push(errors, "authorizedWriteFields", "必须继承生产计划授权字段");
  if (!stringArray(preflight.platformWritableFields)) push(errors, "platformWritableFields", "必须是字符串数组");
  if (!stringArray(preflight.effectiveWritableFields)) push(errors, "effectiveWritableFields", "必须是字符串数组");
  if (stringArray(preflight.effectiveWritableFields) && stringArray(preflight.authorizedWriteFields) && preflight.effectiveWritableFields.some((field) => !preflight.authorizedWriteFields.includes(field))) {
    push(errors, "effectiveWritableFields", "不得超出生产计划授权字段");
  }
  if (stringArray(preflight.effectiveWritableFields) && stringArray(preflight.platformWritableFields) && preflight.effectiveWritableFields.some((field) => !preflight.platformWritableFields.includes(field))) {
    push(errors, "effectiveWritableFields", "不得超出平台现场可写字段");
  }
  if (!isObject(preflight.imagePermission) || !IMAGE_PERMISSION_STATUSES.has(preflight.imagePermission.status) || !nonEmptyString(preflight.imagePermission.evidenceRef)) {
    push(errors, "imagePermission", "必须保存图片权限状态和证据");
  }
  if (!isObject(preflight.priceCurrency) || !nonEmptyString(preflight.priceCurrency.expected) || !nonEmptyString(preflight.priceCurrency.observed) || !["matched", "mismatched", "unverified"].includes(preflight.priceCurrency.status) || !nonEmptyString(preflight.priceCurrency.evidenceRef)) {
    push(errors, "priceCurrency", "必须保存平台价格字段币种核验");
  }
  if (!Array.isArray(preflight.risks) || preflight.risks.some((risk) => !isObject(risk) || !nonEmptyString(risk.code) || !nonEmptyString(risk.message))) {
    push(errors, "risks", "风险必须是带代码和说明的数组");
  }
  if (!TECHNICAL_STATUSES.has(preflight.technicalStatus)) push(errors, "technicalStatus", "技术状态无效");
  if (preflight.businessStateEffect !== "none") push(errors, "businessStateEffect", "技术检查不得影响商品业务状态");
  if (preflight.readyForPlatformWrite !== false) push(errors, "readyForPlatformWrite", "第13B-1阶段不得进入真实写入");
  if (preflight.productCreated !== false) push(errors, "productCreated", "不得创建商品");
  if (preflight.imagesUploaded !== 0) push(errors, "imagesUploaded", "不得上传图片");
  if (preflight.inventoryModified !== false) push(errors, "inventoryModified", "不得修改库存");
  if (preflight.storeDataModified !== false) push(errors, "storeDataModified", "不得修改店铺数据");
  if (preflight.productionRecordCreated !== false) push(errors, "productionRecordCreated", "不得生成生产记录");
  if (preflight.platformWrites !== 0) push(errors, "platformWrites", "不得产生平台写入");
  return { valid: errors.length === 0, errors };
}

export function assertValidPlatformWritePreflight(preflight) {
  const result = validatePlatformWritePreflight(preflight);
  if (!result.valid) throw new Error(`PlatformWritePreflight校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return preflight;
}

function validateInspection(inspection) {
  if (!isObject(inspection)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 检查器必须返回结构化结果");
  if (!nonEmptyString(inspection.observedStore) || !["matched", "mismatched", "unverified"].includes(inspection.storeIdentityStatus) || !nonEmptyString(inspection.storeIdentityEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 店铺身份检查结果不完整");
  }
  if (!PERMISSION_STATUSES.has(inspection.permissionStatus) || !nonEmptyString(inspection.permissionEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 权限检查结果不完整");
  }
  for (const name of ["api", "sellerBackend"]) {
    const value = inspection.connections?.[name];
    if (!isObject(value) || !CONNECTION_STATUSES.has(value.status) || !nonEmptyString(value.checkedVia) || !nonEmptyString(value.evidenceRef)) {
      throw new Error(`PLATFORM_PREFLIGHT_INSPECTION_INVALID: ${name}连接检查结果不完整`);
    }
  }
  if (!stringArray(inspection.platformWritableFields)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 平台可写字段必须是字符串数组");
  if (!IMAGE_PERMISSION_STATUSES.has(inspection.imagePermissionStatus) || !nonEmptyString(inspection.imagePermissionEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 图片权限检查结果不完整");
  }
  if (!nonEmptyString(inspection.priceFieldCurrency) || !nonEmptyString(inspection.priceCurrencyEvidenceRef)) {
    throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 平台价格字段币种检查不完整");
  }
  if (!Array.isArray(inspection.risks)) throw new Error("PLATFORM_PREFLIGHT_INSPECTION_INVALID: 风险必须是数组");
}

function technicalStatusFor(inspection) {
  const connectionStatuses = [inspection.connections.api.status, inspection.connections.sellerBackend.status];
  if (inspection.permissionStatus === "permission_required" || inspection.imagePermissionStatus === "permission_required" || connectionStatuses.includes("permission_required")) return "permission_required";
  if (connectionStatuses.includes("system_error") || connectionStatuses.includes("unavailable")) return "system_error";
  if (connectionStatuses.includes("unknown") || inspection.permissionStatus === "unknown" || inspection.storeIdentityStatus === "unverified") return "data_unavailable";
  return "completed";
}

/**
 * 第13B-1阶段只执行只读平台前检。所有商品字段来自ProductionPlan；检查器只提供当前技术证据。
 */
export async function runPlatformWritePreflight({ productionPlan, inspectPlatform, checkedAt }) {
  assertValidProductionPlan(productionPlan);
  if (typeof inspectPlatform !== "function") throw new Error("PLATFORM_PREFLIGHT_INSPECTOR_REQUIRED: 缺少只读平台检查器");
  if (!isoDateTime(checkedAt)) throw new Error("PLATFORM_PREFLIGHT_INPUT_GAP: 检查时间无效");
  const protectedPlan = structuredClone(productionPlan);
  const inspection = await inspectPlatform(deepFreeze({
    mode: "read_only_preflight",
    targetPlatform: productionPlan.platform,
    expectedStore: productionPlan.store,
    requestedWriteFields: structuredClone(productionPlan.allowedWriteFields),
    imageUploadRequested: productionPlan.allowedWriteFields.includes("assets.finalUploads"),
    productCreationRequested: productionPlan.allowedWriteFields.includes("create_product"),
    inventoryWriteRequested: productionPlan.allowedWriteFields.includes("stock"),
    expectedPlatformWriteCurrency: productionPlan.platformWritePrice.currency,
    platformWriteRequested: false
  }));
  validateInspection(inspection);
  if (JSON.stringify(protectedPlan) !== JSON.stringify(productionPlan)) throw new Error("PLATFORM_PREFLIGHT_PLAN_MUTATED: 检查器修改了ProductionPlan");

  const platformWritableFields = [...new Set(inspection.platformWritableFields)];
  const effectiveWritableFields = productionPlan.allowedWriteFields.filter((field) => platformWritableFields.includes(field));
  const risks = structuredClone(inspection.risks);
  if (inspection.storeIdentityStatus !== "matched") risks.push({ code: "store_identity_not_verified", message: "店铺身份尚未验证一致" });
  const priceCurrencyMatched = inspection.priceFieldCurrency === productionPlan.platformWritePrice.currency;
  if (!priceCurrencyMatched) risks.push({ code: "platform_price_currency_mismatch", message: `授权写入币种${productionPlan.platformWritePrice.currency}与平台字段币种${inspection.priceFieldCurrency}不一致` });
  if (effectiveWritableFields.length !== productionPlan.allowedWriteFields.length) risks.push({ code: "write_scope_not_fully_available", message: "平台当前权限不能覆盖全部授权字段" });
  const technicalStatus = technicalStatusFor(inspection);
  if (technicalStatus !== "completed") risks.push({ code: `technical_${technicalStatus}`, message: "平台前置检查未完成，仅记录技术状态，不改变商品业务状态" });

  const preflight = {
    schemaVersion: PLATFORM_WRITE_PREFLIGHT_VERSION,
    preflightId: `platform-preflight:${productionPlan.planId}:${fingerprint({ checkedAt, inspection }).slice(0, 12)}`,
    sourceProductionPlanId: productionPlan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(productionPlan),
    targetPlatform: productionPlan.platform,
    storeIdentity: {
      expectedStore: productionPlan.store,
      observedStore: inspection.observedStore,
      status: inspection.storeIdentityStatus,
      evidenceRef: inspection.storeIdentityEvidenceRef
    },
    permission: {
      status: inspection.permissionStatus,
      evidenceRef: inspection.permissionEvidenceRef
    },
    connectionStatus: structuredClone(inspection.connections),
    authorizedWriteFields: structuredClone(productionPlan.allowedWriteFields),
    platformWritableFields,
    effectiveWritableFields,
    imagePermission: {
      status: inspection.imagePermissionStatus,
      evidenceRef: inspection.imagePermissionEvidenceRef
    },
    priceCurrency: {
      expected: productionPlan.platformWritePrice.currency,
      observed: inspection.priceFieldCurrency,
      status: priceCurrencyMatched ? "matched" : "mismatched",
      evidenceRef: inspection.priceCurrencyEvidenceRef
    },
    risks,
    technicalStatus,
    businessStateEffect: "none",
    checkedAt,
    readyForPlatformWrite: false,
    productCreated: false,
    imagesUploaded: 0,
    inventoryModified: false,
    storeDataModified: false,
    productionRecordCreated: false,
    platformWrites: 0
  };
  assertValidPlatformWritePreflight(preflight);
  return deepFreeze(preflight);
}
