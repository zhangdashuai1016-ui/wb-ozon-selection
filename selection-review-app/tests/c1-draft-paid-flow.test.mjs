import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createC1DraftSoftwareUseCase } from '../lib/c1-draft-software-use-case.mjs';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext, createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { c1DraftPreparedCandidate, c1DraftPaidReceipt } from './fixtures/c1-draft-source-fixture.mjs';
import { assertC1ProviderOutcome, validateC1ProviderOutcome } from '../lib/c1-ai-draft-contract.mjs';
import { C1AiGatewayError } from '../lib/c1-ai-gateway.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { createSoftwareJobResultEnvelope, settleSoftwareJob } from '../lib/software-job-contract.mjs';

async function fixture(t, { json = false, gateway } = {}) {
  const candidate = c1DraftPreparedCandidate();
  const executionBinding = { provider: 'terra', modelVersion: 'gpt-5.6-terra', credentialAlias: 'gateway-alias:paid-fixture', allowedWorkerIds: ['worker-c1-draft'] };
  let time = KEYWORD_NOW; const clock = () => time;
  const owner = createActorContext({ userId: 'owner-paid-c1', sessionId: 'session:paid-c1', actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: time });
  const worker = createActorContext({ userId: 'worker-c1-draft', sessionId: 'session:worker-c1', actorType: 'worker', roles: ['operator'], source: 'registered_runtime_worker', authenticatedAt: time });
  const document = { candidates: [candidate], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } };
  let filePath, repository;
  if (json) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'c1-paid-flow-')); t.after(() => rm(dir, { recursive: true, force: true }));
    filePath = path.join(dir, 'state.json'); await writeFile(filePath, JSON.stringify(document));
    repository = createJsonBusinessStateRepository({ filePath });
  } else repository = createMemoryBusinessStateRepository(document);
  const registry = createLocalDevelopmentWorkerRegistry({ clock });
  registry.register({ workerId: worker.userId, capabilities: ['ai-draft-gateway'], version: '1', observedAt: time });
  let calls = 0;
  const makeUseCase = (repo = repository) => createC1DraftSoftwareUseCase({ repository: repo, runtimeMode: 'local_development', serverClock: clock,
    workerRegistry: registry, executionBinding, requestGateway: async args => {
      calls += 1; assert.equal(Object.hasOwn(args, 'paymentAuthorization'), false);
      if (gateway) return gateway(args, repo);
      const receipt = c1DraftPaidReceipt(args, clock());
      return { status: 'receipt_ready', request: args.request, receipt, jobId: receipt.gatewayJobId };
    } });
  const usecase = makeUseCase();
  const prepareInput = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, idempotencyKey: 'prepare:c1:1', auditEventId: 'audit:prepare:c1:1' };
  const approve = prepared => ({ actor: owner, input: { candidateId: candidate.id, expectedRevision: prepared.candidate.dataRevision,
    requestRef: prepared.result.requestRef, requestFingerprint: prepared.result.requestFingerprint,
    confirmPaidCall: true, expiresAt: null, idempotencyKey: 'approve:c1:1', auditEventId: 'audit:approve:c1:1' } });
  const runInput = enqueued => ({ candidateId: candidate.id, expectedRevision: enqueued.result.softwareJobRef.revision,
    jobId: enqueued.result.softwareJobRef.jobId, leaseId: 'lease:paid-c1', leaseDurationMs: 60_000 });
  return { candidate, executionBinding, owner, worker, repository, registry, clock, usecase, makeUseCase, prepareInput, approve, runInput, filePath, calls: () => calls,
    setTime(value) { time = value; registry.heartbeat({ workerId: worker.userId, capabilities: ['ai-draft-gateway'], version: '1' }); } };
}

async function prepareAndAuthorize(f) {
  const prepared = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  return { prepared, enqueued: await f.usecase.authorizeAndEnqueue(f.approve(prepared)) };
}

