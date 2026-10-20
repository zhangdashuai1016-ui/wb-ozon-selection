import assert from 'node:assert/strict';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createOzonAccountReadRuntime } from '../../lib/ozon-account-read-runtime.mjs';
import { OzonDEHttpTransportError } from '../../lib/ozon-de-http-configuration.mjs';
import { createOzonAccountReadEvidenceSource } from '../../lib/ozon-account-read-evidence.mjs';

/** Synthetic account responses through the real authorizer, lease, receipt and repository contracts. */
export async function accountReadConcurrencyFixture({ repository, clock, productionBinding, candidateId,
  beforeSend = null, afterSend = null, responseMode = 'observed', readBinding = null, protocolCatalog = null }) {
  const document = await repository.readSnapshot(), candidate = document.candidates.find(value => value.id === candidateId);
  assert.ok(candidate, 'A persisted production fixture candidate is required');
  const binding = readBinding === null ? { scopeRef: 'account-scope:synthetic:concurrency', platform: 'ozon',
    ...Object.fromEntries(['bindingId','configurationVersion','storeRef','warehouseRef','warehouseId','credentialAlias']
      .map(field => [field, structuredClone(productionBinding[field])])),
    clientIdRef: 'client:synthetic:concurrency', officialContractRefs: {
      roles: 'official:synthetic:roles', seller_info: 'official:synthetic:seller', warehouse_list: 'official:synthetic:warehouse' } } : structuredClone(readBinding);
  const actor = createActorContext({userId:'synthetic-owner',sessionId:'session:synthetic:account-concurrency',
    actorType:'human',roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:clock()});
  const requests = [], responses = {
    '/v1/roles': {expires_at:'2099-01-01T00:00:00.000Z',roles:[{name:'Synthetic',methods:['/v3/product/import','/v1/*']}]},
    '/v1/seller/info': {company:{currency:'CNY'}},
    '/v2/warehouse/list': {has_next:false,warehouses:[{warehouse_id:Number(binding.warehouseId),is_rfbs:true,
      status:'created',warehouse_type:'RFBS',pause_at:null}]}
  };
  const runtime = createOzonAccountReadRuntime({repository,serverClock:clock,
    workerRegistry:createLocalDevelopmentWorkerRegistry({clock}),
    worker:{workerId:'worker:synthetic:account-concurrency',version:'version:1',leaseDurationMs:60000},
    loadCurrentReadBinding:()=>structuredClone(binding),requestJson:async(request,options)=>{
      assert.ok(Object.hasOwn(responses,request.endpoint),`Unexpected account method: ${request.endpoint}`);
      if(beforeSend)await beforeSend(request);
      await options.beforeRequestSend();requests.push(request.endpoint);
      if(afterSend)await afterSend(request);
      if(responseMode==='unknown')throw new OzonDEHttpTransportError('SYNTHETIC_ACCOUNT_RESPONSE_LOST',
        {externalRequestState:'unknown_outcome',requestTransmission:'attempted'});
      return responseMode==='unavailable'?{}:structuredClone(responses[request.endpoint]);
    }});
  const input = {candidateId,skuPackageId:candidate.lifecycleV11.skuPackage.skuPackageId,expectedRevision:candidate.dataRevision,
    bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,
    expiresAt:new Date(Date.parse(clock())+3600000).toISOString(),confirmReadOnce:true,idempotencyKey:`account:synthetic:${candidateId}`};
  const evidenceSource=createOzonAccountReadEvidenceSource({repository,loadCurrentReadBinding:()=>structuredClone(binding),protocolCatalog});
  return {runtime,input,actor,requests,responses,evidenceSource,
    enqueue:overrides=>runtime.authorizeAndEnqueue({actor,input:{...input,...overrides}}),
    continue:job=>runtime.continueSaved({candidateId,jobId:job.jobId,expectedRevision:job.revision}),
    async publish(completed) {
      assert.equal(completed.status,'completed');
      const saved=await repository.readSnapshot(),current=saved.candidates.find(value=>value.id===candidateId);
      const authorization=current.lifecycleV11.skuPackage.productionAuthorization,locked=authorization.lockedScope;
      const scope={candidateId,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,
        authorizationId:authorization.authorizationId,sourceCandidateRevision:authorization.sourceCandidateRevision,
        storeRef:structuredClone(locked.storeRef),warehouseRef:locked.warehouseRef,warehouseId:binding.warehouseId,
        credentialAlias:locked.credentialAlias,bindingId:binding.bindingId,configurationVersion:binding.configurationVersion};
      return evidenceSource.publish({scope,jobId:completed.job.jobId});
    },
    async run(overrides={}) {const queued=await runtime.authorizeAndEnqueue({actor,input:{...input,...overrides}});
      return runtime.continueSaved({candidateId,jobId:queued.job.jobId,expectedRevision:queued.job.revision});}
  };
}

export async function waitForAccountReadBoundary(entered, running, release) {
  let timer;
  try {await Promise.race([entered,running.then(()=>{throw new Error('Execution ended before its explicit synchronization point');}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Execution synchronization deadline exceeded')),10000);})]);}
  catch(error){release();throw error;}
  finally{clearTimeout(timer);}
}
