import { resolveSeerfarDiscoveryEvidence, SeerfarDiscoveryContractError, SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES } from './seerfar-discovery-contract.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { authorizeOperation } from './runtime-identity.mjs';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { normalizeADiscoveryServiceBindings, assertADiscoveryConnectorBinding } from './runtime-configuration.mjs';
import { A_DISCOVERY_JOB_TYPE, getADiscoveryProviderCapability, readADiscoveryMarketResult, ADiscoveryError, assertADiscoveryPlan, assertADiscoveryBatch,
  assertADiscoveryScope, assertADiscoveryAuthorization, assertADiscoveryCredential, assertADiscoveryReceipt } from './a-discovery-contract.mjs';
import { createADiscoveryJobForScope, ADiscoveryExecutionBlockedError } from './software-job-repository.mjs';
import { runADiscoverySoftwareJob } from './a-discovery-software-runner.mjs';
import { assertADiscoveryCandidateImportRecord, assertADiscoveryCandidateSelectionRecord } from './a-discovery-candidate-import.mjs';

const clone=value=>structuredClone(value);
const closed=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const requireValue=(value,code)=>{if(!value)throw new ADiscoveryError(code);};
const supportsPlan=(service,plan)=>service.connector.provider===plan.provider&&service.connector.contractVersion===plan.contractVersion&&
  (plan.provider!=='seerfar'||service.connector.budgetPolicyRef===plan.budget.policyRef)&&plan.requests.every(request=>service.connector.allowedMethods.includes(request.method));
function owner(actor){
  authorizeOperation({actor,requiredRoles:['owner']});
  requireValue(actor.actorType==='human'&&actor.source==='authenticated_identity_provider','AUTHENTICATED_OWNER_REQUIRED');
}
function collection(document,key,array=false){
  const value=readCollection(document,key,array);
  if(!Object.hasOwn(document,'runtime'))document.runtime={};
  if(!Object.hasOwn(document.runtime,key))document.runtime[key]=value;
  return value;
}
function readCollection(document,key,array=false){
  if(!Object.hasOwn(document,'runtime'))return array?[]:{};
  requireValue(document.runtime!==null&&typeof document.runtime==='object'&&!Array.isArray(document.runtime),'REPOSITORY_INVALID');
  if(!Object.hasOwn(document.runtime,key))return array?[]:{};
  const value=document.runtime[key];
  requireValue(array?Array.isArray(value):value!==null&&typeof value==='object'&&!Array.isArray(value),'REPOSITORY_INVALID');return value;
}

