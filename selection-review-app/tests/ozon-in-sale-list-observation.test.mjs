import test from 'node:test';
import assert from 'node:assert/strict';
import { assertInSaleListScope, assertInSaleListPolicy, assertInSaleListJob, createInSaleListJob,
  beginInSaleListPage, markInSaleListPageSending, buildInSaleListPageQuery, normalizeInSaleListPage,
  applyInSaleListPageResult, stopInSaleListJob, assertInSaleListRequestBody,
  OZON_IN_SALE_LIST_PROTOCOL_VERSION, OZON_IN_SALE_LIST_OFFICIAL_EVIDENCE_REF } from '../lib/ozon-in-sale-list-observation.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter, OZON_SELLER_API_DE_ADAPTER_VERSION } from '../lib/ozon-seller-api-de-adapter.mjs';
import { isCanonicalFrozenRef, isOpaqueProductionSourceRef } from '../lib/production-contract-primitives.mjs';
import { createDBatchEFixture } from './helpers/d-batch-e-fixture.mjs';

const at = seconds => new Date(Date.parse('2026-10-18T10:00:00.000Z')+seconds*1000).toISOString();
const clone = value => structuredClone(value);
function scope() {
  return {schemaVersion:'ozon-in-sale-list-scope-v1',batchId:'batch:synthetic',authorizationRef:'batch:synthetic:in-sale-list',
    officialEvidenceRef:OZON_IN_SALE_LIST_OFFICIAL_EVIDENCE_REF,accountEvidenceRef:'account-read:synthetic:roles',
    storeRef:{stableStoreId:'miska',platformStoreId:'seller:synthetic:1',mappingVersion:'mapping:synthetic:1'},
    warehouseRef:'warehouse:synthetic:1',warehouseId:'10001',credentialAlias:'credential-alias:synthetic:1',bindingId:'binding:synthetic:1',configurationVersion:'config:1',
    targets:[1,2,3].map(index=>({candidateId:`candidate:${index}`,skuPackageId:`sku:${index}`,sourceRevision:4,
      sourceRecordId:`d-batch-offer:synthetic:${index}`,authorizationId:`production-auth:${index}`,authorizationFingerprint:String(index).repeat(64),
      offerId:`SKU-${index}`,productId:String(100+index)}))};
}
const policy=()=>({pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000});
const holder={workerId:'worker:1',leaseId:'lease:1'};
function job(patch={}) { return createInSaleListJob({scope:scope(),policy:policy(),...holder,workerVersion:'worker:v1',leaseExpiresAt:at(120),createdAt:at(0),...patch}); }
function begin(current=job(),seconds=1) {return beginInSaleListPage({job:current,...holder,at:at(seconds)});}
function sending(current=begin(),seconds=1) {return markInSaleListPageSending({job:current,...holder,at:at(seconds)});}
const row=(offer_id,product_id)=>({offer_id,product_id,archived:false});
function page(current,items,last_id='cursor-next',seconds=2) {
  return normalizeInSaleListPage({query:buildInSaleListPageQuery(current),response:{result:{items,last_id}},observedAt:at(seconds)});
}
function apply(current,result,seconds=2) {return applyInSaleListPageResult({job:current,result,...holder,at:at(seconds)});}

test('one frozen scope keeps three exact D identities and explicit bounded policy without defaults',()=>{
  const input=scope(),current=job({scope:input});input.targets[0].offerId='changed';
  assert.equal(current.scope.targets[0].offerId,'SKU-1');assert.ok(Object.isFrozen(current.scope.targets[0]));
  assert.equal(current.deadlineAt,at(90));assert.equal(current.requestCount,0);
  for(const patch of [{maxPages:4},{pageSize:1001},{requestTimeoutMs:30001},{durationMs:90001},{maxPages:0}])
    assert.throws(()=>assertInSaleListPolicy({...policy(),...patch}),/POLICY_INVALID/);
  const missing=policy();delete missing.durationMs;assert.throws(()=>assertInSaleListPolicy(missing),/POLICY_INVALID/);
  for(const change of [s=>delete s.accountEvidenceRef,s=>s.targets[0].productId='9007199254740992',
    s=>s.targets.push(clone(s.targets[0])),s=>s.authorizationRef='other',s=>s.targets[0].authorizationFingerprint='not-a-fingerprint']){
    const inputScope=scope();change(inputScope);assert.throws(()=>assertInSaleListScope(inputScope),/SCOPE_INVALID/);
  }
});

