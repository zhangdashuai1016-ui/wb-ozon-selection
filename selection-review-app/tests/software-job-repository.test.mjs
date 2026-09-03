import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import {
  C1_PAID_KEYWORD_EVIDENCE_CAPABILITY,
  C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
  C1_PAID_KEYWORD_POINTS,
  C1_PAID_KEYWORD_PROVIDER,
  createSoftwareJobEnvelope,
  createSoftwareJobResultEnvelope,
  reconcileExpiredSoftwareJobLease,
  reconcileSoftwareJobAfterRestart,
  settleSoftwareJob,
  settleSoftwareJobInDocument
} from "../lib/software-job-contract.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { bindSoftwareJobAdmissionForEnqueue } from "../lib/software-job-admission.mjs";
import { createWorkerDescriptor } from "../lib/runtime-identity.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";

const T0 = "2026-08-25T05:00:00.000Z";

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function job(id = "job-1", idempotencyKey = "C-1:9:keywords", scopeOverrides = {}) {
  const fingerprintSeed = idempotencyKey === "C-1:9:keywords" ? "default" : idempotencyKey;
  const inputFingerprint = sha(`c1-paid-keyword-input:${fingerprintSeed}`);
  const scopeBinding = {
    schemaVersion: "software-job-scope-v1",
    candidateId: scopeOverrides.candidateId ?? "C-1",
    skuPackageId: scopeOverrides.skuPackageId ?? "sku:C-1:S-1",
    sourceRevision: scopeOverrides.sourceRevision ?? 8,
    resultRevision: scopeOverrides.resultRevision ?? 9,
    platform: scopeOverrides.platform ?? "ozon",
    targetStore: scopeOverrides.targetStore ?? "dandanshu",
    supplierSkuId: scopeOverrides.supplierSkuId ?? "supplier-sku-1",
    variantKey: scopeOverrides.variantKey ?? "white",
    sideEffectScope: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    authorizationRef: `c1-paid-keyword-authz-${inputFingerprint.slice(0, 16)}`,
    credentialAlias: `seerfar-open-api-alias-ozon-dandanshu-${inputFingerprint.slice(0, 16)}`,
    inputFingerprint,
    planningEvidenceFingerprint: sha(`c1-paid-keyword-plan:${fingerprintSeed}`),
    runtimeInputFingerprint: sha(`c1-paid-keyword-runtime:${fingerprintSeed}`),
    seerfarRequestFingerprint: sha(`c1-paid-keyword-seerfar:${fingerprintSeed}`),
    salesSnapshotFingerprint: sha(`c1-paid-keyword-sales:${fingerprintSeed}`),
    supplySnapshotFingerprint: sha(`c1-paid-keyword-supply:${fingerprintSeed}`),
    profitModelFingerprint: sha(`c1-paid-keyword-profit:${fingerprintSeed}`),
    c1FactsFingerprint: sha(`c1-paid-keyword-facts:${fingerprintSeed}`),
    pointBudgetEvidenceRef: "config:seerfar-budget-15",
    quotaEvidenceRef: "seerfar-quota:80",
    pointsAuthorized: C1_PAID_KEYWORD_POINTS,
    provider: C1_PAID_KEYWORD_PROVIDER
  };
  return createSoftwareJobEnvelope({
    jobId: id,
    candidateId: scopeBinding.candidateId,
    skuPackageId: scopeBinding.skuPackageId,
    revision: scopeBinding.resultRevision,
    jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    createdAt: T0,
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    idempotencyKey,
    scopeBinding
  });
}

function worker() {
  return createWorkerDescriptor({
    workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version: "1.0.0", observedAt: T0
  });
}

function workerRegistry({ clock = () => T0, workerId = "worker-seerfar-open-api-1", capabilities = [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY], version = "1.0.0", heartbeatTtlMs = 60_000 } = {}) {
  const registry = createLocalDevelopmentWorkerRegistry({ clock, heartbeatTtlMs });
  registry.register({ workerId, capabilities, version, observedAt: clock() });
  return registry;
}

function c2WorkerRegistry(options = {}) {
  return workerRegistry({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    ...options
  });
}

function repository() {
  return repositoryWithJobs([]);
}

function repositoryWithJobs(jobs) {
  const softwareJobs = jobs.length === 0
    ? [job()]
    : jobs.map((softwareJob) =>
      softwareJob.jobType === C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE && !softwareJob.admissionDecision
        ? admittedC1Job(softwareJob)
        : softwareJob
    );
  return createMemoryBusinessStateRepository({
    candidates: [{ id: "C-1", dataRevision: 9 }],
    runtime: {
      softwareJobs: structuredClone(jobs.length === 0 ? [] : softwareJobs),
      softwareJobAuthorizationRecords: softwareJobs.map((softwareJob) => c1AuthorizationRecord(
        softwareJob,
        softwareJob.admissionDecision
          ? { useCount: 1, consumedByJobId: softwareJob.jobId, consumedAt: T0 }
          : {}
      )),
      softwareJobCredentialBindings: softwareJobs.map((softwareJob) => c1CredentialBinding(softwareJob)),
      operationAudit: [],
      idempotencyRecords: []
    }
  });
}

function repositoryForEnqueueableC1Jobs(softwareJobs) {
  return createMemoryBusinessStateRepository({
    candidates: softwareJobs.map((softwareJob) => ({
      id: softwareJob.candidateId,
      dataRevision: softwareJob.revision
    })),
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: softwareJobs.map((softwareJob) => c1AuthorizationRecord(softwareJob)),
      softwareJobCredentialBindings: softwareJobs.map((softwareJob) => c1CredentialBinding(softwareJob)),
      operationAudit: [],
      idempotencyRecords: []
    }
  });
}

function claimedJobFixture(overrides = {}) {
  const admitted = admittedC1Job(job("job-claimed", "C-1:9:keywords:claimed"));
  return {
    ...structuredClone(admitted),
    status: "claimed",
    startedAt: T0,
    lastProgressAt: T0,
    workerId: "worker-seerfar-open-api-1",
    workerVersion: "1.0.0",
    workerCapabilitiesSnapshot: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    leaseId: "lease-claimed",
    leaseExpiresAt: "2026-08-25T05:01:00.000Z",
    attempt: 1,
    externalRequestState: "not_sent",
    ...overrides
  };
}

