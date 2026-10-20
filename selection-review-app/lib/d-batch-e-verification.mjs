import {isDeepStrictEqual} from 'node:util';
import {batchOfferReadbackGaps} from './d-batch-offer-readback.mjs';
import {projectDBatchEMediaReview,readDBatchEMediaConfirmation} from './d-batch-e-media-review.mjs';
import {assertInSaleListJob} from './ozon-in-sale-list-observation.mjs';
import {assertSafeRuntimeRecord} from './runtime-identity.mjs';

const clone=value=>structuredClone(value);
const version='d-batch-e-verification-v1';
function savedRecords(document){
  const records=document.runtime?.dBatchEVerifications??[];
  if(!Array.isArray(records))throw new Error('D_BATCH_E_VERIFICATION_STORE_INVALID');
  return records;
}
function evaluate(document,batchId,candidateId,verifiedAt){
  const batches=(document.runtime?.dProductionBatches??[]).filter(value=>value.batchId===batchId);
  if(batches.length!==1)throw new Error('D_BATCH_E_VERIFICATION_BATCH_INVALID');
  const batch=batches[0];
  if(batch.schemaVersion!=='d-batch-production-authorization-v3')
    return {status:'not_verified',gaps:['current_e_scope_not_authorized'],record:null};
  const media=projectDBatchEMediaReview({document,batchId,candidateId});
  if(!media.scope)return {status:'not_verified',gaps:[media.reasonCode],record:null};
  const confirmation=readDBatchEMediaConfirmation({document,batchId,candidateId});
  const source=media.scope.sourceRecord,readback=media.scope.readback;
  const binding=document.candidates.find(candidate=>candidate.id===candidateId)
    .lifecycleV11.skuPackage.productionAuthorization.executionBinding;
  const gaps=batchOfferReadbackGaps(source,readback.observation).filter(code=>code!=='media_identity_unverified');
  // IN_SALE supplies sale evidence only; it cannot manufacture approval or validation.
  if(readback.observation.moderationStatus!=='approved')gaps.push('moderation_not_approved');
  if(readback.observation.validationStatus!=='success')gaps.push('validation_not_success');
  if(source.inventoryAction!=='write_authorized_stock')gaps.push('authorized_stock_not_verified');
  if(!confirmation)gaps.push(media.status==='owner_mismatch'?'owner_media_mismatch':'owner_media_confirmation_required');
  const jobs=(document.runtime.dBatchInSaleJobs??[]).filter(job=>job.scope?.batchId===batchId);
  if(jobs.length>1)throw new Error('D_BATCH_E_VERIFICATION_LIST_NOT_UNIQUE');
  const job=jobs[0];let match=null;
  if(job){
    assertInSaleListJob(job);
    const target=job.scope.targets.find(value=>value.candidateId===candidateId);
    const expected={candidateId,skuPackageId:source.skuPackageId,sourceRevision:media.scope.sourceRevision,
      sourceRecordId:source.recordId,authorizationId:source.authorizationId,
      authorizationFingerprint:source.authorizationFingerprint,offerId:source.offerId,productId:source.productId};
    if(target&&!isDeepStrictEqual(target,expected))throw new Error('D_BATCH_E_VERIFICATION_LIST_SCOPE_CHANGED');
    if(!isDeepStrictEqual(job.scope.storeRef,source.storeRef)||job.scope.warehouseRef!==source.warehouseRef||
        job.scope.credentialAlias!==source.credentialAlias||job.scope.warehouseId!==source.warehouseId||
        job.scope.bindingId!==binding.bindingId||job.scope.configurationVersion!==binding.configurationVersion||
        job.scope.authorizationRef!==`${batchId}:in-sale-list`||
        !isDeepStrictEqual(job.policy,batch.postImportScope.inSaleList.policy))
      throw new Error('D_BATCH_E_VERIFICATION_LIST_SCOPE_CHANGED');
    if(target)match=job.matches.find(value=>value.offerId===source.offerId&&value.productId===source.productId)??null;
  }
  if(!match)gaps.push('in_sale_not_observed');
  if(gaps.length)return {status:confirmation?'not_verified':'awaiting_owner_media_review',gaps:[...new Set(gaps)],record:null};
  if(verifiedAt===null)return {status:'verification_ready',gaps:[],record:null};
  if(!Number.isFinite(Date.parse(verifiedAt))||Date.parse(verifiedAt)<Math.max(Date.parse(readback.readAt),
      Date.parse(confirmation.confirmedAt),Date.parse(match.observedAt)))throw new Error('D_BATCH_E_VERIFICATION_TIME_INVALID');
  const record={schemaVersion:version,verificationId:`d-batch-e-verified:${readback.readbackId}`,
    batchId,candidateId,skuPackageId:source.skuPackageId,sourceRevision:media.scope.sourceRevision,
    authorizationId:source.authorizationId,authorizationFingerprint:source.authorizationFingerprint,
    sourceRecordId:source.recordId,taskId:source.taskId,productId:source.productId,offerId:source.offerId,
    storeRef:clone(source.storeRef),readbackId:readback.readbackId,
    mediaConfirmationId:confirmation.confirmationId,inSaleJobId:job.jobId,
    inSaleRequestId:match.requestId,inSaleObservedAt:match.observedAt,
    platformReadAt:readback.readAt,verifiedAt,outcome:'listed_verified',
    validationBasis:'exact_d_receipt_price_warehouse_stock_approval_validation_in_sale_and_owner_media',
    moderationStatus:readback.observation.moderationStatus,
    validationStatus:readback.observation.validationStatus,
    listedVerified:true,externalRequests:0,platformWrites:0};
  assertSafeRuntimeRecord(record,'dBatchEVerification');
  return {status:'listed_verified',gaps:[],record};
}

