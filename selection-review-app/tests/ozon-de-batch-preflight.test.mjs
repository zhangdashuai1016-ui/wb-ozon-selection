import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createOzonDEPreflightProvider, inspectOzonDEPreflightCapabilities,
  assertOzonDEPreflightEvidence,OzonDEPreflightEvidenceError } from '../lib/ozon-de-preflight-provider.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { assertCurrentProductionExecutionBinding } from '../lib/platform-write-preflight.mjs';
import { loadOzonProductImportBatchLimitEvidence, loadOzonProductImportBatchLimitFact,
  createOzonProductImportBatchLimitUse } from '../lib/ozon-product-import-batch-limit.mjs';
import { createDBatchAssetTransport, readDBatchAssetTransportProof } from '../lib/d-batch-asset-transport.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { authorizedProductionFixture, localFinalAssets } from './helpers/c2-software-fixture.mjs';

const batchNow='2026-09-28T00:41:00.000Z';
function readyBatchEvidence() {
  const {context,record,scope}=ozonDEPreflightEvidenceFixture();
  record.schemaVersion='ozon-de-preflight-evidence-v4';
  record.collectedAt='2026-09-28T00:40:00.000Z';
  record.expiresAt='2026-09-29T00:40:00.000Z';
  record.protocols.inventoryWrite.prerequisitePolicy={schemaVersion:'ozon-inventory-prerequisite-policy-v1',
    policyId:'policy:synthetic:inventory',version:'synthetic-v1',
    officialEvidenceRef:'evidence:synthetic:official-inventory',
    priceSent:{endpoint:'/v3/product/info/list',field:'statuses.status',acceptedValues:['synthetic_price_sent']},
    reserved:{endpoint:'/v2/product/info/stocks-by-warehouse/fbs',sourceProtocol:'ozon-product-stocks-by-warehouse-fbs-v2'},
    stockRequest:{identityField:'offer_id',quantSize:null}};
  context.productionBinding.verification.checkedAt='2026-09-28T00:40:00.000Z';
  context.productionBinding.verification.expiresAt='2026-09-29T00:40:00.000Z';
  const candidate=context.candidate,authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  candidate.targetPlatform=authorization.lockedScope.platform;
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:ready',status:'authorized',
    storeRef:structuredClone(authorization.lockedScope.storeRef),ownerActorId:authorization.authorizedByActorId,
    confirmedAt:authorization.authorizedAt,externalRequestState:'not_sent',excludedOfferIds:['HISTORICAL-KHAKI'],
    postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'write_authorized_stock',
      eReadbackOfferIds:[authorization.lockedScope.merchantSku]},
    members:[{candidateId:candidate.id,skuPackageId:authorization.lockedScope.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,authorizationId:authorization.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(authorization),sourceRevision:authorization.sourceCandidateRevision,
      resultRevision:candidate.dataRevision}]};
  assert.deepEqual(assertOzonDEPreflightEvidence(record),record);
  assert.equal(inspectOzonDEPreflightCapabilities({candidate,authorization,scope,record,reason:null,now:batchNow}).status,'ready');
  return {candidate,record,batch,productionBinding:context.productionBinding};
}

