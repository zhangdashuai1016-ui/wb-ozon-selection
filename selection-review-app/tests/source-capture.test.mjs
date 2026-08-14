import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect1688Page } from "../extension/1688-capture/collector.js";
import { resolveCapturedSku, resolveCapturedSkus, sanitize1688Evidence } from "../lib/source-capture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeDocument() {
  return {
    title: "机械发条木质火车",
    body: { innerText: "商品详情" },
    querySelector(selector) {
      return selector === "h1" ? { textContent: "机械发条木质火车" } : null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

test("1688 collector keeps direct SKU prices and leaves missing stock or price null", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { pathname: "/offer/712421624571.html" },
    context: {
      result: {
        global: {
          globalData: {
            model: {
              offerBaseInfo: { offerId: "712421624571", subject: "瑞安市初刻工艺品有限公司" },
              tradeModel: {
                offerPriceRanges: [{ beginAmount: 2, price: 12 }],
                skuMap: [
                  { skuId: "sku-320", specAttrs: "片数:320片" },
                  { skuId: "sku-100", specAttrs: "片数:100片", canBookCount: 9 }
                ]
              },
              skuModel: {
                skuProps: [],
                skuInfoMap: {
                  "sku-320": { skuId: "sku-320", price: 41 },
                  "sku-100": { skuId: "sku-100", price: 35 }
                }
              },
              offerAttributeModel: { offerAttrs: [{ name: "材质", value: "木质" }] }
            }
          }
        }
      }
    }
  };
  globalThis.document = fakeDocument();
  try {
    const result = await collect1688Page("712421624571");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.title, "机械发条木质火车");
    assert.equal(result.evidence.skus.length, 2);
    assert.equal(result.evidence.skus[0].priceCny, 41);
    assert.equal(result.evidence.skus[0].stock, null);
    assert.equal(result.evidence.skus[1].priceCny, 35);
    assert.equal(result.evidence.skus[1].stock, 9);
    assert.equal(result.evidence.priceRanges[0].priceCny, 12);

    const evidence = sanitize1688Evidence(result.evidence, "712421624571");
    const resolved = resolveCapturedSku({
      productName: "机械发条木质火车320片3D拼图",
      codexReview: { sourceSku: { sku: "机械发条木质火车320片3D拼图" } }
    }, evidence);
    assert.equal(resolved.status, "matched");
    assert.equal(resolved.selected.sourceSkuId, "sku-320");
    assert.equal(resolved.selected.stock, null);

    const multi = resolveCapturedSkus(evidence, ["sku-320", "sku-100"]);
    assert.equal(multi.status, "matched");
    assert.deepEqual(multi.selected.map((sku) => sku.sourceSkuId), ["sku-320", "sku-100"]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("1688 collector rejects a different offer before returning SKU evidence", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { pathname: "/offer/999.html" }, context: null, __INIT_DATA: null };
  globalThis.document = fakeDocument();
  try {
    const result = await collect1688Page("712421624571");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "wrong_offer");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("1688 collector accepts a real top-level SKU ID on a single-specification offer", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { pathname: "/offer/728389288187.html" },
    context: {
      result: {
        global: {
          globalData: {
            model: {
              offerBaseInfo: { offerId: "728389288187", subject: "发光木质3D鬼屋拼图" },
              tradeModel: { offerPriceRanges: [{ beginAmount: 1, price: 53 }] },
              skuModel: {
                skuProps: [],
                defaultSkuId: "ghost-house-sku",
                currentSku: { skuId: "ghost-house-sku", price: 53, canBookCount: 8 }
              }
            }
          }
        }
      }
    }
  };
  globalThis.document = fakeDocument();
  try {
    const result = await collect1688Page("728389288187");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.pageSelectedSkuId, "ghost-house-sku");
    assert.equal(result.evidence.skus.length, 1);
    assert.equal(result.evidence.skus[0].sourceSkuId, "ghost-house-sku");
    assert.equal(result.evidence.skus[0].priceCny, 53);
    assert.equal(result.evidence.skus[0].stock, 8);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("extension manifest stays limited to 1688, Ozon product pages and the local review app", async () => {
  const manifest = JSON.parse(await readFile(path.join(appDir, "extension", "1688-capture", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:4317/*",
    "https://detail.1688.com/offer/*",
    "https://www.ozon.ru/product/*"
  ]);
  assert.equal(manifest.permissions.includes("cookies"), false);
});
