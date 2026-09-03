import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { legacyKeywordJobBlocksPaidExecution } from "./keyword-evidence-software-job-state.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE,
  assertSoftwareJobStrictRef,
  sameSoftwareJobIdentity,
  bindSoftwareJobAdmissionDecision,
  isReservedSoftwareJobHost,
  softwareJobsInDocument
} from "./software-job-contract.mjs";

export const SOFTWARE_JOB_ADMISSION_DECISION_VERSION = "software-job-admission-v1";
export const SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION = "software-job-authorization-record-v1";
export const SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION = "software-job-credential-binding-v1";
export { SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE };

const OCCUPYING_STATUSES = new Set(["queued", "claimed", "waiting_platform", "unknown_outcome"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label) {
  return assertSoftwareJobStrictRef(value, label);
}

function iso(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  return new Date(normalized).toISOString();
}

function sha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  return normalized;
}

function boundedVariantKey(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return normalized;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeHosts(hosts, label) {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 16) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  const normalized = [...new Set(hosts.map((host) => String(host).trim().toLowerCase()))].sort();
  if (normalized.length !== hosts.length || normalized.some((host) =>
    host.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) ||
    isReservedSoftwareJobHost(host))) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return Object.freeze(normalized);
}

function assertUniqueNormalizedRecords(records, keys, code) {
  for (const key of keys) {
    const seen = new Set();
    for (const record of records) {
      const value = record[key];
      if (value === null || value === undefined) continue;
      if (seen.has(value)) throw new Error(code);
      seen.add(value);
    }
  }
}

function normalizeStoreRef(value, label) {
  if (!isObject(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["mappingVersion", "platformStoreId", "stableStoreId"])) {
    throw new Error(`SOFTWARE_JOB_ADMISSION_INVALID:${label}`);
  }
  return Object.freeze({
    stableStoreId: text(value.stableStoreId, `${label}.stableStoreId`),
    platformStoreId: text(value.platformStoreId, `${label}.platformStoreId`),
    mappingVersion: text(value.mappingVersion, `${label}.mappingVersion`)
  });
}

function runtimeCollection(document, key) {
  const value = document?.runtime?.[key];
  return Array.isArray(value) ? value : [];
}

export function softwareJobAuthorizationRecordsInDocument(document) {
  return runtimeCollection(document, "softwareJobAuthorizationRecords");
}

export function softwareJobCredentialBindingsInDocument(document) {
  return runtimeCollection(document, "softwareJobCredentialBindings");
}

