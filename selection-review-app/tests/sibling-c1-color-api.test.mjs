import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { siblingColorState } from './fixtures/sibling-color-state.mjs';
import { startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);

test('synthetic sibling color recovery API preserves the predecessor and requires owner identity', async t => {
  const document = siblingColorState();
  const frozen = document.candidates[0];
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-color-api-'));
  const api = await startSavedDEApi(t, { directory, port, document,
    binding: { storeRef: frozen.storeRef, platform: frozen.targetPlatform }, productionBindings: [] });
  const route = `/api/candidates/${frozen.id}/lifecycle/c1/revise-sibling-color`;
  const input = { candidateId: frozen.id, skuPackageId: frozen.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: frozen.dataRevision };
  const original = await api.readBytes();
  const guest = await api.post(route, input, { authenticated: false });
  assert.equal(guest.status, 401, JSON.stringify(guest.body));
  assert.deepEqual(await api.readBytes(), original);

  await api.authenticate();
  const editable = document.candidates[1];
  const freezeRoute = `/api/candidates/${editable.id}/lifecycle/c1/continue-preparation`;
  const beforeFreeze = await api.readBytes();
  const freeze = await api.post(freezeRoute, { candidateId: editable.id, dataRevision: editable.dataRevision });
  assert.equal(freeze.status, 409, JSON.stringify(freeze.body));
  assert.equal(freeze.body.code, 'SIBLING_COLOR_BINDING_INVALID');
  assert.deepEqual(freeze.body.requiredAttributeIds, ['10096', '10097']);
  assert.deepEqual(await api.readBytes(), beforeFreeze);

  const stale = await api.post(route, { ...input, dataRevision: input.dataRevision - 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readBytes(), beforeFreeze);
  const responses = await Promise.all([api.post(route, input), api.post(route, input)]);
  assert.ok(responses.every(response => response.status === 200), JSON.stringify(responses));
  assert.deepEqual(new Set(responses.map(response => response.body.status)), new Set(['committed', 'idempotent_replay']));
  const saved = await api.readDocument();
  const current = saved.candidates.find(candidate => candidate.id === frozen.id);
  assert.equal(current.dataRevision, frozen.dataRevision + 1);
  assert.equal(current.lifecycleV11.skuPackage.businessPhase, 'C1');
  assert.equal(current.lifecycleV11.skuPackage.c1ProductPlan.status, 'inputs_ready');
  assert.equal(current.lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal(current.lifecycleV11.skuPackage.productionConfirmationCard, null);
  assert.equal(saved.c1SiblingColorRevisionHistoryRecords.length, 1);
  assert.deepEqual(saved.c1SiblingColorRevisionHistoryRecords[0].previousSkuPackage,
    frozen.lifecycleV11.skuPackage);
  const committedBytes = await api.readBytes();
  const conflicting = await api.post(route, { ...input, skuPackageId: 'synthetic:other-sku' });
  assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
  assert.equal(conflicting.body.code, 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await api.readBytes(), committedBytes);
  assert.equal(saved.candidates.find(candidate => candidate.id === 'SYNTHETIC-COLOR-EDITABLE').dataRevision,
    document.candidates[1].dataRevision);
  assert.equal(saved.runtime.softwareJobs?.length ?? 0, 0);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
