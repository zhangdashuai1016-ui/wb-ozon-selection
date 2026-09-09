import { isDeepStrictEqual } from "node:util";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation, assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord, assertCanonicalFrozenRef, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { assertValidProductionRecord, validateProductionReadbackExpectation } from "./draft-production-execution.mjs";
import { validateSystemCreatedVerificationRecord } from "./e-stage-readback.mjs";
import { runSystemCreatedEReadback } from "./d-e-software-closure.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { normalizeC1SourceIdentity } from "./c1-product-plan.mjs";
import { assertEReadbackJobReference, settleEReadbackJobInDocument } from "./d-e-software-job-handoff.mjs";
import { bindSoftwareJobAdmissionDecision, findSoftwareJobInDocument, markSoftwareJobExternalRequestStarted,
  softwareJobsInDocument } from "./software-job-contract.mjs";

import { E_READBACK_ATTEMPT_VERSION, assertEReadbackAttempt } from "./e-readback-attempt.mjs";
export { E_READBACK_ATTEMPT_VERSION, assertEReadbackAttempt };

export const E_READBACK_MAX_DURATION_MS = 60_000;

export class EReadbackRuntimeUnavailableError extends Error {
  constructor() {
    super("E_READBACK_RUNTIME_NOT_CONFIGURED: 可信平台回读尚未接通，未发起查询");
    this.name = "EReadbackRuntimeUnavailableError";
    this.code = "E_READBACK_RUNTIME_NOT_CONFIGURED";
  }
}

class EReadbackSourceConflictError extends Error {
  constructor(code) {
    super(code);
    this.name = "EReadbackSourceConflictError";
    this.code = code;
  }
}

function timestamp(clock) {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("E_READBACK_CLOCK_INVALID");
  return new Date(value).toISOString();
}

function candidateIn(document, candidateId) {
  if (!Array.isArray(document.candidates)) throw new Error("E_READBACK_DOCUMENT_INVALID");
  const matches = document.candidates.filter(candidate => candidate.id === candidateId);
  if (matches.length !== 1 || !matches[0].lifecycleV11?.skuPackage) throw new Error("E_READBACK_CANDIDATE_NOT_FOUND");
  return matches[0];
}

function sourceSnapshot(candidate, sourceRecordId) {
  const sku = candidate.lifecycleV11.skuPackage;
  const record = sku.productionRecord;
  assertValidProductionRecord(record);
  const identity = normalizeC1SourceIdentity(sku.g1Identity);
  if (record.productionRecordId !== sourceRecordId || record.executionMode !== "single_sku_seller_api" ||
      record.skuPackageId !== sku.skuPackageId || record.supplierSkuId !== sku.supplierSkuId ||
      record.platform !== sku.targetPlatform || record.store !== sku.targetStore || candidate.targetStore !== sku.targetStore ||
      identity?.candidateId !== candidate.id || identity.skuPackageId !== sku.skuPackageId ||
      identity.supplierSkuId !== sku.supplierSkuId || identity.platform !== sku.targetPlatform ||
      !sameStoreRef(record.storeRef, identity.storeRef) || !sameStoreRef(record.storeRef, candidate.storeRef) ||
      sku.externalListingRecord !== null || !Array.isArray(sku.readbackHistory)) throw new EReadbackSourceConflictError("E_READBACK_SOURCE_SCOPE_CONFLICT");
  return { productionRecord: structuredClone(record), identity: structuredClone(identity), variantKey: sku.variantKey };
}

function recordedAttempt(candidate, sourceRecordId) {
  const history = candidate.lifecycleV11.skuPackage.readbackHistory;
  if (!Array.isArray(history)) throw new Error("E_READBACK_HISTORY_INVALID");
  const matches = history.filter(entry => entry?.schemaVersion === E_READBACK_ATTEMPT_VERSION &&
    entry.sourceProductionRecordId === sourceRecordId);
  if (matches.length > 1) throw new Error("E_READBACK_ATTEMPT_DUPLICATE");
  const attempt = matches[0];
  if (!attempt) return null;
  assertEReadbackAttempt(attempt);
  if (attempt.candidateId !== candidate.id || attempt.skuPackageId !== candidate.lifecycleV11.skuPackage.skuPackageId) {
    throw new Error("E_READBACK_ATTEMPT_SCOPE_CONFLICT");
  }
  return attempt;
}