// A deliberately restricted historical synthetic record, never used as a normal execution fixture.
function historicalRestriction(request, binding, at) {
  return { schemaVersion: 'c1-ai-draft-payment-authorization-v1', proposalRef: 'proposal:historical:restricted', proposalFingerprint: 'a'.repeat(64),
    requestFingerprint: request.requestFingerprint, executionPolicy: { schemaVersion: 'c1-ai-draft-execution-policy-v1', policyRef: 'policy:historical:restricted',
      configurationVersion: 'history:1', ...binding, serviceBindingRef: 'service:historical', serviceContractVersion: 'history:1',
      quote: { schemaVersion: 'c1-ai-draft-quote-v1', quoteRef: 'quote:historical', quotedAt: at, expiresAt: new Date(Date.parse(at) + 3600000).toISOString(),
        maximumAmountMinor: 125, currency: 'CNY', currencyScale: 2, maxCalls: 1, allowZeroCharge: false } } };
}

test('无金额精确单次确认从保存请求到JSON重启执行，只收费调用一次', async t => {
  const f = await fixture(t, { json: true });
  const prepared = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  const initial = await f.repository.readSnapshot();
  assert.equal(initial.runtime.softwareJobs.length, 0); assert.equal(initial.runtime.softwareJobAuthorizationRecords.length, 0);
  assert.equal(Object.hasOwn(initial.candidates[0].lifecycleV11, 'c1AiDraftProposalsV1'), false);
  assert.equal(Object.hasOwn(initial.runtime, 'c1AiDraftExecutionPoliciesV1'), false);
  assert.equal(f.calls(), 0);
  assert.equal((await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput })).status, 'idempotent_replay');
  const approval = f.approve(prepared); const enqueued = await f.usecase.authorizeAndEnqueue(approval);
  assert.equal((await f.usecase.authorizeAndEnqueue(approval)).status, 'idempotent_replay');
  const restarted = createJsonBusinessStateRepository({ filePath: f.filePath });
  assert.equal((await f.makeUseCase(restarted).runSaved({ actor: f.worker, input: f.runInput(enqueued) })).status, 'applied');
  const saved = await restarted.readSnapshot();
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, 'C2');
  const authorization = saved.runtime.softwareJobAuthorizationRecords[0];
  assert.equal(authorization.useCount, 1); assert.equal(authorization.maxUses, 1); assert.equal(authorization.expiresAt, null);
  assert.equal(Object.hasOwn(authorization, 'paymentAuthorization'), false);
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope.payload.receipt.accounting.charge.status, 'unknown');
  assert.equal((await f.makeUseCase(restarted).runSaved({ actor: f.worker, input: f.runInput(enqueued) })).status, 'idempotent_replay');
  assert.equal(f.calls(), 1);
});

test('保存及确认不接受浏览器构造请求、额外金额、错误指纹、虚假主人或空确认', async t => {
  const f = await fixture(t); const before = await f.repository.readSnapshot();
  await assert.rejects(() => f.usecase.prepareCurrent({ actor: f.owner, input: { ...f.prepareInput, request: {} } }), /INPUT_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  const prepared = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  for (const change of [a => { a.input.maximumAmountMinor = 1; }, a => { a.input.requestFingerprint = 'b'.repeat(64); },
    a => { a.input.requestRef = 'request:other'; }, a => { a.input.confirmPaidCall = false; }, a => { a.input.expiresAt = 'invalid'; },
    a => { a.actor = createLocalDevelopmentActor({ userId: f.owner.userId, at: KEYWORD_NOW }); }, a => { a.actor = f.worker; }]) {
    const approval = structuredClone(f.approve(prepared)); change(approval); const snapshot = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.authorizeAndEnqueue(approval)); assert.deepEqual(await f.repository.readSnapshot(), snapshot);
  }
  assert.equal(f.calls(), 0);
});

test('有效期保留原合同：显式null与有效时间可保存，已过期许可不能新调用', async t => {
  const f = await fixture(t); const prepared = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  const approval = f.approve(prepared); approval.input.expiresAt = new Date(Date.parse(KEYWORD_NOW) + 60000).toISOString();
  const enqueued = await f.usecase.authorizeAndEnqueue(approval); f.setTime(approval.input.expiresAt);
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => f.usecase.runSaved({ actor: f.worker, input: f.runInput(enqueued) }), /EXPIRED/);
  assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls(), 0);
});

