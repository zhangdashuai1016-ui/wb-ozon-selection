import assert from "node:assert/strict";
import { currentProductionBindingFixture } from "./helpers/d-software-fixture.mjs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizedProductionFixture, localFinalAssets } from "./helpers/c2-software-fixture.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../lib/production-plan.mjs";
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
  createStoreIsolatedOzonSellerApiDEAdapter
} from "../lib/ozon-seller-api-de-adapter.mjs";

import { ALL_WRITE_FIELDS, preflightFixture, capabilities, preparedFixture, exactObservation, successfulExecution, historicalPlanFixture } from "./helpers/d-software-fixture.mjs";

test("D only consumes the bound authorization plan and emits one generic Ozon Seller API request", async () => {
  const { authorization, plan, prepared } = await preparedFixture();
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.executableRequest.sourceAuthorizationId, authorization.authorizationId);
  assert.equal(prepared.executableRequest.sourceProductionPlanId, plan.planId);
  assert.equal(prepared.executableRequest.store, "dandanshu");
  assert.equal(prepared.executableRequest.merchantSku, "MERCHANT-SHELF-001");
  assert.equal(prepared.executableRequest.supplierSkuId, "SHELF-WHITE");
  assert.equal(prepared.executableRequest.productImport.body.items[0].offer_id, "MERCHANT-SHELF-001");
  assert.deepEqual(prepared.executableRequest.platformWritePrice, { amount: 151.78, currency: "CNY" });
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

test("historical authorization and old prepared attempts cannot regain D execution eligibility", async () => {
  const { plan, authorization } = historicalPlanFixture();
  const platformWritePreflight = await preflightFixture(plan);
  const inputs = projectProductionPlanInputs(plan);
  assert.throws(() => prepareSingleSkuDExecution({ productionPlan: plan, productionAuthorization: authorization, platformWritePreflight,
    adapterCapabilities: capabilities(inputs.store, inputs.finalUploads, inputs), preparedAt: "2026-08-22T07:15:00.000Z" }), /PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  const { prepared } = await preparedFixture();
  const attempt = structuredClone(beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" }));
  for (const version of [undefined, "production-authorization-v1.1"]) {
    const historicalAttempt = structuredClone(attempt);
    if (version === undefined) delete historicalAttempt.request.sourceAuthorizationVersion;
    else historicalAttempt.request.sourceAuthorizationVersion = version;
    await assert.rejects(() => executeDSoftwareAttempt({ executionAttempt: historicalAttempt,
      executeSellerApi: async () => { throw new Error("must not write"); }, readbackSellerApi: async () => { throw new Error("must not read"); },
      completedAt: "2026-08-22T07:25:00.000Z" }), /D_EXECUTABLE_REQUEST_INVALID|PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  }
});

test("D returns not_ready for local-only finalUploads and never invents browser or manual fallback", async () => {
  const local = await preparedFixture({ assets: localFinalAssets() });
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
  const fixture = authorizedProductionFixture();
  const authorization = fixture.productionAuthorization;
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const preflight = await preflightFixture(plan);
  assert.throws(() => prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: null,
    platformWritePreflight: preflight,
    adapterCapabilities: capabilities(inputs.store, inputs.finalUploads),
    preparedAt: "2026-08-22T07:15:00.000Z"
  }), /ProductionAuthorization/);
  const drifted = authorizedProductionFixture({ merchantSku: "MERCHANT-CHANGED" }).productionAuthorization;
  assert.throws(() => prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: drifted,
    platformWritePreflight: preflight,
    adapterCapabilities: capabilities(inputs.store, inputs.finalUploads),
    preparedAt: "2026-08-22T07:15:00.000Z"
  }), /AUTHORIZATION_DRIFT/);
  const crossStore = await preparedFixture({ preflight: { store: "miska" } });
  assert.equal(crossStore.prepared.status, "not_ready");
  assert.ok(crossStore.prepared.gaps.some((item) => item.code === "store_identity_not_ready"));
});

