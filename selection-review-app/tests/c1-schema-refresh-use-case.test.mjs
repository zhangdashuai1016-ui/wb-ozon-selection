import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createC1SchemaRefreshUseCase } from '../lib/c1-schema-refresh-use-case.mjs';
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository,
  createPostgresBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { executeBusinessMutation } from '../lib/business-mutation-transaction.mjs';
import { persistJsonThroughRealTarget } from '../lib/atomic-json-persistence.mjs';
import { refreshC1FrozenPlatformSchema } from '../lib/c1-frozen-schema-refresh.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { siblingColorState, siblingColorSchemaPack } from './fixtures/sibling-color-state.mjs';
import { createFakePostgresBusinessStateStore } from './helpers/fake-postgres-business-state-store.mjs';

const AT = '2026-10-18T10:00:00.000Z';
const actor = createActorContext({ userId: 'schema-owner', sessionId: 'schema-session', actorType: 'human',
  roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: AT });

function setup(options = {}) {
  const document = siblingColorState();
  const candidate = document.candidates[1];
  const repository = options.repository ?? createMemoryBusinessStateRepository(document);
  const input = { candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision };
  const useCase = createC1SchemaRefreshUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => AT, schemaProvider: async () => freshPack(candidate), ...options });
  return { document, candidate, repository, input, useCase };
}

function freshPack(candidate) {
  const pack = siblingColorSchemaPack(candidate);
  pack.id = 'b-evidence:schema:11111111111111111111';
  pack.checkedAt = AT;
  pack.expiresAt = '2026-10-19T10:00:00.000Z';
  pack.sourceType = 'ozon_seller_api_current_schema';
  pack.sourceRef = 'ozon-seller-api:/v1/description-category/attribute:17028665:92935';
  pack.evidenceData.schemaRevision = 'ozon-schema-11111111111111111111';
  pack.evidenceData.descriptionCategoryId = 17028665;
  pack.evidenceData.typeId = 92935;
  pack.evidenceData.writeBindings.schemaRevision = pack.evidenceData.schemaRevision;
  pack.evidenceData.writeBindings.evidenceRef = pack.id;
  return pack;
}

function continuation(input, authorized) {
  return { ...input, expectedRevision: authorized.candidate.dataRevision,
    authorizationId: authorized.result.authorizationId };
}

test('authorization, durable send, evidence, and all plan references survive repository reopen', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'c1-schema-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'business-state.json');
  await writeFile(filePath, JSON.stringify(siblingColorState()), 'utf8');
  const repository = createJsonBusinessStateRepository({ filePath });
  let calls = 0;
  const fixture = setup({ repository, schemaProvider: async request => {
    calls += 1;
    const persisted = await createJsonBusinessStateRepository({ filePath }).readSnapshot();
    const saved = persisted.candidates[1].lifecycleV11.c1SchemaRefreshV1;
    assert.equal(saved.status, 'request_sent');
    assert.equal(saved.useCount, 1);
    assert.equal(request.candidateRevision, fixture.input.expectedRevision);
    assert.deepEqual([request.kind, request.maximumAttempts, request.maxExternalRequests,
      request.readOnly, request.platformWritesAllowed], ['schema', 1, 2, true, false]);
    assert.deepEqual(saved.readOperations, ['category_schema_ru', 'category_schema_zh']);
    return freshPack(fixture.candidate);
  } });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  assert.equal(calls, 0);
  const completed = await fixture.useCase.continueSaved({ actor, input: continuation(fixture.input, authorized) });
  assert.equal(completed.result.status, 'succeeded');
  assert.equal(completed.candidate.dataRevision, fixture.input.expectedRevision + 3);
  assert.equal(completed.result.externalRequests, null);
  assert.equal(calls, 1);
  const persisted = await createJsonBusinessStateRepository({ filePath }).readSnapshot();
  const target = persisted.candidates[1];
  const plan = target.lifecycleV11.skuPackage.c1ProductPlan;
  assert.deepEqual([plan.schemaSnapshotRef, plan.inputRefs.platformSchemaEvidenceId,
    plan.frozenInputRefs.schemaSnapshotRef, plan.inputSnapshots.platformSchemaRules.evidenceId],
  Array(4).fill(freshPack(fixture.candidate).id));
  assert.equal(persisted.evidencePacks.filter(pack => pack.id === plan.schemaSnapshotRef).length, 1);
  assert.equal(persisted.evidencePacks[0].status, 'superseded');
  assert.deepEqual(persisted.candidates[0], fixture.document.candidates[0]);
  assert.deepEqual(target.lifecycleV11.skuPackage.profitModels, fixture.candidate.lifecycleV11.skuPackage.profitModels);
  assert.equal(target.lifecycleV11.skuPackage.dataRevision, fixture.candidate.lifecycleV11.skuPackage.dataRevision);
  assert.deepEqual(persisted.runtime.operationAudit.map(event => event.externalRequestState),
    ['not_sent', 'unknown_outcome', 'succeeded']);
  assert.equal(persisted.runtime.softwareJobs, undefined);
});

