import { currentOtherCosts } from "./fixtures/real-a-b-flow-fixture.mjs";
import test from 'node:test';import assert from 'node:assert/strict';
import {readAProductDetailSupplierEvidence,buildAProductDetailCandidateEvidence} from '../lib/a-product-detail-evidence.mjs';
import {createAProductDetailCandidateFixture} from './fixtures/a-product-detail-evidence-fixture.mjs';
import {buildRealAConfirmationCard,validateRealAConfirmationSubmission} from '../lib/real-a-confirmation-card.mjs';
import {runRealAConfirmationToBAndC1} from '../lib/real-a-b-c1-flow.mjs';
import {evidencePacks} from './fixtures/real-a-b-flow-fixture.mjs';
test('saved API receipts become original A objects and a derived card without a browser capture or automatic SKU choice',async()=>{
 const {candidate,card,input}=await createAProductDetailCandidateFixture();const before=structuredClone(candidate);
 assert.equal(Object.hasOwn(candidate,'sourceCapture'),false);assert.equal(card.supplierCapture.sourceMode,'provider_api_read_only');assert.deepEqual(card.supplierCapture.selectedSkuIds,[]);
 assert.equal(card.supplierCapture.ownerSupplyConfirmed,false);assert.equal(card.supplierConfirmation.supplierSkuId.value,null);
 assert.equal(validateRealAConfirmationSubmission(card,input).valid,true);assert.equal(readAProductDetailSupplierEvidence(candidate).sourceUrl,candidate.sourceUrl);assert.deepEqual(candidate,before);
});
test('new API path rejects wrong receipt, SKU, spec, price, match, MOQ and known brand',async()=>{
 const {card,input}=await createAProductDetailCandidateFixture();
 for(const [field,value]of Object.entries({captureId:'receipt:wrong',supplierSkuId:'7654321',variantKey:'wrong',unitProductPrice:3,matchType:'near_match',minimumOrderQuantity:2})){
  const changed=structuredClone(input);changed.supplierConfirmation[field]=value;assert.equal(validateRealAConfirmationSubmission(card,changed).valid,false,field);
 }
 for(const moq of [2,null]){const f=await createAProductDetailCandidateFixture({moq});
  assert.equal(validateRealAConfirmationSubmission(f.card,f.input).valid,false);}
 const missingSpec=await createAProductDetailCandidateFixture({specId:null});assert.equal(validateRealAConfirmationSubmission(missingSpec.card,missingSpec.input).valid,false);
 const branded=await createAProductDetailCandidateFixture({brandName:'Synthetic Brand'});assert.equal(validateRealAConfirmationSubmission(branded.card,branded.input).valid,false);
});
test('missing direct retail price and market price never become inferred full-cost evidence',async()=>{
 const missing=await createAProductDetailCandidateFixture({retailPrice:null});
 assert.equal(validateRealAConfirmationSubmission(missing.card,missing.input).valid,false);
 const f=await createAProductDetailCandidateFixture();f.marketReceipt.steps[0].result.facts.currentPrice='unknown';
 const result=buildAProductDetailCandidateEvidence({candidateId:f.candidate.id,sourceRevision:f.candidate.dataRevision-1,resultRevision:f.candidate.dataRevision,marketReceipt:f.marketReceipt,supplierReceipt:f.supplierReceipt});
 assert.equal(result.salesSnapshot,null);assert.equal(result.supplierOption,null);
});
test('existing category evidence can be appended but provider price and SKU evidence cannot be changed',async()=>{
 const f=await createAProductDetailCandidateFixture(),snapshot=f.candidate.salesSnapshotsV11[0];
 snapshot.platformCategoryEvidence={status:'verified',descriptionCategoryId:100,typeId:200,categoryToken:'category:synthetic',sourceSnapshotId:snapshot.snapshotId,
  sourceEvidenceRefs:['commission:synthetic','schema:synthetic'],verifiedAt:'2026-09-08T12:00:00.000Z'};
 const card=buildRealAConfirmationCard(f.candidate);assert.equal(validateRealAConfirmationSubmission(card,f.input).valid,true);
 assert.equal(readAProductDetailSupplierEvidence(f.candidate).salesSnapshot.platformCategoryEvidence.typeId,200);
 snapshot.currentPrice++;assert.throws(()=>readAProductDetailSupplierEvidence(f.candidate),/CANDIDATE_EVIDENCE_CHANGED/);
});
test('formal A freeze retains the selected API SKU image and receipt while adding owner cost and packing',async()=>{
 const f=await createAProductDetailCandidateFixture();
 const packs=evidencePacks().map(value=>({...value,checkedAt:'2026-09-08T12:00:00.000Z',expiresAt:'2026-09-09T12:00:00.000Z'}));
 const result=runRealAConfirmationToBAndC1({candidate:f.candidate,otherCosts:currentOtherCosts(f.candidate),submission:f.input,evidencePacks:packs,confirmedAt:'2026-09-08T12:00:00.000Z'});
 const option=result.opportunityPackage.supplierOptions[0],sku=option.supplierSkus[0];
 assert.deepEqual(sku.imageRefs,['https://cdn.example.com/supplier.jpg']);assert.equal(option.evidenceRef,f.supplierReceipt.receiptId);
 assert.equal(sku.unitProductPrice,5.9);assert.equal(sku.unitDomesticFreight,2);assert.equal(sku.weight.value,0.4);assert.equal(sku.material,'unknown');assert.equal(sku.variantKey,'7654321');
});
test('existing Terra draft appends without replacing provider observations or turning draft into fact',async()=>{
 const {attachTerraAuxiliaryDraft}=await import('../lib/sales-snapshot.mjs');const f=await createAProductDetailCandidateFixture(),snapshot=f.candidate.salesSnapshotsV11[0];
 f.candidate.salesSnapshotsV11[0]=attachTerraAuxiliaryDraft(snapshot,{draftId:'draft:synthetic',provider:'terra',modelVersion:'synthetic-version',generatedAt:'2026-09-08T12:00:00.000Z',
  status:'draft',authoritative:false,mayOverrideObservedFields:false,publicTextEvidenceRefs:[snapshot.evidenceRef],authorizedImageRefs:[],output:{summary:'Synthetic auxiliary summary'}});
 const card=buildRealAConfirmationCard(f.candidate);assert.equal(card.salesReview.terraAssist.authoritative,false);assert.equal(card.salesReview.currentPrice,snapshot.currentPrice);
 assert.equal(validateRealAConfirmationSubmission(card,f.input).valid,true);
});
