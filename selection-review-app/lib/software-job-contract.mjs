import {
  PRODUCTION_CONTRACT_MAX_DEPTH,
  PRODUCTION_CONTRACT_MAX_NODES,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import { validateC2StableAssetTransportResult } from "./c2-asset-lifecycle.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities, WORKER_CAPABILITIES } from "./runtime-identity.mjs";

export const EXTERNAL_REQUEST_STATES = Object.freeze(["not_sent", "in_flight", "failed", "unknown_outcome", "succeeded"]);
export const SOFTWARE_JOB_STATUSES = Object.freeze(["queued", "claimed", "waiting_platform", "completed", "failed", "unknown_outcome"]);
export const SOFTWARE_JOB_RESULT_ENVELOPE_VERSION = "software-job-result-envelope-v1";
export const C2_STABLE_ASSET_TRANSPORT_JOB_TYPE = "c2_stable_asset_transport";
export const C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE = "c1_paid_keyword_evidence";
export const C2_STABLE_ASSET_TRANSPORT_CAPABILITY = "stable-asset-transport";
export const C1_PAID_KEYWORD_EVIDENCE_CAPABILITY = "seerfar-open-api";
export const C1_PAID_KEYWORD_PROVIDER = "seerfar_open_api";
export const C1_PAID_KEYWORD_POINTS = 15;
export const SOFTWARE_JOB_TYPES = Object.freeze([
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE
]);
export const SOFTWARE_JOB_REQUIRED_CAPABILITIES_BY_TYPE = Object.freeze({
  [C2_STABLE_ASSET_TRANSPORT_JOB_TYPE]: Object.freeze([C2_STABLE_ASSET_TRANSPORT_CAPABILITY]),
  [C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE]: Object.freeze([C1_PAID_KEYWORD_EVIDENCE_CAPABILITY])
});
export const SOFTWARE_JOB_APPLICATION_DISPOSITIONS = Object.freeze([
  "applied",
  "revision_conflict_not_applied",
  "result_recorded_no_candidate_mutation"
]);
export const SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE = [
  "^(?=.{1,256}$)",
  "(?!.*[\\u0000-\\u001f\\s?#@=&\\\\])",
  "(?!(?:[Ff][Ii][Ll][Ee]:|[Hh][Tt][Tt][Pp][Ss]?:|/|\\\\|[A-Za-z]:[\\\\/]))",
  "(?!.*//)",
  "[A-Za-z0-9][A-Za-z0-9._:~-]*$"
].join("");
const SOFTWARE_JOB_STRICT_REF_PATTERN = new RegExp(SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE);
const SOFTWARE_JOB_RESULT_ENVELOPE_MAX_STRING_BYTES = 65_536;
const SOFTWARE_JOB_RESULT_ENVELOPE_MAX_TOTAL_STRING_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();
const RESERVED_STABLE_ASSET_HOST_SUFFIXES = Object.freeze([
  "localhost",
  "local",
  "localdomain",
  "lan",
  "home",
  "internal"
]);

export function isReservedSoftwareJobHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || /^\[[0-9a-f:.]+\]$/i.test(normalized)) return true;
  return RESERVED_STABLE_ASSET_HOST_SUFFIXES.some((suffix) =>
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`SOFTWARE_JOB_INVALID: ${label}不能为空`);
  return normalized;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("SOFTWARE_JOB_INVALID: revision无效");
  return value;
}

function iso(value, label) {
  const normalized = text(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`SOFTWARE_JOB_INVALID: ${label}无效`);
  return new Date(normalized).toISOString();
}

function strictRef(value, label) {
  const normalized = text(value, label);
  if (!SOFTWARE_JOB_STRICT_REF_PATTERN.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是有界opaque引用`);
  }
  return normalized;
}

function sha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是sha256`);
  return normalized;
}

export function assertSoftwareJobStrictRef(value, label = "softwareJobRef") {
  return strictRef(value, label);
}