function waitingPlatformJobFixture(overrides = {}) {
  return claimedJobFixture({
    status: "waiting_platform",
    externalRequestState: "in_flight",
    externalRequestRef: "request:C-1:claimed",
    ...overrides
  });
}

function c1AuthorizationRecord(softwareJob = job(), overrides = {}) {
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
    authorizedAt: T0,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null,
    ...overrides
  };
}

function c1CredentialBinding(softwareJob = job(), overrides = {}) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: `seerfar-open-api-binding-${binding.inputFingerprint.slice(0, 16)}`,
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
    allowedWorkerIds: ["worker-seerfar-open-api-1"],
    redaction: "credential_alias_only",
    boundAt: T0,
    expiresAt: null,
    ...overrides
  };
}

function admittedC1Job(softwareJob = job()) {
  const document = {
    candidates: [{ id: softwareJob.candidateId, dataRevision: softwareJob.revision }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [c1AuthorizationRecord(softwareJob)],
      softwareJobCredentialBindings: [c1CredentialBinding(softwareJob)]
    }
  };
  return bindSoftwareJobAdmissionForEnqueue({
    document,
    job: softwareJob,
    observedAt: T0,
    phase: "enqueue_current"
  });
}

function countedClock(value) {
  let calls = 0;
  return {
    clock: () => {
      calls += 1;
      return value;
    },
    calls: () => calls
  };
}

function mutableCountedClock(initialValue) {
  let value = initialValue;
  let calls = 0;
  return {
    clock: () => {
      calls += 1;
      return value;
    },
    set: (nextValue) => {
      value = nextValue;
    },
    calls: () => calls
  };
}

async function holdRepositoryQueue(stateRepository) {
  let release;
  let blocker;
  const entered = new Promise((resolve) => {
    blocker = stateRepository.transact(async () => {
      await new Promise((resume) => {
        release = resume;
        resolve();
      });
      return { changed: false, result: null };
    });
  });
  await entered;
  return { release, blocker };
}

function c2Scope({ inputFingerprint = "a".repeat(64), authorizationRef = "transport-authz:c2:repo", credentialAlias = "credential-alias:oss:repo" } = {}) {
  return {
    schemaVersion: "software-job-scope-v1",
    candidateId: "C-2",
    skuPackageId: "sku:C-2:S-1",
    sourceRevision: 7,
    resultRevision: 8,
    platform: "ozon",
    storeRef: { stableStoreId: "store:ozon:one", platformStoreId: "seller-one", mappingVersion: "stores-v1" },
    supplierSkuId: "supplier-sku-1",
    variantKey: "white",
    sideEffectScope: "c2_stable_asset_transport",
    authorizationRef,
    credentialAlias,
    inputFingerprint,
    stagedAssetManifestFingerprint: "b".repeat(64),
    ownerStagingConfirmationRef: "owner-confirmation:c2-staging:repo",
    allowedStableAssetHosts: ["assets.example.com"]
  };
}

function c2Job(overrides = {}) {
  const scopeBinding = c2Scope(overrides.scope || {});
  return createSoftwareJobEnvelope({
    jobId: overrides.jobId || `software-job:c2-stable-asset-transport:${scopeBinding.inputFingerprint}`,
    candidateId: scopeBinding.candidateId,
    skuPackageId: scopeBinding.skuPackageId,
    revision: scopeBinding.resultRevision,
    jobType: "c2_stable_asset_transport",
    createdAt: T0,
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: ["stable-asset-transport"],
    idempotencyKey: overrides.idempotencyKey || `c2-stable-asset-transport:${scopeBinding.inputFingerprint}`,
    scopeBinding
  });
}

function c2AuthorizationRecord(softwareJob = c2Job(), overrides = {}) {
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
    authorizedAt: T0,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null,
    ...overrides
  };
}

function c2CredentialBinding(softwareJob = c2Job(), overrides = {}) {
  const binding = softwareJob.scopeBinding;
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:oss:repo",
    credentialAlias: binding.credentialAlias,
    status: "active",
    provider: "oss",
    platform: binding.platform,
    storeRef: structuredClone(binding.storeRef),
    sideEffectScope: binding.sideEffectScope,
    allowedStableAssetHosts: structuredClone(binding.allowedStableAssetHosts),
    allowedWorkerIds: ["worker-stable-transport-1"],
    redaction: "credential_alias_only",
    boundAt: T0,
    expiresAt: null,
    ...overrides
  };
}

function admittedC2Document() {
  const softwareJob = c2Job();
  const document = {
    candidates: [{ id: softwareJob.candidateId, dataRevision: softwareJob.revision }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [c2AuthorizationRecord(softwareJob)],
      softwareJobCredentialBindings: [c2CredentialBinding(softwareJob)]
    }
  };
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({
    document,
    job: softwareJob,
    observedAt: T0,
    phase: "enqueue_current"
  });
  document.runtime.softwareJobs = [structuredClone(admittedJob)];
  return { document, job: admittedJob };
}

async function completedEnvelope(store, jobId = "job-1", resultRef = "receipt:C-1:1") {
  const currentJob = await store.get(jobId);
  return createSoftwareJobResultEnvelope({
    job: currentJob,
    resultRef,
    payloadKind: currentJob.jobType,
    payload: { schemaVersion: "test-software-job-result-v1", status: "verified" },
    recordedAt: T0,
    applicationDisposition: "result_recorded_no_candidate_mutation"
  });
}

test("无遗留作业的服务重启收口为零写入", async () => {
  const stateRepository = repository();
  const before = await stateRepository.readSnapshot();
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  assert.deepEqual(await store.reconcileAfterRestart(), { reconciled: [] });
  assert.deepEqual(await stateRepository.readSnapshot(), before);
});

