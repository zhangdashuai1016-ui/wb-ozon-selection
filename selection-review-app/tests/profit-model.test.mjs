import { createSyntheticBCostPolicy } from "./fixtures/b-cost-policy-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adaptLegacyCandidateToOpportunity } from "../lib/legacy-candidate-adapter.mjs";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import { adapt1688CaptureToSupplierOption } from "../lib/supplier-option.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "../lib/supplier-selection-flow.mjs";
import {
  PROFIT_THRESHOLD_VERSION,
  runSkuProfitModel,
  validateProfitModel
} from "../lib/profit-model.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { attachPassedMarketAssessment } from "./helpers/market-assessment-fixture.mjs";
import { createTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { dailySummary } from "../lib/workflow.mjs";
import { productionAuthorizationInputFixture } from "./helpers/c2-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";

const VARIANT = "规格:豪华小火车";

async function preparedInputs(candidate = createTrainCandidate({ lifecycle: false })) {
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.salesSnapshots[0].platform = "ozon";
  opportunity.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunity.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  attachPassedMarketAssessment(opportunity);
  const evidence = sanitize1688Evidence({
    offerId: "712421624571",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
    observedAt: "2026-08-12T12:00:00.000Z",
    title: "机械发条木质火车",
    supplierSalesEvidence: { salesVolume: 500, stabilityScore: 80 },
    supplierBadges: ["牛头供应商"],
    skus: [{
      sourceSkuId: "4993364145574",
      propPath: VARIANT,
      attributes: { 规格: "豪华小火车" },
      priceCny: null,
      priceSource: null,
      stock: null,
      stockSource: null,
      imageUrl: null
    }]
  }, "712421624571");
  evidence.supplierSalesEvidence = { salesVolume: 500, stabilityScore: 80 };
  evidence.supplierBadges = ["牛头供应商"];
  evidence.skus[0].weight = { value: candidate.packedWeightKg, unit: "kg" };
  evidence.skus[0].dimensions = { ...candidate.dimensionsCm, unit: "cm" };
  evidence.skus[0].material = "DVP木纤维板";
  evidence.skus[0].powerProfile = { powered: false };
  const option = structuredClone(adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8"
  }));
  option.supplierSalesEvidence = evidence.supplierSalesEvidence;
  option.supplierBadges = evidence.supplierBadges;
  option.supplierSkus[0].actualPurchaseCost = candidate.purchasePriceRmb;

  opportunity.businessPhase = "A";
  opportunity.businessResult = "passed";
  opportunity.technicalStatus = "completed";
  opportunity.ownerAction = "confirm_supplier_option";
  opportunity.supplierOptions = [option];
  opportunity.recommendedSupplierOptionId = null;
  opportunity.confirmedSupplierOptionId = null;

  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:10:00.000Z"
  });
  const confirmation = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: option.supplierSkus[0].supplierSkuId,
      variantKey: VARIANT
    },
    confirmedAt: "2026-08-12T12:11:00.000Z"
  });
  const skuPackage = createSkuLifecycleFromConfirmedSupply({
    candidateId: candidate.id,
    opportunityPackage: confirmation.opportunityPackage,
    storeRef: candidate.storeRef,
    ownerSupplyConfirmation: confirmation.confirmation,
    skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    createdAt: "2026-08-12T12:12:00.000Z"
  });

  const result = {
    candidate,
    opportunityPackage: confirmation.opportunityPackage,
    skuPackage,
    salesSelection: {
      salesSnapshotId: "legacy-sales:CX-20260803-010",
      pricePath: "marketEvidence.exactTarget.lowestOtherOfferRub",
      currency: "RUB"
    },
    platformFeeEvidence: {
      evidenceId: "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
      commissionRate: candidate.codexReview.cStageReview.commission.rate,
      commissionEvidenceMode: "exact",
      sourceType: "real_same_description_category_seller_api",
      otherCosts: {
        packagingRmb: candidate.packagingCostRmb,
        labelRmb: candidate.codexReview.completeCost.labelRmb,
        fixedOtherRmb: 0,
        advertisingRate: candidate.codexReview.completeCost.advertisingReserveRate,
        returnReserveRate: candidate.codexReview.completeCost.returnOpsReserveRate,
        damageReserveRate: candidate.codexReview.completeCost.damageLossReserveRate,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION
      }
    },
    logisticsEvidence: {
      evidenceId: `logistics:guoo:economy-small:2026-07-20:${candidate.packedWeightKg}kg`,
      route: "GUOO Economy Small PUDO/Courier",
      amountRmb: candidate.codexReview.cStageReview.logistics.freightRmb,
      billableWeightKg: candidate.codexReview.cStageReview.logistics.billableWeightKg,
      effectiveDate: "2026-07-20"
    },
    exchangeRateEvidence: {
      evidenceId: "fx:cbr:2026-08-07:RUB-CNY",
      rubPerCny: candidate.codexReview.exchangeRate.rubPerCny,
      sourceType: "official"
    },
    calculatedAt: "2026-08-12T12:20:00.000Z"
  };
  result.platformFeeEvidence.costPolicyContext = { platform: skuPackage.targetPlatform, store: skuPackage.targetStore,
    storeRef: structuredClone(skuPackage.g1Identity.storeRef), salesScheme: "rfbs" };
  Object.assign(result.platformFeeEvidence.otherCosts, { acquiringRate: 0, taxRate: 0, otherRate: 0 });
  const policyValues = Object.fromEntries(["labelRmb", "fixedOtherRmb", "advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "acquiringRate", "taxRate", "otherRate"]
    .map(key => [key, result.platformFeeEvidence.otherCosts[key]]));
  result.platformFeeEvidence.costPolicySnapshot = createSyntheticBCostPolicy({ scope: result.platformFeeEvidence.costPolicyContext, values: policyValues });
  result.platformFeeEvidence.costPolicySnapshot.policyVersion = GLOBAL_PRICING_POLICY_VERSION;
  return result;
}

