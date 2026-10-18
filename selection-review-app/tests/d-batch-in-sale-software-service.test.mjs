import test from 'node:test';
import assert from 'node:assert/strict';
import {initialBusinessStateDocument,createMemoryBusinessStateRepository} from '../lib/business-state-repository.mjs';
import {createLocalDevelopmentWorkerRegistry} from '../lib/worker-registry.mjs';
import {createDBatchInSaleSoftwareService} from '../lib/d-batch-in-sale-software-service.mjs';
import {OzonDEPreflightEvidenceError} from '../lib/ozon-de-preflight-provider.mjs';
import {OzonDEHttpTransportError} from '../lib/ozon-de-http-configuration.mjs';
import {OZON_SELLER_API_DE_ADAPTER_VERSION} from '../lib/ozon-seller-api-de-adapter.mjs';

const now='2026-10-18T14:00:00.000Z';
const clone=value=>structuredClone(value);
function fixture({transport=null,permission=null,requestTimeoutMs=30000}={}){
  let currentTime=now;
  const document=initialBusinessStateDocument({now});
  const batch={schemaVersion:'d-batch-production-authorization-v3',batchId:'d-batch:synthetic:in-sale',
    storeRef:{stableStoreId:'miska',platformStoreId:'seller:synthetic:1',mappingVersion:'mapping:v1'}};
  document.runtime.dProductionBatches=[batch];
  document.candidates=[1,2,3].map(index=>({id:`candidate:${index}`,dataRevision:4}));
  const repository=createMemoryBusinessStateRepository(document);
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>currentTime});
  const worker={workerId:'worker:synthetic:1',workerVersion:'v1'};
  registry.register({workerId:worker.workerId,version:worker.workerVersion,
    capabilities:['ozon-independent-readback'],observedAt:now});
  function resolveSource(saved,batch){
    return {scope:{schemaVersion:'ozon-in-sale-list-scope-v1',batchId:batch.batchId,
      authorizationRef:`${batch.batchId}:in-sale-list`,officialEvidenceRef:'official:ozon-in-sale-list:20261018',
      storeRef:clone(batch.storeRef),warehouseRef:'warehouse:synthetic:1',warehouseId:'10001',
      credentialAlias:'credential-alias:synthetic:1',bindingId:'binding:synthetic:1',configurationVersion:'config:v1',
      targets:saved.candidates.map((candidate,index)=>({candidateId:candidate.id,skuPackageId:`sku:${index+1}`,
        sourceRevision:candidate.dataRevision,sourceRecordId:`d-source:${index+1}`,authorizationId:`pa:${index+1}`,
        authorizationFingerprint:String(index+1).repeat(64),offerId:`SKU-${index+1}`,productId:String(101+index)}))},
      policy:{pageSize:1000,maxPages:3,requestTimeoutMs,durationMs:90000},...worker,
      evidenceInput:{batchId:batch.batchId}};
  }
  const scope=resolveSource(document,batch).scope;
  const capabilities={status:'read_ready',platform:'ozon',store:'miska',storeRef:clone(scope.storeRef),
    warehouseRef:scope.warehouseRef,warehouseId:scope.warehouseId,credentialAlias:scope.credentialAlias,
    adapterVersion:OZON_SELLER_API_DE_ADAPTER_VERSION,protocolVersion:'ozon-single-sku-d-e-v3',
    evidenceRef:'account:synthetic:1',inSaleListObservation:{status:'verified',protocolVersion:'ozon-in-sale-list-v1',
      evidenceRef:'account:synthetic:1:roles:list',endpoint:'/v3/product/list',officialEvidenceRef:scope.officialEvidenceRef}};
  const calls=[];
  const options={repository,runtimeMode:'local_development',workerRegistry:registry,serverClock:()=>currentTime,
    resolveSource,loadEvidence:async input=>permission?permission(input):{capabilities:clone(capabilities)},
    requestJson:async(request,context)=>{
      await context.beforeRequestSend();
      const saved=await repository.readSnapshot(),job=saved.runtime.dBatchInSaleJobs[0];
      assert.equal(job.attempts.at(-1).requestTransmission,'possibly_sent');
      assert.equal(request.write,false);assert.deepEqual(request.body.filter,{visibility:'IN_SALE'});
      calls.push(clone(request));
      return transport?transport(request,context):{result:{items:[1,2,3].map(index=>({offer_id:`SKU-${index}`,product_id:100+index})),last_id:''}};
    }};
  const service=createDBatchInSaleSoftwareService(options);
  return {repository,service,calls,options,capabilities,resolveSource,
    run:async current=>current.runDue({snapshot:await repository.readSnapshot()}),
    restart:()=>createDBatchInSaleSoftwareService(options),setTime:value=>{currentTime=value;}};
}

test('one persisted page serves all three targets; replay and another process make zero new requests',async()=>{
  const f=fixture();const result=await f.run(f.service);
  assert.equal(result.status,'matched');assert.equal(f.calls.length,1);assert.equal(result.job.matches.length,3);
  assert.equal(result.job.requestCount,1);assert.equal(result.job.attempts[0].status,'observed');
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,1);
});