test("混合Worker按jobType过滤后再取limit，前序C2不会饿死C1", async () => {
  const c1 = job();
  const c2 = c2Job();
  const descriptor = createWorkerDescriptor({ workerId: "worker-seerfar-open-api-1", capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY, "stable-asset-transport"], version: "1.0.0", observedAt: T0 });
  const binding = c2CredentialBinding(c2, { allowedWorkerIds: [descriptor.workerId] });
  const state = createMemoryBusinessStateRepository({
    candidates: [{ id: c1.candidateId, dataRevision: c1.revision }, { id: c2.candidateId, dataRevision: c2.revision }],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [c1AuthorizationRecord(c1), c2AuthorizationRecord(c2)],
      softwareJobCredentialBindings: [c1CredentialBinding(c1), binding] }
  });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: state, serverClock: () => T0,
    workerRegistry: workerRegistry({ capabilities: descriptor.capabilities }) });
  await store.enqueue(c2);
  await store.enqueue(c1);
  assert.deepEqual((await store.listAssignable({ worker: descriptor, limit: 1 })).map((entry) => entry.jobId), [c2.jobId]);
  assert.deepEqual((await store.listAssignable({ worker: descriptor, limit: 1, jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE })).map((entry) => entry.jobId), [c1.jobId]);
  assert.deepEqual((await store.listAssignableWithDiagnostics({ worker: descriptor, jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE })).assignable.map((entry) => entry.jobId), [c1.jobId]);
  await assert.rejects(store.listAssignable({ worker: descriptor, jobType: "unknown" }), /JOB_TYPE_INVALID/);
});

test("Repository作业存储持久化幂等信息，双领取只有一个成功", async () => {
  const stateRepository = repository();
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  assert.equal((await store.enqueue(job())).status, "queued");
  assert.equal((await store.enqueue(job())).jobId, "job-1");
  await assert.rejects(() => store.enqueue(job("job-2")), /SOFTWARE_JOB_IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => store.enqueue({
    ...job("job-stale", "stale"), revision: 8
  }), /SOFTWARE_JOB_REVISION_CONFLICT/);
  const results = await Promise.allSettled([
    store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-1", leaseDurationMs: 60_000 }),
    store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-2", leaseDurationMs: 60_000 })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await store.get("job-1")).attempt, 1);
});

test("排队后候选revision变化时不再展示或领取旧作业", async () => {
  const stateRepository = repository();
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  await store.enqueue(job());
  await stateRepository.transact(async (document) => {
    document.candidates[0].dataRevision = 10;
    return { changed: true, document, result: null };
  });
  assert.deepEqual(await store.listAssignable({ worker: worker() }), []);
  await assert.rejects(() => store.claim({
    jobId: "job-1", worker: worker(), leaseId: "lease-stale", leaseDurationMs: 60_000
  }), /SOFTWARE_JOB_REVISION_CONFLICT/);
  assert.deepEqual([(await store.get("job-1")).status, (await store.get("job-1")).attempt], ["queued", 0]);
});

test("Repository在展示、领取和重启收口前统一校验serverClock且非法时间零写入", async () => {
  for (const invalidClockValue of ["not-a-date", new Date(Number.NaN)]) {
    for (const scenario of [
      {
        name: "enqueue",
        repository: () => repository(),
        run: (store) => store.enqueue(job())
      },
      {
        name: "listAssignable",
        repository: () => repositoryWithJobs([job()]),
        run: (store) => store.listAssignable({ worker: worker() })
      },
      {
        name: "claim",
        repository: () => repositoryWithJobs([job()]),
        run: (store) => store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-invalid-clock", leaseDurationMs: 60_000 })
      },
      {
        name: "recordProgress",
        repository: () => repositoryWithJobs([claimedJobFixture()]),
        run: (store) => store.recordProgress({
          jobId: "job-claimed",
          workerId: "worker-seerfar-open-api-1",
          leaseId: "lease-claimed",
          progressRef: "progress:C-1:invalid-clock"
        })
      },
      {
        name: "markExternalRequestStarted",
        repository: () => repositoryWithJobs([claimedJobFixture()]),
        run: (store) => store.markExternalRequestStarted({
          jobId: "job-claimed",
          workerId: "worker-seerfar-open-api-1",
          leaseId: "lease-claimed",
          externalRequestRef: "request:C-1:invalid-clock"
        })
      },
      {
        name: "settle",
        repository: () => repositoryWithJobs([waitingPlatformJobFixture()]),
        run: (store) => store.settle({
          jobId: "job-claimed",
          workerId: "worker-seerfar-open-api-1",
          leaseId: "lease-claimed",
          status: "failed",
          externalRequestState: "failed",
          failureClass: "transport_failed",
          externalRequestRef: "request:C-1:claimed"
        })
      },
      {
        name: "reconcileAfterRestart",
        repository: () => repositoryWithJobs([claimedJobFixture()]),
        run: (store) => store.reconcileAfterRestart()
      },
      {
        name: "reconcileExpiredLeases",
        repository: () => repositoryWithJobs([claimedJobFixture({ leaseExpiresAt: "2026-08-25T04:59:00.000Z" })]),
        run: (store) => store.reconcileExpiredLeases()
      }
    ]) {
      const stateRepository = scenario.repository();
      const before = await stateRepository.readSnapshot();
      const { clock, calls } = countedClock(invalidClockValue);
      const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: clock, workerRegistry: workerRegistry({ clock: () => T0 }) });
      await assert.rejects(() => scenario.run(store), /SOFTWARE_JOB_STORE_CLOCK_INVALID/, scenario.name);
      assert.equal(calls(), 1, scenario.name);
      assert.deepEqual(await stateRepository.readSnapshot(), before, scenario.name);
    }
  }
});

test("Repository每个领取操作只读取一次规范化serverClock", async () => {
  const stateRepository = repositoryWithJobs([job()]);
  const { clock, calls } = countedClock(T0);
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: clock, workerRegistry: workerRegistry() });
  const claimed = await store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-single-clock", leaseDurationMs: 60_000 });
  assert.equal(calls(), 1);
  assert.deepEqual([claimed.startedAt, claimed.lastProgressAt, claimed.leaseExpiresAt], [
    T0,
    T0,
    "2026-08-25T05:01:00.000Z"
  ]);
});

test("Repository写事务进入串行事务当前快照后才读取serverClock", async () => {
  const lockedAt = "2026-08-25T05:00:30.000Z";
  for (const scenario of [
    {
      name: "enqueue",
      repository: () => repository(),
      run: (store) => store.enqueue(job()),
      assertResult: (result) => assert.equal(result.status, "queued")
    },
    {
      name: "claim",
      repository: () => repositoryWithJobs([job()]),
      run: (store) => store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-lock-time", leaseDurationMs: 60_000 }),
      assertResult: (result) => assert.equal(result.startedAt, lockedAt)
    },
    {
      name: "reconcileAfterRestart",
      repository: () => repositoryWithJobs([claimedJobFixture()]),
      run: (store) => store.reconcileAfterRestart(),
      assertResult: async (_result, stateRepository) => {
        const reconciledJob = (await stateRepository.readSnapshot()).runtime.softwareJobs[0];
        assert.deepEqual([reconciledJob.status, reconciledJob.completedAt, reconciledJob.lastProgressAt], ["failed", lockedAt, lockedAt]);
      }
    }
  ]) {
    const stateRepository = scenario.repository();
    const { clock, set, calls } = mutableCountedClock(T0);
    const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: clock, workerRegistry: workerRegistry() });
    const { release, blocker } = await holdRepositoryQueue(stateRepository);
    const pending = scenario.run(store);
    assert.equal(calls(), 0, scenario.name);
    set(lockedAt);
    release();
    await blocker;
    const result = await pending;
    assert.equal(calls(), 1, scenario.name);
    await scenario.assertResult(result, stateRepository);
  }
});

