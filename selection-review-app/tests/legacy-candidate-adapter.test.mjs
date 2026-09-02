import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyCandidateDocument } from "./helpers/legacy-candidate-fixture.mjs";
import {
  HISTORICAL_UNVERSIONED_PROFIT,
  LEGACY_ADAPTER_MODE,
  LEGACY_FIELD_MAPPING_RULES,
  UNKNOWN,
  adaptLegacyCandidateToOpportunity,
  adaptLegacyCandidatesDocument
} from "../lib/legacy-candidate-adapter.mjs";
import { validateOpportunityPackage } from "../lib/product-lifecycle-schema.mjs";

async function currentDocument() {
  return createLegacyCandidateDocument();
}

test("all 52 synthetic legacy candidates produce one valid read-only OpportunityPackage each", async () => {
  const source = await currentDocument();
  const before = JSON.stringify(source);
  const adapted = adaptLegacyCandidatesDocument(source);

  assert.equal(source.candidates.length, 52);
  assert.equal(adapted.sourceCandidateCount, 52);
  assert.equal(adapted.opportunityCount, 52);
  assert.equal(adapted.opportunities.length, 52);
  assert.equal(new Set(adapted.opportunities.map((item) => item.parentOpportunityId)).size, 52);
  assert.equal(adapted.adapterMode, LEGACY_ADAPTER_MODE);
  for (const pkg of adapted.opportunities) {
    assert.equal(validateOpportunityPackage(pkg).valid, true, pkg.parentOpportunityId);
    assert.equal(Object.isFrozen(pkg), true);
  }
  assert.equal(JSON.stringify(source), before, "只读适配不得修改内存中的旧数据");
});

test("legacy field mapping rules explicitly prevent purchase-component inference", () => {
  assert.equal(LEGACY_FIELD_MAPPING_RULES.purchasePriceRmb, "supplierOptions[0].actualPurchaseCost");
  assert.equal(LEGACY_FIELD_MAPPING_RULES.domesticShippingRmb, "not_mapped_component_is_unknown");
  assert.equal(LEGACY_FIELD_MAPPING_RULES["codexReview.profitCalculation"], "historicalProfitModels[0]");
  assert.equal(Object.isFrozen(LEGACY_FIELD_MAPPING_RULES), true);
});

test("historical all-in purchase cost is preserved without inventing its components", async () => {
  const source = await currentDocument();
  const candidate = source.candidates.find((item) => item.id === "CX-20260803-010");
  const pkg = adaptLegacyCandidateToOpportunity(candidate);
  const supply = pkg.supplierOptions[0];

  assert.equal(supply.actualPurchaseCost, 41);
  assert.equal(supply.actualPurchaseCostCurrency, "CNY");
  assert.equal(supply.productPrice, UNKNOWN);
  assert.equal(supply.domesticShipping, UNKNOWN);
  assert.ok(pkg.legacySource.unknownFields.includes("supplierOptions[0].productPrice"));
  assert.ok(pkg.legacySource.unknownFields.includes("supplierOptions[0].domesticShipping"));
});

test("missing historical purchase cost remains unknown instead of becoming zero", async () => {
  const source = await currentDocument();
  const candidate = source.candidates.find((item) => item.purchasePriceRmb === null);
  const pkg = adaptLegacyCandidateToOpportunity(candidate);
  assert.equal(pkg.supplierOptions[0].actualPurchaseCost, UNKNOWN);
  assert.equal(pkg.supplierOptions[0].actualPurchaseCostCurrency, UNKNOWN);
});

test("ambiguous old workflow and processing labels stay unknown", async () => {
  const source = await currentDocument();
  const candidate = source.candidates.find((item) => item.workflowStatus === "codex_processing");
  const pkg = adaptLegacyCandidateToOpportunity(candidate);
  assert.equal(pkg.businessPhase, UNKNOWN);
  assert.equal(pkg.businessResult, UNKNOWN);
  assert.equal(pkg.technicalStatus, UNKNOWN);
  assert.equal(pkg.ownerAction, UNKNOWN);
});

test("explicit legacy elimination maps to closed and rejected without changing source data", async () => {
  const source = await currentDocument();
  const candidate = source.candidates.find((item) => item.workflowStatus === "eliminated");
  const before = structuredClone(candidate);
  const pkg = adaptLegacyCandidateToOpportunity(candidate);
  assert.equal(pkg.businessPhase, "closed");
  assert.equal(pkg.businessResult, "rejected");
  assert.deepEqual(candidate, before);
});

test("legacy profit remains read-only historical evidence and is never promoted to an active model", async () => {
  const source = await currentDocument();
  const candidatesWithProfit = source.candidates.filter((item) => item.codexReview?.profitCalculation);
  assert.ok(candidatesWithProfit.length > 0);
  for (const candidate of candidatesWithProfit) {
    const pkg = adaptLegacyCandidateToOpportunity(candidate);
    assert.equal(pkg.historicalProfitModels.length, 1);
    assert.equal(pkg.historicalProfitModels[0].profitModelVersion, HISTORICAL_UNVERSIONED_PROFIT);
    assert.equal(pkg.historicalProfitModels[0].sourceCandidateId, candidate.id);
    assert.equal(pkg.historicalProfitModels[0].sourceDataRevision, candidate.dataRevision);
    assert.equal(pkg.historicalProfitModels[0].readOnly, true);
    assert.deepEqual(pkg.historicalProfitModels[0].originalSnapshot, candidate.codexReview.profitCalculation);
  }
});

test("legacy supplier search limits remain unknown but cannot be used as a running policy", async () => {
  const source = await currentDocument();
  const pkg = adaptLegacyCandidateToOpportunity(source.candidates[0]);
  assert.equal(pkg.supplierSearch.status, UNKNOWN);
  assert.equal(pkg.supplierSearch.limits.maxSearchRounds, UNKNOWN);

  const attemptedRun = structuredClone(pkg);
  attemptedRun.supplierSearch.status = "running";
  const result = validateOpportunityPackage(attemptedRun);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "supplierSearch.limits.maxSearchRounds"));
});

test("duplicate legacy IDs stop the adapter instead of hiding a quantity mismatch", () => {
  const base = {
    id: "DUPLICATE",
    productName: "测试商品",
    createdAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:00.000Z",
    dataRevision: 1,
    history: []
  };
  assert.throws(
    () => adaptLegacyCandidatesDocument({ candidates: [base, structuredClone(base)] }),
    /ID不唯一/
  );
});
