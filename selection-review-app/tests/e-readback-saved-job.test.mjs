import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createSystemEReadbackSoftwareRuntime, assertEReadbackAttempt } from "../lib/e-readback-software-use-case.mjs";

const clone = value => structuredClone(value);
const validator = await loadPublishedSchemaValidator();
const validateAttempt = validator.getSchema("e-readback-attempt-v1");
const validateJob = validator.getSchema("software-job-v1.schema.json");

async function fixture({ filePath = null } = {}) {
  const d = await savedDProductionJobFixture();
  // E-only precondition: explicit synthetic DTOs pass through the formal D persistence and terminal reducers.
  assert.equal((await runPersistedDExecution({ ...d.input, createAdapter: ({request}) => createSyntheticDCompletionAdapter({request}) })).status, "succeeded");
  const document = await d.repository.readSnapshot();
  const candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  const configuration = clone(document.runtime.softwareJobs.find(job => job.jobId === d.job.jobId).admissionDecision.executionBindingSnapshot);
  let repository = d.repository;
  if (filePath !== null) {
    await fs.writeFile(filePath, JSON.stringify(document));
    repository = createJsonBusinessStateRepository({ filePath });
  }
  const createStore = (target = repository) => createRepositoryBackedSoftwareJobStore({ businessStateRepository: target,
    serverClock: d.input.serverClock, workerRegistry: d.registry, resolveDEExecutionBinding: () => clone(configuration) });
  const jobStore = createStore(), jobId = candidate.lifecycleV11.eIndependentReadbackJobRefV1.jobId, leaseId = "lease:synthetic:saved-e";
  const job = await jobStore.claim({ jobId, worker: d.worker, leaseId, leaseDurationMs: 60_000 });
  const runArgs = { actor: d.input.actor, input: { candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    sourceRecordId: sku.productionRecord.productionRecordId }, softwareJobContext: { jobStore, jobId, workerId: d.worker.workerId, leaseId } };
  const observation = exactObservation(sku.productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  return { d, candidate, repository, createStore, jobStore, job, runArgs, configuration, observation, clock: d.input.serverClock };
}

function runtime(f, readPlatform, overrides = {}) {
  return createSystemEReadbackSoftwareRuntime({ repository: f.repository, runtimeMode: "local_development",
    serverClock: f.clock, readPlatform, ...overrides });
}

function savedState(document, jobId) {
  const candidate = document.candidates[0], sku = candidate.lifecycleV11.skuPackage;
  return { candidate, sku, attempt: sku.readbackHistory.find(entry => entry.schemaVersion === "e-readback-attempt-v1"),
    job: document.runtime.softwareJobs.find(entry => entry.jobId === jobId) };
}

function assertPublished(document) {
  for (const job of document.runtime.softwareJobs) assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
  for (const attempt of document.candidates[0].lifecycleV11.skuPackage.readbackHistory) {
    if (attempt.schemaVersion !== "e-readback-attempt-v1") continue;
    assertEReadbackAttempt(attempt);
    assert.equal(validateAttempt(attempt), true, JSON.stringify(validateAttempt.errors));
  }
}

test("saved E after domain-produced synthetic D completion reads once only after request markers commit, then settles the same history result", async () => {
  const f = await fixture(), commits = [];
  const repository = { ...f.repository, transact: mutator => f.repository.transact(async document => {
    const outcome = await mutator(document);
    if (outcome.changed) { assertPublished(outcome.document); commits.push(clone(outcome.document)); }
    return outcome;
  }) };
  let reads = 0;
  const result = await runtime(f, async request => {
    reads += 1;
    const saved = savedState(await f.repository.readSnapshot(), f.job.jobId);
    assert.equal(saved.attempt.externalRequestState, "in_flight");
    assert.equal(saved.job.status, "waiting_platform"); assert.equal(saved.job.externalRequestState, "in_flight");
    assert.equal(saved.job.externalRequestRef, `e-readback-request:${f.job.scopeBinding.inputFingerprint}`);
    assert.equal(saved.job.admissionDecision.phase, "external_request");
    assert.equal(saved.candidate.dataRevision, f.job.revision); assert.equal(saved.job.revision, f.job.revision);
    assert.equal(request.writeAllowed, false); assert.equal(request.mode, "independent_read_only");
    assert.deepEqual(request.storeRef, f.candidate.storeRef);
    return f.observation;
  }, { repository }).run(f.runArgs);
  assert.equal(reads, 1); assert.equal(result.status, "verified"); assert.equal(commits.length, 3);
  const intent = savedState(commits[0], f.job.jobId);
  assert.equal(intent.job.status, "claimed"); assert.equal(intent.job.externalRequestState, "not_sent");
  assert.equal(intent.attempt.externalRequestState, "not_sent"); assert.equal(intent.candidate.dataRevision, f.job.revision);
  assert.deepEqual(intent.attempt.softwareJobRef, { jobId: f.job.jobId, revision: f.job.revision,
    workerId: f.runArgs.softwareJobContext.workerId, leaseId: f.runArgs.softwareJobContext.leaseId });
  const saved = savedState(await f.repository.readSnapshot(), f.job.jobId);
  assert.equal(saved.job.status, "completed"); assert.equal(saved.job.externalRequestState, "succeeded");
  assert.equal(saved.candidate.dataRevision, f.job.revision + 1); assert.equal(saved.job.revision, f.job.revision);
  assert.equal(saved.sku.readbackHistory.length, 1); assert.equal(saved.attempt.applicationDisposition, "applied");
  assert.deepEqual(saved.sku.eVerificationRecord, saved.attempt.result.eVerificationRecord);
  assert.deepEqual(saved.sku.productionRecord, f.candidate.lifecycleV11.skuPackage.productionRecord);
});

test("concurrent run and JSON restart replay never read twice or create another job, permit or history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saved-e-readback-"));
  try {
    const filePath = path.join(directory, "state.json"), f = await fixture({ filePath });
    let reads = 0, release, notifyRead;
    const entered = new Promise(resolve => { notifyRead = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const service = runtime(f, async () => { reads += 1; notifyRead(); return pending; });
    const first = service.run(f.runArgs); await entered;
    assert.equal((await service.run(f.runArgs)).status, "idempotent_replay");
    const restartedRepository = createJsonBusinessStateRepository({ filePath });
    const restartedStore = f.createStore(restartedRepository);
    const restarted = runtime(f, async () => { reads += 1; return f.observation; }, { repository: restartedRepository });
    const replayArgs = { ...f.runArgs, softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore: restartedStore } };
    assert.equal((await restarted.run(replayArgs)).status, "idempotent_replay");
    release(f.observation); assert.equal((await first).status, "verified");
    f.d.advance(120_000); f.configuration.serviceConfigurationVersion = "service-config:removed";
    const bytes = await fs.readFile(filePath, "utf8");
    assert.equal((await restarted.run(replayArgs)).status, "idempotent_replay");
    assert.equal(await fs.readFile(filePath, "utf8"), bytes); assert.equal(reads, 1);
    const saved = JSON.parse(bytes); assertPublished(saved);
    assert.equal(saved.runtime.softwareJobs.length, 2); assert.equal(saved.candidates[0].lifecycleV11.skuPackage.readbackHistory.length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("saved E requires exact closed context, registered Worker, original source and candidate CAS before any mutation", async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  let reads = 0;
  const service = runtime(f, async () => { reads += 1; return f.observation; });
  const cases = [
    [args => { args.softwareJobContext = null; args.actor = f.d.owner.args.actor; }, /SOFTWARE_JOB_CONTEXT_REQUIRED/],
    [args => { args.actor = f.d.owner.args.actor; }, /REGISTERED_WORKER_REQUIRED/],
    [args => { args.input.extra = "not_allowed"; }, /INPUT_INVALID/],
    [args => { args.softwareJobContext.extra = "not_allowed"; }, /SOFTWARE_JOB_CONTEXT_INVALID/],
    [args => { args.softwareJobContext.workerId = "another-worker"; }, /REGISTERED_WORKER_REQUIRED/],
    [args => { args.softwareJobContext.leaseId = "another-lease"; }, /LEASE/],
    [args => { args.softwareJobContext.jobId = f.d.job.jobId; }, /HANDOFF_PERSISTED_SOURCE_CONFLICT|REVISION_CONFLICT|SOURCE/],
    [args => { args.input.sourceRecordId = "production-record:other"; }, /SOURCE_SCOPE_CONFLICT/],
    [args => { args.input.expectedCandidateRevision += 1; }, /REVISION_CONFLICT/]
  ];
  for (const [alter, expected] of cases) {
    const args = { ...f.runArgs, input: clone(f.runArgs.input), softwareJobContext: { ...f.runArgs.softwareJobContext } };
    alter(args); await assert.rejects(() => service.run(args), expected);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
  assert.equal(reads, 0);
});

test("expired lease, current registry drift and service configuration drift reject before intent with zero reads", async () => {
  for (const alter of [
    f => f.d.advance(60_001),
    f => f.d.registry.heartbeat({ ...f.d.worker, version: "worker-version:2" }),
    f => { f.configuration.serviceConfigurationVersion = "service-config:2"; },
    f => { f.configuration.storeRef.platformStoreId = "other-store"; }
  ]) {
    const f = await fixture(); alter(f);
    const before = await f.repository.readSnapshot(); let reads = 0;
    await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }).run(f.runArgs),
      /SOFTWARE_JOB_LEASE_REJECTED: 租约已过期|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_ADMISSION_DE_/);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(reads, 0);
  }
});

