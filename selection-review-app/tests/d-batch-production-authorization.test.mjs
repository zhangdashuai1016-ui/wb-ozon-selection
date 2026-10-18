import test from 'node:test';
import assert from 'node:assert/strict';
import { threeColorC2Fixture, at } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitBatchOwnerProductionAuthorization } from '../lib/d-batch-production-authorization.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { assertOzonProductImportBatchLimitUse } from '../lib/ozon-product-import-batch-limit.mjs';

const schemaValidator = await loadPublishedSchemaValidator();

async function fixture(count=1) {
  const {repository,actor,input:c2Input,verifiedAssets}=await threeColorC2Fixture(count);
  await commitSiblingBatchC2Final({repository,runtimeMode:'local_development',actor,
    input:c2Input,verifiedAssets,serverClock:()=>at});
  const before=await repository.readSnapshot();
  const decisions=before.candidates.slice(1).map((child,index)=>{
    const owner=productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
      {sourceCandidate:child,sourceAt:at});
    return {candidate:owner.candidate,ownerInput:{...owner.args.input,
      merchantSku:`SYNTHETIC-COLOR-${index}`},owner};
  });
  await repository.transact(document=>{
    document.candidates.splice(1,decisions.length,...decisions.map(value=>structuredClone(value.candidate)));
    document.evidencePacks=structuredClone(decisions[0].owner.evidencePacks);
    document.currentCommissionCatalogs=structuredClone(decisions[0].owner.currentCommissionCatalogs);
    return {changed:true,document,result:null};
  });
  const parent=(await repository.readSnapshot()).candidates[0];
  const input={confirmAll:true,parentCandidateId:parent.id,parentRevision:parent.dataRevision,
    excludedOfferIds:['SYNTHETIC-FIRST-UNKNOWN'],
    members:decisions.map(value=>({candidateId:value.candidate.id,ownerInput:value.ownerInput})),
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:decisions.map(value=>value.ownerInput.merchantSku)}};
  const source={repository,candidate:decisions[0].candidate};
  const args={repository,runtimeMode:'local_development',actor,
    configuration:decisions[0].owner.configuration,serverClock:()=>at};
  return {source,input,args};
}
async function twoMemberFixture() {
  const {source,input,args}=await fixture(2);
  return {repository:source.repository,input,args};
}

function currentInput(input) {
  return {...input,importLimitUse:{schemaVersion:'ozon-product-import-batch-limit-use-input-v1',
    evidenceRef:'official:ozon-product-import-batch-limit:20261018',decision:'use_for_this_batch_once'},
    postImportScope:{...input.postImportScope,schemaVersion:'d-batch-post-import-scope-v2',inSaleList:{
      schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
      officialEvidenceRef:'official:ozon-in-sale-list:20261018',
      policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}}};
}

test('explicit current batch freezes one import-limit adoption and list scope atomically and idempotently',async()=>{
  const f=await fixture(),input=currentInput(f.input),now='2026-10-18T13:15:00.000Z';
  const configuration=structuredClone(f.args.configuration);
  for(const binding of configuration.productionBindings) binding.verification.expiresAt='2026-11-01T00:00:00.000Z';
  await f.source.repository.transact(document=>{
    // The isolated fixture explicitly keeps its synthetic cost sources usable at the new test clock.
    for(const pack of document.evidencePacks) pack.expiresAt='2026-11-01T00:00:00.000Z';
    return {changed:true,document,result:null};
  });
  const args={...f.args,configuration,serverClock:()=>now};
  const batch=await commitBatchOwnerProductionAuthorization({...args,input});
  assert.equal(batch.schemaVersion,'d-batch-production-authorization-v3');
  assert.equal(batch.postImportScope.schemaVersion,'d-batch-post-import-scope-v2');
  assert.equal(batch.importLimitUse.confirmedBy,f.args.actor.userId);
  assert.equal(batch.importLimitUse.confirmedAt,now);
  assert.equal(batch.importLimitUse.importJobId,`d-batch-import:${batch.batchId}`);
  assert.equal(assertOzonProductImportBatchLimitUse(batch.importLimitUse,{batch}),batch.importLimitUse);
  assert.deepEqual(batch.importLimitUse.members.map(member=>member.resultRevision),batch.members.map(member=>member.resultRevision));
  const saved=await f.source.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs?.length??0,0);
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({...args,input}),batch);
  assert.deepEqual(await f.source.repository.readSnapshot(),saved);
  assert.throws(()=>assertOzonProductImportBatchLimitUse(batch.importLimitUse,{batch:{...batch,ownerActorId:'other-owner'}}),/SCOPE_MISMATCH/);
  await f.source.repository.transact(document=>{
    document.runtime.dProductionBatches[0].postImportScope.inventoryAction='write_authorized_stock';
    return {changed:true,document,result:null};
  });
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...args,input}),/D_BATCH_REPLAY_CONFLICT/);
});

test('new batch facts cannot be adopted before observation or injected into a legacy scope',async()=>{
  const f=await fixture(),before=await f.source.repository.readSnapshot();
  const input=currentInput(f.input);
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...f.args,input}),/LIMIT_USE_INVALID/);
  const {importLimitUse,...withoutUse}=input;
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...f.args,input:withoutUse}),/POST_IMPORT_SCOPE_INVALID/);
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...f.args,input:{...f.input,importLimitUse}}),/POST_IMPORT_SCOPE_INVALID/);
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...f.args,input:{...input,
    importLimitUse:{...importLimitUse,batchId:'client-supplied'}}}),/LIMIT_USE_INPUT_INVALID/);
  assert.deepEqual(await f.source.repository.readSnapshot(),before);
});

