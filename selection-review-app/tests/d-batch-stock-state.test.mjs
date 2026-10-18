import test from 'node:test';
import assert from 'node:assert/strict';
import { createDBatchStockJob, applyDBatchStockEvent, reclaimDBatchStockJob } from '../lib/d-batch-stock-state.mjs';

const at='2026-08-22T07:25:00.000Z';
const member={candidateId:'candidate:batch-black',skuPackageId:'sku:batch-black',offerId:'BLACK-ONE',
  authorizationId:'pa:batch-black',authorizationFingerprint:'a'.repeat(64)};
const batch=inventoryAction=>({schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic',
  members:[member],postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction,
    eReadbackOfferIds:[member.offerId]}});
const input=inventoryAction=>({batch:batch(inventoryAction),member,taskId:'501',productId:'910001',
  workerId:'worker:batch',workerVersion:'v1',leaseId:'lease:one',leaseExpiresAt:'2026-08-22T07:30:00.000Z',leaseDurationMs:300000,createdAt:at,
  observationPolicy:{schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic',version:'v1',
    maxQueries:10,intervalMs:0,expiresAt:'2026-09-01T00:00:00.000Z',requestTimeoutMs:10000}});
const advance=(job,event,observedAt=at)=>applyDBatchStockEvent({job,event:{...event,
  offerId:member.offerId,taskId:'501',productId:'910001'},workerId:'worker:batch',leaseId:'lease:one',observedAt});
function prerequisites(freeStock,priceSent='verified'){
 const scope={taskId:'501',productId:'910001',merchantSku:member.offerId,warehouseId:'70001'};
 const policy={version:'synthetic'};
 const inventoryObservation={sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2',hasNext:false,
  rows:[{warehouseId:'70001',productId:'910001',sku:'1910001',offerId:member.offerId,
    freeStock,present:freeStock,reserved:0}]};
 return {kind:'prerequisites_observed',priceSentObservation:{scope,policy,priceSent,
  requestReceiptRef:'receipt:price'},inventoryPrerequisiteObservation:{scope,policy,priceSent:'unknown',
  inventoryObservation,reservedObservation:freeStock==='unknown'?'unknown':'observed',
  requestReceiptRef:'receipt:stock'}};
}

test('explicit create-only batch member never enters an inventory write state',()=>{
 const job=createDBatchStockJob(input('create_only'));
 assert.equal(job.status,'inventory_deferred');
 assert.equal(job.eReadbackRequired,true);
 assert.throws(()=>advance(job,{kind:'prerequisites_started'}),/PREREQUISITE_REPLAY_BLOCKED/);
 assert.throws(()=>advance(job,{kind:'stock_intent'}),/INTENT_REPLAY_BLOCKED/);
});

test('new batch scope preserves the same stock action and rejects an old scope relabelled as current',()=>{
 const source=input('write_authorized_stock');
 source.batch.schemaVersion='d-batch-production-authorization-v3';
 assert.throws(()=>createDBatchStockJob(source),/POST_IMPORT_SCOPE_INVALID/);
 source.batch.postImportScope={...source.batch.postImportScope,schemaVersion:'d-batch-post-import-scope-v2',inSaleList:{
   schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
   officialEvidenceRef:'official:ozon-in-sale-list:20261018',
   policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}};
 const job=createDBatchStockJob(source);
 assert.equal(job.status,'awaiting_prerequisites');
 assert.equal(job.inventoryAction,'write_authorized_stock');
 assert.equal(job.authorizationId,member.authorizationId);
});

test('one exact prerequisite read and durable stock intent allow one accepted receipt',()=>{
 const admitted=createDBatchStockJob(input('write_authorized_stock'));
 const reading=advance(admitted,{kind:'prerequisites_started'});
 assert.throws(()=>advance(reading,{kind:'prerequisites_started'}),/PREREQUISITE_REPLAY_BLOCKED/);
 const ready=advance(reading,prerequisites(0));
 assert.equal(ready.status,'ready_to_write');
 const intent=advance(ready,{kind:'stock_intent'});
 assert.equal(intent.status,'stock_intent');
 assert.throws(()=>advance(intent,{kind:'stock_intent'}),/INTENT_REPLAY_BLOCKED/);
 const accepted=advance(intent,{kind:'stock_receipt',accepted:true,inventoryReceiptRef:'receipt:inventory'});
 assert.equal(accepted.status,'stock_accepted');
 assert.throws(()=>advance(accepted,{kind:'stock_intent'}),/INTENT_REPLAY_BLOCKED/);
});

