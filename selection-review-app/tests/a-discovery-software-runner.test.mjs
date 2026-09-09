import test from 'node:test';
import assert from 'node:assert/strict';
import { createADiscoveryRuntimeFixture } from './fixtures/a-discovery-runtime-fixture.mjs';

test('the secret boundary and each send guard reject revision drift before any paid fetch',async()=>{
  const f=createADiscoveryRuntimeFixture();let fetched=0;
  const {service}=f.create({readSecret:async()=>{
    await f.repository.transact(document=>{Object.values(document.runtime.aDiscoveryBatches)[0].revision++;return {changed:true,document};});
    return 'synthetic-only-value';
  },fetchImpl:async()=>{fetched++;throw new Error('Must not fetch');}});
  const result=await f.authorize(service,await f.prepare(service));assert.equal(result.status,'failed');assert.equal(fetched,0);
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0];
  assert.equal(job.externalRequestState,'not_sent');assert.equal(saved.runtime.aDiscoveryReceipts[job.jobId].failureClass,'BATCH_CHANGED');
  assert.equal(saved.runtime.softwareJobs.length,1);await service.stop();
});
test('unknown sent failures persist bounded technical evidence, preserve the original thrown value, and do not replay',async()=>{
  for(const error of [new TypeError('synthetic private failure detail'),null]){
    const f=createADiscoveryRuntimeFixture();let requests=0;
    const {service}=f.create({fetchImpl:async()=>{requests++;throw error;}});
    const created=await f.prepare(service);
    await assert.rejects(()=>f.authorize(service,created),value=>value===error);
    const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0],receipt=saved.runtime.aDiscoveryReceipts[job.jobId];
    assert.equal(job.status,'unknown_outcome');assert.equal(receipt.failureClass,'UNEXPECTED_SYSTEM_ERROR');assert.equal(service.status,'failed');
    assert.equal(JSON.stringify(saved).includes('synthetic private failure detail'),false);assert.equal(saved.candidates.length,0);
    const restarted=f.create().service;assert.deepEqual(await restarted.runDue(),{status:'idle',externalRequests:0});assert.equal(requests,1);
    await restarted.stop();await service.stop();
  }
});
test('stopping during credential resolution leaves an explicit unsent result and a late secret cannot fetch',async()=>{
  const f=createADiscoveryRuntimeFixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();let requests=0;
  const {service}=f.create({readSecret:async()=>{entered.resolve();await release.promise;return 'synthetic-only-value';},fetchImpl:async()=>{requests++;throw new Error('Must not fetch');}});
  const created=await f.prepare(service),running=f.authorize(service,created);await entered.promise;await service.stop();
  assert.equal((await running).status,'failed');release.resolve();await new Promise(resolve=>setImmediate(resolve));
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0];assert.equal(job.externalRequestState,'not_sent');assert.equal(requests,0);
});
test('a successful late response is retained as material without replacing reconciled unknown or advancing the plan',async()=>{
  const f=createADiscoveryRuntimeFixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const {service,store}=f.create({fetchImpl:async(...args)=>{entered.resolve();await release.promise;return f.fetchImpl(...args);}});
  const created=await f.prepare(service),running=f.authorize(service,created);await entered.promise;
  f.advance(60001);await store.reconcileAfterRestart();
  const original=await f.repository.readSnapshot(),originalJob=structuredClone(original.runtime.softwareJobs[0]);
  assert.equal(originalJob.status,'unknown_outcome');release.resolve();
  const result=await running;assert.equal(result.status,'idempotent_replay');assert.equal(result.lateMaterialSaved,true);
  const saved=await f.repository.readSnapshot(),receipt=saved.runtime.aDiscoveryReceipts[originalJob.jobId];
  assert.deepEqual(saved.runtime.softwareJobs[0],originalJob);assert.equal(receipt.status,'unknown_outcome');
  assert.equal(receipt.lateResult.result.status,'candidates_found');assert.equal(receipt.lateResult.result.products.length,1);
  assert.equal(saved.runtime.softwareJobs.length,1);assert.equal(f.imports.length,0);assert.deepEqual(await service.runDue(),{status:'idle',externalRequests:0});await service.stop();
});
test('an expired lease before credential access is a saved unsent failure',async()=>{
  const f=createADiscoveryRuntimeFixture(),base=f.create();
  const store={...base.store,async claim(input){const job=await base.store.claim(input);f.advance(60001);return job;}};
  const {service}=f.create({softwareJobStore:store}),created=await f.prepare(service);
  const result=await f.authorize(service,created);assert.equal(result.status,'failed');
  const saved=await f.repository.readSnapshot(),job=saved.runtime.softwareJobs[0];
  assert.equal(job.externalRequestState,'not_sent');assert.equal(saved.runtime.aDiscoveryReceipts[job.jobId].failureClass,'LEASE_EXPIRED');
  assert.deepEqual(f.counts(),{secrets:0,requests:0});await service.stop();await base.service.stop();
});
