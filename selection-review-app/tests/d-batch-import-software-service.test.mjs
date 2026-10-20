import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparedFixture, capabilities as formalCapabilities, currentProductionBindingFixture } from './helpers/d-software-fixture.mjs';
import { authorizedProductionFixture,productionAuthorizationInputFixture,localFinalAssets } from './helpers/c2-software-fixture.mjs';
import {createProductionAuthorization} from '../lib/production-authorization.mjs';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createDBatchImportSoftwareService } from '../lib/d-batch-import-software-service.mjs';
import { OZON_DE_READBACK_ENDPOINTS } from '../lib/ozon-seller-api-de-adapter.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { createDBatchOfferRecord, createDBatchEReadback, applyDBatchEJobEvent } from '../lib/d-batch-offer-readback.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';
import { OzonDEHttpTransportError } from '../lib/ozon-de-http-configuration.mjs';
import { applyDBatchStockEvent } from '../lib/d-batch-stock-state.mjs';
import { OzonDEPreflightEvidenceError } from '../lib/ozon-de-preflight-provider.mjs';
import { readDBatchAssetTransportProof } from '../lib/d-batch-asset-transport.mjs';
import { AliyunOssLocalPreparationError } from '../lib/production-execution-failure.mjs';
import {loadOzonProductImportBatchLimitFact,createOzonProductImportBatchLimitUse} from '../lib/ozon-product-import-batch-limit.mjs';
import {projectDBatchEMediaReview,confirmDBatchEMediaReview} from '../lib/d-batch-e-media-review.mjs';
import {createActorContext} from '../lib/runtime-identity.mjs';
import {reclaimDBatchImportJob} from '../lib/d-batch-import-state.mjs';
import { accountReadConcurrencyFixture, waitForAccountReadBoundary } from './helpers/account-read-concurrency-fixture.mjs';
import { accountReadBindingForProduction, createOzonAccountReadBindingResolver } from '../lib/ozon-account-read-preparation.mjs';
import { createOzonAccountReadEvidenceSource } from '../lib/ozon-account-read-evidence.mjs';
import { createOzonAccountReadServices } from '../lib/ozon-account-read-services.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from '../lib/ozon-de-preflight-evidence-reader.mjs';

const now = '2026-08-22T07:25:00.000Z';
const observationPolicy = { schemaVersion: 'd-platform-observation-policy-v1',
  policyRef: 'policy:synthetic:batch-observation', version: 'v1', maxQueries: 10,
  intervalMs: 0, expiresAt: '2026-09-01T00:00:00.000Z', requestTimeoutMs: 10_000 };
const productImportCapability={status:'verified',protocolVersion:'ozon-product-import-v3',
  evidenceRef:'evidence:synthetic:import-limit',endpoint:'/v3/product/import',
  statusEndpoint:'/v1/product/import/info',maxItemsPerRequest:10,
  limitEvidenceRef:'synthetic:batch-limit',limitObservedAt:'2026-08-22T07:00:00.000Z',
  validUntil:'2026-09-01T00:00:00.000Z'};

async function fixture({stockFree=0,stockReceipt='accepted',eMissingAttributes=false,identity=null,
  policyOverrides={},executionBinding=null,workerId='worker:batch-service'}={}) {
  let currentTime = now;
  const batchObservationPolicy={...observationPolicy,...policyOverrides};
  const fixtureOptions=identity===null?{}:{candidateId:`candidate:batch-service:${identity}`,
    supplierSkuId:`SUPPLIER-${identity}`,merchantSku:`MERCHANT-${identity}`};
  if(executionBinding!==null)fixtureOptions.executionBinding=executionBinding;
  const source = await preparedFixture(fixtureOptions);
  const request = source.prepared.executableRequest;
  const candidate = { id: source.fixture.candidateId, dataRevision: source.fixture.candidateRevision,
    targetPlatform: 'ozon', targetStore: request.store, storeRef: structuredClone(request.storeRef),
    sourceCapture: { skuChoices: [{ sourceSkuId: request.supplierSkuId, attributes: { 颜色: 'black' } }] },
    siblingSourceV1: { parentCardBinding: { model: 'synthetic-model' } },
    lifecycleV11: { skuPackage: structuredClone(source.fixture.skuPackage) } };
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: `d-batch:service-test${identity===null?'':`:${identity}`}`,
    confirmedAt:now,storeRef: structuredClone(request.storeRef), status: 'authorized', externalRequestState: 'not_sent',
    excludedOfferIds: ['FIRST-EXCLUDED'], members: [{ candidateId: candidate.id,
      skuPackageId: request.skuPackageId, offerId: request.merchantSku,
      resultRevision: candidate.dataRevision, authorizationId: source.authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(source.authorization), status: 'authorized', taskId: null,
      productId: null }] };
  const document = initialBusinessStateDocument({ now });
  document.candidates = [candidate];
  document.runtime.dProductionBatches = [batch];
  const repository = createMemoryBusinessStateRepository(document);
  const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => currentTime });
  workerRegistry.register({ workerId, version: 'v1',
    capabilities: ['ozon-production-execution','ozon-independent-readback'], observedAt: now });
  const capability = formalCapabilities(request.store, source.authorization.lockedScope.finalUploads, request);
  capability.warehouseId = request.inventoryWrite.warehouseId;
  capability.inspectedAt = now;
  capability.productImport = structuredClone(productImportCapability);
  capability.independentReadback={status:'verified',evidenceRef:'evidence:synthetic:readback',
    protocolVersion:'ozon-independent-readback-v2',endpoints:structuredClone(OZON_DE_READBACK_ENDPOINTS)};
  const inspection = ozonDEPreflightEvidenceFixture().record.inspection;
  const calls = [];
  let stockWriteSent=false;
  let writeEvidenceUnavailable=false;
  const serviceOptions = { repository, runtimeMode: 'local_development',
    workerRegistry, serverClock: () => currentTime,
    services: new Map([[source.currentProductionBinding.bindingId,
      { worker: workerRegistry.get(workerId),binding:{leaseDurationMs:300_000} }]]),
    loadCurrentProductionBinding: () => source.currentProductionBinding,
    loadBatchObservationPolicy: () => batchObservationPolicy,
    loadBatchMemberEvidence: async () => {
      if(writeEvidenceUnavailable)throw new Error('PRODUCTION_EXECUTION_BINDING_UNVERIFIED');
      return { capabilities: structuredClone(capability),
        inspection: structuredClone(inspection), checkedAt: now };
    },
    loadBatchEReadEvidence: async () => ({ capabilities: structuredClone(capability), checkedAt: now }),
    requestJson: async requestJson => { calls.push(requestJson);
      if(requestJson.endpoint==='/v3/product/import')return {result:{task_id:9001}};
      if(requestJson.endpoint==='/v1/product/import/info')return {result:{items:[
        {offer_id:request.merchantSku,product_id:94001,status:'imported',errors:[]}]}};
      if(requestJson.endpoint==='/v3/product/info/list')return {items:[{offer_id:request.merchantSku,
        product_id:94001,errors:[],is_archived:false,is_autoarchived:false,
        primary_image:[request.finalUploads[0].platformAcceptedUrl],
        images:request.finalUploads.slice(1).map(asset=>asset.platformAcceptedUrl),
        statuses:{status:'price_sent',moderate_status:'approved',validation_status:'success'}}]};
      if(requestJson.endpoint==='/v4/product/info/attributes')return {result:eMissingAttributes?[]:
        [{offer_id:request.merchantSku,product_id:94001}]};
      if(requestJson.endpoint==='/v5/product/info/prices')return {items:[{offer_id:request.merchantSku,
        product_id:94001,price:{price:request.platformWritePrice.amount,currency_code:'CNY'}}]};
      if(requestJson.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {
        products:[{offer_id:request.merchantSku,product_id:94001,sku:194001,
          warehouse_id:Number(request.inventoryWrite.warehouseId),
          free_stock:stockWriteSent?request.stock:stockFree,
          present:stockWriteSent?request.stock:stockFree,reserved:0}],
        has_next:false,cursor:''};
      if(requestJson.endpoint==='/v2/products/stocks'){
        const saved=await repository.readSnapshot();
        assert.equal(saved.runtime.dBatchStockJobs[0].status,'stock_intent');
        assert.ok(saved.runtime.dBatchStockJobs[0].stockIntentAt);
        if(stockReceipt==='transport_unknown')throw new Error('SYNTHETIC_RESPONSE_LOST');
        stockWriteSent=stockReceipt==='accepted';
        return {result:[{offer_id:request.merchantSku,product_id:94001,
          warehouse_id:Number(request.inventoryWrite.warehouseId),
          updated:stockReceipt==='accepted',errors:[]}]};
      }
      throw new Error('Synthetic endpoint not configured');
    } };
  const service = createDBatchImportSoftwareService(serviceOptions);
  return { repository, service, capability, inspection, calls, batch, request, candidateId: candidate.id,
    services:serviceOptions.services,productionBinding:source.currentProductionBinding,workerRegistry,
    expireWriteEvidence:()=>{writeEvidenceUnavailable=true;},
    requestJson:serviceOptions.requestJson,
    restartService: (overrides={}) => createDBatchImportSoftwareService({...serviceOptions,...overrides}),
    advanceClock: value => { currentTime = value; workerRegistry.heartbeat({ workerId,
      version: 'v1', capabilities: ['ozon-production-execution','ozon-independent-readback'], status: 'online' }); } };
}
async function seedV2ObservedImport(f,inventoryAction){
  await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',inventoryAction,
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  await f.service.observeBatchChunk({batchId:f.batch.batchId,chunkIndex:0});
}
async function appendBatchFixture(target,source){
  const other=await source.repository.readSnapshot();
  await target.repository.transact(document=>{
    document.candidates.push(...other.candidates);
    for(const key of ['dProductionBatches','dBatchImportJobs','dBatchStockJobs']){
      if(other.runtime[key]===undefined)continue;
      document.runtime[key]??=[];
      document.runtime[key].push(...other.runtime[key]);
    }
    return {changed:true,document,result:null};
  });
}

