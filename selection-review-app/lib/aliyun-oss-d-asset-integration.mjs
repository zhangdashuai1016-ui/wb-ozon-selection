import { createHash } from "node:crypto";
import { uploadAliyunOssFinalAssets } from "./aliyun-oss-asset-transport.mjs";
import { createProductionPlan } from "./production-plan.mjs";

export const ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION = "aliyun-oss-d-asset-integration-v1";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function currentSku(candidate) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!skuPackage) throw new Error("OSS_D_SKU_PACKAGE_MISSING: 当前商品缺少新版SKU生命周期包");
  if (!skuPackage.productionAuthorization) throw new Error("OSS_D_AUTHORIZATION_MISSING: 尚未取得主人精确生产授权");
  if (skuPackage.productionRecord) throw new Error("OSS_D_ALREADY_PRODUCED: 当前SKU已有生产记录");
  return skuPackage;
}

/**
 * 生成必须先持久化的单次OSS素材传输意图。本函数不读取钥匙串、不上传文件。
 */
export function createPersistableAliyunOssAssetIntent({
  candidate,
  expectedDataRevision,
  ownerDecision,
  startedAt
}) {
  if (!candidate || !nonEmpty(candidate.id)) throw new Error("OSS_D_CANDIDATE_MISSING: 缺少候选");
  if (!Number.isInteger(expectedDataRevision) || Number(candidate.dataRevision) !== expectedDataRevision) {
    throw new Error("OSS_D_REVISION_CONFLICT: 商品资料已变化");
  }
  if (!isoDate(startedAt)) throw new Error("OSS_D_TIME_INVALID: 启动时间无效");
  const skuPackage = currentSku(candidate);
  const authorization = skuPackage.productionAuthorization;
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: authorization.confirmedAt });
  if (plan.platform !== "ozon") throw new Error("OSS_D_PLATFORM_UNSUPPORTED: 当前素材通道只接入Ozon D阶段");
  if (!ownerDecision || ownerDecision.confirmed !== true || ownerDecision.confirmedBy !== "owner") {
    throw new Error("OSS_D_OWNER_CONFIRMATION_REQUIRED: 缺少主人本轮精确素材传输确认");
  }
  if (ownerDecision.authorizationId !== authorization.authorizationId || ownerDecision.skuPackageId !== skuPackage.skuPackageId) {
    throw new Error("OSS_D_SCOPE_MISMATCH: 授权或SKU不一致");
  }
  const expectedAssetIds = plan.finalUploads.map((asset) => asset.assetId);
  if (JSON.stringify(ownerDecision.finalUploadAssetIds) !== JSON.stringify(expectedAssetIds)) {
    throw new Error("OSS_D_SCOPE_MISMATCH: 最终素材集合或顺序不一致");
  }
  const intentCore = {
    candidateId: candidate.id,
    candidateDataRevision: expectedDataRevision,
    skuPackageId: skuPackage.skuPackageId,
    authorizationId: authorization.authorizationId,
    authorizationFingerprint: plan.sourceAuthorizationFingerprint,
    productionPlanId: plan.planId,
    assetsFinalUploadsVersion: plan.assetsFinalUploadsVersion,
    finalUploadAssetIds: expectedAssetIds,
    startedAt
  };
  return freeze({
    schemaVersion: ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION,
    intentId: `oss-asset-intent:${digest(intentCore)}`,
    ...intentCore,
    status: "awaiting_persistence",
    attempt: 1,
    attemptLimit: 1,
    mustPersistBeforeUpload: true,
    persistedAt: null,
    automaticRetry: false,
    retryAllowed: false,
    ossWrites: 0,
    platformWrites: 0
  });
}

export function markAliyunOssAssetIntentPersisted({ intent, persistedAt, persistedCandidateRevision = intent?.candidateDataRevision }) {
  if (!intent || intent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION || intent.status !== "awaiting_persistence") {
    throw new Error("OSS_D_INTENT_INVALID: 素材传输意图无效");
  }
  if (!isoDate(persistedAt)) throw new Error("OSS_D_TIME_INVALID: 持久化时间无效");
  if (!Number.isInteger(persistedCandidateRevision) || persistedCandidateRevision < intent.candidateDataRevision) {
    throw new Error("OSS_D_REVISION_CONFLICT: 持久化后的候选修订号无效");
  }
  return freeze({ ...structuredClone(intent), status: "in_flight", persistedAt, persistedCandidateRevision });
}

