import { createSeerfarDiscoveryRuntimeFixture, syntheticMarketProduct } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import { createASupplierImageSearchJobForScope } from '../lib/software-job-repository.mjs';
import { assertASupplierImageSearchSource } from '../lib/a-supplier-image-search-contract.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createASupplierImageSearchStoreFixture, createASupplierImageSearchReceipt } from './helpers/a-supplier-image-search-fixture.mjs';
import { assertASupplierImageSearchReceipt } from '../lib/a-supplier-image-search-contract.mjs';

async function claim(f) {
  await f.store.enqueue(f.job);
  return f.store.claim({ jobId: f.job.jobId, worker: f.worker, leaseId: 'lease:synthetic-image-search', leaseDurationMs: 60000 });
}
async function markSent(f, claimed) {
  await f.repository.transact(document => {
    const receipt = createASupplierImageSearchReceipt({ scope: f.scope, job: claimed, at: f.clock() }, { inFlight: true });
    document.runtime.aSupplierImageSearchReceipts[claimed.jobId] = receipt;
    f.store.assertASupplierImageSearchExecutionInDocument({ document, jobId: claimed.jobId,
      workerId: claimed.workerId, leaseId: claimed.leaseId, observedAt: f.clock(), markRequestSent: true });
    Object.assign(receipt.steps[0], { sentAt: f.clock(), externalRequestState: 'in_flight', requestTransmission: 'attempted' });
    return { document, changed: true };
  });
  return f.store.get(claimed.jobId);
}