async function localThreeColorFixture({batchVersion=2,runtimeNow=now}={}){
  const document=initialBusinessStateDocument({now}),files=new Map(),models=new Map();
  for(const [index,color] of ['black','cp','CP'].entries()){
    const templates=localFinalAssets();
    const assets=Array.from({length:6},(_,image)=>{
      const body=Buffer.from(`synthetic ${color} final image ${image+1}`);
      const sha256=createHash('sha256').update(body).digest('hex');
      const assetId=`c2-local:00000000-0000-4000-8000-${String(index*6+image+1).padStart(12,'0')}`;
      const asset={...templates[image===0?0:1],assetId,assetRef:`local-asset:${assetId}`,
        order:image+1,role:image===0?'main_image':'gallery_image',sha256,
        byteSize:body.length,assetVersion:`sha256:${sha256}`};
      files.set(assetId,{body,contentType:'image/png'});
      return asset;
    });
    const sourceInput={candidateId:`candidate:batch-local:${color}`,
      supplierSkuId:`SUPPLIER-${color}`,merchantSku:`MERCHANT-${color}`,assets};
    let source;
    if(batchVersion===3){
      const input=productionAuthorizationInputFixture(sourceInput);
      input.authorizedAt=runtimeNow;
      for(const pack of input.evidencePacks)pack.expiresAt='2026-10-19T00:00:00.000Z';
      const result=createProductionAuthorization(input);
      source={...result,candidateId:input.candidateId,candidateRevision:result.productionAuthorization.resultCandidateRevision};
    }else source=authorizedProductionFixture(sourceInput);
    const authorization=source.productionAuthorization,scope=authorization.lockedScope;
    const candidate={id:source.candidateId,dataRevision:source.candidateRevision,
      targetPlatform:'ozon',targetStore:scope.storeRef.stableStoreId,storeRef:structuredClone(scope.storeRef),
      sourceCapture:{skuChoices:[{sourceSkuId:scope.supplierSkuId,attributes:{颜色:color}}]},
      siblingSourceV1:{parentCardBinding:{model:'synthetic-three-color-model'}},
      lifecycleV11:{skuPackage:structuredClone(source.skuPackage),c2UploadDraft:{
        schemaVersion:'c2-upload-draft-v1',candidateId:source.candidateId,skuPackageId:source.skuPackage.skuPackageId,
        schemaEvidenceRef:scope.schemaEvidenceRef,
        uploads:scope.finalUploads.map(asset=>({...structuredClone(asset),status:'ready'})),
        selection:scope.finalUploads.map(asset=>({assetId:asset.assetId,order:asset.order}))}}};
    document.candidates.push(candidate);
    models.set(scope.merchantSku,{candidateId:candidate.id,scope,productId:94001+index,
      media:assets.map(asset=>`https://assets.example.com/batch/${asset.sha256}.png`)});
  }
  const authorization=document.candidates[0].lifecycleV11.skuPackage.productionAuthorization;
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:local-three-colors',
    ownerActorId:authorization.authorizedByActorId,confirmedAt:authorization.authorizedAt,storeRef:structuredClone(authorization.lockedScope.storeRef),
    status:'authorized',externalRequestState:'not_sent',excludedOfferIds:['HISTORICAL-KHAKI'],
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'write_authorized_stock',
      eReadbackOfferIds:[...models.keys()]},members:document.candidates.map(candidate=>{
      const sku=candidate.lifecycleV11.skuPackage,memberAuthorization=sku.productionAuthorization;
      return {candidateId:candidate.id,skuPackageId:sku.skuPackageId,offerId:memberAuthorization.lockedScope.merchantSku,
        resultRevision:candidate.dataRevision,authorizationId:memberAuthorization.authorizationId,
        authorizationFingerprint:fingerprintCanonicalRecord(memberAuthorization),status:'authorized',taskId:null,productId:null};
    })};
  document.runtime.dProductionBatches=[batch];
  const limitFact=batchVersion===3?await loadOzonProductImportBatchLimitFact():null;
  if(batchVersion===3){
    batch.schemaVersion='d-batch-production-authorization-v3';batch.confirmedAt=runtimeNow;
    batch.members.forEach(member=>{member.sourceRevision=member.resultRevision-1;});
    batch.postImportScope={...batch.postImportScope,schemaVersion:'d-batch-post-import-scope-v2',
      inSaleList:{schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
        officialEvidenceRef:'official:ozon-in-sale-list:20261018',
        policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}};
    batch.importLimitUse=createOzonProductImportBatchLimitUse({batch,input:{
      schemaVersion:'ozon-product-import-batch-limit-use-input-v1',evidenceRef:limitFact.evidenceRef,decision:'use_for_this_batch_once'}});
  }
  const bindingFor=candidate=>{
    const binding=currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization);
    if(batchVersion===3){binding.verification.checkedAt=runtimeNow;
      binding.verification.expiresAt=new Date(Date.parse(runtimeNow)+3_600_000).toISOString();}
    return binding;
  };
  const repository=createMemoryBusinessStateRepository(document);
  const workerRegistry=createLocalDevelopmentWorkerRegistry({clock:()=>runtimeNow});
  const worker=workerRegistry.register({workerId:'worker:batch-local',version:'v1',
    capabilities:['ozon-production-execution','ozon-independent-readback'],observedAt:runtimeNow});
  const calls=[],uploads=[],evidencePurposes=[],stockWritten=new Set();
  const evidence=async({candidate,purpose='new_import'})=>{
    evidencePurposes.push({candidateId:candidate.id,purpose});
    const scope=candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope;
    const binding=bindingFor(candidate);
    const proof=readDBatchAssetTransportProof({document:await repository.readSnapshot(),
      batchId:batch.batchId,candidateId:candidate.id});
    const capabilities=formalCapabilities(scope.storeRef.stableStoreId,scope.finalUploads,binding);
    capabilities.warehouseId=binding.warehouseId;capabilities.inspectedAt=runtimeNow;
    capabilities.productImport=structuredClone(productImportCapability);
    if(batchVersion===3){
      delete capabilities.productImport.validUntil;
      Object.assign(capabilities.productImport,{maxItemsPerRequest:100,limitEvidenceRef:limitFact.evidenceRef,
        limitObservedAt:limitFact.observedAt,limitUse:structuredClone(batch.importLimitUse)});
      capabilities.inSaleListObservation={status:'verified',protocolVersion:'ozon-in-sale-list-v1',
        endpoint:'/v3/product/list',evidenceRef:'receipt:synthetic:list-permission',
        officialEvidenceRef:'official:ozon-in-sale-list:20261018'};
    }
    capabilities.independentReadback={status:'verified',evidenceRef:'evidence:synthetic:readback',
      protocolVersion:'ozon-independent-readback-v2',endpoints:structuredClone(OZON_DE_READBACK_ENDPOINTS)};
    capabilities.status=proof===null?'not_ready':'ready';
    capabilities.gaps=proof===null?[{code:'asset_transport_not_verified'}]:[];
    capabilities.assetTransport=proof===null?{status:'unverified',approvedHosts:['assets.example.com'],resolvedAssets:[]}
      :structuredClone(proof.assetTransport);
    return {capabilities,inspection:structuredClone(ozonDEPreflightEvidenceFixture().record.inspection),checkedAt:runtimeNow};
  };
  const options={repository,runtimeMode:'local_development',workerRegistry,serverClock:()=>runtimeNow,
    services:new Map([[authorization.executionBinding.bindingId,{worker,binding:{leaseDurationMs:1_800_000}}]]),
    loadCurrentProductionBinding:bindingFor,
    loadBatchMemberEvidence:evidence,loadBatchEReadEvidence:evidence,
    ...(batchVersion===3?{loadBatchInSaleListEvidence:evidence}:{}),
    loadBatchObservationPolicy:()=>batchVersion===3?{...observationPolicy,expiresAt:'2026-10-19T00:00:00.000Z'}:observationPolicy,
    resolveLocalAsset:async asset=>{
      if(!files.has(asset.assetId))throw new AliyunOssLocalPreparationError('OSS_LOCAL_ASSET_UNAVAILABLE');
      return files.get(asset.assetId);
    },
    upload:async({candidateId,finalUploads,beforePublicWrite,resolveLocalAsset})=>{
      uploads.push(candidateId);
      for(const asset of finalUploads){
        assert.ok(Buffer.isBuffer((await resolveLocalAsset(asset)).body));
        await beforePublicWrite({assetId:asset.assetId,order:asset.order,sha256:asset.sha256});
      }
      return {status:'verified',mode:'preapproved_stable_https',protocolVersion:'aliyun-oss-final-assets-v1',
        approvedHosts:['assets.example.com'],evidenceRef:`oss:synthetic:${candidateId}`,
        resolvedAssets:finalUploads.map(asset=>({assetId:asset.assetId,sha256:asset.sha256,order:asset.order,
          role:asset.role,platformAcceptedUrl:`https://assets.example.com/batch/${asset.sha256}.png`,
          stable:true,authorizationStatus:'approved',evidenceRef:`oss:synthetic:${asset.assetId}`}))};
    },
    requestJson:async(request,transport={})=>{
      if(transport.beforeRequestSend)await transport.beforeRequestSend();
      calls.push(request);
      if(request.endpoint==='/v3/product/import'){
        const saved=await repository.readSnapshot();
        assert.equal(saved.runtime.dBatchAssetTransports.length,3);
        assert.equal(saved.runtime.dBatchAssetTransports.every(record=>record.status==='verified'),true);
        return {result:{task_id:9001}};
      }
      if(request.endpoint==='/v1/product/import/info')return {result:{items:[...models].map(([offerId,model])=>
        ({offer_id:offerId,product_id:model.productId,status:'imported',errors:[]}))}};
      if(request.endpoint==='/v3/product/list')return {result:{items:[...models].map(([offerId,model])=>
        ({offer_id:offerId,product_id:model.productId})),last_id:''}};
      const offerId=request.endpoint==='/v2/products/stocks'?request.body.stocks[0].offer_id:
        (request.body.offer_id??request.body.filter?.offer_id)[0];
      const model=models.get(offerId);assert.ok(model);
      const item={offer_id:offerId,product_id:model.productId};
      const readMedia=batchVersion===3?model.media.map((_,index)=>`https://ir.ozone.ru/s3/multimedia/${model.productId}-${index}.jpg`):model.media;
      if(request.endpoint==='/v3/product/info/list')return {items:[{...item,errors:[],is_archived:false,
        is_autoarchived:false,primary_image:[readMedia[0]],images:readMedia.slice(1),
        statuses:{status:'price_sent',moderate_status:'approved',validation_status:'success'}}]};
      if(request.endpoint==='/v4/product/info/attributes')return {result:[item]};
      if(request.endpoint==='/v5/product/info/prices')return {items:[{...item,
        price:{price:model.scope.platformWritePrice.amount,currency_code:'CNY'}}]};
      if(request.endpoint==='/v2/product/info/stocks-by-warehouse/fbs')return {products:[{...item,
        sku:194001+[...models.keys()].indexOf(offerId),warehouse_id:Number(authorization.executionBinding.warehouseId),
        free_stock:stockWritten.has(offerId)?model.scope.stock:0,
        present:stockWritten.has(offerId)?model.scope.stock:0,reserved:0}],has_next:false,cursor:''};
      if(request.endpoint==='/v2/products/stocks'){
        stockWritten.add(offerId);
        return {result:[{...item,warehouse_id:Number(authorization.executionBinding.warehouseId),updated:true,errors:[]}]};
      }
      throw new Error('Synthetic three-color endpoint not configured');
    }};
  return {repository,batch,files,models,calls,uploads,evidencePurposes,options,
    advanceClock:value=>{runtimeNow=value;},
    restart:(overrides={})=>createDBatchImportSoftwareService({...options,...overrides})};
}

