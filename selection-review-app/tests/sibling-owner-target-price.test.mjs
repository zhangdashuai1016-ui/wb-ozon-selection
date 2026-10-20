import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { commitSiblingBatchABAndC1 } from '../lib/sibling-batch-a-b-c1.mjs';
import { parentCardBinding } from '../lib/sibling-sku-card-guard.mjs';
import { currentCostRule, evidencePacks } from './fixtures/real-a-b-flow-fixture.mjs';
import { confirmedAt, officialCommissionPack, ownerTargetFlowFixture } from './fixtures/owner-target-price-regression-fixture.mjs';

const category = 'ozon:17028966:96063';
const guooFilePath = '/synthetic/owner-target/GUOO-2026.7.20.xlsx';

function forbidNetwork(t) {
  const tripwires = [
    t.mock.method(globalThis, 'fetch', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST')),
    t.mock.method(http, 'request', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST')),
    t.mock.method(https, 'request', () => assert.fail('UNEXPECTED_EXTERNAL_REQUEST'))
  ];
  t.after(() => { for (const tripwire of tripwires) assert.equal(tripwire.mock.callCount(), 0); });
}


/** Only the accepted historical parent card is synthetic; all three new A/B/C1 results use real domain code. */
async function fixture() {
  const { source } = await ownerTargetFlowFixture();
  source.lifecycleEvidenceContextV11.category = category;
  const parent = structuredClone(source);
  parent.id = 'candidate:owner-price-parent';
  const assets = [{ sha256: 'a'.repeat(64) }];
  parent.lifecycleV11 = { skuPackage: { supplierSkuId: '6222816678021', skuPackageId: 'sku:owner-price-parent',
    g1Identity: { candidateId: parent.id, skuPackageId: 'sku:owner-price-parent', supplierSkuId: '6222816678021',
      platform: parent.targetPlatform, storeRef: structuredClone(parent.storeRef) }, technicalStatus: 'unknown_outcome',
    productionAuthorization: { lockedScope: { supplierSkuId: '6222816678021', finalUploads: assets } },
    c2FinalAssets: { productionAuthorizationPreparation: { finalUploads: assets } },
    dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received', taskId: 'synthetic-parent-existing-import' }],
      attempt: { request: { productImport: { body: { items: [{ description_category_id: 17028966, type_id: 96063,
        attributes: [{ id: 9048, values: [{ value: 'SYNTHETIC-PRICE-FAMILY' }] },
          { id: 85, values: [{ value: 'Нет бренда' }] }] }] } } } } } } };
  const skuIds = ['6222816678023', '6222816678020', '6222816678019'];
  const colors = ['黑cp', 'CP', '黑色'];
  parent.sourceCapture = { captureId: 'synthetic:owner-target-capture', mode: 'a_supplier_capture',
    status: 'captured_waiting_owner_selection', sourceUrl: source.sourceCapture.sourceUrl,
    offerId: source.sourceCapture.offerId, observedAt: confirmedAt,
    selectedSkuIds: ['6222816678021', ...skuIds],
    skuChoices: skuIds.map((sourceSkuId, index) => ({ sourceSkuId, variantName: colors[index],
      attributes: { 颜色: colors[index] }, priceCny: null, weight: null })) };
  const children = skuIds.map((sourceSkuId, index) => {
    const child = structuredClone(source);
    child.id = `candidate:owner-target-color-${index}`;
    child.siblingSourceV1 = { parentCandidateId: parent.id, parentRevision: parent.dataRevision, supplierSkuId: sourceSkuId,
      parentCardBinding: parentCardBinding(parent.lifecycleV11.skuPackage) };
    child.sourceCapture = { ...structuredClone(parent.sourceCapture), selectedSkuIds: [],
      skuChoices: [structuredClone(parent.sourceCapture.skuChoices[index])] };
    return child;
  });
  const targets = [848, 900, 950];
  const document = initialBusinessStateDocument({ now: confirmedAt });
  document.candidates = [parent, ...children];
  document.evidencePacks = evidencePacks().filter(pack => pack.kind !== 'commission');
  document.evidencePacks.find(pack => pack.kind === 'schema').scope.category = category;
  const commissionScope = { ...evidencePacks()[0].scope, category };
  document.evidencePacks.push(...children.map((child, index) => officialCommissionPack(child, targets[index], { scope: commissionScope })));
  document.rules.ozonDandanshu = currentCostRule(children[0]);
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    shared: { salesReview: { snapshotId: source.salesSnapshotsV11[0].snapshotId,
      comparability: 'comparable', validityStatus: 'current', confidence: 'limited' },
    targetSalePriceRub: 848, unitDomesticFreight: 2, otherPurchaseCosts: 0, packagingCostRmb: 1.5,
    route: 'guoo-economy-small', confirmExactSkuSupply: true, confirmSalesReview: true,
    minimumOrderQuantity: 1, quantityOneEvidenceSourceNote: 'Synthetic owner checked the exact quantity-one variant quotes.',
    dimensionsCm: { length: 12, width: 12, height: 7 } },
    members: children.map((child, index) => ({ candidateId: child.id, candidateRevision: child.dataRevision,
      sourceSkuId: skuIds[index], unitProductPrice: 15.3 + index, weightKg: 0.4,
      merchantSku: `SYNTHETIC-PRICE-COLOR-${index}`, stock: 20 + index,
      targetSalePriceRub: index === 0 ? null : targets[index] })) };
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'owner-target-batch', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: confirmedAt });
  return { repository: createMemoryBusinessStateRepository(document), input, actor, targets,
    runtimeMode: 'local_development', serverClock: () => confirmedAt, guooFilePath };
}