function assertAppliedSource(candidate, attempt) {
  if (attempt?.applicationDisposition === "applied") {
    const sku = candidate.lifecycleV11.skuPackage;
    if (!validateSystemCreatedVerificationRecord(attempt.result.eVerificationRecord, sku.productionRecord).valid ||
        !isDeepStrictEqual(attempt.result.eVerificationRecord, sku.eVerificationRecord)) {
      throw new EReadbackSourceConflictError("E_READBACK_APPLIED_SOURCE_CONFLICT");
    }
    let source;
    try { source = sourceSnapshot(candidate, attempt.sourceProductionRecordId); }
    catch (error) {
      if (!(error instanceof EReadbackSourceConflictError)) throw error;
      throw new EReadbackSourceConflictError("E_READBACK_APPLIED_SOURCE_CONFLICT");
    }
    if (fingerprintCanonicalRecord(source) !== attempt.sourceFingerprint) {
      throw new EReadbackSourceConflictError("E_READBACK_APPLIED_SOURCE_CONFLICT");
    }
  }
}

function currentAttempt(candidate, sourceRecordId) {
  const attempt = recordedAttempt(candidate, sourceRecordId);
  assertAppliedSource(candidate, attempt);
  return attempt;
}

function displayedAttempt(candidate) {
  const sku = candidate.lifecycleV11?.skuPackage;
  if (!sku || (!sku.productionRecord?.productionRecordId && !sku.eVerificationRecord && sku.businessPhase !== "E")) return null;
  if (!Array.isArray(sku.readbackHistory)) throw new Error("E_READBACK_HISTORY_INVALID");
  // An applied result is located by durable history, never solely by a current pointer that may have drifted.
  if (sku.eVerificationRecord || sku.businessPhase === "E") {
    const applied = sku.readbackHistory.filter(entry => entry?.schemaVersion === E_READBACK_ATTEMPT_VERSION &&
      entry.applicationDisposition === "applied");
    const matching = applied.length > 1 ? applied.filter(entry =>
      entry.result?.eVerificationRecord?.verificationId === sku.eVerificationRecord?.verificationId) : applied;
    if (applied.length > 0) {
      if (matching.length !== 1) throw new Error("E_READBACK_APPLIED_HISTORY_AMBIGUOUS");
      return recordedAttempt(candidate, matching[0].sourceProductionRecordId);
    }
  }
  return sku.productionRecord?.productionRecordId ? recordedAttempt(candidate, sku.productionRecord.productionRecordId) : null;
}

function publicAttempt(attempt, activeIds) {
  if (!attempt) return null;
  return Object.freeze({ ...structuredClone(attempt),
    recordedStatus: attempt.status,
    currentVerified: attempt.status === "verified" && attempt.applicationDisposition === "applied",
    sourceConflict: null,
    status: attempt.status === "in_flight" && !activeIds.has(attempt.attemptId) ? "unknown_outcome" : attempt.status,
    live: attempt.status === "in_flight" && activeIds.has(attempt.attemptId), automaticRetry: false });
}

function validateInput(input) {
  const fields = ["candidateId", "expectedCandidateRevision", "sourceRecordId"];
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field)) ||
      !Number.isInteger(input.expectedCandidateRevision) || input.expectedCandidateRevision < 0) throw new Error("E_READBACK_INPUT_INVALID");
  assertCanonicalFrozenRef(input.candidateId, "candidateId");
  assertCanonicalFrozenRef(input.sourceRecordId, "sourceRecordId");
}

function assertSoftwareJobContext(context) {
  const fields = ["jobStore", "jobId", "workerId", "leaseId"];
  if (!context || typeof context !== "object" || Array.isArray(context) || Object.keys(context).length !== fields.length ||
      fields.some(field => !Object.hasOwn(context, field)) || typeof context.jobStore?.assertDEExecutionInDocument !== "function" ||
      ![context.jobId, context.workerId, context.leaseId].every(isCanonicalFrozenRef)) throw new Error("E_READBACK_SOFTWARE_JOB_CONTEXT_INVALID");
}

