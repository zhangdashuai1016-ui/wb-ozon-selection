import { createSeerfarKeywordProviderAdapter } from "./keyword-evidence-provider-adapter.mjs";
import { prepareC1FactKeywordRuntime } from "./c1-fact-keyword-runtime.mjs";
import { executeSoftwareJobSettlementMutation } from "./business-mutation-transaction.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_PROVIDER,
  createSoftwareJobResultEnvelope
} from "./software-job-contract.mjs";

export const KEYWORD_EVIDENCE_SOFTWARE_RUNNER_VERSION = "keyword-evidence-software-runner-v1";

const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoSecrets(value, path = "softwareJob") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`KEYWORD_SOFTWARE_JOB_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function iso(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`KEYWORD_SOFTWARE_JOB_CLOCK_INVALID:${label}`);
  return new Date(normalized).toISOString();
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

export async function runKeywordEvidenceSoftwareJob(
  _input,
  _options = {}
) {
  throw new Error("KEYWORD_SOFTWARE_JOB_LEGACY_RUNNER_RETIRED: 请通过generic SoftwareJobStore worker执行C1付费关键词作业");
}

function assertGenericC1PaidKeywordJob(job) {
  if (!isObject(job) || job.schemaVersion !== "software-job-v1" ||
      job.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      !isObject(job.scopeBinding) ||
      job.scopeBinding.sideEffectScope !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE ||
      job.scopeBinding.provider !== C1_PAID_KEYWORD_PROVIDER ||
      job.externalRequestState !== "not_sent") {
    throw new Error("C1_PAID_KEYWORD_WORKER_JOB_INVALID");
  }
  return job.scopeBinding;
}

async function readGenericC1PaidKeywordWorkerContext({ repository, job }) {
  const scope = assertGenericC1PaidKeywordJob(job);
  if (!repository || typeof repository.readSnapshot !== "function") throw new Error("C1_PAID_KEYWORD_WORKER_REPOSITORY_REQUIRED");
  const document = await repository.readSnapshot();
  const candidate = document.candidates?.find((entry) => entry.id === job.candidateId);
  const lifecycle = candidate?.lifecycleV11;
  const skuPackage = lifecycle?.skuPackage;
  const jobRef = lifecycle?.c1PaidKeywordEvidenceJobRefV1;
  const inputArtifactRef = lifecycle?.c1PaidKeywordEvidenceInputArtifactRefV1;
  const runtimeInput = lifecycle?.c1PaidKeywordEvidenceRuntimeInputV1;
  const seerfarRequest = lifecycle?.c1PaidKeywordEvidenceSeerfarRequestV1;
  if (!candidate || Number(candidate.dataRevision) !== job.revision ||
      !isObject(skuPackage) || skuPackage.skuPackageId !== job.skuPackageId ||
      !isObject(jobRef) || jobRef.jobId !== job.jobId || jobRef.jobType !== job.jobType ||
      jobRef.candidateId !== job.candidateId || jobRef.skuPackageId !== job.skuPackageId ||
      jobRef.sourceRevision !== scope.sourceRevision || jobRef.resultRevision !== job.revision ||
      jobRef.inputFingerprint !== scope.inputFingerprint ||
      !isObject(inputArtifactRef) || inputArtifactRef.schemaVersion !== "c1-paid-keyword-evidence-input-artifact-ref-v1" ||
      inputArtifactRef.immutable !== true ||
      inputArtifactRef.jobId !== job.jobId || inputArtifactRef.jobType !== job.jobType ||
      inputArtifactRef.candidateId !== job.candidateId || inputArtifactRef.skuPackageId !== job.skuPackageId ||
      inputArtifactRef.sourceRevision !== scope.sourceRevision || inputArtifactRef.resultRevision !== job.revision ||
      inputArtifactRef.runtimeInputFingerprint !== scope.runtimeInputFingerprint ||
      inputArtifactRef.seerfarRequestFingerprint !== scope.seerfarRequestFingerprint ||
      !isObject(runtimeInput) || !isObject(seerfarRequest)) {
    throw new Error("C1_PAID_KEYWORD_WORKER_SCOPE_DRIFT");
  }
  if (fingerprintCanonicalRecord(runtimeInput) !== scope.runtimeInputFingerprint ||
      fingerprintCanonicalRecord(seerfarRequest) !== scope.seerfarRequestFingerprint) {
    throw new Error("C1_PAID_KEYWORD_WORKER_SCOPE_DRIFT");
  }
  assertNoSecrets({ jobRef, inputArtifactRef, runtimeInput, seerfarRequest }, "genericC1PaidKeywordWorker.context");
  return {
    candidate: structuredClone(candidate),
    skuPackage: structuredClone(skuPackage),
    runtimeInput: structuredClone(runtimeInput),
    seerfarRequest: structuredClone(seerfarRequest),
    scope: structuredClone(scope)
  };
}

function keywordWorkerActor(worker, observedAt) {
  return createActorContext({
    userId: worker.workerId,
    sessionId: `session:${worker.workerId}`,
    actorType: "worker",
    roles: ["operator"],
    source: "worker",
    authenticatedAt: observedAt
  });
}

function externalFailureDisposition(receipt) {
  const attempt = receipt.attempt;
  const definiteRejection = ["login_required", "quota_or_rate_limit"].includes(attempt.failureClass) &&
    attempt.failureStage !== "quota_after";
  return {
    status: definiteRejection ? "failed" : "unknown_outcome",
    externalRequestState: definiteRejection ? "failed" : "unknown_outcome",
    failureClass: `c1-paid-keyword-${attempt.failureClass.replaceAll("_", "-")}`
  };
}

async function settleC1PaidKeywordWorkerFailure({
  repository,
  worker,
  waitingJob,
  leaseId,
  serverClock,
  serverTime,
  context,
  disposition
}) {
  const { status, externalRequestState, failureClass } = disposition;
  return executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: keywordWorkerActor(worker, waitingJob.lastProgressAt),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: waitingJob.candidateId,
    skuPackageId: waitingJob.skuPackageId,
    expectedRevision: waitingJob.revision,
    idempotencyKey: `settle-failed:${waitingJob.idempotencyKey}`,
    inputFingerprint: fingerprintCanonicalRecord({
      jobId: waitingJob.jobId,
      externalRequestRef: waitingJob.externalRequestRef,
      externalRequestState,
      failureClass
    }),
    auditEventId: `audit:settle-failed:${waitingJob.jobId}`,
    authorizationRef: context.scope.authorizationRef,
    serverTime,
    serverClock,
    settlement: {
      jobId: waitingJob.jobId,
      workerId: worker.workerId,
      leaseId,
      status,
      externalRequestState,
      resultRef: null,
      resultEnvelope: null,
      failureClass,
      externalRequestRef: waitingJob.externalRequestRef
    },
    expectedJobScopeBinding: context.scope
  });
}

export async function runNextC1PaidKeywordEvidenceSoftwareJob({
  repository,
  softwareJobStore,
  worker,
  leaseId,
  leaseDurationMs = 60_000,
  openApiTransport,
  serverClock = null,
  serverTime = null
}, options = {}) {
  if (!softwareJobStore || typeof softwareJobStore.listAssignable !== "function") {
    throw new Error("C1_PAID_KEYWORD_WORKER_STORE_REQUIRED");
  }
  const assignable = await softwareJobStore.listAssignable({ worker, limit: 1, jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE });
  const nextJob = assignable.find((entry) => entry.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE);
  if (!nextJob) {
    return freeze({
      schemaVersion: "c1-paid-keyword-worker-dispatch-result-v1",
      status: "idle",
      jobId: null,
      externalRequests: 0,
      productionAuthorizationCreated: false,
      dHandoffCreated: false,
      productionPlanCreated: false,
      executionIntentCreated: false,
      platformWrites: 0
    });
  }
  return runC1PaidKeywordEvidenceSoftwareJob({
    repository,
    softwareJobStore,
    worker,
    jobId: nextJob.jobId,
    leaseId,
    leaseDurationMs,
    openApiTransport,
    serverClock,
    serverTime
  }, options);
}

export async function runC1PaidKeywordEvidenceSoftwareJob({
  repository,
  softwareJobStore,
  worker,
  jobId,
  leaseId,
  leaseDurationMs = 60_000,
  openApiTransport,
  serverClock = null,
  serverTime = null
}, { prepareRuntime = prepareC1FactKeywordRuntime } = {}) {
  if (!softwareJobStore || typeof softwareJobStore.get !== "function" ||
      typeof softwareJobStore.claim !== "function" || typeof softwareJobStore.markExternalRequestStarted !== "function") {
    throw new Error("C1_PAID_KEYWORD_WORKER_STORE_REQUIRED");
  }
  if (typeof openApiTransport !== "function") throw new Error("C1_PAID_KEYWORD_WORKER_TRANSPORT_MISSING");
  if (typeof serverClock !== "function") throw new Error("C1_PAID_KEYWORD_WORKER_CLOCK_REQUIRED");
  const queuedJob = await softwareJobStore.get(jobId);
  const context = await readGenericC1PaidKeywordWorkerContext({ repository, job: queuedJob });
  const claimed = await softwareJobStore.claim({ jobId, worker, leaseId, leaseDurationMs });
  if (claimed.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) throw new Error("C1_PAID_KEYWORD_WORKER_JOB_INVALID");
  const externalRequestRef = `request:c1-paid-keyword:${context.scope.seerfarRequestFingerprint.slice(0, 32)}`;
  const waitingJob = await softwareJobStore.markExternalRequestStarted({
    jobId,
    workerId: worker.workerId,
    leaseId,
    externalRequestRef
  });
  let seerfarReceipt;
  try {
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
    seerfarReceipt = await adapter.providers.seerfarApi({
      attemptLimit: 1,
      input: {
        identity: {
          candidateId: waitingJob.candidateId,
          skuPackageId: waitingJob.skuPackageId,
          dataRevision: waitingJob.revision
        },
        platform: context.scope.platform,
        exactSku: context.scope.supplierSkuId,
        fulfillment: context.runtimeInput.keywordSourceEvidence.fulfillment,
        locale: context.runtimeInput.keywordSourceEvidence.locale,
        seerfarRequest: structuredClone(context.seerfarRequest)
      }
    });
  } catch {
    return settleC1PaidKeywordWorkerFailure({
      repository, worker, waitingJob, leaseId, serverClock, serverTime, context,
      disposition: {
        status: "unknown_outcome",
        externalRequestState: "unknown_outcome",
        failureClass: "c1-paid-keyword-external-outcome-unknown"
      }
    });
  }
  if (seerfarReceipt.attempt.status !== "completed") {
    return settleC1PaidKeywordWorkerFailure({
      repository, worker, waitingJob, leaseId, serverClock, serverTime, context,
      disposition: externalFailureDisposition(seerfarReceipt)
    });
  }
  const runtimeInput = structuredClone(context.runtimeInput);
  let resultRef;
  let resultEnvelope;
  try {
    runtimeInput.providerEvidence.seerfarApiReceipt = structuredClone(seerfarReceipt);
    const prepared = await prepareRuntime({
      candidateId: waitingJob.candidateId,
      skuPackage: context.skuPackage,
      input: runtimeInput,
      preparedAt: waitingJob.lastProgressAt,
      existingEvidence: null
    });
    if (prepared?.result?.status !== "ready_for_atomic_persist") {
      throw new Error("C1_PAID_KEYWORD_WORKER_RESULT_NOT_READY");
    }
    const payload = {
      schemaVersion: "c1-paid-keyword-evidence-worker-result-v1",
      prepared,
      providerReceipt: structuredClone(seerfarReceipt),
      triggerReceipt: null
    };
    resultRef = `receipt:c1-paid-keyword:${fingerprintCanonicalRecord({
      jobId: waitingJob.jobId,
      runtimeInputFingerprint: fingerprintCanonicalRecord(runtimeInput),
      providerEvidenceRef: seerfarReceipt.providerEvidence?.evidenceRef ?? null
    }).slice(0, 32)}`;
    resultEnvelope = createSoftwareJobResultEnvelope({
      job: waitingJob,
      resultRef,
      payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      payload,
      recordedAt: iso(prepared.receipt?.completedAt, "runtimeReceipt.completedAt"),
      applicationDisposition: "applied"
    });
  } catch {
    return settleC1PaidKeywordWorkerFailure({
      repository,
      worker,
      waitingJob,
      leaseId,
      serverClock,
      serverTime,
      context,
      disposition: {
        status: "failed",
        externalRequestState: "succeeded",
        failureClass: "c1-paid-keyword-local-preparation-failed"
      }
    });
  }
  return executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode: "local_development",
    actor: keywordWorkerActor(worker, waitingJob.lastProgressAt),
    requiredRoles: ["operator"],
    action: "settle_c1_paid_keyword_evidence",
    candidateId: waitingJob.candidateId,
    skuPackageId: waitingJob.skuPackageId,
    expectedRevision: waitingJob.revision,
    idempotencyKey: `settle:${waitingJob.idempotencyKey}`,
    inputFingerprint: fingerprintCanonicalRecord({
      jobId: waitingJob.jobId,
      resultRef,
      payloadFingerprint: resultEnvelope.payloadFingerprint
    }),
    auditEventId: `audit:settle:${waitingJob.jobId}`,
    authorizationRef: context.scope.authorizationRef,
    serverTime,
    serverClock,
    settlement: {
      jobId: waitingJob.jobId,
      workerId: worker.workerId,
      leaseId,
      status: "completed",
      externalRequestState: "succeeded",
      resultRef,
      resultEnvelope,
      failureClass: null,
      externalRequestRef
    },
    expectedJobScopeBinding: context.scope
  });
}