export function assertBoundedResultEnvelopeStructure(value, label = "resultEnvelope") {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let nodeCount = 0;
  let totalStringBytes = 0;
  const addStringBytes = (text) => {
    const bytes = TEXT_ENCODER.encode(text).length;
    totalStringBytes += bytes;
    if (bytes > SOFTWARE_JOB_RESULT_ENVELOPE_MAX_STRING_BYTES ||
        totalStringBytes > SOFTWARE_JOB_RESULT_ENVELOPE_MAX_TOTAL_STRING_BYTES) {
      throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}字符串超过资源上限`);
    }
  };
  while (stack.length > 0) {
    const current = stack.pop();
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}超过资源上限`);
    }
    if (typeof current.value === "string") {
      addStringBytes(current.value);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) throw new Error(`SOFTWARE_JOB_RESULT_ENVELOPE_INVALID: ${label}不得包含循环引用`);
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else {
      for (const [key, item] of Object.entries(current.value)) {
        addStringBytes(key);
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

function boundedText(value, label) {
  const normalized = text(value, label);
  if (normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}必须是有界文本`);
  }
  return normalized;
}

function normalizeStoreRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["mappingVersion", "platformStoreId", "stableStoreId"])) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding.storeRef无效");
  }
  return Object.freeze({
    stableStoreId: strictRef(value.stableStoreId, "scopeBinding.storeRef.stableStoreId"),
    platformStoreId: strictRef(value.platformStoreId, "scopeBinding.storeRef.platformStoreId"),
    mappingVersion: strictRef(value.mappingVersion, "scopeBinding.storeRef.mappingVersion")
  });
}

function normalizeWorkerCapabilitiesSnapshot(capabilities, label = "workerCapabilitiesSnapshot") {
  if (!Array.isArray(capabilities) || capabilities.some((item) => !WORKER_CAPABILITIES.includes(item))) {
    throw new Error(`SOFTWARE_JOB_INVALID: ${label}无效`);
  }
  return Object.freeze([...new Set(capabilities)].sort());
}

function normalizeC2ScopeBinding(value, { candidateId, skuPackageId, revision: resultRevision }) {
  const allowed = [
    "schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "platform", "storeRef",
    "supplierSkuId", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint",
    "stagedAssetManifestFingerprint", "ownerStagingConfirmationRef", "allowedStableAssetHosts"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== "software-job-scope-v1" ||
      value.candidateId !== candidateId || value.skuPackageId !== skuPackageId ||
      !Number.isInteger(value.sourceRevision) || value.sourceRevision < 0 ||
      value.resultRevision !== value.sourceRevision + 1 || value.resultRevision !== resultRevision ||
      value.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Array.isArray(value.allowedStableAssetHosts) || value.allowedStableAssetHosts.length === 0 ||
      value.allowedStableAssetHosts.length > 16) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding无效");
  }
  const hosts = [...new Set(value.allowedStableAssetHosts.map((host) => String(host).trim().toLowerCase()))].sort();
  if (hosts.length !== value.allowedStableAssetHosts.length || hosts.some((host) =>
    host.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ||
    isReservedSoftwareJobHost(host))) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding.allowedStableAssetHosts无效");
  }
  return Object.freeze({
    schemaVersion: "software-job-scope-v1",
    candidateId: strictRef(value.candidateId, "scopeBinding.candidateId"),
    skuPackageId: strictRef(value.skuPackageId, "scopeBinding.skuPackageId"),
    sourceRevision: value.sourceRevision,
    resultRevision: value.resultRevision,
    platform: strictRef(value.platform, "scopeBinding.platform"),
    storeRef: normalizeStoreRef(value.storeRef),
    supplierSkuId: strictRef(value.supplierSkuId, "scopeBinding.supplierSkuId"),
    variantKey: boundedText(value.variantKey, "scopeBinding.variantKey"),
    sideEffectScope: value.sideEffectScope,
    authorizationRef: strictRef(value.authorizationRef, "scopeBinding.authorizationRef"),
    credentialAlias: strictRef(value.credentialAlias, "scopeBinding.credentialAlias"),
    inputFingerprint: sha256(value.inputFingerprint, "scopeBinding.inputFingerprint"),
    stagedAssetManifestFingerprint: sha256(value.stagedAssetManifestFingerprint, "scopeBinding.stagedAssetManifestFingerprint"),
    ownerStagingConfirmationRef: strictRef(value.ownerStagingConfirmationRef, "scopeBinding.ownerStagingConfirmationRef"),
    allowedStableAssetHosts: Object.freeze(hosts)
  });
}

function normalizeC1ScopeBinding(value, { candidateId, skuPackageId, revision: resultRevision }) {
  const allowed = [
    "schemaVersion", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "platform", "targetStore",
    "supplierSkuId", "variantKey", "sideEffectScope", "authorizationRef", "credentialAlias", "inputFingerprint",
    "planningEvidenceFingerprint", "runtimeInputFingerprint", "seerfarRequestFingerprint", "salesSnapshotFingerprint",
    "supplySnapshotFingerprint", "profitModelFingerprint", "c1FactsFingerprint", "pointBudgetEvidenceRef",
    "quotaEvidenceRef", "pointsAuthorized", "provider"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== "software-job-scope-v1" ||
      value.candidateId !== candidateId || value.skuPackageId !== skuPackageId ||
      !Number.isInteger(value.sourceRevision) || value.sourceRevision < 0 ||
      value.resultRevision !== value.sourceRevision + 1 || value.resultRevision !== resultRevision ||
      value.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      value.provider !== C1_PAID_KEYWORD_PROVIDER ||
      value.pointsAuthorized !== C1_PAID_KEYWORD_POINTS) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding无效");
  }
  return Object.freeze({
    schemaVersion: "software-job-scope-v1",
    candidateId: strictRef(value.candidateId, "scopeBinding.candidateId"),
    skuPackageId: strictRef(value.skuPackageId, "scopeBinding.skuPackageId"),
    sourceRevision: value.sourceRevision,
    resultRevision: value.resultRevision,
    platform: strictRef(value.platform, "scopeBinding.platform"),
    targetStore: strictRef(value.targetStore, "scopeBinding.targetStore"),
    supplierSkuId: strictRef(value.supplierSkuId, "scopeBinding.supplierSkuId"),
    variantKey: boundedText(value.variantKey, "scopeBinding.variantKey"),
    sideEffectScope: value.sideEffectScope,
    authorizationRef: strictRef(value.authorizationRef, "scopeBinding.authorizationRef"),
    credentialAlias: strictRef(value.credentialAlias, "scopeBinding.credentialAlias"),
    inputFingerprint: sha256(value.inputFingerprint, "scopeBinding.inputFingerprint"),
    planningEvidenceFingerprint: sha256(value.planningEvidenceFingerprint, "scopeBinding.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(value.runtimeInputFingerprint, "scopeBinding.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(value.seerfarRequestFingerprint, "scopeBinding.seerfarRequestFingerprint"),
    salesSnapshotFingerprint: sha256(value.salesSnapshotFingerprint, "scopeBinding.salesSnapshotFingerprint"),
    supplySnapshotFingerprint: sha256(value.supplySnapshotFingerprint, "scopeBinding.supplySnapshotFingerprint"),
    profitModelFingerprint: sha256(value.profitModelFingerprint, "scopeBinding.profitModelFingerprint"),
    c1FactsFingerprint: sha256(value.c1FactsFingerprint, "scopeBinding.c1FactsFingerprint"),
    pointBudgetEvidenceRef: strictRef(value.pointBudgetEvidenceRef, "scopeBinding.pointBudgetEvidenceRef"),
    quotaEvidenceRef: strictRef(value.quotaEvidenceRef, "scopeBinding.quotaEvidenceRef"),
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER
  });
}

function normalizeScopeBinding(value, identity, jobType) {
  if (value === null || value === undefined) {
    throw new Error("SOFTWARE_JOB_INVALID: scopeBinding必须绑定具体领域副作用");
  }
  if (jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE) return normalizeC2ScopeBinding(value, identity);
  if (jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) return normalizeC1ScopeBinding(value, identity);
  throw new Error("SOFTWARE_JOB_INVALID: jobType不支持");
}

export function createSoftwareJobEnvelope({
  jobId,
  candidateId,
  skuPackageId,
  revision: sourceRevision,
  jobType,
  createdAt,
  requestedByUserId,
  ownerUserId,
  requiredCapabilities,
  idempotencyKey,
  scopeBinding = null
}) {
  const normalizedJobType = strictRef(jobType, "jobType");
  if (!SOFTWARE_JOB_TYPES.includes(normalizedJobType)) {
    throw new Error("SOFTWARE_JOB_INVALID: jobType不支持");
  }
  const expectedCapabilities = SOFTWARE_JOB_REQUIRED_CAPABILITIES_BY_TYPE[normalizedJobType];
  if (!Array.isArray(requiredCapabilities) ||
      JSON.stringify([...new Set(requiredCapabilities)].sort()) !== JSON.stringify(expectedCapabilities) ||
      requiredCapabilities.some((item) => !WORKER_CAPABILITIES.includes(item))) {
    throw new Error("SOFTWARE_JOB_INVALID: requiredCapabilities无效");
  }
  const identity = {
    candidateId: strictRef(candidateId, "candidateId"),
    skuPackageId: strictRef(skuPackageId, "skuPackageId"),
    revision: revision(sourceRevision)
  };
  return Object.freeze({
    schemaVersion: "software-job-v1",
    jobId: strictRef(jobId, "jobId"),
    candidateId: identity.candidateId,
    skuPackageId: identity.skuPackageId,
    revision: identity.revision,
    jobType: normalizedJobType,
    status: "queued",
    createdAt: iso(createdAt, "createdAt"),
    startedAt: null,
    lastProgressAt: null,
    completedAt: null,
    requestedByUserId: strictRef(requestedByUserId, "requestedByUserId"),
    ownerUserId: strictRef(ownerUserId, "ownerUserId"),
    requiredCapabilities: expectedCapabilities,
    workerId: null,
    workerVersion: null,
    workerCapabilitiesSnapshot: Object.freeze([]),
    leaseId: null,
    leaseExpiresAt: null,
    attempt: 0,
    idempotencyKey: strictRef(idempotencyKey, "idempotencyKey"),
    externalRequestState: "not_sent",
    externalRequestRef: null,
    progressRef: null,
    resultRef: null,
    resultEnvelope: null,
    failureClass: null,
    automaticRetryAllowed: false,
    admissionDecision: null,
    scopeBinding: normalizeScopeBinding(scopeBinding, identity, normalizedJobType)
  });
}

export function claimSoftwareJobLease({ job, worker, leaseId, serverTime, leaseDurationMs }) {
  if (!job || job.schemaVersion !== "software-job-v1" || job.status !== "queued" || job.attempt !== 0) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: 作业不是可领取状态");
  }
  if (!worker || worker.status !== "online" || !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: Worker能力或状态不满足");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 30 * 60 * 1000) {
    throw new Error("SOFTWARE_JOB_CLAIM_REJECTED: leaseDurationMs无效");
  }
  const startedAt = iso(serverTime, "serverTime");
  return Object.freeze({
    ...structuredClone(job),
    status: "claimed",
    startedAt,
    lastProgressAt: startedAt,
    workerId: strictRef(worker.workerId, "workerId"),
    workerVersion: strictRef(worker.version, "workerVersion"),
    workerCapabilitiesSnapshot: normalizeWorkerCapabilitiesSnapshot(worker.capabilities),
    leaseId: strictRef(leaseId, "leaseId"),
    leaseExpiresAt: new Date(Date.parse(startedAt) + leaseDurationMs).toISOString(),
    attempt: 1
  });
}

export function bindSoftwareJobAdmissionDecision(job, decision) {
  if (!job || job.schemaVersion !== "software-job-v1" || !job.scopeBinding ||
      !decision || decision.schemaVersion !== "software-job-admission-v1" ||
      decision.jobId !== job.jobId || decision.candidateId !== job.candidateId ||
      decision.skuPackageId !== job.skuPackageId || decision.revision !== job.revision ||
      decision.jobType !== job.jobType || decision.authorizationRef !== job.scopeBinding.authorizationRef ||
      decision.credentialAlias !== job.scopeBinding.credentialAlias ||
      !/^[a-f0-9]{64}$/.test(String(decision.authorizationFingerprint || "")) ||
      !/^[a-f0-9]{64}$/.test(String(decision.credentialBindingFingerprint || ""))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_DECISION_INVALID");
  }
  const normalizedDecision = structuredClone(decision);
  assertSafeRuntimeRecord(normalizedDecision, "softwareJob.admissionDecision");
  return Object.freeze({
    ...structuredClone(job),
    admissionDecision: Object.freeze(normalizedDecision)
  });
}

export function softwareJobRequiresDomainSettlement(job) {
  return job?.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
    job?.scopeBinding?.sideEffectScope === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
    job?.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
    job?.scopeBinding?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE;
}

function assertActiveLease(job, { workerId, leaseId, serverTime }) {
  if (job.workerId !== strictRef(workerId, "workerId") || job.leaseId !== strictRef(leaseId, "leaseId")) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: Worker或租约不匹配");
  }
  const observedAt = iso(serverTime, "serverTime");
  if (!job.leaseExpiresAt || Date.parse(observedAt) > Date.parse(job.leaseExpiresAt)) {
    throw new Error("SOFTWARE_JOB_LEASE_REJECTED: 租约已过期");
  }
  return observedAt;
}

export function recordSoftwareJobProgress({ job, workerId, leaseId, progressRef, serverTime }) {
  if (!job || job.schemaVersion !== "software-job-v1" || job.status !== "claimed" || job.attempt !== 1) {
    throw new Error("SOFTWARE_JOB_PROGRESS_REJECTED: 作业不是已领取状态");
  }
  const observedAt = assertActiveLease(job, { workerId, leaseId, serverTime });
  const next = {
    ...structuredClone(job),
    lastProgressAt: observedAt,
    progressRef: strictRef(progressRef, "progressRef")
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function markSoftwareJobExternalRequestStarted({ job, workerId, leaseId, externalRequestRef, serverTime }) {
  if (!job || job.schemaVersion !== "software-job-v1" || job.status !== "claimed" || job.attempt !== 1 || job.externalRequestState !== "not_sent") {
    throw new Error("SOFTWARE_JOB_EXTERNAL_REQUEST_REJECTED: 作业不能开始外部请求");
  }
  const observedAt = assertActiveLease(job, { workerId, leaseId, serverTime });
  const next = {
    ...structuredClone(job),
    status: "waiting_platform",
    lastProgressAt: observedAt,
    externalRequestState: "in_flight",
    externalRequestRef: strictRef(externalRequestRef, "externalRequestRef")
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

function restartOrLeaseReconciliationContext(job, serverTime) {
  if (!job || job.schemaVersion !== "software-job-v1" ||
      !["claimed", "waiting_platform"].includes(job.status) ||
      job.attempt !== 1 ||
      job.completedAt !== null ||
      job.resultRef !== null ||
      job.resultEnvelope !== null ||
      !job.startedAt ||
      !job.lastProgressAt ||
      !job.workerId ||
      !job.leaseId ||
      !job.leaseExpiresAt) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  const observedAt = iso(serverTime, "serverTime");
  const startedAt = iso(job.startedAt, "startedAt");
  const lastProgressAt = iso(job.lastProgressAt, "lastProgressAt");
  const leaseExpiresAt = iso(job.leaseExpiresAt, "leaseExpiresAt");
  strictRef(job.workerId, "workerId");
  strictRef(job.leaseId, "leaseId");
  if (Date.parse(observedAt) < Date.parse(startedAt) ||
      Date.parse(observedAt) < Date.parse(lastProgressAt)) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  if (job.status === "claimed") {
    if (job.externalRequestState !== "not_sent" || job.externalRequestRef !== null) {
      throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
    }
    return Object.freeze({ observedAt, leaseExpiresAt, requestWasSent: false });
  }
  if (job.externalRequestState !== "in_flight" || !job.externalRequestRef) {
    throw new Error("SOFTWARE_JOB_RECONCILIATION_REJECTED");
  }
  strictRef(job.externalRequestRef, "externalRequestRef");
  return Object.freeze({ observedAt, leaseExpiresAt, requestWasSent: true });
}

function reconciledSoftwareJob(job, { observedAt, requestWasSent, failureClass }) {
  const next = {
    ...structuredClone(job),
    status: requestWasSent ? "unknown_outcome" : "failed",
    completedAt: observedAt,
    lastProgressAt: observedAt,
    externalRequestState: requestWasSent ? "unknown_outcome" : "not_sent",
    failureClass,
    automaticRetryAllowed: false
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function reconcileSoftwareJobAfterRestart({ job, serverTime }) {
  const context = restartOrLeaseReconciliationContext(job, serverTime);
  return reconciledSoftwareJob(job, {
    observedAt: context.observedAt,
    requestWasSent: context.requestWasSent,
    failureClass: context.requestWasSent ? "service_restart_after_external_request" : "service_restart_before_external_request"
  });
}

export function reconcileExpiredSoftwareJobLease({ job, serverTime }) {
  const context = restartOrLeaseReconciliationContext(job, serverTime);
  if (Date.parse(context.observedAt) <= Date.parse(context.leaseExpiresAt)) {
    throw new Error("SOFTWARE_JOB_LEASE_NOT_EXPIRED");
  }
  return reconciledSoftwareJob(job, {
    observedAt: context.observedAt,
    requestWasSent: context.requestWasSent,
    failureClass: context.requestWasSent ? "lease_expired_after_external_request" : "lease_expired_before_external_request"
  });
}

function normalizeResultEnvelope(envelope, job, applicationDisposition) {
  assertBoundedResultEnvelopeStructure(envelope);
  const allowedKeys = [
    "schemaVersion", "resultRef", "jobId", "jobType", "candidateId", "skuPackageId", "revision",
    "workerId", "leaseId", "externalRequestRef", "externalRequestState", "payloadKind", "payload",
    "payloadFingerprint", "applicationDisposition", "recordedAt"
  ];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).some((key) => !allowedKeys.includes(key)) ||
      envelope.schemaVersion !== SOFTWARE_JOB_RESULT_ENVELOPE_VERSION ||
      envelope.externalRequestState !== "succeeded" ||
      envelope.jobId !== job.jobId || envelope.jobType !== job.jobType ||
      envelope.payloadKind !== job.jobType ||
      envelope.candidateId !== job.candidateId || envelope.skuPackageId !== job.skuPackageId ||
      envelope.revision !== job.revision || envelope.workerId !== job.workerId ||
      envelope.leaseId !== job.leaseId || envelope.externalRequestRef !== job.externalRequestRef ||
      !SOFTWARE_JOB_APPLICATION_DISPOSITIONS.includes(applicationDisposition) ||
      !SOFTWARE_JOB_APPLICATION_DISPOSITIONS.includes(envelope.applicationDisposition) ||
      !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
  }
  const payload = structuredClone(envelope.payload);
  const payloadFingerprint = fingerprintCanonicalRecord(payload);
  if (envelope.payloadFingerprint !== payloadFingerprint) throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
  const normalized = {
    schemaVersion: SOFTWARE_JOB_RESULT_ENVELOPE_VERSION,
    resultRef: strictRef(envelope.resultRef, "resultEnvelope.resultRef"),
    jobId: strictRef(envelope.jobId, "resultEnvelope.jobId"),
    jobType: strictRef(envelope.jobType, "resultEnvelope.jobType"),
    candidateId: strictRef(envelope.candidateId, "resultEnvelope.candidateId"),
    skuPackageId: strictRef(envelope.skuPackageId, "resultEnvelope.skuPackageId"),
    revision: revision(envelope.revision),
    workerId: strictRef(envelope.workerId, "resultEnvelope.workerId"),
    leaseId: strictRef(envelope.leaseId, "resultEnvelope.leaseId"),
    externalRequestRef: strictRef(envelope.externalRequestRef, "resultEnvelope.externalRequestRef"),
    externalRequestState: "succeeded",
    payloadKind: strictRef(envelope.payloadKind, "resultEnvelope.payloadKind"),
    payload,
    payloadFingerprint,
    applicationDisposition,
    recordedAt: iso(envelope.recordedAt, "resultEnvelope.recordedAt")
  };
  assertSafeRuntimeRecord(normalized, "softwareJob.resultEnvelope");
  return Object.freeze(normalized);
}

export function createSoftwareJobResultEnvelope({
  job,
  resultRef,
  payloadKind,
  payload,
  recordedAt,
  applicationDisposition = "result_recorded_no_candidate_mutation"
}) {
  assertBoundedResultEnvelopeStructure(payload, "resultEnvelope.payload");
  const payloadFingerprint = fingerprintCanonicalRecord(payload);
  return normalizeResultEnvelope({
    schemaVersion: SOFTWARE_JOB_RESULT_ENVELOPE_VERSION,
    resultRef,
    jobId: job?.jobId,
    jobType: job?.jobType,
    candidateId: job?.candidateId,
    skuPackageId: job?.skuPackageId,
    revision: job?.revision,
    workerId: job?.workerId,
    leaseId: job?.leaseId,
    externalRequestRef: job?.externalRequestRef,
    externalRequestState: "succeeded",
    payloadKind,
    payload,
    payloadFingerprint,
    applicationDisposition,
    recordedAt
  }, job, applicationDisposition);
}

function settleSoftwareJobCore({
  job,
  workerId,
  leaseId,
  status,
  externalRequestState,
  serverTime,
  resultRef = null,
  resultEnvelope = null,
  applicationDisposition = "result_recorded_no_candidate_mutation",
  failureClass = null,
  externalRequestRef = job?.externalRequestRef ?? null,
  domainSettlementValidated = false
}) {
  if (!job || job.schemaVersion !== "software-job-v1" || !["claimed", "waiting_platform"].includes(job.status) || job.attempt !== 1) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 作业不是已领取状态");
  }
  const completedAt = assertActiveLease(job, { workerId, leaseId, serverTime });
  if (!['completed', 'failed', 'unknown_outcome'].includes(status) || !EXTERNAL_REQUEST_STATES.includes(externalRequestState)) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 终态无效");
  }
  let normalizedEnvelope = null;
  if (status === "completed") {
    if (softwareJobRequiresDomainSettlement(job) && !domainSettlementValidated) {
      throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED");
    }
    if (job.status !== "waiting_platform" || job.externalRequestState !== "in_flight" || externalRequestState !== "succeeded" || !resultEnvelope) {
      throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 完成态必须从已持久化in_flight收口且有结果封套");
    }
    normalizedEnvelope = normalizeResultEnvelope(resultEnvelope, job, applicationDisposition);
    if (resultRef !== null && resultRef !== undefined && resultRef !== normalizedEnvelope.resultRef) {
      throw new Error("SOFTWARE_JOB_RESULT_ENVELOPE_INVALID");
    }
    resultRef = normalizedEnvelope.resultRef;
  }
  if (status === "unknown_outcome" && (job.status !== "waiting_platform" || job.externalRequestState !== "in_flight" || externalRequestState !== "unknown_outcome")) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 结果未知必须从已持久化in_flight收口");
  }
  if (status === "failed") {
    if (!failureClass) throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 失败态必须提供failureClass");
    const validFailureTransition =
      (job.status === "claimed" && job.externalRequestState === "not_sent" && externalRequestState === "not_sent") ||
      (job.status === "waiting_platform" && job.externalRequestState === "in_flight" && externalRequestState === "failed") ||
      (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && job.status === "waiting_platform" &&
        job.externalRequestState === "in_flight" && externalRequestState === "succeeded" &&
        failureClass === "c1-paid-keyword-local-preparation-failed" && resultRef === null && resultEnvelope === null);
    if (!validFailureTransition) throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: 失败态与已持久化外部请求状态不一致");
  }
  const persistedExternalRequestRef = job.externalRequestRef ?? null;
  if ((externalRequestRef ?? null) !== persistedExternalRequestRef) {
    throw new Error("SOFTWARE_JOB_SETTLEMENT_REJECTED: externalRequestRef不得由结算调用覆盖");
  }
  const next = {
    ...structuredClone(job),
    status,
    lastProgressAt: completedAt,
    completedAt,
    externalRequestState,
    externalRequestRef: persistedExternalRequestRef,
    resultRef: resultRef ? strictRef(resultRef, "resultRef") : null,
    resultEnvelope: normalizedEnvelope ? structuredClone(normalizedEnvelope) : null,
    failureClass: failureClass ? strictRef(failureClass, "failureClass") : null,
    automaticRetryAllowed: false
  };
  assertSafeRuntimeRecord(next, "softwareJob");
  return Object.freeze(next);
}

export function settleSoftwareJob(settlement) {
  return settleSoftwareJobCore({
    ...settlement,
    domainSettlementValidated: false
  });
}

export function softwareJobsInDocument(document) {
  if (!document.runtime || typeof document.runtime !== "object" || Array.isArray(document.runtime)) document.runtime = {};
  if (!Array.isArray(document.runtime.softwareJobs)) document.runtime.softwareJobs = [];
  return document.runtime.softwareJobs;
}

export function sameSoftwareJobIdentity(left, right) {
  return left.jobId === right.jobId && left.candidateId === right.candidateId &&
    left.skuPackageId === right.skuPackageId && left.revision === right.revision && left.jobType === right.jobType &&
    left.requestedByUserId === right.requestedByUserId && left.ownerUserId === right.ownerUserId &&
    (left.resultEnvelope ?? null) === null && (right.resultEnvelope ?? null) === null &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.requiredCapabilities) === JSON.stringify(right.requiredCapabilities) &&
    JSON.stringify(left.scopeBinding) === JSON.stringify(right.scopeBinding);
}

export function findSoftwareJobInDocument(document, jobId) {
  return softwareJobsInDocument(document).find((entry) => entry.jobId === jobId) || null;
}

export function enqueueSoftwareJobInDocument(document, job) {
  assertSafeRuntimeRecord(job, "softwareJob");
  const jobs = softwareJobsInDocument(document);
  const existing = jobs.find((entry) => entry.idempotencyKey === job.idempotencyKey);
  if (existing) {
    if (!sameSoftwareJobIdentity(existing, job)) throw new Error("SOFTWARE_JOB_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ changed: false, job: structuredClone(existing) });
  }
  if (jobs.some((entry) => entry.jobId === job.jobId)) throw new Error("SOFTWARE_JOB_ID_CONFLICT");
  jobs.push(structuredClone(job));
  return Object.freeze({ changed: true, job: structuredClone(job) });
}

function settleSoftwareJobInDocumentCore(document, settlement, serverTime, { domainSettlementValidated = false } = {}) {
  const jobs = softwareJobsInDocument(document);
  const index = jobs.findIndex((entry) => entry.jobId === settlement.jobId);
  if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  const next = settleSoftwareJobCore({
    job: jobs[index],
    workerId: settlement.workerId,
    leaseId: settlement.leaseId,
    status: settlement.status,
    externalRequestState: settlement.externalRequestState,
    resultRef: settlement.resultRef,
    resultEnvelope: settlement.resultEnvelope,
    applicationDisposition: settlement.applicationDisposition,
    failureClass: settlement.failureClass,
    externalRequestRef: settlement.externalRequestRef,
    serverTime,
    domainSettlementValidated
  });
  jobs[index] = structuredClone(next);
  return next;
}

export function settleSoftwareJobInDocument(document, settlement, serverTime) {
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime);
}

export function settleC1PaidKeywordEvidenceSoftwareJobInDocument(document, settlement, serverTime) {
  const job = findSoftwareJobInDocument(document, settlement.jobId);
  if (!job) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  if (job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      job.scopeBinding?.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_CONTEXT_INVALID");
  }
  if (settlement.status !== "completed" || settlement.resultEnvelope?.payloadKind !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_COMPLETED_REQUIRED");
  }
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime, { domainSettlementValidated: true });
}

function c2StableAssetTransportContextForSettlement(document, job) {
  if (!Array.isArray(document.candidates)) throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_CANDIDATE_REQUIRED");
  const candidate = document.candidates.find((entry) => entry.id === job.candidateId);
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  const jobRef = skuPackage?.c2FinalAssets?.stableAssetTransport?.jobRef;
  if (!candidate || !skuPackage || !jobRef ||
      jobRef.jobId !== job.jobId || jobRef.jobType !== job.jobType ||
      jobRef.candidateId !== job.candidateId || jobRef.skuPackageId !== job.skuPackageId ||
      jobRef.sourceRevision !== job.scopeBinding?.sourceRevision ||
      jobRef.resultRevision !== job.revision ||
      jobRef.inputFingerprint !== job.scopeBinding?.inputFingerprint) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_CONTEXT_INVALID");
  }
  return { skuPackage, jobRef };
}

export function settleC2StableAssetTransportSoftwareJobInDocument(document, settlement, serverTime) {
  const jobs = softwareJobsInDocument(document);
  const job = jobs.find((entry) => entry.jobId === settlement.jobId);
  if (!job) throw new Error("SOFTWARE_JOB_NOT_FOUND");
  if (!softwareJobRequiresDomainSettlement(job)) {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_NOT_REQUIRED");
  }
  if (settlement.status !== "completed") {
    throw new Error("SOFTWARE_JOB_DOMAIN_SETTLEMENT_COMPLETED_REQUIRED");
  }
  assertBoundedResultEnvelopeStructure(settlement.resultEnvelope, "softwareJob.domainSettlement.resultEnvelope");
  const { skuPackage, jobRef } = c2StableAssetTransportContextForSettlement(document, job);
  validateC2StableAssetTransportResult({
    skuPackage,
    jobRef,
    transportResultEnvelope: {
      ...structuredClone(settlement.resultEnvelope),
      applicationDisposition: "applied"
    },
    allowedStableAssetHosts: job.scopeBinding.allowedStableAssetHosts,
    settledAt: serverTime
  });
  return settleSoftwareJobInDocumentCore(document, settlement, serverTime, {
    domainSettlementValidated: true
  });
}