// Receipt/replay identity survives lease expiry and current source edits; it never grants another read.
function assertSavedJobHolder({ document, candidate, attempt, input, softwareJobContext }) {
  const job = findSoftwareJobInDocument(document, softwareJobContext.jobId);
  const ref = attempt.softwareJobRef;
  if (!job || !ref || job.jobType !== "e_independent_readback" || job.candidateId !== candidate.id ||
      job.skuPackageId !== attempt.skuPackageId || job.attempt !== 1 ||
      ref.jobId !== job.jobId || ref.revision !== job.revision || ref.workerId !== job.workerId || ref.leaseId !== job.leaseId ||
      ref.workerId !== softwareJobContext.workerId || ref.leaseId !== softwareJobContext.leaseId ||
      attempt.requestedByUserId !== job.workerId || input.expectedCandidateRevision !== job.revision ||
      input.sourceRecordId !== job.scopeBinding.sourceProductionRecordId ||
      attempt.sourceProductionRecordId !== job.scopeBinding.sourceProductionRecordId ||
      !isDeepStrictEqual(candidate.lifecycleV11.eIndependentReadbackJobRefV1, {
        jobId: job.jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId,
        sourceRevision: job.scopeBinding.sourceRevision, resultRevision: job.revision, inputFingerprint: job.scopeBinding.inputFingerprint
      })) throw new Error("E_READBACK_SOFTWARE_JOB_REFERENCE_CONFLICT");
  return job;
}

function assertCurrentJob({ document, candidate, input, softwareJobContext, observedAt }) {
  assertEReadbackJobReference({ document, candidate, job: findSoftwareJobInDocument(document, softwareJobContext.jobId) });
  const guard = softwareJobContext.jobStore.assertDEExecutionInDocument({ document,
    jobId: softwareJobContext.jobId, workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId, observedAt });
  if (guard.job.revision !== input.expectedCandidateRevision || candidate.dataRevision !== guard.job.revision ||
      guard.job.scopeBinding.sourceProductionRecordId !== input.sourceRecordId) throw new Error("E_READBACK_REVISION_CONFLICT");
  return guard;
}

function markJobRequestStarted(document, guard, softwareJobContext, observedAt) {
  const job = markSoftwareJobExternalRequestStarted({ job: bindSoftwareJobAdmissionDecision(guard.job, guard.admissionDecision),
    workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId,
    externalRequestRef: `e-readback-request:${guard.job.scopeBinding.inputFingerprint}`, serverTime: observedAt });
  const jobs = softwareJobsInDocument(document), index = jobs.findIndex(entry => entry.jobId === job.jobId);
  if (index < 0) throw new Error("E_READBACK_SOFTWARE_JOB_REFERENCE_CONFLICT");
  jobs[index] = structuredClone(job);
}