function claimedAdmittedC2Document({
  leaseExpiresAt = "2026-08-25T05:01:00.000Z",
  authorizationExpiresAt = null,
  credentialExpiresAt = null
} = {}) {
  const softwareJob = c2Job();
  const document = {
    candidates: [{ id: softwareJob.candidateId, dataRevision: softwareJob.revision }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [c2AuthorizationRecord(softwareJob, { expiresAt: authorizationExpiresAt })],
      softwareJobCredentialBindings: [c2CredentialBinding(softwareJob, { expiresAt: credentialExpiresAt })]
    }
  };
  const admittedJob = bindSoftwareJobAdmissionForEnqueue({
    document,
    job: softwareJob,
    observedAt: T0,
    phase: "enqueue_current"
  });
  document.runtime.softwareJobs[0] = {
    ...structuredClone(admittedJob),
    status: "claimed",
    startedAt: T0,
    lastProgressAt: T0,
    workerId: "worker-stable-transport-1",
    workerVersion: "1.0.0",
    workerCapabilitiesSnapshot: ["stable-asset-transport"],
    leaseId: "lease-expiring-before-request",
    leaseExpiresAt,
    attempt: 1,
    externalRequestState: "not_sent",
    externalRequestRef: null
  };
  return { document, admittedJob };
}

async function assertQueuedExternalStartRejected({ document, admittedJob, lockedAt, errorPattern }) {
  let registryNow = "2026-08-25T05:00:30.000Z";
  const stateRepository = createMemoryBusinessStateRepository(document);
  const before = await stateRepository.readSnapshot();
  const { clock, set, calls } = mutableCountedClock(registryNow);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: clock,
    workerRegistry: c2WorkerRegistry({ clock: () => registryNow, heartbeatTtlMs: 10 * 60_000 })
  });

  const { release, blocker } = await holdRepositoryQueue(stateRepository);
  const pending = store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-expiring-before-request",
    externalRequestRef: "request:must-not-start"
  });
  assert.equal(calls(), 0);
  registryNow = lockedAt;
  set(registryNow);
  release();
  await blocker;
  await assert.rejects(pending, errorPattern);
  assert.equal(calls(), 1);
  const after = await stateRepository.readSnapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(
    after.runtime.softwareJobs.map((entry) => [entry.jobId, entry.status, entry.externalRequestState, entry.externalRequestRef]),
    [[admittedJob.jobId, "claimed", "not_sent", null]]
  );
}

test("markExternalRequestStarted排队跨过授权到期后按锁内时间拒绝且零外部请求", async () => {
  await assertQueuedExternalStartRejected({
    ...claimedAdmittedC2Document({
      leaseExpiresAt: "2026-08-25T05:03:00.000Z",
      authorizationExpiresAt: "2026-08-25T05:01:00.000Z"
    }),
    lockedAt: "2026-08-25T05:02:00.000Z",
    errorPattern: /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED/
  });
});

test("markExternalRequestStarted排队跨过凭据到期后按锁内时间拒绝且零外部请求", async () => {
  await assertQueuedExternalStartRejected({
    ...claimedAdmittedC2Document({
      leaseExpiresAt: "2026-08-25T05:03:00.000Z",
      credentialExpiresAt: "2026-08-25T05:01:00.000Z"
    }),
    lockedAt: "2026-08-25T05:02:00.000Z",
    errorPattern: /SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED/
  });
});

test("markExternalRequestStarted排队跨过租约到期后按锁内时间拒绝且零外部请求", async () => {
  await assertQueuedExternalStartRejected({
    ...claimedAdmittedC2Document({ leaseExpiresAt: "2026-08-25T05:01:00.000Z" }),
    lockedAt: "2026-08-25T05:02:00.000Z",
    errorPattern: /租约已过期/
  });
});

test("markExternalRequestStarted排队后锁内时间未过期时只启动一次外部请求", async () => {
  let registryNow = "2026-08-25T05:00:00.000Z";
  const { document, admittedJob } = claimedAdmittedC2Document({
    leaseExpiresAt: "2026-08-25T05:03:00.000Z",
    authorizationExpiresAt: "2026-08-25T05:03:00.000Z",
    credentialExpiresAt: "2026-08-25T05:03:00.000Z"
  });
  const stateRepository = createMemoryBusinessStateRepository(document);
  const { clock, set, calls } = mutableCountedClock(registryNow);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: clock,
    workerRegistry: c2WorkerRegistry({ clock: () => registryNow, heartbeatTtlMs: 10 * 60_000 })
  });
  const { release, blocker } = await holdRepositoryQueue(stateRepository);
  const pending = store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-expiring-before-request",
    externalRequestRef: "request:started-once"
  });
  assert.equal(calls(), 0);
  registryNow = "2026-08-25T05:02:00.000Z";
  set(registryNow);
  release();
  await blocker;
  const started = await pending;
  assert.equal(calls(), 1);
  assert.deepEqual([started.status, started.externalRequestState, started.externalRequestRef, started.lastProgressAt], [
    "waiting_platform",
    "in_flight",
    "request:started-once",
    registryNow
  ]);
  const persisted = (await stateRepository.readSnapshot()).runtime.softwareJobs[0];
  assert.deepEqual([persisted.status, persisted.externalRequestState, persisted.externalRequestRef, persisted.lastProgressAt], [
    "waiting_platform",
    "in_flight",
    "request:started-once",
    registryNow
  ]);
});

