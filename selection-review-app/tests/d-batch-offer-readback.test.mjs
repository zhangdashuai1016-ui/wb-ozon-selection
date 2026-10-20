import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedFixture, exactObservation } from './helpers/d-software-fixture.mjs';
import { createDBatchEJob, applyDBatchEJobEvent, reclaimDBatchEJob,
  assertDBatchEJob, createDBatchEReadback } from '../lib/d-batch-offer-readback.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';

const now='2026-08-22T07:25:00.000Z';
const at=ms=>new Date(Date.parse(now)+ms).toISOString();
const policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:batch-e',
  version:'v1',maxQueries:2,intervalMs:1000,expiresAt:at(30_000),requestTimeoutMs:1000};

async function fixture(){
  const source=await preparedFixture(),request=source.prepared.executableRequest;
  const observation=exactObservation(request);
  const batchId='d-batch:synthetic:e';
  const record={schemaVersion:'d-batch-offer-record-v2',recordId:`d-batch-offer:${batchId}:${request.merchantSku}`,
    batchId,chunkIndex:0,taskId:'9001',productId:observation.platformProductId,
    candidateId:request.candidateId,skuPackageId:request.skuPackageId,offerId:request.merchantSku,
    supplierSkuId:request.supplierSkuId,authorizationId:request.sourceAuthorizationId,
    authorizationFingerprint:request.sourceAuthorizationFingerprint,productionPlanId:request.sourceProductionPlanId,
    productionPlanFingerprint:request.sourceProductionPlanFingerprint,importRequestReceiptRef:'receipt:synthetic:import',
    importItemFingerprint:'fingerprint:synthetic:item',importChunkFingerprint:'fingerprint:synthetic:chunk',
    importContentFingerprint:'fingerprint:synthetic:content',inventoryAction:'write_authorized_stock',
    inventoryModified:true,inventoryReceiptRef:'receipt:synthetic:stock',expectedStock:request.stock,
    expectedPrice:structuredClone(request.platformWritePrice),
    readbackExpectation:structuredClone(request.independentReadback.expectation),platform:request.platform,
    store:request.store,storeRef:structuredClone(request.storeRef),warehouseRef:request.warehouseRef,
    credentialAlias:request.credentialAlias,warehouseId:request.inventoryWrite.warehouseId,createdAt:now,
    published:false,activated:false,advertisingOpened:false,status:'created_stock_write_accepted'};
  const job=createDBatchEJob({record,workerId:'worker:synthetic:e',workerVersion:'v1',
    leaseId:'lease:synthetic:e',leaseExpiresAt:at(5000),leaseDurationMs:5000,
    observationPolicy:policy,createdAt:now});
  const event=(held,value,ms=0)=>applyDBatchEJobEvent({job:held,event:value,
    workerId:held.workerId,leaseId:held.leaseId,observedAt:at(ms)});
  return {record,observation,job,event,source};
}

