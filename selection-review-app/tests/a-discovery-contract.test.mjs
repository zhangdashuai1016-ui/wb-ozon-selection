import test from 'node:test';
import assert from 'node:assert/strict';
import { assertADiscoveryPlan,assertADiscoveryBatch,assertADiscoveryScope,assertADiscoveryBatchSource,assertADiscoveryAuthorization,assertADiscoveryCredential,
  assertADiscoveryReceipt,readADiscoveryTerminal,interruptADiscoveryReceipt,nextADiscoveryRequest,assertADiscoveryAdmission,ADiscoveryError } from '../lib/a-discovery-contract.mjs';
import {createADiscoveryContractFixture,createADiscoveryContractReceipt,discoveryAt} from './fixtures/a-discovery-contract-fixture.mjs';
const known=code=>error=>error instanceof ADiscoveryError&&error.code===code;
test('explicit finite plan and batch are strictly validated without inventing a candidate or approval',()=>{
  const f=createADiscoveryContractFixture();assert.deepEqual(assertADiscoveryBatch(f.batch),f.batch);
  assert.deepEqual(assertADiscoveryScope(f.scope,f.job),f.scope);assert.equal(Object.hasOwn(f.job,'candidateId'),false);
  assert.deepEqual(assertADiscoveryAuthorization(f.authorization),f.authorization);assert.deepEqual(assertADiscoveryCredential(f.credential),f.credential);
  assert.equal(assertADiscoveryAdmission({...f,receipts:[],checkedAt:discoveryAt}),true);
  assert.deepEqual(nextADiscoveryRequest({batch:f.batch,receipts:[]}),f.scope.request);
});
test('budget, count, sequence and duplicate queries cannot silently expand',()=>{
  for(const mutate of [p=>p.budget.maxCredits=29,p=>p.budget.maxRequests=4]){
    const p=createADiscoveryContractFixture().batch.plan;mutate(p);assert.throws(()=>assertADiscoveryPlan(p),known('BUDGET_INVALID'));
  }
  const duplicate=createADiscoveryContractFixture().batch.plan;duplicate.requests[2].requestId=duplicate.requests[1].requestId;
  assert.throws(()=>assertADiscoveryPlan(duplicate),known('PLAN_INVALID'));
  const p=createADiscoveryContractFixture().batch.plan;[p.requests[0],p.requests[1]]=[p.requests[1],p.requests[0]];
  assert.throws(()=>assertADiscoveryPlan(p),known('PLAN_SEQUENCE_INVALID'));
});
test('current revision, target store, provider route and owner permission are independent mandatory gates',()=>{
  for(const field of ['revision','targetStore','bindingId','configurationVersion','credentialAlias','budgetPolicyRef']){
    const f=createADiscoveryContractFixture();f.batch[field]=field==='revision'?1:field==='targetStore'?'dandanshu':'changed:ref';
    assert.throws(()=>assertADiscoveryBatchSource(f.batch,f.scope),known('BATCH_CHANGED'));
  }
  const f=createADiscoveryContractFixture();f.authorization.authorizedByUserId='owner:other';
  assert.throws(()=>assertADiscoveryAdmission({...f,receipts:[],checkedAt:discoveryAt}),known('AUTHORIZATION_INVALID'));
  f.authorization.authorizedByUserId=f.batch.ownerUserId;
  assert.throws(()=>assertADiscoveryAdmission({...f,receipts:[],checkedAt:f.scope.expiresAt}),known('AUTHORIZATION_EXPIRED'));
});
test('successful discovery is evidence only; exact SKU match and seller identity stay unknown',()=>{
  const f=createADiscoveryContractFixture(),receipt=createADiscoveryContractReceipt(f);
  assert.deepEqual(readADiscoveryTerminal(receipt,f.job),{status:'completed',externalRequestState:'succeeded',failureClass:null});
  assert.equal(receipt.steps[0].result.products[0].exactSkuMatch,'unknown');assert.equal(receipt.steps[0].result.accounting.actualCharge,'unknown');
  assert.deepEqual(nextADiscoveryRequest({batch:f.batch,receipts:[receipt]}),f.batch.plan.requests[1]);
  receipt.steps[0].result.products[0].exactSkuMatch='confirmed';assert.throws(()=>assertADiscoveryReceipt(receipt,f.job));
});
test('true empty, known failure and uncertain send each stop without making another request',()=>{
  const f=createADiscoveryContractFixture();
  assert.equal(nextADiscoveryRequest({batch:f.batch,receipts:[createADiscoveryContractReceipt(f,{empty:true})]}),null);
  for(const sent of [false,true]){
    const receipt=createADiscoveryContractReceipt(f);receipt.status='in_flight';receipt.completedAt=null;const step=receipt.steps[0];
    step.result=null;step.completedAt=null;step.sentAt=sent?discoveryAt:null;step.externalRequestState=sent?'in_flight':'not_sent';step.requestTransmission=sent?'attempted':'not_attempted';
    const stopped=interruptADiscoveryReceipt(receipt,f.job,discoveryAt,sent?'TIMEOUT':'CREDENTIAL_MISSING');
    assert.equal(stopped.status,sent?'unknown_outcome':'failed');assert.equal(nextADiscoveryRequest({batch:f.batch,receipts:[stopped]}),null);
  }
});
test('receipt duplication, skipped queries, cross-batch source and forged success are rejected',()=>{
  const f=createADiscoveryContractFixture(),receipt=createADiscoveryContractReceipt(f);
  assert.throws(()=>nextADiscoveryRequest({batch:f.batch,receipts:[receipt,receipt]}),known('SEQUENCE_INVALID'));
  const changed=structuredClone(receipt);changed.scope.batchId='batch:other';assert.throws(()=>assertADiscoveryReceipt(changed,f.job),known('JOB_SOURCE_CONFLICT'));
  receipt.steps[0].requestTransmission='attempted';assert.throws(()=>assertADiscoveryReceipt(receipt,f.job),known('STEP_RESULT_INVALID'));
});
test('one-use permission cannot be represented as consumed without a matching job and time',()=>{
  const f=createADiscoveryContractFixture();f.authorization.useCount=1;
  assert.throws(()=>assertADiscoveryAuthorization(f.authorization),known('AUTHORIZATION_INVALID'));
  f.authorization.consumedByJobId=f.job.jobId;f.authorization.consumedAt=discoveryAt;assertADiscoveryAuthorization(f.authorization);
  f.authorization.consumedAt=f.authorization.expiresAt;assert.throws(()=>assertADiscoveryAuthorization(f.authorization),known('AUTHORIZATION_INVALID'));
});