test('completed synthetic media remains reported when account evidence expires before batch import admission',async()=>{
  const f=await localThreeColorFixture(),clock=f.options.serverClock;
  await f.repository.transact(document=>{
    for(const member of document.runtime.dProductionBatches[0].members){
      const candidate=document.candidates.find(value=>value.id===member.candidateId);
      member.sourceRevision=candidate.lifecycleV11.skuPackage.productionAuthorization.sourceCandidateRevision;
    }
    return {changed:true,document};
  });
  const initial=await f.repository.readSnapshot(),binding=f.options.loadCurrentProductionBinding(initial.candidates[0]);
  const readService={productionBindingId:binding.bindingId,productionConfigurationVersion:binding.configurationVersion,
    workerId:'worker:synthetic:account-after-media',workerVersion:'v1',leaseDurationMs:60000};
  const configuration={productionBindings:[binding],ozonDECredentialBindings:[{credentialAlias:binding.credentialAlias,clientId:'700123'}],
    ozonAccountReadServiceBindings:[readService]};
  const readBinding=accountReadBindingForProduction(configuration,binding),accounts=[],completed=[];
  const expiry=new Date(Date.parse(clock())+1000).toISOString();
  for(const candidate of initial.candidates){
    const account=await accountReadConcurrencyFixture({repository:f.repository,clock,productionBinding:binding,candidateId:candidate.id,readBinding});
    accounts.push(account);completed.push(await account.run({expiresAt:expiry}));
  }
  const source=createOzonAccountReadEvidenceSource({repository:f.repository,loadCurrentReadBinding:createOzonAccountReadBindingResolver(configuration)});
  const reader=createRepositoryBackedOzonDEPreflightEvidenceReader({repository:f.repository,verifySourceReceipt:source.verifySourceReceipt});
  const provider=createOzonDEPreflightProvider({readEvidence:reader,serverClock:clock});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let paused=false;
  const production=f.restart({loadBatchMemberEvidence:async input=>{
    const evidence=await f.options.loadBatchMemberEvidence(input);
    const document=await f.repository.readSnapshot(),assets=document.runtime.dBatchAssetTransports;
    if(!paused&&Array.isArray(assets)&&assets.length===3&&assets.every(record=>record.status==='verified')){
      paused=true;entered.resolve();await release.promise;
    }
    return evidence;
  }});
  const services=createOzonAccountReadServices({configuration,repository:f.repository,
    workerRegistry:createLocalDevelopmentWorkerRegistry({clock}),serverClock:clock,
    requestJson:async()=>{throw new Error('Unexpected account request during continuation');},
    evidenceSource:source,preflightProvider:provider,
    deRuntimeServices:{continueAuthorizedBatchImport:input=>production.runAuthorizedBatch(input)}});
  const running=services.continueAuthorizedBatch({batchId:f.batch.batchId});
  await waitForAccountReadBoundary(entered.promise,running,release.resolve);
  const afterMedia=await f.repository.readSnapshot();
  f.advanceClock(expiry);release.resolve();
  const result=await running;
  assert.equal(afterMedia.runtime.dBatchAssetTransports.length,3);
  assert.equal(afterMedia.runtime.dBatchAssetTransports.every(record=>record.status==='verified'),true);
  assert.equal(afterMedia.runtime.dBatchImportJobs,undefined);assert.equal(f.uploads.length,3);assert.deepEqual(f.calls,[]);
  assert.equal(result.status,'account_read_incomplete');assert.equal(result.reasonCode,'D_BATCH_IMPORT_ACCOUNT_EVIDENCE_NOT_CURRENT');
  assert.equal(result.executionView.assetRequestTransmission,'attempted_or_unknown');assert.equal(result.externalRequests,'unknown');assert.equal(result.platformWrites,0);
  const stopped=await f.repository.readSnapshot();assert.deepEqual(stopped,afterMedia);
  await assert.rejects(()=>accounts[0].enqueue({refreshOfJobId:completed[0].job.jobId,idempotencyKey:'account:refresh:after-media-expiry'}),
    {code:'OZON_ACCOUNT_READ_REFRESH_PRODUCTION_BUSY'});
  assert.deepEqual(await f.repository.readSnapshot(),stopped);assert.deepEqual(f.calls,[]);
  assert.equal(accounts.reduce((sum,account)=>sum+account.requests.length,0),9);
});

test('all batch import limits and observation policies are admitted before the first OSS intent',async()=>{
  const cases=[
    ['policy_missing','D_BATCH_SERVICE_OBSERVATION_POLICY_MISSING'],
    ['policy_invalid','D_PLATFORM_OBSERVATION_POLICY_INVALID'],
    ['policy_expired','D_BATCH_SERVICE_OBSERVATION_POLICY_NOT_CURRENT'],
    ['policy_window_short','D_BATCH_SERVICE_OBSERVATION_POLICY_NOT_CURRENT'],
    ['policy_last_member_conflict','D_BATCH_SERVICE_OBSERVATION_POLICY_CONFLICT'],
    ['limit_last_member_missing','D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED'],
    ['limit_last_member_expired','D_BATCH_SERVICE_LIMIT_NOT_CURRENT'],
    ['limit_last_member_future','D_BATCH_SERVICE_LIMIT_NOT_CURRENT'],
    ['limit_last_member_conflict','D_BATCH_SERVICE_ACCOUNT_EVIDENCE_CONFLICT']
  ];
  for(const [scenario,code] of cases){
    const f=await localThreeColorFixture();
    const service=f.restart({loadBatchObservationPolicy:({candidate})=>{
      if(scenario==='policy_missing')return null;
      if(scenario==='policy_invalid')return {...observationPolicy,maxQueries:0};
      if(scenario==='policy_expired')return {...observationPolicy,expiresAt:now};
      if(scenario==='policy_window_short')return {...observationPolicy,expiresAt:'2026-08-22T07:25:05.000Z'};
      if(scenario==='policy_last_member_conflict'&&candidate.id.endsWith(':CP'))
        return {...observationPolicy,version:'v2'};
      return observationPolicy;
    },loadBatchMemberEvidence:async input=>{
      assert.equal(input.purpose,'new_import');
      const evidence=await f.options.loadBatchMemberEvidence(input);
      if(input.candidate.id.endsWith(':CP')){
        if(scenario==='limit_last_member_missing')delete evidence.capabilities.productImport.maxItemsPerRequest;
        if(scenario==='limit_last_member_expired')evidence.capabilities.productImport.validUntil=now;
        if(scenario==='limit_last_member_future')evidence.capabilities.productImport.limitObservedAt='2026-08-22T08:00:00.000Z';
        if(scenario==='limit_last_member_conflict')evidence.capabilities.productImport.maxItemsPerRequest=9;
      }
      return evidence;
    }});
    await assert.rejects(service.runAuthorizedBatch({batchId:f.batch.batchId}),{message:code},scenario);
    assert.equal(f.uploads.length,0,scenario);
    assert.equal(f.calls.length,0,scenario);
    const saved=await f.repository.readSnapshot();
    assert.equal(saved.runtime.dBatchAssetTransports,undefined,scenario);
    assert.equal(saved.runtime.dBatchImportJobs,undefined,scenario);
  }
});
test('a known observation gate change after an asset request preserves unknown and never restarts the upload',async()=>{
  const f=await localThreeColorFixture();
  let expired=false,puts=0;
  const service=f.restart({loadBatchObservationPolicy:()=>expired?{...observationPolicy,expiresAt:now}:observationPolicy,
    upload:async input=>{
      f.uploads.push(input.candidateId);
      for(const asset of input.finalUploads){
        await input.beforePublicWrite({assetId:asset.assetId,order:asset.order,sha256:asset.sha256});
        puts++;expired=true;
      }
      throw new Error('Synthetic expired policy did not stop the next write');
    }});
  await assert.rejects(service.runAuthorizedBatch({batchId:f.batch.batchId}),
    {message:'D_BATCH_SERVICE_OBSERVATION_POLICY_NOT_CURRENT'});
  assert.equal(puts,1);
  assert.equal(f.calls.length,0);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports[0].status,'unknown_outcome');
  assert.equal(saved.runtime.dBatchAssetTransports[0].writeIntents.length,1);
  assert.equal(saved.runtime.dBatchImportJobs,undefined);
  assert.equal((await service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'unknown_outcome');
  assert.equal((await f.restart().runAuthorizedBatch({batchId:f.batch.batchId})).status,'unknown_outcome');
  assert.equal(f.uploads.length,1);
});

