import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGuooRoutes, assertGuooRouteComparison, appendGuooRouteComparison, assertGuooComparisonReadyForEvidence } from '../lib/guoo-route-comparison.mjs';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';
import { calculateFreight } from '../lib/lifecycle-b-input-bundle.mjs';

const at='2026-09-09T08:00:00.000Z';
const issue=(code,message)=>({code,message,sourceCells:[{sheetName:'Synthetic',cellRef:'F5'}]});
function row(rowNumber=17,perKgRmb=28.1,perParcelRmb=17.97) {
  const route=`GUOO Synthetic ${rowNumber} PUDO`;
  return {rowNumber,route,deliveryMethods:[route,`GUOO Synthetic ${rowNumber} Courier`],routeText:route,
    sourceRefs:{perKgRmb:{sheetName:'Synthetic',cellRef:`K${rowNumber}`},perParcelRmb:{sheetName:'Synthetic',cellRef:`L${rowNumber}`}},
    evidenceData:{chargeableWeightRule:'actual_weight',perKgRmb,perParcelRmb,minimumChargeableWeightKg:0.001,
      weightRoundingRule:'none',weightRoundingKg:null,productType:'Small',weightLimit:'0.001-2KG',declaredValueLimitRub:'1501-7000₽',
      sizeLimit:'尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费',
      batteryTransportRule:'电池不允许\n只接普货（不接带电、带磁、液体、粉末、刀具、仿牌等产品）'},
    unresolvedRules:[],feeCoverage:{status:'complete',additionalPerParcelRmb:0,evidenceRef:'evidence:synthetic-complete-fees'}};
}
function input(rows=[row()]) {
  const present=new Set(rows.map(value=>value.rowNumber));
  const completeRows=[...rows,...Array.from({length:15},(_,index)=>index+10).filter(index=>!present.has(index)).map(index=>{
    const excluded=row(index);excluded.evidenceData.weightLimit='10-30KG';return excluded;
  })];
  return {candidateId:'candidate:synthetic-guoo',sourceRevision:3,
    packaging:{weightKg:0.21,dimensionsCm:{length:20,width:10,height:5},sourceRef:'evidence:synthetic-confirmed-packaging'},
    salePrice:{amountRub:2000,sourceRef:'evidence:synthetic-target-sale'},
    cargoFacts:{batteryType:'none',batteryEnergyWh:null,generalCargo:true,personalUse:true,irregularShape:false,sourceRef:'evidence:synthetic-cargo'},
    catalog:{schemaVersion:'guoo-tariff-catalog-v1',sourceRef:'evidence:synthetic-catalog',ruleVersion:'synthetic-guoo-v1',
      observedAt:at,sourceNotes:[],rows:completeRows,unresolvedRules:[]}};
}

test('complete single-item comparison reuses the existing freight calculation and includes fixed fee once',()=>{
  const request=input(),unchanged=structuredClone(request),result=compareGuooRoutes(request);
  assert.deepEqual(result.routes[0].baseFreight,calculateFreight({id:'evidence:synthetic-catalog:row-17',
    scope:{route:request.catalog.rows[0].route.replace(/ PUDO$/u,''),ruleVersion:request.catalog.ruleVersion},evidenceData:request.catalog.rows[0].evidenceData},request.packaging));
  assert.equal(result.routes[0].totalFreightRmb,23.87);
  assert.equal(result.status,'compared');assert.equal(result.selectedRoute,request.catalog.rows[0].route.replace(/ PUDO$/u,''));
  assert.equal(result.routes[0].feeCoverage.evidenceRef,'evidence:synthetic-complete-fees');
  assert.deepEqual(assertGuooRouteComparison(result,{candidateId:request.candidateId,sourceRevision:3,catalog:request.catalog}),result);
  assert.deepEqual(request,unchanged);assert.equal(result.platformWrites,0);
});

test('minimum full fee differs from minimum base fee and ties do not select a warehouse',()=>{
  const first=row(16,10,1),second=row(17,20,1);first.feeCoverage.additionalPerParcelRmb=10;
  const request=input([first,second]),result=compareGuooRoutes(request);
  assert.equal(result.routes[0].baseFreight.amountRmb,3.1);assert.equal(result.routes[0].totalFreightRmb,13.1);
  assert.equal(result.selectedRoute,second.route.replace(/ PUDO$/u,''));
  const tied=compareGuooRoutes(input([row(16),row(17)]));
  assert.equal(tied.status,'compared');assert.equal(tied.minimumRoutes.length,2);assert.equal(tied.selectedRoute,null);
  assert.equal(Object.hasOwn(tied,'warehouseId'),false);
});

