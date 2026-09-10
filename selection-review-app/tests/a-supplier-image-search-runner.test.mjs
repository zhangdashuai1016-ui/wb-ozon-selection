import test from 'node:test';
import assert from 'node:assert/strict';
import { runASupplierImageSearchSoftwareJob, recordASupplierImageSearchLateResult } from '../lib/a-supplier-image-search-runner.mjs';
import { ASupplierImageSearchError } from '../lib/a-supplier-image-search-contract.mjs';
import { createASupplierImageSearchStoreFixture, createASupplierImageSearchReceipt } from './helpers/a-supplier-image-search-fixture.mjs';

async function setup(t) {
  const f = await createASupplierImageSearchStoreFixture(t);
  await f.store.enqueue(f.job);
  const input = { repository: f.repository, softwareJobStore: f.store, worker: f.worker, jobId: f.job.jobId,
    leaseId: 'lease:synthetic-runner', leaseDurationMs: 60000, serverClock: f.clock };
  const result = () => createASupplierImageSearchReceipt({ scope: f.scope, job: f.job, at: f.clock() }).steps[0].result;
  return { ...f, input, result };
}

test('without a real page adapter the queued job and authorization remain untouched', async t => {
  const f = await setup(t), before = await f.repository.readSnapshot();
  assert.equal((await runASupplierImageSearchSoftwareJob(f.input)).status, 'not_configured');
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('an injected protocol adapter sees a durable send intent; replay executes zero submissions', async t => {
  const f = await setup(t); let submissions = 0;
  const pageAdapter = { async execute({ beforeSubmit }) {
    await beforeSubmit();
    const current = await f.coldRepository().readSnapshot();
    assert.equal(current.runtime.aSupplierImageSearchReceipts[f.job.jobId].steps[0].externalRequestState, 'in_flight');
    submissions++; return f.result();
  } };
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter })).status, 'completed');
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter })).status, 'idempotent_replay');
  assert.equal(submissions, 1);
  assert.deepEqual((await f.repository.readSnapshot()).candidates, [f.candidate]);
});

test('expired authorization at submission prevents the image action', async t => {
  const f = await setup(t); let submissions = 0;
  const pageAdapter = { async execute({ beforeSubmit }) { f.advance(11000); await beforeSubmit(); submissions++; return f.result(); } };
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter })).status, 'failed');
  assert.equal(submissions, 0);
});

test('an error after submission is unknown and cannot be replayed', async t => {
  const f = await setup(t); let submissions = 0;
  const pageAdapter = { async execute({ beforeSubmit }) { await beforeSubmit(); submissions++; throw new ASupplierImageSearchError('NETWORK_ERROR'); } };
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter })).status, 'unknown_outcome');
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter })).status, 'idempotent_replay');
  assert.equal(submissions, 1);
});

test('unknown adapter errors are persisted and still propagate with their original identity', async t => {
  const f = await setup(t), failure = new Error('synthetic adapter bug');
  const pageAdapter = { async execute({ beforeSubmit }) { await beforeSubmit(); throw failure; } };
  await assert.rejects(runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter }), error => error === failure);
  assert.equal((await f.store.get(f.job.jobId)).status, 'unknown_outcome');
});

test('a bounded timeout aborts the adapter and retains unknown outcome', async t => {
  const f = await setup(t); let observedSignal;
  const pageAdapter = { async execute({ beforeSubmit, signal }) {
    observedSignal = signal; await beforeSubmit();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
  } };
  assert.equal((await runASupplierImageSearchSoftwareJob({ ...f.input, pageAdapter, timeoutMs: 100 })).status, 'unknown_outcome');
  assert.equal(observedSignal.aborted, true);
});


test('authorization or lease expiration on response retains material without completing', async t => {
  for (const lease of [false,true]) {
    const f=await setup(t);
    const pageAdapter={async execute({beforeSubmit}) {await beforeSubmit();f.advance(lease?1001:11000);return f.result();}};
    const result=await runASupplierImageSearchSoftwareJob({...f.input,leaseDurationMs:lease?1000:60000,pageAdapter});
    assert.equal(result.status,'unknown_outcome');
    assert.equal(result.receipt.failureClass,lease?'LEASE_EXPIRED':'AUTHORIZATION_EXPIRED');
    assert.deepEqual(result.receipt.lateResult.result,f.result());
    assert.equal((await f.store.get(f.job.jobId)).resultEnvelope,null);
  }
});

test('cancellation with an arriving response cannot become completed', async t => {
  const f=await setup(t),controller=new AbortController();
  const pageAdapter={async execute({beforeSubmit}) {await beforeSubmit();controller.abort();return f.result();}};
  const result=await runASupplierImageSearchSoftwareJob({...f.input,signal:controller.signal,pageAdapter});
  assert.equal(result.status,'unknown_outcome');assert.equal(result.receipt.failureClass,'CANCELLED');
});

