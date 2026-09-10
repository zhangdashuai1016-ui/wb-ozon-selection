import test from "node:test";
import assert from "node:assert/strict";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createDProductionJobScope, createEReadbackJobScope, normalizeDESoftwareJobScope } from "../lib/d-e-software-job-scope.mjs";
import { createDEJobAdmissionDecision } from "../lib/d-e-software-job-admission.mjs";
import { createSoftwareJobEnvelope, bindSoftwareJobAdmissionDecision, claimSoftwareJobLease,
  markSoftwareJobExternalRequestStarted } from "../lib/software-job-contract.mjs";
import { createWorkerDescriptor } from "../lib/runtime-identity.mjs";
import { PRODUCTION_EXECUTION_BINDING_SCHEMA } from "../lib/production-authorization-preparation.mjs";
import { deSoftwareJobScopeFixture, DE_SCOPE_OBSERVED_AT as observedAt } from "./fixtures/d-e-software-job-scope-fixture.mjs";
import { c1AiSoftwareJobFixture, c1AiSoftwareJobResultEnvelope } from "./fixtures/c1-ai-software-job-fixture.mjs";
import { bindSoftwareJobAdmissionForEnqueue } from "../lib/software-job-admission.mjs";

const ajv = await loadPublishedSchemaValidator();
const validateJob = ajv.getSchema("software-job-v1.schema.json");
const validateAdmission = ajv.getSchema("software-job-admission-v1.schema.json#/$defs/softwareJobAdmissionDecision");
const validateSnapshot = ajv.getSchema("software-job-admission-v1.schema.json#/$defs/deExecutionBindingSnapshot");
const validateResult = ajv.getSchema("software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope");
const validateScope = type => ajv.getSchema(`software-job-v1.schema.json#/$defs/${type === "d_production_execution" ? "dProductionExecutionScopeBinding" : "eIndependentReadbackScopeBinding"}`);
const fixture = await deSoftwareJobScopeFixture();
const cases = [
  [fixture.initialCandidate, createDProductionJobScope, "ozon-production-execution"],
  [fixture.completedCandidate, createEReadbackJobScope, "ozon-independent-readback"]
].map(([candidate, createScope, capability]) => {
  const scope = createScope({ candidate, observedAt });
  const job = createSoftwareJobEnvelope({ jobId: `job:schema:${scope.sideEffectScope}`, candidateId: candidate.id,
    skuPackageId: scope.skuPackageId, revision: scope.resultRevision, jobType: scope.sideEffectScope, createdAt: observedAt,
    requestedByUserId: "software-handoff", ownerUserId: "synthetic-owner", requiredCapabilities: [capability],
    idempotencyKey: `enqueue:schema:${scope.sideEffectScope}`, scopeBinding: scope });
  const admission = createDEJobAdmissionDecision({ candidate, job, observedAt, phase: "enqueue_current" });
  const admitted = bindSoftwareJobAdmissionDecision(job, admission);
  const binding = { schemaVersion: "d-e-execution-binding-v1", serviceId: "service:synthetic-de", serviceConfigurationVersion: "configuration:synthetic:1",
    productionBinding: structuredClone(scope.productionBinding), platform: "ozon", storeRef: structuredClone(scope.identity.storeRef),
    warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias, workerId: "worker-synthetic-de", workerVersion: "synthetic:1",
    configurationEvidence: { evidenceRef: "evidence:synthetic-de-configuration", checkedAt: observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString() } };
  const worker = createWorkerDescriptor({ workerId: binding.workerId, capabilities: [capability], version: binding.workerVersion, observedAt });
  return { candidate, scope, job, admission, admitted, binding, worker };
});

function accepts(validate, value) { assert.equal(validate(value), true, JSON.stringify(validate.errors)); }
function rejects(validate, value) { assert.equal(validate(value), false, "invalid published contract was accepted"); }

test("strict D/E schemas accept real source producers, shared queued envelopes and long saved PA/plan IDs", () => {
  assert.deepEqual(ajv.getSchema("software-job-v1.schema.json").schema.$defs.deProductionBinding, PRODUCTION_EXECUTION_BINDING_SCHEMA);
  for (const { scope, job, admission, admitted } of cases) {
    assert.equal(Object.keys(scope).length, job.jobType === "d_production_execution" ? 17 : 27);
    assert.ok(scope.authorizationRef.length > 256);
    if (job.jobType === "e_independent_readback") assert.ok(scope.sourceProductionPlanId.length > 256);
    accepts(validateScope(job.jobType), scope);
    accepts(validateJob, job);
    accepts(validateJob, admitted);
    accepts(validateAdmission, admission);
    assert.equal(admission.admissionKind, "domain_handoff");
    assert.equal(admission.executionBindingSnapshot, null);
    assert.equal(Object.hasOwn(admission, "credentialBindingRef"), false);
  }
});

