import { createDPlatformObservationRuntimeFixture as waitingFixture } from './fixtures/d-platform-observation-runtime-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPersistedDRemainingInventory } from '../lib/d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { createDPlatformObservationRuntime } from '../lib/d-platform-observation-use-case.mjs';
import { assertDPlatformObservationScope, createDPlatformObservationScope, assertDRemainingInventoryContinuation, assertDRemainingInventorySend } from '../lib/d-platform-observation-contract.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
const clone=value=>structuredClone(value);
test('accepted import and first bounded observation job are atomic; pending survives reconstruction without replaying import',async()=>{
 const f=await waitingFixture();let document=await f.d.repository.readSnapshot();
 assert.equal(document.runtime.softwareJobs[0].externalRequestState,'succeeded');
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
 const first=await f.job();assert.equal(first.scopeBinding.queryIndex,1);assertDPlatformObservationScope(first.scopeBinding);
 const runtime=f.createRuntime();await runtime.runJob({jobId:first.jobId});
 document=await f.d.repository.readSnapshot();assert.equal(document.runtime.softwareJobs.find(j=>j.jobId===first.jobId).status,'completed');
 const second=await f.job();assert.equal(second.scopeBinding.queryIndex,2);assert.notEqual(second.jobId,first.jobId);
 await f.createRuntime().runJob({jobId:first.jobId});assert.equal(f.calls.length,1);
 assert.equal((await f.createRuntime().runDue()).status,'idle');assert.equal(f.calls.length,1);
 f.d.advance(11);await f.createRuntime().runDue();assert.equal(f.calls.length,2);assert.equal(f.d.calls.length,1);
 const validator=await loadPublishedSchemaValidator();const valid=validator.getSchema('d-software-execution-state-v2');
 assert.equal(valid((await f.d.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.dSoftwareExecution),true,JSON.stringify(valid.errors));
});
test('pending budget exhausts explicitly; failed and skipped never schedule another read or stock write',async()=>{
 for(const status of ['pending','failed','skipped']) {
  const f=await waitingFixture({maxQueries:1,responses:[status]});await f.createRuntime().runJob({jobId:(await f.job()).jobId});
  const doc=await f.d.repository.readSnapshot(),c=doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation;
  assert.equal(c.status,status==='pending'?'query_budget_exhausted':`platform_${status}`);assert.equal(await f.job(),undefined);
  assert.equal(c.inventoryWriteState,'not_sent');assert.equal(f.d.calls.length,1);assert.equal(f.calls.length,1);assert.equal(f.ready(),0);
 }
});
test('imported does not prove price_sent; absent formal prerequisite policy stops before any price or stock request',async()=>{
 const f=await waitingFixture({responses:['imported']});await f.createRuntime().runJob({jobId:(await f.job()).jobId});
 f.d.advance(11);const next=await f.job();assert.equal(next.scopeBinding.queryKind,'price_state');await f.createRuntime().runJob({jobId:next.jobId});
 const doc=await f.d.repository.readSnapshot(),state=doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 assert.equal(state.platformContinuation.status,'blocked');assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(f.calls.length,1);assert.equal(f.ready(),0);assert.equal(await f.job(),undefined);
 assert.throws(()=>assertDRemainingInventoryContinuation({document:doc,job:doc.runtime.softwareJobs[0],observationJobId:next.jobId,
  checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:()=>true}),/SOURCE_JOB_INVALID/);
});
test('changed revision or source D failure blocks a queued observation before providers',async()=>{
 for(const drift of ['revision','failed','unknown_outcome']) {
  const f=await waitingFixture(),job=await f.job();
  await f.d.repository.transact(document=>{if(drift==='revision')document.candidates[0].dataRevision++;else document.runtime.softwareJobs[0].status=drift;
   return {changed:true,document};});
  if(drift==='revision'){await f.createRuntime().runJob({jobId:job.jobId});
   const saved=await f.d.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===job.jobId).status,'failed');
   assert.equal(saved.runtime.softwareJobs.find(value=>value.jobId===job.jobId).externalRequestState,'not_sent');
  }else await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),/SOURCE/);
  assert.equal(f.calls.length,0);assert.equal(f.d.calls.length,1);
 }
});
test('old unknown D records cannot acquire an observation scope or become a current execution',async()=>{
 const f=await waitingFixture(),doc=await f.d.repository.readSnapshot();doc.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.schemaVersion='d-software-execution-state-v1';
 assert.throws(()=>createDPlatformObservationScope({document:doc,candidate:doc.candidates[0],sourceDJob:doc.runtime.softwareJobs[0],
  policy:f.rules,queryIndex:1,nextEligibleAt:f.d.input.serverClock(),observedAt:f.d.input.serverClock()}),/SOURCE_CONFLICT/);
 assert.equal(f.d.calls.length,1);
});

