import { isDeepStrictEqual } from 'node:util';
import { createLinkfoxDiscoveryConnector, assertLinkfoxDiscoveryBinding } from './linkfox-discovery-connector.mjs';
import { createLinkfoxProductDetailConnector, assertLinkfoxProductDetailBinding } from './linkfox-product-detail-connector.mjs';
import { LinkfoxDiscoveryError } from './linkfox-discovery-api.mjs';
import { A_DISCOVERY_JOB_TYPE, A_DISCOVERY_FAILURE_CLASSES, ADiscoveryError, assertADiscoveryScope, assertADiscoveryReceipt } from './a-discovery-contract.mjs';
import { A_PRODUCT_DETAIL_JOB_TYPE, A_PRODUCT_DETAIL_FAILURE_CLASSES, AProductDetailError, assertAProductDetailScope, assertAProductDetailReceipt } from './a-product-detail-contract.mjs';
import { ADiscoveryExecutionBlockedError, AProductDetailExecutionBlockedError } from './software-job-repository.mjs';

// Only these two versioned protocols may use the shared single-request lifecycle.
// URLs, parsers, scope validators and settlement hooks cannot come from external configuration.
const protocols=Object.freeze({
 discovery:{jobType:A_DISCOVERY_JOB_TYPE,collection:'aDiscoveryReceipts',receiptVersion:'a-discovery-receipt-v1',receiptPrefix:'a-discovery-receipt',
  assertBinding:assertLinkfoxDiscoveryBinding,assertScope:assertADiscoveryScope,assertReceipt:assertADiscoveryReceipt,ErrorType:ADiscoveryError,
  BlockedError:ADiscoveryExecutionBlockedError,failureClasses:A_DISCOVERY_FAILURE_CLASSES,createConnector:createLinkfoxDiscoveryConnector,method:'search',
  guard:'assertADiscoveryExecutionInDocument',settle:'settleADiscoveryInDocument'},
 detail:{jobType:A_PRODUCT_DETAIL_JOB_TYPE,collection:'aProductDetailReceipts',receiptVersion:'a-product-detail-receipt-v1',receiptPrefix:'a-product-detail-receipt',
  assertBinding:assertLinkfoxProductDetailBinding,assertScope:assertAProductDetailScope,assertReceipt:assertAProductDetailReceipt,ErrorType:AProductDetailError,
  BlockedError:AProductDetailExecutionBlockedError,failureClasses:A_PRODUCT_DETAIL_FAILURE_CLASSES,createConnector:createLinkfoxProductDetailConnector,method:'read',
  guard:'assertAProductDetailExecutionInDocument',settle:'settleAProductDetailInDocument'}
});
const clone=value=>structuredClone(value);
const terminal=job=>['completed','failed','unknown_outcome'].includes(job.status);
function receiptCollection(document,protocol){
  const value=document.runtime[protocol.collection];
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('LINKFOX_READ_RECEIPT_COLLECTION_INVALID');
  return value;
}
function heldJob(document,jobId,workerId,leaseId,protocol){
  const job=document.runtime.softwareJobs.find(value=>value.jobId===jobId);
  if(!job||job.jobType!==protocol.jobType||job.workerId!==workerId||job.leaseId!==leaseId)throw new Error('LINKFOX_READ_HOLDER_CONFLICT');
  protocol.assertScope(job.scopeBinding,job);return job;
}

