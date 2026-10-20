import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { runRealAConfirmationToBAndC1, assertCurrentBCommissionEvidence } from '../lib/real-a-b-c1-flow.mjs';
import { runSkuProfitModel, validateProfitModel } from '../lib/profit-model.mjs';
import { validateSkuLifecyclePackage } from '../lib/product-lifecycle-schema.mjs';
import { createBExactCommissionRecalculationUseCase } from '../lib/b-exact-commission-recalculation-use-case.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createSavedConditionalBFixture } from './fixtures/real-a-b-flow-fixture.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { finalPricingC1ReuseFixture } from './fixtures/final-pricing-c1-reuse-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { finalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { confirmedAt, officialCommissionPack, ownerTargetFlowFixture, profitInputs,
  saveFlowResult } from './fixtures/owner-target-price-regression-fixture.mjs';

function forbidNetwork(t) {
  const tripwires = [
    t.mock.method(globalThis, 'fetch', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST')),
    t.mock.method(http, 'request', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST')),
    t.mock.method(https, 'request', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST'))
  ];
  t.after(() => { for (const tripwire of tripwires) assert.equal(tripwire.mock.callCount(), 0); });
}


test('real A uses owner 848 for formal profit while preserving the observed 475 market and its conflict', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture();
  const before = structuredClone(fixture.args);
  const result = runRealAConfirmationToBAndC1(fixture.args);
  const model = result.profitModel;
  assert.equal(model.recommendedSalePriceRub, 848);
  assert.equal(model.recommendedSalePriceCny, 70.67);
  // Independently calculated from the synthetic fixed costs and 12% + 5% + 2% income rates.
  assert.equal(model.unitProfitRmb, 18.94);
  assert.equal(model.sellerSettlementRevenue.amount, 62.19);
  assert.ok(Math.abs(model.calculation.unitProfitRmb - (848 / 12 * 0.81 - 38.3)) < 1e-10);
  assert.equal(model.profitMargin, Number(((848 / 12 * 0.81 - 38.3) / (848 / 12)).toFixed(4)));
  assert.equal(model.result, 'passed');
  assert.equal(model.calculationType, 'formal');
  assert.equal(model.calculation.version, 'profit-calculation-v4-owner-target-price');
  assert.equal(model.priceInputs.marketReferencePriceRub, 475);
  const target = model.priceInputs.ownerTargetPrice;
  assert.deepEqual(Object.keys(target).sort(), ['amountRub', 'candidateId', 'confirmedAt', 'evidenceRef', 'sourceRevision']);
  assert.equal(target.amountRub, 848);
  assert.equal(target.candidateId, fixture.source.id);
  assert.equal(target.sourceRevision, fixture.source.dataRevision);
  assert.equal(target.confirmedAt, confirmedAt);
  assert.equal(target.evidenceRef, `owner-a-confirmation:${fixture.source.id}:${fixture.source.dataRevision}`);
  const confirmationEvent = result.opportunityPackage.audit.history.find(event => event.event === 'real_a_one_card_inputs_frozen');
  assert.deepEqual(confirmationEvent.ownerTargetPrice, target);
  assert.deepEqual(result.opportunityPackage.salesSnapshots, fixture.source.salesSnapshotsV11);
  assert.equal(result.opportunityPackage.marketAssessment.recommendedSalePrice.amount, 475);
  assert.equal(model.marketFit.marketReferencePriceCny, 39.58);
  assert.equal(model.marketFit.status, 'severe_market_conflict');
  assert.deepEqual(model.marketFit.feePriceBasis, { kind: 'owner_target_price', targetSalePriceCny: 848 / 12,
    commissionRate: 0.12, marketComparison: 'reference_only' });
  assert.equal(result.systemEvidenceBundle.platformFeeEvidence.officialCommissionBinding.priceRub, 848);
  assert.equal(result.c1Handoff.trigger, 'b_passed_auto_c1');
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.platformWrites, 0);
  assert.deepEqual(result.externalAccesses, []);
  assert.deepEqual(fixture.args, before);
});

test('no owner target retains the v3 market-price calculation and an actual loss cannot create C1', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture({ targetPriceRub: null });
  const result = runRealAConfirmationToBAndC1(fixture.args);
  assert.equal(result.profitModel.recommendedSalePriceRub, 475);
  assert.equal(result.profitModel.calculation.version, 'profit-calculation-v3-cost-policy-snapshot');
  assert.equal(result.profitModel.priceInputs, undefined);
  assert.equal(result.profitModel.result, 'rejected');
  assert.equal(result.c1Handoff, null);
  assert.equal(result.skuPackage.businessPhase, 'B');
});