function correctedQuoteCandidate() {
  const candidate = createTrainCandidate({ lifecycle: false });
  candidate.packedWeightKg = 0.21;
  candidate.codexReview.cStageReview.logistics.billableWeightKg = 0.21;
  candidate.codexReview.cStageReview.logistics.freightRmb = 23.87;
  return candidate;
}

test("confirmed 0.21 kg supply creates an independent SKU and the profit domain keeps phase B", async () => {
  const candidate = correctedQuoteCandidate();
  const candidateBefore = structuredClone(candidate);
  const inputs = await preparedInputs(candidate);
  const before = structuredClone(inputs);
  const { skuPackage } = runSkuProfitModel(inputs);
  assert.equal(skuPackage.g1Identity.candidateId, candidate.id);
  assert.equal(skuPackage.parentOpportunityId, inputs.opportunityPackage.parentOpportunityId);
  assert.deepEqual(skuPackage.g1Identity.storeRef, candidate.storeRef);
  assert.equal(skuPackage.selectedSupplySnapshot.supplierSku.weight.value, 0.21);
  assert.equal(skuPackage.businessPhase, "B");
  assert.equal(skuPackage.businessResult, "passed");
  assert.equal(skuPackage.technicalStatus, "completed");
  assert.equal(skuPackage.activeProfitModelVersion, "profit-v1");
  assert.equal(skuPackage.c1ProductPlan, null);
  assert.deepEqual(validateSkuLifecyclePackage(skuPackage), { valid: true, errors: [] });
  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(inputs, before);
});

test("corrected quote preserves exact owner-confirmed supply and all five evidence references", async () => {
  const inputs = await preparedInputs(correctedQuoteCandidate());
  const { candidate, opportunityPackage } = inputs;
  const { skuPackage, profitModel: model } = runSkuProfitModel(inputs);
  const selected = skuPackage.selectedSupplySnapshot;
  assert.equal(opportunityPackage.dataRevision, candidate.dataRevision);
  assert.equal(opportunityPackage.salesSnapshots[0].sourceDataRevision, candidate.dataRevision);
  assert.equal(selected.sourceOpportunityRevision, candidate.dataRevision);
  assert.equal(selected.ownerSupplyConfirmation.sourceOpportunityRevision, candidate.dataRevision);
  assert.deepEqual(selected.supplierOption, opportunityPackage.supplierOptions[0]);
  assert.deepEqual(selected.supplierSku, opportunityPackage.supplierOptions[0].supplierSkus[0]);
  assert.deepEqual(model.inputSnapshotRefs, [
    "legacy-sales:CX-20260803-010",
    "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8:4993364145574",
    "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
    "logistics:guoo:economy-small:2026-07-20:0.21kg",
    "fx:cbr:2026-08-07:RUB-CNY"
  ]);
  assert.equal(model.recommendedSalePriceRub, 1831);
  assert.deepEqual(model.actualPurchaseCost, {
    amount: 41, currency: "CNY", evidenceRef: model.inputSnapshotRefs[1]
  });
  assert.equal(model.internationalFreight.amount, 23.87);
  assert.equal(model.internationalFreight.evidenceRef, model.inputSnapshotRefs[3]);
  assert.equal(model.commissionRate, 0.14);
  assert.deepEqual(model.priceConversion, {
    rubPerCny: 12.0637, evidenceRef: model.inputSnapshotRefs[4], checkedAt: inputs.calculatedAt
  });
});

