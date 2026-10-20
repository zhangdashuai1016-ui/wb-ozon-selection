import { isDeepStrictEqual } from 'node:util';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { isCompleteStoreRef, sameStoreRef } from './store-binding.mjs';
import { observedWarehouseAvailableStock, productionReadbackContentGaps,
  productionReadbackMediaGaps, validateProductionReadbackExpectation } from './e-stage-readback.mjs';
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { assertDBatchFrozenImport } from './d-batch-import-state.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import {supportsPostImportBatch,assertDBatchPostImportScope} from './d-batch-production-contract.mjs';

export const D_BATCH_OFFER_RECORD_VERSION='d-batch-offer-record-v2';
export const D_BATCH_E_READBACK_VERSION='d-batch-e-readback-v2';
export const D_BATCH_E_JOB_VERSION='d-batch-e-job-v2';
const LEGACY_E_JOB_VERSION='d-batch-e-job-v1';
const LEGACY_E_READBACK_VERSION='d-batch-e-readback-v1';
const clone=value=>structuredClone(value);
const ref=value=>typeof value==='string'&&value.trim().length>0;
const time=value=>ref(value)&&!Number.isNaN(Date.parse(value));
const positiveId=value=>ref(value)&&/^[1-9][0-9]*$/.test(value);

/** One immutable D source. Import and optional stock write remain separate facts. */
export function createDBatchOfferRecord({batch,member,chunkIndex,stockJob,source,frozenImport,chunkOfferIds,
  importObservation,createdAt}){
  assertDBatchFrozenImport(frozenImport,chunkOfferIds);
  assertDBatchPostImportScope(batch?.postImportScope,batch?.members?.map(value=>value.offerId),batch?.schemaVersion);
  const itemIndex=chunkOfferIds.indexOf(member.offerId);
  if(!supportsPostImportBatch(batch?.schemaVersion)||
      !batch.members.some(saved=>isDeepStrictEqual(saved,member))||
      !Number.isSafeInteger(chunkIndex)||chunkIndex<0||
      stockJob?.batchId!==batch.batchId||stockJob.offerId!==member.offerId||
      stockJob.candidateId!==member.candidateId||stockJob.skuPackageId!==member.skuPackageId||
      stockJob.authorizationId!==member.authorizationId||
      stockJob.authorizationFingerprint!==member.authorizationFingerprint||
      stockJob.inventoryAction!==batch.postImportScope.inventoryAction||
      source?.candidateId!==member.candidateId||source.skuPackageId!==member.skuPackageId||
      source.merchantSku!==member.offerId||source.sourceAuthorizationId!==member.authorizationId||
      source.sourceAuthorizationFingerprint!==member.authorizationFingerprint||
      itemIndex<0||!isDeepStrictEqual(source,frozenImport.memberSources[itemIndex])||
      frozenImport.items[itemIndex]?.offer_id!==member.offerId||
      importObservation?.kind!=='import_result_observed'||
      importObservation.taskId!==stockJob.taskId||
      importObservation.productId!==stockJob.productId||
      !ref(importObservation.requestReceiptRef)||!positiveId(stockJob.taskId)||
      !positiveId(stockJob.productId)||!time(createdAt)||
      (stockJob.inventoryAction==='create_only'&&stockJob.status!=='inventory_deferred')||
      (stockJob.inventoryAction==='write_authorized_stock'&&stockJob.status!=='stock_accepted'))
    throw new Error('D_BATCH_OFFER_SOURCE_INVALID');
  const record={schemaVersion:D_BATCH_OFFER_RECORD_VERSION,
    recordId:`d-batch-offer:${batch.batchId}:${member.offerId}`,
    batchId:batch.batchId,chunkIndex,taskId:stockJob.taskId,productId:stockJob.productId,
    candidateId:member.candidateId,skuPackageId:member.skuPackageId,offerId:member.offerId,
    supplierSkuId:source.supplierSkuId,
    authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,
    productionPlanId:source.sourceProductionPlanId,
    productionPlanFingerprint:source.sourceProductionPlanFingerprint,
    importRequestReceiptRef:importObservation.requestReceiptRef,
    importItemFingerprint:fingerprintCanonicalRecord(frozenImport.items[itemIndex]),
    importChunkFingerprint:frozenImport.itemFingerprint,
    importContentFingerprint:frozenImport.contentFingerprint,
    inventoryAction:stockJob.inventoryAction,
    inventoryModified:stockJob.inventoryAction==='write_authorized_stock',
    inventoryReceiptRef:stockJob.inventoryAction==='write_authorized_stock'?stockJob.inventoryReceiptRef:null,
    expectedStock:stockJob.inventoryAction==='write_authorized_stock'?source.stock:null,
    expectedPrice:clone(source.platformWritePrice),
    readbackExpectation:clone(source.readbackExpectation),
    platform:source.platform,store:source.store,storeRef:clone(source.storeRef),
    warehouseRef:source.warehouseRef,credentialAlias:source.credentialAlias,
    warehouseId:source.warehouseId,createdAt,
    published:false,activated:false,advertisingOpened:false,
    status:stockJob.inventoryAction==='create_only'?'created_pending_inventory':'created_stock_write_accepted'};
  assertDBatchOfferRecord(record);
  return Object.freeze(record);
}

