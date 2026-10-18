import { initialBusinessStateDocument } from '../../lib/business-state-repository.mjs';
import { fingerprintCanonicalRecord } from '../../lib/production-contract-primitives.mjs';
import { createProductionPlan } from '../../lib/production-plan.mjs';
import { projectProductionReadbackExpectation } from '../../lib/e-stage-readback.mjs';
import { createDBatchEJob, applyDBatchEJobEvent, createDBatchEReadback } from '../../lib/d-batch-offer-readback.mjs';
import { authorizedProductionFixture, localFinalAssets } from './c2-software-fixture.mjs';
import { exactObservation } from './d-software-fixture.mjs';

const NOW = '2026-08-22T08:00:00.000Z', READ_AT = '2026-08-22T08:00:01.000Z';
const clone = value => structuredClone(value);

export function createDBatchEFixture({ version = 3 } = {}) {
  const authorizationSource = authorizedProductionFixture({ assets: localFinalAssets(),
    storeRef: { stableStoreId: 'miska', platformStoreId: 'seller-miska-synthetic', mappingVersion: 'stores-v1' } });
  const pa = authorizationSource.productionAuthorization, scope = pa.lockedScope;
  const candidate = { id: authorizationSource.candidateId, dataRevision: authorizationSource.candidateRevision,
    targetPlatform: 'ozon', targetStore: 'miska', storeRef: clone(scope.storeRef), lifecycleV11: {
      skuPackage: clone(authorizationSource.skuPackage), c2UploadDraft: { schemaVersion: 'c2-upload-draft-v1',
        candidateId: authorizationSource.candidateId, skuPackageId: scope.skuPackageId, schemaEvidenceRef: scope.schemaEvidenceRef,
        uploads: scope.finalUploads.map(asset => ({ ...clone(asset), status: 'ready' })),
        selection: scope.finalUploads.map(asset => ({ assetId: asset.assetId, order: asset.order })) } } };
  const member = { candidateId: candidate.id, skuPackageId: scope.skuPackageId, offerId: scope.merchantSku,
    sourceRevision: pa.sourceCandidateRevision, resultRevision: candidate.dataRevision,
    authorizationId: pa.authorizationId, authorizationFingerprint: fingerprintCanonicalRecord(pa), status: 'authorized' };
  const batch = { schemaVersion: `d-batch-production-authorization-v${version}`, batchId: 'd-batch:synthetic:media-review',
    ownerActorId: pa.authorizedByActorId, confirmedAt: pa.authorizedAt, storeRef: clone(scope.storeRef),
    excludedOfferIds: ['HISTORICAL-KHAKI'], status: 'authorized', externalRequestState: 'not_sent', members: [member],
    postImportScope: { schemaVersion: `d-batch-post-import-scope-v${version === 3 ? 2 : 1}`,
      inventoryAction: 'write_authorized_stock', eReadbackOfferIds: [member.offerId], ...(version === 3 ? {
        inSaleList: { schemaVersion: 'ozon-in-sale-list-authorization-v1', decision: 'read_store_in_sale_list_for_batch',
          officialEvidenceRef: 'official:ozon-in-sale-list:20261018',
          policy: { pageSize: 1000, maxPages: 3, requestTimeoutMs: 30000, durationMs: 90000 } } } : {}) } };
  const plan = createProductionPlan(authorizationSource);
  const expectation = projectProductionReadbackExpectation({ finalUploads: scope.finalUploads.map(asset => ({ ...asset,
    platformAcceptedUrl: `https://assets.example.com/${asset.order}.png` })), warehouseId: pa.executionBinding.warehouseId });
  const record = { schemaVersion: 'd-batch-offer-record-v2', recordId: `d-batch-offer:${batch.batchId}:${member.offerId}`,
    batchId: batch.batchId, chunkIndex: 0, taskId: '9001', productId: '910001', candidateId: candidate.id,
    skuPackageId: scope.skuPackageId, offerId: scope.merchantSku, supplierSkuId: scope.supplierSkuId,
    authorizationId: pa.authorizationId, authorizationFingerprint: member.authorizationFingerprint,
    productionPlanId: plan.planId, productionPlanFingerprint: fingerprintCanonicalRecord(plan),
    importRequestReceiptRef: 'receipt:synthetic:import', importItemFingerprint: 'fingerprint:synthetic:item',
    importChunkFingerprint: 'fingerprint:synthetic:chunk', importContentFingerprint: 'fingerprint:synthetic:content',
    inventoryAction: 'write_authorized_stock', inventoryModified: true, inventoryReceiptRef: 'receipt:synthetic:stock',
    expectedStock: scope.stock, expectedPrice: clone(scope.platformWritePrice), readbackExpectation: clone(expectation),
    platform: 'ozon', store: 'miska', storeRef: clone(scope.storeRef), warehouseRef: scope.warehouseRef,
    credentialAlias: scope.credentialAlias, warehouseId: pa.executionBinding.warehouseId, createdAt: NOW,
    published: false, activated: false, advertisingOpened: false, status: 'created_stock_write_accepted' };
  const observation = exactObservation({ ...record, executionMode: 'single_sku_seller_api', merchantSku: record.offerId,
    expectedImageCount: 2 }, { mediaObservation: { sourceProtocol: 'ozon-product-info-v3',
      primaryImageUrl: 'https://ir.ozone.ru/s3/multimedia/test-main.jpg',
      images: ['https://ir.ozone.ru/s3/multimedia/test-detail.jpg'] }, moderationStatus: 'approved', validationStatus: 'success' });
  let job = createDBatchEJob({ record, workerId: 'worker:synthetic:e', workerVersion: 'v1', leaseId: 'lease:synthetic:e',
    leaseExpiresAt: '2026-08-22T08:01:00.000Z', leaseDurationMs: 60000, createdAt: NOW,
    observationPolicy: { schemaVersion: 'd-platform-observation-policy-v1', policyRef: 'policy:synthetic:e', version: 'v1',
      maxQueries: 3, intervalMs: 1000, expiresAt: '2026-08-22T09:00:00.000Z', requestTimeoutMs: 1000 } });
  job = applyDBatchEJobEvent({ job, event: { kind: 'read_started' }, workerId: job.workerId, leaseId: job.leaseId, observedAt: NOW });
  const readback = createDBatchEReadback({ record, observation, readAt: READ_AT });
  job = applyDBatchEJobEvent({ job, event: { kind: 'read_completed', resultId: readback.readbackId }, workerId: job.workerId, leaseId: job.leaseId, observedAt: READ_AT });
  const document = initialBusinessStateDocument({ now: NOW });
  document.candidates = [candidate]; document.runtime.dProductionBatches = [batch];
  document.runtime.dBatchOfferRecords = [record]; document.runtime.dBatchEJobs = [job]; document.runtime.dBatchEReadbacks = [readback];
  return { document, batchId: batch.batchId, candidateId: candidate.id, record, observation };
}
