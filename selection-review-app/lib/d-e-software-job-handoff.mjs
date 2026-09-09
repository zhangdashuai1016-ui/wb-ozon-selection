import { isDeepStrictEqual } from "node:util";
import { createDProductionJobScope, assertDProductionJobScope } from "./d-e-software-job-scope.mjs";
import { assertDEJobAdmissionDecision } from "./d-e-software-job-admission.mjs";
import { assertValidLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import {
  D_PRODUCTION_EXECUTION_JOB_TYPE, D_PRODUCTION_EXECUTION_CAPABILITY,
  E_INDEPENDENT_READBACK_JOB_TYPE, E_INDEPENDENT_READBACK_CAPABILITY,
  createSoftwareJobEnvelope, enqueueSoftwareJobInDocument, findSoftwareJobInDocument, settleDProductionSoftwareJobInDocument,
  settleEReadbackSoftwareJobInDocument, settleDAssetTransportSoftwareJobInDocument, settleDPreparationSoftwareJobInDocument
} from "./software-job-contract.mjs";
import { bindSoftwareJobAdmissionForEnqueue } from "./software-job-admission.mjs";

function referenceFor(job) {
  return { jobId: job.jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId,
    sourceRevision: job.scopeBinding.sourceRevision, resultRevision: job.revision, inputFingerprint: job.scopeBinding.inputFingerprint };
}

/** Called only inside the transaction that just created this PA. No transport or credential lookup occurs here. */
export function enqueueDProductionHandoffInDocument({ document, candidate, observedAt }) {
  const scopeBinding = createDProductionJobScope({ candidate, observedAt });
  const sku = candidate.lifecycleV11.skuPackage;
  const authorization = sku.productionAuthorization;
  if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v1" || sku.dHandoff.softwareJobCreated !== false ||
      authorization.authorizedAt !== observedAt || sku.dHandoff.createdAt !== observedAt ||
      !Array.isArray(document.candidates) || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  const jobId = `d-production-job:${scopeBinding.authorizationFingerprint}`;
  const job = createSoftwareJobEnvelope({ jobId, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    revision: candidate.dataRevision, jobType: D_PRODUCTION_EXECUTION_JOB_TYPE, createdAt: observedAt,
    requestedByUserId: authorization.authorizedByActorId, ownerUserId: authorization.authorizedByActorId,
    requiredCapabilities: [D_PRODUCTION_EXECUTION_CAPABILITY], idempotencyKey: jobId, scopeBinding });
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({ document, job, observedAt, phase: "enqueue_current" });
  const queued = enqueueSoftwareJobInDocument(document, admittedJob);
  if (!queued.changed) throw new Error("D_JOB_HANDOFF_ALREADY_EXISTS");
  sku.dHandoff = { ...sku.dHandoff, schemaVersion: "c2-d-handoff-v2", status: "software_job_queued",
    softwareJobCreated: true, softwareJobRef: referenceFor(queued.job) };
  sku.businessPhase = "D";
  sku.technicalStatus = "queued";
  const event = sku.audit.history.at(-1);
  if (event?.event !== "production_authorization_and_d_handoff_created_atomically" ||
      event.authorizationId !== authorization.authorizationId || event.at !== observedAt || event.softwareJobCreated !== false) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_AUDIT_REQUIRED");
  }
  event.event = "production_authorization_and_d_software_job_created_atomically";
  event.softwareJobCreated = true;
  event.softwareJobId = jobId;
  candidate.lifecycleV11.status = "production_authorized_d_job_queued";
  assertValidLifecyclePackage(sku);
  return { dHandoff: structuredClone(sku.dHandoff), softwareJobCreated: true,
    softwareJobRef: { jobId, jobType: job.jobType, candidateId: job.candidateId, skuPackageId: job.skuPackageId, revision: job.revision } };
}

