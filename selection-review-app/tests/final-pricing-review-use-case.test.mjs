import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalPricingRevalidationFixture } from './fixtures/final-pricing-revalidation-fixture.mjs';
import { createFinalPricingReviewUseCase } from '../lib/final-pricing-review-use-case.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext, createLocalDevelopmentActor } from '../lib/runtime-identity.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';

function fixture() {
  const f = createFinalPricingRevalidationFixture();
  f.candidate.salesSnapshotsV11 = structuredClone(f.assessmentInput.salesSnapshots);
  const document = { candidates: [f.candidate], evidencePacks: f.evidencePacks, currentCommissionCatalogs: [], rules: f.rules,
    runtime: { softwareJobs: [] } };
  const repository = createMemoryBusinessStateRepository(document);
  const owner = createActorContext({ userId: 'owner-final', sessionId: 'session-final', actorType: 'human', roles: ['owner'],
    source: 'authenticated_identity_provider', authenticatedAt: f.observedAt });
  const input = { candidateId: f.candidate.id, expectedRevision: f.candidate.dataRevision,
    skuPackageId: f.candidate.lifecycleV11.skuPackage.skuPackageId, selectedPriceRub: f.assessmentInput.selectedPriceRub,
    reviews: structuredClone(f.assessmentInput.reviews), idempotencyKey: 'final-review:1', auditEventId: 'audit:final-review:1' };
  const usecase = createFinalPricingReviewUseCase({ repository, runtimeMode: 'local_development', serverClock: () => f.observedAt });
  return { ...f, repository, owner, input, usecase };
}

test('同价复核绑定原B，双提交仅一次保存且冷启动复用零作业', async () => {
  const f = fixture(), before = await f.repository.readSnapshot();
  const results = await Promise.all([f.usecase.review({ actor: f.owner, input: f.input }), f.usecase.review({ actor: f.owner, input: f.input })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['committed', 'idempotent_replay']);
  assert.equal(results[0].result.status, 'price_unchanged');
  const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
  assert.deepEqual(sku.profitModels, before.candidates[0].lifecycleV11.skuPackage.profitModels);
  assert.equal(sku.finalPricingReview.profitModelVersion, sku.activeProfitModelVersion);
  assert.equal(saved.candidates[0].dataRevision, f.input.expectedRevision + 1);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(results[0].result.externalRequests, 0);
  assert.equal(results[0].result.productionAuthorizationCreated, false);
  const cold = createMemoryBusinessStateRepository(saved);
  const usecase = createFinalPricingReviewUseCase({ repository: cold, runtimeMode: 'local_development', serverClock: () => f.observedAt });
  assert.equal((await usecase.review({ actor: f.owner, input: f.input })).status, 'idempotent_replay');
  assert.deepEqual(await cold.readSnapshot(), saved);
});

test('同价重新复核生成新卡身份并保留旧卡和已确认素材', async () => {
  const f = fixture();
  await f.repository.transact(document => {
    const candidate = document.candidates[0], source = candidate.lifecycleV11.skuPackage;
    const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision,
      finalUploadAssets: finalAssets(), preparedAt: f.observedAt });
    const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision,
      finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: f.observedAt });
    candidate.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: f.observedAt }).skuPackage);
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot();
  const first = await f.usecase.review({ actor: f.owner, input: f.input });
  const second = await f.usecase.review({ actor: f.owner, input: { ...f.input, expectedRevision: first.candidate.dataRevision,
    idempotencyKey: 'final-review:again', auditEventId: 'audit:final-review:again' } });
  const life = second.candidate.lifecycleV11;
  assert.notEqual(first.candidate.lifecycleV11.skuPackage.productionConfirmationCard.cardRevision, life.skuPackage.productionConfirmationCard.cardRevision);
  assert.deepEqual(life.finalPricingCardHistory[0], before.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard);
  assert.deepEqual(life.skuPackage.c2FinalAssets, before.candidates[0].lifecycleV11.skuPackage.c2FinalAssets);
  assert.deepEqual(life.skuPackage.profitModels, before.candidates[0].lifecycleV11.skuPackage.profitModels);
});

