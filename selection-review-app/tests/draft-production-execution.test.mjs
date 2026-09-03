import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  executeSingleSkuDraftCreation,
  PRODUCTION_RECORD_VERSION,
  validateProductionRecord
} from "../lib/draft-production-execution.mjs";
import {
  createProductionPlan,
  fingerprintProductionPlan
} from "../lib/production-plan.mjs";

function authorizationFixture() {
  return {
    schemaVersion: "production-authorization-v1.1",
    authorizationId: "production-auth:sku-lifecycle:TEST-SKU-001:SUP-001:23",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt: "2026-08-12T15:00:00.000Z",
    sourceConfirmationCardId: "final-plan-card:TEST-SKU-001:22",
    authorizedDataRevision: 23,
    lockedScope: {
      platform: "ozon",
      store: "dandanshu",
      skuPackageId: "sku-lifecycle:TEST-SKU-001:SUP-001",
      supplierSkuId: "SUP-001",
      variantKey: "single-variant",
      titleVersion: "title-v1",
      title: "Тестовый деревянный 3D-пазл",
      contentVersion: "content-v1",
      content: {
        locale: "ru-RU",
        description: "Тестовый деревянный 3D-пазл.",
        bulletPoints: ["Сборная модель."],
        searchKeywords: ["деревянный 3D-пазл"]
      },
      attributeVersion: "attributes-v1",
      attributes: {
        requiredPlatformFields: [
          { fieldKey: "brand", fact: { value: "Нет бренда", verificationStatus: "confirmed" } },
          { fieldKey: "model_name", fact: { value: "Тестовый пазл", verificationStatus: "confirmed" } }
        ]
      },
      packing: {
        weight: { value: 0.3, unit: "kg" },
        dimensions: { length: 23, width: 16, height: 3, unit: "cm" }
      },
      schemaWriteBindings: {
        schemaRevision: "ozon-schema:test",
        evidenceRef: "test:schema-write-bindings",
        content: {
          title: { fieldKey: "title", attributeId: 4180, complexId: 0, dictionaryId: 0 },
          description: { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 },
          searchKeywords: { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 }
        },
        requiredAttributes: [
          { fieldKey: "brand", attributeId: 85, complexId: 0, dictionaryId: 1 },
          { fieldKey: "model_name", attributeId: 9048, complexId: 0, dictionaryId: 0 }
        ]
      },
      platformCategory: {
        descriptionCategoryId: { value: "17028665", verificationStatus: "confirmed" },
        typeId: { value: "92935", verificationStatus: "confirmed" }
      },
      recommendedPrice: { rub: 1831, cny: 151.78 },
      buyerTargetPrice: { amount: 1831, currency: "RUB" },
      platformWritePrice: { amount: 151.78, currency: "CNY" },
      priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
      stock: 100,
      assetsFinalUploadsVersion: "assets-final-v1",
      finalUploads: [{ assetId: "final-main", assetRef: "/owner/final-main.png", ownerConfirmed: true, productionEligible: true }],
      publishScope: "create_draft_only",
      exclusions: ["no_publish", "no_activate", "no_moderation_submission", "no_advertising"],
      allowedWriteFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"]
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

function planAndPreflight() {
  const authorization = authorizationFixture();
  const plan = createProductionPlan({
    productionAuthorization: authorization,
    createdAt: "2026-08-12T15:05:00.000Z"
  });
  const preflight = {
    schemaVersion: "platform-write-preflight-v1.1",
    preflightId: "platform-preflight:TEST-SKU-001",
    sourceProductionPlanId: plan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(plan),
    targetPlatform: "ozon",
    storeIdentity: {
      expectedStore: "dandanshu",
      observedStore: "dandanshu",
      status: "matched",
      evidenceRef: "test:store-identity"
    },
    permission: { status: "verified", evidenceRef: "test:permission" },
    connectionStatus: {
      api: { status: "connected", checkedVia: "test_read_only", evidenceRef: "test:api" },
      sellerBackend: { status: "connected", checkedVia: "test_read_only", evidenceRef: "test:backend" }
    },
    authorizedWriteFields: [...plan.allowedWriteFields],
    platformWritableFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    effectiveWritableFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    imagePermission: { status: "verified", evidenceRef: "test:image-permission" },
    priceCurrency: { expected: "CNY", observed: "CNY", status: "matched", evidenceRef: "test:currency" },
    risks: [],
    technicalStatus: "completed",
    businessStateEffect: "none",
    checkedAt: "2026-08-12T15:06:00.000Z",
    readyForPlatformWrite: false,
    productCreated: false,
    imagesUploaded: 0,
    inventoryModified: false,
    storeDataModified: false,
    productionRecordCreated: false,
    platformWrites: 0
  };
  return { authorization, plan, preflight };
}

test("13B-2 creates exactly one draft and saves the returned platform product ID", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  let callCount = 0;
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async (value) => {
      callCount += 1;
      payload = value;
      assert.equal(payload.schemaWriteBindings.schemaRevision, "ozon-schema:test");
      return {
        status: "draft",
        productId: "OZON-DRAFT-1001",
        offerId: "TEST-SKU-001",
        writeEvidenceRef: "ozon:draft-create:task-1001",
        published: false,
        activated: false,
        advertisingOpened: false,
        inventoryModified: true,
        imagesUploaded: 1
      };
    },
    readbackPlatformDraft: async () => ({
      status: "draft",
      productId: "OZON-DRAFT-1001",
      title: plan.title,
      price: plan.platformWritePrice,
      stock: 100,
      finalUploadAssetIds: ["final-main"],
      mainImageAssetId: "final-main",
      evidenceRef: "ozon:draft-readback:OZON-DRAFT-1001",
      published: false,
      activated: false,
      moderationSubmitted: false
    })
  });
  assert.equal(callCount, 1);
  assert.equal(payload.batchSize, 1);
  assert.equal(payload.supplierSkuId, "SUP-001");
  assert.equal(payload.title, plan.title);
  assert.deepEqual(payload.content, plan.content);
  assert.deepEqual(payload.packing, plan.packing);
  assert.deepEqual(payload.attributes, plan.attributes);
  assert.deepEqual(payload.buyerTargetPrice, plan.buyerTargetPrice);
  assert.deepEqual(payload.platformWritePrice, plan.platformWritePrice);
  assert.equal(payload.publishScope, "create_draft_only");
  assert.equal(payload.publish, false);
  assert.equal(payload.activate, false);
  assert.equal(payload.openAdvertising, false);
  assert.equal(payload.writeInventory, true);
  assert.equal(payload.uploadImages, true);
  assert.equal(payload.stock, 100);
  assert.deepEqual(payload.finalUploads, plan.finalUploads);

  const record = result.productionRecord;
  assert.equal(record.schemaVersion, PRODUCTION_RECORD_VERSION);
  assert.equal(record.status, "draft");
  assert.equal(record.platformProductId, "OZON-DRAFT-1001");
  assert.equal(record.batchSize, 1);
  assert.deepEqual(validateProductionRecord(record), { valid: true, errors: [] });
});

