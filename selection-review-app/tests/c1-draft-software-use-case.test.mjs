import { createC1PaidFormalFixture } from "./fixtures/c1-draft-source-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createC1DraftSoftwareUseCase, prepareC1DraftSoftwareExecution } from "../lib/c1-draft-software-use-case.mjs";
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { createActorContext, createLocalDevelopmentActor } from "../lib/runtime-identity.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { executeBusinessMutation } from "../lib/business-mutation-transaction.mjs";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";
import { C1AiGatewayError } from "../lib/c1-ai-gateway.mjs";
import { createC1AiAccounting } from "../lib/c1-ai-draft-contract.mjs";

async function fixture(t, { json = false, atomicWriter, gateway, changeDocument } = {}) {
  const formal = createC1PaidFormalFixture();
  const at = formal.at;
  const owner = createLocalDevelopmentActor({ userId: "owner-c1-draft", at });
  const worker = createActorContext({ userId: "worker-c1-draft", sessionId: "worker-session-c1", actorType: "worker",
    roles: ["operator"], source: "local_worker", authenticatedAt: at });
  const input = { request: formal.request, expectedRevision: formal.candidate.dataRevision,
    authorizationRef: formal.authorizedExecution.authorizationRef.authorizationId,
    credentialAlias: "gateway-alias:formal", jobId: formal.receipt.softwareJobId,
    idempotencyKey: "enqueue:formal-c1:1", auditEventId: "audit:formal-c1:enqueue" };
  const prepared = prepareC1DraftSoftwareExecution({ candidate: formal.candidate, ...input,
    ownerUserId: owner.userId, requestedByUserId: owner.userId });
  const scopeBinding = prepared.jobInput.scopeBinding;
  const executionBinding = formal.executionBinding;
  const document = { candidates: [formal.candidate], runtime: { softwareJobs: [],
    softwareJobAuthorizationRecords: [{ schemaVersion: "software-job-authorization-record-v1",
      authorizationId: input.authorizationRef, authorizationType: "paid_ai_draft", action: "c1_ai_draft",
      status: "active", scopeBinding: structuredClone(scopeBinding), authorizedByUserId: owner.userId,
      authorizedAt: at, expiresAt: null, maxUses: 1, useCount: 0, consumedByJobId: null, consumedAt: null }],
    softwareJobCredentialBindings: [{ schemaVersion: "software-job-credential-binding-v1", bindingId: "binding:formal-c1",
      credentialAlias: input.credentialAlias, status: "active", provider: formal.request.provider, sideEffectScope: "c1_ai_draft",
      scopeBinding: structuredClone(scopeBinding), allowedWorkerIds: [worker.userId], redaction: "credential_alias_only", boundAt: at, expiresAt: null }] } };
  if (changeDocument) changeDocument(document);
  let filePath;
  let repository;
  if (json) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c1-draft-durable-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filePath = path.join(directory, "state.json");
    await writeFile(filePath, JSON.stringify(document), "utf8");
    repository = createJsonBusinessStateRepository({ filePath, ...(atomicWriter ? { atomicWriter } : {}) });
  } else repository = createMemoryBusinessStateRepository(document);
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  registry.register({ workerId: worker.userId, capabilities: ["ai-draft-gateway"], version: "1", observedAt: at });
  let calls = 0;
  const requestGateway = async args => {
    calls += 1;
    const saved = await repository.readSnapshot();
    assert.equal(saved.runtime.softwareJobs[0].status, "waiting_platform");
    assert.equal(saved.runtime.softwareJobs[0].externalRequestState, "in_flight");
    assert.deepEqual(args.request, saved.candidates[0].lifecycleV11.c1AiDraftRequestV1);
    assert.equal(args.authorizedExecution.candidateRevision, input.expectedRevision + 1);
    assert.equal(args.authorizedExecution.sourceSkuRevision, formal.request.sourceSkuRevision);
    assert.equal(args.credentialAlias, input.credentialAlias);
    if (gateway) return gateway({ ...args, repository, formal });
    return { status: "receipt_ready", jobId: formal.receipt.gatewayJobId, request: args.request, receipt: formal.receipt };
  };
  const makeUseCase = (targetRepository = repository) => createC1DraftSoftwareUseCase({ repository: targetRepository,
    runtimeMode: "local_development", serverClock: () => at, workerRegistry: registry, requestGateway, executionBinding });
  const usecase = makeUseCase();
  const run = { actor: worker, input: { jobId: input.jobId, leaseId: "lease:formal-c1", leaseDurationMs: 1_000 } };
  const apply = job => ({ actor: worker, input: { jobId: job.jobId, payloadFingerprint: job.resultEnvelope.payloadFingerprint,
    expectedRevision: job.revision, idempotencyKey: "apply:formal-c1:1", auditEventId: "audit:formal-c1:apply" } });
  return { formal, at, owner, worker, input, executionBinding, repository, usecase, run, apply, filePath, makeUseCase, calls: () => calls };
}

