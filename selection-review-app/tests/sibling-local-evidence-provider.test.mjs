import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { createLocalOzonCommissionEvidenceProvider } from '../lib/lifecycle-b-real-evidence-readers.mjs';
import { createLifecycleBEvidenceProvider } from '../lib/lifecycle-b-evidence-providers.mjs';
import { commitLifecycleBEvidencePacks } from '../lib/lifecycle-b-evidence-runtime.mjs';
import { isLifecycleEvidenceTraceValid, validateLifecycleEvidenceData } from '../lib/lifecycle-b-input-bundle.mjs';
import { createInternalEvidenceValidity, createSourceDeclaredEvidenceValidity,
  inspectLifecycleEvidenceValidity } from '../lib/lifecycle-evidence-validity.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';

// Only the local table reader is synthetic. Provider validation, scope matching,
// evidence identity, validity interpretation and atomic commit are production code.
const AT = '2026-10-18T17:00:00.000Z';
const LATER = '2026-10-18T17:00:00.001Z';
const FILE_SHA = 'a'.repeat(64);
const CATEGORY = 'ozon:17028966:96063';

function forbidNetwork(t) {
  const tripwires = [
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network fetch')),
    t.mock.method(http, 'request', () => assert.fail('Unexpected HTTP request')),
    t.mock.method(https, 'request', () => assert.fail('Unexpected HTTPS request'))
  ];
  t.after(() => { for (const tripwire of tripwires) assert.equal(tripwire.mock.callCount(), 0); });
}

function referenceConfiguration() {
  return { catalogPath: '/synthetic/sibling-local-evidence/commission.json', sellerRegion: 'CN',
    versionState: { fileSha256: FILE_SHA, effectiveFrom: '2026-08-01', status: 'active' } };
}

function schemaPack() {
  return { id: `b-evidence:schema:${'b'.repeat(20)}`, kind: 'schema', status: 'active',
    scope: { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: CATEGORY, ruleVersion: 'ozon-current' },
    sourceType: 'ozon_seller_api_current_schema',
    sourceRef: 'ozon-seller-api:/v1/description-category/attribute:17028966:96063',
    checkedAt: '2026-10-18T16:00:00.000Z', expiresAt: '2026-10-19T16:00:00.000Z',
    providerVersion: 'lifecycle-b-evidence-provider-v1.1',
    validity: createInternalEvidenceValidity('schema'),
    evidenceData: { schemaRevision: `ozon-schema-${'c'.repeat(20)}`, descriptionCategoryId: 17028966,
      typeId: 96063, requiredFields: [], attributes: [{ fieldKey: '10096', label: 'Цвет товара',
        required: false, dictionaryId: 1494, isCollection: true, maxValueCount: 3 }] } };
}

function request({ candidateId = 'SYNTHETIC-BLACK-CP', candidateRevision = 2, priceRub = 848 } = {}) {
  return { requestVersion: 'lifecycle-b-evidence-preparation-v1.1', kind: 'commission',
    candidateId, candidateRevision,
    scope: { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF),
      category: CATEGORY, salesScheme: 'rfbs' },
    relatedSchemaScope: structuredClone(schemaPack().scope),
    commissionReferenceScope: { priceRub, typeName: '宠物服装', mpCategoryZh: '宠物用品' },
    maximumAttempts: 1, readOnly: true, platformWritesAllowed: false, requestedAt: AT };
}

function referenceRead(query) {
  return { schemaVersion: 'ozon-commission-reference-read-v1', platform: 'ozon', sellerRegion: 'CN',
    salesScheme: query.scope.salesScheme, priceRub: query.scope.priceRub, priceTier: 'le1500',
    commissionRate: 0.12, matchedRows: [{ row: 1, typeRu: 'Одежда для животных', typeZh: '宠物服装',
      typeEn: 'Pet clothing', category3Zh: '宠物服装和靴子', mpCategoryZh: '宠物用品', brand: 'All' }],
    source: { sourceUrl: 'https://docs.ozon.ru/common/pravila-raboty/komissii/', sourcePage: 'Full ChinaHK',
      effectiveFrom: '2026-08-01', fileSha256: FILE_SHA, fileLastModified: '2026-08-01T00:00:00.000Z',
      downloadedAt: '2026-08-01T01:00:00.000Z', catalogSchemaVersion: 'ozon-official-commission-reference-v1' },
    versionState: structuredClone(query.versionState), checkedAt: query.asOf, gaps: [] };
}