test("13B-2 reads only ProductionPlan fields and cannot expand into A/B/C, images, inventory, publish, activate or advertising", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  let keys;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async (payload) => {
      keys = Object.keys(payload);
      return { status: "draft", productId: "1002", writeEvidenceRef: "test:draft:1002" };
    },
    readbackPlatformDraft: async () => ({
      status: "draft", productId: "1002", title: plan.title, price: plan.platformWritePrice, stock: 100,
      finalUploadAssetIds: ["final-main"], mainImageAssetId: "final-main", evidenceRef: "test:readback:1002"
    })
  });
  for (const forbidden of ["salesSnapshot", "profitModel", "c1ProductPlan", "c2FinalAssets"]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(result.productionRecord.writtenFields, ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"]);
  assert.equal(result.productionRecord.published, false);
  assert.equal(result.productionRecord.activated, false);
  assert.equal(result.productionRecord.advertisingOpened, false);
  assert.equal(result.productionRecord.inventoryModified, true);
  assert.equal(result.productionRecord.stockWritten, 100);
  assert.equal(result.productionRecord.imagesUploaded, 1);
  assert.deepEqual(result.productionRecord.finalUploadAssetIds, ["final-main"]);
  assert.equal(result.productionRecord.independentReadbackVerified, true);
  assert.equal(result.otherSkuExecuted, false);
});

test("13B-2 creates one product for validation/moderation without inventory or activation", async () => {
  const authorization = authorizationFixture();
  authorization.authorizationId += ":moderation";
  authorization.lockedScope.publishScope = "create_and_allow_validation_moderation";
  authorization.lockedScope.exclusions = ["no_publish_or_activation", "no_inventory_write", "no_warehouse_or_logistics_change", "no_promotion_change", "no_advertising_change", "no_other_sku_write"];
  authorization.lockedScope.allowedWriteFields = ["create_product", "title", "attributes", "price", "assets.finalUploads", "publish_scope"];
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: "2026-08-13T09:00:00.000Z" });
  const base = planAndPreflight().preflight;
  const preflight = {
    ...base,
    sourceProductionPlanId: plan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(plan),
    authorizedWriteFields: [...plan.allowedWriteFields],
    platformWritableFields: [...plan.allowedWriteFields],
    effectiveWritableFields: [...plan.allowedWriteFields]
  };
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    executedAt: "2026-08-13T09:05:00.000Z",
    createPlatformDraft: async (value) => {
      payload = value;
      return { status: "validation_or_moderation", productId: "OZON-2001", offerId: "TEST-SKU-001", writeEvidenceRef: "test:write:2001", moderationSubmitted: true, published: false, activated: false };
    },
    readbackPlatformDraft: async () => ({
      status: "validation_or_moderation", productId: "OZON-2001", title: plan.title, price: plan.platformWritePrice,
      inventoryModified: false, finalUploadAssetIds: ["final-main"], mainImageAssetId: "final-main",
      evidenceRef: "test:readback:2001", moderationSubmitted: true, published: false, activated: false
    })
  });
  assert.equal(payload.mode, "single_sku_create_and_moderate");
  assert.equal(payload.writeInventory, false);
  assert.equal(payload.publish, false);
  assert.equal(payload.activate, false);
  assert.equal(result.productionRecord.status, "validation_or_moderation");
  assert.equal(result.productionRecord.inventoryModified, false);
  assert.equal(result.productionRecord.stockWritten, null);
  assert.deepEqual(result.productionRecord.writtenFields, ["create_product", "title", "attributes", "price", "assets.finalUploads", "publish_scope"]);
  assert.deepEqual(validateProductionRecord(result.productionRecord), { valid: true, errors: [] });
});

