import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDBatchEFixture} from './helpers/d-batch-e-fixture.mjs';
import {createMemoryBusinessStateRepository,createJsonBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {createActorContext} from '../lib/runtime-identity.mjs';
import {projectDBatchEMediaReview,confirmDBatchEMediaReview} from '../lib/d-batch-e-media-review.mjs';
import {createDBatchEReadback} from '../lib/d-batch-offer-readback.mjs';
import {projectDBatchEVerification,reconcileDBatchEVerifications} from '../lib/d-batch-e-verification.mjs';
import {createInSaleListJob,beginInSaleListPage,markInSaleListPageSending,buildInSaleListPageQuery,
  normalizeInSaleListPage,applyInSaleListPageResult} from '../lib/ozon-in-sale-list-observation.mjs';

const now='2026-10-18T14:00:00.000Z';
const clone=value=>structuredClone(value);
const owner=createActorContext({userId:'synthetic-owner',sessionId:'synthetic-e-session',actorType:'human',
  roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:now});
function fixture({version=3,observation={}}={}){
  const f=createDBatchEFixture({version});
  f.observation={...clone(f.observation),...observation};
  f.document.runtime.dBatchEReadbacks=[createDBatchEReadback({record:f.record,observation:f.observation,
    readAt:f.document.runtime.dBatchEReadbacks[0].readAt})];
  const batch=f.document.runtime.dProductionBatches[0],member=batch.members[0];
  const binding=f.document.candidates[0].lifecycleV11.skuPackage.productionAuthorization.executionBinding;
  const scope={schemaVersion:'ozon-in-sale-list-scope-v1',batchId:f.batchId,
    authorizationRef:`${f.batchId}:in-sale-list`,officialEvidenceRef:'official:ozon-in-sale-list:20261018',
    accountEvidenceRef:'receipt:synthetic:roles:list',storeRef:clone(f.record.storeRef),warehouseRef:f.record.warehouseRef,
    warehouseId:f.record.warehouseId,credentialAlias:f.record.credentialAlias,
    bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,
    targets:[{candidateId:f.candidateId,skuPackageId:member.skuPackageId,sourceRevision:member.resultRevision,
      sourceRecordId:f.record.recordId,authorizationId:member.authorizationId,
      authorizationFingerprint:member.authorizationFingerprint,offerId:member.offerId,productId:f.record.productId}]};
  let job=createInSaleListJob({scope,policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000},
    workerId:'worker:synthetic:1',workerVersion:'v1',leaseId:'lease:synthetic:1',
    leaseExpiresAt:'2026-10-18T14:01:30.000Z',createdAt:now});
  const holder={workerId:job.workerId,leaseId:job.leaseId,at:now};
  job=beginInSaleListPage({job,...holder});job=markInSaleListPageSending({job,...holder});
  const result=normalizeInSaleListPage({query:buildInSaleListPageQuery(job),
    response:{result:{items:[{offer_id:f.record.offerId,product_id:Number(f.record.productId)}],last_id:''}},observedAt:now});
  f.document.runtime.dBatchInSaleJobs=[applyInSaleListPageResult({job,result,...holder})];
  return f;
}
async function confirm(repository,f,decision='matches'){
  const document=await repository.readSnapshot(),view=projectDBatchEMediaReview({document,batchId:f.batchId,candidateId:f.candidateId});
  return confirmDBatchEMediaReview({repository,runtimeMode:'local_development',serverClock:()=>now,actor:owner,
    input:{scope:view.scope,decision,confirmContent:decision==='matches',confirmHero:decision==='matches',confirmOrder:decision==='matches'}});
}
const view=(document,f)=>projectDBatchEVerification({document,batchId:f.batchId,candidateId:f.candidateId});
const reconcile=async repository=>reconcileDBatchEVerifications({repository,serverClock:()=>now,snapshot:await repository.readSnapshot()});

test('images alone and sale alone cannot verify E; the complete evidence persists once without rewriting history',async()=>{
  const f=fixture(),repository=createMemoryBusinessStateRepository(f.document);
  const before=clone(f.document);
  assert.equal(view(before,f).listedVerified,false);assert.ok(view(before,f).gaps.includes('owner_media_confirmation_required'));
  await confirm(repository,f);
  assert.equal(view(await repository.readSnapshot(),f).status,'verification_ready');
  const result=await reconcile(repository);assert.equal(result.status,'batch_e_verified');
  const saved=await repository.readSnapshot();assert.equal(view(saved,f).listedVerified,true);
  assert.equal(saved.runtime.dBatchEVerifications.length,1);
  assert.deepEqual(saved.candidates,before.candidates);assert.deepEqual(saved.runtime.dBatchOfferRecords,before.runtime.dBatchOfferRecords);
  assert.deepEqual(saved.runtime.dBatchEReadbacks,before.runtime.dBatchEReadbacks);
  assert.equal(saved.runtime.dBatchEReadbacks[0].listedVerified,false);
  assert.equal((await reconcile(repository)).status,'idle');
});