test('new batch preflight resolves its chosen fact without consuming the single import use or reviving legacy TTL',async()=>{
  const f=readyBatchEvidence(),fact=await loadOzonProductImportBatchLimitFact(),now='2026-10-18T13:15:00.000Z';
  f.record.collectedAt=fact.observedAt;f.record.expiresAt='2026-10-19T00:00:00.000Z';
  f.productionBinding.verification.checkedAt=fact.observedAt;
  f.productionBinding.verification.expiresAt=f.record.expiresAt;
  Object.assign(f.batch,{schemaVersion:'d-batch-production-authorization-v3',confirmedAt:now,
    postImportScope:{...f.batch.postImportScope,schemaVersion:'d-batch-post-import-scope-v2',inSaleList:{
      schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
      officialEvidenceRef:'official:ozon-in-sale-list:20261018',
      policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}}});
  f.batch.importLimitUse=createOzonProductImportBatchLimitUse({batch:f.batch,input:{
    schemaVersion:'ozon-product-import-batch-limit-use-input-v1',evidenceRef:fact.evidenceRef,decision:'use_for_this_batch_once'}});
  let reads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=>now,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async({batch})=>{reads++;assert.equal(batch.batchId,f.batch.batchId);return fact;}});
  const before=structuredClone(f.batch);
  for(let index=0;index<2;index++) {
    const result=await provider.loadBatchMemberEvidence(f);
    assert.equal(result.capabilities.status,'ready');
    assert.equal(Object.hasOwn(result.capabilities.productImport,'validUntil'),false);
    assert.deepEqual(result.capabilities.productImport.limitUse,f.batch.importLimitUse);
  }
  assert.equal(reads,2);assert.deepEqual(f.batch,before);
  await provider.loadBatchMemberEvidence({...f,purpose:'import_observation'});
  assert.equal(reads,2);
  const legacy=await loadOzonProductImportBatchLimitEvidence();
  const wrong=createOzonDEPreflightProvider({serverClock:()=>now,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>legacy});
  await assert.rejects(wrong.loadBatchMemberEvidence(f),/LIMIT_FACT_INVALID/);
  const changed=structuredClone(f);changed.batch.importLimitUse.members[0].authorizationId='pa:other';
  await assert.rejects(provider.loadBatchMemberEvidence(changed),/LIMIT_USE_SCOPE_MISMATCH/);
});

test('the new list permission requires explicit batch scope and the current receipt-backed method grant',async()=>{
  const f=readyBatchEvidence(),input={...f,offerId:f.batch.members[0].offerId};
  let grants=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    verifyInSaleListPermission:async({record,scope,checkedAt})=>{
      grants++;assert.deepEqual(record,f.record);assert.deepEqual(scope,f.record.scope);assert.equal(checkedAt,batchNow);
      return {status:'verified',protocolVersion:'ozon-in-sale-list-v1',endpoint:'/v3/product/list',
        evidenceRef:'receipt:synthetic:roles:list',officialEvidenceRef:'official:ozon-in-sale-list:20261018'};
    }});
  await assert.rejects(provider.loadBatchInSaleListEvidence(input),/IN_SALE_SCOPE_NOT_AUTHORIZED/);
  assert.equal(grants,0);
  f.batch.schemaVersion='d-batch-production-authorization-v3';
  f.batch.status='imported_awaiting_inventory';
  f.batch.postImportScope={...f.batch.postImportScope,schemaVersion:'d-batch-post-import-scope-v2',
    inSaleList:{schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
      officialEvidenceRef:'official:ozon-in-sale-list:20261018',
      policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}};
  const before=structuredClone(f.record),result=await provider.loadBatchInSaleListEvidence(input);
  assert.equal(result.capabilities.inSaleListObservation.status,'verified');assert.equal(grants,1);
  assert.deepEqual(result.capabilities.independentReadback,f.record.protocols.independentReadback);
  assert.deepEqual(f.record,before);
  let sourceReads=0;
  const corrupt=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>{
    if(++sourceReads===2)throw new OzonDEPreflightEvidenceError('ACCOUNT_SOURCE_CONTENT_MISMATCH');
    return f.record;
  },verifyInSaleListPermission:async()=>{throw new Error('CORRUPTED_SOURCE_MUST_NOT_PROJECT_PERMISSION');}});
  await assert.rejects(corrupt.loadBatchInSaleListEvidence(input),{code:'OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_SOURCE_INVALID'});
  assert.equal(sourceReads,2);
  const absent=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record});
  await assert.rejects(absent.loadBatchInSaleListEvidence(input),/IN_SALE_SCOPE_NOT_AUTHORIZED/);
  f.record.protocols.independentReadback.status='denied';
  await assert.rejects(provider.loadBatchInSaleListEvidence(input),/BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(grants,1);
});

