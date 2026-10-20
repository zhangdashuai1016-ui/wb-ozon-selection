import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readDBatchAssetTransportProof } from '../lib/d-batch-asset-transport.mjs';
import { BATCH_ASSET_AT as NOW, createRealAccountAssetTransportFixture as realAccountAssetFixture } from './helpers/d-batch-asset-transport-fixture.mjs';

const ACCOUNT_SOURCE_RISK_CODES = [
  'account_store_identity_not_provided',
  'account_store_identity_from_scoped_warehouse',
  'account_price_currency_from_company_currency',
  'inventory_price_state_engineering_mapping',
  'method_contract_not_product_result'
];

function forbidRealNetwork(t) {
  const tripwires = [
    t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected real network fetch')),
    t.mock.method(http, 'request', () => assert.fail('Unexpected real HTTP request')),
    t.mock.method(https, 'request', () => assert.fail('Unexpected real HTTPS request'))
  ];
  t.after(() => { for (const tripwire of tripwires) assert.equal(tripwire.mock.callCount(), 0); });
}

test('three members consume real v4 account sources and retain all five source explanations through asset transport', async t => {
  forbidRealNetwork(t);
  const f = await realAccountAssetFixture({ count: 3 }), before = await f.repository.readSnapshot();
  for (const record of Object.values(before.runtime.ozonDEPreflightEvidence)) {
    assert.equal(record.schemaVersion, 'ozon-de-preflight-evidence-v4');
    assert.deepEqual(record.inspection.risks.map(risk => risk.code), ACCOUNT_SOURCE_RISK_CODES);
  }
  const result = await f.restartReal().run(f.input), after = await f.repository.readSnapshot();
  assert.equal(result.status, 'verified');
  assert.equal(f.syntheticPuts.length, before.candidates.reduce((sum, candidate) =>
    sum + candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope.finalUploads.length, 0));
  assert.equal(f.uploads.length, 3);
  assert.deepEqual(f.accounts.map(account => account.requests.length), [3, 3, 3]);
  for (const { evidence } of f.evidenceRead) {
    assert.deepEqual(evidence.inspection.risks.map(risk => risk.code), ACCOUNT_SOURCE_RISK_CODES);
    assert.deepEqual(evidence.capabilities.gaps.map(gap => gap.code), ['asset_transport_not_verified']);
  }
  assert.equal(after.runtime.dBatchAssetTransports.length, 3);
  assert.ok(after.runtime.dBatchAssetTransports.every(record => record.status === 'verified'));
  for (const candidate of before.candidates) assert.ok(readDBatchAssetTransportProof({
    document: after, batchId: f.batch.batchId, candidateId: candidate.id }));
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.runtime.dProductionBatches, before.runtime.dProductionBatches);
  assert.deepEqual(after.runtime.ozonAccountReadReceipts, before.runtime.ozonAccountReadReceipts);
  assert.deepEqual(after.runtime.ozonDEPreflightEvidence, before.runtime.ozonDEPreflightEvidence);
  assert.equal(after.runtime.dBatchImportJobs, undefined);
});

for (const invalid of ['warehouse_not_rfbs', 'warehouse_paused', 'permission_denied', 'currency_mismatch'])
  test('real account provider rejects ' + invalid + ' on a later member before any asset intent', async t => {
    forbidRealNetwork(t);
    const f = await realAccountAssetFixture({ count: 2, adjustResponses(responses, index) {
      if (index !== 1) return;
      if (invalid === 'warehouse_not_rfbs') responses['/v2/warehouse/list'].warehouses[0].is_rfbs = false;
      if (invalid === 'warehouse_paused') responses['/v2/warehouse/list'].warehouses[0].pause_at = NOW;
      if (invalid === 'permission_denied') responses['/v1/roles'].roles[0].methods =
        responses['/v1/roles'].roles[0].methods.filter(method => method !== '/v3/product/import');
      if (invalid === 'currency_mismatch') responses['/v1/seller/info'].company.currency = 'RUB';
    } });
    const before = await f.repository.readSnapshot(), result = await f.restartReal().run(f.input);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasonCode, 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_READY');
    assert.deepEqual(await f.repository.readSnapshot(), before);
    assert.deepEqual(f.syntheticPuts, []); assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.accounts.map(account => account.requests.length), [3, 3]);
    const bad = f.evidenceRead.find(value => value.candidateId === before.candidates[1].id).evidence;
    assert.equal(bad.capabilities.status, 'not_ready');
    if (invalid.startsWith('warehouse_')) {
      const code = invalid === 'warehouse_not_rfbs' ? 'account_warehouse_not_rfbs' : 'account_warehouse_paused';
      assert.ok(bad.capabilities.gaps.some(gap => gap.code === code && gap.field === 'warehouse'));
      assert.ok(bad.inspection.risks.some(risk => risk.code === code));
    }
    assert.ok(bad.inspection.risks.some(risk => risk.code === 'method_contract_not_product_result'));
  });

test('asset structured preflight rejects unsafe fields even when all real provider source explanations remain', async t => {
  forbidRealNetwork(t);
  const f = await realAccountAssetFixture({ count: 2 }), before = await f.repository.readSnapshot();
  const mutations = [
    ['permission_denied', inspection => { inspection.permissionStatus = 'denied'; }],
    ['permission_unknown', inspection => { inspection.permissionStatus = 'unknown'; }],
    ['store_mismatch', inspection => { inspection.storeIdentityStatus = 'mismatched'; }],
    ['anchor_missing', inspection => { inspection.storeIdentityStatus = 'unverified'; inspection.storeIdentityVia = 'none'; }],
    ['api_unavailable', inspection => { inspection.connections.api.status = 'unavailable'; }],
    ['api_unknown', inspection => { inspection.connections.api.status = 'unknown'; }],
    ['currency_mismatch', inspection => { inspection.priceFieldCurrency = 'RUB'; }],
    ['write_field_missing', inspection => { inspection.platformWritableFields = inspection.platformWritableFields.filter(field => field !== 'stock'); }],
    ['image_denied', inspection => { inspection.imagePermissionStatus = 'denied'; }],
    ['image_unknown', inspection => { inspection.imagePermissionStatus = 'unknown'; }]
  ];
  for (const [name, mutate] of mutations) {
    const runtime = f.restartReal({ getBatchMemberEvidence: async input => {
      const evidence = await f.realEvidence(input);
      assert.deepEqual(evidence.inspection.risks.map(risk => risk.code), ACCOUNT_SOURCE_RISK_CODES);
      if (input.candidate.id === before.candidates[1].id) mutate(evidence.inspection);
      return evidence;
    } });
    const result = await runtime.run(f.input);
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.reasonCode, 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_READY', name);
    assert.deepEqual(await f.repository.readSnapshot(), before, name);
    assert.deepEqual(f.syntheticPuts, [], name); assert.deepEqual(f.uploads, [], name);
  }
  assert.deepEqual(f.accounts.map(account => account.requests.length), [3, 3]);
});