test("corrected B quote recomputes raw profit independently of historical rounded conclusions", async () => {
  const candidate = correctedQuoteCandidate();
  Object.assign(candidate.codexReview.profitCalculation, {
    targetPriceRmb: 99999, unitProfitRmb: -99999, marginRate: -1
  });
  const { profitModel: model } = runSkuProfitModel(await preparedInputs(candidate));
  assert.equal(model.recommendedSalePriceCny, 151.78);
  assert.equal(model.sellerSettlementRevenue.amount, 130.53);
  assert.equal(model.unitProfitRmb, 44.45);
  assert.ok(Math.abs(model.calculation.recommendedSalePriceCny - 151.77764699055845) < 1e-10);
  assert.ok(Math.abs(model.calculation.unitProfitRmb - 44.44545877301324) < 1e-10);
  assert.equal(model.profitMargin, 0.2928);
  assert.equal(model.priceFloors.qualifyingFloorCny, 116);
  assert.equal(model.result, "passed");
  assert.equal(model.profitModelVersion, "profit-v1");
});

test("confirmed supply and B computation complete with no network or repeated fact request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("B must use frozen evidence without external access");
  };
  try {
    const { profitModel } = runSkuProfitModel(await preparedInputs(correctedQuoteCandidate()));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(profitModel.externalAccesses, []);
    assert.deepEqual(profitModel.requestedExistingFields, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing corrected freight rejects atomically without a profit version or C transition", async () => {
  const inputs = await preparedInputs(correctedQuoteCandidate());
  inputs.logisticsEvidence.amountRmb = "unknown";
  const before = structuredClone(inputs);
  assert.throws(() => runSkuProfitModel(inputs), /B_INPUT_GAP: 缺少国际运费/);
  assert.equal(inputs.skuPackage.businessPhase, "B");
  assert.deepEqual(inputs.skuPackage.profitModels, []);
  assert.equal(inputs.skuPackage.c1ProductPlan, null);
  assert.deepEqual(inputs, before);
});

test("daily B totals only count exact formal profit and exclude conditional commission estimates", async () => {
  for (const mode of ["exact", "estimated"]) {
    const inputs = await preparedInputs();
    inputs.platformFeeEvidence.commissionEvidenceMode = mode;
    if (mode === "estimated") inputs.platformFeeEvidence.estimateAuthorized = true;
    const { skuPackage } = runSkuProfitModel(inputs);
    const candidate = { ...inputs.candidate, lifecycleV11: { skuPackage } };
    delete candidate.codexReview;
    const summary = dailySummary([candidate, candidate], undefined, "2026-08-12");
    assert.equal(summary.combined.profitPassed, mode === "exact" ? 1 : 0, "only a formal frozen SKU is counted once");
    assert.equal(summary.combined.exactProfitPassed, mode === "exact" ? 1 : 0);
    assert.equal(summary.combined.estimatedProfitPassed, 0);
    const missingMode = structuredClone(candidate);
    delete missingMode.lifecycleV11.skuPackage.profitModels[0].commissionMode;
    const unknown = dailySummary([missingMode], undefined, "2026-08-12");
    assert.equal(unknown.combined.exactProfitPassed, 0);
    assert.equal(unknown.combined.profitPassed, 0);
    assert.equal(unknown.combined.unclassifiedProfitPassed, 0);
    for (const change of [
      value => { value.id = "different-candidate"; },
      value => { value.storeRef.platformStoreId = "different-store"; },
      value => { value.lifecycleV11.skuPackage.activeProfitModelVersion = "profit-v2"; },
      value => { value.lifecycleV11.skuPackage.profitModels[0].unitProfitRmb = 99999; }
    ]) {
      const invalid = structuredClone(candidate);
      change(invalid);
      assert.equal(dailySummary([invalid], undefined, "2026-08-12").combined.profitPassed, 0);
    }
    assert.equal(dailySummary([candidate], undefined, "2026-08-13").combined.profitPassed, 0);
  }
});