export function assertDBatchOfferRecord(record){
  if(!['d-batch-offer-record-v1',D_BATCH_OFFER_RECORD_VERSION].includes(record?.schemaVersion)||
      ![record.recordId,record.batchId,record.candidateId,record.skuPackageId,record.offerId,
        record.supplierSkuId,record.authorizationId,record.authorizationFingerprint,
        record.productionPlanId,record.productionPlanFingerprint,record.importRequestReceiptRef,
        record.warehouseRef,record.credentialAlias].every(ref)||
      !Number.isSafeInteger(record.chunkIndex)||record.chunkIndex<0||
      !positiveId(record.taskId)||!positiveId(record.productId)||!time(record.createdAt)||
      (record.schemaVersion===D_BATCH_OFFER_RECORD_VERSION&&
        (!ref(record.importItemFingerprint)||!ref(record.importChunkFingerprint)||
          !ref(record.importContentFingerprint)))||
      !['create_only','write_authorized_stock'].includes(record.inventoryAction)||
      !validateProductionReadbackExpectation(record.readbackExpectation)||
      record.readbackExpectation.warehouseId!==record.warehouseId||
      !isCompleteStoreRef(record.storeRef,record.store)||
      record.platform!=='ozon'||!ref(record.store)||
      !Number.isFinite(record.expectedPrice?.amount)||record.expectedPrice.currency!=='CNY'||
      record.published!==false||record.activated!==false||record.advertisingOpened!==false||
      (record.inventoryAction==='create_only'&&
        (record.inventoryModified!==false||record.inventoryReceiptRef!==null||
          record.expectedStock!==null||record.status!=='created_pending_inventory'))||
      (record.inventoryAction==='write_authorized_stock'&&
        (record.inventoryModified!==true||!ref(record.inventoryReceiptRef)||
          !Number.isSafeInteger(record.expectedStock)||record.expectedStock<0||
          record.status!=='created_stock_write_accepted')))
    throw new Error('D_BATCH_OFFER_RECORD_INVALID');
  assertSafeRuntimeRecord(record,'dBatchOfferRecord');
  return record;
}

/** E confirms the exact card. A stock-write scope additionally requires the exact warehouse quantity. */
export function batchOfferReadbackGaps(record,observation){
  assertDBatchOfferRecord(record);
  const gaps=[];
  if(!observation||typeof observation!=='object')return ['observation_missing'];
  for(const [field,expected] of Object.entries({platform:record.platform,store:record.store,
    skuPackageId:record.skuPackageId,supplierSkuId:record.supplierSkuId,
    merchantSku:record.offerId,platformProductId:record.productId}))
    if(observation[field]!==expected)gaps.push(field);
  if(!sameStoreRef(observation.storeRef,record.storeRef)||
      observation.warehouseRef!==record.warehouseRef||
      observation.credentialAlias!==record.credentialAlias)gaps.push('executionBinding');
  if(!isDeepStrictEqual(observation.currentPrice,record.expectedPrice))gaps.push('currentPrice');
  if(!ref(observation.platformEvidenceRef))gaps.push('platformEvidenceRef');
  if(!Array.isArray(observation.errors)||observation.errors.length>0)gaps.push('platformErrors');
  gaps.push(...(record.inventoryAction==='create_only'
    ? productionReadbackMediaGaps(record.readbackExpectation,observation)
    : productionReadbackContentGaps(record.readbackExpectation,observation)));
  if(record.inventoryAction==='write_authorized_stock'){
    const current=observedWarehouseAvailableStock(observation.inventoryObservation,record.warehouseId,
      {productId:record.productId,offerId:record.offerId});
    if(current!==record.expectedStock||observation.currentStock!==record.expectedStock)
      gaps.push('authorized_stock_not_verified');
  }
  return [...new Set(gaps)];
}

