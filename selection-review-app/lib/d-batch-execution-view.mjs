import { isDeepStrictEqual } from 'node:util';
import { sameStoreRef } from './store-binding.mjs';
import {projectDBatchEMediaReview} from './d-batch-e-media-review.mjs';
import {projectDBatchEVerification} from './d-batch-e-verification.mjs';
import {assertInSaleListJob} from './ozon-in-sale-list-observation.mjs';

const clone=value=>structuredClone(value);
const text=value=>typeof value==='string'&&value.trim().length>0;

function assetView(record,batch,member){
  const scope=record.scope,state=record.state,intent=state?.intent;
  const manifest=scope?.finalUploads;
  const identityFields=['candidateId','skuPackageId','offerId','resultRevision','authorizationId','authorizationFingerprint'];
  const identities=batch.members.map(value=>Object.fromEntries(identityFields.map(key=>[key,value[key]])));
  if(record.schemaVersion!=='d-batch-asset-transport-v1'||
      record.recordId!==`d-batch-assets:${batch.batchId}:${member.candidateId}`||
      scope?.batchId!==batch.batchId||scope.candidateId!==member.candidateId||
      scope.skuPackageId!==member.skuPackageId||scope.sourceRevision!==member.resultRevision||
      scope.authorizationId!==member.authorizationId||scope.authorizationFingerprint!==member.authorizationFingerprint||
      !sameStoreRef(scope.storeRef,batch.storeRef)||!isDeepStrictEqual(scope.members,identities)||
      !isDeepStrictEqual(scope.excludedOfferIds,batch.excludedOfferIds)||
      !isDeepStrictEqual(scope.postImportScope,batch.postImportScope)||
      scope.schemaVersion!==batch.schemaVersion||
      (batch.schemaVersion==='d-batch-production-authorization-v3'&&!isDeepStrictEqual(scope.importLimitUse,batch.importLimitUse))||
      !['in_flight','verified','failed','unknown_outcome'].includes(record.status)||state?.status!==record.status||
      state.schemaVersion!=='aliyun-oss-d-asset-state-v1'||
      intent?.candidateId!==member.candidateId||intent.skuPackageId!==member.skuPackageId||
      intent.candidateDataRevision!==member.resultRevision||intent.persistedCandidateRevision!==member.resultRevision||
      intent.authorizationId!==member.authorizationId||intent.authorizationFingerprint!==member.authorizationFingerprint||
      !Array.isArray(manifest)||manifest.length===0||new Set(manifest.map(asset=>asset.assetId)).size!==manifest.length||
      manifest.some((asset,index)=>!text(asset.assetId)||asset.order!==index+1||!/^[a-f0-9]{64}$/.test(asset.sha256))||
      !isDeepStrictEqual(intent.finalUploadAssetIds,manifest.map(asset=>asset.assetId))||
      !Array.isArray(record.writeIntents)||record.writeIntents.length>manifest.length||
      record.writeIntents.some((write,index)=>['assetId','order','sha256'].some(key=>write[key]!==manifest[index][key]))||
      !(intent.ossWrites==='unknown'||Number.isSafeInteger(intent.ossWrites)&&intent.ossWrites>=0))
    throw new Error('D_BATCH_VIEW_ASSET_SOURCE_CONFLICT');
  return {assetStatus:record.status,assetReason:intent.failureCode??state.blockReason??null,
    attempted:record.writeIntents.length>0||intent.ossWrites==='unknown'||intent.ossWrites>0||
      ['verified','unknown_outcome'].includes(record.status)};
}

