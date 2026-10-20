import { assertOzonAccountReadScope, assertOzonAccountReadReceipt, readOzonAccountReadTerminal,
  completedOzonAccountReadEvidenceExpiresAt, OzonAccountReadError } from './ozon-account-read-contract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const fail = () => { throw new OzonAccountReadError('REPOSITORY_INVALID'); };
function collection(document, key) {
  const runtime = Object.hasOwn(document, 'runtime') ? document.runtime : {};
  if (!object(runtime)) fail();
  if (!Object.hasOwn(runtime, key)) return [];
  if (!Array.isArray(runtime[key]) || runtime[key].some(value => !object(value))) fail();
  return runtime[key];
}

/** A transaction-local projection, not a new lock or persisted state. */
export function ozonAccountReadCoordinationState({ document, candidateIds }) {
  if (!Array.isArray(candidateIds) || candidateIds.some(id => !text(id)) || new Set(candidateIds).size !== candidateIds.length) fail();
  const ids = new Set(candidateIds);
  const jobs = collection(document, 'softwareJobs').filter(job => job.jobType === 'ozon_account_read' && ids.has(job.candidateId));
  if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) fail();
  return jobs.map(job => {
    const scope = assertOzonAccountReadScope(job.scopeBinding, job);
    if (!text(job.jobId) || !text(job.createdAt) || !Number.isFinite(Date.parse(job.createdAt)) || !['queued', 'claimed', 'waiting_platform', 'completed', 'failed', 'unknown_outcome'].includes(job.status) ||
        !['not_sent', 'in_flight', 'succeeded', 'failed', 'unknown_outcome'].includes(job.externalRequestState)) fail();
    return { jobId: job.jobId, candidateId: job.candidateId, revision: job.revision, createdAt: job.createdAt,
      status: job.status, externalRequestState: job.externalRequestState, scopeFingerprint: scope.inputFingerprint };
  }).sort((left, right) => left.jobId.localeCompare(right.jobId));
}

export function ozonAccountReadProductionBlocker(state) {
  if (state.some(job => job.status === 'unknown_outcome' || job.externalRequestState === 'unknown_outcome')) return 'unknown_outcome';
  if (state.some(job => ['queued', 'claimed', 'waiting_platform'].includes(job.status) || job.externalRequestState === 'in_flight')) return 'in_progress';
  return null;
}

function untouchedDJob(job) {
  return job.status === 'queued' && job.attempt === 0 && job.externalRequestState === 'not_sent' &&
    ['workerId', 'workerVersion', 'leaseId', 'leaseExpiresAt', 'externalRequestRef', 'resultRef', 'resultEnvelope',
      'startedAt', 'lastProgressAt', 'progressRef', 'completedAt', 'failureClass'].every(field => job[field] === null) &&
    Array.isArray(job.workerCapabilitiesSnapshot) && job.workerCapabilitiesSnapshot.length === 0 &&
    !Object.hasOwn(job, 'preparationEvidence');
}

