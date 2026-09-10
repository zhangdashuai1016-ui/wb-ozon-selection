import test from 'node:test';
import assert from 'node:assert/strict';
import {createAProductDetailRuntimeFixture} from './fixtures/a-product-detail-runtime-fixture.mjs';

test('candidate drift while credential resolves saves an unsent failure and never fetches detail',async()=>{
  const f=await createAProductDetailRuntimeFixture();let fetched=0;
  const {service}=f.create({readSecret:async()=>{await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});return 'synthetic-secret';},fetchImpl:async()=>{fetched++;return new Response('{}');}});
  const outcome=await f.authorize(service);assert.equal(outcome.status,'failed');assert.equal(fetched,0);
  const saved=await f.repository.readSnapshot(),receipt=Object.values(saved.runtime.aProductDetailReceipts)[0];
  assert.equal(receipt.failureClass,'CANDIDATE_CHANGED');assert.equal(receipt.steps[0].externalRequestState,'not_sent');assert.equal(f.applications.length,0);await service.stop();
});

test('unknown thrown values are persisted as technical evidence and rethrown without replay',async()=>{
  for(const original of [new TypeError('synthetic private response'),null]){
    const f=await createAProductDetailRuntimeFixture(),{service}=f.create({fetchImpl:async()=>{throw original;}});
    let caught=false;try{await f.authorize(service);}catch(error){caught=true;assert.equal(error,original);}assert.equal(caught,true);
    const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs.find(value=>value.jobType==='a_product_detail_read');
    assert.equal(job.status,'unknown_outcome');assert.equal(saved.runtime.aProductDetailReceipts[job.jobId].failureClass,'UNEXPECTED_SYSTEM_ERROR');
    assert.equal(JSON.stringify(saved).includes('synthetic private response'),false);assert.equal(service.status,'failed');
    const next=f.create();assert.equal((await next.service.runDue()).status,'idle');assert.equal(f.applications.length,0);await next.service.stop();
  }
});

test('stopping before detail credential resolution completes cannot create a late request',async()=>{
  const f=await createAProductDetailRuntimeFixture();let resolveSecret,started;const ready=new Promise(resolve=>{started=resolve;});let fetched=0;
  const {service}=f.create({readSecret:async()=>{started();return new Promise(resolve=>{resolveSecret=resolve;});},fetchImpl:async()=>{fetched++;return new Response('{}');}});
  const running=f.authorize(service);await ready;await service.stop();const result=await running;
  assert.equal(result.status,'failed');resolveSecret('synthetic-secret');await new Promise(resolve=>setImmediate(resolve));assert.equal(fetched,0);
  const saved=await f.repository.readSnapshot(),receipt=Object.values(saved.runtime.aProductDetailReceipts)[0];assert.equal(receipt.failureClass,'CANCELLED');assert.equal(receipt.steps[0].externalRequestState,'not_sent');
});

test('a late successful detail response remains material under the original unknown terminal',async()=>{
  const f=await createAProductDetailRuntimeFixture();let release,started;const ready=new Promise(resolve=>{started=resolve;});
  const {service,store}=f.create({fetchImpl:async(url,options)=>{started();return new Promise(resolve=>{release=async()=>resolve(await f.fetchImpl(url,options));});}});
  const running=f.authorize(service);await ready;f.advance(60001);await store.reconcileAfterRestart();
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs.find(value=>value.jobType==='a_product_detail_read');assert.equal(job.status,'unknown_outcome');
  await release();const outcome=await running;assert.equal(outcome.lateMaterialSaved,true);
  const after=await f.repository.readSnapshot();assert.deepEqual(after.runtime.softwareJobs.find(value=>value.jobId===job.jobId),job);
  assert.equal(after.runtime.aProductDetailReceipts[job.jobId].lateResult.result.status,'observed');assert.equal(after.runtime.softwareJobs.filter(value=>value.jobType==='a_product_detail_read').length,1);
  assert.equal(f.applications.length,0);await service.stop();
});

test('the transport deadline reaches credential cancellation before any detail request',async()=>{
  const f=await createAProductDetailRuntimeFixture();let credentialSignal,fetched=0;
  const {service}=f.create({connectorBindings:[{...f.connectorBinding,timeoutMs:20}],readSecret:async({signal})=>{
    credentialSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },fetchImpl:async()=>{fetched++;return new Response('{}');}});
  const result=await f.authorize(service);assert.equal(result.status,'failed');assert.equal(credentialSignal.aborted,true);assert.equal(fetched,0);
  const saved=await f.repository.readSnapshot(),receipt=Object.values(saved.runtime.aProductDetailReceipts)[0];assert.equal(receipt.failureClass,'TIMEOUT');assert.equal(receipt.steps[0].externalRequestState,'not_sent');await service.stop();
});
