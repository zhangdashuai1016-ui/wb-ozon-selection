import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparedFixture, capabilities as formalCapabilities } from './helpers/d-software-fixture.mjs';
import { finalAssets as syntheticFinalAssets } from './helpers/c2-software-fixture.mjs';
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../lib/ozon-seller-api-de-adapter.mjs';
import { OzonDEHttpTransportError } from '../lib/ozon-de-http-configuration.mjs';
import { createPersistedDBatchImportRuntime } from '../lib/d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';
import { deSoftwareJobScopeFixture } from './fixtures/d-e-software-job-scope-fixture.mjs';
import { validateProductionRecord } from '../lib/production-record-contract.mjs';
import { loadOzonProductImportBatchLimitFact, createOzonProductImportBatchLimitUse } from '../lib/ozon-product-import-batch-limit.mjs';
import { ozonAccountReadCoordinationState } from '../lib/ozon-account-read-coordination.mjs';
import { accountReadConcurrencyFixture, waitForAccountReadBoundary } from './helpers/account-read-concurrency-fixture.mjs';

const at = '2026-08-22T07:25:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10,
  intervalMs: 0, expiresAt: '2026-09-01T00:00:00.000Z', requestTimeoutMs: 10_000 };
const binding = { warehouseRef: 'warehouse:synthetic:dandanshu', credentialAlias: 'credential-alias:synthetic:dandanshu' };

