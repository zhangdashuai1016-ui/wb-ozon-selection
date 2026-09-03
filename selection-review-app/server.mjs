import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PACKAGING_COST_RMB,
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  NO_PROGRESS_TIMEOUT_MINUTES,
  DEFAULT_RULES,
  WORKFLOW_STATUSES,
  promotionPricingGate,
  approvalGate,
  profitReviewGate,
  codexAutoEliminationGate,
  businessDate,
  claimEligible,
  dailySummary,
  dispatchQueueSummary,
  filterUserNeededFields,
  processingStatusSummary,
  isActualProcessingRun,
  recordProcessingProgress,
  registerProcessingAttempt,
  recentAvoidanceFeedback,
  requiredInputFields,
  selectionStage,
  purchaseCeilingSummary,
  queueUserDispatch,
  sortDispatchQueue,
  stopNoProgressRuns,
  technicalFailureDisposition,
  validateListingRecord,
  validateListingReadback,
  wbAssessmentDecisionGate
} from "./lib/workflow.mjs";
import {
  ACTIVE_DISPATCH_STATES,
  RECOVERABLE_TERMINAL_DISPATCH_STATES,
  activeDispatchForCandidate,
  candidateActiveNode,
  collaborationSummary,
  dispatchDeliveryGroups,
  dispatchOwnerForNode,
  ensureCollaborationData,
  isDisabledLegacyCDispatch,
  latestDispatchForCandidate,
  readWorkflowMap,
  validateNodeExecution,
  workflowMapView
} from "./lib/workflow-map.mjs";
import {
  CodexDispatcher,
  dispatchCandidateSnapshot,
  dispatchCapabilityPlan,
  requiredSkillsForDispatch
} from "./lib/codex-dispatcher.mjs";
import {
  extract1688OfferId,
  normalize1688CaptureSource,
  resolveCapturedSku,
  resolveCapturedSkus,
  sanitize1688Evidence,
  sanitizeSourceCaptureFailureResult,
  sourceCaptureFailureDestinationLabel,
  sourceCaptureFailureMessage
} from "./lib/source-capture.mjs";
import {
  ozonCaptureFailureMessage,
  sanitizeOzonCaptureEvidence
} from "./lib/ozon-sales-capture.mjs";
import { adaptLegacyCandidateToOpportunity } from "./lib/legacy-candidate-adapter.mjs";
import { buildRealLifecycleEntryPreview } from "./lib/real-lifecycle-entry-preview.mjs";
import { buildRealAConfirmationCard } from "./lib/real-a-confirmation-card.mjs";
import {
  AStageTerraGatewayError,
  runAStageTerraAssist
} from "./lib/a-stage-terra-gateway.mjs";
import { applyLifecycleBEvidenceContext } from "./lib/lifecycle-b-evidence-context.mjs";
import { runRealAConfirmationWithSystemEvidence } from "./lib/real-a-b-evidence-orchestration.mjs";
import {
  inspectLifecycleBInputReadiness,
  validateLifecycleEvidenceData
} from "./lib/lifecycle-b-input-bundle.mjs";
import {
  buildLifecycleBEvidencePreparationPlan,
  runLifecycleBEvidencePreparation
} from "./lib/lifecycle-b-evidence-preparation.mjs";
import { createLifecycleBRealEvidenceProviderRegistry } from "./lib/lifecycle-b-real-evidence-readers.mjs";
import {
  buildLifecycleBExplicitOtherCosts,
  commitLifecycleBEvidencePacks
} from "./lib/lifecycle-b-evidence-runtime.mjs";
import {
  finalizeReal13CForOwnerCard as finalizeLegacyFireTrain13CForOwnerCard,
  prepareRealC1ForFinalAssets as prepareLegacyFireTrainC1ForFinalAssets
} from "./lib/real-c1-preparation.mjs";
import { completeC1AndStartC2 } from "./lib/lifecycle-c-stage.mjs";
import { runC1SoftwareOrchestration } from "./lib/c1-software-orchestrator.mjs";
import { resolveC1K3RuntimeEvidence } from "./lib/c1-k3-runtime-bridge.mjs";
import { prepareC1FactKeywordRuntime } from "./lib/c1-fact-keyword-runtime.mjs";
import { buildC1FactKeywordAtomicPatch } from "./lib/c1-fact-keyword-persistence.mjs";
import { acceptC1KeywordEvidenceReadyEvent } from "./lib/c1-keyword-evidence-auto-trigger.mjs";
import {
  buildC1KeywordSoftwareJobPlan
} from "./lib/c1-keyword-software-job-planner.mjs";
import {
  enqueueC1PaidKeywordEvidenceJob,
  reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument
} from "./lib/c1-keyword-software-use-case.mjs";
import { runC1KeywordPlanningEvidenceProduction } from "./lib/c1-keyword-planning-software-use-case.mjs";
import {
  inspectSeerfarRuntimeConfiguration
} from "./lib/seerfar-runtime-connector.mjs";
import {
  confirmC2SoftwareFinalUploads,
  createC2SoftwareContainer,
  prepareC2FinalUploadManifest
} from "./lib/c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "./lib/final-product-plan-confirmation-card.mjs";
import { createConfiguredBusinessStateRepository } from "./lib/business-state-repository.mjs";
import { createSelectionReviewRuntimeConfiguration } from "./lib/runtime-configuration.mjs";
import {
  assertTrustedApiRequest,
  isTrustedInternalApiRequest,
  normalizeHttpErrorResponse,
  parseHttpRequestTarget,
  readJsonRequestBody
} from "./lib/http-api-boundary.mjs";
import {
  normalizeCandidateCodexCreateInput,
  normalizeCandidateUserCreateInput,
  normalizeCandidateUserPatchInput
} from "./lib/candidate-user-fields.mjs";
import { normalizeCandidateCommentInput } from "./lib/candidate-comment-boundary.mjs";
import {
  listingPreparationCStageFields,
  listingPreparationInheritedFields,
  normalizeListingPreparationReviewInput
} from "./lib/listing-preparation-review-boundary.mjs";
import { createDevelopmentIdentityProvider } from "./lib/runtime-identity-provider.mjs";
import { createActorContext } from "./lib/runtime-identity.mjs";
import { createRepositoryBackedSoftwareJobStore } from "./lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "./lib/worker-registry.mjs";
import { assertRuntimeBoundaries } from "./lib/multi-user-central-runtime.mjs";
import { commitProductionAuthorizationHandoff } from "./lib/production-authorization.mjs";
import { assertValidLifecyclePackage } from "./lib/product-lifecycle-schema.mjs";
import {
  createExternalListingRecord,
  verifyExternalListing,
  verifySystemCreatedListing
} from "./lib/e-stage-readback.mjs";
import {
  phase2ADemoCard,
  phase2AResultSummary,
  runPhase2AConfirmation
} from "./lib/phase-2a-simulation.mjs";
import {
  blockExecutionForTechnicalFailure,
  buildExecutionRuntimeView,
  codexDispatchGate,
  completeExecutionStep,
  createSoftwareExecutionRuntime,
  openExceptionCase,
  recordExceptionMaintenanceStarted,
  startSoftwareStep,
  startThirdPartyAiStep,
  simulateNormalSoftwarePath,
  waitForOwner
} from "./lib/software-execution-state.mjs";
import {
  EXCEPTION_MAINTENANCE_PATH,
  NORMAL_PRODUCTION_PATH,
  assertRuntimeCodexDependencyAllowed,
  codexOfflineModeFromEnvironment
} from "./lib/codex-independence.mjs";
import { buildThreeStoreMapView } from "./lib/three-store-map.mjs";
import { buildDESoftwareIntegrationView } from "./lib/d-e-software-integration.mjs";
import {
  createPersistableAliyunOssAssetIntent,
  executeAliyunOssAssetIntent,
  markAliyunOssAssetIntentPersisted,
  reconcileAliyunOssAssetIntentAfterRestart
} from "./lib/aliyun-oss-d-asset-integration.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfiguration = createSelectionReviewRuntimeConfiguration({ env: process.env, appDir, argv: process.argv });
const dataFile = runtimeConfiguration.dataFile;
const workflowMapFile = runtimeConfiguration.workflowMapFile;
const imagesDir = path.join(appDir, "product-images");
const c2FinalUploadsDir = runtimeConfiguration.c2FinalUploadsDir;
const distDir = path.join(appDir, "dist");
const apiOnly = runtimeConfiguration.apiOnly;
const port = runtimeConfiguration.port;
const host = runtimeConfiguration.bindHost;
const automationConcurrencyLimit = Math.min(
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  Math.max(1, Number(process.env.SELECTION_REVIEW_CONCURRENCY_LIMIT || DEFAULT_AUTOMATION_CONCURRENCY_LIMIT))
);
const codexOfflineEnabled = codexOfflineModeFromEnvironment(process.env);
const explicitDispatchDeliveryEnabled = !codexOfflineEnabled && ["on", "true"].includes(
  String(process.env.SELECTION_REVIEW_AUTO_DELIVER || "").trim().toLowerCase()
);
const aiGatewayUrl = runtimeConfiguration.aiGatewayUrl;
const aiGatewayDeploymentMode = runtimeConfiguration.deploymentMode;
const allowedReviewOrigins = new Set(runtimeConfiguration.allowedOrigins);
const trustedServiceOrigins = new Set([
  runtimeConfiguration.publicOrigin,
  localHttpOrigin(host, port)
]);
const allowedExtensionOrigins = new Set(runtimeConfiguration.allowedExtensionOrigins);
const internalApiRequestToken = randomBytes(32).toString("base64url");
const businessStateRepository = createConfiguredBusinessStateRepository(runtimeConfiguration);
const runtimeIdentityProvider = createDevelopmentIdentityProvider({
  userId: runtimeConfiguration.defaultUserId,
  clock: () => new Date().toISOString()
});
const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => new Date().toISOString() });
const softwareJobStore = createRepositoryBackedSoftwareJobStore({
  businessStateRepository,
  serverClock: () => new Date().toISOString(),
  workerRegistry
});
const runtimeArchitecture = assertRuntimeBoundaries({
  configuration: runtimeConfiguration,
  businessStateRepository,
  identityProvider: runtimeIdentityProvider,
  softwareJobStore,
  workerRegistry,
  legacyBusinessMutationPathsPresent: true
});
// Historical fire-train adapters are retained for audit/unit tests only.
// They must never be re-enabled from the production review-app runtime.
const legacyFireTrainAdapterEnabled = false;
const legacyManualC1InputEnabled = process.env.SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT === "true";
const seerfarSoftwareExecutionEnabled = false;
const c1PaidKeywordGenericQueueEnabled = true;

const USER_FIELDS = [
  "targetStore",
  "productUrl",
  "productName",
  "sourceUrl",
  "competitorUrl",
  "purchasePriceRmb",
  "packagingCostRmb",
  "moq",
  "netWeightKg",
  "packedWeightKg",
  "dimensionsCm",
  "materialsAndAge",
  "powered",
  "complianceStatus",
  "authorizationStatus",
  "expectedPriceRub",
  "sellerRevenueCny",
  "imageUrl",
  "notes",
  "acceptedTestRisk"
];

const RECOVERY_POLICY_VERSION = "system-owned-recovery-v1-2026-08-11";
const RECOVERY_ACTION_LABELS = {
  allow_estimated_commission: "允许本SKU使用估算佣金并继续",
  retry_current_stage_once: "重试当前阶段一次",
  keep_stopped: "保持停止，等待精确证据"
};

const DEFAULTED_USER_FIELDS = new Set([
  "domesticShippingRmb",
  "packagingCostRmb",
  "complianceStatus",
  "authorizationStatus"
]);

const sourceCaptureSessions = new Map();
const salesCaptureSessions = new Map();
const sourceCaptureJobTimers = new Map();
const dispatchDeliveriesInFlight = new Set();
const SOURCE_CAPTURE_TTL_MS = 3 * 60 * 1000;
const SOURCE_CAPTURE_JOB_QUEUE_TTL_MS = Math.max(50, Number(process.env.SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS || 2 * 60 * 1000));
const SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS = Math.max(50, Number(process.env.SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS || 60 * 1000));
const REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION = "1.2.7";
const EXTENSION_HEARTBEAT_TTL_MS = 75 * 1000;
let latestExtensionHeartbeat = null;
let sourceCaptureJobClaimQueue = Promise.resolve();

function extensionHeartbeatSnapshot(timestamp = Date.now()) {
  if (!latestExtensionHeartbeat) {
    return {
      status: "not_seen",
      fresh: false,
      version: "",
      backgroundReady: false,
      observedAt: null,
      receivedAt: null,
      expiresAt: null
    };
  }
  const fresh = latestExtensionHeartbeat.receivedAtMs + EXTENSION_HEARTBEAT_TTL_MS > timestamp;
  return {
    status: fresh
      ? latestExtensionHeartbeat.backgroundReady ? "connected" : "background_unavailable"
      : "stale",
    fresh,
    version: latestExtensionHeartbeat.version,
    backgroundReady: latestExtensionHeartbeat.backgroundReady,
    observedAt: latestExtensionHeartbeat.observedAt,
    receivedAt: new Date(latestExtensionHeartbeat.receivedAtMs).toISOString(),
    expiresAt: new Date(latestExtensionHeartbeat.receivedAtMs + EXTENSION_HEARTBEAT_TTL_MS).toISOString()
  };
}

function purgeExpiredCaptureSessions(timestamp = Date.now()) {
  for (const sessions of [sourceCaptureSessions, salesCaptureSessions]) {
    for (const [id, session] of sessions.entries()) {
      if (session.mode === "a_supplier_capture" && session.jobStatus) continue;
      if (session.expiresAt <= timestamp || session.consumedAt) sessions.delete(id);
    }
  }
}

function captureControlSnapshot(timestamp = Date.now()) {
  purgeExpiredCaptureSessions(timestamp);
  const active = [
    ...[...sourceCaptureSessions.values()].map((session) => ({ ...session, platform: "1688", captureKind: "supplier" })),
    ...[...salesCaptureSessions.values()].map((session) => ({ ...session, platform: "ozon", captureKind: "sales" }))
  ].sort((left, right) => left.createdAt - right.createdAt)[0];
  if (!active) {
    return {
      status: "idle",
      label: "商品采集控制空闲",
      candidateId: null,
      captureId: null,
      platform: null,
      captureKind: null,
      startedAt: null,
      expiresAt: null
    };
  }
  return {
    status: "busy",
    label: `正在采集 ${active.candidateId}（${active.platform}）`,
    candidateId: active.candidateId,
    captureId: active.captureId,
    platform: active.platform,
    captureKind: active.captureKind,
    startedAt: new Date(active.createdAt).toISOString(),
    expiresAt: new Date(active.expiresAt).toISOString()
  };
}

function ensureCaptureControlAvailable(candidateId) {
  const control = captureControlSnapshot();
  if (control.status !== "busy") return;
  throw httpError(409, `商品采集控制正由 ${control.candidateId} 使用；本次没有启动，也不会排队或自动重试`, {
    captureControl: control
  });
}

function currentProfitRule(persisted, current) {
  return {
    ...current,
    ...(persisted || {}),
    pricingPolicyVersion: current.pricingPolicyVersion,
    advertisingReserveRate: 0,
    advertisingReserveScenarios: undefined,
    decisionAdvertisingScenario: undefined,
    stressAdvertisingScenario: undefined,
    promotionDiscountScenarios: current.promotionDiscountScenarios,
    decisionPromotionScenario: current.decisionPromotionScenario,
    targetMarginRate: current.targetMarginRate,
    minimumUnitProfitRmb: current.minimumUnitProfitRmb,
    priceRoundRmb: current.priceRoundRmb,
    labelCostRmb: current.labelCostRmb,
    damageLossReserveRate: current.damageLossReserveRate,
    withdrawalFeeRate: current.withdrawalFeeRate,
    thresholdPolicy: "either",
    note: current.note
  };
}

function candidateProfitRule(candidate, rules) {
  if (candidate.targetStore === "miska") return rules.ozonMiska;
  if (candidate.targetStore === "wb") return rules.wbCrossListing;
  return rules.ozonDandanshu;
}

function now() {
  return new Date().toISOString();
}

function fixedRecoveryDecision(kind, summary, actions) {
  return {
    kind,
    summary: String(summary || "").trim(),
    actions: actions.map((id) => ({ id, label: RECOVERY_ACTION_LABELS[id] })),
    policyVersion: RECOVERY_POLICY_VERSION
  };
}

function recoveryText(candidate, dispatch) {
  return [
    candidate.processing?.blockReason,
    candidate.processing?.lastError,
    dispatch?.agentReply,
    dispatch?.error
  ].filter(Boolean).join("\n");
}

function classifyStoppedCandidate(candidate, dispatch) {
  const missing = requiredInputFields(candidate);
  if (missing.length) {
    return {
      kind: "needs_data",
      missing,
      summary: `缺少可填写的B阶段资料：${missing.map((item) => item.label).join("、")}`
    };
  }
  const text = recoveryText(candidate, dispatch);
  if (
    dispatch?.status === "needs_decision" &&
    /估算佣金|佣金.*授权|允许.*佣金/.test(text) &&
    candidate.acceptedEstimatedCommission !== true
  ) {
    return {
      kind: "business_decision",
      summary: "当前精确佣金尚未取得，需要决定是否允许本SKU使用清楚标注的估算佣金。"
    };
  }
  const systemOwned =
    dispatch?.nodeId === "M12" ||
    dispatch?.failureLayer === "missing_business_readback" ||
    (dispatch?.failureLayer === "codex_app_server" && /active writer|正在处理|busy/i.test(text)) ||
    candidate.processing?.dispatchState === "normalized" ||
    /当前派发节点是M04|只做C阶段|项目长期规则也要求C阶段|评审台本地服务.*无法连接|无法调用.*complete/.test(text) ||
    (!dispatch && /1688|Chrome|浏览器/.test(text));
  if (systemOwned || !dispatch) {
    return {
      kind: "system_recovery",
      summary: "系统旧路由、回传或阶段状态有误；按当前B阶段规则自动纠正并继续。"
    };
  }
  return {
    kind: "external_failure",
    summary: text || "当前阶段发生一次真实技术失败，已停止自动重试。"
  };
}

function json(res, status, responseBody, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(responseBody));
}

async function requestBody(req) {
  return readJsonRequestBody(req, { maxBytes: 2_000_000, requireJsonContentType: true });
}

async function requestBinaryBody(req, maxBytes = 100 * 1024 * 1024) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw httpError(413, "最终素材文件过大");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw httpError(413, "最终素材文件过大");
    chunks.push(chunk);
  }
  if (bytes === 0) throw httpError(400, "最终素材文件为空");
  return Buffer.concat(chunks, bytes);
}

const C2_UPLOAD_EXTENSIONS = Object.freeze({
  ".jpg": { mediaType: "image", contentTypes: ["image/jpeg"] },
  ".jpeg": { mediaType: "image", contentTypes: ["image/jpeg"] },
  ".png": { mediaType: "image", contentTypes: ["image/png"] },
  ".webp": { mediaType: "image", contentTypes: ["image/webp"] },
  ".mp4": { mediaType: "video", contentTypes: ["video/mp4"] }
});

function normalizeC2UploadFileName(value) {
  const fileName = path.basename(String(value || "").trim());
  if (!fileName || fileName.length > 180 || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw httpError(400, "最终素材文件名无效");
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!C2_UPLOAD_EXTENSIONS[extension]) throw httpError(415, "最终素材仅支持JPG、PNG、WEBP和MP4");
  return { fileName, extension, ...C2_UPLOAD_EXTENSIONS[extension] };
}

function c2UploadCandidateSegment(candidateId) {
  const segment = String(candidateId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!segment) throw httpError(400, "候选ID无效");
  return segment;
}

function c2UploadBodyMatchesType(body, extension) {
  if (!Buffer.isBuffer(body) || body.length < 12) return false;
  if ([".jpg", ".jpeg"].includes(extension)) return body[0] === 0xff && body[1] === 0xd8 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9;
  if (extension === ".png") return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".mp4") return body.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}

async function stageC2FinalUpload({ candidateId, dataRevision, fileName, contentType, body, stagedAt }) {
  const normalized = normalizeC2UploadFileName(fileName);
  const actualContentType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!normalized.contentTypes.includes(actualContentType)) throw httpError(415, "最终素材文件类型与扩展名不一致");
  if (!c2UploadBodyMatchesType(body, normalized.extension)) throw httpError(415, "最终素材文件内容与声明类型不一致");
  const assetUuid = randomUUID();
  const directory = path.join(c2FinalUploadsDir, c2UploadCandidateSegment(candidateId), String(dataRevision));
  await fs.mkdir(directory, { recursive: true });
  const storedName = `${assetUuid}-${normalized.fileName}`;
  const assetRef = path.join(directory, storedName);
  const temporaryRef = `${assetRef}.uploading`;
  try {
    await fs.writeFile(temporaryRef, body, { flag: "wx" });
    await fs.rename(temporaryRef, assetRef);
  } catch (error) {
    await fs.rm(temporaryRef, { force: true }).catch(() => {});
    throw error;
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    assetId: `c2-final:${candidateId}:${dataRevision}:${assetUuid}`,
    mediaType: normalized.mediaType,
    assetRef,
    fileName: normalized.fileName,
    assetVersion: `sha256:${sha256}`,
    sha256,
    byteSize: body.byteLength,
    sourceEvidenceRef: `c2-upload:${candidateId}:${dataRevision}:${assetUuid}`,
    sourceType: "owner_provided_final_upload",
    stagedAt
  };
}

async function verifyAndAuthorizeStagedC2Assets({ candidateId, dataRevision, assets }) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 30) {
    throw httpError(400, "最终素材必须为1到30个文件");
  }
  const root = path.resolve(c2FinalUploadsDir, c2UploadCandidateSegment(candidateId), String(dataRevision));
  const verified = [];
  const seenAssetIds = new Set();
  for (const asset of assets) {
    const assetId = String(asset?.assetId || "");
    const expectedPrefix = `c2-final:${candidateId}:${dataRevision}:`;
    if (!assetId.startsWith(expectedPrefix) || seenAssetIds.has(assetId)) throw httpError(422, "最终素材ID无效或重复");
    seenAssetIds.add(assetId);
    const assetRef = path.resolve(String(asset?.assetRef || ""));
    if (!assetRef.startsWith(`${root}${path.sep}`)) throw httpError(422, "最终素材不属于当前候选和修订");
    const normalized = normalizeC2UploadFileName(asset.fileName);
    if (normalized.mediaType !== asset.mediaType || !/^[a-f0-9]{64}$/.test(String(asset.sha256 || ""))) {
      throw httpError(422, "最终素材身份或摘要无效");
    }
    const assetUuid = assetId.slice(expectedPrefix.length);
    if (!/^[0-9a-f-]{36}$/i.test(assetUuid) || asset.sourceEvidenceRef !== `c2-upload:${candidateId}:${dataRevision}:${assetUuid}`) {
      throw httpError(422, "最终素材证据引用无效");
    }
    if (path.basename(assetRef) !== `${assetUuid}-${normalized.fileName}`) throw httpError(422, "最终素材文件身份不一致");
    const body = await fs.readFile(assetRef);
    if (!c2UploadBodyMatchesType(body, path.extname(normalized.fileName).toLowerCase())) throw httpError(422, "最终素材文件内容类型无效");
    const actualSha256 = createHash("sha256").update(body).digest("hex");
    if (actualSha256 !== asset.sha256 || body.byteLength !== Number(asset.byteSize)) {
      throw httpError(409, "最终素材文件内容或大小已变化，请重新选择");
    }
    verified.push({
      ...structuredClone(asset),
      assetRef,
      assetVersion: `sha256:${actualSha256}`,
      sourceType: "owner_provided_final_upload",
      sourceEvidenceRef: asset.sourceEvidenceRef,
      usageAuthorization: {
        status: "owner_authorized_for_listing",
        evidenceRef: `owner-confirmation:c2:${candidateId}:${dataRevision}:${actualSha256}`
      }
    });
  }
  return verified;
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

function respondWithError(req, res, error) {
  const normalized = normalizeHttpErrorResponse(error);
  if (normalized.shouldLogStack) console.error(error);
  return json(res, normalized.status, normalized.body, chromeExtensionCors(req));
}

function localHttpOrigin(bindHost, listenPort) {
  const normalizedHost = String(bindHost || "").trim();
  const originHost = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `http://${originHost}:${listenPort}`;
}

