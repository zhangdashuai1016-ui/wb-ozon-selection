import { createSoftwareExecutionRuntime, openExceptionCase } from './software-execution-state.mjs';
import { createDPlatformObservationRuntime } from './d-platform-observation-use-case.mjs';
import { assertDPlatformObservationAdmission, assertDRemainingInventorySend } from './d-platform-observation-contract.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeDEServiceBindings } from './runtime-configuration.mjs';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { assertWorkerRegistryBoundary } from './worker-registry.mjs';
import { createActorContext } from './runtime-identity.mjs';
import { createRepositoryBackedSoftwareJobStore } from './software-job-repository.mjs';
import { findSoftwareJobInDocument, softwareJobsInDocument, bindSoftwareJobAdmissionDecision, markSoftwareJobExternalRequestStarted } from './software-job-contract.mjs';
import { assertDProductionJobReference, settleDPreparationJobInDocument } from './d-e-software-job-handoff.mjs';
import { assertDEJobAdmissionDecision } from './d-e-software-job-admission.mjs';
import { createProductionPlan } from './production-plan.mjs';
import { runPlatformWritePreflight, assertCurrentProductionExecutionBinding } from './platform-write-preflight.mjs';
import { productionJobPrewriteCode } from './production-execution-failure.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { runPersistedDExecution, runPersistedDRemainingInventory } from './d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from './ozon-seller-api-de-adapter.mjs';
import { createSystemEReadbackSoftwareRuntime } from './e-readback-software-use-case.mjs';
import { createDAssetTransportSoftwareRuntime } from './d-asset-transport-software-use-case.mjs';
import { createDProductionPreparationIntent, completeDProductionPreparation, markDProductionPreparationUnknown,
  assertDProductionPreparationContinuation } from './d-production-preparation-contract.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef } from './production-contract-primitives.mjs';

