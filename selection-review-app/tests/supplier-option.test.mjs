import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import {
  UNKNOWN,
  adapt1688CaptureToSupplierOption,
  validateSupplierOption
} from "../lib/supplier-option.mjs";

function capturedEvidence(overrides = {}) {
  return sanitize1688Evidence({
    offerId: "712421624571",
    observedAt: "2026-08-12T12:00:00.000Z",
    title: "机械发条木质火车",
    priceRanges: [{ minimumQuantity: 2, priceCny: 35, source: "tradeModel.offerPriceRanges" }],
    supplierAttributes: { 材质: "木质" },
    skus: [
      {
        sourceSkuId: "sku-320",
        propPath: "片数:320片",
        attributes: { 片数: "320片" },
        priceCny: 41,
        priceSource: "skuModel.skuInfoMap.sku-320.price",
        stock: 9,
        stockSource: "skuModel.skuInfoMap.sku-320.stock",
        imageUrl: "https://cbu01.alicdn.com/img/ibank/example.jpg"
      },
      {
        sourceSkuId: "sku-100",
        propPath: null,
        attributes: { 片数: "100片" },
        priceCny: null,
        priceSource: null,
        stock: null,
        stockSource: null,
        imageUrl: null
      }
    ],
    ...overrides
  }, "712421624571");
}

test("existing 1688 capture adapts to one SupplierOption with independent SupplierSKUs", () => {
  const evidence = capturedEvidence();
  const before = structuredClone(evidence);
  const option = adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: "source-capture:SC-test-001"
  });

  assert.equal(option.sourcePlatform, "1688");
  assert.equal(option.supplierOptionId, "supplier-option:1688:712421624571");
  assert.equal(option.productUrl, "https://detail.1688.com/offer/712421624571.html");
  assert.equal(option.offerId, "712421624571");
  assert.equal(option.supplierSkus.length, 2);
  assert.deepEqual(option.supplierSkus.map((sku) => sku.supplierSkuId), ["sku-320", "sku-100"]);
  assert.equal(option.supplierSkus[0].variantKey, "片数:320片");
  assert.equal(option.supplierSkus[1].variantKey, "片数=100片");
  assert.equal(option.supplierSkus[0].unitProductPrice, 41);
  assert.equal(option.supplierSkus[0].imageRefs[0], "https://cbu01.alicdn.com/img/ibank/example.jpg");
  assert.equal(option.captureTime, "2026-08-12T12:00:00.000Z");
  assert.equal(option.evidenceRef, "source-capture:SC-test-001");
  assert.deepEqual(validateSupplierOption(option), { valid: true, errors: [] });
  assert.deepEqual(evidence, before, "适配不得修改现有采集证据");
  assert.equal(Object.isFrozen(option), true);
});

test("missing sales, badges, freight, cost and SKU facts remain explicit unknown", () => {
  const option = adapt1688CaptureToSupplierOption(capturedEvidence(), {
    evidenceRef: "source-capture:SC-test-unknown"
  });
  assert.equal(option.supplierSalesEvidence, UNKNOWN);
  assert.equal(option.supplierBadges, UNKNOWN);
  for (const sku of option.supplierSkus) {
    assert.equal(sku.unitDomesticFreight, UNKNOWN);
    assert.equal(sku.actualPurchaseCost, UNKNOWN);
    assert.equal(sku.weight, UNKNOWN);
    assert.equal(sku.dimensions, UNKNOWN);
    assert.equal(sku.material, UNKNOWN, "商品级材质不得静默套给全部SKU");
    assert.equal(sku.powerProfile, UNKNOWN);
  }
  assert.equal(option.supplierSkus[1].unitProductPrice, UNKNOWN);
  assert.equal(option.supplierSkus[1].imageRefs, UNKNOWN);
});

test("tier price never substitutes a missing direct SKU price", () => {
  const option = adapt1688CaptureToSupplierOption(capturedEvidence(), {
    evidenceRef: "source-capture:SC-test-tier-price"
  });
  assert.equal(option.supplierSkus[1].unitProductPrice, UNKNOWN);
  assert.notEqual(option.supplierSkus[1].unitProductPrice, 35);
});

test("actualPurchaseCost is never calculated even if a caller appends freight-like fields", () => {
  const evidence = capturedEvidence();
  evidence.skus[0].domesticFreightCny = 6;
  evidence.skus[0].actualPurchaseCostCny = undefined;
  const option = adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: "source-capture:SC-test-no-inference"
  });
  assert.equal(option.supplierSkus[0].unitProductPrice, 41);
  assert.equal(option.supplierSkus[0].unitDomesticFreight, UNKNOWN);
  assert.equal(option.supplierSkus[0].actualPurchaseCost, UNKNOWN);
  assert.notEqual(option.supplierSkus[0].actualPurchaseCost, 47);
});

test("published SupplierOption schema requires every frozen 6A field", async () => {
  const url = new URL("../schema/supplier-option-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  const optionRequired = [
    "supplierOptionId",
    "sourcePlatform",
    "productUrl",
    "offerId",
    "supplierSalesEvidence",
    "supplierBadges",
    "supplierSkus",
    "captureTime",
    "evidenceRef"
  ];
  const skuRequired = [
    "supplierSkuId",
    "variantKey",
    "attributes",
    "unitProductPrice",
    "unitDomesticFreight",
    "actualPurchaseCost",
    "weight",
    "dimensions",
    "material",
    "powerProfile",
    "imageRefs"
  ];
  assert.deepEqual(schema.$defs.SupplierOption.required, optionRequired);
  assert.deepEqual(schema.$defs.SupplierSKU.required, skuRequired);
});

test("missing facts cannot be represented by null or omitted fields", () => {
  const option = structuredClone(adapt1688CaptureToSupplierOption(capturedEvidence(), {
    evidenceRef: "source-capture:SC-test-explicit-unknown"
  }));
  option.supplierSkus[0].weight = null;
  delete option.supplierSkus[0].powerProfile;
  const result = validateSupplierOption(option);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path.endsWith(".weight")));
  assert.ok(result.errors.some((item) => item.path.endsWith(".powerProfile")));
});
