import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingBatchSchemaPreparation } from '../src/siblingBatchSchemaPreparation.js';

function candidate(id, evidenceId = 'schema:old', maximum) {
  return { id, lifecycleV11: { skuPackage: { c1ProductPlan: { inputSnapshots: { platformSchemaRules: {
    evidenceId, attributes: [{ fieldKey: '10096', dictionaryId: 8, isCollection: true,
      ...(maximum === undefined ? {} : { maxValueCount: maximum }) }, { fieldKey: '10097' }]
  } } } } } };
}

test('missing collection bound requires a read and never treats absent metadata as unlimited', () => {
  for (const maximum of [undefined, 0, -1]) {
    const view = siblingBatchSchemaPreparation([candidate('one', 'schema:old', maximum)]);
    assert.equal(view.ready, false);
    assert.equal(view.rows[0].action, 'read');
  }
});

test('one successful read offers exact saved evidence adoption to remaining members', () => {
  const first = candidate('one', 'schema:new', 3);
  first.lifecycleV11.c1SchemaRefreshV1 = { status: 'succeeded', evidencePackId: 'schema:new', settledAt: '2026-10-18T00:00:00Z' };
  const second = candidate('two');
  const original = structuredClone([first, second]);
  const view = siblingBatchSchemaPreparation([first, second]);
  assert.equal(view.evidencePackId, 'schema:new');
  assert.deepEqual(view.rows.map(row => row.action), ['ready', 'adopt']);
  assert.deepEqual([first, second], original);
  second.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules = structuredClone(
    first.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules);
  assert.equal(siblingBatchSchemaPreparation([first, second]).ready, true);
});

test('unknown reads remain stopped and successful incomplete evidence is shown as missing', () => {
  const first = candidate('one', 'schema:new');
  first.lifecycleV11.c1SchemaRefreshV1 = { status: 'succeeded', evidencePackId: 'schema:new', settledAt: '2026-10-18T00:00:00Z' };
  const second = candidate('two');
  second.lifecycleV11.c1SchemaRefreshV1 = { status: 'unknown_outcome' };
  assert.deepEqual(siblingBatchSchemaPreparation([first, second]).rows.map(row => row.action), ['evidence_missing', 'reconcile']);
});

test('stale success receipt cannot supply a different frozen schema', () => {
  const first = candidate('one');
  first.lifecycleV11.c1SchemaRefreshV1 = { status: 'succeeded', evidencePackId: 'schema:different', settledAt: '2026-10-18T00:00:00Z' };
  assert.equal(siblingBatchSchemaPreparation([first]).source, null);
});
