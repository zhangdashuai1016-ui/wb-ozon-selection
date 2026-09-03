import assert from "node:assert/strict";
import test from "node:test";
import {
  createPersistableAliyunOssAssetIntent,
  executeAliyunOssAssetIntent,
  markAliyunOssAssetIntentPersisted,
  reconcileAliyunOssAssetIntentAfterRestart
} from "../lib/aliyun-oss-d-asset-integration.mjs";
import { inspectAdapterCapabilities, resolveFinalUploads } from "../lib/ozon-seller-api-de-adapter.mjs";
import { createProductionPlan } from "../lib/production-plan.mjs";

const NOW = "2026-08-22T12:00:00.000Z";

function authorizedCandidate() {
  const assets = [1, 2].map((order) => ({
    assetId: `final-${order}`,
    assetRef: `/owner/final-${order}.png`,
    fileName: `final-${order}.png`,
    sha256: String(order).repeat(64),
    order,
    role: order === 1 ? "main_image" : "detail_image",
    lifecycleArea: "finalUploads",
    sourceType: "owner_upload",
    ownerConfirmed: true,
    productionEligible: true
  }));
  const productionAuthorization = {
    schemaVersion: "production-authorization-v1.1",
    authorizationId: "production-auth:CX-OSS-001:SUP-MUSIC-001:7",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt: NOW,
    sourceConfirmationCardId: "card:CX-OSS-001:7",
    authorizedDataRevision: 7,
    lockedScope: {
      platform: "ozon",
      store: "dandanshu",
      skuPackageId: "sku-lifecycle:CX-OSS-001:SUP-MUSIC-001",
      supplierSkuId: "SUP-MUSIC-001",
      variantKey: "wooden-music-box",
      titleVersion: "c1-seo-draft-v1.1:music-box",
      title: "Музыкальная шкатулка из дерева",
      contentVersion: "c1-seo-draft-v1.1:music-box",
      content: { locale: "ru-RU", description: "Деревянная музыкальная шкатулка.", bulletPoints: ["Механическая мелодия."], searchKeywords: ["музыкальная шкатулка"] },
      attributeVersion: "c1-fact-verification-v1.1:music-box",
      attributes: { brand: { value: "Нет бренда", status: "confirmed" } },
      packing: { weight: { value: 0.3, unit: "kg" }, dimensions: { length: 23, width: 16, height: 3, unit: "cm" } },
      schemaWriteBindings: {
        schemaRevision: "ozon-schema:music-box",
        evidenceRef: "schema:music-box",
        content: {
          title: { fieldKey: "title", attributeId: 4180, complexId: 0, dictionaryId: 0 },
          description: { fieldKey: "description", attributeId: 4191, complexId: 0, dictionaryId: 0 },
          searchKeywords: { fieldKey: "searchKeywords", attributeId: 23171, complexId: 0, dictionaryId: 0 }
        },
        requiredAttributes: [{ fieldKey: "brand", attributeId: 85, complexId: 0, dictionaryId: 1 }]
      },
      platformCategory: { descriptionCategoryId: { value: "17000001", verificationStatus: "confirmed" }, typeId: { value: "92001", verificationStatus: "confirmed" } },
      recommendedPrice: { rub: 1800, cny: 150 },
      buyerTargetPrice: { amount: 1800, currency: "RUB" },
      platformWritePrice: { amount: 150, currency: "CNY" },
      priceConversion: { rubPerCny: 12, checkedAt: NOW, evidenceRef: "rate:1" },
      stock: 100,
      assetsFinalUploadsVersion: "c2-assets:CX-OSS-001:7",
      finalUploads: assets,
      publishScope: "create_and_allow_validation_moderation",
      exclusions: ["no_advertising", "no_promotion"],
      allowedWriteFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"]
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
  const skuPackage = {
    skuPackageId: "sku-lifecycle:CX-OSS-001:SUP-MUSIC-001",
    supplierSkuId: "SUP-MUSIC-001",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    productionAuthorization,
    productionRecord: null,
    eVerificationRecord: null
  };
  return { id: "CX-OSS-001", dataRevision: 41, lifecycleV11: { skuPackage } };
}

function ownerDecision(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  return {
    confirmed: true,
    confirmedBy: "owner",
    authorizationId: sku.productionAuthorization.authorizationId,
    skuPackageId: sku.skuPackageId,
    finalUploadAssetIds: sku.productionAuthorization.lockedScope.finalUploads.map((asset) => asset.assetId)
  };
}

test("OSS素材意图必须绑定当前revision、主人授权和完整finalUploads顺序", () => {
  const candidate = authorizedCandidate();
  const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: 41, ownerDecision: ownerDecision(candidate), startedAt: NOW });
  assert.equal(intent.status, "awaiting_persistence");
  assert.equal(intent.mustPersistBeforeUpload, true);
  assert.equal(intent.attemptLimit, 1);
  assert.equal(intent.ossWrites, 0);
  assert.equal(intent.platformWrites, 0);
  assert.throws(() => createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: 40, ownerDecision: ownerDecision(candidate), startedAt: NOW }), /OSS_D_REVISION_CONFLICT/);
  assert.throws(() => createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: 41, ownerDecision: { ...ownerDecision(candidate), finalUploadAssetIds: ["final-2", "final-1"] }, startedAt: NOW }), /OSS_D_SCOPE_MISMATCH/);
});