test('nonzero or unknown stock requires an owner; sent stock intent cannot replay after restart',()=>{
 for(const freeStock of [100,'unknown']){
  const reading=advance(createDBatchStockJob(input('write_authorized_stock')),{kind:'prerequisites_started'});
  const blocked=advance(reading,prerequisites(freeStock));
  assert.equal(blocked.status,'needs_owner');
  assert.throws(()=>advance(blocked,{kind:'stock_intent'}),/INTENT_REPLAY_BLOCKED/);
 }
 const reading=advance(createDBatchStockJob(input('write_authorized_stock')),{kind:'prerequisites_started'});
 const ready=advance(reading,prerequisites(0));
 const intent=advance(ready,{kind:'stock_intent'});
 const unknown=advance(intent,{kind:'stock_unknown',reason:'response_lost'});
 assert.equal(unknown.status,'unknown_outcome');
 assert.throws(()=>advance(unknown,{kind:'stock_receipt',accepted:true,
  inventoryReceiptRef:'receipt:late'}),/RECEIPT_INVALID/);
 const reclaimed=reclaimDBatchStockJob({job:intent,workerId:'worker:batch',workerVersion:'v1',
  leaseId:'lease:two',leaseExpiresAt:'2026-08-22T07:35:00.000Z',observedAt:'2026-08-22T07:31:00.000Z'});
 assert.equal(reclaimed.status,'stock_intent');
 assert.throws(()=>applyDBatchStockEvent({job:reclaimed,event:{kind:'stock_intent',offerId:member.offerId,
  taskId:'501',productId:'910001'},workerId:'worker:batch',leaseId:'lease:two',
  observedAt:'2026-08-22T07:31:00.000Z'}),/INTENT_REPLAY_BLOCKED/);
});

test('a prewrite stop requires explicit no-transmission proof and never permits replay',()=>{
 const reading=advance(createDBatchStockJob(input('write_authorized_stock')),{kind:'prerequisites_started'});
 const ready=advance(reading,prerequisites(0));
 const intent=advance(ready,{kind:'stock_intent'});
 for(const job of [ready,intent]){
  assert.throws(()=>advance(job,{kind:'stock_prewrite_blocked',reason:'permission_denied'}),
    /PREWRITE_BLOCK_INVALID/);
  const stopped=advance(job,{kind:'stock_prewrite_blocked',reason:'permission_denied',
    requestTransmission:'not_attempted'});
  assert.equal(stopped.status,'prewrite_blocked');
  assert.throws(()=>advance(stopped,{kind:'stock_intent'}),/INTENT_REPLAY_BLOCKED/);
 }
});

test('the same holder can preserve a late stock result but an old lease cannot overwrite a new holder',()=>{
 const reading=advance(createDBatchStockJob(input('write_authorized_stock')),{kind:'prerequisites_started'});
 const ready=advance(reading,prerequisites(0));
 const intent=advance(ready,{kind:'stock_intent'});
 const lateAt='2026-08-22T07:31:00.000Z';
 const receipt=advance(intent,{kind:'stock_receipt',accepted:true,
  inventoryReceiptRef:'receipt:late-accepted'},lateAt);
 assert.equal(receipt.status,'stock_accepted');
 const unknown=advance(intent,{kind:'stock_unknown',reason:'interrupted_after_intent'},lateAt);
 assert.equal(unknown.status,'unknown_outcome');
 const failedRead=advance(reading,{kind:'prerequisites_failed',reason:'interrupted_read'},lateAt);
 assert.equal(failedRead.status,'precheck_failed');
 assert.throws(()=>advance(ready,{kind:'stock_intent'},lateAt),/LEASE_OR_SCOPE_INVALID/);
 const reclaimed=reclaimDBatchStockJob({job:intent,workerId:'worker:batch',workerVersion:'v1',
  leaseId:'lease:two',leaseExpiresAt:'2026-08-22T07:35:00.000Z',observedAt:lateAt});
 assert.throws(()=>advance(reclaimed,{kind:'stock_receipt',accepted:true,
  inventoryReceiptRef:'receipt:old-holder'},lateAt),/LEASE_OR_SCOPE_INVALID/);
 assert.throws(()=>advance(intent,{kind:'stock_unknown',reason:'time_reversed'},
  '2026-08-22T07:24:00.000Z'),/LEASE_OR_SCOPE_INVALID/);
});
