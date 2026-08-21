import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLifecycleBExplicitOtherCosts,
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

test("其他成本只从当前商品与项目规则显式组成", () => {
  assert.deepEqual(buildLifecycleBExplicitOtherCosts(
    { packagingCostRmb: 1.5 },
    {
      labelCostRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingReserveRate: 0,
      returnOpsReserveRate: 0.05,
      damageLossReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceRoundRmb: 1,
      thresholdPolicy: "either"
    }
  ), {
    packagingRmb: 1.5,
    labelRmb: 1.5,
    fixedOtherRmb: 0,
    advertisingRate: 0,
    returnReserveRate: 0.05,
    damageReserveRate: 0.05,
    withdrawalFeeRate: 0.02,
    targetMarginRate: 0.15,
    minimumUnitProfitRmb: 20,
    priceIncrementCny: 1,
    thresholdLogic: "any",
    pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
  });
  assert.throws(
    () => buildLifecycleBExplicitOtherCosts({ packagingCostRmb: null }, {}),
    /B_EVIDENCE_COST_POLICY_INCOMPLETE/
  );
});

test("四类证据先全量校验再原子替换，失败不留下半套结果", () => {
  const old = pack("exchange_rate", { pair: "RUB/CNY" }, { rubPerCny: 11.2 });
  old.id = "old-rate";
  old.scopeKey = 'exchange_rate|{"pair":"RUB/CNY"}';
  const data = { evidencePacks: [old] };
  const valid = [
    pack("commission", { platform: "ozon", store: "dandanshu", category: "ozon:1:2", salesScheme: "rfbs" }, {
      commissionRate: 0.14,
      otherCosts: { packagingRmb: 1.5, labelRmb: 1.5, fixedOtherRmb: 0, advertisingRate: 0, returnReserveRate: 0.05, damageReserveRate: 0.05, withdrawalFeeRate: 0.02, targetMarginRate: 0.15, minimumUnitProfitRmb: 20, priceIncrementCny: 1, thresholdLogic: "any", pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1" }
    }),
    pack("logistics_tariff", { route: "GUOO Economy Small", ruleVersion: "guoo-2026-07-20" }, {
      chargeableWeightRule: "actual_weight", perKgRmb: 28.1, perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0, weightRoundingRule: "none", weightRoundingKg: null
    }),
    pack("exchange_rate", { pair: "RUB/CNY" }, { rubPerCny: 11.3 }),
    pack("schema", { platform: "ozon", store: "dandanshu", category: "ozon:1:2", ruleVersion: "ozon-current" }, {
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
