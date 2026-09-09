import { validateSalesSnapshot } from './sales-snapshot.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { assertAProductDetailReceipt,assertAProductDetailScope,AProductDetailError } from './a-product-detail-contract.mjs';
import { assertLinkfoxProductDetailResult,adaptLinkfoxDetailToSalesSnapshot,adaptLinkfoxDetailToSupplierOption } from './linkfox-product-detail-api.mjs';
const check=(value,code)=>{if(!value)throw new AProductDetailError(code);};
const closed=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const clone=value=>{assertSafeRuntimeRecord(value);return structuredClone(value);};
function adapted(evidence){
 const market=adaptLinkfoxDetailToSalesSnapshot(evidence.marketResult,{snapshotId:evidence.salesSnapshotId,evidenceRef:evidence.marketReceiptRef});
 const supplier=adaptLinkfoxDetailToSupplierOption(evidence.supplierResult,{evidenceRef:evidence.supplierReceiptRef});
 return {salesSnapshot:market.salesSnapshot,supplierOption:supplier.supplierOption,complianceStatus:market.complianceStatus,gaps:[...market.gaps,...supplier.gaps]};
}
export function assertAProductDetailCandidateEvidence(evidence){
 check(closed(evidence,['schemaVersion','candidateId','sourceRevision','resultRevision','sourceScope','marketReceiptRef','supplierReceiptRef','marketResult','supplierResult','salesSnapshotId','supplierOptionId'])&&
  evidence.schemaVersion==='a-product-detail-candidate-evidence-v1'&&['candidateId','marketReceiptRef','supplierReceiptRef','salesSnapshotId','supplierOptionId'].every(k=>isCanonicalFrozenRef(evidence[k]))&&
  Number.isSafeInteger(evidence.sourceRevision)&&evidence.sourceRevision>=0&&evidence.resultRevision===evidence.sourceRevision+1,'CANDIDATE_EVIDENCE_INVALID');
 const scope=assertAProductDetailScope(evidence.sourceScope);
 check(scope.candidateId===evidence.candidateId&&scope.sourceRevision===evidence.sourceRevision&&scope.requestIndex===0&&
  evidence.salesSnapshotId===`sales:linkfox:${evidence.candidateId}:${evidence.resultRevision}`&&
  evidence.supplierOptionId===`supplier-option:1688:${scope.discoverySource.supplierOfferId}`&&evidence.marketReceiptRef!==evidence.supplierReceiptRef&&
  evidence.marketReceiptRef.startsWith('a-product-detail-receipt:')&&evidence.supplierReceiptRef.startsWith('a-product-detail-receipt:'),'CANDIDATE_EVIDENCE_INVALID');
 for(const [index,result]of [evidence.marketResult,evidence.supplierResult].entries()){
  assertLinkfoxProductDetailResult(result);const request=scope.detailPlan.requests[index];
  check(result.status==='observed'&&result.requestId===request.requestId&&result.method===request.method&&result.productId===request.productId,'CANDIDATE_EVIDENCE_INVALID');
 }
 return clone(evidence);
}
export function buildAProductDetailCandidateEvidence({candidateId,sourceRevision,resultRevision,marketReceipt,supplierReceipt}){
 assertAProductDetailReceipt(marketReceipt);assertAProductDetailReceipt(supplierReceipt);
 const scope=marketReceipt.scope,other=supplierReceipt.scope;
 check(marketReceipt.status==='completed'&&supplierReceipt.status==='completed'&&scope.requestIndex===0&&other.requestIndex===1&&
  scope.candidateId===candidateId&&other.candidateId===candidateId&&scope.sourceRevision===sourceRevision&&other.sourceRevision===sourceRevision&&
  ['targetStore','bindingId','configurationVersion','credentialAlias','budgetPolicyRef','expiresAt'].every(k=>scope[k]===other[k])&&
  isDeepStrictEqual(scope.detailPlan,other.detailPlan)&&isDeepStrictEqual(scope.discoverySource,other.discoverySource),'CANDIDATE_EVIDENCE_SOURCE_INVALID');
 const evidence=assertAProductDetailCandidateEvidence({schemaVersion:'a-product-detail-candidate-evidence-v1',candidateId,sourceRevision,resultRevision,sourceScope:scope,
  marketReceiptRef:marketReceipt.receiptId,supplierReceiptRef:supplierReceipt.receiptId,marketResult:marketReceipt.steps[0].result,supplierResult:supplierReceipt.steps[0].result,
  salesSnapshotId:`sales:linkfox:${candidateId}:${resultRevision}`,supplierOptionId:`supplier-option:1688:${scope.discoverySource.supplierOfferId}`});
 if(evidence.marketResult.facts.currentPrice==='unknown'||evidence.marketResult.facts.currency!=='RUB')return {evidence,salesSnapshot:null,supplierOption:null};
 const {salesSnapshot,supplierOption}=adapted(evidence);return {evidence,salesSnapshot,supplierOption};
}
/** A derived card view, never a fake browser capture or a second supply-selection authority. */
export function readAProductDetailSupplierEvidence(candidate){
 if(!Object.hasOwn(candidate,'aProductDetailEvidenceV1'))return null;
 const evidence=assertAProductDetailCandidateEvidence(candidate.aProductDetailEvidenceV1),values=adapted(evidence);
 check(candidate.id===evidence.candidateId&&Number.isSafeInteger(candidate.dataRevision)&&candidate.dataRevision>=evidence.resultRevision&&candidate.targetStore===evidence.sourceScope.targetStore,'CANDIDATE_EVIDENCE_SOURCE_INVALID');
 const market=(candidate.salesSnapshotsV11??[]).filter(value=>value.snapshotId===evidence.salesSnapshotId),suppliers=(candidate.supplierOptionsV11??[]).filter(value=>value.supplierOptionId===evidence.supplierOptionId);
 check(market.length===1&&suppliers.length===1&&validateSalesSnapshot(market[0]).valid,'CANDIDATE_EVIDENCE_CHANGED');
 const sourceFacts=structuredClone(market[0]);delete sourceFacts.auxiliaryDrafts;delete sourceFacts.platformCategoryEvidence;
 check(isDeepStrictEqual(sourceFacts,values.salesSnapshot)&&isDeepStrictEqual(suppliers[0],values.supplierOption),'CANDIDATE_EVIDENCE_CHANGED');
 values.salesSnapshot=structuredClone(market[0]);
 const facts=evidence.supplierResult.facts;
 const skuChoices=facts.skus.map((row,index)=>({sourceSkuId:row.supplierSkuId,variantKey:row.specId==='unknown'?null:row.specId,
  attributes:structuredClone(values.supplierOption.supplierSkus[index].attributes),priceCny:row.retailPriceCny==='unknown'?null:row.retailPriceCny,
  unitProductPrice:row.retailPriceCny==='unknown'?null:row.retailPriceCny,priceSource:row.priceSource,stock:row.stock==='unknown'?null:row.stock,
  imageUrl:row.imageRef==='unknown'?null:row.imageRef,minimumOrderQuantity:facts.minOrderQuantity}));
 const supplierCapture={mode:'provider_api_read_only',sourceMode:'provider_api_read_only',status:'captured_waiting_owner_selection',captureId:evidence.supplierReceiptRef,
  jobId:evidence.supplierReceiptRef.slice('a-product-detail-receipt:'.length),jobStatus:'completed',attempt:1,sourceUrl:facts.productUrl,originalSourceUrl:facts.productUrl,
  offerId:facts.offerId,observedAt:evidence.supplierResult.observedAt,pageFields:{unitProductPriceCny:null,unitProductPriceSource:null,unitDomesticFreightCny:null,unitDomesticFreightSource:null},
  skuChoices,selectedSkuIds:[],ownerSupplyConfirmed:false,minimumOrderQuantity:facts.minOrderQuantity,complianceStatus:values.complianceStatus};
 return clone({evidence,...values,supplierCapture,sourceUrl:facts.productUrl});
}
