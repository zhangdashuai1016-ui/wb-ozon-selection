import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createDBatchAssetTransport, DBatchAssetTransportError, readDBatchAssetTransportProof,
  reconcileExpiredDBatchAssetTransport } from '../lib/d-batch-asset-transport.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { authorizedProductionFixture, localFinalAssets, finalAssets } from './helpers/c2-software-fixture.mjs';
import { currentProductionBindingFixture, capabilities } from './helpers/d-software-fixture.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const hash = body => createHash('sha256').update(body).digest('hex');
async function fixture({ count = 2, local = true, legacy = false } = {}) {
  const document = initialBusinessStateDocument({ now: NOW }), files = new Map(), events = [], uploads = [];
  for (let i = 0; i < count; i++) {
    const assets = (local ? localFinalAssets() : finalAssets()).map((asset, index) => {
      const body = Buffer.from(`synthetic batch ${i} image ${index}`);
      const sha256 = hash(body);
      const value = local ? { ...asset, sha256, byteSize: body.length, assetVersion: `sha256:${sha256}` } : asset;
      files.set(`candidate:batch-assets:${i}:${value.assetId}`, { body, contentType: 'image/png' });
      return value;
    });
    const source = authorizedProductionFixture({ candidateId: `candidate:batch-assets:${i}`,
      supplierSkuId: `SKU-${i}`, merchantSku: `MERCHANT-${i}`, assets });
    document.candidates.push({ id: source.candidateId, dataRevision: source.candidateRevision,
      targetPlatform: 'ozon', targetStore: 'dandanshu', storeRef: clone(source.productionAuthorization.lockedScope.storeRef),
      lifecycleV11: { skuPackage: clone(source.skuPackage), ...(local ? { c2UploadDraft: {
        schemaVersion: 'c2-upload-draft-v1', candidateId: source.candidateId, skuPackageId: source.skuPackage.skuPackageId,
        schemaEvidenceRef: source.productionAuthorization.lockedScope.schemaEvidenceRef,
        uploads: source.productionAuthorization.lockedScope.finalUploads.map(asset => ({ ...clone(asset), status: 'ready' })),
        selection: source.productionAuthorization.lockedScope.finalUploads.map(asset => ({ assetId: asset.assetId, order: asset.order }))
      } } : {}) } });
  }
  const first = document.candidates[0].lifecycleV11.skuPackage.productionAuthorization;
  const batch = { schemaVersion: `d-batch-production-authorization-v${legacy ? 1 : 2}`, batchId: 'd-batch:assets-test',
    ownerActorId: first.authorizedByActorId, confirmedAt: first.authorizedAt, storeRef: clone(first.lockedScope.storeRef),
    excludedOfferIds: ['EXCLUDED-KHAKI'], postImportScope: { schemaVersion: 'd-batch-post-import-scope-v1',
      inventoryAction: 'write_authorized_stock', eReadbackOfferIds: document.candidates.map((_, i) => `MERCHANT-${i}`) },
    status: 'authorized', externalRequestState: 'not_sent', members: document.candidates.map(candidate => {
      const sku = candidate.lifecycleV11.skuPackage, authorization = sku.productionAuthorization;
      return { candidateId: candidate.id, skuPackageId: sku.skuPackageId, offerId: authorization.lockedScope.merchantSku,
        resultRevision: candidate.dataRevision, authorizationId: authorization.authorizationId,
        authorizationFingerprint: fingerprintCanonicalRecord(authorization) };
    }) };
  document.runtime.dProductionBatches = [batch];
  const repository = createMemoryBusinessStateRepository(document);
  let currentTime = NOW;
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:assets-test', version: 'v1', capabilities: ['ozon-production-execution'], observedAt: NOW });
  const configuration = {
    repository, runtimeMode: 'local_development', workerRegistry, serverClock: () => currentTime, leaseDurationMs: 60_000,
    loadCurrentProductionBinding: ({ candidate }) => currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization),
    resolveLocalAsset: async (asset, { candidate }) => {
      events.push(`local:${candidate.id}:${asset.assetId}`);
      const file = files.get(`${candidate.id}:${asset.assetId}`);
      assert.ok(file);
      return file;
    },
    getBatchMemberEvidence: async ({ candidate }) => {
      events.push(`evidence:${candidate.id}`);
      const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
      const binding = currentProductionBindingFixture(authorization);
      return { checkedAt: currentTime, inspection: clone(ozonDEPreflightEvidenceFixture().record.inspection),
        capabilities: { ...capabilities('dandanshu', authorization.lockedScope.finalUploads, binding),
          warehouseId: binding.warehouseId, status: 'not_ready', gaps: [{ code: 'asset_transport_not_verified' }] } };
    },
    upload: async ({ candidateId, finalUploads, resolveLocalAsset, beforePublicWrite }) => {
      uploads.push(candidateId); events.push(`upload:${candidateId}`);
      for (const asset of finalUploads) {
        assert.ok(Buffer.isBuffer((await resolveLocalAsset(asset)).body));
        await beforePublicWrite({ assetId: asset.assetId, order: asset.order, sha256: asset.sha256 });
      }
      return assetReceipt(finalUploads);
    }
  };
  const input = { batchId: batch.batchId, workerId: 'worker:assets-test' };
  return { repository, batch, files, events, uploads, input, configuration,
    runtime: createDBatchAssetTransport(configuration),
    restart: overrides => createDBatchAssetTransport({ ...configuration, ...overrides }),
    advance: value => { currentTime = value; } };
}
const clone = value => structuredClone(value);
const assetReceipt = assets => ({ status: 'verified', mode: 'preapproved_stable_https',
  protocolVersion: 'aliyun-oss-final-assets-v1', approvedHosts: ['assets.example.invalid'],
  resolvedAssets: assets.map(asset => ({ assetId: asset.assetId, order: asset.order, sha256: asset.sha256,
    platformAcceptedUrl: `https://assets.example.invalid/${encodeURIComponent(asset.assetId)}.png`,
    stable: true, authorizationStatus: 'approved', evidenceRef: `oss:${asset.assetId}` })), evidenceRef: 'oss:synthetic:batch-assets' });

