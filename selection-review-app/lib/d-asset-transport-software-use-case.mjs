import { isDeepStrictEqual } from "node:util";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation, assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { assertValidProductionPlan } from "./production-plan.mjs";
import { assertCurrentProductionExecutionBinding } from "./platform-write-preflight.mjs";
import { assertDProductionJobReference, settleDAssetTransportJobInDocument } from "./d-e-software-job-handoff.mjs";
import { bindSoftwareJobAdmissionDecision, findSoftwareJobInDocument, markSoftwareJobExternalRequestStarted,
  recordDESoftwareJobProgress, softwareJobsInDocument } from "./software-job-contract.mjs";
import { createPersistableAliyunOssAssetIntent, markAliyunOssAssetIntentPersisted,
  executeAliyunOssAssetIntent, settleAliyunOssAssetIntent } from "./aliyun-oss-d-asset-integration.mjs";

function observedTime(clock) {
  const value = clock();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("OSS_D_TIME_INVALID");
  return new Date(value).toISOString();
}

function assertInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "candidateId") || !Object.hasOwn(input, "expectedCandidateRevision") ||
      !isCanonicalFrozenRef(input.candidateId) || !Number.isSafeInteger(input.expectedCandidateRevision) || input.expectedCandidateRevision < 0) {
    throw new Error("OSS_D_SOFTWARE_INPUT_INVALID");
  }
}

function assertContext(context, actor) {
  const fields = ["jobStore", "jobId", "workerId", "leaseId"];
  if (!context || typeof context !== "object" || Array.isArray(context) || Object.keys(context).length !== fields.length ||
      fields.some(field => !Object.hasOwn(context, field)) || typeof context.jobStore?.assertDEExecutionInDocument !== "function" ||
      ![context.jobId, context.workerId, context.leaseId].every(isCanonicalFrozenRef)) throw new Error("OSS_D_SOFTWARE_JOB_CONTEXT_INVALID");
  if (actor?.actorType !== "worker" || actor.source !== "registered_runtime_worker" || actor.userId !== context.workerId) {
    throw new Error("OSS_D_REGISTERED_WORKER_REQUIRED");
  }
  authorizeOperation({ actor, requiredRoles: ["operator", "owner"] });
}

function candidateIn(document, candidateId) {
  if (!Array.isArray(document.candidates)) throw new Error("OSS_D_DOCUMENT_INVALID");
  const matches = document.candidates.filter(candidate => candidate.id === candidateId);
  if (matches.length !== 1 || !matches[0].lifecycleV11?.skuPackage) throw new Error("OSS_D_CANDIDATE_MISSING");
  return matches[0];
}

function softwareReference(job, context) {
  return { jobId: job.jobId, revision: job.revision, workerId: context.workerId, leaseId: context.leaseId };
}

// This identity check is also valid after source edits and lease expiry. It grants no further upload.
function assertSavedHolder({ document, candidate, input, softwareJobContext }) {
  const state = candidate.lifecycleV11.skuPackage.dAssetTransport;
  const job = findSoftwareJobInDocument(document, softwareJobContext.jobId);
  const intent = state?.intent;
  if (!job || job.jobType !== "d_production_execution" || job.attempt !== 1 || job.candidateId !== candidate.id ||
      job.skuPackageId !== candidate.lifecycleV11.skuPackage.skuPackageId ||
      job.workerId !== softwareJobContext.workerId || job.leaseId !== softwareJobContext.leaseId ||
      input.expectedCandidateRevision !== job.revision ||
      state?.schemaVersion !== "aliyun-oss-d-asset-state-v1" ||
      !isDeepStrictEqual(state.softwareJobRef, softwareReference(job, softwareJobContext)) ||
      !["in_flight", "verified", "failed", "unknown_outcome"].includes(state.status) ||
      state.executionRevision !== (state.status === "in_flight" ? 1 : 2) ||
      intent?.status !== (state.status === "verified" ? "completed" : state.status) ||
      intent.candidateId !== candidate.id || intent.skuPackageId !== job.skuPackageId || intent.candidateDataRevision !== job.revision ||
      intent.persistedCandidateRevision !== job.revision + 1 || intent.authorizationId !== job.scopeBinding.authorizationRef ||
      intent.authorizationFingerprint !== job.scopeBinding.authorizationFingerprint ||
      intent.productionPlan?.sourceAuthorization?.authorizationId !== job.scopeBinding.authorizationRef ||
      fingerprintCanonicalRecord(intent.productionPlan.sourceAuthorization) !== job.scopeBinding.authorizationFingerprint) {
    throw new Error("OSS_D_SOFTWARE_JOB_REFERENCE_CONFLICT");
  }
  assertValidProductionPlan(intent.productionPlan);
  assertSafeRuntimeRecord(state, "dAssetTransport");
  return { job, state };
}