async function assetViewFixture(){
  const f=await fixture(),authorization=f.source.authorization;
  const member={candidateId:f.record.candidateId,skuPackageId:f.record.skuPackageId,offerId:f.record.offerId,
    authorizationId:f.record.authorizationId,authorizationFingerprint:f.record.authorizationFingerprint,
    sourceRevision:authorization.sourceCandidateRevision,resultRevision:authorization.resultCandidateRevision};
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:f.record.batchId,
    ownerActorId:authorization.authorizedByActorId,confirmedAt:authorization.authorizedAt,
    status:'authorized',externalRequestState:'not_sent',storeRef:structuredClone(f.record.storeRef),
    excludedOfferIds:['HISTORICAL-KHAKI'],postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',
      inventoryAction:'write_authorized_stock',eReadbackOfferIds:[member.offerId]},members:[member]};
  const finalUploads=structuredClone(authorization.lockedScope.finalUploads);
  const scope={schemaVersion:batch.schemaVersion,batchId:batch.batchId,ownerActorId:batch.ownerActorId,
    confirmedAt:batch.confirmedAt,storeRef:structuredClone(batch.storeRef),excludedOfferIds:batch.excludedOfferIds,
    postImportScope:batch.postImportScope,members:batch.members.map(value=>Object.fromEntries(
      ['candidateId','skuPackageId','offerId','resultRevision','authorizationId','authorizationFingerprint'].map(key=>[key,value[key]]))),
    candidateId:member.candidateId,skuPackageId:member.skuPackageId,sourceRevision:member.resultRevision,
    authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,finalUploads};
  const assetRecord={schemaVersion:'d-batch-asset-transport-v1',recordId:`d-batch-assets:${batch.batchId}:${member.candidateId}`,
    batchId:batch.batchId,candidateId:member.candidateId,scope,status:'in_flight',revision:1,
    workerId:'worker:synthetic:asset-view',workerVersion:'v1',leaseId:'lease:synthetic:asset-view',
    leaseExpiresAt:at(60_000),createdAt:now,updatedAt:now,writeIntents:[],
    state:{schemaVersion:'aliyun-oss-d-asset-state-v1',status:'in_flight',executionRevision:1,automaticRetry:false,
      platformWrites:0,assetTransport:null,intent:{schemaVersion:'aliyun-oss-d-asset-integration-v1',status:'in_flight',
        candidateId:member.candidateId,skuPackageId:member.skuPackageId,
        candidateDataRevision:member.resultRevision,persistedCandidateRevision:member.resultRevision,
        authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,
        finalUploadAssetIds:finalUploads.map(asset=>asset.assetId),ossWrites:0}}};
  return {batch,member,assetRecord,document:{runtime:{dProductionBatches:[batch],dBatchAssetTransports:[assetRecord]}}};
}

test('E appends distinct observations and never calls card or stock equality a verified sale',async()=>{
  const {record,observation}=await fixture();
  const before=structuredClone(observation);
  const first=createDBatchEReadback({record,observation,readAt:now,readSequence:1});
  const second=createDBatchEReadback({record,observation,readAt:at(1000),readSequence:2});
  assert.notEqual(first.readbackId,second.readbackId);
  assert.equal(first.observationDisposition,'complete');
  assert.equal(first.status,'card_and_stock_observed');
  assert.equal(first.listedVerified,false);
  assert.deepEqual(observation,before);
});

test('only attributable price or stock differences permit another bounded read',async()=>{
  const {record,observation}=await fixture();
  const pending=createDBatchEReadback({record,observation:{...observation,
    currentPrice:{...record.expectedPrice,amount:record.expectedPrice.amount+1}},readAt:now});
  assert.equal(pending.status,'verification_pending');
  assert.equal(pending.observationDisposition,'observe');
  assert.deepEqual(pending.gaps,['currentPrice']);
  for(const changed of [{platformProductId:'999999'},{errors:[{code:'DECLINED'}]},
    {mediaObservation:{sourceProtocol:'unknown',primaryImageUrl:null,images:[]}}]){
    const result=createDBatchEReadback({record,observation:{...observation,...changed},readAt:now});
    assert.equal(result.observationDisposition,'stop');
    assert.equal(result.listedVerified,false);
  }
});

test('unknown or incomparable prices stop observation instead of being treated as a price difference',async()=>{
  const {record,observation}=await fixture();
  for(const currentPrice of [null,{currency:record.expectedPrice.currency},
    {amount:'unknown',currency:record.expectedPrice.currency},
    {amount:record.expectedPrice.amount,currency:'unknown'},
    {amount:record.expectedPrice.amount,currency:'RUB'},
    {amount:0,currency:record.expectedPrice.currency}]){
    const changed={...observation,currentPrice};
    const before=structuredClone(changed);
    const result=createDBatchEReadback({record,observation:changed,readAt:now});
    assert.equal(result.observationDisposition,'stop');
    assert.equal(result.status,'not_verified');
    assert.deepEqual(result.gaps,['currentPrice']);
    assert.equal(result.listedVerified,false);
    assert.deepEqual(changed,before);
  }
});

