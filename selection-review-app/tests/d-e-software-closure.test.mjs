import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createProductionPlan } from "../lib/production-plan.mjs";
import { runPlatformWritePreflight } from "../lib/platform-write-preflight.mjs";
import {
  beginDSoftwareExecution,
  executeDSoftwareAttempt,
  prepareSingleSkuDExecution,
  runSystemCreatedEReadback
} from "../lib/d-e-software-closure.mjs";
import {
  createExternalListingRecord,
  verifyExternalListing
} from "../lib/e-stage-readback.mjs";
import {
  createStoreIsolatedOzonSellerApiDEAdapter,
  inspectAdapterCapabilities,
  OZON_DE_READBACK_ENDPOINTS
} from "../lib/ozon-seller-api-de-adapter.mjs";

const ALL_WRITE_FIELDS = [
  "create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"
];

function authorizationFixture({
  store = "dandanshu",
  skuPackageId = "sku-lifecycle:GENERIC-MUSIC-BOX:SUP-MUSIC-001",
  supplierSkuId = "SUP-MUSIC-001",
  assetRefs = ["https://assets.example/music-main.jpg", "https://assets.example/music-detail.jpg"]
} = {}) {
  return {
    schemaVersion: "production-authorization-v1.1",
    authorizationId: `production-auth:${skuPackageId}:7`,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt: "2026-08-22T01:00:00.000Z",
    sourceConfirmationCardId: `final-plan-card:${skuPackageId}:7`,
    authorizedDataRevision: 7,
    lockedScope: {
      platform: "ozon",
      store,
      skuPackageId,
      supplierSkuId,
      variantKey: "mechanical-music-box",
      titleVersion: "c1-seo-draft:generic-music-box:v1",
      title: "Механическая музыкальная шкатулка — швейная машинка",
      contentVersion: "c1-seo-draft:generic-music-box:v1",
      content: {
        locale: "ru-RU",
        description: "Механическая музыкальная шкатулка в форме швейной машинки.",
        bulletPoints: ["Механизм с ручным заводом."],
        searchKeywords: ["музыкальная шкатулка", "швейная машинка"]
      },
      attributeVersion: "c1-facts:generic-music-box:v1",
      attributes: {
        requiredPlatformFields: [
          { fieldKey: "85", fact: { value: { value: "Нет бренда", dictionaryValueId: 1001 }, verificationStatus: "confirmed" } },
          { fieldKey: "9048", fact: { value: "Швейная машинка", verificationStatus: "confirmed" } },
          { fieldKey: "8229", fact: { value: { value: "Музыкальная шкатулка", dictionaryValueId: 2001 }, verificationStatus: "confirmed" } }
        ]
      },
      packing: {
        weight: { value: 0.4, unit: "kg" },
        dimensions: { length: 12, width: 12, height: 7, unit: "cm" }
      },
      schemaWriteBindings: {
        schemaRevision: "ozon-schema:music-box:2026-08-22",
        evidenceRef: "evidence:schema:music-box:2026-08-22",
        content: {
          title: { fieldKey: "title", attributeId: 4180, complexId: 0, dictionaryId: 0 },
          description: { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 },
          searchKeywords: { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 }
        },
        requiredAttributes: [
          { fieldKey: "85", attributeId: 85, complexId: 0, dictionaryId: 301 },
          { fieldKey: "9048", attributeId: 9048, complexId: 0, dictionaryId: 0 },
          { fieldKey: "8229", attributeId: 8229, complexId: 0, dictionaryId: 302 }
        ]
      },
      platformCategory: {
        descriptionCategoryId: { value: 17028973, verificationStatus: "confirmed" },
        typeId: { value: 92849, verificationStatus: "confirmed" }
      },
      recommendedPrice: { rub: 1422, cny: 117.85 },
      buyerTargetPrice: { amount: 1422, currency: "RUB" },
      platformWritePrice: { amount: 117.85, currency: "CNY" },
      priceConversion: {
        rubPerCny: 12.0662,
        evidenceRef: "evidence:fx:RUB-CNY:2026-08-22",
        checkedAt: "2026-08-22T00:00:00.000Z"
      },
      stock: 100,
      assetsFinalUploadsVersion: `c2-final:${skuPackageId}:v3`,
      finalUploads: assetRefs.map((assetRef, index) => ({
        assetId: `final:${supplierSkuId}:${index + 1}`,
        assetRef,
        sha256: String(index + 1).repeat(64),
        order: index + 1,
        role: index === 0 ? "main" : "detail",
        lifecycleArea: "finalUploads",
        ownerConfirmed: true,
        productionEligible: true
      })),
      publishScope: "create_and_allow_validation_moderation",
      exclusions: ["no_publish_or_activation", "no_promotion_change", "no_advertising_change", "no_other_sku_write"],
      allowedWriteFields: [...ALL_WRITE_FIELDS]
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
}

async function preflightFixture(plan, { store = plan.store, writableFields = ALL_WRITE_FIELDS } = {}) {
  return runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-22T01:10:00.000Z",
    inspectPlatform: async () => ({
      observedStore: store,
      storeIdentityStatus: store === plan.store ? "matched" : "mismatched",
      storeIdentityEvidenceRef: `evidence:seller-api:store:${store}`,
      permissionStatus: "verified",
      permissionEvidenceRef: "evidence:seller-api:permission",
      connections: {
        api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "evidence:seller-api:connection" },
        sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "evidence:seller-backend:connection" }
      },
      platformWritableFields: writableFields,
      imagePermissionStatus: "verified",
      imagePermissionEvidenceRef: "evidence:seller-api:image-permission",
      priceFieldCurrency: "CNY",
      priceCurrencyEvidenceRef: "evidence:seller-api:currency:CNY",
      risks: []
    })
  });
}

