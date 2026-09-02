import test from "node:test";
import assert from "node:assert/strict";
import { createTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { adaptLegacyCandidateToOpportunity } from "../lib/legacy-candidate-adapter.mjs";
import {
  createSkuLifecyclePackage,
  runBProfitModel
} from "../lib/product-lifecycle-b-flow.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { attachPassedMarketAssessment } from "./helpers/market-assessment-fixture.mjs";

const TEST_SKU_ID = "CX-20260803-010";
const CALCULATED_AT = "2026-08-12T12:00:00.000Z";

async function currentCandidate() {
  const candidate = createTrainCandidate({ lifecycle: false });
  // This B regression freezes the corrected 0.21 kg quote, not the initial 0.3 kg quote.
  candidate.packedWeightKg = 0.21;
  candidate.codexReview.cStageReview.logistics.billableWeightKg = 0.21;
  candidate.codexReview.cStageReview.logistics.freightRmb = 23.87;
  return candidate;
}

function createTestInputs(candidate, opportunityPackage) {
  const supplier = opportunityPackage.supplierOptions[0];
  const skuPackage = createSkuLifecyclePackage({
    opportunityPackage,
    confirmedSupplierSelection: {
      status: "confirmed",
      confirmedBy: "owner_existing_record",
      confirmedAt: "2026-08-12T02:30:00.000Z",
      supplierOptionId: supplier.supplierOptionId,
      supplierSkuId: supplier.supplierSkuId,
      variantKey: supplier.variant
    },
    skuPackageId: `sku-lifecycle:${candidate.id}:${supplier.supplierSkuId}`,
    readbackLimits: { maxAutomaticAttempts: 2, maxConsecutiveSameFailure: 1 },
    createdAt: "2026-08-12T11:59:00.000Z"
  });
  return {
    opportunityPackage,
    skuPackage,
    priceSelection: {
      salesSnapshotId: opportunityPackage.salesSnapshots[0].snapshotId,
      pricePath: "marketEvidence.exactTarget.lowestOtherOfferRub",
      currency: "RUB"
    },
    feeEvidence: {
      evidenceId: `fees:${candidate.id}:revision-${candidate.dataRevision}`,
      sourceDataRevision: candidate.dataRevision,
      commissionRate: candidate.codexReview.cStageReview.commission.rate,
      commissionEvidenceType: candidate.codexReview.cStageReview.commission.sourceType,
      internationalLogisticsRmb: candidate.codexReview.cStageReview.logistics.freightRmb,
      packagingRmb: candidate.packagingCostRmb,
      labelRmb: candidate.codexReview.completeCost.labelRmb,
      advertisingReserveRate: candidate.codexReview.completeCost.advertisingReserveRate,
      returnReserveRate: candidate.codexReview.completeCost.returnOpsReserveRate,
      damageReserveRate: candidate.codexReview.completeCost.damageLossReserveRate,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1",
      otherCostRmb: 0
    },
    exchangeRateEvidence: {
      evidenceId: `fx:${candidate.codexReview.exchangeRate.rateDate}:RUB-CNY`,
      rubPerCny: candidate.codexReview.exchangeRate.rubPerCny,
      sourceType: candidate.codexReview.exchangeRate.sourceType,
      checkedAt: candidate.codexReview.exchangeRate.checkedAt
    },
    calculatedAt: CALCULATED_AT
  };
}

test("single SKU flows from OpportunityPackage to SkuLifecyclePackage and B ProfitModel", async () => {
  const candidate = await currentCandidate();
  const candidateBefore = JSON.stringify(candidate);
  const opportunityPackage = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunityPackage.salesSnapshots[0].platform = "ozon";
  opportunityPackage.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunityPackage.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunityPackage);
  const inputs = createTestInputs(candidate, opportunityPackage);
  const opportunityBefore = JSON.stringify(opportunityPackage);
  const skuBefore = JSON.stringify(inputs.skuPackage);

  const result = runBProfitModel(inputs);

  assert.equal(result.skuPackage.parentOpportunityId, TEST_SKU_ID);
  assert.equal(result.skuPackage.businessPhase, "B", "B完成不得自动进入C");
  assert.equal(result.skuPackage.businessResult, "passed");
  assert.equal(result.skuPackage.technicalStatus, "completed");
  assert.equal(result.skuPackage.activeProfitModelVersion, "profit-v1");
  assert.equal(validateSkuLifecyclePackage(result.skuPackage).valid, true);
  assert.equal(JSON.stringify(candidate), candidateBefore, "旧候选不得修改");
  assert.equal(JSON.stringify(opportunityPackage), opportunityBefore, "OpportunityPackage上游快照不得修改");
  assert.equal(JSON.stringify(inputs.skuPackage), skuBefore, "初始SKU包不得被覆盖");
});

