import test from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionHttpFixture } from './helpers/d-e-saved-api-fixture.mjs';
import { createSelectionReviewRuntimeConfiguration } from '../lib/runtime-configuration.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createOzonDEHttpTransport } from '../lib/ozon-de-http-transport.mjs';
import { createOzonAccountReadBindingResolver, accountReadBindingForProduction } from '../lib/ozon-account-read-preparation.mjs';
import { createOzonAccountReadEvidenceSource, composeOzonAccountPreflightEvidence } from '../lib/ozon-account-read-evidence.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../lib/ozon-de-preflight-evidence-reader.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createOzonAccountReadServices } from '../lib/ozon-account-read-services.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { OZON_DE_READBACK_ENDPOINTS, OZON_DE_LEGACY_READBACK_ENDPOINTS, OZON_PRODUCT_IMPORT_INFO_ENDPOINT } from '../lib/ozon-seller-api-de-adapter.mjs';
import { createOzonAccountReadRuntime } from '../lib/ozon-account-read-runtime.mjs';

async function fixture({ clockOffsetMs = 0 } = {}) {
  const base = await productionOwnerDecisionHttpFixture(), clock = () => new Date(Date.parse(base.owner.formal.at) + clockOffsetMs).toISOString();
  const accountService = { ...base.service, schemaVersion: 'ozon-account-read-service-binding-v1',
    serviceId: 'service:synthetic:account-read', workerId: 'worker:synthetic:account-read' };
  const env = {
    SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: base.candidate.targetStore, platform: 'ozon', storeRef: base.candidate.storeRef }]),
    SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify([base.binding]),
    SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([base.service]),
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify([accountService]),
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify([{ credentialAlias: base.binding.credentialAlias, clientId: '700123',
      keychainService: 'synthetic-account-source', keychainAccount: 'synthetic-account' }])
  };
  const configuration = createSelectionReviewRuntimeConfiguration({ env, appDir: '/tmp/synthetic-account-integration', argv: [] });
  const repository = createMemoryBusinessStateRepository(base.document), workerRegistry = createLocalDevelopmentWorkerRegistry({ clock });
  let secretReads = 0; const requests = [];
  const responses = {
    '/v1/roles': { expires_at: '2027-01-01T00:00:00.000Z', roles: [{ name: 'test', methods: ['/v3/product/import', '/v2/products/stocks',
      OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_READBACK_ENDPOINTS)] }] },
    '/v1/seller/info': { company: { currency: 'CNY', inn: 'private-tax-value' } },
    '/v2/warehouse/list': { has_next: false, warehouses: [{ warehouse_id: Number(base.binding.warehouseId), is_rfbs: true,
      status: 'created', warehouse_type: 'RFBS', pause_at: null }] }
  };
  const transport = createOzonDEHttpTransport({ productionBindings: configuration.productionBindings,
    credentialBindings: configuration.ozonDECredentialBindings, readSecret: async () => { secretReads++; return 'synthetic-secret'; },
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url).pathname; assert.ok(Object.hasOwn(responses, endpoint));
      requests.push({ endpoint, body: options.body });
      return new Response(JSON.stringify(responses[endpoint]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  const resolver = createOzonAccountReadBindingResolver(configuration);
  const source = createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding: resolver });
  const reader = createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt: source.verifySourceReceipt });
  const provider = createOzonDEPreflightProvider({ readEvidence: reader, serverClock: clock });
  const de = createDEProductionRuntimeServices({ repository, runtimeMode: 'local_development', serverClock: clock, workerRegistry,
    deServiceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
    requestJson: transport.requestJson, inspectPlatform: provider.inspectPlatform, loadAdapterCapabilities: provider.loadAdapterCapabilities,
    upload: async () => { throw new Error('unexpected asset request'); }, resolveLocalAsset: async () => { throw new Error('unexpected asset read'); },
    preflightRequestMode: 'persisted_evidence_only' });
  const services = createOzonAccountReadServices({ configuration, repository, workerRegistry, serverClock: clock,
    requestJson: transport.requestJson, evidenceSource: source, preflightProvider: provider, deRuntimeServices: de });
  const preparation = services.preparation({ candidate: base.candidate, document: base.document }), option = preparation.options[0];
  const input = { candidateId: base.candidate.id, skuPackageId: preparation.skuPackageId, expectedRevision: preparation.expectedRevision,
    bindingId: option.bindingId, configurationVersion: option.configurationVersion, scopeRef: option.scopeRef,
    expiresAt: '2026-09-01T00:00:00.000Z', confirmReadOnce: true, idempotencyKey: 'owner-read:source-integration' };
  return { base, env, configuration, repository, source, reader, provider, services, input, requests, responses, get secretReads() { return secretReads; } };
}