for (const value of [0, -1, '848', NaN, Infinity]) {
  test(`invalid explicit owner target ${String(value)} fails instead of falling back to market`, async t => {
    forbidNetwork(t);
    const fixture = await ownerTargetFlowFixture();
    fixture.input.targetSalePriceRub = value;
    const before = structuredClone(fixture.source);
    assert.throws(() => runRealAConfirmationToBAndC1(fixture.args), /REAL_A_CONFIRMATION_INVALID/);
    assert.deepEqual(fixture.source, before);
  });
}

test('generic A rejects an official 849 price binding for actual owner 848 even in the same tariff tier', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture({ commissionPriceRub: 849 });
  assert.equal(fixture.packs[0].commissionCatalogRef.priceTier, 'le1500');
  const before = structuredClone(fixture.args);
  assert.throws(() => runRealAConfirmationToBAndC1(fixture.args), /B_INPUT_GAP|B_COMMISSION|REAL_A_SYSTEM_EVIDENCE_GAP/);
  assert.deepEqual(fixture.args, before);
});

test('generic B with no owner target also rejects a fee bound to a different actual market price', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture({ targetPriceRub: null, commissionPriceRub: 848 });
  assert.throws(() => runRealAConfirmationToBAndC1(fixture.args), /B_INPUT_GAP|B_COMMISSION|REAL_A_SYSTEM_EVIDENCE_GAP/);
});

test('final commission recheck rejects a changed same-ID official binding without rewriting the frozen bundle', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture();
  const result = runRealAConfirmationToBAndC1(fixture.args);
  const before = structuredClone(result.systemEvidenceBundle);
  fixture.packs[0].evidenceData.officialCommissionBinding.priceRub = 849;
  assert.throws(() => assertCurrentBCommissionEvidence({ bundle: result.systemEvidenceBundle,
    evidencePacks: fixture.packs, currentCommissionCatalogs: [], asOf: confirmedAt }), /B_COMMISSION_SOURCE_CONFLICT/);
  assert.deepEqual(result.systemEvidenceBundle, before);
});

test('replaying A preserves the original target evidence and rejects changed or removed owner targets', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture();
  const first = runRealAConfirmationToBAndC1(fixture.args);
  const saved = saveFlowResult(fixture.source, first), before = structuredClone(saved);
  const input = { ...fixture.input, sourceDataRevision: saved.dataRevision, dataRevision: saved.dataRevision };
  const replay = runRealAConfirmationToBAndC1({ ...fixture.args, candidate: saved, submission: input });
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.profitModel, first.profitModel);
  assert.deepEqual(replay.skuPackage.profitModels, first.skuPackage.profitModels);
  for (const targetSalePriceRub of [849, null]) {
    assert.throws(() => runRealAConfirmationToBAndC1({ ...fixture.args, candidate: saved,
      submission: { ...input, targetSalePriceRub } }), /ALREADY_CONFIRMED_CONFLICT|SYSTEM_EVIDENCE_GAP/);
  }
  for (const receiptChange of [{ receiptId: 'synthetic:another-a-confirmation' },
    { sourceCandidateRevision: saved.lifecycleV11.aConfirmationReceipt.sourceCandidateRevision + 1 },
    { confirmedAt: '2026-08-18T02:00:01.000Z' }, { decision: 'reject' }]) {
    const changed = structuredClone(saved);
    Object.assign(changed.lifecycleV11.aConfirmationReceipt, receiptChange);
    const changedBefore = structuredClone(changed);
    assert.throws(() => runRealAConfirmationToBAndC1({ ...fixture.args, candidate: changed, submission: input }),
      /REAL_A_ALREADY_CONFIRMED_CONFLICT/);
    assert.deepEqual(changed, changedBefore);
  }
  assert.deepEqual(saved, before);
});

test('a previously market-priced A confirmation cannot acquire an owner target through replay', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture({ marketPriceRub: 1462, targetPriceRub: null, mode: 'exact' });
  const first = runRealAConfirmationToBAndC1(fixture.args), saved = saveFlowResult(fixture.source, first);
  const before = structuredClone(saved);
  assert.throws(() => runRealAConfirmationToBAndC1({ ...fixture.args, candidate: saved,
    submission: { ...fixture.input, sourceDataRevision: saved.dataRevision, dataRevision: saved.dataRevision,
      targetSalePriceRub: 1462 } }), /ALREADY_CONFIRMED_CONFLICT|SYSTEM_EVIDENCE_GAP/);
  assert.deepEqual(saved, before);
});

