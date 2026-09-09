import test from 'node:test';
import assert from 'node:assert/strict';
import {createADiscoveryRuntimeFixture} from './fixtures/a-discovery-runtime-fixture.mjs';
import {createAProductDetailContractFixture,createAProductDetailContractReceipt} from './fixtures/a-product-detail-contract-fixture.mjs';
import {createADiscoveryCandidateImportUseCase} from '../lib/a-discovery-candidate-import.mjs';
import {createRepositoryBackedSoftwareJobStore,createAProductDetailJobForScope,AProductDetailExecutionBlockedError} from '../lib/software-job-repository.mjs';
import {createLocalDevelopmentWorkerRegistry} from '../lib/worker-registry.mjs';
import {createMemoryBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {assertCompletedAProductDetailJobResult} from '../lib/software-job-contract.mjs';
import {loadPublishedSchemaValidator} from './helpers/published-schema-validator.mjs';

async function fixture(){
 const f=createADiscoveryRuntimeFixture(),importer=createADiscoveryCandidateImportUseCase({repository:f.repository,serverClock:f.clock,storeBindings:[]});
 const {service}=f.create({onBatchReady:input=>importer.importBatch(input)}),created=await f.prepare(service);
 await f.authorize(service,created);await service.runDue();await service.runDue();await service.stop();
 const document=await f.repository.readSnapshot(),candidate=document.candidates[0],source=candidate.aDiscoveryEvidenceV1;
 const jobs=document.runtime.softwareJobs,template=createAProductDetailContractFixture();
 const base={...template.scope,candidateId:candidate.id,sourceRevision:candidate.dataRevision,resultRevision:candidate.dataRevision,
  discoverySource:{...template.scope.discoverySource,batchId:source.batchId,batchRevision:source.sourceRevision,planId:source.planId,planVersion:source.planVersion,
   marketJobId:jobs[0].jobId,marketReceiptRef:source.marketReceiptRef,supplierJobId:jobs[1].jobId,supplierReceiptRef:source.supplierReceiptRefs[0]}};
 const scopes=base.detailPlan.requests.map((request,requestIndex)=>({...structuredClone(base),requestIndex,request,authorizationRef:`permit:detail:${requestIndex}`}));
 const workerRegistry=createLocalDevelopmentWorkerRegistry({clock:f.clock}),worker=workerRegistry.register({workerId:'worker:detail',version:'v1',capabilities:['linkfox-product-detail-api'],observedAt:f.clock()});
 await f.repository.transact(document=>{
  document.runtime.aProductDetailReceipts={};
  for(const scope of scopes){document.runtime.softwareJobAuthorizationRecords.push({...template.authorization,authorizationId:scope.authorizationRef,authorizedByUserId:f.owner.userId,scopeBinding:scope});
   document.runtime.softwareJobCredentialBindings.push({...template.credential,bindingId:`binding:detail:${scope.requestIndex}`,scopeBinding:scope,allowedWorkerIds:[worker.workerId]});}
  return {document,changed:true};
 });
 const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:f.repository,workerRegistry,serverClock:f.clock});
 const job=createAProductDetailJobForScope({scope:scopes[0],ownerUserId:f.owner.userId,createdAt:f.clock()});
 return {...f,store,worker,workerRegistry,job,scopes,candidate};
}
async function begin(f,job=f.job){
 if(!(await f.store.get(job.jobId)))await f.store.enqueue(job);const claimed=await f.store.claim({jobId:job.jobId,worker:f.worker,leaseId:`lease:detail:${job.scopeBinding.requestIndex}`,leaseDurationMs:60000});
 await f.repository.transact(document=>{
  const receipt=createAProductDetailContractReceipt({scope:job.scopeBinding,job:claimed});receipt.status='in_flight';receipt.completedAt=null;
  Object.assign(receipt.steps[0],{sentAt:null,completedAt:null,externalRequestState:'not_sent',requestTransmission:'not_attempted',result:null});
  document.runtime.aProductDetailReceipts[job.jobId]=receipt;
  f.store.assertAProductDetailExecutionInDocument({document,jobId:job.jobId,workerId:f.worker.workerId,leaseId:claimed.leaseId,observedAt:f.clock(),markRequestSent:true});
  Object.assign(receipt.steps[0],{sentAt:f.clock(),externalRequestState:'in_flight',requestTransmission:'attempted'});
  return {document,changed:true};
 });return f.store.get(job.jobId);
}
async function finish(f,job){return f.repository.transact(document=>{
 document.runtime.aProductDetailReceipts[job.jobId]=createAProductDetailContractReceipt({scope:job.scopeBinding,job});
 const result=f.store.settleAProductDetailInDocument({document,jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId,observedAt:f.clock()});
 return {document,changed:true,result};
});}

