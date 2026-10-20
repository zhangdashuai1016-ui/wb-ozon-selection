import { ozonAccountReadCoordinationState } from './ozon-account-read-coordination.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createProductionPlan } from './production-plan.mjs';
import { runPlatformWritePreflight } from './platform-write-preflight.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter, OZON_DE_READBACK_ENDPOINTS } from './ozon-seller-api-de-adapter.mjs';
import { createPersistedDBatchImportRuntime } from './d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { applyDBatchStockEvent, reclaimDBatchStockJob } from './d-batch-stock-state.mjs';
import { randomUUID } from 'node:crypto';
import { OzonDEHttpTransportError } from './ozon-de-http-configuration.mjs';
import { createDBatchOfferRecord, createDBatchEJob, applyDBatchEJobEvent,
  reclaimDBatchEJob, createDBatchEReadback, assertDBatchEJob,
  D_BATCH_E_JOB_VERSION, D_BATCH_E_READBACK_VERSION } from './d-batch-offer-readback.mjs';
import { assertDBatchFrozenImport } from './d-batch-import-state.mjs';
import { productionJobPrewriteCode } from './production-execution-failure.mjs';
import { OzonDEPreflightEvidenceError } from './ozon-de-preflight-provider.mjs';
import { createDBatchAssetTransport, readDBatchAssetTransportProof,
  reconcileExpiredDBatchAssetTransport } from './d-batch-asset-transport.mjs';
import {createDBatchInSaleSoftwareService} from './d-batch-in-sale-software-service.mjs';
import {supportedBatchVersion,supportsPostImportBatch} from './d-batch-production-contract.mjs';
import {assertOzonBatchImportLimitCapability} from './ozon-product-import-batch-limit.mjs';
import {reconcileDBatchEVerifications} from './d-batch-e-verification.mjs';

const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim() !== '';
const stockBoundaryFailures = new Set([
  'D_BATCH_STOCK_SCOPE_CHANGED','D_BATCH_STOCK_MEMBER_CHANGED','D_BATCH_STOCK_IMPORT_SOURCE_CHANGED',
  'D_BATCH_STOCK_WORKER_NOT_CURRENT','D_BATCH_STOCK_WORKER_SCOPE_CHANGED',
  'D_BATCH_STOCK_MEMBER_NOT_READY','D_BATCH_STOCK_WRITE_LEASE_EXPIRED',
  'D_BATCH_STOCK_READ_GUARD_BLOCKED','D_BATCH_STOCK_WRITE_GUARD_BLOCKED',
  'D_BATCH_STOCK_READ_TIMEOUT','D_BATCH_STOCK_WRITE_TIMEOUT',
  'D_BATCH_SERVICE_BINDING_NOT_REGISTERED','D_BATCH_SERVICE_MEMBER_CHANGED'
]);
const stockFailureEvents = new Set(['precheck_blocked','prerequisites_failed',
  'stock_prewrite_blocked','stock_unknown']);
function stockFailureCode(error) {
  if (error instanceof OzonDEHttpTransportError && !error.cause) return 'transport_failure';
  const productionCode = productionJobPrewriteCode(error);
  if (productionCode !== null) return productionCode;
  return error?.constructor === Error && stockBoundaryFailures.has(error.message) ? error.message : null;
}
function knownEReadbackFailure(error,signal){
  if(error===signal.reason && signal.aborted)return 'request_timeout';
  if(error instanceof OzonDEHttpTransportError && !error.cause)return 'transport_failure';
  if(error instanceof OzonDEPreflightEvidenceError &&
      error.code==='OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED')return error.code;
  const code=productionJobPrewriteCode(error);
  if(code!==null)return code;
  if(error?.constructor!==Error)return null;
  const boundaryCode=error.message.split(':',1)[0];
  if(['D_BATCH_E_WORKER_NOT_CURRENT','D_BATCH_E_WORKER_SCOPE_CHANGED',
    'D_BATCH_E_READ_EVIDENCE_NOT_READY','D_BATCH_SERVICE_BINDING_NOT_REGISTERED'].includes(boundaryCode))return boundaryCode;
  return ['OZON_DE_READBACK_IDENTITY_MISMATCH','OZON_DE_READBACK_PRICE_INVALID'].includes(boundaryCode)
    ?'platform_data_invalid':null;
}

function savedBatch(document, batchId) {
  const matches = document.runtime?.dProductionBatches?.filter(batch => batch.batchId === batchId);
  if (matches?.length !== 1 || !supportedBatchVersion(matches[0].schemaVersion)) {
    throw new Error('D_BATCH_SERVICE_BATCH_NOT_UNIQUE');
  }
  return matches[0];
}

function candidateFor(document, saved) {
  const matches = document.candidates.filter(candidate => candidate.id === saved.candidateId);
  if (matches.length !== 1) throw new Error('D_BATCH_SERVICE_CANDIDATE_NOT_UNIQUE');
  const candidate = matches[0], sku = candidate.lifecycleV11?.skuPackage;
  if (candidate.dataRevision !== saved.resultRevision || sku?.skuPackageId !== saved.skuPackageId ||
      sku?.productionAuthorization?.authorizationId !== saved.authorizationId ||
      fingerprintCanonicalRecord(sku.productionAuthorization) !== saved.authorizationFingerprint ||
      sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord) {
    throw new Error('D_BATCH_SERVICE_MEMBER_CHANGED');
  }
  return candidate;
}

function memberGrouping(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  const choices = candidate.sourceCapture?.skuChoices;
  const color = choices?.length === 1 && choices[0].sourceSkuId === sku.supplierSkuId
    ? choices[0].attributes?.颜色 : null;
  const model = candidate.siblingSourceV1?.parentCardBinding?.model;
  if (!text(color) || !text(model)) throw new Error('D_BATCH_SERVICE_GROUPING_UNVERIFIED');
  return { colorKey: color.trim(), modelKey: model.trim() };
}

function sameProtocol(a,b){
  if(!text(a?.evidenceRef)||!text(b?.evidenceRef))return false;
  const {evidenceRef:aRef,...aFacts}=a;
  const {evidenceRef:bRef,...bFacts}=b;
  return text(aRef)&&text(bRef)&&isDeepStrictEqual(aFacts,bFacts);
}
function assertBatchImportLimit(productImport,checkedAt,batch){
  if(batch.schemaVersion==='d-batch-production-authorization-v3')
    return assertOzonBatchImportLimitCapability(productImport,{batch,checkedAt});
  if(!Number.isSafeInteger(productImport?.maxItemsPerRequest)||
      productImport.maxItemsPerRequest<1||productImport.maxItemsPerRequest>100||
      !text(productImport.limitEvidenceRef)||!text(productImport.limitObservedAt)||
      !text(productImport.validUntil)||!Number.isFinite(Date.parse(productImport.limitObservedAt))||
      !Number.isFinite(Date.parse(productImport.validUntil)))
    throw new Error('D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED');
  if(!Number.isFinite(Date.parse(checkedAt))||
      Date.parse(checkedAt)<Date.parse(productImport.limitObservedAt)||
      Date.parse(checkedAt)>=Date.parse(productImport.validUntil))
    throw new Error('D_BATCH_SERVICE_LIMIT_NOT_CURRENT');
}
function combineCapabilities(members, batch,checkedAt) {
  const first = members[0].adapterCapabilities;
  if (first?.status !== 'ready' || !sameStoreRef(first.storeRef, batch.storeRef)) {
    throw new Error('D_BATCH_SERVICE_CAPABILITIES_NOT_READY');
  }
  const fields = ['platform','store','storeRef','warehouseRef','credentialAlias','warehouseId',
    'adapterVersion','protocolVersion'];
  const assets = new Map();
  for (const member of members) {
    const capability = member.adapterCapabilities;
    if (capability?.status !== 'ready' || fields.some(field => !isDeepStrictEqual(capability[field], first[field])) ||
        ['productImport','inventoryWrite','independentReadback'].some(field =>
          !sameProtocol(capability[field], first[field])) ||
        capability.assetTransport?.status !== 'verified' ||
        !isDeepStrictEqual(capability.assetTransport.approvedHosts, first.assetTransport?.approvedHosts)) {
      throw new Error('D_BATCH_SERVICE_ACCOUNT_EVIDENCE_CONFLICT');
    }
    for (const asset of capability.assetTransport.resolvedAssets) {
      const prior = assets.get(asset.assetId);
      if (prior && !isDeepStrictEqual(prior, asset)) throw new Error('D_BATCH_SERVICE_ASSET_ID_CONFLICT');
      assets.set(asset.assetId, asset);
    }
  }
  assertBatchImportLimit(first.productImport,checkedAt,batch);
  return { ...clone(first), assetTransport: { ...clone(first.assetTransport), resolvedAssets: [...assets.values()].map(asset => clone(asset)) } };
}

