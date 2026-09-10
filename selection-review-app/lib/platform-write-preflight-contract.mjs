import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { isOzonProductionConnectionRequirements } from "./ozon-production-strategy.mjs";
export const PLATFORM_WRITE_PREFLIGHT_VERSION = "platform-write-preflight-v1.2";
export const LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION = "platform-write-preflight-v1.1";
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

function push(errors, path, message) {
  errors.push({ path, message });
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

export function platformWritePreflightTechnicalStatus(inspection, requiredConnections) {
  const statuses = requiredConnections.map(name => inspection.connections[name].status);
  if (inspection.permissionStatus === "permission_required" || inspection.imagePermissionStatus === "permission_required" || statuses.includes("permission_required")) return "permission_required";
  if (statuses.includes("system_error") || statuses.includes("unavailable")) return "system_error";
  if (statuses.includes("unknown") || inspection.permissionStatus === "unknown" || inspection.storeIdentityStatus === "unverified") return "data_unavailable";
  return "completed";
}

export function validatePlatformWritePreflight(preflight) {
  const errors = [];
  if (!isObject(preflight)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (![PLATFORM_WRITE_PREFLIGHT_VERSION, LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION].includes(preflight.schemaVersion)) push(errors, "schemaVersion", "前检版本无效");
  if (preflight.schemaVersion === PLATFORM_WRITE_PREFLIGHT_VERSION &&
      (preflight.targetPlatform !== "ozon" || !isOzonProductionConnectionRequirements(preflight.connectionRequirements))) {
    push(errors, "connectionRequirements", "必须保存当前正式API路线及完整连接合同");
  }
  if (preflight.schemaVersion === LEGACY_PLATFORM_WRITE_PREFLIGHT_VERSION && Object.hasOwn(preflight, "connectionRequirements")) {
    push(errors, "connectionRequirements", "旧版前检不得附加新路线解释");
  }
  for (const field of ["preflightId", "sourceProductionPlanId", "sourceProductionPlanFingerprint", "targetPlatform", "checkedAt"]) {
    if (!nonEmptyString(preflight[field])) push(errors, field, "必须是非空字符串");
  }
  if (!isoDateTime(preflight.checkedAt)) push(errors, "checkedAt", "必须是有效时间");
  if (!isObject(preflight.storeIdentity) || !nonEmptyString(preflight.storeIdentity.expectedStore) || !nonEmptyString(preflight.storeIdentity.observedStore) || !["matched", "mismatched", "unverified"].includes(preflight.storeIdentity.status) || !nonEmptyString(preflight.storeIdentity.evidenceRef)) {
    push(errors, "storeIdentity", "必须保存预期店铺、观察店铺、匹配状态和证据");
  }
  const identity = preflight.storeIdentity;
  if (!isCompleteStoreRef(identity?.expectedStoreRef, identity?.expectedStore) ||
      !(identity.observedStoreRef === null || isCompleteStoreRef(identity.observedStoreRef, identity.observedStore))) push(errors, "storeIdentity", "必须保存完整预期店铺引用和已观察引用或明确未验证");
  if (identity?.status === "matched" && (identity.expectedStore !== identity.observedStore || !sameStoreRef(identity.expectedStoreRef, identity.observedStoreRef))) push(errors, "storeIdentity.status", "同名店铺不能替代完整店铺身份匹配");
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
  if (preflight.schemaVersion === PLATFORM_WRITE_PREFLIGHT_VERSION && errors.length === 0 &&
      preflight.technicalStatus !== platformWritePreflightTechnicalStatus({ connections: preflight.connectionStatus,
        permissionStatus: preflight.permission.status, imagePermissionStatus: preflight.imagePermission.status,
        storeIdentityStatus: preflight.storeIdentity.status }, preflight.connectionRequirements.requiredConnections)) {
    push(errors, "technicalStatus", "技术状态必须来自当前路线实际必需连接与检查结果");
  }
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

/** Historical records remain readable, but cannot authorize a current execution. */
export function assertCurrentPlatformWritePreflight(preflight) {
  assertValidPlatformWritePreflight(preflight);
  if (preflight.schemaVersion !== PLATFORM_WRITE_PREFLIGHT_VERSION) throw new Error("PLATFORM_PREFLIGHT_VERSION_OUTDATED: 当前执行需要新版前检");
  return preflight;
}
