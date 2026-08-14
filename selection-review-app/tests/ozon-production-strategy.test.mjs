import assert from "node:assert/strict";
import test from "node:test";
import {
  createOzonProductionStrategy,
  validateOzonProductionStrategy
} from "../lib/ozon-production-strategy.mjs";

test("Ozon local final assets require only one manual media handoff", () => {
  const strategy = createOzonProductionStrategy({
    platform: "ozon",
    finalUploads: [{ assetRef: "/Users/example/main.png" }, { assetRef: "/Users/example/detail.png" }]
  });
  assert.equal(strategy.primaryPath, "seller_api");
  assert.equal(strategy.mediaMode, "single_manual_local_file_selection");
  assert.equal(strategy.manualActionsRequired, 1);
  assert.equal(strategy.forbiddenBrowserActions.includes("fill_price"), true);
  assert.equal(strategy.priceFieldRule, "platform_write_price_cny_only");
  assert.deepEqual(validateOzonProductionStrategy(strategy), { valid: true, errors: [] });
});

test("Ozon remote final assets allow a zero-manual Seller API path", () => {
  const strategy = createOzonProductionStrategy({
    platform: "ozon",
    finalUploads: [{ assetRef: "https://cdn.example/main.png" }, { assetRef: "https://cdn.example/detail.png" }]
  });
  assert.equal(strategy.browserRole, "none");
  assert.equal(strategy.mediaMode, "seller_api_remote_urls");
  assert.equal(strategy.manualActionsRequired, 0);
});

test("Ozon production strategy never retries or starts another SKU", () => {
  const strategy = createOzonProductionStrategy({
    platform: "ozon",
    finalUploads: [{ assetRef: "/Users/example/main.png" }]
  });
  assert.equal(strategy.stopOnFailure, true);
  assert.equal(strategy.automaticRetry, false);
  assert.equal(strategy.nextSkuAutomaticStart, false);
});