async function batchWithPersistedAssetProof() {
  const ready=readyBatchEvidence(),files=new Map();
  const assets=localFinalAssets().map((asset,index)=>{
    const body=Buffer.from(`synthetic provider batch asset ${index}`);
    const sha256=createHash('sha256').update(body).digest('hex');
    const value={...asset,sha256,byteSize:body.length,assetVersion:`sha256:${sha256}`};
    files.set(value.assetId,{body,contentType:'image/png'});
    return value;
  });
  const source=authorizedProductionFixture({candidateId:'candidate:batch-assets-provider',
    supplierSkuId:'SUPPLIER-BLACK',merchantSku:'MERCHANT-BLACK',assets});
  const authorization=source.productionAuthorization,locked=authorization.lockedScope;
  const candidate={id:source.candidateId,dataRevision:source.candidateRevision,targetPlatform:'ozon',
    targetStore:locked.storeRef.stableStoreId,storeRef:structuredClone(locked.storeRef),
    lifecycleV11:{skuPackage:structuredClone(source.skuPackage),c2UploadDraft:{schemaVersion:'c2-upload-draft-v1',
      candidateId:source.candidateId,skuPackageId:locked.skuPackageId,schemaEvidenceRef:locked.schemaEvidenceRef,
      uploads:locked.finalUploads.map(asset=>({...structuredClone(asset),status:'ready'})),
      selection:locked.finalUploads.map(asset=>({assetId:asset.assetId,order:asset.order}))}}};
  const batch={...ready.batch,ownerActorId:authorization.authorizedByActorId,confirmedAt:authorization.authorizedAt,
    storeRef:structuredClone(locked.storeRef),postImportScope:{schemaVersion:'d-batch-post-import-scope-v1',
      inventoryAction:'write_authorized_stock',eReadbackOfferIds:[locked.merchantSku]},
    members:[{candidateId:candidate.id,skuPackageId:locked.skuPackageId,offerId:locked.merchantSku,
      authorizationId:authorization.authorizationId,authorizationFingerprint:fingerprintCanonicalRecord(authorization),
      resultRevision:candidate.dataRevision}]};
  const record=structuredClone(ready.record);
  record.scope={...record.scope,candidateId:candidate.id,skuPackageId:locked.skuPackageId,
    supplierSkuId:locked.supplierSkuId,authorizationId:authorization.authorizationId,
    sourceCandidateRevision:authorization.sourceCandidateRevision};
  const document=initialBusinessStateDocument({now:batchNow});
  document.candidates=[candidate];document.runtime.dProductionBatches=[batch];
  const repository=createMemoryBusinessStateRepository(document);
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>batchNow});
  registry.register({workerId:'worker:batch-provider',version:'v1',observedAt:batchNow,capabilities:['ozon-production-execution']});
  let limitReads=0,uploads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>record,
    loadBatchLimitEvidence:async()=>{limitReads++;throw new Error('ASSET_PREPARATION_MUST_NOT_READ_IMPORT_LIMIT');},
    loadBatchAssetProof:async({candidate,batch})=>readDBatchAssetTransportProof({document:await repository.readSnapshot(),
      batchId:batch.batchId,candidateId:candidate.id})});
  const before=await repository.readSnapshot();
  const runtime=createDBatchAssetTransport({repository,runtimeMode:'local_development',workerRegistry:registry,
    serverClock:()=>batchNow,leaseDurationMs:1_800_000,loadCurrentProductionBinding:()=>ready.productionBinding,
    resolveLocalAsset:async asset=>files.get(asset.assetId),getBatchMemberEvidence:provider.loadBatchMemberEvidence,
    upload:async({finalUploads,resolveLocalAsset,beforePublicWrite})=>{
      uploads++;
      for(const asset of finalUploads){
        assert.ok(Buffer.isBuffer((await resolveLocalAsset(asset)).body));
        await beforePublicWrite({assetId:asset.assetId,order:asset.order,sha256:asset.sha256});
      }
      return {status:'verified',mode:'preapproved_stable_https',protocolVersion:'aliyun-oss-final-assets-v1',
        evidenceRef:'evidence:synthetic:batch-provider-assets',approvedHosts:['assets.example.invalid'],
        resolvedAssets:finalUploads.map(asset=>({assetId:asset.assetId,order:asset.order,sha256:asset.sha256,
          platformAcceptedUrl:`https://assets.example.invalid/${encodeURIComponent(asset.assetId)}.png`,
          stable:true,authorizationStatus:'approved',evidenceRef:`evidence:synthetic:asset:${asset.assetId}`}))};
    }});
  assert.equal((await runtime.run({batchId:batch.batchId,workerId:'worker:batch-provider'})).status,'verified');
  const saved=await repository.readSnapshot();
  assert.deepEqual(saved.candidates,before.candidates);
  assert.deepEqual(saved.runtime.dProductionBatches,before.runtime.dProductionBatches);
  assert.equal(uploads,1);assert.equal(limitReads,0);
  const proof=readDBatchAssetTransportProof({document:saved,batchId:batch.batchId,candidateId:candidate.id});
  assert.ok(proof);
  return {candidate,record,batch,productionBinding:ready.productionBinding,provider,proof,repository};
}

