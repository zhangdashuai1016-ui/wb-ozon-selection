import test from "node:test";
import assert from "node:assert/strict";
import { collectMockOzonSalesSnapshot } from "../lib/sales-snapshot.mjs";
import {
  assessAStageMarket,
  evaluateFinalMarketPricing,
  resolveBMarketPrice,
  validateAMarketAssessment
} from "../lib/market-sample-policy.mjs";

const NOW = "2026-08-14T04:00:00.000Z";

function snapshot(sellerType, id, price = 1800) {
  const unknown = sellerType === "unknown";
  return collectMockOzonSalesSnapshot({
    sourceMode: "mock_ozon_fixture",
    snapshotId: id,
    marketScope: sellerType === "cross_border_cn" ? "ozon_cn_cross_border" : "ozon_general_market",
    sellerType,
    sellerIdentityEvidence: {
      status: unknown ? "unverified" : "verified",
      signals: unknown ? [] : [{ field: "seller_registered_country", value: sellerType === "local_ru" ? "RU" : sellerType === "cross_border_cn" ? "CN" : "KZ", sourcePath: "fixture.seller" }],
      evidenceRef: "fixture:identity:" + id
    },
    productUrl: "https://www.ozon.ru/product/" + id,
    title: "可比测试商品 " + id,
    imageRefs: ["https://cdn.example.test/" + id + ".jpg"],
    currentPrice: price,
    currency: "RUB",
    categoryPath: "测试类目",
    attributes: { model: "same-target-sku" },
    collectedAt: NOW,
    evidenceRef: "fixture:sales:" + id
  });
}

function opportunity(snapshots) {
  return {
    parentOpportunityId: "OPP-2A",
    dataRevision: 4,
    salesSnapshots: snapshots
  };
}

function goodReview(overrides = {}) {
  return {
    comparability: "comparable",
    priceEvidenceStatus: "verified",
    validityStatus: "current",
    evidenceTraceable: true,
    ...overrides
  };
}

function assess(snapshots, reviews, overrides = {}) {
  return assessAStageMarket({
    opportunityPackage: opportunity(snapshots),
    sampleReviews: reviews,
    assessedAt: NOW,
    assessmentId: "a-market:OPP-2A:" + Object.keys(reviews).join("+"),
    ...overrides
  });
}

test("2A cross_border_cn证据完整时优先形成主要价格带并放行A", () => {
  const cn = snapshot("cross_border_cn", "cn-1", 1900);
  const result = assess([cn], { "cn-1": goodReview() });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.primarySampleIds, ["cn-1"]);
  assert.equal(result.confidence, "high");
  assert.equal(result.recommendedSalePrice.amount, 1900);
  assert.deepEqual(validateAMarketAssessment(result), { valid: true, errors: [] });
});

test("2A unknown身份未确认但商品、价格、页面和可比性完整时正常进入A到B", () => {
  const unknown = snapshot("unknown", "unknown-usable", 1831);
  const result = assess([unknown], { "unknown-usable": goodReview() });
  assert.equal(result.status, "passed");
  assert.equal(result.businessResult, "passed");
  assert.equal(result.bEligibility, "eligible_after_owner_supply_confirmation");
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.sampleSummaries[0].reason, "卖家身份未确认，当前商品和价格证据可用。");
});

test("2A unknown可比性不足或价格证据缺失时留在A补销售证据", () => {
  const unknown = snapshot("unknown", "unknown-gap", 1831);
  const result = assess([unknown], {
    "unknown-gap": goodReview({ comparability: "not_comparable", priceEvidenceStatus: "missing" })
  });
  assert.equal(result.status, "data_gap");
  assert.equal(result.businessResult, "pending");
  assert.equal(result.gateReason, "销售证据不足或商品可比性不足");
  assert.deepEqual(result.primarySampleIds, []);
});

test("2A local_ru只作背景，不能单独形成中国跨境主要价格带", () => {
  const local = snapshot("local_ru", "ru-background", 1600);
  const onlyLocal = assess([local], { "ru-background": goodReview() });
  assert.equal(onlyLocal.status, "data_gap");
  assert.deepEqual(onlyLocal.primarySampleIds, []);
  assert.deepEqual(onlyLocal.backgroundSampleIds, ["ru-background"]);

  const unknown = snapshot("unknown", "unknown-primary", 1800);
  const combined = assess([local, unknown], {
    "ru-background": goodReview(),
    "unknown-primary": goodReview()
  });
  assert.equal(combined.status, "passed");
  assert.deepEqual(combined.primarySampleIds, ["unknown-primary"]);
  assert.equal(combined.containsLocalRuBackground, true);
});

test("2A unknown始终保留原身份，不会自动改写为cross_border_cn", () => {
  const unknown = snapshot("unknown", "unknown-preserved");
  const result = assess([unknown], { "unknown-preserved": goodReview() });
  assert.equal(result.sampleSummaries[0].sellerType, "unknown");
  assert.equal(result.sampleSummaries[0].identityEvidenceStatus, "unverified");
  assert.equal(result.sellerTypeCounts.unknown, 1);
  assert.equal(result.sellerTypeCounts.cross_border_cn, 0);
});

