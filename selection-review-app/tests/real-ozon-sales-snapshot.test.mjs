import test from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN,
  classifyOzonSellerIdentity,
  collectRealOzonSalesSnapshot,
  createOzonCollectionFailure,
  validateSalesSnapshot
} from "../lib/sales-snapshot.mjs";

function realObservation(overrides = {}) {
  return {
    sourceMode: "real_ozon_page_observation",
    technicalStatus: "completed",
    snapshotId: "sales-snapshot:real-ozon-single-001",
    marketScope: "ozon_general_market",
    sellerIdentitySignals: [
      { field: "seller_display_name", value: "Example Shop", sourcePath: "dom.seller.name" }
    ],
    sellerIdentityEvidenceRef: "browser-dom:real-ozon-single-001:seller",
    productUrl: "https://www.ozon.ru/product/example-10001/",
    title: "Механический деревянный 3D-пазл Паровоз",
    imageRefs: ["https://ir.ozone.ru/example-10001.jpg"],
    currentPrice: 1831,
    currency: "RUB",
    categoryPath: "Хобби и творчество > 3D-пазл",
    attributes: { material: "Дерево", pieces: 320 },
    collectedAt: "2026-08-12T10:30:00.000Z",
    evidenceRef: "browser-dom:real-ozon-single-001",
    ...overrides
  };
}

test("real Ozon page observation generates a valid read-only SalesSnapshot", () => {
  const observation = realObservation();
  const before = structuredClone(observation);
  const snapshot = collectRealOzonSalesSnapshot(observation);

  assert.equal(snapshot.collectorMode, "real_page_read_only");
  assert.equal(snapshot.sellerType, UNKNOWN, "店名不能推断跨境身份");
  assert.equal(snapshot.sellerIdentityEvidence.status, "unverified");
  assert.deepEqual(validateSalesSnapshot(snapshot), { valid: true, errors: [] });
  assert.deepEqual(observation, before, "真实页面观察输入不得被修改");
  assert.equal(Object.isFrozen(snapshot), true);
});

test("cross_border_cn requires direct seller country evidence", () => {
  const weak = classifyOzonSellerIdentity([
    { field: "shipping_origin", value: "China", sourcePath: "dom.shipping" },
    { field: "seller_display_name", value: "CN Shop", sourcePath: "dom.seller.name" }
  ]);
  assert.equal(weak.sellerType, UNKNOWN);
  assert.equal(weak.status, "unverified");

  const direct = classifyOzonSellerIdentity([
    { field: "seller_registered_country", value: "CN", sourcePath: "dom.seller.legal.country" }
  ]);
  assert.equal(direct.sellerType, "cross_border_cn");
  assert.equal(direct.status, "verified");
});

test("a failed page read produces only technical failure and no SalesSnapshot", () => {
  const result = createOzonCollectionFailure({
    collectionId: "ozon-collection:phase5b:001",
    sourceCandidateId: "CX-20260803-010",
    sourceDataRevision: 25,
    productUrl: "https://www.ozon.ru/product/example-10001/",
    collectedAt: "2026-08-12T10:30:00.000Z",
    failureLayer: "ozon_antibot_challenge",
    reason: "页面要求完成人机验证，商品DOM不可读",
    evidenceRef: "browser-dom:phase5b:antibot"
  });

  assert.equal(result.technicalStatus, "data_acquisition_failed");
  assert.equal(result.businessStateEffect, "unchanged");
  assert.equal(result.snapshot, null);
  assert.equal(result.failure.retryAttempted, false);
  for (const forbidden of ["businessPhase", "businessResult", "ownerAction"]) {
    assert.equal(Object.hasOwn(result, forbidden), false, forbidden);
  }
});

test("failed technical observation cannot be converted into a snapshot", () => {
  assert.throws(
    () => collectRealOzonSalesSnapshot(realObservation({ technicalStatus: "data_acquisition_failed" })),
    /页面未成功读取时不得生成SalesSnapshot/
  );
});
