import test from "node:test";
import assert from "node:assert/strict";
import { createTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { prepareRealC1ForFinalAssets } from "../lib/real-c1-preparation.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { collectMockOzonSalesSnapshot } from "../lib/sales-snapshot.mjs";

const preparedAt = "2026-08-12T04:00:00.000Z";
const ownerFactConfirmation = {
  confirmedBy: "owner",
  confirmedAt: preparedAt,
  brandDecision: "no_brand",
  material: "DVP",
  pieceCount: 320,
  mechanism: "mechanical_wind_up",
  powered: false,
  containsBattery: false
};

async function fixtureCandidate() {
  const candidate = createTrainCandidate({ lifecycle: false });
  candidate.dataRevision = 25;
  candidate.lifecycleV11 = undefined;
  candidate.sourceCapture = {
    captureId: "SC-8f132e8e-425e-401a-8c72-13c32290d8b8",
    status: "verified",
    offerId: "712421624571",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
    observedAt: "2026-08-11T13:20:27.689Z",
    selectedSkus: [{
      sourceSkuId: "4993364145574",
      propPath: "8a318f128032ae3f693cf198c362a0b2",
      attributes: { 规格: "豪华小火车" },
      priceCny: null,
      imageUrl: null
    }]
  };
  candidate.codexReview.cStageReview = {
    ...candidate.codexReview.cStageReview,
    status: "needs_decision",
    checkedAt: "2026-08-12T02:30:00.000Z",
    sourceCaptureId: candidate.sourceCapture.captureId,
    exactSourceSku: "4993364145574",
    categoryPath: "Хобби и творчество > Пазлы, модели для сборки > 3D-пазл",
    descriptionCategoryId: "17028665",
    typeId: "92935",
    commission: { rate: 0.14, sourceType: "real_same_description_category_seller_api", checkedAt: "2026-08-12T02:30:00.000Z" },
    logistics: { route: "GUOO Economy Small PUDO/Courier", billableWeightKg: 0.3, freightRmb: 26.4, tariffEffectiveDate: "2026-07-20" }
  };
  candidate.salesSnapshotsV11 = [collectMockOzonSalesSnapshot({
    sourceMode: "mock_ozon_fixture",
    snapshotId: "test-sales:CX-20260803-010:cross-border-cn",
    marketScope: "ozon_cn_cross_border",
    sellerType: "cross_border_cn",
    sellerIdentityEvidence: {
      status: "verified",
      signals: [{ field: "seller_registered_country", value: "CN", sourcePath: "test.fixture" }],
      evidenceRef: "test:seller-identity:cross-border-cn"
    },
    productUrl: candidate.productUrl,
    title: candidate.productName,
    imageRefs: candidate.imageUrl ? [candidate.imageUrl] : [],
    currentPrice: candidate.expectedPriceRub,
    currency: "RUB",
    categoryPath: candidate.codexReview.cStageReview.categoryPath,
    attributes: {},
    collectedAt: "2026-08-12T03:50:00.000Z",
    evidenceRef: "test:ozon-sales-snapshot:CX-20260803-010"
  })];
  return candidate;
}

test("real CX-20260803-010 builds C1 and stops at C2 final assets", async () => {
  const candidate = await fixtureCandidate();
  const before = JSON.stringify(candidate);
  const result = prepareRealC1ForFinalAssets({ candidate, ownerFactConfirmation, preparedAt });
  assert.equal(JSON.stringify(candidate), before);
  assert.equal(result.sourceCandidateRevision, 25);
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.businessResult, "pending");
  assert.equal(result.skuPackage.technicalStatus, "completed");
  assert.equal(result.skuPackage.ownerAction, "provide_final_assets");
  assert.equal(result.skuPackage.supplierSkuId, "4993364145574");
  assert.equal(result.skuPackage.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(result.skuPackage.c2FinalAssets.status, "awaiting_final_uploads");
  assert.equal(result.skuPackage.c2FinalAssets.assets.finalUploads.length, 0);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.equal(result.platformWrites, 0);
  assert.deepEqual(validateSkuLifecyclePackage(result.skuPackage), { valid: true, errors: [] });
});

test("real C1 keeps exact costs and owner facts without inventing direct 1688 price", async () => {
  const result = prepareRealC1ForFinalAssets({ candidate: await fixtureCandidate(), ownerFactConfirmation, preparedAt });
  const supply = result.skuPackage.selectedSupplySnapshot.supplierSku;
  const profit = result.skuPackage.profitModels[0];
  const fields = new Map(result.skuPackage.c1ProductPlan.productAttributes.supplierAttributes.map((item) => [item.fieldKey, item.fact.value]));
  assert.equal(supply.unitProductPrice, "unknown");
  assert.equal(supply.unitDomesticFreight, "unknown");
  assert.equal(supply.actualPurchaseCost, 41);
  assert.equal(supply.material, "DVP");
  assert.equal(supply.powerProfile.containsBattery, false);
  assert.equal(fields.get("brand"), "Нет бренда");
  assert.equal(fields.get("piece_count"), 320);
  assert.equal(profit.recommendedSalePriceRub, 1831);
  assert.equal(profit.unitProfitRmb, 41.92);
  assert.equal(profit.profitMargin, 0.2762);
  assert.equal(profit.result, "passed");
});

test("real C1 rejects stale or conflicting source identity", async () => {
  const candidate = await fixtureCandidate();
  candidate.sourceCapture.offerId = "wrong";
  assert.throws(
    () => prepareRealC1ForFinalAssets({ candidate, ownerFactConfirmation, preparedAt }),
    /offerId不一致/
  );
});

test("real C1 accepts a comparable unknown seller snapshot without rewriting its identity", async () => {
  const candidate = await fixtureCandidate();
  candidate.salesSnapshotsV11[0] = {
    ...candidate.salesSnapshotsV11[0],
    sellerType: "unknown",
    sellerIdentityEvidence: {
      status: "unverified",
      signals: [],
      evidenceRef: "test:seller-identity:unknown"
    }
  };
  const result = prepareRealC1ForFinalAssets({ candidate, ownerFactConfirmation, preparedAt });
  assert.equal(result.opportunityPackage.marketAssessment.status, "passed");
  assert.equal(result.opportunityPackage.marketAssessment.sampleSummaries[0].sellerType, "unknown");
  assert.equal(result.opportunityPackage.marketAssessment.manualReviewRequired, false);
  assert.equal(result.skuPackage.profitModels[0].result, "passed");
  assert.equal(result.skuPackage.businessPhase, "C2");
});

test("real C1 keeps local_ru as background and stops when it is the only price sample", async () => {
  const candidate = await fixtureCandidate();
  candidate.salesSnapshotsV11[0] = {
    ...candidate.salesSnapshotsV11[0],
    sellerType: "local_ru",
    sellerIdentityEvidence: {
      status: "verified",
      signals: [{ field: "seller_registered_country", value: "RU", sourcePath: "test.fixture" }],
      evidenceRef: "test:seller-identity:local-ru"
    }
  };
  assert.throws(
    () => prepareRealC1ForFinalAssets({ candidate, ownerFactConfirmation, preparedAt }),
    /销售证据不足或商品可比性不足/
  );
});
