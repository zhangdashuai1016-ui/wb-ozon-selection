import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 35000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const TEST_ID = "GENERIC-NON-TRAIN-001";
const TEST_SKU = "SINK-ORGANIZER-BLUE";

function replaceAllStrings(value, replacements) {
  return JSON.parse(Object.entries(replacements).reduce(
    (text, [from, to]) => text.split(from).join(to),
    JSON.stringify(value)
  ));
}

function nonTrainCandidate(reference) {
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
  sales.marketEvidence.exactTarget.specification = "硅胶水槽收纳架，蓝色";
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

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const bodyJson = await response.json();
  return { response, body: bodyJson };
}

test("第二个非火车SKU用通用C1、C2和ProductionAuthorization完成隔离测试", async (t) => {
  const source = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  const fireTrain = source.candidates.find((item) => item.id === "CX-20260803-010");
  assert.ok(fireTrain);
  const originalFireTrain = JSON.stringify(fireTrain);
  const candidate = nonTrainCandidate(fireTrain);
  const directory = await mkdtemp(path.join(tmpdir(), "generic-c-stage-api-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "generic-c-stage-test", updatedAt: "2026-08-17T10:00:00.000Z", automationStarted: false },
    rules: source.rules,
    candidates: [structuredClone(fireTrain), candidate],
    dispatches: []
  }));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  const retired = await post(`/api/candidates/${TEST_ID}/lifecycle/final-assets`, { dataRevision: 1, confirmed: true });
  assert.equal(retired.response.status, 410);
  assert.match(retired.body.message, /旧火车专属C阶段入口已隔离/);
  const legacyAdapter = await post(`/api/legacy/fire-train/candidates/${TEST_ID}/lifecycle/c1-owner-facts`, { dataRevision: 1, confirmed: true });
  assert.equal(legacyAdapter.response.status, 410);
  assert.match(legacyAdapter.body.message, /火车专属历史适配器已永久隔离/);

  const c1 = await post(`/api/candidates/${TEST_ID}/lifecycle/c1/complete`, {
    dataRevision: 1,
    platformSchemaEvidence: {
      evidenceId: "schema:ozon:dandanshu:kitchen-organizer:2026-08-17",
      platform: "ozon",
      store: "dandanshu",
      descriptionCategoryId: "kitchen-organizer-category",
      typeId: "sink-organizer-type",
      categoryName: "Органайзеры для кухни",
      schemaRevision: "ozon-schema:kitchen-organizer:2026-08-17",
      requiredFields: [
        { fieldKey: "product_type", label: "商品类型", required: true, sourceAttributeKeys: ["product_type"] },
        { fieldKey: "color", label: "颜色", required: true, sourceAttributeKeys: ["color"] }
      ],
      categoryRestrictions: [],
      platformCompliance: "no_recorded_restriction",
      collectedAt: "2026-08-17T10:01:00.000Z"
    },
    competitorTextSnapshot: {
      snapshotId: "competitor-text:sink-organizer:2026-08-17",
      sourceSalesSnapshotId: candidate.lifecycleV11.opportunityPackage.salesSnapshots[0].snapshotId,
      observedAt: "2026-08-17T10:01:00.000Z",
      evidenceRef: "sales-snapshot:sink-organizer#competitor-text",
      texts: [{
        textId: "competitor-sink-organizer-title",
        text: "Органайзер для кухонной раковины",
        sourceRef: "https://www.ozon.ru/product/sink-organizer-test/",
        role: "buyer_language_reference_only"
      }]
    },
    keywordEvidence: {
      evidenceId: "seo-evidence:sink-organizer:2026-08-17",
      status: "ready",
      targetPlatform: "ozon",
      targetSkuPackageId: `sku-lifecycle:${TEST_ID}:${TEST_SKU}`,
      sourcePlatform: "ozon",
      collectionMode: "current_frozen_facts_no_volume",
      pointsSpent: 0,
      reuseEvidenceNote: "仅使用当前冻结商品事实词，不声明搜索量",
      observedAt: "2026-08-17T10:01:00.000Z",
      keywords: [
        {
          query: "органайзер для раковины",
          keywordEvidenceRef: "seo-evidence:sink-organizer:core",
          sourceSku: "ozon-sink-organizer-reference",
          sourcePlatform: "ozon",
          group: "core_product_type",
          factBindingPaths: ["productAttributes.supplierAttributes.0.fact"],
          relevanceStatus: "retained",
          reason: "商品类型与冻结事实一致"
        },
        {
          query: "силиконовый органайзер",
          keywordEvidenceRef: "seo-evidence:sink-organizer:material",
          sourceSku: "ozon-sink-organizer-reference",
          sourcePlatform: "ozon",
          group: "material",
          factBindingPaths: ["productAttributes.material"],
          relevanceStatus: "retained",
          reason: "材质与冻结供应SKU一致"
        }
      ]
    }
  });
  assert.equal(c1.response.status, 200, c1.body.message);
  assert.equal(c1.body.candidate.lifecycleV11.skuPackage.businessPhase, "C2");
  assert.equal(c1.body.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(c1.body.candidate.lifecycleV11.skuPackage.c2FinalAssets.status, "awaiting_final_uploads");
  assert.equal(c1.body.candidate.lifecycleV11.skuPackage.supplierSkuId, TEST_SKU);
  assert.equal(c1.body.candidate.lifecycleV11.platformWrites, 0);

  const revisionAfterC1 = c1.body.candidate.dataRevision;
  const finalUploadAssets = [
    {
      assetId: `final:${TEST_ID}:main`,
      mediaType: "image",
      assetRef: "https://example.invalid/final/sink-organizer-main.jpg",
      fileName: "sink-organizer-main.jpg",
      sha256: "a".repeat(64),
      byteSize: 120000,
      order: 1,
      role: "main_image",
      sourceType: "owner_provided_final_upload",
      addedAt: "2026-08-17T10:02:00.000Z"
    },
    {
      assetId: `final:${TEST_ID}:detail-1`,
      mediaType: "image",
      assetRef: "https://example.invalid/final/sink-organizer-detail.jpg",
      fileName: "sink-organizer-detail.jpg",
      sha256: "b".repeat(64),
      byteSize: 110000,
      order: 2,
      role: "detail_image",
      sourceType: "owner_provided_final_upload",
      addedAt: "2026-08-17T10:02:00.000Z"
    }
  ];
  const c2 = await post(`/api/candidates/${TEST_ID}/lifecycle/c2/final-assets`, {
    dataRevision: revisionAfterC1,
    confirmed: true,
    finalUploadAssets,
    approvedAssetIds: finalUploadAssets.map((asset) => asset.assetId),
    confirmationNote: "主人确认当前非火车SKU的两张最终素材及顺序"
  });
  assert.equal(c2.response.status, 200, c2.body.message);
  assert.equal(c2.body.candidate.lifecycleV11.skuPackage.c2FinalAssets.status, "completed");
  assert.equal(c2.body.candidate.lifecycleV11.skuPackage.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.deepEqual(
    c2.body.candidate.lifecycleV11.skuPackage.productionConfirmationCard.c2Assets.finalUploads.map((asset) => asset.assetId),
    finalUploadAssets.map((asset) => asset.assetId)
  );

  const revisionAfterC2 = c2.body.candidate.dataRevision;
  const cardId = c2.body.candidate.lifecycleV11.skuPackage.productionConfirmationCard.cardId;
  const missingExactScope = await post(`/api/candidates/${TEST_ID}/lifecycle/production-authorization`, {
    dataRevision: revisionAfterC2,
    confirmed: true,
    cardId
  });
  assert.equal(missingExactScope.response.status, 400);
  assert.match(missingExactScope.body.message, /分别锁定买家目标价、后台写入价和汇率证据/);
  const authorization = await post(`/api/candidates/${TEST_ID}/lifecycle/production-authorization`, {
    dataRevision: revisionAfterC2,
    confirmed: true,
    cardId,
    buyerTargetPrice: { amount: 1200, currency: "RUB" },
    platformWritePrice: { amount: 100, currency: "CNY" },
    priceConversion: { rubPerCny: 12, evidenceRef: "fx:cbr:2026-08-17:RUB-CNY", checkedAt: "2026-08-17T10:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: [
      "no_publish_or_activation",
      "no_moderation_submission",
      "no_promotion_change",
      "no_advertising_change",
      "no_warehouse_or_logistics_change",
      "no_other_sku_write"
    ],
    allowedWriteFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    note: "非火车SKU隔离测试，只生成授权快照"
  });
  assert.equal(authorization.response.status, 200, authorization.body.message);
  const scope = authorization.body.candidate.lifecycleV11.skuPackage.productionAuthorization.lockedScope;
  assert.equal(scope.supplierSkuId, TEST_SKU);
  assert.equal(scope.stock, 100);
  assert.equal(scope.buyerTargetPrice.amount, 1200);
  assert.equal(scope.platformWritePrice.amount, 100);
  assert.deepEqual(scope.finalUploads.map((asset) => asset.assetId), finalUploadAssets.map((asset) => asset.assetId));
  assert.equal(authorization.body.candidate.lifecycleV11.skuPackage.productionRecord, null);
  assert.equal(authorization.body.candidate.lifecycleV11.platformWrites, 0);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(JSON.stringify(persisted.candidates.find((item) => item.id === "CX-20260803-010")), originalFireTrain);
  const serializedNonTrain = JSON.stringify(persisted.candidates.find((item) => item.id === TEST_ID).lifecycleV11.skuPackage);
  for (const fireSpecific of ["CX-20260803-010", "4993364145574", "豪华小火车", "Паровоз", "DVP", "282"]) {
    assert.equal(serializedNonTrain.includes(fireSpecific), false, `非火车生命周期不得包含火车专属值：${fireSpecific}`);
  }
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(persisted.dispatches.length, 0);
});