async function fixture({ failReceipt = false, createAdapterFailures = 0, observationItems = null, count = 2,
  inventoryAction = null, maxItemsPerRequest = null, failImportCall = null,
  expireLimitAfterIntentChunk = null, failPrewriteCheckpoint = false,
  importFailure = null, beforeImportResponse = null, beforeSendFailure = null, scopedLimit = false, beforeAdapter = null } = {}) {
  let currentTime = scopedLimit ? '2026-10-18T13:15:00.000Z' : at;
  const colors = count === 2 ? ['white', 'black'] : ['black', 'navy', 'khaki'];
  const sources = [];
  for (let index = 0; index < count; index++) {
    const color = colors[index % colors.length];
    const name = count === 2 ? ['A', 'B'][index] : String(index + 2).padStart(2, '0');
    const assets = index === 0 && count === 2 ? undefined : syntheticFinalAssets().map((asset, assetIndex) => ({ ...asset,
      assetId: `${asset.assetId}:${name}`,
      assetRef: assetIndex === 0 ? `https://assets.example.com/${color}-main.jpg` : asset.assetRef,
      sha256: assetIndex === 0 ? ({ white: 'a', black: 'c', navy: 'e', khaki: 'f' })[color].repeat(64) : asset.sha256 }));
    sources.push(await preparedFixture({ candidateId: `candidate:batch-${name.toLowerCase()}`,
      supplierSkuId: `SHELF-${name}`, merchantSku: `BATCH-${name}`, assets, ...binding }));
  }
  const members = sources.map((source, index) => ({ request: source.prepared.executableRequest,
    executionContext: { ...source.executionContext, serverClock: () => currentTime },
    platformWritePreflight: source.preflight,
    colorKey: colors[index % colors.length],
    modelKey: 'same-product', sourceTechnicalStatus: 'not_started', observationPolicy }));
  const capability = formalCapabilities('dandanshu', members.flatMap(member => member.request.finalUploads), members[0].request);
  capability.warehouseId = '70001';
  capability.assetTransport.resolvedAssets = members.flatMap(member => member.request.finalUploads.map(asset => ({
    assetId: asset.assetId, platformAcceptedUrl: asset.platformAcceptedUrl, sha256: asset.sha256,
    order: asset.order, authorizationStatus: 'approved', stable: true, evidenceRef: `evidence:asset:${asset.assetId}` })));
  capability.productImport.endpoint = '/v3/product/import';
  capability.productImport.maxItemsPerRequest = maxItemsPerRequest ?? (count === 2 ? 2 : 10);
  capability.productImport.limitEvidenceRef = 'synthetic:batch-limit';
  capability.productImport.limitObservedAt = '2026-08-22T07:00:00.000Z';
  capability.productImport.validUntil = '2026-09-01T00:00:00.000Z';
  if (expireLimitAfterIntentChunk !== null)
    capability.productImport.validUntil = '2026-08-22T07:25:01.000Z';
  const document = initialBusinessStateDocument({ now: at });
  document.candidates = sources.map((source, index) => ({ id: source.fixture.candidateId,
    dataRevision: source.fixture.candidateRevision, targetPlatform: 'ozon', targetStore: 'dandanshu',
    storeRef: structuredClone(members[index].request.storeRef),
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } }));
  document.runtime.dProductionBatches = [{ schemaVersion: inventoryAction===null ?
    'd-batch-production-authorization-v1':'d-batch-production-authorization-v2',
    batchId: 'd-batch:synthetic', status: 'authorized', externalRequestState: 'not_sent',
    storeRef: structuredClone(members[0].request.storeRef),
    excludedOfferIds: ['BATCH-FIRST'], ...(inventoryAction===null?{}:{postImportScope:{
      schemaVersion:'d-batch-post-import-scope-v1',inventoryAction,
      eReadbackOfferIds:members.map(member=>member.request.merchantSku)}}),
    members: sources.map((source, index) => ({
      candidateId: source.fixture.candidateId, skuPackageId: source.fixture.skuPackage.skuPackageId,
      offerId: members[index].request.merchantSku, resultRevision: source.fixture.candidateRevision,
      authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization),
      status: 'authorized', taskId: null, productId: null })) }];
  if (scopedLimit) {
    const fact=await loadOzonProductImportBatchLimitFact(),batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v3';
    batch.ownerActorId='synthetic-owner';batch.confirmedAt=currentTime;
    for(const saved of batch.members) saved.sourceRevision=saved.resultRevision-1;
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v2',inventoryAction:inventoryAction??'create_only',
      eReadbackOfferIds:batch.members.map(member=>member.offerId),inSaleList:{
        schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
        officialEvidenceRef:'official:ozon-in-sale-list:20261018',
        policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}};
    batch.importLimitUse=createOzonProductImportBatchLimitUse({batch,input:{
      schemaVersion:'ozon-product-import-batch-limit-use-input-v1',evidenceRef:fact.evidenceRef,decision:'use_for_this_batch_once'}});
    Object.assign(capability.productImport,{maxItemsPerRequest:100,limitEvidenceRef:fact.evidenceRef,
      limitObservedAt:fact.observedAt,limitUse:structuredClone(batch.importLimitUse)});
    delete capability.productImport.validUntil;
    for(const member of members) {
      member.executionContext.currentProductionBinding=structuredClone(member.executionContext.currentProductionBinding);
      member.executionContext.currentProductionBinding.verification.expiresAt='2026-11-01T00:00:00.000Z';
      member.observationPolicy={...observationPolicy,expiresAt:'2026-11-01T00:00:00.000Z'};
    }
  }
  const baseRepository = createMemoryBusinessStateRepository(document);
  let rejectReceipt = failReceipt;
  let rejectPrewrite = failPrewriteCheckpoint;
  const repository = failReceipt || failPrewriteCheckpoint ? { ...baseRepository, transact: mutator => baseRepository.transact(async saved => {
    const outcome = await mutator(saved);
    if (rejectReceipt && saved.runtime.dBatchImportJobs?.some(job => job.chunks.some(chunk => chunk.status === 'waiting_platform'))) {
      rejectReceipt = false;
      throw new Error('synthetic receipt persistence failure');
    }
    if (rejectPrewrite && saved.runtime.dBatchImportJobs?.some(job =>
      job.chunks.some(chunk => chunk.status === 'prewrite_blocked'))) {
      rejectPrewrite = false;
      throw new Error('synthetic prewrite checkpoint failure');
    }
    return outcome;
  }) } : baseRepository;
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId: 'worker:batch-synthetic', version: 'v1',
    capabilities: ['ozon-production-execution'], observedAt: currentTime });
  const calls = [];
  let remainingAdapterFailures = createAdapterFailures;
  let readCount = 0;
  const runtimeOptions = (runtimeRepository = repository) => ({ repository: runtimeRepository, workerRegistry, serverClock: () => currentTime,
    leaseDurationMs: 60_000,
    verifyCurrentBatchEvidence: async () => {
      const saved = await runtimeRepository.readSnapshot();
      assert.equal(saved.runtime.dProductionBatches[0].members.length, members.length);
      if (beforeSendFailure && saved.runtime.dBatchImportJobs?.some(job =>
        job.chunks.some(chunk => chunk.status === 'intent'))) throw beforeSendFailure;
    },
    createAdapter: async () => {
      if (beforeAdapter) await beforeAdapter();
      if (remainingAdapterFailures > 0) { remainingAdapterFailures--; throw new Error('synthetic adapter startup failure'); }
      const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ adapterCapabilities: capability,
      requestJson: async (request, options) => {
        await options?.beforeRequestSend?.();
        calls.push(request);
        if (request.write) {
          const sendCount=calls.filter(call=>call.write).length;
          if(sendCount===failImportCall)throw importFailure ?? new Error('synthetic import response lost');
          if (beforeImportResponse) await beforeImportResponse({ repository: runtimeRepository, workerRegistry,
            setTime: value => { currentTime = value; } });
          return { result: { task_id: 500 + sendCount } };
        }
        const items = observationItems?.[readCount++] ?? [
          { offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] },
          { offer_id: 'BATCH-B', product_id: 0, status: 'failed', errors: [] }
        ];
        return { result: { items } };
      } });
      return expireLimitAfterIntentChunk === null ? adapter : { ...adapter,
        executeBatchImport: (input,options) => adapter.executeBatchImport(input,{...options,
          persistCheckpoint: async event => {
            await options.persistCheckpoint(event);
            if(event.kind==='batch_import_intent' && event.chunkIndex===expireLimitAfterIntentChunk)
              currentTime=capability.productImport.validUntil;
          }}) };
    } });
  const runtime = createPersistedDBatchImportRuntime(runtimeOptions());
  return { repository, runtime, members, capability, calls, workerRegistry, clock:()=>currentTime,
    restartRuntime:(registry=workerRegistry,runtimeRepository=repository)=>createPersistedDBatchImportRuntime({...runtimeOptions(runtimeRepository),workerRegistry:registry}),
    setTime: value => { currentTime = value; } };
}

async function accountForImportBatch(f, options={}) {
  const document=await f.repository.readSnapshot(),candidate=document.candidates[1];
  return accountReadConcurrencyFixture({repository:f.repository,clock:f.clock,candidateId:candidate.id,
    productionBinding:f.members[1].executionContext.currentProductionBinding,...options});
}
async function importInputWithAccountState(f) {
  const document=await f.repository.readSnapshot();
  return {batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,workerId:'worker:batch-synthetic',
    accountReadState:ozonAccountReadCoordinationState({document,candidateIds:document.runtime.dProductionBatches[0].members.map(member=>member.candidateId)})};
}

