import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoreIsolatedOzonSellerApiDEAdapter,
  inspectAdapterCapabilities,
  OZON_DE_READBACK_ENDPOINTS,
  resolveFinalUploads
} from "../lib/ozon-seller-api-de-adapter.mjs";

function finalUploads(host = "media.example") {
  return [1, 2].map((order) => ({
    assetId: `asset-${order}`,
    assetRef: `/local/asset-${order}.png`,
    sha256: String(order).repeat(64),
    order,
    role: order === 1 ? "main" : "detail",
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true,
    platformAcceptedUrl: `https://${host}/asset-${order}.png`
  }));
}

function capabilityInput({ store = "dandanshu", warehouseId = "70001", host = "media.example", assets = finalUploads(host) } = {}) {
  return {
    store,
    warehouseId,
    inspectedAt: "2026-08-22T03:00:00.000Z",
    storeIdentity: {
      status: "verified", expectedStore: store, observedStore: store,
      evidenceRef: `evidence:store:${store}`
    },
    productImport: {
      status: "verified", protocolVersion: "ozon-product-import-v3",
      endpoint: "/v3/product/import", statusEndpoint: "/v1/product/import/info",
      evidenceRef: "evidence:protocol:product-import"
    },
    assetTransport: {
      status: "verified", protocolVersion: "approved-https-assets-v1", mode: "preapproved_stable_https",
      approvedHosts: [host], evidenceRef: "evidence:protocol:assets",
      resolvedAssets: assets.map((asset) => ({
        assetId: asset.assetId,
        platformAcceptedUrl: asset.platformAcceptedUrl,
        sha256: asset.sha256,
        order: asset.order,
        authorizationStatus: "approved",
        stable: true,
        evidenceRef: `evidence:resolved:${asset.assetId}`
      }))
    },
    inventoryWrite: {
      status: "verified", protocolVersion: "ozon-products-stocks-v2",
      endpoint: "/v2/products/stocks", warehouseId,
      evidenceRef: "evidence:protocol:inventory"
    },
    independentReadback: {
      status: "verified", protocolVersion: "ozon-independent-readback-v1",
      endpoints: structuredClone(OZON_DE_READBACK_ENDPOINTS),
      evidenceRef: "evidence:protocol:readback"
    }
  };
}

function readyCapabilities(options = {}) {
  return inspectAdapterCapabilities(capabilityInput(options));
}

function executableRequest({ store = "dandanshu", warehouseId = "70001", offerId = "SUP-MUSIC-001" } = {}) {
  return {
    platform: "ozon",
    store,
    skuPackageId: `sku-lifecycle:GENERIC:${offerId}`,
    merchantSku: offerId,
    supplierSkuId: offerId,
    platformWritePrice: { amount: 117.85, currency: "CNY" },
    stock: 100,
    finalUploads: finalUploads().map((asset) => ({
      assetId: asset.assetId,
      platformAcceptedUrl: asset.platformAcceptedUrl,
      sha256: asset.sha256,
      order: asset.order
    })),
    productImport: {
      endpoint: "/v3/product/import",
      body: { items: [{ offer_id: offerId, price: "117.85", currency_code: "CNY" }] }
    },
    inventoryWrite: { endpoint: "/v2/products/stocks", warehouseId, stock: 100 },
    executionKey: `d-execution:${store}:${offerId}`,
    idempotencyKey: `d-execution:${store}:${offerId}`
  };
}

function readbackResponses({ offerId = "SUP-MUSIC-001", productId = "910001", saleStatus = "Продается", stateFailed = false, primaryInImages = false } = {}) {
  const primaryImage = "https://cdn.ozon/main.jpg";
  return {
    "/v4/product/info/attributes": {
      result: [{
        offer_id: offerId,
        id: Number(productId),
        sku: 810001,
        primary_image: primaryImage,
        images: primaryInImages ? [primaryImage, "https://cdn.ozon/detail.jpg"] : ["https://cdn.ozon/detail.jpg"]
      }]
    },
    "/v3/product/info/list": {
      items: [{
        offer_id: offerId, id: Number(productId), sku: 810001, name: "Музыкальная шкатулка", is_archived: false,
        statuses: { moderate_status: "approved", validation_status: "success", status_name: saleStatus, status_description: "" },
        errors: []
      }]
    },
    "/v5/product/info/prices": {
      items: [{ offer_id: offerId, product_id: Number(productId), price: { price: 117.85, currency_code: "CNY" } }]
    },
    "/v4/product/info/stocks": {
      items: [{ offer_id: offerId, product_id: Number(productId), stocks: [{ type: "rfbs", present: 103, reserved: 3 }] }]
    },
    "/v3/product/list": {
      result: { items: stateFailed ? [{ offer_id: offerId, product_id: Number(productId), errors: [{ code: "failed_update" }] }] : [] }
    }
  };
}