function capabilities(store = "dandanshu", finalUploads = []) {
  const resolvedAssets = finalUploads.map((asset) => ({
    assetId: asset.assetId,
    platformAcceptedUrl: asset.assetRef,
    sha256: asset.sha256,
    order: asset.order,
    authorizationStatus: "approved",
    stable: true,
    evidenceRef: `evidence:asset:${asset.assetId}`
  }));
  return {
    status: "ready",
    platform: "ozon",
    store,
    adapterVersion: "ozon-seller-api-adapter:contract-test-v1",
    evidenceRef: "evidence:adapter:contract-test",
    productImport: { status: "verified", evidenceRef: "evidence:protocol:product-import" },
    assetTransport: {
      status: "verified",
      evidenceRef: "evidence:protocol:asset-transport",
      approvedHosts: ["assets.example"],
      resolvedAssets
    },
    inventoryWrite: {
      status: "verified",
      endpoint: "/fixture/inventory/write",
      warehouseId: "fixture-warehouse-dandanshu",
      protocolVersion: "fixture-inventory-v1",
      evidenceRef: "evidence:protocol:inventory"
    },
    independentReadback: { status: "verified", evidenceRef: "evidence:protocol:readback" }
  };
}

async function preparedFixture(options = {}) {
  const authorization = authorizationFixture(options);
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: "2026-08-22T01:05:00.000Z" });
  const preflight = await preflightFixture(plan, options.preflight || {});
  const prepared = prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    adapterCapabilities: options.adapterCapabilities || capabilities(plan.store, plan.finalUploads),
    preparedAt: "2026-08-22T01:15:00.000Z"
  });
  return { authorization, plan, preflight, prepared };
}

function exactObservation(request, overrides = {}) {
  return {
    platform: request.platform,
    store: request.store,
    skuPackageId: request.skuPackageId,
    supplierSkuId: request.supplierSkuId,
    merchantSku: request.merchantSku,
    platformProductId: "910001",
    currentPrice: structuredClone(request.platformWritePrice || request.expectedPrice),
    currentStock: 100,
    imageCount: request.finalUploads?.length ?? request.expectedImageCount,
    moderationStatus: "in_moderation",
    validationStatus: "processing",
    saleStatus: "not_for_sale",
    errors: [],
    platformEvidenceRef: "evidence:seller-api:readback:910001",
    ...overrides
  };
}

