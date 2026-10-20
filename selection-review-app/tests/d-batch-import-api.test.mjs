import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { threeColorC2Fixture, at } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { assertOzonProductImportBatchLimitUse, loadOzonProductImportBatchLimitEvidence,
  loadOzonProductImportBatchLimitFact } from '../lib/ozon-product-import-batch-limit.mjs';
import { accountReadConcurrencyFixture } from './helpers/account-read-concurrency-fixture.mjs';

const { api: port } = allocatedTestPorts();

test('authenticated three-color HTTP authorization refuses a persisted queued account read before any member changes, including after restart',async t=>{
  const fixture=await productionOwnerDecisionHttpFixture(),family=await threeColorC2Fixture(3);
  await commitSiblingBatchC2Final({repository:family.repository,runtimeMode:'local_development',actor:family.actor,
    input:family.input,verifiedAssets:family.verifiedAssets,serverClock:()=>at});
  const prepared=await family.repository.readSnapshot(),parent=prepared.candidates[0];
  const owners=prepared.candidates.slice(1).map(child=>productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    {sourceCandidate:child,sourceAt:at}));
  fixture.document.candidates=[parent,...owners.map(owner=>owner.candidate)];
  fixture.document.evidencePacks=owners[0].evidencePacks.map(pack=>({...pack,expiresAt:'2099-01-01T00:00:00.000Z'}));
  fixture.document.currentCommissionCatalogs=owners[0].currentCommissionCatalogs;
  const repository=createMemoryBusinessStateRepository(fixture.document),account=await accountReadConcurrencyFixture({repository,
    clock:()=>new Date().toISOString(),productionBinding:fixture.binding,candidateId:owners[2].candidate.id});
  const queued=await account.enqueue();assert.equal(queued.status,'queued');assert.deepEqual(account.requests,[]);
  const directory=await mkdtemp(path.join(tmpdir(),'batch-account-guard-http-'));
  const api=await startSavedDEApi(t,{directory,port,document:await repository.readSnapshot(),binding:fixture.binding,services:[]});
  await api.authenticate();const before=await api.readBytes();
  const members=owners.map((owner,index)=>({candidateId:owner.candidate.id,ownerInput:{...owner.args.input,merchantSku:`HTTP-GUARD-COLOR-${index}`}}));
  const input={confirmAll:true,parentCandidateId:parent.id,parentRevision:parent.dataRevision,excludedOfferIds:['SYNTHETIC-FIRST-UNKNOWN'],members,
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',eReadbackOfferIds:members.map(member=>member.ownerInput.merchantSku)}};
  for(let attempt=0;attempt<2;attempt++){
    if(attempt){await api.restart();await api.authenticate('login');}
    const response=await api.post('/api/d-batches/authorize',input);
    assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.code,'D_BATCH_ACCOUNT_READ_IN_PROGRESS');
    assert.deepEqual(await api.readBytes(),before);assert.equal(api.dependencyRequests(),0);
    const saved=await api.readDocument();assert.deepEqual(saved.candidates,fixture.document.candidates);
    assert.equal(saved.runtime.dProductionBatches?.length??0,0);assert.equal(saved.runtime.dBatchImportJobs?.length??0,0);
    assert.equal(saved.candidates.slice(1).some(candidate=>candidate.lifecycleV11.skuPackage.productionAuthorization),false);
  }
  await api.assertClean();
});