test("daily C completion follows persisted C2 confirmation without legacy ready timestamps", () => {
  const { skuPackage } = productionAuthorizationInputFixture();
  const candidate = {
    id: skuPackage.g1Identity.candidateId,
    storeRef: structuredClone(skuPackage.g1Identity.storeRef),
    targetStore: skuPackage.targetStore, targetPlatform: skuPackage.targetPlatform,
    workflowStatus: "listing_preparation", lifecycleV11: { skuPackage }
  };
  const before = structuredClone(candidate);
  const summary = dailySummary([candidate, candidate], undefined, "2026-08-22");
  assert.equal(summary.combined.cCompleted, 1);
  assert.equal(summary.combined.readyToList, 1, "the formal fixture has an exact passed profit and a complete final card");
  const unresolved = structuredClone(candidate);
  unresolved.lifecycleV11.skuPackage.productionConfirmationCard.riskAndUnknowns.status = "owner_review_required";
  unresolved.lifecycleV11.skuPackage.productionConfirmationCard.riskAndUnknowns.materialRisks = ["category_restrictions_unknown"];
  const unresolvedSummary = dailySummary([unresolved], undefined, "2026-08-22");
  assert.equal(unresolvedSummary.combined.cCompleted, 1);
  assert.equal(unresolvedSummary.combined.readyToList, 0, "completed C2 with a recorded gap cannot count as ready");
  assert.deepEqual(candidate, before);
  assert.equal(dailySummary([candidate], undefined, "2026-08-23").combined.cCompleted, 0);
  const mismatched = structuredClone(candidate);
  mismatched.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation.approvedManifestSha256 = "0".repeat(64);
  assert.equal(dailySummary([mismatched], undefined, "2026-08-22").combined.cCompleted, 0);
  for (const change of [
    value => { value.storeRef = {}; value.lifecycleV11.skuPackage.g1Identity.storeRef = {}; },
    value => { delete value.lifecycleV11.skuPackage.c2FinalAssets.assets; },
    value => {
      delete value.lifecycleV11.skuPackage.c2FinalAssets.ownerFinalUploadConfirmation.approvedManifestSha256;
      delete value.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalManifestSha256;
    }
  ]) {
    const invalid = structuredClone(candidate);
    change(invalid);
    const counts = dailySummary([invalid], undefined, "2026-08-22").combined;
    assert.equal(counts.cCompleted, 0);
    assert.equal(counts.readyToList, 0);
  }
  const falseCard = structuredClone(candidate);
  falseCard.lifecycleV11.skuPackage.productionConfirmationCard = { status: "awaiting_owner_business_confirmation", riskAndUnknowns: { status: "no_recorded_gaps" } };
  assert.equal(dailySummary([falseCard], undefined, "2026-08-22").combined.readyToList, 0);
});

test("CX-20260803-010 produces the complete frozen ProfitModel from five upstream sources", async () => {
  const inputs = await preparedInputs();
  const result = runSkuProfitModel(inputs);
  const model = result.profitModel;

  assert.equal(model.recommendedSalePriceRub, 1831);
  assert.equal(model.recommendedSalePriceCny, 151.78);
  assert.deepEqual(model.priceConversion, {
    rubPerCny: 12.0637,
    evidenceRef: "fx:cbr:2026-08-07:RUB-CNY",
    checkedAt: "2026-08-12T12:20:00.000Z"
  });
  assert.deepEqual(model.sellerSettlementRevenue, {
    amount: 130.53,
    currency: "CNY",
    evidenceRef: "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
    formula: "recommendedSalePriceCny × (1 - commissionRate)"
  });
  assert.equal(model.commissionRate, 0.14);
  assert.equal(model.internationalFreight.amount, 26.4);
  assert.equal(model.actualPurchaseCost.amount, 41);
  assert.equal(model.otherCosts.amount, 21.21);
  assert.equal(model.unitProfitRmb, 41.92);
  assert.equal(model.profitMargin, 0.2762);
  assert.equal(model.pricingMode, "source-market-fit");
  assert.deepEqual(model.priceFloors, {
    breakEvenPriceCny: 95.14,
    marginFloorCny: 119.32,
    minimumProfitFloorCny: 122.16,
    qualifyingFloorCny: 120,
    qualifyingLogic: "any",
    priceIncrementCny: 1
  });
  assert.equal(model.marketFit.status, "fits_market");
  assert.equal(model.marketFit.headroomCny, 31.78);
  assert.equal(model.marketFit.comparableCountIsHardGate, false);
  assert.equal(model.thresholdVersion, PROFIT_THRESHOLD_VERSION);
  assert.deepEqual(model.thresholds, {
    minimumProfitMargin: 0.15,
    minimumUnitProfitRmb: 20,
    logic: "any"
  });
  assert.equal(model.result, "passed");
  assert.equal(model.marketAssessmentRef, "a-market:CX-20260803-010:test");
  assert.deepEqual(model.marketSampleRefs, ["legacy-sales:CX-20260803-010"]);
  assert.equal(model.inputSnapshotRefs.length, 5);
  assert.deepEqual(validateProfitModel(model), { valid: true, errors: [] });
});