test('unknown potentially usable route blocks the minimum while a proven ineligible route does not',()=>{
  const unknown=row(16);unknown.feeCoverage={status:'unknown',additionalPerParcelRmb:null,evidenceRef:null};
  const blocked=compareGuooRoutes(input([unknown,row(17)]));
  assert.equal(blocked.routes[0].eligibility,'eligible');assert.equal(blocked.routes[0].totalFreightRmb,null);
  assert.equal(blocked.status,'blocked');assert.deepEqual(blocked.minimumRoutes,[]);
  unknown.evidenceData.weightLimit='3-30KG';
  const decided=compareGuooRoutes(input([unknown,row(17)]));
  assert.equal(decided.routes[0].eligibility,'ineligible');assert.equal(decided.status,'compared');
});

test('actual catalog rule gaps and missing business facts remain explicit with zero quote',()=>{
  const request=input();request.salePrice=null;request.cargoFacts=null;
  request.catalog.rows[0].evidenceData.weightRoundingRule=null;
  request.catalog.rows[0].unresolvedRules=[issue('WEIGHT_ROUNDING_UNRESOLVED','按克文字不能决定进位方式')];
  request.catalog.unresolvedRules=[issue('SETTLEMENT_RULES_AND_FEE_COVERAGE_UNRESOLVED','结算规则及完整费用未核实')];
  const result=compareGuooRoutes(request);
  assert.equal(result.status,'blocked');assert.equal(result.routes[0].eligibility,'unknown');assert.equal(result.routes[0].baseFreight,null);
  assert.ok(result.routes[0].reasons.some(value=>value.code==='SALE_PRICE_REQUIRED'));
  assert.ok(result.routes[0].reasons.some(value=>value.code==='CARGO_RULE_UNRESOLVED'));
  assert.equal(result.globalIssues[0].code,'SETTLEMENT_RULES_AND_FEE_COVERAGE_UNRESOLVED');
  assert.ok(result.routes[0].reasons.some(value=>value.code==='WEIGHT_ROUNDING_UNRESOLVED'));
  assert.ok(result.routes[0].reasons.some(value=>value.code==='FREIGHT_RULE_INCOMPLETE'));
});

test('rounding minimum and volume facts never receive a default and reuse original step calculation when explicit',()=>{
  for(const field of ['minimumChargeableWeightKg','weightRoundingRule']) {
    const request=input();request.catalog.rows[0].evidenceData[field]=null;
    const result=compareGuooRoutes(request);assert.equal(result.status,'blocked');assert.equal(result.routes[0].baseFreight,null);
  }
  const request=input(),tariff=request.catalog.rows[0].evidenceData;
  tariff.chargeableWeightRule='max_actual_volume';tariff.volumeDivisorCm3PerKg=null;
  assert.equal(compareGuooRoutes(request).status,'blocked');
  tariff.volumeDivisorCm3PerKg=12000;tariff.weightRoundingRule='step';tariff.weightRoundingKg=0.1;
  const result=compareGuooRoutes(request);assert.equal(result.routes[0].baseFreight.chargeableWeightKg,0.3);
  assert.equal(result.routes[0].totalFreightRmb,26.4);
});

test('known range size and battery restrictions reject, unsupported or conflicting text remains unknown',()=>{
  for(const change of [request=>request.packaging.weightKg=3,request=>request.salePrice.amountRub=1500,
    request=>request.packaging.dimensionsCm.length=61,
    request=>{request.cargoFacts.batteryType='installed';request.cargoFacts.generalCargo=false;}]) {
    const request=input();change(request);const result=compareGuooRoutes(request);
    assert.equal(result.routes[0].eligibility,'ineligible');assert.equal(result.status,'no_applicable_routes');
  }
  const conflict=input();conflict.packaging.weightKg=3;
  conflict.catalog.rows[0].unresolvedRules=[issue('WEIGHT_BOUNDARY_SOURCE_CONFLICT','表文与公式边界不同')];
  assert.equal(compareGuooRoutes(conflict).routes[0].eligibility,'unknown');
  const unsupported=input();unsupported.catalog.rows[0].evidenceData.sizeLimit='assume anything fits';
  assert.equal(compareGuooRoutes(unsupported).status,'blocked');
});

test('asymmetric dimensions compare longest edges without changing packaging or treating a formula as a rule',()=>{
  const request=input();request.packaging.dimensionsCm={length:10,width:100,height:20};
  request.catalog.rows[0].evidenceData.sizeLimit='尺寸限制：三边之和不超310CM，单边最大尺寸不超150*80*80CM';
  assert.equal(compareGuooRoutes(request).status,'compared');
  request.catalog.rows[0].evidenceData.weightLimit='=IF(anything)';
  assert.equal(compareGuooRoutes(request).status,'blocked');
});