/** A saved job cannot adopt a historical PA or another job's candidate reference. */
export function assertDProductionJobReference({ document, candidate, job }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  const handoff = sku?.dHandoff;
  if (!authorization || handoff?.schemaVersion !== "c2-d-handoff-v2" || handoff.softwareJobCreated !== true ||
      job?.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || job.scopeBinding?.authorizationRef !== authorization.authorizationId ||
      job.scopeBinding.authorizationFingerprint !== fingerprintCanonicalRecord(authorization) ||
      job.jobId !== `d-production-job:${job.scopeBinding.authorizationFingerprint}` ||
      !isDeepStrictEqual(handoff.softwareJobRef, referenceFor(job)) ||
      handoff.productionAuthorizationId !== authorization.authorizationId ||
      job.ownerUserId !== authorization.authorizedByActorId || job.requestedByUserId !== authorization.authorizedByActorId ||
      !Array.isArray(document.runtime?.softwareJobs) ||
      document.runtime.softwareJobs.filter(entry => entry.jobType === job.jobType &&
        entry.scopeBinding?.authorizationRef === authorization.authorizationId).length !== 1 ||
      !isDeepStrictEqual(findSoftwareJobInDocument(document, job.jobId), job)) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

/** A replay must find both immutable PA and the same unique job; later execution progress is allowed. */
export function assertPersistedDProductionHandoff({ document, candidate, job, sourceCandidate }) {
  assertDProductionJobReference({ document, candidate, job });
  const { productionAuthorization: authorization, dHandoff: handoff } = candidate.lifecycleV11.skuPackage;
  if (!sourceCandidate || !isDeepStrictEqual(handoff, sourceCandidate.lifecycleV11?.skuPackage?.dHandoff) ||
      job.createdAt !== authorization.authorizedAt || job.idempotencyKey !== job.jobId) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
  // Validate the frozen input at its original clock, not today's rights expiry.
  assertDProductionJobScope({ scope: job.scopeBinding, candidate: sourceCandidate, observedAt: job.createdAt });
  assertDEJobAdmissionDecision(job, job.admissionDecision);
}

function assertFrozenDJobHandoff(document, candidate, before) {
  const handoff = candidate.lifecycleV11?.skuPackage?.dHandoff;
  if (before.jobType !== D_PRODUCTION_EXECUTION_JOB_TYPE || handoff?.schemaVersion !== "c2-d-handoff-v2" ||
      handoff.softwareJobCreated !== true || !isDeepStrictEqual(handoff.softwareJobRef, referenceFor(before)) ||
      handoff.productionAuthorizationId !== before.scopeBinding.authorizationRef ||
      before.jobId !== `d-production-job:${before.scopeBinding.authorizationFingerprint}` || before.idempotencyKey !== before.jobId ||
      document.runtime.softwareJobs.filter(entry => entry.jobType === before.jobType &&
        entry.scopeBinding?.authorizationRef === before.scopeBinding.authorizationRef).length !== 1) {
    throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

/** Existing D settlement calls this before committing its ProductionRecord. E is created only with the verified D source. */
export function settleDProductionJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  const { job, eScope, reconciliationRequired } = settleDProductionSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
  if (reconciliationRequired) {
    candidate.lifecycleV11.skuPackage.dSoftwareExecution.continuationBlocked = true;
    candidate.lifecycleV11.skuPackage.dSoftwareExecution.blockReason = "software_job_reconciliation_required";
  }
  if (eScope === null) return Object.freeze({ job, eJobRef: null });
  if (Object.hasOwn(candidate.lifecycleV11, "eIndependentReadbackJobRefV1")) throw new Error("E_JOB_HANDOFF_ALREADY_EXISTS");
  const eJobId = `e-readback-job:${eScope.inputFingerprint}`;
  const pending = createSoftwareJobEnvelope({ jobId: eJobId, candidateId: candidate.id, skuPackageId: job.skuPackageId,
    revision: candidate.dataRevision, jobType: E_INDEPENDENT_READBACK_JOB_TYPE, createdAt: observedAt,
    requestedByUserId: job.requestedByUserId, ownerUserId: job.ownerUserId,
    requiredCapabilities: [E_INDEPENDENT_READBACK_CAPABILITY], idempotencyKey: eJobId, scopeBinding: eScope });
  const admitted = bindSoftwareJobAdmissionForEnqueue({ document, job: pending, observedAt, phase: "enqueue_current" });
  const queued = enqueueSoftwareJobInDocument(document, admitted);
  if (!queued.changed) throw new Error("E_JOB_HANDOFF_ALREADY_EXISTS");
  const eJobRef = referenceFor(queued.job);
  candidate.lifecycleV11.eIndependentReadbackJobRefV1 = eJobRef;
  candidate.lifecycleV11.skuPackage.businessPhase = "E";
  candidate.lifecycleV11.skuPackage.technicalStatus = "queued";
  candidate.lifecycleV11.status = "d_created_e_readback_queued";
  return Object.freeze({ job, eJobRef: structuredClone(eJobRef) });
}

export function settleEReadbackJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("E_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  if (before.jobType !== E_INDEPENDENT_READBACK_JOB_TYPE ||
      !isDeepStrictEqual(candidate.lifecycleV11?.eIndependentReadbackJobRefV1, referenceFor(before)) ||
      before.jobId !== `e-readback-job:${before.scopeBinding.inputFingerprint}` || before.idempotencyKey !== before.jobId ||
      document.runtime.softwareJobs.filter(entry => entry.jobType === before.jobType &&
        entry.scopeBinding?.authorizationRef === before.scopeBinding.authorizationRef).length !== 1) {
    throw new Error("E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
  return settleEReadbackSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
}

export function assertEReadbackJobReference({ document, candidate, job }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const ref = candidate?.lifecycleV11?.eIndependentReadbackJobRefV1;
  if (!sku || job?.jobType !== E_INDEPENDENT_READBACK_JOB_TYPE || !isDeepStrictEqual(ref, referenceFor(job)) ||
      job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
      job.jobId !== `e-readback-job:${job.scopeBinding?.inputFingerprint}` || job.idempotencyKey !== job.jobId ||
      sku.productionRecord?.productionRecordId !== job.scopeBinding?.sourceProductionRecordId ||
      fingerprintCanonicalRecord(sku.productionRecord) !== job.scopeBinding.sourceProductionRecordFingerprint ||
      job.ownerUserId !== sku.productionAuthorization?.authorizedByActorId || job.requestedByUserId !== job.ownerUserId ||
      !Array.isArray(document.runtime?.softwareJobs) || document.runtime.softwareJobs.filter(entry => entry.jobType === job.jobType &&
        entry.scopeBinding?.authorizationRef === job.scopeBinding.authorizationRef).length !== 1) {
    throw new Error("E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
  }
}

export function settleDAssetTransportJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_ASSET_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  const result = settleDAssetTransportSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
  if (result.continuationBlocked) {
    const state = candidate.lifecycleV11.skuPackage.dAssetTransport;
    state.continuationBlocked = true;
    if (result.reconciliationRequired) state.blockReason = "software_job_reconciliation_required";
    else if (!state.blockReason) state.blockReason = result.job.failureClass;
  }
  return result;
}

export function settleDPreparationJobInDocument({ document, candidate, jobId, workerId, leaseId, observedAt }) {
  const before = findSoftwareJobInDocument(document, jobId);
  if (!before || candidate?.id !== before.candidateId || document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("D_PREPARATION_JOB_HANDOFF_ATOMIC_SOURCE_REQUIRED");
  }
  assertFrozenDJobHandoff(document, candidate, before);
  return settleDPreparationSoftwareJobInDocument(document, { jobId, workerId, leaseId }, observedAt);
}