test("identical B inputs replay the existing ProfitModel without appending a version", async () => {
  const inputs = await preparedInputs();
  const first = runSkuProfitModel(inputs);
  const replay = runSkuProfitModel({ ...inputs, skuPackage: first.skuPackage });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.profitModel.profitModelVersion, first.profitModel.profitModelVersion);
  assert.deepEqual(replay.skuPackage.profitModels, first.skuPackage.profitModels);
  assert.equal(replay.skuPackage.dataRevision, first.skuPackage.dataRevision);
});

test("same B evidence IDs cannot replay changed frozen values or an inactive historical result", async () => {
  const inputs = await preparedInputs();
  const first = runSkuProfitModel(inputs);
  const changed = structuredClone(inputs);
  changed.platformFeeEvidence.commissionRate += 0.01;
  assert.throws(() => runSkuProfitModel({ ...changed, skuPackage: first.skuPackage }), /PROFIT_REPLAY_CONFLICT/);
  assert.throws(() => runSkuProfitModel({ ...inputs, skuPackage: first.skuPackage,
    exchangeRateEvidence: { ...inputs.exchangeRateEvidence, rubPerCny: inputs.exchangeRateEvidence.rubPerCny + 1 }
  }), /PROFIT_REPLAY_CONFLICT/);
  const second = runSkuProfitModel({ ...changed, skuPackage: first.skuPackage, calculatedAt: "2026-08-12T13:00:00.000Z" });
  assert.throws(() => runSkuProfitModel({ ...inputs, skuPackage: second.skuPackage }), /PROFIT_REPLAY_CONFLICT/);
  assert.equal(first.skuPackage.profitModels.length, 1);
});

test("both profit validators reject changed parameters under a published threshold version", async () => {
  const result = runSkuProfitModel(await preparedInputs());
  const sku = structuredClone(result.skuPackage);
  sku.profitModels[0].thresholds.minimumUnitProfitRmb = 0;
  sku.profitModels[0].thresholds.minimumProfitMargin = 0;
  assert.equal(validateProfitModel(sku.profitModels[0]).valid, false);
  const checked = validateSkuLifecyclePackage(sku);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some((entry) => entry.path.endsWith("thresholds")));
});

test("B uses OR threshold logic and remains in B after calculation", async () => {
  const inputs = await preparedInputs();
  const passed = runSkuProfitModel(inputs);
  assert.equal(passed.skuPackage.businessPhase, "B");
  assert.equal(passed.skuPackage.businessResult, "passed");
  assert.equal(passed.skuPackage.technicalStatus, "completed");
  assert.equal(passed.skuPackage.c1ProductPlan, null);
  assert.equal(passed.skuPackage.c2FinalAssets, null);
  assert.equal(passed.skuPackage.productionAuthorization, null);
  assert.equal(passed.skuPackage.productionRecord, null);

  const lowProfit = await preparedInputs();
  lowProfit.platformFeeEvidence.otherCosts.fixedOtherRmb = 30;
  lowProfit.platformFeeEvidence.costPolicySnapshot.items.fixedOtherRmb.value = 30;
  const rejected = runSkuProfitModel(lowProfit);
  assert.ok(rejected.profitModel.profitMargin < 0.15 && rejected.profitModel.unitProfitRmb < 20);
  assert.equal(rejected.profitModel.result, "rejected");
  assert.equal(rejected.skuPackage.businessPhase, "B");
});

test("authorized commission estimates remain conditional regardless of numeric profit and cannot pass formal B", async () => {
  const inputs = await preparedInputs();
  inputs.platformFeeEvidence.commissionRate = 0.2;
  inputs.platformFeeEvidence.commissionEvidenceMode = "estimated";
  inputs.platformFeeEvidence.estimateAuthorized = true;
  const result = runSkuProfitModel(inputs);
  assert.equal(result.profitModel.commissionRate, 0.2);
  assert.equal(result.profitModel.commissionMode, "estimated");
  assert.equal(Object.hasOwn(result.profitModel, "exactCommissionRequiredAtC"), false);
  assert.equal(result.profitModel.exactCommissionRequiredForFormalB, true);
  assert.equal(result.profitModel.calculationType, "conditional");
  assert.equal(result.profitModel.result, "manual_review");
  assert.equal(result.skuPackage.businessPhase, "B");
  assert.equal(result.skuPackage.businessResult, "manual_review");
  assert.equal(result.skuPackage.ownerAction, "review_business_exception");
  assert.equal(result.skuPackage.c1ProductPlan, null);
  const low = structuredClone(inputs);
  low.platformFeeEvidence.otherCosts.fixedOtherRmb = 10000;
  low.platformFeeEvidence.costPolicySnapshot.items.fixedOtherRmb.value = 10000;
  assert.equal(runSkuProfitModel(low).profitModel.result, "manual_review", "an estimate cannot eliminate the SKU either");
  for (const falseResult of ["passed", "rejected"]) {
    const invalid = structuredClone(result.profitModel); invalid.result = falseResult;
    assert.equal(validateProfitModel(invalid).valid, false);
  }

  const unauthorized = await preparedInputs();
  unauthorized.platformFeeEvidence.commissionEvidenceMode = "estimated";
  assert.throws(() => runSkuProfitModel(unauthorized), /估算佣金缺少当前SKU主人授权/);
});