test('detail uses strict pre-SKU v3 jobs and two approved reads without changing candidate or replaying search',async()=>{
 const f=await fixture(),first=await begin(f),one=await finish(f,first);
 assert.equal(one.job.status,'completed');assert.ok(one.nextJob);assert.equal(one.nextJob.scopeBinding.requestIndex,1);
 assert.deepEqual((await f.repository.readSnapshot()).candidates,[f.candidate]);
 const two=await finish(f,await begin(f,one.nextJob));assert.equal(two.job.status,'completed');assert.equal(two.nextJob,null);
 const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates,[f.candidate]);
 assert.deepEqual(saved.runtime.softwareJobs.slice(-2).map(job=>job.subject),[0,1].map(()=>({kind:'a_candidate',candidateId:f.candidate.id,revision:f.candidate.dataRevision})));
 for(const job of saved.runtime.softwareJobs.slice(-2))assert.deepEqual(assertCompletedAProductDetailJobResult({job,receipt:saved.runtime.aProductDetailReceipts[job.jobId]}),job.resultEnvelope);
 assert.deepEqual(await f.store.enqueue(f.job),one.job);assert.deepEqual(await f.repository.readSnapshot(),saved);
 assert.deepEqual(f.counts(),{secrets:3,requests:3});
 const ajv=await loadPublishedSchemaValidator(),validate=ajv.getSchema('software-job-v3.schema.json');
 for(const job of [f.job,first,one.job,two.job])assert.equal(validate(job),true,JSON.stringify(validate.errors));
 assert.equal(validate({...f.job,subject:{kind:'discovery_batch',batchId:'fake',revision:f.job.revision}}),false);
 assert.equal(validate({...f.job,candidateId:f.candidate.id}),false);
});
test('candidate drift and original search envelope corruption cannot pass the send gate',async()=>{
 const f=await fixture(),issued=await begin(f),saved=await f.repository.readSnapshot();
 for(const mode of ['revision','eliminated','source']){
  const document=structuredClone(saved);if(mode==='revision')document.candidates[0].dataRevision++;
  if(mode==='eliminated')document.candidates[0].workflowStatus='eliminated';
  if(mode==='source')document.runtime.softwareJobs[0].resultEnvelope.payload.receiptRef='wrong';
  assert.throws(()=>f.store.assertAProductDetailExecutionInDocument({document,jobId:issued.jobId,workerId:issued.workerId,leaseId:issued.leaseId,observedAt:f.clock()}),mode==='source'?/COMPLETED_RESULT_CONFLICT/:AProductDetailExecutionBlockedError);
 }
 assert.deepEqual(await f.repository.readSnapshot(),saved);
});
test('cold restart preserves attempted detail unknown and never creates the second read',async()=>{
 const f=await fixture();await begin(f);const repository=createMemoryBusinessStateRepository(await f.repository.readSnapshot());
 const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry:f.workerRegistry,serverClock:f.clock});
 await store.reconcileAfterRestart();const saved=await repository.readSnapshot();
 assert.equal(saved.runtime.softwareJobs.at(-1).status,'unknown_outcome');assert.equal(saved.runtime.aProductDetailReceipts[f.job.jobId].status,'unknown_outcome');
 assert.equal(saved.runtime.softwareJobs.length,4);assert.deepEqual(saved.candidates,[f.candidate]);
 await store.reconcileAfterRestart();assert.deepEqual(await repository.readSnapshot(),saved);
});