test("2A unknown身份本身不触发人工复核或主人补身份", () => {
  const unknown = snapshot("unknown", "unknown-no-review");
  const result = assess([unknown], { "unknown-no-review": goodReview() });
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.ownerAction, "confirm_supplier_option");
  assert.notEqual(result.businessResult, "manual_review");
});

test("2A通过的unknown价格依据可被B直接读取，B不再次审查卖家身份", () => {
  const unknown = snapshot("unknown", "unknown-b", 1831);
  const pkg = opportunity([unknown]);
  pkg.marketAssessment = assess([unknown], { "unknown-b": goodReview() });
  const resolved = resolveBMarketPrice(pkg, "unknown-b");
  assert.equal(resolved.snapshot.sellerType, "unknown");
  assert.equal(resolved.recommendedSalePrice.amount, 1831);
  assert.equal(resolved.assessment.manualReviewRequired, false);
});

function finalInput(count = 3) {
  const salesSnapshots = Array.from({ length: count }, (_, index) => ({ ...snapshot('unknown', `final-${index}`, 1000 + index * 100), productUrl: `https://www.ozon.ru/product/${900000000 + index}/` }));
  return { assessmentId: 'final:synthetic:1', assessedAt: NOW,
    target: { candidateId: 'candidate:synthetic', sourceRevision: 2, skuPackageId: 'sku:synthetic',
      platform: 'ozon', store: 'dandanshu', storeRef: { stableStoreId: 'dandanshu', platformStoreId: 'synthetic-store', mappingVersion: 'synthetic-v1' }, market: 'ozon_general_market' },
    salesSnapshots, selectedPriceRub: 1250,
    reviews: salesSnapshots.map((item, index) => ({ snapshotId: item.snapshotId,
      ...Object.fromEntries(['exactProduct', 'exactSpecification', 'sameMarket', 'currentlyForSale'].map(key => [key, { value: true, evidenceRef: `fixture:${key}:${index}` }])),
      salesWindow: { count: 100 - index, startDate: '2026-07-16', endDate: '2026-08-14', dayCount: 30,
        provenance: 'third_party_estimate', evidenceRef: `fixture:sales:${index}`, validityStatus: 'current', validityEvidenceRef: `fixture:validity:${index}` }, anomaly: null })) };
}

test('最终定价两条可比可用且不足三条，一条pending，不改主人选价和输入', () => {
  for (const count of [1, 2, 3]) {
    const input = finalInput(count), before = JSON.stringify(input), result = evaluateFinalMarketPricing(input);
    assert.equal(result.status, count === 1 ? 'pending' : 'ready');
    assert.equal(result.insufficientSamples, count < 3);
    assert.equal(result.selectedPriceRub, 1250);
    assert.equal(JSON.stringify(input), before);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('前三先按销量，同款异常触发补样本最多五，不可比永不补入', () => {
  const input = finalInput(7);
  input.reviews[0].anomaly = { reason: 'promotion', evidenceRef: 'fixture:promotion' };
  input.reviews[1].exactSpecification.value = false;
  const result = evaluateFinalMarketPricing(input);
  assert.deepEqual(result.coreSampleIds, ['final-0', 'final-2', 'final-3']);
  assert.deepEqual(result.supplementarySampleIds, ['final-4', 'final-5']);
  assert.equal(result.priceBand.maximum, 1500);
  assert.equal(result.samples[1].eligible, false);
});

test('缺周期、未知时效或不同窗口不能当同一近30天排序', () => {
  const input = finalInput(2); input.reviews[0].salesWindow = null;
  assert.equal(evaluateFinalMarketPricing(input).status, 'pending');
  const unknown = finalInput(2); unknown.reviews[0].salesWindow.validityStatus = 'unknown';
  assert.equal(evaluateFinalMarketPricing(unknown).status, 'pending');
  const mismatch = finalInput(2); mismatch.reviews[0].salesWindow.startDate = '2026-07-15';
  const result = evaluateFinalMarketPricing(mismatch);
  assert.equal(result.status, 'pending');
  assert.ok(result.issues.includes('sales_window_mismatch'));
});

test('最终定价闭输入拒绝缺来源、重复ID、坏窗口和未来窗口', () => {
  for (const mutate of [input => { input.extra = true; }, input => { input.salesSnapshots[1] = { ...input.salesSnapshots[1], productUrl: input.salesSnapshots[0].productUrl }; }, input => { input.reviews[0].sameMarket.evidenceRef = ''; },
    input => { input.reviews[1].snapshotId = input.reviews[0].snapshotId; },
    input => { input.reviews[0].salesWindow.count = -1; }, input => { input.reviews[0].salesWindow.endDate = '2026-09-14'; },
    input => { input.reviews[0].salesWindow.startDate = '2026-07-01'; }]) {
    const input = finalInput(2); mutate(input);
    assert.throws(() => evaluateFinalMarketPricing(input), error => error.code.startsWith('FINAL_PRICING_'));
  }
});

test('同一平台商品的不同标题路径或查询参数不能冒充多个样本', () => {
  const input = finalInput(2);
  input.salesSnapshots[1].productUrl = 'https://www.ozon.ru/product/another-title-900000000/?from=search';
  assert.throws(() => evaluateFinalMarketPricing(input), { code: 'FINAL_PRICING_SNAPSHOT_INVALID' });
});
