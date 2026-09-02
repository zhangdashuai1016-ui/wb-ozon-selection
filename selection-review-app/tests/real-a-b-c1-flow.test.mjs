import test from "node:test";
import assert from "node:assert/strict";
import { createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { runRealAConfirmationToBAndC1 } from "../lib/real-a-b-c1-flow.mjs";
import { buildRealAConfirmationCard } from "../lib/real-a-confirmation-card.mjs";

const confirmedAt = "2026-08-18T02:00:00.000Z";

async function candidate() {
  const value = createMusicBoxCandidate();
  delete value.lifecycleV11;
  value.workflowStatus = "codex_processing";
  value.listingHandoff = null;
  return value;
}

function submission(card) {
  return {
    decision: "confirm",
    salesReview: {
      snapshotId: card.salesReview.snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

function evidencePacks({ logistics = {} } = {}) {
  return [{
    id: "fees:ozon:dandanshu:music-box:2026-08-18",
    kind: "commission",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", category: "music-box", salesScheme: "rfbs" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
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
    },
  }, {
    id: "logistics:guoo:music-box:2026-08-18",
    kind: "logistics_tariff",
    status: "active",
    scope: { route: "guoo-economy-small", ruleVersion: "guoo-2026-07-20" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      chargeableWeightRule: "actual_weight",
      perKgRmb: 0,
      perParcelRmb: 18,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1,
      ...logistics
    }
  }, {
    id: "fx:official:2026-08-18:RUB-CNY",
    kind: "exchange_rate",
    status: "active",
    scope: { pair: "RUB/CNY" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      rubPerCny: 12
    }
  }, {
    id: "schema:ozon:dandanshu:music-box:2026-08-18",
    kind: "schema",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", category: "music-box", ruleVersion: "schema-2026-08-18" },
    checkedAt: confirmedAt,
    expiresAt: "2026-08-19T02:00:00.000Z",
    evidenceData: {
      schemaRevision: "2026-08-18",
      requiredFields: []
    }
  }].map((pack) => ({
    ...pack,
    sourceType: "isolated_test",
    sourceRef: `fixture:${pack.id}`
  }));
}

function addEvidenceContext(source) {
  source.lifecycleEvidenceContextV11 = {
    platform: "ozon",
    store: "dandanshu",
    category: "music-box",
    salesScheme: "rfbs",
    route: "guoo-economy-small",
    logisticsRuleVersion: "guoo-2026-07-20",
    exchangePair: "RUB/CNY",
    schemaRuleVersion: "schema-2026-08-18"
  };
  return source;
}

test("真实A一次确认原子生成Opportunity、SKU、B利润和唯一C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const before = JSON.stringify(source);
  const card = buildRealAConfirmationCard(source);
  const result = runRealAConfirmationToBAndC1({
    candidate: source,
    submission: submission(card),
    evidencePacks: evidencePacks(),
    confirmedAt
  });

  assert.equal(result.decision, "confirm");
  assert.equal(result.opportunityPackage.businessResult, "passed");
  assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
  assert.equal(result.skuPackage.supplierSkuId, "SKU-SEWING-MACHINE-01");
  assert.equal(result.profitModel.result, "passed");
  assert.equal(result.profitModel.thresholdVersion, "profit-threshold-v1.2-15pct-or-20cny");
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(result.c1Handoff.trigger, "b_passed_auto_c1");
  assert.equal(result.c1Handoff.uniqueOwner, "listing_task");
  assert.equal(result.c1Handoff.selectionTaskStopped, true);
  assert.equal(result.taskDispatches, 0);
  assert.deepEqual(result.externalAccesses, []);
  assert.equal(result.platformWrites, 0);
  assert.equal(JSON.stringify(source), before);
});

test("系统B证据不齐时整轮拒绝且不产生半成品生命周期", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const before = JSON.stringify(source);
  assert.throws(() => runRealAConfirmationToBAndC1({
    candidate: source,
    submission: submission(card),
    evidencePacks: evidencePacks().slice(0, 1),
    confirmedAt
  }), /REAL_A_SYSTEM_EVIDENCE_GAP.*国际物流.*汇率.*Schema/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.lifecycleV11?.skuPackage, undefined);
});

test("B未达利润门槛时不创建C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const evidence = evidencePacks({ logistics: { perParcelRmb: 105 } });
  const result = runRealAConfirmationToBAndC1({
    candidate: source,
    submission: submission(card),
    evidencePacks: evidence,
    confirmedAt
  });
  assert.equal(result.profitModel.result, "rejected");
  assert.equal(result.skuPackage.businessPhase, "B");
  assert.equal(result.skuPackage.c1ProductPlan, null);
  assert.equal(result.c1Handoff, null);
  assert.equal(result.uniqueOwner, "none");
});

test("同一候选已有SKU生命周期时禁止再次确认", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  source.lifecycleV11 = { ...(source.lifecycleV11 || {}), skuPackage: { skuPackageId: "existing" } };
  assert.throws(() => runRealAConfirmationToBAndC1({
    candidate: source,
    submission: submission(card),
    evidencePacks: evidencePacks(),
    confirmedAt
  }), /REAL_A_ALREADY_CONFIRMED/);
});