test('three real A/B/C1 branches use each submitted target and its own official fee binding without altering market or parent', async t => {
  forbidNetwork(t);
  const f = await fixture(), before = await f.repository.readSnapshot();
  const result = await commitSiblingBatchABAndC1(f);
  const after = await f.repository.readSnapshot();
  assert.equal(result.members.length, 3);
  assert.equal(new Set(result.members.map(member => member.c1HandoffId)).size, 3);
  assert.deepEqual(after.candidates[0], before.candidates[0]);
  assert.deepEqual(after.evidencePacks, before.evidencePacks);
  for (const [index, child] of after.candidates.slice(1).entries()) {
    const life = child.lifecycleV11, model = life.skuPackage.profitModels.at(-1), target = f.targets[index];
    assert.equal(model.result, 'passed');
    assert.equal(model.recommendedSalePriceRub, target);
    assert.equal(model.priceInputs.marketReferencePriceRub, 475);
    assert.equal(model.priceInputs.ownerTargetPrice.amountRub, target);
    assert.equal(model.priceInputs.ownerTargetPrice.candidateId, child.id);
    assert.equal(model.priceInputs.ownerTargetPrice.sourceRevision, before.candidates[index + 1].dataRevision);
    assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.officialCommissionBinding.priceRub, target);
    assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.officialCommissionBinding.candidateId, child.id);
    assert.equal(model.unitProfitRmb, Number((target / 12 * 0.81 - (38.3 + index)).toFixed(2)));
    assert.equal(life.opportunityPackage.marketAssessment.recommendedSalePrice.amount, 475);
    assert.deepEqual(child.salesSnapshotsV11, before.candidates[index + 1].salesSnapshotsV11);
    assert.deepEqual(life.opportunityPackage.salesSnapshots, before.candidates[index + 1].salesSnapshotsV11);
    assert.equal(model.marketFit.marketReferencePriceCny, 39.58);
    assert.equal(life.skuPackage.profitModels.length, 1);
    assert.equal(life.c1Handoffs.length, 1);
    assert.equal(life.skuPackage.businessPhase, 'C1');
    assert.equal(life.skuPackage.productionAuthorization, null);
    assert.equal(life.platformWrites, 0);
  }
  assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.externalRequests, 0);
});

test('a third-member fee price mismatch keeps every lifecycle, parent and saved evidence unchanged', async t => {
  forbidNetwork(t);
  const f = await fixture();
  f.input.members[2].targetSalePriceRub = 951;
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchABAndC1(f), /SYSTEM_EVIDENCE_GAP|B_COMMISSION|B_INPUT_GAP/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.equal(before.candidates.slice(1).every(child => child.lifecycleV11 === undefined), true);
});