test('B replay cannot change price origin or amount across v3 and v4 under the same calculation identity', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture({ mode: 'exact' });
  const inputs = profitInputs(fixture);
  assert.ok(inputs.salesSelection.ownerTargetPrice);
  const marketInputs = profitInputs(await ownerTargetFlowFixture({ targetPriceRub: null, mode: 'exact' }));
  const market = runSkuProfitModel(marketInputs), owner = runSkuProfitModel(inputs);
  for (const [original, changed] of [[market, inputs], [owner, marketInputs],
    [owner, { ...inputs, salesSelection: { ...inputs.salesSelection,
      ownerTargetPrice: { ...inputs.salesSelection.ownerTargetPrice, amountRub: 849 } } }]]) {
    const before = structuredClone(original.skuPackage);
    assert.throws(() => runSkuProfitModel({ ...changed, skuPackage: original.skuPackage }), /PROFIT_REPLAY_CONFLICT/);
    assert.deepEqual(original.skuPackage, before);
  }
  const replay = runSkuProfitModel({ ...inputs, skuPackage: owner.skuPackage });
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.skuPackage.profitModels, owner.skuPackage.profitModels);
});

test('B validates owner target identity and provenance before creating a profit version', async t => {
  forbidNetwork(t);
  const inputs = profitInputs(await ownerTargetFlowFixture({ mode: 'exact' }));
  for (const mutation of [target => { target.candidateId = 'another-candidate'; },
    target => { target.sourceRevision = -1; }, target => { target.sourceRevision += 1; },
    target => { target.evidenceRef = ''; }, target => { target.evidenceRef = 'synthetic:unrelated-owner-decision'; },
    target => { target.confirmedAt = '2026-08-19T00:00:00.000Z'; },
    target => { target.untrustedExtra = true; }]) {
    const changed = structuredClone(inputs);
    mutation(changed.salesSelection.ownerTargetPrice);
    assert.throws(() => runSkuProfitModel(changed), /B_INPUT_GAP|OWNER_TARGET/);
    assert.deepEqual(changed.skuPackage.profitModels, []);
  }
  const unbound = structuredClone(inputs);
  const event = unbound.opportunityPackage.audit.history.find(row => row.event === 'real_a_one_card_inputs_frozen');
  delete event.ownerTargetPrice;
  assert.throws(() => runSkuProfitModel(unbound), /B_INPUT_GAP|OWNER_TARGET/);
  assert.deepEqual(unbound.skuPackage.profitModels, []);
});

test('v4 profit survives the published schemas and both validators reject changed target or market input', async t => {
  forbidNetwork(t);
  const fixture = await ownerTargetFlowFixture();
  const result = runRealAConfirmationToBAndC1(fixture.args);
  const validator = await loadPublishedSchemaValidator();
  assert.equal(validator.validate('profit-model-v1.1.schema.json', result.profitModel), true, JSON.stringify(validator.errors));
  assert.deepEqual(validateProfitModel(result.profitModel), { valid: true, errors: [] });
  assert.equal(validateSkuLifecyclePackage(result.skuPackage).valid, true);
  for (const mutation of [model => { model.priceInputs.ownerTargetPrice.amountRub = 849; },
    model => { model.priceInputs.marketReferencePriceRub = 848; },
    model => { delete model.priceInputs; }, model => { model.priceInputs.ownerTargetPrice.evidenceRef = ''; },
    model => { model.calculation.version = 'profit-calculation-v3-cost-policy-snapshot'; },
    model => { delete model.calculation; }]) {
    const sku = structuredClone(result.skuPackage);
    mutation(sku.profitModels.at(-1));
    assert.equal(validateProfitModel(sku.profitModels.at(-1)).valid, false);
    assert.equal(validateSkuLifecyclePackage(sku).valid, false);
  }
});