test('approval, validation, price, errors and exact warehouse stock each remain independent gates',async()=>{
  const cases=[['moderation_not_approved',{moderationStatus:'unknown'}],['moderation_not_approved',{moderationStatus:'declined'}],
    ['moderation_not_approved',{moderationStatus:'in_moderation'}],['validation_not_success',{validationStatus:'failed'}],
    ['validation_not_success',{validationStatus:'unknown'}],['validation_not_success',{validationStatus:'processing'}],
    ['currentPrice',{currentPrice:{amount:1,currency:'CNY'}}],['platformErrors',{errors:['synthetic_validation_error']}],
    ['authorized_stock_not_verified',{currentStock:0}]];
  for(const [gap,observation] of cases){
    const f=fixture({observation}),repository=createMemoryBusinessStateRepository(f.document);
    await confirm(repository,f);assert.equal((await reconcile(repository)).status,'idle');
    const projected=view(await repository.readSnapshot(),f);
    assert.equal(projected.listedVerified,false);assert.ok(projected.gaps.includes(gap),gap);
  }
});

test('no sale observation and an explicit owner mismatch remain separate, non-success results',async()=>{
  const f=fixture(),repository=createMemoryBusinessStateRepository(f.document);
  await confirm(repository,f,'mismatch');
  assert.ok(view(await repository.readSnapshot(),f).gaps.includes('owner_media_mismatch'));
  assert.equal((await reconcile(repository)).status,'idle');
  const second=fixture();delete second.document.runtime.dBatchInSaleJobs;
  const other=createMemoryBusinessStateRepository(second.document);await confirm(other,second);
  assert.ok(view(await other.readSnapshot(),second).gaps.includes('in_sale_not_observed'));
  assert.equal((await reconcile(other)).status,'idle');
});

test('a stale or cross-store positive membership cannot be reused as verification',async()=>{
  const f=fixture(),repository=createMemoryBusinessStateRepository(f.document);await confirm(repository,f);
  const saved=await repository.readSnapshot();
  for(const change of [document=>{document.runtime.dBatchInSaleJobs[0].scope.storeRef.stableStoreId='other';},
    document=>{document.runtime.dBatchInSaleJobs[0].scope.bindingId='binding:other';},
    document=>{document.runtime.dBatchInSaleJobs[0].scope.configurationVersion='config:other';},
    document=>{document.runtime.dBatchInSaleJobs[0].scope.targets[0].sourceRevision++;}]){
    const changed=clone(saved);change(changed);assert.throws(()=>view(changed,f),/SCOPE_CHANGED/);
  }
});

test('legacy authorization remains historical despite complete synthetic new evidence',async()=>{
  const f=fixture({version:2}),repository=createMemoryBusinessStateRepository(f.document);await confirm(repository,f);
  assert.deepEqual(view(await repository.readSnapshot(),f).gaps,['current_e_scope_not_authorized']);
  assert.equal((await reconcile(repository)).status,'idle');
});

test('concurrent terminal commits and JSON reopen retain exactly one bound E record',async t=>{
  const f=fixture(),directory=await mkdtemp(path.join(os.tmpdir(),'batch-e-final-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));const filePath=path.join(directory,'state.json');
  const repository=createJsonBusinessStateRepository({filePath,initializeIfMissing:true,now});
  await repository.transact(()=>({changed:true,document:f.document}));await confirm(repository,f);
  const snapshot=await repository.readSnapshot();
  await Promise.all([1,2].map(()=>reconcileDBatchEVerifications({repository,serverClock:()=>now,snapshot})));
  const reopened=createJsonBusinessStateRepository({filePath});const saved=await reopened.readSnapshot();
  assert.equal(saved.runtime.dBatchEVerifications.length,1);assert.equal(view(saved,f).listedVerified,true);
  const corrupt=clone(saved);corrupt.runtime.dBatchEVerifications[0].productId='99';
  assert.throws(()=>view(corrupt,f),/SOURCE_CHANGED/);
});