test('the existing continuation pump settles expired asset intents without an import job or live dependencies',async()=>{
  for(const writeCount of [0,1]){
    const f=await localThreeColorFixture();
    let interrupted;
    await f.restart({upload:async input=>{
      for(const asset of input.finalUploads.slice(0,writeCount))
        await input.beforePublicWrite({assetId:asset.assetId,order:asset.order,sha256:asset.sha256});
      interrupted=await f.repository.readSnapshot();
      throw new Error('SYNTHETIC_PROCESS_INTERRUPTION');
    }}).runAuthorizedBatch({batchId:f.batch.batchId});
    interrupted.candidates[0].dataRevision++;
    const persisted=createMemoryBusinessStateRepository(interrupted);
    let reads=0,transactions=0,dependencyCalls=0;
    const repository={...persisted,
      readSnapshot:async()=>{reads++;return persisted.readSnapshot();},
      transact:async apply=>{transactions++;return persisted.transact(apply);}};
    const unavailable=()=>{dependencyCalls++;throw new Error('UNEXPECTED_RECOVERY_DEPENDENCY');};
    const cold=f.restart({repository,serverClock:()=> '2026-08-22T08:00:00.000Z',services:new Map(),
      loadCurrentProductionBinding:unavailable,loadBatchMemberEvidence:unavailable,
      loadBatchEReadEvidence:unavailable,loadBatchObservationPolicy:unavailable,
      resolveLocalAsset:unavailable,upload:unavailable,requestJson:unavailable});
    const result=await cold.runDueBatchContinuations();
    assert.equal(result.status,writeCount===0?'failed':'unknown_outcome');
    assert.equal(result.executionStage,'asset_transport');
    assert.equal(reads,1);
    assert.equal(transactions,1);
    const saved=await persisted.readSnapshot();
    assert.equal(saved.runtime.dBatchImportJobs,undefined);
    assert.equal(saved.runtime.dBatchAssetTransports[0].revision,writeCount+2);
    assert.deepEqual(saved.candidates,interrupted.candidates);
    assert.deepEqual(saved.runtime.dProductionBatches,interrupted.runtime.dProductionBatches);
    reads=0;transactions=0;
    assert.equal((await cold.runDueBatchContinuations()).status,'idle');
    assert.equal(reads,4);
    assert.equal(transactions,0);
    assert.equal(dependencyCalls,0);
    assert.equal(f.calls.length,0);
    assert.equal(f.uploads.length,0);
  }
});

test('three-color batch uploads all eighteen final assets before one import and continues stock and E from its saved proofs',async()=>{
  const f=await localThreeColorFixture(),before=await f.repository.readSnapshot();
  const service=f.restart();
  assert.equal((await service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'waiting_platform');
  assert.equal(f.uploads.length,3);
  assert.equal(f.evidencePurposes.every(value=>value.purpose==='new_import'),true);
  const imported=f.calls.filter(call=>call.endpoint==='/v3/product/import');
  assert.equal(imported.length,1);
  assert.equal(imported[0].body.items.length,3);
  for(const item of imported[0].body.items){
    const model=f.models.get(item.offer_id);assert.ok(model);
    assert.equal(item.primary_image,model.media[0]);
    assert.deepEqual(item.images,model.media.slice(1));
    assert.equal(item.offer_id==='HISTORICAL-KHAKI',false);
  }
  const cold=f.restart(),steps=[];
  for(let index=0;index<12;index++){
    const result=await cold.runDueBatchContinuations();steps.push(result.status);
    if(result.status==='idle')break;
  }
  assert.equal(steps.at(-1),'idle');
  assert.equal(steps.filter(status=>status==='stock_accepted').length,3);
  assert.equal(steps.filter(status=>status==='card_and_stock_observed').length,3);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports.length,3);
  assert.equal(saved.runtime.dBatchAssetTransports[0].leaseExpiresAt,'2026-08-22T07:55:00.000Z');
  assert.equal(saved.runtime.dBatchAssetTransports.reduce((sum,record)=>sum+record.writeIntents.length,0),18);
  assert.equal(saved.runtime.dBatchEReadbacks.length,3);
  assert.equal(saved.runtime.dBatchEReadbacks.every(result=>result.listedVerified===false),true);
  assert.deepEqual(saved.candidates,before.candidates);
  assert.deepEqual(saved.runtime.softwareJobs,before.runtime.softwareJobs);
  assert.equal((await f.restart().runAuthorizedBatch({batchId:f.batch.batchId})).status,'idempotent_replay');
  assert.equal(f.uploads.length,3);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,3);
});
test('new three-color batch reaches independent E through the existing cold pump and one owner image review per member',async()=>{
  const runtimeNow='2026-10-18T14:00:00.000Z';
  const f=await localThreeColorFixture({batchVersion:3,runtimeNow}),before=await f.repository.readSnapshot();
  assert.equal((await f.restart().runAuthorizedBatch({batchId:f.batch.batchId})).status,'waiting_platform');
  const statuses=[];
  for(let index=0;index<15;index++){
    const result=await f.restart().runDueBatchContinuations();statuses.push(result.status);
    if(result.status==='idle')break;
  }
  assert.equal(statuses.at(-1),'idle');assert.equal(statuses.filter(value=>value==='matched').length,1);
  const observed=await f.repository.readSnapshot();
  assert.equal(observed.runtime.dBatchImportJobs[0].schemaVersion,'d-batch-import-job-v4');
  assert.equal(observed.runtime.dBatchInSaleJobs.length,1);
  assert.equal(observed.runtime.dBatchInSaleJobs[0].matches.length,3);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/list').length,1);
  assert.equal(observed.runtime.dBatchEVerifications,undefined);
  assert.equal(projectDBatchExecutionView(observed,f.batch.batchId).members.every(member=>
    member.mediaReview.canConfirmMatch&&!member.listedVerified),true);
  // Distinct frozen chunks can stop after a successful earlier chunk. The stopped
  // members keep their exact state while the proven successful member remains verifiable.
  for(const stopStatus of ['prewrite_blocked','unknown_outcome']){
    const partial=structuredClone(observed),job=partial.runtime.dBatchImportJobs[0],original=job.chunks[0];
    const partialBatch=partial.runtime.dProductionBatches[0];
    job.chunks=partialBatch.members.map((member,index)=>{
      const items=[original.frozenImport.items[index]],memberSources=[original.frozenImport.memberSources[index]];
      const frozenImport={schemaVersion:original.frozenImport.schemaVersion,items,memberSources,
        itemFingerprint:fingerprintCanonicalRecord(items),contentFingerprint:fingerprintCanonicalRecord({items,memberSources})};
      return {...structuredClone(original),index,offerIds:[member.offerId],frozenImport,
        ...(index===0?{results:[original.results[0]]}:{taskId:null,results:null,observationReads:0,
          status:index===1?stopStatus:'not_sent',
          ...(index===1&&stopStatus==='prewrite_blocked'?{prewriteReasonCode:'SYNTHETIC_WRITE_DENIED',requestTransmission:'not_attempted'}:{}),
          ...(index===1&&stopStatus==='unknown_outcome'?{unknownReason:'synthetic_response_lost'}:{})})};
    });
    job.status=stopStatus==='prewrite_blocked'?'partial_failure':'unknown_outcome';partialBatch.status=job.status;
    assert.doesNotThrow(()=>reclaimDBatchImportJob({job,workerId:job.workerId,workerVersion:job.workerVersion,
      leaseId:'lease:synthetic:validation-only',observedAt:job.leaseExpiresAt,
      leaseExpiresAt:new Date(Date.parse(job.leaseExpiresAt)+60_000).toISOString()}));
    for(const collection of ['dBatchStockJobs','dBatchEJobs','dBatchEReadbacks','dBatchOfferRecords'])
      partial.runtime[collection]=partial.runtime[collection].filter(value=>value.candidateId===partialBatch.members[0].candidateId);
    const stock=partial.runtime.dBatchStockJobs[0],chunk=job.chunks[0];
    const record=createDBatchOfferRecord({batch:partialBatch,member:partialBatch.members[0],chunkIndex:0,stockJob:stock,
      source:chunk.frozenImport.memberSources[0],frozenImport:chunk.frozenImport,chunkOfferIds:chunk.offerIds,
      importObservation:chunk.results[0].importObservation,createdAt:stock.createdAt});
    partial.runtime.dBatchOfferRecords=[record];
    const previous=partial.runtime.dBatchEReadbacks[0];
    const readback=createDBatchEReadback({record,observation:previous.observation,readAt:previous.readAt,readSequence:previous.readSequence});
    partial.runtime.dBatchEReadbacks=[readback];partial.runtime.dBatchEJobs[0].resultId=readback.readbackId;
    delete partial.runtime.dBatchInSaleJobs;
    const repository=createMemoryBusinessStateRepository(partial),beforeCalls=f.calls.length;
    const service=f.restart({repository});
    const result=await service.runDueBatchContinuations();
    assert.equal(result.status,'matched',stopStatus);assert.equal(result.job.scope.targets.length,1);
    assert.equal(f.calls.length,beforeCalls+1);assert.equal(f.calls.at(-1).endpoint,'/v3/product/list');
    assert.deepEqual((await repository.readSnapshot()).runtime.dBatchImportJobs,[job]);
  }
  const actor=createActorContext({userId:'synthetic-owner',sessionId:'session:batch-e',actorType:'human',
    roles:['owner'],source:'authenticated_identity_provider',authenticatedAt:runtimeNow});
  for(const member of f.batch.members){
    const review=projectDBatchEMediaReview({document:await f.repository.readSnapshot(),batchId:f.batch.batchId,candidateId:member.candidateId});
    await confirmDBatchEMediaReview({repository:f.repository,runtimeMode:'local_development',serverClock:()=>runtimeNow,actor,
      input:{scope:review.scope,decision:'matches',confirmContent:true,confirmHero:true,confirmOrder:true}});
    assert.equal((await f.restart().runDueBatchContinuations()).status,'batch_e_verified');
  }
  const saved=await f.repository.readSnapshot(),view=projectDBatchExecutionView(saved,f.batch.batchId);
  assert.equal(saved.runtime.dBatchEVerifications.length,3);assert.equal(view.members.every(member=>member.listedVerified),true);
  assert.deepEqual(saved.candidates,before.candidates);assert.deepEqual(saved.runtime.dProductionBatches[0].importLimitUse,f.batch.importLimitUse);
  assert.equal((await f.restart().runDueBatchContinuations()).status,'idle');
  assert.equal((await f.restart().runAuthorizedBatch({batchId:f.batch.batchId})).status,'idempotent_replay');
  assert.equal(f.uploads.length,3);assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,3);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/list').length,3,'one main list plus two isolated partial-batch cases');
});