test('batch import cannot omit its prepared account source once real account reads exist',async()=>{
  const f=await fixture(),account=await accountForImportBatch(f);await account.run();
  const before=await f.repository.readSnapshot(),input=await importInputWithAccountState(f);delete input.accountReadState;
  await assert.rejects(()=>f.runtime.run(input),/D_BATCH_IMPORT_ACCOUNT_READ_SOURCE_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.deepEqual(f.calls,[]);
});

for(const status of ['queued','unknown_outcome'])test(`batch import admission rejects a real ${status} account read with no lease or intent`,async()=>{
  const f=await fixture(),account=await accountForImportBatch(f,{responseMode:status==='unknown_outcome'?'unknown':'observed'});
  const read=status==='queued'?await account.enqueue():await account.run();assert.equal(read.status,status);
  const before=await f.repository.readSnapshot(),input=await importInputWithAccountState(f);
  await assert.rejects(()=>f.runtime.run(input),/D_BATCH_IMPORT_ACCOUNT_READ_BLOCKED/);
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.deepEqual(f.calls,[]);
});

test('batch import admission prevents an expired refresh while its first adapter is still pending',async()=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture({beforeAdapter:async()=>{entered.resolve();await release.promise;}}),account=await accountForImportBatch(f);
  const expiry=new Date(Date.parse(f.clock())+1000).toISOString(),completed=await account.run({expiresAt:expiry});await account.publish(completed);
  const running=f.runtime.run(await importInputWithAccountState(f));
  await waitForAccountReadBoundary(entered.promise,running,release.resolve);
  try{
    f.setTime(expiry);
    const before=await f.repository.readSnapshot();assert.equal(before.runtime.dBatchImportJobs.length,1);assert.deepEqual(f.calls,[]);
    await assert.rejects(()=>account.enqueue({refreshOfJobId:completed.job.jobId,idempotencyKey:'account:refresh:after-import-admission'}),
      {code:'OZON_ACCOUNT_READ_REFRESH_PRODUCTION_BUSY'});
    assert.deepEqual(await f.repository.readSnapshot(),before);assert.equal(account.requests.length,3);
  }finally{release.resolve();await running;}
});

for(const expiresFirst of ['grant','roles'])test(`batch import preparation crossing ${expiresFirst} expiry creates no job or intent and preserves refresh`,async()=>{
  const f=await fixture(),account=await accountForImportBatch(f),expiry=new Date(Date.parse(f.clock())+1000).toISOString();
  if(expiresFirst==='roles')account.responses['/v1/roles'].expires_at=expiry;
  const completed=await account.run(expiresFirst==='grant'?{expiresAt:expiry}:{});await account.publish(completed);
  const before=await f.repository.readSnapshot(),prepared=await importInputWithAccountState(f);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let paused=false;
  const guardedRepository={...f.repository,transact:async mutator=>{
    if(!paused){paused=true;entered.resolve();await release.promise;}
    return f.repository.transact(mutator);
  }};
  const running=f.restartRuntime(f.workerRegistry,guardedRepository).run(prepared);
  await waitForAccountReadBoundary(entered.promise,running,release.resolve);
  f.setTime(expiry);release.resolve();
  await assert.rejects(running,/D_BATCH_IMPORT_ACCOUNT_EVIDENCE_NOT_CURRENT/);
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.deepEqual(f.calls,[]);
  const refreshed=await account.enqueue({refreshOfJobId:completed.job.jobId,idempotencyKey:`account:refresh:expired-${expiresFirst}-during-import`});
  assert.equal(refreshed.status,'queued');assert.equal(account.requests.length,3);
  const after=await f.repository.readSnapshot();assert.deepEqual(after.candidates,before.candidates);
  assert.deepEqual(after.runtime.dProductionBatches,before.runtime.dProductionBatches);
  assert.deepEqual(after.runtime.ozonAccountReadReceipts,before.runtime.ozonAccountReadReceipts);
  assert.deepEqual(after.runtime.ozonDEPreflightEvidence,before.runtime.ozonDEPreflightEvidence);
  assert.equal(after.runtime.dBatchImportJobs,undefined);
});

test('a completed-to-failed account refresh between import preparation and admission rejects the stale source atomically',async()=>{
  const f=await fixture(),account=await accountForImportBatch(f),expiry=new Date(Date.parse(f.clock())+1000).toISOString();
  const completed=await account.run({expiresAt:expiry});await account.publish(completed);
  const prepared=await importInputWithAccountState(f),entered=Promise.withResolvers(),release=Promise.withResolvers();let paused=false;
  const guardedRepository={...f.repository,transact:async mutator=>{
    if(!paused){paused=true;entered.resolve();await release.promise;}
    return f.repository.transact(mutator);
  }};
  const running=f.restartRuntime(f.workerRegistry,guardedRepository).run(prepared);
  await waitForAccountReadBoundary(entered.promise,running,release.resolve);
  let before;
  try{
    f.setTime(expiry);
    const retry=await accountForImportBatch(f,{responseMode:'unavailable'});
    const failed=await retry.run({refreshOfJobId:completed.job.jobId,idempotencyKey:'account:refresh:during-import-prepare'});
    assert.equal(failed.status,'failed');assert.equal(retry.requests.length,1);
    before=await f.repository.readSnapshot();assert.equal(before.runtime.dBatchImportJobs,undefined);
  }finally{release.resolve();}
  await assert.rejects(running,/D_BATCH_IMPORT_ACCOUNT_READ_CHANGED/);
  assert.deepEqual(await f.repository.readSnapshot(),before);assert.deepEqual(f.calls,[]);
});