test("SoftwareJob重启与过期租约收口统一走contract状态机并保留scope", () => {
  const notSent = claimedJobFixture();
  const restartedBeforeRequest = reconcileSoftwareJobAfterRestart({ job: notSent, serverTime: T0 });
  assert.deepEqual(
    [restartedBeforeRequest.status, restartedBeforeRequest.externalRequestState, restartedBeforeRequest.failureClass, restartedBeforeRequest.automaticRetryAllowed],
    ["failed", "not_sent", "service_restart_before_external_request", false]
  );

  const inFlight = waitingPlatformJobFixture();
  const restartedAfterRequest = reconcileSoftwareJobAfterRestart({ job: inFlight, serverTime: T0 });
  assert.deepEqual(
    [restartedAfterRequest.status, restartedAfterRequest.externalRequestState, restartedAfterRequest.failureClass, restartedAfterRequest.automaticRetryAllowed],
    ["unknown_outcome", "unknown_outcome", "service_restart_after_external_request", false]
  );

  const expiredBeforeRequest = reconcileExpiredSoftwareJobLease({
    job: claimedJobFixture({ leaseExpiresAt: "2026-08-25T04:59:59.000Z" }),
    serverTime: T0
  });
  assert.deepEqual(
    [expiredBeforeRequest.status, expiredBeforeRequest.externalRequestState, expiredBeforeRequest.failureClass],
    ["failed", "not_sent", "lease_expired_before_external_request"]
  );

  const { job: scopedJob } = admittedC2Document();
  const scopedClaimed = {
    ...structuredClone(scopedJob),
    status: "claimed",
    startedAt: T0,
    lastProgressAt: T0,
    workerId: "worker-stable-transport-1",
    workerVersion: "1.0.0",
    workerCapabilitiesSnapshot: ["stable-asset-transport"],
    leaseId: "lease-scoped",
    leaseExpiresAt: "2026-08-25T05:01:00.000Z",
    attempt: 1,
    externalRequestState: "not_sent",
    externalRequestRef: null
  };
  const scopedReconciled = reconcileSoftwareJobAfterRestart({ job: scopedClaimed, serverTime: T0 });
  assert.deepEqual(scopedReconciled.scopeBinding, scopedClaimed.scopeBinding);
  assert.deepEqual(scopedReconciled.admissionDecision, scopedClaimed.admissionDecision);

  assert.throws(() => reconcileSoftwareJobAfterRestart({
    job: claimedJobFixture({ externalRequestState: "in_flight", externalRequestRef: "request:bad-combo" }),
    serverTime: T0
  }), /SOFTWARE_JOB_RECONCILIATION_REJECTED/);
  assert.throws(() => reconcileSoftwareJobAfterRestart({
    job: waitingPlatformJobFixture({ externalRequestState: "not_sent", externalRequestRef: null }),
    serverTime: T0
  }), /SOFTWARE_JOB_RECONCILIATION_REJECTED/);
  assert.throws(() => reconcileExpiredSoftwareJobLease({
    job: claimedJobFixture({ leaseExpiresAt: "2026-08-25T05:01:00.000Z" }),
    serverTime: T0
  }), /SOFTWARE_JOB_LEASE_NOT_EXPIRED/);
});

test("领取后revision变化时外部请求门禁拒绝且仍保持not_sent", async () => {
  const stateRepository = repository();
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  await store.enqueue(job());
  await store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-1", leaseDurationMs: 60_000 });
  await stateRepository.transact(async (document) => {
    document.candidates[0].dataRevision = 10;
    return { changed: true, document, result: null };
  });
  await assert.rejects(() => store.markExternalRequestStarted({
    jobId: "job-1", workerId: "worker-seerfar-open-api-1", leaseId: "lease-1", externalRequestRef: "request:stale"
  }), /SOFTWARE_JOB_REVISION_CONFLICT/);
  const current = await store.get("job-1");
  assert.deepEqual([current.status, current.externalRequestState, current.externalRequestRef], ["claimed", "not_sent", null]);
});

test("候选已绑定其他SKU时旧作业在领取前明确拒绝", async () => {
  const stateRepository = createMemoryBusinessStateRepository({
    candidates: [{
      id: "C-1",
      dataRevision: 9,
      lifecycleV11: { skuPackage: { skuPackageId: "sku:C-1:OTHER" } }
    }]
  });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  await assert.rejects(() => store.enqueue(job()), /SOFTWARE_JOB_SKU_CONFLICT/);
});

test("作业进度和外部请求终态持久化，领域完成不能绕过事务，租约过期不能写入", async () => {
  let now = T0;
  const stateRepository = repository();
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => now, workerRegistry: workerRegistry() });
  await store.enqueue(job());
  await store.claim({ jobId: "job-1", worker: worker(), leaseId: "lease-1", leaseDurationMs: 60_000 });
  now = "2026-08-25T05:00:10.000Z";
  await store.recordProgress({ jobId: "job-1", workerId: "worker-seerfar-open-api-1", leaseId: "lease-1", progressRef: "progress:C-1:1" });
  await store.markExternalRequestStarted({
    jobId: "job-1", workerId: "worker-seerfar-open-api-1", leaseId: "lease-1", externalRequestRef: "request:C-1:1"
  });
  assert.deepEqual(
    [(await store.get("job-1")).status, (await store.get("job-1")).externalRequestState],
    ["waiting_platform", "in_flight"]
  );
  now = "2026-08-25T05:00:20.000Z";
  const resultEnvelope = await completedEnvelope(store);
  await assert.rejects(() => store.settle({
    jobId: "job-1", workerId: "worker-seerfar-open-api-1", leaseId: "lease-1",
    status: "completed", externalRequestState: "succeeded", resultRef: "receipt:C-1:1",
    resultEnvelope
  }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
  assert.deepEqual(
    [(await store.get("job-1")).status, (await store.get("job-1")).externalRequestState, (await store.get("job-1")).resultRef],
    ["waiting_platform", "in_flight", null]
  );

  const second = job("job-2", "C-1:10:keywords", { sourceRevision: 9, resultRevision: 10 });
  const revisionTenRepository = createMemoryBusinessStateRepository({
    candidates: [{ id: "C-1", dataRevision: 10 }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [c1AuthorizationRecord(second)],
      softwareJobCredentialBindings: [c1CredentialBinding(second)]
    }
  });
  const revisionTenStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: revisionTenRepository, serverClock: () => now, workerRegistry: workerRegistry() });
  await revisionTenStore.enqueue(second);
  await revisionTenStore.claim({ jobId: "job-2", worker: worker(), leaseId: "lease-2", leaseDurationMs: 60_000 });
  now = "2026-08-25T05:02:00.000Z";
  await assert.rejects(() => revisionTenStore.recordProgress({
    jobId: "job-2", workerId: "worker-seerfar-open-api-1", leaseId: "lease-2", progressRef: "too-late"
  }), /租约已过期/);
});