function chromeExtensionCors(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!allowedExtensionOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function assertClaimedCaptureResultOrigin(session, req, label) {
  const origin = String(req.headers.origin || "").trim();
  if (!session?.claimedExtensionOrigin) {
    throw httpError(409, `${label}作业尚未由插件后台原子领取，不能回传结果`, { code: "capture_job_not_claimed" });
  }
  if (session?.claimedExtensionOrigin && session.claimedExtensionOrigin !== origin) {
    throw httpError(409, `${label}回传来源与领取来源不一致`, { code: "capture_extension_origin_mismatch" });
  }
}

function recordExtensionHeartbeat(input) {
  const version = String(input.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw httpError(400, "插件心跳版本无效");
  if (typeof input.backgroundReady !== "boolean") throw httpError(400, "插件心跳缺少后台状态");
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) throw httpError(400, "插件心跳时间无效");
  latestExtensionHeartbeat = {
    version,
    backgroundReady: input.backgroundReady,
    observedAt: observedAt.toISOString(),
    receivedAtMs: Date.now()
  };
  return extensionHeartbeatSnapshot();
}

function validCaptureToken(expected, provided) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(provided || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function captureSession(candidateId, captureId = "") {
  purgeExpiredCaptureSessions();
  if (captureId) return sourceCaptureSessions.get(captureId) || null;
  return [...sourceCaptureSessions.values()].find((session) => session.candidateId === candidateId) || null;
}

function captureSessionPublic(session) {
  return {
    captureId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedOfferId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    originalSourceUrl: session.originalSourceUrl,
    mode: session.mode,
    expiresAt: new Date(session.expiresAt).toISOString(),
    extensionRequest: {
      captureId: session.captureId,
      candidateId: session.candidateId,
      dataRevision: session.dataRevision,
      expectedOfferId: session.expectedOfferId,
      sourceUrl: session.sourceUrl,
      mode: session.mode,
      allowShortLinkResolution: session.mode === "a_supplier_capture" && !session.expectedOfferId
    }
  };
}

function sourceCaptureJobPublic(session) {
  return {
    jobId: session.captureId,
    candidateId: session.candidateId,
    requestRevision: session.requestRevision,
    dataRevision: session.dataRevision,
    mode: session.mode,
    sourceUrl: session.sourceUrl,
    expectedOfferId: session.expectedOfferId,
    status: session.jobStatus,
    attempt: session.attempt,
    requiredExtensionVersion: session.requiredExtensionVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    claimedAt: session.claimedAt ? new Date(session.claimedAt).toISOString() : null,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}

function sourceCaptureJobPayload(session) {
  return {
    captureId: session.captureId,
    jobId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedOfferId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    mode: session.mode,
    allowShortLinkResolution: !session.expectedOfferId,
    requiredExtensionVersion: session.requiredExtensionVersion,
    attempt: session.attempt,
    token: session.token
  };
}

function clearSourceCaptureJobTimer(captureId) {
  const timer = sourceCaptureJobTimers.get(captureId);
  if (timer) clearTimeout(timer);
  sourceCaptureJobTimers.delete(captureId);
}

async function expireSourceCaptureJob(captureId, expectedStatus) {
  const session = sourceCaptureSessions.get(captureId);
  if (!session || session.jobStatus !== expectedStatus || session.consumedAt) return;
  const failureCode = expectedStatus === "claimed" ? "unknown_outcome" : "extension_job_unclaimed";
  await mutateDataWhenChanged((data) => {
    const current = data.candidates.find((item) => item.id === session.candidateId);
    if (!current || current.sourceCapture?.captureId !== captureId) return { changed: false };
    if (Number(current.dataRevision) !== Number(session.dataRevision)) return { changed: false };
    markSourceCaptureFailure(current, session, failureCode, expectedStatus === "claimed"
      ? "插件已领取一次，但在执行期限内没有回传可验证结果"
      : "插件在作业等待期限内没有领取本候选");
    return { changed: true };
  });
  session.jobStatus = failureCode;
  session.consumedAt = Date.now();
  clearSourceCaptureJobTimer(captureId);
  sourceCaptureSessions.delete(captureId);
}

function scheduleSourceCaptureJobExpiry(session, expectedStatus, timeoutMs) {
  clearSourceCaptureJobTimer(session.captureId);
  const timer = setTimeout(() => {
    void expireSourceCaptureJob(session.captureId, expectedStatus).catch((error) => {
      console.error("1688采集作业超时收口失败", error);
    });
  }, timeoutMs);
  timer.unref?.();
  sourceCaptureJobTimers.set(session.captureId, timer);
}

async function enqueueASupplierCaptureJob({ candidateId, requestRevision, requestedSourceUrl }) {
  const existing = captureSession(candidateId);
  if (existing?.mode === "a_supplier_capture" &&
    [existing.requestRevision, existing.dataRevision].includes(requestRevision) &&
    ["queued", "claimed"].includes(existing.jobStatus)) {
    const data = await readData();
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
    return { candidate: publicCandidate(current, data.rules), captureJob: sourceCaptureJobPublic(existing), duplicate: true };
  }
  ensureCaptureControlAvailable(candidateId);
  const source = normalize1688CaptureSource(requestedSourceUrl);
  if (source.type === "invalid") {
    throw httpError(422, "A阶段供应链接不是允许的1688短链或精确商品链接", { code: "source_url_invalid" });
  }
  const session = {
    captureId: `SCJ-${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    candidateId,
    requestRevision,
    dataRevision: null,
    expectedOfferId: source.offerId,
    sourceUrl: source.sourceUrl,
    originalSourceUrl: source.sourceUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + SOURCE_CAPTURE_JOB_QUEUE_TTL_MS,
    recoverySuggestion: "",
    mode: "a_supplier_capture",
    jobStatus: "queued",
    attempt: 0,
    requiredExtensionVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
    claimedAt: null,
    claimedExtensionVersion: "",
    claimedExtensionOrigin: ""
  };
  sourceCaptureSessions.set(session.captureId, session);
  let candidate;
  try {
    candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== Number(requestRevision)) {
        throw httpError(409, "商品资料已变化，请刷新后重新保存A阶段供应链接", { code: "revision_conflict" });
      }
      if (!sourceCaptureAllowed(current, session.mode)) {
        throw httpError(409, "当前商品状态不能建立A阶段供应采集作业", { code: "business_state_rejected" });
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "当前SKU已有任务等待或运行，不能建立供应采集作业", { code: "candidate_busy" });
      }
      const timestamp = now();
      current.sourceUrl = source.sourceUrl;
      current.sourceCapture = {
        captureId: session.captureId,
        jobId: session.captureId,
        status: "waiting_extension",
        jobStatus: "queued",
        offerId: source.offerId,
        sourceUrl: source.sourceUrl,
        originalSourceUrl: source.sourceUrl,
        mode: session.mode,
        attempt: 0,
        requiredExtensionVersion: session.requiredExtensionVersion,
        startedAt: timestamp,
        writeOccurred: false,
        businessStateEffect: "unchanged"
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      session.dataRevision = current.dataRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "aSupplierCaptureJobQueued", "主人在新版A确认动作中保存供应链接；系统已建立一个受控采集作业，等待插件后台领取，不自动选择SKU、运行B/C1或派发任务", timestamp);
      return publicCandidate(current, data.rules);
    });
  } catch (error) {
    sourceCaptureSessions.delete(session.captureId);
    throw error;
  }
  scheduleSourceCaptureJobExpiry(session, "queued", SOURCE_CAPTURE_JOB_QUEUE_TTL_MS);
  return { candidate, captureJob: sourceCaptureJobPublic(session), duplicate: false };
}

function claimPendingASupplierCaptureJob(extensionVersion, extensionOrigin) {
  const operation = sourceCaptureJobClaimQueue.then(async () => {
    const claimed = [...sourceCaptureSessions.values()]
      .find((item) => item.mode === "a_supplier_capture" && item.jobStatus === "claimed" && item.attempt === 1);
    if (claimed) return { captureJob: null, jobNotice: null };
    const session = [...sourceCaptureSessions.values()]
      .filter((item) => item.mode === "a_supplier_capture" && item.jobStatus === "queued" && item.attempt === 0)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!session) return { captureJob: null, jobNotice: null };
    if (String(extensionVersion) !== session.requiredExtensionVersion) {
      await mutateDataWhenChanged((data) => {
        const current = data.candidates.find((item) => item.id === session.candidateId);
        if (!current || current.sourceCapture?.captureId !== session.captureId) return { changed: false };
        if (current.sourceCapture.status === "extension_version_mismatch" &&
          current.sourceCapture.observedExtensionVersion === String(extensionVersion)) return { changed: false };
        current.sourceCapture = {
          ...current.sourceCapture,
          status: "extension_version_mismatch",
          jobStatus: "queued",
          failureCode: "extension_version_mismatch",
          reason: `当前插件v${String(extensionVersion || "未知")}，作业要求v${session.requiredExtensionVersion}`,
          observedExtensionVersion: String(extensionVersion || ""),
          writeOccurred: false,
          businessStateEffect: "unchanged"
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        session.dataRevision = current.dataRevision;
        current.updatedAt = now();
        current.lastModifiedBy = "system";
        return { changed: true };
      });
      return {
        captureJob: null,
        jobNotice: {
          code: "extension_version_mismatch",
          candidateId: session.candidateId,
          requiredExtensionVersion: session.requiredExtensionVersion
        }
      };
    }
    session.jobStatus = "claimed";
    session.attempt = 1;
    session.claimedAt = Date.now();
    session.claimedExtensionVersion = String(extensionVersion);
    session.claimedExtensionOrigin = String(extensionOrigin || "");
    clearSourceCaptureJobTimer(session.captureId);
    try {
      await mutateData((data) => {
        const current = data.candidates.find((item) => item.id === session.candidateId);
        if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
        if (current.sourceCapture?.captureId !== session.captureId ||
          !["waiting_extension", "extension_version_mismatch"].includes(current.sourceCapture.status)) {
          throw httpError(409, "当前候选不再等待该采集作业", { code: "capture_job_state_conflict" });
        }
        if (Number(current.dataRevision) !== Number(session.dataRevision)) {
          throw httpError(409, "采集作业修订号已失效", { code: "revision_conflict" });
        }
        current.sourceCapture = {
          ...current.sourceCapture,
          status: "capturing",
          jobStatus: "claimed",
          attempt: 1,
          claimedAt: new Date(session.claimedAt).toISOString(),
          claimedExtensionVersion: session.claimedExtensionVersion,
          failureCode: null,
          reason: null,
          writeOccurred: false,
          businessStateEffect: "unchanged"
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        session.dataRevision = current.dataRevision;
        current.updatedAt = now();
        current.lastModifiedBy = "system";
        return null;
      });
    } catch (error) {
      session.jobStatus = "queued";
      session.attempt = 0;
      session.claimedAt = null;
      session.claimedExtensionVersion = "";
      session.claimedExtensionOrigin = "";
      scheduleSourceCaptureJobExpiry(session, "queued", SOURCE_CAPTURE_JOB_QUEUE_TTL_MS);
      throw error;
    }
    session.expiresAt = Date.now() + SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS;
    scheduleSourceCaptureJobExpiry(session, "claimed", SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS);
    return { captureJob: sourceCaptureJobPayload(session), jobNotice: null };
  });
  sourceCaptureJobClaimQueue = operation.catch(() => undefined);
  return operation;
}

function salesCaptureSession(candidateId, captureId = "") {
  purgeExpiredCaptureSessions();
  if (captureId) return salesCaptureSessions.get(captureId) || null;
  return [...salesCaptureSessions.values()].find((session) => session.candidateId === candidateId) || null;
}

function salesCaptureSessionPublic(session) {
  return {
    captureId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedProductId: session.expectedProductId,
    productUrl: session.productUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
    extensionRequest: {
      captureId: session.captureId,
      candidateId: session.candidateId,
      dataRevision: session.dataRevision,
      expectedProductId: session.expectedProductId,
      productUrl: session.productUrl
    }
  };
}

function salesCaptureTechnicalStatus(code) {
  if (["site_login_required", "site_verification_required", "permission_required", "extension_not_installed"].includes(code)) {
    return "permission_required";
  }
  if (code === "extension_background_unavailable") return "system_error";
  if (["wrong_product", "structured_data_unavailable", "precise_price_missing", "invalid_capture"].includes(code)) {
    return "data_unavailable";
  }
  return "system_error";
}

function listedSourceRecoveryAllowed(candidate) {
  return candidate.workflowStatus === "listed" &&
    candidate.listingRecord?.stateOnly === true &&
    candidate.listingPreparation?.status === "queued" &&
    candidate.sourceCapture?.status !== "verified";
}

function sourceCaptureAllowed(candidate, mode = "listing_preparation") {
  if (mode === "listed_evidence_recovery") return listedSourceRecoveryAllowed(candidate);
  if (mode === "a_supplier_capture") {
    return !candidate.lifecycleV11?.skuPackage &&
      !candidate.lifecycleV11?.aConfirmationReceipt &&
      ["awaiting_user_direction", "needs_user_data", "codex_processing"].includes(candidate.workflowStatus);
  }
  const legacyReadyPendingC = candidate.workflowStatus === "ready_to_list" &&
    !(candidate.listingPreparation?.status === "prepared" && candidate.cCompletedAt);
  if (candidate.workflowStatus !== "listing_preparation" && !legacyReadyPendingC) return false;
  return [
    "awaiting_user_start",
    "blocked",
    "needs_decision",
    "paused_user_stopped",
    "capturing_source"
  ].includes(candidate.listingHandoff?.state) || legacyReadyPendingC;
}

function normalizedEvidenceScope(scope = {}) {
  const entries = Object.entries(scope)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => [String(key), String(value).trim()])
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function evidenceScopeKey(kind, scope) {
  return `${kind}|${JSON.stringify(normalizedEvidenceScope(scope))}`;
}

function evidencePackApplies(pack, candidate, timestamp = Date.now()) {
  if (!pack || pack.status !== "active") return false;
  if (pack.expiresAt && new Date(pack.expiresAt).getTime() <= timestamp) return false;
  const scope = pack.scope || {};
  const expectedPlatform = candidate.targetStore === "wb" ? "wb" : "ozon";
  const category = String(candidate.codexReview?.category || candidate.codexReview?.productType || candidate.listingPreparation?.category || "").trim().toLowerCase();
  const salesScheme = String(candidate.codexReview?.salesScheme || candidate.listingPreparation?.salesScheme || "").trim().toLowerCase();
  const route = String(candidate.codexReview?.logistics?.route || candidate.listingPreparation?.route || "").trim().toLowerCase();
  const exactMatches = [
    [scope.platform, expectedPlatform],
    [scope.store, candidate.targetStore],
    [scope.category, category],
    [scope.salesScheme, salesScheme],
    [scope.route, route]
  ];
  return exactMatches.every(([required, actual]) =>
    !required || (actual && String(required).trim().toLowerCase() === String(actual).trim().toLowerCase())
  );
}

function attachReusableEvidence(data, candidate) {
  const packs = (data.evidencePacks || []).filter((pack) => evidencePackApplies(pack, candidate));
  const ids = new Set(Array.isArray(candidate.evidencePackIds) ? candidate.evidencePackIds.map(String) : []);
  for (const pack of packs) ids.add(pack.id);
  candidate.evidencePackIds = [...ids];
  return packs.filter((pack) => ids.has(pack.id)).map((pack) => ({
    id: pack.id,
    kind: pack.kind,
    scope: pack.scope,
    summary: pack.summary,
    sourceType: pack.sourceType,
    checkedAt: pack.checkedAt,
    expiresAt: pack.expiresAt,
    ruleVersion: pack.ruleVersion
  }));
}

function normalizeBusinessStateDocument(document) {
  const data = structuredClone(document);
  if (Number(data.meta?.version || 1) !== 2) {
    throw new Error("候选数据尚未迁移到v2");
  }
  data.rules = {
    ...DEFAULT_RULES,
    ...(data.rules || {}),
    selectionFlow: {
      ...DEFAULT_RULES.selectionFlow,
      ...(data.rules?.selectionFlow || {}),
      stageBoundaries: {
        ...DEFAULT_RULES.selectionFlow.stageBoundaries,
        ...(data.rules?.selectionFlow?.stageBoundaries || {}),
        A: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.A,
          ...(data.rules?.selectionFlow?.stageBoundaries?.A || {})
        },
        B: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.B,
          ...(data.rules?.selectionFlow?.stageBoundaries?.B || {})
        },
        C: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.C,
          ...(data.rules?.selectionFlow?.stageBoundaries?.C || {})
        }
      },
      antiIdleRun: {
        ...DEFAULT_RULES.selectionFlow.antiIdleRun,
        ...(data.rules?.selectionFlow?.antiIdleRun || {})
      },
      technicalFailurePolicy: DEFAULT_RULES.selectionFlow.technicalFailurePolicy,
      retryPolicy: DEFAULT_RULES.selectionFlow.retryPolicy,
      profitInputs: DEFAULT_RULES.selectionFlow.profitInputs,
      sourcePagePurpose: DEFAULT_RULES.selectionFlow.sourcePagePurpose,
      note: DEFAULT_RULES.selectionFlow.note
    },
    dailyTargets: {
      ...DEFAULT_RULES.dailyTargets,
      ...(data.rules?.dailyTargets || {}),
      cadence: DEFAULT_RULES.dailyTargets.cadence,
      automaticAuditEnabled: false
    },
    listingPreparation: {
      ...DEFAULT_RULES.listingPreparation,
      ...(data.rules?.listingPreparation || {}),
      batchEnabled: false,
      defaultNewStock: 100,
      startPolicy: DEFAULT_RULES.listingPreparation.startPolicy,
      productionPolicy: DEFAULT_RULES.listingPreparation.productionPolicy
    },
    evidenceReuse: {
      ...DEFAULT_RULES.evidenceReuse,
      ...(data.rules?.evidenceReuse || {})
    },
    purchaseInput: {
      ...DEFAULT_RULES.purchaseInput,
      ...(data.rules?.purchaseInput || {}),
      scope: DEFAULT_RULES.purchaseInput.scope,
      domesticShippingRmb: DEFAULT_RULES.purchaseInput.domesticShippingRmb,
      componentPolicy: DEFAULT_RULES.purchaseInput.componentPolicy,
      note: DEFAULT_RULES.purchaseInput.note
    },
    ozonDandanshu: currentProfitRule(data.rules?.ozonDandanshu, DEFAULT_RULES.ozonDandanshu),
    ozonMiska: currentProfitRule(data.rules?.ozonMiska, DEFAULT_RULES.ozonMiska),
    wbCrossListing: currentProfitRule(data.rules?.wbCrossListing, DEFAULT_RULES.wbCrossListing),
    selectionDirections: {
      ...DEFAULT_RULES.selectionDirections,
      ...(data.rules?.selectionDirections || {}),
      dandanshu: {
        ...DEFAULT_RULES.selectionDirections.dandanshu,
        ...(data.rules?.selectionDirections?.dandanshu || {}),
        minimumCrossBorderShare: 0.4,
        requirePositivePurchaseSpaceBeforeSourceSearch: true,
        automaticRetryEnabled: false
      },
      miska: {
        ...DEFAULT_RULES.selectionDirections.miska,
        ...(data.rules?.selectionDirections?.miska || {}),
        automaticAdditionEnabled: false,
        pauseReason: DEFAULT_RULES.selectionDirections.miska.pauseReason,
        userSampleReviewThreshold: DEFAULT_RULES.selectionDirections.miska.userSampleReviewThreshold
      },
      note: DEFAULT_RULES.selectionDirections.note
    }
  };
  return ensureCollaborationData(data);
}

async function readData() {
  return normalizeBusinessStateDocument(await businessStateRepository.readSnapshot());
}

function mutateData(mutator) {
  return businessStateRepository.transact(async (document) => {
    const data = normalizeBusinessStateDocument(document);
    const result = await mutator(data);
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    return { changed: true, document: data, result };
  });
}

function mutateDataWhenChanged(mutator) {
  return businessStateRepository.transact(async (document) => {
    const data = normalizeBusinessStateDocument(document);
    const outcome = await mutator(data);
    if (!outcome?.changed) return { changed: false, result: outcome?.result };
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    return { changed: true, document: data, result: outcome.result };
  });
}

function orphanedASupplierCaptureKind(sourceCapture) {
  if (sourceCapture?.mode !== "a_supplier_capture") return null;
  if (sourceCapture.status === "waiting_extension" && sourceCapture.jobStatus === "queued") return "queued";
  if (sourceCapture.status === "capturing" && sourceCapture.jobStatus === "claimed") return "claimed";
  return null;
}

async function reconcileOrphanedASupplierCaptureJobsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const timestamp = now();
    const reconciled = [];
    for (const current of data.candidates || []) {
      const kind = orphanedASupplierCaptureKind(current.sourceCapture);
      if (!kind) continue;
      const previous = current.sourceCapture;
      const { token: _discardedToken, extensionRequest: _discardedRequest, ...safePrevious } = previous;
      const failureCode = kind === "claimed" ? "unknown_outcome" : "service_restarted_before_claim";
      const reason = sourceCaptureFailureMessage(failureCode);
      current.sourceCapture = {
        ...safePrevious,
        status: "failed",
        jobStatus: kind === "claimed" ? "unknown_outcome" : "failed",
        technicalStatus: kind === "claimed" ? "unknown_outcome" : "system_error",
        failureCode,
        failureLayer: "selection_review_service_restart",
        reason,
        stoppedAt: timestamp,
        restartRecoveredAt: timestamp,
        writeOccurred: false,
        businessStateEffect: "unchanged",
        automaticRetryAllowed: false,
        requiresOwnerNewAuthorization: true
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(
        current,
        "system",
        kind === "claimed" ? "aSupplierCaptureUnknownAfterRestart" : "aSupplierCaptureStoppedAfterRestart",
        `${reason}；旧内存会话、一次性令牌和领取资格均未恢复。A阶段业务状态保持不变；以后只能由主人基于新修订号重新授权，不自动重建、领取、重试、运行B/C1或派发任务。`,
        timestamp
      );
      reconciled.push({ candidateId: current.id, failureCode });
    }
    return {
      changed: reconciled.length > 0,
      result: { count: reconciled.length, items: reconciled }
    };
  });
}

async function reconcileOrphanedAliyunOssAssetIntentsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const timestamp = now();
    const reconciled = [];
    for (const current of data.candidates || []) {
      const state = current.lifecycleV11?.skuPackage?.dAssetTransport;
      if (state?.intent?.status !== "in_flight") continue;
      const intent = reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent: state.intent, restartedAt: timestamp });
      state.status = "unknown_outcome";
      state.intent = structuredClone(intent);
      state.assetTransport = null;
      state.automaticRetry = false;
      state.platformWrites = 0;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(
        current,
        "system",
        "ossAssetTransportUnknownAfterRestart",
        "服务重启时发现未收口的OSS素材传输意图，已标记结果未知并禁止自动重试；商品业务结论和Ozon写入状态不变。",
        timestamp
      );
      reconciled.push({ candidateId: current.id, intentId: intent.intentId });
    }
    return {
      changed: reconciled.length > 0,
      result: { count: reconciled.length, items: reconciled }
    };
  });
}

async function reconcileOrphanedKeywordEvidenceSoftwareJobsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const timestamp = now();
    const outcome = reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument({ document: data, restartedAt: timestamp });
    for (const item of outcome.reconciled) {
      const current = data.candidates.find((candidate) => candidate.id === item.candidateId);
      if (!current) continue;
      addHistory(
        current,
        "system",
        "c1KeywordSoftwareJobUnknownAfterRestart",
        "服务重启时发现旧C1关键词局部作业处于in_flight，已迁移为unknown_outcome并禁止自动重发；新作业只允许进入通用SoftwareJobStore。",
        timestamp
      );
    }
    return { changed: outcome.changed, result: { count: outcome.reconciled.length, items: outcome.reconciled } };
  });
}

function dispatchPublic(dispatch) {
  if (!dispatch) return null;
  const legacyDisabled = isDisabledLegacyCDispatch(dispatch);
  return {
    ...dispatch,
    status: legacyDisabled ? "legacy_disabled" : dispatch.status,
    legacyDisabled,
    message: dispatch.message,
    pendingApproval: dispatch.pendingApproval || null
  };
}

function appendNodeReply(data, dispatch, message, status = "responded") {
  const text = String(message || "").trim();
  if (!text || dispatch.replyCommentId) return;
  const comment = {
    id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor: "codex",
    message: text,
    nodeId: dispatch.nodeId,
    scope: dispatch.scope,
    dispatchId: dispatch.id,
    replyTo: dispatch.commentId || null,
    requiresResponse: status === "needs_decision",
    status,
    at: now()
  };
  if (dispatch.scope === "workflow") {
    data.workflowComments.push(comment);
  } else {
    const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
    if (candidate) {
      candidate.comments ||= [];
      candidate.comments.push(comment);
    }
  }
  dispatch.replyCommentId = comment.id;
}

async function postLocalDispatchResult(pathname, payload) {
  const response = await fetch(`${localHttpOrigin(host, port)}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-selection-review-internal-token": internalApiRequestToken
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body?.error || body?.message || text || `本机回写失败（HTTP ${response.status}）`);
  }
  return body;
}

async function applyStructuredDispatchResult(dispatchId) {
  const data = await readData();
  const dispatch = (data.dispatches || []).find((item) => item.id === dispatchId);
  const result = dispatch?.structuredResult;
  if (!dispatch || !result) return false;
  if (!["running", "permission_required"].includes(dispatch.status)) return true;

  let resultPayload = null;
  if (result.resultJson) {
    try {
      resultPayload = JSON.parse(result.resultJson);
    } catch {
      throw new Error("负责人返回的业务结果JSON无法解析");
    }
  }

  if (result.resultType === "selection_review") {
    if (result.status !== "completed" || !resultPayload || typeof resultPayload !== "object") {
      throw new Error("选品业务回写缺少完整selection_review结果");
    }
    await postLocalDispatchResult(`/api/candidates/${encodeURIComponent(dispatch.candidateId)}/codex-review`, {
      ...resultPayload,
      dataRevision: Number(dispatch.dataRevision),
      runId: dispatch.runId
    });
  } else if (result.resultType === "listing_preparation_review") {
    if (!resultPayload || typeof resultPayload !== "object") {
      throw new Error("C阶段业务回写缺少listing_preparation_review结果");
    }
    const expectedCaptureId = dispatch.candidateSnapshot?.sourceCapture?.captureId || null;
    if (expectedCaptureId && resultPayload.sourceCaptureId !== expectedCaptureId) {
      throw new Error("C阶段结果没有带回本轮1688采集编号，不能验收");
    }
    await postLocalDispatchResult(`/api/candidates/${encodeURIComponent(dispatch.candidateId)}/listing-preparation-review`, {
      ...resultPayload,
      status: resultPayload.status || (result.status === "completed" ? "prepared" : result.status),
      reason: resultPayload.reason || (result.status === "completed" ? "" : result.reply),
      dataRevision: Number(dispatch.dataRevision),
      runId: dispatch.runId
    });
  } else if (result.status === "completed") {
    return false;
  }

  await postLocalDispatchResult(`/api/dispatches/${encodeURIComponent(dispatch.id)}/complete`, {
    runId: dispatch.runId,
    status: result.status,
    reply: result.reply,
    evidence: result.evidenceSummary || (result.resultType !== "none" ? `已接收${result.resultType}结构化结果` : "")
  });
  return true;
}

async function handleDispatcherEvent(event) {
  if (event.type === "assistant_delta") return;
  if (event.type === "assignee_available") {
    setTimeout(() => deliverDispatch(event.dispatchId).catch((error) => console.error("负责人空闲后派发失败", error)), 0);
    return;
  }
  if (event.type === "turn_completed") {
    try {
      await applyStructuredDispatchResult(event.dispatchId);
    } catch (error) {
      event.error = `结构化回传处理失败：${error.message}`;
    }
  }
  await mutateDataWhenChanged((data) => {
    const dispatch = (data.dispatches || []).find((item) => item.id === event.dispatchId);
    if (!dispatch) return { changed: false };
    const timestamp = now();
    if (event.type === "approval") {
      dispatch.status = "permission_required";
      dispatch.pendingApproval = event.approval;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "assistant_message") {
      dispatch.agentReply = event.text;
      dispatch.structuredResult = event.structuredResult || null;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "turn_completed") {
      dispatch.turnCompletedAt = timestamp;
      dispatch.turnStatus = event.status;
      dispatch.error = event.error || dispatch.error || "";
      if (!["completed", "blocked", "needs_decision"].includes(dispatch.status)) {
        dispatch.status = event.error ? "failed" : "responded_unverified";
        dispatch.failureLayer = event.error ? "codex_turn" : "missing_business_readback";
      }
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (
        candidate?.workflowStatus === "codex_processing" &&
        candidate.processing?.runId === dispatch.runId &&
        Number(candidate.dataRevision) === Number(dispatch.dataRevision) &&
        candidate.workflowStatus === dispatch.workflowStatusAtDispatch
      ) {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "blocked",
          runId: null,
          startedAt: null,
          currentStep: event.error ? "派发任务失败，已停止" : "任务已回复，结果未验证",
          lastRunId: dispatch.runId,
          lastProgressAt: timestamp,
          dispatchState: dispatch.status,
          manualHold: true,
          blockReason: event.error
            ? `派发任务失败：${event.error}`
            : "负责人任务已回复，但没有共享数据回写或独立证据",
          userAction: "请在主界面选择固定处理方式",
          recoveryDecision: fixedRecoveryDecision(
            event.error ? "external_failure" : "result_unverified",
            event.error
              ? `派发任务失败：${event.error}`
              : "负责人已经回复，但系统没有取得可验收的结构化结果。",
            ["retry_current_stage_once", "keep_stopped"]
          )
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
      } else if (
        ["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus) &&
        candidate.listingHandoff?.runId === dispatch.runId
      ) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "blocked",
          runId: null,
          currentStep: event.error ? "负责人任务派发失败，已停止" : "负责人任务已回复，结果未验证",
          blockReason: event.error || "缺少共享数据回写或独立证据",
          recoveryDecision: fixedRecoveryDecision(
            event.error ? "external_failure" : "result_unverified",
            event.error || "负责人已经回复，但系统没有取得可验收的结构化结果。",
            ["retry_current_stage_once", "keep_stopped"]
          ),
          stoppedAt: timestamp
        };
        candidate.updatedAt = timestamp;
      }
      appendNodeReply(
        data,
        dispatch,
        dispatch.agentReply || (event.error ? `任务失败：${event.error}` : "任务已回复，但没有取得可验证的数据回写。"),
        dispatch.status === "needs_decision" ? "needs_decision" : "responded"
      );
    } else {
      return { changed: false };
    }
    return { changed: true, result: dispatchPublic(dispatch) };
  });
}

const codexDispatcher = explicitDispatchDeliveryEnabled
  ? new CodexDispatcher({ onEvent: (event) => handleDispatcherEvent(event) })
  : null;

async function deliverDispatch(dispatchId) {
  if (dispatchDeliveriesInFlight.has(dispatchId)) return null;
  const snapshot = await readData();
  const queuedDispatch = snapshot.dispatches.find((item) => item.id === dispatchId);
  if (isDisabledLegacyCDispatch(queuedDispatch)) return null;
  if (!queuedDispatch || !["queued", "waiting_assignee"].includes(queuedDispatch.status)) return null;
  const delivery = {
    dispatch: { ...queuedDispatch },
    route: { ...snapshot.taskRoutes[queuedDispatch.assigneeRole] },
    candidate: queuedDispatch.candidateId ? snapshot.candidates.find((item) => item.id === queuedDispatch.candidateId) : null
  };
  const gate = delivery.candidate ? codexDispatchGate(delivery.candidate) : null;
  if (delivery.candidate && !gate.allowed) return null;
  if (delivery.candidate) {
    assertRuntimeCodexDependencyAllowed({
      codexOffline: codexOfflineEnabled,
      pathType: gate.mode === "exception" ? EXCEPTION_MAINTENANCE_PATH : NORMAL_PRODUCTION_PATH,
      skuPackageId: delivery.candidate.lifecycleV11?.skuPackage?.skuPackageId || `candidate:${delivery.candidate.id}`,
      dependencyType: "dispatch",
      evidenceRef: `dispatch:${delivery.dispatch.id}`
    });
  }
  if (!codexDispatcher) return null;
  dispatchDeliveriesInFlight.add(dispatchId);

  const map = await readWorkflowMap(workflowMapFile);
  const node = map.nodes.find((item) => item.id === delivery.dispatch.nodeId);
  try {
    const outcome = await codexDispatcher.deliver(delivery.dispatch, delivery.route, node, delivery.candidate);
    return await mutateDataWhenChanged((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch || !["queued", "waiting_assignee"].includes(dispatch.status)) return { changed: false, result: null };
      if (
        outcome.status === "waiting_assignee" &&
        dispatch.status === "waiting_assignee" &&
        dispatch.deliveryDetail === (outcome.detail || "")
      ) return { changed: false, result: dispatchPublic(dispatch) };
      dispatch.status = outcome.status;
      dispatch.turnId = outcome.turnId || null;
      dispatch.runId = outcome.turnId || null;
      dispatch.deliveryDetail = outcome.detail || "";
      dispatch.attachedSkills = Array.isArray(outcome.attachedSkills) ? outcome.attachedSkills : [];
      const timestamp = now();
      dispatch.skillsAttachedAt = outcome.status === "running" ? timestamp : null;
      dispatch.deliveredAt = outcome.status === "running" ? timestamp : null;
      dispatch.startedAt = outcome.status === "running" ? timestamp : null;
      dispatch.lastEventAt = timestamp;
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (outcome.status === "running" && candidate?.executionRuntime?.exceptionCase?.schemaVersion === "exception-case-v2" && gate?.exceptionId) {
        candidate.executionRuntime = recordExceptionMaintenanceStarted(candidate.executionRuntime, {
          exceptionId: gate.exceptionId,
          turnId: outcome.turnId,
          at: timestamp
        });
      }
      if (outcome.status === "blocked") {
        dispatch.failureLayer = outcome.failureLayer || "codex_dispatch";
        dispatch.error = outcome.detail || "负责人任务派发已停止";
        if (candidate?.workflowStatus === "codex_processing") {
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "blocked",
            runId: null,
            startedAt: null,
            currentStep: "负责人任务写入锁被占用，派发已停止",
            dispatchState: "blocked",
            manualHold: true,
            blockReason: dispatch.error,
            userAction: "先释放对应Codex任务的其他写入连接，再从UI只重试当前SKU一次",
            stoppedAt: timestamp,
            stopReason: dispatch.failureLayer
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = "system";
        } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "blocked",
            runId: null,
            currentStep: "上架任务写入锁被占用，C阶段派发已停止",
            blockReason: dispatch.error,
            userAction: "先释放上架任务的其他写入连接，再从UI只重试当前SKU一次",
            stoppedAt: timestamp,
            failureLayer: dispatch.failureLayer
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = "system";
        }
      } else if (outcome.status === "running" && candidate?.workflowStatus === "codex_processing") {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "running",
          runId: outcome.turnId,
          startedAt: timestamp,
          claimRevision: Number(candidate.dataRevision),
          currentStep: "负责人任务已启动",
          lastProgressAt: timestamp,
          dispatchState: "claimed",
          manualHold: false,
          blockReason: null,
          userAction: ""
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
        addHistory(candidate, "system", "oneShotTurnStarted", `一次性派发已取得真实运行编号：${outcome.turnId}`, timestamp);
      } else if (outcome.status === "running" && ["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "running",
          owner: dispatch.assigneeRole,
          runId: outcome.turnId,
          startedAt: timestamp,
          currentStep: dispatch.nodeId === "M07" ? "上架任务已开始C阶段" : "上架负责人任务已启动",
          requiredSkills: dispatch.requiredSkills || [],
          attachedSkills: dispatch.attachedSkills,
          skillsAttachedAt: dispatch.skillsAttachedAt,
          sourceCaptureId: dispatch.capabilityPlan?.sourceCapture?.captureId || null
        };
        candidate.updatedAt = timestamp;
      }
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = outcome.status === "blocked" ? "failed" : "verified";
      route.verifiedAt = now();
      route.lastError = outcome.status === "blocked" ? dispatch.error : "";
      return { changed: true, result: dispatchPublic(dispatch) };
    });
  } catch (error) {
    return mutateDataWhenChanged((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch || !["queued", "waiting_assignee"].includes(dispatch.status)) return { changed: false, result: null };
      const timestamp = now();
      const assigneeBusy = /active writer|already has an active writer|负责人正在处理/i.test(String(error.message || ""));
      if (assigneeBusy) {
        const detail = "负责人任务存在未结束轮次，结束后系统再领取";
        if (dispatch.status === "waiting_assignee" && dispatch.deliveryDetail === detail) {
          return { changed: false, result: dispatchPublic(dispatch) };
        }
        dispatch.status = "waiting_assignee";
        dispatch.lastEventAt = timestamp;
        dispatch.failureLayer = "";
        dispatch.error = "";
        dispatch.deliveryDetail = detail;
        const candidate = dispatch.candidateId
          ? data.candidates.find((item) => item.id === dispatch.candidateId)
          : null;
        if (candidate?.workflowStatus === "codex_processing") {
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "queued",
            runId: null,
            startedAt: null,
            currentStep: "等待选品负责人空闲",
            dispatchState: "waiting_assignee",
            manualHold: false,
            blockReason: null,
            userAction: ""
          };
          candidate.updatedAt = timestamp;
        } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "queued",
            runId: null,
            currentStep: dispatch.assigneeRole === "listing_task" ? "等待上架负责人空闲" : "等待选品负责人空闲",
            blockReason: null
          };
          candidate.updatedAt = timestamp;
        }
        return { changed: true, result: dispatchPublic(dispatch) };
      }
      dispatch.status = "failed";
      dispatch.lastEventAt = timestamp;
      dispatch.failureLayer = "codex_app_server";
      dispatch.error = error.message;
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (
        candidate?.workflowStatus === "codex_processing" &&
        Number(candidate.dataRevision) === Number(dispatch.dataRevision)
      ) {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "blocked",
          runId: null,
          startedAt: null,
          currentStep: "一次性派发失败，已停止",
          dispatchState: "failed",
          manualHold: true,
          blockReason: `派发失败层 codex_app_server：${error.message}`,
          userAction: "可在UI选择是否只重试当前阶段一次",
          recoveryDecision: fixedRecoveryDecision(
            "external_failure",
            `派发失败层 codex_app_server：${error.message}`,
            ["retry_current_stage_once", "keep_stopped"]
          ),
          stoppedAt: timestamp,
          stopReason: "codex_app_server"
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = "system";
      } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "blocked",
          runId: null,
          blockReason: `派发失败层 codex_app_server：${error.message}`,
          stoppedAt: timestamp
        };
        candidate.updatedAt = timestamp;
      }
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = "failed";
      route.lastError = error.message;
      return { changed: true, result: dispatchPublic(dispatch) };
    });
  } finally {
    dispatchDeliveriesInFlight.delete(dispatchId);
  }
}