test("D intent is deterministic, persisted before write, and idempotent per authorization and plan", async () => {
  const first = await preparedFixture();
  const second = await preparedFixture();
  assert.equal(first.prepared.executableRequest.executionKey, second.prepared.executableRequest.executionKey);
  const attempt = beginDSoftwareExecution({ preparedExecution: first.prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  assert.equal(attempt.status, "in_flight");
  assert.equal(attempt.persistBeforeWrite, true);
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.retryAllowed, false);
});

test("D creates ProductionRecord only after real IDs, receipts, and exact independent readback", async () => {
  const { attempt, result } = await successfulExecution();
  assert.equal(result.status, "succeeded");
  assert.equal(result.productionRecord.platformProductId, "910001");
  assert.equal(result.productionRecord.platformOfferId, "MERCHANT-SHELF-001");
  assert.equal(result.productionRecord.sourceProductionPlanId, attempt.request.sourceProductionPlanId);
  assert.equal(result.productionRecord.sourceAuthorizationId, attempt.request.sourceAuthorizationId);
  assert.equal(result.productionRecord.stockWritten, 100);
  assert.equal(result.productionRecord.imagesUploaded, 2);
  assert.equal(result.productionRecord.independentReadbackVerified, true);
});

test("real adapter parks D after one import and its separate readback preserves unproven sale status", async () => {
  const fixture = authorizedProductionFixture();
  const authorization = fixture.productionAuthorization;
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  const preflight = await preflightFixture(plan);
  const adapterCapabilities = capabilities(inputs.store, inputs.finalUploads, inputs);
  adapterCapabilities.warehouseId = adapterCapabilities.inventoryWrite.warehouseId;
  const prepared = prepareSingleSkuDExecution({
    productionPlan: plan,
    productionAuthorization: authorization,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    platformWritePreflight: preflight,
    adapterCapabilities,
    preparedAt: "2026-08-22T07:15:00.000Z"
  });
  assert.equal(prepared.status, "ready");
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  let listed = false; const calls = [];
  const requestJson = async ({ endpoint }) => {
    calls.push(endpoint);
    if (endpoint === "/v3/product/import") return { result: { task_id: 701 } };
    if (endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "MERCHANT-SHELF-001", product_id: 910001, status: "imported", errors: [] }] } };
    if (endpoint === "/v2/products/stocks") return { result: [{ offer_id: "MERCHANT-SHELF-001", product_id: 910001, warehouse_id: 70001, updated: true, errors: [] }] };
    if (endpoint === "/v4/product/info/attributes") return { result: [{ offer_id: "MERCHANT-SHELF-001", id: 910001,
      primary_image: attempt.request.finalUploads[0].platformAcceptedUrl, images: attempt.request.finalUploads.slice(1).map(asset => asset.platformAcceptedUrl) }] };
    if (endpoint === "/v3/product/info/list") return { items: [{
      offer_id: "MERCHANT-SHELF-001", id: 910001, is_archived: false,
      statuses: {
        moderate_status: listed ? "approved" : "in_moderation",
        validation_status: listed ? "success" : "processing",
        status_name: listed ? "Продается" : "Создаётся"
      },
      errors: []
    }] };
    if (endpoint === "/v5/product/info/prices") return { items: [{ offer_id: "MERCHANT-SHELF-001", product_id: 910001, price: { price: 151.78, currency_code: "CNY" } }] };
    if (endpoint === "/v2/product/info/stocks-by-warehouse/fbs") return { products: [{ offer_id: "MERCHANT-SHELF-001", product_id: 910001, sku: 810001, warehouse_id: 70001, free_stock: 100, present: 103, reserved: 3 }], has_next: false, cursor: "" };
    if (endpoint === "/v3/product/list") return { result: { items: [] } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const executionContext = { productionPlan: plan, currentProductionBinding: currentProductionBindingFixture(authorization), serverClock: () => "2026-08-22T07:25:00.000Z" };
  const adapter = createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities, executionContext });
  const checkpoints = [];
  const execution = await executeDSoftwareAttempt({
    executionAttempt: attempt, executionContext,
    executeSellerApi: adapter.executeSellerApi,
    readbackSellerApi: adapter.readbackSellerApi,
    persistCheckpoint: async event => checkpoints.push(structuredClone(event)),
    completedAt: "2026-08-22T07:25:00.000Z"
  });
  assert.equal(execution.status, "waiting_platform");
  assert.deepEqual(calls, ["/v3/product/import"]);
  assert.deepEqual(checkpoints.map(event => event.kind), ["import_intent", "import_task_received"]);
  assert.equal(checkpoints[1].taskId, "701");
  assert.equal(execution.productionRecord, null);
  assert.equal(execution.platformResult.productId, null);
  assert.equal(execution.platformContinuation.status, "waiting_import");
  assert.equal(execution.platformContinuation.inventoryWriteState, "not_sent");
  assert.equal(execution.immediateReadback, undefined);
  assert.equal(execution.retryAllowed, false);
  // A human display label cannot independently prove a machine sale state, even after a new read.
  listed = true;
  const restartedAdapter = createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities });
  const laterObservation = await restartedAdapter.readbackSellerApi({ platform: "ozon", store: attempt.request.store,
    storeRef: attempt.request.storeRef, warehouseRef: attempt.request.warehouseRef, credentialAlias: attempt.request.credentialAlias,
    warehouseId: attempt.request.inventoryWrite.warehouseId, skuPackageId: attempt.request.skuPackageId,
    platformProductId: "910001", merchantSku: attempt.request.merchantSku, supplierSkuId: attempt.request.supplierSkuId, writeAllowed: false });
  assert.equal(laterObservation.saleStatus, "unknown");
  assert.equal(laterObservation.currentStock, 100);
  assert.equal(laterObservation.inventoryObservation.sourceProtocol, "ozon-product-stocks-by-warehouse-fbs-v2");
  assert.equal(calls.filter(endpoint => endpoint === "/v3/product/import").length, 1);
  assert.equal(calls.includes("/v2/products/stocks"), false);
  assert.equal(execution.productionRecord, null);

});