/** Current evidence is rechecked. Historical confirmations never manufacture a fresh platform observation. */
export function projectDBatchEVerification({document,batchId,candidateId}){
  const saved=savedRecords(document).filter(record=>record.batchId===batchId&&record.candidateId===candidateId);
  if(saved.length>1)throw new Error('D_BATCH_E_VERIFICATION_NOT_UNIQUE');
  const result=evaluate(document,batchId,candidateId,saved[0]?.verifiedAt??null);
  if(saved.length===0)return {status:result.record?'verification_ready':result.status,
    listedVerified:false,gaps:result.gaps,verification:null};
  if(!result.record||!isDeepStrictEqual(result.record,saved[0]))
    throw new Error('D_BATCH_E_VERIFICATION_SOURCE_CHANGED');
  return {status:'listed_verified',listedVerified:true,gaps:[],verification:clone(saved[0])};
}

/** Append at most one terminal batch E fact per pump pass; no candidate/PA/D history is rewritten. */
export async function reconcileDBatchEVerifications({repository,serverClock,snapshot,target=null}){
  for(const batch of snapshot.runtime?.dProductionBatches??[]){
    if(target!==null&&batch.batchId!==target.batchId)continue;
    if(batch.schemaVersion!=='d-batch-production-authorization-v3')continue;
    for(const member of batch.members){
      if(target!==null&&member.candidateId!==target.candidateId)continue;
      if(savedRecords(snapshot).some(record=>record.batchId===batch.batchId&&record.candidateId===member.candidateId))continue;
      const prepared=evaluate(snapshot,batch.batchId,member.candidateId,serverClock());
      if(!prepared.record)continue;
      const result=await repository.transact(document=>{
        const records=savedRecords(document);
        const prior=records.filter(record=>record.batchId===batch.batchId&&record.candidateId===member.candidateId);
        if(prior.length>1)throw new Error('D_BATCH_E_VERIFICATION_NOT_UNIQUE');
        if(prior.length===1)return {changed:false,result:null};
        const current=evaluate(document,batch.batchId,member.candidateId,prepared.record.verifiedAt);
        if(!current.record||!isDeepStrictEqual(current.record,prepared.record))
          throw new Error('D_BATCH_E_VERIFICATION_SOURCE_CHANGED');
        document.runtime.dBatchEVerifications=[...records,current.record];
        return {changed:true,document,result:clone(current.record)};
      });
      if(result)return {status:'batch_e_verified',result};
    }
  }
  return {status:'idle'};
}