test("13B-2 rejects changed authorization before the platform adapter is called", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  const changed = structuredClone(authorization);
  changed.lockedScope.title = "Изменённый заголовок";
  let calls = 0;
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: changed,
    platformWritePreflight: preflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async () => { calls += 1; },
    readbackPlatformDraft: async () => { calls += 1; }
  }), /AUTHORIZATION_VERSION_CHANGED/);
  assert.equal(calls, 0);
});

test("13B-2 rejects unknown required attributes and stale preflight without calling the platform", async () => {
  const first = planAndPreflight();
  const unknownAuthorization = structuredClone(first.authorization);
  unknownAuthorization.lockedScope.attributes.requiredPlatformFields[0].fact = { value: "unknown", verificationStatus: "unknown" };
  const unknownPlan = createProductionPlan({
    productionAuthorization: unknownAuthorization,
    createdAt: "2026-08-12T15:05:00.000Z"
  });
  let calls = 0;
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: unknownPlan,
    productionAuthorization: unknownAuthorization,
    platformWritePreflight: first.preflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async () => { calls += 1; },
    readbackPlatformDraft: async () => { calls += 1; }
  }), /DRAFT_DATA_GAP/);
  assert.equal(calls, 0);

  const stalePreflight = structuredClone(first.preflight);
  stalePreflight.sourceProductionPlanFingerprint = "b".repeat(64);
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: first.plan,
    productionAuthorization: first.authorization,
    platformWritePreflight: stalePreflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async () => { calls += 1; },
    readbackPlatformDraft: async () => { calls += 1; }
  }), /DRAFT_PREFLIGHT_STALE/);
  assert.equal(calls, 0);
});

test("13B-2 saves no ProductionRecord when platform result is not a draft with product ID", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  for (const result of [
    { status: "published", productId: "1003", writeEvidenceRef: "test:published" },
    { status: "draft", productId: "", writeEvidenceRef: "test:no-id" },
    { status: "draft", productId: "1004", writeEvidenceRef: "test:activated", activated: true }
  ]) {
    await assert.rejects(() => executeSingleSkuDraftCreation({
      productionPlan: plan,
      productionAuthorization: authorization,
      platformWritePreflight: preflight,
      executedAt: "2026-08-12T15:10:00.000Z",
      createPlatformDraft: async () => result,
      readbackPlatformDraft: async () => ({})
    }), /DRAFT_PLATFORM/);
  }
});

test("13B-2 refuses completion when independent readback does not match stock or final images", async () => {
  const { authorization, plan, preflight } = planAndPreflight();
  await assert.rejects(() => executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    executedAt: "2026-08-12T15:10:00.000Z",
    createPlatformDraft: async () => ({ status: "draft", productId: "1005", writeEvidenceRef: "test:draft:1005" }),
    readbackPlatformDraft: async () => ({
      status: "draft", productId: "1005", title: plan.title, price: plan.platformWritePrice, stock: 0,
      finalUploadAssetIds: [], mainImageAssetId: null, evidenceRef: "test:readback:1005"
    })
  }), /DRAFT_READBACK_MISMATCH/);
});

test("published ProductionRecord schema locks draft-only single-SKU execution", async () => {
  const url = new URL("../schema/production-record-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.deepEqual(schema.properties.status.enum, ["draft", "validation_or_moderation"]);
  assert.deepEqual(schema.properties.executionMode.enum, ["single_sku_draft_only", "single_sku_create_and_moderate", "single_sku_seller_api"]);
  assert.equal(schema.properties.batchSize.const, 1);
  assert.equal(schema.properties.published.const, false);
  assert.equal(schema.properties.activated.const, false);
  assert.equal(schema.properties.advertisingOpened.const, false);
  assert.equal(schema.properties.inventoryModified.type, "boolean");
  assert.deepEqual(schema.properties.stockWritten.type, ["integer", "null"]);
  assert.equal(schema.properties.imagesUploaded.minimum, 1);
  assert.equal(schema.properties.independentReadbackVerified.const, true);
  assert.equal(schema.properties.writtenFields.minItems, 6);
});
