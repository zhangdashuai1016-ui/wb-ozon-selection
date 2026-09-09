import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import {
  UNKNOWN,
  adapt1688CaptureToSupplierOption,
  assertValidSupplierOption,
  validateSupplierOption
} from "../lib/supplier-option.mjs";

function capturedEvidence(overrides = {}) {
  return sanitize1688Evidence({
    offerId: "712421624571",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
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

test("SupplierSKU rejects malformed numeric facts without coercing their shape", () => {
  const base = adapt1688CaptureToSupplierOption(capturedEvidence(), { evidenceRef: "fixture:shape" });
  for (const [field, values] of Object.entries({
    weight: [-5, [], true, false, NaN, Infinity, {}, { value: -1, unit: "kg" }, { value: "1", unit: "kg" }],
    dimensions: [-5, [], true, {}, { length: 1, width: 2, height: -3 }],
    material: [false, [], 2],
    powerProfile: [true, [], 2],
    unitProductPrice: [true, [], "12", -5],
    unitDomesticFreight: [true, [], "0", -5],
    actualPurchaseCost: [true, [], "12", -5]
  })) {
    for (const value of values) {
      const option = structuredClone(base);
      option.supplierSkus[0][field] = value;
      const result = validateSupplierOption(option);
      assert.equal(result.valid, false, `${field} ${JSON.stringify(value)} must be invalid`);
      assert.ok(result.errors.some((error) => error.path.endsWith(`.${field}`)));
    }
  }
  for (const weight of [0, 0.2, { value: 0.2, unit: "kg" }, "页面原文: 200g", UNKNOWN]) {
    const option = structuredClone(base);
    option.supplierSkus[0].weight = weight;
    assert.equal(validateSupplierOption(option).valid, true);
  }
});

test("derived variant keys are order-independent and exclude absent or non-scalar attributes", () => {
  const build = (attributes, propPath = null) => {
    const evidence = capturedEvidence();
    evidence.skus = [{ ...evidence.skus[0], propPath, attributes }];
    return adapt1688CaptureToSupplierOption(evidence, { evidenceRef: "fixture:variant" }).supplierSkus[0].variantKey;
  };
  assert.equal(build({ color: "red", size: "S" }), build({ size: "S", color: "red" }));
  assert.equal(build({ color: "red", a: null, b: undefined, c: true, d: [], e: {}, f: "unknown", g: " null " }), "color=red");
  assert.equal(build({ count: 0 }), "count=0");
  assert.equal(build({ absent: null }), "sku-320");
  assert.equal(build({ color: "red" }, "unknown"), "color=red");
  assert.notEqual(build({ color: "red|size=S" }), build({ color: "red", size: "S" }), "属性分隔符不能造成key碰撞");
});

test("public SupplierOption rejects noncanonical or foreign product sources without rewriting them", () => {
  const base = adapt1688CaptureToSupplierOption(capturedEvidence(), { evidenceRef: "fixture:exact-source" });
  const urls = [
    "https://evil.example/offer/712421624571.html",
    "https://detail.1688.com.evil.example/offer/712421624571.html",
    "https://detail.1688.com@evil.example/offer/712421624571.html",
    "https://user:password@detail.1688.com/offer/712421624571.html",
    "https://user@detail.1688.com/offer/712421624571.html",
    "http://detail.1688.com/offer/712421624571.html",
    "https://detail.1688.com:8443/offer/712421624571.html",
    "https://detail.1688.com:443/offer/712421624571.html",
    "https://m.1688.com/offer/712421624571.html",
    "https://qr.1688.com/s/example",
    "https://detail.1688.com/offer/712421624571.html?token=not-a-real-secret",
    "https://detail.1688.com/offer/712421624571.html#fragment",
    "https://detail.1688.com/offer/712421624571.html?",
    "https://detail.1688.com/offer/712421624571.html#",
    "https://DETAIL.1688.COM/offer/712421624571.html",
    "https://detail.1688.com\\offer\\712421624571.html",
    "https://detail.1688.com/offer/712421624571.html/reviews",
    "https://detail.1688.com/offer/../offer/712421624571.html",
    "https://detail.1688.com/offer/%37%31%32%34%32%31%36%32%34%35%37%31.html",
    " https://detail.1688.com/offer/712421624571.html ",
    "https://detail.1688.com/offer/712421624571.ht\tml",
    "https://detail.1688.com/offer/999999999999.html",
    null, {}, [], 712421624571
  ];
  for (const productUrl of urls) {
    const option = { ...structuredClone(base), productUrl };
    const before = structuredClone(option);
    const result = validateSupplierOption(option);
    assert.equal(result.valid, false, `must reject ${JSON.stringify(productUrl)}`);
    assert.ok(result.errors.some((error) => error.path === "SupplierOption.productUrl"));
    assert.throws(() => assertValidSupplierOption(option), /SupplierOption\.productUrl/);
    assert.deepEqual(option, before, "校验不得修复或覆盖来源");
  }
});

test("public SupplierOption binds the exact native-string offer identity without coercion", () => {
  const base = adapt1688CaptureToSupplierOption(capturedEvidence(), { evidenceRef: "fixture:offer-identity" });
  for (const offerId of ["999999999999", "", "unknown", " 712421624571 ", "7e11", "-1", "12.5", "1".repeat(41), 712421624571, true, {}, []]) {
    const option = { ...structuredClone(base), offerId };
    const result = validateSupplierOption(option);
    assert.equal(result.valid, false, `must reject ${JSON.stringify(offerId)}`);
    assert.ok(result.errors.some((error) => error.path === "SupplierOption.productUrl"));
    if (offerId !== "999999999999") {
      assert.ok(result.errors.some((error) => error.path === "SupplierOption.offerId"));
    }
  }
});

test("direct capture adaptation cannot bypass official product URL and offer identity validation", () => {
  const base = capturedEvidence();
  for (const overrides of [
    { sourceUrl: "https://evil.example/offer/712421624571.html" },
    { sourceUrl: "https://user:password@detail.1688.com/offer/712421624571.html" },
    { sourceUrl: "https://detail.1688.com/offer/999999999999.html" },
    { offerId: "999999999999" },
    { offerId: 712421624571 },
    { offerId: "../../other" }
  ]) {
    // Deliberately bypass sanitize1688Evidence: the public adapter owns this check too.
    const evidence = { ...structuredClone(base), ...overrides };
    const before = structuredClone(evidence);
    assert.throws(() => adapt1688CaptureToSupplierOption(evidence, { evidenceRef: "fixture:direct-source" }), /SupplierOption\.(productUrl|offerId)/);
    assert.deepEqual(evidence, before);
  }
});

test("canonical official source remains valid and frozen without changing existing option or SKU identity", () => {
  const evidence = capturedEvidence();
  const option = adapt1688CaptureToSupplierOption(evidence, { evidenceRef: "fixture:canonical-source" });
  assert.equal(assertValidSupplierOption(option), option);
  assert.equal(option.supplierOptionId, "supplier-option:1688:712421624571");
  assert.equal(option.offerId, evidence.offerId);
  assert.equal(option.productUrl, evidence.sourceUrl);
  assert.deepEqual(option.supplierSkus.map((sku) => sku.supplierSkuId), evidence.skus.map((sku) => sku.sourceSkuId));
  assert.equal(Object.isFrozen(option.supplierSkus[0]), true);
});

test("canonical numeric offer IDs retain string identity at the existing capture length boundaries", () => {
  for (const offerId of ["1", "9".repeat(40)]) {
    const evidence = sanitize1688Evidence({
      ...capturedEvidence(),
      offerId,
      sourceUrl: `https://detail.1688.com/offer/${offerId}.html`
    }, offerId);
    const option = adapt1688CaptureToSupplierOption(evidence, { evidenceRef: "fixture:offer-boundary" });
    assert.equal(validateSupplierOption(option).valid, true);
    assert.equal(option.offerId, offerId);
    assert.equal(option.productUrl, evidence.sourceUrl);
  }
});