for (const mode of ['exact', 'official_reference']) {
  test(`saved conditional B retains original owner 848 and its A provenance when recalculating with ${mode}`, async t => {
    forbidNetwork(t);
    const legacy = await createSavedConditionalBFixture();
    const fixture = await ownerTargetFlowFixture({ mode: 'estimated' });
    const original = runRealAConfirmationToBAndC1(fixture.args);
    assert.equal(original.profitModel.calculationType, 'conditional');
    assert.equal(original.profitModel.result, 'manual_review');
    assert.equal(original.c1Handoff, null);
    const saved = saveFlowResult(fixture.source, original);
    saved.executionRuntime = structuredClone(legacy.candidate.executionRuntime);
    saved.workflowStatus = legacy.candidate.workflowStatus;
    const document = structuredClone(legacy.document);
    document.candidates = [saved];
    if (mode === 'official_reference') document.evidencePacks[0] = officialCommissionPack(saved, 848);
    const repository = createMemoryBusinessStateRepository(document);
    const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'owner-price-recalculate',
      actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: legacy.at });
    const usecase = createBExactCommissionRecalculationUseCase({ repository, runtimeMode: 'local_development',
      serverClock: () => legacy.at });
    const input = { candidateId: saved.id, expectedRevision: saved.dataRevision,
      skuPackageId: original.skuPackage.skuPackageId, failureId: 'failure:b-exact',
      idempotencyKey: `synthetic:owner-price:${mode}`, auditEventId: `synthetic:audit:owner-price:${mode}` };
    if (mode === 'exact') {
      for (const receiptChange of [{ receiptId: 'synthetic:another-a-confirmation' },
        { confirmedAt: '2026-08-18T02:00:01.000Z' }]) {
        const changedDocument = structuredClone(document);
        Object.assign(changedDocument.candidates[0].lifecycleV11.aConfirmationReceipt, receiptChange);
        const changedRepository = createMemoryBusinessStateRepository(changedDocument);
        const changedUsecase = createBExactCommissionRecalculationUseCase({ repository: changedRepository,
          runtimeMode: 'local_development', serverClock: () => legacy.at });
        const before = await changedRepository.readSnapshot();
        await assert.rejects(() => changedUsecase.recalculate({ actor, input }), /B_EXACT_RECALCULATION_SOURCE_CONFLICT/);
        assert.deepEqual(await changedRepository.readSnapshot(), before);
      }
    }
    const response = await usecase.recalculate({ actor, input });
    assert.equal(response.status, 'committed');
    const after = await repository.readSnapshot(), life = after.candidates[0].lifecycleV11;
    const formal = life.skuPackage.profitModels.at(-1);
    assert.equal(formal.result, 'passed');
    assert.equal(formal.recommendedSalePriceRub, 848);
    assert.equal(formal.priceInputs.marketReferencePriceRub, 475);
    assert.deepEqual(formal.priceInputs.ownerTargetPrice, original.profitModel.priceInputs.ownerTargetPrice);
    assert.equal(formal.priceInputs.ownerTargetPrice.sourceRevision, fixture.source.dataRevision);
    assert.notEqual(formal.priceInputs.ownerTargetPrice.sourceRevision, saved.dataRevision);
    assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), original.skuPackage.profitModels);
    assert.deepEqual(life.opportunityPackage, original.opportunityPackage);
    assert.deepEqual(life.ownerSupplyConfirmation, original.ownerSupplyConfirmation);
    assert.equal(life.c1Handoffs.length, 1);
    assert.equal(life.skuPackage.productionAuthorization, null);
    assert.deepEqual(after.runtime.softwareJobs, []);
    assert.equal((await usecase.recalculate({ actor, input })).status, 'idempotent_replay');
    assert.deepEqual(await repository.readSnapshot(), after);
  });
}

test('a real v4 repricing result reaches the frozen final card with separate market, target and source references', async t => {
  forbidNetwork(t);
  const fixture = finalPricingC1ReuseFixture();
  fixture.input.selectedPriceRub = 2400;
  const initial = await fixture.repository.readSnapshot();
  await fixture.usecase.review({ actor: fixture.actor, input: fixture.input });
  const beforeCard = await fixture.repository.readSnapshot();
  const life = beforeCard.candidates[0].lifecycleV11, source = life.skuPackage;
  const model = source.profitModels.at(-1);
  assert.equal(model.calculation.version, 'profit-calculation-v4-owner-target-price');
  assert.equal(model.recommendedSalePriceRub, 2400);
  assert.equal(model.priceInputs.marketReferencePriceRub, 2000);
  assert.equal(model.priceInputs.ownerTargetPrice.amountRub, 2400);
  assert.equal(model.priceInputs.ownerTargetPrice.evidenceRef, source.finalPricingReview.assessment.assessmentId);
  assert.equal(life.opportunityPackage.marketAssessment.recommendedSalePrice.amount, 2000);
  assert.deepEqual(source.profitModels.slice(0, -1), initial.candidates[0].lifecycleV11.skuPackage.profitModels);
  assert.equal(source.businessPhase, 'C2');
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: fixture.observedAt });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: fixture.observedAt });
  const result = createFinalProductPlanConfirmationCard({ skuPackage: confirmed.skuPackage, createdAt: fixture.observedAt });
  assert.deepEqual(result.confirmationCard.profitResult.priceInputs.value, model.priceInputs);
  assert.deepEqual(result.confirmationCard.profitResult.priceInputs.sourceRefs,
    [model.profitModelVersion, ...model.marketSampleRefs, model.priceInputs.ownerTargetPrice.evidenceRef]);
  assert.equal(result.confirmationCard.profitResult.recommendedSalePrice.value.rub, 2400);
  assert.deepEqual(result.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.activeProfitModel.priceInputs,
    model.priceInputs);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.confirmationCard.productionBoundary.platformWrites, 0);
  const validator = await loadPublishedSchemaValidator();
  const validate = validator.getSchema('product-lifecycle-v1.1');
  assert.equal(validate(result.skuPackage), true, JSON.stringify(validate.errors));
  assert.deepEqual(await fixture.repository.readSnapshot(), beforeCard);
});
