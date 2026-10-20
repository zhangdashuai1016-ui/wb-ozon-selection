import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOzonOptionalAttributes } from '../lib/ozon-submission-attributes.mjs';
function input() { return { attributes: { requiredPlatformFields: [{ fieldKey: '85' }], ozonAttributes: [
  { fieldKey: '85' }, { fieldKey: '5953', fact: { verificationStatus: 'confirmed', sourceRefs: ['mapping:1'], value: { value: 'Унисекс', dictionaryValueId: 1884 } } },
  { fieldKey: '10096', fact: { verificationStatus: 'unknown' } }
] }, platformSchemaAttributes: [{ fieldKey: '5953', required: false, complexId: 0, dictionaryId: 1 }] }; }
test('only confirmed applicable optional fields are added; unknowns are explicitly omitted', () => {
  assert.deepEqual(buildOzonOptionalAttributes(input()), { attributes: [{ id: 5953, complex_id: 0, values: [{ dictionary_value_id: 1884, value: 'Унисекс' }] }], omissions: [{ fieldKey: '10096', reason: 'fact_unconfirmed' }] });
});
test('optional mapping rejects absent schema, duplicate fields, missing provenance and guessed dictionary values', () => {
  for (const mutate of [i => i.platformSchemaAttributes = null, i => i.platformSchemaAttributes[0].required = true, i => i.attributes.ozonAttributes.push(structuredClone(i.attributes.ozonAttributes[1])), i => i.attributes.ozonAttributes[1].fact.sourceRefs = [], i => delete i.attributes.ozonAttributes[1].fact.value.dictionaryValueId]) {
    const i = input(); mutate(i); assert.throws(() => buildOzonOptionalAttributes(i), /OZON_OPTIONAL_/);
  }
});
test('schema free text is sent without fabricated dictionary ID; legacy absence preserves existing payload', () => {
  const i = input(); i.platformSchemaAttributes[0].dictionaryId = 0; i.attributes.ozonAttributes[1].fact.value = 150;
  assert.deepEqual(buildOzonOptionalAttributes(i).attributes[0].values, [{ dictionary_value_id: 0, value: '150' }]);
  assert.deepEqual(buildOzonOptionalAttributes({ attributes: { requiredPlatformFields: [] }, platformSchemaAttributes: null }), { attributes: [], omissions: [] });
});

function collectionInput() {
  const value = input();
  Object.assign(value.platformSchemaAttributes[0], { isCollection: true, maxValueCount: 2 });
  value.attributes.ozonAttributes[1].fact.value = [
    { value: 'synthetic first value', dictionaryValueId: 1884 },
    { value: 'synthetic second value', dictionaryValueId: 1885 }
  ];
  return value;
}

test('optional dictionary collections preserve order and IDs exactly at the schema limit', () => {
  const value = collectionInput(), before = structuredClone(value);
  assert.deepEqual(buildOzonOptionalAttributes(value), {
    attributes: [{ id: 5953, complex_id: 0, values: [
      { dictionary_value_id: 1884, value: 'synthetic first value' },
      { dictionary_value_id: 1885, value: 'synthetic second value' }
    ] }], omissions: [{ fieldKey: '10096', reason: 'fact_unconfirmed' }]
  });
  assert.deepEqual(value, before);
});

test('optional collection constraints reject invalid shape, duplicates and unbounded or exceeded cardinality', () => {
  for (const change of [
    value => { value.attributes.ozonAttributes[1].fact.value = []; },
    value => { value.attributes.ozonAttributes[1].fact.value = ['synthetic unmapped']; },
    value => { value.attributes.ozonAttributes[1].fact.value[0] = null; },
    value => { value.attributes.ozonAttributes[1].fact.value[1].dictionaryValueId = 1884; },
    value => { delete value.attributes.ozonAttributes[1].fact.value[0].dictionaryValueId; },
    value => { value.attributes.ozonAttributes[1].fact.value[0].dictionaryValueId = 0; },
    value => { value.attributes.ozonAttributes[1].fact.value[0].dictionaryValueId = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.attributes.ozonAttributes[1].fact.value[0].value = ' '; },
    value => { value.platformSchemaAttributes[0].isCollection = false; },
    value => { value.platformSchemaAttributes[0].dictionaryId = 0; },
    value => { delete value.platformSchemaAttributes[0].maxValueCount; },
    ...[0, 1, -1, 2.5, '2', Number.MAX_SAFE_INTEGER + 1].map(maximum => value => { value.platformSchemaAttributes[0].maxValueCount = maximum; })
  ]) {
    const value = collectionInput(); change(value);
    const before = structuredClone(value);
    assert.throws(() => buildOzonOptionalAttributes(value), { message: 'OZON_OPTIONAL_ATTRIBUTE_COLLECTION_INVALID' });
    assert.deepEqual(value, before);
  }
});

test('optional scalar validation retains dictionary and free-text error distinctions', () => {
  for (const raw of [{ value: 'missing id' }, { value: 'invalid id', dictionaryValueId: -1 },
    { value: ' ', dictionaryValueId: 1884 }, { bad: 'invalid' }, true]) {
    const value = input(); value.attributes.ozonAttributes[1].fact.value = raw;
    const before = structuredClone(value);
    assert.throws(() => buildOzonOptionalAttributes(value), { message: 'OZON_OPTIONAL_ATTRIBUTE_DICTIONARY_REQUIRED' });
    assert.deepEqual(value, before);
  }
  for (const raw of [true, { bad: 'invalid' }, { value: undefined }, NaN, Infinity]) {
    const value = input(); value.platformSchemaAttributes[0].dictionaryId = 0;
    value.attributes.ozonAttributes[1].fact.value = raw;
    const before = structuredClone(value);
    assert.throws(() => buildOzonOptionalAttributes(value), { message: 'OZON_OPTIONAL_ATTRIBUTE_VALUE_INVALID' });
    assert.deepEqual(value, before);
  }
});