async function interruptedFixture(writeCount) {
  const source = await fixture({ count: 1 });
  let snapshot;
  await source.restart({ upload: async ({ finalUploads, beforePublicWrite }) => {
    for (const { assetId, order, sha256 } of finalUploads.slice(0, writeCount))
      await beforePublicWrite({ assetId, order, sha256 });
    snapshot = await source.repository.readSnapshot();
    throw new Error('SYNTHETIC_PROCESS_INTERRUPTION');
  } }).run(source.input);
  const repository = createMemoryBusinessStateRepository(snapshot);
  return { ...source, repository, snapshot,
    recover: () => reconcileExpiredDBatchAssetTransport({ repository, serverClock: source.configuration.serverClock }) };
}

async function delayedReceiptFixture({ writesBeforePause = 2 } = {}) {
  const f = await fixture({ count: 1 });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let puts = 0;
  const runtime = f.restart({ upload: async ({ finalUploads, beforePublicWrite }) => {
    for (const { assetId, order, sha256 } of finalUploads) {
      if (puts === writesBeforePause) { entered(); await gate; }
      await beforePublicWrite({ assetId, order, sha256 });
      puts++;
    }
    if (puts === writesBeforePause) { entered(); await gate; }
    return assetReceipt(finalUploads);
  } });
  const running = runtime.run(f.input);
  await ready;
  return { ...f, running, release, puts: () => puts,
    recover: () => reconcileExpiredDBatchAssetTransport({ repository: f.repository, serverClock: f.configuration.serverClock }) };
}

test('expired batch asset intents settle locally once and never infer a successful upload', async () => {
  for (const writeCount of [0, 1, 2]) {
    const f = await interruptedFixture(writeCount), before = await f.repository.readSnapshot();
    f.advance('2026-08-22T12:00:59.999Z');
    assert.equal((await f.recover()).status, 'idle');
    assert.deepEqual(await f.repository.readSnapshot(), before);
    f.advance('2026-08-22T12:01:00.000Z');
    const outcomes = await Promise.all([f.recover(), f.recover()]);
    const status = writeCount === 0 ? 'failed' : 'unknown_outcome';
    assert.deepEqual(outcomes.map(value => value.status).sort(), ['idle', status].sort());
    const saved = await f.repository.readSnapshot(), record = saved.runtime.dBatchAssetTransports[0];
    assert.equal(record.status, status);
    assert.equal(record.revision, before.runtime.dBatchAssetTransports[0].revision + 1);
    assert.equal(record.state.intent.ossWrites, writeCount === 0 ? 0 : 'unknown');
    assert.equal(record.state.intent.externalRequestState, writeCount === 0 ? 'not_attempted' : undefined);
    assert.equal(record.state.continuationBlocked, true);
    assert.equal(record.state.automaticRetry, false);
    assert.equal(record.state.intent.retryAllowed, false);
    assert.deepEqual(saved.candidates, before.candidates);
    assert.deepEqual(saved.runtime.dProductionBatches, before.runtime.dProductionBatches);
    assert.equal(saved.runtime.dBatchImportJobs, undefined);
    const view = projectDBatchExecutionView(saved, f.batch.batchId);
    assert.equal(view.members[0].assetStatus, status);
    assert.equal(view.members[0].assetReason, record.state.intent.failureCode);
    assert.equal(view.assetRequestTransmission, writeCount === 0 ? 'not_attempted' : 'attempted_or_unknown');
    assert.equal(view.members[0].importStatus, 'not_started');
    assert.equal(view.members[0].eStatus, 'not_started');
    assert.equal(view.members[0].listedVerified, false);
    assert.equal((await f.recover()).status, 'idle');
    assert.deepEqual(await f.repository.readSnapshot(), saved);
    let uploads = 0;
    const cold = f.restart({ repository: f.repository, upload: async () => { uploads++; throw new Error('UNEXPECTED_UPLOAD'); } });
    assert.equal((await cold.run(f.input)).status, status);
    assert.equal(uploads, 0);
    assert.equal(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), null);
  }
});

