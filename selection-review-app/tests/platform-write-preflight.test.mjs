import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PLATFORM_WRITE_PREFLIGHT_VERSION,
  runPlatformWritePreflight,
  validatePlatformWritePreflight
} from "../lib/platform-write-preflight.mjs";

function productionPlanFixture() {
  return {
    schemaVersion: "production-plan-v1.1",
    planId: "production-plan:production-auth:CX-20260803-010:7b944e001234",
    mode: "simulation",
    status: "prepared",
    createdAt: "2026-08-12T14:00:00.000Z",
    sourceAuthorizationId: "production-auth:CX-20260803-010:23",
    sourceAuthorizationRevision: 23,
    sourceAuthorizationFingerprint: "a".repeat(64),
    platform: "ozon",
    store: "dandanshu",
    skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    sku: { supplierSkuId: "4993364145574", variantKey: "豪华小火车" },
    titleVersion: "c1-seo-draft-v1.1:2026-08-12T13:00:00.000Z",
    title: "Механический деревянный 3D-пазл «Паровоз», 320 деталей",
    attributeVersion: "c1-fact-verification-v1.1:2026-08-12T12:30:00.000Z",
    attributes: { brand: { value: "unknown", status: "unknown" } },
    platformCategory: {
      descriptionCategoryId: { value: "17028665", verificationStatus: "confirmed" },
      typeId: { value: "92935", verificationStatus: "confirmed" }
    },
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    stock: 100,
    assetsFinalUploadsVersion: "c2-assets:CX-20260803-010:2026-08-12T13:12:00.000Z",
    finalUploads: [{ assetId: "final:CX-20260803-010:main", ownerConfirmed: true, productionEligible: true }],
    executionStrategy: {
      schemaVersion: "ozon-production-strategy-v1.0",
      primaryPath: "seller_api",
      browserRole: "local_media_handoff_only",
      automatedFields: ["create_product", "title", "platform_write_price_cny", "independent_readback"],
      mediaMode: "single_manual_local_file_selection",
      manualActionsRequired: 1,
      manualActionLabel: "一次选择已确认的本地最终素材",
      forbiddenBrowserActions: ["fill_title", "choose_category", "fill_attributes", "fill_price", "fill_dimensions", "fill_weight"],
      priceFieldRule: "platform_write_price_cny_only",
      stopOnFailure: true,
      automaticRetry: false,
      nextSkuAutomaticStart: false
    },
    publishScope: "create_draft_only",
    exclusions: ["do_not_submit", "do_not_publish"],
    allowedWriteFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    sourceReadPolicy: "authorization_snapshot_only",
    sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false,
    platformWrites: 0,
    productCreated: false,
    assetsUploaded: 0,
    readbackPerformed: false
  };
}

function successfulInspection(overrides = {}) {
  return {
    observedStore: "dandanshu",
    storeIdentityStatus: "matched",
    storeIdentityEvidenceRef: "seller-api:client-info:2026-08-12T14:10:00Z",
    permissionStatus: "verified",
    permissionEvidenceRef: "seller-api:read-only-permission-check:2026-08-12T14:10:00Z",
    connections: {
      api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "seller-api:health:2026-08-12T14:10:00Z" },
      sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "seller-backend:session:2026-08-12T14:10:00Z" }
    },
    platformWritableFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope", "advertising"],
    imagePermissionStatus: "verified",
    imagePermissionEvidenceRef: "seller-api:image-scope:2026-08-12T14:10:00Z",
    priceFieldCurrency: "CNY",
    priceCurrencyEvidenceRef: "seller-api:store-currency:CNY:2026-08-12T14:10:00Z",
    risks: [],
    ...overrides
  };
}

test("13B-1 generates a complete read-only PlatformWritePreflight from ProductionPlan", async () => {
  const plan = productionPlanFixture();
  let request;
  const result = await runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-12T14:10:00.000Z",
    inspectPlatform: async (value) => {
      request = value;
      return successfulInspection();
    }
  });
  assert.equal(result.schemaVersion, PLATFORM_WRITE_PREFLIGHT_VERSION);
  assert.equal(result.targetPlatform, "ozon");
  assert.deepEqual(result.storeIdentity, {
    expectedStore: "dandanshu",
    observedStore: "dandanshu",
    status: "matched",
    evidenceRef: "seller-api:client-info:2026-08-12T14:10:00Z"
  });
  assert.equal(result.permission.status, "verified");
  assert.equal(result.connectionStatus.api.status, "connected");
  assert.equal(result.connectionStatus.sellerBackend.status, "connected");
  assert.equal(result.imagePermission.status, "verified");
  assert.equal(result.technicalStatus, "completed");
  assert.equal(result.businessStateEffect, "none");
  assert.deepEqual(validatePlatformWritePreflight(result), { valid: true, errors: [] });
  assert.deepEqual(Object.keys(request).sort(), [
    "expectedPlatformWriteCurrency", "expectedStore", "imageUploadRequested", "inventoryWriteRequested", "mode",
    "platformWriteRequested", "productCreationRequested", "requestedWriteFields", "targetPlatform"
  ]);
  assert.equal(request.mode, "read_only_preflight");
  assert.equal(request.productCreationRequested, true);
  assert.equal(request.inventoryWriteRequested, true);
  assert.equal(request.platformWriteRequested, false);
  assert.equal(result.priceCurrency.status, "matched");
});