/** A single independent read uses the existing SKU history. Construction and replay perform no platform I/O. */
export function createSystemEReadbackSoftwareRuntime({ repository, runtimeMode, serverClock, readPlatform = null,
  maxReadDurationMs = E_READBACK_MAX_DURATION_MS }) {
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else if (["central_test", "central_production"].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  else throw new Error("E_READBACK_RUNTIME_MODE_INVALID");
  if (typeof serverClock !== "function" || (readPlatform !== null && typeof readPlatform !== "function") ||
      !Number.isInteger(maxReadDurationMs) || maxReadDurationMs < 1 || maxReadDurationMs > E_READBACK_MAX_DURATION_MS) {
    throw new Error("E_READBACK_DEPENDENCY_INVALID");
  }
  const activeIds = new Set();

  return Object.freeze({
    view(candidate) {
      const attempt = displayedAttempt(candidate);
      try { assertAppliedSource(candidate, attempt); }
      catch (error) {
        if (!(error instanceof EReadbackSourceConflictError)) throw error;
        return Object.freeze({ ...publicAttempt(attempt, activeIds), status: "source_conflict",
          currentVerified: false, sourceConflict: error.code });
      }
      return publicAttempt(attempt, activeIds);
    },
    async run({ actor, input, softwareJobContext = null }) {
      validateInput(input);
      if (softwareJobContext !== null) {
        assertSoftwareJobContext(softwareJobContext);
        if (actor?.actorType !== "worker" || actor.source !== "registered_runtime_worker" || actor.userId !== softwareJobContext.workerId) {
          throw new Error("E_READBACK_REGISTERED_WORKER_REQUIRED");
        }
      }
      if (readPlatform === null) throw new EReadbackRuntimeUnavailableError();
      authorizeOperation({ actor, requiredRoles: ["owner", "operator"] });
      if (!((actor.actorType === "human" && actor.source === "authenticated_identity_provider") ||
          (actor.actorType === "worker" && actor.source === "registered_runtime_worker"))) {
        throw new Error("E_READBACK_AUTHENTICATED_ACTOR_REQUIRED");
      }
      const admitted = await repository.transact(document => {
        const candidate = candidateIn(document, input.candidateId);
        const existing = currentAttempt(candidate, input.sourceRecordId);
        if (softwareJobContext === null && (candidate.lifecycleV11.skuPackage.dHandoff?.schemaVersion === "c2-d-handoff-v2" ||
            Object.hasOwn(candidate.lifecycleV11.skuPackage.dSoftwareExecution ?? {}, "softwareJobRef") ||
            document.runtime?.softwareJobs?.some(job => job.jobType === "e_independent_readback" && job.candidateId === candidate.id) ||
            Object.hasOwn(candidate.lifecycleV11, "eIndependentReadbackJobRefV1") ||
            (existing && Object.hasOwn(existing, "softwareJobRef")))) throw new Error("E_READBACK_SOFTWARE_JOB_CONTEXT_REQUIRED");
        if (existing) {
          if (softwareJobContext !== null) assertSavedJobHolder({ document, candidate, attempt: existing, input, softwareJobContext });
          return { changed: false, result: { status: "idempotent_replay", candidate: structuredClone(candidate), attempt: publicAttempt(existing, activeIds) } };
        }
        if (candidate.dataRevision !== input.expectedCandidateRevision) throw new Error("E_READBACK_REVISION_CONFLICT");
        const source = sourceSnapshot(candidate, input.sourceRecordId);
        const sku = candidate.lifecycleV11.skuPackage;
        if (sku.eVerificationRecord !== null) throw new Error("E_READBACK_VERIFICATION_ALREADY_EXISTS");
        const startedAt = timestamp(serverClock);
        const guard = softwareJobContext === null ? null : assertCurrentJob({ document, candidate, input, softwareJobContext, observedAt: startedAt });
        const attempt = { schemaVersion: E_READBACK_ATTEMPT_VERSION,
          attemptId: `e-readback:${candidate.id}:${input.sourceRecordId}`,
          candidateId: candidate.id, skuPackageId: sku.skuPackageId,
          sourceProductionRecordId: input.sourceRecordId, sourceFingerprint: fingerprintCanonicalRecord(source),
          requestedByUserId: actor.userId, startedAt, completedAt: null, status: "in_flight",
          externalRequestState: "not_sent", result: null, applicationDisposition: "pending", automaticRetry: false, platformWrites: 0 };
        if (guard !== null) attempt.softwareJobRef = { jobId: guard.job.jobId, revision: guard.job.revision,
          workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId };
        assertEReadbackAttempt(attempt);
        sku.readbackHistory.push(attempt);
        return { changed: true, document, result: { status: "admitted", source, attempt: structuredClone(attempt) } };
      });
      if (admitted.status === "idempotent_replay") return admitted;

      const attempt = admitted.attempt;
      activeIds.add(attempt.attemptId);
      try {
        const requiresRead = validateProductionReadbackExpectation(admitted.source.productionRecord.readbackExpectation);
        if (requiresRead) await repository.transact(document => {
          const candidate = candidateIn(document, input.candidateId);
          const current = currentAttempt(candidate, input.sourceRecordId);
          if (current?.attemptId !== attempt.attemptId || current.status !== "in_flight" || current.externalRequestState !== "not_sent") {
            throw new Error("E_READBACK_ATTEMPT_CONFLICT");
          }
          if (!isDeepStrictEqual(sourceSnapshot(candidate, input.sourceRecordId), admitted.source)) throw new Error("E_READBACK_SOURCE_SCOPE_CONFLICT");
          if (softwareJobContext !== null) {
            assertSavedJobHolder({ document, candidate, attempt: current, input, softwareJobContext });
            const observedAt = timestamp(serverClock);
            const guard = assertCurrentJob({ document, candidate, input, softwareJobContext, observedAt });
            markJobRequestStarted(document, guard, softwareJobContext, observedAt);
          }
          current.externalRequestState = "in_flight";
          return { changed: true, document, result: null };
        });
        const boundedRead = async request => {
          const controller = new AbortController();
          let timer;
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("E_READBACK_DEADLINE_EXCEEDED"));
            }, maxReadDurationMs);
          });
          try {
            return await Promise.race([Promise.resolve().then(() => readPlatform(request, { signal: controller.signal })), deadline]);
          } finally {
            clearTimeout(timer);
          }
        };
        const result = await runSystemCreatedEReadback({ productionRecord: admitted.source.productionRecord,
          readPlatform: boundedRead, completionClock: serverClock, verifiedAt: timestamp(serverClock) });
        assertSafeRuntimeRecord(result, "eReadbackResult");
        return await repository.transact(document => {
          const candidate = candidateIn(document, input.candidateId);
          const sku = candidate.lifecycleV11.skuPackage;
          const current = currentAttempt(candidate, input.sourceRecordId);
          if (current?.attemptId !== attempt.attemptId || current.status !== "in_flight" || current.result !== null) throw new Error("E_READBACK_SETTLEMENT_CONFLICT");
          const job = softwareJobContext === null ? null : assertSavedJobHolder({ document, candidate, attempt: current, input, softwareJobContext });
          current.completedAt = timestamp(serverClock);
          current.result = structuredClone(result);
          const ioUnknown = result.gaps.includes("technical_readback_failure:platform_read_failed");
          current.status = ioUnknown ? "unknown_outcome" : result.status;
          current.externalRequestState = !requiresRead ? "not_sent" : ioUnknown ? "unknown_outcome" : "succeeded";
          // Persist the observed result even if a concurrent edit prevents publishing it as the current verification.
          const reconciliationRequired = job?.status === "unknown_outcome";
          const sourceStillCurrent = !reconciliationRequired && (job === null || candidate.dataRevision === job.revision) &&
            isDeepStrictEqual(sku.productionRecord, admitted.source.productionRecord) &&
            isDeepStrictEqual(sku.g1Identity, admitted.source.identity) && sku.variantKey === admitted.source.variantKey &&
            sku.skuPackageId === attempt.skuPackageId && sku.supplierSkuId === admitted.source.productionRecord.supplierSkuId &&
            sku.targetPlatform === admitted.source.productionRecord.platform && sku.targetStore === admitted.source.productionRecord.store &&
            candidate.targetStore === sku.targetStore && sameStoreRef(candidate.storeRef, admitted.source.productionRecord.storeRef) &&
            sku.externalListingRecord === null && sku.eVerificationRecord === null;
          current.applicationDisposition = reconciliationRequired ? "reconciliation_required_not_applied" :
            sourceStillCurrent ? "recorded" : "source_conflict_not_applied";
          if (!sourceStillCurrent) current.status = "not_applied";
          if (sourceStillCurrent && result.status === "verified") {
            if (!validateSystemCreatedVerificationRecord(result.eVerificationRecord, sku.productionRecord).valid) throw new Error("E_READBACK_VERIFICATION_INVALID");
            sku.eVerificationRecord = structuredClone(result.eVerificationRecord);
            sku.businessPhase = "E";
            sku.businessResult = "passed";
            sku.technicalStatus = "completed";
            sku.ownerAction = "none";
            candidate.dataRevision += 1;
            candidate.updatedAt = current.completedAt;
            candidate.workflowStatus = "listed";
            current.applicationDisposition = "applied";
          }
          assertEReadbackAttempt(current);
          if (softwareJobContext !== null) settleEReadbackJobInDocument({ document, candidate,
            jobId: softwareJobContext.jobId, workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId,
            observedAt: current.completedAt });
          return { changed: true, document, result: { status: current.status, candidate: structuredClone(candidate), attempt: publicAttempt(current, new Set()) } };
        });
      } finally {
        activeIds.delete(attempt.attemptId);
      }
    }
  });
}