function localProvider({ packs = [schemaPack()], at = AT, read = referenceRead } = {}) {
  const calls = [];
  const configuration = referenceConfiguration();
  const provider = createLocalOzonCommissionEvidenceProvider({ ozonCommissionReference: configuration,
    schemaPacks: packs, now: () => new Date(at), readOzonCommissionReferenceImpl: async query => {
      assert.equal(query.catalogPath, configuration.catalogPath);
      assert.deepEqual(query.versionState, configuration.versionState);
      assert.equal(query.asOf, at);
      assert.deepEqual(query.scope, { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs',
        priceRub: query.scope.priceRub, typeIdentity: { typeZh: '宠物服装' }, mpCategoryZh: '宠物用品' });
      calls.push(structuredClone(query));
      return read(query);
    } });
  return { provider, calls };
}

function commit(document, packs, at = AT) {
  return commitLifecycleBEvidencePacks(document, packs, { createdAt: at, createdBy: 'synthetic-test' });
}

async function otherCommissionPack(input, { mode, at = AT, authorizationRef = 'synthetic-estimate:one' }) {
  const evidenceData = { commissionRate: 0.12, commissionEvidenceMode: mode };
  if (mode === 'estimated') evidenceData.commissionEstimateAuthorization = {
    schemaVersion: 'commission-estimate-authorization-v1', candidateId: input.candidateId,
    candidateRevision: input.candidateRevision, authorizationRef, commissionRate: evidenceData.commissionRate
  };
  return createLifecycleBEvidenceProvider({ kind: 'commission', read: async () => ({ current: true,
    scope: structuredClone(input.scope), sourceType: 'synthetic-local-commission',
    sourceRef: `synthetic-commission:${mode}`, checkedAt: at, expiresAt: '2026-10-19T17:00:00.000Z', evidenceData }) })(input);
}

test('same-millisecond three-color readings have distinct bindings and preserve the active parent evidence', async t => {
  forbidNetwork(t);
  const schemas = [schemaPack()], schemasBefore = structuredClone(schemas);
  const { provider, calls } = localProvider({ packs: schemas });
  const parent = await provider(request({ candidateId: 'SYNTHETIC-PARENT', candidateRevision: 78 }));
  const document = { evidencePacks: [] };
  commit(document, [parent]);
  const savedParent = structuredClone(document.evidencePacks[0]);
  const inputs = [request(), request({ candidateId: 'SYNTHETIC-CP', candidateRevision: 1 }),
    request({ candidateId: 'SYNTHETIC-BLACK', candidateRevision: 1 })];
  const packs = await Promise.all(inputs.map(input => provider(input)));
  assert.equal(new Set([parent, ...packs].map(pack => pack.id)).size, 4);
  assert.equal(new Set(packs.map(pack => pack.checkedAt)).size, 1);
  for (const [index, pack] of packs.entries()) {
    assert.deepEqual(pack.evidenceData.officialCommissionBinding, { schemaVersion: 'ozon-official-commission-binding-v1',
      candidateId: inputs[index].candidateId, candidateRevision: inputs[index].candidateRevision, priceRub: 848 });
    assert.equal(isLifecycleEvidenceTraceValid(pack), true);
    assert.equal(validateLifecycleEvidenceData('commission', pack.evidenceData).valid, true);
    assert.equal(pack.evidenceData.commissionEvidenceMode, 'official_reference');
    assert.equal(pack.evidenceData.estimateAuthorized, false);
  }
  const saved = commit(document, packs);
  assert.equal(saved.length, 3);
  assert.equal(document.evidencePacks.length, 4);
  assert.ok(document.evidencePacks.every(pack => pack.status === 'active'));
  assert.deepEqual(document.evidencePacks[0], savedParent);
  const beforeReplay = structuredClone(document);
  commit(document, packs);
  assert.deepEqual(document, beforeReplay);
  assert.equal(calls.length, 4);
  assert.deepEqual(schemas, schemasBefore);
});

