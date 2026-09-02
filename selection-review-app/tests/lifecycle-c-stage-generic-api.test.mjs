import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import { createTrainCandidate, createGenericCStageCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 35000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const TEST_ID = "GENERIC-NON-TRAIN-001";
const TEST_SKU = "SINK-ORGANIZER-BLUE";


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
  const fireTrain = createTrainCandidate();
  assert.ok(fireTrain.lifecycleV11.skuPackage, "合成对照候选必须包含完整生命周期");
  const originalFireTrain = JSON.stringify(fireTrain);
  const candidate = createGenericCStageCandidate();
  const directory = await mkdtemp(path.join(tmpdir(), "generic-c-stage-api-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "generic-c-stage-test", updatedAt: "2026-08-17T10:00:00.000Z", automationStarted: false },
    rules: structuredClone(DEFAULT_RULES),
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
  t.after(() => stopApiProcess(child));
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
