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

test('current API connection route is closed and independent of historical media handoff metadata', async () => {
  const { ozonProductionConnectionRequirements, isOzonProductionConnectionRequirements } = await import('../lib/ozon-production-strategy.mjs');
  const expected = { contractVersion: 'ozon-connection-requirements-v1', route: 'seller_api', requiredConnections: ['api'] };
  assert.deepEqual(ozonProductionConnectionRequirements('seller_api'), expected);
  assert.equal(isOzonProductionConnectionRequirements(expected), true);
  for (const bad of [null, {}, { ...expected, extra: true }, { ...expected, route: 'browser' }, { ...expected, contractVersion: 'old' },
    { ...expected, requiredConnections: [] }, { ...expected, requiredConnections: ['api', 'api'] }, { ...expected, requiredConnections: ['sellerBackend'] }]) {
    assert.equal(isOzonProductionConnectionRequirements(bad), false);
  }
  assert.throws(() => ozonProductionConnectionRequirements('browser'), /ROUTE_UNSUPPORTED/);
  assert.throws(() => ozonProductionConnectionRequirements(''), /ROUTE_UNSUPPORTED/);
  assert.throws(() => ozonProductionConnectionRequirements('seller_api').requiredConnections.push('sellerBackend'), TypeError);
});