test('price, revision, estimated authorization and exact evidence coexist without superseding other scopes', async t => {
  forbidNetwork(t);
  const { provider } = localProvider();
  const inputs = [request(), request({ priceRub: 900 }), request({ candidateRevision: 3 })];
  const official = await Promise.all(inputs.map(input => provider(input)));
  const estimates = await Promise.all([
    otherCommissionPack(inputs[0], { mode: 'estimated' }),
    otherCommissionPack(inputs[0], { mode: 'estimated', authorizationRef: 'synthetic-estimate:two' }),
    otherCommissionPack(inputs[2], { mode: 'estimated' })
  ]);
  const exact = await otherCommissionPack(inputs[0], { mode: 'exact' });
  const all = [...official, ...estimates, exact], document = { evidencePacks: [] };
  assert.equal(new Set(all.map(pack => pack.id)).size, all.length);
  commit(document, all);
  assert.equal(document.evidencePacks.length, 7);
  assert.ok(document.evidencePacks.every(pack => pack.status === 'active'));
});

test('a later reading supersedes only the identical full binding and keeps unrelated history unchanged', async t => {
  forbidNetwork(t);
  const { provider } = localProvider();
  const input = request();
  const official = await provider(input);
  const others = await Promise.all([provider(request({ priceRub: 900 })), provider(request({ candidateRevision: 3 })),
    provider(request({ candidateId: 'SYNTHETIC-PARENT', candidateRevision: 78 })),
    otherCommissionPack(input, { mode: 'estimated' }), otherCommissionPack(input, { mode: 'exact' })]);
  const document = { evidencePacks: [] };
  commit(document, [official, ...others]);
  const original = structuredClone(document.evidencePacks);
  const newer = await localProvider({ at: LATER }).provider(input);
  assert.notEqual(newer.id, official.id);
  commit(document, [newer], LATER);
  assert.deepEqual(document.evidencePacks[0], { ...original[0], status: 'superseded' });
  assert.deepEqual(document.evidencePacks.slice(1, original.length), original.slice(1));
  assert.equal(document.evidencePacks.at(-1).status, 'active');
  const newerEstimate = await otherCommissionPack(input, { mode: 'estimated', at: LATER });
  commit(document, [newerEstimate], LATER);
  assert.equal(document.evidencePacks.find(pack => pack.id === others[3].id).status, 'superseded');
  assert.equal(document.evidencePacks.find(pack => pack.id === newer.id).status, 'active');
  assert.deepEqual(document.evidencePacks.find(pack => pack.id === others[4].id), original[5]);
});

test('refresh-due saved schema remains usable without restamping or replacing its original evidence', async t => {
  forbidNetwork(t);
  const schema = schemaPack();
  schema.checkedAt = '2026-09-20T16:00:00.000Z';
  schema.expiresAt = '2026-09-21T16:00:00.000Z';
  const before = structuredClone(schema);
  assert.deepEqual({ status: inspectLifecycleEvidenceValidity(schema, { asOf: AT }).status,
    usable: inspectLifecycleEvidenceValidity(schema, { asOf: AT }).usable }, { status: 'refresh_due', usable: true });
  const { provider, calls } = localProvider({ packs: [schema] });
  const pack = await provider(request());
  const document = { evidencePacks: [schema] };
  commit(document, [pack]);
  assert.deepEqual(document.evidencePacks[0], before);
  assert.deepEqual(schema, before);
  assert.equal(pack.checkedAt, AT);
  assert.equal(calls.length, 1);
});

const invalidSchemas = [
  ['missing category', pack => { pack.scope.category = 'ozon:17028966:96064'; }, /B_EVIDENCE_LOCAL_SCHEMA_AMBIGUOUS_OR_MISSING/],
  ['different store', pack => { pack.scope.storeRef.platformStoreId = 'synthetic-other-store'; }, /B_EVIDENCE_LOCAL_SCHEMA_AMBIGUOUS_OR_MISSING/],
  ['different mapping', pack => { pack.scope.storeRef.mappingVersion = 'synthetic-mapping:v2'; }, /B_EVIDENCE_LOCAL_SCHEMA_AMBIGUOUS_OR_MISSING/],
  ['expired source limit', pack => { pack.checkedAt = '2026-10-16T16:00:00.000Z'; pack.expiresAt = '2026-10-17T16:00:00.000Z';
    pack.validity = createSourceDeclaredEvidenceValidity('schema', pack.expiresAt); }, /B_EVIDENCE_LOCAL_SCHEMA_INVALID/],
  ['superseded schema', pack => { pack.status = 'superseded'; }, /B_EVIDENCE_LOCAL_SCHEMA_INVALID/],
  ['invalid schema DTO', pack => { pack.evidenceData.requiredFields = 'invalid'; }, /B_EVIDENCE_LOCAL_SCHEMA_INVALID/],
  ['different schema type ID', pack => { pack.evidenceData.typeId += 1; }, /B_EVIDENCE_LOCAL_SCHEMA_INVALID/]
];
for (const [label, change, expected] of invalidSchemas) test(`${label} stops before even the local table reader`, async t => {
  forbidNetwork(t);
  const pack = schemaPack();
  change(pack);
  const before = structuredClone(pack), { provider, calls } = localProvider({ packs: [pack] });
  await assert.rejects(() => provider(request()), expected);
  assert.equal(calls.length, 0);
  assert.deepEqual(pack, before);
});