test('new batch keeps one import job after JSON reopen and cannot replay its adoption',async t=>{
  const f=await fixture({scopedLimit:true,createAdapterFailures:1,inventoryAction:'create_only'});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,workerId:'worker:batch-synthetic'};
  await assert.rejects(()=>f.runtime.run(input),/synthetic adapter startup failure/);
  const before=await f.repository.readSnapshot(),job=before.runtime.dBatchImportJobs[0];
  assert.equal(job.schemaVersion,'d-batch-import-job-v4');
  assert.equal(job.jobId,before.runtime.dProductionBatches[0].importLimitUse.importJobId);
  assert.deepEqual(job.importLimitUse,before.runtime.dProductionBatches[0].importLimitUse);
  assert.equal(job.chunks[0].status,'not_sent');assert.equal(f.calls.length,0);
  const directory=await mkdtemp(path.join(tmpdir(),'d-batch-limit-reopen-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'business-state.json');
  const writer=createJsonBusinessStateRepository({filePath,initializeIfMissing:true,initialDocument:before});
  await writer.transact(document=>({changed:true,document,result:null}));
  const reopened=createJsonBusinessStateRepository({filePath});
  assert.deepEqual(await reopened.readSnapshot(),before);
  assert.equal((await f.restartRuntime(f.workerRegistry,reopened).run(input)).status,'waiting_platform');
  const replayRepository=createJsonBusinessStateRepository({filePath});
  assert.equal((await f.restartRuntime(f.workerRegistry,replayRepository).run(input)).status,'idempotent_replay');
  const after=await replayRepository.readSnapshot();
  assert.equal(after.runtime.dBatchImportJobs.length,1);
  assert.deepEqual(after.runtime.dBatchImportJobs[0].importLimitUse,job.importLimitUse);
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.restartRuntime(f.workerRegistry,replayRepository).observe({...input,chunkIndex:0})).status,'partial_failure');
  const observed=await createJsonBusinessStateRepository({filePath}).readSnapshot();
  assert.equal(observed.runtime.dBatchStockJobs.length,1);
  assert.equal(observed.runtime.dBatchStockJobs[0].status,'inventory_deferred');
  assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('new batch import adoption rejects capability scope drift before saving any job or request',async()=>{
  const f=await fixture({scopedLimit:true,inventoryAction:'create_only'});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,workerId:'worker:batch-synthetic'};
  f.capability.productImport.limitUse.members[0].authorizationFingerprint='b'.repeat(64);
  const before=await f.repository.readSnapshot();
  await assert.rejects(()=>f.runtime.run(input),/LIMIT_USE_SCOPE_MISMATCH/);
  assert.deepEqual(await f.repository.readSnapshot(),before);
  assert.equal(f.calls.length,0);
});

test('persisted batch intent sends once, then one task read settles each offer independently', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const result = await runtime.run(input);
  assert.equal(result.status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'partial_failure');
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'platform_failed']);
  assert.equal(saved.candidates.some(candidate => candidate.lifecycleV11.skuPackage.productionRecord), false);
  assert.deepEqual(calls.map(call => call.write), [true, false]);
});
test('v2 imported offer atomically creates only its own frozen stock continuation',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({inventoryAction:'create_only'});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,workerId:'worker:batch-synthetic'};
  await runtime.run(input);
  const result=await runtime.observe({...input,chunkIndex:0});
  assert.equal(result.status,'partial_failure');
  const saved=await repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs.length,1);
  const stock=saved.runtime.dBatchStockJobs[0];
  assert.equal(stock.offerId,'BATCH-A');
  assert.equal(stock.status,'inventory_deferred');
  assert.equal(stock.authorizationId,saved.runtime.dProductionBatches[0].members[0].authorizationId);
  assert.deepEqual(calls.map(call=>call.write),[true,false]);
});
test('mixed imported, failed and unknown offers retain separate results without an import replay',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({count:3,
    inventoryAction:'create_only',observationItems:[[
      {offer_id:'BATCH-02',product_id:910002,status:'imported',errors:[]},
      {offer_id:'BATCH-03',product_id:0,status:'failed',errors:[]}
    ]]});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,
    workerId:'worker:batch-synthetic'};
  await runtime.run(input);
  assert.equal((await runtime.observe({...input,chunkIndex:0})).status,'unknown_outcome');
  const saved=await repository.readSnapshot();
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member=>member.status),
    ['imported_awaiting_inventory_and_e','platform_failed','unknown_outcome']);
  assert.deepEqual(saved.runtime.dBatchStockJobs.map(job=>job.offerId),['BATCH-02']);
  const view=projectDBatchExecutionView(saved,input.batchId);
  assert.deepEqual(view.members.map(member=>member.importStatus),
    ['imported','platform_failed','unknown_outcome']);
  assert.deepEqual(view.members.map(member=>member.eStatus),
    ['not_started','not_started','not_started']);
  assert.equal((await runtime.run(input)).status,'idempotent_replay');
  assert.equal(calls.filter(call=>call.write).length,1);
});

test('a sent unknown chunk never replays or sends a later untouched chunk',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture({count:3,
    maxItemsPerRequest:1,failImportCall:2});
  const input={batchId:'d-batch:synthetic',members,adapterCapabilities:capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await runtime.run(input)).status,'unknown_outcome');
  const chunks=(await repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks;
  assert.deepEqual(chunks.map(chunk=>chunk.status),['waiting_platform','unknown_outcome','not_sent']);
  assert.equal((await runtime.run(input)).status,'idempotent_replay');
  assert.equal(calls.filter(call=>call.write).length,2);
  assert.equal(calls.some(call=>call.body.items?.some(item=>item.offer_id==='BATCH-04')),false);
});

