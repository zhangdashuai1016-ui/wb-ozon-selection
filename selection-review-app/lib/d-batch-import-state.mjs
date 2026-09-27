import { isDeepStrictEqual } from 'node:util';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

export const D_BATCH_IMPORT_JOB_VERSION = 'd-batch-import-job-v1';
const validRef = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => validRef(value) && !Number.isNaN(Date.parse(value));
const clone = value => structuredClone(value);
const chunkStatuses = new Set(['not_sent', 'intent', 'waiting_platform', 'observed_pending',
  'observed_imported', 'platform_failed', 'platform_skipped', 'unknown_outcome']);

function assertJob(job) {
  if (job?.schemaVersion !== D_BATCH_IMPORT_JOB_VERSION || !validRef(job.jobId) || !validRef(job.batchId) ||
      !Number.isSafeInteger(job.revision) || job.revision < 1 || !validRef(job.workerId) || !validRef(job.workerVersion) ||
      !validRef(job.leaseId) || !validTime(job.leaseExpiresAt) || !Array.isArray(job.chunks) ||
      job.chunks.length === 0 || job.chunks.some((chunk, index) => chunk.index !== index ||
        !Array.isArray(chunk.offerIds) || chunk.offerIds.length === 0 ||
        !validRef(chunk.limitEvidenceRef) || !chunkStatuses.has(chunk.status) ||
        chunk.offerIds.some(offerId => !validRef(offerId)) || new Set(chunk.offerIds).size !== chunk.offerIds.length ||
        (['not_sent', 'intent'].includes(chunk.status) && (chunk.taskId !== null || chunk.results !== null)) ||
        (['waiting_platform', 'observed_pending', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(chunk.status) &&
          (!/^[1-9][0-9]*$/.test(chunk.taskId) || !Number.isSafeInteger(Number(chunk.taskId)))) ||
        (chunk.status === 'waiting_platform' && chunk.results !== null) ||
        (['observed_pending', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(chunk.status) &&
          (!Array.isArray(chunk.results) ||
            !isDeepStrictEqual(chunk.results.map(result => result.offerId), chunk.offerIds))) ||
        (chunk.status === 'unknown_outcome' && chunk.taskId !== null &&
          (!/^[1-9][0-9]*$/.test(chunk.taskId) || !Number.isSafeInteger(Number(chunk.taskId))))) ||
      new Set(job.chunks.flatMap(chunk => chunk.offerIds)).size !== job.chunks.flatMap(chunk => chunk.offerIds).length ||
      job.status !== statusFor(job.chunks)) {
    throw new Error('D_BATCH_IMPORT_JOB_INVALID');
  }
  assertSafeRuntimeRecord(job, 'dBatchImportJob');
  return job;
}

function statusFor(chunks) {
  if (chunks.some(chunk => chunk.status === 'unknown_outcome' || chunk.status === 'intent')) return 'unknown_outcome';
  if (chunks.some(chunk => chunk.status === 'platform_failed' || chunk.status === 'platform_skipped')) return 'partial_failure';
  if (chunks.every(chunk => chunk.status === 'observed_imported')) return 'imported_awaiting_inventory';
  if (chunks.some(chunk => chunk.status === 'waiting_platform' || chunk.status === 'observed_pending')) return 'waiting_platform';
  return 'claimed';
}

/** Persisted batch import state. Every chunk belongs to one task and every offer has one terminal observation. */
export function createDBatchImportJob({ batch, chunks, workerId, workerVersion, leaseId, leaseExpiresAt, createdAt }) {
  if (batch?.status !== 'authorized' || batch.externalRequestState !== 'not_sent' ||
      !validRef(batch.batchId) || !Array.isArray(batch.members) || !Array.isArray(chunks) ||
      !Array.isArray(batch.excludedOfferIds) ||
      chunks.length === 0 || !validRef(workerId) || !validRef(workerVersion) || !validRef(leaseId) ||
      !validTime(createdAt) || !validTime(leaseExpiresAt) || Date.parse(leaseExpiresAt) <= Date.parse(createdAt)) {
    throw new Error('D_BATCH_IMPORT_ADMISSION_INVALID');
  }
  const expected = batch.members.map(member => member.offerId);
  const actual = chunks.flatMap(chunk => chunk.offerIds);
  if (!isDeepStrictEqual(actual, expected) || actual.some(offerId => batch.excludedOfferIds.includes(offerId))) {
    throw new Error('D_BATCH_IMPORT_MEMBER_SCOPE_MISMATCH');
  }
  const job = { schemaVersion: D_BATCH_IMPORT_JOB_VERSION, jobId: `d-batch-import:${batch.batchId}`,
    batchId: batch.batchId, revision: 1, workerId, workerVersion, leaseId, leaseExpiresAt, status: 'claimed',
    createdAt, updatedAt: createdAt, chunks: chunks.map((chunk, index) => ({ index,
      offerIds: [...chunk.offerIds], limitEvidenceRef: chunk.limitEvidenceRef,
      status: 'not_sent', taskId: null, results: null })) };
  return Object.freeze(assertJob(job));
}

/** Apply one durable checkpoint. An intent without a task receipt can only be reconciled, never sent again. */
export function applyDBatchImportEvent({ job, event, workerId, leaseId, observedAt }) {
  assertJob(job);
  if (!validTime(observedAt) || workerId !== job.workerId || leaseId !== job.leaseId ||
      Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt) ||
      !Number.isSafeInteger(event?.chunkIndex) || event.chunkIndex < 0 || event.chunkIndex >= job.chunks.length) {
    throw new Error('D_BATCH_IMPORT_LEASE_OR_SCOPE_INVALID');
  }
  const next = clone(job), chunk = next.chunks[event.chunkIndex];
  if (!isDeepStrictEqual(event.offerIds, chunk.offerIds)) throw new Error('D_BATCH_IMPORT_OFFER_SCOPE_MISMATCH');
  if (event.kind === 'batch_import_intent') {
    if (chunk.status !== 'not_sent' || next.chunks.slice(0, chunk.index).some(prior =>
      !['waiting_platform', 'observed_imported', 'platform_failed', 'platform_skipped'].includes(prior.status))) {
      throw new Error('D_BATCH_IMPORT_INTENT_REPLAY_BLOCKED');
    }
    chunk.status = 'intent';
  } else if (event.kind === 'batch_import_task_received') {
    if (chunk.status !== 'intent' || !/^[1-9][0-9]*$/.test(event.taskId) ||
        !Number.isSafeInteger(Number(event.taskId))) throw new Error('D_BATCH_IMPORT_TASK_RECEIPT_INVALID');
    chunk.taskId = event.taskId;
    chunk.status = 'waiting_platform';
  } else if (event.kind === 'batch_import_unknown') {
    if (chunk.status !== 'intent' || !validRef(event.reason)) throw new Error('D_BATCH_IMPORT_UNKNOWN_INVALID');
    chunk.status = 'unknown_outcome';
    chunk.unknownReason = event.reason;
  } else if (event.kind === 'batch_import_observed') {
    if (!['waiting_platform', 'observed_pending', 'unknown_outcome'].includes(chunk.status) ||
        chunk.taskId === null || event.taskId !== chunk.taskId ||
        !Array.isArray(event.results) || !isDeepStrictEqual(event.results.map(result => result.offerId), chunk.offerIds) ||
        event.results.some(result => !['imported', 'platform_failed', 'platform_skipped', 'waiting_platform', 'unknown_outcome'].includes(result.classification) ||
          result.importObservation?.taskId !== event.taskId ||
          (result.importObservation.merchantSku !== null && result.importObservation.merchantSku !== result.offerId) ||
          (result.classification === 'imported' && (!/^[1-9][0-9]*$/.test(result.importObservation.productId) ||
            !Number.isSafeInteger(Number(result.importObservation.productId)))))) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_INVALID');
    }
    chunk.results = clone(event.results);
    chunk.status = event.results.some(result => result.classification === 'unknown_outcome') ? 'unknown_outcome' :
      event.results.some(result => result.classification === 'platform_failed') ? 'platform_failed' :
      event.results.some(result => result.classification === 'platform_skipped') ? 'platform_skipped' :
      event.results.some(result => result.classification === 'waiting_platform') ? 'observed_pending' : 'observed_imported';
  } else throw new Error('D_BATCH_IMPORT_EVENT_INVALID');
  next.revision++;
  next.updatedAt = observedAt;
  next.status = statusFor(next.chunks);
  assertJob(next);
  return Object.freeze(next);
}

/** Expired leases can be replaced without changing a saved intent or replaying a task. */
export function reclaimDBatchImportJob({ job, workerId, workerVersion, leaseId, leaseExpiresAt, observedAt }) {
  assertJob(job);
  if (!validRef(workerId) || !validRef(workerVersion) || !validRef(leaseId) || !validTime(observedAt) || !validTime(leaseExpiresAt) ||
      Date.parse(observedAt) < Date.parse(job.leaseExpiresAt) ||
      Date.parse(leaseExpiresAt) <= Date.parse(observedAt)) throw new Error('D_BATCH_IMPORT_RECLAIM_INVALID');
  const next = { ...clone(job), workerId, workerVersion, leaseId, leaseExpiresAt, updatedAt: observedAt,
    revision: job.revision + 1 };
  assertJob(next);
  return Object.freeze(next);
}
