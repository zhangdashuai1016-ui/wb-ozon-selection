import assert from 'node:assert/strict';
import test from 'node:test';
import { savedDProductionJobFixture } from './fixtures/d-production-saved-job-fixture.mjs';
import { prepareSingleSkuDExecution } from '../lib/d-e-software-closure.mjs';
import { createDProductionPreparationIntent, completeDProductionPreparation, markDProductionPreparationUnknown,
  assertDProductionPreparation, assertDProductionPreparationContinuation, validateDProductionPreparation } from '../lib/d-production-preparation-contract.mjs';
import { inspectAdapterCapabilities, OZON_DE_READBACK_ENDPOINTS } from '../lib/ozon-seller-api-de-adapter.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
const f = await savedDProductionJobFixture();
// This test supplies its own current synthetic capability observation.
const caps=f.input.adapterCapabilities;
f.input.adapterCapabilities=inspectAdapterCapabilities({...caps,inspectedAt:f.input.serverClock(),
 storeIdentity:{status:'verified',expectedStore:caps.store,observedStore:caps.store,observedStoreRef:caps.storeRef,credentialAlias:caps.credentialAlias,evidenceRef:'evidence:synthetic:store'},
 productImport:{...caps.productImport,endpoint:'/v3/product/import',statusEndpoint:'/v1/product/import/info',protocolVersion:'ozon-product-import-v3'},
 assetTransport:{...caps.assetTransport,mode:'preapproved_stable_https',protocolVersion:'approved-https-assets-v1'},
 independentReadback:{...caps.independentReadback,protocolVersion:'ozon-independent-readback-v2',endpoints:OZON_DE_READBACK_ENDPOINTS}});