const terminal = job => ['completed','failed','unknown_outcome'].includes(job.status);
const clone = value => structuredClone(value);
const remainingInventoryPreSendFailures = new Set([
  'DE_RUNTIME_INVENTORY_PROOF_UNAVAILABLE', 'DE_RUNTIME_INVENTORY_OBSERVATION_CHANGED',
  'D_PLATFORM_OBSERVATION_SOURCE_CONFLICT', 'D_PLATFORM_OBSERVATION_JOB_SOURCE_CONFLICT',
  'D_PLATFORM_OBSERVATION_POLICY_EXPIRED', 'D_PLATFORM_OBSERVATION_INVENTORY_HOLDER_INVALID',
  'D_PLATFORM_OBSERVATION_PREREQUISITE_SOURCE_UNVERIFIED'
]);
function knownRemainingInventoryPreSendFailure(error) {
  return error instanceof DERuntimeUnavailableError || productionJobPrewriteCode(error)!==null ||
    error?.constructor===Error && remainingInventoryPreSendFailures.has(error.message);
}
export class DERuntimeUnavailableError extends Error {
  constructor(code) { super(`DE_RUNTIME_UNAVAILABLE_${code}`); this.name='DERuntimeUnavailableError'; this.code=this.message; }
}
/** Explicit transport-boundary error; unrelated internal errors retain their original identity. */
export class DEPreflightTransportError extends Error {
  constructor(code) {
    if (!['timeout','cancelled','connection_failed','response_lost'].includes(code)) throw new TypeError('DE_PREFLIGHT_TRANSPORT_CODE_INVALID');
    super(`DE_PREFLIGHT_TRANSPORT_${code.toUpperCase()}`); this.name='DEPreflightTransportError'; this.code=this.message;
  }
}
function inputShape(input) {
  if (!input || Object.keys(input).length!==3 || !['candidateId','jobId','expectedRevision'].every(k=>Object.hasOwn(input,k)) ||
      !isCanonicalFrozenRef(input.candidateId) || !isCanonicalFrozenRef(input.jobId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0) throw new Error('DE_RUNTIME_INPUT_INVALID');
}
function candidateIn(document, id) {
  const candidates=document.candidates.filter(candidate=>candidate.id===id);
  if(candidates.length!==1) throw new Error('DE_RUNTIME_CANDIDATE_NOT_FOUND');
  return candidates[0];
}
function replaceJob(document, job) {
  const jobs=softwareJobsInDocument(document),index=jobs.findIndex(value=>value.jobId===job.jobId);
  if(index<0) throw new Error('DE_RUNTIME_JOB_NOT_FOUND'); jobs[index]=clone(job);
}
/** Construct routing and registered capabilities only. No candidate/job read, credential resolution or provider invocation. */
export function createDEProductionRuntimeServices({ repository, runtimeMode, serverClock, workerRegistry,
  deServiceBindings=[],productionBindings=[],requestJson=null,inspectPlatform=null,loadAdapterCapabilities=null,
  upload=null,resolveLocalAsset=null,loadCurrentProductionBinding=null,preflightRequestMode='external_read',loadDPlatformObservationPolicy=null,verifyInventoryPrerequisiteSource=null,
  observationPumpIntervalMs=null,onObservationError=null,eReadbackPumpIntervalMs=null,onReadbackError=null }={}) {
  assertBusinessStateRepositoryBoundary(repository); assertWorkerRegistryBoundary(workerRegistry);
  if(typeof serverClock!=='function' || [requestJson,inspectPlatform,loadAdapterCapabilities,upload,resolveLocalAsset,loadCurrentProductionBinding,loadDPlatformObservationPolicy,verifyInventoryPrerequisiteSource,onObservationError,onReadbackError]
    .some(value=>value!==null&&typeof value!=='function')) throw new Error('DE_RUNTIME_DEPENDENCY_INVALID');
  if(!['external_read','persisted_evidence_only'].includes(preflightRequestMode)) throw new Error('DE_RUNTIME_PREFLIGHT_REQUEST_MODE_INVALID');
  if(eReadbackPumpIntervalMs!==null && (!Number.isSafeInteger(eReadbackPumpIntervalMs)||eReadbackPumpIntervalMs<1000||eReadbackPumpIntervalMs>2147483647)) throw new Error('DE_RUNTIME_E_PUMP_INTERVAL_INVALID');
  const bindings=normalizeDEServiceBindings(deServiceBindings,productionBindings), services=new Map();
  for(const binding of bindings){
    const worker=workerRegistry.register({workerId:binding.workerId,version:binding.workerVersion,
      capabilities:['ozon-production-execution','ozon-independent-readback'],observedAt:serverClock()});
    services.set(binding.productionBindingId,{binding,worker});
  }
  function production(candidate, service) {
    const binding=loadCurrentProductionBinding===null ? productionBindings.find(value=>value.bindingId===service.binding.productionBindingId) : loadCurrentProductionBinding(candidate);
    if(binding && typeof binding.then==='function') throw new TypeError('DE_RUNTIME_CURRENT_BINDING_MUST_BE_SYNCHRONOUS');
    return binding;
  }
  function resolveBinding({candidate,job}) {
    const service=services.get(job.scopeBinding.productionBinding.bindingId);
    if(!service) throw new DERuntimeUnavailableError('SERVICE');
    const current=production(candidate,service);
    if(!current) throw new DERuntimeUnavailableError('PRODUCTION_BINDING');
    return {schemaVersion:'d-e-execution-binding-v1',serviceId:service.binding.serviceId,serviceConfigurationVersion:service.binding.configurationVersion,
      productionBinding:{bindingId:current.bindingId,configurationVersion:current.configurationVersion,warehouseId:current.warehouseId},
      platform:current.platform,storeRef:clone(current.storeRef),warehouseRef:current.warehouseRef,credentialAlias:current.credentialAlias,
      workerId:service.worker.workerId,workerVersion:service.worker.version,configurationEvidence:clone(current.verification)};
  }
  const activeReadbacks=new Map();
  const eExecutions=new Map(),eControllers=new Map();
  let ePumpStarted=false,ePumpTimer=null,ePumpActive=null,stopping=false;
  const historyReadback=createSystemEReadbackSoftwareRuntime({repository,runtimeMode,serverClock,readPlatform:null});
  const jobStore=createRepositoryBackedSoftwareJobStore({businessStateRepository:repository,serverClock,workerRegistry,resolveDEExecutionBinding:resolveBinding});
  async function snapshot(input) {
    const document=await repository.readSnapshot(),candidate=candidateIn(document,input.candidateId),job=findSoftwareJobInDocument(document,input.jobId);
    if(!job) throw new Error('DE_RUNTIME_JOB_NOT_FOUND');
    if(job.candidateId!==candidate.id||job.skuPackageId!==candidate.lifecycleV11.skuPackage.skuPackageId||!['d_production_execution','e_independent_readback','e_d_platform_observation'].includes(job.jobType)) throw new Error('DE_RUNTIME_JOB_SOURCE_CONFLICT');
    if(job.jobType === 'e_d_platform_observation') assertDPlatformObservationAdmission(job,job.admissionDecision);
    else assertDEJobAdmissionDecision(job,job.admissionDecision);
    return {document,candidate,job};
  }
  function replay({document,candidate,job},input) {
    if(input.expectedRevision!==job.revision && input.expectedRevision!==candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
    if(job.jobType==='d_production_execution') assertDProductionJobReference({document,candidate,job});
    else if(job.jobType === 'e_independent_readback' && fingerprintCanonicalRecord(candidate.lifecycleV11.skuPackage.productionRecord)!==job.scopeBinding.sourceProductionRecordFingerprint) throw new Error('DE_RUNTIME_REPLAY_SOURCE_CONFLICT');
    return {status:'idempotent_replay',candidate:clone(candidate),job:clone(job)};
  }
  function available(candidate,job) {
    const service=services.get(job.scopeBinding.productionBinding.bindingId);
    if(!service) throw new DERuntimeUnavailableError('SERVICE');
    for(const [name,value] of [['TRANSPORT',requestJson],['CAPABILITIES',loadAdapterCapabilities],...(job.jobType==='d_production_execution'?[['PREFLIGHT',inspectPlatform]]:[])]) {
      if(value===null) throw new DERuntimeUnavailableError(name);
    }
    const sku=candidate.lifecycleV11.skuPackage;
    if(job.jobType==='d_production_execution' && sku.productionAuthorization.lockedScope.finalUploads.some(asset=>asset.assetRef.startsWith('local-asset:')) && !sku.dAssetTransport && (upload===null||resolveLocalAsset===null)) throw new DERuntimeUnavailableError('ASSET_TRANSPORT');
    return service;
  }
  function actor(service) { return createActorContext({userId:service.worker.workerId,sessionId:`worker-session:${service.worker.workerId}:${service.binding.configurationVersion}`,
    actorType:'worker',roles:['operator'],source:'registered_runtime_worker',authenticatedAt:serverClock()}); }
  async function prepare(candidate,job,service,context,plan,capabilities) {
    const begun=await repository.transact(document=>{
      const observedAt=serverClock(),guard=jobStore.assertDEExecutionInDocument({document,...context,observedAt});
      if(guard.candidate.dataRevision!==candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
      if(guard.job.preparationEvidence) return {changed:false,result:{replay:true}};
      const productionBinding=production(guard.candidate,service);
      assertCurrentProductionExecutionBinding({productionAuthorization:plan.sourceAuthorization,currentProductionBinding:productionBinding,checkedAt:observedAt});
      let next=bindSoftwareJobAdmissionDecision(guard.job,guard.admissionDecision);
      if(preflightRequestMode==='external_read'&&next.status==='claimed') next=markSoftwareJobExternalRequestStarted({job:next,...context,externalRequestRef:`d-production-request:${job.scopeBinding.authorizationFingerprint}`,serverTime:observedAt});
      const evidence=createDProductionPreparationIntent({job:next,candidateRevision:candidate.dataRevision,productionPlan:plan,startedAt:observedAt,requestMode:preflightRequestMode});
      next={...next,preparationEvidence:evidence};replaceJob(document,next);
      return {changed:true,document,result:{evidence,inspectionContext:clone({candidate:guard.candidate,job:next,
        candidateRevision:guard.candidate.dataRevision,sourceRevision:next.revision,productionAuthorization:plan.sourceAuthorization,
        productionPlan:plan,productionBinding,preparationEvidence:evidence,workerId:next.workerId,leaseId:next.leaseId})}};
    });
    if(begun.replay) return {proceed:false};
    let next;
    try {
      const preflight=await runPlatformWritePreflight({productionPlan:plan,checkedAt:begun.evidence.startedAt,inspectPlatform:async query=>{
        const controller=new AbortController();
        const remaining=Math.max(1,Date.parse(begun.inspectionContext.job.leaseExpiresAt)-Date.parse(serverClock()));
        let timer;
        const deadline=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{const error=new DEPreflightTransportError('timeout');controller.abort(error);reject(error);},remaining);
        });
        try { return await Promise.race([Promise.resolve().then(()=>inspectPlatform(query,{...clone(begun.inspectionContext),signal:controller.signal})),deadline]); }
        finally { clearTimeout(timer); }
      }});
      let prepared;
      try {
        prepared=prepareSingleSkuDExecution({productionPlan:plan,productionAuthorization:plan.sourceAuthorization,platformWritePreflight:preflight,
          adapterCapabilities:capabilities,currentProductionBinding:production(candidate,service),preparedAt:serverClock()});
      } catch(error) {
        const code=productionJobPrewriteCode(error); if(code===null) throw error;
        prepared={schemaVersion:'d-software-execution-v2',preparedAt:serverClock(),
          sourceProductionPlanId:begun.evidence.sourceProductionPlanId,sourceProductionPlanFingerprint:begun.evidence.sourceProductionPlanFingerprint,
          sourceAuthorizationFingerprint:begun.evidence.sourceAuthorizationFingerprint,
          status:'not_ready',gaps:[{code,field:'productionExecution',message:'当前生产执行条件已变化，本轮停止'}]};
      }
      next=completeDProductionPreparation({evidence:begun.evidence,platformWritePreflight:preflight,adapterCapabilities:capabilities,preparedExecution:prepared,completedAt:serverClock()});
    } catch(error) {
      if(!(error instanceof DEPreflightTransportError)) throw error;
      next=markDProductionPreparationUnknown({evidence:begun.evidence,completedAt:serverClock()});
    }
    return repository.transact(document=>{
      const current=candidateIn(document,candidate.id),saved=findSoftwareJobInDocument(document,job.jobId);
      if(!isDeepStrictEqual(saved.preparationEvidence,begun.evidence)) throw new Error('DE_RUNTIME_PREPARATION_CONFLICT');
      const sourceChanged=current.dataRevision!==next.sourceCandidateRevision || !isDeepStrictEqual(current.lifecycleV11.skuPackage.productionAuthorization,plan.sourceAuthorization);
      let admissionBlocked=false;
      if(!terminal(saved)) {
        try { jobStore.assertDEExecutionInDocument({document,...context,observedAt:serverClock()}); }
        catch(error) { if(productionJobPrewriteCode(error)===null) throw error; admissionBlocked=true; }
      }
      const evidence={...next,continuationBlocked:next.continuationBlocked||sourceChanged||admissionBlocked||terminal(saved)};
      assertDProductionPreparationContinuation(saved.preparationEvidence,evidence);
      replaceJob(document,{...saved,preparationEvidence:evidence});
      if(evidence.requestMode==='persisted_evidence_only'&&saved.status==='failed'&&saved.externalRequestState==='not_sent'&&saved.externalRequestRef===null){
        return {changed:true,document,result:{proceed:false,evidence}};
      }
      const settled=settleDPreparationJobInDocument({document,candidate:current,jobId:job.jobId,...context,observedAt:serverClock()});
      const resulting=findSoftwareJobInDocument(document,job.jobId);
      return {changed:true,document,result:{proceed:evidence.status==='ready'&&!evidence.continuationBlocked&&!terminal(resulting),evidence,settled}};
    });
  }
  async function runE(input,known=null) {
    const active=eExecutions.get(input.jobId);
    if(active){
      if(!isDeepStrictEqual(active.input,input))throw new Error('DE_RUNTIME_E_CONCURRENT_INPUT_CONFLICT');
      return active.execution;
    }
    if(stopping)return {status:'stopped'};
    const controller=new AbortController();eControllers.set(input.jobId,controller);
    const execution=performE(input,known,controller.signal);eExecutions.set(input.jobId,{input:clone(input),execution});
    try{return await execution;}finally{eExecutions.delete(input.jobId);eControllers.delete(input.jobId);}
  }
  async function performE(input,known,stopSignal) {
    const initial=known||await snapshot(input);
    if(terminal(initial.job)||initial.job.status!=='queued') return replay(initial,input);
    if(input.expectedRevision!==initial.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
    const service=available(initial.candidate,initial.job);workerRegistry.heartbeat({...service.worker,status:'online'});
    const leaseId=`lease:de:${randomUUID()}`,workerActor=actor(service);
    await jobStore.claim({jobId:input.jobId,worker:service.worker,leaseId,leaseDurationMs:service.binding.leaseDurationMs});
    const context={jobStore,jobId:input.jobId,workerId:service.worker.workerId,leaseId};
    const runtime=createSystemEReadbackSoftwareRuntime({repository,runtimeMode,serverClock,readPlatform:async(query,options)=>{
      const current=await snapshot(input);
      const capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      return createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities}).readbackSellerApi(query,
        {...options,signal:AbortSignal.any([options.signal,stopSignal])});
    }});
    activeReadbacks.set(input.jobId,runtime);
    try {
      return await runtime.run({actor:workerActor,input:{candidateId:input.candidateId,expectedCandidateRevision:initial.candidate.dataRevision,
        sourceRecordId:initial.candidate.lifecycleV11.skuPackage.productionRecord.productionRecordId},softwareJobContext:context});
    } finally { activeReadbacks.delete(input.jobId); }
  }
  async function resumeInventory({sourceDJobId,observationJobId}) {
    const document=await repository.readSnapshot(),job=findSoftwareJobInDocument(document,sourceDJobId),candidate=candidateIn(document,job.candidateId);
    let service,capabilities;
    const leaseId=`lease:d-inventory:${randomUUID()}`;
    try {
      const state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
      if(candidate.dataRevision!==state.expectedCandidateRevision ||
        !isDeepStrictEqual(candidate.lifecycleV11.skuPackage.productionAuthorization,state.productionPlan.sourceAuthorization) ||
        Date.parse(serverClock())>=Date.parse(state.platformContinuation.policy.expiresAt))
        return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    service=available(candidate,job);workerRegistry.heartbeat({...service.worker,status:'online'});
    capabilities=await loadAdapterCapabilities({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
    if(verifyInventoryPrerequisiteSource === null || !capabilities.inventoryWrite.prerequisitePolicy) return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'inventory_policy_missing'});
    const initialProof=await verifyInventoryPrerequisiteSource({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
    if(initialProof === null) return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    if(typeof initialProof.assertCurrent !== 'function') throw new Error('DE_RUNTIME_INVENTORY_PROOF_INVALID');
    const verify=args=>initialProof.assertCurrent(args) === true &&
      isDeepStrictEqual(args.prerequisites.priceSentObservation.policy,capabilities.inventoryWrite.prerequisitePolicy) &&
      isDeepStrictEqual(args.prerequisites.inventoryPrerequisiteObservation.policy,capabilities.inventoryWrite.prerequisitePolicy);
    await jobStore.claimDRemainingInventory({jobId:sourceDJobId,worker:service.worker,leaseId,
      leaseDurationMs:service.binding.leaseDurationMs,observationJobId,verifyInventoryPrerequisiteSource:verify});
    } catch(error) {
      if(!(error instanceof DERuntimeUnavailableError) && ![
        'D_PLATFORM_OBSERVATION_SOURCE_CONFLICT','D_PLATFORM_OBSERVATION_POLICY_EXPIRED',
        'D_PLATFORM_OBSERVATION_PREREQUISITE_SOURCE_UNVERIFIED',
        'SOFTWARE_JOB_ADMISSION_DE_BINDING_EVIDENCE_EXPIRED','SOFTWARE_JOB_ADMISSION_DE_BINDING_CHANGED'
      ].includes(error.message))throw error;
      return jobStore.rejectDRemainingInventory({jobId:sourceDJobId,observationJobId,failureClass:'context_changed'});
    }
    const context={jobStore,jobId:sourceDJobId,workerId:service.worker.workerId,leaseId};
    let observation;
    const assertRemainingInventoryAuthorization=async()=>{
      const latest=await repository.readSnapshot(),latestJob=findSoftwareJobInDocument(latest,sourceDJobId),latestCandidate=candidateIn(latest,latestJob.candidateId);
      const proof=await verifyInventoryPrerequisiteSource({candidate:clone(latestCandidate),job:clone(latestJob),productionBinding:clone(production(latestCandidate,service))});
      if(proof === null) throw new Error('DE_RUNTIME_INVENTORY_PROOF_UNAVAILABLE');
      if(typeof proof.assertCurrent !== 'function') throw new TypeError('DE_RUNTIME_INVENTORY_PROOF_INVALID');
      return repository.transact(current=>{
      const held=findSoftwareJobInDocument(current,sourceDJobId),observedAt=serverClock();
      const currentCandidate=candidateIn(current,held.candidateId);
      assertCurrentProductionExecutionBinding({productionAuthorization:currentCandidate.lifecycleV11.skuPackage.productionAuthorization,
        currentProductionBinding:production(currentCandidate,service),checkedAt:observedAt});
      const validated=assertDRemainingInventorySend({document:current,job:held,observationJobId,checkedAt:observedAt,
        workerId:service.worker.workerId,leaseId,verifyInventoryPrerequisiteSource:proof.assertCurrent});
      if(observation !== undefined && !isDeepStrictEqual(observation,validated.prerequisites)) throw new Error('DE_RUNTIME_INVENTORY_OBSERVATION_CHANGED');
      observation=validated.prerequisites;
      return {changed:false,result:null};
      });
    };
    try {
      await assertRemainingInventoryAuthorization();
    } catch(error) {
      const known=knownRemainingInventoryPreSendFailure(error);
      const stopped=await repository.transact(current=>{
        const at=serverClock();
        const settled=jobStore.stopDRemainingInventoryBeforeSendInDocument({document:current,...context,observedAt:at});
        const currentCandidate=candidateIn(current,settled.candidateId);
        if(!known) {
          const prior=currentCandidate.executionRuntime || createSoftwareExecutionRuntime({candidateId:currentCandidate.id,
            dataRevision:currentCandidate.dataRevision,businessPhase:'D',stepId:'D_REMAINING_INVENTORY',at});
          if(prior.exceptionCase?.status!=='open')currentCandidate.executionRuntime=openExceptionCase({...prior,
            businessPhase:'D',stepId:'D_REMAINING_INVENTORY'}, {
            exceptionId:`exception:d-inventory-pre-send:${sourceDJobId}`,reasonCode:'system_failure',failureLayer:'d_inventory_pre_send',
            evidenceRefs:[settled.resultRef],skuPackageId:settled.skuPackageId,softwareJobId:sourceDJobId,
            lastSuccessfulStepId:'import_result_observed',externalRequestRefs:[settled.platformContinuation.requestReceiptRef],
            unknownOutcome:false,sourceRevision:settled.revision,at});
        }
        return {changed:true,document:current,result:{status:settled.status,job:clone(settled),candidate:clone(currentCandidate)}};
      });
      if(!known)throw error;
      return stopped;
    }
    const outcome=await runPersistedDRemainingInventory({repository,candidateId:candidate.id,softwareJobContext:context,serverClock,
      currentProductionBinding:production(candidate,service),observation,assertRemainingInventoryAuthorization,
      createAdapter:({executionContext})=>createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities,executionContext})});
    if(outcome.status!=='succeeded')return outcome;
    const saved=await repository.readSnapshot(),current=candidateIn(saved,candidate.id),source=findSoftwareJobInDocument(saved,sourceDJobId);
    const eRef=current.lifecycleV11.eIndependentReadbackJobRefV1;
    if(source.status!=='completed'||source.resultEnvelope.applicationDisposition!=='applied'||!eRef)throw new Error('DE_RUNTIME_E_HANDOFF_MISSING');
    const e=await runE({candidateId:current.id,jobId:eRef.jobId,expectedRevision:current.dataRevision});
    return {status:e.status,d:outcome,e};
  }
  const observationRuntime=createDPlatformObservationRuntime({repository,jobStore,serverClock,pumpIntervalMs:observationPumpIntervalMs,
    onError:onObservationError,onPrerequisitesObserved:resumeInventory,resolveExecution:async({candidate,job})=>{
      const service=available(candidate,job);workerRegistry.heartbeat({...service.worker,status:'online'});
      return {worker:service.worker,leaseDurationMs:service.binding.leaseDurationMs,createAdapter:async()=>{
        const capabilities=await loadAdapterCapabilities({candidate:clone(candidate),job:clone(job),productionBinding:clone(production(candidate,service))});
        return createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities});
      }};
    }});
  async function runDueEReadbacks() {
    if(ePumpActive)return ePumpActive;
    ePumpActive=(async()=>{
      let rejection=null;
      for(const service of services.values()){
        workerRegistry.heartbeat({...service.worker,status:'online'});
        const {assignable:jobs,rejected}=await jobStore.listAssignableWithDiagnostics({worker:service.worker,jobType:'e_independent_readback',limit:1});
        if(rejected.length>0&&rejection===null)rejection=rejected[0];
        if(jobs.length===0)continue;
        const job=jobs[0];
        if(job.status!=='queued'||job.attempt!==0||job.externalRequestState!=='not_sent'||job.externalRequestRef!==null)throw new Error('DE_RUNTIME_E_QUEUE_SOURCE_CONFLICT');
        try{return await runE({candidateId:job.candidateId,jobId:job.jobId,expectedRevision:job.revision});}
        catch(error){
          if(!(error instanceof DERuntimeUnavailableError))throw error;
          return {status:'blocked',rejection:{jobId:job.jobId,candidateId:job.candidateId,code:error.code}};
        }
      }
      return rejection===null?{status:'idle'}:{status:'blocked',rejection};
    })();
    try{return await ePumpActive;}finally{ePumpActive=null;}
  }
  function scheduleEReadback(){
    if(ePumpStarted)ePumpTimer=setTimeout(()=>{
      runDueEReadbacks().then(scheduleEReadback,error=>{ePumpStarted=false;onReadbackError(error);});
    },eReadbackPumpIntervalMs);
  }
  return Object.freeze({
    start(){
      if(eReadbackPumpIntervalMs!==null && onReadbackError===null)throw new Error('DE_RUNTIME_E_PUMP_ERROR_HANDLER_REQUIRED');
      stopping=false;
      if(observationPumpIntervalMs!==null)observationRuntime.start();
      if(eReadbackPumpIntervalMs!==null&&!ePumpStarted){ePumpStarted=true;scheduleEReadback();}
    },
    async stop(){
      stopping=true;ePumpStarted=false;clearTimeout(ePumpTimer);
      for(const controller of eControllers.values())controller.abort(new Error('DE_RUNTIME_STOPPED'));
      await observationRuntime.stop();
      await Promise.all([...eExecutions.values()].map(value=>value.execution));
      if(ePumpActive)await ePumpActive;
    },runDueObservations:observationRuntime.runDue,runDueEReadbacks,resumeInventory,
    readbackView(candidate) {
      const jobId=candidate?.lifecycleV11?.eIndependentReadbackJobRefV1?.jobId;
      const active=activeReadbacks.get(jobId);
      return (active || historyReadback).view(candidate);
    },
    configurationView:Object.freeze(bindings.map(binding=>Object.freeze(clone(binding)))),
    dependencyView:Object.freeze({transport:requestJson!==null,preflight:inspectPlatform!==null,capabilities:loadAdapterCapabilities!==null,assetTransport:upload!==null&&resolveLocalAsset!==null}),
    async continueSavedCurrent(input) {
      inputShape(input);let current=await snapshot(input);
      if(current.job.jobType==='e_independent_readback') return runE(input,current);
      if(current.job.jobType==='e_d_platform_observation') {
        if(input.expectedRevision !== current.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
        return observationRuntime.runJob({jobId:input.jobId});
      }
      if(current.job.status!=='queued') return replay(current,input);
      if(input.expectedRevision!==current.candidate.dataRevision) throw new Error('DE_RUNTIME_REVISION_CONFLICT');
      const service=available(current.candidate,current.job);workerRegistry.heartbeat({...service.worker,status:'online'});
      const leaseId=`lease:de:${randomUUID()}`,workerActor=actor(service);
      const claimed=await jobStore.claim({jobId:input.jobId,worker:service.worker,leaseId,leaseDurationMs:service.binding.leaseDurationMs});
      const context={jobStore,jobId:input.jobId,workerId:service.worker.workerId,leaseId};
      current=await snapshot(input);
      // Read persisted protocol/account evidence before any public asset upload.
      let capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      let sku=current.candidate.lifecycleV11.skuPackage;
      const accountAndProtocolsReady=capabilities.gaps.every(gap=>gap.code==='asset_transport_not_verified');
      if(accountAndProtocolsReady&&sku.productionAuthorization.lockedScope.finalUploads.some(asset=>asset.assetRef.startsWith('local-asset:'))&&!sku.dAssetTransport){
        const assets=createDAssetTransportSoftwareRuntime({repository,runtimeMode,serverClock,upload,resolveLocalAsset,loadCurrentProductionBinding:({candidate})=>production(candidate,service)});
        const result=await assets.run({actor:workerActor,input:{candidateId:input.candidateId,expectedCandidateRevision:current.candidate.dataRevision},softwareJobContext:context});
        if(result.assetTransportState.status!=='verified'||result.assetTransportState.continuationBlocked) return result;
        current=await snapshot(input);
        capabilities=await loadAdapterCapabilities({candidate:clone(current.candidate),productionBinding:clone(production(current.candidate,service)),job:clone(current.job)});
      }
      current=await snapshot(input);sku=current.candidate.lifecycleV11.skuPackage;
      const plan=sku.dAssetTransport?.intent.productionPlan||createProductionPlan({productionAuthorization:sku.productionAuthorization,candidateId:current.candidate.id,
        candidateRevision:current.candidate.dataRevision,skuPackage:sku,createdAt:serverClock()});
      const preparation=await prepare(current.candidate,claimed,service,context,plan,capabilities);
      if(!preparation.proceed) {
        const stopped=await snapshot(input);
        return {status:stopped.job.status,candidate:clone(stopped.candidate),job:clone(stopped.job)};
      }
      const platformObservationPolicy=loadDPlatformObservationPolicy === null ? null : await loadDPlatformObservationPolicy({candidate:clone(current.candidate),job:clone(current.job),checkedAt:serverClock()});
      const d=await runPersistedDExecution({repository,runtimeMode,platformObservationPolicy,serverClock,actor:workerActor,candidateId:input.candidateId,
        expectedCandidateRevision:current.candidate.dataRevision,productionPlan:plan,platformWritePreflight:preparation.evidence.result.platformWritePreflight,
        adapterCapabilities:capabilities,currentProductionBinding:production(current.candidate,service),softwareJobContext:context,
        createAdapter:async({executionContext})=>createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:capabilities,executionContext})});
      current=await snapshot(input);
      const eRef=current.candidate.lifecycleV11.eIndependentReadbackJobRefV1;
      if(d.status==='succeeded'&&current.job.status==='completed'&&current.job.resultEnvelope.applicationDisposition==='applied'&&eRef){
        const e=await runE({candidateId:input.candidateId,jobId:eRef.jobId,expectedRevision:current.candidate.dataRevision});return {status:e.status,d,e};
      }
      return d;
    }
  });
}
