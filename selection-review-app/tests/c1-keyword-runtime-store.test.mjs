import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueC1PaidKeywordEvidenceJob } from '../lib/c1-keyword-software-use-case.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentActor, createWorkerDescriptor } from '../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore, C1PaidKeywordExecutionBlockedError, assertC1PaidKeywordContinuationResult } from '../lib/software-job-repository.mjs';
import { C1_PAID_KEYWORD_EVIDENCE_CAPABILITY, settleSoftwareJob } from '../lib/software-job-contract.mjs';
import { runC1PaidKeywordEvidenceSoftwareJob } from '../lib/keyword-evidence-software-runner.mjs';
import { createSoftwareExecutionRuntime, openExceptionCase, blockExecutionForTechnicalFailure } from '../lib/software-execution-state.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';
import { c1PaidKeywordSettlementCandidate, c1PaidKeywordFixtureReceipt, prepareC1PaidKeywordSettlementFixture } from './fixtures/c1-paid-keyword-settlement-fixture.mjs';

async function fixture() {
  let now=KEYWORD_NOW;
  const candidate=await c1PaidKeywordSettlementCandidate();
  const repository=createMemoryBusinessStateRepository({candidates:[candidate],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[],operationAudit:[],idempotencyRecords:[]}});
  const enqueue=await enqueueC1PaidKeywordEvidenceJob({repository,runtimeMode:'local_development',
    actor:createLocalDevelopmentActor({at:now,userId:'owner-1',sessionId:'test:c1-store'}),candidateId:candidate.id,
    expectedRevision:candidate.dataRevision,clientInput:{dataRevision:candidate.dataRevision},serverTime:now,serverClock:()=>now});
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>now,heartbeatTtlMs:120000});
  const worker=createWorkerDescriptor({workerId:'worker-seerfar-open-api-1',capabilities:[C1_PAID_KEYWORD_EVIDENCE_CAPABILITY],version:'1.0.0',observedAt:now});
  registry.register(worker);
  const store=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock:()=>now,workerRegistry:registry});
  const jobId=enqueue.result.softwareJobRef.jobId,leaseId='lease:c1-store';
  const context={jobId,workerId:worker.workerId,leaseId};
  return {repository,store,worker,jobId,leaseId,context,clock:()=>now,advance(ms){now=new Date(Date.parse(now)+ms).toISOString();},
    claim:()=>store.claim({jobId,worker,leaseId,leaseDurationMs:60000})};
}

test('keyword send guard reuses consumed authorization and exact current source before every request',async()=>{
  const f=await fixture();await f.claim();
  let document=await f.repository.readSnapshot();
  const guard=()=>f.store.assertC1PaidKeywordExecutionInDocument({document,...f.context,observedAt:f.clock()});
  assert.equal(guard().job.status,'claimed');
  assert.equal(document.runtime.softwareJobAuthorizationRecords[0].useCount,1);
  const original=structuredClone(document);
  for(const mutate of [
    value=>{value.candidates[0].dataRevision++;},
    value=>{value.candidates[0].lifecycleV11.c1PaidKeywordEvidenceSeerfarRequestV1.skuIds=[99];},
    value=>{value.runtime.softwareJobAuthorizationRecords[0].useCount=0;value.runtime.softwareJobAuthorizationRecords[0].consumedByJobId=null;value.runtime.softwareJobAuthorizationRecords[0].consumedAt=null;}
  ]) {document=structuredClone(original);mutate(document);assert.throws(guard,C1PaidKeywordExecutionBlockedError);}
  document=structuredClone(original);document.runtime.idempotencyRecords[0].candidateSnapshot.lifecycleV11.c1PaidKeywordEvidenceSeerfarRequestV1.skuIds=[99];
  assert.throws(guard,error=>error instanceof Error && !(error instanceof C1PaidKeywordExecutionBlockedError) && error.message==='C1_PAID_KEYWORD_SOURCE_CONFLICT');
  document=original;assert.throws(()=>f.store.assertC1PaidKeywordExecutionInDocument({document,...f.context,leaseId:'lease:wrong',observedAt:f.clock()}),C1PaidKeywordExecutionBlockedError);
  await f.store.markExternalRequestStarted({...f.context,externalRequestRef:'request:c1-store'});
  document=await f.repository.readSnapshot();assert.equal(guard().job.status,'waiting_platform');
  f.advance(60001);assert.throws(guard,C1PaidKeywordExecutionBlockedError);
});

