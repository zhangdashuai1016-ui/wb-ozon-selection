import assert from 'node:assert/strict';
import { savedDProductionJobFixture } from './d-production-saved-job-fixture.mjs';
import { runPersistedDExecution } from '../../lib/d-e-software-integration.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from '../../lib/ozon-seller-api-de-adapter.mjs';
import { createDPlatformObservationRuntime } from '../../lib/d-platform-observation-use-case.mjs';
/** Real asynchronous adapter and persisted job flow using explicit synthetic HTTP responses only. */
const clone=value=>structuredClone(value);
const policy = at => ({schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:task',version:'version:1',
 maxQueries:4,intervalMs:10,requestTimeoutMs:1000,expiresAt:new Date(Date.parse(at)+60000).toISOString()});
export async function createDPlatformObservationRuntimeFixture({maxQueries=4,responses=['pending'],prerequisitePolicy=null,beforeResponse=null,initialAdapterFactory=null,responseFor=null}={}) {
 const d=await savedDProductionJobFixture(),rules={...policy(d.input.serverClock()),maxQueries};
 const outcome=await runPersistedDExecution({...d.input,platformObservationPolicy:rules,createAdapter:initialAdapterFactory ? initialAdapterFactory(d) : d.createAdapter()});
 assert.equal(outcome.status,'waiting_platform');assert.deepEqual(d.calls,['/v3/product/import']);
 const calls=[],caps=clone(d.input.adapterCapabilities);if(prerequisitePolicy)caps.inventoryWrite.prerequisitePolicy=clone(prerequisitePolicy === 'configured' ? d.input.adapterCapabilities.inventoryWrite.prerequisitePolicy : prerequisitePolicy);else delete caps.inventoryWrite.prerequisitePolicy;
 const merchantSku=(await d.repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.attempt.request.merchantSku;
 let index=0,ready=0;
 const createRuntime=(onPrerequisitesObserved=()=>{ready++;})=>createDPlatformObservationRuntime({repository:d.repository,jobStore:d.jobStore,serverClock:d.input.serverClock,
  resolveExecution:()=>({worker:d.worker,leaseDurationMs:60000,createAdapter:()=>createStoreIsolatedOzonSellerApiDEAdapter({adapterCapabilities:caps,
   requestJson:async(request,options)=>{await options.beforeRequestSend();calls.push(request.endpoint);
    if(beforeResponse)await beforeResponse({request,advance:d.advance,repository:d.repository});
    const status=responses[Math.min(index++,responses.length-1)];
    const defaultResponse=(()=>{
    if(request.endpoint==='/v1/product/import/info')return {result:{items:[{offer_id:merchantSku,
     product_id:status==='pending'?0:910001,status,errors:[]}]}};
    if(request.endpoint==='/v3/product/info/list')return {items:[{offer_id:merchantSku,id:910001,statuses:{status:caps.inventoryWrite.prerequisitePolicy.priceSent.acceptedValues[0]},errors:[]}]};
    if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {products:[{offer_id:merchantSku,product_id:910001,sku:1910001,
      warehouse_id:Number(d.currentProductionBinding.warehouseId),free_stock:100,present:100,reserved:0}],has_next:false,cursor:''};
    throw new Error('Unexpected synthetic observation endpoint');
    })();
    return responseFor ? responseFor({request,defaultResponse,options,d,merchantSku,caps,status}) : defaultResponse;
   }})}),onPrerequisitesObserved});
 const job=()=>d.repository.readSnapshot().then(doc=>doc.runtime.softwareJobs.find(value=>value.jobType==='e_d_platform_observation'&&value.status==='queued'));
 return {d,rules,calls,caps,createRuntime,job,ready:()=>ready};
}
