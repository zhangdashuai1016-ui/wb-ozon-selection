import test from "node:test";
import assert from "node:assert/strict";
import { collectOzonPage } from "../extension/1688-capture/collector-ozon.js";
import { sanitizeOzonCaptureEvidence } from "../lib/ozon-sales-capture.mjs";

function node(textContent, options = {}) {
  return {
    textContent,
    currentSrc: options.currentSrc || "",
    src: options.src || "",
    children: options.children || [],
    closest(selector) { return selector === "button" && options.inButton ? {} : null; },
    getAttribute(name) { return name === "src" ? options.src || "" : null; }
  };
}

function widget(textContent = "", options = {}) {
  return {
    textContent,
    children: options.children || [],
    querySelectorAll(selector) {
      if (selector === "span") return options.spans || [];
      if (selector === "img") return options.images || [];
      if (selector === "a") return options.links || [];
      return [];
    }
  };
}

function installPage({ href = "https://www.ozon.ru/product/test-product-4403916892/", widgets = {} } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = { location: { href } };
  globalThis.document = {
    body: { innerText: "Карточка товара" },
    querySelector(selector) {
      const match = selector.match(/^\[data-widget="(.+)"\]$/);
      if (match) return widgets[match[1]] || null;
      return selector === "h1" ? { textContent: "Музыкальная швейная машинка" } : null;
    }
  };
  globalThis.fetch = async () => { throw new Error("collector must not fetch"); };
  return () => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  };
}

function realLikeWidgets({ includePrice = true } = {}) {
  const attributeRows = [
    node("", { children: [node("Тип"), node("Музыкальная шкатулка")] }),
    node("", { children: [node("Материал"), node("Пластик")] }),
    node("", { children: [node("Страна-изготовитель"), node("Китай")] })
  ];
  return {
    webProductHeading: widget("Музыкальная шарманка швейная машинка"),
    webPrice: widget("", {
      spans: includePrice
        ? [node("1 316 ₽", { inButton: true }), node("1 462 ₽"), node("2 548 ₽")]
        : []
    }),
    webGallery: widget("", {
      images: [
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc50/main.jpg" }),
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc1000/main.jpg" }),
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc1000/two.jpg" })
      ]
    }),
    webShortCharacteristics: widget("", { children: [node(""), node("", { children: attributeRows })] }),
    breadCrumbs: widget("", { links: [node("Дом и сад"), node("Шкатулки")] })
  };
}

test("Ozon collector reads already-loaded widgets without network requests or defaults", async () => {
  const restore = installPage({ widgets: realLikeWidgets() });
  try {
    const result = await collectOzonPage("4403916892");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.productId, "4403916892");
    assert.equal(result.evidence.currentPrice, 1462, "普通买家价格不能被银行卡专享价替代");
    assert.equal(result.evidence.currency, "RUB");
    assert.equal(result.evidence.attributes["Тип"], "Музыкальная шкатулка");
    assert.equal(result.evidence.attributes["Материал"], "Пластик");
    assert.equal(result.evidence.attributes["Ozon bank price"], "1316 RUB");
    assert.deepEqual(result.evidence.imageRefs, [
      "https://ir.ozone.ru/s3/multimedia/wc1000/main.jpg",
      "https://ir.ozone.ru/s3/multimedia/wc1000/two.jpg"
    ]);
    assert.equal(result.evidence.source, "ozon_loaded_page_widgets");

    const snapshot = sanitizeOzonCaptureEvidence(result.evidence, "4403916892", {
      captureId: "OSC-test",
      snapshotId: "sales-snapshot:ozon:test"
    });
    assert.equal(snapshot.sellerType, "unknown");
    assert.equal(snapshot.currentPrice, 1462);
    assert.equal(snapshot.collectorMode, "real_page_read_only");
  } finally {
    restore();
  }
});

test("Ozon collector rejects another product before reading widgets", async () => {
  const restore = installPage({ widgets: realLikeWidgets() });
  try {
    const result = await collectOzonPage("9999999999");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "wrong_product");
  } finally {
    restore();
  }
});

test("Ozon collector stops when loaded price widget has no ordinary buyer price", async () => {
  const restore = installPage({ widgets: realLikeWidgets({ includePrice: false }) });
  try {
    const result = await collectOzonPage("4403916892");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "precise_price_missing");
  } finally {
    restore();
  }
});
