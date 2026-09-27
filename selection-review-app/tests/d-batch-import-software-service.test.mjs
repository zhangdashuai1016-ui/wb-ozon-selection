import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedFixture, capabilities as formalCapabilities } from './helpers/d-software-fixture.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createDBatchImportSoftwareService } from '../lib/d-batch-import-software-service.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

const now = '2026-08-22T07:25:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10,
  intervalMs: 0, expiresAt: '2026-09-01T00:00:00.000Z', requestTimeoutMs: 10_000 };

async function fixture() {
  let currentTime = now;
  const source = await preparedFixture();
  const request = source.prepared.executableRequest;
  const candidate = { id: source.fixture.candidateId, dataRevision: source.fixture.candidateRevision,
    targetPlatform: 'ozon', targetStore: request.store, storeRef: structuredClone(request.storeRef),
    sourceCapture: { skuChoices: [{ sourceSkuId: request.supplierSkuId, attributes: { 颜色: 'black' } }] },
    siblingSourceV1: { parentCardBinding: { model: 'synthetic-model' } },
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } };
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: 'd-batch:service-test',
    storeRef: structuredClone(request.storeRef), status: 'authorized', externalRequestState: 'not_sent',
    excludedOfferIds: ['FIRST-EXCLUDED'], members: [{ candidateId: candidate.id,
      skuPackageId: request.skuPackageId, offerId: request.merchantSku,
      resultRevision: candidate.dataRevision, authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization), status: 'authorized', taskId: null,
      productId: null }] };
  const document = initialBusinessStateDocument({ now });
  document.candidates = [candidate];
  document.runtime.dProductionBatches = [batch];
  const repository = createMemoryBusinessStateRepository(document);
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:batch-service', version: 'v1',
    capabilities: ['ozon-production-execution'], observedAt: now });
  const capability = formalCapabilities(request.store, source.authorization.lockedScope.finalUploads, request);
  capability.warehouseId = request.inventoryWrite.warehouseId;
  capability.inspectedAt = now;
  capability.productImport = { status: 'verified', protocolVersion: 'ozon-product-import-v3',
    evidenceRef: 'evidence:synthetic:import-limit', endpoint: '/v3/product/import',
    statusEndpoint: '/v1/product/import/info', maxItemsPerRequest: 10,
    validUntil: '2026-09-01T00:00:00.000Z' };
  const inspection = ozonDEPreflightEvidenceFixture().record.inspection;
  const calls = [];
  const serviceOptions = { repository, runtimeMode: 'local_development',
    workerRegistry, serverClock: () => currentTime,
    services: new Map([[source.currentProductionBinding.bindingId,
      { worker: workerRegistry.get('worker:batch-service') }]]),
    loadCurrentProductionBinding: () => source.currentProductionBinding,
    loadBatchObservationPolicy: () => observationPolicy,
    loadBatchMemberEvidence: async () => ({ capabilities: structuredClone(capability),
      inspection: structuredClone(inspection), checkedAt: now }),
    requestJson: async requestJson => { calls.push(requestJson);
      return requestJson.write ? { result: { task_id: 9001 } } :
        { result: { items: [{ offer_id: request.merchantSku, product_id: 94001, status: 'imported', errors: [] }] } };
    } };
  const service = createDBatchImportSoftwareService(serviceOptions);
  return { repository, service, capability, calls, batch, candidateId: candidate.id,
    restartService: () => createDBatchImportSoftwareService(serviceOptions),
    advanceClock: value => { currentTime = value; workerRegistry.heartbeat({ workerId: 'worker:batch-service',
      version: 'v1', capabilities: ['ozon-production-execution'], status: 'online' }); } };
}

test('software service requires a current batch limit before admission and sends no request', async () => {
  const f = await fixture();
  delete f.capability.productImport.maxItemsPerRequest;
  await assert.rejects(f.service.runAuthorizedBatch({ batchId: f.batch.batchId }),
    /D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs, undefined);
});

test('software service starts one persisted import task and duplicate start cannot resend', async () => {
  const f = await fixture();
  const first = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(first.status, 'waiting_platform');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  delete f.capability.productImport.maxItemsPerRequest;
  const replay = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(replay.status, 'idempotent_replay');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].taskId, '9001');
});

test('software service records the offer observation without claiming inventory or E success', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  const observed = await f.service.observeBatchChunk({ batchId: f.batch.batchId, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.equal(observed.results[0].classification, 'imported');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dProductionBatches[0].members[0].status, 'imported_awaiting_inventory_and_e');
  const sku = saved.candidates.find(candidate => candidate.id === f.candidateId).lifecycleV11.skuPackage;
  assert.equal(sku.productionRecord, null);
  assert.equal(sku.eVerificationRecord, null);
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('an expired lease can be reclaimed without fresh import limit evidence', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const reclaimed = await f.service.reclaimBatchLease({ batchId: f.batch.batchId });
  assert.equal(reclaimed.status, 'waiting_platform');
  assert.equal(reclaimed.chunks[0].taskId, '9001');
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('restarted software pump recovers only a saved task and never resends its import', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const restarted = f.restartService();
  const result = await restarted.runDueBatchObservations();
  assert.equal(result.status, 'imported_awaiting_inventory');
  assert.deepEqual(f.calls.map(call => call.write), [true, false]);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].observationReads, 1);
});