test('ready v4 batch combines account and separate current official item limit without mutating either source',async()=>{
  const f=readyBatchEvidence(),limit=await loadOzonProductImportBatchLimitEvidence();
  const before=structuredClone(f.record);
  let limitReads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>{limitReads++;return limit;}});
  const result=await provider.loadBatchMemberEvidence(f);
  assert.equal(result.capabilities.status,'ready');
  assert.equal(result.capabilities.productImport.status,'verified');
  assert.equal(result.capabilities.productImport.maxItemsPerRequest,100);
  assert.equal(result.capabilities.productImport.limitEvidenceRef,limit.evidenceRef);
  assert.equal(result.capabilities.productImport.evidenceRef,f.record.protocols.productImport.evidenceRef);
  assert.notEqual(result.capabilities.productImport.evidenceRef,result.capabilities.productImport.limitEvidenceRef);
  assert.equal(result.capabilities.productImport.validUntil,limit.validUntil);
  assert.equal(Object.isFrozen(result.capabilities),true);
  assert.equal(Object.isFrozen(result.capabilities.productImport),true);
  assert.equal(limitReads,1);
  assert.deepEqual(f.record,before);
});

test('batch observation never consumes the public send limit; missing or expired send evidence stops new import',async()=>{
  const f=readyBatchEvidence(),limit=await loadOzonProductImportBatchLimitEvidence();
  const observer=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>{throw new Error('OBSERVATION_READ_LIMIT');}});
  for(const purpose of ['import_observation','stock_write','asset_transport']){
    const observed=await observer.loadBatchMemberEvidence({...f,purpose});
    assert.equal(observed.capabilities.status,'ready');
    assert.equal(observed.capabilities.productImport.maxItemsPerRequest,null);
    assert.equal(Object.hasOwn(observed.capabilities.productImport,'limitEvidenceRef'),false);
  }
  const missing=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record});
  await assert.rejects(missing.loadBatchMemberEvidence(f),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_LIMIT_SOURCE_REQUIRED/);
  const invalid=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>null});
  await assert.rejects(invalid.loadBatchMemberEvidence(f),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  const forged=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>({...limit,sourceUrl:'https://example.test/forged-limit'})});
  await assert.rejects(forged.loadBatchMemberEvidence(f),/OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  f.record.expiresAt='2026-10-06T00:40:00.000Z';
  f.productionBinding.verification.expiresAt='2026-10-06T00:40:00.000Z';
  const expired=createOzonDEPreflightProvider({serverClock:()=>limit.validUntil,readEvidence:async()=>f.record,
    loadBatchLimitEvidence:async()=>limit});
  await assert.rejects(expired.loadBatchMemberEvidence(f),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_LIMIT_NOT_CURRENT/);
  const historical=await expired.loadBatchMemberEvidence({...f,purpose:'import_observation'});
  assert.equal(historical.capabilities.status,'ready');
});

