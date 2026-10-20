import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { siblingColorState, siblingColorSchemaPack } from './fixtures/sibling-color-state.mjs';
import { startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';

const { api: port } = allocatedTestPorts();

function savedSchemaPack(candidate, id = 'schema:synthetic:saved-current') {
  const pack = siblingColorSchemaPack(candidate);
  pack.id = id;
  pack.checkedAt = '2026-08-18T00:00:00.000Z';
  pack.expiresAt = '2099-01-01T00:00:00.000Z';
  pack.sourceRef = 'synthetic:saved-current-schema';
  pack.evidenceData.schemaRevision = 'schema:synthetic:saved-current-version';
  pack.evidenceData.writeBindings.schemaRevision = pack.evidenceData.schemaRevision;
  pack.evidenceData.writeBindings.evidenceRef = pack.id;
  return pack;
}

async function startSchemaPreparationApi(t, document, identityProvider = 'local_owner_password') {
  const candidate = document.candidates[1];
  return startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-schema-api-')),
    port, document, binding: { storeRef: candidate.storeRef, platform: candidate.targetPlatform },
    productionBindings: [], identityProvider });
}

test('unsettled color reads cannot be cleared through the frozen sibling revision API', async t => {
  for (const status of ['request_sent', 'unknown_outcome']) {
    await t.test(status, async child => {
      const document = siblingColorState();
      const frozen = document.candidates[0];
      frozen.lifecycleV11.c1ColorDictionaryReadsV1 = { '10096': {
        schemaVersion: 'c1-color-dictionary-read-v1', status,
        authorizationId: `synthetic:${status}`, externalRequestRef: `synthetic:${status}:request`
      } };
      const api = await startSavedDEApi(child, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-color-unsettled-')),
        port, document, binding: { storeRef: frozen.storeRef, platform: frozen.targetPlatform },
        productionBindings: [] });
      await api.authenticate();
      const before = await api.readBytes();
      const response = await api.post(`/api/candidates/${frozen.id}/lifecycle/c1/revise-sibling-color`, {
        candidateId: frozen.id, skuPackageId: frozen.lifecycleV11.skuPackage.skuPackageId,
        dataRevision: frozen.dataRevision });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, 'C1_SIBLING_COLOR_REVISION_DICTIONARY_READ_UNSETTLED');
      assert.deepEqual(await api.readBytes(), before);
      assert.equal(api.dictionaryRequests(), 0);
      assert.equal(api.dependencyRequests(), 0);
      await api.assertClean();
    });
  }
});

