import { C1SkuRightsReviewError, C1_SKU_RIGHTS_REVIEW_FAILURE_CODES } from "./c1-sku-rights-review.mjs";
import { isCanonicalFrozenRef } from "./production-contract-primitives.mjs";

export const D_READBACK_MISMATCH_CODES = Object.freeze([
  "observation", "platform", "store", "skuPackageId", "merchantSku", "supplierSkuId", "executionBinding",
  "platformProductId", "currentPrice", "currentStock", "imageCount", "platformStatus", "platformEvidence",
  "readback_expectation_missing_or_invalid", "media_identity_unverified", "media_duplicate", "media_manifest_mismatch",
  "main_image_mismatch", "media_order_or_set_mismatch", "warehouse_identity_or_quantity_unverified", "warehouse_stock_mismatch"
]);
const D_READBACK_MISMATCH_PREFIX = "write_readback_mismatch:";
const mismatchCodes = new Set(D_READBACK_MISMATCH_CODES);
const maximumMismatchReasonLength = D_READBACK_MISMATCH_PREFIX.length + D_READBACK_MISMATCH_CODES.join(",").length;

/** A domain diagnostic may contain several bounded codes; it is not a persisted entity reference. */
export function isDProductionUnknownReason(value) {
  if (typeof value !== "string") return false;
  if (!value.startsWith(D_READBACK_MISMATCH_PREFIX)) return isCanonicalFrozenRef(value);
  if (value.length > maximumMismatchReasonLength) return false;
  const codes = value.slice(D_READBACK_MISMATCH_PREFIX.length).split(",");
  return codes.length <= mismatchCodes.size && new Set(codes).size === codes.length && codes.every(code => mismatchCodes.has(code));
}

export function formatDReadbackMismatchReason(codes) {
  if (!Array.isArray(codes) || !codes.every(code => mismatchCodes.has(code))) throw new TypeError("D_READBACK_MISMATCH_CODES_INVALID");
  const reason = `${D_READBACK_MISMATCH_PREFIX}${[...new Set(codes)].join(",")}`;
  if (!isDProductionUnknownReason(reason)) throw new TypeError("D_READBACK_MISMATCH_CODES_INVALID");
  return reason;
}

export const OSS_LOCAL_PREPARATION_FAILURE_CODES = Object.freeze([
  "OSS_LOCAL_ASSET_UNAVAILABLE", "OSS_CREDENTIAL_UNAVAILABLE", "OSS_LOCAL_ASSET_INVALID"
]);

export class AliyunOssLocalPreparationError extends Error {
  constructor(code) {
    if (!OSS_LOCAL_PREPARATION_FAILURE_CODES.includes(code)) throw new TypeError("OSS_LOCAL_PREPARATION_ERROR_INVALID");
    super(code); this.name = "AliyunOssLocalPreparationError"; this.code = code;
  }
}

const isProgramError = error => [TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError].some(type => error instanceof type);

export const PRODUCTION_EXECUTION_BINDING_FAILURE_CODES = Object.freeze([
  "PRODUCTION_EXECUTION_BINDING_REQUIRED", "PRODUCTION_EXECUTION_BINDING_TIME_INVALID", "PRODUCTION_EXECUTION_BINDING_DRIFT",
  "PRODUCTION_EXECUTION_BINDING_UNVERIFIED", "PRODUCTION_BINDINGS_INVALID", "STORE_BINDINGS_INVALID"
]);

export function productionExecutionPrewriteFailure(error) {
  if (isProgramError(error)) return null;
  const code = error?.code || String(error?.message).split(":", 1)[0];
  if (PRODUCTION_EXECUTION_BINDING_FAILURE_CODES.includes(code)) return { layer: "production_configuration", code };
  if (error instanceof C1SkuRightsReviewError && C1_SKU_RIGHTS_REVIEW_FAILURE_CODES.includes(code)) return { layer: "sku_rights_review", code };
  if (["D_EXECUTION_CONTEXT_REQUIRED", "D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH", "PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED"].includes(code)) {
    return { layer: "production_authorization", code };
  }
  if (error instanceof Error && (error.message.startsWith("ProductionAuthorization校验失败：") || error.message.startsWith("ProductionPlan校验失败："))) {
    return { layer: "production_authorization", code: "D_EXECUTION_AUTHORIZATION_INVALID" };
  }
  return null;
}

export function isProductionExecutionPrewriteFailure({ layer, code }) {
  return layer === "production_configuration" && PRODUCTION_EXECUTION_BINDING_FAILURE_CODES.includes(code) ||
    layer === "sku_rights_review" && C1_SKU_RIGHTS_REVIEW_FAILURE_CODES.includes(code);
}

export function productionJobPrewriteCode(error) {
  if (isProgramError(error)) return null;
  const prewrite = productionExecutionPrewriteFailure(error);
  if (prewrite) return prewrite.code;
  const code = error?.code || String(error?.message).split(":", 1)[0];
  return /^(?:SOFTWARE_JOB_ADMISSION_DE_[A-Z_]+|SOFTWARE_JOB_LEASE_REJECTED|SOFTWARE_JOB_REVISION_CONFLICT|SOFTWARE_JOB_SKU_CONFLICT|WORKER_REGISTRY_WORKER_NOT_CURRENT|D_JOB_CURSOR_[A-Z_]+|DE_JOB_SCOPE_[A-Z_]+|D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT)$/.test(code)
    ? code : null;
}

export function isDProductionPrewriteFailure(failure) {
  return failure !== null && typeof failure === "object" && (
    isProductionExecutionPrewriteFailure(failure) ||
    failure.layer === "production_authorization" && ["D_EXECUTION_CONTEXT_REQUIRED", "D_EXECUTION_AUTHORIZATION_SCOPE_MISMATCH",
      "PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED", "D_EXECUTION_AUTHORIZATION_INVALID"].includes(failure.code) ||
    failure.layer === "production_admission" && (failure.code === "candidate_changed_during_production" || productionJobPrewriteCode({ code: failure.code }) !== null) ||
    failure.layer === "seller_api" && failure.code === "adapter_request_invalid");
}

export function assetTransportPrewriteFailure(error) {
  if (error instanceof AliyunOssLocalPreparationError && OSS_LOCAL_PREPARATION_FAILURE_CODES.includes(error.code)) {
    return { layer: "asset_preparation", code: error.code };
  }
  const existing = productionExecutionPrewriteFailure(error);
  if (existing) return existing;
  const code = productionJobPrewriteCode(error);
  return code === null ? null : { layer: "production_admission", code };
}

export function isAssetTransportPrewriteFailure(failure) {
  return isDProductionPrewriteFailure(failure) && failure.layer !== "seller_api" ||
    failure?.layer === "asset_preparation" && OSS_LOCAL_PREPARATION_FAILURE_CODES.includes(failure.code);
}