function currentGuard({ document, candidate, softwareJobContext, observedAt, loadCurrentProductionBinding }) {
  assertDProductionJobReference({ document, candidate, job: findSoftwareJobInDocument(document, softwareJobContext.jobId) });
  const guard = softwareJobContext.jobStore.assertDEExecutionInDocument({ document, jobId: softwareJobContext.jobId,
    workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId, observedAt });
  const binding = loadCurrentProductionBinding({ candidate: structuredClone(candidate), job: structuredClone(guard.job),
    worker: structuredClone(guard.worker), observedAt });
  if (binding && typeof binding.then === "function") throw new TypeError("OSS_D_CONFIGURATION_LOADER_MUST_BE_SYNCHRONOUS");
  assertCurrentProductionExecutionBinding({ productionAuthorization: candidate.lifecycleV11.skuPackage.productionAuthorization,
    currentProductionBinding: binding, checkedAt: observedAt });
  const snapshot = guard.admissionDecision.executionBindingSnapshot;
  if (!snapshot || !["bindingId", "configurationVersion", "warehouseId"].every(field => binding[field] === snapshot.productionBinding[field]) ||
      !["platform", "warehouseRef", "credentialAlias"].every(field => binding[field] === snapshot[field]) ||
      !isDeepStrictEqual(binding.storeRef, snapshot.storeRef) || !isDeepStrictEqual(binding.verification, snapshot.configurationEvidence)) {
    throw new Error("PRODUCTION_EXECUTION_BINDING_DRIFT: OSS服务配置与已领取作业不一致");
  }
  return guard;
}

function saveProgress(document, guard, context, observedAt, suffix, { external = false } = {}) {
  let job = bindSoftwareJobAdmissionDecision(guard.job, guard.admissionDecision);
  if (external && job.status === "claimed") job = markSoftwareJobExternalRequestStarted({ job, workerId: context.workerId,
    leaseId: context.leaseId, externalRequestRef: `d-production-request:${job.scopeBinding.authorizationFingerprint}`, serverTime: observedAt });
  job = recordDESoftwareJobProgress({ job, workerId: context.workerId, leaseId: context.leaseId,
    progressRef: `d-assets:${job.scopeBinding.authorizationFingerprint}:${suffix}`, serverTime: observedAt });
  const jobs = softwareJobsInDocument(document), index = jobs.findIndex(entry => entry.jobId === job.jobId);
  if (index < 0) throw new Error("OSS_D_SOFTWARE_JOB_REFERENCE_CONFLICT");
  jobs[index] = structuredClone(job);
}

function outcome(candidate, status = candidate.lifecycleV11.skuPackage.dAssetTransport.status) {
  return { status, candidate: structuredClone(candidate), assetTransportState: structuredClone(candidate.lifecycleV11.skuPackage.dAssetTransport), platformWrites: 0 };
}

