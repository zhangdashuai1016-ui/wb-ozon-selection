import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect1688Page } from "../extension/1688-capture/collector.js";
import {
  classify1688TimeoutOutcome,
  classify1688NavigationOutcome,
  classify1688Source,
  isAllowed1688NavigationHost,
  observed1688TabAddress,
  shouldWaitFor1688Destination,
  validateResolved1688Source
} from "../extension/1688-capture/source-routing.js";
import {
  normalize1688CaptureSource,
  resolveCapturedSku,
  resolveCapturedSkus,
  sanitize1688Evidence,
  sanitizeSourceCaptureFailureDiagnostics,
  sanitizeSourceCaptureFailureResult,
  sourceCaptureFailureDestinationLabel
} from "../lib/source-capture.mjs";
import { toggleLocalSupplierSkuSelection } from "../src/aSupplierCaptureSelection.js";

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
                freightPrice: 6,
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
    assert.equal(result.evidence.pageFields.unitProductPriceCny, null);
    assert.equal(result.evidence.pageFields.unitDomesticFreightCny, 6);
    assert.equal(result.evidence.pageFields.unitDomesticFreightSource, "tradeModel.freightPrice");

    const evidence = sanitize1688Evidence(result.evidence, "712421624571");
    assert.equal(evidence.pageFields.unitProductPriceCny, null);
    assert.equal(evidence.pageFields.unitDomesticFreightCny, 6);
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

test("A supplier routing accepts only exact detail links or the narrow qr short-link allowlist", () => {
  assert.deepEqual(normalize1688CaptureSource("https://qr.1688.com/s/7OnLCakq?ignored=1"), {
    type: "short",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    offerId: ""
  });
  assert.deepEqual(classify1688Source("https://qr.1688.com/s/7OnLCakq"), {
    type: "short",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    offerId: ""
  });
  assert.deepEqual(validateResolved1688Source(
    "https://qr.1688.com/s/7OnLCakq",
    "https://detail.1688.com/offer/876240928352.html?from=qr"
  ), {
    offerId: "876240928352",
    sourceUrl: "https://detail.1688.com/offer/876240928352.html"
  });
  assert.equal(validateResolved1688Source("https://qr.1688.com/s/7OnLCakq", "https://example.com/offer/876240928352.html"), null);
  assert.equal(isAllowed1688NavigationHost("https://qr.1688.com/s/7OnLCakq"), true);
  assert.equal(isAllowed1688NavigationHost("https://detail.1688.com/offer/876240928352.html"), true);
  assert.equal(isAllowed1688NavigationHost("https://m.1688.com/offer/876240928352.html"), false);
  assert.equal(isAllowed1688NavigationHost("https://example.com/offer/876240928352.html"), false);
  assert.equal(validateResolved1688Source(
    "https://detail.1688.com/offer/712421624571.html",
    "https://detail.1688.com/offer/876240928352.html",
    "712421624571"
  ), null);
  assert.equal(normalize1688CaptureSource("https://qr.1688.com/other/7OnLCakq").type, "invalid");
});

test("short-link navigation failures become fixed enums without leaking URLs, queries or tokens", () => {
  const cases = [
    ["https://login.1688.com/member/signin.htm?token=secret-login", "login_1688", "login", "login_required", "登录页"],
    ["https://sec.1688.com/verify/captcha?session=secret-check", "verification_1688", "verification", "verification_required", "人机验证页"],
    ["https://m.1688.com/offer/876240928352.html?share=secret-mobile", "mobile_1688", "mobile_offer", "mobile_page", "移动页"],
    ["https://qr.1688.com/s/secret-redirect?token=hidden", "other_1688", "redirect_intermediate", "intermediate_page", "中间跳转页"],
    ["https://example.com/path?cookie=secret-cookie", "external", "other", "non_whitelisted_destination", "其他非白名单页面"],
    ["https://detail.1688.com/offer/999999.html?token=hidden", "detail_1688", "offer_detail", "different_offer", "不同商品"]
  ];
  for (const [url, finalHostClass, finalPathType, redirectClassification, label] of cases) {
    const diagnostics = classify1688NavigationOutcome(url, {
      expectedOfferId: redirectClassification === "different_offer" ? "876240928352" : "",
      navigationStage: "page_complete"
    });
    assert.equal(diagnostics.finalHostClass, finalHostClass);
    assert.equal(diagnostics.finalPathType, finalPathType);
    assert.equal(diagnostics.redirectClassification, redirectClassification);
    assert.equal(sourceCaptureFailureDestinationLabel(diagnostics), label);
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /https?:|secret-|[?&](?:token|cookie|session)=/i);
  }
  const safeDifferentOffer = classify1688NavigationOutcome(
    "https://detail.1688.com/offer/999999.html?token=hidden",
    { expectedOfferId: "876240928352", navigationStage: "page_complete" }
  );
  assert.equal(safeDifferentOffer.observedOfferId, "999999");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(safeDifferentOffer), safeDifferentOffer);
  assert.throws(() => sanitizeSourceCaptureFailureDiagnostics({
    ...safeDifferentOffer,
    finalUrl: "https://detail.1688.com/offer/999999.html?token=hidden"
  }), /capture_failure_diagnostics_invalid/);
});