test('invalid identity quantity-like packaging duplicate routes and contradictory facts fail explicitly',()=>{
  for(const change of [request=>request.sourceRevision=-1,request=>request.packaging.weightKg=NaN,
    request=>request.packaging.quantity=2,request=>request.catalog.rows.push(structuredClone(request.catalog.rows[0])),request=>request.catalog.rows.pop(),
    request=>request.cargoFacts.batteryType='installed',request=>request.salePrice.amountRub=0]) {
    const request=input();change(request);assert.throws(()=>compareGuooRoutes(request),/GUOO_ROUTE_COMPARISON_/);
  }
});

test('published comparison verifier rejects forged selection totals and evidence identity',()=>{
  const request=input(),result=compareGuooRoutes(request);
  for(const change of [value=>value.selectedRoute='another-route',value=>value.routes[0].totalFreightRmb=0,
    value=>value.catalogSourceRef='another-source',value=>value.inputSnapshot.packaging.weightKg=1]) {
    const changed=structuredClone(result);change(changed);
    assert.throws(()=>assertGuooRouteComparison(changed,{candidateId:request.candidateId,sourceRevision:3,catalog:request.catalog}),/GUOO_ROUTE_COMPARISON_/);
  }
});

test('append binds both revisions preserves history and does not mutate the candidate',()=>{
  const request=input(),comparison=compareGuooRoutes(request),candidate={id:request.candidateId,dataRevision:3,history:[{action:'keep'}]};
  const original=structuredClone(candidate),next=appendGuooRouteComparison(candidate,comparison,{recordedAt:at});
  assert.deepEqual(candidate,original);assert.equal(next.dataRevision,4);assert.equal(next.guooRouteComparisonsV1[0].sourceRevision,3);
  assert.equal(next.guooRouteComparisonsV1[0].resultRevision,4);assert.equal(next.guooRouteComparisonsV1[0].recordedAt,at);
  request.sourceRevision=4;
  const again=appendGuooRouteComparison(next,compareGuooRoutes(request),{recordedAt:at});
  assert.equal(again.guooRouteComparisonsV1.length,2);assert.deepEqual(again.guooRouteComparisonsV1[0],next.guooRouteComparisonsV1[0]);
  assert.throws(()=>appendGuooRouteComparison(next,comparison,{recordedAt:at}),/REVISION_CONFLICT/);
});

test('append rejects corrupt history frozen SKU and other candidate identity',()=>{
  const request=input(),comparison=compareGuooRoutes(request),candidate={id:request.candidateId,dataRevision:3};
  for(const changed of [{...candidate,guooRouteComparisonsV1:{}},{...candidate,lifecycleV11:{skuPackage:{skuPackageId:'frozen'}}},
    {...candidate,id:'candidate:other'}])assert.throws(()=>appendGuooRouteComparison(changed,comparison,{recordedAt:at}),/GUOO_ROUTE_COMPARISON_/);
});


test('installed battery permission text and Wh do not prove complete SKU transport eligibility',()=>{
  const request=input();request.cargoFacts={...request.cargoFacts,batteryType:'installed',batteryEnergyWh:20,generalCargo:false};
  for(const batteryTransportRule of ['可以运输内部装有电池的物品\n无需提供材料安全性数据表MSDS',
    '不可运输纯电池\n可以运输内部装有电池的物品\n无需提供材料安全性数据表MSDS\n最大功率为160瓦特一小时']) {
    request.catalog.rows[0].evidenceData.batteryTransportRule=batteryTransportRule;
    const result=compareGuooRoutes(request);assert.equal(result.routes[0].eligibility,'unknown');assert.equal(result.status,'compared');assert.equal(result.transportVerified,false);
    assert.ok(result.routes[0].reasons.some(value=>value.code==='CARGO_RULE_UNRESOLVED'));
  }
  request.cargoFacts.batteryEnergyWh=161;
  assert.equal(compareGuooRoutes(request).routes[0].eligibility,'ineligible');
});

test('saved evidence admission requires the current revision unique completed decision and matching rules',()=>{
  const request=input(),candidate={id:request.candidateId,dataRevision:3};
  const saved=appendGuooRouteComparison(candidate,compareGuooRoutes(request),{recordedAt:at});
  const admitted=assertGuooComparisonReadyForEvidence(saved,request.catalog.ruleVersion);
  assert.equal(admitted.resultRevision,4);assert.equal(admitted.selectedRoute,request.catalog.rows[0].route.replace(/ PUDO$/u,''));
  assert.deepEqual(saved.guooRouteComparisonsV1[0],admitted);
  assert.throws(()=>assertGuooComparisonReadyForEvidence(candidate,request.catalog.ruleVersion),/COMPARISON_REQUIRED/);
  assert.throws(()=>assertGuooComparisonReadyForEvidence({...saved,dataRevision:5},request.catalog.ruleVersion),/SAVED_RESULT_STALE/);
  assert.throws(()=>assertGuooComparisonReadyForEvidence(saved,'another-rule-version'),/RULE_VERSION_CONFLICT/);
  assert.throws(()=>assertGuooComparisonReadyForEvidence({...saved,lifecycleV11:{skuPackage:{skuPackageId:'frozen'}}},request.catalog.ruleVersion),/FROZEN_CANDIDATE_REVIEW_REQUIRED/);
  const broken=structuredClone(saved);broken.guooRouteComparisonsV1[0].routes[0].totalFreightRmb=0;
  assert.throws(()=>assertGuooComparisonReadyForEvidence(broken,request.catalog.ruleVersion),/RESULT_PRICE_INVALID/);
  const missingFacts=structuredClone(saved);missingFacts.guooRouteComparisonsV1[0].inputSnapshot.salePrice=null;
  assert.throws(()=>assertGuooComparisonReadyForEvidence(missingFacts,request.catalog.ruleVersion),/RESULT_ELIGIBILITY_INVALID/);
});