test('batch member reads only its saved authorization and scope without a single D job', async () => {
  const { context, record } = ozonDEPreflightEvidenceFixture();
  const candidate = context.candidate;
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: 'd-batch:synthetic',
    status: 'authorized',storeRef:structuredClone(authorization.lockedScope.storeRef),
    members: [{ candidateId: candidate.id, skuPackageId: context.job.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(authorization), resultRevision: candidate.dataRevision }] };
  let reads = 0;
  const provider = createOzonDEPreflightProvider({ serverClock: () => '2026-08-22T07:25:00.000Z',
    readEvidence: async () => { reads++; return record; } });
  const result = await provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch,purpose:'import_observation' });
  assert.equal(reads, 1);
  assert.equal(result.capabilities.status, 'not_ready');
  assert.ok(result.capabilities.gaps.some(gap => gap.code === 'evidence_protocol_version_outdated'));
  batch.members[0].resultRevision++;
  await assert.rejects(provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch,purpose:'import_observation' }), /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads, 1);
});

test('batch E uses current read evidence after write verification expires, and rejects drift or missing read grants', async () => {
  const {context,record}=ozonDEPreflightEvidenceFixture();
  const candidate=context.candidate,authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  assert.equal(Object.hasOwn(candidate.lifecycleV11.skuPackage,'merchantSku'),false);
  assert.ok(authorization.lockedScope.merchantSku);
  const binding=structuredClone(context.productionBinding);
  binding.verification.expiresAt='2026-08-22T07:20:00.000Z';
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:e-read',status:'imported_awaiting_inventory',
    storeRef:structuredClone(authorization.lockedScope.storeRef),
    members:[{candidateId:candidate.id,skuPackageId:authorization.lockedScope.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,authorizationId:authorization.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(authorization),resultRevision:candidate.dataRevision}]};
  batch.postImportScope={eReadbackOfferIds:[batch.members[0].offerId]};
  assert.throws(()=>assertCurrentProductionExecutionBinding({productionAuthorization:authorization,
    currentProductionBinding:binding,checkedAt:'2026-08-22T07:25:00.000Z'}),/PRODUCTION_EXECUTION_BINDING_UNVERIFIED/);
  record.schemaVersion='ozon-de-preflight-evidence-v3';
  record.protocols.inventoryWrite={...record.protocols.inventoryWrite,status:'denied',prerequisitePolicy:null};
  record.inspection.permissionStatus='denied';
  let reads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=> '2026-08-22T07:25:00.000Z',
    readEvidence:async scope=>{reads++;assert.deepEqual(scope,record.scope);return structuredClone(record);}});
  const input={candidate,productionBinding:binding,batch,offerId:batch.members[0].offerId};
  const ready=await provider.loadBatchEReadEvidence(input);
  assert.equal(ready.capabilities.status,'read_ready');
  assert.equal(ready.capabilities.independentReadback.status,'verified');
  assert.equal(reads,1);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,warehouseId:'999999'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,credentialAlias:'credential-alias:synthetic:other'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  const forgedBatch=structuredClone(batch);
  forgedBatch.members[0].offerId='UNCONFIRMED-OFFER';
  forgedBatch.postImportScope.eReadbackOfferIds=['UNCONFIRMED-OFFER'];
  await assert.rejects(provider.loadBatchEReadEvidence({...input,batch:forgedBatch,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads,1);
  record.protocols.independentReadback.status='denied';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  record.protocols.independentReadback.status='verified';
  record.inspection.storeIdentityStatus='mismatched';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,3);
  record.inspection.storeIdentityStatus='matched';
  record.expiresAt='2026-08-22T07:25:00.000Z';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,4);
});

