import test from 'node:test';
import assert from 'node:assert/strict';
import { createDPlatformObservationRuntimeFixture } from './fixtures/d-platform-observation-runtime-fixture.mjs';
import { createDEProductionRuntimeServices } from '../lib/d-e-runtime-services.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { persistDExecutionCheckpoint } from '../lib/d-e-software-integration.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';

async function readyFixture() {
  const f=await createDPlatformObservationRuntimeFixture({responses:['imported'],prerequisitePolicy:'configured'});
  const observations=f.createRuntime(()=>{});
  for(let index=0;index<3;index++) {
    await observations.runJob({jobId:(await f.job()).jobId});
    f.d.advance(11);
  }
  const document=await f.d.repository.readSnapshot(),job=document.runtime.softwareJobs[0];
  const observationJobId=job.platformContinuation.observationHistory.at(-1).jobId;
  return {...f,sourceDJobId:job.jobId,observationJobId};
}
function services(f,afterClaim) {
  let proofs=0,requests=0;
  const runtime=createDEProductionRuntimeServices({repository:f.d.repository,runtimeMode:f.d.input.runtimeMode,
    serverClock:f.d.input.serverClock,workerRegistry:createLocalDevelopmentWorkerRegistry({clock:f.d.input.serverClock}),productionBindings:[f.d.currentProductionBinding],
    deServiceBindings:[{schemaVersion:'d-e-service-binding-v1',serviceId:'service:synthetic:saved-d',configurationVersion:'service-config:1',
      productionBindingId:f.d.currentProductionBinding.bindingId,productionConfigurationVersion:f.d.currentProductionBinding.configurationVersion,
      workerId:f.d.worker.workerId,workerVersion:f.d.worker.version,leaseDurationMs:60000}],
    inspectPlatform:()=>{throw new Error('Unexpected new preflight');},loadAdapterCapabilities:()=>f.caps,
    upload:()=>{throw new Error('Unexpected asset upload');},resolveLocalAsset:()=>{throw new Error('Unexpected asset resolution');},
    requestJson:()=>{requests++;throw new Error('Unexpected inventory request');},
    verifyInventoryPrerequisiteSource:async()=>{
      proofs++;
      if(proofs===2)return afterClaim(f);
      return {assertCurrent:()=>true};
    }});
  return {runtime,proofs:()=>proofs,requests:()=>requests};
}
async function assertStopped(f,expectException=false) {
  const document=await f.d.repository.readSnapshot(),job=document.runtime.softwareJobs[0],candidate=document.candidates[0];
  const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');assert.equal(job.attempt,1);
  assert.equal(state.platformWrites,1);assert.equal(state.checkpoints.length,3);
  assert.equal(state.platformContinuation.status,'inventory_not_sent_interrupted');
  assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');assert.equal(state.continuationBlocked,true);
  assert.equal(state.attempt.productionRecord,null);assert.equal(candidate.lifecycleV11.skuPackage.productionRecord,null);
  assert.deepEqual(f.d.calls,['/v3/product/import']);assert.equal(f.calls.length,3);
  assert.deepEqual(await f.d.jobStore.listDRemainingInventoryJobs({limit:1}),[]);
  const validator=await loadPublishedSchemaValidator(),validate=validator.getSchema('software-job-v1.schema.json');
  assert.equal(validate(job),true,JSON.stringify(validate.errors));
  if(expectException) {
    const exception=candidate.executionRuntime.exceptionCase;
    assert.equal(exception.status,'open');assert.equal(exception.softwareJobId,job.jobId);
    assert.equal(exception.businessPhase,'D');assert.equal(exception.unknownOutcome,false);
    assert.equal(exception.dispatchState,'not_dispatched');assert.equal(exception.automaticRetryAllowed,false);
    assert.equal(exception.lastSuccessfulStepId,'import_result_observed');
  } else assert.notEqual(candidate.executionRuntime?.exceptionCase?.status,'open');
  return document;
}
test('known prerequisites lost after remaining inventory claim settle the exact original D without sending',async t=>{
  for(const [name,afterClaim] of [
    ['proof unavailable',async()=>null],
    ['revision changed',async f=>{await f.d.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document,result:null};});return {assertCurrent:()=>true};}],
    ['lease expired',async f=>{f.d.advance(60001);return {assertCurrent:()=>true};}]
  ])await t.test(name,async()=>{
    const f=await readyFixture(),service=services(f,afterClaim);
    const result=await service.runtime.resumeInventory(f);
    assert.equal(result.status,'failed');assert.equal(service.proofs(),2);assert.equal(service.requests(),0);
    await assertStopped(f);
  });
});
test('unknown post-claim verifier failures save maintenance atomically and rethrow the original error',async()=>{
  const f=await readyFixture(),failure=new TypeError('Synthetic internal failure with password: must-not-persist');
  const service=services(f,async()=>{throw failure;});
  await assert.rejects(()=>service.runtime.resumeInventory(f),error=>error===failure);
  assert.equal(service.requests(),0);
  const document=await assertStopped(f,true);
  assert.equal(JSON.stringify(document).includes('must-not-persist'),false);
});
test('an invalid verifier interface is a system error rather than a known empty source',async()=>{
  const f=await readyFixture(),service=services(f,async()=>({assertCurrent:true}));
  await assert.rejects(()=>service.runtime.resumeInventory(f),{name:'TypeError',message:'DE_RUNTIME_INVENTORY_PROOF_INVALID'});
  assert.equal(service.requests(),0);await assertStopped(f,true);
});
test('the targeted pre-send stop rejects wrong holders, damaged import proof, sent inventory, and repeated terminal settlement',async()=>{
  const f=await readyFixture(),leaseId='lease:synthetic:admission-stop';
  await f.d.jobStore.claimDRemainingInventory({jobId:f.sourceDJobId,worker:f.d.worker,leaseId,leaseDurationMs:60000,
    observationJobId:f.observationJobId,verifyInventoryPrerequisiteSource:()=>true});
  const stop=(document,overrides={})=>f.d.jobStore.stopDRemainingInventoryBeforeSendInDocument({document,jobId:f.sourceDJobId,
    workerId:f.d.worker.workerId,leaseId,observedAt:f.d.input.serverClock(),...overrides});
  const before=await f.d.repository.readSnapshot();
  for(const overrides of [{workerId:'worker:wrong'},{leaseId:'lease:wrong'}]) {
    await assert.rejects(()=>f.d.repository.transact(document=>{stop(document,overrides);return {changed:true,document};}),/HOLDER_INVALID/);
    assert.deepEqual(await f.d.repository.readSnapshot(),before);
  }
  await assert.rejects(()=>f.d.repository.transact(document=>{
    document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.checkpoints[2].productId='999999';
    stop(document);return {changed:true,document};
  }));
  assert.deepEqual(await f.d.repository.readSnapshot(),before);
  const state=before.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  await persistDExecutionCheckpoint({repository:f.d.repository,candidateId:f.d.candidate.id,executionKey:state.executionKey,
    expectedExecutionRevision:state.executionRevision,serverClock:f.d.input.serverClock,currentProductionBinding:f.d.currentProductionBinding,
    softwareJobContext:{jobStore:f.d.jobStore,jobId:f.sourceDJobId,workerId:f.d.worker.workerId,leaseId},
    event:{kind:'stock_intent',taskId:state.platformContinuation.taskId,productId:state.platformContinuation.productId,
      merchantSku:state.attempt.request.merchantSku,warehouseId:state.attempt.request.inventoryWrite.warehouseId,stock:state.attempt.request.stock}});
  const sent=await f.d.repository.readSnapshot();
  await assert.rejects(()=>f.d.repository.transact(document=>{stop(document);return {changed:true,document};}),/HOLDER_INVALID|PROOF_REQUIRED/);
  assert.deepEqual(await f.d.repository.readSnapshot(),sent);
  const fresh=await readyFixture(),runtime=services(fresh,async()=>null);await runtime.runtime.resumeInventory(fresh);
  const stopped=await fresh.d.repository.readSnapshot(),job=stopped.runtime.softwareJobs[0];
  await assert.rejects(()=>fresh.d.repository.transact(document=>{fresh.d.jobStore.stopDRemainingInventoryBeforeSendInDocument({document,
    jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId,observedAt:fresh.d.input.serverClock()});return {changed:true,document};}),/HOLDER_INVALID/);
  assert.deepEqual(await fresh.d.repository.readSnapshot(),stopped);
});
