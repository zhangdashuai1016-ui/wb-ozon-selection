import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ADiscoveryError, assertADiscoveryBatch, assertADiscoveryBatchSource, assertADiscoveryReceipt,
  assertADiscoveryAuthorization, assertADiscoveryCredential, readADiscoveryMarketResult } from './a-discovery-contract.mjs';
import { assertCompletedADiscoveryJobResult, isADiscoverySoftwareJob } from './software-job-contract.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { assertSafeBusinessMutationCandidate } from './runtime-identity.mjs';
import { createInitialCandidate } from './candidate-initialization.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValue = (condition, code) => { if (!condition) throw new ADiscoveryError(code); };
export function assertADiscoveryCandidateImportRecord(record, {batchId, revision}) {
  const fields = ['schemaVersion','batchId','revision','recordedAt','status','candidateId','marketProductId','sourceJobIds','failureClass'];
  requireValue(object(record) && Object.keys(record).length === fields.length && fields.every(field=>Object.hasOwn(record,field)) &&
    record.schemaVersion === 'a-discovery-candidate-import-v1' && record.batchId === batchId && isCanonicalFrozenRef(batchId) &&
    record.revision === revision && Number.isSafeInteger(revision) && revision >= 0 && typeof record.recordedAt === 'string' &&
    Number.isFinite(Date.parse(record.recordedAt)) && ['imported','all_duplicates','blocked','failed'].includes(record.status) &&
    Array.isArray(record.sourceJobIds) && record.sourceJobIds.length <= 3 && record.sourceJobIds.every(isCanonicalFrozenRef) &&
    new Set(record.sourceJobIds).size === record.sourceJobIds.length, 'IMPORT_RECORD_INVALID');
  if (record.status === 'imported') {
    requireValue(isCanonicalFrozenRef(record.candidateId) && typeof record.marketProductId === 'string' &&
      /^[1-9][0-9]*$/.test(record.marketProductId) && record.sourceJobIds.length > 0 && record.failureClass === null, 'IMPORT_RECORD_INVALID');
  } else {
    requireValue(record.candidateId === null && record.marketProductId === null, 'IMPORT_RECORD_INVALID');
    requireValue(record.status === 'all_duplicates' ? record.sourceJobIds.length > 0 && record.failureClass === null :
      isCanonicalFrozenRef(record.failureClass), 'IMPORT_RECORD_INVALID');
  }
  return structuredClone(record);
}
function imports(document) {
  if (!Object.hasOwn(document.runtime, 'aDiscoveryCandidateImports')) document.runtime.aDiscoveryCandidateImports = {};
  requireValue(object(document.runtime.aDiscoveryCandidateImports), 'IMPORT_REPOSITORY_INVALID');
  return document.runtime.aDiscoveryCandidateImports;
}

/** Provider search evidence enters A as unverified material, never as a supply or profit decision. */
export function readCompletedADiscoveryBatch({ document, batchId, revision }) {
  const batch = assertADiscoveryBatch(document.runtime.aDiscoveryBatches?.[batchId]);
  requireValue(batch.revision === revision, 'BATCH_CHANGED');
  requireValue(Array.isArray(document.runtime.softwareJobs) && object(document.runtime.aDiscoveryReceipts) &&
    Array.isArray(document.runtime.softwareJobAuthorizationRecords) && Array.isArray(document.runtime.softwareJobCredentialBindings), 'IMPORT_SOURCE_INVALID');
  const jobs = document.runtime.softwareJobs.filter(job => isADiscoverySoftwareJob(job) && job.subject.batchId === batchId && job.revision === revision)
    .sort((left, right) => left.scopeBinding.requestIndex - right.scopeBinding.requestIndex);
  requireValue(jobs.length === batch.plan.requests.length, 'IMPORT_SOURCE_INCOMPLETE');
  const receipts = jobs.map((job, index) => {
    const receipt = assertADiscoveryReceipt(document.runtime.aDiscoveryReceipts[job.jobId], job);
    assertADiscoveryBatchSource(batch, receipt.scope);
    requireValue(receipt.scope.requestIndex === index && receipt.status === 'completed' && job.status === 'completed' &&
      job.externalRequestState === 'succeeded' && readADiscoveryMarketResult(receipt).status === 'candidates_found' &&
      job.ownerUserId === batch.ownerUserId && job.requestedByUserId === batch.ownerUserId, 'IMPORT_SOURCE_INCOMPLETE');
    assertCompletedADiscoveryJobResult({job,receipt});
    const permits = document.runtime.softwareJobAuthorizationRecords.filter(value => value.authorizationId === receipt.scope.authorizationRef);
    const credentials = document.runtime.softwareJobCredentialBindings.filter(value => value.sideEffectScope === job.jobType &&
      value.scopeBinding?.authorizationRef === receipt.scope.authorizationRef);
    requireValue(permits.length === 1 && credentials.length === 1, 'IMPORT_PERMISSION_CONFLICT');
    const permit = assertADiscoveryAuthorization(permits[0]), credential = assertADiscoveryCredential(credentials[0]);
    requireValue(isDeepStrictEqual(permit.scopeBinding, receipt.scope) && isDeepStrictEqual(credential.scopeBinding, receipt.scope) &&
      permit.authorizedByUserId === batch.ownerUserId && permit.useCount === 1 && permit.consumedByJobId === job.jobId &&
      credential.allowedWorkerIds.includes(job.workerId) && Date.parse(permit.authorizedAt) <= Date.parse(receipt.startedAt) &&
      Date.parse(credential.boundAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt) < Date.parse(permit.expiresAt) &&
      Date.parse(receipt.completedAt) < Date.parse(credential.expiresAt), 'IMPORT_PERMISSION_CONFLICT');
    return receipt;
  });
  return { batch, jobs, receipts };
}

