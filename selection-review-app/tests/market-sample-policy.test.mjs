import test from "node:test";
import assert from "node:assert/strict";
import { collectMockOzonSalesSnapshot } from "../lib/sales-snapshot.mjs";
import {
  assessAStageMarket,
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
