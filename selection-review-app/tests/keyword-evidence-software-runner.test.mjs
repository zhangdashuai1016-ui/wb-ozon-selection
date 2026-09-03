import assert from "node:assert/strict";
import test from "node:test";

import {
  runC1PaidKeywordEvidenceSoftwareJob,
  runNextC1PaidKeywordEvidenceSoftwareJob,
  runKeywordEvidenceSoftwareJob
} from "../lib/keyword-evidence-software-runner.mjs";
import { enqueueC1PaidKeywordEvidenceJob } from "../lib/c1-keyword-software-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentActor, createWorkerDescriptor } from "../lib/runtime-identity.mjs";
import { C1_PAID_KEYWORD_EVIDENCE_CAPABILITY, C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE } from "../lib/software-job-contract.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { KEYWORD_NOW } from "./fixtures/c1-keyword-planning-fixture.mjs";
import {
  c1PaidKeywordFixtureReceipt,
  c1PaidKeywordSettlementCandidate as genericC1ReadyCandidate,
  prepareC1PaidKeywordSettlementFixture as genericPrepared
} from "./fixtures/c1-paid-keyword-settlement-fixture.mjs";

const NOW = "2026-08-24T11:00:00.000Z";

function skuPackage() {
  return {
    candidateId: "CX-MUSIC-BOX-SOFTWARE",
    skuPackageId: "sku:music-box:1",
    businessPhase: "C1",
    c1ProductPlan: { identity: { targetPlatform: "ozon", supplierSkuId: "supplier-music-box-1" } }
  };
}

function runtimeInputTemplate() {
  return {
    schemaVersion: "c1-fact-keyword-runtime-input-v1",
    dataRevision: 12,
    keywordSourceEvidence: {
      fulfillment: "rfbs",
      locale: "ru-RU",
      policy: { browserAllowed: false, browserPreauthorized: false },
      healthPolicy: {},
      frozenEvidence: {}
    },
    frozenSeoRules: { version: "seo-v1" },
    frozenComplexityDecision: null,
    reusableKeywordSnapshot: null,
    keywordExpiresAt: "2026-08-25T11:00:00.000Z",
    providerEvidence: {
      seerfarApiReceipt: null,
      browserReceipt: null,
      standardSkuHealthReceipts: [],
      keywordMetricEvidence: { version: "keyword-metrics-v1" }
    }
  };
}

function job(overrides = {}) {
  return {
    schemaVersion: "keyword-evidence-software-runner-v1",
    jobId: "keyword-job:music-box:12",
    candidateId: "CX-MUSIC-BOX-SOFTWARE",
    dataRevision: 12,
    skuPackageId: "sku:music-box:1",
    startedAt: NOW,
    attemptLimit: 1,
    browserFallbackAllowed: false,
    codexDispatchAllowed: false,
    runtimeInputTemplate: runtimeInputTemplate(),
    seerfarRequest: {
      operation: "reverse_keywords",
      platform: "ozon",
      skuIds: [123456],
      factRefs: ["fact:music-mechanism"],
      competitorRefs: ["competitor:123456"],
      matchType: "exact_match",
      attemptId: "attempt:seerfar:music-box:12",
      queryId: "query:seerfar:music-box:12",
      receiptId: "receipt:seerfar:music-box:12",
      startedAt: NOW
    },
    ...overrides
  };
}

function providerReceipt(overrides = {}) {
  return {
    observation: {
      attemptId: "attempt:seerfar:music-box:12",
      provider: "seerfar-open-api",
      queryId: "query:seerfar:music-box:12",
      requestId: "request:music-box:12",
      receiptId: "receipt:seerfar:music-box:12",
      startedAt: NOW,
      completedAt: NOW,
      traceRef: "seerfar:reverse_keywords:safe",
      completed: true,
      resultCount: 1,
      ...overrides
    },
    candidates: overrides.completed === false ? [] : [{ term: "музыкальная шкатулка", sourceRefs: [], factRefs: ["fact:music-mechanism"], competitorRefs: ["competitor:123456"], sourceTrust: "seerfar_open_api", matchType: "exact_match" }],
    pointsBefore: 100,
    pointsAfter: 85,
    pointsSpent: 15,
    evidence: { evidenceRef: "seerfar:reverse_keywords:safe" }
  };
}

