import { createSyntheticBCostPolicy } from "./fixtures/b-cost-policy-fixture.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLifecycleBExplicitOtherCosts,
  resolveLifecycleBProfitRule,
  assertLifecycleBCostsCurrent,
  inspectLifecycleBCostReadiness,
  commitLifecycleBEvidencePacks
} from "../lib/lifecycle-b-evidence-runtime.mjs";

function pack(kind, scope, evidenceData) {
  return {
    id: `pack-${kind}`,
    kind,
    status: "active",
    scope,
    sourceType: "current_read_only",
    sourceRef: `fixture:${kind}`,
    checkedAt: "2026-08-18T02:00:00.000Z",
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData,
    providerVersion: "provider-v1"
  };
}

test("证据同ID内容冲突整批拒绝，不同平台店铺映射不会互相替代", () => {
  const scope = { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, category: "shelf", ruleVersion: "v1" };
  const original = pack("schema", scope, { schemaRevision: "v1", requiredFields: [] });
  const data = { evidencePacks: [] };
  commitLifecycleBEvidencePacks(data, [original], { createdAt: "2026-08-18T02:01:00.000Z" });
  const before = structuredClone(data);
  const changed = { ...original, scope: { ...scope, storeRef: { ...SYNTHETIC_STORE_REF, platformStoreId: "another" } } };
  assert.throws(() => commitLifecycleBEvidencePacks(data, [changed], { createdAt: "2026-08-18T02:02:00.000Z" }), /B_EVIDENCE_COMMIT_ID_CONFLICT/);
  assert.deepEqual(data, before);
  commitLifecycleBEvidencePacks(data, [{ ...changed, id: "new-schema" }], { createdAt: "2026-08-18T02:02:00.000Z" });
  assert.equal(data.evidencePacks.filter(item => item.status === "active").length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(data.evidencePacks[0])).scope.storeRef, SYNTHETIC_STORE_REF);
});

test("其他成本只从当前商品与有来源的项目政策显式组成", () => {
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF,
    lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  const rule = currentCostRules().ozonDandanshu;
  const result = buildLifecycleBExplicitOtherCosts(candidate, rule);
  assert.deepEqual(result, { packagingRmb: 1.5, labelRmb: 1.5, fixedOtherRmb: 0,
    advertisingRate: 0, returnReserveRate: 0.05, damageReserveRate: 0.05, withdrawalFeeRate: 0.02,
    acquiringRate: 0, taxRate: 0, otherRate: 0, targetMarginRate: 0.15, minimumUnitProfitRmb: 20,
    priceIncrementCny: 1, thresholdLogic: "any", pricingPolicyVersion: rule.costPolicySnapshot.policyVersion,
    costPolicySnapshot: rule.costPolicySnapshot });
  assert.throws(() => buildLifecycleBExplicitOtherCosts({ ...candidate, packagingCostRmb: null }, rule),
    /B_EVIDENCE_COST_POLICY_INCOMPLETE/);
  assert.throws(() => buildLifecycleBExplicitOtherCosts(candidate, { ...rule, costPolicySnapshot: undefined }),
    { code: "B_COST_POLICY_INVALID" });
});

