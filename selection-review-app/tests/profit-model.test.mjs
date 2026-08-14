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
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";

const TEST_PRODUCT_ID = "CX-20260803-010";
const VARIANT = "规格:豪华小火车";

async function currentCandidate() {
  const url = new URL("../data/candidates.json", import.meta.url);
  const document = JSON.parse(await readFile(url, "utf8"));
  return document.candidates.find((item) => item.id === TEST_PRODUCT_ID);
}

async function preparedInputs() {
  const candidate = await currentCandidate();
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.salesSnapshots[0].platform = "ozon";
  opportunity.salesSnapshots[0].sellerType = "cross_border_cn";
  opportunity.salesSnapshots[0].sellerIdentityEvidence = { status: "verified", evidenceRef: "test:cross-border-cn" };
  const evidence = sanitize1688Evidence({
    offerId: "712421624571",
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
  evidence.skus[0].weight = { value: 0.3, unit: "kg" };
  evidence.skus[0].dimensions = { length: 23, width: 16, height: 3, unit: "cm" };
  evidence.skus[0].material = "DVP木纤维板";
  evidence.skus[0].powerProfile = { powered: false };
  const option = structuredClone(adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8"
  }));
  option.supplierSalesEvidence = evidence.supplierSalesEvidence;
  option.supplierBadges = evidence.supplierBadges;
  option.supplierSkus[0].actualPurchaseCost = 41;

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
    opportunityPackage: confirmation.opportunityPackage,
    ownerSupplyConfirmation: confirmation.confirmation,
    skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    createdAt: "2026-08-12T12:12:00.000Z"
  });

  return {
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
      commissionRate: 0.14,
      sourceType: "real_same_description_category_seller_api",
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0.05,
        damageReserveRate: 0.05
      }
    },
    logisticsEvidence: {
      evidenceId: "logistics:guoo:economy-small:2026-07-20:0.3kg",
      route: "GUOO Economy Small PUDO/Courier",
      amountRmb: 26.4,
      billableWeightKg: 0.3,
      effectiveDate: "2026-07-20"
    },
    exchangeRateEvidence: {
      evidenceId: "fx:cbr:2026-08-07:RUB-CNY",
      rubPerCny: 12.0637,
      sourceType: "official"
    },
    calculatedAt: "2026-08-12T12:20:00.000Z"
  };
}

test("CX-20260803-010 produces the complete frozen ProfitModel from five upstream sources", async () => {
  const inputs = await preparedInputs();
  const result = runSkuProfitModel(inputs);
  const model = result.profitModel;

  assert.equal(model.recommendedSalePriceRub, 1831);
  assert.equal(model.recommendedSalePriceCny, 151.78);
  assert.deepEqual(model.sellerSettlementRevenue, {
    amount: 130.53,
    currency: "CNY",
    evidenceRef: "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
    formula: "recommendedSalePriceCny × (1 - commissionRate)"
  });
  assert.equal(model.commissionRate, 0.14);
  assert.equal(model.internationalFreight.amount, 26.4);
  assert.equal(model.actualPurchaseCost.amount, 41);
  assert.equal(model.otherCosts.amount, 18.18);
  assert.equal(model.unitProfitRmb, 44.95);
  assert.equal(model.profitMargin, 0.2962);
  assert.equal(model.thresholdVersion, PROFIT_THRESHOLD_VERSION);
  assert.equal(model.result, "passed");
  assert.equal(model.inputSnapshotRefs.length, 5);
  assert.deepEqual(validateProfitModel(model), { valid: true, errors: [] });
});

test("B uses AND threshold logic and remains in B after calculation", async () => {
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
  const rejected = runSkuProfitModel(lowProfit);
  assert.ok(rejected.profitModel.profitMargin < 0.25 || rejected.profitModel.unitProfitRmb < 20);
  assert.equal(rejected.profitModel.result, "rejected");
  assert.equal(rejected.skuPackage.businessPhase, "B");
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
});
