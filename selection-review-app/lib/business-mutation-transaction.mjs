import {
  assertBusinessStateRepositoryBoundary,
  assertCentralPersistenceBoundary
} from "./business-state-repository.mjs";
import {
  assertSafeRuntimeRecord,
  authorizeOperation,
  createOperationAuditEvent
} from "./runtime-identity.mjs";
import { settleC2StableAssetTransport } from "./c2-asset-lifecycle.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { buildC1FactKeywordAtomicPatch, assertC1PaidKeywordPreparedResult } from "./c1-fact-keyword-persistence.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  bindSoftwareJobAdmissionDecision,
  createSoftwareJobEnvelope,
  enqueueSoftwareJobInDocument,
  findSoftwareJobInDocument,
  settleC1PaidKeywordEvidenceSoftwareJobInDocument,
  settleC2StableAssetTransportSoftwareJobInDocument,
  settleSoftwareJobInDocument
} from "./software-job-contract.mjs";
import { consumeSoftwareJobAdmissionForEnqueue } from "./software-job-admission.mjs";

const CENTRAL_MODES = new Set(["central_test", "central_production"]);
const SOFTWARE_JOB_INPUT_KEYS = Object.freeze([
  "candidateId",
  "idempotencyKey",
  "jobId",
  "jobType",
  "ownerUserId",
  "requestedByUserId",
  "requiredCapabilities",
  "revision",
  "scopeBinding",
  "skuPackageId"
].sort());
const SOFTWARE_JOB_EFFECT_KEYS = Object.freeze([
  "jobInput",
  "kind",
  "operation",
  "schemaVersion"
].sort());
const SOFTWARE_JOB_EFFECT_KEYS_WITH_ADMISSION = Object.freeze([
  "admissionRecords",
  ...SOFTWARE_JOB_EFFECT_KEYS
].sort());
const SOFTWARE_JOB_ADMISSION_EFFECT_KEYS = Object.freeze([
  "authorizationRecord",
  "credentialBinding",
  "schemaVersion"
].sort());

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`BUSINESS_MUTATION_INPUT_INVALID:${label}`);
  return normalized;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("BUSINESS_MUTATION_INPUT_INVALID:expectedRevision");
  return value;
}

function isoServerTime(value, label) {
  const normalized = String(value ?? "").trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || Number.isNaN(timestamp)) throw new Error(`BUSINESS_MUTATION_CLOCK_INVALID:${label}`);
  return new Date(timestamp).toISOString();
}

function observedServerTime({ serverClock, serverTime, authoritativeRequired }) {
  if (authoritativeRequired) {
    if (typeof serverClock !== "function") throw new Error("BUSINESS_MUTATION_SERVER_CLOCK_REQUIRED");
    return isoServerTime(serverClock(), "serverClock");
  }
  return isoServerTime(serverTime, "serverTime");
}

function runtimeCollections(document) {
  if (!document.runtime || typeof document.runtime !== "object" || Array.isArray(document.runtime)) document.runtime = {};
  if (!Array.isArray(document.runtime.operationAudit)) document.runtime.operationAudit = [];
  if (!Array.isArray(document.runtime.idempotencyRecords)) document.runtime.idempotencyRecords = [];
  return document.runtime;
}

function candidateState(candidate) {
  return String(candidate.workflowStatus || candidate.lifecycleV11?.skuPackage?.businessPhase || "unknown");
}

function assertDeclarativeSoftwareJobEffect(effect, operation) {
  if (effect === null || effect === undefined) return null;
  const keys = Object.keys(effect || {}).sort();
  if (!effect || typeof effect !== "object" || Array.isArray(effect) ||
      ![
        JSON.stringify(SOFTWARE_JOB_EFFECT_KEYS),
        JSON.stringify(SOFTWARE_JOB_EFFECT_KEYS_WITH_ADMISSION)
      ].includes(JSON.stringify(keys)) ||
      effect.schemaVersion !== "business-mutation-effect-v1" || effect.kind !== "software_job" ||
      effect.operation !== operation || !effect.jobInput || typeof effect.jobInput !== "object" || Array.isArray(effect.jobInput) ||
      JSON.stringify(Object.keys(effect.jobInput).sort()) !== JSON.stringify(SOFTWARE_JOB_INPUT_KEYS)) {
    throw new Error("BUSINESS_MUTATION_EFFECT_INVALID");
  }
  assertPureData(effect.jobInput, "softwareJobEffect.jobInput");
  const admissionRecords = Object.hasOwn(effect, "admissionRecords")
    ? assertDeclarativeSoftwareJobAdmissionEffect(effect.admissionRecords)
    : null;
  return { ...structuredClone(effect), admissionRecords };
}

