import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWbCommissionReference, WbCommissionReferenceError } from '../lib/wb-commission-reference-reader.mjs';

const asOf = '2026-09-09T12:00:00.000Z';
const scope = { platform: 'wb', sellerRegion: 'CN', subjectId: 5267, salesScheme: 'fbs' };
const row = { parentID: 1513, parentName: 'Спортивная одежда', subjectID: 5267, subjectName: 'Шорты спортивные', kgvpChina: 20 };
const source = {
  schemaVersion: 'commission-reference-source-v1', catalogId: 'wb-china-commission', catalogVersion: '2026-09-09T05:02:34.628109Z',
  platform: 'wb', sellerRegion: 'CN', sourceUrl: 'https://common-api.wildberries.ru/api/v1/tariffs/commission',
  acquiredAt: '2026-09-09T05:02:34.628109Z', sourceReceiptRef: 'wb-download-receipt-20260909', sourceField: 'kgvpChina',
  rowCount: 1, categoryIdentityField: 'subjectID', effectiveFrom: null, effectiveTo: null, salesSchemes: null,
  priceConditions: null, applicabilityStatus: 'official_mode_and_price_conditions_not_yet_verified',
  purpose: 'saved_official_reference_not_formal_profit_evidence', refreshFrequency: null, productionEvidenceCommitted: false
};
const versionState = { catalogId: source.catalogId, catalogVersion: source.catalogVersion, status: 'active' };
async function fixture(t, { rows = [row], metadata = source } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-commission-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, 'catalog.json'), sourcePath = path.join(directory, 'source.json');
  await Promise.all([writeFile(catalogPath, JSON.stringify(rows)), writeFile(sourcePath, JSON.stringify(metadata))]);
  const input = { catalogPath, sourcePath, scope: structuredClone(scope), versionState: structuredClone(versionState), asOf };
  return { input, lookup: overrides => readWbCommissionReference({ ...input, ...overrides }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof WbCommissionReferenceError && error.code === code);

test('exact subject lookup preserves source, nullable period and mode/price gaps without a TTL or formal evidence', async t => {
  const f = await fixture(t), result = await f.lookup();
  assert.equal(result.status, 'matched_with_gaps'); assert.equal(result.commissionRate, 0.2);
  assert.equal(result.commissionPercent, 20); assert.deepEqual(result.matchedRow, row);
  assert.deepEqual(result.source, source); assert.equal(result.formalApplicability, false);
  assert.deepEqual(result.gaps, [
    { code: 'SALES_SCHEME_APPLICABILITY_UNKNOWN', field: 'source.salesSchemes', blocking: true },
    { code: 'PRICE_CONDITIONS_UNKNOWN', field: 'source.priceConditions', blocking: true },
    { code: 'EFFECTIVE_PERIOD_UNKNOWN', field: 'source.effectiveFrom/effectiveTo', blocking: false }
  ]);
  assert.equal(Object.hasOwn(result, 'expiresAt'), false); assert.equal(Object.hasOwn(result, 'current'), false);
  assert.deepEqual((await f.lookup({ asOf: '2027-09-09T12:00:00.000Z' })).matchedRow, row);
  assert.deepEqual(f.input.scope, scope); assert.deepEqual(f.input.versionState, versionState);
});

test('version invalidation and replacement are supplied per lookup and never hidden by reuse', async t => {
  const f = await fixture(t); assert.equal((await f.lookup()).commissionRate, 0.2);
  for (const [state, status] of [[{ ...versionState, status: 'invalidated' }, 'invalidated'],
    [{ ...versionState, catalogVersion: 'replacement' }, 'version_mismatch'],
    [{ ...versionState, catalogId: 'other-catalog' }, 'version_mismatch']]) {
    const result = await f.lookup({ versionState: state });
    assert.equal(result.status, status); assert.equal(result.commissionRate, null);
    assert.equal(result.matchedRow, null); assert.equal(result.formalApplicability, false);
  }
});

test('wrong platform/region, missing ID, unknown scheme and future source stay explicit', async t => {
  const f = await fixture(t);
  for (const mismatch of [{ ...scope, platform: 'ozon' }, { ...scope, sellerRegion: 'RU' }]) {
    const result = await f.lookup({ scope: mismatch }); assert.equal(result.status, 'scope_mismatch'); assert.equal(result.commissionRate, null);
  }
  const absent = await f.lookup({ scope: { ...scope, subjectId: 999999 } });
  assert.equal(absent.status, 'not_found'); assert.equal(absent.commissionRate, null);
  const unknown = await f.lookup({ scope: { ...scope, salesScheme: null } });
  assert.equal(unknown.commissionRate, 0.2); assert.ok(unknown.gaps.some(value => value.code === 'SALES_SCHEME_MISSING'));
  assert.equal((await f.lookup({ asOf: '2026-09-08T12:00:00.000Z' })).status, 'not_yet_available');
});

test('known effective boundaries are enforced without manufacturing an end date', async t => {
  const f = await fixture(t, { metadata: { ...source, effectiveFrom: '2026-09-10T00:00:00.000Z', effectiveTo: '2026-09-11T00:00:00.000Z' } });
  assert.equal((await f.lookup()).status, 'not_effective');
  assert.equal((await f.lookup({ asOf: '2026-09-10T00:00:00.000Z' })).status, 'matched_with_gaps');
  assert.equal((await f.lookup({ asOf: '2026-09-11T00:00:00.000Z' })).status, 'not_effective');
});

test('whole catalog rejects duplicate IDs, count mismatch, malformed numbers and unverified source changes', async t => {
  const cases = [
    [{ rows: [row, row], metadata: { ...source, rowCount: 2 } }, 'DUPLICATE_SUBJECT_ID'],
    [{ rows: [] }, 'ROW_COUNT_INVALID'],
    ...[-1, 101, '20', null].map(kgvpChina => [{ rows: [{ ...row, kgvpChina }] }, 'ROW_INVALID']),
    [{ rows: [{ ...row, subjectID: '5267' }] }, 'ROW_INVALID'],
    [{ metadata: { ...source, sellerRegion: 'RU' } }, 'SOURCE_INVALID'],
    [{ metadata: { ...source, sourceField: 'kgvpMarketplace' } }, 'SOURCE_INVALID'],
    [{ metadata: { ...source, sourceUrl: 'https://example.invalid' } }, 'SOURCE_INVALID'],
    [{ metadata: { ...source, catalogVersion: '' } }, 'SOURCE_INVALID'],
    [{ metadata: { ...source, salesSchemes: ['fbs'] } }, 'SOURCE_APPLICABILITY_UNSUPPORTED'],
    [{ metadata: { ...source, productionEvidenceCommitted: true } }, 'SOURCE_APPLICABILITY_UNSUPPORTED']
  ];
  for (const [options, code] of cases) { const f = await fixture(t, options); await rejectsCode(f.lookup(), code); }
});

test('zero is an actual rate and 100 percent remains explicit reference data outside the current B rate contract', async t => {
  for (const kgvpChina of [0, 100]) {
    const f = await fixture(t, { rows: [{ ...row, kgvpChina }] }), result = await f.lookup();
    assert.equal(result.commissionRate, kgvpChina / 100); assert.equal(result.formalApplicability, false);
    assert.equal(result.gaps.some(value => value.code === 'COMMISSION_RATE_UNSUPPORTED_BY_B'), kgvpChina === 100);
  }
});

test('invalid input, malformed JSON and missing files are errors rather than zero commission', async t => {
  const f = await fixture(t);
  await rejectsCode(f.lookup({ versionState: undefined }), 'INPUT_INVALID');
  await rejectsCode(f.lookup({ asOf: '2026-02-30T12:00:00.000Z' }), 'INPUT_INVALID');
  await rejectsCode(f.lookup({ scope: { ...scope, subjectId: '5267' } }), 'INPUT_INVALID');
  await writeFile(f.input.catalogPath, '{'); await rejectsCode(f.lookup(), 'CATALOG_JSON_INVALID');
  await rm(f.input.catalogPath); await assert.rejects(f.lookup(), error => error.code === 'ENOENT');
});

test('approved local WB table has 7408 unique rows and exact CN subject lookup keeps source gaps', async () => {
  const catalogPath = fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.json', import.meta.url));
  const sourcePath = fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.source.json', import.meta.url));
  const bytes = await readFile(catalogPath), metadataBytes = await readFile(sourcePath);
  const result = await readWbCommissionReference({ catalogPath, sourcePath, scope, versionState, asOf });
  assert.equal(result.source.rowCount, 7408); assert.equal(result.commissionRate, 0.2);
  assert.deepEqual(result.matchedRow, row); assert.equal(result.formalApplicability, false);
  assert.equal(result.source.effectiveFrom, null); assert.equal(result.source.effectiveTo, null);
  assert.equal(result.source.salesSchemes, null); assert.equal(result.source.priceConditions, null);
  assert.deepEqual(await readFile(catalogPath), bytes); assert.deepEqual(await readFile(sourcePath), metadataBytes);
});
