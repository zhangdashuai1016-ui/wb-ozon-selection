import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";

async function fixture(t, { json = false, atomicWriter = persistJsonThroughRealTarget } = {}) {
  let filePath;
  if (json) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "d-job-repository-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filePath = path.join(directory, "state.json");
  }
  const source = productionOwnerDecisionFixture(json ? document => createJsonBusinessStateRepository({ filePath,
    initializeIfMissing: true, initialDocument: document, atomicWriter }) : undefined);
  const committed = await commitSingleOwnerProductionAuthorization(source.args);
  const repository = source.repository;
  const [job] = (await repository.readSnapshot()).runtime.softwareJobs;
  const scope = job.scopeBinding;
  let now = source.formal.at;
  const binding = { schemaVersion: "d-e-execution-binding-v1", serviceId: "service:synthetic-d", serviceConfigurationVersion: "service-config:synthetic:1",
    productionBinding: structuredClone(scope.productionBinding), platform: "ozon", storeRef: structuredClone(scope.identity.storeRef),
    warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias, workerId: "worker:synthetic-d", workerVersion: "version:1",
    configurationEvidence: { evidenceRef: "evidence:synthetic-d-configuration", checkedAt: now,
      expiresAt: new Date(Date.parse(now) + 300_000).toISOString() } };
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => now, heartbeatTtlMs: 300_000 });
  const worker = registry.register({ workerId: binding.workerId, version: binding.workerVersion,
    capabilities: ["ozon-production-execution"], observedAt: now });
  const resolverInputs = [];
  const resolver = input => { resolverInputs.push(structuredClone(input)); return structuredClone(binding); };
  const makeStore = (resolveDEExecutionBinding = resolver, targetRepository = repository) => createRepositoryBackedSoftwareJobStore({
    businessStateRepository: targetRepository, serverClock: () => now, workerRegistry: registry, resolveDEExecutionBinding });
  const store = makeStore();
  const claimInput = { jobId: job.jobId, worker, leaseId: "lease:synthetic-d", leaseDurationMs: 1_000 };
  const markInput = { jobId: job.jobId, workerId: worker.workerId, leaseId: claimInput.leaseId, externalRequestRef: "request:synthetic-d" };
  const guard = (targetStore = store, overrides = {}) => repository.transact(document => ({ changed: false,
    result: targetStore.assertDEExecutionInDocument({ document, jobId: job.jobId, workerId: worker.workerId,
      leaseId: claimInput.leaseId, observedAt: now, ...overrides }) }));
  return { source, committed, repository, job, binding, registry, worker, resolverInputs, makeStore, store, claimInput, markInput, guard, filePath,
    now: () => now, advance: milliseconds => { now = new Date(Date.parse(now) + milliseconds).toISOString(); } };
}

async function rejectsUnchanged(f, action, error) {
  const before = await f.repository.readSnapshot();
  const bytes = f.filePath ? await readFile(f.filePath) : null;
  await assert.rejects(action, error);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  if (bytes) assert.deepEqual(await readFile(f.filePath), bytes);
}

test("actual current owner commit persists v2 PA handoff and one queued D job before execution configuration exists", async t => {
  const f = await fixture(t, { json: true });
  const saved = await f.repository.readSnapshot();
  const sku = saved.candidates[0].lifecycleV11.skuPackage;
  assert.equal(sku.productionAuthorization.schemaVersion, "production-authorization-v1.2");
  assert.equal(sku.dHandoff.schemaVersion, "c2-d-handoff-v2");
  assert.equal(sku.dHandoff.softwareJobRef.jobId, f.job.jobId);
  assert.equal(f.job.status, "queued"); assert.equal(f.job.attempt, 0); assert.equal(f.job.externalRequestState, "not_sent");
  assert.equal(f.job.admissionDecision.phase, "enqueue_current"); assert.equal(f.job.admissionDecision.executionBindingSnapshot, null);
  assert.equal(f.resolverInputs.length, 0);
  assert.equal(f.committed.result.externalRequests, 0); assert.equal(f.committed.result.platformWrites, 0);
  assert.equal(saved.runtime.softwareJobs.length, 1);
  const noResolver = f.makeStore(null);
  await rejectsUnchanged(f, () => noResolver.claim(f.claimInput), /SOFTWARE_JOB_ADMISSION_DE_BINDING_REQUIRED/);
  await rejectsUnchanged(f, () => f.store.enqueue(f.job), /SOFTWARE_JOB_DOMAIN_HANDOFF_REQUIRED/);
  const reopened = createJsonBusinessStateRepository({ filePath: f.filePath });
  assert.deepEqual(await reopened.readSnapshot(), saved);
});

