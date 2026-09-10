import test from 'node:test';import assert from 'node:assert/strict';
import {createLinkfoxProductDetailConnector} from '../lib/linkfox-product-detail-connector.mjs';
import {createLinkfoxGatewayTransport} from '../lib/linkfox-gateway-transport.mjs';
import {LINKFOX_DETAIL_CONTRACT_VERSION,buildLinkfoxProductDetailRequest} from '../lib/linkfox-product-detail-api.mjs';
import {LINKFOX_DISCOVERY_GATEWAY,LINKFOX_DISCOVERY_CONTRACT_VERSION,LinkfoxDiscoveryError} from '../lib/linkfox-discovery-api.mjs';
const binding=()=>({provider:'linkfox',bindingId:'detail:route',configurationVersion:'version:1',gatewayOrigin:LINKFOX_DISCOVERY_GATEWAY,credentialAlias:'linkfox-synthetic',
 contractVersion:LINKFOX_DETAIL_CONTRACT_VERSION,allowedMethods:['ozon_detail','supplier_detail'],timeoutMs:1000,budgetPolicyRef:'detail:budget'});
const input=method=>({requestId:'detail:request',method,productId:method==='ozon_detail'?'2107989735':'876240928352'});
const data=method=>method==='ozon_detail'?{code:'200',errcode:200,total:1,products:[{sku:2107989735,title:'Synthetic item',price:297,currency:'₽',productUrl:'https://www.ozon.ru/product/2107989735/'}]}:
 {errcode:200,offerId:'876240928352',subject:'合成物品',skuList:[{skuId:'1234567',retailPrice:'5.90'}]};
const known=code=>error=>error instanceof LinkfoxDiscoveryError&&error.code===code;
function fixture(overrides={}){const events=[];const options={binding:binding(),readSecret:async()=>{events.push('secret');return 'synthetic-value';},beforeRequestSend:async facts=>events.push(['gate',facts]),
 fetchImpl:async(url,opts)=>{events.push(['fetch',url,opts]);return new Response(JSON.stringify(data(JSON.parse(opts.body).sku?'ozon_detail':'supplier_detail')));},serverClock:()=> '2026-09-08T12:00:00.000Z',...overrides};
 return {events,options,connector:createLinkfoxProductDetailConnector(options)};}
test('each detail job uses one exact provider endpoint and retains separate budget identity',async()=>{
 for(const method of ['ozon_detail','supplier_detail']){const {events,connector}=fixture();assert.deepEqual(events,[]);
 const result=await connector.read(input(method));assert.equal(result.status,'observed');assert.equal(result.accounting.actualCharge,'unknown');
 assert.deepEqual(events.map(v=>Array.isArray(v)?v[0]:v),['secret','gate','fetch']);assert.equal(events[1][1].budgetPolicyRef,'detail:budget');
 assert.equal(events[2][1],LINKFOX_DISCOVERY_GATEWAY+(method==='ozon_detail'?'/seerfar/ozon/productDetailSearch':'/alibaba1688/productDetail'));
 assert.equal(events[2][2].redirect,'error');await assert.rejects(connector.read(input(method)),known('ALREADY_ATTEMPTED'));assert.equal(events.length,3);}
});
test('search bindings cannot authorize detail, and the shared core rejects tampered request paths and bodies',async()=>{
 assert.throws(()=>fixture({binding:{...binding(),contractVersion:LINKFOX_DISCOVERY_CONTRACT_VERSION,allowedMethods:['ozon_market_search']}}),known('BINDING_INVALID'));
 for(const change of [{endpoint:'https://example.com/secret'},{body:{offerId:'876240928353'}},{endpoint:'/alibaba1688/productSearch'}]){
 const {options,events}=fixture();const transport=createLinkfoxGatewayTransport(options);
 await assert.rejects(transport.request({...buildLinkfoxProductDetailRequest(input('supplier_detail')),...change}),known('INPUT_INVALID'));assert.deepEqual(events,[]);}
});
test('detail send gate and credentials fail before fetch; unknown errors are not swallowed',async()=>{
 const original=new Error('synthetic stale detail permission');const f=fixture({beforeRequestSend:async()=>{throw original;}});
 await assert.rejects(f.connector.read(input('ozon_detail')),error=>error===original);assert.deepEqual(f.events,['secret']);
 for(const code of ['CREDENTIAL_MISSING','CREDENTIAL_UNAVAILABLE','CREDENTIAL_READ_FAILED']){const f=fixture({readSecret:async()=>{throw new LinkfoxDiscoveryError(code);}});
 await assert.rejects(f.connector.read(input('supplier_detail')),known(code));assert.deepEqual(f.events,[]);}
});
test('detail response deadline cancels the body and never issues a second request',async()=>{
 let count=0,cancelled=false;const f=fixture({binding:{...binding(),timeoutMs:20},fetchImpl:async()=>{count++;return new Response(new ReadableStream({cancel(){cancelled=true;}}));}});
 await assert.rejects(f.connector.read(input('supplier_detail')),known('TIMEOUT'));await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.equal(count,1);
 await assert.rejects(f.connector.read(input('supplier_detail')),known('ALREADY_ATTEMPTED'));assert.equal(count,1);
});
test('detail cancellation while credentials resolve prevents a late paid request',async()=>{
 const controller=new AbortController(),original=new Error('cancel detail');const f=fixture({signal:controller.signal,readSecret:async()=>{controller.abort(original);return 'synthetic-value';}});
 await assert.rejects(f.connector.read(input('supplier_detail')),error=>error===original);assert.deepEqual(f.events,[]);
});
test('a transport that returns headers after deadline has its late body cancelled without replay',async()=>{
 let finish,cancelled=false,sends=0;
 const f=fixture({binding:{...binding(),timeoutMs:20},fetchImpl:async()=>{sends++;return new Promise(resolve=>{finish=resolve;});}});
 await assert.rejects(f.connector.read(input('supplier_detail')),known('TIMEOUT'));
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.equal(sends,1);
 await assert.rejects(f.connector.read(input('supplier_detail')),known('ALREADY_ATTEMPTED'));
});
test('internal deadline signal reaches credential reader for resource cancellation',async()=>{
 let receivedSignal,cancelled=false;
 const f=fixture({binding:{...binding(),timeoutMs:20},readSecret:({signal})=>{receivedSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));}});
 await assert.rejects(f.connector.read(input('supplier_detail')),known('TIMEOUT'));assert.equal(receivedSignal.aborted,true);assert.equal(cancelled,true);assert.deepEqual(f.events,[]);
});