test('concurrent clicks and old request replays call the provider only once', async () => {
  let calls = 0;
  const fixture = setup({ schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
  const [first, replay] = await Promise.all([fixture.useCase.authorize({ actor, input: fixture.input }),
    fixture.useCase.authorize({ actor, input: fixture.input })]);
  assert.deepEqual(new Set([first.status, replay.status]), new Set(['committed', 'idempotent_replay']));
  const input = continuation(fixture.input, first);
  const results = await Promise.all([fixture.useCase.continueSaved({ actor, input }),
    fixture.useCase.continueSaved({ actor, input })]);
  assert.deepEqual(new Set(results.map(result => result.status)), new Set(['committed', 'idempotent_replay']));
  await fixture.useCase.continueSaved({ actor, input });
  assert.equal(calls, 1);
  const document = await fixture.repository.readSnapshot();
  assert.equal(document.runtime.idempotencyRecords.length, 3);
  assert.equal(document.evidencePacks.length, 2);
});

test('Schema settlement atomically writes shared evidence and only its candidate partition', async () => {
  const document = siblingColorState();
  const target = document.candidates[1], otherId = document.candidates[0].id;
  const store = createFakePostgresBusinessStateStore({ document });
  const repository = createPostgresBusinessStateRepository({ store });
  const beforeRows = store.storedRows();
  const fixture = setup({ repository, runtimeMode: 'central_test' });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  const input = continuation(fixture.input, authorized);
  const completed = await fixture.useCase.continueSaved({ actor, input });
  assert.equal(completed.status, 'committed');
  assert.equal(completed.result.status, 'succeeded');
  assert.deepEqual(store.calls.lockedCandidateIds, [[target.id], [target.id], null]);
  const rows = store.storedRows();
  assert.equal(rows.shared.schemaVersion, 'business-state-shared-part-v1');
  assert.deepEqual(rows.shared.document.evidencePacks.map(pack => [pack.id, pack.status]), [
    [document.evidencePacks[0].id, 'superseded'], [freshPack(target).id, 'active'],
  ]);
  assert.deepEqual(rows.parts[otherId], beforeRows.parts[otherId]);
  assert.equal(rows.parts[target.id].schemaVersion, 'business-state-candidate-part-v1');
  assert.equal(Object.hasOwn(rows.parts[target.id].collections, 'evidencePacks'), false);
  assert.deepEqual(rows.parts[target.id].collections['runtime.idempotencyRecords'].records.map(record => record.action),
    ['authorize_c1_schema_refresh', 'claim_c1_schema_refresh', 'settle_c1_schema_refresh']);
  const reopened = createPostgresBusinessStateRepository({ store });
  const persisted = await reopened.readSnapshot();
  assert.equal(persisted.candidates[1].dataRevision, target.dataRevision + 3);
  assert.equal(persisted.candidates[1].lifecycleV11.skuPackage.c1ProductPlan.schemaSnapshotRef, freshPack(target).id);
  assert.deepEqual(persisted.candidates[0], document.candidates[0]);
  assert.deepEqual((await reopened.readCandidates([otherId])).evidencePacks, persisted.evidencePacks,
    'same-scope evidence stays visible to other candidates without changing their frozen snapshots');
  await assert.rejects(reopened.transactCandidates([target.id], async current => {
    current.evidencePacks.push({ id: 'unapproved-shared-pack' });
    return { changed: true, document: current, result: null };
  }), /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:shared/);
  assert.deepEqual(await reopened.readSnapshot(), persisted);
});

test('adopting shared Schema evidence remains a candidate-scoped operation', async () => {
  const document = siblingColorState(), target = document.candidates[1];
  const pack = freshPack(target);
  document.evidencePacks.push(pack);
  const store = createFakePostgresBusinessStateStore({ document });
  const repository = createPostgresBusinessStateRepository({ store });
  const before = store.storedRows();
  const fixture = setup({ repository, runtimeMode: 'central_test' });
  const adopted = await fixture.useCase.adoptSaved({ actor, input: { ...fixture.input, evidencePackId: pack.id } });
  assert.equal(adopted.result.status, 'succeeded');
  assert.deepEqual(store.calls.lockedCandidateIds, [[target.id]]);
  assert.deepEqual(store.storedRows().shared, before.shared);
  assert.deepEqual(store.storedRows().parts[document.candidates[0].id], before.parts[document.candidates[0].id]);
});

test('wrong actor, stale revision, wrong SKU, and frozen/produced plans cause zero reads', async t => {
  const cases = [
    ['actor', fixture => ({ actor: { ...actor, source: 'local_development' }, input: fixture.input }), null],
    ['revision', fixture => ({ actor, input: { ...fixture.input, expectedRevision: 26 } }), null],
    ['SKU', fixture => ({ actor, input: { ...fixture.input, skuPackageId: 'other-sku' } }), null],
    ['frozen', fixture => ({ actor, input: fixture.input }), candidate => { candidate.lifecycleV11.skuPackage.c1ProductPlan.status = 'facts_checked'; }],
    ['produced', fixture => ({ actor, input: fixture.input }), candidate => { candidate.lifecycleV11.skuPackage.externalListingRecord = { listingId: 'other-listing' }; }],
    ['store', fixture => ({ actor, input: fixture.input }), candidate => { candidate.storeRef.platformStoreId = 'other-store'; }],
    ['identity', fixture => ({ actor, input: fixture.input }), candidate => { candidate.lifecycleV11.skuPackage.g1Identity.candidateId = 'other-candidate'; }]
  ];
  for (const [name, args, edit] of cases) await t.test(name, async () => {
    let calls = 0;
    const fixture = setup({ schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
    if (edit) await fixture.repository.transact(document => {
      edit(document.candidates[1]); return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(fixture.useCase.authorize(args(fixture)));
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
    assert.equal(calls, 0);
  });
});

test('claim checks owner, expiry, current revision, and persisted scope before calling the provider', async t => {
  for (const name of ['owner', 'expiry', 'revision', 'scope']) await t.test(name, async () => {
    let calls = 0;
    let now = AT;
    const fixture = setup({ serverClock: () => now, schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
    const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
    let claimActor = actor;
    if (name === 'owner') claimActor = { ...actor, userId: 'other-owner' };
    if (name === 'expiry') now = '2026-10-18T10:10:00.000Z';
    if (['revision', 'scope'].includes(name)) await fixture.repository.transact(document => {
      const candidate = document.candidates[1];
      if (name === 'revision') candidate.dataRevision += 1;
      else candidate.lifecycleV11.c1SchemaRefreshV1.schemaRuleVersion = 'another-rule';
      return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(fixture.useCase.continueSaved({ actor: claimActor, input: continuation(fixture.input, authorized) }));
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
    assert.equal(calls, 0);
  });
});

test('unknown provider outcomes are durable, redact raw errors, and prohibit a fresh authorization', async () => {
  let calls = 0;
  const fixture = setup({ schemaProvider: async () => { calls += 1; throw new Error('token=do-not-save'); } });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  const input = continuation(fixture.input, authorized);
  const completed = await fixture.useCase.continueSaved({ actor, input });
  assert.equal(completed.result.status, 'unknown_outcome');
  assert.equal(completed.result.failureCode, 'C1_SCHEMA_REFRESH_UNKNOWN_OUTCOME');
  assert.deepEqual(completed.candidate.lifecycleV11.skuPackage, fixture.candidate.lifecycleV11.skuPackage);
  await fixture.useCase.continueSaved({ actor, input });
  await assert.rejects(fixture.useCase.authorize({ actor,
    input: { ...fixture.input, expectedRevision: completed.candidate.dataRevision } }), /ALREADY_AUTHORIZED/);
  const document = await fixture.repository.readSnapshot();
  assert.equal(calls, 1);
  assert.equal(document.evidencePacks.length, 1);
  assert.equal(JSON.stringify(document).includes('do-not-save'), false);
});

test('returned malformed or out-of-scope evidence is a known failure, with no partial Schema update', async t => {
  for (const name of ['empty', 'wrong_kind', 'wrong_store', 'wrong_category', 'old_time', 'future_time', 'expired', 'empty_attributes']) {
    await t.test(name, async () => {
      const fixture = setup({ schemaProvider: async () => {
        const pack = freshPack(fixture.candidate);
        if (name === 'empty') return null;
        if (name === 'wrong_kind') pack.kind = 'commission';
        if (name === 'wrong_store') pack.scope.storeRef.platformStoreId = 'another-store';
        if (name === 'wrong_category') pack.evidenceData.typeId = 999;
        if (name === 'old_time') pack.checkedAt = '2026-10-18T09:59:59.000Z';
        if (name === 'future_time') pack.checkedAt = '2026-10-18T10:00:01.000Z';
        if (name === 'expired') pack.expiresAt = AT;
        if (name === 'empty_attributes') pack.evidenceData.attributes = [];
        return pack;
      } });
      const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
      const completed = await fixture.useCase.continueSaved({ actor, input: continuation(fixture.input, authorized) });
      assert.equal(completed.result.status, 'failed');
      assert.equal(completed.result.failureCode, 'C1_SCHEMA_REFRESH_EVIDENCE_INVALID');
      assert.deepEqual(completed.candidate.lifecycleV11.skuPackage, fixture.candidate.lifecycleV11.skuPackage);
      assert.equal((await fixture.repository.readSnapshot()).evidencePacks.length, 1);
      const next = await fixture.useCase.authorize({ actor,
        input: { ...fixture.input, expectedRevision: completed.candidate.dataRevision } });
      assert.notEqual(next.result.authorizationId, authorized.result.authorizationId);
      assert.equal(next.candidate.lifecycleV11.c1SchemaRefreshHistoryV1[0].status, 'failed');
    });
  }
});

test('explicit provider DTO failures differ from unknown network/read failures', async t => {
  for (const [code, status] of [['B_EVIDENCE_PROVIDER_DATA_INVALID', 'failed'], ['B_EVIDENCE_PROVIDER_READ_FAILED', 'unknown_outcome']]) {
    await t.test(code, async () => {
      const fixture = setup({ schemaProvider: async () => { throw Object.assign(new Error('cookie=private'), { code }); } });
      const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
      const completed = await fixture.useCase.continueSaved({ actor, input: continuation(fixture.input, authorized) });
      assert.equal(completed.result.status, status);
      assert.equal(JSON.stringify(await fixture.repository.readSnapshot()).includes('cookie=private'), false);
    });
  }
});

test('failed send-intent persistence produces zero provider calls', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'c1-schema-claim-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'business-state.json');
  await writeFile(filePath, JSON.stringify(siblingColorState()), 'utf8');
  let calls = 0;
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (file, document) => {
    if (document.candidates[1].lifecycleV11.c1SchemaRefreshV1.status === 'request_sent') throw new Error('synthetic_disk_failure');
    await persistJsonThroughRealTarget(file, document);
  } });
  const fixture = setup({ repository, schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  const before = await readFile(filePath, 'utf8');
  await assert.rejects(fixture.useCase.continueSaved({ actor, input: continuation(fixture.input, authorized) }), /synthetic_disk_failure/);
  assert.equal(await readFile(filePath, 'utf8'), before);
  assert.equal(calls, 0);
});

test('failed atomic settlement leaves request_sent, no new pack, and cannot resend after restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'c1-schema-settle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'business-state.json');
  await writeFile(filePath, JSON.stringify(siblingColorState()), 'utf8');
  let calls = 0;
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (file, document) => {
    if (document.candidates[1].lifecycleV11.c1SchemaRefreshV1.status === 'succeeded') throw new Error('synthetic_disk_failure');
    await persistJsonThroughRealTarget(file, document);
  } });
  const fixture = setup({ repository, schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  const input = continuation(fixture.input, authorized);
  await assert.rejects(fixture.useCase.continueSaved({ actor, input }), error =>
    error.code === 'C1_SCHEMA_REFRESH_SETTLEMENT_UNCONFIRMED' && error.requestSent === true);
  const reopened = createJsonBusinessStateRepository({ filePath });
  const persisted = await reopened.readSnapshot();
  assert.equal(persisted.candidates[1].lifecycleV11.c1SchemaRefreshV1.status, 'request_sent');
  assert.equal(persisted.candidates[1].dataRevision, fixture.input.expectedRevision + 2);
  assert.equal(persisted.evidencePacks.length, 1);
  assert.equal(persisted.runtime.idempotencyRecords.length, 2);
  const restarted = setup({ repository: reopened, schemaProvider: async () => { calls += 1; return freshPack(fixture.candidate); } });
  assert.equal((await restarted.useCase.continueSaved({ actor, input })).status, 'idempotent_replay');
  await assert.rejects(restarted.useCase.authorize({ actor,
    input: { ...fixture.input, expectedRevision: persisted.candidates[1].dataRevision } }), /ALREADY_AUTHORIZED/);
  assert.equal(calls, 1);
});

test('a concurrent candidate edit rejects stale settlement without reverting the edit or replaying the read', async () => {
  const fixture = setup({ schemaProvider: async () => {
    await fixture.repository.transact(document => {
      document.candidates[1].dataRevision += 1;
      document.candidates[1].productName = 'concurrent saved edit';
      return { changed: true, document, result: null };
    });
    return freshPack(fixture.candidate);
  } });
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  await assert.rejects(fixture.useCase.continueSaved({ actor, input: continuation(fixture.input, authorized) }),
    error => error.code === 'C1_SCHEMA_REFRESH_SETTLEMENT_UNCONFIRMED' && error.requestSent === true);
  const persisted = await fixture.repository.readSnapshot();
  assert.equal(persisted.candidates[1].productName, 'concurrent saved edit');
  assert.equal(persisted.candidates[1].lifecycleV11.c1SchemaRefreshV1.status, 'request_sent');
  assert.equal(persisted.evidencePacks.length, 1);
});

async function claimedFixture() {
  const fixture = setup();
  const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
  await fixture.repository.transact(document => {
    const candidate = document.candidates[1];
    const record = candidate.lifecycleV11.c1SchemaRefreshV1;
    record.status = 'request_sent'; record.useCount = 1; record.requestedAt = AT;
    record.externalRequestRef = `${record.authorizationId}:request`;
    candidate.dataRevision += 1;
    return { changed: true, document, result: null };
  });
  const input = continuation(fixture.input, authorized);
  const command = { repository: fixture.repository, runtimeMode: 'local_development', actor,
    requiredRoles: ['owner'], action: 'settle_c1_schema_refresh', candidateId: input.candidateId,
    skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision + 1,
    idempotencyKey: `${input.authorizationId}:settle`, inputFingerprint: 'synthetic-schema-result',
    auditEventId: `${input.authorizationId}:settle:audit`, authorizationRef: input.authorizationId,
    externalRequestRef: `${input.authorizationId}:request`, externalRequestState: 'succeeded', serverClock: () => AT };
  const outcomeFor = ({ candidate, observedAt }) => {
    const pack = freshPack(candidate);
    const refreshed = refreshC1FrozenPlatformSchema({ skuPackage: candidate.lifecycleV11.skuPackage,
      freshPack: pack, refreshedAt: observedAt });
    candidate.lifecycleV11.skuPackage = refreshed.skuPackage;
    const record = candidate.lifecycleV11.c1SchemaRefreshV1;
    Object.assign(record, { status: 'succeeded', settledAt: observedAt, evidencePackId: pack.id, failureCode: null });
    return { candidate, evidencePacksToCommit: [pack], result: { status: 'succeeded', evidencePackId: pack.id, change: refreshed.change } };
  };
  return { ...fixture, command, outcomeFor };
}

test('the transaction effect rejects missing, multiple, wrong-kind, wrong-scope, and partial-plan packs atomically', async t => {
  const edits = [
    ['missing', outcome => { delete outcome.evidencePacksToCommit; }],
    ['multiple', outcome => { outcome.evidencePacksToCommit.push(structuredClone(outcome.evidencePacksToCommit[0])); }],
    ['kind', outcome => { outcome.evidencePacksToCommit[0].kind = 'commission'; }],
    ['scope', outcome => { outcome.evidencePacksToCommit[0].scope.storeRef.platformStoreId = 'different-store'; }],
    ['rule', outcome => { outcome.evidencePacksToCommit[0].scope.ruleVersion = 'different-rule'; }],
    ['ref', outcome => { outcome.candidate.lifecycleV11.skuPackage.c1ProductPlan.schemaSnapshotRef = 'partial-ref'; }],
    ['content', outcome => { outcome.evidencePacksToCommit[0].evidenceData.attributes[0].dictionaryId = -1; }],
    ['ID', outcome => { outcome.evidencePacksToCommit[0].id = 'wrong-pack-ID'; }],
    ['owner', outcome => { outcome.candidate.lifecycleV11.c1SchemaRefreshV1.authorizedByUserId = 'other-owner'; }],
    ['candidate', outcome => { outcome.candidate.productName = 'unrelated-product-change'; }],
    ['lifecycle', outcome => { outcome.candidate.lifecycleV11.unrelatedResult = 'not-a-schema-refresh'; }]
  ];
  for (const [name, edit] of edits) await t.test(name, async () => {
    const fixture = await claimedFixture();
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(executeBusinessMutation({ ...fixture.command, mutate: context => {
      const outcome = fixture.outcomeFor(context); edit(outcome); return outcome;
    } }));
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  });
});

test('Schema effects are restricted to this action and an authenticated owner', async t => {
  for (const name of ['action', 'owner']) await t.test(name, async () => {
    const fixture = await claimedFixture();
    const before = await fixture.repository.readSnapshot();
    const command = name === 'action' ? { ...fixture.command, action: 'ordinary_edit' }
      : { ...fixture.command, actor: { ...actor, source: 'local_development' } };
    await assert.rejects(executeBusinessMutation({ ...command, mutate: fixture.outcomeFor }));
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  });
});

test('settlement replay verifies the saved evidence and permits later superseded status only', async t => {
  for (const name of ['untouched', 'superseded', 'missing', 'changed', 'duplicate']) await t.test(name, async () => {
    const fixture = await claimedFixture();
    const first = await executeBusinessMutation({ ...fixture.command, mutate: fixture.outcomeFor });
    assert.equal(first.status, 'committed');
    await fixture.repository.transact(document => {
      const pack = document.evidencePacks.find(item => item.id === first.result.evidencePackId);
      if (name === 'superseded') pack.status = 'superseded';
      if (name === 'missing') document.evidencePacks = document.evidencePacks.filter(item => item !== pack);
      if (name === 'changed') pack.evidenceData.attributes[0].dictionaryId += 1;
      if (name === 'duplicate') document.evidencePacks.push(structuredClone(pack));
      return { changed: true, document, result: null };
    });
    const replay = () => executeBusinessMutation({ ...fixture.command, mutate: () => { throw new Error('must_not_run'); } });
    if (['untouched', 'superseded'].includes(name)) assert.equal((await replay()).status, 'idempotent_replay');
    else await assert.rejects(replay(), /C1_SCHEMA_REFRESH_REPLAY_EVIDENCE_CONFLICT/);
  });
});

test('an explicit local adoption reuses the current saved pack without an external grant or request', async () => {
  let calls = 0;
  const fixture = setup({ schemaProvider: async () => { calls += 1; throw new Error('must_not_read'); } });
  const pack = freshPack(fixture.candidate);
  await fixture.repository.transact(document => {
    document.evidencePacks.push(pack); return { changed: true, document, result: null };
  });
  const before = await fixture.repository.readSnapshot();
  const input = { ...fixture.input, evidencePackId: pack.id };
  const adopted = await fixture.useCase.adoptSaved({ actor, input });
  assert.equal(adopted.result.status, 'succeeded');
  assert.deepEqual([adopted.result.externalRequests, calls], [0, 0]);
  assert.equal(adopted.candidate.dataRevision, fixture.input.expectedRevision + 1);
  assert.equal(adopted.candidate.lifecycleV11.c1SchemaRefreshV1, undefined);
  assert.equal(adopted.candidate.lifecycleV11.skuPackage.c1ProductPlan.schemaSnapshotRef, pack.id);
  const after = await fixture.repository.readSnapshot();
  assert.deepEqual(after.evidencePacks, before.evidencePacks);
  assert.deepEqual(after.candidates[0], before.candidates[0]);
  assert.equal(after.runtime.operationAudit[0].authorizationRef, null);
  assert.equal(after.runtime.softwareJobs, undefined);
  assert.equal((await fixture.useCase.adoptSaved({ actor, input })).status, 'idempotent_replay');
  assert.equal((await fixture.repository.readSnapshot()).candidates[1].dataRevision, adopted.candidate.dataRevision);
});

test('local adoption rejects missing, duplicate, inactive, expired and different-scope packs atomically', async t => {
  for (const name of ['missing', 'duplicate', 'inactive', 'expired', 'store', 'category', 'rule', 'empty_attributes']) await t.test(name, async () => {
    let calls = 0;
    const fixture = setup({ schemaProvider: async () => { calls += 1; throw new Error('must_not_read'); } });
    const pack = freshPack(fixture.candidate);
    if (name === 'inactive') pack.status = 'superseded';
    if (name === 'expired') pack.expiresAt = AT;
    if (name === 'store') pack.scope.storeRef.platformStoreId = 'other-store';
    if (name === 'category') pack.scope.category = 'ozon:17028665:999';
    if (name === 'rule') pack.scope.ruleVersion = 'other-rule';
    if (name === 'empty_attributes') pack.evidenceData.attributes = [];
    await fixture.repository.transact(document => {
      if (name !== 'missing') document.evidencePacks.push(pack);
      if (name === 'duplicate') document.evidencePacks.push(structuredClone(pack));
      return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(fixture.useCase.adoptSaved({ actor, input: { ...fixture.input, evidencePackId: pack.id } }),
      /C1_SCHEMA_REFRESH_SAVED_EVIDENCE_INVALID/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
    assert.equal(calls, 0);
  });
});

test('local adoption cannot hide a pending or unknown external read', async t => {
  for (const status of ['authorized', 'request_sent', 'unknown_outcome']) await t.test(status, async () => {
    const fixture = setup();
    const authorized = await fixture.useCase.authorize({ actor, input: fixture.input });
    const pack = freshPack(fixture.candidate);
    await fixture.repository.transact(document => {
      document.candidates[1].lifecycleV11.c1SchemaRefreshV1.status = status;
      document.evidencePacks.push(pack); return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(fixture.useCase.adoptSaved({ actor, input: { ...fixture.input,
      expectedRevision: authorized.candidate.dataRevision, evidencePackId: pack.id } }), /UNSETTLED_READ/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  });
});

test('Schema changes do not invalidate an unsettled color dictionary read', async t => {
  for (const status of ['request_sent', 'unknown_outcome']) await t.test(status, async () => {
    const fixture = setup({ schemaProvider: async () => { throw new Error('must_not_read'); } });
    const pack = freshPack(fixture.candidate);
    await fixture.repository.transact(document => {
      document.candidates[1].lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': { status } };
      document.evidencePacks.push(pack); return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(fixture.useCase.authorize({ actor, input: fixture.input }), /DICTIONARY_READ_UNSETTLED/);
    await assert.rejects(fixture.useCase.adoptSaved({ actor, input: { ...fixture.input, evidencePackId: pack.id } }), /DICTIONARY_READ_UNSETTLED/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  });
});