test('one unavailable final asset blocks the entire three-color import before any upload',async()=>{
  const f=await localThreeColorFixture();
  f.files.delete([...f.files.keys()].at(-1));
  const result=await f.restart().runAuthorizedBatch({batchId:f.batch.batchId});
  assert.equal(result.status,'blocked');
  assert.equal(result.executionStage,'asset_transport');
  assert.equal(result.reasonCode,'OSS_LOCAL_ASSET_UNAVAILABLE');
  assert.equal(f.uploads.length,0);
  assert.equal(f.calls.length,0);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports,undefined);
  assert.equal(saved.runtime.dBatchImportJobs,undefined);
});
test('a possible asset write is durable unknown and a cold batch restart cannot import or replay it',async()=>{
  const f=await localThreeColorFixture();
  const service=f.restart({upload:async input=>{
    f.uploads.push(input.candidateId);
    const asset=input.finalUploads[0];
    await input.beforePublicWrite({assetId:asset.assetId,order:asset.order,sha256:asset.sha256});
    throw new Error('SYNTHETIC_UPLOAD_RESPONSE_LOST');
  }});
  assert.equal((await service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'unknown_outcome');
  assert.equal((await f.restart().runAuthorizedBatch({batchId:f.batch.batchId})).status,'unknown_outcome');
  assert.equal(f.uploads.length,1);
  assert.equal(f.calls.length,0);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchAssetTransports[0].status,'unknown_outcome');
  assert.equal(saved.runtime.dBatchImportJobs,undefined);
});
test('another service sees a saved asset intent in flight and cannot start the batch import early',async()=>{
  const f=await localThreeColorFixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  let gated=false;
  const service=f.restart({upload:async input=>{
    if(!gated){gated=true;entered.resolve();await release.promise;}
    return f.options.upload(input);
  }});
  const first=service.runAuthorizedBatch({batchId:f.batch.batchId});
  await Promise.race([entered.promise,first.then(()=>{throw new Error('Synthetic asset upload was not entered');})]);
  const parallel=await f.restart().runAuthorizedBatch({batchId:f.batch.batchId});
  assert.equal(parallel.status,'in_flight');
  assert.equal(f.calls.length,0);
  release.resolve();
  assert.equal((await first).status,'waiting_platform');
  assert.equal(f.uploads.length,3);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
});

test('software service requires a current batch limit before admission and sends no request', async () => {
  const f = await fixture();
  delete f.capability.productImport.maxItemsPerRequest;
  await assert.rejects(f.service.runAuthorizedBatch({ batchId: f.batch.batchId }),
    /D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs, undefined);
});
test('new batch authorization scope runs an explicit create-only import and software readback',async()=>{
  const f=await fixture();
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'create_only',
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  const started=await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  assert.equal(started.status,'waiting_platform');
  assert.equal((await f.service.runDueBatchContinuations()).status,'imported_awaiting_inventory');
  const e=await f.service.runDueBatchContinuations();
  assert.equal(e.status,'card_observed_pending_inventory');
  assert.equal((await f.service.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'idempotent_replay');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});

test('software service starts one persisted import task and duplicate start cannot resend', async () => {
  const f = await fixture();
  const first = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(first.status, 'waiting_platform');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  delete f.capability.productImport.maxItemsPerRequest;
  const replay = await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  assert.equal(replay.status, 'idempotent_replay');
  assert.equal(f.calls.filter(call => call.write).length, 1);
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchImportJobs[0].chunks[0].taskId, '9001');
});

test('software service records the offer observation without claiming inventory or E success', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  const observed = await f.service.observeBatchChunk({ batchId: f.batch.batchId, chunkIndex: 0 });
  assert.equal(observed.status, 'imported_awaiting_inventory');
  assert.equal(observed.results[0].classification, 'imported');
  const saved = await f.repository.readSnapshot();
  assert.equal(saved.runtime.dProductionBatches[0].members[0].status, 'imported_awaiting_inventory_and_e');
  const sku = saved.candidates.find(candidate => candidate.id === f.candidateId).lifecycleV11.skuPackage;
  assert.equal(sku.productionRecord, null);
  assert.equal(sku.eVerificationRecord, null);
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('an expired lease can be reclaimed without fresh import limit evidence', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const reclaimed = await f.service.reclaimBatchLease({ batchId: f.batch.batchId });
  assert.equal(reclaimed.status, 'waiting_platform');
  assert.equal(reclaimed.chunks[0].taskId, '9001');
  assert.equal(f.calls.filter(call => call.write).length, 1);
});

test('restarted software pump recovers only a saved task and never resends its import', async () => {
  const f = await fixture();
  await f.service.runAuthorizedBatch({ batchId: f.batch.batchId });
  delete f.capability.productImport.maxItemsPerRequest;
  f.capability.productImport.validUntil = '2026-08-22T07:20:00.000Z';
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const restarted = f.restartService();
  const result = await restarted.runDueBatchObservations();
  assert.equal(result.status, 'imported_awaiting_inventory');
  assert.deepEqual(f.calls.map(call => call.write), [true, false]);
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0].observationReads, 1);
});
test('historical v2 import job remains observable after a cold service restart',async()=>{
  const f=await fixture();
  await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  await f.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].schemaVersion='d-batch-import-job-v2';
    return {changed:true,document,result:null};
  });
  const observed=await f.restartService().runDueBatchObservations();
  assert.equal(observed.status,'imported_awaiting_inventory');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].schemaVersion,
    'd-batch-import-job-v2');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
});
test('known import observation preparation gaps stop one batch without a read and leave the next batch runnable',async()=>{
  for(const reason of ['evidence_not_ready','service_not_configured']){
    const first=await fixture({identity:`blocked-${reason}`,
      workerId:reason==='service_not_configured'?'worker:removed-service':'worker:batch-service',
      executionBinding:reason==='service_not_configured'
        ?{bindingId:'binding:synthetic:not-configured',configurationVersion:'config-v1',warehouseId:'70001'}:null});
    const second=await fixture({identity:`following-${reason}`});
    await first.service.runAuthorizedBatch({batchId:first.batch.batchId});
    await second.service.runAuthorizedBatch({batchId:second.batch.batchId});
    await appendBatchFixture(first,second);
    const overrides={services:second.services,workerRegistry:second.workerRegistry,
      loadCurrentProductionBinding:()=>second.productionBinding,
      loadBatchMemberEvidence:async({candidate})=>({
        capabilities:reason==='evidence_not_ready'&&candidate.id===first.candidateId
          ?{...structuredClone(first.capability),productImport:{status:'unverified'}}
          :structuredClone(second.capability),
        inspection:structuredClone(second.inspection),checkedAt:now}),
      requestJson:second.requestJson};
    const firstCallCount=first.calls.length,secondCallCount=second.calls.length;
    if(reason==='service_not_configured')assert.equal(second.workerRegistry.get('worker:removed-service'),null);
    const stopped=await first.restartService(overrides).runDueBatchObservations();
    assert.equal(stopped.status,'observation_stopped');
    assert.equal(stopped.reason,reason);
    assert.equal(first.calls.length,firstCallCount);
    assert.equal(second.calls.length,secondCallCount);
    const blocked=(await first.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0];
    assert.equal(blocked.status,'observation_stopped');
    assert.equal(blocked.stopReason,reason);
    assert.equal(blocked.observationReads,0);
    assert.equal(blocked.observationInFlight,false);
    assert.equal(blocked.taskId,'9001');
    assert.deepEqual(blocked.offerIds,[first.request.merchantSku]);
    const cold=first.restartService(overrides);
    const observed=await cold.runDueBatchObservations();
    assert.equal(observed.status,'imported_awaiting_inventory');
    assert.equal(observed.results[0].offerId,second.request.merchantSku);
    assert.equal((await cold.runDueBatchObservations()).status,'idle');
    assert.equal(first.calls.length,firstCallCount);
    assert.equal(second.calls.length,secondCallCount+1);
    const jobs=(await first.repository.readSnapshot()).runtime.dBatchImportJobs;
    assert.equal(jobs[0].chunks[0].observationReads,0);
    assert.equal(jobs[1].chunks[0].observationReads,1);
  }
});
test('an unknown import observation preparation error remains explicit and does not consume a read',async()=>{
  const f=await fixture();
  await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
  const failure=new TypeError('D_BATCH_SERVICE_OBSERVATION_EVIDENCE_NOT_READY');
  const service=f.restartService({loadBatchMemberEvidence:async()=>{throw failure;}});
  const before=f.calls.length;
  await assert.rejects(service.runDueBatchObservations(),error=>error===failure);
  const chunk=(await f.repository.readSnapshot()).runtime.dBatchImportJobs[0].chunks[0];
  assert.equal(chunk.status,'waiting_platform');
  assert.equal(chunk.observationReads,0);
  assert.equal(chunk.observationInFlight,false);
  assert.equal(f.calls.length,before);
});
test('an old import observation preparation failure cannot stop a newly reclaimed lease',async()=>{
  for(const entry of ['pump','explicit']){
    const f=await fixture();
    await f.service.runAuthorizedBatch({batchId:f.batch.batchId});
    const original=(await f.repository.readSnapshot()).runtime.dBatchImportJobs[0];
    let reclaimed;
    const service=f.restartService({loadBatchMemberEvidence:async()=>{
      f.advanceClock('2026-08-22T07:31:00.000Z');
      reclaimed=await f.service.reclaimBatchLease({batchId:f.batch.batchId});
      return {capabilities:{...structuredClone(f.capability),productImport:{status:'unverified'}},
        inspection:structuredClone(f.inspection),checkedAt:now};
    }});
    const before=f.calls.length;
    const action=entry==='pump'?service.runDueBatchObservations():
      service.observeBatchChunk({batchId:f.batch.batchId,chunkIndex:0});
    await assert.rejects(action,/D_BATCH_IMPORT_CHECKPOINT_SCOPE_CHANGED/);
    const saved=(await f.repository.readSnapshot()).runtime.dBatchImportJobs[0];
    assert.notEqual(reclaimed.leaseId,original.leaseId);
    assert.deepEqual(saved,reclaimed);
    assert.equal(saved.chunks[0].status,'waiting_platform');
    assert.equal(saved.chunks[0].observationReads,0);
    assert.equal(f.calls.length,before);
  }
});
test('create-only imported offer performs no stock precheck or stock write',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'idle');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].status,'inventory_deferred');
  assert.deepEqual(f.calls.map(call=>call.write),[true,false]);
});