test("13B-1 intersects platform capabilities with the authorized field scope", async () => {
  const result = await runPlatformWritePreflight({
    productionPlan: productionPlanFixture(),
    checkedAt: "2026-08-12T14:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      platformWritableFields: ["title", "attributes", "advertising"]
    })
  });
  assert.deepEqual(result.effectiveWritableFields, ["title", "attributes"]);
  assert.equal(result.effectiveWritableFields.includes("advertising"), false);
  assert.ok(result.risks.some((risk) => risk.code === "write_scope_not_fully_available"));
  assert.equal(result.readyForPlatformWrite, false);
});

test("13B-1 records connection failure only as technicalStatus without a business effect", async () => {
  const plan = productionPlanFixture();
  const before = structuredClone(plan);
  const result = await runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-12T14:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      connections: {
        api: { status: "unavailable", checkedVia: "seller_api_read_only", evidenceRef: "seller-api:timeout:2026-08-12T14:10:00Z" },
        sellerBackend: { status: "system_error", checkedVia: "seller_backend_read_only", evidenceRef: "seller-backend:connection-error:2026-08-12T14:10:00Z" }
      },
      permissionStatus: "unknown",
      permissionEvidenceRef: "permission:not-observed:2026-08-12T14:10:00Z",
      imagePermissionStatus: "unknown",
      imagePermissionEvidenceRef: "image-permission:not-observed:2026-08-12T14:10:00Z"
    })
  });
  assert.equal(result.technicalStatus, "system_error");
  assert.equal(result.businessStateEffect, "none");
  assert.deepEqual(plan, before);
  assert.ok(result.risks.some((risk) => risk.code === "technical_system_error"));
});

test("13B-1 records missing permission without creating or modifying anything", async () => {
  const result = await runPlatformWritePreflight({
    productionPlan: productionPlanFixture(),
    checkedAt: "2026-08-12T14:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      permissionStatus: "permission_required",
      permissionEvidenceRef: "seller-api:permission-required:2026-08-12T14:10:00Z",
      imagePermissionStatus: "permission_required",
      imagePermissionEvidenceRef: "seller-api:image-permission-required:2026-08-12T14:10:00Z"
    })
  });
  assert.equal(result.technicalStatus, "permission_required");
  assert.equal(result.productCreated, false);
  assert.equal(result.imagesUploaded, 0);
  assert.equal(result.inventoryModified, false);
  assert.equal(result.storeDataModified, false);
  assert.equal(result.productionRecordCreated, false);
  assert.equal(result.platformWrites, 0);
});

test("13B-1 rejects an inspector that attempts to mutate the frozen ProductionPlan request", async () => {
  const plan = productionPlanFixture();
  await assert.rejects(() => runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-12T14:10:00.000Z",
    inspectPlatform: async (request) => {
      request.requestedWriteFields.push("advertising");
      return successfulInspection();
    }
  }), TypeError);
  assert.equal(plan.allowedWriteFields.includes("advertising"), false);
});

test("published PlatformWritePreflight schema freezes the no-write boundary", async () => {
  const url = new URL("../schema/platform-write-preflight-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  for (const field of [
    "targetPlatform", "storeIdentity", "permission", "connectionStatus", "authorizedWriteFields",
    "platformWritableFields", "effectiveWritableFields", "imagePermission", "priceCurrency", "risks", "technicalStatus"
  ]) assert.ok(schema.required.includes(field), field);
  assert.equal(schema.properties.businessStateEffect.const, "none");
  assert.equal(schema.properties.readyForPlatformWrite.const, false);
  assert.equal(schema.properties.productCreated.const, false);
  assert.equal(schema.properties.imagesUploaded.const, 0);
  assert.equal(schema.properties.inventoryModified.const, false);
  assert.equal(schema.properties.storeDataModified.const, false);
  assert.equal(schema.properties.productionRecordCreated.const, false);
  assert.equal(schema.properties.platformWrites.const, 0);
});
