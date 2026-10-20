import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { TERRA_AUXILIARY_DRAFT_VERSION, SALES_AUXILIARY_OUTPUT_SCHEMA, isSalesAuxiliaryAttributeHint } from '../lib/sales-snapshot.mjs';
import { C2_REFERENCE_SEMANTICS, collectCanonicalC2ReferenceErrors, assertNoProductionSecrets,
  fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

const evidenceRef = 'evidence:sales:current';
const paths = C2_REFERENCE_SEMANTICS.c1SalesAuxiliaryLabelPaths;
function fixture(leafPath = paths[0], label = '商品标题') {
  const row = { field: '标题', value: '宠物背心', evidenceRef: label };
  const draft = { schemaVersion: TERRA_AUXILIARY_DRAFT_VERSION, provider: 'terra', status: 'draft',
    authoritative: false, mayOverrideObservedFields: false, publicTextEvidenceRefs: [evidenceRef],
    output: { summary: '仅辅助说明', comparabilitySignals: [], attributeHints: [row] } };
  const snapshot = { evidenceRef, attributes: { 'Вид одежды': 'Жилет' }, auxiliaryDrafts: [draft] };
  const root = {};
  let node = root;
  const prefix = leafPath.slice(0, -6);
  for (const [index, segment] of prefix.entries()) {
    node[segment] = index === prefix.length - 1 ? snapshot : {};
    node = node[segment];
  }
  return { root, snapshot, draft, row };
}

test('v1 auxiliary field explanations remain ordinary text in each declared frozen container', () => {
  for (const path of paths) for (const label of ['商品标题', 'Ozon bank price', 'Вид одежды', '从已采集标题判断适用对象']) {
    const { root } = fixture(path, label);
    const before = JSON.stringify(root), fingerprint = fingerprintCanonicalRecord(root);
    assert.deepEqual(collectCanonicalC2ReferenceErrors(root), [], JSON.stringify(path));
    assert.doesNotThrow(() => assertNoProductionSecrets(root));
    assert.equal(JSON.stringify(root), before);
    assert.equal(fingerprintCanonicalRecord(root), fingerprint);
  }
});

test('ordinary references and undeclared containers retain canonical requirements', () => {
  const { root } = fixture();
  for (const document of [{ evidenceRef: '商品标题' }, { sourceRef: '商品标题' }, { assetRef: '商品标题' },
    { unknown: root }, { inputSnapshots: { salesSnapshot: fixture().snapshot } }]) {
    assert.ok(collectCanonicalC2ReferenceErrors(document).length > 0);
  }
});

test('auxiliary text requires the actual v1 draft role and does not upgrade authoritative facts', () => {
  for (const [key, value] of [['schemaVersion', 'unknown-v2'], ['provider', 'other'], ['status', 'confirmed'],
    ['authoritative', true], ['authoritative', undefined], ['mayOverrideObservedFields', true]]) {
    const { root, draft } = fixture();
    draft[key] = value;
    assert.ok(collectCanonicalC2ReferenceErrors(root).length > 0, key);
  }
});

test('the actual public evidence stays canonical and attached to the frozen sales snapshot', () => {
  for (const refs of [[], ['evidence:sales:other'], [evidenceRef, '商品标题'], null]) {
    const { root, draft } = fixture();
    draft.publicTextEvidenceRefs = refs;
    assert.ok(collectCanonicalC2ReferenceErrors(root).length > 0);
  }
  const { root, snapshot } = fixture();
  snapshot.evidenceRef = '商品标题';
  assert.ok(collectCanonicalC2ReferenceErrors(root).length > 0);
});

test('fake arrays, duplicate row ownership and misnamed hint containers cannot obtain text semantics', () => {
  for (const change of [
    ({ snapshot, draft }) => { snapshot.auxiliaryDrafts = { '[array]': draft }; },
    ({ draft, row }) => { draft.output.attributeHints = { '[array]': row }; },
    ({ snapshot, draft }) => { snapshot.auxiliaryDrafts.push({ ...draft }); },
    ({ draft }) => { draft.output.other = draft.output.attributeHints; delete draft.output.attributeHints; }
  ]) {
    const value = fixture(); change(value);
    assert.ok(collectCanonicalC2ReferenceErrors(value.root).length > 0);
  }
});

test('the declared hint object keeps its existing closed shape and string bounds', () => {
  for (const change of [
    ({ row }) => { row.extra = 'x'; },
    ({ row }) => { row.field = ''; },
    ({ row }) => { row.field = '名'.repeat(121); },
    ({ row }) => { row.value = 1; },
    ({ row }) => { row.value = '值'.repeat(501); },
    ({ row }) => { row.evidenceRef = '标'.repeat(301); },
    ({ row }) => { row.evidenceRef = ''; },
    ({ draft, row }) => { draft.output.attributeHints = Array.from({ length: 31 }, () => row); }
  ]) {
    const value = fixture(); change(value);
    assert.ok(collectCanonicalC2ReferenceErrors(value.root).length > 0);
  }
});

test('Unicode character limits match the existing published output schema', () => {
  const validate = new Ajv({ strict: true }).compile(SALES_AUXILIARY_OUTPUT_SCHEMA);
  for (const [key, maximum] of [['field', 120], ['value', 500], ['evidenceRef', 300]]) {
    for (const count of [1, maximum, maximum + 1]) {
      const { root, draft, row } = fixture();
      row[key] = '🐈'.repeat(count);
      assert.equal(validate(draft.output), count <= maximum);
      assert.equal(isSalesAuxiliaryAttributeHint(row), count <= maximum);
      assert.equal(collectCanonicalC2ReferenceErrors(root).length === 0, count <= maximum);
    }
  }
});

test('other fields inside the same draft are still traversed as evidence references', () => {
  const { root, draft } = fixture();
  draft.output.evidenceRef = '商品标题';
  const errors = collectCanonicalC2ReferenceErrors(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0].path, /output\.evidenceRef$/);
});

test('auxiliary label semantics do not disable complete secret scanning', () => {
  for (const label of ['password=private-value', 'Cookie: sid=private-value', 'Bearer secret-value']) {
    const { root } = fixture(paths[0], label);
    assert.deepEqual(collectCanonicalC2ReferenceErrors(root), []);
    assert.throws(() => assertNoProductionSecrets(root), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  }
});
