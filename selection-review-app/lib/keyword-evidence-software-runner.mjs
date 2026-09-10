import { createSeerfarKeywordProviderAdapter } from "./keyword-evidence-provider-adapter.mjs";
import { prepareC1FactKeywordRuntime } from "./c1-fact-keyword-runtime.mjs";
import { executeSoftwareJobSettlementMutation } from "./business-mutation-transaction.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { createActorContext } from "./runtime-identity.mjs";
import { C1PaidKeywordExecutionBlockedError } from './software-job-repository.mjs';
import { SeerfarTransportError } from './seerfar-open-api-transport.mjs';
import { createSoftwareExecutionRuntime, openExceptionCase } from './software-execution-state.mjs';
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

export async function runNextC1PaidKeywordEvidenceSoftwareJob({
  repository,
  softwareJobStore,
  worker,
  leaseId,
  leaseDurationMs = 60_000,
  openApiTransport,
  createTransport = null,
  signal = null,
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
    createTransport,
    signal,
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
  createTransport = null,
  signal = null,
  serverClock = null,
  serverTime = null
}, { prepareRuntime = prepareC1FactKeywordRuntime } = {}) {
  if (!softwareJobStore || typeof softwareJobStore.get !== "function" ||
      typeof softwareJobStore.claim !== "function" || typeof softwareJobStore.markExternalRequestStarted !== "function") {
    throw new Error("C1_PAID_KEYWORD_WORKER_STORE_REQUIRED");
  }
  if (typeof openApiTransport !== "function" && typeof createTransport !== 'function') throw new Error("C1_PAID_KEYWORD_WORKER_TRANSPORT_MISSING");
  if (typeof serverClock !== "function") throw new Error("C1_PAID_KEYWORD_WORKER_CLOCK_REQUIRED");
  const queuedJob = await softwareJobStore.get(jobId);
  const context = await readGenericC1PaidKeywordWorkerContext({ repository, job: queuedJob });
  const claimed = await softwareJobStore.claim({ jobId, worker, leaseId, leaseDurationMs });
  if (claimed.jobType !== C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE) throw new Error("C1_PAID_KEYWORD_WORKER_JOB_INVALID");
  const externalRequestRef = `request:c1-paid-keyword:${context.scope.seerfarRequestFingerprint.slice(0, 32)}`;
  let waitingJob = claimed, requestSent = false;
  async function checkCurrent(){return repository.transact(document=>{
    if(signal?.aborted)throw new C1PaidKeywordExecutionBlockedError('C1_PAID_KEYWORD_CANCELLED');
    const result=softwareJobStore.assertC1PaidKeywordExecutionInDocument({document,jobId,workerId:worker.workerId,leaseId,observedAt:serverClock()});
    return {changed:false,result};
  });}
  async function beforeRequestSend(){
    await checkCurrent();
    if(!requestSent)waitingJob=await softwareJobStore.markExternalRequestStarted({jobId,workerId:worker.workerId,leaseId,externalRequestRef});
    await checkCurrent();requestSent=true;
  }
  async function persistFailure(error,{externalSucceeded=false,known=false,disposition=null}={}){
    return repository.transact(document=>{
      const observedAt=serverClock();
      const persisted=document.runtime.softwareJobs.find(value=>value.jobId===jobId);
      const issued=persisted.externalRequestState!=='not_sent';
      const job=softwareJobStore.settleC1PaidKeywordFailureInDocument({document,jobId,workerId:worker.workerId,leaseId,observedAt,
        status:disposition?.status ?? (externalSucceeded || !issued?'failed':'unknown_outcome'),
        externalRequestState:disposition?.externalRequestState ?? (externalSucceeded?'succeeded':issued?'unknown_outcome':'not_sent'),
        failureClass:disposition?.failureClass ?? (externalSucceeded?'c1-paid-keyword-local-preparation-failed':known?`c1-paid-keyword-${error.code.toLowerCase().replaceAll('_','-')}`:'c1-paid-keyword-system-failure')});
      if(!known){
        const candidate=document.candidates.find(value=>value.id===job.candidateId);
        const prior=candidate.executionRuntime || createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,
          businessPhase:'C1',stepId:'C1_KEYWORD_EVIDENCE',at:observedAt});
        if(prior.exceptionCase?.status!=='open')candidate.executionRuntime=openExceptionCase({...prior,businessPhase:'C1',stepId:'C1_KEYWORD_EVIDENCE'}, {
          exceptionId:`exception:c1-keyword:${jobId}`,reasonCode:'system_failure',failureLayer:'c1_keyword_evidence',
          evidenceRefs:[externalRequestRef],skuPackageId:job.skuPackageId,softwareJobId:jobId,sourceRevision:job.revision,
          lastSuccessfulStepId:externalSucceeded?'keyword_response_received':issued?'keyword_request_started':'keyword_job_claimed',
          externalRequestRefs:issued?[externalRequestRef]:[],unknownOutcome:issued&&!externalSucceeded,at:observedAt});
      }
      return {changed:true,document,result:{status:'committed',result:{status:job.status,candidateRevisionUnchanged:true,productionAuthorizationCreated:false,dHandoffCreated:false,productionPlanCreated:false,executionIntentCreated:false,platformWrites:0},job}};
    });
  }
  let seerfarReceipt;
  try {
    await checkCurrent();
    const transport=createTransport===null?openApiTransport:await createTransport({beforeRequestSend,signal});
    if(createTransport===null)await beforeRequestSend();
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport:transport });
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
  } catch(error) {
    const cancelled=signal?.aborted && error===signal.reason;
    const known=cancelled || error instanceof SeerfarTransportError || error instanceof C1PaidKeywordExecutionBlockedError;
    const outcome=await persistFailure(cancelled?new C1PaidKeywordExecutionBlockedError('C1_PAID_KEYWORD_CANCELLED'):error,{known});
    if(!known)throw error;
    return outcome;
  }
  if (seerfarReceipt.attempt.status !== "completed") {
    return persistFailure(null,{known:true,disposition:externalFailureDisposition(seerfarReceipt)});
  }
  const runtimeInput = structuredClone(context.runtimeInput);
  let resultRef;
  let resultEnvelope;
  try {
    await checkCurrent();
    runtimeInput.providerEvidence.seerfarApiReceipt = structuredClone(seerfarReceipt);
    const prepared = await prepareRuntime({
      candidateId: waitingJob.candidateId,
      skuPackage: context.skuPackage,
      input: runtimeInput,
      preparedAt: waitingJob.lastProgressAt,
      existingEvidence: null
    });
    if (prepared?.result?.status !== "ready_for_atomic_persist") return persistFailure(null,{known:true,externalSucceeded:true});
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
  } catch(error) {
    const known=error instanceof C1PaidKeywordExecutionBlockedError;
    const outcome=await persistFailure(error,{externalSucceeded:true,known});
    if(!known)throw error;
    return outcome;
  }
  try { return await executeSoftwareJobSettlementMutation({
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
  } catch(error) { await persistFailure(error,{externalSucceeded:true});throw error; }
}