function assertDeclarativeSoftwareJobAdmissionEffect(records) {
  if (!records || typeof records !== "object" || Array.isArray(records) ||
      JSON.stringify(Object.keys(records).sort()) !== JSON.stringify(SOFTWARE_JOB_ADMISSION_EFFECT_KEYS) ||
      records.schemaVersion !== "business-mutation-software-job-admission-effect-v1" ||
      !records.authorizationRecord || typeof records.authorizationRecord !== "object" || Array.isArray(records.authorizationRecord) ||
      !records.credentialBinding || typeof records.credentialBinding !== "object" || Array.isArray(records.credentialBinding)) {
    throw new Error("BUSINESS_MUTATION_EFFECT_INVALID");
  }
  assertPureData(records.authorizationRecord, "softwareJobEffect.admissionRecords.authorizationRecord");
  assertPureData(records.credentialBinding, "softwareJobEffect.admissionRecords.credentialBinding");
  return structuredClone(records);
}

function assertPureData(value, path, seen = new WeakSet()) {
  if (value === null) return;
  const type = typeof value;
  if (["string", "number", "boolean"].includes(type)) return;
  if (["function", "symbol", "bigint", "undefined"].includes(type)) {
    throw new Error(`BUSINESS_MUTATION_EFFECT_INVALID:${path}`);
  }
  if (type !== "object" || seen.has(value)) throw new Error(`BUSINESS_MUTATION_EFFECT_INVALID:${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureData(entry, `${path}[${index}]`, seen));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`BUSINESS_MUTATION_EFFECT_INVALID:${path}`);
  }
  Object.entries(value).forEach(([key, entry]) => assertPureData(entry, `${path}.${key}`, seen));
}

function assertDeclarativeSoftwareJobSettlementEffect(effect) {
  const allowed = [
    "externalRequestRef", "externalRequestState", "failureClass", "jobId", "leaseId", "resultEnvelope", "resultRef", "status", "workerId"
  ];
  if (!effect || typeof effect !== "object" || Array.isArray(effect) ||
      Object.keys(effect).some((key) => !allowed.includes(key)) ||
      ["jobId", "workerId", "leaseId", "status", "externalRequestState"].some((key) => !(key in effect))) {
    throw new Error("BUSINESS_MUTATION_EFFECT_INVALID");
  }
  return effect;
}

function appendSoftwareJobAdmissionRecords(document, records, observedAt) {
  if (!records) return;
  const runtime = runtimeCollections(document);
  if (!Array.isArray(runtime.softwareJobAuthorizationRecords)) runtime.softwareJobAuthorizationRecords = [];
  if (!Array.isArray(runtime.softwareJobCredentialBindings)) runtime.softwareJobCredentialBindings = [];
  const authorizationRecord = {
    ...structuredClone(records.authorizationRecord),
    authorizedAt: observedAt,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
  const credentialBinding = {
    ...structuredClone(records.credentialBinding),
    boundAt: observedAt
  };
  if (runtime.softwareJobAuthorizationRecords.some((entry) => entry?.authorizationId === authorizationRecord.authorizationId) ||
      runtime.softwareJobCredentialBindings.some((entry) => entry?.bindingId === credentialBinding.bindingId)) {
    throw new Error("BUSINESS_MUTATION_SOFTWARE_JOB_ADMISSION_CONFLICT");
  }
  assertSafeRuntimeRecord(authorizationRecord, "softwareJobEffect.authorizationRecord");
  assertSafeRuntimeRecord(credentialBinding, "softwareJobEffect.credentialBinding");
  runtime.softwareJobAuthorizationRecords.push(authorizationRecord);
  runtime.softwareJobCredentialBindings.push(credentialBinding);
}

export function assertReplaySoftwareJob(document, storedResult) {
  const expected = storedResult?.softwareJobRef;
  if (!expected) return;
  if (document.runtime?.softwareJobs?.filter((job) => job.jobId === expected.jobId).length !== 1) {
    throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
  }
  const actual = findSoftwareJobInDocument(document, expected.jobId);
  if (!actual || actual.candidateId !== expected.candidateId || actual.skuPackageId !== expected.skuPackageId ||
      actual.revision !== expected.revision || actual.jobType !== expected.jobType) {
    throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
  }
}

function assertCandidateSoftwareJobReference(candidate, job) {
  let ref;
  if (job.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE) {
    ref = candidate?.lifecycleV11?.skuPackage?.c2FinalAssets?.stableAssetTransport?.jobRef;
  } else if (job.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
    ref = candidate?.lifecycleV11?.c1PaidKeywordEvidenceJobRefV1;
  } else {
    throw new Error("BUSINESS_MUTATION_EFFECT_JOB_TYPE_UNSUPPORTED");
  }
  if (!ref || ref.jobId !== job.jobId || ref.jobType !== job.jobType || ref.candidateId !== job.candidateId ||
      ref.skuPackageId !== job.skuPackageId || ref.resultRevision !== job.revision ||
      ref.sourceRevision !== job.scopeBinding?.sourceRevision || ref.inputFingerprint !== job.scopeBinding?.inputFingerprint) {
    throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
  }
}

function assertExactObjectKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(code);
  }
  return value;
}

function assertC1PaidKeywordExecution(result) {
  const execution = assertExactObjectKeys(result.execution, [
    "aiGatewayCalls",
    "automaticRetries",
    "codexDispatches",
    "metricProviderCalls",
    "platformAccessesByPipeline",
    "platformWrites"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  if (![0, 1].includes(execution.metricProviderCalls) ||
      execution.aiGatewayCalls !== 0 ||
      execution.codexDispatches !== 0 ||
      execution.platformAccessesByPipeline !== 0 ||
      execution.platformWrites !== 0 ||
      execution.automaticRetries !== 0) {
    throw new Error("BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  }
  const downstream = assertExactObjectKeys(result.downstream, [
    "c2Started",
    "eReadbackStarted",
    "productionStarted"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  if (downstream.c2Started !== false || downstream.productionStarted !== false || downstream.eReadbackStarted !== false) {
    throw new Error("BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  }
}

function assertC1PaidKeywordRuntimeReceipt(receipt, job) {
  assertExactObjectKeys(receipt, [
    "automaticRetries",
    "candidateId",
    "codexDispatches",
    "completedAt",
    "externalCallsByRuntime",
    "inputFingerprint",
    "platformWrites",
    "providerReceiptReads",
    "receiptFingerprint",
    "schemaVersion",
    "skuPackageId",
    "sourceCandidateRevision",
    "status"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  assertExactObjectKeys(receipt.providerReceiptReads, [
    "browser",
    "keywordMetrics",
    "seerfarApi",
    "standardSkuHealth"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  if (receipt.schemaVersion !== "c1-fact-keyword-runtime-receipt-v1" ||
      receipt.status !== "ready_for_atomic_persist" ||
      receipt.candidateId !== job.candidateId ||
      receipt.skuPackageId !== job.skuPackageId ||
      receipt.sourceCandidateRevision !== job.revision ||
      !/^[a-f0-9]{64}$/.test(receipt.inputFingerprint) ||
      !/^[a-f0-9]{64}$/.test(receipt.receiptFingerprint) ||
      !Number.isFinite(Date.parse(receipt.completedAt)) ||
      receipt.providerReceiptReads.seerfarApi !== 1 ||
      receipt.providerReceiptReads.browser !== 0 ||
      ![0, 1, 2, 3].includes(receipt.providerReceiptReads.standardSkuHealth) ||
      ![0, 1].includes(receipt.providerReceiptReads.keywordMetrics) ||
      receipt.externalCallsByRuntime !== 0 ||
      receipt.codexDispatches !== 0 ||
      receipt.platformWrites !== 0 ||
      receipt.automaticRetries !== 0) {
    throw new Error("BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  }
}

function assertC1PaidKeywordPrepared(prepared, job) {
  assertExactObjectKeys(prepared, ["receipt", "result"], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  const result = assertExactObjectKeys(prepared.result, [
    "bindingEvidence",
    "candidateId",
    "downstream",
    "evidenceStage",
    "execution",
    "factVerification",
    "gaps",
    "k3CurrentBinding",
    "k3KeywordEvidenceSnapshot",
    "keywordPreparation",
    "preparedInputs",
    "schemaVersion",
    "skuPackage",
    "sourceCandidateRevision",
    "status"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  assertC1PaidKeywordExecution(result);
  assertC1PaidKeywordRuntimeReceipt(prepared.receipt, job);
  return prepared;
}

function assertC1PaidKeywordEvidencePayload(payload, job) {
  const allowedKeys = ["schemaVersion", "prepared", "triggerReceipt", "providerReceipt"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !allowedKeys.includes(key)) ||
      payload.schemaVersion !== "c1-paid-keyword-evidence-worker-result-v1" ||
      payload.triggerReceipt !== null ||
      !payload.prepared || typeof payload.prepared !== "object" || Array.isArray(payload.prepared)) {
    throw new Error("BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  }
  assertC1PaidKeywordPrepared(payload.prepared, job);
  assertExactObjectKeys(payload.providerReceipt, ["attempt", "candidates", "pointsBefore", "pointsAfter", "pointsSpent", "providerEvidence"], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  assertExactObjectKeys(payload.providerReceipt.attempt, [
    "schemaVersion", "attemptId", "provider", "channel", "queryId", "queryText", "locale", "targetPlatform",
    "requestId", "receiptId", "startedAt", "completedAt", "status", "resultCount", "failureClass", "failureStage", "traceRef"
  ], "BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  const result = payload.prepared.result;
  if (result?.candidateId !== job.candidateId || result?.sourceCandidateRevision !== job.revision ||
      result?.skuPackage?.skuPackageId !== job.skuPackageId ||
      payload.prepared?.receipt?.candidateId !== job.candidateId ||
      payload.prepared?.receipt?.skuPackageId !== job.skuPackageId) {
    throw new Error("BUSINESS_MUTATION_C1_RESULT_PAYLOAD_INVALID");
  }
  return structuredClone(payload);
}

function applyC1PaidKeywordEvidenceSettlement({ current, jobBefore, settledJob, observedAt }) {
  const payload = assertC1PaidKeywordEvidencePayload(settledJob.resultEnvelope.payload, jobBefore);
  const sourceSkuPackage = current.lifecycleV11?.skuPackage;
  const patch = buildC1FactKeywordAtomicPatch({
    candidate: current,
    expectedRevision: jobBefore.revision,
    sourceSkuPackage,
    prepared: payload.prepared,
    triggerReceipt: payload.triggerReceipt ?? null,
    stagedAt: observedAt
  });
  const nextCandidate = structuredClone(current);
  nextCandidate.lifecycleV11 = patch.lifecycleV11;
  // Completed execution bodies remain in the immutable enqueue snapshot; live state keeps references and evidence.
  delete nextCandidate.lifecycleV11.c1KeywordSoftwareJobPlanV1;
  delete nextCandidate.lifecycleV11.c1PaidKeywordEvidenceRuntimeInputV1;
  delete nextCandidate.lifecycleV11.c1PaidKeywordEvidenceSeerfarRequestV1;
  nextCandidate.lifecycleV11.c1PaidKeywordEvidenceJobRefV1 = structuredClone(current.lifecycleV11.c1PaidKeywordEvidenceJobRefV1);
  nextCandidate.lifecycleV11.c1PaidKeywordEvidenceSettlementV1 = {
    schemaVersion: "c1-paid-keyword-evidence-settlement-v1",
    jobId: settledJob.jobId,
    resultRef: settledJob.resultRef,
    resultFingerprint: settledJob.resultEnvelope.payloadFingerprint,
    settledAt: observedAt
  };
  nextCandidate.listingPreparation = patch.listingPreparation;
  nextCandidate.processing = patch.processing;
  nextCandidate.dataRevision = patch.nextRevision;
  nextCandidate.updatedAt = patch.updatedAt;
  nextCandidate.lastModifiedBy = patch.lastModifiedBy;
  const domainResult = {
    schemaVersion: "c1-paid-keyword-evidence-settlement-result-v1",
    status: "verified",
    jobRef: structuredClone(current.lifecycleV11.c1PaidKeywordEvidenceJobRefV1),
    evidenceFingerprint: payload.prepared.result.evidenceStage.evidence.evidenceFingerprint,
    keywordSnapshotId: payload.prepared.result.k3KeywordEvidenceSnapshot.snapshotId,
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    productionPlanCreated: false,
    executionIntentCreated: false,
    platformWrites: 0,
    applicationDisposition: "applied",
    candidateRevisionUnchanged: false
  };
  return { nextCandidate, domainResult };
}

export async function executeBusinessMutation({
  repository,
  runtimeMode,
  actor,
  requiredRoles,
  action,
  candidateId,
  skuPackageId,
  expectedRevision,
  idempotencyKey,
  inputFingerprint,
  auditEventId,
  authorizationRef = null,
  externalRequestState = "not_sent",
  externalRequestRef = null,
  serverTime,
  serverClock = null,
  mutate,
  softwareJobEffect = null
}) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) {
    throw new Error("BUSINESS_MUTATION_RUNTIME_MODE_INVALID");
  }
  const boundary = CENTRAL_MODES.has(runtimeMode)
    ? assertCentralPersistenceBoundary(repository)
    : assertBusinessStateRepositoryBoundary(repository);
  authorizeOperation({ actor, requiredRoles });
  if (typeof mutate !== "function") throw new Error("BUSINESS_MUTATION_INPUT_INVALID:mutate");
  const sourceRevision = revision(expectedRevision);
  const key = text(idempotencyKey, "idempotencyKey");
  const fingerprint = text(inputFingerprint, "inputFingerprint");
  const targetCandidateId = text(candidateId, "candidateId");
  const targetSkuPackageId = text(skuPackageId, "skuPackageId");
  const operation = text(action, "action");
  const eventId = text(auditEventId, "auditEventId");
  const effect = assertDeclarativeSoftwareJobEffect(softwareJobEffect, "enqueue");

  return repository.transact(async (document) => {
    const observedAt = observedServerTime({ serverClock, serverTime, authoritativeRequired: effect !== null });
    if (!Array.isArray(document.candidates)) throw new Error("BUSINESS_MUTATION_DOCUMENT_INVALID");
    const runtime = runtimeCollections(document);
    const existing = runtime.idempotencyRecords.find((entry) => entry.idempotencyKey === key);
    if (existing) {
      if (existing.inputFingerprint !== fingerprint || existing.candidateId !== targetCandidateId || existing.action !== operation) {
        const error = new Error("BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT");
        error.code = "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT";
        throw error;
      }
      assertReplaySoftwareJob(document, existing.result);
      return {
        changed: false,
        result: Object.freeze({
          status: "idempotent_replay",
          candidate: structuredClone(existing.candidateSnapshot),
          result: structuredClone(existing.result),
          auditEvent: structuredClone(existing.auditEvent),
          repository: boundary
        })
      };
    }

    const index = document.candidates.findIndex((entry) => entry.id === targetCandidateId);
    if (index < 0) throw new Error("BUSINESS_MUTATION_CANDIDATE_NOT_FOUND");
    const current = structuredClone(document.candidates[index]);
    if (Number(current.dataRevision) !== sourceRevision) {
      const error = new Error("BUSINESS_MUTATION_REVISION_CONFLICT");
      error.code = "BUSINESS_MUTATION_REVISION_CONFLICT";
      error.currentRevision = Number(current.dataRevision);
      throw error;
    }
    const fromState = candidateState(current);
    const outcome = await mutate({ candidate: structuredClone(current), observedAt });
    if (!outcome || typeof outcome !== "object" || !outcome.candidate || !("result" in outcome)) {
      throw new Error("BUSINESS_MUTATION_OUTCOME_INVALID");
    }
    const nextCandidate = structuredClone(outcome.candidate);
    if (nextCandidate.id !== targetCandidateId || Number(nextCandidate.dataRevision) !== sourceRevision) {
      throw new Error("BUSINESS_MUTATION_CANDIDATE_IDENTITY_INVALID");
    }
    assertSafeRuntimeRecord(nextCandidate, "businessMutation.candidate");
    nextCandidate.dataRevision = sourceRevision + 1;
    const result = structuredClone(outcome.result);
    assertSafeRuntimeRecord(result, "businessMutation.result");
    if (effect) {
      const job = createSoftwareJobEnvelope({ ...structuredClone(effect.jobInput), createdAt: observedAt });
      if (job.createdAt !== observedAt) throw new Error("BUSINESS_MUTATION_EFFECT_CLOCK_DRIFT");
      if (job.candidateId !== targetCandidateId || job.skuPackageId !== targetSkuPackageId ||
          job.revision !== sourceRevision + 1 || job.idempotencyKey !== key) {
        throw new Error("BUSINESS_MUTATION_EFFECT_IDENTITY_INVALID");
      }
      assertCandidateSoftwareJobReference(nextCandidate, job);
      appendSoftwareJobAdmissionRecords(document, effect.admissionRecords, observedAt);
      const admissionDecision = consumeSoftwareJobAdmissionForEnqueue({
        document,
        job,
        observedAt,
        phase: "enqueue_before_candidate_commit"
      });
      const admittedJob = bindSoftwareJobAdmissionDecision(job, admissionDecision);
      document.candidates[index] = nextCandidate;
      const jobOutcome = enqueueSoftwareJobInDocument(document, admittedJob);
      if (!jobOutcome.changed) throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
      result.softwareJobRef = {
        jobId: jobOutcome.job.jobId,
        jobType: jobOutcome.job.jobType,
        candidateId: jobOutcome.job.candidateId,
        skuPackageId: jobOutcome.job.skuPackageId,
        revision: jobOutcome.job.revision
      };
    }
    const auditEvent = createOperationAuditEvent({
      eventId,
      action: operation,
      actor,
      workerId: outcome.workerId || null,
      candidateId: targetCandidateId,
      skuPackageId: targetSkuPackageId,
      sourceRevision,
      resultRevision: sourceRevision + 1,
      fromState,
      toState: candidateState(nextCandidate),
      authorizationRef,
      externalRequestState,
      externalRequestRef,
      idempotencyKey: key,
      serverTime: observedAt
    });
    document.candidates[index] = nextCandidate;
    runtime.operationAudit.push(structuredClone(auditEvent));
    runtime.idempotencyRecords.push({
      schemaVersion: "business-idempotency-record-v1",
      idempotencyKey: key,
      inputFingerprint: fingerprint,
      candidateId: targetCandidateId,
      skuPackageId: targetSkuPackageId,
      action: operation,
      sourceRevision,
      resultRevision: sourceRevision + 1,
      candidateSnapshot: structuredClone(nextCandidate),
      result: structuredClone(result),
      auditEvent: structuredClone(auditEvent),
      recordedAt: observedAt
    });
    return {
      changed: true,
      document,
      result: Object.freeze({
        status: "committed",
        candidate: structuredClone(nextCandidate),
        result,
        auditEvent,
        repository: boundary
      })
    };
  });
}

export async function executeSoftwareJobSettlementMutation({
  repository,
  runtimeMode,
  actor,
  requiredRoles,
  action,
  candidateId,
  skuPackageId,
  expectedRevision,
  idempotencyKey,
  inputFingerprint,
  auditEventId,
  authorizationRef = null,
  serverTime,
  serverClock,
  settlement,
  expectedJobScopeBinding
}) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) {
    throw new Error("BUSINESS_MUTATION_RUNTIME_MODE_INVALID");
  }
  const boundary = CENTRAL_MODES.has(runtimeMode)
    ? assertCentralPersistenceBoundary(repository)
    : assertBusinessStateRepositoryBoundary(repository);
  authorizeOperation({ actor, requiredRoles });
  const targetCandidateId = text(candidateId, "candidateId");
  const targetSkuPackageId = text(skuPackageId, "skuPackageId");
  const sourceRevision = revision(expectedRevision);
  const key = text(idempotencyKey, "idempotencyKey");
  const fingerprint = text(inputFingerprint, "inputFingerprint");
  const operation = text(action, "action");
  const eventId = text(auditEventId, "auditEventId");
  const settlementEffect = assertDeclarativeSoftwareJobSettlementEffect(settlement);
  if (actor?.actorType !== "worker" || actor.userId !== settlementEffect.workerId) {
    throw new Error("BUSINESS_MUTATION_WORKER_IDENTITY_REQUIRED");
  }

  return repository.transact(async (document) => {
    const observedAt = observedServerTime({ serverClock, serverTime, authoritativeRequired: true });
    if (!Array.isArray(document.candidates)) throw new Error("BUSINESS_MUTATION_DOCUMENT_INVALID");
    const runtime = runtimeCollections(document);
    const existing = runtime.idempotencyRecords.find((entry) => entry.idempotencyKey === key);
    if (existing) {
      if (existing.inputFingerprint !== fingerprint || existing.candidateId !== targetCandidateId || existing.action !== operation) {
        throw new Error("BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT");
      }
      assertReplaySoftwareJob(document, existing.result);
      return { changed: false, result: Object.freeze({
        status: "idempotent_replay",
        candidate: structuredClone(existing.candidateSnapshot),
        result: structuredClone(existing.result),
        auditEvent: structuredClone(existing.auditEvent),
        repository: boundary
      }) };
    }

    const index = document.candidates.findIndex((entry) => entry.id === targetCandidateId);
    if (index < 0) throw new Error("BUSINESS_MUTATION_CANDIDATE_NOT_FOUND");
    const current = structuredClone(document.candidates[index]);
    const jobBefore = findSoftwareJobInDocument(document, settlementEffect.jobId);
    if (!jobBefore || jobBefore.candidateId !== targetCandidateId || jobBefore.skuPackageId !== targetSkuPackageId ||
        jobBefore.revision !== sourceRevision || !expectedJobScopeBinding ||
        JSON.stringify(jobBefore.scopeBinding) !== JSON.stringify(expectedJobScopeBinding)) {
      throw new Error("BUSINESS_MUTATION_EFFECT_IDENTITY_INVALID");
    }
    assertCandidateSoftwareJobReference(current, jobBefore);
    const fromState = candidateState(current);
    const currentRevision = Number(current.dataRevision);
    if (settlementEffect.status === "completed" && jobBefore.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
      const payload = assertC1PaidKeywordEvidencePayload(settlementEffect.resultEnvelope?.payload, jobBefore);
      const enqueueRecord = runtime.idempotencyRecords.find((entry) =>
        entry.result?.softwareJobRef?.jobId === jobBefore.jobId &&
        entry.action === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && entry.candidateSnapshot?.dataRevision === jobBefore.revision
      );
      if (!enqueueRecord) throw new Error("BUSINESS_MUTATION_C1_FROZEN_INPUT_REQUIRED");
      await assertC1PaidKeywordPreparedResult({
        sourceCandidate: enqueueRecord.candidateSnapshot,
        sourceRevision: jobBefore.revision,
        prepared: payload.prepared,
        providerReceipt: payload.providerReceipt
      });
      if (currentRevision === sourceRevision && fingerprintCanonicalRecord(current.lifecycleV11?.skuPackage) !==
          fingerprintCanonicalRecord(enqueueRecord.candidateSnapshot.lifecycleV11?.skuPackage)) {
        throw new Error("BUSINESS_MUTATION_C1_FROZEN_INPUT_DRIFT");
      }
    }
    const applicationDisposition = settlementEffect.status === "completed"
      ? currentRevision === sourceRevision ? "applied" : "revision_conflict_not_applied"
      : "result_recorded_no_candidate_mutation";
    const settlementDocumentWriter = settlementEffect.status === "completed"
      ? jobBefore.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE
        ? settleC2StableAssetTransportSoftwareJobInDocument
        : jobBefore.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE
          ? settleC1PaidKeywordEvidenceSoftwareJobInDocument
          : null
      : settleSoftwareJobInDocument;
    if (!settlementDocumentWriter) throw new Error("BUSINESS_MUTATION_EFFECT_JOB_TYPE_UNSUPPORTED");
    const settledJob = settlementDocumentWriter(document, {
      ...settlementEffect,
      applicationDisposition
    }, observedAt);
    let nextCandidate = structuredClone(current);
    let domainResult = {
      status: settledJob.status,
      candidateRevisionUnchanged: true,
      productionAuthorizationCreated: false,
      dHandoffCreated: false,
      productionPlanCreated: false,
      executionIntentCreated: false,
      platformWrites: 0,
      applicationDisposition: "result_recorded_no_candidate_mutation"
    };
    if (settledJob.status === "completed") {
      if (currentRevision !== sourceRevision) {
        domainResult.applicationDisposition = "revision_conflict_not_applied";
        domainResult.productionAuthorizationCreated = false;
        domainResult.dHandoffCreated = false;
        domainResult.productionPlanCreated = false;
        domainResult.executionIntentCreated = false;
        domainResult.platformWrites = 0;
      } else if (jobBefore.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE) {
        const skuPackage = current.lifecycleV11?.skuPackage;
        const jobRef = skuPackage?.c2FinalAssets?.stableAssetTransport?.jobRef;
        if (!skuPackage || !jobRef) throw new Error("BUSINESS_MUTATION_HALF_STATE_REJECTED");
        const completed = settleC2StableAssetTransport({
          skuPackage,
          jobRef,
          transportResultEnvelope: {
            ...structuredClone(settlementEffect.resultEnvelope),
            applicationDisposition: "applied"
          },
          allowedStableAssetHosts: jobBefore.scopeBinding.allowedStableAssetHosts,
          settledAt: observedAt
        });
        nextCandidate = structuredClone(current);
        nextCandidate.lifecycleV11.skuPackage = structuredClone(completed.skuPackage);
        if (nextCandidate.id !== targetCandidateId || Number(nextCandidate.dataRevision) !== sourceRevision) {
          throw new Error("BUSINESS_MUTATION_CANDIDATE_IDENTITY_INVALID");
        }
        nextCandidate.dataRevision = sourceRevision + 1;
        domainResult = {
          schemaVersion: "c2-stable-asset-transport-settlement-result-v1",
          status: "verified",
          jobRef,
          stagedAssetManifestFingerprint: completed.c2AssetLifecycle.stableAssetTransport.stagedAssetManifestFingerprint,
          finalManifestSha256: completed.c2AssetLifecycle.stableAssetTransport.transportResult.payload.finalManifestSha256,
          transportResultEnvelope: structuredClone(completed.c2AssetLifecycle.stableAssetTransport.transportResult),
          productionAuthorizationCreated: false,
          dHandoffCreated: false,
          productionPlanCreated: false,
          executionIntentCreated: false,
          platformWrites: 0
        };
        domainResult.applicationDisposition = "applied";
        domainResult.candidateRevisionUnchanged = false;
        assertSafeRuntimeRecord(nextCandidate, "businessMutation.candidate");
        assertSafeRuntimeRecord(domainResult, "businessMutation.result");
        document.candidates[index] = nextCandidate;
      } else if (jobBefore.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) {
        const applied = applyC1PaidKeywordEvidenceSettlement({
          current,
          jobBefore,
          settledJob,
          observedAt
        });
        nextCandidate = applied.nextCandidate;
        domainResult = applied.domainResult;
        assertSafeRuntimeRecord(nextCandidate, "businessMutation.candidate");
        assertSafeRuntimeRecord(domainResult, "businessMutation.result");
        document.candidates[index] = nextCandidate;
      } else {
        throw new Error("BUSINESS_MUTATION_EFFECT_JOB_TYPE_UNSUPPORTED");
      }
    }
    const result = { ...domainResult, softwareJobRef: {
      jobId: settledJob.jobId,
      jobType: settledJob.jobType,
      candidateId: settledJob.candidateId,
      skuPackageId: settledJob.skuPackageId,
      revision: settledJob.revision
    } };
    if (settledJob.resultEnvelope) {
      if (settledJob.jobType === C2_STABLE_ASSET_TRANSPORT_JOB_TYPE) result.transportResultEnvelope = structuredClone(settledJob.resultEnvelope);
      else result.resultEnvelope = structuredClone(settledJob.resultEnvelope);
    }
    assertSafeRuntimeRecord(result, "businessMutation.result");
    const auditEvent = createOperationAuditEvent({
      eventId,
      action: operation,
      actor,
      workerId: settledJob.workerId,
      candidateId: targetCandidateId,
      skuPackageId: targetSkuPackageId,
      sourceRevision,
      resultRevision: Number(nextCandidate.dataRevision),
      fromState,
      toState: candidateState(nextCandidate),
      authorizationRef,
      externalRequestState: settledJob.externalRequestState,
      externalRequestRef: settledJob.externalRequestRef,
      idempotencyKey: key,
      serverTime: observedAt
    });
    runtime.operationAudit.push(structuredClone(auditEvent));
    runtime.idempotencyRecords.push({
      schemaVersion: "business-idempotency-record-v1",
      idempotencyKey: key,
      inputFingerprint: fingerprint,
      candidateId: targetCandidateId,
      skuPackageId: targetSkuPackageId,
      action: operation,
      sourceRevision,
      resultRevision: Number(nextCandidate.dataRevision),
      candidateSnapshot: structuredClone(nextCandidate),
      result: structuredClone(result),
      auditEvent: structuredClone(auditEvent),
      recordedAt: observedAt
    });
    return { changed: true, document, result: Object.freeze({
      status: "committed", candidate: structuredClone(nextCandidate), result, auditEvent, repository: boundary
    }) };
  });
}
