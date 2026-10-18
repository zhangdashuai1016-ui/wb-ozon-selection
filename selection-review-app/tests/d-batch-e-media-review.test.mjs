import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createDBatchEReadback } from '../lib/d-batch-offer-readback.mjs';
import { projectDBatchEMediaReview, confirmDBatchEMediaReview, readDBatchEMediaConfirmation } from '../lib/d-batch-e-media-review.mjs';
import { createDBatchEFixture as fixture } from './helpers/d-batch-e-fixture.mjs';

const NOW = '2026-08-22T08:00:00.000Z', CONFIRMED_AT = '2026-08-22T08:00:02.000Z';
const clone = value => structuredClone(value);
const owner = createActorContext({ userId: 'synthetic-owner', sessionId: 'synthetic-media-session', actorType: 'human',
  roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: NOW });


const view = f => projectDBatchEMediaReview({ document: f.document, batchId: f.batchId, candidateId: f.candidateId });
const inputFor = (f, decision = 'matches') => ({ scope: clone(view(f).scope), decision,
  confirmContent: decision === 'matches', confirmHero: decision === 'matches', confirmOrder: decision === 'matches' });
const confirm = (repository, input, actor = owner) => confirmDBatchEMediaReview({ repository,
  runtimeMode: 'local_development', serverClock: () => CONFIRMED_AT, actor, input });
const proof = (document, f) => readDBatchEMediaConfirmation({ document, batchId: f.batchId, candidateId: f.candidateId });
function replaceObservation(f, changes) {
  const previous = f.document.runtime.dBatchEReadbacks[0];
  f.document.runtime.dBatchEReadbacks[0] = createDBatchEReadback({ record: f.record,
    observation: { ...clone(f.observation), ...changes }, readAt: previous.readAt, readSequence: previous.readSequence });
}

test('owner review shows the exact saved local and CDN sequences and adds evidence without changing source state', async () => {
  const f = fixture(), projected = view(f), original = clone(f.document);
  assert.equal(projected.status, 'awaiting_owner_review'); assert.equal(projected.canConfirmMatch, true);
  assert.equal(projected.pairs.length, 2);
  assert.equal(projected.pairs[0].expected.previewSrc, `/api/candidates/${encodeURIComponent(f.candidateId)}/lifecycle/c2/local-assets/c2-local%3A00000000-0000-4000-8000-000000000001`);
  assert.equal(projected.pairs[0].observed.platformUrl, f.observation.mediaObservation.primaryImageUrl);
  assert.equal(projected.scope.expectedSequence.assets[0].role, 'main_image');
  const repository = createMemoryBusinessStateRepository(f.document);
  const result = await confirm(repository, inputFor(f));
  assert.equal(result.status, 'owner_confirmed'); assert.equal(result.platformWrites, 0); assert.equal(result.externalRequests, 0);
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.candidates, original.candidates);
  for (const name of ['dProductionBatches', 'dBatchOfferRecords', 'dBatchEJobs', 'dBatchEReadbacks']) assert.deepEqual(saved.runtime[name], original.runtime[name]);
  assert.equal(saved.runtime.dBatchEMediaConfirmations.length, 1);
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(saved.runtime.operationAudit[0].sourceRevision, saved.runtime.operationAudit[0].resultRevision);
  assert.deepEqual(proof(saved, f), result.confirmation);
  assert.equal(saved.runtime.dBatchEReadbacks[0].listedVerified, false);
  assert.deepEqual(saved.runtime.dBatchEReadbacks[0].gaps, ['media_identity_unverified']);
});

test('reviewing one member does not mistake the per-request import limit for a batch limit', () => {
  const f = fixture(), batch = f.document.runtime.dProductionBatches[0], member = batch.members[0];
  for (let index = 1; index <= 100; index++) batch.members.push({ ...clone(member),
    candidateId: `synthetic-extra-candidate:${index}`, skuPackageId: `synthetic-extra-sku:${index}`,
    offerId: `SYNTHETIC-EXTRA-${index}`, authorizationId: `synthetic-extra-authorization:${index}` });
  batch.postImportScope.eReadbackOfferIds = batch.members.map(value => value.offerId);
  const projected = view(f);
  assert.equal(projected.status, 'awaiting_owner_review'); assert.equal(projected.canConfirmMatch, true);
  assert.equal(projected.scope.batchSource.members.length, 101);
  assert.equal(projected.scope.candidateId, f.candidateId);
});

