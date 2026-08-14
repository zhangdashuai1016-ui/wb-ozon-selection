import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adaptLegacyCandidateToOpportunity } from "../lib/legacy-candidate-adapter.mjs";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import { adapt1688CaptureToSupplierOption } from "../lib/supplier-option.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption,
  validateOwnerSupplyConfirmation
} from "../lib/supplier-selection-flow.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";

const TEST_PRODUCT_ID = "CX-20260803-010";
const VARIANT = "片数:320片";

async function testCandidate() {
  const url = new URL("../data/candidates.json", import.meta.url);
  const document = JSON.parse(await readFile(url, "utf8"));
  return document.candidates.find((item) => item.id === TEST_PRODUCT_ID);
}

function supplierOption({
  offerId,
  actualPurchaseCost,
  salesVolume,
  stabilityScore,
  badges = "unknown",
  completeFacts = false
}) {
  const evidence = sanitize1688Evidence({
    offerId,
    observedAt: "2026-08-12T12:00:00.000Z",
    title: `木质机械火车-${offerId}`,
    supplierSalesEvidence: { salesVolume, stabilityScore },
    supplierBadges: badges,
    skus: [{
      sourceSkuId: `sku-${offerId}-320`,
      propPath: VARIANT,
      attributes: { 片数: "320片" },
      priceCny: 35,
      priceSource: "skuModel.skuInfoMap.price",
      stock: 20,
      stockSource: "skuModel.skuInfoMap.stock",
      imageUrl: "https://cbu01.alicdn.com/img/ibank/train-320.jpg"
    }]
  }, offerId);
  evidence.supplierSalesEvidence = { salesVolume, stabilityScore };
  evidence.supplierBadges = badges;
  if (completeFacts) {
    evidence.skus[0].weight = { value: 0.3, unit: "kg" };
    evidence.skus[0].dimensions = { length: 23, width: 16, height: 3, unit: "cm" };
    evidence.skus[0].material = "DVP木纤维板";
    evidence.skus[0].powerProfile = { powered: false };
  }
  const option = structuredClone(adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: `source-capture:${offerId}`
  }));
  option.supplierSalesEvidence = { salesVolume, stabilityScore };
  option.supplierBadges = badges;
  option.supplierSkus[0].actualPurchaseCost = actualPurchaseCost;
  return option;
}

async function opportunityWithOptions(options) {
  const candidate = await testCandidate();
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.businessPhase = "A";
  opportunity.businessResult = "passed";
  opportunity.technicalStatus = "completed";
  opportunity.ownerAction = "confirm_supplier_option";
  opportunity.supplierOptions = options;
  opportunity.recommendedSupplierOptionId = null;
  opportunity.confirmedSupplierOptionId = null;
  return { candidate, opportunity };
}

test("recommendation reads the sales snapshot and applies the four frozen priorities in order", async () => {
  const lowerCost = supplierOption({
    offerId: "700000000001",
    actualPurchaseCost: 39,
    salesVolume: 10,
    stabilityScore: 20,
    badges: "unknown"
  });
  const higherCostStrongSupplier = supplierOption({
    offerId: "700000000002",
    actualPurchaseCost: 40,
    salesVolume: 100000,
    stabilityScore: 100,
    badges: ["牛头供应商", "超级工厂"],
    completeFacts: true
  });
  const { opportunity } = await opportunityWithOptions([higherCostStrongSupplier, lowerCost]);
  const result = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:10:00.000Z"
  });

  assert.deepEqual(result.salesSnapshotRefs, ["legacy-sales:CX-20260803-010"]);
  assert.equal(result.recommendedSupplierOptionId, lowerCost.supplierOptionId, "最低到手成本优先，后续加分不能反超");
  assert.equal(result.ownerConfirmationStatus, "not_confirmed");
  assert.equal(result.opportunityPackage.recommendedSupplierOptionId, lowerCost.supplierOptionId);
  assert.equal(result.opportunityPackage.confirmedSupplierOptionId, null, "系统只能推荐，不能自动确认");
  assert.equal(result.opportunityPackage.ownerAction, "confirm_supplier_option");
});

test("sales, trusted badges and fact completeness are sequential tie breakers", async () => {
  const lowSales = supplierOption({
    offerId: "700000000011",
    actualPurchaseCost: 39,
    salesVolume: 10,
    stabilityScore: 20,
    badges: ["牛头供应商"],
    completeFacts: true
  });
  const highSalesNoBadge = supplierOption({
    offerId: "700000000012",
    actualPurchaseCost: 39,
    salesVolume: 1000,
    stabilityScore: 90,
    badges: "unknown"
  });
  let prepared = await opportunityWithOptions([lowSales, highSalesNoBadge]);
  let result = recommendSupplierOption({
    opportunityPackage: prepared.opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:11:00.000Z"
  });
  assert.equal(result.recommendedSupplierOptionId, highSalesNoBadge.supplierOptionId, "销量稳定性是成本后的第二优先级");

  const noBadgeComplete = supplierOption({
    offerId: "700000000013",
    actualPurchaseCost: 39,
    salesVolume: 1000,
    stabilityScore: 90,
    badges: "unknown",
    completeFacts: true
  });
  const trustedIncomplete = supplierOption({
    offerId: "700000000014",
    actualPurchaseCost: 39,
    salesVolume: 1000,
    stabilityScore: 90,
    badges: ["牛头供应商"]
  });
  prepared = await opportunityWithOptions([noBadgeComplete, trustedIncomplete]);
  result = recommendSupplierOption({
    opportunityPackage: prepared.opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:12:00.000Z"
  });
  assert.equal(result.recommendedSupplierOptionId, trustedIncomplete.supplierOptionId, "可信标识是销量后的第三优先级");

  const complete = supplierOption({
    offerId: "700000000015",
    actualPurchaseCost: 39,
    salesVolume: 1000,
    stabilityScore: 90,
    badges: ["牛头供应商"],
    completeFacts: true
  });
  prepared = await opportunityWithOptions([trustedIncomplete, complete]);
  result = recommendSupplierOption({
    opportunityPackage: prepared.opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:13:00.000Z"
  });
  assert.equal(result.recommendedSupplierOptionId, complete.supplierOptionId, "事实完整度是第四优先级");
});