test('expired limit after durable intent is proven unsent, displayed per offer and never replayed',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const stopped=await f.runtime.run(input);
  assert.equal(stopped.status,'prewrite_blocked');
  const saved=await f.repository.readSnapshot(),chunk=saved.runtime.dBatchImportJobs[0].chunks[0];
  assert.equal(saved.runtime.dBatchImportJobs[0].schemaVersion,'d-batch-import-job-v3');
  assert.equal(chunk.status,'prewrite_blocked');
  assert.equal(chunk.taskId,null);
  assert.equal(chunk.prewriteReasonCode,'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED');
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'not_sent');
  assert.deepEqual(saved.runtime.dProductionBatches[0].members.map(member=>member.status),
    ['prewrite_blocked','prewrite_blocked']);
  assert.deepEqual(projectDBatchExecutionView(saved,input.batchId).members.map(member=>
    [member.importStatus,member.importGapCode]),[
      ['prewrite_blocked','OZON_BATCH_LIMIT_EVIDENCE_REQUIRED'],
      ['prewrite_blocked','OZON_BATCH_LIMIT_EVIDENCE_REQUIRED']]);
  assert.equal(f.calls.length,0);
  const restarted=f.restartRuntime();
  const replay=await Promise.all([restarted.run(input),restarted.run(input)]);
  assert.deepEqual(replay.map(value=>value.status),['idempotent_replay','idempotent_replay']);
  assert.equal(f.calls.length,0);
});

test('concurrent duplicate starts commit one proven-unsent verdict and no import request',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const outcomes=await Promise.all([f.runtime.run(input),f.runtime.run(input)]);
  assert.equal(outcomes.some(result=>result.status==='prewrite_blocked'),true);
  assert.equal(outcomes.every(result=>['prewrite_blocked','idempotent_replay'].includes(result.status)),true);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs.length,1);
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].status,'prewrite_blocked');
  assert.equal(f.calls.length,0);
});

test('concurrent normal starts still send only one import task',async()=>{
  const f=await fixture();
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  const outcomes=await Promise.all([f.runtime.run(input),f.runtime.run(input)]);
  assert.equal(outcomes.some(result=>result.status==='waiting_platform'),true);
  assert.equal(outcomes.every(result=>['waiting_platform','idempotent_replay'].includes(result.status)),true);
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status,
    'waiting_platform');
});

test('a failed prewrite checkpoint retains the unknown intent and forbids replay',async()=>{
  const f=await fixture({expireLimitAfterIntentChunk:0,failPrewriteCheckpoint:true});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'unknown_outcome');
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].status,'intent');
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'intent_persisted');
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal(f.calls.length,0);
});

test('a sent first chunk remains observable after the next chunk is proven unsent',async()=>{
  const f=await fixture({count:3,maxItemsPerRequest:1,expireLimitAfterIntentChunk:1,
    observationItems:[[{offer_id:'BATCH-02',product_id:910002,status:'imported',errors:[]}]]});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'waiting_platform');
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchImportJobs[0].chunks.map(chunk=>chunk.status),
    ['waiting_platform','prewrite_blocked','not_sent']);
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState,'task_received');
  assert.deepEqual(f.calls.map(call=>call.write),[true]);
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal((await f.restartRuntime().observe({...input,chunkIndex:0})).status,'partial_failure');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
  assert.equal(f.calls.some(call=>call.body.items?.some(item=>item.offer_id==='BATCH-04')),false);
});

test('typed transport with attempted transmission remains unknown after one write',async()=>{
  const f=await fixture({failImportCall:1,importFailure:new OzonDEHttpTransportError(
    'OZON_DE_HTTP_CONNECTION_FAILED',{externalRequestState:'unknown_outcome',
      requestTransmission:'attempted'})});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  assert.equal((await f.runtime.run(input)).status,'unknown_outcome');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status,
    'unknown_outcome');
  assert.equal((await f.restartRuntime().run(input)).status,'idempotent_replay');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});

test('a late task receipt survives lease and heartbeat expiry without sending another chunk', async () => {
  const f = await fixture({ count: 3, maxItemsPerRequest: 1,
    beforeImportResponse: ({ setTime }) => setTime('2026-08-22T07:26:01.000Z') });
  const input = { batchId: 'd-batch:synthetic', members: f.members,
    adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
  assert.equal((await f.runtime.run(input)).status, 'waiting_platform');
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchImportJobs[0].chunks.map(chunk => [chunk.status, chunk.taskId]),
    [['waiting_platform', '501'], ['not_sent', null], ['not_sent', null]]);
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState, 'task_received');
  assert.equal(f.workerRegistry.findEligible(['ozon-production-execution']).length, 0);
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.restartRuntime().run(input), /WORKER_NOT_CURRENT/);
  assert.equal(f.calls.length, 1);
});

