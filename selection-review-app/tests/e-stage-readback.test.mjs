import test from "node:test";
import assert from "node:assert/strict";
import {
  createExternalListingRecord,
  validateEVerificationRecord,
  validateExternalListingRecord,
  verifyExternalListing,
  verifySystemCreatedListing
} from "../lib/e-stage-readback.mjs";

const observed = {
  platform: "ozon",
  store: "dandanshu",
  skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
  supplierSkuId: "4993364145574",
  platformProductId: "5453271207",
  merchantSku: "4993364145574",
  currentPrice: { amount: 153, currency: "CNY" },
  currentStock: 100,
  imageCount: 10,
  moderationStatus: "approved",
  validationStatus: "success",
  saleStatus: "on_sale",
  errors: [],
  platformEvidenceRef: "ozon-seller-api:store-a:4993364145574:2026-08-13T09:31:31.666Z"
};

const decision = {
  decision: "keep_current_live_price",
  confirmedBy: "owner",
  confirmedAt: "2026-08-13T09:20:00.000Z",
  price: { amount: 153, currency: "CNY" }
};

test("external discovery creates ExternalListingRecord and E ends externally_verified", () => {
  const external = createExternalListingRecord({
    observation: { ...observed, discoverySource: "seller_portal", platformEvidenceRef: "ozon-seller-portal:product-row:5453271207" },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.equal(validateExternalListingRecord(external).valid, true);
  assert.equal(external.createdByCurrentRun, false);
  const verified = verifyExternalListing({ externalListingRecord: external, verifiedObservation: observed, verifiedAt: "2026-08-13T09:31:31.666Z" });
  assert.equal(validateEVerificationRecord(verified).valid, true);
  assert.equal(verified.sourceRecordType, "ExternalListingRecord");
  assert.equal(verified.outcome, "externally_verified");
  assert.equal(verified.createdByCurrentRun, false);
  assert.equal(verified.imageCount, 10);
});

test("system-created E path requires ProductionRecord and ends listed_verified", () => {
  const productionRecord = {
    productionRecordId: "production-record:one",
    platformProductId: "5453271207",
    supplierSkuId: "4993364145574"
  };
  const verified = verifySystemCreatedListing({
    productionRecord,
    verifiedObservation: observed,
    verifiedAt: "2026-08-13T09:31:31.666Z",
    ownerPriceDecision: decision
  });
  assert.equal(verified.sourceRecordType, "ProductionRecord");
  assert.equal(verified.outcome, "listed_verified");
  assert.equal(verified.createdByCurrentRun, true);
});

test("external path rejects identity or retained-price drift", () => {
  const external = createExternalListingRecord({
    observation: { ...observed, discoverySource: "seller_portal" },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.throws(() => verifyExternalListing({
    externalListingRecord: external,
    verifiedObservation: { ...observed, platformProductId: "OTHER" },
    verifiedAt: "2026-08-13T09:31:31.666Z"
  }), /IDENTITY_MISMATCH/);
  assert.throws(() => verifyExternalListing({
    externalListingRecord: external,
    verifiedObservation: { ...observed, currentPrice: { amount: 151.78, currency: "CNY" } },
    verifiedAt: "2026-08-13T09:31:31.666Z"
  }), /PRICE_MISMATCH/);
});

test("unknown image, stock, moderation or errors remain explicit instead of inferred", () => {
  const external = createExternalListingRecord({
    observation: {
      ...observed,
      discoverySource: "seller_portal",
      currentStock: "unknown",
      imageCount: "unknown",
      moderationStatus: "unknown",
      validationStatus: "unknown",
      errors: "unknown"
    },
    ownerPriceDecision: decision,
    discoveredAt: "2026-08-13T09:25:00.000Z"
  });
  assert.equal(validateExternalListingRecord(external).valid, true);
  assert.equal(external.imageCount, "unknown");
  assert.equal(external.errors, "unknown");
});