test('authorized stock branch persists one exact prerequisite read and refuses nonzero stock',async()=>{
  for(const stockFree of [0,100]){
    const f=await fixture({stockFree});
    await seedV2ObservedImport(f,'write_authorized_stock');
    const first=await f.service.runDueBatchStockPrerequisites();
    assert.equal(first.status,stockFree===0?'ready_to_write':'needs_owner');
    assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].prerequisiteReads,1);
    assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'idle');
    assert.deepEqual(f.calls.map(call=>call.write),[true,false,false,false]);
  }
});
test('authorized stock sends once after durable intent; restart cannot replay accepted or unknown receipt',async()=>{
  for(const stockReceipt of ['accepted','incomplete']){
    const f=await fixture({stockReceipt});
    await seedV2ObservedImport(f,'write_authorized_stock');
    assert.equal((await f.service.runDueBatchStockPrerequisites()).status,'ready_to_write');
    const first=await f.service.runDueBatchStockWrites();
    assert.equal(first.status,stockReceipt==='accepted'?'stock_accepted':'unknown_outcome');
    const saved=await f.repository.readSnapshot();
    assert.ok(saved.runtime.dBatchStockJobs[0].stockIntentAt);
    assert.equal(saved.runtime.dBatchStockJobs[0].status,first.status);
    assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
    assert.equal((await f.restartService().runDueBatchStockWrites()).status,'idle');
    assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
  }
});
test('per-offer E distinguishes card creation without stock from authorized stock readback',async()=>{
  for(const inventoryAction of ['create_only','write_authorized_stock']){
    const f=await fixture();
    await seedV2ObservedImport(f,inventoryAction);
    if(inventoryAction==='write_authorized_stock'){
      await f.service.runDueBatchStockPrerequisites();
      await f.service.runDueBatchStockWrites();
    }
    const saved=await f.repository.readSnapshot();
    const batch=saved.runtime.dProductionBatches[0],chunk=saved.runtime.dBatchImportJobs[0].chunks[0];
    const record=createDBatchOfferRecord({batch,member:batch.members[0],chunkIndex:0,
      stockJob:saved.runtime.dBatchStockJobs[0],source:chunk.frozenImport.memberSources[0],
      frozenImport:chunk.frozenImport,chunkOfferIds:chunk.offerIds,
      importObservation:chunk.results[0].importObservation,createdAt:now});
    assert.equal(record.inventoryModified,inventoryAction==='write_authorized_stock');
    const media=record.readbackExpectation.media.map(item=>item.submittedUrl);
    const observation={platform:'ozon',store:record.store,storeRef:record.storeRef,
      warehouseRef:record.warehouseRef,credentialAlias:record.credentialAlias,
      skuPackageId:record.skuPackageId,supplierSkuId:record.supplierSkuId,
      merchantSku:record.offerId,platformProductId:record.productId,
      currentPrice:record.expectedPrice,currentStock:inventoryAction==='create_only'?'unknown':record.expectedStock,
      imageCount:media.length,errors:[],platformEvidenceRef:'receipt:synthetic:independent-readback',
      mediaObservation:{sourceProtocol:'ozon-product-info-v3',primaryImageUrl:media[0],images:media.slice(1)},
      inventoryObservation:{sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2',hasNext:false,
        rows:inventoryAction==='create_only'?[]:[{warehouseId:record.warehouseId,productId:record.productId,
          sku:'194001',offerId:record.offerId,freeStock:record.expectedStock,present:record.expectedStock,reserved:0}]}};
    const e=createDBatchEReadback({record,observation,readAt:now});
    assert.equal(e.status,inventoryAction==='create_only'?'card_observed_pending_inventory':'card_and_stock_observed');
    assert.equal(e.listedVerified,false);
    const drift=createDBatchEReadback({record,observation:{...observation,platformProductId:'999999'},readAt:now});
    assert.equal(drift.status,'not_verified');
    assert.ok(drift.gaps.includes('platformProductId'));
  }
});
test('software E persists one independent per-offer readback for each frozen inventory action',async()=>{
  for(const inventoryAction of ['create_only','write_authorized_stock']){
    const f=await fixture();
    await seedV2ObservedImport(f,inventoryAction);
    if(inventoryAction==='write_authorized_stock'){
      await f.service.runDueBatchStockPrerequisites();
      await f.service.runDueBatchStockWrites();
    }
    const result=await f.service.runDueBatchEReadbacks();
    assert.equal(result.status,inventoryAction==='create_only'?
      'card_observed_pending_inventory':'card_and_stock_observed');
    assert.equal(result.result.listedVerified,false);
    const saved=await f.repository.readSnapshot();
    assert.equal(saved.runtime.dBatchOfferRecords.length,1);
    assert.equal(saved.runtime.dBatchEReadbacks.length,1);
    assert.equal(saved.runtime.dBatchEJobs[0].status,'completed');
    assert.equal(saved.runtime.dProductionBatches[0].members[0].status,result.status);
    const view=projectDBatchExecutionView(saved,f.batch.batchId);
    assert.equal(view.members[0].eStatus,result.status);
    assert.equal(view.members[0].inventoryStatus,inventoryAction==='create_only'?'inventory_deferred':'stock_accepted');
    assert.equal(view.members[0].listedVerified,false);
    assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
    assert.equal(f.calls.filter(call=>call.write).length,
      inventoryAction==='create_only'?1:2);
  }
});
test('saved import E remains read-only after write qualification expires, but needs current read authority',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  f.expireWriteEvidence();
  f.capability.status='not_ready';
  f.capability.inventoryWrite.status='expired';
  f.inspection.permissionStatus='denied';
  const observed=await f.restartService().runDueBatchEReadbacks();
  assert.equal(observed.status,'card_observed_pending_inventory');
  assert.equal(f.calls.filter(call=>call.write).length,1);
  const denied=await fixture();
  await seedV2ObservedImport(denied,'create_only');
  denied.capability.independentReadback.status='expired';
  const before=denied.calls.length;
  const blocked=await denied.restartService().runDueBatchEReadbacks();
  assert.equal(blocked.status,'read_failed');
  assert.deepEqual(blocked.result.gaps,['technical_readback_failure:D_BATCH_E_READ_EVIDENCE_NOT_READY']);
  assert.equal(denied.calls.length,before);
  assert.equal((await denied.repository.readSnapshot()).runtime.dBatchEJobs[0].status,'read_failed');
  assert.equal((await denied.restartService().runDueBatchEReadbacks()).status,'idle');
  assert.equal(denied.calls.length,before);
});
test('E refuses a changed frozen import source before creating an offer record or reading the platform',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  await f.repository.transact(document=>{
    document.runtime.dBatchImportJobs[0].chunks[0].frozenImport.memberSources[0].stock+=1;
    return {changed:true,document,result:null};
  });
  const before=f.calls.length;
  await assert.rejects(()=>f.restartService().runDueBatchEReadbacks(),
    /D_BATCH_FROZEN_IMPORT_INVALID/);
  assert.equal(f.calls.length,before);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchOfferRecords,undefined);
  assert.equal(saved.runtime.dBatchEJobs,undefined);
});
test('explicit stock scope pumps import, prerequisite, stock and E without a second import',async()=>{
  const f=await fixture();
  await f.repository.transact(document=>{
    const batch=document.runtime.dProductionBatches[0];
    batch.schemaVersion='d-batch-production-authorization-v2';
    batch.postImportScope={schemaVersion:'d-batch-post-import-scope-v1',
      inventoryAction:'write_authorized_stock',
      eReadbackOfferIds:batch.members.map(member=>member.offerId)};
    return {changed:true,document,result:null};
  });
  assert.equal((await f.service.runAuthorizedBatch({batchId:f.batch.batchId})).status,'waiting_platform');
  assert.equal((await f.service.runDueBatchContinuations()).status,'imported_awaiting_inventory');
  assert.equal((await f.service.runDueBatchContinuations()).status,'ready_to_write');
  assert.equal((await f.service.runDueBatchContinuations()).status,'stock_accepted');
  assert.equal((await f.service.runDueBatchContinuations()).status,'card_and_stock_observed');
  assert.equal((await f.service.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});
test('a restarted process continues only the durable authorized unsent stock scope',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const restarted=f.restartService();
  assert.equal((await restarted.runDueBatchContinuations()).status,'stock_accepted');
  assert.equal((await restarted.runDueBatchContinuations()).status,'card_and_stock_observed');
  assert.equal((await restarted.runDueBatchContinuations()).status,'idle');
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v3/product/import').length,1);
});

test('known stock preparation failure is persisted locally and does not repeat on the next pump tick',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  f.expireWriteEvidence();
  const before=f.calls.length;
  const stopped=await f.restartService().runDueBatchContinuations();
  assert.equal(stopped.status,'precheck_failed');
  assert.equal(stopped.job.failureReason,'PRODUCTION_EXECUTION_BINDING_UNVERIFIED');
  assert.equal(f.calls.length,before);
  assert.equal((await f.restartService().runDueBatchStockPrerequisites()).status,'idle');
  assert.equal(f.calls.length,before);
});