async function authorizeProduction(f) {
  return commitSingleOwnerProductionAuthorization({ ...f.base.owner.args, repository: f.repository });
}

test('real local transport, pre-PA read and later PA use the same saved source without repeating account requests', async () => {
  const f = await fixture(), original = await f.repository.readSnapshot();
  assert.equal(f.secretReads, 0); assert.deepEqual(f.requests, []);
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  assert.equal(read.status, 'completed'); assert.equal(read.requestsSent, 3); assert.equal(read.productionStatus, null);
  const observed = await f.repository.readSnapshot(); assert.deepEqual(observed.candidates, original.candidates);
  assert.equal(JSON.stringify(observed).includes('private-tax-value'), false);
  assert.equal(JSON.stringify(observed).includes('synthetic-secret'), false);
  assert.deepEqual(f.requests.map(value => value.endpoint), ['/v1/roles', '/v1/seller/info', '/v2/warehouse/list']);
  assert.equal(f.requests[0].body, undefined); assert.equal(f.requests[1].body, undefined);
  assert.deepEqual(JSON.parse(f.requests[2].body), { limit: 1, warehouse_ids: [f.base.binding.warehouseId] });
  const saved = await authorizeProduction(f), dRef = saved.result.softwareJobRef;
  const continuation = await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: dRef.jobId, expectedRevision: saved.candidate.dataRevision });
  assert.equal(continuation.status, 'account_evidence_gaps'); assert.equal(f.requests.length, 3);
  const document = await f.repository.readSnapshot(), sku = document.candidates[0].lifecycleV11.skuPackage;
  const dJob = document.runtime.softwareJobs.find(job => job.jobId === dRef.jobId);
  assert.equal(dJob.status, 'queued'); assert.equal(dJob.attempt, 0); assert.equal(dJob.externalRequestState, 'not_sent');
  const record = document.runtime.ozonDEPreflightEvidence[sku.productionAuthorization.authorizationId];
  assert.deepEqual(await f.reader(record.scope), record);
  assert.equal(record.inspection.connections.api.status, 'connected');
  assert.equal(record.inspection.permissionStatus, 'verified');
  assert.equal(record.inspection.storeIdentityStatus, 'unverified'); assert.equal(record.inspection.priceFieldCurrency, 'unknown');
  assert.equal(record.inspection.connections.sellerBackend.status, 'unknown'); assert.equal(record.protocols.productImport, null);
  assert.equal(record.schemaVersion, 'ozon-de-preflight-evidence-v3');
  assert.deepEqual(record.protocols,{productImport:null,inventoryWrite:null,independentReadback:null});
  assert.equal(record.inspection.risks.some(risk => risk.code === 'account_seller_backend_not_checked'), false);
  const preparation = f.services.preparation({ candidate: document.candidates[0], document });
  assert.equal(preparation.runtime[0].isCurrent, true, 'pre-PA receipt remains visible after the production decision');
  assert.equal(preparation.runtime[0].canContinue, false);
  const before = await f.repository.readSnapshot();
  await f.source.publish({ scope: record.scope, jobId: read.jobId });
  assert.deepEqual(await f.repository.readSnapshot(), before, 'same source publication is idempotent');
  assert.equal(Object.hasOwn(sku, 'dAssetTransport'), false); assert.equal(Object.hasOwn(sku, 'dSoftwareExecution'), false);
});

