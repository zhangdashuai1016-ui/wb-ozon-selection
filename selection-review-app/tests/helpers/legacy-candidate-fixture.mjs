import { collectMockOzonSalesSnapshot, collectRealOzonSalesSnapshot } from "../../lib/sales-snapshot.mjs";
import { adaptLegacyCandidateToOpportunity } from "../../lib/legacy-candidate-adapter.mjs";
import { prepareRealC1ForFinalAssets, finalizeReal13CForOwnerCard } from "../../lib/real-c1-preparation.mjs";
import { createProductionAuthorization } from "../../lib/production-authorization.mjs";
import { createExternalListingRecord, verifyExternalListing } from "../../lib/e-stage-readback.mjs";

const observedAt = "2026-08-12T03:50:00.000Z";

function replaceAllStrings(value, replacements) {
  return JSON.parse(Object.entries(replacements).reduce(
    (text, [from, to]) => text.split(from).join(to),
    JSON.stringify(value)
  ));
}

export function createGenericCStageCandidate() {
  const reference = createTrainCandidate();
  const TEST_ID = "GENERIC-NON-TRAIN-001";
  const TEST_SKU = "SINK-ORGANIZER-BLUE";
  const candidate = replaceAllStrings(reference, {
    "CX-20260803-010": TEST_ID,
    "4993364145574": TEST_SKU,
    "712421624571": "900000000001",
    "8a318f128032ae3f693cf198c362a0b2": "variant:blue-sink-organizer"
  });
  const lifecycle = candidate.lifecycleV11;
  const opportunity = lifecycle.opportunityPackage;
  const sku = lifecycle.skuPackage;
  const variantKey = "颜色:蓝色";
  const sales = opportunity.salesSnapshots[0];
  sales.title = "Силиконовый органайзер для кухонной раковины";
  sales.productUrl = "https://www.ozon.ru/product/sink-organizer-test/";
  sales.categoryPath = "Дом и сад > Кухня > Органайзеры";
  sales.currentPrice = 1200;
  sales.imageRefs = ["https://example.invalid/sink-organizer-source.jpg"];
  sales.marketEvidence = { exactTarget: { specification: "硅胶水槽收纳架，蓝色" } };
  sales.marketEvidence.exactTarget.lowestOtherOfferRub = 1200;
  sales.marketEvidence.exactTarget.regularPriceRub = 1350;
  sales.marketEvidence.exactTarget.ozonCardPriceRub = 1200;
  sales.marketEvidence.directionSamplesCaveat = "相似厨房收纳用品只作方向背景，不冒充精确同款";
  sales.marketEvidence.acceptanceNote = "测试夹具：当前销售样本与蓝色硅胶水槽收纳架具有合理可比性";
  sales.legacyExpectedPriceRub = 1200;

  opportunity.directionName = "厨房水槽收纳架";
  for (const option of opportunity.supplierOptions) {
    option.productUrl = "https://detail.1688.com/offer/900000000001.html";
    option.offerId = "900000000001";
    option.supplierOptionId = "supplier-option:1688:900000000001";
    option.evidenceRef = "source-capture:test:sink-organizer";
    const supplierSku = option.supplierSkus[0];
    Object.assign(supplierSku, {
      supplierSkuId: TEST_SKU,
      variantKey,
      attributes: {
        product_type: "水槽收纳架",
        color: "蓝色",
        model_name: "水槽收纳架"
      },
      unitProductPrice: 16,
      unitDomesticFreight: 4,
      actualPurchaseCost: 20,
      weight: { value: 0.25, unit: "kg", evidenceRef: "owner-confirmed:test:weight" },
      dimensions: { length: 22, width: 11, height: 4, unit: "cm", evidenceRef: "owner-confirmed:test:dimensions" },
      material: "silicone",
      powerProfile: {
        powered: false,
        containsBattery: false,
        batteryType: "not_applicable",
        batteryCount: 0,
        evidenceRef: "owner-confirmed:test:power"
      },
      imageRefs: ["https://example.invalid/sink-organizer-source.jpg"]
    });
  }
  opportunity.recommendedSupplierOptionId = "supplier-option:1688:900000000001";
  opportunity.confirmedSupplierOptionId = "supplier-option:1688:900000000001";

  const selected = sku.selectedSupplySnapshot;
  selected.snapshotId = `source-capture:test:sink-organizer:${TEST_SKU}`;
  selected.ownerSupplyConfirmation.recommendedSupplierOptionId = "supplier-option:1688:900000000001";
  selected.ownerSupplyConfirmation.supplierOptionId = "supplier-option:1688:900000000001";
  selected.ownerSupplyConfirmation.supplierSkuId = TEST_SKU;
  selected.ownerSupplyConfirmation.variantKey = variantKey;
  selected.supplierOption = structuredClone(opportunity.supplierOptions[0]);
  selected.supplierSku = structuredClone(opportunity.supplierOptions[0].supplierSkus[0]);
  sku.supplierOptionId = "supplier-option:1688:900000000001";
  sku.supplierSkuId = TEST_SKU;
  sku.variantKey = variantKey;
  sku.skuPackageId = `sku-lifecycle:${TEST_ID}:${TEST_SKU}`;
  sku.skuFacts = {
    actualPurchaseCost: 20,
    actualPurchaseCostCurrency: "CNY",
    weight: structuredClone(selected.supplierSku.weight),
    dimensions: structuredClone(selected.supplierSku.dimensions),
    material: "silicone",
    powerProfile: structuredClone(selected.supplierSku.powerProfile)
  };
  sku.inheritedSalesSnapshotRefs = [sales.snapshotId];
  sku.businessPhase = "B";
  sku.businessResult = "passed";
  sku.technicalStatus = "completed";
  sku.ownerAction = "none";
  sku.c1ProductPlan = null;
  sku.c2FinalAssets = null;
  sku.productionConfirmationCard = null;
  sku.productionAuthorization = null;
  sku.productionRecord = null;
  sku.externalListingRecord = null;
  sku.eVerificationRecord = null;
  sku.readbackHistory = [];
  sku.profitModels = [{
    schemaVersion: "profit-model-v1.1",
    profitModelVersion: "profit-v1",
    calculatedAt: "2026-08-17T10:00:00.000Z",
    inputSnapshotRefs: [
      sales.snapshotId,
      selected.snapshotId,
      "fees:ozon:dandanshu:kitchen-organizer:2026-08-17",
      "logistics:guoo:kitchen-organizer:2026-08-17",
      "fx:cbr:2026-08-17:RUB-CNY"
    ],
    marketAssessmentRef: "a-market:test:sink-organizer",
    marketSampleRefs: [sales.snapshotId],
    marketSellerTypesUsed: ["unknown"],
    marketConfidence: "limited",
    containsLocalRuBackground: false,
    recommendedSalePriceRub: 1200,
    recommendedSalePriceCny: 100,
    priceConversion: {
      rubPerCny: 12,
      evidenceRef: "fx:cbr:2026-08-17:RUB-CNY",
      checkedAt: "2026-08-17T10:00:00.000Z"
    },
    sellerSettlementRevenue: {
      amount: 86,
      currency: "CNY",
      evidenceRef: "fees:ozon:dandanshu:kitchen-organizer:2026-08-17",
      formula: "recommendedSalePriceCny × (1 - commissionRate)"
    },
    commissionRate: 0.14,
    internationalFreight: {
      amount: 20,
      currency: "CNY",
      evidenceRef: "logistics:guoo:kitchen-organizer:2026-08-17",
      route: "GUOO Economy Small"
    },
    actualPurchaseCost: { amount: 20, currency: "CNY", evidenceRef: selected.snapshotId },
    otherCosts: {
      amount: 10,
      currency: "CNY",
      evidenceRef: "fees:ozon:dandanshu:kitchen-organizer:2026-08-17",
      components: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 7,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0
      }
    },
    unitProfitRmb: 36,
    profitMargin: 0.36,
    thresholdVersion: "profit-threshold-v1.2-15pct-or-20cny",
    thresholds: { minimumProfitMargin: 0.15, minimumUnitProfitRmb: 20, logic: "any" },
    result: "passed",
    executionMode: "five_upstream_evidence_sources_only",
    externalAccesses: [],
    requestedExistingFields: [],
    formula: "利润=卖家结算收入-国际运费-实际采购到手成本-其他成本；利润率=单件利润÷建议成交价人民币"
  }];
  sku.activeProfitModelVersion = "profit-v1";
  sku.audit.updatedAt = "2026-08-17T10:00:00.000Z";
  sku.audit.history = [{ event: "generic_non_train_b_passed", at: "2026-08-17T10:00:00.000Z" }];

  candidate.id = TEST_ID;
  candidate.productName = "硅胶水槽收纳架";
  candidate.productUrl = sales.productUrl;
  candidate.sourceUrl = "https://detail.1688.com/offer/900000000001.html";
  candidate.purchasePriceRmb = 20;
  candidate.packedWeightKg = 0.25;
  candidate.dimensionsCm = { length: 22, width: 11, height: 4 };
  candidate.workflowStatus = "listing_preparation";
  candidate.dataRevision = 1;
  candidate.processing = { state: "idle", manualHold: false };
  candidate.listingPreparation = { status: "c1_ready" };
  candidate.listingHandoff = { state: "queued", owner: "listing_task" };
  lifecycle.status = "b_passed_auto_c1";
  lifecycle.skuPackage = sku;
  lifecycle.platformWrites = 0;
  lifecycle.externalAccesses = [];
  return candidate;
}

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