test('a real batch PA keeps its full composite identity through a positive list observation',()=>{
  const fixture=createDBatchEFixture(),batch=fixture.document.runtime.dProductionBatches[0],member=batch.members[0];
  const binding=fixture.document.candidates[0].lifecycleV11.skuPackage.productionAuthorization.executionBinding;
  const record=fixture.record;
  const currentScope={schemaVersion:'ozon-in-sale-list-scope-v1',batchId:batch.batchId,
    authorizationRef:`${batch.batchId}:in-sale-list`,officialEvidenceRef:OZON_IN_SALE_LIST_OFFICIAL_EVIDENCE_REF,
    accountEvidenceRef:'account-read:synthetic:roles',storeRef:clone(record.storeRef),warehouseRef:record.warehouseRef,
    warehouseId:record.warehouseId,credentialAlias:record.credentialAlias,
    bindingId:binding.bindingId,configurationVersion:binding.configurationVersion,
    targets:[{candidateId:member.candidateId,skuPackageId:member.skuPackageId,sourceRevision:member.resultRevision,
      sourceRecordId:record.recordId,authorizationId:member.authorizationId,authorizationFingerprint:member.authorizationFingerprint,
      offerId:member.offerId,productId:record.productId}]};
  assert.ok(member.authorizationId.length>256);assert.equal(isCanonicalFrozenRef(member.authorizationId),false);
  assert.equal(isOpaqueProductionSourceRef(member.authorizationId),true);
  const current=sending(begin(job({scope:currentScope})));
  const unrelatedOffers=['历史蓝色背心','Legacy SKU 02',` ${record.offerId} `];
  const result=page(current,[...unrelatedOffers.map((offer,index)=>row(offer,990001+index)),
    row(record.offerId,Number(record.productId))],'');
  const completed=apply(current,result);
  assert.equal(result.itemCount,4);assert.equal(completed.status,'matched');assert.deepEqual(completed.scope,currentScope);
  assert.equal(completed.scope.targets[0].authorizationId,member.authorizationId);
  assert.equal(completed.scope.targets[0].sourceRecordId,record.recordId);
  assert.deepEqual(completed.matches,[{offerId:record.offerId,productId:record.productId,
    requestId:current.attempts[0].requestId,observedAt:at(2)}]);
  for(const unrelated of unrelatedOffers){
    assert.equal(JSON.stringify(result).includes(unrelated),false);
    assert.equal(JSON.stringify(completed).includes(unrelated),false);
  }
});

test('external offer IDs accept bounded business strings without normalizing or relaxing frozen target IDs',()=>{
  const current=sending(),longOffer='商'.repeat(1024),result=page(current,[row(longOffer,9001)]);
  assert.equal(result.itemCount,1);assert.deepEqual(result.matchedItems,[]);
  assert.equal(JSON.stringify(result).includes(longOffer),false);
  for(const invalid of ['',null,undefined,123,true,{},[],Object('offer'),'   ','\u00a0',
    'x\u0000y','x\ny','x\ty','x\u007fy','x\u0085y','x'.repeat(1025)]){
    assert.throws(()=>page(current,[row(invalid,9001)]),/OZON_IN_SALE_LIST_RESPONSE_IDENTITY_INVALID/);
  }
  for(const offerId of ['中文货号','SKU 1',' SKU-1 ']){
    const changed=scope();changed.targets[0].offerId=offerId;
    assert.throws(()=>assertInSaleListScope(changed),/SCOPE_INVALID/);
  }
  assert.throws(()=>page(current,[row(' SKU-1 ',101)]),/OZON_IN_SALE_LIST_RESPONSE_IDENTITY_CONFLICT/);
});