test('unknown image counts or stock quantities cannot trigger another platform observation',async()=>{
  const {record,observation}=await fixture();
  for(const changed of [{imageCount:'unknown'},{imageCount:null},{imageCount:-1},
    {imageCount:1.5},{imageCount:Number.MAX_SAFE_INTEGER+1},{currentStock:'unknown'}]){
    const observed={...observation,...changed};
    const before=structuredClone(observed);
    const result=createDBatchEReadback({record,observation:observed,readAt:now});
    assert.equal(result.observationDisposition,'stop');
    assert.equal(result.status,'not_verified');
    assert.ok(result.gaps.includes(Object.hasOwn(changed,'imageCount')?'imageCount':'authorized_stock_not_verified'));
    assert.equal(result.listedVerified,false);
    assert.deepEqual(observed,before);
  }
});

test('a technical read failure is durable and never becomes a pending platform observation',async()=>{
  const {record}=await fixture();
  const result=createDBatchEReadback({record,observation:null,readAt:now,
    readFailure:'transport_failure',readSequence:2});
  assert.equal(result.observationDisposition,'failed');
  assert.equal(result.observation,null);
  assert.deepEqual(result.gaps,['technical_readback_failure:transport_failure']);
});

test('E respects the frozen interval and query limit while preserving prior result references',async()=>{
  const {job,event}=await fixture();
  const first=event(job,{kind:'read_started'});
  const pending=event(first,{kind:'read_pending',resultId:'result:synthetic:1'});
  assert.equal(pending.nextReadAt,at(1000));
  assert.equal(pending.readCount,1);
  assert.throws(()=>event(pending,{kind:'read_started'},999),/READ_NOT_ADMITTED/);
  const second=event(pending,{kind:'read_started'},1000);
  assert.equal(second.resultId,'result:synthetic:1');
  const again=event(second,{kind:'read_pending',resultId:'result:synthetic:2'},1000);
  assert.throws(()=>event(again,{kind:'read_started'},2000),/READ_NOT_ADMITTED/);
  const stopped=event(again,{kind:'observation_stopped',reason:'query_limit'},2000);
  assert.equal(stopped.status,'observation_stopped');
  assert.equal(stopped.resultId,'result:synthetic:2');
});

test('an in-flight read cannot start a second request even before its lease expires',async()=>{
  const {job,event}=await fixture();
  const running=event(job,{kind:'read_started'});
  assert.throws(()=>event(running,{kind:'read_started'},100),/READ_NOT_ADMITTED/);
});

test('a late observation survives time expiry only for the same holder and lease',async()=>{
  const {job,event}=await fixture();
  const running=event(job,{kind:'read_started'});
  const completed=event(running,{kind:'read_completed',resultId:'result:synthetic:late'},6000);
  assert.equal(completed.status,'completed');
  const reclaimed=reclaimDBatchEJob({job:running,workerId:'worker:synthetic:new',workerVersion:'v1',
    leaseId:'lease:synthetic:new',leaseExpiresAt:at(15_000),observedAt:at(6000)});
  assert.throws(()=>applyDBatchEJobEvent({job:reclaimed,
    event:{kind:'read_completed',resultId:'result:synthetic:late'},workerId:job.workerId,
    leaseId:job.leaseId,observedAt:at(6001)}),/LEASE_INVALID/);
});

test('legacy E jobs retain their one-observation semantics without an implicit migration',async()=>{
  const {record,job,event}=await fixture();
  const legacy={...job,schemaVersion:'d-batch-e-job-v1'};delete legacy.nextReadAt;
  assert.equal(assertDBatchEJob(legacy).schemaVersion,'d-batch-e-job-v1');
  const started=event(legacy,{kind:'read_started'});
  assert.throws(()=>event(started,{kind:'read_pending',resultId:'result:synthetic:1'}),/PENDING_INVALID/);
  assert.equal(event(started,{kind:'read_completed',resultId:'result:synthetic:1'}).schemaVersion,
    'd-batch-e-job-v1');
  const result=createDBatchEReadback({record,observation:null,readFailure:'transport_failure',
    readAt:now,schemaVersion:'d-batch-e-readback-v1'});
  assert.equal(result.readbackId,`d-batch-e:${record.recordId}`);
  assert.equal(Object.hasOwn(result,'readSequence'),false);
});