test('a late response cannot settle a replaced holder, authorization or frozen request', async () => {
  for (const changed of ['lease', 'holder', 'authorization', 'frozen']) {
    const f = await fixture({ beforeImportResponse: async ({ repository, setTime }) => {
      setTime('2026-08-22T07:26:01.000Z');
      await repository.transact(document => {
        const job = document.runtime.dBatchImportJobs[0];
        if (changed === 'lease') job.leaseId = 'lease:replacement';
        if (changed === 'holder') job.workerId = 'worker:replacement';
        if (changed === 'authorization') document.runtime.dProductionBatches[0].members[0].authorizationId =
          'authorization:replacement';
        if (changed === 'frozen') {
          const frozen = job.chunks[0].frozenImport;
          frozen.items[0].name += ' changed';
          frozen.itemFingerprint = fingerprintCanonicalRecord(frozen.items);
          frozen.contentFingerprint = fingerprintCanonicalRecord({ items: frozen.items,
            memberSources: frozen.memberSources });
        }
        return { changed: true, document, result: null };
      });
    } });
    const input = { batchId: 'd-batch:synthetic', members: f.members,
      adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
    assert.equal((await f.runtime.run(input)).status, 'unknown_outcome');
    assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].taskId, null);
    assert.equal(f.calls.length, 1);
  }
});

test('a programming failure inside the final send guard is saved as unsent and still exposed', async () => {
  const cause = new TypeError('synthetic final guard failure');
  const f = await fixture({ beforeSendFailure: cause });
  const input = { batchId: 'd-batch:synthetic', members: f.members,
    adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
  await assert.rejects(() => f.runtime.run(input), error =>
    error instanceof OzonDEHttpTransportError && error.cause === cause &&
    error.externalRequestState === 'not_sent' && error.requestTransmission === 'not_attempted');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].status, 'prewrite_blocked');
  assert.equal(saved.runtime.dProductionBatches[0].externalRequestState, 'not_sent');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.restartRuntime().run(input)).status, 'idempotent_replay');
  assert.equal(f.calls.length, 0);
});

test('adapter startup failure can resume only a never-sent chunk', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ createAdapterFailures: 1 });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await assert.rejects(() => runtime.run(input), /synthetic adapter startup failure/);
  assert.equal((await repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].status, 'not_sent');
  assert.equal((await runtime.run(input)).status, 'waiting_platform');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('a restart sends only the frozen canonical items and rejects saved content drift',async()=>{
  const f=await fixture({createAdapterFailures:1});
  const input={batchId:'d-batch:synthetic',members:f.members,adapterCapabilities:f.capability,
    workerId:'worker:batch-synthetic'};
  await assert.rejects(()=>f.runtime.run(input),/synthetic adapter startup failure/);
  const saved=(await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0];
  assert.equal(saved.frozenImport.schemaVersion,'d-batch-frozen-import-v1');
  assert.equal(JSON.stringify(saved.frozenImport).includes('local-asset:'),false);
  assert.equal((await f.runtime.run(input)).status,'waiting_platform');
  assert.deepEqual(f.calls.find(call=>call.write).body.items,saved.frozenImport.items);
  const drift=await fixture({createAdapterFailures:1});
  const driftInput={...input,members:drift.members,adapterCapabilities:drift.capability};
  await assert.rejects(()=>drift.runtime.run(driftInput),/synthetic adapter startup failure/);
  await drift.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].chunks[0].frozenImport.items[0].name='mutated after admission';
    return {changed:true,document,result:null};
  });
  await assert.rejects(()=>drift.runtime.run(driftInput),/D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(drift.calls.filter(call=>call.write).length,0);
  await drift.repository.transact(document=>{
    const frozen=document.runtime.dBatchImportJobs[0].chunks[0].frozenImport;
    frozen.items[0].name=saved.frozenImport.items[0].name;
    frozen.memberSources[0].stock+=1;
    return {changed:true,document,result:null};
  });
  await assert.rejects(()=>drift.runtime.run(driftInput),/D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(drift.calls.filter(call=>call.write).length,0);
});

test('current single-SKU preflight must still pass for every batch member before admission', async () => {
  const { repository, runtime, members, capability, calls } = await fixture();
  const before = await repository.readSnapshot();
  const changed = members.map(member => ({ ...member }));
  changed[1].platformWritePreflight = structuredClone(changed[1].platformWritePreflight);
  changed[1].platformWritePreflight.permission.status = 'denied';
  await assert.rejects(() => runtime.run({ batchId: 'd-batch:synthetic', members: changed,
    adapterCapabilities: capability, workerId: 'worker:batch-synthetic' }), /MEMBER_NOT_READY/);
  assert.deepEqual(await repository.readSnapshot(), before);
  assert.equal(calls.length, 0);
});

test('a live single-SKU D job reserves the same offer against batch admission',async()=>{
  const {repository,runtime,members,capability,calls}=await fixture();
  await repository.transact(document=>{
    document.runtime.softwareJobs=[{candidateId:members[0].request.candidateId,
      jobType:'d_production_execution',status:'claimed'}];
    return {changed:true,document,result:null};
  });
  await assert.rejects(runtime.run({batchId:'d-batch:synthetic',members,
    adapterCapabilities:capability,workerId:'worker:batch-synthetic'}),
  /MEMBER_CHANGED_OR_SINGLE_BUSY/);
  assert.equal(calls.length,0);
  assert.equal((await repository.readSnapshot()).runtime.dBatchImportJobs,undefined);
});

test('a failed receipt checkpoint leaves the sent intent unknown and forbids replay', async () => {
  const { repository, runtime, members, capability, calls } = await fixture({ failReceipt: true });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  assert.equal((await runtime.run(input)).status, 'unknown_outcome');
  const job = (await repository.readSnapshot()).runtime.dBatchImportJobs[0];
  assert.equal(job.chunks[0].status, 'intent');
  assert.equal(calls.filter(call => call.write).length, 1);
  assert.equal((await runtime.run(input)).status, 'idempotent_replay');
  assert.equal(calls.filter(call => call.write).length, 1);
});

