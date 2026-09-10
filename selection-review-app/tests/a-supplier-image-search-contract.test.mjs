import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../lib/a-supplier-image-search-contract.mjs';
const at='2026-09-09T08:00:00.000Z', later='2026-09-09T08:00:01.000Z',expires='2026-09-09T09:00:00.000Z';
function fixture(){
 const scope={schemaVersion:'a-supplier-image-search-scope-v1',candidateId:'candidate:test',sourceRevision:2,resultRevision:2,targetPlatform:'ozon',targetStore:'miska',imageSource:{kind:'sales_snapshot',snapshotId:'sales:test',imageIndex:0,imageRef:'image:sales:test:0',sourceEvidenceRef:'evidence:test'},request:{requestId:'request:test',method:'image_search',maxSearches:1,maxResults:4},bindingId:'binding:test',configurationVersion:'config:v1',credentialAlias:'session:browser',authorizationRef:'permit:test',expiresAt:expires};
 const candidate={id:scope.candidateId,dataRevision:2,targetPlatform:'ozon',targetStore:'miska',workflowStatus:'needs_user_data',salesSnapshotsV11:[{schemaVersion:'sales-snapshot-v1.1',snapshotId:'sales:test',platform:'ozon',marketScope:'ozon_general_market',sellerType:'unknown',sellerIdentityEvidence:{status:'unverified',signals:[],evidenceRef:'evidence:seller'},productUrl:'https://www.ozon.ru/product/123/',title:'test',imageRefs:['https://cdn.example.com/image.jpg'],currentPrice:2000,currency:'RUB',categoryPath:'unknown',attributes:{},collectedAt:at,evidenceRef:'evidence:test',collectorMode:'real_page_read_only',collectorVersion:'real-ozon-sales-snapshot-v1',readOnly:true}]};
 const authorization={schemaVersion:'software-job-authorization-record-v3',authorizationId:'permit:test',authorizationType:'a_supplier_image_search_once',status:'active',action:c.A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,scopeBinding:scope,authorizedByUserId:'user:test',authorizedAt:at,expiresAt:expires,maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null};
 const credential={schemaVersion:'software-job-credential-binding-v3',bindingId:'binding:test',credentialAlias:'session:browser',status:'active',provider:'1688_browser',sideEffectScope:c.A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE,scopeBinding:scope,allowedWorkerIds:['worker:test'],redaction:'credential_alias_only',boundAt:at,expiresAt:expires};
 const result={schemaVersion:'a-supplier-image-search-result-v1',provider:'1688_browser',requestId:'request:test',imageRef:scope.imageSource.imageRef,observedAt:later,status:'candidates_found',submissionEvidenceRef:'evidence:submitted',completionEvidenceRef:'evidence:completed',products:[{offerId:'123',sourceUrl:'https://detail.1688.com/offer/123.html',evidenceRef:'evidence:offer',sameSku:'unknown',minimumOrderQuantity:null}]};
 const receipt={schemaVersion:'a-supplier-image-search-receipt-v1',receiptId:'a-supplier-image-search-receipt:job:test',jobId:'job:test',scope,workerId:'worker:test',leaseId:'lease:test',startedAt:at,completedAt:later,status:'completed',failureClass:null,steps:[{method:'image_search',intentAt:at,sentAt:at,completedAt:later,externalRequestState:'succeeded',requestTransmission:'response_received',result,errorCode:null}]};
 return {scope,candidate,authorization,credential,result,receipt};
}
test('scope and source resolve only the selected saved market image',()=>{
 const f=fixture();assert.deepEqual(c.assertASupplierImageSearchScope(f.scope),f.scope);
 assert.equal(c.assertASupplierImageSearchSource({...f,document:{}}).imageUrl,'https://cdn.example.com/image.jpg');
 for(const mutate of [s=>s.request.url='https://example.com/x',s=>s.request.maxSearches=2,s=>s.request.maxResults=5,s=>s.targetPlatform='wb',s=>s.imageSource.imageIndex=1]){const v=structuredClone(f.scope);mutate(v);assert.throws(()=>c.assertASupplierImageSearchScope(v));}
});
test('saved source corruption unknown identity and internal images reject',()=>{
 for(const url of ['https://localhost/x','https://127.0.0.1/x','https://x.internal/x','https://example.com:123/x','https://example.com/x?token=secret']){const f=fixture();f.candidate.salesSnapshotsV11[0].imageRefs=[url];assert.throws(()=>c.assertASupplierImageSearchSource({...f,document:{}}),/SOURCE_INVALID/);}
 const f=fixture();f.candidate.salesSnapshotsV11[0].collectorMode='mock_only';assert.throws(()=>c.assertASupplierImageSearchSource({...f,document:{}}),/SOURCE_INVALID/);
 f.candidate.dataRevision=3;assert.throws(()=>c.assertASupplierImageSearchCandidateSource(f.candidate,f.scope),/CANDIDATE_CHANGED/);
});
test('single-use authorization and local-session binding reject mismatch and secrets',()=>{
 const f=fixture();c.assertASupplierImageSearchAuthorization(f.authorization);c.assertASupplierImageSearchCredential(f.credential);
 const altered=structuredClone(f.credential);altered.provider='linkfox';assert.throws(()=>c.assertASupplierImageSearchCredential(altered));
 altered.provider='1688_browser';altered.bindingId='binding:wrong';assert.throws(()=>c.assertASupplierImageSearchCredential(altered));
 f.authorization.useCount=1;assert.throws(()=>c.assertASupplierImageSearchAuthorization(f.authorization));
});
test('results preserve unknown SKU MOQ and require explicit submission/completion even for empty',()=>{
 const f=fixture();c.assertASupplierImageSearchResult(f.result,f.scope);
 for(const mutate of [r=>r.products[0].sameSku='exact_match',r=>r.products[0].minimumOrderQuantity=1,r=>r.products[0].sourceUrl='https://detail.1688.com/offer/999.html',r=>r.products.push({...r.products[0]}),r=>r.completionEvidenceRef=null]){const v=structuredClone(f.result);mutate(v);assert.throws(()=>c.assertASupplierImageSearchResult(v,f.scope));}
 const empty={...f.result,status:'true_empty',products:[]};c.assertASupplierImageSearchResult(empty,f.scope);
 assert.throws(()=>c.assertASupplierImageSearchResult({...empty,submissionEvidenceRef:null},f.scope));
});
test('terminal success is strict and failed-before-send remains zero-action',()=>{
 const f=fixture();assert.equal(c.readASupplierImageSearchTerminal(f.receipt).externalRequestState,'succeeded');
 const bad=structuredClone(f.receipt);bad.steps[0].result=null;assert.throws(()=>c.assertASupplierImageSearchReceipt(bad));
 const failed={...f.receipt,status:'failed',failureClass:'PAGE_CONTRACT_UNCONFIGURED',steps:[]};
 assert.equal(c.readASupplierImageSearchTerminal(failed).externalRequestState,'not_sent');
});
test('interruption after send stays unknown and late results cannot promote success',()=>{
 const f=fixture(),r=f.receipt;r.status='in_flight';r.completedAt=null;r.steps[0]={...r.steps[0],completedAt:null,externalRequestState:'in_flight',requestTransmission:'attempted',result:null};
 const stopped=c.interruptASupplierImageSearchReceipt(r,null,later,'TIMEOUT');assert.equal(stopped.status,'unknown_outcome');
 stopped.lateResult={recordedAt:later,result:f.result};assert.equal(c.readASupplierImageSearchTerminal(stopped).status,'unknown_outcome');
 stopped.status='completed';assert.throws(()=>c.assertASupplierImageSearchReceipt(stopped));
});
test('admission rejects expired permit frozen candidate and prior attempted search',()=>{
 const f=fixture();assert.equal(c.assertASupplierImageSearchAdmission({...f,document:{},receipts:[],checkedAt:at}),true);
 assert.throws(()=>c.assertASupplierImageSearchAdmission({...f,document:{},receipts:[],checkedAt:expires}),/AUTHORIZATION_EXPIRED/);
 assert.throws(()=>c.assertASupplierImageSearchAdmission({...f,document:{},receipts:[f.receipt],checkedAt:at}),/SEQUENCE_INVALID/);
 f.candidate.lifecycleV11={skuPackage:{}};assert.throws(()=>c.assertASupplierImageSearchCandidateEligible(f.candidate));
});