test("持久化后只调用一次OSS并把稳定URL证据直接接入D适配器", async () => {
  const candidate = authorizedCandidate();
  const baseIntent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: 41, ownerDecision: ownerDecision(candidate), startedAt: NOW });
  const persistedIntent = markAliyunOssAssetIntentPersisted({ intent: baseIntent, persistedAt: "2026-08-22T12:00:01.000Z" });
  let calls = 0;
  const result = await executeAliyunOssAssetIntent({
    persistedIntent,
    candidate,
    completedAt: "2026-08-22T12:00:02.000Z",
    upload: async ({ finalUploads }) => {
      calls += 1;
      return {
        status: "verified",
        mode: "preapproved_stable_https",
        protocolVersion: "aliyun-oss-final-assets-v1",
        approvedHosts: ["ozon-img-staging-cn-20260630-a7k3.oss-accelerate.aliyuncs.com"],
        resolvedAssets: finalUploads.map((asset) => ({
          assetId: asset.assetId, sha256: asset.sha256, order: asset.order,
          platformAcceptedUrl: `https://ozon-img-staging-cn-20260630-a7k3.oss-accelerate.aliyuncs.com/${asset.assetId}.png`,
          stable: true, authorizationStatus: "approved", evidenceRef: `oss:${asset.assetId}`
        })),
        evidenceRef: "oss:verified:CX-OSS-001"
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.intent.status, "completed");
  const sku = candidate.lifecycleV11.skuPackage;
  const plan = createProductionPlan({ productionAuthorization: sku.productionAuthorization, createdAt: sku.productionAuthorization.confirmedAt });
  const capabilities = inspectAdapterCapabilities({
    store: "dandanshu", warehouseId: "1020005003806890", inspectedAt: NOW,
    storeIdentity: { status: "verified", expectedStore: "dandanshu", observedStore: "dandanshu", evidenceRef: "store:1" },
    productImport: { status: "verified", protocolVersion: "ozon-product-import-v3", endpoint: "/v3/product/import", statusEndpoint: "/v1/product/import/info", evidenceRef: "import:1" },
    assetTransport: result.assetTransport,
    inventoryWrite: { status: "verified", protocolVersion: "ozon-products-stocks-v2", endpoint: "/v2/products/stocks", warehouseId: "1020005003806890", evidenceRef: "stock:1" },
    independentReadback: { status: "verified", protocolVersion: "ozon-independent-readback-v1", endpoints: { attributes: "/v4/product/info/attributes", info: "/v3/product/info/list", prices: "/v5/product/info/prices", stocks: "/v4/product/info/stocks", stateFailed: "/v3/product/list" }, evidenceRef: "readback:1" }
  });
  assert.equal(capabilities.status, "ready");
  const resolved = resolveFinalUploads({ finalUploads: plan.finalUploads, adapterCapabilities: capabilities });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.resolvedAssets.length, 2);
});

test("OSS失败或服务重启都收口unknown_outcome且不重试", async () => {
  const candidate = authorizedCandidate();
  const intent = markAliyunOssAssetIntentPersisted({
    intent: createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: 41, ownerDecision: ownerDecision(candidate), startedAt: NOW }),
    persistedAt: "2026-08-22T12:00:01.000Z"
  });
  let calls = 0;
  const failed = await executeAliyunOssAssetIntent({
    persistedIntent: intent, candidate, completedAt: "2026-08-22T12:00:02.000Z",
    upload: async () => { calls += 1; throw new Error("OSS_PUBLIC_READBACK_FAILED: HTTP 403"); }
  });
  assert.equal(calls, 1);
  assert.equal(failed.status, "unknown_outcome");
  assert.equal(failed.retryAllowed, false);
  assert.equal(failed.assetTransport, null);
  const restarted = reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent: intent, restartedAt: "2026-08-22T12:05:00.000Z" });
  assert.equal(restarted.status, "unknown_outcome");
  assert.equal(restarted.failureCode, "OSS_D_RESTART_UNKNOWN_OUTCOME");
  assert.equal(restarted.retryAllowed, false);
});