test('one authenticated batch confirmation persists authorization and reports missing account routing without an external request', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-import-api-'));
  const family=await threeColorC2Fixture(1);
  await commitSiblingBatchC2Final({repository:family.repository,runtimeMode:'local_development',
    actor:family.actor,input:family.input,verifiedAssets:family.verifiedAssets,serverClock:()=>at});
  const prepared=await family.repository.readSnapshot();
  const parent=prepared.candidates[0];
  const owner=productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    {sourceCandidate:prepared.candidates[1],sourceAt:at});
  fixture.document.candidates=[parent,owner.candidate];
  fixture.document.evidencePacks=owner.evidencePacks.map(pack=>({...pack,expiresAt:'2099-01-01T00:00:00.000Z'}));
  fixture.document.currentCommissionCatalogs=owner.currentCommissionCatalogs;
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document,
    binding: fixture.binding, services: [] });
  const input={confirmAll:true,parentCandidateId:parent.id,parentRevision:parent.dataRevision,
    excludedOfferIds:['SYNTHETIC-FIRST-UNKNOWN'],
    members:[{candidateId:owner.candidate.id,ownerInput:{...owner.args.input,
      merchantSku:'SYNTHETIC-COLOR-API'}}],
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:['SYNTHETIC-COLOR-API']}};
  const denied = await api.post('/api/d-batches/authorize', input, { authenticated: false });
  assert.equal(denied.status, 401);
  const before = await api.readBytes();
  await api.authenticate();
  const crossSite = await api.post('/api/d-batches/authorize', input,
    { headers: { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await api.readBytes(), before);
  const legacy=structuredClone(input);
  delete legacy.parentCandidateId;delete legacy.parentRevision;
  const missingParent=await api.post('/api/d-batches/authorize',legacy);
  assert.equal(missingParent.status,400,JSON.stringify(missingParent.body));
  assert.equal(missingParent.body.code,'D_BATCH_AUTHORIZATION_INPUT_INVALID');
  assert.deepEqual(await api.readBytes(),before);
  const confirmed = await api.post('/api/d-batches/authorize', input);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.executionStatus,'prewrite_blocked');
  assert.equal(confirmed.body.executionView.members[0].offerId,'SYNTHETIC-COLOR-API');
  assert.equal(confirmed.body.reasonCode,'OZON_ACCOUNT_READ_BATCH_ACCOUNT_ROUTING_UNAVAILABLE');
  assert.equal(confirmed.body.externalRequests, 0);
  const replay = await api.post('/api/d-batches/authorize', input);
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  assert.equal(replay.body.batch.batchId,confirmed.body.batch.batchId);
  const detail=await api.get(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}`);
  assert.equal(detail.status,200);
  assert.equal(detail.body.members[0].importStatus,'not_started');
  const resume=await api.post(`/api/d-batches/${encodeURIComponent(confirmed.body.batch.batchId)}/resume`,
    {confirmUnsentStockContinuation:true});
  assert.equal(resume.status,422);
  assert.equal(resume.body.code,'DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT');
  const saved = await api.readDocument();
  assert.equal(saved.runtime.dProductionBatches.length,1);
  assert.equal(saved.runtime.dBatchImportJobs, undefined);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});

test('wired three-color authorization freezes the current official fact for this batch without the expired legacy TTL or an external request', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-import-wired-api-'));
  const family = await threeColorC2Fixture(3);
  await commitSiblingBatchC2Final({ repository: family.repository, runtimeMode: 'local_development',
    actor: family.actor, input: family.input, verifiedAssets: family.verifiedAssets, serverClock: () => at });
  const prepared = await family.repository.readSnapshot();
  const parent = prepared.candidates[0];
  const owners = prepared.candidates.slice(1).map(child => productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    { sourceCandidate: child, sourceAt: at }));
  assert.equal(owners.length, 3);
  fixture.document.candidates = [parent, ...owners.map(owner => owner.candidate)];
  fixture.document.evidencePacks = owners[0].evidencePacks.map(pack => ({ ...pack, expiresAt: '2099-01-01T00:00:00.000Z' }));
  fixture.document.currentCommissionCatalogs = owners[0].currentCommissionCatalogs;
  const fact = await loadOzonProductImportBatchLimitFact();
  const legacy = await loadOzonProductImportBatchLimitEvidence();
  assert.ok(Date.parse(fact.observedAt) > Date.parse(legacy.validUntil), 'the new public fact was observed after the legacy local TTL');
  assert.equal(Object.hasOwn(fact, 'validUntil'), false);
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
    services: [], accountReadServices: [], credentialBindings: [{ credentialAlias: fixture.binding.credentialAlias,
      clientId: '700123', keychainService: 'synthetic-batch-import-wired', keychainAccount: 'synthetic-no-secret' }] });
  await api.authenticate();
  const state = await api.get('/api/state');
  assert.equal(state.status, 200, JSON.stringify({ body: state.body, stderr: api.stderr }));
  for (const owner of owners) {
    const candidate = state.body.candidates.find(candidate => candidate.id === owner.candidate.id);
    assert.deepEqual(candidate.ozonAccountReadPreparation.options, [], 'credentials alone do not supply an account read service or grant a read');
    assert.deepEqual(candidate.ozonAccountReadPreparation.runtime, []);
  }
  const input = { confirmAll: true, parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    excludedOfferIds: ['SYNTHETIC-FIRST-UNKNOWN'],
    members: owners.map((owner, index) => ({ candidateId: owner.candidate.id,
      ownerInput: { ...owner.args.input, merchantSku: `SYNTHETIC-WIRED-COLOR-${index}` } })),
    importLimitUse: { schemaVersion: 'ozon-product-import-batch-limit-use-input-v1',
      evidenceRef: fact.evidenceRef, decision: 'use_for_this_batch_once' },
    postImportScope: { schemaVersion: 'd-batch-post-import-scope-v2', inventoryAction: 'create_only',
      eReadbackOfferIds: owners.map((_, index) => `SYNTHETIC-WIRED-COLOR-${index}`), inSaleList: {
        schemaVersion: 'ozon-in-sale-list-authorization-v1', decision: 'read_store_in_sale_list_for_batch',
        officialEvidenceRef: 'official:ozon-in-sale-list:20261018',
        policy: { pageSize: 1000, maxPages: 3, requestTimeoutMs: 30000, durationMs: 90000 } } } };
  const confirmed = await api.post('/api/d-batches/authorize', input);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.executionStatus, 'prewrite_blocked');
  assert.equal(confirmed.body.reasonCode, 'OZON_ACCOUNT_READ_BATCH_SERVICE_NOT_CONFIGURED');
  assert.equal(confirmed.body.externalRequests, 0);
  assert.equal(confirmed.body.platformWrites, 0);
  const batch = confirmed.body.batch;
  assert.equal(batch.schemaVersion, 'd-batch-production-authorization-v3');
  assert.deepEqual(batch.members.map(member => member.offerId), input.postImportScope.eReadbackOfferIds);
  assert.deepEqual(batch.excludedOfferIds, ['SYNTHETIC-FIRST-UNKNOWN']);
  assert.deepEqual(batch.postImportScope, input.postImportScope);
  assert.equal(batch.importLimitUse.evidenceRef, fact.evidenceRef);
  assert.equal(batch.importLimitUse.decision, 'use_for_this_batch_once');
  assert.equal(batch.importLimitUse.importJobId, `d-batch-import:${batch.batchId}`);
  assert.ok(Date.parse(batch.importLimitUse.confirmedAt) > Date.parse(legacy.validUntil));
  assert.deepEqual(assertOzonProductImportBatchLimitUse(batch.importLimitUse, { batch }), batch.importLimitUse);
  assert.deepEqual(batch.importLimitUse.members.map(member => [member.candidateId, member.resultRevision]),
    batch.members.map(member => [member.candidateId, member.resultRevision]));
  const saved = await api.readDocument();
  assert.deepEqual(saved.candidates.find(candidate => candidate.id === parent.id), parent, 'the unknown historical parent is never reused as a batch member');
  assert.equal(saved.runtime.dProductionBatches.length, 1);
  assert.equal(saved.runtime.dBatchImportJobs, undefined);
  assert.equal(saved.runtime.ozonAccountReadJobs?.length ?? 0, 0);
  const bytes = await api.readBytes();
  const replay = await api.post('/api/d-batches/authorize', input);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.batch, batch);
  assert.equal(replay.body.reasonCode, confirmed.body.reasonCode);
  assert.deepEqual(await api.readBytes(), bytes);
  assert.equal(api.dependencyRequests(), 0);
  await api.assertClean();
});
