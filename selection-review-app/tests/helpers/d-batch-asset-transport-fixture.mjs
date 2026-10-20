import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createDBatchAssetTransport } from '../../lib/d-batch-asset-transport.mjs';
import { fingerprintCanonicalRecord } from '../../lib/production-contract-primitives.mjs';
import { authorizedProductionFixture, localFinalAssets, finalAssets } from './c2-software-fixture.mjs';
import { currentProductionBindingFixture, capabilities } from './d-software-fixture.mjs';
import { ozonDEPreflightEvidenceFixture } from '../fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { accountReadConcurrencyFixture } from './account-read-concurrency-fixture.mjs';
import { createOzonDEPreflightProvider } from '../../lib/ozon-de-preflight-provider.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../../lib/ozon-de-preflight-evidence-reader.mjs';
import { loadOzonDEProtocolCatalog } from '../../lib/ozon-de-protocol-catalog.mjs';
import { OZON_DE_READBACK_ENDPOINTS } from '../../lib/ozon-seller-api-de-adapter.mjs';

export const BATCH_ASSET_AT = '2026-08-22T12:00:00.000Z';
const hash = body => createHash('sha256').update(body).digest('hex');
export async function createDBatchAssetTransportFixture({ count = 2, local = true, legacy = false } = {}) {
  const document = initialBusinessStateDocument({ now: BATCH_ASSET_AT }), files = new Map(), events = [], uploads = [];
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
        sourceRevision: authorization.sourceCandidateRevision, resultRevision: candidate.dataRevision, authorizationId: authorization.authorizationId,
        authorizationFingerprint: fingerprintCanonicalRecord(authorization) };
    }) };
  document.runtime.dProductionBatches = [batch];
  const repository = createMemoryBusinessStateRepository(document);
  let currentTime = BATCH_ASSET_AT;
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:assets-test', version: 'v1', capabilities: ['ozon-production-execution'], observedAt: BATCH_ASSET_AT });
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
      return syntheticBatchAssetReceipt(finalUploads);
    }
  };
  const input = { batchId: batch.batchId, workerId: 'worker:assets-test' };
  return { repository, batch, files, events, uploads, input, configuration,
    runtime: createDBatchAssetTransport(configuration),
    restart: overrides => createDBatchAssetTransport({ ...configuration, ...overrides }),
    advance: value => { currentTime = value; } };
}
const clone = value => structuredClone(value);
export const syntheticBatchAssetReceipt = assets => ({ status: 'verified', mode: 'preapproved_stable_https',
  protocolVersion: 'aliyun-oss-final-assets-v1', approvedHosts: ['assets.example.invalid'],
  resolvedAssets: assets.map(asset => ({ assetId: asset.assetId, order: asset.order, sha256: asset.sha256,
    platformAcceptedUrl: `https://assets.example.invalid/${encodeURIComponent(asset.assetId)}.png`,
    stable: true, authorizationStatus: 'approved', evidenceRef: `oss:${asset.assetId}` })), evidenceRef: 'oss:synthetic:batch-assets' });

export async function createRealAccountAssetTransportFixture({ count = 1, expiresFirst = null, adjustResponses = () => {} } = {}) {
  const f = await createDBatchAssetTransportFixture({ count }), catalog = await loadOzonDEProtocolCatalog();
  const expiry = new Date(Date.parse(BATCH_ASSET_AT) + 1000).toISOString();
  const accounts = [], completed = [], providers = new Map(), evidenceRead = [], syntheticPuts = [];
  for (const [index, candidate] of (await f.repository.readSnapshot()).candidates.entries()) {
    const account = await accountReadConcurrencyFixture({ repository: f.repository, clock: f.configuration.serverClock,
      candidateId: candidate.id, productionBinding: currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization),
      protocolCatalog: catalog });
    account.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', '/v1/product/import/info',
      '/v2/products/stocks', ...Object.values(OZON_DE_READBACK_ENDPOINTS)];
    if (expiresFirst === 'roles') account.responses['/v1/roles'].expires_at = expiry;
    adjustResponses(account.responses, index);
    const read = await account.run(expiresFirst === 'grant' ? { expiresAt: expiry } : {});
    assert.equal(read.status, 'completed');
    await account.publish(read);
    accounts.push(account); completed.push(read);
    providers.set(candidate.id, createOzonDEPreflightProvider({ serverClock: f.configuration.serverClock,
      readEvidence: createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: f.repository,
        verifySourceReceipt: account.evidenceSource.verifySourceReceipt }) }));
  }
  const realEvidence = async input => {
    assert.ok(providers.has(input.candidate.id));
    const evidence = await providers.get(input.candidate.id).loadBatchMemberEvidence(input);
    evidenceRead.push({ candidateId: input.candidate.id, evidence: clone(evidence) });
    return evidence;
  };
  const upload = input => f.configuration.upload({ ...input, beforePublicWrite: async asset => {
    await input.beforePublicWrite(asset);
    syntheticPuts.push({ candidateId: input.candidateId, ...clone(asset), observedAt: f.configuration.serverClock() });
  } });
  return { ...f, accounts, completed, providers, evidenceRead, syntheticPuts, expiry, realEvidence,
    restartReal: overrides => f.restart({ getBatchMemberEvidence: realEvidence, upload, ...overrides }) };
}
