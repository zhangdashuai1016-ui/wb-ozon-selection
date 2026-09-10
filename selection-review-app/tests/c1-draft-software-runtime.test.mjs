import test from "node:test";
import assert from "node:assert/strict";
import { createC1PaidFormalFixture } from "./fixtures/c1-draft-source-fixture.mjs";
import { c1AiSoftwareJobFixture } from "./fixtures/c1-ai-software-job-fixture.mjs";
import { createC1DraftSoftwareUseCase } from "../lib/c1-draft-software-use-case.mjs";
import { createC1DraftSoftwareRuntime, C1DraftRuntimeUnavailableError } from "../lib/c1-draft-software-runtime.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { C1AiGatewayError } from "../lib/c1-ai-gateway.mjs";

async function fixture({ gateway } = {}) {
  const formal = createC1PaidFormalFixture({ credentialAlias: "gateway-alias:fixture-one" });
  const binding = c1AiSoftwareJobFixture({ formalDraftFixture: formal, jobId: formal.receipt.softwareJobId });
  const document = structuredClone(binding.document); document.candidates = [structuredClone(formal.candidate)];
  const repository = createMemoryBusinessStateRepository(document);
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => binding.at }); registry.register(binding.worker);
  const owner = createActorContext({ userId: "owner-1", sessionId: "owner-session", actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: binding.at });
  const worker = createActorContext({ userId: binding.worker.workerId, sessionId: "worker-session", actorType: "worker", roles: ["operator"], source: "registered_runtime_worker", authenticatedAt: binding.at });
  let calls = 0;
  const useCase = createC1DraftSoftwareUseCase({ repository, runtimeMode: "local_development", serverClock: () => binding.at,
    workerRegistry: registry, requestGateway: async input => {
      calls += 1;
      const saved = await repository.readSnapshot();
      assert.equal(saved.runtime.softwareJobs[0].externalRequestState, "in_flight");
      assert.deepEqual(input.request, saved.candidates[0].lifecycleV11.c1AiDraftRequestV1);
      if (gateway) return gateway({ input, repository, formal });
      return { status: "receipt_ready", request: input.request, receipt: formal.receipt, jobId: formal.receipt.gatewayJobId };
    } });
  await useCase.enqueue({ actor: owner, input: { request: binding.request, expectedRevision: formal.candidate.dataRevision,
    authorizationRef: binding.authorizationRecord.authorizationId, credentialAlias: binding.credentialBinding.credentialAlias,
    jobId: binding.job.jobId, idempotencyKey: binding.job.idempotencyKey, auditEventId: "audit:runtime:c1-enqueue" } });
  const execution = { workerActor: worker, leaseId: "lease:runtime:c1", leaseDurationMs: 60_000 };
  const runtime = createC1DraftSoftwareRuntime({ useCase, loadSavedExecution: async () => execution });
  return { formal, repository, execution, runtime, calls: () => calls,
    trigger: { candidateId: formal.candidate.id, expectedRevision: formal.candidate.dataRevision + 1, jobId: binding.job.jobId } };
}

test("未配置服务时构造与请求零执行，不读取历史作业或创建请求", async () => {
  let calls = 0;
  const runtime = createC1DraftSoftwareRuntime({ useCase: { runSaved: async () => { calls += 1; } } });
  assert.equal(calls, 0);
  await assert.rejects(() => runtime.continueSavedCurrent({ candidateId: "candidate:one", expectedRevision: 1, jobId: "job:one" }), C1DraftRuntimeUnavailableError);
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(runtime, "continueCurrent"), false);
});

test("软件仅消费已保存request/job；启动零执行，明确触发后保存回执并应用，重复不付费", async () => {
  const f = await fixture(); assert.equal(f.calls(), 0);
  assert.equal((await f.runtime.continueSavedCurrent(f.trigger)).status, "applied");
  assert.equal((await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.businessPhase, "C2");
  assert.equal((await f.runtime.continueSavedCurrent(f.trigger)).status, "idempotent_replay");
  assert.equal(f.calls(), 1);
});

test("并发运行已保存作业只能发出一次请求", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.runtime.continueSavedCurrent(f.trigger), f.runtime.continueSavedCurrent(f.trigger)]);
  assert.ok(results.some(result => result.status === "fulfilled" && result.value.status === "applied"));
  assert.equal(f.calls(), 1);
  assert.equal((await f.repository.readSnapshot()).runtime.softwareJobAuthorizationRecords[0].useCount, 1);
});

test("loader不能注入主人/请求，错候选修订与无效worker拒绝且零外呼", async () => {
  for (const change of [f => { f.execution.ownerActor = {}; }, f => { f.execution.request = {}; },
    f => { f.trigger.expectedRevision += 1; }, f => { f.trigger.candidateId = "candidate:other"; },
    f => { f.execution.workerActor = { ...f.execution.workerActor, actorType: "human" }; }]) {
    const f = await fixture(); change(f); const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.runtime.continueSavedCurrent(f.trigger));
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls(), 0);
  }
});

test("未知终态持久保留，不应用、不重发", async () => {
  const f = await fixture({ gateway: async () => { throw new C1AiGatewayError("C1_GATEWAY_TIMEOUT", "gateway_status", "synthetic timeout", { externalRequestState: "unknown_outcome" }); } });
  assert.equal((await f.runtime.continueSavedCurrent(f.trigger)).status, "unknown_outcome");
  assert.equal((await f.runtime.continueSavedCurrent(f.trigger)).status, "stopped");
  assert.equal(f.calls(), 1);
  assert.equal((await f.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.c2FinalAssets, null);
});

test("回执已保存但并发备注改变revision时拒绝应用，原费用与备注保留", async () => {
  const f = await fixture({ gateway: async ({ input, repository, formal }) => {
    await repository.transact(document => { document.candidates[0].notes = "concurrent note"; document.candidates[0].dataRevision += 1; return { changed: true, document, result: null }; });
    return { status: "receipt_ready", request: input.request, receipt: formal.receipt, jobId: formal.receipt.gatewayJobId };
  } });
  await assert.rejects(() => f.runtime.continueSavedCurrent(f.trigger), /REVISION_CONFLICT/);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status, "completed");
  assert.ok(saved.runtime.softwareJobs[0].resultEnvelope.payload.receipt.accounting);
  assert.equal(saved.candidates[0].notes, "concurrent note");
  await assert.rejects(() => f.runtime.continueSavedCurrent(f.trigger), /REVISION_CONFLICT/);
  assert.equal(f.calls(), 1);
});