export function createVerifiedGenericCandidate() {
  const candidate = createAuthorizedTrainCandidate();
  // The route identity is intentionally non-legacy; the frozen SKU and its
  // historical authorization remain unchanged, just as in the idempotency case.
  candidate.id = "GENERIC-LIFECYCLE-E-READBACK";
  const sku = candidate.lifecycleV11.skuPackage;
  const observation = {
    platform: sku.targetPlatform,
    store: sku.targetStore,
    skuPackageId: sku.skuPackageId,
    supplierSkuId: sku.supplierSkuId,
    platformProductId: "TEST-EXTERNALLY-VERIFIED-001",
    merchantSku: sku.supplierSkuId,
    currentPrice: { amount: 153, currency: "CNY" },
    currentStock: 100,
    imageCount: 5,
    moderationStatus: "approved",
    validationStatus: "success",
    saleStatus: "on_sale",
    errors: [],
    platformEvidenceRef: "test:external-observation:generic-e-readback"
  };
  // These domain functions validate in-memory observations only; no platform
  // readback, production execution, or external adapter is invoked.
  const externalListingRecord = createExternalListingRecord({
    observation: { ...observation, discoverySource: "seller_portal" },
    ownerPriceDecision: {
      decision: "keep_current_live_price",
      confirmedBy: "owner",
      confirmedAt: "2026-08-17T09:00:00.000Z",
      price: structuredClone(observation.currentPrice)
    },
    discoveredAt: "2026-08-17T09:05:00.000Z"
  });
  const verification = verifyExternalListing({
    externalListingRecord,
    verifiedObservation: observation,
    verifiedAt: "2026-08-17T09:10:00.000Z"
  });
  sku.externalListingRecord = structuredClone(externalListingRecord);
  sku.eVerificationRecord = structuredClone(verification);
  sku.businessPhase = "E";
  sku.businessResult = "passed";
  sku.technicalStatus = "completed";
  sku.ownerAction = "none";
  sku.readbackPolicy = { ...sku.readbackPolicy, status: "completed", automaticAttempts: 1 };
  sku.readbackHistory = [{
    verificationId: verification.verificationId,
    path: verification.verificationPath,
    outcome: verification.outcome,
    platformProductId: verification.platformProductId,
    verifiedAt: verification.verifiedAt,
    evidenceRef: verification.platformEvidenceRef
  }];
  candidate.lifecycleV11.status = verification.outcome;
  candidate.lifecycleV11.platformWrites = 0;
  return candidate;
}