test('known not-sent and sent unknown failures survive expired lease and source drift without permitting replay',async()=>{
  for(const sent of [false,true]) {
    const f=await fixture();await f.claim();
    if(sent)await f.store.markExternalRequestStarted({...f.context,externalRequestRef:'request:c1-store'});
    const before=await f.repository.readSnapshot();
    assert.throws(()=>f.store.settleC1PaidKeywordFailureInDocument({document:structuredClone(before),...f.context,observedAt:f.clock(),status:'completed',externalRequestState:'succeeded',failureClass:'c1-paid-keyword-source-changed'}),/FAILURE_INVALID/);
    f.advance(60001);
    await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document,result:null};});
    const args={...f.context,observedAt:f.clock(),status:sent?'unknown_outcome':'failed',externalRequestState:sent?'unknown_outcome':'not_sent',failureClass:'c1-paid-keyword-source-changed'};
    assert.throws(()=>settleSoftwareJob({job:before.runtime.softwareJobs[0],...args,serverTime:f.clock()}),/LEASE_REJECTED/);
    await f.repository.transact(document=>({changed:true,document,result:f.store.settleC1PaidKeywordFailureInDocument({document,...args})}));
    const after=await f.repository.readSnapshot(),job=after.runtime.softwareJobs[0];
    assert.equal(job.status,args.status);assert.equal(job.externalRequestState,args.externalRequestState);
    assert.equal(job.completedAt,f.clock());assert.equal(job.leaseId,f.leaseId);assert.equal(job.automaticRetryAllowed,false);
    assert.equal(after.candidates[0].dataRevision,before.candidates[0].dataRevision+1);
    assert.deepEqual(f.store.settleC1PaidKeywordFailureInDocument({document:after,...args}),job);
    assert.throws(()=>f.store.settleC1PaidKeywordFailureInDocument({document:structuredClone(after),...args,leaseId:'lease:wrong'}),/LEASE_REJECTED/);
    const corrupt=structuredClone(before);corrupt.runtime.idempotencyRecords[0].candidateSnapshot.lifecycleV11.c1PaidKeywordEvidenceSeerfarRequestV1.skuIds=[100];
    assert.throws(()=>f.store.settleC1PaidKeywordFailureInDocument({document:corrupt,...args}),/SOURCE_CONFLICT/);
    await assert.rejects(f.claim(),/REJECTED|CONFLICT/);
  }
});