function normalizeC2AuthorizationRecord(record) {
  const allowedKeys = [
    "schemaVersion", "authorizationId", "status", "action", "candidateId", "skuPackageId", "sourceRevision",
    "resultRevision", "platform", "storeRef", "supplierSkuId", "variantKey", "sideEffectScope",
    "stagedAssetManifestFingerprint", "ownerStagingConfirmationRef", "allowedStableAssetHosts",
    "authorizedByUserId", "authorizedAt", "expiresAt", "maxUses", "useCount", "consumedByJobId", "consumedAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION ||
      record.status !== "active" || record.action !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      record.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      record.maxUses !== 1 || ![0, 1].includes(record.useCount)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const consumedByJobId = record.consumedByJobId === null ? null : text(record.consumedByJobId, "authorization.consumedByJobId");
  const consumedAt = record.consumedAt === null ? null : iso(record.consumedAt, "authorization.consumedAt");
  if ((record.useCount === 0 && (consumedByJobId !== null || consumedAt !== null)) ||
      (record.useCount === 1 && (consumedByJobId === null || consumedAt === null))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION,
    authorizationId: text(record.authorizationId, "authorization.authorizationId"),
    status: "active",
    action: record.action,
    candidateId: text(record.candidateId, "authorization.candidateId"),
    skuPackageId: text(record.skuPackageId, "authorization.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    platform: text(record.platform, "authorization.platform"),
    storeRef: normalizeStoreRef(record.storeRef, "authorization.storeRef"),
    supplierSkuId: text(record.supplierSkuId, "authorization.supplierSkuId"),
    variantKey: boundedVariantKey(record.variantKey, "authorization.variantKey"),
    sideEffectScope: record.sideEffectScope,
    stagedAssetManifestFingerprint: sha256(record.stagedAssetManifestFingerprint, "authorization.stagedAssetManifestFingerprint"),
    ownerStagingConfirmationRef: text(record.ownerStagingConfirmationRef, "authorization.ownerStagingConfirmationRef"),
    allowedStableAssetHosts: normalizeHosts(record.allowedStableAssetHosts, "authorization.allowedStableAssetHosts"),
    authorizedByUserId: text(record.authorizedByUserId, "authorization.authorizedByUserId"),
    authorizedAt: iso(record.authorizedAt, "authorization.authorizedAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "authorization.expiresAt"),
    maxUses: 1,
    useCount: record.useCount,
    consumedByJobId,
    consumedAt
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.authorizationRecord");
  return normalized;
}

function normalizeC1AuthorizationRecord(record) {
  const allowedKeys = [
    "schemaVersion", "authorizationId", "status", "action", "authorizationSubject", "candidateId", "skuPackageId",
    "sourceRevision", "resultRevision", "platform", "targetStore", "supplierSkuId", "variantKey", "sideEffectScope",
    "provider", "credentialAlias", "inputFingerprint", "planningEvidenceFingerprint", "runtimeInputFingerprint",
    "seerfarRequestFingerprint", "salesSnapshotFingerprint", "supplySnapshotFingerprint", "profitModelFingerprint",
    "c1FactsFingerprint", "pointBudgetEvidenceRef", "quotaEvidenceRef", "pointsAuthorized", "authorizedByUserId",
    "authorizedAt", "expiresAt", "maxUses", "useCount", "consumedByJobId", "consumedAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION ||
      record.status !== "active" || record.action !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      record.provider !== C1_PAID_KEYWORD_PROVIDER ||
      record.authorizationSubject !== "c1_paid_keyword_evidence:seerfar_open_api_once" ||
      record.pointsAuthorized !== C1_PAID_KEYWORD_POINTS ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      record.maxUses !== 1 || ![0, 1].includes(record.useCount)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const consumedByJobId = record.consumedByJobId === null ? null : text(record.consumedByJobId, "authorization.consumedByJobId");
  const consumedAt = record.consumedAt === null ? null : iso(record.consumedAt, "authorization.consumedAt");
  if ((record.useCount === 0 && (consumedByJobId !== null || consumedAt !== null)) ||
      (record.useCount === 1 && (consumedByJobId === null || consumedAt === null))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_INVALID");
  }
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_AUTHORIZATION_RECORD_VERSION,
    authorizationId: text(record.authorizationId, "authorization.authorizationId"),
    status: "active",
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
    candidateId: text(record.candidateId, "authorization.candidateId"),
    skuPackageId: text(record.skuPackageId, "authorization.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    platform: text(record.platform, "authorization.platform"),
    targetStore: text(record.targetStore, "authorization.targetStore"),
    supplierSkuId: text(record.supplierSkuId, "authorization.supplierSkuId"),
    variantKey: boundedVariantKey(record.variantKey, "authorization.variantKey"),
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    provider: C1_PAID_KEYWORD_PROVIDER,
    credentialAlias: text(record.credentialAlias, "authorization.credentialAlias"),
    inputFingerprint: sha256(record.inputFingerprint, "authorization.inputFingerprint"),
    planningEvidenceFingerprint: sha256(record.planningEvidenceFingerprint, "authorization.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(record.runtimeInputFingerprint, "authorization.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(record.seerfarRequestFingerprint, "authorization.seerfarRequestFingerprint"),
    salesSnapshotFingerprint: sha256(record.salesSnapshotFingerprint, "authorization.salesSnapshotFingerprint"),
    supplySnapshotFingerprint: sha256(record.supplySnapshotFingerprint, "authorization.supplySnapshotFingerprint"),
    profitModelFingerprint: sha256(record.profitModelFingerprint, "authorization.profitModelFingerprint"),
    c1FactsFingerprint: sha256(record.c1FactsFingerprint, "authorization.c1FactsFingerprint"),
    pointBudgetEvidenceRef: text(record.pointBudgetEvidenceRef, "authorization.pointBudgetEvidenceRef"),
    quotaEvidenceRef: text(record.quotaEvidenceRef, "authorization.quotaEvidenceRef"),
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    authorizedByUserId: text(record.authorizedByUserId, "authorization.authorizedByUserId"),
    authorizedAt: iso(record.authorizedAt, "authorization.authorizedAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "authorization.expiresAt"),
    maxUses: 1,
    useCount: record.useCount,
    consumedByJobId,
    consumedAt
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.authorizationRecord");
  return normalized;
}

function normalizeAuthorizationRecord(record) {
  if (record?.action === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || record?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    return normalizeC1AuthorizationRecord(record);
  }
  return normalizeC2AuthorizationRecord(record);
}

function normalizeC2CredentialBinding(record) {
  const allowedKeys = [
    "schemaVersion", "bindingId", "credentialAlias", "status", "provider", "platform", "storeRef",
    "sideEffectScope", "allowedStableAssetHosts", "allowedWorkerIds", "redaction", "boundAt", "expiresAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION ||
      record.status !== "active" || record.redaction !== "credential_alias_only" ||
      record.sideEffectScope !== C2_STABLE_ASSET_TRANSPORT_JOB_TYPE ||
      !Array.isArray(record.allowedWorkerIds) || record.allowedWorkerIds.length === 0 || record.allowedWorkerIds.length > 32) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  }
  const workerIds = [...new Set(record.allowedWorkerIds.map((workerId) => text(workerId, "credential.allowedWorkerIds")))].sort();
  if (workerIds.length !== record.allowedWorkerIds.length) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION,
    bindingId: text(record.bindingId, "credential.bindingId"),
    credentialAlias: text(record.credentialAlias, "credential.credentialAlias"),
    status: "active",
    provider: text(record.provider, "credential.provider"),
    platform: text(record.platform, "credential.platform"),
    storeRef: normalizeStoreRef(record.storeRef, "credential.storeRef"),
    sideEffectScope: record.sideEffectScope,
    allowedStableAssetHosts: normalizeHosts(record.allowedStableAssetHosts, "credential.allowedStableAssetHosts"),
    allowedWorkerIds: Object.freeze(workerIds),
    redaction: "credential_alias_only",
    boundAt: iso(record.boundAt, "credential.boundAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "credential.expiresAt")
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.credentialBinding");
  return normalized;
}

function normalizeC1CredentialBinding(record) {
  const allowedKeys = [
    "schemaVersion", "bindingId", "credentialAlias", "status", "provider", "platform", "targetStore",
    "sideEffectScope", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint",
    "planningEvidenceFingerprint", "runtimeInputFingerprint", "seerfarRequestFingerprint", "allowedWorkerIds",
    "redaction", "boundAt", "expiresAt"
  ];
  if (!isObject(record) || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      record.schemaVersion !== SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION ||
      record.status !== "active" || record.redaction !== "credential_alias_only" ||
      record.provider !== C1_PAID_KEYWORD_PROVIDER ||
      record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      !Number.isInteger(record.sourceRevision) || record.sourceRevision < 0 ||
      record.resultRevision !== record.sourceRevision + 1 ||
      !Array.isArray(record.allowedWorkerIds) || record.allowedWorkerIds.length === 0 || record.allowedWorkerIds.length > 32) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  }
  const workerIds = [...new Set(record.allowedWorkerIds.map((workerId) => text(workerId, "credential.allowedWorkerIds")))].sort();
  if (workerIds.length !== record.allowedWorkerIds.length) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID");
  const normalized = Object.freeze({
    schemaVersion: SOFTWARE_JOB_CREDENTIAL_BINDING_VERSION,
    bindingId: text(record.bindingId, "credential.bindingId"),
    credentialAlias: text(record.credentialAlias, "credential.credentialAlias"),
    status: "active",
    provider: C1_PAID_KEYWORD_PROVIDER,
    platform: text(record.platform, "credential.platform"),
    targetStore: text(record.targetStore, "credential.targetStore"),
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: text(record.candidateId, "credential.candidateId"),
    skuPackageId: text(record.skuPackageId, "credential.skuPackageId"),
    sourceRevision: record.sourceRevision,
    resultRevision: record.resultRevision,
    inputFingerprint: sha256(record.inputFingerprint, "credential.inputFingerprint"),
    planningEvidenceFingerprint: sha256(record.planningEvidenceFingerprint, "credential.planningEvidenceFingerprint"),
    runtimeInputFingerprint: sha256(record.runtimeInputFingerprint, "credential.runtimeInputFingerprint"),
    seerfarRequestFingerprint: sha256(record.seerfarRequestFingerprint, "credential.seerfarRequestFingerprint"),
    allowedWorkerIds: Object.freeze(workerIds),
    redaction: "credential_alias_only",
    boundAt: iso(record.boundAt, "credential.boundAt"),
    expiresAt: record.expiresAt === null ? null : iso(record.expiresAt, "credential.expiresAt")
  });
  assertSafeRuntimeRecord(normalized, "softwareJob.credentialBinding");
  return normalized;
}

function normalizeCredentialBinding(record) {
  if (record?.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || record?.provider === C1_PAID_KEYWORD_PROVIDER) {
    return normalizeC1CredentialBinding(record);
  }
  return normalizeC2CredentialBinding(record);
}

function assertScope(value) {
  if (!isObject(value) || value.schemaVersion !== "software-job-scope-v1") {
    throw new Error("SOFTWARE_JOB_ADMISSION_SCOPE_REQUIRED");
  }
  return value;
}

function candidateForJob(document, job) {
  if (!Array.isArray(document?.candidates)) throw new Error("SOFTWARE_JOB_ADMISSION_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === job.candidateId);
  if (!candidate) throw new Error("SOFTWARE_JOB_ADMISSION_CANDIDATE_NOT_FOUND");
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && legacyKeywordJobBlocksPaidExecution(candidate)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_LEGACY_OUTCOME_UNRESOLVED");
  }
  return candidate;
}

export function normalizeSoftwareJobScopeKey(job) {
  const scope = assertScope(job?.scopeBinding);
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE || scope.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    const identity = {
      schemaVersion: "software-job-normalized-scope-v1",
      jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      candidateId: text(scope.candidateId, "scope.candidateId"),
      skuPackageId: text(scope.skuPackageId, "scope.skuPackageId"),
      platform: text(scope.platform, "scope.platform"),
      targetStore: text(scope.targetStore, "scope.targetStore"),
      supplierSkuId: text(scope.supplierSkuId, "scope.supplierSkuId"),
      variantKey: boundedVariantKey(scope.variantKey, "scope.variantKey"),
      sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      provider: C1_PAID_KEYWORD_PROVIDER
    };
    return `software-job-scope:${fingerprintCanonicalRecord(identity)}`;
  }
  const identity = {
    schemaVersion: "software-job-normalized-scope-v1",
    jobType: text(job.jobType, "job.jobType"),
    candidateId: text(scope.candidateId, "scope.candidateId"),
    skuPackageId: text(scope.skuPackageId, "scope.skuPackageId"),
    platform: text(scope.platform, "scope.platform"),
    stableStoreId: text(scope.storeRef?.stableStoreId, "scope.storeRef.stableStoreId"),
    supplierSkuId: text(scope.supplierSkuId, "scope.supplierSkuId"),
    variantKey: boundedVariantKey(scope.variantKey, "scope.variantKey"),
    sideEffectScope: text(scope.sideEffectScope, "scope.sideEffectScope")
  };
  return `software-job-scope:${fingerprintCanonicalRecord(identity)}`;
}

function scopeOccupies(job) {
  return OCCUPYING_STATUSES.has(job.status) ||
    job.externalRequestState === "in_flight" ||
    (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && job.status === "failed" && job.externalRequestState === "succeeded") ||
    (job.status === "completed" && job.resultEnvelope?.applicationDisposition === "revision_conflict_not_applied");
}

export function assertNoSoftwareJobScopeConflict(document, job) {
  if (!job?.scopeBinding) return;
  const targetScope = normalizeSoftwareJobScopeKey(job);
  for (const existing of softwareJobsInDocument(document)) {
    if (sameSoftwareJobIdentity(existing, job)) continue;
    if (!existing?.scopeBinding) continue;
    if (normalizeSoftwareJobScopeKey(existing) === targetScope && scopeOccupies(existing)) {
      throw new Error("SOFTWARE_JOB_SCOPE_CONFLICT");
    }
  }
}

function assertRecordCurrent(record, observedAt, code) {
  if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.parse(observedAt)) throw new Error(code);
}

function assertRecordNotFuture(record, observedAt, field, code) {
  if (Date.parse(record[field]) > Date.parse(observedAt)) throw new Error(code);
}

function assertRecordTimeOrder(leftValue, rightValue, code) {
  if (Date.parse(leftValue) > Date.parse(rightValue)) throw new Error(code);
}

function authorizationFingerprintSnapshot(record) {
  const { maxUses: _maxUses, useCount: _useCount, consumedByJobId: _consumedByJobId, consumedAt: _consumedAt, ...snapshot } = record;
  return snapshot;
}

function assertAuthorizationMatchesJob(record, job, observedAt) {
  const scope = assertScope(job.scopeBinding);
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    if (record.authorizationId !== scope.authorizationRef || record.action !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.authorizationSubject !== "c1_paid_keyword_evidence:seerfar_open_api_once" ||
        record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
        record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
        record.resultRevision !== job.revision || record.platform !== scope.platform ||
        record.targetStore !== scope.targetStore || record.supplierSkuId !== scope.supplierSkuId ||
        record.variantKey !== scope.variantKey || record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.provider !== C1_PAID_KEYWORD_PROVIDER || record.credentialAlias !== scope.credentialAlias ||
        record.inputFingerprint !== scope.inputFingerprint ||
        record.planningEvidenceFingerprint !== scope.planningEvidenceFingerprint ||
        record.runtimeInputFingerprint !== scope.runtimeInputFingerprint ||
        record.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint ||
        record.salesSnapshotFingerprint !== scope.salesSnapshotFingerprint ||
        record.supplySnapshotFingerprint !== scope.supplySnapshotFingerprint ||
        record.profitModelFingerprint !== scope.profitModelFingerprint ||
        record.c1FactsFingerprint !== scope.c1FactsFingerprint ||
        record.pointBudgetEvidenceRef !== scope.pointBudgetEvidenceRef ||
        record.quotaEvidenceRef !== scope.quotaEvidenceRef ||
        record.pointsAuthorized !== C1_PAID_KEYWORD_POINTS) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH");
    }
    if (record.authorizedByUserId !== job.ownerUserId || record.authorizedByUserId !== job.requestedByUserId) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
    }
    assertRecordNotFuture(record, observedAt, "authorizedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE");
    if (record.consumedAt !== null) {
      assertRecordTimeOrder(record.authorizedAt, record.consumedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION");
      assertRecordNotFuture(record, observedAt, "consumedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE");
    }
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED");
    return;
  }
  if (record.authorizationId !== scope.authorizationRef || record.action !== job.jobType ||
      record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
      record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
      record.resultRevision !== job.revision || record.platform !== scope.platform ||
      record.supplierSkuId !== scope.supplierSkuId || record.variantKey !== scope.variantKey ||
      record.sideEffectScope !== scope.sideEffectScope ||
      record.stagedAssetManifestFingerprint !== scope.stagedAssetManifestFingerprint ||
      record.ownerStagingConfirmationRef !== scope.ownerStagingConfirmationRef ||
      !sameJson(record.storeRef, scope.storeRef) ||
      !sameJson(record.allowedStableAssetHosts, scope.allowedStableAssetHosts)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH");
  }
  if (record.authorizedByUserId !== job.ownerUserId || record.authorizedByUserId !== job.requestedByUserId) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
  }
  assertRecordNotFuture(record, observedAt, "authorizedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE");
  if (record.consumedAt !== null) {
    assertRecordTimeOrder(record.authorizedAt, record.consumedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION");
    assertRecordNotFuture(record, observedAt, "consumedAt", "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE");
  }
  assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED");
}

function assertCredentialMatchesJob(record, job, observedAt, workerId = null) {
  const scope = assertScope(job.scopeBinding);
  if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    if (record.credentialAlias !== scope.credentialAlias || record.platform !== scope.platform ||
        record.targetStore !== scope.targetStore || record.provider !== C1_PAID_KEYWORD_PROVIDER ||
        record.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
        record.candidateId !== job.candidateId || record.skuPackageId !== job.skuPackageId ||
        record.sourceRevision !== scope.sourceRevision || record.resultRevision !== scope.resultRevision ||
        record.inputFingerprint !== scope.inputFingerprint ||
        record.planningEvidenceFingerprint !== scope.planningEvidenceFingerprint ||
        record.runtimeInputFingerprint !== scope.runtimeInputFingerprint ||
        record.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint) {
      throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
    }
    if (workerId !== null && !record.allowedWorkerIds.includes(workerId)) {
      throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND");
    }
    assertRecordNotFuture(record, observedAt, "boundAt", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE");
    assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED");
    return;
  }
  if (record.credentialAlias !== scope.credentialAlias || record.platform !== scope.platform ||
      record.sideEffectScope !== scope.sideEffectScope ||
      !sameJson(record.storeRef, scope.storeRef) ||
      !sameJson(record.allowedStableAssetHosts, scope.allowedStableAssetHosts)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
  }
  if (workerId !== null && !record.allowedWorkerIds.includes(workerId)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND");
  }
  assertRecordNotFuture(record, observedAt, "boundAt", "SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE");
  assertRecordCurrent(record, observedAt, "SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED");
}

function assertAuthorizationUseForPhase(record, job, phase) {
  if (phase === "enqueue_before_candidate_commit" || phase === "enqueue_current") {
    if (record.useCount !== 0 || record.consumedByJobId !== null || record.consumedAt !== null) {
      throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED");
    }
    return;
  }
  if (["claim", "external_request"].includes(phase) &&
      (record.useCount !== 1 || record.consumedByJobId !== job.jobId || record.consumedAt === null)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_CONSUMED_BY_JOB");
  }
}

function findValidatedAuthorization(document, job, observedAt) {
  const scope = assertScope(job.scopeBinding);
  const records = softwareJobAuthorizationRecordsInDocument(document)
    .filter((entry) => entry?.authorizationId === scope.authorizationRef)
    .map(normalizeAuthorizationRecord);
  assertUniqueNormalizedRecords(records, ["authorizationId"], "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_DUPLICATE");
  const record = records
    .find((entry) => entry?.authorizationId === scope.authorizationRef);
  if (!record) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  assertAuthorizationMatchesJob(record, job, observedAt);
  return record;
}

function findValidatedCredential(document, job, observedAt, workerId = null) {
  const scope = assertScope(job.scopeBinding);
  const namespaceCollisions = softwareJobCredentialBindingsInDocument(document)
    .filter((entry) => entry?.bindingId === scope.credentialAlias);
  if (namespaceCollisions.length > 0) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_NAMESPACE_COLLISION");
  }
  const aliasRecords = softwareJobCredentialBindingsInDocument(document)
    .filter((entry) => entry?.credentialAlias === scope.credentialAlias)
    .map(normalizeCredentialBinding);
  assertUniqueNormalizedRecords(aliasRecords, ["bindingId"], "SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  const records = job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE
    ? aliasRecords.filter((record) => record.sideEffectScope === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE &&
      record.candidateId === job.candidateId && record.skuPackageId === job.skuPackageId &&
      record.sourceRevision === scope.sourceRevision && record.resultRevision === scope.resultRevision &&
      record.inputFingerprint === scope.inputFingerprint)
    : aliasRecords;
  if (records.length === 0) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED");
  if (records.length !== 1) throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  assertUniqueNormalizedRecords(records, ["bindingId", "credentialAlias"], "SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE");
  const [record] = records;
  if (job.admissionDecision && record.bindingId !== job.admissionDecision.credentialBindingRef) {
    throw new Error("SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH");
  }
  assertCredentialMatchesJob(record, job, observedAt, workerId);
  return record;
}

function decisionStableProjection(decision) {
  return {
    schemaVersion: decision?.schemaVersion,
    admissionId: decision?.admissionId,
    jobId: decision?.jobId,
    candidateId: decision?.candidateId,
    skuPackageId: decision?.skuPackageId,
    revision: decision?.revision,
    jobType: decision?.jobType,
    normalizedScopeKey: decision?.normalizedScopeKey,
    authorizationRef: decision?.authorizationRef,
    authorizationFingerprint: decision?.authorizationFingerprint,
    credentialBindingRef: decision?.credentialBindingRef,
    credentialAlias: decision?.credentialAlias,
    credentialBindingFingerprint: decision?.credentialBindingFingerprint
  };
}

function assertStoredDecisionMatches(job, decision) {
  if (!["claim", "external_request"].includes(decision.phase)) return;
  if (!job.admissionDecision || !sameJson(decisionStableProjection(job.admissionDecision), decisionStableProjection(decision))) {
    throw new Error("SOFTWARE_JOB_ADMISSION_DECISION_MISMATCH");
  }
}

export function validateSoftwareJobAdmission({ document, job, observedAt, phase, worker = null, workerId = null }) {
  if (!job?.scopeBinding) return null;
  const observed = iso(observedAt, "observedAt");
  const candidate = candidateForJob(document, job);
  const expectedRevision = phase === "enqueue_before_candidate_commit" ? job.scopeBinding.sourceRevision : job.revision;
  if (Number(candidate.dataRevision) !== expectedRevision) throw new Error("SOFTWARE_JOB_ADMISSION_REVISION_CONFLICT");
  if (worker !== null) {
    if (!workerSatisfiesCapabilities(worker, job.requiredCapabilities)) throw new Error("SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED");
    workerId = worker.workerId;
  }
  const authorization = findValidatedAuthorization(document, job, observed);
  const credential = findValidatedCredential(document, job, observed, workerId);
  assertAuthorizationUseForPhase(authorization, job, phase);
  const authorizationFingerprint = fingerprintCanonicalRecord(authorizationFingerprintSnapshot(authorization));
  const credentialBindingFingerprint = fingerprintCanonicalRecord(credential);
  const decision = {
    schemaVersion: SOFTWARE_JOB_ADMISSION_DECISION_VERSION,
    admissionId: `software-job-admission:${fingerprintCanonicalRecord({
      jobId: job.jobId,
      scopeKey: normalizeSoftwareJobScopeKey(job),
      authorizationFingerprint,
      credentialBindingFingerprint
    })}`,
    jobId: job.jobId,
    candidateId: job.candidateId,
    skuPackageId: job.skuPackageId,
    revision: job.revision,
    jobType: job.jobType,
    normalizedScopeKey: normalizeSoftwareJobScopeKey(job),
    authorizationRef: authorization.authorizationId,
    authorizationFingerprint,
    credentialBindingRef: credential.bindingId,
    credentialAlias: credential.credentialAlias,
    credentialBindingFingerprint,
    phase,
    observedAt: observed
  };
  assertSafeRuntimeRecord(decision, "softwareJob.admissionDecision");
  assertStoredDecisionMatches(job, decision);
  return Object.freeze(decision);
}

export function assertSoftwareJobAdmittedForEnqueue({ document, job, observedAt, phase = "enqueue_current" }) {
  assertNoSoftwareJobScopeConflict(document, job);
  return validateSoftwareJobAdmission({ document, job, observedAt, phase });
}

export function consumeSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase = "enqueue_before_candidate_commit" }) {
  if (!document?.runtime || !Array.isArray(document.runtime.softwareJobAuthorizationRecords)) {
    throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  }
  assertNoSoftwareJobScopeConflict(document, job);
  const decision = validateSoftwareJobAdmission({ document, job, observedAt, phase });
  const index = document.runtime.softwareJobAuthorizationRecords.findIndex((record) =>
    record?.authorizationId === job.scopeBinding.authorizationRef
  );
  if (index < 0) throw new Error("SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED");
  document.runtime.softwareJobAuthorizationRecords[index] = {
    ...structuredClone(document.runtime.softwareJobAuthorizationRecords[index]),
    useCount: 1,
    consumedByJobId: job.jobId,
    consumedAt: decision.observedAt
  };
  const consumed = findValidatedAuthorization(document, job, decision.observedAt);
  assertAuthorizationUseForPhase(consumed, job, "claim");
  return decision;
}

export function bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase = "enqueue_before_candidate_commit" }) {
  const decision = consumeSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase });
  return bindSoftwareJobAdmissionDecision(job, decision);
}

export function assertSoftwareJobAdmittedForClaim({ document, job, worker, observedAt }) {
  return validateSoftwareJobAdmission({ document, job, worker, observedAt, phase: "claim" });
}

export function assertSoftwareJobAdmittedForExternalRequest({ document, job, workerId, observedAt }) {
  return validateSoftwareJobAdmission({ document, job, workerId, observedAt, phase: "external_request" });
}