/** Saved plans and one-use jobs share the existing repository and worker queue. */
export function createADiscoveryRuntimeServices({repository,softwareJobStore,runtimeMode,serverClock,workerRegistry,
  serviceBindings=[],connectorBindings=[],plans=[],getEvidenceRecords=()=>[],readSecret,fetchImpl,onError,onBatchReady,onSelectProduct=null,sleep}={}){
  if(runtimeMode==='local_development')assertBusinessStateRepositoryBoundary(repository);
  else if(['central_test','central_production'].includes(runtimeMode))assertCentralPersistenceBoundary(repository);
  else throw new TypeError('A_DISCOVERY_RUNTIME_MODE_INVALID');
  if(typeof serverClock!=='function'||typeof readSecret!=='function'||typeof fetchImpl!=='function'||typeof onError!=='function'||typeof onBatchReady!=='function'||
    ['register','heartbeat'].some(key=>typeof workerRegistry?.[key]!=='function')||
    ['get','claim','listAssignableWithDiagnostics','enqueueADiscoveryInDocument','assertADiscoveryExecutionInDocument','settleADiscoveryInDocument'].some(key=>typeof softwareJobStore?.[key]!=='function'))throw new TypeError('A_DISCOVERY_SERVICE_DEPENDENCY_INVALID');
  requireValue(typeof getEvidenceRecords==='function','RUNNER_DEPENDENCY_INVALID');
  if(onSelectProduct!==null&&typeof onSelectProduct!=='function')throw new TypeError('A_DISCOVERY_SERVICE_DEPENDENCY_INVALID');
  const connectors=connectorBindings.map(assertADiscoveryConnectorBinding),bindings=normalizeADiscoveryServiceBindings(serviceBindings,connectors);
  requireValue(Array.isArray(plans)&&plans.length<=10,'PLAN_INVALID');
  const savedPlans=plans.map(assertADiscoveryPlan);
  requireValue(new Set(savedPlans.map(plan=>`${plan.planId}\n${plan.version}`)).size===savedPlans.length,'PLAN_INVALID');
  const services=bindings.map(binding=>{
    const connector=connectors.find(value=>value.bindingId===binding.connectorBindingId&&value.configurationVersion===binding.connectorConfigurationVersion);
    const worker={workerId:binding.workerId,version:binding.workerVersion,capabilities:[getADiscoveryProviderCapability(connector.provider,connector.contractVersion)]};
    workerRegistry.register({...worker,observedAt:serverClock()});
    return {binding,worker,connector};
  });
  function evidenceBlocker(plan) {
    if(plan.provider!=='seerfar')return null;
    try {resolveSeerfarDiscoveryEvidence({records:getEvidenceRecords(),request:plan.requests[0],budget:plan.budget,now:serverClock()});return null;}
    catch(error){if(error instanceof SeerfarDiscoveryContractError&&error.code.startsWith('EVIDENCE_'))return error.code;throw error;}
  }
  function batchConfigurationBlocker(batch){return batchPlanAvailable(batch)?evidenceBlocker(batch.plan):'PLAN_NOT_CONFIGURED';}
  function batchPlanAvailable(batch) {
    return savedPlans.some(plan=>isDeepStrictEqual(plan,batch.plan))&&services.some(service=>
      service.connector.bindingId===batch.bindingId&&service.connector.configurationVersion===batch.configurationVersion&&
      service.connector.credentialAlias===batch.credentialAlias&&service.connector.budgetPolicyRef===batch.budgetPolicyRef&&
      supportsPlan(service,batch.plan));
  }
  let active=null,activeExecution=null,lastAdmissionRejection=null,started=false,timer=null,failed=false,notificationError=null;
  const controllers=new Set();
  const heartbeat=service=>workerRegistry.heartbeat({...service.worker,status:'online'});
  function serviceFor(bindingId,configurationVersion){
    const matches=services.filter(value=>value.connector.bindingId===bindingId&&value.connector.configurationVersion===configurationVersion);
    requireValue(matches.length===1,'SERVICE_NOT_CONFIGURED');return matches[0];
  }
  function batchFor(document,batchId,actor){
    const batch=readCollection(document,'aDiscoveryBatches')[batchId];requireValue(batch!==undefined,'BATCH_REQUIRED');
    assertADiscoveryBatch(batch);requireValue(batch.ownerUserId===actor.userId,'OWNER_CONFLICT');return batch;
  }
  function singleflight(operation){if(active)return active;active=operation().catch(error=>{failed=true;throw error;}).finally(()=>{active=null;});return active;}
  async function continueReadyBatch(batchId=null){
    const document=await repository.readSnapshot(),receipts=readCollection(document,'aDiscoveryReceipts'),imports=readCollection(document,'aDiscoveryCandidateImports');
    for(const job of readCollection(document,'softwareJobs',true)){
      if(job.jobType!==A_DISCOVERY_JOB_TYPE||job.status!=='completed'||job.externalRequestState!=='succeeded'||batchId!==null&&job.subject.batchId!==batchId)continue;
      const batch=assertADiscoveryBatch(document.runtime.aDiscoveryBatches[job.subject.batchId]);
      if(job.revision!==batch.revision||job.scopeBinding.requestIndex!==batch.plan.requests.length-1)continue;
      if(Object.hasOwn(imports,`${batch.batchId}:${batch.revision}`)){
        assertADiscoveryCandidateImportRecord(imports[`${batch.batchId}:${batch.revision}`],{batchId:batch.batchId,revision:batch.revision});continue;
      }
      const all=readCollection(document,'softwareJobs',true).filter(value=>value.jobType===A_DISCOVERY_JOB_TYPE&&value.subject.batchId===batch.batchId&&value.revision===batch.revision);
      if(all.length!==batch.plan.requests.length||!all.every(value=>value.status==='completed'&&value.externalRequestState==='succeeded'))continue;
      for(const value of all)assertADiscoveryScope(value.scopeBinding,value);
      if(!all.every(value=>readADiscoveryMarketResult(assertADiscoveryReceipt(receipts[value.jobId],value)).status==='candidates_found'))continue;
      return onBatchReady({batchId:batch.batchId,revision:batch.revision});
    }
    return null;
  }
  async function runSelected(service,job){
    const currentJob=await softwareJobStore.get(job.jobId);
    if(currentJob?.status==='queued'&&currentJob.attempt===0&&currentJob.externalRequestState==='not_sent'){
      const document=await repository.readSnapshot();
      const batch=assertADiscoveryBatch(readCollection(document,'aDiscoveryBatches')[currentJob.subject.batchId]);
      const blocker=batchConfigurationBlocker(batch);
      if(blocker!==null){
        lastAdmissionRejection={jobId:job.jobId,code:`A_DISCOVERY_${blocker}`};
        return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};
      }
    }
    const leaseId=`lease:a-discovery:${randomUUID()}`,controller=new AbortController();controllers.add(controller);
    activeExecution={jobId:job.jobId,workerId:service.worker.workerId,leaseId};
    try{
      const result=await runADiscoverySoftwareJob({repository,softwareJobStore,worker:heartbeat(service),jobId:job.jobId,leaseId,
        leaseDurationMs:service.binding.leaseDurationMs,connectorBinding:service.connector,getEvidenceRecords,readSecret,fetchImpl,serverClock,sleep,signal:controller.signal});
      lastAdmissionRejection=null;
      if(result.status==='completed'){
        const imported=await continueReadyBatch(job.subject.batchId);
        if(imported!==null)return {...result,candidateImport:imported};
      }
      return result;
    }catch(error){
      if(error instanceof SeerfarDiscoveryContractError&&SEERFAR_DISCOVERY_EVIDENCE_FAILURE_CLASSES.includes(error.code)){
        lastAdmissionRejection={jobId:job.jobId,code:`A_DISCOVERY_${error.code}`};return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};
      }
      if(error instanceof ADiscoveryExecutionBlockedError){lastAdmissionRejection={jobId:job.jobId,code:error.code};return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
      failed=true;throw error;
    }finally{controllers.delete(controller);activeExecution=null;}
  }
  function runDue(){return singleflight(async()=>{
    if(failed)return {status:'failed',externalRequests:0};
    if(services.length===0)return {status:'not_configured',externalRequests:0};
    const imported=await continueReadyBatch();
    if(imported!==null)return {status:'continued',candidateImport:imported,externalRequests:0};
    for(const service of services){
      const {assignable,rejected}=await softwareJobStore.listAssignableWithDiagnostics({worker:heartbeat(service),jobType:A_DISCOVERY_JOB_TYPE,limit:1});
      if(assignable.length)return runSelected(service,assignable[0]);
      if(rejected.length){lastAdmissionRejection=clone(rejected[0]);return {status:'blocked',rejection:clone(lastAdmissionRejection),externalRequests:0};}
    }
    return {status:'idle',externalRequests:0};
  });}
  function schedule(){
    if(!started)return;
    timer=setTimeout(async()=>{
      timer=null;
      try{await runDue();}catch(error){started=false;failed=true;try{await onError(error);}catch(cause){notificationError=cause;}return;}
      schedule();
    },bindings[0].pumpIntervalMs);
    timer.unref?.();
  }
  return Object.freeze({
    get status(){return failed?'failed':started?'running':services.length?'stopped':'not_configured';},
    get activeExecution(){return clone(activeExecution);},get lastAdmissionRejection(){return clone(lastAdmissionRejection);},get notificationError(){return notificationError;},
    configurationView:clone(bindings),runDue,
    view({document,actor}){
      owner(actor);
      const batches=Object.values(readCollection(document,'aDiscoveryBatches')).map(assertADiscoveryBatch).filter(batch=>batch.ownerUserId===actor.userId);
      const jobs=readCollection(document,'softwareJobs',true),receipts=readCollection(document,'aDiscoveryReceipts'),imports=readCollection(document,'aDiscoveryCandidateImports'),selections=readCollection(document,'aDiscoveryCandidateSelections');
      const candidates=Array.isArray(document.candidates)?document.candidates:[];
      const configurationBlockers=[];
      if(savedPlans.length===0)configurationBlockers.push('PLAN_NOT_CONFIGURED');
      if(connectors.length===0)configurationBlockers.push('CONNECTOR_NOT_CONFIGURED');
      if(services.length===0)configurationBlockers.push('SERVICE_NOT_CONFIGURED');
      const compatiblePlans=savedPlans.filter(plan=>services.some(service=>supportsPlan(service,plan)));
      const preparablePlans=compatiblePlans.filter(plan=>evidenceBlocker(plan)===null);
      if(savedPlans.length>0&&services.length>0&&compatiblePlans.length===0)configurationBlockers.push('PLAN_NOT_SUPPORTED');
      if(compatiblePlans.length>0&&preparablePlans.length===0)configurationBlockers.push(...new Set(compatiblePlans.map(evidenceBlocker)));
      return {schemaVersion:'a-discovery-view-v1',plans:clone(preparablePlans),bindings:services.map(({connector})=>({bindingId:connector.bindingId,configurationVersion:connector.configurationVersion})),
        canPrepare:configurationBlockers.length===0,configurationBlockers,
        targetStores:['miska','dandanshu'],batches:batches.slice(-100).map(batch=>{
          const current=jobs.filter(job=>job.jobType===A_DISCOVERY_JOB_TYPE&&job.subject.batchId===batch.batchId);
          const routeAvailable=services.some(value=>value.connector.bindingId===batch.bindingId&&value.connector.configurationVersion===batch.configurationVersion);
          const key=`${batch.batchId}:${batch.revision}`;
          const prefix=`${key}:`;
          const batchSelections=Object.entries(selections).filter(([id])=>id.startsWith(prefix)).map(([id,record])=>assertADiscoveryCandidateSelectionRecord(record,{batchId:batch.batchId,revision:batch.revision,marketProductId:id.slice(prefix.length)}));
          const importedCandidates=candidates.filter(candidate=>[candidate.aDiscoveryEvidenceV1,candidate.aDiscoveryEvidenceV2].some(evidence=>evidence?.batchId===batch.batchId))
            .map(candidate=>({candidateId:candidate.id,marketProductId:(candidate.aDiscoveryEvidenceV2??candidate.aDiscoveryEvidenceV1).marketProductId}));
          return {batch:clone(batch),candidateImport:Object.hasOwn(imports,key)?assertADiscoveryCandidateImportRecord(imports[key],{batchId:batch.batchId,revision:batch.revision}):null,
            selections:batchSelections,importedCandidates,
            jobs:current.map(job=>({job:clone(job),receipt:Object.hasOwn(receipts,job.jobId)?assertADiscoveryReceipt(receipts[job.jobId],job):null,
              canContinue:job.status==='queued'&&job.attempt===0&&job.externalRequestState==='not_sent'&&job.revision===batch.revision&&routeAvailable&&batchConfigurationBlocker(batch)===null&&Date.parse(serverClock())<Date.parse(job.scopeBinding.expiresAt)})),
            canAuthorize:current.length===0&&batchConfigurationBlocker(batch)===null,
            configurationBlocker:current.length===0||current.some(job=>job.status==='queued'&&job.attempt===0&&job.externalRequestState==='not_sent')?batchConfigurationBlocker(batch):null};
        }),hasMore:batches.length>100,runtimeStatus:failed?'failed':started?'running':services.length?'stopped':'not_configured',activeExecution:clone(activeExecution),
        lastAdmissionRejection:clone(lastAdmissionRejection),platformWrites:0};
    },
    async createBatch({actor,input}){
      owner(actor);requireValue(closed(input,['planId','planVersion','targetStore','bindingId','configurationVersion','idempotencyKey'])&&
        ['planId','planVersion','bindingId','configurationVersion','idempotencyKey'].every(key=>isCanonicalFrozenRef(input[key]))&&['miska','dandanshu'].includes(input.targetStore),'INPUT_INVALID');
      const service=serviceFor(input.bindingId,input.configurationVersion),plan=savedPlans.find(value=>value.planId===input.planId&&value.version===input.planVersion);
      requireValue(plan!==undefined&&supportsPlan(service,plan),'PLAN_NOT_CONFIGURED');
      const blocker=evidenceBlocker(plan);requireValue(blocker===null,blocker);
      const batchId=`a-discovery-batch:${fingerprintCanonicalRecord({ownerUserId:actor.userId,idempotencyKey:input.idempotencyKey})}`;
      return repository.transact(document=>{
        const batches=collection(document,'aDiscoveryBatches'),exists=Object.hasOwn(batches,batchId),existing=exists?assertADiscoveryBatch(batches[batchId]):null;collection(document,'aDiscoveryReceipts');
        const batch=assertADiscoveryBatch({schemaVersion:plan.provider==='seerfar'?'a-discovery-batch-v2':'a-discovery-batch-v1',batchId,revision:0,ownerUserId:actor.userId,createdAt:exists?existing.createdAt:serverClock(),
          plan:clone(plan),targetStore:input.targetStore,bindingId:service.connector.bindingId,configurationVersion:service.connector.configurationVersion,
          credentialAlias:service.connector.credentialAlias,budgetPolicyRef:service.connector.budgetPolicyRef});
        if(exists){requireValue(isDeepStrictEqual(existing,batch),'IDEMPOTENCY_CONFLICT');return {changed:false,result:{batch:clone(existing),idempotentReplay:true,externalRequests:0}};}
        batches[batchId]=batch;return {changed:true,document,result:{batch:clone(batch),idempotentReplay:false,externalRequests:0}};
      });
    },
    async authorizeAndRun({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','expiresAt','idempotencyKey'])&&isCanonicalFrozenRef(input.batchId)&&isCanonicalFrozenRef(input.idempotencyKey)&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.expiresAt==='string'&&Number.isFinite(Date.parse(input.expiresAt)),'INPUT_INVALID');
      const authorized=await repository.transact(document=>{
        const batch=batchFor(document,input.batchId,actor);requireValue(batch.revision===input.expectedRevision,'BATCH_CHANGED');
        const service=serviceFor(batch.bindingId,batch.configurationVersion),at=serverClock();requireValue(Date.parse(input.expiresAt)>Date.parse(at),'AUTHORIZATION_EXPIRED');
        const authorizations=collection(document,'softwareJobAuthorizationRecords',true),credentials=collection(document,'softwareJobCredentialBindings',true);
        const scoped=authorizations.filter(value=>value.action===A_DISCOVERY_JOB_TYPE&&value.scopeBinding.batchId===batch.batchId&&value.scopeBinding.sourceRevision===batch.revision);
        const records=batch.plan.requests.map((request,requestIndex)=>{
          const authorizationRef=`a-discovery-permit:${fingerprintCanonicalRecord({batchId:batch.batchId,revision:batch.revision,requestIndex,idempotencyKey:input.idempotencyKey,ownerUserId:actor.userId})}`;
          const scope=assertADiscoveryScope({schemaVersion:batch.plan.provider==='seerfar'?'a-discovery-scope-v2':'a-discovery-scope-v1',
            ...(batch.plan.provider==='seerfar'?{provider:'seerfar',contractVersion:batch.plan.contractVersion,budget:clone(batch.plan.budget)}:{}),batchId:batch.batchId,sourceRevision:batch.revision,resultRevision:batch.revision,
            planId:batch.plan.planId,planVersion:batch.plan.version,requestIndex,request:clone(request),bindingId:batch.bindingId,configurationVersion:batch.configurationVersion,
            credentialAlias:batch.credentialAlias,budgetPolicyRef:batch.budgetPolicyRef,targetStore:batch.targetStore,authorizationRef,expiresAt:input.expiresAt});
          return {scope,authorization:assertADiscoveryAuthorization({schemaVersion:'software-job-authorization-record-v3',authorizationId:authorizationRef,
            authorizationType:batch.plan.provider==='seerfar'?'a_seerfar_discovery_once':'a_discovery_once',status:'active',action:A_DISCOVERY_JOB_TYPE,scopeBinding:scope,authorizedByUserId:actor.userId,authorizedAt:at,expiresAt:input.expiresAt,
            maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null}),credential:assertADiscoveryCredential({schemaVersion:'software-job-credential-binding-v3',
            bindingId:`a-discovery-credential:${authorizationRef.slice('a-discovery-permit:'.length)}`,credentialAlias:batch.credentialAlias,status:'active',provider:batch.plan.provider,
            sideEffectScope:A_DISCOVERY_JOB_TYPE,scopeBinding:scope,allowedWorkerIds:[service.worker.workerId],redaction:'credential_alias_only',boundAt:at,expiresAt:input.expiresAt})};
        });
        if(scoped.length){
          requireValue(scoped.length===records.length&&records.every(record=>scoped.some(value=>value.authorizationId===record.scope.authorizationRef&&isDeepStrictEqual(value.scopeBinding,record.scope))),'ALREADY_AUTHORIZED');
          const first=document.runtime.softwareJobs.find(job=>job.jobType===A_DISCOVERY_JOB_TYPE&&job.scopeBinding.authorizationRef===records[0].scope.authorizationRef);
          requireValue(first!==undefined,'JOB_SOURCE_CONFLICT');return {changed:false,result:{job:clone(first),serviceBindingId:service.binding.serviceId}};
        }
        const blocker=batchConfigurationBlocker(batch);requireValue(blocker===null,blocker);
        for(const record of records){authorizations.push(record.authorization);credentials.push(record.credential);}
        const job=softwareJobStore.enqueueADiscoveryInDocument({document,job:createADiscoveryJobForScope({scope:records[0].scope,ownerUserId:actor.userId,createdAt:at}),observedAt:at});
        return {changed:true,document,result:{job:clone(job),serviceBindingId:service.binding.serviceId}};
      });
      if(active&&activeExecution?.jobId!==authorized.job.jobId)return {status:'queued',jobId:authorized.job.jobId,externalRequests:0};
      return singleflight(()=>runSelected(services.find(value=>value.binding.serviceId===authorized.serviceBindingId),authorized.job));
    },
    async importSelected({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','marketProductId'])&&isCanonicalFrozenRef(input.batchId)&&
        Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&typeof input.marketProductId==='string'&&/^[1-9][0-9]*$/.test(input.marketProductId),'INPUT_INVALID');
      requireValue(onSelectProduct!==null,'SERVICE_NOT_CONFIGURED');
      const document=await repository.readSnapshot(),batch=batchFor(document,input.batchId,actor);
      requireValue(batch.revision===input.expectedRevision,'BATCH_CHANGED');
      return onSelectProduct({batchId:batch.batchId,revision:batch.revision,marketProductId:input.marketProductId,selectedByUserId:actor.userId});
    },
    continueSavedCurrent({actor,input}){
      owner(actor);requireValue(closed(input,['batchId','expectedRevision','jobId'])&&isCanonicalFrozenRef(input.batchId)&&isCanonicalFrozenRef(input.jobId)&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'INPUT_INVALID');
      requireValue(!active||activeExecution?.jobId===input.jobId,'SERVICE_BUSY');
      return singleflight(async()=>{
        const document=await repository.readSnapshot(),batch=batchFor(document,input.batchId,actor),job=await softwareJobStore.get(input.jobId);
        requireValue(batch.revision===input.expectedRevision&&job?.subject?.batchId===batch.batchId&&job.revision===batch.revision,'BATCH_CHANGED');
        return runSelected(serviceFor(batch.bindingId,batch.configurationVersion),job);
      });
    },
    start(){if(started||failed||!services.length)return;started=true;schedule();},
    async stop(){started=false;clearTimeout(timer);timer=null;for(const controller of controllers)controller.abort(new ADiscoveryError('CANCELLED'));if(active)await active;}
  });
}