test("the second locked gate blocks drift after intent, leaves not_sent, and never treats replay as permission", async () => {
  for (const [change, expected] of [
    [f => { f.configuration.serviceConfigurationVersion = "service-config:2"; }, /SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED/],
    [f => f.d.advance(60_001), /SOFTWARE_JOB_LEASE_REJECTED: 租约已过期/],
    [f => f.repository.transact(document => { document.candidates[0].dataRevision += 1; document.candidates[0].notes = "请求前新备注";
      return { changed: true, document }; }), /SOFTWARE_JOB_REVISION_CONFLICT/],
    [f => f.repository.transact(document => { document.candidates[0].lifecycleV11.skuPackage.productionRecord.platformProductId = "910002";
      return { changed: true, document }; }), /E_READBACK_SOURCE_SCOPE_CONFLICT/]
  ]) {
    const f = await fixture(); let transactions = 0, reads = 0;
    const repository = { ...f.repository, transact: async mutator => {
      const outcome = await f.repository.transact(mutator);
      if (++transactions === 1) await change(f);
      return outcome;
    } };
    await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }, { repository }).run(f.runArgs), expected);
    const before = await f.repository.readSnapshot(), saved = savedState(before, f.job.jobId);
    assert.equal(saved.job.status, "claimed"); assert.equal(saved.job.externalRequestState, "not_sent");
    assert.equal(saved.attempt.externalRequestState, "not_sent"); assert.equal(saved.attempt.result, null);
    assert.equal((await runtime(f, async () => { reads += 1; return f.observation; }).run(f.runArgs)).status, "idempotent_replay");
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(reads, 0);
  }
});

