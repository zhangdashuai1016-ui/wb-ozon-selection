import test from 'node:test';
import assert from 'node:assert/strict';
import {createAProductDetailRuntimeFixture} from './fixtures/a-product-detail-runtime-fixture.mjs';
import {runAProductDetailSoftwareJob} from '../lib/a-product-detail-runner.mjs';

test('detail needs independent explicit permission and preserves the candidate until both receipts exist',async()=>{
  const f=await createAProductDetailRuntimeFixture(),{service}=f.create();
  const before=await f.repository.readSnapshot();
  assert.equal((await service.runDue()).status,'idle');assert.deepEqual(f.counts(),{secrets:0,requests:0});
  await assert.rejects(f.authorize(service,{productId:'999'}),/INPUT_INVALID/);
  const first=await f.authorize(service);assert.equal(first.status,'completed');
  let saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates,before.candidates);
  assert.equal(saved.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read').length,2);
  const permits=saved.runtime.softwareJobAuthorizationRecords.filter(value=>value.action==='a_product_detail_read');
  assert.equal(permits.length,2);assert.deepEqual(permits.map(value=>value.useCount),[1,1]);
  assert.equal(permits[0].scopeBinding.detailPlan.budget.maxCredits,13);
  assert.ok(permits.every(value=>value.scopeBinding.sourceRevision===f.candidate.dataRevision));
  assert.deepEqual(f.counts(),{secrets:1,requests:1});assert.equal(f.applications.length,0);
  const second=await service.runDue();assert.equal(second.status,'completed');assert.equal(f.applications.length,1);
  saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates,before.candidates);
  assert.equal(Object.keys(saved.runtime.aProductDetailReceipts).length,2);assert.equal(saved.runtime.aProductDetailReceipts[first.jobId].steps[0].result.status,'observed');
  assert.equal((await service.runDue()).status,'idle');assert.deepEqual(f.counts(),{secrets:2,requests:2});
  await assert.rejects(f.authorize(service,{idempotencyKey:'different:key'}),/ALREADY_APPLIED/);await service.stop();
});

test('the second explicit detail job survives restart without another market request or search authority',async()=>{
  const f=await createAProductDetailRuntimeFixture(),first=f.create();await f.authorize(first.service);await first.service.stop();
  const next=f.create();await next.service.runDue();
  assert.equal(f.calls.filter(url=>url.endsWith('/seerfar/ozon/productDetailSearch')).length,1);
  assert.equal(f.calls.filter(url=>url.endsWith('/alibaba1688/productDetail')).length,1);
  const saved=await f.repository.readSnapshot();assert.ok(saved.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read').every(job=>job.attempt===1));
  assert.ok(saved.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read').every(job=>!Object.hasOwn(job,'skuPackageId')&&!Object.hasOwn(job,'candidateId')&&job.subject.kind==='a_candidate'));
  assert.equal((await next.service.runDue()).status,'idle');await next.service.stop();
});

test('true empty market detail stops supplier spend and does not apply A evidence',async()=>{
  const f=await createAProductDetailRuntimeFixture(),{service}=f.create({fetchImpl:async()=>new Response(JSON.stringify({code:'200',errcode:200,total:0,products:[]}))});
  const result=await f.authorize(service);assert.equal(result.status,'completed');
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs.filter(job=>job.jobType==='a_product_detail_read').length,1);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords.filter(value=>value.action==='a_product_detail_read').map(value=>value.useCount),[1,0]);
  assert.equal((await service.runDue()).status,'idle');assert.equal(f.applications.length,0);await service.stop();
});

test('committed detail receipts recover only local application after a crash before callback',async()=>{
  const f=await createAProductDetailRuntimeFixture(),first=f.create();await f.authorize(first.service);
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs.find(job=>job.jobType==='a_product_detail_read'&&job.status==='queued');
  const worker=first.options.workerRegistry.heartbeat({workerId:f.serviceBinding.workerId,version:f.serviceBinding.workerVersion,capabilities:['linkfox-product-detail-api'],status:'online'});
  await runAProductDetailSoftwareJob({repository:f.repository,softwareJobStore:first.store,worker,jobId:job.jobId,leaseId:'lease:detail-final',leaseDurationMs:60000,
    connectorBinding:f.connectorBinding,readSecret:f.readSecret,fetchImpl:f.fetchImpl,serverClock:f.clock});
  assert.equal(f.applications.length,0);await first.service.stop();
  const next=f.create();assert.equal((await next.service.runDue()).status,'continued');assert.equal(f.applications.length,1);
  assert.equal((await next.service.runDue()).status,'idle');assert.deepEqual(f.counts(),{secrets:2,requests:2});
  const document=await f.repository.readSnapshot();assert.equal(next.service.view({document,actor:f.owner,candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision}).canAuthorize,false);
  await next.service.stop();
});

