import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../lib/ozon-de-preflight-evidence-reader.mjs';
import { createOzonDEPreflightProvider, OzonDEPreflightEvidenceError,
  OzonDEPreflightEvidenceUnavailableError } from '../lib/ozon-de-preflight-provider.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';

const clone = value => structuredClone(value);
function repositoryFor(record) {
  return createMemoryBusinessStateRepository({ candidates: [], runtime: {
    ozonDEPreflightEvidence: { [record.scope.authorizationId]: clone(record) }
  } });
}
function receipt(record) {
  return { status: 'verified', evidenceId: record.evidenceId, scope: clone(record.scope),
    collectedAt: record.collectedAt, expiresAt: record.expiresAt,
    readAuthorizationRef: record.provenance.readAuthorizationRef,
    softwareJobRef: record.provenance.softwareJobRef,
    officialContractRefs: clone(record.provenance.officialContractRefs) };
}

test('constructing the reader does not read or write; absent evidence is distinct from an unavailable source', async () => {
  const { record, scope } = ozonDEPreflightEvidenceFixture();
  const empty = createMemoryBusinessStateRepository({ candidates: [], runtime: {} });
  let reads = 0;
  const readEvidence = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: {
    ...empty, readSnapshot: async () => { reads += 1; return empty.readSnapshot(); }
  } });
  assert.equal(reads, 0); assert.equal(await readEvidence(scope), null); assert.equal(reads, 1);
  const repository = repositoryFor(record), before = await repository.readSnapshot();
  const unverified = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository });
  await assert.rejects(unverified(scope), error => error instanceof OzonDEPreflightEvidenceUnavailableError && error.code === 'evidence_source_unverified');
  assert.deepEqual(await repository.readSnapshot(), before);
});

test('the default server source boundary cannot promote a self-declared verified record', async () => {
  const { record, scope, context, query } = ozonDEPreflightEvidenceFixture();
  const provider = createOzonDEPreflightProvider({
    readEvidence: createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: repositoryFor(record) }),
    serverClock: () => context.preparationEvidence.startedAt
  });
  const capabilities = await provider.loadAdapterCapabilities(context);
  assert.equal(capabilities.status, 'not_ready');
  assert.ok(capabilities.gaps.some(gap => gap.code === 'evidence_source_unverified'));
  const inspection = await provider.inspectPlatform(query, context);
  assert.equal(inspection.connections.api.status, 'unknown');
  assert.equal(inspection.connections.sellerBackend.status, 'unknown');
  assert.equal(inspection.priceFieldCurrency, 'unknown');
  assert.ok(inspection.risks.some(risk => risk.code === 'evidence_source_unverified'));
  assert.equal(scope.authorizationId, context.productionAuthorization.authorizationId);
});

test('only a trusted exact source receipt permits a detached normalized record, without refreshing evidence time', async () => {
  const { record, scope } = ozonDEPreflightEvidenceFixture();
  const repository = repositoryFor(record), before = await repository.readSnapshot();
  let verified = 0;
  const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt: async (source, expected) => {
    verified += 1; assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source.scope)); assert.ok(Object.isFrozen(expected));
    assert.deepEqual(source, record); assert.deepEqual(expected, scope); return receipt(source);
  } });
  const result = await reader(scope); assert.deepEqual(result, record); assert.equal(verified, 1);
  result.inspection.permissionStatus = 'denied';
  assert.deepEqual(await repository.readSnapshot(), before);
});

test('truthy, partial, mismatched and extra-field source receipts are rejected', async () => {
  const { record, scope } = ozonDEPreflightEvidenceFixture();
  for (const result of [true, { status: 'verified' }, { ...receipt(record), evidenceId: 'evidence:other' },
    { ...receipt(record), scope: { ...scope, credentialAlias: 'alias:other' } },
    { ...receipt(record), softwareJobRef: 'job:other' }, { ...receipt(record), extra: true }]) {
    const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: repositoryFor(record), verifySourceReceipt: async () => result });
    await assert.rejects(reader(scope), error => error instanceof OzonDEPreflightEvidenceError && error.code === 'OZON_DE_PREFLIGHT_EVIDENCE_SOURCE_RECEIPT_INVALID');
  }
});

test('the target authorization is selected directly, without touching unrelated entries or falling back to another identity', async () => {
  const { record, scope } = ozonDEPreflightEvidenceFixture();
  const base = createMemoryBusinessStateRepository({ candidates: [], runtime: {} });
  const entries = { [scope.authorizationId]: record };
  Object.defineProperty(entries, 'unrelated', { enumerable: true, get() { throw new Error('Unrelated evidence was read'); } });
  const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: { ...base,
    readSnapshot: async () => ({ runtime: { ozonDEPreflightEvidence: entries } }) }, verifySourceReceipt: async value => receipt(value) });
  assert.deepEqual(await reader(scope), record);
  assert.equal(await reader({ ...scope, authorizationId: 'pa:absent' }), null);
  await assert.rejects(reader({ ...scope, warehouseId: '998877' }), /SCOPE_MISMATCH/);
  await assert.rejects(reader({ ...scope, storeRef: { ...scope.storeRef, mappingVersion: 'mapping:other' } }), /SCOPE_MISMATCH/);
});

test('malformed persistence and unknown I/O or verifier failures remain distinguishable', async () => {
  const { record, scope } = ozonDEPreflightEvidenceFixture();
  for (const runtime of [null, { ozonDEPreflightEvidence: null }, { ozonDEPreflightEvidence: [] },
    { ozonDEPreflightEvidence: { [scope.authorizationId]: { ...record, extra: true } } }]) {
    const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: createMemoryBusinessStateRepository({ runtime }) });
    await assert.rejects(reader(scope), OzonDEPreflightEvidenceError);
  }
  const failure = new TypeError('Synthetic unknown source failure');
  const base = repositoryFor(record);
  for (const options of [ { repository: { ...base, readSnapshot: async () => { throw failure; } } },
    { repository: base, verifySourceReceipt: async () => { throw failure; } } ]) {
    const reader = createRepositoryBackedOzonDEPreflightEvidenceReader(options);
    await assert.rejects(reader(scope), error => error === failure);
  }
});