test("a late read keeps its result after lease expiry and blocks apply after any saved-job revision or source drift", async () => {
  for (const [expectedStatus, change] of [
    ["verified", async f => { f.d.advance(60_001); f.configuration.serviceConfigurationVersion = "service-config:2"; }],
    ["not_applied", async f => f.repository.transact(document => { document.candidates[0].notes = "主人新增备注"; document.candidates[0].dataRevision += 1;
      return { changed: true, document }; })],
    ["not_applied", async f => f.repository.transact(document => { document.candidates[0].lifecycleV11.skuPackage.productionRecord.platformProductId = "910002";
      return { changed: true, document }; })]
  ]) {
    const f = await fixture(); let reads = 0;
    const result = await runtime(f, async () => { reads += 1; await change(f); return f.observation; }).run(f.runArgs);
    const saved = savedState(await f.repository.readSnapshot(), f.job.jobId);
    assert.deepEqual(saved.attempt.result.observation, f.observation); assert.equal(reads, 1);
    assert.equal(result.status, expectedStatus);
    assert.equal(saved.job.externalRequestState, "succeeded"); assert.equal(saved.job.revision, f.job.revision);
    if (result.status === "verified") {
      assert.equal(saved.attempt.applicationDisposition, "applied"); assert.equal(saved.job.status, "completed");
    } else {
      assert.equal(result.status, "not_applied"); assert.equal(saved.attempt.applicationDisposition, "source_conflict_not_applied");
      assert.equal(saved.sku.eVerificationRecord, null); assert.notEqual(saved.candidate.workflowStatus, "listed");
    }
    assertPublished(await f.repository.readSnapshot());
    assert.equal((await runtime(f, async () => { reads += 1; return f.observation; }).run(f.runArgs)).status, "idempotent_replay");
    assert.equal(reads, 1);
  }
});