test("服务重启时已领取但未发外部请求记failed，已发请求记unknown_outcome，均不自动重试", async () => {
  const beforeJob = job("job-before", "before", {
    candidateId: "C-before",
    skuPackageId: "sku:C-before:S-1",
    supplierSkuId: "supplier-before"
  });
  const afterJob = job("job-after", "after", {
    candidateId: "C-after",
    skuPackageId: "sku:C-after:S-1",
    supplierSkuId: "supplier-after"
  });
  const stateRepository = repositoryForEnqueueableC1Jobs([beforeJob, afterJob]);
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => T0, workerRegistry: workerRegistry() });
  await store.enqueue(beforeJob);
  await store.enqueue(afterJob);
  await store.claim({ jobId: "job-before", worker: worker(), leaseId: "lease-before", leaseDurationMs: 60_000 });
  await store.claim({ jobId: "job-after", worker: worker(), leaseId: "lease-after", leaseDurationMs: 60_000 });
  await store.markExternalRequestStarted({
    jobId: "job-after", workerId: "worker-seerfar-open-api-1", leaseId: "lease-after", externalRequestRef: "request:after"
  });
  const result = await store.reconcileAfterRestart();
  assert.deepEqual(result.reconciled.sort(), ["job-after", "job-before"]);
  const before = await store.get("job-before");
  const after = await store.get("job-after");
  assert.deepEqual([before.status, before.externalRequestState, before.automaticRetryAllowed], ["failed", "not_sent", false]);
  assert.deepEqual([after.status, after.externalRequestState, after.automaticRetryAllowed], ["unknown_outcome", "unknown_outcome", false]);
  assert.deepEqual((await store.listWaitingPlatform()).map((entry) => entry.jobId), []);
});

test("服务运行期间租约过期按外部请求终态收口，不改变候选业务状态", async () => {
  let now = T0;
  const beforeJob = job("job-before", "lease-before", {
    candidateId: "C-before",
    skuPackageId: "sku:C-before:S-1",
    supplierSkuId: "supplier-before"
  });
  const afterJob = job("job-after", "lease-after", {
    candidateId: "C-after",
    skuPackageId: "sku:C-after:S-1",
    supplierSkuId: "supplier-after"
  });
  const stateRepository = repositoryForEnqueueableC1Jobs([beforeJob, afterJob]);
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: stateRepository, serverClock: () => now, workerRegistry: workerRegistry() });
  await store.enqueue(beforeJob);
  await store.enqueue(afterJob);
  await store.claim({ jobId: "job-before", worker: worker(), leaseId: "lease-before", leaseDurationMs: 60_000 });
  await store.claim({ jobId: "job-after", worker: worker(), leaseId: "lease-after", leaseDurationMs: 60_000 });
  await store.markExternalRequestStarted({
    jobId: "job-after", workerId: "worker-seerfar-open-api-1", leaseId: "lease-after", externalRequestRef: "request:after"
  });
  const candidateBefore = (await stateRepository.readSnapshot()).candidates[0];
  now = "2026-08-25T05:01:01.000Z";
  assert.deepEqual((await store.reconcileExpiredLeases()).reconciled.sort(), ["job-after", "job-before"]);
  const before = await store.get("job-before");
  const after = await store.get("job-after");
  assert.deepEqual([before.status, before.externalRequestState], ["failed", "not_sent"]);
  assert.deepEqual([after.status, after.externalRequestState], ["unknown_outcome", "unknown_outcome"]);
  assert.equal(before.automaticRetryAllowed, false);
  assert.equal(after.automaticRetryAllowed, false);
  assert.deepEqual((await store.listWaitingPlatform()).map((entry) => entry.jobId), []);
  assert.deepEqual((await stateRepository.readSnapshot()).candidates[0], candidateBefore);
});

