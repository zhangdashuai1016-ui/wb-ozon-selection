import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCurrentDJobExecutionCursor, DProductionJobCursorError } from '../lib/d-production-job-cursor.mjs';
import { dProductionJobCursorFixture, CURSOR_NOW as observedAt } from './fixtures/d-production-job-cursor-fixture.mjs';

const direct = await dProductionJobCursorFixture();
const oss = await dProductionJobCursorFixture({ oss: true });
const check = (fixture, candidate, job = fixture.job, at = observedAt) => assertCurrentDJobExecutionCursor({ job, candidate, observedAt: at });

test('真实无OSS/有OSS状态链均精确绑定固定PA revision，校验不修改来源', () => {
  for (const fixture of [direct, oss]) {
    const before = structuredClone(fixture);
    for (const candidate of fixture.snapshots.slice(0, -1)) {
      const cursor = check(fixture, candidate);
      assert.equal(cursor.authorizationCandidateRevision, fixture.job.revision);
      assert.equal(cursor.candidateRevision, candidate.dataRevision); assert.ok(Object.isFrozen(cursor));
      const sku = candidate.lifecycleV11.skuPackage;
      if (sku.dSoftwareExecution) {
        assert.equal(cursor.stage, 'd_in_flight'); assert.equal(cursor.executionRevision, sku.dSoftwareExecution.checkpoints.length + 1);
        assert.equal(cursor.candidateRevision, fixture.job.revision + (fixture === oss ? 3 : 1));
      }
    }
    assert.deepEqual(fixture, before);
  }
  assert.equal(check(oss, oss.snapshots[1]).stage, 'oss_in_flight');
  assert.equal(check(oss, oss.snapshots[2]).stage, 'oss_verified');
});

test('任一步candidate或job revision上下漂移均拒绝，不采用大于等于门禁', () => {
  for (const fixture of [direct, oss]) for (const source of fixture.snapshots.slice(0, -1)) for (const offset of [-1, 1]) {
    const candidate = structuredClone(source); candidate.dataRevision += offset;
    assert.throws(() => check(fixture, candidate), /CANDIDATE_REVISION_CONFLICT/);
    assert.throws(() => check(fixture, source, { ...fixture.job, revision: fixture.job.revision + offset }), /JOB_SOURCE_CONFLICT/);
  }
});

test('PA、G1、SKU、variant、冻结scope和plan来源漂移不能被源投影掩盖', () => {
  const source = oss.snapshots.at(-2);
  for (const change of [c => { c.storeRef.mappingVersion = 'other'; }, c => { c.lifecycleV11.skuPackage.dataRevision += 1; },
    c => { c.lifecycleV11.skuPackage.variantKey = 'other'; }, c => { c.lifecycleV11.skuPackage.productionAuthorization.executionBinding.warehouseId = '80001'; },
    c => { c.lifecycleV11.skuPackage.dSoftwareExecution.productionPlan.sourceAuthorization.authorizationId = 'other'; },
    c => { c.lifecycleV11.skuPackage.dSoftwareExecution.attempt.request.sourceProductionPlanFingerprint = 'a'.repeat(64); }]) {
    const candidate = structuredClone(source); change(candidate); assert.throws(() => check(oss, candidate));
  }
  const job = structuredClone(oss.job); job.scopeBinding.inputFingerprint = 'a'.repeat(64);
  assert.throws(() => check(oss, source, job));
});

test('OSS意图、实际素材结果和executionRevision漂移均拒绝', () => {
  for (const change of [s => { s.executionRevision += 1; }, s => { s.intent.persistedCandidateRevision += 1; },
    s => { s.intent.authorizationFingerprint = 'b'.repeat(64); }, s => { s.intent.finalUploadAssetIds.reverse(); },
    s => { s.assetTransport.resolvedAssets[0].sha256 = 'b'.repeat(64); },
    s => { s.assetTransport.resolvedAssets[0].platformAcceptedUrl = 'https://assets.example.com/other.png'; },
    s => { s.continuationBlocked = true; }]) {
    const candidate = structuredClone(oss.snapshots.at(-2)); change(candidate.lifecycleV11.skuPackage.dAssetTransport);
    assert.throws(() => check(oss, candidate), DProductionJobCursorError);
  }
});

test('checkpoint严格前缀、前序任务/产品/库存回执和执行计数独立核对', () => {
  for (const change of [s => { s.executionRevision += 1; }, s => { s.checkpoints.reverse(); }, s => { s.step = 'stock_intent'; },
    s => { s.checkpoints[2].taskId = '999'; }, s => { s.checkpoints[3].productId = '999'; },
    s => { s.checkpoints[4].warehouseId = '999'; }, s => { s.checkpoints[4].updated = false; },
    s => { s.checkpoints[5].observation.platformProductId = '999'; },
    s => { s.attempt.executionKey = 'execution:other'; }, s => { s.platformWrites = 0; },
    s => { s.canCallSellerApiBeforePersist = true; }, s => { s.attempt.request.finalUploads[0] = null; }]) {
    const candidate = structuredClone(direct.snapshots.at(-2)); change(candidate.lifecycleV11.skuPackage.dSoftwareExecution);
    assert.throws(() => check(direct, candidate), DProductionJobCursorError);
  }
});

test('终态、unknown、阻断、未来时间与过期rights拒绝执行游标，不制造重试资格', () => {
  assert.throws(() => check(direct, direct.snapshots.at(-1)), /ALREADY_COMPLETED/);
  for (const status of ['failed', 'unknown_outcome', 'succeeded']) {
    const candidate = structuredClone(direct.snapshots[1]); candidate.lifecycleV11.skuPackage.dSoftwareExecution.status = status;
    assert.throws(() => check(direct, candidate), /EXECUTION_STOPPED/);
  }
  for (const status of ['failed', 'unknown_outcome']) {
    const candidate = structuredClone(oss.snapshots[1]); candidate.lifecycleV11.skuPackage.dAssetTransport.status = status;
    assert.throws(() => check(oss, candidate), /ASSET_STOPPED/);
  }
  const future = structuredClone(direct.snapshots[1]); future.lifecycleV11.skuPackage.dSoftwareExecution.attempt.startedAt = '2099-01-01T00:00:00Z';
  assert.throws(() => check(direct, future), /TIME_CONFLICT/);
  const expiry = direct.snapshots[0].lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt;
  assert.throws(() => check(direct, direct.snapshots[1], direct.job, expiry), error => error.code === 'C1_SKU_RIGHTS_REVIEW_EXPIRED');
});

test('纯模块不引入事务、通用作业、PA用例或传输模块依赖', async () => {
  const source = await readFile(new URL('../lib/d-production-job-cursor.mjs', import.meta.url), 'utf8');
  const modules = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(modules, ['node:util', './d-e-software-job-scope.mjs', './production-contract-primitives.mjs', './store-binding.mjs']);
});