/** Read-only per-offer projection; a batch aggregate never overwrites a member's result. */
export function projectDBatchExecutionView(document,batchId){
  const batches=document?.runtime?.dProductionBatches?.filter(value=>value.batchId===batchId)??[];
  if(batches.length===0)throw new Error('D_BATCH_VIEW_BATCH_NOT_FOUND');
  if(batches.length!==1)throw new Error('D_BATCH_VIEW_BATCH_NOT_UNIQUE');
  const batch=batches[0];
  const listJobs=(document.runtime.dBatchInSaleJobs??[]).filter(value=>value.scope?.batchId===batchId);
  const listStops=(document.runtime.dBatchInSaleAdmissionStops??[]).filter(value=>value.batchId===batchId);
  if(listJobs.length>1||listStops.length>1)throw new Error('D_BATCH_VIEW_LIST_NOT_UNIQUE');
  const listJob=listJobs[0];
  if(listJob)assertInSaleListJob(listJob);
  const imports=document.runtime.dBatchImportJobs?.filter(value=>value.batchId===batchId)??[];
  if(imports.length>1)throw new Error('D_BATCH_VIEW_IMPORT_NOT_UNIQUE');
  const job=imports[0]??null;
  const stockJobs=document.runtime.dBatchStockJobs??[];
  const eJobs=document.runtime.dBatchEJobs??[];
  const eResults=document.runtime.dBatchEReadbacks??[];
  const assetRecords=document.runtime.dBatchAssetTransports??[];
  if(![stockJobs,eJobs,eResults,assetRecords].every(Array.isArray))throw new Error('D_BATCH_VIEW_STORE_INVALID');
  const batchAssets=assetRecords.filter(record=>record.batchId===batchId);
  if(new Set(batchAssets.map(record=>record.candidateId)).size!==batchAssets.length||
      new Set(batchAssets.map(record=>record.recordId)).size!==batchAssets.length)
    throw new Error('D_BATCH_VIEW_ASSET_NOT_UNIQUE');
  if(batchAssets.some(record=>!batch.members.some(member=>member.candidateId===record.candidateId)))
    throw new Error('D_BATCH_VIEW_ASSET_SOURCE_CONFLICT');
  let assetRequestAttempted=false;
  const members=batch.members.map(member=>{
    const assetRecord=batchAssets.find(record=>record.candidateId===member.candidateId);
    const asset=assetRecord?assetView(assetRecord,batch,member):{assetStatus:'not_started',assetReason:null,attempted:false};
    assetRequestAttempted ||= asset.attempted;
    const chunks=job?.chunks.filter(chunk=>chunk.offerIds.includes(member.offerId))??[];
    if(chunks.length>1)throw new Error('D_BATCH_VIEW_CHUNK_NOT_UNIQUE');
    const chunk=chunks[0]??null;
    const results=chunk?.results?.filter(result=>result.offerId===member.offerId)??[];
    const stocks=stockJobs.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    const e=eJobs.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    const readbacks=eResults.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    if(results.length>1||stocks.length>1||e.length>1||
        new Set(readbacks.map(value=>value.readbackId)).size!==readbacks.length||
        readbacks.length>1&&e[0]?.schemaVersion!=='d-batch-e-job-v2')
      throw new Error('D_BATCH_VIEW_MEMBER_RESULT_NOT_UNIQUE');
    const result=results[0]??null,stock=stocks[0]??null;
    const readback=e[0]?.resultId?readbacks.find(value=>value.readbackId===e[0].resultId)??null:null;
    if((stock||readback)&&result?.classification!=='imported'||e[0]?.resultId&&!readback||
        readbacks.length&&(!e[0]||!readback||readbacks.some(value=>
          value.sourceRecordId!==e[0].recordId||value.candidateId!==member.candidateId)))
      throw new Error('D_BATCH_VIEW_RESULT_SOURCE_CONFLICT');
    const mediaReview=batch.schemaVersion==='d-batch-production-authorization-v3'&&readback
      ?projectDBatchEMediaReview({document,batchId,candidateId:member.candidateId}):null;
    const verification=batch.schemaVersion==='d-batch-production-authorization-v3'&&readback
      ?projectDBatchEVerification({document,batchId,candidateId:member.candidateId}):null;
    return {candidateId:member.candidateId,skuPackageId:member.skuPackageId,
      offerId:member.offerId,memberStatus:member.status,
      assetStatus:asset.assetStatus,assetReason:asset.assetReason,
      chunkIndex:chunk?.index??null,taskId:chunk?.taskId??null,
      productId:result?.importObservation?.productId??null,
      importStatus:result?.classification??chunk?.status??'not_started',
      importGapCode:result?.gapCode??chunk?.prewriteReasonCode??chunk?.lastObservationFailure??chunk?.stopReason??null,
      inventoryAction:batch.postImportScope?.inventoryAction??null,
      inventoryStatus:stock?.status??'not_started',
      inventoryReason:stock?.ownerReason??stock?.unknownReason??stock?.failureReason??null,
      eStatus:verification?.listedVerified?'listed_verified':mediaReview?.status==='awaiting_owner_review'?'awaiting_owner_media_review':e[0]&&['queued','read_in_flight','observed_pending','read_failed','observation_stopped'].includes(e[0].status)
        ?e[0].status:readback?.status??e[0]?.status??'not_started',
      eStopReason:e[0]?.status==='observation_stopped'?e[0].stopReason:null,
      eGaps:verification?.gaps??readback?.gaps??[],listedVerified:verification?.listedVerified??false,
      mediaReview,verification:verification?.verification??null};
  });
  return Object.freeze({schemaVersion:'d-batch-execution-view-v1',batchId,
    status:batch.status,externalRequestState:batch.externalRequestState,
    assetRequestTransmission:assetRequestAttempted?'attempted_or_unknown':'not_attempted',
    inSaleList:{status:listJob?.status??(listStops.length?'blocked':'not_started'),
      requestCount:listJob?.requestCount??0,maxRequests:batch.postImportScope?.inSaleList?.policy?.maxPages??0,
      stopReason:listJob?.stopReason??listStops[0]?.reason??null},
    excludedOfferIds:clone(batch.excludedOfferIds),members:clone(members)});
}
