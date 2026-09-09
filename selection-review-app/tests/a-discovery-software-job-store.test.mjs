import test from 'node:test';
import assert from 'node:assert/strict';
import { createADiscoveryContractFixture, createADiscoveryContractReceipt, discoveryAt } from './fixtures/a-discovery-contract-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore, createADiscoveryJobForScope, ADiscoveryExecutionBlockedError } from '../lib/software-job-repository.mjs';
import { createSoftwareJobEnvelope, claimSoftwareJobLease, assertCompletedADiscoveryJobResult } from '../lib/software-job-contract.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';

function fixture() {
  const base = createADiscoveryContractFixture();
  const scopes = base.batch.plan.requests.map((request, requestIndex) => ({ ...structuredClone(base.scope), request, requestIndex, authorizationRef: `permit:synthetic:${requestIndex}` }));
  const document = { candidates: [], runtime: { softwareJobs: [], aDiscoveryBatches: { [base.batch.batchId]: base.batch }, aDiscoveryReceipts: {},
    softwareJobAuthorizationRecords: scopes.map(scope => ({ ...structuredClone(base.authorization), authorizationId: scope.authorizationRef, scopeBinding: scope })),
    softwareJobCredentialBindings: scopes.map(scope => ({ ...structuredClone(base.credential), bindingId: `binding:one-use:${scope.requestIndex}`, scopeBinding: scope })) } };
  const repository = createMemoryBusinessStateRepository(document);
  let now = discoveryAt;
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => now });
  const worker = { workerId: 'worker:synthetic', version: 'worker-version:1', capabilities: ['linkfox-discovery-api'] };
  registry.register({ ...worker, observedAt: now });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: () => now, workerRegistry: registry });
  const job = createADiscoveryJobForScope({ scope: scopes[0], ownerUserId: base.batch.ownerUserId, createdAt: now });
  return { repository, store, registry, worker, job, scopes, base, advance(value) { now = value; } };
}
async function begin(f, job = f.job) {
  await f.store.enqueue(job);
  const claimed = await f.store.claim({ jobId: job.jobId, worker: f.worker, leaseId: `lease:${job.scopeBinding.requestIndex}`, leaseDurationMs: 60000 });
  await f.repository.transact(document => {
    const receipt = createADiscoveryContractReceipt({ scope: claimed.scopeBinding, job: claimed });
    receipt.status = 'in_flight'; receipt.completedAt = null;
    Object.assign(receipt.steps[0], { sentAt: null, completedAt: null, externalRequestState: 'not_sent', requestTransmission: 'not_attempted', result: null });
    document.runtime.aDiscoveryReceipts[job.jobId] = receipt;
    f.store.assertADiscoveryExecutionInDocument({ document, jobId: job.jobId, workerId: f.worker.workerId, leaseId: claimed.leaseId, observedAt: discoveryAt, markRequestSent: true });
    Object.assign(receipt.steps[0], { sentAt: discoveryAt, externalRequestState: 'in_flight', requestTransmission: 'unknown' });
    return { document, changed: true, result: null };
  });
  return f.store.get(job.jobId);
}
async function finish(f, job, { empty = false } = {}) {
  return f.repository.transact(document => {
    document.runtime.aDiscoveryReceipts[job.jobId] = createADiscoveryContractReceipt({ scope: job.scopeBinding, job }, { empty });
    const result = f.store.settleADiscoveryInDocument({ document, jobId: job.jobId, workerId: job.workerId, leaseId: job.leaseId, observedAt: discoveryAt });
    return { document, changed: true, result };
  });
}

test('v3 batch-only jobs use one existing queue and consumed permissions, then atomically enqueue only the approved next request', async () => {
  const f = fixture();
  assert.equal(f.job.schemaVersion, 'software-job-v3');
  assert.equal(Object.hasOwn(f.job, 'candidateId'), false);
  assert.equal(Object.hasOwn(f.job, 'skuPackageId'), false);
  const issued = await begin(f);
  const before = await f.repository.readSnapshot();
  assert.equal(before.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.equal(before.runtime.softwareJobAuthorizationRecords[1].useCount, 0);
  const settled = await finish(f, issued);
  assert.equal(settled.job.status, 'completed');
  const receipt = (await f.repository.readSnapshot()).runtime.aDiscoveryReceipts[f.job.jobId];
  assert.deepEqual(assertCompletedADiscoveryJobResult({ job: settled.job, receipt }), settled.job.resultEnvelope);
  assert.throws(() => assertCompletedADiscoveryJobResult({ job: { ...settled.job, resultRef: 'wrong' }, receipt }), /COMPLETED_RESULT_CONFLICT/);
  assert.equal(settled.nextJob.scopeBinding.requestIndex, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.length, 2);
  assert.deepEqual(saved.candidates, []);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[1].consumedByJobId, settled.nextJob.jobId);
  assert.deepEqual(await f.store.enqueue(f.job), settled.job);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
  await assert.rejects(() => f.store.claim({ jobId: f.job.jobId, worker: f.worker, leaseId: 'lease:again', leaseDurationMs: 60000 }), ADiscoveryExecutionBlockedError);
});