test("可领取列表不得把授权或凭据缺口伪装成无作业", async () => {
  const sha = "a".repeat(64);
  const scopeBinding = {
    schemaVersion: "software-job-scope-v1",
    candidateId: "C-2",
    skuPackageId: "sku:C-2:S-1",
    sourceRevision: 7,
    resultRevision: 8,
    platform: "ozon",
    storeRef: { stableStoreId: "store:ozon:one", platformStoreId: "seller-one", mappingVersion: "stores-v1" },
    supplierSkuId: "supplier-sku-1",
    variantKey: "white",
    sideEffectScope: "c2_stable_asset_transport",
    authorizationRef: "transport-authz:c2:repo-list",
    credentialAlias: "credential-alias:oss:repo-list",
    inputFingerprint: sha,
    stagedAssetManifestFingerprint: "b".repeat(64),
    ownerStagingConfirmationRef: "owner-confirmation:c2-staging:repo-list",
    allowedStableAssetHosts: ["assets.example.com"]
  };
  const queuedJob = createSoftwareJobEnvelope({
    jobId: `software-job:c2-stable-asset-transport:${sha}`,
    candidateId: "C-2",
    skuPackageId: "sku:C-2:S-1",
    revision: 8,
    jobType: "c2_stable_asset_transport",
    createdAt: T0,
    requestedByUserId: "owner-1",
    ownerUserId: "owner-1",
    requiredCapabilities: ["stable-asset-transport"],
    idempotencyKey: `c2-stable-asset-transport:${sha}`,
    scopeBinding
  });
  const c2Worker = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: T0
  });
  const repositoryWithoutAuthorization = createMemoryBusinessStateRepository({
    candidates: [{ id: "C-2", dataRevision: 8 }],
    runtime: {
      softwareJobs: [queuedJob],
      softwareJobAuthorizationRecords: [],
      softwareJobCredentialBindings: []
    }
  });
  const storeWithoutAuthorization = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repositoryWithoutAuthorization,
    serverClock: () => T0,
    workerRegistry: c2WorkerRegistry()
  });
  assert.deepEqual(await storeWithoutAuthorization.listAssignable({ worker: c2Worker }), []);
  const missingAuthorizationDiagnostics = await storeWithoutAuthorization.listAssignableWithDiagnostics({ worker: c2Worker });
  assert.deepEqual(missingAuthorizationDiagnostics.assignable, []);
  assert.deepEqual(
    missingAuthorizationDiagnostics.rejected.map((entry) => [entry.jobId, entry.reasonCode]),
    [[queuedJob.jobId, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED"]]
  );

  const goodSha = "c".repeat(64);
  const goodJob = c2Job({
    jobId: `software-job:c2-stable-asset-transport:${goodSha}`,
    idempotencyKey: `c2-stable-asset-transport:${goodSha}`,
    scope: {
      inputFingerprint: goodSha,
      authorizationRef: "transport-authz:c2:repo-list-good",
      credentialAlias: "credential-alias:oss:repo-list-good"
    }
  });
  const poisonDocument = {
    candidates: [{ id: "C-2", dataRevision: 8 }],
    runtime: {
      softwareJobs: [],
      softwareJobAuthorizationRecords: [c2AuthorizationRecord(goodJob)],
      softwareJobCredentialBindings: [c2CredentialBinding(goodJob)]
    }
  };
  const admittedGoodJob = bindSoftwareJobAdmissionForEnqueue({
    document: poisonDocument,
    job: goodJob,
    observedAt: T0,
    phase: "enqueue_current"
  });
  poisonDocument.runtime.softwareJobs = [queuedJob, structuredClone(admittedGoodJob)];
  const poisonRepository = createMemoryBusinessStateRepository(poisonDocument);
  const poisonStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: poisonRepository,
    serverClock: () => T0,
    workerRegistry: c2WorkerRegistry()
  });
  const poisonDiagnostics = await poisonStore.listAssignableWithDiagnostics({ worker: c2Worker, limit: 10 });
  assert.deepEqual(poisonDiagnostics.assignable.map((entry) => entry.jobId), [goodJob.jobId]);
  assert.deepEqual(
    poisonDiagnostics.rejected.map((entry) => [entry.jobId, entry.reasonCode]),
    [[queuedJob.jobId, "SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED"]]
  );

  const validAuthorization = {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: scopeBinding.authorizationRef,
    status: "active",
    action: "c2_stable_asset_transport",
    candidateId: scopeBinding.candidateId,
    skuPackageId: scopeBinding.skuPackageId,
    sourceRevision: scopeBinding.sourceRevision,
    resultRevision: scopeBinding.resultRevision,
    platform: scopeBinding.platform,
    storeRef: structuredClone(scopeBinding.storeRef),
    supplierSkuId: scopeBinding.supplierSkuId,
    variantKey: scopeBinding.variantKey,
    sideEffectScope: scopeBinding.sideEffectScope,
    stagedAssetManifestFingerprint: scopeBinding.stagedAssetManifestFingerprint,
    ownerStagingConfirmationRef: scopeBinding.ownerStagingConfirmationRef,
    allowedStableAssetHosts: structuredClone(scopeBinding.allowedStableAssetHosts),
    authorizedByUserId: "owner-1",
    authorizedAt: T0,
    expiresAt: null,
    maxUses: 1,
    useCount: 1,
    consumedByJobId: queuedJob.jobId,
    consumedAt: T0
  };
  const workerSpecificRepository = createMemoryBusinessStateRepository({
    candidates: [{ id: "C-2", dataRevision: 8 }],
    runtime: {
      softwareJobs: [queuedJob],
      softwareJobAuthorizationRecords: [validAuthorization],
      softwareJobCredentialBindings: [{
        schemaVersion: "software-job-credential-binding-v1",
        bindingId: "credential-binding:oss:repo-list",
        credentialAlias: scopeBinding.credentialAlias,
        status: "active",
        provider: "oss",
        platform: scopeBinding.platform,
        storeRef: structuredClone(scopeBinding.storeRef),
        sideEffectScope: scopeBinding.sideEffectScope,
        allowedStableAssetHosts: structuredClone(scopeBinding.allowedStableAssetHosts),
        allowedWorkerIds: ["worker-other"],
        redaction: "credential_alias_only",
        boundAt: T0,
        expiresAt: null
      }]
    }
  });
  const workerSpecificStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: workerSpecificRepository,
    serverClock: () => T0,
    workerRegistry: c2WorkerRegistry()
  });
  assert.deepEqual(await workerSpecificStore.listAssignable({ worker: c2Worker }), []);
});

test("C2副作用作业领取只信任WorkerRegistry当前事实并冻结版本能力快照", async () => {
  const { document, job: admittedJob } = admittedC2Document();
  const registry = c2WorkerRegistry({
    capabilities: ["image-processing", "stable-asset-transport"],
    version: "registry-1.0.0"
  });
  const stateRepository = createMemoryBusinessStateRepository(document);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: () => T0,
    workerRegistry: registry
  });
  const fakeDescriptor = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["image-processing"],
    version: "fake-9.9.9",
    observedAt: T0
  });
  assert.deepEqual((await store.listAssignable({ worker: fakeDescriptor })).map((entry) => entry.jobId), [admittedJob.jobId]);
  const claimed = await store.claim({
    jobId: admittedJob.jobId,
    worker: fakeDescriptor,
    leaseId: "lease-registry",
    leaseDurationMs: 60_000
  });
  assert.equal(claimed.workerVersion, "registry-1.0.0");
  assert.deepEqual(claimed.workerCapabilitiesSnapshot, ["image-processing", "stable-asset-transport"]);
  registry.markOffline("worker-stable-transport-1");
  await assert.rejects(() => store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-registry",
    externalRequestRef: "request:registry-offline"
  }), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);
  assert.deepEqual([(await store.get(admittedJob.jobId)).status, (await store.get(admittedJob.jobId)).externalRequestState], ["claimed", "not_sent"]);
});