test('unknown task observation is read-only reconcilable after lease expiry', async () => {
  const incomplete = [{ offer_id: 'BATCH-A', product_id: 910001, status: 'imported', errors: [] }];
  const complete = [...incomplete, { offer_id: 'BATCH-B', product_id: 910002, status: 'imported', errors: [] }];
  const { repository, runtime, members, capability, calls, workerRegistry, setTime } = await fixture({
    observationItems: [incomplete, complete] });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await runtime.run(input);
  assert.equal((await runtime.observe({ ...input, chunkIndex: 0 })).status, 'unknown_outcome');
  setTime('2026-08-22T07:26:01.000Z');
  workerRegistry.heartbeat({ workerId: input.workerId, version: 'v1', capabilities: ['ozon-production-execution'] });
  await assert.rejects(() => runtime.observe({ ...input, chunkIndex: 0 }), /NOT_ADMITTED/);
  await runtime.reclaim({ batchId: input.batchId, workerId: input.workerId });
  const observed = await runtime.observe({ ...input, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.deepEqual((await repository.readSnapshot()).runtime.dProductionBatches[0].members.map(member => member.status),
    ['imported_awaiting_inventory_and_e', 'imported_awaiting_inventory_and_e']);
  assert.deepEqual(calls.map(call => call.write), [true, false, false]);
});

test('an expired worker heartbeat cannot renew itself through a batch checkpoint', async () => {
  const { runtime, members, capability, calls, workerRegistry, setTime } = await fixture();
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  await runtime.run(input);
  setTime('2026-08-22T07:25:31.000Z');
  await assert.rejects(() => runtime.observe({ ...input, chunkIndex: 0 }), /WORKER_CHANGED/);
  assert.equal(workerRegistry.findEligible(['ozon-production-execution']).length, 0);
  assert.equal(calls.filter(call => !call.write).length, 0);
  workerRegistry.heartbeat({ workerId: input.workerId, version: 'v1',
    capabilities: ['ozon-production-execution'] });
  assert.equal((await runtime.observe({ ...input, chunkIndex: 0 })).status, 'partial_failure');
});

test('observation preparation blocks stop only the saved task without a read or lease renewal', async () => {
  for (const reason of ['evidence_not_ready', 'service_not_configured']) {
    const f = await fixture();
    const input = { batchId: 'd-batch:synthetic', members: f.members,
      adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
    await f.runtime.run(input);
    const before = await f.repository.readSnapshot();
    f.setTime('2026-08-22T07:26:01.000Z');
    const emptyRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => '2026-08-22T07:26:01.000Z' });
    assert.equal(emptyRegistry.get(input.workerId), null);
    const stoppingRuntime = reason === 'service_not_configured' ? f.restartRuntime(emptyRegistry) : f.runtime;
    const stopped = await stoppingRuntime.blockObservation({ batchId: input.batchId, chunkIndex: 0, reason,
      expectedSource: before.runtime.dBatchImportJobs[0], expectedBatch: before.runtime.dProductionBatches[0] });
    assert.equal(stopped.chunks[0].status, 'observation_stopped');
    assert.equal(stopped.chunks[0].stopReason, reason);
    assert.equal(stopped.chunks[0].taskId, '501');
    assert.equal(stopped.chunks[0].observationReads, 0);
    assert.equal(stopped.chunks[0].observationInFlight, false);
    assert.equal(stopped.leaseExpiresAt, before.runtime.dBatchImportJobs[0].leaseExpiresAt);
    const saved = await f.repository.readSnapshot();
    assert.equal(saved.runtime.dProductionBatches[0].externalRequestState, 'task_received');
    assert.deepEqual(saved.candidates, before.candidates);
    assert.equal(f.workerRegistry.findEligible(['ozon-production-execution']).length, 0);
    assert.equal(f.calls.length, 1);
    await stoppingRuntime.blockObservation({ batchId: input.batchId, chunkIndex: 0, reason,
      expectedSource: saved.runtime.dBatchImportJobs[0], expectedBatch: saved.runtime.dProductionBatches[0] });
    assert.deepEqual(await f.repository.readSnapshot(), saved);
    assert.equal(f.calls.length, 1);
  }
});

test('observation preparation refuses unclassified reasons, changed sources and invalid holders', async () => {
  const f = await fixture();
  const input = { batchId: 'd-batch:synthetic', members: f.members,
    adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
  await f.runtime.run(input);
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'unknown_system_failure', expectedSource: before.runtime.dBatchImportJobs[0],
    expectedBatch: before.runtime.dProductionBatches[0] }),
  /OBSERVATION_BLOCK_NOT_ADMITTED/);
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'evidence_not_ready' }), /OBSERVATION_BLOCK_NOT_ADMITTED/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  await f.repository.transact(document => {
    document.runtime.dBatchImportJobs[0].workerVersion = 'changed-version';
    return { changed: true, document, result: null };
  });
  const changedWorker = await f.repository.readSnapshot();
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'evidence_not_ready', expectedSource: before.runtime.dBatchImportJobs[0],
    expectedBatch: before.runtime.dProductionBatches[0] }), /CHECKPOINT_SCOPE_CHANGED/);
  assert.deepEqual(await f.repository.readSnapshot(), changedWorker);
  await f.repository.transact(document => {
    document.runtime.dBatchImportJobs[0].workerVersion = 'v1';
    document.runtime.dProductionBatches[0].excludedOfferIds = ['changed-exclusion'];
    return { changed: true, document, result: null };
  });
  const changedBatch = await f.repository.readSnapshot();
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'evidence_not_ready', expectedSource: before.runtime.dBatchImportJobs[0],
    expectedBatch: before.runtime.dProductionBatches[0] }), /CHECKPOINT_SCOPE_CHANGED/);
  assert.deepEqual(await f.repository.readSnapshot(), changedBatch);
  await f.repository.transact(document => {
    document.runtime.dProductionBatches[0].excludedOfferIds = before.runtime.dProductionBatches[0].excludedOfferIds;
    document.candidates[0].dataRevision++;
    return { changed: true, document, result: null };
  });
  const changed = await f.repository.readSnapshot();
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'evidence_not_ready', expectedSource: before.runtime.dBatchImportJobs[0],
    expectedBatch: before.runtime.dProductionBatches[0] }), /OBSERVATION_SOURCE_CHANGED/);
  assert.deepEqual(await f.repository.readSnapshot(), changed);
  await f.repository.transact(document => {
    document.candidates[0].dataRevision = before.candidates[0].dataRevision;
    document.runtime.dBatchImportJobs[0].chunks[0].frozenImport.items[0].name += ' damaged';
    return { changed: true, document, result: null };
  });
  const damaged = await f.repository.readSnapshot();
  await assert.rejects(() => f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
    reason: 'service_not_configured', expectedSource: damaged.runtime.dBatchImportJobs[0],
    expectedBatch: damaged.runtime.dProductionBatches[0] }), /FROZEN_IMPORT_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), damaged);
  assert.equal(f.calls.length, 1);
});

