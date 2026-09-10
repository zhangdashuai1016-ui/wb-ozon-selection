import test from "node:test";
import assert from "node:assert/strict";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { c1AiSoftwareJobFixture, c1AiSoftwareJobResultEnvelope } from "./fixtures/c1-ai-software-job-fixture.mjs";
import { createSoftwareJobEnvelope, claimSoftwareJobLease, markSoftwareJobExternalRequestStarted, settleSoftwareJob,
  reconcileSoftwareJobAfterRestart, createSoftwareJobResultEnvelope, normalizeC1AiDraftScopeBinding } from "../lib/software-job-contract.mjs";
import { bindSoftwareJobAdmissionForEnqueue, assertSoftwareJobAdmittedForClaim, assertSoftwareJobAdmittedForExternalRequest,
  assertNoSoftwareJobScopeConflict, normalizeSoftwareJobScopeKey } from "../lib/software-job-admission.mjs";
import { assertSafeRuntimeRecord } from "../lib/runtime-identity.mjs";
import { createC1AiAccounting } from "../lib/c1-ai-draft-contract.mjs";

function inFlight(fixture = c1AiSoftwareJobFixture(), leaseDurationMs = 300_000) {
  const admitted = bindSoftwareJobAdmissionForEnqueue({ document: fixture.document, job: fixture.job, observedAt: fixture.at, phase: "enqueue_current" });
  const claimed = claimSoftwareJobLease({ job: admitted, worker: fixture.worker, leaseId: "lease-c1-draft", serverTime: fixture.at, leaseDurationMs });
  const job = markSoftwareJobExternalRequestStarted({ job: claimed, workerId: fixture.worker.workerId,
    leaseId: claimed.leaseId, externalRequestRef: "request:c1-draft:fixture-one", serverTime: fixture.at });
  return { ...fixture, job };
}

function settlement(fixture, overrides = {}) {
  return { job: fixture.job, workerId: fixture.worker.workerId, leaseId: fixture.job.leaseId, status: "completed",
    externalRequestState: "succeeded", serverTime: "2026-08-22T02:02:00.000Z",
    resultEnvelope: c1AiSoftwareJobResultEnvelope(fixture.job, fixture.request), ...overrides };
}

test("草稿作业分别冻结候选和SKU修订，完整G1、网关能力及一次授权不可混用", () => {
  const fixture = c1AiSoftwareJobFixture();
  assert.equal(fixture.job.revision, 12);
  assert.equal(fixture.job.scopeBinding.sourceRevision, 11);
  assert.equal(fixture.job.scopeBinding.sourceSkuRevision, fixture.request.sourceSkuRevision);
  assert.notEqual(fixture.job.revision, fixture.job.scopeBinding.sourceSkuRevision);
  assert.equal(fixture.job.scopeBinding.identity.credentialAlias, "not_applicable");
  assert.deepEqual(fixture.job.requiredCapabilities, ["ai-draft-gateway"]);
  assert.equal(Object.hasOwn(fixture.authorizationRecord, "pointsAuthorized"), false);
  for (const change of [
    scope => { delete scope.identity.storeRef.mappingVersion; },
    scope => { scope.identity.storeRef.platformStoreId = "unknown"; },
    scope => { scope.identity.candidateId = "other"; },
    scope => { scope.identity.credentialAlias = scope.credentialAlias; },
    scope => { scope.resultRevision = scope.sourceRevision; },
    scope => { scope.sourceSkuRevision = "3"; },
    scope => { scope.requestFingerprint = "b".repeat(64); },
    scope => { scope.provider = "seerfar_open_api"; },
    scope => { scope.authorizationRef = "authorization:c1-ai-draft:extra:part"; },
    scope => { scope.pointsAuthorized = 15; }
  ]) {
    const invalid = structuredClone(fixture.job.scopeBinding);
    change(invalid);
    assert.throws(() => normalizeC1AiDraftScopeBinding(invalid, fixture.job));
  }
  assert.throws(() => createSoftwareJobEnvelope({ ...fixture.job, requiredCapabilities: ["seerfar-open-api"] }), /requiredCapabilities/);
});