/** Refresh is allowed only before any member of the production unit has begun D. */
export function ozonAccountReadRefreshProductionBusy({ document, candidateId }) {
  if (!Array.isArray(document.candidates) || !text(candidateId)) fail();
  const batches = collection(document, 'dProductionBatches');
  if (batches.some(batch => !text(batch.batchId) || !Array.isArray(batch.members) || batch.members.length === 0 ||
      batch.members.some(member => !object(member) || !text(member.candidateId)) ||
      new Set(batch.members.map(member => member.candidateId)).size !== batch.members.length)) fail();
  const matches = batches.filter(batch => batch.members.some(member => member.candidateId === candidateId));
  if (matches.length > 1) fail();
  const batch = matches[0];
  const ids = new Set(batch ? batch.members.map(member => member.candidateId) : [candidateId]);
  const candidates = document.candidates.filter(candidate => ids.has(candidate.id));
  if (candidates.length !== ids.size || new Set(candidates.map(candidate => candidate.id)).size !== ids.size) fail();
  let busy = false;
  for (const candidate of candidates) {
    const sku = candidate.lifecycleV11?.skuPackage;
    if (!object(sku)) fail();
    if (Object.hasOwn(sku, 'readbackHistory') && !Array.isArray(sku.readbackHistory)) fail();
    if (['dAssetTransport', 'dSoftwareExecution', 'productionRecord', 'externalListingRecord', 'eVerificationRecord']
      .some(field => sku[field] !== undefined && sku[field] !== null) || sku.readbackHistory?.length > 0) busy = true;
  }
  if (collection(document, 'softwareJobs').some(job => job.jobType === 'd_production_execution' &&
      ids.has(job.candidateId) && !untouchedDJob(job))) busy = true;
  for (const key of ['dBatchAssetTransports', 'dBatchImportJobs', 'dBatchStockJobs', 'dBatchOfferRecords', 'dBatchEJobs']) {
    const records = collection(document, key);
    if (batch && records.some(record => record.batchId === batch.batchId)) busy = true;
  }
  return busy || Boolean(batch && (batch.status !== 'authorized' || batch.externalRequestState !== 'not_sent'));
}

/** Recheck only the adopted source and time bound at D admission; preflight owns its complete proof. */
export function ozonAccountReadProductionEvidenceCurrent({ document, state, observedAt }) {
  if (!text(observedAt) || !Number.isFinite(Date.parse(observedAt))) throw new OzonAccountReadError('PRODUCTION_EVIDENCE_TIME_INVALID');
  if (state.length === 0) return true;
  const records = document.runtime.ozonDEPreflightEvidence, receipts = document.runtime.ozonAccountReadReceipts;
  if (!object(records) || !object(receipts)) throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_REQUIRED');
  const jobs = collection(document, 'softwareJobs');
  const currentTime = Date.parse(observedAt);
  let current = true;
  for (const candidateId of new Set(state.map(job => job.candidateId))) {
    const candidates = document.candidates.filter(candidate => candidate.id === candidateId);
    if (candidates.length !== 1) fail();
    const sku = candidates[0].lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
    if (!object(authorization)) throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_REQUIRED');
    const record = records[authorization.authorizationId];
    if (record === undefined) throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_REQUIRED');
    if (!object(record) || !object(record.scope) || !object(record.provenance) ||
        record.scope.authorizationId !== authorization.authorizationId || record.scope.candidateId !== candidateId ||
        record.scope.skuPackageId !== sku.skuPackageId || record.scope.supplierSkuId !== sku.supplierSkuId ||
        record.scope.sourceCandidateRevision !== authorization.sourceCandidateRevision) {
      throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_INVALID');
    }
    const jobId = record.provenance.softwareJobRef;
    const sourceJobs = jobs.filter(job => job.jobId === jobId);
    if (sourceJobs.length !== 1 || !state.some(job => job.jobId === jobId && job.candidateId === candidateId) ||
        sourceJobs[0].status !== 'completed' || sourceJobs[0].externalRequestState !== 'succeeded') {
      throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_INVALID');
    }
    const job = sourceJobs[0], receipt = assertOzonAccountReadReceipt(receipts[jobId], job);
    const terminal = readOzonAccountReadTerminal(receipt, job);
    if (terminal.status !== 'completed' || terminal.externalRequestState !== 'succeeded' ||
        receipt.scope.candidateId !== candidateId || receipt.scope.skuPackageId !== sku.skuPackageId ||
        receipt.scope.supplierSkuId !== sku.supplierSkuId || record.collectedAt !== receipt.steps.at(-1).result.observedAt ||
        record.expiresAt !== completedOzonAccountReadEvidenceExpiresAt(receipt)) {
      throw new OzonAccountReadError('PRODUCTION_EVIDENCE_SOURCE_INVALID');
    }
    if (currentTime < Date.parse(record.collectedAt) || currentTime >= Date.parse(record.expiresAt)) current = false;
  }
  return current;
}