function genericProviderReceipt() {
  const { attempt, candidates, pointsBefore, pointsAfter, pointsSpent, providerEvidence } = c1PaidKeywordFixtureReceipt();
  return {
    observation: {
      attemptId: attempt.attemptId,
      provider: attempt.provider,
      queryId: attempt.queryId,
      requestId: attempt.requestId,
      receiptId: attempt.receiptId,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      traceRef: attempt.traceRef,
      completed: true,
      resultCount: attempt.resultCount
    },
    candidates,
    pointsBefore,
    pointsAfter,
    pointsSpent,
    evidence: providerEvidence
  };
}

function readyRuntime({ input }) {
  return {
    receipt: { receiptFingerprint: "runtime-receipt" },
    result: {
      status: "ready_for_atomic_persist",
      evidenceStage: { evidence: { evidenceFingerprint: "evidence-ready-12" } }
    },
    input
  };
}

function genericWorkerRegistry() {
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => KEYWORD_NOW, heartbeatTtlMs: 60_000 });
  registry.register({
    workerId: "worker-seerfar-open-api-1",
    capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    version: "1.0.0",
    observedAt: KEYWORD_NOW
  });
  return registry;
}

function genericWorker() {
  return createWorkerDescriptor({
    workerId: "worker-seerfar-open-api-1",
    capabilities: [C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],
    version: "1.0.0",
    observedAt: KEYWORD_NOW
  });
}

test("旧关键词runner直接执行入口已退役，不能绕过generic SoftwareJobStore", async () => {
  let calls = 0;
  await assert.rejects(() => runKeywordEvidenceSoftwareJob({
    job: job(),
    skuPackage: skuPackage(),
    openApiTransport: async (request) => {
      calls += 1;
      return providerReceipt();
    }
  }, { prepareRuntime: async (args) => readyRuntime(args) }), /LEGACY_RUNNER_RETIRED/);
  assert.equal(calls, 0);
});

test("旧关键词runner技术失败路径同样退役，不再生成旧C1事件", async () => {
  const failedReceipt = providerReceipt({ completed: false, completedAt: null, resultCount: null, timeout: true });
  let calls = 0;
  await assert.rejects(() => runKeywordEvidenceSoftwareJob({
    job: job(),
    skuPackage: skuPackage(),
    openApiTransport: async () => {
      calls += 1;
      return failedReceipt;
    }
  }, {
    prepareRuntime: async () => ({ result: { status: "not_ready", gaps: [{ code: "keyword_preparation_technical_unavailable" }] }, receipt: {} })
  }), /LEGACY_RUNNER_RETIRED/);
  assert.equal(calls, 0);
});

test("旧runner所有输入都在外部调用前退役拒绝", async () => {
  const cases = [
    job({ dataRevision: 13 }),
    job({ skuPackageId: "sku:other" }),
    job({ browserFallbackAllowed: true }),
    job({ apiKey: "forbidden" })
  ];
  for (const value of cases) {
    let calls = 0;
    await assert.rejects(() => runKeywordEvidenceSoftwareJob({ job: value, skuPackage: skuPackage(), openApiTransport: async () => { calls += 1; return providerReceipt(); } }), /LEGACY_RUNNER_RETIRED/);
    assert.equal(calls, 0);
  }
});

test("generic C1 paid keyword Worker一次明确true_empty回执结合冻结证据，经真实领域流水线原子落盘", async () => {
  const candidate = await genericC1ReadyCandidate();
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
  const enqueue = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:generic-c1-worker" }),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => KEYWORD_NOW,
    workerRegistry: genericWorkerRegistry()
  });
  let calls = 0;
  const result = await runC1PaidKeywordEvidenceSoftwareJob({
    repository,
    softwareJobStore: store,
    worker: genericWorker(),
    jobId: enqueue.result.softwareJobRef.jobId,
    leaseId: "lease:generic-c1-worker",
    leaseDurationMs: 60_000,
    openApiTransport: async (request) => {
      calls += 1;
      assert.equal(request.identity.candidateId, candidate.id);
      assert.equal(request.identity.dataRevision, candidate.dataRevision + 1);
      assert.equal(request.seerfarRequest.operation, "reverse_keywords");
      return genericProviderReceipt();
    },
    serverClock: () => KEYWORD_NOW
  }, {
    prepareRuntime: async (args) => genericPrepared(args)
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "committed");
  assert.equal(result.result.status, "verified");
  assert.deepEqual([
    result.result.productionAuthorizationCreated,
    result.result.dHandoffCreated,
    result.result.productionPlanCreated,
    result.result.executionIntentCreated,
    result.result.platformWrites
  ], [false, false, false, false, 0]);
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.softwareJobs[0].status, "completed");
  assert.equal(stored.runtime.softwareJobs[0].externalRequestState, "succeeded");
  const apiAttempt = stored.candidates[0].lifecycleV11.keywordEvidencePreparationV1.sourceAttempts.find((attempt) => attempt.channel === "api");
  assert.equal(apiAttempt.failureClass, "true_empty");
  assert.equal(apiAttempt.resultCount, 0);
  assert.equal(stored.candidates[0].dataRevision, candidate.dataRevision + 2);
  assert.equal(stored.candidates[0].lifecycleV11.c1SoftwareEvidenceV1.evidenceFingerprint, result.result.evidenceFingerprint);
  assert.equal(stored.candidates[0].lifecycleV11.c1PaidKeywordEvidenceSettlementV1.jobId, enqueue.result.softwareJobRef.jobId);
});