test('composite source and derived request IDs may exceed leaf limits without relaxing leaf references',()=>{
  const currentScope=scope();currentScope.batchId=`d-batch:${'b'.repeat(248)}`;
  currentScope.authorizationRef=`${currentScope.batchId}:in-sale-list`;
  currentScope.targets=currentScope.targets.slice(0,1);
  currentScope.targets[0].offerId=`SKU-${'s'.repeat(252)}`;
  currentScope.targets[0].sourceRecordId=`d-batch-offer:${currentScope.batchId}:${currentScope.targets[0].offerId}`;
  assert.equal(currentScope.batchId.length,256);assert.equal(currentScope.targets[0].offerId.length,256);
  assert.ok(currentScope.authorizationRef.length>256);assert.ok(currentScope.targets[0].sourceRecordId.length>256);
  const current=sending(begin(job({scope:currentScope})));
  const target=current.scope.targets[0],completed=apply(current,page(current,[row(target.offerId,Number(target.productId))],''));
  assert.equal(completed.status,'matched');assert.ok(completed.matches[0].requestId.length>256);
  assert.equal(completed.matches[0].requestId,`${current.jobId}:page:1`);
  for(const field of ['batchId','accountEvidenceRef','warehouseRef','credentialAlias','bindingId','configurationVersion']){
    const changed=scope();changed[field]='x'.repeat(257);
    assert.throws(()=>assertInSaleListScope(changed),/SCOPE_INVALID/);
  }
  for(const field of ['candidateId','skuPackageId','offerId']){
    const changed=scope();changed.targets[0][field]='x'.repeat(257);
    assert.throws(()=>assertInSaleListScope(changed),/SCOPE_INVALID/);
  }
  for(const field of ['authorizationId','sourceRecordId']){
    for(const invalid of ['',null,'Unknown','null','undefined','not_applicable','missing',' value','value ','x\ny','x\u007fy','x'.repeat(1025)]){
      const changed=scope();changed.targets[0][field]=invalid;
      assert.throws(()=>assertInSaleListScope(changed),/SCOPE_INVALID/);
    }
    const changed=scope();changed.targets[0][field]='production-source:api_key=synthetic-value';
    assert.throws(()=>assertInSaleListScope(changed),/RUNTIME_IDENTITY_INVALID/);
  }
});

test('101 batch targets share one job and one three-page budget across import request boundaries',()=>{
  const batchScope=scope(),template=batchScope.targets[0];
  batchScope.targets=Array.from({length:101},(_,index)=>({...template,candidateId:`candidate:${index}`,
    skuPackageId:`sku:${index}`,sourceRecordId:`d-batch-offer:synthetic:${index}`,authorizationId:`production-auth:${index}`,
    authorizationFingerprint:(index+1).toString(16).padStart(64,'0'),offerId:`SKU-${index}`,productId:String(1000+index)}));
  let current=job({scope:batchScope});
  const jobId=current.jobId;
  for(let index=0;index<3;index++){
    current=sending(begin(current,index*2+1),index*2+1);
    const items=batchScope.targets.slice(index*50,(index+1)*50).map(target=>row(target.offerId,Number(target.productId)));
    current=apply(current,page(current,items,`cursor-${index+1}`,index*2+2),index*2+2);
    assert.equal(current.jobId,jobId);assert.equal(current.requestCount,index+1);assert.equal(current.deadlineAt,at(90));
  }
  assert.equal(current.status,'matched');assert.equal(current.matches.length,101);assert.equal(current.policy.maxPages,3);
  assert.throws(()=>begin(current,7),/PAGE_NOT_ADMITTED/);
});