async function successfulExecution() {
  const { prepared } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T01:20:00.000Z" });
  const result = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: async (request) => ({
      status: "accepted",
      productId: "910001",
      offerId: request.merchantSku,
      requestReceiptRef: "receipt:product-import:910001",
      inventoryReceiptRef: "receipt:inventory:910001"
    }),
    readbackSellerApi: async (request) => exactObservation(attempt.request, { platformProductId: request.platformProductId }),
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  return { attempt, result };
}

test("D only consumes the bound authorization plan and emits one generic Ozon Seller API request", async () => {
  const { authorization, plan, prepared } = await preparedFixture();
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.executableRequest.sourceAuthorizationId, authorization.authorizationId);
  assert.equal(prepared.executableRequest.sourceProductionPlanId, plan.planId);
  assert.equal(prepared.executableRequest.store, "dandanshu");
  assert.equal(prepared.executableRequest.merchantSku, "SUP-MUSIC-001");
  assert.deepEqual(prepared.executableRequest.platformWritePrice, { amount: 117.85, currency: "CNY" });
  assert.equal(prepared.executableRequest.stock, 100);
  assert.equal(prepared.executableRequest.finalUploads.length, 2);
  assert.equal(prepared.executableRequest.publishScope, "create_and_allow_validation_moderation");
  assert.equal(prepared.executionPolicy.browserFallback, false);
  assert.equal(prepared.executionPolicy.manualFallback, false);
  assert.equal(prepared.executionPolicy.codexDispatch, false);
  for (const forbidden of ["salesSnapshot", "profitModel", "c1ProductPlan", "collected", "aiDrafts"]) {
    assert.equal(forbidden in prepared.executableRequest, false);
  }
});

test("D returns not_ready for local-only finalUploads and never invents browser or manual fallback", async () => {
  const local = await preparedFixture({ assetRefs: ["/fixtures/music-main.jpg", "/fixtures/music-detail.jpg"] });
  assert.equal(local.prepared.status, "not_ready");
  assert.equal(local.prepared.executableRequest, null);
  assert.ok(local.prepared.gaps.some((item) => item.code === "platform_asset_url_not_approved"));
  assert.equal(local.prepared.executionPolicy.browserFallback, false);
  assert.equal(local.prepared.executionPolicy.manualFallback, false);

  const missingTransportEvidence = capabilities();
  delete missingTransportEvidence.assetTransport.evidenceRef;
  const remoteWithoutProtocol = await preparedFixture({ adapterCapabilities: missingTransportEvidence });
  assert.equal(remoteWithoutProtocol.prepared.status, "not_ready");
  assert.ok(remoteWithoutProtocol.prepared.gaps.some((item) => item.code === "asset_transport_protocol_not_ready"));
});

test("D rejects missing authorization, authorization drift, and cross-store preflight", async () => {
  const authorization = authorizationFixture();
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: "2026-08-22T01:05:00.000Z" });
  const preflight = await preflightFixture(plan);
  assert.throws(() => prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: null,
    platformWritePreflight: preflight,
    adapterCapabilities: capabilities(plan.store, plan.finalUploads),
    preparedAt: "2026-08-22T01:15:00.000Z"
  }), /ProductionAuthorization/);
  const drifted = structuredClone(authorization);
  drifted.lockedScope.title = "Подменённое название";
  assert.throws(() => prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: drifted,
    platformWritePreflight: preflight,
    adapterCapabilities: capabilities(plan.store, plan.finalUploads),
    preparedAt: "2026-08-22T01:15:00.000Z"
  }), /AUTHORIZATION_DRIFT/);
  const crossStore = await preparedFixture({ preflight: { store: "miska" } });
  assert.equal(crossStore.prepared.status, "not_ready");
  assert.ok(crossStore.prepared.gaps.some((item) => item.code === "store_identity_not_ready"));
});

test("D intent is deterministic, persisted before write, and idempotent per authorization and plan", async () => {
  const first = await preparedFixture();
  const second = await preparedFixture();
  assert.equal(first.prepared.executableRequest.executionKey, second.prepared.executableRequest.executionKey);
  const attempt = beginDSoftwareExecution({ preparedExecution: first.prepared, startedAt: "2026-08-22T01:20:00.000Z" });
  assert.equal(attempt.status, "in_flight");
  assert.equal(attempt.persistBeforeWrite, true);
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.retryAllowed, false);
});