test('synthetic image search enqueues once and only one concurrent claim wins', async t => {
  const f = await createASupplierImageSearchStoreFixture(t);
  await f.store.enqueue(f.job);
  const before = await f.repository.readSnapshot();
  await f.store.enqueue(f.job);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  const outcomes = await Promise.allSettled(['one', 'two'].map(value => f.store.claim({ jobId: f.job.jobId,
    worker: f.worker, leaseId: `lease:${value}`, leaseDurationMs: 60000 })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.equal(saved.runtime.softwareJobs[0].attempt, 1);
  assert.equal(saved.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.deepEqual(saved.candidates, [f.candidate]);
});

test('legacy detail capability cannot claim an image-search job', async t => {
  const f = await createASupplierImageSearchStoreFixture(t);
  await f.store.enqueue(f.job);
  const wrongWorker = f.workerRegistry.register({ workerId: 'worker:synthetic-legacy-detail', version: 'version:synthetic-1',
    capabilities: ['linkfox-product-detail-api'], observedAt: f.clock() });
  const before = await f.repository.readSnapshot();
  await assert.rejects(f.store.claim({ jobId: f.job.jobId, worker: wrongWorker, leaseId: 'lease:wrong-capability', leaseDurationMs: 60000 }), /CAPABILITY|CAPABILITIES|WORKER/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

for (const boundary of ['expired-authorization', 'revision', 'image-source']) {
  test(`${boundary} prevents sending the image and preserves candidate facts`, async t => {
    const f = await createASupplierImageSearchStoreFixture(t), claimed = await claim(f);
    if (boundary === 'expired-authorization') f.advance(10000);
    else await f.repository.transact(document => {
      if (boundary === 'revision') document.candidates[0].dataRevision++;
      else document.candidates[0].salesSnapshotsV11[0].evidenceRef = 'evidence:another-source';
      return { document, changed: true };
    });
    const before = await f.repository.readSnapshot();
    await assert.rejects(markSent(f, claimed), boundary === 'expired-authorization' ? /AUTHORIZATION_EXPIRED/ :
      boundary === 'revision' ? /CANDIDATE_CHANGED|REVISION_CONFLICT/ : /SOURCE_INVALID/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal((await f.store.get(claimed.jobId)).externalRequestState, 'not_sent');
  });
}

for (const empty of [false, true]) {
  test(`completed ${empty ? 'true-empty' : 'candidate'} search only appends evidence without supply confirmation or detail dispatch`, async t => {
    const f = await createASupplierImageSearchStoreFixture(t), job = await markSent(f, await claim(f));
    await f.repository.transact(document => {
      document.runtime.aSupplierImageSearchReceipts[job.jobId] = createASupplierImageSearchReceipt({ scope: f.scope, job, at: f.clock() }, { empty });
      const result = f.store.settleASupplierImageSearchInDocument({ document, jobId: job.jobId, workerId: job.workerId,
        leaseId: job.leaseId, observedAt: f.clock() });
      return { document, changed: true, result };
    });
    const saved = await f.repository.readSnapshot(), completed = await f.store.get(job.jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.externalRequestState, 'succeeded');
    assert.deepEqual(saved.candidates, [f.candidate]);
    assert.equal(saved.runtime.softwareJobs.length, 1);
    const receipt = assertASupplierImageSearchReceipt(saved.runtime.aSupplierImageSearchReceipts[job.jobId], completed);
    assert.equal(receipt.steps[0].result.status, empty ? 'true_empty' : 'candidates_found');
    for (const product of receipt.steps[0].result.products) {
      assert.equal(product.sameSku, 'unknown'); assert.equal(product.minimumOrderQuantity, null);
    }
    await f.store.enqueue(f.job);
    assert.deepEqual(await f.repository.readSnapshot(), saved);
  });
}

test('sent search survives JSON cold restart as unknown and cannot replay', async t => {
  const f = await createASupplierImageSearchStoreFixture(t), job = await markSent(f, await claim(f));
  const repository = f.coldRepository(), store = f.makeStore(repository);
  await store.reconcileAfterRestart();
  const saved = await repository.readSnapshot(), recovered = await store.get(job.jobId);
  assert.equal(recovered.status, 'unknown_outcome');
  assert.equal(recovered.externalRequestState, 'unknown_outcome');
  assert.equal(saved.runtime.aSupplierImageSearchReceipts[job.jobId].status, 'unknown_outcome');
  assert.deepEqual(saved.candidates, [f.candidate]);
  assert.equal(saved.runtime.softwareJobs.length, 1);
  await assert.rejects(store.claim({ jobId: job.jobId, worker: f.worker, leaseId: 'lease:forbidden-replay', leaseDurationMs: 60000 }));
  await store.reconcileAfterRestart();
  assert.deepEqual(await repository.readSnapshot(), saved);
});

for (const boundary of ['expired-authorization', 'revision']) {
  test(`${boundary} rejects enqueue without consuming authorization`, async t => {
    const f = await createASupplierImageSearchStoreFixture(t);
    if (boundary === 'expired-authorization') f.advance(10000);
    else await f.repository.transact(document => { document.candidates[0].dataRevision++; return { document, changed: true }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.store.enqueue(f.job), /EXPIRED|CHANGED|REVISION/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(before.runtime.softwareJobAuthorizationRecords[0].useCount, 0);
  });
}

test('expired sent lease becomes unknown without a second search', async t => {
  const f = await createASupplierImageSearchStoreFixture(t), job = await markSent(f, await claim(f));
  f.advance(60001);
  await f.store.reconcileExpiredLeases();
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.softwareJobs[0].status, 'unknown_outcome');
  assert.equal(saved.runtime.aSupplierImageSearchReceipts[job.jobId].status, 'unknown_outcome');
  assert.equal(saved.runtime.softwareJobs.length, 1);
  assert.deepEqual(saved.candidates, [f.candidate]);
});


test('published strict schemas cover actual queued claimed terminal jobs and reject unsafe or incompatible DTOs', async t => {
  const ajv = await loadPublishedSchemaValidator();
  const jobSchema = ajv.getSchema('software-job-v3.schema.json');
  const receiptSchema = ajv.getSchema('a-supplier-image-search-v1.schema.json#/$defs/receipt');
  const resultSchema = ajv.getSchema('a-supplier-image-search-v1.schema.json#/$defs/result');
  const scopeSchema = ajv.getSchema('a-supplier-image-search-v1.schema.json#/$defs/scope');
  for (const validate of [jobSchema, receiptSchema, resultSchema, scopeSchema]) assert.equal(typeof validate, 'function');
  const f = await createASupplierImageSearchStoreFixture(t);
  const queued = await f.store.enqueue(f.job), claimed = await claim(f), sent = await markSent(f, claimed);
  const receipt = createASupplierImageSearchReceipt({ scope: f.scope, job: sent, at: f.clock() });
  await f.repository.transact(document => {
    document.runtime.aSupplierImageSearchReceipts[sent.jobId] = receipt;
    f.store.settleASupplierImageSearchInDocument({ document, jobId: sent.jobId, workerId: sent.workerId,
      leaseId: sent.leaseId, observedAt: f.clock() });
    return { document, changed: true };
  });
  const completed = await f.store.get(sent.jobId);
  for (const job of [queued, claimed, sent, completed]) assert.equal(jobSchema(job), true, JSON.stringify(jobSchema.errors));
  assert.equal(receiptSchema(receipt), true, JSON.stringify(receiptSchema.errors));
  assert.equal(resultSchema(receipt.steps[0].result), true, JSON.stringify(resultSchema.errors));
  assert.equal(scopeSchema(f.scope), true, JSON.stringify(scopeSchema.errors));
  for (const mutate of [
    job => { job.token = 'synthetic-forbidden-field'; },
    job => { job.candidateId = f.candidate.id; },
    job => { job.skuPackageId = 'sku:forbidden-pre-sku'; },
    job => { job.subject = { kind: 'discovery_batch', batchId: 'batch:wrong', revision: 0 }; },
    job => { job.requiredCapabilities = ['linkfox-product-detail-api']; }
  ]) {
    const bad = structuredClone(queued); mutate(bad); assert.equal(jobSchema(bad), false);
  }
  const badScope = structuredClone(f.scope);
  badScope.imageSource.imageRef = 'https://images.example.com/synthetic.jpg';
  assert.equal(scopeSchema(badScope), false);
  const rawResult = { ...structuredClone(receipt.steps[0].result), rawResponse: 'synthetic-forbidden-payload' };
  assert.equal(resultSchema(rawResult), false);
  const tooMany = structuredClone(receipt.steps[0].result);
  tooMany.products = Array.from({ length: 5 }, (_, index) => ({ ...tooMany.products[0], offerId: String(900000000000 + index),
    sourceUrl: `https://detail.1688.com/offer/${900000000000 + index}.html` }));
  assert.equal(resultSchema(tooMany), false);
  const impossibleFailure = structuredClone(receipt);
  impossibleFailure.status = 'failed'; impossibleFailure.failureClass = 'TIMEOUT';
  Object.assign(impossibleFailure.steps[0], { result: null, errorCode: 'TIMEOUT', externalRequestState: 'in_flight', requestTransmission: 'attempted' });
  assert.equal(receiptSchema(impossibleFailure), false);
});


test('completed Seerfar transport receipt supplies the current image and rejects changed envelope or product identity', async t => {
  const discovery = await createSeerfarDiscoveryRuntimeFixture(t, { products: [syntheticMarketProduct()] });
  const { service } = discovery.create(), created = await discovery.prepare(service);
  assert.equal((await discovery.authorize(service, created)).status, 'completed');
  await service.stop();
  const discovered = await discovery.repository.readSnapshot();
  assert.deepEqual(discovery.calls.map(call => call.step), ['quota_before', 'category_detail', 'quota_after']);
  const f = await createASupplierImageSearchStoreFixture(t), candidate = discovered.candidates[0];
  const source = candidate.aDiscoveryEvidenceV2;
  Object.assign(f.scope, { candidateId: candidate.id, sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision,
    targetStore: candidate.targetStore, imageSource: { kind: 'seerfar_market_product', marketReceiptRef: source.marketReceiptRef,
      marketProductId: source.marketProductId, imageIndex: 0, imageRef: `image:${source.marketReceiptRef}:${source.marketProductId}:0` } });
  f.candidate = structuredClone(candidate);
  f.authorization.scopeBinding = structuredClone(f.scope);
  f.credential.scopeBinding = structuredClone(f.scope);
  f.job = createASupplierImageSearchJobForScope({ scope: f.scope, ownerUserId: f.owner.userId, createdAt: f.clock() });
  await f.repository.transact(() => {
    const document = structuredClone(discovered);
    document.runtime.softwareJobAuthorizationRecords.push(f.authorization);
    document.runtime.softwareJobCredentialBindings.push(f.credential);
    document.runtime.aSupplierImageSearchReceipts = {};
    return { document, changed: true };
  });
  const baseline = await f.repository.readSnapshot();
  const resolved = assertASupplierImageSearchSource({ document: baseline, candidate: baseline.candidates[0], scope: f.scope });
  assert.equal(resolved.imageUrl, syntheticMarketProduct().imageUrl);
  assert.equal(resolved.sourceJob.status, 'completed');
  assert.equal(resolved.sourceReceipt.status, 'completed');
  const claimed = await claim(f), saved = await f.repository.readSnapshot();
  for (const mutate of [
    document => { document.runtime.softwareJobs[0].resultEnvelope.payload.receiptRef = 'receipt:other'; },
    document => { document.candidates[0].aDiscoveryEvidenceV2.batchId = 'batch:other'; },
    document => { document.candidates[0].aDiscoveryEvidenceV2.marketProductId = '9999999999'; }
  ]) {
    const corrupted = structuredClone(saved); mutate(corrupted);
    assert.throws(() => f.store.assertASupplierImageSearchExecutionInDocument({ document: corrupted, jobId: claimed.jobId,
      workerId: claimed.workerId, leaseId: claimed.leaseId, observedAt: f.clock() }), /SOURCE_INVALID|COMPLETED_RESULT_CONFLICT/);
  }
  assert.deepEqual(await f.repository.readSnapshot(), saved);
  const sent = await markSent(f, claimed);
  assert.equal(sent.externalRequestState, 'in_flight');
  assert.deepEqual((await f.repository.readSnapshot()).candidates, baseline.candidates);
  assert.equal(discovery.calls.length, 3);
});