/** One explicitly saved job owns one connector instance and at most one HTTP request. */
export async function runLinkfoxReadSoftwareJob({kind,repository,softwareJobStore,worker,jobId,leaseId,leaseDurationMs,
  connectorBinding,readSecret,fetchImpl,serverClock,signal=null}){
  if(!Object.hasOwn(protocols,kind))throw new TypeError('LINKFOX_READ_JOB_KIND_INVALID');
  const protocol=protocols[kind];
  const {assertReceipt,assertScope,ErrorType,BlockedError,failureClasses}=protocol;
  if(typeof repository?.transact!=='function'||typeof serverClock!=='function'||typeof readSecret!=='function'||typeof fetchImpl!=='function')throw new TypeError('LINKFOX_READ_RUNNER_DEPENDENCY_INVALID');
  const binding=protocol.assertBinding(connectorBinding),queued=await softwareJobStore.get(jobId);
  if(!queued||queued.jobType!==protocol.jobType)throw new ErrorType('JOB_SOURCE_CONFLICT');
  const scope=assertScope(queued.scopeBinding,queued);
  if(!['bindingId','configurationVersion','credentialAlias','budgetPolicyRef'].every(key=>scope[key]===binding[key]))throw new ErrorType('BINDING_INVALID');
  if(queued.status!=='queued')return {status:'idempotent_replay',jobId,executionStatus:queued.status};
  const claimed=await softwareJobStore.claim({jobId,worker,leaseId,leaseDurationMs});
  let attempted=false,responseReceived=false,hasUnexpectedContinuationError=false,unexpectedContinuationError;
  await repository.transact(document=>{
    const job=heldJob(document,jobId,worker.workerId,leaseId,protocol),receipts=receiptCollection(document,protocol),at=serverClock();
    if(Object.hasOwn(receipts,jobId))throw new Error('LINKFOX_READ_RECEIPT_ALREADY_EXISTS');
    receipts[jobId]=assertReceipt({schemaVersion:protocol.receiptVersion,receiptId:`${protocol.receiptPrefix}:${jobId}`,
      jobId,scope:clone(scope),workerId:worker.workerId,leaseId,startedAt:at,completedAt:null,status:'in_flight',failureClass:null,
      steps:[{method:scope.request.method,intentAt:at,sentAt:null,completedAt:null,externalRequestState:'not_sent',requestTransmission:'not_attempted',result:null,errorCode:null}]},job);
    return {changed:true,document,result:null};
  });
  async function guard(markRequestSent=false,transmission=null){
    return repository.transact(document=>{
      if(signal?.aborted)throw new ErrorType('CANCELLED');
      const observedAt=serverClock();
      const checked=softwareJobStore[protocol.guard]({document,jobId,workerId:worker.workerId,leaseId,observedAt,markRequestSent});
      if(markRequestSent||transmission!==null){
        const receipt=receiptCollection(document,protocol)[jobId],step=receipt.steps[0];
        if(receipt.status!=='in_flight'||step.completedAt!==null)throw new Error('LINKFOX_READ_RECEIPT_NOT_ACTIVE');
        if(markRequestSent){
          if(step.sentAt!==null)throw new Error('LINKFOX_READ_SEND_ALREADY_STARTED');
          step.sentAt=observedAt;step.externalRequestState='in_flight';step.requestTransmission='unknown';
        }
        if(transmission!==null)step.requestTransmission=transmission;
        assertReceipt(receipt,checked.job);
      }
      return {changed:markRequestSent||transmission!==null,...(markRequestSent||transmission!==null?{document}:{}),result:checked};
    });
  }
  async function finish({result=null,failureClass=null}){
    return repository.transact(document=>{
      const job=heldJob(document,jobId,worker.workerId,leaseId,protocol),receipts=receiptCollection(document,protocol),saved=receipts[jobId];
      if(terminal(job)){
        if(result!==null&&job.status==='unknown_outcome'){
          const receipt=assertReceipt(saved,job);
          if(receipt.status!=='unknown_outcome'||receipt.steps[0]?.sentAt===null)throw new Error('LINKFOX_READ_LATE_RESULT_SOURCE_CONFLICT');
          if(Object.hasOwn(receipt,'lateResult')){
            if(!isDeepStrictEqual(receipt.lateResult.result,result))throw new Error('LINKFOX_READ_LATE_RESULT_CONFLICT');
            return {changed:false,result:{status:'idempotent_replay',jobId,executionStatus:job.status,lateMaterialSaved:true}};
          }
          receipt.lateResult={recordedAt:serverClock(),result:clone(result)};
          receipts[jobId]=assertReceipt(receipt,job);
          return {changed:true,document,result:{status:'idempotent_replay',jobId,executionStatus:job.status,lateMaterialSaved:true}};
        }
        return {changed:false,result:{status:'idempotent_replay',jobId,executionStatus:job.status}};
      }
      const receipt=assertReceipt(saved,job),step=receipt.steps[0],at=serverClock();
      receipt.completedAt=at;step.completedAt=at;
      if(result!==null){receipt.status='completed';step.result=result;step.externalRequestState='succeeded';step.requestTransmission='response_received';}
      else{
        receipt.failureClass=failureClass;step.errorCode=failureClass;
        const issued=step.sentAt!==null;
        step.externalRequestState=!issued?'not_sent':responseReceived?'failed':'unknown_outcome';
        step.requestTransmission=!issued?'not_attempted':responseReceived?'response_received':attempted?'attempted':'unknown';
        receipt.status=step.externalRequestState==='unknown_outcome'?'unknown_outcome':'failed';
      }
      receipts[jobId]=assertReceipt(receipt,job);
      const settled=softwareJobStore[protocol.settle]({document,jobId,workerId:worker.workerId,leaseId,observedAt:at});
      if(Object.hasOwn(settled,'unexpectedContinuationError')){
        hasUnexpectedContinuationError=true;unexpectedContinuationError=settled.unexpectedContinuationError;
      }
      return {changed:true,document,result:{status:settled.job.status,jobId,job:clone(settled.job),receipt:clone(receipt),
        nextJobId:settled.nextJob?.jobId??null,continuationBlocked:settled.continuationBlocked,continuationBlocker:settled.continuationBlocker??null,
        externalRequests:attempted?1:0,platformWrites:0}};
    });
  }
  let outcome;
  try{
    const now=Date.parse(serverClock());
    if(now>=Date.parse(scope.expiresAt))throw new ErrorType('AUTHORIZATION_EXPIRED');
    if(now>=Date.parse(claimed.leaseExpiresAt))throw new ErrorType('LEASE_EXPIRED');
    const timeoutMs=Math.min(binding.timeoutMs,Date.parse(scope.expiresAt)-now,Date.parse(claimed.leaseExpiresAt)-now);
    const connector=protocol.createConnector({binding:{...binding,timeoutMs},signal,serverClock,
      readSecret:async request=>{await guard();return readSecret(request);},
      beforeRequestSend:async facts=>{
        if(!isDeepStrictEqual(facts,{requestId:scope.request.requestId,method:scope.request.method,bindingId:binding.bindingId,
          configurationVersion:binding.configurationVersion,budgetPolicyRef:binding.budgetPolicyRef}))throw new Error('LINKFOX_READ_TRANSPORT_SCOPE_CONFLICT');
        await guard(true);
      },fetchImpl:async(...args)=>{
        await guard(false,'attempted');
        if(args[1].signal.aborted)throw args[1].signal.reason;
        attempted=true;const response=await fetchImpl(...args);responseReceived=true;return response;
      }});
    const result=await connector[protocol.method](scope.request);
    outcome=await finish({result});
  }catch(error){
    const cancelled=signal?.aborted&&error===signal.reason;
    const typed=error instanceof LinkfoxDiscoveryError||error instanceof BlockedError||
      error instanceof ErrorType&&['CANCELLED','LEASE_EXPIRED','AUTHORIZATION_EXPIRED'].includes(error.code);
    const classified=error instanceof BlockedError?error.failureClass:typed?error.code:null;
    const code=cancelled?'CANCELLED':typed&&failureClasses.includes(classified)?classified:'UNEXPECTED_SYSTEM_ERROR';
    outcome=await finish({failureClass:code});
    if(code==='UNEXPECTED_SYSTEM_ERROR')throw error;
  }
  if(hasUnexpectedContinuationError)throw unexpectedContinuationError;
  return outcome;
}