test('missing or ambiguous saved schemas cannot be replaced by a network lookup', async t => {
  forbidNetwork(t);
  assert.throws(() => localProvider({ packs: [] }), /B_EVIDENCE_LOCAL_COMMISSION_CONFIGURATION_REQUIRED/);
  const pack = schemaPack(), { provider, calls } = localProvider({ packs: [pack, { ...pack, id: 'synthetic-duplicate-schema' }] });
  await assert.rejects(() => provider(request()), /B_EVIDENCE_LOCAL_SCHEMA_AMBIGUOUS_OR_MISSING/);
  assert.equal(calls.length, 0);
});

test('local reader errors stop once with a classified failure and never return a default rate', async t => {
  forbidNetwork(t);
  const { provider, calls } = localProvider({ read: () => {
    throw Object.assign(new Error('synthetic reader failure'), { code: 'CATALOG_UNREADABLE' });
  } });
  await assert.rejects(() => provider(request()), /B_EVIDENCE_LOCAL_COMMISSION_UNAVAILABLE: OFFICIAL_TABLE_CATALOG_UNREADABLE/);
  assert.equal(calls.length, 1);
});

for (const [label, change, expected] of [
  ['missing rate', result => { result.commissionRate = null; }, /OFFICIAL_TABLE_RATE_UNUSABLE/],
  ['blocking table gap', result => { result.gaps = [{ code: 'TYPE_AMBIGUOUS', field: 'scope.typeIdentity', blocking: true }]; }, /TYPE_AMBIGUOUS/],
  ['missing source identity', result => { delete result.source.fileSha256; }, /OFFICIAL_TABLE_SOURCE_INCOMPLETE/],
  ['invalid source identity', result => { result.source.fileSha256 = 'invalid'; }, /B_EVIDENCE_PROVIDER_VALIDITY_INVALID/],
  ['empty matched rows', result => { result.matchedRows = []; }, /OFFICIAL_TABLE_SOURCE_INCOMPLETE/]
]) test(`bad official table DTO: ${label} produces no commission pack`, async t => {
  forbidNetwork(t);
  const { provider, calls } = localProvider({ read: query => { const result = referenceRead(query); change(result); return result; } });
  await assert.rejects(() => provider(request()), expected);
  assert.equal(calls.length, 1);
});

test('standard provider rejects an official result bound to another candidate, revision or price', async t => {
  forbidNetwork(t);
  const input = request(), pack = await localProvider().provider(input);
  for (const change of [binding => { binding.candidateId = 'SYNTHETIC-OTHER'; },
    binding => { binding.candidateRevision += 1; }, binding => { binding.priceRub += 1; }]) {
    const raw = { ...structuredClone(pack), current: true };
    change(raw.evidenceData.officialCommissionBinding);
    const provider = createLifecycleBEvidenceProvider({ kind: 'commission', read: async () => raw });
    await assert.rejects(() => provider(input), { code: 'B_EVIDENCE_PROVIDER_OFFICIAL_SCOPE_MISMATCH' });
  }
});

test('a rejected result in a three-member commit leaves all previous evidence unchanged', async t => {
  forbidNetwork(t);
  const { provider } = localProvider(), document = { evidencePacks: [] };
  commit(document, [await provider(request({ candidateId: 'SYNTHETIC-PARENT', candidateRevision: 78 }))]);
  const before = structuredClone(document);
  const packs = await Promise.all(['SYNTHETIC-BLACK-CP', 'SYNTHETIC-CP', 'SYNTHETIC-BLACK']
    .map(candidateId => provider(request({ candidateId }))));
  const invalid = structuredClone(packs);
  invalid[2].evidenceData.officialCommissionBinding.priceRub = null;
  assert.throws(() => commit(document, invalid), /B_EVIDENCE_COMMIT_INVALID_PACK/);
  assert.deepEqual(document, before);
});