test('provider accepts the independent proof produced by the saved batch OSS runtime without adding candidate asset state',async()=>{
  const f=await batchWithPersistedAssetProof(),before=structuredClone(f.candidate);
  const result=await f.provider.loadBatchMemberEvidence({...f,purpose:'asset_transport'});
  assert.equal(result.capabilities.status,'ready');
  assert.deepEqual(result.capabilities.assetTransport,f.proof.assetTransport);
  assert.equal(Object.hasOwn(f.candidate.lifecycleV11.skuPackage,'dAssetTransport'),false);
  assert.deepEqual(f.candidate,before);
  assert.equal(result.capabilities.productImport.maxItemsPerRequest,null);
  assert.equal(Object.hasOwn(result.capabilities.productImport,'limitEvidenceRef'),false);
});

test('provider rejects a batch asset proof from another identity, revision, authorization, store, manifest or plan',async()=>{
  const f=await batchWithPersistedAssetProof();
  const otherPlan=readyBatchEvidence().candidate.lifecycleV11.skuPackage.dAssetTransport.intent.productionPlan;
  const original=structuredClone({candidate:f.candidate,batch:f.batch,proof:f.proof});
  const changes=[
    proof=>{proof.recordId='d-batch-assets:other';},
    proof=>{proof.batchId='d-batch:other';},
    proof=>{proof.candidateId='candidate:other';},
    proof=>{proof.skuPackageId='sku:other';},
    proof=>{proof.sourceRevision++;},
    proof=>{proof.authorizationId='production-auth:other';},
    proof=>{proof.authorizationFingerprint='0'.repeat(64);},
    proof=>{proof.storeRef.platformStoreId='seller-other';},
    proof=>{proof.finalUploadAssetIds.reverse();},
    proof=>{proof.productionPlan=structuredClone(otherPlan);}
  ];
  for(const mutate of changes){
    const proof=structuredClone(f.proof);mutate(proof);
    const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
      loadBatchAssetProof:async()=>proof});
    await assert.rejects(provider.loadBatchMemberEvidence({...f,purpose:'asset_transport'}),
      error=>error.code==='OZON_DE_PREFLIGHT_EVIDENCE_BATCH_ASSET_SCOPE_MISMATCH');
  }
  assert.deepEqual({candidate:f.candidate,batch:f.batch,proof:f.proof},original);
});

test('provider rejects an independent batch proof with a receipt outside its stable HTTPS manifest',async()=>{
  const f=await batchWithPersistedAssetProof();
  const proof=structuredClone(f.proof);
  proof.assetTransport.resolvedAssets[0].platformAcceptedUrl='https://wrong-host.example.invalid/image.png';
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>f.record,
    loadBatchAssetProof:async()=>proof});
  await assert.rejects(provider.loadBatchMemberEvidence({...f,purpose:'asset_transport'}),
    error=>error.code==='OZON_DE_PREFLIGHT_EVIDENCE_ASSET_RECEIPT_INVALID');
});

test('batch E distinguishes corrupted or mismatched evidence from a valid record missing read permission',async()=>{
  const f=readyBatchEvidence();
  f.batch.status='imported_awaiting_inventory';
  f.batch.postImportScope={eReadbackOfferIds:[f.batch.members[0].offerId]};
  const input={candidate:f.candidate,productionBinding:f.productionBinding,batch:f.batch,
    offerId:f.batch.members[0].offerId};
  for(const mutate of [record=>{record.scope.authorizationId='production-auth:other';},
    record=>{record.protocols.independentReadback.endpoints=['/unverified'];},
    record=>{record.provenance.softwareJobRef='';}]){
    const corrupted=structuredClone(f.record);mutate(corrupted);
    const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>corrupted});
    await assert.rejects(provider.loadBatchEReadEvidence(input),
      error=>error.code==='OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_SOURCE_INVALID');
  }
  const denied=structuredClone(f.record);denied.protocols.independentReadback.status='denied';
  const provider=createOzonDEPreflightProvider({serverClock:()=>batchNow,readEvidence:async()=>denied});
  await assert.rejects(provider.loadBatchEReadEvidence(input),
    error=>error.code==='OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED');
});
