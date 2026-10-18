import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import { startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createDBatchMediaReviewFixture } from './helpers/d-batch-media-review-fixture.mjs';
import { projectDBatchEMediaReview } from '../lib/d-batch-e-media-review.mjs';
import { createDBatchEReadback } from '../lib/d-batch-offer-readback.mjs';

const clone = value => structuredClone(value);
const batchRoute = fixture => `/api/d-batches/${encodeURIComponent(fixture.batchId)}`;
const reviewRoute = fixture => `${batchRoute(fixture)}/media-review`;
const reviewInput = fixture => ({ scope: projectDBatchEMediaReview(fixture).scope, decision: 'matches',
  confirmContent: true, confirmHero: true, confirmOrder: true });

async function start(t, fixture, identityProvider = 'local_owner_password') {
  return startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'd-batch-media-api-')),
    port: allocatedTestPorts().api, document: fixture.document, binding: fixture.binding, identityProvider });
}

async function rejectedWithoutWrite(api, before, request, status, code) {
  const response = await request;
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code);
  assert.deepEqual(await api.readBytes(), before);
  assert.equal(api.dependencyRequests(), 0);
  return response;
}

test('media review HTTP enforces authenticated owner, request origin, content type and exact path scope', async t => {
  const fixture = createDBatchMediaReviewFixture(), input = reviewInput(fixture);
  const api = await start(t, fixture), route = reviewRoute(fixture), before = await api.readBytes();
  await rejectedWithoutWrite(api, before, api.post(route, input, { authenticated: false }), 401, 'OWNER_LOGIN_REQUIRED');
  await rejectedWithoutWrite(api, before, api.get(batchRoute(fixture)), 401, 'OWNER_LOGIN_REQUIRED');
  const preview = projectDBatchEMediaReview(fixture).pairs[0].expected.previewSrc;
  await rejectedWithoutWrite(api, before, api.get(preview), 401, 'OWNER_LOGIN_REQUIRED');
  await api.authenticate();
  for (const [headers, status, code] of [
    [{ Origin: 'https://untrusted.example' }, 403, 'api_origin_forbidden'],
    [{ Origin: '' }, 403, 'api_origin_required'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'api_fetch_site_forbidden'],
    [{ 'Content-Type': 'text/plain' }, 415, 'json_content_type_required']
  ]) await rejectedWithoutWrite(api, before, api.post(route, input, { headers }), status, code);
  await rejectedWithoutWrite(api, before,
    api.post('/api/d-batches/d-batch:other/media-review', input), 400);
  await rejectedWithoutWrite(api, before,
    api.post('/api/d-batches/not-a-batch/media-review', { ...input, scope: { ...input.scope, batchId: 'not-a-batch' } }), 400);
  await rejectedWithoutWrite(api, before,
    api.post('/api/d-batches/%ZZ/media-review', input), 400, 'request_path_encoding_invalid');
  await rejectedWithoutWrite(api, before,
    api.post(route, { ...input, scope: { ...input.scope, candidateId: 'candidate:unrelated' } }), 409, 'D_BATCH_E_MEDIA_MEMBER_NOT_UNIQUE');
  await rejectedWithoutWrite(api, before,
    api.post(route, { ...input, confirmOrder: false }), 409, 'D_BATCH_E_MEDIA_INPUT_INVALID');
  await rejectedWithoutWrite(api, before,
    api.post(route, { ...input, extra: true }), 409, 'D_BATCH_E_MEDIA_INPUT_INVALID');
  const assetId = input.scope.expectedSequence.assets[0].assetId;
  await rejectedWithoutWrite(api, before,
    api.get(`/api/candidates/candidate:unrelated/lifecycle/c2/local-assets/${encodeURIComponent(assetId)}`), 404);
  await rejectedWithoutWrite(api, before,
    api.get(`/api/candidates/${encodeURIComponent(fixture.candidateId)}/lifecycle/c2/local-assets/c2-local:missing`), 404);
  await api.assertClean();
});

test('development identity cannot confirm media or read registered C2 originals', async t => {
  const fixture = createDBatchMediaReviewFixture(), input = reviewInput(fixture);
  const api = await start(t, fixture, 'development_default'), before = await api.readBytes();
  await rejectedWithoutWrite(api, before, api.post(reviewRoute(fixture), input), 403);
  await rejectedWithoutWrite(api, before, api.get(batchRoute(fixture)), 403);
  await rejectedWithoutWrite(api, before,
    api.get(projectDBatchEMediaReview(fixture).pairs[0].expected.previewSrc), 403, 'C2_PREVIEW_OWNER_REQUIRED');
  await api.assertClean();
});