test("当前条件测算在利润与生命周期发布Schema均不能伪装成正式通过", async () => {
  const validator = await loadPublishedSchemaValidator();
  const validateModel = validator.getSchema("profit-model-v1.1");
  const validateSku = validator.getSchema("product-lifecycle-v1.1");
  for (const mode of ["exact", "estimated"]) {
    const inputs = await preparedInputs();
    inputs.platformFeeEvidence.commissionEvidenceMode = mode;
    if (mode === "estimated") inputs.platformFeeEvidence.estimateAuthorized = true;
    const result = runSkuProfitModel(inputs);
    assert.equal(validateModel(result.profitModel), true, JSON.stringify(validateModel.errors));
    assert.equal(validateSku(result.skuPackage), true, JSON.stringify(validateSku.errors));
    if (mode === "estimated") {
      for (const edit of [m => { m.result = "passed"; }, m => { m.result = "rejected"; },
        m => { m.calculationType = "formal"; }, m => { delete m.exactCommissionRequiredForFormalB; }]) {
        const invalid = structuredClone(result.skuPackage); edit(invalid.profitModels[0]);
        assert.equal(validateModel(invalid.profitModels[0]), false);
        assert.equal(validateSku(invalid), false);
      }
    }
  }
});

async function boundaryInputs(priceCny, profitRmb) {
  const inputs = structuredClone(await preparedInputs());
  inputs.exchangeRateEvidence.rubPerCny = 1;
  attachPassedMarketAssessment(inputs.opportunityPackage, { price: priceCny });
  inputs.opportunityPackage.salesSnapshots[0].currentPrice = priceCny;
  inputs.skuPackage.selectedSupplySnapshot.supplierSku.actualPurchaseCost = 1;
  inputs.skuPackage.skuFacts.actualPurchaseCost = 1;
  inputs.opportunityPackage.supplierOptions[0].supplierSkus[0].actualPurchaseCost = 1;
  inputs.platformFeeEvidence.otherCosts.fixedOtherRmb = priceCny * 0.74 - 1 - 26.4 - 3 - profitRmb;
  inputs.platformFeeEvidence.costPolicySnapshot.items.fixedOtherRmb.value = inputs.platformFeeEvidence.otherCosts.fixedOtherRmb;
  return inputs;
}

for (const [price, profit, expected] of [
  [100.02, 15, "rejected"], [100, 14.999, "rejected"], [100, 15, "passed"],
  [200, 19.999, "rejected"], [200, 20, "passed"], [100.02, 15.0031, "passed"]
]) {
  test(`unrounded threshold: price ${price}, profit ${profit} is ${expected}`, async () => {
    const inputs = await boundaryInputs(price, profit);
    const before = structuredClone(inputs);
    const result = runSkuProfitModel(inputs);
    assert.equal(result.profitModel.result, expected);
    assert.ok(Math.abs(result.profitModel.calculation.unitProfitRmb - profit) < 1e-10);
    assert.deepEqual(validateProfitModel(result.profitModel), { valid: true, errors: [] });
    assert.deepEqual(validateSkuLifecyclePackage(result.skuPackage), { valid: true, errors: [] });
    assert.deepEqual(inputs, before);
    assert.deepEqual(validateProfitModel(JSON.parse(JSON.stringify(result.profitModel))), { valid: true, errors: [] });
  });
}

test("a rounded display or a fabricated calculation cannot promote a rejected model", async () => {
  const result = runSkuProfitModel(await boundaryInputs(100.02, 15));
  for (const change of [
    model => { model.profitMargin = 0.15; model.result = "passed"; },
    model => { model.calculation.unitProfitRmb = 20; },
    model => { model.calculation = null; },
    model => { model.calculation.version = "unsupported"; }
  ]) {
    const model = structuredClone(result.profitModel);
    change(model);
    assert.equal(validateProfitModel(model).valid, false);
    const sku = structuredClone(result.skuPackage);
    sku.profitModels[0] = model;
    assert.equal(validateSkuLifecyclePackage(sku).valid, false);
  }
});

