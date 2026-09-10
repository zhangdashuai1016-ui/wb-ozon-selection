import {createADiscoveryContractFixture,createADiscoveryContractReceipt,discoveryAt} from './a-discovery-contract-fixture.mjs';
import {LINKFOX_DETAIL_CONTRACT_VERSION,buildLinkfoxProductDetailRequest,normalizeLinkfoxProductDetailResponse} from '../../lib/linkfox-product-detail-api.mjs';
export function createAProductDetailContractFixture(){
 const source=createADiscoveryContractFixture(),market=createADiscoveryContractReceipt(source);
 source.job.status='completed';source.job.externalRequestState='succeeded';source.job.ownerUserId=source.batch.ownerUserId;
 const supplier=structuredClone(source);supplier.scope.requestIndex=1;supplier.scope.request=supplier.batch.plan.requests[1];supplier.scope.authorizationRef='permit:synthetic:1';
 supplier.job.scopeBinding=supplier.scope;supplier.job.jobId='job:synthetic:1';const supplierReceipt=createADiscoveryContractReceipt(supplier);
 const candidate={id:'candidate:synthetic',dataRevision:0,workflowStatus:'needs_user_data',eliminatedAt:null,targetPlatform:'ozon',targetStore:'miska',aDiscoveryEvidenceV1:{schemaVersion:'a-discovery-candidate-evidence-v1',batchId:source.batch.batchId,
  sourceRevision:0,resultRevision:0,planId:source.batch.plan.planId,planVersion:source.batch.plan.version,marketProductId:'2107989735',marketReceiptRef:market.receiptId,
  supplierReceiptRefs:[supplierReceipt.receiptId],exactSkuMatch:'unknown',businessEffect:'discovery_evidence_only'}};
 const requests=[{requestId:'detail:market',method:'ozon_detail',productId:'2107989735'},{requestId:'detail:supplier',method:'supplier_detail',productId:'876240928352'}];
 const scope={schemaVersion:'a-product-detail-scope-v1',candidateId:candidate.id,sourceRevision:0,resultRevision:0,targetStore:'miska',discoverySource:{batchId:source.batch.batchId,batchRevision:0,
  planId:source.batch.plan.planId,planVersion:source.batch.plan.version,marketProductId:'2107989735',marketReceiptRef:market.receiptId,marketJobId:source.job.jobId,
  supplierOfferId:'876240928352',supplierReceiptRef:supplierReceipt.receiptId,supplierJobId:supplier.job.jobId},detailPlan:{schemaVersion:'a-product-detail-plan-v1',planId:'detail:plan',version:'version:1',
  contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,requests,budget:{unit:'linkfox_credits',maxRequests:2,maxCredits:13}},requestIndex:0,request:requests[0],bindingId:'detail:binding',configurationVersion:'version:1',
  credentialAlias:'linkfox-synthetic',budgetPolicyRef:'detail:budget',authorizationRef:'permit:detail:0',expiresAt:'2026-09-08T13:00:00.000Z'};
 const authorization={...source.authorization,authorizationId:scope.authorizationRef,authorizationType:'a_product_detail_once',action:'a_product_detail_read',scopeBinding:scope};
 const credential={...source.credential,sideEffectScope:'a_product_detail_read',scopeBinding:scope};
 const job={...source.job,jobId:'job:detail:0',jobType:'a_product_detail_read',subject:{kind:'a_candidate',candidateId:candidate.id,revision:0},scopeBinding:scope};
 const document={candidates:[candidate],runtime:{softwareJobs:[source.job,supplier.job],aDiscoveryBatches:{[source.batch.batchId]:source.batch},aDiscoveryReceipts:{[source.job.jobId]:market,[supplier.job.jobId]:supplierReceipt}}};
 return structuredClone({candidate,scope,authorization,credential,job,document});
}
export function createAProductDetailContractReceipt({scope,job},{empty=false}={}){
 const request=buildLinkfoxProductDetailRequest(scope.request),supplier=scope.request.method==='supplier_detail';
 const response=supplier?{errcode:200,offerId:scope.request.productId,subject:'合成收纳',skuList:[{skuId:'1234567',retailPrice:'5.90'}]}:
  {code:'200',errcode:200,total:empty?0:1,products:empty?[]:[{sku:Number(scope.request.productId),title:'Synthetic item',price:297,currency:'₽',productUrl:`https://www.ozon.ru/product/${scope.request.productId}/`}]};
 const result=normalizeLinkfoxProductDetailResponse({request,httpStatus:200,response,observedAt:discoveryAt});
 return {schemaVersion:'a-product-detail-receipt-v1',receiptId:`a-product-detail-receipt:${job.jobId}`,jobId:job.jobId,scope,workerId:job.workerId,leaseId:job.leaseId,startedAt:discoveryAt,
  completedAt:discoveryAt,status:'completed',failureClass:null,steps:[{method:scope.request.method,intentAt:discoveryAt,sentAt:discoveryAt,completedAt:discoveryAt,externalRequestState:'succeeded',requestTransmission:'response_received',result,errorCode:null}]};
}
