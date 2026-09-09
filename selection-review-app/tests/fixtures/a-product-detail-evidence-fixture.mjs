import {createAProductDetailContractFixture,createAProductDetailContractReceipt} from './a-product-detail-contract-fixture.mjs';
import {buildLinkfoxProductDetailRequest,normalizeLinkfoxProductDetailResponse} from '../../lib/linkfox-product-detail-api.mjs';
import {buildAProductDetailCandidateEvidence} from '../../lib/a-product-detail-evidence.mjs';
import {candidate as legacyCandidate,addEvidenceContext,submission} from './real-a-b-flow-fixture.mjs';
import {buildRealAConfirmationCard} from '../../lib/real-a-confirmation-card.mjs';
export async function createAProductDetailCandidateFixture({moq=1,brandName,retailPrice='5.90',specId='7654321'}={}){
 const base=addEvidenceContext(await legacyCandidate()),f=createAProductDetailContractFixture();
 f.scope.candidateId=base.id;f.scope.sourceRevision=base.dataRevision;f.scope.resultRevision=base.dataRevision;f.scope.targetStore=base.targetStore;
 f.job.subject={kind:'a_candidate',candidateId:base.id,revision:base.dataRevision};f.job.revision=base.dataRevision;f.job.scopeBinding=f.scope;
 const marketReceipt=createAProductDetailContractReceipt(f);
 if(brandName!==undefined)marketReceipt.steps[0].result.facts.brandName=brandName;
 const second=structuredClone(f);second.scope.requestIndex=1;second.scope.request=second.scope.detailPlan.requests[1];second.scope.authorizationRef='permit:detail:1';second.job.jobId='job:detail:1';second.job.scopeBinding=second.scope;
 const supplierReceipt=createAProductDetailContractReceipt(second);
 const raw={errcode:200,offerId:second.scope.request.productId,subject:'合成桌面收纳',skuList:[{skuId:'1234567',specId,retailPrice,skuImageUrl:'https://cdn.example.com/supplier.jpg'}]};
 if(moq!==undefined)raw.minOrderQuantity=moq;
 supplierReceipt.steps[0].result=normalizeLinkfoxProductDetailResponse({request:buildLinkfoxProductDetailRequest(second.scope.request),httpStatus:200,response:raw,observedAt:marketReceipt.completedAt});
 const result=buildAProductDetailCandidateEvidence({candidateId:base.id,sourceRevision:base.dataRevision,resultRevision:base.dataRevision+1,marketReceipt,supplierReceipt});
 const candidate={...base,dataRevision:base.dataRevision+1,salesSnapshotsV11:[result.salesSnapshot],supplierOptionsV11:[result.supplierOption],aProductDetailEvidenceV1:result.evidence,sourceUrl:result.supplierOption.productUrl};
 delete candidate.sourceCapture;
 const card=buildRealAConfirmationCard(candidate),input=submission(card),sku=card.supplierCapture.skuChoices[0];
 Object.assign(input.supplierConfirmation,{captureId:card.supplierCapture.captureId,supplierSkuId:sku.sourceSkuId,variantKey:sku.variantKey,unitProductPrice:sku.priceCny,
  minimumOrderQuantity:sku.minimumOrderQuantity,matchType:'exact_match',actualPurchaseCost:sku.priceCny===null?null:sku.priceCny+2});
 return {candidate,card,input,marketReceipt,supplierReceipt,result};
}
