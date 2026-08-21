import test from "node:test";
import assert from "node:assert/strict";
import {
  createLifecycleBInputBundle,
  inspectLifecycleBInputReadiness,
  resolveLifecycleEvidenceContext,
  validateLifecycleBInputBundle,
  validateLifecycleEvidenceData
} from "../lib/lifecycle-b-input-bundle.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";

const createdAt = "2026-08-18T02:00:00.000Z";

function candidate() {
  return {
    id: "TEST-A-ONE-CARD",
    dataRevision: 7,
    targetStore: "dandanshu",
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

function normalizedSubmission() {
  return {
    supplierConfirmation: {
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 }
    }
  };
}

function packs() {
  const common = {
    status: "active",
    sourceType: "isolated_test",
    sourceRef: "fixture:lifecycle-b-evidence",
    checkedAt: createdAt,
    expiresAt: "2026-08-19T02:00:00.000Z"
  };
  return [{
    ...common,
    id: "EP-COMMISSION",
    kind: "commission",
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
        pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION
      }
    }
  }, {
    ...common,
    id: "EP-LOGISTICS",
    kind: "logistics_tariff",
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    evidenceData: {
      chargeableWeightRule: "max_actual_volume",
      perKgRmb: 20,
      perParcelRmb: 10,
      volumeDivisorCm3PerKg: 6000,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  }, {
    ...common,
    id: "EP-FX",
    kind: "exchange_rate",
    scope: { pair: "RUB/CNY" },
    evidenceData: { rubPerCny: 12 }
  }, {
    ...common,
    id: "EP-SCHEMA",
    kind: "schema",
    scope: { platform: "ozon", store: "dandanshu", category: "music-box", ruleVersion: "ozon-music-box-2026-08-18" },
    evidenceData: { schemaRevision: "ozon-music-box-2026-08-18", requiredFields: [] }
  }];
}

test("四类精确证据包可冻结为B输入并按SKU重量尺寸计算运费", () => {
  const source = candidate();
  const before = JSON.stringify(source);
  const readiness = inspectLifecycleBInputReadiness({ candidate: source, evidencePacks: packs(), asOf: createdAt });
  assert.equal(readiness.ready, true);
  const bundle = createLifecycleBInputBundle({
    candidate: source,
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  assert.equal(bundle.browserSupplied, false);
  assert.deepEqual(bundle.sourcePackIds, ["EP-COMMISSION", "EP-LOGISTICS", "EP-FX", "EP-SCHEMA"]);
  assert.equal(bundle.logisticsEvidence.actualWeightKg, 0.4);
  assert.equal(bundle.logisticsEvidence.volumeWeightKg, 0.168);
  assert.equal(bundle.logisticsEvidence.chargeableWeightKg, 0.4);
  assert.equal(bundle.logisticsEvidence.amountRmb, 18);
  assert.equal(bundle.platformSchemaEvidence.store, "dandanshu");
  assert.equal(JSON.stringify(source), before);
});

test("过期、适用键不一致或只有摘要的证据包均不能作为B输入", () => {
  const expired = packs();
  expired[0].expiresAt = "2026-08-18T02:30:00.000Z";
  let readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: expired, asOf: "2026-08-18T03:00:00.000Z" });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前平台佣金与其他成本证据"]);
  assert.equal(readiness.fields[0].status, "expired");

  const wrongStore = packs();
  wrongStore[3].scope.store = "miska";
  readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: wrongStore, asOf: createdAt });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前平台Schema证据"]);
  assert.equal(readiness.fields[3].status, "scope_mismatch");

  const metadataOnly = packs();
  delete metadataOnly[1].evidenceData;
  readiness = inspectLifecycleBInputReadiness({ candidate: candidate(), evidencePacks: metadataOnly, asOf: createdAt });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, ["当前国际物流资费规则"]);
  assert.equal(readiness.fields[1].status, "metadata_only");
});

test("适用范围缺失或与目标店铺冲突时不猜测并阻止证据匹配", () => {
  const missingContext = candidate();
  delete missingContext.lifecycleEvidenceContextV11.salesScheme;
  const missing = resolveLifecycleEvidenceContext(missingContext);
  assert.equal(missing.ready, false);
  assert.match(missing.missing.join("、"), /销售模式/);
  const readiness = inspectLifecycleBInputReadiness({ candidate: missingContext, evidencePacks: packs(), asOf: createdAt });
  assert.equal(readiness.contextReady, false);
  assert.ok(readiness.fields.every((field) => field.status === "waiting_context"));

  const conflict = candidate();
  conflict.lifecycleEvidenceContextV11.store = "miska";
  const resolved = resolveLifecycleEvidenceContext(conflict);
  assert.equal(resolved.ready, false);
  assert.match(resolved.missing.join("、"), /店铺.*冲突/);
});

test("同一适用范围的系统证据可跨SKU复用，但运费仍按各SKU包装独立计算", () => {
  const first = candidate();
  const second = { ...candidate(), id: "TEST-A-SECOND-SKU", dataRevision: 3 };
  const firstBundle = createLifecycleBInputBundle({
    candidate: first,
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  const secondBundle = createLifecycleBInputBundle({
    candidate: second,
    evidencePacks: packs(),
    normalizedSubmission: {
      supplierConfirmation: {
        weightKg: 0.8,
        dimensionsCm: { length: 30, width: 20, height: 10 }
      }
    },
    createdAt
  });
  assert.deepEqual(firstBundle.sourcePackIds, secondBundle.sourcePackIds);
  assert.notEqual(firstBundle.logisticsEvidence.chargeableWeightKg, secondBundle.logisticsEvidence.chargeableWeightKg);
  assert.notEqual(firstBundle.logisticsEvidence.amountRmb, secondBundle.logisticsEvidence.amountRmb);
  assert.equal(firstBundle.sourceCandidateId, "TEST-A-ONE-CARD");
  assert.equal(secondBundle.sourceCandidateId, "TEST-A-SECOND-SKU");
});

test("运费规则缺公式或证据包与主人确认包装不一致时明确拒绝", () => {
  const invalid = validateLifecycleEvidenceData("logistics_tariff", {
    chargeableWeightRule: "max_actual_volume",
    perKgRmb: 20,
    perParcelRmb: 10,
    minimumChargeableWeightKg: 0,
    weightRoundingKg: 0.1
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.map((item) => item.path).join(","), /volumeDivisorCm3PerKg/);

  const bundle = createLifecycleBInputBundle({
    candidate: candidate(),
    evidencePacks: packs(),
    normalizedSubmission: normalizedSubmission(),
    createdAt
  });
  const validation = validateLifecycleBInputBundle(structuredClone(bundle), {
    candidate: candidate(),
    normalizedSubmission: { supplierConfirmation: { weightKg: 0.5, dimensionsCm: { length: 12, width: 12, height: 7 } } }
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.map((item) => item.path).join(","), /packagingSnapshot/);
});