test('synthetic sibling color recovery API preserves the predecessor and requires owner identity', async t => {
  const document = siblingColorState();
  const frozen = document.candidates[0];
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-color-api-'));
  const api = await startSavedDEApi(t, { directory, port, document,
    binding: { storeRef: frozen.storeRef, platform: frozen.targetPlatform }, productionBindings: [] });
  const route = `/api/candidates/${frozen.id}/lifecycle/c1/revise-sibling-color`;
  const input = { candidateId: frozen.id, skuPackageId: frozen.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: frozen.dataRevision };
  const original = await api.readBytes();
  const guest = await api.post(route, input, { authenticated: false });
  assert.equal(guest.status, 401, JSON.stringify(guest.body));
  assert.deepEqual(await api.readBytes(), original);

  await api.authenticate();
  const editable = document.candidates[1];
  const freezeRoute = `/api/candidates/${editable.id}/lifecycle/c1/continue-preparation`;
  const beforeFreeze = await api.readBytes();
  const freeze = await api.post(freezeRoute, { candidateId: editable.id, dataRevision: editable.dataRevision });
  assert.equal(freeze.status, 409, JSON.stringify(freeze.body));
  assert.equal(freeze.body.code, 'SIBLING_COLOR_BINDING_INVALID');
  assert.deepEqual(freeze.body.requiredAttributeIds, ['10096', '10097']);
  assert.deepEqual(await api.readBytes(), beforeFreeze);

  const stale = await api.post(route, { ...input, dataRevision: input.dataRevision - 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readBytes(), beforeFreeze);
  const responses = await Promise.all([api.post(route, input), api.post(route, input)]);
  assert.ok(responses.every(response => response.status === 200), JSON.stringify(responses));
  assert.deepEqual(new Set(responses.map(response => response.body.status)), new Set(['committed', 'idempotent_replay']));
  const saved = await api.readDocument();
  const current = saved.candidates.find(candidate => candidate.id === frozen.id);
  assert.equal(current.dataRevision, frozen.dataRevision + 1);
  assert.equal(current.lifecycleV11.skuPackage.businessPhase, 'C1');
  assert.equal(current.lifecycleV11.skuPackage.c1ProductPlan.status, 'inputs_ready');
  assert.equal(current.lifecycleV11.skuPackage.c2FinalAssets, null);
  assert.equal(current.lifecycleV11.skuPackage.productionConfirmationCard, null);
  assert.equal(saved.c1SiblingColorRevisionHistoryRecords.length, 1);
  assert.deepEqual(saved.c1SiblingColorRevisionHistoryRecords[0].previousSkuPackage,
    frozen.lifecycleV11.skuPackage);
  const committedBytes = await api.readBytes();
  const conflicting = await api.post(route, { ...input, skuPackageId: 'synthetic:other-sku' });
  assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
  assert.equal(conflicting.body.code, 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await api.readBytes(), committedBytes);
  assert.equal(saved.candidates.find(candidate => candidate.id === 'SYNTHETIC-COLOR-EDITABLE').dataRevision,
    document.candidates[1].dataRevision);
  assert.equal(saved.runtime.softwareJobs?.length ?? 0, 0);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('owner-authorized complete color choices are read once, saved and mapped without another account read', async t => {
  const document = siblingColorState();
  const editable = document.candidates[1];
  const schema = editable.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const api = await startSavedDEApi(t, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-color-choices-')),
    port, document, binding: { storeRef: editable.storeRef, platform: editable.targetPlatform },
    productionBindings: [], dictionaryResponder: (request, query) => {
      if (request.method !== 'POST' || query?.kind !== 'schema_dictionary_values' ||
          query.store !== schema.store || query.category !== `ozon:${schema.descriptionCategoryId}:${schema.typeId}` ||
          query.attributeId !== '10096' || query.limit !== 200) return null;
      const checkedAt = new Date();
      return { ok: true, evidence: { current: true,
        scope: { platform: 'ozon', store: query.store, category: query.category, attributeId: query.attributeId },
        sourceRef: 'synthetic:dictionary:10096', checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + 24 * 60 * 60_000).toISOString(), evidenceData: { complete: true,
          values: [{ value: 'synthetic-broad-color', valueZh: '合成广义颜色', dictionaryValueId: 910096 }] } } };
    } });
  const route = `/api/candidates/${editable.id}/lifecycle/c1`;
  await api.authenticate();
  const facts = await api.get(`${route}/ozon-attributes`);
  assert.equal(facts.status, 200);
  const sourceFacts = facts.body.proposal.confirmedFacts.filter(fact => fact.value === '黑cp' &&
    fact.factPath.startsWith('productAttributes.supplierAttributes.'));
  assert.equal(sourceFacts.length, 1);
  const before = await api.readBytes();
  const premature = await api.post(`${route}/ozon-attribute-mapping`, { candidateId: editable.id,
    dataRevision: editable.dataRevision, mappings: [{ attributeId: '10096', value: 'synthetic-broad-color',
      sourceFactPath: sourceFacts[0].factPath }] });
  assert.equal(premature.status, 409, JSON.stringify(premature.body));
  assert.equal(premature.body.code, 'C1_COLOR_DICTIONARY_AUTHORIZATION_MISSING');
  assert.deepEqual(await api.readBytes(), before);
  assert.equal(api.dictionaryRequests(), 0);

  const authorizationInput = { candidateId: editable.id, skuPackageId: editable.lifecycleV11.skuPackage.skuPackageId,
    dataRevision: editable.dataRevision, attributeId: '10096' };
  const unauthorized = await api.post(`${route}/color-dictionary/authorize`, authorizationInput, { authenticated: false });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await api.readBytes(), before);
  const staleAuthorization = await api.post(`${route}/color-dictionary/authorize`,
    { ...authorizationInput, dataRevision: authorizationInput.dataRevision - 1 });
  assert.equal(staleAuthorization.status, 409, JSON.stringify(staleAuthorization.body));
  assert.equal(staleAuthorization.body.code, 'BUSINESS_MUTATION_REVISION_CONFLICT');
  assert.deepEqual(await api.readBytes(), before);
  assert.equal(api.dictionaryRequests(), 0);
  const authorized = await api.post(`${route}/color-dictionary/authorize`, authorizationInput);
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  assert.equal(authorized.body.result.status, 'authorized');
  assert.equal(authorized.body.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].status, 'authorized');
  assert.equal(api.dictionaryRequests(), 0);
  const afterAuthorization = await api.readBytes();
  const conflictingAuthorization = await api.post(`${route}/color-dictionary/authorize`,
    { ...authorizationInput, skuPackageId: 'synthetic:other-sku' });
  assert.equal(conflictingAuthorization.status, 409, JSON.stringify(conflictingAuthorization.body));
  assert.equal(conflictingAuthorization.body.code, 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await api.readBytes(), afterAuthorization);
  assert.equal(api.dictionaryRequests(), 0);
  const claimInput = { ...authorizationInput, dataRevision: authorized.body.candidate.dataRevision,
    authorizationId: authorized.body.result.authorizationId };
  const reads = await Promise.all([api.post(`${route}/color-dictionary/continue`, claimInput),
    api.post(`${route}/color-dictionary/continue`, claimInput)]);
  assert.ok(reads.every(response => response.status === 200), JSON.stringify(reads));
  assert.deepEqual(new Set(reads.map(response => response.body.status)), new Set(['committed', 'idempotent_replay']));
  const completedRead = reads.find(response => response.body.result?.status === 'succeeded');
  assert.deepEqual(completedRead.body.candidate.lifecycleV11.c1ColorDictionaryReadsV1['10096'].evidence.values
    .map(value => value.value), ['synthetic-broad-color']);
  assert.equal(api.dictionaryRequests(), 1);
  const saved = await api.readDocument();
  const current = saved.candidates.find(candidate => candidate.id === editable.id);
  const record = current.lifecycleV11.c1ColorDictionaryReadsV1['10096'];
  assert.equal(record.status, 'succeeded');
  assert.equal(record.useCount, 1);
  assert.equal(record.evidence.complete, true);
  assert.deepEqual(record.evidence.values.map(item => item.value), ['synthetic-broad-color']);
  const mapping = await api.post(`${route}/ozon-attribute-mapping`, { candidateId: editable.id,
    dataRevision: current.dataRevision, mappings: [
      { attributeId: '10096', value: 'synthetic-broad-color', sourceFactPath: sourceFacts[0].factPath },
      { attributeId: '10097', value: 'synthetic-exact-color', sourceFactPath: sourceFacts[0].factPath }
    ] });
  assert.equal(mapping.status, 200, JSON.stringify(mapping.body));
  assert.deepEqual(mapping.body.result.mappedAttributeIds, ['10096', '10097']);
  assert.equal(mapping.body.result.externalCalls, 0);
  assert.equal(api.dictionaryRequests(), 1);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('schema refresh and local adoption reject missing owner, malformed inputs and stale revisions before any request', async t => {
  const document = siblingColorState(), candidate = document.candidates[1], pack = savedSchemaPack(candidate);
  document.evidencePacks.push(pack);
  const api = await startSchemaPreparationApi(t, document);
  const base = `/api/candidates/${candidate.id}/lifecycle/c1`;
  const actions = [
    { route: `${base}/refresh-category-schema`, input: { candidateId: candidate.id, dataRevision: candidate.dataRevision } },
    { route: `${base}/adopt-saved-category-schema`, input: { candidateId: candidate.id,
      dataRevision: candidate.dataRevision, evidencePackId: pack.id } }
  ];
  const before = await api.readBytes();
  for (const action of actions) {
    const response = await api.post(action.route, action.input, { authenticated: false,
      headers: { 'x-user-id': 'synthetic-owner', 'x-session-id': 'synthetic-session', 'x-user-role': 'owner' } });
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.deepEqual(await api.readBytes(), before);
  }
  await api.authenticate();
  for (const action of actions) {
    for (const invalid of [null, { ...action.input, candidateId: 'synthetic-other-candidate' },
      { ...action.input, dataRevision: String(action.input.dataRevision) },
      { ...action.input, dataRevision: -1 }, { ...action.input, extra: true },
      { ...action.input, dataRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
      const response = await api.post(action.route, invalid);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.match(response.body.message, /当前商品、修订号/);
      assert.deepEqual(await api.readBytes(), before);
    }
    const stale = await api.post(action.route, { ...action.input, dataRevision: candidate.dataRevision + 1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.match(stale.body.message, /商品资料已变化/);
    assert.deepEqual(await api.readBytes(), before);
  }
  for (const evidencePackId of ['', '   ', 1]) {
    const response = await api.post(actions[1].route, { ...actions[1].input, evidencePackId });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepEqual(await api.readBytes(), before);
  }
  assert.deepEqual(await api.readDocument(), document);
  assert.equal(api.dictionaryRequests(), 0);assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('development-default identity cannot authorize schema refresh or adopt saved evidence through forged owner headers', async t => {
  const document = siblingColorState(), candidate = document.candidates[1], pack = savedSchemaPack(candidate);
  document.evidencePacks.push(pack);
  const api = await startSchemaPreparationApi(t, document, 'development_default'), before = await api.readBytes();
  for (const action of ['refresh-category-schema', 'adopt-saved-category-schema']) {
    const input = { candidateId: candidate.id, dataRevision: candidate.dataRevision,
      ...(action === 'adopt-saved-category-schema' ? { evidencePackId: pack.id } : {}) };
    const response = await api.post(`/api/candidates/${candidate.id}/lifecycle/c1/${action}`, input,
      { authenticated: false, headers: { 'x-user-id': 'synthetic-owner', 'x-session-id': 'synthetic-session', 'x-user-role': 'owner' } });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.code, 'C1_SCHEMA_REFRESH_OWNER_REQUIRED');
    assert.equal(response.body.externalRequests, 0);
    assert.deepEqual(await api.readBytes(), before);
  }
  assert.equal(api.dictionaryRequests(), 0);assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('unsettled schema reads preserve their original state and cannot be replayed or replaced by local adoption', async t => {
  for (const status of ['request_sent', 'unknown_outcome']) await t.test(status, async child => {
    const document = siblingColorState(), candidate = document.candidates[1], pack = savedSchemaPack(candidate);
    const previous = { schemaVersion: 'c1-schema-refresh-v1', status,
      authorizationId: `schema:synthetic:${status}`, candidateId: candidate.id,
      skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, sourceCandidateRevision: candidate.dataRevision,
      externalRequestRef: `schema:synthetic:${status}:request`, useCount: 1,
      requestedAt: '2026-08-18T00:00:00.000Z', failureCode: status === 'unknown_outcome' ? 'C1_SCHEMA_REFRESH_UNKNOWN_OUTCOME' : null };
    candidate.lifecycleV11.c1SchemaRefreshV1 = previous;
    candidate.dataRevision += 2;
    document.evidencePacks.push(pack);
    const api = await startSchemaPreparationApi(child, document);
    await api.authenticate();
    const before = await api.readBytes();
    const base = `/api/candidates/${candidate.id}/lifecycle/c1`, input = { candidateId: candidate.id, dataRevision: candidate.dataRevision };
    for (const action of ['refresh-category-schema', 'adopt-saved-category-schema']) {
      const response = await api.post(`${base}/${action}`, { ...input,
        ...(action === 'adopt-saved-category-schema' ? { evidencePackId: pack.id } : {}) });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, previous.failureCode ?? 'C1_SCHEMA_REFRESH_RESULT_UNCONFIRMED');
      assert.equal(response.body.requestState, status);
      assert.equal(response.body.externalRequests, null);
      assert.equal(response.body.newExternalRequests, 0);
      assert.equal(response.body.platformWrites, 0);assert.equal(response.body.paidCalls, 0);
      assert.deepEqual(await api.readBytes(), before);
    }
    await api.restart();await api.authenticate('login');
    const repeated = await api.post(`${base}/refresh-category-schema`, input);
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    assert.equal(repeated.body.requestState, status);assert.equal(repeated.body.newExternalRequests, 0);
    assert.deepEqual(await api.readBytes(), before);
    assert.deepEqual((await api.readDocument()).candidates[1].lifecycleV11.c1SchemaRefreshV1, previous);
    assert.equal(api.dictionaryRequests(), 0);assert.equal(api.dependencyRequests(), 0);
    await api.assertClean();
  });
});

test('local schema adoption accepts only the exact active scope and updates all plan references without any external request', async t => {
  const document = siblingColorState(), candidate = document.candidates[1], pack = savedSchemaPack(candidate);
  const wrongPacks = ['store', 'category', 'rule', 'inactive'].map(kind => {
    const wrong = savedSchemaPack(candidate, `schema:synthetic:wrong-${kind}`);
    if (kind === 'store') wrong.scope.storeRef.platformStoreId = 'synthetic-other-store';
    if (kind === 'category') wrong.scope.category = 'ozon:17028665:999';
    if (kind === 'rule') wrong.scope.ruleVersion = 'synthetic-other-rule';
    if (kind === 'inactive') wrong.status = 'superseded';
    return wrong;
  });
  document.evidencePacks.push(pack, ...wrongPacks);
  const api = await startSchemaPreparationApi(t, document);
  await api.authenticate();
  const before = await api.readDocument(), bytes = await api.readBytes();
  const route = `/api/candidates/${candidate.id}/lifecycle/c1/adopt-saved-category-schema`;
  const input = { candidateId: candidate.id, dataRevision: candidate.dataRevision, evidencePackId: pack.id };
  for (const evidencePackId of [...wrongPacks.map(item => item.id), 'schema:synthetic:missing']) {
    const response = await api.post(route, { ...input, evidencePackId });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'C1_SCHEMA_REFRESH_SAVED_EVIDENCE_INVALID');
    assert.equal(response.body.requestState, 'not_sent');assert.equal(response.body.externalRequests, 0);
    assert.equal(response.body.platformWrites, 0);assert.equal(response.body.paidCalls, 0);
    assert.deepEqual(await api.readBytes(), bytes);
  }
  const results = await Promise.all([api.post(route, input), api.post(route, input)]);
  assert.ok(results.some(result => result.status === 200), JSON.stringify(results));
  for (const result of results) {
    assert.ok([200, 409].includes(result.status), JSON.stringify(result.body));
    if (result.status === 409) assert.match(result.body.message, /商品资料已变化/);
    else {
      assert.equal(result.body.status, 'succeeded');assert.equal(result.body.change.evidenceId, pack.id);
      assert.equal(result.body.externalRequests, 0);assert.equal(result.body.platformWrites, 0);assert.equal(result.body.paidCalls, 0);
    }
  }
  const saved = await api.readDocument(), updated = saved.candidates[1], sku = updated.lifecycleV11.skuPackage;
  const plan = sku.c1ProductPlan;
  assert.equal(updated.dataRevision, candidate.dataRevision + 1);
  assert.equal(sku.businessPhase, 'C1');assert.equal(plan.status, 'inputs_ready');
  assert.deepEqual([plan.schemaSnapshotRef, plan.inputRefs.platformSchemaEvidenceId,
    plan.frozenInputRefs.schemaSnapshotRef, plan.inputSnapshots.platformSchemaRules.evidenceId], Array(4).fill(pack.id));
  assert.deepEqual(plan.inputSnapshots.platformSchemaRules.attributes, pack.evidenceData.attributes);
  const { c1ProductPlan: previousPlan, ...previousSku } = before.candidates[1].lifecycleV11.skuPackage;
  const { c1ProductPlan: currentPlan, ...currentSku } = sku;
  assert.deepEqual(currentSku, previousSku);
  assert.notEqual(currentPlan.schemaSnapshotRef, previousPlan.schemaSnapshotRef);
  assert.deepEqual(saved.candidates[0], before.candidates[0]);assert.deepEqual(saved.evidencePacks, before.evidencePacks);
  assert.equal(updated.lifecycleV11.c1SchemaRefreshV1, undefined);
  assert.equal(saved.runtime.softwareJobs, undefined);
  assert.equal(saved.runtime.idempotencyRecords.length, 1);
  assert.equal(saved.runtime.operationAudit.length, 1);
  assert.equal(saved.runtime.operationAudit[0].action, 'adopt_saved_c1_schema');
  assert.equal(saved.runtime.operationAudit[0].authorizationRef, null);
  assert.equal(api.dictionaryRequests(), 0);assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