test('two member authorization is atomic and each member gets its own identity', async () => {
  const { repository, input, args } = await twoMemberFixture();
  const batch = await commitBatchOwnerProductionAuthorization({ ...args, input });
  assert.equal(batch.members.length, 2);
  assert.deepEqual(batch.postImportScope.eReadbackOfferIds,batch.members.map(member=>member.offerId));
  assert.equal(new Set(batch.members.map(member => member.authorizationId)).size, 2);
  const saved = await repository.readSnapshot();
  const validateAuthorization = schemaValidator.getSchema('production-authorization-v1.2');
  for (const candidate of saved.candidates.filter(candidate => candidate.id !== input.parentCandidateId)) {
    const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
    assert.equal(validateAuthorization(authorization), true, JSON.stringify(validateAuthorization.errors));
  }
  assert.equal(saved.candidates.filter(candidate => candidate.id!==input.parentCandidateId&&
    candidate.lifecycleV11.skuPackage.productionAuthorization).length, 2);
  const stale = await twoMemberFixture();
  stale.input.members[1].ownerInput.dataRevision += 1;
  const staleBefore = await stale.repository.readSnapshot();
  await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...stale.args, input: stale.input }));
  assert.deepEqual(await stale.repository.readSnapshot(), staleBefore);
});

test('one batch decision saves a member authorization and a batch reservation atomically', async () => {
  const { source, input, args } = await fixture();
  const first = await commitBatchOwnerProductionAuthorization({ ...args, input });
  assert.equal(first.status, 'authorized');
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].status, 'authorized');
  const saved = await source.repository.readSnapshot();
  assert.equal(saved.runtime.dProductionBatches.length, 1);
  const child=saved.candidates.find(candidate=>candidate.id===source.candidate.id);
  assert.equal(child.dataRevision,source.candidate.dataRevision+1);
  assert.equal(child.lifecycleV11.skuPackage.productionAuthorization.authorizationId,
    first.members[0].authorizationId);
  assert.equal(child.lifecycleV11.skuPackage.productionRecord,null);
  assert.equal(saved.runtime.softwareJobs?.some(job=>job.jobType==='d_production_execution'),false);
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({ ...args, input }), first);
  assert.deepEqual(await source.repository.readSnapshot(), saved);
});

test('stale revision, exclusion and existing unknown outcome leave every record unchanged', async () => {
  for (const change of [
    input => { input.members[0].ownerInput.dataRevision += 1; },
    input => { input.excludedOfferIds.push(input.members[0].ownerInput.merchantSku); }
  ]) {
    const { source, input, args } = await fixture();
    change(input);
    const before = await source.repository.readSnapshot();
    await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...args, input }));
    assert.deepEqual(await source.repository.readSnapshot(), before);
  }
  const { source, input, args } = await fixture();
  await source.repository.transact(document => {
    document.candidates.find(candidate=>candidate.id===source.candidate.id)
      .lifecycleV11.skuPackage.technicalStatus = 'unknown_outcome';
    return { changed: true, document, result: null };
  });
  const before = await source.repository.readSnapshot();
  await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...args, input }), /ALREADY_STARTED/);
  assert.deepEqual(await source.repository.readSnapshot(), before);
});
test('post-import action and exact E member scope require one explicit owner decision',async()=>{
 for(const change of [
  input=>{delete input.postImportScope;},
  input=>{input.postImportScope.inventoryAction='automatic';},
  input=>{input.postImportScope.eReadbackOfferIds=[];},
  input=>{input.postImportScope.eReadbackOfferIds=['OTHER-OFFER'];}
 ]){
  const {source,input,args}=await fixture();change(input);
  const before=await source.repository.readSnapshot();
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...args,input}),
    /D_BATCH_(POST_IMPORT_SCOPE|AUTHORIZATION_INPUT)_INVALID/);
  assert.deepEqual(await source.repository.readSnapshot(),before);
 }
});

test('an existing partial batch cannot capture a selected sibling, while exact historical replay stays read-only',async()=>{
  const occupied=await fixture();
  await occupied.source.repository.transact(document=>{
    document.runtime.dProductionBatches=[{batchId:'d-batch:prior-partial',members:[{
      candidateId:occupied.input.members[0].candidateId,offerId:'SYNTHETIC-OLD-CLAIM'}]}];
    return {changed:true,document,result:null};
  });
  const before=await occupied.source.repository.readSnapshot();
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...occupied.args,input:occupied.input}),
    /D_BATCH_SELECTED_MEMBERS_CHANGED/);
  assert.deepEqual(await occupied.source.repository.readSnapshot(),before);

  const historical=await fixture();
  const batch=await commitBatchOwnerProductionAuthorization({...historical.args,input:historical.input});
  await historical.source.repository.transact(document=>{
    document.candidates.find(candidate=>candidate.id===historical.input.parentCandidateId).dataRevision+=1;
    return {changed:true,document,result:null};
  });
  const saved=await historical.source.repository.readSnapshot();
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({...historical.args,
    input:historical.input}),batch);
  assert.deepEqual(await historical.source.repository.readSnapshot(),saved);
});
