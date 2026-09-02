import { collectMockOzonSalesSnapshot, collectRealOzonSalesSnapshot } from "../../lib/sales-snapshot.mjs";
import { adaptLegacyCandidateToOpportunity } from "../../lib/legacy-candidate-adapter.mjs";
import { prepareRealC1ForFinalAssets, finalizeReal13CForOwnerCard } from "../../lib/real-c1-preparation.mjs";
import { createProductionAuthorization } from "../../lib/production-authorization.mjs";

const observedAt = "2026-08-12T03:50:00.000Z";

// Synthetic inputs for legacy contract cases, not a snapshot of business data.
// Exact IDs remain only where the legacy contract or existing assertions require them.

function salesSnapshot(candidate, sellerType) {
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
    attributes: {},
    collectedAt: observedAt,
    evidenceRef: `test:sales:${candidate.id}`
  });
}

export function createTrainCandidate({ lifecycle = true, returnOpsReserveRate = 0.05 } = {}) {
  const candidate = {
    id: "CX-20260803-010",
    productName: "机械发条DVP火车320件3D拼图",
    dataRevision: 25,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: observedAt,
    history: [],
    targetStore: "dandanshu",
    targetPlatform: "ozon",
    workflowStatus: "codex_processing",
    source: "user",
    productUrl: "https://www.ozon.ru/product/test-mechanical-train-100000001/",
    imageUrl: "https://example.com/test-train.png",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
    purchasePriceRmb: 41,
    expectedPriceRub: 1831,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    packagingCostRmb: 1.5,
    powered: false,
    sourceCapture: {
      captureId: "test-capture-train",
      status: "verified",
      offerId: "712421624571",
      sourceUrl: "https://detail.1688.com/offer/712421624571.html",
      observedAt,
      selectedSkus: [{ sourceSkuId: "4993364145574", propPath: "规格:豪华小火车", attributes: { 规格: "豪华小火车" }, priceCny: null, imageUrl: null }]
    },
    codexReview: {
      reviewedAt: observedAt,
      marketEvidence: { checkedAt: observedAt, exactTarget: { lowestOtherOfferRub: 1831 } },
      category: { path: "Хобби и творчество > Пазлы, модели для сборки > 3D-пазл" },
      profitCalculation: { directionalStatus: "passed", targetPriceRmb: 151.78, unitProfitRmb: 41.92, marginRate: 0.2762 },
      exchangeRate: { rubPerCny: 12.0637, rateDate: "2026-08-07", sourceType: "official", checkedAt: "2026-08-07T00:00:00.000Z" },
      completeCost: { labelRmb: 1.5, advertisingReserveRate: 0, returnOpsReserveRate, damageLossReserveRate: 0.05 },
      cStageReview: {
        checkedAt: observedAt,
        sourceCaptureId: "test-capture-train",
        exactSourceSku: "4993364145574",
        exactSourceSpec: "规格:豪华小火车",
        categoryPath: "Хобби и творчество > Пазлы, модели для сборки > 3D-пазл",
        descriptionCategoryId: "17028665",
        typeId: "92935",
        commission: { rate: 0.14, sourceType: "real_same_description_category_seller_api", checkedAt: observedAt },
        logistics: { route: "GUOO Economy Small PUDO/Courier", billableWeightKg: 0.3, freightRmb: 26.4, tariffEffectiveDate: "2026-07-20" }
      }
    }
  };
  candidate.salesSnapshotsV11 = [salesSnapshot(candidate, "cross_border_cn")];
  if (lifecycle) {
    candidate.lifecycleV11 = structuredClone(prepareRealC1ForFinalAssets({
      candidate,
      ownerFactConfirmation: { confirmedBy: "owner", confirmedAt: observedAt, brandDecision: "no_brand", material: "DVP", pieceCount: 320, mechanism: "mechanical_wind_up", powered: false, containsBattery: false },
      preparedAt: "2026-08-12T04:00:00.000Z"
    }));
  }
  return candidate;
}

