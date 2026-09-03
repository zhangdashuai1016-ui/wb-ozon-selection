import { createProductionPlan } from "./production-plan.mjs";
import {
  beginDSoftwareExecution,
  markDSoftwareUnknownOutcome,
  prepareSingleSkuDExecution
} from "./d-e-software-closure.mjs";

export const D_E_SOFTWARE_INTEGRATION_VERSION = "d-e-software-integration-v1";
export const D_SOFTWARE_EXECUTION_STATE_VERSION = "d-software-execution-state-v1";

function gap(code, field, message) {
  return { code, field, message };
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function base(status, overrides = {}) {
  return freeze({
    schemaVersion: D_E_SOFTWARE_INTEGRATION_VERSION,
    available: true,
    status,
    platform: null,
    store: null,
    skuPackageId: null,
    productionPlanId: null,
    productionAuthorizationId: null,
    assetTransportStatus: "not_started",
    assetTransportEvidenceRef: null,
    assetTransportResolvedCount: 0,
    productionRecordId: null,
    eVerificationId: null,
    gaps: [],
    canPrepareExecution: false,
    canExecutePlatformWrite: false,
    requiresExactOwnerExecutionAuthorization: true,
    executionIntentPersisted: false,
    automaticRetry: false,
    browserFallback: false,
    codexDispatch: false,
    platformWrites: 0,
    ...overrides
  });
}

function requiredText(value, code) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${code}: 字段不能为空`);
  return value;
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 生成“必须先原子持久化、之后才允许调用Seller API”的单次D执行意图。
 * 本函数不写候选、不访问平台，也不执行Seller API。
 */
export function createPersistableDExecutionIntent({
  candidateId,
  candidateDataRevision,
  expectedCandidateRevision,
  preparedExecution,
  ownerExecutionDecision,
  startedAt
}) {
  requiredText(candidateId, "D_EXECUTION_CANDIDATE_REQUIRED");
  if (!Number.isInteger(candidateDataRevision) || !Number.isInteger(expectedCandidateRevision) ||
      candidateDataRevision !== expectedCandidateRevision) {
    throw new Error("D_EXECUTION_REVISION_CONFLICT: 候选修订号已变化");
  }
  if (!preparedExecution || preparedExecution.schemaVersion !== "d-software-execution-v1" ||
      preparedExecution.status !== "ready" || !preparedExecution.executableRequest) {
    throw new Error("D_EXECUTION_NOT_READY: 当前D请求尚未准备完成");
  }
  if (!ownerExecutionDecision || ownerExecutionDecision.confirmed !== true) {
    throw new Error("D_EXECUTION_OWNER_CONFIRMATION_REQUIRED: 缺少主人本轮精确执行确认");
  }

  const request = preparedExecution.executableRequest;
  const exactFields = [
    ["authorizationId", "sourceAuthorizationId"],
    ["productionPlanId", "sourceProductionPlanId"],
    ["store", "store"],
    ["skuPackageId", "skuPackageId"],
    ["supplierSkuId", "supplierSkuId"],
    ["publishScope", "publishScope"],
    ["assetsFinalUploadsVersion", "assetsFinalUploadsVersion"]
  ];
  for (const [decisionField, requestField] of exactFields) {
    if (String(ownerExecutionDecision[decisionField] ?? "") !== String(request[requestField] ?? "")) {
      throw new Error(`D_EXECUTION_OWNER_SCOPE_MISMATCH: ${decisionField}与授权执行请求不一致`);
    }
  }
  if (!exactJson(ownerExecutionDecision.platformWritePrice, request.platformWritePrice)) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 后台写入价格与授权执行请求不一致");
  }
  if (ownerExecutionDecision.stock !== 100 || request.stock !== 100) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 新品库存必须精确锁定为100");
  }
  const decisionAssetIds = ownerExecutionDecision.finalUploadAssetIds;
  const requestAssetIds = Array.isArray(request.finalUploads) ? request.finalUploads.map((asset) => asset.assetId) : [];
  if (!Array.isArray(decisionAssetIds) || !exactJson(decisionAssetIds, requestAssetIds)) {
    throw new Error("D_EXECUTION_OWNER_SCOPE_MISMATCH: 最终上传素材集合或顺序不一致");
  }

  const attempt = beginDSoftwareExecution({ preparedExecution, startedAt });
  return freeze({
    schemaVersion: D_SOFTWARE_EXECUTION_STATE_VERSION,
    candidateId,
    candidateDataRevision,
    authorizationId: request.sourceAuthorizationId,
    productionPlanId: request.sourceProductionPlanId,
    executionKey: attempt.executionKey,
    status: "in_flight",
    attempt,
    mustPersistBeforeSellerApi: true,
    canCallSellerApiBeforePersist: false,
    attemptLimit: 1,
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: 0
  });
}

/** 服务重启不能恢复或重放一次结果未知的写入，只能收口为unknown_outcome。 */
export function reconcilePersistedDExecutionOnRestart({ executionState, restartedAt }) {
  if (!executionState || executionState.schemaVersion !== D_SOFTWARE_EXECUTION_STATE_VERSION) {
    throw new Error("D_EXECUTION_STATE_INVALID: 持久化D执行状态无效");
  }
  if (executionState.status !== "in_flight") return executionState;
  const attempt = markDSoftwareUnknownOutcome({
    executionAttempt: executionState.attempt,
    reason: "service_restart_after_persist_before_terminal_receipt",
    markedAt: restartedAt
  });
  return freeze({
    ...structuredClone(executionState),
    status: "unknown_outcome",
    attempt,
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: 0
  });
}

/**
 * 4317 的第6C接缝只生成可见准备度。它不读取凭证、不访问平台、不持久化执行意图，
 * 更不会调用 Seller API。真正D执行必须由后续受控执行路由先原子保存单次intent。
 */
export function buildDESoftwareIntegrationView({ candidate, platformWritePreflight = null, adapterCapabilities = null, inspectedAt }) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!skuPackage) return base("not_applicable", { available: false, requiresExactOwnerExecutionAuthorization: false });

  const common = {
    platform: skuPackage.targetPlatform || null,
    store: skuPackage.targetStore || null,
    skuPackageId: skuPackage.skuPackageId || null,
    productionAuthorizationId: skuPackage.productionAuthorization?.authorizationId || null,
    productionRecordId: skuPackage.productionRecord?.productionRecordId || null,
    eVerificationId: skuPackage.eVerificationRecord?.verificationId || null
  };
  const dAssetTransport = skuPackage.dAssetTransport || null;
  const assetCommon = {
    assetTransportStatus: dAssetTransport?.status || "not_started",
    assetTransportEvidenceRef: dAssetTransport?.assetTransport?.evidenceRef || null,
    assetTransportResolvedCount: Array.isArray(dAssetTransport?.assetTransport?.resolvedAssets)
      ? dAssetTransport.assetTransport.resolvedAssets.length
      : 0
  };
  Object.assign(common, assetCommon);

  if (skuPackage.eVerificationRecord) {
    return base("listed_verified", { ...common, requiresExactOwnerExecutionAuthorization: false });
  }
  if (skuPackage.productionRecord) {
    return base("awaiting_e_readback", {
      ...common,
      gaps: [gap("e_readback_not_completed", "eVerificationRecord", "系统创建记录已存在，仍需独立E回读")],
      requiresExactOwnerExecutionAuthorization: false
    });
  }
  if (!skuPackage.productionAuthorization) {
    return base("awaiting_production_authorization", {
      ...common,
      gaps: [gap("production_authorization_missing", "productionAuthorization", "尚未取得主人精确生产授权")]
    });
  }

  let productionPlan;
  try {
    productionPlan = createProductionPlan({
      productionAuthorization: skuPackage.productionAuthorization,
      // ProductionPlan必须稳定绑定授权快照，不能因每次打开页面的时钟变化而漂移。
      createdAt: skuPackage.productionAuthorization.confirmedAt
    });
  } catch (error) {
    return base("authorization_not_runnable", {
      ...common,
      gaps: [gap("production_plan_not_ready", "productionAuthorization", error.message)]
    });
  }

  const planCommon = { ...common, productionPlanId: productionPlan.planId };
  const missing = [];
  if (dAssetTransport?.status === "unknown_outcome") {
    missing.push(gap("asset_transport_unknown_outcome", "dAssetTransport", "OSS素材传输结果未知，禁止自动重试；需要主人开启新的精确授权轮"));
  } else if (dAssetTransport?.status !== "verified") {
    missing.push(gap("asset_transport_not_ready", "dAssetTransport", "最终素材尚未取得已验证的OSS稳定HTTPS地址"));
  }
  if (!platformWritePreflight) missing.push(gap("platform_preflight_missing", "platformWritePreflight", "尚未完成当前店铺Seller API只读前检"));
  if (!adapterCapabilities) missing.push(gap("adapter_capabilities_missing", "adapterCapabilities", "尚未取得当前店铺、仓库、素材、库存与独立回读能力证据"));
  if (missing.length > 0) return base("not_ready", { ...planCommon, gaps: missing });

  let prepared;
  try {
    prepared = prepareSingleSkuDExecution({
      productionPlan,
      productionAuthorization: skuPackage.productionAuthorization,
      platformWritePreflight,
      adapterCapabilities,
      preparedAt: inspectedAt
    });
  } catch (error) {
    return base("not_ready", { ...planCommon, gaps: [gap("d_preparation_rejected", "dExecution", error.message)] });
  }
  if (prepared.status !== "ready") return base("not_ready", { ...planCommon, gaps: prepared.gaps });

  return base("ready_for_explicit_execution", {
    ...planCommon,
    canPrepareExecution: true,
    canExecutePlatformWrite: false
  });
}
