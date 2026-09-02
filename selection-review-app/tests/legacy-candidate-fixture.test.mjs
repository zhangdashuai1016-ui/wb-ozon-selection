import assert from "node:assert/strict";
import test from "node:test";
import { validateOpportunityPackage, validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { validateEVerificationRecord, validateExternalListingRecord } from "../lib/e-stage-readback.mjs";
import { createTrainCandidate, createMusicBoxCandidate, createLegacyCandidateDocument, createAuthorizedTrainCandidate, createGenericCStageCandidate, createVerifiedGenericCandidate } from "./helpers/legacy-candidate-fixture.mjs";

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

test("synthetic generic C-stage baseline is valid and contains no frozen train SKU facts", () => {
  const candidate = createGenericCStageCandidate();
  const { opportunityPackage, skuPackage } = candidate.lifecycleV11;
  assert.deepEqual(validateOpportunityPackage(opportunityPackage), { valid: true, errors: [] });
  assert.deepEqual(validateSkuLifecyclePackage(skuPackage), { valid: true, errors: [] });
  assert.equal(candidate.id, "GENERIC-NON-TRAIN-001");
  assert.equal(skuPackage.supplierSkuId, "SINK-ORGANIZER-BLUE");
  assert.equal(skuPackage.businessPhase, "B");
  assert.equal(skuPackage.businessResult, "passed");
  assert.equal(opportunityPackage.salesSnapshots[0].currentPrice, 1200);
  assert.equal(skuPackage.profitModels[0].recommendedSalePriceRub, 1200);
  assert.equal(skuPackage.productionAuthorization, null);
  assert.equal(skuPackage.productionRecord, null);
  assert.equal(candidate.lifecycleV11.platformWrites, 0);
  for (const forbidden of ["CX-20260803-010", "4993364145574", "豪华小火车", "Паровоз", "DVP", "282"]) {
    assert.equal(JSON.stringify(skuPackage).includes(forbidden), false, forbidden);
  }
  skuPackage.skuFacts.material = "test-mutation";
  assert.equal(createGenericCStageCandidate().lifecycleV11.skuPackage.skuFacts.material, "silicone");
});

test("synthetic E idempotency baseline is a valid observation record, not a production execution", () => {
  const candidate = createVerifiedGenericCandidate();
  const sku = candidate.lifecycleV11.skuPackage;
  assert.equal(candidate.id, "GENERIC-LIFECYCLE-E-READBACK");
  assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
  assert.deepEqual(validateExternalListingRecord(sku.externalListingRecord), { valid: true, errors: [] });
  assert.deepEqual(validateEVerificationRecord(sku.eVerificationRecord), { valid: true, errors: [] });
  assert.equal(sku.eVerificationRecord.sourceRecordId, sku.externalListingRecord.externalListingRecordId);
  assert.equal(sku.eVerificationRecord.skuPackageId, sku.skuPackageId);
  assert.equal(sku.eVerificationRecord.createdByCurrentRun, false);
  assert.equal(sku.eVerificationRecord.verificationPath, "external_discovered");
  assert.equal(sku.productionRecord, null);
  assert.equal(sku.productionAuthorization.productionExecuted, false);
  assert.equal(candidate.lifecycleV11.platformWrites, 0);
  assert.deepEqual(sku.productionAuthorization, createAuthorizedTrainCandidate().lifecycleV11.skuPackage.productionAuthorization);
  sku.eVerificationRecord.platformProductId = "test-mutation";
  assert.equal(createVerifiedGenericCandidate().lifecycleV11.skuPackage.eVerificationRecord.platformProductId, "TEST-EXTERNALLY-VERIFIED-001");
});