test("claim snapshot and lease are published together after durable replacement and survive JSON reopen", async t => {
  let releaseWrite, enteredWrite;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const entered = new Promise(resolve => { enteredWrite = resolve; });
  let proposed;
  const f = await fixture(t, { json: true, atomicWriter: async (target, document) => {
    if (document.runtime.softwareJobs?.[0]?.status === "claimed") {
      proposed = structuredClone(document); enteredWrite(); await gate;
    }
    await persistJsonThroughRealTarget(target, document);
  } });
  const before = await readFile(f.filePath);
  const claiming = f.store.claim(f.claimInput);
  await entered;
  try {
    const pending = proposed.runtime.softwareJobs[0];
    assert.equal(pending.admissionDecision.phase, "claim");
    assert.deepEqual(pending.admissionDecision.executionBindingSnapshot, f.binding);
    assert.equal(pending.workerId, f.worker.workerId); assert.equal(pending.workerVersion, f.worker.version);
    assert.deepEqual(pending.workerCapabilitiesSnapshot, f.worker.capabilities);
    assert.equal(pending.leaseId, f.claimInput.leaseId); assert.equal(pending.attempt, 1);
    assert.deepEqual(await readFile(f.filePath), before);
  } finally { releaseWrite(); }
  const claimed = await claiming;
  const reopened = createJsonBusinessStateRepository({ filePath: f.filePath });
  assert.deepEqual((await reopened.readSnapshot()).runtime.softwareJobs[0], claimed);
  assert.equal(claimed.revision, f.job.revision);
  assert.equal((await reopened.readSnapshot()).candidates[0].dataRevision, f.committed.candidate.dataRevision);
  const [input] = f.resolverInputs;
  assert.deepEqual(input.worker, f.worker); assert.equal(input.job.status, "queued");
  assert.equal(input.candidate.dataRevision, claimed.revision); assert.equal(input.observedAt, f.now());
});

test("failed claim replacement retains both old enqueue decision and unclaimed lease state", async t => {
  let proposed;
  const f = await fixture(t, { json: true, atomicWriter: async (target, document) => {
    if (document.runtime.softwareJobs?.[0]?.status === "claimed") {
      proposed = structuredClone(document); throw new Error("SYNTHETIC_D_CLAIM_REPLACEMENT_FAILED");
    }
    await persistJsonThroughRealTarget(target, document);
  } });
  await rejectsUnchanged(f, () => f.store.claim(f.claimInput), /SYNTHETIC_D_CLAIM_REPLACEMENT_FAILED/);
  assert.equal(proposed.runtime.softwareJobs[0].admissionDecision.phase, "claim");
  assert.equal(proposed.runtime.softwareJobs[0].leaseId, f.claimInput.leaseId);
  assert.deepEqual(await f.store.get(f.job.jobId), f.job);
});

test("concurrent explicit claims consume the original queued job once without changing candidate or source revision", async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.store.claim(f.claimInput), f.store.claim({ ...f.claimInput, leaseId: "lease:second" })]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  const failed = outcomes.find(value => value.status === "rejected");
  assert.match(failed.reason.message, /PHASE_CONFLICT|CLAIM_REJECTED/);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.length, 1); assert.equal(saved.runtime.softwareJobs[0].attempt, 1);
  assert.equal(saved.runtime.softwareJobs[0].revision, f.job.revision);
  assert.equal(saved.candidates[0].dataRevision, f.committed.candidate.dataRevision);
  assert.deepEqual(saved.runtime.softwareJobs[0], outcomes.find(value => value.status === "fulfilled").value);
});

test("claim rejects unregistered workers and current registry/configuration mismatches without changing the queued job", async t => {
  const f = await fixture(t);
  await rejectsUnchanged(f, () => f.store.claim({ ...f.claimInput, worker: { ...f.worker, workerId: "worker:unregistered" } }), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);
  const original = structuredClone(f.binding);
  for (const change of [b => { b.workerId = "worker:other"; }, b => { b.workerVersion = "version:other"; },
    b => { b.storeRef.platformStoreId = "store:other"; }, b => { b.credentialAlias = "alias:other"; },
    b => { b.productionBinding.configurationVersion = "configuration:other"; },
    b => { b.configurationEvidence.expiresAt = f.now(); }, b => { b.configurationEvidence.checkedAt = "2099-01-01T00:00:00.000Z"; }]) {
    Object.assign(f.binding, structuredClone(original)); change(f.binding);
    await rejectsUnchanged(f, () => f.store.claim(f.claimInput), /SOFTWARE_JOB_ADMISSION_DE_(?:WORKER_CONFLICT|BINDING_SOURCE_CONFLICT|BINDING_EVIDENCE_EXPIRED)/);
  }
  Object.assign(f.binding, original);
  f.registry.heartbeat({ workerId: f.worker.workerId, version: "version:2", capabilities: f.worker.capabilities });
  await rejectsUnchanged(f, () => f.store.claim(f.claimInput), /SOFTWARE_JOB_ADMISSION_DE_WORKER_CONFLICT/);
  f.registry.heartbeat({ workerId: f.worker.workerId, version: f.worker.version, capabilities: ["file-upload"] });
  await rejectsUnchanged(f, () => f.store.claim(f.claimInput), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);
});