/**
 * 只在意图已经持久化后执行一次OSS上传。任何失败均按结果未知停止，不自动重试。
 */
export async function executeAliyunOssAssetIntent({
  persistedIntent,
  candidate,
  upload = uploadAliyunOssFinalAssets,
  completedAt
}) {
  if (!persistedIntent || persistedIntent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION ||
      persistedIntent.status !== "in_flight" || !isoDate(persistedIntent.persistedAt)) {
    throw new Error("OSS_D_INTENT_NOT_PERSISTED: OSS写入前必须先持久化单次意图");
  }
  if (!isoDate(completedAt)) throw new Error("OSS_D_TIME_INVALID: 完成时间无效");
  const skuPackage = currentSku(candidate);
  const authorization = skuPackage.productionAuthorization;
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: authorization.confirmedAt });
  const bindings = [
    [candidate.id, persistedIntent.candidateId],
    [Number(candidate.dataRevision), persistedIntent.persistedCandidateRevision],
    [skuPackage.skuPackageId, persistedIntent.skuPackageId],
    [authorization.authorizationId, persistedIntent.authorizationId],
    [plan.sourceAuthorizationFingerprint, persistedIntent.authorizationFingerprint],
    [plan.planId, persistedIntent.productionPlanId],
    [plan.assetsFinalUploadsVersion, persistedIntent.assetsFinalUploadsVersion]
  ];
  if (bindings.some(([actual, expected]) => actual !== expected) ||
      JSON.stringify(plan.finalUploads.map((asset) => asset.assetId)) !== JSON.stringify(persistedIntent.finalUploadAssetIds)) {
    throw new Error("OSS_D_BINDING_DRIFT: 持久化后商品、授权或素材发生变化");
  }

  try {
    const assetTransport = await upload({
      candidateId: candidate.id,
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: candidate.dataRevision,
      finalUploads: plan.finalUploads
    });
    if (assetTransport?.status !== "verified" || assetTransport?.mode !== "preapproved_stable_https" ||
        !nonEmpty(assetTransport.evidenceRef) || assetTransport.resolvedAssets?.length !== plan.finalUploads.length) {
      throw new Error("OSS_D_RECEIPT_INVALID: OSS素材回执不完整");
    }
    return freeze({
      status: "verified",
      intent: { ...structuredClone(persistedIntent), status: "completed", completedAt, ossWrites: assetTransport.resolvedAssets.length },
      assetTransport: structuredClone(assetTransport),
      retryAllowed: false,
      automaticRetry: false,
      platformWrites: 0
    });
  } catch (error) {
    return freeze({
      status: "unknown_outcome",
      intent: {
        ...structuredClone(persistedIntent),
        status: "unknown_outcome",
        completedAt,
        failureLayer: "aliyun_oss_asset_transport",
        failureCode: nonEmpty(error?.message) ? String(error.message).split(":", 1)[0] : "OSS_D_UPLOAD_FAILED",
        ossWrites: "unknown"
      },
      assetTransport: null,
      retryAllowed: false,
      automaticRetry: false,
      platformWrites: 0
    });
  }
}

export function reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent, restartedAt }) {
  if (!persistedIntent || persistedIntent.schemaVersion !== ALIYUN_OSS_D_ASSET_INTEGRATION_VERSION) {
    throw new Error("OSS_D_INTENT_INVALID: 素材传输意图无效");
  }
  if (!isoDate(restartedAt)) throw new Error("OSS_D_TIME_INVALID: 重启收口时间无效");
  if (persistedIntent.status !== "in_flight") return persistedIntent;
  return freeze({
    ...structuredClone(persistedIntent),
    status: "unknown_outcome",
    completedAt: restartedAt,
    failureLayer: "selection_review_service_restart",
    failureCode: "OSS_D_RESTART_UNKNOWN_OUTCOME",
    ossWrites: "unknown",
    automaticRetry: false,
    retryAllowed: false,
    platformWrites: 0
  });
}
