import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { prepareOwnerProductFacts, OWNER_PRODUCT_FACT_LABELS } from '../lib/owner-product-facts.mjs';
import { createC1SiblingSharedFactRevision, resolveC1SiblingSharedFactRevision } from '../lib/c1-sibling-shared-facts.mjs';
import { verifyC1ProductFacts, assertValidC1ProductPlan } from '../lib/c1-product-plan.mjs';
import { resolveC1SupplierFactRevision } from '../lib/confirmed-supplier-inputs.mjs';
import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS } from './fixtures/c1-sku-rights-review-fixture.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { projectC1SiblingNeutralDraft } from '../lib/c1-sibling-neutral-copy.mjs';
import { createC2SoftwareContainer } from '../lib/c2-software-orchestrator.mjs';
import { oneColorFixture } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { previewSiblingBatchC1Preparation, commitSiblingBatchC1Preparation } from '../lib/sibling-batch-c1-preparation.mjs';

const at = '2026-08-12T13:00:00.000Z', captureId = 'capture:shared-family', offerId = '712421624571';
const ownerFacts = { productForm: '迷你背心', intendedUses: ['猫', '酒瓶'], closureType: '魔术贴', adjustable: true, detachable: null };

function fixture() {
  const source = createFormalC1DraftFixture({ candidateId: 'candidate:shared-parent', supplierSkuId: 'sku:shared-parent',
    variantKey: '颜色:卡其色', sourceOfferId: offerId, captureId,
    skuAttributes: { quantityOneEvidence: { captureId }, 颜色: '卡其色', 适合季节: '四季', 适用性别: '中性' } });
  const target = createFormalC1DraftFixture({ candidateId: 'candidate:shared-child', supplierSkuId: 'sku:shared-child',
    variantKey: '颜色:黑色', sourceOfferId: offerId, captureId,
    skuAttributes: { quantityOneEvidence: { captureId }, 颜色: '黑色' } });
  const merged = mergeC1AiDraftReceipt({ skuPackage: source.checked.skuPackage, request: source.request,
    receipt: source.receipt, settledExecution: source.settledExecution, mergedAt: at });
  let parent = { ...structuredClone(source.candidate), lifecycleV11: { skuPackage: structuredClone(merged.skuPackage) } };
  parent = prepareOwnerProductFacts({ candidate: parent, facts: ownerFacts, confirmedByUserId: 'owner:source', confirmedAt: at }).candidate;
  const plan = parent.lifecycleV11.skuPackage.c1ProductPlan;
  const declaration = parent.lifecycleV11.ownerProductFactsV1;
  plan.productAttributes.ownerDeclaredFacts = Object.entries(ownerFacts).filter(([, value]) => value !== null).map(([fieldKey, value]) => ({
    fieldKey, label: OWNER_PRODUCT_FACT_LABELS[fieldKey], fact: { value, verificationStatus: 'confirmed', reason: null,
      sourceRefs: [`${declaration.declarationId}#/facts/${fieldKey}`] } }));
  const paths = plan.productAttributes.ownerDeclaredFacts.map((_, index) => `productAttributes.ownerDeclaredFacts.${index}.fact`);
  for (const key of ['适合季节', '适用性别']) paths.push(`productAttributes.supplierAttributes.${plan.productAttributes.supplierAttributes.findIndex(row => row.fieldKey === key)}.fact`);
  plan.seoTitleDraft.factRefs.push(...paths);
  parent.sourceCapture = { captureId, offerId, selectedSkuIds: ['sku:shared-parent', 'sku:shared-child'],
    supplierAttributes: { 颜色: '卡其色,黑色', 适合季节: '四季', 适用性别: '中性' } };
  const candidate = { ...structuredClone(target.candidate), siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: 'sku:shared-child' },
    sourceCapture: { captureId, offerId, supplierAttributes: structuredClone(parent.sourceCapture.supplierAttributes) },
    lifecycleV11: { skuPackage: structuredClone(target.created.skuPackage) } };
  return { parent, candidate };
}

function prepared() {
  const state = fixture(), plan = state.candidate.lifecycleV11.skuPackage.c1ProductPlan;
  const record = createC1SiblingSharedFactRevision({ ...state, confirmedByUserId: 'owner:batch', preparedAt: at });
  plan.sourceFactsRevision = record;
  return { ...state, record, plan, identity: state.candidate.lifecycleV11.skuPackage.g1Identity };
}