/** Executes only the newly persisted asset intent for this exact saved D job. Construction and replay perform no I/O. */
export function createDAssetTransportSoftwareRuntime({ repository, runtimeMode, serverClock, upload,
  resolveLocalAsset, loadCurrentProductionBinding }) {
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else if (["central_test", "central_production"].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  else throw new Error("OSS_D_RUNTIME_MODE_INVALID");
  if (![serverClock, upload, resolveLocalAsset, loadCurrentProductionBinding].every(value => typeof value === "function")) {
    throw new Error("OSS_D_RUNTIME_DEPENDENCY_INVALID");
  }
  return Object.freeze({
    async run({ actor, input, softwareJobContext }) {
      assertInput(input);
      assertContext(softwareJobContext, actor);
      const admitted = await repository.transact(document => {
        const candidate = candidateIn(document, input.candidateId), sku = candidate.lifecycleV11.skuPackage;
        if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2") throw new Error("OSS_D_SAVED_HANDOFF_REQUIRED");
        if (sku.dAssetTransport !== null && sku.dAssetTransport !== undefined) {
          assertSavedHolder({ document, candidate, input, softwareJobContext });
          return { changed: false, result: outcome(candidate, "idempotent_replay") };
        }
        if (candidate.dataRevision !== input.expectedCandidateRevision || sku.dSoftwareExecution) throw new Error("OSS_D_REVISION_CONFLICT");
        const observedAt = observedTime(serverClock);
        const guard = currentGuard({ document, candidate, softwareJobContext, observedAt, loadCurrentProductionBinding });
        if (guard.job.revision !== input.expectedCandidateRevision || guard.job.status !== "claimed" || guard.job.externalRequestState !== "not_sent") {
          throw new Error("OSS_D_REVISION_CONFLICT");
        }
        const softwareJobRef = softwareReference(guard.job, softwareJobContext);
        const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: input.expectedCandidateRevision,
          softwareJobRef, startedAt: observedAt });
        const persistedIntent = markAliyunOssAssetIntentPersisted({ intent, persistedAt: observedAt,
          persistedCandidateRevision: input.expectedCandidateRevision + 1 });
        sku.dAssetTransport = { schemaVersion: "aliyun-oss-d-asset-state-v1", status: "in_flight", executionRevision: 1,
          intent: structuredClone(persistedIntent), assetTransport: null, automaticRetry: false, platformWrites: 0, softwareJobRef };
        candidate.dataRevision += 1; candidate.updatedAt = observedAt;
        saveProgress(document, guard, softwareJobContext, observedAt, "intent_persisted");
        assertSafeRuntimeRecord(sku.dAssetTransport, "dAssetTransport");
        return { changed: true, document, result: outcome(candidate, "admitted") };
      });
      if (admitted.status === "idempotent_replay") return admitted;
      const persistedIntent = admitted.assetTransportState.intent;
      const result = await executeAliyunOssAssetIntent({ persistedIntent, candidate: admitted.candidate, upload,
        resolveLocalAsset: asset => resolveLocalAsset(asset, { candidate: admitted.candidate }), serverClock,
        softwareJobRef: admitted.assetTransportState.softwareJobRef,
        beforePublicWrite: asset => repository.transact(document => {
          const candidate = candidateIn(document, input.candidateId);
          const { state } = assertSavedHolder({ document, candidate, input, softwareJobContext });
          if (state.status !== "in_flight" || !isDeepStrictEqual(state.intent, persistedIntent)) throw new Error("OSS_D_SOFTWARE_JOB_REFERENCE_CONFLICT");
          const observedAt = observedTime(serverClock);
          const guard = currentGuard({ document, candidate, softwareJobContext, observedAt, loadCurrentProductionBinding });
          saveProgress(document, guard, softwareJobContext, observedAt, `public_write:${asset.order}`, { external: true });
          return { changed: true, document, result: null };
        }) });
      return repository.transact(document => {
        const candidate = candidateIn(document, input.candidateId);
        const { job } = assertSavedHolder({ document, candidate, input, softwareJobContext });
        const observedAt = observedTime(serverClock);
        const settled = settleAliyunOssAssetIntent({ candidate, persistedIntent, result, settledAt: observedAt });
        candidate.lifecycleV11.skuPackage.dAssetTransport = settled.lifecycleV11.skuPackage.dAssetTransport;
        if (job.status === "unknown_outcome") {
          candidate.lifecycleV11.skuPackage.dAssetTransport.continuationBlocked = true;
          candidate.lifecycleV11.skuPackage.dAssetTransport.blockReason = "software_job_reconciliation_required";
        }
        candidate.dataRevision += 1; candidate.updatedAt = observedAt;
        settleDAssetTransportJobInDocument({ document, candidate, jobId: softwareJobContext.jobId,
          workerId: softwareJobContext.workerId, leaseId: softwareJobContext.leaseId, observedAt });
        return { changed: true, document, result: outcome(candidate) };
      });
    }
  });
}
