import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_CAPABILITY,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE,
  assertSoftwareJobStrictRef,
  createSoftwareJobEnvelope,
  createSoftwareJobResultEnvelope,
  settleSoftwareJob
} from "../lib/software-job-contract.mjs";
import {
  assertNoSoftwareJobScopeConflict,
  assertSoftwareJobAdmittedForClaim,
  assertSoftwareJobAdmittedForEnqueue,
  assertSoftwareJobAdmittedForExternalRequest,
  bindSoftwareJobAdmissionForEnqueue,
  normalizeSoftwareJobScopeKey
} from "../lib/software-job-admission.mjs";
import { createWorkerDescriptor } from "../lib/runtime-identity.mjs";

const NOW = "2026-09-01T08:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function scope({ sourceRevision = 7, resultRevision = 8, authorizationRef = "transport-authz:c2:1", credentialAlias = "credential-alias:oss:one", inputFingerprint = SHA_A } = {}) {
  return {
    schemaVersion: "software-job-scope-v1",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    sourceRevision,
    resultRevision,
    platform: "ozon",
    storeRef: { stableStoreId: "store:ozon:one", platformStoreId: "seller-one", mappingVersion: "stores-v1" },
    supplierSkuId: "supplier-sku-1",
    variantKey: "white",
    sideEffectScope: "c2_stable_asset_transport",
    authorizationRef,
    credentialAlias,
    inputFingerprint,
    stagedAssetManifestFingerprint: SHA_B,
    ownerStagingConfirmationRef: "owner-confirmation:c2-staging:1",
    allowedStableAssetHosts: ["assets.example.com"]
  };
}

function job(overrides = {}) {
  const binding = scope(overrides.scope || {});
  return createSoftwareJobEnvelope({
    jobId: overrides.jobId || `software-job:c2-stable-asset-transport:${binding.inputFingerprint}`,
    candidateId: binding.candidateId,
    skuPackageId: binding.skuPackageId,
    revision: binding.resultRevision,
    jobType: "c2_stable_asset_transport",
    createdAt: NOW,
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: ["stable-asset-transport"],
    idempotencyKey: overrides.idempotencyKey || `c2-stable-asset-transport:${binding.inputFingerprint}`,
    scopeBinding: binding
  });
}

function authorizationRecord(softwareJob = job()) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: binding.authorizationRef,
    status: "active",
    action: softwareJob.jobType,
    candidateId: softwareJob.candidateId,
    skuPackageId: softwareJob.skuPackageId,
    sourceRevision: binding.sourceRevision,
    resultRevision: binding.resultRevision,
    platform: binding.platform,
    storeRef: structuredClone(binding.storeRef),
    supplierSkuId: binding.supplierSkuId,
    variantKey: binding.variantKey,
    sideEffectScope: binding.sideEffectScope,
    stagedAssetManifestFingerprint: binding.stagedAssetManifestFingerprint,
    ownerStagingConfirmationRef: binding.ownerStagingConfirmationRef,
    allowedStableAssetHosts: structuredClone(binding.allowedStableAssetHosts),
    authorizedByUserId: "owner-1",
    authorizedAt: NOW,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
}

function credentialBinding(softwareJob = job(), allowedWorkerIds = ["worker-stable-transport-1"]) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:oss:one",
    credentialAlias: binding.credentialAlias,
    status: "active",
    provider: "oss",
    platform: binding.platform,
    storeRef: structuredClone(binding.storeRef),
    sideEffectScope: binding.sideEffectScope,
    allowedStableAssetHosts: structuredClone(binding.allowedStableAssetHosts),
    allowedWorkerIds,
    redaction: "credential_alias_only",
    boundAt: NOW,
    expiresAt: null
  };
}

