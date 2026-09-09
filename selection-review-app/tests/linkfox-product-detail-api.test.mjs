import test from 'node:test';import assert from 'node:assert/strict';
import {buildLinkfoxProductDetailRequest,normalizeLinkfoxProductDetailResponse,adaptLinkfoxDetailToSalesSnapshot,adaptLinkfoxDetailToSupplierOption,LINKFOX_DETAIL_COSTS} from '../lib/linkfox-product-detail-api.mjs';
import {validateSalesSnapshot} from '../lib/sales-snapshot.mjs';import {validateSupplierOption} from '../lib/supplier-option.mjs';
const observedAt='2026-09-08T12:00:00.000Z';
const request=method=>buildLinkfoxProductDetailRequest({requestId:'detail:synthetic',method,productId:method==='ozon_detail'?'2107989735':'876240928352'});
const market=()=>({code:'200',errcode:200,total:1,products:[{sku:2107989735,title:'Synthetic organizer',price:297,currency:'₽',productUrl:'https://www.ozon.ru/product/2107989735/',imageUrls:['https://cdn.example.com/organizer.jpg'],categoryInfo:{titlePath:'Home/Organizer'}}]});
const supplier=()=>({errcode:200,offerId:'876240928352',subject:'合成桌面收纳',minOrderQuantity:1,skuList:[{skuId:'1234567',specId:'7654321',retailPrice:'5.90',price:'3.00',amountOnSale:2,skuImageUrl:'https://cdn.example.com/item.jpg'}]});
const normalize=(method,response)=>normalizeLinkfoxProductDetailResponse({request:request(method),httpStatus:200,response,observedAt});
test('detail methods bind one explicit identity and cost metadata without enlarging search authorization',()=>{
 assert.deepEqual(request('ozon_detail').body,{sku:'2107989735'});assert.deepEqual(request('supplier_detail').body,{offerId:'876240928352'});
 assert.equal(LINKFOX_DETAIL_COSTS.ozon_detail+LINKFOX_DETAIL_COSTS.supplier_detail,13);assert.equal(LINKFOX_DETAIL_COSTS.actualCharge,'unknown');
 assert.throws(()=>buildLinkfoxProductDetailRequest({requestId:'d:1',method:'ozon_detail',productId:'9007199254740993'}));
});
test('Ozon detail builds a genuine provider snapshot with unknown seller identity and no page claim',()=>{
 const result=normalize('ozon_detail',market()),adapted=adaptLinkfoxDetailToSalesSnapshot(result,{snapshotId:'snapshot:synthetic',evidenceRef:'receipt:synthetic'});
 assert.equal(validateSalesSnapshot(adapted.salesSnapshot).valid,true);assert.equal(adapted.salesSnapshot.collectorMode,'provider_api_read_only');
 assert.equal(adapted.salesSnapshot.sellerType,'unknown');assert.equal(adapted.complianceStatus,'unknown');
 const changed={...adapted.salesSnapshot,collectorMode:'real_page_read_only'};assert.equal(validateSalesSnapshot(changed).valid,false);
 const branded=market();branded.products[0].brandName='Synthetic Brand';assert.equal(adaptLinkfoxDetailToSalesSnapshot(normalize('ozon_detail',branded),{snapshotId:'snapshot:1',evidenceRef:'receipt:1'}).complianceStatus,'brand_review_required');
});
test('single SKU retail price remains distinct from wholesale and no supply is auto-confirmed',()=>{
 const result=normalize('supplier_detail',supplier()),adapted=adaptLinkfoxDetailToSupplierOption(result,{evidenceRef:'receipt:synthetic'});
 assert.equal(validateSupplierOption(adapted.supplierOption).valid,true);const sku=adapted.supplierOption.supplierSkus[0];
 assert.equal(sku.unitProductPrice,5.9);assert.equal(sku.variantKey,'7654321');assert.deepEqual(sku.attributes,{});
 assert.equal(sku.unitDomesticFreight,'unknown');assert.equal(sku.weight,'unknown');assert.equal(sku.actualPurchaseCost,'unknown');
 assert.deepEqual(adapted.selectedSkuIds,[]);assert.equal(adapted.ownerSupplyConfirmed,false);
 const absent=supplier();delete absent.skuList[0].retailPrice;absent.shippingInfo={weight:1,skuShippingInfoList:[{weight:500}]};
 const unknown=adaptLinkfoxDetailToSupplierOption(normalize('supplier_detail',absent),{evidenceRef:'receipt:2'});assert.equal(unknown.supplierOption.supplierSkus[0].unitProductPrice,'unknown');
});
test('empty responses, wrong types, identity drift and unsafe numbers cannot create detail evidence',()=>{
 assert.equal(normalize('ozon_detail',{code:'200',errcode:200,total:0,products:[]}).status,'true_empty');
 for(const value of ['2107989735',9007199254740992,true]){const r=market();r.products[0].sku=value;assert.throws(()=>normalize('ozon_detail',r));}
 const r=supplier();r.offerId='876240928353';assert.throws(()=>normalize('supplier_detail',r));
 for(const value of [5.9,'1e2','-1','0','1.123']){const r=supplier();r.skuList[0].retailPrice=value;assert.throws(()=>normalize('supplier_detail',r));}
 const missing=market();delete missing.products[0].price;assert.throws(()=>adaptLinkfoxDetailToSalesSnapshot(normalize('ozon_detail',missing),{snapshotId:'snapshot:1',evidenceRef:'receipt:1'}));
});
test('published SalesSnapshot schema admits only the explicitly paired provider version',async()=>{
 const {readFile}=await import('node:fs/promises');const {default:Ajv2020}=await import('ajv/dist/2020.js');const {default:addFormats}=await import('ajv-formats');
 const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);const validate=ajv.compile(JSON.parse(await readFile(new URL('../schema/sales-snapshot-v1.1.schema.json',import.meta.url),'utf8')));
 const {salesSnapshot}=adaptLinkfoxDetailToSalesSnapshot(normalize('ozon_detail',market()),{snapshotId:'snapshot:synthetic',evidenceRef:'receipt:synthetic'});
 assert.equal(validate(salesSnapshot),true,JSON.stringify(validate.errors));assert.equal(validate({...salesSnapshot,collectorVersion:'real-ozon-sales-snapshot-v1'}),false);
});
test('persistent normalized identity cannot drift before constructing formal evidence',()=>{
 const value=normalize('supplier_detail',supplier());value.facts.offerId='876240928353';
 assert.throws(()=>adaptLinkfoxDetailToSupplierOption(value,{evidenceRef:'receipt:synthetic'}));
 const marketValue=normalize('ozon_detail',market());marketValue.productId='2107989736';
 assert.throws(()=>adaptLinkfoxDetailToSalesSnapshot(marketValue,{snapshotId:'snapshot:synthetic',evidenceRef:'receipt:synthetic'}));
});
