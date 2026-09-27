import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedFixture, capabilities as formalCapabilities } from './helpers/d-software-fixture.mjs';
import { finalAssets as syntheticFinalAssets } from './helpers/c2-software-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { createPersistedDBatchImportRuntime } from '../lib/d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

const at = '2026-08-22T07:25:00.000Z';
const binding = { warehouseRef: 'warehouse:synthetic:dandanshu', credentialAlias: 'credential-alias:synthetic:dandanshu' };

async function fixture({ failReceipt = false, createAdapterFailures = 0, observationItems = null, count = 2 } = {}) {
  let currentTime = at;
  const colors = count === 2 ? ['white', 'black'] : ['black', 'navy', 'khaki'];
  const sources = [];
  for (let index = 0; index < count; index++) {
    const color = colors[index % colors.length];
    const name = count === 2 ? ['A', 'B'][index] : String(index + 2).padStart(2, '0');
    const assets = index === 0 && count === 2 ? undefined : syntheticFinalAssets().map((asset, assetIndex) => ({ ...asset,
      assetId: `${asset.assetId}:${name}`,
      assetRef: assetIndex === 0 ? `https://assets.example.com/${color}-main.jpg` : asset.assetRef,
      sha256: assetIndex === 0 ? ({ white: 'a', black: 'c', navy: 'e', khaki: 'f' })[color].repeat(64) : asset.sha256 }));
    sources.push(await preparedFixture({ candidateId: `candidate:batch-${name.toLowerCase()}`,
      supplierSkuId: `SHELF-${name}`, merchantSku: `BATCH-${name}`, assets, ...binding }));
  }
  const members = sources.map((source, index) => ({ request: source.prepared.executableRequest,
    executionContext: source.executionContext, platformWritePreflight: source.preflight,
    colorKey: colors[index % colors.length],
    modelKey: 'same-product', sourceTechnicalStatus: 'not_started' }));
  const capability = formalCapabilities('dandanshu', members.flatMap(member => member.request.finalUploads), members[0].request);
  capability.warehouseId = '70001';
  capability.assetTransport.resolvedAssets = members.flatMap(member => member.request.finalUploads.map(asset => ({
    assetId: asset.assetId, platformAcceptedUrl: asset.platformAcceptedUrl, sha256: asset.sha256,
    order: asset.order, authorizationStatus: 'approved', stable: true, evidenceRef: `evidence:asset:${asset.assetId}` })));
  capability.productImport.endpoint = '/v3/product/import';
  capability.productImport.maxItemsPerRequest = count === 2 ? 2 : 10;
  capability.productImport.validUntil = '2026-09-01T00:00:00.000Z';
  const document = initialBusinessStateDocument({ now: at });
  document.candidates = sources.map((source, index) => ({ id: source.fixture.candidateId,
    dataRevision: source.fixture.candidateRevision, targetPlatform: 'ozon', targetStore: 'dandanshu',
    storeRef: structuredClone(members[index].request.storeRef),
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } }));
  document.runtime.dProductionBatches = [{ schemaVersion: 'd-batch-production-authorization-v1',
    batchId: 'd-batch:synthetic', status: 'authorized', externalRequestState: 'not_sent',
    storeRef: structuredClone(members[0].request.storeRef),
    excludedOfferIds: ['BATCH-FIRST'], members: sources.map((source, index) => ({
      candidateId: source.fixture.candidateId, skuPackageId: source.fixture.skuPackage.skuPackageId,
      offerId: members[index].request.merchantSku, resultRevision: source.fixture.candidateRevision,
      authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization),
      status: 'authorized', taskId: null, productId: null })) }];
  const baseRepository = createMemoryBusinessStateRepository(document);
  let rejectReceipt = failReceipt;
  const repository = failReceipt ? { ...baseRepository, transact: mutator => baseRepository.transact(async saved => {
    const outcome = await mutator(saved);
    if (rejectReceipt && saved.runtime.dBatchImportJobs?.some(job => job.chunks.some(chunk => chunk.status === 'waiting_platform'))) {
      rejectReceipt = false;
      throw new Error('synthetic receipt persistence failure');
    }
    return outcome;
  }) } : baseRepository;
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:batch-synthetic', version: 'v1',
    capabilities: ['ozon-production-execution'], observedAt: at });
  const calls = [];
  let remainingAdapterFailures = createAdapterFailures;
  let readCount = 0;
  const runtime = createPersistedDBatchImportRuntime({ repository, workerRegistry, serverClock: () => currentTime,
    leaseDurationMs: 60_000,
    verifyCurrentBatchEvidence: async () => {
      const saved = await repository.readSnapshot();
      assert.equal(saved.runtime.dProductionBatches[0].members.length, members.length);
    },
    createAdapter: async () => {
      if (remainingAdapterFailures > 0) { remainingAdapterFailures--; throw new Error('synthetic adapter startup failure'); }
      return createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capability,
      requestJson: async request => {
        calls.push(request);
        if (request.write) return { result: { task_id: 500 + calls.filter(call => call.write).length } };
        const items = observationItems?.[readCount++] ?? [
          { offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] },
          { offer_id: 'BATCH-B', product_id: 0, status: 'failed', errors: [] }
        ];
        return { result: { items } };
      } });
    } });
  return { repository, runtime, members, capability, calls, workerRegistry,
    setTime: value => { currentTime = value; } };
}