test('old batch scope has zero page actions and no implicit upgrade',async()=>{
  const f=fixture();await f.repository.transact(document=>{document.runtime.dProductionBatches[0].schemaVersion='d-batch-production-authorization-v2';return {changed:true,document};});
  assert.equal((await f.run(f.service)).status,'idle');assert.equal(f.calls.length,0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchInSaleJobs,undefined);
});

test('missing method permission is a durable stop with zero send and no automatic re-admission',async()=>{
  const f=fixture({permission:async()=>{throw new OzonDEPreflightEvidenceError('IN_SALE_METHOD_NOT_GRANTED');}});
  assert.equal((await f.run(f.service)).status,'in_sale_read_stopped');
  const saved=await f.repository.readSnapshot();assert.equal(saved.runtime.dBatchInSaleAdmissionStops[0].reason,'permission_unavailable');
  assert.equal(saved.runtime.dBatchInSaleAdmissionStops[0].requestTransmission,'not_attempted');
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,0);
});

test('concurrent service instances cannot send the same page twice',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;});const inRequest=new Promise(resolve=>{entered=resolve;});
  const f=fixture({transport:async()=>{entered();await gate;return {result:{items:[],last_id:''}};}});
  const first=f.run(f.service);await inRequest;
  assert.equal((await f.run(f.restart())).status,'idle');release();
  assert.equal((await first).job.stopReason,'empty_page');assert.equal(f.calls.length,1);
});

test('a cold restart stops an interrupted intent without replay and retains its consumed budget',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;});const inRequest=new Promise(resolve=>{entered=resolve;});
  const f=fixture({transport:async()=>{entered();await gate;return {result:{items:[],last_id:''}};}});
  const first=f.run(f.service);await inRequest;
  f.setTime('2026-10-18T14:01:31.000Z');
  const stopped=await f.run(f.restart());assert.equal(stopped.job.stopReason,'read_interrupted');
  assert.equal(stopped.job.requestCount,1);assert.equal(stopped.job.attempts[0].requestTransmission,'possibly_sent');
  release();assert.equal((await first).status,'in_sale_receipt_superseded');
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,1);
});

test('pagination budget survives restarts and unmatched results never assert not-in-sale',async()=>{
  const f=fixture({transport:async request=>({result:{items:[{offer_id:`unrelated-${request.body.last_id}`,product_id:900+request.body.last_id.length}],last_id:`${request.body.last_id}x`}})});
  await f.run(f.service);await f.run(f.restart());const result=await f.run(f.restart());
  assert.equal(result.job.stopReason,'page_limit');assert.equal(result.job.requestCount,3);
  assert.deepEqual(f.calls.map(request=>request.body.last_id),['','x','xx']);assert.deepEqual(result.job.matches,[]);
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,3);
});

test('source drift during permission recheck persists a stop before transmission',async()=>{
  const f=fixture();let reads=0;
  const service=createDBatchInSaleSoftwareService({...f.options,loadEvidence:async()=>{
    if(++reads===3)await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
    return {capabilities:clone(f.capabilities)};
  }});
  const result=await f.run(service);assert.equal(result.job.stopReason,'source_changed');assert.equal(f.calls.length,0);
  assert.equal(result.job.attempts[0].requestTransmission,'not_attempted');
});

test('timeout cancels the transport, persists failure and releases the active-service latch',async()=>{
  const f=fixture({requestTimeoutMs:20,transport:async(_request,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const result=await f.run(f.service);assert.equal(result.job.stopReason,'request_timeout');
  assert.equal(result.job.status,'failed');assert.equal((await f.run(f.service)).status,'idle');assert.equal(f.calls.length,1);
});

test('invalid platform data and receipt corruption are classified separately without retry',async()=>{
  const f=fixture({transport:async()=>({result:{items:[{offer_id:'SKU-1',product_id:'101'}],last_id:''}})});
  const result=await f.run(f.service);assert.equal(result.job.stopReason,'platform_data_invalid');
  assert.equal(result.job.attempts[0].requestTransmission,'response_received');
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,1);
  const failure=new OzonDEPreflightEvidenceError('BATCH_E_READ_SOURCE_INVALID');
  const broken=fixture({permission:async()=>{throw failure;}});
  await assert.rejects(broken.run(broken.service),error=>error===failure);
  assert.equal((await broken.repository.readSnapshot()).runtime.dBatchInSaleAdmissionStops[0].reason,'system_failure');
  assert.equal((await broken.run(broken.restart())).status,'idle');assert.equal(broken.calls.length,0);
});

test('real transport cancellation classification retains possible-send evidence',async()=>{
  const f=fixture({requestTimeoutMs:20,transport:async(_request,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new OzonDEHttpTransportError('OZON_DE_HTTP_CANCELLED',
      {layer:'transport',externalRequestState:'unknown_outcome',requestTransmission:'attempted'})),{once:true});
  })});
  const result=await f.run(f.service);assert.equal(result.job.stopReason,'request_timeout');
  assert.equal(result.job.attempts[0].requestTransmission,'possibly_sent');
  assert.equal((await f.run(f.restart())).status,'idle');assert.equal(f.calls.length,1);
});