test('true-empty ends the plan and cold restart preserves unknown without replay', async () => {
  const empty = fixture(), issued = await begin(empty);
  assert.equal((await finish(empty, issued, { empty: true })).nextJob, null);
  assert.equal((await empty.repository.readSnapshot()).runtime.softwareJobs.length, 1);
  const f = fixture(); await begin(f);
  const restartedRepository = createMemoryBusinessStateRepository(await f.repository.readSnapshot());
  const restarted = createRepositoryBackedSoftwareJobStore({ businessStateRepository: restartedRepository, serverClock: () => discoveryAt, workerRegistry: f.registry });
  await restarted.reconcileAfterRestart();
  const saved = await restartedRepository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status, 'unknown_outcome');
  assert.equal(saved.runtime.aDiscoveryReceipts[f.job.jobId].status, 'unknown_outcome');
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.deepEqual((await restarted.reconcileAfterRestart()).reconciled, []);
  assert.deepEqual(await restartedRepository.readSnapshot(), saved);
});

test('current revision and expiry reject at the real send gate without a second intent', async () => {
  const f = fixture(); await begin(f);
  const saved = await f.repository.readSnapshot();
  for (const mode of ['revision', 'expiry']) {
    const document = structuredClone(saved);
    if (mode === 'revision') document.runtime.aDiscoveryBatches[f.base.batch.batchId].revision += 1;
    assert.throws(() => f.store.assertADiscoveryExecutionInDocument({ document, jobId: f.job.jobId,
      workerId: f.worker.workerId, leaseId: 'lease:0', observedAt: mode === 'expiry' ? f.scopes[0].expiresAt : discoveryAt }), ADiscoveryExecutionBlockedError);
  }
  assert.deepEqual(await f.repository.readSnapshot(), saved);
});

test('published v3 closed schema validates queued/claimed/completed jobs while old versions are not upgraded', async () => {
  const f = fixture(), ajv = await loadPublishedSchemaValidator(), validate = ajv.getSchema('software-job-v3.schema.json');
  assert.equal(validate(f.job), true, JSON.stringify(validate.errors));
  const issued = await begin(f);
  assert.equal(validate(issued), true, JSON.stringify(validate.errors));
  const settled = await finish(f, issued);
  assert.equal(validate(settled.job), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...settled.job, candidateId: 'invented' }), false);
  assert.equal(validate({ ...settled.job, schemaVersion: 'software-job-v2' }), false);
  assert.throws(() => createSoftwareJobEnvelope({ ...f.job, subject: undefined, candidateId: 'fake', skuPackageId: 'fake' }), /DISCOVERY_SUBJECT_INVALID/);
  assert.throws(() => claimSoftwareJobLease({ job: { ...f.job, schemaVersion: 'software-job-v1' }, worker: { ...f.worker, status: 'online' }, leaseId: 'lease', serverTime: discoveryAt, leaseDurationMs: 1000 }), /CLAIM_REJECTED/);
});


test('a changed next scope stops continuation but preserves the completed response and spent first permit', async () => {
  const f = fixture(), issued = await begin(f);
  await f.repository.transact(document => {
    document.runtime.aDiscoveryBatches[f.base.batch.batchId].revision += 1;
    return { document, changed: true, result: null };
  });
  const result = await finish(f, issued);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.continuationBlocker, 'A_DISCOVERY_BATCH_CHANGED');
  assert.equal(Object.hasOwn(result, 'unexpectedContinuationError'), false);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.aDiscoveryReceipts[f.job.jobId].status, 'completed');
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[1].useCount, 0);
});

test('unknown next-step corruption is returned outside the persisted result after current success commits', async () => {
  const f = fixture(), issued = await begin(f);
  await f.repository.transact(document => {
    document.runtime.softwareJobAuthorizationRecords.push(structuredClone(document.runtime.softwareJobAuthorizationRecords[1]));
    return { document, changed: true, result: null };
  });
  let original;
  const result = await f.repository.transact(document => {
    document.runtime.aDiscoveryReceipts[issued.jobId] = createADiscoveryContractReceipt({ scope: issued.scopeBinding, job: issued });
    const settled = f.store.settleADiscoveryInDocument({ document, jobId: issued.jobId, workerId: issued.workerId, leaseId: issued.leaseId, observedAt: discoveryAt });
    assert.equal(Object.hasOwn(settled, 'unexpectedContinuationError'), true);
    original = settled.unexpectedContinuationError;
    return { document, changed: true, result: { job: settled.job, continuationBlocker: settled.continuationBlocker } };
  });
  assert.match(original.message, /NEXT_AUTHORIZATION_REQUIRED/);
  assert.equal(result.job.status, 'completed');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(saved.runtime.aDiscoveryReceipts[issued.jobId].status, 'completed');
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[1].useCount, 0);
  assert.equal(JSON.stringify(saved).includes('NEXT_AUTHORIZATION_REQUIRED'), false);
});