test('shared family facts retain the original parent declaration and child identity without copying owner approval', async () => {
  const { parent, candidate } = fixture(), before = structuredClone({ parent, candidate });
  const record = createC1SiblingSharedFactRevision({ parent, candidate, confirmedByUserId: 'owner:batch', preparedAt: at });
  assert.deepEqual({ parent, candidate }, before);
  assert.equal(record.source.identity.candidateId, parent.id);
  assert.equal(record.sourceIdentity.candidateId, candidate.id);
  assert.deepEqual(record.sourceOwnerDeclaration, parent.lifecycleV11.ownerProductFactsV1);
  assert.equal(record.sourceOwnerDeclaration.confirmedByUserId, 'owner:source');
  assert.equal(record.ownerConfirmation.confirmedByUserId, 'owner:batch');
  assert.equal(record.ownerConfirmation.productionAuthorized, false);
  assert.deepEqual(record.ownerConfirmation.adoptedSupplierFieldKeys, ['适合季节', '适用性别']);
  assert.equal(record.ownerConfirmation.adoptedOwnerFieldKeys.includes('detachable'), false);
  candidate.lifecycleV11.skuPackage.c1ProductPlan.sourceFactsRevision = record;
  const sku = candidate.lifecycleV11.skuPackage;
  const rights = syntheticSkuRightsReview({ plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity, reviewedAt: at,
    brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS });
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights, verifiedAt: at });
  assertValidC1ProductPlan(checked.c1ProductPlan);
  assert.equal(checked.c1ProductPlan.productAttributes.supplierAttributes.find(row => row.fieldKey === '颜色').fact.value, '黑色');
  for (const row of checked.c1ProductPlan.productAttributes.ownerDeclaredFacts) {
    assert.deepEqual(row.fact.value, ownerFacts[row.fieldKey]);
    assert.ok(row.fact.sourceRefs.includes(`${record.revisionId}#/ownerConfirmation`));
    assert.ok(row.fact.sourceRefs.includes(`${record.sourceOwnerDeclaration.declarationId}#/facts/${row.fieldKey}`));
  }
  assert.equal(Object.hasOwn(candidate.lifecycleV11, 'ownerProductFactsV1'), false);
  for (const key of ['salesSnapshot', 'confirmedSupplierSkuSnapshot', 'profitModel', 'platformSchemaRules']) {
    assert.deepEqual(checked.c1ProductPlan.inputSnapshots[key], before.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots[key]);
  }
  assert.deepEqual(checked.c1ProductPlan.inputSnapshots.skuRightsReview, rights);
  const validator = (await loadPublishedSchemaValidator()).getSchema('c1-product-plan-v1.1');
  assert.equal(validator(checked.c1ProductPlan), true, JSON.stringify(validator.errors));
  for (const change of [record => { record.ownerConfirmation.status = 'pending'; },
    record => { record.unreviewedFields = ['detachable']; }]) {
    const invalid = structuredClone(checked.c1ProductPlan); change(invalid.sourceFactsRevision);
    assert.equal(validator(invalid), false);
  }
});

test('shared facts reject foreign family, capture, source declaration, target SKU, and store without changing inputs', () => {
  for (const change of [
    state => { state.candidate.siblingSourceV1.parentCandidateId = 'candidate:other'; },
    state => { state.candidate.sourceCapture.captureId = 'capture:other'; },
    state => { state.parent.sourceCapture.selectedSkuIds = ['sku:shared-parent']; },
    state => { state.candidate.storeRef.platformStoreId = 'other-store'; },
    state => { state.candidate.sourceCapture.supplierAttributes.适合季节 = '夏季'; },
    state => { delete state.parent.lifecycleV11.ownerProductFactsV1; }
  ]) {
    const state = fixture(); change(state); const before = structuredClone(state);
    assert.throws(() => createC1SiblingSharedFactRevision({ ...state, confirmedByUserId: 'owner:batch', preparedAt: at }), /C1_SIBLING_SHARED_/);
    assert.deepEqual(state, before);
  }
});

test('saved shared facts reject missing confirmation, altered scope, unreviewed fields and source corruption', () => {
  for (const change of [
    state => { state.record.ownerConfirmation.status = 'pending'; },
    state => { state.record.ownerConfirmation.confirmedByUserId = ''; },
    state => { state.record.ownerConfirmation.sourceCandidateRevision++; },
    state => { state.record.targetSkuRevision++; },
    state => { state.record.ownerConfirmation.productionAuthorized = true; },
    state => { state.record.sourceIdentity.supplierSkuId = 'sku:other'; },
    state => { state.record.source.identity.storeRef.platformStoreId = 'other-store'; },
    state => { state.record.sourceOwnerDeclaration.sourceIdentity.candidateId = 'candidate:other'; },
    state => { state.record.family.offerId = 'other-offer'; },
    state => { state.record.family.captureId = 'capture:other'; },
    state => { state.record.ownerConfirmation.adoptedOwnerFieldKeys.push('detachable'); },
    state => { state.record.supplierFacts[0].fieldKey = '颜色'; },
    state => { state.record.supplierFacts[0].sourceRefs = ['source:unrelated']; },
    state => { state.record.supplierFacts[0] = null; },
    state => { state.record.sourceOwnerDeclaration.facts.adjustable = 'yes'; },
    state => { state.plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.适合季节 = '夏季'; }
  ]) {
    const state = prepared(); change(state);
    assert.throws(() => resolveC1SupplierFactRevision({ plan: state.plan, sourceIdentity: state.identity }), /C1_SIBLING_SHARED_/);
  }
});