test('only saved same-source price and warehouse observations authorize the original unsent inventory once',async()=>{
 const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured'});let last;
 for(let index=0;index<3;index++){last=await f.job();await f.createRuntime().runJob({jobId:last.jobId});f.d.advance(11);}
 assert.equal(f.ready(),1);assert.equal(f.calls.length,3);assert.equal(f.d.calls.length,1);
 const before=await f.d.repository.readSnapshot(),job=before.runtime.softwareJobs[0],verify=()=>true;
 const source=assertDRemainingInventoryContinuation({document:before,job,observationJobId:last.jobId,checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:verify});
 const corrupted=clone(before),priceJob=corrupted.runtime.softwareJobs.find(value=>value.scopeBinding?.queryKind==='price_state');
 priceJob.resultEnvelope.payload.observationFingerprint='0'.repeat(64);
 assert.throws(()=>assertDRemainingInventoryContinuation({document:corrupted,job:corrupted.runtime.softwareJobs[0],observationJobId:last.jobId,
  checkedAt:f.d.input.serverClock(),verifyInventoryPrerequisiteSource:verify}),/PREREQUISITE_ENVELOPE_CONFLICT/);
 // Reconstruct the pump after observations are committed but before the continuation callback runs.
 const recoveredRuntime=f.createRuntime(async pending=>{
 assert.deepEqual(pending,{sourceDJobId:job.jobId,observationJobId:last.jobId});
 const leaseId='lease:synthetic:remaining';
 const claims=await Promise.allSettled([1,2].map(()=>f.d.jobStore.claimDRemainingInventory({jobId:job.jobId,worker:f.d.worker,leaseId,
  leaseDurationMs:60000,observationJobId:last.jobId,verifyInventoryPrerequisiteSource:verify})));
 assert.equal(claims.filter(value=>value.status==='fulfilled').length,1,claims.map(value=>value.reason?.stack ?? value.status).join('\n'));assert.equal(claims.filter(value=>value.status==='rejected').length,1);
 let writes=0,guards=0;const context={jobStore:f.d.jobStore,jobId:job.jobId,workerId:f.d.worker.workerId,leaseId};
 const assertRemainingInventoryAuthorization=async()=>{const document=await f.d.repository.readSnapshot();
  assertDRemainingInventorySend({document,job:document.runtime.softwareJobs[0],observationJobId:last.jobId,checkedAt:f.d.input.serverClock(),
    workerId:f.d.worker.workerId,leaseId,verifyInventoryPrerequisiteSource:verify});guards++;};
 const result=await runPersistedDRemainingInventory({repository:f.d.repository,candidateId:f.d.candidate.id,softwareJobContext:context,
  serverClock:f.d.input.serverClock,currentProductionBinding:f.d.currentProductionBinding,observation:source.prerequisites,assertRemainingInventoryAuthorization,
  createAdapter:({executionContext,request})=>{
   const adapter=createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:f.caps,executionContext,requestJson:async(call,options)=>{
    assert.equal(call.endpoint,'/v2/products/stocks');await options.beforeRequestSend();writes++;
    return {result:[{offer_id:request.merchantSku,product_id:910001,warehouse_id:Number(request.inventoryWrite.warehouseId),updated:true,errors:[]}]};
   }});
   // This test isolates D continuation persistence. Independent seller status remains unproved.
   return {...adapter,readbackSellerApi:async()=>({platform:'ozon',store:request.store,storeRef:request.storeRef,warehouseRef:request.warehouseRef,
    credentialAlias:request.credentialAlias,skuPackageId:request.skuPackageId,supplierSkuId:request.supplierSkuId,merchantSku:request.merchantSku,
    platformProductId:'910001',currentPrice:request.platformWritePrice,currentStock:'unknown',imageCount:'unknown',moderationStatus:'unknown',
    validationStatus:'unknown',saleStatus:'unknown',errors:[],platformEvidenceRef:'evidence:synthetic:unproved'})};
  }});
 assert.equal(result.status,'unknown_outcome');assert.equal(writes,1);assert.equal(guards,2);assert.equal(f.d.calls.length,1);
 const final=await f.d.repository.readSnapshot();assert.equal(final.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
 assert.equal(final.runtime.softwareJobs[0].attempt,1);
 await assert.rejects(()=>f.d.jobStore.claimDRemainingInventory({jobId:job.jobId,worker:f.d.worker,leaseId:'lease:another',leaseDurationMs:60000,
  observationJobId:last.jobId,verifyInventoryPrerequisiteSource:verify}),/CONTINUATION_JOB_INVALID/);assert.equal(writes,1);
 return {status:'continued_once'};
 });
 assert.deepEqual(await recoveredRuntime.runDue(),{status:'continued_once'});
 assert.deepEqual(await recoveredRuntime.runDue(),{status:'idle'});
});