async function deliverWaitingDispatches() {
  const data = await readData();
  const waiting = (data.dispatches || []).filter((item) =>
    ["queued", "waiting_assignee"].includes(item.status) &&
    !isDisabledLegacyCDispatch(item) &&
    (!item.candidateId || codexDispatchGate(data.candidates.find((candidate) => candidate.id === item.candidateId)).allowed)
  );
  const groups = dispatchDeliveryGroups(waiting, data.taskRoutes);
  await Promise.all(groups.map(async (group) => {
    for (const dispatch of group) await deliverDispatch(dispatch.id);
  }));
}

function createDispatchRecord(data, { node, scope, candidate = null, message, commentId = null, trigger = "node_comment" }) {
  if (candidate) {
    const gate = codexDispatchGate(candidate);
    if (!gate.allowed) throw httpError(409, gate.reason);
    assertRuntimeCodexDependencyAllowed({
      codexOffline: codexOfflineEnabled,
      pathType: gate.mode === "exception" ? EXCEPTION_MAINTENANCE_PATH : NORMAL_PRODUCTION_PATH,
      skuPackageId: candidate.lifecycleV11?.skuPackage?.skuPackageId || `candidate:${candidate.id}`,
      dependencyType: "dispatch",
      evidenceRef: `candidate-dispatch:${candidate.id}:${candidate.dataRevision}`
    });
  }
  const assigneeRole = dispatchOwnerForNode(node, scope);
  if (candidate && assigneeRole === "control_task") {
    throw httpError(409, "当前SKU必须直接派给最终选品或上架负责人，不能绕到总控任务");
  }
  const duplicate = (data.dispatches || []).find((item) =>
    item.scope === scope &&
    (candidate
      ? item.candidateId === candidate.id
      : item.nodeId === node.id && item.candidateId === null) &&
    ACTIVE_DISPATCH_STATES.has(item.status) &&
    !isDisabledLegacyCDispatch(item)
  );
  if (duplicate) throw httpError(409, "该节点已有一次工作正在等待或执行，不能重复派发", { dispatchId: duplicate.id });
  const timestamp = now();
  const reusableEvidencePacks = candidate ? attachReusableEvidence(data, candidate) : [];
  const capabilityPlan = candidate ? dispatchCapabilityPlan(node, candidate) : null;
  const requiredSkills = candidate ? requiredSkillsForDispatch(node, candidate) : [];
  const dispatch = {
    id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scope,
    nodeId: node.id,
    nodeTitle: node.title,
    candidateId: candidate?.id || null,
    dataRevision: candidate ? Number(candidate.dataRevision) : null,
    candidateSnapshot: candidate ? dispatchCandidateSnapshot(candidate) : null,
    reusableEvidencePacks,
    capabilityPlan,
    requiredSkills: requiredSkills.map((skill) => ({ name: skill.name, path: skill.path })),
    attachedSkills: [],
    skillsAttachedAt: null,
    workflowStatusAtDispatch: candidate?.workflowStatus || null,
    assigneeRole,
    assigneeThreadId: data.taskRoutes?.[assigneeRole]?.threadId || null,
    assigneeTitle: data.taskRoutes?.[assigneeRole]?.title || node.owner,
    message: String(message || "").trim(),
    commentId,
    trigger,
    status: "queued",
    runId: null,
    turnId: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    pendingApproval: null,
    agentReply: "",
    completionEvidence: "",
    productionAuthorized: false
  };
  data.dispatches.push(dispatch);
  return dispatch;
}

function createCandidateDispatch(data, map, candidate, {
  nodeId,
  message,
  trigger,
  actor = "system"
}) {
  const node = map.nodes.find((item) => item.id === nodeId);
  validateNodeExecution(node, "candidate", candidate);
  const timestamp = now();
  const comment = {
    id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    message,
    nodeId: node.id,
    scope: "candidate",
    dispatchId: null,
    requiresResponse: true,
    status: "pending",
    replyTo: null,
    at: timestamp
  };
  candidate.comments ||= [];
  candidate.comments.push(comment);
  const dispatch = createDispatchRecord(data, {
    node,
    scope: "candidate",
    candidate,
    message,
    commentId: comment.id,
    trigger
  });
  comment.dispatchId = dispatch.id;
  return dispatch;
}

function appendControlAlert(data, alert) {
  data.controlAlerts ||= [];
  if (data.controlAlerts.some((item) => item.dedupeKey === alert.dedupeKey)) return false;
  data.controlAlerts.push(alert);
  return true;
}

async function stopRunsWithoutProgress() {
  return mutateDataWhenChanged((data) => {
    const alerts = stopNoProgressRuns(data.candidates, new Date(), NO_PROGRESS_TIMEOUT_MINUTES);
    if (!alerts.length) return { changed: false, result: [] };
    for (const alert of alerts) {
      const candidate = data.candidates.find((item) => item.id === alert.candidateId);
      if (candidate) {
        addHistory(candidate, "system", "stoppedNoProgress", alert.message, alert.createdAt);
        candidate.updatedAt = alert.createdAt;
        candidate.lastModifiedBy = "system";
      }
      appendControlAlert(data, alert);
    }
    return { changed: true, result: alerts };
  });
}

function cleanUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    const kept = new URLSearchParams();
    for (const key of ["offerId", "hotSaleSkuId", "sku", "skuId", "product_id"]) {
      if (parsed.searchParams.has(key)) kept.set(key, parsed.searchParams.get(key));
    }
    parsed.search = kept.toString();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function candidateLinks(candidate) {
  return [candidate.productUrl, candidate.sourceUrl, candidate.competitorUrl]
    .map(cleanUrl)
    .filter(Boolean);
}

function duplicateCandidate(candidates, links, exceptId = "") {
  const requested = new Set(links.map(cleanUrl).filter(Boolean));
  if (!requested.size) return null;
  return candidates.find(
    (candidate) =>
      candidate.id !== exceptId &&
      candidateLinks(candidate).some((link) => requested.has(link))
  );
}

function nextCandidateId(candidates, prefix) {
  const date = businessDate().replaceAll("-", "");
  const base = `${prefix}-${date}-`;
  const highest = candidates.reduce((maximum, candidate) => {
    if (!candidate.id.startsWith(base)) return maximum;
    return Math.max(maximum, Number(candidate.id.slice(base.length)) || 0);
  }, 0);
  return `${base}${String(highest + 1).padStart(3, "0")}`;
}

