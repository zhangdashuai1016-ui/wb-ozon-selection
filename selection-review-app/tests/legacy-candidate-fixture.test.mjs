import assert from "node:assert/strict";
import test from "node:test";
import { validateOpportunityPackage, validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { createTrainCandidate, createMusicBoxCandidate, createLegacyCandidateDocument, createAuthorizedTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";

test("synthetic candidate factories produce fresh, schema-valid lifecycle inputs", () => {
  const first = createTrainCandidate();
  const second = createTrainCandidate();
  assert.deepEqual(first, second);
  assert.deepEqual(validateSkuLifecyclePackage(first.lifecycleV11.skuPackage), { valid: true, errors: [] });
  first.codexReview.completeCost.returnOpsReserveRate = 0.99;
  first.lifecycleV11.skuPackage.audit.history.push({ event: "test-mutation" });
  assert.equal(second.codexReview.completeCost.returnOpsReserveRate, 0.05);
  assert.equal(second.lifecycleV11.skuPackage.audit.history.some((entry) => entry.event === "test-mutation"), false);
  const musicBox = createMusicBoxCandidate();
  assert.deepEqual(validateOpportunityPackage(musicBox.lifecycleV11.opportunityPackage), { valid: true, errors: [] });
});

test("synthetic legacy document explicitly represents unknown, processing, rejected and historical-profit records", () => {
  const document = createLegacyCandidateDocument();
  assert.equal(document.candidates.length, 52);
  assert.equal(new Set(document.candidates.map((candidate) => candidate.id)).size, 52);
  assert.ok(document.candidates.some((candidate) => candidate.purchasePriceRmb === null));
  assert.ok(document.candidates.some((candidate) => candidate.workflowStatus === "codex_processing"));
  assert.ok(document.candidates.some((candidate) => candidate.workflowStatus === "eliminated"));
  assert.ok(document.candidates.some((candidate) => candidate.codexReview?.profitCalculation));
});

test("synthetic final-assets authorization preserves the unexecuted five-image contract", () => {
  const candidate = createAuthorizedTrainCandidate();
  const sku = candidate.lifecycleV11.skuPackage;
  assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
  assert.equal(sku.activeProfitModelVersion, "profit-v2");
  assert.equal(sku.profitModels.length, 2);
  assert.equal(sku.productionAuthorization.lockedScope.finalUploads.length, 5);
  assert.equal(sku.productionAuthorization.lockedScope.stock, 100);
  assert.equal(sku.productionAuthorization.productionExecuted, false);
  assert.equal(sku.productionAuthorization.platformWrites, 0);
  assert.equal(sku.productionRecord, null);
});
