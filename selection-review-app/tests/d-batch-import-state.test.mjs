import test from 'node:test';
import assert from 'node:assert/strict';
import { createDBatchImportJob, applyDBatchImportEvent } from '../lib/d-batch-import-state.mjs';

const at = '2026-09-27T10:00:00.000Z';
const lease = '2026-09-27T10:01:00.000Z';
const batch = { batchId: 'd-batch:synthetic', status: 'authorized', externalRequestState: 'not_sent',
  excludedOfferIds: ['offer-01'], members: Array.from({ length: 31 }, (_, index) => ({ offerId: `offer-${String(index + 2).padStart(2, '0')}` })) };
const chunks = [0, 10, 20, 30].map(start => ({ offerIds: batch.members.slice(start, start + 10).map(member => member.offerId),
  limitEvidenceRef: 'synthetic:current-limit' }));
const scope = { workerId: 'worker:synthetic', workerVersion: 'v1', leaseId: 'lease:synthetic', observedAt: at };
const apply = (job, event) => applyDBatchImportEvent({ job, event, ...scope });

test('32 specifications exclude the first; 31 offers persist four bounded task intents and per-offer results', () => {
  let job = createDBatchImportJob({ batch, chunks, ...scope, createdAt: at, leaseExpiresAt: lease });
  assert.deepEqual(job.chunks.map(chunk => chunk.offerIds.length), [10, 10, 10, 1]);
  assert.equal(job.chunks.flatMap(chunk => chunk.offerIds).includes('offer-01'), false);
  for (const chunk of job.chunks) {
    const offerIds = chunk.offerIds;
    job = apply(job, { kind: 'batch_import_intent', chunkIndex: chunk.index, offerIds });
    assert.equal(job.chunks[chunk.index].status, 'intent');
    assert.throws(() => apply(job, { kind: 'batch_import_intent', chunkIndex: chunk.index, offerIds }), /REPLAY_BLOCKED/);
    job = apply(job, { kind: 'batch_import_task_received', chunkIndex: chunk.index,
      offerIds, taskId: String(501 + chunk.index) });
  }
  assert.equal(job.status, 'waiting_platform');
  for (const chunk of job.chunks) {
    job = apply(job, { kind: 'batch_import_observed', chunkIndex: chunk.index, offerIds: chunk.offerIds,
      taskId: String(501 + chunk.index), results: chunk.offerIds.map(offerId => ({ offerId,
        classification: offerId === 'offer-09' ? 'platform_failed' : 'imported',
        importObservation: { taskId: String(501 + chunk.index), merchantSku: offerId,
          productId: offerId === 'offer-09' ? null : '910001' } })) });
  }
  assert.equal(job.status, 'partial_failure');
  assert.equal(job.chunks.flatMap(chunk => chunk.results).filter(result => result.classification === 'imported').length, 30);
  assert.equal(job.chunks.flatMap(chunk => chunk.results).filter(result => result.classification === 'platform_failed').length, 1);
  assert.throws(() => apply(job, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds }), /REPLAY_BLOCKED/);
});

test('missing receipt, wrong offer, wrong task and expired lease never reopen a write', () => {
  const admitted = createDBatchImportJob({ batch, chunks, ...scope, createdAt: at, leaseExpiresAt: lease });
  assert.throws(() => apply(admitted, { kind: 'batch_import_intent', chunkIndex: 1, offerIds: chunks[1].offerIds }), /REPLAY_BLOCKED/);
  const sent = apply(admitted, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds });
  assert.equal(sent.status, 'unknown_outcome');
  assert.throws(() => apply(sent, { kind: 'batch_import_intent', chunkIndex: 0, offerIds: chunks[0].offerIds }), /REPLAY_BLOCKED/);
  assert.throws(() => apply(sent, { kind: 'batch_import_task_received', chunkIndex: 0,
    offerIds: ['wrong'], taskId: '501' }), /OFFER_SCOPE_MISMATCH/);
  assert.throws(() => applyDBatchImportEvent({ job: sent, event: { kind: 'batch_import_task_received',
    chunkIndex: 0, offerIds: chunks[0].offerIds, taskId: '501' }, workerId: scope.workerId,
  leaseId: scope.leaseId, observedAt: lease }), /LEASE_OR_SCOPE_INVALID/);
  const received = apply(sent, { kind: 'batch_import_task_received', chunkIndex: 0,
    offerIds: chunks[0].offerIds, taskId: '501' });
  assert.throws(() => apply(received, { kind: 'batch_import_observed', chunkIndex: 0,
    offerIds: chunks[0].offerIds, taskId: '502', results: [] }), /OBSERVATION_INVALID/);
  assert.throws(() => createDBatchImportJob({ batch, chunks: [chunks[0]], ...scope,
    createdAt: at, leaseExpiresAt: lease }), /MEMBER_SCOPE_MISMATCH/);
});