test("unconfirmed recommendation cannot create a SKU lifecycle package", async () => {
  const option = supplierOption({
    offerId: "700000000021",
    actualPurchaseCost: 39,
    salesVolume: 500,
    stabilityScore: 80,
    badges: ["牛头供应商"]
  });
  const { opportunity } = await opportunityWithOptions([option]);
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:20:00.000Z"
  });

  assert.throws(() => createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: recommendation.opportunityPackage,
    ownerSupplyConfirmation: null,
    skuPackageId: "sku-lifecycle:test:unconfirmed",
    createdAt: "2026-08-12T12:21:00.000Z"
  }), /未确认供应方案不能进入SKU生命周期/);
  assert.equal(recommendation.opportunityPackage.confirmedSupplierOptionId, null);
});

test("simulated owner confirmation creates one independent SKU package without running B, C or D", async () => {
  const option = supplierOption({
    offerId: "700000000031",
    actualPurchaseCost: 39,
    salesVolume: 500,
    stabilityScore: 80,
    badges: ["牛头供应商"],
    completeFacts: true
  });
  const { candidate, opportunity } = await opportunityWithOptions([option]);
  const candidateBefore = JSON.stringify(candidate);
  const opportunityBefore = JSON.stringify(opportunity);
  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:30:00.000Z"
  });
  const selectedSku = option.supplierSkus[0];
  const confirmed = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: selectedSku.supplierSkuId,
      variantKey: selectedSku.variantKey
    },
    confirmedAt: "2026-08-12T12:31:00.000Z"
  });
  const skuPackage = createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: confirmed.opportunityPackage,
    ownerSupplyConfirmation: confirmed.confirmation,
    skuPackageId: "sku-lifecycle:CX-20260803-010:700000000031:320",
    createdAt: "2026-08-12T12:32:00.000Z"
  });

  assert.equal(confirmed.confirmation.selectedRecommendedOption, true);
  assert.deepEqual(validateOwnerSupplyConfirmation(confirmed.confirmation), { valid: true, errors: [] });
  assert.equal(confirmed.opportunityPackage.confirmedSupplierOptionId, option.supplierOptionId);
  assert.equal(skuPackage.entityType, "SkuLifecyclePackage");
  assert.equal(skuPackage.parentOpportunityId, TEST_PRODUCT_ID);
  assert.equal(skuPackage.supplierOptionId, option.supplierOptionId);
  assert.equal(skuPackage.supplierSkuId, selectedSku.supplierSkuId);
  assert.equal(skuPackage.variantKey, VARIANT);
  assert.deepEqual(skuPackage.inheritedSalesSnapshotRefs, ["legacy-sales:CX-20260803-010"]);
  assert.equal(skuPackage.businessPhase, "B", "只创建B入口，不执行B利润");
  assert.equal(skuPackage.businessResult, "pending");
  assert.equal(skuPackage.technicalStatus, "not_started");
  assert.deepEqual(skuPackage.profitModels, []);
  assert.equal(skuPackage.activeProfitModelVersion, null);
  assert.equal(skuPackage.c1ProductPlan, null);
  assert.equal(skuPackage.c2FinalAssets, null);
  assert.equal(skuPackage.productionAuthorization, null);
  assert.equal(skuPackage.productionRecord, null);
  assert.equal(validateSkuLifecyclePackage(skuPackage).valid, true);
  assert.equal(JSON.stringify(candidate), candidateBefore, "历史候选不得修改");
  assert.equal(JSON.stringify(opportunity), opportunityBefore, "输入OpportunityPackage不得修改");
});

test("OwnerSupplyConfirmation schema and validator reject system confirmation", async () => {
  const schemaUrl = new URL("../schema/owner-supply-confirmation-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.$id, "owner-supply-confirmation-v1.1");
  assert.equal(schema.properties.confirmedBy.const, "owner");

  const result = validateOwnerSupplyConfirmation({
    confirmationVersion: "owner-supply-confirmation-v1.1",
    status: "confirmed",
    parentOpportunityId: TEST_PRODUCT_ID,
    sourceOpportunityRevision: 25,
    recommendationVersion: "supplier-recommendation-v1.1",
    recommendedSupplierOptionId: "supplier-option:1688:test",
    selectedRecommendedOption: true,
    supplierOptionId: "supplier-option:1688:test",
    supplierSkuId: "sku-test",
    variantKey: VARIANT,
    confirmedBy: "system",
    confirmedAt: "2026-08-12T12:40:00.000Z"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "confirmedBy"));
});
