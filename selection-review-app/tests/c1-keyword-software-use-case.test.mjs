import assert from "node:assert/strict";
import test from "node:test";

import {
  C1_KEYWORD_SOFTWARE_EXECUTION_PREPARATION_VERSION,
  enqueueC1PaidKeywordEvidenceJob,
  prepareC1KeywordSoftwareExecution,
  reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument
} from "../lib/c1-keyword-software-use-case.mjs";
import { produceC1KeywordPlanningEvidence } from "../lib/c1-keyword-planning-evidence-producer.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentActor, createActorContext } from "../lib/runtime-identity.mjs";
import { C1_PAID_KEYWORD_EVIDENCE_CAPABILITY, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE, C1_PAID_KEYWORD_POINTS, C1_PAID_KEYWORD_PROVIDER } from "../lib/software-job-contract.mjs";
import { KEYWORD_NOW, keywordPlanningCandidate, keywordPlanningSourceEvidence } from "./fixtures/c1-keyword-planning-fixture.mjs";

const NOW = "2026-08-24T12:00:00.000Z";

function candidate(revision = 8) {
  return {
    id: "CX-MUSIC-USE-CASE",
    dataRevision: revision,
    lifecycleV11: {
      skuPackage: {
        candidateId: "CX-MUSIC-USE-CASE",
        skuPackageId: "sku:music:use-case",
        businessPhase: "C1"
      }
    }
  };
}

function plan(status) {
  const common = {
    schemaVersion: "c1-keyword-software-job-plan-v1",
    status,
    readinessClass: status === "not_ready" ? "blocked" : "ready",
    candidateId: "CX-MUSIC-USE-CASE",
    sourceCandidateRevision: 8,
    skuPackageId: "sku:music:use-case",
    sourceSkuRevision: null,
    mode: null,
    bindings: null,
    gaps: status === "not_ready" ? [{ code: "keyword_planning_evidence_missing", field: "planning", message: "缺少冻结证据" }] : [],
    job: null,
    reusableSnapshot: null,
    executionPolicy: {
      provider: "none",
      attemptLimit: 0,
      automaticRetries: 0,
      browserFallbackAllowed: false,
      codexDispatchAllowed: false,
      c2Started: false,
      dStarted: false,
      eStarted: false
    },
    plannedAt: NOW,
    planFingerprint: "a".repeat(64),
    runtimeInputTemplate: null,
    seerfarRequest: null
  };
  if (status === "reuse_ready") {
    common.mode = "reuse_existing_evidence";
    common.runtimeInputTemplate = { schemaVersion: "c1-fact-keyword-runtime-input-v1", dataRevision: 8 };
  }
  if (status === "ready") {
    common.mode = "seerfar_open_api_once";
    common.executionPolicy.provider = "seerfar_open_api";
    common.executionPolicy.attemptLimit = 1;
    common.runtimeInputTemplate = { schemaVersion: "c1-fact-keyword-runtime-input-v1", dataRevision: 9 };
    common.seerfarRequest = { operation: "reverse_keywords", skuIds: ["900001", "900002", "900003"] };
    common.job = {
      schemaVersion: "c1-paid-keyword-evidence-software-job-plan-v1",
      jobId: "keyword-job:music:8",
      jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
      candidateId: common.candidateId,
      skuPackageId: common.skuPackageId,
      sourceRevision: 8,
      resultRevision: 9,
      platform: "ozon",
      targetStore: "dandanshu",
      supplierSkuId: "MUSIC-WHITE",
      variantKey: "white",
      provider: C1_PAID_KEYWORD_PROVIDER,
      requiredCapabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
      idempotencyKey: "c1-paid-keyword:music:8",
      scopeBinding: {
        schemaVersion: "software-job-scope-v1",
        candidateId: common.candidateId,
        skuPackageId: common.skuPackageId,
        sourceRevision: 8,
        resultRevision: 9,
        platform: "ozon",
        targetStore: "dandanshu",
        supplierSkuId: "MUSIC-WHITE",
        variantKey: "white",
        sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
        authorizationRef: "c1-paid-keyword-authz-fixture",
        credentialAlias: "seerfar-open-api-alias-ozon-dandanshu",
        inputFingerprint: "b".repeat(64),
        planningEvidenceFingerprint: "c".repeat(64),
        runtimeInputFingerprint: "d".repeat(64),
        seerfarRequestFingerprint: "e".repeat(64),
        salesSnapshotFingerprint: "f".repeat(64),
        supplySnapshotFingerprint: "1".repeat(64),
        profitModelFingerprint: "2".repeat(64),
        c1FactsFingerprint: "3".repeat(64),
        pointBudgetEvidenceRef: "config:seerfar-budget-15",
        quotaEvidenceRef: "seerfar-quota:80",
        pointsAuthorized: C1_PAID_KEYWORD_POINTS,
        provider: C1_PAID_KEYWORD_PROVIDER
      },
      runtimeInputTemplate: structuredClone(common.runtimeInputTemplate),
      seerfarRequest: structuredClone(common.seerfarRequest),
      runtimeInputFingerprint: "d".repeat(64),
      seerfarRequestFingerprint: "e".repeat(64)
    };
  }
  return common;
}