test('a page intent reserves budget before sending and only its holder can start one request',()=>{
  const current=begin();assert.equal(current.requestCount,1);assert.equal(current.attempts[0].requestTransmission,'not_attempted');
  assert.deepEqual(buildInSaleListPageQuery(current).scope,current.scope);
  assert.throws(()=>begin(current,2),/PAGE_NOT_ADMITTED/);
  assert.throws(()=>markInSaleListPageSending({job:current,workerId:'other',leaseId:'lease:1',at:at(1)}),/LEASE_INVALID/);
  const sent=sending(current);assert.equal(sent.attempts[0].requestTransmission,'possibly_sent');
  assert.throws(()=>sending(sent,2),/SEND_NOT_ADMITTED/);
});

test('only exact same-row offer and product pairs produce positive observations',()=>{
  const current=sending(),result=page(current,[row('unrelated',999),...scope().targets.map(target=>row(target.offerId,Number(target.productId)))]);
  assert.equal(result.itemCount,4);assert.equal(result.matchedItems.length,3);
  assert.equal(JSON.stringify(result).includes('unrelated'),false);assert.equal(Object.hasOwn(result,'response'),false);
  const completed=apply(current,result);assert.equal(completed.status,'matched');assert.equal(completed.matches.length,3);
  assert.equal(completed.attempts[0].requestTransmission,'response_received');assert.throws(()=>begin(completed,3),/PAGE_NOT_ADMITTED/);
  assert.equal(Object.hasOwn(completed,'listedVerified'),false);
});

test('empty or unmatched pages remain unverified rather than a negative sale claim or completed scan',()=>{
  const current=sending(),empty=apply(current,page(current,[],''));
  assert.equal(empty.status,'stopped');assert.equal(empty.stopReason,'empty_page');assert.deepEqual(empty.matches,[]);
  const unmatched=apply(current,page(current,[row('sku-1',999)]));
  assert.equal(unmatched.status,'page_observed');assert.deepEqual(unmatched.matches,[]);
  const cursorEmpty=apply(current,page(current,[row('unrelated',999)],''));
  assert.equal(cursorEmpty.stopReason,'cursor_empty');assert.equal(Object.hasOwn(cursorEmpty,'scanComplete'),false);
});

test('pagination uses only the previous returned cursor, spends at most three requests and never renews the deadline',()=>{
  let current=job();
  for(let index=1;index<=3;index++){
    current=sending(begin(current,index*2-1),index*2-1);
    assert.equal(current.attempts.at(-1).lastId,index===1?'':`cursor-${index-1}`);
    current=apply(current,page(current,[row(`unrelated-${index}`,900+index)],`cursor-${index}`,index*2),index*2);
    assert.equal(current.deadlineAt,at(90));
  }
  assert.equal(current.requestCount,3);assert.equal(current.status,'stopped');assert.equal(current.stopReason,'page_limit');
  assert.throws(()=>begin(current,7),/PAGE_NOT_ADMITTED/);
  const broken=clone(current);broken.attempts[1].lastId='invented';assert.throws(()=>assertInSaleListJob(broken),/ATTEMPT_INVALID/);
});

test('cursor stagnation and an accidentally repeated page stop with distinct durable reasons',()=>{
  let current=sending();current=apply(current,page(current,[row('other-a',901)],'cursor-1'));
  current=sending(begin(current,3),3);
  assert.equal(apply(current,page(current,[row('other-b',902)],'cursor-1',4),4).stopReason,'cursor_stalled');
  assert.equal(apply(current,page(current,[row('other-a',901)],'cursor-2',4),4).stopReason,'repeated_page');
});