test("B reads the exact upstream revisions and exposes a complete evidence trace", async () => {
  const candidate = await currentCandidate();
  const opportunityPackage = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunityPackage.salesSnapshots[0].platform = "ozon";
  opportunityPackage.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunityPackage.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunityPackage);
  const inputs = createTestInputs(candidate, opportunityPackage);
  const result = runBProfitModel(inputs);
  const model = result.profitModel;

  assert.equal(opportunityPackage.dataRevision, candidate.dataRevision);
  assert.equal(opportunityPackage.salesSnapshots[0].sourceDataRevision, candidate.dataRevision);
  assert.equal(result.skuPackage.selectedSupplySnapshot.sourceOpportunityRevision, candidate.dataRevision);
  assert.equal(result.skuPackage.selectedSupplySnapshot.data.sourceDataRevision, candidate.dataRevision);
  assert.deepEqual(model.inputSnapshotRefs, [
    "legacy-sales:CX-20260803-010",
    "legacy-supply:CX-20260803-010",
    `fees:CX-20260803-010:revision-${candidate.dataRevision}`,
    "fx:2026-08-07:RUB-CNY"
  ]);
  assert.deepEqual(model.inputs.salesPrice, {
    value: 1831,
    currency: "RUB",
    sourceRef: "legacy-sales:CX-20260803-010",
    sourcePath: "marketAssessment.recommendedSalePrice.amount"
  });
  assert.deepEqual(model.inputs.purchaseCost, {
    value: 41,
    currency: "CNY",
    sourceRef: "legacy-supply:CX-20260803-010"
  });
  assert.equal(model.inputs.logistics.value, candidate.codexReview.cStageReview.logistics.freightRmb);
  assert.equal(model.inputs.commission.rate, 0.14);
  assert.equal(model.inputs.exchangeRate.rubPerCny, 12.0637);
});

test("B independently generates the frozen v1.1 profit output from four upstream inputs", async () => {
  const candidate = await currentCandidate();
  const alteredHistory = structuredClone(candidate);
  alteredHistory.codexReview.profitCalculation.targetPriceRmb = 99999;
  alteredHistory.codexReview.profitCalculation.unitProfitRmb = -99999;
  alteredHistory.codexReview.profitCalculation.marginRate = -1;
  const opportunityPackage = structuredClone(adaptLegacyCandidateToOpportunity(alteredHistory));
  opportunityPackage.salesSnapshots[0].platform = "ozon";
  opportunityPackage.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunityPackage.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunityPackage);
  const result = runBProfitModel(createTestInputs(alteredHistory, opportunityPackage));

  assert.equal(result.profitModel.recommendedSalePriceCny, 151.78);
  assert.equal(result.profitModel.sellerRevenueAfterCommissionCny, 130.53);
  assert.equal(result.profitModel.unitProfitRmb, 44.45);
  assert.equal(result.profitModel.profitMargin, 0.2929);
  assert.equal(result.profitModel.priceFloors.qualifyingFloorCny, 116);
  assert.equal(result.profitModel.result, "passed");
  assert.equal(result.profitModel.profitModelVersion, "profit-v1");
});

test("B completes with network access disabled and does not request already supplied fields", async () => {
  const candidate = await currentCandidate();
  const opportunityPackage = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunityPackage.salesSnapshots[0].platform = "ozon";
  opportunityPackage.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunityPackage.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunityPackage);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("B阶段禁止访问外部平台");
  };
  try {
    const result = runBProfitModel(createTestInputs(candidate, opportunityPackage));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.profitModel.externalAccesses, []);
    assert.deepEqual(result.profitModel.requestedExistingFields, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing upstream evidence stops as a data gap without guessing or entering C", async () => {
  const candidate = await currentCandidate();
  const opportunityPackage = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunityPackage.salesSnapshots[0].platform = "ozon";
  opportunityPackage.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunityPackage.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunityPackage);
  const inputs = createTestInputs(candidate, opportunityPackage);
  inputs.feeEvidence = { ...inputs.feeEvidence, internationalLogisticsRmb: "unknown" };
  assert.throws(() => runBProfitModel(inputs), /B_INPUT_GAP: 缺少国际物流/);
  assert.equal(inputs.skuPackage.businessPhase, "B");
  assert.equal(inputs.skuPackage.profitModels.length, 0);
});
