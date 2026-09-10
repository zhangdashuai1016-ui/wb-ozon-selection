import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { LinkfoxDiscoveryError } from './linkfox-discovery-api.mjs';
import { assertValidSalesSnapshot, SALES_SNAPSHOT_SCHEMA_VERSION } from './sales-snapshot.mjs';
import { adapt1688CaptureToSupplierOption } from './supplier-option.mjs';
export const LINKFOX_DETAIL_CONTRACT_VERSION='linkfox-detail-93a1dbf-v1';
export const LINKFOX_DETAIL_COSTS=Object.freeze({unit:'linkfox_credits',ozon_detail:12,supplier_detail:1,actualCharge:'unknown'});
const methods={ozon_detail:'/seerfar/ozon/productDetailSearch',supplier_detail:'/alibaba1688/productDetail'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const check=(v,code='RESPONSE_INVALID')=>{if(!v)throw new LinkfoxDiscoveryError(code);};
const closed=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=1000&&!/[\u0000-\u001f\u007f]/u.test(v);
const id=v=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v);
const numericId=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const at=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function optional(v,predicate){if(v===undefined||v===null)return 'unknown';check(predicate(v));return v;}
function imageUrl(v){check(text(v));let url;try{url=new URL(v);}catch(error){if(error instanceof TypeError)throw new LinkfoxDiscoveryError('RESPONSE_INVALID');throw error;}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&!/^(localhost|[0-9.]+)$/i.test(url.hostname)&&!url.hostname.endsWith('.local'));return url.href;}
function images(v){if(v===undefined||v===null)return 'unknown';check(Array.isArray(v)&&v.length<=40);return v.map(imageUrl);}
export function buildLinkfoxProductDetailRequest(input){
  check(closed(input,['requestId','method','productId'])&&isCanonicalFrozenRef(input.requestId)&&Object.hasOwn(methods,input.method)&&id(input.productId),'INPUT_INVALID');
  if(input.method==='ozon_detail')check(BigInt(input.productId)<=BigInt(Number.MAX_SAFE_INTEGER),'INPUT_INVALID');
  assertSafeRuntimeRecord(input);
  return {schemaVersion:'linkfox-detail-request-v1',contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,provider:'linkfox',...structuredClone(input),endpoint:methods[input.method],
    body:input.method==='ozon_detail'?{sku:input.productId}:{offerId:input.productId}};
}
function validateRequest(request){const expected=buildLinkfoxProductDetailRequest({requestId:request.requestId,method:request.method,productId:request.productId});check(isDeepStrictEqual(expected,request),'INPUT_INVALID');return expected;}
function singlePrice(v){return optional(v,value=>typeof value==='number'&&Number.isFinite(value)&&value>0);}
function retailPrice(v){if(v===undefined||v===null)return 'unknown';check(typeof v==='string'&&/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(v));const cents=Number(v)*100;check(Number.isSafeInteger(Math.round(cents))&&Number(v)>0);return Number(v);}
function ozonFacts(response,request){
  check(response.code==='200'&&Number.isSafeInteger(response.total)&&[0,1].includes(response.total));
  const rows=Object.hasOwn(response,'products')?response.products:response.data;
  check(Array.isArray(rows)&&rows.length===response.total);
  if(Object.hasOwn(response,'products')&&Object.hasOwn(response,'data'))check(isDeepStrictEqual(response.products,response.data));
  if(!rows.length)return null;
  const row=rows[0];check(object(row)&&numericId(row.sku)&&String(row.sku)===request.productId,'IDENTITY_INVALID');
  if(Object.hasOwn(row,'productId'))check(row.productId===row.sku,'IDENTITY_INVALID');
  check(text(row.title));const expected=`https://www.ozon.ru/product/${request.productId}/`;
  check(typeof row.productUrl==='string','IDENTITY_INVALID');let url;
  try{url=new URL(row.productUrl);}catch(error){if(error instanceof TypeError)throw new LinkfoxDiscoveryError('IDENTITY_INVALID');throw error;}
  check(url.protocol==='https:'&&['ozon.ru','www.ozon.ru'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&
    /^\/product\//.test(url.pathname)&&url.pathname.match(/(?:\/|-)([0-9]+)\/?$/)?.[1]===request.productId,'IDENTITY_INVALID');
  if(Object.hasOwn(row,'currency'))check(row.currency==='₽');
  if(row.categoryInfo!==undefined&&row.categoryInfo!==null)check(object(row.categoryInfo));
  return {productId:request.productId,productUrl:expected,title:row.title,currentPrice:singlePrice(row.price),currency:row.currency===undefined?'unknown':'RUB',
    imageRefs:images(row.imageUrls),categoryPath:optional(row.categoryInfo?.titlePath,text),brandName:optional(row.brandName,text),
    sellerName:optional(row.sellerName,text),sellerType:'unknown',attributes:'unknown'};
}
function supplierFacts(response,request){
  check(response.offerId===request.productId,'IDENTITY_INVALID');check(text(response.subject));
  check(Array.isArray(response.skuList)&&response.skuList.length>0&&response.skuList.length<=200);
  const skus=response.skuList.map((row,index)=>{
    check(object(row)&&id(row.skuId),'IDENTITY_INVALID');
    const specId=optional(row.specId,v=>id(v));const retailPriceCny=retailPrice(row.retailPrice);
    return {supplierSkuId:row.skuId,specId,retailPriceCny,stock:optional(row.amountOnSale,v=>Number.isSafeInteger(v)&&v>=0),
      imageRef:row.skuImageUrl===undefined||row.skuImageUrl===null?'unknown':imageUrl(row.skuImageUrl),attributes:'unknown',
      priceSource:retailPriceCny==='unknown'?'unknown':`skuList[${index}].retailPrice`};
  });
  check(new Set(skus.map(v=>v.supplierSkuId)).size===skus.length,'IDENTITY_INVALID');
  return {offerId:request.productId,productUrl:`https://detail.1688.com/offer/${request.productId}.html`,title:response.subject,
    minOrderQuantity:optional(response.minOrderQuantity,v=>Number.isSafeInteger(v)&&v>0),skus,
    unitDomesticFreight:'unknown',weight:'unknown',dimensions:'unknown',actualPurchaseCost:'unknown'};
}
export function normalizeLinkfoxProductDetailResponse({request,httpStatus,response,observedAt}){
  request=validateRequest(request);check(at(observedAt));
  if(httpStatus===401)throw new LinkfoxDiscoveryError('AUTHENTICATION_REQUIRED');
  if(httpStatus===402)throw new LinkfoxDiscoveryError('BILLING_FAILED');
  if(httpStatus===429)throw new LinkfoxDiscoveryError('RATE_LIMITED');
  if(httpStatus!==200)throw new LinkfoxDiscoveryError('PROVIDER_FAILED');
  check(object(response)&&Number.isSafeInteger(response.errcode));
  if(response.errcode!==200)throw new LinkfoxDiscoveryError(response.errcode===401?'AUTHENTICATION_REQUIRED':response.errcode===402?'BILLING_FAILED':
    response.errcode===1003&&request.method==='ozon_detail'?'RATE_LIMITED':'PROVIDER_FAILED');
  const facts=request.method==='ozon_detail'?ozonFacts(response,request):supplierFacts(response,request);
  const result={schemaVersion:'linkfox-detail-result-v1',provider:'linkfox',contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,requestId:request.requestId,
    method:request.method,productId:request.productId,observedAt,status:facts===null?'true_empty':'observed',facts,
    accounting:{unit:'linkfox_credits',actualCharge:'unknown'},businessEffect:'detail_evidence_only'};
  return assertLinkfoxProductDetailResult(result);
}
export function assertLinkfoxProductDetailResult(result){
  check(closed(result,['schemaVersion','provider','contractVersion','requestId','method','productId','observedAt','status','facts','accounting','businessEffect'])&&
    result.schemaVersion==='linkfox-detail-result-v1'&&result.provider==='linkfox'&&result.contractVersion===LINKFOX_DETAIL_CONTRACT_VERSION&&
    isCanonicalFrozenRef(result.requestId)&&Object.hasOwn(methods,result.method)&&id(result.productId)&&at(result.observedAt)&&
    ['observed','true_empty'].includes(result.status)&&result.businessEffect==='detail_evidence_only'&&
    closed(result.accounting,['unit','actualCharge'])&&result.accounting.unit==='linkfox_credits'&&result.accounting.actualCharge==='unknown','INPUT_INVALID');
  if(result.status==='true_empty')check(result.method==='ozon_detail'&&result.facts===null,'INPUT_INVALID');
  else if(result.method==='ozon_detail'){
    const f=result.facts;check(closed(f,['productId','productUrl','title','currentPrice','currency','imageRefs','categoryPath','brandName','sellerName','sellerType','attributes'])&&
      f.productId===result.productId&&f.productUrl===`https://www.ozon.ru/product/${result.productId}/`&&text(f.title)&&
      BigInt(result.productId)<=BigInt(Number.MAX_SAFE_INTEGER)&&['RUB','unknown'].includes(f.currency)&&
      (f.currentPrice==='unknown'||typeof f.currentPrice==='number'&&Number.isFinite(f.currentPrice)&&f.currentPrice>0)&&
      f.sellerType==='unknown'&&f.attributes==='unknown'&&['categoryPath','brandName','sellerName'].every(k=>f[k]==='unknown'||text(f[k])),'INPUT_INVALID');
    if(f.imageRefs!=='unknown')images(f.imageRefs);
  }else{
    const f=result.facts;check(closed(f,['offerId','productUrl','title','minOrderQuantity','skus','unitDomesticFreight','weight','dimensions','actualPurchaseCost'])&&
      f.offerId===result.productId&&f.productUrl===`https://detail.1688.com/offer/${result.productId}.html`&&text(f.title)&&
      (f.minOrderQuantity==='unknown'||Number.isSafeInteger(f.minOrderQuantity)&&f.minOrderQuantity>0)&&
      ['unitDomesticFreight','weight','dimensions','actualPurchaseCost'].every(k=>f[k]==='unknown')&&Array.isArray(f.skus)&&f.skus.length>0&&f.skus.length<=200,'INPUT_INVALID');
    for(const [index,row]of f.skus.entries()){
      check(closed(row,['supplierSkuId','specId','retailPriceCny','stock','imageRef','attributes','priceSource'])&&id(row.supplierSkuId)&&
        (row.specId==='unknown'||id(row.specId))&&(row.retailPriceCny==='unknown'||typeof row.retailPriceCny==='number'&&Number.isFinite(row.retailPriceCny)&&row.retailPriceCny>0)&&
        (row.stock==='unknown'||Number.isSafeInteger(row.stock)&&row.stock>=0)&&row.attributes==='unknown'&&
        row.priceSource===(row.retailPriceCny==='unknown'?'unknown':`skuList[${index}].retailPrice`),'INPUT_INVALID');
      if(row.imageRef!=='unknown')imageUrl(row.imageRef);
    }
    check(new Set(f.skus.map(v=>v.supplierSkuId)).size===f.skus.length,'IDENTITY_INVALID');
  }
  assertSafeRuntimeRecord(result);return structuredClone(result);
}
function usable(result,method,evidenceRef){assertLinkfoxProductDetailResult(result);check(result.method===method&&result.status==='observed'&&isCanonicalFrozenRef(evidenceRef),'INPUT_INVALID');}
export function adaptLinkfoxDetailToSupplierOption(result,{evidenceRef}){
  usable(result,'supplier_detail',evidenceRef);const facts=result.facts;
  const option=adapt1688CaptureToSupplierOption({offerId:facts.offerId,sourceUrl:facts.productUrl,observedAt:result.observedAt,skus:facts.skus.map(row=>({
    sourceSkuId:row.supplierSkuId,propPath:row.specId==='unknown'?null:row.specId,attributes:{},priceCny:row.retailPriceCny==='unknown'?null:row.retailPriceCny,
    imageUrl:row.imageRef==='unknown'?null:row.imageRef}))},{evidenceRef});
  return {supplierOption:option,fieldSources:facts.skus.map(row=>({supplierSkuId:row.supplierSkuId,unitProductPrice:row.priceSource})),
    gaps:['sku_attributes_unknown','domestic_freight_unknown','packing_unknown','actual_purchase_cost_unknown'],selectedSkuIds:[],ownerSupplyConfirmed:false};
}
export function adaptLinkfoxDetailToSalesSnapshot(result,{snapshotId,evidenceRef}){
  usable(result,'ozon_detail',evidenceRef);check(isCanonicalFrozenRef(snapshotId),'INPUT_INVALID');const facts=result.facts;
  check(facts.currentPrice!=='unknown'&&facts.currency==='RUB','RESPONSE_INVALID');
  const snapshot={schemaVersion:SALES_SNAPSHOT_SCHEMA_VERSION,snapshotId,platform:'ozon',marketScope:'ozon_general_market',sellerType:'unknown',
    sellerIdentityEvidence:{status:'unverified',signals:[],evidenceRef},productUrl:facts.productUrl,title:facts.title,imageRefs:facts.imageRefs==='unknown'?[]:facts.imageRefs,
    currentPrice:facts.currentPrice,currency:'RUB',categoryPath:facts.categoryPath,attributes:{},collectedAt:result.observedAt,evidenceRef,
    collectorVersion:LINKFOX_DETAIL_CONTRACT_VERSION,collectorMode:'provider_api_read_only',readOnly:true};
  assertValidSalesSnapshot(snapshot);
  return {salesSnapshot:snapshot,gaps:['product_attributes_unknown',...(facts.imageRefs==='unknown'?['images_unknown']:[])],
    complianceStatus:facts.brandName==='unknown'?'unknown':'brand_review_required'};
}