test('timeout, restart and late receipt preserve spent budget and cannot restart the same job',()=>{
  const current=sending();
  const interrupted=stopInSaleListJob({job:current,...holder,at:at(121),reason:'read_interrupted',requestTransmission:'possibly_sent'});
  assert.equal(interrupted.status,'failed');assert.equal(interrupted.requestCount,1);assert.equal(interrupted.deadlineAt,at(90));
  assert.throws(()=>begin(interrupted,122),/DEADLINE_EXPIRED/);
  assert.throws(()=>stopInSaleListJob({job:current,...holder,at:at(121),reason:'read_interrupted',requestTransmission:'not_attempted'}),/TRANSMISSION_INVALID/);
  const late=apply(current,page(current,[row('SKU-1',101)],'cursor-1',91),91);
  assert.equal(late.stopReason,'deadline_exhausted');assert.equal(late.matches.length,1);
  assert.throws(()=>begin(late,92),/DEADLINE_EXPIRED/);
  assert.throws(()=>applyInSaleListPageResult({job:current,result:page(current,[]),workerId:'other',leaseId:'lease:1',at:at(2)}),/LEASE_INVALID/);
});

test('malformed, unsafe or contradictory identities fail explicitly and never become empty evidence',()=>{
  const current=sending();
  for(const response of [{},{result:{items:[],last_id:null}},{result:{items:[row('SKU-1',102)],last_id:''}},
    {result:{items:[row('SKU-1','101')],last_id:''}},
    {result:{items:[row('SKU-1',Number.MAX_SAFE_INTEGER+1)],last_id:''}},
    {result:{items:[{...row('SKU-1',101),archived:true}],last_id:''}},
    {result:{items:[row('other',901),row('other',901)],last_id:''}},
    {result:{items:Array.from({length:1001},(_,index)=>row(`other-${index}`,index+1000)),last_id:''}}])
    assert.throws(()=>normalizeInSaleListPage({query:buildInSaleListPageQuery(current),response,observedAt:at(2)}),/OZON_IN_SALE_LIST_RESPONSE_/);
});

test('known invalid platform data stops as a received-response failure without resetting the request count',()=>{
  const current=sending();
  const failed=stopInSaleListJob({job:current,...holder,at:at(2),reason:'platform_data_invalid',requestTransmission:'response_received'});
  assert.equal(failed.status,'failed');assert.equal(failed.requestCount,1);
  assert.equal(failed.attempts[0].requestTransmission,'response_received');assert.deepEqual(failed.matches,[]);
  assert.throws(()=>begin(failed,3),/PAGE_NOT_ADMITTED/);
  assert.throws(()=>normalizeInSaleListPage({query:buildInSaleListPageQuery(current),response:{},observedAt:'bad-clock'}),/CLOCK_INVALID/);
});

test('results must settle a sent matching intent and cannot replace its scope or be applied twice',()=>{
  const pending=begin(),sent=sending(pending),result=page(sent,[row('SKU-1',101)]);
  assert.throws(()=>apply(pending,result),/PAGE_RESULT_INVALID/);
  for(const patch of [{requestId:'other'},{requestedLastId:'other'},{matchedItems:[{offerId:'SKU-2',productId:'101'}]},
    {officialEvidenceRef:'other'},{observedAt:at(3)}])assert.throws(()=>apply(sent,{...result,...patch}),/PAGE_RESULT_INVALID/);
  const observed=apply(sent,result);assert.throws(()=>apply(observed,result),/PAGE_RESULT_INVALID/);
});

function adapterHarness({protocolPatch={},clock=()=>at(2),transport}={}){
  const source=scope(),calls=[];
  const adapter=createStoreIsolatedOzonSellerApiDEAdapter({serverClock:clock,adapterCapabilities:{status:'ready',platform:'ozon',store:'miska',
    adapterVersion:OZON_SELLER_API_DE_ADAPTER_VERSION,protocolVersion:'ozon-single-sku-d-e-v3',evidenceRef:'evidence:synthetic:route',
    storeRef:source.storeRef,warehouseRef:source.warehouseRef,warehouseId:source.warehouseId,credentialAlias:source.credentialAlias,
    inventoryWrite:{warehouseId:source.warehouseId,prerequisitePolicy:null},inSaleListObservation:{status:'verified',
      protocolVersion:OZON_IN_SALE_LIST_PROTOCOL_VERSION,evidenceRef:source.accountEvidenceRef,endpoint:'/v3/product/list',
      officialEvidenceRef:source.officialEvidenceRef,...protocolPatch}},
    requestJson:async(request,options)=>{calls.push(request);return transport?transport(request,options):
      (await options.beforeRequestSend(),{result:{items:[row('SKU-1',101)],last_id:'cursor-1'}});}});
  return {adapter,calls};
}