test('expiry recovery uses its frozen source after current candidate revision changes and rejects corrupted intents', async () => {
  const f = await interruptedFixture(1);
  await f.repository.transact(document => { document.candidates[0].dataRevision++;
    return { changed: true, document, result: null }; });
  const before = await f.repository.readSnapshot();
  f.advance('2026-08-22T12:02:00.000Z');
  assert.equal((await f.recover()).status, 'unknown_outcome');
  assert.deepEqual((await f.repository.readSnapshot()).candidates, before.candidates);
  assert.equal(projectDBatchExecutionView(await f.repository.readSnapshot(), f.batch.batchId).members[0].assetStatus, 'unknown_outcome');
  for (const corruption of ['scopeRevision', 'intentStatus', 'intentId', 'writeOrder', 'nestedState', 'extraMarker']) {
    const damaged = await interruptedFixture(1);
    await damaged.repository.transact(document => {
      const record = document.runtime.dBatchAssetTransports[0];
      if (corruption === 'scopeRevision') record.scope.sourceRevision++;
      if (corruption === 'intentStatus') record.state.intent.status = 'completed';
      if (corruption === 'intentId') record.state.intent.intentId = 'oss-asset-intent:wrong';
      if (corruption === 'writeOrder') record.writeIntents[0].order = 2;
      if (corruption === 'nestedState') record.state.executionRevision = 2;
      if (corruption === 'extraMarker') record.leaseExpiryResolution = { schemaVersion: 'd-batch-asset-lease-expiry-v1' };
      return { changed: true, document, result: null };
    });
    const invalid = await damaged.repository.readSnapshot();
    damaged.advance('2026-08-22T12:02:00.000Z');
    await assert.rejects(damaged.recover(), /FROZEN_RECORD_INVALID|RECORD_SCOPE_CHANGED|OSS_D_INTENT_NOT_PERSISTED|OSS_D_INTENT_FROZEN_SOURCE_INVALID/);
    assert.deepEqual(await damaged.repository.readSnapshot(), invalid);
  }
});

test('an original complete late receipt settles a matching expiry resolution without any new upload', async () => {
  const f = await delayedReceiptFixture();
  f.advance('2026-08-22T12:02:00.000Z');
  assert.equal((await f.recover()).status, 'unknown_outcome');
  assert.equal(f.puts(), 2);
  f.release();
  assert.equal((await f.running).status, 'verified');
  const saved = await f.repository.readSnapshot(), record = saved.runtime.dBatchAssetTransports[0];
  assert.equal(record.status, 'verified');
  assert.equal(record.state.continuationBlocked, false);
  assert.equal(record.leaseExpiryResolution.schemaVersion, 'd-batch-asset-lease-expiry-v1');
  assert.equal(record.revision, 5);
  assert.equal(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
    candidateId: saved.candidates[0].id }).assetTransport.resolvedAssets.length, 2);
  assert.equal((await f.recover()).status, 'idle');
  assert.equal(f.puts(), 2);
});

