import test from 'node:test';
import assert from 'node:assert/strict';
import {createAProductDetailRuntimeFixture} from './fixtures/a-product-detail-runtime-fixture.mjs';
import {createADiscoveryRuntimeFixture} from './fixtures/a-discovery-runtime-fixture.mjs';
import {c1AiSoftwareJobFixture} from './fixtures/c1-ai-software-job-fixture.mjs';
import {createMemoryBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {createRepositoryBackedSoftwareJobStore} from '../lib/software-job-repository.mjs';
import {createLocalDevelopmentWorkerRegistry} from '../lib/worker-registry.mjs';
import {bindSoftwareJobAdmissionForEnqueue} from '../lib/software-job-admission.mjs';
import {claimSoftwareJobLease,markSoftwareJobExternalRequestStarted} from '../lib/software-job-contract.mjs';

function legacyInFlight(){
  const f=c1AiSoftwareJobFixture();
  const admitted=bindSoftwareJobAdmissionForEnqueue({document:f.document,job:f.job,observedAt:f.at,phase:'enqueue_current'});
  const claimed=claimSoftwareJobLease({job:admitted,worker:f.worker,leaseId:'lease:old-c1',serverTime:f.at,leaseDurationMs:60000});
  const job=markSoftwareJobExternalRequestStarted({job:claimed,workerId:f.worker.workerId,leaseId:claimed.leaseId,serverTime:f.at,externalRequestRef:'request:old-c1'});
  return {document:{...f.document,runtime:{...f.document.runtime,softwareJobs:[job]}},job};
}
function cold(document,clock){
  const repository=createMemoryBusinessStateRepository(document),workerRegistry=createLocalDevelopmentWorkerRegistry({clock});
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,workerRegistry,serverClock:clock});
  return {repository,store};
}

test('restart filtering reconciles only the requested A type and preserves an actual older running C1 job byte for byte',async()=>{
  const f=await createAProductDetailRuntimeFixture();let release,started;const ready=new Promise(resolve=>{started=resolve;});
  const {service}=f.create({fetchImpl:async(url,options)=>{started();return new Promise(resolve=>{release=async()=>resolve(await f.fetchImpl(url,options));});}});
  const running=f.authorize(service);await ready;
  const snapshot=await f.repository.readSnapshot(),legacy=legacyInFlight();snapshot.candidates.push(...legacy.document.candidates);snapshot.runtime.softwareJobs.push(legacy.job);
  const before=JSON.stringify(snapshot),{repository,store}=cold(snapshot,f.clock);
  assert.deepEqual(await store.reconcileAfterRestart({jobTypes:['a_product_discovery']}),{reconciled:[]});assert.equal(JSON.stringify(await repository.readSnapshot()),before);
  const result=await store.reconcileAfterRestart({jobTypes:['a_product_detail_read']});
  const saved=await repository.readSnapshot(),detail=saved.runtime.softwareJobs.find(job=>job.jobType==='a_product_detail_read');
  assert.deepEqual(result.reconciled,[detail.jobId]);assert.equal(detail.status,'unknown_outcome');assert.equal(saved.runtime.aProductDetailReceipts[detail.jobId].status,'unknown_outcome');
  assert.equal(JSON.stringify(saved.runtime.softwareJobs.filter(job=>job.jobType!=='a_product_detail_read')),JSON.stringify(snapshot.runtime.softwareJobs.filter(job=>job.jobType!=='a_product_detail_read')));
  assert.deepEqual(saved.candidates,snapshot.candidates);assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords,snapshot.runtime.softwareJobAuthorizationRecords);
  const stopped=JSON.stringify(saved);assert.deepEqual(await store.reconcileAfterRestart({jobTypes:['a_product_discovery','a_product_detail_read']}),{reconciled:[]});assert.equal(JSON.stringify(await repository.readSnapshot()),stopped);
  await release();await running;await service.stop();
});

test('filtered restart distinguishes a claimed unsent search from an issued paid request',async()=>{
  const f=createADiscoveryRuntimeFixture();let release,started;const ready=new Promise(resolve=>{started=resolve;});
  const {service}=f.create({readSecret:async()=>{started();return new Promise(resolve=>{release=resolve;});}}),created=await f.prepare(service);
  const running=f.authorize(service,created);await ready;
  const snapshot=await f.repository.readSnapshot(),{repository,store}=cold(snapshot,f.clock);
  const {reconciled}=await store.reconcileAfterRestart({jobTypes:['a_product_discovery','a_product_detail_read']});assert.equal(reconciled.length,1);
  const saved=await repository.readSnapshot(),job=saved.runtime.softwareJobs[0];assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'not_sent');
  assert.equal(saved.runtime.aDiscoveryReceipts[job.jobId].status,'failed');assert.equal(saved.runtime.softwareJobs.length,1);assert.deepEqual(f.counts(),{secrets:0,requests:0});
  await service.stop();await running;release('synthetic-secret');
});

test('the optional restart filter fails closed before mutation and default reconciliation retains its existing breadth',async()=>{
  const legacy=legacyInFlight(),{repository,store}=cold(legacy.document,()=> '2026-09-08T12:00:00.000Z'),before=JSON.stringify(await repository.readSnapshot());
  for(const jobTypes of [[],['a_product_discovery','a_product_discovery'],['c1_ai_draft'],['unknown'],['a_product_discovery','a_product_detail_read','unknown'],'a_product_discovery']){
    await assert.rejects(store.reconcileAfterRestart({jobTypes}),/SOFTWARE_JOB_RESTART_FILTER_INVALID/);assert.equal(JSON.stringify(await repository.readSnapshot()),before);
  }
  assert.deepEqual(await store.reconcileAfterRestart(),{reconciled:[legacy.job.jobId]});assert.equal((await repository.readSnapshot()).runtime.softwareJobs[0].status,'unknown_outcome');
});