test("D/E scopes are closed at every source boundary and cannot exchange side effects or capabilities", () => {
  for (const { job, scope } of cases) {
    for (const field of Object.keys(scope)) {
      const invalid = structuredClone(scope); delete invalid[field]; rejects(validateScope(job.jobType), invalid);
    }
    for (const change of [s => { s.extra = true; }, s => { s.identity.extra = true; },
      s => { s.identity.platform = "wb"; }, s => { s.identity.credentialAlias = s.credentialAlias; },
      s => { delete s.identity.storeRef.mappingVersion; }, s => { s.identity.storeRef.extra = true; },
      s => { s.productionBinding.currentHealth = true; }, s => { s.productionBinding.warehouseId = "070001"; },
      s => { s.productionBinding.warehouseId = "9007199254740992"; }, s => { s.authorizationRef = "x".repeat(1025); },
      s => { s.authorizationRef = "UNKNOWN"; }, s => { s.variantKey = "x".repeat(257); },
      s => { s.variantKey = "规格\n红色"; }, s => { s.credentialAlias = "https://example.com/private"; },
      s => { s.merchantSku = "x".repeat(257); }, s => { s.warehouseRef = "missing"; },
      s => { s.identity.storeRef.mappingVersion = "x".repeat(201); }, s => { s.sourceRevision = Number.MAX_SAFE_INTEGER + 1; },
      s => { s.resultSkuRevision = -1; }, s => { s.inputFingerprint = "g".repeat(64); }]) {
      const invalid = structuredClone(scope); change(invalid); rejects(validateScope(job.jobType), invalid);
    }
    for (const capabilities of [[], ["chrome"], ["ozon-production-execution", "ozon-independent-readback"], [...job.requiredCapabilities, ...job.requiredCapabilities]]) {
      rejects(validateJob, { ...structuredClone(job), requiredCapabilities: capabilities });
    }
    const other = cases.find(value => value.job.jobType !== job.jobType);
    rejects(validateJob, { ...structuredClone(job), scopeBinding: structuredClone(other.scope) });
    rejects(validateJob, { ...structuredClone(job), requiredCapabilities: [...other.job.requiredCapabilities] });
    rejects(validateJob, { ...structuredClone(job), admissionDecision: structuredClone(other.admission) });
    for (const field of ["workerId", "workerVersion", "leaseId", "externalRequestRef", "progressRef"]) {
      rejects(validateJob, { ...structuredClone(job), [field]: "unexpected:initial-state" });
    }
    for (const field of ["startedAt", "lastProgressAt", "leaseExpiresAt"]) rejects(validateJob, { ...structuredClone(job), [field]: observedAt });
    rejects(validateJob, { ...structuredClone(job), workerCapabilitiesSnapshot: [...job.requiredCapabilities] });
  }
  const e = structuredClone(cases[1].scope);
  for (const field of ["sourceProductionRecordId", "sourceProductionPlanId"]) rejects(validateScope(e.sideEffectScope), { ...e, [field]: "x".repeat(1025) });
  for (const value of ["0", "070001", "9007199254740992"]) rejects(validateScope(e.sideEffectScope), { ...e, platformProductId: value });
});

test("schema validates structure while JS retains exact revision arithmetic and immutable source equality", () => {
  for (const { scope, job } of cases) {
    const invalid = structuredClone(scope); invalid.sourceRevision += 1;
    accepts(validateScope(job.jobType), invalid);
    assert.throws(() => normalizeDESoftwareJobScope(invalid, job), /DE_JOB_SCOPE_REVISION_CONFLICT/);
  }
});

