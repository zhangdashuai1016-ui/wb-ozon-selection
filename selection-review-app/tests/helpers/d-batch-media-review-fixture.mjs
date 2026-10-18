import { createDBatchEFixture } from './d-batch-e-fixture.mjs';
import { createDBatchEReadback } from '../../lib/d-batch-offer-readback.mjs';
import { createInSaleListJob, beginInSaleListPage, markInSaleListPageSending, buildInSaleListPageQuery,
  normalizeInSaleListPage, applyInSaleListPageResult } from '../../lib/ozon-in-sale-list-observation.mjs';

const clone = value => structuredClone(value);
const observedAt = '2026-08-22T08:00:03.000Z';

/** Saved synthetic inputs exercise the complete result projection without sending a platform request. */
export function createDBatchMediaReviewFixture({ inSale = true, observation = {} } = {}) {
  const fixture = clone(createDBatchEFixture());
  const { document, record, batchId, candidateId } = fixture;
  const batch = document.runtime.dProductionBatches[0], member = batch.members[0];
  const authorization = document.candidates[0].lifecycleV11.skuPackage.productionAuthorization;
  fixture.observation = { ...fixture.observation, ...clone(observation) };
  const readback = createDBatchEReadback({ record, observation: fixture.observation,
    readAt: document.runtime.dBatchEReadbacks[0].readAt });
  document.runtime.dBatchEReadbacks = [clone(readback)];
  document.runtime.dBatchEJobs[0].resultId = readback.readbackId;
  // The E fixture starts after import. Supply its corresponding saved per-offer projection input.
  document.runtime.dBatchImportJobs = [{ batchId, chunks: [{ index: record.chunkIndex,
    offerIds: [record.offerId], taskId: record.taskId, status: 'completed',
    results: [{ offerId: record.offerId, classification: 'imported',
      importObservation: { productId: record.productId } }] }] }];
  const binding = { ...clone(authorization.executionBinding), platform: 'ozon', storeRef: clone(record.storeRef),
    storeName: '合成核图店铺', warehouseName: '合成核图仓库', warehouseRef: record.warehouseRef,
    credentialAlias: record.credentialAlias, verification: { evidenceRef: 'configuration-evidence:synthetic:media-review',
      checkedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' } };
  if (inSale) {
    const scope = { schemaVersion: 'ozon-in-sale-list-scope-v1', batchId,
      authorizationRef: `${batchId}:in-sale-list`, officialEvidenceRef: batch.postImportScope.inSaleList.officialEvidenceRef,
      accountEvidenceRef: 'receipt:synthetic:roles:list', storeRef: clone(record.storeRef), warehouseRef: record.warehouseRef,
      warehouseId: record.warehouseId, credentialAlias: record.credentialAlias,
      bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
      targets: [{ candidateId, skuPackageId: member.skuPackageId, sourceRevision: member.resultRevision,
        sourceRecordId: record.recordId, authorizationId: member.authorizationId,
        authorizationFingerprint: member.authorizationFingerprint, offerId: member.offerId, productId: record.productId }] };
    let job = createInSaleListJob({ scope, policy: clone(batch.postImportScope.inSaleList.policy),
      workerId: 'worker:synthetic:media-review', workerVersion: 'v1', leaseId: 'lease:synthetic:media-review',
      leaseExpiresAt: '2026-08-22T08:01:33.000Z', createdAt: observedAt });
    const holder = { workerId: job.workerId, leaseId: job.leaseId, at: observedAt };
    job = beginInSaleListPage({ job, ...holder });
    job = markInSaleListPageSending({ job, ...holder });
    const result = normalizeInSaleListPage({ query: buildInSaleListPageQuery(job), observedAt,
      response: { result: { items: [{ offer_id: record.offerId, product_id: Number(record.productId) }], last_id: '' } } });
    document.runtime.dBatchInSaleJobs = [applyInSaleListPageResult({ job, result, ...holder })];
  }
  return { ...fixture, binding };
}