function documentFor(softwareJob = job(), { candidateRevision = softwareJob.scopeBinding.sourceRevision, jobs = [], auth = [authorizationRecord(softwareJob)], credentials = [credentialBinding(softwareJob)] } = {}) {
  return {
    candidates: [{ id: softwareJob.candidateId, dataRevision: candidateRevision }],
    runtime: {
      softwareJobs: structuredClone(jobs),
      softwareJobAuthorizationRecords: structuredClone(auth),
      softwareJobCredentialBindings: structuredClone(credentials)
    }
  };
}

function worker(workerId = "worker-stable-transport-1", capabilities = ["stable-asset-transport"]) {
  return createWorkerDescriptor({ workerId, capabilities, version: "1.0.0", observedAt: NOW });
}

function admittedDocumentFor(softwareJob = job()) {
  const document = documentFor(softwareJob, { candidateRevision: softwareJob.revision });
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({
    document,
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_current"
  });
  document.runtime.softwareJobs = [structuredClone(admittedJob)];
  return { document, softwareJob: admittedJob };
}

test("SoftwareJob admission Schema与运行时strictRef、resultEnvelope和waiting_platform同源", async () => {
  const admissionSchema = JSON.parse(await readFile(new URL("../schema/software-job-admission-v1.schema.json", import.meta.url), "utf8"));
  const jobSchema = JSON.parse(await readFile(new URL("../schema/software-job-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(admissionSchema.$defs.strictRef.pattern, SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE);
  assert.equal(jobSchema.$defs.strictRef.pattern, SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE);
  assert.ok(jobSchema.properties.status.enum.includes("waiting_platform"));
  assert.deepEqual(jobSchema.properties.jobType.enum, ["c2_stable_asset_transport", "c1_paid_keyword_evidence"]);
  assert.ok(jobSchema.properties.requiredCapabilities.items.enum.includes(C1_PAID_KEYWORD_EVIDENCE_CAPABILITY));
  assert.deepEqual(
    jobSchema.properties.resultEnvelope.oneOf[1].$ref,
    "software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope"
  );
  assert.deepEqual(admissionSchema.$defs.softwareJobAuthorizationRecord.oneOf.map((branch) => branch.$ref), [
    "#/$defs/c2StableAssetTransportAuthorizationRecord",
    "#/$defs/c1PaidKeywordEvidenceAuthorizationRecord"
  ]);
  assert.equal(
    jobSchema.$defs.c1PaidKeywordEvidenceScopeBinding.properties.sideEffectScope.const,
    C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE
  );
  assert.equal(jobSchema.$defs.c1PaidKeywordEvidenceScopeBinding.properties.provider.const, C1_PAID_KEYWORD_PROVIDER);
  assert.equal(jobSchema.$defs.c1PaidKeywordEvidenceScopeBinding.properties.pointsAuthorized.const, C1_PAID_KEYWORD_POINTS);
  const c2Shape = jobSchema.allOf.find((branch) => branch.then?.properties?.scopeBinding?.$ref === "#/$defs/c2StableAssetTransportScopeBinding");
  const c1Shape = jobSchema.allOf.find((branch) => branch.then?.properties?.scopeBinding?.$ref === "#/$defs/c1PaidKeywordEvidenceScopeBinding");
  assert.equal(c2Shape.if.properties.jobType.const, "c2_stable_asset_transport");
  assert.equal(c1Shape.if.properties.jobType.const, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE);
  assert.deepEqual(c2Shape.then.properties.requiredCapabilities.const, ["stable-asset-transport"]);
  assert.deepEqual(c1Shape.then.properties.requiredCapabilities.const, [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY]);
  const authorizationSchema = admissionSchema.$defs.c2StableAssetTransportAuthorizationRecord;
  assert.deepEqual(authorizationSchema.allOf.map((branch) => branch.if.properties.useCount.const), [0, 1]);
  assert.equal(authorizationSchema.allOf[0].then.properties.consumedByJobId.type, "null");
  assert.equal(authorizationSchema.allOf[0].then.properties.consumedAt.type, "null");
  assert.equal(authorizationSchema.allOf[1].then.properties.consumedByJobId.$ref, "#/$defs/strictRef");
  assert.deepEqual(authorizationSchema.allOf[1].then.properties.consumedAt, { type: "string", format: "date-time" });
});

function c1Scope(overrides = {}) {
  return {
    schemaVersion: "software-job-scope-v1",
    candidateId: "C-1",
    skuPackageId: "sku:C-1:S-1",
    sourceRevision: 7,
    resultRevision: 8,
    platform: "ozon",
    targetStore: "dandanshu",
    supplierSkuId: "supplier-sku-1",
    variantKey: "white",
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationRef: "c1-paid-keyword-authz-one",
    credentialAlias: "seerfar-open-api-alias-ozon-dandanshu",
    inputFingerprint: SHA_A,
    planningEvidenceFingerprint: SHA_B,
    runtimeInputFingerprint: SHA_C,
    seerfarRequestFingerprint: "d".repeat(64),
    salesSnapshotFingerprint: "e".repeat(64),
    supplySnapshotFingerprint: "f".repeat(64),
    profitModelFingerprint: "1".repeat(64),
    c1FactsFingerprint: "2".repeat(64),
    pointBudgetEvidenceRef: "config:seerfar-budget-15",
    quotaEvidenceRef: "seerfar-quota:80",
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER,
    ...overrides
  };
}

function c1Job(overrides = {}) {
  const binding = c1Scope(overrides.scope || {});
  return createSoftwareJobEnvelope({
    jobId: overrides.jobId || `keyword-job:${binding.candidateId}:7:${binding.inputFingerprint.slice(0, 8)}`,
    candidateId: binding.candidateId,
    skuPackageId: binding.skuPackageId,
    revision: binding.resultRevision,
    jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    createdAt: NOW,
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    idempotencyKey: overrides.idempotencyKey || `c1-paid-keyword:${binding.candidateId}:7`,
    scopeBinding: binding
  });
}

function c1AuthorizationRecord(softwareJob = c1Job(), overrides = {}) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: binding.authorizationRef,
    status: "active",
    action: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationSubject: "c1_paid_keyword_evidence:seerfar_open_api_once",
    candidateId: softwareJob.candidateId,
    skuPackageId: softwareJob.skuPackageId,
    sourceRevision: binding.sourceRevision,
    resultRevision: binding.resultRevision,
    platform: binding.platform,
    targetStore: binding.targetStore,
    supplierSkuId: binding.supplierSkuId,
    variantKey: binding.variantKey,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    provider: C1_PAID_KEYWORD_PROVIDER,
    credentialAlias: binding.credentialAlias,
    inputFingerprint: binding.inputFingerprint,
    planningEvidenceFingerprint: binding.planningEvidenceFingerprint,
    runtimeInputFingerprint: binding.runtimeInputFingerprint,
    seerfarRequestFingerprint: binding.seerfarRequestFingerprint,
    salesSnapshotFingerprint: binding.salesSnapshotFingerprint,
    supplySnapshotFingerprint: binding.supplySnapshotFingerprint,
    profitModelFingerprint: binding.profitModelFingerprint,
    c1FactsFingerprint: binding.c1FactsFingerprint,
    pointBudgetEvidenceRef: binding.pointBudgetEvidenceRef,
    quotaEvidenceRef: binding.quotaEvidenceRef,
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    authorizedByUserId: "owner-1",
    authorizedAt: NOW,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null,
    ...overrides
  };
}

function c1CredentialBinding(softwareJob = c1Job(), allowedWorkerIds = ["worker-seerfar-open-api-1"], overrides = {}) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:seerfar-open-api:one",
    credentialAlias: binding.credentialAlias,
    status: "active",
    provider: C1_PAID_KEYWORD_PROVIDER,
    platform: binding.platform,
    targetStore: binding.targetStore,
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    candidateId: softwareJob.candidateId,
    skuPackageId: softwareJob.skuPackageId,
    sourceRevision: binding.sourceRevision,
    resultRevision: binding.resultRevision,
    inputFingerprint: binding.inputFingerprint,
    planningEvidenceFingerprint: binding.planningEvidenceFingerprint,
    runtimeInputFingerprint: binding.runtimeInputFingerprint,
    seerfarRequestFingerprint: binding.seerfarRequestFingerprint,
    allowedWorkerIds,
    redaction: "credential_alias_only",
    boundAt: NOW,
    expiresAt: null,
    ...overrides
  };
}

