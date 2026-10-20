import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readDBatchAssetTransportProof } from '../lib/d-batch-asset-transport.mjs';
import { BATCH_ASSET_AT as NOW, createRealAccountAssetTransportFixture as realAccountAssetFixture } from './helpers/d-batch-asset-transport-fixture.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';
import { waitForAccountReadBoundary } from './helpers/account-read-concurrency-fixture.mjs';

const clone = value => structuredClone(value);

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

for (const expiresFirst of ['grant', 'roles']) for (const sentBeforePause of [0, 1])
  test('per-image ' + expiresFirst + ' expiry preserves ' + sentBeforePause + ' sent assets and creates no next write intent', async t => {
    forbidRealNetwork(t);
    const f = await realAccountAssetFixture({ expiresFirst }), before = await f.repository.readSnapshot();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let paused = false;
    const runtime = f.restartReal({ getBatchMemberEvidence: async input => {
      const evidence = await f.realEvidence(input);
      const record = (await f.repository.readSnapshot()).runtime.dBatchAssetTransports?.[0];
      if (!paused && record?.status === 'in_flight' && record.writeIntents.length === sentBeforePause) {
        assert.equal(evidence.checkedAt, NOW);
        assert.deepEqual(evidence.inspection.risks.map(risk => risk.code), ACCOUNT_SOURCE_RISK_CODES);
        paused = true; entered.resolve(); await release.promise;
      }
      return evidence;
    } });
    const running = runtime.run(f.input);
    await waitForAccountReadBoundary(entered.promise, running, release.resolve);
    const atBarrier = await f.repository.readSnapshot();
    assert.equal(atBarrier.runtime.dBatchAssetTransports[0].writeIntents.length, sentBeforePause);
    assert.equal(f.syntheticPuts.length, sentBeforePause);
    assert.ok(Date.parse(f.expiry) < Date.parse(atBarrier.runtime.dBatchAssetTransports[0].leaseExpiresAt));
    f.advance(f.expiry); release.resolve();
    const result = await running, after = await f.repository.readSnapshot(), record = after.runtime.dBatchAssetTransports[0];
    assert.equal(result.reasonCode, 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_CURRENT');
    assert.equal(record.status, sentBeforePause === 0 ? 'failed' : 'unknown_outcome');
    assert.deepEqual(record.writeIntents, atBarrier.runtime.dBatchAssetTransports[0].writeIntents);
    assert.equal(f.syntheticPuts.length, sentBeforePause);
    assert.equal(record.state.intent.ossWrites, sentBeforePause === 0 ? 0 : 'unknown');
    if (sentBeforePause === 0) assert.equal(record.state.intent.externalRequestState, 'not_attempted');
    assert.equal(record.state.automaticRetry, false); assert.equal(record.state.continuationBlocked, true);
    assert.equal(projectDBatchExecutionView(after, f.batch.batchId).assetRequestTransmission,
      sentBeforePause === 0 ? 'not_attempted' : 'attempted_or_unknown');
    assert.deepEqual(after.candidates, before.candidates);
    assert.deepEqual(after.runtime.dProductionBatches, before.runtime.dProductionBatches);
    assert.deepEqual(after.runtime.ozonAccountReadReceipts, before.runtime.ozonAccountReadReceipts);
    assert.deepEqual(after.runtime.ozonDEPreflightEvidence, before.runtime.ozonDEPreflightEvidence);
    await assert.rejects(() => f.accounts[0].enqueue({ refreshOfJobId: f.completed[0].job.jobId,
      idempotencyKey: 'account:refresh:after-image-expiry:' + expiresFirst + ':' + sentBeforePause }),
    { code: 'OZON_ACCOUNT_READ_REFRESH_PRODUCTION_BUSY' });
    assert.deepEqual(await f.repository.readSnapshot(), after);
    await runtime.run(f.input);
    assert.deepEqual(await f.repository.readSnapshot(), after);
    assert.equal(f.syntheticPuts.length, sentBeforePause); assert.equal(f.accounts[0].requests.length, 3);
  });

test('a completed member asset receipt survives the next member per-image expiry without reporting zero transmission', async t => {
  forbidRealNetwork(t);
  const f = await realAccountAssetFixture({ count: 2, expiresFirst: 'grant' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let paused = false;
  const runtime = f.restartReal({ getBatchMemberEvidence: async input => {
    const evidence = await f.realEvidence(input), records = (await f.repository.readSnapshot()).runtime.dBatchAssetTransports;
    if (!paused && records?.length === 2 && records[0].status === 'verified' &&
        records[1].status === 'in_flight' && records[1].writeIntents.length === 0) {
      paused = true; entered.resolve(); await release.promise;
    }
    return evidence;
  } });
  const running = runtime.run(f.input);
  await waitForAccountReadBoundary(entered.promise, running, release.resolve);
  const atBarrier = await f.repository.readSnapshot(), sent = clone(f.syntheticPuts);
  assert.ok(sent.length > 0);
  f.advance(f.expiry); release.resolve();
  const result = await running, after = await f.repository.readSnapshot();
  assert.equal(result.reasonCode, 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_CURRENT');
  assert.deepEqual(after.runtime.dBatchAssetTransports[0], atBarrier.runtime.dBatchAssetTransports[0]);
  assert.ok(readDBatchAssetTransportProof({ document: after, batchId: f.batch.batchId, candidateId: after.candidates[0].id }));
  assert.equal(after.runtime.dBatchAssetTransports[1].status, 'failed');
  assert.deepEqual(after.runtime.dBatchAssetTransports[1].writeIntents, []);
  assert.deepEqual(f.syntheticPuts, sent);
  assert.equal(projectDBatchExecutionView(after, f.batch.batchId).assetRequestTransmission, 'attempted_or_unknown');
  assert.equal(after.runtime.dBatchImportJobs, undefined);
  assert.deepEqual(f.accounts.map(account => account.requests.length), [3, 3]);
});
