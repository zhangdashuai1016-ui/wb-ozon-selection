import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { savedDProductionJobFixture } from './fixtures/d-production-saved-job-fixture.mjs';
import { runPersistedDExecution } from '../lib/d-e-software-integration.mjs';
import { readDInitialImportStoppedJobTerminal } from '../lib/d-platform-observation-contract.mjs';
import { settleDInitialImportStoppedSoftwareJobInDocument, settleSoftwareJob } from '../lib/software-job-contract.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
const clone=value=>structuredClone(value);

async function stoppedFixture(reason) {
  const f=await savedDProductionJobFixture();
  const outcome=await runPersistedDExecution({...f.input,platformObservationPolicy:{schemaVersion:'d-platform-observation-policy-v1',
    policyRef:'policy:synthetic:initial-stop',version:'version:1',maxQueries:3,intervalMs:10,requestTimeoutMs:1000,
    expiresAt:new Date(Date.parse(f.input.serverClock())+120000).toISOString()},
    createAdapter:f.createAdapter(async()=>{if(reason==='lease_expired')f.advance(60001);else f.changeServiceVersion();})});
  assert.equal(outcome.status,'failed');
  const document=await f.repository.readSnapshot();
  return {f,document,job:document.runtime.softwareJobs[0],candidate:document.candidates[0]};
}
test('published SKU and job contracts retain exact accepted import facts without starting observation, stock or E',async()=>{
  const validator=await loadPublishedSchemaValidator(),validateSku=validator.getSchema('product-lifecycle-v1.1'),validateJob=validator.getSchema('software-job-v1.schema.json');
  const root=JSON.parse(await readFile(new URL('../schema/product-lifecycle-v1.1.schema.json',import.meta.url),'utf8'));
  assert.deepEqual(root.$defs.SkuLifecyclePackage.properties.dSoftwareExecution.oneOf,[{type:'null'},{$ref:'d-software-execution-state-v1'},{$ref:'d-software-execution-state-v2'}]);
  for(const reason of ['lease_expired','context_changed']) {
    const {f,document,job,candidate}=await stoppedFixture(reason),sku=candidate.lifecycleV11.skuPackage;
    assert.deepEqual(f.calls,['/v3/product/import']);assert.equal(document.runtime.softwareJobs.length,1);
    assert.equal(job.status,'failed');assert.equal(job.externalRequestState,'succeeded');
    assert.equal(job.workerId,f.job.workerId);assert.equal(job.leaseId,f.job.leaseId);assert.equal(job.attempt,1);
    assert.equal(sku.productionRecord,null);assert.equal(sku.dSoftwareExecution.platformWrites,1);
    assert.equal(job.platformContinuation.inventoryWriteState,'not_sent');assert.equal(job.platformContinuation.queryCount,0);
    assert.deepEqual(job.platformContinuation.observationHistory,[]);
    assert.equal(job.resultEnvelope.payload.schemaVersion,'d-initial-import-stop-job-result-v1');
    assert.equal(job.resultEnvelope.payload.stopReason,reason);
    assert.equal(job.resultEnvelope.payload.taskId,'501');assert.equal(Object.hasOwn(job.resultEnvelope.payload,'lastObservationJobId'),false);
    const terminal=readDInitialImportStoppedJobTerminal({candidate,job,observedAt:f.input.serverClock()});
    assert.deepEqual(job.resultEnvelope.payload,terminal.payload);
    assert.equal(validateSku(sku),true,JSON.stringify(validateSku.errors));assert.equal(validateJob(job),true,JSON.stringify(validateJob.errors));
    for(const change of [
      value=>{value.status='unknown_outcome';value.externalRequestState='unknown_outcome';},
      value=>{value.resultEnvelope.payload.lastObservationJobId='fake:observation';},
      value=>{delete value.resultEnvelope.payload.checkpointFingerprint;},
      value=>{value.resultEnvelope.payload.stopReason='unknown_outcome';},
      value=>{value.resultEnvelope.leaseId=null;},
      value=>{value.platformContinuation.queryCount=1;},
      value=>{value.resultEnvelope.payload.schemaVersion='d-platform-stop-job-result-v1';}
    ]) {const invalid=clone(job);change(invalid);assert.equal(validateJob(invalid),false);}
  }
});
test('initial stop rejects old execution versions, conflicting accepted receipts and wrong holders; generic settlement cannot bypass it',async()=>{
  const {f,document,job,candidate}=await stoppedFixture('lease_expired');
  for(const change of [
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.schemaVersion='d-software-execution-state-v1';},
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.attempt.schemaVersion='d-software-execution-v1';},
    value=>{delete value.lifecycleV11.skuPackage.dSoftwareExecution.attempt.request.executionProtocolVersion;},
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.attempt.platformResult.taskId='502';},
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.attempt.platformResult.requestReceiptRef='receipt:wrong';},
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.checkpoints.pop();},
    value=>{value.lifecycleV11.skuPackage.dSoftwareExecution.platformWrites='unknown';}
  ]) {const invalid=clone(candidate);change(invalid);assert.throws(()=>readDInitialImportStoppedJobTerminal({candidate:invalid,job,observedAt:f.input.serverClock()}));}
  assert.throws(()=>settleDInitialImportStoppedSoftwareJobInDocument(document,{jobId:job.jobId,workerId:job.workerId,leaseId:job.leaseId},f.input.serverClock()),/INITIAL_IMPORT_STOP_INVALID/);
  const intermediate=clone(document);
  intermediate.runtime.softwareJobs[0]=clone(f.commits[0].runtime.softwareJobs[0]);
  const prior=intermediate.runtime.softwareJobs[0];assert.equal(prior.status,'waiting_platform');assert.equal(prior.externalRequestState,'in_flight');
  for(const identity of [{workerId:'worker:wrong',leaseId:prior.leaseId},{workerId:prior.workerId,leaseId:'lease:wrong'}]) {
    assert.throws(()=>settleDInitialImportStoppedSoftwareJobInDocument(clone(intermediate),{jobId:prior.jobId,...identity},f.input.serverClock()));
  }
  assert.throws(()=>settleSoftwareJob({job:prior,workerId:prior.workerId,leaseId:prior.leaseId,status:'failed',externalRequestState:'succeeded',
    failureClass:job.failureClass,resultEnvelope:job.resultEnvelope,serverTime:f.input.serverClock()}),/DOMAIN_SETTLEMENT_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(),document);
});