test('新调用要求当前真实K3有效，但已保存回执在K3过期后仍能只应用', async t => {
  const first = await fixture(t); const a = await prepareAndAuthorize(first);
  first.setTime(first.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1.validity.expiresAt);
  await assert.rejects(() => first.usecase.runSaved({ actor: first.worker, input: first.runInput(a.enqueued) }), /EVIDENCE_NOT_CURRENT|KEYWORD/);
  assert.equal(first.calls(), 0);
  const second = await fixture(t); const b = await prepareAndAuthorize(second);
  const run = second.runInput(b.enqueued);
  assert.equal((await second.usecase.run({ actor: second.worker, input: { jobId: run.jobId, leaseId: run.leaseId, leaseDurationMs: run.leaseDurationMs } })).status, 'receipt_saved');
  second.setTime(second.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1.validity.expiresAt);
  assert.equal((await second.usecase.runSaved({ actor: second.worker, input: run })).status, 'applied'); assert.equal(second.calls(), 1);
});

test('历史受限许可必须保留并明确阻断，不能以另一份无金额许可绕开', async t => {
  for (const differentId of [false, true]) {
    const f = await fixture(t); const { prepared, enqueued } = await prepareAndAuthorize(f);
    await f.repository.transact(document => {
      const restriction = structuredClone(document.runtime.softwareJobAuthorizationRecords[0]);
      restriction.paymentAuthorization = historicalRestriction(prepared.result.request, f.executionBinding, KEYWORD_NOW);
      if (differentId) { restriction.authorizationId = 'authorization:historical:restricted'; restriction.scopeBinding.authorizationRef = restriction.authorizationId; document.runtime.softwareJobAuthorizationRecords.push(restriction); }
      else document.runtime.softwareJobAuthorizationRecords[0] = restriction;
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.runSaved({ actor: f.worker, input: f.runInput(enqueued) }), /RESTRICTED_AUTHORIZATION_UNSUPPORTED/);
    assert.deepEqual(await f.repository.readSnapshot(), before); assert.equal(f.calls(), 0);
  }
});

test('未注册Worker、变更请求来源和未解决作业不能获得另一轮许可', async t => {
  const f = await fixture(t); const prepared = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  f.registry.markOffline(f.worker.userId); const before = await f.repository.readSnapshot();
  await assert.rejects(() => f.usecase.authorizeAndEnqueue(f.approve(prepared)), /WORKER_NOT_CURRENT/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  f.registry.heartbeat({ workerId: f.worker.userId, capabilities: ['ai-draft-gateway'], version: '1' });
  const enqueued = await f.usecase.authorizeAndEnqueue(f.approve(prepared));
  await assert.rejects(() => f.usecase.prepareCurrent({ actor: f.owner, input: { ...f.prepareInput, expectedRevision: enqueued.candidate.dataRevision,
    idempotencyKey: 'prepare:c1:again', auditEventId: 'audit:prepare:c1:again' } }), /CURRENT_JOB_UNRESOLVED/);
  assert.equal(f.calls(), 0);
});

test('请求新版本历史由原子幂等记录保留，不建立报价或第二套存储', async t => {
  const f = await fixture(t); const first = await f.usecase.prepareCurrent({ actor: f.owner, input: f.prepareInput });
  f.setTime(new Date(Date.parse(KEYWORD_NOW) + 1000).toISOString());
  const second = await f.usecase.prepareCurrent({ actor: f.owner, input: { ...f.prepareInput, expectedRevision: first.candidate.dataRevision,
    idempotencyKey: 'prepare:c1:2', auditEventId: 'audit:prepare:c1:2' } });
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.idempotencyRecords[0].result.request, first.result.request);
  assert.deepEqual(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1, second.result.request);
  await assert.rejects(() => f.usecase.authorizeAndEnqueue(f.approve(first)), /CONFLICT/);
});

test('accepted ID在未知程序异常后持久保留，runSaved不重发', async t => {
  const failure = new Error('synthetic-unexpected-gateway-error');
  const f = await fixture(t, { gateway: async args => { await args.onGatewayJobAccepted({ gatewayJobId: 'gateway:synthetic:unknown' }); throw failure; } });
  const { enqueued } = await prepareAndAuthorize(f);
  await assert.rejects(() => f.usecase.runSaved({ actor: f.worker, input: f.runInput(enqueued) }), error => error === failure);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].progressRef, 'gateway:synthetic:unknown');
  assert.equal(saved.runtime.softwareJobs[0].resultEnvelope, null);
  assert.equal((await f.usecase.runSaved({ actor: f.worker, input: f.runInput(enqueued) })).status, 'stopped'); assert.equal(f.calls(), 1);
});