test('expiry settlement grants no remaining send and does not upgrade an unsent terminal result', async () => {
  for (const writesBeforePause of [0, 1]) {
    const f = await delayedReceiptFixture({ writesBeforePause });
    f.advance('2026-08-22T12:02:00.000Z');
    assert.equal((await f.recover()).status, writesBeforePause === 0 ? 'failed' : 'unknown_outcome');
    const failure = assert.rejects(f.running, error => writesBeforePause === 0
      ? error instanceof AggregateError && error.message === 'D_BATCH_ASSET_SETTLEMENT_FAILED' &&
        error.errors.length === 2 && error.errors[0].code === 'D_BATCH_ASSET_RECORD_SCOPE_CHANGED' &&
        error.errors[1].code === 'D_BATCH_ASSET_SETTLEMENT_CONFLICT'
      : error instanceof DBatchAssetTransportError && error.code === 'D_BATCH_ASSET_RECORD_SCOPE_CHANGED');
    f.release();
    await failure;
    const record = (await f.repository.readSnapshot()).runtime.dBatchAssetTransports[0];
    assert.equal(record.status, writesBeforePause === 0 ? 'failed' : 'unknown_outcome');
    assert.equal(f.puts(), writesBeforePause);
  }
});

test('late receipts cannot use changed holders, mutated expiry proofs or real terminal failures', async () => {
  for (const change of ['lease', 'worker', 'version', 'scope', 'intent', 'marker', 'terminalFailure']) {
    const f = await delayedReceiptFixture();
    f.advance('2026-08-22T12:02:00.000Z');
    await f.recover();
    await f.repository.transact(document => {
      const record = document.runtime.dBatchAssetTransports[0];
      if (change === 'lease') record.leaseId = 'lease:replacement';
      if (change === 'worker') record.workerId = 'worker:replacement';
      if (change === 'version') record.workerVersion = 'v2';
      if (change === 'scope') record.scope.sourceRevision++;
      if (change === 'intent') record.state.intent.finalUploadAssetIds.reverse();
      if (change === 'marker') record.leaseExpiryResolution.sourceRecordRevision++;
      if (change === 'terminalFailure') {
        record.state.intent.failureCode = 'OSS_D_BATCH_UPLOAD_UNKNOWN';
        delete record.leaseExpiryResolution;
      }
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    const failure = assert.rejects(f.running, /D_BATCH_ASSET_SETTLEMENT_CONFLICT/);
    f.release();
    await failure;
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(f.puts(), 2);
  }
});

test('late receipt evidence survives current source changes but cannot continue against a new source', async () => {
  for (const change of ['revision', 'authorization']) {
    const f = await delayedReceiptFixture();
    f.advance('2026-08-22T12:02:00.000Z');
    await f.recover();
    await f.repository.transact(document => {
      const candidate = document.candidates[0];
      if (change === 'revision') candidate.dataRevision++;
      else candidate.lifecycleV11.skuPackage.productionAuthorization = clone(authorizedProductionFixture({
        candidateId: candidate.id, supplierSkuId: 'SKU-0', merchantSku: 'MERCHANT-REPLACED',
        assets: candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads }).productionAuthorization);
      return { changed: true, document, result: null };
    });
    const before = await f.repository.readSnapshot();
    f.release();
    assert.equal((await f.running).status, 'blocked');
    const saved = await f.repository.readSnapshot(), record = saved.runtime.dBatchAssetTransports[0];
    assert.equal(record.status, 'verified');
    assert.equal(record.state.continuationBlocked, true);
    assert.equal(record.state.assetTransport.resolvedAssets.length, 2);
    assert.deepEqual(saved.candidates, before.candidates);
    assert.throws(() => readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), /D_BATCH_ASSET_MEMBER_CHANGED/);
    assert.equal(f.puts(), 2);
  }
});

test('a stale recovery snapshot cannot replace a receipt that settled first', async () => {
  const f = await delayedReceiptFixture();
  const snapshot = await f.repository.readSnapshot();
  f.advance('2026-08-22T12:02:00.000Z');
  f.release();
  assert.equal((await f.running).status, 'verified');
  const before = await f.repository.readSnapshot();
  assert.equal((await reconcileExpiredDBatchAssetTransport({ repository: f.repository, snapshot,
    serverClock: f.configuration.serverClock })).status, 'idle');
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('expired asset recovery survives JSON reopen and performs no transaction when idle', async t => {
  const f = await interruptedFixture(1);
  const root = await mkdtemp(path.join(os.tmpdir(), 'batch-asset-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'business.json');
  const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: f.snapshot });
  await repository.transact(document => ({ changed: true, document, result: null }));
  f.advance('2026-08-22T12:02:00.000Z');
  const reopened = createJsonBusinessStateRepository({ filePath });
  assert.equal((await reconcileExpiredDBatchAssetTransport({ repository: reopened,
    serverClock: f.configuration.serverClock })).status, 'unknown_outcome');
  const saved = await reopened.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports[0].revision, 3);
  assert.deepEqual(saved.candidates, f.snapshot.candidates);
  assert.deepEqual(saved.runtime.dProductionBatches, f.snapshot.runtime.dProductionBatches);
  const afterRecovery = createJsonBusinessStateRepository({ filePath });
  assert.deepEqual(await afterRecovery.readSnapshot(), saved);
  assert.equal((await reconcileExpiredDBatchAssetTransport({ repository: afterRecovery,
    serverClock: f.configuration.serverClock })).status, 'idle');
  const idle = { ...afterRecovery, transact: async () => { throw new Error('UNEXPECTED_IDLE_TRANSACTION'); } };
  assert.equal((await reconcileExpiredDBatchAssetTransport({ repository: idle,
    snapshot: saved, serverClock: f.configuration.serverClock })).status, 'idle');
});

test('batch assets reuse OSS intent and receipt rules without changing candidate revisions or production authorizations', async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  const result = await f.runtime.run(f.input);
  assert.equal(result.status, 'verified');
  assert.equal(f.uploads.length, 2);
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.candidates, before.candidates);
  assert.deepEqual(saved.runtime.dProductionBatches, before.runtime.dProductionBatches);
  assert.deepEqual(saved.runtime.softwareJobs, before.runtime.softwareJobs);
  assert.equal(saved.runtime.dBatchAssetTransports.length, 2);
  assert.equal(saved.runtime.dBatchAssetTransports.every(record => record.writeIntents.length === 2), true);
  const firstEvidence = f.events.findIndex(value => value.startsWith('evidence:'));
  assert.equal(f.events.slice(0, firstEvidence).filter(value => value.startsWith('local:')).length, 4);
  for (const candidate of saved.candidates) {
    const proof = readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId, candidateId: candidate.id });
    assert.equal(proof.schemaVersion, 'd-batch-asset-proof-v1');
    assert.equal(proof.sourceRevision, candidate.dataRevision);
    assert.equal(proof.assetTransport.resolvedAssets.length, 2);
    assert.equal(candidate.lifecycleV11.skuPackage.dAssetTransport, undefined);
  }
  assert.equal((await f.restart().run(f.input)).status, 'verified');
  assert.equal(f.uploads.length, 2);
});