test("mobile offer is only an intermediate while redirect is still loading", () => {
  const mobileRedirect = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "redirect_observed" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileRedirect, "loading"), true);

  const mobileComplete = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "page_complete" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileComplete, "complete"), false);

  const mobileTimeout = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "timeout" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileTimeout, "loading"), false);

  const allowedDetailLoading = classify1688NavigationOutcome(
    "https://detail.1688.com/offer/876240928352.html",
    { navigationStage: "redirect_observed" }
  );
  assert.equal(shouldWaitFor1688Destination(allowedDetailLoading, "loading"), true);
  assert.equal(shouldWaitFor1688Destination(allowedDetailLoading, "complete"), false);
});

test("loading tab prefers pending URL and timeout diagnostics stay sanitized", () => {
  const observation = observed1688TabAddress({
    status: "loading",
    url: "https://qr.1688.com/s/secret-token",
    pendingUrl: "https://detail.1688.com/offer/876240928352.html?token=hidden"
  });
  assert.equal(observation.tabObservation, "pending_url");
  assert.match(observation.value, /detail\.1688\.com\/offer\/876240928352\.html/);

  const timeout = classify1688TimeoutOutcome({
    status: "loading",
    url: "about:blank",
    pendingUrl: "https://detail.1688.com/offer/876240928352.html?token=hidden"
  }, "876240928352", {
    redirectClassification: "mobile_page"
  });
  assert.equal(timeout.redirectClassification, "detail_load_timeout");
  assert.equal(timeout.navigationStage, "timeout");
  assert.equal(timeout.tabObservation, "pending_url");
  assert.equal(timeout.lastObservedClassification, "mobile_page");
  assert.equal(sourceCaptureFailureDestinationLabel(timeout), "商品详情页加载超时");
  assert.doesNotMatch(JSON.stringify(timeout), /https?:|secret-|[?&](?:token|cookie|session)=/i);
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(timeout), timeout);
});

test("timeout distinguishes missing tab from missing address and retains only safe last state", () => {
  const missingTab = classify1688TimeoutOutcome(null, "", {
    redirectClassification: "mobile_page"
  });
  assert.equal(missingTab.redirectClassification, "tab_unavailable");
  assert.equal(missingTab.tabObservation, "tab_unavailable");
  assert.equal(missingTab.lastObservedClassification, "mobile_page");
  assert.equal(sourceCaptureFailureDestinationLabel(missingTab), "采集标签已关闭或不可读取");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(missingTab), missingTab);

  const missingAddress = classify1688TimeoutOutcome({ status: "loading", url: "about:blank" }, "", {
    redirectClassification: "intermediate_page"
  });
  assert.equal(missingAddress.redirectClassification, "address_unavailable");
  assert.equal(missingAddress.tabObservation, "address_unavailable");
  assert.equal(missingAddress.lastObservedClassification, "intermediate_page");
  assert.equal(sourceCaptureFailureDestinationLabel(missingAddress), "页面地址仍未就绪");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(missingAddress), missingAddress);
});

test("failed capture reports accept only the strict sanitized payload shape", () => {
  const report = sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-safe",
    token: "one-time-token-not-persisted",
    dataRevision: 24,
    status: "failed",
    failureCode: "site_login_required",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "login_1688",
      finalPathType: "login",
      redirectClassification: "login_required",
      navigationStage: "page_complete",
      observedOfferId: null
    }
  });
  assert.equal(report.failureDiagnostics.redirectClassification, "login_required");
  assert.equal("token" in report, false);
  assert.equal("captureId" in report, false);
  assert.throws(() => sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-unsafe",
    token: "one-time-token",
    dataRevision: 24,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    finalUrl: "https://example.com/?token=must-not-pass"
  }), /capture_failure_diagnostics_invalid/);
  assert.throws(() => sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-unsafe-code",
    token: "one-time-token",
    dataRevision: 24,
    status: "failed",
    failureCode: "https://example.com/?token=must-not-pass",
    observedAt: "2026-08-19T08:00:00.000Z"
  }), /capture_failure_diagnostics_invalid/);
});