function addHistory(candidate, actor, action, detail, at = now()) {
  candidate.history ||= [];
  candidate.history.push({
    id: `H-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    action,
    detail,
    at
  });
}

function queuedProcessing(previous = {}) {
  return {
    state: "queued",
    runId: null,
    startedAt: null,
    claimRevision: null,
    attempts: Number(previous.attempts || 0),
    attemptsToday: Number(previous.attemptsToday || 0),
    lastAttemptAt: previous.lastAttemptAt || null,
    lastError: previous.lastError || null,
    blockReason: previous.blockReason || null,
    userAction: previous.userAction || "",
    readAttempts: Array.isArray(previous.readAttempts) ? previous.readAttempts : [],
    deferredUntil: previous.deferredUntil || null,
    deferredRunId: previous.deferredRunId || null,
    lastAttemptRevision: previous.lastAttemptRevision ?? null,
    lastAttemptBusinessDate: previous.lastAttemptBusinessDate || null,
    dispatchState: previous.dispatchState || null,
    dispatchPriority: previous.dispatchPriority || null,
    dispatchRequestedAt: previous.dispatchRequestedAt || null,
    dispatchTrigger: previous.dispatchTrigger || null,
    manualHold: previous.manualHold === true,
    normalizedAt: previous.normalizedAt || null,
    normalizedFrom: previous.normalizedFrom || null,
    recoveryOptions: Array.isArray(previous.recoveryOptions) ? previous.recoveryOptions : [],
    currentStep: previous.currentStep || "",
    lastProgressAt: previous.lastProgressAt || null,
    progressEvents: Array.isArray(previous.progressEvents) ? previous.progressEvents : [],
    attemptLedger: Array.isArray(previous.attemptLedger) ? previous.attemptLedger : [],
    lastRunId: previous.lastRunId || null,
    stoppedAt: previous.stoppedAt || null,
    stopReason: previous.stopReason || "",
    controlAlertKey: previous.controlAlertKey || ""
  };
}

function capturedSkuLabel(sku) {
  const attributes = Object.entries(sku?.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
  return [sku?.sourceSkuId, attributes || sku?.propPath].filter(Boolean).join(" · ");
}

function markSourceCaptureFailure(current, session, code, detail = "", observedAt = now(), failureDiagnostics = null) {
  const failureDestinationLabel = sourceCaptureFailureDestinationLabel(failureDiagnostics, code);
  const reason = sourceCaptureFailureMessage(code, failureDestinationLabel || detail);
  current.sourceCapture = {
    captureId: session.captureId,
    status: "failed",
    offerId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    originalSourceUrl: session.originalSourceUrl,
    observedAt,
    failureCode: code,
    failureLayer: "source_page_extension_capture",
    failureDiagnostics: failureDiagnostics ? structuredClone(failureDiagnostics) : null,
    failureDestinationLabel,
    reason,
    mode: session.mode,
    jobId: session.jobStatus ? session.captureId : null,
    jobStatus: session.jobStatus ? "failed" : null,
    attempt: Number(session.attempt || 0),
    requiredExtensionVersion: session.requiredExtensionVersion || null,
    writeOccurred: false
  };
  if (session.mode === "a_supplier_capture") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = now();
    current.lastModifiedBy = "system";
    addHistory(current, "system", "aSupplierCaptureStopped", `${reason}；A阶段业务状态保持不变，没有选择SKU、确认供应方案、运行B/C1或派发任务`, observedAt);
    return;
  }
  if (session.mode === "listed_evidence_recovery") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = now();
    current.lastModifiedBy = "system";
    addHistory(current, "system", "listedSourceCaptureStopped", `${reason}；已上架记录保持不变，没有派发任务或产生店铺写入`, observedAt);
    return;
  }
  current.workflowStatus = "listing_preparation";
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "blocked",
    sourceCaptureId: session.captureId,
    failureLayer: "source_page_extension_capture",
    reason,
    stoppedAt: now(),
    writeOccurred: false
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "blocked",
    owner: "listing_task",
    runId: null,
    currentStep: "1688采集已停止",
    blockReason: reason,
    userAction: "处理页面问题后，可在评审台重新采集当前SKU一次",
    stoppedAt: now(),
    defaultStock: 100
  };
  current.processing = { ...queuedProcessing(current.processing), state: "idle" };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = now();
  current.lastModifiedBy = "system";
  addHistory(current, "system", "sourceCaptureStopped", `${reason}；没有派发任务或产生店铺写入`, observedAt);
}

function markAStageCaptureNeedsOwnerSelection(current, session, evidence) {
  const timestamp = now();
  current.sourceUrl = evidence.sourceUrl;
  current.sourceCapture = {
    captureId: session.captureId,
    status: "captured_waiting_owner_selection",
    mode: "a_supplier_capture",
    jobId: session.captureId,
    jobStatus: "completed",
    attempt: Number(session.attempt || 1),
    requiredExtensionVersion: session.requiredExtensionVersion || null,
    originalSourceUrl: session.originalSourceUrl,
    sourceUrl: evidence.sourceUrl,
    offerId: evidence.offerId,
    title: evidence.title,
    offerStatus: evidence.offerStatus,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    pageSelectedSkuId: evidence.pageSelectedSkuId,
    priceRanges: evidence.priceRanges,
    pageFields: evidence.pageFields,
    supplierAttributes: evidence.supplierAttributes,
    skuChoices: evidence.skus,
    selectedSkuIds: [],
    ownerSupplyConfirmed: false,
    suggestedSkuIds: [],
    matchTerms: [],
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "system";
  addHistory(current, "system", "aSupplierCaptureCompleted", `已取得1688精确链接offer/${evidence.offerId}及${evidence.skus.length}个真实SKU；等待主人多选，未自动选择、确认供应方案、运行B/C1或派发任务`, timestamp);
}

function markSourceCaptureNeedsSelection(current, session, evidence, resolution) {
  const timestamp = now();
  current.sourceCapture = {
    captureId: session.captureId,
    status: "needs_sku_selection",
    offerId: evidence.offerId,
    sourceUrl: evidence.sourceUrl,
    title: evidence.title,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    mode: session.mode,
    priceRanges: evidence.priceRanges,
    supplierAttributes: evidence.supplierAttributes,
    matchTerms: resolution.matchTerms || [],
    suggestedSkuIds: (resolution.matches || []).map((sku) => sku.sourceSkuId),
    skuChoices: resolution.choices
  };
  if (session.mode === "listed_evidence_recovery") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    addHistory(current, "system", "listedSourceCaptureNeedsSkuSelection", "已取得1688全部SKU；已上架记录保持不变，等待主人选择准确规格", timestamp);
    return;
  }
  current.workflowStatus = "listing_preparation";
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "needs_decision",
    sourceCaptureId: session.captureId,
    reason: sourceCaptureFailureMessage("sku_ambiguous")
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "needs_decision",
    owner: "listing_task",
    runId: null,
    currentStep: "已取得1688全部SKU，等待主人选择一个或多个规格",
    blockReason: sourceCaptureFailureMessage("sku_ambiguous"),
    userAction: "请在评审台勾选本次要采购的一个或多个SKU",
    defaultStock: 100
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "system";
  addHistory(current, "system", "sourceCaptureNeedsSkuSelection", "1688结构化数据已取得；目标规格未唯一匹配，因此没有派发任务", timestamp);
}

function saveListedSourceEvidence(current, evidence, resolution) {
  const timestamp = now();
  const selectedSkus = resolution.selected;
  const missingDirectPriceSkuIds = resolution.missingDirectPriceSkuIds || [];
  current.sourceCapture = {
    ...(current.sourceCapture || {}),
    status: "verified",
    mode: "listed_evidence_recovery",
    selectedSkus,
    missingDirectPriceSkuIds,
    skuChoices: undefined,
    suggestedSkuIds: undefined,
    verifiedAt: timestamp,
    writeOccurred: false
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "user";
  const selectedText = selectedSkus.map(capturedSkuLabel).join("；");
  const priceGapText = missingDirectPriceSkuIds.length
    ? `；SKU ${missingDirectPriceSkuIds.join("、")}未取得页面直接价格`
    : "";
  addHistory(current, "user", "listedSourceCaptureVerified", `已上架商品补采1688证据完成：${selectedText}${priceGapText}；原上架记录保持不变，未派发任务或产生店铺写入`, timestamp);
}

function queueCapturedListingPreparation(data, map, current, session, evidence, resolution, trigger) {
  const timestamp = now();
  const selectedSkus = resolution.selected;
  const missingDirectPriceSkuIds = resolution.missingDirectPriceSkuIds || [];
  current.workflowStatus = "listing_preparation";
  current.readyAt = null;
  current.cCompletedAt = null;
  current.sourceCapture = {
    captureId: session.captureId,
    status: "verified",
    offerId: evidence.offerId,
    sourceUrl: evidence.sourceUrl,
    title: evidence.title,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    matchTerms: resolution.matchTerms || [],
    selectedSkus,
    missingDirectPriceSkuIds,
    priceRanges: evidence.priceRanges,
    supplierAttributes: evidence.supplierAttributes
  };
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "queued",
    sourceCaptureId: session.captureId,
    capturedSourceSkus: selectedSkus.map(capturedSkuLabel),
    capturedSourcePricesCny: selectedSkus.map((sku) => sku.priceCny),
    requestedAt: timestamp,
    requestedBy: "user"
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "queued",
    owner: "listing_task",
    queuedAt: timestamp,
    runId: null,
    currentStep: "1688 SKU选择已保存，等待上架任务继续C阶段",
    blockReason: null,
    defaultStock: 100,
    inheritedInputRevision: Number(current.dataRevision || 0),
    sourceCaptureId: session.captureId
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "user";
  const selectedText = selectedSkus.map(capturedSkuLabel).join("；");
  const priceGapText = missingDirectPriceSkuIds.length
    ? `；其中SKU ${missingDirectPriceSkuIds.join("、")}未取得页面直接价格，必须在C阶段继续核验，不得用阶梯最低价或默认值兜底`
    : "";
  const message = `主人已从评审台完成1688只读采集并选择SKU：offer ${evidence.offerId}，共${selectedSkus.length}个：${selectedText}${priceGapText}；沿用前期已填采购到手总价、真实打包重量尺寸、目标店铺和B阶段证据，只由上架任务继续当前商品C阶段核验，不得执行店铺写入`;
  const dispatch = createCandidateDispatch(data, map, current, {
    nodeId: "M07",
    message,
    trigger,
    actor: "user"
  });
  addHistory(current, "user", "sourceCaptureVerified", `1688已选择${selectedSkus.length}个SKU并向上架任务派发一次C阶段：${selectedText}`, timestamp);
  return dispatch;
}

function completeListing(current, listingRecord, actor, timestamp) {
  current.workflowStatus = "listed";
  current.listingRecord = listingRecord;
  current.listedAt = listingRecord.confirmedAt;
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "completed",
    owner: "listing_task",
    completedAt: listingRecord.confirmedAt,
    completionMethod: listingRecord.method
  };
  current.processing = { ...queuedProcessing(current.processing), state: "idle" };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = actor;
}

function effectiveNeeds(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const reviewNeeds = candidate.codexReview?.needsFromUser;
  const needs = Array.isArray(reviewNeeds) && reviewNeeds.length
    ? reviewNeeds
    : requiredInputFields(candidate).map((item) => item.label);
  return needs.filter((need) => {
    const label = String(need);
    // “采购到手总价（含国内运费）”是一个完整的用户输入，不能因为
    // 文案中出现“国内运费”就被当成应由系统处理的独立运费字段过滤掉。
    if (/采购到手总价|采购价|货价/.test(label)) return true;
    return !/包材成本|包装成本|国内运费|合规|认证|授权|权属/.test(label);
  });
}

function effectiveNeededFields(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const requested = candidate.codexReview?.needsFromUserFields;
  const valid = Array.isArray(requested)
    ? requested.filter(
        (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
      )
    : [];
  if (valid.length) return filterUserNeededFields(candidate, valid);

  const inferred = [];
  for (const rawNeed of effectiveNeeds(candidate)) {
    const need = String(rawNeed);
    if (/SKU|款式|型号/.test(need)) inferred.push("productName");
    if (/链接|1688|货源/.test(need)) inferred.push(candidate.sourceUrl ? "productUrl" : "sourceUrl");
    if (/采购价|货价|到手总价/.test(need)) inferred.push("purchasePriceRmb");
    if (/重量|实重/.test(need)) inferred.push("packedWeightKg");
    if (/尺寸|长宽高/.test(need)) inferred.push("dimensionsCm");
    if (/非电|带电|电池/.test(need)) inferred.push("powered");
    if (/厚度|防碎|包装说明|补充说明/.test(need)) inferred.push("notes");
  }
  return filterUserNeededFields(candidate, [...new Set(inferred)].filter(
    (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
  ));
}

function publicCandidate(candidate, rules, queueInfo = {}, evidencePacks = []) {
  const userDecision = candidate.userEvaluation?.decision || null;
  const codexDecision = candidate.codexReview?.decision || null;
  const opinionsDiffer =
    Boolean(userDecision && codexDecision) &&
    !(
      (userDecision === "viable" && codexDecision === "approved") ||
      (userDecision === "unsure" && ["approved", "sourcePending", "needsInfo"].includes(codexDecision)) ||
      (userDecision === "reject" && codexDecision === "eliminated")
    );
  const realAEligible =
    !candidate.lifecycleV11?.skuPackage &&
    !candidate.lifecycleV11?.aConfirmationReceipt &&
    ["awaiting_user_direction", "needs_user_data", "codex_processing"].includes(candidate.workflowStatus);
  let evidenceCandidate = candidate;
  let evidenceContextFailure = null;
  if (realAEligible) {
    try {
      evidenceCandidate = applyLifecycleBEvidenceContext(candidate, {
        guooFilePath: process.env.SELECTION_REVIEW_GUOO_TARIFF_FILE
      }).candidate;
    } catch (error) {
      evidenceContextFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const systemEvidenceReadiness = realAEligible
    ? inspectLifecycleBInputReadiness({ candidate: evidenceCandidate, evidencePacks })
    : null;
  let c1KeywordSoftwarePlanningView = null;
  if (candidate.lifecycleV11?.skuPackage?.businessPhase === "C1") {
    const readinessReceipt = candidate.lifecycleV11?.c1KeywordPlanningProductionV1;
    if (["not_ready", "blocked"].includes(readinessReceipt?.status) &&
        readinessReceipt.resultCandidateRevision === candidate.dataRevision) {
      c1KeywordSoftwarePlanningView = {
        status: "not_ready",
        readinessClass: readinessReceipt.status,
        mode: null,
        gaps: structuredClone(readinessReceipt.gaps || []),
        providerCalls: 0,
        automaticRetries: 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    } else try {
      const plan = buildC1KeywordSoftwareJobPlan({
        candidate,
        expectedRevision: candidate.dataRevision,
        plannedAt: now(),
        existingPlan: candidate.lifecycleV11?.c1KeywordSoftwareJobPlanV1 ?? null
      });
      c1KeywordSoftwarePlanningView = {
        status: plan.status,
        readinessClass: plan.readinessClass,
        mode: plan.mode,
        gaps: structuredClone(plan.gaps || []),
        providerCalls: plan.executionPolicy?.provider === "seerfar_open_api" ? 1 : 0,
        automaticRetries: plan.executionPolicy?.automaticRetries ?? 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    } catch {
      c1KeywordSoftwarePlanningView = {
        status: "not_ready",
        readinessClass: "planner_rejected_current_data",
        mode: null,
        gaps: [{ code: "planner_rejected_current_data", field: "lifecycleV11", message: "当前C1冻结数据未通过服务端计划校验" }],
        providerCalls: 0,
        automaticRetries: 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    }
  }
  return {
    ...candidate,
    c1KeywordSoftwarePlanningView,
    executionRuntimeView: buildExecutionRuntimeView(candidate),
    dESoftwareRuntimeView: buildDESoftwareIntegrationView({ candidate, inspectedAt: now() }),
    lifecycleEntryPreview: realAEligible ? buildRealLifecycleEntryPreview(candidate) : null,
    realAConfirmationCard: realAEligible ? buildRealAConfirmationCard(candidate, {
      systemEvidenceReadiness: evidenceContextFailure ? {
        ...systemEvidenceReadiness,
        contextFailure: evidenceContextFailure
      } : systemEvidenceReadiness,
      systemEvidencePreparationPlan: buildLifecycleBEvidencePreparationPlan({
        candidate: evidenceCandidate,
        evidencePacks,
        plannedAt: systemEvidenceReadiness.checkedAt
      })
    }) : null,
    processingStatus: processingStatusSummary(candidate, new Date(), queueInfo),
    owner:
      ["listing_preparation", "ready_to_list", "listed"].includes(candidate.workflowStatus)
        ? "listing_task"
        : "selection_task",
    purchaseCeiling: purchaseCeilingSummary(candidate, rules),
    displayStatus: candidate.workflowStatus,
    needsFromUser: effectiveNeeds(candidate),
    neededFieldKeys: effectiveNeededFields(candidate),
    approvalGate: approvalGate(candidate, rules),
    profitReviewGate: profitReviewGate(candidate, rules),
    selectionStage: selectionStage(candidate, rules),
    wbAssessmentGate: candidate.wbAssessment
      ? wbAssessmentDecisionGate(candidate.wbAssessment, candidate, rules)
      : null,
    unansweredCommentCount: (candidate.comments || []).filter(
      (comment) =>
        comment.actor === "user" &&
        comment.requiresResponse === true &&
        comment.status !== "responded"
    ).length,
    opinionsDiffer
  };
}

function projectC1PaidKeywordSoftwareJob(candidate, runtime) {
  const ref = candidate?.lifecycleV11?.c1PaidKeywordEvidenceJobRefV1;
  if (!ref || ref.jobType !== "c1_paid_keyword_evidence") return null;
  const job = (runtime?.softwareJobs || []).find((entry) =>
    entry.jobId === ref.jobId &&
    entry.jobType === ref.jobType &&
    entry.candidateId === ref.candidateId &&
    entry.skuPackageId === ref.skuPackageId &&
    entry.revision === ref.resultRevision
  );
  if (!job) {
    return {
      schemaVersion: "c1-paid-keyword-software-job-view-v1",
      jobRef: structuredClone(ref),
      status: "not_found",
      externalRequestState: "not_sent",
      jobId: ref.jobId,
      failureClass: "software_job_not_found",
      automaticRetryAllowed: false
    };
  }
  return {
    schemaVersion: "c1-paid-keyword-software-job-view-v1",
    jobRef: structuredClone(ref),
    jobId: job.jobId,
    status: job.status,
    externalRequestState: job.externalRequestState,
    requestedByUserId: job.requestedByUserId,
    ownerUserId: job.ownerUserId,
    workerId: job.workerId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failureClass: job.failureClass,
    automaticRetryAllowed: job.automaticRetryAllowed === true
  };
}

function aiFailureDisposition(error) {
  const code = String(error?.code || "A_TERRA_UNEXPECTED_FAILURE");
  const layer = String(error?.layer || "integration");
  if (code === "MODEL_OUTPUT_SCHEMA_MISMATCH" || layer === "output_schema" || layer === "receipt") {
    return { type: "exception_case", reasonCode: "output_schema_mismatch" };
  }
  const unknownOutcome = Boolean(error?.jobId) && ["gateway_status", "inference"].includes(layer);
  return {
    type: "technical_failure",
    kind: unknownOutcome ? "unknown_outcome" : "external_dependency"
  };
}

async function enrichCapturedSalesSnapshotWithTerra(candidateId, expectedRevision, snapshotId) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source || Number(source.dataRevision) !== Number(expectedRevision)) {
    throw httpError(409, "销售快照保存后商品资料发生变化，Terra辅助整理未启动");
  }
  const salesSnapshot = (source.salesSnapshotsV11 || []).find((item) => item.snapshotId === snapshotId);
  if (!salesSnapshot) throw httpError(409, "刚保存的销售快照不存在，Terra辅助整理未启动");
  if ((salesSnapshot.auxiliaryDrafts || []).some((item) => item.provider === "terra")) {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
  }

  let assisted;
  try {
    assisted = await runAStageTerraAssist({
      candidate: source,
      snapshot: salesSnapshot,
      gatewayUrl: aiGatewayUrl,
      gatewayDeploymentMode: aiGatewayDeploymentMode
    });
  } catch (error) {
    const failure = error instanceof AStageTerraGatewayError
      ? error
      : new AStageTerraGatewayError("A_TERRA_UNEXPECTED_FAILURE", "integration", String(error?.message || error));
    return mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(expectedRevision)) {
        throw httpError(409, "Terra失败回写前商品资料已变化，本轮异常状态未覆盖新数据");
      }
      const timestamp = now();
      const base = current.executionRuntime || createSoftwareExecutionRuntime({
        candidateId: current.id,
        dataRevision: current.dataRevision,
        businessPhase: "A",
        stepId: "A_TERRA_SALES_ASSIST",
        at: timestamp
      });
      const disposition = aiFailureDisposition(failure);
      current.executionRuntime = disposition.type === "exception_case"
        ? openExceptionCase(base, {
          exceptionId: `exception:${current.id}:${current.dataRevision}:a-terra`,
          reasonCode: disposition.reasonCode,
          failureLayer: failure.layer || "integration",
          evidenceRefs: [salesSnapshot.evidenceRef],
          softwareJobId: failure.jobId || null,
          sourceRevision: current.dataRevision,
          at: timestamp
        })
        : blockExecutionForTechnicalFailure(base, {
          failureId: `technical-failure:${current.id}:${current.dataRevision}:a-terra`,
          kind: disposition.kind,
          errorCode: failure.code,
          failureLayer: failure.layer || "integration",
          evidenceRefs: [salesSnapshot.evidenceRef],
          softwareJobId: failure.jobId || null,
          sourceRevision: current.dataRevision,
          at: timestamp
        });
      current.aStageAi = {
        status: "failed",
        taskType: "sales_comparability_assist",
        model: "gpt-5.6-terra",
        jobId: failure.jobId || null,
        attempt: 1,
        failure: {
          code: failure.code,
          layer: failure.layer,
          safeMessageKey: disposition.type === "exception_case"
            ? `exception.${disposition.reasonCode}`
            : `technical_failure.${disposition.kind}`
        },
        businessStateEffect: "unchanged",
        stoppedAt: timestamp
      };
      current.dataRevision += 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "aTerraAssistFailed", `Terra辅助整理在${failure.layer}层停止；A阶段业务结论未改变，未换模型、未重试`, timestamp);
      return publicCandidate(current, data.rules, {}, data.evidencePacks || []);
    });
  }

  return mutateData((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== Number(expectedRevision)) {
      throw httpError(409, "Terra结果返回前商品资料已变化，本轮结果未保存");
    }
    const index = (current.salesSnapshotsV11 || []).findIndex((item) => item.snapshotId === snapshotId);
    if (index < 0) throw httpError(409, "Terra结果对应的销售快照不存在");
    const timestamp = assisted.receipt.completedAt || now();
    current.salesSnapshotsV11[index] = structuredClone(assisted.snapshot);
    const base = current.executionRuntime || createSoftwareExecutionRuntime({
      candidateId: current.id,
      dataRevision: current.dataRevision,
      businessPhase: "A",
      stepId: "A_TERRA_SALES_ASSIST",
      at: timestamp
    });
    const running = startThirdPartyAiStep(base, {
      stepId: "A_TERRA_SALES_ASSIST",
      inputRevision: current.dataRevision,
      inferenceJobId: assisted.jobId,
      at: assisted.receipt.requestedAt || timestamp
    });
    current.executionRuntime = completeExecutionStep(running, {
      outputRevision: current.dataRevision + 1,
      inferenceReceiptId: assisted.receiptId,
      at: timestamp
    });
    current.inferenceReceiptsV1 ||= [];
    if (!current.inferenceReceiptsV1.some((item) => item.receiptId === assisted.receiptId)) {
      current.inferenceReceiptsV1.push({
        receiptId: assisted.receiptId,
        jobId: assisted.jobId,
        model: "gpt-5.6-terra",
        taskType: "sales_comparability_assist",
        attempt: 1,
        evidenceRefs: structuredClone(assisted.receipt.evidenceRefs || []),
        requestHash: assisted.receipt.requestHash,
        outputSchemaHash: assisted.receipt.outputSchemaHash || null,
        validation: structuredClone(assisted.receipt.validation),
        usage: assisted.receipt.usage ?? "unknown",
        completedAt: timestamp
      });
    }
    current.aStageAi = {
      status: "completed",
      taskType: "sales_comparability_assist",
      model: "gpt-5.6-terra",
      jobId: assisted.jobId,
      receiptId: assisted.receiptId,
      attempt: 1,
      authoritative: false,
      businessStateEffect: "unchanged",
      completedAt: timestamp
    };
    current.dataRevision += 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    addHistory(current, "system", "aTerraAssistCompleted", "Terra已基于公开销售快照生成不可覆盖真实字段的A阶段辅助草稿；未作商业决定、未唤醒Codex", timestamp);
    return publicCandidate(current, data.rules, {}, data.evidencePacks || []);
  });
}

async function continueC1SoftwareWhenEvidenceReady(candidateId, expectedRevision) {
  const snapshotData = await readData();
  let source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source || Number(source.dataRevision) !== Number(expectedRevision)) {
    throw httpError(409, "C1软件执行前商品资料发生变化，本轮未启动");
  }
  if (!source.lifecycleV11?.c1KeywordPlanningEvidenceV1) {
    const producedAt = now();
    const planning = await runC1KeywordPlanningEvidenceProduction({
      repository: businessStateRepository,
      runtimeMode: runtimeConfiguration.deploymentMode,
      actor: createActorContext({
        userId: "selection-review-software",
        sessionId: `c1-keyword-planning:${source.id}:${source.dataRevision}`,
        actorType: "software",
        roles: ["operator"],
        source: "selection_review_state_machine",
        authenticatedAt: producedAt
      }),
      candidateId: source.id,
      expectedRevision: source.dataRevision,
      producedAt,
      codexOffline: true
    });
    if (["committed", "already_current", "idempotent_replay"].includes(planning.status)) {
      source = planning.candidate;
      // 本轮只完成确定性的planning evidence生产；付费Seerfar作业必须由后续通用SoftwareJobStore接缝执行。
      return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
    }
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
  }
  const skuPackage = source.lifecycleV11?.skuPackage;
  const evidence = source.lifecycleV11?.c1SoftwareEvidenceV1;
  if (!skuPackage || !evidence || skuPackage.businessPhase !== "C1") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
  }
  if (skuPackage.c1ProductPlan?.status === "seo_draft_ready") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
  }
  const timestamp = now();
  const c1Evidence = resolveC1K3RuntimeEvidence(evidence);
  const result = await runC1SoftwareOrchestration({
    candidateId: source.id,
    candidateRevision: source.dataRevision,
    skuPackage,
    frozenSeoRules: c1Evidence.frozenSeoRules,
    k3KeywordEvidenceSnapshot: c1Evidence.k3KeywordEvidenceSnapshot,
    k3CurrentBinding: c1Evidence.k3CurrentBinding,
    savedKeywordEvidence: c1Evidence.savedKeywordEvidence,
    legacySavedKeywordEvidenceReadOnly: c1Evidence.legacySavedKeywordEvidenceReadOnly,
    frozenComplexityDecision: c1Evidence.frozenComplexityDecision,
    startedAt: timestamp,
    gatewayOptions: { gatewayUrl: aiGatewayUrl, gatewayDeploymentMode: aiGatewayDeploymentMode }
  });

  return mutateData((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== Number(expectedRevision)) {
      throw httpError(409, "C1软件结果返回前商品资料发生变化，本轮结果未保存");
    }
    const currentSku = current.lifecycleV11?.skuPackage;
    if (!currentSku || currentSku.skuPackageId !== skuPackage.skuPackageId ||
        currentSku.dataRevision !== skuPackage.dataRevision) {
      throw httpError(409, "C1软件结果对应的SKU包或修订号已经变化，本轮结果未保存");
    }

    let persistedSkuPackage = result.skuPackage;
    let c2Result = null;
    if (result.status === "completed") {
      c2Result = createC2SoftwareContainer({
        skuPackage: result.skuPackage,
        expectedDataRevision: result.skuPackage.dataRevision,
        assetRegions: { collected: [], aiDrafts: [], finalUploads: [] },
        createdAt: timestamp
      });
      persistedSkuPackage = c2Result.skuPackage;
    }
    current.lifecycleV11.skuPackage = structuredClone(persistedSkuPackage);
    const base = current.executionRuntime || createSoftwareExecutionRuntime({
      candidateId: current.id,
      dataRevision: current.dataRevision,
      businessPhase: "C1",
      stepId: "C1_SOFTWARE_PREPARATION",
      at: timestamp
    });
    base.businessPhase = "C1";
    if (result.status === "completed") {
      const running = startThirdPartyAiStep(base, {
        stepId: "C1_AI_SEO_DRAFT",
        inputRevision: current.dataRevision,
        inferenceJobId: result.inferenceJobId,
        at: result.inferenceReceipt.startedAt || timestamp
      });
      const aiCompleted = completeExecutionStep(running, {
        outputRevision: current.dataRevision + 1,
        inferenceReceiptId: result.inferenceReceiptId,
        at: result.inferenceReceipt.completedAt || timestamp
      });
      aiCompleted.businessPhase = "C2";
      current.executionRuntime = waitForOwner(aiCompleted, {
        stepId: "C2_OWNER_FINAL_ASSETS",
        inputRevision: current.dataRevision + 1,
        at: timestamp,
        detail: "等待主人提供并确认当前SKU的最终图片、视频、首图和顺序"
      });
      current.inferenceReceiptsV1 ||= [];
      if (!current.inferenceReceiptsV1.some((item) => item.receiptId === result.inferenceReceiptId)) {
        current.inferenceReceiptsV1.push({
          receiptId: result.inferenceReceiptId,
          jobId: result.inferenceJobId,
          model: result.inferenceReceipt.modelVersion,
          taskType: "c1_seo_draft",
          attempt: 1,
          inputEvidenceRefs: structuredClone(result.inferenceReceipt.inputEvidenceRefs),
          outputFingerprint: result.inferenceReceipt.outputFingerprint,
          completedAt: result.inferenceReceipt.completedAt
        });
      }
      current.lifecycleV11.status = "c2_waiting_final_uploads";
      current.lifecycleV11.c2SoftwareInputV1 = structuredClone(c2Result.preparedInput);
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "c2_waiting_final_uploads",
        reason: "C1已生成并严格验收draft_only草稿，系统已自动建立C2三素材域；当前只等待主人提供最终上传素材。",
        decisionItems: ["提供当前SKU的最终图片/视频、首图和顺序"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        owner: "listing_task",
        currentStep: "C1完成，C2等待最终素材",
        blockReason: null,
        userAction: "请提供并确认当前SKU的最终素材；采集素材和AI草稿不会自动进入生产。",
        realTaskDispatched: false
      };
      addHistory(current, "system", "c1SoftwareCompletedAndC2Started", `C1软件单次调用${result.inferenceReceipt.modelVersion}并严格验收回执；已原子建立C2空素材域，未派发Codex、未访问平台、未进入D/E`, timestamp);
    } else if (result.status === "not_ready") {
      const running = startSoftwareStep(base, {
        stepId: "C1_INPUT_PREPARATION",
        inputRevision: current.dataRevision,
        at: timestamp
      });
      current.executionRuntime = completeExecutionStep(running, {
        outputRevision: current.dataRevision + 1,
        at: timestamp
      });
      current.lifecycleV11.status = "c1_waiting_evidence";
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "c1_waiting_evidence",
        reason: result.gaps.map((gap) => gap.message).join("；"),
        decisionItems: [],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "blocked",
        owner: "software",
        currentStep: "C1等待软件证据",
        blockReason: result.gaps.map((gap) => gap.code).join(","),
        userAction: "无需主人操作；软件不得从标题拆词或调用兜底路径",
        realTaskDispatched: false
      };
      addHistory(current, "system", "c1SoftwareEvidenceMissing", "C1缺少已保存关键词证据，软件已停止；B利润结论和商品业务状态未改变", timestamp);
    } else if (result.status === "technical_failure") {
      current.executionRuntime = blockExecutionForTechnicalFailure(base, {
        failureId: `technical-failure:${current.id}:${current.dataRevision}:c1-ai`,
        kind: result.technicalFailure.kind,
        errorCode: result.technicalFailure.errorCode,
        failureLayer: result.technicalFailure.failureLayer,
        evidenceRefs: result.technicalFailure.evidenceRefs,
        softwareJobId: result.technicalFailure.softwareJobId,
        sourceRevision: current.dataRevision,
        at: timestamp
      });
      current.lifecycleV11.status = "c1_technical_blocked";
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "c1_technical_blocked",
        reason: result.technicalFailure.message,
        decisionItems: [],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "blocked",
        owner: "software",
        currentStep: result.technicalFailure.kind === "external_dependency"
          ? "C1外部服务故障，软件已安全停止"
          : "C1技术状态已收口，禁止自动重试",
        blockReason: result.technicalFailure.errorCode,
        userAction: "无需主人排查技术；本轮不会自动重试、换模型或改走Codex。",
        realTaskDispatched: false
      };
      addHistory(current, "system", "c1SoftwareTechnicalFailure", `C1在${result.technicalFailure.failureLayer}层安全停止；未重试、未换模型、未唤醒Codex，B利润结论未改变`, timestamp);
    } else {
      current.executionRuntime = openExceptionCase(base, {
        exceptionId: `exception:${current.id}:${current.dataRevision}:c1-ai`,
        reasonCode: result.exceptionCase.reasonCode,
        failureLayer: result.exceptionCase.failureLayer,
        evidenceRefs: result.exceptionCase.evidenceRefs,
        skuPackageId: currentSku.skuPackageId,
        softwareJobId: result.inferenceJobId,
        sourceRevision: current.dataRevision,
        at: timestamp
      });
      current.lifecycleV11.status = "c1_ai_blocked";
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "c1_ai_blocked",
        reason: current.executionRuntime.exceptionCase.message,
        decisionItems: [],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "blocked",
        owner: "controller",
        currentStep: "C1需要技术维护 / ExceptionCase",
        blockReason: result.exceptionCase.errorCode,
        userAction: "无需主人排查技术；ExceptionCase已保存，但未表示Codex已领取。",
        realTaskDispatched: false
      };
      addHistory(current, "system", "c1SoftwareBlocked", `C1在${result.exceptionCase.failureLayer}层停止；未重试、未换模型，B利润结论未改变`, timestamp);
    }
    current.processing = { ...queuedProcessing(current.processing), state: "idle" };
    current.dataRevision += 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    return publicCandidate(current, data.rules, {}, data.evidencePacks || []);
  });
}

async function prepareAndContinueC1FactKeywordEvidence(candidateId, input, { triggerReceipt = null } = {}) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  if (Number(source.dataRevision) !== Number(input.dataRevision)) {
    throw httpError(409, "C1事实与关键词流水线启动前商品资料已变化，请刷新后重新生成当前证据");
  }
  const skuPackage = source.lifecycleV11?.skuPackage;
  if (!skuPackage || skuPackage.businessPhase !== "C1") {
    throw httpError(409, "当前商品没有可进入C1事实与关键词流水线的冻结SKU包");
  }
  if (source.lifecycleV11?.c1SoftwareEvidenceV1) {
    return continueC1SoftwareWhenEvidenceReady(candidateId, source.dataRevision);
  }

  const timestamp = now();
  let prepared;
  try {
    prepared = await prepareC1FactKeywordRuntime({
      candidateId,
      skuPackage,
      input,
      preparedAt: timestamp,
      existingEvidence: null
    });
  } catch (error) {
    throw httpError(422, String(error?.message || error));
  }
  if (prepared.result.status !== "ready_for_atomic_persist") {
    const reason = prepared.result.gaps?.map((item) => item.message).filter(Boolean).join("；") || "C1事实或关键词证据尚未完整";
    throw httpError(422, `C1_FACT_KEYWORD_NOT_READY: ${reason}`);
  }

  const staged = await mutateData((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== Number(input.dataRevision)) {
      throw httpError(409, "C1事实与关键词结果返回前商品资料已变化，本轮没有保存任何证据");
    }
    const currentSku = current.lifecycleV11?.skuPackage;
    if (!currentSku || currentSku.skuPackageId !== skuPackage.skuPackageId ||
        currentSku.dataRevision !== skuPackage.dataRevision) {
      throw httpError(409, "C1事实与关键词结果对应的SKU包已经变化，本轮没有保存任何证据");
    }
    const patch = buildC1FactKeywordAtomicPatch({
      candidate: current,
      expectedRevision: input.dataRevision,
      sourceSkuPackage: skuPackage,
      prepared,
      triggerReceipt,
      stagedAt: timestamp
    });
    current.lifecycleV11 = patch.lifecycleV11;
    current.listingPreparation = patch.listingPreparation;
    current.processing = { ...queuedProcessing(current.processing), ...patch.processing };
    current.dataRevision = patch.nextRevision;
    current.updatedAt = patch.updatedAt;
    current.lastModifiedBy = patch.lastModifiedBy;
    addHistory(current, "system", "c1FactKeywordEvidenceAtomicallyStaged", "C1事实、关键词来源、K3评分与软件证据已一次性保存；未派发Codex、未访问销售或供应平台、未进入C2/D/E", timestamp);
    return { nextRevision: current.dataRevision };
  });
  return continueC1SoftwareWhenEvidenceReady(candidateId, staged.nextRevision);
}

async function continueC1FromKeywordEvidenceReadyEvent(candidateId, event) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  let accepted;
  try {
    accepted = acceptC1KeywordEvidenceReadyEvent({ candidate: source, event, acceptedAt: now() });
  } catch (error) {
    throw httpError(409, String(error?.message || error));
  }
  if (accepted.status === "idempotent_replay") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || []);
  }
  return prepareAndContinueC1FactKeywordEvidence(candidateId, accepted.runtimeInput, {
    triggerReceipt: accepted.triggerReceipt
  });
}

async function runC1KeywordEvidenceSoftwareJob(candidateId, input) {
  const timestamp = now();
  const snapshot = await readData();
  const source = snapshot.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  const actor = runtimeIdentityProvider.resolveActor({ sessionId: `c1-paid-keyword:${candidateId}` });
  let outcome;
  try {
    outcome = await enqueueC1PaidKeywordEvidenceJob({
      repository: businessStateRepository,
      runtimeMode: "local_development",
      actor,
      candidateId,
      expectedRevision: source.dataRevision,
      clientInput: input,
      serverTime: timestamp,
      serverClock: () => now()
    });
  } catch (error) {
    const message = String(error?.message || error);
    throw httpError(message.includes("CLIENT_INPUT_REJECTED") ? 400 : message.includes("REVISION_CONFLICT") ? 409 : 422, message);
  }
  if (outcome.status === "reuse_ready") {
    return prepareAndContinueC1FactKeywordEvidence(candidateId, outcome.reuseInput);
  }
  if (outcome.status === "not_ready") {
    throw httpError(422, "C1_KEYWORD_SOFTWARE_NOT_READY: 服务端冻结证据尚未达到执行门槛", {
      readinessClass: outcome.readinessClass,
      gaps: outcome.gaps
    });
  }
  const data = await readData();
  const current = data.candidates.find((item) => item.id === candidateId);
  if (!current) throw httpError(404, "候选不存在");
  return publicCandidate(current, data.rules, {}, data.evidencePacks || []);
}

function responseState(data) {
  const rules = data.rules || DEFAULT_RULES;
  const dispatch = dispatchQueueSummary(data.candidates, new Date(), automationConcurrencyLimit);
    const candidates = data.candidates.map((candidate) => {
    const publicValue = publicCandidate(
      candidate,
      rules,
      dispatch.positions[candidate.id] || {},
      data.evidencePacks || []
    );
    const activeDispatch = activeDispatchForCandidate(data, candidate.id);
    const latestDispatch = latestDispatchForCandidate(data, candidate.id);
    return {
      ...publicValue,
      c1PaidKeywordSoftwareJob: projectC1PaidKeywordSoftwareJob(candidate, data.runtime),
      activeDispatch: dispatchPublic(activeDispatch),
      latestDispatch: dispatchPublic(latestDispatch)
    };
  });
  return {
    meta: data.meta,
    rules,
    extensionHeartbeat: extensionHeartbeatSnapshot(),
    captureControl: captureControlSnapshot(),
    runtimeArchitecture: {
      ...runtimeArchitecture,
      currentUser: (() => {
        const actor = runtimeIdentityProvider.resolveActor();
        return { userId: actor.userId, roles: actor.roles };
      })(),
      workers: workerRegistry.snapshot().map((worker) => ({
        workerId: worker.workerId,
        capabilities: worker.capabilities,
        status: worker.status,
        heartbeatCurrent: worker.heartbeatCurrent
      }))
    },
    summary: {
      ...dailySummary(data.candidates, rules),
      dispatch: {
        ...dispatch,
        processingCounts: collaborationSummary(data, dispatch.processingCounts)
      },
      controlAlertsPending: (data.controlAlerts || []).filter((item) => !item.acknowledgedAt).length
    },
    evidencePacks: (data.evidencePacks || []).map((pack) => ({
      id: pack.id,
      kind: pack.kind,
      scope: pack.scope,
      summary: pack.summary,
      sourceType: pack.sourceType,
      checkedAt: pack.checkedAt,
      expiresAt: pack.expiresAt,
      status: pack.status
    })),
    candidates
  };
}

function validateStore(store) {
  if (!["dandanshu", "miska", "wb"].includes(store)) {
    throw httpError(400, "请选择目标店铺");
  }
}

function initialCandidate(input, source, id, timestamp) {
  const candidate = {
    id,
    source,
    group: source === "user" ? "userAdded" : input.group || "evergreen",
    targetStore: input.targetStore,
    productName: input.productName?.trim() || (source === "user" ? "用户添加的待识别商品" : "系统新增候选"),
    productUrl: input.productUrl?.trim() || "",
    sourceUrl: input.sourceUrl?.trim() || "",
    competitorUrl: input.competitorUrl?.trim() || "",
    purchasePriceRmb: input.purchasePriceRmb ?? null,
    domesticShippingRmb: input.domesticShippingRmb ?? null,
    packagingCostRmb: input.packagingCostRmb ?? DEFAULT_PACKAGING_COST_RMB,
    moq: input.moq ?? null,
    netWeightKg: input.netWeightKg ?? null,
    packedWeightKg: input.packedWeightKg ?? null,
    dimensionsCm: input.dimensionsCm || { length: null, width: null, height: null },
    materialsAndAge: input.materialsAndAge?.trim() || "",
    powered: input.powered ?? "unknown",
    complianceStatus: input.complianceStatus || "needs_confirmation",
    authorizationStatus: input.authorizationStatus || "needs_confirmation",
    expectedPriceRub: input.expectedPriceRub ?? null,
    sellerRevenueCny: input.sellerRevenueCny ?? null,
    purchaseCeiling: input.purchaseCeiling || {
      status: "unavailable",
      scope: "purchase_plus_domestic_shipping",
      missing: ["Codex尚未完成方向采购价反算"]
    },
    acceptedTestRisk: input.acceptedTestRisk === true,
    imageUrl: input.imageUrl?.trim() || "",
    notes: input.notes?.trim() || "",
    createdAt: timestamp,
    updatedAt: timestamp,
    reviewedAt: null,
    lastModifiedBy: source,
    userEvaluation: null,
    codexReview: null,
    comments: [],
    history: [],
    workflowStatus: "awaiting_user_direction",
    processing: { ...queuedProcessing(), state: "idle" },
    dataRevision: 1,
    selectionDate: businessDate(timestamp),
    readyAt: null,
    bPassedAt: null,
    cCompletedAt: null,
    listingPreparation: null,
    defaultStock: 100,
    eliminatedAt: null,
    eliminationReason: "",
    wbAssessment: null,
    sourceSearchAttempts: Number(input.sourceSearchAttempts || 0),
    sourceSearchAttemptLimit: 3
  };
  if (source === "user") {
    candidate.executionRuntime = createSoftwareExecutionRuntime({
      candidateId: id,
      dataRevision: candidate.dataRevision,
      businessPhase: "A",
      stepId: "A_WAITING_OWNER_DIRECTION",
      at: timestamp
    });
  }
  return candidate;
}

async function handleApi(req, res, pathname) {
  assertTrustedApiRequest({
    method: req.method,
    pathname,
    headers: req.headers,
    trustedServiceOrigins: [...trustedServiceOrigins],
    allowedReviewOrigins: [...allowedReviewOrigins],
    allowedExtensionOrigins: [...allowedExtensionOrigins],
    internalRequestToken: internalApiRequestToken
  });
  if (req.method === "OPTIONS" && (pathname === "/api/extension/heartbeat" || /^\/api\/candidates\/[^/]+\/(?:source-capture|sales-capture)\/result$/.test(pathname))) {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受本机Chrome扩展回传");
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (req.method === "POST" && pathname === "/api/extension/heartbeat") {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受本机Chrome扩展心跳");
    const heartbeat = recordExtensionHeartbeat(await requestBody(req));
    const claim = heartbeat.backgroundReady
      ? await claimPendingASupplierCaptureJob(heartbeat.version, String(req.headers.origin || ""))
      : { captureJob: null, jobNotice: null };
    return json(res, 200, { accepted: true, heartbeat, ...claim }, headers);
  }
  if (req.method === "GET" && pathname === "/api/health") {
    const data = await readData();
    return json(res, 200, {
      ok: true,
      service: "selection-review-app",
      version: 2,
      dataVersion: data.meta.version,
      extensionHeartbeat: extensionHeartbeatSnapshot(),
      captureControl: captureControlSnapshot(),
      checkedAt: now()
    });
  }

  if (req.method === "GET" && pathname === "/api/simulations/phase-2a") {
    return json(res, 200, { card: phase2ADemoCard() });
  }

  if (req.method === "GET" && pathname === "/api/simulations/software-execution") {
    return json(res, 200, {
      result: simulateNormalSoftwarePath(),
      persistence: {
        sharedCandidatesWritten: 0,
        dispatchesCreated: 0,
        codexTasksWoken: 0,
        platformAccesses: 0,
        platformWrites: 0
      }
    });
  }

  if (req.method === "POST" && pathname === "/api/simulations/phase-2a/confirm") {
    const input = await requestBody(req);
    const result = runPhase2AConfirmation(input);
    return json(res, 200, {
      result,
      profitSummary: phase2AResultSummary(result),
      persistence: {
        sharedCandidatesWritten: 0,
        dispatchesCreated: 0,
        platformAccesses: 0,
        platformWrites: 0
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return json(res, 200, responseState(await readData()));
  }

  const lifecycleBEvidencePrepareRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/b-evidence\/prepare$/);
  if (req.method === "POST" && lifecycleBEvidencePrepareRoute) {
    const candidateId = lifecycleBEvidencePrepareRoute[1];
    const input = await requestBody(req);
    const snapshot = await readData();
    const candidate = snapshot.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw httpError(404, "候选不存在");
    if (Number(input.dataRevision) !== Number(candidate.dataRevision)) {
      throw httpError(409, "商品资料已变化，请刷新后重新开始一次只读取证");
    }
    if (activeDispatchForCandidate(snapshot, candidate.id)) {
      throw httpError(409, "当前SKU已有负责人任务，不能同时启动系统证据读取");
    }

    const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, candidateProfitRule(candidate, snapshot.rules));
    const plannedAt = now();
    const providers = createLifecycleBRealEvidenceProviderRegistry({
      otherCosts,
      ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
      guooFilePath: process.env.SELECTION_REVIEW_GUOO_TARIFF_FILE,
      cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
    });
    const run = await runLifecycleBEvidencePreparation({
      candidate,
      evidencePacks: snapshot.evidencePacks || [],
      providers,
      plannedAt,
    });
    if (run.status !== "completed") {
      throw httpError(422, `B阶段系统证据读取已停止：${run.failure?.reason || "未知失败"}`, {
        evidencePreparation: run
      });
    }
    if (run.evidencePacksToCommit.length === 0) {
      return json(res, 200, {
        evidencePreparation: run,
        evidencePacks: [],
        candidateStateChanged: false,
        dispatchesCreated: 0,
        platformWrites: 0
      });
    }

    const committed = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "取证期间商品资料已变化，本轮结果未保存");
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "取证期间SKU已被负责人领取，本轮结果未保存");
      }
      return commitLifecycleBEvidencePacks(data, run.evidencePacksToCommit, {
        createdAt: now(),
        createdBy: "selection_review_b_evidence"
      });
    });
    return json(res, 201, {
      evidencePreparation: run,
      evidencePacks: committed.map((pack) => ({
        id: pack.id,
        kind: pack.kind,
        scope: pack.scope,
        summary: pack.summary,
        sourceType: pack.sourceType,
        sourceRef: pack.sourceRef,
        checkedAt: pack.checkedAt,
        expiresAt: pack.expiresAt,
        ruleVersion: pack.ruleVersion,
        status: pack.status
      })),
      candidateStateChanged: false,
      dispatchesCreated: 0,
      platformWrites: 0
    });
  }

  if (req.method === "POST" && pathname === "/api/evidence-packs") {
    const input = await requestBody(req);
    if (!input.kind?.trim() || !input.summary?.trim() || !input.checkedAt || !input.sourceType?.trim()) {
      throw httpError(400, "共享证据包必须包含类型、摘要、来源类型和取得时间");
    }
    if (!input.scope || typeof input.scope !== "object" || Array.isArray(input.scope)) {
      throw httpError(400, "共享证据包必须包含明确适用范围");
    }
    if (Number.isNaN(new Date(input.checkedAt).getTime())) throw httpError(400, "共享证据取得时间无效");
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) throw httpError(400, "共享证据失效时间无效");
    if (/token|cookie|password|secret/i.test(JSON.stringify(input))) {
      throw httpError(400, "共享证据包不得包含Token、Cookie、密码或密钥字段");
    }
    const result = await mutateData((data) => {
      const kind = input.kind.trim();
      if (!data.rules.evidenceReuse?.reusableKinds?.includes(kind)) {
        throw httpError(422, "该证据类型不能跨SKU复用");
      }
      const scope = normalizedEvidenceScope(input.scope);
      const requiredScope = {
        commission: ["platform", "store", "category", "salesScheme"],
        exchange_rate: ["pair"],
        logistics_tariff: ["route", "ruleVersion"],
        schema: ["platform", "store", "category", "ruleVersion"],
        electrical_rule: ["platform", "route", "ruleVersion"]
      }[kind] || [];
      const missingScope = requiredScope.filter((key) => !scope[key]);
      if (missingScope.length) throw httpError(422, `共享${kind}证据缺适用范围：${missingScope.join("、")}`);
      let evidenceData = null;
      if (input.evidenceData !== undefined) {
        if (!String(input.sourceRef || "").trim()) {
          throw httpError(422, `共享${kind}结构化数据必须包含可追溯来源`);
        }
        if (!input.expiresAt) {
          throw httpError(422, `共享${kind}结构化数据必须包含失效时间`);
        }
        if (Date.parse(input.expiresAt) <= Date.parse(input.checkedAt)) {
          throw httpError(422, `共享${kind}结构化数据失效时间必须晚于取得时间`);
        }
        const validation = validateLifecycleEvidenceData(kind, input.evidenceData);
        if (!validation.valid) {
          throw httpError(422, `共享${kind}结构化数据无效：${validation.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
        }
        evidenceData = structuredClone(input.evidenceData);
      }
      const scopeKey = evidenceScopeKey(kind, scope);
      const timestamp = now();
      const existing = (data.evidencePacks || []).find((pack) => pack.scopeKey === scopeKey && pack.status === "active");
      if (existing) existing.status = "superseded";
      const pack = {
        id: `EP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        scope,
        scopeKey,
        summary: input.summary.trim(),
        sourceType: input.sourceType.trim(),
        sourceRef: String(input.sourceRef || "").trim(),
        checkedAt: new Date(input.checkedAt).toISOString(),
        expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        ruleVersion: String(input.ruleVersion || "").trim(),
        evidenceData,
        status: "active",
        createdAt: timestamp,
        createdBy: String(input.createdBy || "task").trim()
      };
      data.evidencePacks.push(pack);
      return pack;
    });
    return json(res, 201, { evidencePack: result });
  }

  if (req.method === "GET" && pathname === "/api/three-store-map") {
    return json(res, 200, buildThreeStoreMapView({
      runtimeArchitecture,
      seerfarSoftwareExecutionEnabled
    }));
  }

  // Legacy dispatch/comment compatibility only. This candidate progress view is
  // not the user-facing 全店能力地图 and must not be used as code-health evidence.
  if (req.method === "GET" && pathname === "/api/workflow-map") {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    const selectedCandidateId = requestUrl.searchParams.get("candidateId") || "";
    const data = await readData();
    const state = responseState(data);
    const map = await readWorkflowMap(workflowMapFile);
    return json(res, 200, workflowMapView(map, data, state.candidates, selectedCandidateId));
  }

  if (req.method === "POST" && pathname === "/api/node-comments") {
    const input = await requestBody(req);
    if (!input.nodeId?.trim() || !input.message?.trim()) {
      throw httpError(400, "节点留言必须包含节点和内容");
    }
    if (input.action !== "record") {
      throw httpError(409, "小地图只保存节点留言；请回到商品评审主界面派发当前SKU");
    }
    const map = await readWorkflowMap(workflowMapFile);
    const node = map.nodes.find((item) => item.id === input.nodeId.trim());
    const result = await mutateData((data) => {
      const scope = input.scope === "workflow" ? "workflow" : "candidate";
      const candidate = scope === "candidate"
        ? data.candidates.find((item) => item.id === input.candidateId)
        : null;
      validateNodeExecution(node, scope, candidate);
      if (candidate && Number(candidate.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "商品资料已变化，请刷新小地图后重新提交");
      }
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: input.message.trim(),
        nodeId: node.id,
        scope,
        dispatchId: null,
        requiresResponse: false,
        status: "recorded",
        replyTo: null,
        at: timestamp
      };
      if (scope === "workflow") data.workflowComments.push(comment);
      else {
        candidate.comments ||= [];
        candidate.comments.push(comment);
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = "user";
        addHistory(candidate, "user", "nodeCommented", `在${node.id} ${node.title}提交记录留言`, timestamp);
      }
      return { comment, dispatch: null };
    });
    json(res, 201, result);
    return;
  }

  const candidateDispatchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && candidateDispatchRoute) {
    const input = await requestBody(req);
    if (input.trigger === "automatic_stage_continuation") {
      throw httpError(409, "B阶段通过后应进入待上架准备，不再由选品任务自动继续C阶段");
    }
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "派发必须提供当前数据修订号");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const candidate = data.candidates.find((item) => item.id === candidateDispatchRoute[1]);
      if (!candidate) throw httpError(404, "候选不存在");
      if (Number(candidate.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新派发");
      }
      if (candidate.lifecycleV11?.opportunityPackage || candidate.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧通用派发入口；A确认后自动进入B，B通过后自动进入C1，商品状态未改变");
      }
      if (candidate.workflowStatus === "codex_processing") {
        if (candidate.processing?.state !== "queued" || candidate.processing?.manualHold === true) {
          throw httpError(409, "当前商品尚未获得派发许可；已停止商品必须先在主界面选择恢复方式");
        }
      } else if (candidate.workflowStatus === "listing_preparation") {
        throw httpError(409, "请使用主界面的开始上架准备按钮启动C阶段");
      } else if (candidate.workflowStatus === "ready_to_list") {
        throw httpError(409, "可上架商品必须先完成精确生产确认卡，不能普通派发");
      } else {
        throw httpError(409, "当前业务阶段不能直接派发");
      }
      const nodeId = candidateActiveNode(candidate);
      const node = map.nodes.find((item) => item.id === nodeId);
      validateNodeExecution(node, "candidate", candidate);
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: "主人从商品评审主界面明确派发当前SKU一次",
        nodeId: node.id,
        scope: "candidate",
        dispatchId: null,
        requiresResponse: true,
        status: "pending",
        replyTo: null,
        at: timestamp
      };
      candidate.comments ||= [];
      candidate.comments.push(comment);
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = "user";
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate,
        message: comment.message,
        commentId: comment.id,
        trigger: "review_ui_dispatch"
      });
      comment.dispatchId = dispatch.id;
      dispatchId = dispatch.id;
      addHistory(
        candidate,
        "user",
        "reviewUiDispatched",
        `从商品评审主界面向${dispatch.assigneeTitle || dispatch.assigneeRole}派发当前SKU一次`,
        timestamp
      );
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 201, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("主界面一次性派发失败", error)), 0);
    return;
  }

  const dispatchContinueRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/continue$/);
  if (req.method === "POST" && dispatchContinueRoute) {
    const input = await requestBody(req);
    if (!input.message?.trim()) throw httpError(400, "继续原派发必须提供本轮纠正说明");
    if (!input.candidateId?.trim() || !Number.isInteger(input.dataRevision)) {
      throw httpError(400, "继续原派发必须锁定当前SKU和数据修订号");
    }
    let dispatchId = null;
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchContinueRoute[1]);
      if (!dispatch) throw httpError(404, "原派发不存在");
      if (isDisabledLegacyCDispatch(dispatch)) {
        throw httpError(409, "旧C阶段派发只保留为历史记录，不能继续或重新领取");
      }
      if (!["responded_unverified", "blocked", "needs_decision", "failed"].includes(dispatch.status)) {
        throw httpError(409, "原派发当前不是可继续的终止状态");
      }
      if (dispatch.candidateId !== input.candidateId.trim()) {
        throw httpError(409, "原派发与指定SKU不一致");
      }
      const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
      if (!candidate) throw httpError(404, "原派发对应商品不存在");
      const gate = codexDispatchGate(candidate);
      if (!gate.allowed) throw httpError(409, gate.reason);
      if (Number(candidate.dataRevision) !== input.dataRevision || Number(dispatch.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料或原派发修订号已变化，不能继续旧派发", {
          currentRevision: candidate.dataRevision,
          dispatchRevision: dispatch.dataRevision
        });
      }
      const duplicate = data.dispatches.find((item) =>
        item.id !== dispatch.id &&
        item.candidateId === candidate.id &&
        ACTIVE_DISPATCH_STATES.has(item.status) &&
        !isDisabledLegacyCDispatch(item)
      );
      if (duplicate) throw httpError(409, "同一SKU已有其他工作正在等待或执行", { dispatchId: duplicate.id });

      const timestamp = now();
      dispatch.continuationHistory ||= [];
      dispatch.continuationHistory.push({
        turnId: dispatch.turnId || null,
        runId: dispatch.runId || null,
        status: dispatch.status,
        agentReply: dispatch.agentReply || "",
        failureLayer: dispatch.failureLayer || "",
        error: dispatch.error || "",
        completedAt: dispatch.turnCompletedAt || dispatch.lastEventAt || null,
        archivedAt: timestamp
      });
      dispatch.continuationCount = dispatch.continuationHistory.length;
      dispatch.continuedAt = timestamp;
      dispatch.continuationReason = input.reason?.trim() || "总控按主人纠正继续同一B阶段工作";
      dispatch.message = input.message.trim();
      dispatch.trigger = "control_continue_dispatch";
      dispatch.status = "queued";
      dispatch.runId = null;
      dispatch.turnId = null;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      dispatch.agentReply = "";
      dispatch.completionEvidence = "";
      dispatch.deliveryAttemptedAt = null;
      dispatch.deliveryDetail = "";
      dispatch.deliveredAt = null;
      dispatch.startedAt = null;
      dispatch.turnCompletedAt = null;
      dispatch.turnStatus = null;
      dispatch.error = "";
      dispatch.failureLayer = "";
      dispatch.replyCommentId = null;
      dispatch.candidateSnapshot = dispatchCandidateSnapshot(candidate);
      candidate.processing = queueUserDispatch(candidate.processing, timestamp, "control_continue_dispatch");
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = "control_task";
      addHistory(candidate, "control", "oneShotContinued", `原派发${dispatch.id}按主人纠正继续，不创建新派发`, timestamp);
      dispatchId = dispatch.id;
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("原派发继续失败", error)), 0);
    }
    return;
  }

  const productionAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/production-authorization$/);

  const salesCaptureStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sales-capture\/start$/);
  if (req.method === "POST" && salesCaptureStartRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "Ozon采集必须提供当前数据修订号");
    throw httpError(409, "Ozon采集等待插件后台claim协议接线，本次没有创建采集会话或业务写入", {
      code: "sales_capture_claim_protocol_required"
    });
  }

  const salesCaptureResultRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sales-capture\/result$/);
  if (req.method === "POST" && salesCaptureResultRoute) {
    const input = await requestBody(req);
    const session = salesCaptureSession(salesCaptureResultRoute[1], String(input.captureId || ""));
    if (!session || session.candidateId !== salesCaptureResultRoute[1]) throw httpError(409, "Ozon采集会话不存在或已失效");
    assertClaimedCaptureResultOrigin(session, req, "Ozon采集");
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "Ozon采集令牌无效");
    if (!Number.isInteger(input.dataRevision) || input.dataRevision !== session.dataRevision) throw httpError(409, "Ozon采集修订号不一致");
    if (!["captured", "failed"].includes(input.status)) throw httpError(400, "Ozon采集状态无效");

    let candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === session.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== session.dataRevision) throw httpError(409, "商品资料已变化，本次Ozon采集结果已拒绝");
      if (current.salesCapture?.captureId !== session.captureId || current.salesCapture?.status !== "waiting_extension") {
        throw httpError(409, "当前商品不再等待这次Ozon采集结果");
      }
      const timestamp = now();
      if (input.status === "failed") {
        const code = String(input.failureCode || "system_error").trim();
        const observedAt = Number.isFinite(new Date(input.observedAt).getTime()) ? new Date(input.observedAt).toISOString() : timestamp;
        current.salesCapture = {
          ...current.salesCapture,
          status: "failed",
          technicalStatus: salesCaptureTechnicalStatus(code),
          failureCode: code,
          reason: ozonCaptureFailureMessage(code),
          observedAt,
          stoppedAt: timestamp,
          businessStateEffect: "unchanged",
          retryAttempted: false,
          writeOccurred: false
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        addHistory(current, "system", "ozonSalesCaptureFailed", `Ozon只读采集已停止：${ozonCaptureFailureMessage(code)}；商品业务状态未改变`, timestamp);
        return publicCandidate(current, data.rules);
      }

      let snapshot;
      try {
        const validated = sanitizeOzonCaptureEvidence(input.evidence, session.expectedProductId, {
          captureId: session.captureId,
          snapshotId: `sales-snapshot:ozon:${session.expectedProductId}:${session.captureId}`
        });
        snapshot = {
          ...structuredClone(validated),
          sourceCandidateId: current.id,
          sourceDataRevision: session.requestRevision,
          productId: session.expectedProductId,
          captureId: session.captureId
        };
      } catch (error) {
        const code = String(error?.message || "invalid_capture");
        current.salesCapture = {
          ...current.salesCapture,
          status: "failed",
          technicalStatus: salesCaptureTechnicalStatus(code),
          failureCode: code,
          reason: ozonCaptureFailureMessage(code),
          observedAt: timestamp,
          stoppedAt: timestamp,
          businessStateEffect: "unchanged",
          retryAttempted: false,
          writeOccurred: false
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        addHistory(current, "system", "ozonSalesCaptureRejected", "Ozon采集结果未通过服务端校验；商品业务状态未改变", timestamp);
        return publicCandidate(current, data.rules);
      }

      const snapshots = Array.isArray(current.salesSnapshotsV11) ? current.salesSnapshotsV11 : [];
      if (!snapshots.some((item) => item.captureId === session.captureId)) snapshots.push(snapshot);
      current.salesSnapshotsV11 = snapshots;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.salesCapture = {
        ...current.salesCapture,
        status: "verified",
        technicalStatus: "completed",
        snapshotId: snapshot.snapshotId,
        productId: snapshot.productId,
        title: snapshot.title,
        currentPrice: snapshot.currentPrice,
        currency: snapshot.currency,
        imageCount: snapshot.imageRefs.length,
        sellerType: snapshot.sellerType,
        marketScope: snapshot.marketScope,
        observedAt: snapshot.collectedAt,
        completedAt: timestamp,
        businessStateEffect: "unchanged",
        retryAttempted: false,
        writeOccurred: false
      };
      const opportunityPackage = adaptLegacyCandidateToOpportunity(current);
      current.lifecycleV11 = {
        ...(current.lifecycleV11 || {}),
        status: "opportunity_sales_snapshot_captured",
        sourceCandidateId: current.id,
        sourceCandidateRevision: current.dataRevision,
        opportunityPackage: structuredClone(opportunityPackage),
        platformWrites: Number(current.lifecycleV11?.platformWrites || 0),
        externalAccesses: [
          ...(Array.isArray(current.lifecycleV11?.externalAccesses) ? current.lifecycleV11.externalAccesses : []),
          {
            platform: "ozon",
            mode: "read_only_sales_snapshot",
            captureId: session.captureId,
            productId: session.expectedProductId,
            accessedAt: snapshot.collectedAt,
            writeOccurred: false
          }
        ]
      };
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "ozonSalesSnapshotCaptured", `已保存Ozon商品${session.expectedProductId}的当前销售快照；未推进业务阶段`, timestamp);
      return publicCandidate(current, data.rules);
    });
    if (input.status === "captured" && candidate.salesCapture?.status === "verified" && candidate.salesCapture?.snapshotId) {
      candidate = await enrichCapturedSalesSnapshotWithTerra(
        candidate.id,
        candidate.dataRevision,
        candidate.salesCapture.snapshotId
      );
    }
    session.consumedAt = Date.now();
    salesCaptureSessions.delete(session.captureId);
    return json(res, 200, { candidate, dispatch: null }, chromeExtensionCors(req));
  }

  const sourceCaptureStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/start$/);
  if (req.method === "POST" && sourceCaptureStartRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "1688采集必须提供当前数据修订号");
    if (input.mode && !["listed_evidence_recovery", "a_supplier_capture"].includes(input.mode)) throw httpError(400, "1688采集模式无效");
    if (input.mode === "a_supplier_capture") {
      throw httpError(409, "A阶段独立采集按钮已停用：请在新版A确认卡保存供应链接，服务端会建立单候选作业并由插件后台自动领取", {
        code: "manual_a_supplier_capture_retired"
      });
    }
    if (input.mode === "listed_evidence_recovery") {
      throw httpError(409, "已上架1688补采等待插件后台claim协议接线，本次没有创建采集会话或业务写入", {
        code: "listed_source_capture_claim_protocol_required"
      });
    }
    if (!input.mode) {
      throw httpError(409, "旧1688上架采集入口已停用：新版流程必须在A阶段的一张确认卡内确认供应链接、具体SKU、价格、国内运费、采购成本、重量和尺寸；该入口不会创建旧C阶段派发");
    }
    const candidateId = sourceCaptureStartRoute[1];
    const existing = captureSession(candidateId);
    if (existing && existing.mode === input.mode && [existing.requestRevision, existing.dataRevision].includes(input.dataRevision)) {
      const data = await readData();
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      return json(res, 200, { candidate: publicCandidate(current, data.rules), ...captureSessionPublic(existing) });
    }
    ensureCaptureControlAvailable(candidateId);

    const session = {
      captureId: `SC-${randomUUID()}`,
      token: randomBytes(32).toString("base64url"),
      candidateId,
      requestRevision: input.dataRevision,
      dataRevision: null,
      expectedOfferId: "",
      sourceUrl: "",
      originalSourceUrl: "",
      createdAt: Date.now(),
      expiresAt: Date.now() + SOURCE_CAPTURE_TTL_MS,
      recoverySuggestion: String(input.recoverySuggestion || "").trim().slice(0, 1500),
      mode: input.mode
    };
    sourceCaptureSessions.set(session.captureId, session);
    let candidate;
    try {
      candidate = await mutateData((data) => {
        const current = data.candidates.find((item) => item.id === candidateId);
        if (!current) throw httpError(404, "候选不存在");
        if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后再采集1688");
        if (!sourceCaptureAllowed(current, session.mode)) throw httpError(409, "当前商品状态不能启动1688采集");
        if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
        const source = normalize1688CaptureSource(current.sourceUrl);
        if (source.type === "invalid") throw httpError(422, "当前货源不是允许的1688精确链接或qr.1688.com短链");
        if (session.mode !== "a_supplier_capture" && source.type !== "detail") {
          throw httpError(422, "当前模式只接受可识别的1688精确商品链接");
        }
        const offerId = source.offerId;
        const timestamp = now();
        session.expectedOfferId = offerId;
        session.sourceUrl = source.sourceUrl;
        session.originalSourceUrl = source.sourceUrl;
        current.sourceCapture = {
          captureId: session.captureId,
          status: "waiting_extension",
          offerId,
          sourceUrl: session.sourceUrl,
          originalSourceUrl: session.originalSourceUrl,
          mode: session.mode,
          startedAt: timestamp,
          writeOccurred: false
        };
        if (session.mode === "listing_preparation") {
          current.workflowStatus = "listing_preparation";
          current.listingPreparation = {
            ...(current.listingPreparation || {}),
            status: "capturing_source",
            sourceCaptureId: session.captureId,
            requestedAt: timestamp,
            requestedBy: "user"
          };
          current.listingHandoff = {
            ...(current.listingHandoff || {}),
            state: "capturing_source",
            owner: "listing_task",
            runId: null,
            currentStep: "等待本机Chrome扩展读取当前1688商品",
            blockReason: null,
            defaultStock: 100
          };
        }
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        session.dataRevision = current.dataRevision;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "user";
        const startAction = session.mode === "listed_evidence_recovery"
          ? "listedSourceCaptureStarted"
          : session.mode === "a_supplier_capture"
            ? "aSupplierCaptureStarted"
            : "sourceCaptureStarted";
        const startDetail = session.mode === "listed_evidence_recovery"
          ? "主人为已上架商品启动一次性1688只读补采；原上架记录保持不变，尚未派发任务"
          : session.mode === "a_supplier_capture"
            ? "主人在A阶段启动一次性1688供应采集；只等待结构化证据，不自动选择SKU、确认供应方案、运行B/C1或派发任务"
            : "主人从评审台启动当前SKU的一次性1688只读采集；尚未派发任务";
        addHistory(current, "user", startAction, startDetail, timestamp);
        return publicCandidate(current, data.rules);
      });
    } catch (error) {
      sourceCaptureSessions.delete(session.captureId);
      throw error;
    }
    return json(res, 201, { candidate, ...captureSessionPublic(session) });
  }

  const sourceCaptureResultRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/result$/);
  if (req.method === "POST" && sourceCaptureResultRoute) {
    const input = await requestBody(req);
    const session = captureSession(sourceCaptureResultRoute[1], String(input.captureId || ""));
    if (!session || session.candidateId !== sourceCaptureResultRoute[1]) throw httpError(409, "1688采集会话不存在或已失效", { code: "capture_session_invalid" });
    assertClaimedCaptureResultOrigin(session, req, "1688采集");
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "1688采集令牌无效", { code: "capture_token_invalid" });
    if (!Number.isInteger(input.dataRevision) || input.dataRevision !== session.dataRevision) throw httpError(409, "1688采集修订号不一致", { code: "revision_conflict" });
    if (session.mode === "a_supplier_capture" && session.jobStatus &&
      (session.jobStatus !== "claimed" || session.attempt !== 1)) {
      throw httpError(409, "A阶段采集作业尚未由插件原子领取，不能回传结果", { code: "capture_job_not_claimed" });
    }
    if (!['captured', 'failed'].includes(input.status)) throw httpError(400, "1688采集状态无效", { code: "capture_result_invalid" });
    let failedResult = null;
    if (input.status === "failed") {
      try {
        failedResult = sanitizeSourceCaptureFailureResult(input);
      } catch {
        throw httpError(400, "1688采集失败分类不符合脱敏白名单", { code: "capture_failure_diagnostics_invalid" });
      }
    }
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === session.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== session.dataRevision) throw httpError(409, "商品资料已变化，本次采集结果已拒绝", { code: "revision_conflict" });
      if (current.sourceCapture?.captureId !== session.captureId || current.sourceCapture?.status !== "waiting_extension") {
        if (!(session.mode === "a_supplier_capture" && current.sourceCapture?.captureId === session.captureId && current.sourceCapture?.status === "capturing")) {
          throw httpError(409, "当前SKU不再等待这次采集结果", { code: "capture_job_state_conflict" });
        }
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务，不能接收采集结果");

      if (input.status === "failed") {
        markSourceCaptureFailure(
          current,
          session,
          failedResult.failureCode,
          "",
          failedResult.observedAt,
          failedResult.failureDiagnostics
        );
        return publicCandidate(current, data.rules);
      }

      let evidence;
      try {
        const resolvedSourceUrl = String(input.resolvedSourceUrl || session.sourceUrl || "").trim();
        const resolvedOfferId = extract1688OfferId(resolvedSourceUrl);
        if (!resolvedOfferId) throw new Error(session.mode === "a_supplier_capture" ? "short_link_resolution_failed" : "wrong_offer");
        if (session.expectedOfferId && session.expectedOfferId !== resolvedOfferId) throw new Error("wrong_offer");
        evidence = sanitize1688Evidence(input.evidence, resolvedOfferId);
      } catch (error) {
        const code = String(error?.message || "invalid_capture");
        markSourceCaptureFailure(current, session, code, "扩展回传未通过服务端校验");
        return publicCandidate(current, data.rules);
      }
      if (session.mode === "a_supplier_capture") {
        markAStageCaptureNeedsOwnerSelection(current, session, evidence);
        return publicCandidate(current, data.rules);
      }
      const suggested = resolveCapturedSku(current, evidence);
      markSourceCaptureNeedsSelection(current, session, evidence, {
        choices: evidence.skus,
        matchTerms: suggested.matchTerms || [],
        matches: suggested.selected ? [suggested.selected] : suggested.matches || []
      });
      return publicCandidate(current, data.rules);
    });
    session.consumedAt = Date.now();
    session.jobStatus = input.status === "captured" ? "completed" : "failed";
    clearSourceCaptureJobTimer(session.captureId);
    sourceCaptureSessions.delete(session.captureId);
    const data = await readData();
    const dispatch = dispatchId ? data.dispatches.find((item) => item.id === dispatchId) : null;
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) }, chromeExtensionCors(req));
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("1688采集后派发失败", error)), 0);
    }
    return;
  }

  const sourceCaptureSelectRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/select-sku$/);
  if (req.method === "POST" && sourceCaptureSelectRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "选择1688 SKU必须提供当前数据修订号");
    if (!Array.isArray(input.sourceSkuIds) || !input.sourceSkuIds.length) throw httpError(400, "请至少选择一个1688 SKU");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceCaptureSelectRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新选择SKU");
      if (current.sourceCapture?.mode === "a_supplier_capture") {
        throw httpError(409, "新版A阶段确认卡当前只提供本地临时多选，不通过旧接口保存、确认供应方案或进入B/C1");
      }
      if (current.sourceCapture?.status !== "needs_sku_selection") throw httpError(409, "当前商品不在等待选择1688 SKU");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
      if (current.sourceCapture.mode !== "listed_evidence_recovery") {
        throw httpError(409, "旧1688选择入口只保留历史读取，不再创建C阶段派发；请使用新版A阶段确认卡");
      }
      const evidence = {
        offerId: current.sourceCapture.offerId,
        sourceUrl: current.sourceCapture.sourceUrl,
        title: current.sourceCapture.title,
        observedAt: current.sourceCapture.observedAt,
        collectionMethod: current.sourceCapture.collectionMethod,
        titleSource: current.sourceCapture.titleSource,
        offerIdSource: current.sourceCapture.offerIdSource,
        priceRanges: current.sourceCapture.priceRanges || [],
        supplierAttributes: current.sourceCapture.supplierAttributes || {},
        skus: current.sourceCapture.skuChoices || []
      };
      const resolution = resolveCapturedSkus(evidence, input.sourceSkuIds);
      if (resolution.status === "invalid_selection") throw httpError(422, "选择的SKU不在本次采集结果中");
      if (current.sourceCapture.mode === "listed_evidence_recovery") {
        saveListedSourceEvidence(current, evidence, resolution);
        return publicCandidate(current, data.rules);
      }
      const sessionLike = { captureId: current.sourceCapture.captureId };
      const dispatch = queueCapturedListingPreparation(data, map, current, sessionLike, evidence, resolution, "listing_preparation_source_capture_skus_selected");
      dispatchId = dispatch.id;
      return publicCandidate(current, data.rules);
    });
    const data = await readData();
    const dispatch = data.dispatches.find((item) => item.id === dispatchId);
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) });
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("选择1688 SKU后派发失败", error)), 0);
    }
    return;
  }

  const listingPreparationStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/start-listing-preparation$/);
  if (req.method === "POST" && listingPreparationStartRoute) {
    await requestBody(req);
    throw httpError(409, "旧“开始上架准备”入口已停用：awaiting_user_start只作为历史状态读取；新版商品必须由B通过后自动进入C1，调用本接口不会改变商品状态");
  }

  const realAConfirmationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/a-confirm$/);
  if (req.method === "POST" && realAConfirmationRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "A确认必须提供当前数据修订号");
    const snapshot = await readData();
    const snapshotCandidate = snapshot.candidates.find((item) => item.id === realAConfirmationRoute[1]);
    if (!snapshotCandidate) throw httpError(404, "候选不存在");
    if (Number(snapshotCandidate.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认A阶段");
    if (activeDispatchForCandidate(snapshot, snapshotCandidate.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能同时确认A阶段");
    if (input.decision !== "reject" && snapshotCandidate.executionRuntime?.exceptionCase?.status === "open") {
      throw httpError(409, "当前SKU存在尚未解决的有证据异常；业务结论未改变，不能继续进入B");
    }
    if (input.decision !== "reject") {
      const requestedSourceUrl = String(input.supplierConfirmation?.productUrl || snapshotCandidate.sourceUrl || "").trim();
      const requestedSource = normalize1688CaptureSource(requestedSourceUrl);
      const capture = snapshotCandidate.sourceCapture;
      const captureReadyForSameSource = capture?.mode === "a_supplier_capture" &&
        capture?.status === "captured_waiting_owner_selection" &&
        normalize1688CaptureSource(capture.sourceUrl).sourceUrl === requestedSource.sourceUrl;
      if (requestedSource.type !== "invalid" && !captureReadyForSameSource) {
        const queued = await enqueueASupplierCaptureJob({
          candidateId: snapshotCandidate.id,
          requestRevision: input.dataRevision,
          requestedSourceUrl
        });
        return json(res, queued.duplicate ? 200 : 202, {
          status: "supplier_capture_job_queued",
          candidate: queued.candidate,
          captureJob: queued.captureJob,
          dispatch: null,
          bStarted: false,
          c1Created: false
        });
      }
    }
    const timestamp = now();
    let providers = {};
    let commissionEstimate = null;
    if (input.decision !== "reject") {
      if (input.commissionEstimate !== undefined) {
        const rate = Number(input.commissionEstimate?.commissionRate);
        if (input.commissionEstimate?.authorized !== true || input.commissionEstimate?.confirmedBy !== "owner") {
          throw httpError(400, "估算佣金必须由主人对当前SKU明确授权");
        }
        if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
          throw httpError(400, "估算佣金率必须在0到1之间");
        }
        commissionEstimate = {
          authorized: true,
          confirmedBy: "owner",
          commissionRate: rate,
          authorizationRef: `owner-a-confirmation:commission-estimate:${snapshotCandidate.id}`
        };
      }
      let otherCosts;
      try {
        otherCosts = buildLifecycleBExplicitOtherCosts(
          snapshotCandidate,
          candidateProfitRule(snapshotCandidate, snapshot.rules)
        );
      } catch (error) {
        throw httpError(422, error instanceof Error ? error.message : String(error));
      }
      providers = createLifecycleBRealEvidenceProviderRegistry({
        otherCosts,
        ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
        guooFilePath: process.env.SELECTION_REVIEW_GUOO_TARIFF_FILE,
        cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
        commissionEstimate
      });
    }
    let orchestration;
    try {
      orchestration = await runRealAConfirmationWithSystemEvidence({
        candidate: snapshotCandidate,
        submission: input,
        evidencePacks: snapshot.evidencePacks || [],
        providers,
        confirmedAt: timestamp,
        guooFilePath: process.env.SELECTION_REVIEW_GUOO_TARIFF_FILE
      });
    } catch (error) {
      throw httpError(422, error instanceof Error ? error.message : String(error));
    }
    if (orchestration.status !== "completed") {
      throw httpError(422, `A确认后的B系统证据准备已停止：${orchestration.evidencePreparation?.failure?.reason || "未知失败"}`, {
        evidencePreparation: orchestration.evidencePreparation
      });
    }
    const result = orchestration.result;
    if (result.idempotentReplay === true) {
      return json(res, 200, {
        candidate: publicCandidate(snapshotCandidate, snapshot.rules, {}, snapshot.evidencePacks || []),
        idempotentReplay: true
      });
    }
    const originalEvidencePacks = JSON.stringify(snapshot.evidencePacks || []);
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realAConfirmationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认A阶段");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能同时确认A阶段");
      if (JSON.stringify(data.evidencePacks || []) !== originalEvidencePacks) {
        throw httpError(409, "B证据在本轮读取期间发生变化，本轮结果未保存；请刷新后重新确认一次");
      }
      commitLifecycleBEvidencePacks(data, orchestration.evidencePacksToCommit, {
        createdAt: timestamp,
        createdBy: "real_a_confirmation_system_evidence"
      });

      if (result.decision === "reject") {
        current.lifecycleV11 = {
          ...(current.lifecycleV11 || {}),
          schemaVersion: "product-lifecycle-v1.1",
          status: "a_rejected_by_owner",
          aConfirmationReceipt: {
            receiptId: result.confirmationReceiptId,
            decision: "reject",
            sourceCandidateRevision: result.sourceCandidateRevision,
            confirmedAt: timestamp
          },
          opportunityPackage: null,
          skuPackage: null,
          c1Handoffs: [],
          externalAccesses: [],
          platformWrites: 0
        };
        current.workflowStatus = "eliminated";
        current.eliminatedAt = timestamp;
        current.eliminationReason = "主人在A阶段完整确认卡选择淘汰";
        current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: true };
        current.dataRevision += 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "user";
        addHistory(current, "user", "realARejected", "主人在一张A确认卡淘汰当前商品；未启动B、未派发任务、零平台访问和写入", timestamp);
        return publicCandidate(current, data.rules);
      }

      const bPassed = result.profitModel.result === "passed";
      const usedCommissionEstimate = result.profitModel.commissionMode === "estimated";
      if (usedCommissionEstimate) {
        current.acceptedEstimatedCommission = true;
        current.estimatedCommissionAuthorization = {
          commissionRate: commissionEstimate.commissionRate,
          confirmedBy: "owner",
          confirmedAt: timestamp,
          sourceCandidateRevision: input.dataRevision,
          exactCommissionRequiredAtC: true
        };
      }
      current.lifecycleEvidenceContextV11 = structuredClone(orchestration.evidenceContext);
      current.lifecycleV11 = {
        ...(current.lifecycleV11 || {}),
        schemaVersion: "product-lifecycle-v1.1",
        status: bPassed ? "b_passed_auto_c1" : "b_rejected",
        aConfirmationReceipt: {
          receiptId: result.confirmationReceiptId,
          decision: "confirm",
          sourceCandidateRevision: result.sourceCandidateRevision,
          confirmedAt: timestamp
        },
        opportunityPackage: structuredClone(result.opportunityPackage),
        ownerSupplyConfirmation: structuredClone(result.ownerSupplyConfirmation),
        bSystemEvidenceBundle: structuredClone(result.systemEvidenceBundle),
        skuPackage: structuredClone(result.skuPackage),
        c1Handoffs: result.c1Handoff ? [structuredClone(result.c1Handoff)] : [],
        externalAccesses: structuredClone(orchestration.externalAccesses),
        platformWrites: 0
      };
      const runtimeBase = current.executionRuntime || createSoftwareExecutionRuntime({
        candidateId: current.id,
        dataRevision: current.dataRevision,
        businessPhase: "A",
        stepId: "A_CONFIRMATION",
        at: timestamp
      });
      const bRuntime = startSoftwareStep(runtimeBase, {
        stepId: "B_DETERMINISTIC_PROFIT",
        inputRevision: current.dataRevision,
        at: timestamp
      });
      current.executionRuntime = completeExecutionStep(bRuntime, {
        outputRevision: current.dataRevision + 1,
        at: timestamp
      });
      current.executionRuntime.businessPhase = bPassed ? "C1" : "B";
      current.bPassedAt = bPassed ? timestamp : null;
      current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: false };
      if (bPassed) {
        current.workflowStatus = "listing_preparation";
        current.listingPreparation = {
          status: "c1_inputs_ready",
          reason: usedCommissionEstimate
            ? "主人一次确认A阶段后，B已使用明确标注的估算佣金自动计算并通过；C1输入已创建，生产前必须补取当前精确佣金。"
            : "主人一次确认A阶段后，B已只读冻结证据自动计算并通过；C1输入已原子创建。",
          decisionItems: usedCommissionEstimate ? ["C阶段补取当前店铺、类目和RFBS模式的精确佣金"] : [],
          writeOccurred: false,
          platformWrites: 0
        };
        current.listingHandoff = {
          state: "created",
          owner: "listing_task",
          runId: null,
          currentStep: "B利润通过，C1输入已自动创建",
          blockReason: null,
          userAction: "无需再次点击开始上架准备",
          inheritedInputRevision: result.c1Handoff.inheritedSkuRevision,
          handoffId: result.c1Handoff.handoffId,
          realTaskDispatched: false
        };
      } else {
        current.workflowStatus = "eliminated";
        current.eliminatedAt = timestamp;
        current.eliminationReason = `B阶段利润未达到当前门槛：单件利润${result.profitModel.unitProfitRmb}元，利润率${(result.profitModel.profitMargin * 100).toFixed(1)}%`;
        current.listingPreparation = null;
        current.listingHandoff = null;
      }
      current.dataRevision += 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(
        current,
        "system",
        bPassed ? "realAAutoBPassedAndC1Created" : "realAAutoBRejected",
        bPassed
          ? `A确认后系统只读准备B证据并自动通过，创建唯一C1交接${result.c1Handoff.handoffId}；负责人切换为上架任务；未派发真实任务、零平台写入`
          : `A确认后系统只读准备B证据并自动计算，未通过当前利润门槛；未创建C1、未派发任务、零平台写入`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    const completedCandidate = result.decision === "confirm" && result.profitModel?.result === "passed"
      ? await continueC1SoftwareWhenEvidenceReady(candidate.id, candidate.dataRevision)
      : candidate;
    return json(res, 200, { candidate: completedCandidate });
  }

  const listingPreparationReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/listing-preparation-review$/);
  const retiredFireTrainC1Route = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1-owner-facts$/);
  const retiredFireTrainFinalAssetsRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/final-assets$/);
  const legacyFireTrainC1Route = pathname.match(/^\/api\/legacy\/fire-train\/candidates\/([^/]+)\/lifecycle\/c1-owner-facts$/);
  const legacyFireTrainFinalAssetsRoute = pathname.match(/^\/api\/legacy\/fire-train\/candidates\/([^/]+)\/lifecycle\/final-assets$/);
  const genericC1CompleteRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/complete$/);
  const c1FactKeywordPipelineRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/fact-keyword-pipeline$/);
  const c1KeywordEvidenceReadyRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/keyword-evidence-ready$/);
  const c1KeywordEvidenceSoftwareRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/keyword-evidence-software-run$/);
  const c1SoftwareEvidenceStageRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/software-evidence$/);
  const genericC2FinalAssetUploadRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/final-assets\/upload$/);
  const genericC2FinalAssetsRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/final-assets$/);
  const realProductionAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization$/);
  const realProductionAuthorizationRevisionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization\/revise$/);
  const realProductionAuthorizationPriceRepairRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization\/repair-price-semantics$/);
  const realDAssetTransportRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/asset-transport$/);
  if (req.method === "POST" && (retiredFireTrainC1Route || retiredFireTrainFinalAssetsRoute)) {
    await requestBody(req);
    throw httpError(410, "旧火车专属C阶段入口已隔离，不得用于新版生命周期；请使用通用C1/C2入口");
  }
  if (req.method === "POST" && (legacyFireTrainC1Route || legacyFireTrainFinalAssetsRoute) && !legacyFireTrainAdapterEnabled) {
    await requestBody(req);
    throw httpError(410, "火车专属历史适配器已永久隔离，只保留旧数据审计与单元测试，不得进入通用生产路径");
  }
  if (req.method === "POST" && c1FactKeywordPipelineRoute) {
    await requestBody(req);
    throw httpError(410, "旧C1事实关键词注入入口已停用；新版流程只接受服务端按当前revision生成的单次软件计划");
  }
  if (req.method === "POST" && c1KeywordEvidenceReadyRoute) {
    await requestBody(req);
    throw httpError(410, "旧关键词就绪事件注入入口已停用；外部事件只能由当前服务端单次作业内部接续");
  }
  if (req.method === "GET" && pathname === "/api/integrations/seerfar/runtime-status") {
    const configuration = await inspectSeerfarRuntimeConfiguration();
    return json(res, 200, {
      ...configuration,
      softwareExecutionEnabled: seerfarSoftwareExecutionEnabled,
      softwareJobQueueEnabled: c1PaidKeywordGenericQueueEnabled,
      consumerConnected: false,
      executionBlocker: "awaiting_runtime_binding",
      directProviderExecutionEnabled: false,
      automaticRetries: 0,
      browserFallbackEnabled: false,
      secretExposed: false
    });
  }
  if (req.method === "POST" && c1KeywordEvidenceSoftwareRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "关键词软件作业只接受application/json");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "关键词软件作业拒绝非评审台页面来源");
    const input = await requestBody(req);
    const candidate = await runC1KeywordEvidenceSoftwareJob(c1KeywordEvidenceSoftwareRoute[1], input);
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && c1SoftwareEvidenceStageRoute) {
    await requestBody(req);
    throw httpError(410, "旧C1软件证据手工冻结入口已停用；新版流程只读取服务端冻结证据");
  }
  if (req.method === "POST" && genericC1CompleteRoute && !legacyManualC1InputEnabled) {
    await requestBody(req);
    throw httpError(410, "旧手工提交Schema、竞品文字和关键词的C1入口已停用；新版C1只读取A/B冻结数据与已保存证据并由软件自动执行");
  }
  if (req.method === "POST" && genericC1CompleteRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "C1完成必须提供当前数据修订号");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === genericC1CompleteRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新完成C1");
      const opportunityPackage = current.lifecycleV11?.opportunityPackage;
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!opportunityPackage || !skuPackage) throw httpError(409, "当前商品缺少新版A/B冻结数据包");
      if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
        throw httpError(409, "当前SKU已经生产授权或执行，不能重建C1/C2");
      }
      const timestamp = now();
      let result;
      try {
        result = completeC1AndStartC2({
          opportunityPackage,
          skuPackage,
          platformSchemaEvidence: input.platformSchemaEvidence,
          competitorTextSnapshot: input.competitorTextSnapshot,
          keywordEvidence: input.keywordEvidence,
          collectedAssets: Array.isArray(input.collectedAssets) ? input.collectedAssets : [],
          completedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.lifecycleV11 = {
        ...current.lifecycleV11,
        status: "awaiting_final_assets",
        skuPackage: structuredClone(result.skuPackage),
        externalAccesses: [],
        platformWrites: 0
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_final_assets",
        reason: "通用C1已仅使用A/B冻结数据完成事实、Schema和SEO草稿，当前等待主人确认最终上传素材。",
        decisionItems: ["提供并确认当前SKU的最终图片/视频及顺序"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        owner: "listing_task",
        runId: null,
        currentStep: "C1完成，C2等待最终素材",
        blockReason: null,
        userAction: "请确认当前SKU的最终素材；采集素材和AI草稿不会自动进入D。",
        decisionItems: ["确认最终上传素材"],
        stoppedAt: null
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "genericC1CompletedAndC2Started", `通用C1完成；锁定供应SKU ${result.skuPackage.supplierSkuId}；C2等待最终素材；零外部访问、零平台写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && genericC2FinalAssetUploadRoute) {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    const dataRevision = Number(requestUrl.searchParams.get("dataRevision"));
    const fileName = requestUrl.searchParams.get("fileName") || "";
    if (!Number.isInteger(dataRevision)) throw httpError(400, "C2素材上传必须提供当前数据修订号");
    const candidateId = genericC2FinalAssetUploadRoute[1];
    const before = await readData();
    const current = before.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新选择素材");
    const skuPackage = current.lifecycleV11?.skuPackage;
    if (!skuPackage?.c2FinalAssets?.softwareState || skuPackage.businessPhase !== "C2" || skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") {
      throw httpError(409, "当前SKU不是新版C2等待最终素材状态");
    }
    if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
      throw httpError(409, "当前SKU已经生产授权或执行，不能新增最终素材");
    }
    const body = await requestBinaryBody(req);
    const asset = await stageC2FinalUpload({
      candidateId,
      dataRevision,
      fileName,
      contentType: req.headers["content-type"],
      body,
      stagedAt: now()
    });
    const after = await readData();
    const unchanged = after.candidates.find((item) => item.id === candidateId);
    if (!unchanged || Number(unchanged.dataRevision) !== dataRevision || unchanged.lifecycleV11?.skuPackage?.c2FinalAssets?.status !== "awaiting_final_uploads") {
      await fs.rm(asset.assetRef, { force: true }).catch(() => {});
      throw httpError(409, "素材上传期间商品资料已变化，文件未保存，请刷新后重新选择");
    }
    return json(res, 201, {
      candidateId,
      dataRevision,
      asset,
      businessStateChanged: false,
      platformWrites: 0
    });
  }
  if (req.method === "POST" && genericC2FinalAssetsRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "C2素材确认必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须由主人明确确认当前SKU的最终素材清单和顺序");
    if (!Array.isArray(input.finalUploadAssets) || input.finalUploadAssets.length === 0) {
      throw httpError(400, "必须提供当前SKU的最终上传素材");
    }
    if (!Array.isArray(input.approvedAssetIds) || input.approvedAssetIds.length === 0) {
      throw httpError(400, "必须提供主人确认的素材ID顺序");
    }
    const confirmationSnapshot = await readData();
    const confirmationCandidate = confirmationSnapshot.candidates.find((item) => item.id === genericC2FinalAssetsRoute[1]);
    if (!confirmationCandidate) throw httpError(404, "候选不存在");
    if (Number(confirmationCandidate.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认素材");
    const verifiedFinalUploadAssets = await verifyAndAuthorizeStagedC2Assets({
      candidateId: genericC2FinalAssetsRoute[1],
      dataRevision: input.dataRevision,
      assets: input.finalUploadAssets
    });
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === genericC2FinalAssetsRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认素材");
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!skuPackage) throw httpError(409, "当前商品缺少新版SKU生命周期包");
      if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
        throw httpError(409, "当前SKU已经生产授权或执行，不能覆盖素材");
      }
      const timestamp = now();
      let result;
      try {
        const manifest = prepareC2FinalUploadManifest({
          skuPackage,
          expectedDataRevision: skuPackage.dataRevision,
          finalUploadAssets: verifiedFinalUploadAssets,
          preparedAt: timestamp
        });
        if (JSON.stringify(input.approvedAssetIds) !== JSON.stringify(manifest.approvedAssetIds)) {
          throw new Error("C2_SOFTWARE_OWNER_CONFIRMATION_REQUIRED: 主人确认的素材ID及顺序必须与冻结清单完全一致");
        }
        const confirmed = confirmC2SoftwareFinalUploads({
          skuPackage,
          expectedDataRevision: skuPackage.dataRevision,
          finalManifest: manifest,
          ownerDecision: {
            status: "confirmed",
            confirmedBy: "owner",
            approvedManifestVersion: manifest.schemaVersion,
            approvedManifestSha256: manifest.manifestSha256,
            approvedAssetIds: manifest.approvedAssetIds,
            confirmationNote: input.confirmationNote || null
          },
          confirmedAt: timestamp
        });
        const card = createFinalProductPlanConfirmationCard({
          skuPackage: confirmed.skuPackage,
          createdAt: timestamp
        });
        result = {
          skuPackage: card.skuPackage,
          confirmationCard: card.confirmationCard,
          finalManifest: manifest
        };
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.lifecycleV11 = {
        ...current.lifecycleV11,
        status: "awaiting_owner_business_confirmation",
        skuPackage: structuredClone(result.skuPackage),
        platformWrites: 0
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_owner_business_confirmation",
        reason: "C2最终素材已按主人确认顺序锁定，最终商品方案卡已生成；尚未生产授权。",
        decisionItems: ["审核最终商品方案卡并决定通过、退回C阶段或淘汰"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        owner: "listing_task",
        runId: null,
        currentStep: "C1+C2完成，等待主人审核最终商品方案卡",
        blockReason: null,
        userAction: "请核对精确SKU、利润、事实、SEO、风险和最终素材后决定是否进入生产授权。",
        decisionItems: ["通过进入生产授权", "退回C阶段修改", "淘汰商品"]
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "c2SoftwareFinalAssetsConfirmed", `主人确认${result.confirmationCard.c2Assets.finalUploads.length}个最终素材及清单指纹${result.finalManifest.manifestSha256}；已生成通用确认卡；未创建生产授权，零平台写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && realDAssetTransportRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "OSS素材准备必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须由主人明确确认当前授权素材执行一次OSS准备");
    if (!input.authorizationId || !Array.isArray(input.finalUploadAssetIds) || input.finalUploadAssetIds.length === 0) {
      throw httpError(400, "必须锁定当前生产授权和完整最终素材顺序");
    }

    const persisted = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realDAssetTransportRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认OSS素材准备");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!skuPackage?.productionAuthorization || skuPackage.productionRecord) throw httpError(409, "当前SKU缺少有效生产授权或已经生产");
      if (skuPackage.dAssetTransport?.assetTransport?.status === "verified") throw httpError(409, "当前授权素材已经取得OSS稳定地址，禁止重复上传");
      if (["in_flight", "unknown_outcome"].includes(skuPackage.dAssetTransport?.intent?.status)) {
        throw httpError(409, "当前授权素材已有执行中或结果未知的OSS记录，禁止重复上传");
      }
      const timestamp = now();
      let intent;
      try {
        intent = createPersistableAliyunOssAssetIntent({
          candidate: current,
          expectedDataRevision: input.dataRevision,
          ownerDecision: {
            confirmed: true,
            confirmedBy: "owner",
            authorizationId: input.authorizationId,
            skuPackageId: skuPackage.skuPackageId,
            finalUploadAssetIds: input.finalUploadAssetIds
          },
          startedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      const persistedCandidateRevision = Number(current.dataRevision) + 1;
      const persistedIntent = markAliyunOssAssetIntentPersisted({
        intent,
        persistedAt: timestamp,
        persistedCandidateRevision
      });
      skuPackage.dAssetTransport = {
        schemaVersion: "aliyun-oss-d-asset-state-v1",
        status: "in_flight",
        intent: structuredClone(persistedIntent),
        assetTransport: null,
        automaticRetry: false,
        platformWrites: 0
      };
      current.dataRevision = persistedCandidateRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "ossAssetTransportIntentPersisted", `已持久化当前授权${input.finalUploadAssetIds.length}个最终素材的一次OSS传输意图；尚未写Ozon`, timestamp);
      return { candidate: structuredClone(current), intent: structuredClone(persistedIntent) };
    });

    const result = await executeAliyunOssAssetIntent({
      persistedIntent: persisted.intent,
      candidate: persisted.candidate,
      completedAt: now()
    });

    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realDAssetTransportRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const state = current.lifecycleV11?.skuPackage?.dAssetTransport;
      if (!state || state.intent?.intentId !== persisted.intent.intentId || state.intent?.status !== "in_flight") {
        throw httpError(409, "OSS传输意图已变化，结果不得覆盖当前商品");
      }
      if (Number(current.dataRevision) !== persisted.intent.persistedCandidateRevision) {
        throw httpError(409, "OSS执行期间商品资料已变化，结果不得覆盖当前商品");
      }
      const timestamp = now();
      state.status = result.status;
      state.intent = structuredClone(result.intent);
      state.assetTransport = result.status === "verified" ? structuredClone(result.assetTransport) : null;
      state.automaticRetry = false;
      state.platformWrites = 0;
      current.dataRevision = Number(current.dataRevision) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(
        current,
        "system",
        result.status === "verified" ? "ossAssetTransportVerified" : "ossAssetTransportUnknownOutcome",
        result.status === "verified"
          ? `当前授权${result.assetTransport.resolvedAssets.length}个最终素材已取得稳定HTTPS地址；Ozon写入仍为0`
          : "OSS素材传输结果未知，已停止且禁止自动重试；Ozon写入仍为0",
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, result.status === "verified" ? 200 : 502, { candidate, assetTransportStatus: result.status });
  }
  if (req.method === "POST" && (realProductionAuthorizationPriceRepairRoute || realProductionAuthorizationRevisionRoute)) {
    await requestBody(req);
    return json(res, 410, {
      message: "ProductionAuthorization不可变；修订或价格修复必须由后续独立版本化批次设计，当前不覆盖原授权。",
      externalRequests: 0,
      platformWrites: 0
    });
  }
  if (req.method === "POST" && realProductionAuthorizationRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "生产授权必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须由主人明确通过最终商品方案卡");
    if (!input.decisionId || !input.cardId || !input.sourcePreparationFingerprint || !input.sourceFinalCardInputFingerprint ||
        !input.ownerDecisionFingerprint || !input.ownerConfirmation) {
      throw httpError(400, "生产授权必须锁定独立主人决定、C2准备指纹、最终卡指纹和主人确认对象");
    }
    if (!input.merchantSku || !input.warehouseRef || !input.credentialAlias || !Number.isInteger(input.stock)) {
      throw httpError(400, "生产授权必须明确平台SKU、仓库引用、凭据别名和库存");
    }
    if (!input.buyerTargetPrice || !input.platformWritePrice || !input.priceConversion) {
      throw httpError(400, "生产授权必须分别锁定买家目标价、后台写入价和汇率证据");
    }
    if (!input.publishScope || !Array.isArray(input.exclusions) || !Array.isArray(input.allowedWriteFields)) {
      throw httpError(400, "生产授权必须明确发布范围、排除项和允许写入字段");
    }
    const timestamp = now();
    let transaction;
    try {
      transaction = await commitProductionAuthorizationHandoff({
        repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode,
        actor: runtimeIdentityProvider.resolveActor({ sessionId: String(req.headers["x-session-id"] || "production-authorization") }),
        candidateId: realProductionAuthorizationRoute[1],
        expectedCandidateRevision: input.dataRevision,
        ownerDecision: {
          decisionId: input.decisionId,
          selectedOption: "approve_for_production_authorization",
          sourcePreparationFingerprint: input.sourcePreparationFingerprint,
          sourceFinalCardInputFingerprint: input.sourceFinalCardInputFingerprint,
          sourceConfirmationCardId: input.cardId,
          merchantSku: input.merchantSku,
          warehouseRef: input.warehouseRef,
          credentialAlias: input.credentialAlias,
          stock: input.stock,
          buyerTargetPrice: input.buyerTargetPrice,
          platformWritePrice: input.platformWritePrice,
          priceConversion: input.priceConversion,
          publishScope: input.publishScope,
          allowedWriteFields: input.allowedWriteFields,
          exclusions: input.exclusions,
          ownerDecisionFingerprint: input.ownerDecisionFingerprint,
          ownerConfirmation: input.ownerConfirmation
        },
        confirmedAt: timestamp
      });
    } catch (error) {
      if (error.code === "RUNTIME_OPERATION_FORBIDDEN") throw httpError(403, error.message);
      if (error.message === "PRODUCTION_AUTHORIZATION_CANDIDATE_NOT_FOUND") throw httpError(404, "候选不存在");
      if (/REVISION_CONFLICT|IDEMPOTENCY_CONFLICT|GATE_REJECTED|IDENTITY_DRIFT/.test(error.message)) throw httpError(409, error.message);
      throw httpError(422, error.message);
    }
    const data = await readData();
    const committed = data.candidates.find((item) => item.id === realProductionAuthorizationRoute[1]);
    return json(res, 200, {
      status: transaction.status,
      candidate: publicCandidate(committed, data.rules),
      productionAuthorization: transaction.result.productionAuthorization,
      dHandoff: transaction.result.dHandoff,
      productionPlanCreated: false,
      executionIntentCreated: false,
      softwareJobCreated: false,
      dWritePermissionGranted: false,
      externalRequests: 0,
      platformWrites: 0
    });
  }
  if (req.method === "POST" && legacyFireTrainFinalAssetsRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "最终素材确认必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须明确确认本次精确SKU事实和最终素材顺序");
    if (!Array.isArray(input.fileNames) || input.fileNames.length === 0 || input.fileNames[0] !== "09-成品图-俄文.png") {
      throw httpError(400, "最终素材必须存在，且09-成品图-俄文.png必须是首图");
    }
    if (!runtimeConfiguration.legacyFireTrainAssetRoot) {
      throw httpError(410, "火车专属历史素材目录未启用，该适配器仅保留审计用途");
    }
    const allowedRoot = runtimeConfiguration.legacyFireTrainAssetRoot;
    const timestamp = now();
    const finalUploadAssets = [];
    for (const [index, fileName] of input.fileNames.entries()) {
      if (path.basename(fileName) !== fileName) throw httpError(400, "最终素材文件名无效");
      const assetRef = path.resolve(allowedRoot, fileName);
      if (!assetRef.startsWith(`${allowedRoot}${path.sep}`)) throw httpError(400, "最终素材超出本次主人提供目录");
      let bytes;
      let stat;
      try {
        [bytes, stat] = await Promise.all([fs.readFile(assetRef), fs.stat(assetRef)]);
      } catch {
        throw httpError(422, `最终素材不可读：${fileName}`);
      }
      const extension = path.extname(fileName).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".mp4"].includes(extension)) throw httpError(422, `最终素材格式不支持：${fileName}`);
      finalUploadAssets.push({
        assetId: `final:CX-20260803-010:${index + 1}:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
        mediaType: extension === ".mp4" ? "video" : "image",
        assetRef,
        fileName,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: stat.size,
        order: index + 1,
        role: index === 0 ? "main_image" : "detail_image",
        sourceType: "owner_provided_final_upload",
        addedAt: timestamp
      });
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === legacyFireTrainFinalAssetsRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.id !== "CX-20260803-010") throw httpError(409, "第13C当前只允许CX-20260803-010");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认素材");
      if (current.lifecycleV11?.skuPackage?.productionAuthorization || current.lifecycleV11?.skuPackage?.productionRecord) {
        throw httpError(409, "该SKU已经生产授权或执行，不能覆盖事实和素材");
      }
      let result;
      try {
        result = finalizeLegacyFireTrain13CForOwnerCard({
          candidate: current,
          ownerFactConfirmation: {
            brandDecision: "no_brand",
            material: "DVP",
            pieceCount: Number(input.pieceCount),
            mechanism: "mechanical_wind_up",
            powered: false,
            containsBattery: false
          },
          packedWeightKg: Number(input.packedWeightKg),
          dimensionsCm: input.dimensionsCm,
          finalUploadAssets,
          excludedAssets: Array.isArray(input.excludedAssets) ? input.excludedAssets : [],
          preparedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.productName = result.correctedProductName;
      current.packedWeightKg = Number(input.packedWeightKg);
      current.dimensionsCm = structuredClone(input.dimensionsCm);
      current.lifecycleV11 = structuredClone(result.lifecycle);
      const profit = result.activeProfitModel;
      current.codexReview.cStageStatus = "awaiting_owner_business_confirmation";
      current.codexReview.cStageReview = {
        ...current.codexReview.cStageReview,
        status: "awaiting_owner_business_confirmation",
        ownerFactConfirmation: structuredClone(result.lifecycle.ownerFactConfirmation),
        logistics: structuredClone(result.logistics),
        profit: {
          profitModelVersion: profit.profitModelVersion,
          unitProfitRmb: profit.unitProfitRmb,
          marginRate: profit.profitMargin,
          targetPriceRub: profit.recommendedSalePriceRub,
          exchangeRateSnapshotDate: current.codexReview.exchangeRate.rateDate,
          marketResearchRefreshed: false
        },
        draftTitleRu: result.confirmationCard.seoDraft.title.text,
        finalAssetCount: finalUploadAssets.length,
        finalAssetOrder: finalUploadAssets.map((asset) => asset.fileName),
        excludedAssets: structuredClone(input.excludedAssets || []),
        missing: ["主人审核最终商品方案确认卡；A阶段320片价格参考与当前282件精确SKU不是完全同规格"]
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_owner_business_confirmation",
        reason: "C1事实、profit-v2和C2最终素材已完成，正在等待主人审核最终商品方案卡；尚未生产授权。",
        decisionItems: ["审核最终商品方案卡并决定通过、退回C阶段或淘汰"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        runId: null,
        currentStep: "C1+C2完成，等待主人审核最终商品方案卡",
        blockReason: null,
        userAction: "请审核标题、282件、0.21kg、23×16×3cm、利润、最终图片顺序和市场证据差异。",
        decisionItems: ["通过进入生产授权", "退回C阶段修改", "淘汰商品"]
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "real13CFinalAssetsConfirmed", `主人纠正精确SKU为282件、实际打包0.21kg、23×16×3cm；09为首图，${finalUploadAssets.length}个安全素材进入C2，已生成最终商品方案确认卡；零平台写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && legacyFireTrainC1Route) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "C1主人确认必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须明确确认当前精确SKU事实");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === legacyFireTrainC1Route[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.id !== "CX-20260803-010") throw httpError(409, "第13C当前只允许CX-20260803-010");
      if (current.workflowStatus !== "listing_preparation") throw httpError(409, "当前商品不在C阶段上架准备");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认");
      if (current.lifecycleV11?.skuPackage) throw httpError(409, "当前SKU已经存在真实生命周期包，不能重复生成");
      const timestamp = now();
      let lifecycle;
      try {
        lifecycle = prepareLegacyFireTrainC1ForFinalAssets({
          candidate: current,
          ownerFactConfirmation: {
            confirmedBy: "owner",
            confirmedAt: timestamp,
            brandDecision: input.brandDecision,
            material: input.material,
            pieceCount: input.pieceCount,
            mechanism: input.mechanism,
            powered: input.powered,
            containsBattery: input.containsBattery
          },
          preparedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.lifecycleV11 = lifecycle;
      current.codexReview = {
        ...(current.codexReview || {}),
        cStageStatus: "awaiting_final_assets",
        cStageFailureLayer: null,
        cStageReview: {
          ...(current.codexReview?.cStageReview || {}),
          status: "awaiting_final_assets",
          ownerFactConfirmation: structuredClone(lifecycle.ownerFactConfirmation),
          c1PlanId: lifecycle.skuPackage.c1ProductPlan.c1PlanId,
          c1Status: lifecycle.skuPackage.c1ProductPlan.status,
          missing: ["完整授权素材清单与顺序"]
        }
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_final_assets",
        failureLayer: null,
        reason: "C1商品方案已经基于当前冻结证据完成；现在只等待主人提供并确认最终上传图片/视频及顺序。",
        decisionItems: ["提供并确认完整授权素材清单、图片/视频及顺序"],
        writeOccurred: false,
        c1CompletedAt: timestamp,
        sourceCaptureId: current.sourceCapture.captureId
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        runId: null,
        currentStep: "C1商品方案已完成，等待C2最终素材",
        blockReason: null,
        userAction: "请提供本SKU最终要上传的图片/视频，并确认顺序；采集素材不会自动进入D。",
        decisionItems: ["提供并确认完整授权素材清单、图片/视频及顺序"],
        stoppedAt: null
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "realC1FactsConfirmed", "主人确认精确SKU为无品牌、DVP、320片、机械发条、非电且无电池；C1已生成并停在C2最终素材确认，未创建商品或写店", timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && listingPreparationReviewRoute) {
    const input = normalizeListingPreparationReviewInput(await requestBody(req));
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listingPreparationReviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "listing_preparation") throw httpError(409, "只有待上架准备商品可以回写C阶段");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，旧C阶段结果不得覆盖新数据");
      if (input.runId && current.listingHandoff?.runId && current.listingHandoff.runId !== input.runId) {
        throw httpError(409, "C阶段runId与当前上架准备任务不一致");
      }
      const timestamp = now();
      if (Object.keys(input.candidateData).length) {
        const inheritedFields = listingPreparationInheritedFields();
        const conflictingField = inheritedFields.find((field) =>
          Object.hasOwn(input.candidateData, field) &&
          JSON.stringify(input.candidateData[field]) !== JSON.stringify(current[field])
        );
        if (conflictingField) {
          throw httpError(422, `C阶段发现前期继承字段冲突：${conflictingField}；不得静默覆盖，请返回needs_decision让主人确认`);
        }
        for (const field of listingPreparationCStageFields()) {
          if (Object.hasOwn(input.candidateData, field)) current[field] = input.candidateData[field];
        }
      }
      const evidencePackIds = input.evidencePackIds;
      const unknownPack = evidencePackIds.find((id) => !(data.evidencePacks || []).some((pack) => pack.id === id && pack.status === "active"));
      if (unknownPack) throw httpError(422, `共享证据包不存在或已失效：${unknownPack}`);
      if (input.status === "prepared") {
        const expectedOfferId = extract1688OfferId(current.sourceUrl);
        if (expectedOfferId) {
          if (current.sourceCapture?.status !== "verified") {
            throw httpError(422, "精确1688链接尚无已校验采集结果，C阶段不能通过");
          }
          if (input.sourceCaptureId !== current.sourceCapture.captureId) {
            throw httpError(422, "C阶段结果没有带回当前1688采集编号，不能通过");
          }
        }
        const preparation = input.preparation;
        const missing = ["exactSourceSku", "category", "schemaEvidence", "finalPrice"].filter((field) => !String(preparation[field] || "").trim());
        if (missing.length || !Array.isArray(preparation.assets) || !preparation.assets.filter((item) => String(item).trim()).length) {
          throw httpError(422, "C阶段通过必须包含精确货源SKU、类目、Schema证据、最终价格和素材清单");
        }
        const gate = approvalGate(current, data.rules);
        if (!gate.passed) throw httpError(422, "C阶段尚未满足可上架门槛", { blockers: gate.blockers });
        current.workflowStatus = "ready_to_list";
        current.readyAt = timestamp;
        current.cCompletedAt = timestamp;
        current.defaultStock = 100;
        current.evidencePackIds = evidencePackIds;
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          ...preparation,
          status: "prepared",
          defaultStock: 100,
          evidencePackIds,
          sourceCaptureId: current.sourceCapture?.captureId || null,
          completedAt: timestamp
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "prepared",
          owner: "listing_task",
          runId: null,
          currentStep: "C阶段完成，等待主人确认并开始上架",
          preparedAt: timestamp,
          defaultStock: 100,
          blockReason: null
        };
        addHistory(current, "listing_task", "listingPreparationCompleted", "上架任务已完成C阶段；库存100仅为待确认默认值，尚未写店", timestamp);
      } else {
        const reason = input.reason;
        const decisionItems = input.decisionItems;
        const userAction = input.userAction || (
          input.status === "needs_decision"
            ? "请确认页面列出的必要事实；确认前不会重新采集或继续上架"
            : "本次已停止；只有主人明确选择后才会再次执行"
        );
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: input.status,
          evidencePackIds,
          decisionItems,
          stoppedAt: timestamp,
          failureLayer: input.failureLayer,
          reason,
          writeOccurred: input.writeOccurred === true
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: input.status === "needs_decision" ? "needs_decision" : "blocked",
          runId: null,
          currentStep: input.status === "needs_decision" ? "C阶段只读核验完成，等待主人确认必要事实" : "C阶段已停止",
          blockReason: reason,
          userAction,
          decisionItems,
          stoppedAt: timestamp
        };
        addHistory(current, "listing_task", "listingPreparationStopped", `C阶段已停止：${reason}；系统不会自动重试`, timestamp);
      }
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "listing_task";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && productionAuthorizationRoute) {
    return json(res, 410, {
      message: "旧生产确认入口已永久停用；只能使用绑定C2冻结快照的生命周期原子授权接口。",
      dispatchesCreated: 0,
      externalRequests: 0,
      platformWrites: 0
    });
  }

  const dispatchClaimRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/claim$/);
  if (req.method === "POST" && dispatchClaimRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "领取一次性派发必须提供runId和当前真实步骤");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchClaimRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (isDisabledLegacyCDispatch(dispatch)) {
        throw httpError(409, "旧C阶段派发只保留为历史记录，不能领取");
      }
      if (!["received", "permission_required"].includes(dispatch.status)) {
        throw httpError(409, "该派发尚未被目标任务接收或已经结束");
      }
      const timestamp = now();
      dispatch.status = "running";
      dispatch.runId = input.runId.trim();
      dispatch.currentStep = input.currentStep.trim();
      dispatch.startedAt = timestamp;
      dispatch.lastProgressAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (!candidate) throw httpError(404, "派发对应商品不存在");
        if (Number(candidate.dataRevision) !== Number(dispatch.dataRevision)) {
          throw httpError(409, "商品资料已变化，本次派发失效");
        }
        if (["listing_preparation", "ready_to_list"].includes(candidate.workflowStatus)) {
          if (candidate.listingHandoff?.runId && candidate.listingHandoff.runId !== dispatch.runId) {
            throw httpError(409, "同一SKU已有另一个负责人正在运行");
          }
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "running",
            runId: dispatch.runId,
            startedAt: timestamp,
            currentStep: dispatch.currentStep,
            lastProgressAt: timestamp
          };
        } else {
          if (candidate.processing?.state === "running" && candidate.processing?.runId !== dispatch.runId) {
            throw httpError(409, "同一SKU已有另一个负责人正在运行");
          }
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "running",
            runId: dispatch.runId,
            startedAt: timestamp,
            currentStep: dispatch.currentStep,
            lastProgressAt: timestamp,
            claimRevision: candidate.dataRevision,
            dispatchState: "claimed",
            manualHold: false,
            attempts: Number(candidate.processing?.attempts || 0) + 1,
            progressEvents: []
          };
        }
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
        addHistory(candidate, "codex", "oneShotClaimed", `一次性派发${dispatch.id}已开始：${dispatch.currentStep}`, timestamp);
      }
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const desktopTurnRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/desktop-turn$/);
  if (req.method === "POST" && desktopTurnRoute) {
    const input = await requestBody(req);
    if (!input.turnId?.trim() || !Number.isInteger(input.dataRevision)) {
      throw httpError(400, "接管Codex桌面端运行必须提供真实运行编号和当前修订号");
    }
    const snapshot = await readData();
    const original = snapshot.dispatches.find((item) => item.id === desktopTurnRoute[1]);
    if (!original) throw httpError(404, "原派发不存在");
    if (!['queued', 'waiting_assignee'].includes(original.status)) {
      throw httpError(409, "原派发已经运行或结束，不能重复接管");
    }
    if (Number(original.dataRevision) !== input.dataRevision) {
      throw httpError(409, "原派发修订号已变化，不能接管旧运行");
    }
    const route = snapshot.taskRoutes[original.assigneeRole];
    await codexDispatcher.verifyDesktopTurn(route, input.turnId.trim(), original.id);
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === desktopTurnRoute[1]);
      const candidate = dispatch?.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (!dispatch || !candidate) throw httpError(404, "原派发或商品不存在");
      if (!['queued', 'waiting_assignee'].includes(dispatch.status)) {
        throw httpError(409, "原派发已经运行或结束，不能重复接管");
      }
      if (Number(candidate.dataRevision) !== input.dataRevision || Number(dispatch.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，本次运行不能接管");
      }
      const timestamp = now();
      dispatch.status = "running";
      dispatch.turnId = input.turnId.trim();
      dispatch.runId = input.turnId.trim();
      dispatch.deliveryDetail = "负责人任务已由Codex桌面端启动，已核验真实运行编号";
      dispatch.deliveryMode = "codex_desktop_host";
      dispatch.attachedSkills = (dispatch.requiredSkills || []).map((skill) => skill.name).filter(Boolean);
      dispatch.skillsAttachedAt = timestamp;
      dispatch.deliveredAt = timestamp;
      dispatch.startedAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.failureLayer = "";
      dispatch.error = "";
      candidate.listingHandoff = {
        ...(candidate.listingHandoff || {}),
        state: "running",
        owner: dispatch.assigneeRole,
        runId: dispatch.runId,
        startedAt: timestamp,
        currentStep: dispatch.nodeId === "M07" ? "上架任务已开始C阶段" : "上架负责人任务已启动",
        requiredSkills: dispatch.requiredSkills || [],
        attachedSkills: dispatch.attachedSkills,
        skillsAttachedAt: timestamp,
        sourceCaptureId: dispatch.capabilityPlan?.sourceCapture?.captureId || null
      };
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = dispatch.assigneeRole;
      addHistory(candidate, "system", "desktopTurnAdopted", `原派发已核验Codex桌面端真实运行编号：${dispatch.runId}`, timestamp);
      const taskRoute = data.taskRoutes[dispatch.assigneeRole];
      taskRoute.status = "verified";
      taskRoute.verifiedAt = timestamp;
      taskRoute.lastError = "";
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    return json(res, 200, result);
  }

  const dispatchProgressRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/progress$/);
  if (req.method === "POST" && dispatchProgressRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "记录派发进展必须提供runId和当前步骤");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchProgressRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (dispatch.status !== "running" || dispatch.runId !== input.runId.trim()) {
        throw httpError(409, "只能更新当前实际运行的一次性派发");
      }
      const timestamp = now();
      dispatch.currentStep = input.currentStep.trim();
      dispatch.lastProgressAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.progressEvents ||= [];
      dispatch.progressEvents.push({ at: timestamp, step: dispatch.currentStep, evidence: String(input.evidence || "").trim() });
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
          if (candidate.listingHandoff?.runId !== dispatch.runId) throw httpError(409, "上架准备运行编号已变化");
          candidate.listingHandoff.currentStep = dispatch.currentStep;
          candidate.listingHandoff.lastProgressAt = timestamp;
        } else {
          if (candidate?.processing?.runId !== dispatch.runId) throw httpError(409, "SKU运行编号已变化");
          candidate.processing.currentStep = dispatch.currentStep;
          candidate.processing.lastProgressAt = timestamp;
          candidate.processing.progressEvents ||= [];
          candidate.processing.progressEvents.push({ at: timestamp, type: "dispatch_progress", step: dispatch.currentStep, evidenceRef: String(input.evidence || "").trim() });
        }
        candidate.updatedAt = timestamp;
        addHistory(candidate, "codex", "oneShotProgress", `${dispatch.currentStep}${input.evidence ? `；证据：${String(input.evidence).trim()}` : ""}`, timestamp);
      }
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const dispatchCompleteRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/complete$/);
  if (req.method === "POST" && dispatchCompleteRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !["completed", "blocked", "needs_decision"].includes(input.status) || !input.reply?.trim()) {
      throw httpError(400, "收口派发必须提供runId、真实状态和给主人回复");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchCompleteRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (dispatch.runId !== input.runId.trim() || !["running", "permission_required"].includes(dispatch.status)) {
        throw httpError(409, "只能收口当前运行的一次性派发");
      }
      const timestamp = now();
      let finalStatus = input.status;
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (!candidate) throw httpError(404, "派发对应商品不存在");
        if (
          input.status === "completed" &&
          Number(candidate.dataRevision) === Number(dispatch.dataRevision) &&
          candidate.workflowStatus === dispatch.workflowStatusAtDispatch &&
          !String(input.evidence || "").trim()
        ) finalStatus = "responded_unverified";
        if (["listing_preparation", "ready_to_list"].includes(candidate.workflowStatus) && candidate.listingHandoff?.runId === dispatch.runId) {
          const decision = fixedRecoveryDecision(
            input.status === "needs_decision" ? "business_decision" : "result_unverified",
            input.reply.trim(),
            ["retry_current_stage_once", "keep_stopped"]
          );
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: input.status === "needs_decision" ? "needs_decision" : "blocked",
            runId: null,
            currentStep: input.status === "completed" ? "任务已回复，缺少结构化回写" : "已停止：等待主人建议",
            lastProgressAt: timestamp,
            blockReason: input.status === "completed" ? "负责人已回复，但没有C阶段或平台回读的结构化结果" : input.reply.trim(),
            userAction: "请在UI选择固定处理方式",
            recoveryDecision: decision,
            stoppedAt: timestamp
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = dispatch.assigneeRole;
          addHistory(candidate, "codex", "oneShotCompleted", `一次性派发${finalStatus}：${input.reply.trim()}`, timestamp);
        } else if (candidate.processing?.runId === dispatch.runId) {
          const needsCommissionDecision = input.status === "needs_decision" && /估算佣金|佣金.*授权|允许.*佣金/.test(input.reply);
          const decision = input.status === "completed"
            ? null
            : fixedRecoveryDecision(
                needsCommissionDecision ? "business_decision" : "external_failure",
                input.reply.trim(),
                needsCommissionDecision
                  ? ["allow_estimated_commission", "keep_stopped"]
                  : ["retry_current_stage_once", "keep_stopped"]
              );
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: input.status === "completed" ? "idle" : "blocked",
            runId: null,
            startedAt: null,
            currentStep: input.status === "completed" ? "本次派发已结束" : "已停止：等待主人决定",
            lastRunId: dispatch.runId,
            lastProgressAt: timestamp,
            dispatchState: input.status === "completed" ? "completed" : "blocked",
            manualHold: input.status !== "completed",
            blockReason: input.status === "completed" ? null : input.reply.trim(),
            userAction: input.status === "needs_decision" ? "请在UI选择固定处理方式" : "",
            recoveryDecision: decision
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = dispatch.assigneeRole;
          addHistory(candidate, "codex", "oneShotCompleted", `一次性派发${finalStatus}：${input.reply.trim()}`, timestamp);
        }
      }
      dispatch.status = finalStatus;
      dispatch.agentReply = input.reply.trim();
      dispatch.completionEvidence = String(input.evidence || "").trim();
      dispatch.completedAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      appendNodeReply(data, dispatch, input.reply.trim(), input.status === "needs_decision" ? "needs_decision" : "responded");
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const dispatchApprovalRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/approval$/);
  if (req.method === "POST" && dispatchApprovalRoute) {
    const input = await requestBody(req);
    if (!input.requestId || !["accept", "decline", "cancel"].includes(input.decision)) {
      throw httpError(400, "权限决定必须是允许、拒绝或取消本次");
    }
    const data = await readData();
    const dispatch = data.dispatches.find((item) => item.id === dispatchApprovalRoute[1]);
    if (!dispatch?.pendingApproval || String(dispatch.pendingApproval.requestId) !== String(input.requestId)) {
      throw httpError(409, "权限请求已失效，请刷新");
    }
    try {
      codexDispatcher.resolveApproval(dispatch.id, String(input.requestId), input.decision);
    } catch (error) {
      throw httpError(409, error.message);
    }
    const updated = await mutateData((currentData) => {
      const current = currentData.dispatches.find((item) => item.id === dispatch.id);
      current.pendingApproval = null;
      current.status = input.decision === "accept" ? "running" : "blocked";
      current.permissionDecision = { decision: input.decision, at: now() };
      current.lastEventAt = now();
      return dispatchPublic(current);
    });
    return json(res, 200, { dispatch: updated });
  }

  if (req.method === "GET" && pathname === "/api/control/alerts") {
    const data = await readData();
    const alerts = (data.controlAlerts || []).filter((item) => !item.acknowledgedAt);
    return json(res, 200, { alerts });
  }

  const controlAlertAckRoute = pathname.match(/^\/api\/control\/alerts\/([^/]+)\/ack$/);
  if (req.method === "POST" && controlAlertAckRoute) {
    await requestBody(req);
    const alertId = controlAlertAckRoute[1];
    const alert = await mutateData((data) => {
      const current = (data.controlAlerts || []).find((item) => item.id === alertId);
      if (!current) throw httpError(404, "总控提醒不存在");
      if (!current.acknowledgedAt) current.acknowledgedAt = now();
      return current;
    });
    return json(res, 200, { alert });
  }

  if (req.method === "POST" && pathname === "/api/control/reconcile-stopped") {
    const input = await requestBody(req);
    const map = await readWorkflowMap(workflowMapFile);
    if (input.confirm !== true) {
      const data = await readData();
      const preview = data.candidates
        .filter((item) => item.workflowStatus === "codex_processing")
        .map((candidate) => ({
          candidateId: candidate.id,
          productName: candidate.productName,
          ...classifyStoppedCandidate(candidate, latestDispatchForCandidate(data, candidate.id))
        }));
      return json(res, 200, { policyVersion: RECOVERY_POLICY_VERSION, dryRun: true, preview });
    }
    const dispatchIds = [];
    const result = await mutateData((data) => {
      if (data.meta?.recoveryPolicyVersion === RECOVERY_POLICY_VERSION) {
        return { alreadyApplied: true, policyVersion: RECOVERY_POLICY_VERSION, changes: [] };
      }
      const timestamp = now();
      const changes = [];
      for (const current of data.candidates) {
        if (current.workflowStatus !== "codex_processing") continue;
        if (activeDispatchForCandidate(data, current.id)) continue;
        const latest = latestDispatchForCandidate(data, current.id);
        const classification = classifyStoppedCandidate(current, latest);
        if (latest && RECOVERABLE_TERMINAL_DISPATCH_STATES.has(latest.status)) {
          latest.status = "superseded";
          latest.supersededAt = timestamp;
          latest.supersededReason = `由${RECOVERY_POLICY_VERSION}按真实失败类型重新分类`;
        }
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        if (classification.kind === "needs_data") {
          current.workflowStatus = "needs_user_data";
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "idle",
            manualHold: false,
            dispatchState: "needs_data",
            currentStep: classification.summary,
            blockReason: null,
            userAction: "请直接填写页面列出的缺失字段",
            recoveryDecision: null
          };
          addHistory(current, "system", "recoveryClassifiedNeedsData", classification.summary, timestamp);
        } else if (classification.kind === "business_decision") {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "needs_decision",
            currentStep: "等待主人选择固定处理方式",
            blockReason: classification.summary,
            userAction: "请在UI选择固定处理方式",
            recoveryDecision: fixedRecoveryDecision(
              "business_decision",
              classification.summary,
              ["allow_estimated_commission", "keep_stopped"]
            )
          };
          addHistory(current, "system", "recoveryClassifiedDecision", classification.summary, timestamp);
        } else if (classification.kind === "system_recovery") {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "legacy_read_only",
            currentStep: "旧执行记录已收口为历史只读",
            blockReason: classification.summary,
            userAction: "当前无需操作；新版商品由软件状态机重新建立执行上下文",
            recoveryDecision: null
          };
          addHistory(current, "system", "legacyExecutionArchived", "旧系统恢复记录只作历史读取，未创建Codex派发", timestamp);
        } else {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "blocked",
            currentStep: "一次真实技术失败后已停止",
            blockReason: classification.summary,
            userAction: "请在UI选择固定处理方式",
            recoveryDecision: fixedRecoveryDecision(
              "external_failure",
              classification.summary,
              ["retry_current_stage_once", "keep_stopped"]
            )
          };
          addHistory(current, "system", "recoveryClassifiedExternalFailure", classification.summary, timestamp);
        }
        changes.push({ candidateId: current.id, kind: classification.kind, dataRevision: current.dataRevision });
      }
      data.meta.recoveryPolicyVersion = RECOVERY_POLICY_VERSION;
      data.meta.lastRecoveryClassification = {
        at: timestamp,
        policyVersion: RECOVERY_POLICY_VERSION,
        changedCount: changes.length,
        automationStarted: false
      };
      data.meta.automationStarted = false;
      return { alreadyApplied: false, policyVersion: RECOVERY_POLICY_VERSION, changes, dispatchIds: [...dispatchIds] };
    });
    json(res, 200, result);
    if (dispatchIds.length && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchIds[0]).catch((error) => console.error("系统恢复首条派发失败", error)), 0);
    }
    return;
  }

  const recoveryActionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/recovery-action$/);
  if (req.method === "POST" && recoveryActionRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "恢复选择必须提供当前数据修订号");
    if (!Object.hasOwn(RECOVERY_ACTION_LABELS, input.action)) throw httpError(400, "恢复选择无效");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === recoveryActionRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "候选已变化，请刷新后重新选择");
      const decision = current.workflowStatus === "codex_processing"
        ? current.processing?.recoveryDecision
        : current.listingHandoff?.recoveryDecision;
      if (!decision?.actions?.some((item) => item.id === input.action)) {
        throw httpError(409, "当前状态不允许这个恢复选择");
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能重复派发");
      const timestamp = now();
      if (input.action === "keep_stopped") {
        if (current.workflowStatus === "codex_processing") {
          current.processing.currentStep = "主人选择保持停止，等待精确证据";
          current.processing.userAction = "当前无需操作";
        } else {
          current.listingHandoff.currentStep = "主人选择保持停止，等待精确证据";
        }
        current.updatedAt = timestamp;
        addHistory(current, "user", "keptStopped", "主人选择保持停止，等待精确证据", timestamp);
        return { candidate: publicCandidate(current, data.rules), dispatch: null };
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      if (input.action === "allow_estimated_commission") current.acceptedEstimatedCommission = true;
      const nodeId = current.workflowStatus === "codex_processing" ? "M04" : "M07";
      if (current.workflowStatus === "codex_processing") {
        current.processing = {
          ...queueUserDispatch({ ...(current.processing || {}), manualHold: false }, timestamp, `fixed_recovery_${input.action}`),
          currentStep: "已选择固定处理方式，等待选品负责人",
          recoveryDecision: null
        };
      } else {
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "已选择固定处理方式，等待上架负责人",
          blockReason: null,
          recoveryDecision: null
        };
      }
      const message = input.action === "allow_estimated_commission"
        ? "主人已明确允许当前SKU使用清楚标注的估算佣金；继续当前B阶段，估算不得冒充精确事实"
        : "主人只允许重试当前阶段一次；只处理上次真实失败点，再次失败立即停止";
      const dispatch = createCandidateDispatch(data, map, current, {
        nodeId,
        message,
        trigger: `fixed_recovery_${input.action}`,
        actor: "user"
      });
      dispatchId = dispatch.id;
      addHistory(current, "user", "fixedRecoverySelected", `${RECOVERY_ACTION_LABELS[input.action]}：${dispatch.id}`, timestamp);
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("固定恢复选择派发失败", error)), 0);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/control/resume") {
    const input = await requestBody(req);
    if (!input.candidateId || !input.recoveryPath?.trim()) {
      throw httpError(400, "按建议重试必须指定candidateId和本次执行建议");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "总控恢复必须提供当前数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选数据已变化，请刷新后重新确认恢复方式");
      }
      const activeDispatch = activeDispatchForCandidate(data, current.id);
      if (activeDispatch) {
        throw httpError(409, "当前SKU已有一次派发正在等待或运行，不能重复派发", { dispatchId: activeDispatch.id });
      }
      const latestDispatch = latestDispatchForCandidate(data, current.id);
      const terminalDispatchCanRecover = Boolean(
        latestDispatch && RECOVERABLE_TERMINAL_DISPATCH_STATES.has(latestDispatch.status)
      );
      const stoppedSelectionCanRecover = Boolean(
        current.workflowStatus === "codex_processing" &&
        ["blocked", "queued", "deferred"].includes(current.processing?.state) &&
        (current.processing?.manualHold === true || terminalDispatchCanRecover)
      );
      const stoppedListingCanRecover = Boolean(
        current.workflowStatus === "listing_preparation" &&
        ["paused_user_stopped", "blocked", "needs_decision"].includes(current.listingHandoff?.state)
      );
      if (!stoppedSelectionCanRecover && !stoppedListingCanRecover) {
        throw httpError(409, "只有本次处理已停止的候选可以按建议重试");
      }
      const timestamp = now();
      const existingBPass = Boolean(
        current.bPassedAt ||
        current.codexReview?.selectionStage === "B_profit_passed_C_pending" ||
        current.codexReview?.profitCalculation?.directionalStatus === "passed"
      );
      if (stoppedSelectionCanRecover && existingBPass) {
        current.workflowStatus = "listing_preparation";
        current.processing = {
          ...queuedProcessing(current.processing),
          state: "idle",
          runId: null,
          manualHold: false,
          blockReason: null,
          userAction: ""
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "已有B阶段通过证据，按主人建议等待上架任务重试C阶段",
          recoveryPath: input.recoveryPath.trim(),
          defaultStock: 100,
          resumedAt: timestamp,
          blockReason: null
        };
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: "queued",
          retrySuggestion: input.recoveryPath.trim(),
          retriedAt: timestamp
        };
      } else if (stoppedSelectionCanRecover) {
        current.processing = {
          ...queuedProcessing(current.processing),
          state: "queued",
          runId: null,
          startedAt: null,
          currentStep: "",
          lastProgressAt: null,
          progressEvents: [],
          attemptLedger: [],
          manualHold: false,
          dispatchState: "requested",
          dispatchPriority: "user_retry",
          dispatchRequestedAt: timestamp,
          dispatchTrigger: "user_guided_retry",
          recoveryPath: input.recoveryPath.trim(),
          blockReason: null,
          userAction: "",
          stoppedAt: null,
          stopReason: "",
          controlAlertKey: ""
        };
      } else {
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "",
          recoveryPath: input.recoveryPath.trim(),
          blockReason: null,
          resumedAt: timestamp,
          currentStep: "按主人建议等待重试C阶段"
        };
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: "queued",
          retrySuggestion: input.recoveryPath.trim(),
          retriedAt: timestamp
        };
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "userGuidedRetry", `主人给出执行建议并只重试当前SKU一次：${input.recoveryPath.trim()}`, timestamp);
      const nodeId = candidateActiveNode(current);
      const node = map.nodes.find((item) => item.id === nodeId);
      if (!node || node.executionOwner === "control_task") {
        throw httpError(409, "无法确定当前SKU的最终选品或上架负责人，已停止派发");
      }
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate: current,
        message: `只按主人本次建议重试当前SKU一次：${input.recoveryPath.trim()}；再次失败立即停止，不得自动换路径或重试`,
        trigger: "user_guided_retry"
      });
      dispatchId = dispatch.id;
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("恢复派发失败", error)), 0);
    return;
  }

  if (req.method === "GET" && pathname === "/api/automation/work") {
    const data = await readData();
    const state = responseState(data);
    const publicById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
    const automationEnabled = data.meta?.automationStarted === true;
    const dispatchQueue = automationEnabled ? sortDispatchQueue(data.candidates) : [];
    return json(res, 200, {
      automationEnabled,
      disabledReason: automationEnabled ? "" : "自动化已关闭；等待总控明确开启",
      notificationPolicy: "健康检查、队列不变和重复证据保持静默",
      summary: state.summary,
      queued: dispatchQueue.map((candidate) => publicById.get(candidate.id)),
      urgent: dispatchQueue
        .filter((candidate) => candidate.processing?.dispatchState === "requested")
        .map((candidate) => publicById.get(candidate.id)),
      wbReassessment: state.candidates.filter(
        () => false
      ),
      handoffPending: state.candidates.filter(
        (candidate) =>
          candidate.workflowStatus === "ready_to_list" &&
          candidate.listingHandoff?.state === "queued"
      ),
      avoidanceFeedback: recentAvoidanceFeedback(data.candidates),
      rules: state.rules
    });
  }

  if (req.method === "POST" && pathname === "/api/automation/claim") {
    const input = await requestBody(req);
    if (!input.runId?.trim()) throw httpError(400, "自动审核必须提供runId");
    if (!input.initialStep?.trim()) throw httpError(400, "自动审核必须提供当前执行步骤");
    const result = await mutateData((data) => {
      if (data.meta?.automationStarted !== true) {
        throw httpError(409, "自动化已关闭，只有总控明确开启后才能领取任务");
      }
      const running = data.candidates.filter(
        (candidate) => candidate.workflowStatus === "codex_processing" && isActualProcessingRun(candidate.processing)
      ).sort((a, b) => {
        const timeDifference = new Date(a.processing.startedAt).getTime() - new Date(b.processing.startedAt).getTime();
        return timeDifference || a.id.localeCompare(b.id);
      });
      const alreadyRunning = input.candidateId
        ? running.find((candidate) => candidate.id === input.candidateId)
        : null;
      if (alreadyRunning) {
        return {
          candidate: null,
          alreadyRunning: {
            candidateId: alreadyRunning.id,
            runId: alreadyRunning.processing.runId,
            startedAt: alreadyRunning.processing.startedAt
          }
        };
      }
      const duplicateRunId = running.find(
        (candidate) => candidate.processing?.runId === input.runId.trim()
      );
      if (duplicateRunId) {
        throw httpError(409, "runId已被另一条运行中候选使用", {
          candidateId: duplicateRunId.id
        });
      }
      if (running.length >= automationConcurrencyLimit) {
        return {
          candidate: null,
          busy: {
            candidateId: running[0].id,
            candidateIds: running.map((candidate) => candidate.id),
            startedAt: running[0].processing.startedAt,
            concurrencyLimit: automationConcurrencyLimit,
            availableSlots: 0
          }
        };
      }
      const queue = sortDispatchQueue(data.candidates).filter(
        (candidate) =>
          candidate.processing?.deferredRunId !== input.runId.trim() &&
          (!input.candidateId || candidate.id === input.candidateId)
      );
      const candidate = queue[0];
      if (!candidate) return { candidate: null };
      const claimTime = now();
      const sameBusinessDate = candidate.processing?.lastAttemptBusinessDate === businessDate(claimTime);
      candidate.processing = {
        ...candidate.processing,
        state: "running",
        runId: input.runId.trim(),
        startedAt: claimTime,
        currentStep: input.initialStep.trim(),
        lastProgressAt: claimTime,
        progressEvents: [],
        attemptLedger: [],
        lastAttemptAt: claimTime,
        claimRevision: candidate.dataRevision,
        attempts: Number(candidate.processing?.attempts || 0) + 1,
        attemptsToday: sameBusinessDate ? Number(candidate.processing?.attemptsToday || 0) + 1 : 1,
        lastAttemptBusinessDate: businessDate(claimTime),
        lastError: null,
        blockReason: null,
        userAction: "",
        readAttempts: [],
        deferredUntil: null,
        deferredRunId: null,
        dispatchState: "claimed",
        manualHold: false,
        stoppedAt: null,
        stopReason: "",
        controlAlertKey: ""
      };
      candidate.updatedAt = candidate.processing.startedAt;
      candidate.lastModifiedBy = "automation";
      addHistory(candidate, "codex", "claimed", `自动审核开始：${input.runId.trim()}`);
      return {
        candidate: publicCandidate(candidate, data.rules),
        claimRevision: candidate.dataRevision
      };
    });
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/automation/attempt") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.evidenceLayer?.trim() || !input.target?.trim()) {
      throw httpError(400, "登记读取尝试必须提供runId、candidateId、证据层和目标");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，本轮读取尝试已失效");
      }
      try {
        current.processing = registerProcessingAttempt(current.processing, input, now());
      } catch (error) {
        throw httpError(/本轮已尝试/.test(error.message) ? 409 : 400, error.message);
      }
      current.updatedAt = now();
      current.lastModifiedBy = "automation";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/progress") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.progressType?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "记录实质进展必须提供runId、candidateId、进展类型和当前步骤");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，本轮进展已失效");
      }
      try {
        current.processing = recordProcessingProgress(current.processing, input, now());
      } catch (error) {
        throw httpError(/已记录|没有实质变化/.test(error.message) ? 409 : 400, error.message);
      }
      current.updatedAt = current.processing.lastProgressAt;
      current.lastModifiedBy = "automation";
      addHistory(
        current,
        "codex",
        "progress",
        input.progressType === "new_evidence"
          ? `取得新证据：${input.evidenceRef.trim()}；下一步：${input.currentStep.trim()}`
          : `执行步骤更新：${input.currentStep.trim()}`,
        current.processing.lastProgressAt
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/release") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.error?.trim()) {
      throw httpError(400, "释放自动审核任务必须提供runId、candidateId和具体错误");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (
        current.processing?.state !== "running" ||
        current.processing.runId !== input.runId.trim()
      ) {
        throw httpError(409, "只能释放当前runId实际领取的审核任务");
      }
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，当前任务无需再释放");
      }
      const timestamp = now();
      const failureScope = String(input.failureScope || "supplier_link").trim();
      let disposition;
      try {
        disposition = technicalFailureDisposition({
          attemptsToday: Number(current.processing?.attemptsToday || 0),
          readAttempts: input.readAttempts,
          explicitSafetyBlock: input.explicitSafetyBlock === true
        });
      } catch (error) {
        throw httpError(400, error.message);
      }
      const userAction =
        input.userAction?.trim() ||
        "请让总控明确是否按一个恢复路径重新开始；恢复前不再自动重试";
      const stoppedRunId = input.runId.trim();
      const dedupeKey = `technical-block|${current.id}|${stoppedRunId}|${failureScope}`;
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "blocked",
        runId: null,
        startedAt: null,
        currentStep: "已停止：等待总控确认",
        lastRunId: stoppedRunId,
        lastError: input.error.trim(),
        blockReason: input.error.trim(),
        userAction,
        readAttempts: disposition.readAttempts,
        deferredRunId: null,
        deferredUntil: null,
        lastAttemptRevision: Number(input.dataRevision),
        lastAttemptBusinessDate: businessDate(timestamp),
        dispatchState: "blocked",
        manualHold: true,
        failureScope,
        stoppedAt: timestamp,
        stopReason: "evidence_bearing_technical_failure",
        controlAlertKey: dedupeKey,
        recoveryOptions: disposition.recoveryOptions || []
      };
      current.codexReview = {
        ...(current.codexReview || {}),
        technicalBlock: {
          reason: input.error.trim(),
          failureScope,
          stoppedAt: timestamp,
          runId: stoppedRunId,
          readAttempts: disposition.readAttempts
        }
      };
      const alert = {
        id: dedupeKey,
        dedupeKey,
        candidateId: current.id,
        runId: stoppedRunId,
        type: "evidence_bearing_technical_failure",
        message: input.error.trim(),
        createdAt: timestamp,
        acknowledgedAt: null,
        recoveryOptions: disposition.recoveryOptions || []
      };
      appendControlAlert(data, alert);
      addHistory(
        current,
        "codex",
        "blockedAfterTechnicalFailure",
        `一次证据化技术失败后已停止：${input.error.trim()}；下一步：${userAction}`,
        timestamp
      );
      current.updatedAt = timestamp;
      current.lastModifiedBy = "automation";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const sourceAttemptRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-search-attempt$/);
  if (req.method === "POST" && sourceAttemptRoute) {
    throw httpError(409, "该旧接口已停用：B阶段不得核1688；精确货源SKU只在主人启动待上架准备后由上架任务完成C阶段核验");
    /* c8 ignore start -- 保留旧数据迁移读取逻辑，不再允许新调用 */
    const input = await requestBody(req);
    if (!["found", "not_found"].includes(input.result)) {
      throw httpError(400, "找货结果必须是found或not_found；技术失败请释放任务重试");
    }
    if (!input.checkedAt || !input.searchQuery?.trim()) {
      throw httpError(400, "找货记录必须包含查询词和查询时间");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "找货记录必须提供领取时的数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceAttemptRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.source !== "codex" || current.workflowStatus !== "codex_processing") {
        throw httpError(409, "只有已认可且正在处理的Codex方向候选可记录自动找货");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧找货结果不得覆盖新数据");
      }
      if (input.runId && current.processing?.runId !== input.runId) {
        throw httpError(409, "找货runId与当前领取任务不一致");
      }
      current.sourceSearchHistory ||= [];
      current.sourceSearchHistory.push({
        result: input.result,
        searchQuery: input.searchQuery.trim(),
        evidenceUrl: input.evidenceUrl?.trim() || "",
        checkedAt: input.checkedAt
      });
      const timestamp = now();
      if (input.result === "found") {
        if (!input.sourceUrl?.trim()) throw httpError(400, "找到货源时必须保存精确货源链接");
        const duplicate = duplicateCandidate(data.candidates, [input.sourceUrl], current.id);
        if (duplicate) {
          throw httpError(409, `该货源链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
        }
        current.sourceUrl = input.sourceUrl.trim();
        current.workflowStatus = "codex_processing";
        current.processing = queuedProcessing(current.processing);
        addHistory(current, "codex", "sourceFound", "已找到精确货源，自动进入利润审核", timestamp);
      } else {
        current.sourceSearchAttempts = Number(current.sourceSearchAttempts || 0) + 1;
        current.sourceSearchAttemptLimit = Number(current.sourceSearchAttemptLimit || 3);
        if (current.sourceSearchAttempts >= current.sourceSearchAttemptLimit) {
          current.workflowStatus = "eliminated";
          current.processing = { ...queuedProcessing(current.processing), state: "idle" };
          current.eliminatedAt = timestamp;
          current.eliminationReason = `Codex已完成${current.sourceSearchAttempts}轮精确找货，仍未找到可审核货源`;
          addHistory(current, "codex", "sourceSearchExhausted", current.eliminationReason, timestamp);
        } else {
          current.processing = queuedProcessing(current.processing);
          addHistory(
            current,
            "codex",
            "sourceNotFound",
            `第${current.sourceSearchAttempts}/${current.sourceSearchAttemptLimit}轮精确找货未找到，保留后续重试`,
            timestamp
          );
        }
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "codex";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
    /* c8 ignore stop */
  }

  if (req.method === "POST" && pathname === "/api/candidates") {
    const input = normalizeCandidateUserCreateInput(await requestBody(req));
    const result = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const timestamp = now();
      const created = initialCandidate(input, "user", nextCandidateId(data.candidates, "USR"), timestamp);
      addHistory(created, "user", "created", "用户添加候选，已进入软件状态机；未派发Codex任务", timestamp);
      data.candidates.unshift(created);
      return { candidate: publicCandidate(created, data.rules), dispatch: null };
    });
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/codex/candidates") {
    const input = normalizeCandidateCodexCreateInput(await requestBody(req));
    if (![true, false].includes(input.powered)) throw httpError(400, "Codex候选必须确认是否带电");
    if (!input.purchaseCeiling || !["verified", "estimated", "unavailable"].includes(input.purchaseCeiling.status)) {
      throw httpError(400, "Codex候选必须提供含国内邮费采购区间，或明确标记尚无法反算");
    }
    const ceiling = purchaseCeilingSummary(input, DEFAULT_RULES);
    if (
      ["verified", "estimated"].includes(input.purchaseCeiling.status) &&
      input.purchaseCeiling.pricingPolicyVersion !== candidateProfitRule(input, DEFAULT_RULES).pricingPolicyVersion
    ) {
      throw httpError(400, "新采购上限必须按折后成交价计算利润，并保存20%、25%、30%促销对应建议标价");
    }
    if (input.purchaseCeiling.status === "verified" && ceiling.status !== "verified") {
      throw httpError(400, "采购上限证据不完整，不能标记为已验证", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "estimated" && ceiling.status !== "estimated"
    ) {
      throw httpError(400, "方向采购区间证据不足，不能标记为已估算", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "unavailable" &&
      (!Array.isArray(input.purchaseCeiling.missing) || !input.purchaseCeiling.missing.length)
    ) {
      throw httpError(400, "尚无法反算时必须写明Codex的技术缺口");
    }
    const candidate = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const summary = dailySummary(data.candidates, data.rules);
      const storeSummary = summary.stores[input.targetStore];
      if (storeSummary && storeSummary.automaticAdditionEnabled === false) {
        throw httpError(429, storeSummary.automaticAdditionPauseReason);
      }
      if (summary.combined.profitPassed >= summary.combined.target) {
        throw httpError(429, "全店今日B阶段利润通过已达到10个，无需继续自动补充候选");
      }
      if (storeSummary && storeSummary.remainingCodexAdditionCapacity <= 0) {
        throw httpError(429, `${input.targetStore} 今日Codex新增候选已达到30条上限`);
      }
      const timestamp = now();
      const created = initialCandidate(input, "codex", nextCandidateId(data.candidates, "CX"), timestamp);
      addHistory(created, "codex", "created", "Codex自动补充候选，等待用户判断方向", timestamp);
      data.candidates.unshift(created);
      return publicCandidate(created, data.rules);
    });
    return json(res, 201, { candidate });
  }

  const candidateRoute = pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (req.method === "PATCH" && candidateRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "保存候选资料必须提供当前数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再保存", {
          currentRevision: current.dataRevision
        });
      }
      if (["ready_to_list", "listed", "eliminated"].includes(current.workflowStatus)) {
        throw httpError(409, "终态候选不可直接修改；请保留历史结论并创建新候选");
      }
      const normalizedInput = normalizeCandidateUserPatchInput(input, current);
      const duplicate = duplicateCandidate(
        data.candidates,
        [normalizedInput.productUrl, normalizedInput.sourceUrl, normalizedInput.competitorUrl],
        current.id
      );
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      for (const field of USER_FIELDS) {
        if (Object.hasOwn(normalizedInput, field)) current[field] = normalizedInput[field];
      }
      if (Object.hasOwn(normalizedInput, "purchasePriceRmb") && !Object.hasOwn(normalizedInput, "domesticShippingRmb")) {
        current.domesticShippingRmb = null;
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = now();
      current.lastModifiedBy = "user";
      if (
        current.workflowStatus === "needs_user_data" ||
        current.workflowStatus === "codex_processing" ||
        current.processing?.state === "running"
      ) {
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, current.updatedAt, "user_update");
      }
      if (
        current.workflowStatus === "codex_processing" &&
        current.processing?.manualHold !== true &&
        !activeDispatchForCandidate(data, current.id)
      ) {
        const dispatch = createCandidateDispatch(data, map, current, {
          nodeId: "M04",
          message: "主人已补充当前SKU资料，请按最新修订继续一次A/B处理；不要打开1688精确页",
          trigger: "candidate_data_auto",
          actor: "system"
        });
        dispatchId = dispatch.id;
      }
      addHistory(current, "user", "updated", "用户补充资料；技术阻塞不会自动解除，是否恢复由总控决定");
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchId ? dispatchPublic(data.dispatches.find((item) => item.id === dispatchId)) : null };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("补资料自动派发失败", error)), 0);
    }
    return;
  }

  const evaluationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/user-evaluation$/);
  if (req.method === "POST" && evaluationRoute) {
    const input = await requestBody(req);
    if (!["viable", "reject", "unsure"].includes(input.decision)) {
      throw httpError(400, "请选择你的判断");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === evaluationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.lifecycleV11?.opportunityPackage || current.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧方向确认入口；请使用A阶段完整确认卡，商品状态未改变");
      }
      if (!Number.isInteger(input.dataRevision)) {
        throw httpError(400, "提交判断必须提供当前数据修订号");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再判断", {
          currentRevision: current.dataRevision
        });
      }
      const timestamp = now();
      const profitInputs = input.candidateData || {};
      if (input.decision === "unsure" && Object.keys(profitInputs).length) {
        if (profitInputs.sourceUrl?.trim()) {
          const duplicate = duplicateCandidate(data.candidates, [profitInputs.sourceUrl], current.id);
          if (duplicate) {
            throw httpError(409, `该采购链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
          }
        }
        for (const field of ["productName", "sourceUrl", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"]) {
          if (Object.hasOwn(profitInputs, field)) current[field] = profitInputs[field];
        }
        if (Object.hasOwn(profitInputs, "purchasePriceRmb") && !Object.hasOwn(profitInputs, "domesticShippingRmb")) {
          current.domesticShippingRmb = null;
        }
      }
      current.userEvaluation = {
        decision: input.decision,
        reason: input.reason?.trim() || "",
        at: timestamp
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      if (input.decision === "reject") {
        current.workflowStatus = "eliminated";
        current.processing = { ...queuedProcessing(current.processing), state: "idle" };
        current.eliminatedAt = timestamp;
        current.eliminationReason = `用户判断不行${current.userEvaluation.reason ? `：${current.userEvaluation.reason}` : ""}`;
      } else {
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, timestamp, "user_evaluation");
        current.eliminatedAt = null;
        current.eliminationReason = "";
        const dispatch = createCandidateDispatch(data, map, current, {
          nodeId: "M04",
          message: "主人已确认该方向继续，请自动完成当前SKU的A/B利润处理；B阶段不得打开1688精确页",
          trigger: "direction_confirmed_auto",
          actor: "system"
        });
        dispatchId = dispatch.id;
      }
      const labels = { viable: "可做，交给Codex核算", reject: "不行，立即淘汰", unsure: "待确认，交给Codex核算" };
      const inputNote =
        input.decision === "unsure" && Object.keys(profitInputs).length
          ? "；已同时补充采购链接、含国内邮费的采购总价和包装规格"
          : "";
      addHistory(current, "user", "evaluated", `用户判断：${labels[input.decision]}${inputNote}`, timestamp);
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchId ? dispatchPublic(data.dispatches.find((item) => item.id === dispatchId)) : null };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("方向确认自动派发失败", error)), 0);
    }
    return;
  }

  const commentRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/comments$/);
  if (req.method === "POST" && commentRoute) {
    const input = normalizeCandidateCommentInput(await requestBody(req), {
      actor: isTrustedInternalApiRequest(req.headers, internalApiRequestToken) ? "codex" : "user"
    });
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === commentRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "留言保存时商品资料已变化，请刷新后重试", {
          currentRevision: current.dataRevision
        });
      }
      const comment = {
        id: `C-${randomUUID()}`,
        actor: input.actor,
        message: input.message,
        category: input.category,
        requiresResponse: false,
        status: "recorded",
        replyTo: input.replyTo,
        at: now()
      };
      current.comments ||= [];
      current.comments.push(comment);
      if (comment.actor === "codex" && comment.replyTo) {
        const original = current.comments.find((item) => item.id === comment.replyTo);
        if (original?.actor === "user") {
          original.status = "responded";
          original.respondedAt = comment.at;
          original.responseCommentId = comment.id;
        }
      }
      current.updatedAt = comment.at;
      current.lastModifiedBy = comment.actor;
      addHistory(
        current,
        comment.actor,
        "commented",
        comment.category === "elimination_feedback"
          ? "新增后续选品避坑原因"
          : "新增双方记录留言",
        comment.at
      );
      return { comment, candidate: publicCandidate(current, data.rules) };
    });
    return json(res, 201, result);
  }

  const reviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/codex-review$/);
  if (req.method === "POST" && reviewRoute) {
    const input = await requestBody(req);
    if (!["approved", "needsInfo", "eliminated"].includes(input.decision)) {
      throw httpError(400, "Codex判断无效");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "Codex审核必须提供领取时的数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === reviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.lifecycleV11?.opportunityPackage || current.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧B审核入口；请使用新版B利润模型，商品状态未改变");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧审核结果不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (
        current.processing?.state === "running" &&
        input.runId &&
        current.processing.runId !== input.runId
      ) {
        throw httpError(409, "自动审核runId与当前领取任务不一致");
      }
      const reviewInput = { ...input };
      const wbAssessment = reviewInput.wbAssessment;
      delete reviewInput.wbAssessment;
      const autoElimination = codexAutoEliminationGate(
        { ...current, codexReview: reviewInput },
        data.rules
      );
      if (autoElimination.shouldEliminate && reviewInput.decision !== "eliminated") {
        reviewInput.decision = "eliminated";
        reviewInput.reason = autoElimination.reason;
        reviewInput.autoElimination = autoElimination;
      }
      if (
        reviewInput.decision === "approved" &&
        !["suitable", "notSuitable"].includes(wbAssessment?.status)
      ) {
        throw httpError(400, "进入待上架前必须同时给出WB适合或不适合的明确结论");
      }
      if (
        reviewInput.decision === "approved" &&
        wbAssessment?.status === "notSuitable" &&
        !wbAssessment.reason?.trim()
      ) {
        throw httpError(400, "WB不适合必须写明当前判断依据");
      }
      if (reviewInput.decision === "approved") {
        const scenarioGate = promotionPricingGate(
          reviewInput.profitCalculation,
          candidateProfitRule(current, data.rules)
        );
        if (!scenarioGate.passed) {
          throw httpError(422, "Ozon利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: scenarioGate.blockers
          });
        }
        const wbScenarioGate = promotionPricingGate(
          wbAssessment?.profitCalculation,
          data.rules.wbCrossListing
        );
        if (!wbScenarioGate.passed) {
          throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: wbScenarioGate.blockers
          });
        }
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeeds({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须明确列出用户需要补什么");
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeededFields({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须指向明确且可填写的字段，不能退回整套表单");
      }
      const reviewedAt = now();
      current.codexReview = { ...reviewInput, reviewedAt };
      if (reviewInput.decision === "approved") {
        const gate = profitReviewGate(current, data.rules);
        if (!gate.passed) {
          throw httpError(422, "不满足B阶段利润通过门槛，只能标为待补资料或淘汰", {
            blockers: gate.blockers
          });
        }
        current.workflowStatus = "listing_preparation";
        const assessedWb = { ...wbAssessment, assessedAt: reviewedAt };
        const wbGate = wbAssessmentDecisionGate(assessedWb, current, data.rules);
        if (!wbGate.passed) {
          throw httpError(422, "WB市场与利润判断不满足新规则", {
            blockers: wbGate.blockers
          });
        }
        current.wbAssessment = assessedWb;
        current.bPassedAt = reviewedAt;
        current.readyAt = null;
        current.cCompletedAt = null;
        current.defaultStock = 100;
        current.listingPreparation = {
          status: "queued",
          bCommissionMode: gate.commissionMode,
          startedAt: reviewedAt,
          completedAt: null,
          evidencePackIds: Array.isArray(reviewInput.evidencePackIds) ? reviewInput.evidencePackIds : []
        };
        current.evidencePackIds = Array.isArray(reviewInput.evidencePackIds) ? reviewInput.evidencePackIds : [];
        current.listingHandoff = {
          state: "queued",
          owner: "listing_task",
          handedOffAt: reviewedAt,
          queuedAt: reviewedAt,
          currentStep: "B阶段通过，已自动进入C1，等待上架任务领取",
          defaultStock: 100
        };
        current.eliminatedAt = null;
        current.eliminationReason = "";
      } else if (reviewInput.decision === "eliminated") {
        current.workflowStatus = "eliminated";
        current.readyAt = null;
        current.eliminatedAt = reviewedAt;
        current.eliminationReason = reviewInput.reason?.trim() || "Codex判断不可做";
      } else {
        current.workflowStatus = "needs_user_data";
        current.readyAt = null;
      }
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "idle",
        lastError: null,
        blockReason: null,
        userAction: "",
        dispatchState: "completed"
      };
      current.reviewedAt = reviewedAt;
      current.updatedAt = reviewedAt;
      current.lastModifiedBy = "codex";
      if (reviewInput.decision === "approved") {
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        const dispatch = createCandidateDispatch(data, map, current, {
          nodeId: "M07",
          message: "B阶段已按统一门槛通过。请只继承A/B冻结数据完成当前SKU的C1事实、合规、Schema和SEO方案；不得重新访问Ozon/WB/1688，不得重新选择供应商，不得执行店铺写入",
          trigger: "b_passed_auto_c1",
          actor: "system"
        });
        dispatchId = dispatch.id;
      }
      const labels = { approved: "B阶段通过并自动进入C1", needsInfo: "需要用户补资料", eliminated: "淘汰" };
      addHistory(current, "codex", "reviewed", `Codex判断：${labels[reviewInput.decision]}`, reviewedAt);
      return publicCandidate(current, data.rules);
    });
    const data = dispatchId ? await readData() : null;
    const dispatch = dispatchId ? data.dispatches.find((item) => item.id === dispatchId) : null;
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) });
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("B通过后自动派发C1失败", error)), 0);
    }
    return;
  }

  const wbRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/wb-assessment$/);
  const listingReadbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/listing-readback$/);
  const lifecycleEReadbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/e-readback$/);
  if (req.method === "POST" && lifecycleEReadbackRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "E阶段回读必须提供当前数据修订号");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === lifecycleEReadbackRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新回读");
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!skuPackage) throw httpError(409, "当前SKU没有新版生命周期数据包");
      if (skuPackage.eVerificationRecord) {
        if (skuPackage.eVerificationRecord.platformProductId === String(input.verifiedObservation?.platformProductId || "")) {
          return publicCandidate(current, data.rules);
        }
        throw httpError(409, "当前SKU已经完成另一个平台商品的E验证，禁止覆盖");
      }
      const expectedPlatform = current.targetStore === "wb" ? "wb" : "ozon";
      const observation = input.verifiedObservation || {};
      if (String(observation.platform || "").toLowerCase() !== expectedPlatform || String(observation.store || "").toLowerCase() !== current.targetStore) {
        throw httpError(409, "E回读平台或店铺与当前SKU不一致");
      }
      if (String(observation.skuPackageId || "") !== skuPackage.skuPackageId || String(observation.supplierSkuId || "") !== skuPackage.supplierSkuId || String(observation.merchantSku || "") !== skuPackage.supplierSkuId) {
        throw httpError(409, "E回读的生命周期、供应SKU或商家货号不一致");
      }
      const previousAuthorization = JSON.stringify(skuPackage.productionAuthorization);
      const timestamp = now();
      let eVerificationRecord;
      if (input.path === "system_created") {
        if (!skuPackage.productionRecord || skuPackage.externalListingRecord) throw httpError(409, "系统创建路径必须存在唯一ProductionRecord");
        try {
          eVerificationRecord = verifySystemCreatedListing({
            productionRecord: skuPackage.productionRecord,
            verifiedObservation: observation,
            verifiedAt: input.verifiedAt || timestamp,
            ownerPriceDecision: input.ownerPriceDecision
          });
        } catch (error) {
          throw httpError(422, error.message);
        }
      } else if (input.path === "external_discovered") {
        if (skuPackage.productionRecord) throw httpError(409, "存在ProductionRecord时不得改走外部发现路径");
        if (skuPackage.externalListingRecord) throw httpError(409, "ExternalListingRecord已经存在，禁止重复创建");
        let externalListingRecord;
        try {
          externalListingRecord = createExternalListingRecord({
            observation: input.discoveredObservation,
            ownerPriceDecision: input.ownerPriceDecision,
            discoveredAt: input.discoveredAt || timestamp
          });
          eVerificationRecord = verifyExternalListing({
            externalListingRecord,
            verifiedObservation: observation,
            verifiedAt: input.verifiedAt || timestamp
          });
        } catch (error) {
          throw httpError(422, error.message);
        }
        skuPackage.externalListingRecord = structuredClone(externalListingRecord);
      } else {
        throw httpError(400, "E阶段必须明确system_created或external_discovered路径");
      }
      skuPackage.eVerificationRecord = structuredClone(eVerificationRecord);
      skuPackage.businessPhase = "E";
      skuPackage.businessResult = "passed";
      skuPackage.technicalStatus = "completed";
      skuPackage.ownerAction = "none";
      skuPackage.readbackPolicy = {
        ...skuPackage.readbackPolicy,
        status: "completed",
        automaticAttempts: Number(skuPackage.readbackPolicy?.automaticAttempts || 0) + 1,
        consecutiveSameFailureCount: 0,
        lastFailureLayer: null,
        stopReason: null,
        stoppedAt: null
      };
      skuPackage.readbackHistory = [
        ...(skuPackage.readbackHistory || []),
        {
          verificationId: eVerificationRecord.verificationId,
          path: eVerificationRecord.verificationPath,
          outcome: eVerificationRecord.outcome,
          platformProductId: eVerificationRecord.platformProductId,
          verifiedAt: eVerificationRecord.verifiedAt,
          evidenceRef: eVerificationRecord.platformEvidenceRef
        }
      ];
      skuPackage.dataRevision = Number(skuPackage.dataRevision || 0) + 1;
      skuPackage.audit = {
        ...skuPackage.audit,
        updatedAt: eVerificationRecord.verifiedAt,
        history: [
          ...(skuPackage.audit?.history || []),
          {
            at: eVerificationRecord.verifiedAt,
            action: eVerificationRecord.outcome,
            evidenceRef: eVerificationRecord.platformEvidenceRef
          }
        ]
      };
      if (JSON.stringify(skuPackage.productionAuthorization) !== previousAuthorization) throw httpError(500, "E阶段禁止修改历史生产授权");
      try {
        assertValidLifecyclePackage(skuPackage);
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.lifecycleV11.status = eVerificationRecord.outcome;
      current.lifecycleV11.platformWrites = Number(current.lifecycleV11.platformWrites || 0);
      const listingRecord = {
        platform: eVerificationRecord.platform,
        store: eVerificationRecord.store,
        productId: eVerificationRecord.platformProductId,
        merchantSku: eVerificationRecord.merchantSku,
        productUrl: String(input.productUrl || ""),
        confirmedAt: eVerificationRecord.verifiedAt,
        moderationStatus: eVerificationRecord.moderationStatus,
        validationStatus: eVerificationRecord.validationStatus,
        saleStatus: eVerificationRecord.saleStatus,
        method: "automatic_readback",
        eVerificationOutcome: eVerificationRecord.outcome,
        createdByCurrentRun: eVerificationRecord.createdByCurrentRun,
        currentPrice: structuredClone(eVerificationRecord.currentPrice),
        currentStock: eVerificationRecord.currentStock,
        imageCount: eVerificationRecord.imageCount,
        errors: structuredClone(eVerificationRecord.errors),
        ownerPriceDecision: structuredClone(eVerificationRecord.ownerPriceDecision),
        readback: {
          sourceType: "real",
          source: input.readbackSource,
          checkedAt: eVerificationRecord.verifiedAt,
          evidenceRef: eVerificationRecord.platformEvidenceRef
        }
      };
      completeListing(current, listingRecord, "system", timestamp);
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "e_verified",
        reason: eVerificationRecord.outcome === "externally_verified"
          ? "平台商品由外部发现并完成E阶段独立验证；未伪造ProductionRecord。"
          : "系统创建商品已基于ProductionRecord完成E阶段独立验证。",
        writeOccurred: false,
        platformWrites: 0,
        decisionItems: []
      };
      addHistory(
        current,
        "system",
        eVerificationRecord.outcome,
        `${eVerificationRecord.outcome === "externally_verified" ? "外部发现商品" : "系统创建商品"}完成E验证：${eVerificationRecord.platform.toUpperCase()} ${eVerificationRecord.platformProductId}；当前价${eVerificationRecord.currentPrice.amount} ${eVerificationRecord.currentPrice.currency}；本轮零平台写入`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && listingReadbackRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "自动上架回写必须提供当前数据修订号");
    }
    let listingRecord;
    try {
      listingRecord = validateListingReadback(input);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listingReadbackRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus === "listed") {
        const existing = current.listingRecord || {};
        if (
          existing.platform === listingRecord.platform &&
          existing.productId === listingRecord.productId &&
          existing.merchantSku === listingRecord.merchantSku
        ) {
          return publicCandidate(current, data.rules);
        }
        throw httpError(409, "该候选已记录为另一个平台商品，不能自动覆盖");
      }
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品可以接收上架回读");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧上架回读不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (current.listingHandoff?.owner && current.listingHandoff.owner !== "listing_task") {
        throw httpError(409, "该SKU尚未交给上架任务，不能自动标记已上架");
      }
      if (listingRecord.store !== current.targetStore) {
        throw httpError(409, "回读店铺与候选目标店铺不一致");
      }
      const expectedPlatform = current.targetStore === "wb" ? "wb" : "ozon";
      if (listingRecord.platform !== expectedPlatform) {
        throw httpError(409, "回读平台与候选目标平台不一致");
      }
      const timestamp = now();
      completeListing(current, listingRecord, "listing_task", timestamp);
      addHistory(
        current,
        "system",
        "listingReadbackCompleted",
        `上架任务真实回读完成：${listingRecord.platform.toUpperCase()} ${listingRecord.productId} · ${listingRecord.moderationStatus} · ${listingRecord.saleStatus}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const listedRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/mark-listed$/);
  if (req.method === "POST" && listedRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "标记已上架必须提供当前数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listedRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const explicitlyConfirmedAlreadyListed = input.confirmedAlreadyListed === true;
      const stateOnlyManualConfirmation = explicitlyConfirmedAlreadyListed &&
        ["ready_to_list", "listing_preparation"].includes(current.workflowStatus);
      if (current.workflowStatus !== "ready_to_list" && !stateOnlyManualConfirmation) {
        throw httpError(409, "只有待上架商品可以标记为已上架");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已更新，请刷新后再确认已上架");
      }
      let listingRecord;
      try {
        listingRecord = validateListingRecord({
          ...input,
          store: input.store || current.targetStore
        }, { allowMissingIdentity: stateOnlyManualConfirmation });
        if (stateOnlyManualConfirmation) {
          listingRecord.confirmationSource = "user_explicit_confirmation";
          listingRecord.stateOnly = true;
        }
      } catch (error) {
        throw httpError(400, error.message);
      }
      const timestamp = now();
      completeListing(current, listingRecord, "user", timestamp);
      addHistory(
        current,
        "user",
        "markedListed",
        `自动回读不可用，手动确认上架：${listingRecord.platform.toUpperCase()} ${listingRecord.productId || listingRecord.productUrl}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && wbRoute) {
    const input = await requestBody(req);
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "WB独立判断只能由受控内部回写提交");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "WB判断必须提供当前数据修订号");
    }
    if (!["suitable", "notSuitable"].includes(input.status)) {
      throw httpError(400, "WB判断状态无效");
    }
    if (input.status === "notSuitable" && !input.reason?.trim()) {
      throw httpError(400, "WB不适合必须写明当前判断依据");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === wbRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品才进行WB独立复算");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "WB判断时商品资料已变化，请刷新后重试", {
          currentRevision: current.dataRevision
        });
      }
      const assessment = { ...input, assessedAt: now() };
      const scenarioGate = promotionPricingGate(
        assessment.profitCalculation,
        data.rules.wbCrossListing
      );
      if (!scenarioGate.passed) {
        throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
          blockers: scenarioGate.blockers
        });
      }
      const gate = wbAssessmentDecisionGate(assessment, current, data.rules);
      if (!gate.passed) {
        throw httpError(422, "WB市场与利润判断不满足新规则", { blockers: gate.blockers });
      }
      current.wbAssessment = assessment;
      current.updatedAt = assessment.assessedAt;
      current.lastModifiedBy = "codex";
      addHistory(current, "codex", "wbAssessed", `WB独立判断：${input.status}`, assessment.assessedAt);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  return json(res, 404, { message: "接口不存在" });
}

async function serveFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw httpError(404, "文件不存在", { code: "static_file_not_found" });
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    // This dashboard is an operational surface: serving a stale JavaScript bundle
    // can make a valid form submit without its current dataRevision. Always ask
    // the browser to revalidate app assets instead of retaining an old UI.
    "Cache-Control": extension === ".html" ? "no-cache" : "no-cache"
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = parseHttpRequestTarget(req.url, req.headers.host, {
      fallbackHost: `${host}:${port}`
    });
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    if (pathname.startsWith("/product-images/")) {
      const filename = path.basename(pathname);
      return await serveFile(res, path.join(imagesDir, filename));
    }
    if (apiOnly) return json(res, 404, { message: "API服务仅处理/api和/product-images" });
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(distDir, requested);
    if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
      return json(res, 403, { message: "禁止访问" });
    }
    try {
      return await serveFile(res, filePath);
    } catch {
      return await serveFile(res, path.join(distDir, "index.html"));
    }
  } catch (error) {
    return respondWithError(req, res, error);
  }
});

const restartReconciliation = await reconcileOrphanedASupplierCaptureJobsAfterRestart();
const ossRestartReconciliation = await reconcileOrphanedAliyunOssAssetIntentsAfterRestart();
const keywordSoftwareRestartReconciliation = await reconcileOrphanedKeywordEvidenceSoftwareJobsAfterRestart();
const genericSoftwareJobRestartReconciliation = await softwareJobStore.reconcileAfterRestart();

server.listen(port, host, () => {
  console.log(`全店经营工作台${apiOnly ? " API" : ""}：http://${host}:${port}`);
  if (restartReconciliation.count > 0) {
    console.log(`已收口 ${restartReconciliation.count} 条服务重启前遗留的A阶段采集作业；未恢复令牌、会话或自动重试。`);
  }
  if (ossRestartReconciliation.count > 0) {
    console.log(`已收口 ${ossRestartReconciliation.count} 条服务重启前遗留的OSS素材传输意图；未自动重试。`);
  }
  if (keywordSoftwareRestartReconciliation.count > 0) {
    console.log(`已收口 ${keywordSoftwareRestartReconciliation.count} 条服务重启前遗留的Seerfar软件作业；均标记结果未知且未自动重试。`);
  }
  if (genericSoftwareJobRestartReconciliation.reconciled.length > 0) {
    console.log(`已收口 ${genericSoftwareJobRestartReconciliation.reconciled.length} 条服务重启前遗留的通用软件作业；未发请求的记失败，已发请求的记结果未知，均不自动重试。`);
  }
  if (explicitDispatchDeliveryEnabled) {
    deliverWaitingDispatches().catch((error) => console.error("启动时恢复合法待派发任务失败", error));
  }
});

// This guard never claims work or calls a marketplace. It only stops a run
// whose auditable progress lease expired, then creates one deduplicated notice
// for total control to consume.
const noProgressGuard = setInterval(() => {
  stopRunsWithoutProgress().catch((error) => console.error("防空跑门禁失败", error));
}, 60_000);
noProgressGuard.unref();

function closeServer() {
  clearInterval(noProgressGuard);
  codexDispatcher?.close();
  server.close(() => process.exit(0));
}

process.once("SIGTERM", closeServer);
process.once("SIGINT", closeServer);

export { server };
