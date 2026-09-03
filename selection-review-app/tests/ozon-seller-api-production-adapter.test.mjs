import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOzonSellerImportRequest,
  createOzonSellerApiProductionAdapter
} from "../lib/ozon-seller-api-production-adapter.mjs";

function payload(overrides = {}) {
  return {
    mode: "single_sku_create_and_moderate",
    platform: "ozon",
    store: "dandanshu",
    supplierSkuId: "SUP-MUSIC-001",
    title: "Музыкальная шкатулка — швейная машинка",
    content: {
      locale: "ru-RU",
      description: "Механическая музыкальная шкатулка.",
      bulletPoints: ["Ручной завод."],
      searchKeywords: ["музыкальная шкатулка", "швейная машинка"]
    },
    attributes: {
      requiredPlatformFields: [
        { fieldKey: "85", fact: { value: { value: "Нет бренда", dictionaryValueId: 1001 }, verificationStatus: "confirmed" } },
        { fieldKey: "9048", fact: { value: "Швейная машинка", verificationStatus: "confirmed" } },
        { fieldKey: "8229", fact: { value: { value: "Музыкальная шкатулка", dictionaryValueId: 2001 }, verificationStatus: "confirmed" } }
      ]
    },
    schemaWriteBindings: {
      schemaRevision: "ozon-schema-current:test",
      evidenceRef: "test:ozon-schema:music-box",
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
    packing: {
      weight: { value: 0.4, unit: "kg" },
      dimensions: { length: 12, width: 12, height: 7, unit: "cm" }
    },
    platformCategory: {
      descriptionCategoryId: { value: 17028973, verificationStatus: "confirmed" },
      typeId: { value: 92849, verificationStatus: "confirmed" }
    },
    platformWritePrice: { amount: 117.85, currency: "CNY" },
    finalUploads: [
      { assetId: "main", assetRef: "https://assets.example/main.jpg", ownerConfirmed: true, productionEligible: true },
      { assetId: "detail", assetRef: "https://assets.example/detail.jpg", ownerConfirmed: true, productionEligible: true }
    ],
    publishScope: "create_and_allow_validation_moderation",
    ...overrides
  };
}

test("builds one Ozon import item from the frozen production payload", () => {
  const request = buildOzonSellerImportRequest(payload());
  assert.equal(request.body.items.length, 1);
  const item = request.body.items[0];
  assert.equal(item.offer_id, "SUP-MUSIC-001");
  assert.equal(item.currency_code, "CNY");
  assert.equal(item.price, "117.85");
  assert.equal(item.weight, 400);
  assert.equal(item.depth, 120);
  assert.equal(item.width, 120);
  assert.equal(item.height, 70);
  assert.equal(item.primary_image, "https://assets.example/main.jpg");
  assert.deepEqual(item.images, ["https://assets.example/detail.jpg"]);
  assert.equal(item.attributes.find((entry) => entry.id === 4191).values[0].value.includes("Ручной завод"), true);
  assert.equal(item.attributes.find((entry) => entry.id === 85).values[0].dictionary_value_id, 1001);
  assert.equal(request.inventoryIncluded, false);
});

test("rejects draft-only, local assets, unknown attributes and wrong currency before transport", () => {
  assert.throws(() => buildOzonSellerImportRequest(payload({ mode: "single_sku_draft_only", publishScope: "create_draft_only" })), /SCOPE_REJECTED/);
  const local = payload();
  local.finalUploads[0].assetRef = "/tmp/main.jpg";
  assert.throws(() => buildOzonSellerImportRequest(local), /REMOTE_ASSET_REQUIRED/);
  const unknown = payload();
  unknown.attributes.requiredPlatformFields[0].fact = { value: "unknown", verificationStatus: "unknown" };
  assert.throws(() => buildOzonSellerImportRequest(unknown), /REQUIRED_ATTRIBUTE_UNKNOWN/);
  const rub = payload({ platformWritePrice: { amount: 1462, currency: "RUB" } });
  assert.throws(() => buildOzonSellerImportRequest(rub), /PRICE_REJECTED/);
  const unbound = payload();
  delete unbound.schemaWriteBindings;
  assert.throws(() => buildOzonSellerImportRequest(unbound), /SCHEMA_BINDING_REJECTED/);
  const missingDictionaryId = payload();
  missingDictionaryId.attributes.requiredPlatformFields[0].fact.value = "Нет бренда";
  assert.throws(() => buildOzonSellerImportRequest(missingDictionaryId), /DICTIONARY_VALUE_REQUIRED/);
});

test("uses one import call, one terminal-status call and independent readback without inventory write", async () => {
  const calls = [];
  const adapter = createOzonSellerApiProductionAdapter({
    requestJson: async (request) => {
      calls.push(request);
      if (request.endpoint === "/v3/product/import") return { result: { task_id: "task-1" } };
      if (request.endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "SUP-MUSIC-001", product_id: 9001, status: "imported", errors: [] }] } };
      if (request.endpoint === "/v3/product/info/list") return { items: [{ offer_id: "SUP-MUSIC-001", id: 9001, name: "Музыкальная шкатулка — швейная машинка", price: { price: "117.85" } }] };
      if (request.endpoint === "/v4/product/info/attributes") return { result: [{ offer_id: "SUP-MUSIC-001", primary_image: "https://cdn.ozon/main.jpg", images: ["https://cdn.ozon/detail.jpg"] }] };
      throw new Error(`unexpected ${request.endpoint}`);
    }
  });
  const created = await adapter.createPlatformDraft(payload());
  assert.equal(created.status, "validation_or_moderation");
  assert.equal(created.inventoryModified, false);
  const readback = await adapter.readbackPlatformDraft({ productId: "9001" });
  assert.equal(readback.price.amount, 117.85);
  assert.deepEqual(readback.finalUploadAssetIds, ["main", "detail"]);
  assert.deepEqual(calls.map((call) => [call.endpoint, call.write]), [
    ["/v3/product/import", true],
    ["/v1/product/import/info", false],
    ["/v3/product/info/list", false],
    ["/v4/product/info/attributes", false]
  ]);
});

test("stops on pending import and never polls or reads another product", async () => {
  let calls = 0;
  const adapter = createOzonSellerApiProductionAdapter({
    requestJson: async ({ endpoint }) => {
      calls += 1;
      if (endpoint === "/v3/product/import") return { result: { task_id: "task-pending" } };
      return { result: { items: [{ offer_id: "SUP-MUSIC-001", status: "pending" }] } };
    }
  });
  await assert.rejects(() => adapter.createPlatformDraft(payload()), /PENDING_UNKNOWN_OUTCOME/);
  assert.equal(calls, 2);
});