test('initialization source failure persists a zero-step failure after claim', async t => {
  const f=await setup(t);let executions=0;
  const store={...f.store,async claim(input){const result=await f.store.claim(input);await f.repository.transact(document=>{
    document.candidates[0].dataRevision++;return {changed:true,document,result:null};});return result;}};
  const result=await runASupplierImageSearchSoftwareJob({...f.input,softwareJobStore:store,pageAdapter:{async execute(){executions++;}}});
  assert.equal(result.status,'failed');assert.equal(result.receipt.failureClass,'CANDIDATE_CHANGED');
  assert.deepEqual(result.receipt.steps,[]);assert.equal(executions,0);
});

test('timeout while awaiting submission persistence never authorizes an upload', async t => {
  const f=await setup(t);let calls=0,submissions=0,adapterFinished;
  const adapterDone=new Promise(resolve=>{adapterFinished=resolve;});
  const repository={...f.repository,async transact(operation){calls++;if(calls===2)await new Promise(resolve=>setTimeout(resolve,1200));return f.repository.transact(operation);}};
  const pageAdapter={async execute({beforeSubmit}){try {await beforeSubmit();submissions++;return f.result();}finally{adapterFinished();}}};
  const result=await runASupplierImageSearchSoftwareJob({...f.input,repository,pageAdapter,timeoutMs:1000});
  await adapterDone;
  assert.equal(result.status,'failed');assert.equal(submissions,0);
  assert.equal((await f.repository.readSnapshot()).runtime.aSupplierImageSearchReceipts[f.job.jobId].steps[0].sentAt,null);
});

test('source mutation between send and response is unknown and preserves normalized material', async t => {
  const f=await setup(t);
  const pageAdapter={async execute({beforeSubmit}){await beforeSubmit();await f.repository.transact(document=>{
    document.candidates[0].salesSnapshotsV11[0].imageRefs[0]='https://images.example.com/changed.jpg';
    return {changed:true,document,result:null};});return f.result();}};
  const result=await runASupplierImageSearchSoftwareJob({...f.input,pageAdapter});
  assert.equal(result.status,'unknown_outcome');assert.equal(result.receipt.failureClass,'SOURCE_INVALID');
  assert.deepEqual(result.receipt.lateResult.result,f.result());
});

test('late delivery is explicit idempotent and cannot change unknown into success', async t => {
  const f=await setup(t);let signal;
  const pageAdapter={async execute(args){signal=args.signal;await args.beforeSubmit();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(null),{once:true}));}};
  assert.equal((await runASupplierImageSearchSoftwareJob({...f.input,pageAdapter,timeoutMs:100})).status,'unknown_outcome');
  const input={repository:f.repository,jobId:f.job.jobId,workerId:f.worker.workerId,leaseId:f.input.leaseId,result:f.result(),serverClock:f.clock};
  assert.equal((await recordASupplierImageSearchLateResult(input)).status,'unknown_outcome');
  assert.equal((await recordASupplierImageSearchLateResult(input)).lateMaterialSaved,true);
  assert.equal((await f.store.get(f.job.jobId)).resultEnvelope,null);
  await assert.rejects(recordASupplierImageSearchLateResult({...input,leaseId:'lease:wrong'}),/JOB_SOURCE_CONFLICT/);
  await assert.rejects(recordASupplierImageSearchLateResult({...input,result:{...f.result(),completionEvidenceRef:'evidence:changed'}}),/LATE_RESULT_INVALID/);
});

test('abort after intent commit but before callback returns prevents submission and retains uncertainty', async t => {
  const f=await setup(t),controller=new AbortController();let calls=0,submissions=0;
  const repository={...f.repository,async transact(operation){calls++;const count=calls;const result=await f.repository.transact(operation);if(count===2)controller.abort();return result;}};
  const pageAdapter={async execute({beforeSubmit}){await beforeSubmit();submissions++;return f.result();}};
  const result=await runASupplierImageSearchSoftwareJob({...f.input,repository,signal:controller.signal,pageAdapter});
  assert.equal(result.status,'unknown_outcome');assert.equal(submissions,0);
  assert.notEqual(result.receipt.steps[0].sentAt,null);
});

test('an unexpected initialization failure is recorded and retains its original error', async t => {
  const f=await setup(t),failure=new Error('synthetic initialization bug');let calls=0,executions=0;
  const repository={...f.repository,async transact(operation){calls++;if(calls===1)throw failure;return f.repository.transact(operation);}};
  await assert.rejects(runASupplierImageSearchSoftwareJob({...f.input,repository,pageAdapter:{async execute(){executions++;}}}),error=>error===failure);
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.softwareJobs[0].status,'failed');
  assert.equal(saved.runtime.aSupplierImageSearchReceipts[f.job.jobId].failureClass,'UNEXPECTED_SYSTEM_ERROR');assert.equal(executions,0);
});