test("capability inspection requires exact store, warehouse, protocols, and four evidence groups", () => {
  const ready = readyCapabilities();
  assert.equal(ready.status, "ready");
  assert.equal(ready.store, "dandanshu");
  assert.equal(ready.warehouseId, "70001");
  assert.match(ready.evidenceRef, /^ozon-adapter-capabilities:/);

  const missingAssets = capabilityInput();
  missingAssets.assetTransport.status = "unknown";
  missingAssets.assetTransport.evidenceRef = "";
  const blocked = inspectAdapterCapabilities(missingAssets);
  assert.equal(blocked.status, "not_ready");
  assert.ok(blocked.gaps.some((item) => item.code === "asset_transport_not_verified"));

  const crossStore = capabilityInput();
  crossStore.storeIdentity.observedStore = "miska";
  assert.equal(inspectAdapterCapabilities(crossStore).status, "not_ready");
});

test("final upload resolution accepts only capability-approved stable HTTPS URLs", () => {
  const assets = finalUploads();
  const ready = readyCapabilities({ assets });
  const resolved = resolveFinalUploads({ finalUploads: assets, adapterCapabilities: ready });
  assert.equal(resolved.status, "ready");
  assert.deepEqual(resolved.resolvedAssets.map((asset) => asset.platformAcceptedUrl), [
    "https://media.example/asset-1.png", "https://media.example/asset-2.png"
  ]);

  const localOnlyInput = capabilityInput({ assets });
  localOnlyInput.assetTransport.resolvedAssets = [];
  const localOnly = resolveFinalUploads({
    finalUploads: assets,
    adapterCapabilities: inspectAdapterCapabilities(localOnlyInput)
  });
  assert.equal(localOnly.status, "not_ready");

  const tmpAssets = finalUploads("tmpfiles.org");
  const tmpCapabilities = inspectAdapterCapabilities(capabilityInput({ host: "tmpfiles.org", assets: tmpAssets }));
  assert.equal(tmpCapabilities.status, "not_ready");
  assert.equal(resolveFinalUploads({ finalUploads: tmpAssets, adapterCapabilities: tmpCapabilities }).status, "not_ready");

  const unapproved = structuredClone(capabilityInput({ assets }));
  unapproved.assetTransport.approvedHosts = ["another.example"];
  const unapprovedCapabilities = inspectAdapterCapabilities(unapproved);
  assert.equal(resolveFinalUploads({ finalUploads: assets, adapterCapabilities: unapprovedCapabilities }).status, "not_ready");
});

test("executeSellerApi performs one import, one task read, then one exact stock-100 write", async () => {
  const calls = [];
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.endpoint === "/v3/product/import") return { result: { task_id: 501 } };
      if (request.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, status: "imported", errors: [] }] } };
      if (request.endpoint === "/v2/products/stocks") return { result: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
      throw new Error(`unexpected ${request.endpoint}`);
    }
  });
  const result = await adapter.executeSellerApi(executableRequest());
  assert.equal(result.status, "accepted");
  assert.equal(result.productId, "910001");
  assert.equal(result.offerId, "SUP-MUSIC-001");
  assert.match(result.requestReceiptRef, /^ozon-import-receipt:/);
  assert.match(result.inventoryReceiptRef, /^ozon-inventory-receipt:/);
  assert.deepEqual(calls.map((call) => [call.store, call.endpoint, call.write]), [
    ["dandanshu", "/v3/product/import", true],
    ["dandanshu", "/v1/product/import/info", false],
    ["dandanshu", "/v2/products/stocks", true]
  ]);
  assert.deepEqual(calls[2].body, { stocks: [{ offer_id: "SUP-MUSIC-001", stock: 100, warehouse_id: 70001 }] });
});

test("executeSellerApi stops after the first ambiguous layer and never retries or writes stock early", async () => {
  let calls = 0;
  const transportAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async () => { calls += 1; throw new Error("timeout"); }
  });
  const transport = await transportAdapter.executeSellerApi(executableRequest());
  assert.equal(transport.status, "unknown_outcome");
  assert.equal(transport.layer, "product_import_transport");
  assert.equal(transport.retryAllowed, false);
  assert.equal(calls, 1);

  const mismatchCalls = [];
  const mismatchAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async (request) => {
      mismatchCalls.push(request.endpoint);
      if (request.endpoint === "/v3/product/import") return { result: { task_id: 502 } };
      return { result: { items: [{ offer_id: "WRONG-SKU", product_id: 910001, status: "imported", errors: [] }] } };
    }
  });
  const mismatch = await mismatchAdapter.executeSellerApi(executableRequest());
  assert.equal(mismatch.status, "unknown_outcome");
  assert.equal(mismatch.layer, "product_import_identity");
  assert.deepEqual(mismatchCalls, ["/v3/product/import", "/v1/product/import/info"]);

  const inventoryCalls = [];
  const inventoryAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async (request) => {
      inventoryCalls.push(request.endpoint);
      if (request.endpoint === "/v3/product/import") return { result: { task_id: 503 } };
      if (request.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, status: "imported", errors: [] }] } };
      return { result: [] };
    }
  });
  const inventory = await inventoryAdapter.executeSellerApi(executableRequest());
  assert.equal(inventory.status, "unknown_outcome");
  assert.equal(inventory.layer, "inventory_write_receipt");
  assert.equal(inventoryCalls.length, 3);
});