test("not_ready只返回精确缺口，不创建意图或外部调用", () => {
  let intentCalls = 0;
  const result = prepareC1KeywordSoftwareExecution(
    { candidate: candidate(), clientInput: { dataRevision: 8 }, plannedAt: NOW },
    {
      buildPlan: () => plan("not_ready"),
      createJobIntent: () => { intentCalls += 1; throw new Error("不应调用"); }
    }
  );
  assert.equal(result.schemaVersion, C1_KEYWORD_SOFTWARE_EXECUTION_PREPARATION_VERSION);
  assert.deepEqual([result.status, result.executionKind, result.providerCallsPlanned, intentCalls], ["not_ready", "none", 0, 0]);
  assert.equal(result.gaps[0].code, "keyword_planning_evidence_missing");
  assert.deepEqual(Object.values(result.sideEffects), [0, 0, 0, 0, false, false, false]);
});

test("真实规划器在尚无C1生命周期包时返回not_ready而不是伪造执行上下文", () => {
  const value = { id: "CX-NO-C1", dataRevision: 4 };
  const result = prepareC1KeywordSoftwareExecution({
    candidate: value,
    clientInput: { dataRevision: 4 },
    plannedAt: NOW
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.skuPackageId, null);
  assert.equal(result.gaps[0].code, "c1_sku_package_missing");
  assert.equal(result.providerCallsPlanned, 0);
});

test("reuse_ready保留服务端运行输入且不创建付费作业意图", () => {
  let intentCalls = 0;
  const result = prepareC1KeywordSoftwareExecution(
    { candidate: candidate(), clientInput: { dataRevision: 8 }, plannedAt: NOW },
    {
      buildPlan: () => plan("reuse_ready"),
      createJobIntent: () => { intentCalls += 1; throw new Error("不应调用"); }
    }
  );
  assert.deepEqual([result.status, result.executionKind, result.providerCallsPlanned, intentCalls], ["reuse_ready", "reuse_existing_evidence", 0, 0]);
  assert.equal(result.reuseInput.dataRevision, 8);
  assert.equal(result.jobIntent, null);
  assert.equal(result.runnerJob, null);
});

test("ready只生成generic SoftwareJob输入，不再创建旧runner或候选内意图", () => {
  const value = candidate();
  const before = structuredClone(value);
  const result = prepareC1KeywordSoftwareExecution(
    { candidate: value, clientInput: { dataRevision: 8 }, plannedAt: NOW },
    { buildPlan: () => plan("ready") }
  );
  assert.deepEqual([result.status, result.executionKind, result.providerCallsPlanned], ["ready", "seerfar_open_api_once", 1]);
  assert.equal(result.jobIntent, null);
  assert.equal(result.runnerJob, null);
  assert.deepEqual([result.softwareJobInput.jobType, result.softwareJobInput.revision], [C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE, 9]);
  assert.deepEqual(result.softwareJobInput.requiredCapabilities, [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY]);
  assert.equal(result.softwareJobInput.scopeBinding.provider, C1_PAID_KEYWORD_PROVIDER);
  assert.equal(result.jobRuntimeInput.dataRevision, 9);
  assert.equal(result.seerfarRequest.operation, "reverse_keywords");
  assert.deepEqual(value, before);
  assert.equal(Object.isFrozen(result), true);
});

test("客户端字段、revision、计划身份和执行策略不精确时立即拒绝", () => {
  const value = candidate();
  assert.throws(() => prepareC1KeywordSoftwareExecution({ candidate: value, clientInput: { dataRevision: 8, seerfarRequest: {} }, plannedAt: NOW }), /CLIENT_INPUT_REJECTED/);
  assert.throws(() => prepareC1KeywordSoftwareExecution({ candidate: value, clientInput: { dataRevision: 7 }, plannedAt: NOW }), /REVISION_CONFLICT/);
  assert.throws(() => prepareC1KeywordSoftwareExecution(
    { candidate: value, clientInput: { dataRevision: 8 }, plannedAt: NOW },
    { buildPlan: () => ({ ...plan("not_ready"), candidateId: "CX-OTHER" }) }
  ), /PLAN_SCOPE_DRIFT/);
  const unsafeReuse = plan("reuse_ready");
  unsafeReuse.seerfarRequest = { operation: "reverse_keywords" };
  assert.throws(() => prepareC1KeywordSoftwareExecution(
    { candidate: value, clientInput: { dataRevision: 8 }, plannedAt: NOW },
    { buildPlan: () => unsafeReuse }
  ), /REUSE_PLAN_INVALID/);
});

test("旧局部in_flight作业必须先迁移为unknown，不允许和generic job并存执行", () => {
  const value = candidate();
  value.lifecycleV11.keywordEvidenceSoftwareJobV1 = { status: "in_flight", sourceRevision: 8 };
  assert.throws(() => prepareC1KeywordSoftwareExecution(
    { candidate: value, clientInput: { dataRevision: 8 }, plannedAt: NOW },
    { buildPlan: () => plan("ready") }
  ), /LEGACY_JOB_IN_FLIGHT/);
});

test("旧局部in_flight作业重启收口为unknown_outcome且不创建generic job", () => {
  const document = {
    candidates: [{
      ...candidate(),
      lifecycleV11: {
        ...candidate().lifecycleV11,
        keywordEvidenceSoftwareJobV1: {
          schemaVersion: "keyword-evidence-software-runner-v1",
          jobId: "legacy-keyword-job:music:8",
          status: "in_flight",
          retryAllowed: true
        }
      }
    }],
    runtime: { softwareJobs: [] }
  };
  const result = reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument({
    document,
    restartedAt: KEYWORD_NOW
  });
  assert.equal(result.changed, true);
  assert.equal(document.candidates[0].lifecycleV11.keywordEvidenceSoftwareJobV1.status, "unknown_outcome");
  assert.equal(document.candidates[0].lifecycleV11.keywordEvidenceSoftwareJobV1.retryAllowed, false);
  assert.equal(document.candidates[0].lifecycleV11.keywordEvidenceSoftwareJobV1.failureClass, "legacy_keyword_software_job_unknown_after_restart");
  assert.equal(document.candidates[0].dataRevision, 9);
  assert.deepEqual(document.runtime.softwareJobs, []);
  const after = structuredClone(document);
  const replay = reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument({ document, restartedAt: "2026-08-26T12:00:00.000Z" });
  assert.equal(replay.changed, false);
  assert.deepEqual(document, after);
});

function c1ReadyCandidate() {
  const value = keywordPlanningCandidate();
  const produced = produceC1KeywordPlanningEvidence({
    candidate: value,
    expectedRevision: value.dataRevision,
    serverEvidence: keywordPlanningSourceEvidence(),
    producedAt: KEYWORD_NOW
  });
  assert.equal(produced.status, "ready");
  const ready = structuredClone(value);
  ready.dataRevision = produced.evidence.binding.candidateRevision;
  ready.lifecycleV11.skuPackage = structuredClone(produced.skuPackage);
  ready.lifecycleV11.c1KeywordPlanningEvidenceV1 = structuredClone(produced.evidence);
  return ready;
}

function c1Actor() {
  return createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:c1-paid-keyword" });
}

test("legacy unknown阻断真实planner入队，不创建job、授权或凭据绑定", async () => {
  const value = c1ReadyCandidate();
  value.lifecycleV11.keywordEvidenceSoftwareJobV1 = { status: "unknown_outcome", sourceRevision: 1, retryAllowed: false };
  const repository = createMemoryBusinessStateRepository({ candidates: [value], runtime: { softwareJobs: [] } });
  const before = await repository.readSnapshot();
  await assert.rejects(enqueueC1PaidKeywordEvidenceJob({ repository, runtimeMode: "local_development", actor: c1Actor(), candidateId: value.id,
    expectedRevision: value.dataRevision, clientInput: { dataRevision: value.dataRevision }, serverTime: KEYWORD_NOW }), /LEGACY_JOB_UNKNOWN_OUTCOME/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

function authorizationRecord(scope) {
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: scope.authorizationRef,
    status: "active",
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
    candidateId: scope.candidateId,
    skuPackageId: scope.skuPackageId,
    sourceRevision: scope.sourceRevision,
    resultRevision: scope.resultRevision,
    platform: scope.platform,
    targetStore: scope.targetStore,
    supplierSkuId: scope.supplierSkuId,
    variantKey: scope.variantKey,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    provider: C1_PAID_KEYWORD_PROVIDER,
    credentialAlias: scope.credentialAlias,
    inputFingerprint: scope.inputFingerprint,
    planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
    runtimeInputFingerprint: scope.runtimeInputFingerprint,
    seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
    salesSnapshotFingerprint: scope.salesSnapshotFingerprint,
    supplySnapshotFingerprint: scope.supplySnapshotFingerprint,
    profitModelFingerprint: scope.profitModelFingerprint,
    c1FactsFingerprint: scope.c1FactsFingerprint,
    pointBudgetEvidenceRef: scope.pointBudgetEvidenceRef,
    quotaEvidenceRef: scope.quotaEvidenceRef,
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    authorizedByUserId: "owner-1",
    authorizedAt: KEYWORD_NOW,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
}

function credentialBinding(scope) {
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:seerfar-open-api:dandanshu",
    credentialAlias: scope.credentialAlias,
    status: "active",
    provider: C1_PAID_KEYWORD_PROVIDER,
    platform: scope.platform,
    targetStore: scope.targetStore,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: scope.candidateId,
    skuPackageId: scope.skuPackageId,
    sourceRevision: scope.sourceRevision,
    resultRevision: scope.resultRevision,
    inputFingerprint: scope.inputFingerprint,
    planningEvidenceFingerprint: scope.planningEvidenceFingerprint,
    runtimeInputFingerprint: scope.runtimeInputFingerprint,
    seerfarRequestFingerprint: scope.seerfarRequestFingerprint,
    allowedWorkerIds: ["worker-seerfar-open-api-1"],
    redaction: "credential_alias_only",
    boundAt: KEYWORD_NOW,
    expiresAt: null
  };
}

test("C1 paid keyword enqueue在同一事务写候选jobRef、generic job、授权消耗和零下游", async () => {
  const candidate = c1ReadyCandidate();
  const preparation = prepareC1KeywordSoftwareExecution({
    candidate,
    clientInput: { dataRevision: candidate.dataRevision },
    plannedAt: KEYWORD_NOW
  });
  const repository = createMemoryBusinessStateRepository({
    candidates: [candidate],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [],
      softwareJobCredentialBindings: [],
      operationAudit: [],
      idempotencyRecords: []
    }
  });
  const result = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: c1Actor(),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  assert.equal(result.status, "committed");
  assert.equal(result.result.status, "queued");
  assert.deepEqual([
    result.result.productionAuthorizationCreated,
    result.result.dHandoffCreated,
    result.result.productionPlanCreated,
    result.result.executionIntentCreated,
    result.result.externalCallsPerformed
  ], [false, false, false, false, 0]);
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, candidate.dataRevision + 1);
  assert.equal(stored.candidates[0].lifecycleV11.keywordEvidenceSoftwareJobV1, undefined);
  assert.equal(stored.candidates[0].lifecycleV11.c1PaidKeywordEvidenceJobRefV1.jobId, preparation.softwareJobInput.jobId);
  assert.deepEqual(
    [
      stored.candidates[0].lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1.immutable,
      stored.candidates[0].lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1.runtimeInputFingerprint,
      stored.candidates[0].lifecycleV11.c1PaidKeywordEvidenceInputArtifactRefV1.seerfarRequestFingerprint
    ],
    [
      true,
      preparation.softwareJobInput.scopeBinding.runtimeInputFingerprint,
      preparation.softwareJobInput.scopeBinding.seerfarRequestFingerprint
    ]
  );
  assert.equal(stored.runtime.softwareJobs.length, 1);
  assert.equal(stored.runtime.softwareJobs[0].jobType, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE);
  assert.equal(stored.runtime.softwareJobs[0].admissionDecision.authorizationRef, preparation.softwareJobInput.scopeBinding.authorizationRef);
  assert.equal(stored.runtime.softwareJobCredentialBindings[0].credentialAlias, preparation.softwareJobInput.scopeBinding.credentialAlias);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords[0].consumedByJobId, preparation.softwareJobInput.jobId);
  assert.equal(stored.runtime.operationAudit.length, 1);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);
  const replay = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: c1Actor(),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  const replayed = await repository.readSnapshot();
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replayed.runtime.softwareJobs.length, 1);
  assert.equal(replayed.runtime.softwareJobAuthorizationRecords.length, 1);
  assert.equal(replayed.runtime.softwareJobCredentialBindings.length, 1);
  assert.equal(replayed.runtime.idempotencyRecords.length, 1);
  const replayInput = { repository, runtimeMode: "local_development", candidateId: candidate.id, expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision }, serverTime: KEYWORD_NOW };
  const reviewer = createActorContext({ userId: "reviewer-1", sessionId: "test:reviewer", actorType: "human", roles: ["reviewer"], source: "test", authenticatedAt: KEYWORD_NOW });
  await assert.rejects(enqueueC1PaidKeywordEvidenceJob({ ...replayInput, actor: reviewer }), /OPERATION_FORBIDDEN/);
  await assert.rejects(enqueueC1PaidKeywordEvidenceJob({ ...replayInput, actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-2" }) }), /REPLAY_OWNER_MISMATCH/);
  assert.deepEqual(await repository.readSnapshot(), replayed);
  for (const corruptJobs of [[], [{ ...replayed.runtime.softwareJobs[0], candidateId: "another-candidate" }],
    [replayed.runtime.softwareJobs[0], replayed.runtime.softwareJobs[0]]]) {
    const incomplete = structuredClone(replayed);
    incomplete.runtime.softwareJobs = structuredClone(corruptJobs);
    const incompleteRepository = createMemoryBusinessStateRepository(incomplete);
    await assert.rejects(enqueueC1PaidKeywordEvidenceJob({ ...replayInput, repository: incompleteRepository, actor: c1Actor() }), /HALF_STATE_REJECTED/);
    assert.deepEqual(await incompleteRepository.readSnapshot(), incomplete);
  }
});