test("四类证据先全量校验再原子替换，失败不留下半套结果", () => {
  const old = pack("exchange_rate", { pair: "RUB/CNY" }, { rubPerCny: 11.2 });
  old.id = "old-rate";
  old.scopeKey = 'exchange_rate|{"pair":"RUB/CNY"}';
  const data = { evidencePacks: [old] };
  const valid = [
    pack("commission", { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon:1:2", salesScheme: "rfbs" }, {
      commissionRate: 0.14, commissionEvidenceMode: "exact",
      otherCosts: { packagingRmb: 1.5, labelRmb: 1.5, fixedOtherRmb: 0, advertisingRate: 0, returnReserveRate: 0.05, damageReserveRate: 0.05, withdrawalFeeRate: 0.02, targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceIncrementCny: 1, thresholdLogic: "any", pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1" }
    }),
    pack("logistics_tariff", { route: "GUOO Economy Small", ruleVersion: "guoo-2026-07-20" }, {
      chargeableWeightRule: "actual_weight", perKgRmb: 28.1, perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0, weightRoundingRule: "none", weightRoundingKg: null
    }),
    pack("exchange_rate", { pair: "RUB/CNY" }, { rubPerCny: 11.3 }),
    pack("schema", { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon:1:2", ruleVersion: "ozon-current" }, {
      schemaRevision: "schema-current", requiredFields: []
    })
  ];
  const before = structuredClone(data);
  assert.throws(
    () => commitLifecycleBEvidencePacks(data, [...valid.slice(0, 3), { ...valid[3], evidenceData: {} }], {
      createdAt: "2026-08-18T02:01:00.000Z"
    }),
    /B_EVIDENCE_COMMIT_INVALID_DATA/
  );
  assert.deepEqual(data, before);

  const committed = commitLifecycleBEvidencePacks(data, valid, {
    createdAt: "2026-08-18T02:01:00.000Z"
  });
  assert.equal(committed.length, 4);
  assert.equal(data.evidencePacks.find((item) => item.id === "old-rate").status, "superseded");
  assert.equal(data.evidencePacks.filter((item) => item.status === "active").length, 4);
});

test("来源引用出现凭证字样时整批拒绝", () => {
  const data = { evidencePacks: [] };
  const unsafe = pack("exchange_rate", { pair: "RUB/CNY" }, { rubPerCny: 11.3 });
  unsafe.sourceRef = "authorization:secret";
  assert.throws(
    () => commitLifecycleBEvidencePacks(data, [unsafe], { createdAt: "2026-08-18T02:01:00.000Z" }),
    /B_EVIDENCE_COMMIT_SECRET_REJECTED/
  );
  assert.equal(data.evidencePacks.length, 0);
});

test('WB catalog commit preserves null expiry, rejects stale declarations and conflicting same-ID provenance atomically',()=>{
  const storeRef={...SYNTHETIC_STORE_REF,stableStoreId:'wb'};
  const commission=pack('commission',{platform:'wb',store:'wb',storeRef,category:'wb:subject:5267',salesScheme:'fbs'},
    {commissionRate:0.14,commissionEvidenceMode:'exact',otherCosts:{packagingRmb:1.5,labelRmb:1.5,fixedOtherRmb:0,
      advertisingRate:0,returnReserveRate:0,damageReserveRate:0.05,withdrawalFeeRate:0.02,targetMarginRate:0.15,
      minimumUnitProfitRmb:20,priceIncrementCny:1,thresholdLogic:'any',pricingPolicyVersion:'synthetic-cost-policy'}});
  commission.sourceType='wb_official_commission_reference';commission.expiresAt=null;
  commission.commissionCatalogRef={catalogId:'synthetic-catalog',catalogVersion:'v1',sellerRegion:'CN',subjectId:5267,
    sourceField:'kgvpChina',sourceReceiptRef:'synthetic-receipt',effectiveFrom:null};
  const currentCommissionCatalogs=[{platform:'wb',sellerRegion:'CN',catalogId:'synthetic-catalog',catalogVersion:'v1',status:'active'}];
  const options={createdAt:'2026-08-18T02:01:00.000Z',currentCommissionCatalogs},data={evidencePacks:[]};
  const saved=commitLifecycleBEvidencePacks(data,[commission],options);
  assert.equal(saved[0].expiresAt,null);assert.deepEqual(saved[0].commissionCatalogRef,commission.commissionCatalogRef);
  const before=structuredClone(data),conflict=structuredClone(commission);
  conflict.commissionCatalogRef.sourceReceiptRef='synthetic-other-receipt';
  assert.throws(()=>commitLifecycleBEvidencePacks(data,[conflict],options),/B_EVIDENCE_COMMIT_ID_CONFLICT/);
  assert.deepEqual(data,before);
  for(const catalogs of [[],[{...currentCommissionCatalogs[0],status:'invalidated'}],[{...currentCommissionCatalogs[0],catalogVersion:'v2'}]]){
    assert.throws(()=>commitLifecycleBEvidencePacks(data,[commission],{...options,currentCommissionCatalogs:catalogs}),/B_EVIDENCE_COMMIT_CATALOG_INVALID/);
    assert.deepEqual(data,before);
  }
  const secret=structuredClone(commission);secret.commissionCatalogRef.sourceReceiptRef='cookie=private';
  assert.throws(()=>commitLifecycleBEvidencePacks(data,[secret],options),/B_EVIDENCE_COMMIT_SECRET_REJECTED/);
  assert.deepEqual(data,before);
});


function currentCostRules() {
  const policy = { fixedOtherRmb: 0, advertisingReserveRate: 0, returnOpsReserveRate: 0.05,
    targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceRoundRmb: 1, thresholdPolicy: "either" };
  return { ozonDandanshu: { ...policy, costPolicySnapshot: createSyntheticBCostPolicy({
    scope: { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, salesScheme: "rfbs" },
    values: { returnReserveRate: 0.05 } }) }, ozonMiska: { ...policy, fixedOtherRmb: 2 },
    wbCrossListing: { ...policy, fixedOtherRmb: 3 } };
}

test("成本规则明确选择三店，未知店及缺失规则没有默认回退", () => {
  const rules = currentCostRules();
  for (const [store, key] of [["dandanshu", "ozonDandanshu"], ["miska", "ozonMiska"], ["wb", "wbCrossListing"]]) {
    assert.equal(resolveLifecycleBProfitRule({ targetStore: store }, rules), rules[key]);
  }
  for (const store of ["other", "", undefined]) {
    assert.throws(() => resolveLifecycleBProfitRule({ targetStore: store }, rules),
      { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
  }
  assert.throws(() => resolveLifecycleBProfitRule({ targetStore: "miska" }, { ozonDandanshu: rules.ozonDandanshu }),
    { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
});

test("准备后重验当前成本，规则变化拒绝且不修改输入", () => {
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF, lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  const rules = currentCostRules();
  const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules));
  assert.deepEqual(assertLifecycleBCostsCurrent({ candidate, rules, otherCosts }), otherCosts);
  rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 8;
  const before = structuredClone({ candidate, rules, otherCosts });
  assert.throws(() => assertLifecycleBCostsCurrent({ candidate, rules, otherCosts }), { code: "B_COST_POLICY_CHANGED" });
  assert.deepEqual({ candidate, rules, otherCosts }, before);
  assert.equal(otherCosts.packagingRmb, 1.5);
  assert.equal(otherCosts.fixedOtherRmb, 0);
  assert.throws(() => assertLifecycleBCostsCurrent({ candidate, rules: {}, otherCosts }),
    { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
  assert.throws(() => assertLifecycleBCostsCurrent({ candidate: { ...candidate, packagingCostRmb: null }, rules, otherCosts }),
    { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
});


test("成本就绪与技术证据分离，完整政策就绪且不输出政策内容", () => {
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF,
    lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  const rules = currentCostRules();
  const before = structuredClone({ candidate, rules });
  assert.deepEqual(inspectLifecycleBCostReadiness({ candidate, rules, asOf: "2026-09-09T00:00:00.000Z" }),
    { ready: true, missing: [], code: null });
  assert.deepEqual({ candidate, rules }, before);
});

test("成本就绪区分未知、缺政策、已含结算、范围与有效期缺口", () => {
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF,
    lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  for (const [mutate, code, message] of [
    [rules => { delete rules.ozonDandanshu.costPolicySnapshot; }, "B_COST_POLICY_INVALID", /完整成本政策未登记/],
    [rules => { delete rules.ozonDandanshu; }, "B_EVIDENCE_COST_POLICY_INCOMPLETE", /店铺成本规则/],
    [rules => { Object.assign(rules.ozonDandanshu.costPolicySnapshot.items.taxRate, { status: "unknown", value: null }); }, "B_COST_POLICY_UNKNOWN", /税费适用性或数值尚未核实/],
    [rules => { rules.ozonDandanshu.costPolicySnapshot.items.withdrawalFeeRate.status = "included_in_settlement"; }, "B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS", /已含结算/],
    [rules => { rules.ozonDandanshu.costPolicySnapshot.scope.salesScheme = "other"; }, "B_COST_POLICY_SCOPE_MISMATCH", /销售模式/],
    [rules => { rules.ozonDandanshu.costPolicySnapshot.effectiveTo = "2026-09-09T00:00:00.000Z"; }, "B_COST_POLICY_EXPIRED", /到期/],
    [rules => { rules.ozonDandanshu.costPolicySnapshot.effectiveFrom = "2026-09-10T00:00:00.000Z"; }, "B_COST_POLICY_NOT_EFFECTIVE", /尚未生效/]
  ]) {
    const rules = currentCostRules(); mutate(rules);
    const before = structuredClone({ candidate, rules });
    const result = inspectLifecycleBCostReadiness({ candidate, rules, asOf: "2026-09-09T00:00:00.000Z" });
    assert.equal(result.ready, false); assert.equal(result.code, code);
    assert.equal(result.missing.length, 1); assert.match(result.missing[0], message);
    assert.deepEqual({ candidate, rules }, before);
  }
});

test("成本就绪要求显式时间，未知运行错误原样传播", () => {
  for (const asOf of [undefined, null, "invalid", "2026-02-30T00:00:00.000Z"]) {
    assert.throws(() => inspectLifecycleBCostReadiness({ candidate: {}, rules: {}, asOf }), /B_COST_READINESS_TIME_INVALID/);
  }
  const failure = new Error("synthetic unexpected runtime failure");
  const rules = Object.defineProperty({}, "ozonDandanshu", { get() { throw failure; } });
  assert.throws(() => inspectLifecycleBCostReadiness({ candidate: { targetStore: "dandanshu" }, rules,
    asOf: "2026-09-09T00:00:00.000Z" }), error => error === failure);
});


test("费用缺口只显示固定中文项目名称，不回显来源字符串", () => {
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF,
    lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  const rules = currentCostRules();
  for (const key of ["withdrawalFeeRate", "taxRate"]) Object.assign(rules.ozonDandanshu.costPolicySnapshot.items[key], {
    status: "unknown", value: null, evidenceRef: "synthetic-private-source-not-for-display" });
  const result = inspectLifecycleBCostReadiness({ candidate, rules, asOf: "2026-09-09T00:00:00.000Z" });
  assert.deepEqual(result.missing, ["提现费适用性或数值尚未核实。", "税费适用性或数值尚未核实。"]);
  assert.equal(JSON.stringify(result).includes("synthetic-private-source"), false);
});

test("店铺成本模板按当前范围实例化为快照，显式快照优先，范围不符不实例化也不回退", () => {
  const asOf = "2026-09-09T12:00:00.000Z";
  const candidate = { targetStore: "dandanshu", storeRef: SYNTHETIC_STORE_REF, lifecycleEvidenceContextV11: { salesScheme: "rfbs" }, packagingCostRmb: 1.5 };
  const rules = { ozonDandanshu: structuredClone(DEFAULT_RULES.ozonDandanshu) };
  assert.equal(rules.ozonDandanshu.costPolicySnapshot, undefined);
  const costs = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf });
  assert.equal(costs.pricingPolicyVersion, DEFAULT_RULES.ozonDandanshu.costPolicy.policyVersion);
  assert.deepEqual(costs.costPolicySnapshot.scope, { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, salesScheme: "rfbs" });
  assert.equal(costs.costPolicySnapshot.schemaVersion, "b-cost-policy-snapshot-v1");
  assert.deepEqual(costs.costPolicySnapshot.items, DEFAULT_RULES.ozonDandanshu.costPolicy.items);
  assert.deepEqual([costs.acquiringRate, costs.taxRate, costs.otherRate, costs.fixedOtherRmb], [0, 0, 0, 0]);
  assert.deepEqual(inspectLifecycleBCostReadiness({ candidate, rules, asOf }), { ready: true, missing: [], code: null });
  assert.deepEqual(assertLifecycleBCostsCurrent({ candidate, rules, otherCosts: costs, asOf }), costs);
  const fbo = { ...candidate, lifecycleEvidenceContextV11: { salesScheme: "fbo" } };
  assert.throws(() => buildLifecycleBExplicitOtherCosts(fbo, rules.ozonDandanshu, { asOf }), { code: "B_COST_POLICY_SCOPE_MISMATCH" });
  assert.equal(inspectLifecycleBCostReadiness({ candidate: fbo, rules, asOf }).code, "B_COST_POLICY_SCOPE_MISMATCH");
  assert.throws(() => buildLifecycleBExplicitOtherCosts({ ...candidate, storeRef: null }, rules.ozonDandanshu, { asOf }), { code: "B_COST_POLICY_SCOPE_MISMATCH" });
  const explicit = currentCostRules();
  explicit.ozonDandanshu.costPolicy = structuredClone(DEFAULT_RULES.ozonDandanshu.costPolicy);
  const explicitCosts = buildLifecycleBExplicitOtherCosts(candidate, explicit.ozonDandanshu, { asOf });
  assert.equal(explicitCosts.pricingPolicyVersion, explicit.ozonDandanshu.costPolicySnapshot.policyVersion);
  assert.notEqual(explicitCosts.pricingPolicyVersion, DEFAULT_RULES.ozonDandanshu.costPolicy.policyVersion);
});
