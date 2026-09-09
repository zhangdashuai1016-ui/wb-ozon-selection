import { collectMockOzonSalesSnapshot } from "../../lib/sales-snapshot.mjs";

const observedAt = "2026-08-12T03:50:00.000Z";

// Raw synthetic legacy inputs only. No lifecycle, provider, authorization or platform state is constructed here.
function salesSnapshot(candidate, sellerType, attributes) {
  return collectMockOzonSalesSnapshot({
    sourceMode: "mock_ozon_fixture",
    snapshotId: `fixture-sales:${candidate.id}`,
    marketScope: "ozon_cn_cross_border",
    sellerType,
    sellerIdentityEvidence: {
      status: sellerType === "unknown" ? "unverified" : "verified",
      signals: sellerType === "unknown" ? [] : [{ field: "seller_registered_country", value: "CN", sourcePath: "test.fixture" }],
      evidenceRef: `test:seller-identity:${sellerType}`
    },
    productUrl: candidate.productUrl,
    title: candidate.productName,
    imageRefs: [candidate.imageUrl],
    currentPrice: candidate.expectedPriceRub,
    currency: "RUB",
    categoryPath: candidate.codexReview.cStageReview.categoryPath,
    attributes,
    collectedAt: observedAt,
    evidenceRef: `test:sales:${candidate.id}`
  });
}

export function createTrainCandidateInput({ returnOpsReserveRate = 0.05,
  candidateId = "CX-20260803-010", supplierSkuId = "4993364145574", sourceOfferId = "712421624571",
  variantKey = "规格:豪华小火车", productName = "机械发条DVP火车320件3D拼图", expectedPriceRub = 1831,
  purchasePriceRmb = 41, packedWeightKg = 0.3, dimensionsCm = { length: 23, width: 16, height: 3 },
  captureId = "test-capture-train", internationalFreightRmb = 26.4,
  salesAttributes = {},
  productUrl = "https://www.ozon.ru/product/test-mechanical-train-100000001/", imageUrl = "https://example.com/test-train.png",
  categoryPath = "Хобби и творчество > Пазлы, модели для сборки > 3D-пазл",
  storeRef = { stableStoreId: "dandanshu", platformStoreId: "fixture-seller-001", mappingVersion: "fixture-stores-v1" }
} = {}) {
  const candidate = {
    id: candidateId,
    productName,
    dataRevision: 25,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: observedAt,
    history: [],
    targetStore: storeRef.stableStoreId,
    storeRef: structuredClone(storeRef),
    targetPlatform: "ozon",
    workflowStatus: "codex_processing",
    source: "user",
    productUrl,
    imageUrl,
    sourceUrl: `https://detail.1688.com/offer/${sourceOfferId}.html`,
    purchasePriceRmb,
    expectedPriceRub,
    packedWeightKg,
    dimensionsCm: structuredClone(dimensionsCm),
    packagingCostRmb: 1.5,
    powered: false,
    sourceCapture: {
      captureId,
      status: "verified",
      offerId: sourceOfferId,
      sourceUrl: `https://detail.1688.com/offer/${sourceOfferId}.html`,
      observedAt,
      selectedSkus: [{ sourceSkuId: supplierSkuId, propPath: variantKey,
        attributes: { [variantKey.slice(0, variantKey.indexOf(":"))]: variantKey.slice(variantKey.indexOf(":") + 1) }, priceCny: null, imageUrl: null }]
    },
    codexReview: {
      reviewedAt: observedAt,
      marketEvidence: { checkedAt: observedAt, exactTarget: { lowestOtherOfferRub: expectedPriceRub } },
      category: { path: categoryPath },
      profitCalculation: { directionalStatus: "passed", targetPriceRmb: 151.78, unitProfitRmb: 41.92, marginRate: 0.2762 },
      exchangeRate: { rubPerCny: 12.0637, rateDate: "2026-08-07", sourceType: "official", checkedAt: "2026-08-07T00:00:00.000Z" },
      completeCost: { labelRmb: 1.5, advertisingReserveRate: 0, returnOpsReserveRate, damageLossReserveRate: 0.05 },
      cStageReview: {
        checkedAt: observedAt,
        sourceCaptureId: captureId,
        exactSourceSku: supplierSkuId,
        exactSourceSpec: variantKey,
        categoryPath,
        descriptionCategoryId: "17028665",
        typeId: "92935",
        commission: { rate: 0.14, sourceType: "real_same_description_category_seller_api", checkedAt: observedAt },
        logistics: { route: "GUOO Economy Small PUDO/Courier", billableWeightKg: packedWeightKg, freightRmb: internationalFreightRmb, tariffEffectiveDate: "2026-07-20" }
      }
    }
  };
  candidate.salesSnapshotsV11 = [salesSnapshot(candidate, "cross_border_cn", salesAttributes)];
  return candidate;
}