test('改价追加B并保留历史，C1引用新利润，未自动授权或外部作业', async () => {
  const f = fixture(), before = await f.repository.readSnapshot();
  const result = await f.usecase.review({ actor: f.owner, input: { ...f.input, selectedPriceRub: 2400 } });
  const saved = await f.repository.readSnapshot(), life = saved.candidates[0].lifecycleV11, old = before.candidates[0].lifecycleV11;
  assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), old.skuPackage.profitModels);
  assert.equal(life.skuPackage.profitModels.at(-1).recommendedSalePriceRub, 2400);
  assert.equal(life.skuPackage.c1ProductPlan.inputRefs.profitModelVersion, life.skuPackage.activeProfitModelVersion);
  assert.equal(life.finalPricingRevisionHistory.length, 1);
  assert.deepEqual(life.finalPricingRevisionHistory[0].previousOpportunityPackage, old.opportunityPackage);
  assert.equal(result.result.externalRequests, 0);
  assert.equal(result.result.platformWrites, 0);
  assert.equal(result.result.productionAuthorizationCreated, false);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  assert.ok(!life.skuPackage.productionAuthorization);
});

test('最终价格利润不通过后可显式改价重审，旧拒绝版本保留且无授权', async () => {
  const f = fixture();
  const first = await f.usecase.review({ actor: f.owner, input: { ...f.input, selectedPriceRub: 1 } });
  assert.equal(first.result.status, 'profit_rejected');
  const rejected = await f.repository.readSnapshot();
  const second = await f.usecase.review({ actor: f.owner, input: { ...f.input, expectedRevision: first.candidate.dataRevision,
    selectedPriceRub: 2400, idempotencyKey: 'final-review:2', auditEventId: 'audit:final-review:2' } });
  assert.equal(second.result.status, 'price_revalidated');
  const saved = await f.repository.readSnapshot(), sku = saved.candidates[0].lifecycleV11.skuPackage;
  assert.deepEqual(sku.profitModels.slice(0, -1), rejected.candidates[0].lifecycleV11.skuPackage.profitModels);
  assert.equal(sku.businessPhase, 'C1');
  assert.equal(sku.productionAuthorization, null);
  assert.deepEqual(saved.runtime.softwareJobs, []);
});

test('身份修订来源秘密或单样本未就绪全部拒绝且无字节改变', async () => {
  const cases = [
    f => ({ actor: createLocalDevelopmentActor({ at: f.observedAt }), input: f.input }),
    f => ({ actor: f.owner, input: { ...f.input, expectedRevision: f.input.expectedRevision + 1 } }),
    f => ({ actor: f.owner, input: { ...f.input, reviews: [{ ...f.input.reviews[0], snapshotId: 'missing' }, ...f.input.reviews.slice(1)] } }),
    f => ({ actor: f.owner, input: { ...f.input, reviews: [{ ...f.input.reviews[0], token: 'synthetic-secret' }, ...f.input.reviews.slice(1)] } }),
    f => ({ actor: f.owner, input: { ...f.input, reviews: f.input.reviews.slice(0, 1) } })
  ];
  const expected = [/FINAL_PRICING_OWNER_REQUIRED/, /REVISION_CONFLICT/, /FINAL_PRICING_SNAPSHOT_CHANGED/, /SECRET/, /FINAL_PRICING_EVIDENCE_REQUIRED/];
  for (const [index, request] of cases.entries()) {
    const f = fixture(), before = JSON.stringify(await f.repository.readSnapshot());
    await assert.rejects(() => f.usecase.review(request(f)), error => expected[index].test(`${error.code} ${error.message}`));
    assert.equal(JSON.stringify(await f.repository.readSnapshot()), before);
  }
});

test('缺政策及未结束作业或未知结果停止且无写入', async () => {
  const cases = [
    d => { delete d.rules.ozonDandanshu.costPolicySnapshot; },
    d => { d.candidates[0].lifecycleV11.skuPackage.technicalStatus = 'unknown_outcome'; },
    ...['queued', 'running', 'unknown_outcome'].map(status => d => { const c = d.candidates[0]; d.runtime.softwareJobs.push({ schemaVersion: 'software-job-v1', candidateId: c.id, skuPackageId: c.lifecycleV11.skuPackage.skuPackageId, status }); })
  ];
  for (const [index, mutate] of cases.entries()) {
    const f = fixture();
    await f.repository.transact(document => { mutate(document); return { document, changed: true, result: null }; });
    const before = JSON.stringify(await f.repository.readSnapshot());
    await assert.rejects(() => f.usecase.review({ actor: f.owner, input: f.input }), error => (index === 0 ? /B_COST_POLICY_/ : index === 1 ? /FINAL_PRICING_REVISION_NOT_AVAILABLE/ : /FINAL_PRICING_STAGE_CONFLICT/).test(`${error.code} ${error.message}`));
    assert.equal(JSON.stringify(await f.repository.readSnapshot()), before);
  }
});