test("cross-store and cross-SKU requests are rejected before any platform call", async () => {
  let calls = 0;
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async () => { calls += 1; return {}; }
  });
  const wrongStore = await adapter.executeSellerApi(executableRequest({ store: "miska" }));
  assert.equal(wrongStore.status, "rejected_before_write");
  const wrongSkuRequest = executableRequest();
  wrongSkuRequest.productImport.body.items[0].offer_id = "OTHER-SKU";
  const wrongSku = await adapter.executeSellerApi(wrongSkuRequest);
  assert.equal(wrongSku.status, "rejected_before_write");
  assert.equal(calls, 0);
});

test("independent readback works in a fresh adapter without process-local submission state", async () => {
  const calls = [];
  const responses = readbackResponses();
  const restartedAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async (request) => {
      calls.push(request);
      return structuredClone(responses[request.endpoint]);
    }
  });
  const result = await restartedAdapter.readbackSellerApi({
    mode: "independent_read_only",
    platform: "ozon",
    store: "dandanshu",
    skuPackageId: "sku-lifecycle:GENERIC:SUP-MUSIC-001",
    platformProductId: "910001",
    merchantSku: "SUP-MUSIC-001",
    supplierSkuId: "SUP-MUSIC-001",
    writeAllowed: false
  });
  assert.deepEqual(calls.map((call) => [call.endpoint, call.write]), [
    ["/v4/product/info/attributes", false],
    ["/v3/product/info/list", false],
    ["/v5/product/info/prices", false],
    ["/v4/product/info/stocks", false],
    ["/v3/product/list", false]
  ]);
  assert.deepEqual(result.currentPrice, { amount: 117.85, currency: "CNY" });
  assert.equal(result.currentStock, 100);
  assert.equal(result.imageCount, 2);
  assert.equal(result.moderationStatus, "approved");
  assert.equal(result.validationStatus, "success");
  assert.equal(result.saleStatus, "on_sale");
  assert.deepEqual(result.errors, []);
  assert.match(result.platformEvidenceRef, /^ozon-independent-readback:/);
});

test("independent readback counts unique image URLs whether images includes primary_image or not", async () => {
  for (const primaryInImages of [true, false]) {
    const responses = readbackResponses({ primaryInImages });
    const adapter = createStoreIsolatedOzonSellerApiDEAdapter({
      adapterCapabilities: readyCapabilities(),
      requestJson: async ({ endpoint }) => structuredClone(responses[endpoint])
    });
    const result = await adapter.readbackSellerApi({
      platform: "ozon",
      store: "dandanshu",
      platformProductId: "910001",
      merchantSku: "SUP-MUSIC-001",
      supplierSkuId: "SUP-MUSIC-001",
      writeAllowed: false
    });
    assert.equal(result.imageCount, 2, `primaryInImages=${primaryInImages}`);
  }
});

test("independent readback rejects identity drift and reports STATE_FAILED as an error", async () => {
  const driftResponses = readbackResponses();
  driftResponses["/v5/product/info/prices"].items[0].product_id = 999999;
  const driftAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async ({ endpoint }) => structuredClone(driftResponses[endpoint])
  });
  await assert.rejects(() => driftAdapter.readbackSellerApi({
    platform: "ozon", store: "dandanshu", platformProductId: "910001",
    merchantSku: "SUP-MUSIC-001", supplierSkuId: "SUP-MUSIC-001", writeAllowed: false
  }), /IDENTITY_MISMATCH: prices/);

  const failedResponses = readbackResponses({ stateFailed: true });
  const failedAdapter = createStoreIsolatedOzonSellerApiDEAdapter({
    adapterCapabilities: readyCapabilities(),
    requestJson: async ({ endpoint }) => structuredClone(failedResponses[endpoint])
  });
  const failed = await failedAdapter.readbackSellerApi({
    platform: "ozon", store: "dandanshu", platformProductId: "910001",
    merchantSku: "SUP-MUSIC-001", supplierSkuId: "SUP-MUSIC-001", writeAllowed: false
  });
  assert.equal(failed.errors.some((item) => item.source === "STATE_FAILED"), true);
});