test('a real third-member loss saves its exact v4 conclusion while no color advances to C1 or production', async t => {
  forbidNetwork(t);
  const f = await fixture();
  f.input.members[2].targetSalePriceRub = 475;
  await f.repository.transact(document => {
    const child = document.candidates[3];
    const old = document.evidencePacks.find(pack => pack.kind === 'commission' &&
      pack.evidenceData.officialCommissionBinding.candidateId === child.id);
    document.evidencePacks = document.evidencePacks.map(pack => pack === old
      ? officialCommissionPack(child, 475, { scope: old.scope }) : pack);
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot();
  const result = await commitSiblingBatchABAndC1(f);
  const after = await f.repository.readSnapshot();
  const child = after.candidates[3], original = before.candidates[3];
  assert.equal(result.status, 'b_not_passed');
  assert.equal(result.passedMembers, 2);
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].candidateId, original.id);
  assert.equal(result.members[0].supplierSkuId, f.input.members[2].sourceSkuId);
  assert.equal(result.members[0].result, 'rejected');
  assert.equal(result.members[0].resultRevision, original.dataRevision + 1);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.externalRequests, 0);
  assert.equal(child.siblingBatchBAttemptsV1.length, 1);
  const attempt = child.siblingBatchBAttemptsV1[0], model = attempt.profitModel;
  assert.equal(attempt.schemaVersion, 'sibling-batch-b-attempt-v1');
  assert.equal(attempt.parentCandidateId, before.candidates[0].id);
  assert.equal(attempt.parentRevision, before.candidates[0].dataRevision);
  assert.equal(attempt.sourceRevision, original.dataRevision);
  assert.equal(attempt.recordedAt, confirmedAt);
  assert.equal(attempt.recordedBy, f.actor.userId);
  assert.equal(attempt.result, 'rejected');
  assert.equal(attempt.platformWrites, 0);
  assert.equal(model.result, 'rejected');
  assert.equal(model.calculation.version, 'profit-calculation-v4-owner-target-price');
  assert.equal(model.recommendedSalePriceRub, 475);
  assert.equal(model.priceInputs.marketReferencePriceRub, 475);
  assert.equal(model.priceInputs.ownerTargetPrice.amountRub, 475);
  assert.equal(model.priceInputs.ownerTargetPrice.candidateId, original.id);
  assert.equal(model.priceInputs.ownerTargetPrice.sourceRevision, original.dataRevision);
  assert.ok(model.unitProfitRmb < 0);
  assert.equal(result.members[0].unitProfitRmb, model.unitProfitRmb);
  assert.equal(result.members[0].profitMargin, model.profitMargin);
  assert.equal(child.dataRevision, original.dataRevision + 1);
  assert.equal(child.updatedAt, confirmedAt);
  assert.equal(child.lastModifiedBy, f.actor.userId);
  const unchangedChild = structuredClone(child), expectedChild = structuredClone(original);
  for (const key of ['siblingBatchBAttemptsV1', 'dataRevision', 'updatedAt', 'lastModifiedBy']) {
    delete unchangedChild[key];
    delete expectedChild[key];
  }
  assert.deepEqual(unchangedChild, expectedChild);
  assert.deepEqual(after.candidates.slice(0, 3), before.candidates.slice(0, 3));
  assert.equal(after.candidates.slice(1).every(item => item.lifecycleV11 === undefined), true,
    'failed and passing colors have no C1 handoff or production authorization');
  assert.deepEqual({ ...after, candidates: [] }, { ...before, candidates: [] },
    'no evidence, software job, permit or other shared state changes');
});

test('concurrent duplicate batch submissions create only one independent profit and C1 record per color', async t => {
  forbidNetwork(t);
  const f = await fixture();
  const before = await f.repository.readSnapshot();
  const results = await Promise.allSettled([commitSiblingBatchABAndC1(f), commitSiblingBatchABAndC1(f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.match(rejected.reason.message, /SIBLING_BATCH_A_MEMBER_CONFLICT/);
  const saved = await f.repository.readSnapshot();
  for (const child of saved.candidates.slice(1)) {
    assert.equal(child.lifecycleV11.skuPackage.profitModels.length, 1);
    assert.equal(child.lifecycleV11.c1Handoffs.length, 1);
    assert.equal(child.lifecycleV11.skuPackage.productionAuthorization, null);
  }
  assert.deepEqual(saved.runtime.softwareJobs, before.runtime.softwareJobs);
});