test("D creates ProductionRecord only after real IDs, receipts, and exact independent readback", async () => {
  const { attempt, result } = await successfulExecution();
  assert.equal(result.status, "succeeded");
  assert.equal(result.productionRecord.platformProductId, "910001");
  assert.equal(result.productionRecord.platformOfferId, "SUP-MUSIC-001");
  assert.equal(result.productionRecord.sourceProductionPlanId, attempt.request.sourceProductionPlanId);
  assert.equal(result.productionRecord.sourceAuthorizationId, attempt.request.sourceAuthorizationId);
  assert.equal(result.productionRecord.stockWritten, 100);
  assert.equal(result.productionRecord.imagesUploaded, 2);
  assert.equal(result.productionRecord.independentReadbackVerified, true);
});

test("real adapter contract integrates with D execution and E readback without submission memory", async () => {
  const authorization = authorizationFixture();
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: "2026-08-22T01:05:00.000Z" });
  const preflight = await preflightFixture(plan);
  const adapterCapabilities = inspectAdapterCapabilities({
    store: plan.store,
    warehouseId: "70001",
    inspectedAt: "2026-08-22T01:10:00.000Z",
    storeIdentity: { status: "verified", expectedStore: plan.store, observedStore: plan.store, evidenceRef: "evidence:store:dandanshu" },
    productImport: {
      status: "verified", protocolVersion: "ozon-product-import-v3", endpoint: "/v3/product/import",
      statusEndpoint: "/v1/product/import/info", evidenceRef: "evidence:product-import"
    },
    assetTransport: {
      status: "verified", protocolVersion: "approved-assets-v1", mode: "preapproved_stable_https",
      approvedHosts: ["assets.example"], evidenceRef: "evidence:assets",
      resolvedAssets: plan.finalUploads.map((asset) => ({
        assetId: asset.assetId, platformAcceptedUrl: asset.assetRef, sha256: asset.sha256, order: asset.order,
        authorizationStatus: "approved", stable: true, evidenceRef: `evidence:asset:${asset.assetId}`
      }))
    },
    inventoryWrite: {
      status: "verified", protocolVersion: "ozon-stock-v2", endpoint: "/v2/products/stocks",
      warehouseId: "70001", evidenceRef: "evidence:inventory"
    },
    independentReadback: {
      status: "verified", protocolVersion: "ozon-readback-v1",
      endpoints: structuredClone(OZON_DE_READBACK_ENDPOINTS), evidenceRef: "evidence:readback"
    }
  });
  const prepared = prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    adapterCapabilities,
    preparedAt: "2026-08-22T01:15:00.000Z"
  });
  assert.equal(prepared.status, "ready");
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T01:20:00.000Z" });
  let listed = false;
  const requestJson = async ({ endpoint }) => {
    if (endpoint === "/v3/product/import") return { result: { task_id: 701 } };
    if (endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, status: "imported", errors: [] }] } };
    if (endpoint === "/v2/products/stocks") return { result: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
    if (endpoint === "/v4/product/info/attributes") return { result: [{ offer_id: "SUP-MUSIC-001", id: 910001, primary_image: "https://cdn.ozon/main.jpg", images: ["https://cdn.ozon/detail.jpg"] }] };
    if (endpoint === "/v3/product/info/list") return { items: [{
      offer_id: "SUP-MUSIC-001", id: 910001, is_archived: false,
      statuses: {
        moderate_status: listed ? "approved" : "in_moderation",
        validation_status: listed ? "success" : "processing",
        status_name: listed ? "Продается" : "Создаётся"
      },
      errors: []
    }] };
    if (endpoint === "/v5/product/info/prices") return { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, price: { price: 117.85, currency_code: "CNY" } }] };
    if (endpoint === "/v4/product/info/stocks") return { items: [{ offer_id: "SUP-MUSIC-001", product_id: 910001, stocks: [{ type: "rfbs", present: 100, reserved: 0 }] }] };
    if (endpoint === "/v3/product/list") return { result: { items: [] } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities });
  const execution = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: adapter.executeSellerApi,
    readbackSellerApi: adapter.readbackSellerApi,
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.productionRecord.platformProductId, "910001");
  assert.equal(execution.productionRecord.stockWritten, 100);

  listed = true;
  const restartedAdapter = createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities });
  const eResult = await runSystemCreatedEReadback({
    productionRecord: execution.productionRecord,
    readPlatform: restartedAdapter.readbackSellerApi,
    verifiedAt: "2026-08-22T02:00:00.000Z"
  });
  assert.equal(eResult.status, "verified");
  assert.equal(eResult.outcome, "listed_verified");
});