test("A confirmation card supplier multi-selection is local, defaults empty, and can check or uncheck without an API contract", async () => {
  assert.deepEqual(toggleLocalSupplierSkuSelection([], "sku-a", true), ["sku-a"]);
  assert.deepEqual(toggleLocalSupplierSkuSelection(["sku-a"], "sku-b", true), ["sku-a", "sku-b"]);
  assert.deepEqual(toggleLocalSupplierSkuSelection(["sku-a", "sku-b"], "sku-a", false), ["sku-b"]);
  const component = await readFile(path.join(appDir, "src", "components", "RealAConfirmationCard.jsx"), "utf8");
  assert.match(component, /useState\(\[\]\)/);
  assert.match(component, /setLocalSelectedSkuIds\(\[\]\)/);
  assert.match(component, /card\.sourceCandidateId, card\.sourceDataRevision, card\.supplierCapture\?\.captureId/);
  assert.match(component, /type="checkbox"/);
  assert.match(component, /toggleLocalSupplierSkuSelection/);
  assert.match(component, /不会调用接口、保存选择、确认供应方案或进入B\/C1/);
  assert.doesNotMatch(component, /selectSourceCaptureSku|completeSourceCapture|api\./);
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

test("extension manifest stays limited to the 1688 short-link/detail allowlist, Ozon product pages and the local review app", async () => {
  const manifest = JSON.parse(await readFile(path.join(appDir, "extension", "1688-capture", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.7");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:4317/*",
    "https://detail.1688.com/offer/*",
    "https://qr.1688.com/s/*",
    "https://www.ozon.ru/product/*"
  ]);
  assert.equal(manifest.permissions.includes("cookies"), false);
});

test("extension background resolves an A-stage short link once and never auto-selects a supplier SKU", async () => {
  const background = await readFile(path.join(appDir, "extension", "1688-capture", "background.js"), "utf8");
  const request = await readFile(path.join(appDir, "extension", "1688-capture", "capture-request.js"), "utf8");
  assert.match(request, /payload\.mode !== SUPPLIER_CAPTURE_MODE/);
  assert.match(request, /payload\.allowShortLinkResolution !== true/);
  assert.match(background, /const matching = source\.type === "detail"[\s\S]*?: null/);
  assert.match(background, /chrome\.tabs\.create\(\{ url: source\.sourceUrl, active: true \}\)/);
  assert.match(background, /resolvedSourceUrl: resolved\.sourceUrl/);
  assert.match(background, /classify1688NavigationOutcome/);
  assert.match(background, /shouldWaitFor1688Destination/);
  assert.match(background, /failureDiagnostics: error\.failureDiagnostics/);
  assert.doesNotMatch(background, /finalUrl\s*:/);
  assert.doesNotMatch(background, /selectedSkuIds\s*=/);
});

test("page bridge and extension background preserve precise capture rejection codes", async () => {
  const bridge = await readFile(path.join(appDir, "extension", "1688-capture", "bridge.js"), "utf8");
  const background = await readFile(path.join(appDir, "extension", "1688-capture", "background.js"), "utf8");
  assert.match(bridge, /SELECTION_REVIEW_1688_CAPTURE_REQUEST/);
  assert.match(bridge, /response\?\.code/);
  assert.match(background, /validateSupplierCaptureRequest/);
  assert.match(background, /captureRequestErrorMessage/);
  assert.match(background, /body\?\.captureJob/);
  assert.match(background, /void runCapture\(payload\)/);
});

test("extension status handshake verifies the background worker instead of only the page bridge", async () => {
  const bridge = await readFile(path.join(appDir, "extension", "1688-capture", "bridge.js"), "utf8");
  const background = await readFile(path.join(appDir, "extension", "1688-capture", "background.js"), "utf8");
  assert.match(bridge, /SELECTION_REVIEW_EXTENSION_BACKGROUND_PING/);
  assert.match(bridge, /backgroundReady/);
  assert.match(background, /SELECTION_REVIEW_EXTENSION_BACKGROUND_PING/);
  assert.match(background, /sendResponse\(\{ accepted: true, version:/);
  assert.match(background, /\/api\/extension\/heartbeat/);
  assert.match(background, /selection-review-extension-heartbeat/);
  assert.match(background, /periodInMinutes: 0\.5/);
  assert.match(bridge, /setInterval\(\(\) => void publishStatus\(\), 10000\)/);
});