test('source-derived fact references resolve to stored records and altered projections are rejected', () => {
  const state = prepared();
  const projected = resolveC1SiblingSharedFactRevision({ plan: state.plan, sourceIdentity: state.identity });
  assert.equal(projected.attributeSources.适合季节, `${state.record.revisionId}#/supplierFacts/0`);
  assert.equal(state.record.supplierFacts[0].fieldKey, '适合季节');
  const sku = state.candidate.lifecycleV11.skuPackage;
  const rights = syntheticSkuRightsReview({ plan: state.plan, sourceIdentity: state.identity, reviewedAt: at,
    brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS });
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: rights, verifiedAt: at });
  const changed = structuredClone(checked.c1ProductPlan);
  changed.productAttributes.ownerDeclaredFacts[0].fact.value = false;
  assert.throws(() => assertValidC1ProductPlan(changed), /C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED/);
});

test('saved same-capture facts pass the normal fact, formal-copy and C2 contracts with zero external calls', t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Unexpected external request'); });
  const source = createFormalC1DraftFixture({ candidateId: 'candidate:captured-parent', supplierSkuId: 'sku:captured-parent',
    sourceOfferId: offerId, captureId, variantKey: '颜色:卡其色',
    skuAttributes: { quantityOneEvidence: { captureId }, 颜色: '卡其色', piece_count: 8 } });
  const target = createFormalC1DraftFixture({ candidateId: 'candidate:captured-child', supplierSkuId: 'sku:captured-child',
    sourceOfferId: offerId, captureId, variantKey: '颜色:黑色',
    skuAttributes: { quantityOneEvidence: { captureId }, 颜色: '黑色' } });
  const merged = mergeC1AiDraftReceipt({ skuPackage: source.checked.skuPackage, request: source.request,
    receipt: source.receipt, settledExecution: source.settledExecution, mergedAt: at });
  const parent = { ...structuredClone(source.candidate), sourceCapture: { captureId, offerId,
    selectedSkuIds: ['sku:captured-parent', 'sku:captured-child'], supplierAttributes: { piece_count: 8 } },
    lifecycleV11: { skuPackage: merged.skuPackage } };
  const candidate = { ...structuredClone(target.candidate),
    sourceCapture: { captureId, offerId, supplierAttributes: { piece_count: 8 } },
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: 'sku:captured-child' },
    lifecycleV11: { skuPackage: structuredClone(target.created.skuPackage) } };
  const before = structuredClone(parent);
  const sku = candidate.lifecycleV11.skuPackage;
  sku.c1ProductPlan.sourceFactsRevision = createC1SiblingSharedFactRevision({ parent, candidate,
    confirmedByUserId: 'owner:batch', preparedAt: at });
  const checked = verifyC1ProductFacts({ skuPackage: sku,
    skuRightsReview: target.checked.c1ProductPlan.inputSnapshots.skuRightsReview, verifiedAt: at });
  const reused = projectC1SiblingNeutralDraft({ sourcePlan: merged.c1ProductPlan, sourceIdentity: merged.skuPackage.g1Identity,
    request: source.request, receipt: source.receipt, settledExecution: source.settledExecution,
    targetSkuPackage: checked.skuPackage, sourceCandidateRevision: parent.dataRevision,
    targetCandidateRevision: candidate.dataRevision, observedAt: at });
  const c2 = createC2SoftwareContainer({ skuPackage: reused.skuPackage, expectedDataRevision: reused.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: at });
  assert.equal(c2.skuPackage.businessPhase, 'C2');
  assert.equal(c2.skuPackage.c2FinalAssets.status, 'awaiting_final_uploads');
  assert.equal(c2.skuPackage.productionAuthorization, null);
  assert.equal(c2.skuPackage.c1ProductPlan.identity.supplierSkuId, 'sku:captured-child');
  assert.equal(c2.skuPackage.c1ProductPlan.productAttributes.supplierAttributes.find(row => row.fieldKey === 'piece_count').fact.value, 8);
  assert.deepEqual(parent, before);
  assert.equal(requests, 0);
});

test('batch preview remains read-only and neither an unconfirmed nor non-human submission saves C1 facts', async () => {
  const { repository, actor, input } = await oneColorFixture();
  const before = await repository.readSnapshot();
  const previewInput = { ...input, confirmed: false };
  const preview = previewSiblingBatchC1Preparation({ document: before, actor, input: previewInput, serverClock: () => at });
  assert.equal(preview.members.length, 1);
  assert.deepEqual(await repository.readSnapshot(), before);
  await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor,
    input: previewInput, serverClock: () => at }), /SIBLING_BATCH_C1_INPUT_INVALID/);
  await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor: { ...actor, actorType: 'software' }, input, serverClock: () => at }), /SIBLING_BATCH_C1_INPUT_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});