function c1DocumentFor(softwareJob = c1Job(), { candidateRevision = softwareJob.scopeBinding.sourceRevision, auth = [c1AuthorizationRecord(softwareJob)], credentials = [c1CredentialBinding(softwareJob)] } = {}) {
  return {
    candidates: [{ id: softwareJob.candidateId, dataRevision: candidateRevision }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: structuredClone(auth),
      softwareJobCredentialBindings: structuredClone(credentials)
    }
  };
}

test("C1同一凭据alias可绑定多个独立作业，但精确重复和被替换binding仍拒绝", () => {
  const first = c1Job();
  const second = c1Job({ scope: {
    candidateId: "C-2", skuPackageId: "sku:C-2:S-2", supplierSkuId: "supplier-sku-2",
    inputFingerprint: SHA_B, authorizationRef: "c1-paid-keyword-authz-two"
  } });
  const credentials = [
    c1CredentialBinding(first),
    c1CredentialBinding(second, ["worker-seerfar-open-api-1"], { bindingId: "credential-binding:seerfar-open-api:two" })
  ];
  for (const current of [first, second]) {
    const document = c1DocumentFor(current, { credentials });
    const admitted = bindSoftwareJobAdmissionForEnqueue({ document, job: current, observedAt: NOW });
    assert.equal(admitted.admissionDecision.credentialBindingRef,
      current === first ? credentials[0].bindingId : credentials[1].bindingId);
    document.candidates[0].dataRevision = current.revision;
    const duplicate = structuredClone(document);
    duplicate.runtime.softwareJobCredentialBindings.push({
      ...structuredClone(credentials[current === first ? 0 : 1]), bindingId: "credential-binding:duplicate"
    });
    assert.throws(() => assertSoftwareJobAdmittedForClaim({ document: duplicate, job: admitted, observedAt: NOW,
      worker: createWorkerDescriptor({ workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1", observedAt: NOW })
    }), /CREDENTIAL_DUPLICATE/);
    const rebound = structuredClone(document);
    rebound.runtime.softwareJobCredentialBindings[current === first ? 0 : 1].bindingId = "credential-binding:replacement";
    assert.throws(() => assertSoftwareJobAdmittedForClaim({ document: rebound, job: admitted, observedAt: NOW,
      worker: createWorkerDescriptor({ workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1", observedAt: NOW })
    }), /CREDENTIAL_MISMATCH/);
  }
});

test("C1旧in_flight与unknown_outcome在共享admission阻止直接入队", () => {
  for (const status of ["in_flight", "unknown_outcome"]) {
    const softwareJob = c1Job();
    const document = c1DocumentFor(softwareJob);
    document.candidates[0].lifecycleV11 = { keywordEvidenceSoftwareJobV1: { status } };
    const before = structuredClone(document);
    assert.throws(() => bindSoftwareJobAdmissionForEnqueue({ document, job: softwareJob, observedAt: NOW }), /LEGACY_OUTCOME_UNRESOLVED/);
    assert.deepEqual(document, before);
  }
});

test("C1外部已成功但本地处理失败继续占用scope，不能跨revision重复扣点", () => {
  const first = c1Job();
  const next = c1Job({ jobId: "keyword-job:next", idempotencyKey: "c1-paid-keyword:next", scope: {
    sourceRevision: 8, resultRevision: 9, inputFingerprint: SHA_B, authorizationRef: "c1-paid-keyword-authz-next"
  } });
  const document = c1DocumentFor(next);
  document.runtime.softwareJobs = [{ ...structuredClone(first), status: "failed", externalRequestState: "succeeded" }];
  assert.throws(() => assertNoSoftwareJobScopeConflict(document, next), /SOFTWARE_JOB_SCOPE_CONFLICT/);
  document.runtime.softwareJobs[0].externalRequestState = "failed";
  assert.doesNotThrow(() => assertNoSoftwareJobScopeConflict(document, next));
});

test("C1 paid keyword admission绑定owner授权、provider credential、store、指纹和一次性15点", () => {
  const softwareJob = c1Job();
  const document = c1DocumentFor(softwareJob);
  const decision = assertSoftwareJobAdmittedForEnqueue({
    document,
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  });
  assert.equal(decision.jobType, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE);
  assert.equal(decision.authorizationRef, softwareJob.scopeBinding.authorizationRef);
  assert.equal(normalizeSoftwareJobScopeKey(softwareJob).startsWith("software-job-scope:"), true);

  const browserWorker = createWorkerDescriptor({
    workerId: "worker-browser",
    capabilities: ["seerfar-browser"],
    version: "1.0.0",
    observedAt: NOW
  });
  assert.throws(() => assertSoftwareJobAdmittedForClaim({
    document: c1DocumentFor(softwareJob, { candidateRevision: softwareJob.revision }),
    job: softwareJob,
    worker: browserWorker,
    observedAt: NOW
  }), /WORKER_CAPABILITY_REQUIRED/);

  const driftedAuthorization = c1AuthorizationRecord(softwareJob, { pointsAuthorized: 16 });
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: c1DocumentFor(softwareJob, { auth: [driftedAuthorization] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /AUTHORIZATION_INVALID|AUTHORIZATION_MISMATCH/);

  const driftedCredential = c1CredentialBinding(softwareJob, ["worker-seerfar-open-api-1"], { provider: "seerfar-browser" });
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: c1DocumentFor(softwareJob, { credentials: [driftedCredential] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /CREDENTIAL_INVALID|CREDENTIAL_MISMATCH/);
});

test("SoftwareJob strictRef的Schema pattern与运行时边界逐样本同判", () => {
  const pattern = new RegExp(SOFTWARE_JOB_STRICT_REF_PATTERN_SOURCE);
  const valid = [
    "job:c2-stable-asset-transport:1",
    "request:c2-stable-transport:fixture",
    "receipt:c2-stable-transport:fixture",
    "tokenizer:tool",
    "credentialAlias:ozon",
    "a".repeat(256)
  ];
  const invalid = [
    "",
    "a".repeat(257),
    "has space",
    "https://assets.example.com/final/1.jpg",
    "file:///tmp/result",
    "/tmp/result",
    String.raw`C:\tmp\result`,
    "opaque?tokenizer=tool",
    "opaque#fragment",
    "user@example",
    "token=none",
    "a&b",
    "a//b",
    "line\nbreak"
  ];
  for (const value of valid) {
    assert.equal(pattern.test(value), true, value);
    assert.equal(assertSoftwareJobStrictRef(value), value);
  }
  for (const value of invalid) {
    assert.equal(pattern.test(value), false, value);
    assert.throws(() => assertSoftwareJobStrictRef(value), /SOFTWARE_JOB_INVALID/);
  }
});

test("admission必须绑定持久AuthorizationRecord和脱敏CredentialBinding，且拒绝漂移或秘密容器", () => {
  const softwareJob = job();
  const document = documentFor(softwareJob);
  const decision = assertSoftwareJobAdmittedForEnqueue({
    document,
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  });
  assert.deepEqual([decision.authorizationRef, decision.credentialAlias, decision.phase], [
    softwareJob.scopeBinding.authorizationRef,
    softwareJob.scopeBinding.credentialAlias,
    "enqueue_before_candidate_commit"
  ]);

  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { auth: [] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED/);
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { credentials: [] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED/);

  const driftedAuthorization = authorizationRecord(softwareJob);
  driftedAuthorization.stagedAssetManifestFingerprint = SHA_C;
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { auth: [driftedAuthorization] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH/);

  const secretCredential = credentialBinding(softwareJob);
  secretCredential.provider = "Bearer-secret";
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { credentials: [secretCredential] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /不得.*秘密|SOFTWARE_JOB_ADMISSION_CREDENTIAL_INVALID/);

  const otherOwnerAuthorization = authorizationRecord(softwareJob);
  otherOwnerAuthorization.authorizedByUserId = "owner-2";
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { auth: [otherOwnerAuthorization] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_OWNER_MISMATCH/);

  const futureAuthorization = authorizationRecord(softwareJob);
  futureAuthorization.authorizedAt = "2026-09-01T08:00:01.000Z";
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { auth: [futureAuthorization] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_NOT_EFFECTIVE/);

  const futureConsumption = authorizationRecord(softwareJob);
  futureConsumption.useCount = 1;
  futureConsumption.consumedByJobId = softwareJob.jobId;
  futureConsumption.consumedAt = "2026-09-01T08:00:01.000Z";
  assert.throws(() => assertSoftwareJobAdmittedForClaim({
    document: documentFor(softwareJob, { candidateRevision: softwareJob.revision, auth: [futureConsumption] }),
    job: softwareJob,
    worker: worker(),
    observedAt: NOW
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_NOT_EFFECTIVE/);

  const impossibleConsumptionOrder = authorizationRecord(softwareJob);
  impossibleConsumptionOrder.useCount = 1;
  impossibleConsumptionOrder.consumedByJobId = softwareJob.jobId;
  impossibleConsumptionOrder.authorizedAt = "2026-09-01T08:00:00.000Z";
  impossibleConsumptionOrder.consumedAt = "2026-09-01T07:59:59.999Z";
  assert.throws(() => assertSoftwareJobAdmittedForClaim({
    document: documentFor(softwareJob, { candidateRevision: softwareJob.revision, auth: [impossibleConsumptionOrder] }),
    job: softwareJob,
    worker: worker(),
    observedAt: NOW
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_CONSUMPTION_PRECEDES_AUTHORIZATION/);

  const futureCredential = credentialBinding(softwareJob);
  futureCredential.boundAt = "2026-09-01T08:00:01.000Z";
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { credentials: [futureCredential] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_CREDENTIAL_NOT_EFFECTIVE/);

  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { auth: [authorizationRecord(softwareJob), authorizationRecord(softwareJob)] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_DUPLICATE/);

  const duplicateCredential = credentialBinding(softwareJob);
  duplicateCredential.bindingId = "credential-binding:oss:two";
  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: documentFor(softwareJob, { credentials: [credentialBinding(softwareJob), duplicateCredential] }),
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_before_candidate_commit"
  }), /SOFTWARE_JOB_ADMISSION_CREDENTIAL_DUPLICATE/);

  const collisionJob = job({ scope: { credentialAlias: "credential:X" } });
  const authoritativeCredential = credentialBinding(collisionJob);
  authoritativeCredential.bindingId = "binding:A";
  authoritativeCredential.credentialAlias = "credential:X";
  const collidingCredential = credentialBinding(collisionJob);
  collidingCredential.bindingId = "credential:X";
  collidingCredential.credentialAlias = "credential:Y";
  for (const credentials of [
    [authoritativeCredential, collidingCredential],
    [collidingCredential, authoritativeCredential]
  ]) {
    assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
      document: documentFor(collisionJob, { credentials }),
      job: collisionJob,
      observedAt: NOW,
      phase: "enqueue_before_candidate_commit"
    }), /SOFTWARE_JOB_ADMISSION_CREDENTIAL_NAMESPACE_COLLISION/);
  }
});

test("同一外部副作用scope跨revision排队、in-flight和revision_conflict完成态都互斥", () => {
  const first = job();
  const retry = job({
    jobId: `software-job:c2-stable-asset-transport:${SHA_C}`,
    idempotencyKey: `c2-stable-asset-transport:${SHA_C}`,
    scope: { sourceRevision: 8, resultRevision: 9, authorizationRef: "transport-authz:c2:2", inputFingerprint: SHA_C }
  });
  assert.equal(normalizeSoftwareJobScopeKey(first), normalizeSoftwareJobScopeKey(retry));

  assert.throws(() => assertNoSoftwareJobScopeConflict(
    documentFor(retry, { candidateRevision: 8, jobs: [first] }),
    retry
  ), /SOFTWARE_JOB_SCOPE_CONFLICT/);

  const appliedCompleted = {
    ...structuredClone(first),
    status: "completed",
    externalRequestState: "succeeded",
    resultEnvelope: { applicationDisposition: "applied" }
  };
  assert.doesNotThrow(() => assertNoSoftwareJobScopeConflict(
    documentFor(retry, { candidateRevision: 8, jobs: [appliedCompleted] }),
    retry
  ));

  const revisionConflictCompleted = {
    ...structuredClone(first),
    status: "completed",
    externalRequestState: "succeeded",
    resultEnvelope: { applicationDisposition: "revision_conflict_not_applied" }
  };
  assert.throws(() => assertNoSoftwareJobScopeConflict(
    documentFor(retry, { candidateRevision: 8, jobs: [revisionConflictCompleted] }),
    retry
  ), /SOFTWARE_JOB_SCOPE_CONFLICT/);
});

test("claim与external_request阶段重新校验worker能力和CredentialBinding绑定", () => {
  const softwareJob = job();
  const { document: claimDocument, softwareJob: admittedJob } = admittedDocumentFor(softwareJob);
  assert.deepEqual(
    claimDocument.runtime.softwareJobAuthorizationRecords.map((record) => [record.useCount, record.consumedByJobId, record.consumedAt]),
    [[1, softwareJob.jobId, NOW]]
  );
  const decision = assertSoftwareJobAdmittedForClaim({
    document: claimDocument,
    job: admittedJob,
    worker: worker(),
    observedAt: NOW
  });
  assert.equal(decision.phase, "claim");
  assert.equal(assertSoftwareJobAdmittedForExternalRequest({
    document: claimDocument,
    job: admittedJob,
    workerId: "worker-stable-transport-1",
    observedAt: NOW
  }).phase, "external_request");

  assert.throws(() => assertSoftwareJobAdmittedForEnqueue({
    document: claimDocument,
    job: softwareJob,
    observedAt: NOW,
    phase: "enqueue_current"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED/);

  const tamperedDecisionJob = {
    ...structuredClone(admittedJob),
    admissionDecision: { ...structuredClone(admittedJob.admissionDecision), credentialBindingFingerprint: SHA_C }
  };
  assert.throws(() => assertSoftwareJobAdmittedForClaim({
    document: claimDocument,
    job: tamperedDecisionJob,
    worker: worker(),
    observedAt: NOW
  }), /SOFTWARE_JOB_ADMISSION_DECISION_MISMATCH/);

  assert.throws(() => assertSoftwareJobAdmittedForClaim({
    document: claimDocument,
    job: admittedJob,
    worker: worker("worker-image", ["image-processing"]),
    observedAt: NOW
  }), /SOFTWARE_JOB_ADMISSION_WORKER_CAPABILITY_REQUIRED/);
  assert.throws(() => assertSoftwareJobAdmittedForExternalRequest({
    document: claimDocument,
    job: admittedJob,
    workerId: "worker-other",
    observedAt: NOW
  }), /SOFTWARE_JOB_ADMISSION_WORKER_NOT_BOUND/);
});

test("resultEnvelope是单一持久结果封套且payload指纹锁定", () => {
  const softwareJob = {
    ...structuredClone(job()),
    jobType: "c1_keyword_evidence",
    scopeBinding: null,
    status: "waiting_platform",
    startedAt: NOW,
    lastProgressAt: NOW,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-stable-transport-1",
    leaseExpiresAt: "2026-09-01T08:01:00.000Z",
    attempt: 1,
    externalRequestState: "in_flight",
    externalRequestRef: "request:c2-stable-transport:1"
  };
  const payload = { schemaVersion: "test-result-v1", status: "verified" };
  const envelope = createSoftwareJobResultEnvelope({
    job: softwareJob,
    resultRef: "receipt:c2-stable-transport:1",
    payloadKind: softwareJob.jobType,
    payload,
    recordedAt: NOW,
    applicationDisposition: "result_recorded_no_candidate_mutation"
  });
  assert.equal(envelope.payloadFingerprint, fingerprintCanonicalRecord(payload));
  const tampered = structuredClone(envelope);
  tampered.payload.status = "tampered";
  assert.throws(() => settleSoftwareJob({
    job: softwareJob,
    workerId: softwareJob.workerId,
    leaseId: softwareJob.leaseId,
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: tampered.resultRef,
    resultEnvelope: tampered,
    applicationDisposition: "result_recorded_no_candidate_mutation",
    allowDomainSettlement: true,
    serverTime: NOW
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);

  assert.throws(() => createSoftwareJobResultEnvelope({
    job: softwareJob,
    resultRef: "receipt:c2-stable-transport:payload-kind-drift",
    payloadKind: "c2_stable_asset_transport",
    payload,
    recordedAt: NOW,
    applicationDisposition: "result_recorded_no_candidate_mutation"
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
});

test("resultEnvelope在fingerprint和clone之前拒绝循环与超限payload", () => {
  const softwareJob = {
    ...structuredClone(job()),
    jobType: "c1_keyword_evidence",
    scopeBinding: null,
    status: "waiting_platform",
    startedAt: NOW,
    lastProgressAt: NOW,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-stable-transport-1",
    leaseExpiresAt: "2026-09-01T08:01:00.000Z",
    attempt: 1,
    externalRequestState: "in_flight",
    externalRequestRef: "request:c2-stable-transport:1"
  };
  const cyclicPayload = { schemaVersion: "test-result-v1" };
  cyclicPayload.self = cyclicPayload;
  assert.throws(() => createSoftwareJobResultEnvelope({
    job: softwareJob,
    resultRef: "receipt:c2-stable-transport:cycle",
    payloadKind: softwareJob.jobType,
    payload: cyclicPayload,
    recordedAt: NOW
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);

  assert.throws(() => createSoftwareJobResultEnvelope({
    job: softwareJob,
    resultRef: "receipt:c2-stable-transport:large",
    payloadKind: softwareJob.jobType,
    payload: { schemaVersion: "test-result-v1", value: "x".repeat(65_537) },
    recordedAt: NOW
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);

  const envelope = createSoftwareJobResultEnvelope({
    job: softwareJob,
    resultRef: "receipt:c2-stable-transport:valid",
    payloadKind: softwareJob.jobType,
    payload: { schemaVersion: "test-result-v1", status: "verified" },
    recordedAt: NOW,
    applicationDisposition: "result_recorded_no_candidate_mutation"
  });
  const cyclicEnvelope = { ...structuredClone(envelope), payload: { schemaVersion: "test-result-v1" } };
  cyclicEnvelope.payload.self = cyclicEnvelope.payload;
  cyclicEnvelope.payloadFingerprint = "0".repeat(64);
  assert.throws(() => settleSoftwareJob({
    job: softwareJob,
    workerId: softwareJob.workerId,
    leaseId: softwareJob.leaseId,
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: cyclicEnvelope.resultRef,
    resultEnvelope: cyclicEnvelope,
    applicationDisposition: "result_recorded_no_candidate_mutation",
    allowDomainSettlement: true,
    serverTime: NOW
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
});