test('persisted batch intent sends once, then one task read settles each offer independently', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const result = await runtime.run(input);
  assert.equal(result.status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'partial_failure');
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'platform_failed']);
  assert.equal(saved.candidates.some(candidate => candidate.lifecycleV11.skuPackage.productionRecord), false);
  assert.deepEqual(calls.map(call => call.write), [true, false]);
});

test('adapter startup failure can resume only a never-sent chunk', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ createAdapterFailures: 1 });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await assert.rejects(() => runtime.run(input), /synthetic adapter startup failure/);
  assert.equal((await repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status, 'not_sent');
  assert.equal((await runtime.run(input)).status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('current single-SKU preflight must still pass for every batch member before admission', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const before = await repository.readSnapshot();
  const changed = members.map(member => ({ ...member }));
  changed[1].platformWritePreflight = structuredClone(changed[1].platformWritePreflight);
  changed[1].platformWritePreflight.permission.status = 'denied';
  await assert.rejects(() => runtime.run({ batchId: 'd-batch:synthetic', members: changed,
    adapterCapabilities: capability, workerId: 'worker:batch-synthetic' }), /MEMBER_NOT_READY/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(calls.length, 0);
});

test('a failed receipt checkpoint leaves the sent intent unknown and forbids replay', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ failReceipt: true });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  assert.equal((await runtime.run(input)).status, 'unknown_outcome');
  const job = (await repository.readSnapshot()).runtime.dBatchImportJobs[0];
  assert.equal(job.chunks[0].status, 'intent');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('unknown task observation is read-only reconcilable after lease expiry', async () => {
  const incomplete = [{ offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] }];
  const complete = [...incomplete, { offer_id: 'BATCH-B', product_id: 910002, status: 'imported', errors: [] }];
  const { repository, runtime, members, capability, calls, workerRegistry, setTime } = await fixture({
    observationItems: [incomplete, complete] });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await runtime.run(input);
  assert.equal((await runtime.observe({ ...input, chunkIndex: 0 })).status, 'unknown_outcome');
  setTime('2026-08-22T07:26:01.000Z');
  workerRegistry.heartbeat({ workerId: input.workerId, version: 'v1', capabilities: ['ozon-production-execution'] });
  await assert.rejects(() => runtime.observe({ ...input, chunkIndex: 0 }), /NOT_ADMITTED/);
  await runtime.reclaim({ batchId: input.batchId, workerId: input.workerId });
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.deepEqual((await repository.readSnapshot()).runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'imported_awaiting_inventory_and_e']);
  assert.deepEqual(calls.map(call => call.write), [true, false, false]);
});

test('31 authorized members send four persisted tasks within the synthetic limit', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ count: 31 });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const outcome = await runtime.run(input);
  assert.equal(outcome.status, 'waiting_platform');
  assert.deepEqual(calls.filter(call => call.write).map(call => call.body.items.length), [10, 10, 10, 1]);
  const saved = await repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks.every(chunk => chunk.status === 'waiting_platform'), true);
  assert.equal(new Set(saved.runtime.dBatchImportJobs[0].chunks.map(chunk => chunk.taskId)).size, 4);
  assert.equal(calls.some(call => call.body.items?.some(item => item.offer_id === 'BATCH-FIRST')), false);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 4);
});
