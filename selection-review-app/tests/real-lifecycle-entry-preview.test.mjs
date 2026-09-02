import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";

import { buildRealLifecycleEntryPreview } from "../lib/real-lifecycle-entry-preview.mjs";

test("CX-20260802-014 produces a read-only real lifecycle entry preview without guessing missing supply facts", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lifecycle-preview-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataPath = path.join(directory, "fixture.json");
  const fileBefore = Buffer.from(JSON.stringify({ candidates: [createMusicBoxCandidate()] }));
  await writeFile(dataPath, fileBefore);
  const document = JSON.parse(await readFile(dataPath, "utf8"));
  const candidate = document.candidates[0];
  const candidateBefore = JSON.stringify(candidate);

  const preview = buildRealLifecycleEntryPreview(candidate);

  assert.equal(preview.readOnly, true);
  assert.equal(preview.available, true);
  assert.equal(preview.sourceCandidateId, "CX-20260802-014");
  assert.equal(preview.sourceDataRevision, candidate.dataRevision);
  assert.equal(preview.opportunityPackage.parentOpportunityId, candidate.id);
  assert.equal(preview.salesEvidence.schemaValid, true);
  assert.equal(preview.salesEvidence.currentPrice, 1462);
  assert.equal(preview.salesEvidence.currency, "RUB");
  assert.equal(preview.salesEvidence.sellerType, "unknown");
  assert.equal(preview.salesEvidence.businessUseStatus, "pending_a_review");
  assert.equal(preview.supplierEvidence.sourceUrl, "https://detail.1688.com/offer/876240928352.html");
  assert.equal(candidate.sourceCapture.originalSourceUrl, "https://qr.1688.com/s/7OnLCakq");
  assert.equal(preview.supplierEvidence.supplierSkuId, null);
  assert.equal(preview.supplierEvidence.unitProductPrice, null);
  assert.equal(preview.supplierEvidence.unitDomesticFreight, null);
  assert.equal(preview.supplierEvidence.actualPurchaseCost, 17.3);
  assert.equal(preview.supplierEvidence.packedWeightKg, 0.4);
  assert.deepEqual(preview.supplierEvidence.dimensionsCm, { length: 12, width: 12, height: 7 });
  assert.equal(preview.supplierEvidence.historicalComponentsInferred, false);
  assert.equal(preview.readiness.classification, "B");
  assert.equal(preview.readiness.canEnterB, false);
  assert.equal(preview.readiness.canAutoEnterC1, false);
  const gaps = preview.readiness.missing.map((item) => item.key);
  assert.deepEqual(gaps, [
    "sales_comparability_review",
    "sales_validity_review",
    "supplier_sku",
    "unit_product_price",
    "unit_domestic_freight",
    "owner_supply_confirmation"
  ]);
  assert.equal(gaps.includes("seller_identity"), false);
  assert.deepEqual(preview.boundaries, {
    sharedCandidateWrites: 0,
    dispatchesCreated: 0,
    externalAccesses: 0,
    platformWrites: 0,
    businessStateChanged: false,
    automationStarted: false
  });
  assert.equal(JSON.stringify(candidate), candidateBefore);
  assert.deepEqual(await readFile(dataPath), fileBefore);
});