test('owner confirmation and final E survive concurrent submission, readback and authenticated restart exactly once', async t => {
  const fixture = createDBatchMediaReviewFixture(), api = await start(t, fixture);
  const owner = await api.authenticate(), route = reviewRoute(fixture);
  const current = await api.get(batchRoute(fixture));
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.members[0].mediaReview.status, 'awaiting_owner_review');
  assert.equal(current.body.members[0].listedVerified, false);
  assert.equal(current.body.inSaleList.status, 'matched');
  const input = { ...reviewInput(fixture), scope: current.body.members[0].mediaReview.scope };
  const before = await api.readDocument();
  const responses = await Promise.all([api.post(route, input), api.post(route, input)]);
  for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(responses.map(response => response.body.idempotent).sort(), [false, true]);
  for (const response of responses) {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'owner_confirmed');
    assert.equal(response.body.confirmation.confirmedByUserId, owner.userId);
    assert.equal(response.body.externalRequests, 0);
    assert.equal(response.body.platformWrites, 0);
    assert.equal(response.body.executionView.members[0].listedVerified, true);
    assert.equal(response.body.executionView.members[0].eStatus, 'listed_verified');
  }
  const saved = await api.readDocument(), savedBytes = await api.readBytes();
  assert.equal(saved.runtime.dBatchEMediaConfirmations.length, 1);
  assert.equal(saved.runtime.dBatchEVerifications.length, 1);
  assert.equal(saved.runtime.operationAudit.filter(event => event.action === 'confirm_batch_e_media').length, 1);
  assert.deepEqual(saved.candidates, before.candidates);
  for (const field of ['dProductionBatches', 'dBatchImportJobs', 'dBatchOfferRecords', 'dBatchEJobs', 'dBatchEReadbacks', 'dBatchInSaleJobs']) {
    assert.deepEqual(saved.runtime[field], before.runtime[field], field);
  }
  assert.equal(saved.runtime.dBatchEReadbacks[0].listedVerified, false);
  await rejectedWithoutWrite(api, savedBytes, api.post(route, { ...input, decision: 'mismatch' }),
    409, 'D_BATCH_E_MEDIA_DECISION_ALREADY_RECORDED');
  await api.restart();
  await rejectedWithoutWrite(api, savedBytes, api.get(batchRoute(fixture)), 401, 'OWNER_LOGIN_REQUIRED');
  await api.authenticate('login');
  const reopened = await api.get(batchRoute(fixture));
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.deepEqual(reopened.body, responses[0].body.executionView);
  const replay = await api.post(route, input);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotent, true);
  assert.deepEqual(replay.body.confirmation, saved.runtime.dBatchEMediaConfirmations[0]);
  assert.deepEqual(await api.readBytes(), savedBytes);
  await api.assertClean();
});

test('media HTTP rejects stale revision, replaced readback and corrupted saved observation without committing', async t => {
  for (const kind of ['candidate_revision', 'new_readback', 'corrupt_readback']) await t.test(kind, async subtest => {
    const fixture = createDBatchMediaReviewFixture(), input = reviewInput(fixture);
    if (kind === 'candidate_revision') fixture.document.candidates[0].dataRevision += 1;
    if (kind === 'new_readback') {
      const readback = createDBatchEReadback({ record: fixture.record, observation: fixture.observation,
        readAt: '2026-08-22T08:00:02.000Z', readSequence: 2 });
      fixture.document.runtime.dBatchEReadbacks.push(readback);
      fixture.document.runtime.dBatchEJobs[0].readCount = 2;
      fixture.document.runtime.dBatchEJobs[0].resultId = readback.readbackId;
    }
    if (kind === 'corrupt_readback') fixture.document.runtime.dBatchEReadbacks[0].observation.imageCount = 99;
    const api = await start(subtest, fixture); await api.authenticate();
    const before = await api.readBytes();
    await rejectedWithoutWrite(api, before, api.post(reviewRoute(fixture), input), 409,
      kind === 'corrupt_readback' ? 'D_BATCH_E_MEDIA_READBACK_SOURCE_INVALID' : 'D_BATCH_E_MEDIA_SOURCE_CHANGED');
    if (kind === 'new_readback') {
      const current = await api.get(batchRoute(fixture));
      assert.equal(current.status, 200, JSON.stringify(current.body));
      assert.notEqual(current.body.members[0].mediaReview.scope.readbackId, input.scope.readbackId);
      const confirmed = await api.post(reviewRoute(fixture), { ...input, scope: current.body.members[0].mediaReview.scope });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body.confirmation.scope.readback.readSequence, 2);
      assert.equal((await api.readDocument()).runtime.dBatchEMediaConfirmations.length, 1);
    }
    await api.assertClean();
  });
});

test('HTTP saves owner mismatch and incomplete E as explicit non-success states', async t => {
  for (const decision of ['mismatch', 'matches']) await t.test(decision, async subtest => {
    const fixture = createDBatchMediaReviewFixture({ inSale: false, observation: { moderationStatus: 'unknown' } });
    const input = { ...reviewInput(fixture), decision };
    const api = await start(subtest, fixture); await api.authenticate();
    const before = clone(await api.readDocument());
    const response = await api.post(reviewRoute(fixture), input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const member = response.body.executionView.members[0];
    assert.equal(member.mediaReview.status, decision === 'mismatch' ? 'owner_mismatch' : 'owner_confirmed');
    assert.equal(member.listedVerified, false);
    assert.notEqual(member.eStatus, 'listed_verified');
    assert.ok(member.eGaps.includes('moderation_not_approved'));
    assert.ok(member.eGaps.includes('in_sale_not_observed'));
    if (decision === 'mismatch') assert.ok(member.eGaps.includes('owner_media_mismatch'));
    const saved = await api.readDocument();
    assert.equal(saved.runtime.dBatchEMediaConfirmations.length, 1);
    assert.deepEqual(saved.runtime.dBatchEVerifications ?? [], []);
    assert.deepEqual(saved.candidates, before.candidates);
    assert.deepEqual(saved.runtime.dBatchEReadbacks, before.runtime.dBatchEReadbacks);
    await api.assertClean();
  });
});