test('legacy and current stable HTTPS batches retain their original zero-upload path with missing transport dependencies', async () => {
  for (const legacy of [false, true]) {
    const f = await fixture({ local: false, legacy }), before = await f.repository.readSnapshot();
    assert.equal((await f.restart({ upload: null, resolveLocalAsset: null }).run(f.input)).status, 'verified');
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.equal(f.events.length, 0);
  }
  const old = await fixture({ legacy: true });
  assert.equal((await old.runtime.run(old.input)).reasonCode, 'D_BATCH_ASSET_LEGACY_SCOPE_NOT_SUPPORTED');
  assert.equal(old.events.length, 0);
});

test('asset leases use an explicit existing DE configuration and accept its controlled thirty minute upper bound', async () => {
  const f = await fixture({ count: 1 });
  assert.throws(() => f.restart({ leaseDurationMs: undefined }), /DEPENDENCY_INVALID/);
  assert.throws(() => f.restart({ leaseDurationMs: 1_800_001 }), /DEPENDENCY_INVALID/);
  assert.equal((await f.restart({ leaseDurationMs: 1_800_000 }).run(f.input)).status, 'verified');
  const record = (await f.repository.readSnapshot()).runtime.dBatchAssetTransports[0];
  assert.equal(record.leaseExpiresAt, '2026-08-22T12:30:00.000Z');
});

test('one missing or corrupted local file blocks the entire batch before account evidence or upload', async () => {
  const f = await fixture();
  [...f.files.values()].at(-1).body = Buffer.from('changed');
  const result = await f.runtime.run(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'OSS_LOCAL_ASSET_INVALID');
  assert.equal(f.events.some(value => value.startsWith('evidence:')), false);
  assert.equal(f.uploads.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports, undefined);
});