test('changing revision cannot reauthorize or replay an existing unknown detail request',async()=>{
  const f=await createAProductDetailRuntimeFixture(),original=new Error('synthetic detail transport failure'),first=f.create({fetchImpl:async()=>{throw original;}});
  await assert.rejects(f.authorize(first.service),error=>error===original);
  await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
  const next=f.create();await assert.rejects(f.authorize(next.service,{expectedRevision:f.candidate.dataRevision+1,idempotencyKey:'new:revision'}),/ALREADY_AUTHORIZED/);
  assert.equal((await next.service.runDue()).status,'idle');assert.equal(f.applications.length,0);await next.service.stop();
});

test('the authorization view shows only the two exact saved identities without creating permits',async()=>{
  const f=await createAProductDetailRuntimeFixture(),{service}=f.create(),document=await f.repository.readSnapshot(),before=JSON.stringify(document);
  const view=service.view({document,actor:f.owner,candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision});
  assert.equal(view.canAuthorize,true);assert.equal(view.preparationBlockCode,null);
  assert.deepEqual(view.proposedReads,[{method:'ozon_detail',productId:'2107989735',productUrl:'https://www.ozon.ru/product/2107989735/'},
    {method:'supplier_detail',productId:'876240928352',productUrl:'https://detail.1688.com/offer/876240928352.html'}]);
  assert.equal(JSON.stringify(document),before);assert.deepEqual(f.counts(),{secrets:0,requests:0});
  await f.authorize(service);const saved=await f.repository.readSnapshot();saved.candidates[0].dataRevision++;
  const history=service.view({document:saved,actor:f.owner,candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision+1});
  assert.equal(history.canAuthorize,false);assert.equal(history.preparationBlockCode,'ALREADY_AUTHORIZED');assert.deepEqual(history.proposedReads,view.proposedReads);
  assert.ok(history.jobs.every(value=>value.canContinue===false));await service.stop();
});

test('ineligible and missing-source candidates have explicit preparation blockers without paid actions',async()=>{
  const f=await createAProductDetailRuntimeFixture(),{service}=f.create();
  for(const mutate of [document=>{document.candidates[0].workflowStatus='eliminated';},document=>{delete document.candidates[0].aDiscoveryEvidenceV1;},document=>{document.runtime.aDiscoveryBatches={};}]){
    const document=await f.repository.readSnapshot();mutate(document);
    const view=service.view({document,actor:f.owner,candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision});
    assert.equal(view.canAuthorize,false);assert.ok(['CANDIDATE_CHANGED','SOURCE_INVALID'].includes(view.preparationBlockCode));assert.deepEqual(view.proposedReads,[]);
  }
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();
});


test('legacy detail view preserves absent runtime and rejects damaged runtime or collections',async()=>{
  const f=await createAProductDetailRuntimeFixture(),{service}=f.create();
  const document=await f.repository.readSnapshot();delete document.runtime;
  const before=JSON.stringify(document);Object.freeze(document);
  const input={document,actor:f.owner,candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision};
  const view=service.view(input);assert.equal(view.canAuthorize,false);assert.equal(view.preparationBlockCode,'SOURCE_INVALID');
  assert.deepEqual(view.jobs,[]);assert.deepEqual(view.proposedReads,[]);assert.equal(JSON.stringify(document),before);
  for(const runtime of [null,[],false,0,'invalid',undefined])assert.throws(()=>service.view({...input,document:{...document,runtime}}),/REPOSITORY_INVALID/);
  for(const key of ['softwareJobs','aProductDetailReceipts','aProductDetailApplications','aDiscoveryBatches']){
    for(const value of [null,false,0,'invalid',key==='softwareJobs'?{}:[]]){
      assert.throws(()=>service.view({...input,document:{...document,runtime:{[key]:value}}}),/REPOSITORY_INVALID/);
    }
  }
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();
});