test('new adapter method sends exactly one no-ID IN_SALE page and passes the final-send callback through',async()=>{
  const f=adapterHarness();let guarded=0;
  const result=await f.adapter.readInSaleListPage(buildInSaleListPageQuery(begin()),{beforeRequestSend:async()=>{guarded++;}});
  assert.equal(f.calls.length,1);assert.equal(guarded,1);assert.equal(f.calls[0].write,false);
  assert.deepEqual(f.calls[0].body,{filter:{visibility:'IN_SALE'},last_id:'',limit:1000});
  assert.equal(result.matchedItems[0].offerId,'SKU-1');assert.equal(f.calls[0].executionKey,result.requestId);
});

test('adapter rejects old/missing method grant, scope drift, absent guard, expired deadline and cancellation before requesting',async()=>{
  const query=buildInSaleListPageQuery(begin()),options={beforeRequestSend:async()=>{}};
  for(const protocolPatch of [{protocolVersion:'ozon-independent-readback-v2'},{evidenceRef:'other'},{status:'denied'}]){
    const f=adapterHarness({protocolPatch});await assert.rejects(()=>f.adapter.readInSaleListPage(query,options),/CAPABILITY_NOT_AUTHORIZED/);assert.equal(f.calls.length,0);
  }
  const f=adapterHarness(),changed=clone(query);changed.scope.credentialAlias='other';
  await assert.rejects(()=>f.adapter.readInSaleListPage(changed,options),/CAPABILITY_NOT_AUTHORIZED/);
  await assert.rejects(()=>f.adapter.readInSaleListPage(query),/CAPABILITY_NOT_AUTHORIZED/);
  const expired=adapterHarness({clock:()=>at(90)});await assert.rejects(()=>expired.adapter.readInSaleListPage(query,options),/DEADLINE_EXPIRED/);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await assert.rejects(()=>f.adapter.readInSaleListPage(query,{...options,signal:controller.signal}),/cancelled/);
  assert.equal(f.calls.length,0);assert.equal(expired.calls.length,0);
});

test('adapter freezes query identity across an asynchronous request and never retries a transport failure',async()=>{
  const query=clone(buildInSaleListPageQuery(begin()));
  const f=adapterHarness({transport:async(_request,options)=>{
    await options.beforeRequestSend();query.scope.targets[0].offerId='changed-by-caller';
    return {result:{items:[row('SKU-1',101)],last_id:'cursor-1'}};
  }});
  const result=await f.adapter.readInSaleListPage(query,{beforeRequestSend:async()=>{}});
  assert.equal(result.matchedItems[0].offerId,'SKU-1');assert.equal(f.calls.length,1);
  const failure=new TypeError('programming failure');
  const failed=adapterHarness({transport:async()=>{throw failure;}});
  await assert.rejects(()=>failed.adapter.readInSaleListPage(buildInSaleListPageQuery(begin()),{beforeRequestSend:async()=>{}}),error=>error===failure);
  assert.equal(failed.calls.length,1);
});

test('identifier filters, extra filters and invalid limits are forbidden for the new observation',()=>{
  const body={filter:{visibility:'IN_SALE'},last_id:'',limit:1000};assertInSaleListRequestBody(body);
  for(const field of ['offer_id','product_id','skus']){
    assert.throws(()=>assertInSaleListRequestBody({...body,filter:{...body.filter,[field]:['101']}}),/REQUEST_BODY_INVALID/);
    assert.throws(()=>assertInSaleListRequestBody({...body,[field]:['101']}),/REQUEST_BODY_INVALID/);
  }
  assert.throws(()=>assertInSaleListRequestBody({...body,limit:1001}),/REQUEST_BODY_INVALID/);
});