/** Failed or incomplete reads are durable observations, not a listing-success assertion. */
export function createDBatchEReadback({record,observation,readAt,readFailure=null,readSequence=1,
  schemaVersion=D_BATCH_E_READBACK_VERSION}){
  assertDBatchOfferRecord(record);
  if(!time(readAt)||Date.parse(readAt)<Date.parse(record.createdAt)||
      ![D_BATCH_E_READBACK_VERSION,LEGACY_E_READBACK_VERSION].includes(schemaVersion)||
      !Number.isSafeInteger(readSequence)||readSequence<1||readSequence>100||
      (readFailure!==null&&!ref(readFailure))||
      (readFailure===null&&(!observation||typeof observation!=='object')))
    throw new Error('D_BATCH_E_READBACK_INPUT_INVALID');
  const gaps=readFailure===null?batchOfferReadbackGaps(record,observation):[`technical_readback_failure:${readFailure}`];
  const comparable=readFailure===null&&Number.isFinite(observation.currentPrice?.amount)&&
    observation.currentPrice.amount>0&&observation.currentPrice.currency===record.expectedPrice.currency&&
    Number.isSafeInteger(observation.imageCount)&&observation.imageCount>=0&&
    (record.inventoryAction==='create_only'||
      Number.isSafeInteger(observation.currentStock)&&observation.currentStock>=0);
  const observationDisposition=readFailure!==null?'failed':gaps.length===0?'complete':
    comparable&&gaps.every(code=>['currentPrice','authorized_stock_not_verified','warehouse_stock_mismatch',
      'media_manifest_mismatch','main_image_mismatch','media_order_or_set_mismatch','imageCount'].includes(code))
      ?'observe':'stop';
  const result={schemaVersion,
    readbackId:`d-batch-e:${record.recordId}${schemaVersion===D_BATCH_E_READBACK_VERSION?`:read:${readSequence}`:''}`,sourceRecordId:record.recordId,
    batchId:record.batchId,chunkIndex:record.chunkIndex,taskId:record.taskId,
    offerId:record.offerId,candidateId:record.candidateId,
    authorizationId:record.authorizationId,
    status:gaps.length?'not_verified':record.inventoryAction==='create_only'?'card_observed_pending_inventory':'card_and_stock_observed',
    inventoryWritten:record.inventoryModified,
    listedVerified:false,readAt,gaps,
    observation:readFailure===null?clone(observation):null};
  if(schemaVersion===D_BATCH_E_READBACK_VERSION){
    result.readSequence=readSequence;
    result.observationDisposition=observationDisposition;
    if(observationDisposition==='observe')result.status='verification_pending';
  }
  assertSafeRuntimeRecord(result,'dBatchEReadback');
  return Object.freeze(result);
}

export function createDBatchEJob({record,workerId,workerVersion,leaseId,leaseExpiresAt,
  leaseDurationMs,observationPolicy,createdAt}){
  assertDBatchOfferRecord(record);assertDPlatformObservationPolicy(observationPolicy);
  if(![workerId,workerVersion,leaseId].every(ref)||!time(leaseExpiresAt)||!time(createdAt)||
      Date.parse(leaseExpiresAt)<=Date.parse(createdAt)||
      !Number.isSafeInteger(leaseDurationMs)||leaseDurationMs<1000||leaseDurationMs>300000)
    throw new Error('D_BATCH_E_JOB_ADMISSION_INVALID');
  const job={schemaVersion:D_BATCH_E_JOB_VERSION,jobId:`d-batch-e-job:${record.recordId}`,
    recordId:record.recordId,batchId:record.batchId,offerId:record.offerId,
    candidateId:record.candidateId,authorizationId:record.authorizationId,
    workerId,workerVersion,leaseId,leaseExpiresAt,leaseDurationMs,
    observationPolicy:clone(observationPolicy),status:'queued',readCount:0,nextReadAt:createdAt,
    createdAt,updatedAt:createdAt};
  return Object.freeze(assertDBatchEJob(job));
}