test('a missing local registration cannot be replaced by an injected readable file', async () => {
  const f = await fixture({ count: 1 });
  await f.repository.transact(document => {
    delete document.candidates[0].lifecycleV11.c2UploadDraft;
    return { changed: true, document, result: null };
  });
  const result = await f.runtime.run(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'OSS_LOCAL_ASSET_INVALID');
  assert.equal(f.events.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('an existing local registration with contradictory identity or selection retains its original error', async () => {
  for (const corruption of ['identity', 'selection']) {
    const f = await fixture({ count: 1 });
    await f.repository.transact(document => {
      const draft = document.candidates[0].lifecycleV11.c2UploadDraft;
      if (corruption === 'identity') draft.candidateId = 'candidate:other';
      else draft.selection[0].assetId = 'asset:not-registered';
      return { changed: true, document, result: null };
    });
    const code = corruption === 'identity' ? 'c2_final_registration_mismatch' : 'c2_upload_selection_invalid';
    await assert.rejects(f.runtime.run(f.input), error => error.constructor === Error && error.extra?.code === code);
    assert.equal(f.events.length, 0);
    assert.equal(f.uploads.length, 0);
    assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports, undefined);
  }
});

test('all current account and protocol gaps are checked before any OSS intent or upload', async () => {
  const f = await fixture();
  const runtime = f.restart({ getBatchMemberEvidence: async input => {
    const evidence = await f.configuration.getBatchMemberEvidence(input);
    if (input.candidate.id.endsWith(':1')) evidence.capabilities.gaps.push({ code: 'account_evidence_missing' });
    return evidence;
  } });
  const outcome = await runtime.run(f.input);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_READY');
  assert.equal(f.uploads.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports, undefined);
  assert.equal((await f.restart({ upload: null }).run(f.input)).reasonCode, 'D_BATCH_ASSET_TRANSPORT_NOT_CONFIGURED');
});

test('corrupt asset stores first observed after preflight propagate without being replaced by an empty store', async () => {
  for (const corrupt of [null, {}]) {
    const f = await fixture({ count: 1 }), before = await f.repository.readSnapshot();
    const runtime = f.restart({ getBatchMemberEvidence: async input => {
      const evidence = await f.configuration.getBatchMemberEvidence(input);
      await f.repository.transact(document => {
        document.runtime.dBatchAssetTransports = clone(corrupt);
        return { changed: true, document, result: null };
      });
      return evidence;
    } });
    await assert.rejects(runtime.run(f.input), error =>
      error instanceof DBatchAssetTransportError && error.code === 'D_BATCH_ASSET_STORE_INVALID');
    const saved = await f.repository.readSnapshot();
    assert.deepEqual(saved.runtime.dBatchAssetTransports, corrupt);
    assert.deepEqual(saved.candidates, before.candidates);
    assert.deepEqual(saved.runtime.dProductionBatches, before.runtime.dProductionBatches);
    assert.equal(f.uploads.length, 0);
  }
});

test('duplicate and mismatched persisted asset records introduced after preflight remain explicit errors', async () => {
  for (const corruption of ['duplicate', 'scope']) {
    const f = await fixture({ count: 1 });
    assert.equal((await f.runtime.run(f.input)).status, 'verified');
    const verified = (await f.repository.readSnapshot()).runtime.dBatchAssetTransports[0];
    const corruptRecords = [clone(verified)];
    if (corruption === 'duplicate') corruptRecords.push(clone(verified));
    else corruptRecords[0].scope.authorizationFingerprint = 'changed-authorization-fingerprint';
    await f.repository.transact(document => {
      document.runtime.dBatchAssetTransports = [];
      return { changed: true, document, result: null };
    });
    const runtime = f.restart({ getBatchMemberEvidence: async input => {
      const evidence = await f.configuration.getBatchMemberEvidence(input);
      await f.repository.transact(document => {
        document.runtime.dBatchAssetTransports = clone(corruptRecords);
        return { changed: true, document, result: null };
      });
      return evidence;
    } });
    const code = corruption === 'duplicate' ? 'D_BATCH_ASSET_RECORD_NOT_UNIQUE' : 'D_BATCH_ASSET_RECORD_SCOPE_CHANGED';
    await assert.rejects(runtime.run(f.input), error => error instanceof DBatchAssetTransportError && error.code === code);
    const saved = await f.repository.readSnapshot();
    assert.deepEqual(saved.runtime.dBatchAssetTransports, corruptRecords);
    assert.throws(() => readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), error => error.code === code);
    assert.equal(f.uploads.length, 1);
  }
});

test('missing configuration blocks but corrupt configuration and programming failures propagate unchanged', async () => {
  const f = await fixture({ count: 1 });
  const missing = await f.restart({ loadCurrentProductionBinding: () => null }).run(f.input);
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reasonCode, 'PRODUCTION_EXECUTION_BINDING_REQUIRED');
  await assert.rejects(f.restart({ loadCurrentProductionBinding: () => ({}) }).run(f.input), /PRODUCTION_BINDINGS_INVALID/);
  const failure = new TypeError('PRODUCTION_EXECUTION_BINDING_REQUIRED');
  await assert.rejects(f.restart({ loadCurrentProductionBinding: () => { throw failure; } }).run(f.input), error => error === failure);
  assert.equal(f.uploads.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports, undefined);
});