test('saved evidence admission never falls back past a newer blocked corrupt or tied record',()=>{
  const request=input(),candidate={id:request.candidateId,dataRevision:3};
  const first=appendGuooRouteComparison(candidate,compareGuooRoutes(request),{recordedAt:at});
  request.sourceRevision=4;request.salePrice=null;
  const second=appendGuooRouteComparison(first,compareGuooRoutes(request),{recordedAt:at});
  assert.throws(()=>assertGuooComparisonReadyForEvidence(second,request.catalog.ruleVersion),/COMPARISON_NOT_READY/);
  const corrupt={...first,guooRouteComparisonsV1:{}};
  assert.throws(()=>assertGuooComparisonReadyForEvidence(corrupt,request.catalog.ruleVersion),/HISTORY_INVALID/);
  const invalidLatest={...first,guooRouteComparisonsV1:[...first.guooRouteComparisonsV1,{}]};
  assert.throws(()=>assertGuooComparisonReadyForEvidence(invalidLatest,request.catalog.ruleVersion),/SAVED_RESULT_INVALID/);
  const tiedInput=input([row(16),row(17)]);
  const tied=appendGuooRouteComparison(candidate,compareGuooRoutes(tiedInput),{recordedAt:at});
  assert.throws(()=>assertGuooComparisonReadyForEvidence(tied,tiedInput.catalog.ruleVersion),/COMPARISON_NOT_READY/);
});

 test('five inputs recommend a table quote while unknown transport cannot enter formal evidence',()=>{
  const request=input();request.cargoFacts=null;
  const result=compareGuooRoutes(request);
  assert.equal(result.status,'compared');assert.equal(result.routes[0].quoteEligibility,'eligible');
  assert.equal(result.routes[0].eligibility,'unknown');assert.equal(result.transportVerified,false);
  assert.equal(result.selectedRoute,'GUOO Synthetic 17');assert.equal(result.routes[0].totalFreightRmb,23.87);
  assert.deepEqual(result.routes[0].deliveryMethods,request.catalog.rows[0].deliveryMethods);
  assert.deepEqual(assertGuooRouteComparison(result,{catalog:request.catalog}),result);
  const saved=appendGuooRouteComparison({id:request.candidateId,dataRevision:3},result,{recordedAt:at});
  assert.throws(()=>assertGuooComparisonReadyForEvidence(saved,request.catalog.ruleVersion),/TRANSPORT_EVIDENCE_REQUIRED/);
 });

test('saved real workbook five-input example recommends Economy Small 46.07 without selecting a delivery method',async()=>{
  const request=input();request.catalog=await readGuooTariffCatalog();request.cargoFacts=null;
  request.packaging={weightKg:1,dimensionsCm:{length:20,width:20,height:8},sourceRef:'test:five-input-package'};
  const result=compareGuooRoutes(request);
  assert.equal(result.status,'compared');assert.equal(result.selectedRoute,'GUOO Economy Small');
  assert.equal(result.selectedRouteLabel,'经济轻小件');assert.equal(result.transportVerified,false);
  for(const [route,amount] of [['GUOO Express Small',68.47],['GUOO Standard Small',57.27],['GUOO Economy Small',46.07]]) {
    const quoted=result.routes.find(row=>row.route===route);assert.equal(quoted.totalFreightRmb,amount);
    assert.equal(quoted.quoteEligibility,'eligible');assert.equal(quoted.eligibility,'unknown');
    assert.deepEqual(quoted.deliveryMethods,[`${route} PUDO`,`${route} Courier`]);
  }
  assert.deepEqual(assertGuooRouteComparison(result,{catalog:request.catalog}),result);
  request.packaging.weightKg=2;
  assert.equal(compareGuooRoutes(request).status,'blocked');
  request.packaging.weightKg=3;request.salePrice.amountRub=1501;
  assert.equal(compareGuooRoutes(request).status,'blocked');
  request.salePrice.amountRub=2000;assert.equal(compareGuooRoutes(request).status,'compared');
});
