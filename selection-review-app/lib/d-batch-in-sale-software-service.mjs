import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {assertBusinessStateRepositoryBoundary,assertCentralPersistenceBoundary} from './business-state-repository.mjs';
import {assertSafeRuntimeRecord} from './runtime-identity.mjs';
import {OzonDEPreflightEvidenceError} from './ozon-de-preflight-provider.mjs';
import {OzonDEHttpTransportError} from './ozon-de-http-configuration.mjs';
import {createStoreIsolatedOzonSellerApiDEAdapter} from './ozon-seller-api-de-adapter.mjs';
import {createInSaleListJob,assertInSaleListJob,beginInSaleListPage,
  markInSaleListPageSending,buildInSaleListPageQuery,applyInSaleListPageResult,
  stopInSaleListJob} from './ozon-in-sale-list-observation.mjs';

const clone=value=>structuredClone(value);
const terminal=job=>['matched','stopped','failed'].includes(job.status);
const boundaryFailures=new Set(['D_BATCH_IN_SALE_SOURCE_CHANGED','D_BATCH_IN_SALE_WORKER_NOT_CURRENT',
  'D_BATCH_IN_SALE_LEASE_EXPIRED','D_BATCH_IN_SALE_PERMISSION_CHANGED',
  'D_BATCH_SERVICE_MEMBER_CHANGED','D_BATCH_STOCK_SCOPE_CHANGED','D_BATCH_STOCK_MEMBER_CHANGED',
  'D_BATCH_STOCK_IMPORT_SOURCE_CHANGED','D_BATCH_SERVICE_BINDING_NOT_REGISTERED']);
const invalidPlatformResponse=new Set(['OZON_IN_SALE_LIST_RESPONSE_INVALID',
  'OZON_IN_SALE_LIST_RESPONSE_IDENTITY_INVALID','OZON_IN_SALE_LIST_RESPONSE_IDENTITY_CONFLICT',
  'OZON_IN_SALE_LIST_RESPONSE_DUPLICATE_IDENTITY']);
const unavailablePermission=new Set(['OZON_DE_PREFLIGHT_EVIDENCE_IN_SALE_SOURCE_UNAVAILABLE',
  'OZON_DE_PREFLIGHT_EVIDENCE_IN_SALE_METHOD_NOT_GRANTED','OZON_DE_PREFLIGHT_EVIDENCE_IN_SALE_PERMISSION_NOT_CURRENT',
  'OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED']);
function failureCode(error,signal){
  if(signal?.aborted&&error instanceof OzonDEHttpTransportError&&
      ['OZON_DE_HTTP_CANCELLED','OZON_DE_HTTP_TIMEOUT'].includes(error.code))return 'request_timeout';
  if(error instanceof OzonDEHttpTransportError&&error.cause instanceof Error)
    return failureCode(error.cause,signal);
  if(signal?.aborted&&error===signal.reason)return 'request_timeout';
  if(error instanceof OzonDEPreflightEvidenceError)
    return unavailablePermission.has(error.code)?'permission_unavailable':null;
  if(error instanceof OzonDEHttpTransportError&&!error.cause)return 'transport_failure';
  if(error?.constructor===Error&&invalidPlatformResponse.has(error.message))return 'platform_data_invalid';
  if(error?.constructor===Error&&error.message==='OZON_IN_SALE_LIST_DEADLINE_EXPIRED')return 'deadline_exhausted';
  if(error?.constructor!==Error||!boundaryFailures.has(error.message))return null;
  if(error.message==='D_BATCH_IN_SALE_WORKER_NOT_CURRENT')return 'worker_not_current';
  if(error.message==='D_BATCH_IN_SALE_LEASE_EXPIRED')return 'lease_expired';
  if(error.message==='D_BATCH_IN_SALE_PERMISSION_CHANGED')return 'permission_unavailable';
  return 'source_changed';
}
function jobsOf(document){
  const jobs=document.runtime?.dBatchInSaleJobs??[];
  if(!Array.isArray(jobs))throw new Error('D_BATCH_IN_SALE_STORE_INVALID');
  return jobs;
}
function uniqueBatch(document,batchId){
  const batches=document.runtime?.dProductionBatches?.filter(value=>value.batchId===batchId)??[];
  if(batches.length!==1)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
  return batches[0];
}

