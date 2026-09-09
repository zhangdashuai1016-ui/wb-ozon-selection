import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOzonAccountReadRequest,normalizeOzonAccountReadResponse,collectOzonAccountReadMethod,OzonAccountReadApiError} from '../lib/ozon-account-read-api.mjs';
const scope={storeRef:{stableStoreId:'dandanshu',platformStoreId:'synthetic-store:1',mappingVersion:'mapping:1'},warehouseRef:'warehouse:1',warehouseId:'10001',credentialAlias:'credential-alias:1'};
const at='2026-09-08T00:00:00.000Z';
const normalize=(method,response,patch={})=>normalizeOzonAccountReadResponse({method,response,scope,observedAt:at,officialContractRef:'official-contract:synthetic:1',...patch});
const warehouse=()=>({warehouse_id:10001,is_rfbs:true,status:'created',warehouse_type:'RFBS',pause_at:null});
test('only documented fixed read requests; roles and seller info have no body',()=>{
 for(const method of ['roles','seller_info','warehouse_list']){
  const request=buildOzonAccountReadRequest({method,scope,executionKey:'request:synthetic:1'});assert.equal(request.write,false);assert.equal(request.method,'POST');assert.deepEqual(request.storeRef,scope.storeRef);
  assert.deepEqual(request.body,method==='warehouse_list'?{limit:1,warehouse_ids:['10001']}:null);
 }
 assert.throws(()=>buildOzonAccountReadRequest({method:'products',scope,executionKey:'request:1'}),OzonAccountReadApiError);
 assert.throws(()=>buildOzonAccountReadRequest({method:'roles',scope:{...scope,warehouseId:'9223372036854775808'},executionKey:'request:1'}),OzonAccountReadApiError);
});
test('roles preserve exact method strings without deriving permissions from role names',()=>{
 const result=normalize('roles',{expires_at:'2027-01-01T00:00:00Z',roles:[{name:'Admin',methods:['/v3/product/import','/v1/*']}]});
 assert.equal(result.status,'observed');assert.deepEqual(result.facts.roles[0].methods,['/v3/product/import','/v1/*']);assert.equal(Object.hasOwn(result.facts,'permissionStatus'),false);
 for(const response of [{},{roles:[]},{expires_at:at,roles:[{name:'Admin',methods:[]}]},{expires_at:'2027-01-01T00:00:00Z',roles:[{name:'Admin'}]}])assert.equal(normalize('roles',response).status,'data_unavailable');
});
test('wrong documented field types reject; they are never converted into empty facts',()=>{
 for(const [method,response] of [['roles',{expires_at:42}],['roles',{roles:null}],['roles',{roles:[{methods:'all'}]}],['roles',{roles:[{methods:[42]}]}],['seller_info',{company:null}],['seller_info',{company:{currency:123}}],['seller_info',{company:{currency:'XXX'}}],['warehouse_list',{has_next:'false',warehouses:[]}],['warehouse_list',{has_next:false,warehouses:[{...warehouse(),warehouse_id:'10001'}]}],['warehouse_list',{has_next:false,warehouses:[{...warehouse(),warehouse_id:Number.MAX_SAFE_INTEGER+1}]}],['warehouse_list',{has_next:false,warehouses:[{...warehouse(),is_rfbs:'true'}]}],['warehouse_list',{has_next:false,warehouses:[{...warehouse(),pause_at:'tomorrow'}]}]])assert.throws(()=>normalize(method,response),OzonAccountReadApiError);
});
test('seller company currency is a separate fact; tax IDs, names and other account information are excluded',()=>{
 const result=normalize('seller_info',{company:{currency:'USD',inn:'DO_NOT_SAVE_TAX_ID',ogrn:'DO_NOT_SAVE_REGISTRATION',legal_name:'DO_NOT_SAVE_NAME'},ratings:{private:'DO_NOT_SAVE'},subscription:{private:'DO_NOT_SAVE'}});
 assert.deepEqual(result.facts,{companyCurrency:'USD'});assert.equal(result.status,'observed');assert.equal(JSON.stringify(result).includes('DO_NOT_SAVE'),false);
 assert.equal(normalize('seller_info',{}).status,'data_unavailable');assert.equal(normalize('seller_info',{company:{}}).status,'data_unavailable');
});
test('warehouse matches exact requested ID; pagination and true empty results remain gaps',()=>{
 assert.equal(normalize('warehouse_list',{has_next:false,warehouses:[warehouse()]}).status,'observed');
 for(const [response,code] of [[{has_next:true,warehouses:[warehouse()]},'warehouse_pagination_incomplete'],[{has_next:false,warehouses:[]},'warehouse_not_found'],[{has_next:false,warehouses:[{...warehouse(),warehouse_id:10002}]},'warehouse_scope_mismatch']]){
  const result=normalize('warehouse_list',response);assert.equal(result.status,'data_unavailable');assert.ok(result.gaps.some(g=>g.code===code));
 }
 const partial=normalize('warehouse_list',{warehouses:[{}]});assert.equal(partial.status,'data_unavailable');assert.equal(partial.facts.hasNext,null);assert.equal(partial.facts.warehouses[0].warehouseId,null);
});
test('pause field absence differs from explicit null without inferring operational status',()=>{
 const missing=warehouse();delete missing.pause_at;
 assert.deepEqual(normalize('warehouse_list',{has_next:false,warehouses:[missing]}).facts.warehouses[0],{warehouseId:'10001',isRfbs:true,status:'created',warehouseType:'RFBS',pauseAtPresent:false,pauseAt:null});
 assert.equal(normalize('warehouse_list',{has_next:false,warehouses:[warehouse()]}).facts.warehouses[0].pauseAtPresent,true);
});
test('response projection does not invoke accessors and enforces bounded collections',()=>{
 let calls=0;const response=Object.defineProperty({},'roles',{get(){calls++;return [];}});
 assert.throws(()=>normalize('roles',response),OzonAccountReadApiError);assert.equal(calls,0);
 assert.throws(()=>normalize('roles',{roles:Array(1001).fill({})}),/LIMIT_EXCEEDED/);
});
test('one-method collector forwards trusted hook and cancellation; no retry on failure',async()=>{
 let calls=0,hooks=0;const controller=new AbortController(),beforeRequestSend=async()=>{hooks++;};
 const result=await collectOzonAccountReadMethod({method:'seller_info',scope,executionKey:'request:1',observedAt:at,officialContractRef:'official-contract:1',signal:controller.signal,beforeRequestSend,
  requestJson:async(request,options)=>{calls++;assert.equal(options.signal,controller.signal);assert.equal(options.beforeRequestSend,beforeRequestSend);await options.beforeRequestSend();return {company:{currency:'CNY'}};}});
 assert.equal(result.status,'observed');assert.equal(calls,1);assert.equal(hooks,1);
 const error=new Error('transport stopped');await assert.rejects(()=>collectOzonAccountReadMethod({method:'roles',scope,executionKey:'request:2',observedAt:at,officialContractRef:'official-contract:1',beforeRequestSend,
  requestJson:async()=>{calls++;throw error;}}),e=>e===error);assert.equal(calls,2);
});