test("generic C1 paid keyword Worker生产入口只从SoftwareJobStore领取可分配作业", async () => {
  const candidate = await genericC1ReadyCandidate();
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
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => KEYWORD_NOW,
    workerRegistry: genericWorkerRegistry()
  });
  let calls = 0;
  const idle = await runNextC1PaidKeywordEvidenceSoftwareJob({
    repository,
    softwareJobStore: store,
    worker: genericWorker(),
    leaseId: "lease:generic-c1-worker-idle",
    openApiTransport: async () => {
      calls += 1;
      return providerReceipt();
    },
    serverClock: () => KEYWORD_NOW
  }, {
    prepareRuntime: async (args) => genericPrepared(args)
  });
  assert.equal(idle.status, "idle");
  assert.equal(calls, 0);

  const enqueue = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:generic-c1-worker-dispatch" }),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  const result = await runNextC1PaidKeywordEvidenceSoftwareJob({
    repository,
    softwareJobStore: store,
    worker: genericWorker(),
    leaseId: "lease:generic-c1-worker-dispatch",
    leaseDurationMs: 60_000,
    openApiTransport: async (request) => {
      calls += 1;
      assert.equal(request.identity.candidateId, candidate.id);
      assert.equal(request.identity.dataRevision, candidate.dataRevision + 1);
      return genericProviderReceipt();
    },
    serverClock: () => KEYWORD_NOW
  }, {
    prepareRuntime: async (args) => genericPrepared(args)
  });
  assert.equal(result.status, "committed");
  assert.equal(result.result.softwareJobRef.jobId, enqueue.result.softwareJobRef.jobId);
  assert.equal(calls, 1);
});

test("generic C1队列消费者要求store在limit前精确筛选C1类型", async () => {
  const worker = genericWorker();
  let listCalls = 0;
  const result = await runNextC1PaidKeywordEvidenceSoftwareJob({
    softwareJobStore: {
      listAssignable: async (query) => {
        listCalls += 1;
        assert.deepEqual(query, { worker, limit: 1, jobType: C1_PAID_KEYWORD_EVIDENCE_JOB_TYPE });
        return [];
      }
    },
    worker
  });
  assert.equal(result.status, "idle");
  assert.equal(listCalls, 1);
});

test("generic C1 paid keyword Worker在成功回执后本地准备失败保留external succeeded且不推进candidate", async () => {
  const candidate = await genericC1ReadyCandidate();
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
  const enqueue = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:generic-c1-worker-failure" }),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverTime: KEYWORD_NOW,
    serverClock: () => KEYWORD_NOW
  });
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => KEYWORD_NOW,
    workerRegistry: genericWorkerRegistry()
  });
  let calls = 0;
  const result = await runC1PaidKeywordEvidenceSoftwareJob({
    repository,
    softwareJobStore: store,
    worker: genericWorker(),
    jobId: enqueue.result.softwareJobRef.jobId,
    leaseId: "lease:generic-c1-worker-failure",
    leaseDurationMs: 60_000,
    openApiTransport: async () => {
      calls += 1;
      return providerReceipt();
    },
    serverClock: () => KEYWORD_NOW
  }, {
    prepareRuntime: async () => ({
      result: {
        status: "not_ready",
        gaps: [{ code: "keyword_preparation_missing_metric" }]
      },
      receipt: {
        status: "not_ready"
      }
    })
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "committed");
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.candidateRevisionUnchanged, true);
  assert.deepEqual([
    result.result.productionAuthorizationCreated,
    result.result.dHandoffCreated,
    result.result.productionPlanCreated,
    result.result.executionIntentCreated,
    result.result.platformWrites
  ], [false, false, false, false, 0]);
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, candidate.dataRevision + 1);
  assert.equal(stored.candidates[0].lifecycleV11.c1SoftwareEvidenceV1, undefined);
  assert.equal(stored.runtime.softwareJobs[0].status, "failed");
  assert.equal(stored.runtime.softwareJobs[0].externalRequestState, "succeeded");
  assert.equal(stored.runtime.softwareJobs[0].failureClass, "c1-paid-keyword-local-preparation-failed");
  assert.equal(stored.runtime.softwareJobs[0].resultEnvelope, null);
});

