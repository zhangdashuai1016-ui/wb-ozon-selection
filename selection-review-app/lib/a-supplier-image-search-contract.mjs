import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef, isCanonicalStableHttpsAssetRef, CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { validateSalesSnapshot } from './sales-snapshot.mjs';
import { ADiscoveryError, assertADiscoveryReceipt, readADiscoveryMarketResult } from './a-discovery-contract.mjs';
export const A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE='a_supplier_image_search';
export const A_SUPPLIER_IMAGE_SEARCH_CAPABILITY='1688-image-search-browser';
export const A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES=Object.freeze(['ALREADY_ATTEMPTED','CANDIDATE_CHANGED','SOURCE_INVALID','AUTHORIZATION_INVALID','AUTHORIZATION_EXPIRED','CREDENTIAL_BINDING_INVALID','LEASE_EXPIRED','CANCELLED','PAGE_CONTRACT_UNCONFIGURED','LOGIN_REQUIRED','VERIFICATION_REQUIRED','PLATFORM_PERMISSION_DENIED','NAVIGATION_REJECTED','RESPONSE_INVALID','NETWORK_ERROR','TIMEOUT','UNKNOWN_OUTCOME','UNEXPECTED_SYSTEM_ERROR']);
export class ASupplierImageSearchError extends Error {constructor(code){super(`A_SUPPLIER_IMAGE_SEARCH_${code}`);this.name='ASupplierImageSearchError';this.code=code;}}
const closed=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const check=(v,code)=>{if(!v)throw new ASupplierImageSearchError(code);};
const ref=v=>isCanonicalFrozenRef(v)&&!['unknown','null','undefined'].includes(v);
const time=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v);
const safeClone=v=>{assertSafeRuntimeRecord(v);return structuredClone(v);};
export function assertASupplierImageSearchScope(scope,job){
 check(closed(scope,['schemaVersion','candidateId','sourceRevision','resultRevision','targetPlatform','targetStore','imageSource','request','bindingId','configurationVersion','credentialAlias','authorizationRef','expiresAt'])&&scope.schemaVersion==='a-supplier-image-search-scope-v1'&&
 ['candidateId','bindingId','configurationVersion','credentialAlias','authorizationRef'].every(k=>ref(scope[k]))&&integer(scope.sourceRevision)&&scope.resultRevision===scope.sourceRevision&&scope.targetPlatform==='ozon'&&['miska','dandanshu'].includes(scope.targetStore)&&time(scope.expiresAt),'SCOPE_INVALID');
 const source=scope.imageSource;
 if(source?.kind==='sales_snapshot')check(closed(source,['kind','snapshotId','imageIndex','imageRef','sourceEvidenceRef'])&&ref(source.snapshotId)&&ref(source.sourceEvidenceRef)&&integer(source.imageIndex)&&source.imageIndex<20&&source.imageRef===`image:${source.snapshotId}:${source.imageIndex}`,'SOURCE_INVALID');
 else check(closed(source,['kind','marketReceiptRef','marketProductId','imageIndex','imageRef'])&&source.kind==='seerfar_market_product'&&ref(source.marketReceiptRef)&&id(source.marketProductId)&&source.imageIndex===0&&source.imageRef===`image:${source.marketReceiptRef}:${source.marketProductId}:0`,'SOURCE_INVALID');
 check(ref(source.imageRef)&&closed(scope.request,['requestId','method','maxSearches','maxResults'])&&ref(scope.request.requestId)&&scope.request.method==='image_search'&&scope.request.maxSearches===1&&scope.request.maxResults===4,'REQUEST_INVALID');
 if(job)check(job.schemaVersion==='software-job-v3'&&job.jobType===A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE&&closed(job.subject,['kind','candidateId','revision'])&&job.subject.kind==='a_candidate'&&job.subject.candidateId===scope.candidateId&&job.subject.revision===scope.sourceRevision&&job.revision===scope.sourceRevision&&!Object.hasOwn(job,'candidateId')&&!Object.hasOwn(job,'skuPackageId')&&isDeepStrictEqual(job.scopeBinding,scope),'JOB_SOURCE_CONFLICT');
 return safeClone(scope);
}
export function assertASupplierImageSearchCandidateEligible(candidate){
 check(candidate?.workflowStatus==='needs_user_data'&&candidate.eliminatedAt==null&&candidate.lifecycleV11==null&&candidate.bPassedAt==null&&candidate.cCompletedAt==null&&candidate.executionRuntime?.exceptionCase?.status!=='open'&&candidate.executionRuntime?.technicalFailure?.status!=='stopped','CANDIDATE_CHANGED');return candidate;
}
export function assertASupplierImageSearchCandidateSource(candidate,scope){
 assertASupplierImageSearchScope(scope);assertASupplierImageSearchCandidateEligible(candidate);
 check(candidate.id===scope.candidateId&&candidate.dataRevision===scope.sourceRevision&&candidate.targetPlatform===scope.targetPlatform&&candidate.targetStore===scope.targetStore,'CANDIDATE_CHANGED');return candidate;
}
export function assertASupplierImageSearchSource({document,candidate,scope}){
 assertASupplierImageSearchCandidateSource(candidate,scope);const source=scope.imageSource;let imageUrl,sourceEvidenceRef,sourceJob=null,sourceReceipt=null;
 if(source.kind==='sales_snapshot'){
  check(Array.isArray(candidate.salesSnapshotsV11),'SOURCE_INVALID');const rows=candidate.salesSnapshotsV11.filter(row=>row.snapshotId===source.snapshotId);
  check(rows.length===1&&rows[0].evidenceRef===source.sourceEvidenceRef&&time(rows[0].collectedAt)&&Array.isArray(rows[0].imageRefs),'SOURCE_INVALID');
  check(validateSalesSnapshot(rows[0]).valid&&rows[0].platform===scope.targetPlatform&&rows[0].collectorMode!=='mock_only','SOURCE_INVALID');
  imageUrl=rows[0].imageRefs[source.imageIndex];sourceEvidenceRef=source.sourceEvidenceRef;
 }else{
  const evidence=candidate.aDiscoveryEvidenceV2;check(evidence?.provider==='seerfar'&&evidence.marketReceiptRef===source.marketReceiptRef&&evidence.marketProductId===source.marketProductId&&Array.isArray(document?.runtime?.softwareJobs),'SOURCE_INVALID');
  const jobs=document.runtime.softwareJobs.filter(job=>`a-discovery-receipt:${job.jobId}`===source.marketReceiptRef);check(jobs.length===1,'SOURCE_INVALID');const job=jobs[0];
  let receipt;try{receipt=assertADiscoveryReceipt(document.runtime.aDiscoveryReceipts?.[job.jobId],job);}catch(error){if(error instanceof ADiscoveryError)throw new ASupplierImageSearchError('SOURCE_INVALID');throw error;}
  check(job.status==='completed'&&job.externalRequestState==='succeeded'&&receipt.status==='completed'&&receipt.scope.provider==='seerfar'&&receipt.scope.targetStore===scope.targetStore&&evidence.batchId===receipt.scope.batchId&&evidence.sourceRevision===receipt.scope.sourceRevision&&evidence.planId===receipt.scope.planId&&evidence.planVersion===receipt.scope.planVersion,'SOURCE_INVALID');
  const result=readADiscoveryMarketResult(receipt),products=result.products.filter(row=>row.productId===source.marketProductId);check(products.length===1,'SOURCE_INVALID');imageUrl=products[0].imageUrl;sourceEvidenceRef=source.marketReceiptRef;sourceJob=job;sourceReceipt=receipt;
 }
 check(isCanonicalStableHttpsAssetRef(imageUrl)&&!new RegExp(CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE).test(imageUrl),'SOURCE_INVALID');
 return {imageRef:source.imageRef,imageUrl,sourceEvidenceRef,sourceJob,sourceReceipt};
}
export function assertASupplierImageSearchResult(result,scope){
 assertASupplierImageSearchScope(scope);
 check(closed(result,['schemaVersion','provider','requestId','imageRef','observedAt','status','submissionEvidenceRef','completionEvidenceRef','products'])&&result.schemaVersion==='a-supplier-image-search-result-v1'&&result.provider==='1688_browser'&&result.requestId===scope.request.requestId&&result.imageRef===scope.imageSource.imageRef&&time(result.observedAt)&&ref(result.submissionEvidenceRef)&&ref(result.completionEvidenceRef)&&Array.isArray(result.products)&&result.products.length<=4&&['candidates_found','true_empty'].includes(result.status),'RESULT_INVALID');
 check(result.status==='true_empty'?result.products.length===0:result.products.length>0,'RESULT_INVALID');const ids=new Set();
 for(const row of result.products){check(closed(row,['offerId','sourceUrl','evidenceRef','sameSku','minimumOrderQuantity'])&&id(row.offerId)&&!ids.has(row.offerId)&&row.sourceUrl===`https://detail.1688.com/offer/${row.offerId}.html`&&ref(row.evidenceRef)&&row.sameSku==='unknown'&&row.minimumOrderQuantity===null,'RESULT_PRODUCT_INVALID');ids.add(row.offerId);}
 return safeClone(result);
}
export function assertASupplierImageSearchAuthorization(record) {
  check(closed(record,['schemaVersion','authorizationId','authorizationType','status','action','scopeBinding','authorizedByUserId','authorizedAt','expiresAt','maxUses','useCount','consumedByJobId','consumedAt'])&&
    record.schemaVersion==='software-job-authorization-record-v3'&&record.authorizationType==='a_supplier_image_search_once'&&record.status==='active'&&record.action===A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE&&
    ref(record.authorizationId)&&ref(record.authorizedByUserId)&&time(record.authorizedAt)&&time(record.expiresAt)&&Date.parse(record.authorizedAt)<Date.parse(record.expiresAt)&&
    record.maxUses===1&&[0,1].includes(record.useCount),'AUTHORIZATION_INVALID');
  const scope=assertASupplierImageSearchScope(record.scopeBinding);
  check(record.authorizationId===scope.authorizationRef&&record.expiresAt===scope.expiresAt&&
    (record.useCount===0?record.consumedByJobId===null&&record.consumedAt===null:ref(record.consumedByJobId)&&time(record.consumedAt)&&
      Date.parse(record.consumedAt)>=Date.parse(record.authorizedAt)&&Date.parse(record.consumedAt)<Date.parse(record.expiresAt)),'AUTHORIZATION_INVALID');
  return safeClone(record);
}
export function assertASupplierImageSearchCredential(record) {
  check(closed(record,['schemaVersion','bindingId','credentialAlias','status','provider','sideEffectScope','scopeBinding','allowedWorkerIds','redaction','boundAt','expiresAt'])&&
    record.schemaVersion==='software-job-credential-binding-v3'&&record.status==='active'&&record.provider==='1688_browser'&&record.sideEffectScope===A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE&&
    ref(record.bindingId)&&record.redaction==='credential_alias_only'&&time(record.boundAt)&&time(record.expiresAt)&&Date.parse(record.boundAt)<Date.parse(record.expiresAt)&&
    Array.isArray(record.allowedWorkerIds)&&record.allowedWorkerIds.length===1&&record.allowedWorkerIds.every(ref),'CREDENTIAL_BINDING_INVALID');
  const scope=assertASupplierImageSearchScope(record.scopeBinding);
  check(record.bindingId===scope.bindingId&&record.credentialAlias===scope.credentialAlias&&record.expiresAt===scope.expiresAt,'CREDENTIAL_BINDING_INVALID');return safeClone(record);
}
export function assertASupplierImageSearchReceipt(receipt,job) {
  check(closed(receipt,['schemaVersion','receiptId','jobId','scope','workerId','leaseId','startedAt','completedAt','status','failureClass','steps',...(Object.hasOwn(receipt??{},'lateResult')?['lateResult']:[])])&&
    receipt.schemaVersion==='a-supplier-image-search-receipt-v1'&&['receiptId','jobId','workerId','leaseId'].every(k=>ref(receipt[k]))&&time(receipt.startedAt)&&
    ['in_flight','completed','failed','unknown_outcome'].includes(receipt.status)&&Array.isArray(receipt.steps)&&receipt.steps.length<=1,'RECEIPT_INVALID');
  assertASupplierImageSearchScope(receipt.scope,job);
  check(receipt.receiptId===`a-supplier-image-search-receipt:${receipt.jobId}`,'RECEIPT_SOURCE_CONFLICT');
  if(job)check(receipt.jobId===job.jobId&&receipt.workerId===job.workerId&&receipt.leaseId===job.leaseId,'RECEIPT_SOURCE_CONFLICT');
  const step=receipt.steps[0];
  if(step){
    check(closed(step,['method','intentAt','sentAt','completedAt','externalRequestState','requestTransmission','result','errorCode'])&&
      step.method===receipt.scope.request.method&&time(step.intentAt)&&Date.parse(step.intentAt)>=Date.parse(receipt.startedAt)&&
      ['not_sent','in_flight','succeeded','failed','unknown_outcome'].includes(step.externalRequestState)&&
      ['not_attempted','attempted','response_received','unknown'].includes(step.requestTransmission),'STEP_INVALID');
    check(step.sentAt===null?step.externalRequestState==='not_sent'&&step.requestTransmission==='not_attempted':
      time(step.sentAt)&&Date.parse(step.sentAt)>=Date.parse(step.intentAt)&&Date.parse(step.sentAt)<Date.parse(receipt.scope.expiresAt)&&
      (!job||Date.parse(step.sentAt)<Date.parse(job.leaseExpiresAt))&&step.externalRequestState!=='not_sent'&&step.requestTransmission!=='not_attempted','STEP_TRANSMISSION_INVALID');
    check(step.completedAt===null||time(step.completedAt)&&Date.parse(step.completedAt)>=Date.parse(step.sentAt??step.intentAt),'STEP_TIME_INVALID');
    check(step.errorCode===null||A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(step.errorCode),'STEP_INVALID');
    if(step.result!==null){assertASupplierImageSearchResult(step.result,receipt.scope);check(step.externalRequestState==='succeeded'&&step.requestTransmission==='response_received'&&
      step.errorCode===null&&step.completedAt!==null&&Date.parse(step.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(step.result.observedAt)<=Date.parse(step.completedAt),'STEP_RESULT_INVALID');}
  }
  if(step){check(step.externalRequestState==='succeeded'?step.result!==null:step.result===null,'STEP_RESULT_INVALID');
    check(step.externalRequestState==='in_flight'?step.completedAt===null&&step.errorCode===null:true,'STEP_INVALID');}
  if(receipt.status==='in_flight')check(receipt.completedAt===null&&receipt.failureClass===null,'RECEIPT_INVALID');
  else {
    check(time(receipt.completedAt)&&Date.parse(receipt.completedAt)>=Date.parse(receipt.startedAt)&&(!step||step.completedAt!==null&&Date.parse(receipt.completedAt)>=Date.parse(step.completedAt)),'RECEIPT_TIME_INVALID');
    if(receipt.status==='completed')check(step?.result!==null&&step?.result!==undefined&&receipt.failureClass===null,'RECEIPT_RESULT_INVALID');
    else check(A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(receipt.failureClass)&&(!step||step.result===null&&step.errorCode===receipt.failureClass),'RECEIPT_FAILURE_INVALID');
    check(receipt.status==='unknown_outcome'?step?.externalRequestState==='unknown_outcome':!step||!['in_flight','unknown_outcome'].includes(step.externalRequestState),'RECEIPT_OUTCOME_CONFLICT');
  }
  if(Object.hasOwn(receipt,'lateResult')){
    const late=receipt.lateResult;
    check(receipt.status==='unknown_outcome'&&step?.sentAt!==null&&step?.sentAt!==undefined&&
      closed(late,['recordedAt','result'])&&time(late.recordedAt)&&Date.parse(late.recordedAt)>=Date.parse(receipt.completedAt),'LATE_RESULT_INVALID');
    assertASupplierImageSearchResult(late.result,receipt.scope);
    check(Date.parse(late.result.observedAt)>=Date.parse(step.sentAt)&&Date.parse(late.result.observedAt)<=Date.parse(late.recordedAt),'LATE_RESULT_INVALID');
  }
  return safeClone(receipt);
}
export function readASupplierImageSearchTerminal(receipt,job) {
  assertASupplierImageSearchReceipt(receipt,job);check(receipt.status!=='in_flight','RECEIPT_NOT_TERMINAL');
  return {status:receipt.status,externalRequestState:receipt.steps[0]?.externalRequestState??'not_sent',failureClass:receipt.failureClass};
}
export function interruptASupplierImageSearchReceipt(receipt,job,completedAt,failureClass) {
  const next=assertASupplierImageSearchReceipt(receipt,job);check(next.status==='in_flight'&&time(completedAt)&&A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(failureClass),'RECEIPT_INTERRUPTION_INVALID');
  const step=next.steps[0];if(step){step.completedAt=completedAt;step.errorCode=failureClass;if(step.externalRequestState==='in_flight')step.externalRequestState='unknown_outcome';}
  next.completedAt=completedAt;next.failureClass=failureClass;next.status=step?.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
  return assertASupplierImageSearchReceipt(next,job);
}

export function nextASupplierImageSearchRequest({candidate,scope,receipts}){
 assertASupplierImageSearchCandidateSource(candidate,scope);check(Array.isArray(receipts)&&receipts.length<=1,'SEQUENCE_INVALID');
 if(receipts.length){const receipt=assertASupplierImageSearchReceipt(receipts[0]);check(isDeepStrictEqual(receipt.scope,scope),'SEQUENCE_INVALID');return null;}return structuredClone(scope.request);
}
export function assertASupplierImageSearchAdmission({document,candidate,scope,authorization,receipts,checkedAt}){
 assertASupplierImageSearchSource({document,candidate,scope});assertASupplierImageSearchAuthorization(authorization);
 check(time(checkedAt)&&Date.parse(checkedAt)>=Date.parse(authorization.authorizedAt)&&Date.parse(checkedAt)<Date.parse(scope.expiresAt),'AUTHORIZATION_EXPIRED');
 check(isDeepStrictEqual(authorization.scopeBinding,scope),'AUTHORIZATION_INVALID');check(isDeepStrictEqual(nextASupplierImageSearchRequest({candidate,scope,receipts}),scope.request),'SEQUENCE_INVALID');return true;
}