test("missing or invalid commission modes fail before creating a profit version", async () => {
  for (const mode of [undefined, null, "", "current", true, 0]) {
    const inputs = await preparedInputs();
    inputs.platformFeeEvidence.commissionEvidenceMode = mode;
    assert.throws(() => runSkuProfitModel(inputs), /佣金证据必须明确/);
    assert.deepEqual(inputs.skuPackage.profitModels, []);
  }
});

test("synthetic historical 25-percent-and-20-yuan model remains valid and is not rewritten", async () => {
  const { calculation, ...historical } = structuredClone(runSkuProfitModel(await preparedInputs()).profitModel);
  assert.equal(calculation.version, "profit-calculation-v3-cost-policy-snapshot");
  // This explicit legacy fixture predates the calculation field; its bytes remain unchanged.
  historical.thresholdVersion = "profit-threshold-v1.1-25pct-20cny";
  historical.thresholds = { minimumProfitMargin: 0.25, minimumUnitProfitRmb: 20, logic: "all" };
  assert.ok(historical, "expected historical ProfitModel fixture");
  const before = structuredClone(historical);
  assert.equal(historical.thresholdVersion, "profit-threshold-v1.1-25pct-20cny");
  const validation = validateProfitModel(historical);
  assert.deepEqual(validation, { valid: true, errors: [] });
  assert.equal(validation.errors.some((item) => ["thresholdVersion", "thresholds", "result"].includes(item.path)), false);
  assert.deepEqual(historical, before);
});

test("B makes zero external calls and never asks for existing fields", async () => {
  const inputs = await preparedInputs();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("第7阶段禁止访问Ozon、WB和1688");
  };
  try {
    const result = runSkuProfitModel(inputs);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.profitModel.externalAccesses, []);
    assert.deepEqual(result.profitModel.requestedExistingFields, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a new calculation appends a version and cannot overwrite historical profit", async () => {
  const inputs = await preparedInputs();
  const first = runSkuProfitModel(inputs);
  const historicalBefore = structuredClone(first.skuPackage.profitModels);
  const second = runSkuProfitModel({
    ...inputs,
    skuPackage: first.skuPackage,
    calculatedAt: "2026-08-12T12:21:00.000Z"
  });

  assert.equal(first.profitModel.profitModelVersion, "profit-v1");
  assert.equal(second.profitModel.profitModelVersion, "profit-v2");
  assert.deepEqual(second.skuPackage.profitModels.slice(0, historicalBefore.length), historicalBefore);
  assert.equal(second.skuPackage.profitModels.length, 2);
  assert.equal(validateSkuLifecyclePackage(second.skuPackage).valid, true);
});

test("missing any one of the five sources stops without partial profit", async () => {
  const inputs = await preparedInputs();
  const initial = JSON.stringify(inputs.skuPackage);
  assert.throws(
    () => runSkuProfitModel({ ...inputs, logisticsEvidence: null }),
    /B_INPUT_GAP: 缺少国际物流证据/
  );
  assert.equal(JSON.stringify(inputs.skuPackage), initial);
  assert.deepEqual(inputs.skuPackage.profitModels, []);
});

test("published ProfitModel schema requires every phase-7 output", async () => {
  const url = new URL("../schema/profit-model-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  for (const field of [
    "recommendedSalePriceRub",
    "recommendedSalePriceCny",
    "sellerSettlementRevenue",
    "commissionRate",
    "internationalFreight",
    "actualPurchaseCost",
    "otherCosts",
    "unitProfitRmb",
    "profitMargin",
    "thresholdVersion",
    "result"
  ]) assert.ok(schema.required.includes(field), field);
  for (const field of ["marketAssessmentRef", "marketSampleRefs"]) assert.ok(schema.required.includes(field), field);
});