test("candidate and unique v2 job-reference drift cannot be repaired by overwriting the job revision", async t => {
  for (const corrupt of [c => { c.dataRevision += 1; }, c => { c.lifecycleV11.skuPackage.dataRevision += 1; },
    c => { c.lifecycleV11.skuPackage.variantKey = "changed"; }, c => { c.lifecycleV11.skuPackage.dHandoff.softwareJobRef.jobId = "job:other"; }]) {
    const f = await fixture(t);
    await f.repository.transact(document => { corrupt(document.candidates[0]); return { changed: true, document, result: null }; });
    await rejectsUnchanged(f, () => f.store.claim(f.claimInput), /D_JOB_CURSOR_|D_JOB_HANDOFF_|DE_JOB_SCOPE_/);
    assert.equal((await f.store.get(f.job.jobId)).revision, f.job.revision);
  }
});

test("mark and transaction-local guard recheck live lease/configuration and preserve the original job on failure", async t => {
  for (const change of [f => { f.advance(1_001); }, f => { f.binding.serviceConfigurationVersion = "service-config:2"; },
    f => { f.binding.productionBinding.configurationVersion = "configuration:2"; }, f => { f.binding.credentialAlias = "alias:other"; },
    f => { f.binding.configurationEvidence.expiresAt = f.now(); },
    f => { f.registry.heartbeat({ workerId: f.worker.workerId, version: "version:2", capabilities: f.worker.capabilities }); }]) {
    const f = await fixture(t); await f.store.claim(f.claimInput); change(f);
    const rejected = /SOFTWARE_JOB_LEASE_REJECTED|SOFTWARE_JOB_ADMISSION_DE_BINDING_(?:CHANGED|SOURCE_CONFLICT|EVIDENCE_EXPIRED)|WORKER_REGISTRY_WORKER_NOT_CURRENT/;
    await rejectsUnchanged(f, () => f.store.markExternalRequestStarted(f.markInput), rejected);
    await rejectsUnchanged(f, () => f.guard(), rejected);
    assert.equal((await f.store.get(f.job.jobId)).revision, f.job.revision);
  }
});

test("valid guarded mark retains source identity; wrong holder/lease and duplicate sends remain rejected", async t => {
  const f = await fixture(t, { json: true }); await f.store.claim(f.claimInput);
  const checked = await f.guard();
  assert.equal(checked.admissionDecision.phase, "external_request");
  assert.deepEqual(checked.admissionDecision.executionBindingSnapshot, f.binding);
  checked.job.scopeBinding.merchantSku = "mutated-detached-result";
  assert.equal((await f.store.get(f.job.jobId)).scopeBinding.merchantSku, f.job.scopeBinding.merchantSku);
  await rejectsUnchanged(f, () => f.guard(f.store, { leaseId: "lease:other" }), /SOFTWARE_JOB_LEASE_REJECTED/);
  await rejectsUnchanged(f, () => f.store.markExternalRequestStarted({ ...f.markInput, leaseId: "lease:other" }), /SOFTWARE_JOB_LEASE_REJECTED/);
  await rejectsUnchanged(f, () => f.guard(f.store, { workerId: "worker:other" }), /WORKER_REGISTRY_WORKER_NOT_CURRENT/);
  const marked = await f.store.markExternalRequestStarted(f.markInput);
  assert.equal(marked.status, "waiting_platform"); assert.equal(marked.externalRequestState, "in_flight");
  assert.equal(marked.externalRequestRef, f.markInput.externalRequestRef); assert.equal(marked.revision, f.job.revision);
  const saved = await f.repository.readSnapshot(); await f.guard(); assert.deepEqual(await f.repository.readSnapshot(), saved);
  await rejectsUnchanged(f, () => f.store.markExternalRequestStarted(f.markInput), /SOFTWARE_JOB_EXTERNAL_REQUEST_REJECTED/);
});

test("a conflicting external terminal state cannot pass a claimed or waiting execution lease guard", async t => {
  for (const waiting of [false, true]) for (const externalRequestState of ["unknown_outcome", "failed", "succeeded"]) {
    const f = await fixture(t); await f.store.claim(f.claimInput);
    if (waiting) await f.store.markExternalRequestStarted(f.markInput);
    await f.repository.transact(document => { document.runtime.softwareJobs[0].externalRequestState = externalRequestState;
      return { changed: true, document, result: null }; });
    await rejectsUnchanged(f, () => f.guard(), /SOFTWARE_JOB_LEASE_REJECTED/);
  }
});

test("claim obtains configuration time inside the queued transaction; unknown resolver errors propagate unchanged", async t => {
  const f = await fixture(t);
  const resolverError = new TypeError("synthetic resolver programming error");
  await rejectsUnchanged(f, () => f.makeStore(() => { throw resolverError; }).claim(f.claimInput), error => error === resolverError);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = f.repository.transact(async () => { entered(); await gate; return { changed: false, result: null }; });
  await started;
  f.binding.configurationEvidence.expiresAt = new Date(Date.parse(f.now()) + 1_000).toISOString();
  const claiming = f.store.claim(f.claimInput);
  f.advance(2_000); release(); await blocker;
  const before = await f.repository.readSnapshot();
  await assert.rejects(claiming, /SOFTWARE_JOB_ADMISSION_DE_BINDING_EVIDENCE_EXPIRED/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal(f.resolverInputs.at(-1).observedAt, f.now());
});