test('published schema roundtrips each closed record and preserves unknown instead of asserting facts',async()=>{
  const {readFile}=await import('node:fs/promises');const {default:Ajv2020}=await import('ajv/dist/2020.js');const {default:addFormats}=await import('ajv-formats');
  const schema=JSON.parse(await readFile(new URL('../schema/a-discovery-v1.schema.json',import.meta.url),'utf8'));
  const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(schema);
  const f=createADiscoveryContractFixture(),receipt=createADiscoveryContractReceipt(f);
  for(const [name,value] of Object.entries({batch:f.batch,plan:f.batch.plan,scope:f.scope,authorization:f.authorization,credential:f.credential,subject:f.job.subject,receipt})){
    const validate=ajv.getSchema(`a-discovery-v1.schema.json#/$defs/${name}`);
    assert.equal(validate(JSON.parse(JSON.stringify(value))),true,JSON.stringify(validate.errors));
    assert.equal(validate({...value,unexpected:'field'}),false,name);
  }
  const validate=ajv.getSchema('a-discovery-v1.schema.json#/$defs/receipt');
  assert.equal(validate(receipt),true);receipt.steps[0].result.products[0].sellerIdentity='verified';assert.equal(validate(receipt),false);
  const changed=createADiscoveryContractReceipt(f);changed.scope.batchId='batch:other';
  assert.equal(validate(changed),true);assert.throws(()=>assertADiscoveryReceipt(changed,f.job),known('JOB_SOURCE_CONFLICT'));
});
test('first-item selection is an explicit one-candidate provider-order policy',()=>{
 const p=createADiscoveryContractFixture().batch.plan;
 assert.equal(assertADiscoveryPlan(p).selection.maxCandidates,1);
 for(const selection of [{schemaVersion:'a-discovery-selection-v1',marketOrder:'provider_order',maxCandidates:20},
   {schemaVersion:'a-discovery-selection-v1',marketOrder:'cheapest',maxCandidates:1}])assert.throws(()=>assertADiscoveryPlan({...p,selection}),known('SELECTION_INVALID'));
});
test('late successful DTO is retained only as evidence on an unknown sent receipt without advancing',()=>{
 const f=createADiscoveryContractFixture(),completed=createADiscoveryContractReceipt(f),pending=structuredClone(completed);pending.status='in_flight';pending.completedAt=null;
 pending.steps[0].result=null;pending.steps[0].completedAt=null;pending.steps[0].externalRequestState='in_flight';pending.steps[0].requestTransmission='attempted';
 const stopped=interruptADiscoveryReceipt(pending,f.job,discoveryAt,'TIMEOUT');stopped.lateResult={recordedAt:discoveryAt,result:completed.steps[0].result};
 assertADiscoveryReceipt(stopped,f.job);assert.equal(readADiscoveryTerminal(stopped,f.job).status,'unknown_outcome');assert.equal(nextADiscoveryRequest({batch:f.batch,receipts:[stopped]}),null);
 const wrong=structuredClone(stopped);wrong.lateResult.result.requestId='request:other';assert.throws(()=>assertADiscoveryReceipt(wrong,f.job));
 const early=structuredClone(stopped);early.lateResult.recordedAt='2026-09-08T11:59:00.000Z';assert.throws(()=>assertADiscoveryReceipt(early,f.job),known('LATE_RESULT_INVALID'));
 completed.lateResult=stopped.lateResult;assert.throws(()=>assertADiscoveryReceipt(completed,f.job),known('LATE_RESULT_INVALID'));
});