test('供应商未发出与中央已调用网关分开保存，不错误标成零网关调用', async t => {
  const providerOutcome = { schemaVersion: 'c1-provider-outcome-v1', failureLayer: 'credential', externalRequestState: 'not_sent', requestTransmission: 'not_attempted' };
  let inFlight;
  const f = await fixture(t, { gateway: async (_args, repository) => {
    inFlight = (await repository.readSnapshot()).runtime.softwareJobs[0];
    throw new C1AiGatewayError('C1_GATEWAY_PROVIDER_REJECTED', 'credential', 'synthetic provider unavailable', { externalRequestState: 'failed', providerOutcome });
  } });
  const { enqueued } = await prepareAndAuthorize(f);
  assert.equal((await f.usecase.runSaved({ actor: f.worker, input: f.runInput(enqueued) })).status, 'failed');
  const saved = await f.repository.readSnapshot(); assert.equal(saved.runtime.softwareJobs[0].externalRequestState, 'failed');
  assert.deepEqual(saved.runtime.softwareJobs[0].resultEnvelope.payload.providerOutcome, providerOutcome); assert.equal(f.calls(), 1);
  const completed = saved.runtime.softwareJobs[0];
  const resettle = payload => settleSoftwareJob({ job: inFlight, workerId: inFlight.workerId, leaseId: inFlight.leaseId,
    status: 'failed', externalRequestState: 'failed', failureClass: completed.failureClass, serverTime: f.clock(),
    resultEnvelope: createSoftwareJobResultEnvelope({ ...completed.resultEnvelope, job: inFlight, payload }) });
  const forged = structuredClone(completed.resultEnvelope.payload);
  forged.providerOutcome.externalRequestState = 'succeeded'; forged.providerOutcome.requestTransmission = 'response_received';
  // Rebuilding the envelope recomputes its fingerprint; the independent terminal-state check must still reject it.
  assert.throws(() => resettle(forged), /SOFTWARE_JOB_C1_AI_FAILURE_RESULT_INVALID/);
  const legacy = structuredClone(completed.resultEnvelope.payload); legacy.providerOutcome = null;
  assert.equal(resettle(legacy).status, 'failed');
  delete legacy.providerOutcome; assert.equal(resettle(legacy).status, 'failed');
});

test('providerOutcome为严格四字段合同，保留每种真实传输状态与错误类别', () => {
  for (const externalRequestState of ['not_sent', 'failed', 'succeeded', 'unknown_outcome']) {
    for (const requestTransmission of ['not_attempted', 'attempted', 'response_received', 'unknown']) {
      const dto = { schemaVersion: 'c1-provider-outcome-v1', failureLayer: 'provider', externalRequestState, requestTransmission };
      const valid = externalRequestState === 'unknown_outcome' || (externalRequestState === 'not_sent' ? requestTransmission === 'not_attempted' : requestTransmission === 'response_received');
      assert.equal(validateC1ProviderOutcome(dto).valid, valid);
      if (valid) { assert.deepEqual(assertC1ProviderOutcome(dto), dto); assert.equal(Object.isFrozen(assertC1ProviderOutcome(dto)), true); }
      else assert.throws(() => assertC1ProviderOutcome(dto), /TRANSMISSION_CONFLICT/);
    }
  }
  for (const dto of [null, {}, { schemaVersion: 'c1-provider-outcome-v1', failureLayer: 'provider', externalRequestState: 'not_sent', requestTransmission: 'not_attempted', raw: 'extra' }]) assert.equal(validateC1ProviderOutcome(dto).valid, false);
});

test('发布schema允许原无金额授权，保留历史受限记录的严格形状', async t => {
  const f = await fixture(t); const { prepared } = await prepareAndAuthorize(f);
  const saved = await f.repository.readSnapshot(); const record = saved.runtime.softwareJobAuthorizationRecords[0];
  const ajv = await loadPublishedSchemaValidator(); const validate = ajv.getSchema('software-job-admission-v1.schema.json#/$defs/softwareJobAuthorizationRecord');
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  const historical = structuredClone(record); historical.paymentAuthorization = historicalRestriction(prepared.result.request, f.executionBinding, KEYWORD_NOW);
  assert.equal(validate(historical), true, JSON.stringify(validate.errors));
  historical.paymentAuthorization.executionPolicy.quote.maxCalls = 2;
  assert.equal(validate(historical), false);
});
