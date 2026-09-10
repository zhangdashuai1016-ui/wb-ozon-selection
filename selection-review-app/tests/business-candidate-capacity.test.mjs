import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { executeBusinessMutation } from '../lib/business-mutation-transaction.mjs';
import { assertSafeRuntimeRecord, createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';

const at = '2026-09-08T10:00:00.000Z';
function candidate() { return { id: 'capacity-candidate', dataRevision: 1, workflowStatus: 'c1_preparation', savedEvidence: Array(10500).fill(0) }; }
async function commit(next) {
  const original = { id: next.id, dataRevision: 1, workflowStatus: 'c1_preparation' };
  const repository = createMemoryBusinessStateRepository({ candidates: [original] });
  const input = { repository, runtimeMode: 'local_development', actor: createLocalDevelopmentActor({ at, userId: 'capacity-owner' }),
    requiredRoles: ['owner'], action: 'prepare_current_c1_request', candidateId: next.id, skuPackageId: 'sku:capacity', expectedRevision: 1,
    idempotencyKey: 'capacity:1', inputFingerprint: 'capacity-input-v1', auditEventId: 'audit:capacity:1', serverTime: at,
    mutate: () => ({ candidate: next, result: { status: 'awaiting_paid_confirmation' } }) };
  return { repository, run: () => executeBusinessMutation(input), original };
}

test('bounded aggregate candidate commits atomically while external single-record budget stays unchanged', async () => {
  const next = candidate();
  assert.throws(() => assertSafeRuntimeRecord(next), /RUNTIME_IDENTITY_INVALID/);
  const f = await commit(next), result = await f.run();
  assert.equal(result.status, 'committed'); assert.equal(result.candidate.dataRevision, 2);
  const stored = await f.repository.readSnapshot();
  assert.deepEqual(stored.candidates[0].savedEvidence, next.savedEvidence);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);
  const replay = await f.run(); assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await f.repository.readSnapshot(), stored);
});

test('aggregate node byte and depth limits reject without any partial business mutation', async () => {
  const excessiveNodes = candidate(); excessiveNodes.savedEvidence = Array(20000).fill(0);
  const excessiveBytes = candidate(); excessiveBytes.note = '中'.repeat(350000);
  const excessiveEscapedBytes = candidate(); excessiveEscapedBytes.note = '\u0000'.repeat(180000);
  const excessiveDepth = candidate(); let cursor = excessiveDepth; for (let i = 0; i < 129; i++) cursor = cursor.next = {};
  for (const next of [excessiveNodes, excessiveBytes, excessiveEscapedBytes, excessiveDepth]) {
    const f = await commit(next), before = await f.repository.readSnapshot();
    await assert.rejects(f.run(), error => error.code === 'BUSINESS_CANDIDATE_RESOURCE_LIMIT_EXCEEDED');
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('secrets raw persistence and local paths after node ten thousand still reject', async () => {
  for (const unsafe of [{ clientSecret: 'synthetic' }, { note: 'Bearer synthetic-secret' }, { rawResponse: {} }, { note: '/private/synthetic/file' }]) {
    const next = candidate(); next.finalEvidence = unsafe;
    const f = await commit(next), before = await f.repository.readSnapshot();
    await assert.rejects(f.run(), /RUNTIME_IDENTITY_INVALID/);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test('candidate scope never increases the result-envelope budget', async () => {
  const next = candidate(); const repository = createMemoryBusinessStateRepository({ candidates: [{ id: next.id, dataRevision: 1 }] });
  const before = await repository.readSnapshot();
  await assert.rejects(executeBusinessMutation({ repository, runtimeMode: 'local_development', actor: createLocalDevelopmentActor({ at }),
    requiredRoles: ['owner'], action: 'prepare_current_c1_request', candidateId: next.id, skuPackageId: 'sku:capacity', expectedRevision: 1,
    idempotencyKey: 'capacity:result', inputFingerprint: 'capacity-result-v1', auditEventId: 'audit:capacity:result', serverTime: at,
    mutate: () => ({ candidate: next, result: { oversizedResponse: Array(10500).fill(0) } }) }), /RUNTIME_IDENTITY_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});