test('versioned source keeps old method evidence unchanged and never expands it to the exact warehouse method', async () => {
  const f = await fixture();
  f.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', '/v2/products/stocks',
    OZON_PRODUCT_IMPORT_INFO_ENDPOINT, ...Object.values(OZON_DE_LEGACY_READBACK_ENDPOINTS)];
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f), authorization = saved.candidate.lifecycleV11.skuPackage.productionAuthorization;
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId,
    expectedRevision: saved.candidate.dataRevision });
  const current = await f.repository.readSnapshot(), record = current.runtime.ozonDEPreflightEvidence[authorization.authorizationId];
  assert.equal(record.inspection.permissionStatus, 'denied');
  const legacy = composeOzonAccountPreflightEvidence({ scope: record.scope,
    receipt: current.runtime.ozonAccountReadReceipts[read.jobId], authorization, schemaVersion: 'ozon-de-preflight-evidence-v1' });
  assert.equal(legacy.inspection.permissionStatus, 'verified');
  assert.ok(legacy.inspection.risks.some(risk => risk.code === 'account_seller_backend_not_checked'));
  assert.notEqual(legacy.evidenceId, record.evidenceId);
  assert.equal((await f.source.verifySourceReceipt(legacy, legacy.scope)).status, 'verified');
  const versionTwo=composeOzonAccountPreflightEvidence({scope:record.scope,receipt:current.runtime.ozonAccountReadReceipts[read.jobId],authorization,schemaVersion:'ozon-de-preflight-evidence-v2'});
  assert.equal(versionTwo.inspection.permissionStatus,'denied');assert.notEqual(versionTwo.evidenceId,record.evidenceId);
  assert.equal((await f.source.verifySourceReceipt(versionTwo,versionTwo.scope)).status,'verified');
  const promoted=structuredClone(versionTwo);promoted.schemaVersion='ozon-de-preflight-evidence-v3';
  await assert.rejects(()=>f.source.verifySourceReceipt(promoted,promoted.scope),/ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  const relabelled = structuredClone(legacy); relabelled.schemaVersion = 'ozon-de-preflight-evidence-v2';
  await assert.rejects(() => f.source.verifySourceReceipt(relabelled, relabelled.scope), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  await f.repository.transact(document => {
    document.runtime.ozonDEPreflightEvidence[authorization.authorizationId] = structuredClone(legacy);
    document.runtime.ozonDEPreflightEvidenceVersions[authorization.authorizationId] = [structuredClone(legacy)];
    return { changed: true, document };
  });
  const before = await f.repository.readSnapshot(), counts = { requests: f.requests.length, secrets: f.secretReads };
  assert.equal((await f.source.publish({ scope: record.scope, jobId: read.jobId })).status, 'published');
  const after = await f.repository.readSnapshot();
  assert.deepEqual(after.runtime.ozonDEPreflightEvidenceVersions[authorization.authorizationId], [legacy, record]);
  for (const field of ['ozonAccountReadReceipts', 'softwareJobs', 'softwareJobAuthorizationRecords', 'softwareJobCredentialBindings']) {
    assert.deepEqual(after.runtime[field], before.runtime[field]);
  }
  assert.equal(after.runtime.ozonDEPreflightEvidence[authorization.authorizationId].inspection.permissionStatus, 'denied');
  assert.equal(f.requests.length, counts.requests); assert.equal(f.secretReads, counts.secrets);
  assert.equal(f.requests.length, 3);
});

test('a later genuine failed source supersedes a saved success at the verifier and publication boundaries', async () => {
  const f = await fixture(), read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot(), record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  // A second independently produced historical receipt models an older producer's saved attempt.
  const later = await fixture({ clockOffsetMs: 1000 }); later.responses['/v1/roles'] = {};
  const failed = await later.services.authorizeAndRun({ actor: later.base.owner.args.actor,
    input: { ...later.input, idempotencyKey: 'owner-read:later-history' } });
  assert.equal(failed.status, 'failed');
  const laterDocument = await later.repository.readSnapshot();
  await f.repository.transact(document => {
    for (const collection of ['softwareJobs', 'softwareJobAuthorizationRecords', 'softwareJobCredentialBindings']) {
      document.runtime[collection].push(...laterDocument.runtime[collection]);
    }
    Object.assign(document.runtime.ozonAccountReadReceipts, laterDocument.runtime.ozonAccountReadReceipts);
    return { changed: true, document };
  });
  await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_SUPERSEDED/);
  await assert.rejects(() => f.source.publish({ scope: record.scope, jobId: read.jobId }), /ACCOUNT_SOURCE_SUPERSEDED/);
  assert.deepEqual((await f.repository.readSnapshot()).runtime.ozonDEPreflightEvidence, original.runtime.ozonDEPreflightEvidence);
  assert.equal(f.requests.length, 3); assert.equal(later.requests.length, 1);
});