function sameCurrentCapabilities(saved, checked) {
  const { inspectedAt: savedAt, ...savedFacts } = saved;
  const { inspectedAt: checkedAt, ...checkedFacts } = checked;
  return text(savedAt) && text(checkedAt) && isDeepStrictEqual(savedFacts, checkedFacts);
}

/** Builds only from saved batch members, current bindings and persisted account evidence. */
export function createDBatchImportSoftwareService({ repository, runtimeMode, workerRegistry, serverClock,
  services, loadCurrentProductionBinding, loadBatchMemberEvidence, loadBatchEReadEvidence, loadBatchObservationPolicy,
  loadBatchInSaleListEvidence=null,
  requestJson,upload=null,resolveLocalAsset=null }) {
  if (typeof loadBatchMemberEvidence !== 'function' || typeof loadBatchEReadEvidence !== 'function' || typeof requestJson !== 'function') {
    throw new Error('D_BATCH_SERVICE_DEPENDENCY_REQUIRED');
  }
  if (typeof loadBatchObservationPolicy !== 'function') throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_REQUIRED');
  const resolveService = candidate => {
    const bindingId = candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.bindingId;
    const service = services.get(bindingId);
    if (!service) throw new Error('D_BATCH_SERVICE_BINDING_NOT_REGISTERED');
    const binding = loadCurrentProductionBinding(candidate, service);
    if (!binding || binding.then) throw new Error('D_BATCH_SERVICE_CURRENT_BINDING_REQUIRED');
    return { service, binding };
  };
  function currentObservationPolicy(candidate,binding,batch,checkedAt){
    const policy=loadBatchObservationPolicy({candidate:clone(candidate),
      productionBinding:clone(binding),batch:clone(batch)});
    if(!policy)throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_MISSING');
    assertDPlatformObservationPolicy(policy);
    if(Date.parse(checkedAt)>=Date.parse(policy.expiresAt)||
        Date.parse(policy.expiresAt)-Date.parse(checkedAt)<
          policy.maxQueries*policy.intervalMs+policy.requestTimeoutMs)
      throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_NOT_CURRENT');
    return clone(policy);
  }
  async function runBatchAssetTransport(document,batch){
    const sources=batch.members.map(saved=>{
      const candidate=candidateFor(document,saved);
      return {candidate,...resolveService(candidate)};
    });
    if(sources.length===0)throw new Error('D_BATCH_SERVICE_EMPTY_BATCH');
    const workerId=sources[0].service.worker.workerId;
    if(sources.some(({service})=>service.worker.workerId!==workerId))
      throw new Error('D_BATCH_SERVICE_WORKER_CONFLICT');
    const leaseDurationMs=sources[0].service.binding?.leaseDurationMs;
    if(!Number.isSafeInteger(leaseDurationMs)||leaseDurationMs<1000||leaseDurationMs>1_800_000)
      throw new Error('D_BATCH_SERVICE_ASSET_LEASE_REQUIRED');
    if(sources.some(({service})=>service.binding?.leaseDurationMs!==leaseDurationMs))
      throw new Error('D_BATCH_SERVICE_ASSET_LEASE_CONFLICT');
    let observationPolicy=null,importProtocol=null;
    const runtime=createDBatchAssetTransport({repository,runtimeMode,workerRegistry,serverClock,
      upload,resolveLocalAsset,leaseDurationMs,
      loadCurrentProductionBinding:({candidate})=>resolveService(candidate).binding,
      getBatchMemberEvidence:async input=>{
        const evidence=await loadBatchMemberEvidence({...input,purpose:'new_import'});
        if(observationPolicy===null){
          for(const {candidate,binding} of sources){
            const policy=currentObservationPolicy(candidate,binding,batch,serverClock());
            if(observationPolicy!==null&&!isDeepStrictEqual(policy,observationPolicy))
              throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_CONFLICT');
            observationPolicy=policy;
            memberGrouping(candidate);
          }
        }
        const policy=currentObservationPolicy(input.candidate,input.productionBinding,input.batch,serverClock());
        if(!isDeepStrictEqual(policy,observationPolicy))
          throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_CONFLICT');
        assertBatchImportLimit(evidence.capabilities?.productImport,serverClock(),batch);
        if(importProtocol!==null&&!sameProtocol(evidence.capabilities.productImport,importProtocol))
          throw new Error('D_BATCH_SERVICE_ACCOUNT_EVIDENCE_CONFLICT');
        importProtocol=clone(evidence.capabilities.productImport);
        return evidence;
      }});
    return runtime.run({batchId:batch.batchId,workerId});
  }
  async function prepare(batchId, createdAt = serverClock()) {
    const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
    if (!['authorized','import_admitted','claimed','waiting_platform','partial_failure','unknown_outcome',
      'imported_awaiting_inventory'].includes(batch.status)) {
      throw new Error('D_BATCH_SERVICE_BATCH_NOT_RUNNABLE');
    }
    const members = [];
    const planCreatedAt=supportsPostImportBatch(batch.schemaVersion)
      ?batch.confirmedAt:createdAt;
    if(!text(planCreatedAt)||Number.isNaN(Date.parse(planCreatedAt)))
      throw new Error('D_BATCH_SERVICE_PLAN_TIME_REQUIRED');
    let workerId = null;
    for (const saved of batch.members) {
      const candidate = candidateFor(document, saved);
      const { service, binding } = resolveService(candidate);
      if (workerId !== null && workerId !== service.worker.workerId) throw new Error('D_BATCH_SERVICE_WORKER_CONFLICT');
      workerId = service.worker.workerId;
      const observationPolicy=currentObservationPolicy(candidate,binding,batch,serverClock());
      if (members.length > 0 && !isDeepStrictEqual(observationPolicy, members[0].observationPolicy)) {
        throw new Error('D_BATCH_SERVICE_OBSERVATION_POLICY_CONFLICT');
      }
      const sku = candidate.lifecycleV11.skuPackage;
      const batchAssetProof=readDBatchAssetTransportProof({document,batchId,candidateId:candidate.id});
      const plan = batchAssetProof?.productionPlan ?? sku.dAssetTransport?.intent?.productionPlan ?? createProductionPlan({
        productionAuthorization: sku.productionAuthorization, candidateId: candidate.id,
        candidateRevision: candidate.dataRevision, skuPackage: sku, createdAt:planCreatedAt });
      const evidence = await loadBatchMemberEvidence({ candidate: clone(candidate), productionBinding: clone(binding), batch: clone(batch) });
      const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: evidence.checkedAt,
        inspectPlatform: async () => clone(evidence.inspection) });
      const prepared = prepareSingleSkuDExecution({ productionPlan: plan,
        productionAuthorization: plan.sourceAuthorization, platformWritePreflight: preflight,
        adapterCapabilities: evidence.capabilities, currentProductionBinding: binding, preparedAt: evidence.checkedAt });
      if (prepared.status !== 'ready') throw new Error(`D_BATCH_SERVICE_MEMBER_NOT_READY:${candidate.id}:${prepared.gaps.map(gap => gap.code).join(',')}`);
      const grouping = memberGrouping(candidate);
      members.push({ request: prepared.executableRequest, executionContext: { productionPlan: plan,
        currentProductionBinding: binding, serverClock: () => evidence.checkedAt },
      platformWritePreflight: preflight, adapterCapabilities: evidence.capabilities,
      ...grouping, sourceTechnicalStatus: 'not_started', observationPolicy });
    }
    return { batch, members, adapterCapabilities: combineCapabilities(members,batch,serverClock()), workerId,
      accountReadState: ozonAccountReadCoordinationState({ document, candidateIds: batch.members.map(member => member.candidateId) }) };
  }
  function observationSource(document,batchId,chunkIndex){
    const batch = savedBatch(document, batchId);
    const jobs = document.runtime?.dBatchImportJobs?.filter(job => job.batchId === batchId) ?? [];
    if (jobs.length !== 1 || !Number.isSafeInteger(chunkIndex) ||
        !['waiting_platform','observed_pending','unknown_outcome'].includes(jobs[0].chunks[chunkIndex]?.status) ||
        !text(jobs[0].chunks[chunkIndex].taskId)) throw new Error('D_BATCH_SERVICE_OBSERVATION_TASK_REQUIRED');
    const offerId = jobs[0].chunks[chunkIndex].offerIds[0];
    const saved = batch.members.filter(member => member.offerId === offerId);
    if (saved.length !== 1) throw new Error('D_BATCH_SERVICE_OBSERVATION_MEMBER_MISSING');
    const candidate = candidateFor(document, saved[0]);
    return {batch,job:jobs[0],candidate};
  }
  async function prepareObservation({batch,candidate}) {
    const { service, binding } = resolveService(candidate);
    const evidence = await loadBatchMemberEvidence({ candidate: clone(candidate),
      productionBinding: clone(binding), batch: clone(batch),purpose:'import_observation' });
    const capability = evidence.capabilities;
    if (capability?.status !== 'ready' || !sameStoreRef(capability.storeRef, batch.storeRef) ||
        capability.productImport?.status !== 'verified' ||
        capability.productImport?.endpoint !== '/v3/product/import' ||
        capability.productImport?.statusEndpoint !== '/v1/product/import/info' ||
        !text(capability.productImport.protocolVersion) || !text(capability.productImport.evidenceRef)) {
      throw new Error('D_BATCH_SERVICE_OBSERVATION_EVIDENCE_NOT_READY');
    }
    return { adapterCapabilities: capability, workerId: service.worker.workerId };
  }
  const runtime = createPersistedDBatchImportRuntime({ repository, runtimeMode, workerRegistry, serverClock,
    createAdapter: async ({ adapterCapabilities }) => createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities }),
    verifyCurrentBatchEvidence: async ({ batchId, members, adapterCapabilities, chunkIndex }) => {
      const checked = await prepare(batchId, members[0].executionContext.productionPlan.createdAt);
      if (checked.workerId === null || !sameCurrentCapabilities(adapterCapabilities, checked.adapterCapabilities) ||
          members.length !== checked.members.length || members.some((member, index) =>
            !isDeepStrictEqual(member.request, checked.members[index].request) ||
            !isDeepStrictEqual(member.observationPolicy, checked.members[index].observationPolicy)) ||
          !Number.isSafeInteger(chunkIndex)) throw new Error('D_BATCH_SERVICE_EVIDENCE_DRIFT');
    } });
  async function observeBatchChunk({batchId,chunkIndex}){
    const document=await repository.readSnapshot();
    const source=observationSource(document,batchId,chunkIndex);
    let ready;
    try{ready=await prepareObservation(source);}
    catch(error){
      const reason=error?.constructor!==Error?undefined:
        error.message==='D_BATCH_SERVICE_OBSERVATION_EVIDENCE_NOT_READY'?'evidence_not_ready':
        error.message==='D_BATCH_SERVICE_BINDING_NOT_REGISTERED'?'service_not_configured':undefined;
      if(reason===undefined)throw error;
      const job=await runtime.blockObservation({batchId,chunkIndex,reason,
        expectedSource:source.job,expectedBatch:source.batch});
      return {status:'observation_stopped',reason,job};
    }
    return runtime.observe({batchId,members:[],adapterCapabilities:ready.adapterCapabilities,
      workerId:ready.workerId,chunkIndex});
  }
  let activeObservation = null;
  async function runDueBatchObservations() {
    return runDueBatchObservationsFromSnapshot(null);
  }
  async function runDueBatchObservationsFromSnapshot(snapshot) {
    if (activeObservation) return activeObservation;
    activeObservation = (async () => {
      const document = snapshot ?? await repository.readSnapshot(), observedAt = serverClock();
      for (const job of document.runtime?.dBatchImportJobs ?? []) {
        if (!['d-batch-import-job-v2','d-batch-import-job-v3','d-batch-import-job-v4'].includes(job.schemaVersion))
          throw new Error('D_BATCH_SERVICE_JOB_VERSION_INVALID');
        for (const chunk of job.chunks) {
          if (chunk.taskId === null ||
              !['waiting_platform','observed_pending','unknown_outcome'].includes(chunk.status)) continue;
          if (Date.parse(observedAt) >= Date.parse(job.leaseExpiresAt)) {
            await runtime.reclaim({ batchId: job.batchId, workerId: job.workerId });
          } else if (chunk.observationInFlight) continue;
          if (Date.parse(observedAt) >= Date.parse(job.observationPolicy.expiresAt) ||
              chunk.observationReads >= job.observationPolicy.maxQueries) {
            const reason = chunk.observationReads >= job.observationPolicy.maxQueries ? 'query_limit' : 'policy_expired';
            const stopped = await runtime.stopObservation({ batchId: job.batchId,
              workerId: job.workerId, chunkIndex: chunk.index, reason });
            return { status: 'observation_stopped', reason, job: stopped };
          }
          if (Date.parse(observedAt) < Date.parse(chunk.nextObservationAt)) continue;
          return observeBatchChunk({batchId:job.batchId,chunkIndex:chunk.index});
        }
      }
      return { status: 'idle' };
    })();
    try { return await activeObservation; } finally { activeObservation = null; }
  }
  function stockSource(document,stockJob){
    const batch=savedBatch(document,stockJob.batchId);
    if(!supportsPostImportBatch(batch.schemaVersion)||
        batch.postImportScope?.inventoryAction!==stockJob.inventoryAction||
        !batch.postImportScope.eReadbackOfferIds.includes(stockJob.offerId))
      throw new Error('D_BATCH_STOCK_SCOPE_CHANGED');
    const matching=batch.members.filter(member=>member.offerId===stockJob.offerId);
    if(matching.length!==1||matching[0].candidateId!==stockJob.candidateId||
        matching[0].skuPackageId!==stockJob.skuPackageId||
        matching[0].authorizationId!==stockJob.authorizationId||
        matching[0].authorizationFingerprint!==stockJob.authorizationFingerprint)
      throw new Error('D_BATCH_STOCK_MEMBER_CHANGED');
    const importJobs=document.runtime?.dBatchImportJobs?.filter(job=>job.batchId===batch.batchId)??[];
    const observations=importJobs.flatMap(job=>job.chunks.flatMap(chunk=>(chunk.results??[])
      .filter(result=>result.offerId===stockJob.offerId)
      .map(result=>({chunk,chunkIndex:chunk.index,taskId:chunk.taskId,result}))));
    if(importJobs.length!==1||observations.length!==1||observations[0].taskId!==stockJob.taskId||
        observations[0].result.classification!=='imported'||
        observations[0].result.importObservation?.productId!==stockJob.productId)
      throw new Error('D_BATCH_STOCK_IMPORT_SOURCE_CHANGED');
    return {batch,member:matching[0],candidate:candidateFor(document,matching[0]),
      importChunk:observations[0].chunk,
      chunkIndex:observations[0].chunkIndex,
      importObservation:observations[0].result.importObservation};
  }
  function batchEReadbackSource(document,stockJob){
    const source=stockSource(document,stockJob);
    const frozen=assertDBatchFrozenImport(source.importChunk.frozenImport,source.importChunk.offerIds);
    const position=source.importChunk.offerIds.indexOf(stockJob.offerId);
    if(position<0||frozen.items[position].offer_id!==stockJob.offerId)
      throw new Error('D_BATCH_E_FROZEN_SOURCE_MISSING');
    const sourceRequest=frozen.memberSources[position];
    return {source,sourceRequest};
  }
  async function prepareBatchEReadback(document,stockJob){
    const {source,sourceRequest}=batchEReadbackSource(document,stockJob);
    const {service,binding}=resolveService(source.candidate);
    if(service.worker.workerId!==stockJob.workerId||
        binding.bindingId!==source.candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.bindingId)
      throw new Error('D_BATCH_E_WORKER_SCOPE_CHANGED');
    const evidence=await loadBatchEReadEvidence({candidate:clone(source.candidate),
      productionBinding:clone(binding),batch:clone(source.batch),offerId:stockJob.offerId});
    const capability=evidence.capabilities;
    if(capability?.platform!=='ozon'||
        !sameStoreRef(capability.storeRef,source.batch.storeRef)||
        !sameStoreRef(capability.storeRef,sourceRequest.storeRef)||
        capability.store!==sourceRequest.store||capability.warehouseRef!==sourceRequest.warehouseRef||
        capability.credentialAlias!==sourceRequest.credentialAlias||
        capability.warehouseId!==sourceRequest.warehouseId||
        capability.independentReadback?.status!=='verified'||
        capability.independentReadback.protocolVersion!=='ozon-independent-readback-v2'||
        !text(capability.independentReadback.evidenceRef)||
        !isDeepStrictEqual(capability.independentReadback.endpoints,OZON_DE_READBACK_ENDPOINTS))
      throw new Error('D_BATCH_E_READ_EVIDENCE_NOT_READY');
    // Readback is gated by the current read protocol and a transport that rejects writes.
    // The seller adapter's constructor also carries write capability fields, which are
    // deliberately not reused as authorization for this independent observation.
    return {source:sourceRequest,capabilities:{...clone(capability),status:'ready',
      inventoryWrite:{warehouseId:sourceRequest.warehouseId,prerequisitePolicy:null}}};
  }
  function inSaleSource(document,batch){
    if(batch.schemaVersion!=='d-batch-production-authorization-v3')return null;
    const imports=document.runtime?.dBatchImportJobs?.filter(job=>job.batchId===batch.batchId)??[];
    if(imports.length>1)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
    if(imports.length===0)return null;
    const targets=[];let first=null;
    for(const member of batch.members){
      const stockJobs=(document.runtime.dBatchStockJobs??[]).filter(job=>job.batchId===batch.batchId&&job.offerId===member.offerId);
      if(stockJobs.length>1)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
      const stock=stockJobs[0];
      if(!stock){
        const chunk=imports[0].chunks.find(value=>value.offerIds.includes(member.offerId));
        if(!chunk)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
        const result=chunk?.results?.find(value=>value.offerId===member.offerId);
        const stoppedWithoutTask=chunk.status==='prewrite_blocked'||
          chunk.status==='unknown_outcome'&&chunk.taskId===null;
        const unsentBehindStop=chunk.status==='not_sent'&&imports[0].chunks.slice(0,chunk.index)
          .some(prior=>prior.status==='prewrite_blocked'||prior.status==='unknown_outcome'&&prior.taskId===null);
        if(['platform_failed','platform_skipped'].includes(result?.classification)||
            chunk.status==='observation_stopped'||stoppedWithoutTask||unsentBehindStop)continue;
        return null;
      }
      if(['needs_owner','precheck_failed','prewrite_blocked','unknown_outcome'].includes(stock.status))continue;
      if(!['inventory_deferred','stock_accepted'].includes(stock.status))return null;
      const jobs=(document.runtime.dBatchEJobs??[]).filter(job=>job.batchId===batch.batchId&&job.offerId===member.offerId);
      if(jobs.length>1)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
      if(jobs.length===0||!['completed','read_failed','observation_stopped'].includes(jobs[0].status))return null;
      if(jobs[0].status!=='completed')continue;
      const {source,sourceRequest}=batchEReadbackSource(document,stock);
      const records=(document.runtime.dBatchOfferRecords??[]).filter(record=>record.recordId===jobs[0].recordId);
      const projected=createDBatchOfferRecord({batch,member,chunkIndex:source.chunkIndex,stockJob:stock,
        source:sourceRequest,frozenImport:source.importChunk.frozenImport,chunkOfferIds:source.importChunk.offerIds,
        importObservation:source.importObservation,createdAt:stock.createdAt});
      const readbacks=(document.runtime.dBatchEReadbacks??[]).filter(readback=>readback.readbackId===jobs[0].resultId);
      if(records.length!==1||!isDeepStrictEqual(records[0],projected)||readbacks.length!==1||
          readbacks[0].sourceRecordId!==projected.recordId)throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
      if(readbacks[0].observation===null)continue;
      const {service,binding}=resolveService(source.candidate);
      const routing={storeRef:clone(batch.storeRef),warehouseRef:sourceRequest.warehouseRef,
        warehouseId:sourceRequest.warehouseId,credentialAlias:sourceRequest.credentialAlias,
        bindingId:binding.bindingId,configurationVersion:binding.configurationVersion};
      if(first&&(first.workerId!==stock.workerId||first.workerVersion!==stock.workerVersion||
          !isDeepStrictEqual(first.routing,routing)))throw new Error('D_BATCH_IN_SALE_SOURCE_CHANGED');
      if(service.worker.workerId!==stock.workerId)throw new Error('D_BATCH_IN_SALE_WORKER_NOT_CURRENT');
      first??={routing,workerId:stock.workerId,workerVersion:stock.workerVersion,
        evidenceInput:{candidate:clone(source.candidate),productionBinding:clone(binding),batch:clone(batch),offerId:member.offerId}};
      targets.push({candidateId:member.candidateId,skuPackageId:member.skuPackageId,
        sourceRevision:member.resultRevision,sourceRecordId:projected.recordId,
        authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,
        offerId:member.offerId,productId:projected.productId});
    }
    if(targets.length===0)return null;
    return {scope:{schemaVersion:'ozon-in-sale-list-scope-v1',batchId:batch.batchId,
      authorizationRef:`${batch.batchId}:in-sale-list`,
      officialEvidenceRef:batch.postImportScope.inSaleList.officialEvidenceRef,...first.routing,targets},
      policy:clone(batch.postImportScope.inSaleList.policy),workerId:first.workerId,
      workerVersion:first.workerVersion,evidenceInput:first.evidenceInput};
  }
  const inSaleService=createDBatchInSaleSoftwareService({repository,runtimeMode,workerRegistry,serverClock,
    resolveSource:inSaleSource,loadEvidence:loadBatchInSaleListEvidence,requestJson});
  function eligibleStockWorker(stockJob){
    const worker=workerRegistry.findEligible(['ozon-production-execution'])
      .find(value=>value.workerId===stockJob.workerId);
    if(!worker||worker.version!==stockJob.workerVersion)
      throw new Error('D_BATCH_STOCK_WORKER_NOT_CURRENT');
    return worker;
  }
  function assertStockJobIdentity(held,expected){
    if(['batchId','candidateId','skuPackageId','offerId','taskId','productId',
      'authorizationId','authorizationFingerprint','inventoryAction','eReadbackRequired',
      'workerId','workerVersion','observationPolicy','createdAt','leaseDurationMs'].some(field=>
        !isDeepStrictEqual(held[field],expected[field])))
      throw new Error('D_BATCH_STOCK_CHECKPOINT_SOURCE_CHANGED');
  }
  async function stockCheckpoint(stockJob,event){
    return repository.transact(document=>{
      const jobs=document.runtime?.dBatchStockJobs;
      if(!Array.isArray(jobs))throw new Error('D_BATCH_STOCK_STORE_INVALID');
      const matches=jobs.filter(job=>job.jobId===stockJob.jobId);
      if(matches.length!==1)throw new Error('D_BATCH_STOCK_JOB_NOT_UNIQUE');
      assertStockJobIdentity(matches[0],stockJob);
      // A changed source is a reason to stop the job. It must not prevent that
      // failure from being saved; only forward progress needs the live source.
      if(!stockFailureEvents.has(event.kind))stockSource(document,matches[0]);
      const next=applyDBatchStockEvent({job:matches[0],event:{...event,offerId:stockJob.offerId,
        taskId:stockJob.taskId,productId:stockJob.productId},workerId:stockJob.workerId,
        leaseId:stockJob.leaseId,observedAt:serverClock()});
      jobs[jobs.indexOf(matches[0])]=next;
      return {changed:true,document,result:clone(next)};
    });
  }
  async function settleStockFailure(job,error){
    const failure=error instanceof OzonDEHttpTransportError && error.cause instanceof Error
      ?error.cause:error;
    const code=stockFailureCode(failure);
    const snapshot=await repository.readSnapshot();
    const held=snapshot.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
    if(!held)throw error;
    // Another holder or another completed transition cannot be rewritten by a
    // stale invocation, even if this invocation has a useful failure to report.
    if(held.leaseId!==job.leaseId || held.revision!==job.revision){
      if(code===null)throw failure;
      return {status:'idempotent_replay',job:clone(held)};
    }
    const reason=code??'system_failure';
    let event;
    if(held.status==='awaiting_prerequisites')event={kind:'precheck_blocked',reason};
    else if(held.status==='prerequisites_in_flight')event={kind:'prerequisites_failed',reason};
    else if(held.status==='ready_to_write')event={kind:'stock_prewrite_blocked',reason,
      requestTransmission:'not_attempted'};
    else if(held.status==='stock_intent'){
      const transportNotAttempted=error instanceof OzonDEHttpTransportError &&
        error.externalRequestState==='not_sent' && error.requestTransmission==='not_attempted';
      event=transportNotAttempted
        ?{kind:'stock_prewrite_blocked',reason,requestTransmission:'not_attempted'}
        :{kind:'stock_unknown',reason};
    }else{
      if(code===null)throw failure;
      return {status:held.status,job:clone(held)};
    }
    let stopped;
    try{stopped=await stockCheckpoint(job,event);}
    catch(checkpointError){throw new AggregateError([error,checkpointError],
      'D_BATCH_STOCK_FAILURE_CHECKPOINT_FAILED');}
    if(code===null)throw failure;
    return {status:stopped.status,job:stopped};
  }
  async function prepareStock(stockJob){
    const document=await repository.readSnapshot();
    const {batch,candidate,importObservation}=stockSource(document,stockJob);
    const {service,binding}=resolveService(candidate);
    if(service.worker.workerId!==stockJob.workerId)
      throw new Error('D_BATCH_STOCK_WORKER_SCOPE_CHANGED');
    const sku=candidate.lifecycleV11.skuPackage;
    if(!text(batch.confirmedAt)||Number.isNaN(Date.parse(batch.confirmedAt)))
      throw new Error('D_BATCH_STOCK_PLAN_TIME_REQUIRED');
    const batchAssetProof=readDBatchAssetTransportProof({document,batchId:batch.batchId,candidateId:candidate.id});
    const plan=batchAssetProof?.productionPlan??sku.dAssetTransport?.intent?.productionPlan??createProductionPlan({
      productionAuthorization:sku.productionAuthorization,candidateId:candidate.id,
      candidateRevision:candidate.dataRevision,skuPackage:sku,createdAt:batch.confirmedAt});
    const evidence=await loadBatchMemberEvidence({candidate:clone(candidate),
      productionBinding:clone(binding),batch:clone(batch),purpose:'stock_write'});
    const preflight=await runPlatformWritePreflight({productionPlan:plan,checkedAt:evidence.checkedAt,
      inspectPlatform:async()=>clone(evidence.inspection)});
    const prepared=prepareSingleSkuDExecution({productionPlan:plan,
      productionAuthorization:plan.sourceAuthorization,platformWritePreflight:preflight,
      adapterCapabilities:evidence.capabilities,currentProductionBinding:binding,preparedAt:evidence.checkedAt});
    if(prepared.status!=='ready'||prepared.executableRequest.merchantSku!==stockJob.offerId||
        !sameStoreRef(evidence.capabilities.storeRef,batch.storeRef))
      throw new Error('D_BATCH_STOCK_MEMBER_NOT_READY');
    const request=prepared.executableRequest;
    const query={platform:request.platform,store:request.store,storeRef:request.storeRef,
      warehouseRef:request.warehouseRef,credentialAlias:request.credentialAlias,
      warehouseId:request.inventoryWrite.warehouseId,writeAllowed:false,
      merchantSku:request.merchantSku,supplierSkuId:request.supplierSkuId,
      executionKey:request.executionKey,requestReceiptRef:importObservation.requestReceiptRef,
      taskId:stockJob.taskId,productId:stockJob.productId};
    return {request,query,capabilities:evidence.capabilities,executionContext:{productionPlan:plan,
      currentProductionBinding:binding,serverClock}};
  }
  let activeStockPrerequisites=null;
  async function runDueBatchStockPrerequisites(){
    if(activeStockPrerequisites)return activeStockPrerequisites;
    activeStockPrerequisites=performDueBatchStockPrerequisites();
    try{return await activeStockPrerequisites;}finally{activeStockPrerequisites=null;}
  }
  async function performDueBatchStockPrerequisites(){
    const document=await repository.readSnapshot();
    for(const saved of document.runtime?.dBatchStockJobs??[]){
      if(saved.status==='prerequisites_in_flight' &&
          Date.parse(serverClock())>=Date.parse(saved.leaseExpiresAt)){
        const stopped=await stockCheckpoint(saved,{kind:'prerequisites_failed',
          reason:'prerequisite_read_interrupted'});
        return {status:stopped.status,job:stopped};
      }
      if(saved.status!=='awaiting_prerequisites')continue;
      let job=saved;
      try{
        if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)){
          const worker=eligibleStockWorker(job);
          job=await repository.transact(current=>{
            const jobs=current.runtime?.dBatchStockJobs??[];
            const held=jobs.find(value=>value.jobId===saved.jobId);
            if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
            stockSource(current,held);
            const at=serverClock();
            const next=reclaimDBatchStockJob({job:held,workerId:worker.workerId,
              workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
              leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
            jobs[jobs.indexOf(held)]=next;
            return {changed:true,document:current,result:clone(next)};
          });
        }
        eligibleStockWorker(job);
        if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
          return {status:'precheck_failed',job:await stockCheckpoint(job,{kind:'precheck_blocked',reason:'policy_expired'})};
        const ready=await prepareStock(job);
        job=await stockCheckpoint(job,{kind:'prerequisites_started'});
        const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson,adapterCapabilities:ready.capabilities,
          executionContext:ready.executionContext});
        const beforeRequestSend=async()=>{
          eligibleStockWorker(job);
          const latest=await repository.readSnapshot();
          const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
          if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
          assertStockJobIdentity(held,job);
          stockSource(latest,held);
          if(held.leaseId!==job.leaseId||held.status!=='prerequisites_in_flight'||
              Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
              Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
            throw new Error('D_BATCH_STOCK_READ_GUARD_BLOCKED');
        };
        const controller=new AbortController();
        const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
          Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
          Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
        const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_STOCK_READ_TIMEOUT')),
          Math.max(1,timeoutMs));
        try{
          const priceSentObservation=await adapter.observePriceSent(ready.query,
            {signal:controller.signal,beforeRequestSend});
          const inventoryPrerequisiteObservation=await adapter.observeInventoryPrerequisites(ready.query,
            {signal:controller.signal,beforeRequestSend});
          const next=await stockCheckpoint(job,{kind:'prerequisites_observed',priceSentObservation,
            inventoryPrerequisiteObservation});
          return {status:next.status,job:next};
        }finally{clearTimeout(timer);}
      }catch(error){return settleStockFailure(job,error);}
    }
    return {status:'idle'};
  }
  let activeStockWrites=null;
  async function runDueBatchStockWrites({allowedBatchIds=null}={}){
    if(activeStockWrites)return activeStockWrites;
    activeStockWrites=performDueBatchStockWrites({allowedBatchIds});
    try{return await activeStockWrites;}finally{activeStockWrites=null;}
  }
  async function performDueBatchStockWrites({allowedBatchIds}){
    const document=await repository.readSnapshot();
    for(const saved of document.runtime?.dBatchStockJobs??[]){
      if(saved.status==='stock_intent' &&
          Date.parse(serverClock())>=Date.parse(saved.leaseExpiresAt)){
        const stopped=await stockCheckpoint(saved,{kind:'stock_unknown',
          reason:'inventory_write_interrupted'});
        return {status:stopped.status,job:stopped};
      }
      if(saved.status!=='ready_to_write'||allowedBatchIds!==null&&!allowedBatchIds.has(saved.batchId))continue;
      let job=saved;
      try{
        if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)){
          const worker=eligibleStockWorker(job);
          job=await repository.transact(current=>{
            const jobs=current.runtime?.dBatchStockJobs??[];
            const held=jobs.find(value=>value.jobId===saved.jobId);
            if(!held||held.status!=='ready_to_write')throw new Error('D_BATCH_STOCK_JOB_CHANGED');
            stockSource(current,held);
            const at=serverClock();
            const next=reclaimDBatchStockJob({job:held,workerId:worker.workerId,
              workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
              leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
            jobs[jobs.indexOf(held)]=next;
            return {changed:true,document:current,result:clone(next)};
          });
        }
        eligibleStockWorker(job);
        const ready=await prepareStock(job);
        const policy=ready.capabilities.inventoryWrite?.prerequisitePolicy;
        if(!policy||fingerprintCanonicalRecord(policy)!==job.prerequisitePolicyFingerprint)
          return {status:'prewrite_blocked',job:await stockCheckpoint(job,
            {kind:'stock_prewrite_blocked',reason:'prerequisite_policy_changed',requestTransmission:'not_attempted'})};
        if(Date.parse(serverClock())>=Date.parse(job.leaseExpiresAt)||
            Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
          throw new Error('D_BATCH_STOCK_WRITE_LEASE_EXPIRED');
        const observation={priceSentObservation:{...clone(job.priceSentObservation),policy:clone(policy)},
          inventoryPrerequisiteObservation:{...clone(job.inventoryPrerequisiteObservation),policy:clone(policy)}};
        const assertAuthorization=async()=>{
          eligibleStockWorker(job);
          const latest=await repository.readSnapshot();
          const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
          if(!held)throw new Error('D_BATCH_STOCK_JOB_MISSING');
          assertStockJobIdentity(held,job);
          stockSource(latest,held);
          if(held.leaseId!==job.leaseId||!['ready_to_write','stock_intent'].includes(held.status)||
              held.observedFreeStock!==0||held.prerequisitePolicyFingerprint!==fingerprintCanonicalRecord(policy)||
              Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
              Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
            throw new Error('D_BATCH_STOCK_WRITE_GUARD_BLOCKED');
        };
        const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson,
          adapterCapabilities:ready.capabilities,executionContext:ready.executionContext});
        const controller=new AbortController();
        const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
          Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
          Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
        const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_STOCK_WRITE_TIMEOUT')),
          Math.max(1,timeoutMs));
        try{
          const result=await adapter.executeRemainingInventory(ready.request,{observation,
            assertRemainingInventoryAuthorization:assertAuthorization,
            beforeRequestSend:async()=>{
              await assertAuthorization();
              const current=await repository.readSnapshot();
              const held=current.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
              if(held?.status!=='stock_intent')throw new Error('D_BATCH_STOCK_INTENT_REQUIRED');
              assertStockJobIdentity(held,job);
            },signal:controller.signal,persistCheckpoint:async event=>{
              if(event.kind==='stock_intent')job=await stockCheckpoint(job,{kind:'stock_intent'});
              else if(event.kind==='stock_receipt_observed'){
                const accepted=event.updated===true&&event.itemCount===1&&event.errorCount===0&&
                  event.productId===job.productId&&event.merchantSku===job.offerId&&
                  event.warehouseId===ready.request.inventoryWrite.warehouseId;
                await stockCheckpoint(job,accepted?
                  {kind:'stock_receipt',accepted:true,inventoryReceiptRef:event.inventoryReceiptRef}:
                  {kind:'stock_unknown',reason:'inventory_receipt_incomplete_or_identity_mismatch'});
              }else throw new Error('D_BATCH_STOCK_CHECKPOINT_EVENT_INVALID');
            }});
          if(result.status==='blocked'){
            if(result.writeOccurred!==false||result.requestTransmission!=='not_attempted')
              throw new Error('D_BATCH_STOCK_ADAPTER_PREWRITE_PROOF_INVALID');
            const stopped=await stockCheckpoint(job,{kind:'stock_prewrite_blocked',
              reason:result.code,requestTransmission:'not_attempted'});
            return {status:stopped.status,job:stopped};
          }
          if(result.status==='unknown_outcome'){
            const latest=await repository.readSnapshot();
            const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
            if(held?.status==='stock_intent')return {status:'unknown_outcome',job:await stockCheckpoint(job,
              {kind:'stock_unknown',reason:result.reason})};
            if(held?.status==='unknown_outcome')return {status:'unknown_outcome',job:clone(held)};
          }
          const latest=await repository.readSnapshot();
          const held=latest.runtime?.dBatchStockJobs?.find(value=>value.jobId===job.jobId);
          if(result.status!=='accepted'||held?.status!=='stock_accepted')
            throw new Error('D_BATCH_STOCK_RESULT_CHECKPOINT_MISMATCH');
          return {status:'stock_accepted',job:clone(held)};
        }finally{clearTimeout(timer);}
      }catch(error){return settleStockFailure(job,error);}
    }
    return {status:'idle'};
  }
  function readbackForJob(job,record,fields){
    return createDBatchEReadback({record,...fields,readSequence:job.readCount,
      schemaVersion:job.schemaVersion===D_BATCH_E_JOB_VERSION
        ?D_BATCH_E_READBACK_VERSION:'d-batch-e-readback-v1'});
  }
  async function checkpointBatchE({stockJob,job,record,event,result=null}){
    return repository.transact(document=>{
      const jobs=document.runtime?.dBatchEJobs??[];
      const matches=jobs.filter(value=>value.jobId===job.jobId);
      if(matches.length!==1)throw new Error('D_BATCH_E_JOB_MISSING');
      const held=matches[0];
      if(['recordId','batchId','offerId','candidateId','authorizationId','workerVersion',
        'observationPolicy','createdAt','leaseDurationMs'].some(field=>
          !isDeepStrictEqual(held[field],job[field])))throw new Error('D_BATCH_E_RESULT_SCOPE_INVALID');
      const records=document.runtime?.dBatchOfferRecords?.filter(value=>value.recordId===record.recordId)??[];
      if(records.length!==1||!isDeepStrictEqual(records[0],record))throw new Error('D_BATCH_E_SOURCE_CONFLICT');
      if(held.readCount!==job.readCount)throw new Error('D_BATCH_E_JOB_READ_CHANGED');
      const stock=document.runtime?.dBatchStockJobs?.find(value=>value.jobId===stockJob.jobId);
      if(!stock||stock.status!==stockJob.status)throw new Error('D_BATCH_E_STOCK_SOURCE_CHANGED');
      if(event.kind!=='read_failed')stockSource(document,stock);
      const next=applyDBatchEJobEvent({job:held,event,workerId:job.workerId,
        leaseId:job.leaseId,observedAt:serverClock()});
      jobs[jobs.indexOf(held)]=next;
      if(result){
        if(result.sourceRecordId!==record.recordId||result.readbackId!==event.resultId)
          throw new Error('D_BATCH_E_RESULT_SCOPE_INVALID');
        const results=document.runtime.dBatchEReadbacks??[];
        if(!Array.isArray(results)||results.some(value=>value.readbackId===result.readbackId))
          throw new Error('D_BATCH_E_RESULT_DUPLICATE');
        results.push(result);document.runtime.dBatchEReadbacks=results;
        if(result.status!=='not_verified'){
          const batch=savedBatch(document,stockJob.batchId);
          const member=batch.members.find(value=>value.offerId===stockJob.offerId);
          if(!member)throw new Error('D_BATCH_E_MEMBER_MISSING');
          member.status=result.status;
        }
      }
      return {changed:true,document,result:clone(next)};
    });
  }
  let activeEReadback=null;
  async function runDueBatchEReadbacks(){
    if(activeEReadback)return activeEReadback;
    activeEReadback=(async()=>{
      const snapshot=await repository.readSnapshot();
      for(const saved of snapshot.runtime?.dBatchStockJobs??[]){
        if(!['inventory_deferred','stock_accepted'].includes(saved.status))continue;
        if(saved.inventoryAction==='create_only'&&saved.status!=='inventory_deferred'||
            saved.inventoryAction==='write_authorized_stock'&&saved.status!=='stock_accepted')continue;
        const priorJobs=snapshot.runtime?.dBatchEJobs?.filter(job=>job.batchId===saved.batchId&&
          job.offerId===saved.offerId)??[];
        if(priorJobs.length>1)throw new Error('D_BATCH_E_JOB_NOT_UNIQUE');
        const priorJob=priorJobs[0];
        if(priorJob){
          assertDBatchEJob(priorJob);
          if(['completed','read_failed','observation_stopped'].includes(priorJob.status))continue;
          if(priorJob.status==='read_in_flight'){
            if(Date.parse(serverClock())<Date.parse(priorJob.leaseExpiresAt))continue;
            if(priorJob.schemaVersion===D_BATCH_E_JOB_VERSION){
              const records=snapshot.runtime?.dBatchOfferRecords?.filter(record=>record.recordId===priorJob.recordId)??[];
              if(records.length!==1)throw new Error('D_BATCH_E_SOURCE_CONFLICT');
              const result=readbackForJob(priorJob,records[0],{observation:null,
                readAt:serverClock(),readFailure:'read_interrupted'});
              const settled=await checkpointBatchE({stockJob:saved,job:priorJob,record:records[0],
                event:{kind:'read_failed',resultId:result.readbackId},result});
              return {status:'read_failed',job:settled,result};
            }
          }
          if(priorJob.schemaVersion===D_BATCH_E_JOB_VERSION && priorJob.status==='observed_pending' &&
              Date.parse(serverClock())<Date.parse(priorJob.nextReadAt) &&
              Date.parse(serverClock())<Date.parse(priorJob.observationPolicy.expiresAt) &&
              priorJob.readCount<priorJob.observationPolicy.maxQueries)continue;
        }
        const worker={workerId:saved.workerId,version:saved.workerVersion};
        const {source,sourceRequest}=batchEReadbackSource(snapshot,saved);
        const projected=createDBatchOfferRecord({batch:source.batch,member:source.member,
          chunkIndex:source.chunkIndex,stockJob:saved,source:sourceRequest,
          frozenImport:source.importChunk.frozenImport,chunkOfferIds:source.importChunk.offerIds,
          importObservation:source.importObservation,createdAt:saved.createdAt});
        let job=await repository.transact(document=>{
          const stock=document.runtime?.dBatchStockJobs?.find(value=>value.jobId===saved.jobId);
          if(!stock||stock.status!==saved.status||stock.leaseId!==saved.leaseId)
            throw new Error('D_BATCH_E_STOCK_SOURCE_CHANGED');
          const current=stockSource(document,stock);
          const record=createDBatchOfferRecord({batch:current.batch,member:current.member,
            chunkIndex:current.chunkIndex,stockJob:stock,source:sourceRequest,
            frozenImport:current.importChunk.frozenImport,chunkOfferIds:current.importChunk.offerIds,
            importObservation:current.importObservation,createdAt:stock.createdAt});
          if(!isDeepStrictEqual(record,projected))throw new Error('D_BATCH_E_RECORD_DRIFT');
          const records=document.runtime.dBatchOfferRecords??[];
          const jobs=document.runtime.dBatchEJobs??[];
          if(!Array.isArray(records)||!Array.isArray(jobs))throw new Error('D_BATCH_E_STORE_INVALID');
          const existingRecords=records.filter(value=>value.recordId===record.recordId);
          const existingJobs=jobs.filter(value=>value.recordId===record.recordId);
          if(existingRecords.length>1||existingJobs.length>1||
              (existingRecords.length===1&&!isDeepStrictEqual(existingRecords[0],record))||
              existingRecords.length!==existingJobs.length)
            throw new Error('D_BATCH_E_SOURCE_CONFLICT');
          if(existingJobs.length===1){
            let held=existingJobs[0];
            if(Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)){
              const at=serverClock();
              held=reclaimDBatchEJob({job:held,workerId:worker.workerId,
                workerVersion:worker.version,leaseId:`lease:${randomUUID()}`,
                leaseExpiresAt:new Date(Date.parse(at)+held.leaseDurationMs).toISOString(),observedAt:at});
              jobs[jobs.indexOf(existingJobs[0])]=held;
              return {changed:true,document,result:clone(held)};
            }
            return {changed:false,result:clone(held)};
          }
          const at=serverClock();
          const created=createDBatchEJob({record,workerId:worker.workerId,workerVersion:worker.version,
            leaseId:`lease:${randomUUID()}`,
            leaseExpiresAt:new Date(Date.parse(at)+stock.leaseDurationMs).toISOString(),
            leaseDurationMs:stock.leaseDurationMs,observationPolicy:stock.observationPolicy,createdAt:at});
          records.push(record);jobs.push(created);
          document.runtime.dBatchOfferRecords=records;document.runtime.dBatchEJobs=jobs;
          return {changed:true,document,result:clone(created)};
        });
        const checkpoint=(event,result=null)=>checkpointBatchE({stockJob:saved,job,
          record:projected,event,result});
        if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt)||
            job.readCount>=job.observationPolicy.maxQueries){
          const stopped=await checkpoint({kind:'observation_stopped',
            reason:job.readCount>=job.observationPolicy.maxQueries?'query_limit':'policy_expired'});
          return {status:'observation_stopped',job:stopped};
        }
        job=await checkpoint({kind:'read_started'});
        const guard=async()=>{
          const currentWorker=workerRegistry.findEligible(['ozon-independent-readback'])
            .find(value=>value.workerId===job.workerId);
          if(!currentWorker||currentWorker.version!==job.workerVersion)
            throw new Error('D_BATCH_E_WORKER_NOT_CURRENT');
          const current=await repository.readSnapshot();
          const held=current.runtime?.dBatchEJobs?.find(value=>value.jobId===job.jobId);
          const stock=current.runtime?.dBatchStockJobs?.find(value=>value.jobId===saved.jobId);
          if(!held||!stock||held.leaseId!==job.leaseId||held.status!=='read_in_flight'||
              stock.status!==saved.status||Date.parse(serverClock())>=Date.parse(held.leaseExpiresAt)||
              Date.parse(serverClock())>=Date.parse(held.observationPolicy.expiresAt))
            throw new Error('D_BATCH_E_READ_GUARD_BLOCKED');
          stockSource(current,stock);
        };
        const guardedRequest=async(request,options)=>{
          if(request.write!==false)throw new Error('D_BATCH_E_READ_ONLY_REQUIRED');
          await guard();
          return requestJson(request,{...options,beforeRequestSend:guard});
        };
        const controller=new AbortController();
        const timeoutMs=Math.min(job.observationPolicy.requestTimeoutMs,
          Date.parse(job.leaseExpiresAt)-Date.parse(serverClock()),
          Date.parse(job.observationPolicy.expiresAt)-Date.parse(serverClock()));
        const timer=setTimeout(()=>controller.abort(new Error('D_BATCH_E_READ_TIMEOUT')),
          Math.max(1,timeoutMs));
        let result;
        try{
          const currentWorker=workerRegistry.findEligible(['ozon-independent-readback'])
            .find(value=>value.workerId===job.workerId);
          if(!currentWorker||currentWorker.version!==job.workerVersion)
            throw new Error('D_BATCH_E_WORKER_NOT_CURRENT');
          const current=await repository.readSnapshot();
          const ready=await prepareBatchEReadback(current,saved);
          const adapter=createStoreIsolatedOzonSellerApiDEAdapter({requestJson:guardedRequest,
            adapterCapabilities:ready.capabilities});
          const observation=await adapter.readbackSellerApi({platform:projected.platform,
            store:projected.store,storeRef:projected.storeRef,warehouseRef:projected.warehouseRef,
            credentialAlias:projected.credentialAlias,warehouseId:projected.warehouseId,
            skuPackageId:projected.skuPackageId,supplierSkuId:projected.supplierSkuId,
            merchantSku:projected.offerId,platformProductId:projected.productId,writeAllowed:false},
          {signal:controller.signal});
          result=readbackForJob(job,projected,{observation,readAt:serverClock()});
        }catch(error){
          const knownFailure=knownEReadbackFailure(error,controller.signal);
          const reason=knownFailure??'system_failure';
          const result=readbackForJob(job,projected,{observation:null,
            readAt:serverClock(),readFailure:reason});
          let settled;
          try{settled=await checkpoint({kind:'read_failed',resultId:result.readbackId},result);}
          catch(checkpointError){throw new AggregateError([error,checkpointError],
            'D_BATCH_E_FAILURE_CHECKPOINT_FAILED');}
          if(knownFailure===null)throw error;
          return {status:'read_failed',job:settled,result};
        }finally{clearTimeout(timer);}
        const kind=result.observationDisposition==='observe'?'read_pending':'read_completed';
        const settled=await checkpoint({kind,resultId:result.readbackId},result);
        return {status:result.status,job:settled,result};
      }
      return {status:'idle'};
    })();
    try{return await activeEReadback;}finally{activeEReadback=null;}
  }
  async function runDueBatchContinuations(){
    const snapshot=await repository.readSnapshot();
    const assetRecovery=await reconcileExpiredDBatchAssetTransport({repository,serverClock,snapshot});
    if(assetRecovery.status!=='idle')return assetRecovery;
    const importObservation=await runDueBatchObservationsFromSnapshot(snapshot);
    if(importObservation.status!=='idle')return importObservation;
    const prerequisite=await runDueBatchStockPrerequisites();
    if(prerequisite.status!=='idle')return prerequisite;
    // The immutable v2 batch scope and its exact imported-offer job are the
    // authority. A process-local activation flag cannot grant or revoke it.
    const write=await runDueBatchStockWrites();
    if(write.status!=='idle')return write;
    const readback=await runDueBatchEReadbacks();
    if(readback.status!=='idle')return readback;
    const inSale=await inSaleService.runDue({snapshot});
    if(inSale.status!=='idle')return inSale;
    return reconcileDBatchEVerifications({repository,serverClock,snapshot});
  }
  return Object.freeze({
    async runAuthorizedBatch({ batchId }) {
      const snapshot = await repository.readSnapshot();
      const batch=savedBatch(snapshot, batchId);
      const jobs = snapshot.runtime?.dBatchImportJobs?.filter(job => job.batchId === batchId) ?? [];
      if (jobs.length > 1) throw new Error('D_BATCH_SERVICE_JOB_NOT_UNIQUE');
      if (jobs.length === 1 && (jobs[0].chunks.every(chunk => chunk.status !== 'not_sent') ||
          jobs[0].chunks.some(chunk => ['intent', 'unknown_outcome', 'prewrite_blocked'].includes(chunk.status)))) {
        return { status: 'idempotent_replay', executionStatus: jobs[0].status, job: clone(jobs[0]) };
      }
      const assets=await runBatchAssetTransport(snapshot,batch);
      if(assets.status!=='verified')return {...assets,executionStage:'asset_transport'};
      const ready = await prepare(batchId);
      const result=await runtime.run({ batchId, members: ready.members, adapterCapabilities: ready.adapterCapabilities,
        workerId: ready.workerId, accountReadState: ready.accountReadState });
      return result;
    },
    async resumeAuthorizedBatchContinuations({batchId}){
      const document=await repository.readSnapshot(),batch=savedBatch(document,batchId);
      if(!supportsPostImportBatch(batch.schemaVersion))
        throw new Error('D_BATCH_SERVICE_RESUME_SCOPE_INVALID');
      const jobs=document.runtime?.dBatchImportJobs?.filter(job=>job.batchId===batchId)??[];
      if(jobs.length!==1)throw new Error('D_BATCH_SERVICE_RESUME_JOB_REQUIRED');
      const stockJobs=document.runtime?.dBatchStockJobs?.filter(job=>job.batchId===batchId)??[];
      if(stockJobs.length===0||!stockJobs.some(job=>['awaiting_prerequisites','ready_to_write'].includes(job.status)))
        throw new Error('D_BATCH_SERVICE_RESUME_NOTHING_UNSENT');
      for(const job of stockJobs.filter(value=>['awaiting_prerequisites','ready_to_write'].includes(value.status))){
        eligibleStockWorker(job);
        if(Date.parse(serverClock())>=Date.parse(job.observationPolicy.expiresAt))
          throw new Error('D_BATCH_SERVICE_RESUME_POLICY_EXPIRED');
        await prepareStock(job);
      }
      return {status:'continuation_activated',batchId};
    },
    observeBatchChunk,
    async reclaimBatchLease({ batchId }) {
      const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
      if (batch.members.length === 0) throw new Error('D_BATCH_SERVICE_EMPTY_BATCH');
      const workerId = resolveService(candidateFor(document, batch.members[0])).service.worker.workerId;
      return runtime.reclaim({ batchId, workerId });
    },
    runDueBatchObservations,runDueBatchStockPrerequisites,runDueBatchStockWrites,
    runDueBatchEReadbacks,runDueBatchContinuations
  });
}