async function genericWorkerFixture() {
  const candidate = await genericC1ReadyCandidate();
  const repository = createMemoryBusinessStateRepository({
    candidates: [candidate],
    runtime: {
      softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [],
      operationAudit: [], idempotencyRecords: []
    }
  });
  const enqueue = await enqueueC1PaidKeywordEvidenceJob({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: KEYWORD_NOW, userId: "owner-1", sessionId: "test:c1-runner-regression" }),
    candidateId: candidate.id,
    expectedRevision: candidate.dataRevision,
    clientInput: { dataRevision: candidate.dataRevision },
    serverClock: () => KEYWORD_NOW
  });
  const softwareJobStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => KEYWORD_NOW,
    workerRegistry: genericWorkerRegistry()
  });
  return {
    candidate,
    repository,
    params: {
      repository,
      softwareJobStore,
      worker: genericWorker(),
      jobId: enqueue.result.softwareJobRef.jobId,
      leaseId: "lease:c1-runner-regression",
      leaseDurationMs: 60_000,
      serverClock: () => KEYWORD_NOW
    }
  };
}

test("generic C1缺少权威时钟时在领取与外呼前拒绝，固定serverTime不能替代", async () => {
  const fixture = await genericWorkerFixture();
  let calls = 0;
  await assert.rejects(() => runC1PaidKeywordEvidenceSoftwareJob({
    ...fixture.params,
    serverClock: null,
    serverTime: KEYWORD_NOW,
    openApiTransport: async () => { calls += 1; }
  }), /C1_PAID_KEYWORD_WORKER_CLOCK_REQUIRED/);
  const stored = await fixture.repository.readSnapshot();
  assert.equal(stored.runtime.softwareJobs[0].status, "queued");
  assert.equal(stored.runtime.softwareJobs[0].attempt, 0);
  assert.equal(calls, 0);
});

for (const scenario of [
  {
    name: "请求超时异常",
    transport: async () => { throw new Error("network_timeout private-detail-must-not-persist"); },
    status: "unknown_outcome", externalRequestState: "unknown_outcome",
    failureClass: "c1-paid-keyword-external-outcome-unknown"
  },
  {
    name: "响应无法解析",
    transport: async () => ({ malformed: true }),
    status: "unknown_outcome", externalRequestState: "unknown_outcome",
    failureClass: "c1-paid-keyword-external-outcome-unknown"
  },
  {
    name: "归一化超时回执",
    transport: async () => providerReceipt({ completed: false, completedAt: null, resultCount: null, timeout: true, failureStage: "target_request" }),
    status: "unknown_outcome", externalRequestState: "unknown_outcome",
    failureClass: "c1-paid-keyword-network-timeout"
  },
  {
    name: "平台明确拒绝登录权限",
    transport: async () => providerReceipt({ completed: false, completedAt: null, resultCount: null, loginRequired: true, failureStage: "target_request" }),
    status: "failed", externalRequestState: "failed",
    failureClass: "c1-paid-keyword-login-required"
  },
  {
    name: "平台明确额度拒绝",
    transport: async () => providerReceipt({ completed: false, completedAt: null, resultCount: null, quotaExceeded: true, failureStage: "target_request" }),
    status: "failed", externalRequestState: "failed",
    failureClass: "c1-paid-keyword-quota-or-rate-limit"
  },
  {
    name: "目标请求后查询额度失败",
    transport: async () => providerReceipt({ completed: false, completedAt: null, resultCount: null, loginRequired: true, failureStage: "quota_after" }),
    status: "unknown_outcome", externalRequestState: "unknown_outcome",
    failureClass: "c1-paid-keyword-login-required"
  }
]) {
  test(`generic C1 paid keyword Worker准确收口${scenario.name}且不重试`, async () => {
    const fixture = await genericWorkerFixture();
    let calls = 0;
    let preparations = 0;
    const result = await runC1PaidKeywordEvidenceSoftwareJob({
      ...fixture.params,
      openApiTransport: async (...args) => { calls += 1; return scenario.transport(...args); }
    }, {
      prepareRuntime: async () => { preparations += 1; throw new Error("failed receipt must not enter domain preparation"); }
    });
    const stored = await fixture.repository.readSnapshot();
    const job = stored.runtime.softwareJobs[0];
    assert.equal(result.status, "committed");
    assert.equal(job.status, scenario.status);
    assert.equal(job.externalRequestState, scenario.externalRequestState);
    assert.equal(job.failureClass, scenario.failureClass);
    assert.equal(job.automaticRetryAllowed, false);
    assert.equal(job.resultEnvelope, null);
    assert.equal(stored.candidates[0].dataRevision, fixture.candidate.dataRevision + 1);
    assert.equal(stored.candidates[0].lifecycleV11.c1SoftwareEvidenceV1, undefined);
    assert.doesNotMatch(JSON.stringify(stored), /private-detail-must-not-persist/);
    assert.equal(calls, 1);
    assert.equal(preparations, 0);
    await assert.rejects(() => runC1PaidKeywordEvidenceSoftwareJob({ ...fixture.params, openApiTransport: async () => { calls += 1; } }), /WORKER_JOB_INVALID/);
    assert.equal(calls, 1);
  });
}

