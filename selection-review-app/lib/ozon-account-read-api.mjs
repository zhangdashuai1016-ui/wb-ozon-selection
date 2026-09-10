import { assertOzonAccountDiscoveryScope, OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION } from './ozon-account-read-contract.mjs';
import { isCompleteStoreRef } from './store-binding.mjs';
import { isCanonicalFrozenRef, assertNoProductionSecrets } from './production-contract-primitives.mjs';
import { isRuntimeConfigurationTimestamp } from './runtime-configuration.mjs';

export const OZON_ACCOUNT_READ_METHODS = Object.freeze(['roles','seller_info','warehouse_list']);
const endpoints = Object.freeze({roles:'/v1/roles',seller_info:'/v1/seller/info',warehouse_list:'/v2/warehouse/list'});
const currencies = new Set(['RUB','EUR','USD','CNY','BYN','KZT','KGS']);
export class OzonAccountReadApiError extends Error {
  constructor(code) { super(`OZON_ACCOUNT_READ_${code}`); this.name='OzonAccountReadApiError'; this.code=this.message; }
}
function requireValue(value,code='RESPONSE_INVALID') { if(!value) throw new OzonAccountReadApiError(code); }
const plain=value=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;
function field(value,key) {
  requireValue(plain(value));
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor===undefined) return {present:false,value:null};
  requireValue(Object.hasOwn(descriptor,'value'));
  return {present:true,value:descriptor.value};
}
function string(value,max=512) { requireValue(typeof value==='string' && value.length<=max && !/[\u0000-\u001f\u007f]/u.test(value)); return value; }
function list(value,max) {
  requireValue(Array.isArray(value));requireValue(value.length<=max,'RESPONSE_LIMIT_EXCEEDED');
  return Array.from({length:value.length},(_,index)=>{const descriptor=Object.getOwnPropertyDescriptor(value,String(index));requireValue(descriptor && Object.hasOwn(descriptor,'value'));return descriptor.value;});
}
function assertScope(scope) {
  if(scope?.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION){assertOzonAccountDiscoveryScope(scope);return;}
  requireValue(plain(scope) && isCompleteStoreRef(scope.storeRef,scope.storeRef?.stableStoreId) &&
    isCanonicalFrozenRef(scope.warehouseRef) && isCanonicalFrozenRef(scope.credentialAlias) && typeof scope.warehouseId==='string' && /^[1-9][0-9]{0,18}$/.test(scope.warehouseId) &&
    BigInt(scope.warehouseId)<=9223372036854775807n,'SCOPE_INVALID');
}
function endpoint(method) { requireValue(OZON_ACCOUNT_READ_METHODS.includes(method),'METHOD_INVALID');return endpoints[method]; }
/** Only documented request bodies: no requestBody is declared for roles or seller/info. */
export function buildOzonAccountReadRequest({method,scope,executionKey}) {
  const path=endpoint(method);assertScope(scope);requireValue(isCanonicalFrozenRef(executionKey),'EXECUTION_KEY_INVALID');
  if(scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION)return {schemaVersion:'ozon-account-discovery-request-v1',subject:structuredClone(scope.subject),
    accountRoute:Object.fromEntries(['bindingId','configurationVersion','targetStore','credentialAlias','clientIdRef'].map(field=>[field,scope[field]])),
    platform:'ozon',method:'POST',endpoint:path,body:method==='warehouse_list'?{limit:20}:null,write:false,executionKey};
  return {platform:'ozon',store:scope.storeRef.stableStoreId,storeRef:structuredClone(scope.storeRef),warehouseRef:scope.warehouseRef,credentialAlias:scope.credentialAlias,
    method:'POST',endpoint:path,body:method==='warehouse_list'?{limit:1,warehouse_ids:[scope.warehouseId]}:null,write:false,executionKey};
}
function gap(gaps,code,field) { gaps.push({code,field,message:'账户读取未取得当前所需的完整事实'}); }
function optionalText(source,key,gaps,required=true) {
  const entry=field(source,key);
  if(!entry.present){if(required)gap(gaps,`account_${key}_missing`,key);return null;}
  const value=string(entry.value);
  if(value.length===0 && required)gap(gaps,`account_${key}_missing`,key);
  return value;
}
function rolesFacts(response,observedAt,gaps) {
  const expires=optionalText(response,'expires_at',gaps);
  if(expires!==null && expires!==''){
    requireValue(isRuntimeConfigurationTimestamp(expires));
    if(Date.parse(expires)<=Date.parse(observedAt))gap(gaps,'account_roles_expired','expires_at');
  }
  const roles=field(response,'roles');
  if(!roles.present){gap(gaps,'account_roles_missing','roles');return {expiresAt:expires,roles:null};}
  let methodCount=0;
  const values=list(roles.value,1000).map(role=>{
    const name=optionalText(role,'name',gaps,false),methods=field(role,'methods');
    if(!methods.present){gap(gaps,'account_role_methods_missing','roles.methods');return {name,methods:null};}
    const paths=list(methods.value,10000).map(value=>string(value));
    methodCount+=paths.length;requireValue(methodCount<=10000,'RESPONSE_LIMIT_EXCEEDED');
    return {name,methods:paths};
  });
  if(values.length===0)gap(gaps,'account_roles_empty','roles');
  return {expiresAt:expires,roles:values};
}
function sellerFacts(response,gaps) {
  const company=field(response,'company');
  if(!company.present){gap(gaps,'account_company_missing','company');return {companyCurrency:null};}
  const currency=optionalText(company.value,'currency',gaps);
  if(currency!==null)requireValue(currencies.has(currency));
  return {companyCurrency:currency};
}
function warehouseFacts(response,scope,gaps) {
  const discovery=scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION;
  const next=field(response,'has_next');
  if(next.present)requireValue(typeof next.value==='boolean');else gap(gaps,'account_has_next_missing','has_next');
  if(next.value===true&&!discovery)gap(gaps,'warehouse_pagination_incomplete','has_next');
  const warehouses=field(response,'warehouses');
  if(!warehouses.present){gap(gaps,'account_warehouses_missing','warehouses');return {hasNext:next.value,warehouses:null};}
  const values=list(warehouses.value,discovery?20:200).map(warehouse=>{
    const id=field(warehouse,'warehouse_id'),rfbs=field(warehouse,'is_rfbs'),pause=field(warehouse,'pause_at');
    if(id.present)requireValue(Number.isSafeInteger(id.value) && id.value>0);else gap(gaps,'account_warehouse_id_missing','warehouse_id');
    if(rfbs.present)requireValue(typeof rfbs.value==='boolean');else gap(gaps,'account_is_rfbs_missing','is_rfbs');
    if(pause.present && pause.value!==null)requireValue(isRuntimeConfigurationTimestamp(pause.value));
    return {...(discovery?{name:optionalText(warehouse,'name',gaps)}:{}),warehouseId:id.present?String(id.value):null,isRfbs:rfbs.value,status:optionalText(warehouse,'status',gaps),warehouseType:optionalText(warehouse,'warehouse_type',gaps),
      pauseAtPresent:pause.present,pauseAt:pause.value};
  });
  if(!discovery&&values.length===0 && next.value===false)gap(gaps,'warehouse_not_found','warehouses');
  if(!discovery&&(values.length>1 || values.some(value=>value.warehouseId!==null && value.warehouseId!==scope.warehouseId)))gap(gaps,'warehouse_scope_mismatch','warehouses');
  if(discovery)requireValue(new Set(values.filter(row=>row.warehouseId!==null).map(row=>row.warehouseId)).size===values.filter(row=>row.warehouseId!==null).length,'DUPLICATE_WAREHOUSE_ID');
  return {hasNext:next.value,warehouses:values};
}
/** Whitelist projection only. Company identifiers, names, ratings, subscriptions and raw responses are never retained. */
export function normalizeOzonAccountReadResponse({method,response,scope,observedAt,officialContractRef}) {
  const path=endpoint(method);assertScope(scope);
  requireValue(isRuntimeConfigurationTimestamp(observedAt) && isCanonicalFrozenRef(officialContractRef),'CONTEXT_INVALID');
  requireValue(plain(response));const gaps=[];
  const facts=method==='roles'?rolesFacts(response,observedAt,gaps):method==='seller_info'?sellerFacts(response,gaps):warehouseFacts(response,scope,gaps);
  if(scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION){
    const seen=new Set();for(let i=0;i<gaps.length;){const key=`${gaps[i].code}:${gaps[i].field}`;if(seen.has(key))gaps.splice(i,1);else{seen.add(key);i++;}}
  }
  const result={schemaVersion:scope.schemaVersion===OZON_ACCOUNT_DISCOVERY_SCOPE_VERSION?'ozon-account-read-result-v2':'ozon-account-read-result-v1',method,endpoint:path,officialContractRef,observedAt,status:gaps.length===0?'observed':'data_unavailable',facts,gaps};
  try { assertNoProductionSecrets(result,'ozonAccountReadResult'); }
  catch(error){if(error?.constructor===Error && /^PRODUCTION_AUTHORIZATION_SECRET_REJECTED:/.test(error.message))throw new OzonAccountReadApiError('RESPONSE_UNSAFE');throw error;}
  return result;
}
export async function collectOzonAccountReadMethod({method,scope,executionKey,requestJson,beforeRequestSend,signal,observedAt,officialContractRef}) {
  requireValue(typeof requestJson==='function' && typeof beforeRequestSend==='function' && (signal===undefined || signal instanceof AbortSignal),'DEPENDENCY_INVALID');
  const request=buildOzonAccountReadRequest({method,scope,executionKey});
  requireValue(isRuntimeConfigurationTimestamp(observedAt) && isCanonicalFrozenRef(officialContractRef),'CONTEXT_INVALID');
  const response=await requestJson(request,{signal,beforeRequestSend});
  return normalizeOzonAccountReadResponse({method,response,scope,observedAt,officialContractRef});
}
