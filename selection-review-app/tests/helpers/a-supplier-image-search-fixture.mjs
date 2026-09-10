import fs from 'node:fs/promises';
import { collectRealOzonSalesSnapshot } from '../../lib/sales-snapshot.mjs';
import os from 'node:os';
import path from 'node:path';
import { createJsonBusinessStateRepository, initialBusinessStateDocument } from '../../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore, createASupplierImageSearchJobForScope } from '../../lib/software-job-repository.mjs';

export const imageSearchAt = '2026-09-09T04:00:00.000Z';

// Synthetic protocol evidence only; no real browser, account, or platform request.
export function createASupplierImageSearchFixture() {
  const owner = { userId: 'owner:synthetic-image-search', actorType: 'human', source: 'authenticated_identity_provider', roles: ['owner'] };
  const candidate = { id: 'candidate:synthetic-image-search', dataRevision: 0, workflowStatus: 'needs_user_data',
    targetPlatform: 'ozon', targetStore: 'miska', eliminatedAt: null,
    salesSnapshotsV11: [collectRealOzonSalesSnapshot({ sourceMode: 'real_ozon_page_observation', technicalStatus: 'completed',
      snapshotId: 'snapshot:synthetic-image', marketScope: 'ozon_general_market', sellerIdentitySignals: [],
      sellerIdentityEvidenceRef: 'evidence:synthetic-seller-unknown', productUrl: 'https://www.ozon.ru/product/123456789/',
      title: 'Synthetic image-search item', imageRefs: ['https://images.example.com/synthetic.jpg'], currentPrice: 2000,
      currency: 'RUB', categoryPath: 'Дом и сад', attributes: {},
      evidenceRef: 'evidence:synthetic-market', collectedAt: imageSearchAt })] };
  const scope = { schemaVersion: 'a-supplier-image-search-scope-v1', candidateId: candidate.id, sourceRevision: 0, resultRevision: 0,
    targetPlatform: 'ozon', targetStore: 'miska', imageSource: { kind: 'sales_snapshot', snapshotId: 'snapshot:synthetic-image',
      imageIndex: 0, imageRef: 'image:snapshot:synthetic-image:0', sourceEvidenceRef: 'evidence:synthetic-market' },
    request: { requestId: 'request:synthetic-image-search', method: 'image_search', maxSearches: 1, maxResults: 4 },
    bindingId: 'binding:synthetic-image-browser', configurationVersion: 'version:synthetic-1', credentialAlias: 'synthetic-browser-alias',
    authorizationRef: 'permit:synthetic-image-search', expiresAt: '2026-09-09T04:00:10.000Z' };
  const worker = { workerId: 'worker:synthetic-image-search', version: 'version:synthetic-1',
    capabilities: ['1688-image-search-browser'], observedAt: imageSearchAt };
  const authorization = { schemaVersion: 'software-job-authorization-record-v3', authorizationId: scope.authorizationRef,
    authorizationType: 'a_supplier_image_search_once', status: 'active', action: 'a_supplier_image_search', scopeBinding: structuredClone(scope),
    authorizedByUserId: owner.userId, authorizedAt: imageSearchAt, expiresAt: scope.expiresAt, maxUses: 1, useCount: 0,
    consumedByJobId: null, consumedAt: null };
  const credential = { schemaVersion: 'software-job-credential-binding-v3', bindingId: scope.bindingId,
    credentialAlias: scope.credentialAlias, status: 'active', provider: '1688_browser', sideEffectScope: 'a_supplier_image_search',
    scopeBinding: structuredClone(scope), allowedWorkerIds: [worker.workerId], redaction: 'credential_alias_only',
    boundAt: imageSearchAt, expiresAt: scope.expiresAt };
  return { owner, candidate, scope, worker, authorization, credential };
}

export function createASupplierImageSearchReceipt({ scope, job, at = imageSearchAt }, { empty = false, inFlight = false } = {}) {
  const result = { schemaVersion: 'a-supplier-image-search-result-v1', provider: '1688_browser', requestId: scope.request.requestId,
    imageRef: scope.imageSource.imageRef, observedAt: at, status: empty ? 'true_empty' : 'candidates_found',
    submissionEvidenceRef: 'evidence:synthetic-image-submitted', completionEvidenceRef: 'evidence:synthetic-search-completed',
    products: empty ? [] : [{ offerId: '876240928352', sourceUrl: 'https://detail.1688.com/offer/876240928352.html',
      evidenceRef: 'evidence:synthetic-search-hit', sameSku: 'unknown', minimumOrderQuantity: null }] };
  return { schemaVersion: 'a-supplier-image-search-receipt-v1', receiptId: `a-supplier-image-search-receipt:${job.jobId}`,
    jobId: job.jobId, scope: structuredClone(scope), workerId: job.workerId, leaseId: job.leaseId, startedAt: at,
    completedAt: inFlight ? null : at, status: inFlight ? 'in_flight' : 'completed', failureClass: null,
    steps: [{ method: 'image_search', intentAt: at, sentAt: inFlight ? null : at, completedAt: inFlight ? null : at,
      externalRequestState: inFlight ? 'not_sent' : 'succeeded', requestTransmission: inFlight ? 'not_attempted' : 'response_received',
      result: inFlight ? null : result, errorCode: null }] };
}

export async function createASupplierImageSearchStoreFixture(t) {
  const f = createASupplierImageSearchFixture();
  let timestamp = Date.parse(imageSearchAt);
  const clock = () => new Date(timestamp).toISOString();
  const advance = ms => { timestamp += ms; };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'supplier-image-search-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const document = initialBusinessStateDocument({ now: clock() });
  document.candidates = [structuredClone(f.candidate)];
  Object.assign(document.runtime, { softwareJobs: [], softwareJobAuthorizationRecords: [f.authorization],
    softwareJobCredentialBindings: [f.credential], aSupplierImageSearchReceipts: {} });
  await fs.writeFile(filePath, JSON.stringify(document));
  const coldRepository = () => createJsonBusinessStateRepository({ filePath });
  const repository = coldRepository();
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock });
  const worker = workerRegistry.register(f.worker);
  const makeStore = repository => createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, workerRegistry, serverClock: clock });
  const store = makeStore(repository);
  const job = createASupplierImageSearchJobForScope({ scope: f.scope, ownerUserId: f.owner.userId, createdAt: clock() });
  return { ...f, worker, repository, filePath, coldRepository, clock, advance, workerRegistry, makeStore, store, job };
}