for (const providerFails of [false, true]) {
  for (const leaseExpired of [false, true]) {
    test(`generic C1 ${providerFails ? "失败" : "成功"}结算只在事务锁内读取真实时钟${leaseExpired ? "并拒绝过期租约" : "一次"}`, async () => {
      const fixture = await genericWorkerFixture();
      let insideTransaction = false;
      let clockReads = 0;
      let calls = 0;
      const observedAt = new Date(Date.parse(KEYWORD_NOW) + (leaseExpired ? 60_001 : 1_000)).toISOString();
      const repository = {
        ...fixture.repository,
        transact: (mutator) => fixture.repository.transact(async (document) => {
          insideTransaction = true;
          try { return await mutator(document); }
          finally { insideTransaction = false; }
        })
      };
      const execute = () => runC1PaidKeywordEvidenceSoftwareJob({
        ...fixture.params,
        repository,
        serverClock: () => {
          clockReads += 1;
          assert.equal(insideTransaction, true);
          return observedAt;
        },
        openApiTransport: async () => {
          calls += 1;
          if (providerFails) throw new Error("network_timeout");
          return genericProviderReceipt();
        }
      }, { prepareRuntime: async (args) => genericPrepared(args) });
      if (leaseExpired) await assert.rejects(execute, /SOFTWARE_JOB_LEASE_REJECTED: 租约已过期/);
      else assert.equal((await execute()).status, "committed");
      const stored = await fixture.repository.readSnapshot();
      const job = stored.runtime.softwareJobs[0];
      assert.equal(clockReads, 1);
      assert.equal(calls, 1);
      assert.equal(job.status, leaseExpired ? "waiting_platform" : providerFails ? "unknown_outcome" : "completed");
      assert.equal(job.completedAt, leaseExpired ? null : observedAt);
      if (!leaseExpired) assert.equal(stored.runtime.operationAudit.at(-1).serverTime, observedAt);
    });
  }
}

for (const { name, prepareRuntime } of [
  { name: "准备异常", prepareRuntime: async () => { throw new Error("private-local-error-must-not-persist"); } },
  { name: "坏封套", prepareRuntime: async () => ({ result: { status: "ready_for_atomic_persist" }, receipt: {} }) }
]) {
  test(`generic C1已确认外部成功时，本地${name}不会改写外部终态`, async () => {
    const fixture = await genericWorkerFixture();
    let calls = 0;
    const result = await runC1PaidKeywordEvidenceSoftwareJob({
      ...fixture.params,
      openApiTransport: async () => { calls += 1; return providerReceipt(); }
    }, { prepareRuntime });
    const stored = await fixture.repository.readSnapshot();
    const job = stored.runtime.softwareJobs[0];
    assert.equal(result.status, "committed");
    assert.equal(job.status, "failed");
    assert.equal(job.externalRequestState, "succeeded");
    assert.equal(job.failureClass, "c1-paid-keyword-local-preparation-failed");
    assert.equal(job.resultEnvelope, null);
    assert.equal(stored.candidates[0].dataRevision, fixture.candidate.dataRevision + 1);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(stored), /private-local-error-must-not-persist/);
  });
}