test('the execution view selects the current receipt and keeps historical observations',async()=>{
  const {record,observation,job,event}=await fixture();
  const pending=createDBatchEReadback({record,observation:{...observation,
    currentPrice:{...record.expectedPrice,amount:record.expectedPrice.amount+1}},readAt:now,readSequence:1});
  const complete=createDBatchEReadback({record,observation,readAt:at(1000),readSequence:2});
  const first=event(event(job,{kind:'read_started'}),{kind:'read_pending',resultId:pending.readbackId});
  const completed=event(event(first,{kind:'read_started'},1000),
    {kind:'read_completed',resultId:complete.readbackId},1000);
  const document={runtime:{dProductionBatches:[{batchId:record.batchId,status:'imported_awaiting_inventory',
    excludedOfferIds:['offer:synthetic:parent'],members:[{candidateId:record.candidateId,
      offerId:record.offerId,skuPackageId:record.skuPackageId}]}],
    dBatchImportJobs:[{batchId:record.batchId,chunks:[{index:0,offerIds:[record.offerId],
      results:[{offerId:record.offerId,classification:'imported',importObservation:{productId:record.productId}}]}]}],
    dBatchStockJobs:[],dBatchEJobs:[completed],dBatchEReadbacks:[pending,complete]}};
  const before=structuredClone(document);
  const view=projectDBatchExecutionView(document,record.batchId);
  assert.equal(view.members[0].eStatus,'card_and_stock_observed');
  assert.deepEqual(view.members[0].eGaps,[]);
  assert.equal(view.members[0].listedVerified,false);
  assert.equal(view.members[0].assetStatus,'not_started');
  assert.equal(view.members[0].assetReason,null);
  assert.equal(view.assetRequestTransmission,'not_attempted');
  assert.deepEqual(document,before);
  for(const readbacks of [[],[pending]]){
    const missing=structuredClone(document);
    missing.runtime.dBatchEReadbacks=structuredClone(readbacks);
    const missingBefore=structuredClone(missing);
    assert.throws(()=>projectDBatchExecutionView(missing,record.batchId),
      /D_BATCH_VIEW_RESULT_SOURCE_CONFLICT/);
    assert.deepEqual(missing,missingBefore);
  }
});

test('asset execution projection preserves precise durable states and conservative OSS transmission facts',async()=>{
  const f=await assetViewFixture();
  for(const scenario of [
    {status:'in_flight',writes:0,count:0,transmission:'not_attempted'},
    {status:'in_flight',writes:1,count:0,transmission:'attempted_or_unknown'},
    {status:'verified',writes:2,count:2,transmission:'attempted_or_unknown'},
    {status:'failed',writes:0,count:0,reason:'OSS_D_BATCH_PREWRITE_FAILED',transmission:'not_attempted'},
    {status:'failed',writes:1,count:0,reason:'OSS_D_BATCH_PREWRITE_FAILED',transmission:'attempted_or_unknown'},
    {status:'unknown_outcome',writes:0,count:'unknown',reason:'OSS_D_BATCH_UPLOAD_UNKNOWN',transmission:'attempted_or_unknown'},
    {status:'unknown_outcome',writes:1,count:'unknown',reason:'OSS_D_BATCH_UPLOAD_UNKNOWN',transmission:'attempted_or_unknown'}
  ]){
    const document=structuredClone(f.document),record=document.runtime.dBatchAssetTransports[0];
    record.status=scenario.status;record.state.status=scenario.status;
    record.state.intent.status=scenario.status==='verified'?'completed':scenario.status;
    record.state.intent.ossWrites=scenario.count;
    record.writeIntents=record.scope.finalUploads.slice(0,scenario.writes).map(({assetId,order,sha256})=>({assetId,order,sha256,startedAt:now}));
    if(scenario.reason){record.state.intent.failureCode=scenario.reason;record.state.blockReason='asset_transport_failed';}
    const before=structuredClone(document),view=projectDBatchExecutionView(document,f.batch.batchId);
    assert.equal(view.schemaVersion,'d-batch-execution-view-v1');
    assert.equal(view.members[0].assetStatus,scenario.status);
    assert.equal(view.members[0].assetReason,scenario.reason??null);
    assert.equal(view.assetRequestTransmission,scenario.transmission);
    assert.equal(view.members[0].importStatus,'not_started');
    assert.equal(view.members[0].eStatus,'not_started');
    assert.equal(view.members[0].listedVerified,false);
    assert.deepEqual(document,before);
  }
});