/** One page per existing batch-pump pass. No private timer, automatic retry or new queue. */
export function createDBatchInSaleSoftwareService({repository,runtimeMode,workerRegistry,serverClock,
  resolveSource,loadEvidence,requestJson}){
  assertBusinessStateRepositoryBoundary(repository);
  if(['central_test','central_production'].includes(runtimeMode))assertCentralPersistenceBoundary(repository);
  if([serverClock,resolveSource,requestJson].some(value=>typeof value!=='function')||
      loadEvidence!==null&&typeof loadEvidence!=='function')throw new Error('D_BATCH_IN_SALE_DEPENDENCY_INVALID');
  function assertWorker(job){
    const worker=workerRegistry.findEligible(['ozon-independent-readback'])
      .find(value=>value.workerId===job.workerId);
    if(!worker||worker.version!==job.workerVersion)throw new Error('D_BATCH_IN_SALE_WORKER_NOT_CURRENT');
  }
  function currentSource(document,job){
    const source=resolveSource(document,uniqueBatch(document,job.scope.batchId));
    const {accountEvidenceRef,...scope}=job.scope;
    if(!source||!isDeepStrictEqual(source.scope,scope)||!isDeepStrictEqual(source.policy,job.policy)||
        source.workerId!==job.workerId||source.workerVersion!==job.workerVersion||!accountEvidenceRef)
      throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
    return source;
  }
  async function saveTransition(job,transition,{checkSource=true}={}){
    return repository.transact(document=>{
      const jobs=jobsOf(document),matches=jobs.filter(value=>value.jobId===job.jobId);
      if(matches.length!==1)throw new Error('D_BATCH_IN_SALE_JOB_MISSING');
      if(!isDeepStrictEqual(matches[0],job))return {changed:false,result:null};
      if(checkSource)currentSource(document,job);
      const next=transition(matches[0]);
      jobs[jobs.indexOf(matches[0])]=next;document.runtime.dBatchInSaleJobs=jobs;
      return {changed:true,document,result:clone(next)};
    });
  }
  async function stop(job,reason,error=null){
    const transmission=error instanceof OzonDEHttpTransportError
      ?({not_attempted:'not_attempted',attempted:'possibly_sent',response_received:'response_received'})[error.requestTransmission]
      :invalidPlatformResponse.has(error?.message)?'response_received':null;
    if(error instanceof OzonDEHttpTransportError&&transmission===undefined)
      throw new Error('D_BATCH_IN_SALE_TRANSMISSION_INVALID');
    return saveTransition(job,held=>stopInSaleListJob({job:held,workerId:job.workerId,
      leaseId:job.leaseId,at:serverClock(),reason,
      requestTransmission:held.status==='page_in_flight'?(transmission??held.attempts.at(-1).requestTransmission):null}),{checkSource:false});
  }
  async function admissionStop(batchId,error){
    const code=failureCode(error),reason=code??'system_failure';
    const result=await repository.transact(document=>{
      uniqueBatch(document,batchId);
      const stops=document.runtime.dBatchInSaleAdmissionStops??[];
      if(!Array.isArray(stops))throw new Error('D_BATCH_IN_SALE_STORE_INVALID');
      const prior=stops.filter(value=>value.batchId===batchId);
      if(prior.length>1)throw new Error('D_BATCH_IN_SALE_STOP_NOT_UNIQUE');
      if(prior.length===1)return {changed:false,result:clone(prior[0])};
      const record={schemaVersion:'d-batch-in-sale-admission-stop-v1',batchId,
        reason,requestTransmission:'not_attempted',stoppedAt:serverClock()};
      assertSafeRuntimeRecord(record,'dBatchInSaleAdmissionStop');
      document.runtime.dBatchInSaleAdmissionStops=[...stops,record];
      return {changed:true,document,result:record};
    });
    if(code===null)throw error;
    return {status:'in_sale_read_stopped',result};
  }
  async function admit(snapshot,batch){
    const source=resolveSource(snapshot,batch);
    if(source===null)return null;
    if(loadEvidence===null)throw new OzonDEPreflightEvidenceError('IN_SALE_SOURCE_UNAVAILABLE');
    const evidence=await loadEvidence(source.evidenceInput);
    const accountEvidenceRef=evidence.capabilities?.inSaleListObservation?.evidenceRef;
    if(typeof accountEvidenceRef!=='string'||!accountEvidenceRef)
      throw new OzonDEPreflightEvidenceError('IN_SALE_METHOD_NOT_GRANTED');
    const createdAt=serverClock(),scope={...clone(source.scope),accountEvidenceRef};
    const job=createInSaleListJob({scope,policy:source.policy,workerId:source.workerId,
      workerVersion:source.workerVersion,leaseId:`lease:${randomUUID()}`,
      leaseExpiresAt:new Date(Date.parse(createdAt)+source.policy.durationMs).toISOString(),createdAt});
    assertWorker(job);
    return repository.transact(document=>{
      const jobs=jobsOf(document),prior=jobs.filter(value=>value.scope.batchId===batch.batchId);
      if(prior.length>1)throw new Error('D_BATCH_IN_SALE_JOB_NOT_UNIQUE');
      if(prior.length===1)return {changed:false,result:null};
      if((document.runtime.dBatchInSaleAdmissionStops??[]).some(value=>value.batchId===batch.batchId))
        return {changed:false,result:null};
      currentSource(document,job);
      document.runtime.dBatchInSaleJobs=[...jobs,job];
      return {changed:true,document,result:clone(job)};
    });
  }
  async function readPage(job){
    if(Date.parse(serverClock())>=Date.parse(job.deadlineAt)||
        Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)){
      return {status:'in_sale_read_stopped',job:await stop(job,'deadline_exhausted')};
    }
    const controller=new AbortController();
    const timeout=Math.min(job.policy.requestTimeoutMs,Date.parse(job.deadlineAt)-Date.parse(serverClock()),
      Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()));
    const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_IN_SALE_REQUEST_TIMEOUT')),Math.max(1,timeout));
    try{
      assertWorker(job);
      const next=await saveTransition(job,held=>beginInSaleListPage({job:held,workerId:job.workerId,
        leaseId:job.leaseId,at:serverClock()}));
      if(next===null)return {status:'idle'};
      job=next;
      const query=buildInSaleListPageQuery(job);
      const source=currentSource(await repository.readSnapshot(),job);
      const ready=await loadEvidence(source.evidenceInput);
      if(ready.capabilities?.inSaleListObservation?.evidenceRef!==job.scope.accountEvidenceRef)
        throw new Error('D_BATCH_IN_SALE_PERMISSION_CHANGED');
      const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson,serverClock,
        adapterCapabilities:{...clone(ready.capabilities),status:'ready',
          inventoryWrite:{warehouseId:job.scope.warehouseId,prerequisitePolicy:null}}});
      const beforeRequestSend=async()=>{
        if(controller.signal.aborted)throw controller.signal.reason;
        assertWorker(job);
        if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)||
            Date.parse(serverClock())>=Date.parse(job.deadlineAt))throw new Error('D_BATCH_IN_SALE_LEASE_EXPIRED');
        const current=await repository.readSnapshot(),source=currentSource(current,job);
        const latest=await loadEvidence(source.evidenceInput);
        if(latest.capabilities?.inSaleListObservation?.evidenceRef!==job.scope.accountEvidenceRef)
          throw new Error('D_BATCH_IN_SALE_PERMISSION_CHANGED');
        if(controller.signal.aborted)throw controller.signal.reason;
        const marked=await saveTransition(job,held=>markInSaleListPageSending({job:held,
          workerId:job.workerId,leaseId:job.leaseId,at:serverClock()}));
        if(marked===null)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
        job=marked;
      };
      const result=await adapter.readInSaleListPage(query,{signal:controller.signal,beforeRequestSend});
      const saved=await saveTransition(job,held=>applyInSaleListPageResult({job:held,result,
        workerId:job.workerId,leaseId:job.leaseId,at:serverClock()}));
      return saved===null?{status:'in_sale_receipt_superseded'}:{status:saved.status,job:saved};
    }catch(error){
      const code=failureCode(error,controller.signal),reason=code??'system_failure';
      let saved;
      try{saved=await stop(job,reason,error);}
      catch(checkpointError){throw new AggregateError([error,checkpointError],'D_BATCH_IN_SALE_FAILURE_CHECKPOINT_FAILED');}
      if(code===null)throw error;
      return {status:'in_sale_read_stopped',job:saved};
    }finally{clearTimeout(timer);}
  }
  let active=null;
  return Object.freeze({async runDue({snapshot}){
    if(active)return active;
    active=(async()=>{
      for(const batch of snapshot.runtime?.dProductionBatches??[]){
        if(batch.schemaVersion!=='d-batch-production-authorization-v3')continue;
        const stops=snapshot.runtime?.dBatchInSaleAdmissionStops??[];
        if(!Array.isArray(stops))throw new Error('D_BATCH_IN_SALE_STORE_INVALID');
        if(stops.some(value=>value.batchId===batch.batchId))continue;
        const prior=jobsOf(snapshot).filter(value=>value.scope.batchId===batch.batchId);
        if(prior.length>1)throw new Error('D_BATCH_IN_SALE_JOB_NOT_UNIQUE');
        let job=prior[0];
        if(job){
          assertInSaleListJob(job);
          if(terminal(job))continue;
          if(job.status==='page_in_flight'){
            if(Date.parse(serverClock())<Date.parse(job.leaseExpiresAt)&&
                Date.parse(serverClock())<Date.parse(job.deadlineAt))continue;
            return {status:'in_sale_read_stopped',job:await stop(job,'read_interrupted')};
          }
        }else{
          try{job=await admit(snapshot,batch);}
          catch(error){return admissionStop(batch.batchId,error);}
          if(job===null)continue;
        }
        return readPage(job);
      }
      return {status:'idle'};
    })();
    try{return await active;}finally{active=null;}
  }});
}