test('warehouse observation arriving after policy expiry preserves evidence but cannot resume inventory',async()=>{
 const f=await waitingFixture({responses:['imported'],prerequisitePolicy:'configured',beforeResponse:({request,advance})=>{
  if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')advance(59980);
 }});
 for(let index=0;index<3;index++){const job=await f.job();await f.createRuntime().runJob({jobId:job.jobId});if(index<2)f.d.advance(11);}
 const document=await f.d.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 assert.equal(state.platformContinuation.observationHistory.length,3);
 assert.equal(state.platformContinuation.observationHistory.at(-1).result.reservedObservation,'observed');
 assert.equal(state.platformContinuation.status,'unknown_outcome');assert.equal(state.continuationBlocked,true);
 assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');assert.equal(f.ready(),0);
 assert.equal(await f.job(),undefined);assert.equal(f.calls.length,3);assert.deepEqual(f.d.calls,['/v3/product/import']);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.productionRecord,null);
});

test('unknown observation exceptions are persisted, rethrown, and never replayed',async()=>{
 const failure=new Error('synthetic internal observation failure');
 const f=await waitingFixture({beforeResponse:()=>{throw failure;}}),job=await f.job();
 await assert.rejects(()=>f.createRuntime().runJob({jobId:job.jobId}),error=>error===failure);
 const document=await f.d.repository.readSnapshot(),saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'unknown_outcome');assert.equal(saved.externalRequestState,'unknown_outcome');
 assert.equal(document.candidates[0].executionRuntime.exceptionCase.softwareJobId,job.jobId);
 assert.equal(document.candidates[0].executionRuntime.exceptionCase.automaticRetryAllowed,false);
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.inventoryWriteState,'not_sent');
 await f.createRuntime().runJob({jobId:job.jobId});assert.equal(f.calls.length,1);assert.equal(await f.job(),undefined);
});

test('empty observation queue performs no candidate read, adapter construction, or external request',async()=>{
 let listed=0;
 const runtime=createDPlatformObservationRuntime({repository:{readSnapshot(){throw new Error('unexpected candidate read');}},
  jobStore:{async listDPlatformObservationJobs({limit}){assert.equal(limit,1);listed++;return [];},async listDRemainingInventoryJobs({limit}){assert.equal(limit,1);return [];}},
  serverClock:()=> '2026-09-08T00:00:00.000Z',resolveExecution(){throw new Error('unexpected provider construction');}});
 assert.deepEqual(await runtime.runDue(),{status:'idle'});assert.equal(listed,1);await runtime.stop();
});

test('expired queued observation is durably blocked before any provider call',async()=>{
 const f=await waitingFixture();const job=await f.job();f.d.advance(60001);
 await f.createRuntime().runDue();const document=await f.d.repository.readSnapshot();
 const saved=document.runtime.softwareJobs.find(value=>value.jobId===job.jobId);
 assert.equal(saved.status,'failed');assert.equal(saved.attempt,0);assert.equal(saved.externalRequestState,'not_sent');
 assert.equal(document.runtime.softwareJobs[0].status,'failed');
 assert.equal(document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.platformContinuation.status,'blocked');
 assert.equal(f.calls.length,0);assert.equal(await f.job(),undefined);
});

test('a sent observation survives current revision drift but cannot schedule or resume any write',async()=>{
 const f=await waitingFixture({beforeResponse:async({repository})=>{
  await repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
 }}),job=await f.job();await f.createRuntime().runJob({jobId:job.jobId});
 const document=await f.d.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
 const record=state.platformContinuation.observationHistory[0];assert.equal(record.sourceContextChanged,true);
 assert.equal(record.result.classification,'waiting_platform');assert.equal(state.platformContinuation.status,'unknown_outcome');
 assert.equal(state.continuationBlocked,true);assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');
 assert.equal(document.runtime.softwareJobs.find(value=>value.jobId===job.jobId).externalRequestState,'succeeded');
 assert.equal(document.runtime.softwareJobs[0].status,'unknown_outcome');assert.equal(f.calls.length,1);assert.equal(await f.job(),undefined);
});