test('duplicate concurrent owner submission commits once and mismatch is immutable for the same evidence', async () => {
  const f = fixture(), repository = createMemoryBusinessStateRepository(f.document), input = inputFor(f, 'mismatch');
  const results = await Promise.all([confirm(repository, input), confirm(repository, input)]);
  assert.deepEqual(results.map(result => result.idempotent).sort(), [false, true]);
  const saved = await repository.readSnapshot();
  assert.equal(saved.runtime.dBatchEMediaConfirmations.length, 1); assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(proof(saved, f), null);
  assert.equal(projectDBatchEMediaReview({ ...f, document: saved }).status, 'owner_mismatch');
  await assert.rejects(confirm(repository, inputFor(f)), /DECISION_ALREADY_RECORDED/);
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test('owner identity, explicit checks and every echoed source field are enforced before persistence', async () => {
  const f = fixture(), input = inputFor(f);
  const mutations = [value => { value.scope.sourceRevision++; }, value => { value.scope.authorizationId += ':other'; },
    value => { value.scope.sourceRecordId += ':other'; }, value => { value.scope.readbackId += ':other'; },
    value => { value.scope.expectedSequence.assets.reverse(); }, value => { value.scope.observedSequence.urls.reverse(); },
    value => { value.scope.readback.observation.currentStock++; }, value => { value.scope.extra = true; },
    value => { value.confirmHero = false; }];
  for (const mutate of mutations) {
    const repository = createMemoryBusinessStateRepository(f.document), changed = clone(input); mutate(changed);
    await assert.rejects(confirm(repository, changed), /SOURCE_CHANGED|INPUT_INVALID/);
    assert.deepEqual(await repository.readSnapshot(), f.document);
  }
  for (const actor of [{ ...owner, actorType: 'software' }, { ...owner, roles: ['reviewer'] },
    { ...owner, source: 'request_body' }, null]) {
    const repository = createMemoryBusinessStateRepository(f.document);
    await assert.rejects(confirm(repository, input, actor), /OWNER_REQUIRED|FORBIDDEN/);
    assert.deepEqual(await repository.readSnapshot(), f.document);
  }
});

test('current revision, PA, registration or readback changes reject stale human confirmation', async () => {
  const f = fixture(), input = inputFor(f);
  for (const mutate of [doc => { doc.candidates[0].dataRevision++; },
    doc => { doc.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId += ':other'; },
    doc => { doc.candidates[0].lifecycleV11.c2UploadDraft.selection.reverse(); },
    doc => { doc.runtime.dBatchEReadbacks[0].observation.mediaObservation.images[0] = 'https://ir.ozone.ru/s3/changed.jpg'; }]) {
    const changed = clone(f.document); mutate(changed); const repository = createMemoryBusinessStateRepository(changed);
    await assert.rejects(confirm(repository, input), /SOURCE_CHANGED|READBACK_SOURCE_INVALID|REGISTRATION_INVALID/);
    assert.deepEqual(await repository.readSnapshot(), changed);
  }
});

test('unapproved image origins and unsafe URLs are blocked without producing a review scope or fetch target', () => {
  const f = fixture();
  for (const url of ['https://example.com/image.jpg', 'https://ir.ozone.ru.evil.example/image.jpg',
    'https://192.168.0.1/image.jpg', 'https://ir.ozone.ru:9443/image.jpg',
    'https://ir.ozone.ru/image.jpg?resize=1', 'https://ir.ozone.ru/image.jpg#x']) {
    replaceObservation(f, { mediaObservation: { ...f.observation.mediaObservation, primaryImageUrl: url } });
    const projected = view(f);
    assert.equal(projected.status, 'blocked'); assert.equal(projected.canConfirmMatch, false);
    assert.equal(projected.scope, null); assert.deepEqual(projected.pairs, []);
  }
  for (const url of ['https://127.0.0.1/image.jpg', 'https://user@ir.ozone.ru/image.jpg']) {
    assert.throws(() => replaceObservation(f, { mediaObservation: { ...f.observation.mediaObservation,
      primaryImageUrl: url } }), /RUNTIME_IDENTITY_INVALID/);
  }
});

test('count or duplicate media differences can be recorded as mismatch and cannot be confirmed as matching', async () => {
  const f = fixture();
  for (const images of [[], ['https://ir.ozone.ru/s3/multimedia/test-detail.jpg', 'https://ir.ozone.ru/s3/multimedia/test-detail.jpg']]) {
    replaceObservation(f, { mediaObservation: { ...f.observation.mediaObservation, images }, imageCount: images.length + 1 });
    const projected = view(f); assert.equal(projected.canConfirmMatch, false); assert.equal(projected.canRecordMismatch, true);
    const repository = createMemoryBusinessStateRepository(f.document);
    await assert.rejects(confirm(repository, inputFor(f)), /SEQUENCE_MISMATCH/);
    const result = await confirm(repository, inputFor(f, 'mismatch')); assert.equal(result.status, 'owner_mismatch');
    assert.equal(proof(await repository.readSnapshot(), f), null);
  }
});

test('a newer readback requires a new owner review and cannot inherit the earlier matching decision', async () => {
  const f = fixture(), repository = createMemoryBusinessStateRepository(f.document);
  await confirm(repository, inputFor(f));
  await repository.transact(document => {
    const next = createDBatchEReadback({ record: f.record, observation: f.observation, readAt: CONFIRMED_AT, readSequence: 2 });
    document.runtime.dBatchEReadbacks.push(next); document.runtime.dBatchEJobs[0].readCount = 2;
    document.runtime.dBatchEJobs[0].resultId = next.readbackId;
    return { changed: true, document };
  });
  const saved = await repository.readSnapshot();
  assert.equal(proof(saved, f), null);
  const projected = projectDBatchEMediaReview({ ...f, document: saved });
  assert.equal(projected.status, 'awaiting_owner_review');
  await assert.rejects(confirm(repository, inputFor(f)), /SOURCE_CHANGED/);
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test('a queued or continuing follow-up read disables review until observation stops', () => {
  for (const status of ['queued', 'read_in_flight', 'observed_pending']) {
    const f = fixture();
    f.document.runtime.dBatchEJobs[0] = { ...clone(f.document.runtime.dBatchEJobs[0]), status,
      ...(status === 'read_in_flight' ? { readCount: 2 } : {}) };
    if (status === 'queued') {
      f.document.runtime.dBatchEJobs[0].readCount = 0;
      delete f.document.runtime.dBatchEJobs[0].resultId;
      f.document.runtime.dBatchEReadbacks = [];
    }
    const projected = view(f);
    assert.equal(projected.status, 'not_ready'); assert.equal(projected.scope, null); assert.equal(proof(f.document, f), null);
  }
  const stopped = fixture();
  stopped.document.runtime.dBatchEJobs[0] = { ...clone(stopped.document.runtime.dBatchEJobs[0]),
    status: 'observation_stopped', stopReason: 'observation_budget_exhausted' };
  assert.equal(view(stopped).status, 'awaiting_owner_review');
});

test('duplicate and corrupted saved evidence fail explicitly instead of returning a usable proof', async () => {
  const f = fixture(), repository = createMemoryBusinessStateRepository(f.document);
  await confirm(repository, inputFor(f)); const saved = await repository.readSnapshot();
  for (const mutate of [doc => { doc.runtime.dBatchEMediaConfirmations.push(clone(doc.runtime.dBatchEMediaConfirmations[0])); },
    doc => { doc.runtime.dBatchEMediaConfirmations[0].checks.hero = false; },
    doc => { doc.runtime.dBatchEMediaConfirmations[0].scope.observedSequence.urls.reverse(); },
    doc => { doc.runtime.dBatchEReadbacks.push(clone(doc.runtime.dBatchEReadbacks[0])); }]) {
    const changed = clone(saved); mutate(changed);
    assert.throws(() => proof(changed, f), /NOT_UNIQUE|CONFIRMATION_INVALID|CONFIRMATION_SOURCE_CHANGED/);
  }
});

test('legacy batch review remains evidence only and the confirmation survives real JSON save and reopen', async t => {
  const f = fixture({ version: 2 }), root = await mkdtemp(path.join(os.tmpdir(), 'batch-e-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state.json');
  const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, now: NOW });
  await repository.transact(() => ({ changed: true, document: f.document }));
  const result = await confirm(repository, inputFor(f));
  const reopened = createJsonBusinessStateRepository({ filePath });
  const saved = await reopened.readSnapshot();
  assert.equal(proof(saved, f).confirmationId, result.confirmation.confirmationId);
  assert.equal(saved.runtime.dProductionBatches[0].schemaVersion, 'd-batch-production-authorization-v2');
  assert.equal(saved.runtime.dBatchEReadbacks[0].listedVerified, false);
  assert.equal((await confirm(reopened, inputFor(f))).idempotent, true);
  assert.equal((await createJsonBusinessStateRepository({ filePath }).readSnapshot()).runtime.operationAudit.length, 1);
});