test('malformed account evidence and contradictory account identity cannot be reported as ordinary missing permission', async () => {
  for (const corruption of ['shape', 'identity']) {
    const f = await fixture({ count: 1 });
    const runtime = f.restart({ getBatchMemberEvidence: async input => {
      const evidence = await f.configuration.getBatchMemberEvidence(input);
      if (corruption === 'shape') evidence.capabilities.gaps = null;
      else evidence.capabilities.credentialAlias = 'credential:other-account';
      return evidence;
    } });
    const code = corruption === 'shape' ? 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_INVALID' : 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_SCOPE_MISMATCH';
    await assert.rejects(runtime.run(f.input), error => error instanceof DBatchAssetTransportError && error.code === code);
    assert.equal(f.uploads.length, 0);
    assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports, undefined);
  }
});

test('concurrent calls and a second runtime never upload the same member twice', async () => {
  const f = await fixture({ count: 1 });
  let open, entered;
  const gate = new Promise(resolve => { open = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const runtime = f.restart({ upload: async input => { entered(); await gate; return f.configuration.upload(input); } });
  const first = runtime.run(f.input), second = runtime.run(f.input);
  await ready;
  assert.equal((await f.restart().run(f.input)).status, 'in_flight');
  open();
  assert.equal((await first).status, 'verified');
  assert.equal((await second).status, 'verified');
  assert.equal(f.uploads.length, 1);
});

test('transmitted failure remains unknown and neither later runs nor a cold runtime upload again', async () => {
  const f = await fixture();
  let calls = 0;
  const runtime = f.restart({ upload: async ({ finalUploads, beforePublicWrite }) => {
    calls++;
    const { assetId, order, sha256 } = finalUploads[0];
    await beforePublicWrite({ assetId, order, sha256 });
    throw new Error('OSS_PUBLIC_READBACK_FAILED: synthetic response lost');
  } });
  assert.equal((await runtime.run(f.input)).status, 'unknown_outcome');
  assert.equal((await f.restart().run(f.input)).status, 'unknown_outcome');
  assert.equal(calls, 1);
  assert.equal(f.uploads.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports.length, 1);
});

test('verified earlier members are not uploaded again when a later member fails', async () => {
  const f = await fixture();
  const runtime = f.restart({ upload: async input => {
    if (input.candidateId.endsWith(':0')) return f.configuration.upload(input);
    const { assetId, order, sha256 } = input.finalUploads[0];
    await input.beforePublicWrite({ assetId, order, sha256 });
    throw new Error('OSS_PUBLIC_READBACK_FAILED');
  } });
  assert.equal((await runtime.run(f.input)).status, 'unknown_outcome');
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchAssetTransports.map(value => value.status), ['verified', 'unknown_outcome']);
  assert.equal((await f.restart().run(f.input)).status, 'unknown_outcome');
  assert.equal(f.uploads.length, 1);
});

test('a late receipt settles the original holder after expiry without granting another upload', async () => {
  const f = await fixture({ count: 1 });
  const runtime = f.restart({ upload: async input => {
    const result = await f.configuration.upload(input);
    f.advance('2026-08-22T12:02:00.000Z');
    return result;
  } });
  assert.equal((await runtime.run(f.input)).status, 'verified');
  assert.equal((await f.restart().run(f.input)).status, 'verified');
  assert.equal(f.uploads.length, 1);
});

test('changed source or replaced holder cannot publish a verified proof', async () => {
  for (const change of ['revision', 'holder']) {
    const f = await fixture({ count: 1 });
    const runtime = f.restart({ upload: async input => {
      const result = await f.configuration.upload(input);
      await f.repository.transact(document => {
        if (change === 'revision') document.candidates[0].dataRevision++;
        else document.runtime.dBatchAssetTransports[0].leaseId = 'lease:replacement';
        return { changed: true, document, result: null };
      });
      return result;
    } });
    if (change === 'revision') assert.equal((await runtime.run(f.input)).status, 'blocked');
    else await assert.rejects(runtime.run(f.input), error =>
      error instanceof DBatchAssetTransportError && error.code === 'D_BATCH_ASSET_SETTLEMENT_CONFLICT');
    const saved = await f.repository.readSnapshot();
    if (change === 'revision') assert.throws(() => readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), /D_BATCH_ASSET_MEMBER_CHANGED/);
    else assert.equal(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), null);
    assert.equal(f.uploads.length, 1);
  }
});

