import test from 'node:test';import assert from 'node:assert/strict';
import {assertAProductDetailScope,assertAProductDetailPlan,assertAProductDetailCandidateSource,assertAProductDetailSource,assertAProductDetailAuthorization,
 assertAProductDetailCredential,assertAProductDetailReceipt,readAProductDetailTerminal,interruptAProductDetailReceipt,nextAProductDetailRequest,assertAProductDetailAdmission,AProductDetailError} from '../lib/a-product-detail-contract.mjs';
import {createAProductDetailContractFixture,createAProductDetailContractReceipt} from './fixtures/a-product-detail-contract-fixture.mjs';
const at='2026-09-08T12:00:00.000Z';const known=code=>e=>e instanceof AProductDetailError&&e.code===code;
test('detail source uses saved market and first supplier identities without inventing SKU or spending search permission',()=>{
 const f=createAProductDetailContractFixture();assertAProductDetailScope(f.scope,f.job);assertAProductDetailAuthorization(f.authorization);assertAProductDetailCredential(f.credential);
 assert.equal(assertAProductDetailSource(f).supplierReceipt.steps[0].result.products[0].productId,f.scope.discoverySource.supplierOfferId);
 assert.equal(assertAProductDetailAdmission({...f,receipts:[],checkedAt:at}),true);assert.equal(Object.hasOwn(f.job,'skuPackageId'),false);
 assert.equal(f.scope.detailPlan.budget.maxCredits,13);f.authorization.authorizationType='a_discovery_once';assert.throws(()=>assertAProductDetailAuthorization(f.authorization),known('AUTHORIZATION_INVALID'));
});
test('candidate, plan, store and source identity changes reject all detail requests',()=>{
 for(const change of [f=>f.candidate.dataRevision++,f=>f.candidate.targetStore='dandanshu',f=>f.candidate.aDiscoveryEvidenceV1.marketProductId='2107989736']){
  const f=createAProductDetailContractFixture();change(f);assert.throws(()=>assertAProductDetailCandidateSource(f.candidate,f.scope),known('CANDIDATE_CHANGED'));
 }
 const f=createAProductDetailContractFixture();f.scope.discoverySource.supplierOfferId='876240928353';f.scope.detailPlan.requests[1].productId='876240928353';
 assert.throws(()=>assertAProductDetailSource(f),known('SOURCE_INVALID'));
});
test('the explicit two-request 13-credit plan cannot be enlarged or reordered',()=>{
 const f=createAProductDetailContractFixture();f.scope.detailPlan.budget.maxCredits=30;assert.throws(()=>assertAProductDetailPlan(f.scope.detailPlan),known('BUDGET_INVALID'));
 const g=createAProductDetailContractFixture();g.scope.detailPlan.requests.reverse();assert.throws(()=>assertAProductDetailPlan(g.scope.detailPlan),known('PLAN_SEQUENCE_INVALID'));
});
test('first receipt keeps source revision and unlocks only the preapproved supplier request',()=>{
 const f=createAProductDetailContractFixture(),before=structuredClone(f.candidate),receipt=createAProductDetailContractReceipt(f);
 assert.equal(readAProductDetailTerminal(receipt,f.job).status,'completed');
 assert.deepEqual(nextAProductDetailRequest({...f,receipts:[receipt]}),f.scope.detailPlan.requests[1]);assert.deepEqual(f.candidate,before);
 const second=structuredClone(f);second.scope.requestIndex=1;second.scope.request=second.scope.detailPlan.requests[1];second.scope.authorizationRef='permit:detail:1';
 second.job.jobId='job:detail:1';second.job.scopeBinding=second.scope;
 const completed=createAProductDetailContractReceipt(second);assert.equal(nextAProductDetailRequest({...f,receipts:[receipt,completed]}),null);
 assert.deepEqual(f.candidate,before);
});
test('empty, known failure and unknown sends stop; no stale candidate version can be resumed',()=>{
 const f=createAProductDetailContractFixture();assert.equal(nextAProductDetailRequest({...f,receipts:[createAProductDetailContractReceipt(f,{empty:true})]}),null);
 const receipt=createAProductDetailContractReceipt(f);receipt.status='in_flight';receipt.completedAt=null;receipt.steps[0].result=null;receipt.steps[0].completedAt=null;receipt.steps[0].externalRequestState='in_flight';receipt.steps[0].requestTransmission='attempted';
 const stopped=interruptAProductDetailReceipt(receipt,f.job,at,'TIMEOUT');assert.equal(stopped.status,'unknown_outcome');assert.equal(nextAProductDetailRequest({...f,receipts:[stopped]}),null);
 f.candidate.dataRevision++;assert.throws(()=>nextAProductDetailRequest({...f,receipts:[stopped]}),known('CANDIDATE_CHANGED'));
});
test('result identity and late result identity are tied to the original detail request',()=>{
 const f=createAProductDetailContractFixture(),receipt=createAProductDetailContractReceipt(f);receipt.steps[0].result.requestId='detail:wrong';
 assert.throws(()=>assertAProductDetailReceipt(receipt,f.job),known('STEP_RESULT_INVALID'));
});
test('published detail schema roundtrips strict records and cannot interchange discovery and candidate subjects',async()=>{
 const {readFile}=await import('node:fs/promises'),{default:Ajv2020}=await import('ajv/dist/2020.js'),{default:addFormats}=await import('ajv-formats');
 const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(JSON.parse(await readFile(new URL('../schema/a-product-detail-v1.schema.json',import.meta.url),'utf8')));
 const f=createAProductDetailContractFixture(),receipt=createAProductDetailContractReceipt(f);
 for(const [name,value]of Object.entries({scope:f.scope,plan:f.scope.detailPlan,subject:f.job.subject,authorization:f.authorization,credential:f.credential,receipt})){
  const validate=ajv.getSchema(`a-product-detail-v1.schema.json#/$defs/${name}`);assert.equal(validate(JSON.parse(JSON.stringify(value))),true,JSON.stringify(validate.errors));
  assert.equal(validate({...value,extra:true}),false);
 }
 const validate=ajv.getSchema('a-product-detail-v1.schema.json#/$defs/subject');assert.equal(validate({kind:'discovery_batch',batchId:'batch:1',revision:0}),false);
});
test('retained discovery provenance cannot reactivate an eliminated or already advanced candidate',()=>{
 for(const mutate of [c=>c.workflowStatus='eliminated',c=>c.eliminatedAt=at,c=>c.lifecycleV11={},c=>c.salesSnapshotsV11=[{snapshotId:'saved:1'}]]){
  const f=createAProductDetailContractFixture();mutate(f.candidate);assert.throws(()=>assertAProductDetailCandidateSource(f.candidate,f.scope),known('CANDIDATE_CHANGED'));
 }
});