const intent = createDProductionPreparationIntent({job:f.job,candidateRevision:f.candidate.dataRevision,productionPlan:f.input.productionPlan,startedAt:f.input.serverClock()});
function complete(overrides={}) {
  const preparedExecution = prepareSingleSkuDExecution({productionAuthorization:f.input.productionPlan.sourceAuthorization,...f.input,preparedAt:f.input.serverClock(),...overrides});
  return completeDProductionPreparation({evidence:intent,platformWritePreflight:overrides.platformWritePreflight||f.input.platformWritePreflight,
    adapterCapabilities:f.input.adapterCapabilities,preparedExecution,completedAt:f.input.serverClock()});
}
test('real PA and preflight producers produce a closed intent and evidence-only ready result',()=>{
  const ready=complete(); assert.equal(assertDProductionPreparation(intent,{job:f.job}).status,'in_flight');
  assert.equal(assertDProductionPreparationContinuation(intent,ready).status,'ready');
  assert.equal(ready.result.preparedExecution.executableRequest,undefined);
  assert.equal(JSON.stringify(ready).includes('"endpoint"'),false);
  assert.equal(ready.revision,f.job.revision); assert.equal(ready.result.capabilities.evidenceRef,f.input.adapterCapabilities.evidenceRef);
});
test('real denied preflight remains not_ready and an unknown read contains no invented result',()=>{
  const p=structuredClone(f.input.platformWritePreflight);p.permission.status='denied';
  const result=complete({platformWritePreflight:p});assert.equal(result.status,'not_ready');assert.ok(result.result.preparedExecution.gaps.length);
  const unknown=markDProductionPreparationUnknown({evidence:intent,completedAt:f.input.serverClock()});
  assert.equal(unknown.result,null);assert.equal(unknown.continuationBlocked,true);
  assert.throws(()=>completeDProductionPreparation({evidence:unknown}),/ALREADY_RECORDED/);
});
test('closed source, holder, result, secret and inconsistent readiness are rejected',()=>{
  for (const mutation of [v=>{v.extra=true;},v=>{delete v.workerId;},v=>{v.jobId='job:other';},v=>{v.revision=-1;},
    v=>{v.result.preparedExecution.executableRequest={};},v=>{v.result.capabilities.endpoint='/v3/product/import';},
    v=>{v.result.platformWritePreflight.permission.secret='synthetic';},v=>{v.result.platformWritePreflight.sourceProductionPlanFingerprint='0'.repeat(64);},
    v=>{v.result.preparedExecution.gaps=[{code:'missing',field:'facts',message:'missing'}];}]){
    const invalid=complete();mutation(invalid);assert.equal(validateDProductionPreparation(invalid,{job:f.job}).valid,false);
  }
  assert.throws(()=>assertDProductionPreparation(complete(),{job:{...f.job,leaseId:'lease:other'}}),/JOB_CONFLICT/);
  assert.throws(()=>assertDProductionPreparationContinuation(complete(),complete()),/CONTINUATION_CONFLICT/);
});
test('published preparation variant preserves old jobs and rejects missing/excessive evidence or cross-domain borrowing',async()=>{
 const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');
 const validator=await loadPublishedSchemaValidator(),validate=validator.getSchema('software-job-v1.schema.json#/$defs/dProductionPreparation');
 for(const evidence of [intent,complete(),markDProductionPreparationUnknown({evidence:intent,completedAt:f.input.serverClock()})]){
  assert.equal(validate(evidence),true,JSON.stringify(validate.errors));
  for(const field of Object.keys(evidence).filter(field=>field!=='requestMode')){const invalid=structuredClone(evidence);delete invalid[field];assert.equal(validate(invalid),false);}
 }
 for(const change of [v=>{v.result.capabilities.header='synthetic';},v=>{v.result.preparedExecution.executableRequest={};},
  v=>{v.status='ready';v.result=null;},v=>{v.result.preparedExecution.gaps=[{code:'missing',field:'schema',message:'missing'}];}]){
  const invalid=complete();change(invalid);assert.equal(validate(invalid),false);
 }
 const validateJob=validator.getSchema('software-job-v1.schema.json');
 assert.equal(validateJob(f.job),true,JSON.stringify(validateJob.errors));
 const {c1AiSoftwareJobFixture}=await import('./fixtures/c1-ai-software-job-fixture.mjs');
 const c1=structuredClone(c1AiSoftwareJobFixture().job);c1.preparationEvidence=complete();assert.equal(validateJob(c1),false);
});
test('new request modes are immutable while historical v1 keeps its original external-read identity',async()=>{
 const local=createDProductionPreparationIntent({job:f.job,candidateRevision:f.candidate.dataRevision,
  productionPlan:f.input.productionPlan,startedAt:f.input.serverClock(),requestMode:'persisted_evidence_only'});
 assert.equal(intent.requestMode,'external_read');assert.equal(local.requestMode,'persisted_evidence_only');
 assert.notEqual(local.preparationId,intent.preparationId);
 for(const mutate of [v=>{v.requestMode='external_read';},v=>{delete v.requestMode;},v=>{v.requestMode='automatic';}]){
  const invalid=structuredClone(local);mutate(invalid);assert.equal(validateDProductionPreparation(invalid).valid,false);
 }
 const historical=structuredClone(intent);delete historical.requestMode;
 const historicalIdentity=Object.fromEntries(Object.entries(historical).filter(([key])=>!['preparationId','completedAt','status','result','continuationBlocked'].includes(key)));
 historical.preparationId=`d-preparation:${fingerprintCanonicalRecord(historicalIdentity)}`;
 assert.deepEqual(assertDProductionPreparation(historical,{job:f.job}),historical);
 const historicalUnknown=markDProductionPreparationUnknown({evidence:historical,completedAt:f.input.serverClock()});
 assert.equal(Object.hasOwn(historicalUnknown,'requestMode'),false);
 assert.equal(assertDProductionPreparationContinuation(historical,historicalUnknown).status,'unknown_outcome');
 assert.throws(()=>assertDProductionPreparationContinuation(intent,markDProductionPreparationUnknown({evidence:local,completedAt:f.input.serverClock()})),/CONTINUATION_CONFLICT/);
 const {loadPublishedSchemaValidator}=await import('./helpers/published-schema-validator.mjs');
 const validate=(await loadPublishedSchemaValidator()).getSchema('software-job-v1.schema.json#/$defs/dProductionPreparation');
 for(const evidence of [historical,historicalUnknown,local,intent])assert.equal(validate(evidence),true,JSON.stringify(validate.errors));
 const invalid=structuredClone(local);invalid.requestMode='automatic';assert.equal(validate(invalid),false);
});
test('completion binds the actual preparation producer to the saved plan and authorization',()=>{
 const prepared=prepareSingleSkuDExecution({productionAuthorization:f.input.productionPlan.sourceAuthorization,...f.input,preparedAt:f.input.serverClock()});
 assert.equal(prepared.schemaVersion,'d-software-execution-v2');
 const historicalPrepared={...prepared,schemaVersion:'d-software-execution-v1'};
 assert.throws(()=>completeDProductionPreparation({evidence:intent,platformWritePreflight:f.input.platformWritePreflight,
  adapterCapabilities:f.input.adapterCapabilities,preparedExecution:historicalPrepared,completedAt:f.input.serverClock()}),/PREPARED_SOURCE_CONFLICT/);
 for(const field of ['sourceProductionPlanId','sourceProductionPlanFingerprint','sourceAuthorizationFingerprint','preparedAt']){
  const invalid=structuredClone(prepared);invalid[field]=field==='preparedAt'?'2026-02-30T00:00:00.000Z':'other';
  assert.throws(()=>completeDProductionPreparation({evidence:intent,platformWritePreflight:f.input.platformWritePreflight,
   adapterCapabilities:f.input.adapterCapabilities,preparedExecution:invalid,completedAt:f.input.serverClock()}),/PREPARED_SOURCE_CONFLICT/);
 }
});

test('historical v1.1 preparation results can be read but cannot complete a new preparation', () => {
  const result = complete(), old = structuredClone(result);
  old.result.platformWritePreflight.schemaVersion = 'platform-write-preflight-v1.1';
  delete old.result.platformWritePreflight.connectionRequirements;
  const before = structuredClone(old);
  assert.equal(assertDProductionPreparation(old, { job: f.job }).status, result.status);
  assert.deepEqual(old, before);
  assert.throws(() => complete({ platformWritePreflight: old.result.platformWritePreflight }), /VERSION_OUTDATED/);
});