test('source reconstruction validates author identity, credential validity and every D/E method permission', async () => {
  const f = await fixture(); f.responses['/v1/roles'].roles[0].methods = ['/v3/product/import', '/v2/products/stocks'];
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input }), saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot(), record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  assert.equal(record.inspection.permissionStatus, 'denied');
  assert.ok(record.inspection.risks.some(value => value.code === 'account_method_permissions_incomplete'));
  for (const change of ['owner', 'future_binding', 'expired_credential']) {
    await f.repository.transact(() => {
      const document = structuredClone(original), runtime = document.runtime;
      if (change === 'owner') runtime.softwareJobAuthorizationRecords.find(value => value.consumedByJobId === read.jobId).authorizedByUserId = 'owner:other';
      else {
        const credential = runtime.softwareJobCredentialBindings.find(value => value.sideEffectScope === 'ozon_account_read');
        if (change === 'future_binding') credential.boundAt = '2026-08-31T23:00:00.000Z';
        else credential.expiresAt = credential.boundAt;
      }
      return { changed: true, document };
    });
    await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_(AUTHORIZATION_INVALID|CREDENTIAL_INVALID|INVALID)/);
  }
  assert.equal(f.requests.length, 3);
});

test('source verifier rejects changed factual content, missing consumed authorization, and changed Client ID under an unchanged alias', async () => {
  const f = await fixture(), read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const saved = await authorizeProduction(f);
  await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  const original = await f.repository.readSnapshot();
  const record = original.runtime.ozonDEPreflightEvidence[saved.candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId];
  const tampered = structuredClone(record); tampered.inspection.platformWritableFields = ['title'];
  await assert.rejects(() => f.source.verifySourceReceipt(tampered, record.scope), /ACCOUNT_SOURCE_CONTENT_MISMATCH/);
  const changedConfig = createSelectionReviewRuntimeConfiguration({ env: { ...f.env,
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify([{ credentialAlias: f.base.binding.credentialAlias,
      clientId: '700124', keychainService: 'synthetic-account-source', keychainAccount: 'synthetic-account' }]) },
    appDir: '/tmp/synthetic-account-integration', argv: [] });
  const other = createOzonAccountReadEvidenceSource({ repository: f.repository, loadCurrentReadBinding: createOzonAccountReadBindingResolver(changedConfig) });
  await assert.rejects(() => other.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_CONFIGURATION_CHANGED/);
  await f.repository.transact(document => { document.runtime.softwareJobAuthorizationRecords = document.runtime.softwareJobAuthorizationRecords
    .filter(value => value.consumedByJobId !== read.jobId); return { changed: true, document }; });
  await assert.rejects(() => f.source.verifySourceReceipt(record, record.scope), /ACCOUNT_SOURCE_AUTHORIZATION_INVALID/);
  assert.equal(f.requests.length, 3);
});

test('new PA waits before D claim without reading credentials when no account permission exists', async () => {
  const f = await fixture(), saved = await authorizeProduction(f);
  const result = await f.services.continueProduction({ candidateId: f.input.candidateId, jobId: saved.result.softwareJobRef.jobId, expectedRevision: saved.candidate.dataRevision });
  assert.equal(result.status, 'awaiting_account_read'); assert.equal(f.secretReads, 0); assert.deepEqual(f.requests, []);
  const document = await f.repository.readSnapshot(), job = document.runtime.softwareJobs.find(value => value.jobId === saved.result.softwareJobRef.jobId);
  assert.equal(job.status, 'queued'); assert.equal(job.attempt, 0); assert.equal(job.externalRequestState, 'not_sent');
});

test('account routing requires an explicit binding and detects Client ID or configuration drift without inventing platform verification', async () => {
  const f = await fixture(), document = await f.repository.readSnapshot(), resolver = createOzonAccountReadBindingResolver(f.configuration);
  assert.equal(resolver({ document, candidateId: f.input.candidateId, skuPackageId: f.input.skuPackageId }), null);
  const binding = resolver({ document, ...f.input });
  assert.equal(binding.scopeRef, f.input.scopeRef); assert.equal(Object.hasOwn(binding, 'verification'), false);
  const changed = { ...f.configuration, ozonDECredentialBindings: [{ ...f.configuration.ozonDECredentialBindings[0], clientId: '700124' }] };
  assert.notEqual(accountReadBindingForProduction(changed, f.base.binding).scopeRef, binding.scopeRef);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({ env: { ...f.env,
    SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: JSON.stringify([{ ...f.configuration.ozonAccountReadServiceBindings[0], workerId: f.base.service.workerId }]) },
    appDir: '/tmp/synthetic-account-integration', argv: [] }), /Worker/);
  assert.equal(f.secretReads, 0);
});