test("C2副作用作业在过期心跳或领取后版本能力撤销时零外部请求", async () => {
  let now = T0;
  const { document: staleDocument, job: staleJob } = admittedC2Document();
  const staleRegistry = c2WorkerRegistry({ clock: () => now, heartbeatTtlMs: 1_000 });
  now = "2026-08-25T05:00:02.000Z";
  const staleStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: createMemoryBusinessStateRepository(staleDocument),
    serverClock: () => now,
    workerRegistry: staleRegistry
  });
  const staleWorkerDescriptor = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: T0
  });
  assert.deepEqual(await staleStore.listAssignable({ worker: staleWorkerDescriptor }), []);
  await assert.rejects(() => staleStore.claim({
    jobId: staleJob.jobId,
    worker: staleWorkerDescriptor,
    leaseId: "lease-stale-registry",
    leaseDurationMs: 60_000
  }), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);

  now = T0;
  const { document: revokedDocument, job: revokedJob } = admittedC2Document();
  const revokedRegistry = c2WorkerRegistry({ clock: () => now });
  const revokedStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: createMemoryBusinessStateRepository(revokedDocument),
    serverClock: () => now,
    workerRegistry: revokedRegistry
  });
  await revokedStore.claim({
    jobId: revokedJob.jobId,
    worker: createWorkerDescriptor({
      workerId: "worker-stable-transport-1",
      capabilities: ["stable-asset-transport"],
      version: "1.0.0",
      observedAt: T0
    }),
    leaseId: "lease-revoked",
    leaseDurationMs: 60_000
  });
  revokedRegistry.heartbeat({
    workerId: "worker-stable-transport-1",
    capabilities: ["image-processing"],
    version: "registry-1.0.1",
    status: "online"
  });
  await assert.rejects(() => revokedStore.markExternalRequestStarted({
    jobId: revokedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-revoked",
    externalRequestRef: "request:revoked"
  }), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);
  assert.deepEqual([(await revokedStore.get(revokedJob.jobId)).status, (await revokedStore.get(revokedJob.jobId)).externalRequestState], ["claimed", "not_sent"]);
});

test("泛型Repository settlement不能伪造C2领域完成回执", async () => {
  const { document, job: admittedJob } = admittedC2Document();
  const registry = c2WorkerRegistry();
  const stateRepository = createMemoryBusinessStateRepository(document);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: () => T0,
    workerRegistry: registry
  });
  await store.claim({
    jobId: admittedJob.jobId,
    worker: createWorkerDescriptor({
      workerId: "worker-stable-transport-1",
      capabilities: ["stable-asset-transport"],
      version: "1.0.0",
      observedAt: T0
    }),
    leaseId: "lease-generic-settle",
    leaseDurationMs: 60_000
  });
  await store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-generic-settle",
    externalRequestRef: "request:generic-settle"
  });
  const envelope = createSoftwareJobResultEnvelope({
    job: await store.get(admittedJob.jobId),
    resultRef: "receipt:generic-settle",
    payloadKind: "c2_stable_asset_transport",
    payload: { schemaVersion: "fake-c2-stable-asset-transport-result-v1", status: "verified" },
    recordedAt: T0
  });
  await assert.rejects(() => store.settle({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-generic-settle",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:generic-settle",
    resultEnvelope: envelope
  }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
  assert.deepEqual([(await store.get(admittedJob.jobId)).status, (await store.get(admittedJob.jobId)).externalRequestState], ["waiting_platform", "in_flight"]);
});

test("泛型Repository settlement不能伪造C1付费关键词领域完成回执", async () => {
  const admittedJob = admittedC1Job(job("job-generic-c1-settle", "C-1:9:keywords:generic-c1-settle"));
  const stateRepository = repositoryWithJobs([admittedJob]);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: () => T0,
    workerRegistry: workerRegistry()
  });
  await store.claim({
    jobId: admittedJob.jobId,
    worker: worker(),
    leaseId: "lease-generic-c1-settle",
    leaseDurationMs: 60_000
  });
  await store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-seerfar-open-api-1",
    leaseId: "lease-generic-c1-settle",
    externalRequestRef: "request:generic-c1-settle"
  });
  const waitingJob = await store.get(admittedJob.jobId);
  const envelope = createSoftwareJobResultEnvelope({
    job: waitingJob,
    resultRef: "receipt:generic-c1-settle",
    payloadKind: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE,
    payload: { schemaVersion: "fake-c1-paid-keyword-result-v1", status: "verified" },
    recordedAt: T0
  });
  await assert.rejects(() => store.settle({
    jobId: admittedJob.jobId,
    workerId: "worker-seerfar-open-api-1",
    leaseId: "lease-generic-c1-settle",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:generic-c1-settle",
    resultEnvelope: envelope
  }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
  assert.deepEqual([(await store.get(admittedJob.jobId)).status, (await store.get(admittedJob.jobId)).externalRequestState], ["waiting_platform", "in_flight"]);
});

test("公共settle primitive不能靠旧布尔或内部标记伪造C2领域完成回执", async () => {
  const { document, job: admittedJob } = admittedC2Document();
  const registry = c2WorkerRegistry();
  const stateRepository = createMemoryBusinessStateRepository(document);
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: stateRepository,
    serverClock: () => T0,
    workerRegistry: registry
  });
  await store.claim({
    jobId: admittedJob.jobId,
    worker: createWorkerDescriptor({
      workerId: "worker-stable-transport-1",
      capabilities: ["stable-asset-transport"],
      version: "1.0.0",
      observedAt: T0
    }),
    leaseId: "lease-primitive-settle",
    leaseDurationMs: 60_000
  });
  await store.markExternalRequestStarted({
    jobId: admittedJob.jobId,
    workerId: "worker-stable-transport-1",
    leaseId: "lease-primitive-settle",
    externalRequestRef: "request:primitive-settle"
  });
  const claimedJob = await store.get(admittedJob.jobId);
  const forgedEnvelope = createSoftwareJobResultEnvelope({
    job: claimedJob,
    resultRef: "receipt:primitive-settle",
    payloadKind: "c2_stable_asset_transport",
    payload: { schemaVersion: "fake-c2-stable-asset-transport-result-v1", status: "verified" },
    recordedAt: T0
  });
  const forgedSettlement = {
    workerId: "worker-stable-transport-1",
    leaseId: "lease-primitive-settle",
    status: "completed",
    externalRequestState: "succeeded",
    externalRequestRef: "request:primitive-settle",
    resultRef: "receipt:primitive-settle",
    resultEnvelope: forgedEnvelope,
    serverTime: T0,
    allowDomainSettlement: true,
    domainSettlementValidated: true
  };
  assert.throws(() => settleSoftwareJob({
    job: claimedJob,
    ...forgedSettlement
  }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);

  const snapshot = await stateRepository.readSnapshot();
  assert.throws(() => settleSoftwareJobInDocument(snapshot, {
    jobId: admittedJob.jobId,
    ...forgedSettlement
  }, T0, { allowDomainSettlement: true }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
  assert.deepEqual(
    snapshot.runtime.softwareJobs.map((job) => [job.jobId, job.status, job.externalRequestState]),
    [[admittedJob.jobId, "waiting_platform", "in_flight"]]
  );
});
