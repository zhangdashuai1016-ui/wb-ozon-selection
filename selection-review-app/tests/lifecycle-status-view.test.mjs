import test from "node:test";
import assert from "node:assert/strict";
import { createTrainCandidate, createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import {
  mapLifecycleStatus,
  withTechnicalFailureDisplay
} from "../src/lifecycleStatusView.js";

async function currentCandidate(id = "CX-20260803-010") {
  if (id === "CX-20260803-010") return createTrainCandidate();
  assert.equal(id, "CX-20260802-014");
  return createMusicBoxCandidate();
}

test("a stored SKU lifecycle package renders all four current state lines", async () => {
  const candidate = await currentCandidate();
  const status = mapLifecycleStatus(candidate);
  assert.equal(status.available, true);
  assert.equal(status.sourceEntityType, "SkuLifecyclePackage");
  assert.equal(status.businessPhase, candidate.lifecycleV11.skuPackage.businessPhase);
  assert.equal(status.businessResult, candidate.lifecycleV11.skuPackage.businessResult);
  assert.equal(status.technicalStatus, candidate.lifecycleV11.skuPackage.technicalStatus);
  assert.equal(status.ownerAction, candidate.lifecycleV11.skuPackage.ownerAction);
  assert.equal(status.productFailed, false);
  assert.equal(status.sourceDataRevision, candidate.dataRevision);
});

test("technical failure changes only the technical line and never becomes product failure", async () => {
  const candidate = await currentCandidate();
  const completed = mapLifecycleStatus(candidate);
  const failed = withTechnicalFailureDisplay(completed, {
    technicalStatus: "data_acquisition_failed",
    failureLayer: "ozon_snapshot_reader"
  });
  assert.equal(failed.businessPhase, completed.businessPhase);
  assert.equal(failed.businessResult, completed.businessResult);
  assert.equal(failed.ownerAction, completed.ownerAction);
  assert.equal(failed.technicalStatus, "data_acquisition_failed");
  assert.equal(failed.productFailed, false);
  assert.equal(failed.failureLayer, "ozon_snapshot_reader");
});

test("lifecycle display is no longer tied to a candidate ID and still requires a package", async () => {
  const candidate = await currentCandidate();
  const anotherSku = mapLifecycleStatus({ ...candidate, id: "OTHER-LIFECYCLE-SKU" });
  assert.equal(anotherSku.available, true);
  assert.equal(anotherSku.sourceCandidateId, "OTHER-LIFECYCLE-SKU");
  assert.equal(mapLifecycleStatus({ ...candidate, lifecycleV11: null }).reason, "lifecycle_package_missing");
});

test("an OpportunityPackage-only candidate renders its four lines without upgrading unknown to A", async () => {
  const candidate = structuredClone(await currentCandidate("CX-20260802-014"));
  delete candidate.lifecycleV11.skuPackage;
  candidate.lifecycleV11.opportunityPackage.businessPhase = "unknown";
  const status = mapLifecycleStatus(candidate);
  assert.equal(status.available, true);
  assert.equal(status.sourceEntityType, "OpportunityPackage");
  assert.equal(status.businessPhase, "unknown");
  assert.equal(status.businessResult, candidate.lifecycleV11.opportunityPackage.businessResult);
  assert.equal(status.technicalStatus, candidate.lifecycleV11.opportunityPackage.technicalStatus);
  assert.equal(status.ownerAction, candidate.lifecycleV11.opportunityPackage.ownerAction);
  assert.match(status.explanation, /unknown保持未确认/);
});

test("display mapping does not mutate the shared candidate object", async () => {
  const candidate = await currentCandidate();
  const before = JSON.stringify(candidate);
  const status = mapLifecycleStatus(candidate);
  withTechnicalFailureDisplay(status);
  assert.equal(JSON.stringify(candidate), before);
});