export function assertDBatchEJob(job){
  assertDPlatformObservationPolicy(job?.observationPolicy);
  const current=job?.schemaVersion===D_BATCH_E_JOB_VERSION;
  if(![D_BATCH_E_JOB_VERSION,LEGACY_E_JOB_VERSION].includes(job?.schemaVersion)||
      ![job.jobId,job.recordId,job.batchId,job.offerId,job.candidateId,
        job.authorizationId,job.workerId,job.workerVersion,job.leaseId].every(ref)||
      !time(job.leaseExpiresAt)||!time(job.createdAt)||!time(job.updatedAt)||
      !Number.isSafeInteger(job.leaseDurationMs)||job.leaseDurationMs<1000||job.leaseDurationMs>300000||
      !Number.isSafeInteger(job.readCount)||job.readCount<0||
      job.readCount>job.observationPolicy.maxQueries||
      !['queued','read_in_flight','completed','read_failed','observation_stopped',
        ...(current?['observed_pending']:[])].includes(job.status)||
      (current&&(!time(job.nextReadAt)||Date.parse(job.nextReadAt)<Date.parse(job.createdAt)))||
      (job.status==='queued'&&job.readCount!==0)||
      (job.status==='observed_pending'&&(job.readCount===0||!ref(job.resultId)))||
      (job.status==='read_in_flight'&&job.readCount===0)||
      (['completed','read_failed'].includes(job.status)&&!ref(job.resultId))||
      (job.status==='observation_stopped'&&!ref(job.stopReason)))
    throw new Error('D_BATCH_E_JOB_INVALID');
  assertSafeRuntimeRecord(job,'dBatchEJob');
  return job;
}

export function applyDBatchEJobEvent({job,event,workerId,leaseId,observedAt}){
  assertDBatchEJob(job);
  const terminalReceipt=['read_completed','read_pending','read_failed','observation_stopped'].includes(event?.kind);
  if(!time(observedAt)||workerId!==job.workerId||leaseId!==job.leaseId||
      (!terminalReceipt&&Date.parse(observedAt)>=Date.parse(job.leaseExpiresAt)))
    throw new Error('D_BATCH_E_JOB_LEASE_INVALID');
  const next=clone(job);
  if(event.kind==='read_started'){
    if(!['queued',...(next.schemaVersion===D_BATCH_E_JOB_VERSION?['observed_pending']:['read_in_flight'])].includes(next.status)||
        (next.schemaVersion===D_BATCH_E_JOB_VERSION&&Date.parse(observedAt)<Date.parse(next.nextReadAt))||
        next.readCount>=next.observationPolicy.maxQueries||
        Date.parse(observedAt)>=Date.parse(next.observationPolicy.expiresAt))
      throw new Error('D_BATCH_E_JOB_READ_NOT_ADMITTED');
    next.status='read_in_flight';next.readCount++;
  }else if(event.kind==='read_pending'){
    if(next.schemaVersion!==D_BATCH_E_JOB_VERSION||next.status!=='read_in_flight'||!ref(event.resultId))
      throw new Error('D_BATCH_E_JOB_PENDING_INVALID');
    next.status='observed_pending';next.resultId=event.resultId;
    next.nextReadAt=new Date(Date.parse(observedAt)+next.observationPolicy.intervalMs).toISOString();
  }else if(event.kind==='read_completed'){
    if(next.status!=='read_in_flight'||!ref(event.resultId))
      throw new Error('D_BATCH_E_JOB_RESULT_INVALID');
    next.status='completed';next.resultId=event.resultId;
  }else if(event.kind==='read_failed'){
    if(next.status!=='read_in_flight'||!ref(event.resultId))
      throw new Error('D_BATCH_E_JOB_FAILURE_INVALID');
    next.status='read_failed';next.resultId=event.resultId;
  }else if(event.kind==='observation_stopped'){
    if(!['queued','read_in_flight','observed_pending'].includes(next.status)||!ref(event.reason))
      throw new Error('D_BATCH_E_JOB_STOP_INVALID');
    next.status='observation_stopped';next.stopReason=event.reason;
  }else throw new Error('D_BATCH_E_JOB_EVENT_INVALID');
  next.updatedAt=observedAt;
  return Object.freeze(assertDBatchEJob(next));
}

export function reclaimDBatchEJob({job,workerId,workerVersion,leaseId,leaseExpiresAt,observedAt}){
  assertDBatchEJob(job);
  if(![workerId,workerVersion,leaseId].every(ref)||!time(leaseExpiresAt)||!time(observedAt)||
      Date.parse(observedAt)<Date.parse(job.leaseExpiresAt)||
      Date.parse(leaseExpiresAt)<=Date.parse(observedAt))throw new Error('D_BATCH_E_JOB_RECLAIM_INVALID');
  return Object.freeze(assertDBatchEJob({...clone(job),workerId,workerVersion,leaseId,
    leaseExpiresAt,updatedAt:observedAt}));
}