test('queued read view checks current persisted permission without reading credentials or consuming authorization again', async () => {
  const f = await fixture(), serverClock = () => f.base.owner.formal.at;
  const configured = f.configuration.ozonAccountReadServiceBindings[0];
  const runtime = createOzonAccountReadRuntime({ repository: f.repository, serverClock,
    workerRegistry: createLocalDevelopmentWorkerRegistry({ clock: serverClock }),
    worker: { workerId: configured.workerId, version: configured.workerVersion, leaseDurationMs: configured.leaseDurationMs },
    loadCurrentReadBinding: createOzonAccountReadBindingResolver(f.configuration),
    requestJson: async () => { throw new Error('queued view made a request'); } });
  await runtime.authorizeAndEnqueue({ actor: f.base.owner.args.actor, input: f.input });
  let document = await f.repository.readSnapshot();
  assert.equal(f.services.preparation({ candidate: document.candidates[0], document }).runtime[0].canContinue, true);
  await f.repository.transact(current => { current.runtime.softwareJobAuthorizationRecords = []; return { changed: true, document: current }; });
  document = await f.repository.readSnapshot();
  const view = f.services.preparation({ candidate: document.candidates[0], document }).runtime[0];
  assert.equal(view.canContinue, false); assert.equal(view.admissionBlocker, 'SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED');
  assert.deepEqual(await f.repository.readSnapshot(), document); assert.equal(f.secretReads, 0); assert.equal(f.requests.length, 0);
});

test('historical v2 SKU preparation reads absent runtime without changing the document or accessing providers', async () => {
  const f = await fixture(), document = await f.repository.readSnapshot();
  delete document.runtime;
  assert.ok(document.candidates[0].lifecycleV11.skuPackage);
  const before = JSON.stringify(document);
  Object.freeze(document);
  const view = f.services.preparation({ candidate: document.candidates[0], document });
  assert.deepEqual(view.runtime, []);
  assert.equal(view.options.length, 1);
  assert.equal(JSON.stringify(document), before);
  assert.equal(Object.hasOwn(document, 'runtime'), false);
  assert.equal(f.secretReads, 0);
  assert.deepEqual(f.requests, []);
});

test('account preparation rejects malformed runtime collections instead of treating them as absent history', async () => {
  const f = await fixture(), original = await f.repository.readSnapshot();
  for (const runtime of [null, [], false, 0, 'invalid', { softwareJobs: null }, { softwareJobs: {} },
    { ozonAccountReadReceipts: null }, { ozonAccountReadReceipts: [] }, { ozonAccountReadReceipts: false }]) {
    const document = { ...original, runtime }, before = JSON.stringify(document);
    assert.throws(() => f.services.preparation({ candidate: document.candidates[0], document }),
      { code: 'OZON_ACCOUNT_READ_REPOSITORY_INVALID' });
    assert.equal(JSON.stringify(document), before);
  }
  assert.equal(f.secretReads, 0);
  assert.deepEqual(f.requests, []);
});

test('saved account receipts remain visible and explicit corrupt receipt entries fail read-only projection', async () => {
  const f = await fixture();
  const read = await f.services.authorizeAndRun({ actor: f.base.owner.args.actor, input: f.input });
  const document = await f.repository.readSnapshot(), before = JSON.stringify(document);
  const view = f.services.preparation({ candidate: document.candidates[0], document });
  assert.equal(view.runtime[0].jobId, read.jobId);
  assert.equal(view.runtime[0].status, 'completed');
  assert.equal(view.runtime[0].requestsSent, 3);
  assert.deepEqual(view.runtime[0].observedMethods, ['roles', 'seller_info', 'warehouse_list']);
  assert.equal(view.runtime[0].companyCurrency, 'CNY');
  assert.equal(JSON.stringify(document), before);
  for (const receipt of [null, false, 0, {}]) {
    const corrupt = structuredClone(document);
    corrupt.runtime.ozonAccountReadReceipts[read.jobId] = receipt;
    const saved = JSON.stringify(corrupt);
    assert.throws(() => f.services.preparation({ candidate: corrupt.candidates[0], document: corrupt }),
      error => error.name === 'OzonAccountReadError');
    assert.equal(JSON.stringify(corrupt), saved);
  }
  assert.equal(f.requests.length, 3);
  assert.equal(f.secretReads, 3);
});