test("new B requires an evidenced cost policy and rejects unknown, settlement inclusion and mismatched scope", async () => {
  for (const [mutate, expected] of [
    [input => { delete input.platformFeeEvidence.costPolicySnapshot; }, /B_INPUT_GAP/],
    [input => { input.platformFeeEvidence.costPolicySnapshot.items.taxRate = { ...input.platformFeeEvidence.costPolicySnapshot.items.taxRate, status: "unknown", value: null }; }, /B_COST_POLICY_UNKNOWN/],
    [input => { input.platformFeeEvidence.costPolicySnapshot.items.withdrawalFeeRate.status = "included_in_settlement"; }, /B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS/],
    [input => { input.platformFeeEvidence.costPolicySnapshot.policyEvidenceRef = ""; }, /B_COST_POLICY_INVALID/],
    [input => { input.platformFeeEvidence.costPolicySnapshot.scope.salesScheme = "other"; }, /B_COST_POLICY_SCOPE_MISMATCH/],
    [input => { input.platformFeeEvidence.costPolicyContext.store = "miska"; }, /B_INPUT_GAP/],
    [input => { input.platformFeeEvidence.otherCosts.taxRate = 0.01; }, /B_INPUT_GAP/]
  ]) {
    const input = await preparedInputs(); mutate(input);
    const before = structuredClone(input);
    assert.throws(() => runSkuProfitModel(input), expected);
    assert.deepEqual(input, before);
    assert.deepEqual(input.skuPackage.profitModels, []);
  }
});

test("new policy fees feed the single pricing formula and persist their exact provenance", async () => {
  const input = await preparedInputs();
  const previous = runSkuProfitModel(input).profitModel;
  const fees = input.platformFeeEvidence;
  fees.costPolicySnapshot.policyVersion = "synthetic-cost-policy-v2";
  fees.otherCosts.pricingPolicyVersion = "synthetic-cost-policy-v2";
  for (const [key, value] of Object.entries({ labelRmb: 2.5, withdrawalFeeRate: 0.03, acquiringRate: 0.01, taxRate: 0.02, otherRate: 0.01 })) {
    fees.otherCosts[key] = value; fees.costPolicySnapshot.items[key].value = value;
  }
  const model = runSkuProfitModel(input).profitModel;
  const rawPrice = model.calculation.recommendedSalePriceCny;
  assert.ok(Math.abs(model.calculation.unitProfitRmb - (previous.calculation.unitProfitRmb - 1 - rawPrice * 0.05)) < 1e-10);
  assert.equal(model.otherCosts.amount, Number((fees.otherCosts.packagingRmb + 2.5 + rawPrice * 0.17).toFixed(2)));
  assert.equal(model.sellerSettlementRevenue.amount, previous.sellerSettlementRevenue.amount);
  assert.equal(model.pricingPolicyVersion, "synthetic-cost-policy-v2");
  assert.deepEqual(model.otherCosts.costPolicySnapshot, fees.costPolicySnapshot);
  assert.deepEqual(model.otherCosts.costPolicyContext, fees.costPolicyContext);
  assert.deepEqual(validateProfitModel(model), { valid: true, errors: [] });
  for (const mutate of [value => { value.otherCosts.amount += 1; }, value => { value.costScope.variableRates.tax = 0; },
    value => { value.otherCosts.components.withdrawalFeeRate = 0; }, value => { delete value.otherCosts.costPolicySnapshot; }]) {
    const changed = structuredClone(model); mutate(changed);
    assert.equal(validateProfitModel(changed).valid, false);
  }
  const validate = (await loadPublishedSchemaValidator()).getSchema("profit-model-v1.1");
  assert.equal(validate(model), true, JSON.stringify(validate.errors));
  const missing = structuredClone(model); delete missing.otherCosts.costPolicySnapshot;
  assert.equal(validate(missing), false);
});

test("historical v1 and v2 frozen calculations remain readable without a cost policy snapshot", async () => {
  const validate = (await loadPublishedSchemaValidator()).getSchema("profit-model-v1.1");
  for (const mode of ["exact", "estimated"]) {
    const input = await preparedInputs();
    input.platformFeeEvidence.commissionEvidenceMode = mode;
    if (mode === "estimated") input.platformFeeEvidence.estimateAuthorized = true;
    const historical = structuredClone(runSkuProfitModel(input).profitModel);
    historical.calculation.version = "profit-calculation-v2-formal-commission";
    delete historical.otherCosts.costPolicySnapshot;
    delete historical.otherCosts.costPolicyContext;
    for (const key of ["acquiringRate", "taxRate", "otherRate"]) delete historical.otherCosts.components[key];
    const before = JSON.stringify(historical);
    assert.deepEqual(validateProfitModel(historical), { valid: true, errors: [] });
    assert.equal(validate(historical), true, JSON.stringify(validate.errors));
    assert.equal(JSON.stringify(historical), before);
    if (mode === "exact") {
      historical.calculation.version = "profit-calculation-v1-unrounded";
      assert.deepEqual(validateProfitModel(historical), { valid: true, errors: [] });
      assert.equal(validate(historical), true, JSON.stringify(validate.errors));
    }
  }
});