function existingMarketIds(candidates) {
  const result = new Set();
  for (const candidate of candidates) {
    if (candidate.aDiscoveryEvidenceV1?.marketProductId) result.add(candidate.aDiscoveryEvidenceV1.marketProductId);
    if (candidate.aDiscoveryEvidenceV2?.platform === 'ozon' && candidate.aDiscoveryEvidenceV2.marketProductId) result.add(candidate.aDiscoveryEvidenceV2.marketProductId);
    for (const value of [candidate.productUrl, candidate.competitorUrl]) {
      if (typeof value !== 'string' || !/^https?:\/\/(?:www\.)?ozon\.ru\//i.test(value)) continue;
      // Historical malformed or non-product links carry no exact numeric product identity.
      const match = value.match(/^https?:\/\/(?:www\.)?ozon\.ru\/product\/(?:[^/?#]*-)?([1-9][0-9]*)\/?(?:[?#].*)?$/i);
      if (match) result.add(match[1]);
    }
  }
  return result;
}

export function createADiscoveryCandidateImportUseCase({ repository, serverClock, storeBindings }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function' || !Array.isArray(storeBindings)) throw new TypeError('A_DISCOVERY_IMPORT_DEPENDENCY_INVALID');
  return Object.freeze({ async importBatch({ batchId, revision }) {
    if (!isCanonicalFrozenRef(batchId) || !Number.isSafeInteger(revision) || revision < 0) throw new ADiscoveryError('IMPORT_INPUT_INVALID');
    const key = `${batchId}:${revision}`, at = serverClock();
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new TypeError('A_DISCOVERY_IMPORT_CLOCK_INVALID');
    const base = {schemaVersion:'a-discovery-candidate-import-v1',batchId,revision,recordedAt:at,status:'failed',
      candidateId:null,marketProductId:null,sourceJobIds:[],failureClass:null};
    let originalError, hasOriginalError = false;
    const result = await repository.transact(document => {
      const saved = imports(document)[key];
      if (saved !== undefined) {
        return {changed:false,result:assertADiscoveryCandidateImportRecord(saved,{batchId,revision})};
      }
      let imported;
      try {
        const {batch,jobs,receipts} = readCompletedADiscoveryBatch({document,batchId,revision});
        requireValue(Array.isArray(document.candidates), 'IMPORT_REPOSITORY_INVALID');
        const known = existingMarketIds(document.candidates);
        const product = readADiscoveryMarketResult(receipts[0]).products.find(value => !known.has(value.productId));
        imported = {...base,status:product ? 'imported' : 'all_duplicates',sourceJobIds:jobs.map(job=>job.jobId)};
        if (product) {
          const id = `candidate:${randomUUID()}`;
          requireValue(isCanonicalFrozenRef(id) && !document.candidates.some(value=>value.id===id), 'IMPORT_CANDIDATE_CONFLICT');
          const candidate = createInitialCandidate({input:{targetStore:batch.targetStore,productName:product.title,productUrl:product.productUrl,
            // The provider's main image is display-only evidence for the owner's supplier search; it is not a listing asset.
            imageUrl:typeof product.imageUrl==='string'?product.imageUrl:''},
            source:'software',id,timestamp:at,storeBindings});
          candidate.targetPlatform = 'ozon';
          const seerfar = batch.plan.provider === 'seerfar';
          const evidence = {schemaVersion:seerfar?'a-discovery-candidate-evidence-v2':'a-discovery-candidate-evidence-v1',
            ...(seerfar?{provider:'seerfar',platform:'ozon',contractVersion:batch.plan.contractVersion}:{}),batchId,sourceRevision:revision,
            resultRevision:candidate.dataRevision,planId:batch.plan.planId,planVersion:batch.plan.version,marketProductId:product.productId,
            marketReceiptRef:receipts[0].receiptId,supplierReceiptRefs:receipts.slice(1).map(receipt=>receipt.receiptId),
            observedMarketPrice:{value:product.price,currency:product.currency},exactSkuMatch:'unknown',businessEffect:'discovery_evidence_only'};
          if(seerfar)candidate.aDiscoveryEvidenceV2=evidence;
          else candidate.aDiscoveryEvidenceV1=evidence;
          candidate.history.push({id:`history:${randomUUID()}`,actor:'software',action:'discovery_imported',detail:'按已批准发现计划保存待核验商品，尚未确认供货方案或正式利润。',at});
          assertSafeBusinessMutationCandidate(candidate);
          imported.candidateId = id; imported.marketProductId = product.productId;
          document.candidates.unshift(candidate);
        }
      } catch (error) {
        imported = {...base,status:error instanceof ADiscoveryError ? 'blocked' : 'failed',
          failureClass:error instanceof ADiscoveryError ? error.code : 'UNEXPECTED_SYSTEM_ERROR'};
        if (!(error instanceof ADiscoveryError)) { originalError = error; hasOriginalError = true; }
      }
      imports(document)[key] = assertADiscoveryCandidateImportRecord(imported,{batchId,revision});
      return {changed:true,document,result:structuredClone(imported)};
    });
    if (hasOriginalError) throw originalError;
    return result;
  } });
}