test("D marks transport, ambiguous response, and readback mismatch unknown without retry or record", async () => {
  const { prepared, executionContext } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  const transport = await executeDSoftwareAttempt({
    executionAttempt: attempt, executionContext,
    executeSellerApi: async () => { throw new Error("connection reset"); },
    readbackSellerApi: async () => { throw new Error("must not run"); },
    completedAt: "2026-08-22T07:25:00.000Z"
  });
  assert.equal(transport.status, "unknown_outcome");
  assert.equal(transport.retryAllowed, false);
  assert.equal(transport.productionRecord, null);
  await assert.rejects(() => executeDSoftwareAttempt({
    executionAttempt: transport,
    executeSellerApi: async () => ({}),
    readbackSellerApi: async () => ({}),
    completedAt: "2026-08-22T07:30:00.000Z"
  }), /ATTEMPT_STATE_REJECTED/);

  const ambiguous = await executeDSoftwareAttempt({
    executionAttempt: attempt, executionContext,
    executeSellerApi: async () => ({ status: "accepted", productId: "910001", offerId: "WRONG" }),
    readbackSellerApi: async () => ({}),
    completedAt: "2026-08-22T07:25:00.000Z"
  });
  assert.equal(ambiguous.status, "unknown_outcome");
  assert.equal(ambiguous.productionRecord, null);

  const mismatch = await executeDSoftwareAttempt({
    executionAttempt: attempt, executionContext,
    executeSellerApi: async (request) => ({
      status: "accepted", productId: "910001", offerId: request.merchantSku,
      requestReceiptRef: "receipt:product", inventoryReceiptRef: "receipt:inventory"
    }),
    readbackSellerApi: async () => exactObservation(attempt.request, { currentStock: 0 }),
    completedAt: "2026-08-22T07:25:00.000Z"
  });
  assert.equal(mismatch.status, "unknown_outcome");
  assert.match(mismatch.reason, /currentStock/);
  assert.equal(mismatch.productionRecord, null);
});