test("正式完整C1：保存请求和一次授权，先持久回执，再独立原子合并C1并建立C2", async t => {
  const f = await fixture(t);
  const before = structuredClone(f.formal.candidate);
  const enqueued = await f.usecase.enqueue({ actor: f.owner, input: f.input });
  assert.equal(enqueued.candidate.dataRevision, before.dataRevision + 1);
  assert.equal(enqueued.candidate.lifecycleV11.skuPackage.dataRevision, before.lifecycleV11.skuPackage.dataRevision);
  const result = await f.usecase.run(f.run);
  assert.equal(result.status, "receipt_saved");
  let saved = await f.repository.readSnapshot();
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
  const applied = await f.usecase.apply(f.apply(result.job));
  assert.equal(applied.result.status, "applied");
  saved = await f.repository.readSnapshot();
  assert.equal(saved.candidates[0].dataRevision, before.dataRevision + 2);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, "seo_draft_ready");
  assert.ok(saved.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.softwareState);
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "applied");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.formal.candidate, before);
});

test("真实JSON重启可只应用已保存回执，重复与并发应用只有一次候选变更", async t => {
  const f = await fixture(t, { json: true });
  await f.usecase.enqueue({ actor: f.owner, input: f.input });
  const result = await f.usecase.run(f.run);
  const reopened = createJsonBusinessStateRepository({ filePath: f.filePath });
  const restarted = f.makeUseCase(reopened);
  const results = await Promise.all([restarted.apply(f.apply(result.job)), restarted.apply(f.apply(result.job))]);
  assert.deepEqual(new Set(results.map(value => value.status)), new Set(["committed", "idempotent_replay"]));
  const saved = JSON.parse(await readFile(f.filePath, "utf8"));
  assert.equal(saved.runtime.operationAudit.length, 2);
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "applied");
  assert.equal(f.calls(), 1);
  await assert.rejects(() => restarted.run(f.run), /REQUEST_ALREADY_ATTEMPTED/);
});