test('completion recovery selects only the exact applied current result and never reclaims the paid job',async()=>{
  const f=await fixture();let calls=0;
  const source=c1PaidKeywordFixtureReceipt();
  const receipt={observation:{...source.attempt,completed:true},candidates:source.candidates,pointsBefore:source.pointsBefore,pointsAfter:source.pointsAfter,pointsSpent:source.pointsSpent,evidence:source.providerEvidence};
  const result=await runC1PaidKeywordEvidenceSoftwareJob({repository:f.repository,softwareJobStore:f.store,worker:f.worker,jobId:f.jobId,
    leaseId:f.leaseId,leaseDurationMs:60000,openApiTransport:async()=>{calls++;return receipt;},serverClock:f.clock},
    {prepareRuntime:prepareC1PaidKeywordSettlementFixture});
  assert.equal(result.status,'committed');assert.equal(calls,1);
  const document=await f.repository.readSnapshot();assert.equal(document.runtime.softwareJobs[0].status,'completed');
  assert.deepEqual(await f.store.listC1KeywordContinuationJobs({limit:1,jobId:f.jobId}),[{jobId:f.jobId,candidateId:document.candidates[0].id,resultRevision:document.candidates[0].dataRevision}]);
  assert.deepEqual(await f.store.listC1KeywordContinuationJobs({limit:1,jobId:'job:other'}),[]);
  const savedCandidate=document.candidates[0],savedJob=document.runtime.softwareJobs[0];
  assert.deepEqual(assertC1PaidKeywordContinuationResult({candidate:savedCandidate,job:savedJob}),
    {jobId:f.jobId,candidateId:savedCandidate.id,resultRevision:savedCandidate.dataRevision});
  for(const mutate of [
    value=>{value.candidate.dataRevision++;},
    value=>{value.candidate.id='candidate:other';},
    value=>{value.candidate.lifecycleV11.c1AiDraftRequestV1={requestId:'existing'};},
    value=>{value.job.status='unknown_outcome';},
    value=>{value.candidate.lifecycleV11.c1PaidKeywordEvidenceSettlementV1.resultRef='result:other';},
    value=>{value.candidate.lifecycleV11.c1SoftwareEvidenceV1={schemaVersion:'wrong'};}
  ]) {
    const input={candidate:structuredClone(savedCandidate),job:structuredClone(savedJob)};mutate(input);
    assert.throws(()=>assertC1PaidKeywordContinuationResult(input),/CONTINUATION_SOURCE_CONFLICT/);
  }
  for (const exceptionJobId of [f.jobId,'job:other']) {
    await f.repository.transact(current=>{
      const candidate=current.candidates[0];
      candidate.executionRuntime=openExceptionCase(createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,businessPhase:'C1',stepId:'C1_KEYWORD_CONTINUATION',at:f.clock()}), {
        exceptionId:'exception:keyword-continuation',reasonCode:'system_failure',failureLayer:'c1_keyword_continuation',
        evidenceRefs:[current.runtime.softwareJobs[0].resultRef],skuPackageId:candidate.lifecycleV11.skuPackage.skuPackageId,
        softwareJobId:exceptionJobId,lastSuccessfulStepId:'keyword_evidence_saved',externalRequestRefs:[],unknownOutcome:false,at:f.clock()
      });
      return {changed:true,document:current,result:null};
    });
    const blocked=await f.repository.readSnapshot();
    assert.deepEqual(await f.store.listC1KeywordContinuationJobs({limit:1}),[]);
    assert.deepEqual(await f.repository.readSnapshot(),blocked);
    assert.deepEqual(blocked.runtime.softwareJobs[0],document.runtime.softwareJobs[0]);
  }
  for(const failureJobId of ['job:other',f.jobId]) {
    await f.repository.transact(current=>{
      const candidate=current.candidates[0];
      candidate.executionRuntime=blockExecutionForTechnicalFailure(createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,
        businessPhase:'C1',stepId:'C1_KEYWORD_HANDOFF',at:f.clock()}), {
        failureId:'failure:keyword-handoff',kind:'known_technical_failure',errorCode:'C1_DRAFT_RUNTIME_UNAVAILABLE',
        failureLayer:'c1_keyword_handoff',evidenceRefs:[current.runtime.softwareJobs[0].resultRef],softwareJobId:failureJobId,at:f.clock()
      });return {changed:true,document:current,result:null};
    });
    const blocked=await f.repository.readSnapshot();
    assert.equal((await f.store.listC1KeywordContinuationJobs({limit:1})).length,failureJobId===f.jobId?0:1);
    assert.deepEqual(await f.repository.readSnapshot(),blocked);assert.deepEqual(blocked.runtime.softwareJobs[0],document.runtime.softwareJobs[0]);
  }
  await f.repository.transact(current=>{delete current.candidates[0].executionRuntime;current.candidates[0].lifecycleV11.c1PaidKeywordEvidenceSettlementV1.resultFingerprint='0'.repeat(64);return {changed:true,document:current,result:null};});
  await assert.rejects(f.store.listC1KeywordContinuationJobs({limit:1}),/CONTINUATION_SOURCE_CONFLICT/);
});
