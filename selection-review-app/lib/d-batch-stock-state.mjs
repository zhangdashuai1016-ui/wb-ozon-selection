import { isDeepStrictEqual } from 'node:util';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

export const D_BATCH_STOCK_JOB_VERSION = 'd-batch-stock-job-v1';
const clone = value => structuredClone(value);
const ref = value => typeof value === 'string' && value.trim().length > 0;
const time = value => ref(value) && !Number.isNaN(Date.parse(value));
const states = new Set(['inventory_deferred','awaiting_prerequisites','prerequisites_in_flight',
  'ready_to_write','stock_intent','stock_accepted','needs_owner','unknown_outcome']);

function assertJob(job) {
  if (job?.schemaVersion !== D_BATCH_STOCK_JOB_VERSION || !ref(job.jobId) || !ref(job.batchId) ||
      !ref(job.offerId) || !ref(job.candidateId) || !ref(job.skuPackageId) || !ref(job.authorizationId) ||
      !ref(job.authorizationFingerprint) || !ref(job.taskId) || !ref(job.productId) ||
      !ref(job.workerId) || !ref(job.workerVersion) || !ref(job.leaseId) || !time(job.leaseExpiresAt) ||
      !time(job.createdAt) || !time(job.updatedAt) || !Number.isSafeInteger(job.revision) || job.revision < 1 ||
      !states.has(job.status) || !['create_only','write_authorized_stock'].includes(job.inventoryAction) ||
      typeof job.eReadbackRequired !== 'boolean' || !Number.isSafeInteger(job.prerequisiteReads) ||
      job.prerequisiteReads < 0 || job.prerequisiteReads > 1 ||
      (job.inventoryAction === 'create_only' && (job.status !== 'inventory_deferred' || job.prerequisiteReads !== 0)) ||
      (job.status === 'prerequisites_in_flight' && job.prerequisiteReads !== 1) ||
      (job.status === 'ready_to_write' && (!ref(job.priceReceiptRef) || !ref(job.stockReceiptRef) || job.observedFreeStock !== 0)) ||
      (job.status === 'stock_intent' && !time(job.stockIntentAt)) ||
      (job.status === 'stock_accepted' && !ref(job.inventoryReceiptRef)) ||
      (job.status === 'unknown_outcome' && !ref(job.unknownReason)) ||
      (job.status === 'needs_owner' && !ref(job.ownerReason))) throw new Error('D_BATCH_STOCK_JOB_INVALID');
  assertSafeRuntimeRecord(job, 'dBatchStockJob');
  return job;
}

/** One member's stock action, bound to its imported offer and its own production authorization. */
export function createDBatchStockJob({ batch, member, taskId, productId, workerId, workerVersion,
  leaseId, leaseExpiresAt, createdAt }) {
  if (batch?.schemaVersion !== 'd-batch-production-authorization-v2' ||
      batch.postImportScope?.schemaVersion !== 'd-batch-post-import-scope-v1' ||
      !batch.postImportScope.eReadbackOfferIds.includes(member?.offerId) ||
      !batch.members.some(saved => isDeepStrictEqual(saved, member)) ||
      !/^[1-9][0-9]*$/.test(taskId) || !/^[1-9][0-9]*$/.test(productId) ||
      ![workerId,workerVersion,leaseId].every(ref) || !time(createdAt) || !time(leaseExpiresAt) ||
      Date.parse(leaseExpiresAt) <= Date.parse(createdAt)) throw new Error('D_BATCH_STOCK_ADMISSION_INVALID');
  const inventoryAction = batch.postImportScope.inventoryAction;
  const job = { schemaVersion:D_BATCH_STOCK_JOB_VERSION,
    jobId:`d-batch-stock:${batch.batchId}:${member.candidateId}`, batchId:batch.batchId,
    offerId:member.offerId,candidateId:member.candidateId,skuPackageId:member.skuPackageId,
    authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,
    taskId,productId,inventoryAction,eReadbackRequired:true,
    workerId,workerVersion,leaseId,leaseExpiresAt,revision:1,createdAt,updatedAt:createdAt,
    status:inventoryAction==='create_only'?'inventory_deferred':'awaiting_prerequisites',
    prerequisiteReads:0,priceReceiptRef:null,stockReceiptRef:null,observedFreeStock:null,
    stockIntentAt:null,inventoryReceiptRef:null,unknownReason:null,ownerReason:null };
  return Object.freeze(assertJob(job));
}