test("real claim/request admission records retain exact technical snapshots and worker capabilities", () => {
  for (const { candidate, admitted, binding, worker } of cases) {
    const claimAdmission = createDEJobAdmissionDecision({ candidate, job: admitted, observedAt, phase: "claim", executionBinding: binding, worker });
    accepts(validateAdmission, claimAdmission); accepts(validateSnapshot, claimAdmission.executionBindingSnapshot);
    const claimed = claimSoftwareJobLease({ job: bindSoftwareJobAdmissionDecision(admitted, claimAdmission), worker,
      leaseId: "lease:synthetic-schema", serverTime: observedAt, leaseDurationMs: 60_000 });
    accepts(validateJob, claimed);
    assert.deepEqual(claimed.workerCapabilitiesSnapshot, admitted.requiredCapabilities);
    const requestAdmission = createDEJobAdmissionDecision({ candidate, job: claimed, observedAt, phase: "external_request", executionBinding: binding, worker });
    const started = markSoftwareJobExternalRequestStarted({ job: bindSoftwareJobAdmissionDecision(claimed, requestAdmission),
      workerId: worker.workerId, leaseId: claimed.leaseId, externalRequestRef: "request:synthetic-schema", serverTime: observedAt });
    accepts(validateAdmission, requestAdmission); accepts(validateJob, started);
    assert.equal(started.status, "waiting_platform");
    assert.equal(started.externalRequestState, "in_flight");
    rejects(validateAdmission, { ...claimAdmission, executionBindingSnapshot: null });
    rejects(validateAdmission, { ...requestAdmission, executionBindingSnapshot: null });
    rejects(validateJob, { ...claimed, admissionDecision: null });
    rejects(validateJob, { ...started, admissionDecision: null });
  }
});

test("D/E admission and technical snapshots are closed, phase-specific and never manufacture current health", () => {
  for (const { admission, binding } of cases) {
    for (const field of Object.keys(admission)) {
      const invalid = structuredClone(admission); delete invalid[field]; rejects(validateAdmission, invalid);
    }
    for (const change of [a => { a.credentialBindingRef = "credential:other"; }, a => { a.admissionKind = "paid_authorization"; },
      a => { a.phase = "enqueue_before_candidate_commit"; }, a => { a.executionBindingSnapshot = binding; },
      a => { a.admissionId = "admission:wrong-prefix"; }, a => { a.normalizedScopeKey = "scope:wrong-prefix"; },
      a => { a.authorizationRef = "x".repeat(1025); }, a => { a.sourceFingerprint = "x"; }, a => { a.observedAt = "invalid"; }]) {
      const invalid = structuredClone(admission); change(invalid); rejects(validateAdmission, invalid);
    }
    for (const field of Object.keys(binding)) {
      const invalid = structuredClone(binding); delete invalid[field]; rejects(validateSnapshot, invalid);
    }
    for (const change of [b => { b.currentHealth = true; }, b => { b.platform = "wb"; }, b => { b.workerId = "missing"; },
      b => { b.workerVersion = "x".repeat(257); }, b => { b.serviceId = "https://example.com/private"; },
      b => { b.configurationEvidence.token = "synthetic-private-value"; }, b => { b.configurationEvidence.checkedAt = "invalid"; },
      b => { b.productionBinding.extra = true; }, b => { b.storeRef.extra = true; }]) {
      const invalid = structuredClone(binding); change(invalid); rejects(validateSnapshot, invalid);
    }
  }
});

test("new domain admission cannot cross into historical C1/C2 variants and D/E terminal payloads remain unavailable", () => {
  const f = c1AiSoftwareJobFixture();
  const oldJob = bindSoftwareJobAdmissionForEnqueue({ document: f.document, job: f.job, observedAt: f.at, phase: "enqueue_current" });
  accepts(validateJob, oldJob); accepts(validateAdmission, oldJob.admissionDecision);
  const claimed = claimSoftwareJobLease({ job: oldJob, worker: f.worker, leaseId: "lease:c1-schema-compatibility", serverTime: f.at, leaseDurationMs: 60_000 });
  const inFlight = markSoftwareJobExternalRequestStarted({ job: claimed, workerId: f.worker.workerId, leaseId: claimed.leaseId,
    externalRequestRef: "request:c1-schema-compatibility", serverTime: f.at });
  const oldResult = c1AiSoftwareJobResultEnvelope(inFlight, f.request);
  accepts(validateResult, oldResult);
  for (const { admitted, admission } of cases) {
    rejects(validateJob, { ...oldJob, admissionDecision: admission });
    rejects(validateJob, { ...admitted, admissionDecision: oldJob.admissionDecision });
    rejects(validateAdmission, { ...oldJob.admissionDecision, jobType: admitted.jobType });
    rejects(validateResult, { ...oldResult, jobType: admitted.jobType });
    for (const status of ["completed", "failed", "unknown_outcome"]) rejects(validateJob, { ...admitted, status });
    rejects(validateJob, { ...admitted, resultEnvelope: {} });
    rejects(validateJob, { ...admitted, resultRef: "receipt:unpublished-de" });
  }
});