test("D preserves a known pre-write rejection as failed without ProductionRecord", async () => {
  const { prepared, executionContext } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  const result = await executeDSoftwareAttempt({
    executionAttempt: attempt, executionContext,
    executeSellerApi: async () => ({ status: "rejected_before_write", writeOccurred: false, code: "schema_rejected" }),
    readbackSellerApi: async () => { throw new Error("must not run"); },
    completedAt: "2026-08-22T07:25:00.000Z"
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
      currentPrice: { amount: 151.78, currency: "CNY" },
      currentStock: 100,
      imageCount: 2,
      moderationStatus: "approved",
      validationStatus: "success",
      saleStatus: "on_sale"
    }),
    verifiedAt: "2026-08-22T08:00:00.000Z"
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.outcome, "listed_verified");
  assert.equal(verified.eVerificationRecord.sourceRecordType, "ProductionRecord");
  assert.equal(verified.platformWrites, 0);

  const pending = await runSystemCreatedEReadback({
    productionRecord: result.productionRecord,
    readPlatform: async () => exactObservation(result.productionRecord, {
      currentPrice: { amount: 151.78, currency: "CNY" },
      currentStock: 100,
      imageCount: 2,
      moderationStatus: "in_moderation",
      validationStatus: "processing",
      saleStatus: "not_for_sale"
    }),
    verifiedAt: "2026-08-22T08:05:00.000Z"
  });
  assert.equal(pending.status, "not_verified");
  assert.equal(pending.outcome, null);
  assert.equal(pending.eVerificationRecord, null);
  assert.equal(pending.automaticRetry, false);

  const unavailable = await runSystemCreatedEReadback({
    productionRecord: result.productionRecord,
    readPlatform: async () => { throw new Error("read timeout"); },
    verifiedAt: "2026-08-22T08:10:00.000Z"
  });
  assert.equal(unavailable.status, "not_verified");
  assert.match(unavailable.gaps[0], /technical_readback_failure/);
  assert.equal(unavailable.eVerificationRecord, null);
  assert.equal(unavailable.automaticRetry, false);
});

test("E records the trusted completion time after the independent read and rejects a backward clock", async () => {
  const { result } = await successfulExecution();
  const productionRecord = result.productionRecord;
  const startedAt = "2026-08-22T08:00:00.000Z"; const completedAt = "2026-08-22T08:02:00.000Z";
  for (const fail of [false, true]) {
    let observedAt = startedAt;
    const readback = await runSystemCreatedEReadback({ productionRecord, completionClock: () => observedAt,
      readPlatform: async () => { observedAt = completedAt; if (fail) throw new Error("synthetic read failure");
        return exactObservation(productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" }); } });
    assert.equal(readback.verifiedAt, completedAt);
    if (!fail) assert.equal(readback.eVerificationRecord.verifiedAt, completedAt);
    else assert.equal(readback.eVerificationRecord, null);
  }
  let reads = 0;
  await assert.rejects(() => runSystemCreatedEReadback({ productionRecord, completionClock: () => "invalid",
    readPlatform: async () => { reads += 1; } }), /E_SYSTEM_READBACK_TIME_INVALID/);
  assert.equal(reads, 0);
  let observedAt = completedAt;
  await assert.rejects(() => runSystemCreatedEReadback({ productionRecord, completionClock: () => observedAt,
    readPlatform: async () => { observedAt = startedAt; return exactObservation(productionRecord); } }), /E_SYSTEM_READBACK_TIME_INVALID/);
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
    decision: "keep_current_live_price", confirmedBy: "owner", confirmedAt: "2026-08-22T08:00:00.000Z",
    price: { amount: 88, currency: "CNY" }
  };
  const external = createExternalListingRecord({ observation, ownerPriceDecision, discoveredAt: "2026-08-22T08:00:00.000Z" });
  const verified = verifyExternalListing({ externalListingRecord: external, verifiedObservation: observation, verifiedAt: "2026-08-22T08:05:00.000Z" });
  assert.equal(verified.verificationPath, "external_discovered");
  assert.equal(verified.outcome, "externally_verified");
  assert.equal(verified.createdByCurrentRun, false);
});

test("D keys isolate SKU and store, and active D/E code has no train-specific defaults", async () => {
  const first = await preparedFixture();
  const second = await preparedFixture({
    storeRef: { stableStoreId: "miska", platformStoreId: "synthetic-miska", mappingVersion: "stores-v1" },
    supplierSkuId: "SUP-SHELF-002",
    merchantSku: "MERCHANT-SHELF-002",
    adapterCapabilities: undefined
  });
  assert.notEqual(first.prepared.executableRequest.executionKey, second.prepared.executableRequest.executionKey);
  assert.equal(second.prepared.executableRequest.store, "miska");
  assert.equal(second.prepared.executableRequest.merchantSku, "MERCHANT-SHELF-002");
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