/** Intents are durable and non-replayable. A lost stock receipt is unknown, never a new stock write. */
export function applyDBatchStockEvent({ job, event, workerId, leaseId, observedAt }) {
  assertJob(job);
  if (!time(observedAt) || workerId !== job.workerId || leaseId !== job.leaseId ||
      Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt) ||
      event?.offerId !== job.offerId || event.taskId !== job.taskId || event.productId !== job.productId) {
    throw new Error('D_BATCH_STOCK_LEASE_OR_SCOPE_INVALID');
  }
  const next=clone(job);
  if(event.kind==='prerequisites_started'){
    if(next.status!=='awaiting_prerequisites'||next.prerequisiteReads!==0)
      throw new Error('D_BATCH_STOCK_PREREQUISITE_REPLAY_BLOCKED');
    next.prerequisiteReads=1;next.status='prerequisites_in_flight';
  }else if(event.kind==='prerequisites_observed'){
    if(next.status!=='prerequisites_in_flight'||!ref(event.priceReceiptRef)||!ref(event.stockReceiptRef)||
        !['verified','unknown'].includes(event.priceSent)||
        !(event.freeStock==='unknown'||Number.isSafeInteger(event.freeStock)&&event.freeStock>=0))
      throw new Error('D_BATCH_STOCK_PREREQUISITES_INVALID');
    next.priceReceiptRef=event.priceReceiptRef;next.stockReceiptRef=event.stockReceiptRef;
    next.observedFreeStock=event.freeStock;
    if(event.priceSent==='verified'&&event.freeStock===0)next.status='ready_to_write';
    else {next.status='needs_owner';next.ownerReason=event.priceSent!=='verified'?'price_not_verified':
      event.freeStock==='unknown'?'stock_unknown':'stock_not_zero';}
  }else if(event.kind==='stock_intent'){
    if(next.status!=='ready_to_write'||next.stockIntentAt!==null)
      throw new Error('D_BATCH_STOCK_INTENT_REPLAY_BLOCKED');
    next.stockIntentAt=observedAt;next.status='stock_intent';
  }else if(event.kind==='stock_receipt'){
    if(next.status!=='stock_intent'||!ref(event.inventoryReceiptRef)||event.accepted!==true)
      throw new Error('D_BATCH_STOCK_RECEIPT_INVALID');
    next.inventoryReceiptRef=event.inventoryReceiptRef;next.status='stock_accepted';
  }else if(event.kind==='stock_unknown'){
    if(next.status!=='stock_intent'||!ref(event.reason))throw new Error('D_BATCH_STOCK_UNKNOWN_INVALID');
    next.unknownReason=event.reason;next.status='unknown_outcome';
  }else throw new Error('D_BATCH_STOCK_EVENT_INVALID');
  next.revision++;next.updatedAt=observedAt;
  return Object.freeze(assertJob(next));
}

/** Reclaim changes only ownership; an in-flight read or stock intent remains non-replayable. */
export function reclaimDBatchStockJob({job,workerId,workerVersion,leaseId,leaseExpiresAt,observedAt}){
  assertJob(job);
  if(![workerId,workerVersion,leaseId].every(ref)||!time(leaseExpiresAt)||!time(observedAt)||
      Date.parse(observedAt)<Date.parse(job.leaseExpiresAt)||Date.parse(leaseExpiresAt)<=Date.parse(observedAt))
    throw new Error('D_BATCH_STOCK_RECLAIM_INVALID');
  return Object.freeze(assertJob({...clone(job),workerId,workerVersion,leaseId,leaseExpiresAt,
    updatedAt:observedAt,revision:job.revision+1}));
}