test("D marks transport, ambiguous response, and readback mismatch unknown without retry or record", async () => {
  const { prepared } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T01:20:00.000Z" });
  const transport = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: async () => { throw new Error("connection reset"); },
    readbackSellerApi: async () => { throw new Error("must not run"); },
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  assert.equal(transport.status, "unknown_outcome");
  assert.equal(transport.retryAllowed, false);
  assert.equal(transport.productionRecord, null);
  await assert.rejects(() => executeDSoftwareAttempt({
    executionAttempt: transport,
    executeSellerApi: async () => ({}),
    readbackSellerApi: async () => ({}),
    completedAt: "2026-08-22T01:30:00.000Z"
  }), /ATTEMPT_STATE_REJECTED/);

  const ambiguous = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: async () => ({ status: "accepted", productId: "910001", offerId: "WRONG" }),
    readbackSellerApi: async () => ({}),
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  assert.equal(ambiguous.status, "unknown_outcome");
  assert.equal(ambiguous.productionRecord, null);

  const mismatch = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: async (request) => ({
      status: "accepted", productId: "910001", offerId: request.merchantSku,
      requestReceiptRef: "receipt:product", inventoryReceiptRef: "receipt:inventory"
    }),
    readbackSellerApi: async () => exactObservation(attempt.request, { currentStock: 0 }),
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  assert.equal(mismatch.status, "unknown_outcome");
  assert.match(mismatch.reason, /currentStock/);
  assert.equal(mismatch.productionRecord, null);
});

test("D preserves a known pre-write rejection as failed without ProductionRecord", async () => {
  const { prepared } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T01:20:00.000Z" });
  const result = await executeDSoftwareAttempt({
    executionAttempt: attempt,
    executeSellerApi: async () => ({ status: "rejected_before_write", writeOccurred: false, code: "schema_rejected" }),
    readbackSellerApi: async () => { throw new Error("must not run"); },
    completedAt: "2026-08-22T01:25:00.000Z"
  });
  assert.equal(result.status, "failed");
  assert.equal(result.productionRecord, null);
  assert.equal(result.retryAllowed, false);
});