test('observation preparation cannot record an old failure to the holder replacing its pending source', async () => {
  const f = await fixture();
  const input = { batchId: 'd-batch:synthetic', members: f.members,
    adapterCapabilities: f.capability, workerId: 'worker:batch-synthetic' };
  await f.runtime.run(input);
  const entered = Promise.withResolvers(), prepared = Promise.withResolvers();
  const pending = (async () => {
    const source = await f.repository.readSnapshot();
    entered.resolve();
    await prepared.promise;
    return f.runtime.blockObservation({ batchId: input.batchId, chunkIndex: 0,
      reason: 'evidence_not_ready', expectedSource: source.runtime.dBatchImportJobs[0],
      expectedBatch: source.runtime.dProductionBatches[0] });
  })();
  await entered.promise;
  f.workerRegistry.register({ workerId: 'worker:replacement', version: 'v1',
    capabilities: ['ozon-production-execution'], observedAt: at });
  await f.repository.transact(document => {
    const job = document.runtime.dBatchImportJobs[0];
    job.workerId = 'worker:replacement';
    job.leaseId = 'lease:replacement';
    job.revision++;
    return { changed: true, document, result: null };
  });
  const replaced = await f.repository.readSnapshot();
  prepared.resolve();
  await assert.rejects(() => pending, /CHECKPOINT_SCOPE_CHANGED/);
  assert.deepEqual(await f.repository.readSnapshot(), replaced);
  assert.equal(f.calls.length, 1);
});

test('a selected 32-SKU family imports 31 once after its first SKU already succeeded', async t => {
  const { completedCandidate } = await deSoftwareJobScopeFixture({ merchantSku: 'BATCH-FIRST' });
  const firstRecord = completedCandidate.lifecycleV11.skuPackage.productionRecord;
  const { repository, runtime, restartRuntime, members, capability, calls } = await fixture({ count: 31 });
  await repository.transact(document => {
    document.candidates.unshift(structuredClone(completedCandidate));
    return { changed: true, document, result: null };
  });
  const input = { batchId: 'd-batch:synthetic', members, adapterCapabilities: capability,
    workerId: 'worker:batch-synthetic' };
  const outcome = await runtime.run(input);
  const replay = await runtime.run(input);
  const restartedReplay = await restartRuntime().run(input);
  const saved = await repository.readSnapshot();
  const writes = structuredClone(calls.filter(call => call.write));
  const excludedCandidate = structuredClone(saved.candidates.find(candidate => candidate.id === completedCandidate.id));
  const batch = structuredClone(saved.runtime.dProductionBatches[0]);
  const job = structuredClone(saved.runtime.dBatchImportJobs[0]);
  await t.test('31 authorized members send four persisted tasks within the synthetic limit', () => {
    assert.equal(outcome.status, 'waiting_platform');
    assert.deepEqual(writes.map(call => call.body.items.length), [10, 10, 10, 1]);
    assert.equal(job.chunks.every(chunk => chunk.status === 'waiting_platform'), true);
    assert.equal(new Set(job.chunks.map(chunk => chunk.taskId)).size, 4);
    assert.equal(writes.some(call => call.body.items?.some(item => item.offer_id === 'BATCH-FIRST')), false);
    assert.equal(replay.status, 'idempotent_replay');
    assert.equal(writes.length, 4);
  });
  await t.test('a previously successful first SKU stays excluded when the other 31 import as one batch', () => {
    assert.equal(validateProductionRecord(firstRecord).valid, true);
    assert.equal(firstRecord.merchantSku, 'BATCH-FIRST');
    assert.equal(writes.flatMap(call => call.body.items).some(item => item.offer_id === firstRecord.merchantSku), false);
    assert.deepEqual(excludedCandidate, completedCandidate);
    assert.deepEqual(batch.excludedOfferIds, [firstRecord.merchantSku]);
    assert.equal(restartedReplay.status, 'idempotent_replay');
    assert.equal(writes.length, 4);
  });
});