test('one batch with unavailable stock evidence stops locally while another authorized batch continues',async()=>{
  const first=await fixture({identity:'first'}),second=await fixture({identity:'second'});
  await seedV2ObservedImport(first,'write_authorized_stock');
  await seedV2ObservedImport(second,'write_authorized_stock');
  await appendBatchFixture(first,second);
  const service=first.restartService({
    loadBatchMemberEvidence:async({candidate})=>{
      if(candidate.id===first.candidateId)throw new Error('PRODUCTION_EXECUTION_BINDING_UNVERIFIED');
      return {capabilities:structuredClone(second.capability),inspection:structuredClone(second.inspection),checkedAt:now};
    },
    requestJson:async(request,options)=>{
      if(request.endpoint!=='/v2/products/stocks')return second.requestJson(request,options);
      await options.beforeRequestSend();
      second.calls.push(request);
      const document=await first.repository.readSnapshot();
      assert.equal(document.runtime.dBatchStockJobs[1].status,'stock_intent');
      return {result:[{offer_id:second.request.merchantSku,product_id:94001,
        warehouse_id:Number(second.request.inventoryWrite.warehouseId),updated:true,errors:[]}]};
    }
  });
  assert.equal((await service.runDueBatchStockPrerequisites()).status,'precheck_failed');
  assert.equal((await service.runDueBatchStockPrerequisites()).status,'ready_to_write');
  const written=await service.runDueBatchStockWrites();
  assert.equal(written.status,'stock_accepted');
  assert.equal(written.job.offerId,second.request.merchantSku);
  const saved=await first.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs[0].status,'precheck_failed');
  assert.equal(saved.runtime.dBatchStockJobs[1].status,'stock_accepted');
  assert.equal(first.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,0);
  assert.equal(second.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});

test('an unknown programming failure during stock preparation is saved and rethrown unchanged',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  const failure=new TypeError('synthetic stock preparation defect');
  const service=f.restartService({loadBatchMemberEvidence:async()=>{throw failure;}});
  const before=f.calls.length;
  await assert.rejects(service.runDueBatchStockPrerequisites(),error=>error===failure);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs[0].status,'precheck_failed');
  assert.equal(saved.runtime.dBatchStockJobs[0].failureReason,'system_failure');
  assert.equal(f.calls.length,before);
});

test('a typed not-attempted stock failure becomes prewrite_blocked and never repeats',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  let attempts=0;
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint!=='/v2/products/stocks')return f.requestJson(request,options);
    attempts++;
    throw new OzonDEHttpTransportError('OZON_DE_HTTP_CREDENTIAL_UNAVAILABLE');
  }});
  const result=await service.runDueBatchStockWrites();
  assert.equal(result.status,'prewrite_blocked');
  assert.equal(attempts,1);
  assert.equal((await f.restartService().runDueBatchContinuations()).status,'idle');
  assert.equal(attempts,1);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,0);
});

test('an unexpected error after the stock send boundary preserves unknown and is rethrown',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  const failure=new TypeError('synthetic response parser defect');
  let attempts=0;
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint!=='/v2/products/stocks')return f.requestJson(request,options);
    await options.beforeRequestSend();
    attempts++;
    throw failure;
  }});
  await assert.rejects(service.runDueBatchStockWrites(),error=>error===failure);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs[0].status,'unknown_outcome');
  assert.ok(saved.runtime.dBatchStockJobs[0].stockIntentAt);
  assert.equal((await f.restartService().runDueBatchContinuations()).status,'idle');
  assert.equal(attempts,1);
});

test('late transmitted failure is saved after lease expiry and a cold restart never resends it',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  let attempts=0;
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint!=='/v2/products/stocks')return f.requestJson(request,options);
    await options.beforeRequestSend();
    attempts++;
    f.advanceClock('2026-08-22T07:31:00.000Z');
    throw new OzonDEHttpTransportError('OZON_DE_HTTP_RESPONSE_LOST',
      {layer:'transport',externalRequestState:'unknown',requestTransmission:'attempted'});
  }});
  const result=await service.runDueBatchStockWrites();
  assert.equal(result.status,'unknown_outcome');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].status,'unknown_outcome');
  assert.equal((await f.restartService().runDueBatchContinuations()).status,'idle');
  assert.equal(attempts,1);
});

test('concurrent stock pumps share one send and another service cannot overwrite its live intent',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint==='/v2/products/stocks'){
      await options.beforeRequestSend();
      entered.resolve();
      await release.promise;
    }
    return f.requestJson(request,options);
  }});
  const first=service.runDueBatchStockWrites();
  await entered.promise;
  const second=service.runDueBatchStockWrites();
  assert.equal((await f.restartService().runDueBatchStockWrites()).status,'idle');
  assert.equal((await f.repository.readSnapshot()).runtime.dBatchStockJobs[0].status,'stock_intent');
  release.resolve();
  assert.deepEqual((await Promise.all([first,second])).map(result=>result.status),
    ['stock_accepted','stock_accepted']);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});

test('a same-lease stock identity change is refused at the final send guard',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  let transmissions=0;
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint!=='/v2/products/stocks')return f.requestJson(request,options);
    await f.repository.transact(document=>{
      document.runtime.dBatchStockJobs[0].workerVersion='changed-version';
      return {changed:true,document,result:null};
    });
    await options.beforeRequestSend();
    transmissions++;
    return f.requestJson(request,options);
  }});
  await assert.rejects(service.runDueBatchStockWrites(),error=>error instanceof AggregateError &&
    error.message==='D_BATCH_STOCK_FAILURE_CHECKPOINT_FAILED' &&
    error.errors.some(item=>item.message==='D_BATCH_STOCK_CHECKPOINT_SOURCE_CHANGED'));
  assert.equal(transmissions,0);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,0);
  const job=(await f.repository.readSnapshot()).runtime.dBatchStockJobs[0];
  assert.equal(job.workerVersion,'changed-version');
  assert.equal(job.status,'stock_intent');
  assert.equal(job.inventoryReceiptRef,null);
});

test('a stock receipt cannot be attributed to a changed worker version under the same lease',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  const service=f.restartService({requestJson:async(request,options)=>{
    if(request.endpoint!=='/v2/products/stocks')return f.requestJson(request,options);
    await options.beforeRequestSend();
    const response=await f.requestJson(request,options);
    await f.repository.transact(document=>{
      document.runtime.dBatchStockJobs[0].workerVersion='changed-version';
      return {changed:true,document,result:null};
    });
    return response;
  }});
  await assert.rejects(service.runDueBatchStockWrites(),error=>error instanceof AggregateError &&
    error.message==='D_BATCH_STOCK_FAILURE_CHECKPOINT_FAILED' &&
    error.errors.some(item=>item.message==='D_BATCH_STOCK_CHECKPOINT_SOURCE_CHANGED'));
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchStockJobs[0].workerVersion,'changed-version');
  assert.equal(saved.runtime.dBatchStockJobs[0].status,'stock_intent');
  assert.equal(saved.runtime.dBatchStockJobs[0].inventoryReceiptRef,null);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});

test('an interrupted stock intent or prerequisite read is settled without replaying either action',async()=>{
  for(const state of ['stock_intent','prerequisites_in_flight']){
    const f=await fixture();
    await seedV2ObservedImport(f,'write_authorized_stock');
    if(state==='stock_intent')await f.service.runDueBatchStockPrerequisites();
    await f.repository.transact(document=>{
      const job=document.runtime.dBatchStockJobs[0];
      document.runtime.dBatchStockJobs[0]=applyDBatchStockEvent({job,event:{
        kind:state==='stock_intent'?'stock_intent':'prerequisites_started',offerId:job.offerId,
        taskId:job.taskId,productId:job.productId},workerId:job.workerId,leaseId:job.leaseId,observedAt:now});
      return {changed:true,document,result:null};
    });
    f.advanceClock('2026-08-22T07:31:00.000Z');
    const before=f.calls.length;
    const result=await f.restartService().runDueBatchContinuations();
    assert.equal(result.status,state==='stock_intent'?'unknown_outcome':'precheck_failed');
    assert.equal((await f.restartService().runDueBatchContinuations()).status,'idle');
    assert.equal(f.calls.length,before);
  }
});