test("E starts only from ProductionRecord and verifies exact live identity, price, stock, images, moderation, and sale", async () => {
  const { result } = await successfulExecution();
  const verified = await runSystemCreatedEReadback({
    productionRecord: result.productionRecord,
    readPlatform: async () => exactObservation(result.productionRecord, {
      platformProductId: "910001",
      currentPrice: { amount: 117.85, currency: "CNY" },
      currentStock: 100,
      imageCount: 2,
      moderationStatus: "approved",
      validationStatus: "success",
      saleStatus: "on_sale"
    }),
    verifiedAt: "2026-08-22T02:00:00.000Z"
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.outcome, "listed_verified");
  assert.equal(verified.eVerificationRecord.sourceRecordType, "ProductionRecord");
  assert.equal(verified.platformWrites, 0);

  const pending = await runSystemCreatedEReadback({
    productionRecord: result.productionRecord,
    readPlatform: async () => exactObservation(result.productionRecord, {
      currentPrice: { amount: 117.85, currency: "CNY" },
      currentStock: 100,
      imageCount: 2,
      moderationStatus: "in_moderation",
      validationStatus: "processing",
      saleStatus: "not_for_sale"
    }),
    verifiedAt: "2026-08-22T02:05:00.000Z"
  });
  assert.equal(pending.status, "not_verified");
  assert.equal(pending.outcome, null);
  assert.equal(pending.eVerificationRecord, null);
  assert.equal(pending.automaticRetry, false);

  const unavailable = await runSystemCreatedEReadback({
    productionRecord: result.productionRecord,
    readPlatform: async () => { throw new Error("read timeout"); },
    verifiedAt: "2026-08-22T02:10:00.000Z"
  });
  assert.equal(unavailable.status, "not_verified");
  assert.match(unavailable.gaps[0], /technical_readback_failure/);
  assert.equal(unavailable.eVerificationRecord, null);
  assert.equal(unavailable.automaticRetry, false);
});

test("ExternalListingRecord remains a separate compatible E path", () => {
  const observation = {
    platform: "ozon", store: "dandanshu", skuPackageId: "sku-lifecycle:EXTERNAL-001",
    supplierSkuId: "SUP-EXTERNAL-001", platformProductId: "920001", merchantSku: "SUP-EXTERNAL-001",
    currentPrice: { amount: 88, currency: "CNY" }, currentStock: 12, imageCount: 3,
    moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale", errors: [],
    platformEvidenceRef: "evidence:external:920001", discoverySource: "seller_api"
  };
  const ownerPriceDecision = {
    decision: "keep_current_live_price", confirmedBy: "owner", confirmedAt: "2026-08-22T02:00:00.000Z",
    price: { amount: 88, currency: "CNY" }
  };
  const external = createExternalListingRecord({ observation, ownerPriceDecision, discoveredAt: "2026-08-22T02:00:00.000Z" });
  const verified = verifyExternalListing({ externalListingRecord: external, verifiedObservation: observation, verifiedAt: "2026-08-22T02:05:00.000Z" });
  assert.equal(verified.verificationPath, "external_discovered");
  assert.equal(verified.outcome, "externally_verified");
  assert.equal(verified.createdByCurrentRun, false);
});

test("D keys isolate SKU and store, and active D/E code has no train-specific defaults", async () => {
  const first = await preparedFixture();
  const second = await preparedFixture({
    store: "miska",
    skuPackageId: "sku-lifecycle:GENERIC-SHELF:SUP-SHELF-002",
    supplierSkuId: "SUP-SHELF-002",
    adapterCapabilities: undefined
  });
  assert.notEqual(first.prepared.executableRequest.executionKey, second.prepared.executableRequest.executionKey);
  assert.equal(second.prepared.executableRequest.store, "miska");
  assert.equal(second.prepared.executableRequest.merchantSku, "SUP-SHELF-002");
  const source = await readFile(new URL("../lib/d-e-software-closure.mjs", import.meta.url), "utf8");
  for (const marker of ["4993364145574", "282", "火车", "小火车", "Паровоз", "xiaohouzi-"]) assert.equal(source.includes(marker), false, marker);
});

test("published D/E schemas lock single attempt, no fallback, no retry, and zero E writes", async () => {
  const dSchema = JSON.parse(await readFile(new URL("../schema/d-software-execution-v1.schema.json", import.meta.url), "utf8"));
  const eSchema = JSON.parse(await readFile(new URL("../schema/e-system-readback-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(dSchema.properties.executionPolicy.properties.batchSize.const, 1);
  assert.equal(dSchema.properties.executionPolicy.properties.attemptLimit.const, 1);
  assert.equal(dSchema.properties.executionPolicy.properties.automaticRetry.const, false);
  assert.equal(dSchema.properties.executionPolicy.properties.browserFallback.const, false);
  assert.equal(dSchema.properties.executionPolicy.properties.manualFallback.const, false);
  assert.equal(dSchema.properties.executionPolicy.properties.codexDispatch.const, false);
  assert.ok((JSON.stringify((await readFile(new URL("../schema/production-record-v1.1.schema.json", import.meta.url), "utf8")))).includes("requestReceiptRef"));
  assert.equal(eSchema.properties.automaticRetry.const, false);
  assert.equal(eSchema.properties.platformWrites.const, 0);
});