test("相同请求重复入队只消费一次，两个并发worker调用只能发出一个请求", async t => {
  const f = await fixture(t);
  const enqueues = await Promise.all([f.usecase.enqueue({ actor: f.owner, input: f.input }), f.usecase.enqueue({ actor: f.owner, input: f.input })]);
  assert.deepEqual(new Set(enqueues.map(value => value.status)), new Set(["committed", "idempotent_replay"]));
  const runs = await Promise.allSettled([f.usecase.run(f.run), f.usecase.run(f.run)]);
  assert.equal(runs.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(runs.filter(value => value.status === "rejected").length, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(f.calls(), 1);
});

test("apply拒绝同候选修订下店铺映射和冻结输入漂移，租约后登记回执不续权", async t => {
  for (const change of [
    candidate => { candidate.storeRef.platformStoreId = "other-platform-store"; },
    candidate => { candidate.storeRef.mappingVersion = "mapping-revised"; },
    candidate => { candidate.lifecycleV11.c1AiDraftRequestV1.sourceInputFingerprint = "f".repeat(64); }
  ]) {
    const f = await fixture(t);
    await f.usecase.enqueue({ actor: f.owner, input: f.input });
    const result = await f.usecase.run(f.run);
    await f.repository.transact(async document => { change(document.candidates[0]); return { changed: true, document, result: null }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.apply(f.apply(result.job)), /APPLICATION_SOURCE_CONFLICT/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
  const f = await fixture(t);
  let currentTime = f.at;
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  registry.register({ workerId: f.worker.userId, capabilities: ["ai-draft-gateway"], version: "1", observedAt: currentTime });
  const usecase = createC1DraftSoftwareUseCase({ repository: f.repository, runtimeMode: "local_development", serverClock: () => currentTime,
    workerRegistry: registry, requestGateway: async ({ request }) => {
      currentTime = new Date(Date.parse(f.at) + 61_000).toISOString();
      return { status: "receipt_ready", jobId: f.formal.receipt.gatewayJobId, request,
        receipt: { ...f.formal.receipt, completedAt: currentTime } };
    } });
  await usecase.enqueue({ actor: f.owner, input: f.input });
  const result = await usecase.run(f.run);
  assert.equal(result.status, "receipt_saved");
  assert.equal(result.job.leaseExpiresAt, new Date(Date.parse(f.at) + 1_000).toISOString());
  assert.equal(result.job.attempt, 1);
});

test("保存请求、请求开始或终态失败时不越过持久化边界，不吞I/O异常", async t => {
  for (const failingWrite of [1, 3, 4, 5]) {
    let writes = 0;
    const f = await fixture(t, { json: true, atomicWriter: async (filePath, document) => {
      writes += 1;
      if (writes === failingWrite) throw new Error("simulated_write_failure");
      return persistJsonThroughRealTarget(filePath, document);
    } });
    if (failingWrite === 1) await assert.rejects(() => f.usecase.enqueue({ actor: f.owner, input: f.input }), /simulated_write_failure/);
    else {
      await f.usecase.enqueue({ actor: f.owner, input: f.input });
      if (failingWrite < 5) await assert.rejects(() => f.usecase.run(f.run), /simulated_write_failure/);
      else {
        const result = await f.usecase.run(f.run);
        await assert.rejects(() => f.usecase.apply(f.apply(result.job)), /simulated_write_failure/);
      }
    }
    const saved = JSON.parse(await readFile(f.filePath, "utf8"));
    assert.equal(f.calls(), failingWrite <= 3 ? 0 : 1);
    assert.equal(saved.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
    if (failingWrite === 1) assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 0);
    if (failingWrite === 4) assert.equal(saved.runtime.softwareJobs[0].externalRequestState, "in_flight");
    if (failingWrite === 5) assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
  }
});

test("缺失已保存付费授权、错误网关绑定和伪造额外准入字段全部拒绝", async t => {
  for (const changeDocument of [
    value => { value.runtime.softwareJobAuthorizationRecords = []; },
    value => { value.runtime.softwareJobAuthorizationRecords[0].authorizationType = "paid_keyword"; },
    value => { value.runtime.softwareJobCredentialBindings[0].scopeBinding.identity.storeRef.mappingVersion = "wrong"; }
  ]) {
    const f = await fixture(t, { changeDocument });
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.enqueue({ actor: f.owner, input: f.input }));
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(f.calls(), 0);
  }
  const f = await fixture(t);
  await assert.rejects(() => f.usecase.enqueue({ actor: f.owner, input: { ...f.input, paidAuthorization: true } }), /ENQUEUE_INPUT_INVALID/);
});

test("候选并发备注修订或SKU源修订漂移保留收费回执，双CAS禁止应用", async t => {
  for (const skuOnly of [false, true]) {
    const f = await fixture(t, { gateway: async ({ request, repository, formal }) => {
      await repository.transact(async document => {
        if (skuOnly) document.candidates[0].lifecycleV11.skuPackage.dataRevision += 1;
        else document.candidates[0].dataRevision += 1;
        return { changed: true, document, result: null };
      });
      return { status: "receipt_ready", jobId: formal.receipt.gatewayJobId, request, receipt: formal.receipt };
    } });
    await f.usecase.enqueue({ actor: f.owner, input: f.input });
    const result = await f.usecase.run(f.run);
    assert.equal(result.status, "receipt_saved");
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.apply(f.apply(result.job)), /REVISION_CONFLICT|SOURCE_CONFLICT/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(before.runtime.softwareJobs[0].resultEnvelope.payload.receipt.providerRequestId, f.formal.receipt.providerRequestId);
    assert.equal(f.calls(), 1);
  }
});

test("错误结果指纹、调用方mutator、未知终态和历史in_flight不能应用或重新付费", async t => {
  const f = await fixture(t);
  await f.usecase.enqueue({ actor: f.owner, input: f.input });
  const result = await f.usecase.run(f.run);
  const before = await f.repository.readSnapshot();
  const bad = f.apply(result.job);
  bad.input.payloadFingerprint = "f".repeat(64);
  await assert.rejects(() => f.usecase.apply(bad), /APPLICATION_SCOPE_CONFLICT/);
  await assert.rejects(() => executeBusinessMutation({ repository: f.repository, runtimeMode: "local_development", actor: f.owner,
    requiredRoles: ["owner"], action: "c1_ai_draft_apply", mutate: () => {},
    softwareJobApplicationEffect: { schemaVersion: "c1-ai-draft-application-effect-v1", jobId: result.job.jobId, payloadFingerprint: result.job.resultEnvelope.payloadFingerprint } }), /INPUT_INVALID:mutate/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  const g = await fixture(t, { gateway: async () => { throw new Error("internal_bug_not_a_gateway_failure"); } });
  await g.usecase.enqueue({ actor: g.owner, input: g.input });
  await assert.rejects(() => g.usecase.run(g.run), /internal_bug_not_a_gateway_failure/);
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: g.repository, serverClock: () => g.at });
  await store.reconcileAfterRestart();
  assert.equal((await store.get(g.input.jobId)).status, "unknown_outcome");
  await assert.rejects(() => g.usecase.run(g.run), /REQUEST_ALREADY_ATTEMPTED/);
  await assert.rejects(() => g.usecase.apply({ actor: g.worker, input: { jobId: g.input.jobId,
    payloadFingerprint: "a".repeat(64), expectedRevision: g.input.expectedRevision + 1,
    idempotencyKey: "apply:unknown", auditEventId: "audit:unknown" } }), /APPLICATION_SCOPE_CONFLICT/);
  assert.equal(g.calls(), 1);
});

test("网关明确失败、已成功但草稿拒绝和未知分开保存对账证据，异常原文不落盘", async t => {
  for (const externalRequestState of ["failed", "unknown_outcome", "succeeded"]) {
    const accounting = createC1AiAccounting({ gatewayJobId: "gateway-job:failed:1",
      providerRequestId: externalRequestState === "succeeded" ? "provider-call:rejected:1" : null,
      usage: externalRequestState === "succeeded" ? { prompt_tokens: 180, completion_tokens: 24, total_tokens: 204 } : "unknown" });
    const f = await fixture(t, { gateway: async () => {
      throw new C1AiGatewayError("C1_AI_INFERENCE_FAILED", "gateway_status", "untrusted private detail",
        { jobId: "gateway-job:failed:1", externalRequestState, accounting });
    } });
    await f.usecase.enqueue({ actor: f.owner, input: f.input });
    const result = await f.usecase.run(f.run);
    assert.equal(result.status, externalRequestState === "unknown_outcome" ? "unknown_outcome" : "failed");
    assert.equal(result.job.externalRequestState, externalRequestState);
    assert.equal(result.job.resultRef, "gateway-job:failed:1");
    assert.deepEqual(result.job.resultEnvelope.payload.accounting, accounting);
    assert.equal(result.job.resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
    assert.equal(result.job.resultEnvelope.payload.accounting.charge.status, "unknown");
    assert.equal(JSON.stringify(await f.repository.readSnapshot()).includes("untrusted private detail"), false);
    await assert.rejects(() => f.usecase.run(f.run), /REQUEST_ALREADY_ATTEMPTED/);
    assert.equal(f.calls(), 1);
  }
});

async function keywordHandoffRetryUseCaseFixture() {
  const {createC1KeywordHandoffRetryFixture,keywordHandoffDraftBinding:binding}=await import('./fixtures/c1-keyword-handoff-retry-fixture.mjs');
  const f=await createC1KeywordHandoffRetryFixture();
  const usecase=createC1DraftSoftwareUseCase({repository:f.repository,runtimeMode:'local_development',serverClock:f.clock,
    executionBinding:{provider:binding.provider,modelVersion:binding.modelVersion,credentialAlias:binding.credentialAlias,allowedWorkerIds:[binding.workerId]}});
  return {...f,usecase};
}

test('keyword handoff retry is a single atomic local request under duplicate and concurrent owner submissions',async()=>{
  const f=await keywordHandoffRetryUseCaseFixture();
  const results=await Promise.all([f.usecase.retryKeywordHandoff({actor:f.owner,input:f.input}),f.usecase.retryKeywordHandoff({actor:f.owner,input:f.input})]);
  assert.deepEqual(results.map(value=>value.status),['committed','idempotent_replay']);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(results[0].result,results[1].result);assert.equal(saved.candidates[0].dataRevision,f.input.expectedRevision+1);
  assert.equal(saved.runtime.idempotencyRecords.filter(value=>value.action==='c1_keyword_handoff_retry').length,1);
  assert.deepEqual(saved.runtime.softwareJobs,f.document.runtime.softwareJobs);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,f.document.runtime.softwareJobAuthorizationRecords);
  assert.deepEqual(saved.runtime.idempotencyRecords.at(-1).result.priorTechnicalFailure,f.document.candidates[0].executionRuntime.technicalFailure);
  await assert.rejects(f.usecase.retryKeywordHandoff({actor:f.owner,input:{...f.input,idempotencyKey:'retry:keyword:second',auditEventId:'audit:retry:second'}}),/BUSINESS_MUTATION_REVISION_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(),saved);assert.deepEqual(f.counts(),{keywordCalls:1,gatewayCalls:0});
});

test('keyword handoff retry rejects wrong permission, scope, failure or current evidence without changing state',async()=>{
  const f=await keywordHandoffRetryUseCaseFixture();
  for(const [input,pattern] of [
    [{...f.input,confirmed:true},/C1_KEYWORD_HANDOFF_RETRY_INPUT_INVALID/],
    [{...f.input,keywordJobId:'job:other'},/C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT/],
    [{...f.input,failureId:'failure:other'},/C1_KEYWORD_HANDOFF_RECOVERY_REJECTED/],
    [{...f.input,expectedRevision:f.input.expectedRevision+1},/BUSINESS_MUTATION_REVISION_CONFLICT/]
  ]) {
    await assert.rejects(f.usecase.retryKeywordHandoff({actor:f.owner,input}),pattern);
    assert.deepEqual(await f.repository.readSnapshot(),f.document);
  }
  await assert.rejects(f.usecase.retryKeywordHandoff({actor:{...f.owner,actorType:'software'},input:f.input}),/C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(),f.document);
  for(const mutate of [
    candidate=>{candidate.executionRuntime.technicalFailure.sourceRevision++;},
    candidate=>{candidate.executionRuntime.technicalFailure.evidenceRefs=['receipt:other'];},
    candidate=>{candidate.executionRuntime.technicalFailure.errorCode='OTHER_CONFIGURATION_FAILURE';},
    candidate=>{candidate.lifecycleV11.c1PaidKeywordEvidenceSettlementV1.resultFingerprint='0'.repeat(64);}
  ]) {
    await f.repository.transact(()=>{const document=structuredClone(f.document);mutate(document.candidates[0]);return {changed:true,document};});
    const before=await f.repository.readSnapshot();
    await assert.rejects(f.usecase.retryKeywordHandoff({actor:f.owner,input:f.input}),/C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT|C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT|C1_KEYWORD_HANDOFF_RECOVERY_REJECTED/);
    assert.deepEqual(await f.repository.readSnapshot(),before);
  }
});
