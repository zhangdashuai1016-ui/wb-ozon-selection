import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  mapPhase4SingleSkuLifecycle,
  withTechnicalFailureDisplay
} from "../src/lifecycleStatusView.js";

async function currentCandidate(id = "CX-20260803-010") {
  const url = new URL("../data/candidates.json", import.meta.url);
  const document = JSON.parse(await readFile(url, "utf8"));
  return document.candidates.find((item) => item.id === id);
}

test("CX-20260803-010 renders the current four lifecycle states", async () => {
  const candidate = await currentCandidate();
  const status = mapPhase4SingleSkuLifecycle(candidate);
  assert.equal(status.available, true);
  assert.equal(status.businessPhase, candidate.lifecycleV11.skuPackage.businessPhase);
  assert.equal(status.businessResult, candidate.lifecycleV11.skuPackage.businessResult);
  assert.equal(status.technicalStatus, candidate.lifecycleV11.skuPackage.technicalStatus);
  assert.equal(status.ownerAction, candidate.lifecycleV11.skuPackage.ownerAction);
  assert.equal(status.productFailed, false);
  assert.equal(status.sourceDataRevision, candidate.dataRevision);
});

test("technical failure changes only the technical line and never becomes product failure", async () => {
  const candidate = await currentCandidate();
  const completed = mapPhase4SingleSkuLifecycle(candidate);
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

test("the lifecycle display mapping is limited to the approved single SKU and requires a package", async () => {
  const candidate = await currentCandidate();
  assert.equal(mapPhase4SingleSkuLifecycle({ ...candidate, id: "OTHER" }).available, false);
  assert.equal(mapPhase4SingleSkuLifecycle({ ...candidate, lifecycleV11: null }).reason, "lifecycle_package_missing");
});

test("display mapping does not mutate the shared candidate object", async () => {
  const candidate = await currentCandidate();
  const before = JSON.stringify(candidate);
  const status = mapPhase4SingleSkuLifecycle(candidate);
  withTechnicalFailureDisplay(status);
  assert.equal(JSON.stringify(candidate), before);
});