test('missing asset records remain not started and do not materialize pre-intent business state',async()=>{
  const f=await assetViewFixture();delete f.document.runtime.dBatchAssetTransports;
  const before=structuredClone(f.document),view=projectDBatchExecutionView(f.document,f.batch.batchId);
  assert.equal(view.members[0].assetStatus,'not_started');
  assert.equal(view.members[0].assetReason,null);
  assert.equal(view.assetRequestTransmission,'not_attempted');
  assert.deepEqual(f.document,before);
});

test('asset projection rejects duplicated or cross-scope records instead of showing a successful asset state',async()=>{
  const f=await assetViewFixture();
  const duplicate=structuredClone(f.document);
  duplicate.runtime.dBatchAssetTransports.push(structuredClone(f.assetRecord));
  assert.throws(()=>projectDBatchExecutionView(duplicate,f.batch.batchId),/D_BATCH_VIEW_ASSET_NOT_UNIQUE/);
  for(const mutate of [
    record=>{record.recordId='d-batch-assets:other';},
    record=>{record.candidateId='candidate:other';},
    record=>{record.scope.candidateId='candidate:other';},
    record=>{record.scope.skuPackageId='sku:other';},
    record=>{record.scope.sourceRevision++;},
    record=>{record.scope.authorizationId='production-auth:other';},
    record=>{record.scope.authorizationFingerprint='0'.repeat(64);},
    record=>{record.scope.storeRef.platformStoreId='seller-other';},
    record=>{record.scope.members[0].offerId='offer:other';},
    record=>{record.state.intent.authorizationId='production-auth:other';},
    record=>{record.state.intent.finalUploadAssetIds.reverse();},
    record=>{record.writeIntents=[{assetId:'asset:other',order:1,sha256:'0'.repeat(64)}];},
    record=>{record.state.intent.ossWrites=-1;}
  ]){
    const document=structuredClone(f.document);mutate(document.runtime.dBatchAssetTransports[0]);
    const before=structuredClone(document);
    assert.throws(()=>projectDBatchExecutionView(document,f.batch.batchId),/D_BATCH_VIEW_ASSET_SOURCE_CONFLICT/);
    assert.deepEqual(document,before);
  }
});

test('asset attempts stay within their batch and never alter current E stop reasons or historical observations',async()=>{
  const f=await assetViewFixture(),other=structuredClone(f.assetRecord);
  other.batchId='d-batch:unrelated';other.status='unknown_outcome';other.state.status='unknown_outcome';
  other.state.intent.ossWrites='unknown';
  delete f.document.runtime.dBatchAssetTransports;
  f.document.runtime.dBatchAssetTransports=[other];
  assert.equal(projectDBatchExecutionView(f.document,f.batch.batchId).assetRequestTransmission,'not_attempted');
  const {record,observation,job,event}=await fixture();
  const pending=createDBatchEReadback({record,observation:{...observation,
    currentPrice:{...record.expectedPrice,amount:record.expectedPrice.amount+1}},readAt:now});
  const running=event(job,{kind:'read_started'});
  const waiting=event(running,{kind:'read_pending',resultId:pending.readbackId});
  const stopped=event(waiting,{kind:'observation_stopped',reason:'policy_expired'},30_000);
  f.document.runtime.dBatchImportJobs=[{batchId:record.batchId,chunks:[{index:0,offerIds:[record.offerId],
    results:[{offerId:record.offerId,classification:'imported',importObservation:{productId:record.productId}}]}]}];
  f.document.runtime.dBatchEJobs=[stopped];f.document.runtime.dBatchEReadbacks=[pending];
  const before=structuredClone(f.document),view=projectDBatchExecutionView(f.document,f.batch.batchId);
  assert.equal(view.members[0].eStatus,'observation_stopped');
  assert.equal(view.members[0].eStopReason,'policy_expired');
  assert.deepEqual(view.members[0].eGaps,['currentPrice']);
  assert.equal(view.members[0].listedVerified,false);
  assert.deepEqual(f.document,before);
});