test("a real restart reconciliation preserves unknown and late JSON evidence requires reconciliation without applying or reading again", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saved-e-late-readback-"));
  try {
    const filePath = path.join(directory, "state.json"), f = await fixture({ filePath });
    let reads = 0, reconciledJob;
    const result = await runtime(f, async () => {
      reads += 1; f.d.advance(60_001);
      const recoveryRepository = createJsonBusinessStateRepository({ filePath });
      const recoveryStore = f.createStore(recoveryRepository);
      await recoveryStore.reconcileAfterRestart();
      reconciledJob = savedState(await recoveryRepository.readSnapshot(), f.job.jobId).job;
      assert.equal(reconciledJob.status, "unknown_outcome");
      return f.observation;
    }).run(f.runArgs);
    assert.equal(result.status, "not_applied"); assert.equal(result.attempt.applicationDisposition, "reconciliation_required_not_applied");
    const before = await fs.readFile(filePath, "utf8"), document = JSON.parse(before), saved = savedState(document, f.job.jobId);
    assert.deepEqual(saved.job, reconciledJob); assert.deepEqual(saved.attempt.result.observation, f.observation);
    assert.equal(saved.attempt.externalRequestState, "succeeded"); assert.equal(saved.sku.eVerificationRecord, null);
    assert.equal(saved.candidate.dataRevision, f.job.revision); assert.notEqual(saved.candidate.workflowStatus, "listed");
    assertPublished(document);
    const repository = createJsonBusinessStateRepository({ filePath }), store = f.createStore(repository);
    const restarted = runtime(f, async () => { reads += 1; return f.observation; }, { repository });
    const replay = await restarted.run({ ...f.runArgs, softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore: store } });
    assert.equal(replay.status, "idempotent_replay"); assert.equal(replay.attempt.currentVerified, false);
    assert.equal(await fs.readFile(filePath, "utf8"), before); assert.equal(reads, 1);
    await assert.rejects(() => store.claim({ jobId: f.job.jobId, worker: f.d.worker, leaseId: "lease:second", leaseDurationMs: 60_000 }));
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("known read failure and mismatching observation settle from history without retry or invented verification", async () => {
  for (const failure of [true, false]) {
    const f = await fixture(); let reads = 0;
    const service = runtime(f, async () => {
      reads += 1;
      if (failure) throw new Error("synthetic-untrusted-provider-detail");
      return { ...f.observation, saleStatus: "not_for_sale" };
    });
    const result = await service.run(f.runArgs), document = await f.repository.readSnapshot(), saved = savedState(document, f.job.jobId);
    assert.equal(result.status, failure ? "unknown_outcome" : "not_verified");
    assert.equal(saved.job.status, failure ? "unknown_outcome" : "completed");
    assert.equal(saved.job.externalRequestState, failure ? "unknown_outcome" : "succeeded");
    assert.equal(saved.attempt.result.eVerificationRecord, null); assert.equal(saved.sku.eVerificationRecord, null);
    assert.equal(saved.candidate.dataRevision, f.job.revision); assert.equal(JSON.stringify(document).includes("synthetic-untrusted-provider-detail"), false);
    assertPublished(document);
    assert.equal((await service.run(f.runArgs)).status, "idempotent_replay"); assert.equal(reads, 1);
    assert.deepEqual(await f.repository.readSnapshot(), document);
  }
});

test("receipt persistence and unknown guard errors propagate unchanged without a second read", async () => {
  for (const failAt of [1, 2, 3]) {
    const f = await fixture(), unexpected = new TypeError("synthetic persistence implementation error");
    let transactions = 0, reads = 0;
    const repository = { ...f.repository, transact: mutator => {
      if (++transactions === failAt) return Promise.reject(unexpected);
      return f.repository.transact(mutator);
    } };
    await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }, { repository }).run(f.runArgs), error => error === unexpected);
    const before = await f.repository.readSnapshot(), saved = savedState(before, f.job.jobId);
    assert.equal(reads, failAt === 3 ? 1 : 0); assert.equal(saved.sku.eVerificationRecord, null);
    assert.equal(saved.job.status, failAt === 3 ? "waiting_platform" : "claimed");
    if (failAt !== 1) {
      assert.equal((await runtime(f, async () => { reads += 1; return f.observation; }).run(f.runArgs)).status, "idempotent_replay");
      assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(reads, failAt === 3 ? 1 : 0);
    }
  }
  const f = await fixture(), unexpected = new TypeError("synthetic admission implementation error");
  const jobStore = { ...f.jobStore, assertDEExecutionInDocument() { throw unexpected; } };
  const before = await f.repository.readSnapshot(); let reads = 0;
  await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }).run({ ...f.runArgs,
    softwareJobContext: { ...f.runArgs.softwareJobContext, jobStore } }), error => error === unexpected);
  assert.equal(reads, 0); assert.deepEqual(await f.repository.readSnapshot(), before);
});

