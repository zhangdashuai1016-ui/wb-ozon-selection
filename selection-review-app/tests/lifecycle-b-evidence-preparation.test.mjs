import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLifecycleBEvidencePreparationPlan,
  runLifecycleBEvidencePreparation
} from "../lib/lifecycle-b-evidence-preparation.mjs";

const plannedAt = "2026-08-18T06:30:00.000Z";
const preparedAt = "2026-08-18T06:31:00.000Z";
const expiresAt = "2026-08-19T06:30:00.000Z";

function candidate(id = "EVIDENCE-PREP-SKU-1") {
  return {
    id,
    dataRevision: 4,
    targetStore: "dandanshu",
    workflowStatus: "awaiting_user_direction",
    lifecycleEvidenceContextV11: {
      platform: "ozon",
      store: "dandanshu",
      category: "music-box",
      salesScheme: "rfbs",
      route: "guoo-economy-small",
      logisticsRuleVersion: "guoo-2026-07-20",
      exchangePair: "RUB/CNY",
      schemaRuleVersion: "ozon-music-box-2026-08-18"
    }
  };
}

function pack(kind, id = `PACK-${kind}`) {
  const shared = {
    id,
    kind,
    status: "active",
    sourceType: "isolated_test",
    sourceRef: `fixture:${kind}`,
    checkedAt: plannedAt,
    expiresAt
  };
  if (kind === "commission") return {
    ...shared,
    scope: { platform: "ozon", store: "dandanshu", category: "music-box", salesScheme: "rfbs" },
    evidenceData: {
      commissionRate: 0.14,
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    }
  };
  if (kind === "logistics_tariff") return {
    ...shared,
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    evidenceData: {
      chargeableWeightRule: "actual_weight",
      perKgRmb: 28.1,
      perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  };
  if (kind === "exchange_rate") return {
    ...shared,
    scope: { pair: "RUB/CNY" },
    evidenceData: { rubPerCny: 12 }
  };
  return {
    ...shared,
    scope: { platform: "ozon", store: "dandanshu", category: "music-box", ruleVersion: "ozon-music-box-2026-08-18" },
    evidenceData: { schemaRevision: "ozon-music-box-2026-08-18", requiredFields: [] }
  };
}

function allPacks() {
  return ["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => pack(kind));
}

test("四类当前证据全部复用时不调用任何提供器", async () => {
  const source = candidate();
  const before = JSON.stringify(source);
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate: source, evidencePacks: allPacks(), plannedAt });
  assert.equal(plan.status, "ready_from_reuse");
  assert.ok(plan.actions.every((action) => action.action === "reuse"));
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: allPacks(),
    providers: {},
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.equal(JSON.stringify(source), before);
});

test("计划时可复用但完成前已过期时停止，不把时效漂移标成完成", async () => {
  const expiring = allPacks();
  expiring[0].expiresAt = "2026-08-18T06:30:30.000Z";
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: expiring,
    providers: {},
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "reuse_validity_drift");
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.equal(result.businessStateEffect, "unchanged");
});

test("四类缺失时各提供器只调用一次并形成全有或全无的提交集合", async () => {
  const calls = [];
  const providers = Object.fromEntries(allPacks().map((item) => [
    item.kind,
    async (request) => {
      calls.push({ kind: item.kind, request });
      return pack(item.kind);
    }
  ]));
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: [],
    providers,
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "completed");
  assert.equal(result.finalReadiness.ready, true);
  assert.equal(result.evidencePacksToCommit.length, 4);
  assert.deepEqual(calls.map((item) => item.kind), ["commission", "logistics_tariff", "exchange_rate", "schema"]);
  assert.ok(calls.every((item) => item.request.maximumAttempts === 1 && item.request.readOnly === true));
  assert.ok(result.providerCalls.every((call) => call.attempt === 1 && call.status === "completed"));
  assert.equal(result.automaticRetryAttempted, false);
});

test("任一提供器失败立即停止并丢弃本轮已准备结果，不形成半套提交", async () => {
  const calls = [];
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: [],
    providers: {
      commission: async () => { calls.push("commission"); return pack("commission"); },
      logistics_tariff: async () => { calls.push("logistics_tariff"); throw new Error("GUOO规则文件不可读"); },
      exchange_rate: async () => { calls.push("exchange_rate"); return pack("exchange_rate"); },
      schema: async () => { calls.push("schema"); return pack("schema"); }
    },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["commission", "logistics_tariff"]);
  assert.deepEqual(result.evidencePacksToCommit, []);
  assert.deepEqual(result.discardedEvidencePackIds, ["PACK-commission"]);
  assert.equal(result.failure.layer, "provider:logistics_tariff");
  assert.equal(result.businessStateEffect, "unchanged");
  assert.equal(result.automaticRetryAttempted, false);
});

test("提供器返回错店铺证据时停止，不用错误范围兜底", async () => {
  const wrong = pack("commission");
  wrong.scope.store = "miska";
  const result = await runLifecycleBEvidencePreparation({
    candidate: candidate(),
    evidencePacks: allPacks().slice(1),
    providers: { commission: async () => wrong },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "provider_result:commission");
  assert.match(result.failure.reason, /适用范围不一致/);
  assert.deepEqual(result.evidencePacksToCommit, []);
});

test("证据上下文不完整时零调用并保持商品业务状态不变", async () => {
  const source = candidate();
  delete source.lifecycleEvidenceContextV11.category;
  const before = JSON.stringify(source);
  let called = 0;
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: [],
    providers: { commission: async () => { called += 1; return pack("commission"); } },
    plannedAt,
    preparedAt
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.layer, "evidence_context");
  assert.equal(called, 0);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.businessStateEffect, "unchanged");
});

test("不同SKU在相同适用范围内复用同一证据包且互不修改", async () => {
  const shared = allPacks();
  const first = await runLifecycleBEvidencePreparation({
    candidate: candidate("SKU-A"), evidencePacks: shared, providers: {}, plannedAt, preparedAt
  });
  const second = await runLifecycleBEvidencePreparation({
    candidate: candidate("SKU-B"), evidencePacks: shared, providers: {}, plannedAt, preparedAt
  });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.deepEqual(first.plan.actions.map((action) => action.evidencePackId), second.plan.actions.map((action) => action.evidencePackId));
  assert.deepEqual(first.providerCalls, []);
  assert.deepEqual(second.providerCalls, []);
});

test("真实读取完成时间由读取后时钟冻结，不要求调用方预猜未来时间", async () => {
  const source = candidate();
  const times = [
    "2026-08-18T02:00:01.000Z",
    "2026-08-18T02:00:02.000Z",
    "2026-08-18T02:00:03.000Z",
    "2026-08-18T02:00:04.000Z",
    "2026-08-18T02:00:05.000Z"
  ];
  let clockIndex = 0;
  const providers = Object.fromEntries(allPacks().map((pack) => [
    pack.kind,
    async () => ({ ...structuredClone(pack), checkedAt: "2026-08-18T02:00:00.500Z" })
  ]));
  const result = await runLifecycleBEvidencePreparation({
    candidate: source,
    evidencePacks: [],
    providers,
    plannedAt: "2026-08-18T02:00:00.000Z",
    clock: () => new Date(times[Math.min(clockIndex++, times.length - 1)])
  });
  assert.equal(result.status, "completed");
  assert.equal(result.evidencePacksToCommit.length, 4);
});
