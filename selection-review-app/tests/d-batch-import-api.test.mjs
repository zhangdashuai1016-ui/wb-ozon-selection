import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);

test('one authenticated batch confirmation persists authorization and reports unavailable D without an external request', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-import-api-'));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document,
    binding: fixture.binding, services: [] });
  const input = { confirmAll: true, excludedOfferIds: ['FIRST-EXCLUDED'],
    members: [{ candidateId: fixture.candidate.id, ownerInput: fixture.owner.args.input }],
    postImportScope: { schemaVersion: 'd-batch-post-import-scope-v1', inventoryAction: 'create_only',
      eReadbackOfferIds: [fixture.owner.args.input.merchantSku] } };
  const denied = await api.post('/api/d-batches/authorize', input, { authenticated: false });
  assert.equal(denied.status, 401);
  const before = await api.readBytes();
  await api.authenticate();
  const crossSite = await api.post('/api/d-batches/authorize', input,
    { headers: { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await api.readBytes(), before);
  const confirmed = await api.post('/api/d-batches/authorize', input);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.executionStatus, 'prewrite_blocked');
  assert.equal(confirmed.body.executionView.members[0].offerId, fixture.owner.args.input.merchantSku);
  assert.equal(confirmed.body.reasonCode, 'DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT');
  assert.equal(confirmed.body.externalRequests, 0);
  const replay = await api.post('/api/d-batches/authorize', input);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.batch.batchId, confirmed.body.batch.batchId);
  const detail=await api.get(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}`);
  assert.equal(detail.status,200);
  assert.equal(detail.body.members[0].importStatus,'not_started');
  const resume=await api.post(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}/resume`,
    {confirmUnsentStockContinuation:true});
  assert.equal(resume.status,422);
  assert.equal(resume.body.code,'DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT');
  const saved = await api.readDocument();
  assert.equal(saved.runtime.dProductionBatches.length, 1);
  assert.equal(saved.runtime.dBatchImportJobs, undefined);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
