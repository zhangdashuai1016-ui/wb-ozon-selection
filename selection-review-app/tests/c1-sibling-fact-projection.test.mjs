import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { projectC1SiblingNeutralDraft, mapC1SiblingFactPath, assertC1SiblingSchemaCompatibility,
  assertC1SiblingNeutralReuse } from '../lib/c1-sibling-neutral-copy.mjs';

const at = '2026-08-12T13:00:00.000Z';
const fact = value => ({ value, verificationStatus: 'confirmed', sourceRefs: ['source:saved'], reason: null });

test('neutral content uses stable supplier field keys after target attribute reordering', () => {
  const source = createFormalC1DraftFixture({ candidateId: 'candidate:source', supplierSkuId: 'sku:source',
    variantKey: '颜色:卡其色', skuAttributes: { 颜色: '卡其色', piece_count: 8 } });
  const target = createFormalC1DraftFixture({ candidateId: 'candidate:target', supplierSkuId: 'sku:target',
    variantKey: '颜色:黑色', skuAttributes: { piece_count: 8, 颜色: '黑色' } });
  const merged = mergeC1AiDraftReceipt({ skuPackage: source.checked.skuPackage, request: source.request,
    receipt: source.receipt, settledExecution: source.settledExecution, mergedAt: at });
  const sourcePlan = merged.skuPackage.c1ProductPlan, before = structuredClone(sourcePlan);
  const targetBefore = structuredClone(target.checked.skuPackage);
  const result = projectC1SiblingNeutralDraft({ sourcePlan, sourceIdentity: merged.skuPackage.g1Identity,
    request: source.request, receipt: source.receipt, settledExecution: source.settledExecution,
    targetSkuPackage: target.checked.skuPackage, sourceCandidateRevision: 27, targetCandidateRevision: 28, observedAt: at });
  const sourcePath = sourcePlan.seoTitleDraft.factRefs.find(path => path.includes('supplierAttributes'));
  const targetPath = result.content.seoTitleDraft.factRefs.find(path => path.includes('supplierAttributes'));
  assert.notEqual(sourcePath, targetPath);
  assert.equal(result.skuPackage.c1ProductPlan.productAttributes.supplierAttributes[Number(targetPath.split('.')[2])].fieldKey, 'piece_count');
  for (const piece of [result.content.seoTitleDraft, result.content.descriptionDraft, ...result.content.bulletPointsDraft,
    ...result.content.searchKeywordsDraft.keywords]) {
    assert.equal(piece.factRefs.includes(targetPath), true);
    assert.equal(piece.assertions.find(item => item.factPath === targetPath).value, 8);
  }
  assertC1SiblingNeutralReuse({ plan: result.skuPackage.c1ProductPlan, resultSkuRevision: result.skuPackage.dataRevision });
  assert.deepEqual(sourcePlan, before);
  assert.deepEqual(target.checked.skuPackage, targetBefore);
});

test('stable fact mapping covers owner facts and official attributes and rejects duplicate, missing or conflicting keys', () => {
  const sourcePlan = { productAttributes: { ownerDeclaredFacts: [{ fieldKey: 'productForm', fact: fact('迷你背心') },
    { fieldKey: 'adjustable', fact: fact(true) }], ozonAttributes: [{ fieldKey: '4967', fact: fact({ value: 'Оксфорд', dictionaryValueId: 61979 }) }] } };
  const targetPlan = structuredClone(sourcePlan);
  targetPlan.productAttributes.ownerDeclaredFacts.reverse();
  targetPlan.productAttributes.ozonAttributes.unshift({ fieldKey: '10096', fact: fact({ value: 'черный', dictionaryValueId: 2 }) });
  assert.equal(mapC1SiblingFactPath({ sourcePlan, targetPlan, sourceFactPath: 'productAttributes.ownerDeclaredFacts.0.fact' }), 'productAttributes.ownerDeclaredFacts.1.fact');
  assert.equal(mapC1SiblingFactPath({ sourcePlan, targetPlan, sourceFactPath: 'productAttributes.ozonAttributes.0.fact' }), 'productAttributes.ozonAttributes.1.fact');
  for (const change of [
    plan => { plan.productAttributes.ownerDeclaredFacts.push(structuredClone(plan.productAttributes.ownerDeclaredFacts[1])); },
    plan => { plan.productAttributes.ownerDeclaredFacts.pop(); },
    plan => { plan.productAttributes.ownerDeclaredFacts[1].fact.value = '其他商品'; },
    plan => { plan.productAttributes.ownerDeclaredFacts[1].fact.verificationStatus = 'unknown'; }
  ]) {
    const changed = structuredClone(targetPlan); change(changed);
    assert.throws(() => mapC1SiblingFactPath({ sourcePlan, targetPlan: changed,
      sourceFactPath: 'productAttributes.ownerDeclaredFacts.0.fact' }), /C1_SIBLING_NEUTRAL_FACT_/);
  }
});

test('schema refresh accepts evidence and ordering changes but rejects changed adopted field semantics or scope', () => {
  const sourcePlan = { inputSnapshots: { platformSchemaRules: { platform: 'ozon', store: 'miska',
    storeRef: { stableStoreId: 'miska', platformStoreId: '3852479', mappingVersion: 'store:v1' },
    categoryName: 'Одежда для животных', descriptionCategoryId: '17028966', typeId: '96063',
    schemaRevision: 'schema:old', evidenceId: 'evidence:old',
    attributes: [{ fieldKey: '4967', type: 'String', dictionaryId: 1503, isCollection: false, complexId: 0 },
      { fieldKey: '10096', dictionaryId: 1, isCollection: true }],
    requiredFields: [{ fieldKey: '4967', required: true }] } } };
  const targetPlan = structuredClone(sourcePlan), schema = targetPlan.inputSnapshots.platformSchemaRules;
  schema.evidenceId = 'evidence:new'; schema.schemaRevision = 'schema:new'; schema.attributes.reverse();
  schema.attributes[0].dictionaryId = 7;
  assertC1SiblingSchemaCompatibility({ sourcePlan, targetPlan, attributeIds: ['4967'] });
  for (const change of [
    value => { value.storeRef.platformStoreId = 'other'; },
    value => { value.descriptionCategoryId = 'other'; },
    value => { value.typeId = 'other'; },
    value => { value.attributes[1].dictionaryId = 2; },
    value => { value.attributes[1].type = 'Integer'; },
    value => { value.attributes[1].isCollection = true; },
    value => { value.attributes[1].complexId = 3; },
    value => { value.requiredFields[0].required = false; },
    value => { value.attributes.push(structuredClone(value.attributes[1])); }
  ]) {
    const changed = structuredClone(targetPlan); change(changed.inputSnapshots.platformSchemaRules);
    assert.throws(() => assertC1SiblingSchemaCompatibility({ sourcePlan, targetPlan: changed, attributeIds: ['4967'] }),
      /C1_SIBLING_NEUTRAL_(SCOPE_DIFFERENCE|SCHEMA_FIELD_CHANGED)/);
  }
});