test('unexpected upload programming failures are saved and propagate without a success fallback', async () => {
  const f = await fixture({ count: 1 }), failure = new TypeError('synthetic uploader defect');
  await assert.rejects(f.restart({ upload: async () => { throw failure; } }).run(f.input), error => error === failure);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchAssetTransports[0].status, 'failed');
  assert.equal((await f.restart().run(f.input)).status, 'failed');
});

test('non-business typed gate errors retain durable failed or unknown state and propagate the same error', async () => {
  for (const writesBeforeError of [0, 1]) {
    const f = await fixture({ count: 1 });
    const failure = new DBatchAssetTransportError('RECORD_SCOPE_CHANGED');
    let evidenceChecks = 0, puts = 0;
    const runtime = f.restart({
      getBatchMemberEvidence: async input => {
        evidenceChecks++;
        if (evidenceChecks === writesBeforeError + 2) throw failure;
        return f.configuration.getBatchMemberEvidence(input);
      },
      upload: async ({ finalUploads, beforePublicWrite }) => {
        for (const { assetId, order, sha256 } of finalUploads) {
          await beforePublicWrite({ assetId, order, sha256 });
          puts++;
        }
        return assetReceipt(finalUploads);
      }
    });
    await assert.rejects(runtime.run(f.input), error => error === failure);
    const saved = await f.repository.readSnapshot(), record = saved.runtime.dBatchAssetTransports[0];
    const status = writesBeforeError === 0 ? 'failed' : 'unknown_outcome';
    assert.equal(record.status, status);
    assert.equal(record.state.status, status);
    assert.equal(record.writeIntents.length, writesBeforeError);
    assert.equal(puts, writesBeforeError);
    assert.equal(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
      candidateId: saved.candidates[0].id }), null);
    assert.equal((await f.restart().run(f.input)).status, status);
    assert.equal(f.uploads.length, 0);
  }
});

test('expired lease and changed account permission between intent and first put stop with zero public writes', async () => {
  for (const changed of ['lease', 'account']) {
    const f = await fixture({ count: 1 });
    let deny = false, puts = 0;
    const runtime = f.restart({
      getBatchMemberEvidence: async input => {
        const evidence = await f.configuration.getBatchMemberEvidence(input);
        if (deny) evidence.capabilities.gaps.push({ code: 'account_evidence_not_current' });
        return evidence;
      },
      upload: async ({ finalUploads, beforePublicWrite }) => {
        if (changed === 'lease') f.advance('2026-08-22T12:02:00.000Z');
        else deny = true;
        const { assetId, order, sha256 } = finalUploads[0];
        await beforePublicWrite({ assetId, order, sha256 });
        puts++;
        return assetReceipt(finalUploads);
      }
    });
    const result = await runtime.run(f.input);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasonCode, changed === 'lease' ? 'D_BATCH_ASSET_SEND_GUARD_BLOCKED' : 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_READY');
    const saved = await f.repository.readSnapshot();
    assert.equal(saved.runtime.dBatchAssetTransports[0].status, 'failed');
    assert.equal(saved.runtime.dBatchAssetTransports[0].writeIntents.length, 0);
    assert.equal(puts, 0);
    assert.equal((await f.restart().run(f.input)).status, 'failed');
  }
});

test('a malformed returned stable URL receipt is retained as unknown and is never a usable asset proof', async () => {
  const f = await fixture({ count: 1 });
  const runtime = f.restart({ upload: async input => {
    const result = await f.configuration.upload(input);
    result.resolvedAssets[0].platformAcceptedUrl = 'http://127.0.0.1:4317/secret';
    return result;
  } });
  await assert.rejects(runtime.run(f.input), /OSS_D_RECEIPT_INVALID/);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports[0].status, 'unknown_outcome');
  assert.equal(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId,
    candidateId: saved.candidates[0].id }), null);
  assert.equal((await f.restart().run(f.input)).status, 'unknown_outcome');
  assert.equal(f.uploads.length, 1);
});

test('independent batch asset proof survives an actual JSON save and reopen without rewriting candidate state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'batch-assets-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'synthetic.json'), f = await fixture({ count: 1 });
  const before = await f.repository.readSnapshot();
  const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: before });
  assert.equal((await f.restart({ repository }).run(f.input)).status, 'verified');
  const reopened = createJsonBusinessStateRepository({ filePath });
  const saved = await reopened.readSnapshot();
  assert.deepEqual(saved.candidates, before.candidates);
  assert.ok(readDBatchAssetTransportProof({ document: saved, batchId: f.batch.batchId, candidateId: saved.candidates[0].id }));
  assert.equal((await f.restart({ repository: reopened }).run(f.input)).status, 'verified');
  assert.equal(f.uploads.length, 1);
});
