import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {threeColorFixture} from './fixtures/sibling-batch-final-family-fixture.mjs';
import {startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs';
import {allocatedTestPorts} from './helpers/api-process-lifecycle.mjs';
import {createPreparationValues,preparationDraftScopeCurrent,preparationValuesEqual} from '../src/siblingPreparationState.js';
import {createJsonBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {writeSyntheticSiblingPreparationCatalog} from './fixtures/sibling-preparation-catalog-fixture.mjs';
import {currentCostRule,evidencePacks} from './fixtures/real-a-b-flow-fixture.mjs';

const {api:port}=allocatedTestPorts();

async function startPreparationApi(t,identityProvider='local_owner_password',prepareDocument=null) {
 const fixture=await threeColorFixture(),document=await fixture.repository.readSnapshot(),parent=document.candidates[0];
 for(const child of document.candidates.slice(1))delete child.targetPlatform;
 if(prepareDocument)prepareDocument(document);
 const directory=await mkdtemp(path.join(tmpdir(),'s1-preparation-api-'));
 const catalog=await writeSyntheticSiblingPreparationCatalog({document,tempDir:directory});
 const api=await startSavedDEApi(t,{directory,port,document,binding:{storeRef:parent.storeRef,platform:parent.targetPlatform},productionBindings:[],catalogDirectory:directory,identityProvider});
 const route=`/api/sibling-batches/${encodeURIComponent(parent.id)}`;
 return {api,document,parent,catalog,route};
}

/** Reuse the synthetic family with explicit pre-A inputs and an accepted parent card. */
async function startEvidencePreparationApi(t,{ready=false}={}) {
 return startPreparationApi(t,'local_owner_password',document=>{
  const parent=document.candidates[0],children=document.candidates.slice(1),sku=parent.lifecycleV11.skuPackage;
  const binding=children[0].siblingSourceV1.parentCardBinding;
  const assets=binding.parentImageSha256s.map(sha256=>({sha256}));
  sku.productionAuthorization={lockedScope:{supplierSkuId:sku.supplierSkuId,finalUploads:structuredClone(assets)}};
  sku.c2FinalAssets={productionAuthorizationPreparation:{finalUploads:structuredClone(assets)}};
  sku.dSoftwareExecution={checkpoints:[{kind:'import_task_received',taskId:'synthetic-parent-import'}],
   attempt:{request:{productImport:{body:{items:[{description_category_id:binding.descriptionCategoryId,type_id:binding.typeId,
    attributes:[{id:9048,values:[{value:binding.model}]},{id:85,values:[{value:binding.brand}]}]}]}}}}};
  parent.sourceCapture.priceRanges=[{minimumQuantity:1,priceCny:18,source:'synthetic:one-piece-price'}];
  for(const choice of parent.sourceCapture.skuChoices)choice.priceCny=18;
  for(const child of children) {
   delete child.lifecycleV11;
   delete child.lifecycleEvidenceContextV11;
   child.siblingSourceV1.parentRevision=parent.dataRevision;
   child.sourceCapture.skuChoices[0].priceCny=18;
  }
  document.rules.ozonDandanshu=currentCostRule({...children[0],lifecycleEvidenceContextV11:{salesScheme:'rfbs'}});
  document.evidencePacks=ready?evidencePacks().map(pack=>{
   pack.expiresAt='2099-01-01T00:00:00.000Z';
   if(['commission','schema'].includes(pack.kind))Object.assign(pack.scope,{store:parent.targetStore,
    storeRef:structuredClone(parent.storeRef),category:`ozon:${binding.descriptionCategoryId}:${binding.typeId}`});
   if(pack.kind==='schema') {
    pack.scope.ruleVersion='ozon-current';
    Object.assign(pack.evidenceData,{descriptionCategoryId:binding.descriptionCategoryId,typeId:binding.typeId});
   }
   if(pack.kind==='logistics_tariff')Object.assign(pack.scope,{route:'synthetic',ruleVersion:'guoo-2026-08-19'});
   return pack;
  }):[];
 });
}

async function saveEvidencePreparationDraft({api,document,parent,catalog,route}) {
 const values=createPreparationValues(catalog,parent,document.candidates.slice(1));
 values.shared.other='0';
 const saved=await api.post(route+'/preparation-draft',{parentCandidateId:parent.id,parentRevision:parent.dataRevision,
  memberRevisions:document.candidates.slice(1).map(candidate=>({candidateId:candidate.id,revision:candidate.dataRevision})),
  expectedDraftRevision:0,idempotencyKey:'synthetic:evidence:save',values});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 return {parentCandidateId:parent.id,parentRevision:parent.dataRevision,draftRevision:saved.body.draft.draftRevision};
}

const evidenceQuery=input=>`?${new URLSearchParams({parentRevision:String(input.parentRevision),draftRevision:String(input.draftRevision)})}`;

function assertBusinessUnchanged(before,after) {
 assert.equal(after.candidates.length,before.candidates.length);
 for(const [i,candidate] of after.candidates.entries()) {
  const original=structuredClone(before.candidates[i]),current=structuredClone(candidate);
  delete original.siblingPreparationDraftRefV1;delete current.siblingPreparationDraftRefV1;
  assert.deepEqual(current,original);
  assert.equal(candidate.dataRevision,before.candidates[i].dataRevision);
  assert.deepEqual(candidate.lifecycleV11,before.candidates[i].lifecycleV11);
 }
 assert.deepEqual(after.runtime.softwareJobs,before.runtime.softwareJobs);
 assert.deepEqual(after.runtime.idempotencyRecords,before.runtime.idempotencyRecords);
 assert.deepEqual(after.dispatches,before.dispatches);
}

function assertDraftReferences(document,draft) {
 assert.equal(draft.productionAuthorizationGranted,false);
 for(const member of draft.memberRevisions) {
  const candidate=document.candidates.find(c=>c.id===member.candidateId);
  assert.ok(candidate);
  assert.deepEqual(candidate.siblingPreparationDraftRefV1,{parentCandidateId:draft.parentCandidateId,
   draftRevision:draft.draftRevision,inputFingerprint:draft.inputFingerprint});
 }
}

test('real isolated API requires owner, persists/reloads all three colors, rejects conflicts and saves one draft per version without jobs or shop traffic',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t);
 const originalBytes=await api.readBytes();
 assert.equal((await api.get(route+'/preparation')).status,401);
 assert.deepEqual(await api.readBytes(),originalBytes);
 await api.authenticate();
 const read=await api.get(route+'/preparation');assert.equal(read.status,200);assert.equal(read.body.configured,true);assert.equal(read.body.draft,null);
 assert.deepEqual(read.body.catalog,catalog);assert.equal(catalog.assets.length,18);assert.equal(catalog.assets.filter(a=>a.kind==='finished').length,15);assert.deepEqual(catalog.assets.filter(a=>a.kind==='owner_color_exception').map(a=>[a.assetId,a.onlySourceSkuId]),[['16',catalog.supplierSkuIds[0]],['30',catalog.supplierSkuIds[1]],['18',catalog.supplierSkuIds[2]]]);
 assert.deepEqual(await api.readDocument(),document);assert.ok(read.body.supplyPreparation);
 const values=createPreparationValues(read.body.catalog,parent,document.candidates.slice(1));values.shared.titleRu='synthetic edited draft';
 values.page=2;
 const orders=[['16','27','19'],['30','17','27','19'],['18','24','29','19']];
 for(const [i,member] of values.members.entries()) {member.order=orders[i];member.hero=orders[i][0];}
 values.members[0].overrides.titleRu='synthetic black-cp title';
 values.members[1].overrides.stock='21';
 values.members[2].overrides.descriptionZh='';
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),expectedDraftRevision:0,idempotencyKey:'synthetic:api:save',values};
 const before=await api.readDocument();assert.ok(Array.isArray(before.runtime.operationAudit));
 const beforeSaveBytes=await api.readBytes();
 const unauthenticated=await api.post(route+'/preparation-draft',input,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}});
 assert.equal(unauthenticated.status,401,JSON.stringify(unauthenticated.body));
 assert.deepEqual(await api.readBytes(),beforeSaveBytes);
 assert.equal((await api.post(route+'/preparation-draft',input,{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.deepEqual(await api.readBytes(),beforeSaveBytes);

 const saves=await Promise.all([api.post(route+'/preparation-draft',input),api.post(route+'/preparation-draft',input)]);
 for(const save of saves) {
  assert.equal(save.status,200,JSON.stringify(save.body));assert.equal(save.body.draft.draftRevision,1);
  assert.deepEqual(save.body.draft.values,values);assert.equal(save.body.externalRequests,0);assert.equal(save.body.platformWrites,0);
 }
 assert.deepEqual(saves[0].body,saves[1].body);
 const firstDraft=saves[0].body.draft,saved=await api.readDocument(),stored=await api.readStoredDocument();
 assertBusinessUnchanged(before,saved);assertDraftReferences(saved,firstDraft);
 assert.deepEqual(saved.candidates[0],before.candidates[0]);
 assert.deepEqual(stored.runtime.siblingPreparationDrafts,[firstDraft]);
 assert.equal(stored.runtime.operationAudit.length,before.runtime.operationAudit.length+1);
 assert.deepEqual(stored.runtime.operationAudit.slice(0,-1),before.runtime.operationAudit);
 assert.deepEqual(stored.runtime.operationAudit.at(-1),{eventId:`audit:sibling-preparation:${parent.id}:1`,
  action:'save_sibling_preparation_draft',actorId:firstDraft.savedBy,candidateId:parent.id,
  sourceRevision:parent.dataRevision,draftRevision:1,at:firstDraft.savedAt,platformWrites:0});
 const firstBytes=await api.readBytes(),firstRead=await api.get(route+'/preparation');
 assert.equal(firstRead.status,200);assert.deepEqual(firstRead.body.draft,firstDraft);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.order),orders);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.hero),['16','30','18']);
 assert.deepEqual(firstRead.body.draft.values.members.map(m=>m.sourceSkuId),values.members.map(m=>m.sourceSkuId));
 assert.deepEqual(await api.readBytes(),firstBytes);
 const replay=await api.post(route+'/preparation-draft',input);assert.equal(replay.status,200);
 assert.deepEqual(replay.body,saves[0].body);assert.deepEqual(await api.readBytes(),firstBytes);
 const conflict=await api.post(route+'/preparation-draft',{...input,idempotencyKey:'synthetic:api:conflict'});
 assert.equal(conflict.status,409);assert.equal(conflict.body.code,'SIBLING_PREPARATION_DRAFT_CONFLICT');
 assert.deepEqual(await api.readBytes(),firstBytes);
 const changedPayload=structuredClone(input);changedPayload.values.shared.titleRu='changed payload under the same key';
 const changedReplay=await api.post(route+'/preparation-draft',changedPayload);
 assert.equal(changedReplay.status,409);assert.equal(changedReplay.body.code,'SIBLING_PREPARATION_REPLAY_CONFLICT');
 assert.deepEqual(await api.readBytes(),firstBytes);

 const competingInputs=['a','b'].map((key,i)=>{
  const next=structuredClone(input);next.expectedDraftRevision=1;next.idempotencyKey=`synthetic:api:race:${key}`;
  next.values.members[0].overrides.stock=String(31+i);return next;
 });
 const competitors=await Promise.all(competingInputs.map(next=>api.post(route+'/preparation-draft',next)));
 assert.deepEqual(competitors.map(result=>result.status).sort((a,b)=>a-b),[200,409]);
 const winnerIndex=competitors.findIndex(result=>result.status===200),winner=competitors[winnerIndex];
 const loser=competitors.find(result=>result.status===409);
 assert.equal(loser.body.code,'SIBLING_PREPARATION_DRAFT_CONFLICT');
 assert.equal(winner.body.draft.draftRevision,2);assert.deepEqual(winner.body.draft.values,competingInputs[winnerIndex].values);
 assert.equal(winner.body.externalRequests,0);assert.equal(winner.body.platformWrites,0);
 const latest=await api.readDocument(),latestStored=await api.readStoredDocument();
 assertBusinessUnchanged(before,latest);assertDraftReferences(latest,winner.body.draft);
 assert.deepEqual(latest.candidates[0],before.candidates[0]);
 assert.deepEqual(latestStored.runtime.siblingPreparationDrafts,[firstDraft,winner.body.draft]);
 assert.equal(latestStored.runtime.operationAudit.length,before.runtime.operationAudit.length+2);
 assert.deepEqual(latestStored.runtime.operationAudit.slice(0,-1),stored.runtime.operationAudit);
 assert.equal(latestStored.runtime.operationAudit.at(-1).eventId,`audit:sibling-preparation:${parent.id}:2`);
 assert.equal(latestStored.runtime.operationAudit.at(-1).action,'save_sibling_preparation_draft');
 const latestBytes=await api.readBytes(),latestRead=await api.get(route+'/preparation');
 assert.equal(latestRead.status,200);assert.deepEqual(latestRead.body.draft,winner.body.draft);
 assert.deepEqual(await api.readBytes(),latestBytes);

 await api.restart();await api.authenticate('login');
 const restarted=await api.get(route+'/preparation');assert.equal(restarted.status,200);
 assert.deepEqual(restarted.body.draft,winner.body.draft);assert.deepEqual(restarted.body.draft.values,competingInputs[winnerIndex].values);
 assert.equal(restarted.body.draft.values.shared.titleRu,'synthetic edited draft');
 assert.deepEqual(await api.readStoredDocument(),latestStored);assert.deepEqual(await api.readBytes(),latestBytes);
 const winnerReplay=await api.post(route+'/preparation-draft',competingInputs[winnerIndex]);
 assert.equal(winnerReplay.status,200);assert.deepEqual(winnerReplay.body,winner.body);
 const historicalReplay=await api.post(route+'/preparation-draft',input);
 assert.equal(historicalReplay.status,200);assert.deepEqual(historicalReplay.body,saves[0].body);
 const stale=await api.post(route+'/preparation-draft',{...input,idempotencyKey:'synthetic:api:stale',expectedDraftRevision:2,parentRevision:parent.dataRevision+1});
 assert.equal(stale.status,409);assert.equal(stale.body.code,'SIBLING_PREPARATION_SOURCE_CHANGED');
 assert.deepEqual(await api.readDocument(),latest);assert.deepEqual(await api.readBytes(),latestBytes);
 assert.deepEqual((await api.get(route+'/preparation')).body.draft,winner.body.draft);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('development-default read-only identity cannot read or save preparation even with owner headers',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t,'development_default');
 const before=await api.readBytes(),values=createPreparationValues(catalog,parent,document.candidates.slice(1));
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,
  memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:0,idempotencyKey:'synthetic:api:read-only',values};
 const read=await api.get(route+'/preparation');assert.equal(read.status,403,JSON.stringify(read.body));
 assert.deepEqual(await api.readBytes(),before);
 const rejected=await api.post(route+'/preparation-draft',input,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}});
 assert.equal(rejected.status,403,JSON.stringify(rejected.body));
 const evidenceInput={parentCandidateId:parent.id,parentRevision:parent.dataRevision,draftRevision:1};
 assert.equal((await api.get(route+'/preparation-evidence'+evidenceQuery(evidenceInput))).status,403);
 assert.equal((await api.post(route+'/preparation-evidence',evidenceInput,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}})).status,403);
 assert.deepEqual(await api.readBytes(),before);assert.deepEqual(await api.readDocument(),document);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('evidence HTTP rejects missing owner, malformed input and stale revisions without side effects',async t=>{
 const f=await startEvidencePreparationApi(t),{api,parent,route}=f;
 const endpoint=route+'/preparation-evidence',initial={parentCandidateId:parent.id,parentRevision:parent.dataRevision,draftRevision:1};
 const initialBytes=await api.readBytes();
 assert.equal((await api.get(endpoint+evidenceQuery(initial))).status,401);
 assert.equal((await api.post(endpoint,initial,{authenticated:false,
  headers:{'x-user-id':'synthetic-owner','x-session-id':'synthetic-session','x-user-role':'owner'}})).status,401);
 assert.deepEqual(await api.readBytes(),initialBytes);
 await api.authenticate();
 const unsaved=await api.get(endpoint+evidenceQuery(initial));
 assert.equal(unsaved.status,422,JSON.stringify(unsaved.body));
 assert.equal(unsaved.body.code,'SIBLING_BATCH_EVIDENCE_DRAFT_REQUIRED');
 assert.deepEqual(await api.readBytes(),initialBytes);
 const input=await saveEvidencePreparationDraft(f),before=await api.readBytes();
 assert.equal((await api.post(endpoint,input,{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.equal((await api.post(endpoint,input,{authenticated:false})).status,401);
 const invalidInputs=[{...input,parentCandidateId:'candidate:other-family'},{...input,unexpected:true},
  {...input,parentRevision:String(input.parentRevision)},{...input,draftRevision:0},null];
 for(const invalid of invalidInputs) {
  const response=await api.post(endpoint,invalid);
  assert.equal(response.status,422,JSON.stringify(response.body));
  assert.equal(response.body.code,'SIBLING_BATCH_EVIDENCE_INPUT_INVALID');
  assert.deepEqual(await api.readBytes(),before);
 }
 const malformedQueries=['',`?draftRevision=${input.draftRevision}`,`?parentRevision=&draftRevision=${input.draftRevision}`,
  `?parentRevision=invalid&draftRevision=${input.draftRevision}`,`?parentRevision=1e0&draftRevision=${input.draftRevision}`,
  `?parentRevision=${input.parentRevision}&parentRevision=${input.parentRevision+1}&draftRevision=${input.draftRevision}`,
  `?parentRevision=${input.parentRevision}&draftRevision=${input.draftRevision}&extra=true`];
 for(const query of malformedQueries) {
  const response=await api.get(endpoint+query);
  assert.equal(response.status,400,JSON.stringify({query,...response.body}));
  assert.match(response.body.message,/唯一、完整/);
  assert.deepEqual(await api.readBytes(),before);
 }
 const zeroDraft=await api.get(endpoint+evidenceQuery({...input,draftRevision:0}));
 assert.equal(zeroDraft.status,422);assert.equal(zeroDraft.body.code,'SIBLING_BATCH_EVIDENCE_INPUT_INVALID');
 for(const stale of [{...input,parentRevision:input.parentRevision+1},{...input,draftRevision:input.draftRevision+1}]) {
  for(const response of [await api.get(endpoint+evidenceQuery(stale)),await api.post(endpoint,stale)]) {
   assert.equal(response.status,409,JSON.stringify(response.body));
   assert.equal(response.body.code,'SIBLING_BATCH_EVIDENCE_DRAFT_CHANGED');
   assert.equal(response.body.externalRequests,0);assert.equal(response.body.platformWrites,0);
  }
  assert.deepEqual(await api.readBytes(),before);
 }
 const repository=createJsonBusinessStateRepository({filePath:api.dataFile});
 await repository.transact(state=>{state.candidates[1].dataRevision+=1;return {changed:true,document:state,result:null};});
 const revisedBytes=await api.readBytes();
 for(const response of [await api.get(endpoint+evidenceQuery(input)),await api.post(endpoint,input)]) {
  assert.equal(response.status,409,JSON.stringify(response.body));
  assert.equal(response.body.code,'SIBLING_BATCH_EVIDENCE_DRAFT_CHANGED');
 }
 assert.deepEqual(await api.readBytes(),revisedBytes);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('read-only evidence GET reports dependency gaps and local POST stops with no state changes or shop traffic',async t=>{
 const f=await startEvidencePreparationApi(t),{api,route}=f;
 await api.authenticate();
 const input=await saveEvidencePreparationDraft(f),before=await api.readDocument(),bytes=await api.readBytes();
 const endpoint=route+'/preparation-evidence';
 const read=await api.get(endpoint+evidenceQuery(input));
 assert.equal(read.status,200,JSON.stringify(read.body));
 assert.equal(read.body.ready,false);assert.equal(read.body.localPreparationAvailable,false);
 assert.equal(read.body.status,'preparation_required');assert.equal(read.body.members.length,3);
 for(const member of read.body.members) {
  assert.equal(Object.hasOwn(member,'candidate'),false);
  assert.equal(Object.hasOwn(member,'submission'),false);
  assert.deepEqual(member.actions.filter(action=>action.action==='prepare_once').map(action=>action.kind),
   ['commission','logistics_tariff','exchange_rate','schema']);
 }
 assert.deepEqual([...new Set(read.body.externalGaps.map(gap=>gap.kind))],['logistics_tariff','exchange_rate','schema']);
 assert.equal(read.body.businessStateEffect,'unchanged');assert.equal(read.body.externalRequests,0);assert.equal(read.body.platformWrites,0);
 assert.deepEqual(await api.readBytes(),bytes);
 const posts=await Promise.all([api.post(endpoint,input),api.post(endpoint,input)]);
 for(const post of posts) {
  assert.equal(post.status,200,JSON.stringify(post.body));assert.equal(post.body.result,'blocked');
  assert.equal(post.body.ready,false);assert.equal(post.body.externalRequests,0);assert.equal(post.body.platformWrites,0);
 }
 assert.deepEqual(await api.readDocument(),before);assert.deepEqual(await api.readBytes(),bytes);
 assert.equal(before.candidates.slice(1).every(candidate=>candidate.lifecycleV11===undefined),true);
 assert.equal(before.candidates[0].lifecycleV11.skuPackage.technicalStatus,'unknown_outcome');
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('evidence HTTP reuses current saved evidence without local reads, jobs, receipts or A advancement',async t=>{
 const f=await startEvidencePreparationApi(t,{ready:true}),{api,route}=f;
 await api.authenticate();
 const input=await saveEvidencePreparationDraft(f),before=await api.readDocument(),bytes=await api.readBytes();
 const endpoint=route+'/preparation-evidence';
 const read=await api.get(endpoint+evidenceQuery(input));
 assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.ready,true);
 assert.equal(read.body.status,'ready_from_reuse');assert.equal(read.body.localPreparationAvailable,false);
 assert.deepEqual(read.body.externalGaps,[]);
 assert.equal(read.body.members.every(member=>member.actions.every(action=>action.action==='reuse')),true);
 assert.deepEqual(await api.readBytes(),bytes);
 const posts=await Promise.all([api.post(endpoint,input),api.post(endpoint,input)]);
 for(const post of posts) {
  assert.equal(post.status,200,JSON.stringify(post.body));assert.equal(post.body.result,'already_prepared');
  assert.equal(post.body.ready,true);assert.equal(post.body.externalRequests,0);assert.equal(post.body.platformWrites,0);
 }
 assert.deepEqual(await api.readDocument(),before);assert.deepEqual(await api.readBytes(),bytes);
 assert.equal(before.candidates.slice(1).every(candidate=>candidate.lifecycleV11===undefined),true);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});

test('unchanged values can be saved against refreshed parent and member revisions as one new draft',async t=>{
 const {api,document,parent,catalog,route}=await startPreparationApi(t);
 await api.authenticate();
 const values=createPreparationValues(catalog,parent,document.candidates.slice(1));
 const input={parentCandidateId:parent.id,parentRevision:parent.dataRevision,
  memberRevisions:document.candidates.slice(1).map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:0,idempotencyKey:'synthetic:api:scope:initial',values};
 const first=await api.post(route+'/preparation-draft',input);
 assert.equal(first.status,200,JSON.stringify(first.body));
 const repository=createJsonBusinessStateRepository({filePath:api.dataFile});
 await repository.transact(state=>{
  state.candidates[0].dataRevision+=1;
  state.candidates[1].dataRevision+=1;
  return {changed:true,document:state,result:null};
 });
 const changed=await api.readDocument(),currentParent=changed.candidates[0],members=changed.candidates.slice(1);
 assert.equal(preparationDraftScopeCurrent(first.body.draft,currentParent,members,catalog),false);
 const next={...input,parentRevision:currentParent.dataRevision,
  memberRevisions:members.map(c=>({candidateId:c.id,revision:c.dataRevision})),
  expectedDraftRevision:1,idempotencyKey:'synthetic:api:scope:current'};
 const saved=await api.post(route+'/preparation-draft',next);
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal(saved.body.draft.draftRevision,2);
 assert.equal(preparationValuesEqual(saved.body.draft.values,first.body.draft.values),true);
 assert.equal(preparationDraftScopeCurrent(saved.body.draft,currentParent,members,catalog),true);
 assertBusinessUnchanged(changed,await api.readDocument());
 assert.deepEqual((await api.get(route+'/preparation')).body.draft,saved.body.draft);
 const stored=await api.readBytes();
 assert.deepEqual((await api.post(route+'/preparation-draft',next)).body,saved.body);
 assert.deepEqual(await api.readBytes(),stored);
 await api.assertClean();assert.equal(api.dependencyRequests(),0);assert.equal(api.dictionaryRequests(),0);
});