test("草稿准入消费一次授权，claim与发送前重查精确身份、凭据和owner", () => {
  const fixture = c1AiSoftwareJobFixture();
  const admitted = bindSoftwareJobAdmissionForEnqueue({ document: fixture.document, job: fixture.job, observedAt: fixture.at, phase: "enqueue_current" });
  assert.equal(fixture.document.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(fixture.document.runtime.softwareJobAuthorizationRecords[0].consumedByJobId, fixture.job.jobId);
  assertSoftwareJobAdmittedForClaim({ document: fixture.document, job: admitted, worker: fixture.worker, observedAt: fixture.at });
  assertSoftwareJobAdmittedForExternalRequest({ document: fixture.document, job: admitted, workerId: fixture.worker.workerId, observedAt: fixture.at });
  assert.throws(() => bindSoftwareJobAdmissionForEnqueue({ document: fixture.document, job: fixture.job, observedAt: fixture.at, phase: "enqueue_current" }), /ALREADY_CONSUMED/);
  for (const change of [
    value => { value.candidates[0].dataRevision += 1; },
    value => { value.candidates[0].storeRef.platformStoreId = "other-store"; },
    value => { value.candidates[0].storeRef.mappingVersion = "other-mapping"; },
    value => { value.candidates[0].targetStore = "miska"; },
    value => { value.candidates[0].lifecycleV11.skuPackage.dataRevision += 1; },
    value => { value.candidates[0].lifecycleV11.skuPackage.g1Identity.storeRef.platformStoreId = "different-store"; },
    value => { value.candidates[0].lifecycleV11.skuPackage.g1Identity.storeRef.mappingVersion = "new-mapping"; },
    value => { value.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status = "seo_draft_ready"; },
    value => { value.runtime.softwareJobAuthorizationRecords[0].authorizedByUserId = "other-owner"; },
    value => { value.runtime.softwareJobAuthorizationRecords[0].authorizationType = "paid_keyword"; },
    value => { value.runtime.softwareJobAuthorizationRecords[0].maxUses = 2; },
    value => { value.runtime.softwareJobAuthorizationRecords[0].scopeBinding.sourceSkuRevision += 1; },
    value => { value.runtime.softwareJobCredentialBindings[0].scopeBinding.identity.storeRef.mappingVersion = "other-version"; },
    value => { value.runtime.softwareJobCredentialBindings[0].allowedWorkerIds = ["other-worker"]; },
    value => { value.runtime.softwareJobCredentialBindings[0].provider = "seerfar_open_api"; },
    value => { value.runtime.softwareJobCredentialBindings[0].credentialAlias = "other-alias"; },
    value => { value.runtime.softwareJobCredentialBindings[0].expiresAt = fixture.at; }
  ]) {
    const invalid = structuredClone(fixture.document);
    change(invalid);
    assert.throws(() => assertSoftwareJobAdmittedForClaim({ document: invalid, job: admitted, worker: fixture.worker, observedAt: fixture.at }));
    assert.throws(() => assertSoftwareJobAdmittedForExternalRequest({ document: invalid, job: admitted, workerId: fixture.worker.workerId, observedAt: fixture.at }));
  }
});

test("草稿回执先保存而不应用候选，通用settle不能伪造applied或另一个请求", () => {
  const fixture = inFlight();
  const before = structuredClone(fixture.job);
  const completed = settleSoftwareJob(settlement(fixture));
  assert.equal(completed.status, "completed");
  assert.equal(completed.resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.equal(completed.resultEnvelope.payload.receipt.softwareJobId, fixture.job.jobId);
  assert.equal(completed.externalRequestRef, fixture.job.externalRequestRef);
  assert.deepEqual(fixture.job, before);
  assert.throws(() => settleSoftwareJob(settlement(fixture, { applicationDisposition: "applied" })), /SOFTWARE_JOB_C1_AI_RESULT_INVALID/);
  const callerApplied = { ...c1AiSoftwareJobResultEnvelope(fixture.job, fixture.request), applicationDisposition: "applied" };
  assert.throws(() => settleSoftwareJob(settlement(fixture, { resultEnvelope: callerApplied })), /SOFTWARE_JOB_C1_AI_RESULT_INVALID/);
  assert.throws(() => settleSoftwareJob(settlement({ ...fixture, job: { ...fixture.job, admissionDecision: null } })), /SOFTWARE_JOB_ADMISSION_DECISION_INVALID/);
  for (const receiptOverrides of [{ softwareJobId: "other-job" }, { attempt: 2 }, { extra: "not-published" }, { startedAt: "2026-08-22T02:03:00.000Z" }]) {
    const envelope = c1AiSoftwareJobResultEnvelope(fixture.job, fixture.request, receiptOverrides);
    assert.throws(() => settleSoftwareJob(settlement(fixture, { resultEnvelope: envelope })), /SOFTWARE_JOB_C1_AI_RESULT_INVALID/);
  }
  const payload = structuredClone(completed.resultEnvelope.payload);
  payload.request.sourceIdentity.storeRef.mappingVersion = "wrong-mapping";
  const wrongRequest = createSoftwareJobResultEnvelope({ job: fixture.job, resultRef: completed.resultRef, payloadKind: fixture.job.jobType, payload, recordedAt: completed.completedAt });
  assert.throws(() => settleSoftwareJob(settlement(fixture, { resultEnvelope: wrongRequest })), /SOFTWARE_JOB_C1_AI_RESULT_INVALID/);
  assert.throws(() => settleSoftwareJob(settlement({ ...fixture, job: completed })), /不是已领取状态/);
});

test("草稿已请求的原租约过期后仍能登记终态，不能换worker或lease、续权或倒退时间", () => {
  const fixture = inFlight(c1AiSoftwareJobFixture(), 1_000);
  const before = structuredClone(fixture.job);
  const completed = settleSoftwareJob(settlement(fixture));
  assert.equal(completed.status, "completed");
  assert.equal(completed.leaseExpiresAt, before.leaseExpiresAt);
  assert.equal(completed.attempt, 1);
  assert.deepEqual(fixture.job, before);
  assert.throws(() => settleSoftwareJob(settlement(fixture, { workerId: "other-worker" })), /Worker或租约不匹配/);
  assert.throws(() => settleSoftwareJob(settlement(fixture, { leaseId: "other-lease" })), /Worker或租约不匹配/);
  assert.throws(() => settleSoftwareJob(settlement(fixture, { serverTime: "2026-08-22T01:59:59.000Z" })), /倒退/);
  assert.throws(() => markSoftwareJobExternalRequestStarted({ job: fixture.job, workerId: fixture.worker.workerId, leaseId: fixture.job.leaseId, externalRequestRef: "request:second", serverTime: completed.completedAt }), /不能开始外部请求/);
  const unknown = settleSoftwareJob(settlement(fixture, { status: "unknown_outcome", externalRequestState: "unknown_outcome", resultEnvelope: null }));
  assert.equal(unknown.status, "unknown_outcome");
  assert.equal(unknown.automaticRetryAllowed, false);
  assert.equal(reconcileSoftwareJobAfterRestart({ job: fixture.job, serverTime: completed.completedAt }).status, "unknown_outcome");
});

test("草稿完成但尚未应用继续占用，换修订或模型不能再发同范围请求", () => {
  const fixture = inFlight();
  const completed = settleSoftwareJob(settlement(fixture));
  const later = c1AiSoftwareJobFixture({ sourceCandidateRevision: 12, jobId: "software-job:c1-draft:2", authorizationId: "authorization:c1-ai-draft:fixture-two" });
  assert.equal(normalizeSoftwareJobScopeKey(later.job), normalizeSoftwareJobScopeKey(completed));
  assert.throws(() => assertNoSoftwareJobScopeConflict({ runtime: { softwareJobs: [completed] } }, later.job), /SOFTWARE_JOB_SCOPE_CONFLICT/);
  const changedRoute = { ...later.job, scopeBinding: { ...later.job.scopeBinding, provider: "sol" } };
  assert.throws(() => assertNoSoftwareJobScopeConflict({ runtime: { softwareJobs: [completed] } }, changedRoute), /SOFTWARE_JOB_SCOPE_CONFLICT/);
  const applied = structuredClone(completed);
  applied.resultEnvelope.applicationDisposition = "applied";
  assert.doesNotThrow(() => assertNoSoftwareJobScopeConflict({ runtime: { softwareJobs: [applied] } }, later.job));
});

test("草稿验收失败保留同一次请求真实耗用，外部成功仍占用且不能声明applied", () => {
  const fixture = inFlight();
  const payload = { schemaVersion: "c1-ai-draft-software-failure-v1", request: fixture.request,
    accounting: createC1AiAccounting({ gatewayJobId: "gateway-job:rejected:1", providerRequestId: "provider-call:1", usage: { total_tokens: 250 } }),
    errorCode: "C1_AI_GATEWAY_RECEIPT_REJECTED" };
  const resultEnvelope = createSoftwareJobResultEnvelope({ job: fixture.job, resultRef: "gateway-job:rejected:1", payloadKind: "c1_ai_draft",
    payload, recordedAt: "2026-08-22T02:02:00.000Z" });
  const failed = settleSoftwareJob(settlement(fixture, { status: "failed", externalRequestState: "succeeded", failureClass: payload.errorCode, resultEnvelope }));
  assert.equal(failed.externalRequestState, "succeeded");
  assert.deepEqual(failed.resultEnvelope.payload.accounting.usage, { total_tokens: 250 });
  const later = c1AiSoftwareJobFixture({ sourceCandidateRevision: 12, jobId: "software-job:another:1", authorizationId: "authorization:c1-ai-draft:another" });
  assert.throws(() => assertNoSoftwareJobScopeConflict({ runtime: { softwareJobs: [failed] } }, later.job), /SOFTWARE_JOB_SCOPE_CONFLICT/);
  assert.throws(() => settleSoftwareJob(settlement(fixture, { status: "failed", externalRequestState: "succeeded", failureClass: payload.errorCode,
    resultEnvelope: { ...resultEnvelope, applicationDisposition: "applied" } })), /FAILURE_RESULT_INVALID/);
  for (const change of [
    value => { value.accounting.gatewayJobId = "other-gateway-job"; },
    value => { value.request.sourceSkuRevision += 1; },
    value => { value.accounting.usage = { total_tokens: -1 }; },
    value => { value.errorCode = "OTHER_ERROR"; },
    value => { value.extra = true; }
  ]) {
    const invalid = structuredClone(payload);
    change(invalid);
    const envelope = createSoftwareJobResultEnvelope({ job: fixture.job, resultRef: "gateway-job:rejected:1", payloadKind: "c1_ai_draft",
      payload: invalid, recordedAt: resultEnvelope.recordedAt });
    assert.throws(() => settleSoftwareJob(settlement(fixture, { status: "failed", externalRequestState: "succeeded", failureClass: payload.errorCode, resultEnvelope: envelope })));
  }
});

test("canonical授权值只允许已发布的明确路径，普通嵌套同名字段仍拒绝", () => {
  const fixture = c1AiSoftwareJobFixture();
  assertSafeRuntimeRecord(fixture.authorizationRecord);
  assertSafeRuntimeRecord(fixture.credentialBinding);
  assertSafeRuntimeRecord(fixture.job);
  for (const value of [
    { authorizationId: fixture.authorizationRecord.authorizationId },
    { comment: { authorizationId: fixture.authorizationRecord.authorizationId } },
    { ...fixture.job, extra: { authorizationId: fixture.authorizationRecord.authorizationId } },
    { ...fixture.authorizationRecord, unexpected: { authorizationId: fixture.authorizationRecord.authorizationId } }
  ]) assert.throws(() => assertSafeRuntimeRecord(value), /不得保存秘密字段或凭据值/);
});

test("新草稿job和准入schema可编译并验证正式fixture，旧必填边界未放宽", async () => {
  const ajv = await loadPublishedSchemaValidator();
  const fixture = c1AiSoftwareJobFixture();
  const cases = [
    ["software-job-v1.schema.json", fixture.job],
    ["software-job-admission-v1.schema.json#/$defs/softwareJobAuthorizationRecord", fixture.authorizationRecord],
    ["software-job-admission-v1.schema.json#/$defs/softwareJobCredentialBinding", fixture.credentialBinding],
    ["runtime-identity-v1.schema.json#/$defs/workerDescriptor", fixture.worker]
  ];
  for (const [schema, value] of cases) {
    const validate = ajv.getSchema(schema);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, unpublished: true }), false);
  }
  const active = inFlight();
  for (const externalRequestState of ["succeeded", "failed", "unknown_outcome"]) {
    const payload = { schemaVersion: "c1-ai-draft-software-failure-v1", request: active.request,
      accounting: createC1AiAccounting({ gatewayJobId: "gateway-job:rejected:1" }), errorCode: "C1_AI_INFERENCE_FAILED" };
    const resultEnvelope = createSoftwareJobResultEnvelope({ job: active.job, resultRef: "gateway-job:rejected:1", payloadKind: "c1_ai_draft",
      externalRequestState, payload, recordedAt: "2026-08-22T02:02:00.000Z" });
    const failed = settleSoftwareJob(settlement(active, { status: externalRequestState === "unknown_outcome" ? "unknown_outcome" : "failed",
      externalRequestState, failureClass: payload.errorCode, resultEnvelope }));
    const validate = ajv.getSchema("software-job-v1.schema.json");
    assert.equal(validate(failed), true, JSON.stringify(validate.errors));
    const validateEnvelope = ajv.getSchema("software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope");
    if (externalRequestState !== "succeeded") {
      assert.equal(validateEnvelope({ ...resultEnvelope, jobType: "c2_stable_asset_transport" }), false);
      assert.equal(validateEnvelope({ ...resultEnvelope, applicationDisposition: "applied" }), false);
    }
  }
});