test('an unknown stock receipt stops E and cannot be resumed as an unsent write',async()=>{
  const f=await fixture({stockReceipt:'incomplete'});
  await seedV2ObservedImport(f,'write_authorized_stock');
  await f.service.runDueBatchStockPrerequisites();
  assert.equal((await f.service.runDueBatchStockWrites()).status,'unknown_outcome');
  const restarted=f.restartService();
  assert.equal((await restarted.runDueBatchContinuations()).status,'idle');
  await assert.rejects(restarted.resumeAuthorizedBatchContinuations({batchId:f.batch.batchId}),
    /RESUME_NOTHING_UNSENT/);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchEReadbacks,undefined);
  assert.equal(f.calls.filter(call=>call.endpoint==='/v2/products/stocks').length,1);
});
test('create-only missing independent product readback remains unverified without a stock write',async()=>{
  const f=await fixture({eMissingAttributes:true});
  await seedV2ObservedImport(f,'create_only');
  const failed=await f.service.runDueBatchEReadbacks();
  assert.equal(failed.status,'read_failed');
  assert.equal(failed.result.status,'not_verified');
  assert.equal(failed.result.listedVerified,false);
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
  assert.equal(f.calls.filter(call=>call.write).length,1);
});

function pricePendingService(f){
  return f.restartService({requestJson:async(request,options)=>{
    const response=await f.requestJson(request,options);
    if(request.endpoint==='/v5/product/info/prices')response.items[0].price.price+=1;
    return response;
  }});
}

test('E observes only comparable pending data at the saved interval and appends each result across restart',async()=>{
  const f=await fixture({policyOverrides:{intervalMs:5000}});
  await seedV2ObservedImport(f,'create_only');
  const pending=pricePendingService(f);
  const first=await pending.runDueBatchEReadbacks();
  assert.equal(first.status,'verification_pending');
  assert.equal(first.job.status,'observed_pending');
  assert.equal(first.job.nextReadAt,'2026-08-22T07:25:05.000Z');
  assert.equal(first.result.readSequence,1);
  assert.equal(first.result.observationDisposition,'observe');
  const calls=f.calls.length;
  assert.equal((await pending.runDueBatchEReadbacks()).status,'idle');
  assert.equal(f.calls.length,calls);
  f.advanceClock('2026-08-22T07:25:05.000Z');
  const second=await f.restartService().runDueBatchEReadbacks();
  assert.equal(second.status,'card_observed_pending_inventory');
  assert.equal(second.job.status,'completed');
  assert.equal(second.result.readSequence,2);
  assert.notEqual(second.result.readbackId,first.result.readbackId);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchEReadbacks.length,2);
  assert.deepEqual(saved.runtime.dBatchEReadbacks[0],first.result);
  assert.equal(saved.runtime.dBatchEJobs[0].resultId,second.result.readbackId);
  const view=projectDBatchExecutionView(saved,f.batch.batchId);
  assert.equal(view.members[0].eStatus,'card_observed_pending_inventory');
  assert.equal(view.members[0].listedVerified,false);
  assert.equal(f.calls.filter(call=>call.write).length,1);
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
});

test('E stops at its saved query budget without a third platform read or overwriting earlier observations',async()=>{
  const f=await fixture({policyOverrides:{maxQueries:2}});
  await seedV2ObservedImport(f,'create_only');
  const service=pricePendingService(f);
  const first=await service.runDueBatchEReadbacks();
  const second=await service.runDueBatchEReadbacks();
  assert.equal(first.status,'verification_pending');
  assert.equal(second.status,'verification_pending');
  const before=f.calls.length;
  const stopped=await f.restartService().runDueBatchEReadbacks();
  assert.equal(stopped.status,'observation_stopped');
  assert.equal(stopped.job.stopReason,'query_limit');
  assert.equal(stopped.job.readCount,2);
  assert.equal(f.calls.length,before);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchEReadbacks,[first.result,second.result]);
  assert.equal((await service.runDueBatchEReadbacks()).status,'idle');
});

test('E stops when its saved policy expires even before the next scheduled observation',async()=>{
  const f=await fixture({policyOverrides:{intervalMs:30_000,expiresAt:'2026-08-22T07:31:00.000Z'}});
  await seedV2ObservedImport(f,'create_only');
  f.advanceClock('2026-08-22T07:30:55.000Z');
  const service=pricePendingService(f);
  assert.equal((await service.runDueBatchEReadbacks()).status,'verification_pending');
  const before=f.calls.length;
  f.advanceClock('2026-08-22T07:31:01.000Z');
  const stopped=await f.restartService().runDueBatchEReadbacks();
  assert.equal(stopped.status,'observation_stopped');
  assert.equal(stopped.job.stopReason,'policy_expired');
  assert.equal(f.calls.length,before);
});

test('E identity mismatch is terminal and never becomes a pending observation',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  const service=f.restartService({requestJson:async(request,options)=>{
    const response=await f.requestJson(request,options);
    if(request.endpoint==='/v4/product/info/attributes')response.result[0].product_id=94002;
    return response;
  }});
  const stopped=await service.runDueBatchEReadbacks();
  assert.equal(stopped.status,'read_failed');
  assert.equal(stopped.result.status,'not_verified');
  assert.equal(stopped.result.observationDisposition,'failed');
  const before=f.calls.length;
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
  assert.equal(f.calls.length,before);
});

test('a restarted v2 E read in flight is recorded as interrupted without replaying its platform request',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  const first=await pricePendingService(f).runDueBatchEReadbacks();
  await f.repository.transact(document=>{
    const job=document.runtime.dBatchEJobs[0];
    document.runtime.dBatchEJobs[0]=applyDBatchEJobEvent({job,event:{kind:'read_started'},
      workerId:job.workerId,leaseId:job.leaseId,observedAt:now});
    return {changed:true,document,result:null};
  });
  f.advanceClock('2026-08-22T07:31:00.000Z');
  const before=f.calls.length;
  const stopped=await f.restartService().runDueBatchEReadbacks();
  assert.equal(stopped.status,'read_failed');
  assert.equal(stopped.result.readSequence,2);
  assert.deepEqual(stopped.result.gaps,['technical_readback_failure:read_interrupted']);
  assert.equal(f.calls.length,before);
  const saved=await f.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchEReadbacks[0],first.result);
  assert.equal(saved.runtime.dBatchEReadbacks.length,2);
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
});

test('completed legacy v1 E history remains unchanged and is never upgraded or reread',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  await f.service.runDueBatchEReadbacks();
  await f.repository.transact(document=>{
    const record=document.runtime.dBatchOfferRecords[0];
    const observation=document.runtime.dBatchEReadbacks[0].observation;
    const historical=createDBatchEReadback({record,observation,readAt:now,
      schemaVersion:'d-batch-e-readback-v1'});
    const job=document.runtime.dBatchEJobs[0];
    job.schemaVersion='d-batch-e-job-v1';
    delete job.nextReadAt;
    job.resultId=historical.readbackId;
    document.runtime.dBatchEReadbacks=[historical];
    return {changed:true,document,result:null};
  });
  const before=await f.repository.readSnapshot(),calls=f.calls.length;
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
  assert.equal(f.calls.length,calls);
  assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('E records an exact read-permission gap without platform traffic and leaves another offer runnable',async()=>{
  const first=await fixture({identity:'e-denied'}),second=await fixture({identity:'e-allowed'});
  await seedV2ObservedImport(first,'create_only');
  await seedV2ObservedImport(second,'create_only');
  await appendBatchFixture(first,second);
  const service=first.restartService({loadBatchEReadEvidence:async({candidate})=>{
    if(candidate.id===first.candidateId)throw new OzonDEPreflightEvidenceError('BATCH_E_READ_NOT_AUTHORIZED');
    return {capabilities:structuredClone(second.capability),checkedAt:now};
  },requestJson:second.requestJson});
  const firstCalls=first.calls.length,secondCalls=second.calls.length;
  const stopped=await service.runDueBatchEReadbacks();
  assert.equal(stopped.status,'read_failed');
  assert.deepEqual(stopped.result.gaps,
    ['technical_readback_failure:OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED']);
  assert.equal(first.calls.length,firstCalls);
  assert.equal(second.calls.length,secondCalls);
  const observed=await service.runDueBatchEReadbacks();
  assert.equal(observed.status,'card_observed_pending_inventory');
  assert.equal(observed.result.offerId,second.request.merchantSku);
  const saved=await first.repository.readSnapshot();
  assert.deepEqual(saved.runtime.dBatchEJobs.map(job=>job.status),['read_failed','completed']);
  assert.equal(saved.runtime.dBatchEReadbacks.length,2);
  assert.equal(first.calls.length,firstCalls);
  assert.equal(second.calls.filter(call=>call.write).length,1);
});

test('an unexpected E preparation error is persisted as failed and still propagates unchanged',async()=>{
  const f=await fixture();
  await seedV2ObservedImport(f,'create_only');
  const failure=new TypeError('synthetic read-authority parser defect');
  const service=f.restartService({loadBatchEReadEvidence:async()=>{throw failure;}});
  const before=f.calls.length;
  await assert.rejects(service.runDueBatchEReadbacks(),error=>error===failure);
  const saved=await f.repository.readSnapshot();
  assert.equal(saved.runtime.dBatchEJobs[0].status,'read_failed');
  assert.deepEqual(saved.runtime.dBatchEReadbacks[0].gaps,['technical_readback_failure:system_failure']);
  assert.equal(f.calls.length,before);
  assert.equal((await f.restartService().runDueBatchEReadbacks()).status,'idle');
});