export function createMusicBoxCandidate() {
  const candidate = {
    id: "CX-20260802-014",
    productName: "手摇缝纫机音乐盒",
    dataRevision: 7,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: observedAt,
    history: [],
    targetStore: "dandanshu",
    targetPlatform: "ozon",
    workflowStatus: "codex_processing",
    source: "user",
    productUrl: "https://www.ozon.ru/product/test-music-box-4403916892/",
    imageUrl: "https://example.com/test-music-box.png",
    sourceUrl: "https://detail.1688.com/offer/876240928352.html",
    purchasePriceRmb: 17.3,
    expectedPriceRub: 1462,
    packedWeightKg: 0.4,
    dimensionsCm: { length: 12, width: 12, height: 7 },
    sourceCapture: { captureId: "test-capture-music-box", status: "verified", originalSourceUrl: "https://qr.1688.com/s/7OnLCakq", sourceUrl: "https://detail.1688.com/offer/876240928352.html", offerId: "876240928352", observedAt, selectedSkus: [] },
    codexReview: { cStageReview: { categoryPath: "Музыкальные шкатулки" } }
  };
  // The adapter consumes an observation object; it does not open a page.
  // Keeping this mode exercises category derivation instead of pre-filling its result.
  candidate.salesSnapshotsV11 = [collectRealOzonSalesSnapshot({
    sourceMode: "real_ozon_page_observation", technicalStatus: "completed",
    snapshotId: `fixture-sales:${candidate.id}`, marketScope: "ozon_general_market",
    sellerIdentitySignals: [], sellerIdentityEvidenceRef: "test:unknown-seller",
    productUrl: candidate.productUrl, title: candidate.productName, imageRefs: [candidate.imageUrl],
    currentPrice: candidate.expectedPriceRub, currency: "RUB", categoryPath: "Музыкальные шкатулки",
    attributes: { description_category_id: 17028743, type_id: 971097529 },
    collectedAt: observedAt, evidenceRef: `test:sales:${candidate.id}`
  })];
  candidate.lifecycleV11 = { opportunityPackage: structuredClone(adaptLegacyCandidateToOpportunity(candidate)) };
  return candidate;
}

export function createLegacyCandidateDocument() {
  const train = createTrainCandidate({ lifecycle: false });
  const candidates = [train, createMusicBoxCandidate()];
  for (let index = 2; index < 52; index += 1) {
    candidates.push({
      id: `TEST-LEGACY-${index}`,
      productName: `合成旧候选${index}`,
      createdAt: observedAt,
      updatedAt: observedAt,
      dataRevision: index,
      history: [],
      purchasePriceRmb: index === 2 ? null : index,
      workflowStatus: index === 3 ? "eliminated" : "codex_processing"
    });
  }
  return { candidates };
}

export function createAuthorizedTrainCandidate() {
  // The final-assets correction case freezes a 3% return reserve independently
  // of the 5% reserve in the initial C1 preparation case.
  const candidate = createTrainCandidate({ returnOpsReserveRate: 0.03 });
  const finalUploadAssets = ["09-成品图-俄文.png", "01-成品图-俄文.png", "05-成品图-俄文.png", "详情-01.jpg", "详情-02.jpg"].map((fileName, index) => ({
    assetId: `test-final-${index + 1}`, mediaType: "image", assetRef: `/test-fixtures/${fileName}`, fileName,
    sha256: `${index}`.padStart(64, "0"), byteSize: 1000 + index, order: index + 1,
    role: index === 0 ? "main_image" : "detail_image", sourceType: "owner_provided_final_upload", addedAt: "2026-08-12T16:00:00.000Z"
  }));
  const finalized = finalizeReal13CForOwnerCard({
    candidate,
    ownerFactConfirmation: { brandDecision: "no_brand", material: "DVP", pieceCount: 282, mechanism: "mechanical_wind_up", powered: false, containsBattery: false },
    packedWeightKg: 0.21, dimensionsCm: { length: 23, width: 16, height: 3 },
    finalUploadAssets, excludedAssets: [], preparedAt: "2026-08-12T16:00:00.000Z"
  });
  const authorized = createProductionAuthorization({
    skuPackage: finalized.lifecycle.skuPackage,
    ownerDecision: { selectedOption: "approve_for_production_authorization", confirmedBy: "owner", cardId: finalized.confirmationCard.cardId },
    buyerTargetPrice: { amount: 1831, currency: "RUB" }, platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only", exclusions: ["no_publish_or_activation", "no_moderation_submission"], confirmedAt: "2026-08-12T16:10:00.000Z"
  });
  candidate.lifecycleV11 = { ...structuredClone(finalized.lifecycle), skuPackage: structuredClone(authorized.skuPackage) };
  return candidate;
}
