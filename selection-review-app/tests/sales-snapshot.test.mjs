import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MARKET_SCOPES,
  SALES_SNAPSHOT_SCHEMA_VERSION,
  SELLER_TYPES,
  UNKNOWN,
  collectMockOzonSalesSnapshot,
  validateSalesSnapshot
} from "../lib/sales-snapshot.mjs";

function mockFixture(overrides = {}) {
  return {
    sourceMode: "mock_ozon_fixture",
    snapshotId: "sales-snapshot:mock-ozon-001",
    marketScope: "ozon_cn_cross_border",
    sellerType: "cross_border_cn",
    sellerIdentityEvidence: {
      status: "verified",
      signals: [
        { field: "seller_origin", value: "CN", sourcePath: "mock.seller.origin" },
        { field: "shipping_origin", value: "China", sourcePath: "mock.shipping.origin" }
      ],
      evidenceRef: "mock-evidence:ozon-seller-identity-001"
    },
    productUrl: "https://www.ozon.ru/product/mock-cross-border-product-10001/",
    title: "Механический деревянный 3D-пазл Паровоз",
    imageRefs: ["mock-image:10001:1", "mock-image:10001:2"],
    currentPrice: 1831,
    currency: "RUB",
    categoryPath: "Хобби и творчество > Пазлы, модели для сборки > 3D-пазл",
    attributes: {
      material: "Дерево",
      pieces: 320
    },
    collectedAt: "2026-08-12T13:00:00.000Z",
    evidenceRef: "mock-evidence:ozon-product-10001",
    ...overrides
  };
}

test("mock Ozon data generates a complete immutable SalesSnapshot", () => {
  const fixture = mockFixture();
  const before = structuredClone(fixture);
  const snapshot = collectMockOzonSalesSnapshot(fixture);

  assert.equal(snapshot.schemaVersion, SALES_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.platform, "ozon");
  assert.equal(snapshot.marketScope, "ozon_cn_cross_border");
  assert.equal(snapshot.sellerType, "cross_border_cn");
  assert.deepEqual(snapshot.sellerIdentityEvidence, fixture.sellerIdentityEvidence);
  assert.equal(snapshot.productUrl, fixture.productUrl);
  assert.equal(snapshot.title, fixture.title);
  assert.deepEqual(snapshot.imageRefs, fixture.imageRefs);
  assert.equal(snapshot.currentPrice, 1831);
  assert.equal(snapshot.currency, "RUB");
  assert.equal(snapshot.categoryPath, fixture.categoryPath);
  assert.deepEqual(snapshot.attributes, fixture.attributes);
  assert.equal(snapshot.collectedAt, fixture.collectedAt);
  assert.equal(snapshot.evidenceRef, fixture.evidenceRef);
  assert.equal(snapshot.collectorMode, "mock_only");
  assert.equal(snapshot.readOnly, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(fixture, before, "模拟接口不得修改输入");
  assert.deepEqual(validateSalesSnapshot(snapshot), { valid: true, errors: [] });
});

test("all required acceptance fields are present in the published JSON Schema", async () => {
  const url = new URL("../schema/sales-snapshot-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  const required = [
    "platform",
    "marketScope",
    "sellerType",
    "sellerIdentityEvidence",
    "productUrl",
    "title",
    "imageRefs",
    "currentPrice",
    "currency",
    "categoryPath",
    "attributes",
    "collectedAt",
    "evidenceRef"
  ];
  assert.equal(schema.$id, SALES_SNAPSHOT_SCHEMA_VERSION);
  for (const field of required) assert.ok(schema.required.includes(field), field);
});

test("sellerType vocabulary is frozen for the later real Ozon phase", () => {
  assert.deepEqual(SELLER_TYPES, ["cross_border_cn", "local_ru", "other_cross_border", "unknown"]);
  assert.deepEqual(MARKET_SCOPES, ["ozon_cn_cross_border", "ozon_general_market", "unknown"]);
});

test("unconfirmed seller identity remains unknown without inference", () => {
  const snapshot = collectMockOzonSalesSnapshot(mockFixture({
    marketScope: UNKNOWN,
    sellerType: UNKNOWN,
    sellerIdentityEvidence: {
      status: "unverified",
      signals: [],
      evidenceRef: "mock-evidence:seller-identity-unavailable"
    }
  }));
  assert.equal(snapshot.marketScope, UNKNOWN);
  assert.equal(snapshot.sellerType, UNKNOWN);
  assert.equal(snapshot.sellerIdentityEvidence.status, "unverified");
});

test("an explicit seller type without verified identity evidence is rejected", () => {
  assert.throws(
    () => collectMockOzonSalesSnapshot(mockFixture({
      sellerType: "local_ru",
      sellerIdentityEvidence: {
        status: "unverified",
        signals: [],
        evidenceRef: "mock-evidence:insufficient"
      }
    })),
    /明确卖家类型必须有已验证身份依据/
  );
});

test("5A rejects any non-mock collection mode before network activity", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("5A禁止真实平台访问");
  };
  try {
    assert.throws(
      () => collectMockOzonSalesSnapshot(mockFixture({ sourceMode: "real_ozon" })),
      /只允许mock_ozon_fixture/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid price, time, image references and evidence are rejected", () => {
  const snapshot = {
    ...collectMockOzonSalesSnapshot(mockFixture()),
    currentPrice: 0,
    collectedAt: "not-a-time",
    imageRefs: [""],
    evidenceRef: ""
  };
  const result = validateSalesSnapshot(snapshot);
  assert.equal(result.valid, false);
  const paths = result.errors.map((item) => item.path);
  assert.ok(paths.includes("currentPrice"));
  assert.ok(paths.includes("collectedAt"));
  assert.ok(paths.includes("imageRefs"));
  assert.ok(paths.includes("evidenceRef"));
});

test("SalesSnapshot creation has no lifecycle transition or profit output", () => {
  const snapshot = collectMockOzonSalesSnapshot(mockFixture());
  for (const forbidden of [
    "businessPhase",
    "businessResult",
    "technicalStatus",
    "ownerAction",
    "profitModels",
    "skuPackageId",
    "productionAuthorization"
  ]) {
    assert.equal(Object.hasOwn(snapshot, forbidden), false, forbidden);
  }
});
