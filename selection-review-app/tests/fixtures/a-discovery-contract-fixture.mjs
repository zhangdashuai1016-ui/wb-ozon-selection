import { LINKFOX_DISCOVERY_CONTRACT_VERSION, buildLinkfoxDiscoveryRequest, normalizeLinkfoxDiscoveryResponse } from '../../lib/linkfox-discovery-api.mjs';
export const discoveryAt='2026-09-08T12:00:00.000Z';
export function createADiscoveryContractFixture(){
  const requests=[{requestId:'discovery:market',method:'ozon_market_search',keywords:['органайзер'],pageSize:20},
    {requestId:'discovery:supplier1',method:'supplier_search',keywords:['桌面收纳'],pageSize:10},
    {requestId:'discovery:supplier2',method:'supplier_search',keywords:['桌面整理'],pageSize:10}];
  const batch={schemaVersion:'a-discovery-batch-v1',batchId:'batch:synthetic',revision:0,ownerUserId:'owner:synthetic',createdAt:discoveryAt,
    targetStore:'miska',bindingId:'route:synthetic',configurationVersion:'version:1',credentialAlias:'linkfox-synthetic',budgetPolicyRef:'budget:synthetic',
    plan:{schemaVersion:'a-discovery-plan-v1',planId:'plan:synthetic',version:'version:1',provider:'linkfox',contractVersion:LINKFOX_DISCOVERY_CONTRACT_VERSION,
      selection:{schemaVersion:'a-discovery-selection-v1',marketOrder:'provider_order',supplierOrder:'provider_order',maxCandidates:1},direction:'普通非电桌面整理小件（偏好）',requests,budget:{unit:'linkfox_credits',maxRequests:3,maxCredits:30},exclusions:['明确品牌/IP风险','带电商品']}};
  const scope={schemaVersion:'a-discovery-scope-v1',batchId:batch.batchId,sourceRevision:0,resultRevision:0,planId:batch.plan.planId,planVersion:batch.plan.version,
    requestIndex:0,request:requests[0],bindingId:batch.bindingId,configurationVersion:batch.configurationVersion,credentialAlias:batch.credentialAlias,
    budgetPolicyRef:batch.budgetPolicyRef,authorizationRef:'permit:synthetic:0',expiresAt:'2026-09-08T13:00:00.000Z',targetStore:batch.targetStore};
  const authorization={schemaVersion:'software-job-authorization-record-v3',authorizationId:scope.authorizationRef,authorizationType:'a_discovery_once',status:'active',
    action:'a_product_discovery',scopeBinding:scope,authorizedByUserId:batch.ownerUserId,authorizedAt:discoveryAt,expiresAt:scope.expiresAt,maxUses:1,useCount:0,consumedByJobId:null,consumedAt:null};
  const credential={schemaVersion:'software-job-credential-binding-v3',bindingId:'binding:one-use:0',credentialAlias:scope.credentialAlias,status:'active',provider:'linkfox',
    sideEffectScope:'a_product_discovery',scopeBinding:scope,allowedWorkerIds:['worker:synthetic'],redaction:'credential_alias_only',boundAt:discoveryAt,expiresAt:scope.expiresAt};
  const job={schemaVersion:'software-job-v3',jobType:'a_product_discovery',jobId:'job:synthetic:0',subject:{kind:'discovery_batch',batchId:batch.batchId,revision:0},revision:0,
    scopeBinding:scope,workerId:'worker:synthetic',leaseId:'lease:synthetic',leaseExpiresAt:'2026-09-08T12:10:00.000Z'};
  return structuredClone({batch,scope,authorization,credential,job});
}
export function createADiscoveryContractReceipt({scope,job},{empty=false}={}){
  const supplier=scope.request.method==='supplier_search';
  const products=empty?[]:supplier?[{offerId:'876240928352',asinUrl:'https://detail.1688.com/offer/876240928352.html',title:'合成收纳',currency:'CNY',price:5}]:
    [{sku:2107989735,productUrl:'https://www.ozon.ru/product/2107989735',title:'Synthetic organizer',price:297,currency:'₽'}];
  const result=normalizeLinkfoxDiscoveryResponse({request:buildLinkfoxDiscoveryRequest(scope.request),httpStatus:200,response:{code:'200',errcode:200,total:products.length,products},observedAt:discoveryAt});
  return {schemaVersion:'a-discovery-receipt-v1',receiptId:`a-discovery-receipt:${job.jobId}`,jobId:job.jobId,scope,workerId:job.workerId,leaseId:job.leaseId,
    startedAt:discoveryAt,completedAt:discoveryAt,status:'completed',failureClass:null,steps:[{method:scope.request.method,intentAt:discoveryAt,sentAt:discoveryAt,
      completedAt:discoveryAt,externalRequestState:'succeeded',requestTransmission:'response_received',result,errorCode:null}]};
}