test("softwareJobRef is an optional closed v1 extension and corrupted holder/revision never grants replay", async () => {
  const f = await fixture(); let reads = 0;
  await runtime(f, async () => { reads += 1; return f.observation; }).run(f.runArgs);
  const original = await f.repository.readSnapshot(), valid = savedState(original, f.job.jobId).attempt;
  assert.equal(validateAttempt(valid), true, JSON.stringify(validateAttempt.errors));
  const historicalShape = clone(valid); delete historicalShape.softwareJobRef;
  assert.equal(validateAttempt(historicalShape), true); assertEReadbackAttempt(historicalShape);
  for (const alter of [ref => { delete ref.leaseId; }, ref => { ref.extra = true; }, ref => { ref.revision = -1; },
    ref => { ref.revision = Number.MAX_SAFE_INTEGER + 1; }, ref => { ref.workerId = "https://unsafe.example/key?token=secret"; }]) {
    const attempt = clone(valid); alter(attempt.softwareJobRef);
    assert.equal(validateAttempt(attempt), false); assert.throws(() => assertEReadbackAttempt(attempt), /SOFTWARE_JOB_REFERENCE_INVALID/);
  }
  for (const change of [args => { args.softwareJobContext.leaseId = "lease:other"; }, args => { args.input.expectedCandidateRevision += 1; }]) {
    const args = { ...f.runArgs, input: clone(f.runArgs.input), softwareJobContext: { ...f.runArgs.softwareJobContext } }; change(args);
    await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }).run(args), /SOFTWARE_JOB_REFERENCE_CONFLICT/);
  }
  await assert.rejects(() => runtime(f, async () => { reads += 1; return f.observation; }).run({ actor: f.d.owner.args.actor, input: f.runArgs.input }),
    /SOFTWARE_JOB_CONTEXT_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(), original); assert.equal(reads, 1);
});
